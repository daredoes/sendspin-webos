/*
 * config-http.js — a tiny LAN configuration web server (the "LG Input Hook" pattern).
 *
 * The TV's node service runs this on 0.0.0.0:<port> (verified reachable from another
 * computer on the LAN). Browse to http://<tv-ip>:<port> from any phone/laptop and
 * configure the player with a real keyboard instead of the TV remote. It also
 * exposes mDNS discovery so you can pick a Music Assistant server without typing an
 * IP.
 *
 * Dependency-free (node http). node 8.12 compatible.
 *
 * start(port, handlers) where handlers = {
 *   snapshot:   function() -> state object,
 *   discover:   function(cb(err, servers)),
 *   applyConfig:function({server, username, password, playerName}) -> state object
 * }
 * Returns the http.Server (or null if it could not bind).
 */
var http = require('http');

function send(res, code, obj) {
  var body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req, cb) {
  var data = '';
  req.on('data', function (c) { data += c; if (data.length > 1e6) { req.destroy(); } });
  req.on('end', function () { var j = null; try { j = JSON.parse(data || '{}'); } catch (e) {} cb(j); });
}

function start(port, handlers) {
  var server = http.createServer(function (req, res) {
    var url = req.url.split('?')[0];

    if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(PAGE);
      return;
    }
    if (req.method === 'GET' && url === '/api/status') {
      send(res, 200, { state: handlers.snapshot() });
      return;
    }
    if (req.method === 'GET' && url === '/api/discover') {
      handlers.discover(function (err, servers) {
        send(res, 200, { servers: servers || [], error: err ? String(err.message || err) : null });
      });
      return;
    }
    if (req.method === 'POST' && url === '/api/config') {
      readBody(req, function (body) {
        if (!body || !body.server) { send(res, 400, { error: 'server is required' }); return; }
        var state = handlers.applyConfig({
          server: body.server,
          username: body.username || '',
          password: body.password || '',
          playerName: body.playerName || ''
        });
        send(res, 200, { state: state });
      });
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });

  server.on('error', function (e) {
    console.error('Sendspin config-http: listen failed', e && e.message);
  });
  try {
    server.listen(port, '0.0.0.0', function () {
      console.log('Sendspin config-http: listening on 0.0.0.0:' + port);
    });
  } catch (e) {
    console.error('Sendspin config-http: start threw', e && e.message);
    return null;
  }
  return server;
}

/* Self-contained config page. No external assets so it works offline on any LAN
 * device. Talks to the /api/* endpoints above. */
