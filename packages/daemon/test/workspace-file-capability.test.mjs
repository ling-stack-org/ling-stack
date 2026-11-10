import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { WorkspaceFileCapabilityRegistry } from "../dist/features/previews/workspace-file-capabilities.js";

test("workspace file capability binds durable action scope and expires", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-capability-"));
  await mkdir(join(cwd, "src"));
  const filePath = join(cwd, "src", "example.ts");
  await writeFile(filePath, "export const value = 1;\n");
  const runId = "run-capability";
  const threadId = "thread-capability";
  const actionId = `tool:${runId}:edit-1`;
  const store = fakeStore({ cwd, runId, threadId, actionId, filePath });
  const stores = {
    getStore: (requestedCwd) => requestedCwd === resolve(cwd) ? store : store,
  };
  const registry = new WorkspaceFileCapabilityRegistry();
  const scope = {
    workspaceId: "workspace_default",
    threadId,
    runId,
    actionId,
    participantId: "participant-engineer",
  };
  const issuedAt = new Date("2026-09-03T00:00:00.000Z");
  const capability = registry.issue({
    cwd,
    capabilityTarget: "open_file",
    refId: filePath,
    scope,
    ttlMs: 60_000,
  }, stores, issuedAt);

  assert.match(capability.capabilityId, /^wscap_/u);
  assert.equal(capability.displayPath, "src/example.ts");
  assert.equal(capability.daemonEpoch, registry.daemonEpoch);
  const grant = registry.redeem(capability.capabilityId, scope, stores, { now: new Date("2026-09-03T00:00:30.000Z") });
  assert.match(grant.resource.contentPath, /[\\/]src[\\/]example\.ts$/u);

  assert.throws(
    () => registry.redeem(capability.capabilityId, { ...scope, participantId: "participant-qa" }, stores, { now: new Date("2026-09-03T00:00:30.000Z") }),
    /scope does not match/u,
  );
  assert.throws(
    () => registry.redeem(capability.capabilityId, scope, stores, { now: new Date("2026-09-03T00:01:01.000Z") }),
    /invalid or expired/u,
  );
});

test("workspace file capability rejects a source ref outside the action", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-capability-"));
  await writeFile(join(cwd, "safe.ts"), "export const safe = true;\n");
  const runId = "run-capability-missing-ref";
  const threadId = "thread-capability-missing-ref";
  const actionId = `tool:${runId}:edit-1`;
  const store = fakeStore({ cwd, runId, threadId, actionId, filePath: join(cwd, "safe.ts") });
  const stores = { getStore: () => store };
  const registry = new WorkspaceFileCapabilityRegistry();
  assert.throws(() => registry.issue({
    cwd,
    capabilityTarget: "open_file",
    refId: "secret.env",
    scope: {
      workspaceId: "workspace_default",
      threadId,
      runId,
      actionId,
      participantId: "participant-engineer",
    },
  }, stores), /source ref is not attached/u);
});

test("workspace file capability requires the exact workflow step scope", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-capability-"));
  const filePath = join(cwd, "step.ts");
  await writeFile(filePath, "export const step = true;\n");
  const runId = "run-capability-step";
  const threadId = "thread-capability-step";
  const actionId = `tool:${runId}:edit-1`;
  const store = fakeStore({ cwd, runId, threadId, actionId, filePath, workflowStepId: "step-1" });
  const registry = new WorkspaceFileCapabilityRegistry();
  const base = {
    cwd,
    capabilityTarget: "open_file",
    refId: filePath,
    scope: {
      workspaceId: "workspace_default",
      threadId,
      runId,
      actionId,
      participantId: "participant-engineer",
    },
  };

  assert.throws(() => registry.issue(base, { getStore: () => store }), /workflow step does not match/u);
  assert.doesNotThrow(() => registry.issue({
    ...base,
    scope: { ...base.scope, workflowStepId: "step-1" },
  }, { getStore: () => store }));
});

test("workspace file capability rejects a symlink that resolves outside the workspace", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-capability-"));
  const outside = await mkdtemp(join(tmpdir(), "ling-capability-outside-"));
  const outsidePath = join(outside, "secret.env");
  await writeFile(outsidePath, "TOP_SECRET=redacted\n");
  await symlink(outsidePath, join(cwd, "secret.env"));
  const runId = "run-capability-symlink";
  const threadId = "thread-capability-symlink";
  const store = fakeStore({ cwd, runId, threadId, actionId: `tool:${runId}:edit-1`, filePath: join(cwd, "secret.env") });
  const registry = new WorkspaceFileCapabilityRegistry();
  assert.throws(() => registry.issue({
    cwd,
    capabilityTarget: "open_file",
    refId: join(cwd, "secret.env"),
    scope: {
      workspaceId: "workspace_default",
      threadId,
      runId,
      actionId: `tool:${runId}:edit-1`,
      participantId: "participant-engineer",
    },
  }, { getStore: () => store }), /outside the active workspace/u);
});

