import { _electron as electron, expect, test } from "@playwright/test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const testsDirectory = dirname(fileURLToPath(import.meta.url));
const harnessDirectory = join(testsDirectory, "computer-use-preview-renderer-harness");

let electronApp;
let page;
let rendererErrors;

test.beforeEach(async ({}, testInfo) => {
  rendererErrors = [];
  const displayMediaMode = testInfo.title.includes("display-media");
  const manualDisplayMediaMode = testInfo.title.includes("pending display-media acquisition");
  electronApp = await electron.launch({
    args: [harnessDirectory],
    env: {
      ...process.env,
      LING_PREVIEW_HARNESS_DISPLAY_MEDIA: manualDisplayMediaMode
        ? "manual"
        : displayMediaMode ? "1" : "0",
    },
  });
  page = await electronApp.firstWindow();
  page.on("console", (message) => {
    if (message.type() === "error") {
      rendererErrors.push(message.text());
    }
  });
  page.on("pageerror", (error) => rendererErrors.push(error.message));
  await expect(page.locator(".preview-shell")).toBeVisible();
  await page.locator(".preview-shell").hover();
});

test.afterEach(async () => {
  expect(rendererErrors).toEqual([]);
  await electronApp?.close();
});

test("keeps Open task, Hide, and More as the ordered top-level actions", async () => {
  const controls = page.locator(".preview-controls > button");
  const semanticOrder = await controls.evaluateAll((buttons) => buttons.map((button) => {
    const name = `${button.textContent ?? ""} ${button.getAttribute("aria-label") ?? ""}`.toLowerCase();
    if (name.includes("open task")) {
      return "open";
    }
    if (name.includes("hide")) {
      return "hide";
    }
    if (name.includes("more")) {
      return "more";
    }
    return name.trim();
  }));

  expect(semanticOrder).toEqual(["open", "hide", "more"]);

  await page.evaluate(() => window.lingPreviewTestHarness.clearCalls());
  await page.getByRole("button", { name: "Open task" }).click();
  await page.getByRole("button", { name: "Hide" }).click();
  const calls = await page.evaluate(() => window.lingPreviewTestHarness.getCalls());
  expect(calls
    .map((call) => call.name)
    .filter((name) => ["openOwnerConversation", "hide", "requestStop"].includes(name)))
    .toEqual(["openOwnerConversation", "hide"]);
});

test("supports Arrow, Home, End, and Escape navigation with focus return", async () => {
  const moreButton = page.getByRole("button", { name: "More preview actions" });
  await moreButton.click();

  const menu = page.getByRole("menu", { name: "Preview actions" });
  const items = menu.getByRole("menuitem");
  await expect(menu).toBeVisible();
  expect(await items.count()).toBeGreaterThan(1);
  await expect(items.first()).toBeFocused();

  await page.keyboard.press("ArrowDown");
  await expect(items.nth(1)).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(items.first()).toBeFocused();
  await page.keyboard.press("End");
  await expect(items.last()).toBeFocused();
  await page.keyboard.press("Home");
  await expect(items.first()).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(items.last()).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(moreButton).toBeFocused();
});

test("keeps Close window separate from Stop and orders the More menu safely", async () => {
  await page.getByRole("button", { name: "More preview actions" }).click();
  const menu = page.getByRole("menu", { name: "Preview actions" });
  const labels = await menu.getByRole("menuitem").allTextContents();
  expect(labels).toEqual(["Reset position", "Close window", "Stop Computer Use"]);
  await expect(menu.getByRole("separator")).toHaveCount(1);

  await page.evaluate(() => window.lingPreviewTestHarness.clearCalls());
  await page.getByRole("menuitem", { name: "Close window" }).click();
  const calls = await page.evaluate(() => window.lingPreviewTestHarness.getCalls());
  expect(calls.map((call) => call.name)).toContain("close");
  expect(calls.map((call) => call.name)).not.toContain("requestStop");
});

