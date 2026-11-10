import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as nextTick } from "node:timers/promises";
import { AttemptExecutorGroup } from "../dist/runtime/attempt-execution-quiescence.js";

const source = Object.freeze({ runId: "run_original", workUnitId: "work_original", attemptId: "attempt_original",
  runtimeInstanceId: "runtime_original", fencingToken: "900719925474099312345" });
const request = Object.freeze({ kind: "user_input_required", requestId: "request_original", requestVersion: 1 });
const settledAt = "2026-10-03T01:00:00.000Z";

function fixture(input = {}) {
  const verified = new Set();
  const unknowns = [];
  const checks = [];
  const group = new AttemptExecutorGroup({ source: { ...source },
    isCurrentExecutionOwner: captured => { checks.push(captured); return input.current?.() ?? true; },
    verifySettlement: (ticket, proof) => input.verify?.(ticket, proof) ?? verified.has(proof.evidenceRef),
    persistBlockedOperation: blocker => { unknowns.push(blocker); return input.persist?.(blocker) ?? true; } });
  function proof(ticket, kind = "known_no_start", extra = {}) {
    const value = { schemaVersion: 1, source: { ...source }, operationId: ticket.id, kind,
      evidenceRef: `evidence_${ticket.id}_${kind}`, settledAt,
      ...(kind === "known_no_start" || kind === "unknown_outcome" ? {} : { physicalScope: "entire_operation", effects: "persisted" }),
      ...(kind === "unknown_outcome" ? { code: "descendants_unverified" } : {}), ...extra };
    verified.add(value.evidenceRef);
    return value;
  }
  return { group, proof, verified, unknowns, checks };
}

test("captures an immutable full source without numeric fencing-token coercion", () => {
  const mutableSource = { ...source };
  const group = new AttemptExecutorGroup({ source: mutableSource, isCurrentExecutionOwner: () => true,
    verifySettlement: () => true, persistBlockedOperation: () => true });
  mutableSource.attemptId = "successor";
  mutableSource.fencingToken = "1";
  assert.deepEqual(group.source, source);
  assert.equal(Object.isFrozen(group.source), true);
  const ticket = group.beginHostCall("command", "call_1");
  assert.equal(Object.isFrozen(ticket), true);
  assert.deepEqual(ticket.source, source);
});

for (const missing of ["runId", "workUnitId", "attemptId", "runtimeInstanceId", "fencingToken"]) {
  test(`rejects construction without captured ${missing}`, () => {
    const incomplete = { ...source }; delete incomplete[missing];
    assert.throws(() => new AttemptExecutorGroup({ source: incomplete, isCurrentExecutionOwner: () => true,
      verifySettlement: () => true, persistBlockedOperation: () => true }), /invalid.*source/i);
  });
}

test("begin is synchronous and fails closed on stale owner or an asynchronous owner predicate", () => {
  const stale = fixture({ current: () => false });
  assert.equal(stale.group.isAdmissionOpen(), false);
  assert.throws(() => stale.group.assertAdmissionOpen(), /stale.*owner/i);
  assert.throws(() => stale.group.beginHostCall("command", "call_1"), /stale.*owner/i);
  assert.equal(stale.group.getSnapshot().operations.length, 0);
  const asynchronous = fixture({ current: () => Promise.resolve(true) });
  assert.throws(() => asynchronous.group.beginHostCall("command", "call_1"), /stale.*owner/i);
});

test("closing admission synchronously rejects prepared and new dispatches", () => {
  const { group } = fixture();
  const prepared = group.beginHostCall("command", "prepared");
  assert.equal(group.isAdmissionOpen(), true);
  group.assertAdmissionOpen();
  group.closeAdmission(request);
  assert.equal(group.isAdmissionOpen(), false);
  assert.throws(() => group.assertAdmissionOpen(), /admission.*closed/i);
  let launched = false;
  assert.throws(() => group.launchHostEffect(prepared, () => { launched = true; }), /admission.*closed/i);
  assert.throws(() => group.beginHostCall("mcp", "later"), /admission.*closed/i);
  assert.equal(launched, false);
  assert.equal(group.getSnapshot().operations.length, 1);
});

test("close is strictly idempotent, retains its copied identity and cannot be retargeted", () => {
  const { group } = fixture();
  const mutable = { ...request };
  group.closeAdmission(mutable); mutable.requestId = "other";
  group.closeAdmission({ ...request });
  assert.deepEqual(group.getSnapshot().requiredInput, request);
  assert.throws(() => group.closeAdmission({ ...request, requestVersion: 2 }), /different.*request/i);
  assert.throws(() => group.closeAdmission({ ...request, extra: true }), /invalid.*request/i);
});

