import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import { createDaemonServer } from "../dist/index.js";

test("App Server exposes development checks and external Agent admission", { timeout: 10_000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-app-server-development-rpc-"));
  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd });
  await daemon.start();
  const address = daemon.server.address();
  assert.ok(address && typeof address === "object");
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/app-server/rpc?cwd=${encodeURIComponent(cwd)}`);
  const messages = [];
  socket.on("message", data => messages.push(JSON.parse(String(data))));
  const send = (id, method, params) => socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  try {
    await once(socket, "open");
    send(1, "initialize", {
      protocolVersions: ["ling-app-server/1"],
      requiredCapabilities: ["development.verify", "development.instructions", "externalAgent.federation"],
    });
    await waitFor(messages, message => message.id === 1);

    send(2, "doctor/run", { cwd });
    const doctor = await waitFor(messages, message => message.id === 2);
    assert.ok(["ok", "warning", "fail"].includes(doctor.result.overallStatus));

    send(3, "instructions/init", { cwd, mode: "preview", idempotencyKey: "instructions-1" });
    const instructions = await waitFor(messages, message => message.id === 3);
    assert.equal(instructions.result.status, "draft");

    send(4, "verify/plan", {
      cwd,
      candidate: { workspaceId: cwd, candidateDigest: "candidate-rpc" },
      requestedChecks: ["typecheck"],
    });
    const plan = await waitFor(messages, message => message.id === 4);
    assert.equal(plan.result.checks.length, 1);
    assert.equal(plan.result.checks[0].kind, "typecheck");
    send(40, "verify/start", {
      planId: plan.result.planId, planRevision: plan.result.planRevision,
      candidateDigest: "candidate-rpc", idempotencyKey: "start-without-operator",
    });
    assert.equal((await waitFor(messages, message => message.id === 40)).error.data.code, "authorization_required");

    send(5, "workItem/create", { cwd, sourceType: "manual", sourceId: "external-rpc", title: "External task" });
    const created = await waitFor(messages, message => message.id === 5);
    assert.equal(created.result.workItem.status, "intake");
    const acceptance = { workItemId: created.result.workItem.workItemId, expectedWorkItemRevision: Number(created.result.workItem.revision), idempotencyKey: "accept-rpc-1" };
    send(50, "workItem/accept", acceptance);
    const accepted = (await waitFor(messages, message => message.id === 50)).result;
    assert.equal(accepted.workItem.status, "ready");
    send(51, "workItem/accept", acceptance);
    const replayed = (await waitFor(messages, message => message.id === 51)).result;
    assert.equal(replayed.replayed, true);
    assert.deepEqual(replayed.acceptance, accepted.acceptance);
    const workItem = accepted.workItem;
    send(6, "externalAgent/register", {
      registration: {
        agentId: "agent-rpc",
        adapterKind: "acp",
        protocolVersion: "acp/1",
        displayName: "RPC Agent",
        capabilities: ["task.start", "task.reconnect", "task.cancel", "workItem.dispatch"],
        workspaceScopes: ["workspace_default"],
        toolScopes: ["read"],
        approvalModes: ["host"],
        source: "local",
        version: "1",
      },
      idempotencyKey: "register-rpc-1",
    });
    const registered = await waitFor(messages, message => message.id === 6);
    assert.ok(registered.result.acceptedCapabilities.includes("task.start"));
    send(7, "externalAgent/task/start", {
      cwd,
      registrationId: registered.result.registrationId,
      submission: {
        workItemId: workItem.workItemId,
        workItemRevision: workItem.revision,
        objective: "Inspect the candidate",
        acceptanceSnapshot: { candidateDigest: "candidate-rpc" },
        workspaceId: "workspace_default",
        instructionManifestDigest: "instructions-rpc",
        idempotencyKey: "submission-rpc-1",
      },
    });
    const started = await waitFor(messages, message => message.id === 7);
    assert.equal(started.result.task.status, "accepted");
  } finally {
    socket.terminate();
    await daemon.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

async function waitFor(messages, predicate) {
  for (const message of messages) if (predicate(message)) return message;
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error("Timed out waiting for App Server response")), 2_000);
    const timer = setInterval(() => {
      const message = messages.find(predicate);
      if (!message) return;
      clearTimeout(deadline);
      clearInterval(timer);
      resolve(message);
    }, 10);
  });
}
