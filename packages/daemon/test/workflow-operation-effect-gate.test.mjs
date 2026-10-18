import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { channelOperationPlanFingerprintV1, delegatedStepRequirementFingerprintV1, isDelegatedStepRequirementV1 } from "../../contracts/dist/index.js";
import { createWorkflowOperationExecutionSnapshot, validateWorkflowOperationRunContext } from "../dist/features/runs/workflow-operation-snapshot.js";
import { workflowOperationEffectRejection } from "../dist/features/runs/workflow-operation-effect-gate.js";
import { parseRunRequest } from "../dist/features/runs/schemas.js";

const sourceRefs = [{ itemId: "source", quote: "Read input.txt and create output.txt" }];
function operation(kind = "file_read", path = "input.txt", id = "op") {
  const writes = kind !== "file_read";
  return {
    id, kind, targetKind: "file", targetRef: { type: "operation", id: path, label: path }, required: true, dependsOn: [],
    binding: {
      schemaVersion: 1, ownerParticipantId: "owner", sourceRefs,
      inputRefs: writes ? [] : [{ path, sourceRefs }],
      outputRefs: writes ? [{ path, sourceRefs }] : [],
      ...(writes ? { contentSource: { kind: "literal", text: "exact output", sourceRefs } } : {}),
      effectScope: { readPaths: writes ? [] : [path], writePaths: writes ? [path] : [], exactCommands: [], allowEnvironmentAccess: false, allowNetworkAccess: false },
    },
  };
}
function fixture(cwd = "/workspace", operations = [operation()]) {
  const plan = { bindingVersion: 1, operations, fingerprint: channelOperationPlanFingerprintV1(operations) };
  const requirement = {
    schemaVersion: 1, workflowId: "workflow", workflowStepId: "step", participantId: "owner",
    participantManifestFingerprint: "manifest", executionPlanFingerprint: plan.fingerprint,
    expectedOutcome: "execution", requiredOperationIds: operations.map((op) => op.id),
    requiredDependencyStepIds: [], acceptedEvidenceKinds: ["execution_action"],
  };
  requirement.fingerprint = delegatedStepRequirementFingerprintV1(requirement);
  let step = { id: "step", workflowId: "workflow", toParticipantId: "owner", runId: "run", metadata: {
    executionPlan: plan, executionOperationIds: operations.map((op) => op.id), delegatedRequirement: requirement,
  } };
  const snapshot = createWorkflowOperationExecutionSnapshot(step);
  const run = { id: "run", status: "running", cwd, teammateId: "owner", workflowStepId: "step", requestSnapshot: {
    workflowOperationExecution: snapshot, delegatedRequirement: structuredClone(requirement),
  } };
  let storedRun = structuredClone(run);
  const store = { getRun: (id) => id === storedRun?.id ? storedRun : undefined,
    listHostCommandWriteBlockers: () => [],
    getChannelWorkflowStep: (id) => id === step?.id ? step : undefined,
    listChannelWorkflowSteps: () => [step] };
  return { store, run, get step() { return step; }, set step(value) { step = value; }, set storedRun(value) { storedRun = value; } };
}
const gate = (f, toolName, input, cwd = f.run.cwd) => workflowOperationEffectRejection({ store: f.store, run: f.run, request: { toolName, input, cwd } });

test("immutable typed snapshot preserves full plan, owner IDs and requirement fingerprint", () => {
  const f = fixture();
  const result = validateWorkflowOperationRunContext(f);
  assert.equal(result.status, "ready");
  assert.equal(result.snapshot.plan.fingerprint, f.step.metadata.executionPlan.fingerprint);
  assert.deepEqual(result.snapshot.ownedOperationIds, ["op"]);
  assert.notEqual(result.snapshot.plan, f.step.metadata.executionPlan);
  assert.equal(isDelegatedStepRequirementV1(f.step.metadata.delegatedRequirement), true);
  const changed = { ...f.step.metadata.delegatedRequirement, executionPlanFingerprint: "different" };
  assert.equal(isDelegatedStepRequirementV1(changed), false);
});

