import assert from "node:assert/strict";
import test from "node:test";
import { ComputerUsePreviewCoordinator } from "../dist/main/computer-use/coordinator.js";
import { FakeComputerUsePreviewPlatformAdapter } from "../dist/main/computer-use/fake-platform-adapter.js";
import {
  FAKE_COMPUTER_USE_PROJECTION,
  FakeComputerUseProjectionClient,
} from "../dist/main/computer-use/fake-projection-client.js";
import { encodeComputerUsePipNormalizedPlacement } from "../dist/main/computer-use/layout.js";

test("Computer Use preview waits for the first frame and Hide releases media without Stop", async () => {
  const client = new CountingProjectionClient(FAKE_COMPUTER_USE_PROJECTION);
  const adapter = new FakeComputerUsePreviewPlatformAdapter();
  const preferences = new MemoryPreferenceStore();
  const windows = [];
  const coordinator = createCoordinator({ client, adapter, preferences, windows });
  await coordinator.start();
  coordinator.reportSelectedConversation(FAKE_COMPUTER_USE_PROJECTION.conversationId);
  await flush();

  assert.equal(windows.length, 1);
  assert.equal(windows[0].showCount, 0, "empty preview must remain hidden before first frame");
  assert.equal(coordinator.getSummary().visible, false);
  coordinator.reportFrameReady(FAKE_COMPUTER_USE_PROJECTION.sessionId);
  assert.equal(windows[0].showCount, 1);
  assert.equal(coordinator.getSummary().visible, true);
  assert.equal(coordinator.getRendererSnapshot().visibilityIntent, "auto");

  const hidden = await coordinator.hide(FAKE_COMPUTER_USE_PROJECTION.sessionId);
  assert.equal(hidden.accepted, true);
  assert.equal(windows[0].hideCount, 1);
  assert.equal(coordinator.getSummary().visible, false);
  assert.equal(adapter.releaseCount, 1);
  assert.equal(client.stopCount, 0, "Hide must never call runtime Stop");
  assert.equal(
    windows[0].messages.some((message) => message.channel.endsWith("preview-release-media")),
    false,
    "fake sources do not own renderer MediaStream tracks",
  );
  await coordinator.dispose();
  assert.equal(adapter.disposeCount, 1, "coordinator shutdown must dispose the Session-scoped adapter once");
});

test("locale changes update renderer copy without reopening the window or source", async () => {
  const client = new CountingProjectionClient(FAKE_COMPUTER_USE_PROJECTION);
  const adapter = new FakeComputerUsePreviewPlatformAdapter();
  const windows = [];
  const coordinator = createCoordinator({
    client,
    adapter,
    preferences: new MemoryPreferenceStore(),
    windows,
  });
  coordinator.reportLocale("zh-CN");
  await coordinator.start();
  coordinator.reportSelectedConversation(FAKE_COMPUTER_USE_PROJECTION.conversationId);
  await flush();
  coordinator.reportFrameReady(FAKE_COMPUTER_USE_PROJECTION.sessionId, 1);

  const before = structuredClone(coordinator.getRendererSnapshot());
  assert.equal(before.locale, "zh-CN");
  const prepareCount = adapter.prepareCount;
  const loadedPathCount = windows[0].loadedPaths.length;
  const showCount = windows[0].showCount;
  const messageCount = windows[0].messages.length;

  coordinator.reportLocale("en-US");
  const after = coordinator.getRendererSnapshot();
  assert.equal(after.locale, "en-US");
  assert.equal(after.sessionId, before.sessionId);
  assert.equal(after.sourceRevision, before.sourceRevision);
  assert.equal(after.sourceKind, before.sourceKind);
  assert.equal(after.frameReady, before.frameReady);
  assert.equal(adapter.prepareCount, prepareCount, "locale must not reacquire the source");
  assert.equal(windows.length, 1, "locale must not create another BrowserWindow");
  assert.equal(windows[0].loadedPaths.length, loadedPathCount, "locale must not reload the renderer");
  assert.equal(windows[0].showCount, showCount, "locale must not reveal the window again");
  assert.equal(windows[0].messages.length, messageCount + 1);
  assert.equal(windows[0].messages.at(-1).args[0].locale, "en-US");

  coordinator.reportLocale("en-US");
  assert.equal(windows[0].messages.length, messageCount + 1, "duplicate locale reports are no-ops");

  client.emit({
    ...FAKE_COMPUTER_USE_PROJECTION,
    preview: { ...FAKE_COMPUTER_USE_PROJECTION.preview, revision: 2 },
    updatedAt: "2026-07-15T00:00:02.000Z",
  });
  await flush();
  assert.equal(coordinator.getRendererSnapshot().locale, "en-US", "new revisions inherit the latest locale");
  await coordinator.dispose();
});

test("coordinator disposal completes and disposes the platform adapter when subscription close throws", async () => {
  const adapter = new FakeComputerUsePreviewPlatformAdapter();
  const coordinator = createCoordinator({
    client: new ThrowingCloseProjectionClient(FAKE_COMPUTER_USE_PROJECTION),
    adapter,
    preferences: new MemoryPreferenceStore(),
    windows: [],
  });
  await coordinator.start();

  await coordinator.dispose();
  assert.equal(adapter.disposeCount, 1, "adapter disposal must run even when subscription cleanup fails");
});

