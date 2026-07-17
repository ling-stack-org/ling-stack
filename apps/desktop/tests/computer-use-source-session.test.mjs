import assert from "node:assert/strict";
import test from "node:test";
import {
  COMPUTER_USE_RENDERER_MEDIA_RELEASE_TIMEOUT_MS,
  ComputerUsePreviewSourceSession,
} from "../dist/main/computer-use/source-session.js";

test("source generations are Desktop-local, monotonic, and invalidated independently of daemon revision", () => {
  const session = new ComputerUsePreviewSourceSession();
  const first = session.beginSourceActivation();
  session.snapshot = { sourceRevision: 1, sourceGeneration: first };
  assert.equal(session.matchesSourceIdentity(1, first), true);

  session.invalidateSourceActivation();
  assert.equal(session.matchesSourceIdentity(1, first), false);

  const replacement = session.beginSourceActivation();
  session.snapshot = { sourceRevision: 1, sourceGeneration: replacement };
  assert.equal(replacement, first + 1);
  assert.equal(session.matchesSourceIdentity(1, first), false);
  assert.equal(session.matchesSourceIdentity(1, replacement), true);
});

test("renderer media release accepts only the exact sender and request identity", async () => {
  const session = new ComputerUsePreviewSourceSession();
  const adapter = new ReleaseCountingAdapter();
  const window = new FakePreviewWindow(41);
  const timers = createTimerHarness();
  const completion = session.releaseMedia(releaseInput({ window, adapter, timers }));
  const request = window.releaseRequests[0];

  assert.equal(session.acknowledgeRendererMediaRelease(successAck(request), 999), false);
  assert.equal(session.acknowledgeRendererMediaRelease(successAck({ ...request, requestId: "wrong" }), 41), false);
  assert.equal(session.acknowledgeRendererMediaRelease(successAck({ ...request, sourceRevision: 8 }), 41), false);
  assert.equal(session.acknowledgeRendererMediaRelease(successAck({ ...request, sourceGeneration: 8 }), 41), false);
  assert.equal(session.acknowledgeRendererMediaRelease(successAck(request), 41), true);
  assert.equal(await completion, "acknowledged");
  assert.equal(session.acknowledgeRendererMediaRelease(successAck(request), 41), false, "ack replay must be ignored");
  assert.equal(adapter.releaseCount, 1);
  assert.deepEqual(timers.activeTimers(), []);
});

test("concurrent matching release calls share the request, timer, adapter cleanup, and completion", async () => {
  const session = new ComputerUsePreviewSourceSession();
  const adapter = new ReleaseCountingAdapter();
  const window = new FakePreviewWindow(42);
  const timers = createTimerHarness();
  const input = releaseInput({ window, adapter, timers });

  const first = session.releaseMedia(input);
  const second = session.releaseMedia(input);
  assert.equal(first, second);
  assert.equal(window.releaseRequests.length, 1);
  assert.equal(timers.activeTimers().length, 1);
  assert.equal(adapter.releaseCount, 1);

  session.acknowledgeRendererMediaRelease(successAck(window.releaseRequests[0]), 42);
  assert.deepEqual(await Promise.all([first, second]), ["acknowledged", "acknowledged"]);
});

test("a conflicting release fails closed without replacing the pending request", async () => {
  const session = new ComputerUsePreviewSourceSession();
  const adapter = new ReleaseCountingAdapter();
  const window = new FakePreviewWindow(43);
  const timers = createTimerHarness();
  const failures = [];
  const first = session.releaseMedia(releaseInput({ window, adapter, timers }));
  const conflict = session.releaseMedia({
    ...releaseInput({ window, adapter, timers }),
    identity: { sessionId: "another-session", sourceRevision: 2, sourceGeneration: 2 },
    onRendererReleaseFailure: (outcome) => failures.push(outcome),
  });

  assert.equal(await conflict, "conflict");
  await Promise.resolve();
  assert.deepEqual(failures, ["conflict"]);
  assert.equal(window.releaseRequests.length, 1);
  assert.equal(adapter.releaseCount, 1);

  session.acknowledgeRendererMediaRelease(successAck(window.releaseRequests[0]), 43);
  assert.equal(await first, "acknowledged");
});