test("workspace artifact capability preserves the dedicated artifact target", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-capability-"));
  const artifactsDir = join(cwd, ".ling-stack", "artifacts");
  await mkdir(artifactsDir, { recursive: true });
  const artifact = {
    id: "artifact-report-1",
    runId: "run-capability-artifact",
    type: "diff",
    path: "report.diff",
    title: "Run diff",
    createdAt: "2026-09-03T00:00:01.000Z",
  };
  await writeFile(join(artifactsDir, artifact.path), "--- a/source.ts\n+++ b/source.ts\n");
  const runId = artifact.runId;
  const threadId = "thread-capability-artifact";
  const actionId = `tool:${runId}:edit-1`;
  const filePath = join(cwd, "source.ts");
  await writeFile(filePath, "export const value = 1;\n");
  const store = fakeStore({ cwd, runId, threadId, actionId, filePath, artifact });
  const registry = new WorkspaceFileCapabilityRegistry();
  const scope = {
    workspaceId: "workspace_default",
    threadId,
    runId,
    actionId,
    participantId: "participant-engineer",
  };
  const capability = registry.issue({
    cwd,
    capabilityTarget: "open_artifact",
    refId: artifact.id,
    scope,
  }, { getStore: () => store });
  assert.equal(capability.capabilityTarget, "open_artifact");
  assert.equal(capability.displayPath, "report.diff");
  const grant = registry.redeem(capability.capabilityId, scope, { getStore: () => store }, { capabilityTarget: "open_artifact" });
  assert.equal(grant.resource.kind, "artifact");
  assert.match(grant.resource.contentPath, /[\\/]\.ling-stack[\\/]artifacts[\\/]report\.diff$/u);

  const diffCapability = registry.issue({
    cwd,
    capabilityTarget: "open_diff",
    refId: artifact.id,
    scope,
  }, { getStore: () => store });
  assert.equal(diffCapability.capabilityTarget, "open_diff");
  assert.equal(registry.redeem(diffCapability.capabilityId, scope, { getStore: () => store }, { capabilityTarget: "open_diff" }).resource.kind, "artifact");
});

function fakeStore({ cwd, runId, threadId, actionId, filePath, workflowStepId, artifact }) {
  const start = {
    seq: 1,
    runId,
    type: "tool_start",
    ts: "2026-09-03T00:00:00.000Z",
    data: { toolCallId: "edit-1", toolName: "edit", args: { path: filePath } },
  };
  const end = {
    seq: 2,
    runId,
    type: "tool_end",
    ts: "2026-09-03T00:00:01.000Z",
    data: { toolCallId: "edit-1", toolName: "edit", isError: false, result: { touchedPaths: [filePath] } },
  };
  const artifactEvent = artifact ? {
    seq: 3,
    runId,
    type: "artifact_created",
    ts: "2026-09-03T00:00:01.100Z",
    data: { toolCallId: "edit-1", artifactId: artifact.id },
  } : undefined;
  const events = [start, end, artifactEvent].filter(Boolean);
  return {
    paths: { cwd: resolve(cwd), artifactsDir: join(cwd, ".ling-stack", "artifacts"), identity: { workspaceId: "workspace_default" } },
    getLingThread: (id) => id === threadId ? { id, workspaceId: "workspace_default" } : undefined,
    getRun: (id) => id === runId ? { id, threadId, teammateId: "participant-engineer", workflowStepId, cwd: resolve(cwd), status: "succeeded", createdAt: start.ts, updatedAt: end.ts } : undefined,
    listRuns: () => [{ id: runId, threadId, teammateId: "participant-engineer", workflowStepId, cwd: resolve(cwd), status: "succeeded", createdAt: start.ts, updatedAt: end.ts }],
    listApprovalRequests: () => [],
    listEvents: (id, options = {}) => id === runId ? events.filter((event) => event.seq > (options.afterSeq ?? 0)).slice(0, options.limit ?? 1000) : [],
    getConversationItem: () => undefined,
    getArtifact: (id) => artifact?.id === id ? artifact : undefined,
  };
}
