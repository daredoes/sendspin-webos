function _mergeNamespaces(n, m) {
    m.forEach(function (e) {
        e && typeof e !== 'string' && !Array.isArray(e) && Object.keys(e).forEach(function (k) {
            if (k !== 'default' && !(k in n)) {
                var d = Object.getOwnPropertyDescriptor(e, k);
                Object.defineProperty(n, k, d.get ? d : {
                    enumerable: true,
                    get: function () { return e[k]; }
                });
            }
        });
    });
    return Object.freeze(n);
}

// Sync correction constants
const SAMPLE_CORRECTION_FADE_LEN = 8; // samples to blend around correction points
// Blend budget across the whole fade window.
// We derive per-sample strength from fade length so longer fades become gentler.
// 1.0 means the whole fade applies roughly a full-strength blend in total.
const SAMPLE_CORRECTION_TARGET_BLEND_SUM = 1.0;
const SAMPLE_CORRECTION_FADE_STRENGTH = Math.min(1, (2 * SAMPLE_CORRECTION_TARGET_BLEND_SUM) / SAMPLE_CORRECTION_FADE_LEN);
const SAMPLE_CORRECTION_FADE_ALPHAS = new Float32Array(SAMPLE_CORRECTION_FADE_LEN);
for (let f = 0; f < SAMPLE_CORRECTION_FADE_LEN; f++) {
    SAMPLE_CORRECTION_FADE_ALPHAS[f] =
        ((SAMPLE_CORRECTION_FADE_LEN - f) / (SAMPLE_CORRECTION_FADE_LEN + 1)) *
            SAMPLE_CORRECTION_FADE_STRENGTH;
}
const OUTPUT_LATENCY_ALPHA = 0.01; // EMA smoothing factor for outputLatency
const SYNC_ERROR_ALPHA = 0.1; // EMA smoothing factor for sync error (filters jitter)
const OUTPUT_LATENCY_STORAGE_KEY = "sendspin-output-latency-us"; // LocalStorage key
const OUTPUT_LATENCY_PERSIST_INTERVAL_MS = 10000;
const RECORRECTION_CHECK_INTERVAL_MS = 250;
const RECORRECTION_TRIGGER_MS = 30;
const RECORRECTION_SUSTAIN_MS = 400;
const RECORRECTION_COOLDOWN_MS = 1500;
const RECORRECTION_CUTOVER_GUARD_SEC = 0.3;
const RECORRECTION_TRANSIENT_JUMP_MS = 25;
const RECORRECTION_TRANSIENT_CONFIRM_WINDOW_MS = RECORRECTION_CHECK_INTERVAL_MS * 4;
const HARD_RESYNC_STARTUP_GRACE_MS = 1000;
const HARD_RESYNC_COOLDOWN_MS = 500;
const SCHEDULE_HEADROOM_SEC = 0.2;
const SCHEDULE_HORIZON_PRECISE_SEC = 20;
const SCHEDULE_HORIZON_GOOD_SEC = 8;
const SCHEDULE_HORIZON_POOR_SEC = 4;
const SCHEDULE_HORIZON_PRECISE_ERROR_MS = 2;
const SCHEDULE_HORIZON_GOOD_ERROR_MS = 8;
const OUTPUT_TIMESTAMP_MAX_FRESHNESS_MS = 250;
const OUTPUT_TIMESTAMP_MIN_SAMPLE_INTERVAL_MS = 40;
const OUTPUT_TIMESTAMP_SLOPE_MIN = 0.95;
const OUTPUT_TIMESTAMP_SLOPE_MAX = 1.05;
const OUTPUT_TIMESTAMP_MAX_DIVERGENCE_SEC = 0.25;
const OUTPUT_TIMESTAMP_MAX_DIVERGENCE_DELTA_SEC = 0.05;
const OUTPUT_TIMESTAMP_MAX_BACKWARD_SEC = 0.005;
const OUTPUT_TIMESTAMP_FUTURE_TOLERANCE_MS = 5;
const OUTPUT_TIMESTAMP_PROMOTION_MIN_GOOD_SAMPLES = 6;
const OUTPUT_TIMESTAMP_PROMOTION_MIN_SPAN_MS = 750;
const OUTPUT_TIMESTAMP_MAX_CONSECUTIVE_BAD_SAMPLES = 2;
// Mode-specific sync correction thresholds
const CORRECTION_THRESHOLDS = {
    sync: {
        resyncAboveMs: 200, // Hard resync for large errors
        rate2AboveMs: 35, // Use 2% rate when error exceeds this
        rate1AboveMs: 8, // Use 1% rate when error exceeds this
        samplesBelowMs: 8, // Use sample insertion/deletion below this
        deadbandBelowMs: 1, // Ignore corrections below this
        enableRecorrectionMonitor: true,
        immediateDelayCutover: true,
    },
    quality: {
        resyncAboveMs: 35, // Tighter resync threshold to avoid drifting too far
        rate2AboveMs: Infinity, // Disabled - never use rate correction
        rate1AboveMs: Infinity, // Disabled - never use rate correction
        samplesBelowMs: 35, // Use sample insertion/deletion below this
        deadbandBelowMs: 1, // Keep deadband tight for accurate sync
        enableRecorrectionMonitor: false,
        immediateDelayCutover: false,
    },
    "quality-local": {
        resyncAboveMs: 600, // Last resort only (prefer keeping uninterrupted playback even if out of sync)
        rate2AboveMs: Infinity, // Disabled - never use rate correction
        rate1AboveMs: Infinity, // Disabled - never use rate correction
        samplesBelowMs: 0, // Disabled - never use sample corrections (prioritize smooth local playback)
        deadbandBelowMs: 5, // Larger deadband to avoid frequent small adjustments
        enableRecorrectionMonitor: false,
        immediateDelayCutover: false,
    },
};
class AudioProcessor {
    constructor(stateManager, timeFilter, outputMode = "direct", audioElement, isAndroid = false, ownsAudioElement = false, silentAudioSrc, syncDelayMs = 0, useHardwareVolume = false, correctionMode = "sync", storage = null, useOutputLatencyCompensation = true) {
        this.stateManager = stateManager;
        this.timeFilter = timeFilter;
        this.outputMode = outputMode;
        this.audioElement = audioElement;
        this.isAndroid = isAndroid;
        this.ownsAudioElement = ownsAudioElement;
        this.silentAudioSrc = silentAudioSrc;
        this.syncDelayMs = syncDelayMs;
        this.useHardwareVolume = useHardwareVolume;
        this.storage = storage;
        this.audioContext = null;
        this.gainNode = null;
        this.streamDestination = null;
        this.audioBufferQueue = [];
        this.scheduledSources = [];
        // Seamless playback tracking
        this.nextPlaybackTime = 0; // AudioContext time when audio should reach the output
        this.nextScheduleTime = 0; // AudioContext time for source.start() (delayed, for Web Audio)
        this.lastScheduledServerTime = 0; // Server timestamp of last scheduled chunk end
        // Sync tracking (for debugging/display)
        this.currentSyncErrorMs = 0;
        this.smoothedSyncErrorMs = 0; // EMA-filtered sync error for corrections
        this.resyncCount = 0;
        this.currentPlaybackRate = 1.0;
        this.currentCorrectionMethod = "none";
        this.lastSamplesAdjusted = 0;
        // Output latency smoothing (EMA to filter Chrome jitter)
        this.lastRawOutputLatencyUs = 0;
        this.smoothedOutputLatencyUs = null;
        this.lastLatencyPersistAtMs = null;
        this.timingEstimateAudioContextTimeSec = null;
        this.timingEstimateAtMs = null;
        // Correction mode
        this._correctionMode = "sync";
        // Periodic status logging
        this._lastStatusLogMs = 0;
        this._lastTimestampRejectReason = null;
        this._intervalResyncCount = 0;
        // Native Opus decoder (uses WebCodecs API)
        this.webCodecsDecoder = null;
        this.webCodecsDecoderReady = null;
        this.webCodecsFormat = null;
        this.useNativeOpus = true; // false when WebCodecs unavailable
        // Fallback Opus decoder (opus-encdec library)
        this.opusDecoder = null;
        this.opusDecoderModule = null;
        this.opusDecoderReady = null;
        this.useOutputLatencyCompensation = true;
        this.nativeDecoderQueue = [];
        this.recorrectionInterval = null;
        this.recorrectionBreachStartedAtMs = null;
        this.lastRecorrectionAtMs = -Infinity;
        this.recorrectionMinScheduleTimeSec = null;
        this.recorrectionPrevRawSyncErrorMs = null;
        this.recorrectionPendingJumpSign = null;
        this.recorrectionPendingJumpAtMs = null;
        this.hardResyncGraceUntilMs = null;
        this.lastHardResyncAtMs = -Infinity;
        this.pendingClockSourceCutover = false;
        this.activeAudioClockSource = "estimated";
        this.outputTimestampLastSample = null;
        this.outputTimestampGoodSamples = 0;
        this.outputTimestampBadSamples = 0;
        this.outputTimestampGoodSinceMs = null;
        this.scheduleTimeout = null;
        this.queueProcessScheduled = false;
        this._correctionMode = correctionMode;
        this.useOutputLatencyCompensation = useOutputLatencyCompensation;
        this.syncDelayMs = this.sanitizeSyncDelayMs(this.syncDelayMs);
        // Load persisted output latency from storage
        this.loadPersistedLatency();
    }
    sanitizeSyncDelayMs(delayMs) {
        if (!isFinite(delayMs)) {
            return 0;
        }
        return Math.max(0, Math.min(5000, Math.round(delayMs)));
    }
    // Load persisted output latency from storage
    loadPersistedLatency() {
        if (!this.storage)
            return;
        try {
            const stored = this.storage.getItem(OUTPUT_LATENCY_STORAGE_KEY);
            if (stored) {
                const latency = parseFloat(stored);
                if (!isNaN(latency) && latency >= 0) {
                    this.smoothedOutputLatencyUs = latency;
                }
            }
        }
        catch {
            // Storage may fail depending on the implementation, ignore errors
        }
    }
    // Persist output latency to storage
    persistLatency() {
        if (!this.storage || this.smoothedOutputLatencyUs === null)
            return;
        try {
            this.storage.setItem(OUTPUT_LATENCY_STORAGE_KEY, this.smoothedOutputLatencyUs.toString());
        }
        catch {
            // Storage may fail depending on the implementation, ignore errors
        }
    }
    // Get current correction mode
    get correctionMode() {
        return this._correctionMode;
    }
    // Set correction mode at runtime
    setCorrectionMode(mode) {
        this._correctionMode = mode;
        if (!this.modeUsesRecorrectionMonitor(mode)) {
            this.stopRecorrectionMonitor();
        }
        else {
            this.startRecorrectionMonitor();
        }
    }
    modeUsesRecorrectionMonitor(mode) {
        return CORRECTION_THRESHOLDS[mode].enableRecorrectionMonitor;
    }
    get usesRecorrectionMonitor() {
        return this.modeUsesRecorrectionMonitor(this._correctionMode);
    }
    get usesImmediateDelayCutover() {
        return CORRECTION_THRESHOLDS[this._correctionMode].immediateDelayCutover;
    }
    getTargetScheduledHorizonSec() {
        const errorMs = this.timeFilter.error / 1000;
        if (errorMs < SCHEDULE_HORIZON_PRECISE_ERROR_MS) {
            return SCHEDULE_HORIZON_PRECISE_SEC;
        }
        if (errorMs <= SCHEDULE_HORIZON_GOOD_ERROR_MS) {
            return SCHEDULE_HORIZON_GOOD_SEC;
        }
        return SCHEDULE_HORIZON_POOR_SEC;
    }
    getScheduledAheadSec(currentTimeSec) {
        let farthestScheduledSec = this.nextScheduleTime;
        for (const entry of this.scheduledSources) {
            if (entry.endTime > farthestScheduledSec) {
                farthestScheduledSec = entry.endTime;
            }
        }
        if (farthestScheduledSec <= 0) {
            return 0;
        }
        return Math.max(0, farthestScheduledSec - currentTimeSec);
    }
    setActiveAudioClockSource(source) {
        if (this.activeAudioClockSource === source) {
            return;
        }
        this.activeAudioClockSource = source;
        this.pendingClockSourceCutover = source === "timestamp";
        if (this.pendingClockSourceCutover &&
            (this.scheduledSources.length > 0 ||
                this.nextPlaybackTime !== 0 ||
                this.lastScheduledServerTime !== 0)) {
            this.scheduleQueueProcessing();
        }
    }
    resetOutputTimestampValidation() {
        this.activeAudioClockSource = "estimated";
        this.pendingClockSourceCutover = false;
        this.outputTimestampLastSample = null;
        this.outputTimestampGoodSamples = 0;
        this._lastTimestampRejectReason = null;
        this.outputTimestampBadSamples = 0;
        this.outputTimestampGoodSinceMs = null;
    }
    demoteOutputTimestampValidation(reason) {
        this.resetOutputTimestampValidation();
        this._lastTimestampRejectReason = reason;
    }
    getEstimatedAudioContextTimeSec(rawTimeSec, nowMs) {
        // Fallback: de-quantize `currentTime` using wall clock and slew toward the raw value.
        // Key goal: avoid discrete ~10/20ms jumps in derived audio time.
        const TIMING_MAX_SLEW_SEC = 0.002; // max correction per snapshot (2ms)
        const TIMING_RESET_THRESHOLD_SEC = 0.5; // snap if mapping is clearly invalid
        const TIMING_MAX_LEAD_SEC = 0.1; // don't run far ahead of raw time
        if (this.timingEstimateAudioContextTimeSec === null) {
            this.timingEstimateAudioContextTimeSec = rawTimeSec;
            this.timingEstimateAtMs = nowMs;
        }
        else if (this.timingEstimateAtMs !== null) {
            const wallDeltaSec = Math.max(0, (nowMs - this.timingEstimateAtMs) / 1000);
            const predicted = this.timingEstimateAudioContextTimeSec + wallDeltaSec;
            this.timingEstimateAtMs = nowMs;
            const errorSec = rawTimeSec - predicted;
            if (Math.abs(errorSec) > TIMING_RESET_THRESHOLD_SEC) {
                this.timingEstimateAudioContextTimeSec = rawTimeSec;
            }
            else {
                const slew = Math.max(-TIMING_MAX_SLEW_SEC, Math.min(TIMING_MAX_SLEW_SEC, errorSec));
                // Keep monotonic and bounded vs raw time.
                const next = Math.max(this.timingEstimateAudioContextTimeSec, predicted + slew);
                this.timingEstimateAudioContextTimeSec = Math.min(next, rawTimeSec + TIMING_MAX_LEAD_SEC);
            }
        }
        return this.timingEstimateAudioContextTimeSec ?? rawTimeSec;
    }
    rejectOutputTimestampSample(reason, catastrophic = false) {
        this.outputTimestampLastSample = null;
        this.outputTimestampGoodSamples = 0;
        this.outputTimestampGoodSinceMs = null;
        this._lastTimestampRejectReason = reason;
        if (this.activeAudioClockSource !== "timestamp") {
            this.outputTimestampBadSamples = 0;
            return;
        }
        this.outputTimestampBadSamples += 1;
        if (catastrophic ||
            this.outputTimestampBadSamples >=
                OUTPUT_TIMESTAMP_MAX_CONSECUTIVE_BAD_SAMPLES) {
            this.demoteOutputTimestampValidation(reason);
        }
    }
    getTimestampDerivedAudioTimeSec(rawTimeSec) {
        if (!this.audioContext) {
            return null;
        }
        const getOutputTimestamp = this.audioContext.getOutputTimestamp;
        if (typeof getOutputTimestamp !== "function") {
            if (this.activeAudioClockSource === "timestamp") {
                this.demoteOutputTimestampValidation("getOutputTimestamp unavailable");
            }
            return null;
        }
        try {
            const ts = getOutputTimestamp.call(this.audioContext);
            // Sample performance.now() after getOutputTimestamp() so we validate the
            // timestamp against a contemporaneous wall-clock reading instead of an
            // earlier one taken before the browser produced the timestamp snapshot.
            const nowMs = performance.now();
            const rawFreshnessMs = nowMs - ts.performanceTime;
            if (rawFreshnessMs < -OUTPUT_TIMESTAMP_FUTURE_TOLERANCE_MS) {
                this.rejectOutputTimestampSample(`performanceTime in future (${rawFreshnessMs.toFixed(1)}ms)`, true);
                return null;
            }
            const freshnessMs = Math.max(0, rawFreshnessMs);
            const predictedAudioTimeSec = ts.contextTime + freshnessMs / 1000;
            const sample = {
                contextTimeSec: ts.contextTime,
                performanceTimeMs: ts.performanceTime,
                nowMs,
                predictedAudioTimeSec,
                rawAudioTimeSec: rawTimeSec,
            };
            if (freshnessMs > OUTPUT_TIMESTAMP_MAX_FRESHNESS_MS) {
                this.rejectOutputTimestampSample(`stale timestamp (${freshnessMs.toFixed(1)}ms old)`, true);
                return null;
            }
            const divergenceSec = predictedAudioTimeSec - rawTimeSec;
            if (Math.abs(divergenceSec) > OUTPUT_TIMESTAMP_MAX_DIVERGENCE_SEC) {
                this.rejectOutputTimestampSample(`timestamp/raw divergence ${Math.abs(divergenceSec * 1000).toFixed(1)}ms`, true);
                return null;
            }
            const lastSample = this.outputTimestampLastSample;
            if (lastSample) {
                const perfDeltaMs = ts.performanceTime - lastSample.performanceTimeMs;
                if (perfDeltaMs < 0) {
                    this.rejectOutputTimestampSample(`performanceTime moved backward (${perfDeltaMs.toFixed(1)}ms)`, true);
                    return null;
                }
                if (predictedAudioTimeSec <
                    lastSample.predictedAudioTimeSec - OUTPUT_TIMESTAMP_MAX_BACKWARD_SEC) {
                    this.rejectOutputTimestampSample(`predicted audio time moved backward ${((lastSample.predictedAudioTimeSec - predictedAudioTimeSec) * 1000).toFixed(1)}ms`, true);
                    return null;
                }
                const lastDivergenceSec = lastSample.predictedAudioTimeSec - lastSample.rawAudioTimeSec;
                if (Math.abs(divergenceSec - lastDivergenceSec) >
                    OUTPUT_TIMESTAMP_MAX_DIVERGENCE_DELTA_SEC) {
                    this.rejectOutputTimestampSample(`timestamp/raw divergence drift ${Math.abs((divergenceSec - lastDivergenceSec) * 1000).toFixed(1)}ms`);
                    return null;
                }
                if (perfDeltaMs >= OUTPUT_TIMESTAMP_MIN_SAMPLE_INTERVAL_MS) {
                    const perfDeltaSec = perfDeltaMs / 1000;
                    const contextSlope = (ts.contextTime - lastSample.contextTimeSec) / perfDeltaSec;
                    const predictedSlope = (predictedAudioTimeSec - lastSample.predictedAudioTimeSec) /
                        perfDeltaSec;
                    if (contextSlope < OUTPUT_TIMESTAMP_SLOPE_MIN ||
                        contextSlope > OUTPUT_TIMESTAMP_SLOPE_MAX) {
                        this.rejectOutputTimestampSample(`context slope ${contextSlope.toFixed(3)} out of range`);
                        return null;
                    }
                    if (predictedSlope < OUTPUT_TIMESTAMP_SLOPE_MIN ||
                        predictedSlope > OUTPUT_TIMESTAMP_SLOPE_MAX) {
                        this.rejectOutputTimestampSample(`predicted slope ${predictedSlope.toFixed(3)} out of range`);
                        return null;
                    }
                }
            }
            this.outputTimestampLastSample = sample;
            this.outputTimestampBadSamples = 0;
            if (this.outputTimestampGoodSinceMs === null) {
                this.outputTimestampGoodSinceMs = nowMs;
            }
            this.outputTimestampGoodSamples += 1;
            if (this.activeAudioClockSource !== "timestamp" &&
                this.outputTimestampGoodSamples >=
                    OUTPUT_TIMESTAMP_PROMOTION_MIN_GOOD_SAMPLES &&
                this.outputTimestampGoodSinceMs !== null &&
                nowMs - this.outputTimestampGoodSinceMs >=
                    OUTPUT_TIMESTAMP_PROMOTION_MIN_SPAN_MS) {
                this.setActiveAudioClockSource("timestamp");
                this._lastTimestampRejectReason = null;
            }
            return predictedAudioTimeSec;
        }
        catch (error) {
            const reason = error instanceof Error
                ? `getOutputTimestamp failed: ${error.message}`
                : `getOutputTimestamp failed: ${String(error)}`;
            this.rejectOutputTimestampSample(reason, true);
            return null;
        }
    }
    getTimingSnapshot() {
        const nowMs = performance.now();
        const nowUs = nowMs * 1000;
        if (!this.audioContext) {
            return {
                audioContextTimeSec: 0,
                audioContextRawTimeSec: 0,
                nowMs,
                nowUs,
            };
        }
        const rawTimeSec = this.audioContext.currentTime;
        const estimatedTimeSec = this.getEstimatedAudioContextTimeSec(rawTimeSec, nowMs);
        const timestampTimeSec = this.getTimestampDerivedAudioTimeSec(rawTimeSec);
        let derivedTimeSec = this.activeAudioClockSource === "timestamp" && timestampTimeSec !== null
            ? timestampTimeSec
            : estimatedTimeSec;
        if (!Number.isFinite(derivedTimeSec)) {
            derivedTimeSec = rawTimeSec;
        }
        return {
            audioContextTimeSec: derivedTimeSec,
            audioContextRawTimeSec: rawTimeSec,
            nowMs,
            nowUs,
        };
    }
    resetScheduledPlaybackState(_reason) {
        this.nextPlaybackTime = 0;
        this.nextScheduleTime = 0;
        this.lastScheduledServerTime = 0;
        this.recorrectionMinScheduleTimeSec = null;
        this.hardResyncGraceUntilMs = null;
        this.lastHardResyncAtMs = -Infinity;
        this.pendingClockSourceCutover = false;
        this.resetRecorrectionCheckState();
        this.resetSyncErrorEma();
        this.currentSyncErrorMs = 0;
        this.currentPlaybackRate = 1.0;
        this.currentCorrectionMethod = "none";
        this.lastSamplesAdjusted = 0;
        this._lastStatusLogMs = 0;
        this._intervalResyncCount = 0;
    }
    pruneExpiredScheduledSources(currentTimeSec) {
        if (this.scheduledSources.length === 0) {
            return;
        }
        this.scheduledSources = this.scheduledSources.filter((entry) => entry.endTime > currentTimeSec);
        if (this.scheduledSources.length === 0) {
            this.resetScheduledPlaybackState("no scheduled audio ahead");
        }
    }
    startRecorrectionMonitor() {
        if (this.recorrectionInterval !== null) {
            return;
        }
        this.recorrectionInterval = globalThis.setInterval(() => this.checkRecorrection(), RECORRECTION_CHECK_INTERVAL_MS);
    }
    stopRecorrectionMonitor() {
        if (this.recorrectionInterval !== null) {
            clearInterval(this.recorrectionInterval);
            this.recorrectionInterval = null;
        }
        this.resetRecorrectionCheckState();
        this.lastRecorrectionAtMs = -Infinity;
    }
    clearRecorrectionBreachState() {
        this.recorrectionBreachStartedAtMs = null;
        this.recorrectionPendingJumpSign = null;
        this.recorrectionPendingJumpAtMs = null;
    }
    resetRecorrectionCheckState() {
        this.clearRecorrectionBreachState();
        this.recorrectionPrevRawSyncErrorMs = null;
    }
    armHardResyncStartupGrace(nowMs) {
        if (this.activeAudioClockSource === "timestamp") {
            this.hardResyncGraceUntilMs = null;
            return;
        }
        if (this.hardResyncGraceUntilMs === null) {
            this.hardResyncGraceUntilMs = nowMs + HARD_RESYNC_STARTUP_GRACE_MS;
        }
    }
    canUseHardResync(nowMs) {
        if (this.activeAudioClockSource === "timestamp") {
            this.hardResyncGraceUntilMs = null;
        }
        else if (this.hardResyncGraceUntilMs !== null &&
            nowMs < this.hardResyncGraceUntilMs) {
            return false;
        }
        return nowMs - this.lastHardResyncAtMs >= HARD_RESYNC_COOLDOWN_MS;
    }
    noteHardResync(nowMs) {
        this.lastHardResyncAtMs = nowMs;
    }
    shouldIgnoreTransientRecorrectionJump(rawSyncErrorMs, nowMs) {
        const prevRawSyncErrorMs = this.recorrectionPrevRawSyncErrorMs;
        this.recorrectionPrevRawSyncErrorMs = rawSyncErrorMs;
        if (prevRawSyncErrorMs === null) {
            this.recorrectionPendingJumpSign = null;
            this.recorrectionPendingJumpAtMs = null;
            return false;
        }
        const jumpDeltaMs = rawSyncErrorMs - prevRawSyncErrorMs;
        const jumpSign = Math.sign(rawSyncErrorMs);
        const isJumpDetected = Math.abs(jumpDeltaMs) >= RECORRECTION_TRANSIENT_JUMP_MS && jumpSign !== 0;
        if (!isJumpDetected) {
            this.recorrectionPendingJumpSign = null;
            this.recorrectionPendingJumpAtMs = null;
            return false;
        }
        const isConfirmed = this.recorrectionPendingJumpSign === jumpSign &&
            this.recorrectionPendingJumpAtMs !== null &&
            nowMs - this.recorrectionPendingJumpAtMs <=
                RECORRECTION_TRANSIENT_CONFIRM_WINDOW_MS;
        this.recorrectionPendingJumpSign = jumpSign;
        this.recorrectionPendingJumpAtMs = nowMs;
        if (isConfirmed) {
            this.recorrectionPendingJumpSign = null;
            this.recorrectionPendingJumpAtMs = null;
            return false;
        }
        return true;
    }
    performGuardedCutover(reason, options = {}) {
        if (!this.audioContext) {
            return;
        }
        const incrementResyncCount = options.incrementResyncCount ?? false;
        const markCooldown = options.markCooldown ?? true;
        const nowMs = performance.now();
        const cutoffTime = this.audioContext.currentTime + RECORRECTION_CUTOVER_GUARD_SEC;
        if (incrementResyncCount) {
            this.resyncCount++;
            this._intervalResyncCount++;
        }
        this.resetSyncErrorEma();
        this.currentCorrectionMethod = "resync";
        this.lastSamplesAdjusted = 0;
        this.currentPlaybackRate = 1.0;
        const cutResult = this.cutScheduledSources(cutoffTime);
        this.recorrectionMinScheduleTimeSec = Math.max(cutoffTime, cutResult.keptTailEndTimeSec);
        this.nextPlaybackTime = 0;
        this.nextScheduleTime = 0;
        this.lastScheduledServerTime = 0;
        this.resetRecorrectionCheckState();
        if (markCooldown) {
            this.lastRecorrectionAtMs = nowMs;
        }
        this.noteHardResync(nowMs);
        this.processAudioQueue();
    }
    checkRecorrection() {
        if (!this.usesRecorrectionMonitor) {
            this.resetRecorrectionCheckState();
            return;
        }
        if (!this.audioContext || this.audioContext.state !== "running") {
            this.resetRecorrectionCheckState();
            return;
        }
        if (!this.stateManager.isPlaying ||
            this.nextPlaybackTime === 0 ||
            this.lastScheduledServerTime === 0) {
            this.resetRecorrectionCheckState();
            return;
        }
        const { audioContextTimeSec: audioContextTime, audioContextRawTimeSec: audioContextRawTime, nowMs, nowUs, } = this.getTimingSnapshot();
        this.pruneExpiredScheduledSources(audioContextRawTime);
        const scheduledAheadSec = this.getScheduledAheadSec(audioContextRawTime);
        if (scheduledAheadSec <= 0) {
            this.resetRecorrectionCheckState();
            if (this.audioBufferQueue.length > 0) {
                this.processAudioQueue();
            }
            return;
        }
        const outputLatencySec = this.useOutputLatencyCompensation
            ? this.getSmoothedOutputLatencyUs() / 1000000
            : 0;
        const targetPlaybackTime = this.computeTargetPlaybackTime(this.lastScheduledServerTime, audioContextTime, nowUs, outputLatencySec);
        const syncErrorMs = (this.nextPlaybackTime - targetPlaybackTime) * 1000;
        const smoothedSyncErrorMs = this.applySyncErrorEma(syncErrorMs);
        const absErrorMs = Math.abs(smoothedSyncErrorMs);
        const isTransientJump = this.shouldIgnoreTransientRecorrectionJump(syncErrorMs, nowMs);
        if (absErrorMs < RECORRECTION_TRIGGER_MS) {
            this.clearRecorrectionBreachState();
            return;
        }
        if (isTransientJump) {
            this.clearRecorrectionBreachState();
            return;
        }
        if (this.recorrectionBreachStartedAtMs === null) {
            this.recorrectionBreachStartedAtMs = nowMs;
            return;
        }
        if (nowMs - this.recorrectionBreachStartedAtMs < RECORRECTION_SUSTAIN_MS) {
            return;
        }
        if (nowMs - this.lastRecorrectionAtMs < RECORRECTION_COOLDOWN_MS) {
            return;
        }
        this.applyRecorrectionCutover();
    }
    applyRecorrectionCutover() {
        this.performGuardedCutover("recorrection", {
            incrementResyncCount: true,
            markCooldown: true,
        });
    }
    getSyncDelayMs() {
        return this.syncDelayMs;
    }
    // Update sync delay at runtime
    setSyncDelay(delayMs) {
        const sanitizedDelayMs = this.sanitizeSyncDelayMs(delayMs);
        const oldDelayMs = this.syncDelayMs;
        const deltaMs = sanitizedDelayMs - oldDelayMs;
        this.syncDelayMs = sanitizedDelayMs;
        if (deltaMs === 0 || !this.usesImmediateDelayCutover) {
            return;
        }
        if (!this.audioContext || this.audioContext.state !== "running") {
            return;
        }
        if (!this.stateManager.isPlaying) {
            return;
        }
        if (this.scheduledSources.length === 0 &&
            this.audioBufferQueue.length === 0 &&
            this.nextPlaybackTime === 0) {
            return;
        }
        this.performGuardedCutover("delay-change", {
            incrementResyncCount: false,
            markCooldown: true,
        });
    }
    // Get current sync info for debugging/display
    get syncInfo() {
        return {
            clockDriftPercent: this.timeFilter.drift * 100,
            syncErrorMs: this.currentSyncErrorMs,
            resyncCount: this.resyncCount,
            outputLatencyMs: this.getRawOutputLatencyUs() / 1000,
            playbackRate: this.currentPlaybackRate,
            correctionMethod: this.currentCorrectionMethod,
            samplesAdjusted: this.lastSamplesAdjusted,
            correctionMode: this._correctionMode,
        };
    }
    emitStatusLog(nowMs) {
        if (this._lastStatusLogMs !== 0 && nowMs - this._lastStatusLogMs < 10000) {
            return;
        }
        this._lastStatusLogMs = nowMs;
        // corr field
        let corr;
        switch (this.currentCorrectionMethod) {
            case "rate":
                corr = `rate@${this.currentPlaybackRate}`;
                break;
            case "samples":
                corr = `samples:${this.lastSamplesAdjusted}`;
                break;
            default:
                corr = this.currentCorrectionMethod;
        }
        // q field
        const queueDepth = this.audioBufferQueue.length + this.scheduledSources.length;
        const aheadSec = this.audioContext
            ? this.getScheduledAheadSec(this.audioContext.currentTime)
            : 0;
        // clock field
        let clock;
        if (this.activeAudioClockSource === "timestamp") {
            clock = `timestamp(good:${this.outputTimestampGoodSamples})`;
        }
        else if (this._lastTimestampRejectReason) {
            clock = `estimated(reject:"${this._lastTimestampRejectReason}")`;
        }
        else {
            clock = "estimated";
        }
        // tf field
        const tf = this.timeFilter.is_synchronized
            ? `synced(err=${(this.timeFilter.error / 1000).toFixed(1)}ms,drift=${this.timeFilter.drift.toFixed(3)},n=${this.timeFilter.count})`
            : `pending(n=${this.timeFilter.count})`;
        // lat field
        const latMs = this.smoothedOutputLatencyUs !== null
            ? Math.round(this.smoothedOutputLatencyUs / 1000)
            : 0;
        console.log(`Sendspin: sync=${this.smoothedSyncErrorMs >= 0 ? "+" : ""}${this.smoothedSyncErrorMs.toFixed(1)}ms` +
            ` corr=${corr}` +
            ` q=${queueDepth}/${aheadSec.toFixed(1)}s` +
            ` resyncs=${this._intervalResyncCount}` +
            ` clock=${clock}` +
            ` tf=${tf}` +
            ` lat=${latMs}ms` +
            ` mode=${this._correctionMode}` +
            ` ctx=${this.audioContext?.state ?? "null"}` +
            ` gen=${this.stateManager.streamGeneration}`);
        this._intervalResyncCount = 0;
    }
    applySyncErrorEma(inputMs) {
        this.currentSyncErrorMs = inputMs;
        this.smoothedSyncErrorMs =
            SYNC_ERROR_ALPHA * inputMs +
                (1 - SYNC_ERROR_ALPHA) * this.smoothedSyncErrorMs;
        return this.smoothedSyncErrorMs;
    }
    resetSyncErrorEma() {
        this.smoothedSyncErrorMs = 0;
    }
    // Get raw output latency in microseconds (for Kalman filter input)
    getRawOutputLatencyUs() {
        if (!this.audioContext)
            return 0;
        const baseLatency = this.audioContext.baseLatency ?? 0;
        const outputLatency = this.audioContext.outputLatency ?? 0;
        const rawUs = (baseLatency + outputLatency) * 1000000; // Convert seconds to microseconds
        this.lastRawOutputLatencyUs = rawUs;
        return rawUs;
    }
    // Get smoothed output latency in microseconds (filters Chrome jitter)
    getSmoothedOutputLatencyUs() {
        const rawLatencyUs = this.getRawOutputLatencyUs();
        // Some browsers report 0 until playback is active; treat 0 as "unknown"
        // and keep the last good estimate to avoid poisoning sync.
        if (rawLatencyUs <= 0 && this.smoothedOutputLatencyUs !== null) {
            return this.smoothedOutputLatencyUs;
        }
        if (this.smoothedOutputLatencyUs === null) {
            this.smoothedOutputLatencyUs = rawLatencyUs;
        }
        else {
            this.smoothedOutputLatencyUs =
                OUTPUT_LATENCY_ALPHA * rawLatencyUs +
                    (1 - OUTPUT_LATENCY_ALPHA) * this.smoothedOutputLatencyUs;
        }
        const nowMs = typeof performance !== "undefined" ? performance.now() : Date.now();
        if (this.lastLatencyPersistAtMs === null ||
            nowMs - this.lastLatencyPersistAtMs >= OUTPUT_LATENCY_PERSIST_INTERVAL_MS) {
            this.persistLatency();
            this.lastLatencyPersistAtMs = nowMs;
        }
        return this.smoothedOutputLatencyUs;
    }
    // Reset latency smoother (call on stream change or audio context recreation)
    resetLatencySmoother() {
        this.smoothedOutputLatencyUs = null;
    }
    // Create a fresh copy of an AudioBuffer
    // Some decoders produce buffers with boundary artifacts - copying fixes this
    copyBuffer(buffer) {
        if (!this.audioContext)
            return buffer;
        const newBuffer = this.audioContext.createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
        for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
            newBuffer.getChannelData(ch).set(buffer.getChannelData(ch));
        }
        return newBuffer;
    }
    // Adjust buffer by inserting or deleting 1 sample using interpolation
    // Insert: [A, B, ...] → [A, (A+B)/2, B, ...] (at start)
    // Delete: [..., Y, Z] → [..., (Y+Z)/2] (at end)
    adjustBufferSamples(buffer, samplesToAdjust) {
        if (!this.audioContext || samplesToAdjust === 0 || buffer.length < 2) {
            return this.copyBuffer(buffer);
        }
        const channels = buffer.numberOfChannels;
        const len = buffer.length;
        const sampleRate = buffer.sampleRate;
        try {
            if (samplesToAdjust > 0) {
                // Insert 1 sample at START: [A, B, ...] → [A, (A+B)/2, B, ...]
                const newBuffer = this.audioContext.createBuffer(channels, len + 1, sampleRate);
                for (let ch = 0; ch < channels; ch++) {
                    const oldData = buffer.getChannelData(ch);
                    const newData = newBuffer.getChannelData(ch);
                    newData[0] = oldData[0];
                    const insertedSample = (oldData[0] + oldData[1]) / 2;
                    newData[1] = insertedSample;
                    newData.set(oldData.subarray(1), 2);
                    // After inserting one synthetic sample, gently pull the next few real samples toward it.
                    // This smooths the splice and avoids a hard step immediately after the insertion point.
                    for (let f = 0; f < SAMPLE_CORRECTION_FADE_LEN; f++) {
                        const pos = 2 + f;
                        if (pos >= newData.length)
                            break;
                        const alpha = SAMPLE_CORRECTION_FADE_ALPHAS[f];
                        newData[pos] = newData[pos] * (1 - alpha) + insertedSample * alpha;
                    }
                }
                return newBuffer;
            }
            else {
                // Delete 1 sample at END: [..., Y, Z] → [..., (Y+Z)/2]
                const newBuffer = this.audioContext.createBuffer(channels, len - 1, sampleRate);
                for (let ch = 0; ch < channels; ch++) {
                    const oldData = buffer.getChannelData(ch);
                    const newData = newBuffer.getChannelData(ch);
                    newData.set(oldData.subarray(0, len - 2));
                    const replacementSample = (oldData[len - 2] + oldData[len - 1]) / 2;
                    newData[len - 2] = replacementSample;
                    // Before a deletion collapse, gently pull the preceding samples toward the replacement.
                    // This smooths entry into the new boundary formed by skipping one sample.
                    for (let f = 0; f < SAMPLE_CORRECTION_FADE_LEN; f++) {
                        const pos = len - 3 - f;
                        if (pos < 0)
                            break;
                        const alpha = SAMPLE_CORRECTION_FADE_ALPHAS[f];
                        newData[pos] =
                            newData[pos] * (1 - alpha) + replacementSample * alpha;
                    }
                }
                return newBuffer;
            }
        }
        catch (e) {
            console.error("Sendspin: adjustBufferSamples error:", e);
            return buffer;
        }
    }
    // Initialize AudioContext with platform-specific setup
    initAudioContext() {
        if (this.audioContext) {
            return; // Already initialized
        }
        if (this.outputMode === "media-element" && this.ownsAudioElement) {
            this.audioElement = document.createElement("audio");
            this.audioElement.style.display = "none";
            document.body.appendChild(this.audioElement);
        }
        // Set audio session to "playback" so audio continues when iOS device is muted
        // (iOS 17+, no-op on other platforms)
        if (navigator.audioSession) {
            navigator.audioSession.type = "playback";
        }
        const streamSampleRate = this.stateManager.currentStreamFormat?.sample_rate || 48000;
        this.audioContext = new AudioContext({ sampleRate: streamSampleRate });
        this.gainNode = this.audioContext.createGain();
        const audioElement = this.audioElement;
        if (this.outputMode === "direct") {
            // Direct output to audioContext.destination (e.g., Cast receiver)
            this.gainNode.connect(this.audioContext.destination);
        }
        else {
            if (!audioElement) {
                throw new Error("Media-element output requires an audio element to be available during initialization.");
            }
            if (this.isAndroid && this.silentAudioSrc) {
                // Android MediaSession workaround: Play almost-silent audio file
                // Android browsers don't support MediaSession with MediaStream from Web Audio API
                // Solution: Loop almost-silent audio to keep MediaSession active
                // Real audio plays through Web Audio API → audioContext.destination
                this.gainNode.connect(this.audioContext.destination);
                // Use almost-silent audio file to trick Android into showing MediaSession
                audioElement.src = this.silentAudioSrc;
                audioElement.loop = true;
                // CRITICAL: Do NOT mute - Android requires audible audio for MediaSession
                audioElement.muted = false;
                // Set volume to 100% (the file itself is almost silent)
                audioElement.volume = 1.0;
                // Start playing to activate MediaSession
                audioElement.play().catch((e) => {
                    console.warn("Sendspin: Audio autoplay blocked:", e);
                });
            }
            else {
                // iOS/Desktop: Use MediaStream approach for background playback
                // Create MediaStreamDestination to bridge Web Audio API to HTML5 audio element
                this.streamDestination =
                    this.audioContext.createMediaStreamDestination();
                this.gainNode.connect(this.streamDestination);
                // Do NOT connect to audioContext.destination to avoid echo
                // Connect to HTML5 audio element for iOS background playback
                audioElement.srcObject = this.streamDestination.stream;
                audioElement.volume = 1.0;
                // Start playing to activate MediaSession
                audioElement.play().catch((e) => {
                    console.warn("Sendspin: Audio autoplay blocked:", e);
                });
            }
        }
        this.updateVolume();
        if (this.usesRecorrectionMonitor) {
            this.startRecorrectionMonitor();
        }
    }
    // Resume AudioContext if suspended (required for browser autoplay policies)
    async resumeAudioContext() {
        if (this.audioContext && this.audioContext.state === "suspended") {
            try {
                await this.audioContext.resume();
                console.log("Sendspin: AudioContext resumed");
            }
            catch (e) {
                console.warn("Sendspin: Failed to resume AudioContext:", e);
                return;
            }
            if (this.audioBufferQueue.length > 0) {
                this.scheduleQueueProcessing();
            }
            if (this.usesRecorrectionMonitor) {
                this.startRecorrectionMonitor();
            }
        }
    }
    cutScheduledSources(cutoffTime) {
        if (!this.audioContext) {
            return {
                requeuedCount: 0,
                cutCount: 0,
                keptTailEndTimeSec: 0,
            };
        }
        const stopTime = Math.max(cutoffTime, this.audioContext.currentTime);
        let requeued = 0;
        let cutCount = 0;
        let keptTailEndTimeSec = 0;
        this.scheduledSources = this.scheduledSources.filter((entry) => {
            // Keep sources scheduled before stopTime to avoid cutting mid-buffer artifacts.
            if (entry.startTime < stopTime) {
                keptTailEndTimeSec = Math.max(keptTailEndTimeSec, entry.endTime);
                return true;
            }
            try {
                entry.source.onended = null;
                entry.source.stop(stopTime);
            }
            catch (e) {
                // Ignore errors if source already stopped
            }
            this.audioBufferQueue.push({
                buffer: entry.buffer,
                serverTime: entry.serverTime,
                generation: entry.generation,
            });
            requeued++;
            cutCount++;
            return false;
        });
        return {
            requeuedCount: requeued,
            cutCount,
            keptTailEndTimeSec,
        };
    }
    // Update volume based on current state
    updateVolume() {
        if (!this.gainNode)
            return;
        // Hardware volume mode: keep software gain at 1.0, external handles volume
        if (this.useHardwareVolume) {
            this.gainNode.gain.value = 1.0;
            return;
        }
        if (this.stateManager.muted) {
            this.gainNode.gain.value = 0;
        }
        else {
            this.gainNode.gain.value = this.stateManager.volume / 100;
        }
    }
    // Decode audio data based on codec
    async decodeAudioData(audioData, format) {
        if (!this.audioContext)
            return null;
        try {
            if (format.codec === "opus") {
                // Opus fallback path - native decoder uses async queueToNativeOpusDecoder
                return await this.decodeOpusWithEncdec(audioData, format);
            }
            else if (format.codec === "flac") {
                // FLAC can be decoded by the browser's native decoder
                // If codec_header is provided, prepend it to the audio data
                let dataToEncode = audioData;
                if (format.codec_header) {
                    // Decode Base64 codec header
                    const headerBytes = Uint8Array.from(atob(format.codec_header), (c) => c.charCodeAt(0));
                    // Concatenate header + audio data
                    const combined = new Uint8Array(headerBytes.length + audioData.byteLength);
                    combined.set(headerBytes, 0);
                    combined.set(new Uint8Array(audioData), headerBytes.length);
                    dataToEncode = combined.buffer;
                }
                return await this.audioContext.decodeAudioData(dataToEncode);
            }
            else if (format.codec === "pcm") {
                // PCM data needs manual decoding
                return this.decodePCMData(audioData, format);
            }
        }
        catch (error) {
            console.error("Error decoding audio data:", error);
        }
        return null;
    }
    // Initialize native Opus decoder
    async initWebCodecsDecoder(format) {
        const tryConfigureExistingDecoder = () => {
            if (!this.webCodecsDecoder)
                return false;
            const matchesFormat = !!this.webCodecsFormat &&
                this.webCodecsFormat.sample_rate === format.sample_rate &&
                this.webCodecsFormat.channels === format.channels;
            if (this.webCodecsDecoder.state === "configured" && matchesFormat) {
                return true;
            }
            if (this.webCodecsDecoder.state === "closed") {
                return false;
            }
            try {
                this.webCodecsDecoder.configure({
                    codec: "opus",
                    sampleRate: format.sample_rate,
                    numberOfChannels: format.channels,
                });
                this.webCodecsFormat = format;
                return true;
            }
            catch {
                return false;
            }
        };
        if (tryConfigureExistingDecoder()) {
            return;
        }
        if (this.webCodecsDecoderReady) {
            await this.webCodecsDecoderReady;
            if (tryConfigureExistingDecoder()) {
                return;
            }
            try {
                this.webCodecsDecoder?.close();
            }
            catch {
                // Ignore close errors; we'll recreate below.
            }
            this.webCodecsDecoder = null;
            this.webCodecsDecoderReady = null;
            this.webCodecsFormat = null;
        }
        if (this.webCodecsDecoderReady) {
            await this.webCodecsDecoderReady;
            return;
        }
        this.webCodecsDecoderReady = this.createWebCodecsDecoder(format);
        await this.webCodecsDecoderReady;
    }
    // Create and configure native Opus decoder (WebCodecs)
    async createWebCodecsDecoder(format) {
        if (typeof AudioDecoder === "undefined") {
            this.useNativeOpus = false;
            return;
        }
        try {
            const support = await AudioDecoder.isConfigSupported({
                codec: "opus",
                sampleRate: format.sample_rate,
                numberOfChannels: format.channels,
            });
            if (!support.supported) {
                console.log("[NativeOpus] WebCodecs Opus not supported, will use fallback");
                this.useNativeOpus = false;
                return;
            }
            this.webCodecsDecoder = new AudioDecoder({
                output: (audioData) => this.handleAudioData(audioData),
                error: (error) => {
                    console.error("[NativeOpus] WebCodecs decoder error:", error);
                },
            });
            this.webCodecsDecoder.configure({
                codec: "opus",
                sampleRate: format.sample_rate,
                numberOfChannels: format.channels,
            });
            this.webCodecsFormat = format;
            console.log(`[NativeOpus] Using WebCodecs AudioDecoder: ${format.sample_rate}Hz, ${format.channels}ch`);
        }
        catch (error) {
            console.warn("[NativeOpus] WebCodecs init failed, will use fallback:", error);
            this.useNativeOpus = false;
        }
    }
    // Handle decoded audio data from native Opus decoder
    handleAudioData(audioData) {
        try {
            const outputTimestampUs = Number(audioData.timestamp);
            const metadata = this.nativeDecoderQueue.shift();
            if (!metadata) {
                console.warn(`[NativeOpus] Dropping frame with empty decode queue (out ts=${outputTimestampUs})`);
                audioData.close();
                return;
            }
            const { serverTimeUs, generation } = metadata;
            if (generation !== this.stateManager.streamGeneration) {
                console.warn(`[NativeOpus] Dropping old-stream frame (ts=${serverTimeUs}, gen=${generation} != current=${this.stateManager.streamGeneration})`);
                audioData.close();
                return;
            }
            const channels = audioData.numberOfChannels;
            const frames = audioData.numberOfFrames;
            const fmt = audioData.format;
            let interleaved;
            if (fmt === "f32-planar") {
                interleaved = new Float32Array(frames * channels);
                for (let ch = 0; ch < channels; ch++) {
                    const channelData = new Float32Array(frames);
                    audioData.copyTo(channelData, { planeIndex: ch });
                    for (let i = 0; i < frames; i++) {
                        interleaved[i * channels + ch] = channelData[i];
                    }
                }
            }
            else if (fmt === "f32") {
                interleaved = new Float32Array(frames * channels);
                audioData.copyTo(interleaved, { planeIndex: 0 });
            }
            else if (fmt === "s16-planar") {
                interleaved = new Float32Array(frames * channels);
                for (let ch = 0; ch < channels; ch++) {
                    const channelData = new Int16Array(frames);
                    audioData.copyTo(channelData, { planeIndex: ch });
                    for (let i = 0; i < frames; i++) {
                        interleaved[i * channels + ch] = channelData[i] / 32768.0;
                    }
                }
            }
            else if (fmt === "s16") {
                const int16Data = new Int16Array(frames * channels);
                audioData.copyTo(int16Data, { planeIndex: 0 });
                interleaved = new Float32Array(frames * channels);
                for (let i = 0; i < frames * channels; i++) {
                    interleaved[i] = int16Data[i] / 32768.0;
                }
            }
            else {
                console.warn(`[NativeOpus] Unsupported AudioData format: ${fmt}`);
                audioData.close();
                return;
            }
            this.handleNativeOpusOutput(interleaved, serverTimeUs, channels);
            audioData.close();
        }
        catch (e) {
            console.error("[NativeOpus] Error in output callback:", e);
            audioData.close();
        }
    }
    resolveOpusDecoderModule(moduleExport) {
        const maybeDefault = moduleExport?.default;
        const maybeCommonJs = moduleExport?.["module.exports"];
        const resolved = maybeDefault ?? maybeCommonJs ?? moduleExport;
        if (!resolved || typeof resolved !== "object") {
            throw new Error("[Opus] Invalid libopus decoder module export");
        }
        return resolved;
    }
    resolveOggOpusDecoderClass(wrapperExport) {
        const maybeDefault = wrapperExport?.default;
        const maybeCommonJs = wrapperExport?.["module.exports"];
        const wrapper = maybeDefault ?? maybeCommonJs ?? wrapperExport;
        const resolved = wrapper?.OggOpusDecoder ?? wrapper;
        if (typeof resolved !== "function") {
            throw new Error("[Opus] OggOpusDecoder class export not found");
        }
        return resolved;
    }
    async waitForOpusReady(target) {
        if (target.isReady)
            return;
        if (Object.isExtensible(target)) {
            await new Promise((resolve) => {
                target.onready = () => resolve();
            });
            return;
        }
        while (!target.isReady) {
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
    }
    // Initialize opus-encdec decoder (fallback when WebCodecs unavailable)
    async initOpusEncdecDecoder(format) {
        if (this.opusDecoderReady) {
            await this.opusDecoderReady;
            return;
        }
        this.opusDecoderReady = (async () => {
            console.log("[Opus] Initializing decoder (opus-encdec)...");
            // Dynamically import the pure JavaScript decoder (not WASM) to avoid bundling issues
            const [DecoderModuleExport, DecoderWrapperExport] = await Promise.all([
                Promise.resolve().then(function () { return libopusDecoder$1; }),
                Promise.resolve().then(function () { return oggOpusDecoder$1; }),
            ]);
            this.opusDecoderModule =
                this.resolveOpusDecoderModule(DecoderModuleExport);
            const OggOpusDecoderClass = this.resolveOggOpusDecoderClass(DecoderWrapperExport);
            // Wait for Module to be ready (async asm.js initialization)
            await this.waitForOpusReady(this.opusDecoderModule);
            // Create decoder instance
            this.opusDecoder = new OggOpusDecoderClass({
                rawOpus: true, // We're decoding raw Opus packets, not Ogg containers
                decoderSampleRate: format.sample_rate,
                outputBufferSampleRate: format.sample_rate,
                numberOfChannels: format.channels,
            }, this.opusDecoderModule);
            // Wait for decoder to be ready if needed
            await this.waitForOpusReady(this.opusDecoder);
            console.log("[Opus] Decoder ready");
        })();
        await this.opusDecoderReady;
    }
    // Handle native Opus decoder output - creates AudioBuffer and adds to queue
    handleNativeOpusOutput(interleaved, serverTimeUs, channels) {
        if (!this.audioContext || !this.webCodecsFormat) {
            return;
        }
        const numFrames = interleaved.length / channels;
        const audioBuffer = this.audioContext.createBuffer(channels, numFrames, this.webCodecsFormat.sample_rate);
        // De-interleave samples into separate channels
        for (let ch = 0; ch < channels; ch++) {
            const channelData = audioBuffer.getChannelData(ch);
            for (let i = 0; i < numFrames; i++) {
                channelData[i] = interleaved[i * channels + ch];
            }
        }
        // Add to queue directly
        this.audioBufferQueue.push({
            buffer: audioBuffer,
            serverTime: serverTimeUs,
            generation: this.stateManager.streamGeneration,
        });
        this.scheduleQueueProcessing();
    }
    // Schedule queue processing without starvation.
    // Uses a short timeout to allow out-of-order async decodes (FLAC) to batch.
    // TODO: Consider a "max-wait" watchdog if timer throttling/clamping causes excessive scheduling latency.
    scheduleQueueProcessing() {
        if (this.queueProcessScheduled) {
            return;
        }
        this.queueProcessScheduled = true;
        if (typeof globalThis.setTimeout === "function") {
            this.scheduleTimeout = globalThis.setTimeout(() => {
                this.scheduleTimeout = null;
                this.queueProcessScheduled = false;
                this.processAudioQueue();
            }, 15);
            return;
        }
        const run = () => {
            this.queueProcessScheduled = false;
            this.processAudioQueue();
        };
        if (typeof globalThis
            .queueMicrotask === "function") {
            globalThis.queueMicrotask(run);
        }
        else {
            Promise.resolve().then(run);
        }
    }
    // Queue Opus packet to native decoder for async decoding (non-blocking)
    queueToNativeOpusDecoder(audioData, serverTimeUs, generation) {
        if (!this.webCodecsDecoder ||
            this.webCodecsDecoder.state !== "configured") {
            return false;
        }
        try {
            this.nativeDecoderQueue.push({
                serverTimeUs,
                generation,
            });
            const chunk = new EncodedAudioChunk({
                type: "key", // Opus packets are self-contained
                // Keep server time as timestamp for easier debugging/inspection.
                timestamp: serverTimeUs,
                data: audioData,
            });
            // Queue for async decoding (non-blocking)
            this.webCodecsDecoder.decode(chunk);
            return true;
        }
        catch (error) {
            if (this.nativeDecoderQueue.length > 0) {
                this.nativeDecoderQueue.pop();
            }
            console.error("[NativeOpus] WebCodecs queue error:", error);
            return false;
        }
    }
    // Decode using opus-encdec library (fallback)
    async decodeOpusWithEncdec(audioData, format) {
        if (!this.audioContext) {
            return null;
        }
        try {
            // Initialize fallback decoder if needed
            await this.initOpusEncdecDecoder(format);
            // Decode the raw Opus packet
            const uint8Array = new Uint8Array(audioData);
            const decodedSamples = [];
            this.opusDecoder.decodeRaw(uint8Array, (samples) => {
                // Copy samples since they're from WASM heap
                decodedSamples.push(new Float32Array(samples));
            });
            if (decodedSamples.length === 0) {
                console.warn("[Opus] Fallback decoder produced no samples");
                return null;
            }
            // Convert interleaved samples to AudioBuffer
            const interleavedSamples = decodedSamples[0];
            const numFrames = interleavedSamples.length / format.channels;
            const audioBuffer = this.audioContext.createBuffer(format.channels, numFrames, format.sample_rate);
            // De-interleave samples into separate channels
            for (let ch = 0; ch < format.channels; ch++) {
                const channelData = audioBuffer.getChannelData(ch);
                for (let i = 0; i < numFrames; i++) {
                    channelData[i] = interleavedSamples[i * format.channels + ch];
                }
            }
            return audioBuffer;
        }
        catch (error) {
            console.error("[Opus] Decode error:", error);
            return null;
        }
    }
    // Decode PCM audio data
    decodePCMData(audioData, format) {
        if (!this.audioContext)
            return null;
        const bytesPerSample = (format.bit_depth || 16) / 8;
        const dataView = new DataView(audioData);
        const numSamples = audioData.byteLength / (bytesPerSample * format.channels);
        const audioBuffer = this.audioContext.createBuffer(format.channels, numSamples, format.sample_rate);
        // Decode PCM data (interleaved format)
        for (let channel = 0; channel < format.channels; channel++) {
            const channelData = audioBuffer.getChannelData(channel);
            for (let i = 0; i < numSamples; i++) {
                const offset = (i * format.channels + channel) * bytesPerSample;
                let sample = 0;
                if (format.bit_depth === 16) {
                    sample = dataView.getInt16(offset, true) / 32768.0;
                }
                else if (format.bit_depth === 24) {
                    // 24-bit is stored in 3 bytes (little-endian)
                    const byte1 = dataView.getUint8(offset);
                    const byte2 = dataView.getUint8(offset + 1);
                    const byte3 = dataView.getUint8(offset + 2);
                    // Reconstruct as signed 24-bit value
                    let int24 = (byte3 << 16) | (byte2 << 8) | byte1;
                    // Sign extend if necessary
                    if (int24 & 0x800000) {
                        int24 |= 0xff000000;
                    }
                    sample = int24 / 8388608.0;
                }
                else if (format.bit_depth === 32) {
                    sample = dataView.getInt32(offset, true) / 2147483648.0;
                }
                channelData[i] = sample;
            }
        }
        return audioBuffer;
    }
    // Handle binary audio message
    async handleBinaryMessage(data) {
        const format = this.stateManager.currentStreamFormat;
        if (!format) {
            console.warn("Sendspin: Received audio chunk but no stream format set");
            return;
        }
        if (!this.audioContext) {
            console.warn("Sendspin: Received audio chunk but no audio context");
            return;
        }
        if (!this.gainNode) {
            console.warn("Sendspin: Received audio chunk but no gain node");
            return;
        }
        // Capture stream generation before async decode
        const generation = this.stateManager.streamGeneration;
        // First byte contains role type and message slot
        // Spec: bits 7-2 identify role type (6 bits), bits 1-0 identify message slot (2 bits)
        const firstByte = new Uint8Array(data)[0];
        // Type 4 is audio chunk (Player role, slot 0) - IDs 4-7 are player role
        if (firstByte === 4) {
            // Next 8 bytes are server timestamp in microseconds (big-endian int64)
            const timestampView = new DataView(data, 1, 8);
            // Read as big-endian int64 and convert to number
            const serverTimeUs = Number(timestampView.getBigInt64(0, false));
            // Rest is audio data
            const audioData = data.slice(9);
            // For Opus: use native decoder (non-blocking async path)
            if (format.codec === "opus" && this.useNativeOpus) {
                await this.initWebCodecsDecoder(format);
                if (this.useNativeOpus && this.webCodecsDecoder) {
                    if (this.queueToNativeOpusDecoder(audioData, serverTimeUs, generation)) {
                        return; // Async path - callback handles queue
                    }
                    // Fall through to fallback on error
                }
            }
            // Fallback decode path (PCM, FLAC, or Opus via opus-encdec)
            const audioBuffer = await this.decodeAudioData(audioData, format);
            if (audioBuffer) {
                // Check if stream generation changed during async decode
                if (generation !== this.stateManager.streamGeneration) {
                    return;
                }
                // Add to queue for ordered playback
                this.audioBufferQueue.push({
                    buffer: audioBuffer,
                    serverTime: serverTimeUs,
                    generation: generation,
                });
                this.scheduleQueueProcessing();
            }
            else {
                console.error("Sendspin: Failed to decode audio buffer");
            }
        }
    }
    // Process the audio queue and schedule chunks in order
    processAudioQueue() {
        if (!this.audioContext || !this.gainNode)
            return;
        if (this.audioContext.state !== "running")
            return;
        // Filter out any chunks from old streams (safety check)
        const currentGeneration = this.stateManager.streamGeneration;
        this.audioBufferQueue = this.audioBufferQueue.filter((chunk) => chunk.generation === currentGeneration);
        // Sort queue by server timestamp to ensure proper ordering
        this.audioBufferQueue.sort((a, b) => a.serverTime - b.serverTime);
        // Don't schedule until time sync is ready
        if (!this.timeFilter.is_synchronized) {
            return;
        }
        const { audioContextTimeSec: audioContextTime, audioContextRawTimeSec, nowMs, nowUs, } = this.getTimingSnapshot();
        this.pruneExpiredScheduledSources(audioContextRawTimeSec);
        const outputLatencySec = this.useOutputLatencyCompensation
            ? this.getSmoothedOutputLatencyUs() / 1000000
            : 0;
        const syncDelaySec = this.syncDelayMs / 1000;
        const targetScheduledHorizonSec = this.getTargetScheduledHorizonSec();
        if (this.usesRecorrectionMonitor) {
            this.startRecorrectionMonitor();
        }
        if (this.pendingClockSourceCutover) {
            this.pendingClockSourceCutover = false;
            if (this.scheduledSources.length > 0 ||
                this.nextPlaybackTime !== 0 ||
                this.lastScheduledServerTime !== 0) {
                this.performGuardedCutover("delay-change", {
                    incrementResyncCount: false,
                    markCooldown: false,
                });
                return;
            }
        }
        // Schedule chunks until we have enough future audio to survive short JS throttling.
        while (this.audioBufferQueue.length > 0) {
            const scheduledAheadSec = this.getScheduledAheadSec(audioContextRawTimeSec);
            if (this.nextPlaybackTime > 0 &&
                scheduledAheadSec >= targetScheduledHorizonSec) {
                break;
            }
            const chunk = this.audioBufferQueue.shift();
            let playbackTime;
            let scheduleTime;
            let playbackRate;
            // Always compute the drift-corrected target time
            const targetPlaybackTime = this.computeTargetPlaybackTime(chunk.serverTime, audioContextTime, nowUs, outputLatencySec);
            // First chunk or after a gap: calculate from server timestamp
            if (this.nextPlaybackTime === 0 || this.lastScheduledServerTime === 0) {
                this.armHardResyncStartupGrace(nowMs);
                playbackTime = targetPlaybackTime;
                scheduleTime = playbackTime - syncDelaySec;
                if (this.recorrectionMinScheduleTimeSec !== null) {
                    scheduleTime = Math.max(scheduleTime, this.recorrectionMinScheduleTimeSec);
                    playbackTime = scheduleTime + syncDelaySec;
                }
                this.recorrectionMinScheduleTimeSec = null;
                playbackRate = 1.0;
                chunk.buffer = this.copyBuffer(chunk.buffer);
            }
            else {
                // Subsequent chunks: schedule back-to-back for seamless playback
                // Check if this chunk is contiguous with the last one
                const expectedServerTime = this.lastScheduledServerTime;
                const serverGapUs = chunk.serverTime - expectedServerTime;
                const serverGapSec = serverGapUs / 1000000;
                if (Math.abs(serverGapSec) < 0.1) {
                    // Chunk is contiguous (within 100ms)
                    // Calculate sync error (positive = behind target, negative = ahead)
                    const syncErrorSec = this.nextPlaybackTime - targetPlaybackTime;
                    const syncErrorMs = syncErrorSec * 1000;
                    // Apply EMA smoothing to filter jitter - use smoothed value for corrections
                    const correctionErrorMs = this.applySyncErrorEma(syncErrorMs);
                    // Get thresholds for current correction mode
                    const thresholds = CORRECTION_THRESHOLDS[this._correctionMode];
                    const canUseHardResync = this.canUseHardResync(nowMs);
                    if (Math.abs(correctionErrorMs) > thresholds.resyncAboveMs &&
                        canUseHardResync) {
                        // Tier 4: Hard resync if sync error exceeds threshold
                        this.noteHardResync(nowMs);
                        this.resyncCount++;
                        this._intervalResyncCount++;
                        this.resetSyncErrorEma();
                        this.cutScheduledSources(targetPlaybackTime - syncDelaySec);
                        playbackTime = targetPlaybackTime;
                        scheduleTime = playbackTime - syncDelaySec;
                        playbackRate = 1.0;
                        this.currentCorrectionMethod = "resync";
                        this.lastSamplesAdjusted = 0;
                        chunk.buffer = this.copyBuffer(chunk.buffer);
                    }
                    else if (Math.abs(correctionErrorMs) > thresholds.resyncAboveMs) {
                        // We cannot hard resync right now because startup grace or the
                        // cooldown is active, so use the strongest smooth correction instead.
                        playbackTime = this.nextPlaybackTime;
                        scheduleTime = this.nextScheduleTime;
                        playbackRate = Number.isFinite(thresholds.rate2AboveMs)
                            ? correctionErrorMs > 0
                                ? 1.02
                                : 0.98
                            : 1.0;
                        this.currentCorrectionMethod =
                            playbackRate === 1.0 ? "none" : "rate";
                        this.lastSamplesAdjusted = 0;
                        chunk.buffer = this.copyBuffer(chunk.buffer);
                    }
                    else if (Math.abs(correctionErrorMs) < thresholds.deadbandBelowMs) {
                        // Tier 1: Within deadband - no correction needed
                        playbackTime = this.nextPlaybackTime;
                        scheduleTime = this.nextScheduleTime;
                        playbackRate = 1.0;
                        this.currentCorrectionMethod = "none";
                        this.lastSamplesAdjusted = 0;
                        chunk.buffer = this.copyBuffer(chunk.buffer);
                    }
                    else if (Math.abs(correctionErrorMs) <= thresholds.samplesBelowMs) {
                        // Tier 2: Small error - use single sample insertion/deletion
                        playbackTime = this.nextPlaybackTime;
                        scheduleTime = this.nextScheduleTime;
                        playbackRate = 1.0;
                        const samplesToAdjust = correctionErrorMs > 0 ? -1 : 1;
                        chunk.buffer = this.adjustBufferSamples(chunk.buffer, samplesToAdjust);
                        this.currentCorrectionMethod = "samples";
                        this.lastSamplesAdjusted = samplesToAdjust;
                    }
                    else {
                        // Tier 3: Medium error - use playback rate adjustment
                        playbackTime = this.nextPlaybackTime;
                        scheduleTime = this.nextScheduleTime;
                        const absErrorMs = Math.abs(correctionErrorMs);
                        if (correctionErrorMs > 0) {
                            playbackRate =
                                absErrorMs >= thresholds.rate2AboveMs
                                    ? 1.02
                                    : absErrorMs >= thresholds.rate1AboveMs
                                        ? 1.01
                                        : 1.0;
                        }
                        else {
                            playbackRate =
                                absErrorMs >= thresholds.rate2AboveMs
                                    ? 0.98
                                    : absErrorMs >= thresholds.rate1AboveMs
                                        ? 0.99
                                        : 1.0;
                        }
                        this.currentCorrectionMethod =
                            playbackRate === 1.0 ? "none" : "rate";
                        this.lastSamplesAdjusted = 0;
                        chunk.buffer = this.copyBuffer(chunk.buffer);
                    }
                }
                else {
                    // Gap detected in server timestamps - hard resync
                    this.noteHardResync(nowMs);
                    this.resyncCount++;
                    this._intervalResyncCount++;
                    this.cutScheduledSources(targetPlaybackTime - syncDelaySec);
                    playbackTime = targetPlaybackTime;
                    scheduleTime = playbackTime - syncDelaySec;
                    playbackRate = 1.0;
                    this.currentCorrectionMethod = "resync";
                    this.lastSamplesAdjusted = 0;
                    chunk.buffer = this.copyBuffer(chunk.buffer);
                }
            }
            // Track current rate for debugging
            this.currentPlaybackRate = playbackRate;
            // Drop only if we already missed the logical playback time. Missing the
            // early-start window just means we apply less sync delay for this chunk.
            if (playbackTime < audioContextRawTimeSec) {
                // Reset seamless tracking since we dropped a chunk
                this.nextPlaybackTime = 0;
                this.nextScheduleTime = 0;
                this.lastScheduledServerTime = 0;
                continue;
            }
            const effectiveScheduleTime = Math.max(scheduleTime, audioContextRawTimeSec);
            const effectivePlaybackTime = effectiveScheduleTime + (playbackTime - scheduleTime);
            const source = this.audioContext.createBufferSource();
            source.buffer = chunk.buffer;
            source.playbackRate.value = playbackRate; // Apply rate correction
            source.connect(this.gainNode);
            source.start(effectiveScheduleTime);
            // Track for seamless scheduling of next chunk
            // Account for actual duration with playback rate adjustment
            const actualDuration = chunk.buffer.duration / playbackRate;
            this.nextPlaybackTime = effectivePlaybackTime + actualDuration;
            this.nextScheduleTime = effectiveScheduleTime + actualDuration;
            this.lastScheduledServerTime =
                chunk.serverTime + chunk.buffer.duration * 1000000;
            const scheduledEntry = {
                source,
                startTime: effectiveScheduleTime,
                endTime: effectiveScheduleTime + actualDuration,
                buffer: chunk.buffer,
                serverTime: chunk.serverTime,
                generation: chunk.generation,
            };
            this.scheduledSources.push(scheduledEntry);
            source.onended = () => {
                const idx = this.scheduledSources.indexOf(scheduledEntry);
                if (idx > -1)
                    this.scheduledSources.splice(idx, 1);
                if (this.scheduledSources.length === 0) {
                    this.resetScheduledPlaybackState("all scheduled audio ended");
                    if (this.audioBufferQueue.length > 0) {
                        this.processAudioQueue();
                    }
                }
            };
        }
        this.emitStatusLog(nowMs);
    }
    computeTargetPlaybackTime(serverTimeUs, audioContextTime, nowUs, outputLatencySec) {
        const chunkClientTimeUs = this.timeFilter.computeClientTime(serverTimeUs);
        const deltaUs = chunkClientTimeUs - nowUs;
        const deltaSec = deltaUs / 1000000;
        return (audioContextTime + deltaSec + SCHEDULE_HEADROOM_SEC - outputLatencySec);
    }
    // Start audio element playback (for MediaSession)
    startAudioElement() {
        if (this.outputMode === "media-element" && this.audioElement) {
            if (this.audioElement.paused) {
                this.audioElement.play().catch((e) => {
                    console.warn("Sendspin: Failed to start audio element:", e);
                });
            }
        }
        // No-op for direct mode
    }
    // Stop audio element playback (for MediaSession)
    stopAudioElement() {
        if (this.outputMode === "media-element" && this.audioElement) {
            if (!this.audioElement.paused) {
                this.audioElement.pause();
            }
        }
        // No-op for direct mode
    }
    // Clear all audio buffers and scheduled sources
    clearBuffers() {
        this.stopRecorrectionMonitor();
        // Stop all scheduled audio sources
        this.scheduledSources.forEach((entry) => {
            try {
                entry.source.stop();
            }
            catch (e) {
                // Ignore errors if source already stopped
            }
        });
        this.scheduledSources = [];
        // Clear buffers and reset scheduling state
        this.audioBufferQueue = [];
        if (this.scheduleTimeout !== null) {
            clearTimeout(this.scheduleTimeout);
            this.scheduleTimeout = null;
        }
        this.queueProcessScheduled = false;
        // Drop any pending native Opus decode outputs from the previous stream.
        // We close and recreate the decoder on next use to ensure stale callbacks
        // cannot be correlated with new-stream metadata.
        this.nativeDecoderQueue = [];
        try {
            this.webCodecsDecoder?.close();
        }
        catch {
            // Ignore close errors
        }
        this.webCodecsDecoder = null;
        this.webCodecsDecoderReady = null;
        this.webCodecsFormat = null;
        // Reset stream anchors
        this.stateManager.resetStreamAnchors();
        // Reset sync stats and timing sources
        this.resetScheduledPlaybackState();
        this.resyncCount = 0;
        this.lastRawOutputLatencyUs = 0;
        this.resetLatencySmoother();
        this.timingEstimateAudioContextTimeSec = null;
        this.timingEstimateAtMs = null;
        this.resetOutputTimestampValidation();
    }
    // Cleanup and close AudioContext
    close() {
        this.clearBuffers();
        if (this.audioContext) {
            this.audioContext.close();
            this.audioContext = null;
        }
        // Clean up native Opus decoder
        if (this.webCodecsDecoder) {
            try {
                this.webCodecsDecoder.close();
            }
            catch (e) {
                // Ignore if already closed
            }
            this.webCodecsDecoder = null;
            this.webCodecsDecoderReady = null;
            this.webCodecsFormat = null;
        }
        // Clean up fallback Opus decoder
        if (this.opusDecoder) {
            this.opusDecoder = null;
            this.opusDecoderModule = null;
            this.opusDecoderReady = null;
        }
        // Reset native Opus flag for next session
        this.useNativeOpus = true;
        this.gainNode = null;
        this.streamDestination = null;
        // Always stop and clear the audio element on full disconnect/teardown.
        if (this.outputMode === "media-element" && this.audioElement) {
            this.audioElement.pause();
            this.audioElement.srcObject = null;
            this.audioElement.loop = false;
            this.audioElement.removeAttribute("src");
            this.audioElement.load();
            if (this.ownsAudioElement) {
                this.audioElement.remove();
                this.audioElement = undefined;
            }
        }
    }
    // Get AudioContext for external use
    getAudioContext() {
        return this.audioContext;
    }
}

// Constants
const STATE_UPDATE_INTERVAL = 5000; // 5 seconds
const TIME_SYNC_BURST_SIZE = 8;
const TIME_SYNC_BURST_INTERVAL_MS = 10000;
const TIME_SYNC_REQUEST_TIMEOUT_MS = 2000;
const TIME_SYNC_ROBUST_SELECTION_COUNT = 3;
class ProtocolHandler {
    constructor(playerId, wsManager, audioProcessor, stateManager, timeFilter, config = {}) {
        this.playerId = playerId;
        this.wsManager = wsManager;
        this.audioProcessor = audioProcessor;
        this.stateManager = stateManager;
        this.timeFilter = timeFilter;
        this.timeSyncBurstActive = false;
        this.timeSyncBurstSentCount = 0;
        this.timeSyncInFlightClientTransmitted = null;
        this.timeSyncInFlightTimeout = null;
        this.timeSyncBurstSamples = [];
        this.clientName = config.clientName ?? "Sendspin Player";
        this.codecs = config.codecs ?? ["opus", "flac", "pcm"];
        this.bufferCapacity = config.bufferCapacity ?? 1024 * 1024 * 5; // 5MB default
        this.useHardwareVolume = config.useHardwareVolume ?? false;
        this.useOutputLatencyCompensation =
            config.useOutputLatencyCompensation ?? true;
        this.onVolumeCommand = config.onVolumeCommand;
        this.onDelayCommand = config.onDelayCommand;
        this.getExternalVolume = config.getExternalVolume;
    }
    // Handle WebSocket messages
    handleMessage(event) {
        if (typeof event.data === "string") {
            // JSON message
            const message = JSON.parse(event.data);
            this.handleServerMessage(message);
        }
        else if (event.data instanceof ArrayBuffer) {
            // Binary message (audio chunk)
            this.audioProcessor.handleBinaryMessage(event.data);
        }
        else if (event.data instanceof Blob) {
            // Convert Blob to ArrayBuffer
            event.data.arrayBuffer().then((buffer) => {
                this.audioProcessor.handleBinaryMessage(buffer);
            });
        }
    }
    // Handle server messages
    handleServerMessage(message) {
        switch (message.type) {
            case "server/hello":
                this.handleServerHello();
                break;
            case "server/time":
                this.handleServerTime(message);
                break;
            case "stream/start":
                this.handleStreamStart(message);
                break;
            case "stream/clear":
                this.handleStreamClear(message);
                break;
            case "stream/end":
                this.handleStreamEnd(message);
                break;
            case "server/command":
                this.handleServerCommand(message);
                break;
            case "server/state":
                this.stateManager.updateServerState(message.payload);
                break;
            case "group/update":
                this.stateManager.updateGroupState(message.payload);
                break;
        }
    }
    // Handle server hello
    handleServerHello() {
        console.log("Sendspin: Connected to server");
        // Per spec: Send initial client/state immediately after server/hello
        this.sendStateUpdate();
        // Start time synchronization with fixed bursts.
        this.stopTimeSync();
        this.startTimeSyncBurstIfIdle();
        this.scheduleNextTimeSyncBurstTick();
        // Start periodic state updates
        const stateInterval = window.setInterval(() => this.sendStateUpdate(), STATE_UPDATE_INTERVAL);
        this.stateManager.setStateUpdateInterval(stateInterval);
    }
    // Restart the periodic state update interval.
    // Called after volume commands to prevent a pending periodic update
    // from sending stale hardware volume shortly after the command response.
    restartStateUpdateInterval() {
        const newInterval = window.setInterval(() => this.sendStateUpdate(), STATE_UPDATE_INTERVAL);
        this.stateManager.setStateUpdateInterval(newInterval);
    }
    // Schedule the next fixed 10s burst tick.
    scheduleNextTimeSyncBurstTick() {
        const timeSyncTimeout = window.setTimeout(() => {
            this.startTimeSyncBurstIfIdle();
            this.scheduleNextTimeSyncBurstTick();
        }, TIME_SYNC_BURST_INTERVAL_MS);
        this.stateManager.setTimeSyncInterval(timeSyncTimeout);
    }
    startTimeSyncBurstIfIdle() {
        if (this.timeSyncBurstActive || !this.wsManager.isConnected()) {
            return;
        }
        this.timeSyncBurstActive = true;
        this.timeSyncBurstSentCount = 0;
        this.timeSyncBurstSamples = [];
        this.timeSyncInFlightClientTransmitted = null;
        this.sendNextTimeSyncBurstProbe();
    }
    sendNextTimeSyncBurstProbe() {
        if (!this.timeSyncBurstActive ||
            this.timeSyncInFlightClientTransmitted !== null ||
            !this.wsManager.isConnected()) {
            return;
        }
        if (this.timeSyncBurstSentCount >= TIME_SYNC_BURST_SIZE) {
            this.finalizeTimeSyncBurst();
            return;
        }
        const clientTransmitted = this.sendTimeSync();
        this.timeSyncBurstSentCount += 1;
        this.timeSyncInFlightClientTransmitted = clientTransmitted;
        this.armTimeSyncProbeTimeout(clientTransmitted);
    }
    armTimeSyncProbeTimeout(expectedClientTransmitted) {
        this.clearTimeSyncProbeTimeout();
        this.timeSyncInFlightTimeout = window.setTimeout(() => {
            this.handleTimeSyncProbeTimeout(expectedClientTransmitted);
        }, TIME_SYNC_REQUEST_TIMEOUT_MS);
    }
    clearTimeSyncProbeTimeout() {
        if (this.timeSyncInFlightTimeout !== null) {
            clearTimeout(this.timeSyncInFlightTimeout);
            this.timeSyncInFlightTimeout = null;
        }
    }
    handleTimeSyncProbeTimeout(expectedClientTransmitted) {
        if (!this.timeSyncBurstActive ||
            this.timeSyncInFlightClientTransmitted !== expectedClientTransmitted) {
            return;
        }
        console.warn("Sendspin: Time sync probe timed out, aborting current burst");
        this.abortTimeSyncBurst();
    }
    finalizeTimeSyncBurst() {
        this.clearTimeSyncProbeTimeout();
        const candidate = this.selectTimeSyncBurstCandidate();
        if (candidate) {
            this.timeFilter.update(candidate.measurement, candidate.maxError, candidate.t4);
        }
        this.timeSyncBurstActive = false;
        this.timeSyncBurstSentCount = 0;
        this.timeSyncInFlightClientTransmitted = null;
        this.timeSyncBurstSamples = [];
    }
    selectTimeSyncBurstCandidate() {
        if (this.timeSyncBurstSamples.length === 0) {
            return null;
        }
        const topRttSamples = [...this.timeSyncBurstSamples]
            .sort((a, b) => a.rttTerm - b.rttTerm)
            .slice(0, Math.min(TIME_SYNC_ROBUST_SELECTION_COUNT, this.timeSyncBurstSamples.length));
        const sortedByMeasurement = [...topRttSamples].sort((a, b) => a.measurement - b.measurement);
        return sortedByMeasurement[Math.floor(sortedByMeasurement.length / 2)];
    }
    abortTimeSyncBurst() {
        this.clearTimeSyncProbeTimeout();
        this.timeSyncBurstActive = false;
        this.timeSyncBurstSentCount = 0;
        this.timeSyncInFlightClientTransmitted = null;
        this.timeSyncBurstSamples = [];
    }
    stopTimeSync() {
        this.stateManager.clearTimeSyncInterval();
        this.abortTimeSyncBurst();
    }
    // Handle server time synchronization
    handleServerTime(message) {
        if (!this.timeSyncBurstActive ||
            this.timeSyncInFlightClientTransmitted === null) {
            return;
        }
        // Per spec: client_transmitted (T1), server_received (T2), server_transmitted (T3)
        const T1 = message.payload.client_transmitted;
        if (T1 !== this.timeSyncInFlightClientTransmitted) {
            console.warn("Sendspin: Ignoring out-of-order time response", T1, this.timeSyncInFlightClientTransmitted);
            return;
        }
        const T4 = Math.floor(performance.now() * 1000); // client received time
        const T2 = message.payload.server_received;
        const T3 = message.payload.server_transmitted;
        // NTP offset calculation: measurement = ((T2 - T1) + (T3 - T4)) / 2
        const measurement = (T2 - T1 + (T3 - T4)) / 2;
        // Max error (half of round-trip time): max_error = ((T4 - T1) - (T3 - T2)) / 2
        const rttTerm = Math.max(0, T4 - T1 - (T3 - T2));
        const maxError = Math.max(1000, rttTerm / 2);
        this.timeSyncBurstSamples.push({
            measurement,
            maxError,
            t4: T4,
            rttTerm,
        });
        this.clearTimeSyncProbeTimeout();
        this.timeSyncInFlightClientTransmitted = null;
        if (this.timeSyncBurstSentCount >= TIME_SYNC_BURST_SIZE) {
            this.finalizeTimeSyncBurst();
            return;
        }
        this.sendNextTimeSyncBurstProbe();
    }
    // Handle stream start (also used for format updates per new spec)
    handleStreamStart(message) {
        const isFormatUpdate = this.stateManager.currentStreamFormat !== null;
        this.stateManager.currentStreamFormat = message.payload.player;
        console.log(isFormatUpdate
            ? "Sendspin: Stream format updated"
            : "Sendspin: Stream started", this.stateManager.currentStreamFormat);
        console.log(`Sendspin: Codec=${this.stateManager.currentStreamFormat.codec.toUpperCase()}, ` +
            `SampleRate=${this.stateManager.currentStreamFormat.sample_rate}Hz, ` +
            `Channels=${this.stateManager.currentStreamFormat.channels}, ` +
            `BitDepth=${this.stateManager.currentStreamFormat.bit_depth}bit`);
        this.audioProcessor.initAudioContext();
        // Resume AudioContext if suspended (required for browser autoplay policies)
        this.audioProcessor.resumeAudioContext();
        if (!isFormatUpdate) {
            // New stream: reset scheduling state and clear buffers
            this.audioProcessor.clearBuffers();
        }
        // Format update: don't clear buffers (per new spec)
        this.stateManager.isPlaying = true;
        // Ensure audio element is playing for MediaSession
        this.audioProcessor.startAudioElement();
        // Explicitly set playbackState for Android (if mediaSession available)
        if (typeof navigator !== "undefined" && navigator.mediaSession) {
            navigator.mediaSession.playbackState = "playing";
        }
    }
    // Handle stream clear (for seek operations)
    handleStreamClear(message) {
        const roles = message.payload.roles;
        // If roles is undefined or includes 'player', clear player buffers
        if (!roles || roles.includes("player")) {
            console.log("Sendspin: Stream clear (seek)");
            this.audioProcessor.clearBuffers();
            // Note: Don't stop playing, don't clear format - just clear buffers
        }
    }
    // Handle stream end
    handleStreamEnd(message) {
        const roles = message.payload?.roles;
        // If roles is undefined or includes 'player', handle player stream end
        if (!roles || roles.includes("player")) {
            console.log("Sendspin: Stream ended");
            // Per spec: Stop playback and clear buffers
            this.audioProcessor.clearBuffers();
            // Clear format and reset state
            this.stateManager.currentStreamFormat = null;
            this.stateManager.isPlaying = false;
            // Stop audio element (except on Android where silent loop continues)
            this.audioProcessor.stopAudioElement();
            // Explicitly set playbackState (if mediaSession available)
            if (typeof navigator !== "undefined" && navigator.mediaSession) {
                navigator.mediaSession.playbackState = "paused";
            }
            // Send state update to server
            this.sendStateUpdate();
        }
    }
    // Handle server commands
    handleServerCommand(message) {
        const playerCommand = message.payload.player;
        if (!playerCommand)
            return;
        switch (playerCommand.command) {
            case "volume":
                // Set volume command
                if (playerCommand.volume !== undefined) {
                    this.stateManager.volume = playerCommand.volume;
                    this.audioProcessor.updateVolume();
                    // Notify external handler for hardware volume
                    if (this.useHardwareVolume && this.onVolumeCommand) {
                        this.onVolumeCommand(playerCommand.volume, this.stateManager.muted);
                    }
                }
                break;
            case "mute":
                // Mute/unmute command - uses boolean mute field
                if (playerCommand.mute !== undefined) {
                    this.stateManager.muted = playerCommand.mute;
                    this.audioProcessor.updateVolume();
                    // Notify external handler for hardware volume
                    if (this.useHardwareVolume && this.onVolumeCommand) {
                        this.onVolumeCommand(this.stateManager.volume, playerCommand.mute);
                    }
                }
                break;
            case "set_static_delay": {
                const delay = playerCommand.static_delay_ms;
                if (typeof delay === "number" && isFinite(delay)) {
                    const clamped = Math.max(0, Math.min(5000, Math.round(delay)));
                    this.audioProcessor.setSyncDelay(clamped);
                    this.onDelayCommand?.(clamped);
                }
                break;
            }
        }
        // Reset periodic timer first, then send state with commanded values.
        // Skip hardware read to avoid race where hardware hasn't applied the volume yet.
        this.restartStateUpdateInterval();
        this.sendStateUpdate(true);
    }
    // Send client hello with player identification
    sendClientHello() {
        const hello = {
            type: "client/hello",
            payload: {
                client_id: this.playerId,
                name: this.clientName,
                version: 1,
                supported_roles: ["player@v1", "controller@v1", "metadata@v1"],
                device_info: {
                    product_name: "Web Browser",
                    manufacturer: (typeof navigator !== "undefined" && navigator.vendor) || "Unknown",
                    software_version: (typeof navigator !== "undefined" && navigator.userAgent) ||
                        "Unknown",
                },
                "player@v1_support": {
                    supported_formats: this.getSupportedFormats(),
                    buffer_capacity: this.bufferCapacity,
                    supported_commands: ["volume", "mute"],
                },
            },
        };
        this.wsManager.send(hello);
    }
    // Get supported codecs for the current browser
    getBrowserSupportedCodecs() {
        const userAgent = typeof navigator !== "undefined" ? navigator.userAgent : "";
        const isSafari = /^((?!chrome|android).)*safari/i.test(userAgent);
        const isFirefox = /firefox/i.test(userAgent);
        // Check if native Opus decoder is available (requires secure context)
        const hasNativeOpus = typeof AudioDecoder !== "undefined";
        if (!hasNativeOpus) {
            if (typeof window !== "undefined" && !window.isSecureContext) {
                console.warn("[Opus] Running in insecure context, falling back to FLAC/PCM");
            }
            else {
                console.warn("[Opus] Native decoder not available, falling back to FLAC/PCM");
            }
        }
        if (isSafari) {
            // Safari: No FLAC support
            return new Set(["pcm", "opus"]);
        }
        if (isFirefox) {
            // Firefox: Opus has audio glitches with both native and opus-encdec decoders
            return new Set(["pcm", "flac"]);
        }
        if (hasNativeOpus) {
            // Native Opus available (Chrome, Edge)
            return new Set(["pcm", "opus", "flac"]);
        }
        // No WebCodecs AudioDecoder (insecure context or unsupported browser)
        return new Set(["pcm", "flac"]);
    }
    // Build supported formats from requested codecs, filtering out unsupported ones
    getSupportedFormats() {
        const browserSupported = this.getBrowserSupportedCodecs();
        const formats = [];
        for (const codec of this.codecs) {
            if (!browserSupported.has(codec)) {
                continue;
            }
            if (codec === "opus") {
                // Opus requires 48kHz
                formats.push({
                    codec: "opus",
                    sample_rate: 48000,
                    channels: 2,
                    bit_depth: 16,
                });
            }
            else {
                // PCM and FLAC support both sample rates
                formats.push({ codec, sample_rate: 48000, channels: 2, bit_depth: 16 });
                formats.push({ codec, sample_rate: 44100, channels: 2, bit_depth: 16 });
            }
        }
        if (formats.length === 0) {
            throw new Error(`No supported codecs: requested [${this.codecs.join(", ")}], ` +
                `browser supports [${[...browserSupported].join(", ")}]`);
        }
        return formats;
    }
    // Send time synchronization message
    sendTimeSync(clientTimeUs = Math.floor(performance.now() * 1000)) {
        const message = {
            type: "client/time",
            payload: {
                client_transmitted: clientTimeUs,
            },
        };
        this.wsManager.send(message);
        return clientTimeUs;
    }
    // Send state update
    // When skipHardwareRead is true, use stateManager values instead of reading from hardware.
    // This avoids race conditions when responding to volume commands.
    sendStateUpdate(skipHardwareRead = false) {
        let volume = this.stateManager.volume;
        let muted = this.stateManager.muted;
        if (!skipHardwareRead && this.useHardwareVolume && this.getExternalVolume) {
            const externalVol = this.getExternalVolume();
            volume = externalVol.volume;
            muted = externalVol.muted;
        }
        const syncDelayMs = this.audioProcessor.getSyncDelayMs();
        const staticDelayMs = Math.max(0, Math.min(5000, Math.round(syncDelayMs)));
        const message = {
            type: "client/state",
            payload: {
                player: {
                    state: this.stateManager.playerState,
                    volume,
                    muted,
                    static_delay_ms: staticDelayMs,
                    supported_commands: ["set_static_delay"],
                },
            },
        };
        this.wsManager.send(message);
    }
    // Send goodbye message before disconnecting
    sendGoodbye(reason) {
        this.wsManager.send({
            type: "client/goodbye",
            payload: {
                reason,
            },
        });
    }
    // Send controller command to server
    sendCommand(command, params) {
        this.wsManager.send({
            type: "client/command",
            payload: {
                controller: {
                    command,
                    ...params,
                },
            },
        });
    }
}

/**
 * Apply a diff to an object, returning a new copy.
 * - Fields from diff are merged into the copy
 * - null values delete the key from the result
 * - Nested objects are merged recursively (one level deep)
 */
function applyDiff(existing, diff) {
    const result = { ...existing };
    for (const key of Object.keys(diff)) {
        const value = diff[key];
        if (value === null) {
            delete result[key];
        }
        else if (value !== undefined) {
            // If both existing and new value are plain objects, merge recursively
            const existingValue = result[key];
            if (typeof value === "object" &&
                !Array.isArray(value) &&
                typeof existingValue === "object" &&
                existingValue !== null &&
                !Array.isArray(existingValue)) {
                result[key] = applyDiff(existingValue, value);
            }
            else {
                result[key] = value;
            }
        }
    }
    return result;
}
class StateManager {
    constructor(onStateChange) {
        this._volume = 100;
        this._muted = false;
        this._playerState = "synchronized";
        this._isPlaying = false;
        this._currentStreamFormat = null;
        this._streamStartServerTime = 0;
        this._streamStartAudioTime = 0;
        this._streamGeneration = 0;
        // Cached server state (from server/state messages)
        this._serverState = {};
        // Cached group state (from group/update messages)
        this._groupState = {};
        // Interval references for cleanup
        this.timeSyncInterval = null;
        this.stateUpdateInterval = null;
        this.onStateChangeCallback = onStateChange;
    }
    // Volume & Mute
    get volume() {
        return this._volume;
    }
    set volume(value) {
        this._volume = Math.max(0, Math.min(100, value));
        this.notifyStateChange();
    }
    get muted() {
        return this._muted;
    }
    set muted(value) {
        this._muted = value;
        this.notifyStateChange();
    }
    // Player State
    get playerState() {
        return this._playerState;
    }
    set playerState(value) {
        this._playerState = value;
        this.notifyStateChange();
    }
    // Playing State
    get isPlaying() {
        return this._isPlaying;
    }
    set isPlaying(value) {
        this._isPlaying = value;
        this.notifyStateChange();
    }
    // Stream Format
    get currentStreamFormat() {
        return this._currentStreamFormat;
    }
    set currentStreamFormat(value) {
        this._currentStreamFormat = value;
    }
    // Stream Anchoring (for timestamp-based scheduling)
    get streamStartServerTime() {
        return this._streamStartServerTime;
    }
    set streamStartServerTime(value) {
        this._streamStartServerTime = value;
    }
    get streamStartAudioTime() {
        return this._streamStartAudioTime;
    }
    set streamStartAudioTime(value) {
        this._streamStartAudioTime = value;
    }
    // Reset stream anchors (called on stream start)
    resetStreamAnchors() {
        this._streamStartServerTime = 0;
        this._streamStartAudioTime = 0;
        this._streamGeneration++;
    }
    // Get current stream generation
    get streamGeneration() {
        return this._streamGeneration;
    }
    // Interval management
    setTimeSyncInterval(interval) {
        this.clearTimeSyncInterval();
        this.timeSyncInterval = interval;
    }
    clearTimeSyncInterval() {
        if (this.timeSyncInterval !== null) {
            clearTimeout(this.timeSyncInterval);
            this.timeSyncInterval = null;
        }
    }
    setStateUpdateInterval(interval) {
        this.clearStateUpdateInterval();
        this.stateUpdateInterval = interval;
    }
    clearStateUpdateInterval() {
        if (this.stateUpdateInterval !== null) {
            clearInterval(this.stateUpdateInterval);
            this.stateUpdateInterval = null;
        }
    }
    clearAllIntervals() {
        this.clearTimeSyncInterval();
        this.clearStateUpdateInterval();
    }
    // Reset all state (called on disconnect)
    reset() {
        this._volume = 100;
        this._muted = false;
        this._playerState = "synchronized";
        this._isPlaying = false;
        this._currentStreamFormat = null;
        this._streamStartServerTime = 0;
        this._streamStartAudioTime = 0;
        this._serverState = {};
        this._groupState = {};
        this.clearAllIntervals();
    }
    // Notify callback of state changes
    notifyStateChange() {
        if (this.onStateChangeCallback) {
            this.onStateChangeCallback({
                isPlaying: this._isPlaying,
                volume: this._volume,
                muted: this._muted,
                playerState: this._playerState,
                serverState: this._serverState,
                groupState: this._groupState,
            });
        }
    }
    // Update server state (merges delta, null clears fields)
    updateServerState(update) {
        this._serverState = applyDiff(this._serverState, update);
        this.notifyStateChange();
    }
    // Update group state (merges delta, null clears fields)
    updateGroupState(update) {
        this._groupState = applyDiff(this._groupState, update);
        this.notifyStateChange();
    }
    // Getters for cached state
    get serverState() {
        return this._serverState;
    }
    get groupState() {
        return this._groupState;
    }
}

class WebSocketManager {
    constructor() {
        this.ws = null;
        this.reconnectTimeout = null;
        this.shouldReconnect = false;
    }
    // Connect to WebSocket server
    async connect(url, onOpen, onMessage, onError, onClose) {
        // Store handlers
        this.onOpenHandler = onOpen;
        this.onMessageHandler = onMessage;
        this.onErrorHandler = onError;
        this.onCloseHandler = onClose;
        // Disconnect if already connected
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        return new Promise((resolve, reject) => {
            try {
                console.log("Sendspin: Connecting to", url);
                this.ws = new WebSocket(url);
                this.ws.binaryType = "arraybuffer";
                this.shouldReconnect = true;
                this.ws.onopen = () => {
                    console.log("Sendspin: WebSocket connected");
                    if (this.onOpenHandler) {
                        this.onOpenHandler();
                    }
                    resolve();
                };
                this.ws.onmessage = (event) => {
                    if (this.onMessageHandler) {
                        this.onMessageHandler(event);
                    }
                };
                this.ws.onerror = (error) => {
                    console.error("Sendspin: WebSocket error", error);
                    if (this.onErrorHandler) {
                        this.onErrorHandler(error);
                    }
                    reject(error);
                };
                this.ws.onclose = () => {
                    console.log("Sendspin: WebSocket disconnected");
                    if (this.onCloseHandler) {
                        this.onCloseHandler();
                    }
                    // Try to reconnect after a delay if we should reconnect
                    if (this.shouldReconnect) {
                        this.scheduleReconnect(url);
                    }
                };
            }
            catch (error) {
                console.error("Sendspin: Failed to connect", error);
                reject(error);
            }
        });
    }
    // Schedule reconnection attempt
    scheduleReconnect(url) {
        if (this.reconnectTimeout !== null) {
            clearTimeout(this.reconnectTimeout);
        }
        this.reconnectTimeout = window.setTimeout(() => {
            if (this.shouldReconnect) {
                console.log("Sendspin: Attempting to reconnect...");
                this.connect(url, this.onOpenHandler, this.onMessageHandler, this.onErrorHandler, this.onCloseHandler).catch((error) => {
                    console.error("Sendspin: Reconnection failed", error);
                });
            }
        }, 5000);
    }
    // Disconnect from WebSocket server
    disconnect() {
        this.shouldReconnect = false;
        if (this.reconnectTimeout !== null) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = null;
        }
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
    }
    // Send message to server (JSON)
    send(message) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(message));
        }
        else {
            console.warn("Sendspin: Cannot send message, WebSocket not connected");
        }
    }
    // Check if WebSocket is connected
    isConnected() {
        return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
    }
    // Get current ready state
    getReadyState() {
        return this.ws ? this.ws.readyState : WebSocket.CLOSED;
    }
}

/**
 * Two-dimensional Kalman filter for NTP-style time synchronization.
 *
 * This class implements a time synchronization filter that tracks both the timestamp
 * offset and clock drift rate between a client and server. It processes measurements
 * obtained with NTP-style time messages that contain round-trip timing information to
 * optimally estimate the time relationship while accounting for network latency
 * uncertainty.
 *
 * The filter maintains a 2D state vector [offset, drift] with associated covariance
 * matrix to track estimation uncertainty. An adaptive forgetting factor helps the
 * filter recover quickly from network disruptions or server clock adjustments.
 *
 * Direct port of the Python implementation from aiosendspin.
 */
// Residual threshold as fraction of max_error for triggering adaptive forgetting.
// When residual > CUTOFF * max_error, the filter applies forgetting to recover from outliers.
const ADAPTIVE_FORGETTING_CUTOFF = 2.0;
class SendspinTimeFilter {
    constructor(offset_process_std_dev = 0.01, forget_factor = 1.1, drift_significance_threshold = 2.0, drift_process_std_dev = 0.0) {
        this._last_update = 0;
        this._count = 0;
        this._offset = 0.0;
        this._drift = 0.0;
        this._offset_covariance = Infinity;
        this._offset_drift_covariance = 0.0;
        this._drift_covariance = 0.0;
        this._use_drift = false;
        this._offset_process_variance =
            offset_process_std_dev * offset_process_std_dev;
        this._drift_process_variance =
            drift_process_std_dev * drift_process_std_dev;
        this._forget_variance_factor = forget_factor * forget_factor;
        this._drift_significance_threshold_squared =
            drift_significance_threshold * drift_significance_threshold;
        this._current_time_element = this._createDefaultTimeElement();
    }
    /**
     * Create a default TimeElement with zero values.
     * Single source of truth for default initialization.
     */
    _createDefaultTimeElement() {
        return {
            last_update: 0,
            offset: 0.0,
            drift: 0.0,
        };
    }
    /**
     * Process a new time synchronization measurement through the Kalman filter.
     *
     * Updates the filter's offset and drift estimates using a two-stage Kalman filter
     * algorithm: predict based on the drift model then correct using the new
     * measurement. The measurement uncertainty is derived from the network round-trip
     * delay.
     *
     * @param measurement - Computed offset from NTP-style exchange: ((T2-T1)+(T3-T4))/2 in microseconds
     * @param max_error - Half the round-trip delay: ((T4-T1)-(T3-T2))/2, representing maximum measurement uncertainty in microseconds
     * @param time_added - Client timestamp when this measurement was taken in microseconds
     */
    update(measurement, max_error, time_added) {
        if (time_added === this._last_update) {
            // Skip duplicate timestamps to avoid division by zero in drift calculation
            return;
        }
        const dt = time_added - this._last_update;
        this._last_update = time_added;
        const update_std_dev = max_error;
        const measurement_variance = update_std_dev * update_std_dev;
        // Filter initialization: First measurement establishes offset baseline
        if (this._count <= 0) {
            this._count += 1;
            this._offset = measurement;
            this._offset_covariance = measurement_variance;
            this._drift = 0.0; // No drift information available yet
            this._current_time_element = {
                last_update: this._last_update,
                offset: this._offset,
                drift: this._drift,
            };
            this._use_drift = false;
            return;
        }
        // Second measurement: Initial drift estimation from finite differences
        if (this._count === 1) {
            this._count += 1;
            this._drift = (measurement - this._offset) / dt;
            this._offset = measurement;
            // Drift variance estimated from propagation of offset uncertainties
            this._drift_covariance =
                (this._offset_covariance + measurement_variance) / (dt * dt);
            this._offset_covariance = measurement_variance;
            this._current_time_element = {
                last_update: this._last_update,
                offset: this._offset,
                drift: this._drift,
            };
            this._use_drift = false;
            return;
        }
        /// Kalman Prediction Step ///
        // State prediction: x_k|k-1 = F * x_k-1|k-1
        const offset = this._offset + this._drift * dt;
        // Covariance prediction: P_k|k-1 = F * P_k-1|k-1 * F^T + Q
        // State transition matrix F = [1, dt; 0, 1]
        const dt_squared = dt * dt;
        // Process noise models uncertainty growth in both offset and drift random walks.
        const drift_process_variance = dt * this._drift_process_variance;
        let new_drift_covariance = this._drift_covariance + drift_process_variance;
        const offset_drift_process_variance = 0.0;
        let new_offset_drift_covariance = this._offset_drift_covariance +
            this._drift_covariance * dt +
            offset_drift_process_variance;
        const offset_process_variance = dt * this._offset_process_variance;
        let new_offset_covariance = this._offset_covariance +
            2 * this._offset_drift_covariance * dt +
            this._drift_covariance * dt_squared +
            offset_process_variance;
        /// Innovation and Adaptive Forgetting ///
        const residual = measurement - offset; // Innovation: y_k = z_k - H * x_k|k-1
        const max_residual_cutoff = max_error * ADAPTIVE_FORGETTING_CUTOFF;
        if (this._count < 100) {
            // Build sufficient history before enabling adaptive forgetting
            this._count += 1;
        }
        else if (Math.abs(residual) > max_residual_cutoff) {
            // Large prediction error detected - likely network disruption or clock adjustment
            // Apply forgetting factor to increase Kalman gain and accelerate convergence
            new_drift_covariance *= this._forget_variance_factor;
            new_offset_drift_covariance *= this._forget_variance_factor;
            new_offset_covariance *= this._forget_variance_factor;
        }
        /// Kalman Update Step ///
        // Innovation covariance: S = H * P * H^T + R, where H = [1, 0]
        const uncertainty = 1.0 / (new_offset_covariance + measurement_variance);
        // Kalman gain: K = P * H^T * S^(-1)
        const offset_gain = new_offset_covariance * uncertainty;
        const drift_gain = new_offset_drift_covariance * uncertainty;
        // State update: x_k|k = x_k|k-1 + K * y_k
        this._offset = offset + offset_gain * residual;
        this._drift += drift_gain * residual;
        // Covariance update: P_k|k = (I - K*H) * P_k|k-1
        // Using simplified form to ensure numerical stability
        this._drift_covariance =
            new_drift_covariance - drift_gain * new_offset_drift_covariance;
        this._offset_drift_covariance =
            new_offset_drift_covariance - drift_gain * new_offset_covariance;
        this._offset_covariance =
            new_offset_covariance - offset_gain * new_offset_covariance;
        // Drift compensation is enabled only when the estimate is statistically significant.
        const drift_squared = this._drift * this._drift;
        this._use_drift =
            drift_squared >
                this._drift_significance_threshold_squared * this._drift_covariance;
        this._current_time_element = {
            last_update: this._last_update,
            offset: this._offset,
            drift: this._drift,
        };
    }
    /**
     * Convert a client timestamp to the equivalent server timestamp.
     *
     * Applies the current offset and drift compensation to transform from client time
     * domain to server time domain. The transformation accounts for both static offset
     * and dynamic drift accumulated since the last filter update.
     *
     * @param client_time - Client timestamp in microseconds
     * @returns Equivalent server timestamp in microseconds
     */
    computeServerTime(client_time) {
        // Transform: T_server = T_client + offset + drift * (T_client - T_last_update)
        // Compute instantaneous offset accounting for linear drift:
        // offset(t) = offset_base + drift * (t - t_last_update)
        const dt = client_time - this._current_time_element.last_update;
        const effective_drift = this._use_drift
            ? this._current_time_element.drift
            : 0.0;
        const offset = Math.round(this._current_time_element.offset + effective_drift * dt);
        return client_time + offset;
    }
    /**
     * Convert a server timestamp to the equivalent client timestamp.
     *
     * Inverts the time transformation to convert from server time domain to client
     * time domain. Accounts for both offset and drift effects in the inverse
     * transformation.
     *
     * @param server_time - Server timestamp in microseconds
     * @returns Equivalent client timestamp in microseconds
     */
    computeClientTime(server_time) {
        // Inverse transform solving for T_client:
        // T_server = T_client + offset + drift * (T_client - T_last_update)
        // T_server = (1 + drift) * T_client + offset - drift * T_last_update
        // T_client = (T_server - offset + drift * T_last_update) / (1 + drift)
        const effective_drift = this._use_drift
            ? this._current_time_element.drift
            : 0.0;
        return Math.round((server_time -
            this._current_time_element.offset +
            effective_drift * this._current_time_element.last_update) /
            (1.0 + effective_drift));
    }
    /**
     * Reset the filter state.
     */
    reset() {
        this._count = 0;
        this._offset = 0.0;
        this._drift = 0.0;
        this._offset_covariance = Infinity;
        this._offset_drift_covariance = 0.0;
        this._drift_covariance = 0.0;
        this._use_drift = false;
        this._current_time_element = this._createDefaultTimeElement();
    }
    /**
     * Get the number of time sync measurements processed.
     */
    get count() {
        return this._count;
    }
    /**
     * Check if time synchronization is ready for use.
     *
     * Time sync is considered ready when at least 1 measurement has been
     * collected and the offset covariance is finite (not infinite).
     */
    get is_synchronized() {
        return this._count >= 1 && isFinite(this._offset_covariance);
    }
    /**
     * Get the standard deviation estimate in microseconds.
     */
    get error() {
        return Math.round(Math.sqrt(this._offset_covariance));
    }
    /**
     * Get the covariance (variance) estimate for the offset.
     */
    get covariance() {
        return Math.round(this._offset_covariance);
    }
    /**
     * Get the current filtered offset estimate in microseconds.
     */
    get offset() {
        return this._offset;
    }
    /**
     * Get the current clock drift rate estimate.
     * Returns the drift as a ratio (e.g., 0.04 means server clock is 4% faster).
     */
    get drift() {
        return this._drift;
    }
}

// Auto-generated by scripts/bundle-silent-audio.js
// Almost-silent audio for Android MediaSession workaround
const SILENT_AUDIO_SRC = "data:audio/flac;base64,ZkxhQwAAACICQAJAAAAMAADIAfQBcAAHkwCKnZ7FLvzY30lWx+3k6wJCBAAALAwAAABMYXZmNjEuNy4xMDABAAAAFAAAAGVuY29kZXI9TGF2ZjYxLjcuMTAwgQAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA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kkkkkkmSSSSSTJJJJJMkkkkySSSTJJJJMkkkk/+/+//f/7//9////////////z///z//8///P//n//+SSSSSSSSSSSSQkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkmSSSSSSSSSSSSSSST////+BVP//gkDBPnQAAAAOc/VEAP/////9//////////////////z////////+f/////////////////////////////////3///////////////////////////gAhn//gkDBTyQP///+c/y0Af/////5//////////////////////////////////v/////////////////////////////////P////////////////////+T8L/+CQMFfVAAAAA5z9xQB////////////3//////////////////////////////////+f///////////////////////////////////////////////gm0f/4JAwW/EAAAADnP9JAH///////7///////////////////////////////////////////////n///////////////////////////////////////+BEl//gkDBf7AAAAABAL//gkDBjWAAAAADVc//gkDBnRAAAAAEw0//gkDBrYAAAAAMeM//gkDBvfAAAAAL7k//gkDBzKAAAAAFD5//gkDB3NAAAAACmR//gkDB7EAAAAAKIp//gkDB/DAAAAANtB//gkDCB+AAAAAMWl//gkDCF5AAAAALzN//gkDCJwAAAAADd1//gkDCN3AAAAAE4d//gkDCRiAAAAAKAA//gkDCVlAAAAANlo//gkDCZsAAAAAFLQ//gkDCdrAAAAACu4//gkDChGAAAAAA7v//gkDClBAAAAAHeH//gkDCpIAAAAAPw///gkDCtPAAAAAIVX//gkDCxaAAAAAGtK//gkDC1dAAAAABIi//gkDC5UAAAAAJma//gkDC9TAAAAAODy//gkDDAOAAAAANM0//gkDDEJAAAAAKpc//gkDDIAAAAAACHk//gkDDMHAAAAAFiM//gkDDQSAAAAALaR//gkDDUVAAAAAM/5//gkDDYcAAAAAERB//gkDDcbAAAAAD0p//gkDDg2AAAAABh+//gkDDkxAAAAAGEW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";

// Sendspin Protocol Types and Interfaces
var MessageType;
(function (MessageType) {
    MessageType["CLIENT_HELLO"] = "client/hello";
    MessageType["SERVER_HELLO"] = "server/hello";
    MessageType["CLIENT_TIME"] = "client/time";
    MessageType["SERVER_TIME"] = "server/time";
    MessageType["CLIENT_STATE"] = "client/state";
    MessageType["SERVER_STATE"] = "server/state";
    MessageType["CLIENT_COMMAND"] = "client/command";
    MessageType["CLIENT_GOODBYE"] = "client/goodbye";
    MessageType["SERVER_COMMAND"] = "server/command";
    MessageType["STREAM_START"] = "stream/start";
    MessageType["STREAM_CLEAR"] = "stream/clear";
    MessageType["STREAM_REQUEST_FORMAT"] = "stream/request-format";
    MessageType["STREAM_END"] = "stream/end";
    MessageType["GROUP_UPDATE"] = "group/update";
})(MessageType || (MessageType = {}));

// Platform detection utilities
function detectIsAndroid() {
    if (typeof navigator === "undefined")
        return false;
    return /Android/i.test(navigator.userAgent);
}
function detectIsIOS() {
    if (typeof navigator === "undefined")
        return false;
    return (/iPad|iPhone|iPod/.test(navigator.userAgent) ||
        (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));
}
function detectIsMobile() {
    return detectIsAndroid() || detectIsIOS();
}
function detectIsSafari() {
    if (typeof navigator === "undefined")
        return false;
    const ua = navigator.userAgent;
    return /Safari/i.test(ua) && !/Chrome/i.test(ua);
}
function detectIsMac() {
    if (typeof navigator === "undefined")
        return false;
    return /Macintosh/i.test(navigator.userAgent);
}
function detectIsWindows() {
    if (typeof navigator === "undefined")
        return false;
    return /Windows/i.test(navigator.userAgent);
}
/**
 * Get platform-specific default static delay in milliseconds.
 * Based on testing across various platforms and browsers.
 */
function getDefaultSyncDelay() {
    if (detectIsIOS())
        return 250;
    if (detectIsAndroid())
        return 200;
    if (detectIsMac())
        return detectIsSafari() ? 190 : 150;
    if (detectIsWindows())
        return 250;
    // Linux and others
    return 200;
}
function generateRandomId() {
    return Math.random().toString(36).substring(2, 6);
}
class SendspinPlayer {
    constructor(config) {
        this.wsUrl = "";
        this.ownsAudioElement = false;
        // Apply defaults for playerId and clientName (share same random ID)
        const randomId = generateRandomId();
        const playerId = config.playerId ?? `sendspin-js-${randomId}`;
        const clientName = config.clientName ?? `Sendspin JS Client (${randomId})`;
        // Auto-detect platform
        const isAndroid = detectIsAndroid();
        const isMobile = detectIsMobile();
        // Determine output mode:
        // - If audioElement provided, use media-element
        // - If mobile (iOS/Android), default to media-element
        // - Otherwise, use direct
        const outputMode = config.audioElement || isMobile ? "media-element" : "direct";
        this.ownsAudioElement =
            outputMode === "media-element" && !config.audioElement;
        if (this.ownsAudioElement && typeof document === "undefined") {
            throw new Error("SendspinPlayer requires a DOM document to use media-element output without a provided audioElement.");
        }
        // Store config with resolved defaults
        this.config = {
            ...config,
            playerId,
            clientName,
        };
        // Initialize time filter (shared between audio processor and protocol handler)
        this.timeFilter = new SendspinTimeFilter(0, 1.1, 2.0, 1e-12);
        // Initialize state manager with callback
        this.stateManager = new StateManager(config.onStateChange);
        // Initialize audio processor
        let storage = null;
        if (config.storage !== undefined) {
            storage = config.storage;
        }
        else if (typeof localStorage !== "undefined") {
            storage = localStorage;
        }
        this.audioProcessor = new AudioProcessor(this.stateManager, this.timeFilter, outputMode, config.audioElement, isAndroid, this.ownsAudioElement, isAndroid ? SILENT_AUDIO_SRC : undefined, config.syncDelay ?? getDefaultSyncDelay(), config.useHardwareVolume ?? false, config.correctionMode ?? "sync", storage, config.useOutputLatencyCompensation ?? true);
        // Initialize WebSocket manager
        this.wsManager = new WebSocketManager();
        // Initialize protocol handler
        this.protocolHandler = new ProtocolHandler(playerId, this.wsManager, this.audioProcessor, this.stateManager, this.timeFilter, {
            clientName,
            codecs: config.codecs,
            bufferCapacity: config.bufferCapacity,
            useHardwareVolume: config.useHardwareVolume,
            onVolumeCommand: config.onVolumeCommand,
            onDelayCommand: config.onDelayCommand,
            getExternalVolume: config.getExternalVolume,
            useOutputLatencyCompensation: config.useOutputLatencyCompensation,
        });
    }
    // Connect to Sendspin server
    async connect() {
        // Build WebSocket URL
        const url = new URL(this.config.baseUrl);
        const wsProtocol = url.protocol === "https:" ? "wss:" : "ws:";
        this.wsUrl = `${wsProtocol}//${url.host}/sendspin`;
        // Connect to WebSocket
        await this.wsManager.connect(this.wsUrl, 
        // onOpen
        () => {
            console.log("Sendspin: Using player_id:", this.config.playerId);
            this.protocolHandler.sendClientHello();
        }, 
        // onMessage
        (event) => {
            this.protocolHandler.handleMessage(event);
        }, 
        // onError
        (error) => {
            console.error("Sendspin: WebSocket error", error);
        }, 
        // onClose
        () => {
            this.protocolHandler.stopTimeSync();
            console.log("Sendspin: Connection closed");
        });
    }
    /**
     * Disconnect from Sendspin server
     * @param reason - Optional reason for disconnecting (default: 'shutdown')
     *   - 'another_server': Switching to a different Sendspin server
     *   - 'shutdown': Client is shutting down
     *   - 'restart': Client is restarting and will reconnect
     *   - 'user_request': User explicitly requested to disconnect
     */
    disconnect(reason = "shutdown") {
        // Send goodbye message if connected
        if (this.wsManager.isConnected()) {
            this.protocolHandler.sendGoodbye(reason);
        }
        // Stop time sync burst scheduler and in-flight timeout state
        this.protocolHandler.stopTimeSync();
        // Clear intervals
        this.stateManager.clearAllIntervals();
        // Disconnect WebSocket
        this.wsManager.disconnect();
        // Close audio processor
        this.audioProcessor.close();
        // Reset time filter
        this.timeFilter.reset();
        // Reset state
        this.stateManager.reset();
        // Reset MediaSession playbackState (if available)
        if (typeof navigator !== "undefined" && navigator.mediaSession) {
            navigator.mediaSession.playbackState = "none";
            navigator.mediaSession.metadata = null;
        }
    }
    // Set volume (0-100)
    setVolume(volume) {
        this.stateManager.volume = volume;
        this.audioProcessor.updateVolume();
        this.protocolHandler.sendStateUpdate();
    }
    // Set muted state
    setMuted(muted) {
        this.stateManager.muted = muted;
        this.audioProcessor.updateVolume();
        this.protocolHandler.sendStateUpdate();
    }
    // Set static delay (in milliseconds, 0-5000). Positive values schedule playback earlier.
    setSyncDelay(delayMs) {
        this.audioProcessor.setSyncDelay(delayMs);
        this.protocolHandler.sendStateUpdate();
    }
    /**
     * Set the sync correction mode at runtime.
     * @param mode - The correction mode to use:
     *   - "sync": Multi-device sync, may use pitch-changing playback-rate adjustments for faster convergence.
     *   - "quality": No playback-rate changes; uses sample fixes and tighter resyncs, so expect fewer adjustments but occasional jumps. Starts out of sync until the clock converges. Not recommended for bad networks.
     *   - "quality-local": Avoids playback-rate changes; may drift vs. other players and only resyncs
     *     as a last resort.
     */
    setCorrectionMode(mode) {
        this.audioProcessor.setCorrectionMode(mode);
    }
    // ========================================
    // Controller Commands (sent to server)
    // ========================================
    /**
     * Send a controller command to the server.
     * Use this for playback control when the server manages the audio source.
     *
     * @throws Error if the command is not supported by the server
     *
     * @example
     * // Simple commands (no parameters)
     * player.sendCommand('play');
     * player.sendCommand('pause');
     * player.sendCommand('next');
     * player.sendCommand('previous');
     * player.sendCommand('stop');
     * player.sendCommand('shuffle');
     * player.sendCommand('unshuffle');
     * player.sendCommand('repeat_off');
     * player.sendCommand('repeat_one');
     * player.sendCommand('repeat_all');
     * player.sendCommand('switch');
     *
     * // Commands with required parameters
     * player.sendCommand('volume', { volume: 50 });
     * player.sendCommand('mute', { mute: true });
     */
    sendCommand(command, params) {
        const supportedCommands = this.stateManager.serverState.controller?.supported_commands;
        if (supportedCommands && !supportedCommands.includes(command)) {
            throw new Error(`Command '${command}' is not supported by the server. ` +
                `Supported commands: ${supportedCommands.join(", ")}`);
        }
        this.protocolHandler.sendCommand(command, params);
    }
    // Getters for reactive state
    get isPlaying() {
        return this.stateManager.isPlaying;
    }
    get volume() {
        return this.stateManager.volume;
    }
    get muted() {
        return this.stateManager.muted;
    }
    get playerState() {
        return this.stateManager.playerState;
    }
    get currentFormat() {
        return this.stateManager.currentStreamFormat;
    }
    get isConnected() {
        return this.wsManager.isConnected();
    }
    // Get current correction mode
    get correctionMode() {
        return this.audioProcessor.correctionMode;
    }
    // Time sync info for debugging
    get timeSyncInfo() {
        return {
            synced: this.timeFilter.is_synchronized,
            offset: Math.round(this.timeFilter.offset / 1000), // ms
            error: Math.round(this.timeFilter.error / 1000), // ms
        };
    }
    /** Get current server time in microseconds using synchronized clock */
    getCurrentServerTimeUs() {
        return this.timeFilter.computeServerTime(Math.floor(performance.now() * 1000));
    }
    /** Get current track progress with real-time position calculation */
    get trackProgress() {
        const metadata = this.stateManager.serverState.metadata;
        if (!metadata?.progress || metadata.timestamp === undefined) {
            return null;
        }
        const serverTimeUs = this.getCurrentServerTimeUs();
        const elapsedUs = serverTimeUs - metadata.timestamp;
        // playback_speed is multiplied by 1000 in protocol (1000 = normal speed)
        const positionMs = metadata.progress.track_progress +
            (elapsedUs * metadata.progress.playback_speed) / 1000000;
        return {
            positionMs: Math.max(0, Math.min(positionMs, metadata.progress.track_duration)),
            durationMs: metadata.progress.track_duration,
            // Normalize to float (1.0 = normal speed)
            playbackSpeed: metadata.progress.playback_speed / 1000,
        };
    }
    // Sync info for debugging/display
    get syncInfo() {
        return this.audioProcessor.syncInfo;
    }
}

var commonjsGlobal = typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : typeof global !== 'undefined' ? global : typeof self !== 'undefined' ? self : {};

function getDefaultExportFromCjs (x) {
	return x && x.__esModule && Object.prototype.hasOwnProperty.call(x, 'default') ? x['default'] : x;
}

function commonjsRequire(path) {
	throw new Error('Could not dynamically require "' + path + '". Please configure the dynamicRequireTargets or/and ignoreDynamicRequires option of @rollup/plugin-commonjs appropriately for this require call to work.');
}

var libopusDecoder$3 = {exports: {}};

var libopusDecoder$2 = libopusDecoder$3.exports;

var hasRequiredLibopusDecoder;

function requireLibopusDecoder () {
	if (hasRequiredLibopusDecoder) return libopusDecoder$3.exports;
	hasRequiredLibopusDecoder = 1;
	(function (module) {

		// --pre-jses are emitted after the Module integration code, so that they can
		// refer to Module (if they choose; they can also define Module)

		(function (root, factory, globalExport) {

			var lib, env;
			if (module.exports) {
				// Node. Does not work with strict CommonJS, but
				// only CommonJS-like environments that support module.exports,
				// like Node.

				// use process.env (if available) for reading Opus environment settings:
				env = typeof process !== 'undefined' && process && process.env? process.env : root;
				lib = factory(env, commonjsRequire);
				module.exports = lib;
			} else {
				// Browser globals
				lib = factory(root);
				root[globalExport] = lib;
			}

		}(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : typeof commonjsGlobal !== 'undefined' ? commonjsGlobal : libopusDecoder$2, function (global, require) {

		var Module = {};
		Module['isReady'] = false;
		Module['onready'] = null;
		Module['onRuntimeInitialized'] = function(){
			Module['isReady'] = true;
			if(Module['onready']) setTimeout(Module['onready'], 0);
		};

		if(global && global.OPUS_SCRIPT_LOCATION){
			Module['locateFile'] = function(fileName){
				var path = global.OPUS_SCRIPT_LOCATION || '';
				if(path[fileName]) return path[fileName];
				path += path && !/\/$/.test(path)? '/' : '';
				return path + fileName;
			};
		}



		// Sometimes an existing Module object exists with properties
		// meant to overwrite the default module functionality. Here
		// we collect those properties and reapply _after_ we configure
		// the current environment's defaults to avoid having to be so
		// defensive during initialization.
		var moduleOverrides = {};
		var key;
		for (key in Module) {
		  if (Module.hasOwnProperty(key)) {
		    moduleOverrides[key] = Module[key];
		  }
		}

		// Determine the runtime environment we are in. You can customize this by
		// setting the ENVIRONMENT setting at compile time (see settings.js).

		var ENVIRONMENT_IS_WEB = false;
		var ENVIRONMENT_IS_WORKER = false;
		var ENVIRONMENT_IS_NODE = false;
		var ENVIRONMENT_IS_SHELL = false;
		ENVIRONMENT_IS_WEB = typeof window === 'object';
		ENVIRONMENT_IS_WORKER = typeof importScripts === 'function';
		// N.b. Electron.js environment is simultaneously a NODE-environment, but
		// also a web environment.
		ENVIRONMENT_IS_NODE = typeof process === 'object' && typeof process.versions === 'object' && typeof process.versions.node === 'string';
		ENVIRONMENT_IS_SHELL = !ENVIRONMENT_IS_WEB && !ENVIRONMENT_IS_NODE && !ENVIRONMENT_IS_WORKER;

		// `/` should be present at the end if `scriptDirectory` is not empty
		var scriptDirectory = '';
		function locateFile(path) {
		  if (Module['locateFile']) {
		    return Module['locateFile'](path, scriptDirectory);
		  }
		  return scriptDirectory + path;
		}

		// Hooks that are implemented differently in different runtime environments.
		var read_,
		    readBinary;

		var nodeFS;
		var nodePath;

		if (ENVIRONMENT_IS_NODE) {
		  if (ENVIRONMENT_IS_WORKER) {
		    scriptDirectory = require('path').dirname(scriptDirectory) + '/';
		  } else {
		    scriptDirectory = __dirname + '/';
		  }

		// include: node_shell_read.js


		read_ = function shell_read(filename, binary) {
		  var ret = tryParseAsDataURI(filename);
		  if (ret) {
		    return binary ? ret : ret.toString();
		  }
		  if (!nodeFS) nodeFS = require('fs');
		  if (!nodePath) nodePath = require('path');
		  filename = nodePath['normalize'](filename);
		  return nodeFS['readFileSync'](filename, binary ? null : 'utf8');
		};

		readBinary = function readBinary(filename) {
		  var ret = read_(filename, true);
		  if (!ret.buffer) {
		    ret = new Uint8Array(ret);
		  }
		  assert(ret.buffer);
		  return ret;
		};

		// end include: node_shell_read.js
		  if (process['argv'].length > 1) {
		    process['argv'][1].replace(/\\/g, '/');
		  }

		  process['argv'].slice(2);

		  {
		    module['exports'] = Module;
		  }

		  process['on']('uncaughtException', function(ex) {
		    // suppress ExitStatus exceptions from showing an error
		    if (!(ex instanceof ExitStatus)) {
		      throw ex;
		    }
		  });

		  process['on']('unhandledRejection', abort);

		  Module['inspect'] = function () { return '[Emscripten Module object]'; };

		} else
		if (ENVIRONMENT_IS_SHELL) {

		  if (typeof read != 'undefined') {
		    read_ = function shell_read(f) {
		      var data = tryParseAsDataURI(f);
		      if (data) {
		        return intArrayToString(data);
		      }
		      return read(f);
		    };
		  }

		  readBinary = function readBinary(f) {
		    var data;
		    data = tryParseAsDataURI(f);
		    if (data) {
		      return data;
		    }
		    if (typeof readbuffer === 'function') {
		      return new Uint8Array(readbuffer(f));
		    }
		    data = read(f, 'binary');
		    assert(typeof data === 'object');
		    return data;
		  };

		  if (typeof scriptArgs != 'undefined') {
		    scriptArgs;
		  }

		  if (typeof print !== 'undefined') {
		    // Prefer to use print/printErr where they exist, as they usually work better.
		    if (typeof console === 'undefined') console = /** @type{!Console} */({});
		    console.log = /** @type{!function(this:Console, ...*): undefined} */ (print);
		    console.warn = console.error = /** @type{!function(this:Console, ...*): undefined} */ (typeof printErr !== 'undefined' ? printErr : print);
		  }

		} else

		// Note that this includes Node.js workers when relevant (pthreads is enabled).
		// Node.js workers are detected as a combination of ENVIRONMENT_IS_WORKER and
		// ENVIRONMENT_IS_NODE.
		if (ENVIRONMENT_IS_WEB || ENVIRONMENT_IS_WORKER) {
		  if (ENVIRONMENT_IS_WORKER) { // Check worker, not web, since window could be polyfilled
		    scriptDirectory = self.location.href;
		  } else if (typeof document !== 'undefined' && document.currentScript) { // web
		    scriptDirectory = document.currentScript.src;
		  }
		  // blob urls look like blob:http://site.com/etc/etc and we cannot infer anything from them.
		  // otherwise, slice off the final part of the url to find the script directory.
		  // if scriptDirectory does not contain a slash, lastIndexOf will return -1,
		  // and scriptDirectory will correctly be replaced with an empty string.
		  if (scriptDirectory.indexOf('blob:') !== 0) {
		    scriptDirectory = scriptDirectory.substr(0, scriptDirectory.lastIndexOf('/')+1);
		  } else {
		    scriptDirectory = '';
		  }

		  // Differentiate the Web Worker from the Node Worker case, as reading must
		  // be done differently.
		  {

		// include: web_or_worker_shell_read.js


		  read_ = function(url) {
		    try {
		      var xhr = new XMLHttpRequest();
		      xhr.open('GET', url, false);
		      xhr.send(null);
		      return xhr.responseText;
		    } catch (err) {
		      var data = tryParseAsDataURI(url);
		      if (data) {
		        return intArrayToString(data);
		      }
		      throw err;
		    }
		  };

		  if (ENVIRONMENT_IS_WORKER) {
		    readBinary = function(url) {
		      try {
		        var xhr = new XMLHttpRequest();
		        xhr.open('GET', url, false);
		        xhr.responseType = 'arraybuffer';
		        xhr.send(null);
		        return new Uint8Array(/** @type{!ArrayBuffer} */(xhr.response));
		      } catch (err) {
		        var data = tryParseAsDataURI(url);
		        if (data) {
		          return data;
		        }
		        throw err;
		      }
		    };
		  }

		// end include: web_or_worker_shell_read.js
		  }
		} else
		;

		// Set up the out() and err() hooks, which are how we can print to stdout or
		// stderr, respectively.
		var out = Module['print'] || console.log.bind(console);
		var err = Module['printErr'] || console.warn.bind(console);

		// Merge back in the overrides
		for (key in moduleOverrides) {
		  if (moduleOverrides.hasOwnProperty(key)) {
		    Module[key] = moduleOverrides[key];
		  }
		}
		// Free the object hierarchy contained in the overrides, this lets the GC
		// reclaim data used e.g. in memoryInitializerRequest, which is a large typed array.
		moduleOverrides = null;

		// Emit code to handle expected values on the Module object. This applies Module.x
		// to the proper local x. This has two benefits: first, we only emit it if it is
		// expected to arrive, and second, by using a local everywhere else that can be
		// minified.

		if (Module['arguments']) Module['arguments'];

		if (Module['thisProgram']) Module['thisProgram'];

		if (Module['quit']) Module['quit'];

		var tempRet0 = 0;

		var setTempRet0 = function(value) {
		  tempRet0 = value;
		};

		var getTempRet0 = function() {
		  return tempRet0;
		};



		// === Preamble library stuff ===

		// Documentation for the public APIs defined in this file must be updated in:
		//    site/source/docs/api_reference/preamble.js.rst
		// A prebuilt local version of the documentation is available at:
		//    site/build/text/docs/api_reference/preamble.js.txt
		// You can also build docs locally as HTML or other formats in site/
		// An online HTML version (which may be of a different version of Emscripten)
		//    is up at http://kripken.github.io/emscripten-site/docs/api_reference/preamble.js.html

		var wasmBinary;
		if (Module['wasmBinary']) wasmBinary = Module['wasmBinary'];
		Module['noExitRuntime'] || true;

		// include: wasm2js.js


		// wasm2js.js - enough of a polyfill for the WebAssembly object so that we can load
		// wasm2js code that way.

		// Emit "var WebAssembly" if definitely using wasm2js. Otherwise, in MAYBE_WASM2JS
		// mode, we can't use a "var" since it would prevent normal wasm from working.
		/** @suppress{duplicate, const} */
		var
		WebAssembly = {
		  // Note that we do not use closure quoting (this['buffer'], etc.) on these
		  // functions, as they are just meant for internal use. In other words, this is
		  // not a fully general polyfill.
		  Memory: function(opts) {
		    this.buffer = new ArrayBuffer(opts['initial'] * 65536);
		  },

		  Module: function(binary) {
		    // TODO: use the binary and info somehow - right now the wasm2js output is embedded in
		    // the main JS
		  },

		  Instance: function(module, info) {
		    // TODO: use the module and info somehow - right now the wasm2js output is embedded in
		    // the main JS
		    // This will be replaced by the actual wasm2js code.
		    this.exports = (
		// EMSCRIPTEN_START_ASM
		function instantiate(asmLibraryArg) {
		function Table(ret) {
		  // grow method not included; table is not growable
		  ret.set = function(i, func) {
		    this[i] = func;
		  };
		  ret.get = function(i) {
		    return this[i];
		  };
		  return ret;
		}

		  var bufferView;
		  var base64ReverseLookup = new Uint8Array(123/*'z'+1*/);
		  for (var i = 25; i >= 0; --i) {
		    base64ReverseLookup[48+i] = 52+i; // '0-9'
		    base64ReverseLookup[65+i] = i; // 'A-Z'
		    base64ReverseLookup[97+i] = 26+i; // 'a-z'
		  }
		  base64ReverseLookup[43] = 62; // '+'
		  base64ReverseLookup[47] = 63; // '/'
		  /** @noinline Inlining this function would mean expanding the base64 string 4x times in the source code, which Closure seems to be happy to do. */
		  function base64DecodeToExistingUint8Array(uint8Array, offset, b64) {
		    var b1, b2, i = 0, j = offset, bLength = b64.length, end = offset + (bLength*3>>2) - (b64[bLength-2] == '=') - (b64[bLength-1] == '=');
		    for (; i < bLength; i += 4) {
		      b1 = base64ReverseLookup[b64.charCodeAt(i+1)];
		      b2 = base64ReverseLookup[b64.charCodeAt(i+2)];
		      uint8Array[j++] = base64ReverseLookup[b64.charCodeAt(i)] << 2 | b1 >> 4;
		      if (j < end) uint8Array[j++] = b1 << 4 | b2 >> 2;
		      if (j < end) uint8Array[j++] = b2 << 6 | base64ReverseLookup[b64.charCodeAt(i+3)];
		    }
		  }
		function initActiveSegments(imports) {
		  base64DecodeToExistingUint8Array(bufferView, 1024, "eJgAAC0rICAgMFgweAAobnVsbCk=");
		  base64DecodeToExistingUint8Array(bufferView, 1056, "EQAKABEREQAAAAAFAAAAAAAACQAAAAALAAAAAAAAAAARAA8KERERAwoHAAEACQsLAAAJBgsAAAsABhEAAAARERE=");
		  base64DecodeToExistingUint8Array(bufferView, 1137, "CwAAAAAAAAAAEQAKChEREQAKAAACAAkLAAAACQALAAAL");
		  base64DecodeToExistingUint8Array(bufferView, 1195, "DA==");
		  base64DecodeToExistingUint8Array(bufferView, 1207, "DAAAAAAMAAAAAAkMAAAAAAAMAAAM");
		  base64DecodeToExistingUint8Array(bufferView, 1253, "Dg==");
		  base64DecodeToExistingUint8Array(bufferView, 1265, "DQAAAAQNAAAAAAkOAAAAAAAOAAAO");
		  base64DecodeToExistingUint8Array(bufferView, 1311, "EA==");
		  base64DecodeToExistingUint8Array(bufferView, 1323, "DwAAAAAPAAAAAAkQAAAAAAAQAAAQAAASAAAAEhIS");
		  base64DecodeToExistingUint8Array(bufferView, 1378, "EgAAABISEgAAAAAAAAk=");
		  base64DecodeToExistingUint8Array(bufferView, 1427, "Cw==");
		  base64DecodeToExistingUint8Array(bufferView, 1439, "CgAAAAAKAAAAAAkLAAAAAAALAAAL");
		  base64DecodeToExistingUint8Array(bufferView, 1485, "DA==");
		  base64DecodeToExistingUint8Array(bufferView, 1497, "DAAAAAAMAAAAAAkMAAAAAAAMAAAMAAAwMTIzNDU2Nzg5QUJDREVGRmF0YWwgKGludGVybmFsKSBlcnJvciBpbiAlcywgbGluZSAlZDogJXMKAGFzc2VydGlvbiBmYWlsZWQ6IDAAY2VsdC9jZWx0LmMAAAAAAAAAAJ0+AEBePgDABD4AgO0+AECJPgAAAAAAwEw/AADNPQ==");
		  base64DecodeToExistingUint8Array(bufferView, 1665, "/wD/AP8A/wD/AP4BAAH/AP4A/QIAAf8A/gD9AwAB/wAg/h/2H+of2B/CH6gfiB9iHzofCh/YHqAeYh4iHtwdkB1CHe4clhw6HNgbchsKG5waKhq0GToZvBg8GLYXLhegFhAWfhXoFE4UsBMQE24SyBEeEXQQxg8WD2QOrg34DEAMhAvICgoKSgmKCMYHAgc+BngFsgTqAyIDWgKSAcoAAAA2/27+pv3e/Bb8TvuI+sL5/vg6+Hb3tvb29Tj1fPTA8wjzUvKc8erwOvCM7+LuOO6S7fDsUOyy6xjrgurw6WDp0uhK6MTnROfG5kzm1uVk5fbkjuQo5MbjauMS477icOIk4t7hnuFg4Sjh9uDG4J7geOBY4D7gKOAW4ArgAuAA4A==");
		  base64DecodeToExistingUint8Array(bufferView, 1969, "DwgHBAsMAwINCgUGCQ4BAAkGAwQFCAECB2Fzc2VydGlvbiBmYWlsZWQ6IGQ9PTEwIHx8IGQ9PTE2AHNpbGsvTkxTRjJBLmMAYXNzZXJ0aW9uIGZhaWxlZDogcHNEZWMtPkxQQ19vcmRlciA9PSAxMCB8fCBwc0RlYy0+TFBDX29yZGVyID09IDE2AHNpbGsvQ05HLmMAYXNzZXJ0aW9uIGZhaWxlZDogZCA+PSA2AHNpbGsvTFBDX2FuYWx5c2lzX2ZpbHRlci5jAGFzc2VydGlvbiBmYWlsZWQ6IChkICYgMSkgPT0gMABhc3NlcnRpb24gZmFpbGVkOiBkIDw9IGxlbgAAuH6aeZp5Zma4fjNzYXNzZXJ0aW9uIGZhaWxlZDogaWR4ID4gMABzaWxrL1BMQy5jAGFzc2VydGlvbiBmYWlsZWQ6IHBzRGVjLT5MUENfb3JkZXIgPj0gMTAAKq/Vyc//QAARAGP/YQEQ/qMAJyu9Vtn/BgBbAFb/ugAXAID8wBjYTe3/3P9mAKf/6P9IAUn8CAolPgAAAAAAAIfHPclAAIAAhv8kADYBAP1IAjMkRUUMAIAAEgBy/yABi/+f/BsQezgAAAAAAAAAAGgCDcj2/ycAOgDS/6z/eAC4AMX+4/0EBQQVQCMAAAAA5j7GxPP/AAAUABoABQDh/9X//P9BAFoABwBj/wj/1P9RAi8GNArHDAAAAAAAAAAA5FcFxQMA8v/s//H/AgAZACUAGQDw/7n/lf+x/zIAJAFvAtYDCAW4BQAAAAAAAAAAlGtnxBEADAAIAAEA9v/q/+L/4P/q/wMALABkAKgA8wA9AX0BrQHHAQAAAAAAAAAAvQCo/WkCZ3d1AGH/0vsIdDQA3QCo9nRu/P8RAury5WbQ//YCjPClXbD/iQN17wZTnf/MA4LvZkeV/8cDi/AnO5n/gANh8q4upf8FA8/0XiK5/2MCofeYFtL/qQGh+rQLYXNzZXJ0aW9uIGZhaWxlZDogMABzaWxrL3Jlc2FtcGxlcl9wcml2YXRlX2Rvd25fRklSLmMAYXNzZXJ0aW9uIGZhaWxlZDogMABzaWxrL3Jlc2FtcGxlci5jAAYAAwAHAwABCgACBhIKDAQAAgAAAAkEBwQAAwwHB2Fzc2VydGlvbiBmYWlsZWQ6IGluTGVuID49IFMtPkZzX2luX2tIegBhc3NlcnRpb24gZmFpbGVkOiBTLT5pbnB1dERlbGF5IDw9IFMtPkZzX2luX2tIeg==");
		  base64DecodeToExistingUint8Array(bufferView, 2928, "/fr06dS2loN4bmJVSDwxKCAZEw8NCwkIBwYFBAMCAQDS0M7Lx8G3qI5oSjQlGxQOCgYEAg==");
		  base64DecodeToExistingUint8Array(bufferView, 2992, "38m3p5iKfG9iWE9GPjgyLCcjHxsYFRIQDgwKCAYEAwIBALywm4p3YUMrGgoApXdQPS8jGxQOCQQAcT8AAAAAAAwjPFNshJ20zuQPIDdNZX2Xr8nhEypCWXKJorjR5gwZMkhheJOsyN8aLEVacoeftM3hDRY1UGqCnLTN5A8ZLEBac46oxN4TGD5SZHiRqL7WFh8yT2d4l6rL4xUdLUFqfJarxOAeMUtheY6lutHlExk0Rl10j6bA2xoiPkthdpGnwtkZIThGW3GPpcTfFSIzSGF1kavE3hQdMkNadZCoxd0WHzBCX3WSqMTeGCEzTXSGnrTI4BUcRldqfJWqwtkaITVAU3WYrczhGyJBX2yBm67S4RQaSGNxg5qwyNsiKz1OXXKbsc3lFx02YXyKo7PR5R4mOFl2gZ6yyOcVHTE/VW+Oo8HeGzBNZ4Wes8TX6B0vSmN8l7DG3O0hKj1MXXmbrs/hHTVXcIiaqrzQ4xgeNFSDlqa6y+UlMEBUaHacscnmUQsKCQoJCgnvCO8ICgn8CBcJ7whICxQKWgk/CQoJ4gjiCOII4giSCLcJJAkkCQoJCgkKCSQJJAk/CTIJkAzOCiQJJAkKCeIIrQifCNUIkgicCaoJPwlaCVoJWglaCT8JZwkKCZcN8AtPCJ8I4gjiCOII7wgKCdUI0gxFDBQKWgnHCK0InwiSCJIIQggAEAUPrQg8CjwKZwkKCVoJPwkaCGoMrAw/Ca0I+QmCCSQJCgl3CK0ICg2gDaYKkgjVCJwJMgk/CZ8INQgyCXQJFwk/CVoJdAl0CXQJnAk/CcMOLQ6CCd8JPwniCOII/AifCAAItgyZDJkKHguPCRcJ/Aj8COIITwi/DOQMwQr2Co8J1QjVCMcITwg1CDkLpQtJCj8JZwkyCZIIxwjHCEIImQx9DEkKFAriCIUIxwitCK0IXQhqDO4MtApnCeII4gjiCO8IkghCCEUMyAycCQ0I7wjECT8JtwmCCYUIsw3SDAoJjApXCqoJPwlaCSQJTwhfDc8N3gvwC/wIngetCOII4gjiCEwNJg0nCH8KOQsyCXQJ4giqCewJsA6gDZ4HZApRC98JWgk/CZwJ1QjUC8gMtApIC7QKaghPCO8IugjHCG8OSQ7pB7EHZAqMChQKxAkXCT8JhwxVDTIJGghIC0gLJAm3CccIdwgKDSYNHgvcChcJagjiCO8IQggNCBcJ/AiFCHcIhQg/CUkKjAqMCvkJZwmCCa0I1QitCK0IJAl0CS8KjAreC6wM9gpIC6oJGgj8CAoJMglMCa0IaghPCO8IxAnpCukKPAoUCj8JXA6BDroILgeFCMEKpgpxCtEJnwjpClgMpgr5CR4L0QmFCFoJrQiFCNSylIFsYFVST009Ozk4MzEwLSopKCYkIh8eFQwKAwEA//X07Onh2cu+sK+hlYh9cmZbUUc8NCsjHBQTEgwLBQCzioyUl5WZl6N0Q1I7XEhkWVw=");
		  base64DecodeToExistingUint8Array(bufferView, 4112, "EAAAAABjQiQkIiQiIiIiU0UkNCJ0ZkZERLBmREQiQVVEVCR0jZiLqoS7uNiJhPmouYtoZmRERLLaubmq9Ni7u6r0u7vbimebuLmJdLebmIiE2bi4qqTZq5uL9Km4uaqk2N/aitaPvNqo9I2Im6qoitzbi6TbytiJqLr2uYt0udu5imRkhmRmIkREZESoy93aqKeaiGhGpPariYuJm9rbi//+/e4OAwIBAP/+/NojAwIBAP/++tA7BAIBAP/+9sJHCgIBAP/87LdSCAIBAP/867RaEQIBAP/44KthHgQBAP/+7K1fJQcB");
		  base64DecodeToExistingUint8Array(bufferView, 4352, "////gwaR///////sXQ9g///////CUxlH3f////+iSSJCov///9J+SSs5rf///8l9RzA6gv///6ZuSTk+aNL///t7QTdEZKv/AAAAAAAAAAD6AAMABgADAAMAAwAEAAMAAwADAM0BAAAgAAoAFC5kAfALAAAwDQAAsA8AAPAPAAAQEAAAsBAAAAARAABQEQAABxcmNkVVZHSDk6KywdDf7w0ZKTdFU2Jwf46dq7vL3OwPFSIzPU5can6ImKe5zeHwChUkMj9PX25+jZ2tvc3d7REUJTM7Tllre4aWpLjN4PAKDyAzQ1FgcIGOnq29zNzsCBUlM0FPYnF+ipuos8DR2gwPIjc/TldsdoOUp7nL2+wQEyAkOE9bbHaImqu6zNztCxwrOkpZaXiHlqW0xNPi8QYQIS48S1xre4mcqbnH1uELEx4sOUpZaXmHmKm6ytrqDBMdLjlHWGR4hJSltsfY6REXIy44TVxqe4aYp7nM3u0OES01P0tZa3OEl6u8zt3wCRAdKDhHWGd3iZqrvc3e7RATJDA5TFdpdoSWp7nK2uwMER02R1FeaH6IlaS2yd3tDxwvPk9hc4GOm6i0wtDf7ggOHi0+Tl5vf4+fr8DP3+8RHjE+T1xrd4SRoK6+zNzrDhMkLT1MW2x5ipqsvc3e7gwSHy08TFtre4qaq7vM3ewNER8rNUZTZ3KDlae5y9ztERYjKjpOXW59i5uqvM7g8AgPIjJDU2Nzg5KissHR4O8NEClCSVZfb4CJlqO3zuHxERklND9LXGZ3hJCgr7/U5xMfMUFTZHWFk6Guu8jV4/ISHzREWGd1foqVo7HAz9/vEB0vPUxaaneFk6GwwdHg8A8VIzI9SVZhbneBja/G2u1JDm0LbQttC20LbQttC20LbQttC20LbQuTC5MLbQseC5AMDQycC/AL8AvCC8ILwguTC5MLwgucC0gLHgseC6YKUA+uD6ULhwyHDHYL8AseCzIMrAxtCx4LPAr5CdwKbQu8DX0MwgsfDMsLSAttC20LbQttC0gLSAtIC0gLSAvBCr4TvhN2C/UNOQ3wCw0M6QpYDFgMnAseC9EJ7AnBCkgLTBE1EIwKwQqcC8ILbQseC6ULywttC20LbQttC0gLpgokDssLnAvwC/ALOQv2CvALkAznC6UL2wzbDKUL7gyvC2sUlhPsCQoNxg05DX0MFgwwDaULjApXCn8K6QoeC3EK2RM2FAcSTBGcCVEL5wuHDGEMfwq0CkgLHgvpCh4LjAoyDEgLkwttC20LbQttC5MLkwuTC5MLbQttC5MLkwuTC2oQhwylCx8MwgtIC0gLbQucCzkLZAvLC5wLwgt9DDkLsA6wDqwMHwylC0gLbQtIC5wLdgvpCukKHgtIC0gLZAoOD64PhwwyDKwMdgvnC5MLkwsNDB4L6QrpCukK6QoUCgUP8A8dDbwNFgy0CsILdgsyDA0MHgseC1cKVwoeC/YKGxQeE5kMBQ9xDWEMUQtVDXsNjAoUCnEKtAoeC/YKwQoNEM0O2wxYDG0LSAtIC20L6Qq0CukKtArpCh4LSAv2CtkTvhPnC9kNrAzwCw0MgAsfDFELtAq0CrQKHgvpCjwK1RDVECwL3wmHDDANMA0DDAMMMA3wCx4LVwoUCqYKwQrwC2QL9gpIC7QKfwpRCx8MTgxODJAMYQzwC8ILkwseCxcRKg9tC0gLHgtICx4LHgtIC0gLSAseC0gLbQtICx4LpQtkC2QLpQulC/ALMgyQDE4M8AvCC5wLnAucC20LtAqFEDUQ7gwTDW0LkwtIC6ULpQseC+kKtAoeCx4LHgvpCvAPrg8fDMILbQttC20LSAttC20LHgseCx4L6QpIC9wKBxLfEWEMcQ2HDKULUQveCzIMtAp/Cn8Kfwq0CukKjAo1EK0QzQ5JDqYK3ApIC0gLwgucC20LHgt/Cn8K6QpIC3cQ4g3BCh4LHgtIC0gLSAttC20LSAttC20LbQuTC0gLNhQ5E9UIaA3NDpcNEw0eC+4Mlw1ODFELnAm3CcEKbQt7DWUOMgx9DB0N5wuHDIcMpQuQDA0MbQttC38K7AmCCaULwgvpCukKtArpCh4LnAvwCx8MTgxODE4MHwzCC8ILgAs5C38KpgrcCsILaA3ZDR0NrAzwC8ILkwttC0gLHgvLC4ALUQvCC8ILnAvLCx8M8AvwC8ILSAseC20LbQtIC1APfw/CC30MHQ2QDNsM2wyXDXgOcQ2mCoUInAkUCi8K4czJuLevnpqZh3dzcW5tY2JfT0Q0MjAtKyAfGxIKAwD/++vm1MnEtqemo5eKfG5oWk5MRkU5LSIYFQsGBQQDAK+UoLCyra6ksa7EtsbAtkQ+QjxIdVVadoiXjqCOmw==");
		  base64DecodeToExistingUint8Array(bufferView, 6135, "AWRmZkREJCJgpGueubS5i2ZAQiQiIgABINCLjb+YuZtoYKtopmZmZoQBAAAAABAQAFBtTmu5i2dl0NSNi62Ze2ckAAAAAAAAATAAAAAAAAAgRId7d3dnRWJEZ3h2dmZHYoaInbi2mYuG0Kj4S72PeWsgMSIiIgARAtLri3u5iWmGYodotmS3q4ZkRkRGQkIig0CmZkQkAgEAhqZmRCIiQoTU9p6La2tXZmTbfXqJdmeEcoeJaatqMiKk1o2PuZd5Z8AiAAAAAAAB0G1Ku4b5n4lmbpp2V2V3ZQACACQkQkQjYKRmZCQAAiGniq5mZFQCAmRreHckxRgA//799AwDAgEA//784CYDAgEA//770TkEAgEA//70w0UEAgEA//vouFQHAgEA//7wulYOAgEA//7vslseBQEA//jjsWQTAgE=");
		  base64DecodeToExistingUint8Array(bufferView, 6464, "////nASa///////jZg9c///////VUxhI7P////+WTCE/1v///755TSs3uf////WJRys7i/////+DQjJCa8L//6Z0TDc1ff//AAAAAAAAAABkAAMAKAADAAMAAwAFAA4ADgAKAAsAAwAIAAkABwADAFsBAAAgABAAZiarAZARAACQEwAAkBcAANAXAADwFwAA8BgAAEAZAACQGQAAAAAAAFzKvti235rinOZ47Hr0zPw0A4YLiBNkGWYdSiBCJ6Q1+ff29fTq0srJyMWuUjs4NzYuFgwLCgkHAEAAy5YA18OmfW5SAAAAABsaAAAeGgAAeACAQADongoA5gDz3cC1AGQA8AAgAGQAzTwAMAAgq1UAwIBAAM2aZjMA1auAVSsA4MCggGBAIABkKBAHAwEAYXNzZXJ0aW9uIGZhaWxlZDogZnNfa0h6ID09IDggfHwgZnNfa0h6ID09IDEyIHx8IGZzX2tIeiA9PSAxNgBzaWxrL2RlY29kZXJfc2V0X2ZzLmMAYXNzZXJ0aW9uIGZhaWxlZDogcHNEZWMtPm5iX3N1YmZyID09IE1BWF9OQl9TVUJGUiB8fCBwc0RlYy0+bmJfc3ViZnIgPT0gTUFYX05CX1NVQkZSLzIAYXNzZXJ0aW9uIGZhaWxlZDogMABhc3NlcnRpb24gZmFpbGVkOiBfZnQ+MQBjZWx0L2VudGRlYy5j");
		  base64DecodeToExistingUint8Array(bufferView, 7008, "4HAsDwMCAQD+7cCERhcEAP/84ps9CwI=");
		  base64DecodeToExistingUint8Array(bufferView, 7040, "+vXqy0cyKiYjIR8dHBsaGRgXFhUUExIREA8ODQwLCgkIBwYFBAMCAQCzYwBHOCseFQwG");
		  base64DecodeToExistingUint8Array(bufferView, 7104, "x6WQfG1gVEc9MyogFw8IAPHh08e7r6SZjoR7cmlgWFBIQDkyLCYhHRgUEAwJBQIArBsAAMAbAADQGwAAAAAAAAQGGAcFAAACAAAMHCkN/PcPKhkOAf4+Kff2JUH8A/oEQgf4EA4m/SEAAAAAAAAAAA0WJxcM/yRAG/r5CjcrEQEBCAEBBvVKNff0N0z0CP0DXRv8Gic7A/gCAE0LCfgWLPoHKAkaAwn5FGX5BAP4KhoA8SFEAhf+Ny7+DwP/FRAp+hs9JwX1KlgEAf48QQb8//tJOAH3E14d9wAMYwYECO1mLvMDAg0DAgnrVEju9S5o6ggSJjAXAPBGU+sLBfV1Fvj6F3X0AwP4XxwE9g9NPPH/BHwC/AMmVBjnAg0qDR8V/Dgu//8jT/MT+UFY9/IUBFEx4xQASwPvBfcsXPgB/RZFH/pfKfQFJ0MQ/AEA+ng33PMsegToUQULAwcCAAkKWAAcAAAwHAAAgBwAAGFzc2VydGlvbiBmYWlsZWQ6IHBzRGVjLT5wc05MU0ZfQ0ItPm9yZGVyID09IHBzRGVjLT5MUENfb3JkZXIAc2lsay9kZWNvZGVfaW5kaWNlcy5jAH0zGhIPDAsKCQgHBgUEAwIBAMZpLRYPDAsKCQgHBgUEAwIBANWidFM7KyAYEg8MCQcGBQMCAO+7dDscEAsKCQgHBgUEAwIBAPrlvIdWMx4TDQoIBgUEAwIBAPnr1bmcgGdTQjUqIRoVEQ0KAP75686kdk0uGxAKBwUEAwIBAP/9+e/cv5x3VTklFw8KBgQCAP/9+/bt38uzmHxiSzcoHRUPAP/+/ffcompDKhwSDAkGBAMC");
		  base64DecodeToExistingUint8Array(bufferView, 7744, "8b6yhFdKKQ4A38GdjGo5JxI=");
		  base64DecodeToExistingUint8Array(bufferView, 7776, "gADWKgDrgBUA9LhICwD41oAqBwD44apQGQUA++zGfjYSAwD67tOfUiMPBQD658uogFg1GQYA/O7YuZRsRygSBAD98+HHpoBaOR8NAwD+9unUt5NtSSwXCgIA//rw38amgFo6IRAGAQD/+/Tn0rWSbksuGQwFAQD//fju3cSkgFw8IxIIAwEA//358uXQtJJuTDAbDgcDAQ==");
		  base64DecodeToExistingUint8Array(bufferView, 7936, "gQDPMgDsgRQA9blICgD51YEqBgD64qlXGwQA++nCgj4UBAD67M+gYy8RAwD/8Nm2g1EpCwEA//7pyZ9rPRQCAQD/+enOqoBWMhcHAQD/+u7ZupRsRicSBgEA//zz4simgFo4Hg0EAQD//PXn0bSSbkwvGQsEAQD//fjt28KjgF0+JRMIAwEA//768eLNsZFvTzMeDwYCAQ==");
		  base64DecodeToExistingUint8Array(bufferView, 8096, "gQDLNgDqgRcA9bhJCgD614EpBQD86K1WGAMA/fDIgTgPAgD99NmkXiYKAQD99eK9hEcbBwEA/fbny59pOBcGAQD/+OvVs4VVLxMFAQD//vPdwp91RiUMAgEA//746tCrgFUwFggCAQD//vrw3L2Va0MkEAYCAQD//vvz48mmgFo3HQ0FAgEA//789urVt5NtSSsWCgQCAQ==");
		  base64DecodeToExistingUint8Array(bufferView, 8256, "ggDIOgDnghoA9LhMDAD51oIrBgD86K1XGAMA/fHLgzgOAgD+9t2nXiMIAQD++ejBgkEXBQEA//vv06JjLQ8EAQD/+/PfuoNKIQsDAQD//PXmyp5pORgIAgEA//3369azhFQsEwcCAQD//vrw38SfcEUkDwYCAQD//v3159GwiF03GwsDAgEA//79/O/dwp51TCoSBAMCAQ==");
		  base64DecodeToExistingUint8Array(bufferView, 8418, "AgUJDhQbIyw2QU1aaHeH");
		  base64DecodeToExistingUint8Array(bufferView, 8448, "/jFDTVJdY8YLEhgfJC3/LkJOV15o0A4VICozQv9eaG1wc3b4NUVQWF9mYXNzZXJ0aW9uIGZhaWxlZDogX2Z0PjEAY2VsdC9lbnRlbmMuYwBhc3NlcnRpb24gZmFpbGVkOiBfYml0cz4wAGFzc2VydGlvbiBmYWlsZWQ6IGZyYW1lX2xlbmd0aCA9PSAxMiAqIDEwAHNpbGsvZGVjb2RlX3B1bHNlcy5jAHNpbGsvc29ydC5jAGFzc2VydGlvbiBmYWlsZWQ6IEwgPiAwAAABAAAAAQ==");
		  base64DecodeToExistingUint8Array(bufferView, 8674, "Af8B/wL+Av4D/QABAAH/Av8C/gP+Aw==");
		  base64DecodeToExistingUint8Array(bufferView, 8705, "Av///wAAAQEAAQABAAAAAAABAAAAAAABAAAAAQAAAAAA/wIBAAEBAAD//wAAAAAAAAH/AAH/AP8B/gL+/gL9AgP9/AP8BAT7Bfr7BvkGBQj3AAABAAAAAAAAAP8BAAAB/wAB//8B/wIB/wL+/gL+AgID/QABAAAAAAAAAQABAAAB/wEAAAIB/wL//wL/AgL/A/7+/gMAAQAAAQAB/wL/Av8CA/4D/v4EBP0F/fwG/AYF+wj6+/kJYXNzZXJ0aW9uIGZhaWxlZDogbmJfc3ViZnIgPT0gUEVfTUFYX05CX1NVQkZSID4+IDEAc2lsay9kZWNvZGVfcGl0Y2guYwBhc3NlcnRpb24gZmFpbGVkOiBzdGFydF9pZHggPiAwAHNpbGsvZGVjb2RlX2NvcmUuYwBhc3NlcnRpb24gZmFpbGVkOiBwc0RlYy0+TFBDX29yZGVyID09IDEwIHx8IHBzRGVjLT5MUENfb3JkZXIgPT0gMTYAYXNzZXJ0aW9uIGZhaWxlZDogTCA+IDAgJiYgTCA8PSBNQVhfRlJBTUVfTEVOR1RIAHNpbGsvZGVjb2RlX2ZyYW1lLmMAYXNzZXJ0aW9uIGZhaWxlZDogcHNEZWMtPnByZXZTaWduYWxUeXBlID49IDAgJiYgcHNEZWMtPnByZXZTaWduYWxUeXBlIDw9IDIAYXNzZXJ0aW9uIGZhaWxlZDogcHNEZWMtPmx0cF9tZW1fbGVuZ3RoID49IHBzRGVjLT5mcmFtZV9sZW5ndGgAYXNzZXJ0aW9uIGZhaWxlZDogZGVjQ29udHJvbC0+bkNoYW5uZWxzSW50ZXJuYWwgPT0gMSB8fCBkZWNDb250cm9sLT5uQ2hhbm5lbHNJbnRlcm5hbCA9PSAyAHNpbGsvZGVjX0FQSS5jAGFzc2VydGlvbiBmYWlsZWQ6IDAAAAAGAAAABAAAAAMAAACAuwAAeAAAABUAAAAVAAAAAJpZPwAAAAAAAIA/AACAP0AlAAADAAAACAAAAHgAAAALAAAAcCUAAGAmAACQJgAAgAcAAAMAAABwKAAAkFwAAMBdAAB4XgAAsCgAAIgBAADQRAAAsEUAAEBHAAAAAAAAAAABAAIAAwAEAAUABgAHAAgACgAMAA4AEAAUABgAHAAiACgAMAA8AE4AZA==");
		  base64DecodeToExistingUint8Array(bufferView, 9605, "WlBLRT84MSgiHRQSCgAAAAAAAAAAbmRaVE5HQTozLScgGhQMAAAAAAAAdm5nXVZQS0ZBOzUvKB8XDwQAAAAAfndwaF9ZU05IQjw2LycgGREMAQAAhn94cmdhW1VOSEI8Ni8pIx0XEAoBkImCfHFrZV9YUkxGQDkzLSchGg8BmJGKhHt1b2liXFZQSkM9NzErJBQBopuUjoV/eXNsZmBaVE1HQTs1Lh4BrKWemI+Jg312cGpkXldRS0U/OC0UyMjIyMjIyMjGwby3sq2oo56ZlIFo");
		  base64DecodeToExistingUint8Array(bufferView, 9840, "CAAIAAgACAAQABAAEAAVABUAGAAdACIAJAAAAAAAAABqHI04UrseOghp3DqC7Vc7iWOyOwMqBTww3Dk8tD53PByjnjzR8sU8/obxPJurED0FrSo9hMJGPVPmZD0RiYI9h5+TPcuypT3Rvrg9Or/MPVSv4T0Uivc9DiUHPtn0Ej5fMR8+aNcrPorjOD4wUkY+lB9UPr9HYj6OxnA+sJd/PlJbhz5gD48+mOWWPnnbnj5w7qY+2BuvPvtgtz4Ru78+RifIPrei0D54Ktk+lLvhPgxT6j7e7fI+Bon7Pr4QAj8fWgY/JJ8KP1DeDj8rFhM/QUUXPyVqGz9zgx8/zo8jP+aNJz90fCs/P1ovPxkmMz/n3jY/mYM6PzMTPj/FjEE/d+9EP386SD8nbUs/zoZOP+WGUT/xbFQ/jjhXP2npWT9Ff1w/+vleP3NZYT+vnWM/wcZlP8/UZz8RyGk/0qBrP25fbT9QBG8/9I9wP+YCcj+9XXM/H6F0P7/NdT9X5HY/sOV3P5fSeD/jq3k/c3J6Pycnez/nyns/nV58PzXjfD+cWX0/vcJ9P4Yffj/ecH4/q7d+P8/0fj8mKX8/hlV/P756fz+WmX8/zLJ/PxTHfz8c138/guN/P93sfz+2838/ivh/P8j7fz/W/X8/B/9/P6X/fz/o/38//f9/PwAAgD/gAQAAh4gIO/////8FAGAAAwAgAAQACAACAAQABAAB");
		  base64DecodeToExistingUint8Array(bufferView, 10396, "8EcAALBL");
		  base64DecodeToExistingUint8Array(bufferView, 10416, "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/////////////////////wAAAAAAAAAAKQApACkAUgBSAHsApADIAN4=");
		  base64DecodeToExistingUint8Array(bufferView, 17674, "KQApACkAKQB7AHsAewCkAKQA8AAKARsBJwEpACkAKQApACkAKQApACkAewB7AHsAewDwAPAA8AAKAQoBMQE+AUgBUAF7AHsAewB7AHsAewB7AHsA8ADwAPAA8AAxATEBMQE+AT4BVwFfAWYBbAHwAPAA8ADwAPAA8ADwAPAAMQExATEBMQFXAVcBVwFfAV8BcgF4AX4BgwE=");
		  base64DecodeToExistingUint8Array(bufferView, 17840, "KAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcoDxccHyIkJicpKissLS4vLzEyMzQ1Njc3OTo7PD0+Pz9BQkNERUZHRygUISkwNTk9QEJFR0lLTE5QUlVXWVtcXmBiZWdpa2xucHJ1d3l7fH6AKBcnMzxDSU9TV1teYWRmaWtvc3Z5fH6Bg4eLjpGUlpmbn6OmqayusbMjHDFBTllja3J4foSIjZGVmZ+lq7C0ub3Ax83T2Nzh5ejv9fsVITpPYXB9iZSdpq62vcPJz9nj6/P7ESM/Vmp7i5ilsbvFztbe5u36GR83S1tpdYCKkpqhqK60ub7I0Nfe5evw9f8QJEFZboCQn625xM/Z4ury+gspSmeAl6y/0eHx/wkrT26Ko7rP4/YMJ0dje5CktsbW5PH9CSxRcY6owNbr/wcxWn+gv9z3BjNfhqrL6gcvV3ubuNTtBjRhia7Q8AU5apfA5wU7b57K8wU3Z5O74AU8caHO+ARBeq/gBEN/tuoAAAAAAAAAAODg4ODg4ODgoKCgoLm5ubKyqIY9JeDg4ODg4ODg8PDw8M/Pz8bGt5BCKKCgoKCgoKCgubm5ucHBwbe3rIpAJvDw8PDw8PDwz8/Pz8zMzMHBtI9CKLm5ubm5ubm5wcHBwcHBwbe3rIpBJ8/Pz8/Pz8/PzMzMzMnJyby8sI1CKMHBwcHBwcHBwcHBwcLCwri4rYtBJ8zMzMzMzMzMycnJycbGxru7r4xCKA==");
		  base64DecodeToExistingUint8Array(bufferView, 18418, "YADAACABgAEgAIAA4ABAAaABQACgAAABYAHAAQgAaADIACgBiAEoAIgA6ABIAagBSACoAAgBaAHIARAAcADQADABkAEwAJAA8ABQAbABUACwABABcAHQARgAeADYADgBmAE4AJgA+ABYAbgBWAC4ABgBeAHYAQQAZADEACQBhAEkAIQA5ABEAaQBRACkAAQBZAHEAQwAbADMACwBjAEsAIwA7ABMAawBTACsAAwBbAHMARQAdADUADQBlAE0AJQA9ABUAbQBVAC0ABQBdAHUARwAfADcADwBnAE8AJwA/ABcAbwBXAC8ABwBfAHcAQEAYQDBACEBgQEhAIEA4QBBAaEBQQChAAEBYQHBAQkAaQDJACkBiQEpAIkA6QBJAakBSQCpAAkBaQHJAREAcQDRADEBkQExAJEA8QBRAbEBUQCxABEBcQHRARkAeQDZADkBmQE5AJkA+QBZAbkBWQC5ABkBeQHZAQUAZQDFACUBhQElAIUA5QBFAaUBRQClAAUBZQHFAQ0AbQDNAC0BjQEtAI0A7QBNAa0BTQCtAA0BbQHNARUAdQDVADUBlQE1AJUA9QBVAbUBVQC1ABUBdQHVAR0AfQDdAD0BnQE9AJ0A/QBdAb0BXQC9AB0BfQHdAQIAYgDCACIBggEiAIIA4gBCAaIBQgCiAAIBYgHCAQoAagDKACoBigEqAIoA6gBKAaoBSgCqAAoBagHKARIAcgDSADIBkgEyAJIA8gBSAbIBUgCyABIBcgHSARoAegDaADoBmgE6AJoA+gBaAboBWgC6ABoBegHaAQYAZgDGACYBhgEmAIYA5gBGAaYBRgCmAAYBZgHGAQ4AbgDOAC4BjgEuAI4A7gBOAa4BTgCuAA4BbgHOARYAdgDWADYBlgE2AJYA9gBWAbYBVgC2ABYBdgHWAR4AfgDeAD4BngE+AJ4A/gBeAb4BXgC+AB4BfgHeAQMAYwDDACMBgwEjAIMA4wBDAaMBQwCjAAMBYwHDAQsAawDLACsBiwErAIsA6wBLAasBSwCrAAsBawHLARMAcwDTADMBkwEzAJMA8wBTAbMBUwCzABMBcwHTARsAewDbADsBmwE7AJsA+wBbAbsBWwC7ABsBewHbAQcAZwDHACcBhwEnAIcA5wBHAacBRwCnAAcBZwHHAQ8AbwDPAC8BjwEvAI8A7wBPAa8BTwCvAA8BbwHPARcA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");
		  base64DecodeToExistingUint8Array(bufferView, 23740, "sFoAALBL");
		  base64DecodeToExistingUint8Array(bufferView, 23762, "GAAwAEgAYAAIACAAOABQAGgAEAAoAEAAWABwAAQAHAA0AEwAZAAMACQAPABUAGwAFAAsAEQAXAB0AAEAGQAxAEkAYQAJACEAOQBRAGkAEQApAEEAWQBxAAUAHQA1AE0AZQANACUAPQBVAG0AFQAtAEUAXQB1AAIAGgAyAEoAYgAKACIAOgBSAGoAEgAqAEIAWgByAAYAHgA2AE4AZgAOACYAPgBWAG4AFgAuAEYAXgB2AAMAGwAzAEsAYwALACMAOwBTAGsAEwArAEMAWwBzAAcAHwA3AE8AZwAPACcAPwBXAG8AFwAvAEcAXwB3AHgAAACIiAg8AgAAAAUAGAADAAgAAgAEAAQAAQ==");
		  base64DecodeToExistingUint8Array(bufferView, 24044, "0FwAALBL");
		  base64DecodeToExistingUint8Array(bufferView, 24066, "DAAYACQAMAAEABAAHAAoADQACAAUACAALAA4AAEADQAZACUAMQAFABEAHQApADUACQAVACEALQA5AAIADgAaACYAMgAGABIAHgAqADYACgAWACIALgA6AAMADwAbACcAMwAHABMAHwArADcACwAXACMALwA7ADwAAACJiIg8AwAAAAUADAADAAQABAAB");
		  base64DecodeToExistingUint8Array(bufferView, 24229, "XgAAsEsAAAAAAACViwAAN5gAAP+lAAAEtQAAZ8UAAEXXAADB6gAA//8AAGNlbHQvbGFwbGFjZS5jAGFzc2VydGlvbiBmYWlsZWQ6IGZsPDMyNzY4AGFzc2VydGlvbiBmYWlsZWQ6IGZsPD1mbQBhc3NlcnRpb24gZmFpbGVkOiBmbTxJTUlOKGZsK2ZzLDMyNzY4KQ==");
		  base64DecodeToExistingUint8Array(bufferView, 24386, "zkAAAMhAAAC4QAAAqkAAAKJAAACaQAAAkEAAAIxAAACcQAAAlkAAAJJAAACOQAAAnEAAAJRAAACKQAAAkEAAAIxAAACUQAAAmEAAAI5AAABwQAAAcEAAAHBAAABwQAAAcEA=");
		  base64DecodeToExistingUint8Array(bufferView, 24496, "SH9BgUKAQYBAgD6AQIBAgFxOXE9cTlpPdClzKHIohBqEGpERoQywCrELGLMwijaHNoQ1hjiFN4Q3hD1yRmBKWEtYV0pZQltDZDtsMngoeiVhK04yU05UUVhLVkpXR1pJXUpdSm0ociR1InUijxGREpITogylCrIHvQa+CLEJF7I2cz9mQmJFY0pZR1tJW05ZVlBcQl1AZjtnPGg8dTR7LIojhR9hJk0tPVpdPGkqayluLXQmcSZwJnwahBuIE4wUmw6fEJ4Sqg2xCrsIwAavCZ8KFbI7bkdWS1VUU1tCWElXSFxLYkhpOms2czRyN3A4gTOEKJYhjB1iI00qKnlgQmwrbyh1LHsgeCR3IX8hhiKLFZMXmBSeGZoaphWtELgNuAqWDYsPFrI/ckpSVFNcUmc+YEhgQ2VJa0hxN3Y0fTR2NHU3hzGJJ50gkR1hIU0oAABmPwAATD8AACY/AAAAPwCGaz8AFC4/AHC9PgDQTD4CAQ==");
		  base64DecodeToExistingUint8Array(bufferView, 24881, "CA0QExUXGBobHB0eHyAgISIiIyQkJSVhc3NlcnRpb24gZmFpbGVkOiBjb2RlZEJhbmRzID4gc3RhcnQAY2VsdC9yYXRlLmMAYXNzZXJ0aW9uIGZhaWxlZDogYml0c1tqXSA+PSAwAGFzc2VydGlvbiBmYWlsZWQ6IGViaXRzW2pdID49IDAAYXNzZXJ0aW9uIGZhaWxlZDogQyplYml0c1tqXTw8QklUUkVTID09IGJpdHNbal0=");
		  base64DecodeToExistingUint8Array(bufferView, 25078, "4D8AAAAAAADgvwMAAAAEAAAABAAAAAYAAACD+aIARE5uAPwpFQDRVycA3TT1AGLbwAA8mZUAQZBDAGNR/gC73qsAt2HFADpuJADSTUIASQbgAAnqLgAcktEA6x3+ACmxHADoPqcA9TWCAES7LgCc6YQAtCZwAEF+XwDWkTkAU4M5AJz0OQCLX4QAKPm9APgfOwDe/5cAD5gFABEv7wAKWosAbR9tAM9+NgAJyycARk+3AJ5mPwAt6l8Auid1AOXrxwA9e/EA9zkHAJJSigD7a+oAH7FfAAhdjQAwA1YAe/xGAPCrawAgvM8ANvSaAOOpHQBeYZEACBvmAIWZZQCgFF8AjUBoAIDY/wAnc00ABgYxAMpWFQDJqHMAe+JgAGuMwAAZxEcAzWfDAAno3ABZgyoAi3bEAKYclgBEr90AGVfRAKU+BQAFB/8AM34/AMIy6ACYT94Au30yACY9wwAea+8An/heADUfOgB/8soA8YcdAHyQIQBqJHwA1W76ADAtdwAVO0MAtRTGAMMZnQCtxMIALE1BAAwAXQCGfUYA43EtAJvGmgAzYgAAtNJ8ALSnlwA3VdUA1z72AKMQGABNdvwAZJ0qAHDXqwBjfPgAerBXABcV5wDASVYAO9bZAKeEOAAkI8sA1op3AFpUIwAAH7kA8QobABnO3wCfMf8AZh5qAJlXYQCs+0cAfn/YACJltwAy6IkA5r9gAO/EzQBsNgkAXT/UABbe1wBYO94A3puSANIiKAAohugA4lhNAMbKMgAI4xYA4H3LABfAUADzHacAGOBbAC4TNACDEmIAg0gBAPWOWwCtsH8AHunyAEhKQwAQZ9MAqt3YAK5fQgBqYc4ACiikANOZtAAGpvIAXHd/AKPCgwBhPIgAinN4AK+MWgBv170ALaZjAPS/ywCNge8AJsFnAFXKRQDK2TYAKKjSAMJhjQASyXcABCYUABJGmwDEWcQAyMVEAE2ykQAAF/MA1EOtAClJ5QD91RAAAL78AB6UzABwzu4AEz71AOzxgACz58MAx/goAJMFlADBcT4ALgmzAAtF8wCIEpwAqyB7AC61nwBHksIAezIvAAxVbQByp5AAa+cfADHLlgB5FkoAQXniAPTfiQDolJcA4uaEAJkxlwCI7WsAX182ALv9DgBImrQAZ6RsAHFyQgCNXTIAnxW4ALzlCQCNMSUA93Q5ADAFHAANDAEASwhoACzuWABHqpAAdOcCAL3WJAD3faYAbkhyAJ8W7wCOlKYAtJH2ANFTUQDPCvIAIJgzAPVLfgCyY2gA3T5fAEBdAwCFiX8AVVIpADdkwABt2BAAMkgyAFtMdQBOcdQARVRuAAsJwQAq9WkAFGbVACcHnQBdBFAAtDvbAOp2xQCH+RcASWt9AB0nugCWaSkAxsysAK0UVACQ4moAiNmJACxyUAAEpL4AdweUAPMwcAAA/CcA6nGoAGbCSQBk4D0Al92DAKM/lwBDlP0ADYaMADFB3gCSOZ0A3XCMABe35wAI3zsAFTcrAFyAoABagJMAEBGSAA/o2ABsgK8A2/9LADiQDwBZGHYAYqUVAGHLuwDHibkAEEC9ANLyBABJdScA67b2ANsiuwAKFKoAiSYvAGSDdgAJOzMADpQaAFE6qgAdo8IAr+2uAFwmEgBtwk0ALXqcAMBWlwADP4MACfD2ACtAjABtMZkAObQHAAwgFQDYw1sA9ZLEAMatSwBOyqUApzfNAOapNgCrkpQA3UJoABlj3gB2jO8AaItSAPzbNwCuoasA3xUxAACuoQAM+9oAZE1mAO0FtwApZTAAV1a/AEf/OgBq+bkAdb7zACiT3wCrgDAAZoz2AATLFQD6IgYA2eQdAD2zpABXG48ANs0JAE5C6QATvqQAMyO1APCqGgBPZagA0sGlAAs/DwBbeM0AI/l2AHuLBACJF3IAxqZTAG9u4gDv6wAAm0pYAMTatwCqZroAds/PANECHQCx8S0AjJnBAMOtdwCGSNoA912gAMaA9ACs8C8A3eyaAD9cvADQ3m0AkMcfACrbtgCjJToAAK+aAK1TkwC2VwQAKS20AEuAfgDaB6cAdqoOAHtZoQAWEioA3LctAPrl/QCJ2/4Aib79AOR2bAAGqfwAPoBwAIVuFQD9h/8AKD4HAGFnMwAqGIYATb3qALPnrwCPbW4AlWc5ADG/WwCE10gAMN8WAMctQwAlYTUAyXDOADDLuAC/bP0ApACiAAVs5ABa3aAAIW9HAGIS0gC5XIQAcGFJAGtW4ACZUgEAUFU3AB7VtwAz8cQAE25fAF0w5ACFLqkAHbLDAKEyNgAIt6QA6rHUABb3IQCPaeQAJ/93AAwDgACNQC0AT82gACClmQCzotMAL10KALT5QgAR2ssAfb7QAJvbwQCrF70AyqKBAAhqXAAuVRcAJwBVAH8U8ADhB4YAFAtkAJZBjQCHvt4A2v0qAGsltgB7iTQABfP+ALm/ngBoak8ASiqoAE/EWgAt+LwA11qYAPTHlQANTY0AIDqmAKRXXwAUP7EAgDiVAMwgAQBx3YYAyd62AL9g9QBNZREAAQdrAIywrACywNAAUVVIAB77DgCVcsMAowY7AMBANQAG3HsA4EXMAE4p+gDWysgA6PNBAHxk3gCbZNgA2b4xAKSXwwB3WNQAaePFAPDaEwC6OjwARhhGAFV1XwDSvfUAbpLGAKwuXQAORO0AHD5CAGHEhwAp/ekA59bzACJ8ygBvkTUACODFAP/XjQBuauIAsP3GAJMIwQB8XXQAa62yAM1unQA+cnsAxhFqAPfPqQApc98Atcm6ALcAUQDisg0AdLokAOV9YAB02IoADRUsAIEYDAB+ZpQAASkWAJ96dgD9/b4AVkXvANl+NgDs2RMAi7q5AMSX/AAxqCcA8W7DAJTFNgDYqFYAtKi1AM/MDgASiS0Ab1c0ACxWiQCZzuMA1iC5AGteqgA+KpwAEV/MAP0LSgDh9PsAjjttAOKGLADp1IQA/LSpAO/u0QAuNckALzlhADghRAAb2cgAgfwKAPtKagAvHNgAU7SEAE6ZjABUIswAKlXcAMDG1gALGZYAGnC4AGmVZAAmWmAAP1LuAH8RDwD0tREA/Mv1ADS8LQA0vO4A6F3MAN1eYABnjpsAkjPvAMkXuABhWJsA4Ve8AFGDxgDYPhAA3XFIAC0c3QCvGKEAISxGAFnz1wDZepgAnlTAAE+G+gBWBvwA5XmuAIkiNgA4rSIAZ5PcAFXoqgCCJjgAyuebAFENpACZM7EAqdcOAGkFSABlsvAAf4inAIhMlwD50TYAIZKzAHuCSgCYzyEAQJ/cANxHVQDhdDoAZ+tCAP6d3wBe1F8Ae2ekALqsegBV9qIAK4gjAEG6VQBZbggAISqGADlHgwCJ4+YA5Z7UAEn7QAD/VukAHA/KAMVZigCU+isA08HFAA/FzwDbWq4AR8WGAIVDYgAhhjsALHmUABBhhwAqTHsAgCwaAEO/EgCIJpAAeDyJAKjE5ADl23sAxDrCACb06gD3Z4oADZK/AGWjKwA9k7EAvXwLAKRR3AAn3WMAaeHdAJqUGQCoKZUAaM4oAAnttABEnyAATpjKAHCCYwB+fCMAD7kyAKf1jgAUVucAIfEIALWdKgBvfk0ApRlRALX5qwCC39YAlt1hABY2AgDEOp8Ag6KhAHLtbQA5jXoAgripAGsyXABGJ1sAADTtANIAdwD89FUAAVlNAOBxgA==");
		  base64DecodeToExistingUint8Array(bufferView, 27875, "QPsh+T8AAAAALUR0PgAAAICYRvg8AAAAYFHMeDsAAACAgxvwOQAAAEAgJXo4AAAAgCKC4zYAAAAAHfNpNWFzc2VydGlvbiBmYWlsZWQ6IF9rPjAAY2VsdC9jd3JzLmM=");
		  base64DecodeToExistingUint8Array(bufferView, 27984, "sG0AAHBwAAAscwAA5HUAAJh4AABIewAA9H0AAFx/AAAYgAAAjIAAANiAAAAQgQAAMIEAAEiBAABUgQAAYXNzZXJ0aW9uIGZhaWxlZDogX24+PTI=");
		  base64DecodeToExistingUint8Array(bufferView, 28080, "AQ==");
		  base64DecodeToExistingUint8Array(bufferView, 28788, "AQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAADAAAABQAAAAcAAAAJAAAACwAAAA0AAAAPAAAAEQAAABMAAAAVAAAAFwAAABkAAAAbAAAAHQAAAB8AAAAhAAAAIwAAACUAAAAnAAAAKQAAACsAAAAtAAAALwAAADEAAAAzAAAANQAAADcAAAA5AAAAOwAAAD0AAAA/AAAAQQAAAEMAAABFAAAARwAAAEkAAABLAAAATQAAAE8AAABRAAAAUwAAAFUAAABXAAAAWQAAAFsAAABdAAAAXwAAAGEAAABjAAAA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");
		  base64DecodeToExistingUint8Array(bufferView, 33761, "QMpFG0z/UoJas2Kia2B1YXNzZXJ0aW9uIGZhaWxlZDogcW4gPD0gMjU2AGFzc2VydGlvbiBmYWlsZWQ6IHggIT0geQBjZWx0L2NlbHRfbHBjLmMAYXNzZXJ0aW9uIGZhaWxlZDogKG9yZCYzKT09MABhc3NlcnRpb24gZmFpbGVkOiBuPjAAYXNzZXJ0aW9uIGZhaWxlZDogb3ZlcmxhcD49MABhc3NlcnRpb24gZmFpbGVkOiBsZW4+PTMALi9jZWx0L3BpdGNoLmgAYXNzZXJ0aW9uIGZhaWxlZDogbWF4X3BpdGNoPjAAY2VsdC9waXRjaC5jAGFzc2VydGlvbiBmYWlsZWQ6IGxlbj4wAGFzc2VydGlvbiBmYWlsZWQ6IGxlbj49MwAuL2NlbHQvcGl0Y2guaABjZWx0L2tpc3NfZmZ0LmMAYXNzZXJ0aW9uIGZhaWxlZDogbT09NABhc3NlcnRpb24gZmFpbGVkOiBzdC0+bW9kZSA9PSBvcHVzX2N1c3RvbV9tb2RlX2NyZWF0ZSg0ODAwMCwgOTYwLCBOVUxMKQBjZWx0L2NlbHRfZGVjb2Rlci5jAGFzc2VydGlvbiBmYWlsZWQ6IHN0LT5vdmVybGFwID09IDEyMABhc3NlcnRpb24gZmFpbGVkOiBzdC0+Y2hhbm5lbHMgPT0gMSB8fCBzdC0+Y2hhbm5lbHMgPT0gMgBhc3NlcnRpb24gZmFpbGVkOiBzdC0+c3RyZWFtX2NoYW5uZWxzID09IDEgfHwgc3QtPnN0cmVhbV9jaGFubmVscyA9PSAyAGFzc2VydGlvbiBmYWlsZWQ6IHN0LT5kb3duc2FtcGxlID4gMABhc3NlcnRpb24gZmFpbGVkOiBzdC0+c3RhcnQgPT0gMCB8fCBzdC0+c3RhcnQgPT0gMTcAYXNzZXJ0aW9uIGZhaWxlZDogc3QtPnN0YXJ0IDwgc3QtPmVuZABhc3NlcnRpb24gZmFpbGVkOiBzdC0+ZW5kIDw9IDIxAGFzc2VydGlvbiBmYWlsZWQ6IHN0LT5hcmNoID49IDAAYXNzZXJ0aW9uIGZhaWxlZDogc3QtPmFyY2ggPD0gT1BVU19BUkNITUFTSwBhc3NlcnRpb24gZmFpbGVkOiBzdC0+bGFzdF9waXRjaF9pbmRleCA8PSBQTENfUElUQ0hfTEFHX01BWABhc3NlcnRpb24gZmFpbGVkOiBzdC0+bGFzdF9waXRjaF9pbmRleCA+PSBQTENfUElUQ0hfTEFHX01JTiB8fCBzdC0+bGFzdF9waXRjaF9pbmRleCA9PSAwAGFzc2VydGlvbiBmYWlsZWQ6IHN0LT5wb3N0ZmlsdGVyX3BlcmlvZCA8IE1BWF9QRVJJT0QAYXNzZXJ0aW9uIGZhaWxlZDogc3QtPnBvc3RmaWx0ZXJfcGVyaW9kID49IENPTUJGSUxURVJfTUlOUEVSSU9EIHx8IHN0LT5wb3N0ZmlsdGVyX3BlcmlvZCA9PSAwAGFzc2VydGlvbiBmYWlsZWQ6IHN0LT5wb3N0ZmlsdGVyX3BlcmlvZF9vbGQgPCBNQVhfUEVSSU9EAGFzc2VydGlvbiBmYWlsZWQ6IHN0LT5wb3N0ZmlsdGVyX3BlcmlvZF9vbGQgPj0gQ09NQkZJTFRFUl9NSU5QRVJJT0QgfHwgc3QtPnBvc3RmaWx0ZXJfcGVyaW9kX29sZCA9PSAwAGFzc2VydGlvbiBmYWlsZWQ6IHN0LT5wb3N0ZmlsdGVyX3RhcHNldCA8PSAyAGFzc2VydGlvbiBmYWlsZWQ6IHN0LT5wb3N0ZmlsdGVyX3RhcHNldCA+PSAwAGFzc2VydGlvbiBmYWlsZWQ6IHN0LT5wb3N0ZmlsdGVyX3RhcHNldF9vbGQgPD0gMgBhc3NlcnRpb24gZmFpbGVkOiBzdC0+cG9zdGZpbHRlcl90YXBzZXRfb2xkID49IDAAAgEAGRcCAH58d21XKRMJBAIAYXNzZXJ0aW9uIGZhaWxlZDogYWNjdW09PTAAYXNzZXJ0aW9uIGZhaWxlZDogcGNtX2NvdW50ID09IGZyYW1lX3NpemUAc3JjL29wdXNfZGVjb2Rlci5jAGFzc2VydGlvbiBmYWlsZWQ6IHJldD09ZnJhbWVfc2l6ZS1wYWNrZXRfZnJhbWVfc2l6ZQBhc3NlcnRpb24gZmFpbGVkOiByZXQ9PXBhY2tldF9mcmFtZV9zaXplAGFzc2VydGlvbiBmYWlsZWQ6IHN0LT5jaGFubmVscyA9PSAxIHx8IHN0LT5jaGFubmVscyA9PSAyAGFzc2VydGlvbiBmYWlsZWQ6IHN0LT5GcyA9PSA0ODAwMCB8fCBzdC0+RnMgPT0gMjQwMDAgfHwgc3QtPkZzID09IDE2MDAwIHx8IHN0LT5GcyA9PSAxMjAwMCB8fCBzdC0+RnMgPT0gODAwMABhc3NlcnRpb24gZmFpbGVkOiBzdC0+RGVjQ29udHJvbC5BUElfc2FtcGxlUmF0ZSA9PSBzdC0+RnMAYXNzZXJ0aW9uIGZhaWxlZDogc3QtPkRlY0NvbnRyb2wuaW50ZXJuYWxTYW1wbGVSYXRlID09IDAgfHwgc3QtPkRlY0NvbnRyb2wuaW50ZXJuYWxTYW1wbGVSYXRlID09IDE2MDAwIHx8IHN0LT5EZWNDb250cm9sLmludGVybmFsU2FtcGxlUmF0ZSA9PSAxMjAwMCB8fCBzdC0+RGVjQ29udHJvbC5pbnRlcm5hbFNhbXBsZVJhdGUgPT0gODAwMABhc3NlcnRpb24gZmFpbGVkOiBzdC0+RGVjQ29udHJvbC5uQ2hhbm5lbHNBUEkgPT0gc3QtPmNoYW5uZWxzAGFzc2VydGlvbiBmYWlsZWQ6IHN0LT5EZWNDb250cm9sLm5DaGFubmVsc0ludGVybmFsID09IDAgfHwgc3QtPkRlY0NvbnRyb2wubkNoYW5uZWxzSW50ZXJuYWwgPT0gMSB8fCBzdC0+RGVjQ29udHJvbC5uQ2hhbm5lbHNJbnRlcm5hbCA9PSAyAGFzc2VydGlvbiBmYWlsZWQ6IHN0LT5EZWNDb250cm9sLnBheWxvYWRTaXplX21zID09IDAgfHwgc3QtPkRlY0NvbnRyb2wucGF5bG9hZFNpemVfbXMgPT0gMTAgfHwgc3QtPkRlY0NvbnRyb2wucGF5bG9hZFNpemVfbXMgPT0gMjAgfHwgc3QtPkRlY0NvbnRyb2wucGF5bG9hZFNpemVfbXMgPT0gNDAgfHwgc3QtPkRlY0NvbnRyb2wucGF5bG9hZFNpemVfbXMgPT0gNjAAYXNzZXJ0aW9uIGZhaWxlZDogc3QtPmFyY2ggPj0gMABhc3NlcnRpb24gZmFpbGVkOiBzdC0+YXJjaCA8PSBPUFVTX0FSQ0hNQVNLAGFzc2VydGlvbiBmYWlsZWQ6IHN0LT5zdHJlYW1fY2hhbm5lbHMgPT0gMSB8fCBzdC0+c3RyZWFtX2NoYW5uZWxzID09IDIAYXNzZXJ0aW9uIGZhaWxlZDogMABhc3NlcnRpb24gZmFpbGVkOiAob3B1c19jdXN0b21fZGVjb2Rlcl9jdGwoY2VsdF9kZWMsIDEwMDEyLCAoKCh2b2lkKSgoZW5kYmFuZCkgPT0gKG9wdXNfaW50MzIpMCkpLCAob3B1c19pbnQzMikoZW5kYmFuZCkpKSkgPT0gT1BVU19PSwBhc3NlcnRpb24gZmFpbGVkOiAob3B1c19jdXN0b21fZGVjb2Rlcl9jdGwoY2VsdF9kZWMsIDEwMDA4LCAoKCh2b2lkKSgoc3QtPnN0cmVhbV9jaGFubmVscykgPT0gKG9wdXNfaW50MzIpMCkpLCAob3B1c19pbnQzMikoc3QtPnN0cmVhbV9jaGFubmVscykpKSkgPT0gT1BVU19PSwBhc3NlcnRpb24gZmFpbGVkOiAob3B1c19jdXN0b21fZGVjb2Rlcl9jdGwoY2VsdF9kZWMsIDEwMDEwLCAoKCh2b2lkKSgoMCkgPT0gKG9wdXNfaW50MzIpMCkpLCAob3B1c19pbnQzMikoMCkpKSkgPT0gT1BVU19PSwBhc3NlcnRpb24gZmFpbGVkOiAob3B1c19jdXN0b21fZGVjb2Rlcl9jdGwoY2VsdF9kZWMsIDQwMzEsICgoJnJlZHVuZGFudF9ybmcpICsgKCgmcmVkdW5kYW50X3JuZykgLSAob3B1c191aW50MzIqKSgmcmVkdW5kYW50X3JuZykpKSkpID09IE9QVVNfT0sAYXNzZXJ0aW9uIGZhaWxlZDogKG9wdXNfY3VzdG9tX2RlY29kZXJfY3RsKGNlbHRfZGVjLCAxMDAxMCwgKCgodm9pZCkoKHN0YXJ0X2JhbmQpID09IChvcHVzX2ludDMyKTApKSwgKG9wdXNfaW50MzIpKHN0YXJ0X2JhbmQpKSkpID09IE9QVVNfT0sAYXNzZXJ0aW9uIGZhaWxlZDogKG9wdXNfY3VzdG9tX2RlY29kZXJfY3RsKGNlbHRfZGVjLCA0MDI4KSkgPT0gT1BVU19PSwBhc3NlcnRpb24gZmFpbGVkOiAob3B1c19jdXN0b21fZGVjb2Rlcl9jdGwoY2VsdF9kZWMsIDEwMDE1LCAoKCZjZWx0X21vZGUpICsgKCgmY2VsdF9tb2RlKSAtIChjb25zdCBPcHVzQ3VzdG9tTW9kZSoqKSgmY2VsdF9tb2RlKSkpKSkgPT0gT1BVU19PSwAAAAAIAAAABAAAAOF6VD/2KFw/zJIAABAAAAAEAAAAmplZP65HYT/MkgAAIAAAAAQAAADBymE/w/VoP8ySAAAwAAAACAAAALgeZT+DwGo/1JIAAEAAAAAIAAAAqMZrP9ejcD/UkgAAUAAAABAAAAAxCGw/16NwP9ySAABgAAAAEAAAANejcD+F63E/3JIAAIAAAAAQAAAAMzNzPzMzcz/ckgAAoAAAABAAAACPwnU/j8J1P9ySAADAAAAAIAAAANnOdz/Zznc/5JIAAAABAAAgAAAAmpl5P5qZeT/kkgAA8JIAACAAAAAQlAAAIAAAADCVAAAgAAAAUJYAAEAAAAAAAAAAJZHguiDq7z8AAAAAAADwPyWR4Log6u8/3ksrz82o7z9aH/+a5jzvP1XPF7Xap+4/vqBk9qLr7T/XkG46uArtP4voz2UHCOw/td5vtOPm6j9YAHQU96rpPyJyVTQxWOg/UMWuabXy5j9Y5LYByH7lP5RFJ2y7AOQ/RytKS9184j+po+NqZPfgP6qpl6W+6N4/FsR6gkjv2z9LZsyPhQnZPz/p4VfuPdY/wmpufT+S0z+gvqdqaQvRPytyXzkIW80/J5liL5D3yD+hB8qvF/HEP8pirICMSsE/IsW+bFQKvD9hhQCFH0G2P4/ecB+5NbE/Q4TJnk7DqT8he3vfEXiiP/NHKOi855g/We0O5+l1jj8hAg6hSs1+PwAAAAAAAAAAwVNMzh7i7z8AAAAAAADwP8FTTM4e4u8/z0LImg2J7z8MbeeYf/buP4gSLXk8Le4/mk30twwx7T+1sMC6ngbsP8yZDhlms+o/3Hksx3U96T9RqyK7VqvnP5U2yU3cA+Y/davnpPdN5D93AJvei5DiPxOB6h9E0uA/xgDD0dky3j9TPgRVo9faP9kIYcE/ndc/qGoG4Z+M1D9uJH0YKa3RP1rvefZDCc4/GwBgK1cuyT9RlmsbkM7EP4vsWq3Z68A/6dYpXn4Kuz/fF/rUby61PwYNgUwAOLA/yr1E5fQvqD+mFfjtmHihP0v1U9J5Q5g/lM+f9I0BkD8Abjc9/6iDP95pGUbNmXU/4IWMy+EoYz/8qfHSTWJAPwAAAAAAAAAAuaajkCLa7z8AAAAAAADwP7mmo5Ai2u8/hQsW2ntp7z9ERs1417DuPyZTw4bAtO0/M9ouXVZ77D+pzhc5EwzrP6nqcSGHb+k/cuaRHgqv5z/W0WnEadTlP8CnpBSV6eM/OaAA5Ur44T/qgxvfzQngP1Vq1TJCTdw/Q13e+5+s2D8PWvbBhT7VPx8F28pDDdI/oGc3IxhBzj+Mi3rz4frIP/CuSIb7TMQ/dOMnH8w3wD/uYYrNIm+5PztOVcoAirM/6GEuyuhXrT8kM80qInmlP7tpbfnMgp4/Iix0b4/vlD8+Ed0W2YyLP13CX5umMoE/UAiy2AUHdD+ByCq+BBtlP9zuq5Ov21I/G8qaom1GNz8=");
		  base64DecodeToExistingUint8Array(bufferView, 38480, "yFEM0oT07z8AAAAAAADwP8hRDNKE9O8/9pUH6SnS7z/a08TxMpnvP9T9ENkPSu8/fp+7blvl7j9hwT+d2WvuPx3X8SV13u0/an9v7Dw+7T/J6jXBYIzsP3ckRQEuyus/Hrx+2gv56j860L80dxrqP/UlI4D+L+k/8kBDgz076D8OB1Pe2D3nP/fyr6N5OeY/TMjFIMkv5T/OuHiRbCLkP/+ZWhkBE+M/L5wx7RcD4j9j2QbNMvTgP01ahnKBz98/zY9k+zW+3T8VxjeQBbfbP+AHrag9vNk/YDMKk/PP1z/zHfzEAfTVP0qFZ/gFKtQ/5808FGBz0j+NyjQ3MtHQP9jRevDBiM4/ryd4Eiqbyz/ISJPeedrIP7XPWyMfR8Y/PVdCFB/hwz+1zQFAHajBP026kLvGNr8/LgwmONRzuz9mkgUKxAS4P4BUFsd55rQ/YkhOJm4Vsj+kFYSXhRuvP+yy6yCnlqo/l6hBRZOTpj8+eC/vWAmjP9XnrEfI3Z8/bM9NFzl2mj/08djo/8mVPw8LtaZ5x5E/VRds+h67jD/+pLEosveGPzy3lup+JYI/pfu1zFROfD9nH1R3n8J1PwXEfxU7dXA/dH+znJ1vaD/T8PMAksBhP/dS2/qnI1k/P8Gs7XlAUT/xQgCR+sJGP3uyzVM+gDw/JlGSIvCPMD/HVG5gehQhP32Jfzcgqws/8WjjiLX45D4=");
		  base64DecodeToExistingUint8Array(bufferView, 39024, "MJxQAAAAAAAF");
		  base64DecodeToExistingUint8Array(bufferView, 39044, "AQ==");
		  base64DecodeToExistingUint8Array(bufferView, 39068, "AgAAAAMAAADomw==");
		  base64DecodeToExistingUint8Array(bufferView, 39092, "Ag==");
		  base64DecodeToExistingUint8Array(bufferView, 39107, "//////8=");
		  base64DecodeToExistingUint8Array(bufferView, 39348, "EJw=");
		}

		  var scratchBuffer = new ArrayBuffer(16);
		  var i32ScratchView = new Int32Array(scratchBuffer);
		  var f32ScratchView = new Float32Array(scratchBuffer);
		  var f64ScratchView = new Float64Array(scratchBuffer);
		  
		  function wasm2js_scratch_load_i32(index) {
		    return i32ScratchView[index];
		  }
		      
		  function wasm2js_scratch_store_i32(index, value) {
		    i32ScratchView[index] = value;
		  }
		      
		  function wasm2js_scratch_load_f64() {
		    return f64ScratchView[0];
		  }
		      
		  function wasm2js_scratch_store_f64(value) {
		    f64ScratchView[0] = value;
		  }
		      
		  function wasm2js_scratch_store_f32(value) {
		    f32ScratchView[2] = value;
		  }
		      
		  function wasm2js_scratch_load_f32() {
		    return f32ScratchView[2];
		  }
		      
		function asmFunc(env) {
		 var memory = env.memory;
		 var buffer = memory.buffer;
		 var HEAP8 = new Int8Array(buffer);
		 var HEAP16 = new Int16Array(buffer);
		 var HEAP32 = new Int32Array(buffer);
		 var HEAPU8 = new Uint8Array(buffer);
		 var HEAPU16 = new Uint16Array(buffer);
		 var HEAPU32 = new Uint32Array(buffer);
		 var HEAPF32 = new Float32Array(buffer);
		 var HEAPF64 = new Float64Array(buffer);
		 var Math_imul = Math.imul;
		 var Math_fround = Math.fround;
		 var Math_abs = Math.abs;
		 var Math_clz32 = Math.clz32;
		 var Math_min = Math.min;
		 var Math_max = Math.max;
		 var Math_floor = Math.floor;
		 var Math_sqrt = Math.sqrt;
		 var abort = env.abort;
		 var emscripten_resize_heap = env.emscripten_resize_heap;
		 var emscripten_memcpy_big = env.emscripten_memcpy_big;
		 var __wasi_fd_close = env.fd_close;
		 var __wasi_fd_write = env.fd_write;
		 var abort = env.abort;
		 var setTempRet0 = env.setTempRet0;
		 var legalimport$__wasi_fd_seek = env.fd_seek;
		 var __stack_pointer = 5282864;
		 var i64toi32_i32$HIGH_BITS = 0;
		 // EMSCRIPTEN_START_FUNCS
		function dlmalloc($0) {
		 $0 = $0 | 0;
		 var $1 = 0, $2 = 0, $3 = 0, $4 = 0, $5 = 0, $6 = 0, $7 = 0, $8 = 0, $9 = 0, $10 = 0, $11 = 0, $12 = 0;
		 $12 = __stack_pointer - 16 | 0;
		 __stack_pointer = $12;
		 label$1 : {
		  label$2 : {
		   label$3 : {
		    label$4 : {
		     label$5 : {
		      label$6 : {
		       label$7 : {
		        label$8 : {
		         label$9 : {
		          label$10 : {
		           label$11 : {
		            label$12 : {
		             if ($0 >>> 0 <= 244) {
		              $6 = HEAP32[9852];
		              $4 = $0 >>> 0 < 11 ? 16 : $0 + 11 & -8;
		              $2 = $4 >>> 3 | 0;
		              $0 = $6 >>> $2 | 0;
		              if ($0 & 3) {
		               $4 = (($0 ^ -1) & 1) + $2 | 0;
		               $3 = $4 << 3;
		               $2 = HEAP32[$3 + 39456 >> 2];
		               $0 = $2 + 8 | 0;
		               $1 = HEAP32[$2 + 8 >> 2];
		               $3 = $3 + 39448 | 0;
		               label$15 : {
		                if (($1 | 0) == ($3 | 0)) {
		                 HEAP32[9852] = __wasm_rotl_i32(-2, $4) & $6;
		                 break label$15;
		                }
		                HEAP32[$1 + 12 >> 2] = $3;
		                HEAP32[$3 + 8 >> 2] = $1;
		               }
		               $1 = $4 << 3;
		               HEAP32[$2 + 4 >> 2] = $1 | 3;
		               $2 = $2 + $1 | 0;
		               HEAP32[$2 + 4 >> 2] = HEAP32[$2 + 4 >> 2] | 1;
		               break label$1;
		              }
		              $9 = HEAP32[9854];
		              if ($9 >>> 0 >= $4 >>> 0) {
		               break label$12;
		              }
		              if ($0) {
		               $1 = $0 << $2;
		               $0 = 2 << $2;
		               $0 = $1 & ($0 | 0 - $0);
		               $0 = ($0 & 0 - $0) - 1 | 0;
		               $1 = $0;
		               $0 = $0 >>> 12 & 16;
		               $2 = $1 >>> $0 | 0;
		               $1 = $2 >>> 5 & 8;
		               $3 = $0 | $1;
		               $0 = $2 >>> $1 | 0;
		               $2 = $0 >>> 2 & 4;
		               $1 = $3 | $2;
		               $0 = $0 >>> $2 | 0;
		               $2 = $0 >>> 1 & 2;
		               $1 = $1 | $2;
		               $0 = $0 >>> $2 | 0;
		               $2 = $0 >>> 1 & 1;
		               $1 = ($1 | $2) + ($0 >>> $2 | 0) | 0;
		               $3 = $1 << 3;
		               $2 = HEAP32[$3 + 39456 >> 2];
		               $0 = HEAP32[$2 + 8 >> 2];
		               $3 = $3 + 39448 | 0;
		               label$18 : {
		                if (($0 | 0) == ($3 | 0)) {
		                 $6 = __wasm_rotl_i32(-2, $1) & $6;
		                 HEAP32[9852] = $6;
		                 break label$18;
		                }
		                HEAP32[$0 + 12 >> 2] = $3;
		                HEAP32[$3 + 8 >> 2] = $0;
		               }
		               $0 = $2 + 8 | 0;
		               HEAP32[$2 + 4 >> 2] = $4 | 3;
		               $3 = $2 + $4 | 0;
		               $5 = $1 << 3;
		               $1 = $5 - $4 | 0;
		               HEAP32[$3 + 4 >> 2] = $1 | 1;
		               HEAP32[$2 + $5 >> 2] = $1;
		               if ($9) {
		                $5 = $9 >>> 3 | 0;
		                $4 = ($5 << 3) + 39448 | 0;
		                $2 = HEAP32[9857];
		                $5 = 1 << $5;
		                label$21 : {
		                 if (!($6 & $5)) {
		                  HEAP32[9852] = $5 | $6;
		                  $5 = $4;
		                  break label$21;
		                 }
		                 $5 = HEAP32[$4 + 8 >> 2];
		                }
		                HEAP32[$4 + 8 >> 2] = $2;
		                HEAP32[$5 + 12 >> 2] = $2;
		                HEAP32[$2 + 12 >> 2] = $4;
		                HEAP32[$2 + 8 >> 2] = $5;
		               }
		               HEAP32[9857] = $3;
		               HEAP32[9854] = $1;
		               break label$1;
		              }
		              $8 = HEAP32[9853];
		              if (!$8) {
		               break label$12;
		              }
		              $0 = (0 - $8 & $8) - 1 | 0;
		              $1 = $0;
		              $0 = $0 >>> 12 & 16;
		              $2 = $1 >>> $0 | 0;
		              $1 = $2 >>> 5 & 8;
		              $3 = $0 | $1;
		              $0 = $2 >>> $1 | 0;
		              $2 = $0 >>> 2 & 4;
		              $1 = $3 | $2;
		              $0 = $0 >>> $2 | 0;
		              $2 = $0 >>> 1 & 2;
		              $1 = $1 | $2;
		              $0 = $0 >>> $2 | 0;
		              $2 = $0 >>> 1 & 1;
		              $3 = HEAP32[(($1 | $2) + ($0 >>> $2 | 0) << 2) + 39712 >> 2];
		              $2 = (HEAP32[$3 + 4 >> 2] & -8) - $4 | 0;
		              $1 = $3;
		              while (1) {
		               label$24 : {
		                $0 = HEAP32[$1 + 16 >> 2];
		                if (!$0) {
		                 $0 = HEAP32[$1 + 20 >> 2];
		                 if (!$0) {
		                  break label$24;
		                 }
		                }
		                $1 = (HEAP32[$0 + 4 >> 2] & -8) - $4 | 0;
		                $5 = $1;
		                $1 = $2 >>> 0 > $1 >>> 0;
		                $2 = $1 ? $5 : $2;
		                $3 = $1 ? $0 : $3;
		                $1 = $0;
		                continue;
		               }
		               break;
		              }
		              $10 = $3 + $4 | 0;
		              if ($10 >>> 0 <= $3 >>> 0) {
		               break label$11;
		              }
		              $11 = HEAP32[$3 + 24 >> 2];
		              $5 = HEAP32[$3 + 12 >> 2];
		              if (($5 | 0) != ($3 | 0)) {
		               $0 = HEAP32[$3 + 8 >> 2];
		               HEAP32[$0 + 12 >> 2] = $5;
		               HEAP32[$5 + 8 >> 2] = $0;
		               break label$2;
		              }
		              $1 = $3 + 20 | 0;
		              $0 = HEAP32[$1 >> 2];
		              if (!$0) {
		               $0 = HEAP32[$3 + 16 >> 2];
		               if (!$0) {
		                break label$10;
		               }
		               $1 = $3 + 16 | 0;
		              }
		              while (1) {
		               $7 = $1;
		               $5 = $0;
		               $1 = $0 + 20 | 0;
		               $0 = HEAP32[$1 >> 2];
		               if ($0) {
		                continue;
		               }
		               $1 = $5 + 16 | 0;
		               $0 = HEAP32[$5 + 16 >> 2];
		               if ($0) {
		                continue;
		               }
		               break;
		              }
		              HEAP32[$7 >> 2] = 0;
		              break label$2;
		             }
		             $4 = -1;
		             if ($0 >>> 0 > 4294967231) {
		              break label$12;
		             }
		             $0 = $0 + 11 | 0;
		             $4 = $0 & -8;
		             $9 = HEAP32[9853];
		             if (!$9) {
		              break label$12;
		             }
		             $7 = 31;
		             if ($4 >>> 0 <= 16777215) {
		              $0 = $0 >>> 8 | 0;
		              $1 = $0;
		              $0 = $0 + 1048320 >>> 16 & 8;
		              $2 = $1 << $0;
		              $1 = $2;
		              $2 = $2 + 520192 >>> 16 & 4;
		              $1 = $1 << $2;
		              $3 = $1;
		              $1 = $1 + 245760 >>> 16 & 2;
		              $0 = ($3 << $1 >>> 15 | 0) - ($0 | $2 | $1) | 0;
		              $7 = ($0 << 1 | $4 >>> $0 + 21 & 1) + 28 | 0;
		             }
		             $2 = 0 - $4 | 0;
		             $1 = HEAP32[($7 << 2) + 39712 >> 2];
		             label$31 : {
		              label$32 : {
		               label$33 : {
		                if (!$1) {
		                 $0 = 0;
		                 break label$33;
		                }
		                $0 = 0;
		                $3 = $4 << (($7 | 0) == 31 ? 0 : 25 - ($7 >>> 1 | 0) | 0);
		                while (1) {
		                 label$36 : {
		                  $6 = (HEAP32[$1 + 4 >> 2] & -8) - $4 | 0;
		                  if ($6 >>> 0 >= $2 >>> 0) {
		                   break label$36;
		                  }
		                  $5 = $1;
		                  $2 = $6;
		                  if ($2) {
		                   break label$36;
		                  }
		                  $2 = 0;
		                  $0 = $1;
		                  break label$32;
		                 }
		                 $6 = HEAP32[$1 + 20 >> 2];
		                 $1 = HEAP32[(($3 >>> 29 & 4) + $1 | 0) + 16 >> 2];
		                 $0 = $6 ? ($6 | 0) == ($1 | 0) ? $0 : $6 : $0;
		                 $3 = $3 << 1;
		                 if ($1) {
		                  continue;
		                 }
		                 break;
		                }
		               }
		               if (!($0 | $5)) {
		                $0 = 2 << $7;
		                $0 = ($0 | 0 - $0) & $9;
		                if (!$0) {
		                 break label$12;
		                }
		                $0 = (0 - $0 & $0) - 1 | 0;
		                $1 = $0;
		                $0 = $0 >>> 12 & 16;
		                $1 = $1 >>> $0 | 0;
		                $3 = $1 >>> 5 & 8;
		                $6 = $0 | $3;
		                $0 = $1 >>> $3 | 0;
		                $1 = $0 >>> 2 & 4;
		                $3 = $6 | $1;
		                $0 = $0 >>> $1 | 0;
		                $1 = $0 >>> 1 & 2;
		                $3 = $3 | $1;
		                $0 = $0 >>> $1 | 0;
		                $1 = $0 >>> 1 & 1;
		                $0 = HEAP32[(($3 | $1) + ($0 >>> $1 | 0) << 2) + 39712 >> 2];
		               }
		               if (!$0) {
		                break label$31;
		               }
		              }
		              while (1) {
		               $6 = (HEAP32[$0 + 4 >> 2] & -8) - $4 | 0;
		               $3 = $6 >>> 0 < $2 >>> 0;
		               $2 = $3 ? $6 : $2;
		               $5 = $3 ? $0 : $5;
		               $1 = HEAP32[$0 + 16 >> 2];
		               if (!$1) {
		                $1 = HEAP32[$0 + 20 >> 2];
		               }
		               $0 = $1;
		               if ($0) {
		                continue;
		               }
		               break;
		              }
		             }
		             if (!$5 | HEAP32[9854] - $4 >>> 0 <= $2 >>> 0) {
		              break label$12;
		             }
		             $7 = $4 + $5 | 0;
		             if ($7 >>> 0 <= $5 >>> 0) {
		              break label$11;
		             }
		             $8 = HEAP32[$5 + 24 >> 2];
		             $3 = HEAP32[$5 + 12 >> 2];
		             if (($5 | 0) != ($3 | 0)) {
		              $0 = HEAP32[$5 + 8 >> 2];
		              HEAP32[$0 + 12 >> 2] = $3;
		              HEAP32[$3 + 8 >> 2] = $0;
		              break label$3;
		             }
		             $1 = $5 + 20 | 0;
		             $0 = HEAP32[$1 >> 2];
		             if (!$0) {
		              $0 = HEAP32[$5 + 16 >> 2];
		              if (!$0) {
		               break label$9;
		              }
		              $1 = $5 + 16 | 0;
		             }
		             while (1) {
		              $6 = $1;
		              $3 = $0;
		              $1 = $0 + 20 | 0;
		              $0 = HEAP32[$1 >> 2];
		              if ($0) {
		               continue;
		              }
		              $1 = $3 + 16 | 0;
		              $0 = HEAP32[$3 + 16 >> 2];
		              if ($0) {
		               continue;
		              }
		              break;
		             }
		             HEAP32[$6 >> 2] = 0;
		             break label$3;
		            }
		            $0 = HEAP32[9854];
		            if ($4 >>> 0 <= $0 >>> 0) {
		             $2 = HEAP32[9857];
		             $1 = $0 - $4 | 0;
		             label$45 : {
		              if ($1 >>> 0 >= 16) {
		               HEAP32[9854] = $1;
		               $3 = $2 + $4 | 0;
		               HEAP32[9857] = $3;
		               HEAP32[$3 + 4 >> 2] = $1 | 1;
		               HEAP32[$0 + $2 >> 2] = $1;
		               HEAP32[$2 + 4 >> 2] = $4 | 3;
		               break label$45;
		              }
		              HEAP32[9857] = 0;
		              HEAP32[9854] = 0;
		              HEAP32[$2 + 4 >> 2] = $0 | 3;
		              $0 = $0 + $2 | 0;
		              HEAP32[$0 + 4 >> 2] = HEAP32[$0 + 4 >> 2] | 1;
		             }
		             $0 = $2 + 8 | 0;
		             break label$1;
		            }
		            $3 = HEAP32[9855];
		            if ($4 >>> 0 < $3 >>> 0) {
		             $2 = $3 - $4 | 0;
		             HEAP32[9855] = $2;
		             $0 = HEAP32[9858];
		             $1 = $4 + $0 | 0;
		             HEAP32[9858] = $1;
		             HEAP32[$1 + 4 >> 2] = $2 | 1;
		             HEAP32[$0 + 4 >> 2] = $4 | 3;
		             $0 = $0 + 8 | 0;
		             break label$1;
		            }
		            $0 = 0;
		            $9 = $4 + 47 | 0;
		            $1 = $9;
		            if (HEAP32[9970]) {
		             $2 = HEAP32[9972];
		            } else {
		             HEAP32[9973] = -1;
		             HEAP32[9974] = -1;
		             HEAP32[9971] = 4096;
		             HEAP32[9972] = 4096;
		             HEAP32[9970] = $12 + 12 & -16 ^ 1431655768;
		             HEAP32[9975] = 0;
		             HEAP32[9963] = 0;
		             $2 = 4096;
		            }
		            $6 = $1 + $2 | 0;
		            $7 = 0 - $2 | 0;
		            $5 = $6 & $7;
		            if ($5 >>> 0 <= $4 >>> 0) {
		             break label$1;
		            }
		            $2 = HEAP32[9962];
		            if ($2) {
		             $1 = HEAP32[9960];
		             $8 = $5 + $1 | 0;
		             if ($2 >>> 0 < $8 >>> 0 | $1 >>> 0 >= $8 >>> 0) {
		              break label$1;
		             }
		            }
		            if (HEAPU8[39852] & 4) {
		             break label$6;
		            }
		            label$51 : {
		             label$52 : {
		              $2 = HEAP32[9858];
		              if ($2) {
		               $0 = 39856;
		               while (1) {
		                $1 = HEAP32[$0 >> 2];
		                if (HEAP32[$0 + 4 >> 2] + $1 >>> 0 > $2 >>> 0 ? $1 >>> 0 <= $2 >>> 0 : 0) {
		                 break label$52;
		                }
		                $0 = HEAP32[$0 + 8 >> 2];
		                if ($0) {
		                 continue;
		                }
		                break;
		               }
		              }
		              $3 = sbrk(0);
		              if (($3 | 0) == -1) {
		               break label$7;
		              }
		              $6 = $5;
		              $0 = HEAP32[9971];
		              $2 = $0 - 1 | 0;
		              if ($3 & $2) {
		               $6 = ($5 - $3 | 0) + ($2 + $3 & 0 - $0) | 0;
		              }
		              if ($6 >>> 0 > 2147483646 | $4 >>> 0 >= $6 >>> 0) {
		               break label$7;
		              }
		              $0 = HEAP32[9962];
		              if ($0) {
		               $2 = HEAP32[9960];
		               $1 = $6 + $2 | 0;
		               if ($0 >>> 0 < $1 >>> 0 | $2 >>> 0 >= $1 >>> 0) {
		                break label$7;
		               }
		              }
		              $0 = sbrk($6);
		              if (($3 | 0) != ($0 | 0)) {
		               break label$51;
		              }
		              break label$5;
		             }
		             $6 = $6 - $3 & $7;
		             if ($6 >>> 0 > 2147483646) {
		              break label$7;
		             }
		             $3 = sbrk($6);
		             if (($3 | 0) == (HEAP32[$0 >> 2] + HEAP32[$0 + 4 >> 2] | 0)) {
		              break label$8;
		             }
		             $0 = $3;
		            }
		            if (!(($0 | 0) == -1 | $4 + 48 >>> 0 <= $6 >>> 0)) {
		             $2 = HEAP32[9972];
		             $2 = $2 + ($9 - $6 | 0) & 0 - $2;
		             if ($2 >>> 0 > 2147483646) {
		              $3 = $0;
		              break label$5;
		             }
		             if ((sbrk($2) | 0) != -1) {
		              $6 = $2 + $6 | 0;
		              $3 = $0;
		              break label$5;
		             }
		             sbrk(0 - $6 | 0);
		             break label$7;
		            }
		            $3 = $0;
		            if (($0 | 0) != -1) {
		             break label$5;
		            }
		            break label$7;
		           }
		           abort();
		          }
		          $5 = 0;
		          break label$2;
		         }
		         $3 = 0;
		         break label$3;
		        }
		        if (($3 | 0) != -1) {
		         break label$5;
		        }
		       }
		       HEAP32[9963] = HEAP32[9963] | 4;
		      }
		      if ($5 >>> 0 > 2147483646) {
		       break label$4;
		      }
		      $3 = sbrk($5);
		      $1 = ($3 | 0) == -1;
		      $0 = sbrk(0);
		      if ($1 | $3 >>> 0 >= $0 >>> 0 | ($0 | 0) == -1) {
		       break label$4;
		      }
		      $6 = $0 - $3 | 0;
		      if ($6 >>> 0 <= $4 + 40 >>> 0) {
		       break label$4;
		      }
		     }
		     $0 = HEAP32[9960] + $6 | 0;
		     HEAP32[9960] = $0;
		     if (HEAPU32[9961] < $0 >>> 0) {
		      HEAP32[9961] = $0;
		     }
		     label$62 : {
		      label$63 : {
		       label$64 : {
		        $2 = HEAP32[9858];
		        if ($2) {
		         $0 = 39856;
		         while (1) {
		          $1 = HEAP32[$0 >> 2];
		          $5 = HEAP32[$0 + 4 >> 2];
		          if (($1 + $5 | 0) == ($3 | 0)) {
		           break label$64;
		          }
		          $0 = HEAP32[$0 + 8 >> 2];
		          if ($0) {
		           continue;
		          }
		          break;
		         }
		         break label$63;
		        }
		        $0 = HEAP32[9856];
		        if (!($0 >>> 0 <= $3 >>> 0 ? $0 : 0)) {
		         HEAP32[9856] = $3;
		        }
		        $0 = 0;
		        HEAP32[9965] = $6;
		        HEAP32[9964] = $3;
		        HEAP32[9860] = -1;
		        HEAP32[9861] = HEAP32[9970];
		        HEAP32[9967] = 0;
		        while (1) {
		         $2 = $0 << 3;
		         $1 = $2 + 39448 | 0;
		         HEAP32[$2 + 39456 >> 2] = $1;
		         HEAP32[$2 + 39460 >> 2] = $1;
		         $0 = $0 + 1 | 0;
		         if (($0 | 0) != 32) {
		          continue;
		         }
		         break;
		        }
		        $0 = $6 - 40 | 0;
		        $2 = $3 + 8 & 7 ? -8 - $3 & 7 : 0;
		        $1 = $0 - $2 | 0;
		        HEAP32[9855] = $1;
		        $2 = $2 + $3 | 0;
		        HEAP32[9858] = $2;
		        HEAP32[$2 + 4 >> 2] = $1 | 1;
		        HEAP32[($0 + $3 | 0) + 4 >> 2] = 40;
		        HEAP32[9859] = HEAP32[9974];
		        break label$62;
		       }
		       if (HEAP32[$0 + 12 >> 2] & 8 | ($2 >>> 0 < $1 >>> 0 | $2 >>> 0 >= $3 >>> 0)) {
		        break label$63;
		       }
		       HEAP32[$0 + 4 >> 2] = $5 + $6;
		       $0 = $2 + 8 & 7 ? -8 - $2 & 7 : 0;
		       $1 = $2 + $0 | 0;
		       HEAP32[9858] = $1;
		       $3 = HEAP32[9855] + $6 | 0;
		       $0 = $3 - $0 | 0;
		       HEAP32[9855] = $0;
		       HEAP32[$1 + 4 >> 2] = $0 | 1;
		       HEAP32[($2 + $3 | 0) + 4 >> 2] = 40;
		       HEAP32[9859] = HEAP32[9974];
		       break label$62;
		      }
		      $5 = HEAP32[9856];
		      if ($5 >>> 0 > $3 >>> 0) {
		       HEAP32[9856] = $3;
		      }
		      $1 = $3 + $6 | 0;
		      $0 = 39856;
		      label$70 : {
		       label$71 : {
		        label$72 : {
		         label$73 : {
		          label$74 : {
		           label$75 : {
		            while (1) {
		             if (HEAP32[$0 >> 2] != ($1 | 0)) {
		              $0 = HEAP32[$0 + 8 >> 2];
		              if ($0) {
		               continue;
		              }
		              break label$75;
		             }
		             break;
		            }
		            if (!(HEAPU8[$0 + 12 | 0] & 8)) {
		             break label$74;
		            }
		           }
		           $0 = 39856;
		           while (1) {
		            $1 = HEAP32[$0 >> 2];
		            if ($1 >>> 0 <= $2 >>> 0) {
		             $1 = HEAP32[$0 + 4 >> 2] + $1 | 0;
		             if ($1 >>> 0 > $2 >>> 0) {
		              break label$73;
		             }
		            }
		            $0 = HEAP32[$0 + 8 >> 2];
		            continue;
		           }
		          }
		          HEAP32[$0 >> 2] = $3;
		          HEAP32[$0 + 4 >> 2] = HEAP32[$0 + 4 >> 2] + $6;
		          $7 = ($3 + 8 & 7 ? -8 - $3 & 7 : 0) + $3 | 0;
		          HEAP32[$7 + 4 >> 2] = $4 | 3;
		          $6 = ($1 + 8 & 7 ? -8 - $1 & 7 : 0) + $1 | 0;
		          $1 = ($6 - $7 | 0) - $4 | 0;
		          $4 = $4 + $7 | 0;
		          if (($2 | 0) == ($6 | 0)) {
		           HEAP32[9858] = $4;
		           $0 = HEAP32[9855] + $1 | 0;
		           HEAP32[9855] = $0;
		           HEAP32[$4 + 4 >> 2] = $0 | 1;
		           break label$71;
		          }
		          if (HEAP32[9857] == ($6 | 0)) {
		           HEAP32[9857] = $4;
		           $0 = HEAP32[9854] + $1 | 0;
		           HEAP32[9854] = $0;
		           HEAP32[$4 + 4 >> 2] = $0 | 1;
		           HEAP32[$0 + $4 >> 2] = $0;
		           break label$71;
		          }
		          $0 = HEAP32[$6 + 4 >> 2];
		          if (($0 & 3) == 1) {
		           $9 = $0 & -8;
		           label$83 : {
		            if ($0 >>> 0 <= 255) {
		             $8 = $0 >>> 3 | 0;
		             $0 = ($8 << 3) + 39448 | 0;
		             $3 = HEAP32[$6 + 8 >> 2];
		             $2 = HEAP32[$6 + 12 >> 2];
		             if (($3 | 0) == ($2 | 0)) {
		              HEAP32[9852] = HEAP32[9852] & __wasm_rotl_i32(-2, $8);
		              break label$83;
		             }
		             HEAP32[$3 + 12 >> 2] = $2;
		             HEAP32[$2 + 8 >> 2] = $3;
		             break label$83;
		            }
		            $8 = HEAP32[$6 + 24 >> 2];
		            $3 = HEAP32[$6 + 12 >> 2];
		            label$86 : {
		             if (($6 | 0) != ($3 | 0)) {
		              $0 = HEAP32[$6 + 8 >> 2];
		              HEAP32[$0 + 12 >> 2] = $3;
		              HEAP32[$3 + 8 >> 2] = $0;
		              break label$86;
		             }
		             label$89 : {
		              $0 = $6 + 20 | 0;
		              $2 = HEAP32[$0 >> 2];
		              if ($2) {
		               break label$89;
		              }
		              $0 = $6 + 16 | 0;
		              $2 = HEAP32[$0 >> 2];
		              if ($2) {
		               break label$89;
		              }
		              $3 = 0;
		              break label$86;
		             }
		             while (1) {
		              $5 = $0;
		              $3 = $2;
		              $0 = $2 + 20 | 0;
		              $2 = HEAP32[$0 >> 2];
		              if ($2) {
		               continue;
		              }
		              $0 = $3 + 16 | 0;
		              $2 = HEAP32[$3 + 16 >> 2];
		              if ($2) {
		               continue;
		              }
		              break;
		             }
		             HEAP32[$5 >> 2] = 0;
		            }
		            if (!$8) {
		             break label$83;
		            }
		            $2 = HEAP32[$6 + 28 >> 2];
		            $0 = ($2 << 2) + 39712 | 0;
		            label$91 : {
		             if (HEAP32[$0 >> 2] == ($6 | 0)) {
		              HEAP32[$0 >> 2] = $3;
		              if ($3) {
		               break label$91;
		              }
		              HEAP32[9853] = HEAP32[9853] & __wasm_rotl_i32(-2, $2);
		              break label$83;
		             }
		             HEAP32[(HEAP32[$8 + 16 >> 2] == ($6 | 0) ? 16 : 20) + $8 >> 2] = $3;
		             if (!$3) {
		              break label$83;
		             }
		            }
		            HEAP32[$3 + 24 >> 2] = $8;
		            $0 = HEAP32[$6 + 16 >> 2];
		            if ($0) {
		             HEAP32[$3 + 16 >> 2] = $0;
		             HEAP32[$0 + 24 >> 2] = $3;
		            }
		            $0 = HEAP32[$6 + 20 >> 2];
		            if (!$0) {
		             break label$83;
		            }
		            HEAP32[$3 + 20 >> 2] = $0;
		            HEAP32[$0 + 24 >> 2] = $3;
		           }
		           $6 = $6 + $9 | 0;
		           $1 = $1 + $9 | 0;
		          }
		          HEAP32[$6 + 4 >> 2] = HEAP32[$6 + 4 >> 2] & -2;
		          HEAP32[$4 + 4 >> 2] = $1 | 1;
		          HEAP32[$1 + $4 >> 2] = $1;
		          if ($1 >>> 0 <= 255) {
		           $2 = $1 >>> 3 | 0;
		           $0 = ($2 << 3) + 39448 | 0;
		           $2 = 1 << $2;
		           $1 = HEAP32[9852];
		           label$95 : {
		            if (!($2 & $1)) {
		             HEAP32[9852] = $2 | $1;
		             $2 = $0;
		             break label$95;
		            }
		            $2 = HEAP32[$0 + 8 >> 2];
		           }
		           HEAP32[$0 + 8 >> 2] = $4;
		           HEAP32[$2 + 12 >> 2] = $4;
		           HEAP32[$4 + 12 >> 2] = $0;
		           HEAP32[$4 + 8 >> 2] = $2;
		           break label$71;
		          }
		          $0 = 31;
		          if ($1 >>> 0 <= 16777215) {
		           $0 = $1 >>> 8 | 0;
		           $3 = $0;
		           $0 = $0 + 1048320 >>> 16 & 8;
		           $2 = $3 << $0;
		           $3 = $2;
		           $2 = $2 + 520192 >>> 16 & 4;
		           $3 = $3 << $2;
		           $5 = $3;
		           $3 = $3 + 245760 >>> 16 & 2;
		           $0 = ($5 << $3 >>> 15 | 0) - ($0 | $2 | $3) | 0;
		           $0 = ($0 << 1 | $1 >>> $0 + 21 & 1) + 28 | 0;
		          }
		          HEAP32[$4 + 28 >> 2] = $0;
		          HEAP32[$4 + 16 >> 2] = 0;
		          HEAP32[$4 + 20 >> 2] = 0;
		          $2 = ($0 << 2) + 39712 | 0;
		          $3 = HEAP32[9853];
		          $5 = 1 << $0;
		          label$98 : {
		           if (!($3 & $5)) {
		            HEAP32[9853] = $3 | $5;
		            HEAP32[$2 >> 2] = $4;
		            break label$98;
		           }
		           $0 = $1 << (($0 | 0) == 31 ? 0 : 25 - ($0 >>> 1 | 0) | 0);
		           $3 = HEAP32[$2 >> 2];
		           while (1) {
		            $2 = $3;
		            if ((HEAP32[$2 + 4 >> 2] & -8) == ($1 | 0)) {
		             break label$72;
		            }
		            $3 = $0 >>> 29 | 0;
		            $0 = $0 << 1;
		            $6 = ($3 & 4) + $2 | 0;
		            $5 = $6 + 16 | 0;
		            $3 = HEAP32[$5 >> 2];
		            if ($3) {
		             continue;
		            }
		            break;
		           }
		           HEAP32[$6 + 16 >> 2] = $4;
		          }
		          HEAP32[$4 + 24 >> 2] = $2;
		          HEAP32[$4 + 12 >> 2] = $4;
		          HEAP32[$4 + 8 >> 2] = $4;
		          break label$71;
		         }
		         $0 = $6 - 40 | 0;
		         $5 = $3 + 8 & 7 ? -8 - $3 & 7 : 0;
		         $7 = $0 - $5 | 0;
		         HEAP32[9855] = $7;
		         $5 = $3 + $5 | 0;
		         HEAP32[9858] = $5;
		         HEAP32[$5 + 4 >> 2] = $7 | 1;
		         HEAP32[($0 + $3 | 0) + 4 >> 2] = 40;
		         HEAP32[9859] = HEAP32[9974];
		         $0 = (($1 - 39 & 7 ? 39 - $1 & 7 : 0) + $1 | 0) - 47 | 0;
		         $5 = $2 + 16 >>> 0 > $0 >>> 0 ? $2 : $0;
		         HEAP32[$5 + 4 >> 2] = 27;
		         $0 = HEAP32[9967];
		         $7 = HEAP32[9966];
		         HEAP32[$5 + 16 >> 2] = $7;
		         HEAP32[$5 + 20 >> 2] = $0;
		         $7 = HEAP32[9965];
		         $0 = HEAP32[9964];
		         HEAP32[$5 + 8 >> 2] = $0;
		         HEAP32[$5 + 12 >> 2] = $7;
		         HEAP32[9966] = $5 + 8;
		         HEAP32[9965] = $6;
		         HEAP32[9964] = $3;
		         HEAP32[9967] = 0;
		         $0 = $5 + 24 | 0;
		         while (1) {
		          HEAP32[$0 + 4 >> 2] = 7;
		          $3 = $0 + 8 | 0;
		          $0 = $0 + 4 | 0;
		          if ($1 >>> 0 > $3 >>> 0) {
		           continue;
		          }
		          break;
		         }
		         if (($2 | 0) == ($5 | 0)) {
		          break label$62;
		         }
		         HEAP32[$5 + 4 >> 2] = HEAP32[$5 + 4 >> 2] & -2;
		         $6 = $5 - $2 | 0;
		         HEAP32[$2 + 4 >> 2] = $6 | 1;
		         HEAP32[$5 >> 2] = $6;
		         if ($6 >>> 0 <= 255) {
		          $1 = $6 >>> 3 | 0;
		          $0 = ($1 << 3) + 39448 | 0;
		          $1 = 1 << $1;
		          $3 = HEAP32[9852];
		          label$103 : {
		           if (!($1 & $3)) {
		            HEAP32[9852] = $1 | $3;
		            $1 = $0;
		            break label$103;
		           }
		           $1 = HEAP32[$0 + 8 >> 2];
		          }
		          HEAP32[$0 + 8 >> 2] = $2;
		          HEAP32[$1 + 12 >> 2] = $2;
		          HEAP32[$2 + 12 >> 2] = $0;
		          HEAP32[$2 + 8 >> 2] = $1;
		          break label$62;
		         }
		         $0 = 31;
		         HEAP32[$2 + 16 >> 2] = 0;
		         HEAP32[$2 + 20 >> 2] = 0;
		         if ($6 >>> 0 <= 16777215) {
		          $0 = $6 >>> 8 | 0;
		          $1 = $0;
		          $0 = $0 + 1048320 >>> 16 & 8;
		          $1 = $1 << $0;
		          $3 = $1;
		          $1 = $1 + 520192 >>> 16 & 4;
		          $3 = $3 << $1;
		          $5 = $3;
		          $3 = $3 + 245760 >>> 16 & 2;
		          $0 = ($5 << $3 >>> 15 | 0) - ($0 | $1 | $3) | 0;
		          $0 = ($0 << 1 | $6 >>> $0 + 21 & 1) + 28 | 0;
		         }
		         HEAP32[$2 + 28 >> 2] = $0;
		         $1 = ($0 << 2) + 39712 | 0;
		         $3 = HEAP32[9853];
		         $5 = 1 << $0;
		         label$106 : {
		          if (!($3 & $5)) {
		           HEAP32[9853] = $3 | $5;
		           HEAP32[$1 >> 2] = $2;
		           break label$106;
		          }
		          $0 = $6 << (($0 | 0) == 31 ? 0 : 25 - ($0 >>> 1 | 0) | 0);
		          $3 = HEAP32[$1 >> 2];
		          while (1) {
		           $1 = $3;
		           if ((HEAP32[$1 + 4 >> 2] & -8) == ($6 | 0)) {
		            break label$70;
		           }
		           $3 = $0 >>> 29 | 0;
		           $0 = $0 << 1;
		           $7 = ($3 & 4) + $1 | 0;
		           $5 = $7 + 16 | 0;
		           $3 = HEAP32[$5 >> 2];
		           if ($3) {
		            continue;
		           }
		           break;
		          }
		          HEAP32[$7 + 16 >> 2] = $2;
		         }
		         HEAP32[$2 + 24 >> 2] = $1;
		         HEAP32[$2 + 12 >> 2] = $2;
		         HEAP32[$2 + 8 >> 2] = $2;
		         break label$62;
		        }
		        $0 = HEAP32[$2 + 8 >> 2];
		        HEAP32[$0 + 12 >> 2] = $4;
		        HEAP32[$2 + 8 >> 2] = $4;
		        HEAP32[$4 + 24 >> 2] = 0;
		        HEAP32[$4 + 12 >> 2] = $2;
		        HEAP32[$4 + 8 >> 2] = $0;
		       }
		       $0 = $7 + 8 | 0;
		       break label$1;
		      }
		      $0 = HEAP32[$1 + 8 >> 2];
		      HEAP32[$0 + 12 >> 2] = $2;
		      HEAP32[$1 + 8 >> 2] = $2;
		      HEAP32[$2 + 24 >> 2] = 0;
		      HEAP32[$2 + 12 >> 2] = $1;
		      HEAP32[$2 + 8 >> 2] = $0;
		     }
		     $0 = HEAP32[9855];
		     if ($4 >>> 0 >= $0 >>> 0) {
		      break label$4;
		     }
		     $2 = $0 - $4 | 0;
		     HEAP32[9855] = $2;
		     $0 = HEAP32[9858];
		     $1 = $4 + $0 | 0;
		     HEAP32[9858] = $1;
		     HEAP32[$1 + 4 >> 2] = $2 | 1;
		     HEAP32[$0 + 4 >> 2] = $4 | 3;
		     $0 = $0 + 8 | 0;
		     break label$1;
		    }
		    HEAP32[__errno_location() >> 2] = 48;
		    $0 = 0;
		    break label$1;
		   }
		   label$109 : {
		    if (!$8) {
		     break label$109;
		    }
		    $1 = HEAP32[$5 + 28 >> 2];
		    $0 = ($1 << 2) + 39712 | 0;
		    label$110 : {
		     if (HEAP32[$0 >> 2] == ($5 | 0)) {
		      HEAP32[$0 >> 2] = $3;
		      if ($3) {
		       break label$110;
		      }
		      $9 = __wasm_rotl_i32(-2, $1) & $9;
		      HEAP32[9853] = $9;
		      break label$109;
		     }
		     HEAP32[(HEAP32[$8 + 16 >> 2] == ($5 | 0) ? 16 : 20) + $8 >> 2] = $3;
		     if (!$3) {
		      break label$109;
		     }
		    }
		    HEAP32[$3 + 24 >> 2] = $8;
		    $0 = HEAP32[$5 + 16 >> 2];
		    if ($0) {
		     HEAP32[$3 + 16 >> 2] = $0;
		     HEAP32[$0 + 24 >> 2] = $3;
		    }
		    $0 = HEAP32[$5 + 20 >> 2];
		    if (!$0) {
		     break label$109;
		    }
		    HEAP32[$3 + 20 >> 2] = $0;
		    HEAP32[$0 + 24 >> 2] = $3;
		   }
		   label$113 : {
		    if ($2 >>> 0 <= 15) {
		     $0 = $2 + $4 | 0;
		     HEAP32[$5 + 4 >> 2] = $0 | 3;
		     $0 = $0 + $5 | 0;
		     HEAP32[$0 + 4 >> 2] = HEAP32[$0 + 4 >> 2] | 1;
		     break label$113;
		    }
		    HEAP32[$5 + 4 >> 2] = $4 | 3;
		    HEAP32[$7 + 4 >> 2] = $2 | 1;
		    HEAP32[$2 + $7 >> 2] = $2;
		    if ($2 >>> 0 <= 255) {
		     $2 = $2 >>> 3 | 0;
		     $0 = ($2 << 3) + 39448 | 0;
		     $2 = 1 << $2;
		     $1 = HEAP32[9852];
		     label$116 : {
		      if (!($2 & $1)) {
		       HEAP32[9852] = $2 | $1;
		       $2 = $0;
		       break label$116;
		      }
		      $2 = HEAP32[$0 + 8 >> 2];
		     }
		     HEAP32[$0 + 8 >> 2] = $7;
		     HEAP32[$2 + 12 >> 2] = $7;
		     HEAP32[$7 + 12 >> 2] = $0;
		     HEAP32[$7 + 8 >> 2] = $2;
		     break label$113;
		    }
		    $0 = 31;
		    if ($2 >>> 0 <= 16777215) {
		     $0 = $2 >>> 8 | 0;
		     $1 = $0;
		     $0 = $0 + 1048320 >>> 16 & 8;
		     $1 = $1 << $0;
		     $3 = $1;
		     $1 = $1 + 520192 >>> 16 & 4;
		     $4 = $3 << $1;
		     $3 = $4;
		     $4 = $4 + 245760 >>> 16 & 2;
		     $0 = ($3 << $4 >>> 15 | 0) - ($0 | $1 | $4) | 0;
		     $0 = ($0 << 1 | $2 >>> $0 + 21 & 1) + 28 | 0;
		    }
		    HEAP32[$7 + 28 >> 2] = $0;
		    HEAP32[$7 + 16 >> 2] = 0;
		    HEAP32[$7 + 20 >> 2] = 0;
		    $1 = ($0 << 2) + 39712 | 0;
		    label$119 : {
		     $4 = 1 << $0;
		     label$120 : {
		      if (!($9 & $4)) {
		       HEAP32[9853] = $4 | $9;
		       HEAP32[$1 >> 2] = $7;
		       break label$120;
		      }
		      $0 = $2 << (($0 | 0) == 31 ? 0 : 25 - ($0 >>> 1 | 0) | 0);
		      $4 = HEAP32[$1 >> 2];
		      while (1) {
		       $1 = $4;
		       if ((HEAP32[$1 + 4 >> 2] & -8) == ($2 | 0)) {
		        break label$119;
		       }
		       $4 = $0 >>> 29 | 0;
		       $0 = $0 << 1;
		       $6 = ($4 & 4) + $1 | 0;
		       $3 = $6 + 16 | 0;
		       $4 = HEAP32[$3 >> 2];
		       if ($4) {
		        continue;
		       }
		       break;
		      }
		      HEAP32[$6 + 16 >> 2] = $7;
		     }
		     HEAP32[$7 + 24 >> 2] = $1;
		     HEAP32[$7 + 12 >> 2] = $7;
		     HEAP32[$7 + 8 >> 2] = $7;
		     break label$113;
		    }
		    $0 = HEAP32[$1 + 8 >> 2];
		    HEAP32[$0 + 12 >> 2] = $7;
		    HEAP32[$1 + 8 >> 2] = $7;
		    HEAP32[$7 + 24 >> 2] = 0;
		    HEAP32[$7 + 12 >> 2] = $1;
		    HEAP32[$7 + 8 >> 2] = $0;
		   }
		   $0 = $5 + 8 | 0;
		   break label$1;
		  }
		  label$123 : {
		   if (!$11) {
		    break label$123;
		   }
		   $1 = HEAP32[$3 + 28 >> 2];
		   $0 = ($1 << 2) + 39712 | 0;
		   label$124 : {
		    if (HEAP32[$0 >> 2] == ($3 | 0)) {
		     HEAP32[$0 >> 2] = $5;
		     if ($5) {
		      break label$124;
		     }
		     HEAP32[9853] = __wasm_rotl_i32(-2, $1) & $8;
		     break label$123;
		    }
		    HEAP32[(HEAP32[$11 + 16 >> 2] == ($3 | 0) ? 16 : 20) + $11 >> 2] = $5;
		    if (!$5) {
		     break label$123;
		    }
		   }
		   HEAP32[$5 + 24 >> 2] = $11;
		   $0 = HEAP32[$3 + 16 >> 2];
		   if ($0) {
		    HEAP32[$5 + 16 >> 2] = $0;
		    HEAP32[$0 + 24 >> 2] = $5;
		   }
		   $0 = HEAP32[$3 + 20 >> 2];
		   if (!$0) {
		    break label$123;
		   }
		   HEAP32[$5 + 20 >> 2] = $0;
		   HEAP32[$0 + 24 >> 2] = $5;
		  }
		  label$127 : {
		   if ($2 >>> 0 <= 15) {
		    $0 = $2 + $4 | 0;
		    HEAP32[$3 + 4 >> 2] = $0 | 3;
		    $0 = $0 + $3 | 0;
		    HEAP32[$0 + 4 >> 2] = HEAP32[$0 + 4 >> 2] | 1;
		    break label$127;
		   }
		   HEAP32[$3 + 4 >> 2] = $4 | 3;
		   HEAP32[$10 + 4 >> 2] = $2 | 1;
		   HEAP32[$2 + $10 >> 2] = $2;
		   if ($9) {
		    $4 = $9 >>> 3 | 0;
		    $1 = ($4 << 3) + 39448 | 0;
		    $0 = HEAP32[9857];
		    $4 = 1 << $4;
		    label$130 : {
		     if (!($6 & $4)) {
		      HEAP32[9852] = $4 | $6;
		      $4 = $1;
		      break label$130;
		     }
		     $4 = HEAP32[$1 + 8 >> 2];
		    }
		    HEAP32[$1 + 8 >> 2] = $0;
		    HEAP32[$4 + 12 >> 2] = $0;
		    HEAP32[$0 + 12 >> 2] = $1;
		    HEAP32[$0 + 8 >> 2] = $4;
		   }
		   HEAP32[9857] = $10;
		   HEAP32[9854] = $2;
		  }
		  $0 = $3 + 8 | 0;
		 }
		 __stack_pointer = $12 + 16 | 0;
		 return $0 | 0;
		}
		function opus_decode_frame($0, $1, $2, $3, $4, $5) {
		 var $6 = 0, $7 = 0, $8 = 0, $9 = 0, $10 = Math_fround(0), $11 = 0, $12 = 0, $13 = 0, $14 = 0, $15 = 0, $16 = 0, $17 = 0, $18 = 0, $19 = 0, $20 = 0, $21 = 0, $22 = 0, $23 = 0, $24 = 0, $25 = 0, $26 = 0, $27 = 0, $28 = 0, $29 = 0;
		 $7 = __stack_pointer - 192 | 0;
		 __stack_pointer = $7;
		 $8 = $7;
		 HEAP32[$8 + 136 >> 2] = 0;
		 $6 = -2;
		 label$1 : {
		  label$2 : {
		   label$3 : {
		    label$4 : {
		     label$5 : {
		      label$6 : {
		       label$7 : {
		        label$8 : {
		         label$9 : {
		          label$10 : {
		           label$11 : {
		            $21 = HEAP32[$0 + 12 >> 2];
		            $14 = ($21 | 0) / 50 | 0;
		            $11 = $14 >> 3;
		            label$12 : {
		             if (($11 | 0) > ($4 | 0)) {
		              break label$12;
		             }
		             $28 = HEAP32[$0 >> 2];
		             $13 = HEAP32[$0 + 4 >> 2];
		             $17 = $14 >> 2;
		             $9 = $14 >> 1;
		             $6 = Math_imul(($21 | 0) / 25 | 0, 3);
		             $6 = ($4 | 0) < ($6 | 0) ? $4 : $6;
		             label$13 : {
		              label$14 : {
		               label$15 : {
		                label$16 : {
		                 label$17 : {
		                  label$18 : {
		                   label$19 : {
		                    label$20 : {
		                     if (($2 | 0) <= 1) {
		                      $4 = HEAP32[$0 + 64 >> 2];
		                      $6 = ($4 | 0) > ($6 | 0) ? $6 : $4;
		                      break label$20;
		                     }
		                     if ($1) {
		                      break label$19;
		                     }
		                    }
		                    $16 = HEAP32[$0 + 60 >> 2];
		                    if (!$16) {
		                     $4 = Math_imul(HEAP32[$0 + 8 >> 2], $6);
		                     if (($4 | 0) < 1) {
		                      break label$12;
		                     }
		                     memset($3, 0, $4 << 2);
		                     break label$12;
		                    }
		                    if (($6 | 0) > ($14 | 0)) {
		                     $4 = $6;
		                     while (1) {
		                      $11 = opus_decode_frame($0, 0, 0, $3, ($4 | 0) < ($14 | 0) ? $4 : $14, 0);
		                      if (($11 | 0) < 0) {
		                       $6 = $11;
		                       break label$12;
		                      }
		                      $3 = (Math_imul(HEAP32[$0 + 8 >> 2], $11) << 2) + $3 | 0;
		                      $4 = $4 - $11 | 0;
		                      if (($4 | 0) > 0) {
		                       continue;
		                      }
		                      break;
		                     }
		                     break label$12;
		                    }
		                    if (($6 | 0) >= ($14 | 0)) {
		                     $12 = $6;
		                     break label$18;
		                    }
		                    if (($6 | 0) > ($9 | 0)) {
		                     $12 = $9;
		                     break label$18;
		                    }
		                    if (($16 | 0) == 1e3) {
		                     $12 = $6;
		                     $16 = 1e3;
		                     break label$18;
		                    }
		                    $12 = ($6 | 0) > ($17 | 0) ? ($6 | 0) < ($9 | 0) ? $17 : $6 : $6;
		                    break label$18;
		                   }
		                   $19 = HEAP32[$0 + 52 >> 2];
		                   $16 = HEAP32[$0 + 56 >> 2];
		                   $12 = HEAP32[$0 + 64 >> 2];
		                   ec_dec_init($8 + 144 | 0, $1, $2);
		                   $24 = 1;
		                   $4 = HEAP32[$0 + 60 >> 2];
		                   if (($4 | 0) < 1) {
		                    break label$17;
		                   }
		                   if (!(HEAP32[$0 + 68 >> 2] ? 0 : !(($4 | 0) == 1002 | ($16 | 0) != 1002))) {
		                    if (($16 | 0) == 1002) {
		                     $16 = 1002;
		                     break label$17;
		                    }
		                    if (($4 | 0) != 1002) {
		                     break label$17;
		                    }
		                   }
		                   $27 = 1;
		                   $25 = Math_imul(HEAP32[$0 + 8 >> 2], $17);
		                   $22 = $7 - (((($16 | 0) == 1002 ? $25 : 1) << 2) + 15 & -16) | 0;
		                   $7 = $22;
		                   __stack_pointer = $7;
		                   if (($16 | 0) == 1002) {
		                    opus_decode_frame($0, 0, 0, $22, ($12 | 0) > ($17 | 0) ? $17 : $12, 0);
		                    $16 = 1002;
		                    $4 = 1;
		                    break label$16;
		                   }
		                   $4 = ($6 | 0) < ($12 | 0);
		                   $22 = 0;
		                   $6 = -1;
		                   if (!$4) {
		                    break label$15;
		                   }
		                   break label$13;
		                  }
		                  $1 = 0;
		                 }
		                 $4 = ($16 | 0) == 1002;
		                }
		                $15 = $4;
		                $4 = ($6 | 0) < ($12 | 0);
		                $6 = -1;
		                if ($4) {
		                 break label$13;
		                }
		                $23 = 1;
		                $6 = 1;
		                $25 = 1;
		                $4 = $25;
		                if ($15) {
		                 break label$14;
		                }
		               }
		               $23 = $25;
		               $6 = Math_imul(HEAP32[$0 + 8 >> 2], ($9 | 0) > ($12 | 0) ? $9 : $12);
		               $4 = 0;
		              }
		              $25 = $4;
		              $4 = $6;
		              $18 = $7 - (($4 << 1) + 15 & -16) | 0;
		              $20 = $18;
		              __stack_pointer = $18;
		              label$33 : {
		               if (($16 | 0) == 1002) {
		                $26 = !$5;
		                $24 = 0;
		                $9 = 0;
		                $6 = 0;
		                $5 = 0;
		                $15 = 0;
		                break label$33;
		               }
		               $13 = $0 + $13 | 0;
		               if (HEAP32[$0 + 60 >> 2] == 1002) {
		                silk_InitDecoder($13);
		               }
		               $4 = (Math_imul($12, 1e3) | 0) / HEAP32[$0 + 12 >> 2] | 0;
		               HEAP32[$0 + 32 >> 2] = ($4 | 0) > 10 ? $4 : 10;
		               label$36 : {
		                if (!$24) {
		                 break label$36;
		                }
		                HEAP32[$0 + 20 >> 2] = HEAP32[$0 + 48 >> 2];
		                if (($16 | 0) == 1e3) {
		                 label$38 : {
		                  switch ($19 - 1101 | 0) {
		                  case 0:
		                   HEAP32[$0 + 28 >> 2] = 8e3;
		                   break label$36;
		                  case 1:
		                   HEAP32[$0 + 28 >> 2] = 12e3;
		                   break label$36;
		                  default:
		                   break label$38;
		                  }
		                 }
		                 HEAP32[$0 + 28 >> 2] = 16e3;
		                 if (($19 | 0) == 1103) {
		                  break label$36;
		                 }
		                 celt_fatal(36419, 35333, 389);
		                 abort();
		                }
		                HEAP32[$0 + 28 >> 2] = 16e3;
		               }
		               $15 = $0 + 16 | 0;
		               $9 = $1 ? $5 << 1 : 1;
		               $6 = 0;
		               $4 = $18;
		               while (1) {
		                label$42 : {
		                 if (!silk_Decode($13, $15, $9, !$6, $8 + 144 | 0, $4, $8 + 140 | 0, HEAP32[$0 + 44 >> 2])) {
		                  break label$42;
		                 }
		                 if (!$9) {
		                  $6 = -3;
		                  break label$13;
		                 }
		                 HEAP32[$8 + 140 >> 2] = $12;
		                 $7 = Math_imul(HEAP32[$0 + 8 >> 2], $12);
		                 if (($7 | 0) < 1) {
		                  break label$42;
		                 }
		                 memset($4, 0, $7 << 1);
		                }
		                $7 = HEAP32[$8 + 140 >> 2];
		                $4 = (Math_imul($7, HEAP32[$0 + 8 >> 2]) << 1) + $4 | 0;
		                $6 = $6 + $7 | 0;
		                if (($12 | 0) > ($6 | 0)) {
		                 continue;
		                }
		                break;
		               }
		               $26 = !$5;
		               label$44 : {
		                label$45 : {
		                 if (!($26 & $24)) {
		                  $5 = 0;
		                  break label$45;
		                 }
		                 $5 = 0;
		                 label$47 : {
		                  if ((((HEAP32[$8 + 164 >> 2] + Math_clz32(HEAP32[$8 + 172 >> 2]) | 0) + (HEAP32[$0 + 56 >> 2] == 1001 ? 20 : 0) | 0) - 15 | 0) > $2 << 3) {
		                   break label$47;
		                  }
		                  label$48 : {
		                   if (($16 | 0) == 1001) {
		                    $9 = ec_dec_bit_logp($8 + 144 | 0, 12);
		                    if (!$9) {
		                     break label$47;
		                    }
		                    $6 = ec_dec_bit_logp($8 + 144 | 0, 1);
		                    $4 = ec_dec_uint($8 + 144 | 0, 256) + 2 | 0;
		                    $7 = Math_clz32(HEAP32[$8 + 172 >> 2]);
		                    $13 = HEAP32[$8 + 164 >> 2];
		                    break label$48;
		                   }
		                   $9 = 1;
		                   $6 = ec_dec_bit_logp($8 + 144 | 0, 1);
		                   $7 = Math_clz32(HEAP32[$8 + 172 >> 2]);
		                   $13 = HEAP32[$8 + 164 >> 2];
		                   $4 = $2 - (($7 + $13 | 0) - 25 >> 3) | 0;
		                  }
		                  $15 = $2 - $4 | 0;
		                  $7 = (($7 + $13 | 0) - 32 | 0) > $15 << 3;
		                  $5 = $7 ? 0 : $4;
		                  HEAP32[$8 + 148 >> 2] = HEAP32[$8 + 148 >> 2] - $5;
		                  $2 = $7 ? 0 : $15;
		                  $26 = 1;
		                  $9 = $7 ? 0 : $9;
		                  break label$44;
		                 }
		                 $26 = 1;
		                }
		                $6 = 0;
		                $9 = 0;
		               }
		               $24 = ($9 | 0) != 0;
		               $4 = $20 - ((($9 ? 1 : $23) << 2) + 15 & -16) | 0;
		               $20 = $4;
		               __stack_pointer = $4;
		               $15 = 17;
		               $27 = !$9 & $27;
		               if (!$27 | ($16 | 0) == 1002) {
		                break label$33;
		               }
		               opus_decode_frame($0, 0, 0, $4, ($12 | 0) > ($17 | 0) ? $17 : $12, 0);
		               $22 = $4;
		              }
		              $7 = $0 + $28 | 0;
		              $4 = 13;
		              label$50 : {
		               label$51 : {
		                label$52 : {
		                 label$53 : {
		                  switch ($19 - 1101 | 0) {
		                  case 3:
		                   $4 = 19;
		                   break label$52;
		                  case 4:
		                   $4 = 21;
		                   break label$52;
		                  case 0:
		                   break label$52;
		                  case 1:
		                  case 2:
		                   break label$53;
		                  default:
		                   break label$51;
		                  }
		                 }
		                 $4 = 17;
		                }
		                HEAP32[$8 + 128 >> 2] = $4;
		                if (!opus_custom_decoder_ctl($7, 10012, $8 + 128 | 0)) {
		                 break label$50;
		                }
		                celt_fatal(36439, 35333, 491);
		                abort();
		               }
		               if ($19) {
		                break label$1;
		               }
		              }
		              HEAP32[$8 + 112 >> 2] = HEAP32[$0 + 48 >> 2];
		              if (opus_custom_decoder_ctl($7, 10008, $8 + 112 | 0)) {
		               break label$11;
		              }
		              label$56 : {
		               if (!$24) {
		                $23 = 0;
		                $19 = ($6 | 0) != 0;
		                $13 = $20 - 16 | 0;
		                __stack_pointer = $13;
		                break label$56;
		               }
		               $13 = $20 - ((Math_imul(HEAP32[$0 + 8 >> 2], $17) << 2) + 15 & -16) | 0;
		               __stack_pointer = $13;
		               if (!$6) {
		                $23 = 0;
		                $19 = 0;
		                break label$56;
		               }
		               HEAP32[$8 + 96 >> 2] = 0;
		               if (opus_custom_decoder_ctl($7, 10010, $8 + 96 | 0)) {
		                break label$10;
		               }
		               celt_decode_with_ec($7, $1 + $2 | 0, $5, $13, $17, 0, 0);
		               HEAP32[$8 + 80 >> 2] = $8 + 136;
		               $23 = 1;
		               $19 = 1;
		               if (opus_custom_decoder_ctl($7, 4031, $8 + 80 | 0)) {
		                break label$9;
		               }
		              }
		              HEAP32[$8 + 64 >> 2] = $15;
		              if (opus_custom_decoder_ctl($7, 10010, $8 - -64 | 0)) {
		               break label$8;
		              }
		              label$59 : {
		               if (($16 | 0) != 1e3) {
		                $4 = HEAP32[$0 + 60 >> 2];
		                if (!(HEAP32[$0 + 68 >> 2] | (($16 | 0) == ($4 | 0) | ($4 | 0) < 1))) {
		                 if (opus_custom_decoder_ctl($7, 4028, 0)) {
		                  break label$7;
		                 }
		                }
		                $20 = celt_decode_with_ec($7, $26 ? $1 : 0, $2, $3, ($12 | 0) > ($14 | 0) ? $14 : $12, $8 + 144 | 0, 0);
		                break label$59;
		               }
		               HEAP16[$8 + 132 >> 1] = 65535;
		               $4 = Math_imul(HEAP32[$0 + 8 >> 2], $12);
		               if (($4 | 0) >= 1) {
		                memset($3, 0, $4 << 2);
		               }
		               if (!(HEAP32[$0 + 60 >> 2] != 1001 | (HEAP32[$0 + 68 >> 2] ? $23 : 0))) {
		                HEAP32[$8 + 48 >> 2] = 0;
		                if (opus_custom_decoder_ctl($7, 10010, $8 + 48 | 0)) {
		                 break label$6;
		                }
		                celt_decode_with_ec($7, $8 + 132 | 0, 2, $3, $11, 0, 0);
		               }
		               $20 = 0;
		              }
		              label$65 : {
		               if ($25) {
		                break label$65;
		               }
		               $6 = Math_imul(HEAP32[$0 + 8 >> 2], $12);
		               if (($6 | 0) < 1) {
		                break label$65;
		               }
		               $4 = 0;
		               while (1) {
		                $14 = ($4 << 2) + $3 | 0;
		                HEAPF32[$14 >> 2] = HEAPF32[$14 >> 2] + Math_fround(Math_fround(HEAP16[($4 << 1) + $18 >> 1]) * Math_fround(30517578125e-15));
		                $4 = $4 + 1 | 0;
		                if (($6 | 0) != ($4 | 0)) {
		                 continue;
		                }
		                break;
		               }
		              }
		              HEAP32[$8 + 32 >> 2] = $8 + 132;
		              if (opus_custom_decoder_ctl($7, 10015, $8 + 32 | 0)) {
		               break label$5;
		              }
		              $14 = HEAP32[HEAP32[$8 + 132 >> 2] + 60 >> 2];
		              label$67 : {
		               if (!$9 | $19) {
		                break label$67;
		               }
		               if (opus_custom_decoder_ctl($7, 4028, 0)) {
		                break label$4;
		               }
		               HEAP32[$8 + 16 >> 2] = 0;
		               if (opus_custom_decoder_ctl($7, 10010, $8 + 16 | 0)) {
		                break label$3;
		               }
		               celt_decode_with_ec($7, $1 + $2 | 0, $5, $13, $17, 0, 0);
		               HEAP32[$8 >> 2] = $8 + 136;
		               if (opus_custom_decoder_ctl($7, 4031, $8)) {
		                break label$2;
		               }
		               $15 = 48e3 / HEAP32[$0 + 12 >> 2] | 0;
		               $1 = HEAP32[$0 + 8 >> 2];
		               if (($1 | 0) < 1) {
		                break label$67;
		               }
		               $18 = (Math_imul($1, $11) << 2) + $13 | 0;
		               $5 = (Math_imul($12 - $11 | 0, $1) << 2) + $3 | 0;
		               $9 = 0;
		               $28 = ($21 | 0) < 400;
		               while (1) {
		                $4 = 0;
		                if (!$28) {
		                 while (1) {
		                  $6 = Math_imul($1, $4) + $9 << 2;
		                  $7 = $6 + $5 | 0;
		                  $10 = HEAPF32[(Math_imul($4, $15) << 2) + $14 >> 2];
		                  $10 = Math_fround($10 * $10);
		                  HEAPF32[$7 >> 2] = Math_fround($10 * HEAPF32[$6 + $18 >> 2]) + Math_fround(Math_fround(Math_fround(1) - $10) * HEAPF32[$7 >> 2]);
		                  $4 = $4 + 1 | 0;
		                  if (($11 | 0) != ($4 | 0)) {
		                   continue;
		                  }
		                  break;
		                 }
		                }
		                $9 = $9 + 1 | 0;
		                if (($9 | 0) != ($1 | 0)) {
		                 continue;
		                }
		                break;
		               }
		              }
		              label$71 : {
		               if (!$23) {
		                break label$71;
		               }
		               $7 = HEAP32[$0 + 8 >> 2];
		               if (($7 | 0) < 1) {
		                break label$71;
		               }
		               $1 = ($11 | 0) > 1 ? $11 : 1;
		               $9 = 0;
		               $15 = ($21 | 0) < 400;
		               while (1) {
		                $4 = 0;
		                if (!$15) {
		                 while (1) {
		                  $6 = Math_imul($4, $7) + $9 << 2;
		                  HEAP32[$6 + $3 >> 2] = HEAP32[$6 + $13 >> 2];
		                  $4 = $4 + 1 | 0;
		                  if (($4 | 0) != ($1 | 0)) {
		                   continue;
		                  }
		                  break;
		                 }
		                }
		                $9 = $9 + 1 | 0;
		                if (($9 | 0) != ($7 | 0)) {
		                 continue;
		                }
		                break;
		               }
		               $15 = 48e3 / HEAP32[$0 + 12 >> 2] | 0;
		               if (($7 | 0) < 1) {
		                break label$71;
		               }
		               $4 = Math_imul($7, $11) << 2;
		               $18 = $4 + $3 | 0;
		               $13 = $4 + $13 | 0;
		               $1 = 0;
		               $5 = ($21 | 0) < 400;
		               while (1) {
		                $4 = 0;
		                if (!$5) {
		                 while (1) {
		                  $6 = Math_imul($4, $7) + $1 << 2;
		                  $9 = $18 + $6 | 0;
		                  $10 = HEAPF32[(Math_imul($4, $15) << 2) + $14 >> 2];
		                  $10 = Math_fround($10 * $10);
		                  HEAPF32[$9 >> 2] = Math_fround($10 * HEAPF32[$9 >> 2]) + Math_fround(Math_fround(Math_fround(1) - $10) * HEAPF32[$6 + $13 >> 2]);
		                  $4 = $4 + 1 | 0;
		                  if (($11 | 0) != ($4 | 0)) {
		                   continue;
		                  }
		                  break;
		                 }
		                }
		                $1 = $1 + 1 | 0;
		                if (($7 | 0) != ($1 | 0)) {
		                 continue;
		                }
		                break;
		               }
		              }
		              label$78 : {
		               if (!$27) {
		                break label$78;
		               }
		               $6 = HEAP32[$0 + 8 >> 2];
		               if (($12 | 0) >= ($17 | 0)) {
		                $9 = Math_imul($6, $11);
		                if (($9 | 0) >= 1) {
		                 $4 = 0;
		                 while (1) {
		                  $7 = $4 << 2;
		                  HEAP32[$7 + $3 >> 2] = HEAP32[$7 + $22 >> 2];
		                  $4 = $4 + 1 | 0;
		                  if (($9 | 0) != ($4 | 0)) {
		                   continue;
		                  }
		                  break;
		                 }
		                }
		                $13 = 48e3 / HEAP32[$0 + 12 >> 2] | 0;
		                if (($6 | 0) < 1) {
		                 break label$78;
		                }
		                $4 = $9 << 2;
		                $15 = $4 + $3 | 0;
		                $18 = $4 + $22 | 0;
		                $1 = 0;
		                $5 = ($21 | 0) < 400;
		                while (1) {
		                 $4 = 0;
		                 if (!$5) {
		                  while (1) {
		                   $7 = Math_imul($4, $6) + $1 << 2;
		                   $9 = $15 + $7 | 0;
		                   $10 = HEAPF32[(Math_imul($4, $13) << 2) + $14 >> 2];
		                   $10 = Math_fround($10 * $10);
		                   HEAPF32[$9 >> 2] = Math_fround($10 * HEAPF32[$9 >> 2]) + Math_fround(Math_fround(Math_fround(1) - $10) * HEAPF32[$7 + $18 >> 2]);
		                   $4 = $4 + 1 | 0;
		                   if (($11 | 0) != ($4 | 0)) {
		                    continue;
		                   }
		                   break;
		                  }
		                 }
		                 $1 = $1 + 1 | 0;
		                 if (($6 | 0) != ($1 | 0)) {
		                  continue;
		                 }
		                 break;
		                }
		                break label$78;
		               }
		               $13 = 48e3 / HEAP32[$0 + 12 >> 2] | 0;
		               if (($6 | 0) < 1) {
		                break label$78;
		               }
		               $1 = 0;
		               $15 = ($21 | 0) < 400;
		               while (1) {
		                $4 = 0;
		                if (!$15) {
		                 while (1) {
		                  $7 = Math_imul($4, $6) + $1 << 2;
		                  $9 = $7 + $3 | 0;
		                  $10 = HEAPF32[(Math_imul($4, $13) << 2) + $14 >> 2];
		                  $10 = Math_fround($10 * $10);
		                  HEAPF32[$9 >> 2] = Math_fround($10 * HEAPF32[$9 >> 2]) + Math_fround(Math_fround(Math_fround(1) - $10) * HEAPF32[$7 + $22 >> 2]);
		                  $4 = $4 + 1 | 0;
		                  if (($11 | 0) != ($4 | 0)) {
		                   continue;
		                  }
		                  break;
		                 }
		                }
		                $1 = $1 + 1 | 0;
		                if (($6 | 0) != ($1 | 0)) {
		                 continue;
		                }
		                break;
		               }
		              }
		              $4 = HEAP32[$0 + 40 >> 2];
		              label$88 : {
		               if (!$4) {
		                break label$88;
		               }
		               $11 = HEAP32[$0 + 8 >> 2];
		               $29 = exp(+Math_fround(Math_fround($4 | 0) * Math_fround(.0006488140788860619)) * .6931471805599453);
		               $14 = Math_imul($12, $11);
		               if (($14 | 0) < 1) {
		                break label$88;
		               }
		               $10 = Math_fround($29);
		               $4 = 0;
		               while (1) {
		                $11 = ($4 << 2) + $3 | 0;
		                HEAPF32[$11 >> 2] = HEAPF32[$11 >> 2] * $10;
		                $4 = $4 + 1 | 0;
		                if (($14 | 0) != ($4 | 0)) {
		                 continue;
		                }
		                break;
		               }
		              }
		              $4 = HEAP32[$8 + 136 >> 2];
		              $11 = HEAP32[$8 + 172 >> 2];
		              HEAP32[$0 + 60 >> 2] = $16;
		              HEAP32[$0 + 68 >> 2] = ($19 ^ 1) & $24;
		              HEAP32[$0 + 84 >> 2] = ($2 | 0) < 2 ? 0 : $4 ^ $11;
		              $6 = ($20 | 0) < 0 ? $20 : $12;
		             }
		            }
		            __stack_pointer = $8 + 192 | 0;
		            return $6;
		           }
		           celt_fatal(36574, 35333, 493);
		           abort();
		          }
		          celt_fatal(36733, 35333, 502);
		          abort();
		         }
		         celt_fatal(36856, 35333, 505);
		         abort();
		        }
		        celt_fatal(37001, 35333, 509);
		        abort();
		       }
		       celt_fatal(37142, 35333, 516);
		       abort();
		      }
		      celt_fatal(36733, 35333, 531);
		      abort();
		     }
		     celt_fatal(37213, 35333, 549);
		     abort();
		    }
		    celt_fatal(37142, 35333, 556);
		    abort();
		   }
		   celt_fatal(36733, 35333, 557);
		   abort();
		  }
		  celt_fatal(36856, 35333, 560);
		  abort();
		 }
		 celt_fatal(36419, 35333, 488);
		 abort();
		}
		function quant_all_bands($0, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22) {
		 var $23 = 0, $24 = 0, $25 = 0, $26 = 0, $27 = 0, $28 = 0, $29 = 0, $30 = 0, $31 = 0, $32 = 0, $33 = Math_fround(0), $34 = Math_fround(0), $35 = 0, $36 = 0, $37 = 0, $38 = 0, $39 = 0, $40 = 0, $41 = 0, $42 = 0, $43 = 0, $44 = 0, $45 = 0, $46 = 0, $47 = 0, $48 = Math_fround(0), $49 = 0, $50 = 0, $51 = 0, $52 = 0, $53 = 0, $54 = 0, $55 = 0, $56 = 0, $57 = 0, $58 = 0, $59 = 0, $60 = 0, $61 = 0, $62 = 0, $63 = 0, $64 = 0, $65 = 0, $66 = 0, $67 = 0, $68 = 0, $69 = 0, $70 = 0, $71 = 0, $72 = 0, $73 = 0, $74 = 0, $75 = 0, $76 = 0, $77 = 0, $78 = 0, $79 = 0, $80 = 0, $81 = 0, $82 = 0, $83 = 0, $84 = 0, $85 = 0, $86 = Math_fround(0), $87 = 0, $88 = 0, $89 = 0, $90 = 0, $91 = 0, $92 = 0, $93 = 0, $94 = 0, $95 = 0, $96 = 0, $97 = 0, $98 = 0, $99 = 0, $100 = 0, $101 = 0, $102 = 0, $103 = 0, $104 = 0, $105 = 0, $106 = 0, $107 = 0, $108 = Math_fround(0);
		 $27 = __stack_pointer - 1568 | 0;
		 $25 = $27;
		 __stack_pointer = $25;
		 $28 = 1;
		 $37 = HEAP32[$1 + 32 >> 2];
		 $63 = $37 + ($2 << 1) | 0;
		 $41 = HEAP16[$63 >> 1] << $17;
		 $49 = $5 ? 2 : 1;
		 $31 = $25 - ((Math_imul($49, (HEAP16[((HEAP32[$1 + 8 >> 2] << 1) + $37 | 0) - 2 >> 1] << $17) - $41 | 0) << 2) + 15 & -16) | 0;
		 $26 = $31;
		 __stack_pointer = $26;
		 $27 = HEAP32[$1 + 8 >> 2];
		 $29 = HEAP16[(($27 << 1) + $37 | 0) - 2 >> 1];
		 $38 = $29 << $17 << 2;
		 $50 = !$11 & (($0 | 0) != 0 & ($5 | 0) != 0) & ($20 | 0) > 7;
		 $59 = $50 | !$0;
		 $39 = $9 ? 1 << $17 : 1;
		 label$1 : {
		  if ($50) {
		   $28 = HEAP16[($27 << 1) + $37 >> 1] - $29 << $17;
		   $32 = $26 - (($28 << 2) + 15 & -16) | 0;
		   $26 = $32;
		   __stack_pointer = $26;
		   break label$1;
		  }
		  $32 = $4 + $38 | 0;
		 }
		 $27 = ($28 << 2) + 15 & -16;
		 $64 = $26 - $27 | 0;
		 $26 = $64;
		 __stack_pointer = $26;
		 $65 = $26 - $27 | 0;
		 $26 = $65;
		 __stack_pointer = $26;
		 $66 = $26 - $27 | 0;
		 $26 = $66;
		 __stack_pointer = $26;
		 $67 = $26 - $27 | 0;
		 $26 = $67;
		 __stack_pointer = $26;
		 $60 = $26 - $27 | 0;
		 __stack_pointer = $60;
		 HEAP32[$25 + 1532 >> 2] = $16;
		 HEAP32[$25 + 1540 >> 2] = $7;
		 HEAP32[$25 + 1520 >> 2] = $12;
		 HEAP32[$25 + 1504 >> 2] = $0;
		 HEAP32[$25 + 1512 >> 2] = $1;
		 $27 = HEAP32[$19 >> 2];
		 HEAP32[$25 + 1556 >> 2] = $22;
		 HEAP32[$25 + 1548 >> 2] = $21;
		 HEAP32[$25 + 1524 >> 2] = $10;
		 HEAP32[$25 + 1544 >> 2] = $27;
		 $0 = ($39 | 0) > 1;
		 HEAP32[$25 + 1560 >> 2] = $0;
		 HEAP32[$25 + 1552 >> 2] = 0;
		 HEAP32[$25 + 1508 >> 2] = $59;
		 if (($2 | 0) < ($3 | 0)) {
		  $101 = $5 ? $31 : 0;
		  $102 = ($10 | 0) != 3 | $0;
		  $45 = $16 + 28 | 0;
		  $46 = $16 + 8 | 0;
		  $103 = $59 ^ 1;
		  $21 = $49 - 1 | 0;
		  $68 = $2 + 2 | 0;
		  $51 = $2 + 1 | 0;
		  $69 = $3 - 1 | 0;
		  $27 = 0 - $41 << 2;
		  $38 = ($31 + $38 | 0) - ($41 << 2) | 0;
		  $104 = $27 + $38 | 0;
		  $42 = $27 + $31 | 0;
		  $70 = -1 << $39 ^ -1;
		  $52 = $2;
		  $10 = 1;
		  while (1) {
		   $22 = $52;
		   HEAP32[$25 + 1516 >> 2] = $22;
		   label$5 : {
		    label$6 : {
		     $52 = $22 + 1 | 0;
		     $35 = ($22 << 1) + $37 | 0;
		     $0 = HEAP16[$35 >> 1] << $17;
		     $27 = (HEAP16[($52 << 1) + $37 >> 1] << $17) - $0 | 0;
		     if (($27 | 0) > 0) {
		      $61 = ec_tell_frac($16);
		      $26 = $14 - $61 | 0;
		      HEAP32[$25 + 1536 >> 2] = $26 - 1;
		      $71 = $15 - (($2 | 0) == ($22 | 0) ? 0 : $61) | 0;
		      $36 = 0;
		      label$8 : {
		       if (($18 | 0) <= ($22 | 0)) {
		        break label$8;
		       }
		       $15 = $18 - $22 | 0;
		       $15 = HEAP32[($22 << 2) + $8 >> 2] + (($71 | 0) / ((($15 | 0) < 3 ? $15 : 3) | 0) | 0) | 0;
		       $15 = ($15 | 0) > ($26 | 0) ? $26 : $15;
		       $36 = 16383;
		       if (($15 | 0) > 16383) {
		        break label$8;
		       }
		       $36 = ($15 | 0) > 0 ? $15 : 0;
		      }
		      $15 = $0 << 2;
		      $40 = !$59 | (((HEAP16[$35 >> 1] << $17) - $27 | 0) < HEAP16[$63 >> 1] << $17 ? ($22 | 0) != ($51 | 0) : 0) ? $40 : $10 ? $22 : $40 ? $40 : $22;
		      $0 = $5 + $15 | 0;
		      $72 = ($22 | 0) != ($51 | 0);
		      label$11 : {
		       if ($72) {
		        break label$11;
		       }
		       $26 = HEAP32[$1 + 32 >> 2];
		       $28 = HEAP16[$26 + ($51 << 1) >> 1];
		       $10 = $28 - HEAP16[($2 << 1) + $26 >> 1] << $17;
		       $9 = $10 << 2;
		       $26 = HEAP16[($68 << 1) + $26 >> 1] - $28 << $17;
		       $28 = ($10 << 1) - $26 << 2;
		       $26 = $26 - $10 << 2;
		       memcpy($31 + $9 | 0, $31 + $28 | 0, $26);
		       if (!$11) {
		        break label$11;
		       }
		       memcpy($9 + $38 | 0, $28 + $38 | 0, $26);
		      }
		      $43 = $5 ? $0 : 0;
		      $20 = $4 + $15 | 0;
		      $62 = $22 << 2;
		      $15 = HEAP32[$62 + $13 >> 2];
		      HEAP32[$25 + 1528 >> 2] = $15;
		      $29 = HEAP32[$1 + 12 >> 2] > ($22 | 0);
		      $32 = $29 ? $32 : 0;
		      $44 = ($22 | 0) == ($69 | 0);
		      $47 = $44 ? 0 : $32;
		      $30 = -1;
		      label$12 : {
		       if (!$40) {
		        $0 = $70;
		        $26 = $0;
		        break label$12;
		       }
		       $0 = $70;
		       $26 = $0;
		       if (!(($15 | 0) < 0 | $102)) {
		        break label$12;
		       }
		       $15 = ((HEAP16[($40 << 1) + $37 >> 1] << $17) - $41 | 0) - $27 | 0;
		       $30 = ($15 | 0) > 0 ? $15 : 0;
		       $0 = $41 + $30 | 0;
		       $15 = $40;
		       while (1) {
		        $26 = $15;
		        $15 = $15 - 1 | 0;
		        if (HEAP16[($15 << 1) + $37 >> 1] << $17 > ($0 | 0)) {
		         continue;
		        }
		        break;
		       }
		       $9 = $0 + $27 | 0;
		       $10 = $40 - 1 | 0;
		       $28 = (($22 | 0) < ($40 | 0) ? $40 : $22) - 1 | 0;
		       while (1) {
		        label$16 : {
		         $0 = $10;
		         if (($28 | 0) == ($0 | 0)) {
		          $0 = $28;
		          break label$16;
		         }
		         $10 = $0 + 1 | 0;
		         if (HEAP16[($10 << 1) + $37 >> 1] << $17 < ($9 | 0)) {
		          continue;
		         }
		        }
		        break;
		       }
		       $28 = ($0 | 0) < ($26 | 0) ? $15 : $0;
		       $0 = 0;
		       $26 = 0;
		       while (1) {
		        $10 = Math_imul($15, $49);
		        $0 = HEAPU8[$10 + $6 | 0] | $0;
		        $26 = HEAPU8[($10 + $21 | 0) + $6 | 0] | $26;
		        $10 = ($15 | 0) != ($28 | 0);
		        $15 = $15 + 1 | 0;
		        if ($10) {
		         continue;
		        }
		        break;
		       }
		      }
		      $32 = $50 ? $32 : $47;
		      $20 = $29 ? $20 : $31;
		      $9 = $29 ? $43 : $101;
		      if (!$11) {
		       break label$6;
		      }
		      if (!(($12 | 0) != ($22 | 0) | $103)) {
		       $15 = HEAP16[$35 >> 1] << $17;
		       if (($41 | 0) >= ($15 | 0)) {
		        break label$6;
		       }
		       $15 = $15 - $41 | 0;
		       $29 = ($15 | 0) > 1 ? $15 : 1;
		       $15 = 0;
		       while (1) {
		        $10 = $15 << 2;
		        $28 = $31 + $10 | 0;
		        HEAPF32[$28 >> 2] = Math_fround(HEAPF32[$28 >> 2] + HEAPF32[$10 + $38 >> 2]) * Math_fround(.5);
		        $15 = $15 + 1 | 0;
		        if (($29 | 0) != ($15 | 0)) {
		         continue;
		        }
		        break;
		       }
		       break label$6;
		      }
		      if (($12 | 0) == ($22 | 0)) {
		       break label$6;
		      }
		      $10 = $30 << 2;
		      $28 = ($30 | 0) == -1;
		      $29 = $28 ? 0 : $31 + $10 | 0;
		      $15 = $36 >>> 1 | 0;
		      label$21 : {
		       if (($22 | 0) == ($69 | 0)) {
		        $30 = 0;
		        $10 = $28 ? 0 : $10 + $38 | 0;
		        $20 = quant_band($25 + 1504 | 0, $20, $27, $15, $39, $29, $17, 0, Math_fround(1), $32, $0);
		        break label$21;
		       }
		       $10 = $28 ? 0 : $10 + $38 | 0;
		       $20 = quant_band($25 + 1504 | 0, $20, $27, $15, $39, $29, $17, (HEAP16[$35 >> 1] << $17 << 2) + $42 | 0, Math_fround(1), $32, $0);
		       $30 = (HEAP16[$35 >> 1] << $17 << 2) + $104 | 0;
		      }
		      $15 = quant_band($25 + 1504 | 0, $9, $27, $15, $39, $10, $17, $30, Math_fround(1), $32, $26);
		      break label$5;
		     }
		     celt_fatal(33508, 33495, 1495);
		     abort();
		    }
		    label$23 : {
		     if ($9) {
		      if (!($50 ^ 1 | ($12 | 0) <= ($22 | 0))) {
		       $33 = HEAPF32[$7 + $62 >> 2];
		       $34 = HEAPF32[(HEAP32[$1 + 8 >> 2] + $22 << 2) + $7 >> 2];
		       $73 = HEAP32[$16 + 4 >> 2];
		       $74 = HEAP32[$16 >> 2];
		       $24 = $46;
		       $23 = HEAP32[$24 + 8 >> 2];
		       $15 = HEAP32[$24 + 12 >> 2];
		       $10 = $23;
		       $75 = $25 + 1496 | 0;
		       $23 = $75;
		       HEAP32[$23 >> 2] = $10;
		       HEAP32[$23 + 4 >> 2] = $15;
		       $23 = HEAP32[$24 + 4 >> 2];
		       $15 = HEAP32[$24 >> 2];
		       $10 = $15;
		       $15 = $25;
		       HEAP32[$15 + 1488 >> 2] = $10;
		       HEAP32[$15 + 1492 >> 2] = $23;
		       $47 = HEAP32[$16 + 24 >> 2];
		       $76 = $15 + 1480 | 0;
		       HEAP32[$76 >> 2] = HEAP32[$45 + 16 >> 2];
		       $77 = $15 + 1472 | 0;
		       $24 = $45;
		       $23 = HEAP32[$24 + 8 >> 2];
		       $15 = HEAP32[$24 + 12 >> 2];
		       $10 = $23;
		       $23 = $77;
		       HEAP32[$23 >> 2] = $10;
		       HEAP32[$23 + 4 >> 2] = $15;
		       $23 = HEAP32[$24 + 4 >> 2];
		       $15 = HEAP32[$24 >> 2];
		       $10 = $15;
		       $15 = $25;
		       HEAP32[$15 + 1464 >> 2] = $10;
		       HEAP32[$15 + 1468 >> 2] = $23;
		       $78 = $15 + 1408 | 0;
		       $53 = $15 + 1560 | 0;
		       HEAP32[$78 >> 2] = HEAP32[$53 >> 2];
		       $79 = $15 + 1400 | 0;
		       $43 = $15 + 1552 | 0;
		       $24 = $43;
		       $23 = HEAP32[$24 >> 2];
		       $15 = HEAP32[$24 + 4 >> 2];
		       $10 = $23;
		       $23 = $79;
		       HEAP32[$23 >> 2] = $10;
		       HEAP32[$23 + 4 >> 2] = $15;
		       $54 = $25 + 1544 | 0;
		       $24 = $54;
		       $15 = HEAP32[$24 >> 2];
		       $23 = HEAP32[$24 + 4 >> 2];
		       $10 = $15;
		       $80 = $25 + 1392 | 0;
		       $15 = $80;
		       HEAP32[$15 >> 2] = $10;
		       HEAP32[$15 + 4 >> 2] = $23;
		       $55 = $25 + 1536 | 0;
		       $24 = $55;
		       $23 = HEAP32[$24 >> 2];
		       $15 = HEAP32[$24 + 4 >> 2];
		       $10 = $23;
		       $81 = $25 + 1384 | 0;
		       $23 = $81;
		       HEAP32[$23 >> 2] = $10;
		       HEAP32[$23 + 4 >> 2] = $15;
		       $56 = $25 + 1528 | 0;
		       $24 = $56;
		       $15 = HEAP32[$24 >> 2];
		       $23 = HEAP32[$24 + 4 >> 2];
		       $10 = $15;
		       $82 = $25 + 1376 | 0;
		       $15 = $82;
		       HEAP32[$15 >> 2] = $10;
		       HEAP32[$15 + 4 >> 2] = $23;
		       $57 = $25 + 1520 | 0;
		       $24 = $57;
		       $23 = HEAP32[$24 >> 2];
		       $15 = HEAP32[$24 + 4 >> 2];
		       $10 = $23;
		       $83 = $25 + 1368 | 0;
		       $23 = $83;
		       HEAP32[$23 >> 2] = $10;
		       HEAP32[$23 + 4 >> 2] = $15;
		       $58 = $25 + 1512 | 0;
		       $24 = $58;
		       $15 = HEAP32[$24 >> 2];
		       $23 = HEAP32[$24 + 4 >> 2];
		       $10 = $15;
		       $84 = $25 + 1360 | 0;
		       $15 = $84;
		       HEAP32[$15 >> 2] = $10;
		       HEAP32[$15 + 4 >> 2] = $23;
		       $24 = $25;
		       $23 = HEAP32[$24 + 1504 >> 2];
		       $15 = HEAP32[$24 + 1508 >> 2];
		       $10 = $23;
		       $23 = $24;
		       HEAP32[$23 + 1352 >> 2] = $10;
		       HEAP32[$23 + 1356 >> 2] = $15;
		       $11 = $27 << 2;
		       $10 = memcpy($64, $20, $11);
		       $28 = memcpy($65, $9, $11);
		       HEAP32[$43 >> 2] = -1;
		       $15 = 0;
		       $85 = $0 | $26;
		       $0 = 0;
		       $48 = Math_fround(($33 < $34 ? $33 : $34) / Math_fround(3));
		       $86 = Math_fround($34 + $48);
		       $48 = Math_fround($33 + $48);
		       $33 = Math_fround(0);
		       $30 = ($30 | 0) == -1 ? 0 : ($30 << 2) + $31 | 0;
		       $0 = $44 ? $0 : (HEAP16[$35 >> 1] << $17 << 2) + $42 | 0;
		       $105 = quant_band_stereo($23 + 1504 | 0, $20, $9, $27, $36, $39, $30, $17, $0, $32, $85);
		       $34 = Math_fround(0);
		       while (1) {
		        $0 = $15 << 2;
		        $34 = Math_fround($34 + Math_fround(HEAPF32[$10 + $0 >> 2] * HEAPF32[$0 + $20 >> 2]));
		        $15 = $15 + 1 | 0;
		        if (($27 | 0) != ($15 | 0)) {
		         continue;
		        }
		        break;
		       }
		       $15 = 0;
		       while (1) {
		        $0 = $15 << 2;
		        $33 = Math_fround($33 + Math_fround(HEAPF32[$28 + $0 >> 2] * HEAPF32[$0 + $9 >> 2]));
		        $15 = $15 + 1 | 0;
		        if (($27 | 0) != ($15 | 0)) {
		         continue;
		        }
		        break;
		       }
		       $24 = $16;
		       $15 = HEAP32[$24 + 40 >> 2];
		       $23 = HEAP32[$24 + 44 >> 2];
		       $0 = $15;
		       $87 = $25 + 1456 | 0;
		       $15 = $87;
		       HEAP32[$15 >> 2] = $0;
		       HEAP32[$15 + 4 >> 2] = $23;
		       $15 = HEAP32[$24 + 36 >> 2];
		       $23 = HEAP32[$24 + 32 >> 2];
		       $0 = $23;
		       $88 = $25 + 1448 | 0;
		       $23 = $88;
		       HEAP32[$23 >> 2] = $0;
		       HEAP32[$23 + 4 >> 2] = $15;
		       $23 = HEAP32[$24 + 28 >> 2];
		       $15 = HEAP32[$24 + 24 >> 2];
		       $0 = $15;
		       $89 = $25 + 1440 | 0;
		       $15 = $89;
		       HEAP32[$15 >> 2] = $0;
		       HEAP32[$15 + 4 >> 2] = $23;
		       $15 = HEAP32[$24 + 20 >> 2];
		       $23 = HEAP32[$24 + 16 >> 2];
		       $0 = $23;
		       $90 = $25 + 1432 | 0;
		       $23 = $90;
		       HEAP32[$23 >> 2] = $0;
		       HEAP32[$23 + 4 >> 2] = $15;
		       $24 = $46;
		       $15 = HEAP32[$24 >> 2];
		       $23 = HEAP32[$24 + 4 >> 2];
		       $0 = $15;
		       $91 = $25 + 1424 | 0;
		       $15 = $91;
		       HEAP32[$15 >> 2] = $0;
		       HEAP32[$15 + 4 >> 2] = $23;
		       $24 = $16;
		       $23 = HEAP32[$24 >> 2];
		       $26 = $23;
		       $15 = HEAP32[$24 + 4 >> 2];
		       $0 = $15;
		       $24 = $58;
		       $15 = HEAP32[$24 >> 2];
		       $23 = HEAP32[$24 + 4 >> 2];
		       $24 = $15;
		       $92 = $25 + 1296 | 0;
		       $15 = $92;
		       HEAP32[$15 >> 2] = $24;
		       HEAP32[$15 + 4 >> 2] = $23;
		       $24 = $57;
		       $23 = HEAP32[$24 >> 2];
		       $15 = HEAP32[$24 + 4 >> 2];
		       $24 = $23;
		       $93 = $25 + 1304 | 0;
		       $23 = $93;
		       HEAP32[$23 >> 2] = $24;
		       HEAP32[$23 + 4 >> 2] = $15;
		       $24 = $56;
		       $15 = HEAP32[$24 >> 2];
		       $23 = HEAP32[$24 + 4 >> 2];
		       $24 = $15;
		       $94 = $25 + 1312 | 0;
		       $15 = $94;
		       HEAP32[$15 >> 2] = $24;
		       HEAP32[$15 + 4 >> 2] = $23;
		       $24 = $55;
		       $23 = HEAP32[$24 >> 2];
		       $15 = HEAP32[$24 + 4 >> 2];
		       $24 = $23;
		       $95 = $25 + 1320 | 0;
		       $23 = $95;
		       HEAP32[$23 >> 2] = $24;
		       HEAP32[$23 + 4 >> 2] = $15;
		       $24 = $54;
		       $15 = HEAP32[$24 >> 2];
		       $23 = HEAP32[$24 + 4 >> 2];
		       $24 = $15;
		       $96 = $25 + 1328 | 0;
		       $15 = $96;
		       HEAP32[$15 >> 2] = $24;
		       HEAP32[$15 + 4 >> 2] = $23;
		       $24 = $43;
		       $23 = HEAP32[$24 >> 2];
		       $15 = HEAP32[$24 + 4 >> 2];
		       $24 = $23;
		       $97 = $25 + 1336 | 0;
		       $23 = $97;
		       HEAP32[$23 >> 2] = $24;
		       HEAP32[$23 + 4 >> 2] = $15;
		       $98 = $25 + 1344 | 0;
		       HEAP32[$98 >> 2] = HEAP32[$53 >> 2];
		       $23 = $25;
		       HEAP32[$23 + 1416 >> 2] = $26;
		       $15 = $0;
		       HEAP32[$23 + 1420 >> 2] = $15;
		       $24 = $23;
		       $15 = HEAP32[$23 + 1504 >> 2];
		       $23 = HEAP32[$23 + 1508 >> 2];
		       $0 = $15;
		       $15 = $24;
		       HEAP32[$15 + 1288 >> 2] = $0;
		       HEAP32[$15 + 1292 >> 2] = $23;
		       $106 = memcpy($66, $20, $11);
		       $107 = memcpy($67, $9, $11);
		       if (!$44) {
		        memcpy($60, (HEAP16[$35 >> 1] << $17 << 2) + $42 | 0, $11);
		       }
		       $99 = $47 + $74 | 0;
		       $100 = $73 - $47 | 0;
		       $29 = memcpy($25, $99, $100);
		       HEAP32[$16 + 4 >> 2] = $73;
		       HEAP32[$16 >> 2] = $74;
		       $24 = $75;
		       $23 = HEAP32[$24 >> 2];
		       $15 = HEAP32[$24 + 4 >> 2];
		       $0 = $23;
		       $23 = $46;
		       HEAP32[$23 + 8 >> 2] = $0;
		       HEAP32[$23 + 12 >> 2] = $15;
		       $24 = $29;
		       $15 = HEAP32[$24 + 1488 >> 2];
		       $23 = HEAP32[$24 + 1492 >> 2];
		       $0 = $15;
		       $15 = $46;
		       HEAP32[$15 >> 2] = $0;
		       HEAP32[$15 + 4 >> 2] = $23;
		       HEAP32[$16 + 24 >> 2] = $47;
		       HEAP32[$45 + 16 >> 2] = HEAP32[$76 >> 2];
		       $24 = $77;
		       $23 = HEAP32[$24 >> 2];
		       $15 = HEAP32[$24 + 4 >> 2];
		       $0 = $23;
		       $23 = $45;
		       HEAP32[$23 + 8 >> 2] = $0;
		       HEAP32[$23 + 12 >> 2] = $15;
		       $24 = $29;
		       $15 = HEAP32[$24 + 1464 >> 2];
		       $23 = HEAP32[$24 + 1468 >> 2];
		       $0 = $15;
		       $15 = $45;
		       HEAP32[$15 >> 2] = $0;
		       HEAP32[$15 + 4 >> 2] = $23;
		       $24 = $84;
		       $23 = HEAP32[$24 >> 2];
		       $15 = HEAP32[$24 + 4 >> 2];
		       $0 = $23;
		       $23 = $58;
		       HEAP32[$23 >> 2] = $0;
		       HEAP32[$23 + 4 >> 2] = $15;
		       $24 = $83;
		       $15 = HEAP32[$24 >> 2];
		       $23 = HEAP32[$24 + 4 >> 2];
		       $0 = $15;
		       $15 = $57;
		       HEAP32[$15 >> 2] = $0;
		       HEAP32[$15 + 4 >> 2] = $23;
		       $24 = $82;
		       $23 = HEAP32[$24 >> 2];
		       $15 = HEAP32[$24 + 4 >> 2];
		       $0 = $23;
		       $23 = $56;
		       HEAP32[$23 >> 2] = $0;
		       HEAP32[$23 + 4 >> 2] = $15;
		       $24 = $81;
		       $15 = HEAP32[$24 >> 2];
		       $23 = HEAP32[$24 + 4 >> 2];
		       $0 = $15;
		       $15 = $55;
		       HEAP32[$15 >> 2] = $0;
		       HEAP32[$15 + 4 >> 2] = $23;
		       $24 = $80;
		       $23 = HEAP32[$24 >> 2];
		       $15 = HEAP32[$24 + 4 >> 2];
		       $0 = $23;
		       $23 = $54;
		       HEAP32[$23 >> 2] = $0;
		       HEAP32[$23 + 4 >> 2] = $15;
		       $24 = $79;
		       $15 = HEAP32[$24 >> 2];
		       $23 = HEAP32[$24 + 4 >> 2];
		       $0 = $15;
		       $15 = $43;
		       HEAP32[$15 >> 2] = $0;
		       HEAP32[$15 + 4 >> 2] = $23;
		       HEAP32[$53 >> 2] = HEAP32[$78 >> 2];
		       $24 = $29;
		       $23 = HEAP32[$24 + 1352 >> 2];
		       $15 = HEAP32[$24 + 1356 >> 2];
		       $0 = $23;
		       $23 = $24;
		       HEAP32[$23 + 1504 >> 2] = $0;
		       HEAP32[$23 + 1508 >> 2] = $15;
		       $26 = memcpy($20, $10, $11);
		       $9 = memcpy($9, $28, $11);
		       if (!$72) {
		        $15 = HEAP32[$1 + 32 >> 2];
		        $20 = HEAP16[$15 + ($51 << 1) >> 1];
		        $0 = $20 - HEAP16[($2 << 1) + $15 >> 1] << $17;
		        $15 = HEAP16[($68 << 1) + $15 >> 1] - $20 << $17;
		        memcpy(($0 << 2) + $31 | 0, (($0 << 1) - $15 << 2) + $31 | 0, $15 - $0 << 2);
		       }
		       HEAP32[$29 + 1552 >> 2] = 1;
		       $15 = 0;
		       $0 = 0;
		       $34 = Math_fround($48 * $34);
		       $33 = Math_fround($86 * $33);
		       $108 = Math_fround($34 + $33);
		       $33 = Math_fround(0);
		       $0 = $44 ? $0 : (HEAP16[$35 >> 1] << $17 << 2) + $42 | 0;
		       $20 = quant_band_stereo($29 + 1504 | 0, $26, $9, $27, $36, $39, $30, $17, $0, $32, $85);
		       $34 = Math_fround(0);
		       while (1) {
		        $0 = $15 << 2;
		        $34 = Math_fround($34 + Math_fround(HEAPF32[$10 + $0 >> 2] * HEAPF32[$0 + $26 >> 2]));
		        $15 = $15 + 1 | 0;
		        if (($27 | 0) != ($15 | 0)) {
		         continue;
		        }
		        break;
		       }
		       $15 = 0;
		       while (1) {
		        $0 = $15 << 2;
		        $33 = Math_fround($33 + Math_fround(HEAPF32[$28 + $0 >> 2] * HEAPF32[$0 + $9 >> 2]));
		        $15 = $15 + 1 | 0;
		        if (($27 | 0) != ($15 | 0)) {
		         continue;
		        }
		        break;
		       }
		       if (!(Math_fround(Math_fround($48 * $34) + Math_fround($86 * $33)) <= $108 ^ 1)) {
		        $15 = HEAP32[$29 + 1416 >> 2];
		        $23 = HEAP32[$24 + 1420 >> 2];
		        $0 = $15;
		        $15 = $16;
		        HEAP32[$15 >> 2] = $0;
		        HEAP32[$15 + 4 >> 2] = $23;
		        $24 = $87;
		        $23 = HEAP32[$24 >> 2];
		        $15 = HEAP32[$24 + 4 >> 2];
		        $0 = $23;
		        $23 = $16;
		        HEAP32[$23 + 40 >> 2] = $0;
		        HEAP32[$23 + 44 >> 2] = $15;
		        $24 = $88;
		        $15 = HEAP32[$24 >> 2];
		        $23 = HEAP32[$24 + 4 >> 2];
		        $0 = $15;
		        $15 = $16;
		        HEAP32[$15 + 32 >> 2] = $0;
		        HEAP32[$15 + 36 >> 2] = $23;
		        $24 = $89;
		        $23 = HEAP32[$24 >> 2];
		        $15 = HEAP32[$24 + 4 >> 2];
		        $0 = $23;
		        $23 = $16;
		        HEAP32[$23 + 24 >> 2] = $0;
		        HEAP32[$23 + 28 >> 2] = $15;
		        $24 = $90;
		        $15 = HEAP32[$24 >> 2];
		        $23 = HEAP32[$24 + 4 >> 2];
		        $0 = $15;
		        $15 = $16;
		        HEAP32[$15 + 16 >> 2] = $0;
		        HEAP32[$15 + 20 >> 2] = $23;
		        $24 = $91;
		        $23 = HEAP32[$24 >> 2];
		        $15 = HEAP32[$24 + 4 >> 2];
		        $0 = $23;
		        $23 = $46;
		        HEAP32[$23 >> 2] = $0;
		        HEAP32[$23 + 4 >> 2] = $15;
		        $24 = $92;
		        $15 = HEAP32[$24 >> 2];
		        $23 = HEAP32[$24 + 4 >> 2];
		        $0 = $15;
		        $15 = $58;
		        HEAP32[$15 >> 2] = $0;
		        HEAP32[$15 + 4 >> 2] = $23;
		        $24 = $93;
		        $23 = HEAP32[$24 >> 2];
		        $15 = HEAP32[$24 + 4 >> 2];
		        $0 = $23;
		        $23 = $57;
		        HEAP32[$23 >> 2] = $0;
		        HEAP32[$23 + 4 >> 2] = $15;
		        $24 = $94;
		        $15 = HEAP32[$24 >> 2];
		        $23 = HEAP32[$24 + 4 >> 2];
		        $0 = $15;
		        $15 = $56;
		        HEAP32[$15 >> 2] = $0;
		        HEAP32[$15 + 4 >> 2] = $23;
		        $24 = $95;
		        $23 = HEAP32[$24 >> 2];
		        $15 = HEAP32[$24 + 4 >> 2];
		        $0 = $23;
		        $23 = $55;
		        HEAP32[$23 >> 2] = $0;
		        HEAP32[$23 + 4 >> 2] = $15;
		        $24 = $96;
		        $15 = HEAP32[$24 >> 2];
		        $23 = HEAP32[$24 + 4 >> 2];
		        $0 = $15;
		        $15 = $54;
		        HEAP32[$15 >> 2] = $0;
		        HEAP32[$15 + 4 >> 2] = $23;
		        $24 = $97;
		        $23 = HEAP32[$24 >> 2];
		        $15 = HEAP32[$24 + 4 >> 2];
		        $0 = $23;
		        $23 = $43;
		        HEAP32[$23 >> 2] = $0;
		        HEAP32[$23 + 4 >> 2] = $15;
		        HEAP32[$53 >> 2] = HEAP32[$98 >> 2];
		        $24 = $29;
		        $15 = HEAP32[$24 + 1288 >> 2];
		        $23 = HEAP32[$24 + 1292 >> 2];
		        $0 = $15;
		        $15 = $24;
		        HEAP32[$15 + 1504 >> 2] = $0;
		        HEAP32[$15 + 1508 >> 2] = $23;
		        memcpy($26, $106, $11);
		        memcpy($9, $107, $11);
		        if (!$44) {
		         memcpy((HEAP16[$35 >> 1] << $17 << 2) + $42 | 0, $60, $11);
		        }
		        memcpy($99, $29, $100);
		        $20 = $105;
		       }
		       $11 = 0;
		       break label$23;
		      }
		      $11 = 0;
		      HEAP32[$25 + 1552 >> 2] = 0;
		      $15 = 0;
		      $10 = ($30 | 0) == -1 ? 0 : ($30 << 2) + $31 | 0;
		      $15 = $44 ? $15 : (HEAP16[$35 >> 1] << $17 << 2) + $42 | 0;
		      $20 = quant_band_stereo($25 + 1504 | 0, $20, $9, $27, $36, $39, $10, $17, $15, $32, $0 | $26);
		      break label$23;
		     }
		     $11 = 0;
		     $15 = 0;
		     $10 = ($30 | 0) == -1 ? 0 : ($30 << 2) + $31 | 0;
		     $15 = $44 ? $15 : (HEAP16[$35 >> 1] << $17 << 2) + $42 | 0;
		     $20 = quant_band($25 + 1504 | 0, $20, $27, $36, $39, $10, $17, $15, Math_fround(1), $32, $0 | $26);
		    }
		    $15 = $20;
		   }
		   $0 = Math_imul($22, $49);
		   HEAP8[$6 + $0 | 0] = $20;
		   HEAP8[($0 + $21 | 0) + $6 | 0] = $15;
		   $15 = HEAP32[$8 + $62 >> 2];
		   HEAP32[$25 + 1560 >> 2] = 0;
		   $15 = ($61 + $71 | 0) + $15 | 0;
		   $10 = $27 << 3 < ($36 | 0);
		   if (($3 | 0) != ($52 | 0)) {
		    continue;
		   }
		   break;
		  }
		  $27 = HEAP32[$25 + 1544 >> 2];
		 }
		 HEAP32[$19 >> 2] = $27;
		 __stack_pointer = $25 + 1568 | 0;
		}
		function printf_core($0, $1, $2, $3, $4, $5, $6) {
		 var $7 = 0, $8 = 0, $9 = 0, $10 = 0, $11 = 0, $12 = 0, $13 = 0, $14 = 0, $15 = 0, $16 = 0, $17 = 0, $18 = 0, $19 = 0, $20 = 0, $21 = 0, $22 = 0;
		 $7 = __stack_pointer - 80 | 0;
		 __stack_pointer = $7;
		 HEAP32[$7 + 76 >> 2] = $1;
		 $22 = $7 + 55 | 0;
		 $20 = $7 + 56 | 0;
		 $1 = 0;
		 label$1 : {
		  label$2 : while (1) {
		   label$3 : {
		    if (($17 | 0) < 0) {
		     break label$3;
		    }
		    if ((2147483647 - $17 | 0) < ($1 | 0)) {
		     HEAP32[__errno_location() >> 2] = 61;
		     $17 = -1;
		     break label$3;
		    }
		    $17 = $1 + $17 | 0;
		   }
		   label$5 : {
		    label$7 : {
		     label$8 : {
		      $13 = HEAP32[$7 + 76 >> 2];
		      $1 = $13;
		      $8 = HEAPU8[$1 | 0];
		      if ($8) {
		       while (1) {
		        label$11 : {
		         $8 = $8 & 255;
		         label$12 : {
		          if (!$8) {
		           $8 = $1;
		           break label$12;
		          }
		          if (($8 | 0) != 37) {
		           break label$11;
		          }
		          $8 = $1;
		          while (1) {
		           if (HEAPU8[$1 + 1 | 0] != 37) {
		            break label$12;
		           }
		           $9 = $1 + 2 | 0;
		           HEAP32[$7 + 76 >> 2] = $9;
		           $8 = $8 + 1 | 0;
		           $12 = HEAPU8[$1 + 2 | 0];
		           $1 = $9;
		           if (($12 | 0) == 37) {
		            continue;
		           }
		           break;
		          }
		         }
		         $1 = $8 - $13 | 0;
		         if ($0) {
		          out($0, $13, $1);
		         }
		         if ($1) {
		          continue label$2;
		         }
		         $1 = isdigit(HEAP8[HEAP32[$7 + 76 >> 2] + 1 | 0]);
		         $10 = $7;
		         $8 = HEAP32[$7 + 76 >> 2];
		         label$16 : {
		          if (!(!$1 | HEAPU8[$8 + 2 | 0] != 36)) {
		           $21 = 1;
		           $1 = $8 + 3 | 0;
		           $19 = HEAP8[$8 + 1 | 0] - 48 | 0;
		           break label$16;
		          }
		          $1 = $8 + 1 | 0;
		          $19 = -1;
		         }
		         HEAP32[$10 + 76 >> 2] = $1;
		         $18 = 0;
		         $12 = HEAP8[$1 | 0];
		         $9 = $12 - 32 | 0;
		         label$18 : {
		          if ($9 >>> 0 > 31) {
		           $8 = $1;
		           break label$18;
		          }
		          $8 = $1;
		          $9 = 1 << $9;
		          if (!($9 & 75913)) {
		           break label$18;
		          }
		          while (1) {
		           $8 = $1 + 1 | 0;
		           HEAP32[$7 + 76 >> 2] = $8;
		           $18 = $9 | $18;
		           $12 = HEAP8[$1 + 1 | 0];
		           $9 = $12 - 32 | 0;
		           if ($9 >>> 0 >= 32) {
		            break label$18;
		           }
		           $1 = $8;
		           $9 = 1 << $9;
		           if ($9 & 75913) {
		            continue;
		           }
		           break;
		          }
		         }
		         label$21 : {
		          if (($12 | 0) == 42) {
		           $10 = $7;
		           label$23 : {
		            label$24 : {
		             if (!isdigit(HEAP8[$8 + 1 | 0])) {
		              break label$24;
		             }
		             $8 = HEAP32[$7 + 76 >> 2];
		             if (HEAPU8[$8 + 2 | 0] != 36) {
		              break label$24;
		             }
		             HEAP32[((HEAP8[$8 + 1 | 0] << 2) + $4 | 0) - 192 >> 2] = 10;
		             $15 = HEAP32[((HEAP8[$8 + 1 | 0] << 3) + $3 | 0) - 384 >> 2];
		             $21 = 1;
		             $1 = $8 + 3 | 0;
		             break label$23;
		            }
		            if ($21) {
		             break label$8;
		            }
		            $21 = 0;
		            $15 = 0;
		            if ($0) {
		             $1 = HEAP32[$2 >> 2];
		             HEAP32[$2 >> 2] = $1 + 4;
		             $15 = HEAP32[$1 >> 2];
		            }
		            $1 = HEAP32[$7 + 76 >> 2] + 1 | 0;
		           }
		           HEAP32[$10 + 76 >> 2] = $1;
		           if (($15 | 0) > -1) {
		            break label$21;
		           }
		           $15 = 0 - $15 | 0;
		           $18 = $18 | 8192;
		           break label$21;
		          }
		          $15 = getint($7 + 76 | 0);
		          if (($15 | 0) < 0) {
		           break label$8;
		          }
		          $1 = HEAP32[$7 + 76 >> 2];
		         }
		         $11 = -1;
		         label$26 : {
		          if (HEAPU8[$1 | 0] != 46) {
		           break label$26;
		          }
		          if (HEAPU8[$1 + 1 | 0] == 42) {
		           label$28 : {
		            if (!isdigit(HEAP8[$1 + 2 | 0])) {
		             break label$28;
		            }
		            $1 = HEAP32[$7 + 76 >> 2];
		            if (HEAPU8[$1 + 3 | 0] != 36) {
		             break label$28;
		            }
		            HEAP32[((HEAP8[$1 + 2 | 0] << 2) + $4 | 0) - 192 >> 2] = 10;
		            $11 = HEAP32[((HEAP8[$1 + 2 | 0] << 3) + $3 | 0) - 384 >> 2];
		            $1 = $1 + 4 | 0;
		            HEAP32[$7 + 76 >> 2] = $1;
		            break label$26;
		           }
		           if ($21) {
		            break label$8;
		           }
		           if ($0) {
		            $1 = HEAP32[$2 >> 2];
		            HEAP32[$2 >> 2] = $1 + 4;
		            $11 = HEAP32[$1 >> 2];
		           } else {
		            $11 = 0;
		           }
		           $1 = HEAP32[$7 + 76 >> 2] + 2 | 0;
		           HEAP32[$7 + 76 >> 2] = $1;
		           break label$26;
		          }
		          HEAP32[$7 + 76 >> 2] = $1 + 1;
		          $11 = getint($7 + 76 | 0);
		          $1 = HEAP32[$7 + 76 >> 2];
		         }
		         $8 = 0;
		         while (1) {
		          $9 = $8;
		          $16 = -1;
		          if (HEAP8[$1 | 0] - 65 >>> 0 > 57) {
		           break label$1;
		          }
		          $12 = $1 + 1 | 0;
		          HEAP32[$7 + 76 >> 2] = $12;
		          $8 = HEAP8[$1 | 0];
		          $1 = $12;
		          $8 = HEAPU8[(Math_imul($9, 58) + $8 | 0) + 991 | 0];
		          if ($8 - 1 >>> 0 < 8) {
		           continue;
		          }
		          break;
		         }
		         label$32 : {
		          label$33 : {
		           if (($8 | 0) != 19) {
		            if (!$8) {
		             break label$1;
		            }
		            if (($19 | 0) >= 0) {
		             HEAP32[($19 << 2) + $4 >> 2] = $8;
		             $10 = ($19 << 3) + $3 | 0;
		             $14 = HEAP32[$10 >> 2];
		             $10 = HEAP32[$10 + 4 >> 2];
		             HEAP32[$7 + 64 >> 2] = $14;
		             HEAP32[$7 + 68 >> 2] = $10;
		             break label$33;
		            }
		            if (!$0) {
		             break label$5;
		            }
		            pop_arg($7 - -64 | 0, $8, $2, $6);
		            $12 = HEAP32[$7 + 76 >> 2];
		            break label$32;
		           }
		           if (($19 | 0) > -1) {
		            break label$1;
		           }
		          }
		          $1 = 0;
		          if (!$0) {
		           continue label$2;
		          }
		         }
		         $14 = $18 & -65537;
		         $8 = $18 & 8192 ? $14 : $18;
		         $16 = 0;
		         $19 = 1028;
		         $18 = $20;
		         label$36 : {
		          label$37 : {
		           label$38 : {
		            label$39 : {
		             label$40 : {
		              label$41 : {
		               label$42 : {
		                label$43 : {
		                 label$44 : {
		                  label$45 : {
		                   label$46 : {
		                    label$47 : {
		                     label$48 : {
		                      label$49 : {
		                       label$50 : {
		                        label$51 : {
		                         $1 = HEAP8[$12 - 1 | 0];
		                         $1 = $9 ? ($1 & 15) == 3 ? $1 & -33 : $1 : $1;
		                         switch ($1 - 88 | 0) {
		                         case 11:
		                          break label$36;
		                         case 9:
		                         case 13:
		                         case 14:
		                         case 15:
		                          break label$37;
		                         case 27:
		                          break label$42;
		                         case 12:
		                         case 17:
		                          break label$45;
		                         case 23:
		                          break label$46;
		                         case 0:
		                         case 32:
		                          break label$47;
		                         case 24:
		                          break label$48;
		                         case 22:
		                          break label$49;
		                         case 29:
		                          break label$50;
		                         case 1:
		                         case 2:
		                         case 3:
		                         case 4:
		                         case 5:
		                         case 6:
		                         case 7:
		                         case 8:
		                         case 10:
		                         case 16:
		                         case 18:
		                         case 19:
		                         case 20:
		                         case 21:
		                         case 25:
		                         case 26:
		                         case 28:
		                         case 30:
		                         case 31:
		                          break label$7;
		                         default:
		                          break label$51;
		                         }
		                        }
		                        label$52 : {
		                         switch ($1 - 65 | 0) {
		                         case 0:
		                         case 4:
		                         case 5:
		                         case 6:
		                          break label$37;
		                         case 2:
		                          break label$40;
		                         case 1:
		                         case 3:
		                          break label$7;
		                         default:
		                          break label$52;
		                         }
		                        }
		                        if (($1 | 0) == 83) {
		                         break label$41;
		                        }
		                        break label$7;
		                       }
		                       $10 = HEAP32[$7 + 64 >> 2];
		                       $9 = $10;
		                       $14 = HEAP32[$7 + 68 >> 2];
		                       $1 = $14;
		                       $19 = 1028;
		                       break label$44;
		                      }
		                      $1 = 0;
		                      label$53 : {
		                       switch ($9 & 255) {
		                       case 0:
		                        HEAP32[HEAP32[$7 + 64 >> 2] >> 2] = $17;
		                        continue label$2;
		                       case 1:
		                        HEAP32[HEAP32[$7 + 64 >> 2] >> 2] = $17;
		                        continue label$2;
		                       case 2:
		                        $10 = $17;
		                        $14 = $10 >> 31;
		                        $10 = HEAP32[$7 + 64 >> 2];
		                        HEAP32[$10 >> 2] = $17;
		                        HEAP32[$10 + 4 >> 2] = $14;
		                        continue label$2;
		                       case 3:
		                        HEAP16[HEAP32[$7 + 64 >> 2] >> 1] = $17;
		                        continue label$2;
		                       case 4:
		                        HEAP8[HEAP32[$7 + 64 >> 2]] = $17;
		                        continue label$2;
		                       case 6:
		                        HEAP32[HEAP32[$7 + 64 >> 2] >> 2] = $17;
		                        continue label$2;
		                       case 7:
		                        break label$53;
		                       default:
		                        continue label$2;
		                       }
		                      }
		                      $10 = $17;
		                      $14 = $10 >> 31;
		                      $10 = HEAP32[$7 + 64 >> 2];
		                      HEAP32[$10 >> 2] = $17;
		                      HEAP32[$10 + 4 >> 2] = $14;
		                      continue label$2;
		                     }
		                     $11 = $11 >>> 0 > 8 ? $11 : 8;
		                     $8 = $8 | 8;
		                     $1 = 120;
		                    }
		                    $14 = HEAP32[$7 + 64 >> 2];
		                    $10 = HEAP32[$7 + 68 >> 2];
		                    $13 = fmt_x($14, $10, $20, $1 & 32);
		                    if (!($8 & 8)) {
		                     break label$43;
		                    }
		                    $10 = HEAP32[$7 + 64 >> 2];
		                    $14 = HEAP32[$7 + 68 >> 2];
		                    if (!($10 | $14)) {
		                     break label$43;
		                    }
		                    $19 = ($1 >>> 4 | 0) + 1028 | 0;
		                    $16 = 2;
		                    break label$43;
		                   }
		                   $14 = HEAP32[$7 + 64 >> 2];
		                   $10 = HEAP32[$7 + 68 >> 2];
		                   $13 = fmt_o($14, $10, $20);
		                   if (!($8 & 8)) {
		                    break label$43;
		                   }
		                   $1 = $20 - $13 | 0;
		                   $11 = ($1 | 0) < ($11 | 0) ? $11 : $1 + 1 | 0;
		                   break label$43;
		                  }
		                  $14 = HEAP32[$7 + 68 >> 2];
		                  $1 = $14;
		                  $10 = HEAP32[$7 + 64 >> 2];
		                  $9 = $10;
		                  if (($14 | 0) < -1 ? 1 : ($14 | 0) <= -1) {
		                   $10 = $9;
		                   $9 = 0 - $10 | 0;
		                   $14 = $1;
		                   $10 = $14 + (($10 | 0) != 0) | 0;
		                   $10 = 0 - $10 | 0;
		                   $1 = $10;
		                   HEAP32[$7 + 64 >> 2] = $9;
		                   HEAP32[$7 + 68 >> 2] = $10;
		                   $16 = 1;
		                   $19 = 1028;
		                   break label$44;
		                  }
		                  if ($8 & 2048) {
		                   $16 = 1;
		                   $19 = 1029;
		                   break label$44;
		                  }
		                  $16 = $8 & 1;
		                  $19 = $16 ? 1030 : 1028;
		                 }
		                 $10 = $1;
		                 $13 = fmt_u($9, $10, $20);
		                }
		                $8 = ($11 | 0) > -1 ? $8 & -65537 : $8;
		                $10 = HEAP32[$7 + 64 >> 2];
		                $9 = $10;
		                $1 = HEAP32[$7 + 68 >> 2];
		                if (!(!!($10 | $1) | $11)) {
		                 $11 = 0;
		                 $13 = $20;
		                 break label$7;
		                }
		                $1 = !($9 | $1) + ($20 - $13 | 0) | 0;
		                $11 = ($1 | 0) < ($11 | 0) ? $11 : $1;
		                break label$7;
		               }
		               $1 = HEAP32[$7 + 64 >> 2];
		               $13 = $1 ? $1 : 1038;
		               $1 = memchr($13, 0, $11);
		               $18 = $1 ? $1 : $11 + $13 | 0;
		               $8 = $14;
		               $11 = $1 ? $1 - $13 | 0 : $11;
		               break label$7;
		              }
		              $9 = HEAP32[$7 + 64 >> 2];
		              if ($11) {
		               break label$39;
		              }
		              $1 = 0;
		              pad($0, 32, $15, 0, $8);
		              break label$38;
		             }
		             HEAP32[$7 + 12 >> 2] = 0;
		             HEAP32[$7 + 8 >> 2] = HEAP32[$7 + 64 >> 2];
		             HEAP32[$7 + 64 >> 2] = $7 + 8;
		             $11 = -1;
		             $9 = $7 + 8 | 0;
		            }
		            $1 = 0;
		            label$64 : {
		             while (1) {
		              $12 = HEAP32[$9 >> 2];
		              if (!$12) {
		               break label$64;
		              }
		              $12 = wctomb($7 + 4 | 0, $12);
		              $13 = ($12 | 0) < 0;
		              if (!($13 | $11 - $1 >>> 0 < $12 >>> 0)) {
		               $9 = $9 + 4 | 0;
		               $1 = $1 + $12 | 0;
		               if ($11 >>> 0 > $1 >>> 0) {
		                continue;
		               }
		               break label$64;
		              }
		              break;
		             }
		             $16 = -1;
		             if ($13) {
		              break label$1;
		             }
		            }
		            pad($0, 32, $15, $1, $8);
		            if (!$1) {
		             $1 = 0;
		             break label$38;
		            }
		            $9 = 0;
		            $12 = HEAP32[$7 + 64 >> 2];
		            while (1) {
		             $13 = HEAP32[$12 >> 2];
		             if (!$13) {
		              break label$38;
		             }
		             $13 = wctomb($7 + 4 | 0, $13);
		             $9 = $13 + $9 | 0;
		             if (($9 | 0) > ($1 | 0)) {
		              break label$38;
		             }
		             out($0, $7 + 4 | 0, $13);
		             $12 = $12 + 4 | 0;
		             if ($1 >>> 0 > $9 >>> 0) {
		              continue;
		             }
		             break;
		            }
		           }
		           pad($0, 32, $15, $1, $8 ^ 8192);
		           $1 = ($1 | 0) < ($15 | 0) ? $15 : $1;
		           continue label$2;
		          }
		          $1 = FUNCTION_TABLE[$5 | 0]($0, HEAPF64[$7 + 64 >> 3], $15, $11, $8, $1) | 0;
		          continue label$2;
		         }
		         $10 = HEAP32[$7 + 64 >> 2];
		         HEAP8[$7 + 55 | 0] = $10;
		         $11 = 1;
		         $13 = $22;
		         $8 = $14;
		         break label$7;
		        }
		        $9 = $1 + 1 | 0;
		        HEAP32[$7 + 76 >> 2] = $9;
		        $8 = HEAPU8[$1 + 1 | 0];
		        $1 = $9;
		        continue;
		       }
		      }
		      $16 = $17;
		      if ($0) {
		       break label$1;
		      }
		      if (!$21) {
		       break label$5;
		      }
		      $1 = 1;
		      while (1) {
		       $8 = HEAP32[($1 << 2) + $4 >> 2];
		       if ($8) {
		        pop_arg(($1 << 3) + $3 | 0, $8, $2, $6);
		        $16 = 1;
		        $1 = $1 + 1 | 0;
		        if (($1 | 0) != 10) {
		         continue;
		        }
		        break label$1;
		       }
		       break;
		      }
		      $16 = 1;
		      if ($1 >>> 0 >= 10) {
		       break label$1;
		      }
		      while (1) {
		       if (HEAP32[($1 << 2) + $4 >> 2]) {
		        break label$8;
		       }
		       $1 = $1 + 1 | 0;
		       if (($1 | 0) != 10) {
		        continue;
		       }
		       break;
		      }
		      break label$1;
		     }
		     $16 = -1;
		     break label$1;
		    }
		    $12 = $18 - $13 | 0;
		    $18 = ($11 | 0) < ($12 | 0) ? $12 : $11;
		    $9 = $18 + $16 | 0;
		    $1 = ($9 | 0) > ($15 | 0) ? $9 : $15;
		    pad($0, 32, $1, $9, $8);
		    out($0, $19, $16);
		    pad($0, 48, $1, $9, $8 ^ 65536);
		    pad($0, 48, $18, $12, 0);
		    out($0, $13, $12);
		    pad($0, 32, $1, $9, $8 ^ 8192);
		    continue;
		   }
		   break;
		  }
		  $16 = 0;
		 }
		 __stack_pointer = $7 + 80 | 0;
		 return $16;
		}
		function silk_decode_core($0, $1, $2, $3, $4) {
		 var $5 = 0, $6 = 0, $7 = 0, $8 = 0, $9 = 0, $10 = 0, $11 = 0, $12 = 0, $13 = 0, $14 = 0, $15 = 0, $16 = 0, $17 = 0, $18 = 0, $19 = 0, $20 = 0, $21 = 0, $22 = 0, $23 = 0, $24 = 0, $25 = 0, $26 = 0, $27 = 0, $28 = 0, $29 = 0;
		 $12 = __stack_pointer - 32 | 0;
		 $27 = $12;
		 __stack_pointer = $12;
		 $23 = $12 - ((HEAP32[$0 + 2336 >> 2] << 1) + 15 & -16) | 0;
		 $12 = $23;
		 __stack_pointer = $12;
		 $7 = HEAP32[$0 + 2328 >> 2];
		 $21 = $12 - (($7 + HEAP32[$0 + 2336 >> 2] << 2) + 15 & -16) | 0;
		 $12 = $21;
		 __stack_pointer = $12;
		 $9 = HEAP32[$0 + 2332 >> 2] << 2;
		 $24 = $12 - ($9 + 15 & -16) | 0;
		 $12 = $24;
		 __stack_pointer = $12;
		 $15 = $12 - ($9 + 79 & -16) | 0;
		 __stack_pointer = $15;
		 $13 = HEAP8[$0 + 2767 | 0];
		 if (($7 | 0) >= 1) {
		  $16 = HEAP16[((HEAP8[$0 + 2765 | 0] << 1 & -4) + (HEAP8[$0 + 2766 | 0] << 1) | 0) + 6720 >> 1] << 4;
		  $8 = HEAP8[$0 + 2770 | 0];
		  $7 = 0;
		  while (1) {
		   $5 = ($7 << 2) + $0 | 0;
		   $20 = $5 + 4 | 0;
		   $9 = HEAP16[($7 << 1) + $3 >> 1];
		   $12 = $9 << 14;
		   HEAP32[$20 >> 2] = $12;
		   $8 = Math_imul($8, 196314165) + 907633515 | 0;
		   $6 = $5;
		   label$3 : {
		    if (($9 | 0) >= 1) {
		     $12 = $12 - 1280 | 0;
		    } else {
		     if (($9 | 0) > -1) {
		      break label$3;
		     }
		     $12 = $12 | 1280;
		    }
		    HEAP32[$6 + 4 >> 2] = $12;
		   }
		   $12 = $12 + $16 | 0;
		   HEAP32[$5 + 4 >> 2] = ($8 | 0) < 0 ? 0 - $12 | 0 : $12;
		   $8 = $8 + $9 | 0;
		   $7 = $7 + 1 | 0;
		   if (($7 | 0) < HEAP32[$0 + 2328 >> 2]) {
		    continue;
		   }
		   break;
		  }
		 }
		 $5 = HEAP32[$0 + 1288 >> 2];
		 $6 = $0;
		 $10 = HEAP32[$6 + 1284 >> 2];
		 $3 = $10;
		 $10 = $15;
		 HEAP32[$10 >> 2] = $3;
		 HEAP32[$10 + 4 >> 2] = $5;
		 $6 = $6 + 1340 | 0;
		 $5 = HEAP32[$6 >> 2];
		 $10 = HEAP32[$6 + 4 >> 2];
		 $3 = $5;
		 $5 = $15;
		 HEAP32[$5 + 56 >> 2] = $3;
		 HEAP32[$5 + 60 >> 2] = $10;
		 $6 = $0 + 1332 | 0;
		 $10 = HEAP32[$6 >> 2];
		 $5 = HEAP32[$6 + 4 >> 2];
		 $3 = $10;
		 $10 = $15;
		 HEAP32[$10 + 48 >> 2] = $3;
		 HEAP32[$10 + 52 >> 2] = $5;
		 $6 = $0 + 1324 | 0;
		 $5 = HEAP32[$6 >> 2];
		 $10 = HEAP32[$6 + 4 >> 2];
		 $3 = $5;
		 $5 = $15;
		 HEAP32[$5 + 40 >> 2] = $3;
		 HEAP32[$5 + 44 >> 2] = $10;
		 $6 = $0 + 1316 | 0;
		 $10 = HEAP32[$6 >> 2];
		 $5 = HEAP32[$6 + 4 >> 2];
		 $3 = $10;
		 $10 = $15;
		 HEAP32[$10 + 32 >> 2] = $3;
		 HEAP32[$10 + 36 >> 2] = $5;
		 $6 = $0 + 1308 | 0;
		 $5 = HEAP32[$6 >> 2];
		 $10 = HEAP32[$6 + 4 >> 2];
		 $3 = $5;
		 $5 = $15;
		 HEAP32[$5 + 24 >> 2] = $3;
		 HEAP32[$5 + 28 >> 2] = $10;
		 $6 = $0 + 1300 | 0;
		 $10 = HEAP32[$6 >> 2];
		 $5 = HEAP32[$6 + 4 >> 2];
		 $3 = $10;
		 $10 = $15;
		 HEAP32[$10 + 16 >> 2] = $3;
		 HEAP32[$10 + 20 >> 2] = $5;
		 $6 = $0 + 1292 | 0;
		 $5 = HEAP32[$6 >> 2];
		 $10 = HEAP32[$6 + 4 >> 2];
		 $3 = $5;
		 $5 = $15;
		 HEAP32[$5 + 8 >> 2] = $3;
		 HEAP32[$5 + 12 >> 2] = $10;
		 label$6 : {
		  if (HEAP32[$0 + 2324 >> 2] >= 1) {
		   $22 = $0 + 4 | 0;
		   $20 = HEAP32[$0 + 2336 >> 2];
		   $29 = ($13 | 0) < 4;
		   $25 = $2;
		   while (1) {
		    $28 = (($18 << 4 & -32) + $1 | 0) + 32 | 0;
		    $12 = memcpy($27, $28, HEAP32[$0 + 2340 >> 2] << 1);
		    $26 = ($18 << 2) + $1 | 0;
		    $19 = HEAP32[$26 + 16 >> 2];
		    $7 = $19 >> 31;
		    $3 = $7 ^ $7 + $19;
		    $8 = Math_clz32($3);
		    $16 = $19 << $8 - 1;
		    $9 = $16 >> 16;
		    $7 = 536870911 / ($9 | 0) | 0;
		    $5 = ($7 >> 15) + 1 >> 1;
		    $13 = $7 << 16;
		    $7 = $13 >> 16;
		    $9 = 0 - ((Math_imul($7, $16 & 65535) >> 16) + Math_imul($7, $9) << 3) | 0;
		    $9 = ((Math_imul($9, $5) + $13 | 0) + Math_imul($9 >> 16, $7) | 0) + (Math_imul($9 & 65528, $7) >> 16) | 0;
		    $13 = 15 - $8 | 0;
		    $17 = Math_imul($18, 10);
		    $11 = HEAPU8[$0 + 2765 | 0];
		    label$9 : {
		     if ($3 >>> 0 <= 131071) {
		      $3 = 0 - $13 | 0;
		      $13 = 2147483647 >>> $3 | 0;
		      $6 = -2147483648 >> $3;
		      $14 = (($9 | 0) > ($13 | 0) ? $13 : ($9 | 0) < ($6 | 0) ? $6 : $9) << $3;
		      break label$9;
		     }
		     $14 = $9 >> $13;
		    }
		    $17 = $1 + $17 | 0;
		    $3 = 65536;
		    $9 = HEAP32[$0 >> 2];
		    if (($19 | 0) != ($9 | 0)) {
		     $3 = $9 >> 31;
		     $3 = Math_clz32($3 ^ $3 + $9);
		     $9 = $9 << $3 - 1;
		     $13 = $9;
		     $9 = Math_imul($9 >> 16, $7) + (Math_imul($9 & 65535, $7) >> 16) | 0;
		     $10 = $9 >> 31;
		     $6 = $10;
		     $5 = $16;
		     $10 = $5 >> 31;
		     $5 = $10;
		     $10 = $6;
		     $5 = __wasm_i64_mul($9, $10, $16, $5);
		     $6 = $5;
		     $10 = i64toi32_i32$HIGH_BITS;
		     $16 = $13 - ((($10 & 536870911) << 3 | $6 >>> 29) & -8) | 0;
		     $7 = (Math_imul($16 >> 16, $7) + $9 | 0) + (Math_imul($16 & 65535, $7) >> 16) | 0;
		     $9 = $3 - $8 | 0;
		     $8 = $9 + 13 | 0;
		     $9 = $9 + 29 | 0;
		     label$12 : {
		      if (($9 | 0) <= 15) {
		       $9 = 0 - $8 | 0;
		       $8 = 2147483647 >>> $9 | 0;
		       $3 = -2147483648 >> $9;
		       $3 = (($7 | 0) > ($8 | 0) ? $8 : ($3 | 0) > ($7 | 0) ? $3 : $7) << $9;
		       break label$12;
		      }
		      $3 = ($9 | 0) < 48 ? $7 >> $8 : 0;
		     }
		     $16 = $3 & 65535;
		     $13 = $3 >> 16;
		     $7 = 0;
		     while (1) {
		      $9 = ($7 << 2) + $15 | 0;
		      $5 = $9;
		      $9 = HEAP32[$9 >> 2];
		      $8 = $9 << 16 >> 16;
		      HEAP32[$5 >> 2] = ((Math_imul($16, $8) >> 16) + Math_imul($8, $13) | 0) + Math_imul(($9 >> 15) + 1 >> 1, $3);
		      $7 = $7 + 1 | 0;
		      if (($7 | 0) != 16) {
		       continue;
		      }
		      break;
		     }
		    }
		    HEAP32[$0 >> 2] = $19;
		    label$15 : {
		     label$16 : {
		      label$17 : {
		       if (!(!HEAP32[$0 + 4160 >> 2] | HEAP32[$0 + 4164 >> 2] != 2 | (($11 & 255) == 2 | $18 >>> 0 > 1))) {
		        $6 = $17;
		        HEAP16[$6 + 96 >> 1] = 0;
		        HEAP16[$6 + 98 >> 1] = 0;
		        HEAP16[$6 + 100 >> 1] = 0;
		        HEAP16[$6 + 102 >> 1] = 0;
		        HEAP16[$6 + 104 >> 1] = 0;
		        HEAP16[$6 + 100 >> 1] = 4096;
		        $6 = HEAP32[$0 + 2308 >> 2];
		        HEAP32[$26 >> 2] = $6;
		        break label$17;
		       }
		       if (($11 & 255) != 2) {
		        $8 = HEAP32[$0 + 2332 >> 2];
		        $3 = $22;
		        break label$16;
		       }
		       $6 = HEAP32[$26 >> 2];
		      }
		      label$20 : {
		       if (!(($18 | 0) == 2 & $29 ? 0 : $18)) {
		        $9 = HEAP32[$0 + 2336 >> 2];
		        $8 = HEAP32[$0 + 2340 >> 2];
		        $7 = ($9 - $6 | 0) - $8 | 0;
		        if (($7 | 0) <= 2) {
		         break label$6;
		        }
		        $7 = $7 - 2 | 0;
		        if (($18 | 0) == 2) {
		         memcpy((($9 << 1) + $0 | 0) + 1348 | 0, $2, HEAP32[$0 + 2332 >> 2] << 2);
		         $9 = HEAP32[$0 + 2336 >> 2];
		         $8 = HEAP32[$0 + 2340 >> 2];
		        }
		        silk_LPC_analysis_filter(($7 << 1) + $23 | 0, ((Math_imul(HEAP32[$0 + 2332 >> 2], $18) + $7 << 1) + $0 | 0) + 1348 | 0, $28, $9 - $7 | 0, $8, $4);
		        if (!$18) {
		         $7 = HEAP16[$1 + 136 >> 1];
		         $14 = (Math_imul($7, $14 & 65535) >> 16) + Math_imul($14 >> 16, $7) << 2;
		        }
		        if (($6 | 0) < -1) {
		         break label$20;
		        }
		        $8 = $6 + 1 | 0;
		        $3 = $14 & 65535;
		        $16 = $14 >> 16;
		        $13 = HEAP32[$0 + 2336 >> 2];
		        $7 = 0;
		        while (1) {
		         $9 = $7 ^ -1;
		         $5 = ($20 + $9 << 2) + $21 | 0;
		         $9 = HEAP16[($9 + $13 << 1) + $23 >> 1];
		         HEAP32[$5 >> 2] = (Math_imul($9, $3) >> 16) + Math_imul($9, $16);
		         $9 = ($7 | 0) == ($8 | 0);
		         $7 = $7 + 1 | 0;
		         if (!$9) {
		          continue;
		         }
		         break;
		        }
		        break label$20;
		       }
		       if (($3 | 0) == 65536 | ($6 | 0) < -1) {
		        break label$20;
		       }
		       $16 = $6 + 1 | 0;
		       $13 = $3 & 65535;
		       $11 = $3 >> 16;
		       $7 = 0;
		       while (1) {
		        $9 = (($7 ^ -1) + $20 << 2) + $21 | 0;
		        $5 = $9;
		        $9 = HEAP32[$9 >> 2];
		        $8 = $9 << 16 >> 16;
		        HEAP32[$5 >> 2] = ((Math_imul($13, $8) >> 16) + Math_imul($8, $11) | 0) + Math_imul(($9 >> 15) + 1 >> 1, $3);
		        $9 = ($7 | 0) != ($16 | 0);
		        $7 = $7 + 1 | 0;
		        if ($9) {
		         continue;
		        }
		        break;
		       }
		      }
		      $8 = HEAP32[$0 + 2332 >> 2];
		      if (($8 | 0) < 1) {
		       break label$15;
		      }
		      $7 = (($20 - $6 << 2) + $21 | 0) + 8 | 0;
		      $3 = HEAP16[$17 + 104 >> 1];
		      $16 = HEAP16[$17 + 102 >> 1];
		      $13 = HEAP16[$17 + 100 >> 1];
		      $11 = HEAP16[$17 + 98 >> 1];
		      $17 = HEAP16[$17 + 96 >> 1];
		      $9 = 0;
		      while (1) {
		       $6 = $9 << 2;
		       $5 = $24 + $6 | 0;
		       $14 = HEAP32[$7 >> 2];
		       $10 = Math_imul($14 >> 16, $17) + (Math_imul($14 & 65535, $17) >> 16) | 0;
		       $14 = HEAP32[$7 - 4 >> 2];
		       $10 = ($10 + Math_imul($14 >> 16, $11) | 0) + (Math_imul($14 & 65535, $11) >> 16) | 0;
		       $14 = HEAP32[$7 - 8 >> 2];
		       $10 = ($10 + Math_imul($14 >> 16, $13) | 0) + (Math_imul($14 & 65535, $13) >> 16) | 0;
		       $14 = HEAP32[$7 - 12 >> 2];
		       $10 = ($10 + Math_imul($14 >> 16, $16) | 0) + (Math_imul($14 & 65535, $16) >> 16) | 0;
		       $14 = HEAP32[$7 - 16 >> 2];
		       $6 = (HEAP32[$6 + $22 >> 2] + (($10 + Math_imul($14 >> 16, $3) | 0) + (Math_imul($14 & 65535, $3) >> 16) << 1) | 0) + 4 | 0;
		       HEAP32[$5 >> 2] = $6;
		       HEAP32[($20 << 2) + $21 >> 2] = $6 << 1;
		       $20 = $20 + 1 | 0;
		       $7 = $7 + 4 | 0;
		       $9 = $9 + 1 | 0;
		       if (($9 | 0) != ($8 | 0)) {
		        continue;
		       }
		       break;
		      }
		      $3 = $24;
		     }
		     $17 = $3;
		     if (($8 | 0) < 1) {
		      break label$15;
		     }
		     $3 = $19 >>> 6 << 16 >> 16;
		     $16 = HEAP32[$0 + 2340 >> 2];
		     $6 = $16 >>> 1 | 0;
		     $14 = ($19 >> 21) + 1 >> 1;
		     $9 = 0;
		     while (1) {
		      label$28 : {
		       switch ($16 - 10 | 0) {
		       default:
		        celt_fatal(9010, 8991, 199);
		        abort();
		       case 0:
		       case 6:
		        break label$28;
		       }
		      }
		      $11 = HEAP16[$12 >> 1];
		      $13 = $9 << 2;
		      $7 = $13 + $15 | 0;
		      $8 = HEAP32[$7 + 60 >> 2];
		      $5 = (Math_imul($11, $8 >> 16) + $6 | 0) + (Math_imul($8 & 65535, $11) >> 16) | 0;
		      $11 = HEAP16[$12 + 2 >> 1];
		      $8 = HEAP32[$7 + 56 >> 2];
		      $5 = ($5 + Math_imul($11, $8 >> 16) | 0) + (Math_imul($8 & 65535, $11) >> 16) | 0;
		      $11 = HEAP16[$12 + 4 >> 1];
		      $8 = HEAP32[$7 + 52 >> 2];
		      $5 = ($5 + Math_imul($11, $8 >> 16) | 0) + (Math_imul($8 & 65535, $11) >> 16) | 0;
		      $11 = HEAP16[$12 + 6 >> 1];
		      $8 = HEAP32[$7 + 48 >> 2];
		      $5 = ($5 + Math_imul($11, $8 >> 16) | 0) + (Math_imul($8 & 65535, $11) >> 16) | 0;
		      $11 = HEAP16[$12 + 8 >> 1];
		      $8 = HEAP32[$7 + 44 >> 2];
		      $5 = ($5 + Math_imul($11, $8 >> 16) | 0) + (Math_imul($8 & 65535, $11) >> 16) | 0;
		      $11 = HEAP16[$12 + 10 >> 1];
		      $8 = HEAP32[$7 + 40 >> 2];
		      $5 = ($5 + Math_imul($11, $8 >> 16) | 0) + (Math_imul($8 & 65535, $11) >> 16) | 0;
		      $11 = HEAP16[$12 + 12 >> 1];
		      $8 = HEAP32[$7 + 36 >> 2];
		      $5 = ($5 + Math_imul($11, $8 >> 16) | 0) + (Math_imul($8 & 65535, $11) >> 16) | 0;
		      $11 = HEAP16[$12 + 14 >> 1];
		      $8 = HEAP32[$7 + 32 >> 2];
		      $5 = ($5 + Math_imul($11, $8 >> 16) | 0) + (Math_imul($8 & 65535, $11) >> 16) | 0;
		      $11 = HEAP16[$12 + 16 >> 1];
		      $8 = HEAP32[$7 + 28 >> 2];
		      $5 = ($5 + Math_imul($11, $8 >> 16) | 0) + (Math_imul($8 & 65535, $11) >> 16) | 0;
		      $11 = HEAP16[$12 + 18 >> 1];
		      $8 = HEAP32[$7 + 24 >> 2];
		      $8 = ($5 + Math_imul($11, $8 >> 16) | 0) + (Math_imul($8 & 65535, $11) >> 16) | 0;
		      if (($16 | 0) == 16) {
		       $19 = HEAP16[$12 + 20 >> 1];
		       $11 = HEAP32[$7 + 20 >> 2];
		       $5 = (Math_imul($19, $11 >> 16) + $8 | 0) + (Math_imul($11 & 65535, $19) >> 16) | 0;
		       $11 = HEAP16[$12 + 22 >> 1];
		       $8 = HEAP32[$7 + 16 >> 2];
		       $5 = ($5 + Math_imul($11, $8 >> 16) | 0) + (Math_imul($8 & 65535, $11) >> 16) | 0;
		       $11 = HEAP16[$12 + 24 >> 1];
		       $8 = HEAP32[$7 + 12 >> 2];
		       $5 = ($5 + Math_imul($11, $8 >> 16) | 0) + (Math_imul($8 & 65535, $11) >> 16) | 0;
		       $11 = HEAP16[$12 + 26 >> 1];
		       $8 = HEAP32[$7 + 8 >> 2];
		       $5 = ($5 + Math_imul($11, $8 >> 16) | 0) + (Math_imul($8 & 65535, $11) >> 16) | 0;
		       $11 = HEAP16[$12 + 28 >> 1];
		       $8 = HEAP32[$7 + 4 >> 2];
		       $5 = ($5 + Math_imul($11, $8 >> 16) | 0) + (Math_imul($8 & 65535, $11) >> 16) | 0;
		       $8 = HEAP16[$12 + 30 >> 1];
		       $7 = HEAP32[$7 >> 2];
		       $8 = ($5 + Math_imul($8, $7 >> 16) | 0) + (Math_imul($7 & 65535, $8) >> 16) | 0;
		      }
		      $11 = $9 + 16 | 0;
		      $5 = ($11 << 2) + $15 | 0;
		      $7 = ($8 | 0) > -134217728 ? $8 : -134217728;
		      $7 = (($7 | 0) < 134217727 ? $7 : 134217727) << 4;
		      $8 = HEAP32[$13 + $17 >> 2];
		      $13 = $7 + $8 | 0;
		      label$31 : {
		       if (($13 | 0) >= 0) {
		        $7 = ($7 & $8) > -1 ? $13 : -2147483648;
		        break label$31;
		       }
		       $7 = ($7 | $8) > -1 ? 2147483647 : $13;
		      }
		      HEAP32[$5 >> 2] = $7;
		      $7 = (Math_imul($7 >> 16, $3) + Math_imul($7, $14) | 0) + (Math_imul($7 & 65535, $3) >> 16) | 0;
		      HEAP16[($9 << 1) + $25 >> 1] = ($7 | 0) > 8388479 ? 32767 : ($7 | 0) < -8388736 ? -32768 : ($7 >>> 7 | 0) + 1 >>> 1 | 0;
		      $8 = HEAP32[$0 + 2332 >> 2];
		      $9 = $9 + 1 | 0;
		      if (($8 | 0) > ($9 | 0)) {
		       continue;
		      }
		      break;
		     }
		    }
		    $7 = $8 << 2;
		    $12 = $15 + $7 | 0;
		    $10 = $12;
		    $5 = HEAP32[$10 >> 2];
		    $6 = HEAP32[$10 + 4 >> 2];
		    $3 = $5;
		    $5 = $15;
		    HEAP32[$5 >> 2] = $3;
		    HEAP32[$5 + 4 >> 2] = $6;
		    $5 = HEAP32[$10 + 60 >> 2];
		    $6 = HEAP32[$10 + 56 >> 2];
		    $3 = $6;
		    $6 = $15;
		    HEAP32[$6 + 56 >> 2] = $3;
		    HEAP32[$6 + 60 >> 2] = $5;
		    $6 = HEAP32[$10 + 52 >> 2];
		    $5 = HEAP32[$10 + 48 >> 2];
		    $3 = $5;
		    $5 = $15;
		    HEAP32[$5 + 48 >> 2] = $3;
		    HEAP32[$5 + 52 >> 2] = $6;
		    $5 = HEAP32[$10 + 44 >> 2];
		    $6 = HEAP32[$10 + 40 >> 2];
		    $3 = $6;
		    $6 = $15;
		    HEAP32[$6 + 40 >> 2] = $3;
		    HEAP32[$6 + 44 >> 2] = $5;
		    $6 = HEAP32[$10 + 36 >> 2];
		    $5 = HEAP32[$10 + 32 >> 2];
		    $3 = $5;
		    $5 = $15;
		    HEAP32[$5 + 32 >> 2] = $3;
		    HEAP32[$5 + 36 >> 2] = $6;
		    $5 = HEAP32[$10 + 28 >> 2];
		    $6 = HEAP32[$10 + 24 >> 2];
		    $3 = $6;
		    $6 = $15;
		    HEAP32[$6 + 24 >> 2] = $3;
		    HEAP32[$6 + 28 >> 2] = $5;
		    $6 = HEAP32[$10 + 20 >> 2];
		    $5 = HEAP32[$10 + 16 >> 2];
		    $3 = $5;
		    $5 = $15;
		    HEAP32[$5 + 16 >> 2] = $3;
		    HEAP32[$5 + 20 >> 2] = $6;
		    $5 = HEAP32[$10 + 12 >> 2];
		    $6 = HEAP32[$10 + 8 >> 2];
		    $3 = $6;
		    $6 = $15;
		    HEAP32[$6 + 8 >> 2] = $3;
		    HEAP32[$6 + 12 >> 2] = $5;
		    $25 = ($8 << 1) + $25 | 0;
		    $22 = $7 + $22 | 0;
		    $18 = $18 + 1 | 0;
		    if (($18 | 0) < HEAP32[$0 + 2324 >> 2]) {
		     continue;
		    }
		    break;
		   }
		  }
		  $10 = $15;
		  $5 = HEAP32[$10 >> 2];
		  $6 = HEAP32[$10 + 4 >> 2];
		  $1 = $5;
		  $12 = $0 + 1284 | 0;
		  $5 = $12;
		  HEAP32[$5 >> 2] = $1;
		  HEAP32[$5 + 4 >> 2] = $6;
		  $5 = HEAP32[$10 + 60 >> 2];
		  $6 = HEAP32[$10 + 56 >> 2];
		  $0 = $6;
		  $6 = $12;
		  HEAP32[$6 + 56 >> 2] = $0;
		  HEAP32[$6 + 60 >> 2] = $5;
		  $6 = HEAP32[$10 + 52 >> 2];
		  $5 = HEAP32[$10 + 48 >> 2];
		  $0 = $5;
		  $5 = $12;
		  HEAP32[$5 + 48 >> 2] = $0;
		  HEAP32[$5 + 52 >> 2] = $6;
		  $5 = HEAP32[$10 + 44 >> 2];
		  $6 = HEAP32[$10 + 40 >> 2];
		  $0 = $6;
		  $6 = $12;
		  HEAP32[$6 + 40 >> 2] = $0;
		  HEAP32[$6 + 44 >> 2] = $5;
		  $6 = HEAP32[$10 + 36 >> 2];
		  $5 = HEAP32[$10 + 32 >> 2];
		  $0 = $5;
		  $5 = $12;
		  HEAP32[$5 + 32 >> 2] = $0;
		  HEAP32[$5 + 36 >> 2] = $6;
		  $5 = HEAP32[$10 + 28 >> 2];
		  $6 = HEAP32[$10 + 24 >> 2];
		  $0 = $6;
		  $6 = $12;
		  HEAP32[$6 + 24 >> 2] = $0;
		  HEAP32[$6 + 28 >> 2] = $5;
		  $6 = HEAP32[$10 + 20 >> 2];
		  $5 = HEAP32[$10 + 16 >> 2];
		  $0 = $5;
		  $5 = $12;
		  HEAP32[$5 + 16 >> 2] = $0;
		  HEAP32[$5 + 20 >> 2] = $6;
		  $5 = HEAP32[$10 + 12 >> 2];
		  $6 = HEAP32[$10 + 8 >> 2];
		  $0 = $6;
		  $6 = $12;
		  HEAP32[$6 + 8 >> 2] = $0;
		  HEAP32[$6 + 12 >> 2] = $5;
		  __stack_pointer = $27 + 32 | 0;
		  return;
		 }
		 celt_fatal(8959, 8991, 144);
		 abort();
		}
		function silk_Decode($0, $1, $2, $3, $4, $5, $6, $7) {
		 var $8 = 0, $9 = 0, $10 = 0, $11 = 0, $12 = 0, $13 = 0, $14 = 0, $15 = 0, $16 = 0, $17 = 0, $18 = 0, $19 = 0, $20 = 0, $21 = 0, $22 = 0;
		 $14 = __stack_pointer - 656 | 0;
		 __stack_pointer = $14;
		 $10 = $14;
		 HEAP32[$10 + 652 >> 2] = 0;
		 HEAP32[$10 + 640 >> 2] = 0;
		 HEAP32[$10 + 644 >> 2] = 0;
		 label$1 : {
		  label$2 : {
		   label$3 : {
		    label$4 : {
		     label$5 : {
		      $8 = HEAP32[$1 + 4 >> 2];
		      if ($8 - 1 >>> 0 < 2) {
		       if ($3) {
		        while (1) {
		         HEAP32[(Math_imul($9, 4264) + $0 | 0) + 2388 >> 2] = 0;
		         $9 = $9 + 1 | 0;
		         if (($9 | 0) != ($8 | 0)) {
		          continue;
		         }
		         break;
		        }
		       }
		       if (HEAP32[$0 + 8544 >> 2] < ($8 | 0)) {
		        $15 = silk_init_decoder($0 + 4264 | 0);
		        $8 = HEAP32[$1 + 4 >> 2];
		       }
		       if (!(($8 | 0) != 1 | HEAP32[$0 + 8544 >> 2] != 2)) {
		        $21 = HEAP32[$1 + 12 >> 2] == (Math_imul(HEAP32[$0 + 2316 >> 2], 1e3) | 0);
		       }
		       label$11 : {
		        if (!(HEAP32[$0 + 2388 >> 2] | ($8 | 0) < 1)) {
		         $9 = 0;
		         while (1) {
		          $3 = 2;
		          $11 = 1;
		          label$14 : {
		           label$15 : {
		            label$16 : {
		             label$17 : {
		              label$18 : {
		               $8 = HEAP32[$1 + 16 >> 2];
		               switch ($8 | 0) {
		               case 0:
		               case 10:
		                break label$14;
		               case 20:
		                break label$16;
		               case 1:
		               case 2:
		               case 3:
		               case 4:
		               case 5:
		               case 6:
		               case 7:
		               case 8:
		               case 9:
		               case 11:
		               case 12:
		               case 13:
		               case 14:
		               case 15:
		               case 16:
		               case 17:
		               case 18:
		               case 19:
		                break label$17;
		               default:
		                break label$18;
		               }
		              }
		              if (($8 | 0) == 40) {
		               break label$15;
		              }
		              if (($8 | 0) != 60) {
		               break label$17;
		              }
		              $3 = 4;
		              $11 = 3;
		              break label$14;
		             }
		             celt_fatal(9390, 9375, 146);
		             abort();
		            }
		            $3 = 4;
		            break label$14;
		           }
		           $3 = 4;
		           $11 = 2;
		          }
		          $8 = Math_imul($9, 4264) + $0 | 0;
		          HEAP32[$8 + 2324 >> 2] = $3;
		          HEAP32[$8 + 2392 >> 2] = $11;
		          $3 = HEAP32[$1 + 12 >> 2] >> 10;
		          if ($3 >>> 0 > 15 | !(1 << $3 & 34944)) {
		           break label$11;
		          }
		          $15 = silk_decoder_set_fs($8, $3 + 1 | 0, HEAP32[$1 + 8 >> 2]) + $15 | 0;
		          $8 = HEAP32[$1 + 4 >> 2];
		          $9 = $9 + 1 | 0;
		          if (($8 | 0) > ($9 | 0)) {
		           continue;
		          }
		          break;
		         }
		        }
		        $9 = 2;
		        $3 = HEAP32[$1 >> 2];
		        label$19 : {
		         if (($3 | 0) != 2) {
		          $9 = $3;
		          break label$19;
		         }
		         if (($8 | 0) != 2) {
		          break label$19;
		         }
		         if (HEAP32[$0 + 8540 >> 2] != 1) {
		          $8 = 2;
		          if (HEAP32[$0 + 8544 >> 2] != 1) {
		           break label$19;
		          }
		         }
		         HEAP32[$0 + 8536 >> 2] = 0;
		         HEAP32[$0 + 8528 >> 2] = 0;
		         memcpy($0 + 6696 | 0, $0 + 2432 | 0, 300);
		         $8 = HEAP32[$1 + 4 >> 2];
		         $9 = HEAP32[$1 >> 2];
		        }
		        HEAP32[$0 + 8544 >> 2] = $8;
		        HEAP32[$0 + 8540 >> 2] = $9;
		        $3 = -200;
		        if (HEAP32[$1 + 8 >> 2] - 8e3 >>> 0 > 4e4) {
		         break label$1;
		        }
		        label$22 : {
		         if (HEAP32[$0 + 2388 >> 2] | ($2 | 0) == 1) {
		          break label$22;
		         }
		         label$23 : {
		          if (($8 | 0) < 1) {
		           break label$23;
		          }
		          while (1) {
		           $11 = Math_imul($13, 4264) + $0 | 0;
		           $3 = HEAP32[$11 + 2392 >> 2];
		           $8 = 0;
		           $9 = ec_dec_bit_logp($4, 1);
		           if (($3 | 0) > 0) {
		            $12 = $11 + 2392 | 0;
		            while (1) {
		             HEAP32[(($8 << 2) + $11 | 0) + 2404 >> 2] = $9;
		             $3 = HEAP32[$12 >> 2];
		             $9 = ec_dec_bit_logp($4, 1);
		             $8 = $8 + 1 | 0;
		             if (($8 | 0) < ($3 | 0)) {
		              continue;
		             }
		             break;
		            }
		           }
		           HEAP32[$11 + 2416 >> 2] = $9;
		           $8 = HEAP32[$1 + 4 >> 2];
		           $13 = $13 + 1 | 0;
		           if (($8 | 0) > ($13 | 0)) {
		            continue;
		           }
		           break;
		          }
		          $12 = 0;
		          if (($8 | 0) <= 0) {
		           break label$23;
		          }
		          while (1) {
		           $9 = Math_imul($12, 4264) + $0 | 0;
		           HEAP32[$9 + 2420 >> 2] = 0;
		           HEAP32[$9 + 2424 >> 2] = 0;
		           HEAP32[$9 + 2428 >> 2] = 0;
		           label$28 : {
		            if (!HEAP32[$9 + 2416 >> 2]) {
		             break label$28;
		            }
		            $8 = HEAP32[$9 + 2392 >> 2];
		            if (($8 | 0) == 1) {
		             HEAP32[$9 + 2420 >> 2] = 1;
		             break label$28;
		            }
		            $8 = ec_dec_icdf($4, HEAP32[($8 << 2) + 6688 >> 2], 8);
		            $3 = HEAP32[$9 + 2392 >> 2];
		            if (($3 | 0) < 1) {
		             break label$28;
		            }
		            $11 = $8 + 1 | 0;
		            $8 = 0;
		            while (1) {
		             HEAP32[(($8 << 2) + $9 | 0) + 2420 >> 2] = $11 >>> $8 & 1;
		             $8 = $8 + 1 | 0;
		             if (($8 | 0) != ($3 | 0)) {
		              continue;
		             }
		             break;
		            }
		           }
		           $8 = HEAP32[$1 + 4 >> 2];
		           $12 = $12 + 1 | 0;
		           if (($8 | 0) > ($12 | 0)) {
		            continue;
		           }
		           break;
		          }
		         }
		         if (HEAP32[$0 + 2392 >> 2] < 1 | $2) {
		          break label$22;
		         }
		         $17 = $0 + 6684 | 0;
		         $11 = 0;
		         while (1) {
		          if (($8 | 0) >= 1) {
		           $13 = $11 - 1 | 0;
		           $12 = $11 << 2;
		           $16 = $17 + $12 | 0;
		           $3 = 0;
		           while (1) {
		            $9 = Math_imul($3, 4264) + $0 | 0;
		            if (HEAP32[($12 + $9 | 0) + 2420 >> 2]) {
		             label$35 : {
		              if (($8 | 0) != 2 | $3) {
		               break label$35;
		              }
		              silk_stereo_decode_pred($4, $10 + 640 | 0);
		              if (HEAP32[$16 >> 2]) {
		               break label$35;
		              }
		              silk_stereo_decode_mid_only($4, $10 + 652 | 0);
		             }
		             $18 = $9;
		             $19 = $4;
		             $20 = $11;
		             label$36 : {
		              if ($11) {
		               $8 = 2;
		               if (HEAP32[(($13 << 2) + $9 | 0) + 2420 >> 2]) {
		                break label$36;
		               }
		              }
		              $8 = 0;
		             }
		             silk_decode_indices($18, $19, $20, 1, $8);
		             silk_decode_pulses($4, $10, HEAP8[$9 + 2765 | 0], HEAP8[$9 + 2766 | 0], HEAP32[$9 + 2328 >> 2]);
		             $8 = HEAP32[$1 + 4 >> 2];
		            }
		            $3 = $3 + 1 | 0;
		            if (($8 | 0) > ($3 | 0)) {
		             continue;
		            }
		            break;
		           }
		          }
		          $11 = $11 + 1 | 0;
		          if (($11 | 0) < HEAP32[$0 + 2392 >> 2]) {
		           continue;
		          }
		          break;
		         }
		        }
		        if (($8 | 0) != 2) {
		         break label$2;
		        }
		        label$38 : {
		         switch ($2 | 0) {
		         case 0:
		          silk_stereo_decode_pred($4, $10 + 640 | 0);
		          if (!HEAP32[((HEAP32[$0 + 2388 >> 2] << 2) + $0 | 0) + 6668 >> 2]) {
		           break label$4;
		          }
		          break label$3;
		         case 2:
		          if (HEAP32[((HEAP32[$0 + 2388 >> 2] << 2) + $0 | 0) + 2420 >> 2] == 1) {
		           break label$5;
		          }
		          break;
		         default:
		          break label$38;
		         }
		        }
		        HEAP32[$10 + 640 >> 2] = HEAP16[$0 + 8528 >> 1];
		        HEAP32[$10 + 644 >> 2] = HEAP16[$0 + 8530 >> 1];
		        break label$2;
		       }
		       celt_fatal(9390, 9375, 152);
		       abort();
		      }
		      celt_fatal(9284, 9375, 107);
		      abort();
		     }
		     silk_stereo_decode_pred($4, $10 + 640 | 0);
		     if (HEAP32[((HEAP32[$0 + 2388 >> 2] << 2) + $0 | 0) + 6684 >> 2]) {
		      break label$3;
		     }
		    }
		    silk_stereo_decode_mid_only($4, $10 + 652 | 0);
		    break label$2;
		   }
		   HEAP32[$10 + 652 >> 2] = 0;
		  }
		  $8 = HEAP32[$1 + 4 >> 2];
		  label$41 : {
		   if (HEAP32[$10 + 652 >> 2] | ($8 | 0) != 2) {
		    break label$41;
		   }
		   $8 = 2;
		   if (HEAP32[$0 + 8548 >> 2] != 1) {
		    break label$41;
		   }
		   memset($0 + 5548 | 0, 0, 1024);
		   HEAP32[$0 + 8428 >> 2] = 0;
		   HEAP8[$0 + 6576 | 0] = 10;
		   HEAP32[$0 + 6572 >> 2] = 100;
		   HEAP32[$0 + 6640 >> 2] = 1;
		   $8 = HEAP32[$1 + 4 >> 2];
		  }
		  $11 = 1;
		  $3 = $10;
		  $13 = (Math_imul(HEAP32[$1 + 12 >> 2], $8) | 0) >= (Math_imul(HEAP32[$1 >> 2], HEAP32[$1 + 8 >> 2]) | 0);
		  label$42 : {
		   if (!$13) {
		    HEAP32[$10 >> 2] = $5;
		    $9 = $5;
		    $8 = $0 + 2328 | 0;
		    break label$42;
		   }
		   $9 = $14 - ((Math_imul(HEAP32[$0 + 2328 >> 2] + 2 | 0, $8) << 1) + 15 & -16) | 0;
		   $14 = $9;
		   __stack_pointer = $9;
		   HEAP32[$10 >> 2] = $9;
		   $8 = $0 + 2328 | 0;
		  }
		  $12 = ((HEAP32[$8 >> 2] << 1) + $9 | 0) + 4 | 0;
		  HEAP32[$3 + 4 >> 2] = $12;
		  label$44 : {
		   label$45 : {
		    if (!$2) {
		     $11 = !HEAP32[$10 + 652 >> 2];
		     break label$45;
		    }
		    if (!HEAP32[$0 + 8548 >> 2]) {
		     break label$45;
		    }
		    $11 = 0;
		    $8 = HEAP32[$1 + 4 >> 2];
		    if (($2 | 0) != 2 | ($8 | 0) != 2) {
		     break label$44;
		    }
		    $11 = HEAP32[((HEAP32[$0 + 6652 >> 2] << 2) + $0 | 0) + 6684 >> 2] == 1;
		   }
		   $8 = HEAP32[$1 + 4 >> 2];
		  }
		  label$47 : {
		   label$48 : {
		    if (($8 | 0) < 1) {
		     break label$48;
		    }
		    $8 = HEAP32[$0 + 2388 >> 2];
		    $3 = (($8 | 0) > 0) << 1;
		    $3 = ($2 | 0) != 2 | ($8 | 0) < 1 ? $3 : (HEAP32[(($8 << 2) + $0 | 0) + 2416 >> 2] != 0) << 1;
		    $3 = silk_decode_frame($0, $4, HEAP32[$10 >> 2] + 4 | 0, $10 + 648 | 0, $2, $3, $7);
		    $8 = 1;
		    HEAP32[$0 + 2388 >> 2] = HEAP32[$0 + 2388 >> 2] + 1;
		    $15 = $3 + $15 | 0;
		    $3 = HEAP32[$1 + 4 >> 2];
		    if (($3 | 0) >= 2) {
		     while (1) {
		      label$52 : {
		       if ($11) {
		        $20 = Math_imul($8, 4264) + $0 | 0;
		        $18 = $4;
		        $17 = HEAP32[($8 << 2) + $10 >> 2] + 4 | 0;
		        $22 = $10 + 648 | 0;
		        $19 = $2;
		        $3 = HEAP32[$0 + 2388 >> 2] - $8 | 0;
		        $16 = 0;
		        label$54 : {
		         if (($3 | 0) < 1) {
		          break label$54;
		         }
		         $16 = (HEAP32[((Math_imul($8, 4264) + $0 | 0) + ($3 << 2) | 0) + 2416 >> 2] != 0) << 1;
		         if (($2 | 0) == 2) {
		          break label$54;
		         }
		         $16 = HEAP32[$0 + 8548 >> 2] ? 1 : 2;
		        }
		        $3 = $16;
		        $15 = silk_decode_frame($20, $18, $17, $22, $19, $3, $7) + $15 | 0;
		        break label$52;
		       }
		       memset(HEAP32[($8 << 2) + $10 >> 2] + 4 | 0, 0, HEAP32[$10 + 648 >> 2] << 1);
		      }
		      $3 = Math_imul($8, 4264) + $0 | 0;
		      HEAP32[$3 + 2388 >> 2] = HEAP32[$3 + 2388 >> 2] + 1;
		      $3 = HEAP32[$1 + 4 >> 2];
		      $8 = $8 + 1 | 0;
		      if (($3 | 0) > ($8 | 0)) {
		       continue;
		      }
		      break;
		     }
		    }
		    if (($3 | 0) != 2 | HEAP32[$1 >> 2] != 2) {
		     break label$48;
		    }
		    $9 = HEAP32[$10 >> 2];
		    silk_stereo_MS_to_LR($0 + 8528 | 0, $9, $12, $10 + 640 | 0, HEAP32[$0 + 2316 >> 2], HEAP32[$10 + 648 >> 2]);
		    $11 = HEAP32[$10 + 648 >> 2];
		    break label$47;
		   }
		   $3 = HEAP32[$0 + 8532 >> 2];
		   HEAP16[$9 >> 1] = $3;
		   HEAP16[$9 + 2 >> 1] = $3 >>> 16;
		   $11 = HEAP32[$10 + 648 >> 2];
		   $3 = ($11 << 1) + $9 | 0;
		   HEAP32[$0 + 8532 >> 2] = HEAPU16[$3 >> 1] | HEAPU16[$3 + 2 >> 1] << 16;
		  }
		  $8 = (Math_imul(HEAP32[$1 + 8 >> 2], $11) | 0) / (Math_imul(HEAP16[$0 + 2316 >> 1], 1e3) | 0) | 0;
		  HEAP32[$6 >> 2] = $8;
		  $12 = HEAP32[$1 >> 2];
		  $3 = ($12 | 0) == 2;
		  $4 = $14 - ((($3 ? $8 : 1) << 1) + 15 & -16) | 0;
		  $7 = $4;
		  __stack_pointer = $4;
		  $8 = HEAP32[$1 + 4 >> 2];
		  if (!$13) {
		   $13 = HEAP32[$0 + 2328 >> 2];
		   $14 = Math_imul($13 + 2 | 0, $8) << 1;
		   $9 = $7 - ($14 + 15 & -16) | 0;
		   __stack_pointer = $9;
		   $7 = memcpy($9, $5, $14);
		   HEAP32[$10 + 4 >> 2] = ($7 + ($13 << 1) | 0) + 4;
		   HEAP32[$10 >> 2] = $7;
		  }
		  $4 = $3 ? $4 : $5;
		  label$57 : {
		   if (((($8 | 0) > ($12 | 0) ? $12 : $8) | 0) < 1) {
		    break label$57;
		   }
		   $3 = 0;
		   while (1) {
		    $13 = silk_resampler((Math_imul($3, 4264) + $0 | 0) + 2432 | 0, $4, $9 + 2 | 0, $11);
		    $12 = HEAP32[$1 >> 2];
		    label$59 : {
		     if (($12 | 0) != 2) {
		      break label$59;
		     }
		     $8 = 0;
		     $11 = HEAP32[$6 >> 2];
		     if (($11 | 0) < 1) {
		      break label$59;
		     }
		     while (1) {
		      $9 = $8 << 1;
		      HEAP16[($9 + $3 << 1) + $5 >> 1] = HEAPU16[$4 + $9 >> 1];
		      $8 = $8 + 1 | 0;
		      if (($11 | 0) != ($8 | 0)) {
		       continue;
		      }
		      break;
		     }
		    }
		    $15 = $15 + $13 | 0;
		    $3 = $3 + 1 | 0;
		    $8 = HEAP32[$1 + 4 >> 2];
		    if (($3 | 0) >= ((($8 | 0) > ($12 | 0) ? $12 : $8) | 0)) {
		     break label$57;
		    }
		    $9 = HEAP32[($3 << 2) + $10 >> 2];
		    $11 = HEAP32[$10 + 648 >> 2];
		    continue;
		   }
		  }
		  label$61 : {
		   label$62 : {
		    label$63 : {
		     if (($12 | 0) != 2 | ($8 | 0) != 1) {
		      break label$63;
		     }
		     if ($21) {
		      break label$62;
		     }
		     $8 = 0;
		     $3 = HEAP32[$6 >> 2];
		     if (($3 | 0) <= 0) {
		      break label$63;
		     }
		     while (1) {
		      $9 = $8 << 2;
		      HEAP16[($9 | 2) + $5 >> 1] = HEAPU16[$5 + $9 >> 1];
		      $8 = $8 + 1 | 0;
		      if (($8 | 0) != ($3 | 0)) {
		       continue;
		      }
		      break;
		     }
		    }
		    $3 = $15;
		    break label$61;
		   }
		   $3 = silk_resampler($0 + 6696 | 0, $4, HEAP32[$10 >> 2] + 2 | 0, HEAP32[$10 + 648 >> 2]) + $15 | 0;
		   $9 = HEAP32[$6 >> 2];
		   if (($9 | 0) < 1) {
		    break label$61;
		   }
		   $8 = 0;
		   while (1) {
		    HEAP16[($8 << 2 | 2) + $5 >> 1] = HEAPU16[($8 << 1) + $4 >> 1];
		    $8 = $8 + 1 | 0;
		    if (($9 | 0) != ($8 | 0)) {
		     continue;
		    }
		    break;
		   }
		  }
		  $8 = 0;
		  $8 = HEAP32[$0 + 4164 >> 2] == 2 ? Math_imul(HEAP32[(HEAP32[$0 + 2316 >> 2] - 8 & -4) + 9412 >> 2], HEAP32[$0 + 2308 >> 2]) : $8;
		  HEAP32[$1 + 20 >> 2] = $8;
		  label$67 : {
		   if (($2 | 0) == 1) {
		    $9 = HEAP32[$0 + 8544 >> 2];
		    if (($9 | 0) < 1) {
		     break label$67;
		    }
		    $8 = 0;
		    while (1) {
		     HEAP8[(Math_imul($8, 4264) + $0 | 0) + 2312 | 0] = 10;
		     $8 = $8 + 1 | 0;
		     if (($9 | 0) != ($8 | 0)) {
		      continue;
		     }
		     break;
		    }
		    break label$67;
		   }
		   HEAP32[$0 + 8548 >> 2] = HEAP32[$10 + 652 >> 2];
		  }
		 }
		 __stack_pointer = $10 + 656 | 0;
		 return $3;
		}
		function opus_fft_impl($0, $1) {
		 var $2 = 0, $3 = Math_fround(0), $4 = 0, $5 = Math_fround(0), $6 = Math_fround(0), $7 = 0, $8 = Math_fround(0), $9 = 0, $10 = 0, $11 = Math_fround(0), $12 = 0, $13 = Math_fround(0), $14 = 0, $15 = Math_fround(0), $16 = Math_fround(0), $17 = Math_fround(0), $18 = 0, $19 = Math_fround(0), $20 = Math_fround(0), $21 = 0, $22 = Math_fround(0), $23 = Math_fround(0), $24 = Math_fround(0), $25 = 0, $26 = 0, $27 = 0, $28 = 0, $29 = 0, $30 = 0, $31 = Math_fround(0), $32 = Math_fround(0), $33 = Math_fround(0), $34 = 0, $35 = 0, $36 = 0, $37 = Math_fround(0), $38 = 0, $39 = 0, $40 = Math_fround(0), $41 = Math_fround(0), $42 = Math_fround(0), $43 = Math_fround(0), $44 = Math_fround(0), $45 = Math_fround(0), $46 = Math_fround(0), $47 = Math_fround(0), $48 = Math_fround(0), $49 = Math_fround(0), $50 = 0;
		 $29 = __stack_pointer - 32 | 0;
		 __stack_pointer = $29;
		 $14 = HEAP32[$0 + 8 >> 2];
		 HEAP32[$29 >> 2] = 1;
		 $7 = $0 + 12 | 0;
		 $9 = 1;
		 while (1) {
		  $2 = $4;
		  $10 = $2 << 2;
		  $18 = HEAPU16[($10 | 2) + $7 >> 1];
		  $4 = $2 + 1 | 0;
		  $9 = Math_imul(HEAP16[$7 + $10 >> 1], $9);
		  HEAP32[($4 << 2) + $29 >> 2] = $9;
		  if (($18 | 0) != 1) {
		   continue;
		  }
		  break;
		 }
		 $38 = ($14 | 0) > 0 ? $14 : 0;
		 $35 = HEAP16[(($4 << 2) + $0 | 0) + 10 >> 1];
		 label$2 : {
		  while (1) {
		   $12 = $35;
		   $4 = 0;
		   $35 = 1;
		   $30 = $2;
		   if ($2) {
		    $35 = HEAP16[(($30 << 2) + $0 | 0) + 10 >> 1];
		    $4 = $30 << 1;
		   }
		   label$5 : {
		    label$6 : {
		     switch (HEAP16[(($4 << 1) + $0 | 0) + 12 >> 1] - 2 | 0) {
		     case 0:
		      if (($12 | 0) != 4) {
		       break label$2;
		      }
		      $4 = 0;
		      $2 = $1;
		      $10 = HEAP32[($30 << 2) + $29 >> 2];
		      if (($10 | 0) <= 0) {
		       break label$5;
		      }
		      while (1) {
		       $6 = HEAPF32[$2 >> 2];
		       $3 = HEAPF32[$2 + 32 >> 2];
		       HEAPF32[$2 + 32 >> 2] = $6 - $3;
		       HEAPF32[$2 >> 2] = $3 + $6;
		       $7 = $2 + 36 | 0;
		       $6 = HEAPF32[$7 >> 2];
		       $3 = HEAPF32[$2 + 4 >> 2];
		       HEAPF32[$2 + 4 >> 2] = $6 + $3;
		       HEAPF32[$2 + 36 >> 2] = $3 - $6;
		       $6 = HEAPF32[$2 + 8 >> 2];
		       $3 = HEAPF32[$2 + 40 >> 2];
		       $7 = $2 + 44 | 0;
		       $5 = HEAPF32[$7 >> 2];
		       $8 = Math_fround(Math_fround($3 + $5) * Math_fround(.7071067690849304));
		       HEAPF32[$2 + 40 >> 2] = $6 - $8;
		       $9 = $2 + 12 | 0;
		       $11 = HEAPF32[$9 >> 2];
		       $3 = Math_fround(Math_fround($5 - $3) * Math_fround(.7071067690849304));
		       HEAPF32[$2 + 44 >> 2] = $11 - $3;
		       HEAPF32[$2 + 8 >> 2] = $6 + $8;
		       HEAPF32[$2 + 12 >> 2] = $3 + $11;
		       $6 = HEAPF32[$2 + 48 >> 2];
		       $3 = HEAPF32[$2 + 16 >> 2];
		       $7 = $2 + 52 | 0;
		       $5 = HEAPF32[$7 >> 2];
		       HEAPF32[$2 + 48 >> 2] = $3 - $5;
		       $9 = $2 + 20 | 0;
		       $8 = HEAPF32[$9 >> 2];
		       HEAPF32[$2 + 52 >> 2] = $6 + $8;
		       HEAPF32[$2 + 20 >> 2] = $8 - $6;
		       HEAPF32[$2 + 16 >> 2] = $5 + $3;
		       $6 = HEAPF32[$2 + 24 >> 2];
		       $7 = $2 + 60 | 0;
		       $3 = HEAPF32[$7 >> 2];
		       $5 = HEAPF32[$2 + 56 >> 2];
		       $8 = Math_fround(Math_fround($3 - $5) * Math_fround(.7071067690849304));
		       HEAPF32[$2 + 56 >> 2] = $6 - $8;
		       $9 = $2 + 28 | 0;
		       $11 = HEAPF32[$9 >> 2];
		       $3 = Math_fround(Math_fround($3 + $5) * Math_fround(-0.7071067690849304));
		       HEAPF32[$2 + 60 >> 2] = $11 - $3;
		       HEAPF32[$2 + 28 >> 2] = $3 + $11;
		       HEAPF32[$2 + 24 >> 2] = $6 + $8;
		       $2 = $2 - -64 | 0;
		       $4 = $4 + 1 | 0;
		       if (($10 | 0) != ($4 | 0)) {
		        continue;
		       }
		       break;
		      }
		      break label$5;
		     case 2:
		      $34 = HEAP32[($30 << 2) + $29 >> 2];
		      if (($12 | 0) == 1) {
		       $4 = 0;
		       $2 = $1;
		       if (($34 | 0) < 1) {
		        break label$5;
		       }
		       while (1) {
		        $6 = HEAPF32[$2 >> 2];
		        $3 = HEAPF32[$2 + 16 >> 2];
		        $5 = Math_fround($6 + $3);
		        $8 = HEAPF32[$2 + 8 >> 2];
		        $11 = HEAPF32[$2 + 24 >> 2];
		        $15 = Math_fround($8 + $11);
		        HEAPF32[$2 + 16 >> 2] = $5 - $15;
		        HEAPF32[$2 >> 2] = $5 + $15;
		        $7 = $2 + 20 | 0;
		        $12 = $7;
		        $5 = HEAPF32[$2 + 4 >> 2];
		        $15 = HEAPF32[$2 + 20 >> 2];
		        $20 = Math_fround($5 + $15);
		        $7 = $2 + 12 | 0;
		        $22 = HEAPF32[$7 >> 2];
		        $9 = $2 + 28 | 0;
		        $16 = HEAPF32[$9 >> 2];
		        $17 = Math_fround($22 + $16);
		        HEAPF32[$12 >> 2] = $20 - $17;
		        $5 = Math_fround($5 - $15);
		        $8 = Math_fround($8 - $11);
		        HEAPF32[$2 + 28 >> 2] = $5 + $8;
		        $6 = Math_fround($6 - $3);
		        $3 = Math_fround($22 - $16);
		        HEAPF32[$2 + 24 >> 2] = $6 - $3;
		        HEAPF32[$2 + 12 >> 2] = $5 - $8;
		        HEAPF32[$2 + 8 >> 2] = $6 + $3;
		        HEAPF32[$2 + 4 >> 2] = $20 + $17;
		        $2 = $2 + 32 | 0;
		        $4 = $4 + 1 | 0;
		        if (($34 | 0) != ($4 | 0)) {
		         continue;
		        }
		        break;
		       }
		       break label$5;
		      }
		      if (($34 | 0) < 1) {
		       break label$5;
		      }
		      $26 = Math_imul($12, 3);
		      $27 = $12 << 1;
		      $21 = $34 << $38;
		      $28 = Math_imul($21, 3);
		      $39 = $21 << 1;
		      $50 = HEAP32[$0 + 48 >> 2];
		      $36 = 0;
		      while (1) {
		       if (($12 | 0) >= 1) {
		        $2 = (Math_imul($35, $36) << 3) + $1 | 0;
		        $25 = 0;
		        $4 = $50;
		        $7 = $4;
		        $9 = $4;
		        while (1) {
		         $10 = ($12 << 3) + $2 | 0;
		         $6 = HEAPF32[$10 + 4 >> 2];
		         $3 = HEAPF32[$10 >> 2];
		         $18 = ($26 << 3) + $2 | 0;
		         $5 = HEAPF32[$18 + 4 >> 2];
		         $8 = HEAPF32[$18 >> 2];
		         $11 = HEAPF32[$9 >> 2];
		         $15 = HEAPF32[$9 + 4 >> 2];
		         $20 = HEAPF32[$4 >> 2];
		         $22 = HEAPF32[$4 + 4 >> 2];
		         $16 = HEAPF32[$7 >> 2];
		         $14 = ($27 << 3) + $2 | 0;
		         $17 = HEAPF32[$14 + 4 >> 2];
		         $13 = HEAPF32[$14 >> 2];
		         $19 = HEAPF32[$7 + 4 >> 2];
		         $31 = Math_fround(Math_fround($16 * $17) + Math_fround($13 * $19));
		         $23 = HEAPF32[$2 + 4 >> 2];
		         $24 = Math_fround($31 + $23);
		         HEAPF32[$2 + 4 >> 2] = $24;
		         $16 = Math_fround(Math_fround($13 * $16) - Math_fround($17 * $19));
		         $17 = HEAPF32[$2 >> 2];
		         $13 = Math_fround($16 + $17);
		         HEAPF32[$2 >> 2] = $13;
		         $19 = Math_fround(Math_fround($11 * $6) + Math_fround($3 * $15));
		         $32 = Math_fround(Math_fround($20 * $5) + Math_fround($8 * $22));
		         $33 = Math_fround($19 + $32);
		         HEAPF32[$14 + 4 >> 2] = $24 - $33;
		         $6 = Math_fround(Math_fround($3 * $11) - Math_fround($6 * $15));
		         $3 = Math_fround(Math_fround($8 * $20) - Math_fround($5 * $22));
		         $5 = Math_fround($6 + $3);
		         HEAPF32[$14 >> 2] = $13 - $5;
		         HEAPF32[$2 >> 2] = $5 + HEAPF32[$2 >> 2];
		         HEAPF32[$2 + 4 >> 2] = $33 + HEAPF32[$2 + 4 >> 2];
		         $5 = Math_fround($23 - $31);
		         $6 = Math_fround($6 - $3);
		         HEAPF32[$10 + 4 >> 2] = $5 - $6;
		         $3 = Math_fround($17 - $16);
		         $8 = Math_fround($19 - $32);
		         HEAPF32[$10 >> 2] = $3 + $8;
		         HEAPF32[$18 + 4 >> 2] = $5 + $6;
		         HEAPF32[$18 >> 2] = $3 - $8;
		         $2 = $2 + 8 | 0;
		         $4 = ($28 << 3) + $4 | 0;
		         $7 = ($39 << 3) + $7 | 0;
		         $9 = ($21 << 3) + $9 | 0;
		         $25 = $25 + 1 | 0;
		         if (($25 | 0) != ($12 | 0)) {
		          continue;
		         }
		         break;
		        }
		       }
		       $36 = $36 + 1 | 0;
		       if (($36 | 0) != ($34 | 0)) {
		        continue;
		       }
		       break;
		      }
		      break label$5;
		     case 1:
		      $28 = HEAP32[($30 << 2) + $29 >> 2];
		      if (($28 | 0) < 1) {
		       break label$5;
		      }
		      $25 = $12 << 1;
		      $27 = HEAP32[$0 + 48 >> 2];
		      $14 = $28 << $38;
		      $6 = HEAPF32[($27 + (Math_imul($14, $12) << 3) | 0) + 4 >> 2];
		      $21 = $14 << 1;
		      $26 = 0;
		      while (1) {
		       $2 = (Math_imul($26, $35) << 3) + $1 | 0;
		       $7 = $27;
		       $9 = $7;
		       $18 = $12;
		       while (1) {
		        $4 = ($12 << 3) + $2 | 0;
		        $3 = HEAPF32[$4 >> 2];
		        $5 = HEAPF32[$9 >> 2];
		        $8 = HEAPF32[$4 + 4 >> 2];
		        $11 = HEAPF32[$9 + 4 >> 2];
		        $15 = Math_fround(Math_fround($3 * $5) - Math_fround($8 * $11));
		        $10 = ($25 << 3) + $2 | 0;
		        $20 = HEAPF32[$10 >> 2];
		        $22 = HEAPF32[$7 >> 2];
		        $16 = HEAPF32[$10 + 4 >> 2];
		        $17 = HEAPF32[$7 + 4 >> 2];
		        $13 = Math_fround(Math_fround($20 * $22) - Math_fround($16 * $17));
		        $19 = Math_fround($15 + $13);
		        HEAPF32[$4 >> 2] = HEAPF32[$2 >> 2] - Math_fround($19 * Math_fround(.5));
		        $3 = Math_fround(Math_fround($5 * $8) + Math_fround($3 * $11));
		        $5 = Math_fround(Math_fround($22 * $16) + Math_fround($20 * $17));
		        $8 = Math_fround($3 + $5);
		        HEAPF32[$4 + 4 >> 2] = HEAPF32[$2 + 4 >> 2] - Math_fround($8 * Math_fround(.5));
		        HEAPF32[$2 >> 2] = $19 + HEAPF32[$2 >> 2];
		        HEAPF32[$2 + 4 >> 2] = $8 + HEAPF32[$2 + 4 >> 2];
		        $3 = Math_fround($6 * Math_fround($3 - $5));
		        HEAPF32[$10 >> 2] = $3 + HEAPF32[$4 >> 2];
		        $5 = Math_fround($6 * Math_fround($15 - $13));
		        HEAPF32[$10 + 4 >> 2] = HEAPF32[$4 + 4 >> 2] - $5;
		        HEAPF32[$4 >> 2] = HEAPF32[$4 >> 2] - $3;
		        HEAPF32[$4 + 4 >> 2] = $5 + HEAPF32[$4 + 4 >> 2];
		        $2 = $2 + 8 | 0;
		        $7 = ($21 << 3) + $7 | 0;
		        $9 = ($14 << 3) + $9 | 0;
		        $18 = $18 - 1 | 0;
		        if ($18) {
		         continue;
		        }
		        break;
		       }
		       $26 = $26 + 1 | 0;
		       if (($28 | 0) != ($26 | 0)) {
		        continue;
		       }
		       break;
		      }
		      break label$5;
		     case 3:
		      break label$6;
		     default:
		      break label$5;
		     }
		    }
		    $28 = HEAP32[($30 << 2) + $29 >> 2];
		    if (($28 | 0) < 1) {
		     break label$5;
		    }
		    $18 = HEAP32[$0 + 48 >> 2];
		    $26 = $28 << $38;
		    $2 = Math_imul($26, $12);
		    $4 = $18 + ($2 << 4) | 0;
		    $6 = HEAPF32[$4 + 4 >> 2];
		    $3 = HEAPF32[$4 >> 2];
		    $2 = ($2 << 3) + $18 | 0;
		    $5 = HEAPF32[$2 + 4 >> 2];
		    $8 = HEAPF32[$2 >> 2];
		    $39 = $12 << 2;
		    $36 = Math_imul($12, 3);
		    $34 = $12 << 1;
		    $27 = 0;
		    while (1) {
		     if (($12 | 0) >= 1) {
		      $2 = (Math_imul($27, $35) << 3) + $1 | 0;
		      $4 = $2 + ($12 << 3) | 0;
		      $7 = ($34 << 3) + $2 | 0;
		      $9 = ($36 << 3) + $2 | 0;
		      $10 = ($39 << 3) + $2 | 0;
		      $25 = 0;
		      while (1) {
		       $11 = HEAPF32[$2 >> 2];
		       $15 = HEAPF32[$2 + 4 >> 2];
		       $14 = Math_imul($25, $26);
		       $21 = ($14 << 4) + $18 | 0;
		       $16 = HEAPF32[$21 >> 2];
		       $17 = HEAPF32[$7 + 4 >> 2];
		       $13 = HEAPF32[$7 >> 2];
		       $19 = HEAPF32[$21 + 4 >> 2];
		       $31 = Math_fround(Math_fround($16 * $17) + Math_fround($13 * $19));
		       $21 = Math_imul($14, 24) + $18 | 0;
		       $23 = HEAPF32[$21 >> 2];
		       $24 = HEAPF32[$9 + 4 >> 2];
		       $32 = HEAPF32[$9 >> 2];
		       $33 = HEAPF32[$21 + 4 >> 2];
		       $37 = Math_fround(Math_fround($23 * $24) + Math_fround($32 * $33));
		       $20 = Math_fround($31 + $37);
		       $21 = ($14 << 3) + $18 | 0;
		       $40 = HEAPF32[$21 >> 2];
		       $41 = HEAPF32[$4 + 4 >> 2];
		       $42 = HEAPF32[$4 >> 2];
		       $43 = HEAPF32[$21 + 4 >> 2];
		       $44 = Math_fround(Math_fround($40 * $41) + Math_fround($42 * $43));
		       $14 = ($14 << 5) + $18 | 0;
		       $45 = HEAPF32[$14 >> 2];
		       $46 = HEAPF32[$10 + 4 >> 2];
		       $47 = HEAPF32[$10 >> 2];
		       $48 = HEAPF32[$14 + 4 >> 2];
		       $49 = Math_fround(Math_fround($45 * $46) + Math_fround($47 * $48));
		       $22 = Math_fround($44 + $49);
		       HEAPF32[$2 + 4 >> 2] = $15 + Math_fround($20 + $22);
		       $13 = Math_fround(Math_fround($13 * $16) - Math_fround($17 * $19));
		       $19 = Math_fround(Math_fround($32 * $23) - Math_fround($24 * $33));
		       $16 = Math_fround($13 + $19);
		       $23 = Math_fround(Math_fround($42 * $40) - Math_fround($41 * $43));
		       $24 = Math_fround(Math_fround($47 * $45) - Math_fround($46 * $48));
		       $17 = Math_fround($23 + $24);
		       HEAPF32[$2 >> 2] = $11 + Math_fround($16 + $17);
		       $13 = Math_fround($13 - $19);
		       $19 = Math_fround($23 - $24);
		       $23 = Math_fround(Math_fround($6 * $13) + Math_fround($5 * $19));
		       $24 = Math_fround($15 + Math_fround(Math_fround($3 * $20) + Math_fround($8 * $22)));
		       HEAPF32[$4 + 4 >> 2] = $23 + $24;
		       $32 = Math_fround($11 + Math_fround(Math_fround($3 * $16) + Math_fround($8 * $17)));
		       $31 = Math_fround($31 - $37);
		       $33 = Math_fround($44 - $49);
		       $37 = Math_fround(Math_fround($6 * $31) + Math_fround($5 * $33));
		       HEAPF32[$4 >> 2] = $32 - $37;
		       HEAPF32[$10 + 4 >> 2] = $24 - $23;
		       HEAPF32[$10 >> 2] = $37 + $32;
		       $13 = Math_fround(Math_fround($6 * $19) - Math_fround($5 * $13));
		       $15 = Math_fround($15 + Math_fround(Math_fround($8 * $20) + Math_fround($3 * $22)));
		       HEAPF32[$7 + 4 >> 2] = $13 + $15;
		       $20 = Math_fround(Math_fround($5 * $31) - Math_fround($6 * $33));
		       $11 = Math_fround($11 + Math_fround(Math_fround($8 * $16) + Math_fround($3 * $17)));
		       HEAPF32[$7 >> 2] = $20 + $11;
		       HEAPF32[$9 + 4 >> 2] = $15 - $13;
		       HEAPF32[$9 >> 2] = $11 - $20;
		       $10 = $10 + 8 | 0;
		       $9 = $9 + 8 | 0;
		       $7 = $7 + 8 | 0;
		       $4 = $4 + 8 | 0;
		       $2 = $2 + 8 | 0;
		       $25 = $25 + 1 | 0;
		       if (($25 | 0) != ($12 | 0)) {
		        continue;
		       }
		       break;
		      }
		     }
		     $27 = $27 + 1 | 0;
		     if (($28 | 0) != ($27 | 0)) {
		      continue;
		     }
		     break;
		    }
		   }
		   $2 = $30 - 1 | 0;
		   if (($30 | 0) > 0) {
		    continue;
		   }
		   break;
		  }
		  __stack_pointer = $29 + 32 | 0;
		  return;
		 }
		 celt_fatal(34088, 34072, 76);
		 abort();
		}
		function celt_decode_with_ec($0, $1, $2, $3, $4, $5, $6) {
		 var $7 = 0, $8 = 0, $9 = 0, $10 = 0, $11 = 0, $12 = 0, $13 = 0, $14 = 0, $15 = 0, $16 = 0, $17 = 0, $18 = 0, $19 = 0, $20 = Math_fround(0), $21 = 0, $22 = 0, $23 = 0, $24 = 0, $25 = 0, $26 = 0, $27 = Math_fround(0), $28 = 0, $29 = 0, $30 = 0, $31 = 0, $32 = 0, $33 = 0, $34 = 0, $35 = 0, $36 = 0, $37 = 0, $38 = 0, $39 = 0, $40 = 0, $41 = 0, $42 = 0, $43 = 0, $44 = 0, $45 = 0, $46 = 0, $47 = 0, $48 = 0, $49 = 0, $50 = 0, $51 = Math_fround(0);
		 $19 = __stack_pointer - 80 | 0;
		 __stack_pointer = $19;
		 $29 = HEAP32[$0 + 8 >> 2];
		 $17 = $19;
		 HEAP32[$17 + 12 >> 2] = 0;
		 HEAP32[$17 + 8 >> 2] = 0;
		 $21 = HEAP32[$0 + 12 >> 2];
		 validate_celt_decoder($0);
		 $10 = -1;
		 $12 = HEAP32[$0 >> 2];
		 $22 = HEAP32[$12 + 36 >> 2];
		 label$1 : {
		  if (($22 | 0) < 0) {
		   break label$1;
		  }
		  $14 = HEAP32[$12 + 8 >> 2];
		  $7 = $14 << 3;
		  $33 = HEAP32[$12 + 4 >> 2];
		  $11 = $33 + 2048 | 0;
		  $16 = (((Math_imul($29, $11) << 2) + $0 | 0) + Math_imul($29, 96) | 0) + 92 | 0;
		  $26 = $7 + $16 | 0;
		  $30 = $7 + $26 | 0;
		  $44 = $30 + $7 | 0;
		  $4 = Math_imul(HEAP32[$0 + 16 >> 2], $4);
		  $13 = HEAP32[$0 + 24 >> 2];
		  $34 = HEAP32[$12 + 32 >> 2];
		  $8 = HEAP32[$12 + 44 >> 2];
		  while (1) {
		   if ($8 << $9 != ($4 | 0)) {
		    $7 = ($9 | 0) < ($22 | 0);
		    $9 = $9 + 1 | 0;
		    if ($7) {
		     continue;
		    }
		    break label$1;
		   }
		   break;
		  }
		  if (!$3 | $2 >>> 0 > 1275) {
		   break label$1;
		  }
		  $18 = HEAP32[$0 + 20 >> 2];
		  $35 = $14 << 1;
		  $42 = 1 << $9;
		  $22 = ($29 | 0) > 1 ? $29 : 1;
		  $7 = 0;
		  $15 = 0 - $4 << 2;
		  while (1) {
		   $8 = $7 << 2;
		   $10 = ((Math_imul($7, $11) << 2) + $0 | 0) + 92 | 0;
		   HEAP32[$8 + ($17 + 24 | 0) >> 2] = $10;
		   HEAP32[($17 + 16 | 0) + $8 >> 2] = ($10 + $15 | 0) - -8192;
		   $7 = $7 + 1 | 0;
		   if (($22 | 0) != ($7 | 0)) {
		    continue;
		   }
		   break;
		  }
		  if (!(($2 | 0) > 1 ? $1 : 0)) {
		   celt_decode_lost($0, $4, $9);
		   deemphasis($17 + 16 | 0, $3, $4, $29, HEAP32[$0 + 16 >> 2], $12 + 16 | 0, $0 + 84 | 0, $6);
		   $10 = ($4 | 0) / HEAP32[$0 + 16 >> 2] | 0;
		   break label$1;
		  }
		  $36 = HEAP32[$12 + 12 >> 2];
		  $7 = 0;
		  HEAP32[$0 + 56 >> 2] = HEAP32[$0 + 52 >> 2] != 0;
		  if (!$5) {
		   ec_dec_init($17 + 32 | 0, $1, $2);
		   $5 = $17 + 32 | 0;
		  }
		  $31 = 1;
		  if (!(($21 | 0) != 1 | ($14 | 0) < 1)) {
		   while (1) {
		    $8 = ($7 << 2) + $16 | 0;
		    $20 = HEAPF32[$8 >> 2];
		    $27 = HEAPF32[($7 + $14 << 2) + $16 >> 2];
		    HEAPF32[$8 >> 2] = $20 > $27 ? $20 : $27;
		    $7 = $7 + 1 | 0;
		    if (($14 | 0) != ($7 | 0)) {
		     continue;
		    }
		    break;
		   }
		  }
		  $8 = Math_clz32(HEAP32[$5 + 28 >> 2]);
		  $7 = ($8 + HEAP32[$5 + 20 >> 2] | 0) - 32 | 0;
		  $24 = $2 << 3;
		  label$9 : {
		   if (($7 | 0) < ($24 | 0)) {
		    $31 = 0;
		    $1 = 0;
		    if (($7 | 0) != 1) {
		     break label$9;
		    }
		    $31 = ec_dec_bit_logp($5, 15);
		    if (!$31) {
		     $31 = 0;
		     $7 = 1;
		     $1 = 0;
		     break label$9;
		    }
		    $8 = Math_clz32(HEAP32[$5 + 28 >> 2]);
		   }
		   HEAP32[$5 + 20 >> 2] = ($24 - $8 | 0) + 32;
		   $7 = $24;
		   $1 = 1;
		  }
		  $45 = $1;
		  $20 = Math_fround(0);
		  if (!(($7 + 16 | 0) > ($24 | 0) | $18)) {
		   $1 = !ec_dec_bit_logp($5, 1);
		   $20 = Math_fround(0);
		   label$14 : {
		    if ($1) {
		     break label$14;
		    }
		    $7 = ec_dec_uint($5, 6);
		    $7 = ec_dec_bits($5, $7 + 4 | 0) + (16 << $7) | 0;
		    $8 = ec_dec_bits($5, 3);
		    if (((HEAP32[$5 + 20 >> 2] + Math_clz32(HEAP32[$5 + 28 >> 2]) | 0) - 30 | 0) <= ($24 | 0)) {
		     $38 = ec_dec_icdf($5, 35246, 2);
		    }
		    $39 = $7 - 1 | 0;
		    $20 = Math_fround(Math_fround($8 + 1 | 0) * Math_fround(.09375));
		   }
		   $7 = (HEAP32[$5 + 20 >> 2] + Math_clz32(HEAP32[$5 + 28 >> 2]) | 0) - 32 | 0;
		  }
		  $7 = $7 + 3 | 0;
		  if (!(!$9 | ($24 | 0) < ($7 | 0))) {
		   $28 = ec_dec_bit_logp($5, 3);
		   $7 = (HEAP32[$5 + 20 >> 2] + Math_clz32(HEAP32[$5 + 28 >> 2]) | 0) - 29 | 0;
		  }
		  $8 = 0;
		  $1 = $12;
		  $11 = $18;
		  $10 = $13;
		  $25 = $16;
		  if (($7 | 0) <= ($24 | 0)) {
		   $8 = ec_dec_bit_logp($5, 3);
		  }
		  unquant_coarse_energy($1, $11, $10, $25, $8, $5, $21, $9);
		  $32 = $19 - (($14 << 2) + 15 & -16) | 0;
		  $25 = $32;
		  __stack_pointer = $25;
		  $8 = HEAP32[$5 + 4 >> 2] << 3;
		  $10 = (HEAP32[$5 + 20 >> 2] + Math_clz32(HEAP32[$5 + 28 >> 2]) | 0) - 32 | 0;
		  $7 = $28 ? 2 : 4;
		  $1 = ($9 | 0) != 0 & $8 >>> 0 >= $10 + ($7 | 1) >>> 0;
		  $15 = 0;
		  $23 = ($13 | 0) <= ($18 | 0);
		  label$20 : {
		   if ($23) {
		    break label$20;
		   }
		   $19 = $8 - $1 | 0;
		   if ($19 >>> 0 >= $7 + $10 >>> 0) {
		    $15 = ec_dec_bit_logp($5, $7);
		    $10 = (HEAP32[$5 + 20 >> 2] + Math_clz32(HEAP32[$5 + 28 >> 2]) | 0) - 32 | 0;
		   }
		   HEAP32[($18 << 2) + $32 >> 2] = $15;
		   $7 = $18 + 1 | 0;
		   if (($13 | 0) == ($7 | 0)) {
		    break label$20;
		   }
		   $11 = $28 ? 4 : 5;
		   $8 = $15;
		   while (1) {
		    if ($10 + $11 >>> 0 <= $19 >>> 0) {
		     $8 = ec_dec_bit_logp($5, $11) ^ $8;
		     $15 = $15 | $8;
		     $10 = (HEAP32[$5 + 20 >> 2] + Math_clz32(HEAP32[$5 + 28 >> 2]) | 0) - 32 | 0;
		    }
		    HEAP32[($7 << 2) + $32 >> 2] = $8;
		    $7 = $7 + 1 | 0;
		    if (($13 | 0) != ($7 | 0)) {
		     continue;
		    }
		    break;
		   }
		  }
		  $7 = 0;
		  label$24 : {
		   if (!$1) {
		    break label$24;
		   }
		   $8 = ($9 << 3) + 1664 | 0;
		   $10 = $28 << 2;
		   if (HEAPU8[$8 + ($15 + $10 | 0) | 0] == HEAPU8[(($10 | 2) + $15 | 0) + $8 | 0]) {
		    break label$24;
		   }
		   $7 = ec_dec_bit_logp($5, 1) << 1;
		  }
		  if (!$23) {
		   $10 = ($28 << 2) + $7 | 0;
		   $11 = $9 << 3;
		   $7 = $18;
		   while (1) {
		    $8 = ($7 << 2) + $32 | 0;
		    HEAP32[$8 >> 2] = HEAP8[((HEAP32[$8 >> 2] + $10 | 0) + $11 | 0) + 1664 | 0];
		    $7 = $7 + 1 | 0;
		    if (($13 | 0) != ($7 | 0)) {
		     continue;
		    }
		    break;
		   }
		  }
		  $43 = 2;
		  if (((HEAP32[$5 + 20 >> 2] + Math_clz32(HEAP32[$5 + 28 >> 2]) | 0) - 28 | 0) <= ($24 | 0)) {
		   $43 = ec_dec_icdf($5, 35249, 5);
		  }
		  $7 = ($14 << 2) + 15 & -16;
		  $40 = $25 - $7 | 0;
		  $8 = $40;
		  __stack_pointer = $8;
		  init_caps($12, $8, $9, $21);
		  $1 = 6;
		  $37 = $2 << 6;
		  $25 = $8 - $7 | 0;
		  $41 = $25;
		  __stack_pointer = $25;
		  $8 = ec_tell_frac($5);
		  label$28 : {
		   if ($23) {
		    $10 = $37;
		    break label$28;
		   }
		   $11 = $18;
		   $10 = $37;
		   while (1) {
		    $2 = $11 + 1 | 0;
		    $23 = $11 << 2;
		    label$31 : {
		     label$32 : {
		      label$33 : {
		       if ((($1 << 3) + $8 | 0) < ($10 | 0)) {
		        $7 = 0;
		        $19 = $23 + $40 | 0;
		        if (HEAP32[$19 >> 2] <= 0) {
		         break label$32;
		        }
		        $8 = Math_imul(HEAP16[($2 << 1) + $34 >> 1] - HEAP16[($11 << 1) + $34 >> 1] | 0, $21) << $9;
		        $11 = $8 << 3;
		        $8 = ($8 | 0) > 48 ? $8 : 48;
		        $15 = ($8 | 0) > ($11 | 0) ? $11 : $8;
		        $11 = $1;
		        break label$33;
		       }
		       HEAP32[$23 + $25 >> 2] = 0;
		       break label$31;
		      }
		      while (1) {
		       $11 = ec_dec_bit_logp($5, $11);
		       $8 = ec_tell_frac($5);
		       if (!$11) {
		        break label$32;
		       }
		       $7 = $7 + $15 | 0;
		       $10 = $10 - $15 | 0;
		       if (($10 | 0) <= ($8 + 8 | 0)) {
		        break label$32;
		       }
		       $11 = 1;
		       if (HEAP32[$19 >> 2] > ($7 | 0)) {
		        continue;
		       }
		       break;
		      }
		     }
		     HEAP32[$23 + $25 >> 2] = $7;
		     $1 = ($7 | 0) > 0 ? ($1 | 0) > 2 ? $1 - 1 | 0 : 2 : $1;
		    }
		    $11 = $2;
		    if (($13 | 0) != ($11 | 0)) {
		     continue;
		    }
		    break;
		   }
		  }
		  $11 = $41 - (($14 << 2) + 15 & -16) | 0;
		  $19 = $11;
		  __stack_pointer = $11;
		  $2 = 5;
		  if (($8 + 48 | 0) <= ($10 | 0)) {
		   $2 = ec_dec_icdf($5, 35253, 7);
		  }
		  $10 = ($13 | 0) > ($36 | 0);
		  $8 = (ec_tell_frac($5) ^ -1) + $37 | 0;
		  $7 = 0;
		  $34 = $10 ? $36 : $13;
		  $36 = $28 ? $42 : 0;
		  $10 = ($14 << 2) + 15 & -16;
		  $19 = $19 - $10 | 0;
		  $1 = $19;
		  __stack_pointer = $1;
		  $1 = $1 - $10 | 0;
		  $41 = $1;
		  __stack_pointer = $1;
		  $10 = $12;
		  $46 = $18;
		  $47 = $13;
		  $48 = $17 + 12 | 0;
		  $49 = $17 + 8 | 0;
		  $50 = $8;
		  label$37 : {
		   if ($9 >>> 0 < 2) {
		    $23 = 0;
		    $15 = 0;
		    break label$37;
		   }
		   $23 = 0;
		   $15 = 0;
		   if (!$28) {
		    break label$37;
		   }
		   $23 = (($9 << 3) + 16 | 0) <= ($8 | 0);
		   $15 = $23 << 3;
		  }
		  $2 = clt_compute_allocation($10, $46, $47, $25, $40, $2, $48, $49, $50 - $15 | 0, $17 + 4 | 0, $19, $11, $1, $21, $9, $5, 0, 0);
		  unquant_fine_energy($12, $18, $13, $16, $11, $5, $21);
		  $10 = ((($33 | 0) / 2 | 0) - $4 << 2) - -8192 | 0;
		  while (1) {
		   $8 = HEAP32[($17 + 24 | 0) + ($7 << 2) >> 2];
		   memmove($8, ($4 << 2) + $8 | 0, $10);
		   $7 = $7 + 1 | 0;
		   if (($22 | 0) != ($7 | 0)) {
		    continue;
		   }
		   break;
		  }
		  $8 = Math_imul($14, $21);
		  $7 = $41 - ($8 + 15 & -16) | 0;
		  __stack_pointer = $7;
		  $10 = $7 - ((Math_imul($4, $21) << 2) + 15 & -16) | 0;
		  __stack_pointer = $10;
		  quant_all_bands(0, $12, $18, $13, $10, ($21 | 0) == 2 ? ($4 << 2) + $10 | 0 : 0, $7, 0, $19, $36, $43, HEAP32[$17 + 8 >> 2], HEAP32[$17 + 12 >> 2], $32, $37 - $15 | 0, HEAP32[$17 + 4 >> 2], $5, $9, $2, $0 + 40 | 0, 0, HEAP32[$0 + 36 >> 2], HEAP32[$0 + 32 >> 2]);
		  label$40 : {
		   if ($23) {
		    $15 = ec_dec_bits($5, 1);
		    unquant_energy_finalise($12, $18, $13, $16, $11, $1, (($24 - HEAP32[$5 + 20 >> 2] | 0) - Math_clz32(HEAP32[$5 + 28 >> 2]) | 0) + 32 | 0, $5, $21);
		    if (!$15) {
		     break label$40;
		    }
		    anti_collapse($12, $10, $7, $9, $21, $4, $18, $13, $16, $26, $30, $19, HEAP32[$0 + 40 >> 2], HEAP32[$0 + 36 >> 2]);
		    break label$40;
		   }
		   unquant_energy_finalise($12, $18, $13, $16, $11, $1, (($24 - HEAP32[$5 + 20 >> 2] | 0) - Math_clz32(HEAP32[$5 + 28 >> 2]) | 0) + 32 | 0, $5, $21);
		  }
		  if (!($45 ^ 1 | ($8 | 0) < 1)) {
		   $7 = 0;
		   while (1) {
		    HEAP32[($7 << 2) + $16 >> 2] = -1042284544;
		    $7 = $7 + 1 | 0;
		    if (($8 | 0) != ($7 | 0)) {
		     continue;
		    }
		    break;
		   }
		  }
		  celt_synthesis($12, $10, $17 + 16 | 0, $16, $18, $34, $21, $29, $28, $9, HEAP32[$0 + 16 >> 2], $31, HEAP32[$0 + 36 >> 2]);
		  $7 = 0;
		  while (1) {
		   $8 = HEAP32[$0 + 60 >> 2];
		   $10 = ($8 | 0) > 15 ? $8 : 15;
		   HEAP32[$0 + 60 >> 2] = $10;
		   $8 = HEAP32[$0 + 64 >> 2];
		   $11 = ($8 | 0) > 15 ? $8 : 15;
		   HEAP32[$0 + 64 >> 2] = $11;
		   $8 = HEAP32[($17 + 16 | 0) + ($7 << 2) >> 2];
		   comb_filter($8, $8, $11, $10, HEAP32[$12 + 44 >> 2], HEAPF32[$0 + 72 >> 2], HEAPF32[$0 + 68 >> 2], HEAP32[$0 + 80 >> 2], HEAP32[$0 + 76 >> 2], HEAP32[$12 + 60 >> 2], $33, HEAP32[$0 + 36 >> 2]);
		   if ($9) {
		    $10 = HEAP32[$12 + 44 >> 2];
		    $8 = ($10 << 2) + $8 | 0;
		    comb_filter($8, $8, HEAP32[$0 + 60 >> 2], $39, $4 - $10 | 0, HEAPF32[$0 + 68 >> 2], $20, HEAP32[$0 + 76 >> 2], $38, HEAP32[$12 + 60 >> 2], $33, HEAP32[$0 + 36 >> 2]);
		   }
		   $7 = $7 + 1 | 0;
		   if (($22 | 0) != ($7 | 0)) {
		    continue;
		   }
		   break;
		  }
		  HEAP32[$0 + 64 >> 2] = HEAP32[$0 + 60 >> 2];
		  $7 = HEAP32[$0 + 68 >> 2];
		  HEAPF32[$0 + 68 >> 2] = $20;
		  HEAP32[$0 + 72 >> 2] = $7;
		  $7 = HEAP32[$0 + 76 >> 2];
		  HEAP32[$0 + 76 >> 2] = $38;
		  HEAP32[$0 + 80 >> 2] = $7;
		  HEAP32[$0 + 60 >> 2] = $39;
		  if ($9) {
		   HEAP32[$0 + 80 >> 2] = $38;
		   HEAPF32[$0 + 72 >> 2] = $20;
		   HEAP32[$0 + 64 >> 2] = $39;
		  }
		  if (($21 | 0) == 1) {
		   $9 = $14 << 2;
		   memcpy($16 + $9 | 0, $16, $9);
		  }
		  label$48 : {
		   if ($28) {
		    if (($14 | 0) < 1) {
		     break label$48;
		    }
		    $8 = ($35 | 0) > 1 ? $35 : 1;
		    $9 = 0;
		    while (1) {
		     $7 = $9 << 2;
		     $22 = $26 + $7 | 0;
		     $20 = HEAPF32[$22 >> 2];
		     $27 = HEAPF32[$7 + $16 >> 2];
		     HEAPF32[$22 >> 2] = $20 < $27 ? $20 : $27;
		     $9 = $9 + 1 | 0;
		     if (($9 | 0) != ($8 | 0)) {
		      continue;
		     }
		     break;
		    }
		    break label$48;
		   }
		   $9 = $14 << 3;
		   memcpy($30, $26, $9);
		   memcpy($26, $16, $9);
		   if (($14 | 0) < 1) {
		    break label$48;
		   }
		   $51 = HEAP32[$0 + 52 >> 2] < 10 ? Math_fround(Math_fround($42 | 0) * Math_fround(.0010000000474974513)) : Math_fround(1);
		   $8 = ($35 | 0) > 1 ? $35 : 1;
		   $9 = 0;
		   while (1) {
		    $7 = $9 << 2;
		    $22 = $44 + $7 | 0;
		    $20 = Math_fround($51 + HEAPF32[$22 >> 2]);
		    $27 = HEAPF32[$7 + $16 >> 2];
		    HEAPF32[$22 >> 2] = $20 < $27 ? $20 : $27;
		    $9 = $9 + 1 | 0;
		    if (($9 | 0) != ($8 | 0)) {
		     continue;
		    }
		    break;
		   }
		  }
		  $9 = 0;
		  if (($18 | 0) > 0) {
		   while (1) {
		    $7 = $9 << 2;
		    HEAP32[$16 + $7 >> 2] = 0;
		    HEAP32[$7 + $30 >> 2] = -1042284544;
		    HEAP32[$7 + $26 >> 2] = -1042284544;
		    $9 = $9 + 1 | 0;
		    if (($18 | 0) != ($9 | 0)) {
		     continue;
		    }
		    break;
		   }
		  }
		  if (($13 | 0) < ($14 | 0)) {
		   $9 = $13;
		   while (1) {
		    $7 = $9 << 2;
		    HEAP32[$16 + $7 >> 2] = 0;
		    HEAP32[$7 + $30 >> 2] = -1042284544;
		    HEAP32[$7 + $26 >> 2] = -1042284544;
		    $9 = $9 + 1 | 0;
		    if (($14 | 0) != ($9 | 0)) {
		     continue;
		    }
		    break;
		   }
		  }
		  $9 = 0;
		  if (($18 | 0) > 0) {
		   while (1) {
		    $7 = $9 + $14 << 2;
		    HEAP32[$16 + $7 >> 2] = 0;
		    HEAP32[$7 + $30 >> 2] = -1042284544;
		    HEAP32[$7 + $26 >> 2] = -1042284544;
		    $9 = $9 + 1 | 0;
		    if (($18 | 0) != ($9 | 0)) {
		     continue;
		    }
		    break;
		   }
		  }
		  if (($13 | 0) < ($14 | 0)) {
		   while (1) {
		    $9 = $13 + $14 << 2;
		    HEAP32[$16 + $9 >> 2] = 0;
		    HEAP32[$9 + $30 >> 2] = -1042284544;
		    HEAP32[$9 + $26 >> 2] = -1042284544;
		    $13 = $13 + 1 | 0;
		    if (($14 | 0) != ($13 | 0)) {
		     continue;
		    }
		    break;
		   }
		  }
		  HEAP32[$0 + 40 >> 2] = HEAP32[$5 + 28 >> 2];
		  deemphasis($17 + 16 | 0, $3, $4, $29, HEAP32[$0 + 16 >> 2], $12 + 16 | 0, $0 + 84 | 0, $6);
		  HEAP32[$0 + 52 >> 2] = 0;
		  $10 = -3;
		  if (((HEAP32[$5 + 20 >> 2] + Math_clz32(HEAP32[$5 + 28 >> 2]) | 0) - 32 | 0) <= ($24 | 0)) {
		   if (HEAP32[$5 + 44 >> 2]) {
		    HEAP32[$0 + 44 >> 2] = 1;
		   }
		   $10 = ($4 | 0) / HEAP32[$0 + 16 >> 2] | 0;
		  }
		 }
		 __stack_pointer = $17 + 80 | 0;
		 return $10;
		}
		function clt_compute_allocation($0, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18) {
		 var $19 = 0, $20 = 0, $21 = 0, $22 = 0, $23 = 0, $24 = 0, $25 = 0, $26 = 0, $27 = 0, $28 = 0, $29 = 0, $30 = 0, $31 = 0, $32 = 0, $33 = 0, $34 = 0, $35 = 0, $36 = 0, $37 = 0, $38 = 0, $39 = 0, $40 = 0, $41 = 0, $42 = 0;
		 $19 = __stack_pointer;
		 $41 = $19;
		 $8 = ($8 | 0) > 0 ? $8 : 0;
		 $39 = (($8 | 0) > 7) << 3;
		 $33 = $8 - $39 | 0;
		 $37 = HEAP32[$0 + 8 >> 2];
		 label$1 : {
		  if (($13 | 0) != 2) {
		   break label$1;
		  }
		  $35 = HEAPU8[($2 - $1 | 0) + 24880 | 0];
		  if (($35 | 0) > ($33 | 0)) {
		   $35 = 0;
		   break label$1;
		  }
		  $8 = $33 - $35 | 0;
		  $36 = (($8 | 0) > 7) << 3;
		  $33 = $8 - $36 | 0;
		 }
		 $8 = ($37 << 2) + 15 & -16;
		 $23 = $19 - $8 | 0;
		 $19 = $23;
		 __stack_pointer = $19;
		 $30 = $19 - $8 | 0;
		 $19 = $30;
		 __stack_pointer = $19;
		 $27 = $19 - $8 | 0;
		 $19 = $27;
		 __stack_pointer = $19;
		 $28 = $13 << 3;
		 $34 = $19 - $8 | 0;
		 __stack_pointer = $34;
		 $38 = ($1 | 0) >= ($2 | 0);
		 if (!$38) {
		  $25 = $14 + 3 | 0;
		  $24 = Math_imul(($5 - $14 | 0) - 5 | 0, $13);
		  $26 = HEAP32[$0 + 32 >> 2];
		  $20 = HEAPU16[$26 + ($1 << 1) >> 1];
		  $8 = $1;
		  while (1) {
		   $5 = $20 << 16;
		   $21 = $8 << 2;
		   $19 = $8 + 1 | 0;
		   $20 = HEAP16[($19 << 1) + $26 >> 1];
		   $5 = $20 - ($5 >> 16) | 0;
		   $22 = Math_imul($5, 3) << $14 << 3 >> 4;
		   HEAP32[$27 + $21 >> 2] = ($22 | 0) < ($28 | 0) ? $28 : $22;
		   HEAP32[$21 + $34 >> 2] = (Math_imul(Math_imul(($8 ^ -1) + $2 | 0, $24), $5) << $25 >> 6) - ($5 << $14 == 1 ? $28 : 0);
		   $8 = $19;
		   if (($2 | 0) != ($19 | 0)) {
		    continue;
		   }
		   break;
		  }
		 }
		 $40 = HEAP32[$0 + 48 >> 2];
		 $32 = $40 - 1 | 0;
		 $29 = 1;
		 label$6 : {
		  while (1) {
		   $31 = $29 + $32 >> 1;
		   if (!$38) {
		    $25 = Math_imul($31, $37);
		    $24 = HEAP32[$0 + 32 >> 2];
		    $21 = HEAPU16[$24 + ($2 << 1) >> 1];
		    $26 = HEAP32[$0 + 52 >> 2];
		    $20 = 0;
		    $8 = $2;
		    $22 = 0;
		    while (1) {
		     $5 = $21 << 16 >> 16;
		     $8 = $8 - 1 | 0;
		     $21 = HEAP16[($8 << 1) + $24 >> 1];
		     $5 = Math_imul(Math_imul($5 - $21 | 0, $13), HEAPU8[($8 + $25 | 0) + $26 | 0]) << $14;
		     $19 = $5 >> 2;
		     $22 = !$22;
		     if (($5 | 0) >= 4) {
		      $19 = HEAP32[($8 << 2) + $34 >> 2] + $19 | 0;
		      $19 = ($19 | 0) > 0 ? $19 : 0;
		     }
		     $5 = $8 << 2;
		     $19 = HEAP32[$5 + $3 >> 2] + $19 | 0;
		     label$11 : {
		      if (!(($19 | 0) < HEAP32[$5 + $27 >> 2] ? $22 : 0)) {
		       $5 = HEAP32[$4 + $5 >> 2];
		       $19 = ($5 | 0) > ($19 | 0) ? $19 : $5;
		       $22 = 1;
		       break label$11;
		      }
		      $19 = ($19 | 0) < ($28 | 0) ? 0 : $28;
		      $22 = 0;
		     }
		     $20 = $20 + $19 | 0;
		     if (($1 | 0) < ($8 | 0)) {
		      continue;
		     }
		     break;
		    }
		    $8 = ($20 | 0) > ($33 | 0);
		    $29 = $8 ? $29 : $31 + 1 | 0;
		    $32 = $8 ? $31 - 1 | 0 : $32;
		    if (($29 | 0) <= ($32 | 0)) {
		     continue;
		    }
		    $31 = $1;
		    if ($38) {
		     break label$6;
		    }
		    $42 = Math_imul($29, $37);
		    $26 = Math_imul($29 - 1 | 0, $37);
		    $32 = HEAP32[$0 + 32 >> 2];
		    $25 = HEAPU16[$32 + ($1 << 1) >> 1];
		    $24 = HEAP32[$0 + 52 >> 2];
		    $8 = $1;
		    $31 = $8;
		    while (1) {
		     $19 = $25 << 16;
		     $5 = $8 + 1 | 0;
		     $25 = HEAP16[($5 << 1) + $32 >> 1];
		     $19 = Math_imul($25 - ($19 >> 16) | 0, $13);
		     $20 = Math_imul($19, HEAPU8[($8 + $26 | 0) + $24 | 0]) << $14;
		     if (($29 | 0) >= ($40 | 0)) {
		      $19 = HEAP32[($8 << 2) + $4 >> 2];
		     } else {
		      $19 = Math_imul(HEAPU8[($8 + $42 | 0) + $24 | 0], $19) << $14 >> 2;
		     }
		     $21 = $20 >> 2;
		     if (($20 | 0) >= 4) {
		      $20 = HEAP32[($8 << 2) + $34 >> 2] + $21 | 0;
		      $21 = ($20 | 0) > 0 ? $20 : 0;
		     }
		     if (($19 | 0) >= 1) {
		      $19 = HEAP32[($8 << 2) + $34 >> 2] + $19 | 0;
		      $19 = ($19 | 0) > 0 ? $19 : 0;
		     }
		     $20 = $8 << 2;
		     $22 = HEAP32[$20 + $3 >> 2];
		     $21 = (($29 | 0) > 1 ? $22 : 0) + $21 | 0;
		     HEAP32[$20 + $23 >> 2] = $21;
		     $19 = ($19 - $21 | 0) + $22 | 0;
		     HEAP32[$20 + $30 >> 2] = ($19 | 0) > 0 ? $19 : 0;
		     $31 = ($22 | 0) > 0 ? $8 : $31;
		     $8 = $5;
		     if (($8 | 0) != ($2 | 0)) {
		      continue;
		     }
		     break;
		    }
		    break label$6;
		   }
		   $8 = ($33 | 0) < 0;
		   $29 = $8 ? $29 : $31 + 1 | 0;
		   $32 = $8 ? $31 - 1 | 0 : $32;
		   if (($29 | 0) <= ($32 | 0)) {
		    continue;
		   }
		   break;
		  }
		  $31 = $1;
		 }
		 $3 = ($13 | 0) > 1;
		 $24 = 64;
		 $25 = 0;
		 $26 = 0;
		 while (1) {
		  label$20 : {
		   $22 = $24 + $25 >> 1;
		   $5 = $2;
		   $20 = 0;
		   $21 = 0;
		   if (!$38) {
		    while (1) {
		     $5 = $5 - 1 | 0;
		     $8 = $5 << 2;
		     $19 = (Math_imul(HEAP32[$30 + $8 >> 2], $22) >> 6) + HEAP32[$8 + $23 >> 2] | 0;
		     label$23 : {
		      if (!(($19 | 0) < HEAP32[$8 + $27 >> 2] ? !$21 : 0)) {
		       $8 = HEAP32[$4 + $8 >> 2];
		       $8 = ($8 | 0) > ($19 | 0) ? $19 : $8;
		       $21 = 1;
		       break label$23;
		      }
		      $8 = ($19 | 0) < ($28 | 0) ? 0 : $28;
		      $21 = 0;
		     }
		     $20 = $20 + $8 | 0;
		     if (($1 | 0) < ($5 | 0)) {
		      continue;
		     }
		     break;
		    }
		    $8 = ($20 | 0) > ($33 | 0);
		    $25 = $8 ? $25 : $22;
		    $24 = $8 ? $22 : $24;
		    $26 = $26 + 1 | 0;
		    if (($26 | 0) != 6) {
		     continue;
		    }
		    $8 = 0;
		    $20 = $2;
		    $21 = 0;
		    while (1) {
		     $20 = $20 - 1 | 0;
		     $19 = $20 << 2;
		     $5 = HEAP32[$19 + $23 >> 2] + (Math_imul(HEAP32[$19 + $30 >> 2], $25) >> 6) | 0;
		     $22 = ($5 | 0) >= HEAP32[$19 + $27 >> 2];
		     $24 = $19 + $10 | 0;
		     $5 = $21 ? $5 : $22 ? $5 : ($5 | 0) < ($28 | 0) ? 0 : $28;
		     $19 = HEAP32[$4 + $19 >> 2];
		     $19 = ($5 | 0) < ($19 | 0) ? $5 : $19;
		     HEAP32[$24 >> 2] = $19;
		     $8 = $8 + $19 | 0;
		     $21 = $21 | $22;
		     if (($1 | 0) < ($20 | 0)) {
		      continue;
		     }
		     break;
		    }
		    break label$20;
		   }
		   $8 = 0;
		   $19 = ($33 | 0) < 0;
		   $25 = $19 ? $25 : $22;
		   $24 = $19 ? $22 : $24;
		   $26 = $26 + 1 | 0;
		   if (($26 | 0) != 6) {
		    continue;
		   }
		  }
		  break;
		 }
		 $22 = $2 - 1 | 0;
		 label$27 : {
		  label$28 : {
		   if (($31 | 0) >= ($22 | 0)) {
		    $5 = $2;
		    $19 = $35;
		    break label$28;
		   }
		   $32 = $1 + 2 | 0;
		   $30 = $28 + 8 | 0;
		   $21 = $2;
		   while (1) {
		    $19 = HEAP32[$0 + 32 >> 2];
		    $20 = HEAP16[$19 + ($21 << 1) >> 1];
		    $5 = $22;
		    $25 = HEAP16[($5 << 1) + $19 >> 1];
		    $29 = $20 - $25 | 0;
		    $34 = $5 << 2;
		    $22 = $34 + $10 | 0;
		    $23 = HEAP32[$22 >> 2];
		    $24 = $33 - $8 | 0;
		    $19 = HEAP16[($1 << 1) + $19 >> 1];
		    $26 = ($24 >>> 0) / ($20 - $19 >>> 0) | 0;
		    $19 = Math_imul($19 - $20 | 0, $26) + $24 + ($19 - $25) | 0;
		    $20 = ($23 + Math_imul($29, $26) | 0) + (($19 | 0) > 0 ? $19 : 0) | 0;
		    $19 = HEAP32[$27 + $34 >> 2];
		    if (($20 | 0) >= ((($19 | 0) > ($30 | 0) ? $19 : $30) | 0)) {
		     label$32 : {
		      {
		       if (!ec_dec_bit_logp($15, 1)) {
		        break label$32;
		       }
		      }
		      $5 = $21;
		      $19 = $35;
		      break label$27;
		     }
		     $20 = $20 - 8 | 0;
		     $23 = HEAP32[$22 >> 2];
		     $8 = $8 + 8 | 0;
		    }
		    $19 = $35;
		    if (($19 | 0) >= 1) {
		     $19 = HEAPU8[($5 - $1 | 0) + 24880 | 0];
		    }
		    $20 = ($20 | 0) < ($28 | 0) ? 0 : $28;
		    HEAP32[$22 >> 2] = $20;
		    $8 = (($8 - ($23 + $35 | 0) | 0) + $20 | 0) + $19 | 0;
		    $35 = $19;
		    $21 = $5;
		    $22 = $21 - 1 | 0;
		    if (($31 | 0) < ($22 | 0)) {
		     continue;
		    }
		    break;
		   }
		  }
		  $33 = $33 + $39 | 0;
		 }
		 label$38 : {
		  label$39 : {
		   label$40 : {
		    if (($1 | 0) < ($5 | 0)) {
		     label$42 : {
		      label$43 : {
		       label$44 : {
		        label$45 : {
		         $17 = $36;
		         {
		          if (($19 | 0) >= 1) {
		           {
		            break label$45;
		           }
		          }
		          HEAP32[$6 >> 2] = 0;
		          $19 = 0;
		         }
		         $20 = ($19 | 0) > ($1 | 0);
		         $19 = $20 ? 0 : $17;
		         if (!$36 | !$20) {
		          break label$43;
		         }
		         {
		          break label$44;
		         }
		        }
		        $19 = ec_dec_uint($15, ($5 - $1 | 0) + 1 | 0) + $1 | 0;
		        HEAP32[$6 >> 2] = $19;
		        $20 = ($1 | 0) < ($19 | 0);
		        $19 = $20 ? 0 : $36;
		        if (!$36 | !$20) {
		         break label$43;
		        }
		       }
		       HEAP32[$7 >> 2] = ec_dec_bit_logp($15, 1);
		       break label$42;
		      }
		      HEAP32[$7 >> 2] = 0;
		     }
		     $31 = $14 << 3;
		     $22 = HEAP32[$0 + 32 >> 2];
		     $30 = HEAP16[$22 + ($1 << 1) >> 1];
		     $25 = ($33 - $8 | 0) + $19 | 0;
		     $20 = HEAP16[($5 << 1) + $22 >> 1];
		     $23 = ($25 >>> 0) / ($20 - $30 >>> 0) | 0;
		     $24 = Math_imul($23, $30 - $20 | 0);
		     $20 = $30;
		     $8 = $1;
		     while (1) {
		      $21 = $20 << 16;
		      $27 = ($8 << 2) + $10 | 0;
		      $19 = $8 + 1 | 0;
		      $20 = HEAP16[($19 << 1) + $22 >> 1];
		      HEAP32[$27 >> 2] = HEAP32[$27 >> 2] + Math_imul($20 - ($21 >> 16) | 0, $23);
		      $8 = $19;
		      if (($5 | 0) != ($19 | 0)) {
		       continue;
		      }
		      break;
		     }
		     $8 = $24 + $25 | 0;
		     $21 = $30;
		     $19 = $1;
		     while (1) {
		      $27 = $21 << 16;
		      $23 = ($19 << 2) + $10 | 0;
		      $20 = $19 + 1 | 0;
		      $21 = HEAP16[($20 << 1) + $22 >> 1];
		      $19 = $21 - ($27 >> 16) | 0;
		      $19 = ($8 | 0) < ($19 | 0) ? $8 : $19;
		      HEAP32[$23 >> 2] = $19 + HEAP32[$23 >> 2];
		      $8 = $8 - $19 | 0;
		      $19 = $20;
		      if (($19 | 0) != ($5 | 0)) {
		       continue;
		      }
		      break;
		     }
		     $29 = ($13 | 0) > 1 ? 4 : 3;
		     $27 = 0;
		     label$50 : {
		      while (1) {
		       if (($1 | 0) == ($5 | 0)) {
		        break label$50;
		       }
		       $8 = $1 << 2;
		       $19 = $10 + $8 | 0;
		       $20 = HEAP32[$19 >> 2];
		       if (($20 | 0) <= -1) {
		        break label$40;
		       }
		       $23 = $30 << 16;
		       $21 = $20 + $27 | 0;
		       $25 = $1 + 1 | 0;
		       $30 = HEAP16[($25 << 1) + $22 >> 1];
		       $23 = $30 - ($23 >> 16) << $14;
		       label$52 : {
		        if (($23 | 0) >= 2) {
		         $26 = 0;
		         $20 = $21 - HEAP32[$4 + $8 >> 2] | 0;
		         $20 = ($20 | 0) > 0 ? $20 : 0;
		         $24 = $21 - $20 | 0;
		         HEAP32[$19 >> 2] = $24;
		         $21 = Math_imul($13, $23);
		         if (!(HEAP32[$7 >> 2] | (($23 | 0) == 2 | ($13 | 0) != 2))) {
		          $26 = HEAP32[$6 >> 2] > ($1 | 0);
		         }
		         $21 = $21 + $26 | 0;
		         $26 = $21 << 3;
		         $15 = (($23 | 0) == 2 ? $26 >> 2 : 0) + Math_imul($21, -21) | 0;
		         $23 = Math_imul(HEAP16[HEAP32[$0 + 56 >> 2] + ($1 << 1) >> 1] + $31 | 0, $21);
		         $1 = $15 + ($23 >> 1) | 0;
		         $34 = $24 + $1 | 0;
		         label$55 : {
		          if (($34 | 0) < $21 << 4) {
		           $1 = ($23 >> 2) + $1 | 0;
		           break label$55;
		          }
		          if ((Math_imul($21, 24) | 0) <= ($34 | 0)) {
		           break label$55;
		          }
		          $1 = ($23 >> 3) + $1 | 0;
		         }
		         $23 = $8 + $11 | 0;
		         $24 = (($21 << 2) + $24 | 0) + $1 | 0;
		         $21 = ((($24 | 0) > 0 ? $24 : 0) >>> 0) / ($21 >>> 0) >>> 3 | 0;
		         HEAP32[$23 >> 2] = $21;
		         $24 = HEAP32[$19 >> 2];
		         if ((Math_imul($13, $21) | 0) > $24 >> 3) {
		          $21 = $24 >> $3 >> 3;
		          HEAP32[$23 >> 2] = $21;
		         }
		         $21 = ($21 | 0) < 8 ? $21 : 8;
		         HEAP32[$23 >> 2] = $21;
		         HEAP32[$8 + $12 >> 2] = (HEAP32[$19 >> 2] + $1 | 0) <= (Math_imul($21, $26) | 0);
		         HEAP32[$19 >> 2] = HEAP32[$19 >> 2] - Math_imul(HEAP32[$23 >> 2], $28);
		         break label$52;
		        }
		        $1 = $21 - $28 | 0;
		        $20 = ($1 | 0) > 0 ? $1 : 0;
		        HEAP32[$19 >> 2] = $21 - $20;
		        HEAP32[$8 + $11 >> 2] = 0;
		        HEAP32[$8 + $12 >> 2] = 1;
		       }
		       if ($20) {
		        $1 = $8 + $11 | 0;
		        $15 = $1;
		        $21 = $20 >>> $29 | 0;
		        $1 = HEAP32[$1 >> 2];
		        $23 = 8 - $1 | 0;
		        $21 = ($21 | 0) < ($23 | 0) ? $21 : $23;
		        HEAP32[$15 >> 2] = $1 + $21;
		        $1 = Math_imul($21, $28);
		        HEAP32[$8 + $12 >> 2] = ($1 | 0) >= ($20 - $27 | 0);
		        $27 = $20 - $1 | 0;
		       } else {
		        $27 = 0;
		       }
		       if (HEAP32[$19 >> 2] <= -1) {
		        break label$39;
		       }
		       $1 = $25;
		       if (HEAP32[$8 + $11 >> 2] > -1) {
		        continue;
		       }
		       break;
		      }
		      celt_fatal(24984, 24941, 514);
		      abort();
		     }
		     HEAP32[$9 >> 2] = $27;
		     if (($2 | 0) > ($5 | 0)) {
		      $8 = $5;
		      while (1) {
		       $19 = $8 << 2;
		       $20 = $19 + $11 | 0;
		       $1 = $10 + $19 | 0;
		       $21 = HEAP32[$1 >> 2] >> $3 >> 3;
		       HEAP32[$20 >> 2] = $21;
		       if (HEAP32[$1 >> 2] != (Math_imul($21, $28) | 0)) {
		        break label$38;
		       }
		       HEAP32[$1 >> 2] = 0;
		       HEAP32[$12 + $19 >> 2] = HEAP32[$20 >> 2] < 1;
		       $8 = $8 + 1 | 0;
		       if (($8 | 0) != ($2 | 0)) {
		        continue;
		       }
		       break;
		      }
		     }
		     __stack_pointer = $41;
		     return $5;
		    }
		    celt_fatal(24904, 24941, 391);
		    abort();
		   }
		   celt_fatal(24953, 24941, 442);
		   abort();
		  }
		  celt_fatal(24953, 24941, 513);
		  abort();
		 }
		 celt_fatal(25016, 24941, 524);
		 abort();
		}
		function compute_theta($0, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10) {
		 var $11 = 0, $12 = 0, $13 = 0, $14 = 0, $15 = Math_fround(0), $16 = Math_fround(0), $17 = 0, $18 = 0, $19 = 0, $20 = 0, $21 = Math_fround(0), $22 = 0, $23 = 0, $24 = 0, $25 = 0;
		 $22 = HEAP32[$0 + 36 >> 2];
		 $14 = HEAP32[$0 + 28 >> 2];
		 $12 = HEAP32[$0 + 16 >> 2];
		 $23 = HEAP32[$0 >> 2];
		 $11 = 1;
		 $19 = HEAP32[$5 >> 2];
		 $24 = HEAP32[$0 + 8 >> 2];
		 $20 = HEAP32[$0 + 12 >> 2];
		 $8 = HEAP16[HEAP32[$24 + 56 >> 2] + ($20 << 1) >> 1] + ($8 << 3) | 0;
		 $13 = ($19 - $8 | 0) - 32 | 0;
		 $17 = $8 >> 1;
		 $8 = ($4 | 0) == 2 & ($9 | 0) != 0;
		 label$1 : {
		  label$2 : {
		   label$3 : {
		    label$4 : {
		     label$5 : {
		      label$6 : {
		       label$7 : {
		        label$8 : {
		         label$9 : {
		          label$10 : {
		           label$11 : {
		            label$12 : {
		             $17 = $17 + ($8 ? -16 : -4) | 0;
		             $8 = ($4 << 1) + ($8 ? -2 : -1) | 0;
		             $8 = (Math_imul($17, $8) + $19 | 0) / ($8 | 0) | 0;
		             $8 = ($8 | 0) > ($13 | 0) ? $13 : $8;
		             $8 = ($8 | 0) < 64 ? $8 : 64;
		             if (($8 | 0) >= 4) {
		              $11 = (HEAP16[(($8 & 7) << 1) + 33760 >> 1] >> 14 - ($8 >>> 3 | 0)) + 1 & -2;
		              if (($11 | 0) >= 257) {
		               break label$12;
		              }
		             }
		             $11 = ($12 | 0) > ($20 | 0) ? $11 : $9 ? 1 : $11;
		             label$14 : {
		              label$15 : {
		               label$16 : {
		                if ($23) {
		                 $8 = stereo_itheta($2, $3, $9, $4, HEAP32[$0 + 44 >> 2]);
		                 $19 = ec_tell_frac($14);
		                 if (($11 | 0) == 1) {
		                  break label$14;
		                 }
		                 label$18 : {
		                  label$19 : {
		                   if ($9) {
		                    $0 = HEAP32[$0 + 48 >> 2];
		                    if ($0) {
		                     break label$19;
		                    }
		                    $0 = Math_imul($8, $11) - -8192 >> 14;
		                    break label$18;
		                   }
		                   $8 = Math_imul($8, $11);
		                   $13 = $8 - -8192 | 0;
		                   $12 = $13 >> 14;
		                   label$21 : {
		                    if (($12 | 0) >= ($11 | 0)) {
		                     $0 = $12;
		                     break label$21;
		                    }
		                    if (($8 | 0) < 8192) {
		                     $0 = $12;
		                     break label$21;
		                    }
		                    if (!HEAP32[$0 + 56 >> 2]) {
		                     $0 = $12;
		                     break label$21;
		                    }
		                    $0 = $11;
		                    $13 = (($13 & -16384) >>> 0) / ($0 >>> 0) << 16;
		                    $8 = Math_imul($13 >> 13, $13 >> 16) + 32768 >> 16;
		                    $18 = ((Math_imul($8, ((Math_imul((Math_imul($8, -626) + 16384 >> 15) + 8277 | 0, $8) << 1) + 32768 & -65536) - 501415936 >> 16) + 16384 >>> 15 | 0) - $8 << 16) - -2147483648 >> 16;
		                    $17 = Math_clz32($18);
		                    $8 = 1073741824 - $13 | 0;
		                    $8 = Math_imul($8 >> 13, $8 >> 16) + 32768 >> 16;
		                    $8 = ((Math_imul($8, ((Math_imul((Math_imul($8, -626) + 16384 >> 15) + 8277 | 0, $8) << 1) + 32768 & -65536) - 501415936 >> 16) + 16384 >>> 15 | 0) - $8 << 16) - -2147483648 >> 16;
		                    $13 = Math_clz32($8);
		                    $18 = $18 << $17 - 17 << 16 >> 16;
		                    $8 = $8 << $13 - 17 << 16 >> 16;
		                    $8 = Math_imul(($17 - $13 << 11) - (Math_imul($18, (Math_imul($18, -2597) + 16384 >> 15) + 7932 | 0) + 16384 >>> 15 | 0) + (Math_imul($8, (Math_imul($8, -2597) + 16384 >> 15) + 7932 | 0) + 16384 >>> 15) << 16 >> 16, ($4 << 23) - 8388608 >> 16) + 16384 >> 15;
		                    $13 = HEAP32[$5 >> 2];
		                    if (($8 | 0) > ($13 | 0)) {
		                     break label$21;
		                    }
		                    $0 = (0 - $13 | 0) > ($8 | 0) ? 0 : $12;
		                   }
		                   if (($7 | 0) < 2) {
		                    break label$16;
		                   }
		                   break label$9;
		                  }
		                  $8 = Math_imul($8, $11) + (((($8 | 0) > 8192 ? 32767 : -32767) | 0) / ($11 | 0) | 0) | 0;
		                  $8 = ($8 | 0) < 0 ? 0 : $8 >> 14;
		                  $0 = (($0 ^ -1) >>> 31 | 0) + (($8 | 0) < ($11 | 0) ? $8 : $11 - 1 | 0) | 0;
		                 }
		                 if (($4 | 0) <= 2) {
		                  break label$9;
		                 }
		                 $8 = ($11 | 0) / 2 | 0;
		                 $12 = Math_imul($8, 3) + 3 | 0;
		                 $13 = Math_imul($0, 3);
		                 $7 = ($0 | 0) > ($8 | 0);
		                 ec_encode($14, $7 ? ($12 + ($8 ^ -1) | 0) + $0 | 0 : $13, $7 ? ($12 - $8 | 0) + $0 | 0 : $13 + 3 | 0, $8 + $12 | 0);
		                 break label$8;
		                }
		                $19 = ec_tell_frac($14);
		                if (($11 | 0) == 1) {
		                 break label$11;
		                }
		                if (!(!$9 | ($4 | 0) < 3)) {
		                 $17 = $14;
		                 $8 = ($11 | 0) / 2 | 0;
		                 $7 = $8 + 1 | 0;
		                 $12 = Math_imul($7, 3);
		                 $13 = $8 + $12 | 0;
		                 $0 = ec_decode($14, $13);
		                 label$26 : {
		                  if (($12 | 0) > ($0 | 0)) {
		                   $0 = ($0 | 0) / 3 | 0;
		                   break label$26;
		                  }
		                  $0 = $0 - ($7 << 1) | 0;
		                 }
		                 $7 = Math_imul($0, 3);
		                 $18 = ($0 | 0) > ($8 | 0);
		                 ec_dec_update($17, $18 ? (($8 ^ -1) + $12 | 0) + $0 | 0 : $7, $18 ? ($12 - $8 | 0) + $0 | 0 : $7 + 3 | 0, $13);
		                 break label$8;
		                }
		                if ($9 ? 0 : ($7 | 0) <= 1) {
		                 break label$15;
		                }
		                $0 = ec_dec_uint($14, $11 + 1 | 0);
		                break label$8;
		               }
		               $18 = $11 - $0 | 0;
		               $17 = $18 + 1 | 0;
		               $25 = $0 + 1 | 0;
		               $8 = $11 >> 1;
		               $13 = ($8 | 0) < ($0 | 0);
		               $7 = $13 ? $17 : $25;
		               $8 = $8 + 1 | 0;
		               $12 = Math_imul($8, $8);
		               $8 = $13 ? $12 - (Math_imul($18 + 2 | 0, $17) >> 1) | 0 : Math_imul($0, $25) >> 1;
		               ec_encode($14, $8, $7 + $8 | 0, $12);
		               break label$8;
		              }
		              $7 = $14;
		              $2 = $11 >> 1;
		              $9 = $2 + 1 | 0;
		              $3 = Math_imul($9, $9);
		              $0 = ec_decode($14, $3);
		              label$30 : {
		               if (($0 | 0) < Math_imul($2, $9) >> 1) {
		                $9 = isqrt32($0 << 3 | 1) - 1 >>> 1 | 0;
		                $0 = $9 + 1 | 0;
		                $2 = Math_imul($0, $9) >>> 1 | 0;
		                break label$30;
		               }
		               $9 = $11 + 1 | 0;
		               $2 = $9;
		               $9 = ($9 << 1) - isqrt32(($0 ^ -1) + $3 << 3 | 1) >>> 1 | 0;
		               $0 = $2 - $9 | 0;
		               $2 = $3 - (Math_imul($0, ($11 - $9 | 0) + 2 | 0) >> 1) | 0;
		              }
		              ec_dec_update($7, $2, $0 + $2 | 0, $3);
		              $8 = ($9 << 14 >>> 0) / ($11 >>> 0) | 0;
		              break label$5;
		             }
		             if (!$9) {
		              break label$5;
		             }
		             $9 = 0;
		             $12 = 0;
		             label$32 : {
		              if (($8 | 0) < 8193) {
		               break label$32;
		              }
		              $11 = HEAP32[$0 + 52 >> 2];
		              if ($11) {
		               break label$32;
		              }
		              $12 = 1;
		              if (($4 | 0) < 1) {
		               break label$32;
		              }
		              $12 = !$11;
		              $11 = 0;
		              while (1) {
		               $8 = ($11 << 2) + $3 | 0;
		               HEAPF32[$8 >> 2] = -HEAPF32[$8 >> 2];
		               $11 = $11 + 1 | 0;
		               if (($11 | 0) != ($4 | 0)) {
		                continue;
		               }
		               break;
		              }
		             }
		             if (($4 | 0) < 1) {
		              break label$10;
		             }
		             $15 = HEAPF32[($20 << 2) + $22 >> 2];
		             $16 = HEAPF32[(HEAP32[$24 + 8 >> 2] + $20 << 2) + $22 >> 2];
		             $21 = Math_fround(Math_fround(Math_sqrt(Math_fround(Math_fround(Math_fround($15 * $15) + Math_fround(1.0000000036274937e-15)) + Math_fround($16 * $16)))) + Math_fround(1.0000000036274937e-15));
		             $16 = Math_fround($16 / $21);
		             $15 = Math_fround($15 / $21);
		             while (1) {
		              $11 = $9 << 2;
		              $8 = $11 + $2 | 0;
		              HEAPF32[$8 >> 2] = Math_fround($15 * HEAPF32[$8 >> 2]) + Math_fround($16 * HEAPF32[$3 + $11 >> 2]);
		              $9 = $9 + 1 | 0;
		              if (($9 | 0) != ($4 | 0)) {
		               continue;
		              }
		              break;
		             }
		             break label$10;
		            }
		            celt_fatal(33776, 33495, 669);
		            abort();
		           }
		           $12 = 0;
		           if (!$9) {
		            break label$7;
		           }
		          }
		          $4 = 0;
		          label$35 : {
		           if (HEAP32[$5 >> 2] < 17) {
		            break label$35;
		           }
		           $4 = 0;
		           if (HEAP32[$0 + 32 >> 2] < 17) {
		            break label$35;
		           }
		           if ($23) {
		            ec_enc_bit_logp($14, $12, 2);
		            $4 = $12;
		            break label$35;
		           }
		           $4 = ec_dec_bit_logp($14, 2);
		          }
		          $12 = HEAP32[$0 + 52 >> 2] ? 0 : $4;
		          break label$7;
		         }
		         ec_enc_uint($14, $0, $11 + 1 | 0);
		        }
		        if (($0 | 0) <= -1) {
		         break label$6;
		        }
		        $0 = $0 << 14;
		        $8 = ($0 >>> 0) / ($11 >>> 0) | 0;
		        if (!$9 | !$23) {
		         break label$5;
		        }
		        if ($0 >>> 0 < $11 >>> 0) {
		         $12 = 0;
		         if (($4 | 0) < 1) {
		          break label$7;
		         }
		         $15 = HEAPF32[($20 << 2) + $22 >> 2];
		         $16 = HEAPF32[(HEAP32[$24 + 8 >> 2] + $20 << 2) + $22 >> 2];
		         $21 = Math_fround(Math_fround(Math_sqrt(Math_fround(Math_fround(Math_fround($15 * $15) + Math_fround(1.0000000036274937e-15)) + Math_fround($16 * $16)))) + Math_fround(1.0000000036274937e-15));
		         $16 = Math_fround($16 / $21);
		         $15 = Math_fround($15 / $21);
		         $9 = 0;
		         while (1) {
		          $0 = $9 << 2;
		          $11 = $2 + $0 | 0;
		          HEAPF32[$11 >> 2] = Math_fround($15 * HEAPF32[$11 >> 2]) + Math_fround($16 * HEAPF32[$0 + $3 >> 2]);
		          $9 = $9 + 1 | 0;
		          if (($9 | 0) != ($4 | 0)) {
		           continue;
		          }
		          break;
		         }
		         break label$7;
		        }
		        if (($4 | 0) < 1) {
		         break label$5;
		        }
		        $9 = 0;
		        while (1) {
		         $0 = $9 << 2;
		         $11 = $2 + $0 | 0;
		         $16 = Math_fround(HEAPF32[$11 >> 2] * Math_fround(.7071067690849304));
		         $0 = $0 + $3 | 0;
		         $15 = Math_fround(HEAPF32[$0 >> 2] * Math_fround(.7071067690849304));
		         HEAPF32[$11 >> 2] = $16 + $15;
		         HEAPF32[$0 >> 2] = $15 - $16;
		         $9 = $9 + 1 | 0;
		         if (($9 | 0) != ($4 | 0)) {
		          continue;
		         }
		         break;
		        }
		        break label$5;
		       }
		       $4 = ec_tell_frac($14);
		       $0 = $4 - $19 | 0;
		       HEAP32[$5 >> 2] = HEAP32[$5 >> 2] - $0;
		       break label$4;
		      }
		      celt_fatal(33720, 33495, 838);
		      abort();
		     }
		     $9 = ec_tell_frac($14);
		     $0 = $9 - $19 | 0;
		     HEAP32[$5 >> 2] = HEAP32[$5 >> 2] - $0;
		     $9 = 16384;
		     if (($8 | 0) == 16384) {
		      break label$3;
		     }
		     if ($8) {
		      break label$2;
		     }
		     $12 = $8;
		    }
		    HEAP32[$10 >> 2] = HEAP32[$10 >> 2] & (-1 << $6 ^ -1);
		    $4 = -16384;
		    $3 = 32767;
		    $9 = 0;
		    $2 = 0;
		    break label$1;
		   }
		   HEAP32[$10 >> 2] = HEAP32[$10 >> 2] & (-1 << $6 ^ -1) << $6;
		   $2 = 32767;
		   $12 = 0;
		   $3 = 0;
		   $4 = 16384;
		   break label$1;
		  }
		  $2 = $8 << 16;
		  $9 = Math_imul($2 >> 13, $2 >> 16) + 32768 >> 16;
		  $3 = ((Math_imul($9, ((Math_imul((Math_imul($9, -626) + 16384 >> 15) + 8277 | 0, $9) << 1) + 32768 & -65536) - 501415936 >> 16) + 16384 >>> 15 | 0) - $9 << 16) - -2147483648 >> 16;
		  $11 = Math_clz32($3);
		  $9 = 1073741824 - $2 | 0;
		  $9 = Math_imul($9 >> 13, $9 >> 16) + 32768 >> 16;
		  $2 = ((Math_imul($9, ((Math_imul((Math_imul($9, -626) + 16384 >> 15) + 8277 | 0, $9) << 1) + 32768 & -65536) - 501415936 >> 16) + 16384 >>> 15 | 0) - $9 << 16) - -2147483648 >> 16;
		  $9 = Math_clz32($2);
		  $5 = $11 - $9 << 11;
		  $11 = $3 << $11 - 17 << 16 >> 16;
		  $9 = $2 << $9 - 17 << 16 >> 16;
		  $4 = Math_imul($5 - (Math_imul($11, (Math_imul($11, -2597) + 16384 >> 15) + 7932 | 0) + 16384 >>> 15 | 0) + (Math_imul($9, (Math_imul($9, -2597) + 16384 >> 15) + 7932 | 0) + 16384 >>> 15) << 16 >> 16, ($4 << 23) - 8388608 >> 16) + 16384 >> 15;
		  $12 = 0;
		  $9 = $8;
		 }
		 HEAP32[$1 + 20 >> 2] = $0;
		 HEAP32[$1 + 16 >> 2] = $9;
		 HEAP32[$1 + 12 >> 2] = $4;
		 HEAP32[$1 + 8 >> 2] = $2;
		 HEAP32[$1 + 4 >> 2] = $3;
		 HEAP32[$1 >> 2] = $12;
		}
		function silk_PLC_conceal($0, $1, $2, $3) {
		 var $4 = 0, $5 = 0, $6 = 0, $7 = 0, $8 = 0, $9 = 0, $10 = 0, $11 = 0, $12 = 0, $13 = 0, $14 = 0, $15 = 0, $16 = 0, $17 = 0, $18 = 0, $19 = 0, $20 = 0, $21 = 0, $22 = 0, $23 = 0, $24 = 0, $25 = 0, $26 = 0, $27 = 0, $28 = 0, $29 = 0, $30 = 0, $31 = 0, $32 = 0, $33 = 0, $34 = 0;
		 $4 = __stack_pointer + -64 | 0;
		 __stack_pointer = $4;
		 $16 = $4 - ((HEAP32[$0 + 2328 >> 2] + HEAP32[$0 + 2336 >> 2] << 2) + 15 & -16) | 0;
		 $5 = $16;
		 __stack_pointer = $5;
		 $11 = $5 - ((HEAP32[$0 + 2336 >> 2] << 1) + 15 & -16) | 0;
		 __stack_pointer = $11;
		 $9 = $4;
		 HEAP32[$4 + 8 >> 2] = HEAP32[$0 + 4244 >> 2] >> 6;
		 $26 = HEAP32[$0 + 4248 >> 2];
		 $27 = $26 >> 6;
		 HEAP32[$4 + 12 >> 2] = $27;
		 if (HEAP32[$0 + 2376 >> 2]) {
		  $5 = $0 + 4210 | 0;
		  HEAP16[$5 >> 1] = 0;
		  HEAP16[$5 + 2 >> 1] = 0;
		  HEAP16[$5 + 4 >> 1] = 0;
		  HEAP16[$5 + 6 >> 1] = 0;
		  $5 = $0 + 4202 | 0;
		  HEAP16[$5 >> 1] = 0;
		  HEAP16[$5 + 2 >> 1] = 0;
		  HEAP16[$5 + 4 >> 1] = 0;
		  HEAP16[$5 + 6 >> 1] = 0;
		  $5 = $0 + 4194 | 0;
		  HEAP16[$5 >> 1] = 0;
		  HEAP16[$5 + 2 >> 1] = 0;
		  HEAP16[$5 + 4 >> 1] = 0;
		  HEAP16[$5 + 6 >> 1] = 0;
		  $5 = $0 + 4186 | 0;
		  HEAP16[$5 >> 1] = 0;
		  HEAP16[$5 + 2 >> 1] = 0;
		  HEAP16[$5 + 4 >> 1] = 0;
		  HEAP16[$5 + 6 >> 1] = 0;
		 }
		 $8 = $0 + 4 | 0;
		 silk_PLC_energy($9 + 52 | 0, $9 + 60 | 0, $9 + 48 | 0, $9 + 56 | 0, $8, $9 + 8 | 0, HEAP32[$0 + 2332 >> 2], HEAP32[$0 + 2324 >> 2]);
		 $19 = HEAPU16[$0 + 4228 >> 1];
		 $20 = HEAP32[$0 + 4260 >> 2];
		 $24 = HEAP32[$0 + 4256 >> 2];
		 $5 = HEAP32[$0 + 4160 >> 2];
		 $7 = HEAP32[$0 + 4164 >> 2];
		 $15 = HEAP32[$9 + 56 >> 2];
		 $21 = HEAP32[$9 + 52 >> 2];
		 $17 = HEAP32[$9 + 60 >> 2];
		 $25 = HEAP32[$9 + 48 >> 2];
		 $6 = $0 + 4186 | 0;
		 silk_bwexpander($6, HEAP32[$0 + 2340 >> 2], 64881);
		 $4 = HEAP32[$0 + 2340 >> 2];
		 memcpy($9 + 16 | 0, $6, $4 << 1);
		 $22 = (($5 | 0) < 1 ? $5 : 1) << 1;
		 $10 = HEAP16[$22 + (($7 | 0) == 2 ? 2234 : 2238) >> 1];
		 label$2 : {
		  if (HEAP32[$0 + 4160 >> 2]) {
		   break label$2;
		  }
		  if (HEAP32[$0 + 4164 >> 2] == 2) {
		   $5 = 16384 - (HEAPU16[$0 + 4184 >> 1] + (HEAPU16[$0 + 4182 >> 1] + (HEAPU16[$0 + 4180 >> 1] + (HEAPU16[$0 + 4176 >> 1] + HEAPU16[$0 + 4178 >> 1] | 0) | 0) | 0) | 0) | 0;
		   $19 = Math_imul(HEAP16[$0 + 4240 >> 1], ($5 << 16 >> 16 > 3277 ? $5 : 3277) & 65535) >>> 14 | 0;
		   break label$2;
		  }
		  $4 = silk_LPC_inverse_pred_gain_c($6, $4);
		  $4 = ($4 | 0) < 134217728 ? $4 : 134217728;
		  $4 = ($4 | 0) > 4194304 ? $4 : 4194304;
		  $10 = (Math_imul($4 << 3 & 65528, $10) >> 16) + Math_imul($4 >>> 13 & 65535, $10) >> 14;
		  $4 = HEAP32[$0 + 2340 >> 2];
		  $19 = 16384;
		 }
		 $5 = HEAP32[$0 + 2336 >> 2];
		 $13 = (HEAP32[$0 + 4172 >> 2] >> 7) + 1 >> 1;
		 $6 = ($5 - $13 | 0) - $4 | 0;
		 if (($6 | 0) > 2) {
		  $29 = HEAP32[$0 + 4224 >> 2];
		  $6 = $6 - 2 | 0;
		  $7 = $6 << 1;
		  silk_LPC_analysis_filter($11 + $7 | 0, ($0 + $7 | 0) + 1348 | 0, $9 + 16 | 0, $5 - $6 | 0, $4, $3);
		  $4 = HEAP32[$0 + 4248 >> 2];
		  $3 = $4 >> 31;
		  $7 = $3 ^ $3 + $4;
		  $12 = Math_clz32($7);
		  $4 = $4 << $12 - 1;
		  $3 = $4 >> 16;
		  $14 = 536870911 / ($3 | 0) | 0;
		  $18 = ($14 >> 15) + 1 >> 1;
		  $23 = $4 & 65535;
		  $14 = $14 << 16;
		  $4 = $14 >> 16;
		  $3 = 0 - ((Math_imul($23, $4) >> 16) + Math_imul($3, $4) << 3) | 0;
		  $4 = ((Math_imul($3, $18) + $14 | 0) + Math_imul($3 >> 16, $4) | 0) + (Math_imul($3 & 65528, $4) >> 16) | 0;
		  $3 = 16 - $12 | 0;
		  label$5 : {
		   if ($7 >>> 0 <= 65535) {
		    $3 = 0 - $3 | 0;
		    $7 = 2147483647 >>> $3 | 0;
		    $12 = -2147483648 >> $3;
		    $3 = (($4 | 0) > ($7 | 0) ? $7 : ($4 | 0) < ($12 | 0) ? $12 : $4) << $3;
		    break label$5;
		   }
		   $3 = $4 >> $3;
		  }
		  $23 = HEAP32[$0 + 2340 >> 2];
		  $4 = $23 + $6 | 0;
		  $18 = HEAP32[$0 + 2336 >> 2];
		  if (($4 | 0) < ($18 | 0)) {
		   $6 = ($3 | 0) < 1073741823 ? $3 : 1073741823;
		   $3 = $6 & 65535;
		   $7 = $6 >> 16;
		   while (1) {
		    $6 = HEAP16[($4 << 1) + $11 >> 1];
		    HEAP32[($4 << 2) + $16 >> 2] = (Math_imul($6, $3) >> 16) + Math_imul($7, $6);
		    $4 = $4 + 1 | 0;
		    if (($18 | 0) > ($4 | 0)) {
		     continue;
		    }
		    break;
		   }
		  }
		  $28 = HEAP32[$0 + 2324 >> 2];
		  if (($28 | 0) >= 1) {
		   $4 = Math_imul($24 - ($21 >> $15 < $25 >> $17) | 0, $20);
		   $24 = (((($4 | 0) > 128 ? $4 : 128) << 2) + $8 | 0) - 512 | 0;
		   $15 = HEAP16[$22 + 2230 >> 1];
		   $21 = Math_imul(HEAP16[$0 + 2316 >> 1], 4608);
		   $25 = $10 << 16 >> 16;
		   $4 = HEAPU16[$0 + 4184 >> 1];
		   $3 = HEAPU16[$0 + 4182 >> 1];
		   $7 = HEAPU16[$0 + 4180 >> 1];
		   $10 = HEAPU16[$0 + 4178 >> 1];
		   $12 = HEAPU16[$0 + 4176 >> 1];
		   $20 = HEAP32[$0 + 2332 >> 2];
		   $22 = HEAPU8[$0 + 2765 | 0];
		   $17 = 0;
		   while (1) {
		    label$11 : {
		     if (($20 | 0) <= 0) {
		      $6 = $19 << 16 >> 16;
		      $11 = $4 << 16 >> 16;
		      $3 = $3 << 16 >> 16;
		      $7 = $7 << 16 >> 16;
		      $10 = $10 << 16 >> 16;
		      $12 = $12 << 16 >> 16;
		      break label$11;
		     }
		     $6 = $19 << 16 >> 16;
		     $11 = $4 << 16 >> 16;
		     $3 = $3 << 16 >> 16;
		     $7 = $7 << 16 >> 16;
		     $10 = $10 << 16 >> 16;
		     $12 = $12 << 16 >> 16;
		     $4 = (($5 - $13 << 2) + $16 | 0) + 8 | 0;
		     $14 = 0;
		     while (1) {
		      $8 = HEAP32[$4 >> 2];
		      $13 = Math_imul($8 >> 16, $12) + (Math_imul($8 & 65535, $12) >> 16) | 0;
		      $8 = HEAP32[$4 - 4 >> 2];
		      $13 = ($13 + Math_imul($8 >> 16, $10) | 0) + (Math_imul($8 & 65535, $10) >> 16) | 0;
		      $8 = HEAP32[$4 - 8 >> 2];
		      $13 = ($13 + Math_imul($8 >> 16, $7) | 0) + (Math_imul($8 & 65535, $7) >> 16) | 0;
		      $8 = HEAP32[$4 - 12 >> 2];
		      $13 = ($13 + Math_imul($8 >> 16, $3) | 0) + (Math_imul($8 & 65535, $3) >> 16) | 0;
		      $8 = HEAP32[$4 - 16 >> 2];
		      $13 = ($13 + Math_imul($8 >> 16, $11) | 0) + (Math_imul($8 & 65535, $11) >> 16) | 0;
		      $29 = Math_imul($29, 196314165) + 907633515 | 0;
		      $8 = HEAP32[($29 >>> 23 & 508) + $24 >> 2];
		      HEAP32[($5 << 2) + $16 >> 2] = (($13 + Math_imul($8 >> 16, $6) | 0) + (Math_imul($8 & 65535, $6) >> 16) << 2) + 8;
		      $5 = $5 + 1 | 0;
		      $4 = $4 + 4 | 0;
		      $14 = $14 + 1 | 0;
		      if (($20 | 0) != ($14 | 0)) {
		       continue;
		      }
		      break;
		     }
		    }
		    $4 = HEAP32[$0 + 4172 >> 2];
		    $4 = $4 + Math_imul($4 >> 16, 655) + (Math_imul($4 & 65535, 655) >>> 16) | 0;
		    $4 = ($4 | 0) < ($21 | 0) ? $4 : $21;
		    HEAP32[$0 + 4172 >> 2] = $4;
		    $13 = ($4 >> 7) + 1 >> 1;
		    $19 = $22 ? Math_imul($6, $25) >>> 15 | 0 : $19;
		    $4 = Math_imul($11, $15) >>> 15 | 0;
		    $3 = Math_imul($3, $15) >>> 15 | 0;
		    $7 = Math_imul($7, $15) >>> 15 | 0;
		    $10 = Math_imul($10, $15) >>> 15 | 0;
		    $12 = Math_imul($12, $15) >>> 15 | 0;
		    $17 = $17 + 1 | 0;
		    if (($28 | 0) != ($17 | 0)) {
		     continue;
		    }
		    break;
		   }
		   HEAP16[$0 + 4184 >> 1] = $4;
		   HEAP16[$0 + 4182 >> 1] = $3;
		   HEAP16[$0 + 4180 >> 1] = $7;
		   HEAP16[$0 + 4178 >> 1] = $10;
		   HEAP16[$0 + 4176 >> 1] = $12;
		  }
		  $5 = HEAP32[$0 + 1288 >> 2];
		  $6 = HEAP32[$0 + 1284 >> 2];
		  $3 = (($18 << 2) + $16 | 0) + -64 | 0;
		  HEAP32[$3 >> 2] = $6;
		  HEAP32[$3 + 4 >> 2] = $5;
		  $4 = $0 + 1340 | 0;
		  $5 = HEAP32[$4 >> 2];
		  $6 = HEAP32[$4 + 4 >> 2];
		  HEAP32[$3 + 56 >> 2] = $5;
		  HEAP32[$3 + 60 >> 2] = $6;
		  $4 = $0 + 1332 | 0;
		  $6 = HEAP32[$4 >> 2];
		  $5 = HEAP32[$4 + 4 >> 2];
		  HEAP32[$3 + 48 >> 2] = $6;
		  HEAP32[$3 + 52 >> 2] = $5;
		  $4 = $0 + 1324 | 0;
		  $5 = HEAP32[$4 >> 2];
		  $6 = HEAP32[$4 + 4 >> 2];
		  HEAP32[$3 + 40 >> 2] = $5;
		  HEAP32[$3 + 44 >> 2] = $6;
		  $4 = $0 + 1316 | 0;
		  $6 = HEAP32[$4 >> 2];
		  $5 = HEAP32[$4 + 4 >> 2];
		  HEAP32[$3 + 32 >> 2] = $6;
		  HEAP32[$3 + 36 >> 2] = $5;
		  $4 = $0 + 1308 | 0;
		  $5 = HEAP32[$4 >> 2];
		  $6 = HEAP32[$4 + 4 >> 2];
		  HEAP32[$3 + 24 >> 2] = $5;
		  HEAP32[$3 + 28 >> 2] = $6;
		  $4 = $0 + 1300 | 0;
		  $6 = HEAP32[$4 >> 2];
		  $5 = HEAP32[$4 + 4 >> 2];
		  HEAP32[$3 + 16 >> 2] = $6;
		  HEAP32[$3 + 20 >> 2] = $5;
		  $4 = $0 + 1292 | 0;
		  $5 = HEAP32[$4 >> 2];
		  $6 = HEAP32[$4 + 4 >> 2];
		  HEAP32[$3 + 8 >> 2] = $5;
		  HEAP32[$3 + 12 >> 2] = $6;
		  if (($23 | 0) >= 10) {
		   $30 = HEAP32[$0 + 2328 >> 2];
		   if (($30 | 0) >= 1) {
		    $31 = $23 >>> 1 | 0;
		    $20 = $27 << 16 >> 16;
		    $32 = ($26 >> 21) + 1 >> 1;
		    $5 = HEAP32[$3 + 28 >> 2];
		    $6 = HEAP32[$3 + 36 >> 2];
		    $11 = HEAP32[$3 + 44 >> 2];
		    $7 = HEAP32[$3 + 52 >> 2];
		    $4 = HEAP32[$3 + 60 >> 2];
		    $24 = HEAP16[$9 + 34 >> 1];
		    $15 = HEAP16[$9 + 32 >> 1];
		    $21 = HEAP16[$9 + 30 >> 1];
		    $17 = HEAP16[$9 + 28 >> 1];
		    $28 = HEAP16[$9 + 26 >> 1];
		    $25 = HEAP16[$9 + 24 >> 1];
		    $22 = HEAP16[$9 + 22 >> 1];
		    $18 = HEAP16[$9 + 20 >> 1];
		    $26 = HEAP16[$9 + 18 >> 1];
		    $27 = HEAP16[$9 + 16 >> 1];
		    $33 = ($23 | 0) < 11;
		    $10 = 0;
		    while (1) {
		     $34 = (Math_imul($4 >> 16, $27) + $31 | 0) + (Math_imul($4 & 65535, $27) >> 16) | 0;
		     $4 = ($10 << 2) + $3 | 0;
		     $12 = HEAP32[$4 + 56 >> 2];
		     $14 = HEAP32[$4 + 48 >> 2];
		     $8 = HEAP32[$4 + 40 >> 2];
		     $16 = HEAP32[$4 + 32 >> 2];
		     $4 = HEAP32[$4 + 24 >> 2];
		     $5 = ((((((((((((((((($34 + Math_imul($12 >> 16, $26) | 0) + (Math_imul($12 & 65535, $26) >> 16) | 0) + Math_imul($7 >> 16, $18) | 0) + (Math_imul($7 & 65535, $18) >> 16) | 0) + Math_imul($14 >> 16, $22) | 0) + (Math_imul($14 & 65535, $22) >> 16) | 0) + Math_imul($11 >> 16, $25) | 0) + (Math_imul($11 & 65535, $25) >> 16) | 0) + Math_imul($8 >> 16, $28) | 0) + (Math_imul($8 & 65535, $28) >> 16) | 0) + Math_imul($6 >> 16, $17) | 0) + (Math_imul($6 & 65535, $17) >> 16) | 0) + Math_imul($16 >> 16, $21) | 0) + (Math_imul($16 & 65535, $21) >> 16) | 0) + Math_imul($5 >> 16, $15) | 0) + (Math_imul($5 & 65535, $15) >> 16) | 0) + Math_imul($4 >> 16, $24) | 0) + (Math_imul($4 & 65535, $24) >> 16) | 0;
		     $7 = $10 + 16 | 0;
		     $4 = 10;
		     if (!$33) {
		      while (1) {
		       $11 = HEAP16[($9 + 16 | 0) + ($4 << 1) >> 1];
		       $6 = HEAP32[(($4 ^ -1) + $7 << 2) + $3 >> 2];
		       $5 = (Math_imul($11, $6 >> 16) + $5 | 0) + (Math_imul($6 & 65535, $11) >> 16) | 0;
		       $4 = $4 + 1 | 0;
		       if (($23 | 0) != ($4 | 0)) {
		        continue;
		       }
		       break;
		      }
		     }
		     $6 = ($7 << 2) + $3 | 0;
		     $4 = HEAP32[$6 >> 2];
		     $5 = ($5 | 0) > -134217728 ? $5 : -134217728;
		     $5 = (($5 | 0) < 134217727 ? $5 : 134217727) << 4;
		     $11 = $4 + $5 | 0;
		     label$19 : {
		      if (($11 | 0) >= 0) {
		       $4 = ($4 & $5) > -1 ? $11 : -2147483648;
		       break label$19;
		      }
		      $4 = ($4 | $5) > -1 ? 2147483647 : $11;
		     }
		     HEAP32[$6 >> 2] = $4;
		     $5 = (Math_imul($4 >> 16, $20) + Math_imul($4, $32) | 0) + (Math_imul($4 & 65535, $20) >> 16) | 0;
		     HEAP16[($10 << 1) + $2 >> 1] = ($5 | 0) > 8388479 ? 32767 : ($5 | 0) < -8388736 ? -32768 : ($5 >>> 7 | 0) + 1 >>> 1 | 0;
		     $5 = $16;
		     $6 = $8;
		     $11 = $14;
		     $7 = $12;
		     $10 = $10 + 1 | 0;
		     if (($30 | 0) != ($10 | 0)) {
		      continue;
		     }
		     break;
		    }
		   }
		   $4 = ($30 << 2) + $3 | 0;
		   $5 = HEAP32[$4 + 4 >> 2];
		   $6 = HEAP32[$4 >> 2];
		   $3 = $6;
		   $2 = $0 + 1284 | 0;
		   $6 = $2;
		   HEAP32[$6 >> 2] = $3;
		   HEAP32[$6 + 4 >> 2] = $5;
		   $6 = HEAP32[$4 + 60 >> 2];
		   $5 = HEAP32[$4 + 56 >> 2];
		   $3 = $5;
		   $5 = $2;
		   HEAP32[$5 + 56 >> 2] = $3;
		   HEAP32[$5 + 60 >> 2] = $6;
		   $5 = HEAP32[$4 + 52 >> 2];
		   $6 = HEAP32[$4 + 48 >> 2];
		   $3 = $6;
		   $6 = $2;
		   HEAP32[$6 + 48 >> 2] = $3;
		   HEAP32[$6 + 52 >> 2] = $5;
		   $6 = HEAP32[$4 + 44 >> 2];
		   $5 = HEAP32[$4 + 40 >> 2];
		   $3 = $5;
		   $5 = $2;
		   HEAP32[$5 + 40 >> 2] = $3;
		   HEAP32[$5 + 44 >> 2] = $6;
		   $5 = HEAP32[$4 + 36 >> 2];
		   $6 = HEAP32[$4 + 32 >> 2];
		   $3 = $6;
		   $6 = $2;
		   HEAP32[$6 + 32 >> 2] = $3;
		   HEAP32[$6 + 36 >> 2] = $5;
		   $6 = HEAP32[$4 + 28 >> 2];
		   $5 = HEAP32[$4 + 24 >> 2];
		   $3 = $5;
		   $5 = $2;
		   HEAP32[$5 + 24 >> 2] = $3;
		   HEAP32[$5 + 28 >> 2] = $6;
		   $5 = HEAP32[$4 + 20 >> 2];
		   $6 = HEAP32[$4 + 16 >> 2];
		   $3 = $6;
		   $6 = $2;
		   HEAP32[$6 + 16 >> 2] = $3;
		   HEAP32[$6 + 20 >> 2] = $5;
		   $6 = HEAP32[$4 + 12 >> 2];
		   $5 = HEAP32[$4 + 8 >> 2];
		   $3 = $5;
		   $5 = $2;
		   HEAP32[$5 + 8 >> 2] = $3;
		   HEAP32[$5 + 12 >> 2] = $6;
		   HEAP16[$0 + 4228 >> 1] = $19;
		   HEAP32[$0 + 4224 >> 2] = $29;
		   HEAP32[$1 + 12 >> 2] = $13;
		   HEAP32[$1 + 8 >> 2] = $13;
		   HEAP32[$1 + 4 >> 2] = $13;
		   HEAP32[$1 >> 2] = $13;
		   __stack_pointer = $9 - -64 | 0;
		   return;
		  }
		  celt_fatal(2279, 2268, 350);
		  abort();
		 }
		 celt_fatal(2242, 2268, 294);
		 abort();
		}
		function silk_CNG($0, $1, $2, $3) {
		 var $4 = 0, $5 = 0, $6 = 0, $7 = 0, $8 = 0, $9 = 0, $10 = 0, $11 = 0, $12 = 0, $13 = 0, $14 = 0, $15 = 0, $16 = 0, $17 = 0, $18 = 0, $19 = 0, $20 = 0, $21 = 0, $22 = 0, $23 = 0, $24 = 0, $25 = 0, $26 = 0, $27 = 0, $28 = 0, $29 = 0, $30 = 0, $31 = 0, $32 = 0, $33 = 0;
		 $13 = __stack_pointer - 32 | 0;
		 $9 = $13;
		 __stack_pointer = $9;
		 $8 = HEAP32[$0 + 2316 >> 2];
		 if (($8 | 0) != HEAP32[$0 + 4156 >> 2]) {
		  $5 = HEAP32[$0 + 2340 >> 2];
		  $6 = 32767 / ($5 + 1 | 0) | 0;
		  if (($5 | 0) >= 1) {
		   while (1) {
		    $7 = $7 + $6 | 0;
		    HEAP16[(($4 << 1) + $0 | 0) + 4052 >> 1] = $7;
		    $4 = $4 + 1 | 0;
		    if (($5 | 0) != ($4 | 0)) {
		     continue;
		    }
		    break;
		   }
		  }
		  HEAP32[$0 + 4156 >> 2] = $8;
		  $5 = $0 + 4148 | 0;
		  HEAP32[$5 >> 2] = 0;
		  HEAP32[$5 + 4 >> 2] = 3176576;
		 }
		 label$4 : {
		  label$5 : {
		   if (!HEAP32[$0 + 4160 >> 2]) {
		    label$7 : {
		     if (HEAP32[$0 + 4164 >> 2]) {
		      break label$7;
		     }
		     $4 = 0;
		     $6 = HEAP32[$0 + 2340 >> 2];
		     if (($6 | 0) > 0) {
		      while (1) {
		       $7 = ($4 << 1) + $0 | 0;
		       $5 = $7 + 4052 | 0;
		       $12 = $5;
		       $5 = HEAP16[$5 >> 1];
		       $7 = HEAP16[$7 + 2344 >> 1] - $5 | 0;
		       HEAP16[$12 >> 1] = (Math_imul($7 >>> 16 | 0, 16348) + (Math_imul($7 & 65535, 16348) >>> 16 | 0) | 0) + $5;
		       $4 = $4 + 1 | 0;
		       if (($6 | 0) != ($4 | 0)) {
		        continue;
		       }
		       break;
		      }
		     }
		     $14 = $0 + 2772 | 0;
		     $4 = 0;
		     $8 = HEAP32[$0 + 2324 >> 2];
		     label$10 : {
		      if (($8 | 0) <= 0) {
		       $5 = 0;
		       break label$10;
		      }
		      $5 = 0;
		      $7 = 0;
		      while (1) {
		       $6 = HEAP32[(($4 << 2) + $1 | 0) + 16 >> 2];
		       $12 = $6;
		       $6 = ($7 | 0) < ($6 | 0);
		       $7 = $6 ? $12 : $7;
		       $5 = $6 ? $4 : $5;
		       $4 = $4 + 1 | 0;
		       if (($8 | 0) != ($4 | 0)) {
		        continue;
		       }
		       break;
		      }
		     }
		     $4 = HEAP32[$0 + 2332 >> 2];
		     memmove((($4 << 2) + $0 | 0) + 2772 | 0, $14, Math_imul(($8 << 2) - 4 | 0, $4));
		     $4 = HEAP32[$0 + 2332 >> 2];
		     memcpy($14, ((Math_imul($5, $4) << 2) + $0 | 0) + 4 | 0, $4 << 2);
		     $6 = HEAP32[$0 + 2324 >> 2];
		     if (($6 | 0) < 1) {
		      break label$7;
		     }
		     $4 = HEAP32[$0 + 4148 >> 2];
		     $7 = 0;
		     while (1) {
		      $5 = HEAP32[(($7 << 2) + $1 | 0) + 16 >> 2] - $4 | 0;
		      $4 = Math_imul($5 >> 16, 4634) + $4 + (Math_imul($5 & 65535, 4634) >>> 16) | 0;
		      HEAP32[$0 + 4148 >> 2] = $4;
		      $7 = $7 + 1 | 0;
		      if (($6 | 0) != ($7 | 0)) {
		       continue;
		      }
		      break;
		     }
		    }
		    if (!HEAP32[$0 + 4160 >> 2]) {
		     break label$5;
		    }
		   }
		   $8 = $13 - (($3 << 2) + 79 & -16) | 0;
		   __stack_pointer = $8;
		   $7 = HEAP32[$0 + 4248 >> 2];
		   $5 = $7 << 16 >> 16;
		   $4 = HEAP16[$0 + 4228 >> 1];
		   $7 = ((Math_imul($5, $4 & 65535) >> 16) + Math_imul($4 >> 16, $5) | 0) + Math_imul(($7 >> 15) + 1 >> 1, $4) | 0;
		   $5 = $7 >> 16;
		   $4 = HEAP32[$0 + 4148 >> 2];
		   label$14 : {
		    if (!(($4 | 0) < 8388609 ? ($7 | 0) <= 2097151 : 0)) {
		     $4 = $4 >> 16;
		     $4 = Math_imul($4, $4) - (Math_imul($5, $5) << 5) | 0;
		     $1 = 0;
		     if (($4 | 0) < 1) {
		      break label$14;
		     }
		     $7 = Math_clz32($4);
		     $5 = 24 - $7 | 0;
		     label$16 : {
		      if (!$5) {
		       break label$16;
		      }
		      if ($4 >>> 0 <= 127) {
		       $4 = $4 << 0 - $5 | $4 >>> 56 - $7;
		       break label$16;
		      }
		      $4 = $4 << $7 + 8 | $4 >>> $5;
		     }
		     $1 = Math_imul(Math_imul($4 & 127, 13959168) >>> 16 | 65536, ($7 & 1 ? 32768 : 46214) >>> ($7 >>> 1) | 0) & -65536;
		     break label$14;
		    }
		    $6 = $4 << 16 >> 16;
		    $1 = $7 << 16 >> 16;
		    $4 = ((Math_imul($6, $4 >> 16) - (((Math_imul($1, $7 & 65535) >> 16) + Math_imul($1, $5) | 0) + Math_imul(($7 >> 15) + 1 >>> 1 | 0, $7) << 5) | 0) + (Math_imul($4 & 65535, $6) >> 16) | 0) + Math_imul(($4 >> 15) + 1 >> 1, $4) | 0;
		    $1 = 0;
		    if (($4 | 0) < 1) {
		     break label$14;
		    }
		    $7 = Math_clz32($4);
		    $5 = 24 - $7 | 0;
		    label$18 : {
		     if (!$5) {
		      break label$18;
		     }
		     if ($4 >>> 0 <= 127) {
		      $4 = $4 << 0 - $5 | $4 >>> 56 - $7;
		      break label$18;
		     }
		     $4 = $4 << $7 + 8 | $4 >>> $5;
		    }
		    $1 = Math_imul($4 & 127, 13959168) >>> 16 | 0;
		    $4 = ($7 & 1 ? 32768 : 46214) >>> ($7 >>> 1) | 0;
		    $1 = $4 + (Math_imul($4, $1) >>> 16 | 0) << 8;
		   }
		   $6 = $8 - -64 | 0;
		   $7 = 255;
		   while (1) {
		    $4 = $7;
		    $7 = $4 >> 1;
		    if (($3 | 0) < ($4 | 0)) {
		     continue;
		    }
		    break;
		   }
		   $5 = HEAP32[$0 + 4152 >> 2];
		   if (($3 | 0) >= 1) {
		    $7 = 0;
		    while (1) {
		     $5 = Math_imul($5, 196314165) + 907633515 | 0;
		     HEAP32[($7 << 2) + $6 >> 2] = HEAP32[((($5 >> 24 & $4) << 2) + $0 | 0) + 2772 >> 2];
		     $7 = $7 + 1 | 0;
		     if (($7 | 0) != ($3 | 0)) {
		      continue;
		     }
		     break;
		    }
		   }
		   HEAP32[$0 + 4152 >> 2] = $5;
		   silk_NLSF2A($9, $0 + 4052 | 0, HEAP32[$0 + 2340 >> 2], HEAP32[$0 + 4168 >> 2]);
		   $4 = $0 + 4140 | 0;
		   $6 = HEAP32[$4 >> 2];
		   $5 = HEAP32[$4 + 4 >> 2];
		   HEAP32[$8 + 56 >> 2] = $6;
		   HEAP32[$8 + 60 >> 2] = $5;
		   $4 = $0 + 4132 | 0;
		   $5 = HEAP32[$4 >> 2];
		   $6 = HEAP32[$4 + 4 >> 2];
		   HEAP32[$8 + 48 >> 2] = $5;
		   HEAP32[$8 + 52 >> 2] = $6;
		   $4 = $0 + 4124 | 0;
		   $6 = HEAP32[$4 >> 2];
		   $5 = HEAP32[$4 + 4 >> 2];
		   HEAP32[$8 + 40 >> 2] = $6;
		   HEAP32[$8 + 44 >> 2] = $5;
		   $4 = $0 + 4116 | 0;
		   $5 = HEAP32[$4 >> 2];
		   $6 = HEAP32[$4 + 4 >> 2];
		   HEAP32[$8 + 32 >> 2] = $5;
		   HEAP32[$8 + 36 >> 2] = $6;
		   $4 = $0 + 4108 | 0;
		   $6 = HEAP32[$4 >> 2];
		   $5 = HEAP32[$4 + 4 >> 2];
		   HEAP32[$8 + 24 >> 2] = $6;
		   HEAP32[$8 + 28 >> 2] = $5;
		   $4 = $0 + 4100 | 0;
		   $5 = HEAP32[$4 >> 2];
		   $6 = HEAP32[$4 + 4 >> 2];
		   HEAP32[$8 + 16 >> 2] = $5;
		   HEAP32[$8 + 20 >> 2] = $6;
		   $4 = $0 + 4092 | 0;
		   $6 = HEAP32[$4 >> 2];
		   $5 = HEAP32[$4 + 4 >> 2];
		   HEAP32[$8 + 8 >> 2] = $6;
		   HEAP32[$8 + 12 >> 2] = $5;
		   $12 = $0 + 4084 | 0;
		   $4 = $12;
		   $5 = HEAP32[$4 >> 2];
		   $6 = HEAP32[$4 + 4 >> 2];
		   HEAP32[$8 >> 2] = $5;
		   HEAP32[$8 + 4 >> 2] = $6;
		   label$23 : {
		    label$24 : {
		     $15 = HEAP32[$0 + 2340 >> 2];
		     switch ($15 - 10 | 0) {
		     case 0:
		     case 6:
		      break label$23;
		     default:
		      break label$24;
		     }
		    }
		    celt_fatal(2041, 2108, 149);
		    abort();
		   }
		   if (($3 | 0) >= 1) {
		    $32 = $15 >>> 1 | 0;
		    $14 = $1 << 10 >> 16;
		    $33 = ($1 >> 21) + 1 >> 1;
		    $0 = HEAP32[$8 + 28 >> 2];
		    $5 = HEAP32[$8 + 36 >> 2];
		    $6 = HEAP32[$8 + 44 >> 2];
		    $1 = HEAP32[$8 + 52 >> 2];
		    $4 = HEAP32[$8 + 60 >> 2];
		    $16 = HEAP16[$9 + 30 >> 1];
		    $17 = HEAP16[$9 + 28 >> 1];
		    $18 = HEAP16[$9 + 26 >> 1];
		    $19 = HEAP16[$9 + 24 >> 1];
		    $20 = HEAP16[$9 + 22 >> 1];
		    $21 = HEAP16[$9 + 20 >> 1];
		    $22 = HEAP16[$9 + 18 >> 1];
		    $23 = HEAP16[$9 + 16 >> 1];
		    $24 = HEAP16[$9 + 14 >> 1];
		    $25 = HEAP16[$9 + 12 >> 1];
		    $26 = HEAP16[$9 + 10 >> 1];
		    $27 = HEAP16[$9 + 8 >> 1];
		    $28 = HEAP16[$9 + 6 >> 1];
		    $29 = HEAP16[$9 + 4 >> 1];
		    $30 = HEAP16[$9 + 2 >> 1];
		    $31 = HEAP16[$9 >> 1];
		    $7 = 0;
		    while (1) {
		     $10 = (Math_imul($4 >> 16, $31) + $32 | 0) + (Math_imul($4 & 65535, $31) >> 16) | 0;
		     $4 = ($7 << 2) + $8 | 0;
		     $13 = HEAP32[$4 + 56 >> 2];
		     $10 = ((($10 + Math_imul($13 >> 16, $30) | 0) + (Math_imul($13 & 65535, $30) >> 16) | 0) + Math_imul($1 >> 16, $29) | 0) + (Math_imul($1 & 65535, $29) >> 16) | 0;
		     $1 = HEAP32[$4 + 48 >> 2];
		     $10 = ((($10 + Math_imul($1 >> 16, $28) | 0) + (Math_imul($1 & 65535, $28) >> 16) | 0) + Math_imul($6 >> 16, $27) | 0) + (Math_imul($6 & 65535, $27) >> 16) | 0;
		     $6 = HEAP32[$4 + 40 >> 2];
		     $10 = ((($10 + Math_imul($6 >> 16, $26) | 0) + (Math_imul($6 & 65535, $26) >> 16) | 0) + Math_imul($5 >> 16, $25) | 0) + (Math_imul($5 & 65535, $25) >> 16) | 0;
		     $5 = HEAP32[$4 + 32 >> 2];
		     $10 = ((($10 + Math_imul($5 >> 16, $24) | 0) + (Math_imul($5 & 65535, $24) >> 16) | 0) + Math_imul($0 >> 16, $23) | 0) + (Math_imul($0 & 65535, $23) >> 16) | 0;
		     $0 = HEAP32[$4 + 24 >> 2];
		     $0 = ($10 + Math_imul($0 >> 16, $22) | 0) + (Math_imul($0 & 65535, $22) >> 16) | 0;
		     $10 = $7 + 16 | 0;
		     if (($15 | 0) == 16) {
		      $11 = HEAP32[$4 + 20 >> 2];
		      $11 = (Math_imul($11 >> 16, $21) + $0 | 0) + (Math_imul($11 & 65535, $21) >> 16) | 0;
		      $0 = HEAP32[$4 + 16 >> 2];
		      $11 = ($11 + Math_imul($0 >> 16, $20) | 0) + (Math_imul($0 & 65535, $20) >> 16) | 0;
		      $0 = HEAP32[$4 + 12 >> 2];
		      $11 = ($11 + Math_imul($0 >> 16, $19) | 0) + (Math_imul($0 & 65535, $19) >> 16) | 0;
		      $0 = HEAP32[$4 + 8 >> 2];
		      $11 = ($11 + Math_imul($0 >> 16, $18) | 0) + (Math_imul($0 & 65535, $18) >> 16) | 0;
		      $0 = HEAP32[$4 + 4 >> 2];
		      $4 = HEAP32[$4 >> 2];
		      $0 = ((($11 + Math_imul($0 >> 16, $17) | 0) + (Math_imul($0 & 65535, $17) >> 16) | 0) + Math_imul($4 >> 16, $16) | 0) + (Math_imul($4 & 65535, $16) >> 16) | 0;
		     }
		     $4 = ($0 | 0) > -134217728 ? $0 : -134217728;
		     $4 = (($4 | 0) < 134217727 ? $4 : 134217727) << 4;
		     $0 = ($10 << 2) + $8 | 0;
		     $10 = HEAP32[$0 >> 2];
		     $11 = $4 + $10 | 0;
		     label$27 : {
		      if (($11 | 0) >= 0) {
		       $4 = ($4 & $10) > -1 ? $11 : -2147483648;
		       break label$27;
		      }
		      $4 = ($4 | $10) > -1 ? 2147483647 : $11;
		     }
		     HEAP32[$0 >> 2] = $4;
		     $10 = ($7 << 1) + $2 | 0;
		     $0 = (Math_imul($4 >> 16, $14) + Math_imul($4, $33) | 0) + (Math_imul($4 & 65535, $14) >> 16) | 0;
		     $0 = HEAP16[$10 >> 1] + (($0 | 0) > 8388479 ? 32767 : ($0 | 0) < -8388736 ? -32768 : ($0 >> 7) + 1 >> 1) | 0;
		     $0 = ($0 | 0) > -32768 ? $0 : -32768;
		     HEAP16[$10 >> 1] = ($0 | 0) < 32767 ? $0 : 32767;
		     $0 = $5;
		     $5 = $6;
		     $6 = $1;
		     $1 = $13;
		     $7 = $7 + 1 | 0;
		     if (($7 | 0) != ($3 | 0)) {
		      continue;
		     }
		     break;
		    }
		   }
		   $4 = ($3 << 2) + $8 | 0;
		   $5 = HEAP32[$4 + 4 >> 2];
		   $6 = HEAP32[$4 >> 2];
		   $0 = $6;
		   $6 = $12;
		   HEAP32[$6 >> 2] = $0;
		   HEAP32[$6 + 4 >> 2] = $5;
		   $6 = HEAP32[$4 + 60 >> 2];
		   $5 = HEAP32[$4 + 56 >> 2];
		   $0 = $5;
		   $5 = $12;
		   HEAP32[$5 + 56 >> 2] = $0;
		   HEAP32[$5 + 60 >> 2] = $6;
		   $5 = HEAP32[$4 + 52 >> 2];
		   $6 = HEAP32[$4 + 48 >> 2];
		   $0 = $6;
		   $6 = $12;
		   HEAP32[$6 + 48 >> 2] = $0;
		   HEAP32[$6 + 52 >> 2] = $5;
		   $6 = HEAP32[$4 + 44 >> 2];
		   $5 = HEAP32[$4 + 40 >> 2];
		   $0 = $5;
		   $5 = $12;
		   HEAP32[$5 + 40 >> 2] = $0;
		   HEAP32[$5 + 44 >> 2] = $6;
		   $5 = HEAP32[$4 + 36 >> 2];
		   $6 = HEAP32[$4 + 32 >> 2];
		   $0 = $6;
		   $6 = $12;
		   HEAP32[$6 + 32 >> 2] = $0;
		   HEAP32[$6 + 36 >> 2] = $5;
		   $6 = HEAP32[$4 + 28 >> 2];
		   $5 = HEAP32[$4 + 24 >> 2];
		   $0 = $5;
		   $5 = $12;
		   HEAP32[$5 + 24 >> 2] = $0;
		   HEAP32[$5 + 28 >> 2] = $6;
		   $5 = HEAP32[$4 + 20 >> 2];
		   $6 = HEAP32[$4 + 16 >> 2];
		   $0 = $6;
		   $6 = $12;
		   HEAP32[$6 + 16 >> 2] = $0;
		   HEAP32[$6 + 20 >> 2] = $5;
		   $6 = HEAP32[$4 + 12 >> 2];
		   $5 = HEAP32[$4 + 8 >> 2];
		   $0 = $5;
		   $5 = $12;
		   HEAP32[$5 + 8 >> 2] = $0;
		   HEAP32[$5 + 12 >> 2] = $6;
		   break label$4;
		  }
		  memset($0 + 4084 | 0, 0, HEAP32[$0 + 2340 >> 2] << 2);
		 }
		 __stack_pointer = $9 + 32 | 0;
		}
		function silk_resampler_private_down_FIR($0, $1, $2, $3) {
		 var $4 = 0, $5 = 0, $6 = 0, $7 = 0, $8 = 0, $9 = 0, $10 = 0, $11 = 0, $12 = 0, $13 = 0, $14 = 0, $15 = 0, $16 = 0, $17 = 0, $18 = 0, $19 = 0, $20 = 0, $21 = 0;
		 $10 = __stack_pointer;
		 $20 = $10;
		 $6 = HEAP32[$0 + 268 >> 2];
		 $8 = HEAP32[$0 + 276 >> 2];
		 $10 = $10 - (($6 + $8 << 2) + 15 & -16) | 0;
		 __stack_pointer = $10;
		 $17 = $0 + 24 | 0;
		 $12 = memcpy($10, $17, $8 << 2);
		 $10 = HEAP32[$0 + 296 >> 2];
		 $18 = $10 + 4 | 0;
		 $15 = HEAP32[$0 + 272 >> 2];
		 $5 = $10;
		 while (1) {
		  $13 = ($3 | 0) < ($6 | 0) ? $3 : $6;
		  silk_resampler_private_AR2($0, ($8 << 2) + $12 | 0, $2, $5, $13);
		  $14 = $13 << 16;
		  label$2 : {
		   label$3 : {
		    label$4 : {
		     label$5 : {
		      label$6 : {
		       $16 = HEAP32[$0 + 276 >> 2];
		       switch ($16 - 18 | 0) {
		       case 18:
		        break label$3;
		       case 6:
		        break label$5;
		       case 0:
		        break label$6;
		       default:
		        break label$4;
		       }
		      }
		      if (($14 | 0) < 1) {
		       break label$2;
		      }
		      $19 = HEAP32[$0 + 280 >> 2];
		      $21 = $19 << 16 >> 16;
		      $5 = 0;
		      while (1) {
		       $7 = Math_imul($5 & 65535, $21) >> 16;
		       $8 = Math_imul($7, 18) + $18 | 0;
		       $9 = HEAP16[$8 >> 1];
		       $6 = ($5 >> 16 << 2) + $12 | 0;
		       $4 = HEAP32[$6 >> 2];
		       $11 = (Math_imul($9, $4 & 65535) >> 16) + Math_imul($4 >> 16, $9) | 0;
		       $9 = HEAP16[$8 + 2 >> 1];
		       $4 = HEAP32[$6 + 4 >> 2];
		       $11 = ($11 + Math_imul($9, $4 >> 16) | 0) + (Math_imul($4 & 65535, $9) >> 16) | 0;
		       $9 = HEAP16[$8 + 4 >> 1];
		       $4 = HEAP32[$6 + 8 >> 2];
		       $11 = ($11 + Math_imul($9, $4 >> 16) | 0) + (Math_imul($4 & 65535, $9) >> 16) | 0;
		       $9 = HEAP16[$8 + 6 >> 1];
		       $4 = HEAP32[$6 + 12 >> 2];
		       $11 = ($11 + Math_imul($9, $4 >> 16) | 0) + (Math_imul($4 & 65535, $9) >> 16) | 0;
		       $9 = HEAP16[$8 + 8 >> 1];
		       $4 = HEAP32[$6 + 16 >> 2];
		       $11 = ($11 + Math_imul($9, $4 >> 16) | 0) + (Math_imul($4 & 65535, $9) >> 16) | 0;
		       $9 = HEAP16[$8 + 10 >> 1];
		       $4 = HEAP32[$6 + 20 >> 2];
		       $11 = ($11 + Math_imul($9, $4 >> 16) | 0) + (Math_imul($4 & 65535, $9) >> 16) | 0;
		       $9 = HEAP16[$8 + 12 >> 1];
		       $4 = HEAP32[$6 + 24 >> 2];
		       $11 = ($11 + Math_imul($9, $4 >> 16) | 0) + (Math_imul($4 & 65535, $9) >> 16) | 0;
		       $9 = HEAP16[$8 + 14 >> 1];
		       $4 = HEAP32[$6 + 28 >> 2];
		       $9 = ($11 + Math_imul($9, $4 >> 16) | 0) + (Math_imul($4 & 65535, $9) >> 16) | 0;
		       $8 = HEAP16[$8 + 16 >> 1];
		       $4 = HEAP32[$6 + 32 >> 2];
		       $9 = ($9 + Math_imul($8, $4 >> 16) | 0) + (Math_imul($4 & 65535, $8) >> 16) | 0;
		       $8 = Math_imul(($7 ^ -1) + $19 | 0, 18) + $18 | 0;
		       $7 = HEAP16[$8 >> 1];
		       $4 = HEAP32[$6 + 68 >> 2];
		       $9 = ($9 + Math_imul($7, $4 >> 16) | 0) + (Math_imul($4 & 65535, $7) >> 16) | 0;
		       $7 = HEAP16[$8 + 2 >> 1];
		       $4 = HEAP32[$6 + 64 >> 2];
		       $9 = ($9 + Math_imul($7, $4 >> 16) | 0) + (Math_imul($4 & 65535, $7) >> 16) | 0;
		       $7 = HEAP16[$8 + 4 >> 1];
		       $4 = HEAP32[$6 + 60 >> 2];
		       $9 = ($9 + Math_imul($7, $4 >> 16) | 0) + (Math_imul($4 & 65535, $7) >> 16) | 0;
		       $7 = HEAP16[$8 + 6 >> 1];
		       $4 = HEAP32[$6 + 56 >> 2];
		       $9 = ($9 + Math_imul($7, $4 >> 16) | 0) + (Math_imul($4 & 65535, $7) >> 16) | 0;
		       $7 = HEAP16[$8 + 8 >> 1];
		       $4 = HEAP32[$6 + 52 >> 2];
		       $9 = ($9 + Math_imul($7, $4 >> 16) | 0) + (Math_imul($4 & 65535, $7) >> 16) | 0;
		       $7 = HEAP16[$8 + 10 >> 1];
		       $4 = HEAP32[$6 + 48 >> 2];
		       $9 = ($9 + Math_imul($7, $4 >> 16) | 0) + (Math_imul($4 & 65535, $7) >> 16) | 0;
		       $7 = HEAP16[$8 + 12 >> 1];
		       $4 = HEAP32[$6 + 44 >> 2];
		       $9 = ($9 + Math_imul($7, $4 >> 16) | 0) + (Math_imul($4 & 65535, $7) >> 16) | 0;
		       $7 = HEAP16[$8 + 14 >> 1];
		       $4 = HEAP32[$6 + 40 >> 2];
		       $8 = HEAP16[$8 + 16 >> 1];
		       $6 = HEAP32[$6 + 36 >> 2];
		       $6 = ((($9 + Math_imul($7, $4 >> 16) | 0) + (Math_imul($4 & 65535, $7) >> 16) | 0) + Math_imul($8, $6 >> 16) | 0) + (Math_imul($6 & 65535, $8) >> 16) | 0;
		       $8 = ($6 >> 5) + 1 >> 1;
		       HEAP16[$1 >> 1] = ($6 | 0) > 2097119 ? 32767 : ($8 | 0) > -32768 ? $8 : -32768;
		       $1 = $1 + 2 | 0;
		       $5 = $5 + $15 | 0;
		       if (($14 | 0) > ($5 | 0)) {
		        continue;
		       }
		       break;
		      }
		      break label$2;
		     }
		     $8 = 0;
		     if (($14 | 0) <= 0) {
		      break label$2;
		     }
		     while (1) {
		      $4 = HEAP16[$10 + 4 >> 1];
		      $6 = ($8 >> 16 << 2) + $12 | 0;
		      $5 = HEAP32[$6 + 92 >> 2] + HEAP32[$6 >> 2] | 0;
		      $7 = (Math_imul($4, $5 & 65535) >> 16) + Math_imul($5 >> 16, $4) | 0;
		      $4 = HEAP16[$10 + 6 >> 1];
		      $5 = HEAP32[$6 + 88 >> 2] + HEAP32[$6 + 4 >> 2] | 0;
		      $7 = ($7 + Math_imul($4, $5 >> 16) | 0) + (Math_imul($5 & 65535, $4) >> 16) | 0;
		      $4 = HEAP16[$10 + 8 >> 1];
		      $5 = HEAP32[$6 + 84 >> 2] + HEAP32[$6 + 8 >> 2] | 0;
		      $7 = ($7 + Math_imul($4, $5 >> 16) | 0) + (Math_imul($5 & 65535, $4) >> 16) | 0;
		      $4 = HEAP16[$10 + 10 >> 1];
		      $5 = HEAP32[$6 + 80 >> 2] + HEAP32[$6 + 12 >> 2] | 0;
		      $7 = ($7 + Math_imul($4, $5 >> 16) | 0) + (Math_imul($5 & 65535, $4) >> 16) | 0;
		      $4 = HEAP16[$10 + 12 >> 1];
		      $5 = HEAP32[$6 + 76 >> 2] + HEAP32[$6 + 16 >> 2] | 0;
		      $7 = ($7 + Math_imul($4, $5 >> 16) | 0) + (Math_imul($5 & 65535, $4) >> 16) | 0;
		      $4 = HEAP16[$10 + 14 >> 1];
		      $5 = HEAP32[$6 + 72 >> 2] + HEAP32[$6 + 20 >> 2] | 0;
		      $7 = ($7 + Math_imul($4, $5 >> 16) | 0) + (Math_imul($5 & 65535, $4) >> 16) | 0;
		      $4 = HEAP16[$10 + 16 >> 1];
		      $5 = HEAP32[$6 + 68 >> 2] + HEAP32[$6 + 24 >> 2] | 0;
		      $7 = ($7 + Math_imul($4, $5 >> 16) | 0) + (Math_imul($5 & 65535, $4) >> 16) | 0;
		      $4 = HEAP16[$10 + 18 >> 1];
		      $5 = HEAP32[$6 + 64 >> 2] + HEAP32[$6 + 28 >> 2] | 0;
		      $7 = ($7 + Math_imul($4, $5 >> 16) | 0) + (Math_imul($5 & 65535, $4) >> 16) | 0;
		      $4 = HEAP16[$10 + 20 >> 1];
		      $5 = HEAP32[$6 + 60 >> 2] + HEAP32[$6 + 32 >> 2] | 0;
		      $7 = ($7 + Math_imul($4, $5 >> 16) | 0) + (Math_imul($5 & 65535, $4) >> 16) | 0;
		      $4 = HEAP16[$10 + 22 >> 1];
		      $5 = HEAP32[$6 + 56 >> 2] + HEAP32[$6 + 36 >> 2] | 0;
		      $7 = ($7 + Math_imul($4, $5 >> 16) | 0) + (Math_imul($5 & 65535, $4) >> 16) | 0;
		      $4 = HEAP16[$10 + 24 >> 1];
		      $5 = HEAP32[$6 + 52 >> 2] + HEAP32[$6 + 40 >> 2] | 0;
		      $4 = ($7 + Math_imul($4, $5 >> 16) | 0) + (Math_imul($5 & 65535, $4) >> 16) | 0;
		      $5 = HEAP16[$10 + 26 >> 1];
		      $6 = HEAP32[$6 + 48 >> 2] + HEAP32[$6 + 44 >> 2] | 0;
		      $6 = ($4 + Math_imul($5, $6 >> 16) | 0) + (Math_imul($6 & 65535, $5) >> 16) | 0;
		      $5 = ($6 >> 5) + 1 >> 1;
		      HEAP16[$1 >> 1] = ($6 | 0) > 2097119 ? 32767 : ($5 | 0) > -32768 ? $5 : -32768;
		      $1 = $1 + 2 | 0;
		      $8 = $8 + $15 | 0;
		      if (($14 | 0) > ($8 | 0)) {
		       continue;
		      }
		      break;
		     }
		     break label$2;
		    }
		    celt_fatal(2704, 2724, 139);
		    abort();
		   }
		   $8 = 0;
		   if (($14 | 0) <= 0) {
		    break label$2;
		   }
		   while (1) {
		    $4 = HEAP16[$10 + 4 >> 1];
		    $6 = ($8 >> 16 << 2) + $12 | 0;
		    $5 = HEAP32[$6 + 140 >> 2] + HEAP32[$6 >> 2] | 0;
		    $7 = (Math_imul($4, $5 & 65535) >> 16) + Math_imul($5 >> 16, $4) | 0;
		    $4 = HEAP16[$10 + 6 >> 1];
		    $5 = HEAP32[$6 + 136 >> 2] + HEAP32[$6 + 4 >> 2] | 0;
		    $7 = ($7 + Math_imul($4, $5 >> 16) | 0) + (Math_imul($5 & 65535, $4) >> 16) | 0;
		    $4 = HEAP16[$10 + 8 >> 1];
		    $5 = HEAP32[$6 + 132 >> 2] + HEAP32[$6 + 8 >> 2] | 0;
		    $7 = ($7 + Math_imul($4, $5 >> 16) | 0) + (Math_imul($5 & 65535, $4) >> 16) | 0;
		    $4 = HEAP16[$10 + 10 >> 1];
		    $5 = HEAP32[$6 + 128 >> 2] + HEAP32[$6 + 12 >> 2] | 0;
		    $7 = ($7 + Math_imul($4, $5 >> 16) | 0) + (Math_imul($5 & 65535, $4) >> 16) | 0;
		    $4 = HEAP16[$10 + 12 >> 1];
		    $5 = HEAP32[$6 + 124 >> 2] + HEAP32[$6 + 16 >> 2] | 0;
		    $7 = ($7 + Math_imul($4, $5 >> 16) | 0) + (Math_imul($5 & 65535, $4) >> 16) | 0;
		    $4 = HEAP16[$10 + 14 >> 1];
		    $5 = HEAP32[$6 + 120 >> 2] + HEAP32[$6 + 20 >> 2] | 0;
		    $7 = ($7 + Math_imul($4, $5 >> 16) | 0) + (Math_imul($5 & 65535, $4) >> 16) | 0;
		    $4 = HEAP16[$10 + 16 >> 1];
		    $5 = HEAP32[$6 + 116 >> 2] + HEAP32[$6 + 24 >> 2] | 0;
		    $7 = ($7 + Math_imul($4, $5 >> 16) | 0) + (Math_imul($5 & 65535, $4) >> 16) | 0;
		    $4 = HEAP16[$10 + 18 >> 1];
		    $5 = HEAP32[$6 + 112 >> 2] + HEAP32[$6 + 28 >> 2] | 0;
		    $7 = ($7 + Math_imul($4, $5 >> 16) | 0) + (Math_imul($5 & 65535, $4) >> 16) | 0;
		    $4 = HEAP16[$10 + 20 >> 1];
		    $5 = HEAP32[$6 + 108 >> 2] + HEAP32[$6 + 32 >> 2] | 0;
		    $7 = ($7 + Math_imul($4, $5 >> 16) | 0) + (Math_imul($5 & 65535, $4) >> 16) | 0;
		    $4 = HEAP16[$10 + 22 >> 1];
		    $5 = HEAP32[$6 + 104 >> 2] + HEAP32[$6 + 36 >> 2] | 0;
		    $7 = ($7 + Math_imul($4, $5 >> 16) | 0) + (Math_imul($5 & 65535, $4) >> 16) | 0;
		    $4 = HEAP16[$10 + 24 >> 1];
		    $5 = HEAP32[$6 + 100 >> 2] + HEAP32[$6 + 40 >> 2] | 0;
		    $7 = ($7 + Math_imul($4, $5 >> 16) | 0) + (Math_imul($5 & 65535, $4) >> 16) | 0;
		    $4 = HEAP16[$10 + 26 >> 1];
		    $5 = HEAP32[$6 + 96 >> 2] + HEAP32[$6 + 44 >> 2] | 0;
		    $7 = ($7 + Math_imul($4, $5 >> 16) | 0) + (Math_imul($5 & 65535, $4) >> 16) | 0;
		    $4 = HEAP16[$10 + 28 >> 1];
		    $5 = HEAP32[$6 + 92 >> 2] + HEAP32[$6 + 48 >> 2] | 0;
		    $7 = ($7 + Math_imul($4, $5 >> 16) | 0) + (Math_imul($5 & 65535, $4) >> 16) | 0;
		    $4 = HEAP16[$10 + 30 >> 1];
		    $5 = HEAP32[$6 + 88 >> 2] + HEAP32[$6 + 52 >> 2] | 0;
		    $7 = ($7 + Math_imul($4, $5 >> 16) | 0) + (Math_imul($5 & 65535, $4) >> 16) | 0;
		    $4 = HEAP16[$10 + 32 >> 1];
		    $5 = HEAP32[$6 + 84 >> 2] + HEAP32[$6 + 56 >> 2] | 0;
		    $7 = ($7 + Math_imul($4, $5 >> 16) | 0) + (Math_imul($5 & 65535, $4) >> 16) | 0;
		    $4 = HEAP16[$10 + 34 >> 1];
		    $5 = HEAP32[$6 + 80 >> 2] + HEAP32[$6 + 60 >> 2] | 0;
		    $7 = ($7 + Math_imul($4, $5 >> 16) | 0) + (Math_imul($5 & 65535, $4) >> 16) | 0;
		    $4 = HEAP16[$10 + 36 >> 1];
		    $5 = HEAP32[$6 + 76 >> 2] + HEAP32[$6 + 64 >> 2] | 0;
		    $4 = ($7 + Math_imul($4, $5 >> 16) | 0) + (Math_imul($5 & 65535, $4) >> 16) | 0;
		    $5 = HEAP16[$10 + 38 >> 1];
		    $6 = HEAP32[$6 + 72 >> 2] + HEAP32[$6 + 68 >> 2] | 0;
		    $6 = ($4 + Math_imul($5, $6 >> 16) | 0) + (Math_imul($6 & 65535, $5) >> 16) | 0;
		    $5 = ($6 >> 5) + 1 >> 1;
		    HEAP16[$1 >> 1] = ($6 | 0) > 2097119 ? 32767 : ($5 | 0) > -32768 ? $5 : -32768;
		    $1 = $1 + 2 | 0;
		    $8 = $8 + $15 | 0;
		    if (($14 | 0) > ($8 | 0)) {
		     continue;
		    }
		    break;
		   }
		  }
		  $3 = $3 - $13 | 0;
		  if (($3 | 0) >= 2) {
		   memcpy($12, ($13 << 2) + $12 | 0, $16 << 2);
		   $2 = ($13 << 1) + $2 | 0;
		   $5 = HEAP32[$0 + 296 >> 2];
		   $8 = HEAP32[$0 + 276 >> 2];
		   $6 = HEAP32[$0 + 268 >> 2];
		   continue;
		  }
		  break;
		 }
		 memcpy($17, ($13 << 2) + $12 | 0, $16 << 2);
		 __stack_pointer = $20;
		}
		function celt_decode_lost($0, $1, $2) {
		 var $3 = 0, $4 = 0, $5 = 0, $6 = 0, $7 = Math_fround(0), $8 = 0, $9 = Math_fround(0), $10 = 0, $11 = 0, $12 = 0, $13 = 0, $14 = 0, $15 = 0, $16 = 0, $17 = 0, $18 = Math_fround(0), $19 = 0, $20 = 0, $21 = 0, $22 = Math_fround(0), $23 = 0, $24 = 0, $25 = 0, $26 = 0, $27 = 0, $28 = Math_fround(0), $29 = 0, $30 = 0, $31 = 0, $32 = 0, $33 = 0, $34 = Math_fround(0), $35 = 0, $36 = 0, $37 = 0, $38 = 0, $39 = 0, $40 = 0, $41 = 0, $42 = 0, $43 = 0, $44 = 0, $45 = 0, $46 = 0, $47 = 0, $48 = 0, $49 = 0, $50 = 0, $51 = 0, $52 = 0, $53 = 0, $54 = 0, $55 = 0, $56 = 0, $57 = 0, $58 = 0, $59 = 0, $60 = 0, $61 = 0;
		 $10 = __stack_pointer - 4320 | 0;
		 $5 = $10;
		 __stack_pointer = $5;
		 $14 = HEAP32[$0 + 8 >> 2];
		 $26 = ($14 | 0) > 1 ? $14 : 1;
		 $33 = 0 - $1 | 0;
		 $13 = HEAP32[$0 >> 2];
		 $15 = HEAP32[$13 + 4 >> 2];
		 $8 = $15 + 2048 | 0;
		 $11 = HEAP32[$13 + 32 >> 2];
		 $17 = HEAP32[$13 + 8 >> 2];
		 while (1) {
		  $4 = $3 << 2;
		  $6 = ((Math_imul($3, $8) << 2) + $0 | 0) + 92 | 0;
		  HEAP32[$4 + ($5 + 4312 | 0) >> 2] = $6;
		  HEAP32[($5 + 4304 | 0) + $4 >> 2] = (($33 << 2) + $6 | 0) - -8192;
		  $3 = $3 + 1 | 0;
		  if (($26 | 0) != ($3 | 0)) {
		   continue;
		  }
		  break;
		 }
		 $29 = ((Math_imul($8, $14) << 2) + $0 | 0) + 92 | 0;
		 $16 = HEAP32[$0 + 20 >> 2];
		 $24 = HEAP32[$0 + 52 >> 2];
		 label$2 : {
		  if (!(HEAP32[$0 + 56 >> 2] ? 0 : !($16 | ($24 | 0) > 4))) {
		   $3 = $17 << 3;
		   $19 = Math_imul($14, 96) + $29 | 0;
		   $20 = $3 + (($19 + $3 | 0) + $3 | 0) | 0;
		   $22 = $24 ? Math_fround(.5) : Math_fround(1.5);
		   $8 = HEAP32[$0 + 24 >> 2];
		   $3 = HEAP32[$13 + 12 >> 2];
		   $25 = ($3 | 0) > ($8 | 0) ? $8 : $3;
		   $10 = $10 - ((Math_imul($1, $14) << 2) + 15 & -16) | 0;
		   __stack_pointer = $10;
		   while (1) {
		    if (($8 | 0) > ($16 | 0)) {
		     $12 = Math_imul($17, $21);
		     $3 = $16;
		     while (1) {
		      $4 = $3 + $12 << 2;
		      $6 = $19 + $4 | 0;
		      $7 = HEAPF32[$4 + $20 >> 2];
		      $9 = Math_fround(HEAPF32[$6 >> 2] - $22);
		      HEAPF32[$6 >> 2] = $7 > $9 ? $7 : $9;
		      $3 = $3 + 1 | 0;
		      if (($8 | 0) != ($3 | 0)) {
		       continue;
		      }
		      break;
		     }
		    }
		    $21 = $21 + 1 | 0;
		    if (($26 | 0) != ($21 | 0)) {
		     continue;
		    }
		    break;
		   }
		   $21 = ($16 | 0) > ($25 | 0) ? $16 : $25;
		   $4 = HEAP32[$0 + 40 >> 2];
		   if (($14 | 0) >= 1) {
		    $17 = 0;
		    while (1) {
		     if (($16 | 0) < ($25 | 0)) {
		      $20 = Math_imul($1, $17);
		      $12 = $16;
		      while (1) {
		       $8 = HEAP16[($12 << 1) + $11 >> 1];
		       $6 = ($8 << $2) + $20 | 0;
		       $3 = 0;
		       $12 = $12 + 1 | 0;
		       $8 = HEAP16[($12 << 1) + $11 >> 1] - $8 << $2;
		       if (($8 | 0) >= 1) {
		        while (1) {
		         $30 = ($3 + $6 << 2) + $10 | 0;
		         $4 = celt_lcg_rand($4);
		         HEAPF32[$30 >> 2] = $4 >> 20;
		         $3 = $3 + 1 | 0;
		         if (($8 | 0) != ($3 | 0)) {
		          continue;
		         }
		         break;
		        }
		       }
		       renormalise_vector(($6 << 2) + $10 | 0, $8, Math_fround(1), HEAP32[$0 + 36 >> 2]);
		       if (($12 | 0) != ($21 | 0)) {
		        continue;
		       }
		       break;
		      }
		     }
		     $17 = $17 + 1 | 0;
		     if (($17 | 0) != ($14 | 0)) {
		      continue;
		     }
		     break;
		    }
		   }
		   HEAP32[$0 + 40 >> 2] = $4;
		   $6 = (($15 >>> 1 | 0) - $1 << 2) - -8192 | 0;
		   $3 = 0;
		   while (1) {
		    $4 = HEAP32[($5 + 4312 | 0) + ($3 << 2) >> 2];
		    memmove($4, ($1 << 2) + $4 | 0, $6);
		    $3 = $3 + 1 | 0;
		    if (($26 | 0) != ($3 | 0)) {
		     continue;
		    }
		    break;
		   }
		   celt_synthesis($13, $10, $5 + 4304 | 0, $19, $16, $21, $14, $14, 0, $2, HEAP32[$0 + 16 >> 2], 0, HEAP32[$0 + 36 >> 2]);
		   break label$2;
		  }
		  label$15 : {
		   if (!$24) {
		    $3 = HEAP32[$0 + 36 >> 2];
		    pitch_downsample($5 + 4312 | 0, $5 + 112 | 0, 2048, $14, $3);
		    pitch_search($5 + 1552 | 0, $5 + 112 | 0, 1328, 620, $5, $3);
		    $2 = 720 - HEAP32[$5 >> 2] | 0;
		    HEAP32[$0 + 48 >> 2] = $2;
		    $34 = Math_fround(1);
		    break label$15;
		   }
		   $2 = HEAP32[$0 + 48 >> 2];
		   $34 = Math_fround(.800000011920929);
		  }
		  $3 = $2 << 1;
		  $27 = ($3 | 0) < 1024 ? $3 : 1024;
		  $3 = $27 >> 1;
		  $21 = ($3 | 0) > 1 ? $3 : 1;
		  $20 = $10 - (($15 << 2) + 15 & -16) | 0;
		  $4 = $20;
		  __stack_pointer = $4;
		  $16 = 1024 - $27 | 0;
		  $17 = 1024 - $3 | 0;
		  $31 = $27 << 2;
		  $35 = ($5 - $31 | 0) + 4304 | 0;
		  $25 = ($15 | 0) / 2 | 0;
		  $14 = 1024 - $2 | 0;
		  $12 = $1 + $15 | 0;
		  $38 = $12 << 2;
		  $10 = 2048 - $1 | 0;
		  $36 = $10 << 2;
		  $32 = $4 - ($31 + 15 & -16) | 0;
		  __stack_pointer = $32;
		  $8 = $5 + 208 | 0;
		  $19 = HEAP32[$13 + 60 >> 2];
		  $39 = 2047 - $1 << 2;
		  $40 = 2046 - $1 << 2;
		  $41 = 2045 - $1 << 2;
		  $42 = 2044 - $1 << 2;
		  $43 = 2043 - $1 << 2;
		  $44 = 2042 - $1 << 2;
		  $45 = 2041 - $1 << 2;
		  $46 = 2040 - $1 << 2;
		  $47 = 2039 - $1 << 2;
		  $48 = 2038 - $1 << 2;
		  $49 = 2037 - $1 << 2;
		  $50 = 2036 - $1 << 2;
		  $51 = 2035 - $1 << 2;
		  $52 = 2034 - $1 << 2;
		  $53 = 2033 - $1 << 2;
		  $54 = 2032 - $1 << 2;
		  $55 = 2031 - $1 << 2;
		  $56 = 2030 - $1 << 2;
		  $57 = 2029 - $1 << 2;
		  $58 = 2028 - $1 << 2;
		  $59 = 2027 - $1 << 2;
		  $60 = 2026 - $1 << 2;
		  $61 = 2025 - $1 << 2;
		  $30 = 2024 - $1 << 2;
		  $13 = 0;
		  while (1) {
		   $6 = HEAP32[($5 + 4312 | 0) + ($13 << 2) >> 2];
		   $3 = 0;
		   while (1) {
		    $4 = $3 << 2;
		    HEAP32[$4 + ($5 + 112 | 0) >> 2] = HEAP32[($4 + $6 | 0) + 4e3 >> 2];
		    $3 = $3 + 1 | 0;
		    if (($3 | 0) != 1048) {
		     continue;
		    }
		    break;
		   }
		   label$19 : {
		    if ($24) {
		     $3 = Math_imul($13, 24);
		     break label$19;
		    }
		    _celt_autocorr($8, $5, $19, $15, 24, 1024, HEAP32[$0 + 36 >> 2]);
		    HEAPF32[$5 >> 2] = HEAPF32[$5 >> 2] * Math_fround(1.000100016593933);
		    $3 = 1;
		    while (1) {
		     $4 = ($3 << 2) + $5 | 0;
		     $7 = HEAPF32[$4 >> 2];
		     $28 = $7;
		     $18 = Math_fround($7 * Math_fround(-6400000711437315e-20));
		     $7 = Math_fround($3 | 0);
		     HEAPF32[$4 >> 2] = $28 + Math_fround(Math_fround($18 * $7) * $7);
		     $3 = $3 + 1 | 0;
		     if (($3 | 0) != 25) {
		      continue;
		     }
		     break;
		    }
		    $3 = Math_imul($13, 24);
		    _celt_lpc(($3 << 2) + $29 | 0, $5, 24);
		   }
		   $37 = ($3 << 2) + $29 | 0;
		   celt_fir_c($35, $37, $32, $27, 24, HEAP32[$0 + 36 >> 2]);
		   memcpy($35, $32, $31);
		   $7 = Math_fround(1);
		   $3 = 0;
		   $18 = Math_fround(1);
		   if (($2 | 0) >= 1) {
		    while (1) {
		     $9 = HEAPF32[($3 + $16 << 2) + $8 >> 2];
		     $7 = Math_fround($7 + Math_fround($9 * $9));
		     $9 = HEAPF32[($3 + $17 << 2) + $8 >> 2];
		     $18 = Math_fround($18 + Math_fround($9 * $9));
		     $3 = $3 + 1 | 0;
		     if (($21 | 0) != ($3 | 0)) {
		      continue;
		     }
		     break;
		    }
		   }
		   $3 = memmove($6, ($1 << 2) + $6 | 0, $36);
		   $22 = Math_fround(0);
		   $9 = Math_fround(0);
		   $23 = ($12 | 0) < 1;
		   if (!$23) {
		    $28 = Math_fround(Math_sqrt(Math_fround(($7 > $18 ? $18 : $7) / $7)));
		    $7 = Math_fround($34 * $28);
		    $4 = 0;
		    $6 = 0;
		    while (1) {
		     $11 = ($2 | 0) > ($6 | 0);
		     $7 = $11 ? $7 : Math_fround($28 * $7);
		     $6 = $6 - ($11 ? 0 : $2) | 0;
		     $11 = $14 + $6 | 0;
		     HEAPF32[($4 + $10 << 2) + $3 >> 2] = $7 * HEAPF32[($11 << 2) + $8 >> 2];
		     $6 = $6 + 1 | 0;
		     $18 = HEAPF32[(($11 - $1 << 2) + $3 | 0) + 4096 >> 2];
		     $9 = Math_fround($9 + Math_fround($18 * $18));
		     $4 = $4 + 1 | 0;
		     if (($12 | 0) != ($4 | 0)) {
		      continue;
		     }
		     break;
		    }
		   }
		   HEAP32[$5 >> 2] = HEAP32[$3 + $39 >> 2];
		   HEAP32[$5 + 4 >> 2] = HEAP32[$3 + $40 >> 2];
		   HEAP32[$5 + 8 >> 2] = HEAP32[$3 + $41 >> 2];
		   HEAP32[$5 + 12 >> 2] = HEAP32[$3 + $42 >> 2];
		   HEAP32[$5 + 16 >> 2] = HEAP32[$3 + $43 >> 2];
		   HEAP32[$5 + 20 >> 2] = HEAP32[$3 + $44 >> 2];
		   HEAP32[$5 + 24 >> 2] = HEAP32[$3 + $45 >> 2];
		   HEAP32[$5 + 28 >> 2] = HEAP32[$3 + $46 >> 2];
		   HEAP32[$5 + 32 >> 2] = HEAP32[$3 + $47 >> 2];
		   HEAP32[$5 + 36 >> 2] = HEAP32[$3 + $48 >> 2];
		   HEAP32[$5 + 40 >> 2] = HEAP32[$3 + $49 >> 2];
		   HEAP32[$5 + 44 >> 2] = HEAP32[$3 + $50 >> 2];
		   HEAP32[$5 + 48 >> 2] = HEAP32[$3 + $51 >> 2];
		   HEAP32[$5 + 52 >> 2] = HEAP32[$3 + $52 >> 2];
		   HEAP32[$5 + 56 >> 2] = HEAP32[$3 + $53 >> 2];
		   HEAP32[$5 + 60 >> 2] = HEAP32[$3 + $54 >> 2];
		   HEAP32[$5 + 64 >> 2] = HEAP32[$3 + $55 >> 2];
		   HEAP32[$5 + 68 >> 2] = HEAP32[$3 + $56 >> 2];
		   HEAP32[$5 + 72 >> 2] = HEAP32[$3 + $57 >> 2];
		   HEAP32[$5 + 76 >> 2] = HEAP32[$3 + $58 >> 2];
		   HEAP32[$5 + 80 >> 2] = HEAP32[$3 + $59 >> 2];
		   HEAP32[$5 + 84 >> 2] = HEAP32[$3 + $60 >> 2];
		   HEAP32[$5 + 88 >> 2] = HEAP32[$3 + $61 >> 2];
		   HEAP32[$5 + 92 >> 2] = HEAP32[$3 + $30 >> 2];
		   $11 = $3 - -8192 | 0;
		   $4 = $11 + ($33 << 2) | 0;
		   celt_iir($4, $37, $4, $12, 24, $5, HEAP32[$0 + 36 >> 2]);
		   $4 = 0;
		   label$26 : {
		    label$27 : {
		     if (!$23) {
		      while (1) {
		       $7 = HEAPF32[($4 + $10 << 2) + $3 >> 2];
		       $22 = Math_fround($22 + Math_fround($7 * $7));
		       $4 = $4 + 1 | 0;
		       if (($12 | 0) != ($4 | 0)) {
		        continue;
		       }
		       break;
		      }
		      if (Math_fround($22 * Math_fround(.20000000298023224)) < $9) {
		       break label$27;
		      }
		      if ($23) {
		       break label$26;
		      }
		      memset($3 + $36 | 0, 0, $38);
		      break label$26;
		     }
		     if (!($9 > Math_fround(0))) {
		      break label$26;
		     }
		    }
		    if ($9 < $22 ^ 1) {
		     break label$26;
		    }
		    $7 = Math_fround(Math_sqrt(Math_fround(Math_fround($9 + Math_fround(1)) / Math_fround($22 + Math_fround(1)))));
		    if (($15 | 0) >= 1) {
		     $9 = Math_fround(Math_fround(1) - $7);
		     $4 = 0;
		     while (1) {
		      $6 = ($4 + $10 << 2) + $3 | 0;
		      HEAPF32[$6 >> 2] = HEAPF32[$6 >> 2] * Math_fround(Math_fround(1) - Math_fround($9 * HEAPF32[($4 << 2) + $19 >> 2]));
		      $4 = $4 + 1 | 0;
		      if (($15 | 0) != ($4 | 0)) {
		       continue;
		      }
		      break;
		     }
		    }
		    $4 = $15;
		    if (($1 | 0) <= 0) {
		     break label$26;
		    }
		    while (1) {
		     $6 = ($4 + $10 << 2) + $3 | 0;
		     HEAPF32[$6 >> 2] = $7 * HEAPF32[$6 >> 2];
		     $4 = $4 + 1 | 0;
		     if (($12 | 0) > ($4 | 0)) {
		      continue;
		     }
		     break;
		    }
		   }
		   $4 = 0;
		   $6 = HEAP32[$0 + 60 >> 2];
		   $7 = Math_fround(-HEAPF32[$0 + 68 >> 2]);
		   $23 = HEAP32[$0 + 76 >> 2];
		   comb_filter($20, $11, $6, $6, $15, $7, $7, $23, $23, 0, 0, HEAP32[$0 + 36 >> 2]);
		   if (($15 | 0) >= 2) {
		    while (1) {
		     $6 = $4 << 2;
		     $11 = ($4 ^ -1) + $15 << 2;
		     HEAPF32[($6 + $3 | 0) - -8192 >> 2] = Math_fround(HEAPF32[$6 + $19 >> 2] * HEAPF32[$20 + $11 >> 2]) + Math_fround(HEAPF32[$11 + $19 >> 2] * HEAPF32[$6 + $20 >> 2]);
		     $4 = $4 + 1 | 0;
		     if (($25 | 0) != ($4 | 0)) {
		      continue;
		     }
		     break;
		    }
		   }
		   $13 = $13 + 1 | 0;
		   if (($26 | 0) != ($13 | 0)) {
		    continue;
		   }
		   break;
		  }
		 }
		 HEAP32[$0 + 52 >> 2] = $24 + 1;
		 __stack_pointer = $5 + 4320 | 0;
		}
		function __rem_pio2_large($0, $1, $2, $3, $4) {
		 var $5 = 0, $6 = 0, $7 = 0, $8 = 0, $9 = 0, $10 = 0, $11 = 0, $12 = 0, $13 = 0, $14 = 0, $15 = 0, $16 = 0, $17 = 0, $18 = 0, $19 = 0, $20 = 0, $21 = 0, $22 = 0, $23 = 0, $24 = 0;
		 $8 = __stack_pointer - 560 | 0;
		 __stack_pointer = $8;
		 $7 = ($2 - 3 | 0) / 24 | 0;
		 $19 = ($7 | 0) > 0 ? $7 : 0;
		 $13 = Math_imul($19, -24) + $2 | 0;
		 $12 = HEAP32[($4 << 2) + 25088 >> 2];
		 $15 = $3 - 1 | 0;
		 if (($12 + $15 | 0) >= 0) {
		  $6 = $3 + $12 | 0;
		  $2 = $19 - $15 | 0;
		  $7 = 0;
		  while (1) {
		   $5 = ($2 | 0) < 0 ? 0 : +HEAP32[($2 << 2) + 25104 >> 2];
		   HEAPF64[($8 + 320 | 0) + ($7 << 3) >> 3] = $5;
		   $2 = $2 + 1 | 0;
		   $7 = $7 + 1 | 0;
		   if (($7 | 0) != ($6 | 0)) {
		    continue;
		   }
		   break;
		  }
		 }
		 $18 = $13 - 24 | 0;
		 $6 = 0;
		 $10 = ($12 | 0) > 0 ? $12 : 0;
		 $11 = ($3 | 0) < 1;
		 while (1) {
		  label$6 : {
		   if ($11) {
		    $5 = 0;
		    break label$6;
		   }
		   $7 = $6 + $15 | 0;
		   $2 = 0;
		   $5 = 0;
		   while (1) {
		    $5 = $5 + HEAPF64[($2 << 3) + $0 >> 3] * HEAPF64[($8 + 320 | 0) + ($7 - $2 << 3) >> 3];
		    $2 = $2 + 1 | 0;
		    if (($3 | 0) != ($2 | 0)) {
		     continue;
		    }
		    break;
		   }
		  }
		  HEAPF64[($6 << 3) + $8 >> 3] = $5;
		  $2 = ($6 | 0) == ($10 | 0);
		  $6 = $6 + 1 | 0;
		  if (!$2) {
		   continue;
		  }
		  break;
		 }
		 $23 = 47 - $13 | 0;
		 $21 = 48 - $13 | 0;
		 $24 = $13 - 25 | 0;
		 $6 = $12;
		 label$9 : {
		  while (1) {
		   $5 = HEAPF64[($6 << 3) + $8 >> 3];
		   $2 = 0;
		   $7 = $6;
		   $15 = ($6 | 0) < 1;
		   if (!$15) {
		    while (1) {
		     $10 = $2 << 2;
		     $10 = $10 + ($8 + 480 | 0) | 0;
		     $16 = $5;
		     $9 = $5 * 5.960464477539063e-8;
		     label$14 : {
		      if (Math_abs($9) < 2147483648) {
		       $11 = ~~$9;
		       break label$14;
		      }
		      $11 = -2147483648;
		     }
		     $9 = +($11 | 0);
		     $5 = $16 + $9 * -16777216;
		     label$13 : {
		      if (Math_abs($5) < 2147483648) {
		       $11 = ~~$5;
		       break label$13;
		      }
		      $11 = -2147483648;
		     }
		     HEAP32[$10 >> 2] = $11;
		     $7 = $7 - 1 | 0;
		     $5 = HEAPF64[($7 << 3) + $8 >> 3] + $9;
		     $2 = $2 + 1 | 0;
		     if (($6 | 0) != ($2 | 0)) {
		      continue;
		     }
		     break;
		    }
		   }
		   $5 = scalbn($5, $18);
		   $5 = $5 + floor($5 * .125) * -8;
		   label$17 : {
		    if (Math_abs($5) < 2147483648) {
		     $17 = ~~$5;
		     break label$17;
		    }
		    $17 = -2147483648;
		   }
		   $5 = $5 - +($17 | 0);
		   label$19 : {
		    label$20 : {
		     label$21 : {
		      $22 = ($18 | 0) < 1;
		      label$22 : {
		       if (!$22) {
		        $7 = ($6 << 2) + $8 | 0;
		        $2 = $7 + 476 | 0;
		        $11 = $2;
		        $2 = HEAP32[$7 + 476 >> 2];
		        $7 = $2;
		        $2 = $2 >> $21;
		        $7 = $7 - ($2 << $21) | 0;
		        HEAP32[$11 >> 2] = $7;
		        $17 = $2 + $17 | 0;
		        $14 = $7 >> $23;
		        break label$22;
		       }
		       if ($18) {
		        break label$21;
		       }
		       $14 = HEAP32[(($6 << 2) + $8 | 0) + 476 >> 2] >> 23;
		      }
		      if (($14 | 0) < 1) {
		       break label$19;
		      }
		      break label$20;
		     }
		     $14 = 2;
		     if (!($5 >= .5 ^ 1)) {
		      break label$20;
		     }
		     $14 = 0;
		     break label$19;
		    }
		    $2 = 0;
		    $11 = 0;
		    if (!$15) {
		     while (1) {
		      $15 = ($8 + 480 | 0) + ($2 << 2) | 0;
		      $7 = HEAP32[$15 >> 2];
		      $10 = 16777215;
		      label$26 : {
		       label$27 : {
		        if ($11) {
		         break label$27;
		        }
		        $10 = 16777216;
		        if ($7) {
		         break label$27;
		        }
		        $11 = 0;
		        break label$26;
		       }
		       HEAP32[$15 >> 2] = $10 - $7;
		       $11 = 1;
		      }
		      $2 = $2 + 1 | 0;
		      if (($6 | 0) != ($2 | 0)) {
		       continue;
		      }
		      break;
		     }
		    }
		    label$28 : {
		     if ($22) {
		      break label$28;
		     }
		     label$29 : {
		      switch ($24 | 0) {
		      case 0:
		       $7 = ($6 << 2) + $8 | 0;
		       $2 = $7 + 476 | 0;
		       HEAP32[$2 >> 2] = HEAP32[$7 + 476 >> 2] & 8388607;
		       break label$28;
		      case 1:
		       break label$29;
		      default:
		       break label$28;
		      }
		     }
		     $7 = ($6 << 2) + $8 | 0;
		     $2 = $7 + 476 | 0;
		     HEAP32[$2 >> 2] = HEAP32[$7 + 476 >> 2] & 4194303;
		    }
		    $17 = $17 + 1 | 0;
		    if (($14 | 0) != 2) {
		     break label$19;
		    }
		    $5 = 1 - $5;
		    $14 = 2;
		    if (!$11) {
		     break label$19;
		    }
		    $5 = $5 - scalbn(1, $18);
		   }
		   if ($5 == 0) {
		    $7 = 0;
		    label$32 : {
		     $2 = $6;
		     if (($12 | 0) >= ($2 | 0)) {
		      break label$32;
		     }
		     while (1) {
		      $2 = $2 - 1 | 0;
		      $7 = HEAP32[($8 + 480 | 0) + ($2 << 2) >> 2] | $7;
		      if (($2 | 0) > ($12 | 0)) {
		       continue;
		      }
		      break;
		     }
		     if (!$7) {
		      break label$32;
		     }
		     $13 = $18;
		     while (1) {
		      $13 = $13 - 24 | 0;
		      $6 = $6 - 1 | 0;
		      if (!HEAP32[($8 + 480 | 0) + ($6 << 2) >> 2]) {
		       continue;
		      }
		      break;
		     }
		     break label$9;
		    }
		    $2 = 1;
		    while (1) {
		     $7 = $2;
		     $2 = $2 + 1 | 0;
		     if (!HEAP32[($8 + 480 | 0) + ($12 - $7 << 2) >> 2]) {
		      continue;
		     }
		     break;
		    }
		    $10 = $6 + $7 | 0;
		    while (1) {
		     $7 = $3 + $6 | 0;
		     $6 = $6 + 1 | 0;
		     HEAPF64[($8 + 320 | 0) + ($7 << 3) >> 3] = HEAP32[($19 + $6 << 2) + 25104 >> 2];
		     $2 = 0;
		     $5 = 0;
		     if (($3 | 0) >= 1) {
		      while (1) {
		       $5 = $5 + HEAPF64[($2 << 3) + $0 >> 3] * HEAPF64[($8 + 320 | 0) + ($7 - $2 << 3) >> 3];
		       $2 = $2 + 1 | 0;
		       if (($3 | 0) != ($2 | 0)) {
		        continue;
		       }
		       break;
		      }
		     }
		     HEAPF64[($6 << 3) + $8 >> 3] = $5;
		     if (($6 | 0) < ($10 | 0)) {
		      continue;
		     }
		     break;
		    }
		    $6 = $10;
		    continue;
		   }
		   break;
		  }
		  $5 = scalbn($5, 24 - $13 | 0);
		  label$39 : {
		   if (!($5 >= 16777216 ^ 1)) {
		    $3 = $6 << 2;
		    $3 = $3 + ($8 + 480 | 0) | 0;
		    $16 = $5;
		    $9 = $5 * 5.960464477539063e-8;
		    label$42 : {
		     if (Math_abs($9) < 2147483648) {
		      $2 = ~~$9;
		      break label$42;
		     }
		     $2 = -2147483648;
		    }
		    $5 = $16 + +($2 | 0) * -16777216;
		    label$41 : {
		     if (Math_abs($5) < 2147483648) {
		      $7 = ~~$5;
		      break label$41;
		     }
		     $7 = -2147483648;
		    }
		    HEAP32[$3 >> 2] = $7;
		    $6 = $6 + 1 | 0;
		    break label$39;
		   }
		   if (Math_abs($5) < 2147483648) {
		    $2 = ~~$5;
		   } else {
		    $2 = -2147483648;
		   }
		   $13 = $18;
		  }
		  HEAP32[($8 + 480 | 0) + ($6 << 2) >> 2] = $2;
		 }
		 $5 = scalbn(1, $13);
		 label$47 : {
		  if (($6 | 0) <= -1) {
		   break label$47;
		  }
		  $2 = $6;
		  while (1) {
		   HEAPF64[($2 << 3) + $8 >> 3] = $5 * +HEAP32[($8 + 480 | 0) + ($2 << 2) >> 2];
		   $5 = $5 * 5.960464477539063e-8;
		   $3 = ($2 | 0) > 0;
		   $2 = $2 - 1 | 0;
		   if ($3) {
		    continue;
		   }
		   break;
		  }
		  $10 = 0;
		  if (($6 | 0) < 0) {
		   break label$47;
		  }
		  $12 = ($12 | 0) > 0 ? $12 : 0;
		  $7 = $6;
		  while (1) {
		   $0 = $10 >>> 0 > $12 >>> 0 ? $12 : $10;
		   $11 = $6 - $7 | 0;
		   $2 = 0;
		   $5 = 0;
		   while (1) {
		    $5 = $5 + HEAPF64[($2 << 3) + 27872 >> 3] * HEAPF64[($2 + $7 << 3) + $8 >> 3];
		    $3 = ($0 | 0) != ($2 | 0);
		    $2 = $2 + 1 | 0;
		    if ($3) {
		     continue;
		    }
		    break;
		   }
		   HEAPF64[($8 + 160 | 0) + ($11 << 3) >> 3] = $5;
		   $7 = $7 - 1 | 0;
		   $2 = ($6 | 0) != ($10 | 0);
		   $10 = $10 + 1 | 0;
		   if ($2) {
		    continue;
		   }
		   break;
		  }
		 }
		 label$51 : {
		  label$52 : {
		   label$53 : {
		    switch ($4 | 0) {
		    case 3:
		     label$56 : {
		      if (($6 | 0) < 1) {
		       break label$56;
		      }
		      $5 = HEAPF64[($8 + 160 | 0) + ($6 << 3) >> 3];
		      $2 = $6;
		      while (1) {
		       $3 = $2 - 1 | 0;
		       $7 = ($8 + 160 | 0) + ($3 << 3) | 0;
		       $9 = HEAPF64[$7 >> 3];
		       $16 = $9;
		       $9 = $9 + $5;
		       HEAPF64[($8 + 160 | 0) + ($2 << 3) >> 3] = $5 + ($16 - $9);
		       HEAPF64[$7 >> 3] = $9;
		       $7 = ($2 | 0) > 1;
		       $5 = $9;
		       $2 = $3;
		       if ($7) {
		        continue;
		       }
		       break;
		      }
		      if (($6 | 0) < 2) {
		       break label$56;
		      }
		      $5 = HEAPF64[($8 + 160 | 0) + ($6 << 3) >> 3];
		      $2 = $6;
		      while (1) {
		       $3 = $2 - 1 | 0;
		       $7 = ($8 + 160 | 0) + ($3 << 3) | 0;
		       $9 = HEAPF64[$7 >> 3];
		       $16 = $9;
		       $9 = $9 + $5;
		       HEAPF64[($8 + 160 | 0) + ($2 << 3) >> 3] = $5 + ($16 - $9);
		       HEAPF64[$7 >> 3] = $9;
		       $7 = ($2 | 0) > 2;
		       $5 = $9;
		       $2 = $3;
		       if ($7) {
		        continue;
		       }
		       break;
		      }
		      if (($6 | 0) <= 1) {
		       break label$56;
		      }
		      while (1) {
		       $20 = $20 + HEAPF64[($8 + 160 | 0) + ($6 << 3) >> 3];
		       $2 = ($6 | 0) > 2;
		       $6 = $6 - 1 | 0;
		       if ($2) {
		        continue;
		       }
		       break;
		      }
		     }
		     $5 = HEAPF64[$8 + 160 >> 3];
		     if ($14) {
		      break label$52;
		     }
		     HEAPF64[$1 >> 3] = $5;
		     $5 = HEAPF64[$8 + 168 >> 3];
		     HEAPF64[$1 + 16 >> 3] = $20;
		     HEAPF64[$1 + 8 >> 3] = $5;
		     break label$51;
		    case 0:
		     $5 = 0;
		     if (($6 | 0) >= 0) {
		      while (1) {
		       $5 = $5 + HEAPF64[($8 + 160 | 0) + ($6 << 3) >> 3];
		       $2 = ($6 | 0) > 0;
		       $6 = $6 - 1 | 0;
		       if ($2) {
		        continue;
		       }
		       break;
		      }
		     }
		     HEAPF64[$1 >> 3] = $14 ? -$5 : $5;
		     break label$51;
		    case 1:
		    case 2:
		     break label$53;
		    default:
		     break label$51;
		    }
		   }
		   $5 = 0;
		   if (($6 | 0) >= 0) {
		    $2 = $6;
		    while (1) {
		     $5 = $5 + HEAPF64[($8 + 160 | 0) + ($2 << 3) >> 3];
		     $3 = ($2 | 0) > 0;
		     $2 = $2 - 1 | 0;
		     if ($3) {
		      continue;
		     }
		     break;
		    }
		   }
		   HEAPF64[$1 >> 3] = $14 ? -$5 : $5;
		   $5 = HEAPF64[$8 + 160 >> 3] - $5;
		   $2 = 1;
		   if (($6 | 0) >= 1) {
		    while (1) {
		     $5 = $5 + HEAPF64[($8 + 160 | 0) + ($2 << 3) >> 3];
		     $3 = ($2 | 0) != ($6 | 0);
		     $2 = $2 + 1 | 0;
		     if ($3) {
		      continue;
		     }
		     break;
		    }
		   }
		   HEAPF64[$1 + 8 >> 3] = $14 ? -$5 : $5;
		   break label$51;
		  }
		  HEAPF64[$1 >> 3] = -$5;
		  $5 = HEAPF64[$8 + 168 >> 3];
		  HEAPF64[$1 + 16 >> 3] = -$20;
		  HEAPF64[$1 + 8 >> 3] = -$5;
		 }
		 __stack_pointer = $8 + 560 | 0;
		 return $17 & 7;
		}
		function quant_band($0, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10) {
		 var $11 = 0, $12 = 0, $13 = 0, $14 = 0, $15 = 0, $16 = Math_fround(0), $17 = Math_fround(0), $18 = 0, $19 = 0, $20 = 0, $21 = 0, $22 = 0, $23 = 0, $24 = 0, $25 = 0;
		 $22 = ($2 >>> 0) / ($4 >>> 0) | 0;
		 $24 = HEAP32[$0 >> 2];
		 label$1 : {
		  if (($2 | 0) == 1) {
		   $5 = 0;
		   if (HEAP32[$0 + 32 >> 2] >= 8) {
		    $9 = HEAP32[$0 + 28 >> 2];
		    label$4 : {
		     if ($24) {
		      $5 = HEAPF32[$1 >> 2] < Math_fround(0);
		      ec_enc_bits($9, $5, 1);
		      break label$4;
		     }
		     $5 = ec_dec_bits($9, 1);
		    }
		    HEAP32[$0 + 32 >> 2] = HEAP32[$0 + 32 >> 2] - 8;
		   }
		   if (HEAP32[$0 + 4 >> 2]) {
		    HEAPF32[$1 >> 2] = $5 ? Math_fround(-1) : Math_fround(1);
		   }
		   $10 = 1;
		   if (!$7) {
		    break label$1;
		   }
		   HEAP32[$7 >> 2] = HEAP32[$1 >> 2];
		   return 1;
		  }
		  $21 = HEAP32[$0 + 24 >> 2];
		  $11 = ($21 | 0) > 0;
		  label$7 : {
		   if (!$5) {
		    $9 = $5;
		    break label$7;
		   }
		   if (!$9) {
		    $9 = $5;
		    break label$7;
		   }
		   if (!(!($22 & 1) & ($21 | 0) != 0 | (($21 | 0) > 0 | ($4 | 0) > 1))) {
		    $9 = $5;
		    break label$7;
		   }
		   memcpy($9, $5, $2 << 2);
		  }
		  $19 = $11 ? $21 : 0;
		  if (($21 | 0) >= 1) {
		   while (1) {
		    label$13 : {
		     if ($24) {
		      if (($12 | 0) == 31) {
		       break label$13;
		      }
		      $15 = $2 >> $12;
		      $5 = $15 >> 1;
		      $20 = ($5 | 0) > 1 ? $5 : 1;
		      $14 = 1 << $12;
		      $18 = $14 << 1;
		      $11 = 0;
		      while (1) {
		       $5 = 0;
		       if (($15 | 0) >= 2) {
		        while (1) {
		         $13 = (Math_imul($5, $18) + $11 << 2) + $1 | 0;
		         $23 = $13;
		         $16 = Math_fround(HEAPF32[$13 >> 2] * Math_fround(.7071067690849304));
		         $13 = ((($5 << 1 | 1) << $12) + $11 << 2) + $1 | 0;
		         $17 = Math_fround(HEAPF32[$13 >> 2] * Math_fround(.7071067690849304));
		         HEAPF32[$23 >> 2] = $16 + $17;
		         HEAPF32[$13 >> 2] = $16 - $17;
		         $5 = $5 + 1 | 0;
		         if (($20 | 0) != ($5 | 0)) {
		          continue;
		         }
		         break;
		        }
		       }
		       $11 = $11 + 1 | 0;
		       if (($14 | 0) != ($11 | 0)) {
		        continue;
		       }
		       break;
		      }
		     }
		     if (!$9 | ($12 | 0) == 31) {
		      break label$13;
		     }
		     $15 = $2 >> $12;
		     $5 = $15 >> 1;
		     $20 = ($5 | 0) > 1 ? $5 : 1;
		     $14 = 1 << $12;
		     $18 = $14 << 1;
		     $11 = 0;
		     while (1) {
		      $5 = 0;
		      if (($15 | 0) >= 2) {
		       while (1) {
		        $13 = (Math_imul($5, $18) + $11 << 2) + $9 | 0;
		        $23 = $13;
		        $16 = Math_fround(HEAPF32[$13 >> 2] * Math_fround(.7071067690849304));
		        $13 = ((($5 << 1 | 1) << $12) + $11 << 2) + $9 | 0;
		        $17 = Math_fround(HEAPF32[$13 >> 2] * Math_fround(.7071067690849304));
		        HEAPF32[$23 >> 2] = $16 + $17;
		        HEAPF32[$13 >> 2] = $16 - $17;
		        $5 = $5 + 1 | 0;
		        if (($20 | 0) != ($5 | 0)) {
		         continue;
		        }
		        break;
		       }
		      }
		      $11 = $11 + 1 | 0;
		      if (($14 | 0) != ($11 | 0)) {
		       continue;
		      }
		      break;
		     }
		    }
		    $10 = HEAPU8[($10 & 15) + 33536 | 0] | HEAPU8[($10 >> 4) + 33536 | 0] << 2;
		    $12 = $12 + 1 | 0;
		    if (($19 | 0) != ($12 | 0)) {
		     continue;
		    }
		    break;
		   }
		  }
		  $12 = $4 >> $19;
		  $15 = $22 << $19;
		  label$21 : {
		   if (!($15 & 1 | ($21 | 0) > -1)) {
		    $22 = $21;
		    while (1) {
		     if (!(!$24 | ($12 | 0) < 1)) {
		      $5 = $15 >> 1;
		      $20 = ($5 | 0) > 1 ? $5 : 1;
		      $18 = $12 << 1;
		      $11 = 0;
		      while (1) {
		       $5 = 0;
		       if (($15 | 0) >= 2) {
		        while (1) {
		         $13 = (Math_imul($5, $18) + $11 << 2) + $1 | 0;
		         $14 = $13;
		         $16 = Math_fround(HEAPF32[$13 >> 2] * Math_fround(.7071067690849304));
		         $13 = (Math_imul($5 << 1 | 1, $12) + $11 << 2) + $1 | 0;
		         $17 = Math_fround(HEAPF32[$13 >> 2] * Math_fround(.7071067690849304));
		         HEAPF32[$14 >> 2] = $16 + $17;
		         HEAPF32[$13 >> 2] = $16 - $17;
		         $5 = $5 + 1 | 0;
		         if (($20 | 0) != ($5 | 0)) {
		          continue;
		         }
		         break;
		        }
		       }
		       $11 = $11 + 1 | 0;
		       if (($12 | 0) != ($11 | 0)) {
		        continue;
		       }
		       break;
		      }
		     }
		     $14 = $15 >> 1;
		     if (!(!$9 | ($12 | 0) < 1)) {
		      $20 = ($14 | 0) > 1 ? $14 : 1;
		      $18 = $12 << 1;
		      $11 = 0;
		      while (1) {
		       $5 = 0;
		       if (($15 | 0) >= 2) {
		        while (1) {
		         $13 = (Math_imul($5, $18) + $11 << 2) + $9 | 0;
		         $23 = $13;
		         $16 = Math_fround(HEAPF32[$13 >> 2] * Math_fround(.7071067690849304));
		         $13 = (Math_imul($5 << 1 | 1, $12) + $11 << 2) + $9 | 0;
		         $17 = Math_fround(HEAPF32[$13 >> 2] * Math_fround(.7071067690849304));
		         HEAPF32[$23 >> 2] = $16 + $17;
		         HEAPF32[$13 >> 2] = $16 - $17;
		         $5 = $5 + 1 | 0;
		         if (($20 | 0) != ($5 | 0)) {
		          continue;
		         }
		         break;
		        }
		       }
		       $11 = $11 + 1 | 0;
		       if (($12 | 0) != ($11 | 0)) {
		        continue;
		       }
		       break;
		      }
		     }
		     $25 = $25 + 1 | 0;
		     $5 = $12 << 1;
		     $10 = $10 << $12 | $10;
		     if ($15 & 2) {
		      break label$21;
		     }
		     $11 = ($22 | 0) < -1;
		     $22 = $22 + 1 | 0;
		     $12 = $5;
		     $15 = $14;
		     if ($11) {
		      continue;
		     }
		     break;
		    }
		    break label$21;
		   }
		   $14 = $15;
		   $5 = $12;
		  }
		  $11 = ($4 | 0) == 1;
		  label$32 : {
		   if (($5 | 0) < 2) {
		    break label$32;
		   }
		   if ($24) {
		    deinterleave_hadamard($1, $14 >> $19, $5 << $19, $11);
		   }
		   if (!$9) {
		    break label$32;
		   }
		   deinterleave_hadamard($9, $14 >> $19, $5 << $19, $11);
		  }
		  $10 = quant_partition($0, $1, $2, $3, $5, $9, $6, $8, $10);
		  if (!HEAP32[$0 + 4 >> 2]) {
		   break label$1;
		  }
		  if (($5 | 0) >= 2) {
		   interleave_hadamard($1, $14 >> $19, $5 << $19, $11);
		  }
		  label$35 : {
		   if (!$25) {
		    $13 = $5;
		    break label$35;
		   }
		   $18 = 0;
		   while (1) {
		    $14 = $14 << 1;
		    $13 = $5 >> 1;
		    $15 = $10 >>> $13 | 0;
		    if (($5 | 0) >= 2) {
		     $9 = $14 >> 1;
		     $12 = ($9 | 0) > 1 ? $9 : 1;
		     $20 = $5 & -2;
		     $9 = 0;
		     while (1) {
		      $5 = 0;
		      if (($14 | 0) >= 2) {
		       while (1) {
		        $11 = (Math_imul($5, $20) + $9 << 2) + $1 | 0;
		        $0 = $11;
		        $16 = Math_fround(HEAPF32[$11 >> 2] * Math_fround(.7071067690849304));
		        $11 = (Math_imul($5 << 1 | 1, $13) + $9 << 2) + $1 | 0;
		        $17 = Math_fround(HEAPF32[$11 >> 2] * Math_fround(.7071067690849304));
		        HEAPF32[$0 >> 2] = $16 + $17;
		        HEAPF32[$11 >> 2] = $16 - $17;
		        $5 = $5 + 1 | 0;
		        if (($12 | 0) != ($5 | 0)) {
		         continue;
		        }
		        break;
		       }
		      }
		      $9 = $9 + 1 | 0;
		      if (($13 | 0) != ($9 | 0)) {
		       continue;
		      }
		      break;
		     }
		    }
		    $10 = $10 | $15;
		    $5 = $13;
		    $18 = $18 + 1 | 0;
		    if (($25 | 0) != ($18 | 0)) {
		     continue;
		    }
		    break;
		   }
		  }
		  $12 = 0;
		  if (($21 | 0) > 0) {
		   while (1) {
		    $10 = HEAPU8[$10 + 33552 | 0];
		    if (($12 | 0) != 31) {
		     $15 = $2 >> $12;
		     $5 = $15 >> 1;
		     $20 = ($5 | 0) > 1 ? $5 : 1;
		     $14 = 1 << $12;
		     $18 = $14 << 1;
		     $9 = 0;
		     while (1) {
		      $5 = 0;
		      if (($15 | 0) >= 2) {
		       while (1) {
		        $11 = (Math_imul($5, $18) + $9 << 2) + $1 | 0;
		        $0 = $11;
		        $16 = Math_fround(HEAPF32[$11 >> 2] * Math_fround(.7071067690849304));
		        $11 = ((($5 << 1 | 1) << $12) + $9 << 2) + $1 | 0;
		        $17 = Math_fround(HEAPF32[$11 >> 2] * Math_fround(.7071067690849304));
		        HEAPF32[$0 >> 2] = $16 + $17;
		        HEAPF32[$11 >> 2] = $16 - $17;
		        $5 = $5 + 1 | 0;
		        if (($20 | 0) != ($5 | 0)) {
		         continue;
		        }
		        break;
		       }
		      }
		      $9 = $9 + 1 | 0;
		      if (($14 | 0) != ($9 | 0)) {
		       continue;
		      }
		      break;
		     }
		    }
		    $12 = $12 + 1 | 0;
		    if (($19 | 0) != ($12 | 0)) {
		     continue;
		    }
		    break;
		   }
		  }
		  $11 = $13 << $19;
		  if (!(!$7 | ($2 | 0) < 1)) {
		   $16 = Math_fround(Math_sqrt(+($2 | 0)));
		   $5 = 0;
		   while (1) {
		    $9 = $5 << 2;
		    HEAPF32[$9 + $7 >> 2] = HEAPF32[$1 + $9 >> 2] * $16;
		    $5 = $5 + 1 | 0;
		    if (($5 | 0) != ($2 | 0)) {
		     continue;
		    }
		    break;
		   }
		  }
		  $10 = (-1 << $11 ^ -1) & $10;
		 }
		 return $10;
		}
		function update_filter($0) {
		 var $1 = 0, $2 = 0, $3 = 0, $4 = 0, $5 = 0, $6 = 0, $7 = 0, $8 = 0, $9 = 0, $10 = 0, $11 = 0, $12 = 0, $13 = Math_fround(0), $14 = Math_fround(0), $15 = 0, $16 = 0, $17 = 0, $18 = 0, $19 = 0, $20 = 0;
		 $2 = HEAP32[$0 + 8 >> 2];
		 $1 = HEAP32[$0 + 12 >> 2];
		 $5 = ($2 >>> 0) / ($1 >>> 0) | 0;
		 HEAP32[$0 + 36 >> 2] = $5;
		 $3 = Math_imul(HEAP32[$0 + 16 >> 2], 20);
		 $6 = HEAP32[$3 + 37364 >> 2];
		 HEAP32[$0 + 48 >> 2] = $6;
		 $11 = HEAP32[$0 + 24 >> 2];
		 $4 = HEAP32[$3 + 37360 >> 2];
		 HEAP32[$0 + 24 >> 2] = $4;
		 HEAP32[$0 + 40 >> 2] = $2 - Math_imul($1, $5);
		 $17 = HEAP32[$0 + 28 >> 2];
		 label$1 : {
		  label$2 : {
		   label$3 : {
		    if ($1 >>> 0 < $2 >>> 0) {
		     HEAPF32[$0 + 44 >> 2] = Math_fround(HEAPF32[$3 + 37368 >> 2] * Math_fround($1 >>> 0)) / Math_fround($2 >>> 0);
		     $3 = ($4 >>> 0) / ($1 >>> 0) | 0;
		     $5 = $4 - Math_imul($3, $1) | 0;
		     $4 = 4294967295 / ($2 >>> 0) | 0;
		     if ($5 >>> 0 > $4 >>> 0 | $3 >>> 0 > $4 >>> 0) {
		      break label$2;
		     }
		     $4 = Math_imul($2, $3);
		     $3 = (Math_imul($2, $5) >>> 0) / ($1 >>> 0) | 0;
		     if ($4 >>> 0 > ($3 ^ -1) >>> 0) {
		      break label$2;
		     }
		     $4 = ($3 + $4 | 0) + 7 & -8;
		     HEAP32[$0 + 24 >> 2] = $4;
		     $3 = $1 << 1 >>> 0 < $2 >>> 0;
		     $5 = $1 << 2 >>> 0 < $2 >>> 0;
		     $7 = $1 << 3;
		     $6 = $6 >>> $3 >>> $5 >>> ($7 >>> 0 < $2 >>> 0) | 0;
		     if (!($2 >>> 0 <= $7 >>> 0 ? !($3 | $5) : 0)) {
		      HEAP32[$0 + 48 >> 2] = $6;
		     }
		     $3 = $1 << 4 >>> 0 < $2 >>> 0;
		     $2 = $6 >>> $3 | 0;
		     if ($2 ? !$3 : 0) {
		      break label$3;
		     }
		     $6 = $2 ? $2 : 1;
		     HEAP32[$0 + 48 >> 2] = $6;
		     break label$3;
		    }
		    HEAP32[$0 + 44 >> 2] = HEAP32[$3 + 37372 >> 2];
		   }
		   $2 = Math_imul($1, $4);
		   $5 = Math_imul($4, $6) + 8 | 0;
		   label$7 : {
		    if ($2 >>> 0 <= $5 >>> 0) {
		     $3 = 1;
		     if (536870911 / ($1 >>> 0) >>> 0 >= $4 >>> 0) {
		      break label$7;
		     }
		    }
		    $3 = 0;
		    $2 = $5;
		    if (536870903 / ($6 >>> 0) >>> 0 < $4 >>> 0) {
		     break label$2;
		    }
		   }
		   if (HEAPU32[$0 + 80 >> 2] < $2 >>> 0) {
		    $1 = dlrealloc(HEAP32[$0 + 76 >> 2], $2 << 2);
		    if (!$1) {
		     break label$2;
		    }
		    HEAP32[$0 + 80 >> 2] = $2;
		    HEAP32[$0 + 76 >> 2] = $1;
		   }
		   $9 = $0;
		   label$10 : {
		    label$11 : {
		     label$12 : {
		      if (!$3) {
		       $1 = -4;
		       $2 = HEAP32[$0 + 24 >> 2];
		       $6 = HEAP32[$0 + 48 >> 2];
		       $4 = Math_imul($2, $6) + 4 | 0;
		       if (($4 | 0) > -4) {
		        break label$12;
		       }
		       $5 = HEAP32[$0 + 16 >> 2];
		       break label$11;
		      }
		      $2 = HEAP32[$0 + 24 >> 2];
		      $8 = HEAP32[$0 + 12 >> 2];
		      if ($8) {
		       $5 = ($2 | 0) / -2 | 0;
		       $13 = Math_fround($8 >>> 0);
		       $7 = 0;
		       while (1) {
		        if ($2) {
		         $4 = Math_imul($2, $7);
		         $14 = Math_fround(Math_fround($7 >>> 0) / $13);
		         $3 = HEAP32[Math_imul(HEAP32[$0 + 16 >> 2], 20) + 37376 >> 2];
		         $6 = HEAP32[$0 + 76 >> 2];
		         $1 = 0;
		         while (1) {
		          $10 = ($1 + $4 << 2) + $6 | 0;
		          $1 = $1 + 1 | 0;
		          HEAPF32[$10 >> 2] = sinc(HEAPF32[$0 + 44 >> 2], Math_fround(Math_fround($5 + $1 | 0) - $14), $2, $3);
		          if (($1 | 0) != ($2 | 0)) {
		           continue;
		          }
		          break;
		         }
		        }
		        $7 = $7 + 1 | 0;
		        if (($8 | 0) != ($7 | 0)) {
		         continue;
		        }
		        break;
		       }
		      }
		      $1 = HEAP32[$0 + 16 >> 2] > 8 ? 4 : 5;
		      break label$10;
		     }
		     $14 = Math_fround($2 >>> 1 >>> 0);
		     $5 = HEAP32[$0 + 16 >> 2];
		     $3 = HEAP32[Math_imul($5, 20) + 37376 >> 2];
		     $13 = Math_fround($6 >>> 0);
		     $6 = HEAP32[$0 + 76 >> 2];
		     while (1) {
		      HEAPF32[(($1 << 2) + $6 | 0) + 16 >> 2] = sinc(HEAPF32[$0 + 44 >> 2], Math_fround(Math_fround(Math_fround($1 | 0) / $13) - $14), $2, $3);
		      $1 = $1 + 1 | 0;
		      if (($4 | 0) != ($1 | 0)) {
		       continue;
		      }
		      break;
		     }
		    }
		    $1 = ($5 | 0) > 8 ? 6 : 7;
		   }
		   HEAP32[$9 + 84 >> 2] = $1;
		   $1 = (HEAP32[$0 + 32 >> 2] + $2 | 0) - 1 | 0;
		   $2 = HEAP32[$0 + 28 >> 2];
		   if ($1 >>> 0 > $2 >>> 0) {
		    $2 = HEAP32[$0 + 20 >> 2];
		    if (536870911 / ($2 >>> 0) >>> 0 < $1 >>> 0) {
		     break label$2;
		    }
		    $2 = dlrealloc(HEAP32[$0 + 72 >> 2], Math_imul($1, $2) << 2);
		    if (!$2) {
		     break label$2;
		    }
		    HEAP32[$0 + 28 >> 2] = $1;
		    HEAP32[$0 + 72 >> 2] = $2;
		    $2 = $1;
		   }
		   if (!HEAP32[$0 + 56 >> 2]) {
		    $1 = Math_imul(HEAP32[$0 + 20 >> 2], $2);
		    if (!$1) {
		     return 0;
		    }
		    memset(HEAP32[$0 + 72 >> 2], 0, $1 << 2);
		    return 0;
		   }
		   $2 = HEAP32[$0 + 24 >> 2];
		   if ($11 >>> 0 < $2 >>> 0) {
		    $8 = HEAP32[$0 + 20 >> 2];
		    if (!$8) {
		     return 0;
		    }
		    $18 = $11 - 1 | 0;
		    $19 = ($8 << 2) - 4 | 0;
		    $20 = HEAP32[$0 + 68 >> 2];
		    while (1) {
		     $7 = $12 << 2;
		     $8 = $8 - 1 | 0;
		     $15 = $8 << 2;
		     $5 = $15 + $20 | 0;
		     $4 = HEAP32[$5 >> 2];
		     $9 = $4 << 1;
		     $1 = $4 + $18 | 0;
		     if ($1) {
		      $3 = Math_imul($8, $17);
		      $6 = Math_imul(HEAP32[$0 + 28 >> 2], $8);
		      $2 = HEAP32[$0 + 72 >> 2];
		      while (1) {
		       $1 = $1 - 1 | 0;
		       HEAP32[(($4 + $1 | 0) + $6 << 2) + $2 >> 2] = HEAP32[($1 + $3 << 2) + $2 >> 2];
		       if ($1) {
		        continue;
		       }
		       break;
		      }
		     }
		     $16 = $19 - $7 | 0;
		     $9 = $9 + $11 | 0;
		     if ($4) {
		      memset(HEAP32[$0 + 72 >> 2] + Math_imul(HEAP32[$0 + 28 >> 2], $16) | 0, 0, $4 << 2);
		     }
		     HEAP32[$5 >> 2] = 0;
		     $10 = HEAP32[$0 + 24 >> 2];
		     label$28 : {
		      if ($10 >>> 0 > $9 >>> 0) {
		       $6 = $9 - 1 | 0;
		       if ($6) {
		        $5 = $10 - 2 | 0;
		        $7 = $9 - 2 | 0;
		        $4 = Math_imul(HEAP32[$0 + 28 >> 2], $8);
		        $3 = HEAP32[$0 + 72 >> 2];
		        $1 = 0;
		        $2 = 0;
		        while (1) {
		         HEAP32[(($1 + $5 | 0) + $4 << 2) + $3 >> 2] = HEAP32[(($1 + $7 | 0) + $4 << 2) + $3 >> 2];
		         $1 = $2 ^ -1;
		         $2 = $2 + 1 | 0;
		         if (($6 | 0) != ($2 | 0)) {
		          continue;
		         }
		         break;
		        }
		       }
		       $1 = $10 - 1 | 0;
		       if ($6 >>> 0 < $1 >>> 0) {
		        memset(HEAP32[$0 + 72 >> 2] + Math_imul(HEAP32[$0 + 28 >> 2], $16) | 0, 0, $1 - $6 << 2);
		       }
		       $1 = HEAP32[$0 + 60 >> 2] + $15 | 0;
		       HEAP32[$1 >> 2] = HEAP32[$1 >> 2] + ($10 - $9 >>> 1 | 0);
		       break label$28;
		      }
		      $3 = $9 - $10 >>> 1 | 0;
		      HEAP32[$5 >> 2] = $3;
		      $1 = $3 - 1 | 0;
		      $2 = HEAP32[$0 + 24 >> 2];
		      if (($1 | 0) == (0 - $2 | 0)) {
		       break label$28;
		      }
		      $1 = $1 + $2 | 0;
		      $6 = $1 >>> 0 > 1 ? $1 : 1;
		      $5 = Math_imul(HEAP32[$0 + 28 >> 2], $8);
		      $2 = HEAP32[$0 + 72 >> 2];
		      $1 = 0;
		      while (1) {
		       $4 = $1 + $5 | 0;
		       HEAP32[($4 << 2) + $2 >> 2] = HEAP32[($3 + $4 << 2) + $2 >> 2];
		       $1 = $1 + 1 | 0;
		       if (($6 | 0) != ($1 | 0)) {
		        continue;
		       }
		       break;
		      }
		     }
		     $12 = $12 + 1 | 0;
		     if ($8) {
		      continue;
		     }
		     break;
		    }
		    return 0;
		   }
		   $1 = 0;
		   if (!HEAP32[$0 + 20 >> 2] | $2 >>> 0 >= $11 >>> 0) {
		    break label$1;
		   }
		   $12 = HEAP32[$0 + 68 >> 2];
		   $7 = 0;
		   while (1) {
		    $8 = ($7 << 2) + $12 | 0;
		    $1 = HEAP32[$8 >> 2];
		    $3 = $11 - $2 >>> 1 | 0;
		    HEAP32[$8 >> 2] = $3;
		    $9 = $1 + $3 | 0;
		    $1 = $9 - 1 | 0;
		    $2 = HEAP32[$0 + 24 >> 2];
		    if (($1 | 0) != (0 - $2 | 0)) {
		     $1 = $1 + $2 | 0;
		     $6 = $1 >>> 0 > 1 ? $1 : 1;
		     $5 = Math_imul(HEAP32[$0 + 28 >> 2], $7);
		     $2 = HEAP32[$0 + 72 >> 2];
		     $1 = 0;
		     while (1) {
		      $4 = $1 + $5 | 0;
		      HEAP32[($4 << 2) + $2 >> 2] = HEAP32[($3 + $4 << 2) + $2 >> 2];
		      $1 = $1 + 1 | 0;
		      if (($6 | 0) != ($1 | 0)) {
		       continue;
		      }
		      break;
		     }
		    }
		    HEAP32[$8 >> 2] = $9;
		    $7 = $7 + 1 | 0;
		    if ($7 >>> 0 >= HEAPU32[$0 + 20 >> 2]) {
		     return 0;
		    } else {
		     $2 = HEAP32[$0 + 24 >> 2];
		     continue;
		    }
		   }
		  }
		  HEAP32[$0 + 24 >> 2] = $11;
		  HEAP32[$0 + 84 >> 2] = 8;
		  $1 = 1;
		 }
		 return $1;
		}
		function dlfree($0) {
		 $0 = $0 | 0;
		 var $1 = 0, $2 = 0, $3 = 0, $4 = 0, $5 = 0, $6 = 0, $7 = 0;
		 label$1 : {
		  label$2 : {
		   if (!$0) {
		    break label$2;
		   }
		   $3 = $0 - 8 | 0;
		   $1 = HEAP32[$0 - 4 >> 2];
		   $0 = $1 & -8;
		   $5 = $3 + $0 | 0;
		   label$3 : {
		    if ($1 & 1) {
		     break label$3;
		    }
		    if (!($1 & 3)) {
		     break label$2;
		    }
		    $1 = HEAP32[$3 >> 2];
		    $3 = $3 - $1 | 0;
		    $4 = HEAP32[9856];
		    if ($3 >>> 0 < $4 >>> 0) {
		     break label$2;
		    }
		    $0 = $0 + $1 | 0;
		    if (HEAP32[9857] != ($3 | 0)) {
		     if ($1 >>> 0 <= 255) {
		      $7 = $1 >>> 3 | 0;
		      $1 = ($7 << 3) + 39448 | 0;
		      $6 = HEAP32[$3 + 8 >> 2];
		      $2 = HEAP32[$3 + 12 >> 2];
		      if (($6 | 0) == ($2 | 0)) {
		       HEAP32[9852] = HEAP32[9852] & __wasm_rotl_i32(-2, $7);
		       break label$3;
		      }
		      HEAP32[$6 + 12 >> 2] = $2;
		      HEAP32[$2 + 8 >> 2] = $6;
		      break label$3;
		     }
		     $7 = HEAP32[$3 + 24 >> 2];
		     $2 = HEAP32[$3 + 12 >> 2];
		     label$7 : {
		      if (($2 | 0) != ($3 | 0)) {
		       $1 = HEAP32[$3 + 8 >> 2];
		       HEAP32[$1 + 12 >> 2] = $2;
		       HEAP32[$2 + 8 >> 2] = $1;
		       break label$7;
		      }
		      label$10 : {
		       $1 = $3 + 20 | 0;
		       $4 = HEAP32[$1 >> 2];
		       if ($4) {
		        break label$10;
		       }
		       $1 = $3 + 16 | 0;
		       $4 = HEAP32[$1 >> 2];
		       if ($4) {
		        break label$10;
		       }
		       $2 = 0;
		       break label$7;
		      }
		      while (1) {
		       $6 = $1;
		       $2 = $4;
		       $1 = $2 + 20 | 0;
		       $4 = HEAP32[$1 >> 2];
		       if ($4) {
		        continue;
		       }
		       $1 = $2 + 16 | 0;
		       $4 = HEAP32[$2 + 16 >> 2];
		       if ($4) {
		        continue;
		       }
		       break;
		      }
		      HEAP32[$6 >> 2] = 0;
		     }
		     if (!$7) {
		      break label$3;
		     }
		     $4 = HEAP32[$3 + 28 >> 2];
		     $1 = ($4 << 2) + 39712 | 0;
		     label$12 : {
		      if (HEAP32[$1 >> 2] == ($3 | 0)) {
		       HEAP32[$1 >> 2] = $2;
		       if ($2) {
		        break label$12;
		       }
		       HEAP32[9853] = HEAP32[9853] & __wasm_rotl_i32(-2, $4);
		       break label$3;
		      }
		      HEAP32[(HEAP32[$7 + 16 >> 2] == ($3 | 0) ? 16 : 20) + $7 >> 2] = $2;
		      if (!$2) {
		       break label$3;
		      }
		     }
		     HEAP32[$2 + 24 >> 2] = $7;
		     $1 = HEAP32[$3 + 16 >> 2];
		     if ($1) {
		      HEAP32[$2 + 16 >> 2] = $1;
		      HEAP32[$1 + 24 >> 2] = $2;
		     }
		     $1 = HEAP32[$3 + 20 >> 2];
		     if (!$1) {
		      break label$3;
		     }
		     HEAP32[$2 + 20 >> 2] = $1;
		     HEAP32[$1 + 24 >> 2] = $2;
		     break label$3;
		    }
		    $1 = HEAP32[$5 + 4 >> 2];
		    if (($1 & 3) != 3) {
		     break label$3;
		    }
		    HEAP32[9854] = $0;
		    HEAP32[$5 + 4 >> 2] = $1 & -2;
		    break label$1;
		   }
		   if ($3 >>> 0 >= $5 >>> 0) {
		    break label$2;
		   }
		   $1 = HEAP32[$5 + 4 >> 2];
		   if (!($1 & 1)) {
		    break label$2;
		   }
		   label$15 : {
		    if (!($1 & 2)) {
		     if (HEAP32[9858] == ($5 | 0)) {
		      HEAP32[9858] = $3;
		      $0 = HEAP32[9855] + $0 | 0;
		      HEAP32[9855] = $0;
		      HEAP32[$3 + 4 >> 2] = $0 | 1;
		      if (HEAP32[9857] != ($3 | 0)) {
		       break label$2;
		      }
		      HEAP32[9854] = 0;
		      HEAP32[9857] = 0;
		      return;
		     }
		     if (HEAP32[9857] == ($5 | 0)) {
		      HEAP32[9857] = $3;
		      $0 = HEAP32[9854] + $0 | 0;
		      HEAP32[9854] = $0;
		      break label$1;
		     }
		     $0 = ($1 & -8) + $0 | 0;
		     label$19 : {
		      if ($1 >>> 0 <= 255) {
		       $4 = HEAP32[$5 + 12 >> 2];
		       $2 = HEAP32[$5 + 8 >> 2];
		       $5 = $1 >>> 3 | 0;
		       if (($2 | 0) == ($4 | 0)) {
		        HEAP32[9852] = HEAP32[9852] & __wasm_rotl_i32(-2, $5);
		        break label$19;
		       }
		       HEAP32[$2 + 12 >> 2] = $4;
		       HEAP32[$4 + 8 >> 2] = $2;
		       break label$19;
		      }
		      $7 = HEAP32[$5 + 24 >> 2];
		      $2 = HEAP32[$5 + 12 >> 2];
		      label$24 : {
		       if (($5 | 0) != ($2 | 0)) {
		        $1 = HEAP32[$5 + 8 >> 2];
		        HEAP32[$1 + 12 >> 2] = $2;
		        HEAP32[$2 + 8 >> 2] = $1;
		        break label$24;
		       }
		       label$27 : {
		        $1 = $5 + 20 | 0;
		        $4 = HEAP32[$1 >> 2];
		        if ($4) {
		         break label$27;
		        }
		        $1 = $5 + 16 | 0;
		        $4 = HEAP32[$1 >> 2];
		        if ($4) {
		         break label$27;
		        }
		        $2 = 0;
		        break label$24;
		       }
		       while (1) {
		        $6 = $1;
		        $2 = $4;
		        $1 = $2 + 20 | 0;
		        $4 = HEAP32[$1 >> 2];
		        if ($4) {
		         continue;
		        }
		        $1 = $2 + 16 | 0;
		        $4 = HEAP32[$2 + 16 >> 2];
		        if ($4) {
		         continue;
		        }
		        break;
		       }
		       HEAP32[$6 >> 2] = 0;
		      }
		      if (!$7) {
		       break label$19;
		      }
		      $4 = HEAP32[$5 + 28 >> 2];
		      $1 = ($4 << 2) + 39712 | 0;
		      label$29 : {
		       if (HEAP32[$1 >> 2] == ($5 | 0)) {
		        HEAP32[$1 >> 2] = $2;
		        if ($2) {
		         break label$29;
		        }
		        HEAP32[9853] = HEAP32[9853] & __wasm_rotl_i32(-2, $4);
		        break label$19;
		       }
		       HEAP32[(HEAP32[$7 + 16 >> 2] == ($5 | 0) ? 16 : 20) + $7 >> 2] = $2;
		       if (!$2) {
		        break label$19;
		       }
		      }
		      HEAP32[$2 + 24 >> 2] = $7;
		      $1 = HEAP32[$5 + 16 >> 2];
		      if ($1) {
		       HEAP32[$2 + 16 >> 2] = $1;
		       HEAP32[$1 + 24 >> 2] = $2;
		      }
		      $1 = HEAP32[$5 + 20 >> 2];
		      if (!$1) {
		       break label$19;
		      }
		      HEAP32[$2 + 20 >> 2] = $1;
		      HEAP32[$1 + 24 >> 2] = $2;
		     }
		     HEAP32[$3 + 4 >> 2] = $0 | 1;
		     HEAP32[$0 + $3 >> 2] = $0;
		     if (HEAP32[9857] != ($3 | 0)) {
		      break label$15;
		     }
		     HEAP32[9854] = $0;
		     return;
		    }
		    HEAP32[$5 + 4 >> 2] = $1 & -2;
		    HEAP32[$3 + 4 >> 2] = $0 | 1;
		    HEAP32[$0 + $3 >> 2] = $0;
		   }
		   if ($0 >>> 0 <= 255) {
		    $1 = $0 >>> 3 | 0;
		    $0 = ($1 << 3) + 39448 | 0;
		    $1 = 1 << $1;
		    $4 = HEAP32[9852];
		    label$33 : {
		     if (!($1 & $4)) {
		      HEAP32[9852] = $1 | $4;
		      $1 = $0;
		      break label$33;
		     }
		     $1 = HEAP32[$0 + 8 >> 2];
		    }
		    HEAP32[$0 + 8 >> 2] = $3;
		    HEAP32[$1 + 12 >> 2] = $3;
		    HEAP32[$3 + 12 >> 2] = $0;
		    HEAP32[$3 + 8 >> 2] = $1;
		    return;
		   }
		   $1 = 31;
		   HEAP32[$3 + 16 >> 2] = 0;
		   HEAP32[$3 + 20 >> 2] = 0;
		   if ($0 >>> 0 <= 16777215) {
		    $1 = $0 >>> 8 | 0;
		    $2 = $1;
		    $1 = $1 + 1048320 >>> 16 & 8;
		    $4 = $2 << $1;
		    $2 = $4;
		    $4 = $4 + 520192 >>> 16 & 4;
		    $2 = $2 << $4;
		    $6 = $2;
		    $2 = $2 + 245760 >>> 16 & 2;
		    $1 = ($6 << $2 >>> 15 | 0) - ($1 | $4 | $2) | 0;
		    $1 = ($1 << 1 | $0 >>> $1 + 21 & 1) + 28 | 0;
		   }
		   HEAP32[$3 + 28 >> 2] = $1;
		   $4 = ($1 << 2) + 39712 | 0;
		   label$36 : {
		    label$37 : {
		     $2 = HEAP32[9853];
		     $5 = 1 << $1;
		     label$38 : {
		      if (!($2 & $5)) {
		       HEAP32[9853] = $2 | $5;
		       HEAP32[$4 >> 2] = $3;
		       break label$38;
		      }
		      $1 = $0 << (($1 | 0) == 31 ? 0 : 25 - ($1 >>> 1 | 0) | 0);
		      $2 = HEAP32[$4 >> 2];
		      while (1) {
		       $4 = $2;
		       if ((HEAP32[$2 + 4 >> 2] & -8) == ($0 | 0)) {
		        break label$37;
		       }
		       $2 = $1 >>> 29 | 0;
		       $1 = $1 << 1;
		       $6 = ($2 & 4) + $4 | 0;
		       $5 = $6 + 16 | 0;
		       $2 = HEAP32[$5 >> 2];
		       if ($2) {
		        continue;
		       }
		       break;
		      }
		      HEAP32[$6 + 16 >> 2] = $3;
		     }
		     HEAP32[$3 + 24 >> 2] = $4;
		     HEAP32[$3 + 12 >> 2] = $3;
		     HEAP32[$3 + 8 >> 2] = $3;
		     break label$36;
		    }
		    $0 = HEAP32[$4 + 8 >> 2];
		    HEAP32[$0 + 12 >> 2] = $3;
		    HEAP32[$4 + 8 >> 2] = $3;
		    HEAP32[$3 + 24 >> 2] = 0;
		    HEAP32[$3 + 12 >> 2] = $4;
		    HEAP32[$3 + 8 >> 2] = $0;
		   }
		   $3 = HEAP32[9860] - 1 | 0;
		   HEAP32[9860] = $3 ? $3 : -1;
		  }
		  return;
		 }
		 HEAP32[$3 + 4 >> 2] = $0 | 1;
		 HEAP32[$0 + $3 >> 2] = $0;
		}
		function opus_decode_native($0, $1, $2, $3, $4, $5, $6, $7, $8) {
		 var $9 = 0, $10 = 0, $11 = 0, $12 = 0, $13 = 0, $14 = 0, $15 = 0;
		 $12 = __stack_pointer - 112 | 0;
		 __stack_pointer = $12;
		 label$1 : {
		  label$2 : {
		   label$3 : {
		    label$4 : {
		     label$5 : {
		      label$6 : {
		       label$7 : {
		        $11 = HEAP32[$0 + 8 >> 2];
		        if ($11 - 1 >>> 0 < 2) {
		         $10 = HEAP32[$0 + 12 >> 2];
		         label$9 : {
		          if (($10 | 0) <= 15999) {
		           if (($10 | 0) == 8e3 | ($10 | 0) == 12e3) {
		            break label$9;
		           }
		           break label$1;
		          }
		          if (($10 | 0) == 16e3 | ($10 | 0) == 24e3) {
		           break label$9;
		          }
		          if (($10 | 0) != 48e3) {
		           break label$1;
		          }
		         }
		         if (HEAP32[$0 + 24 >> 2] != ($10 | 0)) {
		          break label$7;
		         }
		         $9 = HEAP32[$0 + 28 >> 2];
		         label$11 : {
		          if (($9 | 0) <= 11999) {
		           if (!$9 | ($9 | 0) == 8e3) {
		            break label$11;
		           }
		           break label$2;
		          }
		          if (($9 | 0) == 12e3) {
		           break label$11;
		          }
		          if (($9 | 0) != 16e3) {
		           break label$2;
		          }
		         }
		         if (HEAP32[$0 + 16 >> 2] != ($11 | 0)) {
		          break label$6;
		         }
		         if (HEAPU32[$0 + 20 >> 2] >= 3) {
		          break label$5;
		         }
		         $9 = HEAP32[$0 + 32 >> 2];
		         if ($9 >>> 0 > 20 | !(1 << $9 & 1049601)) {
		          break label$4;
		         }
		         break label$3;
		        }
		        celt_fatal(35445, 35333, 84);
		        abort();
		       }
		       celt_fatal(35611, 35333, 86);
		       abort();
		      }
		      celt_fatal(35863, 35333, 88);
		      abort();
		     }
		     celt_fatal(35925, 35333, 89);
		     abort();
		    }
		    if (($9 | 0) == 40 | ($9 | 0) == 60) {
		     break label$3;
		    }
		    celt_fatal(36063, 35333, 90);
		    abort();
		   }
		   label$13 : {
		    label$14 : {
		     label$15 : {
		      label$16 : {
		       label$17 : {
		        label$18 : {
		         label$19 : {
		          $9 = HEAP32[$0 + 44 >> 2];
		          if (($9 | 0) > -1) {
		           if ($9) {
		            break label$19;
		           }
		           $9 = -1;
		           if (HEAP32[$0 + 48 >> 2] - 1 >>> 0 >= 2) {
		            break label$18;
		           }
		           if ($5 >>> 0 > 1) {
		            break label$13;
		           }
		           if (!($5 ? 0 : !(!$1 | !$2))) {
		            if (($4 | 0) % ((($10 & 65535) >>> 0) / 400 | 0) | 0) {
		             break label$13;
		            }
		           }
		           if (!($2 ? $1 : 0)) {
		            $10 = opus_decode_frame($0, 0, 0, $3, $4, 0);
		            if (($10 | 0) < 0) {
		             $9 = $10;
		             break label$13;
		            }
		            while (1) {
		             if (($4 | 0) > ($10 | 0)) {
		              $9 = opus_decode_frame($0, 0, 0, (Math_imul(HEAP32[$0 + 8 >> 2], $10) << 2) + $3 | 0, $4 - $10 | 0, 0);
		              $5 = ($9 | 0) < 0;
		              $10 = ($5 ? 0 : $9) + $10 | 0;
		              if (!$5) {
		               continue;
		              }
		              break label$13;
		             }
		             break;
		            }
		            if (($4 | 0) != ($10 | 0)) {
		             break label$17;
		            }
		            break label$14;
		           }
		           if (($2 | 0) < 0) {
		            break label$13;
		           }
		           $9 = HEAPU8[$1 | 0];
		           $14 = $9 & 96;
		           $15 = $9 & 128;
		           label$27 : {
		            if ($15) {
		             $9 = $9 >>> 5 & 3;
		             $13 = $9 ? $9 + 1102 | 0 : 1101;
		             break label$27;
		            }
		            $13 = $9 & 16 ? 1105 : 1104;
		            if (($14 | 0) == 96) {
		             break label$27;
		            }
		            $13 = ($9 >>> 5 & 3) + 1101 | 0;
		           }
		           $10 = opus_packet_get_samples_per_frame($1, $10);
		           $9 = HEAPU8[$1 | 0];
		           $11 = opus_packet_parse_impl($1, $2, $6, $12 + 107 | 0, 0, $12, $12 + 108 | 0);
		           if (($11 | 0) < 0) {
		            $9 = $11;
		            break label$13;
		           }
		           $2 = $15 ? 1002 : ($14 | 0) == 96 ? 1001 : 1e3;
		           $6 = $9 & 4 ? 2 : 1;
		           $1 = HEAP32[$12 + 108 >> 2] + $1 | 0;
		           if ($5) {
		            if (!(HEAP32[$0 + 56 >> 2] != 1002 ? !(($2 | 0) == 1002 | ($4 | 0) < ($10 | 0)) : 0)) {
		             $9 = opus_decode_native($0, 0, 0, $3, $4, 0, 0);
		             break label$13;
		            }
		            $5 = $4 - $10 | 0;
		            if ($5) {
		             $11 = HEAP32[$0 + 72 >> 2];
		             $9 = opus_decode_native($0, 0, 0, $3, $5, 0, 0);
		             if (($9 | 0) <= -1) {
		              HEAP32[$0 + 72 >> 2] = $11;
		              break label$13;
		             }
		             if (($5 | 0) != ($9 | 0)) {
		              break label$16;
		             }
		            }
		            HEAP32[$0 + 64 >> 2] = $10;
		            HEAP32[$0 + 52 >> 2] = $13;
		            HEAP32[$0 + 56 >> 2] = $2;
		            HEAP32[$0 + 48 >> 2] = $6;
		            $9 = opus_decode_frame($0, $1, HEAP16[$12 >> 1], (Math_imul(HEAP32[$0 + 8 >> 2], $5) << 2) + $3 | 0, $10, 1);
		            if (($9 | 0) >= 0) {
		             break label$14;
		            }
		            break label$13;
		           }
		           $9 = -2;
		           if ((Math_imul($10, $11) | 0) > ($4 | 0)) {
		            break label$13;
		           }
		           HEAP32[$0 + 64 >> 2] = $10;
		           HEAP32[$0 + 52 >> 2] = $13;
		           HEAP32[$0 + 56 >> 2] = $2;
		           HEAP32[$0 + 48 >> 2] = $6;
		           $5 = 0;
		           label$35 : {
		            if (($11 | 0) < 1) {
		             $9 = 0;
		             break label$35;
		            }
		            $9 = 0;
		            while (1) {
		             $6 = ($5 << 1) + $12 | 0;
		             $2 = opus_decode_frame($0, $1, HEAP16[$6 >> 1], (Math_imul(HEAP32[$0 + 8 >> 2], $9) << 2) + $3 | 0, $4 - $9 | 0, 0);
		             if (($2 | 0) < 0) {
		              $9 = $2;
		              break label$13;
		             }
		             if (($2 | 0) != ($10 | 0)) {
		              break label$15;
		             }
		             $9 = $9 + $10 | 0;
		             $1 = HEAP16[$6 >> 1] + $1 | 0;
		             $5 = $5 + 1 | 0;
		             if (($11 | 0) != ($5 | 0)) {
		              continue;
		             }
		             break;
		            }
		           }
		           HEAP32[$0 + 72 >> 2] = $9;
		           HEAP32[$0 + 76 >> 2] = 0;
		           HEAP32[$0 + 80 >> 2] = 0;
		           break label$13;
		          }
		          celt_fatal(36272, 35333, 92);
		          abort();
		         }
		         celt_fatal(36304, 35333, 93);
		         abort();
		        }
		        celt_fatal(36348, 35333, 95);
		        abort();
		       }
		       celt_fatal(35291, 35333, 652);
		       abort();
		      }
		      celt_fatal(35352, 35333, 689);
		      abort();
		     }
		     celt_fatal(35404, 35333, 724);
		     abort();
		    }
		    HEAP32[$0 + 72 >> 2] = $4;
		    $9 = $4;
		   }
		   __stack_pointer = $12 + 112 | 0;
		   return $9;
		  }
		  celt_fatal(35669, 35333, 87);
		  abort();
		 }
		 celt_fatal(35502, 35333, 85);
		 abort();
		}
		function dispose_chunk($0, $1) {
		 var $2 = 0, $3 = 0, $4 = 0, $5 = 0, $6 = 0, $7 = 0;
		 $5 = $0 + $1 | 0;
		 label$1 : {
		  label$2 : {
		   $2 = HEAP32[$0 + 4 >> 2];
		   if ($2 & 1) {
		    break label$2;
		   }
		   if (!($2 & 3)) {
		    break label$1;
		   }
		   $2 = HEAP32[$0 >> 2];
		   $1 = $2 + $1 | 0;
		   $0 = $0 - $2 | 0;
		   if (($0 | 0) != HEAP32[9857]) {
		    if ($2 >>> 0 <= 255) {
		     $6 = $2 >>> 3 | 0;
		     $2 = ($6 << 3) + 39448 | 0;
		     $3 = HEAP32[$0 + 8 >> 2];
		     $4 = HEAP32[$0 + 12 >> 2];
		     if (($4 | 0) == ($3 | 0)) {
		      HEAP32[9852] = HEAP32[9852] & __wasm_rotl_i32(-2, $6);
		      break label$2;
		     }
		     HEAP32[$3 + 12 >> 2] = $4;
		     HEAP32[$4 + 8 >> 2] = $3;
		     break label$2;
		    }
		    $6 = HEAP32[$0 + 24 >> 2];
		    $3 = HEAP32[$0 + 12 >> 2];
		    label$6 : {
		     if (($3 | 0) != ($0 | 0)) {
		      $2 = HEAP32[$0 + 8 >> 2];
		      HEAP32[$2 + 12 >> 2] = $3;
		      HEAP32[$3 + 8 >> 2] = $2;
		      break label$6;
		     }
		     label$9 : {
		      $2 = $0 + 20 | 0;
		      $4 = HEAP32[$2 >> 2];
		      if ($4) {
		       break label$9;
		      }
		      $2 = $0 + 16 | 0;
		      $4 = HEAP32[$2 >> 2];
		      if ($4) {
		       break label$9;
		      }
		      $3 = 0;
		      break label$6;
		     }
		     while (1) {
		      $7 = $2;
		      $3 = $4;
		      $2 = $3 + 20 | 0;
		      $4 = HEAP32[$2 >> 2];
		      if ($4) {
		       continue;
		      }
		      $2 = $3 + 16 | 0;
		      $4 = HEAP32[$3 + 16 >> 2];
		      if ($4) {
		       continue;
		      }
		      break;
		     }
		     HEAP32[$7 >> 2] = 0;
		    }
		    if (!$6) {
		     break label$2;
		    }
		    $4 = HEAP32[$0 + 28 >> 2];
		    $2 = ($4 << 2) + 39712 | 0;
		    label$11 : {
		     if (HEAP32[$2 >> 2] == ($0 | 0)) {
		      HEAP32[$2 >> 2] = $3;
		      if ($3) {
		       break label$11;
		      }
		      HEAP32[9853] = HEAP32[9853] & __wasm_rotl_i32(-2, $4);
		      break label$2;
		     }
		     HEAP32[(HEAP32[$6 + 16 >> 2] == ($0 | 0) ? 16 : 20) + $6 >> 2] = $3;
		     if (!$3) {
		      break label$2;
		     }
		    }
		    HEAP32[$3 + 24 >> 2] = $6;
		    $2 = HEAP32[$0 + 16 >> 2];
		    if ($2) {
		     HEAP32[$3 + 16 >> 2] = $2;
		     HEAP32[$2 + 24 >> 2] = $3;
		    }
		    $2 = HEAP32[$0 + 20 >> 2];
		    if (!$2) {
		     break label$2;
		    }
		    HEAP32[$3 + 20 >> 2] = $2;
		    HEAP32[$2 + 24 >> 2] = $3;
		    break label$2;
		   }
		   $2 = HEAP32[$5 + 4 >> 2];
		   if (($2 & 3) != 3) {
		    break label$2;
		   }
		   HEAP32[9854] = $1;
		   HEAP32[$5 + 4 >> 2] = $2 & -2;
		   HEAP32[$0 + 4 >> 2] = $1 | 1;
		   HEAP32[$5 >> 2] = $1;
		   return;
		  }
		  $2 = HEAP32[$5 + 4 >> 2];
		  label$14 : {
		   if (!($2 & 2)) {
		    if (HEAP32[9858] == ($5 | 0)) {
		     HEAP32[9858] = $0;
		     $1 = HEAP32[9855] + $1 | 0;
		     HEAP32[9855] = $1;
		     HEAP32[$0 + 4 >> 2] = $1 | 1;
		     if (HEAP32[9857] != ($0 | 0)) {
		      break label$1;
		     }
		     HEAP32[9854] = 0;
		     HEAP32[9857] = 0;
		     return;
		    }
		    if (HEAP32[9857] == ($5 | 0)) {
		     HEAP32[9857] = $0;
		     $1 = HEAP32[9854] + $1 | 0;
		     HEAP32[9854] = $1;
		     HEAP32[$0 + 4 >> 2] = $1 | 1;
		     HEAP32[$0 + $1 >> 2] = $1;
		     return;
		    }
		    $1 = ($2 & -8) + $1 | 0;
		    label$18 : {
		     if ($2 >>> 0 <= 255) {
		      $4 = HEAP32[$5 + 12 >> 2];
		      $3 = HEAP32[$5 + 8 >> 2];
		      $5 = $2 >>> 3 | 0;
		      if (($3 | 0) == ($4 | 0)) {
		       HEAP32[9852] = HEAP32[9852] & __wasm_rotl_i32(-2, $5);
		       break label$18;
		      }
		      HEAP32[$3 + 12 >> 2] = $4;
		      HEAP32[$4 + 8 >> 2] = $3;
		      break label$18;
		     }
		     $6 = HEAP32[$5 + 24 >> 2];
		     $3 = HEAP32[$5 + 12 >> 2];
		     label$21 : {
		      if (($5 | 0) != ($3 | 0)) {
		       $2 = HEAP32[$5 + 8 >> 2];
		       HEAP32[$2 + 12 >> 2] = $3;
		       HEAP32[$3 + 8 >> 2] = $2;
		       break label$21;
		      }
		      label$24 : {
		       $4 = $5 + 20 | 0;
		       $2 = HEAP32[$4 >> 2];
		       if ($2) {
		        break label$24;
		       }
		       $4 = $5 + 16 | 0;
		       $2 = HEAP32[$4 >> 2];
		       if ($2) {
		        break label$24;
		       }
		       $3 = 0;
		       break label$21;
		      }
		      while (1) {
		       $7 = $4;
		       $3 = $2;
		       $4 = $2 + 20 | 0;
		       $2 = HEAP32[$4 >> 2];
		       if ($2) {
		        continue;
		       }
		       $4 = $3 + 16 | 0;
		       $2 = HEAP32[$3 + 16 >> 2];
		       if ($2) {
		        continue;
		       }
		       break;
		      }
		      HEAP32[$7 >> 2] = 0;
		     }
		     if (!$6) {
		      break label$18;
		     }
		     $4 = HEAP32[$5 + 28 >> 2];
		     $2 = ($4 << 2) + 39712 | 0;
		     label$26 : {
		      if (HEAP32[$2 >> 2] == ($5 | 0)) {
		       HEAP32[$2 >> 2] = $3;
		       if ($3) {
		        break label$26;
		       }
		       HEAP32[9853] = HEAP32[9853] & __wasm_rotl_i32(-2, $4);
		       break label$18;
		      }
		      HEAP32[(HEAP32[$6 + 16 >> 2] == ($5 | 0) ? 16 : 20) + $6 >> 2] = $3;
		      if (!$3) {
		       break label$18;
		      }
		     }
		     HEAP32[$3 + 24 >> 2] = $6;
		     $2 = HEAP32[$5 + 16 >> 2];
		     if ($2) {
		      HEAP32[$3 + 16 >> 2] = $2;
		      HEAP32[$2 + 24 >> 2] = $3;
		     }
		     $2 = HEAP32[$5 + 20 >> 2];
		     if (!$2) {
		      break label$18;
		     }
		     HEAP32[$3 + 20 >> 2] = $2;
		     HEAP32[$2 + 24 >> 2] = $3;
		    }
		    HEAP32[$0 + 4 >> 2] = $1 | 1;
		    HEAP32[$0 + $1 >> 2] = $1;
		    if (HEAP32[9857] != ($0 | 0)) {
		     break label$14;
		    }
		    HEAP32[9854] = $1;
		    return;
		   }
		   HEAP32[$5 + 4 >> 2] = $2 & -2;
		   HEAP32[$0 + 4 >> 2] = $1 | 1;
		   HEAP32[$0 + $1 >> 2] = $1;
		  }
		  if ($1 >>> 0 <= 255) {
		   $2 = $1 >>> 3 | 0;
		   $1 = ($2 << 3) + 39448 | 0;
		   $2 = 1 << $2;
		   $4 = HEAP32[9852];
		   label$30 : {
		    if (!($2 & $4)) {
		     HEAP32[9852] = $2 | $4;
		     $2 = $1;
		     break label$30;
		    }
		    $2 = HEAP32[$1 + 8 >> 2];
		   }
		   HEAP32[$1 + 8 >> 2] = $0;
		   HEAP32[$2 + 12 >> 2] = $0;
		   HEAP32[$0 + 12 >> 2] = $1;
		   HEAP32[$0 + 8 >> 2] = $2;
		   return;
		  }
		  $2 = 31;
		  HEAP32[$0 + 16 >> 2] = 0;
		  HEAP32[$0 + 20 >> 2] = 0;
		  if ($1 >>> 0 <= 16777215) {
		   $2 = $1 >>> 8 | 0;
		   $3 = $2;
		   $2 = $2 + 1048320 >>> 16 & 8;
		   $4 = $3 << $2;
		   $3 = $4;
		   $4 = $4 + 520192 >>> 16 & 4;
		   $3 = $3 << $4;
		   $7 = $3;
		   $3 = $3 + 245760 >>> 16 & 2;
		   $2 = ($7 << $3 >>> 15 | 0) - ($2 | $4 | $3) | 0;
		   $2 = ($2 << 1 | $1 >>> $2 + 21 & 1) + 28 | 0;
		  }
		  HEAP32[$0 + 28 >> 2] = $2;
		  $4 = ($2 << 2) + 39712 | 0;
		  label$33 : {
		   $3 = HEAP32[9853];
		   $5 = 1 << $2;
		   label$34 : {
		    if (!($3 & $5)) {
		     HEAP32[9853] = $3 | $5;
		     HEAP32[$4 >> 2] = $0;
		     break label$34;
		    }
		    $2 = $1 << (($2 | 0) == 31 ? 0 : 25 - ($2 >>> 1 | 0) | 0);
		    $3 = HEAP32[$4 >> 2];
		    while (1) {
		     $4 = $3;
		     if ((HEAP32[$3 + 4 >> 2] & -8) == ($1 | 0)) {
		      break label$33;
		     }
		     $3 = $2 >>> 29 | 0;
		     $2 = $2 << 1;
		     $7 = ($3 & 4) + $4 | 0;
		     $5 = $7 + 16 | 0;
		     $3 = HEAP32[$5 >> 2];
		     if ($3) {
		      continue;
		     }
		     break;
		    }
		    HEAP32[$7 + 16 >> 2] = $0;
		   }
		   HEAP32[$0 + 24 >> 2] = $4;
		   HEAP32[$0 + 12 >> 2] = $0;
		   HEAP32[$0 + 8 >> 2] = $0;
		   return;
		  }
		  $1 = HEAP32[$4 + 8 >> 2];
		  HEAP32[$1 + 12 >> 2] = $0;
		  HEAP32[$4 + 8 >> 2] = $0;
		  HEAP32[$0 + 24 >> 2] = 0;
		  HEAP32[$0 + 12 >> 2] = $4;
		  HEAP32[$0 + 8 >> 2] = $1;
		 }
		}
		function silk_NLSF2A($0, $1, $2, $3) {
		 var $4 = 0, $5 = 0, $6 = 0, $7 = 0, $8 = 0, $9 = 0, $10 = 0, $11 = 0, $12 = 0, $13 = 0, $14 = 0, $15 = 0, $16 = 0, $17 = 0, $18 = 0, $19 = 0, $20 = 0, $21 = 0;
		 $6 = __stack_pointer - 320 | 0;
		 __stack_pointer = $6;
		 label$1 : {
		  switch ($2 - 10 | 0) {
		  default:
		   celt_fatal(1994, 2027, 89);
		   abort();
		  case 0:
		  case 6:
		   break label$1;
		  }
		 }
		 $12 = ($2 | 0) == 16 ? 1968 : 1984;
		 while (1) {
		  $8 = HEAP16[($5 << 1) + $1 >> 1];
		  $7 = $8 >> 8 << 1;
		  $3 = HEAP16[$7 + 1698 >> 1];
		  $7 = HEAP16[$7 + 1696 >> 1];
		  HEAP32[($6 + 224 | 0) + (HEAPU8[$5 + $12 | 0] << 2) >> 2] = (Math_imul($3 - $7 | 0, $8 & 255) + ($7 << 8) >> 3) + 1 >> 1;
		  $5 = $5 + 1 | 0;
		  if (($5 | 0) != ($2 | 0)) {
		   continue;
		  }
		  break;
		 }
		 $7 = 65536;
		 HEAP32[$6 + 160 >> 2] = 65536;
		 $1 = 0 - HEAP32[$6 + 224 >> 2] | 0;
		 HEAP32[$6 + 164 >> 2] = $1;
		 $5 = 1;
		 $19 = $2 >> 1;
		 label$4 : {
		  $20 = ($2 | 0) < 4;
		  if ($20) {
		   break label$4;
		  }
		  while (1) {
		   $17 = HEAP32[($6 + 224 | 0) + ($5 << 3) >> 2];
		   $3 = $17;
		   $4 = $3 >> 31;
		   $14 = $3;
		   $15 = $4;
		   $3 = $1;
		   $4 = $3 >> 31;
		   $3 = $4;
		   $13 = $5 + 1 | 0;
		   $18 = ($6 + 160 | 0) + ($13 << 2) | 0;
		   $4 = $15;
		   $3 = __wasm_i64_mul($14, $4, $1, $3);
		   $9 = $3;
		   $4 = i64toi32_i32$HIGH_BITS;
		   $3 = $4 >>> 15 | 0;
		   $4 = ($4 & 32767) << 17 | $9 >>> 15;
		   $10 = $4 + 1 | 0;
		   $11 = $10 >>> 0 < 1 ? $3 + 1 | 0 : $3;
		   $3 = $10;
		   HEAP32[$18 >> 2] = ($7 << 1) - (($11 & 1) << 31 | $3 >>> 1);
		   $8 = $5 << 2;
		   $16 = $8 + ($6 + 160 | 0) | 0;
		   label$6 : {
		    if ($5 >>> 0 < 2) {
		     break label$6;
		    }
		    $8 = HEAP32[($6 + $8 | 0) + 152 >> 2];
		    $1 = $8 + $1 | 0;
		    $3 = $7;
		    $4 = $3 >> 31;
		    $3 = $15;
		    $3 = __wasm_i64_mul($7, $4, $14, $3);
		    $11 = $3;
		    $4 = i64toi32_i32$HIGH_BITS;
		    $3 = $4 >>> 15 | 0;
		    $4 = ($4 & 32767) << 17 | $11 >>> 15;
		    $9 = $4 + 1 | 0;
		    $10 = $9 >>> 0 < 1 ? $3 + 1 | 0 : $3;
		    $3 = $9;
		    HEAP32[$16 >> 2] = $1 - (($10 & 1) << 31 | $3 >>> 1);
		    if (($5 | 0) == 2) {
		     break label$6;
		    }
		    while (1) {
		     $7 = $5 - 1 | 0;
		     $1 = ($6 + 160 | 0) + ($7 << 2) | 0;
		     $12 = HEAP32[(($5 << 2) + $6 | 0) + 148 >> 2];
		     $21 = $12 + HEAP32[$1 >> 2] | 0;
		     $3 = $8;
		     $4 = $3 >> 31;
		     $3 = $15;
		     $3 = __wasm_i64_mul($8, $4, $14, $3);
		     $10 = $3;
		     $4 = i64toi32_i32$HIGH_BITS;
		     $3 = $4 >>> 15 | 0;
		     $4 = ($4 & 32767) << 17 | $10 >>> 15;
		     $11 = $4 + 1 | 0;
		     $9 = $11 >>> 0 < 1 ? $3 + 1 | 0 : $3;
		     $3 = $11;
		     HEAP32[$1 >> 2] = $21 - (($9 & 1) << 31 | $3 >>> 1);
		     $1 = ($5 | 0) > 3;
		     $5 = $7;
		     $8 = $12;
		     if ($1) {
		      continue;
		     }
		     break;
		    }
		   }
		   HEAP32[$6 + 164 >> 2] = HEAP32[$6 + 164 >> 2] - $17;
		   if (($13 | 0) == ($19 | 0)) {
		    break label$4;
		   }
		   $1 = HEAP32[$18 >> 2];
		   $7 = HEAP32[$16 >> 2];
		   $5 = $13;
		   continue;
		  }
		 }
		 $7 = 65536;
		 HEAP32[$6 + 96 >> 2] = 65536;
		 $1 = 0 - HEAP32[$6 + 228 >> 2] | 0;
		 HEAP32[$6 + 100 >> 2] = $1;
		 label$8 : {
		  if ($20) {
		   break label$8;
		  }
		  $20 = $6 + 224 | 4;
		  $5 = 1;
		  while (1) {
		   $17 = HEAP32[($5 << 3) + $20 >> 2];
		   $3 = $17;
		   $4 = $3 >> 31;
		   $14 = $3;
		   $15 = $4;
		   $3 = $1;
		   $4 = $3 >> 31;
		   $3 = $4;
		   $13 = $5 + 1 | 0;
		   $18 = ($6 + 96 | 0) + ($13 << 2) | 0;
		   $4 = $15;
		   $3 = __wasm_i64_mul($14, $4, $1, $3);
		   $9 = $3;
		   $4 = i64toi32_i32$HIGH_BITS;
		   $3 = $4 >>> 15 | 0;
		   $4 = ($4 & 32767) << 17 | $9 >>> 15;
		   $10 = $4 + 1 | 0;
		   $11 = $10 >>> 0 < 1 ? $3 + 1 | 0 : $3;
		   $3 = $10;
		   HEAP32[$18 >> 2] = ($7 << 1) - (($11 & 1) << 31 | $3 >>> 1);
		   $8 = $5 << 2;
		   $16 = $8 + ($6 + 96 | 0) | 0;
		   label$10 : {
		    if ($5 >>> 0 < 2) {
		     break label$10;
		    }
		    $8 = HEAP32[($6 + $8 | 0) + 88 >> 2];
		    $1 = $8 + $1 | 0;
		    $3 = $7;
		    $4 = $3 >> 31;
		    $3 = $15;
		    $3 = __wasm_i64_mul($7, $4, $14, $3);
		    $11 = $3;
		    $4 = i64toi32_i32$HIGH_BITS;
		    $3 = $4 >>> 15 | 0;
		    $4 = ($4 & 32767) << 17 | $11 >>> 15;
		    $9 = $4 + 1 | 0;
		    $10 = $9 >>> 0 < 1 ? $3 + 1 | 0 : $3;
		    $3 = $9;
		    HEAP32[$16 >> 2] = $1 - (($10 & 1) << 31 | $3 >>> 1);
		    if (($5 | 0) == 2) {
		     break label$10;
		    }
		    while (1) {
		     $7 = $5 - 1 | 0;
		     $1 = ($6 + 96 | 0) + ($7 << 2) | 0;
		     $12 = HEAP32[(($5 << 2) + $6 | 0) + 84 >> 2];
		     $21 = $12 + HEAP32[$1 >> 2] | 0;
		     $3 = $8;
		     $4 = $3 >> 31;
		     $3 = $15;
		     $3 = __wasm_i64_mul($8, $4, $14, $3);
		     $10 = $3;
		     $4 = i64toi32_i32$HIGH_BITS;
		     $3 = $4 >>> 15 | 0;
		     $4 = ($4 & 32767) << 17 | $10 >>> 15;
		     $11 = $4 + 1 | 0;
		     $9 = $11 >>> 0 < 1 ? $3 + 1 | 0 : $3;
		     $3 = $11;
		     HEAP32[$1 >> 2] = $21 - (($9 & 1) << 31 | $3 >>> 1);
		     $1 = ($5 | 0) > 3;
		     $5 = $7;
		     $8 = $12;
		     if ($1) {
		      continue;
		     }
		     break;
		    }
		   }
		   HEAP32[$6 + 100 >> 2] = HEAP32[$6 + 100 >> 2] - $17;
		   if (($13 | 0) == ($19 | 0)) {
		    break label$8;
		   }
		   $1 = HEAP32[$18 >> 2];
		   $7 = HEAP32[$16 >> 2];
		   $5 = $13;
		   continue;
		  }
		 }
		 if (($2 | 0) >= 2) {
		  $16 = ($19 | 0) > 1 ? $19 : 1;
		  $7 = HEAP32[$6 + 96 >> 2];
		  $1 = HEAP32[$6 + 160 >> 2];
		  $5 = 0;
		  while (1) {
		   $8 = $5 + 1 | 0;
		   $12 = $8 << 2;
		   $13 = HEAP32[$12 + ($6 + 96 | 0) >> 2];
		   $7 = $13 - $7 | 0;
		   $12 = HEAP32[($6 + 160 | 0) + $12 >> 2];
		   $1 = $12 + $1 | 0;
		   HEAP32[($5 << 2) + $6 >> 2] = 0 - ($7 + $1 | 0);
		   HEAP32[(($5 ^ -1) + $2 << 2) + $6 >> 2] = $7 - $1;
		   $7 = $13;
		   $1 = $12;
		   $5 = $8;
		   if (($16 | 0) != ($5 | 0)) {
		    continue;
		   }
		   break;
		  }
		 }
		 silk_LPC_fit($0, $6, 12, 17, $2);
		 label$14 : {
		  if (silk_LPC_inverse_pred_gain_c($0, $2)) {
		   break label$14;
		  }
		  $8 = 0;
		  while (1) {
		   silk_bwexpander_32($6, $2, (-2 << $8) + 65536 | 0);
		   $5 = 0;
		   while (1) {
		    HEAP16[($5 << 1) + $0 >> 1] = (HEAP32[($5 << 2) + $6 >> 2] >>> 4 | 0) + 1 >>> 1;
		    $5 = $5 + 1 | 0;
		    if (($5 | 0) != ($2 | 0)) {
		     continue;
		    }
		    break;
		   }
		   $5 = silk_LPC_inverse_pred_gain_c($0, $2);
		   if ($8 >>> 0 > 14) {
		    break label$14;
		   }
		   $8 = $8 + 1 | 0;
		   if (!$5) {
		    continue;
		   }
		   break;
		  }
		 }
		 __stack_pointer = $6 + 320 | 0;
		}
		function celt_pitch_xcorr_c($0, $1, $2, $3, $4, $5) {
		 var $6 = Math_fround(0), $7 = 0, $8 = Math_fround(0), $9 = 0, $10 = 0, $11 = 0, $12 = Math_fround(0), $13 = 0, $14 = 0, $15 = 0, $16 = Math_fround(0), $17 = 0, $18 = Math_fround(0), $19 = 0, $20 = Math_fround(0), $21 = Math_fround(0), $22 = Math_fround(0), $23 = Math_fround(0), $24 = Math_fround(0), $25 = Math_fround(0), $26 = Math_fround(0), $27 = Math_fround(0), $28 = Math_fround(0), $29 = 0, $30 = 0, $31 = Math_fround(0), $32 = 0, $33 = 0, $34 = 0;
		 if (($4 | 0) >= 1) {
		  label$2 : {
		   if (($4 | 0) < 4) {
		    break label$2;
		   }
		   if (($3 | 0) >= 3) {
		    $32 = $4 - 3 | 0;
		    $19 = $3 - 3 | 0;
		    $33 = ($3 | 0) == 3;
		    $29 = $3 & -4;
		    $30 = $29 | 1;
		    $34 = ($30 + 1 | 0) >= ($3 | 0);
		    while (1) {
		     $17 = $11 << 2;
		     $5 = $17 + $1 | 0;
		     $7 = $5 + 12 | 0;
		     $8 = HEAPF32[$5 + 8 >> 2];
		     $18 = HEAPF32[$5 + 4 >> 2];
		     $16 = HEAPF32[$5 >> 2];
		     $12 = Math_fround(0);
		     $25 = Math_fround(0);
		     $26 = Math_fround(0);
		     $27 = Math_fround(0);
		     $5 = $0;
		     $10 = 0;
		     $9 = 0;
		     $13 = 0;
		     $14 = 0;
		     $15 = 0;
		     if (!$33) {
		      while (1) {
		       $20 = HEAPF32[$5 >> 2];
		       $6 = HEAPF32[$7 >> 2];
		       $21 = HEAPF32[$5 + 4 >> 2];
		       $22 = HEAPF32[$7 + 4 >> 2];
		       $23 = HEAPF32[$5 + 8 >> 2];
		       $28 = HEAPF32[$7 + 8 >> 2];
		       $24 = HEAPF32[$5 + 12 >> 2];
		       $31 = HEAPF32[$7 + 12 >> 2];
		       $12 = Math_fround(Math_fround(Math_fround(Math_fround($12 + Math_fround($20 * $6)) + Math_fround($21 * $22)) + Math_fround($23 * $28)) + Math_fround($24 * $31));
		       $25 = Math_fround(Math_fround(Math_fround(Math_fround($25 + Math_fround($8 * $20)) + Math_fround($6 * $21)) + Math_fround($22 * $23)) + Math_fround($28 * $24));
		       $26 = Math_fround(Math_fround(Math_fround(Math_fround($26 + Math_fround($18 * $20)) + Math_fround($8 * $21)) + Math_fround($6 * $23)) + Math_fround($22 * $24));
		       $27 = Math_fround(Math_fround(Math_fround(Math_fround($27 + Math_fround($16 * $20)) + Math_fround($18 * $21)) + Math_fround($8 * $23)) + Math_fround($6 * $24));
		       $7 = $7 + 16 | 0;
		       $5 = $5 + 16 | 0;
		       $16 = $22;
		       $8 = $31;
		       $18 = $28;
		       $10 = $10 + 4 | 0;
		       if (($19 | 0) > ($10 | 0)) {
		        continue;
		       }
		       break;
		      }
		      $13 = (wasm2js_scratch_store_f32($26), wasm2js_scratch_load_i32(2));
		      $14 = (wasm2js_scratch_store_f32($25), wasm2js_scratch_load_i32(2));
		      $15 = (wasm2js_scratch_store_f32($12), wasm2js_scratch_load_i32(2));
		      $12 = $6;
		      $9 = (wasm2js_scratch_store_f32($27), wasm2js_scratch_load_i32(2));
		     }
		     label$7 : {
		      if (($3 | 0) <= ($29 | 0)) {
		       break label$7;
		      }
		      $6 = HEAPF32[$5 >> 2];
		      $12 = HEAPF32[$7 >> 2];
		      $15 = (wasm2js_scratch_store_f32(Math_fround(Math_fround($6 * $12) + (wasm2js_scratch_store_i32(2, $15), wasm2js_scratch_load_f32()))), wasm2js_scratch_load_i32(2));
		      $14 = (wasm2js_scratch_store_f32(Math_fround(Math_fround($8 * $6) + (wasm2js_scratch_store_i32(2, $14), wasm2js_scratch_load_f32()))), wasm2js_scratch_load_i32(2));
		      $13 = (wasm2js_scratch_store_f32(Math_fround(Math_fround($18 * $6) + (wasm2js_scratch_store_i32(2, $13), wasm2js_scratch_load_f32()))), wasm2js_scratch_load_i32(2));
		      $9 = (wasm2js_scratch_store_f32(Math_fround(Math_fround($16 * $6) + (wasm2js_scratch_store_i32(2, $9), wasm2js_scratch_load_f32()))), wasm2js_scratch_load_i32(2));
		      $7 = $7 + 4 | 0;
		      $5 = $5 + 4 | 0;
		     }
		     $10 = $7;
		     label$9 : {
		      if (($3 | 0) <= ($30 | 0)) {
		       $7 = $10;
		       break label$9;
		      }
		      $6 = HEAPF32[$5 >> 2];
		      $16 = HEAPF32[$10 >> 2];
		      $15 = (wasm2js_scratch_store_f32(Math_fround(Math_fround($6 * $16) + (wasm2js_scratch_store_i32(2, $15), wasm2js_scratch_load_f32()))), wasm2js_scratch_load_i32(2));
		      $14 = (wasm2js_scratch_store_f32(Math_fround(Math_fround($12 * $6) + (wasm2js_scratch_store_i32(2, $14), wasm2js_scratch_load_f32()))), wasm2js_scratch_load_i32(2));
		      $13 = (wasm2js_scratch_store_f32(Math_fround(Math_fround($8 * $6) + (wasm2js_scratch_store_i32(2, $13), wasm2js_scratch_load_f32()))), wasm2js_scratch_load_i32(2));
		      $9 = (wasm2js_scratch_store_f32(Math_fround(Math_fround($18 * $6) + (wasm2js_scratch_store_i32(2, $9), wasm2js_scratch_load_f32()))), wasm2js_scratch_load_i32(2));
		      $5 = $5 + 4 | 0;
		      $7 = $10 + 4 | 0;
		     }
		     if (!$34) {
		      $6 = HEAPF32[$5 >> 2];
		      $15 = (wasm2js_scratch_store_f32(Math_fround(Math_fround($6 * HEAPF32[$7 >> 2]) + (wasm2js_scratch_store_i32(2, $15), wasm2js_scratch_load_f32()))), wasm2js_scratch_load_i32(2));
		      $14 = (wasm2js_scratch_store_f32(Math_fround(Math_fround($16 * $6) + (wasm2js_scratch_store_i32(2, $14), wasm2js_scratch_load_f32()))), wasm2js_scratch_load_i32(2));
		      $13 = (wasm2js_scratch_store_f32(Math_fround(Math_fround($12 * $6) + (wasm2js_scratch_store_i32(2, $13), wasm2js_scratch_load_f32()))), wasm2js_scratch_load_i32(2));
		      $9 = (wasm2js_scratch_store_f32(Math_fround(Math_fround($8 * $6) + (wasm2js_scratch_store_i32(2, $9), wasm2js_scratch_load_f32()))), wasm2js_scratch_load_i32(2));
		     }
		     HEAP32[$2 + $17 >> 2] = $9;
		     HEAP32[($17 | 4) + $2 >> 2] = $13;
		     HEAP32[($17 | 8) + $2 >> 2] = $14;
		     HEAP32[($17 | 12) + $2 >> 2] = $15;
		     $11 = $11 + 4 | 0;
		     if (($32 | 0) > ($11 | 0)) {
		      continue;
		     }
		     break;
		    }
		    break label$2;
		   }
		   celt_fatal(34032, 34057, 69);
		   abort();
		  }
		  if (($4 | 0) > ($11 | 0)) {
		   $9 = ($3 | 0) < 1;
		   while (1) {
		    $19 = $11 << 2;
		    $8 = Math_fround(0);
		    if (!$9) {
		     $10 = $1 + $19 | 0;
		     $7 = 0;
		     while (1) {
		      $5 = $7 << 2;
		      $8 = Math_fround($8 + Math_fround(HEAPF32[$5 + $0 >> 2] * HEAPF32[$5 + $10 >> 2]));
		      $7 = $7 + 1 | 0;
		      if (($7 | 0) != ($3 | 0)) {
		       continue;
		      }
		      break;
		     }
		    }
		    HEAPF32[$2 + $19 >> 2] = $8;
		    $11 = $11 + 1 | 0;
		    if (($11 | 0) != ($4 | 0)) {
		     continue;
		    }
		    break;
		   }
		  }
		  return;
		 }
		 celt_fatal(33965, 33995, 251);
		 abort();
		}
		function quant_band_stereo($0, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10) {
		 var $11 = Math_fround(0), $12 = 0, $13 = 0, $14 = 0, $15 = Math_fround(0), $16 = 0, $17 = 0, $18 = Math_fround(0), $19 = Math_fround(0), $20 = 0, $21 = 0, $22 = 0, $23 = Math_fround(0);
		 $12 = __stack_pointer - 32 | 0;
		 __stack_pointer = $12;
		 HEAP32[$12 + 24 >> 2] = $10;
		 HEAP32[$12 + 28 >> 2] = $4;
		 $4 = HEAP32[$0 + 28 >> 2];
		 $16 = HEAP32[$0 >> 2];
		 label$1 : {
		  if (($3 | 0) == 1) {
		   $3 = 0;
		   $10 = HEAP32[$0 + 32 >> 2];
		   if (($10 | 0) >= 8) {
		    label$4 : {
		     if ($16) {
		      $3 = HEAPF32[$1 >> 2] < Math_fround(0);
		      ec_enc_bits($4, $3, 1);
		      break label$4;
		     }
		     $3 = ec_dec_bits($4, 1);
		    }
		    $10 = HEAP32[$0 + 32 >> 2] - 8 | 0;
		    HEAP32[$0 + 32 >> 2] = $10;
		   }
		   if (HEAP32[$0 + 4 >> 2]) {
		    HEAPF32[$1 >> 2] = $3 ? Math_fround(-1) : Math_fround(1);
		   }
		   if ($2) {
		    $3 = $2 ? 2 : 1;
		    $7 = $3 >>> 0 > 1 ? $3 : 1;
		    $5 = 1;
		    while (1) {
		     $3 = 0;
		     if (($10 | 0) >= 8) {
		      label$10 : {
		       if ($16) {
		        $3 = HEAPF32[$2 >> 2] < Math_fround(0);
		        ec_enc_bits($4, $3, 1);
		        break label$10;
		       }
		       $3 = ec_dec_bits($4, 1);
		      }
		      $10 = HEAP32[$0 + 32 >> 2] - 8 | 0;
		      HEAP32[$0 + 32 >> 2] = $10;
		     }
		     if (HEAP32[$0 + 4 >> 2]) {
		      HEAPF32[$2 >> 2] = $3 ? Math_fround(-1) : Math_fround(1);
		     }
		     $5 = $5 + 1 | 0;
		     if (($7 | 0) != ($5 | 0)) {
		      continue;
		     }
		     break;
		    }
		   }
		   $7 = 1;
		   if (!$8) {
		    break label$1;
		   }
		   HEAP32[$8 >> 2] = HEAP32[$1 >> 2];
		   break label$1;
		  }
		  compute_theta($0, $12, $1, $2, $3, $12 + 28 | 0, $5, $5, $7, 1, $12 + 24 | 0);
		  $11 = Math_fround(Math_fround(HEAP32[$12 + 8 >> 2]) * Math_fround(30517578125e-15));
		  $19 = Math_fround(Math_fround(HEAP32[$12 + 4 >> 2]) * Math_fround(30517578125e-15));
		  $14 = HEAP32[$12 + 28 >> 2];
		  $17 = HEAP32[$12 + 20 >> 2];
		  $13 = HEAP32[$12 + 16 >> 2];
		  $22 = HEAP32[$12 >> 2];
		  label$13 : {
		   if (($3 | 0) == 2) {
		    $21 = $13 & -16385;
		    $20 = (($21 | 0) != 0) << 3;
		    HEAP32[$0 + 32 >> 2] = HEAP32[$0 + 32 >> 2] - ($20 + $17 | 0);
		    $13 = ($13 | 0) > 8192;
		    $17 = $13 ? $1 : $2;
		    $13 = $13 ? $2 : $1;
		    $20 = $14 - $20 | 0;
		    $14 = 0;
		    label$15 : {
		     if (!$21) {
		      break label$15;
		     }
		     if ($16) {
		      $14 = Math_fround(Math_fround(HEAPF32[$13 >> 2] * HEAPF32[$17 + 4 >> 2]) - Math_fround(HEAPF32[$13 + 4 >> 2] * HEAPF32[$17 >> 2])) < Math_fround(0);
		      ec_enc_bits($4, $14, 1);
		      break label$15;
		     }
		     $14 = ec_dec_bits($4, 1);
		    }
		    $7 = quant_band($0, $13, 2, $20, $5, $6, $7, $8, Math_fround(1), $9, $10);
		    $5 = 1 - ($14 << 1) | 0;
		    HEAPF32[$17 >> 2] = HEAPF32[$13 + 4 >> 2] * Math_fround(0 - $5 | 0);
		    HEAPF32[$17 + 4 >> 2] = HEAPF32[$13 >> 2] * Math_fround($5 | 0);
		    if (!HEAP32[$0 + 4 >> 2]) {
		     break label$13;
		    }
		    HEAPF32[$1 >> 2] = $19 * HEAPF32[$1 >> 2];
		    HEAPF32[$1 + 4 >> 2] = $19 * HEAPF32[$1 + 4 >> 2];
		    $15 = Math_fround($11 * HEAPF32[$2 >> 2]);
		    HEAPF32[$2 >> 2] = $15;
		    HEAPF32[$2 + 4 >> 2] = $11 * HEAPF32[$2 + 4 >> 2];
		    $11 = HEAPF32[$1 >> 2];
		    HEAPF32[$1 >> 2] = $11 - $15;
		    HEAPF32[$2 >> 2] = $11 + HEAPF32[$2 >> 2];
		    $11 = HEAPF32[$1 + 4 >> 2];
		    HEAPF32[$1 + 4 >> 2] = $11 - HEAPF32[$2 + 4 >> 2];
		    HEAPF32[$2 + 4 >> 2] = $11 + HEAPF32[$2 + 4 >> 2];
		    break label$13;
		   }
		   $10 = HEAP32[$12 + 12 >> 2];
		   $17 = HEAP32[$0 + 32 >> 2] - $17 | 0;
		   HEAP32[$0 + 32 >> 2] = $17;
		   $4 = HEAP32[$12 + 24 >> 2];
		   $10 = ($14 - $10 | 0) / 2 | 0;
		   $10 = ($10 | 0) > ($14 | 0) ? $14 : $10;
		   $10 = ($10 | 0) > 0 ? $10 : 0;
		   $16 = $14 - $10 | 0;
		   if (($10 | 0) >= ($16 | 0)) {
		    $6 = quant_band($0, $1, $3, $10, $5, $6, $7, $8, Math_fround(1), $9, $4);
		    $10 = (HEAP32[$0 + 32 >> 2] - $17 | 0) + $10 | 0;
		    $7 = $6 | quant_band($0, $2, $3, ($13 ? ($10 | 0) > 24 ? $10 - 24 | 0 : 0 : 0) + $16 | 0, $5, 0, $7, 0, $11, 0, $4 >> $5);
		    break label$13;
		   }
		   $14 = quant_band($0, $2, $3, $16, $5, 0, $7, 0, $11, 0, $4 >> $5);
		   $16 = (HEAP32[$0 + 32 >> 2] - $17 | 0) + $16 | 0;
		   $7 = $14 | quant_band($0, $1, $3, (($13 | 0) != 16384 ? ($16 | 0) > 24 ? $16 - 24 | 0 : 0 : 0) + $10 | 0, $5, $6, $7, $8, Math_fround(1), $9, $4);
		  }
		  if (!HEAP32[$0 + 4 >> 2]) {
		   break label$1;
		  }
		  label$18 : {
		   if (($3 | 0) == 2) {
		    break label$18;
		   }
		   $15 = Math_fround(0);
		   if (($3 | 0) >= 1) {
		    $0 = 0;
		    while (1) {
		     $5 = $0 << 2;
		     $11 = HEAPF32[$5 + $2 >> 2];
		     $18 = Math_fround($18 + Math_fround($11 * HEAPF32[$1 + $5 >> 2]));
		     $15 = Math_fround($15 + Math_fround($11 * $11));
		     $0 = $0 + 1 | 0;
		     if (($3 | 0) != ($0 | 0)) {
		      continue;
		     }
		     break;
		    }
		   }
		   label$22 : {
		    $15 = Math_fround(Math_fround($19 * $19) + $15);
		    $11 = Math_fround($19 * $18);
		    $11 = Math_fround($11 + $11);
		    $18 = Math_fround($15 + $11);
		    if (!($18 < Math_fround(.0006000000284984708))) {
		     $11 = Math_fround($15 - $11);
		     if ($11 < Math_fround(.0006000000284984708) ^ 1) {
		      break label$22;
		     }
		    }
		    memcpy($2, $1, $3 << 2);
		    break label$18;
		   }
		   if (($3 | 0) < 1) {
		    break label$1;
		   }
		   $18 = Math_fround(Math_fround(1) / Math_fround(Math_sqrt($18)));
		   $23 = Math_fround(Math_fround(1) / Math_fround(Math_sqrt($11)));
		   $0 = 0;
		   while (1) {
		    $5 = $0 << 2;
		    $10 = $5 + $1 | 0;
		    $11 = Math_fround($19 * HEAPF32[$10 >> 2]);
		    $5 = $2 + $5 | 0;
		    $15 = HEAPF32[$5 >> 2];
		    HEAPF32[$10 >> 2] = $23 * Math_fround($11 - $15);
		    HEAPF32[$5 >> 2] = $18 * Math_fround($11 + $15);
		    $0 = $0 + 1 | 0;
		    if (($3 | 0) != ($0 | 0)) {
		     continue;
		    }
		    break;
		   }
		  }
		  if (!$22 | ($3 | 0) < 1) {
		   break label$1;
		  }
		  $0 = 0;
		  while (1) {
		   $5 = ($0 << 2) + $2 | 0;
		   HEAPF32[$5 >> 2] = -HEAPF32[$5 >> 2];
		   $0 = $0 + 1 | 0;
		   if (($3 | 0) != ($0 | 0)) {
		    continue;
		   }
		   break;
		  }
		 }
		 __stack_pointer = $12 + 32 | 0;
		 return $7;
		}
		function silk_LPC_inverse_pred_gain_c($0, $1) {
		 var $2 = 0, $3 = 0, $4 = 0, $5 = 0, $6 = 0, $7 = 0, $8 = 0, $9 = 0, $10 = 0, $11 = 0, $12 = 0, $13 = 0, $14 = 0, $15 = 0, $16 = 0, $17 = 0, $18 = 0, $19 = 0, $20 = 0, $21 = 0, $22 = 0, $23 = 0, $24 = 0;
		 $13 = __stack_pointer - 96 | 0;
		 label$1 : {
		  if (($1 | 0) >= 1) {
		   while (1) {
		    $8 = HEAP16[($6 << 1) + $0 >> 1];
		    HEAP32[($6 << 2) + $13 >> 2] = $8 << 12;
		    $10 = $8 + $10 | 0;
		    $6 = $6 + 1 | 0;
		    if (($6 | 0) != ($1 | 0)) {
		     continue;
		    }
		    break;
		   }
		   if (($10 | 0) > 4095) {
		    break label$1;
		   }
		  }
		  $10 = $1 - 1 | 0;
		  $8 = HEAP32[($10 << 2) + $13 >> 2];
		  $6 = $8 + 16773022 >>> 0 > 33546044;
		  $9 = 1073741824;
		  if (($1 | 0) >= 2) {
		   while (1) {
		    if ($6 & 1) {
		     return 0;
		    }
		    $7 = 0 - ($8 << 7) | 0;
		    $3 = $7 >> 31;
		    $12 = $7;
		    $17 = $3;
		    $7 = __wasm_i64_mul($12, $3, $12, $3);
		    $3 = i64toi32_i32$HIGH_BITS;
		    $6 = 1073741824 - $3 | 0;
		    $2 = $6;
		    $7 = $2 >> 31;
		    $2 = $7;
		    $7 = $11;
		    $2 = __wasm_i64_mul($9, $7, $6, $2);
		    $3 = $2;
		    $7 = i64toi32_i32$HIGH_BITS;
		    $18 = (($7 & 1073741823) << 2 | $3 >>> 30) & -4;
		    if (($18 | 0) < 107374) {
		     break label$1;
		    }
		    $15 = $10;
		    $10 = 0;
		    $8 = $6 >> 31;
		    $16 = Math_clz32($8 ^ $6 + $8);
		    $8 = $6 << $16 - 1;
		    $0 = $8 >> 16;
		    $6 = 536870911 / ($0 | 0) | 0;
		    $3 = ($6 >> 15) + 1 >> 1;
		    $14 = $6 << 16;
		    $6 = $14 >> 16;
		    $8 = 0 - ((Math_imul($6, $8 & 65535) >> 16) + Math_imul($0, $6) << 3) | 0;
		    $3 = ((Math_imul($8, $3) + $14 | 0) + Math_imul($8 >> 16, $6) | 0) + (Math_imul($8 & 65528, $6) >> 16) | 0;
		    $2 = $3 >> 31;
		    $19 = $3;
		    $20 = $2;
		    $6 = $1 >>> 1 | 0;
		    $23 = $6 >>> 0 > 1 ? $6 : 1;
		    $21 = 31 - $16 | 0;
		    while (1) {
		     $14 = ($10 << 2) + $13 | 0;
		     $6 = HEAP32[$14 >> 2];
		     $22 = (($10 ^ -1) + $15 << 2) + $13 | 0;
		     $8 = HEAP32[$22 >> 2];
		     $3 = $8;
		     $2 = $3 >> 31;
		     $3 = $17;
		     $3 = __wasm_i64_mul($8, $2, $12, $3);
		     $7 = $3;
		     $2 = i64toi32_i32$HIGH_BITS;
		     $3 = $2 >>> 30 | 0;
		     $2 = ($2 & 1073741823) << 2 | $7 >>> 30;
		     $4 = $2 + 1 | 0;
		     $1 = $4 >>> 0 < 1 ? $3 + 1 | 0 : $3;
		     $3 = $4;
		     $1 = ($1 & 1) << 31 | $3 >>> 1;
		     $0 = $6 - $1 | 0;
		     $3 = $0;
		     $0 = ($0 | 0) > -1;
		     $3 = ((($0 ? $1 : $6) ^ -2147483648) & ($0 ? $6 : $1)) > -1 ? $3 : $0 ? -2147483648 : 2147483647;
		     $2 = $3 >> 31;
		     $0 = $3;
		     $3 = $20;
		     $3 = __wasm_i64_mul($0, $2, $19, $3);
		     $9 = $3;
		     $2 = i64toi32_i32$HIGH_BITS;
		     $11 = $2;
		     $1 = $3;
		     $7 = $3 & 1;
		     $3 = 0;
		     $4 = $3;
		     $3 = $2;
		     $2 = $1;
		     $5 = ($3 & 1) << 31 | $2 >>> 1;
		     $0 = ($16 | 0) != 31;
		     $1 = $3 >> 1;
		     $2 = $1;
		     $1 = $4;
		     $4 = $2 + $1 | 0;
		     $3 = $7;
		     $7 = $3 + $5 | 0;
		     $4 = $7 >>> 0 < $5 >>> 0 ? $4 + 1 | 0 : $4;
		     $1 = $7;
		     label$8 : {
		      if (!$0) {
		       break label$8;
		      }
		      $4 = $11;
		      $1 = $9;
		      $5 = $21;
		      $2 = $5 & 31;
		      if (($5 & 63) >>> 0 >= 32) {
		       $3 = $4 >> 31;
		       $4 = $4 >> $2;
		      } else {
		       $3 = $4 >> $2;
		       $4 = ((1 << $2) - 1 & $4) << 32 - $2 | $1 >>> $2;
		      }
		      $2 = $4 + 1 | 0;
		      $7 = $2 >>> 0 < 1 ? $3 + 1 | 0 : $3;
		      $3 = $2;
		      $1 = ($7 & 1) << 31 | $3 >>> 1;
		      $4 = $7 >> 1;
		     }
		     $2 = $4;
		     $9 = $1;
		     $7 = $9;
		     $1 = $7 - -2147483648 | 0;
		     $2 = $1 >>> 0 < 2147483648 ? $2 + 1 | 0 : $2;
		     if ($2) {
		      break label$1;
		     }
		     HEAP32[$14 >> 2] = $9;
		     $2 = $6;
		     $4 = $2 >> 31;
		     $2 = $17;
		     $2 = __wasm_i64_mul($6, $4, $12, $2);
		     $5 = $2;
		     $4 = i64toi32_i32$HIGH_BITS;
		     $2 = $4 >>> 30 | 0;
		     $4 = ($4 & 1073741823) << 2 | $5 >>> 30;
		     $3 = $4 + 1 | 0;
		     $1 = $3 >>> 0 < 1 ? $2 + 1 | 0 : $2;
		     $2 = $3;
		     $6 = ($1 & 1) << 31 | $2 >>> 1;
		     $1 = $8 - $6 | 0;
		     $3 = $1;
		     $1 = ($1 | 0) > -1;
		     $2 = ((($1 ? $6 : $8) ^ -2147483648) & ($1 ? $8 : $6)) > -1 ? $3 : $1 ? -2147483648 : 2147483647;
		     $4 = $2 >> 31;
		     $1 = $2;
		     $2 = $20;
		     $2 = __wasm_i64_mul($1, $4, $19, $2);
		     $9 = $2;
		     $4 = i64toi32_i32$HIGH_BITS;
		     $11 = $4;
		     if ($0) {
		      $4 = $11;
		      $1 = $9;
		      $7 = $21;
		      $5 = $7 & 31;
		      if (($7 & 63) >>> 0 >= 32) {
		       $2 = $4 >> 31;
		       $4 = $4 >> $5;
		      } else {
		       $2 = $4 >> $5;
		       $4 = ((1 << $5) - 1 & $4) << 32 - $5 | $1 >>> $5;
		      }
		      $5 = $4 + 1 | 0;
		      $3 = $5 >>> 0 < 1 ? $2 + 1 | 0 : $2;
		      $2 = $5;
		      $9 = ($3 & 1) << 31 | $2 >>> 1;
		      $4 = $3 >> 1;
		      $5 = $4;
		     } else {
		      $3 = $9;
		      $1 = $3 & 1;
		      $2 = 0;
		      $0 = $2;
		      $4 = $11;
		      $2 = $4;
		      $7 = ($2 & 1) << 31 | $3 >>> 1;
		      $3 = $2 >> 1;
		      $4 = $3;
		      $3 = $0;
		      $5 = $3 + $4 | 0;
		      $2 = $1;
		      $1 = $7 + $2 | 0;
		      $9 = $1;
		      $5 = $1 >>> 0 < $7 >>> 0 ? $5 + 1 | 0 : $5;
		     }
		     $11 = $5;
		     $3 = $9;
		     $4 = $3 - -2147483648 | 0;
		     $1 = $4 >>> 0 < 2147483648 ? $5 + 1 | 0 : $5;
		     $3 = 0;
		     if ($1) {
		      break label$1;
		     }
		     HEAP32[$22 >> 2] = $9;
		     $10 = $10 + 1 | 0;
		     if (($23 | 0) != ($10 | 0)) {
		      continue;
		     }
		     break;
		    }
		    $10 = $15 - 1 | 0;
		    $8 = HEAP32[($10 << 2) + $13 >> 2];
		    $6 = $8 + 16773022 >>> 0 > 33546044;
		    $1 = $18;
		    $5 = $1 >> 31;
		    $9 = $1;
		    $11 = $5;
		    $1 = $15;
		    if (($1 | 0) > 1) {
		     continue;
		    }
		    break;
		   }
		  }
		  if ($6) {
		   break label$1;
		  }
		  $1 = 0 - (HEAP32[$13 >> 2] << 7) | 0;
		  $5 = $1 >> 31;
		  $12 = $1;
		  $1 = __wasm_i64_mul($12, $5, $12, $5);
		  $2 = 0 - 0 | 0;
		  $5 = i64toi32_i32$HIGH_BITS;
		  $1 = $5 & 2147483647;
		  $4 = $1 + (($3 | 0) != 0) | 0;
		  $4 = 1073741824 - $4 | 0;
		  $5 = $4 >> 31;
		  $1 = $11;
		  $1 = __wasm_i64_mul($4, $5, $9, $1);
		  $4 = $1;
		  $5 = i64toi32_i32$HIGH_BITS;
		  $6 = (($5 & 1073741823) << 2 | $4 >>> 30) & -4;
		  $24 = ($6 | 0) < 107374 ? 0 : $6;
		 }
		 return $24;
		}
		function opus_packet_parse_impl($0, $1, $2, $3, $4, $5, $6, $7) {
		 var $8 = 0, $9 = 0, $10 = 0, $11 = 0, $12 = 0, $13 = 0, $14 = 0, $15 = 0, $16 = 0, $18 = 0, $19 = 0;
		 $15 = -1;
		 label$1 : {
		  if (!$5 | ($1 | 0) < 0) {
		   break label$1;
		  }
		  $15 = -4;
		  if (!$1) {
		   break label$1;
		  }
		  $16 = HEAPU8[$0 | 0];
		  label$2 : {
		   if ($16 & 128) {
		    $11 = (48e3 << ($16 >>> 3 & 3) >>> 0) / 400 | 0;
		    break label$2;
		   }
		   $11 = $16 & 8 ? 960 : 480;
		   if (($16 & 96) == 96) {
		    break label$2;
		   }
		   $9 = $16 >>> 3 & 3;
		   $11 = 2880;
		   if (($9 | 0) == 3) {
		    break label$2;
		   }
		   $11 = (48e3 << $9 >>> 0) / 100 | 0;
		  }
		  $10 = 1;
		  $9 = $0 + 1 | 0;
		  $8 = $1 - 1 | 0;
		  $12 = $8;
		  $13 = $16 & 3;
		  label$4 : {
		   label$5 : {
		    label$6 : {
		     label$7 : {
		      label$8 : {
		       switch ($13 | 0) {
		       case 1:
		        if ($2) {
		         $10 = 2;
		         $13 = 1;
		         $12 = $8;
		         break label$6;
		        }
		        if ($8 & 1) {
		         break label$1;
		        }
		        $12 = $8 >>> 1 | 0;
		        HEAP16[$5 >> 1] = $12;
		        $10 = 2;
		        break label$5;
		       case 2:
		        if (($1 | 0) <= 1) {
		         HEAP16[$5 >> 1] = 65535;
		         return -4;
		        }
		        $13 = HEAPU8[$9 | 0];
		        if ($13 >>> 0 >= 252) {
		         $10 = 2;
		         if (($1 | 0) <= 2) {
		          HEAP16[$5 >> 1] = 65535;
		          return -4;
		         }
		         $13 = (HEAPU8[$0 + 2 | 0] << 2) + $13 | 0;
		        }
		        HEAP16[$5 >> 1] = $13;
		        $8 = $8 - $10 | 0;
		        if (($13 | 0) > ($8 | 0)) {
		         break label$1;
		        }
		        $12 = $8 - $13 | 0;
		        $9 = $9 + $10 | 0;
		        $13 = 0;
		        $10 = 2;
		        break label$7;
		       case 0:
		        break label$7;
		       default:
		        break label$8;
		       }
		      }
		      if (($1 | 0) < 2) {
		       break label$1;
		      }
		      $14 = HEAPU8[$0 + 1 | 0];
		      $10 = $14 & 63;
		      if (!$10 | Math_imul($10, $11) >>> 0 > 5760) {
		       break label$1;
		      }
		      $13 = $0 + 2 | 0;
		      $1 = $1 - 2 | 0;
		      label$15 : {
		       if (!($14 & 64)) {
		        $9 = $13;
		        break label$15;
		       }
		       while (1) {
		        if (($1 | 0) < 1) {
		         break label$1;
		        }
		        $9 = HEAPU8[$13 | 0];
		        $12 = ($9 | 0) == 255;
		        $9 = ($12 ? -2 : $9) & 255;
		        $1 = ($9 ^ -1) + $1 | 0;
		        $9 = $13 + 1 | 0;
		        $13 = $9;
		        if ($12) {
		         continue;
		        }
		        break;
		       }
		       if (($1 | 0) < 0) {
		        break label$1;
		       }
		      }
		      $13 = $14 >>> 7 ^ 1;
		      if ($14 & 128) {
		       if ($10 >>> 0 < 2) {
		        $8 = $1;
		        $12 = $1;
		        break label$7;
		       }
		       $19 = $10 - 1 | 0;
		       $14 = 0;
		       $12 = $1;
		       $8 = $1;
		       while (1) {
		        $18 = ($14 << 1) + $5 | 0;
		        if (($8 | 0) <= 0) {
		         HEAP16[$18 >> 1] = 65535;
		         return -4;
		        }
		        $11 = 1;
		        $1 = HEAPU8[$9 | 0];
		        if ($1 >>> 0 >= 252) {
		         if (($8 | 0) <= 1) {
		          HEAP16[$18 >> 1] = 65535;
		          return -4;
		         }
		         $11 = 2;
		         $1 = (HEAPU8[$9 + 1 | 0] << 2) + $1 | 0;
		        }
		        HEAP16[$18 >> 1] = $1;
		        $8 = $8 - $11 | 0;
		        if (($8 | 0) < ($1 | 0)) {
		         break label$1;
		        }
		        $9 = $9 + $11 | 0;
		        $12 = ($12 - $11 | 0) - $1 | 0;
		        $14 = $14 + 1 | 0;
		        if (($19 | 0) != ($14 | 0)) {
		         continue;
		        }
		        break;
		       }
		       if (($12 | 0) >= 0) {
		        break label$7;
		       }
		       break label$1;
		      }
		      if ($2) {
		       $12 = $8;
		       $8 = $1;
		       break label$6;
		      }
		      $12 = ($1 | 0) / ($10 | 0) | 0;
		      if ((Math_imul($12, $10) | 0) != ($1 | 0)) {
		       break label$1;
		      }
		      if ($10 >>> 0 < 2) {
		       break label$5;
		      }
		      $11 = $10 - 1 | 0;
		      $8 = 0;
		      while (1) {
		       HEAP16[($8 << 1) + $5 >> 1] = $12;
		       $8 = $8 + 1 | 0;
		       if (($11 | 0) != ($8 | 0)) {
		        continue;
		       }
		       break;
		      }
		      $8 = $1;
		     }
		     if (!$2) {
		      break label$5;
		     }
		    }
		    $11 = (($10 << 1) + $5 | 0) - 2 | 0;
		    $1 = 65535;
		    $2 = -1;
		    label$26 : {
		     if (($8 | 0) < 1) {
		      break label$26;
		     }
		     $14 = HEAPU8[$9 | 0];
		     if ($14 >>> 0 < 252) {
		      $1 = $14;
		      $2 = 1;
		      break label$26;
		     }
		     $2 = -1;
		     if (($8 | 0) < 2) {
		      break label$26;
		     }
		     $1 = (HEAPU8[$9 + 1 | 0] << 2) + $14 | 0;
		     $2 = 2;
		    }
		    HEAP16[$11 >> 1] = $1;
		    $11 = $1 << 16 >> 16;
		    if (($11 | 0) < 0) {
		     break label$1;
		    }
		    $8 = $8 - $2 | 0;
		    if (($11 | 0) > ($8 | 0)) {
		     break label$1;
		    }
		    $9 = $2 + $9 | 0;
		    if ($13) {
		     if ((Math_imul($10, $11) | 0) > ($8 | 0)) {
		      break label$1;
		     }
		     if ($10 >>> 0 < 2) {
		      break label$4;
		     }
		     HEAP16[$5 >> 1] = $1;
		     $1 = 1;
		     $15 = $10 - 1 | 0;
		     if (($15 | 0) == 1) {
		      break label$4;
		     }
		     $2 = ($15 << 1) + $5 | 0;
		     while (1) {
		      HEAP16[($1 << 1) + $5 >> 1] = HEAPU16[$2 >> 1];
		      $1 = $1 + 1 | 0;
		      if (($15 | 0) != ($1 | 0)) {
		       continue;
		      }
		      break;
		     }
		     break label$4;
		    }
		    if (($2 + $11 | 0) > ($12 | 0)) {
		     break label$1;
		    }
		    break label$4;
		   }
		   if (($12 | 0) > 1275) {
		    break label$1;
		   }
		   HEAP16[(($10 << 1) + $5 | 0) - 2 >> 1] = $12;
		  }
		  if ($6) {
		   HEAP32[$6 >> 2] = $9 - $0;
		  }
		  if ($10) {
		   $1 = 0;
		   while (1) {
		    $9 = HEAP16[($1 << 1) + $5 >> 1] + $9 | 0;
		    $1 = $1 + 1 | 0;
		    if (($10 | 0) != ($1 | 0)) {
		     continue;
		    }
		    break;
		   }
		  }
		  if ($3) {
		   HEAP8[$3 | 0] = $16;
		  }
		  $15 = $10;
		 }
		 return $15;
		}
		function quant_partition($0, $1, $2, $3, $4, $5, $6, $7, $8) {
		 var $9 = 0, $10 = 0, $11 = 0, $12 = 0, $13 = 0, $14 = 0, $15 = 0, $16 = Math_fround(0), $17 = Math_fround(0), $18 = 0, $19 = 0, $20 = 0, $21 = 0;
		 $13 = __stack_pointer - 32 | 0;
		 __stack_pointer = $13;
		 HEAP32[$13 + 24 >> 2] = $8;
		 HEAP32[$13 + 28 >> 2] = $3;
		 $9 = HEAP32[$0 + 8 >> 2];
		 $10 = HEAP32[$9 + 100 >> 2] + HEAP16[HEAP32[$9 + 96 >> 2] + (HEAP32[$0 + 12 >> 2] + Math_imul(HEAP32[$9 + 8 >> 2], $6 + 1 | 0) << 1) >> 1] | 0;
		 $9 = HEAPU8[$10 | 0];
		 $15 = -1;
		 $18 = HEAP32[$0 + 28 >> 2];
		 $19 = HEAP32[$0 + 20 >> 2];
		 $20 = HEAP32[$0 >> 2];
		 label$1 : {
		  if (!(($6 | 0) == -1 | ($2 | 0) < 3 | (HEAPU8[$9 + $10 | 0] + 12 | 0) >= ($3 | 0))) {
		   $9 = $6 - 1 | 0;
		   $3 = $2 >>> 1 | 0;
		   $2 = ($3 << 2) + $1 | 0;
		   if (($4 | 0) == 1) {
		    HEAP32[$13 + 24 >> 2] = $8 & 1 | $8 << 1;
		   }
		   $14 = $4 + 1 >> 1;
		   compute_theta($0, $13, $1, $2, $3, $13 + 28 | 0, $14, $4, $9, 0, $13 + 24 | 0);
		   $16 = Math_fround(HEAP32[$13 + 8 >> 2]);
		   $17 = Math_fround(HEAP32[$13 + 4 >> 2]);
		   $8 = HEAP32[$13 + 20 >> 2];
		   $10 = HEAP32[$13 + 12 >> 2];
		   $15 = HEAP32[$13 + 16 >> 2];
		   $11 = $10;
		   label$4 : {
		    if (!($15 & 16383) | ($4 | 0) < 2) {
		     break label$4;
		    }
		    $11 = $10 - ($10 >> 5 - $6) | 0;
		    if (($15 | 0) >= 8193) {
		     break label$4;
		    }
		    $6 = ($3 << 3 >> 6 - $6) + $10 | 0;
		    $11 = $6 & $6 >> 31;
		   }
		   $10 = $11;
		   $16 = Math_fround($16 * Math_fround(30517578125e-15));
		   $17 = Math_fround($17 * Math_fround(30517578125e-15));
		   $6 = HEAP32[$13 + 28 >> 2];
		   $8 = HEAP32[$0 + 32 >> 2] - $8 | 0;
		   HEAP32[$0 + 32 >> 2] = $8;
		   $12 = $5 ? ($3 << 2) + $5 | 0 : 0;
		   $10 = ($6 - $10 | 0) / 2 | 0;
		   $10 = ($6 | 0) < ($10 | 0) ? $6 : $10;
		   $10 = ($10 | 0) > 0 ? $10 : 0;
		   $6 = $6 - $10 | 0;
		   if (($6 | 0) <= ($10 | 0)) {
		    $11 = HEAP32[$13 + 24 >> 2];
		    $1 = quant_partition($0, $1, $3, $10, $14, $5, $9, Math_fround($17 * $7), $11);
		    $10 = (HEAP32[$0 + 32 >> 2] - $8 | 0) + $10 | 0;
		    $9 = $1 | quant_partition($0, $2, $3, ($15 ? ($10 | 0) > 24 ? $10 - 24 | 0 : 0 : 0) + $6 | 0, $14, $12, $9, Math_fround($16 * $7), $11 >> $14) << ($4 >> 1);
		    break label$1;
		   }
		   $11 = HEAP32[$13 + 24 >> 2];
		   $2 = quant_partition($0, $2, $3, $6, $14, $12, $9, Math_fround($16 * $7), $11 >> $14);
		   $6 = (HEAP32[$0 + 32 >> 2] - $8 | 0) + $6 | 0;
		   $9 = quant_partition($0, $1, $3, (($15 | 0) != 16384 ? ($6 | 0) > 24 ? $6 - 24 | 0 : 0 : 0) + $10 | 0, $14, $5, $9, Math_fround($17 * $7), $11) | $2 << ($4 >> 1);
		   break label$1;
		  }
		  $6 = $3 - 1 | 0;
		  $12 = $9 + 1 >>> 1 | 0;
		  $3 = ($6 | 0) > HEAPU8[$12 + $10 | 0];
		  $9 = $3 ? $9 : $12;
		  $11 = $9;
		  $12 = $3 ? $12 : 0;
		  $3 = ($12 + $9 | 0) + 1 >>> 1 | 0;
		  $9 = HEAPU8[$10 + $3 | 0] < ($6 | 0);
		  $11 = $9 ? $11 : $3;
		  $9 = $9 ? $3 : $12;
		  $3 = ($11 + $9 | 0) + 1 >>> 1 | 0;
		  $12 = HEAPU8[$10 + $3 | 0] < ($6 | 0);
		  $9 = $12 ? $3 : $9;
		  $11 = $12 ? $11 : $3;
		  $3 = ($9 + $11 | 0) + 1 >>> 1 | 0;
		  $12 = HEAPU8[$10 + $3 | 0] < ($6 | 0);
		  $9 = $12 ? $3 : $9;
		  $11 = $12 ? $11 : $3;
		  $3 = ($9 + $11 | 0) + 1 >> 1;
		  $12 = HEAPU8[$10 + $3 | 0] < ($6 | 0);
		  $11 = $12 ? $11 : $3;
		  $21 = $11;
		  $12 = $12 ? $3 : $9;
		  $3 = ($11 + $12 | 0) + 1 >> 1;
		  $11 = HEAPU8[$10 + $3 | 0] < ($6 | 0);
		  $9 = $11 ? $21 : $3;
		  $3 = $11 ? $3 : $12;
		  if ($3) {
		   $15 = HEAPU8[$3 + $10 | 0];
		  }
		  $3 = ($6 - $15 | 0) > (HEAPU8[$9 + $10 | 0] - $6 | 0) ? $9 : $3;
		  if ($3) {
		   $14 = HEAPU8[$3 + $10 | 0] + 1 | 0;
		  }
		  $9 = HEAP32[$0 + 32 >> 2] - $14 | 0;
		  HEAP32[$0 + 32 >> 2] = $9;
		  label$9 : {
		   label$10 : {
		    if (($9 | 0) > -1) {
		     $6 = $3;
		     break label$10;
		    }
		    if (($3 | 0) < 1) {
		     $6 = $3;
		     break label$10;
		    }
		    while (1) {
		     $9 = $9 + $14 | 0;
		     HEAP32[$0 + 32 >> 2] = $9;
		     $6 = $3 - 1 | 0;
		     if (!$6) {
		      HEAP32[$0 + 32 >> 2] = $9;
		      break label$9;
		     }
		     $14 = HEAPU8[$6 + $10 | 0] + 1 | 0;
		     $9 = $9 - $14 | 0;
		     HEAP32[$0 + 32 >> 2] = $9;
		     if (($9 | 0) > -1) {
		      break label$10;
		     }
		     $15 = ($3 | 0) > 1;
		     $3 = $6;
		     if ($15) {
		      continue;
		     }
		     break;
		    }
		   }
		   if (!$6) {
		    break label$9;
		   }
		   $6 = ($6 | 0) >= 8 ? ($6 & 7 | 8) << ($6 >>> 3 | 0) - 1 : $6;
		   if ($20) {
		    $9 = alg_quant($1, $2, $6, $19, $4, $18, $7, HEAP32[$0 + 4 >> 2], HEAP32[$0 + 44 >> 2]);
		    break label$1;
		   }
		   $9 = alg_unquant($1, $2, $6, $19, $4, $18, $7);
		   break label$1;
		  }
		  if (!HEAP32[$0 + 4 >> 2]) {
		   $9 = 0;
		   break label$1;
		  }
		  $9 = -1 << $4 ^ -1;
		  $14 = $9 & $8;
		  HEAP32[$13 + 24 >> 2] = $14;
		  if (!$14) {
		   $9 = 0;
		   memset($1, 0, $2 << 2);
		   break label$1;
		  }
		  label$19 : {
		   if ($5) {
		    if (($2 | 0) >= 1) {
		     $3 = HEAP32[$0 + 40 >> 2];
		     $6 = 0;
		     while (1) {
		      $9 = $6 << 2;
		      $3 = Math_imul($3, 1664525) + 1013904223 | 0;
		      HEAPF32[$9 + $1 >> 2] = HEAPF32[$5 + $9 >> 2] + ($3 & 32768 ? Math_fround(.00390625) : Math_fround(-390625e-8));
		      $6 = $6 + 1 | 0;
		      if (($6 | 0) != ($2 | 0)) {
		       continue;
		      }
		      break;
		     }
		     HEAP32[$0 + 40 >> 2] = $3;
		    }
		    $9 = $14;
		    break label$19;
		   }
		   if (($2 | 0) < 1) {
		    break label$19;
		   }
		   $3 = HEAP32[$0 + 40 >> 2];
		   $6 = 0;
		   while (1) {
		    $3 = Math_imul($3, 1664525) + 1013904223 | 0;
		    HEAPF32[($6 << 2) + $1 >> 2] = $3 >> 20;
		    $6 = $6 + 1 | 0;
		    if (($6 | 0) != ($2 | 0)) {
		     continue;
		    }
		    break;
		   }
		   HEAP32[$0 + 40 >> 2] = $3;
		  }
		  renormalise_vector($1, $2, $7, HEAP32[$0 + 44 >> 2]);
		 }
		 __stack_pointer = $13 + 32 | 0;
		 return $9;
		}
		function pitch_search($0, $1, $2, $3, $4, $5) {
		 var $6 = Math_fround(0), $7 = Math_fround(0), $8 = 0, $9 = 0, $10 = 0, $11 = 0, $12 = Math_fround(0), $13 = Math_fround(0), $14 = Math_fround(0), $15 = 0, $16 = 0, $17 = Math_fround(0), $18 = 0, $19 = 0, $20 = Math_fround(0), $21 = 0;
		 $5 = __stack_pointer;
		 $21 = $5;
		 label$1 : {
		  {
		   if (($3 | 0) <= 0) {
		    break label$1;
		   }
		   $11 = $2 >>> 2 | 0;
		   $8 = $5 - (($11 << 2) + 15 & -16) | 0;
		   $5 = $8;
		   __stack_pointer = $5;
		   $9 = $2 + $3 | 0;
		   $10 = $5 - (($9 & -4) + 15 & -16) | 0;
		   $5 = $10;
		   __stack_pointer = $5;
		   $15 = $3 >>> 1 | 0;
		   $16 = $5 - (($15 << 2) + 15 & -16) | 0;
		   __stack_pointer = $16;
		   if ($11) {
		    $5 = 0;
		    while (1) {
		     HEAP32[($5 << 2) + $8 >> 2] = HEAP32[($5 << 3) + $0 >> 2];
		     $5 = $5 + 1 | 0;
		     if (($11 | 0) != ($5 | 0)) {
		      continue;
		     }
		     break;
		    }
		   }
		   if (($9 | 0) >= 4) {
		    $5 = $9 >> 2;
		    $9 = ($5 | 0) > 1 ? $5 : 1;
		    $5 = 0;
		    while (1) {
		     HEAP32[($5 << 2) + $10 >> 2] = HEAP32[($5 << 3) + $1 >> 2];
		     $5 = $5 + 1 | 0;
		     if (($9 | 0) != ($5 | 0)) {
		      continue;
		     }
		     break;
		    }
		   }
		   $9 = $3 >> 2;
		   celt_pitch_xcorr_c($8, $10, $16, $11, $9, $5);
		   $7 = Math_fround(1);
		   if ($11) {
		    $5 = 0;
		    while (1) {
		     $6 = HEAPF32[($5 << 2) + $10 >> 2];
		     $7 = Math_fround($7 + Math_fround($6 * $6));
		     $5 = $5 + 1 | 0;
		     if (($11 | 0) != ($5 | 0)) {
		      continue;
		     }
		     break;
		    }
		   }
		   $18 = 1;
		   if (($3 | 0) > 3) {
		    $13 = Math_fround(-1);
		    $5 = 0;
		    $14 = Math_fround(-1);
		    while (1) {
		     $8 = $5 << 2;
		     $6 = HEAPF32[$16 + $8 >> 2];
		     label$11 : {
		      if ($6 > Math_fround(0) ^ 1) {
		       break label$11;
		      }
		      $6 = Math_fround($6 * Math_fround(9.999999960041972e-13));
		      $6 = Math_fround($6 * $6);
		      if (Math_fround($12 * $6) > Math_fround($14 * $7) ^ 1) {
		       break label$11;
		      }
		      if (Math_fround($17 * $6) > Math_fround($13 * $7)) {
		       $18 = $19;
		       $19 = $5;
		       $14 = $13;
		       $13 = $6;
		       $12 = $17;
		       $17 = $7;
		       break label$11;
		      }
		      $18 = $5;
		      $14 = $6;
		      $12 = $7;
		     }
		     $6 = HEAPF32[($5 + $11 << 2) + $10 >> 2];
		     $20 = Math_fround($6 * $6);
		     $6 = HEAPF32[$10 + $8 >> 2];
		     $7 = Math_fround(Math_max(Math_fround($7 + Math_fround($20 - Math_fround($6 * $6))), Math_fround(1)));
		     $5 = $5 + 1 | 0;
		     if (($9 | 0) != ($5 | 0)) {
		      continue;
		     }
		     break;
		    }
		   }
		   label$13 : {
		    if (!$15) {
		     $11 = $2 >> 1;
		     break label$13;
		    }
		    $11 = $2 >> 1;
		    $18 = $18 << 1;
		    $19 = $19 << 1;
		    $9 = 0;
		    while (1) {
		     $10 = $9 << 2;
		     $3 = $16 + $10 | 0;
		     HEAP32[$3 >> 2] = 0;
		     $5 = $9 - $19 | 0;
		     $8 = $5;
		     $5 = $5 >> 31;
		     label$16 : {
		      if (($5 ^ $5 + $8) >= 3) {
		       $5 = $9 - $18 | 0;
		       $8 = $5;
		       $5 = $5 >> 31;
		       if (($5 ^ $5 + $8) > 2) {
		        break label$16;
		       }
		      }
		      $7 = Math_fround(0);
		      {
		       $8 = $1 + $10 | 0;
		       $5 = 0;
		       while (1) {
		        $10 = $5 << 2;
		        $7 = Math_fround($7 + Math_fround(HEAPF32[$10 + $0 >> 2] * HEAPF32[$10 + $8 >> 2]));
		        $5 = $5 + 1 | 0;
		        if (($11 | 0) != ($5 | 0)) {
		         continue;
		        }
		        break;
		       }
		      }
		      HEAPF32[$3 >> 2] = Math_max($7, Math_fround(-1));
		     }
		     $9 = $9 + 1 | 0;
		     if (($15 | 0) != ($9 | 0)) {
		      continue;
		     }
		     break;
		    }
		   }
		   $7 = Math_fround(1);
		   {
		    $5 = 0;
		    while (1) {
		     $6 = HEAPF32[($5 << 2) + $1 >> 2];
		     $7 = Math_fround($7 + Math_fround($6 * $6));
		     $5 = $5 + 1 | 0;
		     if (($11 | 0) != ($5 | 0)) {
		      continue;
		     }
		     break;
		    }
		   }
		   $8 = 0;
		   label$22 : {
		    if (!$15) {
		     $0 = 0;
		     break label$22;
		    }
		    $13 = Math_fround(-1);
		    $17 = Math_fround(0);
		    $0 = 0;
		    $5 = 0;
		    $12 = Math_fround(0);
		    $14 = Math_fround(-1);
		    while (1) {
		     $10 = $5 << 2;
		     $6 = HEAPF32[$16 + $10 >> 2];
		     label$25 : {
		      if ($6 > Math_fround(0) ^ 1) {
		       break label$25;
		      }
		      $6 = Math_fround($6 * Math_fround(9.999999960041972e-13));
		      $6 = Math_fround($6 * $6);
		      if (Math_fround($12 * $6) > Math_fround($14 * $7) ^ 1) {
		       break label$25;
		      }
		      if (Math_fround($17 * $6) > Math_fround($13 * $7)) {
		       $0 = $5;
		       $14 = $13;
		       $13 = $6;
		       $12 = $17;
		       $17 = $7;
		       break label$25;
		      }
		      $14 = $6;
		      $12 = $7;
		     }
		     $6 = HEAPF32[($5 + $11 << 2) + $1 >> 2];
		     $20 = Math_fround($6 * $6);
		     $6 = HEAPF32[$1 + $10 >> 2];
		     $7 = Math_fround(Math_max(Math_fround($7 + Math_fround($20 - Math_fround($6 * $6))), Math_fround(1)));
		     $5 = $5 + 1 | 0;
		     if (($15 | 0) != ($5 | 0)) {
		      continue;
		     }
		     break;
		    }
		    if (($0 | 0) < 1 | ($15 - 1 | 0) <= ($0 | 0)) {
		     break label$22;
		    }
		    $8 = -1;
		    $5 = ($0 << 2) + $16 | 0;
		    $6 = HEAPF32[$5 + 4 >> 2];
		    $7 = HEAPF32[$5 - 4 >> 2];
		    $12 = HEAPF32[$5 >> 2];
		    if (Math_fround($6 - $7) > Math_fround(Math_fround($12 - $7) * Math_fround(.699999988079071))) {
		     break label$22;
		    }
		    $8 = Math_fround($7 - $6) > Math_fround(Math_fround($12 - $6) * Math_fround(.699999988079071));
		   }
		   HEAP32[$4 >> 2] = ($0 << 1) + $8;
		   __stack_pointer = $21;
		   return;
		  }
		 }
		 celt_fatal(33965, 33995, 303);
		 abort();
		}
		function exp_rotation($0, $1, $2, $3, $4, $5) {
		 var $6 = Math_fround(0), $7 = 0, $8 = Math_fround(0), $9 = Math_fround(0), $10 = Math_fround(0), $11 = 0, $12 = 0, $13 = 0, $14 = 0, $15 = 0, $16 = 0, $17 = 0, $18 = 0, $19 = 0, $20 = 0;
		 label$1 : {
		  if (!$5 | $4 << 1 >= ($1 | 0)) {
		   break label$1;
		  }
		  $9 = Math_fround(Math_fround($1 | 0) / Math_fround(Math_imul(HEAP32[($5 << 2) + 33188 >> 2], $4) + $1 | 0));
		  $9 = Math_fround(Math_fround($9 * $9) * Math_fround(.5));
		  $18 = cos(+Math_fround($9 * Math_fround(1.5707963705062866)));
		  $19 = cos(+Math_fround(Math_fround(Math_fround(1) - $9) * Math_fround(1.5707963705062866)));
		  $5 = 0;
		  if ($3 << 3 <= ($1 | 0)) {
		   $7 = $3 >> 2;
		   $4 = 1;
		   while (1) {
		    $5 = $4;
		    $4 = $4 + 1 | 0;
		    if ((Math_imul(Math_imul($5, $5) + $5 | 0, $3) + $7 | 0) < ($1 | 0)) {
		     continue;
		    }
		    break;
		   }
		  }
		  if (($3 | 0) < 1) {
		   break label$1;
		  }
		  $9 = Math_fround($18);
		  $10 = Math_fround($19);
		  $14 = ($1 >>> 0) / ($3 >>> 0) | 0;
		  $15 = $14 - $5 | 0;
		  $12 = $14 - 3 | 0;
		  $16 = $14 - 1 | 0;
		  $13 = ($5 << 1 ^ -1) + $14 | 0;
		  $20 = ($2 | 0) > -1;
		  $2 = 0;
		  while (1) {
		   $11 = Math_imul($2, $14);
		   label$5 : {
		    if (!$20) {
		     label$7 : {
		      if (!$5) {
		       break label$7;
		      }
		      $1 = 0;
		      $17 = ($11 << 2) + $0 | 0;
		      $4 = $17;
		      if (($15 | 0) >= 1) {
		       while (1) {
		        $7 = ($5 << 2) + $4 | 0;
		        $8 = HEAPF32[$7 >> 2];
		        $6 = HEAPF32[$4 >> 2];
		        HEAPF32[$7 >> 2] = Math_fround($6 * $9) + Math_fround($8 * $10);
		        HEAPF32[$4 >> 2] = Math_fround($6 * $10) - Math_fround($8 * $9);
		        $4 = $4 + 4 | 0;
		        $1 = $1 + 1 | 0;
		        if (($15 | 0) != ($1 | 0)) {
		         continue;
		        }
		        break;
		       }
		      }
		      if (($13 | 0) < 0) {
		       break label$7;
		      }
		      $4 = ($13 << 2) + $17 | 0;
		      $1 = $13;
		      while (1) {
		       $7 = ($5 << 2) + $4 | 0;
		       $8 = HEAPF32[$7 >> 2];
		       $6 = HEAPF32[$4 >> 2];
		       HEAPF32[$7 >> 2] = Math_fround($6 * $9) + Math_fround($8 * $10);
		       HEAPF32[$4 >> 2] = Math_fround($6 * $10) - Math_fround($8 * $9);
		       $4 = $4 - 4 | 0;
		       $7 = ($1 | 0) > 0;
		       $1 = $1 - 1 | 0;
		       if ($7) {
		        continue;
		       }
		       break;
		      }
		     }
		     $7 = ($11 << 2) + $0 | 0;
		     if (($16 | 0) >= 1) {
		      $6 = HEAPF32[$7 >> 2];
		      $1 = 0;
		      $4 = $7;
		      while (1) {
		       $8 = HEAPF32[$4 + 4 >> 2];
		       HEAPF32[$4 >> 2] = Math_fround($6 * $9) - Math_fround($8 * $10);
		       $6 = Math_fround(Math_fround($6 * $10) + Math_fround($8 * $9));
		       HEAPF32[$4 + 4 >> 2] = $6;
		       $4 = $4 + 4 | 0;
		       $1 = $1 + 1 | 0;
		       if (($16 | 0) != ($1 | 0)) {
		        continue;
		       }
		       break;
		      }
		     }
		     if (($12 | 0) < 0) {
		      break label$5;
		     }
		     $4 = ($12 << 2) + $7 | 0;
		     $1 = $12;
		     while (1) {
		      $6 = HEAPF32[$4 >> 2];
		      $8 = HEAPF32[$4 + 4 >> 2];
		      HEAPF32[$4 + 4 >> 2] = Math_fround($6 * $10) + Math_fround($8 * $9);
		      HEAPF32[$4 >> 2] = Math_fround($6 * $9) - Math_fround($8 * $10);
		      $4 = $4 - 4 | 0;
		      $7 = ($1 | 0) > 0;
		      $1 = $1 - 1 | 0;
		      if ($7) {
		       continue;
		      }
		      break;
		     }
		     break label$5;
		    }
		    $11 = ($11 << 2) + $0 | 0;
		    if (($16 | 0) >= 1) {
		     $6 = HEAPF32[$11 >> 2];
		     $1 = 0;
		     $4 = $11;
		     while (1) {
		      $8 = HEAPF32[$4 + 4 >> 2];
		      HEAPF32[$4 >> 2] = Math_fround($6 * $9) + Math_fround($8 * $10);
		      $6 = Math_fround(Math_fround($8 * $9) - Math_fround($6 * $10));
		      HEAPF32[$4 + 4 >> 2] = $6;
		      $4 = $4 + 4 | 0;
		      $1 = $1 + 1 | 0;
		      if (($16 | 0) != ($1 | 0)) {
		       continue;
		      }
		      break;
		     }
		    }
		    if (($12 | 0) >= 0) {
		     $4 = ($12 << 2) + $11 | 0;
		     $1 = $12;
		     while (1) {
		      $6 = HEAPF32[$4 + 4 >> 2];
		      $8 = HEAPF32[$4 >> 2];
		      HEAPF32[$4 + 4 >> 2] = Math_fround($6 * $9) - Math_fround($8 * $10);
		      HEAPF32[$4 >> 2] = Math_fround($8 * $9) + Math_fround($6 * $10);
		      $4 = $4 - 4 | 0;
		      $7 = ($1 | 0) > 0;
		      $1 = $1 - 1 | 0;
		      if ($7) {
		       continue;
		      }
		      break;
		     }
		    }
		    if (!$5) {
		     break label$5;
		    }
		    $1 = 0;
		    $4 = $11;
		    if (($15 | 0) >= 1) {
		     while (1) {
		      $7 = ($5 << 2) + $4 | 0;
		      $6 = HEAPF32[$7 >> 2];
		      $8 = HEAPF32[$4 >> 2];
		      HEAPF32[$7 >> 2] = Math_fround($6 * $10) - Math_fround($8 * $9);
		      HEAPF32[$4 >> 2] = Math_fround($8 * $10) + Math_fround($6 * $9);
		      $4 = $4 + 4 | 0;
		      $1 = $1 + 1 | 0;
		      if (($15 | 0) != ($1 | 0)) {
		       continue;
		      }
		      break;
		     }
		    }
		    if (($13 | 0) < 0) {
		     break label$5;
		    }
		    $4 = ($13 << 2) + $11 | 0;
		    $1 = $13;
		    while (1) {
		     $7 = ($5 << 2) + $4 | 0;
		     $6 = HEAPF32[$7 >> 2];
		     $8 = HEAPF32[$4 >> 2];
		     HEAPF32[$7 >> 2] = Math_fround($6 * $10) - Math_fround($8 * $9);
		     HEAPF32[$4 >> 2] = Math_fround($8 * $10) + Math_fround($6 * $9);
		     $4 = $4 - 4 | 0;
		     $7 = ($1 | 0) > 0;
		     $1 = $1 - 1 | 0;
		     if ($7) {
		      continue;
		     }
		     break;
		    }
		   }
		   $2 = $2 + 1 | 0;
		   if (($3 | 0) != ($2 | 0)) {
		    continue;
		   }
		   break;
		  }
		 }
		}
		function __rem_pio2($0, $1) {
		 var $2 = 0, $3 = 0, $4 = 0, $5 = 0, $6 = 0, $7 = 0, $8 = 0, $9 = 0, $10 = 0, $11 = 0, $12 = 0;
		 $6 = __stack_pointer - 48 | 0;
		 __stack_pointer = $6;
		 label$1 : {
		  label$2 : {
		   wasm2js_scratch_store_f64(+$0);
		   $4 = wasm2js_scratch_load_i32(1) | 0;
		   $8 = wasm2js_scratch_load_i32(0) | 0;
		   $3 = $4;
		   $7 = $4 & 2147483647;
		   label$3 : {
		    if ($7 >>> 0 <= 1074752122) {
		     if (($3 & 1048575) == 598523) {
		      break label$3;
		     }
		     if ($7 >>> 0 <= 1073928572) {
		      if (($4 | 0) > 0 ? 1 : ($4 | 0) >= 0) {
		       $0 = $0 + -1.5707963267341256;
		       $2 = $0 + -6077100506506192e-26;
		       HEAPF64[$1 >> 3] = $2;
		       HEAPF64[$1 + 8 >> 3] = $0 - $2 + -6077100506506192e-26;
		       $3 = 1;
		       break label$1;
		      }
		      $0 = $0 + 1.5707963267341256;
		      $2 = $0 + 6.077100506506192e-11;
		      HEAPF64[$1 >> 3] = $2;
		      HEAPF64[$1 + 8 >> 3] = $0 - $2 + 6.077100506506192e-11;
		      $3 = -1;
		      break label$1;
		     }
		     if (($4 | 0) > 0 ? 1 : ($4 | 0) >= 0) {
		      $0 = $0 + -3.1415926534682512;
		      $2 = $0 + -12154201013012384e-26;
		      HEAPF64[$1 >> 3] = $2;
		      HEAPF64[$1 + 8 >> 3] = $0 - $2 + -12154201013012384e-26;
		      $3 = 2;
		      break label$1;
		     }
		     $0 = $0 + 3.1415926534682512;
		     $2 = $0 + 1.2154201013012384e-10;
		     HEAPF64[$1 >> 3] = $2;
		     HEAPF64[$1 + 8 >> 3] = $0 - $2 + 1.2154201013012384e-10;
		     $3 = -2;
		     break label$1;
		    }
		    if ($7 >>> 0 <= 1075594811) {
		     if ($7 >>> 0 <= 1075183036) {
		      if (($7 | 0) == 1074977148) {
		       break label$3;
		      }
		      if (($4 | 0) > 0 ? 1 : ($4 | 0) >= 0) {
		       $0 = $0 + -4.712388980202377;
		       $2 = $0 + -18231301519518578e-26;
		       HEAPF64[$1 >> 3] = $2;
		       HEAPF64[$1 + 8 >> 3] = $0 - $2 + -18231301519518578e-26;
		       $3 = 3;
		       break label$1;
		      }
		      $0 = $0 + 4.712388980202377;
		      $2 = $0 + 1.8231301519518578e-10;
		      HEAPF64[$1 >> 3] = $2;
		      HEAPF64[$1 + 8 >> 3] = $0 - $2 + 1.8231301519518578e-10;
		      $3 = -3;
		      break label$1;
		     }
		     if (($7 | 0) == 1075388923) {
		      break label$3;
		     }
		     if (($4 | 0) > 0 ? 1 : ($4 | 0) >= 0) {
		      $0 = $0 + -6.2831853069365025;
		      $2 = $0 + -2430840202602477e-25;
		      HEAPF64[$1 >> 3] = $2;
		      HEAPF64[$1 + 8 >> 3] = $0 - $2 + -2430840202602477e-25;
		      $3 = 4;
		      break label$1;
		     }
		     $0 = $0 + 6.2831853069365025;
		     $2 = $0 + 2.430840202602477e-10;
		     HEAPF64[$1 >> 3] = $2;
		     HEAPF64[$1 + 8 >> 3] = $0 - $2 + 2.430840202602477e-10;
		     $3 = -4;
		     break label$1;
		    }
		    if ($7 >>> 0 > 1094263290) {
		     break label$2;
		    }
		   }
		   $2 = $0 * .6366197723675814 + 6755399441055744 + -6755399441055744;
		   $9 = $0 + $2 * -1.5707963267341256;
		   $11 = $2 * 6.077100506506192e-11;
		   $0 = $9 - $11;
		   HEAPF64[$1 >> 3] = $0;
		   $10 = $7 >>> 20 | 0;
		   wasm2js_scratch_store_f64(+$0);
		   $5 = wasm2js_scratch_load_i32(1) | 0;
		   wasm2js_scratch_load_i32(0) | 0;
		   $5 = ($10 - ($5 >>> 20 & 2047) | 0) < 17;
		   if (Math_abs($2) < 2147483648) {
		    $3 = ~~$2;
		   } else {
		    $3 = -2147483648;
		   }
		   label$14 : {
		    if ($5) {
		     break label$14;
		    }
		    $0 = $2 * 6.077100506303966e-11;
		    $12 = $9 - $0;
		    $11 = $2 * 2.0222662487959506e-21 - ($9 - $12 - $0);
		    $0 = $12 - $11;
		    HEAPF64[$1 >> 3] = $0;
		    wasm2js_scratch_store_f64(+$0);
		    $5 = wasm2js_scratch_load_i32(1) | 0;
		    wasm2js_scratch_load_i32(0) | 0;
		    if (($10 - ($5 >>> 20 & 2047) | 0) < 50) {
		     $9 = $12;
		     break label$14;
		    }
		    $0 = $2 * 2.0222662487111665e-21;
		    $9 = $12 - $0;
		    $11 = $2 * 8.4784276603689e-32 - ($12 - $9 - $0);
		    $0 = $9 - $11;
		    HEAPF64[$1 >> 3] = $0;
		   }
		   HEAPF64[$1 + 8 >> 3] = $9 - $0 - $11;
		   break label$1;
		  }
		  if ($7 >>> 0 >= 2146435072) {
		   $0 = $0 - $0;
		   HEAPF64[$1 >> 3] = $0;
		   HEAPF64[$1 + 8 >> 3] = $0;
		   $3 = 0;
		   break label$1;
		  }
		  $5 = $4 & 1048575;
		  $5 = $5 | 1096810496;
		  wasm2js_scratch_store_i32(0, $8 | 0);
		  wasm2js_scratch_store_i32(1, $5 | 0);
		  $0 = +wasm2js_scratch_load_f64();
		  $3 = 0;
		  $5 = 1;
		  while (1) {
		   $3 = ($6 + 16 | 0) + ($3 << 3) | 0;
		   if (Math_abs($0) < 2147483648) {
		    $10 = ~~$0;
		   } else {
		    $10 = -2147483648;
		   }
		   $2 = +($10 | 0);
		   HEAPF64[$3 >> 3] = $2;
		   $0 = ($0 - $2) * 16777216;
		   $3 = 1;
		   $10 = $5 & 1;
		   $5 = 0;
		   if ($10) {
		    continue;
		   }
		   break;
		  }
		  HEAPF64[$6 + 32 >> 3] = $0;
		  label$20 : {
		   if ($0 != 0) {
		    $3 = 2;
		    break label$20;
		   }
		   $5 = 1;
		   while (1) {
		    $3 = $5;
		    $5 = $3 - 1 | 0;
		    if (HEAPF64[($6 + 16 | 0) + ($3 << 3) >> 3] == 0) {
		     continue;
		    }
		    break;
		   }
		  }
		  $3 = __rem_pio2_large($6 + 16 | 0, $6, ($7 >>> 20 | 0) - 1046 | 0, $3 + 1 | 0, 1);
		  $0 = HEAPF64[$6 >> 3];
		  if (($4 | 0) < -1 ? 1 : ($4 | 0) <= -1) {
		   HEAPF64[$1 >> 3] = -$0;
		   HEAPF64[$1 + 8 >> 3] = -HEAPF64[$6 + 8 >> 3];
		   $3 = 0 - $3 | 0;
		   break label$1;
		  }
		  HEAPF64[$1 >> 3] = $0;
		  HEAPF64[$1 + 8 >> 3] = HEAPF64[$6 + 8 >> 3];
		 }
		 __stack_pointer = $6 + 48 | 0;
		 return $3;
		}
		function opus_custom_decoder_ctl($0, $1, $2) {
		 var $3 = 0, $4 = 0, $5 = 0, $6 = 0, $7 = 0;
		 $3 = __stack_pointer - 16 | 0;
		 __stack_pointer = $3;
		 HEAP32[$3 + 12 >> 2] = $2;
		 $4 = -5;
		 label$1 : {
		  label$2 : {
		   label$3 : {
		    label$4 : {
		     label$5 : {
		      label$6 : {
		       label$7 : {
		        label$8 : {
		         switch ($1 - 4027 | 0) {
		         default:
		          label$12 : {
		           switch ($1 - 10007 | 0) {
		           case 3:
		            $1 = HEAP32[$3 + 12 >> 2];
		            HEAP32[$3 + 12 >> 2] = $1 + 4;
		            $4 = -1;
		            $1 = HEAP32[$1 >> 2];
		            if (($1 | 0) < 0 | HEAP32[HEAP32[$0 >> 2] + 8 >> 2] <= ($1 | 0)) {
		             break label$1;
		            }
		            HEAP32[$0 + 20 >> 2] = $1;
		            break label$2;
		           case 5:
		            $1 = HEAP32[$3 + 12 >> 2];
		            HEAP32[$3 + 12 >> 2] = $1 + 4;
		            $4 = -1;
		            $1 = HEAP32[$1 >> 2];
		            if (($1 | 0) < 1 | HEAP32[HEAP32[$0 >> 2] + 8 >> 2] < ($1 | 0)) {
		             break label$1;
		            }
		            HEAP32[$0 + 24 >> 2] = $1;
		            break label$2;
		           case 1:
		            $1 = HEAP32[$3 + 12 >> 2];
		            HEAP32[$3 + 12 >> 2] = $1 + 4;
		            $4 = -1;
		            $1 = HEAP32[$1 >> 2];
		            if ($1 - 1 >>> 0 > 1) {
		             break label$1;
		            }
		            HEAP32[$0 + 12 >> 2] = $1;
		            break label$2;
		           case 0:
		            break label$12;
		           case 9:
		            break label$6;
		           case 8:
		            break label$7;
		           default:
		            break label$1;
		           }
		          }
		          $1 = HEAP32[$3 + 12 >> 2];
		          HEAP32[$3 + 12 >> 2] = $1 + 4;
		          $1 = HEAP32[$1 >> 2];
		          if (!$1) {
		           $4 = -1;
		           break label$1;
		          }
		          HEAP32[$1 >> 2] = HEAP32[$0 + 44 >> 2];
		          $4 = 0;
		          HEAP32[$0 + 44 >> 2] = 0;
		          break label$1;
		         case 0:
		          $1 = HEAP32[$3 + 12 >> 2];
		          HEAP32[$3 + 12 >> 2] = $1 + 4;
		          $1 = HEAP32[$1 >> 2];
		          if (!$1) {
		           $4 = -1;
		           break label$1;
		          }
		          HEAP32[$1 >> 2] = HEAP32[$0 + 4 >> 2] / HEAP32[$0 + 16 >> 2];
		          break label$2;
		         case 1:
		          $5 = HEAP32[$0 + 4 >> 2];
		          $4 = 0;
		          $2 = HEAP32[$0 >> 2];
		          $1 = HEAP32[$2 + 8 >> 2];
		          $6 = (HEAP32[$2 + 4 >> 2] << 2) + 8288 | 0;
		          $2 = HEAP32[$0 + 8 >> 2];
		          memset($0 + 40 | 0, 0, (Math_imul($6, $2) + ($1 << 5) | 0) + 52 | 0);
		          if (($1 | 0) >= 1) {
		           $5 = ((Math_imul($5 + 2048 | 0, $2) << 2) + $0 | 0) + Math_imul($2, 96) | 0;
		           $2 = $1 << 3;
		           $5 = ($5 + $2 | 0) + 92 | 0;
		           $6 = $2 + $5 | 0;
		           $1 = $1 << 1;
		           $7 = ($1 | 0) > 1 ? $1 : 1;
		           $1 = 0;
		           while (1) {
		            $2 = $1 << 2;
		            HEAP32[$6 + $2 >> 2] = -1042284544;
		            HEAP32[$2 + $5 >> 2] = -1042284544;
		            $1 = $1 + 1 | 0;
		            if (($7 | 0) != ($1 | 0)) {
		             continue;
		            }
		            break;
		           }
		          }
		          HEAP32[$0 + 56 >> 2] = 1;
		          break label$1;
		         case 2:
		         case 3:
		         case 5:
		         case 7:
		         case 8:
		         case 9:
		         case 10:
		         case 11:
		         case 12:
		         case 13:
		         case 14:
		         case 15:
		         case 16:
		         case 17:
		         case 18:
		          break label$1;
		         case 20:
		          break label$3;
		         case 19:
		          break label$4;
		         case 4:
		          break label$5;
		         case 6:
		          break label$8;
		         }
		        }
		        $1 = HEAP32[$3 + 12 >> 2];
		        HEAP32[$3 + 12 >> 2] = $1 + 4;
		        $1 = HEAP32[$1 >> 2];
		        if (!$1) {
		         $4 = -1;
		         break label$1;
		        }
		        HEAP32[$1 >> 2] = HEAP32[$0 + 60 >> 2];
		        break label$2;
		       }
		       $1 = HEAP32[$3 + 12 >> 2];
		       HEAP32[$3 + 12 >> 2] = $1 + 4;
		       $1 = HEAP32[$1 >> 2];
		       if (!$1) {
		        $4 = -1;
		        break label$1;
		       }
		       HEAP32[$1 >> 2] = HEAP32[$0 >> 2];
		       break label$2;
		      }
		      $1 = HEAP32[$3 + 12 >> 2];
		      HEAP32[$3 + 12 >> 2] = $1 + 4;
		      HEAP32[$0 + 28 >> 2] = HEAP32[$1 >> 2];
		      break label$2;
		     }
		     $1 = HEAP32[$3 + 12 >> 2];
		     HEAP32[$3 + 12 >> 2] = $1 + 4;
		     $1 = HEAP32[$1 >> 2];
		     if (!$1) {
		      $4 = -1;
		      break label$1;
		     }
		     HEAP32[$1 >> 2] = HEAP32[$0 + 40 >> 2];
		     break label$2;
		    }
		    $1 = HEAP32[$3 + 12 >> 2];
		    HEAP32[$3 + 12 >> 2] = $1 + 4;
		    $4 = -1;
		    $1 = HEAP32[$1 >> 2];
		    if ($1 >>> 0 > 1) {
		     break label$1;
		    }
		    HEAP32[$0 + 32 >> 2] = $1;
		    break label$2;
		   }
		   $1 = HEAP32[$3 + 12 >> 2];
		   HEAP32[$3 + 12 >> 2] = $1 + 4;
		   $1 = HEAP32[$1 >> 2];
		   if (!$1) {
		    $4 = -1;
		    break label$1;
		   }
		   HEAP32[$1 >> 2] = HEAP32[$0 + 32 >> 2];
		  }
		  $4 = 0;
		 }
		 __stack_pointer = $3 + 16 | 0;
		 return $4;
		}
		function validate_celt_decoder($0) {
		 var $1 = 0, $2 = 0;
		 label$1 : {
		  label$2 : {
		   label$3 : {
		    label$4 : {
		     label$5 : {
		      label$6 : {
		       label$7 : {
		        label$8 : {
		         label$9 : {
		          label$10 : {
		           label$11 : {
		            label$12 : {
		             label$13 : {
		              label$14 : {
		               label$15 : {
		                label$16 : {
		                 label$17 : {
		                  label$18 : {
		                   if (HEAP32[$0 >> 2] == (opus_custom_mode_create(48e3, 960) | 0)) {
		                    if (HEAP32[$0 + 4 >> 2] != 120) {
		                     break label$18;
		                    }
		                    if (HEAP32[$0 + 8 >> 2] - 1 >>> 0 >= 2) {
		                     break label$17;
		                    }
		                    if (HEAP32[$0 + 12 >> 2] - 1 >>> 0 >= 2) {
		                     break label$16;
		                    }
		                    if (HEAP32[$0 + 16 >> 2] <= 0) {
		                     break label$15;
		                    }
		                    $1 = HEAP32[$0 + 20 >> 2];
		                    if (!(!$1 | ($1 | 0) == 17)) {
		                     celt_fatal(34405, 34183, 124);
		                     abort();
		                    }
		                    $2 = HEAP32[$0 + 24 >> 2];
		                    if (($2 | 0) <= ($1 | 0)) {
		                     break label$14;
		                    }
		                    if (($2 | 0) >= 22) {
		                     break label$13;
		                    }
		                    $1 = HEAP32[$0 + 36 >> 2];
		                    if (($1 | 0) <= -1) {
		                     break label$12;
		                    }
		                    if ($1) {
		                     break label$11;
		                    }
		                    $1 = HEAP32[$0 + 48 >> 2];
		                    if (($1 | 0) >= 721) {
		                     break label$10;
		                    }
		                    if ($1 ? ($1 | 0) <= 99 : 0) {
		                     break label$9;
		                    }
		                    $1 = HEAP32[$0 + 60 >> 2];
		                    if (($1 | 0) >= 1024) {
		                     break label$8;
		                    }
		                    if ($1 ? ($1 | 0) <= 14 : 0) {
		                     break label$7;
		                    }
		                    $1 = HEAP32[$0 + 64 >> 2];
		                    if (($1 | 0) >= 1024) {
		                     break label$6;
		                    }
		                    if ($1 ? ($1 | 0) <= 14 : 0) {
		                     break label$5;
		                    }
		                    $1 = HEAP32[$0 + 76 >> 2];
		                    if (($1 | 0) >= 3) {
		                     break label$4;
		                    }
		                    if (($1 | 0) <= -1) {
		                     break label$3;
		                    }
		                    $0 = HEAP32[$0 + 80 >> 2];
		                    if (($0 | 0) >= 3) {
		                     break label$2;
		                    }
		                    if (($0 | 0) <= -1) {
		                     break label$1;
		                    }
		                    return;
		                   }
		                   celt_fatal(34111, 34183, 118);
		                   abort();
		                  }
		                  celt_fatal(34203, 34183, 119);
		                  abort();
		                 }
		                 celt_fatal(34240, 34183, 121);
		                 abort();
		                }
		                celt_fatal(34297, 34183, 122);
		                abort();
		               }
		               celt_fatal(34368, 34183, 123);
		               abort();
		              }
		              celt_fatal(34457, 34183, 125);
		              abort();
		             }
		             celt_fatal(34495, 34183, 126);
		             abort();
		            }
		            celt_fatal(34527, 34183, 128);
		            abort();
		           }
		           celt_fatal(34559, 34183, 129);
		           abort();
		          }
		          celt_fatal(34603, 34183, 131);
		          abort();
		         }
		         celt_fatal(34663, 34183, 132);
		         abort();
		        }
		        celt_fatal(34752, 34183, 133);
		        abort();
		       }
		       celt_fatal(34805, 34183, 134);
		       abort();
		      }
		      celt_fatal(34899, 34183, 135);
		      abort();
		     }
		     celt_fatal(34956, 34183, 136);
		     abort();
		    }
		    celt_fatal(35058, 34183, 137);
		    abort();
		   }
		   celt_fatal(35103, 34183, 138);
		   abort();
		  }
		  celt_fatal(35148, 34183, 139);
		  abort();
		 }
		 celt_fatal(35197, 34183, 140);
		 abort();
		}
		function try_realloc_chunk($0, $1) {
		 var $2 = 0, $3 = 0, $4 = 0, $5 = 0, $6 = 0, $7 = 0, $8 = 0, $9 = 0, $10 = 0;
		 $6 = HEAP32[$0 + 4 >> 2];
		 $3 = $6 & 3;
		 $5 = $6 & -8;
		 $2 = $5 + $0 | 0;
		 label$2 : {
		  if (!$3) {
		   $3 = 0;
		   if ($1 >>> 0 < 256) {
		    break label$2;
		   }
		   if ($1 + 4 >>> 0 <= $5 >>> 0) {
		    $3 = $0;
		    if ($5 - $1 >>> 0 <= HEAP32[9972] << 1 >>> 0) {
		     break label$2;
		    }
		   }
		   return 0;
		  }
		  label$5 : {
		   if ($1 >>> 0 <= $5 >>> 0) {
		    $3 = $5 - $1 | 0;
		    if ($3 >>> 0 < 16) {
		     break label$5;
		    }
		    HEAP32[$0 + 4 >> 2] = $6 & 1 | $1 | 2;
		    $1 = $0 + $1 | 0;
		    HEAP32[$1 + 4 >> 2] = $3 | 3;
		    HEAP32[$2 + 4 >> 2] = HEAP32[$2 + 4 >> 2] | 1;
		    dispose_chunk($1, $3);
		    break label$5;
		   }
		   $3 = 0;
		   if (HEAP32[9858] == ($2 | 0)) {
		    $2 = HEAP32[9855] + $5 | 0;
		    if ($2 >>> 0 <= $1 >>> 0) {
		     break label$2;
		    }
		    HEAP32[$0 + 4 >> 2] = $6 & 1 | $1 | 2;
		    $3 = $0 + $1 | 0;
		    $1 = $2 - $1 | 0;
		    HEAP32[$3 + 4 >> 2] = $1 | 1;
		    HEAP32[9855] = $1;
		    HEAP32[9858] = $3;
		    break label$5;
		   }
		   if (HEAP32[9857] == ($2 | 0)) {
		    $2 = HEAP32[9854] + $5 | 0;
		    if ($2 >>> 0 < $1 >>> 0) {
		     break label$2;
		    }
		    $3 = $2 - $1 | 0;
		    label$9 : {
		     if ($3 >>> 0 >= 16) {
		      HEAP32[$0 + 4 >> 2] = $6 & 1 | $1 | 2;
		      $1 = $0 + $1 | 0;
		      HEAP32[$1 + 4 >> 2] = $3 | 1;
		      $2 = $0 + $2 | 0;
		      HEAP32[$2 >> 2] = $3;
		      HEAP32[$2 + 4 >> 2] = HEAP32[$2 + 4 >> 2] & -2;
		      break label$9;
		     }
		     HEAP32[$0 + 4 >> 2] = $6 & 1 | $2 | 2;
		     $1 = $0 + $2 | 0;
		     HEAP32[$1 + 4 >> 2] = HEAP32[$1 + 4 >> 2] | 1;
		     $3 = 0;
		     $1 = 0;
		    }
		    HEAP32[9857] = $1;
		    HEAP32[9854] = $3;
		    break label$5;
		   }
		   $4 = HEAP32[$2 + 4 >> 2];
		   if ($4 & 2) {
		    break label$2;
		   }
		   $7 = ($4 & -8) + $5 | 0;
		   if ($7 >>> 0 < $1 >>> 0) {
		    break label$2;
		   }
		   $9 = $7 - $1 | 0;
		   label$11 : {
		    if ($4 >>> 0 <= 255) {
		     $3 = HEAP32[$2 + 12 >> 2];
		     $2 = HEAP32[$2 + 8 >> 2];
		     $4 = $4 >>> 3 | 0;
		     $5 = ($4 << 3) + 39448 | 0;
		     if (($2 | 0) == ($3 | 0)) {
		      HEAP32[9852] = HEAP32[9852] & __wasm_rotl_i32(-2, $4);
		      break label$11;
		     }
		     HEAP32[$2 + 12 >> 2] = $3;
		     HEAP32[$3 + 8 >> 2] = $2;
		     break label$11;
		    }
		    $8 = HEAP32[$2 + 24 >> 2];
		    $4 = HEAP32[$2 + 12 >> 2];
		    label$14 : {
		     if (($4 | 0) != ($2 | 0)) {
		      $3 = HEAP32[$2 + 8 >> 2];
		      HEAP32[$3 + 12 >> 2] = $4;
		      HEAP32[$4 + 8 >> 2] = $3;
		      break label$14;
		     }
		     label$17 : {
		      $3 = $2 + 20 | 0;
		      $5 = HEAP32[$3 >> 2];
		      if ($5) {
		       break label$17;
		      }
		      $3 = $2 + 16 | 0;
		      $5 = HEAP32[$3 >> 2];
		      if ($5) {
		       break label$17;
		      }
		      $4 = 0;
		      break label$14;
		     }
		     while (1) {
		      $10 = $3;
		      $4 = $5;
		      $3 = $4 + 20 | 0;
		      $5 = HEAP32[$3 >> 2];
		      if ($5) {
		       continue;
		      }
		      $3 = $4 + 16 | 0;
		      $5 = HEAP32[$4 + 16 >> 2];
		      if ($5) {
		       continue;
		      }
		      break;
		     }
		     HEAP32[$10 >> 2] = 0;
		    }
		    if (!$8) {
		     break label$11;
		    }
		    $5 = HEAP32[$2 + 28 >> 2];
		    $3 = ($5 << 2) + 39712 | 0;
		    label$19 : {
		     if (HEAP32[$3 >> 2] == ($2 | 0)) {
		      HEAP32[$3 >> 2] = $4;
		      if ($4) {
		       break label$19;
		      }
		      HEAP32[9853] = HEAP32[9853] & __wasm_rotl_i32(-2, $5);
		      break label$11;
		     }
		     HEAP32[(HEAP32[$8 + 16 >> 2] == ($2 | 0) ? 16 : 20) + $8 >> 2] = $4;
		     if (!$4) {
		      break label$11;
		     }
		    }
		    HEAP32[$4 + 24 >> 2] = $8;
		    $3 = HEAP32[$2 + 16 >> 2];
		    if ($3) {
		     HEAP32[$4 + 16 >> 2] = $3;
		     HEAP32[$3 + 24 >> 2] = $4;
		    }
		    $2 = HEAP32[$2 + 20 >> 2];
		    if (!$2) {
		     break label$11;
		    }
		    HEAP32[$4 + 20 >> 2] = $2;
		    HEAP32[$2 + 24 >> 2] = $4;
		   }
		   if ($9 >>> 0 <= 15) {
		    HEAP32[$0 + 4 >> 2] = $6 & 1 | $7 | 2;
		    $1 = $0 + $7 | 0;
		    HEAP32[$1 + 4 >> 2] = HEAP32[$1 + 4 >> 2] | 1;
		    break label$5;
		   }
		   HEAP32[$0 + 4 >> 2] = $6 & 1 | $1 | 2;
		   $1 = $0 + $1 | 0;
		   HEAP32[$1 + 4 >> 2] = $9 | 3;
		   $2 = $0 + $7 | 0;
		   HEAP32[$2 + 4 >> 2] = HEAP32[$2 + 4 >> 2] | 1;
		   dispose_chunk($1, $9);
		  }
		  $3 = $0;
		 }
		 return $3;
		}
		function silk_shell_decoder($0, $1, $2) {
		 var $3 = 0, $4 = 0, $5 = 0, $6 = 0, $7 = 0, $8 = 0;
		 $7 = $0;
		 label$1 : {
		  label$2 : {
		   if (($2 | 0) < 1) {
		    break label$2;
		   }
		   $3 = ec_dec_icdf($1, HEAPU8[$2 + 8416 | 0] + 8256 | 0, 8);
		   $4 = $2 - $3 | 0;
		   $2 = $3 << 16;
		   if (($2 | 0) < 1) {
		    $3 = 0;
		    break label$2;
		   }
		   $2 = $2 >> 16;
		   $6 = ec_dec_icdf($1, HEAPU8[$2 + 8416 | 0] + 8096 | 0, 8);
		   $3 = $2 - $6 | 0;
		   $2 = $6 << 16;
		   if (($2 | 0) <= 0) {
		    break label$2;
		   }
		   $2 = $2 >> 16;
		   $6 = ec_dec_icdf($1, HEAPU8[$2 + 8416 | 0] + 7936 | 0, 8);
		   $5 = $2 - $6 | 0;
		   $2 = $6 << 16;
		   if (($2 | 0) < 1) {
		    break label$2;
		   }
		   $2 = $2 >> 16;
		   $6 = ec_dec_icdf($1, HEAPU8[$2 + 8416 | 0] + 7776 | 0, 8);
		   HEAP16[$0 >> 1] = $6;
		   $2 = $2 - $6 | 0;
		   break label$1;
		  }
		  HEAP16[$0 >> 1] = 0;
		  $2 = 0;
		 }
		 HEAP16[$7 + 2 >> 1] = $2;
		 $7 = $0;
		 $2 = $5 << 16;
		 label$4 : {
		  if (($2 | 0) >= 1) {
		   $2 = $2 >> 16;
		   $5 = ec_dec_icdf($1, HEAPU8[$2 + 8416 | 0] + 7776 | 0, 8);
		   HEAP16[$0 + 4 >> 1] = $5;
		   $2 = $2 - $5 | 0;
		   break label$4;
		  }
		  HEAP16[$0 + 4 >> 1] = 0;
		  $2 = 0;
		 }
		 HEAP16[$7 + 6 >> 1] = $2;
		 $2 = 0;
		 $7 = $0;
		 label$6 : {
		  label$7 : {
		   $3 = $3 << 16;
		   if (($3 | 0) <= 0) {
		    $5 = $0 + 8 | 0;
		    break label$7;
		   }
		   $8 = $0;
		   $5 = $0 + 8 | 0;
		   $2 = $3 >> 16;
		   $3 = ec_dec_icdf($1, HEAPU8[$2 + 8416 | 0] + 7936 | 0, 8);
		   $2 = $2 - $3 | 0;
		   $3 = $3 << 16;
		   if (($3 | 0) < 1) {
		    break label$7;
		   }
		   $3 = $3 >> 16;
		   $6 = ec_dec_icdf($1, HEAPU8[$3 + 8416 | 0] + 7776 | 0, 8);
		   HEAP16[$8 + 8 >> 1] = $6;
		   $3 = $3 - $6 | 0;
		   break label$6;
		  }
		  HEAP16[$5 >> 1] = 0;
		  $3 = 0;
		 }
		 HEAP16[$7 + 10 >> 1] = $3;
		 $7 = $0;
		 $2 = $2 << 16;
		 label$9 : {
		  if (($2 | 0) >= 1) {
		   $2 = $2 >> 16;
		   $3 = ec_dec_icdf($1, HEAPU8[$2 + 8416 | 0] + 7776 | 0, 8);
		   HEAP16[$0 + 12 >> 1] = $3;
		   $2 = $2 - $3 | 0;
		   break label$9;
		  }
		  HEAP16[$0 + 12 >> 1] = 0;
		  $2 = 0;
		 }
		 HEAP16[$7 + 14 >> 1] = $2;
		 $3 = 0;
		 $2 = 0;
		 $7 = $0;
		 label$11 : {
		  label$12 : {
		   label$13 : {
		    $4 = $4 << 16;
		    if (($4 | 0) >= 1) {
		     $2 = $4 >> 16;
		     $4 = ec_dec_icdf($1, HEAPU8[$2 + 8416 | 0] + 8096 | 0, 8);
		     $2 = $2 - $4 | 0;
		     $4 = $4 << 16;
		     if (($4 | 0) > 0) {
		      break label$13;
		     }
		    }
		    $5 = $0 + 16 | 0;
		    break label$12;
		   }
		   $8 = $0;
		   $5 = $0 + 16 | 0;
		   $3 = $4 >> 16;
		   $4 = ec_dec_icdf($1, HEAPU8[$3 + 8416 | 0] + 7936 | 0, 8);
		   $3 = $3 - $4 | 0;
		   $4 = $4 << 16;
		   if (($4 | 0) < 1) {
		    break label$12;
		   }
		   $4 = $4 >> 16;
		   $6 = ec_dec_icdf($1, HEAPU8[$4 + 8416 | 0] + 7776 | 0, 8);
		   HEAP16[$8 + 16 >> 1] = $6;
		   $4 = $4 - $6 | 0;
		   break label$11;
		  }
		  HEAP16[$5 >> 1] = 0;
		  $4 = 0;
		 }
		 HEAP16[$7 + 18 >> 1] = $4;
		 $7 = $0;
		 $3 = $3 << 16;
		 label$15 : {
		  if (($3 | 0) >= 1) {
		   $3 = $3 >> 16;
		   $4 = ec_dec_icdf($1, HEAPU8[$3 + 8416 | 0] + 7776 | 0, 8);
		   HEAP16[$0 + 20 >> 1] = $4;
		   $3 = $3 - $4 | 0;
		   break label$15;
		  }
		  HEAP16[$0 + 20 >> 1] = 0;
		  $3 = 0;
		 }
		 HEAP16[$7 + 22 >> 1] = $3;
		 $3 = 0;
		 $7 = $0;
		 label$17 : {
		  label$18 : {
		   $2 = $2 << 16;
		   if (($2 | 0) <= 0) {
		    $4 = $0 + 24 | 0;
		    break label$18;
		   }
		   $8 = $0;
		   $4 = $0 + 24 | 0;
		   $2 = $2 >> 16;
		   $5 = ec_dec_icdf($1, HEAPU8[$2 + 8416 | 0] + 7936 | 0, 8);
		   $3 = $2 - $5 | 0;
		   $2 = $5 << 16;
		   if (($2 | 0) < 1) {
		    break label$18;
		   }
		   $2 = $2 >> 16;
		   $5 = ec_dec_icdf($1, HEAPU8[$2 + 8416 | 0] + 7776 | 0, 8);
		   HEAP16[$8 + 24 >> 1] = $5;
		   $2 = $2 - $5 | 0;
		   break label$17;
		  }
		  HEAP16[$4 >> 1] = 0;
		  $2 = 0;
		 }
		 HEAP16[$7 + 26 >> 1] = $2;
		 $2 = $3 << 16;
		 if (($2 | 0) >= 1) {
		  $2 = $2 >> 16;
		  $1 = ec_dec_icdf($1, HEAPU8[$2 + 8416 | 0] + 7776 | 0, 8);
		  HEAP16[$0 + 28 >> 1] = $1;
		  HEAP16[$0 + 30 >> 1] = $2 - $1;
		  return;
		 }
		 HEAP16[$0 + 28 >> 1] = 0;
		 HEAP16[$0 + 30 >> 1] = 0;
		}
		function pitch_downsample($0, $1, $2, $3, $4) {
		 var $5 = Math_fround(0), $6 = 0, $7 = 0, $8 = 0, $9 = 0, $10 = Math_fround(0), $11 = Math_fround(0), $12 = Math_fround(0), $13 = 0, $14 = 0, $15 = 0, $16 = Math_fround(0), $17 = Math_fround(0), $18 = Math_fround(0), $19 = Math_fround(0), $20 = Math_fround(0), $21 = Math_fround(0), $22 = Math_fround(0);
		 $6 = __stack_pointer - 48 | 0;
		 __stack_pointer = $6;
		 $13 = $2 >> 1;
		 $8 = HEAP32[$0 >> 2];
		 {
		  $15 = ($13 | 0) > 2 ? $13 : 2;
		  $7 = 1;
		  while (1) {
		   $9 = $7 << 3;
		   $14 = $9 + $8 | 0;
		   HEAPF32[($7 << 2) + $1 >> 2] = Math_fround(HEAPF32[$14 >> 2] + Math_fround(Math_fround(HEAPF32[$14 - 4 >> 2] + HEAPF32[($9 | 4) + $8 >> 2]) * Math_fround(.5))) * Math_fround(.5);
		   $7 = $7 + 1 | 0;
		   if (($15 | 0) != ($7 | 0)) {
		    continue;
		   }
		   break;
		  }
		 }
		 $5 = Math_fround(Math_fround(Math_fround(HEAPF32[$8 + 4 >> 2] * Math_fround(.5)) + HEAPF32[$8 >> 2]) * Math_fround(.5));
		 HEAPF32[$1 >> 2] = $5;
		 if (($3 | 0) == 2) {
		  $8 = HEAP32[$0 + 4 >> 2];
		  {
		   $15 = ($13 | 0) > 2 ? $13 : 2;
		   $7 = 1;
		   while (1) {
		    $9 = ($7 << 2) + $1 | 0;
		    $0 = $9;
		    $5 = HEAPF32[$9 >> 2];
		    $9 = $7 << 3;
		    $14 = $9 + $8 | 0;
		    HEAPF32[$0 >> 2] = $5 + Math_fround(Math_fround(HEAPF32[$14 >> 2] + Math_fround(Math_fround(HEAPF32[$14 - 4 >> 2] + HEAPF32[($9 | 4) + $8 >> 2]) * Math_fround(.5))) * Math_fround(.5));
		    $7 = $7 + 1 | 0;
		    if (($15 | 0) != ($7 | 0)) {
		     continue;
		    }
		    break;
		   }
		   $5 = HEAPF32[$1 >> 2];
		  }
		  HEAPF32[$1 >> 2] = $5 + Math_fround(Math_fround(Math_fround(HEAPF32[$8 + 4 >> 2] * Math_fround(.5)) + HEAPF32[$8 >> 2]) * Math_fround(.5));
		 }
		 $7 = 0;
		 _celt_autocorr($1, $6 + 16 | 0, 0, 0, 4, $13, $4);
		 HEAPF32[$6 + 16 >> 2] = HEAPF32[$6 + 16 >> 2] * Math_fround(1.000100016593933);
		 $5 = HEAPF32[$6 + 20 >> 2];
		 HEAPF32[$6 + 20 >> 2] = $5 - Math_fround(Math_fround($5 * Math_fround(.00800000037997961)) * Math_fround(.00800000037997961));
		 $5 = HEAPF32[$6 + 24 >> 2];
		 HEAPF32[$6 + 24 >> 2] = $5 - Math_fround(Math_fround($5 * Math_fround(.01600000075995922)) * Math_fround(.01600000075995922));
		 $5 = HEAPF32[$6 + 28 >> 2];
		 HEAPF32[$6 + 28 >> 2] = $5 - Math_fround(Math_fround($5 * Math_fround(.024000000208616257)) * Math_fround(.024000000208616257));
		 $5 = HEAPF32[$6 + 32 >> 2];
		 HEAPF32[$6 + 32 >> 2] = $5 - Math_fround(Math_fround($5 * Math_fround(.03200000151991844)) * Math_fround(.03200000151991844));
		 _celt_lpc($6, $6 + 16 | 0, 4);
		 $5 = Math_fround(HEAPF32[$6 + 8 >> 2] * Math_fround(.7289999127388));
		 HEAPF32[$6 + 8 >> 2] = $5;
		 $10 = Math_fround(HEAPF32[$6 + 12 >> 2] * Math_fround(.6560999155044556));
		 HEAPF32[$6 + 12 >> 2] = $10;
		 $11 = Math_fround(HEAPF32[$6 + 4 >> 2] * Math_fround(.809999942779541));
		 HEAPF32[$6 + 4 >> 2] = $11;
		 $12 = Math_fround(HEAPF32[$6 >> 2] * Math_fround(.8999999761581421));
		 HEAPF32[$6 >> 2] = $12;
		 {
		  $17 = Math_fround($10 + Math_fround($5 * Math_fround(.800000011920929)));
		  $18 = Math_fround($5 + Math_fround($11 * Math_fround(.800000011920929)));
		  $19 = Math_fround($11 + Math_fround($12 * Math_fround(.800000011920929)));
		  $20 = Math_fround($10 * Math_fround(.800000011920929));
		  $21 = Math_fround($12 + Math_fround(.800000011920929));
		  $5 = Math_fround(0);
		  $10 = Math_fround(0);
		  $11 = Math_fround(0);
		  $12 = Math_fround(0);
		  while (1) {
		   $8 = ($7 << 2) + $1 | 0;
		   $16 = HEAPF32[$8 >> 2];
		   HEAPF32[$8 >> 2] = Math_fround($20 * $22) + Math_fround(Math_fround($17 * $5) + Math_fround(Math_fround($18 * $10) + Math_fround(Math_fround($19 * $11) + Math_fround(Math_fround($21 * $12) + $16))));
		   $22 = $5;
		   $5 = $10;
		   $10 = $11;
		   $11 = $12;
		   $12 = $16;
		   $7 = $7 + 1 | 0;
		   if (($13 | 0) != ($7 | 0)) {
		    continue;
		   }
		   break;
		  }
		 }
		 __stack_pointer = $6 + 48 | 0;
		}
		function silk_NLSF_stabilize($0, $1, $2) {
		 var $3 = 0, $4 = 0, $5 = 0, $6 = 0, $7 = 0, $8 = 0, $9 = 0, $10 = 0, $11 = 0, $12 = 0, $13 = 0, $14 = 0, $15 = 0, $16 = 0;
		 $12 = ($2 << 1) + $1 | 0;
		 $13 = $2 - 1 | 0;
		 $11 = ($13 << 1) + $0 | 0;
		 $16 = ($2 | 0) < 2;
		 label$1 : {
		  while (1) {
		   $5 = HEAP16[$0 >> 1];
		   $9 = HEAP16[$1 >> 1];
		   $3 = $5 - $9 | 0;
		   $4 = 1;
		   $6 = 0;
		   if (!$16) {
		    while (1) {
		     $7 = $5 << 16;
		     $10 = $4 << 1;
		     $5 = HEAP16[$10 + $0 >> 1];
		     $7 = ($5 - ($7 >> 16) | 0) - HEAP16[$1 + $10 >> 1] | 0;
		     $8 = $7;
		     $7 = ($3 | 0) > ($7 | 0);
		     $3 = $7 ? $8 : $3;
		     $6 = $7 ? $4 : $6;
		     $4 = $4 + 1 | 0;
		     if (($4 | 0) != ($2 | 0)) {
		      continue;
		     }
		     break;
		    }
		   }
		   $5 = HEAP16[$12 >> 1];
		   $4 = 32768 - ($5 + HEAP16[$11 >> 1] | 0) | 0;
		   $8 = $4;
		   $4 = ($3 | 0) > ($4 | 0);
		   if ((($4 ? $8 : $3) | 0) > -1) {
		    break label$1;
		   }
		   $3 = $4 ? $2 : $6;
		   label$5 : {
		    if (!$3) {
		     HEAP16[$0 >> 1] = $9;
		     break label$5;
		    }
		    label$7 : {
		     label$8 : {
		      if (($2 | 0) != ($3 | 0)) {
		       if (($3 | 0) >= 1) {
		        break label$8;
		       }
		       $9 = 0;
		       break label$7;
		      }
		      HEAP16[$11 >> 1] = -32768 - $5;
		      break label$5;
		     }
		     $4 = 1;
		     if (($3 | 0) == 1) {
		      break label$7;
		     }
		     while (1) {
		      $9 = HEAP16[($4 << 1) + $1 >> 1] + $9 | 0;
		      $4 = $4 + 1 | 0;
		      if (($4 | 0) != ($3 | 0)) {
		       continue;
		      }
		      break;
		     }
		    }
		    $8 = $3 << 1;
		    $14 = $8 + $1 | 0;
		    $10 = HEAP16[$14 >> 1] >> 1;
		    $7 = $10 + $9 | 0;
		    $6 = 32768;
		    label$11 : {
		     if (($2 | 0) <= ($3 | 0)) {
		      break label$11;
		     }
		     $6 = 32768 - $5 | 0;
		     $4 = $13;
		     if (($4 | 0) <= ($3 | 0)) {
		      break label$11;
		     }
		     while (1) {
		      $6 = $6 - HEAP16[($4 << 1) + $1 >> 1] | 0;
		      $4 = $4 - 1 | 0;
		      if (($4 | 0) > ($3 | 0)) {
		       continue;
		      }
		      break;
		     }
		    }
		    $4 = $0 + $8 | 0;
		    $9 = $4 - 2 | 0;
		    $3 = HEAP16[$4 >> 1] + HEAP16[$9 >> 1] | 0;
		    $3 = ($3 >> 1) + ($3 & 1) | 0;
		    $6 = $6 - $10 | 0;
		    label$13 : {
		     if (($7 | 0) > ($6 | 0)) {
		      $5 = $7;
		      $8 = $5;
		      if (($3 | 0) > ($5 | 0)) {
		       break label$13;
		      }
		      $8 = ($3 | 0) < ($6 | 0) ? $6 : $3;
		      break label$13;
		     }
		     $5 = $6;
		     $8 = $5;
		     if (($3 | 0) > ($5 | 0)) {
		      break label$13;
		     }
		     $8 = ($3 | 0) < ($7 | 0) ? $7 : $3;
		    }
		    $5 = $8;
		    $3 = $5 - $10 | 0;
		    HEAP16[$9 >> 1] = $3;
		    HEAP16[$4 >> 1] = HEAPU16[$14 >> 1] + $3;
		   }
		   $15 = $15 + 1 | 0;
		   if (($15 | 0) != 20) {
		    continue;
		   }
		   break;
		  }
		  silk_insertion_sort_increasing_all_values_int16($0, $2);
		  $4 = HEAP16[$0 >> 1];
		  $3 = HEAP16[$1 >> 1];
		  $3 = ($3 | 0) < ($4 | 0) ? $4 : $3;
		  HEAP16[$0 >> 1] = $3;
		  $7 = ($2 | 0) < 2;
		  if (!$7) {
		   $4 = 1;
		   while (1) {
		    $6 = $4 << 1;
		    $5 = $6 + $0 | 0;
		    $8 = $5;
		    $5 = HEAP16[$5 >> 1];
		    $3 = HEAP16[$1 + $6 >> 1] + ($3 << 16 >> 16) | 0;
		    $3 = ($3 | 0) < 32767 ? $3 : 32767;
		    $3 = ($3 | 0) > -32768 ? $3 : -32768;
		    $3 = ($3 | 0) < ($5 | 0) ? $5 : $3;
		    HEAP16[$8 >> 1] = $3;
		    $4 = $4 + 1 | 0;
		    if (($4 | 0) != ($2 | 0)) {
		     continue;
		    }
		    break;
		   }
		  }
		  $4 = HEAP16[$11 >> 1];
		  $3 = 32768 - HEAP16[$12 >> 1] | 0;
		  $3 = ($3 | 0) > ($4 | 0) ? $4 : $3;
		  HEAP16[$11 >> 1] = $3;
		  if ($7) {
		   break label$1;
		  }
		  $4 = $2 - 2 | 0;
		  while (1) {
		   $6 = $4 << 1;
		   $5 = $6 + $0 | 0;
		   $2 = $5;
		   $5 = HEAP16[$5 >> 1];
		   $3 = ($3 << 16 >> 16) - HEAP16[($1 + $6 | 0) + 2 >> 1] | 0;
		   $3 = ($3 | 0) > ($5 | 0) ? $5 : $3;
		   HEAP16[$2 >> 1] = $3;
		   $6 = ($4 | 0) > 0;
		   $4 = $4 - 1 | 0;
		   if ($6) {
		    continue;
		   }
		   break;
		  }
		 }
		}
		function speex_resampler_process_float($0, $1, $2, $3, $4, $5) {
		 var $6 = 0, $7 = 0, $8 = 0, $9 = 0, $10 = 0, $11 = 0, $12 = 0, $13 = 0, $14 = 0, $15 = 0, $16 = 0, $17 = 0, $18 = 0, $19 = 0, $20 = 0;
		 $8 = __stack_pointer - 16 | 0;
		 __stack_pointer = $8;
		 $16 = HEAP32[$0 + 24 >> 2];
		 $17 = $16 - 1 | 0;
		 $13 = HEAP32[$0 + 72 >> 2];
		 $18 = HEAP32[$0 + 28 >> 2];
		 $19 = Math_imul($18, $1);
		 $14 = $13 + ($19 << 2) | 0;
		 $20 = HEAP32[$0 + 88 >> 2];
		 $11 = HEAP32[$5 >> 2];
		 $12 = HEAP32[$3 >> 2];
		 $6 = $1 << 2;
		 $7 = $6 + HEAP32[$0 + 68 >> 2] | 0;
		 label$1 : {
		  if (HEAP32[$7 >> 2]) {
		   HEAP32[$8 + 12 >> 2] = $11;
		   HEAP32[$8 + 8 >> 2] = HEAP32[$7 >> 2];
		   HEAP32[$0 + 56 >> 2] = 1;
		   $9 = FUNCTION_TABLE[HEAP32[$0 + 84 >> 2]]($0, $1, $14, $8 + 8 | 0, $4, $8 + 12 | 0) | 0;
		   $7 = HEAP32[$8 + 8 >> 2];
		   $6 = HEAP32[$0 + 60 >> 2] + $6 | 0;
		   $10 = HEAP32[$6 >> 2];
		   if (($7 | 0) > ($10 | 0)) {
		    HEAP32[$8 + 8 >> 2] = $10;
		    $7 = $10;
		   }
		   HEAP32[$8 + 12 >> 2] = $9;
		   HEAP32[$6 >> 2] = HEAP32[$6 >> 2] - $7;
		   $7 = HEAP32[$8 + 8 >> 2];
		   if (($16 | 0) >= 2) {
		    $6 = 0;
		    while (1) {
		     HEAP32[($6 << 2) + $14 >> 2] = HEAP32[($6 + $7 << 2) + $14 >> 2];
		     $6 = $6 + 1 | 0;
		     if (($17 | 0) != ($6 | 0)) {
		      continue;
		     }
		     break;
		    }
		   }
		   $15 = HEAP32[$0 + 68 >> 2] + ($1 << 2) | 0;
		   $9 = HEAP32[$15 >> 2] - $7 | 0;
		   HEAP32[$15 >> 2] = $9;
		   if ($9) {
		    $6 = 0;
		    $10 = HEAP32[$8 + 8 >> 2];
		    while (1) {
		     $7 = $6 + $17 | 0;
		     HEAP32[($7 << 2) + $14 >> 2] = HEAP32[($7 + $10 << 2) + $14 >> 2];
		     $6 = $6 + 1 | 0;
		     if (($9 | 0) != ($6 | 0)) {
		      continue;
		     }
		     break;
		    }
		   }
		   $6 = HEAP32[$8 + 12 >> 2];
		   $11 = $11 - $6 | 0;
		   if (HEAP32[$15 >> 2]) {
		    break label$1;
		   }
		   $4 = (Math_imul(HEAP32[$0 + 92 >> 2], $6) << 2) + $4 | 0;
		  }
		  if (!$11 | !$12) {
		   break label$1;
		  }
		  $15 = $18 - $17 | 0;
		  $18 = (($16 + $19 << 2) + $13 | 0) - 4 | 0;
		  while (1) {
		   $7 = $12 >>> 0 > $15 >>> 0 ? $15 : $12;
		   HEAP32[$8 + 12 >> 2] = $7;
		   HEAP32[$8 + 8 >> 2] = $11;
		   label$9 : {
		    if ($2) {
		     $6 = 0;
		     if (!$7) {
		      break label$9;
		     }
		     while (1) {
		      HEAP32[($6 + $17 << 2) + $14 >> 2] = HEAP32[(Math_imul($6, $20) << 2) + $2 >> 2];
		      $6 = $6 + 1 | 0;
		      if (($7 | 0) != ($6 | 0)) {
		       continue;
		      }
		      break;
		     }
		     break label$9;
		    }
		    if (!$7) {
		     break label$9;
		    }
		    memset($18, 0, $7 << 2);
		   }
		   HEAP32[$0 + 56 >> 2] = 1;
		   $10 = HEAP32[$0 + 24 >> 2];
		   $7 = HEAP32[$0 + 72 >> 2] + (Math_imul(HEAP32[$0 + 28 >> 2], $1) << 2) | 0;
		   $16 = FUNCTION_TABLE[HEAP32[$0 + 84 >> 2]]($0, $1, $7, $8 + 12 | 0, $4, $8 + 8 | 0) | 0;
		   $9 = HEAP32[$8 + 12 >> 2];
		   $6 = HEAP32[$0 + 60 >> 2] + ($1 << 2) | 0;
		   $13 = HEAP32[$6 >> 2];
		   if (($9 | 0) > ($13 | 0)) {
		    HEAP32[$8 + 12 >> 2] = $13;
		    $9 = $13;
		   }
		   HEAP32[$8 + 8 >> 2] = $16;
		   HEAP32[$6 >> 2] = HEAP32[$6 >> 2] - $9;
		   $9 = HEAP32[$8 + 12 >> 2];
		   $6 = $9;
		   if (($10 | 0) >= 2) {
		    $10 = $10 - 1 | 0;
		    $6 = 0;
		    while (1) {
		     HEAP32[($6 << 2) + $7 >> 2] = HEAP32[($6 + $9 << 2) + $7 >> 2];
		     $6 = $6 + 1 | 0;
		     if (($10 | 0) != ($6 | 0)) {
		      continue;
		     }
		     break;
		    }
		    $6 = HEAP32[$8 + 12 >> 2];
		   }
		   $12 = $12 - $9 | 0;
		   $7 = HEAP32[$8 + 8 >> 2];
		   $11 = $11 - $7 | 0;
		   if (!$11) {
		    break label$1;
		   }
		   $2 = $2 ? (Math_imul($6, $20) << 2) + $2 | 0 : 0;
		   $4 = (Math_imul(HEAP32[$0 + 92 >> 2], $7) << 2) + $4 | 0;
		   if ($12) {
		    continue;
		   }
		   break;
		  }
		 }
		 HEAP32[$3 >> 2] = HEAP32[$3 >> 2] - $12;
		 HEAP32[$5 >> 2] = HEAP32[$5 >> 2] - $11;
		 __stack_pointer = $8 + 16 | 0;
		 $6 = HEAP32[$0 + 84 >> 2];
		 return ($6 | 0) == 8;
		}
		function _ZN17compiler_builtins3int4udiv10divmod_u6417h6026910b5ed08e40E($0, $1, $2, $3) {
		 var $4 = 0, $5 = 0, $6 = 0, $7 = 0, $8 = 0, $9 = 0, $10 = 0, $11 = 0, $12 = 0, $13 = 0, $14 = 0, $15 = 0, $16 = 0;
		 label$1 : {
		  label$2 : {
		   label$3 : {
		    label$4 : {
		     label$5 : {
		      label$6 : {
		       label$7 : {
		        label$8 : {
		         label$9 : {
		          label$11 : {
		           $5 = $1;
		           if ($5) {
		            $7 = $2;
		            if (!$7) {
		             break label$11;
		            }
		            $4 = $3;
		            if (!$4) {
		             break label$9;
		            }
		            $5 = Math_clz32($4) - Math_clz32($5) | 0;
		            if ($5 >>> 0 <= 31) {
		             break label$8;
		            }
		            break label$2;
		           }
		           $4 = $3;
		           if (($4 | 0) == 1 | $4 >>> 0 > 1) {
		            break label$2;
		           }
		           $5 = $0;
		           $7 = $2;
		           $5 = ($5 >>> 0) / ($7 >>> 0) | 0;
		           i64toi32_i32$HIGH_BITS = 0;
		           return $5;
		          }
		          $7 = $3;
		          if (!$0) {
		           break label$7;
		          }
		          if (!$7) {
		           break label$6;
		          }
		          $4 = $7 - 1 | 0;
		          if ($4 & $7) {
		           break label$6;
		          }
		          $9 = $5 >>> __wasm_ctz_i32($7) | 0;
		          i64toi32_i32$HIGH_BITS = 0;
		          return $9;
		         }
		         if (!($7 - 1 & $7)) {
		          break label$5;
		         }
		         $5 = (Math_clz32($7) + 33 | 0) - Math_clz32($5) | 0;
		         $7 = 0 - $5 | 0;
		         break label$3;
		        }
		        $7 = 63 - $5 | 0;
		        $5 = $5 + 1 | 0;
		        break label$3;
		       }
		       $4 = ($5 >>> 0) / ($7 >>> 0) | 0;
		       i64toi32_i32$HIGH_BITS = 0;
		       return $4;
		      }
		      $5 = Math_clz32($7) - Math_clz32($5) | 0;
		      if ($5 >>> 0 < 31) {
		       break label$4;
		      }
		      break label$2;
		     }
		     if (($7 | 0) == 1) {
		      break label$1;
		     }
		     $4 = $1;
		     $9 = $0;
		     $10 = 0;
		     $8 = __wasm_ctz_i32($7);
		     $6 = $8 & 31;
		     if (($8 & 63) >>> 0 >= 32) {
		      $9 = $4 >>> $6 | 0;
		     } else {
		      $10 = $4 >>> $6 | 0;
		      $9 = ((1 << $6) - 1 & $4) << 32 - $6 | $9 >>> $6;
		     }
		     i64toi32_i32$HIGH_BITS = $10;
		     return $9;
		    }
		    $7 = 63 - $5 | 0;
		    $5 = $5 + 1 | 0;
		   }
		   $9 = $1;
		   $4 = $0;
		   $10 = 0;
		   $8 = $5 & 63;
		   $6 = $8 & 31;
		   if (($8 & 63) >>> 0 >= 32) {
		    $12 = $9 >>> $6 | 0;
		   } else {
		    $10 = $9 >>> $6 | 0;
		    $12 = ((1 << $6) - 1 & $9) << 32 - $6 | $4 >>> $6;
		   }
		   $13 = $10;
		   $10 = $1;
		   $9 = $0;
		   $8 = $7 & 63;
		   $6 = $8 & 31;
		   if (($8 & 63) >>> 0 >= 32) {
		    $4 = $9 << $6;
		    $0 = 0;
		   } else {
		    $4 = (1 << $6) - 1 & $9 >>> 32 - $6 | $10 << $6;
		    $0 = $9 << $6;
		   }
		   $1 = $4;
		   if ($5) {
		    $4 = $3 - 1 | 0;
		    $6 = $2 - 1 | 0;
		    $4 = ($6 | 0) != -1 ? $4 + 1 | 0 : $4;
		    $7 = $6;
		    $9 = $4;
		    while (1) {
		     $4 = $12;
		     $8 = $4 << 1;
		     $4 = $13 << 1 | $4 >>> 31;
		     $12 = $8 | $1 >>> 31;
		     $11 = $12;
		     $10 = $4;
		     $4 = $7;
		     $8 = $11;
		     $6 = $9 - (($4 >>> 0 < $8 >>> 0) + $10 | 0) | 0;
		     $13 = $3 & $6 >> 31;
		     $4 = $8;
		     $11 = $6 >> 31;
		     $8 = $11 & $2;
		     $12 = $4 - $8 | 0;
		     $13 = $10 - (($4 >>> 0 < $8 >>> 0) + $13 | 0) | 0;
		     $4 = $1 << 1 | $0 >>> 31;
		     $0 = $0 << 1 | $14;
		     $1 = $4 | $16;
		     $15 = 0;
		     $11 = $11 & 1;
		     $14 = $11;
		     $5 = $5 - 1 | 0;
		     if ($5) {
		      continue;
		     }
		     break;
		    }
		   }
		   i64toi32_i32$HIGH_BITS = $15 | ($1 << 1 | $0 >>> 31);
		   return $0 << 1 | $11;
		  }
		  $0 = 0;
		  $1 = 0;
		 }
		 i64toi32_i32$HIGH_BITS = $1;
		 return $0;
		}
		function xcorr_kernel_c($0, $1, $2, $3) {
		 var $4 = Math_fround(0), $5 = 0, $6 = Math_fround(0), $7 = Math_fround(0), $8 = Math_fround(0), $9 = Math_fround(0), $10 = Math_fround(0), $11 = Math_fround(0), $12 = Math_fround(0), $13 = Math_fround(0), $14 = 0;
		 {
		  $5 = $1 + 12 | 0;
		  $12 = HEAPF32[$1 + 8 >> 2];
		  $6 = HEAPF32[$1 + 4 >> 2];
		  $11 = HEAPF32[$1 >> 2];
		  {
		   $14 = $3 - 3 | 0;
		   $7 = HEAPF32[$2 + 12 >> 2];
		   $8 = HEAPF32[$2 + 8 >> 2];
		   $9 = HEAPF32[$2 + 4 >> 2];
		   $10 = HEAPF32[$2 >> 2];
		   $1 = 0;
		   while (1) {
		    $4 = HEAPF32[$0 >> 2];
		    $13 = HEAPF32[$5 >> 2];
		    $7 = Math_fround(Math_fround($4 * $13) + $7);
		    HEAPF32[$2 + 12 >> 2] = $7;
		    $8 = Math_fround(Math_fround($12 * $4) + $8);
		    HEAPF32[$2 + 8 >> 2] = $8;
		    $9 = Math_fround(Math_fround($6 * $4) + $9);
		    HEAPF32[$2 + 4 >> 2] = $9;
		    $10 = Math_fround(Math_fround($11 * $4) + $10);
		    HEAPF32[$2 >> 2] = $10;
		    $4 = HEAPF32[$0 + 4 >> 2];
		    $11 = HEAPF32[$5 + 4 >> 2];
		    $7 = Math_fround($7 + Math_fround($4 * $11));
		    HEAPF32[$2 + 12 >> 2] = $7;
		    $8 = Math_fround($8 + Math_fround($13 * $4));
		    HEAPF32[$2 + 8 >> 2] = $8;
		    $9 = Math_fround($9 + Math_fround($12 * $4));
		    HEAPF32[$2 + 4 >> 2] = $9;
		    $10 = Math_fround($10 + Math_fround($6 * $4));
		    HEAPF32[$2 >> 2] = $10;
		    $4 = HEAPF32[$0 + 8 >> 2];
		    $6 = HEAPF32[$5 + 8 >> 2];
		    $7 = Math_fround($7 + Math_fround($4 * $6));
		    HEAPF32[$2 + 12 >> 2] = $7;
		    $8 = Math_fround($8 + Math_fround($11 * $4));
		    HEAPF32[$2 + 8 >> 2] = $8;
		    $9 = Math_fround($9 + Math_fround($13 * $4));
		    HEAPF32[$2 + 4 >> 2] = $9;
		    $10 = Math_fround($10 + Math_fround($12 * $4));
		    HEAPF32[$2 >> 2] = $10;
		    $4 = HEAPF32[$0 + 12 >> 2];
		    $12 = HEAPF32[$5 + 12 >> 2];
		    $7 = Math_fround($7 + Math_fround($4 * $12));
		    HEAPF32[$2 + 12 >> 2] = $7;
		    $8 = Math_fround($8 + Math_fround($6 * $4));
		    HEAPF32[$2 + 8 >> 2] = $8;
		    $9 = Math_fround($9 + Math_fround($11 * $4));
		    HEAPF32[$2 + 4 >> 2] = $9;
		    $10 = Math_fround($10 + Math_fround($13 * $4));
		    HEAPF32[$2 >> 2] = $10;
		    $5 = $5 + 16 | 0;
		    $0 = $0 + 16 | 0;
		    $1 = $1 + 4 | 0;
		    if (($14 | 0) > ($1 | 0)) {
		     continue;
		    }
		    break;
		   }
		   $1 = $3 & -4;
		  }
		  $14 = $1 | 1;
		  if (($1 | 0) < ($3 | 0)) {
		   $13 = HEAPF32[$5 >> 2];
		   $4 = HEAPF32[$0 >> 2];
		   HEAPF32[$2 >> 2] = Math_fround($11 * $4) + HEAPF32[$2 >> 2];
		   HEAPF32[$2 + 4 >> 2] = Math_fround($6 * $4) + HEAPF32[$2 + 4 >> 2];
		   HEAPF32[$2 + 8 >> 2] = Math_fround($12 * $4) + HEAPF32[$2 + 8 >> 2];
		   HEAPF32[$2 + 12 >> 2] = Math_fround($4 * $13) + HEAPF32[$2 + 12 >> 2];
		   $5 = $5 + 4 | 0;
		   $0 = $0 + 4 | 0;
		  }
		  $1 = $14 + 1 | 0;
		  if (($3 | 0) > ($14 | 0)) {
		   $11 = HEAPF32[$5 >> 2];
		   $4 = HEAPF32[$0 >> 2];
		   HEAPF32[$2 >> 2] = Math_fround($6 * $4) + HEAPF32[$2 >> 2];
		   HEAPF32[$2 + 4 >> 2] = Math_fround($12 * $4) + HEAPF32[$2 + 4 >> 2];
		   HEAPF32[$2 + 8 >> 2] = Math_fround($13 * $4) + HEAPF32[$2 + 8 >> 2];
		   HEAPF32[$2 + 12 >> 2] = Math_fround($4 * $11) + HEAPF32[$2 + 12 >> 2];
		   $5 = $5 + 4 | 0;
		   $0 = $0 + 4 | 0;
		  }
		  if (($1 | 0) < ($3 | 0)) {
		   $4 = HEAPF32[$5 >> 2];
		   $6 = HEAPF32[$0 >> 2];
		   HEAPF32[$2 >> 2] = Math_fround($12 * $6) + HEAPF32[$2 >> 2];
		   HEAPF32[$2 + 4 >> 2] = Math_fround($13 * $6) + HEAPF32[$2 + 4 >> 2];
		   HEAPF32[$2 + 8 >> 2] = Math_fround($11 * $6) + HEAPF32[$2 + 8 >> 2];
		   HEAPF32[$2 + 12 >> 2] = Math_fround($6 * $4) + HEAPF32[$2 + 12 >> 2];
		  }
		  return;
		 }
		}
		function silk_decode_indices($0, $1, $2, $3, $4) {
		 var $5 = 0, $6 = 0;
		 $5 = __stack_pointer - 48 | 0;
		 __stack_pointer = $5;
		 $6 = $0 + 2766 | 0;
		 label$1 : {
		  if (!(HEAP32[(($2 << 2) + $0 | 0) + 2404 >> 2] ? 0 : !$3)) {
		   $3 = ec_dec_icdf($1, 6709, 8) + 2 | 0;
		   break label$1;
		  }
		  $3 = ec_dec_icdf($1, 6713, 8);
		 }
		 HEAP8[$6 | 0] = $3 & 1;
		 $3 = $3 >>> 1 | 0;
		 HEAP8[$0 + 2765 | 0] = $3;
		 label$4 : {
		  if (($4 | 0) == 2) {
		   HEAP8[$0 + 2736 | 0] = ec_dec_icdf($1, 7040, 8);
		   break label$4;
		  }
		  HEAP8[$0 + 2736 | 0] = ec_dec_icdf($1, ($3 << 24 >> 21) + 7008 | 0, 8) << 3;
		  HEAP8[$0 + 2736 | 0] = ec_dec_icdf($1, 6752, 8) + HEAPU8[$0 + 2736 | 0];
		 }
		 if (HEAP32[$0 + 2324 >> 2] >= 2) {
		  $3 = 1;
		  while (1) {
		   HEAP8[($0 + $3 | 0) + 2736 | 0] = ec_dec_icdf($1, 7040, 8);
		   $3 = $3 + 1 | 0;
		   if (($3 | 0) < HEAP32[$0 + 2324 >> 2]) {
		    continue;
		   }
		   break;
		  }
		 }
		 $2 = $0 + 2744 | 0;
		 $3 = HEAP32[$0 + 2732 >> 2];
		 $3 = ec_dec_icdf($1, HEAP32[$3 + 16 >> 2] + Math_imul(HEAP16[$3 >> 1], HEAP8[$0 + 2765 | 0] >> 1) | 0, 8);
		 HEAP8[$2 | 0] = $3;
		 silk_NLSF_unpack($5 + 16 | 0, $5, HEAP32[$0 + 2732 >> 2], $3 << 24 >> 24);
		 $2 = HEAP32[$0 + 2732 >> 2];
		 $6 = HEAP16[$2 + 2 >> 1];
		 if (($6 | 0) == HEAP32[$0 + 2340 >> 2]) {
		  $3 = 0;
		  if (($6 | 0) > 0) {
		   while (1) {
		    label$11 : {
		     label$12 : {
		      label$13 : {
		       $2 = ec_dec_icdf($1, HEAP32[$2 + 28 >> 2] + HEAP16[($5 + 16 | 0) + ($3 << 1) >> 1] | 0, 8);
		       switch ($2 | 0) {
		       case 8:
		        break label$12;
		       case 0:
		        break label$13;
		       default:
		        break label$11;
		       }
		      }
		      $2 = 0 - ec_dec_icdf($1, 6760, 8) | 0;
		      break label$11;
		     }
		     $2 = ec_dec_icdf($1, 6760, 8) + 8 | 0;
		    }
		    $3 = $3 + 1 | 0;
		    HEAP8[($3 + $0 | 0) + 2744 | 0] = $2 - 4;
		    $2 = HEAP32[$0 + 2732 >> 2];
		    if (HEAP16[$2 + 2 >> 1] > ($3 | 0)) {
		     continue;
		    }
		    break;
		   }
		  }
		  $3 = 4;
		  if (HEAP32[$0 + 2324 >> 2] == 4) {
		   $3 = ec_dec_icdf($1, 6715, 8);
		  }
		  HEAP8[$0 + 2767 | 0] = $3;
		  if (HEAPU8[$0 + 2765 | 0] == 2) {
		   label$16 : {
		    label$17 : {
		     if (($4 | 0) != 2 | HEAP32[$0 + 2396 >> 2] != 2) {
		      break label$17;
		     }
		     $3 = ec_dec_icdf($1, 2960, 8);
		     if ($3 << 16 < 1) {
		      break label$17;
		     }
		     $2 = (HEAPU16[$0 + 2400 >> 1] + $3 | 0) - 9 | 0;
		     HEAP16[$0 + 2762 >> 1] = $2;
		     break label$16;
		    }
		    $3 = $0 + 2762 | 0;
		    HEAP16[$3 >> 1] = Math_imul(ec_dec_icdf($1, 2928, 8), HEAP32[$0 + 2316 >> 2] >>> 1 | 0);
		    $2 = ec_dec_icdf($1, HEAP32[$0 + 2380 >> 2], 8) + HEAPU16[$3 >> 1] | 0;
		    HEAP16[$3 >> 1] = $2;
		   }
		   HEAP16[$0 + 2400 >> 1] = $2;
		   HEAP8[$0 + 2764 | 0] = ec_dec_icdf($1, HEAP32[$0 + 2384 >> 2], 8);
		   $3 = $0 + 2768 | 0;
		   $2 = ec_dec_icdf($1, 7081, 8);
		   HEAP8[$3 | 0] = $2;
		   $3 = 1;
		   label$18 : {
		    if (HEAP32[$0 + 2324 >> 2] < 1) {
		     break label$18;
		    }
		    HEAP8[$0 + 2740 | 0] = ec_dec_icdf($1, HEAP32[($2 << 24 >> 22) + 7152 >> 2], 8);
		    if (HEAP32[$0 + 2324 >> 2] < 2) {
		     break label$18;
		    }
		    while (1) {
		     HEAP8[($0 + $3 | 0) + 2740 | 0] = ec_dec_icdf($1, HEAP32[(HEAP8[$0 + 2768 | 0] << 2) + 7152 >> 2], 8);
		     $3 = $3 + 1 | 0;
		     if (($3 | 0) < HEAP32[$0 + 2324 >> 2]) {
		      continue;
		     }
		     break;
		    }
		   }
		   $3 = 0;
		   if (!$4) {
		    $3 = ec_dec_icdf($1, 6706, 8);
		   }
		   HEAP8[$0 + 2769 | 0] = $3;
		  }
		  HEAP32[$0 + 2396 >> 2] = HEAP8[$0 + 2765 | 0];
		  HEAP8[$0 + 2770 | 0] = ec_dec_icdf($1, 6737, 8);
		  __stack_pointer = $5 + 48 | 0;
		  return;
		 }
		 celt_fatal(7468, 7530, 82);
		 abort();
		}
		function ec_dec_uint($0, $1) {
		 var $2 = 0, $3 = 0, $4 = 0, $5 = 0, $6 = 0, $7 = 0, $8 = 0, $9 = 0, $10 = 0, $11 = 0, $12 = 0;
		 if ($1 >>> 0 > 1) {
		  $10 = $1 - 1 | 0;
		  label$2 : {
		   if ($10 >>> 0 >= 256) {
		    $4 = HEAP32[$0 + 28 >> 2];
		    $7 = 24 - Math_clz32($10) | 0;
		    $2 = $10 >>> $7 | 0;
		    $3 = $2 + 1 | 0;
		    $1 = ($4 >>> 0) / ($3 >>> 0) | 0;
		    HEAP32[$0 + 36 >> 2] = $1;
		    $5 = HEAP32[$0 + 32 >> 2];
		    $8 = $5;
		    $5 = ($5 >>> 0) / ($1 >>> 0) | 0;
		    $6 = $5 + 1 | 0;
		    $3 = $6 - $3 | 0;
		    $11 = ($3 >>> 0 > $6 >>> 0 ? 0 : $3) + ($2 - $5 | 0) | 0;
		    $2 = Math_imul($2 - $11 | 0, $1);
		    $3 = $8 - $2 | 0;
		    HEAP32[$0 + 32 >> 2] = $3;
		    $2 = $11 ? $1 : $4 - $2 | 0;
		    HEAP32[$0 + 28 >> 2] = $2;
		    if ($2 >>> 0 <= 8388608) {
		     $4 = HEAP32[$0 + 24 >> 2];
		     $5 = HEAP32[$0 + 40 >> 2];
		     $6 = HEAP32[$0 + 20 >> 2];
		     $12 = HEAP32[$0 + 4 >> 2];
		     while (1) {
		      $8 = $2 << 8;
		      HEAP32[$0 + 28 >> 2] = $8;
		      $6 = $6 + 8 | 0;
		      HEAP32[$0 + 20 >> 2] = $6;
		      $1 = 0;
		      if ($4 >>> 0 < $12 >>> 0) {
		       $9 = $4 + 1 | 0;
		       HEAP32[$0 + 24 >> 2] = $9;
		       $1 = HEAPU8[HEAP32[$0 >> 2] + $4 | 0];
		       $4 = $9;
		      }
		      HEAP32[$0 + 40 >> 2] = $1;
		      $3 = (($5 << 8 | $1) >>> 1 & 255 | $3 << 8 & 2147483392) ^ 255;
		      HEAP32[$0 + 32 >> 2] = $3;
		      $9 = $2 >>> 0 < 32769;
		      $5 = $1;
		      $2 = $8;
		      if ($9) {
		       continue;
		      }
		      break;
		     }
		    }
		    $8 = $11 << $7;
		    $3 = HEAP32[$0 + 12 >> 2];
		    $1 = HEAP32[$0 + 16 >> 2];
		    label$7 : {
		     if ($7 >>> 0 <= $1 >>> 0) {
		      $6 = $1;
		      break label$7;
		     }
		     $2 = HEAP32[$0 + 8 >> 2];
		     $5 = HEAP32[$0 + 4 >> 2];
		     while (1) {
		      $4 = 0;
		      if ($2 >>> 0 < $5 >>> 0) {
		       $2 = $2 + 1 | 0;
		       HEAP32[$0 + 8 >> 2] = $2;
		       $4 = HEAPU8[HEAP32[$0 >> 2] + ($5 - $2 | 0) | 0];
		      }
		      $3 = $4 << $1 | $3;
		      $4 = ($1 | 0) < 17;
		      $6 = $1 + 8 | 0;
		      $1 = $6;
		      if ($4) {
		       continue;
		      }
		      break;
		     }
		    }
		    HEAP32[$0 + 16 >> 2] = $6 - $7;
		    HEAP32[$0 + 12 >> 2] = $3 >>> $7;
		    HEAP32[$0 + 20 >> 2] = HEAP32[$0 + 20 >> 2] + $7;
		    $7 = (-1 << $7 ^ -1) & $3 | $8;
		    if ($10 >>> 0 >= $7 >>> 0) {
		     break label$2;
		    }
		    HEAP32[$0 + 44 >> 2] = 1;
		    return $10;
		   }
		   $4 = HEAP32[$0 + 28 >> 2];
		   $2 = ($4 >>> 0) / ($1 >>> 0) | 0;
		   HEAP32[$0 + 36 >> 2] = $2;
		   $3 = HEAP32[$0 + 32 >> 2];
		   $8 = $3;
		   $3 = ($3 >>> 0) / ($2 >>> 0) | 0;
		   $9 = ($3 ^ -1) + $1 | 0;
		   $3 = $3 + 1 | 0;
		   $5 = $3 - $1 | 0;
		   $7 = $9 + ($3 >>> 0 < $5 >>> 0 ? 0 : $5) | 0;
		   $1 = Math_imul(($7 ^ -1) + $1 | 0, $2);
		   $3 = $8 - $1 | 0;
		   HEAP32[$0 + 32 >> 2] = $3;
		   $2 = $7 ? $2 : $4 - $1 | 0;
		   HEAP32[$0 + 28 >> 2] = $2;
		   if ($2 >>> 0 > 8388608) {
		    break label$2;
		   }
		   $4 = HEAP32[$0 + 24 >> 2];
		   $5 = HEAP32[$0 + 40 >> 2];
		   $6 = HEAP32[$0 + 20 >> 2];
		   $12 = HEAP32[$0 + 4 >> 2];
		   while (1) {
		    $8 = $2 << 8;
		    HEAP32[$0 + 28 >> 2] = $8;
		    $6 = $6 + 8 | 0;
		    HEAP32[$0 + 20 >> 2] = $6;
		    $1 = 0;
		    if ($4 >>> 0 < $12 >>> 0) {
		     $9 = $4 + 1 | 0;
		     HEAP32[$0 + 24 >> 2] = $9;
		     $1 = HEAPU8[HEAP32[$0 >> 2] + $4 | 0];
		     $4 = $9;
		    }
		    HEAP32[$0 + 40 >> 2] = $1;
		    $3 = (($5 << 8 | $1) >>> 1 & 255 | $3 << 8 & 2147483392) ^ 255;
		    HEAP32[$0 + 32 >> 2] = $3;
		    $9 = $2 >>> 0 < 32769;
		    $5 = $1;
		    $2 = $8;
		    if ($9) {
		     continue;
		    }
		    break;
		   }
		  }
		  return $7;
		 }
		 celt_fatal(6958, 6982, 203);
		 abort();
		}
		function op_pvq_search_c($0, $1, $2, $3, $4) {
		 var $5 = 0, $6 = Math_fround(0), $7 = Math_fround(0), $8 = 0, $9 = Math_fround(0), $10 = Math_fround(0), $11 = 0, $12 = 0, $13 = Math_fround(0), $14 = 0, $15 = 0, $16 = Math_fround(0), $17 = 0, $18 = Math_fround(0);
		 $4 = __stack_pointer;
		 $17 = $4;
		 $5 = ($3 << 2) + 15 & -16;
		 $4 = $4 - $5 | 0;
		 __stack_pointer = $4;
		 $14 = $4 - $5 | 0;
		 __stack_pointer = $14;
		 $11 = ($3 | 0) > 1 ? $3 : 1;
		 $12 = memset($4, 0, $11 << 2);
		 $4 = 0;
		 while (1) {
		  $5 = $4 << 2;
		  $8 = $5 + $0 | 0;
		  $6 = HEAPF32[$8 >> 2];
		  HEAP32[$5 + $14 >> 2] = $6 < Math_fround(0);
		  HEAPF32[$8 >> 2] = Math_abs($6);
		  HEAP32[$1 + $5 >> 2] = 0;
		  $4 = $4 + 1 | 0;
		  if (($11 | 0) != ($4 | 0)) {
		   continue;
		  }
		  break;
		 }
		 $6 = Math_fround(0);
		 if (($2 | 0) > $3 >> 1) {
		  $4 = 0;
		  while (1) {
		   $6 = Math_fround($6 + HEAPF32[($4 << 2) + $0 >> 2]);
		   $4 = $4 + 1 | 0;
		   if (($11 | 0) != ($4 | 0)) {
		    continue;
		   }
		   break;
		  }
		  if (!($6 < Math_fround(64) ? !($6 > Math_fround(1.0000000036274937e-15) ^ 1) : 0)) {
		   HEAP32[$0 >> 2] = 1065353216;
		   memset($0 + 4 | 0, 0, ((($3 | 0) > 2 ? $3 : 2) << 2) - 4 | 0);
		   $6 = Math_fround(1);
		  }
		  $9 = Math_fround(Math_fround(Math_fround($2 | 0) + Math_fround(.800000011920929)) * Math_fround(Math_fround(1) / $6));
		  $5 = 0;
		  $6 = Math_fround(0);
		  while (1) {
		   $8 = $5 << 2;
		   $15 = $8 + $1 | 0;
		   $10 = HEAPF32[$0 + $8 >> 2];
		   $7 = Math_fround(Math_floor(Math_fround($9 * $10)));
		   label$7 : {
		    if (Math_fround(Math_abs($7)) < Math_fround(2147483648)) {
		     $4 = ~~$7;
		     break label$7;
		    }
		    $4 = -2147483648;
		   }
		   HEAP32[$15 >> 2] = $4;
		   $7 = Math_fround($4 | 0);
		   HEAPF32[$8 + $12 >> 2] = $7 + $7;
		   $13 = Math_fround($13 + Math_fround($10 * $7));
		   $2 = $2 - $4 | 0;
		   $6 = Math_fround($6 + Math_fround($7 * $7));
		   $5 = $5 + 1 | 0;
		   if (($11 | 0) != ($5 | 0)) {
		    continue;
		   }
		   break;
		  }
		 }
		 label$9 : {
		  if (($3 + 3 | 0) < ($2 | 0)) {
		   $10 = HEAPF32[$12 >> 2];
		   HEAP32[$1 >> 2] = HEAP32[$1 >> 2] + $2;
		   $7 = Math_fround($2 | 0);
		   $6 = Math_fround(Math_fround($6 + Math_fround($7 * $7)) + Math_fround($10 * $7));
		   break label$9;
		  }
		  if (($2 | 0) < 1) {
		   break label$9;
		  }
		  $15 = ($3 | 0) > 2 ? $3 : 2;
		  $18 = HEAPF32[$0 >> 2];
		  $3 = 0;
		  while (1) {
		   $16 = Math_fround($6 + Math_fround(1));
		   $6 = Math_fround($16 + HEAPF32[$12 >> 2]);
		   $7 = Math_fround($13 + $18);
		   $7 = Math_fround($7 * $7);
		   $4 = 1;
		   $8 = 0;
		   while (1) {
		    $5 = $4 << 2;
		    $10 = Math_fround($16 + HEAPF32[$12 + $5 >> 2]);
		    $9 = Math_fround($13 + HEAPF32[$0 + $5 >> 2]);
		    $9 = Math_fround($9 * $9);
		    $5 = Math_fround($6 * $9) > Math_fround($7 * $10);
		    $6 = $5 ? $10 : $6;
		    $7 = $5 ? $9 : $7;
		    $8 = $5 ? $4 : $8;
		    $4 = $4 + 1 | 0;
		    if (($15 | 0) != ($4 | 0)) {
		     continue;
		    }
		    break;
		   }
		   $4 = $8 << 2;
		   $7 = HEAPF32[$4 + $0 >> 2];
		   $5 = $4 + $12 | 0;
		   $6 = HEAPF32[$5 >> 2];
		   HEAPF32[$5 >> 2] = $6 + Math_fround(2);
		   $4 = $1 + $4 | 0;
		   HEAP32[$4 >> 2] = HEAP32[$4 >> 2] + 1;
		   $6 = Math_fround($16 + $6);
		   $13 = Math_fround($13 + $7);
		   $3 = $3 + 1 | 0;
		   if (($3 | 0) != ($2 | 0)) {
		    continue;
		   }
		   break;
		  }
		 }
		 $4 = 0;
		 while (1) {
		  $5 = $4 << 2;
		  $8 = $5 + $1 | 0;
		  $5 = HEAP32[$5 + $14 >> 2];
		  HEAP32[$8 >> 2] = $5 + (HEAP32[$8 >> 2] ^ 0 - $5);
		  $4 = $4 + 1 | 0;
		  if (($11 | 0) != ($4 | 0)) {
		   continue;
		  }
		  break;
		 }
		 __stack_pointer = $17;
		 return $6;
		}
		function silk_resampler_init($0, $1, $2, $3) {
		 var $4 = 0, $5 = 0, $6 = 0;
		 label$1 : {
		  label$2 : {
		   $4 = memset($0, 0, 300);
		   $0 = $4;
		   label$3 : {
		    if ($3) {
		     label$5 : {
		      if (($1 | 0) <= 15999) {
		       if (($1 | 0) == 8e3 | ($1 | 0) == 12e3) {
		        break label$5;
		       }
		       break label$1;
		      }
		      if (($1 | 0) == 16e3 | ($1 | 0) == 48e3) {
		       break label$5;
		      }
		      if (($1 | 0) != 24e3) {
		       break label$1;
		      }
		     }
		     if (($2 | 0) != 16e3 ? !(($2 | 0) == 8e3 | ($2 | 0) == 12e3) : 0) {
		      break label$1;
		     }
		     $3 = (Math_imul(($1 >>> 12 | 0) - (($1 | 0) > 16e3) >> (($1 | 0) > 24e3), 3) + ($2 >>> 12 | 0) | 0) + 2791 | 0;
		     break label$3;
		    }
		    if (($1 | 0) != 12e3 ? !(($1 | 0) == 8e3 | ($1 | 0) == 16e3) : 0) {
		     break label$2;
		    }
		    label$9 : {
		     if (($2 | 0) <= 15999) {
		      if (($2 | 0) == 8e3 | ($2 | 0) == 12e3) {
		       break label$9;
		      }
		      break label$2;
		     }
		     if (($2 | 0) == 16e3 | ($2 | 0) == 24e3) {
		      break label$9;
		     }
		     if (($2 | 0) != 48e3) {
		      break label$2;
		     }
		    }
		    $3 = (Math_imul($1 >>> 12 | 0, 5) + (($2 >>> 12 | 0) - (($2 | 0) > 16e3) >> (($2 | 0) > 24e3)) | 0) + 2804 | 0;
		   }
		   HEAP32[$0 + 292 >> 2] = HEAP8[$3 | 0];
		   HEAP32[$4 + 288 >> 2] = (($2 & 65535) >>> 0) / 1e3;
		   $3 = (($1 & 65535) >>> 0) / 1e3 | 0;
		   HEAP32[$4 + 284 >> 2] = $3;
		   HEAP32[$4 + 268 >> 2] = Math_imul($3, 10);
		   label$11 : {
		    if (($1 | 0) < ($2 | 0)) {
		     $5 = 1;
		     if ($1 << 1 == ($2 | 0)) {
		      HEAP32[$4 + 264 >> 2] = 1;
		      $5 = 0;
		      break label$11;
		     }
		     HEAP32[$4 + 264 >> 2] = 2;
		     break label$11;
		    }
		    if (($1 | 0) > ($2 | 0)) {
		     HEAP32[$4 + 264 >> 2] = 3;
		     $3 = $2 << 2;
		     if (($3 | 0) == (Math_imul($1, 3) | 0)) {
		      HEAP32[$4 + 296 >> 2] = 2320;
		      HEAP32[$4 + 276 >> 2] = 18;
		      HEAP32[$4 + 280 >> 2] = 3;
		      break label$11;
		     }
		     $0 = Math_imul($2, 3);
		     if (($0 | 0) == $1 << 1) {
		      HEAP32[$4 + 296 >> 2] = 2384;
		      HEAP32[$4 + 276 >> 2] = 18;
		      HEAP32[$4 + 280 >> 2] = 2;
		      break label$11;
		     }
		     if ($2 << 1 == ($1 | 0)) {
		      HEAP32[$4 + 296 >> 2] = 2432;
		      HEAP32[$4 + 276 >> 2] = 24;
		      HEAP32[$4 + 280 >> 2] = 1;
		      break label$11;
		     }
		     if (($0 | 0) == ($1 | 0)) {
		      HEAP32[$4 + 296 >> 2] = 2464;
		      HEAP32[$4 + 276 >> 2] = 36;
		      HEAP32[$4 + 280 >> 2] = 1;
		      break label$11;
		     }
		     if (($1 | 0) == ($3 | 0)) {
		      HEAP32[$4 + 296 >> 2] = 2512;
		      HEAP32[$4 + 276 >> 2] = 36;
		      HEAP32[$4 + 280 >> 2] = 1;
		      break label$11;
		     }
		     if ((Math_imul($2, 6) | 0) == ($1 | 0)) {
		      HEAP32[$4 + 296 >> 2] = 2560;
		      HEAP32[$4 + 276 >> 2] = 36;
		      HEAP32[$4 + 280 >> 2] = 1;
		      break label$11;
		     }
		     celt_fatal(2758, 2778, 154);
		     abort();
		    }
		    HEAP32[$4 + 264 >> 2] = 0;
		   }
		   $0 = $1 << $5;
		   $3 = $2 << 16 >> 16;
		   $6 = ($2 >>> 15 | 0) + 1 >>> 1 | 0;
		   $1 = ($1 << ($5 | 14)) / ($2 | 0) << 2;
		   while (1) {
		    $2 = $1;
		    $1 = $2 + 1 | 0;
		    if (((Math_imul($2 >> 16, $3) + Math_imul($2, $6) | 0) + (Math_imul($2 & 65535, $3) >> 16) | 0) < ($0 | 0)) {
		     continue;
		    }
		    break;
		   }
		   HEAP32[$4 + 272 >> 2] = $2;
		   return 0;
		  }
		  celt_fatal(2758, 2778, 101);
		  abort();
		 }
		 celt_fatal(2758, 2778, 94);
		 abort();
		}
		function comb_filter($0, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) {
		 var $12 = Math_fround(0), $13 = Math_fround(0), $14 = Math_fround(0), $15 = Math_fround(0), $16 = 0, $17 = Math_fround(0), $18 = 0, $19 = 0, $20 = 0, $21 = 0, $22 = Math_fround(0), $23 = Math_fround(0), $24 = Math_fround(0), $25 = Math_fround(0), $26 = Math_fround(0), $27 = Math_fround(0), $28 = Math_fround(0), $29 = Math_fround(0), $30 = Math_fround(0);
		 label$1 : {
		  if (!($5 != Math_fround(0) | $6 != Math_fround(0))) {
		   if (($0 | 0) == ($1 | 0)) {
		    break label$1;
		   }
		   memmove($0, $1, $4 << 2);
		   return;
		  }
		  $11 = ($3 | 0) > 15 ? $3 : 15;
		  $18 = -2 - $11 | 0;
		  $19 = $11 ^ -1;
		  $20 = 1 - $11 | 0;
		  $21 = 0 - $11 | 0;
		  $3 = Math_imul($8, 12);
		  $22 = Math_fround(HEAPF32[$3 + 1624 >> 2] * $6);
		  $23 = Math_fround(HEAPF32[$3 + 1620 >> 2] * $6);
		  $24 = Math_fround(HEAPF32[$3 + 1616 >> 2] * $6);
		  $3 = $5 == $6 ? ($7 | 0) == ($8 | 0) ? 0 : $10 : $10;
		  $8 = ($2 | 0) > 15 ? $2 : 15;
		  $3 = ($11 | 0) == ($8 | 0) ? $3 : $10;
		  if (($3 | 0) >= 1) {
		   $10 = Math_imul($7, 12);
		   $25 = Math_fround(HEAPF32[$10 + 1624 >> 2] * $5);
		   $26 = Math_fround(HEAPF32[$10 + 1620 >> 2] * $5);
		   $27 = Math_fround(HEAPF32[$10 + 1616 >> 2] * $5);
		   $7 = 2 - $11 | 0;
		   $12 = HEAPF32[($20 << 2) + $1 >> 2];
		   $13 = HEAPF32[($21 << 2) + $1 >> 2];
		   $14 = HEAPF32[($19 << 2) + $1 >> 2];
		   $5 = HEAPF32[($18 << 2) + $1 >> 2];
		   $10 = 0;
		   while (1) {
		    $2 = $10 << 2;
		    $16 = $2 + $0 | 0;
		    $15 = HEAPF32[($7 + $10 << 2) + $1 >> 2];
		    $17 = Math_fround($5 + $15);
		    $5 = HEAPF32[$2 + $9 >> 2];
		    $5 = Math_fround($5 * $5);
		    $17 = Math_fround($17 * Math_fround($22 * $5));
		    $28 = Math_fround(Math_fround($12 + $14) * Math_fround($23 * $5));
		    $29 = Math_fround($13 * Math_fround($24 * $5));
		    $30 = HEAPF32[$1 + $2 >> 2];
		    $2 = ($10 - $8 << 2) + $1 | 0;
		    $5 = Math_fround(Math_fround(1) - $5);
		    HEAPF32[$16 >> 2] = $17 + Math_fround($28 + Math_fround($29 + Math_fround(Math_fround(Math_fround($30 + Math_fround(HEAPF32[$2 >> 2] * Math_fround($27 * $5))) + Math_fround(Math_fround($26 * $5) * Math_fround(HEAPF32[$2 + 4 >> 2] + HEAPF32[$2 - 4 >> 2]))) + Math_fround(Math_fround($25 * $5) * Math_fround(HEAPF32[$2 + 8 >> 2] + HEAPF32[$2 - 8 >> 2])))));
		    $5 = $14;
		    $14 = $13;
		    $13 = $12;
		    $12 = $15;
		    $10 = $10 + 1 | 0;
		    if (($10 | 0) != ($3 | 0)) {
		     continue;
		    }
		    break;
		   }
		   $16 = $3;
		  }
		  if ($6 == Math_fround(0)) {
		   if (($0 | 0) == ($1 | 0)) {
		    break label$1;
		   }
		   $10 = $3 << 2;
		   memmove($10 + $0 | 0, $1 + $10 | 0, $4 - $3 << 2);
		   return;
		  }
		  $3 = $4 - $16 | 0;
		  if (($3 | 0) < 1) {
		   break label$1;
		  }
		  $10 = $16 << 2;
		  $0 = $10 + $0 | 0;
		  $9 = 2 - $11 | 0;
		  $2 = $1 + $10 | 0;
		  $14 = HEAPF32[$2 + ($18 << 2) >> 2];
		  $5 = HEAPF32[($19 << 2) + $2 >> 2];
		  $12 = HEAPF32[($21 << 2) + $2 >> 2];
		  $13 = HEAPF32[($20 << 2) + $2 >> 2];
		  $10 = 0;
		  while (1) {
		   $1 = $10 << 2;
		   $15 = HEAPF32[($9 + $10 << 2) + $2 >> 2];
		   HEAPF32[$1 + $0 >> 2] = Math_fround($22 * Math_fround($14 + $15)) + Math_fround(Math_fround($23 * Math_fround($5 + $13)) + Math_fround(Math_fround($24 * $12) + HEAPF32[$1 + $2 >> 2]));
		   $14 = $5;
		   $5 = $12;
		   $12 = $13;
		   $13 = $15;
		   $10 = $10 + 1 | 0;
		   if (($10 | 0) != ($3 | 0)) {
		    continue;
		   }
		   break;
		  }
		 }
		}
		function opus_decoder_ctl($0, $1, $2) {
		 $0 = $0 | 0;
		 $1 = $1 | 0;
		 $2 = $2 | 0;
		 var $3 = 0, $4 = 0, $5 = 0;
		 $3 = __stack_pointer - 48 | 0;
		 __stack_pointer = $3;
		 $5 = HEAP32[$0 + 4 >> 2];
		 $4 = HEAP32[$0 >> 2];
		 HEAP32[$3 + 44 >> 2] = $2;
		 $4 = $0 + $4 | 0;
		 $2 = -5;
		 label$1 : {
		  label$2 : {
		   switch ($1 - 4009 | 0) {
		   case 0:
		    $2 = HEAP32[$3 + 44 >> 2];
		    HEAP32[$3 + 44 >> 2] = $2 + 4;
		    $2 = HEAP32[$2 >> 2];
		    if (!$2) {
		     $2 = -1;
		     break label$1;
		    }
		    HEAP32[$2 >> 2] = HEAP32[$0 + 52 >> 2];
		    $2 = 0;
		    break label$1;
		   case 22:
		    $2 = HEAP32[$3 + 44 >> 2];
		    HEAP32[$3 + 44 >> 2] = $2 + 4;
		    $2 = HEAP32[$2 >> 2];
		    if (!$2) {
		     $2 = -1;
		     break label$1;
		    }
		    HEAP32[$2 >> 2] = HEAP32[$0 + 84 >> 2];
		    $2 = 0;
		    break label$1;
		   case 19:
		    HEAP32[$0 + 64 >> 2] = 0;
		    HEAP32[$0 + 68 >> 2] = 0;
		    HEAP32[$0 + 48 >> 2] = 0;
		    HEAP32[$0 + 52 >> 2] = 0;
		    HEAP32[$0 + 80 >> 2] = 0;
		    HEAP32[$0 + 84 >> 2] = 0;
		    HEAP32[$0 + 72 >> 2] = 0;
		    HEAP32[$0 + 76 >> 2] = 0;
		    HEAP32[$0 + 56 >> 2] = 0;
		    HEAP32[$0 + 60 >> 2] = 0;
		    $2 = 0;
		    opus_custom_decoder_ctl($4, 4028, 0);
		    silk_InitDecoder($0 + $5 | 0);
		    HEAP32[$0 + 48 >> 2] = HEAP32[$0 + 8 >> 2];
		    HEAP32[$0 + 64 >> 2] = HEAP32[$0 + 12 >> 2] / 400;
		    break label$1;
		   case 20:
		    $2 = HEAP32[$3 + 44 >> 2];
		    HEAP32[$3 + 44 >> 2] = $2 + 4;
		    $2 = HEAP32[$2 >> 2];
		    if (!$2) {
		     $2 = -1;
		     break label$1;
		    }
		    HEAP32[$2 >> 2] = HEAP32[$0 + 12 >> 2];
		    $2 = 0;
		    break label$1;
		   case 24:
		    $2 = HEAP32[$3 + 44 >> 2];
		    HEAP32[$3 + 44 >> 2] = $2 + 4;
		    $2 = HEAP32[$2 >> 2];
		    if (!$2) {
		     $2 = -1;
		     break label$1;
		    }
		    if (HEAP32[$0 + 60 >> 2] == 1002) {
		     HEAP32[$3 >> 2] = $2;
		     $2 = opus_custom_decoder_ctl($4, 4033, $3);
		     break label$1;
		    }
		    HEAP32[$2 >> 2] = HEAP32[$0 + 36 >> 2];
		    $2 = 0;
		    break label$1;
		   case 36:
		    $2 = HEAP32[$3 + 44 >> 2];
		    HEAP32[$3 + 44 >> 2] = $2 + 4;
		    $2 = HEAP32[$2 >> 2];
		    if (!$2) {
		     $2 = -1;
		     break label$1;
		    }
		    HEAP32[$2 >> 2] = HEAP32[$0 + 40 >> 2];
		    $2 = 0;
		    break label$1;
		   case 25:
		    $1 = HEAP32[$3 + 44 >> 2];
		    HEAP32[$3 + 44 >> 2] = $1 + 4;
		    $2 = -1;
		    $1 = HEAP32[$1 >> 2];
		    if ($1 + 32768 >>> 0 > 65535) {
		     break label$1;
		    }
		    HEAP32[$0 + 40 >> 2] = $1;
		    $2 = 0;
		    break label$1;
		   case 30:
		    $2 = HEAP32[$3 + 44 >> 2];
		    HEAP32[$3 + 44 >> 2] = $2 + 4;
		    $2 = HEAP32[$2 >> 2];
		    if (!$2) {
		     $2 = -1;
		     break label$1;
		    }
		    HEAP32[$2 >> 2] = HEAP32[$0 + 72 >> 2];
		    $2 = 0;
		    break label$1;
		   case 37:
		    $0 = HEAP32[$3 + 44 >> 2];
		    HEAP32[$3 + 44 >> 2] = $0 + 4;
		    $2 = -1;
		    $0 = HEAP32[$0 >> 2];
		    if ($0 >>> 0 > 1) {
		     break label$1;
		    }
		    HEAP32[$3 + 16 >> 2] = $0;
		    $2 = opus_custom_decoder_ctl($4, 4046, $3 + 16 | 0);
		    break label$1;
		   case 38:
		    break label$2;
		   default:
		    break label$1;
		   }
		  }
		  $0 = HEAP32[$3 + 44 >> 2];
		  HEAP32[$3 + 44 >> 2] = $0 + 4;
		  $0 = HEAP32[$0 >> 2];
		  if (!$0) {
		   $2 = -1;
		   break label$1;
		  }
		  HEAP32[$3 + 32 >> 2] = $0;
		  $2 = opus_custom_decoder_ctl($4, 4047, $3 + 32 | 0);
		 }
		 __stack_pointer = $3 + 48 | 0;
		 return $2 | 0;
		}
		function celt_iir($0, $1, $2, $3, $4, $5, $6) {
		 var $7 = 0, $8 = Math_fround(0), $9 = 0, $10 = 0, $11 = 0, $12 = Math_fround(0), $13 = 0, $14 = 0, $15 = Math_fround(0), $16 = 0, $17 = 0, $18 = 0;
		 $6 = __stack_pointer - 16 | 0;
		 $9 = $6;
		 __stack_pointer = $6;
		 {
		  $13 = $6 - (($4 << 2) + 15 & -16) | 0;
		  $11 = $13;
		  __stack_pointer = $11;
		  $7 = $3 + $4 | 0;
		  $11 = $11 - (($7 << 2) + 15 & -16) | 0;
		  __stack_pointer = $11;
		  $14 = $7;
		  $6 = 0;
		  $10 = 0;
		  {
		   while (1) {
		    HEAP32[($6 << 2) + $13 >> 2] = HEAP32[(($6 ^ -1) + $4 << 2) + $1 >> 2];
		    $6 = $6 + 1 | 0;
		    if (($6 | 0) != ($4 | 0)) {
		     continue;
		    }
		    break;
		   }
		   $6 = 0;
		   $10 = 0;
		   while (1) {
		    HEAPF32[($6 << 2) + $11 >> 2] = -HEAPF32[(($6 ^ -1) + $4 << 2) + $5 >> 2];
		    $6 = $6 + 1 | 0;
		    if (($6 | 0) != ($4 | 0)) {
		     continue;
		    }
		    break;
		   }
		   $10 = $4;
		  }
		  $6 = $10;
		  if (($14 | 0) > ($6 | 0)) {
		   memset(($6 << 2) + $11 | 0, 0, $7 - $6 << 2);
		  }
		  $7 = 0;
		  if (($3 | 0) >= 4) {
		   $18 = $3 - 3 | 0;
		   while (1) {
		    $6 = $7 << 2;
		    HEAP32[$9 >> 2] = HEAP32[$6 + $0 >> 2];
		    $14 = $6 | 4;
		    HEAP32[$9 + 4 >> 2] = HEAP32[$14 + $0 >> 2];
		    $16 = $6 | 8;
		    HEAP32[$9 + 8 >> 2] = HEAP32[$16 + $0 >> 2];
		    $17 = $6 | 12;
		    HEAP32[$9 + 12 >> 2] = HEAP32[$17 + $0 >> 2];
		    xcorr_kernel_c($13, $6 + $11 | 0, $9, $4);
		    $10 = ($4 + $7 << 2) + $11 | 0;
		    $8 = HEAPF32[$9 >> 2];
		    HEAPF32[$10 >> 2] = -$8;
		    HEAPF32[$2 + $6 >> 2] = $8;
		    $12 = Math_fround(HEAPF32[$9 + 4 >> 2] - Math_fround($8 * HEAPF32[$1 >> 2]));
		    HEAPF32[$9 + 4 >> 2] = $12;
		    HEAPF32[$10 + 4 >> 2] = -$12;
		    HEAPF32[$2 + $14 >> 2] = $12;
		    $15 = Math_fround(Math_fround(HEAPF32[$9 + 8 >> 2] - Math_fround($12 * HEAPF32[$1 >> 2])) - Math_fround($8 * HEAPF32[$1 + 4 >> 2]));
		    HEAPF32[$9 + 8 >> 2] = $15;
		    HEAPF32[$10 + 8 >> 2] = -$15;
		    HEAPF32[$2 + $16 >> 2] = $15;
		    $8 = Math_fround(Math_fround(Math_fround(HEAPF32[$9 + 12 >> 2] - Math_fround($15 * HEAPF32[$1 >> 2])) - Math_fround($12 * HEAPF32[$1 + 4 >> 2])) - Math_fround($8 * HEAPF32[$1 + 8 >> 2]));
		    HEAPF32[$10 + 12 >> 2] = -$8;
		    HEAPF32[$2 + $17 >> 2] = $8;
		    $7 = $7 + 4 | 0;
		    if (($18 | 0) > ($7 | 0)) {
		     continue;
		    }
		    break;
		   }
		  }
		  if (($3 | 0) > ($7 | 0)) {
		   $10 = ($4 | 0) < 1;
		   while (1) {
		    $1 = $7 << 2;
		    $8 = HEAPF32[$1 + $0 >> 2];
		    $6 = 0;
		    if (!$10) {
		     while (1) {
		      $8 = Math_fround($8 - Math_fround(HEAPF32[($6 << 2) + $13 >> 2] * HEAPF32[($6 + $7 << 2) + $11 >> 2]));
		      $6 = $6 + 1 | 0;
		      if (($6 | 0) != ($4 | 0)) {
		       continue;
		      }
		      break;
		     }
		    }
		    HEAPF32[($4 + $7 << 2) + $11 >> 2] = $8;
		    HEAPF32[$1 + $2 >> 2] = $8;
		    $7 = $7 + 1 | 0;
		    if (($7 | 0) != ($3 | 0)) {
		     continue;
		    }
		    break;
		   }
		  }
		  $6 = 0;
		  {
		   while (1) {
		    HEAP32[($6 << 2) + $5 >> 2] = HEAP32[(($6 ^ -1) + $3 << 2) + $2 >> 2];
		    $6 = $6 + 1 | 0;
		    if (($6 | 0) != ($4 | 0)) {
		     continue;
		    }
		    break;
		   }
		  }
		  __stack_pointer = $9 + 16 | 0;
		  return;
		 }
		}
		function silk_PLC($0, $1, $2, $3, $4) {
		 var $5 = 0, $6 = 0, $7 = 0, $8 = 0, $9 = 0, $10 = 0, $11 = 0;
		 $7 = HEAP32[$0 + 2316 >> 2];
		 if (($7 | 0) != HEAP32[$0 + 4252 >> 2]) {
		  HEAP32[$0 + 4252 >> 2] = $7;
		  $6 = $0 + 4244 | 0;
		  HEAP32[$6 >> 2] = 65536;
		  HEAP32[$6 + 4 >> 2] = 65536;
		  $6 = $0 + 4256 | 0;
		  HEAP32[$6 >> 2] = 2;
		  HEAP32[$6 + 4 >> 2] = 20;
		  HEAP32[$0 + 4172 >> 2] = HEAP32[$0 + 2328 >> 2] << 7;
		 }
		 if ($3) {
		  silk_PLC_conceal($0, $1, $2, $4);
		  HEAP32[$0 + 4160 >> 2] = HEAP32[$0 + 4160 >> 2] + 1;
		  return;
		 }
		 $3 = HEAP8[$0 + 2765 | 0];
		 HEAP32[$0 + 4164 >> 2] = $3;
		 label$3 : {
		  if (($3 | 0) == 2) {
		   $2 = HEAP32[$0 + 2324 >> 2];
		   label$5 : {
		    if (!$2) {
		     break label$5;
		    }
		    $8 = (($2 << 2) + $1 | 0) - 4 | 0;
		    $6 = HEAP32[$8 >> 2];
		    if (($6 | 0) < 1) {
		     break label$5;
		    }
		    $9 = $0 + 4176 | 0;
		    $11 = HEAP32[$0 + 2332 >> 2];
		    $7 = 0;
		    while (1) {
		     $4 = ($7 ^ -1) + $2 | 0;
		     $3 = Math_imul($4, 10) + $1 | 0;
		     $3 = (((HEAP16[$3 + 98 >> 1] + HEAP16[$3 + 96 >> 1] | 0) + HEAP16[$3 + 100 >> 1] | 0) + HEAP16[$3 + 102 >> 1] | 0) + HEAP16[$3 + 104 >> 1] | 0;
		     if (($5 | 0) < ($3 | 0)) {
		      $5 = Math_imul($4 << 16 >> 16, 10) + $1 | 0;
		      HEAP16[$9 + 8 >> 1] = HEAPU16[$5 + 104 >> 1];
		      $6 = HEAPU16[$5 + 100 >> 1] | HEAPU16[$5 + 102 >> 1] << 16;
		      $5 = HEAPU16[$5 + 96 >> 1] | HEAPU16[$5 + 98 >> 1] << 16;
		      $10 = $5;
		      $5 = $9;
		      HEAP16[$5 >> 1] = $10;
		      HEAP16[$5 + 2 >> 1] = $10 >>> 16;
		      HEAP16[$5 + 4 >> 1] = $6;
		      HEAP16[$5 + 6 >> 1] = $6 >>> 16;
		      HEAP32[$0 + 4172 >> 2] = HEAP32[($4 << 2) + $1 >> 2] << 8;
		      $6 = HEAP32[$8 >> 2];
		      $5 = $3;
		     }
		     $7 = $7 + 1 | 0;
		     if (($7 | 0) == ($2 | 0)) {
		      break label$5;
		     }
		     if ((Math_imul($7, $11) | 0) < ($6 | 0)) {
		      continue;
		     }
		     break;
		    }
		   }
		   $3 = $0 + 4176 | 0;
		   HEAP32[$3 >> 2] = 0;
		   HEAP32[$3 + 4 >> 2] = 0;
		   HEAP16[$0 + 4184 >> 1] = 0;
		   HEAP16[$0 + 4180 >> 1] = $5;
		   if (($5 | 0) <= 11468) {
		    $4 = $0 + 4182 | 0;
		    HEAP16[$4 >> 1] = 0;
		    HEAP16[$4 + 2 >> 1] = 0;
		    HEAP16[$3 >> 1] = 0;
		    HEAP16[$3 + 2 >> 1] = 0;
		    HEAP16[$0 + 4180 >> 1] = Math_imul(11744256 / ((($5 | 0) > 1 ? $5 : 1) >>> 0) << 16 >> 16, $5 << 16 >> 16) >>> 10;
		    break label$3;
		   }
		   if (($5 | 0) < 15566) {
		    break label$3;
		   }
		   $3 = $0 + 4182 | 0;
		   HEAP16[$3 >> 1] = 0;
		   HEAP16[$3 + 2 >> 1] = 0;
		   $3 = $0 + 4176 | 0;
		   HEAP16[$3 >> 1] = 0;
		   HEAP16[$3 + 2 >> 1] = 0;
		   HEAP16[$0 + 4180 >> 1] = Math_imul(255016960 / ($5 >>> 0) | 0, $5 << 16 >> 16) >>> 14;
		   break label$3;
		  }
		  $5 = $0 + 4176 | 0;
		  HEAP32[$5 >> 2] = 0;
		  HEAP32[$5 + 4 >> 2] = 0;
		  HEAP16[$0 + 4184 >> 1] = 0;
		  HEAP32[$0 + 4172 >> 2] = Math_imul($7 << 16 >> 16, 4608);
		  $2 = HEAP32[$0 + 2324 >> 2];
		 }
		 memcpy($0 + 4186 | 0, $1 - -64 | 0, HEAP32[$0 + 2340 >> 2] << 1);
		 HEAP16[$0 + 4240 >> 1] = HEAP32[$1 + 136 >> 2];
		 $5 = ($2 << 2) + $1 | 0;
		 $6 = HEAP32[$5 + 8 >> 2];
		 $5 = HEAP32[$5 + 12 >> 2];
		 $1 = $6;
		 $6 = $0 + 4244 | 0;
		 HEAP32[$6 >> 2] = $1;
		 HEAP32[$6 + 4 >> 2] = $5;
		 HEAP32[$0 + 4260 >> 2] = HEAP32[$0 + 2332 >> 2];
		 HEAP32[$0 + 4256 >> 2] = $2;
		}
		function decode_pulses($0, $1, $2, $3) {
		 var $4 = 0, $5 = 0, $6 = Math_fround(0), $7 = 0, $8 = Math_fround(0), $9 = 0, $10 = 0, $11 = 0;
		 $4 = $2 + 1 | 0;
		 $5 = ($1 | 0) > ($2 | 0);
		 $5 = ec_dec_uint($3, HEAP32[HEAP32[(($5 ? $4 : $1) << 2) + 27984 >> 2] + ((($1 | 0) > ($4 | 0) ? $1 : $4) << 2) >> 2] + HEAP32[HEAP32[((($1 | 0) < ($2 | 0) ? $1 : $2) << 2) + 27984 >> 2] + (($5 ? $1 : $2) << 2) >> 2] | 0);
		 label$1 : {
		  if (($2 | 0) > 0) {
		   if (($1 | 0) < 2) {
		    break label$1;
		   }
		   if (($1 | 0) != 2) {
		    while (1) {
		     $9 = $1;
		     label$5 : {
		      if (($1 | 0) <= ($2 | 0)) {
		       $3 = $2;
		       $7 = $9 << 2;
		       $10 = HEAP32[$7 + 27984 >> 2];
		       $4 = HEAP32[($10 + ($2 << 2) | 0) + 4 >> 2];
		       $11 = $5 >>> 0 >= $4 >>> 0 ? -1 : 0;
		       $4 = $5 - ($4 & $11) | 0;
		       label$7 : {
		        if ($4 >>> 0 < HEAPU32[$7 + $10 >> 2]) {
		         while (1) {
		          $1 = $1 - 1 | 0;
		          $5 = HEAP32[HEAP32[($1 << 2) + 27984 >> 2] + $7 >> 2];
		          if ($5 >>> 0 > $4 >>> 0) {
		           continue;
		          }
		          break label$7;
		         }
		        }
		        while (1) {
		         $1 = $3;
		         $3 = $1 - 1 | 0;
		         $5 = HEAP32[($1 << 2) + $10 >> 2];
		         if ($5 >>> 0 > $4 >>> 0) {
		          continue;
		         }
		         break;
		        }
		       }
		       $3 = (($2 + $11 | 0) - $1 ^ $11) << 16 >> 16;
		       HEAP32[$0 >> 2] = $3;
		       $6 = Math_fround($3 | 0);
		       $8 = Math_fround($8 + Math_fround($6 * $6));
		       $2 = $1;
		       $5 = $4 - $5 | 0;
		       break label$5;
		      }
		      $4 = $9 << 2;
		      $3 = $2 << 2;
		      $1 = HEAP32[$4 + HEAP32[$3 + 27988 >> 2] >> 2];
		      $3 = HEAP32[HEAP32[$3 + 27984 >> 2] + $4 >> 2];
		      if (!($5 >>> 0 < $3 >>> 0 | $1 >>> 0 <= $5 >>> 0)) {
		       HEAP32[$0 >> 2] = 0;
		       $5 = $5 - $3 | 0;
		       break label$5;
		      }
		      $7 = $1 >>> 0 <= $5 >>> 0 ? -1 : 0;
		      $3 = $5 - ($7 & $1) | 0;
		      $1 = $2;
		      while (1) {
		       $1 = $1 - 1 | 0;
		       $5 = HEAP32[HEAP32[($1 << 2) + 27984 >> 2] + $4 >> 2];
		       if ($5 >>> 0 > $3 >>> 0) {
		        continue;
		       }
		       break;
		      }
		      $4 = (($2 + $7 | 0) - $1 ^ $7) << 16 >> 16;
		      HEAP32[$0 >> 2] = $4;
		      $6 = Math_fround($4 | 0);
		      $8 = Math_fround($8 + Math_fround($6 * $6));
		      $2 = $1;
		      $5 = $3 - $5 | 0;
		     }
		     $1 = $9 - 1 | 0;
		     $0 = $0 + 4 | 0;
		     if (($9 | 0) > 3) {
		      continue;
		     }
		     break;
		    }
		   }
		   $1 = $2 << 1 | 1;
		   $4 = $5 >>> 0 >= $1 >>> 0;
		   $2 = $2 - $4 | 0;
		   $4 = $4 ? -1 : 0;
		   $3 = $5 - ($4 & $1) | 0;
		   $5 = $3 + 1 | 0;
		   $1 = $5 >>> 1 | 0;
		   $4 = ($2 - $1 ^ $4) << 16 >> 16;
		   HEAP32[$0 >> 2] = $4;
		   $3 = $3 - ($1 ? ($5 & -2) - 1 | 0 : 0) | 0;
		   $1 = ($1 - $3 ^ 0 - $3) << 16 >> 16;
		   HEAP32[$0 + 4 >> 2] = $1;
		   $6 = Math_fround($4 | 0);
		   $6 = Math_fround($8 + Math_fround($6 * $6));
		   $8 = Math_fround($1 | 0);
		   return Math_fround($6 + Math_fround($8 * $8));
		  }
		  celt_fatal(27936, 27959, 469);
		  abort();
		 }
		 celt_fatal(33168, 27959, 470);
		 abort();
		}
		function resampler_basic_interpolate_single($0, $1, $2, $3, $4, $5) {
		 $0 = $0 | 0;
		 $1 = $1 | 0;
		 $2 = $2 | 0;
		 $3 = $3 | 0;
		 $4 = $4 | 0;
		 $5 = $5 | 0;
		 var $6 = Math_fround(0), $7 = Math_fround(0), $8 = Math_fround(0), $9 = 0, $10 = 0, $11 = 0, $12 = 0, $13 = Math_fround(0), $14 = Math_fround(0), $15 = Math_fround(0), $16 = 0, $17 = 0, $18 = 0, $19 = 0, $20 = 0, $21 = Math_fround(0), $22 = Math_fround(0), $23 = 0, $24 = 0, $25 = 0, $26 = Math_fround(0), $27 = 0, $28 = 0, $29 = 0, $30 = 0, $31 = Math_fround(0);
		 $1 = $1 << 2;
		 $16 = $1 + HEAP32[$0 + 64 >> 2] | 0;
		 $12 = HEAP32[$16 >> 2];
		 $17 = HEAP32[$0 + 60 >> 2] + $1 | 0;
		 $9 = HEAP32[$17 >> 2];
		 $18 = HEAP32[$3 >> 2];
		 label$1 : {
		  if (($9 | 0) >= ($18 | 0)) {
		   break label$1;
		  }
		  $23 = HEAP32[$0 + 40 >> 2];
		  $24 = HEAP32[$0 + 36 >> 2];
		  $25 = HEAP32[$0 + 92 >> 2];
		  $3 = HEAP32[$5 >> 2];
		  $19 = ($3 | 0) > 0 ? $3 : 0;
		  $10 = HEAP32[$0 + 12 >> 2];
		  $26 = Math_fround($10 >>> 0);
		  $20 = HEAP32[$0 + 24 >> 2];
		  $27 = ($20 | 0) < 1;
		  while (1) {
		   if (($11 | 0) == ($19 | 0)) {
		    $11 = $19;
		    break label$1;
		   }
		   $5 = HEAP32[$0 + 48 >> 2];
		   $3 = Math_imul($12, $5);
		   $1 = $3;
		   $3 = ($3 >>> 0) / ($10 >>> 0) | 0;
		   $7 = Math_fround(Math_fround($1 - Math_imul($10, $3) >>> 0) / $26);
		   label$4 : {
		    if ($27) {
		     $8 = Math_fround(0);
		     $13 = Math_fround(0);
		     $14 = Math_fround(0);
		     $15 = Math_fround(0);
		     break label$4;
		    }
		    $28 = ($9 << 2) + $2 | 0;
		    $29 = 4 - $3 | 0;
		    $30 = HEAP32[$0 + 76 >> 2];
		    $3 = 0;
		    $15 = Math_fround(0);
		    $14 = Math_fround(0);
		    $13 = Math_fround(0);
		    $8 = Math_fround(0);
		    while (1) {
		     $6 = HEAPF32[($3 << 2) + $28 >> 2];
		     $3 = $3 + 1 | 0;
		     $1 = (Math_imul($5, $3) + $29 << 2) + $30 | 0;
		     $14 = Math_fround($14 + Math_fround($6 * HEAPF32[$1 >> 2]));
		     $15 = Math_fround($15 + Math_fround($6 * HEAPF32[$1 + 4 >> 2]));
		     $13 = Math_fround($13 + Math_fround($6 * HEAPF32[$1 - 4 >> 2]));
		     $8 = Math_fround($8 + Math_fround($6 * HEAPF32[$1 - 8 >> 2]));
		     if (($3 | 0) != ($20 | 0)) {
		      continue;
		     }
		     break;
		    }
		   }
		   $6 = Math_fround($7 * Math_fround(.16666999459266663));
		   $21 = Math_fround($7 * Math_fround($7 * $6));
		   $22 = Math_fround($21 - $6);
		   $31 = Math_fround($22 * $8);
		   $6 = Math_fround($7 * Math_fround($7 * Math_fround(.5)));
		   $8 = Math_fround(Math_fround($7 + $6) - Math_fround($7 * $6));
		   $6 = Math_fround(Math_fround($6 + Math_fround($7 * Math_fround(-0.3333300054073334))) - $21);
		   HEAPF32[(Math_imul($11, $25) << 2) + $4 >> 2] = Math_fround(Math_fround($31 + Math_fround($8 * $13)) + Math_fround($14 * Math_fround(1 - +$22 - +$8 - +$6))) + Math_fround($6 * $15);
		   $3 = $12 + $23 | 0;
		   $12 = $3 - ($3 >>> 0 < $10 >>> 0 ? 0 : $10) | 0;
		   $11 = $11 + 1 | 0;
		   $9 = ($9 + $24 | 0) + ($3 >>> 0 >= $10 >>> 0) | 0;
		   if (($18 | 0) > ($9 | 0)) {
		    continue;
		   }
		   break;
		  }
		 }
		 HEAP32[$17 >> 2] = $9;
		 HEAP32[$16 >> 2] = $12;
		 return $11 | 0;
		}
		function celt_synthesis($0, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) {
		 var $13 = 0, $14 = 0, $15 = 0, $16 = 0, $17 = 0, $18 = 0, $19 = 0, $20 = 0, $21 = 0, $22 = 0;
		 $13 = __stack_pointer;
		 $21 = $13;
		 $20 = HEAP32[$0 + 8 >> 2];
		 $17 = HEAP32[$0 + 4 >> 2];
		 $14 = HEAP32[$0 + 44 >> 2];
		 $16 = $14 << $9;
		 $15 = $13 - (($16 << 2) + 15 & -16) | 0;
		 __stack_pointer = $15;
		 $19 = HEAP32[$0 + 36 >> 2] - ($8 ? 0 : $9) | 0;
		 $18 = 1 << $9;
		 $13 = $8 ? $18 : 1;
		 $8 = $8 ? $14 : $16;
		 label$1 : {
		  if (!(($6 | 0) != 1 | ($7 | 0) != 2)) {
		   denormalise_bands($0, $1, $15, $3, $4, $5, $18, $10, $11);
		   $7 = memcpy(HEAP32[$2 + 4 >> 2] + (($17 | 0) / 2 << 2) | 0, $15, $16 << 2);
		   if (($13 | 0) < 1) {
		    break label$1;
		   }
		   $6 = $0 - -64 | 0;
		   $9 = 0;
		   while (1) {
		    clt_mdct_backward_c($6, ($9 << 2) + $7 | 0, HEAP32[$2 >> 2] + (Math_imul($8, $9) << 2) | 0, HEAP32[$0 + 60 >> 2], $17, $19, $13, $12);
		    $9 = $9 + 1 | 0;
		    if (($13 | 0) != ($9 | 0)) {
		     continue;
		    }
		    break;
		   }
		   if (($13 | 0) < 1) {
		    break label$1;
		   }
		   $7 = $0 - -64 | 0;
		   $9 = 0;
		   while (1) {
		    clt_mdct_backward_c($7, ($9 << 2) + $15 | 0, HEAP32[$2 + 4 >> 2] + (Math_imul($8, $9) << 2) | 0, HEAP32[$0 + 60 >> 2], $17, $19, $13, $12);
		    $9 = $9 + 1 | 0;
		    if (($13 | 0) != ($9 | 0)) {
		     continue;
		    }
		    break;
		   }
		   break label$1;
		  }
		  if (!(($7 | 0) == 1 ? ($6 | 0) == 2 : 0)) {
		   $22 = ($7 | 0) > 1 ? $7 : 1;
		   $6 = $0 - -64 | 0;
		   $14 = 0;
		   while (1) {
		    denormalise_bands($0, (Math_imul($14, $16) << 2) + $1 | 0, $15, (Math_imul($14, $20) << 2) + $3 | 0, $4, $5, $18, $10, $11);
		    if (($13 | 0) >= 1) {
		     $7 = ($14 << 2) + $2 | 0;
		     $9 = 0;
		     while (1) {
		      clt_mdct_backward_c($6, ($9 << 2) + $15 | 0, HEAP32[$7 >> 2] + (Math_imul($8, $9) << 2) | 0, HEAP32[$0 + 60 >> 2], $17, $19, $13, $12);
		      $9 = $9 + 1 | 0;
		      if (($13 | 0) != ($9 | 0)) {
		       continue;
		      }
		      break;
		     }
		    }
		    $14 = $14 + 1 | 0;
		    if (($22 | 0) != ($14 | 0)) {
		     continue;
		    }
		    break;
		   }
		   break label$1;
		  }
		  $9 = HEAP32[$2 >> 2];
		  denormalise_bands($0, $1, $15, $3, $4, $5, $18, $10, $11);
		  $14 = (($17 | 0) / 2 << 2) + $9 | 0;
		  denormalise_bands($0, ($16 << 2) + $1 | 0, $14, ($20 << 2) + $3 | 0, $4, $5, $18, $10, $11);
		  $9 = 0;
		  if (($16 | 0) > 0) {
		   while (1) {
		    $7 = $9 << 2;
		    $6 = $15 + $7 | 0;
		    HEAPF32[$6 >> 2] = Math_fround(HEAPF32[$6 >> 2] * Math_fround(.5)) + Math_fround(HEAPF32[$7 + $14 >> 2] * Math_fround(.5));
		    $9 = $9 + 1 | 0;
		    if (($16 | 0) != ($9 | 0)) {
		     continue;
		    }
		    break;
		   }
		  }
		  if (($13 | 0) < 1) {
		   break label$1;
		  }
		  $7 = $0 - -64 | 0;
		  $9 = 0;
		  while (1) {
		   clt_mdct_backward_c($7, ($9 << 2) + $15 | 0, HEAP32[$2 >> 2] + (Math_imul($8, $9) << 2) | 0, HEAP32[$0 + 60 >> 2], $17, $19, $13, $12);
		   $9 = $9 + 1 | 0;
		   if (($13 | 0) != ($9 | 0)) {
		    continue;
		   }
		   break;
		  }
		 }
		 __stack_pointer = $21;
		}
		function silk_stereo_MS_to_LR($0, $1, $2, $3, $4, $5) {
		 var $6 = 0, $7 = 0, $8 = 0, $9 = 0, $10 = 0, $11 = 0, $12 = 0, $13 = 0, $14 = 0, $15 = 0, $16 = 0, $17 = 0;
		 $6 = HEAPU16[$0 + 4 >> 1] | HEAPU16[$0 + 6 >> 1] << 16;
		 HEAP16[$1 >> 1] = $6;
		 HEAP16[$1 + 2 >> 1] = $6 >>> 16;
		 $6 = HEAPU16[$0 + 8 >> 1] | HEAPU16[$0 + 10 >> 1] << 16;
		 HEAP16[$2 >> 1] = $6;
		 HEAP16[$2 + 2 >> 1] = $6 >>> 16;
		 $9 = $5 << 1;
		 $6 = $9 + $1 | 0;
		 $6 = HEAPU16[$6 >> 1] | HEAPU16[$6 + 2 >> 1] << 16;
		 HEAP16[$0 + 4 >> 1] = $6;
		 HEAP16[$0 + 6 >> 1] = $6 >>> 16;
		 $6 = $2 + $9 | 0;
		 $6 = HEAPU16[$6 >> 1] | HEAPU16[$6 + 2 >> 1] << 16;
		 HEAP16[$0 + 8 >> 1] = $6;
		 HEAP16[$0 + 10 >> 1] = $6 >>> 16;
		 $9 = $4 << 3;
		 $7 = 65536 / ($9 | 0) | 0;
		 $11 = HEAP32[$3 + 4 >> 2];
		 $12 = HEAP32[$3 >> 2];
		 if (($4 | 0) >= 1) {
		  $3 = $7 << 16 >> 16;
		  $8 = HEAP16[$0 + 2 >> 1];
		  $13 = (Math_imul($3, $11 - $8 << 16 >> 16) >> 15) + 1 >> 1;
		  $10 = HEAP16[$0 >> 1];
		  $14 = (Math_imul($12 - $10 << 16 >> 16, $3) >> 15) + 1 >> 1;
		  $15 = ($9 | 0) > 1 ? $9 : 1;
		  $3 = 0;
		  while (1) {
		   $4 = $3 + 1 | 0;
		   $7 = $4 << 1;
		   $6 = $7 + $2 | 0;
		   $16 = $6;
		   $17 = HEAP16[$6 >> 1] << 8;
		   $8 = $8 + $13 | 0;
		   $6 = $8 << 16 >> 16;
		   $7 = HEAP16[$1 + $7 >> 1];
		   $6 = ($17 + Math_imul($6, $7 >> 5) | 0) + (Math_imul($7 << 11 & 63488, $6) >> 16) | 0;
		   $3 = ($3 << 1) + $1 | 0;
		   $3 = (HEAP16[$3 + 4 >> 1] + HEAP16[$3 >> 1] | 0) + ($7 << 1) | 0;
		   $10 = $10 + $14 | 0;
		   $7 = $10 << 16 >> 16;
		   $3 = (Math_imul($7, $3 >> 7) + $6 | 0) + (Math_imul($3 << 9 & 65024, $7) >> 16) | 0;
		   $7 = ($3 >> 7) + 1 >> 1;
		   HEAP16[$16 >> 1] = ($3 | 0) > 8388479 ? 32767 : ($7 | 0) > -32768 ? $7 : -32768;
		   $3 = $4;
		   if (($15 | 0) != ($3 | 0)) {
		    continue;
		   }
		   break;
		  }
		 }
		 if (($5 | 0) > ($9 | 0)) {
		  $4 = $11 << 16 >> 16;
		  $7 = $12 << 16 >> 16;
		  while (1) {
		   $8 = $9 << 1;
		   $9 = $9 + 1 | 0;
		   $3 = $9 << 1;
		   $10 = $3 + $2 | 0;
		   $3 = HEAP16[$1 + $3 >> 1];
		   $6 = (Math_imul($3 >> 5, $4) + (HEAP16[$10 >> 1] << 8) | 0) + (Math_imul($3 << 11 & 63488, $4) >> 16) | 0;
		   $8 = $1 + $8 | 0;
		   $3 = (HEAP16[$8 + 4 >> 1] + HEAP16[$8 >> 1] | 0) + ($3 << 1) | 0;
		   $3 = ($6 + Math_imul($3 >> 7, $7) | 0) + (Math_imul($3 << 9 & 65024, $7) >> 16) | 0;
		   $8 = ($3 >> 7) + 1 >> 1;
		   HEAP16[$10 >> 1] = ($3 | 0) > 8388479 ? 32767 : ($8 | 0) > -32768 ? $8 : -32768;
		   if (($5 | 0) != ($9 | 0)) {
		    continue;
		   }
		   break;
		  }
		 }
		 HEAP16[$0 + 2 >> 1] = $11;
		 HEAP16[$0 >> 1] = $12;
		 if (($5 | 0) >= 1) {
		  $9 = 0;
		  while (1) {
		   $9 = $9 + 1 | 0;
		   $3 = $9 << 1;
		   $4 = $3 + $1 | 0;
		   $0 = $4;
		   $4 = HEAP16[$4 >> 1];
		   $3 = $2 + $3 | 0;
		   $7 = HEAP16[$3 >> 1];
		   $8 = $4 + $7 | 0;
		   $8 = ($8 | 0) < 32767 ? $8 : 32767;
		   HEAP16[$0 >> 1] = ($8 | 0) > -32768 ? $8 : -32768;
		   $4 = $4 - $7 | 0;
		   $4 = ($4 | 0) < 32767 ? $4 : 32767;
		   HEAP16[$3 >> 1] = ($4 | 0) > -32768 ? $4 : -32768;
		   if (($5 | 0) != ($9 | 0)) {
		    continue;
		   }
		   break;
		  }
		 }
		}
		function anti_collapse($0, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) {
		 var $14 = 0, $15 = Math_fround(0), $16 = 0, $17 = Math_fround(0), $18 = 0, $19 = 0, $20 = Math_fround(0), $21 = 0, $22 = 0, $23 = 0, $24 = 0, $25 = Math_fround(0), $26 = 0, $27 = 0, $28 = 0, $29 = 0, $30 = 0, $31 = Math_fround(0), $32 = 0, $33 = Math_fround(0), $34 = 0, $35 = 0;
		 if (($6 | 0) < ($7 | 0)) {
		  $14 = 1 << $3;
		  $27 = ($14 | 0) > 1 ? $14 : 1;
		  $28 = ($4 | 0) > 1 ? $4 : 1;
		  $29 = ($3 | 0) == 3;
		  $30 = ($3 | 0) == 31;
		  while (1) {
		   $14 = HEAP32[$0 + 32 >> 2];
		   $18 = $6;
		   $6 = $18 + 1 | 0;
		   $23 = $18 << 1;
		   $21 = HEAP16[$14 + ($6 << 1) >> 1] - HEAP16[$23 + $14 >> 1] | 0;
		   $24 = $21 << $3;
		   $31 = Math_fround(Math_fround(1) / Math_fround(Math_sqrt(+($24 | 0))));
		   $25 = Math_fround(Math_fround(exp(+Math_fround(Math_fround((HEAP32[($18 << 2) + $11 >> 2] + 1 >>> 0) / ($21 >>> 0) >>> $3 | 0) * Math_fround(-0.125)) * .6931471805599453)) * Math_fround(.5));
		   $32 = Math_imul($4, $18);
		   $19 = 0;
		   while (1) {
		    $16 = HEAP32[$0 + 8 >> 2];
		    $14 = Math_imul($19, $16) + $18 << 2;
		    $15 = HEAPF32[$14 + $10 >> 2];
		    $17 = HEAPF32[$9 + $14 >> 2];
		    $33 = HEAPF32[$8 + $14 >> 2];
		    if (($4 | 0) == 1) {
		     $16 = $16 + $18 << 2;
		     $20 = HEAPF32[$16 + $10 >> 2];
		     $15 = $15 > $20 ? $15 : $20;
		     $20 = HEAPF32[$9 + $16 >> 2];
		     $17 = $17 > $20 ? $17 : $20;
		    }
		    $34 = exp(+Math_fround(Math_max(Math_fround($33 - ($15 > $17 ? $17 : $15)), Math_fround(0))) * -0.6931471805599453);
		    label$6 : {
		     if ($30) {
		      break label$6;
		     }
		     $26 = ((Math_imul($5, $19) << 2) + $1 | 0) + (HEAP16[HEAP32[$0 + 32 >> 2] + $23 >> 1] << $3 << 2) | 0;
		     $35 = ($19 + $32 | 0) + $2 | 0;
		     $15 = Math_fround($34);
		     $15 = Math_fround($15 + $15);
		     $15 = $29 ? Math_fround($15 * Math_fround(1.4142135381698608)) : $15;
		     $15 = Math_fround($31 * ($15 > $25 ? $25 : $15));
		     $17 = Math_fround(-$15);
		     $22 = 0;
		     $16 = 0;
		     while (1) {
		      $14 = HEAPU8[$35 | 0] >>> $16 & 1;
		      $22 = $14 ? $22 : 1;
		      label$8 : {
		       if ($14) {
		        break label$8;
		       }
		       $14 = 0;
		       if (($21 | 0) < 1) {
		        break label$8;
		       }
		       while (1) {
		        $12 = Math_imul($12, 1664525) + 1013904223 | 0;
		        HEAPF32[(($14 << $3) + $16 << 2) + $26 >> 2] = $12 & 32768 ? $15 : $17;
		        $22 = 1;
		        $14 = $14 + 1 | 0;
		        if (($21 | 0) != ($14 | 0)) {
		         continue;
		        }
		        break;
		       }
		      }
		      $16 = $16 + 1 | 0;
		      if (($27 | 0) != ($16 | 0)) {
		       continue;
		      }
		      break;
		     }
		     if (!$22) {
		      break label$6;
		     }
		     renormalise_vector($26, $24, Math_fround(1));
		    }
		    $19 = $19 + 1 | 0;
		    if (($28 | 0) != ($19 | 0)) {
		     continue;
		    }
		    break;
		   }
		   if (($6 | 0) != ($7 | 0)) {
		    continue;
		   }
		   break;
		  }
		 }
		}
		function deemphasis($0, $1, $2, $3, $4, $5, $6, $7) {
		 var $8 = Math_fround(0), $9 = Math_fround(0), $10 = 0, $11 = 0, $12 = 0, $13 = 0, $14 = 0, $15 = Math_fround(0), $16 = 0, $17 = 0, $18 = Math_fround(0), $19 = 0;
		 $10 = __stack_pointer;
		 $14 = $10;
		 if (!($7 | (($3 | 0) != 2 | ($4 | 0) != 1))) {
		  $8 = HEAPF32[$6 + 4 >> 2];
		  $9 = HEAPF32[$6 >> 2];
		  if (($2 | 0) >= 1) {
		   $11 = HEAP32[$0 + 4 >> 2];
		   $12 = HEAP32[$0 >> 2];
		   $15 = HEAPF32[$5 >> 2];
		   $7 = 0;
		   while (1) {
		    $10 = $7 << 2;
		    $18 = HEAPF32[$11 + $10 >> 2];
		    $3 = $7 << 3;
		    $9 = Math_fround($9 + Math_fround(HEAPF32[$10 + $12 >> 2] + Math_fround(1.0000000031710769e-30)));
		    HEAPF32[$3 + $1 >> 2] = $9 * Math_fround(30517578125e-15);
		    $8 = Math_fround($8 + Math_fround($18 + Math_fround(1.0000000031710769e-30)));
		    HEAPF32[($3 | 4) + $1 >> 2] = $8 * Math_fround(30517578125e-15);
		    $8 = Math_fround($15 * $8);
		    $9 = Math_fround($15 * $9);
		    $7 = $7 + 1 | 0;
		    if (($7 | 0) != ($2 | 0)) {
		     continue;
		    }
		    break;
		   }
		  }
		  HEAPF32[$6 + 4 >> 2] = $8;
		  HEAPF32[$6 >> 2] = $9;
		  __stack_pointer = $14;
		  return;
		 }
		 if (!$7) {
		  $19 = ($3 | 0) > 1 ? $3 : 1;
		  $16 = ($2 | 0) / ($4 | 0) | 0;
		  $11 = $10 - (($2 << 2) + 15 & -16) | 0;
		  __stack_pointer = $11;
		  $9 = HEAPF32[$5 >> 2];
		  $5 = 0;
		  while (1) {
		   $7 = $13 << 2;
		   $10 = $7 + $1 | 0;
		   $12 = HEAP32[$0 + $7 >> 2];
		   $17 = $6 + $7 | 0;
		   $8 = HEAPF32[$17 >> 2];
		   label$6 : {
		    if (($4 | 0) <= 1) {
		     $7 = 0;
		     if (($2 | 0) <= 0) {
		      break label$6;
		     }
		     while (1) {
		      $8 = Math_fround($8 + Math_fround(HEAPF32[($7 << 2) + $12 >> 2] + Math_fround(1.0000000031710769e-30)));
		      HEAPF32[(Math_imul($3, $7) << 2) + $10 >> 2] = $8 * Math_fround(30517578125e-15);
		      $8 = Math_fround($9 * $8);
		      $7 = $7 + 1 | 0;
		      if (($7 | 0) != ($2 | 0)) {
		       continue;
		      }
		      break;
		     }
		     break label$6;
		    }
		    $5 = 1;
		    $7 = 0;
		    if (($2 | 0) < 1) {
		     break label$6;
		    }
		    while (1) {
		     $5 = $7 << 2;
		     $8 = Math_fround($8 + Math_fround(HEAPF32[$12 + $5 >> 2] + Math_fround(1.0000000031710769e-30)));
		     HEAPF32[$5 + $11 >> 2] = $8;
		     $8 = Math_fround($9 * $8);
		     $5 = 1;
		     $7 = $7 + 1 | 0;
		     if (($7 | 0) != ($2 | 0)) {
		      continue;
		     }
		     break;
		    }
		   }
		   HEAPF32[$17 >> 2] = $8;
		   label$10 : {
		    if (!$5) {
		     break label$10;
		    }
		    $7 = 0;
		    if (($16 | 0) < 1) {
		     break label$10;
		    }
		    while (1) {
		     HEAPF32[(Math_imul($3, $7) << 2) + $10 >> 2] = HEAPF32[(Math_imul($4, $7) << 2) + $11 >> 2] * Math_fround(30517578125e-15);
		     $7 = $7 + 1 | 0;
		     if (($16 | 0) != ($7 | 0)) {
		      continue;
		     }
		     break;
		    }
		   }
		   $13 = $13 + 1 | 0;
		   if (($19 | 0) != ($13 | 0)) {
		    continue;
		   }
		   break;
		  }
		  __stack_pointer = $14;
		  return;
		 }
		 celt_fatal(35264, 34183, 279);
		 abort();
		}
		function clt_mdct_backward_c($0, $1, $2, $3, $4, $5, $6, $7) {
		 var $8 = 0, $9 = 0, $10 = Math_fround(0), $11 = Math_fround(0), $12 = Math_fround(0), $13 = Math_fround(0), $14 = 0, $15 = 0, $16 = 0, $17 = 0, $18 = 0, $19 = Math_fround(0), $20 = Math_fround(0), $21 = 0, $22 = 0;
		 $7 = HEAP32[$0 >> 2];
		 $14 = $7 >> 1;
		 $9 = HEAP32[$0 + 24 >> 2];
		 if (($5 | 0) >= 1) {
		  while (1) {
		   $7 = $14;
		   $14 = $7 >> 1;
		   $9 = ($7 << 2) + $9 | 0;
		   $8 = $8 + 1 | 0;
		   if (($8 | 0) != ($5 | 0)) {
		    continue;
		   }
		   break;
		  }
		 }
		 $8 = ($4 << 1 & -4) + $2 | 0;
		 $17 = HEAP32[(($5 << 2) + $0 | 0) + 8 >> 2];
		 label$3 : {
		  if (($7 | 0) <= 3) {
		   opus_fft_impl($17, $8);
		   break label$3;
		  }
		  $15 = $7 >> 2;
		  $21 = ($15 | 0) > 1 ? $15 : 1;
		  $5 = 0;
		  $0 = (Math_imul($14 - 1 | 0, $6) << 2) + $1 | 0;
		  $16 = HEAP32[$17 + 44 >> 2];
		  $18 = $6 << 1;
		  $22 = 0 - $18 << 2;
		  while (1) {
		   $6 = HEAP16[$16 >> 1] << 3;
		   $12 = HEAPF32[$0 >> 2];
		   $13 = HEAPF32[($5 << 2) + $9 >> 2];
		   $10 = HEAPF32[$1 >> 2];
		   $11 = HEAPF32[($5 + $15 << 2) + $9 >> 2];
		   HEAPF32[($6 | 4) + $8 >> 2] = Math_fround($12 * $13) + Math_fround($10 * $11);
		   HEAPF32[$6 + $8 >> 2] = Math_fround($13 * $10) - Math_fround($12 * $11);
		   $16 = $16 + 2 | 0;
		   $0 = $0 + $22 | 0;
		   $1 = ($18 << 2) + $1 | 0;
		   $5 = $5 + 1 | 0;
		   if (($21 | 0) != ($5 | 0)) {
		    continue;
		   }
		   break;
		  }
		  opus_fft_impl($17, $8);
		  if (($7 | 0) < 4) {
		   break label$3;
		  }
		  $5 = $15 + 1 >> 1;
		  $16 = ($5 | 0) > 1 ? $5 : 1;
		  $1 = ($14 << 2) + $8 | 0;
		  $5 = 0;
		  while (1) {
		   $0 = $1 - 4 | 0;
		   $12 = HEAPF32[$0 >> 2];
		   $1 = $1 - 8 | 0;
		   $13 = HEAPF32[$1 >> 2];
		   $10 = HEAPF32[$8 + 4 >> 2];
		   $11 = HEAPF32[($5 << 2) + $9 >> 2];
		   $19 = HEAPF32[$8 >> 2];
		   $20 = HEAPF32[($5 + $15 << 2) + $9 >> 2];
		   HEAPF32[$8 >> 2] = Math_fround($10 * $11) + Math_fround($19 * $20);
		   HEAPF32[$0 >> 2] = Math_fround($10 * $20) - Math_fround($19 * $11);
		   $0 = $5 ^ -1;
		   $10 = HEAPF32[($15 + $0 << 2) + $9 >> 2];
		   $11 = HEAPF32[($0 + $14 << 2) + $9 >> 2];
		   HEAPF32[$1 >> 2] = Math_fround($12 * $10) + Math_fround($13 * $11);
		   HEAPF32[$8 + 4 >> 2] = Math_fround($12 * $11) - Math_fround($13 * $10);
		   $8 = $8 + 8 | 0;
		   $5 = $5 + 1 | 0;
		   if (($16 | 0) != ($5 | 0)) {
		    continue;
		   }
		   break;
		  }
		 }
		 $14 = ($4 | 0) / 2 | 0;
		 if (($4 | 0) >= 2) {
		  $8 = $4 << 2;
		  $9 = $8 + $2 | 0;
		  $8 = $3 + $8 | 0;
		  $5 = 0;
		  while (1) {
		   $12 = HEAPF32[$2 >> 2];
		   $8 = $8 - 4 | 0;
		   $13 = HEAPF32[$8 >> 2];
		   $9 = $9 - 4 | 0;
		   $10 = HEAPF32[$9 >> 2];
		   $11 = HEAPF32[$3 >> 2];
		   HEAPF32[$2 >> 2] = Math_fround($12 * $13) - Math_fround($10 * $11);
		   HEAPF32[$9 >> 2] = Math_fround($10 * $13) + Math_fround($12 * $11);
		   $3 = $3 + 4 | 0;
		   $2 = $2 + 4 | 0;
		   $5 = $5 + 1 | 0;
		   if (($14 | 0) != ($5 | 0)) {
		    continue;
		   }
		   break;
		  }
		 }
		}
		function resampler_basic_interpolate_double($0, $1, $2, $3, $4, $5) {
		 $0 = $0 | 0;
		 $1 = $1 | 0;
		 $2 = $2 | 0;
		 $3 = $3 | 0;
		 $4 = $4 | 0;
		 $5 = $5 | 0;
		 var $6 = Math_fround(0), $7 = 0, $8 = Math_fround(0), $9 = 0, $10 = 0, $11 = 0, $12 = 0, $13 = 0, $14 = 0, $15 = 0, $16 = 0, $17 = 0, $18 = 0, $19 = 0, $20 = 0, $21 = 0, $22 = Math_fround(0), $23 = 0, $24 = 0, $25 = 0, $26 = Math_fround(0), $27 = 0, $28 = 0, $29 = 0, $30 = 0, $31 = 0;
		 $1 = $1 << 2;
		 $17 = $1 + HEAP32[$0 + 64 >> 2] | 0;
		 $13 = HEAP32[$17 >> 2];
		 $18 = HEAP32[$0 + 60 >> 2] + $1 | 0;
		 $9 = HEAP32[$18 >> 2];
		 $19 = HEAP32[$3 >> 2];
		 label$1 : {
		  if (($9 | 0) >= ($19 | 0)) {
		   break label$1;
		  }
		  $23 = HEAP32[$0 + 40 >> 2];
		  $24 = HEAP32[$0 + 36 >> 2];
		  $25 = HEAP32[$0 + 92 >> 2];
		  $3 = HEAP32[$5 >> 2];
		  $20 = ($3 | 0) > 0 ? $3 : 0;
		  $10 = HEAP32[$0 + 12 >> 2];
		  $26 = Math_fround($10 >>> 0);
		  $21 = HEAP32[$0 + 24 >> 2];
		  $27 = ($21 | 0) < 1;
		  while (1) {
		   if (($12 | 0) == ($20 | 0)) {
		    $12 = $20;
		    break label$1;
		   }
		   $5 = HEAP32[$0 + 48 >> 2];
		   $3 = Math_imul($13, $5);
		   $1 = $3;
		   $3 = ($3 >>> 0) / ($10 >>> 0) | 0;
		   $8 = Math_fround(Math_fround($1 - Math_imul($10, $3) >>> 0) / $26);
		   label$4 : {
		    if ($27) {
		     $7 = 0;
		     $11 = 0;
		     $14 = 0;
		     $15 = 0;
		     break label$4;
		    }
		    $28 = ($9 << 2) + $2 | 0;
		    $29 = 4 - $3 | 0;
		    $30 = HEAP32[$0 + 76 >> 2];
		    $3 = 0;
		    $15 = 0;
		    $14 = 0;
		    $11 = 0;
		    $7 = 0;
		    while (1) {
		     $6 = HEAPF32[($3 << 2) + $28 >> 2];
		     $3 = $3 + 1 | 0;
		     $1 = (Math_imul($5, $3) + $29 << 2) + $30 | 0;
		     $14 = $14 + +Math_fround($6 * HEAPF32[$1 >> 2]);
		     $15 = $15 + +Math_fround($6 * HEAPF32[$1 + 4 >> 2]);
		     $11 = $11 + +Math_fround($6 * HEAPF32[$1 - 4 >> 2]);
		     $7 = $7 + +Math_fround($6 * HEAPF32[$1 - 8 >> 2]);
		     if (($3 | 0) != ($21 | 0)) {
		      continue;
		     }
		     break;
		    }
		   }
		   $6 = Math_fround($8 * Math_fround(.16666999459266663));
		   $22 = Math_fround($8 * Math_fround($8 * $6));
		   $16 = +Math_fround($22 - $6);
		   $31 = $7 * $16;
		   $6 = Math_fround($8 * Math_fround($8 * Math_fround(.5)));
		   $7 = +Math_fround(Math_fround($8 + $6) - Math_fround($8 * $6));
		   $11 = $31 + $11 * $7;
		   $16 = 1 - $16 - $7;
		   $7 = +Math_fround(Math_fround($6 + Math_fround($8 * Math_fround(-0.3333300054073334))) - $22);
		   HEAPF32[(Math_imul($12, $25) << 2) + $4 >> 2] = $11 + $14 * +Math_fround($16 - $7) + $15 * $7;
		   $3 = $13 + $23 | 0;
		   $13 = $3 - ($3 >>> 0 < $10 >>> 0 ? 0 : $10) | 0;
		   $12 = $12 + 1 | 0;
		   $9 = ($9 + $24 | 0) + ($3 >>> 0 >= $10 >>> 0) | 0;
		   if (($19 | 0) > ($9 | 0)) {
		    continue;
		   }
		   break;
		  }
		 }
		 HEAP32[$18 >> 2] = $9;
		 HEAP32[$17 >> 2] = $13;
		 return $12 | 0;
		}
		function stereo_itheta($0, $1, $2, $3, $4) {
		 var $5 = Math_fround(0), $6 = Math_fround(0), $7 = Math_fround(0), $8 = Math_fround(0), $9 = Math_fround(0);
		 label$1 : {
		  if ($2) {
		   $6 = Math_fround(1.0000000036274937e-15);
		   if (($3 | 0) < 1) {
		    $5 = Math_fround(1.0000000036274937e-15);
		    break label$1;
		   }
		   $2 = 0;
		   $5 = Math_fround(1.0000000036274937e-15);
		   while (1) {
		    $4 = $2 << 2;
		    $7 = HEAPF32[$4 + $0 >> 2];
		    $8 = HEAPF32[$1 + $4 >> 2];
		    $9 = Math_fround($7 - $8);
		    $5 = Math_fround($5 + Math_fround($9 * $9));
		    $7 = Math_fround($7 + $8);
		    $6 = Math_fround($6 + Math_fround($7 * $7));
		    $2 = $2 + 1 | 0;
		    if (($3 | 0) != ($2 | 0)) {
		     continue;
		    }
		    break;
		   }
		   break label$1;
		  }
		  if (($3 | 0) < 1) {
		   $5 = Math_fround(1.0000000036274937e-15);
		   $6 = Math_fround(1.0000000036274937e-15);
		   break label$1;
		  }
		  $2 = 0;
		  while (1) {
		   $5 = HEAPF32[($2 << 2) + $0 >> 2];
		   $6 = Math_fround($6 + Math_fround($5 * $5));
		   $2 = $2 + 1 | 0;
		   if (($3 | 0) != ($2 | 0)) {
		    continue;
		   }
		   break;
		  }
		  $6 = Math_fround($6 + Math_fround(1.0000000036274937e-15));
		  $2 = 0;
		  $5 = Math_fround(0);
		  while (1) {
		   $7 = HEAPF32[($2 << 2) + $1 >> 2];
		   $5 = Math_fround($5 + Math_fround($7 * $7));
		   $2 = $2 + 1 | 0;
		   if (($3 | 0) != ($2 | 0)) {
		    continue;
		   }
		   break;
		  }
		  $5 = Math_fround($5 + Math_fround(1.0000000036274937e-15));
		 }
		 $8 = Math_fround(Math_sqrt($5));
		 $5 = Math_fround($8 * $8);
		 $9 = Math_fround(Math_sqrt($6));
		 $6 = Math_fround($9 * $9);
		 $7 = Math_fround(0);
		 label$8 : {
		  if (Math_fround($5 + $6) < Math_fround(1.000000045813705e-18)) {
		   break label$8;
		  }
		  $7 = Math_fround(Math_fround(1.5707963705062866) - Math_fround(Math_fround(Math_fround($8 * $9) * Math_fround($5 + Math_fround($6 * Math_fround(.43157973885536194)))) / Math_fround(Math_fround($5 + Math_fround($6 * Math_fround(.6784840226173401))) * Math_fround($5 + Math_fround($6 * Math_fround(.0859554186463356))))));
		  if (!($5 > $6 ^ 1)) {
		   break label$8;
		  }
		  $7 = Math_fround(Math_fround(Math_fround(Math_fround(Math_fround($8 * $9) * Math_fround($6 + Math_fround($5 * Math_fround(.43157973885536194)))) / Math_fround(Math_fround($6 + Math_fround($5 * Math_fround(.6784840226173401))) * Math_fround($6 + Math_fround($5 * Math_fround(.0859554186463356))))) + Math_fround(1.5707963705062866)) + Math_fround(-1.5707963705062866));
		 }
		 $6 = Math_fround(Math_floor(Math_fround(Math_fround($7 * Math_fround(10430.3818359375)) + Math_fround(.5))));
		 if (Math_fround(Math_abs($6)) < Math_fround(2147483648)) {
		  return ~~$6;
		 }
		 return -2147483648;
		}
		function silk_decode_pulses($0, $1, $2, $3, $4) {
		 var $5 = 0, $6 = 0, $7 = 0, $8 = 0, $9 = 0, $10 = 0, $11 = 0, $12 = 0, $13 = 0, $14 = 0;
		 $8 = __stack_pointer - 160 | 0;
		 __stack_pointer = $8;
		 $11 = 8;
		 $6 = ec_dec_icdf($0, Math_imul($2 >> 1, 9) + 7744 | 0, 8);
		 label$1 : {
		  label$2 : {
		   if (($4 & -16) < ($4 | 0)) {
		    if (($4 | 0) == 120) {
		     break label$2;
		    }
		    celt_fatal(8554, 8596, 59);
		    abort();
		   }
		   if (($4 | 0) < 16) {
		    break label$1;
		   }
		   $11 = $4 >> 4;
		  }
		  $13 = Math_imul($6, 18) + 7552 | 0;
		  while (1) {
		   $6 = $9 << 2;
		   $10 = $8 + $6 | 0;
		   HEAP32[$10 >> 2] = 0;
		   $7 = ($8 + 80 | 0) + $6 | 0;
		   $5 = ec_dec_icdf($0, $13, 8);
		   HEAP32[$7 >> 2] = $5;
		   $6 = 0;
		   if (($5 | 0) == 17) {
		    while (1) {
		     $6 = $6 + 1 | 0;
		     $5 = ec_dec_icdf($0, (($6 | 0) == 10) + 7714 | 0, 8);
		     HEAP32[$7 >> 2] = $5;
		     if (($5 | 0) == 17) {
		      continue;
		     }
		     break;
		    }
		    HEAP32[$10 >> 2] = $6;
		   }
		   $9 = $9 + 1 | 0;
		   if (($11 | 0) != ($9 | 0)) {
		    continue;
		   }
		   break;
		  }
		  $6 = 0;
		  while (1) {
		   $5 = ($6 << 16 >> 11) + $1 | 0;
		   $7 = HEAP32[($8 + 80 | 0) + ($6 << 2) >> 2];
		   label$8 : {
		    if (($7 | 0) >= 1) {
		     silk_shell_decoder($5, $0, $7);
		     break label$8;
		    }
		    HEAP16[$5 >> 1] = 0;
		    HEAP16[$5 + 2 >> 1] = 0;
		    HEAP16[$5 + 4 >> 1] = 0;
		    HEAP16[$5 + 6 >> 1] = 0;
		    HEAP16[$5 + 24 >> 1] = 0;
		    HEAP16[$5 + 26 >> 1] = 0;
		    HEAP16[$5 + 28 >> 1] = 0;
		    HEAP16[$5 + 30 >> 1] = 0;
		    HEAP16[$5 + 16 >> 1] = 0;
		    HEAP16[$5 + 18 >> 1] = 0;
		    HEAP16[$5 + 20 >> 1] = 0;
		    HEAP16[$5 + 22 >> 1] = 0;
		    HEAP16[$5 + 8 >> 1] = 0;
		    HEAP16[$5 + 10 >> 1] = 0;
		    HEAP16[$5 + 12 >> 1] = 0;
		    HEAP16[$5 + 14 >> 1] = 0;
		   }
		   $6 = $6 + 1 | 0;
		   if (($11 | 0) != ($6 | 0)) {
		    continue;
		   }
		   break;
		  }
		  while (1) {
		   $14 = $12 << 2;
		   $7 = HEAP32[$14 + $8 >> 2];
		   if (($7 | 0) >= 1) {
		    $13 = ($12 << 16 >> 11) + $1 | 0;
		    $9 = 0;
		    while (1) {
		     $10 = ($9 << 1) + $13 | 0;
		     $6 = HEAP16[$10 >> 1];
		     $5 = 0;
		     while (1) {
		      $6 = ec_dec_icdf($0, 6704, 8) + ($6 << 1) | 0;
		      $5 = $5 + 1 | 0;
		      if (($7 | 0) != ($5 | 0)) {
		       continue;
		      }
		      break;
		     }
		     HEAP16[$10 >> 1] = $6;
		     $9 = $9 + 1 | 0;
		     if (($9 | 0) != 16) {
		      continue;
		     }
		     break;
		    }
		    $6 = ($8 + 80 | 0) + $14 | 0;
		    HEAP32[$6 >> 2] = HEAP32[$6 >> 2] | $7 << 5;
		   }
		   $12 = $12 + 1 | 0;
		   if (($12 | 0) != ($11 | 0)) {
		    continue;
		   }
		   break;
		  }
		 }
		 silk_decode_signs($0, $1, $4, $2, $3, $8 + 80 | 0);
		 __stack_pointer = $8 + 160 | 0;
		}
		function memcpy($0, $1, $2) {
		 var $3 = 0, $4 = 0, $5 = 0;
		 if ($2 >>> 0 >= 512) {
		  emscripten_memcpy_big($0 | 0, $1 | 0, $2 | 0) | 0;
		  return $0;
		 }
		 $4 = $0 + $2 | 0;
		 label$2 : {
		  if (!(($0 ^ $1) & 3)) {
		   label$4 : {
		    if (($2 | 0) < 1) {
		     $2 = $0;
		     break label$4;
		    }
		    if (!($0 & 3)) {
		     $2 = $0;
		     break label$4;
		    }
		    $2 = $0;
		    while (1) {
		     HEAP8[$2 | 0] = HEAPU8[$1 | 0];
		     $1 = $1 + 1 | 0;
		     $2 = $2 + 1 | 0;
		     if ($4 >>> 0 <= $2 >>> 0) {
		      break label$4;
		     }
		     if ($2 & 3) {
		      continue;
		     }
		     break;
		    }
		   }
		   $3 = $4 & -4;
		   label$8 : {
		    if ($3 >>> 0 < 64) {
		     break label$8;
		    }
		    $5 = $3 + -64 | 0;
		    if ($5 >>> 0 < $2 >>> 0) {
		     break label$8;
		    }
		    while (1) {
		     HEAP32[$2 >> 2] = HEAP32[$1 >> 2];
		     HEAP32[$2 + 4 >> 2] = HEAP32[$1 + 4 >> 2];
		     HEAP32[$2 + 8 >> 2] = HEAP32[$1 + 8 >> 2];
		     HEAP32[$2 + 12 >> 2] = HEAP32[$1 + 12 >> 2];
		     HEAP32[$2 + 16 >> 2] = HEAP32[$1 + 16 >> 2];
		     HEAP32[$2 + 20 >> 2] = HEAP32[$1 + 20 >> 2];
		     HEAP32[$2 + 24 >> 2] = HEAP32[$1 + 24 >> 2];
		     HEAP32[$2 + 28 >> 2] = HEAP32[$1 + 28 >> 2];
		     HEAP32[$2 + 32 >> 2] = HEAP32[$1 + 32 >> 2];
		     HEAP32[$2 + 36 >> 2] = HEAP32[$1 + 36 >> 2];
		     HEAP32[$2 + 40 >> 2] = HEAP32[$1 + 40 >> 2];
		     HEAP32[$2 + 44 >> 2] = HEAP32[$1 + 44 >> 2];
		     HEAP32[$2 + 48 >> 2] = HEAP32[$1 + 48 >> 2];
		     HEAP32[$2 + 52 >> 2] = HEAP32[$1 + 52 >> 2];
		     HEAP32[$2 + 56 >> 2] = HEAP32[$1 + 56 >> 2];
		     HEAP32[$2 + 60 >> 2] = HEAP32[$1 + 60 >> 2];
		     $1 = $1 - -64 | 0;
		     $2 = $2 - -64 | 0;
		     if ($5 >>> 0 >= $2 >>> 0) {
		      continue;
		     }
		     break;
		    }
		   }
		   if ($2 >>> 0 >= $3 >>> 0) {
		    break label$2;
		   }
		   while (1) {
		    HEAP32[$2 >> 2] = HEAP32[$1 >> 2];
		    $1 = $1 + 4 | 0;
		    $2 = $2 + 4 | 0;
		    if ($3 >>> 0 > $2 >>> 0) {
		     continue;
		    }
		    break;
		   }
		   break label$2;
		  }
		  if ($4 >>> 0 < 4) {
		   $2 = $0;
		   break label$2;
		  }
		  $3 = $4 - 4 | 0;
		  if ($3 >>> 0 < $0 >>> 0) {
		   $2 = $0;
		   break label$2;
		  }
		  $2 = $0;
		  while (1) {
		   HEAP8[$2 | 0] = HEAPU8[$1 | 0];
		   HEAP8[$2 + 1 | 0] = HEAPU8[$1 + 1 | 0];
		   HEAP8[$2 + 2 | 0] = HEAPU8[$1 + 2 | 0];
		   HEAP8[$2 + 3 | 0] = HEAPU8[$1 + 3 | 0];
		   $1 = $1 + 4 | 0;
		   $2 = $2 + 4 | 0;
		   if ($3 >>> 0 >= $2 >>> 0) {
		    continue;
		   }
		   break;
		  }
		 }
		 if ($2 >>> 0 < $4 >>> 0) {
		  while (1) {
		   HEAP8[$2 | 0] = HEAPU8[$1 | 0];
		   $1 = $1 + 1 | 0;
		   $2 = $2 + 1 | 0;
		   if (($4 | 0) != ($2 | 0)) {
		    continue;
		   }
		   break;
		  }
		 }
		 return $0;
		}
		function silk_decode_parameters($0, $1, $2) {
		 var $3 = 0, $4 = 0, $5 = 0, $6 = 0, $7 = 0, $8 = 0, $9 = 0;
		 $4 = __stack_pointer + -64 | 0;
		 __stack_pointer = $4;
		 silk_gains_dequant($1 + 16 | 0, $0 + 2736 | 0, $0 + 2312 | 0, ($2 | 0) == 2, HEAP32[$0 + 2324 >> 2]);
		 silk_NLSF_decode($4 + 32 | 0, $0 + 2744 | 0, HEAP32[$0 + 2732 >> 2]);
		 $8 = $1 - -64 | 0;
		 silk_NLSF2A($8, $4 + 32 | 0, HEAP32[$0 + 2340 >> 2], HEAP32[$0 + 4168 >> 2]);
		 $9 = $1 + 32 | 0;
		 label$1 : {
		  label$2 : {
		   if (HEAP32[$0 + 2376 >> 2] == 1) {
		    HEAP8[$0 + 2767 | 0] = 4;
		    break label$2;
		   }
		   $6 = HEAP8[$0 + 2767 | 0];
		   if (($6 | 0) > 3) {
		    break label$2;
		   }
		   $7 = HEAP32[$0 + 2340 >> 2];
		   if (($7 | 0) >= 1) {
		    $2 = 0;
		    while (1) {
		     $3 = $2 << 1;
		     $5 = HEAP16[($3 + $0 | 0) + 2344 >> 1];
		     HEAP16[$4 + $3 >> 1] = (Math_imul(HEAP16[($4 + 32 | 0) + $3 >> 1] - $5 | 0, $6) >>> 2 | 0) + $5;
		     $2 = $2 + 1 | 0;
		     if (($7 | 0) != ($2 | 0)) {
		      continue;
		     }
		     break;
		    }
		   }
		   silk_NLSF2A($9, $4, $7, HEAP32[$0 + 4168 >> 2]);
		   break label$1;
		  }
		  memcpy($9, $8, HEAP32[$0 + 2340 >> 2] << 1);
		 }
		 $2 = HEAP32[$0 + 2340 >> 2];
		 memcpy($0 + 2344 | 0, $4 + 32 | 0, $2 << 1);
		 if (HEAP32[$0 + 4160 >> 2]) {
		  silk_bwexpander($9, $2, 63570);
		  silk_bwexpander($8, HEAP32[$0 + 2340 >> 2], 63570);
		 }
		 label$7 : {
		  if (HEAPU8[$0 + 2765 | 0] == 2) {
		   silk_decode_pitch(HEAP16[$0 + 2762 >> 1], HEAP8[$0 + 2764 | 0], $1, HEAP32[$0 + 2316 >> 2], HEAP32[$0 + 2324 >> 2]);
		   $6 = HEAP32[$0 + 2324 >> 2];
		   if (($6 | 0) >= 1) {
		    $7 = HEAP32[(HEAP8[$0 + 2768 | 0] << 2) + 7456 >> 2];
		    $5 = 0;
		    while (1) {
		     $2 = Math_imul($5, 10) + $1 | 0;
		     $3 = Math_imul(HEAP8[($0 + $5 | 0) + 2740 | 0], 5) + $7 | 0;
		     HEAP16[$2 + 96 >> 1] = HEAP8[$3 | 0] << 7;
		     HEAP16[$2 + 98 >> 1] = HEAP8[$3 + 1 | 0] << 7;
		     HEAP16[$2 + 100 >> 1] = HEAP8[$3 + 2 | 0] << 7;
		     HEAP16[$2 + 102 >> 1] = HEAP8[$3 + 3 | 0] << 7;
		     HEAP16[$2 + 104 >> 1] = HEAP8[$3 + 4 | 0] << 7;
		     $5 = $5 + 1 | 0;
		     if (($6 | 0) != ($5 | 0)) {
		      continue;
		     }
		     break;
		    }
		   }
		   $2 = HEAP16[(HEAP8[$0 + 2769 | 0] << 1) + 6728 >> 1];
		   break label$7;
		  }
		  $2 = 0;
		  memset(memset($1, 0, HEAP32[$0 + 2324 >> 2] << 2) + 96 | 0, 0, Math_imul(HEAP32[$0 + 2324 >> 2], 10));
		  HEAP8[$0 + 2768 | 0] = 0;
		 }
		 HEAP32[$1 + 136 >> 2] = $2;
		 __stack_pointer = $4 - -64 | 0;
		}
		function silk_resampler_private_IIR_FIR($0, $1, $2, $3) {
		 var $4 = 0, $5 = 0, $6 = 0, $7 = 0, $8 = 0, $9 = 0, $10 = 0, $11 = 0, $12 = 0, $13 = 0, $14 = 0;
		 $6 = __stack_pointer;
		 $11 = $6;
		 $4 = HEAP32[$0 + 268 >> 2];
		 $7 = $6 - (($4 << 2) + 31 & -16) | 0;
		 __stack_pointer = $7;
		 $6 = HEAP32[$0 + 36 >> 2];
		 $5 = HEAP32[$0 + 32 >> 2];
		 HEAP32[$7 + 8 >> 2] = $5;
		 HEAP32[$7 + 12 >> 2] = $6;
		 $5 = HEAP32[$0 + 28 >> 2];
		 $6 = HEAP32[$0 + 24 >> 2];
		 HEAP32[$7 >> 2] = $6;
		 HEAP32[$7 + 4 >> 2] = $5;
		 $12 = $7 + 16 | 0;
		 $13 = HEAP32[$0 + 272 >> 2];
		 while (1) {
		  $8 = ($3 | 0) < ($4 | 0) ? $3 : $4;
		  silk_resampler_private_up2_HQ($0, $12, $2, $8);
		  $6 = 0;
		  $9 = $8 << 17;
		  if (($9 | 0) >= 1) {
		   while (1) {
		    $10 = Math_imul($6 & 65535, 12) >>> 16 | 0;
		    $5 = $10 << 3;
		    $4 = ($6 >> 16 << 1) + $7 | 0;
		    $14 = ((Math_imul(HEAP16[$5 + 2610 >> 1], HEAP16[$4 + 2 >> 1]) + Math_imul(HEAP16[$5 + 2608 >> 1], HEAP16[$4 >> 1]) | 0) + Math_imul(HEAP16[$5 + 2612 >> 1], HEAP16[$4 + 4 >> 1]) | 0) + Math_imul(HEAP16[$5 + 2614 >> 1], HEAP16[$4 + 6 >> 1]) | 0;
		    $5 = 11 - $10 << 3;
		    $4 = ((($14 + Math_imul(HEAP16[$5 + 2614 >> 1], HEAP16[$4 + 8 >> 1]) | 0) + Math_imul(HEAP16[$5 + 2612 >> 1], HEAP16[$4 + 10 >> 1]) | 0) + Math_imul(HEAP16[$5 + 2610 >> 1], HEAP16[$4 + 12 >> 1]) | 0) + Math_imul(HEAP16[$5 + 2608 >> 1], HEAP16[$4 + 14 >> 1]) | 0;
		    $5 = ($4 >> 14) + 1 >> 1;
		    HEAP16[$1 >> 1] = ($4 | 0) > 1073725439 ? 32767 : ($5 | 0) > -32768 ? $5 : -32768;
		    $1 = $1 + 2 | 0;
		    $6 = $6 + $13 | 0;
		    if (($9 | 0) > ($6 | 0)) {
		     continue;
		    }
		    break;
		   }
		  }
		  $3 = $3 - $8 | 0;
		  if (($3 | 0) >= 1) {
		   $4 = ($8 << 2) + $7 | 0;
		   $6 = HEAP32[$4 + 4 >> 2];
		   $5 = HEAP32[$4 >> 2];
		   HEAP32[$7 >> 2] = $5;
		   HEAP32[$7 + 4 >> 2] = $6;
		   $5 = HEAP32[$4 + 12 >> 2];
		   $6 = HEAP32[$4 + 8 >> 2];
		   HEAP32[$7 + 8 >> 2] = $6;
		   HEAP32[$7 + 12 >> 2] = $5;
		   $2 = ($8 << 1) + $2 | 0;
		   $4 = HEAP32[$0 + 268 >> 2];
		   continue;
		  }
		  break;
		 }
		 $4 = ($8 << 2) + $7 | 0;
		 $6 = HEAP32[$4 + 4 >> 2];
		 $5 = HEAP32[$4 >> 2];
		 HEAP32[$0 + 24 >> 2] = $5;
		 HEAP32[$0 + 28 >> 2] = $6;
		 $5 = HEAP32[$4 + 12 >> 2];
		 $6 = HEAP32[$4 + 8 >> 2];
		 HEAP32[$0 + 32 >> 2] = $6;
		 HEAP32[$0 + 36 >> 2] = $5;
		 __stack_pointer = $11;
		}
		function silk_PLC_glue_frames($0, $1, $2) {
		 var $3 = 0, $4 = 0, $5 = 0, $6 = 0, $7 = 0, $8 = 0;
		 $5 = __stack_pointer - 16 | 0;
		 __stack_pointer = $5;
		 label$1 : {
		  if (HEAP32[$0 + 4160 >> 2]) {
		   silk_sum_sqr_shift($0 + 4232 | 0, $0 + 4236 | 0, $1, $2);
		   HEAP32[$0 + 4220 >> 2] = 1;
		   break label$1;
		  }
		  label$3 : {
		   if (!HEAP32[$0 + 4220 >> 2]) {
		    break label$3;
		   }
		   silk_sum_sqr_shift($5 + 8 | 0, $5 + 12 | 0, $1, $2);
		   $3 = HEAP32[$5 + 12 >> 2];
		   $6 = HEAP32[$0 + 4236 >> 2];
		   label$4 : {
		    if (($3 | 0) > ($6 | 0)) {
		     $4 = $0 + 4232 | 0;
		     HEAP32[$4 >> 2] = HEAP32[$4 >> 2] >> $3 - $6;
		     break label$4;
		    }
		    if (($3 | 0) >= ($6 | 0)) {
		     break label$4;
		    }
		    HEAP32[$5 + 8 >> 2] = HEAP32[$5 + 8 >> 2] >> $6 - $3;
		   }
		   $3 = HEAP32[$0 + 4232 >> 2];
		   $4 = HEAP32[$5 + 8 >> 2];
		   if (($3 | 0) >= ($4 | 0)) {
		    break label$3;
		   }
		   $7 = Math_clz32($3);
		   $8 = $3 << $7 - 1;
		   HEAP32[$0 + 4232 >> 2] = $8;
		   $6 = 0;
		   $3 = 25 - $7 | 0;
		   $4 = $4 >> (($3 | 0) > 0 ? $3 : 0);
		   HEAP32[$5 + 8 >> 2] = $4;
		   $3 = 0;
		   $4 = ($8 | 0) / ((($4 | 0) > 1 ? $4 : 1) | 0) | 0;
		   if (($4 | 0) >= 1) {
		    $3 = Math_clz32($4);
		    $7 = 24 - $3 | 0;
		    label$7 : {
		     if (!$7) {
		      break label$7;
		     }
		     if ($4 >>> 0 <= 127) {
		      $4 = $4 << 0 - $7 | $4 >>> 56 - $3;
		      break label$7;
		     }
		     $4 = $4 << $3 + 8 | $4 >>> $7;
		    }
		    $3 = ($3 & 1 ? 32768 : 46214) >>> ($3 >>> 1) | 0;
		    $3 = $3 + (Math_imul(Math_imul($4 & 127, 13959168) >>> 16 | 0, $3) >>> 16 | 0) << 4;
		   }
		   $4 = (65536 - $3 | 0) / ($2 | 0) | 0;
		   if (($2 | 0) < 1) {
		    break label$3;
		   }
		   $7 = $4 << 2;
		   while (1) {
		    $4 = ($6 << 1) + $1 | 0;
		    $8 = $4;
		    $4 = HEAP16[$4 >> 1];
		    HEAP16[$8 >> 1] = (Math_imul($4, $3 & 65532) >>> 16 | 0) + Math_imul($3 >>> 16 | 0, $4);
		    $3 = $3 + $7 | 0;
		    if (($3 | 0) > 65536) {
		     break label$3;
		    }
		    $6 = $6 + 1 | 0;
		    if (($6 | 0) < ($2 | 0)) {
		     continue;
		    }
		    break;
		   }
		  }
		  HEAP32[$0 + 4220 >> 2] = 0;
		 }
		 __stack_pointer = $5 + 16 | 0;
		}
		function silk_LPC_fit($0, $1, $2, $3, $4) {
		 var $5 = 0, $6 = 0, $7 = 0, $8 = 0, $9 = 0, $10 = 0, $11 = 0;
		 $7 = $3 - $2 | 0;
		 $10 = $7 - 1 | 0;
		 $11 = ($4 | 0) < 1;
		 label$1 : {
		  label$2 : {
		   while (1) {
		    $3 = 0;
		    $2 = 0;
		    if (!$11) {
		     while (1) {
		      $6 = HEAP32[($3 << 2) + $1 >> 2];
		      $8 = $6;
		      $6 = $6 >> 31;
		      $6 = $6 ^ $6 + $8;
		      $8 = $6;
		      $6 = ($2 | 0) < ($6 | 0);
		      $2 = $6 ? $8 : $2;
		      $5 = $6 ? $3 : $5;
		      $3 = $3 + 1 | 0;
		      if (($4 | 0) != ($3 | 0)) {
		       continue;
		      }
		      break;
		     }
		    }
		    $3 = ($7 | 0) == 1 ? ($2 & 1) + ($2 >> 1) | 0 : ($2 >> $10) + 1 >> 1;
		    if (($3 | 0) >= 32768) {
		     $3 = ($3 | 0) < 163838 ? $3 : 163838;
		     silk_bwexpander_32($1, $4, 65470 - ((($3 << 14) - 536854528 | 0) / (Math_imul($5 + 1 | 0, $3) >> 2) | 0) | 0);
		     $9 = $9 + 1 | 0;
		     if (($9 | 0) != 10) {
		      continue;
		     }
		     break label$2;
		    }
		    break;
		   }
		   if (($9 | 0) == 10) {
		    break label$2;
		   }
		   $3 = 0;
		   if (($4 | 0) <= 0) {
		    break label$1;
		   }
		   $5 = ($7 | 0) != 1;
		   while (1) {
		    $2 = HEAP32[($3 << 2) + $1 >> 2];
		    $2 = $5 ? ($2 >> $10) + 1 >> 1 : ($2 & 1) + ($2 >> 1) | 0;
		    HEAP16[($3 << 1) + $0 >> 1] = $2;
		    $3 = $3 + 1 | 0;
		    if (($4 | 0) != ($3 | 0)) {
		     continue;
		    }
		    break;
		   }
		   break label$1;
		  }
		  if (($4 | 0) < 1) {
		   break label$1;
		  }
		  $3 = 0;
		  $9 = ($7 | 0) != 1;
		  while (1) {
		   $6 = ($3 << 2) + $1 | 0;
		   $5 = HEAP32[$6 >> 2];
		   $8 = ($3 << 1) + $0 | 0;
		   label$13 : {
		    if (!$9) {
		     $5 = ($5 & 1) + ($5 >> 1) | 0;
		     $2 = 32767;
		     if (($5 | 0) > 32767) {
		      break label$13;
		     }
		     $2 = ($5 | 0) > -32768 ? $5 : -32768;
		     break label$13;
		    }
		    $5 = $5 >> $10;
		    $2 = 32767;
		    if (($5 | 0) > 65534) {
		     break label$13;
		    }
		    $2 = $5 + 1 >> 1;
		    $2 = ($2 | 0) > -32768 ? $2 : -32768;
		   }
		   HEAP16[$8 >> 1] = $2;
		   HEAP32[$6 >> 2] = $2 << 16 >> 16 << $7;
		   $3 = $3 + 1 | 0;
		   if (($4 | 0) != ($3 | 0)) {
		    continue;
		   }
		   break;
		  }
		 }
		}
		function resampler_basic_direct_double($0, $1, $2, $3, $4, $5) {
		 $0 = $0 | 0;
		 $1 = $1 | 0;
		 $2 = $2 | 0;
		 $3 = $3 | 0;
		 $4 = $4 | 0;
		 $5 = $5 | 0;
		 var $6 = 0, $7 = 0, $8 = 0, $9 = 0, $10 = 0, $11 = 0, $12 = 0, $13 = 0, $14 = 0, $15 = 0, $16 = 0, $17 = 0, $18 = 0, $19 = 0, $20 = 0, $21 = 0, $22 = 0, $23 = 0, $24 = 0;
		 $1 = $1 << 2;
		 $16 = $1 + HEAP32[$0 + 64 >> 2] | 0;
		 $9 = HEAP32[$16 >> 2];
		 $17 = HEAP32[$0 + 60 >> 2] + $1 | 0;
		 $6 = HEAP32[$17 >> 2];
		 $18 = HEAP32[$3 >> 2];
		 label$1 : {
		  if (($6 | 0) >= ($18 | 0)) {
		   break label$1;
		  }
		  $13 = HEAP32[$0 + 12 >> 2];
		  $20 = HEAP32[$0 + 40 >> 2];
		  $21 = HEAP32[$0 + 36 >> 2];
		  $22 = HEAP32[$0 + 92 >> 2];
		  $23 = HEAP32[$0 + 76 >> 2];
		  $3 = HEAP32[$5 >> 2];
		  $19 = ($3 | 0) > 0 ? $3 : 0;
		  $14 = HEAP32[$0 + 24 >> 2];
		  $24 = ($14 | 0) < 1;
		  while (1) {
		   if (($7 | 0) == ($19 | 0)) {
		    $7 = $19;
		    break label$1;
		   }
		   $15 = 0;
		   label$4 : {
		    if ($24) {
		     $10 = 0;
		     $11 = 0;
		     $12 = 0;
		     break label$4;
		    }
		    $3 = ($6 << 2) + $2 | 0;
		    $1 = (Math_imul($9, $14) << 2) + $23 | 0;
		    $5 = 0;
		    $12 = 0;
		    $11 = 0;
		    $10 = 0;
		    while (1) {
		     $0 = $5 << 2;
		     $10 = $10 + +Math_fround(HEAPF32[$1 + $0 >> 2] * HEAPF32[$0 + $3 >> 2]);
		     $8 = $0 | 12;
		     $15 = $15 + +Math_fround(HEAPF32[$8 + $1 >> 2] * HEAPF32[$3 + $8 >> 2]);
		     $8 = $0 | 8;
		     $12 = $12 + +Math_fround(HEAPF32[$8 + $1 >> 2] * HEAPF32[$3 + $8 >> 2]);
		     $0 = $0 | 4;
		     $11 = $11 + +Math_fround(HEAPF32[$1 + $0 >> 2] * HEAPF32[$0 + $3 >> 2]);
		     $5 = $5 + 4 | 0;
		     if (($14 | 0) > ($5 | 0)) {
		      continue;
		     }
		     break;
		    }
		   }
		   HEAPF32[(Math_imul($7, $22) << 2) + $4 >> 2] = $10 + $11 + $12 + $15;
		   $0 = $9 + $20 | 0;
		   $9 = $0 - ($0 >>> 0 < $13 >>> 0 ? 0 : $13) | 0;
		   $7 = $7 + 1 | 0;
		   $6 = ($6 + $21 | 0) + ($0 >>> 0 >= $13 >>> 0) | 0;
		   if (($18 | 0) > ($6 | 0)) {
		    continue;
		   }
		   break;
		  }
		 }
		 HEAP32[$17 >> 2] = $6;
		 HEAP32[$16 >> 2] = $9;
		 return $7 | 0;
		}



		function silk_decode_frame($0, $1, $2, $3, $4, $5, $6) {
		 var $7 = 0, $8 = 0, $9 = 0;
		 $7 = __stack_pointer - 144 | 0;
		 __stack_pointer = $7;
		 $9 = HEAP32[$0 + 2328 >> 2];
		 $8 = $7;
		 HEAP32[$7 + 136 >> 2] = 0;
		 label$1 : {
		  label$2 : {
		   if ($9 - 1 >>> 0 < 320) {
		    label$4 : {
		     label$5 : {
		      label$6 : {
		       switch ($4 | 0) {
		       case 2:
		        if (HEAP32[((HEAP32[$0 + 2388 >> 2] << 2) + $0 | 0) + 2420 >> 2] != 1) {
		         break label$5;
		        }
		        break;
		       case 0:
		        break label$6;
		       default:
		        break label$5;
		       }
		      }
		      $7 = $7 - (($9 + 15 & 2147483632) << 1) | 0;
		      __stack_pointer = $7;
		      silk_decode_indices($0, $1, HEAP32[$0 + 2388 >> 2], $4, $5);
		      $4 = $0 + 2765 | 0;
		      silk_decode_pulses($1, $7, HEAP8[$4 | 0], HEAP8[$0 + 2766 | 0], HEAP32[$0 + 2328 >> 2]);
		      silk_decode_parameters($0, $8, $5);
		      silk_decode_core($0, $8, $2, $7, $6);
		      silk_PLC($0, $8, $2, 0, $6);
		      HEAP32[$0 + 4160 >> 2] = 0;
		      $7 = HEAP8[$4 | 0];
		      HEAP32[$0 + 4164 >> 2] = $7;
		      if ($7 >>> 0 >= 3) {
		       break label$2;
		      }
		      HEAP32[$0 + 2376 >> 2] = 0;
		      break label$4;
		     }
		     HEAP8[$0 + 2765 | 0] = HEAP32[$0 + 4164 >> 2];
		     silk_PLC($0, $8, $2, 1, $6);
		    }
		    $6 = HEAP32[$0 + 2336 >> 2];
		    $7 = HEAP32[$0 + 2328 >> 2];
		    if (($6 | 0) < ($7 | 0)) {
		     break label$1;
		    }
		    $4 = $0 + 1348 | 0;
		    $1 = $4 + ($7 << 1) | 0;
		    $7 = $6 - $7 << 1;
		    memcpy($7 + memmove($4, $1, $7) | 0, $2, HEAP32[$0 + 2328 >> 2] << 1);
		    silk_CNG($0, $8, $2, $9);
		    silk_PLC_glue_frames($0, $2, $9);
		    HEAP32[$0 + 2308 >> 2] = HEAP32[((HEAP32[$0 + 2324 >> 2] << 2) + $8 | 0) - 4 >> 2];
		    HEAP32[$3 >> 2] = $9;
		    __stack_pointer = $8 + 144 | 0;
		    return 0;
		   }
		   celt_fatal(9077, 9126, 58);
		   abort();
		  }
		  celt_fatal(9146, 9126, 94);
		  abort();
		 }
		 celt_fatal(9221, 9126, 107);
		 abort();
		}
		function exp($0) {
		 var $1 = 0, $2 = 0, $3 = 0, $4 = 0, $5 = 0, $6 = 0, $7 = 0;
		 wasm2js_scratch_store_f64(+$0);
		 $1 = wasm2js_scratch_load_i32(1) | 0;
		 $4 = wasm2js_scratch_load_i32(0) | 0;
		 $5 = $1 >>> 31 | 0;
		 label$1 : {
		  label$2 : {
		   label$3 : {
		    label$4 : {
		     $3 = $0;
		     label$5 : {
		      label$6 : {
		       $6 = $1;
		       $1 = $6 & 2147483647;
		       label$7 : {
		        if ($1 >>> 0 >= 1082532651) {
		         $4 = __DOUBLE_BITS($0);
		         $6 = $4;
		         $1 = i64toi32_i32$HIGH_BITS;
		         $4 = $1 & 2147483647;
		         $1 = $6;
		         if (($4 | 0) == 2146435072 & ($1 | 0) != 0 | $4 >>> 0 > 2146435072) {
		          return $0;
		         }
		         if (!($0 > 709.782712893384 ^ 1)) {
		          return $0 * 8.98846567431158e+307;
		         }
		         if (!($0 < -745.1332191019411) | $0 < -708.3964185322641 ^ 1) {
		          break label$7;
		         }
		         break label$2;
		        }
		        if ($1 >>> 0 < 1071001155) {
		         break label$4;
		        }
		        if ($1 >>> 0 < 1072734898) {
		         break label$6;
		        }
		       }
		       $2 = $0 * 1.4426950408889634 + HEAPF64[($5 << 3) + 25072 >> 3];
		       if (Math_abs($2) < 2147483648) {
		        $1 = ~~$2;
		        break label$5;
		       }
		       $1 = -2147483648;
		       break label$5;
		      }
		      $1 = ($5 ^ 1) - $5 | 0;
		     }
		     $2 = +($1 | 0);
		     $0 = $3 + $2 * -0.6931471803691238;
		     $7 = $2 * 1.9082149292705877e-10;
		     $3 = $0 - $7;
		     break label$3;
		    }
		    if ($1 >>> 0 <= 1043333120) {
		     break label$1;
		    }
		    $1 = 0;
		    $3 = $0;
		   }
		   $2 = $3 * $3;
		   $2 = $3 - $2 * ($2 * ($2 * ($2 * ($2 * 4.1381367970572385e-8 + -16533902205465252e-22) + 6613756321437934e-20) + -0.0027777777777015593) + .16666666666666602);
		   $2 = $0 + ($3 * $2 / (2 - $2) - $7) + 1;
		   if (!$1) {
		    break label$2;
		   }
		   $2 = scalbn($2, $1);
		  }
		  return $2;
		 }
		 return $0 + 1;
		}
		function memmove($0, $1, $2) {
		 var $3 = 0;
		 label$1 : {
		  if (($0 | 0) == ($1 | 0)) {
		   break label$1;
		  }
		  if (($1 - $0 | 0) - $2 >>> 0 <= 0 - ($2 << 1) >>> 0) {
		   return memcpy($0, $1, $2);
		  }
		  $3 = ($0 ^ $1) & 3;
		  label$3 : {
		   label$4 : {
		    if ($0 >>> 0 < $1 >>> 0) {
		     if ($3) {
		      $3 = $0;
		      break label$3;
		     }
		     if (!($0 & 3)) {
		      $3 = $0;
		      break label$4;
		     }
		     $3 = $0;
		     while (1) {
		      if (!$2) {
		       break label$1;
		      }
		      HEAP8[$3 | 0] = HEAPU8[$1 | 0];
		      $1 = $1 + 1 | 0;
		      $2 = $2 - 1 | 0;
		      $3 = $3 + 1 | 0;
		      if ($3 & 3) {
		       continue;
		      }
		      break;
		     }
		     break label$4;
		    }
		    label$9 : {
		     if ($3) {
		      break label$9;
		     }
		     if ($0 + $2 & 3) {
		      while (1) {
		       if (!$2) {
		        break label$1;
		       }
		       $2 = $2 - 1 | 0;
		       $3 = $2 + $0 | 0;
		       HEAP8[$3 | 0] = HEAPU8[$1 + $2 | 0];
		       if ($3 & 3) {
		        continue;
		       }
		       break;
		      }
		     }
		     if ($2 >>> 0 <= 3) {
		      break label$9;
		     }
		     while (1) {
		      $2 = $2 - 4 | 0;
		      HEAP32[$2 + $0 >> 2] = HEAP32[$1 + $2 >> 2];
		      if ($2 >>> 0 > 3) {
		       continue;
		      }
		      break;
		     }
		    }
		    if (!$2) {
		     break label$1;
		    }
		    while (1) {
		     $2 = $2 - 1 | 0;
		     HEAP8[$2 + $0 | 0] = HEAPU8[$1 + $2 | 0];
		     if ($2) {
		      continue;
		     }
		     break;
		    }
		    break label$1;
		   }
		   if ($2 >>> 0 <= 3) {
		    break label$3;
		   }
		   while (1) {
		    HEAP32[$3 >> 2] = HEAP32[$1 >> 2];
		    $1 = $1 + 4 | 0;
		    $3 = $3 + 4 | 0;
		    $2 = $2 - 4 | 0;
		    if ($2 >>> 0 > 3) {
		     continue;
		    }
		    break;
		   }
		  }
		  if (!$2) {
		   break label$1;
		  }
		  while (1) {
		   HEAP8[$3 | 0] = HEAPU8[$1 | 0];
		   $3 = $3 + 1 | 0;
		   $1 = $1 + 1 | 0;
		   $2 = $2 - 1 | 0;
		   if ($2) {
		    continue;
		   }
		   break;
		  }
		 }
		 return $0;
		}
		function silk_resampler_private_up2_HQ($0, $1, $2, $3) {
		 var $4 = 0, $5 = 0, $6 = 0, $7 = 0, $8 = 0, $9 = 0, $10 = 0, $11 = 0, $12 = 0, $13 = 0, $14 = 0, $15 = 0, $16 = 0, $17 = 0, $18 = 0;
		 if (($3 | 0) >= 1) {
		  $9 = HEAP32[$0 + 20 >> 2];
		  $7 = HEAP32[$0 + 16 >> 2];
		  $4 = HEAP32[$0 + 12 >> 2];
		  $6 = HEAP32[$0 + 8 >> 2];
		  $8 = HEAP32[$0 + 4 >> 2];
		  $5 = HEAP32[$0 >> 2];
		  while (1) {
		   $13 = HEAP16[($12 << 1) + $2 >> 1] << 10;
		   $10 = $13 - $5 | 0;
		   $10 = (Math_imul($10 & 65535, 1746) >>> 16 | 0) + Math_imul($10 >> 16, 1746) | 0;
		   $14 = $10 + $5 | 0;
		   $5 = $14 - $8 | 0;
		   $15 = (Math_imul($5 & 65535, 14986) >>> 16 | 0) + Math_imul($5 >> 16, 14986) | 0;
		   $5 = $15 + $8 | 0;
		   $8 = $5 - $6 | 0;
		   $11 = $12 << 2;
		   $5 = (Math_imul($8 >> 16, -26453) + (Math_imul($8 & 65535, -26453) >> 16) | 0) + $5 | 0;
		   $6 = ($5 >> 9) + 1 >> 1;
		   HEAP16[$11 + $1 >> 1] = ($5 | 0) > 33553919 ? 32767 : ($6 | 0) > -32768 ? $6 : -32768;
		   $18 = ($11 | 2) + $1 | 0;
		   $6 = $13 - $4 | 0;
		   $11 = (Math_imul($6 & 65535, 6854) >>> 16 | 0) + Math_imul($6 >> 16, 6854) | 0;
		   $16 = $11 + $4 | 0;
		   $4 = $16 - $7 | 0;
		   $17 = (Math_imul($4 & 65535, 25769) >>> 16 | 0) + Math_imul($4 >> 16, 25769) | 0;
		   $4 = $17 + $7 | 0;
		   $7 = $4 - $9 | 0;
		   $4 = (Math_imul($7 >> 16, -9994) + (Math_imul($7 & 65535, -9994) >> 16) | 0) + $4 | 0;
		   $9 = ($4 >> 9) + 1 >> 1;
		   HEAP16[$18 >> 1] = ($4 | 0) > 33553919 ? 32767 : ($9 | 0) > -32768 ? $9 : -32768;
		   $9 = $4 + $7 | 0;
		   $6 = $5 + $8 | 0;
		   $7 = $16 + $17 | 0;
		   $8 = $14 + $15 | 0;
		   $4 = $13 + $11 | 0;
		   $5 = $13 + $10 | 0;
		   $12 = $12 + 1 | 0;
		   if (($12 | 0) != ($3 | 0)) {
		    continue;
		   }
		   break;
		  }
		  HEAP32[$0 + 20 >> 2] = $9;
		  HEAP32[$0 + 16 >> 2] = $7;
		  HEAP32[$0 + 12 >> 2] = $4;
		  HEAP32[$0 + 8 >> 2] = $6;
		  HEAP32[$0 + 4 >> 2] = $8;
		  HEAP32[$0 >> 2] = $5;
		 }
		}
		function ec_encode($0, $1, $2, $3) {
		 var $4 = 0, $5 = 0, $6 = 0;
		 $5 = HEAP32[$0 + 28 >> 2];
		 $4 = ($5 >>> 0) / ($3 >>> 0) | 0;
		 $6 = $0;
		 label$1 : {
		  if ($1) {
		   HEAP32[$0 + 32 >> 2] = HEAP32[$0 + 32 >> 2] + (Math_imul($1 - $3 | 0, $4) + $5 | 0);
		   $3 = Math_imul($2 - $1 | 0, $4);
		   break label$1;
		  }
		  $3 = Math_imul($2 - $3 | 0, $4) + $5 | 0;
		 }
		 HEAP32[$6 + 28 >> 2] = $3;
		 if ($3 >>> 0 <= 8388608) {
		  $1 = HEAP32[$0 + 32 >> 2];
		  while (1) {
		   $5 = $1 >>> 23 | 0;
		   label$5 : {
		    if (($5 | 0) != 255) {
		     $3 = $1 >>> 31 | 0;
		     $4 = HEAP32[$0 + 40 >> 2];
		     if (($4 | 0) >= 0) {
		      $1 = -1;
		      $2 = HEAP32[$0 + 24 >> 2];
		      if (HEAPU32[$0 + 4 >> 2] > $2 + HEAP32[$0 + 8 >> 2] >>> 0) {
		       HEAP32[$0 + 24 >> 2] = $2 + 1;
		       HEAP8[HEAP32[$0 >> 2] + $2 | 0] = $3 + $4;
		       $1 = 0;
		      }
		      HEAP32[$0 + 44 >> 2] = HEAP32[$0 + 44 >> 2] | $1;
		     }
		     $1 = HEAP32[$0 + 36 >> 2];
		     if ($1) {
		      $2 = $3 - 1 | 0;
		      while (1) {
		       $3 = -1;
		       $4 = HEAP32[$0 + 24 >> 2];
		       if (HEAPU32[$0 + 4 >> 2] > $4 + HEAP32[$0 + 8 >> 2] >>> 0) {
		        HEAP32[$0 + 24 >> 2] = $4 + 1;
		        HEAP8[HEAP32[$0 >> 2] + $4 | 0] = $2;
		        $3 = 0;
		        $1 = HEAP32[$0 + 36 >> 2];
		       }
		       $1 = $1 - 1 | 0;
		       HEAP32[$0 + 36 >> 2] = $1;
		       HEAP32[$0 + 44 >> 2] = HEAP32[$0 + 44 >> 2] | $3;
		       if ($1) {
		        continue;
		       }
		       break;
		      }
		     }
		     HEAP32[$0 + 40 >> 2] = $5 & 255;
		     $3 = HEAP32[$0 + 28 >> 2];
		     $1 = HEAP32[$0 + 32 >> 2];
		     break label$5;
		    }
		    HEAP32[$0 + 36 >> 2] = HEAP32[$0 + 36 >> 2] + 1;
		   }
		   $3 = $3 << 8;
		   HEAP32[$0 + 28 >> 2] = $3;
		   $1 = $1 << 8 & 2147483392;
		   HEAP32[$0 + 32 >> 2] = $1;
		   HEAP32[$0 + 20 >> 2] = HEAP32[$0 + 20 >> 2] + 8;
		   if ($3 >>> 0 < 8388609) {
		    continue;
		   }
		   break;
		  }
		 }
		}
		function unquant_energy_finalise($0, $1, $2, $3, $4, $5, $6, $7, $8) {
		 var $9 = 0, $10 = 0, $11 = 0, $12 = 0, $13 = 0, $14 = 0, $15 = 0;
		 $13 = ($8 | 0) > 1 ? $8 : 1;
		 $14 = ($1 | 0) >= ($2 | 0);
		 label$1 : {
		  if ($14 | ($6 | 0) < ($8 | 0)) {
		   break label$1;
		  }
		  $10 = $1;
		  while (1) {
		   $9 = $10 << 2;
		   $15 = $9 + $4 | 0;
		   if (!(HEAP32[$15 >> 2] > 7 | HEAP32[$5 + $9 >> 2])) {
		    $9 = 0;
		    while (1) {
		     $11 = ec_dec_bits($7, 1);
		     $12 = (Math_imul(HEAP32[$0 + 8 >> 2], $9) + $10 << 2) + $3 | 0;
		     HEAPF32[$12 >> 2] = HEAPF32[$12 >> 2] + Math_fround(Math_fround(Math_fround(Math_fround($11 | 0) + Math_fround(-0.5)) * Math_fround(1 << 13 - HEAP32[$15 >> 2])) * Math_fround(6103515625e-14));
		     $9 = $9 + 1 | 0;
		     if (($13 | 0) != ($9 | 0)) {
		      continue;
		     }
		     break;
		    }
		    $6 = $6 - $13 | 0;
		   }
		   $10 = $10 + 1 | 0;
		   if (($10 | 0) >= ($2 | 0)) {
		    break label$1;
		   }
		   if (($6 | 0) >= ($8 | 0)) {
		    continue;
		   }
		   break;
		  }
		 }
		 label$5 : {
		  if (($6 | 0) < ($8 | 0) | $14) {
		   break label$5;
		  }
		  while (1) {
		   $11 = $1 << 2;
		   $10 = $11 + $4 | 0;
		   label$7 : {
		    if (HEAP32[$10 >> 2] > 7) {
		     break label$7;
		    }
		    $9 = 0;
		    if (HEAP32[$5 + $11 >> 2] != 1) {
		     break label$7;
		    }
		    while (1) {
		     $11 = ec_dec_bits($7, 1);
		     $12 = (Math_imul(HEAP32[$0 + 8 >> 2], $9) + $1 << 2) + $3 | 0;
		     HEAPF32[$12 >> 2] = HEAPF32[$12 >> 2] + Math_fround(Math_fround(Math_fround(Math_fround($11 | 0) + Math_fround(-0.5)) * Math_fround(1 << 13 - HEAP32[$10 >> 2])) * Math_fround(6103515625e-14));
		     $9 = $9 + 1 | 0;
		     if (($13 | 0) != ($9 | 0)) {
		      continue;
		     }
		     break;
		    }
		    $6 = $6 - $13 | 0;
		   }
		   $1 = $1 + 1 | 0;
		   if (($2 | 0) <= ($1 | 0)) {
		    break label$5;
		   }
		   if (($6 | 0) >= ($8 | 0)) {
		    continue;
		   }
		   break;
		  }
		 }
		}
		function celt_fir_c($0, $1, $2, $3, $4, $5) {
		 var $6 = 0, $7 = 0, $8 = 0, $9 = 0, $10 = 0, $11 = Math_fround(0), $12 = 0, $13 = 0, $14 = 0;
		 $5 = __stack_pointer - 16 | 0;
		 $6 = $5;
		 __stack_pointer = $5;
		 if (($0 | 0) != ($2 | 0)) {
		  $9 = $5 - (($4 << 2) + 15 & -16) | 0;
		  __stack_pointer = $9;
		  {
		   $5 = 0;
		   while (1) {
		    HEAP32[($5 << 2) + $9 >> 2] = HEAP32[(($5 ^ -1) + $4 << 2) + $1 >> 2];
		    $5 = $5 + 1 | 0;
		    if (($5 | 0) != ($4 | 0)) {
		     continue;
		    }
		    break;
		   }
		  }
		  if (($3 | 0) >= 4) {
		   $13 = $3 - 3 | 0;
		   $14 = 0 - $4 << 2;
		   while (1) {
		    $5 = $7 << 2;
		    $1 = $5 + $0 | 0;
		    HEAP32[$6 >> 2] = HEAP32[$1 >> 2];
		    $8 = $5 | 4;
		    HEAP32[$6 + 4 >> 2] = HEAP32[$8 + $0 >> 2];
		    $10 = $5 | 8;
		    HEAP32[$6 + 8 >> 2] = HEAP32[$10 + $0 >> 2];
		    $12 = $5 | 12;
		    HEAP32[$6 + 12 >> 2] = HEAP32[$12 + $0 >> 2];
		    xcorr_kernel_c($9, $1 + $14 | 0, $6, $4);
		    HEAP32[$2 + $5 >> 2] = HEAP32[$6 >> 2];
		    HEAP32[$2 + $8 >> 2] = HEAP32[$6 + 4 >> 2];
		    HEAP32[$2 + $10 >> 2] = HEAP32[$6 + 8 >> 2];
		    HEAP32[$2 + $12 >> 2] = HEAP32[$6 + 12 >> 2];
		    $7 = $7 + 4 | 0;
		    if (($13 | 0) > ($7 | 0)) {
		     continue;
		    }
		    break;
		   }
		  }
		  if (($3 | 0) > ($7 | 0)) {
		   $10 = ($4 | 0) < 1;
		   while (1) {
		    $8 = $7 << 2;
		    $11 = HEAPF32[$8 + $0 >> 2];
		    if (!$10) {
		     $1 = $7 - $4 | 0;
		     $5 = 0;
		     while (1) {
		      $11 = Math_fround($11 + Math_fround(HEAPF32[($5 << 2) + $9 >> 2] * HEAPF32[($1 + $5 << 2) + $0 >> 2]));
		      $5 = $5 + 1 | 0;
		      if (($5 | 0) != ($4 | 0)) {
		       continue;
		      }
		      break;
		     }
		    }
		    HEAPF32[$2 + $8 >> 2] = $11;
		    $7 = $7 + 1 | 0;
		    if (($7 | 0) != ($3 | 0)) {
		     continue;
		    }
		    break;
		   }
		  }
		  __stack_pointer = $6 + 16 | 0;
		  return;
		 }
		 celt_fatal(33804, 33829, 102);
		 abort();
		}
		function unquant_coarse_energy($0, $1, $2, $3, $4, $5, $6, $7) {
		 var $8 = 0, $9 = 0, $10 = Math_fround(0), $11 = Math_fround(0), $12 = 0, $13 = Math_fround(0), $14 = Math_fround(0), $15 = 0, $16 = 0, $17 = 0, $18 = 0;
		 $8 = __stack_pointer - 16 | 0;
		 __stack_pointer = $8;
		 HEAP32[$8 + 8 >> 2] = 0;
		 HEAP32[$8 + 12 >> 2] = 0;
		 if ($4) {
		  $11 = Math_fround(.149993896484375);
		 } else {
		  $9 = $7 << 2;
		  $14 = HEAPF32[$9 + 24832 >> 2];
		  $11 = HEAPF32[$9 + 24848 >> 2];
		 }
		 if (($1 | 0) < ($2 | 0)) {
		  $15 = ($6 | 0) > 1 ? $6 : 1;
		  $16 = (HEAP32[$5 + 4 >> 2] << 3) + 32 | 0;
		  $12 = (Math_imul($7, 84) + Math_imul($4, 42) | 0) + 24496 | 0;
		  while (1) {
		   $4 = (($1 | 0) < 20 ? $1 : 20) << 1;
		   $17 = $12 + $4 | 0;
		   $18 = ($4 | 1) + $12 | 0;
		   $4 = 0;
		   while (1) {
		    $7 = ($16 - HEAP32[$5 + 20 >> 2] | 0) - Math_clz32(HEAP32[$5 + 28 >> 2]) | 0;
		    label$6 : {
		     if (($7 | 0) >= 15) {
		      $6 = ec_laplace_decode($5, HEAPU8[$17 | 0] << 7, HEAPU8[$18 | 0] << 6);
		      break label$6;
		     }
		     if (($7 | 0) >= 2) {
		      $6 = ec_dec_icdf($5, 24864, 2);
		      $6 = $6 >> 1 ^ 0 - ($6 & 1);
		      break label$6;
		     }
		     $6 = -1;
		     if (($7 | 0) != 1) {
		      break label$6;
		     }
		     $6 = 0 - ec_dec_bit_logp($5, 1) | 0;
		    }
		    $7 = (Math_imul(HEAP32[$0 + 8 >> 2], $4) + $1 << 2) + $3 | 0;
		    $9 = ($8 + 8 | 0) + ($4 << 2) | 0;
		    $13 = HEAPF32[$9 >> 2];
		    $10 = Math_fround($6 | 0);
		    HEAPF32[$7 >> 2] = Math_fround($13 + Math_fround($14 * Math_fround(Math_max(HEAPF32[$7 >> 2], Math_fround(-9))))) + $10;
		    HEAPF32[$9 >> 2] = Math_fround($13 + $10) - Math_fround($11 * $10);
		    $4 = $4 + 1 | 0;
		    if (($15 | 0) != ($4 | 0)) {
		     continue;
		    }
		    break;
		   }
		   $1 = $1 + 1 | 0;
		   if (($2 | 0) != ($1 | 0)) {
		    continue;
		   }
		   break;
		  }
		 }
		 __stack_pointer = $8 + 16 | 0;
		}
		function silk_decoder_set_fs($0, $1, $2) {
		 var $3 = 0, $4 = 0, $5 = 0;
		 if (!(!(1 << $1 & 69888) | $1 >>> 0 > 16)) {
		  label$2 : {
		   label$3 : {
		    $3 = HEAP32[$0 + 2324 >> 2];
		    switch ($3 - 2 | 0) {
		    case 0:
		    case 2:
		     break label$2;
		    default:
		     break label$3;
		    }
		   }
		   celt_fatal(6851, 6829, 44);
		   abort();
		  }
		  HEAP32[$0 + 2332 >> 2] = Math_imul($1, 5);
		  $3 = Math_imul(Math_imul($1, 327680) >> 16, $3);
		  label$4 : {
		   label$5 : {
		    if (!(HEAP32[$0 + 2320 >> 2] == ($2 | 0) ? HEAP32[$0 + 2316 >> 2] == ($1 | 0) : 0)) {
		     $4 = silk_resampler_init($0 + 2432 | 0, Math_imul($1, 1e3), $2, 0);
		     HEAP32[$0 + 2320 >> 2] = $2;
		     if (HEAP32[$0 + 2316 >> 2] != ($1 | 0)) {
		      break label$5;
		     }
		    }
		    $5 = 1;
		    if (HEAP32[$0 + 2328 >> 2] == ($3 | 0)) {
		     break label$4;
		    }
		   }
		   $2 = HEAP32[$0 + 2324 >> 2] == 4;
		   HEAP32[$0 + 2384 >> 2] = ($1 | 0) == 8 ? $2 ? 3026 : 3049 : $2 ? 2992 : 3037;
		   if (!$5) {
		    HEAP32[$0 + 2336 >> 2] = Math_imul($1, 20);
		    $2 = ($1 & -5) == 8;
		    HEAP32[$0 + 2732 >> 2] = $2 ? 4456 : 6580;
		    HEAP32[$0 + 2340 >> 2] = $2 ? 10 : 16;
		    $2 = 6752;
		    label$9 : {
		     label$10 : {
		      switch ($1 - 12 | 0) {
		      default:
		       $2 = 6737;
		       if (($1 | 0) == 8) {
		        break label$9;
		       }
		       celt_fatal(6938, 6829, 89);
		       abort();
		      case 0:
		       break label$10;
		      case 4:
		       break label$9;
		      }
		     }
		     $2 = 6746;
		    }
		    HEAP32[$0 + 2376 >> 2] = 1;
		    HEAP32[$0 + 2380 >> 2] = $2;
		    HEAP32[$0 + 4164 >> 2] = 0;
		    HEAP8[$0 + 2312 | 0] = 10;
		    HEAP32[$0 + 2308 >> 2] = 100;
		    memset($0 + 1284 | 0, 0, 1024);
		   }
		   HEAP32[$0 + 2328 >> 2] = $3;
		   HEAP32[$0 + 2316 >> 2] = $1;
		  }
		  return $4;
		 }
		 celt_fatal(6767, 6829, 43);
		 abort();
		}
		function __stdio_write($0, $1, $2) {
		 $0 = $0 | 0;
		 $1 = $1 | 0;
		 $2 = $2 | 0;
		 var $3 = 0, $4 = 0, $5 = 0, $6 = 0, $7 = 0, $8 = 0, $9 = 0;
		 $3 = __stack_pointer - 32 | 0;
		 __stack_pointer = $3;
		 $4 = HEAP32[$0 + 28 >> 2];
		 HEAP32[$3 + 16 >> 2] = $4;
		 $5 = HEAP32[$0 + 20 >> 2];
		 HEAP32[$3 + 28 >> 2] = $2;
		 HEAP32[$3 + 24 >> 2] = $1;
		 $1 = $5 - $4 | 0;
		 HEAP32[$3 + 20 >> 2] = $1;
		 $8 = $1 + $2 | 0;
		 $9 = 2;
		 $1 = $3 + 16 | 0;
		 label$1 : {
		  label$2 : {
		   label$3 : {
		    if (!__wasi_syscall_ret(__wasi_fd_write(HEAP32[$0 + 60 >> 2], $3 + 16 | 0, 2, $3 + 12 | 0) | 0)) {
		     while (1) {
		      $4 = HEAP32[$3 + 12 >> 2];
		      if (($8 | 0) == ($4 | 0)) {
		       break label$3;
		      }
		      if (($4 | 0) <= -1) {
		       break label$2;
		      }
		      $6 = HEAP32[$1 + 4 >> 2];
		      $5 = $6 >>> 0 < $4 >>> 0;
		      $7 = ($5 << 3) + $1 | 0;
		      $6 = $4 - ($5 ? $6 : 0) | 0;
		      HEAP32[$7 >> 2] = $6 + HEAP32[$7 >> 2];
		      $7 = ($5 ? 12 : 4) + $1 | 0;
		      HEAP32[$7 >> 2] = HEAP32[$7 >> 2] - $6;
		      $8 = $8 - $4 | 0;
		      $1 = $5 ? $1 + 8 | 0 : $1;
		      $9 = $9 - $5 | 0;
		      if (!__wasi_syscall_ret(__wasi_fd_write(HEAP32[$0 + 60 >> 2], $1 | 0, $9 | 0, $3 + 12 | 0) | 0)) {
		       continue;
		      }
		      break;
		     }
		    }
		    if (($8 | 0) != -1) {
		     break label$2;
		    }
		   }
		   $1 = HEAP32[$0 + 44 >> 2];
		   HEAP32[$0 + 28 >> 2] = $1;
		   HEAP32[$0 + 20 >> 2] = $1;
		   HEAP32[$0 + 16 >> 2] = HEAP32[$0 + 48 >> 2] + $1;
		   $0 = $2;
		   break label$1;
		  }
		  HEAP32[$0 + 28 >> 2] = 0;
		  HEAP32[$0 + 16 >> 2] = 0;
		  HEAP32[$0 + 20 >> 2] = 0;
		  HEAP32[$0 >> 2] = HEAP32[$0 >> 2] | 32;
		  $0 = 0;
		  if (($9 | 0) == 2) {
		   break label$1;
		  }
		  $0 = $2 - HEAP32[$1 + 4 >> 2] | 0;
		 }
		 __stack_pointer = $3 + 32 | 0;
		 $4 = $0;
		 return $4 | 0;
		}
		function ec_enc_bit_logp($0, $1, $2) {
		 var $3 = 0, $4 = 0, $5 = 0;
		 $3 = HEAP32[$0 + 28 >> 2];
		 $2 = $3 >>> $2 | 0;
		 $3 = $3 - $2 | 0;
		 label$1 : {
		  if (!$1) {
		   $2 = $3;
		   break label$1;
		  }
		  HEAP32[$0 + 32 >> 2] = HEAP32[$0 + 32 >> 2] + $3;
		 }
		 HEAP32[$0 + 28 >> 2] = $2;
		 if ($2 >>> 0 <= 8388608) {
		  $1 = HEAP32[$0 + 32 >> 2];
		  while (1) {
		   $5 = $1 >>> 23 | 0;
		   label$5 : {
		    if (($5 | 0) != 255) {
		     $2 = $1 >>> 31 | 0;
		     $3 = HEAP32[$0 + 40 >> 2];
		     if (($3 | 0) >= 0) {
		      $1 = -1;
		      $4 = HEAP32[$0 + 24 >> 2];
		      if (HEAPU32[$0 + 4 >> 2] > $4 + HEAP32[$0 + 8 >> 2] >>> 0) {
		       HEAP32[$0 + 24 >> 2] = $4 + 1;
		       HEAP8[HEAP32[$0 >> 2] + $4 | 0] = $2 + $3;
		       $1 = 0;
		      }
		      HEAP32[$0 + 44 >> 2] = HEAP32[$0 + 44 >> 2] | $1;
		     }
		     $1 = HEAP32[$0 + 36 >> 2];
		     if ($1) {
		      $4 = $2 - 1 | 0;
		      while (1) {
		       $2 = -1;
		       $3 = HEAP32[$0 + 24 >> 2];
		       if (HEAPU32[$0 + 4 >> 2] > $3 + HEAP32[$0 + 8 >> 2] >>> 0) {
		        HEAP32[$0 + 24 >> 2] = $3 + 1;
		        HEAP8[HEAP32[$0 >> 2] + $3 | 0] = $4;
		        $2 = 0;
		        $1 = HEAP32[$0 + 36 >> 2];
		       }
		       $1 = $1 - 1 | 0;
		       HEAP32[$0 + 36 >> 2] = $1;
		       HEAP32[$0 + 44 >> 2] = HEAP32[$0 + 44 >> 2] | $2;
		       if ($1) {
		        continue;
		       }
		       break;
		      }
		     }
		     HEAP32[$0 + 40 >> 2] = $5 & 255;
		     $2 = HEAP32[$0 + 28 >> 2];
		     $1 = HEAP32[$0 + 32 >> 2];
		     break label$5;
		    }
		    HEAP32[$0 + 36 >> 2] = HEAP32[$0 + 36 >> 2] + 1;
		   }
		   $2 = $2 << 8;
		   HEAP32[$0 + 28 >> 2] = $2;
		   $1 = $1 << 8 & 2147483392;
		   HEAP32[$0 + 32 >> 2] = $1;
		   HEAP32[$0 + 20 >> 2] = HEAP32[$0 + 20 >> 2] + 8;
		   if ($2 >>> 0 < 8388609) {
		    continue;
		   }
		   break;
		  }
		 }
		}
		function pop_arg($0, $1, $2, $3) {
		 label$1 : {
		  if ($1 >>> 0 > 20) {
		   break label$1;
		  }
		  label$2 : {
		   switch ($1 - 9 | 0) {
		   case 0:
		    $1 = HEAP32[$2 >> 2];
		    HEAP32[$2 >> 2] = $1 + 4;
		    HEAP32[$0 >> 2] = HEAP32[$1 >> 2];
		    return;
		   case 1:
		    $1 = HEAP32[$2 >> 2];
		    HEAP32[$2 >> 2] = $1 + 4;
		    $1 = HEAP32[$1 >> 2];
		    $2 = $1 >> 31;
		    HEAP32[$0 >> 2] = $1;
		    HEAP32[$0 + 4 >> 2] = $2;
		    return;
		   case 2:
		    $1 = HEAP32[$2 >> 2];
		    HEAP32[$2 >> 2] = $1 + 4;
		    $2 = HEAP32[$1 >> 2];
		    HEAP32[$0 >> 2] = $2;
		    HEAP32[$0 + 4 >> 2] = 0;
		    return;
		   case 3:
		    $1 = HEAP32[$2 >> 2] + 7 & -8;
		    HEAP32[$2 >> 2] = $1 + 8;
		    $2 = HEAP32[$1 + 4 >> 2];
		    $1 = HEAP32[$1 >> 2];
		    HEAP32[$0 >> 2] = $1;
		    HEAP32[$0 + 4 >> 2] = $2;
		    return;
		   case 4:
		    $1 = HEAP32[$2 >> 2];
		    HEAP32[$2 >> 2] = $1 + 4;
		    $2 = HEAP16[$1 >> 1];
		    $1 = $2 >> 31;
		    HEAP32[$0 >> 2] = $2;
		    HEAP32[$0 + 4 >> 2] = $1;
		    return;
		   case 5:
		    $1 = HEAP32[$2 >> 2];
		    HEAP32[$2 >> 2] = $1 + 4;
		    $1 = HEAPU16[$1 >> 1];
		    HEAP32[$0 >> 2] = $1;
		    HEAP32[$0 + 4 >> 2] = 0;
		    return;
		   case 6:
		    $1 = HEAP32[$2 >> 2];
		    HEAP32[$2 >> 2] = $1 + 4;
		    $2 = HEAP8[$1 | 0];
		    $1 = $2 >> 31;
		    HEAP32[$0 >> 2] = $2;
		    HEAP32[$0 + 4 >> 2] = $1;
		    return;
		   case 7:
		    $1 = HEAP32[$2 >> 2];
		    HEAP32[$2 >> 2] = $1 + 4;
		    $1 = HEAPU8[$1 | 0];
		    HEAP32[$0 >> 2] = $1;
		    HEAP32[$0 + 4 >> 2] = 0;
		    return;
		   case 8:
		    $1 = HEAP32[$2 >> 2] + 7 & -8;
		    HEAP32[$2 >> 2] = $1 + 8;
		    HEAPF64[$0 >> 3] = HEAPF64[$1 >> 3];
		    return;
		   case 9:
		    break label$2;
		   default:
		    break label$1;
		   }
		  }
		  FUNCTION_TABLE[$3 | 0]($0, $2);
		 }
		}
		function speex_resampler_init_frac($0, $1, $2, $3, $4, $5, $6) {
		 var $7 = 0, $8 = 0;
		 label$1 : {
		  label$2 : {
		   if (!(!$2 | (!$0 | !$1))) {
		    if ($5 >>> 0 < 11) {
		     break label$2;
		    }
		   }
		   if (!$6) {
		    break label$1;
		   }
		   HEAP32[$6 >> 2] = 3;
		   return 0;
		  }
		  $7 = dlcalloc(96, 1);
		  if (!$7) {
		   $7 = 0;
		   if (!$6) {
		    break label$1;
		   }
		   HEAP32[$6 >> 2] = 1;
		   return 0;
		  }
		  HEAP32[$7 >> 2] = 0;
		  HEAP32[$7 + 4 >> 2] = 0;
		  HEAP32[$7 + 44 >> 2] = 1065353216;
		  HEAP32[$7 + 16 >> 2] = -1;
		  HEAP32[$7 + 88 >> 2] = 1;
		  HEAP32[$7 + 92 >> 2] = 1;
		  HEAP32[$7 + 20 >> 2] = $0;
		  HEAP32[$7 + 32 >> 2] = 160;
		  HEAP32[$7 + 8 >> 2] = 0;
		  HEAP32[$7 + 12 >> 2] = 0;
		  $0 = $0 << 2;
		  $8 = dlcalloc($0, 1);
		  HEAP32[$7 + 60 >> 2] = $8;
		  label$5 : {
		   if (!$8) {
		    break label$5;
		   }
		   $8 = dlcalloc($0, 1);
		   HEAP32[$7 + 68 >> 2] = $8;
		   if (!$8) {
		    break label$5;
		   }
		   $0 = dlcalloc($0, 1);
		   HEAP32[$7 + 64 >> 2] = $0;
		   if (!$0) {
		    break label$5;
		   }
		   HEAP32[$7 + 16 >> 2] = $5;
		   speex_resampler_set_rate_frac($7, $1, $2, $3, $4);
		   $0 = update_filter($7);
		   label$6 : {
		    if (!$0) {
		     HEAP32[$7 + 52 >> 2] = 1;
		     break label$6;
		    }
		    dlfree(HEAP32[$7 + 72 >> 2]);
		    dlfree(HEAP32[$7 + 76 >> 2]);
		    dlfree(HEAP32[$7 + 60 >> 2]);
		    dlfree(HEAP32[$7 + 68 >> 2]);
		    dlfree(HEAP32[$7 + 64 >> 2]);
		    dlfree($7);
		    $7 = 0;
		   }
		   if (!$6) {
		    break label$1;
		   }
		   HEAP32[$6 >> 2] = $0;
		   return $7;
		  }
		  if ($6) {
		   HEAP32[$6 >> 2] = 1;
		  }
		  dlfree(HEAP32[$7 + 76 >> 2]);
		  dlfree(HEAP32[$7 + 60 >> 2]);
		  dlfree(HEAP32[$7 + 68 >> 2]);
		  dlfree(HEAP32[$7 + 64 >> 2]);
		  dlfree($7);
		  $7 = 0;
		 }
		 return $7;
		}
		function speex_resampler_set_rate_frac($0, $1, $2, $3, $4) {
		 var $5 = 0, $6 = 0, $7 = 0, $8 = 0, $9 = 0;
		 $6 = 3;
		 label$1 : {
		  if (!$1 | !$2) {
		   break label$1;
		  }
		  if (!(HEAP32[$0 >> 2] != ($3 | 0) | HEAP32[$0 + 4 >> 2] != ($4 | 0) | HEAP32[$0 + 8 >> 2] != ($1 | 0))) {
		   $6 = 0;
		   if (HEAP32[$0 + 12 >> 2] == ($2 | 0)) {
		    break label$1;
		   }
		  }
		  HEAP32[$0 + 8 >> 2] = $1;
		  HEAP32[$0 + 4 >> 2] = $4;
		  HEAP32[$0 >> 2] = $3;
		  $7 = HEAP32[$0 + 12 >> 2];
		  HEAP32[$0 + 12 >> 2] = $2;
		  $5 = $1;
		  $3 = $2;
		  while (1) {
		   $4 = $3;
		   $3 = ($5 >>> 0) % ($3 >>> 0) | 0;
		   $5 = $4;
		   if ($3) {
		    continue;
		   }
		   break;
		  }
		  $3 = ($2 >>> 0) / ($4 >>> 0) | 0;
		  HEAP32[$0 + 12 >> 2] = $3;
		  HEAP32[$0 + 8 >> 2] = ($1 >>> 0) / ($4 >>> 0);
		  label$4 : {
		   if (!$7 | !HEAP32[$0 + 20 >> 2]) {
		    break label$4;
		   }
		   $9 = HEAP32[$0 + 64 >> 2];
		   $4 = 0;
		   while (1) {
		    $6 = 5;
		    $2 = 4294967295 / ($3 >>> 0) | 0;
		    $1 = ($4 << 2) + $9 | 0;
		    $5 = HEAP32[$1 >> 2];
		    $8 = $5;
		    $5 = ($5 >>> 0) / ($7 >>> 0) | 0;
		    $8 = $8 - Math_imul($7, $5) | 0;
		    if ($2 >>> 0 < $8 >>> 0 | $2 >>> 0 < $5 >>> 0) {
		     break label$1;
		    }
		    $5 = Math_imul($3, $5);
		    $3 = (Math_imul($3, $8) >>> 0) / ($7 >>> 0) | 0;
		    if ($5 >>> 0 > ($3 ^ -1) >>> 0) {
		     break label$1;
		    }
		    $3 = $3 + $5 | 0;
		    HEAP32[$1 >> 2] = $3;
		    $5 = HEAP32[$0 + 12 >> 2];
		    if ($5 >>> 0 <= $3 >>> 0) {
		     HEAP32[$1 >> 2] = $5 - 1;
		    }
		    $4 = $4 + 1 | 0;
		    if ($4 >>> 0 >= HEAPU32[$0 + 20 >> 2]) {
		     break label$4;
		    }
		    $3 = HEAP32[$0 + 12 >> 2];
		    continue;
		   }
		  }
		  if (!HEAP32[$0 + 52 >> 2]) {
		   return 0;
		  }
		  $6 = update_filter($0);
		 }
		 return $6;
		}
		function memset($0, $1, $2) {
		 var $3 = 0, $4 = 0, $5 = 0, $6 = 0, $7 = 0;
		 label$1 : {
		  if (!$2) {
		   break label$1;
		  }
		  $3 = $0 + $2 | 0;
		  HEAP8[$3 - 1 | 0] = $1;
		  HEAP8[$0 | 0] = $1;
		  if ($2 >>> 0 < 3) {
		   break label$1;
		  }
		  HEAP8[$3 - 2 | 0] = $1;
		  HEAP8[$0 + 1 | 0] = $1;
		  HEAP8[$3 - 3 | 0] = $1;
		  HEAP8[$0 + 2 | 0] = $1;
		  if ($2 >>> 0 < 7) {
		   break label$1;
		  }
		  HEAP8[$3 - 4 | 0] = $1;
		  HEAP8[$0 + 3 | 0] = $1;
		  if ($2 >>> 0 < 9) {
		   break label$1;
		  }
		  $4 = 0 - $0 & 3;
		  $3 = $4 + $0 | 0;
		  $1 = Math_imul($1 & 255, 16843009);
		  HEAP32[$3 >> 2] = $1;
		  $4 = $2 - $4 & -4;
		  $2 = $4 + $3 | 0;
		  HEAP32[$2 - 4 >> 2] = $1;
		  if ($4 >>> 0 < 9) {
		   break label$1;
		  }
		  HEAP32[$3 + 8 >> 2] = $1;
		  HEAP32[$3 + 4 >> 2] = $1;
		  HEAP32[$2 - 8 >> 2] = $1;
		  HEAP32[$2 - 12 >> 2] = $1;
		  if ($4 >>> 0 < 25) {
		   break label$1;
		  }
		  HEAP32[$3 + 24 >> 2] = $1;
		  HEAP32[$3 + 20 >> 2] = $1;
		  HEAP32[$3 + 16 >> 2] = $1;
		  HEAP32[$3 + 12 >> 2] = $1;
		  HEAP32[$2 - 16 >> 2] = $1;
		  HEAP32[$2 - 20 >> 2] = $1;
		  HEAP32[$2 - 24 >> 2] = $1;
		  HEAP32[$2 - 28 >> 2] = $1;
		  $6 = $3 & 4 | 24;
		  $2 = $4 - $6 | 0;
		  if ($2 >>> 0 < 32) {
		   break label$1;
		  }
		  $5 = __wasm_i64_mul($1, 0, 1, 1);
		  $4 = i64toi32_i32$HIGH_BITS;
		  $7 = $4;
		  $1 = $3 + $6 | 0;
		  while (1) {
		   HEAP32[$1 + 24 >> 2] = $5;
		   $4 = $7;
		   HEAP32[$1 + 28 >> 2] = $4;
		   HEAP32[$1 + 16 >> 2] = $5;
		   HEAP32[$1 + 20 >> 2] = $4;
		   HEAP32[$1 + 8 >> 2] = $5;
		   HEAP32[$1 + 12 >> 2] = $4;
		   HEAP32[$1 >> 2] = $5;
		   HEAP32[$1 + 4 >> 2] = $4;
		   $1 = $1 + 32 | 0;
		   $2 = $2 - 32 | 0;
		   if ($2 >>> 0 > 31) {
		    continue;
		   }
		   break;
		  }
		 }
		 return $0;
		}
		function silk_LPC_analysis_filter($0, $1, $2, $3, $4, $5) {
		 var $6 = 0, $7 = 0, $8 = 0, $9 = 0, $10 = 0, $11 = 0, $12 = 0;
		 label$1 : {
		  label$2 : {
		   if (($4 | 0) > 5) {
		    if ($4 & 1) {
		     break label$2;
		    }
		    if (($3 | 0) < ($4 | 0)) {
		     break label$1;
		    }
		    if (($3 | 0) > ($4 | 0)) {
		     $12 = ($4 | 0) < 7;
		     $5 = $4;
		     while (1) {
		      $11 = $5 << 1;
		      $7 = $11 + $1 | 0;
		      $8 = $7 - 2 | 0;
		      $9 = ((((Math_imul(HEAP16[$2 + 2 >> 1], HEAP16[$7 - 4 >> 1]) + Math_imul(HEAP16[$2 >> 1], HEAP16[$8 >> 1]) | 0) + Math_imul(HEAP16[$2 + 4 >> 1], HEAP16[$7 - 6 >> 1]) | 0) + Math_imul(HEAP16[$2 + 6 >> 1], HEAP16[$7 - 8 >> 1]) | 0) + Math_imul(HEAP16[$2 + 8 >> 1], HEAP16[$7 - 10 >> 1]) | 0) + Math_imul(HEAP16[$2 + 10 >> 1], HEAP16[$7 - 12 >> 1]) | 0;
		      $6 = 6;
		      if (!$12) {
		       while (1) {
		        $10 = $6 << 1;
		        $9 = (Math_imul(HEAP16[$10 + $2 >> 1], HEAP16[$8 - $10 >> 1]) + $9 | 0) + Math_imul(HEAP16[($10 | 2) + $2 >> 1], HEAP16[(($6 ^ -1) << 1) + $8 >> 1]) | 0;
		        $6 = $6 + 2 | 0;
		        if (($6 | 0) < ($4 | 0)) {
		         continue;
		        }
		        break;
		       }
		      }
		      $6 = ((HEAP16[$7 >> 1] << 12) - $9 >> 11) + 1 >> 1;
		      $6 = ($6 | 0) > -32768 ? $6 : -32768;
		      HEAP16[$0 + $11 >> 1] = ($6 | 0) < 32767 ? $6 : 32767;
		      $5 = $5 + 1 | 0;
		      if (($5 | 0) != ($3 | 0)) {
		       continue;
		      }
		      break;
		     }
		    }
		    memset($0, 0, $4 << 1);
		    return;
		   }
		   celt_fatal(2119, 2144, 67);
		   abort();
		  }
		  celt_fatal(2171, 2144, 68);
		  abort();
		 }
		 celt_fatal(2202, 2144, 69);
		 abort();
		}
		function resampler_basic_direct_single($0, $1, $2, $3, $4, $5) {
		 $0 = $0 | 0;
		 $1 = $1 | 0;
		 $2 = $2 | 0;
		 $3 = $3 | 0;
		 $4 = $4 | 0;
		 $5 = $5 | 0;
		 var $6 = 0, $7 = 0, $8 = 0, $9 = 0, $10 = Math_fround(0), $11 = 0, $12 = 0, $13 = 0, $14 = 0, $15 = 0, $16 = 0, $17 = 0, $18 = 0, $19 = 0, $20 = 0;
		 $1 = $1 << 2;
		 $11 = $1 + HEAP32[$0 + 64 >> 2] | 0;
		 $8 = HEAP32[$11 >> 2];
		 $12 = HEAP32[$0 + 60 >> 2] + $1 | 0;
		 $6 = HEAP32[$12 >> 2];
		 $13 = HEAP32[$3 >> 2];
		 label$1 : {
		  if (($6 | 0) >= ($13 | 0)) {
		   break label$1;
		  }
		  $9 = HEAP32[$0 + 12 >> 2];
		  $15 = HEAP32[$0 + 40 >> 2];
		  $16 = HEAP32[$0 + 36 >> 2];
		  $17 = HEAP32[$0 + 92 >> 2];
		  $18 = HEAP32[$0 + 76 >> 2];
		  $3 = HEAP32[$5 >> 2];
		  $14 = ($3 | 0) > 0 ? $3 : 0;
		  $1 = HEAP32[$0 + 24 >> 2];
		  $19 = ($1 | 0) < 1;
		  while (1) {
		   if (($7 | 0) == ($14 | 0)) {
		    $7 = $14;
		    break label$1;
		   }
		   $10 = Math_fround(0);
		   if (!$19) {
		    $5 = ($6 << 2) + $2 | 0;
		    $20 = (Math_imul($1, $8) << 2) + $18 | 0;
		    $0 = 0;
		    while (1) {
		     $3 = $0 << 2;
		     $10 = Math_fround($10 + Math_fround(HEAPF32[$20 + $3 >> 2] * HEAPF32[$3 + $5 >> 2]));
		     $0 = $0 + 1 | 0;
		     if (($1 | 0) != ($0 | 0)) {
		      continue;
		     }
		     break;
		    }
		   }
		   HEAPF32[(Math_imul($7, $17) << 2) + $4 >> 2] = $10;
		   $0 = $8 + $15 | 0;
		   $8 = $0 - ($0 >>> 0 < $9 >>> 0 ? 0 : $9) | 0;
		   $7 = $7 + 1 | 0;
		   $6 = ($6 + $16 | 0) + ($0 >>> 0 >= $9 >>> 0) | 0;
		   if (($13 | 0) > ($6 | 0)) {
		    continue;
		   }
		   break;
		  }
		 }
		 HEAP32[$12 >> 2] = $6;
		 HEAP32[$11 >> 2] = $8;
		 return $7 | 0;
		}
		function ec_laplace_decode($0, $1, $2) {
		 var $3 = 0, $4 = 0, $5 = 0, $6 = 0, $7 = 0, $8 = 0;
		 label$1 : {
		  label$2 : {
		   label$3 : {
		    $5 = ec_decode_bin($0, 15);
		    label$4 : {
		     if ($5 >>> 0 < $1 >>> 0) {
		      $7 = $1;
		      $4 = 0;
		      break label$4;
		     }
		     $4 = 1;
		     $3 = Math_imul(16384 - $2 | 0, 32736 - $1 | 0) >>> 15 | 0;
		     $7 = $3 + 1 | 0;
		     label$6 : {
		      if (!$3) {
		       break label$6;
		      }
		      $6 = $7 << 1;
		      $8 = $6 + $1 | 0;
		      if ($8 >>> 0 > $5 >>> 0) {
		       break label$6;
		      }
		      while (1) {
		       $1 = $8;
		       $4 = $4 + 1 | 0;
		       $3 = Math_imul($6 - 2 | 0, $2) >>> 15 | 0;
		       $7 = $3 + 1 | 0;
		       if (!$3) {
		        break label$6;
		       }
		       $6 = $7 << 1;
		       $8 = $6 + $1 | 0;
		       if ($8 >>> 0 <= $5 >>> 0) {
		        continue;
		       }
		       break;
		      }
		     }
		     if (!$3) {
		      $3 = $5 - $1 | 0;
		      $1 = ($3 & -2) + $1 | 0;
		      $4 = ($3 >>> 1 | 0) + $4 | 0;
		     }
		     $3 = $1 + $7 | 0;
		     $6 = $5 >>> 0 < $3 >>> 0;
		     $3 = $6 ? $1 : $3;
		     if ($3 >>> 0 >= 32768) {
		      break label$3;
		     }
		     if ($3 >>> 0 > $5 >>> 0) {
		      break label$2;
		     }
		     $4 = $6 ? 0 - $4 | 0 : $4;
		    }
		    $1 = $3 + $7 | 0;
		    $1 = $1 >>> 0 < 32768 ? $1 : 32768;
		    if ($5 >>> 0 >= $1 >>> 0) {
		     break label$1;
		    }
		    ec_dec_update($0, $3, $1, 32768);
		    return $4;
		   }
		   celt_fatal(24287, 24272, 128);
		   abort();
		  }
		  celt_fatal(24314, 24272, 130);
		  abort();
		 }
		 celt_fatal(24339, 24272, 131);
		 abort();
		}
		function _celt_lpc($0, $1, $2) {
		 var $3 = Math_fround(0), $4 = 0, $5 = Math_fround(0), $6 = 0, $7 = 0, $8 = 0, $9 = Math_fround(0), $10 = Math_fround(0), $11 = 0, $12 = 0, $13 = 0;
		 $5 = HEAPF32[$1 >> 2];
		 $0 = memset($0, 0, $2 << 2);
		 label$1 : {
		  if (HEAPF32[$1 >> 2] == Math_fround(0)) {
		   break label$1;
		  }
		  $11 = ($2 | 0) > 0 ? $2 : 0;
		  $7 = 1;
		  while (1) {
		   if (($4 | 0) == ($11 | 0)) {
		    break label$1;
		   }
		   $2 = 0;
		   $3 = Math_fround(0);
		   if ($4) {
		    while (1) {
		     $3 = Math_fround($3 + Math_fround(HEAPF32[($2 << 2) + $0 >> 2] * HEAPF32[($4 - $2 << 2) + $1 >> 2]));
		     $2 = $2 + 1 | 0;
		     if (($4 | 0) != ($2 | 0)) {
		      continue;
		     }
		     break;
		    }
		   }
		   $8 = $4 + 1 | 0;
		   $3 = Math_fround(Math_fround(-Math_fround($3 + HEAPF32[($8 << 2) + $1 >> 2])) / $5);
		   HEAPF32[($4 << 2) + $0 >> 2] = $3;
		   if ($4) {
		    $12 = $7 >>> 1 | 0;
		    $2 = 0;
		    while (1) {
		     $6 = ($2 << 2) + $0 | 0;
		     $13 = $6;
		     $9 = HEAPF32[$6 >> 2];
		     $6 = (($2 ^ -1) + $4 << 2) + $0 | 0;
		     $10 = HEAPF32[$6 >> 2];
		     HEAPF32[$13 >> 2] = $9 + Math_fround($3 * $10);
		     HEAPF32[$6 >> 2] = $10 + Math_fround($3 * $9);
		     $2 = $2 + 1 | 0;
		     if (($12 | 0) != ($2 | 0)) {
		      continue;
		     }
		     break;
		    }
		   }
		   $7 = $7 + 1 | 0;
		   $4 = $8;
		   $5 = Math_fround($5 - Math_fround($5 * Math_fround($3 * $3)));
		   if ($5 < Math_fround(HEAPF32[$1 >> 2] * Math_fround(.0010000000474974513)) ^ 1) {
		    continue;
		   }
		   break;
		  }
		 }
		}
		function silk_resampler($0, $1, $2, $3) {
		 var $4 = 0, $5 = 0, $6 = 0;
		 label$1 : {
		  $4 = HEAP32[$0 + 284 >> 2];
		  if (($4 | 0) <= ($3 | 0)) {
		   $6 = HEAP32[$0 + 292 >> 2];
		   if (($6 | 0) > ($4 | 0)) {
		    break label$1;
		   }
		   $5 = $0 + 168 | 0;
		   $4 = $4 - $6 << 1;
		   memcpy($5 + ($6 << 1) | 0, $2, $4);
		   label$3 : {
		    label$4 : {
		     switch (HEAP32[$0 + 264 >> 2] - 1 | 0) {
		     case 0:
		      silk_resampler_private_up2_HQ_wrapper($0, $1, $5, HEAP32[$0 + 284 >> 2]);
		      silk_resampler_private_up2_HQ_wrapper($0, (HEAP32[$0 + 288 >> 2] << 1) + $1 | 0, $2 + $4 | 0, $3 - HEAP32[$0 + 284 >> 2] | 0);
		      break label$3;
		     case 1:
		      silk_resampler_private_IIR_FIR($0, $1, $5, HEAP32[$0 + 284 >> 2]);
		      silk_resampler_private_IIR_FIR($0, (HEAP32[$0 + 288 >> 2] << 1) + $1 | 0, $2 + $4 | 0, $3 - HEAP32[$0 + 284 >> 2] | 0);
		      break label$3;
		     case 2:
		      silk_resampler_private_down_FIR($0, $1, $5, HEAP32[$0 + 284 >> 2]);
		      silk_resampler_private_down_FIR($0, (HEAP32[$0 + 288 >> 2] << 1) + $1 | 0, $2 + $4 | 0, $3 - HEAP32[$0 + 284 >> 2] | 0);
		      break label$3;
		     default:
		      break label$4;
		     }
		    }
		    memcpy(memcpy($1, $5, HEAP32[$0 + 284 >> 2] << 1) + (HEAP32[$0 + 288 >> 2] << 1) | 0, $2 + $4 | 0, $3 - HEAP32[$0 + 284 >> 2] << 1);
		   }
		   $0 = HEAP32[$0 + 292 >> 2];
		   memcpy($5, ($3 - $0 << 1) + $2 | 0, $0 << 1);
		   return 0;
		  }
		  celt_fatal(2825, 2778, 184);
		  abort();
		 }
		 celt_fatal(2865, 2778, 186);
		 abort();
		}
		function __vfprintf_internal($0, $1, $2, $3, $4) {
		 var $5 = 0, $6 = 0, $7 = 0;
		 $5 = __stack_pointer - 208 | 0;
		 __stack_pointer = $5;
		 HEAP32[$5 + 204 >> 2] = $2;
		 $2 = 0;
		 memset($5 + 160 | 0, 0, 40);
		 HEAP32[$5 + 200 >> 2] = HEAP32[$5 + 204 >> 2];
		 label$1 : {
		  if ((printf_core(0, $1, $5 + 200 | 0, $5 + 80 | 0, $5 + 160 | 0, $3, $4) | 0) < 0) {
		   $1 = -1;
		   break label$1;
		  }
		  if (HEAP32[$0 + 76 >> 2] >= 0) {
		   $2 = __lockfile();
		  }
		  $6 = HEAP32[$0 >> 2];
		  if (HEAP8[$0 + 74 | 0] <= 0) {
		   HEAP32[$0 >> 2] = $6 & -33;
		  }
		  $6 = $6 & 32;
		  label$5 : {
		   if (HEAP32[$0 + 48 >> 2]) {
		    $4 = printf_core($0, $1, $5 + 200 | 0, $5 + 80 | 0, $5 + 160 | 0, $3, $4);
		    break label$5;
		   }
		   HEAP32[$0 + 48 >> 2] = 80;
		   HEAP32[$0 + 16 >> 2] = $5 + 80;
		   HEAP32[$0 + 28 >> 2] = $5;
		   HEAP32[$0 + 20 >> 2] = $5;
		   $7 = HEAP32[$0 + 44 >> 2];
		   HEAP32[$0 + 44 >> 2] = $5;
		   $1 = printf_core($0, $1, $5 + 200 | 0, $5 + 80 | 0, $5 + 160 | 0, $3, $4);
		   $4 = $1;
		   if (!$7) {
		    break label$5;
		   }
		   FUNCTION_TABLE[HEAP32[$0 + 36 >> 2]]($0, 0, 0) | 0;
		   HEAP32[$0 + 48 >> 2] = 0;
		   HEAP32[$0 + 44 >> 2] = $7;
		   HEAP32[$0 + 28 >> 2] = 0;
		   HEAP32[$0 + 16 >> 2] = 0;
		   $3 = HEAP32[$0 + 20 >> 2];
		   HEAP32[$0 + 20 >> 2] = 0;
		   $4 = $3 ? $1 : -1;
		  }
		  $3 = HEAP32[$0 >> 2];
		  HEAP32[$0 >> 2] = $6 | $3;
		  $1 = $4;
		  $1 = $3 & 32 ? -1 : $1;
		  if (!$2) {
		   break label$1;
		  }
		 }
		 __stack_pointer = $5 + 208 | 0;
		 return $1;
		}
		function _celt_autocorr($0, $1, $2, $3, $4, $5, $6) {
		 var $7 = 0, $8 = 0, $9 = Math_fround(0), $10 = 0, $11 = 0;
		 $7 = __stack_pointer;
		 $11 = $7;
		 $7 = $7 - (($5 << 2) + 15 & -16) | 0;
		 __stack_pointer = $7;
		 label$1 : {
		  if (($5 | 0) > 0) {
		   if (($3 | 0) <= -1) {
		    break label$1;
		   }
		   if ($3) {
		    $10 = memcpy($7, $0, $5 << 2);
		    $7 = 0;
		    while (1) {
		     $8 = $7 << 2;
		     $9 = HEAPF32[$8 + $2 >> 2];
		     HEAPF32[$8 + $10 >> 2] = HEAPF32[$0 + $8 >> 2] * $9;
		     $8 = ($7 ^ -1) + $5 << 2;
		     HEAPF32[$10 + $8 >> 2] = $9 * HEAPF32[$0 + $8 >> 2];
		     $7 = $7 + 1 | 0;
		     if (($7 | 0) != ($3 | 0)) {
		      continue;
		     }
		     break;
		    }
		    $0 = $10;
		   }
		   $2 = $5 - $4 | 0;
		   celt_pitch_xcorr_c($0, $0, $1, $2, $4 + 1 | 0, $6);
		   $8 = 0;
		   if (($4 | 0) >= 0) {
		    while (1) {
		     $9 = Math_fround(0);
		     $7 = $8 + $2 | 0;
		     if (($7 | 0) < ($5 | 0)) {
		      while (1) {
		       $9 = Math_fround($9 + Math_fround(HEAPF32[($7 << 2) + $0 >> 2] * HEAPF32[($7 - $8 << 2) + $0 >> 2]));
		       $7 = $7 + 1 | 0;
		       if (($7 | 0) != ($5 | 0)) {
		        continue;
		       }
		       break;
		      }
		     }
		     $7 = ($8 << 2) + $1 | 0;
		     HEAPF32[$7 >> 2] = $9 + HEAPF32[$7 >> 2];
		     $7 = ($4 | 0) != ($8 | 0);
		     $8 = $8 + 1 | 0;
		     if ($7) {
		      continue;
		     }
		     break;
		    }
		   }
		   __stack_pointer = $11;
		   return 0;
		  }
		  celt_fatal(33874, 33829, 228);
		  abort();
		 }
		 celt_fatal(33896, 33829, 229);
		 abort();
		}
		function denormalise_bands($0, $1, $2, $3, $4, $5, $6, $7, $8) {
		 var $9 = 0, $10 = 0, $11 = 0, $12 = 0, $13 = 0, $14 = 0, $15 = Math_fround(0);
		 $14 = Math_imul(HEAP32[$0 + 44 >> 2], $6);
		 $12 = HEAP32[$0 + 32 >> 2];
		 $9 = Math_imul(HEAP16[$12 + ($5 << 1) >> 1], $6);
		 if (($7 | 0) != 1) {
		  $0 = ($14 | 0) / ($7 | 0) | 0;
		  $9 = ($0 | 0) > ($9 | 0) ? $9 : $0;
		 }
		 $13 = $8 ? 0 : $5;
		 $10 = $8 ? 0 : $4;
		 $11 = HEAP16[($10 << 1) + $12 >> 1];
		 $7 = Math_imul($11, $6);
		 $4 = $7 << 2;
		 $5 = $2;
		 if (($7 | 0) >= 1) {
		  $0 = 0;
		  $5 = memset($2, 0, $4);
		  while (1) {
		   $5 = $5 + 4 | 0;
		   $0 = $0 + 1 | 0;
		   if (($7 | 0) != ($0 | 0)) {
		    continue;
		   }
		   break;
		  }
		 }
		 if (($13 | 0) > ($10 | 0)) {
		  $0 = $1 + $4 | 0;
		  $1 = $10;
		  while (1) {
		   $7 = $1 << 2;
		   $15 = Math_fround(exp(+Math_fround(Math_min(Math_fround(HEAPF32[$7 + $3 >> 2] + HEAPF32[$7 + 24384 >> 2]), Math_fround(32))) * .6931471805599453));
		   $7 = Math_imul($6, $11);
		   $1 = $1 + 1 | 0;
		   $11 = HEAP16[($1 << 1) + $12 >> 1];
		   $4 = Math_imul($11, $6);
		   while (1) {
		    HEAPF32[$5 >> 2] = HEAPF32[$0 >> 2] * $15;
		    $5 = $5 + 4 | 0;
		    $0 = $0 + 4 | 0;
		    $7 = $7 + 1 | 0;
		    if (($7 | 0) < ($4 | 0)) {
		     continue;
		    }
		    break;
		   }
		   if (($1 | 0) != ($13 | 0)) {
		    continue;
		   }
		   break;
		  }
		 }
		 if (($13 | 0) < ($10 | 0)) {
		  celt_fatal(33464, 33495, 263);
		  abort();
		 }
		 $5 = $8 ? 0 : $9;
		 memset(($5 << 2) + $2 | 0, 0, $14 - $5 << 2);
		}
		function silk_PLC_energy($0, $1, $2, $3, $4, $5, $6, $7) {
		 var $8 = 0, $9 = 0, $10 = 0, $11 = 0, $12 = 0, $13 = 0, $14 = 0;
		 $8 = __stack_pointer;
		 $14 = $8;
		 $10 = $8 - (($6 << 2) + 15 & -16) | 0;
		 __stack_pointer = $10;
		 label$1 : {
		  if (($6 | 0) <= 0) {
		   $11 = ($6 << 1) + $10 | 0;
		   break label$1;
		  }
		  $11 = Math_imul($7 - 2 | 0, $6);
		  $8 = HEAP32[$5 >> 2];
		  $12 = $8 << 16 >> 16;
		  $13 = ($8 >> 15) + 1 >> 1;
		  while (1) {
		   $8 = HEAP32[($9 + $11 << 2) + $4 >> 2];
		   $8 = ((Math_imul($8 & 65535, $12) >> 16) + Math_imul($8 >> 16, $12) | 0) + Math_imul($8, $13) | 0;
		   HEAP16[($9 << 1) + $10 >> 1] = ($8 | 0) > 8388607 ? 32767 : ($8 | 0) < -8388608 ? -32768 : $8 >>> 8 | 0;
		   $9 = $9 + 1 | 0;
		   if (($9 | 0) != ($6 | 0)) {
		    continue;
		   }
		   break;
		  }
		  $11 = ($6 << 1) + $10 | 0;
		  if (($6 | 0) < 1) {
		   break label$1;
		  }
		  $13 = Math_imul($7 - 1 | 0, $6);
		  $9 = HEAP32[$5 + 4 >> 2];
		  $12 = $9 << 16 >> 16;
		  $5 = ($9 >> 15) + 1 >> 1;
		  $9 = 0;
		  while (1) {
		   $8 = HEAP32[($9 + $13 << 2) + $4 >> 2];
		   $8 = ((Math_imul($8 & 65535, $12) >> 16) + Math_imul($8 >> 16, $12) | 0) + Math_imul($5, $8) | 0;
		   HEAP16[($9 << 1) + $11 >> 1] = ($8 | 0) > 8388607 ? 32767 : ($8 | 0) < -8388608 ? -32768 : $8 >>> 8 | 0;
		   $9 = $9 + 1 | 0;
		   if (($9 | 0) != ($6 | 0)) {
		    continue;
		   }
		   break;
		  }
		 }
		 silk_sum_sqr_shift($0, $1, $10, $6);
		 silk_sum_sqr_shift($2, $3, $11, $6);
		 __stack_pointer = $14;
		}
		function ec_dec_init($0, $1, $2) {
		 var $3 = 0, $4 = 0, $5 = 0, $6 = 0, $7 = 0, $8 = 0, $9 = 0;
		 HEAP32[$0 + 24 >> 2] = 0;
		 HEAP32[$0 + 28 >> 2] = 128;
		 HEAP32[$0 + 16 >> 2] = 0;
		 HEAP32[$0 + 20 >> 2] = 9;
		 HEAP32[$0 + 8 >> 2] = 0;
		 HEAP32[$0 + 12 >> 2] = 0;
		 HEAP32[$0 + 4 >> 2] = $2;
		 HEAP32[$0 >> 2] = $1;
		 if ($2) {
		  HEAP32[$0 + 24 >> 2] = 1;
		  $3 = HEAPU8[$1 | 0];
		  $4 = 1;
		 }
		 HEAP32[$0 + 44 >> 2] = 0;
		 HEAP32[$0 + 40 >> 2] = $3;
		 HEAP32[$0 + 28 >> 2] = 32768;
		 HEAP32[$0 + 20 >> 2] = 17;
		 $5 = $3 >>> 1 ^ 127;
		 HEAP32[$0 + 32 >> 2] = $5;
		 label$2 : {
		  if ($2 >>> 0 <= $4 >>> 0) {
		   $6 = $4;
		   break label$2;
		  }
		  $6 = $4 + 1 | 0;
		  HEAP32[$0 + 24 >> 2] = $6;
		  $7 = HEAPU8[$1 + $4 | 0];
		 }
		 HEAP32[$0 + 40 >> 2] = $7;
		 HEAP32[$0 + 28 >> 2] = 8388608;
		 HEAP32[$0 + 20 >> 2] = 25;
		 $8 = (($3 << 8 | $7) >>> 1 & 255 | $5 << 8) ^ 255;
		 HEAP32[$0 + 32 >> 2] = $8;
		 $4 = 0;
		 $9 = $0;
		 label$4 : {
		  if ($2 >>> 0 <= $6 >>> 0) {
		   $5 = $6;
		   $3 = 0;
		   break label$4;
		  }
		  $5 = $6 + 1 | 0;
		  HEAP32[$0 + 24 >> 2] = $5;
		  $3 = HEAPU8[$1 + $6 | 0];
		 }
		 HEAP32[$9 + 40 >> 2] = $3;
		 HEAP32[$0 + 28 >> 2] = -2147483648;
		 HEAP32[$0 + 20 >> 2] = 33;
		 $7 = (($7 << 8 | $3) >>> 1 & 255 | $8 << 8) ^ 255;
		 HEAP32[$0 + 32 >> 2] = $7;
		 if ($2 >>> 0 > $5 >>> 0) {
		  HEAP32[$0 + 24 >> 2] = $5 + 1;
		  $4 = HEAPU8[$1 + $5 | 0];
		 }
		 HEAP32[$0 + 40 >> 2] = $4;
		 HEAP32[$0 + 32 >> 2] = (($3 << 8 | $4) >>> 1 & 255 | $7 << 8) ^ 255;
		}
		function opus_decoder_init($0, $1, $2) {
		 var $3 = 0, $4 = 0, $5 = 0;
		 $3 = __stack_pointer - 16 | 0;
		 __stack_pointer = $3;
		 $5 = -1;
		 label$1 : {
		  label$2 : {
		   if (($1 | 0) <= 15999) {
		    if (($1 | 0) == 8e3 | ($1 | 0) == 12e3) {
		     break label$2;
		    }
		    break label$1;
		   }
		   if (($1 | 0) == 16e3 | ($1 | 0) == 48e3) {
		    break label$2;
		   }
		   if (($1 | 0) != 24e3) {
		    break label$1;
		   }
		  }
		  if ($2 - 1 >>> 0 > 1) {
		   break label$1;
		  }
		  $5 = 0;
		  if (!silk_Get_Decoder_Size($3 + 12 | 0)) {
		   HEAP32[$3 + 12 >> 2] = HEAP32[$3 + 12 >> 2] + 3 & -4;
		   $5 = (celt_decoder_get_size($2) + HEAP32[$3 + 12 >> 2] | 0) + 88 | 0;
		  }
		  $0 = memset($0, 0, $5);
		  $5 = -3;
		  if (silk_Get_Decoder_Size($3 + 8 | 0)) ;
		  $4 = HEAP32[$3 + 8 >> 2] + 3 & -4;
		  HEAP32[$3 + 8 >> 2] = $4;
		  HEAP32[$0 + 48 >> 2] = $2;
		  HEAP32[$0 + 8 >> 2] = $2;
		  HEAP32[$0 + 4 >> 2] = 88;
		  HEAP32[$0 + 24 >> 2] = $1;
		  HEAP32[$0 + 12 >> 2] = $1;
		  HEAP32[$0 + 16 >> 2] = $2;
		  $4 = $4 + 88 | 0;
		  HEAP32[$0 >> 2] = $4;
		  if (silk_InitDecoder($0 + 88 | 0)) {
		   break label$1;
		  }
		  $4 = $0 + $4 | 0;
		  if (celt_decoder_init($4, $1, $2)) {
		   break label$1;
		  }
		  $5 = 0;
		  HEAP32[$3 >> 2] = 0;
		  opus_custom_decoder_ctl($4, 10016, $3);
		  HEAP32[$0 + 64 >> 2] = (($1 & 65535) >>> 0) / 400;
		  HEAP32[$0 + 60 >> 2] = 0;
		  HEAP32[$0 + 44 >> 2] = 0;
		 }
		 __stack_pointer = $3 + 16 | 0;
		 return $5;
		}
		function alg_quant($0, $1, $2, $3, $4, $5, $6, $7, $8) {
		 var $9 = 0, $10 = 0, $11 = Math_fround(0);
		 $8 = __stack_pointer;
		 $10 = $8;
		 label$1 : {
		  if (($2 | 0) > 0) {
		   if (($1 | 0) <= 1) {
		    break label$1;
		   }
		   $8 = $8 - (($1 << 2) + 27 & -16) | 0;
		   __stack_pointer = $8;
		   exp_rotation($0, $1, 1, $4, $2, $3);
		   $11 = op_pvq_search_c($0, $8, $2, $1, $5);
		   encode_pulses($8, $1, $2, $5);
		   if ($7) {
		    $6 = Math_fround(Math_fround(Math_fround(1) / Math_fround(Math_sqrt($11))) * $6);
		    $5 = 0;
		    while (1) {
		     $7 = $5 << 2;
		     HEAPF32[$7 + $0 >> 2] = $6 * Math_fround(HEAP32[$7 + $8 >> 2]);
		     $5 = $5 + 1 | 0;
		     if (($5 | 0) != ($1 | 0)) {
		      continue;
		     }
		     break;
		    }
		    exp_rotation($0, $1, -1, $4, $2, $3);
		   }
		   $3 = 1;
		   if (($4 | 0) >= 2) {
		    $9 = ($1 >>> 0) / ($4 >>> 0) | 0;
		    $0 = ($9 | 0) > 1 ? $9 : 1;
		    $3 = 0;
		    $2 = 0;
		    while (1) {
		     $1 = Math_imul($2, $9);
		     $5 = 0;
		     $7 = 0;
		     while (1) {
		      $7 = HEAP32[($1 + $5 << 2) + $8 >> 2] | $7;
		      $5 = $5 + 1 | 0;
		      if (($5 | 0) != ($0 | 0)) {
		       continue;
		      }
		      break;
		     }
		     $3 = (($7 | 0) != 0) << $2 | $3;
		     $2 = $2 + 1 | 0;
		     if (($4 | 0) != ($2 | 0)) {
		      continue;
		     }
		     break;
		    }
		   }
		   __stack_pointer = $10;
		   return $3;
		  }
		  celt_fatal(33204, 33263, 338);
		  abort();
		 }
		 celt_fatal(33273, 33263, 339);
		 abort();
		}
		function silk_NLSF_decode($0, $1, $2) {
		 var $3 = 0, $4 = 0, $5 = 0, $6 = 0, $7 = 0, $8 = 0, $9 = 0, $10 = 0;
		 $6 = __stack_pointer - 80 | 0;
		 __stack_pointer = $6;
		 silk_NLSF_unpack($6 + 32 | 0, $6 - -64 | 0, $2, HEAP8[$1 | 0]);
		 $4 = HEAPU16[$2 + 2 >> 1];
		 $7 = $4 << 16 >> 16;
		 $9 = ($7 | 0) < 1;
		 if (!$9) {
		  $8 = HEAP16[$2 + 4 >> 1];
		  while (1) {
		   $5 = HEAP8[$1 + $4 | 0];
		   $3 = $5 << 10;
		   $5 = ($5 | 0) > 0 ? $3 - 102 | 0 : ($3 | 102) & $5 >> 31;
		   $3 = $4 - 1 | 0;
		   $10 = (Math_imul($5 >> 16, $8) + (Math_imul(HEAPU8[$3 + ($6 - -64 | 0) | 0], $10 << 16 >> 16) >> 8) | 0) + (Math_imul($5 & 65534, $8) >> 16) | 0;
		   HEAP16[($3 << 1) + $6 >> 1] = $10;
		   $5 = ($4 | 0) > 1;
		   $4 = $3;
		   if ($5) {
		    continue;
		   }
		   break;
		  }
		 }
		 if (!$9) {
		  $4 = Math_imul(HEAP8[$1 | 0], $7);
		  $5 = $4 + HEAP32[$2 + 8 >> 2] | 0;
		  $8 = HEAP32[$2 + 12 >> 2] + ($4 << 1) | 0;
		  $4 = 0;
		  while (1) {
		   $3 = $4 << 1;
		   $1 = $3 + $0 | 0;
		   $3 = ((HEAP16[$3 + $6 >> 1] << 14) / HEAP16[$3 + $8 >> 1] | 0) + (HEAPU8[$4 + $5 | 0] << 7) | 0;
		   $3 = ($3 | 0) > 0 ? $3 : 0;
		   HEAP16[$1 >> 1] = ($3 | 0) < 32767 ? $3 : 32767;
		   $4 = $4 + 1 | 0;
		   $7 = HEAP16[$2 + 2 >> 1];
		   if (($4 | 0) < ($7 | 0)) {
		    continue;
		   }
		   break;
		  }
		 }
		 silk_NLSF_stabilize($0, HEAP32[$2 + 36 >> 2], $7);
		 __stack_pointer = $6 + 80 | 0;
		}
		function ec_enc_uint($0, $1, $2) {
		 var $3 = 0, $4 = 0, $5 = 0, $6 = 0, $7 = 0;
		 label$1 : {
		  if ($2 >>> 0 > 1) {
		   $3 = $2 - 1 | 0;
		   if ($3 >>> 0 >= 256) {
		    $4 = 24 - Math_clz32($3) | 0;
		    $2 = $1 >>> $4 | 0;
		    ec_encode($0, $2, $2 + 1 | 0, ($3 >>> $4 | 0) + 1 | 0);
		    if (!$4) {
		     break label$1;
		    }
		    $7 = (-1 << $4 ^ -1) & $1;
		    $1 = HEAP32[$0 + 12 >> 2];
		    $2 = HEAP32[$0 + 16 >> 2];
		    $3 = $4 + $2 | 0;
		    label$4 : {
		     if ($3 >>> 0 < 33) {
		      $5 = $2;
		      break label$4;
		     }
		     while (1) {
		      $3 = -1;
		      $6 = HEAP32[$0 + 4 >> 2];
		      $5 = HEAP32[$0 + 8 >> 2];
		      if ($6 >>> 0 > $5 + HEAP32[$0 + 24 >> 2] >>> 0) {
		       $3 = $5 + 1 | 0;
		       HEAP32[$0 + 8 >> 2] = $3;
		       HEAP8[HEAP32[$0 >> 2] + ($6 - $3 | 0) | 0] = $1;
		       $3 = 0;
		      }
		      HEAP32[$0 + 44 >> 2] = HEAP32[$0 + 44 >> 2] | $3;
		      $1 = $1 >>> 8 | 0;
		      $3 = ($2 | 0) > 15;
		      $5 = $2 - 8 | 0;
		      $2 = $5;
		      if ($3) {
		       continue;
		      }
		      break;
		     }
		     $3 = $4 + $5 | 0;
		    }
		    HEAP32[$0 + 16 >> 2] = $3;
		    HEAP32[$0 + 12 >> 2] = $7 << $5 | $1;
		    HEAP32[$0 + 20 >> 2] = HEAP32[$0 + 20 >> 2] + $4;
		    return;
		   }
		   ec_encode($0, $1, $1 + 1 | 0, $2);
		   return;
		  }
		  celt_fatal(8490, 8514, 180);
		  abort();
		 }
		 celt_fatal(8528, 8514, 198);
		 abort();
		}
		function deinterleave_hadamard($0, $1, $2, $3) {
		 var $4 = 0, $5 = 0, $6 = 0, $7 = 0, $8 = 0, $9 = 0, $10 = 0;
		 $5 = __stack_pointer;
		 $9 = $5;
		 $8 = Math_imul($1, $2);
		 $5 = $5 - (($8 << 2) + 15 & -16) | 0;
		 __stack_pointer = $5;
		 if (($2 | 0) > 0) {
		  label$2 : {
		   if (!$3) {
		    $6 = ($1 | 0) < 1;
		    while (1) {
		     if (!$6) {
		      $7 = Math_imul($1, $4);
		      $3 = 0;
		      while (1) {
		       HEAP32[($3 + $7 << 2) + $5 >> 2] = HEAP32[(Math_imul($2, $3) + $4 << 2) + $0 >> 2];
		       $3 = $3 + 1 | 0;
		       if (($3 | 0) != ($1 | 0)) {
		        continue;
		       }
		       break;
		      }
		     }
		     $4 = $4 + 1 | 0;
		     if (($4 | 0) != ($2 | 0)) {
		      continue;
		     }
		     break;
		    }
		    break label$2;
		   }
		   $10 = ($2 << 2) + 33592 | 0;
		   $6 = ($1 | 0) < 1;
		   while (1) {
		    if (!$6) {
		     $7 = Math_imul(HEAP32[($4 << 2) + $10 >> 2], $1);
		     $3 = 0;
		     while (1) {
		      HEAP32[($3 + $7 << 2) + $5 >> 2] = HEAP32[(Math_imul($2, $3) + $4 << 2) + $0 >> 2];
		      $3 = $3 + 1 | 0;
		      if (($3 | 0) != ($1 | 0)) {
		       continue;
		      }
		      break;
		     }
		    }
		    $4 = $4 + 1 | 0;
		    if (($4 | 0) != ($2 | 0)) {
		     continue;
		    }
		    break;
		   }
		  }
		  memcpy($0, $5, $8 << 2);
		  __stack_pointer = $9;
		  return;
		 }
		 celt_fatal(33568, 33495, 591);
		 abort();
		}
		function alg_unquant($0, $1, $2, $3, $4, $5, $6) {
		 var $7 = 0, $8 = 0, $9 = 0, $10 = 0;
		 $7 = __stack_pointer;
		 $10 = $7;
		 label$1 : {
		  if (($2 | 0) > 0) {
		   if (($1 | 0) <= 1) {
		    break label$1;
		   }
		   $8 = $7 - (($1 << 2) + 15 & -16) | 0;
		   __stack_pointer = $8;
		   $6 = Math_fround(Math_fround(Math_fround(1) / Math_fround(Math_sqrt(decode_pulses($8, $1, $2, $5)))) * $6);
		   $5 = 0;
		   while (1) {
		    $7 = $5 << 2;
		    HEAPF32[$7 + $0 >> 2] = $6 * Math_fround(HEAP32[$7 + $8 >> 2]);
		    $5 = $5 + 1 | 0;
		    if (($5 | 0) != ($1 | 0)) {
		     continue;
		    }
		    break;
		   }
		   exp_rotation($0, $1, -1, $4, $2, $3);
		   $3 = 1;
		   if (($4 | 0) >= 2) {
		    $9 = ($1 >>> 0) / ($4 >>> 0) | 0;
		    $0 = ($9 | 0) > 1 ? $9 : 1;
		    $3 = 0;
		    $2 = 0;
		    while (1) {
		     $1 = Math_imul($2, $9);
		     $5 = 0;
		     $7 = 0;
		     while (1) {
		      $7 = HEAP32[($1 + $5 << 2) + $8 >> 2] | $7;
		      $5 = $5 + 1 | 0;
		      if (($5 | 0) != ($0 | 0)) {
		       continue;
		      }
		      break;
		     }
		     $3 = (($7 | 0) != 0) << $2 | $3;
		     $2 = $2 + 1 | 0;
		     if (($4 | 0) != ($2 | 0)) {
		      continue;
		     }
		     break;
		    }
		   }
		   __stack_pointer = $10;
		   return $3;
		  }
		  celt_fatal(33337, 33263, 371);
		  abort();
		 }
		 celt_fatal(33398, 33263, 372);
		 abort();
		}
		function interleave_hadamard($0, $1, $2, $3) {
		 var $4 = 0, $5 = 0, $6 = 0, $7 = 0, $8 = 0, $9 = 0, $10 = 0;
		 $5 = __stack_pointer;
		 $9 = $5;
		 $8 = Math_imul($1, $2);
		 $5 = $5 - (($8 << 2) + 15 & -16) | 0;
		 __stack_pointer = $5;
		 label$1 : {
		  if (!$3) {
		   if (($2 | 0) < 1) {
		    break label$1;
		   }
		   $6 = ($1 | 0) < 1;
		   while (1) {
		    if (!$6) {
		     $7 = Math_imul($1, $4);
		     $3 = 0;
		     while (1) {
		      HEAP32[(Math_imul($2, $3) + $4 << 2) + $5 >> 2] = HEAP32[($3 + $7 << 2) + $0 >> 2];
		      $3 = $3 + 1 | 0;
		      if (($3 | 0) != ($1 | 0)) {
		       continue;
		      }
		      break;
		     }
		    }
		    $4 = $4 + 1 | 0;
		    if (($4 | 0) != ($2 | 0)) {
		     continue;
		    }
		    break;
		   }
		   break label$1;
		  }
		  if (($2 | 0) < 1) {
		   break label$1;
		  }
		  $10 = ($2 << 2) + 33592 | 0;
		  $6 = ($1 | 0) < 1;
		  while (1) {
		   if (!$6) {
		    $7 = Math_imul(HEAP32[($4 << 2) + $10 >> 2], $1);
		    $3 = 0;
		    while (1) {
		     HEAP32[(Math_imul($2, $3) + $4 << 2) + $5 >> 2] = HEAP32[($3 + $7 << 2) + $0 >> 2];
		     $3 = $3 + 1 | 0;
		     if (($3 | 0) != ($1 | 0)) {
		      continue;
		     }
		     break;
		    }
		   }
		   $4 = $4 + 1 | 0;
		   if (($4 | 0) != ($2 | 0)) {
		    continue;
		   }
		   break;
		  }
		 }
		 memcpy($0, $5, $8 << 2);
		 __stack_pointer = $9;
		}
		function encode_pulses($0, $1, $2, $3) {
		 var $4 = 0, $5 = 0, $6 = 0, $7 = 0, $8 = 0, $9 = 0, $10 = 0;
		 label$1 : {
		  if (($2 | 0) > 0) {
		   if (($1 | 0) <= 1) {
		    break label$1;
		   }
		   $8 = $1 - 1 | 0;
		   $4 = HEAP32[($8 << 2) + $0 >> 2];
		   $5 = $4 >> 31;
		   $5 = $5 ^ $4 + $5;
		   $7 = $4 >>> 31 | 0;
		   while (1) {
		    $9 = $8 - 1 | 0;
		    $4 = $1 - $9 | 0;
		    $7 = HEAP32[HEAP32[((($4 | 0) < ($5 | 0) ? $4 : $5) << 2) + 27984 >> 2] + ((($4 | 0) > ($5 | 0) ? $4 : $5) << 2) >> 2] + $7 | 0;
		    $6 = HEAP32[($9 << 2) + $0 >> 2];
		    $10 = $6 >> 31;
		    $5 = ($10 ^ $6 + $10) + $5 | 0;
		    if (($6 | 0) <= -1) {
		     $6 = $5 + 1 | 0;
		     $7 = HEAP32[HEAP32[((($4 | 0) > ($5 | 0) ? $6 : $4) << 2) + 27984 >> 2] + ((($4 | 0) > ($6 | 0) ? $4 : $6) << 2) >> 2] + $7 | 0;
		    }
		    $4 = ($8 | 0) > 1;
		    $8 = $9;
		    if ($4) {
		     continue;
		    }
		    break;
		   }
		   $5 = $2 + 1 | 0;
		   $4 = ($1 | 0) > ($2 | 0);
		   ec_enc_uint($3, $7, HEAP32[HEAP32[(($4 ? $5 : $1) << 2) + 27984 >> 2] + ((($1 | 0) > ($5 | 0) ? $1 : $5) << 2) >> 2] + HEAP32[HEAP32[((($1 | 0) < ($2 | 0) ? $1 : $2) << 2) + 27984 >> 2] + (($4 ? $1 : $2) << 2) >> 2] | 0);
		   return;
		  }
		  celt_fatal(27936, 27959, 459);
		  abort();
		 }
		 celt_fatal(28044, 27959, 444);
		 abort();
		}
		function silk_decode_pitch($0, $1, $2, $3, $4) {
		 var $5 = 0, $6 = 0, $7 = 0, $8 = 0, $9 = 0, $10 = 0, $11 = 0;
		 label$1 : {
		  label$2 : {
		   if (($3 | 0) == 8) {
		    if (($4 | 0) == 4) {
		     $8 = 8704;
		     $9 = 11;
		     break label$2;
		    }
		    if (($4 | 0) == 2) {
		     $8 = 8653;
		     $9 = 3;
		     break label$2;
		    }
		    celt_fatal(8888, 8939, 54);
		    abort();
		   }
		   if (($4 | 0) == 4) {
		    $8 = 8752;
		    $9 = 34;
		    break label$2;
		   }
		   if (($4 | 0) != 2) {
		    break label$1;
		   }
		   $8 = 8672;
		   $9 = 12;
		  }
		  $3 = $3 << 16;
		  $5 = $3 >> 15;
		  $11 = $5 + $0 | 0;
		  $7 = Math_imul($3 >> 16, 18);
		  $3 = 0;
		  while (1) {
		   $10 = ($3 << 2) + $2 | 0;
		   $0 = HEAP8[(Math_imul($3, $9) + $1 | 0) + $8 | 0] + $11 | 0;
		   HEAP32[$10 >> 2] = $0;
		   label$8 : {
		    if (($5 | 0) > ($7 | 0)) {
		     $6 = $5;
		     if (($0 | 0) > ($5 | 0)) {
		      break label$8;
		     }
		     $6 = ($0 | 0) < ($7 | 0) ? $7 : $0;
		     break label$8;
		    }
		    $6 = $7;
		    if (($0 | 0) > ($7 | 0)) {
		     break label$8;
		    }
		    $6 = ($0 | 0) < ($5 | 0) ? $5 : $0;
		   }
		   HEAP32[$10 >> 2] = $6;
		   $3 = $3 + 1 | 0;
		   if (($4 | 0) != ($3 | 0)) {
		    continue;
		   }
		   break;
		  }
		  return;
		 }
		 celt_fatal(8888, 8939, 63);
		 abort();
		}
		function silk_sum_sqr_shift($0, $1, $2, $3) {
		 var $4 = 0, $5 = 0, $6 = 0, $7 = 0, $8 = 0, $9 = 0, $10 = 0;
		 $9 = $3 - 1 | 0;
		 $10 = Math_clz32($3);
		 $7 = 31 - $10 | 0;
		 label$1 : {
		  if (($3 | 0) < 2) {
		   $5 = $3;
		   break label$1;
		  }
		  $5 = $3;
		  while (1) {
		   $6 = $4 << 1;
		   $8 = HEAP16[($6 | 2) + $2 >> 1];
		   $6 = HEAP16[$2 + $6 >> 1];
		   $5 = (Math_imul($8, $8) + Math_imul($6, $6) >>> $7 | 0) + $5 | 0;
		   $4 = $4 + 2 | 0;
		   if (($9 | 0) > ($4 | 0)) {
		    continue;
		   }
		   break;
		  }
		  $4 = $3 & -2;
		 }
		 $6 = 0;
		 if (($3 | 0) > ($4 | 0)) {
		  $4 = HEAP16[($4 << 1) + $2 >> 1];
		  $5 = (Math_imul($4, $4) >>> $7 | 0) + $5 | 0;
		 }
		 $4 = 34 - (Math_clz32($5) + $10 | 0) | 0;
		 $7 = ($4 | 0) > 0 ? $4 : 0;
		 if (($3 | 0) < 2) {
		  $4 = 0;
		 } else {
		  $4 = 0;
		  while (1) {
		   $5 = $4 << 1;
		   $8 = HEAP16[($5 | 2) + $2 >> 1];
		   $5 = HEAP16[$2 + $5 >> 1];
		   $6 = (Math_imul($8, $8) + Math_imul($5, $5) >>> $7 | 0) + $6 | 0;
		   $4 = $4 + 2 | 0;
		   if (($9 | 0) > ($4 | 0)) {
		    continue;
		   }
		   break;
		  }
		  $4 = $3 & -2;
		 }
		 if (($4 | 0) < ($3 | 0)) {
		  $2 = HEAP16[($4 << 1) + $2 >> 1];
		  $6 = (Math_imul($2, $2) >>> $7 | 0) + $6 | 0;
		 }
		 HEAP32[$1 >> 2] = $7;
		 HEAP32[$0 >> 2] = $6;
		}
		function sinc($0, $1, $2, $3) {
		 var $4 = 0, $5 = 0, $6 = 0, $7 = 0, $8 = Math_fround(0), $9 = 0, $10 = Math_fround(0), $11 = 0, $12 = 0, $13 = 0, $14 = 0, $15 = 0;
		 $4 = +$1;
		 $6 = Math_abs($4);
		 if ($6 < 1e-6) {
		  return $0;
		 }
		 $7 = +($2 | 0);
		 if (!($7 * .5 < $6)) {
		  $1 = Math_fround($0 * $1);
		  $2 = HEAP32[$3 >> 2];
		  $8 = Math_fround(Math_fround(Math_abs(Math_fround(($4 + $4) / $7))) * Math_fround(HEAP32[$3 + 4 >> 2]));
		  $10 = Math_fround(Math_floor($8));
		  label$3 : {
		   if (Math_fround(Math_abs($10)) < Math_fround(2147483648)) {
		    $3 = ~~$10;
		    break label$3;
		   }
		   $3 = -2147483648;
		  }
		  $2 = $2 + ($3 << 3) | 0;
		  $6 = HEAPF64[$2 + 8 >> 3];
		  $7 = HEAPF64[$2 >> 3];
		  $13 = HEAPF64[$2 + 16 >> 3];
		  $9 = HEAPF64[$2 + 24 >> 3];
		  $4 = +$1 * 3.141592653589793;
		  $14 = sin($4) * +$0 / $4;
		  $1 = Math_fround($8 - Math_fround($3 | 0));
		  $0 = Math_fround($1 * $1);
		  $5 = +Math_fround($1 * $0);
		  $11 = $5 * .1666666667;
		  $4 = +$1;
		  $12 = $11 - $4 * .1666666667;
		  $15 = $9 * $12;
		  $9 = +$0 * .5;
		  $5 = $9 + $4 - $5 * .5;
		  $4 = $9 + $4 * -0.3333333333 - $11;
		  $8 = Math_fround($14 * ($15 + ($13 * $5 + ($7 * $4 + $6 * (1 - $12 - $5 - $4)))));
		 }
		 return $8;
		}
		function opus_decoder_create($0, $1, $2) {
		 $0 = $0 | 0;
		 $1 = $1 | 0;
		 $2 = $2 | 0;
		 var $3 = 0, $4 = 0;
		 $4 = __stack_pointer - 16 | 0;
		 __stack_pointer = $4;
		 label$1 : {
		  label$2 : {
		   label$3 : {
		    label$4 : {
		     if (($0 | 0) <= 15999) {
		      if (($0 | 0) == 8e3 | ($0 | 0) == 12e3) {
		       break label$4;
		      }
		      break label$3;
		     }
		     if (($0 | 0) == 16e3 | ($0 | 0) == 48e3) {
		      break label$4;
		     }
		     if (($0 | 0) != 24e3) {
		      break label$3;
		     }
		    }
		    if ($1 - 1 >>> 0 < 2) {
		     break label$2;
		    }
		   }
		   if (!$2) {
		    break label$1;
		   }
		   HEAP32[$2 >> 2] = -1;
		   break label$1;
		  }
		  if (!silk_Get_Decoder_Size($4 + 12 | 0)) {
		   HEAP32[$4 + 12 >> 2] = HEAP32[$4 + 12 >> 2] + 3 & -4;
		   $3 = (celt_decoder_get_size($1) + HEAP32[$4 + 12 >> 2] | 0) + 88 | 0;
		  }
		  $3 = dlmalloc($3);
		  if (!$3) {
		   $3 = 0;
		   if (!$2) {
		    break label$1;
		   }
		   HEAP32[$2 >> 2] = -7;
		   break label$1;
		  }
		  $0 = opus_decoder_init($3, $0, $1);
		  if ($2) {
		   HEAP32[$2 >> 2] = $0;
		  }
		  if (!$0) {
		   break label$1;
		  }
		  dlfree($3);
		  $3 = 0;
		 }
		 __stack_pointer = $4 + 16 | 0;
		 return $3 | 0;
		}
		function ec_dec_icdf($0, $1, $2) {
		 var $3 = 0, $4 = 0, $5 = 0, $6 = 0, $7 = 0, $8 = 0, $9 = 0, $10 = 0;
		 $3 = HEAP32[$0 + 28 >> 2];
		 $5 = $3 >>> $2 | 0;
		 $4 = HEAP32[$0 + 32 >> 2];
		 $2 = -1;
		 while (1) {
		  $6 = $3;
		  $2 = $2 + 1 | 0;
		  $3 = Math_imul(HEAPU8[$2 + $1 | 0], $5);
		  if ($4 >>> 0 < $3 >>> 0) {
		   continue;
		  }
		  break;
		 }
		 $1 = $6 - $3 | 0;
		 HEAP32[$0 + 28 >> 2] = $1;
		 $5 = $4 - $3 | 0;
		 HEAP32[$0 + 32 >> 2] = $5;
		 if ($1 >>> 0 <= 8388608) {
		  $4 = HEAP32[$0 + 24 >> 2];
		  $6 = HEAP32[$0 + 40 >> 2];
		  $8 = HEAP32[$0 + 20 >> 2];
		  $10 = HEAP32[$0 + 4 >> 2];
		  while (1) {
		   $9 = $1 << 8;
		   HEAP32[$0 + 28 >> 2] = $9;
		   $8 = $8 + 8 | 0;
		   HEAP32[$0 + 20 >> 2] = $8;
		   $3 = 0;
		   if ($4 >>> 0 < $10 >>> 0) {
		    $7 = $4 + 1 | 0;
		    HEAP32[$0 + 24 >> 2] = $7;
		    $3 = HEAPU8[HEAP32[$0 >> 2] + $4 | 0];
		    $4 = $7;
		   }
		   HEAP32[$0 + 40 >> 2] = $3;
		   $5 = ($5 << 8 & 2147483392 | ($6 << 8 | $3) >>> 1 & 255) ^ 255;
		   HEAP32[$0 + 32 >> 2] = $5;
		   $7 = $1 >>> 0 < 32769;
		   $6 = $3;
		   $1 = $9;
		   if ($7) {
		    continue;
		   }
		   break;
		  }
		 }
		 return $2;
		}
		function memchr($0, $1, $2) {
		 var $3 = 0, $4 = 0;
		 $3 = ($2 | 0) != 0;
		 label$1 : {
		  label$2 : {
		   label$3 : {
		    if (!$2 | !($0 & 3)) {
		     break label$3;
		    }
		    $4 = $1 & 255;
		    while (1) {
		     if (HEAPU8[$0 | 0] == ($4 | 0)) {
		      break label$2;
		     }
		     $0 = $0 + 1 | 0;
		     $2 = $2 - 1 | 0;
		     $3 = ($2 | 0) != 0;
		     if (!$2) {
		      break label$3;
		     }
		     if ($0 & 3) {
		      continue;
		     }
		     break;
		    }
		   }
		   if (!$3) {
		    break label$1;
		   }
		  }
		  label$5 : {
		   if (HEAPU8[$0 | 0] == ($1 & 255) | $2 >>> 0 < 4) {
		    break label$5;
		   }
		   $4 = Math_imul($1 & 255, 16843009);
		   while (1) {
		    $3 = HEAP32[$0 >> 2] ^ $4;
		    if (($3 ^ -1) & $3 - 16843009 & -2139062144) {
		     break label$5;
		    }
		    $0 = $0 + 4 | 0;
		    $2 = $2 - 4 | 0;
		    if ($2 >>> 0 > 3) {
		     continue;
		    }
		    break;
		   }
		  }
		  if (!$2) {
		   break label$1;
		  }
		  $3 = $1 & 255;
		  while (1) {
		   if (HEAPU8[$0 | 0] == ($3 | 0)) {
		    return $0;
		   }
		   $0 = $0 + 1 | 0;
		   $2 = $2 - 1 | 0;
		   if ($2) {
		    continue;
		   }
		   break;
		  }
		 }
		 return 0;
		}
		function resampler_basic_zero($0, $1, $2, $3, $4, $5) {
		 $0 = $0 | 0;
		 $1 = $1 | 0;
		 $2 = $2 | 0;
		 $3 = $3 | 0;
		 $4 = $4 | 0;
		 $5 = $5 | 0;
		 var $6 = 0, $7 = 0, $8 = 0, $9 = 0, $10 = 0, $11 = 0, $12 = 0;
		 $2 = $1 << 2;
		 $7 = $2 + HEAP32[$0 + 64 >> 2] | 0;
		 $6 = HEAP32[$7 >> 2];
		 $1 = 0;
		 $8 = HEAP32[$0 + 60 >> 2] + $2 | 0;
		 $2 = HEAP32[$8 >> 2];
		 $9 = HEAP32[$3 >> 2];
		 label$1 : {
		  if (($2 | 0) >= ($9 | 0)) {
		   break label$1;
		  }
		  $3 = HEAP32[$0 + 12 >> 2];
		  $10 = HEAP32[$0 + 40 >> 2];
		  $11 = HEAP32[$0 + 36 >> 2];
		  $12 = HEAP32[$0 + 92 >> 2];
		  $1 = HEAP32[$5 >> 2];
		  $5 = ($1 | 0) > 0 ? $1 : 0;
		  $1 = 0;
		  while (1) {
		   if (($1 | 0) == ($5 | 0)) {
		    $1 = $5;
		    break label$1;
		   }
		   HEAP32[(Math_imul($1, $12) << 2) + $4 >> 2] = 0;
		   $0 = $6 + $10 | 0;
		   $6 = $0 - ($0 >>> 0 < $3 >>> 0 ? 0 : $3) | 0;
		   $1 = $1 + 1 | 0;
		   $2 = ($2 + $11 | 0) + ($0 >>> 0 >= $3 >>> 0) | 0;
		   if (($9 | 0) > ($2 | 0)) {
		    continue;
		   }
		   break;
		  }
		 }
		 HEAP32[$8 >> 2] = $2;
		 HEAP32[$7 >> 2] = $6;
		 return $1 | 0;
		}
		function ec_dec_bit_logp($0, $1) {
		 var $2 = 0, $3 = 0, $4 = 0, $5 = 0, $6 = 0, $7 = 0, $8 = 0, $9 = 0, $10 = 0;
		 $2 = HEAP32[$0 + 28 >> 2];
		 $1 = $2 >>> $1 | 0;
		 $3 = HEAP32[$0 + 32 >> 2];
		 $6 = $1 >>> 0 > $3 >>> 0;
		 if (!$6) {
		  $3 = $3 - $1 | 0;
		  HEAP32[$0 + 32 >> 2] = $3;
		 }
		 $2 = $6 ? $1 : $2 - $1 | 0;
		 HEAP32[$0 + 28 >> 2] = $2;
		 if ($2 >>> 0 <= 8388608) {
		  $4 = HEAP32[$0 + 24 >> 2];
		  $8 = HEAP32[$0 + 40 >> 2];
		  $7 = HEAP32[$0 + 20 >> 2];
		  $10 = HEAP32[$0 + 4 >> 2];
		  while (1) {
		   $9 = $2 << 8;
		   HEAP32[$0 + 28 >> 2] = $9;
		   $7 = $7 + 8 | 0;
		   HEAP32[$0 + 20 >> 2] = $7;
		   $1 = 0;
		   if ($4 >>> 0 < $10 >>> 0) {
		    $5 = $4 + 1 | 0;
		    HEAP32[$0 + 24 >> 2] = $5;
		    $1 = HEAPU8[HEAP32[$0 >> 2] + $4 | 0];
		    $4 = $5;
		   }
		   HEAP32[$0 + 40 >> 2] = $1;
		   $3 = ($3 << 8 & 2147483392 | ($8 << 8 | $1) >>> 1 & 255) ^ 255;
		   HEAP32[$0 + 32 >> 2] = $3;
		   $5 = $2 >>> 0 < 32769;
		   $8 = $1;
		   $2 = $9;
		   if ($5) {
		    continue;
		   }
		   break;
		  }
		 }
		 return $6;
		}
		function ec_dec_update($0, $1, $2, $3) {
		 var $4 = 0, $5 = 0, $6 = 0, $7 = 0, $8 = 0, $9 = 0;
		 $4 = HEAP32[$0 + 36 >> 2];
		 $3 = Math_imul($4, $3 - $2 | 0);
		 $5 = HEAP32[$0 + 32 >> 2] - $3 | 0;
		 HEAP32[$0 + 32 >> 2] = $5;
		 $2 = $1 ? Math_imul($2 - $1 | 0, $4) : HEAP32[$0 + 28 >> 2] - $3 | 0;
		 HEAP32[$0 + 28 >> 2] = $2;
		 if ($2 >>> 0 <= 8388608) {
		  $3 = HEAP32[$0 + 24 >> 2];
		  $4 = HEAP32[$0 + 40 >> 2];
		  $7 = HEAP32[$0 + 20 >> 2];
		  $9 = HEAP32[$0 + 4 >> 2];
		  while (1) {
		   $8 = $2 << 8;
		   HEAP32[$0 + 28 >> 2] = $8;
		   $7 = $7 + 8 | 0;
		   HEAP32[$0 + 20 >> 2] = $7;
		   $1 = 0;
		   if ($3 >>> 0 < $9 >>> 0) {
		    $6 = $3 + 1 | 0;
		    HEAP32[$0 + 24 >> 2] = $6;
		    $1 = HEAPU8[HEAP32[$0 >> 2] + $3 | 0];
		    $3 = $6;
		   }
		   HEAP32[$0 + 40 >> 2] = $1;
		   $5 = ($5 << 8 & 2147483392 | ($4 << 8 | $1) >>> 1 & 255) ^ 255;
		   HEAP32[$0 + 32 >> 2] = $5;
		   $6 = $2 >>> 0 < 32769;
		   $4 = $1;
		   $2 = $8;
		   if ($6) {
		    continue;
		   }
		   break;
		  }
		 }
		}
		function wcrtomb($0, $1, $2) {
		 $2 = 1;
		 label$1 : {
		  if ($0) {
		   if ($1 >>> 0 <= 127) {
		    break label$1;
		   }
		   label$3 : {
		    if (!HEAP32[HEAP32[__pthread_self() + 172 >> 2] >> 2]) {
		     if (($1 & -128) == 57216) {
		      break label$1;
		     }
		     break label$3;
		    }
		    if ($1 >>> 0 <= 2047) {
		     HEAP8[$0 + 1 | 0] = $1 & 63 | 128;
		     HEAP8[$0 | 0] = $1 >>> 6 | 192;
		     return 2;
		    }
		    if (!(($1 & -8192) != 57344 ? $1 >>> 0 >= 55296 : 0)) {
		     HEAP8[$0 + 2 | 0] = $1 & 63 | 128;
		     HEAP8[$0 | 0] = $1 >>> 12 | 224;
		     HEAP8[$0 + 1 | 0] = $1 >>> 6 & 63 | 128;
		     return 3;
		    }
		    if ($1 - 65536 >>> 0 <= 1048575) {
		     HEAP8[$0 + 3 | 0] = $1 & 63 | 128;
		     HEAP8[$0 | 0] = $1 >>> 18 | 240;
		     HEAP8[$0 + 2 | 0] = $1 >>> 6 & 63 | 128;
		     HEAP8[$0 + 1 | 0] = $1 >>> 12 & 63 | 128;
		     return 4;
		    }
		   }
		   HEAP32[__errno_location() >> 2] = 25;
		   $2 = -1;
		  }
		  return $2;
		 }
		 HEAP8[$0 | 0] = $1;
		 return 1;
		}
		function cos($0) {
		 var $1 = 0, $2 = 0, $3 = 0;
		 $1 = __stack_pointer - 16 | 0;
		 __stack_pointer = $1;
		 wasm2js_scratch_store_f64(+$0);
		 $3 = wasm2js_scratch_load_i32(1) | 0;
		 wasm2js_scratch_load_i32(0) | 0;
		 $3 = $3 & 2147483647;
		 label$1 : {
		  if ($3 >>> 0 <= 1072243195) {
		   $2 = 1;
		   if ($3 >>> 0 < 1044816030) {
		    break label$1;
		   }
		   $2 = __cos($0, 0);
		   break label$1;
		  }
		  $2 = $0 - $0;
		  if ($3 >>> 0 >= 2146435072) {
		   break label$1;
		  }
		  label$3 : {
		   switch (__rem_pio2($0, $1) & 3) {
		   case 0:
		    $2 = __cos(HEAPF64[$1 >> 3], HEAPF64[$1 + 8 >> 3]);
		    break label$1;
		   case 1:
		    $2 = -__sin(HEAPF64[$1 >> 3], HEAPF64[$1 + 8 >> 3], 1);
		    break label$1;
		   case 2:
		    $2 = -__cos(HEAPF64[$1 >> 3], HEAPF64[$1 + 8 >> 3]);
		    break label$1;
		   default:
		    break label$3;
		   }
		  }
		  $2 = __sin(HEAPF64[$1 >> 3], HEAPF64[$1 + 8 >> 3], 1);
		 }
		 __stack_pointer = $1 + 16 | 0;
		 return $2;
		}
		function __fwritex($0, $1, $2) {
		 var $3 = 0, $4 = 0, $5 = 0;
		 $3 = HEAP32[$2 + 16 >> 2];
		 label$1 : {
		  if (!$3) {
		   if (__towrite($2)) {
		    break label$1;
		   }
		   $3 = HEAP32[$2 + 16 >> 2];
		  }
		  $5 = HEAP32[$2 + 20 >> 2];
		  if ($3 - $5 >>> 0 < $1 >>> 0) {
		   return FUNCTION_TABLE[HEAP32[$2 + 36 >> 2]]($2, $0, $1) | 0;
		  }
		  label$5 : {
		   if (HEAP8[$2 + 75 | 0] < 0) {
		    $3 = 0;
		    break label$5;
		   }
		   $4 = $1;
		   while (1) {
		    $3 = $4;
		    if (!$3) {
		     $3 = 0;
		     break label$5;
		    }
		    $4 = $3 - 1 | 0;
		    if (HEAPU8[$4 + $0 | 0] != 10) {
		     continue;
		    }
		    break;
		   }
		   $4 = FUNCTION_TABLE[HEAP32[$2 + 36 >> 2]]($2, $0, $3) | 0;
		   if ($4 >>> 0 < $3 >>> 0) {
		    break label$1;
		   }
		   $0 = $0 + $3 | 0;
		   $1 = $1 - $3 | 0;
		   $5 = HEAP32[$2 + 20 >> 2];
		  }
		  memcpy($5, $0, $1);
		  HEAP32[$2 + 20 >> 2] = HEAP32[$2 + 20 >> 2] + $1;
		  $4 = $1 + $3 | 0;
		 }
		 return $4;
		}
		function sin($0) {
		 var $1 = 0, $2 = 0;
		 $1 = __stack_pointer - 16 | 0;
		 __stack_pointer = $1;
		 wasm2js_scratch_store_f64(+$0);
		 $2 = wasm2js_scratch_load_i32(1) | 0;
		 wasm2js_scratch_load_i32(0) | 0;
		 $2 = $2 & 2147483647;
		 label$1 : {
		  if ($2 >>> 0 <= 1072243195) {
		   if ($2 >>> 0 < 1045430272) {
		    break label$1;
		   }
		   $0 = __sin($0, 0, 0);
		   break label$1;
		  }
		  if ($2 >>> 0 >= 2146435072) {
		   $0 = $0 - $0;
		   break label$1;
		  }
		  label$4 : {
		   switch (__rem_pio2($0, $1) & 3) {
		   case 0:
		    $0 = __sin(HEAPF64[$1 >> 3], HEAPF64[$1 + 8 >> 3], 1);
		    break label$1;
		   case 1:
		    $0 = __cos(HEAPF64[$1 >> 3], HEAPF64[$1 + 8 >> 3]);
		    break label$1;
		   case 2:
		    $0 = -__sin(HEAPF64[$1 >> 3], HEAPF64[$1 + 8 >> 3], 1);
		    break label$1;
		   default:
		    break label$4;
		   }
		  }
		  $0 = -__cos(HEAPF64[$1 >> 3], HEAPF64[$1 + 8 >> 3]);
		 }
		 __stack_pointer = $1 + 16 | 0;
		 return $0;
		}
		function ec_enc_bits($0, $1, $2) {
		 var $3 = 0, $4 = 0, $5 = 0, $6 = 0, $7 = 0;
		 {
		  $6 = HEAP32[$0 + 12 >> 2];
		  $5 = HEAP32[$0 + 16 >> 2];
		  $3 = $5 + $2 | 0;
		  label$2 : {
		   if ($3 >>> 0 < 33) {
		    $4 = $5;
		    break label$2;
		   }
		   while (1) {
		    $3 = -1;
		    $7 = HEAP32[$0 + 4 >> 2];
		    $4 = HEAP32[$0 + 8 >> 2];
		    if ($7 >>> 0 > $4 + HEAP32[$0 + 24 >> 2] >>> 0) {
		     $3 = $4 + 1 | 0;
		     HEAP32[$0 + 8 >> 2] = $3;
		     HEAP8[HEAP32[$0 >> 2] + ($7 - $3 | 0) | 0] = $6;
		     $3 = 0;
		    }
		    HEAP32[$0 + 44 >> 2] = HEAP32[$0 + 44 >> 2] | $3;
		    $6 = $6 >>> 8 | 0;
		    $3 = ($5 | 0) > 15;
		    $4 = $5 - 8 | 0;
		    $5 = $4;
		    if ($3) {
		     continue;
		    }
		    break;
		   }
		   $3 = $2 + $4 | 0;
		  }
		  HEAP32[$0 + 16 >> 2] = $3;
		  HEAP32[$0 + 12 >> 2] = $1 << $4 | $6;
		  HEAP32[$0 + 20 >> 2] = HEAP32[$0 + 20 >> 2] + $2;
		  return;
		 }
		}
		function speex_resampler_process_interleaved_float($0, $1, $2, $3, $4) {
		 $0 = $0 | 0;
		 $1 = $1 | 0;
		 $2 = $2 | 0;
		 $3 = $3 | 0;
		 $4 = $4 | 0;
		 var $5 = 0, $6 = 0, $7 = 0, $8 = 0, $9 = 0, $10 = 0;
		 $7 = HEAP32[$0 + 92 >> 2];
		 $8 = HEAP32[$2 >> 2];
		 $9 = HEAP32[$4 >> 2];
		 $5 = HEAP32[$0 + 20 >> 2];
		 HEAP32[$0 + 92 >> 2] = $5;
		 $10 = HEAP32[$0 + 88 >> 2];
		 HEAP32[$0 + 88 >> 2] = $5;
		 if ($5) {
		  $5 = 0;
		  while (1) {
		   HEAP32[$4 >> 2] = $9;
		   HEAP32[$2 >> 2] = $8;
		   label$3 : {
		    if ($1) {
		     $6 = $5 << 2;
		     speex_resampler_process_float($0, $5, $6 + $1 | 0, $2, $3 + $6 | 0, $4);
		     break label$3;
		    }
		    speex_resampler_process_float($0, $5, 0, $2, ($5 << 2) + $3 | 0, $4);
		   }
		   $5 = $5 + 1 | 0;
		   if ($5 >>> 0 < HEAPU32[$0 + 20 >> 2]) {
		    continue;
		   }
		   break;
		  }
		 }
		 HEAP32[$0 + 92 >> 2] = $7;
		 HEAP32[$0 + 88 >> 2] = $10;
		 return HEAP32[$0 + 84 >> 2] == 8 | 0;
		}
		function silk_decode_signs($0, $1, $2, $3, $4, $5) {
		 var $6 = 0, $7 = 0, $8 = 0;
		 $6 = __stack_pointer - 16 | 0;
		 __stack_pointer = $6;
		 HEAP8[$6 + 15 | 0] = 0;
		 if (($2 | 0) >= 8) {
		  $8 = Math_imul(($3 << 1) + $4 << 16 >> 16, 7) + 8448 | 0;
		  $2 = $2 + 8 >> 4;
		  $3 = ($2 | 0) > 1 ? $2 : 1;
		  while (1) {
		   $2 = HEAP32[($7 << 2) + $5 >> 2];
		   if (($2 | 0) >= 1) {
		    $2 = $2 & 31;
		    HEAP8[$6 + 14 | 0] = HEAPU8[($2 >>> 0 < 6 ? $2 : 6) + $8 | 0];
		    $2 = 0;
		    while (1) {
		     $4 = ($2 << 1) + $1 | 0;
		     if (HEAP16[$4 >> 1] >= 1) {
		      HEAP16[$4 >> 1] = Math_imul((ec_dec_icdf($0, $6 + 14 | 0, 8) << 1) - 1 | 0, HEAPU16[$4 >> 1]);
		     }
		     $2 = $2 + 1 | 0;
		     if (($2 | 0) != 16) {
		      continue;
		     }
		     break;
		    }
		   }
		   $1 = $1 + 32 | 0;
		   $7 = $7 + 1 | 0;
		   if (($7 | 0) != ($3 | 0)) {
		    continue;
		   }
		   break;
		  }
		 }
		 __stack_pointer = $6 + 16 | 0;
		}
		function silk_gains_dequant($0, $1, $2, $3, $4) {
		 var $5 = 0, $6 = 0, $7 = 0, $8 = 0, $9 = 0;
		 if (($4 | 0) >= 1) {
		  while (1) {
		   $5 = HEAP8[$1 + $7 | 0];
		   $9 = $2;
		   label$3 : {
		    if (!($3 | $7)) {
		     $6 = HEAP8[$2 | 0] - 16 | 0;
		     $5 = ($5 | 0) > ($6 | 0) ? $5 : $6;
		     break label$3;
		    }
		    $5 = $5 - 4 | 0;
		    $6 = HEAP8[$2 | 0];
		    $8 = $6 + 8 | 0;
		    if (($5 | 0) > ($8 | 0)) {
		     $5 = (($5 << 1) - $8 | 0) + $6 | 0;
		     break label$3;
		    }
		    $5 = $5 + $6 | 0;
		   }
		   $5 = $5 << 24 >> 24 > 0 ? $5 : 0;
		   $5 = $5 << 24 >> 24 < 63 ? $5 : 63;
		   HEAP8[$9 | 0] = $5;
		   $5 = $5 & 255;
		   $5 = (Math_imul($5, 7281) >>> 16 | 0) + Math_imul($5, 29) | 0;
		   HEAP32[($7 << 2) + $0 >> 2] = silk_log2lin(($5 >>> 0 < 1877 ? $5 : 1877) + 2090 | 0);
		   $7 = $7 + 1 | 0;
		   if (($7 | 0) != ($4 | 0)) {
		    continue;
		   }
		   break;
		  }
		 }
		}
		function unquant_fine_energy($0, $1, $2, $3, $4, $5, $6) {
		 var $7 = 0, $8 = 0, $9 = 0, $10 = 0, $11 = Math_fround(0);
		 if (($1 | 0) < ($2 | 0)) {
		  $10 = ($6 | 0) > 1 ? $6 : 1;
		  while (1) {
		   $6 = 0;
		   $8 = ($1 << 2) + $4 | 0;
		   $7 = HEAP32[$8 >> 2];
		   if (($7 | 0) >= 1) {
		    while (1) {
		     $7 = ec_dec_bits($5, $7);
		     $9 = (Math_imul(HEAP32[$0 + 8 >> 2], $6) + $1 << 2) + $3 | 0;
		     $11 = Math_fround(Math_fround($7 | 0) + Math_fround(.5));
		     $7 = HEAP32[$8 >> 2];
		     HEAPF32[$9 >> 2] = HEAPF32[$9 >> 2] + Math_fround(Math_fround(Math_fround($11 * Math_fround(1 << 14 - $7)) * Math_fround(6103515625e-14)) + Math_fround(-0.5));
		     $6 = $6 + 1 | 0;
		     if (($10 | 0) != ($6 | 0)) {
		      continue;
		     }
		     break;
		    }
		   }
		   $1 = $1 + 1 | 0;
		   if (($2 | 0) != ($1 | 0)) {
		    continue;
		   }
		   break;
		  }
		 }
		}
		function silk_stereo_decode_pred($0, $1) {
		 var $2 = 0, $3 = 0, $4 = 0, $5 = 0, $6 = 0;
		 $2 = ec_dec_icdf($0, 6656, 8);
		 $4 = ec_dec_icdf($0, 6734, 8);
		 $6 = ec_dec_icdf($0, 6741, 8);
		 $3 = ec_dec_icdf($0, 6734, 8);
		 $5 = ($2 | 0) / 5 | 0;
		 $2 = $3 + Math_imul(Math_imul($5, -5) + $2 | 0, 3) << 1;
		 $3 = HEAP16[$2 + 6626 >> 1];
		 $2 = HEAP16[$2 + 6624 >> 1];
		 $3 = $3 - $2 | 0;
		 $3 = (Math_imul($3 & 65535, 6554) >>> 16 | 0) + Math_imul($3 >> 16, 6554) | 0;
		 $0 = Math_imul(ec_dec_icdf($0, 6741, 8) << 17 >> 16 | 1, $3) + $2 | 0;
		 HEAP32[$1 + 4 >> 2] = $0;
		 $2 = Math_imul($5, 3) + $4 << 1;
		 $4 = HEAP16[$2 + 6626 >> 1];
		 $2 = HEAP16[$2 + 6624 >> 1];
		 $4 = $4 - $2 | 0;
		 HEAP32[$1 >> 2] = (Math_imul(Math_imul($4 >> 16, 6554) + (Math_imul($4 & 65535, 6554) >>> 16 | 0) | 0, $6 << 17 >> 16 | 1) + $2 | 0) - $0;
		}
		function celt_decoder_init($0, $1, $2) {
		 var $3 = 0, $4 = 0;
		 $3 = -1;
		 $4 = opus_custom_mode_create(48e3, 960);
		 if ($2 >>> 0 <= 2) {
		  if (!$0) {
		   return -7;
		  }
		  $3 = memset($0, 0, (Math_imul((HEAP32[$4 + 4 >> 2] << 2) + 8288 | 0, $2) + (HEAP32[$4 + 8 >> 2] << 5) | 0) + 92 | 0);
		  HEAP32[$3 >> 2] = $4;
		  $0 = HEAP32[$4 + 4 >> 2];
		  HEAP32[$3 + 16 >> 2] = 1;
		  HEAP32[$3 + 20 >> 2] = 0;
		  HEAP32[$3 + 12 >> 2] = $2;
		  HEAP32[$3 + 8 >> 2] = $2;
		  HEAP32[$3 + 4 >> 2] = $0;
		  $4 = HEAP32[$4 + 12 >> 2];
		  HEAP32[$3 + 28 >> 2] = 1;
		  HEAP32[$3 + 32 >> 2] = ($2 | 0) == 1;
		  HEAP32[$3 + 36 >> 2] = 0;
		  HEAP32[$3 + 24 >> 2] = $4;
		  opus_custom_decoder_ctl($3, 4028, 0);
		  $2 = resampling_factor($1);
		  HEAP32[$3 + 16 >> 2] = $2;
		  $3 = $2 ? 0 : -1;
		 }
		 return $3;
		}
		function silk_bwexpander_32($0, $1, $2) {
		 var $3 = 0, $4 = 0, $5 = 0, $6 = 0, $7 = 0, $8 = 0;
		 $4 = $2 >> 16;
		 $5 = $1 - 1 | 0;
		 if (($1 | 0) >= 2) {
		  $7 = $2 - 65536 | 0;
		  $1 = 0;
		  while (1) {
		   $3 = ($1 << 2) + $0 | 0;
		   $8 = $3;
		   $3 = HEAP32[$3 >> 2];
		   $6 = $3 << 16 >> 16;
		   HEAP32[$8 >> 2] = ((Math_imul($6, $2 & 65535) >> 16) + Math_imul($4, $6) | 0) + Math_imul(($3 >> 15) + 1 >> 1, $2);
		   $2 = ((Math_imul($2, $7) >> 15) + 1 >> 1) + $2 | 0;
		   $4 = $2 >> 16;
		   $1 = $1 + 1 | 0;
		   if (($5 | 0) != ($1 | 0)) {
		    continue;
		   }
		   break;
		  }
		 }
		 $1 = ($5 << 2) + $0 | 0;
		 $0 = $1;
		 $1 = HEAP32[$1 >> 2];
		 $3 = $1 << 16 >> 16;
		 HEAP32[$0 >> 2] = ((Math_imul($3, $2 & 65535) >> 16) + Math_imul($3, $4) | 0) + Math_imul(($1 >> 15) + 1 >> 1, $2);
		}
		function silk_NLSF_unpack($0, $1, $2, $3) {
		 var $4 = 0, $5 = 0, $6 = 0;
		 $4 = HEAP16[$2 + 2 >> 1];
		 if (($4 | 0) >= 1) {
		  $5 = HEAP32[$2 + 24 >> 2] + ((Math_imul($4 & 65535, $3) | 0) / 2 | 0) | 0;
		  $3 = 0;
		  while (1) {
		   $4 = HEAPU8[$5 | 0];
		   HEAP16[($3 << 1) + $0 >> 1] = Math_imul($4 >>> 1 & 7, 9);
		   HEAP8[$1 + $3 | 0] = HEAPU8[HEAP32[$2 + 20 >> 2] + (Math_imul(HEAP16[$2 + 2 >> 1] - 1 | 0, $4 & 1) + $3 | 0) | 0];
		   $6 = $3 | 1;
		   HEAP16[($6 << 1) + $0 >> 1] = Math_imul($4 >>> 5 | 0, 9);
		   HEAP8[$1 + $6 | 0] = HEAPU8[HEAP32[$2 + 20 >> 2] + (Math_imul(HEAP16[$2 + 2 >> 1] - 1 | 0, $4 >>> 4 & 1) + $6 | 0) | 0];
		   $5 = $5 + 1 | 0;
		   $3 = $3 + 2 | 0;
		   if (($3 | 0) < HEAP16[$2 + 2 >> 1]) {
		    continue;
		   }
		   break;
		  }
		 }
		}
		function silk_insertion_sort_increasing_all_values_int16($0, $1) {
		 var $2 = 0, $3 = 0, $4 = 0, $5 = 0, $6 = 0;
		 $3 = 1;
		 if (($1 | 0) >= 1) {
		  if (($1 | 0) != 1) {
		   while (1) {
		    $5 = HEAP16[($3 << 1) + $0 >> 1];
		    $2 = $3;
		    label$4 : {
		     while (1) {
		      $6 = $2 - 1 | 0;
		      $4 = HEAP16[($6 << 1) + $0 >> 1];
		      if (($5 | 0) >= ($4 | 0)) {
		       break label$4;
		      }
		      HEAP16[($2 << 1) + $0 >> 1] = $4;
		      $4 = ($2 | 0) > 1;
		      $2 = $6;
		      if ($4) {
		       continue;
		      }
		      break;
		     }
		     $2 = 0;
		    }
		    HEAP16[($2 << 1) + $0 >> 1] = $5;
		    $3 = $3 + 1 | 0;
		    if (($3 | 0) != ($1 | 0)) {
		     continue;
		    }
		    break;
		   }
		  }
		  return;
		 }
		 celt_fatal(8629, 8617, 144);
		 abort();
		}
		function ec_dec_bits($0, $1) {
		 var $2 = 0, $3 = 0, $4 = 0, $5 = 0, $6 = 0, $7 = 0;
		 $4 = HEAP32[$0 + 12 >> 2];
		 $2 = HEAP32[$0 + 16 >> 2];
		 label$1 : {
		  if ($2 >>> 0 >= $1 >>> 0) {
		   $6 = $2;
		   break label$1;
		  }
		  $3 = HEAP32[$0 + 8 >> 2];
		  $7 = HEAP32[$0 + 4 >> 2];
		  while (1) {
		   $5 = 0;
		   if ($3 >>> 0 < $7 >>> 0) {
		    $3 = $3 + 1 | 0;
		    HEAP32[$0 + 8 >> 2] = $3;
		    $5 = HEAPU8[HEAP32[$0 >> 2] + ($7 - $3 | 0) | 0];
		   }
		   $4 = $5 << $2 | $4;
		   $5 = ($2 | 0) < 17;
		   $6 = $2 + 8 | 0;
		   $2 = $6;
		   if ($5) {
		    continue;
		   }
		   break;
		  }
		 }
		 HEAP32[$0 + 16 >> 2] = $6 - $1;
		 HEAP32[$0 + 12 >> 2] = $4 >>> $1;
		 HEAP32[$0 + 20 >> 2] = HEAP32[$0 + 20 >> 2] + $1;
		 return (-1 << $1 ^ -1) & $4;
		}
		function fmt_u($0, $1, $2) {
		 var $3 = 0, $4 = 0, $5 = 0, $6 = 0;
		 label$1 : {
		  if ($1 >>> 0 < 1) {
		   $5 = $0;
		   $3 = $1;
		   $6 = $3;
		   break label$1;
		  }
		  while (1) {
		   $2 = $2 - 1 | 0;
		   $3 = $1;
		   $5 = __wasm_i64_udiv($0, $3, 10, 0);
		   $3 = i64toi32_i32$HIGH_BITS;
		   $6 = $3;
		   $4 = __wasm_i64_mul($5, $3, 10, 0);
		   $3 = $1;
		   HEAP8[$2 | 0] = $0 - $4 | 48;
		   $4 = $3 >>> 0 > 9;
		   $0 = $5;
		   $3 = $6;
		   $1 = $3;
		   if ($4) {
		    continue;
		   }
		   break;
		  }
		 }
		 $4 = $5;
		 if ($4) {
		  while (1) {
		   $2 = $2 - 1 | 0;
		   $0 = ($4 >>> 0) / 10 | 0;
		   HEAP8[$2 | 0] = $4 - Math_imul($0, 10) | 48;
		   $1 = $4 >>> 0 > 9;
		   $4 = $0;
		   if ($1) {
		    continue;
		   }
		   break;
		  }
		 }
		 return $2;
		}
		function renormalise_vector($0, $1, $2, $3) {
		 var $4 = 0, $5 = Math_fround(0), $6 = Math_fround(0);
		 label$1 : {
		  if (($1 | 0) < 1) {
		   break label$1;
		  }
		  while (1) {
		   $6 = HEAPF32[($4 << 2) + $0 >> 2];
		   $5 = Math_fround($5 + Math_fround($6 * $6));
		   $4 = $4 + 1 | 0;
		   if (($4 | 0) != ($1 | 0)) {
		    continue;
		   }
		   break;
		  }
		  if (($1 | 0) < 1) {
		   break label$1;
		  }
		  $5 = Math_fround(Math_fround(Math_fround(1) / Math_fround(Math_sqrt(Math_fround($5 + Math_fround(1.0000000036274937e-15))))) * $2);
		  $4 = 0;
		  while (1) {
		   HEAPF32[$0 >> 2] = $5 * HEAPF32[$0 >> 2];
		   $0 = $0 + 4 | 0;
		   $4 = $4 + 1 | 0;
		   if (($4 | 0) != ($1 | 0)) {
		    continue;
		   }
		   break;
		  }
		 }
		}
		function scalbn($0, $1) {
		 label$1 : {
		  if (($1 | 0) >= 1024) {
		   $0 = $0 * 8.98846567431158e+307;
		   if (($1 | 0) < 2047) {
		    $1 = $1 - 1023 | 0;
		    break label$1;
		   }
		   $0 = $0 * 8.98846567431158e+307;
		   $1 = (($1 | 0) < 3069 ? $1 : 3069) - 2046 | 0;
		   break label$1;
		  }
		  if (($1 | 0) > -1023) {
		   break label$1;
		  }
		  $0 = $0 * 2.2250738585072014e-308;
		  if (($1 | 0) > -2045) {
		   $1 = $1 + 1022 | 0;
		   break label$1;
		  }
		  $0 = $0 * 2.2250738585072014e-308;
		  $1 = (($1 | 0) > -3066 ? $1 : -3066) + 2044 | 0;
		 }
		 $1 = $1 + 1023 << 20;
		 wasm2js_scratch_store_i32(0, 0);
		 wasm2js_scratch_store_i32(1, $1 | 0);
		 return $0 * +wasm2js_scratch_load_f64();
		}
		function silk_resampler_private_AR2($0, $1, $2, $3, $4) {
		 var $5 = 0, $6 = 0, $7 = 0, $8 = 0, $9 = 0;
		 if (($4 | 0) >= 1) {
		  $5 = HEAP32[$0 >> 2];
		  $6 = HEAP16[$3 + 2 >> 1];
		  $7 = HEAP16[$3 >> 1];
		  $3 = 0;
		  while (1) {
		   $5 = (HEAP16[($3 << 1) + $2 >> 1] << 8) + $5 | 0;
		   HEAP32[($3 << 2) + $1 >> 2] = $5;
		   $9 = HEAP32[$0 + 4 >> 2];
		   $5 = $5 << 2;
		   $8 = $5 & 65532;
		   $5 = $5 >> 16;
		   HEAP32[$0 + 4 >> 2] = (Math_imul($8, $6) >> 16) + Math_imul($6, $5);
		   $5 = (Math_imul($5, $7) + $9 | 0) + (Math_imul($7, $8) >> 16) | 0;
		   HEAP32[$0 >> 2] = $5;
		   $3 = $3 + 1 | 0;
		   if (($4 | 0) != ($3 | 0)) {
		    continue;
		   }
		   break;
		  }
		 }
		}
		function init_caps($0, $1, $2, $3) {
		 var $4 = 0, $5 = 0, $6 = 0, $7 = 0, $8 = 0, $9 = 0, $10 = 0, $11 = 0;
		 $4 = HEAP32[$0 + 8 >> 2];
		 if (($4 | 0) >= 1) {
		  $9 = (($2 << 1) + $3 | 0) - 1 | 0;
		  $10 = HEAP32[$0 + 104 >> 2];
		  $7 = HEAP32[$0 + 32 >> 2];
		  $6 = HEAPU16[$7 >> 1];
		  while (1) {
		   $11 = $6 << 16;
		   $8 = $5 + 1 | 0;
		   $6 = HEAP16[($8 << 1) + $7 >> 1];
		   HEAP32[($5 << 2) + $1 >> 2] = Math_imul(HEAPU8[(Math_imul($4, $9) + $5 | 0) + $10 | 0] - -64 | 0, Math_imul($6 - ($11 >> 16) << $2, $3)) >> 2;
		   $5 = $8;
		   $4 = HEAP32[$0 + 8 >> 2];
		   if (($5 | 0) < ($4 | 0)) {
		    continue;
		   }
		   break;
		  }
		 }
		}
		function resampling_factor($0) {
		 var $1 = 0;
		 label$1 : {
		  label$2 : {
		   label$3 : {
		    label$4 : {
		     if (($0 | 0) <= 15999) {
		      if (($0 | 0) == 8e3) {
		       break label$4;
		      }
		      if (($0 | 0) != 12e3) {
		       break label$3;
		      }
		      return 4;
		     }
		     if (($0 | 0) == 16e3) {
		      break label$2;
		     }
		     $1 = 1;
		     if (($0 | 0) == 48e3) {
		      break label$1;
		     }
		     if (($0 | 0) != 24e3) {
		      break label$3;
		     }
		     return 2;
		    }
		    return 6;
		   }
		   celt_fatal(1579, 1599, 84);
		   abort();
		  }
		  $1 = 3;
		 }
		 return $1;
		}
		function opus_custom_mode_create($0, $1, $2) {
		 var $3 = 0;
		 label$1 : {
		  label$2 : {
		   $3 = ($0 | 0) != 48e3;
		   if ((($1 | 0) == 960 ? !$3 : 0) | (($1 & 2147483647) == 480 ? !$3 : 0)) {
		    break label$2;
		   }
		   $0 = ($0 | 0) != 48e3;
		   if ((($1 & 1073741823) == 240 ? !$0 : 0) | (($1 & 536870911) == 120 ? !$0 : 0)) {
		    break label$2;
		   }
		   $1 = 0;
		   {
		    break label$1;
		   }
		  }
		  $1 = 9424;
		  {
		   break label$1;
		  }
		 }
		 return $1;
		}
		function silk_bwexpander($0, $1, $2) {
		 var $3 = 0, $4 = 0, $5 = 0;
		 $3 = $1 - 1 | 0;
		 if (($1 | 0) >= 2) {
		  $5 = $2 - 65536 | 0;
		  $1 = 0;
		  while (1) {
		   $4 = ($1 << 1) + $0 | 0;
		   HEAP16[$4 >> 1] = (Math_imul(HEAP16[$4 >> 1], $2) >>> 15 | 0) + 1 >>> 1;
		   $2 = ((Math_imul($2, $5) >> 15) + 1 >> 1) + $2 | 0;
		   $1 = $1 + 1 | 0;
		   if (($3 | 0) != ($1 | 0)) {
		    continue;
		   }
		   break;
		  }
		 }
		 $1 = ($3 << 1) + $0 | 0;
		 HEAP16[$1 >> 1] = (Math_imul(HEAP16[$1 >> 1], $2) >>> 15 | 0) + 1 >>> 1;
		}
		function _ZN17compiler_builtins3int3mul3Mul3mul17h070e9a1c69faec5bE($0, $1, $2, $3) {
		 var $4 = 0, $5 = 0;
		 $4 = $2 >>> 16 | 0;
		 $5 = $0 >>> 16 | 0;
		 $3 = (Math_imul($4, $5) + Math_imul($1, $2) | 0) + Math_imul($3, $0) | 0;
		 $2 = $2 & 65535;
		 $0 = $0 & 65535;
		 $1 = Math_imul($2, $0);
		 $2 = ($1 >>> 16 | 0) + Math_imul($2, $5) | 0;
		 $3 = $3 + ($2 >>> 16 | 0) | 0;
		 $2 = Math_imul($0, $4) + ($2 & 65535) | 0;
		 i64toi32_i32$HIGH_BITS = $3 + ($2 >>> 16 | 0) | 0;
		 return $1 & 65535 | $2 << 16;
		}
		function dlrealloc($0, $1) {
		 var $2 = 0, $3 = 0;
		 if (!$0) {
		  return dlmalloc($1);
		 }
		 if ($1 >>> 0 >= 4294967232) {
		  HEAP32[__errno_location() >> 2] = 48;
		  return 0;
		 }
		 $2 = try_realloc_chunk($0 - 8 | 0, $1 >>> 0 < 11 ? 16 : $1 + 11 & -8);
		 if ($2) {
		  return $2 + 8 | 0;
		 }
		 $2 = dlmalloc($1);
		 if (!$2) {
		  return 0;
		 }
		 $3 = HEAP32[$0 - 4 >> 2];
		 $3 = ($3 & 3 ? -4 : -8) + ($3 & -8) | 0;
		 memcpy($2, $0, $1 >>> 0 > $3 >>> 0 ? $3 : $1);
		 dlfree($0);
		 return $2;
		}
		function silk_log2lin($0) {
		 var $1 = 0, $2 = 0, $3 = 0;
		 $1 = 0;
		 label$1 : {
		  if (($0 | 0) < 0) {
		   break label$1;
		  }
		  $1 = 2147483647;
		  if (($0 | 0) > 3966) {
		   break label$1;
		  }
		  $1 = $0 & 127;
		  $2 = $0 >>> 7 | 0;
		  $3 = 1 << $2;
		  $0 = ($0 | 0) <= 2047 ? (Math_imul(Math_imul(128 - $1 | 0, $1), -174) >> 16) + $1 << $2 >> 7 : Math_imul((Math_imul(Math_imul(128 - $1 | 0, $1), -174) >> 16) + $1 | 0, $3 >>> 7 | 0);
		  $1 = $3 + $0 | 0;
		 }
		 return $1;
		}
		function pad($0, $1, $2, $3, $4) {
		 var $5 = 0;
		 $5 = __stack_pointer - 256 | 0;
		 __stack_pointer = $5;
		 if (!($4 & 73728 | ($2 | 0) <= ($3 | 0))) {
		  $2 = $2 - $3 | 0;
		  $3 = $2 >>> 0 < 256;
		  memset($5, $1 & 255, $3 ? $2 : 256);
		  if (!$3) {
		   while (1) {
		    out($0, $5, 256);
		    $2 = $2 - 256 | 0;
		    if ($2 >>> 0 > 255) {
		     continue;
		    }
		    break;
		   }
		  }
		  out($0, $5, $2);
		 }
		 __stack_pointer = $5 + 256 | 0;
		}
		function __stdio_seek($0, $1, $2, $3) {
		 $0 = $0 | 0;
		 $1 = $1 | 0;
		 $2 = $2 | 0;
		 $3 = $3 | 0;
		 var $4 = 0;
		 $4 = __stack_pointer - 16 | 0;
		 __stack_pointer = $4;
		 $0 = __wasi_syscall_ret(legalfunc$__wasi_fd_seek(HEAP32[$0 + 60 >> 2], $1, $2, $3 & 255, $4 + 8 | 0));
		 __stack_pointer = $4 + 16 | 0;
		 $2 = HEAP32[$4 + 12 >> 2];
		 i64toi32_i32$HIGH_BITS = $0 ? -1 : $2;
		 $1 = HEAP32[$4 + 8 >> 2];
		 return ($0 ? -1 : $1) | 0;
		}
		function sbrk($0) {
		 var $1 = 0, $2 = 0;
		 $1 = HEAP32[9756];
		 $2 = $0 + 3 & -4;
		 $0 = $1 + $2 | 0;
		 label$1 : {
		  if ($0 >>> 0 <= $1 >>> 0 ? ($2 | 0) >= 1 : 0) {
		   break label$1;
		  }
		  if (__wasm_memory_size() << 16 >>> 0 < $0 >>> 0) {
		   if (!(emscripten_resize_heap($0 | 0) | 0)) {
		    break label$1;
		   }
		  }
		  HEAP32[9756] = $0;
		  return $1;
		 }
		 HEAP32[__errno_location() >> 2] = 48;
		 return -1;
		}
		function silk_CNG_Reset($0) {
		 var $1 = 0, $2 = 0, $3 = 0, $4 = 0;
		 $1 = HEAP32[$0 + 2340 >> 2];
		 $4 = 32767 / ($1 + 1 | 0) | 0;
		 if (($1 | 0) >= 1) {
		  while (1) {
		   $3 = $4 + $3 | 0;
		   HEAP16[(($2 << 1) + $0 | 0) + 4052 >> 1] = $3;
		   $2 = $2 + 1 | 0;
		   if (($1 | 0) != ($2 | 0)) {
		    continue;
		   }
		   break;
		  }
		 }
		 $0 = $0 + 4148 | 0;
		 HEAP32[$0 >> 2] = 0;
		 HEAP32[$0 + 4 >> 2] = 3176576;
		}
		function __sin($0, $1, $2) {
		 var $3 = 0, $4 = 0, $5 = 0;
		 $3 = $0 * $0;
		 $5 = $3 * ($3 * $3) * ($3 * 1.58969099521155e-10 + -2.5050760253406863e-8) + ($3 * ($3 * 27557313707070068e-22 + -1984126982985795e-19) + .00833333333332249);
		 $4 = $3 * $0;
		 if (!$2) {
		  return $4 * ($3 * $5 + -0.16666666666666632) + $0;
		 }
		 return $0 - ($3 * ($1 * .5 - $4 * $5) - $1 + $4 * .16666666666666632);
		}
		function dlcalloc($0, $1) {
		 var $2 = 0, $3 = 0, $4 = 0;
		 $2 = 0;
		 label$2 : {
		  if (!$0) {
		   break label$2;
		  }
		  $3 = __wasm_i64_mul($0, 0, $1, 0);
		  $4 = i64toi32_i32$HIGH_BITS;
		  $2 = $3;
		  if (($0 | $1) >>> 0 < 65536) {
		   break label$2;
		  }
		  $2 = $4 ? -1 : $3;
		 }
		 $3 = $2;
		 $0 = dlmalloc($3);
		 if (!(!$0 | !(HEAPU8[$0 - 4 | 0] & 3))) {
		  memset($0, 0, $3);
		 }
		 return $0;
		}
		function __towrite($0) {
		 var $1 = 0;
		 $1 = HEAPU8[$0 + 74 | 0];
		 HEAP8[$0 + 74 | 0] = $1 | $1 - 1;
		 $1 = HEAP32[$0 >> 2];
		 if ($1 & 8) {
		  HEAP32[$0 >> 2] = $1 | 32;
		  return -1;
		 }
		 HEAP32[$0 + 4 >> 2] = 0;
		 HEAP32[$0 + 8 >> 2] = 0;
		 $1 = HEAP32[$0 + 44 >> 2];
		 HEAP32[$0 + 28 >> 2] = $1;
		 HEAP32[$0 + 20 >> 2] = $1;
		 HEAP32[$0 + 16 >> 2] = HEAP32[$0 + 48 >> 2] + $1;
		 return 0;
		}
		function isqrt32($0) {
		 var $1 = 0, $2 = 0, $3 = 0, $4 = 0, $5 = 0;
		 $2 = 31 - Math_clz32($0) >> 1;
		 $3 = 1 << $2;
		 while (1) {
		  $1 = ($4 << 1) + $3 << $2;
		  $5 = $1;
		  $1 = $0 >>> 0 < $1 >>> 0;
		  $0 = $0 - ($1 ? 0 : $5) | 0;
		  $4 = ($1 ? 0 : $3) + $4 | 0;
		  $1 = ($2 | 0) > 0;
		  $3 = $3 >>> 1 | 0;
		  $2 = $2 - 1 | 0;
		  if ($1) {
		   continue;
		  }
		  break;
		 }
		 return $4;
		}
		function opus_packet_get_samples_per_frame($0, $1) {
		 $0 = HEAPU8[$0 | 0];
		 if ($0 & 128) {
		  return ($1 << ($0 >>> 3 & 3)) / 400 | 0;
		 }
		 if (($0 & 96) == 96) {
		  if ($0 & 8) {
		   return ($1 | 0) / 50 | 0;
		  }
		  return ($1 | 0) / 100 | 0;
		 }
		 $0 = $0 >>> 3 & 3;
		 if (($0 | 0) == 3) {
		  return (Math_imul($1, 60) | 0) / 1e3 | 0;
		 }
		 return ($1 << $0) / 100 | 0;
		}
		function __cos($0, $1) {
		 var $2 = 0, $3 = 0, $4 = 0, $5 = 0;
		 $2 = $0 * $0;
		 $3 = $2 * .5;
		 $4 = 1 - $3;
		 $5 = 1 - $4 - $3;
		 $3 = $2 * $2;
		 return $4 + ($5 + ($2 * ($2 * ($2 * ($2 * 2480158728947673e-20 + -0.001388888888887411) + .0416666666666666) + $3 * $3 * ($2 * ($2 * -11359647557788195e-27 + 2.087572321298175e-9) + -2.7557314351390663e-7)) - $0 * $1));
		}
		function getint($0) {
		 var $1 = 0, $2 = 0, $3 = 0;
		 if (isdigit(HEAP8[HEAP32[$0 >> 2]])) {
		  while (1) {
		   $1 = HEAP32[$0 >> 2];
		   $3 = HEAP8[$1 | 0];
		   HEAP32[$0 >> 2] = $1 + 1;
		   $2 = (Math_imul($2, 10) + $3 | 0) - 48 | 0;
		   if (isdigit(HEAP8[$1 + 1 | 0])) {
		    continue;
		   }
		   break;
		  }
		 }
		 return $2;
		}
		function ec_tell_frac($0) {
		 var $1 = 0, $2 = 0, $3 = 0;
		 $2 = HEAP32[$0 + 20 >> 2] << 3;
		 $0 = HEAP32[$0 + 28 >> 2];
		 $1 = Math_clz32($0);
		 $0 = $0 >>> 16 - $1 | 0;
		 $3 = $0;
		 $0 = ($0 >>> 12 | 0) - 8 | 0;
		 return ((($2 + ($1 << 3) | 0) - ($3 >>> 0 > HEAPU32[($0 << 2) + 24240 >> 2]) | 0) - $0 | 0) - 256 | 0;
		}
		function ec_decode_bin($0, $1) {
		 var $2 = 0;
		 $2 = HEAP32[$0 + 28 >> 2] >>> $1 | 0;
		 HEAP32[$0 + 36 >> 2] = $2;
		 $1 = 1 << $1;
		 $0 = HEAPU32[$0 + 32 >> 2] / ($2 >>> 0) | 0;
		 $2 = $1 + ($0 ^ -1) | 0;
		 $0 = $0 + 1 | 0;
		 $1 = $0 - $1 | 0;
		 return $2 + ($0 >>> 0 < $1 >>> 0 ? 0 : $1) | 0;
		}
		function ec_decode($0, $1) {
		 var $2 = 0;
		 $2 = HEAPU32[$0 + 28 >> 2] / ($1 >>> 0) | 0;
		 HEAP32[$0 + 36 >> 2] = $2;
		 $0 = HEAPU32[$0 + 32 >> 2] / ($2 >>> 0) | 0;
		 $2 = ($0 ^ -1) + $1 | 0;
		 $0 = $0 + 1 | 0;
		 $1 = $0 - $1 | 0;
		 return $2 + ($0 >>> 0 < $1 >>> 0 ? 0 : $1) | 0;
		}
		function fmt_x($0, $1, $2, $3) {
		 if ($0 | $1) {
		  while (1) {
		   $2 = $2 - 1 | 0;
		   HEAP8[$2 | 0] = HEAPU8[($0 & 15) + 1520 | 0] | $3;
		   $0 = ($1 & 15) << 28 | $0 >>> 4;
		   $1 = $1 >>> 4 | 0;
		   if ($0 | $1) {
		    continue;
		   }
		   break;
		  }
		 }
		 return $2;
		}
		function silk_PLC_Reset($0) {
		 var $1 = 0;
		 $1 = $0 + 4244 | 0;
		 HEAP32[$1 >> 2] = 65536;
		 HEAP32[$1 + 4 >> 2] = 65536;
		 $1 = $0 + 4256 | 0;
		 HEAP32[$1 >> 2] = 2;
		 HEAP32[$1 + 4 >> 2] = 20;
		 HEAP32[$0 + 4172 >> 2] = HEAP32[$0 + 2328 >> 2] << 7;
		}
		function opus_decode_float($0, $1, $2, $3, $4, $5) {
		 $0 = $0 | 0;
		 $1 = $1 | 0;
		 $2 = $2 | 0;
		 $3 = $3 | 0;
		 $4 = $4 | 0;
		 $5 = $5 | 0;
		 if (($4 | 0) < 1) {
		  return -1;
		 }
		 return opus_decode_native($0, $1, $2, $3, $4, $5, 0) | 0;
		}
		function silk_InitDecoder($0) {
		 var $1 = 0;
		 silk_init_decoder($0);
		 $1 = silk_init_decoder($0 + 4264 | 0);
		 HEAP32[$0 + 8536 >> 2] = 0;
		 HEAP32[$0 + 8528 >> 2] = 0;
		 HEAP32[$0 + 8532 >> 2] = 0;
		 HEAP32[$0 + 8548 >> 2] = 0;
		 return $1;
		}
		function fmt_o($0, $1, $2) {
		 if ($0 | $1) {
		  while (1) {
		   $2 = $2 - 1 | 0;
		   HEAP8[$2 | 0] = $0 & 7 | 48;
		   $0 = ($1 & 7) << 29 | $0 >>> 3;
		   $1 = $1 >>> 3 | 0;
		   if ($0 | $1) {
		    continue;
		   }
		   break;
		  }
		 }
		 return $2;
		}
		function celt_fatal($0, $1, $2) {
		 var $3 = 0;
		 $3 = __stack_pointer - 16 | 0;
		 __stack_pointer = $3;
		 HEAP32[$3 + 8 >> 2] = $0;
		 HEAP32[$3 + 4 >> 2] = $2;
		 HEAP32[$3 >> 2] = $1;
		 fiprintf(HEAP32[256], 1536, $3);
		 abort();
		 abort();
		}
		function legalstub$dynCall_jiji($0, $1, $2, $3, $4) {
		 $0 = $0 | 0;
		 $1 = $1 | 0;
		 $2 = $2 | 0;
		 $3 = $3 | 0;
		 $4 = $4 | 0;
		 $0 = dynCall_jiji($0, $1, $2, $3, $4);
		 $2 = i64toi32_i32$HIGH_BITS;
		 setTempRet0($2 | 0);
		 return $0 | 0;
		}
		function speex_resampler_destroy($0) {
		 $0 = $0 | 0;
		 dlfree(HEAP32[$0 + 72 >> 2]);
		 dlfree(HEAP32[$0 + 76 >> 2]);
		 dlfree(HEAP32[$0 + 60 >> 2]);
		 dlfree(HEAP32[$0 + 68 >> 2]);
		 dlfree(HEAP32[$0 + 64 >> 2]);
		 dlfree($0);
		}
		function __DOUBLE_BITS($0) {
		 var $1 = 0, $2 = 0;
		 wasm2js_scratch_store_f64(+$0);
		 $1 = wasm2js_scratch_load_i32(1) | 0;
		 $2 = wasm2js_scratch_load_i32(0) | 0;
		 i64toi32_i32$HIGH_BITS = $1;
		 return $2;
		}
		function fiprintf($0, $1, $2) {
		 var $3 = 0;
		 $3 = __stack_pointer - 16 | 0;
		 __stack_pointer = $3;
		 HEAP32[$3 + 12 >> 2] = $2;
		 $2 = vfiprintf($0, $1, $2);
		 __stack_pointer = $3 + 16 | 0;
		 return $2;
		}
		function celt_decoder_get_size($0) {
		 var $1 = 0;
		 $1 = opus_custom_mode_create(48e3, 960);
		 return ((HEAP32[$1 + 8 >> 2] << 5) + Math_imul((HEAP32[$1 + 4 >> 2] << 2) + 8288 | 0, $0) | 0) + 92 | 0;
		}
		function silk_init_decoder($0) {
		 memset($0 + 4 | 0, 0, 4260);
		 HEAP32[$0 + 4168 >> 2] = 0;
		 HEAP32[$0 >> 2] = 65536;
		 HEAP32[$0 + 2376 >> 2] = 1;
		 silk_CNG_Reset($0);
		 silk_PLC_Reset($0);
		 return 0;
		}
		function speex_resampler_init($0, $1, $2, $3, $4) {
		 $0 = $0 | 0;
		 $1 = $1 | 0;
		 $2 = $2 | 0;
		 $3 = $3 | 0;
		 $4 = $4 | 0;
		 return speex_resampler_init_frac($0, $1, $2, $1, $2, $3, $4) | 0;
		}
		function __wasm_i64_udiv($0, $1, $2, $3) {
		 $3 = _ZN17compiler_builtins3int4udiv10divmod_u6417h6026910b5ed08e40E($0, $1, $2, $3);
		 return $3;
		}
		function __wasm_rotl_i32($0, $1) {
		 var $2 = 0;
		 $2 = $1 & 31;
		 $1 = 0 - $1 & 31;
		 return (-1 >>> $2 & $0) << $2 | (-1 << $1 & $0) >>> $1;
		}
		function legalfunc$__wasi_fd_seek($0, $1, $2, $3, $4) {
		 return legalimport$__wasi_fd_seek($0 | 0, $1 | 0, $2 | 0, $3 | 0, $4 | 0) | 0;
		}
		function __wasm_i64_mul($0, $1, $2, $3) {
		 $3 = _ZN17compiler_builtins3int3mul3Mul3mul17h070e9a1c69faec5bE($0, $1, $2, $3);
		 return $3;
		}
		function stackAlloc($0) {
		 $0 = $0 | 0;
		 $0 = __stack_pointer - $0 & -16;
		 __stack_pointer = $0;
		 return $0 | 0;
		}
		function silk_resampler_private_up2_HQ_wrapper($0, $1, $2, $3) {
		 silk_resampler_private_up2_HQ($0, $1, $2, $3);
		}
		function __wasi_syscall_ret($0) {
		 if (!$0) {
		  return 0;
		 }
		 HEAP32[__errno_location() >> 2] = $0;
		 return -1;
		}
		function dynCall_jiji($0, $1, $2, $3, $4) {
		 $3 = FUNCTION_TABLE[$0 | 0]($1, $2, $3, $4) | 0;
		 return $3;
		}
		function __stdio_close($0) {
		 $0 = $0 | 0;
		 return __wasi_fd_close(dummy(HEAP32[$0 + 60 >> 2]) | 0) | 0;
		}
		function __wasm_ctz_i32($0) {
		 if ($0) {
		  return 31 - Math_clz32($0 - 1 ^ $0) | 0;
		 }
		 return 32;
		}



		function silk_stereo_decode_mid_only($0, $1) {
		 HEAP32[$1 >> 2] = ec_dec_icdf($0, 6681, 8);
		}
		function out($0, $1, $2) {
		 if (!(HEAPU8[$0 | 0] & 32)) {
		  __fwritex($1, $2, $0);
		 }
		}
		function wctomb($0, $1) {
		 if (!$0) {
		  return 0;
		 }
		 return wcrtomb($0, $1, 0);
		}
		function vfiprintf($0, $1, $2) {
		 return __vfprintf_internal($0, $1, $2, 0, 0);
		}
		function celt_lcg_rand($0) {
		 return Math_imul($0, 1664525) + 1013904223 | 0;
		}
		function silk_Get_Decoder_Size($0) {
		 HEAP32[$0 >> 2] = 8552;
		 return 0;
		}
		function stackRestore($0) {
		 $0 = $0 | 0;
		 __stack_pointer = $0;
		}
		function opus_decoder_destroy($0) {
		 $0 = $0 | 0;
		 dlfree($0);
		}
		function stackSave() {
		 return __stack_pointer | 0;
		}
		function isdigit($0) {
		 return $0 - 48 >>> 0 < 10;
		}
		function floor($0) {
		 return Math_floor($0);
		}
		function __errno_location() {
		 return 39404;
		}
		function __pthread_self() {
		 return 39176;
		}
		function __lockfile($0) {
		 return 1;
		}
		function dummy($0) {
		 return $0;
		}
		function __wasm_call_ctors() {}
		 bufferView = HEAPU8;
		 initActiveSegments();
		 var FUNCTION_TABLE = Table([null, __stdio_close, __stdio_write, __stdio_seek, resampler_basic_direct_double, resampler_basic_direct_single, resampler_basic_interpolate_double, resampler_basic_interpolate_single, resampler_basic_zero]);
		 function __wasm_memory_size() {
		  return buffer.byteLength / 65536 | 0;
		}
		 
		 return {
		  "__wasm_call_ctors": __wasm_call_ctors, 
		  "opus_decoder_create": opus_decoder_create, 
		  "opus_decode_float": opus_decode_float, 
		  "opus_decoder_ctl": opus_decoder_ctl, 
		  "opus_decoder_destroy": opus_decoder_destroy, 
		  "speex_resampler_init": speex_resampler_init, 
		  "speex_resampler_destroy": speex_resampler_destroy, 
		  "speex_resampler_process_interleaved_float": speex_resampler_process_interleaved_float, 
		  "__errno_location": __errno_location, 
		  "stackSave": stackSave, 
		  "stackRestore": stackRestore, 
		  "stackAlloc": stackAlloc, 
		  "malloc": dlmalloc, 
		  "free": dlfree, 
		  "__indirect_function_table": FUNCTION_TABLE, 
		  "dynCall_jiji": legalstub$dynCall_jiji
		};
		}

		  return asmFunc(asmLibraryArg);
		}
		// EMSCRIPTEN_END_ASM




		)(asmLibraryArg);
		  },

		  instantiate: /** @suppress{checkTypes} */ function(binary, info) {
		    return {
		      then: function(ok) {
		        var module = new WebAssembly.Module(binary);
		        ok({
		          'instance': new WebAssembly.Instance(module)
		        });
		      }
		    };
		  },

		  RuntimeError: Error
		};

		// We don't need to actually download a wasm binary, mark it as present but empty.
		wasmBinary = [];

		// end include: wasm2js.js
		if (typeof WebAssembly !== 'object') {
		  abort('no native wasm support detected');
		}

		// end include: runtime_safe_heap.js
		// Wasm globals

		var wasmMemory;

		//========================================
		// Runtime essentials
		//========================================

		// whether we are quitting the application. no code should run after this.
		// set in exit() and abort()
		var ABORT = false;

		/** @type {function(*, string=)} */
		function assert(condition, text) {
		  if (!condition) {
		    abort('Assertion failed: ' + text);
		  }
		}

		// include: runtime_strings.js


		// runtime_strings.js: Strings related runtime functions that are part of both MINIMAL_RUNTIME and regular runtime.

		// Given a pointer 'ptr' to a null-terminated UTF8-encoded string in the given array that contains uint8 values, returns
		// a copy of that string as a Javascript String object.

		var UTF8Decoder = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf8') : undefined;

		/**
		 * @param {number} idx
		 * @param {number=} maxBytesToRead
		 * @return {string}
		 */
		function UTF8ArrayToString(heap, idx, maxBytesToRead) {
		  var endIdx = idx + maxBytesToRead;
		  var endPtr = idx;
		  // TextDecoder needs to know the byte length in advance, it doesn't stop on null terminator by itself.
		  // Also, use the length info to avoid running tiny strings through TextDecoder, since .subarray() allocates garbage.
		  // (As a tiny code save trick, compare endPtr against endIdx using a negation, so that undefined means Infinity)
		  while (heap[endPtr] && !(endPtr >= endIdx)) ++endPtr;

		  if (endPtr - idx > 16 && heap.subarray && UTF8Decoder) {
		    return UTF8Decoder.decode(heap.subarray(idx, endPtr));
		  } else {
		    var str = '';
		    // If building with TextDecoder, we have already computed the string length above, so test loop end condition against that
		    while (idx < endPtr) {
		      // For UTF8 byte structure, see:
		      // http://en.wikipedia.org/wiki/UTF-8#Description
		      // https://www.ietf.org/rfc/rfc2279.txt
		      // https://tools.ietf.org/html/rfc3629
		      var u0 = heap[idx++];
		      if (!(u0 & 0x80)) { str += String.fromCharCode(u0); continue; }
		      var u1 = heap[idx++] & 63;
		      if ((u0 & 0xE0) == 0xC0) { str += String.fromCharCode(((u0 & 31) << 6) | u1); continue; }
		      var u2 = heap[idx++] & 63;
		      if ((u0 & 0xF0) == 0xE0) {
		        u0 = ((u0 & 15) << 12) | (u1 << 6) | u2;
		      } else {
		        u0 = ((u0 & 7) << 18) | (u1 << 12) | (u2 << 6) | (heap[idx++] & 63);
		      }

		      if (u0 < 0x10000) {
		        str += String.fromCharCode(u0);
		      } else {
		        var ch = u0 - 0x10000;
		        str += String.fromCharCode(0xD800 | (ch >> 10), 0xDC00 | (ch & 0x3FF));
		      }
		    }
		  }
		  return str;
		}

		// Given a pointer 'ptr' to a null-terminated UTF8-encoded string in the emscripten HEAP, returns a
		// copy of that string as a Javascript String object.
		// maxBytesToRead: an optional length that specifies the maximum number of bytes to read. You can omit
		//                 this parameter to scan the string until the first \0 byte. If maxBytesToRead is
		//                 passed, and the string at [ptr, ptr+maxBytesToReadr[ contains a null byte in the
		//                 middle, then the string will cut short at that byte index (i.e. maxBytesToRead will
		//                 not produce a string of exact length [ptr, ptr+maxBytesToRead[)
		//                 N.B. mixing frequent uses of UTF8ToString() with and without maxBytesToRead may
		//                 throw JS JIT optimizations off, so it is worth to consider consistently using one
		//                 style or the other.
		/**
		 * @param {number} ptr
		 * @param {number=} maxBytesToRead
		 * @return {string}
		 */
		function UTF8ToString(ptr, maxBytesToRead) {
		  return ptr ? UTF8ArrayToString(HEAPU8, ptr, maxBytesToRead) : '';
		}

		// Given a pointer 'ptr' to a null-terminated UTF16LE-encoded string in the emscripten HEAP, returns
		// a copy of that string as a Javascript String object.

		typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-16le') : undefined;

		var /** @type {ArrayBuffer} */
		  buffer,
		/** @type {Uint8Array} */
		  HEAPU8,
		/** @type {Int32Array} */
		  HEAP32;

		function updateGlobalBufferAndViews(buf) {
		  buffer = buf;
		  Module['HEAP8'] = new Int8Array(buf);
		  Module['HEAP16'] = new Int16Array(buf);
		  Module['HEAP32'] = HEAP32 = new Int32Array(buf);
		  Module['HEAPU8'] = HEAPU8 = new Uint8Array(buf);
		  Module['HEAPU16'] = new Uint16Array(buf);
		  Module['HEAPU32'] = new Uint32Array(buf);
		  Module['HEAPF32'] = new Float32Array(buf);
		  Module['HEAPF64'] = new Float64Array(buf);
		}

		var INITIAL_MEMORY = Module['INITIAL_MEMORY'] || 16777216;

		// In non-standalone/normal mode, we create the memory here.
		// include: runtime_init_memory.js


		// Create the wasm memory. (Note: this only applies if IMPORTED_MEMORY is defined)

		  if (Module['wasmMemory']) {
		    wasmMemory = Module['wasmMemory'];
		  } else
		  {
		    wasmMemory = new WebAssembly.Memory({
		      'initial': INITIAL_MEMORY / 65536
		      ,
		      'maximum': INITIAL_MEMORY / 65536
		    });
		  }

		if (wasmMemory) {
		  buffer = wasmMemory.buffer;
		}

		// If the user provides an incorrect length, just use that length instead rather than providing the user to
		// specifically provide the memory length with Module['INITIAL_MEMORY'].
		INITIAL_MEMORY = buffer.byteLength;
		updateGlobalBufferAndViews(buffer);

		// end include: runtime_init_memory.js

		// include: runtime_init_table.js
		// In regular non-RELOCATABLE mode the table is exported
		// from the wasm module and this will be assigned once
		// the exports are available.
		var wasmTable;

		// end include: runtime_init_table.js
		// include: runtime_stack_check.js


		// end include: runtime_stack_check.js
		// include: runtime_assertions.js


		// end include: runtime_assertions.js
		var __ATPRERUN__  = []; // functions called before the runtime is initialized
		var __ATINIT__    = []; // functions called during startup
		var __ATMAIN__    = []; // functions called when main() is to be run
		var __ATPOSTRUN__ = []; // functions called after the main() is called

		__ATINIT__.push({ func: function() { ___wasm_call_ctors(); } });

		function preRun() {

		  if (Module['preRun']) {
		    if (typeof Module['preRun'] == 'function') Module['preRun'] = [Module['preRun']];
		    while (Module['preRun'].length) {
		      addOnPreRun(Module['preRun'].shift());
		    }
		  }

		  callRuntimeCallbacks(__ATPRERUN__);
		}

		function initRuntime() {
		  
		  callRuntimeCallbacks(__ATINIT__);
		}

		function preMain() {
		  
		  callRuntimeCallbacks(__ATMAIN__);
		}

		function postRun() {

		  if (Module['postRun']) {
		    if (typeof Module['postRun'] == 'function') Module['postRun'] = [Module['postRun']];
		    while (Module['postRun'].length) {
		      addOnPostRun(Module['postRun'].shift());
		    }
		  }

		  callRuntimeCallbacks(__ATPOSTRUN__);
		}

		function addOnPreRun(cb) {
		  __ATPRERUN__.unshift(cb);
		}

		function addOnPostRun(cb) {
		  __ATPOSTRUN__.unshift(cb);
		}

		// include: runtime_math.js


		// https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Math/imul

		// https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Math/fround

		// https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Math/clz32

		// https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Math/trunc

		// end include: runtime_math.js
		// A counter of dependencies for calling run(). If we need to
		// do asynchronous work before running, increment this and
		// decrement it. Incrementing must happen in a place like
		// Module.preRun (used by emcc to add file preloading).
		// Note that you can add dependencies in preRun, even though
		// it happens right before run - run will be postponed until
		// the dependencies are met.
		var runDependencies = 0;
		var dependenciesFulfilled = null; // overridden to take different actions when all run dependencies are fulfilled

		function addRunDependency(id) {
		  runDependencies++;

		  if (Module['monitorRunDependencies']) {
		    Module['monitorRunDependencies'](runDependencies);
		  }

		}

		function removeRunDependency(id) {
		  runDependencies--;

		  if (Module['monitorRunDependencies']) {
		    Module['monitorRunDependencies'](runDependencies);
		  }

		  if (runDependencies == 0) {
		    if (dependenciesFulfilled) {
		      var callback = dependenciesFulfilled;
		      dependenciesFulfilled = null;
		      callback(); // can add another dependenciesFulfilled
		    }
		  }
		}

		Module["preloadedImages"] = {}; // maps url to image data
		Module["preloadedAudios"] = {}; // maps url to audio data

		/** @param {string|number=} what */
		function abort(what) {
		  if (Module['onAbort']) {
		    Module['onAbort'](what);
		  }

		  what += '';
		  err(what);

		  ABORT = true;

		  what = 'abort(' + what + '). Build with -s ASSERTIONS=1 for more info.';

		  // Use a wasm runtime error, because a JS error might be seen as a foreign
		  // exception, which means we'd run destructors on it. We need the error to
		  // simply make the program stop.
		  var e = new WebAssembly.RuntimeError(what);

		  // Throw the error whether or not MODULARIZE is set because abort is used
		  // in code paths apart from instantiation where an exception is expected
		  // to be thrown when abort is called.
		  throw e;
		}

		// {{MEM_INITIALIZER}}

		// include: memoryprofiler.js


		// end include: memoryprofiler.js
		// include: URIUtils.js


		function hasPrefix(str, prefix) {
		  return String.prototype.startsWith ?
		      str.startsWith(prefix) :
		      str.indexOf(prefix) === 0;
		}

		// Prefix of data URIs emitted by SINGLE_FILE and related options.
		var dataURIPrefix = 'data:application/octet-stream;base64,';

		// Indicates whether filename is a base64 data URI.
		function isDataURI(filename) {
		  return hasPrefix(filename, dataURIPrefix);
		}

		// end include: URIUtils.js
		var wasmBinaryFile = '<<< WASM_BINARY_FILE >>>';
		if (!isDataURI(wasmBinaryFile)) {
		  wasmBinaryFile = locateFile(wasmBinaryFile);
		}

		function getBinary(file) {
		  try {
		    if (file == wasmBinaryFile && wasmBinary) {
		      return new Uint8Array(wasmBinary);
		    }
		    var binary = tryParseAsDataURI(file);
		    if (binary) {
		      return binary;
		    }
		    if (readBinary) {
		      return readBinary(file);
		    } else {
		      throw "sync fetching of the wasm failed: you can preload it to Module['wasmBinary'] manually, or emcc.py will do that for you when generating HTML (but not JS)";
		    }
		  }
		  catch (err) {
		    abort(err);
		  }
		}

		function instantiateSync(file, info) {
		  var instance;
		  var module;
		  var binary;
		  try {
		    binary = getBinary(file);
		    module = new WebAssembly.Module(binary);
		    instance = new WebAssembly.Instance(module, info);
		  } catch (e) {
		    var str = e.toString();
		    err('failed to compile wasm module: ' + str);
		    if (str.indexOf('imported Memory') >= 0 ||
		        str.indexOf('memory import') >= 0) {
		      err('Memory size incompatibility issues may be due to changing INITIAL_MEMORY at runtime to something too large. Use ALLOW_MEMORY_GROWTH to allow any size memory (and also make sure not to set INITIAL_MEMORY at runtime to something smaller than it was at compile time).');
		    }
		    throw e;
		  }
		  return [instance, module];
		}

		// Create the wasm instance.
		// Receives the wasm imports, returns the exports.
		function createWasm() {
		  // prepare imports
		  var info = {
		    'env': asmLibraryArg,
		    'wasi_snapshot_preview1': asmLibraryArg,
		  };
		  // Load the wasm module and create an instance of using native support in the JS engine.
		  // handle a generated wasm instance, receiving its exports and
		  // performing other necessary setup
		  /** @param {WebAssembly.Module=} module*/
		  function receiveInstance(instance, module) {
		    var exports$1 = instance.exports;

		    Module['asm'] = exports$1;

		    wasmTable = Module['asm']['__indirect_function_table'];

		    removeRunDependency();
		  }
		  // we can't run yet (except in a pthread, where we have a custom sync instantiator)
		  addRunDependency();

		  // Prefer streaming instantiation if available.

		  // User shell pages can write their own Module.instantiateWasm = function(imports, successCallback) callback
		  // to manually instantiate the Wasm module themselves. This allows pages to run the instantiation parallel
		  // to any other async startup actions they are performing.
		  if (Module['instantiateWasm']) {
		    try {
		      var exports$1 = Module['instantiateWasm'](info, receiveInstance);
		      return exports$1;
		    } catch(e) {
		      err('Module.instantiateWasm callback failed with error: ' + e);
		      return false;
		    }
		  }

		  var result = instantiateSync(wasmBinaryFile, info);
		  receiveInstance(result[0]);
		  return Module['asm']; // exports were assigned here
		}






		  function callRuntimeCallbacks(callbacks) {
		      while(callbacks.length > 0) {
		        var callback = callbacks.shift();
		        if (typeof callback == 'function') {
		          callback(Module); // Pass the module as the first argument.
		          continue;
		        }
		        var func = callback.func;
		        if (typeof func === 'number') {
		          if (callback.arg === undefined) {
		            wasmTable.get(func)();
		          } else {
		            wasmTable.get(func)(callback.arg);
		          }
		        } else {
		          func(callback.arg === undefined ? null : callback.arg);
		        }
		      }
		    }

		  function _abort() {
		      abort();
		    }

		  function _emscripten_memcpy_big(dest, src, num) {
		      HEAPU8.copyWithin(dest, src, src + num);
		    }
		  
		  function abortOnCannotGrowMemory(requestedSize) {
		      abort('OOM');
		    }
		  function _emscripten_resize_heap(requestedSize) {
		      abortOnCannotGrowMemory();
		    }

		  var SYSCALLS={mappings:{},buffers:[null,[],[]],printChar:function(stream, curr) {
		        var buffer = SYSCALLS.buffers[stream];
		        if (curr === 0 || curr === 10) {
		          (stream === 1 ? out : err)(UTF8ArrayToString(buffer, 0));
		          buffer.length = 0;
		        } else {
		          buffer.push(curr);
		        }
		      },varargs:undefined,get:function() {
		        SYSCALLS.varargs += 4;
		        var ret = HEAP32[(((SYSCALLS.varargs)-(4))>>2)];
		        return ret;
		      },getStr:function(ptr) {
		        var ret = UTF8ToString(ptr);
		        return ret;
		      },get64:function(low, high) {
		        return low;
		      }};
		  function _fd_close(fd) {
		      return 0;
		    }

		  function _fd_seek(fd, offset_low, offset_high, whence, newOffset) {
		  }
		  function _fd_write(fd, iov, iovcnt, pnum) {
		      // hack to support printf in SYSCALLS_REQUIRE_FILESYSTEM=0
		      var num = 0;
		      for (var i = 0; i < iovcnt; i++) {
		        var ptr = HEAP32[(((iov)+(i*8))>>2)];
		        var len = HEAP32[(((iov)+(i*8 + 4))>>2)];
		        for (var j = 0; j < len; j++) {
		          SYSCALLS.printChar(fd, HEAPU8[ptr+j]);
		        }
		        num += len;
		      }
		      HEAP32[((pnum)>>2)] = num;
		      return 0;
		    }

		function intArrayToString(array) {
		  var ret = [];
		  for (var i = 0; i < array.length; i++) {
		    var chr = array[i];
		    if (chr > 0xFF) {
		      chr &= 0xFF;
		    }
		    ret.push(String.fromCharCode(chr));
		  }
		  return ret.join('');
		}


		// Copied from https://github.com/strophe/strophejs/blob/e06d027/src/polyfills.js#L149

		// This code was written by Tyler Akins and has been placed in the
		// public domain.  It would be nice if you left this header intact.
		// Base64 code from Tyler Akins -- http://rumkin.com

		/**
		 * Decodes a base64 string.
		 * @param {string} input The string to decode.
		 */
		var decodeBase64 = typeof atob === 'function' ? atob : function (input) {
		  var keyStr = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';

		  var output = '';
		  var chr1, chr2, chr3;
		  var enc1, enc2, enc3, enc4;
		  var i = 0;
		  // remove all characters that are not A-Z, a-z, 0-9, +, /, or =
		  input = input.replace(/[^A-Za-z0-9\+\/\=]/g, '');
		  do {
		    enc1 = keyStr.indexOf(input.charAt(i++));
		    enc2 = keyStr.indexOf(input.charAt(i++));
		    enc3 = keyStr.indexOf(input.charAt(i++));
		    enc4 = keyStr.indexOf(input.charAt(i++));

		    chr1 = (enc1 << 2) | (enc2 >> 4);
		    chr2 = ((enc2 & 15) << 4) | (enc3 >> 2);
		    chr3 = ((enc3 & 3) << 6) | enc4;

		    output = output + String.fromCharCode(chr1);

		    if (enc3 !== 64) {
		      output = output + String.fromCharCode(chr2);
		    }
		    if (enc4 !== 64) {
		      output = output + String.fromCharCode(chr3);
		    }
		  } while (i < input.length);
		  return output;
		};

		// Converts a string of base64 into a byte array.
		// Throws error on invalid input.
		function intArrayFromBase64(s) {
		  if (typeof ENVIRONMENT_IS_NODE === 'boolean' && ENVIRONMENT_IS_NODE) {
		    var buf;
		    try {
		      // TODO: Update Node.js externs, Closure does not recognize the following Buffer.from()
		      /**@suppress{checkTypes}*/
		      buf = Buffer.from(s, 'base64');
		    } catch (_) {
		      buf = new Buffer(s, 'base64');
		    }
		    return new Uint8Array(buf['buffer'], buf['byteOffset'], buf['byteLength']);
		  }

		  try {
		    var decoded = decodeBase64(s);
		    var bytes = new Uint8Array(decoded.length);
		    for (var i = 0 ; i < decoded.length ; ++i) {
		      bytes[i] = decoded.charCodeAt(i);
		    }
		    return bytes;
		  } catch (_) {
		    throw new Error('Converting base64 string to bytes failed.');
		  }
		}

		// If filename is a base64 data URI, parses and returns data (Buffer on node,
		// Uint8Array otherwise). If filename is not a base64 data URI, returns undefined.
		function tryParseAsDataURI(filename) {
		  if (!isDataURI(filename)) {
		    return;
		  }

		  return intArrayFromBase64(filename.slice(dataURIPrefix.length));
		}


		var asmLibraryArg = {
		  "abort": _abort,
		  "emscripten_memcpy_big": _emscripten_memcpy_big,
		  "emscripten_resize_heap": _emscripten_resize_heap,
		  "fd_close": _fd_close,
		  "fd_seek": _fd_seek,
		  "fd_write": _fd_write,
		  "getTempRet0": getTempRet0,
		  "memory": wasmMemory,
		  "setTempRet0": setTempRet0
		};
		var asm = createWasm();
		/** @type {function(...*):?} */
		var ___wasm_call_ctors = Module["___wasm_call_ctors"] = asm["__wasm_call_ctors"];

		/** @type {function(...*):?} */
		Module["_opus_decoder_create"] = asm["opus_decoder_create"];

		/** @type {function(...*):?} */
		Module["_opus_decode_float"] = asm["opus_decode_float"];

		/** @type {function(...*):?} */
		Module["_opus_decoder_ctl"] = asm["opus_decoder_ctl"];

		/** @type {function(...*):?} */
		Module["_opus_decoder_destroy"] = asm["opus_decoder_destroy"];

		/** @type {function(...*):?} */
		Module["_speex_resampler_init"] = asm["speex_resampler_init"];

		/** @type {function(...*):?} */
		Module["_speex_resampler_destroy"] = asm["speex_resampler_destroy"];

		/** @type {function(...*):?} */
		Module["_speex_resampler_process_interleaved_float"] = asm["speex_resampler_process_interleaved_float"];

		/** @type {function(...*):?} */
		Module["___errno_location"] = asm["__errno_location"];

		/** @type {function(...*):?} */
		Module["stackSave"] = asm["stackSave"];

		/** @type {function(...*):?} */
		Module["stackRestore"] = asm["stackRestore"];

		/** @type {function(...*):?} */
		Module["stackAlloc"] = asm["stackAlloc"];

		/** @type {function(...*):?} */
		Module["_malloc"] = asm["malloc"];

		/** @type {function(...*):?} */
		Module["_free"] = asm["free"];

		/** @type {function(...*):?} */
		Module["dynCall_jiji"] = asm["dynCall_jiji"];





		// === Auto-generated postamble setup entry stuff ===



		var calledRun;

		/**
		 * @constructor
		 * @this {ExitStatus}
		 */
		function ExitStatus(status) {
		  this.name = "ExitStatus";
		  this.message = "Program terminated with exit(" + status + ")";
		  this.status = status;
		}

		dependenciesFulfilled = function runCaller() {
		  // If run has never been called, and we should call run (INVOKE_RUN is true, and Module.noInitialRun is not false)
		  if (!calledRun) run();
		  if (!calledRun) dependenciesFulfilled = runCaller; // try this again later, after new deps are fulfilled
		};

		/** @type {function(Array=)} */
		function run(args) {

		  if (runDependencies > 0) {
		    return;
		  }

		  preRun();

		  // a preRun added a dependency, run will be called later
		  if (runDependencies > 0) {
		    return;
		  }

		  function doRun() {
		    // run may have just been called through dependencies being fulfilled just in this very frame,
		    // or while the async setStatus time below was happening
		    if (calledRun) return;
		    calledRun = true;
		    Module['calledRun'] = true;

		    if (ABORT) return;

		    initRuntime();

		    preMain();

		    if (Module['onRuntimeInitialized']) Module['onRuntimeInitialized']();

		    postRun();
		  }

		  if (Module['setStatus']) {
		    Module['setStatus']('Running...');
		    setTimeout(function() {
		      setTimeout(function() {
		        Module['setStatus']('');
		      }, 1);
		      doRun();
		    }, 1);
		  } else
		  {
		    doRun();
		  }
		}
		Module['run'] = run;

		if (Module['preInit']) {
		  if (typeof Module['preInit'] == 'function') Module['preInit'] = [Module['preInit']];
		  while (Module['preInit'].length > 0) {
		    Module['preInit'].pop()();
		  }
		}

		run();






		return Module;
		}, 'OpusDecoderLib'));//END: UMD wrapper 
	} (libopusDecoder$3));
	return libopusDecoder$3.exports;
}

var libopusDecoderExports = requireLibopusDecoder();
var libopusDecoder = /*@__PURE__*/getDefaultExportFromCjs(libopusDecoderExports);

var libopusDecoder$1 = /*#__PURE__*/_mergeNamespaces({
    __proto__: null,
    default: libopusDecoder
}, [libopusDecoderExports]);

var oggOpusDecoder$2 = {exports: {}};

var hasRequiredOggOpusDecoder;

function requireOggOpusDecoder () {
	if (hasRequiredOggOpusDecoder) return oggOpusDecoder$2.exports;
	hasRequiredOggOpusDecoder = 1;
	(function (module, exports$1) {
		var OggOpusDecoder = function( config, Module ){

		  if ( !Module ) {
		    throw new Error('Module with exports required to initialize a decoder instance');
		  }

		  // this.mainReady = mainReady; // Expose for unit testingthis.isReady = Module.isReady;
		  this.isReady = Module.isReady;
		  if(!this.isReady){
		    Module.onready = function(){
		      this.isReady = true;
		      this.onready && this.onready();
		    };
		  }

		  this.config = Object.assign({
		    // bufferLength: 4096, // Define size of outgoing buffer
		    decoderSampleRate: 48000, // Desired decoder sample rate.
		    outputBufferSampleRate: 48000, // Desired output sample rate. Audio will be resampled
		    resampleQuality: 3, // Value between 0 and 10 inclusive. 10 being highest quality.
		  }, config );

		  // encode "raw" opus stream?
		  // -> either config.rawOpus = true/false,
		  //    or config.mimeType = 'audio/opus'
		  //   (instead of 'audio/ogg; codecs=opus')
		  this.rawOpus = typeof this.config.rawOpus === 'boolean'?
		                  this.config.rawOpus :
		                  /^audio\/opus\b/i.test(this.config.mimeType);

		  this._opus_decoder_create = Module._opus_decoder_create;
		  this._opus_decoder_destroy = Module._opus_decoder_destroy;
		  this._opus_decoder_ctl = Module._opus_decoder_ctl;
		  this._speex_resampler_process_interleaved_float = Module._speex_resampler_process_interleaved_float;
		  this._speex_resampler_init = Module._speex_resampler_init;
		  this._speex_resampler_destroy = Module._speex_resampler_destroy;
		  this._opus_decode_float = Module._opus_decode_float;
		  this._free = Module._free;
		  this._malloc = Module._malloc;
		  this.HEAPU8 = Module.HEAPU8;
		  this.HEAP32 = Module.HEAP32;
		  this.HEAPF32 = Module.HEAPF32;

		  // this.outputBuffers = [];
		  this.decodedBuffers = [];
		  this.completed = false;

		  if(this.config.onInit){
		    this.oninit = this.config.onInit;
		  }

		  if(this.config.onComplete){
		    this.oncomplete = this.config.onComplete;
		  }

		  if(this.config.numberOfChannels > 0){
		    this.numberOfChannels = this.config.numberOfChannels;
		    this.init();
		  }
		};


		OggOpusDecoder.prototype.decode = function( typedArray, onDecoded, userData ) {
		  onDecoded = onDecoded || this.handleDecoded;
		  var dataView = new DataView( typedArray.buffer );
		  this.getPageBoundaries( dataView ).map( function( pageStart ) {
		    var headerType = dataView.getUint8( pageStart + 5, true );
		    var pageIndex = dataView.getUint32( pageStart + 18, true );

		    // Beginning of stream
		    if ( headerType & 2 ) {
		      this.numberOfChannels = dataView.getUint8( pageStart + 37, true );
		      this.init();
		    }

		    // Decode page
		    if ( pageIndex > 1 ) {
		      var segmentTableLength = dataView.getUint8( pageStart + 26, true );
		      var segmentTableIndex = pageStart + 27 + segmentTableLength;

		      for ( var i = 0; i < segmentTableLength; i++ ) {
		        var packetLength = dataView.getUint8( pageStart + 27 + i, true );
		        this.decoderBuffer.set( typedArray.subarray( segmentTableIndex, segmentTableIndex += packetLength ), this.decoderBufferIndex );
		        this.decoderBufferIndex += packetLength;

		        if ( packetLength < 255 ) {
		          var outputSampleLength = this._opus_decode_float( this.decoder, this.decoderBufferPointer, this.decoderBufferIndex, this.decoderOutputPointer, this.decoderOutputMaxLength, 0);
		          var resampledLength = Math.ceil( outputSampleLength * this.config.outputBufferSampleRate / this.config.decoderSampleRate );
		          this.HEAP32[ this.decoderOutputLengthPointer >> 2 ] = outputSampleLength;
		          this.HEAP32[ this.resampleOutputLengthPointer >> 2 ] = resampledLength;
		          this._speex_resampler_process_interleaved_float( this.resampler, this.decoderOutputPointer, this.decoderOutputLengthPointer, this.resampleOutputBufferPointer, this.resampleOutputLengthPointer );
		          onDecoded.call(this, this.HEAPF32.subarray( this.resampleOutputBufferPointer >> 2, (this.resampleOutputBufferPointer >> 2) + resampledLength * this.numberOfChannels ), userData );
		          this.decoderBufferIndex = 0;
		        }
		      }

		      // End of stream
		      if ( headerType & 4 ) {
		        this.completed = true;
		        if(this.oncomplete){
		          this.oncomplete( userData );
		        }
		      }
		    }
		  }, this );
		};

		OggOpusDecoder.prototype.decodeRaw = function( typedArray, onDecoded, userData ) {

		  onDecoded = onDecoded || this.handleDecoded;
		  var dataLength = typedArray.length * typedArray.BYTES_PER_ELEMENT;
		  if(dataLength === 0){
		    return;
		  }

		  var dataOffset=0;
		  if ( typeof this.numberOfChannels === 'undefined' ) {

		    // this.numberOfChannels = typedArray[0] & 0x04 ? 2 : 1;

		    var headerLength = this.decodeHeader( typedArray, this.config.readTags );
		    this.init();

		    if ( headerLength > 0 ) {
		      if ( headerLength >= dataLength ) {
		        return;
		      }
		      dataOffset += headerLength;
		    }
		  }

		  while ( dataOffset < dataLength ) {
		    var packetLength = Math.min( dataLength - dataOffset, this.decoderBufferMaxLength );
		    this.decoderBuffer.set( typedArray.subarray( dataOffset, dataOffset += packetLength ), this.decoderBufferIndex );
		    this.decoderBufferIndex += packetLength;

		    // Decode raw opus packet
		    var outputSampleLength = this._opus_decode_float( this.decoder, this.decoderBufferPointer, typedArray.length, this.decoderOutputPointer, this.decoderOutputMaxLength, 0);
		    var output;
		    if ( this.resampler ) {
		      var resampledLength = Math.ceil( outputSampleLength * this.config.outputBufferSampleRate / this.config.decoderSampleRate );
		      this.HEAP32[ this.decoderOutputLengthPointer >> 2 ] = outputSampleLength;
		      this.HEAP32[ this.resampleOutputLengthPointer >> 2 ] = resampledLength;
		      this._speex_resampler_process_interleaved_float( this.resampler, this.decoderOutputPointer, this.decoderOutputLengthPointer, this.resampleOutputBufferPointer, this.resampleOutputLengthPointer );
		      output = this.HEAPF32.subarray( this.resampleOutputBufferPointer >> 2, (this.resampleOutputBufferPointer >> 2) + resampledLength * this.numberOfChannels );
		    } else {
		      output = this.HEAPF32.subarray( this.decoderOutputPointer >> 2, (this.decoderOutputPointer >> 2) + outputSampleLength * this.numberOfChannels );
		    }
		    onDecoded.call(this, output, userData );
		    this.decoderBufferIndex = 0;
		  }

		  if(this.oncomplete){
		    this.oncomplete( userData );
		  }

		  return;
		};

		OggOpusDecoder.prototype.handleDecoded = function( typedArray ) {
		  this.decodedBuffers.push( typedArray );
		};

		OggOpusDecoder.prototype.decodeHeader = function( typedArray, readTags ) {

		  var invalid = false;
		  var segmentDataView = new DataView( typedArray.buffer );
		  invalid = invalid || (segmentDataView.getUint32( 0, true ) !== 1937076303); // Magic Signature 'Opus'
		  invalid = invalid || (segmentDataView.getUint32( 4, true ) !== 1684104520); // Magic Signature 'Head'
		  invalid = invalid || (segmentDataView.getUint8(  8 ) !== 1); // Version

		  if(invalid){
		    return false;
		  }
		  this.numberOfChannels = segmentDataView.getUint8( 9 ); // Channel count
		  invalid = invalid || (!isFinite(this.numberOfChannels) || this.numberOfChannels < 0 || this.numberOfChannels > 2);

		  if(invalid){
		    this.numberOfChannels = undefined;
		    return false;
		  }
		  var sampleRate = segmentDataView.getUint32( 12, true ); // sample rate
		  invalid = invalid || (!isFinite(sampleRate) || sampleRate < 0 || !this.config);

		  if(invalid){
		    return false;
		  }
		  this.config.decoderSampleRate = sampleRate;

		  var headerSize = 19;
		  var channelMapping = segmentDataView.getUint8( 18 ); // channel map 0 = mono or stereo
		  if(channelMapping > 0){
		    var channelCount = segmentDataView.getUint8( 19 ); // channel count (only encoded, if channel map != 0)
		    headerSize += 2 + ( channelCount * 8 ); // additional header length, when channel mapping family is != 0
		  }

		  var size = typedArray.length * typedArray.BYTES_PER_ELEMENT;
		  if(size > headerSize){
		    var tagsSize;
		    while(tagsSize = this.decodeTags(typedArray, headerSize, readTags)){
		      headerSize += tagsSize;
		      if(headerSize >= size){
		        break;
		      }
		    }
		  }

		  return headerSize;
		};

		OggOpusDecoder.prototype.decodeTags = function( typedArray, offset, readTags ) {

		  offset = offset || 0;
		  var invalid = false;
		  var tag = readTags? {vendor: null, userComments: []} : null;
		  var segmentDataView = new DataView( typedArray.buffer, offset );
		  invalid = invalid || (segmentDataView.getUint32( 0, true ) !== 1937076303); // Magic Signature 'Opus'
		  invalid = invalid || (segmentDataView.getUint32( 4, true ) !== 1936154964); // Magic Signature 'Tags'

		  if(invalid){
		    return false;
		  }
		  var vendorLength = segmentDataView.getUint32( 8, true ); // vendor string length
		  if(tag){
		    tag.vendor = new Uint8Array(segmentDataView, 12, vendorLength);
		  }
		  var userCommentsListLength = segmentDataView.getUint32( 12 + vendorLength, true ); // size of user comments list
		  var size = 16 + vendorLength;
		  if(userCommentsListLength > 0){
		    var length;
		    for(var i=0; i < userCommentsListLength; ++i){
		      length = segmentDataView.getUint32( size, true ); // length of user comment string <i>
		      if(tag){
		        tag.userComments.push(new Uint8Array(segmentDataView, size + 4, length));
		      }
		      size += 4 + length;
		    }
		  }
		  // NOTE in difference to Vorbis Comments, no final 'framing bit' for OpusTags

		  if(tag){
		    if(!this.tags){
		      this.tags = [ tag ];
		    } else {
		      this.tags.push(tag);
		    }
		  }
		  return size;
		};

		OggOpusDecoder.prototype.getPageBoundaries = function( dataView ){
		  var pageBoundaries = [];

		  for ( var i = 0; i < dataView.byteLength - 32; i++ ) {
		    if ( dataView.getUint32( i, true ) == 1399285583 ) {
		      pageBoundaries.push( i );
		    }
		  }

		  return pageBoundaries;
		};

		OggOpusDecoder.prototype.getPitch = function(){
		  return this.getOpusControl( 4033 );
		};

		OggOpusDecoder.prototype.getOpusControl = function( control ){
		  var location = this._malloc( 4 );
		  this._opus_decoder_ctl( this.decoder, control, location );
		  var value = this.HEAP32[ location >> 2 ];
		  this._free( location );
		  return value;
		};

		OggOpusDecoder.prototype.init = function(){
		  this.initCodec();
		  this.initResampler();
		  if(this.oninit){
		    this.oninit();
		  }
		};

		OggOpusDecoder.prototype.initCodec = function() {

		  this.destroyDecoder();

		  var errReference = this._malloc( 4 );
		  this.decoder = this._opus_decoder_create( this.config.decoderSampleRate, this.numberOfChannels, errReference );
		  this._free( errReference );

		  this.decoderBufferMaxLength = 4000;
		  this.decoderBufferPointer = this._malloc( this.decoderBufferMaxLength );
		  this.decoderBuffer = this.HEAPU8.subarray( this.decoderBufferPointer, this.decoderBufferPointer + this.decoderBufferMaxLength );
		  this.decoderBufferIndex = 0;

		  this.decoderOutputLengthPointer = this._malloc( 4 );
		  this.decoderOutputMaxLength = this.config.decoderSampleRate * this.numberOfChannels * 120 / 1000; // Max 120ms frame size
		  this.decoderOutputPointer = this._malloc( this.decoderOutputMaxLength * 4 ); // 4 bytes per sample
		};

		OggOpusDecoder.prototype.initResampler = function() {

		  this.destroyResampler();

		  if ( this.config.decoderSampleRate === this.config.outputBufferSampleRate ) {
		    this.resampler = null;
		    return;
		  }

		  var errLocation = this._malloc( 4 );
		  this.resampler = this._speex_resampler_init( this.numberOfChannels, this.config.decoderSampleRate, this.config.outputBufferSampleRate, this.config.resampleQuality, errLocation );
		  this._free( errLocation );

		  this.resampleOutputLengthPointer = this._malloc( 4 );
		  this.resampleOutputMaxLength = Math.ceil( this.decoderOutputMaxLength * this.config.outputBufferSampleRate / this.config.decoderSampleRate );
		  this.resampleOutputBufferPointer = this._malloc( this.resampleOutputMaxLength * 4 ); // 4 bytes per sample
		};

		OggOpusDecoder.prototype.destroyDecoder = function() {
		  if ( this.decoder ) {
		    this._opus_decoder_destroy( this.decoder );
		    this._free( this.decoderBufferPointer );
		    this._free( this.decoderOutputLengthPointer );
		    this._free( this.decoderOutputPointer );
		  }
		};

		OggOpusDecoder.prototype.destroyResampler = function() {
		  if ( this.resampler ) {
		    this._speex_resampler_destroy( this.resampler );
		    this._free( this.resampleOutputLengthPointer );
		    this._free( this.resampleOutputBufferPointer );
		  }
		};

		OggOpusDecoder.prototype.destroy = function() {
		  this.destroyDecoder();
		  this.decoderBuffer = null;
		  this.destroyResampler();
		  this.decodedBuffers = null;
		};

		{
		  exports$1.OggOpusDecoder = OggOpusDecoder;
		} 
	} (oggOpusDecoder$2, oggOpusDecoder$2.exports));
	return oggOpusDecoder$2.exports;
}

var oggOpusDecoderExports = requireOggOpusDecoder();
var oggOpusDecoder = /*@__PURE__*/getDefaultExportFromCjs(oggOpusDecoderExports);

var oggOpusDecoder$1 = /*#__PURE__*/_mergeNamespaces({
    __proto__: null,
    default: oggOpusDecoder
}, [oggOpusDecoderExports]);

export { MessageType, SendspinPlayer, SendspinTimeFilter, detectIsAndroid, detectIsIOS, detectIsMobile, getDefaultSyncDelay };
