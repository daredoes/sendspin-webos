'use strict';
const test = require('node:test');
const assert = require('node:assert');
const sink = require('../services/com.sendspin.webos.service/gst-sink');

test('pacatArgs plays S16LE PCM at the stream rate and channel count', () => {
  assert.deepStrictEqual(sink.pacatArgs({ sample_rate: 44100, channels: 2 }), [
    '--playback', '--format=s16le', '--rate=44100', '--channels=2',
    '--client-name=sendspin-cinema', '--stream-name=sendspin-cinema'
  ]);
  assert.ok(sink.pacatArgs({}).includes('--rate=48000'));
});
