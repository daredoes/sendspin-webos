/*
 * ma-login.js — exchange Music Assistant username/password for a short-lived
 * access token via the main API WebSocket (ws://host/ws, command "auth/login").
 *
 * MA's Sendspin proxy requires that token in the {type:auth,token} frame before
 * the player protocol starts. node 8.12 compatible. Uses the bundled `ws`.
 */
var WS = require('ws');

// hostPort: "<host>:<port>" e.g. "ma.local:8095" (no scheme). cb(err, accessToken).
function getToken(hostPort, username, password, cb) {
  var done = false;
  var api;
  function finish(err, token) {
    if (done) { return; }
    done = true;
    try { api.close(); } catch (e) {}
    cb(err, token);
  }
  try {
    api = new WS('ws://' + hostPort + '/ws');
  } catch (e) {
    return cb(e);
  }
  var sentLogin = false;
  api.on('message', function (d) {
    var m;
    try { m = JSON.parse(d.toString()); } catch (e) { return; }
    // MA sends a ServerInfoMessage on connect; reply with the login command.
    if (m.server_id && !sentLogin) {
      sentLogin = true;
      api.send(JSON.stringify({
        command: 'auth/login',
        message_id: 'sendspin-login',
        args: { username: username, password: password, device_name: 'Sendspin Cinema (webOS)' }
      }));
      return;
    }
    if (m.message_id === 'sendspin-login') {
      if (m.result && m.result.success && m.result.access_token) {
        finish(null, m.result.access_token);
      } else {
        finish(new Error((m.result && m.result.error) || 'login failed'));
      }
    }
  });
  api.on('error', function (e) { finish(e); });
  setTimeout(function () { finish(new Error('login timeout')); }, 10000);
}

module.exports = { getToken: getToken };
