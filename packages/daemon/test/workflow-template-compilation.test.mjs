import assert from "node:assert/strict";
import test from "node:test";
import { createSqliteRunStore, createSqliteWorkflowTemplateRegistryStore, parseWorkflowTemplateCompilation,
  workflowStepStartAuthorityBasis, workflowTemplateDigest } from "../../core/dist/index.js";
import { b013OwnedStore, b013FactCounts, b013ParticipantId, b013Gate } from "../../core/test/support/b013-pre-gate-fixture.mjs";
import { compileWorkflowTemplate, parseWorkflowTemplateCompileRequest, previewWorkflowTemplate } from "../dist/features/channels/workflow-templates.js";
import { assertWorkflowTemplateCompilationCurrent } from "../dist/features/channels/workflow-template-compilation.js";
import { prepareWorkflowStepStart } from "../dist/features/channels/workflows.js";
import { assertWorkflowSafetyRequest, assertWorkflowSafetyRunner, freezeWorkflowSafetyPlan,
  workflowSafetySnapshot, workflowSafetyEffectRejection } from "../dist/features/runs/workflow-safety.js";
import { createRunnerRegistry } from "../dist/runtime/runners.js";
import { patchWorkspaceRuntimeSettings } from "../dist/runtime/runner-settings.js";

const now = n => new Date(Date.UTC(2026, 10, 3, 0, 0, n)).toISOString();
const definition = (providerPresetId, extra = {}) => ({ schemaVersion: 1, id: "p4-review", name: "P4 review", maxParallelSteps: 2,
  steps: ["first", "second", "join"].map((id, index) => ({ id, name: `Review ${id}`, prompt: `Read evidence for ${id}`,
    teammateId: b013ParticipantId, ...(providerPresetId ? { providerPresetId } : {}),
    sideEffectClass: "analysis_readonly", parallelPolicy: { autoParallel: true, maxParallelSiblings: 2 },
    ...(index === 2 ? { dependsOn: ["first", "second"] } : {}) })), ...extra });

async function fixture(t) {
  const f = await b013OwnedStore(t);
  f.channel = f.store.updateChannel(f.channel.id, { runtimePolicy: { ...f.channel.runtimePolicy, maxConcurrentRuns: 3 } }, now(0));
  f.provider = f.store.createProviderPreset({ kind: "openai-compatible", displayName: "P4 fixture", providerId: "p4-fixture",
    model: "p4-fixture", api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", capabilities: ["chat", "tool_call"],
    headers: { "X-Fixture-Private": "not-for-workflow-projection" }, apiKeyRef: "env:P4_NEVER_MATERIALIZED", enabled: true }, now(0));
  f.registry = createSqliteWorkflowTemplateRegistryStore(f.store);
  let revisionTime = 0;
  f.save = (version = "v1", template = definition(f.provider.id), expectedRevision = f.registry.get(template.id)?.revision ?? 0) =>
    f.registry.saveVersion({ kind: "workflow_template", id: template.id, version, template, source: "workspace",
      visibility: { workspaceVisible: true, promotableToWorkspace: false }, expectedRevision, now: now(revisionTime += 10) });
  f.publish = saved => f.registry.setReviewStatus({ id: saved.entry.id, version: saved.version.version,
    digest: saved.version.digest, reviewStatus: "published", expectedRevision: saved.entry.revision, now: now(revisionTime += 10) });
  f.request = pin => ({ channelId: f.channel.id, objective: "P4 frozen objective", customTemplateId: pin.id,
    customTemplateVersion: pin.version, customTemplateDigest: pin.digest });
  f.compile = pin => compileWorkflowTemplate(f.store, f.request(pin));
  return f;
}

