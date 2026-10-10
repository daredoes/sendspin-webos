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
 * The play stage is a second gst-launch into pulsesink where gstreamer has pulsesink
 * (webOS 6: pacat there throws pa_stream_write Invalid argument). Builds without
 * pulsesink (webOS 8) play the same PCM through pacat into the same pulseaudio mixer.
 * `-q` on the decode stage is REQUIRED: without it gst-launch prints status text
 * ("Pipeline is PREROLLING…") onto fd=1 and corrupts the PCM.
 *
 * Kept separate from service.js so it can be unit-tested on-device. node 8.12 compatible.
 */
var childProcess = require('child_process');
var spawn = childProcess.spawn;

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

// Play stage without pulsesink: the same S16LE PCM (stdin) through pacat.
function pacatArgs(format) {
  var rate = format.sample_rate || 48000;
  var ch = format.channels || 2;
  // pacat buffers ~2 s by default, which delays every volume change by as much.
  return ['--playback', '--format=s16le', '--rate=' + rate, '--channels=' + ch, '--latency-msec=300',
          '--client-name=' + STREAM_TAG, '--stream-name=' + STREAM_TAG];
}

// Picks the play command once per process: pulsesink when gstreamer has it, else pacat.
var hasPulsesink = null;
function playCommand(format) {
  if (hasPulsesink === null) {
    try {
      hasPulsesink = childProcess.spawnSync('gst-inspect-1.0', ['pulsesink'], { stdio: 'ignore', timeout: 5000 }).status === 0;
    } catch (e) {
      hasPulsesink = true;
    }
  }
  return hasPulsesink ? { cmd: 'gst-launch-1.0', args: playArgs(format) } : { cmd: 'pacat', args: pacatArgs(format) };
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
  var out = playCommand(this._format);
  console.log('Sendspin sink: decode[' + this._format.codec + '] -> gain -> ' + out.cmd);
  this.dec = spawn('gst-launch-1.0', decodeArgs(this._format), { stdio: ['pipe', 'pipe', 'inherit'] });
  this.play = spawn(out.cmd, out.args, { stdio: ['pipe', 'ignore', 'inherit'] });

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
// Cubic curve like pulseaudio's own volume scale: a linear gain leaves low settings
// almost as loud as high ones (6% is only 21 dB below 70%; cubed it is 64 dB below).
function volumeGain(volumePct) {
  var pct = (typeof volumePct === 'number' && isFinite(volumePct)) ? volumePct : 100;
  var v = Math.max(0, Math.min(1, pct / 100));
  return v * v * v;
}

GstSink.prototype.setVolume = function (volumePct, muted) {
  this._gain = volumeGain(volumePct);
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

module.exports = { GstSink: GstSink, decodeArgs: decodeArgs, playArgs: playArgs, pacatArgs: pacatArgs, volumeGain: volumeGain };
