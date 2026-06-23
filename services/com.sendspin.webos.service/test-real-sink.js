/* On-device test: drive the REAL production audio path with real audio, no MA
 * server. Frames a FLAC file into Sendspin player chunks ([4][BE int64 ts][payload])
 * and pushes them through GstAudioProcessor -> GstSink -> pulsesink, exactly as the
 * live stream would. Expect: gst PLAYING -> clean EOS (audio mixes with HDMI).
 *
 *   node test-real-sink.js /tmp/test.flac
 */
require('./node-env');
var fs = require('fs');
var core = require('./sendspin-core');
var GstSink = require('./gst-sink').GstSink;

var infile = process.argv[2] || '/tmp/test.flac';
var format = { codec: 'flac', sample_rate: 48000, channels: 2, bit_depth: 16 };

var p = new core.SendspinPlayer({
  playerId: 'webos-realtest', clientName: 'RealTest', baseUrl: 'http://127.0.0.1:1',
  codecs: ['flac', 'pcm'], storage: null,
  createSink: function (fmt) {
    return new GstSink(fmt, function (name, detail) {
      if (name === 'exit') { console.log('[real] gst exit code=' + detail); finish(); }
      if (name === 'error') { console.log('[real] gst error ' + detail); finish(1); }
    });
  },
  onStateChange: function () {}
});

// Simulate the protocol: server/state set a format, then binary audio chunks.
p.stateManager.currentStreamFormat = format;
p.audioProcessor.initAudioContext();

var data = fs.readFileSync(infile);
var CHUNK = 4096, off = 0, frames = 0;
console.log("[real] feeding " + data.length + " bytes of FLAC as chunks");
while (off < data.length) {
  var end = Math.min(off + CHUNK, data.length);
  var payload = data.slice(off, end);
  var head = Buffer.alloc(9);          // [0]=role byte, [1..8]=BE int64 ts (0, unused by sink)
  head[0] = 4;                         // player audio chunk
  var chunk = Buffer.concat([head, payload]);
  p.audioProcessor.handleBinaryMessage(new Uint8Array(chunk));
  frames++; off = end;
}
console.log('[real] fed ' + frames + ' chunks; ending stream');
// End-of-stream: close the sink's stdin so gst drains to EOS.
if (p.audioProcessor.sink && p.audioProcessor.sink.proc) {
  try { p.audioProcessor.sink.proc.stdin.end(); } catch (e) {}
}

var done = false;
function finish(code) { if (done) return; done = true; setTimeout(function () { process.exit(code || 0); }, 200); }
setTimeout(function () { console.log('[real] timeout'); finish(0); }, 12000);
