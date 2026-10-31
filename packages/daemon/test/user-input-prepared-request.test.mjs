import assert from "node:assert/strict";
import test from "node:test";
import { toRuntimeAttemptFence, createSqliteRunStore } from "../../core/dist/index.js";
import { userInputTranscriptFixture, now, acceptedAt, claimedAt } from "../../core/test/support/user-input-transcript-fixture.mjs";
import { prepareUserInputContinuationRequest, readUserInputContinuationPreparedRequest } from "../dist/features/runs/user-input-prepared-request.js";
import { executeRunRequest, createDetachedRunExecutionSink } from "../dist/features/runs/orchestrator.js";
import { channelOperationPlanFingerprintV1 } from "../../contracts/dist/index.js";
import { createDelegatedStepRequirement } from "../dist/features/channels/workflow-step-requirement.js";
import { createWorkflowOperationExecutionSnapshot } from "../dist/features/runs/workflow-operation-snapshot.js";
import { typedOperation } from "./support/workflow-operation-gate-fixture.mjs";
import { prepareFixtureTaskInput } from "./support/prepared-input-fixture.mjs";
import { capturePreparedRunnerInput } from "../dist/features/runs/prepared-runner-input.js";
import { createWorkflowAgentContextStamp } from "../dist/features/channels/agent-context-consistency.js";
import { buildConversationContextProjection } from "../dist/features/channels/context-processing/conversation-context-projector.js";

