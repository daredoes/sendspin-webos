/*
 * persist.js — store the player config on a path that survives an app reinstall.
 *
 * The app's localStorage and the service's in-memory state are both wiped when the
 * IPK is reinstalled (the install replaces the app/service dirs). Writing the config
 * to a file OUTSIDE the install tree — on the persistent dev partition — keeps it
 * across reinstalls AND reboots, and lets the service reconnect on its own at
 * startup (before the app is even opened).
 *
 * Candidate paths in preference order; the first writable one is used. (The app
 * installs under /media/developer/apps/..., so a file directly in /media/developer
 * is untouched by reinstall.) node 8.12 compatible.
 *
 * NOTE: the password is stored in plaintext (homebrew / trusted LAN). Documented.
 */
var fs = require('fs');

// Reboot-persistent paths first; /tmp (tmpfs) is the last-resort fallback (survives
// a reinstall but not a power cycle). The managed service runs jailed, so several of
// these may not be writable from inside it — the first that is wins.
var CANDIDATES = [
  '/media/internal/sendspin-cinema.json',
  '/media/developer/sendspin-cinema.json',
  '/cryptofs/sendspin-cinema.json',
  '/var/luna/preferences/sendspin-cinema.json',
  '/home/root/.sendspin-cinema.json',
  '/tmp/sendspin-cinema.json'
];

var chosen = null;          // path we settled on (read or write), reused for later saves
var lastProbe = [];         // diagnostics: which candidates were writable at save time

function writable(p) {
  try { fs.writeFileSync(p + '.wtest', 'x'); fs.unlinkSync(p + '.wtest'); return true; }
  catch (e) { return false; }
}

// Read the first candidate that holds valid JSON; returns the object or null.
function load() {
  for (var i = 0; i < CANDIDATES.length; i++) {
    try {
      var obj = JSON.parse(fs.readFileSync(CANDIDATES[i], 'utf8'));
      chosen = CANDIDATES[i];
      return obj;
    } catch (e) { /* missing or bad — try next */ }
  }
  return null;
}

// Persist the config object to the first writable candidate (reusing the loaded
// path if we have one). Returns true on success.
function save(obj) {
  lastProbe = [];
  var p = (chosen && writable(chosen)) ? chosen : null;
  for (var i = 0; i < CANDIDATES.length; i++) {
    var w = writable(CANDIDATES[i]);
    lastProbe.push(CANDIDATES[i] + (w ? ' [ok]' : ' [no]'));
    if (!p && w) { p = CANDIDATES[i]; }
  }
  if (!p) { return false; }
  try { fs.writeFileSync(p, JSON.stringify(obj)); chosen = p; return true; }
  catch (e) { return false; }
}

module.exports = {
  load: load,
  save: save,
  path: function () { return chosen; },
  probe: function () { return lastProbe; }
};
