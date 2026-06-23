/*
 * node-env.js — install the browser globals sendspin-core.js expects, so the
 * extracted (browser-origin) protocol stack runs unchanged under webOS node 8.
 *
 * Must be require()'d BEFORE sendspin-core.js. Covers exactly what the keeper
 * code touches:
 *   - WebSocket            (WebSocketManager) -> bundled pure-JS `ws`
 *   - performance.now()    (time sync, µs clock) -> perf_hooks
 *   - URL                  (SendspinPlayer.connect builds the ws URL) -> url
 *   - window.{set,clear}{Timeout,Interval} (timers) -> alias global
 * navigator/document/localStorage/AudioDecoder are only reached behind
 * `typeof x !== "undefined"` guards, so leaving them undefined is correct and
 * yields the right codec set (PCM+FLAC, no Opus) for this device.
 */
var perf = require("perf_hooks").performance;
var URLctor = require("url").URL;
var WS = require("ws");

if (typeof global.performance === "undefined") {
    global.performance = perf;
}
if (typeof global.URL === "undefined") {
    global.URL = URLctor;
}
if (typeof global.WebSocket === "undefined") {
    global.WebSocket = WS;
}
if (typeof global.window === "undefined") {
    // The code only uses window.setTimeout/setInterval/clearTimeout/clearInterval,
    // all of which exist on the node global object.
    global.window = global;
}