test("late renderer source events cannot leave recovery timers after coordinator disposal", async () => {
  const clock = createVirtualTimerHarness("2026-07-15T12:00:00.000Z");
  const adapter = new DeferredReleaseAdapter();
  const coordinator = createCoordinator({
    client: new CountingProjectionClient(FAKE_COMPUTER_USE_PROJECTION),
    adapter,
    preferences: new MemoryPreferenceStore(),
    windows: [],
    now: () => new Date(clock.nowMs),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  await coordinator.start();
  coordinator.reportSelectedConversation(FAKE_COMPUTER_USE_PROJECTION.conversationId);
  await flush();
  coordinator.reportFrameReady(FAKE_COMPUTER_USE_PROJECTION.sessionId, 1);

  const disposal = coordinator.dispose();
  await adapter.releaseStarted.promise;
  coordinator.reportSourceEnded(FAKE_COMPUTER_USE_PROJECTION.sessionId, 1, "late_capture_track_ended");
  await flush();
  adapter.allowRelease.resolve();
  await disposal;

  assert.deepEqual(
    clock.activeTimers().map((timer) => timer.milliseconds),
    [],
    "disposing coordinator must reject late source events and finish with zero timers",
  );
  assert.equal(adapter.disposeCount, 1);
});

test("Computer Use telemetry measures first frame and recovery without carrying source identity", async () => {
  let nowMs = Date.parse("2026-07-15T12:00:00.000Z");
  const events = [];
  const windows = [];
  const coordinator = createCoordinator({
    client: new CountingProjectionClient(FAKE_COMPUTER_USE_PROJECTION),
    adapter: new FakeComputerUsePreviewPlatformAdapter(),
    preferences: new MemoryPreferenceStore(),
    windows,
    now: () => new Date(nowMs),
    telemetry: { record: (event) => events.push(event) },
  });
  await coordinator.start();
  coordinator.reportSelectedConversation(FAKE_COMPUTER_USE_PROJECTION.conversationId);
  await flush();

  nowMs += 125;
  coordinator.reportFrameReady(FAKE_COMPUTER_USE_PROJECTION.sessionId);
  coordinator.reportSourceEnded(FAKE_COMPUTER_USE_PROJECTION.sessionId, "capture_track_ended");
  nowMs += 375;
  coordinator.reportFrameReady(FAKE_COMPUTER_USE_PROJECTION.sessionId);
  await coordinator.hide(FAKE_COMPUTER_USE_PROJECTION.sessionId);

  assert.deepEqual(events.slice(0, 4), [
    { name: "preview_opened", firstFrameLatencyMs: 125 },
    { name: "preview_source_stalled" },
    { name: "preview_recovered", recoveryLatencyMs: 375 },
    { name: "preview_hidden", reason: "user" },
  ]);
  assert.equal(JSON.stringify(events).includes(FAKE_COMPUTER_USE_PROJECTION.target.displayName), false);
  assert.equal(JSON.stringify(events).includes(FAKE_COMPUTER_USE_PROJECTION.preview.descriptorId), false);
  await coordinator.dispose();
});

test("Hide before the first frame prevents a flash and Show can reopen the same session", async () => {
  const windows = [];
  const adapter = new FakeComputerUsePreviewPlatformAdapter();
  const client = new CountingProjectionClient(FAKE_COMPUTER_USE_PROJECTION);
  const coordinator = createCoordinator({
    client,
    adapter,
    preferences: new MemoryPreferenceStore(),
    windows,
  });
  await coordinator.start();
  coordinator.reportSelectedConversation(FAKE_COMPUTER_USE_PROJECTION.conversationId);
  await flush();

  const preview = windows[0];
  assert.equal(preview.showCount, 0);
  const loadedPathCount = preview.loadedPaths.length;
  const hidden = await coordinator.hide(FAKE_COMPUTER_USE_PROJECTION.sessionId);
  assert.deepEqual(hidden, { accepted: true });
  assert.equal(preview.hideCount, 1);
  assert.equal(adapter.releaseCount, 1);
  assert.equal(client.stopCount, 0);

  coordinator.reportFrameReady(FAKE_COMPUTER_USE_PROJECTION.sessionId);
  assert.equal(preview.showCount, 0, "a stale first-frame callback must not reopen a hidden preview");

  const shown = await coordinator.show(FAKE_COMPUTER_USE_PROJECTION.sessionId);
  await flush();
  assert.deepEqual(shown, { accepted: true });
  assert.equal(windows.length, 1, "Show should reuse the existing hidden window");
  assert.equal(
    preview.loadedPaths.length,
    loadedPathCount,
    "Show should reuse the loaded renderer document instead of reloading it",
  );
  coordinator.reportFrameReady(FAKE_COMPUTER_USE_PROJECTION.sessionId);
  assert.equal(preview.showCount, 1);
  await coordinator.dispose();
});

test("display-media Hide waits for release acknowledgement and keeps the reusable window", async () => {
  const windows = [];
  const client = new CountingProjectionClient(FAKE_COMPUTER_USE_PROJECTION);
  const adapter = new DisplayMediaFakeAdapter();
  const coordinator = createCoordinator({
    client,
    adapter,
    preferences: new MemoryPreferenceStore(),
    windows,
  });
  await coordinator.start();
  coordinator.reportSelectedConversation(FAKE_COMPUTER_USE_PROJECTION.conversationId);
  await flush();
  coordinator.reportFrameReady(FAKE_COMPUTER_USE_PROJECTION.sessionId, 1);
  const sourceGeneration = coordinator.getRendererSnapshot().sourceGeneration;

  const hidden = await coordinator.hide(FAKE_COMPUTER_USE_PROJECTION.sessionId);
  assert.deepEqual(hidden, { accepted: true });
  assert.equal(windows[0].releaseRequests.length, 1);
  assert.deepEqual(
    {
      sessionId: windows[0].releaseRequests[0].sessionId,
      sourceRevision: windows[0].releaseRequests[0].sourceRevision,
      sourceGeneration: windows[0].releaseRequests[0].sourceGeneration,
    },
    { sessionId: FAKE_COMPUTER_USE_PROJECTION.sessionId, sourceRevision: 1, sourceGeneration },
  );
  assert.equal(windows[0].destroyCount, 0, "an acknowledged Hide keeps the renderer reusable");
  assert.equal(client.stopCount, 0);
  await coordinator.dispose();
});

test("missing display-media release acknowledgement force-destroys the exact window without Stop", async () => {
  const clock = createVirtualTimerHarness("2026-07-15T12:00:00.000Z");
  const windows = [];
  const client = new CountingProjectionClient(FAKE_COMPUTER_USE_PROJECTION);
  const coordinator = createCoordinator({
    client,
    adapter: new DisplayMediaFakeAdapter(),
    preferences: new MemoryPreferenceStore(),
    windows,
    now: () => new Date(clock.nowMs),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  await coordinator.start();
  coordinator.reportSelectedConversation(FAKE_COMPUTER_USE_PROJECTION.conversationId);
  await flush();
  coordinator.reportFrameReady(FAKE_COMPUTER_USE_PROJECTION.sessionId, 1);
  windows[0].releaseAckMode = "none";

  let hideSettled = false;
  const hide = coordinator.hide(FAKE_COMPUTER_USE_PROJECTION.sessionId).then((result) => {
    hideSettled = true;
    return result;
  });
  await flush();
  assert.equal(hideSettled, false, "Hide cleanup waits for renderer release evidence");
  assert.equal(clock.activeTimer(500)?.milliseconds, 500);
  await clock.fireNext();

  assert.deepEqual(await hide, { accepted: true });
  assert.equal(windows[0].destroyCount, 1);
  assert.equal(client.stopCount, 0, "privacy fallback must never stop the runtime");
  assert.deepEqual(clock.activeTimers(), []);
  await coordinator.dispose();
});

test("negative display-media release acknowledgement destroys the renderer without Stop", async () => {
  const windows = [];
  const client = new CountingProjectionClient(FAKE_COMPUTER_USE_PROJECTION);
  const coordinator = createCoordinator({
    client,
    adapter: new DisplayMediaFakeAdapter(),
    preferences: new MemoryPreferenceStore(),
    windows,
  });
  await coordinator.start();
  coordinator.reportSelectedConversation(FAKE_COMPUTER_USE_PROJECTION.conversationId);
  await flush();
  coordinator.reportFrameReady(FAKE_COMPUTER_USE_PROJECTION.sessionId, 1);
  windows[0].releaseAckMode = "identity_mismatch";

  assert.deepEqual(await coordinator.hide(FAKE_COMPUTER_USE_PROJECTION.sessionId), { accepted: true });
  assert.equal(windows[0].destroyCount, 1);
  assert.equal(client.stopCount, 0);
  await coordinator.dispose();
});

test("renderer crash settles a pending release before queued crash cleanup", async () => {
  const clock = createVirtualTimerHarness("2026-07-15T12:00:00.000Z");
  const windows = [];
  const adapter = new DeferredDisplayMediaReleaseAdapter();
  const client = new CountingProjectionClient(FAKE_COMPUTER_USE_PROJECTION);
  const coordinator = createCoordinator({
    client,
    adapter,
    preferences: new MemoryPreferenceStore(),
    windows,
    now: () => new Date(clock.nowMs),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  await coordinator.start();
  coordinator.reportSelectedConversation(FAKE_COMPUTER_USE_PROJECTION.conversationId);
  await flush();
  coordinator.reportFrameReady(FAKE_COMPUTER_USE_PROJECTION.sessionId, 1);
  windows[0].releaseAckMode = "none";

  const hide = coordinator.hide(FAKE_COMPUTER_USE_PROJECTION.sessionId);
  await adapter.releaseStarted.promise;
  assert.equal(clock.activeTimer(500)?.milliseconds, 500);
  windows[0].emitRendererProcessGone({ reason: "crashed-during-release", exitCode: 12 });
  await flush();
  assert.equal(clock.activeTimer(500), undefined, "renderer death must synchronously clear the ACK deadline");

  adapter.allowRelease.resolve();
  assert.deepEqual(await hide, { accepted: true });
  await flush();
  assert.equal(windows[0].destroyCount, 1);
  assert.equal(client.stopCount, 0);
  assert.deepEqual(clock.activeTimers(), []);
  await coordinator.dispose();
});

test("adapter release failure still force-destroys display media without Stop", async () => {
  const windows = [];
  const client = new CountingProjectionClient(FAKE_COMPUTER_USE_PROJECTION);
  const coordinator = createCoordinator({
    client,
    adapter: new ThrowingDisplayMediaReleaseAdapter(),
    preferences: new MemoryPreferenceStore(),
    windows,
  });
  await coordinator.start();
  coordinator.reportSelectedConversation(FAKE_COMPUTER_USE_PROJECTION.conversationId);
  await flush();
  coordinator.reportFrameReady(FAKE_COMPUTER_USE_PROJECTION.sessionId, 1);

  await assert.rejects(
    coordinator.hide(FAKE_COMPUTER_USE_PROJECTION.sessionId),
    /display_media_release_failed/,
  );
  assert.equal(windows[0].destroyCount, 1);
  assert.equal(client.stopCount, 0);
  await coordinator.dispose();
});

test("stale renderer callbacks from an older descriptor revision are ignored", async () => {
  const windows = [];
  const coordinator = createCoordinator({
    client: new CountingProjectionClient(FAKE_COMPUTER_USE_PROJECTION),
    adapter: new FakeComputerUsePreviewPlatformAdapter(),
    preferences: new MemoryPreferenceStore(),
    windows,
  });
  await coordinator.start();
  coordinator.reportSelectedConversation(FAKE_COMPUTER_USE_PROJECTION.conversationId);
  await flush();

  coordinator.reportFrameReady(FAKE_COMPUTER_USE_PROJECTION.sessionId, 99);
  assert.equal(windows[0].showCount, 0);
  assert.equal(coordinator.getRendererSnapshot().frameReady, false);

  coordinator.reportFrameReady(FAKE_COMPUTER_USE_PROJECTION.sessionId, 1);
  assert.equal(windows[0].showCount, 1);
  await coordinator.dispose();
});

test("renderer crash releases the dead renderer media and recreates once per active session", async () => {
  const windows = [];
  const telemetryEvents = [];
  const adapter = new FakeComputerUsePreviewPlatformAdapter();
  const client = new CountingProjectionClient(FAKE_COMPUTER_USE_PROJECTION);
  const coordinator = createCoordinator({
    client,
    adapter,
    preferences: new MemoryPreferenceStore(),
    windows,
    telemetry: { record: (event) => telemetryEvents.push(event) },
  });
  await coordinator.start();
  coordinator.reportSelectedConversation(FAKE_COMPUTER_USE_PROJECTION.conversationId);
  await flush();

  const firstWindow = windows[0];
  coordinator.reportFrameReady(FAKE_COMPUTER_USE_PROJECTION.sessionId);
  const sendsBeforeCrash = firstWindow.sendAttemptCount;
  firstWindow.sendThrows = true;
  firstWindow.emitRendererProcessGone({ reason: "crashed", exitCode: 9 });
  await flush();

  assert.equal(firstWindow.destroyCount, 1, "the crashed BrowserWindow must be destroyed");
  assert.equal(
    firstWindow.sendAttemptCount,
    sendsBeforeCrash,
    "crash cleanup must not send a release command into a disposed renderer frame",
  );
  assert.equal(firstWindow.rendererGoneListeners.length, 0, "the old crash listener must be removed");
  assert.equal(firstWindow.closedListeners.length, 0, "the old close listener must be removed");
  assert.equal(firstWindow.moveListeners.length + firstWindow.resizeListeners.length, 0, "old layout listeners must be removed");
  assert.equal(windows.length, 2, "an eligible session gets one automatic recreation");
  assert.equal(client.stopCount, 0, "renderer recovery must not stop the runtime");
  assert.equal(adapter.releaseCount >= 1, true, "main-process media cleanup must run even when send() throws");

  const recreatedWindow = windows[1];
  assert.equal(recreatedWindow.showCount, 0, "the recreated preview remains gated until its first frame");
  coordinator.reportFrameReady(FAKE_COMPUTER_USE_PROJECTION.sessionId);
  assert.equal(recreatedWindow.showCount, 1);

  recreatedWindow.emitRendererProcessGone({ reason: "crashed-again", exitCode: 10 });
  await flush();
  assert.equal(recreatedWindow.destroyCount, 1);
  assert.equal(windows.length, 2, "a second crash must not create an automatic crash loop");
  assert.equal(client.stopCount, 0);
  assert.equal(coordinator.getSummary()?.visible, false, "the active runtime remains recoverable but hidden");
  assert.deepEqual(
    telemetryEvents.filter((event) => event.name.startsWith("preview_renderer_")),
    [
      { name: "preview_renderer_crashed", crashCount: 1 },
      { name: "preview_renderer_recreated", recreationCount: 1 },
      { name: "preview_renderer_crashed", crashCount: 2 },
    ],
  );

  const explicitShow = await coordinator.show(FAKE_COMPUTER_USE_PROJECTION.sessionId);
  await flush();
  assert.equal(explicitShow.accepted, true);
  assert.equal(windows.length, 3, "explicit Show remains an escape hatch after auto recovery is exhausted");
  const finalWindow = windows[2];
  coordinator.reportFrameReady(FAKE_COMPUTER_USE_PROJECTION.sessionId, 1);
  finalWindow.emitRendererProcessGone({ reason: "crashed-after-explicit-show", exitCode: 11 });
  await flush();
  assert.equal(finalWindow.destroyCount, 1);
  assert.equal(
    windows.length,
    3,
    "explicit Show must not reset the one-automatic-recreation budget for later crashes",
  );
  await coordinator.dispose();
  assert.equal(finalWindow.destroyCount, 1);
  assert.equal(finalWindow.closedListeners.length, 0);
  assert.equal(finalWindow.moveListeners.length + finalWindow.resizeListeners.length, 0);
  assert.equal(finalWindow.rendererGoneListeners.length, 0);
});

test("renderer crash cannot reopen a user-hidden session", async () => {
  const windows = [];
  const coordinator = createCoordinator({
    client: new CountingProjectionClient(FAKE_COMPUTER_USE_PROJECTION),
    adapter: new FakeComputerUsePreviewPlatformAdapter(),
    preferences: new MemoryPreferenceStore(),
    windows,
  });
  await coordinator.start();
  coordinator.reportSelectedConversation(FAKE_COMPUTER_USE_PROJECTION.conversationId);
  await flush();
  coordinator.reportFrameReady(FAKE_COMPUTER_USE_PROJECTION.sessionId, 1);
  await coordinator.hide(FAKE_COMPUTER_USE_PROJECTION.sessionId);

  windows[0].emitRendererProcessGone({ reason: "crashed-while-hidden", exitCode: 12 });
  await flush();
  assert.equal(windows[0].destroyCount, 1);
  assert.equal(windows.length, 1);
  assert.equal(coordinator.getSummary()?.visible, false);
  await coordinator.dispose();
});

test("explicit Show under auto-show off remains eligible for one renderer recreation", async () => {
  const windows = [];
  const coordinator = createCoordinator({
    client: new CountingProjectionClient(FAKE_COMPUTER_USE_PROJECTION),
    adapter: new FakeComputerUsePreviewPlatformAdapter(),
    preferences: new MemoryPreferenceStore(),
    windows,
  });
  await coordinator.start();
  await coordinator.setAutoShow(false);
  coordinator.reportSelectedConversation(FAKE_COMPUTER_USE_PROJECTION.conversationId);
  await flush();
  assert.equal(windows.length, 0);

  assert.deepEqual(await coordinator.show(FAKE_COMPUTER_USE_PROJECTION.sessionId), { accepted: true });
  await flush();
  coordinator.reportFrameReady(FAKE_COMPUTER_USE_PROJECTION.sessionId, 1);
  windows[0].emitRendererProcessGone({ reason: "explicit-show-crash", exitCode: 13 });
  await flush();
  assert.equal(windows.length, 2);
  assert.equal(windows[1].showCount, 0);
  await coordinator.dispose();
});

test("renderer crash release failure still restores the active summary and attempts reconciliation", async () => {
  const windows = [];
  const client = new CountingProjectionClient(FAKE_COMPUTER_USE_PROJECTION);
  const coordinator = createCoordinator({
    client,
    adapter: new ThrowingDisplayMediaReleaseAdapter(),
    preferences: new MemoryPreferenceStore(),
    windows,
  });
  await coordinator.start();
  coordinator.reportSelectedConversation(FAKE_COMPUTER_USE_PROJECTION.conversationId);
  await flush();
  coordinator.reportFrameReady(FAKE_COMPUTER_USE_PROJECTION.sessionId, 1);

  windows[0].emitRendererProcessGone({ reason: "crashed-with-release-failure", exitCode: 14 });
  await flush();

  assert.equal(windows[0].destroyCount, 1);
  assert.equal(windows.length, 2, "cleanup failure must not skip the bounded recreation attempt");
  assert.equal(coordinator.getSummary()?.sessionId, FAKE_COMPUTER_USE_PROJECTION.sessionId);
  assert.equal(coordinator.getSummary()?.visible, false);
  assert.equal(client.stopCount, 0);
  await coordinator.dispose();
});

test("auto-show off retained visible crash does not report or perform renderer recreation", async () => {
  const windows = [];
  const telemetryEvents = [];
  const coordinator = createCoordinator({
    client: new CountingProjectionClient(FAKE_COMPUTER_USE_PROJECTION),
    adapter: new FakeComputerUsePreviewPlatformAdapter(),
    preferences: new MemoryPreferenceStore(),
    windows,
    telemetry: { record: (event) => telemetryEvents.push(event) },
  });
  await coordinator.start();
  coordinator.reportSelectedConversation(FAKE_COMPUTER_USE_PROJECTION.conversationId);
  await flush();
  coordinator.reportFrameReady(FAKE_COMPUTER_USE_PROJECTION.sessionId, 1);
  await coordinator.setAutoShow(false);
  assert.equal(windows[0].isVisible(), true, "turning auto-show off retains the current surface");

  windows[0].emitRendererProcessGone({ reason: "visible-auto-off-crash", exitCode: 15 });
  await flush();

  assert.equal(windows[0].destroyCount, 1);
  assert.equal(windows.length, 1);
  assert.equal(coordinator.getSummary()?.visible, false);
  assert.deepEqual(
    telemetryEvents.filter((event) => event.name.startsWith("preview_renderer_")),
    [{ name: "preview_renderer_crashed", crashCount: 1 }],
  );
  await coordinator.dispose();
});

test("hidden-session suppression survives coordinator restart", async () => {
  const preferences = new MemoryPreferenceStore();
  const firstWindows = [];
  const first = createCoordinator({
    client: new CountingProjectionClient(FAKE_COMPUTER_USE_PROJECTION),
    adapter: new FakeComputerUsePreviewPlatformAdapter(),
    preferences,
    windows: firstWindows,
  });
  await first.start();
  first.reportSelectedConversation(FAKE_COMPUTER_USE_PROJECTION.conversationId);
  await flush();
  await first.hide(FAKE_COMPUTER_USE_PROJECTION.sessionId);
  await first.dispose();

  const secondWindows = [];
  const second = createCoordinator({
    client: new CountingProjectionClient(FAKE_COMPUTER_USE_PROJECTION),
    adapter: new FakeComputerUsePreviewPlatformAdapter(),
    preferences,
    windows: secondWindows,
  });
  await second.start();
  second.reportSelectedConversation(FAKE_COMPUTER_USE_PROJECTION.conversationId);
  await flush();
  assert.equal(secondWindows.length, 0);
  await second.dispose();
});

test("native Close persists suppression and stale callbacks cannot recreate the preview", async () => {
  const preferences = new MemoryPreferenceStore();
  const client = new CountingProjectionClient(FAKE_COMPUTER_USE_PROJECTION);
  const firstWindows = [];
  const first = createCoordinator({
    client,
    adapter: new FakeComputerUsePreviewPlatformAdapter(),
    preferences,
    windows: firstWindows,
  });
  await first.start();
  first.reportSelectedConversation(FAKE_COMPUTER_USE_PROJECTION.conversationId);
  await flush();
  first.reportFrameReady(FAKE_COMPUTER_USE_PROJECTION.sessionId, 1);
  firstWindows[0].destroy();
  await flush();

  assert.ok(preferences.value.hiddenSessionSuppressions[FAKE_COMPUTER_USE_PROJECTION.sessionId]);
  assert.equal(client.stopCount, 0);
  first.reportFrameReady(FAKE_COMPUTER_USE_PROJECTION.sessionId, 1);
  assert.equal(firstWindows.length, 1);
  assert.equal(first.getSummary()?.visible, false);
  await first.dispose();

  const secondWindows = [];
  const second = createCoordinator({
    client,
    adapter: new FakeComputerUsePreviewPlatformAdapter(),
    preferences,
    windows: secondWindows,
  });
  await second.start();
  second.reportSelectedConversation(FAKE_COMPUTER_USE_PROJECTION.conversationId);
  await flush();
  assert.equal(secondWindows.length, 0);
  assert.deepEqual(await second.show(FAKE_COMPUTER_USE_PROJECTION.sessionId), { accepted: true });
  await flush();
  assert.equal(secondWindows.length, 1);
  assert.equal(secondWindows[0].showCount, 0);
  second.reportFrameReady(FAKE_COMPUTER_USE_PROJECTION.sessionId, 1);
  assert.equal(secondWindows[0].showCount, 1);
  await second.dispose();
});

test("switching away destroys the preview without stopping the runtime and switching back reopens it", async () => {
  const windows = [];
  const adapter = new FakeComputerUsePreviewPlatformAdapter();
  const client = new CountingProjectionClient(FAKE_COMPUTER_USE_PROJECTION);
  const coordinator = createCoordinator({
    client,
    adapter,
    preferences: new MemoryPreferenceStore(),
    windows,
  });
  await coordinator.start();
  coordinator.reportSelectedConversation(FAKE_COMPUTER_USE_PROJECTION.conversationId);
  await flush();
  coordinator.reportFrameReady(FAKE_COMPUTER_USE_PROJECTION.sessionId);

  coordinator.reportSelectedConversation("another-conversation");
  await flush();
  assert.equal(windows[0].destroyCount, 1);
  assert.equal(adapter.releaseCount, 1);
  assert.equal(client.stopCount, 0);
  assert.equal(windows[0].rendererGoneListeners.length, 0);

  // A callback from the old window while no session is selected is harmless.
  windows[0].emitRendererProcessGone({ reason: "stale", exitCode: 11 });
  coordinator.reportSelectedConversation(FAKE_COMPUTER_USE_PROJECTION.conversationId);
  await flush();
  assert.equal(windows.length, 2);
  assert.equal(windows[1].showCount, 0, "route return must still wait for a fresh first frame");
  coordinator.reportFrameReady(FAKE_COMPUTER_USE_PROJECTION.sessionId);
  assert.equal(windows[1].showCount, 1);
  await coordinator.dispose();
});

test("auto-show preference can be disabled and explicit Show still overrides it", async () => {
  const preferences = new MemoryPreferenceStore();
  const windows = [];
  const coordinator = createCoordinator({
    client: new CountingProjectionClient(FAKE_COMPUTER_USE_PROJECTION),
    adapter: new FakeComputerUsePreviewPlatformAdapter(),
    preferences,
    windows,
  });
  await coordinator.start();
  const disabled = await coordinator.setAutoShow(false);
  assert.deepEqual(disabled, { accepted: true });
  assert.deepEqual(coordinator.getPreferences(), { previewAutoShow: false });
  coordinator.reportSelectedConversation(FAKE_COMPUTER_USE_PROJECTION.conversationId);
  await flush();
  assert.equal(windows.length, 0, "disabling auto-show must not create a preview for a new selection");

  const shown = await coordinator.show(FAKE_COMPUTER_USE_PROJECTION.sessionId);
  assert.deepEqual(shown, { accepted: true });
  await flush();
  assert.equal(windows.length, 1, "explicit Show must override the global auto-show preference");
  assert.equal(coordinator.getRendererSnapshot().visibilityIntent, "shown");
  await coordinator.dispose();
});

test("disabling auto-show does not hide a preview that is already visible", async () => {
  const windows = [];
  const coordinator = createCoordinator({
    client: new CountingProjectionClient(FAKE_COMPUTER_USE_PROJECTION),
    adapter: new FakeComputerUsePreviewPlatformAdapter(),
    preferences: new MemoryPreferenceStore(),
    windows,
  });
  await coordinator.start();
  coordinator.reportSelectedConversation(FAKE_COMPUTER_USE_PROJECTION.conversationId);
  await flush();
  coordinator.reportFrameReady(FAKE_COMPUTER_USE_PROJECTION.sessionId, 1);
  assert.equal(windows[0].isVisible(), true);

  assert.deepEqual(await coordinator.setAutoShow(false), { accepted: true });
  assert.equal(windows[0].isVisible(), true);
  assert.equal(coordinator.getSummary().visible, true);
  await coordinator.dispose();
});

test("disabling auto-show while connecting releases the hidden source and rejects a late first frame", async () => {
  const windows = [];
  const adapter = new FakeComputerUsePreviewPlatformAdapter();
  const coordinator = createCoordinator({
    client: new CountingProjectionClient(FAKE_COMPUTER_USE_PROJECTION),
    adapter,
    preferences: new MemoryPreferenceStore(),
    windows,
  });
  await coordinator.start();
  coordinator.reportSelectedConversation(FAKE_COMPUTER_USE_PROJECTION.conversationId);
  await flush();
  assert.equal(coordinator.getRendererSnapshot().sourceStatus, "connecting");
  assert.equal(windows[0].isVisible(), false);

  assert.deepEqual(await coordinator.setAutoShow(false), { accepted: true });
  assert.equal(adapter.releaseCount, 1);
  assert.equal(coordinator.getRendererSnapshot().sourceStatus, "idle");
  assert.equal(coordinator.getSummary().visible, false);

  coordinator.reportFrameReady(FAKE_COMPUTER_USE_PROJECTION.sessionId, 1);
  assert.equal(windows[0].showCount, 0, "a late frame cannot bypass the updated auto-show policy");
  assert.equal(coordinator.getRendererSnapshot().sourceStatus, "idle");
  await coordinator.dispose();
});

test("Hide hides and releases media before rejected preference persistence", async () => {
  const windows = [];
  const adapter = new DisplayMediaFakeAdapter();
  const coordinator = createCoordinator({
    client: new CountingProjectionClient(FAKE_COMPUTER_USE_PROJECTION),
    adapter,
    preferences: new RejectingPreferenceStore(),
    windows,
  });
  await coordinator.start();
  coordinator.reportSelectedConversation(FAKE_COMPUTER_USE_PROJECTION.conversationId);
  await flush();
  coordinator.reportFrameReady(FAKE_COMPUTER_USE_PROJECTION.sessionId, 1);

  const result = await coordinator.hide(FAKE_COMPUTER_USE_PROJECTION.sessionId);

  assert.deepEqual(result, { accepted: true, reason: "desktop_preferences_not_persisted" });
  assert.equal(windows[0].hideCount, 1);
  assert.equal(adapter.releaseCount, 1);
  assert.equal(coordinator.getSummary()?.visible, false);
  await coordinator.dispose();
});

test("Close destroys and releases media while preference persistence is pending", async () => {
  const windows = [];
  const adapter = new DisplayMediaFakeAdapter();
  const preferences = new DeferredPreferenceStore();
  const coordinator = createCoordinator({
    client: new CountingProjectionClient(FAKE_COMPUTER_USE_PROJECTION),
    adapter,
    preferences,
    windows,
  });
  await coordinator.start();
  coordinator.reportSelectedConversation(FAKE_COMPUTER_USE_PROJECTION.conversationId);
  await flush();
  coordinator.reportFrameReady(FAKE_COMPUTER_USE_PROJECTION.sessionId, 1);

  const closing = coordinator.close(FAKE_COMPUTER_USE_PROJECTION.sessionId);
  await preferences.saveStarted.promise;
  assert.equal(windows[0].destroyCount, 1);
  assert.equal(adapter.releaseCount, 1);
  assert.equal(coordinator.getSummary(), undefined);

  preferences.allowSave.resolve();
  assert.deepEqual(await closing, { accepted: true });
  await coordinator.dispose();
});

test("disabling auto-show releases a hidden connecting source before preference persistence settles", async () => {
  const windows = [];
  const adapter = new DisplayMediaFakeAdapter();
  const preferences = new DeferredPreferenceStore();
  const coordinator = createCoordinator({
    client: new CountingProjectionClient(FAKE_COMPUTER_USE_PROJECTION),
    adapter,
    preferences,
    windows,
  });
  await coordinator.start();
  coordinator.reportSelectedConversation(FAKE_COMPUTER_USE_PROJECTION.conversationId);
  await flush();
  assert.equal(coordinator.getRendererSnapshot().sourceStatus, "connecting");

  const disabling = coordinator.setAutoShow(false);
  await preferences.saveStarted.promise;
  assert.equal(adapter.releaseCount, 1);
  assert.equal(coordinator.getRendererSnapshot().sourceStatus, "idle");
  assert.equal(windows[0].showCount, 0);

  preferences.allowSave.resolve();
  assert.deepEqual(await disabling, { accepted: true });
  await coordinator.dispose();
});

test("terminal projection eagerly prunes hidden suppression and explicit visibility state", async () => {
  const preferences = new MemoryPreferenceStore();
  const client = new CountingProjectionClient(FAKE_COMPUTER_USE_PROJECTION);
  const windows = [];
  const coordinator = createCoordinator({
    client,
    adapter: new FakeComputerUsePreviewPlatformAdapter(),
    preferences,
    windows,
  });
  await coordinator.start();
  coordinator.reportSelectedConversation(FAKE_COMPUTER_USE_PROJECTION.conversationId);
  await flush();
  await coordinator.hide(FAKE_COMPUTER_USE_PROJECTION.sessionId);
  assert.ok(preferences.value.hiddenSessionSuppressions[FAKE_COMPUTER_USE_PROJECTION.sessionId]);

  client.emit({
    ...FAKE_COMPUTER_USE_PROJECTION,
    status: "succeeded",
    updatedAt: "2026-07-15T00:00:03.000Z",
    terminalAt: "2026-07-15T00:00:03.000Z",
  });
  await flush();

  assert.equal(
    preferences.value.hiddenSessionSuppressions[FAKE_COMPUTER_USE_PROJECTION.sessionId],
    undefined,
  );
  assert.equal(coordinator.getRendererSnapshot().visibilityIntent, "auto");
  assert.equal(windows[0].showCount, 0, "terminal cleanup must not reveal a user-hidden preview");
  assert.equal(coordinator.getSummary().visible, false);
  await coordinator.dispose();
});

test("startup prunes persisted suppression for an already-terminal session", async () => {
  const preferences = new MemoryPreferenceStore();
  preferences.value.hiddenSessionSuppressions = {
    [FAKE_COMPUTER_USE_PROJECTION.sessionId]: "2026-07-16T12:00:00.000Z",
  };
  const terminalProjection = {
    ...FAKE_COMPUTER_USE_PROJECTION,
    status: "succeeded",
    updatedAt: "2026-07-15T00:00:03.000Z",
    terminalAt: "2026-07-15T00:00:03.000Z",
  };
  const coordinator = createCoordinator({
    client: new CountingProjectionClient(terminalProjection),
    adapter: new FakeComputerUsePreviewPlatformAdapter(),
    preferences,
    windows: [],
  });

  await coordinator.start();
  assert.equal(
    preferences.value.hiddenSessionSuppressions[FAKE_COMPUTER_USE_PROJECTION.sessionId],
    undefined,
  );
  await coordinator.dispose();
});

test("Stop closes only after acknowledgement and terminal linger", async () => {
  const timers = [];
  const windows = [];
  const client = new CountingProjectionClient(FAKE_COMPUTER_USE_PROJECTION);
  const coordinator = createCoordinator({
    client,
    adapter: new FakeComputerUsePreviewPlatformAdapter(),
    preferences: new MemoryPreferenceStore(),
    windows,
    setTimer: (callback, milliseconds) => {
      const timer = { callback, milliseconds, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      timer.cleared = true;
    },
  });
  await coordinator.start();
  coordinator.reportSelectedConversation(FAKE_COMPUTER_USE_PROJECTION.conversationId);
  await flush();
  coordinator.reportFrameReady(FAKE_COMPUTER_USE_PROJECTION.sessionId);

  const result = await coordinator.stop(FAKE_COMPUTER_USE_PROJECTION.sessionId);
  await flush();
  assert.equal(result.accepted, true);
  assert.equal(client.stopCount, 1);
  assert.equal(windows[0].destroyCount, 0);
  const terminalTimer = timers.find((timer) => timer.milliseconds === 300 && !timer.cleared);
  assert.ok(terminalTimer, "cancel acknowledgement must schedule the 300ms terminal linger");
  terminalTimer.fired = true;
  terminalTimer.callback();
  await flush();
  assert.equal(windows[0].destroyCount, 1);
  await coordinator.dispose();
});

test("Stop remains retryable when the runtime accepts the request without acknowledging it", async () => {
  const windows = [];
  const client = new UnacknowledgedStopProjectionClient(FAKE_COMPUTER_USE_PROJECTION);
  const coordinator = createCoordinator({
    client,
    adapter: new FakeComputerUsePreviewPlatformAdapter(),
    preferences: new MemoryPreferenceStore(),
    windows,
  });
  await coordinator.start();
  coordinator.reportSelectedConversation(FAKE_COMPUTER_USE_PROJECTION.conversationId);
  await flush();
  coordinator.reportFrameReady(FAKE_COMPUTER_USE_PROJECTION.sessionId);

  const result = await coordinator.stop(FAKE_COMPUTER_USE_PROJECTION.sessionId);
  await flush();
  assert.deepEqual(result, { accepted: false, reason: "computer_use_stop_ack_timeout" });
  assert.equal(client.stopCount, 1);
  assert.equal(windows[0].destroyCount, 0, "an unacknowledged Stop must leave the preview recoverable");
  assert.equal(coordinator.getSummary()?.status, "running");
  await coordinator.dispose();
});

test("starting and approval projections remain visible in the Desktop summary before a preview descriptor exists", async () => {
  const windows = [];
  const starting = {
    ...FAKE_COMPUTER_USE_PROJECTION,
    status: "starting",
    preview: undefined,
  };
  const client = new FakeComputerUseProjectionClient(starting);
  const coordinator = createCoordinator({
    client,
    adapter: new FakeComputerUsePreviewPlatformAdapter(),
    preferences: new MemoryPreferenceStore(),
    windows,
  });
  await coordinator.start();
  coordinator.reportSelectedConversation(starting.conversationId);
  await flush();

  assert.deepEqual(coordinator.getSummary(), {
    sessionId: starting.sessionId,
    conversationId: starting.conversationId,
    status: "starting",
    targetLabel: starting.target.displayName,
    visible: false,
  });
  assert.equal(windows.length, 0);

  client.emit({
    ...starting,
    status: "waiting_for_approval",
    approvalRequired: {
      approvalId: "approval_without_preview",
      summary: "Allow Computer Use",
    },
    updatedAt: "2026-07-15T00:00:02.000Z",
  });
  await flush();
  assert.equal(coordinator.getSummary()?.status, "waiting_for_approval");
  assert.equal(windows.length, 0, "runtime status is shown in shared UI without opening an empty PiP");
  await coordinator.dispose();
});

test("route change during terminal linger destroys the old preview immediately", async () => {
  const timers = [];
  const windows = [];
  const client = new CountingProjectionClient(FAKE_COMPUTER_USE_PROJECTION);
  const coordinator = createCoordinator({
    client,
    adapter: new FakeComputerUsePreviewPlatformAdapter(),
    preferences: new MemoryPreferenceStore(),
    windows,
    setTimer: (callback, milliseconds) => {
      const timer = { callback, milliseconds, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      timer.cleared = true;
    },
  });
  await coordinator.start();
  coordinator.reportSelectedConversation(FAKE_COMPUTER_USE_PROJECTION.conversationId);
  await flush();
  coordinator.reportFrameReady(FAKE_COMPUTER_USE_PROJECTION.sessionId, 1);
  client.emit({
    ...FAKE_COMPUTER_USE_PROJECTION,
    status: "succeeded",
    updatedAt: "2026-07-15T00:00:03.000Z",
    terminalAt: "2026-07-15T00:00:03.000Z",
  });
  await flush();
  assert.ok(timers.some((timer) => timer.milliseconds === 1_500 && !timer.cleared));

  coordinator.reportSelectedConversation("conversation_other");
  await flush();
  assert.equal(windows[0].destroyCount, 1);
  assert.equal(coordinator.getSummary(), undefined);
  await coordinator.dispose();
});

test("a newer active session preempts an older terminal linger immediately", async () => {
  const timers = [];
  const windows = [];
  const client = new CountingProjectionClient(FAKE_COMPUTER_USE_PROJECTION);
  const coordinator = createCoordinator({
    client,
    adapter: new FakeComputerUsePreviewPlatformAdapter(),
    preferences: new MemoryPreferenceStore(),
    windows,
    setTimer: (callback, milliseconds) => {
      const timer = { callback, milliseconds, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      timer.cleared = true;
    },
  });
  await coordinator.start();
  coordinator.reportSelectedConversation(FAKE_COMPUTER_USE_PROJECTION.conversationId);
  await flush();
  coordinator.reportFrameReady(FAKE_COMPUTER_USE_PROJECTION.sessionId, 1);

  client.emit({
    ...FAKE_COMPUTER_USE_PROJECTION,
    status: "failed",
    updatedAt: "2026-07-15T00:00:03.000Z",
    terminalAt: "2026-07-15T00:00:03.000Z",
  });
  await flush();
  const terminalTimer = timers.find((timer) => timer.milliseconds === 5_000 && !timer.cleared);
  assert.ok(terminalTimer);

  const replacement = activeReplacementProjection("computer-use-session-newer", "2026-07-15T00:00:04.000Z");
  client.emit(replacement);
  await flush();

  assert.equal(terminalTimer.cleared, true);
  assert.equal(windows[0].destroyCount, 1);
  assert.equal(windows.length, 2);
  assert.equal(coordinator.getSummary()?.sessionId, replacement.sessionId);
  await coordinator.dispose();
});

test("an older active projection does not preempt a newer terminal surface", async () => {
  const windows = [];
  const client = new CountingProjectionClient(FAKE_COMPUTER_USE_PROJECTION);
  const coordinator = createCoordinator({
    client,
    adapter: new FakeComputerUsePreviewPlatformAdapter(),
    preferences: new MemoryPreferenceStore(),
    windows,
  });
  await coordinator.start();
  coordinator.reportSelectedConversation(FAKE_COMPUTER_USE_PROJECTION.conversationId);
  await flush();
  coordinator.reportFrameReady(FAKE_COMPUTER_USE_PROJECTION.sessionId, 1);
  client.emit({
    ...FAKE_COMPUTER_USE_PROJECTION,
    status: "failed",
    updatedAt: "2026-07-15T00:00:03.000Z",
    terminalAt: "2026-07-15T00:00:03.000Z",
  });
  await flush();

  client.emit(activeReplacementProjection("computer-use-session-older", "2026-07-15T00:00:02.000Z"));
  await flush();

  assert.equal(windows.length, 1);
  assert.equal(coordinator.getSummary()?.sessionId, FAKE_COMPUTER_USE_PROJECTION.sessionId);
  assert.equal(coordinator.getSummary()?.status, "failed");
  await coordinator.dispose();
});

test("terminal linger queued behind a newer active projection cannot destroy its replacement window", async () => {
  const timers = [];
  const windows = [];
  const adapter = new DeferredDisplayMediaReleaseAdapter();
  const client = new CountingProjectionClient(FAKE_COMPUTER_USE_PROJECTION);
  const coordinator = createCoordinator({
    client,
    adapter,
    preferences: new MemoryPreferenceStore(),
    windows,
    setTimer: (callback, milliseconds) => {
      const timer = { callback, milliseconds, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      timer.cleared = true;
    },
  });
  await coordinator.start();
  coordinator.reportSelectedConversation(FAKE_COMPUTER_USE_PROJECTION.conversationId);
  await flush();
  coordinator.reportFrameReady(FAKE_COMPUTER_USE_PROJECTION.sessionId, 1);
  client.emit({
    ...FAKE_COMPUTER_USE_PROJECTION,
    status: "cancelled",
    updatedAt: "2026-07-15T00:00:03.000Z",
    terminalAt: "2026-07-15T00:00:03.000Z",
  });
  await flush();
  const terminalTimer = timers.find((timer) => timer.milliseconds === 300 && !timer.cleared);
  assert.ok(terminalTimer);

  terminalTimer.callback();
  await adapter.releaseStarted.promise;
  const replacement = activeReplacementProjection("computer-use-session-after-linger", "2026-07-15T00:00:04.000Z");
  client.emit(replacement);
  adapter.allowRelease.resolve();
  await flush();
  await flush();

  assert.equal(windows[0].destroyCount, 1);
  assert.equal(windows.length, 2);
  assert.equal(windows[1].destroyCount, 0);
  assert.equal(coordinator.getSummary()?.sessionId, replacement.sessionId);
  await coordinator.dispose();
});

test("terminal projection cancels a pending missing-first-frame retry before closing the preview", async () => {
  const timers = [];
  const windows = [];
  const client = new CountingProjectionClient(FAKE_COMPUTER_USE_PROJECTION);
  const adapter = new DisplayMediaFakeAdapter();
  const coordinator = createCoordinator({
    client,
    adapter,
    preferences: new MemoryPreferenceStore(),
    windows,
    setTimer: (callback, milliseconds) => {
      const timer = { callback, milliseconds, cleared: false, fired: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      timer.cleared = true;
    },
  });
  await coordinator.start();
  coordinator.reportSelectedConversation(FAKE_COMPUTER_USE_PROJECTION.conversationId);
  await flush();

  const firstFrameWatchdog = timers.find((timer) => timer.milliseconds === 1_000 && !timer.cleared);
  assert.ok(firstFrameWatchdog);
  firstFrameWatchdog.fired = true;
  firstFrameWatchdog.callback();
  await flush();

  const retryTimer = timers.find((timer) => timer.milliseconds === 250 && !timer.fired);
  const deadlineTimer = timers.find((timer) => timer.milliseconds === 10_000 && !timer.fired);
  assert.ok(retryTimer, "missing first frame should have a pending reconnect");
  assert.ok(deadlineTimer, "missing first frame should have a hard recovery deadline");
  client.emit({
    ...FAKE_COMPUTER_USE_PROJECTION,
    status: "cancelled",
    updatedAt: "2026-07-15T00:00:02.000Z",
    terminalAt: "2026-07-15T00:00:02.000Z",
  });
  await flush();

  assert.equal(retryTimer.cleared, true, "terminal state must cancel the stale reconnect timer");
  assert.equal(deadlineTimer.cleared, true, "terminal state must cancel the stale recovery deadline");
  const terminalTimer = timers.find((timer) => timer.milliseconds === 300 && !timer.cleared);
  assert.ok(terminalTimer, "cancelled sessions keep the documented terminal linger");
  const prepareCount = adapter.prepareCount;
  retryTimer.fired = true;
  retryTimer.callback();
  deadlineTimer.fired = true;
  deadlineTimer.callback();
  await flush();
  assert.equal(adapter.prepareCount, prepareCount, "stale recovery callbacks must not reopen terminal media");

  terminalTimer.fired = true;
  terminalTimer.callback();
  await flush();
  assert.equal(windows[0].destroyCount, 1);
  await coordinator.dispose();
});

test("stall timeout releases media, hides the preview, and clears retry state", async () => {
  let nowMs = Date.parse("2026-07-15T12:00:00.000Z");
  const timers = [];
  const windows = [];
  const adapter = new FakeComputerUsePreviewPlatformAdapter();
  const coordinator = createCoordinator({
    client: new CountingProjectionClient(FAKE_COMPUTER_USE_PROJECTION),
    adapter,
    preferences: new MemoryPreferenceStore(),
    windows,
    now: () => new Date(nowMs),
    setTimer: (callback, milliseconds) => {
      const timer = { callback, milliseconds, cleared: false, fired: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      timer.cleared = true;
    },
  });
  await coordinator.start();
  coordinator.reportSelectedConversation(FAKE_COMPUTER_USE_PROJECTION.conversationId);
  await flush();
  coordinator.reportFrameReady(FAKE_COMPUTER_USE_PROJECTION.sessionId);

  coordinator.reportSourceEnded(FAKE_COMPUTER_USE_PROJECTION.sessionId, "capture_track_ended");
  await flush();
  const retryTimer = timers.find((timer) => timer.milliseconds === 250 && !timer.fired);
  assert.ok(retryTimer, "a stalled source should schedule a bounded retry");
  retryTimer.fired = true;
  retryTimer.callback();
  await flush();

  nowMs += 10_001;
  coordinator.reportSourceEnded(FAKE_COMPUTER_USE_PROJECTION.sessionId, "capture_track_ended");
  await flush();

  assert.equal(adapter.releaseCount, 2, "retry and timeout must both release the media handle");
  assert.equal(windows[0].hideCount, 1, "a timed-out stall must hide the preview");
  assert.equal(coordinator.getRendererSnapshot().sourceStatus, "idle");
  assert.equal(coordinator.getRendererSnapshot().frameReady, false);
  assert.equal(
    timers.filter((timer) => !timer.cleared && !timer.fired).length,
    0,
    "timeout must not leave a future retry scheduled",
  );
  await coordinator.dispose();
});

test("display-media frame activity resets a one-second watchdog and a gap enters reconnect", async () => {
  const timers = [];
  const windows = [];
  const client = new CountingProjectionClient(FAKE_COMPUTER_USE_PROJECTION);
  const coordinator = createCoordinator({
    client,
    adapter: new DisplayMediaFakeAdapter(),
    preferences: new MemoryPreferenceStore(),
    windows,
    setTimer: (callback, milliseconds) => {
      const timer = { callback, milliseconds, cleared: false, fired: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      timer.cleared = true;
    },
  });
  await coordinator.start();
  coordinator.reportSelectedConversation(FAKE_COMPUTER_USE_PROJECTION.conversationId);
  await flush();
  coordinator.reportFrameReady(FAKE_COMPUTER_USE_PROJECTION.sessionId, 1);

  coordinator.reportFrameActivity(FAKE_COMPUTER_USE_PROJECTION.sessionId, 99);
  assert.equal(
    timers.some((timer) => timer.milliseconds === 1_000 && !timer.cleared),
    false,
    "stale activity must not leave a watchdog armed",
  );

  coordinator.reportFrameActivity(FAKE_COMPUTER_USE_PROJECTION.sessionId, 1);
  const firstWatchdog = timers.find((timer) => timer.milliseconds === 1_000 && !timer.cleared);
  assert.ok(firstWatchdog);
  coordinator.reportFrameActivity(FAKE_COMPUTER_USE_PROJECTION.sessionId, 1);
  const secondWatchdog = [...timers].reverse().find((timer) => timer.milliseconds === 1_000 && !timer.cleared);
  assert.equal(firstWatchdog.cleared, true);
  assert.notEqual(secondWatchdog, firstWatchdog);

  secondWatchdog.fired = true;
  secondWatchdog.callback();
  await flush();

  assert.equal(coordinator.getRendererSnapshot().sourceStatus, "stalled");
  assert.equal(windows[0].isVisible(), true, "a frame-gap recovery keeps the presented surface visible");
  assert.equal(coordinator.getSummary().visible, true);
  assert.equal(client.stopCount, 0, "a frame gap must not stop the runtime");
  assert.ok(timers.some((timer) => timer.milliseconds === 250 && !timer.cleared));
  await coordinator.dispose();
});

test("a missing first display-media frame enters bounded reconnect without stopping the runtime", async () => {
  const timers = [];
  const windows = [];
  const client = new CountingProjectionClient(FAKE_COMPUTER_USE_PROJECTION);
  const adapter = new DisplayMediaFakeAdapter();
  const coordinator = createCoordinator({
    client,
    adapter,
    preferences: new MemoryPreferenceStore(),
    windows,
    setTimer: (callback, milliseconds) => {
      const timer = { callback, milliseconds, cleared: false, fired: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      timer.cleared = true;
    },
  });
  await coordinator.start();
  coordinator.reportSelectedConversation(FAKE_COMPUTER_USE_PROJECTION.conversationId);
  await flush();

  const firstFrameWatchdog = timers.find((timer) => timer.milliseconds === 1_000 && !timer.cleared);
  assert.ok(firstFrameWatchdog, "display media must not stay connecting forever without a frame");
  firstFrameWatchdog.fired = true;
  firstFrameWatchdog.callback();
  await flush();

  assert.equal(coordinator.getRendererSnapshot().sourceStatus, "stalled");
  assert.equal(coordinator.getRendererSnapshot().frameReady, false);
  assert.equal(windows[0].showCount, 0, "missing-first-frame recovery must not reveal an empty surface");
  assert.equal(coordinator.getSummary().visible, false);
  assert.equal(client.stopCount, 0, "a missing first frame must not stop the runtime");
  const retryTimer = timers.find((timer) => timer.milliseconds === 250 && !timer.cleared);
  const deadlineTimer = timers.find((timer) => timer.milliseconds === 10_000 && !timer.cleared);
  assert.ok(retryTimer);
  assert.ok(deadlineTimer);
  const prepareCount = adapter.prepareCount;
  await coordinator.hide(FAKE_COMPUTER_USE_PROJECTION.sessionId);
  assert.equal(retryTimer.cleared, true);
  assert.equal(deadlineTimer.cleared, true);
  retryTimer.fired = true;
  retryTimer.callback();
  deadlineTimer.fired = true;
  deadlineTimer.callback();
  await flush();
  assert.equal(adapter.prepareCount, prepareCount, "Hide must invalidate retained recovery callbacks");
  assert.equal(client.stopCount, 0, "Hide during first-frame recovery must not stop the runtime");
  await coordinator.dispose();
});

test("a missing first frame exhausts bounded retries and hides by the ten-second recovery deadline", async () => {
  const clock = createVirtualTimerHarness("2026-07-15T12:00:00.000Z");
  const windows = [];
  const client = new CountingProjectionClient(FAKE_COMPUTER_USE_PROJECTION);
  const adapter = new DisplayMediaFakeAdapter();
  const coordinator = createCoordinator({
    client,
    adapter,
    preferences: new MemoryPreferenceStore(),
    windows,
    now: () => new Date(clock.nowMs),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  await coordinator.start();
  coordinator.reportSelectedConversation(FAKE_COMPUTER_USE_PROJECTION.conversationId);
  await flush();

  const initialWatchdog = await clock.fireNext();
  assert.equal(initialWatchdog.milliseconds, 1_000, "initial capture gets one second to deliver a frame");
  const stalledAtMs = clock.nowMs;
  assert.equal(coordinator.getRendererSnapshot().sourceStatus, "stalled");
  assert.ok(clock.activeTimer(10_000), "stall recovery must arm an absolute ten-second deadline");

  const firedDelays = [initialWatchdog.milliseconds];
  let safety = 0;
  while (windows[0].hideCount === 0 && safety < 20) {
    firedDelays.push((await clock.fireNext()).milliseconds);
    safety += 1;
  }

  assert.deepEqual(
    firedDelays,
    [1_000, 250, 1_000, 500, 1_000, 1_000, 1_000, 2_000, 1_000, 2_000, 10_000],
    "each reconnect gets a fresh one-second first-frame gate while backoff remains bounded",
  );
  assert.equal(windows[0].hideCount, 1, "deadline exhaustion must hide the empty preview");
  assert.equal(clock.nowMs - stalledAtMs, 10_000, "retries must not extend recovery past ten seconds");
  assert.equal(adapter.prepareCount, 6, "the bounded backoff permits only five reconnect prepares");
  assert.equal(adapter.releaseCount, 6, "each retry and final timeout must release its media handle");
  assert.equal(client.stopCount, 0, "capture exhaustion must never stop the Computer Use runtime");
  assert.equal(coordinator.getRendererSnapshot().sourceStatus, "idle");
  assert.equal(coordinator.getRendererSnapshot().frameReady, false);
  assert.equal(coordinator.getSummary().status, "running");
  assert.equal(clock.activeTimers().length, 0, "timeout cleanup must leave no retry or watchdog behind");
  await coordinator.dispose();
});

test("ordinary projection updates cannot reopen a source after the ten-second recovery deadline", async () => {
  const clock = createVirtualTimerHarness("2026-07-15T12:00:00.000Z");
  const windows = [];
  const client = new CountingProjectionClient(FAKE_COMPUTER_USE_PROJECTION);
  const adapter = new DisplayMediaFakeAdapter();
  const coordinator = createCoordinator({
    client,
    adapter,
    preferences: new MemoryPreferenceStore(),
    windows,
    now: () => new Date(clock.nowMs),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  await coordinator.start();
  coordinator.reportSelectedConversation(FAKE_COMPUTER_USE_PROJECTION.conversationId);
  await flush();

  let safety = 0;
  while (windows[0].hideCount === 0 && safety < 20) {
    await clock.fireNext();
    safety += 1;
  }
  const exhaustedPrepareCount = adapter.prepareCount;
  client.emit({
    ...FAKE_COMPUTER_USE_PROJECTION,
    updatedAt: "2026-07-15T00:00:02.000Z",
  });
  await flush();

  assert.equal(
    adapter.prepareCount,
    exhaustedPrepareCount,
    "an unrelated projection refresh must not reopen capture after timeout",
  );
  assert.equal(clock.activeTimers().length, 0);
  const showCountAfterTimeout = windows[0].showCount;
  coordinator.reportFrameReady(FAKE_COMPUTER_USE_PROJECTION.sessionId, 1);
  coordinator.reportSourceFailure(FAKE_COMPUTER_USE_PROJECTION.sessionId, 1, "stale_after_timeout");
  await flush();
  assert.equal(
    windows[0].showCount,
    showCountAfterTimeout,
    "stale renderer callbacks must not reveal a timed-out source",
  );
  assert.equal(coordinator.getRendererSnapshot().sourceStatus, "idle");

  windows[0].emitRendererProcessGone({ reason: "crashed-after-stall-timeout", exitCode: 14 });
  await flush();
  assert.equal(windows[0].destroyCount, 1);
  assert.equal(windows.length, 1, "stall-blocked crash must not auto-recreate the renderer");
  assert.equal(coordinator.getSummary()?.visible, false);

  coordinator.reportSelectedConversation("conversation_other");
  await flush();
  coordinator.reportSelectedConversation(FAKE_COMPUTER_USE_PROJECTION.conversationId);
  await flush();
  assert.equal(
    adapter.prepareCount,
    exhaustedPrepareCount,
    "route leave/return must not clear the exact descriptor timeout block",
  );
  assert.equal(windows.length, 1, "a blocked route return must not create another window");

  assert.deepEqual(await coordinator.show(FAKE_COMPUTER_USE_PROJECTION.sessionId), { accepted: true });
  await flush();
  assert.equal(adapter.prepareCount, exhaustedPrepareCount + 1, "explicit Show clears the timeout block");
  await coordinator.dispose();
});

test("a new descriptor revision reopens capture after the ten-second recovery deadline", async () => {
  const clock = createVirtualTimerHarness("2026-07-15T12:00:00.000Z");
  const windows = [];
  const client = new CountingProjectionClient(FAKE_COMPUTER_USE_PROJECTION);
  const adapter = new DisplayMediaFakeAdapter();
  const coordinator = createCoordinator({
    client,
    adapter,
    preferences: new MemoryPreferenceStore(),
    windows,
    now: () => new Date(clock.nowMs),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  await coordinator.start();
  coordinator.reportSelectedConversation(FAKE_COMPUTER_USE_PROJECTION.conversationId);
  await flush();

  let safety = 0;
  while (windows[0].hideCount === 0 && safety < 20) {
    await clock.fireNext();
    safety += 1;
  }
  const exhaustedPrepareCount = adapter.prepareCount;
  const showCountAfterTimeout = windows[0].showCount;

  client.emit({
    ...FAKE_COMPUTER_USE_PROJECTION,
    preview: {
      ...FAKE_COMPUTER_USE_PROJECTION.preview,
      descriptorId: "preview_fake_session_02",
      revision: 2,
    },
    updatedAt: "2026-07-15T00:00:03.000Z",
  });
  await flush();

  assert.equal(adapter.prepareCount, exhaustedPrepareCount + 1, "new descriptor identity clears the timeout block");
  assert.equal(coordinator.getRendererSnapshot().sourceRevision, 2);
  assert.equal(coordinator.getRendererSnapshot().sourceStatus, "connecting");
  assert.equal(client.stopCount, 0, "descriptor recovery must not stop the Computer Use runtime");

  coordinator.reportFrameReady(FAKE_COMPUTER_USE_PROJECTION.sessionId, 2);
  assert.equal(windows[0].showCount, showCountAfterTimeout + 1, "revision 2 reveals only after its first valid frame");
  await coordinator.dispose();
});

test("a new descriptor revision never overrides user Hide suppression", async () => {
  const windows = [];
  const adapter = new FakeComputerUsePreviewPlatformAdapter();
  const client = new CountingProjectionClient(FAKE_COMPUTER_USE_PROJECTION);
  const coordinator = createCoordinator({
    client,
    adapter,
    preferences: new MemoryPreferenceStore(),
    windows,
  });
  await coordinator.start();
  coordinator.reportSelectedConversation(FAKE_COMPUTER_USE_PROJECTION.conversationId);
  await flush();
  coordinator.reportFrameReady(FAKE_COMPUTER_USE_PROJECTION.sessionId, 1);
  await coordinator.hide(FAKE_COMPUTER_USE_PROJECTION.sessionId);
  const prepareCount = adapter.prepareCount;
  const showCount = windows[0].showCount;

  client.emit({
    ...FAKE_COMPUTER_USE_PROJECTION,
    preview: {
      ...FAKE_COMPUTER_USE_PROJECTION.preview,
      descriptorId: "preview_fake_session_02",
      revision: 2,
    },
    updatedAt: "2026-07-15T00:00:03.000Z",
  });
  await flush();

  assert.equal(adapter.prepareCount, prepareCount);
  assert.equal(coordinator.getRendererSnapshot().sourceRevision, 2);
  assert.equal(coordinator.getRendererSnapshot().visibilityIntent, "hidden");
  coordinator.reportFrameReady(FAKE_COMPUTER_USE_PROJECTION.sessionId, 2);
  assert.equal(windows[0].showCount, showCount);

  assert.deepEqual(await coordinator.show(FAKE_COMPUTER_USE_PROJECTION.sessionId), { accepted: true });
  await flush();
  assert.equal(adapter.prepareCount, prepareCount + 1);
  coordinator.reportFrameReady(FAKE_COMPUTER_USE_PROJECTION.sessionId, 2);
  assert.equal(windows[0].showCount, showCount + 1);
  await coordinator.dispose();
});

test("a changed descriptor id rebinds the source even when its revision number is unchanged", async () => {
  const windows = [];
  const prepareInputs = [];
  const adapter = new FakeComputerUsePreviewPlatformAdapter();
  adapter.prepare = async (input) => {
    adapter.prepareCount += 1;
    prepareInputs.push(input);
    return { sourceKind: "fake", aspectRatio: 1.6 };
  };
  const client = new CountingProjectionClient(FAKE_COMPUTER_USE_PROJECTION);
  const coordinator = createCoordinator({
    client,
    adapter,
    preferences: new MemoryPreferenceStore(),
    windows,
  });
  await coordinator.start();
  coordinator.reportSelectedConversation(FAKE_COMPUTER_USE_PROJECTION.conversationId);
  await flush();
  coordinator.reportFrameReady(FAKE_COMPUTER_USE_PROJECTION.sessionId, 1);

  client.emit({
    ...FAKE_COMPUTER_USE_PROJECTION,
    preview: {
      ...FAKE_COMPUTER_USE_PROJECTION.preview,
      descriptorId: "preview_restarted_daemon_descriptor",
      revision: 1,
    },
    updatedAt: "2026-07-15T00:00:03.000Z",
  });
  await flush();

  assert.equal(adapter.prepareCount, 2);
  assert.equal(adapter.releaseCount, 1);
  assert.deepEqual(prepareInputs.map((input) => input.descriptorId), [
    FAKE_COMPUTER_USE_PROJECTION.preview.descriptorId,
    "preview_restarted_daemon_descriptor",
  ]);
  assert.equal(coordinator.getRendererSnapshot().sourceStatus, "connecting");
  assert.equal(coordinator.getRendererSnapshot().frameReady, false);
  await coordinator.dispose();
});

test("same-revision descriptor replacement rejects every stale source callback while release is pending", async () => {
  const timers = [];
  const windows = [];
  const adapter = new DeferredDisplayMediaReleaseAdapter();
  const client = new CountingProjectionClient(FAKE_COMPUTER_USE_PROJECTION);
  const coordinator = createCoordinator({
    client,
    adapter,
    preferences: new MemoryPreferenceStore(),
    windows,
    setTimer: (callback, milliseconds) => {
      const timer = { callback, milliseconds, cleared: false, fired: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      timer.cleared = true;
    },
  });
  await coordinator.start();
  coordinator.reportSelectedConversation(FAKE_COMPUTER_USE_PROJECTION.conversationId);
  await flush();
  const first = coordinator.getRendererSnapshot();
  assert.equal(first.sourceRevision, 1);
  assert.ok(first.sourceGeneration > 0);

  client.emit({
    ...FAKE_COMPUTER_USE_PROJECTION,
    preview: {
      ...FAKE_COMPUTER_USE_PROJECTION.preview,
      descriptorId: "preview_restarted_daemon_descriptor",
      revision: 1,
    },
    updatedAt: "2026-07-15T00:00:03.000Z",
  });
  await adapter.releaseStarted.promise;

  coordinator.reportFrameReady(first.sessionId, first.sourceRevision, first.sourceGeneration);
  coordinator.reportFrameActivity(first.sessionId, first.sourceRevision, first.sourceGeneration);
  coordinator.reportSourceEnded(first.sessionId, first.sourceRevision, first.sourceGeneration, "stale_end");
  coordinator.reportSourceFailure(first.sessionId, first.sourceRevision, first.sourceGeneration, "stale_failure");
  assert.equal(coordinator.getRendererSnapshot().frameReady, false);
  assert.equal(coordinator.getRendererSnapshot().sourceStatus, "connecting");
  assert.equal(
    timers.some((timer) => !timer.cleared && timer.milliseconds === 250),
    false,
    "stale callbacks must not schedule reconnect while exact-source release is pending",
  );

  adapter.allowRelease.resolve();
  await flush();
  const replacement = coordinator.getRendererSnapshot();
  assert.equal(replacement.sourceRevision, first.sourceRevision);
  assert.ok(replacement.sourceGeneration > first.sourceGeneration);
  assert.equal("descriptorId" in replacement, false, "opaque daemon descriptors stay in Desktop main");
  assert.equal(replacement.frameReady, false);

  coordinator.reportFrameReady(
    replacement.sessionId,
    replacement.sourceRevision,
    replacement.sourceGeneration,
  );
  coordinator.reportFrameActivity(
    replacement.sessionId,
    replacement.sourceRevision,
    replacement.sourceGeneration,
  );
  const currentActivityWatchdog = [...timers].reverse().find((timer) =>
    !timer.cleared && timer.milliseconds === 1_000
  );
  assert.ok(currentActivityWatchdog);

  coordinator.reportFrameActivity(first.sessionId, first.sourceRevision, first.sourceGeneration);
  coordinator.reportSourceEnded(first.sessionId, first.sourceRevision, first.sourceGeneration, "stale_end_after_rebind");
  coordinator.reportSourceFailure(first.sessionId, first.sourceRevision, first.sourceGeneration, "stale_failure_after_rebind");
  assert.equal(currentActivityWatchdog.cleared, false, "stale activity must not replace the current watchdog");
  assert.equal(coordinator.getRendererSnapshot().sourceStatus, "live");
  assert.equal(coordinator.getRendererSnapshot().frameReady, true);
  assert.equal(client.stopCount, 0);
  await coordinator.dispose();
});

test("a new descriptor revision invalidates retained missing-first-frame recovery callbacks", async () => {
  const timers = [];
  const windows = [];
  const adapter = new DisplayMediaFakeAdapter();
  const client = new CountingProjectionClient(FAKE_COMPUTER_USE_PROJECTION);
  const coordinator = createCoordinator({
    client,
    adapter,
    preferences: new MemoryPreferenceStore(),
    windows,
    setTimer: (callback, milliseconds) => {
      const timer = { callback, milliseconds, cleared: false, fired: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      timer.cleared = true;
    },
  });
  await coordinator.start();
  coordinator.reportSelectedConversation(FAKE_COMPUTER_USE_PROJECTION.conversationId);
  await flush();

  const firstFrameWatchdog = timers.find((timer) => timer.milliseconds === 1_000 && !timer.cleared);
  assert.ok(firstFrameWatchdog);
  firstFrameWatchdog.fired = true;
  firstFrameWatchdog.callback();
  await flush();
  const staleRetry = timers.find((timer) => timer.milliseconds === 250 && !timer.cleared);
  const staleDeadline = timers.find((timer) => timer.milliseconds === 10_000 && !timer.cleared);
  assert.ok(staleRetry);
  assert.ok(staleDeadline);

  client.emit({
    ...FAKE_COMPUTER_USE_PROJECTION,
    preview: { ...FAKE_COMPUTER_USE_PROJECTION.preview, descriptorId: "preview_fake_session_02", revision: 2 },
    updatedAt: "2026-07-15T00:00:03.000Z",
  });
  await flush();
  assert.equal(staleRetry.cleared, true);
  assert.equal(staleDeadline.cleared, true);
  assert.equal(coordinator.getRendererSnapshot().sourceRevision, 2);
  const prepareCount = adapter.prepareCount;

  staleRetry.fired = true;
  staleRetry.callback();
  staleDeadline.fired = true;
  staleDeadline.callback();
  await flush();

  assert.equal(adapter.prepareCount, prepareCount, "revision 1 retry must not reopen revision 2 capture");
  assert.equal(coordinator.getRendererSnapshot().sourceRevision, 2);
  assert.equal(coordinator.getRendererSnapshot().sourceStatus, "connecting");
  assert.equal(client.stopCount, 0);
  await coordinator.dispose();
});

test("Hide cancels a pending stall retry without stopping the runtime", async () => {
  const timers = [];
  const windows = [];
  const client = new CountingProjectionClient(FAKE_COMPUTER_USE_PROJECTION);
  const adapter = new FakeComputerUsePreviewPlatformAdapter();
  const coordinator = createCoordinator({
    client,
    adapter,
    preferences: new MemoryPreferenceStore(),
    windows,
    setTimer: (callback, milliseconds) => {
      const timer = { callback, milliseconds, cleared: false, fired: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      timer.cleared = true;
    },
  });
  await coordinator.start();
  coordinator.reportSelectedConversation(FAKE_COMPUTER_USE_PROJECTION.conversationId);
  await flush();
  coordinator.reportFrameReady(FAKE_COMPUTER_USE_PROJECTION.sessionId);
  coordinator.reportSourceEnded(FAKE_COMPUTER_USE_PROJECTION.sessionId, "capture_track_ended");
  await flush();

  const retryTimer = timers.find((timer) => timer.milliseconds === 250 && !timer.fired);
  assert.ok(retryTimer);
  await coordinator.hide(FAKE_COMPUTER_USE_PROJECTION.sessionId);
  assert.equal(retryTimer.cleared, true);
  assert.equal(adapter.releaseCount, 1);
  assert.equal(client.stopCount, 0, "Hide must not stop the underlying runtime");
  await coordinator.dispose();
});

test("Hide clears a reconnect timer before waiting for preference persistence", async () => {
  const timers = [];
  const windows = [];
  const adapter = new FakeComputerUsePreviewPlatformAdapter();
  const preferences = new MemoryPreferenceStore();
  const saveStarted = deferred();
  const allowSave = deferred();
  preferences.save = async (value) => {
    preferences.saveCalls += 1;
    preferences.value = structuredClone(value);
    saveStarted.resolve();
    await allowSave.promise;
  };
  const coordinator = createCoordinator({
    client: new CountingProjectionClient(FAKE_COMPUTER_USE_PROJECTION),
    adapter,
    preferences,
    windows,
    setTimer: (callback, milliseconds) => {
      const timer = { callback, milliseconds, cleared: false, fired: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      timer.cleared = true;
    },
  });
  await coordinator.start();
  coordinator.reportSelectedConversation(FAKE_COMPUTER_USE_PROJECTION.conversationId);
  await flush();
  coordinator.reportFrameReady(FAKE_COMPUTER_USE_PROJECTION.sessionId);
  coordinator.reportSourceEnded(FAKE_COMPUTER_USE_PROJECTION.sessionId, "capture_track_ended");
  await flush();

  const retryTimer = timers.find((timer) => timer.milliseconds === 250 && !timer.fired);
  assert.ok(retryTimer);
  const hidePromise = coordinator.hide(FAKE_COMPUTER_USE_PROJECTION.sessionId);
  await saveStarted.promise;

  assert.equal(retryTimer.cleared, true, "Hide must cancel retry before a slow preference write completes");
  retryTimer.fired = true;
  retryTimer.callback();
  allowSave.resolve();
  await hidePromise;
  await flush();

  assert.equal(adapter.prepareCount, 1, "a fired stale callback must observe the in-memory suppression");
  assert.equal(windows[0].hideCount, 1);
  await coordinator.dispose();
});

test("Hide invalidates a reconnect already waiting on permission", async () => {
  const timers = [];
  const windows = [];
  const adapter = new DeferredReconnectPermissionAdapter();
  const coordinator = createCoordinator({
    client: new CountingProjectionClient(FAKE_COMPUTER_USE_PROJECTION),
    adapter,
    preferences: new MemoryPreferenceStore(),
    windows,
    setTimer: (callback, milliseconds) => {
      const timer = { callback, milliseconds, cleared: false, fired: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      timer.cleared = true;
    },
  });
  await coordinator.start();
  coordinator.reportSelectedConversation(FAKE_COMPUTER_USE_PROJECTION.conversationId);
  await flush();
  coordinator.reportFrameReady(FAKE_COMPUTER_USE_PROJECTION.sessionId);
  coordinator.reportSourceEnded(FAKE_COMPUTER_USE_PROJECTION.sessionId, "capture_track_ended");
  await flush();

  const retryTimer = timers.find((timer) => timer.milliseconds === 250 && !timer.fired);
  assert.ok(retryTimer);
  retryTimer.fired = true;
  retryTimer.callback();
  await adapter.reconnectPermissionStarted.promise;

  const hidePromise = coordinator.hide(FAKE_COMPUTER_USE_PROJECTION.sessionId);
  adapter.allowReconnectPermission.resolve();
  await hidePromise;
  await flush();

  assert.equal(adapter.prepareCount, 1, "the in-flight retry must re-check suppression after permission resolves");
  assert.equal(coordinator.getRendererSnapshot().visibilityIntent, "hidden");
  assert.equal(coordinator.getRendererSnapshot().sourceStatus, "idle");
  const showCountBeforeStaleFrame = windows[0].showCount;
  coordinator.reportFrameReady(FAKE_COMPUTER_USE_PROJECTION.sessionId, 1);
  assert.equal(windows[0].showCount, showCountBeforeStaleFrame, "a stale frame cannot show the preview again after Hide");
  await coordinator.dispose();
});

test("a delayed reconnect prepare cannot overwrite a newer descriptor revision", async () => {
  const timers = [];
  const windows = [];
  const adapter = new DeferredSecondPrepareAdapter();
  const client = new CountingProjectionClient(FAKE_COMPUTER_USE_PROJECTION);
  const coordinator = createCoordinator({
    client,
    adapter,
    preferences: new MemoryPreferenceStore(),
    windows,
    setTimer: (callback, milliseconds) => {
      const timer = { callback, milliseconds, cleared: false, fired: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      timer.cleared = true;
    },
  });
  await coordinator.start();
  coordinator.reportSelectedConversation(FAKE_COMPUTER_USE_PROJECTION.conversationId);
  await flush();
  coordinator.reportFrameReady(FAKE_COMPUTER_USE_PROJECTION.sessionId, 1);
  coordinator.reportSourceEnded(FAKE_COMPUTER_USE_PROJECTION.sessionId, 1, "capture_track_ended");
  await flush();

  const retryTimer = timers.find((timer) => timer.milliseconds === 250 && !timer.fired);
  assert.ok(retryTimer);
  retryTimer.fired = true;
  retryTimer.callback();
  await adapter.secondPrepareStarted.promise;

  client.emit({
    ...FAKE_COMPUTER_USE_PROJECTION,
    preview: { ...FAKE_COMPUTER_USE_PROJECTION.preview, descriptorId: "preview_fake_session_02", revision: 2 },
    updatedAt: "2026-07-15T00:00:03.000Z",
  });
  adapter.allowSecondPrepare.resolve();
  await waitFor(() => adapter.prepareInputs.some((input) => input.revision === 2));
  await flush();

  assert.deepEqual(adapter.prepareInputs.map((input) => input.revision), [1, 1, 2]);
  assert.equal(coordinator.getRendererSnapshot().sourceRevision, 2);
  assert.equal(coordinator.getRendererSnapshot().frameReady, false);
  coordinator.reportFrameReady(FAKE_COMPUTER_USE_PROJECTION.sessionId, 1);
  assert.equal(coordinator.getRendererSnapshot().frameReady, false, "revision 1 completion must remain stale");
  coordinator.reportFrameReady(FAKE_COMPUTER_USE_PROJECTION.sessionId, 2);
  assert.equal(coordinator.getRendererSnapshot().frameReady, true);
  await coordinator.dispose();
});

test("initial permission denial reveals an actionable recovery surface without a frame", async () => {
  const timers = [];
  const windows = [];
  const adapter = new FakeComputerUsePreviewPlatformAdapter();
  adapter.getPermissionState = async () => "denied";
  const coordinator = createCoordinator({
    client: new CountingProjectionClient(FAKE_COMPUTER_USE_PROJECTION),
    adapter,
    preferences: new MemoryPreferenceStore(),
    windows,
    setTimer: (callback, milliseconds) => {
      const timer = { callback, milliseconds, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      timer.cleared = true;
    },
  });
  await coordinator.start();
  coordinator.reportSelectedConversation(FAKE_COMPUTER_USE_PROJECTION.conversationId);
  await flush();

  assert.equal(coordinator.getRendererSnapshot().sourceStatus, "permission_denied");
  assert.equal(coordinator.getRendererSnapshot().frameReady, false);
  assert.equal(windows[0].isVisible(), true);
  assert.equal(coordinator.getSummary().visible, true);
  assert.ok(timers.some((timer) => timer.milliseconds === 5_000 && !timer.cleared));
  await coordinator.dispose();
});

test("initial source preparation failure reveals its bounded recovery surface without a frame", async () => {
  const timers = [];
  const windows = [];
  const adapter = new FakeComputerUsePreviewPlatformAdapter();
  adapter.prepare = async () => {
    throw new Error("capture_prepare_failed");
  };
  const coordinator = createCoordinator({
    client: new CountingProjectionClient(FAKE_COMPUTER_USE_PROJECTION),
    adapter,
    preferences: new MemoryPreferenceStore(),
    windows,
    setTimer: (callback, milliseconds) => {
      const timer = { callback, milliseconds, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      timer.cleared = true;
    },
  });
  await coordinator.start();
  coordinator.reportSelectedConversation(FAKE_COMPUTER_USE_PROJECTION.conversationId);
  await flush();

  assert.equal(coordinator.getRendererSnapshot().sourceStatus, "failed");
  assert.equal(coordinator.getRendererSnapshot().frameReady, false);
  assert.equal(windows[0].isVisible(), true);
  assert.equal(coordinator.getSummary().visible, true);
  assert.ok(timers.some((timer) => timer.milliseconds === 5_000 && !timer.cleared));
  await coordinator.dispose();
});

test("reconnect rechecks permission and stops retrying after permission is revoked", async () => {
  const permissionStates = ["granted", "denied"];
  const timers = [];
  const windows = [];
  const adapter = new FakeComputerUsePreviewPlatformAdapter();
  adapter.getPermissionState = async () => permissionStates.shift() ?? "denied";
  const coordinator = createCoordinator({
    client: new CountingProjectionClient(FAKE_COMPUTER_USE_PROJECTION),
    adapter,
    preferences: new MemoryPreferenceStore(),
    windows,
    setTimer: (callback, milliseconds) => {
      const timer = { callback, milliseconds, cleared: false, fired: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      timer.cleared = true;
    },
  });
  await coordinator.start();
  coordinator.reportSelectedConversation(FAKE_COMPUTER_USE_PROJECTION.conversationId);
  await flush();
  coordinator.reportFrameReady(FAKE_COMPUTER_USE_PROJECTION.sessionId);
  coordinator.reportSourceEnded(FAKE_COMPUTER_USE_PROJECTION.sessionId, "permission_revoked");
  await flush();

  const retryTimer = timers.find((timer) => timer.milliseconds === 250 && !timer.fired);
  assert.ok(retryTimer);
  retryTimer.fired = true;
  retryTimer.callback();
  await flush();

  assert.equal(adapter.prepareCount, 1, "a revoked permission must prevent another source prepare");
  assert.equal(coordinator.getRendererSnapshot().sourceStatus, "permission_denied");
  assert.equal(coordinator.getRendererSnapshot().canOpenSettings, true);
  assert.equal(
    timers.filter((timer) =>
      !timer.cleared && !timer.fired && [250, 500, 1_000, 2_000].includes(timer.milliseconds),
    ).length,
    0,
    "permission denial must stop the reconnect loop (a bounded error linger may remain)",
  );
  await coordinator.dispose();
});

test("source failure rejects stale revisions, releases media, and closes after the error linger", async () => {
  const timers = [];
  const windows = [];
  const adapter = new FakeComputerUsePreviewPlatformAdapter();
  const coordinator = createCoordinator({
    client: new CountingProjectionClient(FAKE_COMPUTER_USE_PROJECTION),
    adapter,
    preferences: new MemoryPreferenceStore(),
    windows,
    setTimer: (callback, milliseconds) => {
      const timer = { callback, milliseconds, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      timer.cleared = true;
    },
  });
  await coordinator.start();
  coordinator.reportSelectedConversation(FAKE_COMPUTER_USE_PROJECTION.conversationId);
  await flush();

  coordinator.reportSourceFailure(FAKE_COMPUTER_USE_PROJECTION.sessionId, 99, "stale_failure");
  await flush();
  assert.equal(adapter.releaseCount, 0, "a stale revision must not release the current source");
  assert.equal(coordinator.getRendererSnapshot().sourceStatus, "connecting");
  assert.equal(timers.some((timer) => timer.milliseconds === 5_000), false);

  coordinator.reportFrameReady(FAKE_COMPUTER_USE_PROJECTION.sessionId, 1);
  coordinator.reportSourceFailure(FAKE_COMPUTER_USE_PROJECTION.sessionId, 1, "capture_failed");
  await flush();

  assert.equal(adapter.releaseCount, 1);
  assert.equal(coordinator.getRendererSnapshot().sourceStatus, "failed");
  assert.equal(coordinator.getRendererSnapshot().frameReady, false);
  assert.equal(
    windows[0].messages.some((message) => message.channel.endsWith("preview-release-media")),
    false,
    "fake sources have no renderer media tracks to acknowledge",
  );
  const lingerTimer = timers.find((timer) => timer.milliseconds === 5_000 && !timer.cleared);
  assert.ok(lingerTimer, "a renderer source failure should schedule the five-second error linger");
  assert.equal(
    timers.some((timer) => [250, 500, 1_000, 2_000].includes(timer.milliseconds) && !timer.cleared),
    false,
    "a source failure should not start a reconnect loop",
  );

  lingerTimer.callback();
  await flush();
  assert.equal(windows[0].destroyCount, 1);
  await coordinator.dispose();
});

test("source-error linger cannot destroy a same-revision descriptor replacement", async () => {
  const timers = [];
  const windows = [];
  const adapter = new DeferredDisplayMediaReleaseAdapter();
  const client = new CountingProjectionClient(FAKE_COMPUTER_USE_PROJECTION);
  const coordinator = createCoordinator({
    client,
    adapter,
    preferences: new MemoryPreferenceStore(),
    windows,
    setTimer: (callback, milliseconds) => {
      const timer = { callback, milliseconds, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      timer.cleared = true;
    },
  });
  await coordinator.start();
  coordinator.reportSelectedConversation(FAKE_COMPUTER_USE_PROJECTION.conversationId);
  await flush();
  coordinator.reportFrameReady(FAKE_COMPUTER_USE_PROJECTION.sessionId, 1);
  coordinator.reportSourceFailure(FAKE_COMPUTER_USE_PROJECTION.sessionId, 1, "capture_failed");
  await adapter.releaseStarted.promise;
  const lingerTimer = timers.find((timer) => timer.milliseconds === 5_000 && !timer.cleared);
  assert.ok(lingerTimer);

  lingerTimer.callback();
  client.emit({
    ...FAKE_COMPUTER_USE_PROJECTION,
    preview: {
      ...FAKE_COMPUTER_USE_PROJECTION.preview,
      descriptorId: "preview_same_revision_after_error",
      revision: 1,
    },
    updatedAt: "2026-07-15T00:00:03.000Z",
  });
  adapter.allowRelease.resolve();
  await flush();
  await flush();

  assert.equal(windows[0].destroyCount, 1);
  assert.equal(windows.length, 2);
  assert.equal(windows[1].destroyCount, 0);
  assert.equal(coordinator.getRendererSnapshot().sourceRevision, 1);
  assert.ok(coordinator.getRendererSnapshot().sourceGeneration > 1);
  await coordinator.dispose();
});

test("late source failure after Hide cannot replace hidden state or reveal the preview", async () => {
  const timers = [];
  const windows = [];
  const coordinator = createCoordinator({
    client: new CountingProjectionClient(FAKE_COMPUTER_USE_PROJECTION),
    adapter: new FakeComputerUsePreviewPlatformAdapter(),
    preferences: new MemoryPreferenceStore(),
    windows,
    setTimer: (callback, milliseconds) => {
      const timer = { callback, milliseconds, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      timer.cleared = true;
    },
  });
  await coordinator.start();
  coordinator.reportSelectedConversation(FAKE_COMPUTER_USE_PROJECTION.conversationId);
  await flush();
  coordinator.reportFrameReady(FAKE_COMPUTER_USE_PROJECTION.sessionId, 1);
  await coordinator.hide(FAKE_COMPUTER_USE_PROJECTION.sessionId);
  const showCount = windows[0].showCount;

  coordinator.reportSourceFailure(FAKE_COMPUTER_USE_PROJECTION.sessionId, 1, "late_after_hide");
  await flush();
  assert.equal(windows[0].showCount, showCount);
  assert.equal(windows[0].isVisible(), false);
  assert.equal(coordinator.getRendererSnapshot().sourceStatus, "idle");
  assert.equal(coordinator.getRendererSnapshot().visibilityIntent, "hidden");
  assert.equal(timers.some((timer) => timer.milliseconds === 5_000 && !timer.cleared), false);
  await coordinator.dispose();
});

test("late source failure after terminal cannot overwrite the terminal snapshot", async () => {
  const windows = [];
  const client = new CountingProjectionClient(FAKE_COMPUTER_USE_PROJECTION);
  const coordinator = createCoordinator({
    client,
    adapter: new FakeComputerUsePreviewPlatformAdapter(),
    preferences: new MemoryPreferenceStore(),
    windows,
  });
  await coordinator.start();
  coordinator.reportSelectedConversation(FAKE_COMPUTER_USE_PROJECTION.conversationId);
  await flush();
  coordinator.reportFrameReady(FAKE_COMPUTER_USE_PROJECTION.sessionId, 1);
  client.emit({
    ...FAKE_COMPUTER_USE_PROJECTION,
    status: "succeeded",
    updatedAt: "2026-07-15T00:00:03.000Z",
    terminalAt: "2026-07-15T00:00:03.000Z",
  });
  await flush();
  const before = structuredClone(coordinator.getRendererSnapshot());

  coordinator.reportSourceFailure(FAKE_COMPUTER_USE_PROJECTION.sessionId, 1, "late_after_terminal");
  await flush();
  assert.deepEqual(coordinator.getRendererSnapshot(), before);
  assert.equal(windows[0].isVisible(), true);
  await coordinator.dispose();
});

test("source failure linger pauses across hover and focus while preserving remaining time", async () => {
  let nowMs = Date.parse("2026-07-15T12:00:00.000Z");
  const timers = [];
  const windows = [];
  const coordinator = createCoordinator({
    client: new CountingProjectionClient(FAKE_COMPUTER_USE_PROJECTION),
    adapter: new FakeComputerUsePreviewPlatformAdapter(),
    preferences: new MemoryPreferenceStore(),
    windows,
    now: () => new Date(nowMs),
    setTimer: (callback, milliseconds) => {
      const timer = { callback, milliseconds, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      timer.cleared = true;
    },
  });
  await coordinator.start();
  coordinator.reportSelectedConversation(FAKE_COMPUTER_USE_PROJECTION.conversationId);
  await flush();
  coordinator.reportFrameReady(FAKE_COMPUTER_USE_PROJECTION.sessionId, 1);
  coordinator.reportSourceFailure(FAKE_COMPUTER_USE_PROJECTION.sessionId, 1, "capture_failed");
  await flush();

  const initial = timers.find((timer) => timer.milliseconds === 5_000 && !timer.cleared);
  assert.ok(initial);
  nowMs += 2_000;
  coordinator.reportInteraction("hover", true);
  assert.equal(initial.cleared, true);

  coordinator.reportInteraction("focus", true);
  coordinator.reportInteraction("hover", false);
  assert.equal(
    timers.some((timer) => timer.milliseconds === 3_000 && !timer.cleared),
    false,
    "focus must keep the shared interaction pause active after hover leaves",
  );

  coordinator.reportInteraction("focus", false);
  const resumed = timers.find((timer) => timer.milliseconds === 3_000 && !timer.cleared);
  assert.ok(resumed, "the source error must resume with only three seconds remaining");
  resumed.callback();
  await flush();
  assert.equal(windows[0].destroyCount, 1);
  await coordinator.dispose();
});

test("runtime failure received while focused starts its terminal linger paused", async () => {
  const timers = [];
  const windows = [];
  const client = new CountingProjectionClient(FAKE_COMPUTER_USE_PROJECTION);
  const coordinator = createCoordinator({
    client,
    adapter: new FakeComputerUsePreviewPlatformAdapter(),
    preferences: new MemoryPreferenceStore(),
    windows,
    setTimer: (callback, milliseconds) => {
      const timer = { callback, milliseconds, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      timer.cleared = true;
    },
  });
  await coordinator.start();
  coordinator.reportSelectedConversation(FAKE_COMPUTER_USE_PROJECTION.conversationId);
  await flush();
  coordinator.reportFrameReady(FAKE_COMPUTER_USE_PROJECTION.sessionId, 1);
  coordinator.reportInteraction("focus", true);
  client.emit({
    ...FAKE_COMPUTER_USE_PROJECTION,
    status: "failed",
    updatedAt: "2026-07-15T00:00:03.000Z",
    terminalAt: "2026-07-15T00:00:03.000Z",
    failure: { code: "runtime_failed", message: "Runtime failed", recoverable: false },
  });
  await flush();

  assert.equal(
    timers.some((timer) => timer.milliseconds === 5_000 && !timer.cleared),
    false,
    "a focused terminal failure must not begin counting down",
  );
  coordinator.reportInteraction("focus", false);
  const terminal = timers.find((timer) => timer.milliseconds === 5_000 && !timer.cleared);
  assert.ok(terminal);
  terminal.callback();
  await flush();
  assert.equal(windows[0].destroyCount, 1);
  await coordinator.dispose();
});

test("permission recovery interaction pauses linger and opening Settings cancels auto-close", async () => {
  let nowMs = Date.parse("2026-07-15T12:00:00.000Z");
  const timers = [];
  const windows = [];
  const adapter = new FakeComputerUsePreviewPlatformAdapter();
  let settingsOpenCount = 0;
  adapter.getPermissionState = async () => "denied";
  adapter.openPermissionSettings = async () => {
    settingsOpenCount += 1;
  };
  const coordinator = createCoordinator({
    client: new CountingProjectionClient(FAKE_COMPUTER_USE_PROJECTION),
    adapter,
    preferences: new MemoryPreferenceStore(),
    windows,
    now: () => new Date(nowMs),
    setTimer: (callback, milliseconds) => {
      const timer = { callback, milliseconds, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      timer.cleared = true;
    },
  });
  await coordinator.start();
  coordinator.reportSelectedConversation(FAKE_COMPUTER_USE_PROJECTION.conversationId);
  await flush();

  const initial = timers.find((timer) => timer.milliseconds === 5_000 && !timer.cleared);
  assert.ok(initial);
  nowMs += 1_000;
  coordinator.reportInteraction("hover", true);
  assert.equal(initial.cleared, true);
  await coordinator.openPermissionSettings();
  coordinator.reportInteraction("hover", false);

  assert.equal(settingsOpenCount, 1);
  assert.equal(
    timers.some((timer) => timer.milliseconds === 4_000 && !timer.cleared),
    false,
    "acting on the permission prompt must cancel rather than resume auto-close",
  );
  assert.equal(windows[0].destroyCount, 0);
  await coordinator.dispose();
});

test("session switch clears stale interaction before a later failure linger", async () => {
  const timers = [];
  const windows = [];
  const coordinator = createCoordinator({
    client: new CountingProjectionClient(FAKE_COMPUTER_USE_PROJECTION),
    adapter: new FakeComputerUsePreviewPlatformAdapter(),
    preferences: new MemoryPreferenceStore(),
    windows,
    setTimer: (callback, milliseconds) => {
      const timer = { callback, milliseconds, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      timer.cleared = true;
    },
  });
  await coordinator.start();
  coordinator.reportSelectedConversation(FAKE_COMPUTER_USE_PROJECTION.conversationId);
  await flush();
  coordinator.reportFrameReady(FAKE_COMPUTER_USE_PROJECTION.sessionId, 1);
  coordinator.reportSourceFailure(FAKE_COMPUTER_USE_PROJECTION.sessionId, 1, "first_failure");
  await flush();
  coordinator.reportInteraction("hover", true);
  assert.equal(timers.filter((timer) => timer.milliseconds === 5_000).at(-1)?.cleared, true);

  coordinator.reportSelectedConversation("different-conversation");
  await flush();
  coordinator.reportSelectedConversation(FAKE_COMPUTER_USE_PROJECTION.conversationId);
  await flush();
  assert.equal(windows.length, 2);
  coordinator.reportFrameReady(FAKE_COMPUTER_USE_PROJECTION.sessionId, 1);
  coordinator.reportSourceFailure(FAKE_COMPUTER_USE_PROJECTION.sessionId, 1, "second_failure");
  await flush();

  assert.ok(
    timers.filter((timer) => timer.milliseconds === 5_000).find((timer) => !timer.cleared),
    "a recreated preview must not inherit hover/focus state from the destroyed window",
  );
  await coordinator.dispose();
});

test("ten show/hide cycles reuse one window and do not call Stop", async () => {
  const windows = [];
  const client = new CountingProjectionClient(FAKE_COMPUTER_USE_PROJECTION);
  const adapter = new FakeComputerUsePreviewPlatformAdapter();
  const coordinator = createCoordinator({
    client,
    adapter,
    preferences: new MemoryPreferenceStore(),
    windows,
  });
  await coordinator.start();
  coordinator.reportSelectedConversation(FAKE_COMPUTER_USE_PROJECTION.conversationId);
  await flush();
  for (let index = 0; index < 10; index += 1) {
    coordinator.reportFrameReady(FAKE_COMPUTER_USE_PROJECTION.sessionId);
    await coordinator.hide(FAKE_COMPUTER_USE_PROJECTION.sessionId);
    await coordinator.show(FAKE_COMPUTER_USE_PROJECTION.sessionId);
    await flush();
  }
  assert.equal(windows.length, 1);
  assert.equal(windows[0].loadedPaths.length, 1, "repeated Show should not reload the reusable renderer");
  assert.equal(client.stopCount, 0);
  assert.equal(adapter.prepareCount, 11);
  assert.equal(adapter.releaseCount >= 10, true);
  await coordinator.dispose();
  assert.equal(windows[0].destroyCount, 1);
});

test("first open restores the nearest normalized display placement without restarting media on host updates", async () => {
  const displays = [
    { id: "primary", primary: true, workArea: { x: 0, y: 0, width: 1440, height: 900 } },
    { id: "secondary", workArea: { x: 1440, y: 0, width: 1920, height: 1080 } },
  ];
  const preferences = new MemoryPreferenceStore();
  preferences.value.previewDisplayPlacements = {
    secondary: encodeComputerUsePipNormalizedPlacement({
      display: displays[1],
      bounds: { x: 2_580, y: 622.5, width: 400, height: 250 },
    }),
  };
  const windows = [];
  const adapter = new FakeComputerUsePreviewPlatformAdapter();
  const coordinator = createCoordinator({
    client: new CountingProjectionClient(FAKE_COMPUTER_USE_PROJECTION),
    adapter,
    preferences,
    windows,
    displays,
  });
  await coordinator.start();
  coordinator.reportSelectedConversation(FAKE_COMPUTER_USE_PROJECTION.conversationId);
  await flush();

  assert.deepEqual(windows[0].getBounds(), { x: 2_580, y: 622.5, width: 400, height: 250 });
  const prepareCount = adapter.prepareCount;
  const setBoundsCount = windows[0].setBoundsCount;
  coordinator.reportHostLayout({
    windowBounds: { x: 0, y: 0, width: 1_440, height: 900 },
    obstacles: [{ x: 0, y: 0, width: 1_440, height: 900 }],
    reportedAt: "2026-07-16T00:00:00.000Z",
  });
  assert.equal(adapter.prepareCount, prepareCount, "host geometry must not reopen capture");
  assert.equal(windows[0].setBoundsCount, setBoundsCount, "manual placement must stay fixed on host updates");
  await coordinator.dispose();
});

test("real move and resize persist normalized placement, while programmatic bounds do not feed back", async () => {
  const windows = [];
  const preferences = new MemoryPreferenceStore();
  const coordinator = createCoordinator({
    client: new CountingProjectionClient(FAKE_COMPUTER_USE_PROJECTION),
    adapter: new FakeComputerUsePreviewPlatformAdapter(),
    preferences,
    windows,
  });
  await coordinator.start();
  coordinator.reportSelectedConversation(FAKE_COMPUTER_USE_PROJECTION.conversationId);
  await flush();
  const preview = windows[0];
  const automaticBounds = preview.getBounds();

  coordinator.reportHostLayout({
    windowBounds: { x: 0, y: 0, width: 1_440, height: 900 },
    obstacles: [{ x: 1_000, y: 600, width: 400, height: 300 }],
    reportedAt: "2026-07-16T00:00:01.000Z",
  });
  assert.notDeepEqual(preview.getBounds(), automaticBounds);
  const programmaticBounds = preview.getBounds();
  assert.equal(preferences.saveCalls, 0, "programmatic layout must not persist a manual placement");

  preview.moveTo({ x: 100, y: 120 });
  await flush();
  preview.resizeTo({ width: 500, height: 300 });
  await flush();
  assert.equal(preferences.saveCalls > 0, true);
  assert.equal(preferences.value.previewDisplayPlacements.primary.displayId, "primary");
  assert.deepEqual(preferences.value.previewBounds, {
    displayId: "primary",
    x: 100,
    y: 120,
    width: 500,
    height: 300,
  });
  assert.notDeepEqual(preview.getBounds(), programmaticBounds);
  await coordinator.dispose();
});

test("user drag completion debounces corner snap, persists the preferred corner, and clears the timer on destroy", async () => {
  const clock = createVirtualTimerHarness("2026-07-15T12:00:00.000Z");
  const windows = [];
  const preferences = new MemoryPreferenceStore();
  const coordinator = createCoordinator({
    client: new CountingProjectionClient(FAKE_COMPUTER_USE_PROJECTION),
    adapter: new FakeComputerUsePreviewPlatformAdapter(),
    preferences,
    windows,
    now: () => new Date(clock.nowMs),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  await coordinator.start();
  coordinator.reportSelectedConversation(FAKE_COMPUTER_USE_PROJECTION.conversationId);
  await flush();
  const preview = windows[0];

  preview.moveTo({ x: 64, y: 72 });
  await flush();
  const firstSnapTimer = clock.activeTimers()[0];
  assert.ok(firstSnapTimer, "a user move must schedule a debounced corner snap");

  preview.moveTo({ x: 970, y: 48 });
  await flush();
  assert.equal(firstSnapTimer.cleared, true, "continued dragging must replace the prior debounce timer");
  assert.equal(clock.activeTimers().length, 1);

  const snapTimer = await clock.fireNext();
  assert.equal(snapTimer.milliseconds, 180);
  assert.deepEqual(preview.getBounds(), { x: 1_004, y: 16, width: 420, height: 263 });
  assert.equal(preferences.value.previewPreferredCorner, "top-right");
  assert.equal(preferences.value.previewDisplayPlacements.primary.displayId, "primary");
  assert.equal(clock.activeTimers().length, 0, "completed snap must not leave a timer behind");

  preview.moveTo({ x: 48, y: 580 });
  await flush();
  const pendingDestroySnap = clock.activeTimers()[0];
  assert.ok(pendingDestroySnap);
  assert.deepEqual(await coordinator.close(FAKE_COMPUTER_USE_PROJECTION.sessionId), { accepted: true });
  assert.equal(pendingDestroySnap.cleared, true, "destroying the preview must clear the pending snap timer");
  assert.equal(clock.activeTimers().length, 0);
  await coordinator.dispose();
});

test("saved preferred corner controls automatic placement after restart", async () => {
  const preferences = new MemoryPreferenceStore();
  preferences.value.previewPreferredCorner = "top-left";
  const windows = [];
  const coordinator = createCoordinator({
    client: new CountingProjectionClient(FAKE_COMPUTER_USE_PROJECTION),
    adapter: new FakeComputerUsePreviewPlatformAdapter(),
    preferences,
    windows,
  });
  await coordinator.start();
  coordinator.reportSelectedConversation(FAKE_COMPUTER_USE_PROJECTION.conversationId);
  await flush();

  assert.deepEqual(windows[0].getBounds(), { x: 16, y: 16, width: 420, height: 263 });
  await coordinator.dispose();
});

test("window aspect ratio follows descriptor and prepared source updates", async () => {
  const client = new CountingProjectionClient({
    ...FAKE_COMPUTER_USE_PROJECTION,
    preview: { ...FAKE_COMPUTER_USE_PROJECTION.preview, aspectRatio: 1.8 },
  });
  const adapter = new AspectRatioSequenceAdapter([1.5, 2.2]);
  const windows = [];
  const coordinator = createCoordinator({
    client,
    adapter,
    preferences: new MemoryPreferenceStore(),
    windows,
  });
  await coordinator.start();
  coordinator.reportSelectedConversation(FAKE_COMPUTER_USE_PROJECTION.conversationId);
  await flush();
  const preview = windows[0];
  assert.deepEqual(preview.aspectRatioCalls, [1.8, 1.5]);

  client.emit({
    ...FAKE_COMPUTER_USE_PROJECTION,
    preview: { ...FAKE_COMPUTER_USE_PROJECTION.preview, aspectRatio: 1.9 },
    updatedAt: "2026-07-15T00:00:02.000Z",
  });
  await flush();
  assert.deepEqual(preview.aspectRatioCalls, [1.8, 1.5, 1.9]);
  assert.equal(adapter.prepareCount, 1, "a metadata-only ratio update must not reacquire the source");

  client.emit({
    ...FAKE_COMPUTER_USE_PROJECTION,
    preview: { ...FAKE_COMPUTER_USE_PROJECTION.preview, revision: 2, aspectRatio: 2 },
    updatedAt: "2026-07-15T00:00:03.000Z",
  });
  await flush();
  assert.deepEqual(preview.aspectRatioCalls, [1.8, 1.5, 1.9, 2, 2.2]);
  assert.equal(adapter.prepareCount, 2);
  assert.equal(coordinator.getRendererSnapshot().aspectRatio, 2.2);
  await coordinator.dispose();
});

test("native aspect ratio preserves portrait sources while automatic placement stays bounded", async () => {
  const client = new CountingProjectionClient({
    ...FAKE_COMPUTER_USE_PROJECTION,
    preview: { ...FAKE_COMPUTER_USE_PROJECTION.preview, aspectRatio: 0.75 },
  });
  const adapter = new AspectRatioSequenceAdapter([0.5]);
  const windows = [];
  const coordinator = createCoordinator({
    client,
    adapter,
    preferences: new MemoryPreferenceStore(),
    windows,
  });
  await coordinator.start();
  coordinator.reportSelectedConversation(FAKE_COMPUTER_USE_PROJECTION.conversationId);
  await flush();

  const preview = windows[0];
  assert.deepEqual(preview.aspectRatioCalls, [0.75, 0.5]);
  assert.equal(coordinator.getRendererSnapshot().aspectRatio, 0.5);
  assert.equal(preview.getBounds().height <= 900, true);
  await coordinator.dispose();
});

test("display disconnect restores manual placement to the nearest remaining display and Reset returns to automatic layout", async () => {
  const displays = [
    { id: "primary", primary: true, workArea: { x: 0, y: 0, width: 1440, height: 900 } },
    { id: "secondary", workArea: { x: 1440, y: 0, width: 1920, height: 1080 } },
  ];
  const preferences = new MemoryPreferenceStore();
  preferences.value.previewDisplayPlacements = {
    secondary: encodeComputerUsePipNormalizedPlacement({
      display: displays[1],
      bounds: { x: 2_580, y: 622.5, width: 400, height: 250 },
    }),
  };
  const windows = [];
  const coordinator = createCoordinator({
    client: new CountingProjectionClient(FAKE_COMPUTER_USE_PROJECTION),
    adapter: new FakeComputerUsePreviewPlatformAdapter(),
    preferences,
    windows,
    displays,
  });
  await coordinator.start();
  coordinator.reportSelectedConversation(FAKE_COMPUTER_USE_PROJECTION.conversationId);
  await flush();

  displays.splice(1, 1);
  coordinator.reportDisplayTopologyChanged();
  await flush();
  const fallbackBounds = windows[0].getBounds();
  assert.equal(fallbackBounds.x >= 0 && fallbackBounds.x + fallbackBounds.width <= 1_440, true);
  assert.equal(fallbackBounds.y >= 0 && fallbackBounds.y + fallbackBounds.height <= 900, true);

  const reset = await coordinator.resetPosition();
  assert.deepEqual(reset, { accepted: true });
  assert.equal(preferences.value.previewDisplayPlacements?.secondary, undefined);
  assert.equal(preferences.value.previewBounds, undefined);
  const resetBounds = windows[0].getBounds();
  assert.notDeepEqual(resetBounds, fallbackBounds);
  await coordinator.dispose();
});

function activeReplacementProjection(sessionId, updatedAt) {
  return {
    ...FAKE_COMPUTER_USE_PROJECTION,
    sessionId,
    runId: `${sessionId}-run`,
    workUnitId: `${sessionId}-work-unit`,
    status: "running",
    preview: {
      ...FAKE_COMPUTER_USE_PROJECTION.preview,
      descriptorId: `${sessionId}-descriptor`,
      revision: 1,
    },
    failure: undefined,
    terminalAt: undefined,
    updatedAt,
  };
}

function createCoordinator({
  client,
  adapter,
  preferences,
  windows,
  setTimer,
  clearTimer,
  now,
  displays,
  telemetry,
}) {
  const displayList = displays ?? [{ id: "primary", primary: true, workArea: { x: 0, y: 0, width: 1440, height: 900 } }];
  let coordinator;
  coordinator = new ComputerUsePreviewCoordinator({
    projectionClient: client,
    platformAdapter: adapter,
    preferenceStore: preferences,
    previewIndexPath: "/fake/preview/index.html",
    createWindow: (bounds) => {
      const window = new FakePreviewWindow(
        bounds,
        windows.length + 1,
        (ack, webContentsId) => coordinator.reportMediaReleased(ack, webContentsId),
      );
      windows.push(window);
      return window;
    },
    getDisplays: () => displayList,
    getDisplayMatching: (bounds = displayList[0].workArea) => displayList
      .map((display) => ({
        display,
        distance: centerDistance(bounds, display.workArea),
      }))
      .sort((left, right) => left.distance - right.distance)[0].display,
    now: now ?? (() => new Date("2026-07-15T12:00:00.000Z")),
    ...(telemetry ? { telemetry } : {}),
    ...(setTimer ? { setTimer } : {}),
    ...(clearTimer ? { clearTimer } : {}),
  });
  installCurrentSourceIdentityTestDefaults(coordinator);
  return coordinator;
}

function installCurrentSourceIdentityTestDefaults(coordinator) {
  // Older scenarios focus on lifecycle behavior rather than transport
  // identity. Keep them concise while production IPC and the generation-race
  // regressions below always pass the exact source identity explicitly.
  const currentIdentity = () => {
    const snapshot = coordinator.getRendererSnapshot();
    return {
      revision: snapshot?.sourceRevision ?? 0,
      sourceGeneration: snapshot?.sourceGeneration ?? 0,
    };
  };
  const reportFrameReady = coordinator.reportFrameReady.bind(coordinator);
  coordinator.reportFrameReady = (sessionId, revision, sourceGeneration) => {
    const current = currentIdentity();
    reportFrameReady(
      sessionId,
      revision ?? current.revision,
      sourceGeneration ?? current.sourceGeneration,
    );
  };
  const reportFrameActivity = coordinator.reportFrameActivity.bind(coordinator);
  coordinator.reportFrameActivity = (sessionId, revision, sourceGeneration) => {
    const current = currentIdentity();
    reportFrameActivity(
      sessionId,
      revision ?? current.revision,
      sourceGeneration ?? current.sourceGeneration,
    );
  };
  const reportSourceEnded = coordinator.reportSourceEnded.bind(coordinator);
  coordinator.reportSourceEnded = (sessionId, revision, sourceGeneration, reason) => {
    const current = currentIdentity();
    if (typeof revision === "string") {
      reportSourceEnded(sessionId, current.revision, current.sourceGeneration, revision);
      return;
    }
    if (typeof sourceGeneration === "string" || sourceGeneration === undefined) {
      reportSourceEnded(
        sessionId,
        revision ?? current.revision,
        current.sourceGeneration,
        sourceGeneration ?? reason ?? "source_ended",
      );
      return;
    }
    reportSourceEnded(sessionId, revision, sourceGeneration, reason ?? "source_ended");
  };
  const reportSourceFailure = coordinator.reportSourceFailure.bind(coordinator);
  coordinator.reportSourceFailure = (sessionId, revision, sourceGeneration, reason) => {
    const current = currentIdentity();
    if (typeof revision === "string") {
      reportSourceFailure(sessionId, current.revision, current.sourceGeneration, revision);
      return;
    }
    if (typeof sourceGeneration === "string" || sourceGeneration === undefined) {
      reportSourceFailure(
        sessionId,
        revision ?? current.revision,
        current.sourceGeneration,
        sourceGeneration ?? reason ?? "source_failed",
      );
      return;
    }
    reportSourceFailure(sessionId, revision, sourceGeneration, reason ?? "source_failed");
  };
}

class CountingProjectionClient extends FakeComputerUseProjectionClient {
  stopCount = 0;

  async stop(sessionId, reason) {
    this.stopCount += 1;
    return super.stop(sessionId, reason);
  }
}

class UnacknowledgedStopProjectionClient extends CountingProjectionClient {
  async stop(sessionId) {
    this.stopCount += 1;
    return {
      sessionId,
      accepted: true,
      acknowledged: false,
      auditId: "fake-computer-use-stop-timeout-audit",
      projection: FAKE_COMPUTER_USE_PROJECTION,
      reason: "computer_use_stop_ack_timeout",
    };
  }
}

class ThrowingCloseProjectionClient extends CountingProjectionClient {
  subscribe(listener) {
    const subscription = super.subscribe(listener);
    return {
      close() {
        subscription.close();
        throw new Error("projection_subscription_close_failed");
      },
    };
  }
}

class MemoryPreferenceStore {
  value = {
    schemaVersion: 1,
    previewAutoShow: true,
    hiddenSessionSuppressions: {},
  };
  saveCalls = 0;

  async load() {
    return structuredClone(this.value);
  }

  async save(value) {
    this.saveCalls += 1;
    this.value = structuredClone(value);
  }
}

class RejectingPreferenceStore extends MemoryPreferenceStore {
  async save() {
    this.saveCalls += 1;
    throw new Error("desktop_preferences_write_failed");
  }
}

class DeferredPreferenceStore extends MemoryPreferenceStore {
  saveStarted = deferred();
  allowSave = deferred();

  async save(value) {
    this.saveCalls += 1;
    this.saveStarted.resolve(structuredClone(value));
    await this.allowSave.promise;
    this.value = structuredClone(value);
  }
}

class DeferredReconnectPermissionAdapter extends FakeComputerUsePreviewPlatformAdapter {
  permissionChecks = 0;
  reconnectPermissionStarted = deferred();
  allowReconnectPermission = deferred();

  async getPermissionState() {
    this.permissionChecks += 1;
    if (this.permissionChecks === 1) {
      return "granted";
    }
    this.reconnectPermissionStarted.resolve();
    await this.allowReconnectPermission.promise;
    return "granted";
  }
}

class DeferredReleaseAdapter extends FakeComputerUsePreviewPlatformAdapter {
  releaseStarted = deferred();
  allowRelease = deferred();

  async release() {
    this.releaseCount += 1;
    this.releaseStarted.resolve();
    await this.allowRelease.promise;
  }
}

class DeferredSecondPrepareAdapter extends FakeComputerUsePreviewPlatformAdapter {
  prepareInputs = [];
  secondPrepareStarted = deferred();
  allowSecondPrepare = deferred();

  async prepare(input) {
    this.prepareCount += 1;
    this.prepareInputs.push(structuredClone(input));
    if (this.prepareCount === 2) {
      this.secondPrepareStarted.resolve();
      await this.allowSecondPrepare.promise;
    }
    return { sourceKind: "fake", aspectRatio: 1.6 };
  }
}

class AspectRatioSequenceAdapter extends FakeComputerUsePreviewPlatformAdapter {
  constructor(aspectRatios) {
    super();
    this.aspectRatios = [...aspectRatios];
  }

  async prepare() {
    this.prepareCount += 1;
    return {
      sourceKind: "fake",
      aspectRatio: this.aspectRatios[this.prepareCount - 1] ?? 1.6,
    };
  }
}

class DisplayMediaFakeAdapter extends FakeComputerUsePreviewPlatformAdapter {
  async prepare() {
    this.prepareCount += 1;
    return { sourceKind: "display_media", aspectRatio: 1.6 };
  }
}

class DeferredDisplayMediaReleaseAdapter extends DisplayMediaFakeAdapter {
  releaseStarted = deferred();
  allowRelease = deferred();

  async release() {
    this.releaseCount += 1;
    this.releaseStarted.resolve();
    await this.allowRelease.promise;
  }
}

class ThrowingDisplayMediaReleaseAdapter extends DisplayMediaFakeAdapter {
  async release() {
    this.releaseCount += 1;
    throw new Error("display_media_release_failed");
  }
}

class FakePreviewWindow {
  messages = [];
  showCount = 0;
  hideCount = 0;
  destroyCount = 0;
  setBoundsCount = 0;
  aspectRatioCalls = [];
  destroyed = false;
  visible = false;
  closedListeners = [];
  moveListeners = [];
  resizeListeners = [];
  loadedPaths = [];
  rendererGoneListeners = [];
  sendThrows = false;
  sendAttemptCount = 0;
  releaseAckMode = "success";
  releaseRequests = [];
  webContents;

  constructor(bounds, id, reportMediaReleased) {
    this.bounds = bounds;
    this.webContents = {
      id,
      send: (channel, ...args) => {
        this.sendAttemptCount += 1;
        if (this.sendThrows) {
          throw new Error("renderer_gone");
        }
        this.messages.push({ channel, args });
        if (channel.endsWith("preview-release-media")) {
          const request = args[0];
          this.releaseRequests.push(request);
          if (this.releaseAckMode !== "none") {
            queueMicrotask(() => reportMediaReleased({
              ...request,
              status: this.releaseAckMode === "identity_mismatch" ? "identity_mismatch" : "released",
              releasedTrackCount: this.releaseAckMode === "identity_mismatch" ? 0 : 1,
              allTracksEnded: this.releaseAckMode !== "identity_mismatch",
            }, id));
          }
        }
      },
    };
  }

  async loadFile(path) {
    this.loadedPaths.push(path);
  }

  showInactive() {
    this.showCount += 1;
    this.visible = true;
  }

  hide() {
    this.hideCount += 1;
    this.visible = false;
  }

  destroy() {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.visible = false;
    this.destroyCount += 1;
    for (const listener of this.closedListeners) {
      listener();
    }
  }

  isDestroyed() {
    return this.destroyed;
  }

  isVisible() {
    return this.visible;
  }

  setAspectRatio(aspectRatio) {
    this.aspectRatioCalls.push(aspectRatio);
  }

  setBounds(bounds) {
    this.setBoundsCount += 1;
    this.bounds = bounds;
  }

  moveTo(bounds) {
    this.bounds = { ...this.bounds, x: bounds.x, y: bounds.y };
    for (const listener of this.moveListeners) {
      listener();
    }
  }

  resizeTo(bounds) {
    this.bounds = { ...this.bounds, width: bounds.width, height: bounds.height };
    for (const listener of this.resizeListeners) {
      listener();
    }
  }

  getBounds() {
    return this.bounds;
  }

  on(event, listener) {
    if (event === "closed") {
      this.closedListeners.push(listener);
    } else if (event === "move") {
      this.moveListeners.push(listener);
    } else if (event === "resize") {
      this.resizeListeners.push(listener);
    }
    return this;
  }

  off(event, listener) {
    const listeners = event === "closed"
      ? this.closedListeners
      : event === "move"
        ? this.moveListeners
        : this.resizeListeners;
    const index = listeners.indexOf(listener);
    if (index >= 0) {
      listeners.splice(index, 1);
    }
    return this;
  }

  onRendererProcessGone(listener) {
    this.rendererGoneListeners.push(listener);
    return () => {
      const index = this.rendererGoneListeners.indexOf(listener);
      if (index >= 0) {
        this.rendererGoneListeners.splice(index, 1);
      }
    };
  }

  emitRendererProcessGone(details) {
    for (const listener of [...this.rendererGoneListeners]) {
      listener(details);
    }
  }
}

function centerDistance(left, right) {
  const x = left.x + left.width / 2 - (right.x + right.width / 2);
  const y = left.y + left.height / 2 - (right.y + right.height / 2);
  return x * x + y * y;
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function deferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function createVirtualTimerHarness(startedAt) {
  const harness = {
    nowMs: Date.parse(startedAt),
    timers: [],
    setTimer: (callback, milliseconds) => {
      const timer = {
        callback,
        milliseconds,
        dueAtMs: harness.nowMs + milliseconds,
        cleared: false,
        fired: false,
      };
      harness.timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      timer.cleared = true;
    },
    activeTimers() {
      return harness.timers.filter((timer) => !timer.cleared && !timer.fired);
    },
    activeTimer(milliseconds) {
      return harness.activeTimers().find((timer) => timer.milliseconds === milliseconds);
    },
    async fireNext() {
      const timer = harness.activeTimers()
        .sort((left, right) => left.dueAtMs - right.dueAtMs)[0];
      assert.ok(timer, "expected another active virtual timer");
      harness.nowMs = timer.dueAtMs;
      timer.fired = true;
      timer.callback();
      await flush();
      return timer;
    },
  };
  return harness;
}

async function waitFor(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("condition_timeout");
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
}
