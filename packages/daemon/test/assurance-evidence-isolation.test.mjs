import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { ActiveRunRegistry } from "../dist/runtime/active-runs.js";
import { RunStoreRegistry } from "../dist/runtime/store-registry.js";
import { handleGetRunAssuranceEvidence } from "../dist/features/runs/assurance-evidence.js";
import { requestWorkflowMergeApproval } from "../dist/features/channels/workflow-merge-approval.js";
import { applyApprovedWorkflowMerge } from "../dist/features/channels/workflow-merge-apply.js";
import { collectHostReadiness } from "../../../scripts/framework-assurance/host-readiness.mjs";
import { parseLiveExecutionEvidenceResponse } from "../../../scripts/framework-assurance/execution-evidence.mjs";
import { nativeGit, now, workflowIntegrationCoordinatorFixture } from "./support/workflow-integration-coordinator-fixture.mjs";
import { recoveryHost, workflowConflictRecoveryFixture } from "./support/workflow-conflict-recovery-fixture.mjs";

// The workflow fixture uses native ESM and real SQLite/Git state; the owning daemon
// integration suite loads this boundary through its existing .mjs test runner.
async function startEvidenceServer(t, fixture) {
  const registry = new RunStoreRegistry(() => fixture.store, { recoverOnOpen: false });
  registry.getStore(fixture.cwd);
  const activeRuns = new ActiveRunRegistry();
  const server = createServer((request, response) => {
    handleGetRunAssuranceEvidence(response, new URL(request.url, "http://local"), registry, activeRuns, fixture.runId);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    registry.closeAll();
  });
  const address = server.address();
  const url = new URL(`http://127.0.0.1:${address.port}/runs/${encodeURIComponent(fixture.runId)}/assurance-evidence`);
  url.searchParams.set("cwd", fixture.cwd);
  return {
    async read() {
      const response = await fetch(url);
      const body = await response.json();
      assert.equal(response.status, 200, JSON.stringify(body));
      return body;
    },
  };
}

async function readEvidence(t, fixture) {
  const endpoint = await startEvidenceServer(t, fixture);
  return parseLiveExecutionEvidenceResponse(await endpoint.read());
}

