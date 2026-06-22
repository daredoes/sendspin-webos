/*
 * com.sendspin.cinema.service — background audio daemon for webOS.
 *
 * Headless JS service. Acts as a Sendspin / Music Assistant player: connects over
 * WebSocket, accepts pushed audio streams, and feeds each chunk's encoded payload
 * to gstreamer -> pulsesink, which mixes with live TV/HDMI audio (Phase 1 + Phase 2,
 * proven on hardware: node -> gst-launch stdin -> pulsesink, FLAC + PCM, clean EOS).
 *
 * Architecture:
 *   sendspin-core.js  (extracted protocol/time-sync/state/player from sendspin-lib.js;
 *                       transpiled to node 8 by build-core.mjs + esbuild)
 *     -> GstAudioProcessor (headless; forwards encoded payload to an injected sink)
 *        -> GstSink (this file; spawns gst-launch per negotiated codec)
 *   node-env.js       (installs WebSocket/performance/URL/window globals for node 8)
 *
 * node 8.12 compatible: no arrow fns, no optional chaining, no class fields.
 */

require('./node-env'); // must run before sendspin-core (installs globals)

var Service = require('webos-service');
var core = require('./sendspin-core');
var SendspinPlayer = core.SendspinPlayer;
var GstSink = require('./gst-sink').GstSink;
var maLogin = require('./ma-login');
var mdns = require('./mdns-discover');
var configHttp = require('./config-http');
var persist = require('./persist');
var os = require('os');

var SERVICE_ID = 'com.sendspin.cinema.service';
var service = new Service(SERVICE_ID);

var CONFIG_HTTP_PORT = 3917; // LAN config web UI (browse http://<tv-ip>:3917)

// First non-internal IPv4 address, so the UI can show "configure from your computer".
function lanIp() {
  var ifaces = os.networkInterfaces();
  for (var name in ifaces) {
    var addrs = ifaces[name] || [];
    for (var i = 0; i < addrs.length; i++) {
      if (addrs[i].family === 'IPv4' && !addrs[i].internal) { return addrs[i].address; }
    }
  }
  return null;
}

/* Opt-in file log: webOS discards a JS service's stdout, so this is the only way
 * to see lifecycle events on-device. Off by default (zero cost); enable for
 * debugging by `touch /tmp/sendspin-debug.enable` before the service starts. */
var fs = require('fs');
var DBG_FILE = '/tmp/sendspin-debug.log';
var DBG_ON = false;
try { fs.statSync('/tmp/sendspin-debug.enable'); DBG_ON = true; } catch (e) { DBG_ON = false; }
function dbg(m) {
  if (!DBG_ON) { return; }
  try { fs.appendFileSync(DBG_FILE, new Date().toISOString() + ' ' + m + '\n'); } catch (e) {}
}
dbg('=== service process started ===');

var MA_SENDSPIN_PORT = 8095; // Music Assistant webserver port (serves /ws + /sendspin)

/* ------------------------------------------------------------------ state */

var state = {
  status: 'idle',          // idle | connecting | buffering | playing | paused | error
  server: null,            // Music Assistant host (ip or host[:port])
  username: null,          // MA login (required when the server has auth enabled)
  password: null,
  playerName: 'Sendspin Cinema',
  bootOnStart: true,
  defaultVolume: 70,       // 0..100 volume applied to a fresh player (until MA sets one)
  keepAwake: false,        // when true, veto the TV screensaver so the panel stays on
  track: null,             // { title, artist, artwork } when known
  error: null
};

function clampVol(v) {
  var n = parseInt(v, 10);
  if (isNaN(n)) { return null; }
  return Math.max(0, Math.min(100, n));
}

var player = null;
var statusSubscribers = [];

/* ---------------------------------------------------------------- keep-alive */
/* webos-service exits the process (process.exit(0)) after ~5s with no held
 * activitymanager activity. A background audio daemon must stay resident to keep
 * its WebSocket to Music Assistant open, so while a server is configured we hold
 * one never-completed activity (created via the bundled ActivityManager, which
 * calls _stopTimer and cancels the idle-exit). Released on disconnect/idle. */
var keepAlive = null;

function startKeepAlive() {
  if (keepAlive) { return; }
  try {
    service.activityManager.create('sendspin-keepalive', function (activity) {
      keepAlive = activity;
      console.log('Sendspin: keep-alive activity held (service stays resident)');
    });
  } catch (e) {
    console.error('Sendspin: keep-alive create failed', e);
  }
}