test("an old timeout callback cannot settle a newer renderer release", async () => {
  const session = new ComputerUsePreviewSourceSession();
  const adapter = new ReleaseCountingAdapter();
  const window = new FakePreviewWindow(44);
  const timers = createTimerHarness();

  const first = session.releaseMedia(releaseInput({ window, adapter, timers }));
  const oldTimer = timers.activeTimers()[0];
  oldTimer.callback();
  assert.equal(await first, "timed_out");

  const second = session.releaseMedia({
    ...releaseInput({ window, adapter, timers }),
    identity: { sessionId: "preview-session", sourceRevision: 1, sourceGeneration: 2 },
  });
  const secondRequest = window.releaseRequests[1];
  oldTimer.callback();
  await Promise.resolve();
  assert.equal(timers.activeTimers().length, 1, "the newer request must remain pending");

  assert.equal(session.acknowledgeRendererMediaRelease(successAck(secondRequest), 44), true);
  assert.equal(await second, "acknowledged");
});

test("renderer disappearance and send failure settle release immediately", async () => {
  const timers = createTimerHarness();
  const goneSession = new ComputerUsePreviewSourceSession();
  const goneWindow = new FakePreviewWindow(45);
  const gone = goneSession.releaseMedia(releaseInput({
    window: goneWindow,
    adapter: new ReleaseCountingAdapter(),
    timers,
  }));
  goneSession.reportRendererGone(45);
  assert.equal(await gone, "renderer_gone");

  const failedSession = new ComputerUsePreviewSourceSession();
  const failedWindow = new FakePreviewWindow(46);
  failedWindow.sendThrows = true;
  const failed = failedSession.releaseMedia(releaseInput({
    window: failedWindow,
    adapter: new ReleaseCountingAdapter(),
    timers,
  }));
  assert.equal(await failed, "send_failed");
  assert.deepEqual(timers.activeTimers(), []);
});

test("renderer release timeout is bounded to the privacy deadline", async () => {
  const session = new ComputerUsePreviewSourceSession();
  const timers = createTimerHarness();
  const completion = session.releaseMedia(releaseInput({
    window: new FakePreviewWindow(47),
    adapter: new ReleaseCountingAdapter(),
    timers,
  }));
  const timer = timers.activeTimers()[0];
  assert.equal(timer.milliseconds, COMPUTER_USE_RENDERER_MEDIA_RELEASE_TIMEOUT_MS);
  timer.callback();
  assert.equal(await completion, "timed_out");
});

function releaseInput({ window, adapter, timers }) {
  return {
    window,
    platformAdapter: adapter,
    identity: { sessionId: "preview-session", sourceRevision: 1, sourceGeneration: 1 },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  };
}

function successAck(request) {
  return {
    ...request,
    status: "released",
    releasedTrackCount: 1,
    allTracksEnded: true,
  };
}

class ReleaseCountingAdapter {
  releaseCount = 0;

  async release() {
    this.releaseCount += 1;
  }
}

class FakePreviewWindow {
  destroyed = false;
  releaseRequests = [];
  sendThrows = false;
  webContents;

  constructor(id) {
    this.webContents = {
      id,
      send: (_channel, request) => {
        if (this.sendThrows) {
          throw new Error("renderer_gone");
        }
        this.releaseRequests.push(request);
      },
    };
  }

  isDestroyed() {
    return this.destroyed;
  }
}

function createTimerHarness() {
  const timers = [];
  return {
    setTimer(callback, milliseconds) {
      const timer = { callback, milliseconds, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer(timer) {
      timer.cleared = true;
    },
    activeTimers() {
      return timers.filter((timer) => !timer.cleared);
    },
  };
}
