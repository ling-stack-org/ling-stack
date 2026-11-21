import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createDaemonServer } from "../dist/index.js";
import { createSqliteRunStore } from "../../core/dist/index.js";

test("companion attention endpoint returns a workspace projection", async (t) => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-companion-attention-"));
  const store = createSqliteRunStore(cwd);
  const daemon = createDaemonServer(
    { host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd },
    { storeFactory: () => store },
  );
  t.after(async () => {
    await daemon.stop();
    await rm(cwd, { recursive: true, force: true });
  });
  await daemon.start();
  const address = daemon.server.address();
  assert.ok(address && typeof address === "object");
  const now = new Date().toISOString();
  store.createRun({
    id: "run_companion_attention_expiry",
    cwd,
    taskId: "task_companion_attention_expiry",
    providerName: "test-provider",
    providerModel: "test-model",
    taskSnapshot: { id: "task_companion_attention_expiry", title: "Companion attention expiry" },
    providerSnapshot: { provider: "test-provider", model: "test-model" },
    requestSnapshot: { cwd },
    createdAt: now,
  });
  const expiredApproval = store.createApprovalRequest({
    runId: "run_companion_attention_expiry",
    taskId: "task_companion_attention_expiry",
    actionType: "bash",
    risk: "medium",
    title: "Expired approval",
    description: "This must not be projected as actionable.",
    payload: { type: "bash", cwd, command: "echo expired", riskFlags: [] },
    expiresAt: new Date(Date.now() - 1_000).toISOString(),
  }, now);
  const url = "http://127.0.0.1:" + address.port + "/companion-attention?cwd=" + encodeURIComponent(cwd);
  const response = await fetch(url);
  assert.equal(response.status, 200);
  const projection = await response.json();
  assert.equal(projection.schemaVersion, 1);
  assert.equal(projection.cwd, cwd);
  assert.ok(Array.isArray(projection.items));
  assert.equal(store.getApprovalRequest(expiredApproval.id)?.status, "expired");
  assert.equal(projection.items.some(item => item.id === `approval:${expiredApproval.id}`), false);
  assert.equal((await fetch(url, { method: "POST" })).status, 405);
});
