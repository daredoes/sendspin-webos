var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/sendspin-core.entry.mjs
var sendspin_core_entry_exports = {};
__export(sendspin_core_entry_exports, {
  MessageType: () => MessageType,
  SendspinPlayer: () => SendspinPlayer,
  SendspinTimeFilter: () => SendspinTimeFilter
});
module.exports = __toCommonJS(sendspin_core_entry_exports);

// src/gst-audio-processor.mjs
var GstAudioProcessor = class {
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
    if (this.sink && this.sink.codec === format.codec && this.sink.sampleRate === format.sample_rate) {
      return;
    }
    if (this.sink) {
      this.sink.stop();
      this.sink = null;
    }
    this.sink = this.createSink(format);
    this.updateVolume();
  }
  // No-ops: there is no AudioContext to resume and no <audio> element to drive.
  resumeAudioContext() {
  }
  startAudioElement() {
  }
  stopAudioElement() {
  }
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
      this.sink.write(Buffer.from(bytes.buffer, bytes.byteOffset + 9, bytes.length - 9));
    }
  }
  // Music Assistant volume/mute commands land here. Apply them to OUR pulse
  // sink-input only (gst-sink uses `pactl set-sink-input-volume`), so the stream
  // volume changes while the TV's own/master volume is left alone. stateManager
  // holds the 0..100 volume + muted flag set by the protocol before this call.
  updateVolume() {
    if (!this.sink || typeof this.sink.setVolume !== "function") {
      return;
    }
    const vol = this.stateManager ? this.stateManager.volume : 100;
    const muted = this.stateManager ? this.stateManager.muted : false;
    this.sink.setVolume(vol, muted);
  }
  setSyncDelay(delayMs) {
    const d = Math.round(delayMs);
    this.syncDelayMs = Math.max(0, Math.min(5e3, isFinite(d) ? d : 0));
  }
  getSyncDelayMs() {
    return this.syncDelayMs;
  }
  setCorrectionMode(mode) {
    this.correctionMode = mode;
  }
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
};

