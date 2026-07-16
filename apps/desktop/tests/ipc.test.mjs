import assert from "node:assert/strict";
import test from "node:test";
import { registerDesktopIpc } from "../dist/main/ipc.js";
import { DESKTOP_IPC_CHANNELS } from "../dist/shared/ipc-channels.js";

test("Desktop IPC scopes privileged actions and strictly validates preview media release ACKs", async () => {
  const ipc = new FakeIpcMain();
  const calls = [];
  const hostLayouts = [];
  const computerUse = {
    ownsPreviewWebContents: (id) => id === 22,
    stop: async (sessionId) => {
      calls.push(["stop", sessionId]);
      return { accepted: true, reason: "main_stop" };
    },
    stopCurrent: async () => {
      calls.push(["stopCurrent"]);
      return { accepted: true, reason: "preview_stop" };
    },
    hideCurrent: async () => {
      calls.push(["hideCurrent"]);
      return { accepted: true };
    },
    closeCurrent: async () => {
      calls.push(["closeCurrent"]);
      return { accepted: true };
    },
    resetPosition: async () => {
      calls.push(["resetPosition"]);
      return { accepted: true };
    },
    reportFrameReady: (sessionId, revision, sourceGeneration) => {
      calls.push(["reportFrameReady", sessionId, revision, sourceGeneration]);
    },
    reportFrameActivity: (sessionId, revision, sourceGeneration) => {
      calls.push(["reportFrameActivity", sessionId, revision, sourceGeneration]);
    },
    reportSourceEnded: (sessionId, revision, sourceGeneration, reason) => {
      calls.push(["reportSourceEnded", sessionId, revision, sourceGeneration, reason]);
    },
    reportSourceFailure: (sessionId, revision, sourceGeneration, reason) => {
      calls.push(["reportSourceFailure", sessionId, revision, sourceGeneration, reason]);
    },
    reportMediaReleased: (ack, senderId) => {
      calls.push(["reportMediaReleased", ack, senderId]);
    },
    reportInteraction: (kind, active) => {
      calls.push(["reportInteraction", kind, active]);
    },
    reportLocale: (locale) => {
      calls.push(["reportLocale", locale]);
    },
    reportHostLayout: (layout) => {
      hostLayouts.push(layout);
    },
    getPreferences: () => ({ previewAutoShow: false }),
    setAutoShow: async (enabled) => {
      calls.push(["setAutoShow", enabled]);
      return { accepted: true };
    },
  };
  const unregister = registerDesktopIpc({
    ipcMainImpl: ipc,
    daemon: {
      status: { state: "connected", baseUrl: "http://127.0.0.1:1", ownedByDesktop: true },
      onStatusChanged: () => () => {},
    },
    computerUse,
    getMainWindow: () => ({ webContents: { id: 11 } }),
  });

  const mainEvent = { sender: { id: 11 } };
  const previewEvent = { sender: { id: 22 } };
  const foreignEvent = { sender: { id: 33 } };

  assert.deepEqual(
    await ipc.invoke(DESKTOP_IPC_CHANNELS.computerUseStop, mainEvent, "session-main"),
    { accepted: true, reason: "main_stop" },
  );
  assert.deepEqual(
    await ipc.invoke(DESKTOP_IPC_CHANNELS.computerUseStop, previewEvent),
    { accepted: true, reason: "preview_stop" },
  );
  assert.deepEqual(
    await ipc.invoke(DESKTOP_IPC_CHANNELS.computerUseStop, foreignEvent),
    { accepted: false, reason: "unauthorized_sender" },
  );
  assert.deepEqual(
    await ipc.invoke(DESKTOP_IPC_CHANNELS.computerUsePreviewHide, previewEvent),
    { accepted: true },
  );
  assert.deepEqual(
    await ipc.invoke(DESKTOP_IPC_CHANNELS.computerUsePreviewHide, mainEvent),
    { accepted: false, reason: "unauthorized_preview_sender" },
  );
  assert.deepEqual(
    await ipc.invoke(DESKTOP_IPC_CHANNELS.computerUsePreviewClose, previewEvent),
    { accepted: true },
  );
  assert.deepEqual(
    await ipc.invoke(DESKTOP_IPC_CHANNELS.computerUsePreviewClose, foreignEvent),
    { accepted: false, reason: "unauthorized_preview_sender" },
  );
  assert.deepEqual(
    await ipc.invoke(DESKTOP_IPC_CHANNELS.computerUsePreviewResetPosition, previewEvent),
    { accepted: true },
  );
  assert.deepEqual(
    await ipc.invoke(DESKTOP_IPC_CHANNELS.computerUsePreviewResetPosition, foreignEvent),
    { accepted: false, reason: "unauthorized_preview_sender" },
  );
  assert.deepEqual(
    await ipc.invoke(DESKTOP_IPC_CHANNELS.computerUseAutoShowGet, mainEvent),
    { previewAutoShow: false },
  );
  assert.deepEqual(
    await ipc.invoke(DESKTOP_IPC_CHANNELS.computerUseAutoShowSet, mainEvent, true),
    { accepted: true },
  );
  assert.deepEqual(
    await ipc.invoke(DESKTOP_IPC_CHANNELS.computerUseAutoShowSet, foreignEvent, true),
    { accepted: false, reason: "unauthorized_or_invalid_auto_show" },
  );
  ipc.emit(DESKTOP_IPC_CHANNELS.computerUseReportLocale, mainEvent, "en-US");
  ipc.emit(DESKTOP_IPC_CHANNELS.computerUseReportLocale, mainEvent, "zh-CN");
  ipc.emit(DESKTOP_IPC_CHANNELS.computerUseReportLocale, mainEvent, "fr-FR");
  ipc.emit(DESKTOP_IPC_CHANNELS.computerUseReportLocale, mainEvent, "");
  ipc.emit(DESKTOP_IPC_CHANNELS.computerUseReportLocale, previewEvent, "en-US");
  ipc.emit(DESKTOP_IPC_CHANNELS.computerUseReportLocale, foreignEvent, "zh-CN");
  ipc.emit(DESKTOP_IPC_CHANNELS.computerUsePreviewFrameReady, previewEvent, "session-preview", 7, 101);
  ipc.emit(DESKTOP_IPC_CHANNELS.computerUsePreviewFrameActivity, previewEvent, "session-preview", 7, 102);
  ipc.emit(DESKTOP_IPC_CHANNELS.computerUsePreviewSourceEnded, previewEvent, "session-preview", 7, 103, "track_ended");
  ipc.emit(DESKTOP_IPC_CHANNELS.computerUsePreviewSourceFailed, previewEvent, "session-preview", 7, 104, "capture_failed");
  ipc.emit(DESKTOP_IPC_CHANNELS.computerUsePreviewFrameReady, previewEvent, "session-preview", 7, 0);
  ipc.emit(DESKTOP_IPC_CHANNELS.computerUsePreviewFrameActivity, previewEvent, "session-preview", 7, 102.5);
  ipc.emit(DESKTOP_IPC_CHANNELS.computerUsePreviewSourceEnded, previewEvent, "session-preview", 7, Number.MAX_SAFE_INTEGER + 1, "bad");
  ipc.emit(DESKTOP_IPC_CHANNELS.computerUsePreviewSourceFailed, previewEvent, "session-preview", 7, undefined, "bad");
  ipc.emit(DESKTOP_IPC_CHANNELS.computerUsePreviewFrameActivity, foreignEvent, "session-foreign", 8, 105);
  ipc.emit(DESKTOP_IPC_CHANNELS.computerUsePreviewReleaseMediaAck, previewEvent, {
    requestId: "release-request-1",
    sessionId: "session-preview",
    sourceRevision: 7,
    sourceGeneration: 201,
    status: "released",
    releasedTrackCount: 2,
    allTracksEnded: true,
    ignored: "renderer-secret",
  });
  ipc.emit(DESKTOP_IPC_CHANNELS.computerUsePreviewReleaseMediaAck, previewEvent, {
    requestId: "release-request-2",
    sessionId: "session-preview",
    sourceRevision: 8,
    sourceGeneration: 202,
    status: "identity_mismatch",
    releasedTrackCount: 0,
    allTracksEnded: false,
  });
  ipc.emit(DESKTOP_IPC_CHANNELS.computerUsePreviewReleaseMediaAck, foreignEvent, {
    requestId: "release-request-foreign",
    sessionId: "session-preview",
    sourceRevision: 9,
    sourceGeneration: 203,
    status: "already_released",
    releasedTrackCount: 0,
    allTracksEnded: true,
  });
  const malformedReleaseMediaAcks = [
    undefined,
    null,
    [],
    {
      requestId: "",
      sessionId: "session-preview",
      sourceRevision: 7,
      sourceGeneration: 201,
      status: "released",
      releasedTrackCount: 1,
      allTracksEnded: true,
    },
    {
      requestId: "release-request",
      sessionId: "   ",
      sourceRevision: 7,
      sourceGeneration: 201,
      status: "released",
      releasedTrackCount: 1,
      allTracksEnded: true,
    },
    {
      requestId: "release-request",
      sessionId: "session-preview",
      sourceRevision: -1,
      sourceGeneration: 201,
      status: "released",
      releasedTrackCount: 1,
      allTracksEnded: true,
    },
    {
      requestId: "release-request",
      sessionId: "session-preview",
      sourceRevision: 1.5,
      sourceGeneration: 201,
      status: "released",
      releasedTrackCount: 1,
      allTracksEnded: true,
    },
    {
      requestId: "release-request",
      sessionId: "session-preview",
      sourceRevision: 7,
      status: "released",
      releasedTrackCount: 1,
      allTracksEnded: true,
    },
    {
      requestId: "release-request",
      sessionId: "session-preview",
      sourceRevision: 7,
      sourceGeneration: 0,
      status: "released",
      releasedTrackCount: 1,
      allTracksEnded: true,
    },
    {
      requestId: "release-request",
      sessionId: "session-preview",
      sourceRevision: 7,
      sourceGeneration: 201.5,
      status: "released",
      releasedTrackCount: 1,
      allTracksEnded: true,
    },
    {
      requestId: "release-request",
      sessionId: "session-preview",
      sourceRevision: 7,
      sourceGeneration: Number.MAX_SAFE_INTEGER + 1,
      status: "released",
      releasedTrackCount: 1,
      allTracksEnded: true,
    },
    {
      requestId: "release-request",
      sessionId: "session-preview",
      sourceRevision: 7,
      sourceGeneration: 201,
      status: "unknown",
      releasedTrackCount: 1,
      allTracksEnded: true,
    },
    {
      requestId: "release-request",
      sessionId: "session-preview",
      sourceRevision: 7,
      sourceGeneration: 201,
      status: "released",
      releasedTrackCount: -1,
      allTracksEnded: true,
    },
    {
      requestId: "release-request",
      sessionId: "session-preview",
      sourceRevision: 7,
      sourceGeneration: 201,
      status: "released",
      releasedTrackCount: 0.5,
      allTracksEnded: true,
    },
    {
      requestId: "release-request",
      sessionId: "session-preview",
      sourceRevision: 7,
      sourceGeneration: 201,
      status: "released",
      releasedTrackCount: 1,
      allTracksEnded: "yes",
    },
  ];
  for (const malformedAck of malformedReleaseMediaAcks) {
    ipc.emit(DESKTOP_IPC_CHANNELS.computerUsePreviewReleaseMediaAck, previewEvent, malformedAck);
  }
  ipc.emit(DESKTOP_IPC_CHANNELS.computerUsePreviewInteraction, previewEvent, { kind: "hover", active: true });
  ipc.emit(DESKTOP_IPC_CHANNELS.computerUsePreviewInteraction, previewEvent, { kind: "focus", active: true });
  ipc.emit(DESKTOP_IPC_CHANNELS.computerUsePreviewInteraction, previewEvent, { kind: "invalid", active: true });
  ipc.emit(DESKTOP_IPC_CHANNELS.computerUsePreviewInteraction, previewEvent, { kind: "hover", active: "yes" });
  ipc.emit(DESKTOP_IPC_CHANNELS.computerUsePreviewInteraction, foreignEvent, { kind: "hover", active: false });
  const reportedAt = new Date().toISOString();
  const obstacleKinds = ["composer", "approval", "modal", "dock", "terminal", "unknown"];
  ipc.emit(DESKTOP_IPC_CHANNELS.computerUseReportHostLayout, mainEvent, {
    windowBounds: { x: 10, y: 20, width: 1_400, height: 860, ignored: "window-secret" },
    obstacles: [
      ...obstacleKinds.map((kind, index) => ({
        x: index * 10,
        y: 100,
        width: 80,
        height: 40,
        kind,
        ignored: "obstacle-secret",
      })),
      { x: 70, y: 100, width: 80, height: 40, kind: "arbitrary-web-value" },
      { x: 80, y: 100, width: 80, height: 40 },
      { x: 90, y: 100, width: Number.NaN, height: 40, kind: "composer" },
    ],
    reportedAt,
  });
  ipc.emit(DESKTOP_IPC_CHANNELS.computerUseReportHostLayout, foreignEvent, {
    windowBounds: { x: 0, y: 0, width: 1, height: 1 },
    obstacles: [],
    reportedAt,
  });
  assert.deepEqual(calls, [
    ["stop", "session-main"],
    ["stopCurrent"],
    ["hideCurrent"],
    ["closeCurrent"],
    ["resetPosition"],
    ["setAutoShow", true],
    ["reportLocale", "en-US"],
    ["reportLocale", "zh-CN"],
    ["reportFrameReady", "session-preview", 7, 101],
    ["reportFrameActivity", "session-preview", 7, 102],
    ["reportSourceEnded", "session-preview", 7, 103, "track_ended"],
    ["reportSourceFailure", "session-preview", 7, 104, "capture_failed"],
    ["reportMediaReleased", {
      requestId: "release-request-1",
      sessionId: "session-preview",
      sourceRevision: 7,
      sourceGeneration: 201,
      status: "released",
      releasedTrackCount: 2,
      allTracksEnded: true,
    }, 22],
    ["reportMediaReleased", {
      requestId: "release-request-2",
      sessionId: "session-preview",
      sourceRevision: 8,
      sourceGeneration: 202,
      status: "identity_mismatch",
      releasedTrackCount: 0,
      allTracksEnded: false,
    }, 22],
    ["reportInteraction", "hover", true],
    ["reportInteraction", "focus", true],
  ]);
  assert.deepEqual(hostLayouts, [{
    windowBounds: { x: 10, y: 20, width: 1_400, height: 860 },
    obstacles: [
      ...obstacleKinds.map((kind, index) => ({
        x: index * 10,
        y: 100,
        width: 80,
        height: 40,
        kind,
      })),
      { x: 70, y: 100, width: 80, height: 40, kind: "other" },
      { x: 80, y: 100, width: 80, height: 40, kind: "other" },
    ],
    reportedAt,
  }]);

  const freshReportedAt = new Date(Date.now() - 30_000).toISOString();
  ipc.emit(DESKTOP_IPC_CHANNELS.computerUseReportHostLayout, mainEvent, {
    windowBounds: { x: -2_560, y: -240, width: 1_920, height: 1_080 },
    obstacles: [
      { x: -2_400, y: -120, width: 400, height: 120, kind: "composer" },
      { x: 999_999, y: 0, width: 2, height: 10, kind: "approval" },
      { x: 0, y: 0, width: 0, height: 10, kind: "modal" },
      { x: 0, y: 0, width: 10, height: -1, kind: "dock" },
      { x: 0, y: 0, width: 100_001, height: 10, kind: "terminal" },
      { x: 0, y: 0, width: 10, height: 10, kind: "renderer-defined" },
    ],
    reportedAt: freshReportedAt,
  });
  assert.deepEqual(hostLayouts.at(-1), {
    windowBounds: { x: -2_560, y: -240, width: 1_920, height: 1_080 },
    obstacles: [
      { x: -2_400, y: -120, width: 400, height: 120, kind: "composer" },
      { x: 0, y: 0, width: 10, height: 10, kind: "other" },
    ],
    reportedAt: freshReportedAt,
  });

  const acceptedLayoutCount = hostLayouts.length;
  const invalidWindowBounds = [
    { x: 0, y: 0, width: 0, height: 100 },
    { x: 0, y: 0, width: -1, height: 100 },
    { x: 0, y: 0, width: 100, height: 0 },
    { x: 0, y: 0, width: 100_001, height: 100 },
    { x: 0, y: 0, width: 100, height: 100_001 },
    { x: -1_000_001, y: 0, width: 100, height: 100 },
    { x: 999_999, y: 0, width: 2, height: 100 },
    { x: 0, y: 999_999, width: 100, height: 2 },
    { x: Number.POSITIVE_INFINITY, y: 0, width: 100, height: 100 },
  ];
  for (const windowBounds of invalidWindowBounds) {
    ipc.emit(DESKTOP_IPC_CHANNELS.computerUseReportHostLayout, mainEvent, {
      windowBounds,
      obstacles: [],
      reportedAt: new Date().toISOString(),
    });
  }
  assert.equal(hostLayouts.length, acceptedLayoutCount);

  const cappedObstacles = Array.from({ length: 140 }, (_, index) => ({
    x: index,
    y: 100,
    width: 10,
    height: 10,
    kind: "popover",
  }));
  ipc.emit(DESKTOP_IPC_CHANNELS.computerUseReportHostLayout, mainEvent, {
    windowBounds: { x: 0, y: 0, width: 1_600, height: 900 },
    obstacles: cappedObstacles,
    reportedAt: new Date().toISOString(),
  });
  assert.equal(hostLayouts.at(-1).obstacles.length, 128);
  assert.deepEqual(hostLayouts.at(-1).obstacles.at(-1), {
    x: 127,
    y: 100,
    width: 10,
    height: 10,
    kind: "popover",
  });

  const invalidReportedAtValues = [
    "not-a-date",
    new Date(Date.now() - 6 * 60_000).toISOString(),
    new Date(Date.now() + 2 * 60_000).toISOString(),
    123,
  ];
  for (const invalidReportedAt of invalidReportedAtValues) {
    const before = Date.now();
    ipc.emit(DESKTOP_IPC_CHANNELS.computerUseReportHostLayout, mainEvent, {
      windowBounds: { x: 0, y: 0, width: 1_600, height: 900 },
      obstacles: [],
      reportedAt: invalidReportedAt,
    });
    const after = Date.now();
    const normalizedReportedAt = Date.parse(hostLayouts.at(-1).reportedAt);
    assert.ok(normalizedReportedAt >= before && normalizedReportedAt <= after);
  }

  unregister();
});

class FakeIpcMain {
  handlers = new Map();
  listeners = new Map();

  handle(channel, handler) {
    this.handlers.set(channel, handler);
  }

  on(channel, listener) {
    this.listeners.set(channel, listener);
  }

  removeHandler(channel) {
    this.handlers.delete(channel);
  }

  removeAllListeners(channel) {
    this.listeners.delete(channel);
  }

  invoke(channel, event, ...args) {
    return this.handlers.get(channel)(event, ...args);
  }

  emit(channel, event, ...args) {
    return this.listeners.get(channel)(event, ...args);
  }
}
