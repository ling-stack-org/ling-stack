import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as core from "@ling-stack/core";
import { createBudgetHarness } from "../../core/test/support/delegation-budget-fixture.mjs";
import { SqliteDelegationLifecycleStore } from "../../core/dist/storage/sqlite/delegation-lifecycle-store.js";
import { OrdinaryRunProgressController } from "../dist/features/harness/continuations/run-ordinary-progress.js";

const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const now = "2026-10-23T01:00:00.000Z";

// Host/Core producer fixture only. No SDK shutdown, actual process stop or GUI proof.
async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-suspension-progress-"));
  const store = core.createSqliteRunStore(cwd);
  t.after(async () => { store.close(); await rm(cwd, { recursive: true, force: true }); });
  const channel = store.createChannel({ name: "Suspension progress", boundPath: cwd }, now);
  const task = store.createTask({ channelId: channel.id, title: "Safe boundary", prompt: "Inspect owned result." }, now);
  const thread = store.createLingThread({ kind: "task", channelId: channel.id, taskId: task.id,
    title: task.title, objective: task.prompt }, now);
  const preset = store.createProviderPreset({ kind: "openai-compatible", displayName: "Isolated fixture",
    providerId: "suspension-fixture", model: "fixture-model", api: "openai-completions",
    baseUrl: "https://fixture.invalid/v1", capabilities: ["chat", "tool_call"], enabled: true }, now);
  const userPrompt = `Channel: ${channel.id}\n\nTask: ${task.title}\n\n${task.prompt}`;
  const preparedBody = { schemaVersion: 1, boundary: "pi-model-context", taskId: task.id,
    systemPrompt: "Fixture system", userPrompt, model: { id: "fixture-model", provider: "suspension-fixture",
      api: "openai-completions", baseUrl: "https://fixture.invalid/v1", reasoning: false,
      input: ["text"], contextWindow: 100000, maxTokens: 1024 }, thinkingLevel: "off",
    tools: [{ name: "read", description: "Owned fixture read", parameters: { type: "object" } }] };
  const execution = { schemaVersion: 1, runnerId: "pi", input: { cwd,
    task: { id: task.id, title: task.title, prompt: task.prompt, channelId: channel.id },
    provider: { provider: "suspension-fixture", model: "fixture-model", api: "openai-completions",
      baseUrl: "https://fixture.invalid/v1" }, tools: ["read"], systemPrompt: "Fixture system" },
    toolHydrationEnabled: false, preparedInput: { ...preparedBody, fingerprint: hash(preparedBody) } };
  const policy = core.applyConversationModeToEffectiveRunPolicySnapshot(core.resolveSessionRunPolicy({
    workspacePolicy: store.getApprovalPolicy(), authorizationMode: "always", workspaceAccessMode: "full_access",
    channelBoundPath: cwd }).snapshot, "default");
  const unit = store.createWorkUnit({ workspaceId: core.DEFAULT_WORKSPACE_ID, kind: "task_run", ownerType: "task",
    ownerId: task.id, taskId: task.id, channelId: channel.id, runnerId: "pi", status: "running",
    idempotencyKey: "suspension-unit", createdByActor: "system", request: {}, now });
  const attempt = store.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: 1, runtimeInstanceId: "suspension-source",
    runnerId: "pi", effectiveRunnerId: "pi", providerPresetId: preset.id, status: "started", now });
  const run = store.createRun({ id: "suspension-run", cwd, taskId: task.id, channelId: channel.id,
    threadId: thread.id, workUnitId: unit.id,
    providerPresetId: preset.id, providerName: "suspension-fixture", providerModel: "fixture-model",
    taskSnapshot: execution.input.task, providerSnapshot: {}, contextViewId: "suspension-context", contextViewCreatedAt: now,
    requestSnapshot: { authorizationMode: "always", workspaceAccessMode: "full_access", effectivePolicySnapshot: policy,
      runnerExecutionInput: execution }, createdAt: now });
  store.linkRunToWorkUnit(run.id, unit.id, now);
  store.markRunStarted(run.id, now);
  const sourceFence = core.toRuntimeAttemptFence(attempt);
  store.appendExecutionEvent(run.id, sourceFence, "run_start", { taskId: task.id, cwd,
    provider: run.providerName, model: run.providerModel });
  const view = [{ role: "user", content: userPrompt, timestamp: 1 }];
  const create = (ports = store) => new OrdinaryRunProgressController({ store: ports, run, sourceFence, policySnapshot: policy });
  const read = () => store.readRunProgressCheckpointForRecovery({ runId: run.id, sourceFence,
    expectedLineage: core.captureRunProgressCheckpointLineage(store, store.getRun(run.id), policy).lineage });
  const addRound = (id = "owned-read") => {
    const args = { path: "owned.txt" }, content = [{ type: "text", text: "owned fixture result" }];
    store.appendExecutionEvent(run.id, sourceFence, "tool_start", { toolCallId: id, toolName: "read", args });
    store.appendExecutionEvent(run.id, sourceFence, "tool_end", { toolCallId: id, toolName: "read", result: { content }, isError: false });
    view.push({ role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id, name: "read", arguments: args }], timestamp: 2 },
      { role: "toolResult", toolCallId: id, toolName: "read", content, isError: false, timestamp: 3 });
  };
  return { cwd, store, run, unit, attempt, sourceFence, view, create, read, addRound,
    input: () => ({ modelView: structuredClone(view), activeToolCallIds: [] }),
    rows: () => store.database.prepare("SELECT * FROM run_progress_checkpoints WHERE run_id=? ORDER BY source_event_seq").all(run.id) };
}