test("localizes a same-session snapshot while preserving the open menu and focused action", async () => {
  const moreButton = page.getByRole("button", { name: "More preview actions" });
  await moreButton.click();
  const menu = page.getByRole("menu", { name: "Preview actions" });
  const stopItem = page.getByRole("menuitem", { name: "Stop Computer Use" });
  await expect(menu.getByRole("menuitem").first()).toBeFocused();
  await stopItem.focus();
  await expect(stopItem).toBeFocused();

  await page.evaluate(() => window.lingPreviewTestHarness.pushSnapshot({
    locale: "zh-CN",
    statusDetail: undefined,
  }));

  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect(page.locator(".preview-shell")).toHaveAttribute(
    "aria-label",
    "Example Browser 的 Computer Use 预览",
  );
  await expect.poll(() => page.title()).toContain("实时");
  const localizedMoreButton = page.getByRole("button", { name: "更多预览操作" });
  const localizedMenu = page.getByRole("menu", { name: "预览操作" });
  const localizedStopItem = page.getByRole("menuitem", { name: "停止 Computer Use" });
  await expect(localizedMenu).toBeVisible();
  await expect(localizedMoreButton).toHaveAttribute("aria-expanded", "true");
  await expect(localizedStopItem).toBeFocused();
});

test("never maps Escape to Stop Computer Use", async () => {
  const moreButton = page.getByRole("button", { name: "More preview actions" });
  await moreButton.click();
  await page.evaluate(() => window.lingPreviewTestHarness.clearCalls());

  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  const calls = await page.evaluate(() => window.lingPreviewTestHarness.getCalls());
  expect(calls.map((call) => call.name)).not.toContain("requestStop");
  await expect(page.getByRole("menu", { name: "Preview actions" })).toBeHidden();
});

test("reports hover and keyboard-focus interaction without duplicate active edges", async () => {
  await page.evaluate(() => {
    const previewRoot = document.getElementById("preview-root");
    const focusSink = document.createElement("button");
    focusSink.id = "interaction-focus-sink";
    document.body.append(focusSink);
    focusSink.focus();
    previewRoot.dispatchEvent(new PointerEvent("pointerleave"));
    window.lingPreviewTestHarness.clearCalls();
    previewRoot.dispatchEvent(new PointerEvent("pointerenter"));
    previewRoot.dispatchEvent(new PointerEvent("pointerenter"));
  });
  await page.getByRole("button", { name: "Open task" }).focus();
  await page.getByRole("button", { name: "Hide" }).focus();
  await page.evaluate(() => {
    const focusSink = document.getElementById("interaction-focus-sink");
    focusSink.focus();
    focusSink.remove();
  });
  await page.evaluate(() => {
    const previewRoot = document.getElementById("preview-root");
    previewRoot.dispatchEvent(new PointerEvent("pointerleave"));
    previewRoot.dispatchEvent(new PointerEvent("pointerleave"));
  });

  await expect.poll(async () => page.evaluate(() => window.lingPreviewTestHarness
    .getCalls()
    .filter((call) => call.name === "reportInteraction")
    .map((call) => call.args[0])))
    .toEqual([
      { kind: "hover", active: true },
      { kind: "focus", active: true },
      { kind: "focus", active: false },
      { kind: "hover", active: false },
    ]);
});

test("shows a retryable failure when Stop is not accepted", async () => {
  await page.evaluate(() => {
    window.lingPreviewTestHarness.clearCalls();
    window.lingPreviewTestHarness.setCommandResult("requestStop", {
      accepted: false,
      reason: "runtime_busy",
    });
  });

  await invokeStop();

  const shell = page.locator(".preview-shell");
  await expect(shell).toHaveAttribute("data-stop-command", "failed");
  await expect(page.getByRole("alert")).toContainText("Stop failed");
  await expect(page.getByRole("button", { name: "Try Stop again" })).toBeVisible();
  expect(await callCount("requestStop")).toBe(1);
});

test("shows the same retryable failure when Stop rejects", async () => {
  await page.evaluate(() => {
    window.lingPreviewTestHarness.clearCalls();
    window.lingPreviewTestHarness.setCommandFailure("requestStop", "transport disconnected");
  });

  await invokeStop();

  await expect(page.locator(".preview-shell")).toHaveAttribute("data-stop-command", "failed");
  await expect(page.getByRole("alert")).toContainText("Computer Use is still running");
  await expect(page.getByRole("button", { name: "Try Stop again" })).toBeVisible();
  expect(await callCount("requestStop")).toBe(1);
});

