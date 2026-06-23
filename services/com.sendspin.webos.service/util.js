/*
 * util.js — pure, dependency-free helpers shared by the service. Kept separate
 * from service.js (which require()s the TV-only `webos-service` module) so these
 * can be unit-tested on plain node in CI with no TV. node 8.12 compatible.
 */
'use strict';

var MA_SENDSPIN_PORT = 8095; // Music Assistant webserver port (serves /ws + /sendspin)

// Clamp a volume to 0..100; returns null for non-numeric input.
function clampVol(v) {
  var n = parseInt(v, 10);
  if (isNaN(n)) { return null; }
  return Math.max(0, Math.min(100, n));
}

// Normalize a configured server into a base http(s) URL.
// Accepts "1.2.3.4", "1.2.3.4:8927", "http://host", "ws://host:port".
function buildBaseUrl(server, defaultPort) {
  var raw = server.indexOf('://') >= 0 ? server : 'http://' + server;
  var u = new URL(raw);
  var proto = (u.protocol === 'https:' || u.protocol === 'wss:') ? 'https:' : 'http:';
  var port = u.port || String(defaultPort || MA_SENDSPIN_PORT);
  return proto + '//' + u.hostname + ':' + port;
}

// Combine host + optional port into the "server" string the service parses.
// Mirrors the app-side buildServer so both ends agree on the format.
function buildServer(host, port) {
  host = (host || '').trim().replace(/\/+$/, '');
  if (!host) { return ''; }
  if (port !== undefined && port !== null && String(port).trim()) {
    var bare = host.replace(/^\w+:\/\//, '');
    var hasPort = /:\d+($|\/)/.test(bare);
    if (!hasPort) { host = host + ':' + String(port).trim(); }
  }
  return host;
}

// A 4-digit PIN as a zero-padded string ("0123").
function makePin() {
  return ('000' + Math.floor(Math.random() * 10000)).slice(-4);
}

module.exports = {
  MA_SENDSPIN_PORT: MA_SENDSPIN_PORT,
  clampVol: clampVol,
  buildBaseUrl: buildBaseUrl,
  buildServer: buildServer,
  makePin: makePin
};