function stopKeepAlive() {
  if (!keepAlive) { return; }
  try { service.activityManager.complete(keepAlive, function () {}); } catch (e) {}
  keepAlive = null;
  console.log('Sendspin: keep-alive released (service may idle-exit)');
}

/* ------------------------------------------ keep-TV-awake (screensaver veto) */
/* Separate from the keep-alive above: that keeps the *service process* resident;
 * this keeps the *TV panel* from blanking. webOS asks all registered clients
 * before starting its screensaver. We hold a subscription and, while keepAwake
 * is on, answer ack:false to veto it — so an audio-only session (no remote input
 * for long stretches) doesn't dim/turn the screen off. The service owns this (not
 * the foreground app) so it can be toggled from the LAN web page too: a remote
 * browser can't make this on-TV Luna call itself. */
var SS_REGISTER = 'luna://com.webos.service.tvpower/power/registerScreenSaverRequest';
var SS_RESPONSE = 'luna://com.webos.service.tvpower/power/responseScreenSaverRequest';
var SS_TURNON = 'luna://com.webos.service.tvpower/power/turnOnScreen';
var SS_CLIENT = 'com.sendspin.cinema.service';
var screenSaverSub = null;

function startScreenSaverGuard() {
  if (screenSaverSub) { return; }
  try {
    screenSaverSub = service.subscribe(SS_REGISTER, { subscribe: true, clientName: SS_CLIENT });
    screenSaverSub.on('response', function (m) {
      var p = (m && m.payload) || {};
      // Fired when the TV is about to start its screensaver. Respond before it
      // times out: veto (ack:false) only while keepAwake is on, else allow.
      if (p.state === 'Active' && p.timestamp != null) {
        service.call(SS_RESPONSE, { clientName: SS_CLIENT, ack: !state.keepAwake, timestamp: p.timestamp }, function () {});
      }
    });
    screenSaverSub.on('cancel', function () { screenSaverSub = null; });
    console.log('Sendspin: screensaver guard registered');
  } catch (e) {
    console.error('Sendspin: screensaver guard failed', e);
    screenSaverSub = null;
  }
}

function setKeepAwake(on) {
  state.keepAwake = !!on;
  savePersist();
  // If turning on after the panel already blanked, wake it now.
  if (state.keepAwake) { try { service.call(SS_TURNON, {}, function () {}); } catch (e) {} }
  pushStatus();
  return state.keepAwake;
}

function snapshot() {
  return {
    status: state.status,
    server: state.server,
    username: state.username,        // password is never echoed back
    playerName: state.playerName,
    bootOnStart: state.bootOnStart,
    defaultVolume: state.defaultVolume,
    keepAwake: state.keepAwake,
    track: state.track,
    error: state.error,
    connected: !!(player && player.isConnected),
    configUrl: lanIp() ? ('http://' + lanIp() + ':' + CONFIG_HTTP_PORT) : null
  };
}

function pushStatus() {
  for (var i = statusSubscribers.length - 1; i >= 0; i--) {
    try {
      statusSubscribers[i].respond({ returnValue: true, subscribed: true, state: snapshot() });
    } catch (e) {
      statusSubscribers.splice(i, 1);
    }
  }
}

function setStatus(s, err) {
  state.status = s;
  state.error = err || null;
  if (err) { console.error('Sendspin service:', err); }
  pushStatus();
}

/* ----------------------------------------------------------------- sink */
/* GstSink lives in gst-sink.js (reusable + on-device testable). Wrap each one so
 * its lifecycle events drive the service status. */

function makeSink(format) {
  return new GstSink(format, function (name, detail) {
    if (name === 'error') { setStatus('error', 'gst: ' + detail); }
    else if (name === 'exit') { if (state.status === 'playing') { setStatus('buffering'); } }
    else if (name === 'write') {
      if (state.status === 'buffering' || state.status === 'connecting') { setStatus('playing'); }
    }
  });
}

/* ---------------------------------------------------- Music Assistant player */

function buildBaseUrl(server) {
  // Accept "1.2.3.4", "1.2.3.4:8927", "http://host", "ws://host:port".
  var raw = server.indexOf('://') >= 0 ? server : 'http://' + server;
  var u = new URL(raw);
  var proto = (u.protocol === 'https:' || u.protocol === 'wss:') ? 'https:' : 'http:';
  var port = u.port || String(MA_SENDSPIN_PORT);
  return proto + '//' + u.hostname + ':' + port;
}

