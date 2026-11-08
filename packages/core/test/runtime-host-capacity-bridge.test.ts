import assert from "node:assert/strict";
import test from "node:test";
import type { HostRunCapacityReservation } from "../dist/host-run-capacity-types.js";
import { hostCapacityFixture, hostCapacityWorkspace, realNow } from "./support/runtime-host-capacity-fixture.ts";
import { testDatabase } from "./support/sqlite-test-database.ts";

for (const window of ["intent", "host-reservation", "workspace-receipt"]) {
  test(`reopening after ${window} recovers the original intent without consuming a dispatch gate`, async t => {
    const host = hostCapacityFixture(t), f = await hostCapacityWorkspace(t, host), current = f.prepare(window);
    const record = f.intent(current);
    if (window !== "intent") {
      const reserved = host.host.reserve({ intent: record.intent, now: f.at(3) });
      assert.equal(reserved.status, "reserved");
      if (window === "workspace-receipt") assert.equal(f.journal.attachReservation({ intentId: record.intent.intentId,
        reservation: reserved.reservation, now: f.at(4) }).status, "attached");
    }
    host.reopen();
    f.reopen();
    if (window === "intent") {
      assert.equal(f.bridge.observeReservation(record.intent.intentId, realNow()), undefined);
      assert.equal(host.host.counts().held, 0, "observation never allocates capacity");
    } else {
      const observed = f.bridge.observeReservation(record.intent.intentId, realNow());
      assert.ok(observed!.reservation && observed!.dispatchToken);
      assert.equal(observed!.dispatchedAt, undefined);
    }
    const recovered = f.bridge.reserveAttempt({ source: f.source(current), now: realNow() });
    assert.ok(recovered.status === "reserved" || recovered.status === "duplicate");
    assert.equal(recovered.record.intent.intentId, record.intent.intentId);
    assert.equal(host.host.counts().total, 1);
    assert.equal(f.rows("runtime_semaphore_slots").length, 0);
    assert.equal(f.rows("resource_leases").length, 0);
    assert.equal(f.store.getWorkUnitAttempt(current.attempt.id)!.status, "created");
  });
}

test("distinct workspace databases contend for the same final Host slot without creating local resources", async t => {
  const host = hostCapacityFixture(t, { maximum: 1 }), left = await hostCapacityWorkspace(t, host), right = await hostCapacityWorkspace(t, host);
  const a = left.prepare("shared-id"), b = right.prepare("shared-id");
  assert.notEqual(left.identity.workspaceKey, right.identity.workspaceKey);
  const record = left.reserve(a);
  assert.equal(right.bridge.reserveAttempt({ source: right.source(b), now: realNow() }).status, "full");
  assert.equal(right.rows("runtime_host_capacity_intents").length, 1, "full admission retains its durable retry identity");
  assert.equal(right.rows("runtime_semaphore_slots").length, 0);
  assert.equal(left.journal.prepareNoDispatchRelease({ intentId: record.intent.intentId, now: realNow() }).status, "prepared");
  assert.equal(left.bridge.flushRelease(record.intent.intentId, realNow()), true);
  assert.equal(right.bridge.reserveAttempt({ source: right.source(b), now: realNow() }).status, "reserved");
  assert.deepEqual(host.host.counts(), { held: 1, released: 1, total: 2 });
});

test("an unconfigured Host never allocates a slot or grants SDK dispatch", async t => {
  const host = hostCapacityFixture(t, { configured: false }), f = await hostCapacityWorkspace(t, host), current = f.prepare("unconfigured");
  assert.equal(f.bridge.reserveAttempt({ source: f.source(current), now: realNow() }).status, "unconfigured");
  assert.deepEqual(host.host.counts(), { held: 0, released: 0, total: 0 });
  assert.equal(f.rows("runtime_host_capacity_intents").length, 1);
  assert.equal(f.rows("runtime_semaphore_slots").length, 0);
});