test("registry preview resolves exact references but persists zero workflow, Task, Run or approval facts", async t => {
  const f = await fixture(t), saved = f.save(); f.publish(saved);
  const before = b013FactCounts(f.store), preview = previewWorkflowTemplate(f.store, f.request(saved.version));
  assert.deepEqual(b013FactCounts(f.store), before);
  assert.equal(preview.steps.length, 3);
  assert.deepEqual(preview.steps[2].dependsOn, ["first", "second"]);
  assert.ok(preview.steps.every(step => step.runnerId === "pi" && step.providerPresetId === f.provider.id && step.autoStart === false));
  assert.match(preview.graphFingerprint, /^wtc1_[a-f0-9]{64}$/u);
  assert.equal(JSON.stringify(preview).includes("not-for-workflow-projection"), false);
  assert.equal(JSON.stringify(preview).includes("P4_NEVER_MATERIALIZED"), false);
  const compiled = f.compile(saved.version);
  assert.equal(compiled.workflow.metadata.templateCompilation.graphFingerprint, preview.graphFingerprint);
  for (const step of compiled.workflowSteps) assert.doesNotThrow(() => assertWorkflowTemplateCompilationCurrent(f.store, step));
  assert.equal(b013FactCounts(f.store).tasks, 0);
  assert.equal(b013FactCounts(f.store).run_sessions, 0);
});

test("registry legacy Runner alias publishes, previews and compiles with the canonical Pi digest and pin", async t => {
  const f = await fixture(t), canonical = definition(f.provider.id, { autoStartDefault: false });
  for (const step of canonical.steps) step.requestedRunnerId = "pi";
  const legacy = structuredClone(canonical);
  for (const step of legacy.steps) step.requestedRunnerId = "pi-coding-agent";
  const saved = f.save("v1", legacy), pin = { id: canonical.id, version: "v1", digest: workflowTemplateDigest(canonical) };
  assert.equal(saved.version.digest, pin.digest);
  assert.deepEqual(saved.version.template, canonical);
  assert.deepEqual(f.registry.getVersion(pin.id, pin.version), saved.version);
  const duplicate = f.save("v1", canonical);
  assert.equal(duplicate.status, "duplicate");
  assert.deepEqual(duplicate.version, saved.version);
  assert.deepEqual(f.publish(saved).publishedVersion, pin);
  const runners = createRunnerRegistry([{ id: "pi", displayName: "Pi", status: "enabled", adapter: { run() { assert.fail("compilation cannot dispatch"); } } }]);
  const before = b013FactCounts(f.store), preview = previewWorkflowTemplate(f.store, f.request(pin), runners);
  assert.deepEqual(b013FactCounts(f.store), before);
  assert.deepEqual(preview.templatePin, pin);
  assert.ok(preview.steps.every(step => step.runnerId === "pi"));
  const compiled = compileWorkflowTemplate(f.store, f.request(pin), now(40), runners);
  const snapshot = compiled.workflow.metadata.templateCompilation;
  assert.deepEqual(snapshot.template, canonical);
  assert.deepEqual(snapshot.templatePin, pin);
  assert.deepEqual(snapshot.steps, preview.steps);
  assert.equal(snapshot.graphFingerprint, preview.graphFingerprint);
  for (const step of compiled.workflowSteps) {
    assert.equal(step.metadata.requestedRunnerId, "pi");
    assert.deepEqual(step.metadata.templateCompilationPin, { ...pin, graphFingerprint: preview.graphFingerprint });
    assert.doesNotThrow(() => assertWorkflowTemplateCompilationCurrent(f.store, step));
  }
  assert.equal(b013FactCounts(f.store).tasks, 0);
  assert.equal(b013FactCounts(f.store).run_sessions, 0);
});

test("registry compilation requires explicit id/version/digest and the currently published exact version", async t => {
  const f = await fixture(t), saved = f.save(), before = b013FactCounts(f.store);
  for (const body of [{ customTemplateId: saved.entry.id }, { customTemplateVersion: "v1" },
    { customTemplateId: saved.entry.id, customTemplateVersion: "v1" }])
    assert.throws(() => parseWorkflowTemplateCompileRequest({ ...body, objective: "P4 pin" }, f.channel.id), /explicit template/u);
  assert.throws(() => f.compile(saved.version), { code: "workflow_template_not_published" });
  f.publish(saved);
  assert.throws(() => f.compile({ ...saved.version, digest: `wt1_${"0".repeat(64)}` }), { code: "workflow_template_version_conflict" });
  assert.throws(() => f.compile({ ...saved.version, version: "missing" }), { code: "workflow_template_version_conflict" });
  assert.deepEqual(b013FactCounts(f.store), before);
});

