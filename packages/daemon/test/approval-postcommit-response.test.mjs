import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { handleApprovalItem } from "../dist/features/runs/routes.js";
import { runApprovalPostCommitEffects } from "../dist/features/runs/approval-postcommit-effects.js";

test("approval detail exposes effect lineage without leaking the worker claim token", async () => {
  const approval = { id: "approval-detail", status: "approved", actionType: "bash" };
  const store = {
    getApprovalRequest: () => approval,
    listApprovalPostCommitEffects: () => [{ approvalId: approval.id, effectKind: "owner", ownerKind: "run",
      ownerId: "run-detail", status: "claimed", revision: 2, attempts: 1,
      claimToken: "private-worker-token", claimExpiresAt: "2099-01-01T00:00:00.000Z",
      updatedAt: "2026-09-25T00:00:00.000Z" }],
  };
  const server = createServer((request, response) => {
    void handleApprovalItem(request, response,
      { host: "127.0.0.1", port: 0, maxBodyBytes: 4096 },
      { getStore: () => store }, { approvalId: approval.id }, undefined);
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const response = await fetch(`http://127.0.0.1:${address.port}/approvals/${approval.id}?cwd=${encodeURIComponent("/approval-detail")}`);
    const text = await response.text();
    assert.equal(response.status, 200);
    assert.equal(JSON.parse(text).postCommitEffects[0].status, "claimed");
    assert.equal(text.includes("private-worker-token"), false);
    assert.equal(text.includes("claimExpiresAt"), false);
  } finally {
    await new Promise((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
  }
});

test("one failed approval owner does not suppress independent post-commit owners", () => {
  const called = [];
  assert.throws(() => runApprovalPostCommitEffects({
    resumeRun: () => { called.push("run"); throw new Error("run_resume_failed"); },
    syncWorkflow: () => { called.push("workflow"); },
    syncMedia: () => { called.push("media"); return undefined; },
  }), (error) => error instanceof AggregateError && error.errors.length === 1);
  assert.deepEqual(called, ["run", "workflow", "media"]);
});

test("a failed post-commit approval callback cannot report that the persisted decision failed", async () => {
  const cwd = "/approval-postcommit-test";
  let approval = { id: "approval-postcommit", status: "pending", actionType: "bash" };
  const store = {
    getApprovalRequest: () => approval,
    approveApprovalRequest: (_id, decision) => {
      approval = { ...approval, status: "approved", decisionKind: decision.decisionKind };
      return approval;
    },
  };
  const registry = { getStore: () => store };
  const server = createServer((request, response) => {
    void handleApprovalItem(
      request,
      response,
      { host: "127.0.0.1", port: 0, maxBodyBytes: 4096 },
      registry,
      { approvalId: approval.id, action: "approve" },
      undefined,
      () => { throw new Error("injected_resume_failure"); },
    );
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const response = await fetch(`http://127.0.0.1:${address.port}/approvals/${approval.id}/approve?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decisionKind: "approve_once" }),
    });
    const result = await response.json();
    assert.equal(approval.status, "approved", "the decision committed before the callback failed");
    assert.equal(response.status, 200, "the HTTP result must describe the committed approval");
    assert.equal(result.approval.status, "approved");
    assert.deepEqual(result.postCommit, { status: "deferred", code: "approval_postcommit_reconciliation_required" });
  } finally {
    await new Promise((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
  }
});

test("a post-decision ledger read failure reports deferred without revoking the committed decision", async () => {
  const cwd = "/approval-postcommit-ledger-fault";
  let approval = { id: "approval-ledger-fault", status: "pending", actionType: "bash" };
  const store = {
    getApprovalRequest: () => approval,
    approveApprovalRequest: () => {
      approval = { ...approval, status: "approved" };
      return approval;
    },
    listApprovalPostCommitEffects: () => { throw new Error("injected_ledger_read_failure"); },
  };
  const server = createServer((request, response) => {
    void handleApprovalItem(request, response,
      { host: "127.0.0.1", port: 0, maxBodyBytes: 4096 },
      { getStore: () => store }, { approvalId: approval.id, action: "approve" }, undefined);
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const response = await fetch(`http://127.0.0.1:${address.port}/approvals/${approval.id}/approve?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
    });
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(result.approval.status, "approved");
    assert.equal(result.postCommit.status, "deferred");
  } finally {
    await new Promise((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
  }
});

test("one failed post-commit callback cannot skip independent approval projections", async () => {
  const cwd = "/approval-postcommit-independent-projections";
  let approval = {
    id: "approval-projections",
    status: "pending",
    actionType: "bash",
    externalWorkActionId: "external-action-1",
  };
  let action = { id: "external-action-1", status: "waiting_for_approval", approvalId: approval.id, executionAttemptCount: 0 };
  const events = [];
  const store = {
    getApprovalRequest: () => approval,
    approveApprovalRequest: (_id, decision) => {
      approval = { ...approval, status: "approved", decisionKind: decision.decisionKind };
      return approval;
    },
    appendControlPlaneEvent: (input) => ({ ...input, seq: 1 }),
    getExternalWorkAction: () => action,
    commitExternalWorkActionTransition: (transition) => {
      assert.equal(transition.actionId, action.id);
      assert.equal(transition.expectedStatus, action.status);
      assert.equal(transition.expectedExecutionAttemptCount, action.executionAttemptCount);
      assert.equal(transition.expectedApprovalId, approval.id);
      assert.equal(transition.approvalStatus, approval.status);
      action = { ...action, ...transition.update };
      return action;
    },
  };
  const registry = { getStore: () => store };
  const server = createServer((request, response) => {
    void handleApprovalItem(
      request,
      response,
      { host: "127.0.0.1", port: 0, maxBodyBytes: 4096 },
      registry,
      { approvalId: approval.id, action: "approve" },
      { publish: (event) => events.push(event) },
      () => { throw new Error("injected_resume_failure"); },
    );
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const response = await fetch(`http://127.0.0.1:${address.port}/approvals/${approval.id}/approve?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
    });
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(result.approval.status, "approved");
    assert.equal(result.postCommit?.status, "deferred");
    assert.equal(action.status, "approved", "an unrelated external action still reflects the durable decision");
    assert.equal(events.length, 1, "the approval invalidation is not skipped by a failed resume callback");
  } finally {
    await new Promise((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
  }
});

test("missing durable approval event never dispatches the approved side effect", async () => {
  const cwd = "/approval-postcommit-event-failure";
  let approval = { id: "approval-event-failure", status: "pending", actionType: "bash", runId: "run-1" };
  let dispatched = false;
  const store = {
    getApprovalRequest: () => approval,
    getRun: () => ({ id: "run-1" }),
    appendEvent: () => { throw new Error("injected_event_storage_failure"); },
    approveApprovalRequest: (_id, decision) => {
      approval = { ...approval, status: "approved", decisionKind: decision.decisionKind };
      return approval;
    },
  };
  const server = createServer((request, response) => {
    void handleApprovalItem(
      request,
      response,
      { host: "127.0.0.1", port: 0, maxBodyBytes: 4096 },
      { getStore: () => store },
      { approvalId: approval.id, action: "approve" },
      undefined,
      () => { dispatched = true; },
    );
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const response = await fetch(`http://127.0.0.1:${address.port}/approvals/${approval.id}/approve?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
    });
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(result.approval.status, "approved");
    assert.equal(result.postCommit?.status, "deferred");
    assert.equal(dispatched, false, "an unrecorded approval must not start a side effect");
  } finally {
    await new Promise((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
  }
});
