/*
 * gst-sink.js — the hardware-validated audio sink.
 *
 * Spawns gst-launch reading the encoded stream on stdin (fdsrc), decoding per the
 * negotiated codec, and playing through pulsesink — which mixes with live TV/HDMI
 * audio (Phase 1 + Phase 2, proven on hardware). One GstSink per stream format;
 * GstAudioProcessor recreates it on codec/sample-rate change.
 *
 * Kept separate from service.js so it can be unit-tested on-device without the
 * Luna bus. node 8.12 compatible.
 */
var spawn = require('child_process').spawn;

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

// onEvent(name, detail) is optional; lets the caller react to spawn/exit without
// this module depending on service state. names: 'error' | 'exit' | 'write'.
function GstSink(format, onEvent) {
  this.codec = format.codec;
  this.sampleRate = format.sample_rate;
  this._onEvent = onEvent || function () {};
  var args = pipelineFor(format).join(' ! ').split(' ');
  console.log('Sendspin sink: gst-launch-1.0 ' + args.join(' '));
  this.proc = spawn('gst-launch-1.0', args, { stdio: ['pipe', 'inherit', 'inherit'] });
  var self = this;
  this.proc.on('error', function (e) { self._onEvent('error', e); });
  this.proc.on('exit', function (code) { self._onEvent('exit', code); });
  if (this.proc.stdin) {
    this.proc.stdin.on('error', function () { /* sink closed mid-write; ignore EPIPE */ });
  }
}

GstSink.prototype.write = function (buf) {
  if (this.proc && this.proc.stdin && this.proc.stdin.writable) {
    this._onEvent('write', buf.length);
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

module.exports = { GstSink: GstSink, pipelineFor: pipelineFor };
