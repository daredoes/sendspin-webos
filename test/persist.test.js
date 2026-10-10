'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const persist = require('../services/com.sendspin.webos.service/persist');

test('writeAtomic replaces a read-only config file', () => {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'persist-')), 'cfg.json');
  fs.writeFileSync(p, '{"defaultVolume":70}');
  fs.chmodSync(p, 0o444);
  persist.writeAtomic(p, '{"defaultVolume":30}');
  assert.strictEqual(fs.readFileSync(p, 'utf8'), '{"defaultVolume":30}');
  assert.ok(!fs.existsSync(p + '.tmp'));
});