test("suspension verifies persisted SDK optional undefined fields without treating them as view drift", async t => {
  const f = await fixture(t); f.addRound();
  f.view[1].responseId = undefined;
  f.view[2].details = undefined; f.view[2].usage = undefined;
  const controller = f.create();
  assert.equal(controller.sealSuspensionBoundary(f.input()).kind, "sealed");
  assert.deepEqual(f.read().modelView, JSON.parse(JSON.stringify(f.view)));
  f.view[2].details = { changed: true };
  assert.deepEqual(controller.sealSuspensionBoundary(f.input()), { kind: "blocked", code: "checkpoint.lineage_mismatch" },
    "a real payload change without a new canonical event cannot reuse the sealed head");
});

async function delegatedFixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-suspension-child-progress-"));
  const store = core.createSqliteRunStore(cwd);
  t.after(async () => { store.close(); await rm(cwd, { recursive: true, force: true }); });
  const thread = store.createLingThread({ kind: "task", title: "Delegated suspension", objective: "Seal the owned child view." }, now);
  const unit = store.createWorkUnit({ id: "root-unit", workspaceId: core.DEFAULT_WORKSPACE_ID,
    kind: "task_run", ownerType: "run", ownerId: "root", status: "claimed", idempotencyKey: "root-unit",
    createdByActor: "system", request: {}, now });
  store.createWorkUnitAttempt({ id: "root-attempt", workUnitId: unit.id, attemptNumber: 1,
    runtimeInstanceId: "runtime", runnerId: "pi", status: "created", now });
  store.createRun({ id: "root", cwd, threadId: thread.id, workUnitId: unit.id, taskId: "inline-task",
    providerName: "fixture", providerModel: "fixture-model", taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, createdAt: now });
  store.linkRunToWorkUnit("root", unit.id, now);
  const d = createBudgetHarness(cwd, { store, now, later: "2026-10-23T01:00:00.001Z" });
  d.freeze(); d.start();
  const child = d.spawn();
  const starts = new WeakMap(), preparations = new WeakMap();
  const read = (map, token) => { assert.ok(map.has(token), "fixture Host custody is required"); return map.get(token); };
  const lifecycle = new SqliteDelegationLifecycleStore({ database: d.db }, {
    getRun: id => store.getRun(id), getWorkUnit: id => store.getWorkUnit(id),
    getWorkUnitAttempt: id => store.getWorkUnitAttempt(id), getDelegationStep: id => store.getDelegationStep(id),
    getDelegationBudgetReservation: id => d.writer.getDelegationBudgetReservation(id), getArtifact: id => store.getArtifact(id),
    createArtifactWithinTransaction: input => d.ports.createArtifactWithinTransaction(input),
    createWorkUnitAttemptWithinTransaction: input => store.runtimeWorkUnits.createWorkUnitAttemptWithinTransaction(input),
    transitionRunStatus: input => store.transitionRunStatus(input), transitionWorkUnitStatus: input => store.transitionWorkUnitStatus(input),
    updateWorkUnitAttemptStatus: input => store.updateWorkUnitAttemptStatus(input), appendRuntimeEvent: input => store.appendRuntimeEvent(input),
    assertDispatchAuthorityWithinTransaction: input => d.writer.assertDelegatedChildDispatchAuthorityWithinTransaction(input),
    readRunnerStartObservation: token => read(starts, token), readExecutionPreparation: token => read(preparations, token),
  });
  const claimed = lifecycle.claimDelegatedChild({ reservationId: child.reservation.id, expectedStepRevision: 0,
    runtimeInstanceId: "suspension-child-source", now: "2026-10-23T01:00:00.001Z" });
  const sourceFence = core.toRuntimeAttemptFence(claimed.attempt);
  const task = claimed.run.taskSnapshot;
  const policy = core.applyConversationModeToEffectiveRunPolicySnapshot(core.resolveSessionRunPolicy({
    workspacePolicy: store.getApprovalPolicy(), authorizationMode: "smart", workspaceAccessMode: "workspace_write",
    channelBoundPath: cwd }).snapshot, "default");
  const userPrompt = `Task: ${task.title}\n\n${task.prompt}`;
  const preparedBody = { schemaVersion: 1, boundary: "pi-model-context", taskId: task.id,
    systemPrompt: "Fixture child system", userPrompt, model: { id: claimed.run.providerModel, provider: claimed.run.providerName,
      api: "openai-responses", baseUrl: "https://provider.invalid/v1", reasoning: false,
      input: ["text"], contextWindow: 100000, maxTokens: 1024 }, thinkingLevel: "off",
    tools: [{ name: "read", description: "Owned fixture read", parameters: { type: "object" } }] };
  const runnerExecutionInput = { schemaVersion: 1, runnerId: "pi", input: { cwd, task,
    provider: { provider: claimed.run.providerName, model: claimed.run.providerModel, api: "openai-responses",
      baseUrl: "https://provider.invalid/v1" }, tools: ["read"], systemPrompt: "Fixture child system" },
    toolHydrationEnabled: false, preparedInput: { ...preparedBody, fingerprint: hash(preparedBody) } };
  const preparation = Object.freeze({});
  preparations.set(preparation, { schemaVersion: 1, kind: "delegation.execution.v1", stepId: child.stepId,
    reservationId: child.reservation.id, rootRunId: d.root.id, parentRunId: d.root.id, childRunId: claimed.run.id,
    sourceFence, runnerId: "pi", preparedAt: "2026-10-23T01:00:00.001Z",
    requestSnapshot: { cwd, task: structuredClone(task), parentRunId: d.root.id, threadId: thread.id, runnerId: "pi",
      authorizationMode: "smart", workspaceAccessMode: "workspace_write" },
    runnerExecutionInput, effectivePolicySnapshot: policy });
  lifecycle.commitDelegatedChildPreparation({ reservationId: child.reservation.id, sourceFence,
    preparation, now: "2026-10-23T01:00:00.002Z" });
  const observation = Object.freeze({});
  starts.set(observation, { childRunId: claimed.run.id, sourceFence, runnerId: "pi",
    observationId: "suspension-child-sdk-start", observedAt: "2026-10-23T01:00:00.002Z" });
  const started = lifecycle.commitDelegatedChildStart({ reservationId: child.reservation.id, sourceFence,
    observation, now: "2026-10-23T01:00:00.002Z" });
  const run = started.run;
  store.appendExecutionEvent(run.id, sourceFence, "run_start", { taskId: task.id, cwd,
    provider: run.providerName, model: run.providerModel });
  const args = { path: "owned-child.txt" }, content = [{ type: "text", text: "child fixture result" }];
  store.appendExecutionEvent(run.id, sourceFence, "tool_start", { toolCallId: "child-read", toolName: "read", args });
  store.appendExecutionEvent(run.id, sourceFence, "tool_end", { toolCallId: "child-read", toolName: "read", result: { content }, isError: false });
  const modelView = [{ role: "user", content: userPrompt, timestamp: 1 },
    { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "child-read", name: "read", arguments: args }], timestamp: 2 },
    { role: "toolResult", toolCallId: "child-read", toolName: "read", content, isError: false, timestamp: 3 }];
  return { store, run, child, sourceFence, modelView, controller: new OrdinaryRunProgressController({
    store, run, sourceFence, policySnapshot: JSON.parse(JSON.stringify(policy)),
    delegationBinding: { reservationId: child.reservation.id, targetFence: sourceFence } }) };
}

