import assert from "node:assert/strict";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Worker } from "node:worker_threads";
import { buildRuntimePermissionGrant } from "../dist/index.js";
import { nativePermissionFixture } from "./fixtures/native-permission-fixture.mjs";

test("native turn scope offers explicit consent, never legacy once", async (t) => {
  const f = await nativePermissionFixture(t);
  const approval = f.create();
  assert.deepEqual(approval.availableDecisions, ["approve_permission_scope", "deny"]);
  for (const input of [{}, { decisionKind: "approve_once" }, { decisionKind: "approve_command_rule" }, { decisionKind: "approve_all" }]) {
    assert.throws(() => f.store.approveApprovalRequest(approval.id, input, f.now));
    assert.equal(f.store.getApprovalRequest(approval.id).status, "pending");
    assert.equal(f.store.getApprovalCheckpointForApproval(approval.id).status, "pending");
  }
});

test("explicit scope consent persists exactly and grants one fenced reply, not a Pi or workspace grant", async (t) => {
  const f = await nativePermissionFixture(t);
  const approval = f.create();
  const resolved = f.store.approveApprovalRequest(approval.id, { decisionKind: "approve_permission_scope" }, f.now);
  assert.equal(resolved.decisionKind, "approve_permission_scope");
  assert.deepEqual(resolved.payload, f.payload);
  assert.equal(buildRuntimePermissionGrant(resolved, f.now, "continuation"), undefined);
  assert.deepEqual(f.store.listApprovalCommandRules(), []);
  const reopened = f.open();
  assert.deepEqual(reopened.getApprovalRequest(approval.id), resolved);
  const key = { approvalId: approval.id, fence: f.key.fence };
  const claimed = reopened.claimNativeApprovalReply(key, f.now);
  assert.equal(claimed.approval.decisionKind, "approve_permission_scope");
  assert.throws(() => f.store.claimNativeApprovalReply(key, f.now), { code: "native_approval_unavailable" });
  reopened.settleNativeApprovalReply({ ...key, outcome: "written" }, f.now);
  assert.equal(f.store.getNativeApprovalCorrelation(approval.id).replyStatus, "written");
});

test("ordinary and Pi approvals cannot be converted into native scope consent", async (t) => {
  const f = await nativePermissionFixture(t);
  for (const availableDecisions of [undefined, ["approve_once", "deny"], ["approve_permission_scope", "deny"]]) {
    const approval = f.store.createApprovalRequest({ runId: f.run.id, taskId: f.run.taskId,
      actionType: "bash", risk: "medium", title: "Command", description: "fixture",
      payload: { type: "bash", command: "echo fixture", cwd: f.cwd, riskFlags: [] }, availableDecisions }, f.now);
    assert.throws(() => f.store.approveApprovalRequest(approval.id, { decisionKind: "approve_permission_scope" }, f.now));
    assert.equal(f.store.getApprovalRequest(approval.id).status, "pending");
    if (!availableDecisions?.includes("approve_permission_scope")) {
      assert.equal(f.store.approveApprovalRequest(approval.id, {}, f.now).decisionKind, "approve_once");
    }
  }
});

test("offered decision restrictions apply even to ordinary approvals", async (t) => {
  const f = await nativePermissionFixture(t);
  const approval = f.store.createApprovalRequest({ runId: f.run.id, taskId: f.run.taskId,
    actionType: "bash", risk: "medium", title: "Command", description: "fixture",
    payload: { type: "bash", command: "echo fixture", cwd: f.cwd, riskFlags: [] }, availableDecisions: ["deny"] }, f.now);
  assert.throws(() => f.store.approveApprovalRequest(approval.id, {}, f.now));
  assert.equal(f.store.getApprovalRequest(approval.id).status, "pending");
  assert.equal(f.store.denyApprovalRequest(approval.id, {}, f.now).status, "denied");
});

