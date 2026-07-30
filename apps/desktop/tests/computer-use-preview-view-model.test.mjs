import assert from "node:assert/strict";
import test from "node:test";
import { createComputerUsePreviewViewModel } from "../dist/renderer/computer-use-preview/preview-view-model.js";

test("preview view model exposes explicit runtime/source states", () => {
  const cases = [
    ["running/live", { runtimeStatus: "running", sourceStatus: "live", frameReady: true }, "live", "Live"],
    ["starting", { runtimeStatus: "starting", sourceStatus: "connecting" }, "connecting", "Connecting"],
    ["stalled", { runtimeStatus: "running", sourceStatus: "stalled" }, "reconnecting", "Reconnecting"],
    ["paused", { runtimeStatus: "paused", sourceStatus: "live" }, "paused", "Paused"],
    ["approval", { runtimeStatus: "waiting_for_approval", sourceStatus: "live" }, "approval_required", "Approval required"],
    ["stopping", { runtimeStatus: "stopping", sourceStatus: "live" }, "stopping", "Stopping"],
    ["completed", { runtimeStatus: "succeeded", sourceStatus: "live" }, "completed", "Completed"],
    ["failed", { runtimeStatus: "failed", sourceStatus: "live" }, "failed", "Failed"],
    ["permission", { runtimeStatus: "running", sourceStatus: "permission_denied" }, "permission_required", "Permission required"],
  ];

  for (const [name, overrides, state, label] of cases) {
    const viewModel = createComputerUsePreviewViewModel(snapshot(overrides));
    assert.equal(viewModel.state, state, name);
    assert.equal(viewModel.label, label, name);
    assert.equal(viewModel.controlsPersistent, state !== "live", name);
  }
});

test("view model keeps live controls hover-only and exposes actionable menu items", () => {
  const live = createComputerUsePreviewViewModel(snapshot({ runtimeStatus: "running", sourceStatus: "live", frameReady: true }));
  assert.equal(live.controlsPersistent, false);
  assert.deepEqual(live.primaryActions.map((action) => action.id), ["open", "hide"]);
  assert.deepEqual(live.menuActions.map((action) => action.id), ["reset", "close", "stop"]);
  assert.equal(live.menuActions.find((action) => action.id === "stop")?.separatorBefore, true);

  const permission = createComputerUsePreviewViewModel(snapshot({
    runtimeStatus: "running",
    sourceStatus: "permission_denied",
    canOpenSettings: true,
    canStop: false,
  }));
  assert.deepEqual(permission.primaryActions.map((action) => action.id), ["open", "hide"]);
  assert.deepEqual(permission.menuActions.map((action) => action.id), ["reset", "settings", "retry", "close"]);
  assert.equal(permission.ariaLive, "assertive");
});

test("locked-control state promotes Stop and revoke to an obvious primary action", () => {
  const locked = createComputerUsePreviewViewModel(snapshot({
    lockedControl: {
      phase: "active_locked",
      expiresAt: "2026-07-31T10:15:00.000Z",
    },
  }));
  assert.deepEqual(locked.primaryActions.map((action) => action.id), ["open", "stop", "hide"]);
  assert.equal(locked.primaryActions.find((action) => action.id === "stop")?.label, "Stop and revoke");
  assert.equal(locked.primaryActions.find((action) => action.id === "stop")?.danger, true);
  assert.equal(locked.menuActions.some((action) => action.id === "stop"), false);
});

test("view model exposes structured pending and failed Stop feedback", () => {
  const pending = createComputerUsePreviewViewModel(snapshot(), { stopCommandState: "pending" });
  assert.equal(pending.state, "stopping");
  assert.equal(pending.label, "Stopping");
  assert.equal(pending.detail, "Requesting runtime stop");
  assert.equal(pending.busy, true);
  assert.equal(pending.menuActions.find((action) => action.id === "stop")?.disabled, true);

  const failed = createComputerUsePreviewViewModel(snapshot(), { stopCommandState: "failed" });
  assert.equal(failed.state, "stop_failed");
  assert.equal(failed.label, "Stop failed");
  assert.equal(failed.detail, "Computer Use is still running. Try again.");
  assert.equal(failed.ariaLive, "assertive");
  assert.equal(failed.overlayAction?.id, "stop");
  assert.equal(failed.overlayAction?.label, "Try Stop again");
  assert.equal(failed.menuActions.find((action) => action.id === "stop")?.label, "Try Stop again");
});

test("view model localizes status, actions, and Stop recovery without translating runtime detail", () => {
  const live = createComputerUsePreviewViewModel(snapshot({ locale: "zh-CN", statusDetail: undefined }));
  assert.equal(live.label, "实时");
  assert.deepEqual(live.primaryActions.map((action) => action.label), ["打开任务", "隐藏"]);
  assert.deepEqual(live.menuActions.map((action) => action.label), ["重置位置", "关闭窗口", "停止 Computer Use"]);

  const permission = createComputerUsePreviewViewModel(snapshot({
    locale: "zh-CN",
    sourceStatus: "permission_denied",
    canOpenSettings: true,
  }));
  assert.equal(permission.label, "需要权限");
  assert.equal(permission.detail, "需要屏幕录制权限");
  assert.deepEqual(permission.menuActions.map((action) => action.label), [
    "重置位置",
    "屏幕设置",
    "重试捕获",
    "关闭窗口",
    "停止 Computer Use",
  ]);

  const failedStop = createComputerUsePreviewViewModel(
    snapshot({ locale: "zh-CN" }),
    { stopCommandState: "failed" },
  );
  assert.equal(failedStop.label, "停止失败");
  assert.equal(failedStop.detail, "Computer Use 仍在运行，请重试。");
  assert.equal(failedStop.overlayAction?.label, "再次尝试停止");

  const dynamicFailure = createComputerUsePreviewViewModel(snapshot({
    locale: "zh-CN",
    sourceStatus: "failed",
    statusDetail: "capture_transport_error_42",
  }));
  assert.equal(dynamicFailure.label, "失败");
  assert.equal(dynamicFailure.detail, "capture_transport_error_42");
});

test("unsupported renderer locale falls back to English", () => {
  const viewModel = createComputerUsePreviewViewModel(snapshot({ locale: "fr-FR" }));
  assert.equal(viewModel.label, "Live");
  assert.equal(viewModel.primaryActions[0].label, "Open task");
});

function snapshot(overrides = {}) {
  return {
    sessionId: "session-1",
    conversationId: "conversation-1",
    locale: "en-US",
    targetLabel: "Example Browser",
    runtimeStatus: "running",
    sourceStatus: "live",
    sourceKind: "fake",
    sourceRevision: 1,
    visibilityIntent: "auto",
    frameReady: true,
    aspectRatio: 1.6,
    canStop: true,
    canOpenSettings: false,
    ...overrides,
  };
}
