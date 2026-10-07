import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { captureNativeCommandInput } from "../dist/runtime/sandbox/native-input-capture.js";

function fixture(t, helperPath = "/usr/bin/true") {
  const path = realpathSync(helperPath);
  const originalSpawn = childProcess.spawn;
  let child, closed = false;
  const patch = t.mock.method(childProcess, "spawn", (...args) => {
    child = originalSpawn(...args);
    child.once("close", () => { closed = true; });
    return child;
  });
  syncBuiltinESMExports();
  t.after(async () => {
    patch.mock.restore();
    syncBuiltinESMExports();
    if (child && !closed) {
      child.kill("SIGKILL");
      await Promise.race([new Promise(resolve => child.once("close", resolve)), delay(1500)]);
    }
  });
  return {
    child: () => child, closed: () => closed,
    options: {
      helper: { path, sha256: createHash("sha256").update(readFileSync(path)).digest("hex"), version: "post-spawn-test" },
      root: realpathSync("/private/tmp"), path: "input", maxBytes: 1,
      identity: { runId: "capture-run", workspaceId: "capture-workspace", workUnitId: "capture-work",
        attemptId: "capture-attempt", runtimeInstanceId: "capture-runtime", fencingToken: "capture-token" },
      assertCurrentAuthority() {},
    },
  };
}

for (const denyCleanup of [false, true]) {
  test(`post-spawn writer failure observes the actual helper close; cleanup denied=${denyCleanup}`,
    { skip: process.platform !== "darwin" }, async t => {
      const f = fixture(t);
      const failure = new Error("post-spawn COMMIT failed");
      let sends = 0;
      await assert.rejects(captureNativeCommandInput({ ...f.options, effectGuard: {
        launch(effect) {
          if (f.child()) sends++;
          effect();
          throw failure;
        },
        cleanup(effect) {
          if (denyCleanup) throw new Error("original owner replaced");
          return effect();
        },
      } }), error => error === failure);
      assert.ok(f.child(), "the regression must cross a real OS spawn, not a no-start fixture");
      assert.equal(f.closed(), true, "capture cannot return before close when the actual finite helper can be observed");
      assert.equal(sends, 0, "a failed launch must not send the framed request");
      assert.equal(f.child().stdout.listenerCount("data"), 0, "local writer observers are detached at completion");
    });
}

test("rejected pre-spawn admission does not spawn or invoke cleanup", { skip: process.platform !== "darwin" }, async t => {
  const f = fixture(t);
  const failure = new Error("admission closed");
  await assert.rejects(captureNativeCommandInput({ ...f.options, effectGuard: {
    launch() { throw failure; }, cleanup() { assert.fail("nothing was launched"); },
  } }), error => error === failure);
  assert.equal(f.child(), undefined);
});

test("a synchronous kill error cannot reenter cleanup or replace the original failure",
  { skip: process.platform !== "darwin" }, async t => {
    const f = fixture(t);
    const failure = new Error("post-spawn COMMIT failed");
    let cleanupCalls = 0, killCalls = 0;
    await assert.rejects(captureNativeCommandInput({ ...f.options, effectGuard: {
      launch(effect) {
        effect();
        t.mock.method(f.child(), "kill", () => {
          killCalls++;
          f.child().emit("error", Object.assign(new Error("kill EPERM"), { code: "EPERM" }));
          return false;
        });
        throw failure;
      },
      cleanup(effect) {
        cleanupCalls++;
        assert.equal(cleanupCalls, 1, "one captured cleanup attempt, even on synchronous error emission");
        return effect();
      },
    } }), error => error === failure);
    assert.equal(cleanupCalls, 1);
    assert.equal(killCalls, 1);
    assert.equal(f.closed(), true, "natural helper close remains observable when kill returns false");
  });

test("bounded helper observation preserves failure without claiming a live helper stopped",
  { skip: process.platform !== "darwin" }, async t => {
    const f = fixture(t, "/usr/bin/yes");
    const failure = new Error("post-spawn COMMIT failed");
    await assert.rejects(captureNativeCommandInput({ ...f.options, effectGuard: {
      launch(effect) { effect(); throw failure; },
      cleanup() { throw new Error("captured cleanup authority rejected"); },
    } }), error => error === failure);
    assert.ok(f.child().pid);
    assert.equal(f.closed(), false);
    assert.equal(f.child().exitCode, null, "an observer deadline is not a physical stop receipt");
    assert.equal(f.child().stdout.listenerCount("data"), 0);
  });