test("template successor, draft and publication never mutate or re-resolve the accepted workflow", async t => {
  const f = await fixture(t), first = f.save(); f.publish(first);
  const compiled = f.compile(first.version), before = structuredClone(compiled), basis = workflowStepStartAuthorityBasis(f.store, compiled.workflowSteps[0]);
  const template = definition(f.provider.id); template.steps[0].prompt = "A different successor prompt";
  const second = f.save("v2", template);
  assert.equal(f.registry.get(template.id).reviewStatus, "draft");
  assert.throws(() => f.compile(first.version), { code: "workflow_template_not_published" });
  for (const step of compiled.workflowSteps) assert.doesNotThrow(() => assertWorkflowTemplateCompilationCurrent(f.store, step));
  f.publish(second);
  assert.throws(() => f.compile(first.version), { code: "workflow_template_version_conflict" });
  assert.equal(f.store.getChannelWorkflow(compiled.workflow.id).metadata.templateCompilation.templatePin.version, "v1");
  assert.deepEqual(f.store.getChannelWorkflow(compiled.workflow.id), before.workflow);
  assert.deepEqual(f.store.listChannelWorkflowSteps({ workflowId: compiled.workflow.id, complete: true }), before.workflowSteps);
  assert.equal(workflowStepStartAuthorityBasis(f.store, f.store.getChannelWorkflowStep(compiled.workflowSteps[0].id)), basis);
  for (const step of compiled.workflowSteps) assert.doesNotThrow(() => assertWorkflowTemplateCompilationCurrent(f.store, step));
});

for (const status of ["disabled", "archived"]) test(`${status} template stays revoked after saving a successor at start and at the tool effect boundary`, async t => {
  const f = await fixture(t), saved = f.save(), entry = f.publish(saved), compiled = f.compile(saved.version);
  const step = freezeWorkflowSafetyPlan({ store: f.store, step: compiled.workflowSteps[0], workspaceCwd: f.cwd, executionCwd: f.cwd, runnerId: "pi" });
  const originalSteps = f.store.listChannelWorkflowSteps({ workflowId: compiled.workflow.id, complete: true });
  const task = { id: "p4-revocation-task", channelId: step.channelId, title: step.title, prompt: step.prompt };
  const requestSnapshot = { cwd: f.cwd, task, workflowStepId: step.id, teammateId: step.toParticipantId,
    providerPresetId: f.provider.id, runnerId: "pi", workflowSafetySnapshot: workflowSafetySnapshot(step.metadata.safetyPlan) };
  const run = f.store.createRun({ id: "p4-revocation-run", cwd: f.cwd, taskId: task.id, channelId: step.channelId,
    teammateId: step.toParticipantId, workflowStepId: step.id, providerPresetId: f.provider.id,
    providerName: "fixture", providerModel: "fixture", taskSnapshot: task, providerSnapshot: {}, requestSnapshot, createdAt: now(25) });
  const effectRejection = () => workflowSafetyEffectRejection({ store: f.store, run, request: { toolName: "read", input: {}, cwd: f.cwd } });
  assert.equal(effectRejection(), undefined);
  f.registry.setReviewStatus({ id: entry.id, reviewStatus: status, expectedRevision: entry.revision, now: now(30) });
  const assertRevoked = async () => {
    assert.throws(() => assertWorkflowTemplateCompilationCurrent(f.store, step), { code: "workflow_template_compilation_stale" });
    const before = b013FactCounts(f.store), result = await prepareWorkflowStepStart(f.store, step.id, { mode: "create_and_run_task" }, f.cwd,
      () => assert.fail("revoked pin must stop before Provider preflight"));
    assert.equal(result.kind, "error"); assert.equal(result.code, "workflow_template_compilation_stale");
    const rejection = effectRejection();
    assert.equal(rejection.code, "workflow_safety_mismatch");
    assert.match(rejection.reason, /Template was revoked/u);
    assert.deepEqual(b013FactCounts(f.store), before);
    assert.deepEqual(f.store.getChannelWorkflow(compiled.workflow.id), compiled.workflow);
    assert.deepEqual(f.store.listChannelWorkflowSteps({ workflowId: compiled.workflow.id, complete: true }), originalSteps);
    assert.deepEqual(f.store.getRun(run.id), run);
  };
  await assertRevoked();
  const template = definition(f.provider.id); template.steps[0].prompt = "A saved successor cannot restore revoked authority";
  const successor = f.save("v2", template);
  assert.equal(successor.entry.latestVersion, "v2");
  assert.equal(successor.entry.reviewStatus, status);
  assert.deepEqual(successor.entry.publishedVersion, entry.publishedVersion);
  await assertRevoked();
});

