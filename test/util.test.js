'use strict';
const test = require('node:test');
const assert = require('node:assert');
const util = require('../services/com.sendspin.webos.service/util');

test('clampVol clamps and parses', () => {
  assert.strictEqual(util.clampVol(50), 50);
  assert.strictEqual(util.clampVol('70'), 70);
  assert.strictEqual(util.clampVol(-5), 0);
  assert.strictEqual(util.clampVol(150), 100);
  assert.strictEqual(util.clampVol('abc'), null);
  assert.strictEqual(util.clampVol(''), null);
});

test('buildBaseUrl normalizes server forms', () => {
  assert.strictEqual(util.buildBaseUrl('1.2.3.4'), 'http://1.2.3.4:8095');
  assert.strictEqual(util.buildBaseUrl('1.2.3.4:8927'), 'http://1.2.3.4:8927');
  assert.strictEqual(util.buildBaseUrl('http://host'), 'http://host:8095');
  assert.strictEqual(util.buildBaseUrl('ws://host:9000'), 'http://host:9000');
  assert.strictEqual(util.buildBaseUrl('https://host'), 'https://host:8095');
  assert.strictEqual(util.buildBaseUrl('wss://host:1'), 'https://host:1');
  assert.strictEqual(util.buildBaseUrl('1.2.3.4', 9999), 'http://1.2.3.4:9999');
});

test('buildServer combines host + optional port', () => {
  assert.strictEqual(util.buildServer('1.2.3.4', '8095'), '1.2.3.4:8095');
  assert.strictEqual(util.buildServer('1.2.3.4', ''), '1.2.3.4');
  assert.strictEqual(util.buildServer('1.2.3.4:9', '8095'), '1.2.3.4:9'); // existing port wins
  assert.strictEqual(util.buildServer('http://host/', '80'), 'http://host:80'); // trailing slash trimmed
  assert.strictEqual(util.buildServer('', '80'), '');
});

test('makePin is a 4-digit string', () => {
  for (let i = 0; i < 200; i++) {
    const pin = util.makePin();
    assert.match(pin, /^[0-9]{4}$/);
  }
});
