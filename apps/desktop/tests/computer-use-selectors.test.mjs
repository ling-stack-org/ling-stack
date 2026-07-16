import assert from "node:assert/strict";
import test from "node:test";
import { FAKE_COMPUTER_USE_PROJECTION } from "../dist/main/computer-use/fake-projection-client.js";
import { chooseComputerUsePreviewBounds } from "../dist/main/computer-use/layout.js";
import {
  selectComputerUsePresentation,
  selectComputerUsePipPresentation,
  terminalLingerMilliseconds,
} from "../dist/main/computer-use/selectors.js";

test("presentation selector chooses only the latest active session in the selected conversation", () => {
  const older = { ...FAKE_COMPUTER_USE_PROJECTION, sessionId: "older", updatedAt: "2026-07-15T00:00:00.000Z" };
  const latest = { ...FAKE_COMPUTER_USE_PROJECTION, sessionId: "latest", updatedAt: "2026-07-15T00:02:00.000Z" };
  const completed = { ...FAKE_COMPUTER_USE_PROJECTION, sessionId: "completed", status: "succeeded", updatedAt: "2026-07-15T00:03:00.000Z" };
  assert.equal(selectComputerUsePresentation({
    selectedConversationId: FAKE_COMPUTER_USE_PROJECTION.conversationId,
    projections: [older, completed, latest],
  }).sessionId, "latest");
});

test("presentation selector covers active statuses, terminal exclusion, and deterministic ties", () => {
  const activeStatuses = ["starting", "running", "waiting_for_approval", "paused", "stopping"];
  const terminalStatuses = ["succeeded", "failed", "cancelled"];
  assert.equal(selectComputerUsePresentation({ projections: [] }), undefined);
  assert.equal(selectComputerUsePresentation({
    selectedConversationId: "other-conversation",
    projections: [FAKE_COMPUTER_USE_PROJECTION],
  }), undefined);

  for (const status of activeStatuses) {
    const projection = { ...FAKE_COMPUTER_USE_PROJECTION, status, sessionId: `active-${status}` };
    assert.equal(selectComputerUsePresentation({
      selectedConversationId: FAKE_COMPUTER_USE_PROJECTION.conversationId,
      projections: [projection],
    })?.sessionId, projection.sessionId, `${status} remains presentable`);
  }
  for (const status of terminalStatuses) {
    assert.equal(selectComputerUsePresentation({
      selectedConversationId: FAKE_COMPUTER_USE_PROJECTION.conversationId,
      projections: [{ ...FAKE_COMPUTER_USE_PROJECTION, status }],
    }), undefined, `${status} is terminal`);
  }

  const sameTimestampA = { ...FAKE_COMPUTER_USE_PROJECTION, sessionId: "session-a" };
  const sameTimestampB = { ...FAKE_COMPUTER_USE_PROJECTION, sessionId: "session-b" };
  assert.equal(selectComputerUsePresentation({
    selectedConversationId: FAKE_COMPUTER_USE_PROJECTION.conversationId,
    projections: [sameTimestampA, sameTimestampB],
  })?.sessionId, "session-b", "session id breaks equal updatedAt ties deterministically");

  const latestTerminal = {
    ...FAKE_COMPUTER_USE_PROJECTION,
    sessionId: "latest-terminal",
    status: "succeeded",
    updatedAt: "2026-07-15T00:00:03.000Z",
  };
  const olderActive = {
    ...FAKE_COMPUTER_USE_PROJECTION,
    sessionId: "older-active",
    updatedAt: "2026-07-15T00:00:02.000Z",
  };
  assert.equal(selectComputerUsePresentation({
    selectedConversationId: FAKE_COMPUTER_USE_PROJECTION.conversationId,
    projections: [latestTerminal, olderActive],
  })?.sessionId, "older-active");
});

test("terminal linger policy matches the design contract", () => {
  assert.equal(terminalLingerMilliseconds("succeeded"), 1_500);
  assert.equal(terminalLingerMilliseconds("cancelled"), 300);
  assert.equal(terminalLingerMilliseconds("failed"), 5_000);
  assert.equal(terminalLingerMilliseconds("running"), undefined);
});