test("typed ownership and snapshot omissions fail closed without ALL or legacy fallback", () => {
  for (const mutate of [
    (f) => { f.run.requestSnapshot.workflowOperationExecution = undefined; },
    (f) => { f.step = { ...f.step, runId: "other-run" }; },
    (f) => { f.step = { ...f.step, toParticipantId: "other-owner" }; },
    (f) => { f.step.metadata.executionOperationIds = undefined; },
    (f) => { f.step.metadata.executionPlan = undefined; },
    (f) => { f.step.metadata.executionPlan.fingerprint = "tampered"; },
    (f) => { f.step.metadata.executionOperationIds = ["unknown"]; },
    (f) => { f.step.metadata.delegatedRequirement = undefined; },
    (f) => { f.storedRun = undefined; },
    (f) => { f.storedRun = { ...f.run, teammateId: "other-owner" }; },
  ]) {
    const f = fixture(); mutate(f);
    assert.equal(validateWorkflowOperationRunContext(f).status, "blocked", String(mutate));
  }
});

test("rehashed plan edits cannot replace the accepted immutable Run plan", () => {
  const f = fixture();
  const changed = operation("file_read", "other.txt");
  f.step.metadata.executionPlan = { bindingVersion: 1, operations: [changed], fingerprint: channelOperationPlanFingerprintV1([changed]) };
  const requirement = { ...f.step.metadata.delegatedRequirement, executionPlanFingerprint: f.step.metadata.executionPlan.fingerprint };
  requirement.fingerprint = delegatedStepRequirementFingerprintV1(requirement);
  f.step.metadata.delegatedRequirement = requirement;
  assert.equal(validateWorkflowOperationRunContext(f).code, "operation_binding_fingerprint_mismatch");
});

test("legacy ordinary calls retain their existing approval behavior", () => {
  const run = { id: "legacy", cwd: "/workspace", requestSnapshot: {} };
  assert.equal(workflowOperationEffectRejection({ store: { getRun: () => run, listHostCommandWriteBlockers: () => [] }, run, request: { toolName: "future_tool", input: {}, cwd: "/workspace" } }), undefined);
  const old = { schemaVersion: 1, workflowId: "w", workflowStepId: "s", participantId: "p",
    participantManifestFingerprint: "m", expectedOutcome: "execution", requiredOperationIds: [], requiredDependencyStepIds: [], acceptedEvidenceKinds: ["execution_action"] };
  old.fingerprint = delegatedStepRequirementFingerprintV1(old);
  assert.equal(isDelegatedStepRequirementV1(old), true);
});

test("lost caller fields cannot downgrade a persisted typed Run to legacy", () => {
  const f = fixture();
  const incomplete = { ...f.run, workflowStepId: undefined, requestSnapshot: {} };
  assert.equal(validateWorkflowOperationRunContext({ store: f.store, run: incomplete }).status, "blocked");
});

