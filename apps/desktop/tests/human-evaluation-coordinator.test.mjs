import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import test from "node:test";
import { HumanEvaluationCoordinator } from "../dist/main/human-evaluation/coordinator.js";
import { signHumanEvaluationConfirmation } from "../dist/main/human-evaluation/daemon-client.js";
import { createHumanEvaluationWorkspaceScope } from "../dist/main/human-evaluation/workspace-scope.js";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const nowValue = Date.parse("2026-10-10T10:00:00Z");
const session = { osSessionId: "a".repeat(64), osUserId: "b".repeat(64), active: true, locked: false };
const request = { taskId: "task-qa", requestId: "request-qa", submission: { kind: "adjudicate", decision: { verdict: "pass", rationale: "reviewed" } } };
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };
function fixture(overrides = {}) {
  const calls = [], key = Buffer.alloc(32, 7).toString("base64url");
  let now = nowValue, reads = 0;
  const native = {
    async readSession() { reads++; return overrides.session ? overrides.session(reads) : session; },
    async confirm(input) {
      calls.push(["confirm", input]);
      if (overrides.confirm) return overrides.confirm(input);
      return { status: "confirmed", ...input, sessionBefore: session, sessionAfter: session };
    },
  };
  const daemon = {
    async handshake(input) { calls.push(["handshake", input]); return { workspaceCwd: input.workspaceCwd, confirmationKey: key,
      authority: { daemonEpoch: "daemon", desktopInstanceId: input.desktopInstanceId, desktopEpoch: input.desktopEpoch,
        connectionEpoch: "connection", osSessionId: input.session.osSessionId, osUserId: input.session.osUserId, lockEpoch: input.session.lockEpoch } }; },
    async intent(input) {
      calls.push(["intent", input]);
      const payload = { schemaVersion: 1, intentId: "intent-qa", requestId: input.requestId,
        taskId: input.taskId, canonicalWorkspaceCwd: "/qa", binding: input.authority,
        submission: input.submission, expiresAt: new Date(nowValue + 120_000).toISOString() };
      overrides.payload?.(payload);
      return { schemaVersion: 1, id: "intent-qa", payload, state: "pending",
        createdAt: new Date(nowValue).toISOString(), payloadDigest: createHash("sha256").update(JSON.stringify(payload)).digest("hex") };
    },
    async commit(input) { calls.push(["commit", input]); if (overrides.commit) return overrides.commit(input);
      return { event: { id: "event-qa" }, head: { revision: 1, state: "active" } }; },
    async revoke(authority) { calls.push(["revoke", authority]); await overrides.revoke?.(authority); },
    async snapshot(input) { calls.push(["snapshot", input]);
      return overrides.snapshot?.(input) ?? { events: [] }; },
    async list(input) { calls.push(["list", input]); return overrides.list?.(input) ?? { canonicalWorkspaceCwd: "/qa", items: [] }; },
    async report(input) { calls.push(["report", input]); return overrides.report?.(input) ?? {
      canonicalWorkspaceCwd: "/qa", report: { ref: { taskId: input.taskId, eventId: input.eventId, revision: input.revision } },
      head: { eventId: input.eventId, revision: input.revision, state: "active" }, currentness: "current" }; },
  };
  const coordinator = new HumanEvaluationCoordinator({ desktopInstanceId: "desktop", workspaceCwd: overrides.workspaceCwd ?? "/qa",
    displayWorkspaceCwd: overrides.displayWorkspaceCwd, scopeCurrent: overrides.scopeCurrent, native, daemon, now: () => now });
  return { coordinator, calls, key, setNow(value) { now = value; } };
}

test("native-bound confirmation signs exactly once and exposes no private authority or key", async () => {
  const f = fixture();
  assert.deepEqual(await f.coordinator.submit(request, () => true), { accepted: true, eventId: "event-qa", revision: 1, state: "active" });
  assert.deepEqual(f.calls.map(c => c[0]), ["handshake", "intent", "confirm", "commit", "revoke"]);
  const commit = f.calls.find(c => c[0] === "commit")[1];
  assert.equal(commit.signature, signHumanEvaluationConfirmation({ authority: commit.authority, confirmationKey: f.key }, commit.intentId, commit.confirmation));
  assert.equal("authenticated" in commit, false);
});