test("a live delegated child seals its own view without pretending it is a stopped handoff", async t => {
  const f = await delegatedFixture(t);
  const input = { modelView: f.modelView, activeToolCallIds: [] };
  const sealed = f.controller.sealSuspensionBoundary(input);
  const current = f.store.getRun(f.run.id);
  const ownHead = f.store.readRunProgressCheckpointForRecovery({ runId: current.id, sourceFence: f.sourceFence,
    expectedLineage: core.captureRunProgressCheckpointLineage(f.store, current).lineage });
  assert.equal(ownHead.kind, "verified", JSON.stringify(ownHead));
  assert.equal(sealed.kind, "sealed", JSON.stringify(sealed));
  assert.deepEqual(sealed.witness.sourceFence, f.sourceFence);
  assert.equal(f.controller.sealSuspensionBoundary(input).kind, "sealed");
  assert.equal(f.store.getWorkUnitAttempt(f.sourceFence.attemptId).status, "started");
  assert.equal(f.store.getDelegationStep(f.child.stepId).state, "running");
});

test("suspension seals a pristine SDK view even when ordinary progress is not needed", async t => {
  const f = await fixture(t), controller = f.create();
  assert.deepEqual(controller.beforeProviderBoundary(f.input()), { kind: "not_needed" });
  assert.equal(f.rows().length, 0);
  const sealed = controller.sealSuspensionBoundary(f.input());
  assert.equal(sealed.kind, "sealed", JSON.stringify(sealed));
  const verified = f.read();
  assert.equal(verified.kind, "verified", JSON.stringify(verified));
  assert.deepEqual(sealed.witness, verified.witness);
  assert.deepEqual(verified.modelView, f.view);
  assert.equal(f.store.getWorkUnitAttempt(f.attempt.id).status, "started");
});

