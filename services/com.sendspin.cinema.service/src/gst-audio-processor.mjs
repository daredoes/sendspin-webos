/*
 * GstAudioProcessor — headless replacement for the browser Web-Audio
 * `AudioProcessor` in sendspin-lib.js.
 *
 * The browser version decodes Opus/FLAC/PCM with WebCodecs/WASM and schedules
 * sample-accurate playback through an AudioContext for multi-device sync. None
 * of that runs in a headless webOS node-8 service, and it isn't needed: on this
 * TV gstreamer decodes FLAC/PCM to pulsesink, which mixes with live HDMI for
 * free (Phase 1 + Phase 2, proven on hardware). So this class throws away the
 * decode/schedule engine and instead forwards each chunk's *encoded* payload to
 * an injected sink, letting gstreamer + pulsesink own decode, clocking and mix.
 *
 * It implements the exact method surface ProtocolHandler and SendspinPlayer call
 * on `audioProcessor`, so the unmodified protocol/time-sync/state logic upstream
 * keeps working. Time sync still runs (the server gets client/time replies); we
 * just don't use the filtered clock to schedule — gstreamer's own clock does,
 * which is fine for a single player. Multi-device drift correction is out of
 * scope for the MVP (documented in docs/PROGRESS.md).
 *
 * The sink is injected via `config.createSink(format)` so this module stays free
 * of child_process / gstreamer specifics (service.js owns those).
 */
export class GstAudioProcessor {
    constructor(stateManager, timeFilter, config) {
        this.stateManager = stateManager;
        this.timeFilter = timeFilter;
        this.config = config || {};
        this.createSink = this.config.createSink || null;
        this.sink = null;
        this.syncDelayMs = this.config.syncDelay || 0;
        this.correctionMode = this.config.correctionMode || "sync";
    }

    // Called from handleStreamStart once stateManager.currentStreamFormat is set.
    // (Re)create the sink when the negotiated codec/sample-rate changes.
    initAudioContext() {
        const format = this.stateManager.currentStreamFormat;
        if (!format || !this.createSink) {
            return;
        }
        if (this.sink &&
            this.sink.codec === format.codec &&
            this.sink.sampleRate === format.sample_rate) {
            return; // format unchanged — keep the running sink (format-update case)
        }
        if (this.sink) {
            this.sink.stop();
            this.sink = null;
        }
        this.sink = this.createSink(format);
    }

    // No-ops: there is no AudioContext to resume and no <audio> element to drive.
    resumeAudioContext() { }
    startAudioElement() { }
    stopAudioElement() { }

    // Seek / new stream: tear the sink down so the next chunk rebuilds it clean.
    clearBuffers() {
        if (this.sink) {
            this.sink.stop();
            this.sink = null;
        }
    }

    // Binary audio chunk per spec: byte0 identifies role/slot (4 = player audio),
    // bytes 1..8 = server timestamp µs (BE int64, unused here), rest = encoded payload.
    handleBinaryMessage(data) {
        const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
        if (bytes.length < 9 || bytes[0] !== 4) {
            return;
        }
        if (!this.sink) {
            this.initAudioContext();
        }
        if (this.sink) {
            // Forward the encoded payload (FLAC/PCM frames) straight to gstreamer.
            this.sink.write(Buffer.from(bytes.buffer, bytes.byteOffset + 9, bytes.length - 9));
        }
    }

    // Volume/mute are applied downstream (pulsesink / pactl) — MVP no-op so the
    // server's volume commands are accepted without error. TODO: pactl set-sink-input-volume.
    updateVolume() { }

    setSyncDelay(delayMs) {
        const d = Math.round(delayMs);
        this.syncDelayMs = Math.max(0, Math.min(5000, isFinite(d) ? d : 0));
    }
    getSyncDelayMs() { return this.syncDelayMs; }

    setCorrectionMode(mode) { this.correctionMode = mode; }

    get syncInfo() {
        return {
            mode: this.correctionMode,
            synced: this.timeFilter ? this.timeFilter.is_synchronized : false,
            sinkActive: !!this.sink
        };
    }

    close() {
        if (this.sink) {
            this.sink.stop();
            this.sink = null;
        }
    }
}
