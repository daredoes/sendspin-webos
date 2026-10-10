'use strict';
const test = require('node:test');
const assert = require('node:assert');
const sink = require('../services/com.sendspin.webos.service/gst-sink');

test('pacatArgs plays S16LE PCM at the stream rate and channel count', () => {
  assert.deepStrictEqual(sink.pacatArgs({ sample_rate: 44100, channels: 2 }), [
    '--playback', '--format=s16le', '--rate=44100', '--channels=2', '--latency-msec=300',
    '--client-name=sendspin-cinema', '--stream-name=sendspin-cinema'
  ]);
  assert.ok(sink.pacatArgs({}).includes('--rate=48000'));
});

test('volumeGain follows a cubic curve', () => {
  assert.strictEqual(sink.volumeGain(100), 1);
  assert.strictEqual(sink.volumeGain(0), 0);
  assert.ok(Math.abs(sink.volumeGain(50) - 0.125) < 1e-9);
  const db = (pct) => 20 * Math.log10(sink.volumeGain(pct));
  assert.ok(db(70) - db(6) > 60, '6% is far quieter than 70%');
  assert.strictEqual(sink.volumeGain(150), 1);
  assert.strictEqual(sink.volumeGain('x'), 1);
});