test("cancellation after an orphan Host reservation can attach and revoke without executing the SDK", async t => {
  const host = hostCapacityFixture(t), f = await hostCapacityWorkspace(t, host), current = f.prepare("cancelled-orphan");
  const record = f.intent(current);
  assert.equal(host.host.reserve({ intent: record.intent, now: f.at(3) }).status, "reserved");
  f.terminal(current, { started: false });
  host.reopen(); f.reopen();
  assert.equal(f.bridge.reserveAttempt({ source: f.source(current), now: realNow() }).status, "changed");
  const observed = f.bridge.observeReservation(record.intent.intentId, realNow());
  assert.ok(observed!.reservation);
  assert.equal(f.journal.prepareNoDispatchRelease({ intentId: record.intent.intentId, now: realNow() }).status, "prepared");
  assert.equal(f.bridge.flushRelease(record.intent.intentId, realNow()), true);
  assert.equal(f.journal.listPendingReleases().length, 0);
  assert.deepEqual(host.host.counts(), { held: 0, released: 1, total: 1 });
});

test("a Host reservation is retained if workspace receipt commit fails and later observation can attach it", async t => {
  const host = hostCapacityFixture(t), f = await hostCapacityWorkspace(t, host), current = f.prepare("receipt-fault");
  testDatabase(f.store).exec("CREATE TRIGGER host_capacity_receipt_fault BEFORE UPDATE ON runtime_host_capacity_intents BEGIN SELECT RAISE(ABORT,'receipt fault'); END");
  assert.throws(() => f.bridge.reserveAttempt({ source: f.source(current), now: realNow() }), /receipt fault/u);
  assert.equal(host.host.counts().held, 1);
  const intentId = f.rows("runtime_host_capacity_intents")[0].intent_id;
  assert.ok(typeof intentId === "string");
  assert.equal(f.journal.getIntent(intentId)!.reservation, undefined);
  testDatabase(f.store).exec("DROP TRIGGER host_capacity_receipt_fault");
  host.reopen(); f.reopen();
  assert.ok(f.bridge.observeReservation(intentId, realNow())!.reservation);
  assert.equal(host.host.counts().total, 1);
});

test("an unknown dispatch remains held after reopen and never turns into an automatic retry", async t => {
  const host = hostCapacityFixture(t, { maximum: 1 }), f = await hostCapacityWorkspace(t, host), current = f.prepare("unknown-dispatch");
  const record = f.reserve(current);
  assert.equal(f.localAdmission(current, record), true);
  f.terminal(current, { started: false });
  host.reopen(); f.reopen();
  assert.equal(f.bridge.reserveAttempt({ source: f.source(current), now: realNow() }).status, "changed");
  assert.equal(f.journal.prepareNoDispatchRelease({ intentId: record.intent.intentId, now: realNow() }).status, "changed");
  assert.equal(f.journal.prepareStoppedRelease({ intentId: record.intent.intentId, now: realNow() }).status, "changed");
  assert.equal(f.bridge.flushRelease(record.intent.intentId, realNow()), false);
  assert.equal(host.host.counts().held, 1);
});

for (const window of ["release-outbox", "host-release"]) {
  test(`reopening after ${window} completes the original release and never creates another reservation`, async t => {
    const host = hostCapacityFixture(t), f = await hostCapacityWorkspace(t, host), current = f.prepare(window);
    const record = f.reserve(current);
    const prepared = f.journal.prepareNoDispatchRelease({ intentId: record.intent.intentId, now: realNow() });
    assert.equal(prepared.status, "prepared");
    if (window === "host-release") {
      const release = prepared.release;
      assert.equal(host.host.release({ reservationId: release.reservationId, token: release.token, intent: record.intent,
        kind: release.kind, proofDigest: release.proofDigest, now: realNow() }).status, "released");
    }
    host.reopen(); f.reopen();
    assert.equal(f.journal.listPendingReleases().length, 1);
    assert.equal(f.bridge.flushRelease(record.intent.intentId, realNow()), true);
    assert.ok(f.journal.getRelease(record.intent.intentId)!.acknowledgedAt);
    assert.equal(f.bridge.flushRelease(record.intent.intentId, realNow()), true);
    assert.equal(f.journal.listPendingReleases().length, 0);
    assert.equal(f.bridge.reserveAttempt({ source: f.source(current), now: realNow() }).status, "changed");
    assert.deepEqual(host.host.counts(), { held: 0, released: 1, total: 1 });
  });
}