function onCoreState(s) {
  if (s.serverState && s.serverState.metadata) {
    var m = s.serverState.metadata;
    state.track = {
      title: m.title || null,
      artist: m.artist || null,
      artwork: m.artwork_url || m.art || m.image || null,
      duration: (m.progress && m.progress.track_duration) || null,
      position: (m.progress && m.progress.track_progress) || null
    };
  }
  if (s.groupState && s.groupState.playback_state) {
    state.status = (s.groupState.playback_state === 'playing') ? 'playing' : 'paused';
  }
  dbg('onCoreState pb=' + (s.groupState && s.groupState.playback_state) + ' isConnected=' + !!(player && player.isConnected));
  pushStatus();
}

// Monotonic connect generation. Every connect() bumps it; any async work (login,
// player creation) carries the generation it started under and bails if a newer
// connect() has superseded it. This collapses duplicate/rapid setServer calls
// into a single live player — critical because MA dedups players by client_id, so
// multiple players sharing our client_id would evict each other and flap.
var connectGen = 0;

function startPlayer(baseUrl, authToken, gen) {
  if (gen !== connectGen) { dbg('startPlayer superseded gen=' + gen + ' cur=' + connectGen); return; }
  if (player) { try { player.disconnect(); } catch (e) {} player = null; }
  var safeId = 'webos-' + state.playerName.toLowerCase().replace(/[^a-z0-9]/g, '-');
  var thisPlayer = new SendspinPlayer({
    playerId: safeId,
    clientName: state.playerName,
    baseUrl: baseUrl,
    authToken: authToken,               // null when MA has no auth; else MA access token
    codecs: ['flac', 'pcm'],            // on-device gstreamer decoders (no Opus)
    storage: null,
    createSink: makeSink,
    onStateChange: function (s) { if (thisPlayer === player) { onCoreState(s); } }
  });
  player = thisPlayer;
  // Seed the player with the configured default volume; MA may override it on
  // connect if it remembers a volume for this player. Applied to the stream when
  // the first sink is created.
  try { thisPlayer.setVolume(state.defaultVolume); } catch (e) { dbg('setVolume default failed ' + e); }
  dbg('startPlayer connecting gen=' + gen + ' to ' + baseUrl);
  player.connect()
    .then(function () { dbg('player.connect() resolved isConnected=' + thisPlayer.isConnected); })
    .catch(function (e) { dbg('player.connect() rejected ' + (e && (e.message || e))); if (thisPlayer === player) { setStatus('error', 'connect ' + baseUrl + ': ' + e); } });
}

function connect() {
  var gen = ++connectGen;
  if (player) { try { player.disconnect(); } catch (e) {} player = null; }
  if (!state.server) { setStatus('idle'); return; } // keep-alive stays (LAN config server)
  var baseUrl;
  try { baseUrl = buildBaseUrl(state.server); }
  catch (e) { setStatus('error', 'bad server "' + state.server + '": ' + e); return; }
  startKeepAlive();                      // stay resident while we hold a connection
  setStatus('connecting');

  if (state.username) {
    // MA has auth: exchange username/password for an access token, then connect.
    var hostPort = new URL(baseUrl).host;
    maLogin.getToken(hostPort, state.username, state.password, function (err, token) {
      if (gen !== connectGen) { dbg('login superseded gen=' + gen + ' cur=' + connectGen); return; }
      if (err) { setStatus('error', 'login: ' + (err.message || err)); return; }
      startPlayer(baseUrl, token, gen);
    });
  } else {
    startPlayer(baseUrl, null, gen);
  }
}

function forward(command) {
  if (!player || !player.isConnected) { return { ok: false, reason: 'not connected' }; }
  try { player.sendCommand(command); return { ok: true }; }
  catch (e) { return { ok: false, reason: String(e) }; }
}

/* Shared config entry point used by both the Luna API (setServer) and the LAN
 * config web server (POST /api/config). Sets server/creds/name and (re)connects. */
function savePersist() {
  persist.save({
    server: state.server,
    username: state.username,
    password: state.password,
    playerName: state.playerName,
    bootOnStart: state.bootOnStart,
    defaultVolume: state.defaultVolume,
    keepAwake: state.keepAwake
  });
}

function applyConfig(p) {
  p = p || {};
  dbg('applyConfig server=' + p.server);
  if (p.playerName) { state.playerName = p.playerName; }
  if (p.defaultVolume !== undefined && p.defaultVolume !== null && p.defaultVolume !== '') {
    var dv = clampVol(p.defaultVolume);
    if (dv !== null) { state.defaultVolume = dv; }
  }
  if (p.keepAwake !== undefined) { setKeepAwake(p.keepAwake); }
  state.server = p.server || null;
  if (p.username !== undefined) { state.username = p.username || null; }
  if (p.password !== undefined) { state.password = p.password || null; }
  savePersist();   // survive app reinstall / reboot
  connect();
  return snapshot();
}

