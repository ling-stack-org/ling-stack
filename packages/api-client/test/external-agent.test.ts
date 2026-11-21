import assert from "node:assert/strict";
import test from "node:test";
import { LingAppServerClient, type LingAppServerSocket } from "../dist/app-server.js";

class FederationSocket implements LingAppServerSocket {
  readonly readyState = 1;
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();
  private nextRegistration = 1;

  send(data: string): void {
    const request = JSON.parse(data) as { readonly id: number; readonly method: string; readonly params?: any };
    queueMicrotask(() => {
      const result = request.method === "initialize"
        ? {
            protocolVersion: "ling-app-server/1",
            serverInfo: { name: "fixture", version: "1" },
            connectionId: "connection_1",
            effectiveScopes: ["externalAgent.federation"],
            capabilities: ["externalAgent.federation"],
            limits: { maxInboundFrameBytes: 1024, maxOutboundFrameBytes: 1024 },
          }
        : request.method === "externalAgent/register"
          ? {
              registrationId: `registration_${this.nextRegistration++}`,
              agentId: request.params.registration.agentId,
              acceptedCapabilities: request.params.registration.capabilities,
              deniedCapabilities: [],
              authorizationEpoch: "auth_1",
            }
          : request.method === "externalAgent/capabilities/read"
            ? {
                registrationId: request.params.registrationId,
                capabilities: ["task.start", "task.reconnect", "task.cancel"],
                effectiveWorkspaceScopes: ["workspace_1"],
                effectiveToolScopes: ["read"],
                approvalModes: ["host_bridged"],
                authorizationEpoch: "auth_1",
              }
            : request.method === "externalAgent/task/start"
              ? { task: { taskId: "task_1", submissionId: "submission_1", workItemId: "work_1", workItemRevision: "1", status: "accepted", dispatchDepth: 1 } }
              : request.method === "externalAgent/task/reconnect"
                ? { task: { taskId: "task_1", submissionId: "submission_1", workItemId: "work_1", workItemRevision: "1", status: "running", dispatchDepth: 1 }, resyncRequired: false }
                : request.method === "externalAgent/task/cancel"
                  ? { taskId: "task_1", status: "cancelled" }
                  : {};
      this.emit("message", JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
    });
  }

  close(): void {}

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

test("Ling App Server client exposes typed external Agent federation operations", async () => {
  const client = new LingAppServerClient({
    url: "ws://fixture/app-server/rpc",
    createSocket: () => new FederationSocket(),
    clientInfo: { name: "fixture", version: "1" },
    requiredCapabilities: ["externalAgent.federation"],
  });
  const registration = await client.registerExternalAgent({
    registration: {
      agentId: "agent_1",
      adapterKind: "codex-app-server",
      protocolVersion: "codex/1",
      displayName: "Codex",
      capabilities: ["task.start"],
      workspaceScopes: ["workspace_1"],
      toolScopes: ["read"],
      approvalModes: ["host_bridged"],
      source: "local",
      version: "1",
    },
    idempotencyKey: "register_1",
  });
  assert.equal(registration.agentId, "agent_1");
  assert.deepEqual(await client.readExternalAgentCapabilities({ registrationId: registration.registrationId }), {
    registrationId: registration.registrationId,
    capabilities: ["task.start", "task.reconnect", "task.cancel"],
    effectiveWorkspaceScopes: ["workspace_1"],
    effectiveToolScopes: ["read"],
    approvalModes: ["host_bridged"],
    authorizationEpoch: "auth_1",
  });
  const task = await client.startExternalAgentTask({
    registrationId: registration.registrationId,
    submission: {
      workItemId: "work_1", workItemRevision: "1", objective: "Inspect", acceptanceSnapshot: {}, workspaceId: "workspace_1",
      instructionManifestDigest: "instructions", idempotencyKey: "submission_1",
    },
  });
  assert.equal(task.task.taskId, "task_1");
  assert.equal((await client.reconnectExternalAgentTask({ registrationId: registration.registrationId, taskId: "task_1", submissionId: "submission_1" })).resyncRequired, false);
  assert.deepEqual(await client.cancelExternalAgentTask({ registrationId: registration.registrationId, taskId: "task_1", idempotencyKey: "cancel_1" }), { taskId: "task_1", status: "cancelled" });
});
