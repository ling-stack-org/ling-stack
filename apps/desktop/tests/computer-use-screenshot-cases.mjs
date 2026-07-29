export const computerUseScreenshotThemes = Object.freeze(["light", "dark"]);

export const computerUseScreenshotCases = Object.freeze([
  Object.freeze({ id: "minimum", width: 320, height: 200 }),
  Object.freeze({ id: "default", width: 420, height: 263 }),
  Object.freeze({ id: "maximum", width: 480, height: 300 }),
  Object.freeze({ id: "connecting", width: 420, height: 263, scenario: "connecting" }),
  Object.freeze({ id: "reconnecting", width: 420, height: 263, scenario: "reconnecting" }),
  Object.freeze({ id: "paused", width: 420, height: 263, scenario: "paused" }),
  Object.freeze({ id: "approval-required", width: 420, height: 263, scenario: "approval-required" }),
  Object.freeze({ id: "permission-required", width: 420, height: 263, scenario: "permission-required" }),
  Object.freeze({ id: "stopping", width: 420, height: 263, scenario: "stopping" }),
  Object.freeze({ id: "completed", width: 420, height: 263, scenario: "completed" }),
  Object.freeze({ id: "stopped", width: 420, height: 263, scenario: "stopped" }),
  Object.freeze({ id: "failed", width: 420, height: 263, scenario: "failed" }),
  Object.freeze({ id: "stop-failed", width: 420, height: 263, scenario: "stop-failed" }),
  Object.freeze({ id: "reduced-motion", width: 420, height: 263, scenario: "reduced-motion" }),
  Object.freeze({ id: "deck-stacked", width: 720, height: 450, scenario: "deck-stacked" }),
  Object.freeze({ id: "deck-tabs", width: 420, height: 263, scenario: "deck-tabs" }),
  Object.freeze({ id: "deck-view-all", width: 420, height: 263, scenario: "deck-view-all" }),
]);

const scenarioSnapshots = Object.freeze({
  live: Object.freeze({}),
  connecting: Object.freeze({
    runtimeStatus: "starting",
    sourceStatus: "connecting",
    frameReady: false,
  }),
  reconnecting: Object.freeze({
    runtimeStatus: "running",
    sourceStatus: "stalled",
    frameReady: false,
  }),
  paused: Object.freeze({
    runtimeStatus: "paused",
    sourceStatus: "live",
    frameReady: true,
  }),
  "approval-required": Object.freeze({
    runtimeStatus: "waiting_for_approval",
    sourceStatus: "live",
    frameReady: true,
  }),
  "permission-required": Object.freeze({
    runtimeStatus: "running",
    sourceStatus: "permission_denied",
    frameReady: false,
    canOpenSettings: true,
  }),
  stopping: Object.freeze({
    runtimeStatus: "stopping",
    sourceStatus: "live",
    frameReady: true,
  }),
  completed: Object.freeze({
    runtimeStatus: "succeeded",
    sourceStatus: "live",
    frameReady: true,
  }),
  stopped: Object.freeze({
    runtimeStatus: "cancelled",
    sourceStatus: "ended",
    frameReady: false,
  }),
  failed: Object.freeze({
    runtimeStatus: "failed",
    sourceStatus: "failed",
    frameReady: false,
  }),
  "stop-failed": Object.freeze({}),
  "reduced-motion": Object.freeze({}),
  "deck-stacked": Object.freeze({}),
  "deck-tabs": Object.freeze({}),
  "deck-view-all": Object.freeze({}),
});

const scenarioVisualStates = Object.freeze({
  live: "live",
  connecting: "connecting",
  reconnecting: "reconnecting",
  paused: "paused",
  "approval-required": "approval_required",
  "permission-required": "permission_required",
  stopping: "stopping",
  completed: "completed",
  stopped: "stopped",
  failed: "failed",
  "stop-failed": "stop_failed",
  "reduced-motion": "live",
  "deck-stacked": "live",
  "deck-tabs": "live",
  "deck-view-all": "live",
});

export function computerUseScreenshotSnapshot(scenario = "live") {
  const snapshot = scenarioSnapshots[scenario];
  if (!snapshot) {
    throw new Error(`unknown_computer_use_screenshot_scenario:${scenario}`);
  }
  return snapshot;
}

export function computerUseScreenshotVisualState(scenario = "live") {
  const visualState = scenarioVisualStates[scenario];
  if (!visualState) {
    throw new Error(`unknown_computer_use_screenshot_scenario:${scenario}`);
  }
  return visualState;
}

export function expectedComputerUseScreenshotManifestCases() {
  return computerUseScreenshotThemes.flatMap((theme) => (
    computerUseScreenshotCases.map((screenshotCase) => ({
      filename: `${screenshotCase.id}-${theme}.png`,
      theme,
      width: screenshotCase.width,
      height: screenshotCase.height,
      visualState: computerUseScreenshotVisualState(screenshotCase.scenario),
      reducedMotion: screenshotCase.scenario === "reduced-motion",
    }))
  ));
}
