import assert from "node:assert/strict";
import test from "node:test";
import { ComputerUseRecoveryTimers } from "../dist/main/computer-use/recovery-timers.js";

test("frame-gap watchdog resets on activity and fires once after one second", () => {
  const harness = createTimerHarness();
  const recovery = harness.createRecoveryTimers();
  let gaps = 0;

  recovery.restartFrameGapWatchdog(() => {
    gaps += 1;
  });
  const first = harness.latest(1_000);
  recovery.restartFrameGapWatchdog(() => {
    gaps += 1;
  });
  const second = harness.latest(1_000);

  assert.equal(first.cleared, true);
  assert.notEqual(second, first);
  second.fire();
  assert.equal(gaps, 1);

  recovery.clearFrameGapWatchdog();
  assert.equal(gaps, 1);
});

test("first-frame watchdog resets and fires once after one second", () => {
  const harness = createTimerHarness();
  const recovery = harness.createRecoveryTimers();
  let timeouts = 0;

  recovery.restartFirstFrameWatchdog(() => {
    timeouts += 1;
  });
  const first = harness.latest(1_000);
  recovery.restartFirstFrameWatchdog(() => {
    timeouts += 1;
  });
  const second = harness.latest(1_000);

  assert.equal(first.cleared, true);
  assert.notEqual(second, first);
  second.fire();
  assert.equal(timeouts, 1);

  recovery.clearFirstFrameWatchdog();
  assert.equal(timeouts, 1);
});

test("reconnect backoff is bounded to ten seconds and resets cleanly", () => {
  const harness = createTimerHarness();
  const recovery = harness.createRecoveryTimers();
  const retries = [];
  const onTimeout = () => undefined;

  for (const expectedDelay of [250, 500, 1_000, 2_000]) {
    assert.equal(recovery.scheduleReconnect({ onRetry: () => retries.push(expectedDelay), onTimeout }), "scheduled");
    const timer = harness.latest(expectedDelay);
    timer.fire();
  }
  assert.deepEqual(retries, [250, 500, 1_000, 2_000]);

  harness.nowMs += 10_001;
  assert.equal(recovery.scheduleReconnect({ onRetry: () => retries.push("late"), onTimeout }), "timed_out");
  assert.equal(retries.includes("late"), false);

  recovery.clearReconnectTimer(true);
  assert.equal(recovery.scheduleReconnect({ onRetry: () => retries.push("reset"), onTimeout }), "scheduled");
  assert.equal(harness.latest(250).milliseconds, 250);
});

test("reconnect deadline fires at ten seconds and invalidates a retained retry callback", () => {
  const harness = createTimerHarness();
  const recovery = harness.createRecoveryTimers();
  let retries = 0;
  let timeouts = 0;

  assert.equal(recovery.scheduleReconnect({
    onRetry: () => {
      retries += 1;
    },
    onTimeout: () => {
      timeouts += 1;
    },
  }), "scheduled");
  const retry = harness.latest(250);
  const deadline = harness.latest(10_000);
  assert.ok(retry);
  assert.ok(deadline, "the first stalled attempt must arm an absolute ten-second deadline");

  harness.nowMs += 10_000;
  deadline.fire();
  assert.equal(timeouts, 1);
  assert.equal(retry.cleared, true, "deadline expiry must cancel the pending retry");

  retry.fire();
  assert.equal(retries, 0, "a retained callback must remain stale after deadline expiry");
});

test("rescheduling reconnect invalidates the replaced retry without moving its deadline", () => {
  const harness = createTimerHarness();
  const recovery = harness.createRecoveryTimers();
  const retries = [];
  const onTimeout = () => undefined;

  recovery.scheduleReconnect({ onRetry: () => retries.push(250), onTimeout });
  const firstRetry = harness.latest(250);
  const deadline = harness.latest(10_000);
  recovery.scheduleReconnect({ onRetry: () => retries.push(500), onTimeout });
  const secondRetry = harness.latest(500);

  assert.equal(firstRetry.cleared, true);
  assert.equal(harness.latest(10_000), deadline, "one recovery cycle owns one absolute deadline");
  firstRetry.fire();
  assert.deepEqual(retries, []);
  secondRetry.fire();
  assert.deepEqual(retries, [500]);
});