test("keeps Stop pending until the runtime projection acknowledges it", async () => {
  await page.evaluate(() => {
    window.lingPreviewTestHarness.clearCalls();
    window.lingPreviewTestHarness.setCommandPending("requestStop");
  });

  await invokeStop();

  const shell = page.locator(".preview-shell");
  await expect(shell).toHaveAttribute("data-stop-command", "pending");
  await expect(page.getByRole("status")).toContainText("Stopping");
  expect(await callCount("requestStop")).toBe(1);

  expect(await page.evaluate(() => window.lingPreviewTestHarness.resolveCommand(
    "requestStop",
    { accepted: true },
  ))).toBe(true);
  await expect(shell).toHaveAttribute("data-stop-command", "pending");

  await page.evaluate(() => window.lingPreviewTestHarness.pushSnapshot({ runtimeStatus: "stopping" }));
  await expect(shell).toHaveAttribute("data-stop-command", "idle");
  await page.evaluate(() => window.lingPreviewTestHarness.pushSnapshot({ runtimeStatus: "cancelled" }));
  await expect(page.locator(".preview-status-overlay")).toContainText("Stopped");
});

test("times out a hung Stop command and ignores its late result", async () => {
  await page.clock.install();
  await page.evaluate(() => {
    window.lingPreviewTestHarness.clearCalls();
    window.lingPreviewTestHarness.setCommandPending("requestStop");
  });

  await invokeStop();
  const shell = page.locator(".preview-shell");
  await expect(shell).toHaveAttribute("data-stop-command", "pending");
  await page.clock.fastForward(10_001);

  await expect(shell).toHaveAttribute("data-stop-command", "failed");
  await expect(page.getByRole("button", { name: "Try Stop again" })).toBeVisible();
  expect(await page.evaluate(() => window.lingPreviewTestHarness.resolveCommand(
    "requestStop",
    { accepted: true },
  ))).toBe(true);
  await expect(shell).toHaveAttribute("data-stop-command", "failed");
  expect(await callCount("requestStop")).toBe(1);
});

test("accepted Stop fails retryably when the authoritative snapshot never converges", async () => {
  await page.clock.install();
  await page.evaluate(() => {
    window.lingPreviewTestHarness.clearCalls();
    window.lingPreviewTestHarness.setCommandResult("requestStop", { accepted: true });
  });

  await invokeStop();
  const shell = page.locator(".preview-shell");
  await expect(shell).toHaveAttribute("data-stop-command", "pending");
  await page.clock.fastForward(10_001);

  await expect(shell).toHaveAttribute("data-stop-command", "failed");
  await expect(page.getByRole("button", { name: "Try Stop again" })).toBeVisible();
  await page.evaluate(() => window.lingPreviewTestHarness.pushSnapshot({ runtimeStatus: "stopping" }));
  await expect(shell).toHaveAttribute("data-stop-command", "idle");
});

test("ignores a stale Stop result after the renderer switches sessions", async () => {
  await page.evaluate(() => {
    window.lingPreviewTestHarness.clearCalls();
    window.lingPreviewTestHarness.setCommandPending("requestStop");
  });
  await invokeStop();
  await expect(page.locator(".preview-shell")).toHaveAttribute("data-stop-command", "pending");

  await page.evaluate(() => window.lingPreviewTestHarness.pushSnapshot({
    sessionId: "renderer-harness-session-2",
    conversationId: "renderer-harness-conversation-2",
    targetLabel: "Next Browser Target",
  }));
  await expect(page.locator(".preview-shell")).toHaveAttribute("data-stop-command", "idle");
  expect(await page.evaluate(() => window.lingPreviewTestHarness.resolveCommand(
    "requestStop",
    { accepted: false, reason: "late_failure" },
  ))).toBe(true);

  await expect(page.locator(".preview-shell")).toHaveAttribute("data-state", "live");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect.poll(() => page.title()).toContain("Next Browser Target");
});

test("exposes status transitions through an observable aria-live region", async () => {
  const liveRegion = page.locator(".preview-status-overlay");
  await expect(liveRegion).toHaveAttribute("role", "status");
  await expect(liveRegion).toHaveAttribute("aria-live", "polite");
  await expect(liveRegion).toContainText("Live");

  await page.evaluate(() => window.lingPreviewTestHarness.pushSnapshot({
    runtimeStatus: "failed",
    sourceStatus: "live",
    statusDetail: "Runtime disconnected",
  }));

  await expect(liveRegion).toHaveAttribute("role", "alert");
  await expect(liveRegion).toHaveAttribute("aria-live", "assertive");
  await expect(liveRegion).toContainText("Failed");
  await expect(liveRegion).toContainText("Runtime disconnected");
});

