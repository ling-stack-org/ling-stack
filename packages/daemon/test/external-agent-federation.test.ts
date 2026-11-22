import assert from "node:assert/strict";
import test from "node:test";
import {
  ExternalAgentFederationError,
  ExternalAgentFederationService,
  type ExternalAgentFederationSnapshot,
} from "../dist/runtime/external-agent/federation.js";

const registration = {
  agentId: "agent_codex",
  adapterKind: "codex-app-server" as const,
  protocolVersion: "codex-app-server/1",
  displayName: "Codex",
  capabilities: ["task.start", "task.reconnect", "task.cancel", "stream_text", "untrusted_capability"],
  workspaceScopes: ["workspace_1"],
  toolScopes: ["read", "grep"],
  approvalModes: ["host_bridged"],
  source: "local" as const,
  version: "1.0.0",
};

function createService(): ExternalAgentFederationService {
  let sequence = 0;
  return new ExternalAgentFederationService({
    now: () => `2026-11-21T00:00:0${sequence++}.000Z`,
    idFactory: () => `id_${sequence++}`,
    maxDispatchDepth: 2,
    maxEventsPerTask: 2,
  });
}

function register(service: ExternalAgentFederationService): string {
  return service.register({ registration, idempotencyKey: "register_1" }).registrationId;
}

function start(service: ExternalAgentFederationService, registrationId: string, overrides: Record<string, unknown> = {}) {
  return service.startTask({
    registrationId,
    submission: {
      workItemId: "work_1",
      workItemRevision: "4",
      objective: "Run the requested change",
      acceptanceSnapshot: { tests: ["unit"] },
      workspaceId: "workspace_1",
      instructionManifestDigest: "instructions_sha",
      idempotencyKey: "submission_1",
      ...overrides,
    },
  });
}

test("federation negotiates capabilities and replays registration idempotently", () => {
  const service = createService();
  const first = service.register({ registration, idempotencyKey: "register_1" });
  const replay = service.register({ registration, idempotencyKey: "register_1" });
  assert.deepEqual(replay, first);
  assert.deepEqual(first.acceptedCapabilities, ["task.start", "task.reconnect", "task.cancel", "stream_text"]);
  assert.deepEqual(first.deniedCapabilities, ["untrusted_capability"]);
  assert.deepEqual(service.readCapabilities(first.registrationId).effectiveWorkspaceScopes, ["workspace_1"]);
});

test("federation rejects capability, workspace and recursive dispatch violations", () => {
  const service = createService();
  const registrationId = register(service);
  assert.throws(() => service.startTask({
    registrationId,
    submission: {
      workItemId: "work_2", workItemRevision: "1", objective: "x", acceptanceSnapshot: {}, workspaceId: "workspace_2",
      instructionManifestDigest: "sha", idempotencyKey: "submission_scope",
    },
  }), (error: unknown) => error instanceof ExternalAgentFederationError && error.code === "workspace_scope_denied");
  assert.throws(() => start(service, registrationId, { parentLineage: ["run_parent", "run_grandparent"] }), (error: unknown) => error instanceof ExternalAgentFederationError && error.code === "dispatch_depth_exceeded");

  const noStart = createService();
  const deniedRegistration = noStart.register({
    registration: { ...registration, agentId: "agent_readonly", capabilities: ["stream_text"] },
    idempotencyKey: "register_readonly",
  });
  assert.throws(() => start(noStart, deniedRegistration.registrationId), (error: unknown) => error instanceof ExternalAgentFederationError && error.code === "capability_denied");
});

