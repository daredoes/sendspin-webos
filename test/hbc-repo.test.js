'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const build = require('../scripts/hbc-repo');

test('builds a Homebrew Channel manifest and repo index for a release', () => {
  const ipk = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hbc-')), 'com.sendspin.webos_1.2.3_all.ipk');
  fs.writeFileSync(ipk, 'ipk-bytes');
  const appinfo = { id: 'com.sendspin.webos', version: '1.2.3', type: 'web', title: 'Sendspin WebOS' };
  const { manifest, apps } = build('v1.2.3', ipk, appinfo);

  const base = 'https://github.com/daredoes/sendspin-webos/releases/download/v1.2.3/';
  assert.strictEqual(manifest.id, 'com.sendspin.webos');
  assert.strictEqual(manifest.version, '1.2.3');
  assert.strictEqual(manifest.ipkUrl, base + 'com.sendspin.webos_1.2.3_all.ipk');
  assert.strictEqual(manifest.ipkHash.sha256, crypto.createHash('sha256').update('ipk-bytes').digest('hex'));

  assert.deepStrictEqual(apps.paging, { page: 1, count: 1, maxPage: 1, itemsTotal: 1, prevUrl: null, nextUrl: null });
  assert.strictEqual(apps.packages.length, 1);
  assert.strictEqual(apps.packages[0].manifestUrl, base + 'webosbrew.manifest.json');
  assert.deepStrictEqual(apps.packages[0].manifest, manifest);
});
