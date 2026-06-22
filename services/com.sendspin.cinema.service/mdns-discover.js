/*
 * mdns-discover.js — find Music Assistant servers on the LAN via mDNS, with no
 * dependencies (raw dgram). MA advertises `_mass._tcp.local` and, helpfully, puts
 * a ready-to-use `base_url=http://<ip>:<port>` in its TXT record (verified on the
 * LAN: server_version=2.8.3, base_url=http://192.168.1.221:8095), so a scan can
 * hand the UI a server URL with zero typing.
 *
 * node 8.12 compatible (var/function, no arrow/optional-chaining). Proven on the
 * TV: a multicast query to 224.0.0.251:5353 gets replies from the MA server.
 */
var dgram = require('dgram');

var MDNS_ADDR = '224.0.0.251';
var MDNS_PORT = 5353;
var SERVICE = '_mass._tcp.local';

// Build a DNS query packet (one question, type PTR=12, class IN=1).
function buildQuery(name, type) {
  var bytes = [0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]; // id=0, flags=0, qd=1
  name.split('.').forEach(function (label) {
    bytes.push(label.length);
    for (var i = 0; i < label.length; i++) { bytes.push(label.charCodeAt(i)); }
  });
  bytes.push(0);                // root label
  bytes.push((type >> 8) & 0xff, type & 0xff);
  bytes.push(0, 1);             // class IN
  return Buffer.from(bytes);
}

// Read a DNS name starting at `off`, following compression pointers. Returns the
// dotted name and the offset of the byte after the name in the *original* stream.
function readName(buf, off) {
  var labels = [];
  var jumped = false;
  var next = off;
  var safety = 0;
  while (safety++ < 128) {
    if (off >= buf.length) { break; }
    var len = buf[off];
    if (len === 0) { if (!jumped) { next = off + 1; } break; }
    if ((len & 0xc0) === 0xc0) {
      if (!jumped) { next = off + 2; }
      off = ((len & 0x3f) << 8) | buf[off + 1];
      jumped = true;
      continue;
    }
    off++;
    labels.push(buf.toString('latin1', off, off + len));
    off += len;
  }
  return { name: labels.join('.'), next: next };
}

// Parse a DNS message into a flat list of resource records (TXT/SRV/A/PTR decoded).
function parseMessage(buf) {
  if (buf.length < 12) { return []; }
  var qd = buf.readUInt16BE(4);
  var total = buf.readUInt16BE(6) + buf.readUInt16BE(8) + buf.readUInt16BE(10);
  var off = 12;
  var i, r;
  for (i = 0; i < qd; i++) { r = readName(buf, off); off = r.next + 4; }
  var recs = [];
  for (i = 0; i < total && off + 10 <= buf.length; i++) {
    r = readName(buf, off); off = r.next;
    var type = buf.readUInt16BE(off);
    var rdlen = buf.readUInt16BE(off + 8);
    var rd = off + 10;
    var rec = { name: r.name, type: type };
    if (type === 16) {                       // TXT
      var txt = [], p = rd, end = rd + rdlen;
      while (p < end) { var l = buf[p++]; txt.push(buf.toString('latin1', p, p + l)); p += l; }
      rec.txt = txt;
    } else if (type === 33) {                // SRV
      rec.port = buf.readUInt16BE(rd + 4);
      rec.target = readName(buf, rd + 6).name;
    } else if (type === 1) {                 // A
      rec.ip = buf[rd] + '.' + buf[rd + 1] + '.' + buf[rd + 2] + '.' + buf[rd + 3];
    }
    off = rd + rdlen;
    recs.push(rec);
  }
  return recs;
}

// discover(timeoutMs, cb): cb(err, [{ name, url, server_id, version }]).
function discover(timeoutMs, cb) {
  var sock, done = false;
  var byKey = {};
  var aByHost = {};   // host -> ip, srvByHost: host -> port, for base_url fallback

  function finish(err) {
    if (done) { return; }
    done = true;
    try { sock.close(); } catch (e) {}
    if (err) { return cb(err, []); }
    var out = [];
    for (var k in byKey) { if (byKey[k].url) { out.push(byKey[k]); } }
    cb(null, out);
  }

  try {
    sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  } catch (e) { return cb(e, []); }

  sock.on('error', function (e) { finish(e); });
  sock.on('message', function (msg) {
    var recs;
    try { recs = parseMessage(msg); } catch (e) { return; }
    for (var i = 0; i < recs.length; i++) {
      var rec = recs[i];
      if (rec.type === 1) { aByHost[rec.name] = rec.ip; }
      if (rec.type === 16 && rec.name.indexOf('_mass._tcp') !== -1) {
        var info = {};
        (rec.txt || []).forEach(function (kv) {
          var idx = kv.indexOf('=');
          if (idx > 0) { info[kv.slice(0, idx)] = kv.slice(idx + 1); }
        });
        var key = info.server_id || rec.name;
        byKey[key] = {
          name: (info.name && info.name.trim()) ? info.name : 'Music Assistant',
          url: info.base_url || null,
          server_id: info.server_id || null,
          version: info.server_version || null
        };
      }
    }
  });

  sock.bind(MDNS_PORT, function () {
    try { sock.addMembership(MDNS_ADDR); } catch (e) {}
    try { sock.send(buildQuery(SERVICE, 12), MDNS_PORT, MDNS_ADDR); } catch (e) {}
  });

  setTimeout(function () { finish(null); }, timeoutMs || 3000);
}

module.exports = { discover: discover, parseMessage: parseMessage, buildQuery: buildQuery };