// src/sendspin-core.entry.mjs
var STATE_UPDATE_INTERVAL = 5e3;
var TIME_SYNC_BURST_SIZE = 8;
var TIME_SYNC_BURST_INTERVAL_MS = 1e4;
var TIME_SYNC_REQUEST_TIMEOUT_MS = 2e3;
var TIME_SYNC_ROBUST_SELECTION_COUNT = 3;
var ProtocolHandler = class {
  constructor(playerId, wsManager, audioProcessor, stateManager, timeFilter, config = {}) {
    var _a, _b, _c, _d, _e;
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
    this.clientName = (_a = config.clientName) != null ? _a : "Sendspin Player";
    this.codecs = (_b = config.codecs) != null ? _b : ["opus", "flac", "pcm"];
    this.bufferCapacity = (_c = config.bufferCapacity) != null ? _c : 1024 * 1024 * 5;
    this.useHardwareVolume = (_d = config.useHardwareVolume) != null ? _d : false;
    this.useOutputLatencyCompensation = (_e = config.useOutputLatencyCompensation) != null ? _e : true;
    this.onVolumeCommand = config.onVolumeCommand;
    this.onDelayCommand = config.onDelayCommand;
    this.getExternalVolume = config.getExternalVolume;
  }
  // Handle WebSocket messages
  handleMessage(event) {
    if (typeof event.data === "string") {
      const message = JSON.parse(event.data);
      this.handleServerMessage(message);
    } else if (event.data instanceof ArrayBuffer) {
      this.audioProcessor.handleBinaryMessage(event.data);
    } else if (event.data instanceof Blob) {
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
    this.sendStateUpdate();
    this.stopTimeSync();
    this.startTimeSyncBurstIfIdle();
    this.scheduleNextTimeSyncBurstTick();
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
    if (!this.timeSyncBurstActive || this.timeSyncInFlightClientTransmitted !== null || !this.wsManager.isConnected()) {
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
    if (!this.timeSyncBurstActive || this.timeSyncInFlightClientTransmitted !== expectedClientTransmitted) {
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
    const topRttSamples = [...this.timeSyncBurstSamples].sort((a, b) => a.rttTerm - b.rttTerm).slice(0, Math.min(TIME_SYNC_ROBUST_SELECTION_COUNT, this.timeSyncBurstSamples.length));
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
    if (!this.timeSyncBurstActive || this.timeSyncInFlightClientTransmitted === null) {
      return;
    }
    const T1 = message.payload.client_transmitted;
    if (T1 !== this.timeSyncInFlightClientTransmitted) {
      console.warn("Sendspin: Ignoring out-of-order time response", T1, this.timeSyncInFlightClientTransmitted);
      return;
    }
    const T4 = Math.floor(performance.now() * 1e3);
    const T2 = message.payload.server_received;
    const T3 = message.payload.server_transmitted;
    const measurement = (T2 - T1 + (T3 - T4)) / 2;
    const rttTerm = Math.max(0, T4 - T1 - (T3 - T2));
    const maxError = Math.max(1e3, rttTerm / 2);
    this.timeSyncBurstSamples.push({
      measurement,
      maxError,
      t4: T4,
      rttTerm
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
    console.log(isFormatUpdate ? "Sendspin: Stream format updated" : "Sendspin: Stream started", this.stateManager.currentStreamFormat);
    console.log("Sendspin: Codec=".concat(this.stateManager.currentStreamFormat.codec.toUpperCase(), ", ") + "SampleRate=".concat(this.stateManager.currentStreamFormat.sample_rate, "Hz, ") + "Channels=".concat(this.stateManager.currentStreamFormat.channels, ", ") + "BitDepth=".concat(this.stateManager.currentStreamFormat.bit_depth, "bit"));
    this.audioProcessor.initAudioContext();
    this.audioProcessor.resumeAudioContext();
    if (!isFormatUpdate) {
      this.audioProcessor.clearBuffers();
    }
    this.stateManager.isPlaying = true;
    this.audioProcessor.startAudioElement();
    if (typeof navigator !== "undefined" && navigator.mediaSession) {
      navigator.mediaSession.playbackState = "playing";
    }
  }
  // Handle stream clear (for seek operations)
  handleStreamClear(message) {
    const roles = message.payload.roles;
    if (!roles || roles.includes("player")) {
      console.log("Sendspin: Stream clear (seek)");
      this.audioProcessor.clearBuffers();
    }
  }
  // Handle stream end
  handleStreamEnd(message) {
    var _a;
    const roles = (_a = message.payload) == null ? void 0 : _a.roles;
    if (!roles || roles.includes("player")) {
      console.log("Sendspin: Stream ended");
      this.audioProcessor.clearBuffers();
      this.stateManager.currentStreamFormat = null;
      this.stateManager.isPlaying = false;
      this.audioProcessor.stopAudioElement();
      if (typeof navigator !== "undefined" && navigator.mediaSession) {
        navigator.mediaSession.playbackState = "paused";
      }
      this.sendStateUpdate();
    }
  }
  // Handle server commands
  handleServerCommand(message) {
    var _a;
    const playerCommand = message.payload.player;
    if (!playerCommand)
      return;
    switch (playerCommand.command) {
      case "volume":
        if (playerCommand.volume !== void 0) {
          this.stateManager.volume = playerCommand.volume;
          this.audioProcessor.updateVolume();
          if (this.useHardwareVolume && this.onVolumeCommand) {
            this.onVolumeCommand(playerCommand.volume, this.stateManager.muted);
          }
        }
        break;
      case "mute":
        if (playerCommand.mute !== void 0) {
          this.stateManager.muted = playerCommand.mute;
          this.audioProcessor.updateVolume();
          if (this.useHardwareVolume && this.onVolumeCommand) {
            this.onVolumeCommand(this.stateManager.volume, playerCommand.mute);
          }
        }
        break;
      case "set_static_delay": {
        const delay = playerCommand.static_delay_ms;
        if (typeof delay === "number" && isFinite(delay)) {
          const clamped = Math.max(0, Math.min(5e3, Math.round(delay)));
          this.audioProcessor.setSyncDelay(clamped);
          (_a = this.onDelayCommand) == null ? void 0 : _a.call(this, clamped);
        }
        break;
      }
    }
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
          manufacturer: typeof navigator !== "undefined" && navigator.vendor || "Unknown",
          software_version: typeof navigator !== "undefined" && navigator.userAgent || "Unknown"
        },
        "player@v1_support": {
          supported_formats: this.getSupportedFormats(),
          buffer_capacity: this.bufferCapacity,
          supported_commands: ["volume", "mute"]
        }
      }
    };
    this.wsManager.send(hello);
  }
  // Get supported codecs for the current browser
  getBrowserSupportedCodecs() {
    const userAgent = typeof navigator !== "undefined" ? navigator.userAgent : "";
    const isSafari = /^((?!chrome|android).)*safari/i.test(userAgent);
    const isFirefox = /firefox/i.test(userAgent);
    const hasNativeOpus = typeof AudioDecoder !== "undefined";
    if (!hasNativeOpus) {
      if (typeof window !== "undefined" && !window.isSecureContext) {
        console.warn("[Opus] Running in insecure context, falling back to FLAC/PCM");
      } else {
        console.warn("[Opus] Native decoder not available, falling back to FLAC/PCM");
      }
    }
    if (isSafari) {
      return /* @__PURE__ */ new Set(["pcm", "opus"]);
    }
    if (isFirefox) {
      return /* @__PURE__ */ new Set(["pcm", "flac"]);
    }
    if (hasNativeOpus) {
      return /* @__PURE__ */ new Set(["pcm", "opus", "flac"]);
    }
    return /* @__PURE__ */ new Set(["pcm", "flac"]);
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
        formats.push({
          codec: "opus",
          sample_rate: 48e3,
          channels: 2,
          bit_depth: 16
        });
      } else {
        formats.push({ codec, sample_rate: 48e3, channels: 2, bit_depth: 16 });
        formats.push({ codec, sample_rate: 44100, channels: 2, bit_depth: 16 });
      }
    }
    if (formats.length === 0) {
      throw new Error("No supported codecs: requested [".concat(this.codecs.join(", "), "], ") + "browser supports [".concat([...browserSupported].join(", "), "]"));
    }
    return formats;
  }
  // Send time synchronization message
  sendTimeSync(clientTimeUs = Math.floor(performance.now() * 1e3)) {
    const message = {
      type: "client/time",
      payload: {
        client_transmitted: clientTimeUs
      }
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
    const staticDelayMs = Math.max(0, Math.min(5e3, Math.round(syncDelayMs)));
    const message = {
      type: "client/state",
      payload: {
        player: {
          state: this.stateManager.playerState,
          volume,
          muted,
          static_delay_ms: staticDelayMs,
          supported_commands: ["set_static_delay"]
        }
      }
    };
    this.wsManager.send(message);
  }
  // Send goodbye message before disconnecting
  sendGoodbye(reason) {
    this.wsManager.send({
      type: "client/goodbye",
      payload: {
        reason
      }
    });
  }
  // Send controller command to server
  sendCommand(command, params) {
    this.wsManager.send({
      type: "client/command",
      payload: {
        controller: {
          command,
          ...params
        }
      }
    });
  }
};
function applyDiff(existing, diff) {
  const result = { ...existing };
  for (const key of Object.keys(diff)) {
    const value = diff[key];
    if (value === null) {
      delete result[key];
    } else if (value !== void 0) {
      const existingValue = result[key];
      if (typeof value === "object" && !Array.isArray(value) && typeof existingValue === "object" && existingValue !== null && !Array.isArray(existingValue)) {
        result[key] = applyDiff(existingValue, value);
      } else {
        result[key] = value;
      }
    }
  }
  return result;
}
var StateManager = class {
  constructor(onStateChange) {
    this._volume = 100;
    this._muted = false;
    this._playerState = "synchronized";
    this._isPlaying = false;
    this._currentStreamFormat = null;
    this._streamStartServerTime = 0;
    this._streamStartAudioTime = 0;
    this._streamGeneration = 0;
    this._serverState = {};
    this._groupState = {};
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
        groupState: this._groupState
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
};
var WebSocketManager = class {
  constructor() {
    this.ws = null;
    this.reconnectTimeout = null;
    this.shouldReconnect = false;
  }
  // Connect to WebSocket server
  async connect(url, onOpen, onMessage, onError, onClose) {
    this.onOpenHandler = onOpen;
    this.onMessageHandler = onMessage;
    this.onErrorHandler = onError;
    this.onCloseHandler = onClose;
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
          if (this.shouldReconnect) {
            this.scheduleReconnect(url);
          }
        };
      } catch (error) {
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
    }, 5e3);
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
    } else {
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
};
var ADAPTIVE_FORGETTING_CUTOFF = 2;
var SendspinTimeFilter = class {
  constructor(offset_process_std_dev = 0.01, forget_factor = 1.1, drift_significance_threshold = 2, drift_process_std_dev = 0) {
    this._last_update = 0;
    this._count = 0;
    this._offset = 0;
    this._drift = 0;
    this._offset_covariance = Infinity;
    this._offset_drift_covariance = 0;
    this._drift_covariance = 0;
    this._use_drift = false;
    this._offset_process_variance = offset_process_std_dev * offset_process_std_dev;
    this._drift_process_variance = drift_process_std_dev * drift_process_std_dev;
    this._forget_variance_factor = forget_factor * forget_factor;
    this._drift_significance_threshold_squared = drift_significance_threshold * drift_significance_threshold;
    this._current_time_element = this._createDefaultTimeElement();
  }
  /**
   * Create a default TimeElement with zero values.
   * Single source of truth for default initialization.
   */
  _createDefaultTimeElement() {
    return {
      last_update: 0,
      offset: 0,
      drift: 0
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
      return;
    }
    const dt = time_added - this._last_update;
    this._last_update = time_added;
    const update_std_dev = max_error;
    const measurement_variance = update_std_dev * update_std_dev;
    if (this._count <= 0) {
      this._count += 1;
      this._offset = measurement;
      this._offset_covariance = measurement_variance;
      this._drift = 0;
      this._current_time_element = {
        last_update: this._last_update,
        offset: this._offset,
        drift: this._drift
      };
      this._use_drift = false;
      return;
    }
    if (this._count === 1) {
      this._count += 1;
      this._drift = (measurement - this._offset) / dt;
      this._offset = measurement;
      this._drift_covariance = (this._offset_covariance + measurement_variance) / (dt * dt);
      this._offset_covariance = measurement_variance;
      this._current_time_element = {
        last_update: this._last_update,
        offset: this._offset,
        drift: this._drift
      };
      this._use_drift = false;
      return;
    }
    const offset = this._offset + this._drift * dt;
    const dt_squared = dt * dt;
    const drift_process_variance = dt * this._drift_process_variance;
    let new_drift_covariance = this._drift_covariance + drift_process_variance;
    const offset_drift_process_variance = 0;
    let new_offset_drift_covariance = this._offset_drift_covariance + this._drift_covariance * dt + offset_drift_process_variance;
    const offset_process_variance = dt * this._offset_process_variance;
    let new_offset_covariance = this._offset_covariance + 2 * this._offset_drift_covariance * dt + this._drift_covariance * dt_squared + offset_process_variance;
    const residual = measurement - offset;
    const max_residual_cutoff = max_error * ADAPTIVE_FORGETTING_CUTOFF;
    if (this._count < 100) {
      this._count += 1;
    } else if (Math.abs(residual) > max_residual_cutoff) {
      new_drift_covariance *= this._forget_variance_factor;
      new_offset_drift_covariance *= this._forget_variance_factor;
      new_offset_covariance *= this._forget_variance_factor;
    }
    const uncertainty = 1 / (new_offset_covariance + measurement_variance);
    const offset_gain = new_offset_covariance * uncertainty;
    const drift_gain = new_offset_drift_covariance * uncertainty;
    this._offset = offset + offset_gain * residual;
    this._drift += drift_gain * residual;
    this._drift_covariance = new_drift_covariance - drift_gain * new_offset_drift_covariance;
    this._offset_drift_covariance = new_offset_drift_covariance - drift_gain * new_offset_covariance;
    this._offset_covariance = new_offset_covariance - offset_gain * new_offset_covariance;
    const drift_squared = this._drift * this._drift;
    this._use_drift = drift_squared > this._drift_significance_threshold_squared * this._drift_covariance;
    this._current_time_element = {
      last_update: this._last_update,
      offset: this._offset,
      drift: this._drift
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
    const dt = client_time - this._current_time_element.last_update;
    const effective_drift = this._use_drift ? this._current_time_element.drift : 0;
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
    const effective_drift = this._use_drift ? this._current_time_element.drift : 0;
    return Math.round((server_time - this._current_time_element.offset + effective_drift * this._current_time_element.last_update) / (1 + effective_drift));
  }
  /**
   * Reset the filter state.
   */
  reset() {
    this._count = 0;
    this._offset = 0;
    this._drift = 0;
    this._offset_covariance = Infinity;
    this._offset_drift_covariance = 0;
    this._drift_covariance = 0;
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
};
var MessageType;
(function(MessageType2) {
  MessageType2["CLIENT_HELLO"] = "client/hello";
  MessageType2["SERVER_HELLO"] = "server/hello";
  MessageType2["CLIENT_TIME"] = "client/time";
  MessageType2["SERVER_TIME"] = "server/time";
  MessageType2["CLIENT_STATE"] = "client/state";
  MessageType2["SERVER_STATE"] = "server/state";
  MessageType2["CLIENT_COMMAND"] = "client/command";
  MessageType2["CLIENT_GOODBYE"] = "client/goodbye";
  MessageType2["SERVER_COMMAND"] = "server/command";
  MessageType2["STREAM_START"] = "stream/start";
  MessageType2["STREAM_CLEAR"] = "stream/clear";
  MessageType2["STREAM_REQUEST_FORMAT"] = "stream/request-format";
  MessageType2["STREAM_END"] = "stream/end";
  MessageType2["GROUP_UPDATE"] = "group/update";
})(MessageType || (MessageType = {}));
function detectIsAndroid() {
  if (typeof navigator === "undefined")
    return false;
  return /Android/i.test(navigator.userAgent);
}
function detectIsIOS() {
  if (typeof navigator === "undefined")
    return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
}
function detectIsMobile() {
  return detectIsAndroid() || detectIsIOS();
}
function generateRandomId() {
  return Math.random().toString(36).substring(2, 6);
}
var SendspinPlayer = class {
  constructor(config) {
    var _a, _b;
    this.wsUrl = "";
    this.ownsAudioElement = false;
    const randomId = generateRandomId();
    const playerId = (_a = config.playerId) != null ? _a : "sendspin-js-".concat(randomId);
    const clientName = (_b = config.clientName) != null ? _b : "Sendspin JS Client (".concat(randomId, ")");
    const isAndroid = detectIsAndroid();
    const isMobile = detectIsMobile();
    const outputMode = config.audioElement || isMobile ? "media-element" : "direct";
    this.ownsAudioElement = outputMode === "media-element" && !config.audioElement;
    if (this.ownsAudioElement && typeof document === "undefined") {
      throw new Error("SendspinPlayer requires a DOM document to use media-element output without a provided audioElement.");
    }
    this.config = {
      ...config,
      playerId,
      clientName
    };
    this.timeFilter = new SendspinTimeFilter(0, 1.1, 2, 1e-12);
    this.stateManager = new StateManager(config.onStateChange);
    let storage = null;
    if (config.storage !== void 0) {
      storage = config.storage;
    } else if (typeof localStorage !== "undefined") {
      storage = localStorage;
    }
    this.audioProcessor = new GstAudioProcessor(this.stateManager, this.timeFilter, this.config);
    this.wsManager = new WebSocketManager();
    this.protocolHandler = new ProtocolHandler(playerId, this.wsManager, this.audioProcessor, this.stateManager, this.timeFilter, {
      clientName,
      codecs: config.codecs,
      bufferCapacity: config.bufferCapacity,
      useHardwareVolume: config.useHardwareVolume,
      onVolumeCommand: config.onVolumeCommand,
      onDelayCommand: config.onDelayCommand,
      getExternalVolume: config.getExternalVolume,
      useOutputLatencyCompensation: config.useOutputLatencyCompensation
    });
  }
  // Connect to Sendspin server
  async connect() {
    const url = new URL(this.config.baseUrl);
    const wsProtocol = url.protocol === "https:" ? "wss:" : "ws:";
    this.wsUrl = "".concat(wsProtocol, "//").concat(url.host, "/sendspin");
    await this.wsManager.connect(
      this.wsUrl,
      // onOpen
      () => {
        this._authed = false;
        if (this.config.authToken) {
          console.log("Sendspin: authenticating player_id:", this.config.playerId);
          this.wsManager.send({ type: "auth", token: this.config.authToken, client_id: this.config.playerId });
        } else {
          this._authed = true;
          console.log("Sendspin: Using player_id:", this.config.playerId);
          this.protocolHandler.sendClientHello();
        }
      },
      // onMessage
      (event) => {
        if (!this._authed) {
          if (typeof event.data === "string") {
            let m = null;
            try {
              m = JSON.parse(event.data);
            } catch (e) {
            }
            if (m && m.type === "auth_ok") {
              this._authed = true;
              console.log("Sendspin: auth ok; Using player_id:", this.config.playerId);
              this.protocolHandler.sendClientHello();
            } else {
              console.warn("Sendspin: unexpected pre-auth message", event.data);
            }
          }
          return;
        }
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
      }
    );
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
    if (this.wsManager.isConnected()) {
      this.protocolHandler.sendGoodbye(reason);
    }
    this.protocolHandler.stopTimeSync();
    this.stateManager.clearAllIntervals();
    this.wsManager.disconnect();
    this.audioProcessor.close();
    this.timeFilter.reset();
    this.stateManager.reset();
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
    var _a;
    const supportedCommands = (_a = this.stateManager.serverState.controller) == null ? void 0 : _a.supported_commands;
    if (supportedCommands && !supportedCommands.includes(command)) {
      throw new Error("Command '".concat(command, "' is not supported by the server. ") + "Supported commands: ".concat(supportedCommands.join(", ")));
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
      offset: Math.round(this.timeFilter.offset / 1e3),
      // ms
      error: Math.round(this.timeFilter.error / 1e3)
      // ms
    };
  }
  /** Get current server time in microseconds using synchronized clock */
  getCurrentServerTimeUs() {
    return this.timeFilter.computeServerTime(Math.floor(performance.now() * 1e3));
  }
  /** Get current track progress with real-time position calculation */
  get trackProgress() {
    const metadata = this.stateManager.serverState.metadata;
    if (!(metadata == null ? void 0 : metadata.progress) || metadata.timestamp === void 0) {
      return null;
    }
    const serverTimeUs = this.getCurrentServerTimeUs();
    const elapsedUs = serverTimeUs - metadata.timestamp;
    const positionMs = metadata.progress.track_progress + elapsedUs * metadata.progress.playback_speed / 1e6;
    return {
      positionMs: Math.max(0, Math.min(positionMs, metadata.progress.track_duration)),
      durationMs: metadata.progress.track_duration,
      // Normalize to float (1.0 = normal speed)
      playbackSpeed: metadata.progress.playback_speed / 1e3
    };
  }
  // Sync info for debugging/display
  get syncInfo() {
    return this.audioProcessor.syncInfo;
  }
};
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  MessageType,
  SendspinPlayer,
  SendspinTimeFilter
});