test("existing Pi continuation permission approvals retain once semantics and reject native scope consent", async (t) => {
  const f = await nativePermissionFixture(t);
  const payload = { type: "runtime_permission_request", requestKind: "core_tool", requestedByRunId: f.run.id,
    reason: "Use read", requestedScope: { kind: "core_tool", tools: ["read"] },
    currentScope: { tools: [], allowedWritePaths: [], mcpToolRefs: [], runnerId: "pi" },
    proposedContinuation: { mode: "queue_followup", toolDelta: ["read"], reason: "Use a continuation" } };
  const approval = f.store.createApprovalRequest({ runId: f.run.id, taskId: f.run.taskId,
    actionType: "runtime_permission_request", risk: "low", title: "Permission", description: payload.reason, payload }, f.now);
  assert.throws(() => f.store.approveApprovalRequest(approval.id, { decisionKind: "approve_permission_scope" }, f.now));
  const approved = f.store.approveApprovalRequest(approval.id, {}, f.now);
  assert.equal(approved.decisionKind, "approve_once");
  assert.deepEqual(buildRuntimePermissionGrant(approved, f.now, "continuation").scope, payload.requestedScope);
});

test("native scope rejects missing lifetime, empty or malformed resources and mismatched action", async (t) => {
  const f = await nativePermissionFixture(t);
  const invalid = [
    { payload: { ...f.payload, scope: "session" } },
    { payload: { ...f.payload, version: 2 } },
    { payload: { ...f.payload, scope: undefined } },
    { payload: { ...f.payload, resources: [] } },
    { payload: { ...f.payload, resources: [{ kind: "network", access: "connect", host: "hidden-extra-scope" }] } },
    { payload: { ...f.payload, resources: [{ kind: "filesystem", access: "execute", target: { kind: "path", path: f.cwd } }] } },
    { payload: { ...f.payload, resources: [{ kind: "filesystem", access: ["write"], target: { kind: "path", path: f.cwd } }] } },
    { payload: { ...f.payload, resources: [{ kind: "filesystem", access: "read", target: { kind: "special", name: ["root"] } }] } },
    { payload: { ...f.payload, resources: [{ kind: "filesystem", access: "read", target: { kind: "path", path: "relative" } }] } },
    { payload: { ...f.payload, resources: [{ kind: "filesystem", access: "read", target: { kind: "special", name: "unknown" } }] } },
    { payload: { ...f.payload, resources: [{ kind: "network", access: "connect" }], fileSystemScanDepth: 0 } },
    { payload: { ...f.payload, resources: [{ kind: "filesystem", access: "deny", target: { kind: "path", path: f.cwd } }] } },
    { payload: { ...f.payload, resources: Array.from({ length: 257 }, () => f.payload.resources[0]) } },
    { actionType: "bash" }, { expiresAt: undefined }, { expiresAt: 123 },
  ];
  for (const changes of invalid) {
    assert.throws(() => f.create(changes), { code: "native_journal_invalid" });
    assert.equal(f.store.listApprovalRequests({ runId: f.run.id }).length, 0);
  }
});

test("normalized filesystem entries retain deny boundaries, patterns and symbolic roots", async (t) => {
  const f = await nativePermissionFixture(t);
  const payload = { ...f.payload, fileSystemScanDepth: 3, resources: [
    { kind: "network", access: "connect" },
    { kind: "filesystem", access: "write", target: { kind: "path", path: f.cwd } },
    { kind: "filesystem", access: "deny", target: { kind: "glob", pattern: `${f.cwd}/**/.git/**` } },
    ...["root", "minimal", "project_roots", "tmpdir", "slash_tmp"].map(name => ({ kind: "filesystem", access: "read", target: { kind: "special", name } })),
    { kind: "filesystem", access: "read", target: { kind: "special", name: "project_roots", subpath: "docs" } },
  ] };
  assert.deepEqual(f.create({ payload }).payload, payload);
});