/* --------------------------------------------------------------- Luna API */

service.register('setServer', function (msg) {
  var state2 = applyConfig(msg.payload || {});
  msg.respond({ returnValue: true, state: state2 });
});

service.register('discover', function (msg) {
  var timeout = (msg.payload && msg.payload.timeoutMs) || 3000;
  mdns.discover(timeout, function (err, servers) {
    msg.respond({ returnValue: !err, error: err ? String(err.message || err) : null, servers: servers || [] });
  });
});

service.register('setPlayerName', function (msg) {
  state.playerName = (msg.payload && msg.payload.playerName) || state.playerName;
  savePersist();
  if (state.server) { connect(); } // re-register under the new name
  msg.respond({ returnValue: true, state: snapshot() });
});

service.register('setKeepAwake', function (msg) {
  var on = setKeepAwake(!!(msg.payload && msg.payload.keepAwake));
  msg.respond({ returnValue: true, keepAwake: on, state: snapshot() });
});

service.register('setBootOnStart', function (msg) {
  state.bootOnStart = !!(msg.payload && msg.payload.bootOnStart);
  savePersist();
  // TODO Phase 5: register/unregister a bootd activity per this flag.
  pushStatus();
  msg.respond({ returnValue: true, bootOnStart: state.bootOnStart });
});

service.register('play', function (msg) {
  if (!player) { connect(); }
  var r = forward('play');
  msg.respond({ returnValue: r.ok, reason: r.reason, state: snapshot() });
});

service.register('pause', function (msg) {
  var r = forward('pause');
  msg.respond({ returnValue: r.ok, reason: r.reason, state: snapshot() });
});

service.register('stop', function (msg) {
  var r = forward('stop');
  msg.respond({ returnValue: r.ok, reason: r.reason, state: snapshot() });
});

service.register('next', function (msg) {
  var r = forward('next');
  msg.respond({ returnValue: r.ok, reason: r.reason, state: snapshot() });
});

service.register('previous', function (msg) {
  var r = forward('previous');
  msg.respond({ returnValue: r.ok, reason: r.reason, state: snapshot() });
});

service.register('disconnect', function (msg) {
  state.server = null;
  savePersist();                         // forget the server across reinstall/reboot too
  if (player) { try { player.disconnect(); } catch (e) {} player = null; }
  setStatus('idle');                     // keep-alive stays so the LAN config UI lives on
  msg.respond({ returnValue: true, state: snapshot() });
});

service.register('status', function (msg) {
  if (msg.isSubscription) { statusSubscribers.push(msg); }
  msg.respond({ returnValue: true, subscribed: !!msg.isSubscription, state: snapshot() });
});

/* ----------------------------------------------------- LAN config web server */
/* Serve the config page (and /api/discover + /api/config) to any device on the
 * LAN, so the player can be set up from a computer/phone keyboard. Holding the
 * keep-alive while it runs keeps the service (and the page, and any MA connection)
 * resident after the app has been opened once — until the TV reboots or a bootd
 * autostart (Phase 5b) makes it always-on. */
configHttp.start(CONFIG_HTTP_PORT, {
  snapshot: snapshot,
  discover: function (cb) { mdns.discover(3000, cb); }, // config-http calls discover(cb)
  applyConfig: applyConfig,
  setKeepAwake: setKeepAwake
});
startKeepAlive();
startScreenSaverGuard();

/* Restore config saved on the persistent partition (survives app reinstall/reboot)
 * and reconnect on our own — no need to wait for the app to re-push it. */
(function restorePersisted() {
  var saved = persist.load();
  if (!saved) { dbg('no persisted config'); return; }
  if (saved.playerName) { state.playerName = saved.playerName; }
  if (typeof saved.bootOnStart === 'boolean') { state.bootOnStart = saved.bootOnStart; }
  if (saved.defaultVolume !== undefined) { var sv = clampVol(saved.defaultVolume); if (sv !== null) { state.defaultVolume = sv; } }
  if (typeof saved.keepAwake === 'boolean') { state.keepAwake = saved.keepAwake; }
  state.server = saved.server || null;
  state.username = saved.username || null;
  state.password = saved.password || null;
  dbg('restored persisted config server=' + state.server + ' (' + persist.path() + ')');
  if (state.server) { connect(); }
})();

console.log('Sendspin Cinema service ready:', SERVICE_ID);
