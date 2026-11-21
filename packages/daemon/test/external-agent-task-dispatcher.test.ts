import assert from "node:assert/strict";
import test from "node:test";
import type { PiRunnerRunOptions } from "@ling-stack/runner-pi";
import type { RegisteredRunner } from "../dist/runtime/runners.js";
import { ExternalAgentFederationService } from "../dist/runtime/external-agent/federation.js";
import { dispatchExternalAgentTask } from "../dist/runtime/external-agent/task-dispatcher.js";

const registration = {
  agentId: "agent-dispatcher",
  adapterKind: "custom" as const,
  protocolVersion: "custom/1",
  displayName: "Dispatcher fixture",
  capabilities: ["task.start", "task.reconnect", "task.cancel", "workItem.dispatch"],
  workspaceScopes: ["workspace_default"],
  toolScopes: ["read"],
  approvalModes: ["host"],
  source: "local" as const,
  version: "1",
};

function makeRunner(run: (options: PiRunnerRunOptions) => Promise<ReturnType<NonNullable<RegisteredRunner["adapter"]["runTask"]>> extends Promise<infer T> ? T : never>): RegisteredRunner {
  return {
    id: "fixture-external",
    displayName: "Fixture External",
    status: "enabled",
    executionBoundary: "external",
    adapterRevision: "fixture-external/v1",
    adapter: { runTask: run },
    toolExecutionConformance: {
      adapterRevision: "fixture-external/v1",
      curatedTools: ["read"],
      toolSideEffects: { read: "workspace_read" },
      allowedSideEffects: ["none", "workspace_read"],
      nativeSideEffectMode: "disabled",
      toolSurfaceCurated: true,
      approvalBridgeVerified: true,
      sandboxBindingVerified: true,
      evidenceCommitVerified: true,
      abortPropagationVerified: true,
      attemptFencingVerified: true,
      workspaceBoundaryVerified: true,
      artifactImportVerified: true,
    },
    toolSideEffects: { read: "workspace_read" },
    resumeCapabilities: { nativeResume: false, hostApprovalContinuation: [] },
    nativeResumeConformance: {
      revision: "fixture-external/v1",
      readinessPassed: true,
      conformancePassed: true,
      abortPropagationVerified: true,
      approvalBridgeVerified: true,
    },
  };
}

function taskFor(federation: ExternalAgentFederationService): string {
  const registered = federation.register({ registration, idempotencyKey: "register-dispatcher" });
  return federation.startTask({
    registrationId: registered.registrationId,
    submission: {
      workItemId: "work-item-dispatcher",
      workItemRevision: "1",
      objective: "Inspect the fixture workspace",
      acceptanceSnapshot: { candidateDigest: "candidate-dispatcher" },
      workspaceId: "workspace_default",
      instructionManifestDigest: "instructions-dispatcher",
      idempotencyKey: "submission-dispatcher",
    },
  }).task.taskId;
}

function options(taskId: string, onEvent?: PiRunnerRunOptions["onEvent"]): PiRunnerRunOptions {
  return {
    cwd: "/tmp/ling-dispatcher",
    task: { id: taskId, title: "Fixture task", prompt: "Inspect the fixture workspace" },
    provider: { provider: "fixture", model: "fixture" },
    tools: ["read"],
    onEvent,
  };
}

test("external federation dispatches through a verified adapter and records events", async () => {
  const federation = new ExternalAgentFederationService({ idFactory: (() => {
    let next = 0;
    return () => `fixture-${++next}`;
  })() });
  const events: string[] = [];
  const runner = makeRunner(async (input) => {
    input.onEvent?.({ type: "run_start", taskId: input.task.id, cwd: input.cwd, provider: "fixture", model: "fixture" });
    input.onEvent?.({ type: "assistant_text_delta", text: "ready" });
    return { taskId: input.task.id, events: [], messages: [] };
  });
  const taskId = taskFor(federation);
  const result = await dispatchExternalAgentTask({
    federation,
    taskId,
    runner,
    options: options(taskId, (event) => events.push(event.type)),
    assertAdmission: () => undefined,
  });
  assert.equal(result.outcome, "completed");
  assert.deepEqual(events, ["run_start", "assistant_text_delta"]);
  assert.equal(federation.getTask(taskId)?.task.status, "completed");
  assert.ok((federation.snapshot().events.filter((event) => event.taskId === taskId)).length >= 4);
});

test("external federation converts adapter failure into unknown outcome", async () => {
  const federation = new ExternalAgentFederationService();
  const runner = makeRunner(async () => { throw new Error("adapter disconnected"); });
  const taskId = taskFor(federation);
  const result = await dispatchExternalAgentTask({ federation, taskId, runner, options: options(taskId) });
  assert.equal(result.outcome, "unknown");
  assert.equal(federation.getTask(taskId)?.task.status, "unknown");
});

test("external federation dispatch rejects unverified or embedded runners", async () => {
  const federation = new ExternalAgentFederationService();
  const taskId = taskFor(federation);
  const embedded = { ...makeRunner(async () => ({ taskId, events: [], messages: [] })), executionBoundary: "embedded" as const };
  await assert.rejects(
    dispatchExternalAgentTask({ federation, taskId, runner: embedded, options: options(taskId) }),
    /not an external adapter/u,
  );
});