test("runner-reinterpreted native paths are rejected even when the literal binding matches", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-operation-path-meaning-"));
  try {
    for (const path of ["~/output.txt", "@output.txt", "narrow\u202fspace.txt", "no\u00a0break.txt"]) {
      const f = fixture(cwd, [operation("file_create", path)]);
      assert.equal(gate(f, "write", { path, content: "exact output" })?.code, "operation_binding_path_reinterpreted", path);
    }
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("external Run parsing cannot inject typed snapshots, requirements or callbacks", () => {
  const f = fixture();
  const request = parseRunRequest({ cwd: "/workspace", providerPresetId: "provider", task: { id: "task", title: "Task", prompt: "Read" },
    workflowOperationExecution: f.run.requestSnapshot.workflowOperationExecution,
    delegatedRequirement: f.run.requestSnapshot.delegatedRequirement,
    executionOperationBindings: [operation()], onToolBefore: () => ({ allowed: true }),
  });
  for (const field of ["workflowOperationExecution", "delegatedRequirement", "executionOperationBindings", "onToolBefore"]) {
    assert.equal(request[field], undefined, field);
  }
});

test("only exact owned file paths pass, and lexical or cwd escapes never pass", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-operation-gate-"));
  try {
    await writeFile(join(cwd, "input.txt"), "input");
    const f = fixture(cwd);
    assert.equal(gate(f, "read", { path: "input.txt" }), undefined);
    for (const path of ["other.txt", "../input.txt", "./input.txt", "/etc/passwd", "a//b", "a\\b"]) {
      assert.equal(gate(f, "read", { path }).status, "blocked", path);
    }
    assert.equal(gate(f, "read", { path: "input.txt" }, tmpdir()).code, "operation_binding_cwd_mismatch");
    assert.equal(gate(f, "read", { path: "input.txt", cwd: tmpdir() }).code, "operation_binding_cwd_mismatch");
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("literal native create matches exact content and never overwrites or follows symlinks", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-operation-create-"));
  try {
    const f = fixture(cwd, [operation("file_create", "output.txt")]);
    assert.equal(gate(f, "write", { path: "output.txt", content: "exact output" }), undefined);
    assert.equal(gate(f, "write", { path: "output.txt", content: "different" }).code, "operation_binding_content_mismatch");
    await writeFile(join(cwd, "output.txt"), "existing");
    assert.equal(gate(f, "write", { path: "output.txt", content: "exact output" }).code, "operation_binding_create_target_exists");
    await symlink("output.txt", join(cwd, "input.txt"));
    assert.equal(gate(fixture(cwd), "read", { path: "input.txt" }).code, "operation_binding_symlink_rejected");
    await symlink(tmpdir(), join(cwd, "escape"));
    assert.equal(gate(fixture(cwd, [operation("file_create", "escape/new.txt")]), "write", { path: "escape/new.txt", content: "exact output" }).code, "operation_binding_symlink_rejected");
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("typed bash and all undeclared tool families are structured blocked", () => {
  const f = fixture();
  assert.equal(gate(f, "bash", { command: "node app.js" }).code, "operation_binding_isolation_unavailable");
  assert.equal(gate(f, "request_user_input", { schemaVersion: 1, questions: [] }), undefined);
  for (const name of ["grep", "find", "ls", "mcp__external", "image_generate", "request_permissions", "future_unknown"]) {
    assert.equal(gate(f, name, {}).code, "operation_binding_tool_out_of_scope", name);
  }
});

test("terminal Runs cannot execute another typed tool even when their snapshot remains valid", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-operation-terminal-"));
  try {
    await writeFile(join(cwd, "input.txt"), "input");
    for (const status of ["succeeded", "failed", "cancelled"]) {
      const f = fixture(cwd);
      f.storedRun = { ...f.run, status };
      assert.equal(validateWorkflowOperationRunContext(f).status, "ready", "Terminal evidence remains verifiable");
      assert.equal(gate(f, "read", { path: "input.txt" })?.code, "operation_binding_run_inactive");
    }
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("multi-file patches inspect every path and reject delete or tool-kind smuggling", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-operation-patch-"));
  try {
    const op = operation("file_create", "output.txt");
    op.binding.contentSource = { kind: "generated_objective", text: "Create output", inputOperationIds: [], sourceRefs };
    const f = fixture(cwd, [op]);
    const safe = "*** Begin Patch\n*** Add File: output.txt\n+generated\n*** End Patch";
    assert.equal(gate(f, "write", { patchText: safe }), undefined);
    const extra = "*** Begin Patch\n*** Add File: output.txt\n+generated\n*** Add File: outside.txt\n+no\n*** End Patch";
    assert.equal(gate(f, "write", { patchText: extra }).code, "operation_binding_path_out_of_scope");
    assert.equal(gate(f, "write", { patchText: "*** Begin Patch\n*** Delete File: output.txt\n*** End Patch" }).code, "operation_binding_input_invalid");
    assert.equal(gate(f, "edit", { patchText: safe }).code, "operation_binding_input_invalid");
    assert.equal(gate(f, "write", { content: extra, path: "output.txt" }).code, "operation_binding_path_out_of_scope");
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("generated edit authorizes only its declared existing file for native and patch forms", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-operation-edit-"));
  try {
    await writeFile(join(cwd, "input.txt"), "old\n");
    const op = operation("file_edit", "input.txt");
    op.binding.inputRefs = [{ path: "input.txt", sourceRefs }];
    op.binding.effectScope.readPaths = ["input.txt"];
    op.binding.contentSource = { kind: "generated_objective", text: "Edit requested text", inputOperationIds: [], sourceRefs };
    const f = fixture(cwd, [op]);
    assert.equal(gate(f, "edit", { path: "input.txt", edits: [{ oldText: "old", newText: "new" }] }), undefined);
    assert.equal(gate(f, "edit", { patchText: "*** Begin Patch\n*** Update File: input.txt\n@@\n-old\n+new\n*** End Patch" }), undefined);
    assert.equal(gate(f, "edit", { path: "other.txt", edits: [] }).code, "operation_binding_path_out_of_scope");
    assert.equal(gate(f, "write", { path: "input.txt", content: "new" }).code, "operation_binding_path_out_of_scope");
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
