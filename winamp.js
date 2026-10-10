// Winamp view: Webamp renders the Winamp 2 windows, but the Sendspin service owns the
// audio. Webamp is display-only here: RemoteMedia stands in for its audio engine and
// never sends commands, the transport buttons are intercepted before Webamp sees them
// and go to the service, and the service's status drives the track, clock and
// play/pause state.
(function () {
    var SERVICE = 'luna://com.sendspin.webos.service/';
    var Bridge = window.PalmServiceBridge || window.webOSServiceBridge || null;

    function lunaCall(method, params, onResult) {
        if (!Bridge) { return null; }
        try {
            var bridge = new Bridge();
            bridge.onservicecallback = function (raw) {
                var res; try { res = JSON.parse(raw); } catch (e) { res = null; }
                if (onResult && res) { onResult(res); }
            };
            bridge.call(SERVICE + method, JSON.stringify(params || {}));
            return bridge;
        } catch (e) { return null; }
    }

    // Opened by the service in place of the TV screensaver: any non-media input closes the
    // app and returns to whatever was on screen, as a screensaver would.
    var screensaver = /[?&]screensaver=1/.test(location.search);
    function closeScreensaver() { window.close(); }
    document.addEventListener('webOSRelaunch', function (e) {
        if (e && e.detail && e.detail.screensaver) { screensaver = true; document.getElementById('hint').style.display = 'none'; }
    });

    var status = { track: {} };
    var posMs = 0, posWall = 0, playing = false, lastKey = null, trackId = 0;

    function durationMs() { return (status.track && status.track.duration) || 0; }
    function elapsedMs() {
        var ms = posMs + (playing ? Date.now() - posWall : 0);
        var d = durationMs();
        return Math.max(0, d ? Math.min(d, ms) : ms);
    }

    var media = null;
    function RemoteMedia() { this._handlers = {}; this._analyser = null; media = this; }
    var proto = RemoteMedia.prototype;
    proto.on = function (ev, cb) { (this._handlers[ev] = this._handlers[ev] || []).push(cb); };
    proto._emit = function (ev) { (this._handlers[ev] || []).forEach(function (cb) { cb(); }); };
    proto.timeElapsed = function () { return elapsedMs() / 1000; };
    proto.duration = function () { return durationMs() / 1000; };
    proto.timeRemaining = function () { return Math.max(0, this.duration() - this.timeElapsed()); };
    proto.percentComplete = function () { var d = this.duration(); return d ? 100 * this.timeElapsed() / d : 0; };
    proto.play = function () { return Promise.resolve(); };
    proto.loadFromUrl = function () {
        var self = this;
        setTimeout(function () { self._emit('fileLoaded'); }, 0);
        return Promise.resolve();
    };
    // Volume, seek and EQ belong to Music Assistant; those Winamp controls are display-only.
    ['pause', 'stop', 'setVolume', 'setBalance', 'setPreamp', 'seekToPercentComplete', 'seekToTime',
     'setEqBand', 'disableEq', 'enableEq', 'dispose'].forEach(function (n) { proto[n] = function () {}; });
    proto.getAnalyser = function () {
        if (!this._analyser) {
            var Ctx = window.AudioContext || window.webkitAudioContext;
            this._analyser = new Ctx().createAnalyser();
        }
        return this._analyser;
    };

    var webamp = new window.Webamp({
        __customMediaClass: RemoteMedia,
        enableDoubleSizeMode: true,
        initialTracks: [],
        zIndex: 10
    });

    // Show the service's play state without running Webamp's own transport logic.
    function applyPlayState() {
        if (status.status === 'playing') { if (media) { media._emit('playing'); } }
        else if (status.status === 'paused') { webamp.store.dispatch({ type: 'PAUSE' }); }
        else { webamp.store.dispatch({ type: 'STOP' }); }
    }

    function showTrack() {
        var t = status.track || {};
        trackId++;
        webamp.setTracksToPlay([{
            url: 'sendspin:track:' + trackId,
            duration: durationMs() / 1000,
            metaData: { title: t.title || 'Nothing playing', artist: t.artist || status.playerName || '', album: t.album || '' }
        }]);
        setTimeout(applyPlayState, 0);   // after Webamp's own load settles
    }

    function onStatus(st) {
        var t = st.track || {};
        var wasStatus = status.status;
        status = st;
        posMs = t.position || 0;
        posWall = Date.now();
        playing = st.status === 'playing';
        document.getElementById('art').style.backgroundImage = t.artwork ? "url('" + t.artwork + "')" : '';
        var key = [t.title, t.artist, t.album, t.duration].join('|');
        if (key !== lastKey) { lastKey = key; showTrack(); }
        else if (wasStatus !== st.status) { applyPlayState(); }
    }

    // Winamp's transport buttons go to the service. Capturing on window runs before
    // Webamp's own handlers, so Webamp never acts on these clicks itself.
    var BUTTONS = { previous: 'previous', play: 'play', pause: 'pause', stop: 'stop', next: 'next' };
    function onTransport(e) {
        var el = e.target && e.target.closest && e.target.closest('#previous, #play, #pause, #stop, #next');
        if (!el || !el.closest('#main-window')) { return; }
        e.stopPropagation();
        e.preventDefault();
        if (e.type === 'click' && !screensaver) {
            var cmd = BUTTONS[el.id];
            if (cmd === 'pause' && !playing) { cmd = 'play'; }   // Winamp's pause button resumes when paused
            lunaCall(cmd);
        }
    }
    ['mousedown', 'mouseup', 'click'].forEach(function (t) { window.addEventListener(t, onTransport, true); });
    window.addEventListener('mousedown', function () { if (screensaver) { closeScreensaver(); } }, true);

    function toCinema() {
        try { localStorage.setItem('sendspin_ui', 'cinema'); } catch (e) {}
        location.href = 'index.html';
    }

    webamp.onClose(toCinema);
    setInterval(function () { if (media) { media._emit('timeupdate'); } }, 500);

    window.addEventListener('keydown', function (e) {
        var k = e.key, kc = e.keyCode;
        var cmd = null;
        if (k === 'Backspace' || k === 'Escape' || k === 'GoBack' || kc === 461 || kc === 27) { e.preventDefault(); if (screensaver) { closeScreensaver(); } else { toCinema(); } return; }
        if (k === 'ArrowLeft' || k === 'MediaTrackPrevious' || k === 'MediaRewind' || kc === 37 || kc === 412 || kc === 424) { cmd = 'previous'; }
        else if (k === 'ArrowRight' || k === 'MediaTrackNext' || k === 'MediaFastForward' || kc === 39 || kc === 417 || kc === 425) { cmd = 'next'; }
        else if (k === 'Enter' || k === 'MediaPlayPause' || kc === 13 || kc === 463 || kc === 179) { cmd = playing ? 'pause' : 'play'; }
        else if (k === 'MediaPlay' || kc === 415) { cmd = 'play'; }
        else if (k === 'MediaPause' || kc === 19) { cmd = 'pause'; }
        else if (k === 'MediaStop' || kc === 413) { cmd = 'stop'; }
        var mediaKey = /^Media/.test(k) || [415, 19, 463, 179, 413, 412, 424, 417, 425].indexOf(kc) !== -1;
        if (screensaver && !mediaKey) { e.preventDefault(); closeScreensaver(); return; }
        if (cmd) { e.preventDefault(); lunaCall(cmd); }
    });

    if (screensaver) { document.getElementById('hint').style.display = 'none'; }
    else { try { localStorage.setItem('sendspin_ui', 'winamp'); } catch (e) {} }
    webamp.renderWhenReady(document.getElementById('app')).then(function () {
        window.__statusBridge = lunaCall('status', { subscribe: true }, function (res) {
            if (res.state) { onStatus(res.state); }
        });
    });
})();
