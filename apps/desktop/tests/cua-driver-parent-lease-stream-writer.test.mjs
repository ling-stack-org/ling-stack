import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

import { CuaDriverAtomicPublishError } from "../scripts/cua-driver-package-atomic-publish.mjs";
import { createNativeParentLeaseStreamWriter } from "../scripts/cua-driver-parent-lease-stream-writer.mjs";
import {
  ControlledLeaseWritable,
  deferred,
  nextEventLoopTurn,
} from "./support/cua-driver-controlled-lease-streams.mjs";

for (const end of [false, true]) {
  test(`C001 deterministic ${end ? "end" : "write"}: callback(error) then error preserves cause and waits for drain`, async () => {
    const fixture = createFixture();
    const cause = Object.assign(new Error("controlled broken pipe"), { code: "EPIPE" });
    const pending = fixture.writer.write("frame\n", { end });
    const rejection = assert.rejects(pending, error => {
      assertFailure(error, cause);
      return true;
    });
    let settlements = 0;
    void pending.then(() => { settlements += 1; }, () => { settlements += 1; });
    const request = await fixture.stream.nextWrite();
    request.complete(cause);
    await nextEventLoopTurn();
    assert.equal(fixture.failures.length, 1);
    assert.equal(fixture.stream.listenerCount("error"), 1,
      "callback failure must not remove the listener before the following error event");
    assert.equal(settlements, 0, "typed reject must await authority drain");
    fixture.stream.emit("error", new Error("duplicate stream error"));
    assert.equal(fixture.failures.length, 1, "the first failure is authoritative");
    fixture.drain.resolve();
    await rejection;
    await nextEventLoopTurn();
    assert.equal(settlements, 1);
    const closed = once(fixture.stream, "close");
    fixture.writer.disposeAfterTermination();
    await closed;
    assert.equal(fixture.stream.listenerCount("error"), 0);
  });
}

test("C001 deterministic synchronous write throw rejects once with its original cause", async () => {
  const fixture = createFixture();
  const cause = new Error("controlled synchronous throw");
  fixture.stream.write = () => { throw cause; };
  const rejected = assert.rejects(fixture.writer.write("frame"), error => {
    assertFailure(error, cause);
    return true;
  });
  assert.equal(fixture.failures.length, 1);
  fixture.stream.emit("error", new Error("error after synchronous throw"));
  fixture.drain.resolve();
  await rejected;
  fixture.writer.disposeAfterTermination();
});

test("C001 deterministic close before completion fails instead of resolving a late callback", async () => {
  const fixture = createFixture();
  const pending = fixture.writer.write("frame");
  const rejected = assert.rejects(pending, error => {
    assertFailure(error);
    assert.equal(error.cause.code, "ERR_STREAM_PREMATURE_CLOSE");
    return true;
  });
  const request = await fixture.stream.nextWrite();
  fixture.stream.emit("close");
  request.complete();
  fixture.drain.resolve();
  await rejected;
  assert.equal(fixture.failures.length, 1);
  assert.equal(fixture.stream.listenerCount("error"), 0);
});

test("C001 deterministic idle error invalidates a previously successful writer and prevents future writes", async () => {
  const fixture = createFixture();
  const first = fixture.writer.write("first");
  (await fixture.stream.nextWrite()).complete();
  await first;
  const cause = new Error("idle stdin failure");
  fixture.stream.emit("error", cause);
  const rejected = assert.rejects(fixture.writer.write("never sent"), error => {
    assertFailure(error, cause);
    return true;
  });
  assert.equal(fixture.stream.requests.length, 0);
  fixture.drain.resolve();
  await rejected;
  fixture.writer.disposeAfterTermination();
});

test("C001 deterministic two pending frames share a single failure/drain and never fulfill", async () => {
  const fixture = createFixture();
  const cause = new Error("first frame failed");
  const outcomes = Promise.allSettled([
    fixture.writer.write("first"),
    fixture.writer.write("second"),
  ]);
  (await fixture.stream.nextWrite()).complete(cause);
  await nextEventLoopTurn();
  assert.equal(fixture.failures.length, 1);
  fixture.drain.resolve();
  const results = await outcomes;
  assert.deepEqual(results.map(result => result.status), ["rejected", "rejected"]);
  assert.equal(results[0].reason, results[1].reason);
  assertFailure(results[0].reason, cause);
  fixture.writer.disposeAfterTermination();
});

test("C001 deterministic successful write/end controls keep listener through termination, then clean up", async () => {
  const fixture = createFixture();
  const first = fixture.writer.write("first\n");
  (await fixture.stream.nextWrite()).complete();
  await first;
  const last = fixture.writer.write("release\n", { end: true });
  (await fixture.stream.nextWrite()).complete();
  await last;
  assert.equal(fixture.failures.length, 0);
  assert.equal(fixture.stream.listenerCount("error"), 1);
  const closed = once(fixture.stream, "close");
  fixture.writer.disposeAfterTermination();
  await closed;
  fixture.writer.disposeAfterTermination();
  assert.equal(fixture.stream.destroyCalls, 1);
  assert.equal(fixture.stream.listenerCount("error"), 0);
});

function createFixture() {
  const stream = new ControlledLeaseWritable();
  const drain = deferred();
  const failures = [];
  const writer = createNativeParentLeaseStreamWriter({
    stream,
    createFailure: cause => new CuaDriverAtomicPublishError(
      "staging_parent_lock_protocol_invalid",
      "controlled native parent lease frame failure",
      { cause, outcome: "ambiguous" },
    ),
    onFailure: error => { failures.push(error); return drain.promise; },
  });
  return { stream, drain, failures, writer };
}

function assertFailure(error, cause) {
  assert.ok(error instanceof CuaDriverAtomicPublishError);
  assert.equal(error.code, "staging_parent_lock_protocol_invalid");
  assert.equal(error.outcome, "ambiguous");
  if (cause !== undefined) assert.equal(error.cause, cause);
}
