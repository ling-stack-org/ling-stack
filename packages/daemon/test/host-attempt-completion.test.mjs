import assert from "node:assert/strict";
import test from "node:test";
import { observeHostAttemptCompletion } from "../dist/runtime/host-attempt-completion.js";

test("a failed registration still observes the original rejecting lifetime until it actually ends", async () => {
  let rejectLifetime;
  const lifetime = new Promise((_, reject) => { rejectLifetime = reject; });
  let finished = false;
  const observation = observeHostAttemptCompletion({ trackHostAttemptCompletion() { throw new Error("controlled registration failure"); } },
    { runId: "run", workUnitId: "unit", attemptId: "attempt", runtimeInstanceId: "runtime", fencingToken: "token" }, lifetime)
    .then(() => { finished = true; });
  await Promise.resolve();
  await Promise.resolve();
  // Ensure the failed assertion can never leak the controlled rejection.
  try { assert.equal(finished, false, "registration failure cannot end the actual observed lifetime"); }
  finally { rejectLifetime(new Error("controlled callback failure")); }
  await observation;
  assert.equal(finished, true);
});

test("resource cleanup follows durable completion and is never invoked on failed registration or commit", async () => {
  const source = { runId: "run", workUnitId: "unit", attemptId: "attempt", runtimeInstanceId: "runtime", fencingToken: "token" };
  for (const failure of [undefined, "registration", "commit"]) {
    let finish, released = false;
    const lifetime = new Promise(resolve => { finish = resolve; });
    const observation = observeHostAttemptCompletion({
      trackHostAttemptCompletion() {
        if (failure === "registration") throw new Error(failure);
        return lifetime.then(() => {
          if (failure === "commit") throw new Error(failure);
          return { source, drainedAt: "2026-10-15T00:00:00.000Z" };
        });
      }, releaseHostAttemptResources(actual) { assert.deepEqual(actual, source); released = true; },
    }, source, lifetime);
    await Promise.resolve();
    assert.equal(released, false);
    finish(); await observation;
    assert.equal(released, !failure);
  }
});

test("transient resource cleanup failure retries the exact durable source before completing observation", async () => {
  const source = { runId: "run", workUnitId: "unit", attemptId: "attempt", runtimeInstanceId: "runtime", fencingToken: "token" };
  let releases = 0;
  await observeHostAttemptCompletion({
    trackHostAttemptCompletion: async () => ({ source, drainedAt: "2026-10-15T00:00:00.000Z" }),
    releaseHostAttemptResources(actual) {
      assert.deepEqual(actual, source);
      if (++releases === 1) throw new Error("controlled transient release failure");
    },
  }, source, Promise.resolve());
  assert.equal(releases, 2);
});