test("assurance endpoint projects a real SQLite isolation round without private paths", recoveryHost, async t => {
  const fixture = await workflowConflictRecoveryFixture(t);
  const round = await fixture.create();
  const item = await fixture.start(round, 0);
  fixture.runId = item.run.id;
  fixture.workflowId = round.workflow.id;
  fixture.plan = item.plan;
  const evidence = await readEvidence(t, fixture);
  assert.equal(evidence.execution.runId, fixture.runId);
  assert.equal(evidence.isolation.workflowId, fixture.workflowId);
  assert.equal(evidence.isolation.workflowStepId, fixture.plan.workflowStepId);
  assert.equal(evidence.isolation.round?.candidate, null);
  assert.ok(evidence.isolation.blockers.includes("workflow_merge.candidate_missing"));
  assert.ok(evidence.isolation.blockers.includes("workflow_merge.branch_result_unconfirmed"));
  assert.doesNotMatch(JSON.stringify(evidence), new RegExp(fixture.cwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(JSON.stringify(evidence), /ownerToken|executionRoot|commonDir|sealedPayload/);
});

test("assurance endpoint keeps candidate, approval and apply states distinct", nativeGit, async t => {
  const fixture = await workflowIntegrationCoordinatorFixture(t, { mode: "apply_to_target", isolatedProfile: true });
  assert.equal((await fixture.coordinate()).status, "awaiting_approval");

  let evidence = await readEvidence(t, fixture);
  assert.ok(evidence.isolation.round?.candidate);
  assert.ok(evidence.isolation.branchResults.length > 0);
  assert.ok(evidence.isolation.branchResults.every(result => result.status === "confirmed"));
  assert.equal(evidence.isolation.approval.status, "not_requested");
  assert.equal(evidence.isolation.apply.status, "not_started");
  assert.ok(evidence.isolation.blockers.includes("workflow_merge.approval_missing"));
  assert.equal(evidence.isolation.status, "blocked");

  const request = await requestWorkflowMergeApproval({ store: fixture.store, roundId: fixture.roundId, now });
  assert.ok(["created", "updated", "duplicate"].includes(request.status));
  evidence = await readEvidence(t, fixture);
  assert.equal(evidence.isolation.approval.status, "pending");
  assert.equal(evidence.isolation.apply.status, "not_started");
  assert.ok(evidence.isolation.blockers.includes("workflow_merge.approval_pending"));
  assert.equal(evidence.isolation.status, "blocked");

  fixture.store.approveApprovalRequest(request.value.approvalId, { resolvedBy: "local-user", decisionKind: "approve_once" }, now());
  evidence = await readEvidence(t, fixture);
  assert.equal(evidence.isolation.approval.status, "approved");
  assert.equal(evidence.isolation.apply.status, "not_started");
  assert.ok(evidence.isolation.blockers.includes("workflow_merge.apply_not_started"));
  assert.equal(evidence.isolation.status, "blocked");

  assert.equal((await applyApprovedWorkflowMerge({ store: fixture.store, approvalId: request.value.approvalId, now })).status, "applied");
  evidence = await readEvidence(t, fixture);
  assert.equal(evidence.isolation.approval.status, "approved");
  assert.equal(evidence.isolation.apply.status, "applied");
  assert.equal(evidence.isolation.round?.phase, "applied");
  assert.deepEqual(evidence.isolation.blockers, [], JSON.stringify(evidence.isolation));
  assert.equal(evidence.isolation.status, "verified");
  assert.equal(evidence.lifecycle.status, "drained");
  assert.equal(evidence.lifecycle.stop.reusable, true);
  assert.equal(evidence.execution.effectStatus, "confirmed");
  assert.equal(evidence.admission.status, "blocked");
  assert.ok(evidence.admission.blockers.includes("workflow_admission.tool_broker_enforce_required"));
  assert.ok(evidence.admission.blockers.includes("workflow_admission.execution_binding_invalid"));
});

test("host readiness collects real SQLite/Git evidence through HTTP without granting execution", nativeGit, async t => {
  const fixture = await workflowIntegrationCoordinatorFixture(t, { mode: "apply_to_target", isolatedProfile: true });
  assert.equal((await fixture.coordinate()).status, "awaiting_approval");
  const request = await requestWorkflowMergeApproval({ store: fixture.store, roundId: fixture.roundId, now });
  fixture.store.approveApprovalRequest(request.value.approvalId, { resolvedBy: "local-user", decisionKind: "approve_once" }, now());
  assert.equal((await applyApprovedWorkflowMerge({ store: fixture.store, approvalId: request.value.approvalId, now })).status, "applied");

  const endpoint = await startEvidenceServer(t, fixture);
  let calls = 0;
  const report = await collectHostReadiness({
    cwd: fixture.cwd,
    runId: fixture.runId,
    client: {
      async getRunAssuranceEvidence(runId, cwd) {
        calls += 1;
        assert.equal(runId, fixture.runId);
        assert.equal(cwd, fixture.cwd);
        return endpoint.read();
      },
    },
  });
  assert.equal(calls, 1);
  assert.equal(report.status, "blocked");
  assert.equal(report.executionAuthorized, false);
  assert.equal(report.domains.lifecycle.status, "drained");
  assert.equal(report.domains.lifecycle.allAttemptsTerminal, true);
  assert.equal(report.domains.lifecycle.effects, "settled");
  assert.equal(report.domains.isolation.status, "verified");
  assert.equal(report.domains.isolation.applyStatus, "applied");
  assert.ok(report.blockers.includes("host_readiness.admission_not_verified"));
});
