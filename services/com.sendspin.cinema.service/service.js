/*
 * com.sendspin.cinema.service — background audio daemon for webOS.
 *
 * Headless JS service. Connects to Music Assistant, streams encoded audio, and
 * decodes on-device via gstreamer into pulsesink, which mixes with live TV/HDMI
 * audio (proven Phase 1 + Phase 2 on hardware: node -> gst-launch stdin ->
 * pulsesink, FLAC, clean EOS).
 *
 * node 8.12 compatible: no arrow fns, no const/let in hot paths, no async/await.
 *
 * Status: Phase 3 skeleton. The GstSink (decode+play) path is the real, hardware-
 * validated piece. The Music Assistant WebSocket client is stubbed (TODO Phase 3)
 * so the Luna surface and sink lifecycle can be wired and tested independently.
 */

var Service = require('webos-service');
var spawn = require('child_process').spawn;

var SERVICE_ID = 'com.sendspin.cinema.service';
var service = new Service(SERVICE_ID);

/* ------------------------------------------------------------------ state */

var state = {
  status: 'idle',          // idle | buffering | playing | paused | error
  server: null,            // Music Assistant ws://host:port
  playerName: 'Sendspin Cinema',
  bootOnStart: true,
  codec: 'flac',           // flac (MVP) | pcm ; opus unsupported until asm.js decoder
  track: null,             // { title, artist, ... } when known
  error: null
};

var statusSubscribers = [];

function pushStatus() {
  var i;
  for (i = statusSubscribers.length - 1; i >= 0; i--) {
    try {
      statusSubscribers[i].respond({ returnValue: true, subscribed: true, state: snapshot() });
    } catch (e) {
      statusSubscribers.splice(i, 1);
    }
  }
}

function snapshot() {
  return {
    status: state.status,
    server: state.server,
    playerName: state.playerName,
    bootOnStart: state.bootOnStart,
    codec: state.codec,
    track: state.track,
    error: state.error
  };
}

function setStatus(s, err) {
  state.status = s;
  state.error = err || null;
  pushStatus();
}

/* -------------------------------------------------------------- GstSink */
/* Hardware-validated sink: spawn gst-launch reading the encoded stream on
 * stdin (fdsrc), decode, and play through pulsesink. One sink per playback
 * session; recreated on track/codec change. */

function pipelineFor(codec) {
  if (codec === 'pcm') {
    // Raw S16LE 48k stereo from Music Assistant.
    return ['fdsrc fd=0',
            'rawaudioparse use-sink-caps=false format=pcm pcm-format=s16le sample-rate=48000 num-channels=2',
            'audioconvert', 'audioresample', 'pulsesink'];
  }
  // Default: FLAC (proven end-to-end on device).
  return ['fdsrc fd=0', 'flacparse', 'avdec_flac', 'audioconvert', 'audioresample', 'pulsesink'];
}

function GstSink(codec) {
  this.codec = codec || 'flac';
  this.proc = null;
}

GstSink.prototype.start = function () {
  var self = this;
  var args = pipelineFor(this.codec).join(' ! ').split(' ');
  this.proc = spawn('gst-launch-1.0', args, { stdio: ['pipe', 'inherit', 'inherit'] });
  this.proc.on('error', function (e) { setStatus('error', 'gst spawn: ' + e); });
  this.proc.on('exit', function (code, sig) {
    self.proc = null;
    if (state.status === 'playing') setStatus('idle');
  });
  if (this.proc.stdin) {
    this.proc.stdin.on('error', function () { /* sink closed; ignore broken pipe */ });
  }
  return this;
};

GstSink.prototype.write = function (buf) {
  if (this.proc && this.proc.stdin && this.proc.stdin.writable) {
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

var sink = null;

/* ---------------------------------------------------- Music Assistant (TODO) */
/* Phase 3: open ws to state.server, subscribe to the player queue, and pipe the
 * encoded audio frames into sink.write(). For now playback is driven by an
 * explicit local file via play({file}) to exercise the sink on-device. */

var fs = require('fs');
function feedFile(path) {
  var fd, buf, n, ok;
  try { fd = fs.openSync(path, 'r'); } catch (e) { setStatus('error', 'open ' + path + ': ' + e); return; }
  buf = Buffer.alloc(4096);
  function pump() {
    while (true) {
      n = fs.readSync(fd, buf, 0, 4096, null);
      if (n <= 0) { fs.closeSync(fd); if (sink) { try { sink.proc.stdin.end(); } catch (e) {} } return; }
      ok = sink.write(Buffer.from(buf.slice(0, n)));
      if (!ok && sink.proc) { sink.proc.stdin.once('drain', pump); return; }
    }
  }
  pump();
}

/* --------------------------------------------------------------- Luna API */

service.register('play', function (msg) {
  var p = msg.payload || {};
  if (p.codec) state.codec = p.codec;
  if (sink) sink.stop();
  sink = new GstSink(state.codec).start();
  setStatus('playing');
  if (p.file) feedFile(p.file);          // dev/test path; MA stream replaces this
  msg.respond({ returnValue: true, state: snapshot() });
});

service.register('pause', function (msg) {
  // gstreamer pause is a pipeline state change; for the stdin-fed sink we hold
  // the feed. Full PAUSED transition lands with the libgst host in Phase 3.
  if (state.status === 'playing') setStatus('paused');
  msg.respond({ returnValue: true, state: snapshot() });
});

service.register('stop', function (msg) {
  if (sink) { sink.stop(); sink = null; }
  setStatus('idle');
  msg.respond({ returnValue: true, state: snapshot() });
});

service.register('setServer', function (msg) {
  state.server = (msg.payload && msg.payload.server) || null;
  pushStatus();
  msg.respond({ returnValue: true, server: state.server });
});

service.register('setPlayerName', function (msg) {
  state.playerName = (msg.payload && msg.payload.playerName) || state.playerName;
  pushStatus();
  msg.respond({ returnValue: true, playerName: state.playerName });
});

service.register('setBootOnStart', function (msg) {
  state.bootOnStart = !!(msg.payload && msg.payload.bootOnStart);
  // TODO Phase 5: register/unregister bootd activity per this flag.
  pushStatus();
  msg.respond({ returnValue: true, bootOnStart: state.bootOnStart });
});

service.register('status', function (msg) {
  if (msg.isSubscription) statusSubscribers.push(msg);
  msg.respond({ returnValue: true, subscribed: !!msg.isSubscription, state: snapshot() });
});