test("launch rechecks the original fence after awaits and never borrows successor authority", async () => {
  let current = true;
  const { group, checks } = fixture({ current: () => current });
  const ticket = group.beginHostCall("file_mutation", "call_1");
  await nextTick(); current = false;
  let launched = false;
  assert.throws(() => group.launchHostEffect(ticket, () => { launched = true; }), /stale.*owner/i);
  assert.equal(launched, false);
  assert.equal(checks.length, 2);
  for (const checked of checks) assert.deepEqual(checked, source);
});

test("a predicate that closes admission cannot launch reentrantly", () => {
  let closeOnCheck = false;
  let group;
  ({ group } = fixture({ current: () => { if (closeOnCheck) group.closeAdmission(request); return true; } }));
  const ticket = group.beginHostCall("command", "call_1"); closeOnCheck = true;
  assert.throws(() => group.launchHostEffect(ticket, () => assert.fail("must not launch")), /admission.*closed/i);
});

test("tickets cannot be cloned, forged or imported from a sibling attempt group", () => {
  const { group, proof } = fixture();
  const ticket = group.beginHostCall("command", "call_1");
  const other = fixture().group.beginHostCall("command", "call_1");
  for (const fake of [{ ...ticket }, Object.create(ticket), other, undefined]) {
    assert.throws(() => group.assertMayLaunch(fake), /invalid.*ticket/i);
    assert.throws(() => group.settleHostCall(fake, proof(ticket)), /invalid.*ticket/i);
    assert.throws(() => group.registerProducer(fake, "media", "job_1"), /invalid.*ticket/i);
  }
});

test("duplicate identities cannot silently acquire a second execution ticket", () => {
  const { group } = fixture();
  const first = group.beginHostCall("command", "call_1");
  assert.throws(() => group.beginHostCall("command", "call_1"), /duplicate.*operation/i);
  group.registerProducer(first, "media", "job_1");
  assert.throws(() => group.registerProducer(first, "media", "job_1"), /duplicate.*operation/i);
  assert.equal(group.getSnapshot().operations.length, 2);
});

test("synchronously registered descendants remain in the closed barrier after parent settlement", async () => {
  const { group, proof } = fixture();
  const parent = group.beginHostCall("media", "call_media");
  const child = group.registerProducer(parent, "media", "job_1");
  group.launchHostEffect(parent, () => {});
  group.launchHostEffect(child, () => {});
  group.closeAdmission(request);
  group.settleHostCall(parent, proof(parent, "completed_persisted"));
  const observed = await group.observeDrain(0);
  assert.equal(observed.status, "blocked");
  assert.deepEqual(observed.blockers.map(item => item.operationId), [child.id]);
  group.settleHostCall(child, proof(child, "completed_persisted"));
  assert.equal((await group.drain()).status, "settled");
});

test("late producer registration cannot escape either closure or a settled parent", () => {
  const { group, proof } = fixture();
  const parent = group.beginHostCall("media", "call_media");
  group.closeAdmission(request);
  assert.throws(() => group.registerProducer(parent, "media", "late_job"), /admission.*closed/i);
  group.settleHostCall(parent, proof(parent));
  const other = fixture(); const finished = other.group.beginHostCall("media", "call_other");
  other.group.settleHostCall(finished, other.proof(finished));
  assert.throws(() => other.group.registerProducer(finished, "media", "late_job"), /settled.*operation/i);
});

test("a callback resolve, reject or abort never settles physical execution automatically", async () => {
  const { group } = fixture();
  const resolved = group.beginHostCall("command", "resolved");
  const rejected = group.beginHostCall("mcp", "rejected");
  await group.launchHostEffect(resolved, () => Promise.resolve("callback done"));
  await assert.rejects(group.launchHostEffect(rejected, () => Promise.reject(new Error("callback error"))), /callback error/);
  group.closeAdmission(request);
  const drain = await group.observeDrain(0);
  assert.equal(drain.status, "blocked");
  assert.equal(drain.blockers.length, 2);
  assert.equal(drain.reason, "observation_timeout");
});

test("a synchronous launch exception does not prove no effect or release its ticket", async () => {
  const { group, proof } = fixture();
  const ticket = group.beginHostCall("command", "throwing");
  assert.throws(() => group.launchHostEffect(ticket, () => { throw new Error("observer failed"); }), /observer failed/);
  group.closeAdmission(request);
  assert.throws(() => group.settleHostCall(ticket, proof(ticket)), /launch.*no.start/i);
  assert.equal((await group.observeDrain(0)).status, "blocked");
});