for (const [label, mutate] of [
  ["participant archived", f => f.store.updateAiTeammate(b013ParticipantId, { status: "archived" }, now(30))],
  ["participant tools", f => f.store.updateAiTeammate(b013ParticipantId, { allowedTools: ["read"] }, now(30))],
  ["participant prompt", f => f.store.updateAiTeammate(b013ParticipantId, { systemPrompt: "Changed instruction" }, now(30))],
  ["provider disabled", f => f.store.updateProviderPreset(f.provider.id, { enabled: false }, now(30))],
  ["provider model", f => f.store.updateProviderPreset(f.provider.id, { model: "different" }, now(30))],
]) test(`current ${label} revokes compiled authority without rewriting the frozen snapshot`, async t => {
  const f = await fixture(t), saved = f.save(); f.publish(saved);
  const compiled = f.compile(saved.version), snapshot = structuredClone(compiled.workflow.metadata.templateCompilation);
  mutate(f);
  assert.throws(() => assertWorkflowTemplateCompilationCurrent(f.store, compiled.workflowSteps[0]), { code: "workflow_template_compilation_stale" });
  assert.deepEqual(f.store.getChannelWorkflow(compiled.workflow.id).metadata.templateCompilation, snapshot);
});

test("provider display name and health checks do not spuriously invalidate execution configuration", async t => {
  const f = await fixture(t), saved = f.save(); f.publish(saved);
  const { workflowSteps: [step] } = f.compile(saved.version);
  f.store.updateProviderPreset(f.provider.id, { displayName: "Renamed label" }, now(30));
  f.store.recordProviderCheckResult(f.provider.id, { ok: false, message: "Temporary reachability failure", checkedAt: now(30) });
  assert.doesNotThrow(() => assertWorkflowTemplateCompilationCurrent(f.store, step));
});

for (const [label, change] of [
  ["prompt", step => ({ prompt: `${step.prompt} changed` })],
  ["title", () => ({ title: "Changed title" })],
  ["autostart", step => ({ metadata: { ...step.metadata, autoStart: true } })],
  ["gates", step => ({ metadata: { ...step.metadata, gates: [] } })],
  ["policy", step => ({ metadata: { ...step.metadata, policy: { ...step.metadata.policy, retryable: false } } })],
  ["runner", step => ({ metadata: { ...step.metadata, requestedRunnerId: "external" } })],
  ["dependencies", step => ({ metadata: { ...step.metadata, dependsOnStepIds: [] } })],
  ["pin removed", step => ({ metadata: { ...step.metadata, templateCompilationPin: undefined } })],
]) test(`edited compiled ${label} fails closed before start`, async t => {
  const f = await fixture(t), template = definition(f.provider.id); template.steps[2].gates = [b013Gate()];
  const saved = f.save("v1", template); f.publish(saved);
  const { workflowSteps } = f.compile(saved.version), step = workflowSteps[2];
  const changed = f.store.updateChannelWorkflowStep(step.id, change(step), now(30));
  assert.throws(() => assertWorkflowTemplateCompilationCurrent(f.store, changed), { code: "workflow_template_compilation_stale" });
  const result = await prepareWorkflowStepStart(f.store, step.id, { mode: "create_and_run_task" }, f.cwd);
  assert.equal(result.code, "workflow_template_compilation_stale");
  assert.equal(b013FactCounts(f.store).tasks, 0);
});