var PAGE = '<!DOCTYPE html>\n' +
'<html lang="en"><head><meta charset="utf-8">' +
'<meta name="viewport" content="width=device-width, initial-scale=1">' +
'<title>Sendspin Cinema setup</title><style>' +
'*{box-sizing:border-box}body{margin:0;font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#0b0d12;color:#eef;display:flex;justify-content:center}' +
'.wrap{width:100%;max-width:560px;padding:28px 20px 60px}h1{font-size:1.5rem;margin:0 0 4px}' +
'.sub{color:#8b93a7;margin:0 0 22px;font-size:.95rem}label{display:block;font-size:.82rem;text-transform:uppercase;letter-spacing:.06em;color:#8b93a7;margin:16px 0 6px}' +
'input{width:100%;padding:13px 14px;font-size:1.05rem;border:1px solid #29303f;border-radius:10px;background:#141823;color:#fff;outline:none}' +
'input:focus{border-color:#3b82f6}.row{display:flex;gap:12px}.row .host{flex:3}.row .port{flex:1}' +
'button{font:inherit;cursor:pointer;border:none;border-radius:10px;padding:14px;font-size:1rem}' +
'.primary{width:100%;margin-top:24px;background:#3b82f6;color:#fff;font-weight:600}.primary:active{background:#2f6ad9}' +
'.scan{margin-top:8px;background:#1c2230;color:#cdd6f4;width:100%;border:1px solid #29303f}' +
'#servers{margin-top:10px;display:flex;flex-direction:column;gap:8px}.srv{padding:12px 14px;background:#141823;border:1px solid #29303f;border-radius:10px;cursor:pointer}' +
'.srv:active{border-color:#3b82f6}.srv b{display:block}.srv span{color:#8b93a7;font-size:.85rem}' +
'#msg{margin-top:18px;min-height:1.2em;font-size:.95rem}.ok{color:#34d399}.err{color:#f87171}' +
'.pill{display:inline-block;padding:4px 10px;border-radius:20px;font-size:.8rem;background:#1c2230;color:#8b93a7;margin-bottom:18px}' +
'</style></head><body><div class="wrap">' +
'<h1>Sendspin Cinema</h1><p class="sub">Configure this TV player from your computer.</p>' +
'<div class="pill" id="conn">…</div>' +
'<button class="scan" id="scanBtn" type="button">Scan for Music Assistant servers</button>' +
'<div id="servers"></div>' +
'<label>Server URL or IP</label><div class="row">' +
'<input class="host" id="host" placeholder="192.168.1.20 or http://mass.local" autocapitalize="off" autocomplete="off">' +
'<input class="port" id="port" placeholder="8095" inputmode="numeric"></div>' +
'<label>Username (optional)</label><input id="user" autocapitalize="off" autocomplete="username">' +
'<label>Password (optional)</label><input id="pass" type="password" autocomplete="current-password">' +
'<label>Player name</label><input id="name" placeholder="Cinema TV">' +
'<button class="primary" id="saveBtn" type="button">Save &amp; Connect</button>' +
'<div id="msg"></div></div><script>' +
'function $(i){return document.getElementById(i)}' +
'function setMsg(t,c){var m=$("msg");m.textContent=t;m.className=c||""}' +
'function refresh(){fetch("/api/status").then(function(r){return r.json()}).then(function(d){var s=d.state||{};' +
'$("conn").textContent=(s.connected?"Connected":(s.status||"idle"))+(s.error?(" — "+s.error):"");' +
'if(s.server&&!$("host").value)$("host").value=s.server;if(s.username&&!$("user").value)$("user").value=s.username;' +
'if(s.playerName&&!$("name").value)$("name").value=s.playerName}).catch(function(){})}' +
'$("scanBtn").onclick=function(){setMsg("Scanning…");$("scanBtn").disabled=true;' +
'fetch("/api/discover").then(function(r){return r.json()}).then(function(d){$("scanBtn").disabled=false;' +
'var box=$("servers");box.innerHTML="";var list=d.servers||[];if(!list.length){setMsg("No servers found. Enter the address manually.","err");return}' +
'setMsg(list.length+" found");list.forEach(function(sv){var el=document.createElement("div");el.className="srv";' +
'el.innerHTML="<b>"+(sv.name||"Music Assistant")+"</b><span>"+(sv.url||"")+(sv.version?(" · v"+sv.version):"")+"</span>";' +
'el.onclick=function(){try{var u=new URL(sv.url);$("host").value=u.protocol+"//"+u.hostname;$("port").value=u.port||"";}catch(e){$("host").value=sv.url}' +
'setMsg("Selected "+(sv.name||sv.url),"ok")};box.appendChild(el)})}).catch(function(e){$("scanBtn").disabled=false;setMsg("Scan failed: "+e,"err")})};' +
'$("saveBtn").onclick=function(){var host=$("host").value.trim();if(!host){setMsg("Enter a server URL or IP","err");return}' +
'var server=host;var port=$("port").value.trim();if(port&&!/:[0-9]+($|\\/)/.test(host.replace(/^\\w+:\\/\\//,"")))server=host.replace(/\\/+$/,"")+":"+port;' +
'setMsg("Saving…");fetch("/api/config",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({' +
'server:server,username:$("user").value.trim(),password:$("pass").value,playerName:$("name").value.trim()||"Cinema TV"})})' +
'.then(function(r){return r.json()}).then(function(d){if(d.error){setMsg("Error: "+d.error,"err");return}' +
'setMsg("Saved. Connecting to Music Assistant…","ok");setTimeout(refresh,1500)}).catch(function(e){setMsg("Save failed: "+e,"err")})};' +
'refresh();setInterval(refresh,4000);</script></body></html>';

module.exports = { start: start };
