import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteRunStore } from "@ling-stack/core";
import type { CodeAssessmentSnapshot } from "@ling-stack/contracts";
import { assertCodeAssessmentRequest, restrictCodeAssessmentTools } from "../dist/features/code-assessments/run-policy.js";
import { codeAssessmentRunRequest } from "../dist/features/code-assessments/prompt.js";
import { parseRunRequest, type RunRequest } from "../dist/features/runs/schemas.js";
import type { PiRunnerRunOptions } from "@ling-stack/runner-pi";
import { ToolFreePiRunner } from "./support/tool-free-pi-runner.mjs";

test("assessment policy removes every executable tool surface after ordinary injection", async () => {
  const request = { codeAssessment: { id: "assessment", snapshotDigest: "a".repeat(64) } } as RunRequest;
  const calls: string[] = [];
  const options = {
    tools: ["read", "write"], mcpTools: ["mcp"], hostCapabilityTools: ["host"], mediaGenerationTools: ["media"],
    hooks: { schemaVersion: 1, digest: `sha256:${"a".repeat(64)}`, hooks: [
      { id: "start", event: "run_start", kind: "script", code: "return undefined;" },
    ] },
    initialToolSurface: { toolHydration: true, mediaGeneration: true, userInput: true, delegation: true, nativeFileCreate: true },
    runtimeToolFeatures: { requestPermissions: true, unifiedExec: true, shellSnapshot: true },
    onReadonlyToolCall: () => calls.push("readonly"), onMcpToolCall: () => calls.push("mcp"), onDelegationToolCall: () => calls.push("delegation"),
    onUserInputRequest: () => calls.push("input"), onPermissionRequired: () => calls.push("permission"),
  } as unknown as PiRunnerRunOptions;
  const restricted = restrictCodeAssessmentTools(request, options);
  assert.deepEqual(restricted.tools, []); assert.deepEqual(restricted.mcpTools, []); assert.deepEqual(restricted.hostCapabilityTools, []); assert.deepEqual(restricted.mediaGenerationTools, []);
  assert.deepEqual(restricted.initialToolSurface, { toolHydration: false, mediaGeneration: false, userInput: false, delegation: false, nativeFileCreate: false });
  assert.deepEqual(restricted.runtimeToolFeatures, { requestPermissions: false, unifiedExec: false, shellSnapshot: false });
  assert.equal(restricted.hooks, undefined);
  assert.equal(restricted.onReadonlyToolCall, undefined); assert.equal(restricted.onMcpToolCall, undefined); assert.equal(restricted.onDelegationToolCall, undefined); assert.equal(restricted.onUserInputRequest, undefined);
  assert.equal((await restricted.onToolBefore?.({} as never))?.allowed, false); assert.deepEqual(calls, []);
});

test("review prompt advertises every supported finding severity", async () => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "ling-assessment-prompt-")));
  const store = createSqliteRunStore(cwd);
  const now = new Date().toISOString();
  try {
    const detail = store.createCodeAssessment({ id: "prompt", kind: "review", providerPresetId: "fixture", snapshot: {
      id: "prompt_snapshot", digest: "a".repeat(64), target: { type: "working_tree" }, capturedAt: now,
      files: [], totalFileCount: 0, coverage: "complete", exclusions: [],
    }, now });
    const request = codeAssessmentRunRequest(cwd, detail);
    assert.match(request.systemPrompt ?? "", /critical\|high\|medium\|low\|info/u);
  } finally { store.close(); await rm(cwd, { recursive: true, force: true }); }
});

