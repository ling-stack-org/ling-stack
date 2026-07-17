const { contextBridge } = require("electron");

const displayMediaModeValue = process.env.LING_PREVIEW_HARNESS_DISPLAY_MEDIA;
const displayMediaMode = displayMediaModeValue === "1" || displayMediaModeValue === "manual";
const manualDisplayMediaMode = displayMediaModeValue === "manual";

if (displayMediaMode) {
  contextBridge.executeInMainWorld({
    func: (manualAcquisition) => {
      const harnessState = {
        manualAcquisition,
        requestCount: 0,
        requests: [],
        pendingResolvers: [],
        streams: [],
      };
      Object.defineProperty(globalThis, "__lingDisplayMediaHarness", {
        configurable: true,
        value: harnessState,
      });
      Object.defineProperty(navigator.mediaDevices, "getDisplayMedia", {
        configurable: true,
        value: async (options) => {
          harnessState.requestCount += 1;
          harnessState.requests.push(options);
          const canvas = document.createElement("canvas");
          canvas.width = 640;
          canvas.height = 400;
          const context = canvas.getContext("2d");
          const stream = canvas.captureStream(30);
          harnessState.streams.push(stream);
          let frame = 0;
          const draw = () => {
            if (!context || stream.getTracks().every((track) => track.readyState === "ended")) {
              return;
            }
            frame += 1;
            context.fillStyle = frame % 2 === 0 ? "#274f88" : "#12233c";
            context.fillRect(0, 0, canvas.width, canvas.height);
            context.fillStyle = "#eef6ff";
            context.font = "600 32px system-ui";
            context.fillText(`Ling display media harness ${frame}`, 48, 210);
            requestAnimationFrame(draw);
          };
          draw();
          if (harnessState.manualAcquisition) {
            await new Promise((resolve) => harnessState.pendingResolvers.push(resolve));
          } else {
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          return stream;
        },
      });
    },
    args: [manualDisplayMediaMode],
  });
}

const initialSnapshot = {
  sessionId: "renderer-harness-session",
  conversationId: "renderer-harness-conversation",
  locale: "en-US",
  targetLabel: "Example Browser",
  runtimeStatus: "running",
  sourceStatus: displayMediaMode ? "connecting" : "live",
  sourceKind: displayMediaMode ? "display_media" : "fake",
  sourceRevision: 1,
  sourceGeneration: 1,
  visibilityIntent: "auto",
  frameReady: !displayMediaMode,
  aspectRatio: 1.6,
  canStop: true,
  canOpenSettings: false,
};

let snapshot = { ...initialSnapshot };
let calls = [];
const snapshotListeners = new Set();
const releaseListeners = new Set();
const commandBehaviors = new Map();
const pendingCommands = new Map();
let releaseRequestSequence = 0;

function record(name, args = []) {
  calls.push({ name, args });
}

function command(name, args = []) {
  record(name, args);
  const behavior = commandBehaviors.get(name);
  if (behavior?.kind === "reject") {
    return Promise.reject(new Error(behavior.message));
  }
  if (behavior?.kind === "pending") {
    return new Promise((resolve, reject) => {
      pendingCommands.set(name, { resolve, reject });
    });
  }
  return Promise.resolve(behavior?.result ?? { accepted: true });
}

contextBridge.exposeInMainWorld("lingComputerUsePreview", {
  getSnapshot: () => Promise.resolve(snapshot),
  retryCapture: () => command("retryCapture"),
  resetPosition: () => command("resetPosition"),
  close: () => command("close"),
  hide: () => {
    record("hide");
    return Promise.resolve();
  },
  openOwnerConversation: () => {
    record("openOwnerConversation");
    return Promise.resolve();
  },
  requestStop: () => command("requestStop"),
  openScreenPermissionSettings: () => {
    record("openScreenPermissionSettings");
    return Promise.resolve();
  },
  reportFrameReady: (...args) => record("reportFrameReady", args),
  reportFrameActivity: (...args) => record("reportFrameActivity", args),
  reportInteraction: (...args) => record("reportInteraction", args),
  reportSourceEnded: (...args) => record("reportSourceEnded", args),
  reportSourceFailure: (...args) => record("reportSourceFailure", args),
  onReleaseMedia: (listener) => {
    releaseListeners.add(listener);
    return () => releaseListeners.delete(listener);
  },
  onSnapshotChanged: (listener) => {
    snapshotListeners.add(listener);
    return () => snapshotListeners.delete(listener);
  },
});

contextBridge.exposeInMainWorld("lingPreviewTestHarness", {
  clearCalls: () => {
    calls = [];
  },
  getCalls: () => calls,
  getDisplayMediaRequestCount: () => contextBridge.executeInMainWorld({
    func: () => globalThis.__lingDisplayMediaHarness?.requestCount ?? 0,
  }),
  getDisplayMediaState: () => contextBridge.executeInMainWorld({
    func: () => {
      const state = globalThis.__lingDisplayMediaHarness;
      return {
        requestCount: state?.requestCount ?? 0,
        requests: state?.requests ?? [],
        pendingCount: state?.pendingResolvers.length ?? 0,
        streamTrackStates: state?.streams.map((stream) => stream
          .getTracks()
          .map((track) => track.readyState)) ?? [],
      };
    },
  }),
  resolveNextDisplayMediaAcquisition: () => contextBridge.executeInMainWorld({
    func: () => {
      const resolve = globalThis.__lingDisplayMediaHarness?.pendingResolvers.shift();
      if (!resolve) {
        return false;
      }
      resolve();
      return true;
    },
  }),
  forceNoDecodedFrameFallback: () => contextBridge.executeInMainWorld({
    func: () => {
      const state = globalThis.__lingDisplayMediaHarness;
      if (!state) {
        return false;
      }
      state.videoFrameCallbackPrototypeDescriptor = Object.getOwnPropertyDescriptor(
        HTMLVideoElement.prototype,
        "requestVideoFrameCallback",
      );
      state.readyStatePrototypeDescriptor = Object.getOwnPropertyDescriptor(
        HTMLMediaElement.prototype,
        "readyState",
      );
      Object.defineProperty(HTMLVideoElement.prototype, "requestVideoFrameCallback", {
        configurable: true,
        value: undefined,
      });
      Object.defineProperty(HTMLMediaElement.prototype, "readyState", {
        configurable: true,
        get: () => HTMLMediaElement.HAVE_NOTHING,
      });
      return true;
    },
  }),
  restoreDecodedFrameFallback: () => contextBridge.executeInMainWorld({
    func: () => {
      const state = globalThis.__lingDisplayMediaHarness;
      if (!state) {
        return false;
      }
      for (const [target, property, descriptor] of [
        [
          HTMLVideoElement.prototype,
          "requestVideoFrameCallback",
          state.videoFrameCallbackPrototypeDescriptor,
        ],
        [HTMLMediaElement.prototype, "readyState", state.readyStatePrototypeDescriptor],
      ]) {
        if (descriptor) {
          Object.defineProperty(target, property, descriptor);
        } else {
          delete target[property];
        }
      }
      delete state.videoFrameCallbackPrototypeDescriptor;
      delete state.readyStatePrototypeDescriptor;
      return true;
    },
  }),
  pushSnapshot: (overrides) => {
    snapshot = { ...snapshot, ...overrides };
    for (const listener of snapshotListeners) {
      listener(snapshot);
    }
  },
  emitReleaseMedia: async (request) => {
    const releaseRequest = request ?? {
      requestId: `renderer-harness-release-${++releaseRequestSequence}`,
      sessionId: snapshot.sessionId,
      sourceRevision: snapshot.sourceRevision,
      sourceGeneration: snapshot.sourceGeneration,
    };
    const acknowledgements = [];
    for (const listener of releaseListeners) {
      let result;
      try {
        result = await listener(releaseRequest);
      } catch {
        continue;
      }
      if (!isReleaseMediaResult(result)) {
        continue;
      }
      const ack = { ...releaseRequest, ...result };
      acknowledgements.push(ack);
      record("releaseMediaAck", [ack]);
    }
    return acknowledgements;
  },
  setCommandResult: (name, result) => {
    commandBehaviors.set(name, { kind: "resolve", result });
  },
  setCommandFailure: (name, message) => {
    commandBehaviors.set(name, { kind: "reject", message });
  },
  setCommandPending: (name) => {
    commandBehaviors.set(name, { kind: "pending" });
  },
  resolveCommand: (name, result) => {
    const pending = pendingCommands.get(name);
    if (!pending) {
      return false;
    }
    pendingCommands.delete(name);
    pending.resolve(result);
    return true;
  },
  rejectCommand: (name, message) => {
    const pending = pendingCommands.get(name);
    if (!pending) {
      return false;
    }
    pendingCommands.delete(name);
    pending.reject(new Error(message));
    return true;
  },
});

function isReleaseMediaResult(value) {
  return value !== null &&
    typeof value === "object" &&
    ["released", "already_released", "identity_mismatch"].includes(value.status) &&
    Number.isInteger(value.releasedTrackCount) &&
    value.releasedTrackCount >= 0 &&
    typeof value.allTracksEnded === "boolean";
}