test("missing snapshot and altered objective cannot turn a pinned workflow into a legacy execution", async t => {
  const f = await fixture(t), saved = f.save(); f.publish(saved);
  for (const fault of ["objective", "snapshot"]) {
    const { workflow, workflowSteps: [step] } = f.compile(saved.version);
    f.store.updateChannelWorkflow(workflow.id, fault === "objective" ? { objective: "Changed objective" }
      : { metadata: { ...workflow.metadata, templateCompilation: undefined } }, now(30));
    assert.throws(() => assertWorkflowTemplateCompilationCurrent(f.store, step), { code: "workflow_template_compilation_stale" });
  }
});

test("snapshot and step pin roundtrip through SQLite reopen with no credential material", async t => {
  const f = await fixture(t), saved = f.save(); f.publish(saved);
  const compiled = f.compile(saved.version); f.store.close();
  const reopened = createSqliteRunStore(f.cwd, f.paths);
  try {
    assert.deepEqual(reopened.getChannelWorkflow(compiled.workflow.id), compiled.workflow);
    assert.deepEqual(reopened.listChannelWorkflowSteps({ workflowId: compiled.workflow.id, complete: true }), compiled.workflowSteps);
    for (const step of compiled.workflowSteps) assert.doesNotThrow(() => assertWorkflowTemplateCompilationCurrent(reopened, step));
    const snapshot = reopened.getChannelWorkflow(compiled.workflow.id).metadata.templateCompilation;
    assert.deepEqual(parseWorkflowTemplateCompilation(snapshot), snapshot);
    assert.throws(() => parseWorkflowTemplateCompilation({ ...snapshot, graphFingerprint: `wtc1_${"0".repeat(64)}` }), /digest_mismatch/u);
    assert.equal(JSON.stringify(snapshot).includes("not-for-workflow-projection"), false);
  } finally { reopened.close(); }
});

test("legacy inline optional retryable remains true and compile-only defaults remain manual", async t => {
  const f = await fixture(t), template = definition();
  template.steps[0].policy = { onRunFailed: "block_for_user", onRunCancelled: "block_for_user", onApprovalDenied: "block_for_user" };
  const input = parseWorkflowTemplateCompileRequest({ customTemplate: template, objective: "Old inline definition" }, f.channel.id);
  const compiled = compileWorkflowTemplate(f.store, input);
  assert.equal(compiled.workflowSteps[0].metadata.policy.retryable, true);
  assert.ok(compiled.workflowSteps.every(step => step.metadata.autoStart === false));
  for (const step of compiled.workflowSteps) assert.doesNotThrow(() => assertWorkflowTemplateCompilationCurrent(f.store, step));
});

test("frozen template inputs reject manual and retry overrides before any preparation", async t => {
  const f = await fixture(t), saved = f.save(); f.publish(saved);
  const { workflowSteps: [step] } = f.compile(saved.version), before = b013FactCounts(f.store);
  for (const override of [{ runnerId: "other" }, { providerPresetId: "other" }, { assigneeTeammateId: "other" }, { taskPrompt: "different" }]) {
    const result = await prepareWorkflowStepStart(f.store, step.id, { mode: "create_and_run_task", ...override }, f.cwd);
    assert.equal(result.code, "workflow_template_compilation_stale");
  }
  assert.deepEqual(b013FactCounts(f.store), before);
});