for (const mutation of ["task", "submission", "binding", "expiry"]) {
  test(`changed frozen ${mutation} never reaches native confirmation or commit`, async () => {
    const f = fixture({ payload(p) {
      if (mutation === "task") p.taskId = "other";
      if (mutation === "submission") p.submission = { kind: "revoke", revokesEventId: "other", rationale: "changed" };
      if (mutation === "binding") p.binding = { ...p.binding, lockEpoch: "other" };
      if (mutation === "expiry") p.expiresAt = new Date(nowValue - 1).toISOString();
    } });
    assert.equal((await f.coordinator.submit(request, () => true)).reason, "authority_changed");
    assert.equal(f.calls.filter(c => ["confirm", "commit"].includes(c[0])).length, 0);
  });
}

test("busy payloads do not share success and cancel holds busy until genuine native drain", async () => {
  const pending = deferred();
  const f = fixture({ confirm: () => pending.promise });
  const first = f.coordinator.submit(request, () => true);
  while (!f.calls.some(c => c[0] === "confirm")) await Promise.resolve();
  assert.equal((await f.coordinator.submit({ ...request, requestId: "second" }, () => true)).reason, "busy");
  assert.equal(f.coordinator.cancel("other").accepted, false);
  assert.equal(f.coordinator.cancel(request.requestId).accepted, true);
  assert.equal((await f.coordinator.submit({ ...request, requestId: "third" }, () => true)).reason, "busy");
  pending.resolve({ status: "confirmed", sessionBefore: session, sessionAfter: session });
  assert.equal((await first).reason, "cancelled");
  assert.equal(f.calls.filter(c => c[0] === "commit").length, 0);
});

for (const change of ["lock", "user", "epoch", "owner", "expiry"]) {
  test(`${change} while confirmation is open prevents commit`, async () => {
    let current = true;
    const f = fixture({ session(n) { return n === 3 && change === "user" ? { ...session, osUserId: "c".repeat(64) }
      : n === 3 && change === "lock" ? { ...session, locked: true } : session; }, async confirm(input) {
      if (change === "epoch") f.coordinator.invalidate();
      if (change === "owner") current = false;
      if (change === "expiry") f.setNow(nowValue + 120_001);
      return { ...input, status: "confirmed", sessionBefore: session, sessionAfter: session };
    } });
    assert.equal((await f.coordinator.submit(request, () => current)).accepted, false);
    assert.equal(f.calls.filter(c => c[0] === "commit").length, 0);
  });
}

test("lost commit response is unknown, not automatically resent", async () => {
  const f = fixture({ commit: () => { throw new Error("network lost after commit"); } });
  assert.equal((await f.coordinator.submit(request, () => true)).reason, "submission_unknown");
  assert.equal(f.calls.filter(c => c[0] === "commit").length, 1);
});

test("dispose waits for actual native drain and fences late success", async () => {
  const pending = deferred();
  const f = fixture({ confirm: () => pending.promise });
  const first = f.coordinator.submit(request, () => true);
  while (!f.calls.some(c => c[0] === "confirm")) await Promise.resolve();
  let disposed = false;
  const disposal = f.coordinator.dispose().then(() => { disposed = true; });
  await Promise.resolve(); assert.equal(disposed, false);
  pending.resolve({ status: "confirmed" });
  await first; await disposal;
  assert.equal(disposed, true);
  assert.equal((await f.coordinator.submit(request, () => true)).reason, "unauthorized_sender");
});

test("HMAC frozen wire bytes independent expected value", () => {
  const authority = { daemonEpoch: "d", desktopInstanceId: "i", desktopEpoch: "e", connectionEpoch: "c", osSessionId: "s", osUserId: "u", lockEpoch: "l" };
  const confirmation = { kind: "macos_device_owner_authentication", requestId: "r", payloadDigest: "a".repeat(64), confirmedAt: "time" };
  const key = Buffer.alloc(32, 5);
  const expected = createHmac("sha256", key).update(JSON.stringify(["ling.human-evaluation.confirmation.v1", "d", "i", "e", "c", "s", "u", "l", "intent", confirmation.kind, "r", "a".repeat(64), "time"])).digest("hex");
  assert.equal(signHumanEvaluationConfirmation({ authority, confirmationKey: key.toString("base64url") }, "intent", confirmation), expected);
});

test("unknown response is reconciled by exact private intent without another native confirmation or commit", async () => {
  const f = fixture({ commit: () => { throw new Error("lost"); }, snapshot: input => ({ events: [],
    intent: { id: input.intentId, state: "consumed", payload: { taskId: request.taskId } } }) });
  assert.equal((await f.coordinator.submit(request, () => true)).reason, "submission_unknown");
  const inspected = await f.coordinator.inspect({ taskId: request.taskId }, () => true);
  assert.equal(inspected.lastSubmission, "committed");
  assert.equal(f.calls.find(c => c[0] === "snapshot")[1].intentId, "intent-qa");
  assert.equal(f.calls.filter(c => c[0] === "confirm").length, 1);
  assert.equal(f.calls.filter(c => c[0] === "commit").length, 1);
});

