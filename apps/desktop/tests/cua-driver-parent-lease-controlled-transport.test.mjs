import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  atomicPublishDirectoryNoReplace,
  CuaDriverAtomicPublishError,
  withAtomicPublishParentLeaseChildForTest,
} from "../scripts/cua-driver-package-atomic-publish.mjs";
import {
  ControlledLeaseChild,
  deferred,
  nextEventLoopTurn,
} from "./support/cua-driver-controlled-lease-streams.mjs";

for (const release of [false, true]) {
  test(`C001 controlled real capability ${release ? "release/end" : "CALL/write"} failure invalidates and drains before rejecting`, async (t) => {
    const fixture = await createFixture(t);
    const cause = Object.assign(new Error("controlled capability EPIPE"), { code: "EPIPE" });
    let publicLease;
    let settled = false;
    const running = fixture.withLease(async (lease) => {
      publicLease = lease;
      return release ? "operation returned before release" : fixture.publish(lease);
    });
    const rejected = assert.rejects(running, error => {
      assertFailure(error, cause);
      return true;
    });
    void running.then(() => { settled = true; }, () => { settled = true; });
    const request = await fixture.child.stdin.nextWrite();
    assert.match(request.frame, release ? /\trelease\t/ : /\tcall\t/);
    request.complete(cause);
    await nextEventLoopTurn();
    assert.equal(publicLease.signal.aborted, true, "real capability must be invalidated immediately");
    assert.deepEqual(fixture.child.killCalls, ["SIGKILL"]);
    assert.equal(settled, false, "termination was requested, not confirmed");
    assert.throws(publicLease.assertHeld, error => {
      assertFailure(error, cause);
      return true;
    });
    await assert.rejects(fixture.publish(publicLease), error => {
      assert.equal(error.code, "staging_parent_lock_capability_required");
      return true;
    });
    fixture.child.stdin.emit("error", new Error("duplicate late stdin error"));
    assert.deepEqual(fixture.child.killCalls, ["SIGKILL"]);
    fixture.child.finishExit();
    await rejected;
    await nextEventLoopTurn();
    assert.equal(fixture.child.stdin.closed, true);
    assert.equal(fixture.child.stdin.listenerCount("error"), 0);
    assert.equal(fixture.child.stdin.destroyCalls, 1);
    assert.equal(fixture.child.stdin.requests.length, 0, "invalid capability cannot issue another frame");
  });
}

test("C001 controlled idle stdin error cannot bypass holder drain through guard/release", async (t) => {
  const fixture = await createFixture(t);
  const entered = deferred();
  const finishOperation = deferred();
  const cause = new Error("controlled idle stream failure");
  let settled = false;
  const running = fixture.withLease(async (lease) => {
    entered.resolve(lease);
    await finishOperation.promise;
    return "narrative only";
  });
  const rejected = assert.rejects(running, error => {
    assertFailure(error, cause);
    return true;
  });
  void running.then(() => { settled = true; }, () => { settled = true; });
  const lease = await entered.promise;
  fixture.child.stdin.emit("error", cause);
  await nextEventLoopTurn();
  assert.equal(lease.signal.aborted, true);
  finishOperation.resolve();
  await nextEventLoopTurn();
  assert.equal(settled, false, "guard must await both operation and holder termination");
  assert.deepEqual(fixture.child.killCalls, ["SIGKILL"]);
  fixture.child.finishExit();
  await rejected;
  assert.equal(fixture.child.stdin.requests.length, 0);
});

test("C001 controlled real capability normal CALL plus release stays successful", async (t) => {
  const fixture = await createFixture(t);
  const running = fixture.withLease(lease => fixture.publish(lease));
  const call = await fixture.child.stdin.nextWrite();
  fixture.child.receipt(call, "committed");
  call.complete();
  const release = await fixture.child.stdin.nextWrite();
  assert.match(release.frame, /\trelease\t/);
  fixture.child.receipt(release, "released");
  release.complete();
  await nextEventLoopTurn();
  fixture.child.finishExit({ code: 0, signal: null });
  const result = await running;
  assert.equal(result.outcome, "committed");
  assert.equal(result.operationOwnerPid, fixture.child.pid);
  assert.deepEqual(fixture.child.killCalls, []);
  await nextEventLoopTurn();
  assert.equal(fixture.child.stdin.listenerCount("error"), 0);
});

async function createFixture(t) {
  const parentRoot = await mkdtemp(join(await realpath(tmpdir()), "ling-c001-controlled-"));
  const child = new ControlledLeaseChild();
  t.after(async () => {
    child.finishExit();
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
    await rm(parentRoot, { recursive: true, force: true });
  });
  return {
    child,
    withLease: operation => withAtomicPublishParentLeaseChildForTest({
      parentRoot, child, timeoutMs: 500, operationTimeoutMs: 500,
    }, operation),
    publish: lease => atomicPublishDirectoryNoReplace({
      parentRoot,
      sourceName: "source",
      destinationName: "destination",
      expectedParentIdentity: "1:1",
      expectedSourceIdentity: "1:2",
    }, lease),
  };
}

function assertFailure(error, cause) {
  assert.ok(error instanceof CuaDriverAtomicPublishError);
  assert.equal(error.code, "staging_parent_lock_protocol_invalid");
  assert.equal(error.outcome, "ambiguous");
  assert.equal(error.cause, cause);
}