test("skill binding and definition revocation invalidate the original snapshot at start and effect boundaries", async t => {
  const f = await fixture(t), skillId = "p4-frozen-read";
  const draft = f.store.createSkillImportDraft({ source: "custom", name: "P4 frozen skill", definitions: [{ definition: {
    id: skillId, name: "Frozen read", summary: "Read evidence", roleAffinity: ["engineer"], promptFragments: ["Read evidence only."],
    requiredTools: ["read"], requiredProviderCapabilities: ["chat"], approvalProfile: { mode: "none" }, stateEffects: [],
  } }] }, now(0));
  f.store.publishSkillImportDraft(draft.id, now(0));
  const bindings = f.store.listTeammateSkillBindings(b013ParticipantId);
  f.store.replaceTeammateSkillBindings(b013ParticipantId, [...bindings, { skillId, source: "user", enabled: true }], now(0));
  const template = definition(f.provider.id);
  template.steps[0].skillId = skillId;
  const saved = f.save("v1", template); f.publish(saved);
  const { workflowSteps: [step] } = f.compile(saved.version);
  assert.doesNotThrow(() => assertWorkflowTemplateCompilationCurrent(f.store, step));
  f.store.replaceTeammateSkillBindings(b013ParticipantId, [...bindings, { skillId, source: "user", enabled: false }], now(30));
  assert.throws(() => assertWorkflowTemplateCompilationCurrent(f.store, step), { code: "workflow_template_compilation_stale" });
  const before = b013FactCounts(f.store), result = await prepareWorkflowStepStart(f.store, step.id,
    { mode: "create_and_run_task" }, f.cwd, () => assert.fail("revoked skill cannot reach preflight"));
  assert.equal(result.code, "workflow_template_compilation_stale");
  assert.deepEqual(b013FactCounts(f.store), before);
  assert.equal(workflowSafetyEffectRejection({ store: f.store, run: { id: "revoked-skill", workflowStepId: step.id, cwd: f.cwd },
    request: { toolName: "read", input: {}, cwd: f.cwd } }).code, "workflow_safety_mismatch");
  f.store.replaceTeammateSkillBindings(b013ParticipantId, [...bindings, { skillId, source: "user", enabled: true }], now(31));
  assert.doesNotThrow(() => assertWorkflowTemplateCompilationCurrent(f.store, step));
  const source = { skillId, sourceKind: "manual-markdown", sourceChecksum: "sha256:p4-source", rawSkillMarkdown: "# Read evidence",
    agentMetadata: {}, referencedFiles: [], warnings: [], reviewStatus: "published" };
  f.store.upsertSkillSourceSnapshot(source, now(31));
  assert.throws(() => assertWorkflowTemplateCompilationCurrent(f.store, step), { code: "workflow_template_compilation_stale" });
  const { workflowSteps: [withSource] } = f.compile(saved.version);
  assert.doesNotThrow(() => assertWorkflowTemplateCompilationCurrent(f.store, withSource));
  f.store.upsertSkillSourceSnapshot({ ...source, rawSkillMarkdown: "# Different instructions with an unchanged claimed checksum" }, now(32));
  assert.throws(() => assertWorkflowTemplateCompilationCurrent(f.store, withSource), { code: "workflow_template_compilation_stale" });
  const { workflowSteps: [beforeArchive] } = f.compile(saved.version);
  f.store.archiveSkillRegistryEntry(skillId, now(32));
  assert.throws(() => assertWorkflowTemplateCompilationCurrent(f.store, beforeArchive), { code: "workflow_template_compilation_stale" });
});

