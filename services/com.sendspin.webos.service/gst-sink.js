/*
 * gst-sink.js — the hardware-validated audio sink.
 *
 * Two gst-launch stages with a thin node bridge between them:
 *
 *   MA encoded frames                 raw S16LE PCM (stdout)        pulsesink
 *   ──────────────►  [decode gst -q]  ──────────────►  [node gain]  ──────────►  [play gst] ──► speakers
 *   (write -> stdin)  fdsrc!decode!                     scale samples  fdsrc!rawaudioparse!         (mixes with
 *                     fdsink fd=1                        by volume      audioconvert!pulsesink        live HDMI)
 *
 * Volume/mute (Music Assistant's player volume) is applied STREAM-ONLY by scaling
 * the decoded PCM in the node bridge — a live multiplier, so a volume change needs
 * NO pipeline restart. The previous design respawned a single gst pipeline on every
 * volume change, which discarded all the audio buffered ahead (gst + pulsesink read
 * ahead, and MA streams gaplessly), so the pipeline resumed at the live stream edge
 * — sometimes already inside the *next* track. That made volume changes skip/“change
 * track”. Scaling in node fixes that and keeps the TV's own/master volume untouched.
 *
 * Why two gst processes (not pacat): pacat throws pa_stream_write Invalid argument
 * on this webOS build; the raw-PCM -> pulsesink gst pipeline is the Phase 2-proven
 * sink. `-q` on the decode stage is REQUIRED: without it gst-launch prints status
 * text ("Pipeline is PREROLLING…") onto fd=1 and corrupts the PCM.
 *
 * Kept separate from service.js so it can be unit-tested on-device. node 8.12 compatible.
 */
var spawn = require('child_process').spawn;

/* Identifying tag on our pulsesink stream (handy in `pactl list sink-inputs`). */
var STREAM_TAG = 'sendspin-cinema';

// Decode stage: encoded (stdin) -> normalized S16LE PCM (stdout, fd=1).
function decodeArgs(format) {
  var rate = format.sample_rate || 48000;
  var ch = format.channels || 2;
  var caps = 'audio/x-raw,format=S16LE,channels=' + ch + ',rate=' + rate;
  var head;
  if (format.codec === 'flac') {
    head = ['fdsrc', 'fd=0', '!', 'flacparse', '!', 'avdec_flac'];
  } else if (format.codec === 'pcm') {
    head = ['fdsrc', 'fd=0', '!', 'rawaudioparse', 'use-sink-caps=false', 'format=pcm',
            'pcm-format=s16le', 'sample-rate=' + rate, 'num-channels=' + ch];
  } else {
    // Opus has no software decoder on this device; we never advertise it.
    throw new Error('unsupported codec for on-device gst sink: ' + format.codec);
  }
  return ['-q'].concat(head).concat(['!', 'audioconvert', '!', 'audioresample', '!', caps, '!', 'fdsink', 'fd=1']);
}

// Play stage: S16LE PCM (stdin) -> pulsesink (mixes with live HDMI, Phase 1/2 proven).
function playArgs(format) {
  var rate = format.sample_rate || 48000;
  var ch = format.channels || 2;
  return ['-q', 'fdsrc', 'fd=0', '!', 'rawaudioparse', 'use-sink-caps=false', 'format=pcm',
          'pcm-format=s16le', 'sample-rate=' + rate, 'num-channels=' + ch,
          '!', 'audioconvert', '!', 'audioresample', '!',
          'pulsesink', 'client-name=' + STREAM_TAG, 'stream-properties=props,media.name=' + STREAM_TAG];
}

// onEvent(name, detail) optional. names: 'error' | 'exit' | 'write'.
function GstSink(format, onEvent) {
  this.codec = format.codec;
  this.sampleRate = format.sample_rate;
  this._format = format;
  this._onEvent = onEvent || function () {};
  this._gain = 1;        // 0..1 linear gain applied to PCM
  this._muted = false;
  this._spawn();
}

GstSink.prototype._spawn = function () {
  var self = this;
  console.log('Sendspin sink: decode[' + this._format.codec + '] -> gain -> pulsesink');
  this.dec = spawn('gst-launch-1.0', decodeArgs(this._format), { stdio: ['pipe', 'pipe', 'inherit'] });
  this.play = spawn('gst-launch-1.0', playArgs(this._format), { stdio: ['pipe', 'ignore', 'inherit'] });

  this.dec.on('error', function (e) { self._onEvent('error', e); });
  this.play.on('error', function (e) { self._onEvent('error', e); });
  this.dec.on('exit', function (c) { self._onEvent('exit', c); });
  this.play.on('exit', function (c) { self._onEvent('exit', c); });
  if (this.dec.stdin) { this.dec.stdin.on('error', function () {}); }
  if (this.play.stdin) { this.play.stdin.on('error', function () {}); }

  // PCM bridge: scale by current gain and forward, with backpressure from the
  // play stage's stdin so the realtime clock throttles the whole chain.
  this.dec.stdout.on('data', function (buf) {
    var g = self._muted ? 0 : self._gain;
    if (g <= 0) {
      buf.fill(0);
    } else if (g < 0.999) {
      for (var i = 0; i + 1 < buf.length; i += 2) {
        var v = (buf.readInt16LE(i) * g) | 0;
        buf.writeInt16LE(v < -32768 ? -32768 : (v > 32767 ? 32767 : v), i);
      }
    }
    if (self.play && self.play.stdin && self.play.stdin.writable) {
      if (!self.play.stdin.write(buf)) {
        self.dec.stdout.pause();
        self.play.stdin.once('drain', function () { if (self.dec && self.dec.stdout) { self.dec.stdout.resume(); } });
      }
    }
  });
};

// Feed encoded MA frames into the decode stage.
GstSink.prototype.write = function (buf) {
  if (this.dec && this.dec.stdin && this.dec.stdin.writable) {
    this._onEvent('write', buf.length);
    return this.dec.stdin.write(buf);
  }
  return false;
};

// Live volume (0..100) + mute — no respawn, applied in the PCM bridge above.
GstSink.prototype.setVolume = function (volumePct, muted) {
  var pct = (typeof volumePct === 'number' && isFinite(volumePct)) ? volumePct : 100;
  this._gain = Math.max(0, Math.min(1, pct / 100));
  this._muted = !!muted;
};

GstSink.prototype.stop = function () {
  var procs = [this.dec, this.play];
  this.dec = null;
  this.play = null;
  for (var i = 0; i < procs.length; i++) {
    var pr = procs[i];
    if (pr) {
      try { if (pr.stdin) { pr.stdin.end(); } } catch (e) {}
      try { pr.kill('SIGTERM'); } catch (e) {}
    }
  }
};

module.exports = { GstSink: GstSink, decodeArgs: decodeArgs, playArgs: playArgs };