for (const state of ["current", "corrected", "revoked", "missing"]) {
  test(`report binds immutable event/revision and observes ${state} without rewriting it`, async () => {
    const ref = Object.freeze({ taskId: request.taskId, eventId: "event-original", revision: 1 });
    const f = fixture({ snapshot: () => ({ events: [], reportCurrentness: state === "current" ? "current" : state === "missing" ? "unavailable" : "stale", ...(state !== "missing" ? {
      head: { taskId: request.taskId, eventId: state === "current" ? ref.eventId : "event-later",
        revision: state === "current" ? 1 : 2, state: state === "revoked" ? "revoked" : "active" } } : {}) }) });
    const result = await f.coordinator.inspect({ taskId: request.taskId, reportRef: ref }, () => true);
    assert.equal(result.reportCurrentness, state === "current" ? "current" : state === "missing" ? "unavailable" : "stale");
    assert.deepEqual(ref, { taskId: request.taskId, eventId: "event-original", revision: 1 });
    assert.equal(f.calls.filter(c => ["confirm", "commit"].includes(c[0])).length, 0);
  });
}

test("read-only inspect carries cursor and refuses lock/user drift", async () => {
  const f = fixture({ session(n) { return n === 2 ? { ...session, locked: true } : session; } });
  assert.equal((await f.coordinator.inspect({ taskId: request.taskId, afterRevision: 100 }, () => true)).reason, "authority_changed");
  assert.equal(f.calls.find(c => c[0] === "snapshot")[1].afterRevision, 100);
});

test("matching head alone cannot mark a report current when Host sealed lineage is unavailable", async () => {
  const ref = { taskId: request.taskId, eventId: "event", revision: 1 };
  const f = fixture({ snapshot: () => ({ events: [], head: { taskId: request.taskId, ...ref, state: "active" }, reportCurrentness: "unavailable" }) });
  assert.equal((await f.coordinator.inspect({ taskId: request.taskId, reportRef: ref }, () => true)).reportCurrentness, "unavailable");
  assert.deepEqual(f.calls.find(c => c[0] === "snapshot")[1].reportRef, ref);
  assert.equal(f.calls.some(c => c[0] === "report"), false);
});

test("lock during postcommit cleanup withholds success and preserves exact intent for read-only reconciliation", async () => {
  const cleanup = deferred();
  const f = fixture({ revoke: () => cleanup.promise, snapshot: input => ({ events: [],
    intent: { id: input.intentId, state: "consumed", payload: { taskId: request.taskId } } }) });
  const submitted = f.coordinator.submit(request, () => true);
  while (!f.calls.some(c => c[0] === "revoke")) await Promise.resolve();
  assert.equal(f.calls.filter(c => c[0] === "commit").length, 1);
  f.coordinator.invalidate();
  cleanup.resolve();
  assert.deepEqual(await submitted, { accepted: false, reason: "submission_unknown" });
  assert.equal((await f.coordinator.inspect({ taskId: request.taskId }, () => true)).lastSubmission, "committed");
  assert.equal(f.calls.filter(c => c[0] === "commit").length, 1);
});

test("readback invalidated during connection cleanup does not disclose a cached snapshot", async () => {
  const cleanup = deferred();
  const f = fixture({ revoke: () => cleanup.promise, snapshot: () => ({ events: [{ privateQa: "must-not-return" }] }) });
  const inspected = f.coordinator.inspect({ taskId: request.taskId }, () => true);
  while (!f.calls.some(c => c[0] === "revoke")) await Promise.resolve();
  f.coordinator.invalidate();
  cleanup.resolve();
  assert.deepEqual(await inspected, { accepted: false, reason: "authority_changed" });
});