for (const kind of ["known_no_start", "completed_persisted", "confirmed_stop"]) {
  test(`accepts only Host-verified ${kind} facts for the exact ticket and source`, async () => {
    const { group, proof } = fixture();
    const ticket = group.beginHostCall("command", "call_1");
    if (kind !== "known_no_start") group.launchHostEffect(ticket, () => {});
    group.closeAdmission(request);
    group.settleHostCall(ticket, proof(ticket, kind));
    const drain = await group.drain();
    assert.equal(drain.status, "settled");
    assert.deepEqual(drain.source, source);
    assert.equal(drain.operations.length, 1);
    assert.equal(Object.isFrozen(drain.operations), true);
  });
}

test("unverified and cross-fence evidence cannot satisfy settlement", async () => {
  const { group, proof, verified } = fixture();
  const ticket = group.beginHostCall("command", "call_1");
  group.closeAdmission(request);
  const unverified = proof(ticket, "known_no_start", { evidenceRef: "not_saved" });
  verified.delete(unverified.evidenceRef);
  assert.throws(() => group.settleHostCall(ticket, unverified), /unverified.*settlement/i);
  for (const key of Object.keys(source)) {
    assert.throws(() => group.settleHostCall(ticket, proof(ticket, "known_no_start", { source: { ...source, [key]: "successor" } })),
      /settlement.*source/i);
  }
  assert.throws(() => group.settleHostCall(ticket, proof(ticket, "known_no_start", { operationId: "other_ticket" })), /settlement.*operation/i);
  assert.equal((await group.observeDrain(0)).status, "blocked");
});

test("leader exit, transport close and unsupported scope are not whole-operation proofs", () => {
  const { group, proof } = fixture();
  const ticket = group.beginHostCall("command", "call_1");
  group.launchHostEffect(ticket, () => {});
  for (const physicalScope of ["leader", "stdio", "transport_closed", "descendants_unverified", undefined]) {
    assert.throws(() => group.settleHostCall(ticket, proof(ticket, "completed_persisted", { physicalScope })), /invalid.*settlement/i);
  }
  for (const effects of ["unpersisted", "unknown", undefined]) {
    assert.throws(() => group.settleHostCall(ticket, proof(ticket, "confirmed_stop", { effects })), /invalid.*settlement/i);
  }
});

test("malformed proof and accessor values do not invoke the Host verifier", () => {
  let checked = 0;
  const { group, proof } = fixture({ verify: () => { checked++; return true; } });
  const ticket = group.beginHostCall("mcp", "call_1");
  for (const invalid of [null, {}, { ...proof(ticket), kind: "callback_resolved" }, { ...proof(ticket), settledAt: "bad" },
    { ...proof(ticket), extra: "not_in_schema" }, { ...proof(ticket), get evidenceRef() { assert.fail("must not evaluate getter"); } }]) {
    assert.throws(() => group.settleHostCall(ticket, invalid), /invalid.*settlement/i);
  }
  assert.equal(checked, 0);
});

test("settlement is immutable and strictly idempotent, with no different-proof upgrade", async () => {
  let checks = 0;
  const { group, proof } = fixture({ verify: () => { checks++; return true; } });
  const ticket = group.beginHostCall("command", "call_1");
  const original = proof(ticket);
  group.closeAdmission(request);
  group.settleHostCall(ticket, original);
  group.settleHostCall(ticket, structuredClone(original));
  assert.equal(checks, 1);
  original.evidenceRef = "changed_after_settlement";
  assert.equal((await group.drain()).operations[0].settlement.evidenceRef.includes("known_no_start"), true);
  assert.throws(() => group.settleHostCall(ticket, original), /different.*settlement/i);
  assert.throws(() => group.launchHostEffect(ticket, () => assert.fail("settled operation")), /settled.*operation/i);
});

test("unknown is durably recorded and stays blocked rather than becoming a safe terminal", async () => {
  const { group, proof, unknowns } = fixture();
  const ticket = group.beginHostCall("mcp", "remote");
  group.launchHostEffect(ticket, () => {});
  group.closeAdmission(request);
  const unknown = proof(ticket, "unknown_outcome", { code: "remote_stop_unconfirmed" });
  group.settleHostCall(ticket, unknown);
  group.settleHostCall(ticket, structuredClone(unknown));
  assert.equal(unknowns.length, 1);
  assert.deepEqual(unknowns[0].source, source);
  const drain = await group.drain();
  assert.equal(drain.status, "blocked");
  assert.equal(drain.reason, "unknown_outcome");
  assert.equal(drain.blockers[0].durablyRecorded, true);
  assert.throws(() => group.settleHostCall(ticket, proof(ticket, "confirmed_stop")), /different.*settlement/i);
});