test("keeps document.title synchronized with the current target", async () => {
  const initialTitle = await page.title();
  expect(initialTitle).toContain("Example Browser");
  expect(initialTitle.toLowerCase()).toContain("computer use preview");

  await page.evaluate(() => window.lingPreviewTestHarness.pushSnapshot({
    targetLabel: "Updated Spreadsheet Target",
  }));

  await expect.poll(() => page.title()).toContain("Updated Spreadsheet Target");
  expect(await page.title()).not.toContain("Example Browser");
});

test("serializes pending display-media acquisition across repeated same-source snapshots", async () => {
  await page.evaluate(() => {
    window.lingPreviewTestHarness.clearCalls();
    window.lingPreviewTestHarness.pushSnapshot({ statusDetail: "Connecting capture 1" });
    window.lingPreviewTestHarness.pushSnapshot({ statusDetail: "Connecting capture 2" });
  });

  await expect.poll(() => page.evaluate(() => window.lingPreviewTestHarness
    .getDisplayMediaRequestCount()))
    .toBe(1);
  await expect.poll(() => displayMediaState()).toMatchObject({
    pendingCount: 1,
    requests: [{
      audio: false,
      video: {
        frameRate: { ideal: 30, max: 30 },
        width: { ideal: 960, max: 960 },
        height: { ideal: 600, max: 600 },
      },
    }],
  });
  expect(await page.evaluate(() => window.lingPreviewTestHarness
    .resolveNextDisplayMediaAcquisition())).toBe(true);
  await expect.poll(() => callCount("reportFrameReady")).toBe(1);
});

test("display-media fallback waits for decoded data before reporting the first frame", async () => {
  await expect.poll(() => callCount("reportFrameReady")).toBe(1);
  expect(await page.evaluate(() => window.lingPreviewTestHarness.forceNoDecodedFrameFallback())).toBe(true);
  await page.evaluate(() => {
    window.lingPreviewTestHarness.clearCalls();
    window.lingPreviewTestHarness.pushSnapshot({
      sourceGeneration: 2,
      sourceStatus: "connecting",
      frameReady: false,
      statusDetail: "Waiting for decoded data",
    });
  });
  await expect.poll(() => page.evaluate(() => window.lingPreviewTestHarness
    .getDisplayMediaRequestCount()))
    .toBe(2);
  await page.waitForTimeout(100);
  expect(await callCount("reportFrameReady")).toBe(0);

  expect(await page.evaluate(() => window.lingPreviewTestHarness.restoreDecodedFrameFallback())).toBe(true);
  await expect.poll(() => callCount("reportFrameReady")).toBe(1);
});

test("display-media locale changes do not reacquire the source or report another first frame", async () => {
  await expect.poll(() => page.evaluate(() => window.lingPreviewTestHarness
    .getDisplayMediaRequestCount()))
    .toBe(1);
  await expect.poll(() => callCount("reportFrameReady")).toBe(1);
  await page.evaluate(() => {
    window.lingPreviewTestHarness.clearCalls();
    window.lingPreviewTestHarness.pushSnapshot({ locale: "zh-CN" });
  });

  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect(page.getByRole("button", { name: "打开任务" })).toBeVisible();
  expect(await page.evaluate(() => window.lingPreviewTestHarness.getDisplayMediaRequestCount())).toBe(1);
  expect(await callCount("reportFrameReady")).toBe(0);
});

test("releases live display-media tracks before acknowledging", async () => {
  await expect.poll(() => callCount("reportFrameReady")).toBe(1);
  await expect.poll(() => displayMediaState()).toMatchObject({
    requestCount: 1,
    pendingCount: 0,
    streamTrackStates: [["live"]],
  });

  await page.evaluate(() => window.lingPreviewTestHarness.clearCalls());
  const request = releaseRequest(1, "release-live");
  const acknowledgements = await page.evaluate((value) => window.lingPreviewTestHarness
    .emitReleaseMedia(value), request);

  expect(acknowledgements).toEqual([{
    ...request,
    status: "released",
    releasedTrackCount: 1,
    allTracksEnded: true,
  }]);
  await expect.poll(() => displayMediaState()).toMatchObject({
    pendingCount: 0,
    streamTrackStates: [["ended"]],
  });
  expect(await callCount("releaseMediaAck")).toBe(1);
});

