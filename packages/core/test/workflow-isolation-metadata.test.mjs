import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore, workflowStepStartAuthorityBasis } from "../dist/index.js";
import { createSqliteRunStoreFixture } from "./support/sqlite-run-store-fixture.mjs";

const now = "2026-11-02T00:00:00.000Z";
const pin = { planId: "isolation-plan-a", planDigest: `wip1_${"a".repeat(64)}` };

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-workflow-isolation-metadata-"));
  const f = { cwd, store: createSqliteRunStoreFixture(cwd) };
  t.after(async () => { try { f.store.close(); } finally { await rm(cwd, { recursive: true, force: true }); } });
  const channel = f.store.createChannel({ name: "Isolated writer", boundPath: cwd }, now);
  const workflow = f.store.createChannelWorkflow({ channelId: channel.id, title: "Isolated writer",
    objective: "Preserve the approved scope pin", createdBy: "local-user" }, now);
  f.stepInput = { workflowId: workflow.id, title: "Write", prompt: "Implement the frozen scope",
    toParticipantId: "teammate_builtin_engineer", toParticipantLabel: "Engineer" };
  f.reopen = () => { f.store.close(); f.store = createSqliteRunStore(cwd); };
  return f;
}

test("isolation scope pin survives insert, update and SQLite reopen without changing the start basis", async t => {
  const f = await fixture(t);
  const step = f.store.createChannelWorkflowStep({ ...f.stepInput, metadata: { isolationScopePlan: pin } }, now);
  const basis = workflowStepStartAuthorityBasis(f.store, step);
  assert.ok(basis);
  f.reopen();
  const restored = f.store.getChannelWorkflowStep(step.id);
  assert.deepEqual(restored.metadata.isolationScopePlan, pin);
  assert.equal(workflowStepStartAuthorityBasis(f.store, restored), basis);
  const changed = { ...pin, planDigest: `wip1_${"b".repeat(64)}` };
  f.store.updateChannelWorkflowStep(step.id, { metadata: { isolationScopePlan: changed } }, now);
  f.reopen();
  const updated = f.store.getChannelWorkflowStep(step.id);
  assert.deepEqual(updated.metadata.isolationScopePlan, changed);
  assert.notEqual(workflowStepStartAuthorityBasis(f.store, updated), basis);
  assert.notEqual(workflowStepStartAuthorityBasis(f.store, { ...updated,
    metadata: { ...updated.metadata, isolationScopePlan: { ...changed, planId: "another-plan" } } }),
  workflowStepStartAuthorityBasis(f.store, updated));
});

test("a malformed persisted scope pin never degrades into unbound workflow execution", async t => {
  const f = await fixture(t);
  const step = f.store.createChannelWorkflowStep(f.stepInput, now);
  for (const value of [null, {}, [], { planId: "", planDigest: pin.planDigest }, { ...pin, planId: "unsafe\nplan" },
    { ...pin, planDigest: "tampered" }, { ...pin, planDigest: `wip1_${"g".repeat(64)}` }]) {
    assert.throws(() => f.store.createChannelWorkflowStep({ ...f.stepInput, metadata: { isolationScopePlan: value } }, now),
      /workflow_isolation\.scope_pin_invalid/u);
    assert.throws(() => f.store.updateChannelWorkflowStep(step.id, { metadata: { isolationScopePlan: value } }, now),
      /workflow_isolation\.scope_pin_invalid/u);
    f.store.database.prepare("UPDATE channel_workflow_steps SET metadata_json = ? WHERE id = ?")
      .run(JSON.stringify({ isolationScopePlan: value }), step.id);
    f.reopen();
    assert.throws(() => f.store.getChannelWorkflowStep(step.id), /workflow_isolation\.scope_pin_invalid/u);
    assert.throws(() => f.store.listChannelWorkflowSteps({ workflowId: step.workflowId, complete: true }),
      /workflow_isolation\.scope_pin_invalid/u);
  }
});
