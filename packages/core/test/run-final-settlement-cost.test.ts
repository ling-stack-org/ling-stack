import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { suspensionStopFixture, stopNow } from "./support/run-suspension-stop-fixture.mjs";
import { SqliteRunFinalSettlementStore } from "../dist/storage/sqlite/run-final-settlement-store.js";
import { readRunFinalSettlementRecord } from "../dist/storage/sqlite/run-final-settlement-records.js";

async function fixture(t: TestContext, cost: Record<string, unknown>) {
  const f = await suspensionStopFixture(t, { budget: false });
  const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 };
  const view = [...structuredClone(f.root.view), {
    role: "assistant", content: [{ type: "text", text: "Read complete." }], stopReason: "stop",
    usage: { ...usage, cost },
  }];
  f.store.appendExecutionEvent(f.root.runId, f.root.fence, "message_end", {
    attemptId: f.root.fence.attemptId, role: "assistant", text: "Read complete.", stopReason: "stop", usage,
  });
  const observation = Object.freeze({});
  const ports: ConstructorParameters<typeof SqliteRunFinalSettlementStore>[1] = {
    ...f.ports,
    getRun: id => f.store.getRun(id),
    getWorkUnitAttempt: id => f.store.getWorkUnitAttempt(id),
    getWorkUnit: id => f.store.getWorkUnit(id),
    getApprovalPolicy: () => f.store.getApprovalPolicy(),
    getLingThread: id => f.store.getLingThread(id),
    getChannel: id => f.store.getChannel(id),
    getProviderPreset: id => f.store.getProviderPreset(id),
    getAiTeammate: id => f.store.getAiTeammate(id),
    listTeammateSkillBindings: id => f.store.listTeammateSkillBindings(id),
    getSkillRegistryEntry: id => f.store.getSkillRegistryEntry(id),
    getLatestWorkspaceProvenanceWatermark: (...args) => f.store.getLatestWorkspaceProvenanceWatermark(...args),
    listEvents: (...args) => f.store.listEvents(...args),
    listHarnessToolExecutions: id => f.store.listHarnessToolExecutions(id),
    listHostCommandWriteBlockers: cwd => f.store.listHostCommandWriteBlockers(cwd),
    listApprovalRequests: options => f.store.listApprovalRequests(options),
    readFinalSettlementObservation: reference => {
      assert.equal(reference, observation);
      return { kind: "pi_final_settlement", runId: f.root.runId, sourceFence: f.root.fence,
        modelView: structuredClone(view), toolCallIds: [], settledBuiltinReads: [] };
    },
  };
  const authority = new SqliteRunFinalSettlementStore({ database: f.db }, ports);
  return { ...f, view, commit: () => authority.commitRunFinalSettlement({ runId: f.root.runId,
    sourceFence: f.root.fence, expectedLineage: f.root.lineage, observation, modelView: view, now: stopNow() }) };
}

const baseCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

for (const totalFromProvider of [undefined, false, true]) {
  test(`final settlement retains cost provenance: ${String(totalFromProvider)}`, async t => {
    const cost = { ...baseCost, ...(totalFromProvider === undefined ? {} : { totalFromProvider }) };
    const f = await fixture(t, cost), result = f.commit();
    assert.ok(result.kind === "verified", JSON.stringify(result));
    assert.deepEqual(result.modelView, f.view);
    assert.deepEqual(readRunFinalSettlementRecord(f.db, result.witness.settlement.id).modelView, f.view);
  });
}

const invalidCosts: [string, Record<string, unknown>][] = [
  ["string provenance", { totalFromProvider: "false" }],
  ["numeric provenance", { totalFromProvider: 0 }],
  ["null provenance", { totalFromProvider: null }],
  ["negative amount", { total: -1 }],
  ["string amount", { input: "0" }],
];
for (const [label, change] of invalidCosts) {
  test(`final settlement rejects ${label} without persisting authority`, async t => {
    const f = await fixture(t, { ...baseCost, ...change });
    const before = f.snapshot();
    assert.equal(f.commit().kind, "blocked");
    assert.deepEqual(f.snapshot(), before);
    assert.deepEqual(f.db.prepare("SELECT id FROM run_final_settlements").all(), []);
  });
}