test("federation creates task receipts, streams cursors, reconnects and restores durable snapshot", async () => {
  const service = createService();
  const registrationId = register(service);
  const first = start(service, registrationId);
  assert.equal(first.task.status, "accepted");
  const events: string[] = [];
  service.subscribe(event => events.push(`${event.type}:${event.cursor}`));
  service.markRunning(first.task.taskId);
  service.appendEvent(first.task.taskId, { text: "progress" });
  const current = service.getTask(first.task.taskId)?.task;
  assert.equal(current?.status, "running");
  assert.equal(events.length, 2);
  const reconnect = service.reconnectTask({
    registrationId,
    taskId: first.task.taskId,
    submissionId: first.task.submissionId,
    eventCursor: "external-agent:2",
  });
  assert.deepEqual(reconnect.task, current);
  assert.equal(reconnect.resyncRequired, false);
  assert.deepEqual(reconnect.events?.map(event => event.payload), [{ text: "progress" }]);
  assert.equal(service.reconnectTask({
    registrationId,
    taskId: first.task.taskId,
    submissionId: first.task.submissionId,
    eventCursor: "external-agent:1",
  }).resyncRequired, true);

  const snapshot = service.snapshot();
  const restored = createService();
  restored.restore(snapshot);
  assert.deepEqual(restored.getTask(first.task.taskId)?.task, current);
  assert.deepEqual(restored.register({ registration, idempotencyKey: "register_1" }), service.register({ registration, idempotencyKey: "register_1" }));
  const cancellation = await restored.cancelTask({ registrationId, taskId: first.task.taskId, idempotencyKey: "cancel_1" });
  assert.deepEqual(cancellation, { taskId: first.task.taskId, status: "unknown" });
});

test("federation preserves unknown cancellation outcome and rejects conflicting idempotency", async () => {
  const service = createService();
  const registrationId = register(service);
  const task = start(service, registrationId).task;
  const unknown = await service.cancelTask({ registrationId, taskId: task.taskId, idempotencyKey: "cancel_unknown" }, async () => "unknown");
  assert.deepEqual(unknown, { taskId: task.taskId, status: "unknown" });
  assert.equal(service.getTask(task.taskId)?.task.status, "unknown");
  const secondTask = start(service, registrationId, { idempotencyKey: "submission_2" }).task;
  await assert.rejects(() => service.cancelTask({ registrationId, taskId: secondTask.taskId, idempotencyKey: "cancel_unknown" }), (error: unknown) => error instanceof ExternalAgentFederationError && error.code === "idempotency_conflict");
});

test("federation retries a failed ledger write without publishing an uncommitted state", () => {
  let saved: ExternalAgentFederationSnapshot | undefined;
  let fail = false;
  const service = new ExternalAgentFederationService({ persistence: {
    load: () => saved,
    save: snapshot => {
      if (fail) throw new Error("ledger write failed");
      saved = snapshot;
    },
  } });
  const registrationId = register(service);
  const notices: string[] = [];
  service.subscribe(event => notices.push(event.type));
  fail = true;
  assert.throws(() => start(service, registrationId), /ledger write failed/u);
  assert.deepEqual(service.snapshot(), saved);
  assert.deepEqual(notices, []);
  fail = false;
  const { task } = start(service, registrationId);
  assert.equal(task.status, "accepted");
  assert.deepEqual(notices, ["task_started"]);
  fail = true;
  assert.throws(() => service.markRunning(task.taskId), /ledger write failed/u);
  assert.equal(service.getTask(task.taskId)?.task.status, "accepted");
  assert.deepEqual(service.snapshot(), saved);
  assert.deepEqual(notices, ["task_started"]);
  fail = false;
  assert.equal(service.markRunning(task.taskId).status, "running");
  assert.deepEqual(notices, ["task_started", "task_status"]);
});

test("federation turns a revoked registration into an authorization resync", () => {
  const service = createService();
  const registrationId = register(service);
  const task = start(service, registrationId).task;
  service.revokeRegistration(registrationId);
  assert.throws(() => service.readCapabilities(registrationId), (error: unknown) => error instanceof ExternalAgentFederationError && error.code === "authorization_changed");
  const reconnect = service.reconnectTask({
    registrationId,
    taskId: task.taskId,
    submissionId: task.submissionId,
  });
  assert.equal(reconnect.task.taskId, task.taskId);
  assert.equal(reconnect.resyncRequired, true);
  assert.equal(reconnect.reason, "authorization_changed");
});