test("PiP presentation selector preserves activation precedence and the first-frame gate", () => {
  const base = {
    sessionSuppressed: false,
    explicitlyShown: false,
    previewAutoShow: true,
    windowVisible: false,
    stallTimeoutBlocked: false,
    rendererCrashBlocked: false,
    sourceStatus: "connecting",
    frameReady: false,
  };
  const cases = [
    ["initial connecting activates capture but stays hidden", {}, { visibilityIntent: "auto", sourceActivationAllowed: true, shouldRevealOrRetainWindow: false }],
    ["first live frame reveals", { sourceStatus: "live", frameReady: true }, { visibilityIntent: "auto", sourceActivationAllowed: true, shouldRevealOrRetainWindow: true }],
    ["initial first-frame stall stays hidden", { sourceStatus: "stalled" }, { visibilityIntent: "auto", sourceActivationAllowed: true, shouldRevealOrRetainWindow: false }],
    ["presented stalled surface remains visible", { sourceStatus: "stalled", windowVisible: true }, { visibilityIntent: "auto", sourceActivationAllowed: true, shouldRevealOrRetainWindow: true }],
    ["permission recovery is actionable without a frame", { sourceStatus: "permission_denied" }, { visibilityIntent: "auto", sourceActivationAllowed: true, shouldRevealOrRetainWindow: true }],
    ["source failure is actionable without a frame", { sourceStatus: "failed" }, { visibilityIntent: "auto", sourceActivationAllowed: true, shouldRevealOrRetainWindow: true }],
    ["explicit Show overrides auto-show off", { explicitlyShown: true, previewAutoShow: false }, { visibilityIntent: "shown", sourceActivationAllowed: true, shouldRevealOrRetainWindow: false }],
    ["auto-show off blocks a new hidden surface", { previewAutoShow: false }, { visibilityIntent: "auto", sourceActivationAllowed: false, shouldRevealOrRetainWindow: false, blockReason: "auto_show_disabled" }],
    ["auto-show off retains an already visible surface", { previewAutoShow: false, windowVisible: true }, { visibilityIntent: "auto", sourceActivationAllowed: true, shouldRevealOrRetainWindow: true }],
    ["session suppression has highest priority", { sessionSuppressed: true, stallTimeoutBlocked: true, rendererCrashBlocked: true }, { visibilityIntent: "hidden", sourceActivationAllowed: false, shouldRevealOrRetainWindow: false, blockReason: "session_hidden" }],
    ["stall timeout outranks renderer crash", { stallTimeoutBlocked: true, rendererCrashBlocked: true }, { visibilityIntent: "auto", sourceActivationAllowed: false, shouldRevealOrRetainWindow: false, blockReason: "stall_timeout" }],
    ["renderer crash blocks automatic recreation", { rendererCrashBlocked: true }, { visibilityIntent: "auto", sourceActivationAllowed: false, shouldRevealOrRetainWindow: false, blockReason: "renderer_crash" }],
  ];

  for (const [name, override, expected] of cases) {
    assert.deepEqual(selectComputerUsePipPresentation({ ...base, ...override }), expected, name);
  }
});

test("PiP presentation selector exhaustively covers every input combination", () => {
  const booleans = [false, true];
  const statuses = ["idle", "connecting", "live", "stalled", "permission_denied", "ended", "failed"];
  let checked = 0;

  for (const sessionSuppressed of booleans) {
    for (const explicitlyShown of booleans) {
      for (const previewAutoShow of booleans) {
        for (const windowVisible of booleans) {
          for (const stallTimeoutBlocked of booleans) {
            for (const rendererCrashBlocked of booleans) {
              for (const sourceStatus of statuses) {
                for (const frameReady of booleans) {
                  const visibilityIntent = sessionSuppressed ? "hidden" : explicitlyShown ? "shown" : "auto";
                  const blockReason = sessionSuppressed
                    ? "session_hidden"
                    : stallTimeoutBlocked
                      ? "stall_timeout"
                      : rendererCrashBlocked
                        ? "renderer_crash"
                        : !explicitlyShown && !previewAutoShow && !windowVisible
                          ? "auto_show_disabled"
                          : undefined;
                  const sourceActivationAllowed = blockReason === undefined;
                  const sourceSurfaceReady = (sourceStatus === "live" && frameReady)
                    || sourceStatus === "permission_denied"
                    || sourceStatus === "failed"
                    || (windowVisible && (sourceStatus === "connecting" || sourceStatus === "stalled"));
                  const expected = {
                    visibilityIntent,
                    sourceActivationAllowed,
                    shouldRevealOrRetainWindow: sourceActivationAllowed && (windowVisible || sourceSurfaceReady),
                    ...(blockReason ? { blockReason } : {}),
                  };
                  assert.deepEqual(selectComputerUsePipPresentation({
                    sessionSuppressed,
                    explicitlyShown,
                    previewAutoShow,
                    windowVisible,
                    stallTimeoutBlocked,
                    rendererCrashBlocked,
                    sourceStatus,
                    frameReady,
                  }), expected);
                  checked += 1;
                }
              }
            }
          }
        }
      }
    }
  }

  assert.equal(checked, 896);
});

test("layout offsets the preferred corner when it can avoid an obstacle", () => {
  const bounds = chooseComputerUsePreviewBounds({
    workArea: { x: 0, y: 0, width: 1200, height: 800 },
    size: { width: 400, height: 250 },
    obstacles: [{ x: 760, y: 500, width: 440, height: 300 }],
  });
  assert.deepEqual(bounds, { x: 784, y: 238, width: 400, height: 250 });
});