test("suspension revalidates an existing exact head rather than inserting another checkpoint", async t => {
  const f = await fixture(t), controller = f.create();
  f.addRound();
  assert.equal(controller.beforeProviderBoundary(f.input()).kind, "committed");
  const before = f.rows();
  const sealed = controller.sealSuspensionBoundary(f.input());
  assert.equal(sealed.kind, "sealed", JSON.stringify(sealed));
  assert.deepEqual(f.rows(), before);
  assert.deepEqual(sealed.witness, f.read().witness);
  // A returned DTO must not mutate the controller's in-memory expected head.
  sealed.witness.sourceFence.attemptId = "forged-returned-witness";
  assert.equal(controller.sealSuspensionBoundary(f.input()).kind, "sealed");
});

test("suspension does not reuse a head when the actual SDK view no longer matches", async t => {
  const f = await fixture(t), controller = f.create();
  f.addRound();
  assert.equal(controller.beforeProviderBoundary(f.input()).kind, "committed");
  const before = f.rows(), input = f.input();
  input.modelView.at(-1).content[0].text = "not the sealed tool result";
  assert.equal(controller.sealSuspensionBoundary(input).kind, "blocked");
  assert.deepEqual(f.rows(), before);
});

test("suspension rejects open tool batches even with a previously committed head", async t => {
  const f = await fixture(t), controller = f.create();
  f.addRound();
  assert.equal(controller.beforeProviderBoundary(f.input()).kind, "committed");
  assert.deepEqual(controller.sealSuspensionBoundary({ ...f.input(), activeToolCallIds: ["in-flight"] }),
    { kind: "blocked", code: "checkpoint.effect_unknown" });
});

test("suspension cannot bless a final assistant as an ordinary paired-tool checkpoint", async t => {
  const f = await fixture(t), controller = f.create();
  f.addRound();
  f.view.push({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "finished" }], timestamp: 4 });
  assert.equal(controller.sealSuspensionBoundary(f.input()).kind, "blocked");
  assert.equal(f.rows().length, 0);
});

