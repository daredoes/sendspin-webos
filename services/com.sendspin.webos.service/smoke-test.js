/* Smoke test: verify node-env + sendspin-core + ws load and run under node 8,
 * and that SendspinPlayer drives the GstAudioProcessor->sink wiring without a
 * real Music Assistant server. Connects to a dead host; expects a clean error. */
require('./node-env');
var core = require('./sendspin-core');
console.log('[smoke] core exports:', Object.keys(core).join(','));
console.log('[smoke] performance.now() =', typeof performance.now(), Math.round(performance.now()));
console.log('[smoke] WebSocket =', typeof WebSocket, 'OPEN=' + WebSocket.OPEN);

var sinkWrites = 0, sinkMade = 0;
function FakeSink(fmt){ sinkMade++; this.codec=fmt.codec; this.sampleRate=fmt.sample_rate; }
FakeSink.prototype.write=function(b){ sinkWrites++; };
FakeSink.prototype.stop=function(){};

var p = new core.SendspinPlayer({
  playerId: 'webos-smoke',
  clientName: 'Smoke',
  baseUrl: 'http://127.0.0.1:59999',      // nothing listening -> graceful fail
  codecs: ['flac','pcm'],
  storage: null,
  createSink: function(fmt){ return new FakeSink(fmt); },
  onStateChange: function(s){ /* no-op */ }
});
console.log('[smoke] SendspinPlayer constructed; isConnected=', p.isConnected);

// Directly exercise the headless audio path: a fake "format" + chunk.
p.stateManager.currentStreamFormat = { codec:'flac', sample_rate:48000, channels:2, bit_depth:16 };
p.audioProcessor.initAudioContext();
var chunk = Buffer.concat([Buffer.from([4]), Buffer.alloc(8), Buffer.from('FLACPAYLOAD')]);
p.audioProcessor.handleBinaryMessage(new Uint8Array(chunk));
console.log('[smoke] sinks created=' + sinkMade + ' payloadWrites=' + sinkWrites + ' (expect 1/1)');

p.connect().then(function(){
  console.log('[smoke] connect resolved (unexpected)'); finish(0);
}).catch(function(e){
  console.log('[smoke] connect rejected as expected:', (e && e.message) || e);
  finish(0);
});
function finish(code){ try{p.disconnect();}catch(e){} setTimeout(function(){ process.exit(code); }, 200); }
setTimeout(function(){ console.log('[smoke] timeout reached'); finish(0); }, 4000);
