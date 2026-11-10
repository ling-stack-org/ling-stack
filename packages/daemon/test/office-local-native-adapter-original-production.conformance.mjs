import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { executeOfficeLocalDirectoryWrite, OfficeLocalDirectoryWriterError } from "../dist/features/office-documents/office-local-native-adapter.js";
import { createOriginalOfficeDirectoryCompositionFixture } from "./support/office-original-directory-composition-fixture.mjs";
import { readOriginalAttemptExecutorGroupSnapshot } from "../dist/runtime/attempt-execution-quiescence.js";
import { settleOriginalAttemptHostOfficeLocalDirectoryFromStoreV2 }
  from "../dist/runtime/attempt-host-operation-tracker.js";

const nativeOnly = { skip: process.platform !== "darwin" || process.arch !== "arm64" };

test("original production adapter closes, seals, claims, commits and releases before its original V2 barriers", nativeOnly, async t => {
  const f = await createOriginalOfficeDirectoryCompositionFixture(t), order = [],
    launch = f.tracker.launchOfficeLocalDirectoryEffectV2.bind(f.tracker),
    seal = f.tracker.sealOfficeLocalDirectoryTerminalV2.bind(f.tracker),
    close = f.store.closeHostOfficeLocalDirectoryWindowV2.bind(f.store),
    commit = f.store.settleHostOfficeLocalDirectoryExecutionV2.bind(f.store);
  let firstGrant, firstCommitClosure, firstCommitLeaseError, commits = 0, releasedBeforeBarriers = false;
  const grants = [], postReleaseLocalStates = [];
  t.mock.method(f.tracker, "launchOfficeLocalDirectoryEffectV2", (ticket, effectId, callback, mode) =>
    launch(ticket, effectId, () => {
      const packet = callback();
      if (f.effects().find(row => row.effectId === effectId).kind === "close_session") order.push("native_close_session");
      return packet;
    }, mode));
  t.mock.method(f.tracker, "sealOfficeLocalDirectoryTerminalV2", (ticket, input) => {
    const terminal = seal(ticket, input);
    assert.equal(terminal.outcome, "published_native_only"); order.push("terminal_seal"); return terminal;
  });
  t.mock.method(f.store, "closeHostOfficeLocalDirectoryWindowV2", ticket => {
    assert.equal(f.terminal().outcome, "published_native_only");
    const claim = close(ticket); order.push("owning_close_claim"); return claim;
  });
  t.mock.method(f.store, "settleHostOfficeLocalDirectoryExecutionV2", ticket => {
    const grant = commit(ticket);
    grants.push(grant);
    if (++commits === 1) {
      firstGrant = grant; order.push("core_committed_grant");
      firstCommitClosure = f.runtime.readCoreWindowClosure(f.state.scope).phase;
      try { f.unboundActorGate(); } catch (error) { firstCommitLeaseError = error; }
    } else {
      let releaseConfirmed = false;
      try { f.unboundActorGate(); releaseConfirmed = true; }
      catch (error) {
        if (error.message !== "protected_host_actor_unbound_with_active_stage") throw error;
      }
      if (releaseConfirmed) {
        postReleaseLocalStates.push(readOriginalAttemptExecutorGroupSnapshot(f.tracker.executorGroup).operations.map(row => row.state));
        releasedBeforeBarriers = true;
      }
    }
    return grant;
  });
  const result = executeOfficeLocalDirectoryWrite(f.plan);
  assert.equal(firstCommitClosure, "closed_pending");
  assert.equal(firstCommitLeaseError?.message, "protected_host_actor_unbound_with_active_stage",
    "Core commit alone must not release the owning protection member");
  assert.ok(grants.every(grant => grant === firstGrant), "Tracker must consume the same committed opaque grant");
  assert.ok(postReleaseLocalStates.every(states => states.every(state => state !== "settled")));
  assert.equal(releasedBeforeBarriers, true, "fixed lease release must precede either original local V2 barrier");
  assert.ok(readOriginalAttemptExecutorGroupSnapshot(f.tracker.executorGroup).operations.every(row => row.state === "settled"));
  order.push("tracker_v2_barriers");
  assert.equal(result.kind, "office_local_directory_write_result_v2");
  assert.equal(result.executionId, f.plan.executionId); assert.equal(result.path, f.state.execution.targetPath);
  assert.equal(result.nativeFacts.coreSafe, false); assert.equal(result.nativeFacts.canonicalVisibility, "unverified");
  assert.equal(result.nativeFacts.graph.kind, "graph_verified_only");
  assert.equal(result.nativeFacts.hostStageClosure, "closed");
  assert.equal(result.settlement.parent.phase, "safe"); assert.equal(result.settlement.producer.phase, "safe");
  assert.deepEqual(readFileSync(result.path), f.artifact.bytes);
  assert.deepEqual(order, ["native_close_session", "terminal_seal", "owning_close_claim", "core_committed_grant", "tracker_v2_barriers"]);
  // Both fixed stages allow at most one same-ticket SQL return reconciliation;
  // no count of idempotent SQL reads is permission to replay a native effect.
  assert.ok(commits >= 2 && commits <= 4); assert.deepEqual(f.leaseRoots(), []);
  t.diagnostic(`Same original opaque grant returned by ${commits} bounded Core settlement calls.`);
  assert.throws(() => executeOfficeLocalDirectoryWrite(f.plan), /office_local_directory_write_already_entered/u);
  assert.throws(() => executeOfficeLocalDirectoryWrite({ ...f.plan }), /office_local_directory_plan_invalid/u);
});

