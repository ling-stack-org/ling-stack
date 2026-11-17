import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { createSqliteRunStore, resolveSessionRunPolicy } from "@ling-stack/core";
import type { RunPolicyPreviewResponse } from "@ling-stack/contracts";
import { createDaemonServer } from "../dist/index.js";

async function preview(baseUrl: string, cwd: string, body: unknown): Promise<{ readonly status: number; readonly body: unknown }> {
  const response = await fetch(`${baseUrl}/runs/policy-preview?cwd=${encodeURIComponent(cwd)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

function storeCounts(store: ReturnType<typeof createSqliteRunStore>) {
  return {
    runs: store.listRuns({}).length,
    approvals: store.listApprovalRequests({}).length,
    channels: store.listChannels({}).length,
    tasks: store.listTasks({}).length,
    policy: store.getApprovalPolicy(),
  };
}

test("policy preview uses the run resolver and does not create durable state", async (t) => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-policy-preview-"));
  const store = createSqliteRunStore(cwd);
  const channel = store.createChannel({ name: "Preview", boundPath: resolve(cwd, "project") }, new Date().toISOString());
  const task = store.createTask({ channelId: channel.id, title: "Preview task", prompt: "Inspect policy" }, new Date().toISOString());
  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd }, {
    storeFactory: (root) => {
      assert.equal(root, cwd);
      return store;
    },
  });
  t.after(async () => {
    await daemon.stop();
    store.close();
    await rm(cwd, { recursive: true, force: true });
  });
  await daemon.start();
  const address = daemon.server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const before = storeCounts(store);
  const response = await preview(baseUrl, cwd, {
    channelId: channel.id,
    taskId: task.id,
    permissionPreset: "workspace_collaboration",
    approvalProfile: { mode: "strict", risk: "medium", requiredForTools: ["bash"] },
  });
  assert.equal(response.status, 200);
  const body = response.body as RunPolicyPreviewResponse;
  const expected = resolveSessionRunPolicy({
    workspacePolicy: before.policy,
    permissionPreset: "workspace_collaboration",
    channelBoundPath: channel.boundPath ?? cwd,
    approvalProfile: { mode: "strict", risk: "medium", requiredForTools: ["bash"] },
  });
  assert.equal(body.permissionPreset, "workspace_collaboration");
  assert.equal(body.permissionMode, expected.snapshot.mode);
  assert.deepEqual(body.effectivePolicySnapshot, expected.snapshot);
  assert.equal(body.requiresConfirmation, false);
  assert.deepEqual(storeCounts(store), before);
});

test("policy preview marks full access confirmation and rejects malformed or conflicting scope", async (t) => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-policy-preview-errors-"));
  const store = createSqliteRunStore(cwd);
  const first = store.createChannel({ name: "First", boundPath: cwd }, new Date().toISOString());
  const second = store.createChannel({ name: "Second", boundPath: cwd }, new Date().toISOString());
  const task = store.createTask({ channelId: first.id, title: "Task", prompt: "Preview" }, new Date().toISOString());
  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd }, { storeFactory: () => store });
  t.after(async () => {
    await daemon.stop();
    store.close();
    await rm(cwd, { recursive: true, force: true });
  });
  await daemon.start();
  const address = daemon.server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const fullAccess = await preview(baseUrl, cwd, { permissionPreset: "full_access" });
  assert.equal(fullAccess.status, 200);
  assert.equal((fullAccess.body as RunPolicyPreviewResponse).requiresConfirmation, true);

  const malformedProfile = await preview(baseUrl, cwd, { approvalProfile: { mode: "unsafe" } });
  assert.equal(malformedProfile.status, 400);
  assert.equal((malformedProfile.body as { readonly error: string }).error, "bad_request");

  const conflictingMode = await preview(baseUrl, cwd, {
    permissionPreset: "read_only",
    permissionMode: "full_access",
  });
  assert.equal(conflictingMode.status, 400);

  const conflictingScope = await preview(baseUrl, cwd, { channelId: second.id, taskId: task.id });
  assert.equal(conflictingScope.status, 409);
  assert.equal((conflictingScope.body as { readonly error: string }).error, "policy_preview_scope_conflict");

  const missingChannel = await preview(baseUrl, cwd, { channelId: "missing-channel" });
  assert.equal(missingChannel.status, 404);
  assert.equal((missingChannel.body as { readonly error: string }).error, "channel_not_found");
});