test("waits for a pending display-media acquisition and stops its late stream before acknowledging", async () => {
  await expect.poll(() => displayMediaState()).toMatchObject({
    requestCount: 1,
    pendingCount: 1,
    streamTrackStates: [["live"]],
  });
  await page.evaluate(() => window.lingPreviewTestHarness.clearCalls());

  await page.evaluate((request) => {
    void window.lingPreviewTestHarness.emitReleaseMedia(request);
  }, releaseRequest(1, "release-pending"));
  await page.waitForTimeout(100);
  expect(await callCount("releaseMediaAck")).toBe(0);

  expect(await page.evaluate(() => window.lingPreviewTestHarness
    .resolveNextDisplayMediaAcquisition())).toBe(true);
  await expect.poll(() => page.evaluate(() => window.lingPreviewTestHarness
    .getCalls()
    .find((call) => call.name === "releaseMediaAck")?.args[0]))
    .toEqual({
      ...releaseRequest(1, "release-pending"),
      status: "released",
      releasedTrackCount: 1,
      allTracksEnded: true,
    });
  await expect.poll(() => displayMediaState()).toMatchObject({
    pendingCount: 0,
    streamTrackStates: [["ended"]],
  });
  expect(await callCount("reportSourceFailure")).toBe(0);
});

test("same-revision display-media source replacement reacquires and releases only the exact generation", async () => {
  await expect.poll(() => callCount("reportFrameReady")).toBe(1);
  await page.evaluate(() => window.lingPreviewTestHarness.pushSnapshot({
    sourceGeneration: 2,
    sourceStatus: "connecting",
    frameReady: false,
    statusDetail: "Switching source",
  }));
  await expect.poll(() => page.evaluate(() => window.lingPreviewTestHarness
    .getDisplayMediaRequestCount())).toBe(2);
  await expect.poll(() => page.evaluate(() => window.lingPreviewTestHarness
    .getCalls()
    .filter((call) => call.name === "reportFrameReady" && call.args[1] === 1 && call.args[2] === 2).length))
    .toBe(1);
  await expect.poll(() => displayMediaState()).toMatchObject({
    streamTrackStates: [["ended"], ["live"]],
  });

  await page.evaluate(() => window.lingPreviewTestHarness.clearCalls());
  const request = releaseRequest(1, "release-stale", 1);
  const acknowledgements = await page.evaluate((value) => window.lingPreviewTestHarness
    .emitReleaseMedia(value), request);

  expect(acknowledgements).toEqual([{
    ...request,
    status: "identity_mismatch",
    releasedTrackCount: 0,
    allTracksEnded: false,
  }]);
  await expect.poll(() => displayMediaState()).toMatchObject({
    streamTrackStates: [["ended"], ["live"]],
  });

  const currentRequest = releaseRequest(1, "release-current", 2);
  const currentAcknowledgements = await page.evaluate((value) => window.lingPreviewTestHarness
    .emitReleaseMedia(value), currentRequest);
  expect(currentAcknowledgements).toEqual([{
    ...currentRequest,
    status: "released",
    releasedTrackCount: 1,
    allTracksEnded: true,
  }]);
  await expect.poll(() => displayMediaState()).toMatchObject({
    streamTrackStates: [["ended"], ["ended"]],
  });
});

async function invokeStop() {
  await page.getByRole("button", { name: "More preview actions" }).click();
  await page.getByRole("menuitem", { name: "Stop Computer Use" }).click();
}

async function callCount(name) {
  return page.evaluate((callName) => window.lingPreviewTestHarness
    .getCalls()
    .filter((call) => call.name === callName).length, name);
}

async function displayMediaState() {
  return page.evaluate(() => window.lingPreviewTestHarness.getDisplayMediaState());
}

function releaseRequest(sourceRevision, requestId, sourceGeneration = 1) {
  return {
    requestId,
    sessionId: "renderer-harness-session",
    sourceRevision,
    sourceGeneration,
  };
}