test("terminal, source-error, first-frame, frame-gap, and reconnect timers are all cleared together", () => {
  const harness = createTimerHarness();
  const recovery = harness.createRecoveryTimers();
  recovery.startTerminalLinger({ status: "failed" }, () => undefined);
  recovery.startSourceErrorLinger(() => undefined);
  recovery.restartFirstFrameWatchdog(() => undefined);
  recovery.restartFrameGapWatchdog(() => undefined);
  recovery.scheduleReconnect({ onRetry: () => undefined, onTimeout: () => undefined });

  recovery.clearAll();

  assert.equal(harness.timers.length, 6);
  assert.equal(harness.timers.every((timer) => timer.cleared), true);
});

test("five-second error linger preserves its remaining time while interaction is active", () => {
  const harness = createTimerHarness();
  const recovery = harness.createRecoveryTimers();
  let expired = 0;

  recovery.startSourceErrorLinger(() => {
    expired += 1;
  });
  const initial = harness.latest(5_000);
  harness.nowMs += 2_000;
  recovery.setInteractionPaused(true);

  assert.equal(initial.cleared, true);
  initial.fire();
  assert.equal(expired, 0, "a cleared pre-pause callback must stay stale");

  harness.nowMs += 30_000;
  recovery.setInteractionPaused(false);
  const resumed = harness.latest(3_000);
  assert.ok(resumed, "resume must schedule only the original remaining three seconds");
  resumed.fire();
  assert.equal(expired, 1);
});

test("clearing a pausable linger invalidates a retained callback", () => {
  const harness = createTimerHarness();
  const recovery = harness.createRecoveryTimers();
  let expired = 0;

  recovery.startTerminalLinger({ status: "failed" }, () => {
    expired += 1;
  });
  const retained = harness.latest(5_000);
  recovery.clearAll();
  retained.fire();

  assert.equal(expired, 0);
});

test("interaction pause does not alter success, cancel, frame-gap, or reconnect timing", () => {
  for (const [status, delay] of [["succeeded", 1_500], ["cancelled", 300]]) {
    const harness = createTimerHarness();
    const recovery = harness.createRecoveryTimers();
    recovery.startTerminalLinger({ status }, () => undefined);
    const terminal = harness.latest(delay);
    recovery.setInteractionPaused(true);
    assert.equal(terminal.cleared, false, `${status} terminal timing must remain deterministic`);
  }

  const harness = createTimerHarness();
  const recovery = harness.createRecoveryTimers();
  recovery.restartFirstFrameWatchdog(() => undefined);
  recovery.restartFrameGapWatchdog(() => undefined);
  recovery.scheduleReconnect({ onRetry: () => undefined, onTimeout: () => undefined });
  const firstFrame = harness.timers.find((timer) => timer.milliseconds === 1_000);
  const frameGap = [...harness.timers].reverse().find((timer) => timer.milliseconds === 1_000);
  const reconnect = harness.latest(250);
  const reconnectDeadline = harness.latest(10_000);
  recovery.setInteractionPaused(true);

  assert.equal(firstFrame.cleared, false);
  assert.equal(frameGap.cleared, false);
  assert.equal(reconnect.cleared, false);
  assert.equal(reconnectDeadline.cleared, false);
});

function createTimerHarness() {
  const harness = {
    nowMs: Date.parse("2026-07-16T00:00:00.000Z"),
    timers: [],
    createRecoveryTimers() {
      return new ComputerUseRecoveryTimers({
        now: () => new Date(harness.nowMs),
        setTimer: (callback, milliseconds) => {
          const timer = {
            callback,
            milliseconds,
            cleared: false,
            fired: false,
            fire() {
              this.fired = true;
              this.callback();
            },
          };
          harness.timers.push(timer);
          return timer;
        },
        clearTimer: (timer) => {
          timer.cleared = true;
        },
      });
    },
    latest(milliseconds) {
      return [...harness.timers].reverse().find((timer) => timer.milliseconds === milliseconds);
    },
  };
  return harness;
}