test("suspension still requires a complete view when there are no new tool_end events", async t => {
  const f = await fixture(t), controller = f.create();
  assert.deepEqual(controller.sealSuspensionBoundary({ modelView: undefined, activeToolCallIds: [] }),
    { kind: "blocked", code: "checkpoint.snapshot_unavailable" });
  assert.equal(f.rows().length, 0);
});

test("suspension seals a newer canonical watermark even without another completed tool", async t => {
  const f = await fixture(t), controller = f.create();
  f.addRound();
  assert.equal(controller.beforeProviderBoundary(f.input()).kind, "committed");
  const before = f.read();
  assert.equal(before.kind, "verified");
  f.store.appendExecutionEvent(f.run.id, f.sourceFence, "turn_start", {});
  assert.deepEqual(controller.beforeProviderBoundary(f.input()), { kind: "not_needed" });
  const sealed = controller.sealSuspensionBoundary(f.input());
  assert.equal(sealed.kind, "sealed", JSON.stringify(sealed));
  assert.equal(sealed.witness.sourceEventSeq, before.witness.sourceEventSeq + 1);
  assert.equal(sealed.witness.headRevision, before.witness.headRevision + 1);
  assert.equal(f.rows().length, 2);
});

test("a stale source cannot reuse a previously sealed head", async t => {
  const f = await fixture(t), controller = f.create();
  f.addRound();
  assert.equal(controller.beforeProviderBoundary(f.input()).kind, "committed");
  const before = f.rows();
  f.store.updateWorkUnitAttemptStatus({ ...f.sourceFence, status: "lost", now, endedAt: now });
  assert.deepEqual(controller.sealSuspensionBoundary(f.input()), { kind: "blocked", code: "checkpoint.lineage_mismatch" });
  assert.deepEqual(f.rows(), before);
});

test("suspension rechecks current permissions on a head with no new canonical events", async t => {
  const f = await fixture(t), controller = f.create();
  f.addRound();
  assert.equal(controller.beforeProviderBoundary(f.input()).kind, "committed");
  const before = f.rows();
  f.store.updateApprovalPolicy({ toolDecisions: { read: "deny" } }, now);
  assert.deepEqual(controller.sealSuspensionBoundary(f.input()), { kind: "blocked", code: "checkpoint.permission_drift" });
  assert.deepEqual(f.rows(), before);
});

test("missing durable payload cannot be replaced by the controller's cached SDK view", async t => {
  const f = await fixture(t), controller = f.create();
  f.addRound();
  assert.equal(controller.beforeProviderBoundary(f.input()).kind, "committed");
  const before = f.rows();
  f.store.database.prepare("UPDATE artifacts SET sealed_payload_json=NULL WHERE id=?").run(before[0].model_view_artifact_id);
  assert.equal(controller.sealSuspensionBoundary(f.input()).kind, "blocked");
  assert.deepEqual(f.rows(), before);
});

test("the Core canonical batch veto wins even if the in-memory active set is empty", async t => {
  const f = await fixture(t), controller = f.create();
  f.addRound();
  assert.equal(controller.beforeProviderBoundary(f.input()).kind, "committed");
  const before = f.rows();
  f.store.appendExecutionEvent(f.run.id, f.sourceFence, "tool_start", {
    toolCallId: "late-open-read", toolName: "read", args: { path: "late.txt" } });
  assert.equal(controller.sealSuspensionBoundary(f.input()).kind, "blocked");
  assert.deepEqual(f.rows(), before);
});

for (const code of ["checkpoint.effect_unjournaled", "checkpoint.effect_unknown", "checkpoint.head_conflict", "checkpoint.commit_failed"]) {
  test(`suspension blocks Core ${code}; live-capable is not suspend-capable`, async t => {
    const f = await fixture(t);
    let calls = 0;
    const ports = new Proxy(f.store, { get(target, key) {
      if (key === "commitRunProgressCheckpoint") return () => { calls++; return { kind: "blocked", code }; };
      const value = target[key];
      return typeof value === "function" ? value.bind(target) : value;
    } });
    assert.deepEqual(f.create(ports).sealSuspensionBoundary(f.input()), { kind: "blocked", code });
    assert.equal(calls, 1);
    assert.equal(f.rows().length, 0);
  });
}