async function fixture(t, surface = "normal", sourceOptions = {}) {
  const f = await userInputTranscriptFixture(t, { surface, ...sourceOptions });
  f.sourceTask = { id: f.run.taskId, title: "Build fixture", prompt: "Build index.mjs. Preserve the existing work.", ...(f.channel ? { channelId: f.channel.id } : {}) };
  f.sourceRequest = { cwd: f.cwd, workspaceCwd: f.cwd, task: f.sourceTask, threadId: f.thread.id, turnId: f.turn.turnId,
    teammateId: f.participantId, workflowStepId: f.step?.id, runnerId: "pi", tools: ["read", "write"],
    provider: { provider: "fixture", model: "fixture", api: "openai-completions", baseUrl: "https://fixture.invalid/v1",
      apiKey: "fixture-only-not-a-credential", headers: { Authorization: "fixture-only-not-a-credential" } },
    permissionConfirmation: { mode: "full_access", confirmed: true, confirmedAt: now, reason: "Old fixture grant" },
    permissionMode: "full_access", sourceMessageId: f.turn.item.id, createdByActor: "local-user" };
  f.saveSource = () => f.db.prepare("UPDATE run_sessions SET task_snapshot_json=?,request_snapshot_json=?,provider_snapshot_json=? WHERE id=?")
    .run(JSON.stringify(f.sourceTask), JSON.stringify(f.sourceRequest), JSON.stringify(f.sourceRequest.provider), f.run.id);
  f.captureSource = async (overrides = {}, evidence = {}) => {
    const options = { cwd: f.cwd, task: f.sourceTask, provider: f.sourceRequest.provider,
      tools: f.sourceRequest.tools, appendSystemPrompt: f.sourceRequest.appendSystemPrompt, ...overrides };
    f.sourceRequest.runnerExecutionInput = capturePreparedRunnerInput({ runnerId: f.attempt.effectiveRunnerId,
      options, preparedInput: await prepareFixtureTaskInput(options), ...evidence });
    f.saveSource();
    return options;
  };
  await f.captureSource();
  f.addEvent = (type, data) => {
    const value = f.store.appendEvent(f.run.id, type, data);
    f.db.prepare("UPDATE run_events SET ts=? WHERE id=?").run(now, value.id);
    return value;
  };
  f.start = (answers) => {
    f.submit(answers);
    const events = f.store.listEvents(f.run.id);
    f.store.commitUserInputYield({ threadId: f.thread.id, requestId: f.request.requestId, expectedRequestVersion: 1,
      sourceFence: toRuntimeAttemptFence(f.attempt), quiescence: { kind: "runner_quiesced", runnerId: f.attempt.runnerId,
        stoppedAt: acceptedAt, lastRunEventSeq: events.at(-1)?.seq ?? 0 } }, "2026-09-07T00:00:02.000Z");
    f.delivery = f.store.claimUserInputDelivery({ threadId: f.thread.id, deliveryId: f.receipt.deliveryId,
      expectedRevision: 1, ownerId: "preparation-worker", leaseMs: 1000 }, claimedAt);
    f.claim = { threadId: f.thread.id, deliveryId: f.delivery.deliveryId, expectedRevision: f.delivery.revision,
      ownerId: f.delivery.claim.ownerId, claimToken: f.delivery.claim.token };
  };
  f.prepare = () => prepareUserInputContinuationRequest(f.store, f.claim, claimedAt);
  return f;
}
for (const surface of ["normal", "private", "channel"]) {
  test(`prepared ${surface} request keeps its logical owner and exact saved answer`, async t => {
    const f = await fixture(t, surface);
    f.start([{ questionId: "theme", kind: "text", text: "深色\n```js\nconst x = 1;\n```" }]);
    const prepared = f.prepare(), request = prepared.request;
    assert.equal(request.threadId, f.thread.id); assert.equal(request.turnId, f.turn.turnId);
    assert.equal(request.teammateId, f.participantId); assert.equal(request.task.id, f.run.taskId);
    assert.equal(request.task.channelId, f.channel?.id); assert.equal(request.parentRunId, f.run.id);
    assert.equal(request.continuationReason, "user_input_answer");
    assert.match(request.task.prompt, /Preserve the existing work/);
    assert.ok(request.task.prompt.includes("深色\n```js\nconst x = 1;\n```"));
    assert.equal(request.permissionConfirmation, undefined); assert.equal(request.permissionMode, undefined);
    assert.equal(request.provider.apiKey, undefined); assert.equal(request.provider.headers, undefined);
    assert.equal(request.normalConversationContext, undefined);
    assert.equal(request.sourceMessageId, f.turn.item.id);
    assert.deepEqual(request.tools, ["read", "write"]);
    assert.equal(f.store.getRun(f.delivery.successorRunId), undefined);
    assert.equal(f.store.listWorkUnitAttempts(f.unit.id).length, 1);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM ling_turns").get().n, 1);
    assert.equal(f.store.getUserInputDelivery(f.thread.id, f.delivery.deliveryId).status, "claimed");
    assert.ok(Object.isFrozen(request));
    assert.deepEqual(f.prepare(), prepared);
  });
}
test("option answers include the option label and do not become operation approval", async t => {
  const f = await fixture(t); f.start();
  const { request } = f.prepare();
  assert.match(request.task.prompt, /深色/);
  assert.match(request.task.prompt, /not grant/);
  assert.equal(request.authorizationMode, undefined);
});
test("only original Run evidence enters preparation and narration remains separate from tool facts", async t => {
  const f = await fixture(t);
  f.addEvent("assistant_text_delta", { text: "I will inspect." });
  f.addEvent("message_end", { role: "assistant", text: "I will inspect." });
  f.addEvent("tool_start", { toolCallId: "read-1", toolName: "read", args: { path: "index.mjs" } });
  f.addEvent("tool_end", { toolCallId: "read-1", toolName: "read", result: { text: "existing fixture code" }, isError: false });
  f.start();
  const sibling = f.store.createRun({ id: "foreign-run", cwd: f.cwd, taskId: "foreign-task", providerName: "fixture", providerModel: "fixture",
    taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, createdAt: claimedAt });
  f.store.markRunStarted(sibling.id, claimedAt);
  f.store.appendEvent(sibling.id, "message_end", { role: "assistant", text: "PRIVATE-SIBLING-MARKER" });
  const { request } = f.prepare();
  assert.equal(request.task.prompt.split("I will inspect.").length - 1, 1);
  assert.match(request.task.prompt, /existing fixture code/);
  assert.ok(!request.task.prompt.includes("PRIVATE-SIBLING-MARKER"));
  assert.equal(request.userInputContinuationContext.throughEventSequence, 4);
  assert.equal(request.userInputContinuationContext.eventRefs.length, 4);
});
test("stored Task/workflow step remains the same and a sibling is not included", async t => {
  const f = await fixture(t, "channel", { storedTask: true, workflow: true }); f.start();
  const { request } = f.prepare();
  assert.equal(request.workflowStepId, f.step.id); assert.equal(request.task.id, f.storedTask.id);
  assert.ok(!request.task.prompt.includes(f.siblingStep.id));
});
test("database reopen and unrelated later conversation do not rebuild the prepared input", async t => {
  const f = await fixture(t); f.start(); const prepared = f.prepare();
  f.store.appendConversationUserTurn({ threadId: f.thread.id, title: "Different topic", userInstruction: "LATER-MARKER", idempotencyKey: "later",
    payload: { body: "LATER-MARKER", format: "markdown", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] } }, claimedAt);
  const other = createSqliteRunStore(f.cwd);
  try { assert.deepEqual(readUserInputContinuationPreparedRequest(other, f.thread.id, f.delivery.deliveryId), prepared); }
  finally { other.close(); }
});
test("expired worker and cancellation cannot create preparation", async t => {
  const f = await fixture(t); f.start();
  assert.throws(() => prepareUserInputContinuationRequest(f.store, f.claim, "2026-09-07T00:00:05.000Z"), error => error.code === "delivery_conflict");
  f.store.cancelUserInputWait({ threadId: f.thread.id, sourceRunId: f.run.id }, claimedAt);
  assert.throws(() => f.prepare(), error => error.code === "delivery_conflict");
  assert.equal(f.store.getUserInputContinuationPreparation(f.thread.id, f.delivery.deliveryId, "request"), undefined);
});
test("source request identity drift fails closed rather than importing another owner", async t => {
  const f = await fixture(t); f.sourceRequest.teammateId = "another-agent"; f.saveSource(); f.start();
  assert.throws(() => f.prepare(), error => error.code === "user_input_source_request_invalid");
});
test("missing task prompt cannot silently produce an answer-only task", async t => {
  const f = await fixture(t); delete f.sourceTask.prompt; f.saveSource(); f.start();
  assert.throws(() => f.prepare(), error => error.code === "user_input_source_request_invalid");
});
test("source input drift after preparation is rejected on read, not recaptured", async t => {
  const f = await fixture(t); f.start(); f.prepare();
  f.sourceTask.prompt = "Changed after preparation"; f.saveSource();
  assert.throws(() => readUserInputContinuationPreparedRequest(f.store, f.thread.id, f.delivery.deliveryId), error => error.code === "user_input_prepared_request_changed");
});
test("source context budget failure does not truncate the answer or create preparation", async t => {
  const f = await fixture(t); f.sourceTask.prompt = "a".repeat(1_048_577); await f.captureSource(); f.start();
  assert.throws(() => f.prepare(), error => error.code === "user_input_context_over_budget");
  assert.equal(f.store.getUserInputContinuationPreparation(f.thread.id, f.delivery.deliveryId, "request"), undefined);
});
test("scope is resolved before reading another participant's corrupt preparation", async t => {
  const f = await fixture(t); f.start(); f.prepare();
  f.db.prepare("UPDATE conversation_context_snapshots SET payload_json='{}' WHERE snapshot_use='user_input_continuation_request'").run();
  assert.equal(readUserInputContinuationPreparedRequest(f.store, "foreign-thread", f.delivery.deliveryId), undefined);
  assert.throws(() => readUserInputContinuationPreparedRequest(f.store, f.thread.id, f.delivery.deliveryId));
});
for (const key of ["workspaceCwd", "linkedMessageId", "provider"]) {
  test(`source ${key} cannot redirect continuation outside its Host ownership`, async t => {
    const f = await fixture(t);
    f.sourceRequest[key] = key === "provider" ? { ...f.sourceRequest.provider, model: "foreign-model" } : "foreign-target";
    f.saveSource(); f.start();
    assert.throws(() => f.prepare(), error => error.code === "user_input_source_request_invalid");
  });
}
test("original policy intent is frozen but is not treated as a renewed approval", async t => {
  const f = await fixture(t); f.sourceRequest.approvalProfile = { mode: "strict", requiredForTools: ["write"] }; f.saveSource(); f.start();
  const { request } = f.prepare(), policy = request.userInputContinuationContext.sourcePolicyIntent;
  assert.deepEqual(policy, { permissionMode: "full_access", approvalProfile: { mode: "strict", requiredForTools: ["write"] } });
  assert.equal(policy.permissionConfirmation, undefined);
  assert.equal(request.permissionConfirmation, undefined);
});
for (const reason of ["user_input_answer", "manual_resume"]) {
  test(`ordinary new-run entry rejects answer continuation before any workspace access: ${reason}`, async () => {
    const errors = [], completions = [];
    const forbidden = new Proxy({}, { get() { throw new Error("ordinary entry must not access runtime or workspace"); } });
    const request = { continuationReason: reason, ...(reason === "manual_resume" ? { userInputContinuationContext: {} } : {}) };
    const result = await executeRunRequest(request, { ...createDetachedRunExecutionSink(), writeError: (status, body) => errors.push({ status, body }) },
      forbidden, forbidden, { isShuttingDown: () => false, trackCompletion: promise => completions.push(promise) }, forbidden, forbidden, forbidden);
    assert.equal(result, undefined); assert.equal(completions.length, 1);
    assert.equal(errors.length, 1); assert.equal(errors[0].status, 409);
    assert.equal(errors[0].body.error, "user_input_continuation_coordinator_required");
  });
}
async function typedFixture(t) {
  const f = await fixture(t, "channel", { storedTask: true, workflow: true });
  const operation = typedOperation("file_read", "index.mjs");
  operation.binding.ownerParticipantId = f.participantId;
  const plan = { bindingVersion: 1, operations: [operation], fingerprint: channelOperationPlanFingerprintV1([operation]) };
  f.step = f.store.updateChannelWorkflowStep(f.step.id, { metadata: { executionPlan: plan, executionOperationIds: [operation.id] } }, now);
  const requirement = createDelegatedStepRequirement({ workflow: f.workflow, step: f.step,
    participant: { expectedOutcome: "verification" }, manifestFingerprint: "fixture-manifest" });
  f.step = f.store.updateChannelWorkflowStep(f.step.id, { metadata: { ...f.step.metadata, delegatedRequirement: requirement } }, now);
  Object.assign(f.sourceRequest, { delegatedRequirement: requirement, executionOperationBindings: [operation],
    workflowOperationExecution: createWorkflowOperationExecutionSnapshot(f.step) });
  f.saveSource(); return f;
}
test("typed workflow preparation preserves the full required operation and participant basis", async t => {
  const f = await typedFixture(t); f.start();
  const { request } = f.prepare();
  assert.deepEqual(request.delegatedRequirement, f.sourceRequest.delegatedRequirement);
  assert.deepEqual(request.executionOperationBindings, f.sourceRequest.executionOperationBindings);
  assert.deepEqual(request.workflowOperationExecution, f.sourceRequest.workflowOperationExecution);
});
async function workflowContextFixture(t) {
  const f = await typedFixture(t);
  f.store.updateChannelWorkflow(f.workflow.id, { metadata: { ...f.workflow.metadata,
    sourceMessageId: f.turn.item.id, sourceTurnId: f.turn.turnId } }, now);
  f.step = f.store.updateChannelWorkflowStep(f.step.id, { metadata: { ...f.step.metadata,
    sourceMessageId: f.turn.item.id } }, now);
  const projection = buildConversationContextProjection({ store: f.store,
    sourceItemId: f.turn.item.id, view: "workflow_step", includeSourceTurnItems: false });
  const stamp = createWorkflowAgentContextStamp({ store: f.store, sourceItemId: f.turn.item.id,
    contextProjection: projection.metadata, consumerTeammateId: f.participantId });
  // This preparation test only needs the consumed provenance metadata. Model
  // input still comes from the separately captured, exact SDK execution.
  f.sourceRequest.contextPack = { agentContext: stamp, contextProjection: projection.metadata };
  f.saveSource();
  return f;
}
test("workflow answer preparation retains the exact consumed Host context stamp", async t => {
  const f = await workflowContextFixture(t); f.start();
  const prepared = f.prepare();
  assert.deepEqual(prepared.request.contextPack, f.sourceRequest.contextPack);
  assert.deepEqual(f.prepare(), prepared);
});
for (const corruption of ["missing", "foreign-participant", "foreign-source", "projection-mismatch"]) {
  test(`workflow answer preparation rejects ${corruption} consumed context stamp`, async t => {
    const f = await workflowContextFixture(t);
    const pack = f.sourceRequest.contextPack;
    if (corruption === "missing") delete pack.agentContext;
    if (corruption === "foreign-participant") pack.agentContext.consumerTeammateId = "foreign-agent";
    if (corruption === "foreign-source") pack.agentContext.sourceItemId = "foreign-source-item";
    if (corruption === "projection-mismatch") pack.contextProjection = { ...pack.contextProjection,
      projectionVersion: "foreign-projection" };
    f.saveSource(); f.start();
    assert.throws(() => f.prepare(), error => error.code === "user_input_source_request_invalid");
    assert.equal(f.store.getUserInputContinuationPreparation(f.thread.id, f.delivery.deliveryId, "request"), undefined);
  });
}
for (const key of ["delegatedRequirement", "executionOperationBindings", "workflowOperationExecution"]) {
  test(`typed workflow cannot downgrade a missing ${key} to an unrestricted continuation`, async t => {
    const f = await typedFixture(t); delete f.sourceRequest[key]; f.saveSource(); f.start();
    assert.throws(() => f.prepare(), error => error.code === "user_input_source_request_invalid");
  });
}
test("failed tool output remains failed evidence and pre-stop partial narration is not lost", async t => {
  const f = await fixture(t);
  f.addEvent("tool_start", { toolName: "read", toolCallId: "read", args: { path: "missing.mjs" } });
  f.addEvent("tool_end", { toolName: "read", toolCallId: "read", result: { message: "File missing" }, isError: true });
  f.addEvent("assistant_text_delta", { text: "Need the correct filename." });
  f.start(); const { request } = f.prepare();
  assert.match(request.task.prompt, /"isError":true/);
  assert.match(request.task.prompt, /Need the correct filename/);
});
test("a missing event in the frozen source window cannot be silently omitted", async t => {
  const f = await fixture(t); f.addEvent("message_end", { role: "assistant", text: "before" });
  f.addEvent("message_end", { role: "assistant", text: "after" }); f.start();
  f.db.prepare("DELETE FROM run_events WHERE run_id=? AND seq=1").run(f.run.id);
  assert.throws(() => f.prepare(), error => error.code === "user_input_source_request_invalid");
});
test("source permission drift cannot replace the first frozen policy intent", async t => {
  const f = await fixture(t); f.start(); f.prepare();
  f.sourceRequest.permissionMode = "balanced"; f.saveSource();
  assert.throws(() => readUserInputContinuationPreparedRequest(f.store, f.thread.id, f.delivery.deliveryId));
});
for (const surface of ["normal", "private", "channel"]) {
  test(`actual ${surface} builder output reaches SDK preparation and original-WorkUnit admission`, async t => {
    const f = surface === "channel" ? await typedFixture(t) : await fixture(t, surface); f.start();
    const preparedRequest = f.prepare(), request = preparedRequest.request;
    const options = { cwd: request.cwd, task: request.task, provider: { ...request.provider, reasoning: false }, tools: request.tools };
    const preparedInput = await prepareFixtureTaskInput(options);
    const runnerExecutionInput = capturePreparedRunnerInput({ runnerId: "pi", options, preparedInput });
    assert.ok(preparedInput.userPrompt.includes(request.task.prompt));
    assert.match(preparedInput.userPrompt, /深色/);
    const execution = f.store.saveUserInputContinuationPreparation({ ...f.claim, stage: "execution", parentRef: preparedRequest.ref,
      payload: { schemaVersion: 1, runnerId: "pi", providerName: options.provider.provider, providerModel: options.provider.model,
        taskSnapshot: request.task, providerSnapshot: options.provider, requestSnapshot: request,
        runRequestSnapshot: { ...request, runnerExecutionInput },
        preparedInput, preparedInputFingerprint: preparedInput.fingerprint, runnerExecutionInput } }, claimedAt).snapshot;
    const binding = f.store.admitUserInputContinuation({ ...f.claim, executionRef: { id: execution.id, fingerprint: execution.fingerprint },
      runtimeInstanceId: "fixture-sdk-runtime" }, claimedAt);
    assert.equal(binding.fence.workUnitId, f.unit.id);
    assert.equal(f.store.getLingTurnForRun(binding.runId).id, f.turn.turnId);
    assert.equal(f.store.getRun(binding.runId).teammateId, f.participantId);
    assert.deepEqual(readUserInputContinuationPreparedRequest(f.store, f.thread.id, f.delivery.deliveryId), preparedRequest);
    assert.equal(f.store.getUserInputDelivery(f.thread.id, f.delivery.deliveryId).status, "claimed");
    assert.equal(f.store.getUserInputContinuationReceipt(f.thread.id, f.delivery.deliveryId), undefined);
  });
}