test("missing participants and skills, disabled providers and unavailable runners fail preview without execution", async t => {
  const f = await fixture(t), before = b013FactCounts(f.store);
  for (const change of [{ teammateId: "missing" }, { skillId: "missing" }, { providerPresetId: "missing" }]) {
    const template = definition(f.provider.id); Object.assign(template.steps[0], change);
    const saved = f.save(`v${f.registry.get(template.id)?.revision ?? 0}`, template); f.publish(saved);
    assert.throws(() => previewWorkflowTemplate(f.store, f.request(saved.version)));
  }
  const template = definition(f.provider.id), saved = f.save("disabled-provider", template); f.publish(saved);
  f.store.updateProviderPreset(f.provider.id, { enabled: false }, now(80));
  assert.throws(() => previewWorkflowTemplate(f.store, f.request(saved.version)), { code: "workflow_template_compilation_stale" });
  f.store.updateProviderPreset(f.provider.id, { enabled: true }, now(81));
  const runners = createRunnerRegistry([{ id: "pi", displayName: "Pi", status: "disabled", adapter: { run() { assert.fail("preview must not run"); } } }]);
  assert.throws(() => previewWorkflowTemplate(f.store, f.request(saved.version), runners));
  assert.deepEqual(b013FactCounts(f.store), before);
});

test("an unclassified template defaults to serial and enforces its frozen Runner and Run references", async t => {
  const f = await fixture(t), template = definition(f.provider.id);
  for (const step of template.steps) { delete step.sideEffectClass; delete step.parallelPolicy; }
  const saved = f.save("v1", template); f.publish(saved);
  const { workflowSteps: [compiled] } = f.compile(saved.version);
  const step = freezeWorkflowSafetyPlan({ store: f.store, step: compiled, workspaceCwd: f.cwd, executionCwd: f.cwd, runnerId: "pi" });
  const request = { workflowStepId: step.id, cwd: f.cwd, runnerId: "pi", providerPresetId: f.provider.id,
    teammateId: step.toParticipantId, task: { channelId: step.channelId }, workflowSafetySnapshot: workflowSafetySnapshot(step.metadata.safetyPlan) };
  assert.equal(assertWorkflowSafetyRequest(f.store, request).profile, "serial_v1");
  assert.equal(assertWorkflowSafetyRunner(f.store, request, { runnerId: "pi" }).profile, "serial_v1");
  for (const override of [{ runnerId: "other" }, { providerPresetId: "other" }, { teammateId: "other" }, { requestedSkillId: "other" }])
    assert.throws(() => assertWorkflowSafetyRequest(f.store, { ...request, ...override }), { code: "workflow_safety_mismatch" });
  assert.throws(() => assertWorkflowSafetyRunner(f.store, request, { runnerId: "fallback" }), { code: "workflow_safety_mismatch" });
  const runners = createRunnerRegistry([{ id: "pi", displayName: "Pi", status: "enabled", adapter: { run() { assert.fail(); } } }]);
  patchWorkspaceRuntimeSettings(f.store, runners, { allowedRunnerIds: [], explicitRunnerFallback: "allow_to_default" }, now(30));
  const before = b013FactCounts(f.store), prepared = await prepareWorkflowStepStart(f.store, step.id,
    { mode: "create_and_run_task" }, f.cwd, () => assert.fail("revoked Runner cannot reach preflight"), undefined, runners);
  assert.equal(prepared.code, "workflow_template_compilation_stale");
  assert.deepEqual(b013FactCounts(f.store), before);
});

test("an enabled pinned Runner permits explicit task preparation without dispatch", async t => {
  const f = await fixture(t), saved = f.save(); f.publish(saved);
  const { workflowSteps: [step] } = f.compile(saved.version);
  const runners = createRunnerRegistry([{ id: "pi", displayName: "Pi", status: "enabled", adapter: { run() { assert.fail("task preparation cannot dispatch"); } } }]);
  const result = await prepareWorkflowStepStart(f.store, step.id, { mode: "create_task" }, f.cwd,
    () => assert.fail("task-only preparation cannot validate a Run"), undefined, runners);
  assert.equal(result.kind, "ready", JSON.stringify(result));
  assert.equal(result.runRequest.runnerId, "pi");
  assert.equal(b013FactCounts(f.store).run_sessions, 0);
});
