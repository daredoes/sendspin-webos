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
var spawn = require('child_process').spawn;
var core = require('./sendspin-core');
var SendspinPlayer = core.SendspinPlayer;

var SERVICE_ID = 'com.sendspin.cinema.service';
var service = new Service(SERVICE_ID);

var MA_SENDSPIN_PORT = 8927; // Music Assistant Sendspin player default port

/* ------------------------------------------------------------------ state */

var state = {
  status: 'idle',          // idle | connecting | buffering | playing | paused | error
  server: null,            // Music Assistant host (ip or host[:port])
  playerName: 'Sendspin Cinema',
  bootOnStart: true,
  track: null,             // { title, artist, artwork } when known
  error: null
};

var player = null;
var statusSubscribers = [];

function snapshot() {
  return {
    status: state.status,
    server: state.server,
    playerName: state.playerName,
    bootOnStart: state.bootOnStart,
    track: state.track,
    error: state.error,
    connected: !!(player && player.isConnected)
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

/* -------------------------------------------------------------- GstSink */
/* Hardware-validated sink: gst-launch reads the encoded stream on stdin (fdsrc),
 * decodes per the negotiated codec, and plays through pulsesink (mixes with HDMI).
 * One sink per stream format; GstAudioProcessor recreates it on codec/rate change. */

function pipelineFor(format) {
  var rate = format.sample_rate || 48000;
  var ch = format.channels || 2;
  if (format.codec === 'pcm') {
    return ['fdsrc fd=0',
            'rawaudioparse use-sink-caps=false format=pcm pcm-format=s16le sample-rate=' + rate + ' num-channels=' + ch,
            'audioconvert', 'audioresample', 'pulsesink'];
  }
  if (format.codec === 'flac') {
    return ['fdsrc fd=0', 'flacparse', 'avdec_flac', 'audioconvert', 'audioresample', 'pulsesink'];
  }
  // Opus has no software decoder on this device; we never advertise it, so this
  // should be unreachable. Fail loudly if the server negotiates it anyway.
  throw new Error('unsupported codec for on-device gst sink: ' + format.codec);
}

function GstSink(format) {
  this.codec = format.codec;
  this.sampleRate = format.sample_rate;
  var args = pipelineFor(format).join(' ! ').split(' ');
  console.log('Sendspin sink: gst-launch-1.0 ' + args.join(' '));
  this.proc = spawn('gst-launch-1.0', args, { stdio: ['pipe', 'inherit', 'inherit'] });
  this.proc.on('error', function (e) { setStatus('error', 'gst spawn: ' + e); });
  this.proc.on('exit', function (code) {
    if (state.status === 'playing') { setStatus('buffering'); }
  });
  if (this.proc.stdin) {
    this.proc.stdin.on('error', function () { /* sink closed mid-write; ignore EPIPE */ });
  }
}

GstSink.prototype.write = function (buf) {
  if (this.proc && this.proc.stdin && this.proc.stdin.writable) {
    if (state.status === 'buffering' || state.status === 'connecting') { setStatus('playing'); }
    return this.proc.stdin.write(buf);
  }
  return false;
};

GstSink.prototype.stop = function () {
  if (this.proc) {
    try { this.proc.stdin.end(); } catch (e) {}
    try { this.proc.kill('SIGTERM'); } catch (e) {}
    this.proc = null;
  }
};

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
      artwork: m.artwork_url || m.art || m.image || null
    };
  }
  if (s.groupState && s.groupState.playback_state) {
    state.status = (s.groupState.playback_state === 'playing') ? 'playing' : 'paused';
  }
  pushStatus();
}

function connect() {
  if (player) { try { player.disconnect(); } catch (e) {} player = null; }
  if (!state.server) { setStatus('idle'); return; }
  var baseUrl;
  try { baseUrl = buildBaseUrl(state.server); }
  catch (e) { setStatus('error', 'bad server "' + state.server + '": ' + e); return; }

  var safeId = 'webos-' + state.playerName.toLowerCase().replace(/[^a-z0-9]/g, '-');
  player = new SendspinPlayer({
    playerId: safeId,
    clientName: state.playerName,
    baseUrl: baseUrl,
    codecs: ['flac', 'pcm'],            // on-device gstreamer decoders (no Opus)
    storage: null,
    createSink: function (format) { return new GstSink(format); },
    onStateChange: onCoreState
  });
  setStatus('connecting');
  player.connect().catch(function (e) { setStatus('error', 'connect ' + baseUrl + ': ' + e); });
}

function forward(command) {
  if (!player || !player.isConnected) { return { ok: false, reason: 'not connected' }; }
  try { player.sendCommand(command); return { ok: true }; }
  catch (e) { return { ok: false, reason: String(e) }; }
}

/* --------------------------------------------------------------- Luna API */

service.register('setServer', function (msg) {
  state.server = (msg.payload && msg.payload.server) || null;
  connect();
  msg.respond({ returnValue: true, state: snapshot() });
});

service.register('setPlayerName', function (msg) {
  state.playerName = (msg.payload && msg.payload.playerName) || state.playerName;
  if (state.server) { connect(); } // re-register under the new name
  msg.respond({ returnValue: true, state: snapshot() });
});

service.register('setBootOnStart', function (msg) {
  state.bootOnStart = !!(msg.payload && msg.payload.bootOnStart);
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
  if (player) { try { player.disconnect(); } catch (e) {} player = null; }
  setStatus('idle');
  msg.respond({ returnValue: true, state: snapshot() });
});

service.register('status', function (msg) {
  if (msg.isSubscription) { statusSubscribers.push(msg); }
  msg.respond({ returnValue: true, subscribed: !!msg.isSubscription, state: snapshot() });
});

console.log('Sendspin Cinema service ready:', SERVICE_ID);
