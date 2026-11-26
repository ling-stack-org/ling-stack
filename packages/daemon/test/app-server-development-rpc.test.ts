import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LingAppServerClient, type LingAppServerSocket } from "@ling-stack/api-client";
import { createSqliteRunStore, resolveStoragePaths } from "@ling-stack/core";
import { WebSocket } from "ws";
import { createDaemonServer } from "../dist/index.js";

test("App Server exposes development checks and external Agent admission", { timeout: 15_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "ling-app-server-development-rpc-"));
  const cwd = join(root, "workspace");
  await mkdir(cwd);
  const authToken = randomUUID();
  const createDaemon = (token?: string) => createDaemonServer({
    host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd, authToken: token,
  }, {
    storeFactory(workspace) {
      return createSqliteRunStore(workspace, resolveStoragePaths(workspace, {
        homeDir: root, env: {}, workspaceStateLocation: "repo-local",
      }).workspace);
    },
  });
  let daemon = createDaemon(authToken);
  const connect = async (token?: string) => {
    const address = daemon.server.address();
    assert.ok(address && typeof address === "object");
    const url = new URL(`ws://127.0.0.1:${address.port}/app-server/rpc`);
    url.searchParams.set("cwd", cwd);
    const client = new LingAppServerClient({
      url: url.href, clientInfo: { name: "Development RPC tests", version: "1" },
      requiredCapabilities: ["development.verify", "development.instructions", "externalAgent.federation"],
      createSocket: address => new WebSocket(address, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      }) as unknown as LingAppServerSocket,
    });
    t.after(() => client.close());
    await client.connect();
    return client;
  };
  t.after(async () => {
    await daemon.stop();
    await rm(root, { recursive: true, force: true });
  });

  await daemon.start();
  const operator = await connect(authToken);
  const doctor = await operator.runDoctor({ cwd });
  assert.ok(["ok", "warning", "fail"].includes(doctor.overallStatus));
  const instructions = await operator.initializeInstructions({ cwd, mode: "preview", idempotencyKey: "instructions-1" });
  assert.equal(instructions.status, "draft");

  const plan = await operator.planVerification({
    cwd, candidate: { workspaceId: cwd, candidateDigest: "candidate-rpc" }, requestedChecks: ["typecheck"],
  });
  assert.deepEqual(plan.checks.map(check => check.kind), ["typecheck"]);

  const { workItem: created } = await operator.createWorkItem({ cwd, sourceType: "manual", sourceId: "external-rpc", title: "External task" });
  assert.equal(created.status, "intake");
  const acceptance = {
    workItemId: created.workItemId, expectedWorkItemRevision: Number(created.revision), idempotencyKey: "accept-rpc-1",
  };
  const accepted = await operator.acceptWorkItem(acceptance);
  assert.equal(accepted.workItem.status, "ready");
  const replayed = await operator.acceptWorkItem(acceptance);
  assert.equal(replayed.replayed, true);
  assert.deepEqual(replayed.acceptance, accepted.acceptance);

  operator.close();
  await daemon.stop();
  daemon = createDaemon();
  await daemon.start();
  const observer = await connect();
  await assert.rejects(observer.startVerification({
    planId: plan.planId, planRevision: plan.planRevision,
    candidateDigest: "candidate-rpc", idempotencyKey: "start-without-operator",
  }), { code: "authorization_required" });
  await assert.rejects(observer.acceptWorkItem(acceptance), { code: "authorization_required" });

  const registered = await observer.registerExternalAgent({
    registration: {
      agentId: "agent-rpc", adapterKind: "acp", protocolVersion: "acp/1", displayName: "RPC Agent",
      capabilities: ["task.start", "task.reconnect", "task.cancel", "workItem.dispatch"],
      workspaceScopes: ["workspace_default"], toolScopes: ["read"], approvalModes: ["host"], source: "local", version: "1",
    },
    idempotencyKey: "register-rpc-1",
  });
  assert.ok(registered.acceptedCapabilities.includes("task.start"));
  const started = await observer.startExternalAgentTask({
    registrationId: registered.registrationId,
    submission: {
      workItemId: accepted.workItem.workItemId, workItemRevision: accepted.workItem.revision,
      objective: "Inspect the candidate", acceptanceSnapshot: { candidateDigest: "candidate-rpc" },
      workspaceId: "workspace_default", instructionManifestDigest: "instructions-rpc", idempotencyKey: "submission-rpc-1",
    },
  });
  assert.equal(started.task.status, "accepted");
});