test("a genuine Core commit cannot close the local barriers when the original fixed lease release fails", nativeOnly, async t => {
  const f = await createOriginalOfficeDirectoryCompositionFixture(t),
    commit = f.store.settleHostOfficeLocalDirectoryExecutionV2.bind(f.store);
  let committed = false;
  t.mock.method(f.store, "settleHostOfficeLocalDirectoryExecutionV2", ticket => {
    const grant = commit(ticket);
    committed = true;
    // Actual original scope revocation after SQL commit, not a fake grant,
    // replaced lease gate or a fabricated native return.
    f.runtime.revokeScope(f.state.scope);
    return grant;
  });
  let failure;
  assert.throws(() => {
    try { executeOfficeLocalDirectoryWrite(f.plan); }
    catch (error) { failure = error; throw error; }
  }, error => error instanceof OfficeLocalDirectoryWriterError);
  assert.equal(committed, true);
  assert.equal(failure.hostStageClosure, "closed"); assert.equal(failure.terminalSealConfirmed, true);
  assert.equal(f.terminal().outcome, "published_native_only", "do not rewrite the immutable native-only terminal after release failure");
  assert.ok(f.pairRows().every(row => row.phase === "safe"), "physical/Core commit and local release are distinct axes");
  assert.ok(readOriginalAttemptExecutorGroupSnapshot(f.tracker.executorGroup).operations.every(row => row.state !== "settled"));
  assert.equal(f.runtime.readCoreWindowClosure(f.state.scope).phase, "closed_pending", "failed release must leave the exact original window pending");
  assert.throws(() => f.leaseRoots(), /protected_host_stage_closed/u, "revoked actor admission cannot read or erase the pending lease");
  assert.throws(() => f.unboundActorGate(), /protected_host_actor_unbound_with_active_stage/u,
    "the original same-Registry active-stage gate must prove its pending protection member remains");
  assert.throws(() => executeOfficeLocalDirectoryWrite(f.plan), /office_local_directory_write_already_entered/u);
});

test("a replaced public Tracker settlement cannot counterfeit the original local V2 barriers", nativeOnly, async t => {
  const f = await createOriginalOfficeDirectoryCompositionFixture(t);
  const replacement = t.mock.method(f.tracker, "settleOfficeLocalDirectoryFromStoreV2", () => ({
    parent: f.pairRows()[0], producer: f.pairRows()[1],
  }));
  const result = executeOfficeLocalDirectoryWrite(f.plan);
  assert.equal(result.kind, "office_local_directory_write_result_v2");
  assert.equal(replacement.mock.callCount(), 0, "production must use the original fixed Tracker entry, never this public replacement");
  assert.ok(readOriginalAttemptExecutorGroupSnapshot(f.tracker.executorGroup).operations.every(row => row.state === "settled"));
  assert.deepEqual(f.leaseRoots(), []);
});

test("synchronous post-commit Tracker reentry cannot close original barriers before the fixed lease release", nativeOnly, async t => {
  const f = await createOriginalOfficeDirectoryCompositionFixture(t),
    commit = f.store.settleHostOfficeLocalDirectoryExecutionV2.bind(f.store),
    publicSettle = f.tracker.settleOfficeLocalDirectoryFromStoreV2.bind(f.tracker), reentries = [];
  let entered = false;
  t.mock.method(f.store, "settleHostOfficeLocalDirectoryExecutionV2", ticket => {
    const grant = commit(ticket);
    if (!entered) {
      entered = true;
      // Reenter the real constructor-private implementations after actual SQL
      // commit but before the production helper has released its original lease.
      // Keep assertions outside this wrapper: an assertion throw here could be
      // mistaken for a lost SQL ACK and swallowed by bounded reconciliation.
      for (const [entry, settle] of [["public", () => publicSettle(ticket)],
        ["fixed", () => settleOriginalAttemptHostOfficeLocalDirectoryFromStoreV2(f.tracker, ticket)]]) {
        let error, pendingLeaseError;
        try { settle(); } catch (caught) { error = caught; }
        try { f.unboundActorGate(); } catch (caught) { pendingLeaseError = caught; }
        reentries.push({ entry, error,
          localStates: readOriginalAttemptExecutorGroupSnapshot(f.tracker.executorGroup).operations.map(row => row.state),
          pendingLeaseError });
      }
    }
    return grant;
  });
  const result = executeOfficeLocalDirectoryWrite(f.plan);
  assert.deepEqual(reentries.map(row => row.entry), ["public", "fixed"]);
  for (const row of reentries) {
    assert.ok(row.error instanceof Error, `${row.entry} must reject before its original lease is released`);
    assert.equal(row.error.code, "attempt_host_operation_office_directory_lease_unreleased");
    assert.ok(row.localStates.every(state => state !== "settled"), `${row.entry} cannot prematurely settle either local barrier`);
    assert.equal(row.pendingLeaseError?.message, "protected_host_actor_unbound_with_active_stage",
      "actual Core commit must retain the original pending protection member until fixed release");
  }
  assert.equal(result.settlement.parent.phase, "safe"); assert.equal(result.settlement.producer.phase, "safe");
  assert.ok(readOriginalAttemptExecutorGroupSnapshot(f.tracker.executorGroup).operations.every(row => row.state === "settled"));
  assert.deepEqual(f.leaseRoots(), []);
  assert.equal(f.effects().filter(row => row.kind === "close_session").length, 1, "no native close effect is replayed for reentry");
});