test("scope decision and checkpoint roll back together on persistence failure", async (t) => {
  const f = await nativePermissionFixture(t);
  const approval = f.create();
  const db = new DatabaseSync(f.store.paths.databasePath);
  t.after(() => db.close());
  db.exec("CREATE TRIGGER fail_scope_checkpoint BEFORE UPDATE ON approval_checkpoints BEGIN SELECT RAISE(ABORT, 'fixture checkpoint failure'); END");
  assert.throws(() => f.store.approveApprovalRequest(approval.id, { decisionKind: "approve_permission_scope" }, f.now), /fixture checkpoint failure/);
  assert.equal(f.store.getApprovalRequest(approval.id).status, "pending");
  assert.equal(f.store.getApprovalCheckpointForApproval(approval.id).status, "pending");
  assert.equal(f.store.getNativeApprovalCorrelation(approval.id).replyStatus, "pending");
  db.exec("DROP TRIGGER fail_scope_checkpoint");
  assert.equal(f.store.approveApprovalRequest(approval.id, { decisionKind: "approve_permission_scope" }, f.now).status, "approved");
});

test("expired native scope cannot be approved or claimed", async (t) => {
  const f = await nativePermissionFixture(t);
  const approval = f.create({ expiresAt: f.now });
  assert.throws(() => f.store.approveApprovalRequest(approval.id, { decisionKind: "approve_permission_scope" }, f.now));
  assert.equal(f.store.getApprovalRequest(approval.id).status, "pending");
  assert.throws(() => f.store.claimNativeApprovalReply({ approvalId: approval.id, fence: f.key.fence }, f.now), { code: "native_approval_unavailable" });
});

test("scope denial, native cancellation and stale Attempt fences remain authoritative", async (t) => {
  const f = await nativePermissionFixture(t);
  const denied = f.create();
  f.store.denyApprovalRequest(denied.id, {}, f.now);
  assert.equal(f.store.claimNativeApprovalReply({ approvalId: denied.id, fence: f.key.fence }, f.now).approval.decisionKind, "deny");
  const cancelled = f.create();
  f.store.resolveNativeApprovalRequest({ approvalId: cancelled.id, fence: f.key.fence }, f.now);
  assert.throws(() => f.store.approveApprovalRequest(cancelled.id, { decisionKind: "approve_permission_scope" }, f.now), /not pending/);
  const stale = f.create();
  f.store.approveApprovalRequest(stale.id, { decisionKind: "approve_permission_scope" }, f.now);
  f.store.updateWorkUnitAttemptStatus({ ...f.key.fence, status: "cancelling", now: f.now });
  assert.throws(() => f.store.claimNativeApprovalReply({ approvalId: stale.id, fence: f.key.fence }, f.now), { code: "native_owner_mismatch" });
});

test("independent SQLite connections cannot both resolve the same scope approval", async (t) => {
  const f = await nativePermissionFixture(t);
  const approval = f.create();
  const workers = [true, false].map(approve => new Worker(new URL("fixtures/approval-scope-race.mjs", import.meta.url), {
    workerData: { cwd: f.cwd, id: approval.id, now: f.now, approve },
  }));
  t.after(async () => { await Promise.all(workers.map(worker => worker.terminate())); });
  await Promise.all(workers.map(async worker => assert.deepEqual((await once(worker, "message"))[0], { ready: true })));
  const results = workers.map(worker => once(worker, "message"));
  const exits = workers.map(worker => once(worker, "exit"));
  for (const worker of workers) worker.postMessage("resolve");
  const decisions = (await Promise.all(results)).map(([message]) => message);
  assert.equal(decisions.filter(item => item.status).length, 1);
  assert.equal(decisions.filter(item => item.error).length, 1);
  assert.equal(f.store.getApprovalRequest(approval.id).status, decisions.find(item => item.status).status);
  assert.equal(f.store.getApprovalCheckpointForApproval(approval.id).status, decisions.find(item => item.status).status);
  await Promise.all(exits);
});
