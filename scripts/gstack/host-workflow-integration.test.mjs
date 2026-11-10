import "./managed-integration-guard.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore } from "../../packages/core/dist/index.js";
import { PiRunnerAdapter } from "../../packages/runner-pi/dist/index.js";
import { stream } from "../../packages/runner-pi/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js";
import { prepareRunSkillSource } from "../../packages/daemon/dist/features/runs/skill-source-context.js";
import { withGstackHostContext } from "../../packages/daemon/dist/features/runs/gstack-host-context.js";
import { createDetachedRunExecutionSink, executeRunRequest } from "../../packages/daemon/dist/features/runs/orchestrator.js";
import { ActiveRunRegistry } from "../../packages/daemon/dist/runtime/active-runs.js";
import { createRunnerRegistry } from "../../packages/daemon/dist/runtime/runners.js";
import { RuntimeSupervisor } from "../../packages/daemon/dist/runtime/supervisor.js";
import { RunStoreRegistry } from "../../packages/daemon/dist/runtime/store-registry.js";
import { resolveConfig } from "../../packages/daemon/dist/config.js";
import { prepareUserInputContinuationExecution } from "../../packages/daemon/dist/features/runs/user-input-execution-preparation.js";
import { restorePreparedRunnerOptions } from "../../packages/daemon/dist/features/runs/prepared-runner-input.js";
import { withUserInputContinuationReceiver } from "../../packages/daemon/dist/features/runs/user-input-continuation-receiver.js";

const source = process.env.LING_GSTACK_EXECUTABLE_BUNDLE;
const hash = value => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const originalManifest = "sha256:bf6c489f3629107fbfba09dae571a04b7e867e635a6e73c1eb065e0940dc81db";
async function bodies() {
  const bytes = await readFile(join(source, "manifest.json"));
  assert.equal(hash(bytes), originalManifest);
  const manifest = JSON.parse(bytes), rows = [];
  for (const entry of manifest.skills) {
    const bytes = await readFile(join(source, entry.entryPath));
    const record = manifest.files.find(file => file.path === entry.entryPath);
    assert.equal(bytes.length, record.sizeBytes); assert.equal(hash(bytes), record.checksum);
    rows.push({ id: entry.id, markdown: bytes.toString("utf8"), checksum: record.checksum });
  }
  assert.equal(rows.length, 57);
  return rows;
}
function publish(store, row) {
  store.upsertSkillSourceSnapshot({ id: `gs-${row.id}`, skillId: row.id, sourceKind: "gstack-skill-directory",
    upstreamName: "gstack", upstreamVersion: "1.91.101.0", rawSkillMarkdown: row.markdown,
    sourceChecksum: row.checksum, reviewStatus: "published" }, new Date().toISOString());
}

test("all57 complete frozen bodies prepare real Pi tool schemas without claiming delegation or workflow execution", {
  skip: !source && "requires frozen body source", timeout: 60000,
}, async t => {
  const work = await mkdtemp(join(tmpdir(), "ling-gs-host57-"));
  const store = createSqliteRunStore(work);
  t.after(async () => { store.close(); await rm(work, { recursive: true, force: true }); });
  const rows = [];
  for (const row of await bodies()) {
    publish(store, row);
    const selected = prepareRunSkillSource(store, row.id, "no_operation");
    const input = withGstackHostContext({ cwd: work, agentDir: join(work, "agent"),
      task: { id: `task-${row.id}`, title: row.id, prompt: `Inspect ${row.id} prerequisites; do not execute external actions.` },
      provider: { provider: "fixture", model: "fixture", api: "openai-completions", baseUrl: "https://fixture.invalid/v1" },
      tools: ["read"], appendSystemPrompt: [selected.promptFragment],
      initialToolSurface: { mediaGeneration: false, toolHydration: false, userInput: true } }, selected.context);
    const prepared = await new PiRunnerAdapter().prepareTaskInput(input);
    assert.equal(selected.context.loadedChars, row.markdown.length); assert.equal(selected.context.truncated, false);
    assert.ok(prepared.systemPrompt.includes(row.markdown), row.id);
    assert.match(prepared.systemPrompt, /AskUserQuestion means request_user_input/);
    assert.match(prepared.systemPrompt, /No native delegation tool/);
    assert.ok(prepared.tools.some(tool => tool.name === "request_user_input"));
    rows.push({ id: row.id, bodyChecksum: row.checksum, fullBody: true,
      preparedFingerprint: prepared.fingerprint, nativeQuestionSchema: true, delegation: "unavailable",
      workflowExecution: "pending" });
  }
  await writeFile(join(process.env.LING_GSTACK_RESOURCE_ROOT, "artifacts/report/all57-host-preparation-proof.json"),
    JSON.stringify({ sourceManifestChecksum: originalManifest, rows, providerCalls: 0, releaseEligible: false,
      scope: "real-complete-bodies-and-pi-preparation-not-57-live-workflows" }, null, 2));
});

