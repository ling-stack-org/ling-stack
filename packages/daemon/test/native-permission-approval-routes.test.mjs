import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { LingDaemonClient } from "../../api-client/dist/index.js";
import { nativePermissionFixture } from "../../core/test/fixtures/native-permission-fixture.mjs";
import { handleApprovalItem } from "../dist/features/runs/routes.js";

async function fixture(t) {
  const f = await nativePermissionFixture(t);
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const match = /^\/approvals\/([^/]+)(?:\/(approve|deny))?$/.exec(url.pathname);
    if (!match) { response.writeHead(404).end(); return; }
    void handleApprovalItem(request, response, { host: "127.0.0.1", port: 0, maxBodyBytes: 65536 },
      { getStore: cwd => { assert.equal(cwd, f.cwd); return f.store; } },
      { approvalId: decodeURIComponent(match[1]), action: match[2] }).catch(error => {
        response.writeHead(500).end(JSON.stringify({ error: error.message }));
      });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const client = new LingDaemonClient({ baseUrl });
  const request = async (id, action, input) => {
    const response = await fetch(`${baseUrl}/approvals/${id}/${action}?cwd=${encodeURIComponent(f.cwd)}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
    });
    return { status: response.status, body: await response.json() };
  };
  return { ...f, client, request };
}

test("HTTP/API client approves the saved turn proposal only through explicit scope consent", async (t) => {
  const f = await fixture(t);
  const approval = f.create();
  const result = await f.client.approveApproval(f.cwd, approval.id, { decisionKind: "approve_permission_scope" });
  assert.equal(result.approval.status, "approved");
  assert.equal(result.approval.decisionKind, "approve_permission_scope");
  assert.deepEqual(result.approval.payload, f.payload);
  assert.equal(f.store.getApprovalCheckpointForApproval(approval.id).status, "approved");
  assert.equal(f.store.getNativeApprovalCorrelation(approval.id).replyStatus, "pending");
  const event = f.store.listEvents(f.run.id).find(item => item.type === "approval_approved");
  assert.equal(event.data.decisionKind, "approve_permission_scope");
});

test("HTTP native decision publication is idempotent when the waiting connection publishes first", async t => {
  const f = await fixture(t);
  f.store.transitionRunStatus({ runId: f.run.id, event: "runner_started", actor: "system", now: f.now });
  for (const event of ["claim", "runner_started"]) f.store.transitionWorkUnitStatus({ ...f.key.fence, event, actor: "system", now: f.now });
  f.store.updateWorkUnitAttemptStatus({ ...f.key.fence, status: "started", now: f.now });
  const approval = f.create();
  f.store.synchronizeNativeApprovalWait(f.key, f.now);
  const waitingConnection = f.open();
  const approve = f.store.approveApprovalRequest.bind(f.store);
  f.store.approveApprovalRequest = (...args) => {
    const result = approve(...args);
    waitingConnection.synchronizeNativeApprovalWait(f.key, args[2]);
    return result;
  };
  const response = await f.client.approveApproval(f.cwd, approval.id, { decisionKind: "approve_permission_scope" });
  assert.equal(response.approval.status, "approved");
  const events = f.store.listEvents(f.run.id).filter(event => event.type === "approval_approved");
  assert.equal(events.length, 1);
  assert.equal(events[0].data.decisionKind, "approve_permission_scope");
  assert.equal(f.store.getNativeApprovalCorrelation(approval.id).replyStatus, "pending");
});

test("HTTP default/once and unknown decisions cannot resolve turn permission requests", async (t) => {
  const f = await fixture(t);
  const approval = f.create();
  for (const input of [{}, { decisionKind: "approve_once" }]) {
    const result = await f.request(approval.id, "approve", input);
    assert.equal(result.status, 409);
    assert.equal(result.body.error, "approval_decision_unavailable");
    assert.equal(f.store.getApprovalRequest(approval.id).status, "pending");
  }
  assert.equal((await f.request(approval.id, "approve", { decisionKind: "approve_all" })).status, 400);
  assert.equal(f.store.listEvents(f.run.id).filter(item => item.type === "approval_approved").length, 0);
  assert.equal((await f.client.denyApproval(f.cwd, approval.id)).approval.status, "denied");
});

test("HTTP cannot replace stored resource scope or use scope consent on an ordinary approval", async (t) => {
  const f = await fixture(t);
  const scope = f.create();
  const result = await f.request(scope.id, "approve", { decisionKind: "approve_permission_scope", scope: "session",
    resources: [{ kind: "network", access: "connect" }], payload: { ...f.payload, scope: "session" } });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.approval.payload, f.payload);
  const ordinary = f.store.createApprovalRequest({ runId: f.run.id, taskId: f.run.taskId,
    actionType: "bash", risk: "medium", title: "Command", description: "fixture",
    payload: { type: "bash", cwd: f.cwd, command: "echo fixture", riskFlags: [] } }, f.now);
  assert.equal((await f.request(ordinary.id, "approve", { decisionKind: "approve_permission_scope" })).status, 409);
  const once = await f.client.approveApproval(f.cwd, ordinary.id);
  assert.equal(once.approval.decisionKind, "approve_once");
});

test("expired and already-resolved scope requests stay terminal through HTTP", async (t) => {
  const f = await fixture(t);
  const expired = f.create({ expiresAt: f.now });
  assert.notEqual((await f.request(expired.id, "approve", { decisionKind: "approve_permission_scope" })).status, 200);
  assert.equal(f.store.getApprovalRequest(expired.id).status, "expired");
  const approved = f.create();
  await f.client.approveApproval(f.cwd, approved.id, { decisionKind: "approve_permission_scope" });
  assert.notEqual((await f.request(approved.id, "deny", {})).status, 200);
  assert.equal(f.store.getApprovalRequest(approved.id).status, "approved");
  assert.deepEqual(f.store.listApprovalCommandRules(), []);
});
