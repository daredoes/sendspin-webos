'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const configHttp = require('../services/com.sendspin.webos.service/config-http');

function request(port, method, path, body, headers) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      { host: '127.0.0.1', port, method, path, headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}) },
      (res) => {
        let buf = '';
        res.on('data', (c) => { buf += c; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(buf); } catch (e) { /* non-JSON */ }
          resolve({ status: res.statusCode, json });
        });
      }
    );
    req.on('error', reject);
    if (data) { req.write(data); }
    req.end();
  });
}

function startServer(handlers) {
  const server = configHttp.start(0, handlers);
  return new Promise((resolve) => {
    if (server.listening) { resolve(server); }
    else { server.once('listening', () => resolve(server)); }
  });
}

test('config-http routes, PIN gating, and handler wiring', async () => {
  const calls = {};
  const server = await startServer({
    snapshot: () => ({ status: 'idle', configPin: '1234' }),
    discover: (cb) => cb(null, [{ name: 'MA', url: 'http://1.2.3.4:8095' }]),
    applyConfig: (p) => { calls.config = p; return { ok: true, server: p.server }; },
    setKeepAwake: (v) => { calls.keep = v; return v; },
    setBootOnStart: (v) => { calls.boot = v; return v; },
    getPin: () => '1234'
  });
  const port = server.address().port;

  // Reads are open (no PIN needed).
  const status = await request(port, 'GET', '/api/status');
  assert.strictEqual(status.status, 200);
  assert.strictEqual(status.json.state.configPin, '1234');

  const page = await request(port, 'GET', '/');
  assert.strictEqual(page.status, 200);

  // Writes without the PIN are rejected.
  const noPin = await request(port, 'POST', '/api/keepawake', { keepAwake: true });
  assert.strictEqual(noPin.status, 403);
  assert.strictEqual(calls.keep, undefined);

  // Writes with the wrong PIN are rejected.
  const badPin = await request(port, 'POST', '/api/keepawake', { keepAwake: true, pin: '0000' });
  assert.strictEqual(badPin.status, 403);

  // Correct PIN (via body) applies.
  const okBody = await request(port, 'POST', '/api/keepawake', { keepAwake: true, pin: '1234' });
  assert.strictEqual(okBody.status, 200);
  assert.strictEqual(calls.keep, true);

  // Correct PIN (via header) applies too, for bootonstart.
  const okHdr = await request(port, 'POST', '/api/bootonstart', { bootOnStart: true }, { 'x-sendspin-pin': '1234' });
  assert.strictEqual(okHdr.status, 200);
  assert.strictEqual(calls.boot, true);

  // /api/config still requires a server even with a valid PIN.
  const noServer = await request(port, 'POST', '/api/config', { pin: '1234' });
  assert.strictEqual(noServer.status, 400);

  const cfg = await request(port, 'POST', '/api/config', { pin: '1234', server: '1.2.3.4', keepAwake: false, bootOnStart: true });
  assert.strictEqual(cfg.status, 200);
  assert.strictEqual(calls.config.server, '1.2.3.4');
  assert.strictEqual(calls.config.bootOnStart, true);

  server.close();
});

test('config-http leaves writes open when no PIN is set', async () => {
  const calls = {};
  const server = await startServer({
    snapshot: () => ({ status: 'idle' }),
    discover: (cb) => cb(null, []),
    applyConfig: (p) => p,
    setKeepAwake: (v) => { calls.keep = v; return v; },
    setBootOnStart: (v) => v,
    getPin: () => null
  });
  const port = server.address().port;
  const res = await request(port, 'POST', '/api/keepawake', { keepAwake: true });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(calls.keep, true);
  server.close();
});