for (const surface of ["normal", "private", "channel"]) {
  test(`continuation uses actual ${surface} SDK task and runtime Memory/Skill additions`, async t => {
    const f = await fixture(t, surface);
    f.sourceRequest.appendSystemPrompt = ["REQUEST_ONLY_MUST_NOT_REPLACE_RUNTIME"];
    const appended = ["RUNTIME_MEMORY: preserve user-chosen dark theme", "RUNTIME_SKILL: test before final report"];
    const usedMemory = { memoryIds: ["fixture-memory"], recallQuery: "saved query", policyVersion: "fixture-policy" };
    await f.captureSource({ task: { ...f.sourceTask, prompt: "ACTUAL_SDK_TASK_WITH_ACCEPTED_CONTEXT" },
      systemPrompt: "SOURCE_SYSTEM_PROMPT", appendSystemPrompt: appended }, { usedMemory });
    f.store.recallMemory = () => assert.fail("continuation must not select new Memory");
    f.start();
    const prepared = f.prepare(), request = prepared.request;
    assert.match(request.task.prompt, /ACTUAL_SDK_TASK_WITH_ACCEPTED_CONTEXT/);
    assert.doesNotMatch(request.task.prompt, /Build index.mjs/);
    assert.deepEqual(request.appendSystemPrompt, appended);
    assert.equal(request.systemPrompt, "SOURCE_SYSTEM_PROMPT");
    assert.deepEqual(request.preselectedMemoryUse, usedMemory);
    assert.equal(request.runnerId, f.attempt.effectiveRunnerId);
    assert.equal(typeof request.userInputContinuationContext.sourceExecutionInputFingerprint, "string");
    assert.equal(request.runnerExecutionInput, undefined, "old execution cannot impersonate a prepared successor");
    const options = { cwd: request.cwd, task: request.task, provider: request.provider,
      tools: request.tools, systemPrompt: request.systemPrompt, appendSystemPrompt: request.appendSystemPrompt };
    const sdk = await prepareFixtureTaskInput(options);
    for (const text of appended) assert.ok(sdk.systemPrompt.includes(text));
    assert.ok(sdk.userPrompt.includes("ACTUAL_SDK_TASK_WITH_ACCEPTED_CONTEXT"));
    assert.deepEqual(readUserInputContinuationPreparedRequest(f.store, f.thread.id, f.delivery.deliveryId), prepared);
  });
}