test("failed unknown persistence retains the blocker and only an exact retry can record it", async () => {
  let persisted = false;
  const { group, proof, unknowns } = fixture({ persist: () => persisted });
  const ticket = group.beginHostCall("media", "call_1");
  group.closeAdmission(request);
  const unknown = proof(ticket, "unknown_outcome");
  assert.throws(() => group.settleHostCall(ticket, unknown), /blocked.*persistence/i);
  const blocked = await group.drain();
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.blockers[0].durablyRecorded, false);
  persisted = true; group.settleHostCall(ticket, structuredClone(unknown));
  assert.equal((await group.drain()).blockers[0].durablyRecorded, true);
  assert.equal(unknowns.length, 2);
});

test("asynchronous verifier and persistence hooks fail closed", async () => {
  const asynchronousVerifier = fixture({ verify: () => Promise.resolve(true) });
  const ticket = asynchronousVerifier.group.beginHostCall("command", "call_1");
  assert.throws(() => asynchronousVerifier.group.settleHostCall(ticket, asynchronousVerifier.proof(ticket)), /unverified.*settlement/i);
  const asynchronousPersistence = fixture({ persist: () => Promise.resolve(true) });
  const remote = asynchronousPersistence.group.beginHostCall("mcp", "remote");
  asynchronousPersistence.group.closeAdmission(request);
  assert.throws(() => asynchronousPersistence.group.settleHostCall(remote, asynchronousPersistence.proof(remote, "unknown_outcome")),
    /blocked.*persistence/i);
  assert.equal((await asynchronousPersistence.group.drain()).status, "blocked");
});

test("unbounded drain waits only for this attempt, not for callback completion or sibling groups", async () => {
  const { group, proof } = fixture();
  const ticket = group.beginHostCall("command", "call_1");
  const sibling = fixture(); sibling.group.beginHostCall("command", "sibling");
  group.closeAdmission(request);
  let drained = false;
  const waiting = group.drain().then(result => { drained = true; return result; });
  await nextTick(); assert.equal(drained, false);
  group.settleHostCall(ticket, proof(ticket));
  assert.equal((await waiting).status, "settled");
  assert.equal(sibling.group.getSnapshot().operations[0].state, "admitted");
});

test("bounded observation never cancels or removes an admitted producer and later drain still waits", async () => {
  const { group, proof } = fixture();
  const parent = group.beginHostCall("media", "call_1");
  const producer = group.registerProducer(parent, "media", "job_1");
  group.closeAdmission(request);
  group.settleHostCall(parent, proof(parent));
  const timed = await group.observeDrain(5);
  assert.equal(timed.status, "blocked");
  assert.equal(timed.blockers[0].operationId, producer.id);
  assert.equal(group.getSnapshot().operations.length, 2);
  let stopped = false;
  const pending = group.drain().then(result => { stopped = true; return result; });
  await nextTick(); assert.equal(stopped, false);
  group.settleHostCall(producer, proof(producer));
  assert.equal((await pending).status, "settled");
});

test("multiple observers settle consistently and timeout does not own executor lifecycle", async () => {
  const { group, proof } = fixture();
  const ticket = group.beginHostCall("command", "call_1"); group.closeAdmission(request);
  const first = group.drain(); const second = group.observeDrain(1000);
  assert.equal((await group.observeDrain(0)).status, "blocked");
  group.settleHostCall(ticket, proof(ticket));
  assert.deepEqual(await first, await second);
});

test("drain requires a closed barrier and validates timer bounds", async () => {
  const { group } = fixture();
  await assert.rejects(group.drain(), /admission.*open/i);
  group.closeAdmission(request);
  for (const timeout of [-1, NaN, Infinity, 2147483648]) await assert.rejects(group.observeDrain(timeout), /timeout/i);
  assert.equal((await group.drain()).status, "settled");
});

test("settlement verification cannot reenter launch or create descendants for the settling ticket", () => {
  let group;
  let root;
  ({ group } = fixture({ verify: () => {
    assert.throws(() => group.launchHostEffect(root, () => assert.fail("must not launch")), /settlement.*progress/i);
    assert.throws(() => group.registerProducer(root, "media", "late"), /settlement.*progress/i);
    return true;
  } }));
  root = group.beginHostCall("command", "call_1");
  group.settleHostCall(root, { schemaVersion: 1, source, operationId: root.id, kind: "known_no_start",
    evidenceRef: "durable_fact", settledAt });
});