test("Host release survives a failed workspace ACK commit and is recovered by observation", async t => {
  const host = hostCapacityFixture(t), f = await hostCapacityWorkspace(t, host), current = f.prepare("ack-fault");
  const record = f.reserve(current);
  assert.equal(f.journal.prepareNoDispatchRelease({ intentId: record.intent.intentId, now: realNow() }).status, "prepared");
  testDatabase(f.store).exec("CREATE TRIGGER host_capacity_ack_fault BEFORE UPDATE ON runtime_host_capacity_releases BEGIN SELECT RAISE(ABORT,'ack fault'); END");
  assert.throws(() => f.bridge.flushRelease(record.intent.intentId, realNow()), /ack fault/u);
  assert.equal(host.host.counts().held, 0);
  assert.equal(f.journal.listPendingReleases().length, 1);
  testDatabase(f.store).exec("DROP TRIGGER host_capacity_ack_fault");
  host.reopen(); f.reopen();
  assert.ok(f.bridge.observeReservation(record.intent.intentId, realNow()));
  assert.equal(f.journal.listPendingReleases().length, 0);
  assert.equal(host.host.counts().total, 1);
});

test("a foreign token, release kind or proof cannot acknowledge the owning workspace outbox", async t => {
  const host = hostCapacityFixture(t), f = await hostCapacityWorkspace(t, host), current = f.prepare("ack-binding");
  const record = f.reserve(current);
  const prepared = f.journal.prepareNoDispatchRelease({ intentId: record.intent.intentId, now: realNow() });
  assert.equal(prepared.status, "prepared");
  const release = prepared.release;
  const released = host.host.release({ reservationId: release.reservationId, token: release.token, intent: record.intent,
    kind: release.kind, proofDigest: release.proofDigest, now: realNow() });
  assert.equal(released.status, "released");
  const reservation = released.reservation;
  for (const override of [{ token: "a".repeat(64) }, { releaseKind: "stopped" }, { releaseProofDigest: "b".repeat(64) },
    { reservationId: "foreign" }, { intent: { ...record.intent, workspaceKey: "foreign" } }]) {
    assert.equal(f.journal.acknowledgeRelease({ intentId: record.intent.intentId,
      reservation: { ...reservation, ...override } as HostRunCapacityReservation, now: realNow() }), false);
    assert.equal(f.journal.listPendingReleases().length, 1);
  }
  assert.equal(f.journal.acknowledgeRelease({ intentId: record.intent.intentId, reservation, now: realNow() }), true);
});

test("positive original Host drain and effect coverage release a dispatched terminal source", async t => {
  const host = hostCapacityFixture(t), f = await hostCapacityWorkspace(t, host), current = f.prepare("stopped");
  const record = f.reserve(current), execution = f.begin(current, record);
  execution.lifetime.resolve();
  const completion = await execution.completion;
  assert.equal(completion.effectCoverage, "pi_no_tools_v1");
  assert.equal(f.journal.prepareStoppedRelease({ intentId: record.intent.intentId, now: realNow() }).status, "changed", "still running");
  f.terminal(current, { status: "succeeded" });
  f.store.releaseHostAttemptResources(f.source(current), realNow());
  f.reopen();
  const release = f.journal.prepareStoppedRelease({ intentId: record.intent.intentId, now: realNow() });
  assert.equal(release.status, "prepared");
  assert.equal(release.release.kind, "stopped");
  assert.equal(f.bridge.flushRelease(record.intent.intentId, realNow()), true);
  assert.deepEqual(host.host.counts(), { held: 0, released: 1, total: 1 });
});

test("native journal drain and effect coverage release a dispatched terminal source", async t => {
  const host = hostCapacityFixture(t), f = await hostCapacityWorkspace(t, host), current = f.prepare("native-stop", {
    requestOverrides: { executionBinding: { kind: "native_profile", engineId: "kimi-acp", profileId: "fixture", profileRevision: 1 } },
  });
  const record = f.reserve(current), execution = f.begin(current, record, {
    coverage: { schemaVersion: 1, kind: "native_journal_v1", submissionIds: [] },
  });
  execution.lifetime.resolve();
  const completion = await execution.completion;
  assert.equal(completion.effectCoverage, "native_journal_v1");
  f.terminal(current, { status: "succeeded" });
  f.store.releaseHostAttemptResources(f.source(current), realNow());
  const release = f.journal.prepareStoppedRelease({ intentId: record.intent.intentId, now: realNow() });
  assert.equal(release.status, "prepared", JSON.stringify(release));
  assert.equal(release.release.kind, "stopped");
  assert.equal(f.bridge.flushRelease(record.intent.intentId, realNow()), true);
  assert.deepEqual(host.host.counts(), { held: 0, released: 1, total: 1 });
});