for (const action of ["list", "generateReport"]) {
  const query = action === "list" ? { afterEnrollmentId: "enrollment", limit: 2 }
    : { taskId: request.taskId, eventId: "event-original", revision: 1 };
  test(`${action} uses fixed Host scope without native confirmation, mutation or implicit report refresh`, async () => {
    const f = fixture();
    const result = await f.coordinator[action](query, () => true);
    assert.equal(result.accepted, true); assert.equal(result.canonicalWorkspaceCwd, "/qa");
    assert.deepEqual(f.calls.map(c => c[0]), ["handshake", action === "list" ? "list" : "report", "revoke"]);
    const input = f.calls[1][1];
    for (const [key, value] of Object.entries(query)) assert.equal(input[key], value);
    assert.equal("confirmationKey" in result, false); assert.equal("authority" in result, false);
  });
  for (const drift of ["generation", "owner", "lock", "user"]) {
    test(`${action} fences ${drift} during cleanup before disclosing read-only data`, async () => {
      const cleanup = deferred(); let ownerCurrent = true, finalChanged = false;
      const f = fixture({ revoke: () => cleanup.promise,
        session(n) { return finalChanged && n === 3 ? { ...session,
          ...(drift === "lock" ? { locked: true } : drift === "user" ? { osUserId: "c".repeat(64) } : {}) } : session; } });
      const operation = f.coordinator[action](query, () => ownerCurrent);
      while (!f.calls.some(c => c[0] === "revoke")) await Promise.resolve();
      if (drift === "generation") f.coordinator.invalidate();
      if (drift === "owner") ownerCurrent = false;
      finalChanged = true; cleanup.resolve();
      assert.deepEqual(await operation, { accepted: false, reason: "authority_changed" });
    });
  }
  test(`${action} rejects a response from a different fixed workspace`, async () => {
    const f = fixture({ [action === "list" ? "list" : "report"]: () => ({ canonicalWorkspaceCwd: "/other", items: [] }) });
    assert.deepEqual(await f.coordinator[action](query, () => true), { accepted: false, reason: "authority_changed" });
    assert.equal(f.calls.at(-1)[0], "revoke");
  });
}

test("read-only lane remains busy until real read/cleanup drain; dispose fences the late page", async () => {
  const pending = deferred();
  const f = fixture({ list: () => pending.promise });
  const first = f.coordinator.list({}, () => true);
  while (!f.calls.some(c => c[0] === "list")) await Promise.resolve();
  assert.deepEqual(await f.coordinator.generateReport({ taskId: request.taskId, eventId: "event", revision: 1 }, () => true), { accepted: false, reason: "busy" });
  let disposed = false;
  const disposal = f.coordinator.dispose().then(() => { disposed = true; });
  await Promise.resolve(); assert.equal(disposed, false);
  pending.resolve({ canonicalWorkspaceCwd: "/qa", items: [] });
  assert.equal((await first).accepted, false); await disposal; assert.equal(disposed, true);
});

test("configured workspace alias binds one canonical profile and fails closed after retarget or removal", t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ling-human-scope-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const first = join(root, "first"), foreign = join(root, "foreign"), alias = join(root, "configured");
  mkdirSync(first); mkdirSync(foreign); symlinkSync(first, alias);
  const scope = createHumanEvaluationWorkspaceScope(alias);
  assert.equal(scope.workspaceCwd, alias); assert.equal(scope.canonicalWorkspaceCwd, first); assert.equal(scope.current(), true);
  unlinkSync(alias); symlinkSync(foreign, alias); assert.equal(scope.current(), false);
  unlinkSync(alias); assert.equal(scope.current(), false);
  assert.throws(() => createHumanEvaluationWorkspaceScope(alias));
});

for (const action of ["list", "generateReport", "inspect"]) {
  test(`${action} validates fixed scope before/after the read and never accepts an arbitrary alias`, async () => {
    let scopeCurrent = true;
    const query = action === "list" ? {} : action === "generateReport" ? { taskId: request.taskId, eventId: "event", revision: 1 } : { taskId: request.taskId };
    const f = fixture({ displayWorkspaceCwd: "/qa-configured-alias", scopeCurrent: () => scopeCurrent });
    const first = await f.coordinator[action](query, () => true);
    assert.equal(first.accepted, true);
    if (action !== "inspect") { assert.equal(first.workspaceCwd, "/qa-configured-alias"); assert.equal(first.canonicalWorkspaceCwd, "/qa"); }
    scopeCurrent = false;
    const before = f.calls.length;
    assert.deepEqual(await f.coordinator[action](query, () => true), { accepted: false, reason: "authority_changed" });
    assert.equal(f.calls.length, before);
    const cleanup = deferred(); scopeCurrent = true;
    const pendingFixture = fixture({ scopeCurrent: () => scopeCurrent, revoke: () => cleanup.promise });
    const pending = pendingFixture.coordinator[action](query, () => true);
    while (!pendingFixture.calls.some(c => c[0] === "revoke")) await Promise.resolve();
    scopeCurrent = false; cleanup.resolve();
    assert.deepEqual(await pending, { accepted: false, reason: "authority_changed" });
  });
}