test("assessment admission rejects forged, stale, writable and foreign execution bindings", async () => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "ling-assessment-admission-")));
  const store = createSqliteRunStore(cwd);
  const now = new Date().toISOString();
  const snapshot: CodeAssessmentSnapshot = { id: "snapshot", digest: "a".repeat(64), target: { type: "working_tree" }, capturedAt: now,
    files: [], totalFileCount: 0, coverage: "complete", exclusions: [] };
  try {
    const detail = store.createCodeAssessment({ id: "assessment", kind: "review", providerPresetId: "fixture", snapshot, now });
    const request = codeAssessmentRunRequest(cwd, detail);
    const adapter = new ToolFreePiRunner();
    assert.doesNotThrow(() => assertCodeAssessmentRequest(store, request, adapter));
    const changes: readonly Partial<RunRequest>[] = [
      { codeAssessment: { id: "forged", snapshotDigest: snapshot.digest } },
      { codeAssessment: { id: "assessment", snapshotDigest: "b".repeat(64) } },
      { cwd: join(cwd, "elsewhere") },
      { runnerId: "codex" },
      { workspaceAccessMode: "full_access" },
      { tools: ["write"] },
      { tools: undefined },
      { teammateId: "engineer" },
      { requestedSkillId: "skill" },
    ];
    for (const change of changes) assert.throws(() => assertCodeAssessmentRequest(store, { ...request, ...change }, adapter),
      { code: "assessment_execution_changed" }, JSON.stringify(change));
    assert.throws(() => assertCodeAssessmentRequest(store, request, { runTask() {} }), { code: "assessment_execution_changed" });
    store.finishCodeAssessment("assessment", { status: "cancelled", now });
    assert.throws(() => assertCodeAssessmentRequest(store, request, adapter), { code: "assessment_execution_changed" });
  } finally { store.close(); await rm(cwd, { recursive: true, force: true }); }
});

test("public Run parsing cannot establish an internal code-assessment binding", () => {
  const request = parseRunRequest({ cwd: "/workspace", task: { id: "public", title: "Public Run", prompt: "Inspect" },
    providerPresetId: "fixture", runnerId: "pi", tools: [], permissionPreset: "read_only", workspaceAccessMode: "read_only",
    codeAssessment: { id: "forged", snapshotDigest: "a".repeat(64) } });
  assert.equal(request.codeAssessment, undefined);
});

test("security stages require a completed threat model and cannot be replayed after synthesis", async () => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "ling-assessment-stage-policy-")));
  const store = createSqliteRunStore(cwd);
  const now = new Date().toISOString();
  const snapshot: CodeAssessmentSnapshot = { id: "stage_snapshot", digest: "a".repeat(64), target: { type: "working_tree" }, capturedAt: now,
    files: [], totalFileCount: 0, coverage: "complete", exclusions: [] };
  try {
    const detail = store.createCodeAssessment({ id: "staged", kind: "security", providerPresetId: "fixture", snapshot, now });
    const threatRequest = codeAssessmentRunRequest(cwd, detail, "threat_model");
    const reviewRequest = codeAssessmentRunRequest(cwd, detail, "reviewing_code");
    assert.doesNotThrow(() => assertCodeAssessmentRequest(store, threatRequest));
    assert.throws(() => assertCodeAssessmentRequest(store, reviewRequest), { code: "assessment_execution_changed" });
    store.bindCodeAssessmentRun("staged", "threat_run", now, "threat_model");
    assert.doesNotThrow(() => assertCodeAssessmentRequest(store, threatRequest));
    store.completeCodeAssessmentThreatModel("staged", { runId: "threat_run", artifactId: "artifact", now });
    assert.throws(() => assertCodeAssessmentRequest(store, threatRequest), { code: "assessment_execution_changed" });
    assert.doesNotThrow(() => assertCodeAssessmentRequest(store, reviewRequest));
    store.bindCodeAssessmentRun("staged", "review_run", now, "reviewing_code");
    store.advanceCodeAssessmentPhase("staged", { runId: "review_run", phase: "validating_output", now });
    assert.throws(() => assertCodeAssessmentRequest(store, reviewRequest), { code: "assessment_execution_changed" });
  } finally { store.close(); await rm(cwd, { recursive: true, force: true }); }
});
