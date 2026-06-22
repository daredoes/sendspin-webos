/*
 * gst-sink.js — the hardware-validated audio sink.
 *
 * Spawns gst-launch reading the encoded stream on stdin (fdsrc), decoding per the
 * negotiated codec, and playing through pulsesink — which mixes with live TV/HDMI
 * audio (Phase 1 + Phase 2, proven on hardware). One GstSink per stream format;
 * GstAudioProcessor recreates it on codec/sample-rate change.
 *
 * Volume (Music Assistant's player volume/mute) is applied STREAM-ONLY via an
 * in-pipeline gstreamer `volume` element that scales the decoded PCM samples. This
 * deliberately avoids PulseAudio's per-sink-input volume: on this LG webOS build
 * `pactl set-sink-input-volume` is broken (it garbles the channel volume struct —
 * "tried to set volumes for N channels"), `pacmd` has no reachable socket, and
 * `pulsesink volume=` is overridden by module-stream-restore. Scaling samples in
 * the pipeline is independent of all that and, by construction, only attenuates
 * OUR audio — never the television's own/master volume. gst-launch can't change an
 * element property at runtime, so a volume change respawns the pipeline at the new
 * gain (debounced, so a slider drag collapses to one respawn).
 *
 * Kept separate from service.js so it can be unit-tested on-device without the
 * Luna bus. node 8.12 compatible.
 */
var spawn = require('child_process').spawn;

/* A unique tag stamped on our pulsesink stream (client-name + media.name) so the
 * stream is identifiable in `pactl list sink-inputs` for debugging. */
var STREAM_TAG = 'sendspin-cinema';

// pulsesink with our identifying tags. No spaces inside tokens so the caller's
// ' '-split of the joined pipeline keeps each property a separate gst argument.
var PULSESINK = 'pulsesink client-name=' + STREAM_TAG +
                ' stream-properties=props,media.name=' + STREAM_TAG;

// level: 0..1 gain for the `volume` element. Placed in the PCM domain (after
// decode/audioconvert) so it scales samples — stream-only attenuation.
function pipelineFor(format, level) {
  var rate = format.sample_rate || 48000;
  var ch = format.channels || 2;
  var vol = 'volume volume=' + fmtLevel(level);
  if (format.codec === 'pcm') {
    return ['fdsrc fd=0',
            'rawaudioparse use-sink-caps=false format=pcm pcm-format=s16le sample-rate=' + rate + ' num-channels=' + ch,
            'audioconvert', vol, 'audioresample', PULSESINK];
  }
  if (format.codec === 'flac') {
    return ['fdsrc fd=0', 'flacparse', 'avdec_flac', 'audioconvert', vol, 'audioresample', PULSESINK];
  }
  // Opus has no software decoder on this device; we never advertise it, so this
  // should be unreachable. Fail loudly if the server negotiates it anyway.
  throw new Error('unsupported codec for on-device gst sink: ' + format.codec);
}

// Clamp + format a 0..1 gain to a stable, space-free token for gst-launch.
function fmtLevel(level) {
  var l = (typeof level === 'number' && isFinite(level)) ? level : 1;
  l = Math.max(0, Math.min(1, l));
  return l.toFixed(3);
}

// onEvent(name, detail) is optional; lets the caller react to spawn/exit without
// this module depending on service state. names: 'error' | 'exit' | 'write'.
function GstSink(format, onEvent) {
  this.codec = format.codec;
  this.sampleRate = format.sample_rate;
  this._format = format;
  this._onEvent = onEvent || function () {};
  this._level = 1;        // currently-spawned gain (0..1)
  this._wantLevel = 1;    // target gain after debounce
  this._volTimer = null;
  this._spawn();
}

GstSink.prototype._spawn = function () {
  var args = pipelineFor(this._format, this._level).join(' ! ').split(' ');
  console.log('Sendspin sink: gst-launch-1.0 ' + args.join(' '));
  this.proc = spawn('gst-launch-1.0', args, { stdio: ['pipe', 'inherit', 'inherit'] });
  var self = this;
  this.proc.on('error', function (e) { self._onEvent('error', e); });
  this.proc.on('exit', function (code) { self._onEvent('exit', code); });
  if (this.proc.stdin) {
    this.proc.stdin.on('error', function () { /* sink closed mid-write; ignore EPIPE */ });
  }
};

GstSink.prototype.write = function (buf) {
  if (this.proc && this.proc.stdin && this.proc.stdin.writable) {
    this._onEvent('write', buf.length);
    return this.proc.stdin.write(buf);
  }
  return false;
};

/* Set Music Assistant's player volume (0..100) + mute on OUR stream only. Mute is
 * gain 0; otherwise gain = volume/100. A change debounce-respawns the pipeline so
 * a slider drag (many rapid commands) collapses to a single respawn. */
GstSink.prototype.setVolume = function (volumePct, muted) {
  var pct = (typeof volumePct === 'number' && isFinite(volumePct)) ? volumePct : 100;
  var lvl = Math.max(0, Math.min(1, pct / 100));
  this._wantLevel = muted ? 0 : lvl;
  if (Math.abs(this._wantLevel - this._level) < 0.001) { return; } // no real change
  var self = this;
  if (this._volTimer) { clearTimeout(this._volTimer); }
  this._volTimer = setTimeout(function () {
    self._volTimer = null;
    if (!self.proc) { return; }                                   // stopped meanwhile
    if (Math.abs(self._wantLevel - self._level) < 0.001) { return; }
    self._level = self._wantLevel;
    self._respawn();
  }, 300);
};

// Restart the pipeline at the current this._level, feeding the same stdin stream.
// flacparse/rawaudioparse resync to the next frame after the brief gap.
GstSink.prototype._respawn = function () {
  var old = this.proc;
  if (old) {
    try { old.stdin.end(); } catch (e) {}
    try { old.kill('SIGTERM'); } catch (e) {}
  }
  this._spawn();
};

GstSink.prototype.stop = function () {
  if (this._volTimer) { clearTimeout(this._volTimer); this._volTimer = null; }
  if (this.proc) {
    try { this.proc.stdin.end(); } catch (e) {}
    try { this.proc.kill('SIGTERM'); } catch (e) {}
    this.proc = null;
  }
};

module.exports = { GstSink: GstSink, pipelineFor: pipelineFor };