for (const change of ["missing", "fingerprint", "foreign-task", "task-prompt", "foreign-cwd", "foreign-runner", "foreign-provider", "malformed-task"]) {
  test(`continuation rejects ${change} source SDK input instead of falling back to the old request`, async t => {
    const f = await fixture(t), source = f.sourceRequest.runnerExecutionInput;
    if (change === "missing") delete f.sourceRequest.runnerExecutionInput;
    if (change === "fingerprint") source.preparedInput.fingerprint = "bad";
    if (change === "foreign-task") source.input.task.id = "foreign-task";
    if (change === "task-prompt") source.input.task.prompt = "DIFFERENT_FROM_SDK_USER_PROMPT";
    if (change === "foreign-cwd") source.input.cwd = "/foreign";
    if (change === "foreign-runner") source.runnerId = "foreign-runner";
    if (change === "foreign-provider") source.input.provider.model = "foreign-model";
    if (change === "malformed-task") source.input.task.prompt = null;
    f.saveSource(); f.start();
    assert.throws(() => f.prepare(), error => error.code === "user_input_source_request_invalid");
    assert.equal(f.store.getUserInputContinuationPreparation(f.thread.id, f.delivery.deliveryId, "request"), undefined);
  });
}

test("a source execution change after preparation invalidates replay even when the raw request is unchanged", async t => {
  const f = await fixture(t);
  await f.captureSource({ appendSystemPrompt: ["ORIGINAL_RUNTIME_CONTEXT"] });
  f.start(); f.prepare();
  await f.captureSource({ appendSystemPrompt: ["REPLACEMENT_RUNTIME_CONTEXT"] });
  assert.throws(() => readUserInputContinuationPreparedRequest(f.store, f.thread.id, f.delivery.deliveryId),
    error => error.code === "user_input_prepared_request_changed");
});
