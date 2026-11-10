import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore, DEFAULT_WORKSPACE_ID, toRuntimeAttemptFence } from "../dist/index.js";

const now = "2026-10-05T06:00:00.000Z";
for (const status of ["denied", "cancelled"]) {
  test(`preview cleanup ${status} uses an atomic captured-owner fence across SQLite connections`, async t => {
    const f = await fixture(t), approval = f.create();
    assert.equal(f.store.isCurrentRunExecutionOwner(f.run.id, f.sourceFence), true);
    // Interleave a real second-connection takeover immediately before the
    // authoritative UPDATE, after any read-side checks the implementation does.
    const prepare = f.store.database.prepare.bind(f.store.database);
    let interleaved = false;
    t.mock.method(f.store.database, "prepare", sql => {
      const statement = prepare(sql);
      if (!sql.includes("UPDATE approval_requests")) return statement;
      return { run(...args) {
        if (!interleaved) { interleaved = true; f.replace(); }
        return statement.run(...args);
      } };
    });
    assert.throws(() => f.resolve(status, approval), /Approval execution no longer active/u);
    assert.equal(interleaved, true);
    assert.equal(f.other.getApprovalRequest(approval.id).status, "pending");
    assert.equal(f.other.getApprovalCheckpointForApproval(approval.id).status, "pending");
    assert.equal(f.other.listApprovalPostCommitEffects({ approvalId: approval.id }).length, 0);
  });

  test(`preview cleanup ${status} rejects changed original request identity`, async t => {
    const f = await fixture(t), approval = f.create();
    for (const changed of [
      { runId: "another-run" }, { toolCallId: "another-call" }, { approvalCreatedAt: "2026-10-06T00:00:00.000Z" },
      { sourceFence: { ...f.sourceFence, fencingToken: "wrong-token" } },
    ]) {
      assert.throws(() => f.resolve(status, approval, changed), /Approval execution no longer active/u);
      assert.equal(f.store.getApprovalRequest(approval.id).status, "pending");
    }
  });

  test(`preview cleanup ${status} preserves an external pending-CAS winner`, async t => {
    const f = await fixture(t), approval = f.create();
    f.other.denyApprovalRequest(approval.id, { reason: "external decision" }, now);
    assert.throws(() => f.resolve(status, approval), /Approval request is not pending/u);
    assert.equal(f.store.getApprovalRequest(approval.id).decisionReason, "external decision");
  });

  test(`preview cleanup ${status} resolves its current owner and leaves unfenced callers unchanged`, async t => {
    const f = await fixture(t), approval = f.create();
    const resolved = f.resolve(status, approval);
    assert.equal(resolved.status, status);
    assert.equal(f.store.getApprovalCheckpointForApproval(approval.id).status, status);
    const unfenced = f.create("unfenced-call");
    f.replace();
    assert.equal((status === "denied" ? f.store.denyApprovalRequest : f.store.cancelApprovalRequest)
      .call(f.store, unfenced.id, { reason: "existing administrative path" }, now).status, status);
  });
}

for (const decision of ["approve_once", "approve_command_rule", "expire"]) {
  test(`execution cleanup cannot ${decision} or alter pending approval, checkpoint, rules or postcommit`, async t => {
    const f = await fixture(t), proposal = { prefix: ["whois"], display: "whois", fingerprint: "cleanup-contract-whois", version: 1 };
    const approval = f.create("contract-call", { risk: "medium", payload: { type: "bash", cwd: f.run.cwd,
      command: "whois example.com", riskFlags: [] }, availableDecisions: ["approve_once", "approve_command_rule", "deny"],
      proposedCommandRule: proposal });
    const checkpoint = f.store.getApprovalCheckpointForApproval(approval.id);
    const input = { reason: "must not grant permission from cleanup", ...(decision === "expire" ? {} : { decisionKind: decision }),
      proposedRuleFingerprint: proposal.fingerprint, executionCleanup: { runId: f.run.id, toolCallId: approval.toolCallId,
        approvalCreatedAt: approval.createdAt, sourceFence: f.sourceFence } };
    const decide = decision === "expire" ? f.store.expireApprovalRequest.bind(f.store) : f.store.approveApprovalRequest.bind(f.store);
    assert.throws(() => decide(approval.id, input, now), /Execution cleanup can only deny or cancel an approval/u);
    assert.deepEqual(f.store.getApprovalRequest(approval.id), approval);
    assert.deepEqual(f.store.getApprovalCheckpointForApproval(approval.id), checkpoint);
    assert.deepEqual(f.store.listApprovalCommandRules(), []);
    assert.deepEqual(f.store.listApprovalPostCommitEffects({ approvalId: approval.id }), []);

    // Removing only the cleanup authority keeps every existing management path
    // available; this new contract does not disable approval or persisted rules.
    const { executionCleanup: _cleanup, ...administrativeInput } = input;
    const resolved = decide(approval.id, administrativeInput, now);
    assert.equal(resolved.status, decision === "expire" ? "expired" : "approved");
    assert.equal(f.store.getApprovalCheckpointForApproval(approval.id).status, resolved.status);
    assert.equal(f.store.listApprovalCommandRules().length, decision === "approve_command_rule" ? 1 : 0);
    assert.ok(f.store.listApprovalPostCommitEffects({ approvalId: approval.id }).length > 0);
  });
}

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-approval-cleanup-fence-")), store = createSqliteRunStore(cwd);
  const unit = store.createWorkUnit({ workspaceId: DEFAULT_WORKSPACE_ID, kind: "task_run", ownerType: "run", ownerId: "run",
    idempotencyKey: "unit", status: "running", createdByActor: "system", request: {}, now });
  const attempt = store.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: 1, runtimeInstanceId: "original-runtime",
    runnerId: "pi", status: "started", now });
  store.createRun({ id: "run", cwd, workUnitId: unit.id, taskId: "task", providerName: "fixture", providerModel: "fixture",
    taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, createdAt: now });
  store.linkRunToWorkUnit("run", unit.id, now); store.markRunStarted("run", now);
  const run = store.getRun("run"), sourceFence = toRuntimeAttemptFence(attempt), other = createSqliteRunStore(cwd);
  t.after(async () => { other.close(); store.close(); await rm(cwd, { recursive: true, force: true }); });
  const create = (toolCallId = "call", overrides = {}) => store.createExecutionApprovalRequest({ runId: run.id, taskId: run.taskId,
    toolCallId, actionType: "bash", risk: "high", title: "Isolated cleanup", description: "No command is executed",
    payload: { type: "bash", cwd, command: "git commit -m fixture", riskFlags: [] }, ...overrides }, sourceFence, now);
  const replace = () => other.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: 2,
    runtimeInstanceId: "replacement-runtime", runnerId: "pi", status: "started", now });
  const resolve = (status, approval, changed = {}) => (status === "denied" ? store.denyApprovalRequest : store.cancelApprovalRequest)
    .call(store, approval.id, { reason: "preview failure", executionCleanup: { runId: run.id, toolCallId: approval.toolCallId,
      approvalCreatedAt: approval.createdAt, sourceFence, ...changed } }, now);
  return { store, other, run, sourceFence, create, replace, resolve };
}