test("actual gs review pause and saved answer feed real successor preparation and SDK receipt with fixture scheduling", {
  skip: !source && "requires frozen body source", timeout: 60000,
}, async t => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-gs-question-"));
  const stores = new RunStoreRegistry(createSqliteRunStore), active = new ActiveRunRegistry();
  const supervisor = new RuntimeSupervisor(resolveConfig({ defaultWorkspaceCwd: cwd }));
  t.after(async () => { supervisor.releaseAll(); stores.closeAll(); await rm(cwd, { recursive: true, force: true }); });
  const store = stores.getStore(cwd), now = new Date().toISOString();
  publish(store, (await bodies()).find(row => row.id === "review"));
  const teammateId = "teammate_builtin_engineer";
  store.replaceTeammateSkillBindings(teammateId, [{ skillId: "review", enabled: true, source: "user" }], now);
  const preset = store.createProviderPreset({ kind: "openai-compatible", displayName: "Offline gs fixture", providerId: "gs-fixture",
    model: "fixture", api: "openai-completions", baseUrl: "https://fixture.invalid/v1", authHeader: false,
    reasoning: true, capabilities: ["chat", "tool_call", "reasoning"], enabled: true }, now);
  store.recordProviderCheckResult(preset.id, { ok: true, code: "ready", message: "Scripted transport only", checkedAt: now });
  const thread = store.createLingThread({ kind: "teammate_direct", teammateId, title: "Gs question", objective: "Local gs decision" }, now);
  const turn = store.appendConversationUserTurn({ threadId: thread.id, teammateId, title: "Gs question",
    userInstruction: "Review the local fixture.", idempotencyKey: "gs-question-source", payload: {
      body: "Review the local fixture.", format: "markdown", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [],
    } }, now);
  let calls = 0, wait, wireTools, wireSystem, resumedRunId;
  const input = { schemaVersion: 1, waitMode: "required", questions: [{ questionId: "review-scope", prompt: "Review this scope?",
    required: true, allowFreeText: true, options: [{ optionId: "review", label: "Review" }, { optionId: "stop", label: "Stop" }] }] };
  class Runner extends PiRunnerAdapter {
    registerCustomProviderIfNeeded(runtime, provider) {
      super.registerCustomProviderIfNeeded(runtime, provider);
      runtime.registerProvider(provider.provider, { api: "openai-completions", streamSimple: (model, context, options) =>
        stream(model, context, { ...options, fetch: async (_url, request) => {
          calls++;
          const body = JSON.parse(request.body);
          if (calls === 2) {
            assert.ok(resumedRunId);
            assert.equal(store.getUserInputDelivery(thread.id, answer.deliveryId).status, "applied");
            assert.ok(store.getUserInputContinuationReceipt(thread.id, answer.deliveryId));
            assert.ok(JSON.stringify(body.messages).includes("Review this scope?"));
            assert.equal(body.messages.find(message => message.role === "system" || message.role === "developer")?.content, wireSystem);
            return new Response('data: {"choices":[{"index":0,"delta":{"content":"Fixture accepted saved answer."},"finish_reason":null}]}\n\n'
              + 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
            { headers: { "content-type": "text/event-stream" } });
          }
          assert.equal(calls, 1, "this protocol fixture expects exactly one question and one continuation response");
          wireTools = (body.tools ?? []).map(tool => tool.function.name);
          wireSystem = body.messages.find(message => message.role === "system" || message.role === "developer")?.content;
          const delta = { tool_calls: [{ index: 0, id: "gs-native-question", type: "function",
            function: { name: "request_user_input", arguments: JSON.stringify(input) } }] };
          return new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`
            + `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`
            + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
        } }) });
    }
  }
  const adapter = new Runner();
  const errors = [], runners = createRunnerRegistry([{ id: "pi", displayName: "Gs SDK fixture", status: "enabled", adapter }]);
  const runId = await executeRunRequest({ cwd, workspaceCwd: cwd, threadId: thread.id, turnId: turn.turnId,
    sourceMessageId: turn.item.id, teammateId, requestedSkillId: "review", providerPresetId: preset.id,
    task: { id: "gs-question-task", title: "Gs review", prompt: "Review the local fixture." }, agentDir: join(cwd, "agent"),
    tools: ["read"], idempotencyKey: "gs-review-question-run", createdByActor: "local-user" }, {
    ...createDetachedRunExecutionSink(), writeError: (_status, error) => errors.push(error),
  }, runners, stores, active, supervisor, { resolve: () => undefined }, {}, {
    enableUserInputPause: true, afterRunYielded: (_run, result) => { wait = result; },
  });
  assert.ok(runId, JSON.stringify(errors));
  const run = store.getRun(runId);
  assert.ok(wireTools?.includes("request_user_input"), JSON.stringify({ wireTools, error: run.errorMessage }));
  assert.match(wireSystem, /Ling gs Host mapping v1/);
  assert.equal(run.status, "yielded", run.errorMessage); assert.equal(calls, 1);
  assert.equal(store.getLingTurnForRun(runId).status, "waiting_for_input");
  assert.equal(active.get(runId), undefined);
  const request = store.getUserInputRequest(thread.id, wait.checkpoint.requestId);
  assert.equal(request.status, "pending");
  const frozen = structuredClone(run.requestSnapshot.runnerExecutionInput);
  assert.equal(frozen.skillSourceContext.skillId, "review");
  assert.equal(frozen.skillSourceContext.truncated, false);
  const answer = store.submitUserInputAnswer({ threadId: thread.id, submission: { schemaVersion: 1,
    requestId: request.requestId, expectedVersion: request.requestVersion, expectedStatusRevision: request.statusRevision,
    idempotencyKey: "gs-review-real-answer", answers: [{ questionId: "review-scope", kind: "option", optionId: "review" }] } }, new Date().toISOString());
  assert.equal(store.getUserInputRequest(thread.id, request.requestId).status, "answered");
  assert.ok(answer.deliveryId); assert.deepEqual(store.getRun(runId).requestSnapshot.runnerExecutionInput, frozen);
  assert.equal(calls, 1, "answer persistence alone must not dispatch a model or grant permission");
  const delivery = store.claimUserInputDelivery({ threadId: thread.id, deliveryId: answer.deliveryId,
    expectedRevision: 1, ownerId: "gs-resume-fixture", leaseMs: 60000 }, new Date().toISOString());
  const claim = { threadId: thread.id, deliveryId: delivery.deliveryId, expectedRevision: delivery.revision,
    ownerId: delivery.claim.ownerId, claimToken: delivery.claim.token };
  const controller = new AbortController();
  const liveOptions = { ...frozen.input, signal: controller.signal,
    onUserInputRequest: async () => { throw new Error("This fixture must not generate another question"); } };
  const prepared = await prepareUserInputContinuationExecution({ store, claim, runnerId: "pi", adapter, currentOptions: liveOptions,
    now: () => new Date().toISOString(), assertCurrent: () => { assert.equal(active.isShuttingDown(), false); } });
  assert.equal(calls, 1, "SDK preparation performs no model transport");
  assert.deepEqual(prepared.execution.skillSourceContext, frozen.skillSourceContext);
  assert.deepEqual(prepared.execution.preparedInput.tools, frozen.preparedInput.tools);
  const binding = store.admitUserInputContinuation({ ...claim, executionRef: prepared.ref,
    runtimeInstanceId: "gs-resume-fixture-runtime" }, new Date().toISOString());
  resumedRunId = binding.runId;
  // Only startup scheduling is a fixture. Do not record this as public Host dispatch or live-model skill acceptance.
  const options = withUserInputContinuationReceiver({ store, threadId: thread.id, binding, adapter,
    options: { ...restorePreparedRunnerOptions(prepared.execution, liveOptions), onEvent: event => {
      if (event.type !== "run_start") return;
      const startedAt = new Date().toISOString();
      assert.ok(store.updateWorkUnitAttemptStatus({ ...binding.fence, status: "started", startedAt, now: startedAt }));
      assert.equal(store.transitionWorkUnitStatus({ ...binding.fence, expectedStatus: "claimed", event: "runner_started", actor: "runner", now: startedAt }).ok, true);
      assert.equal(store.transitionRunStatus({ runId: binding.runId, expectedStatus: "queued", event: "runner_started", actor: "runner", now: startedAt }).ok, true);
    } } });
  await adapter.runTask(options);
  assert.equal(calls, 2);
  assert.equal(store.getUserInputDelivery(thread.id, answer.deliveryId).status, "applied");
  assert.deepEqual(store.getRun(runId).requestSnapshot.runnerExecutionInput, frozen);
  assert.equal(store.getLingTurnForRun(binding.runId).id, turn.turnId);
  assert.equal(binding.fence.workUnitId, run.workUnitId);
  await writeFile(join(process.env.LING_GSTACK_RESOURCE_ROOT, "artifacts/report/gs-native-question-proof.json"), JSON.stringify({
    sourceManifestChecksum: originalManifest, skillId: "review", preparedFingerprint: frozen.preparedInput.fingerprint,
    wireTools, scriptedProviderCalls: calls, externalProviderCalls: 0, durablePause: true, durableAnswer: true,
    successorExecutionPreparation: true, receiverAcknowledgedBeforeTransport: true,
    resumedModelExecution: true, scheduling: "explicit-fixture-transitions-not-product-coordinator", releaseEligible: false,
    scope: "real-gs-body-pi-pause-answer-preparation-receiver-with-scripted-transport-not-live-skill-or-public-client" }, null, 2));
});
