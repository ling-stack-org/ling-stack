import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DEFAULT_WORKSPACE_ID, SqliteRunStore, applyConversationModeToEffectiveRunPolicySnapshot,
  resolveSessionRunPolicy, resolveStoragePaths, toRuntimeAttemptFence,
} from "@ling-stack/core";
import { PiRunnerAdapter, readPreparedPiInput } from "@ling-stack/runner-pi";
import { stream } from "../../runner-pi/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js";
import { resolveConfig } from "../dist/config.js";
import { createHarnessFeatureSnapshot } from "../dist/features/harness/index.js";
import { assessDelegatedRunRecovery } from "../dist/features/harness/delegations/delegated-run-recovery.js";
import { createDelegatedRunDispatchAuthority, rebuildDelegatedRunRequest } from "../dist/features/harness/delegations/delegated-run-dispatch.js";
import { admitOriginalDelegationRoot, createOriginalDelegationStoreComposition } from "../dist/features/harness/delegations/store-composition.js";
import { createDetachedRunExecutionSink, executeRunRequest } from "../dist/features/runs/orchestrator.js";
import { resolveProviderForRun } from "../dist/features/runs/providers.js";
import { ActiveRunRegistry } from "../dist/runtime/active-runs.js";
import { createRunnerRegistry } from "../dist/runtime/runners.js";
import { patchWorkspaceRuntimeSettings } from "../dist/runtime/runner-settings.js";
import { RunStoreRegistry } from "../dist/runtime/store-registry.js";
import { RuntimeSupervisor } from "../dist/runtime/supervisor.js";

const KEY_REF = "env:DELEGATED_COMPACTION_FIXTURE_KEY";
const clock = () => new Date().toISOString();
const markerText = "DELEGATED_EFFECT_COMMITTED_ONCE\n";
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function response({ toolCallId, name, args, text, inputTokens = 100 }) {
  const delta = toolCallId ? { tool_calls: [{ index: 0, id: toolCallId, type: "function",
    function: { name, arguments: JSON.stringify(args) } }] } : { content: text };
  const records = [{ choices: [{ index: 0, delta, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: toolCallId ? "tool_calls" : "stop" }] },
    { choices: [], usage: { prompt_tokens: inputTokens, completion_tokens: 16, total_tokens: inputTokens + 16 } }];
  return new Response(records.map(record => `data: ${JSON.stringify(record)}\n\n`).join("") + "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } });
}

/** Real Pi compaction, built-in read/write, Host journal and SQLite; only Provider networking is replaced. */
async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-delegated-compaction-"));
  const paused = deferred(), release = deferred(), controls = {};
  const observed = { calls: [], receipts: [], accepted: [], events: [], errors: [], preparations: [], wire: [],
    summaryRequests: 0, sourceRequests: 0, restoredRequests: 0, wrote: false, tailRead: false };
  let store;
  class CompactionRunner extends PiRunnerAdapter {
    compacting = false;
    restored = false;
    async prepareTaskInput(options) {
      const prepared = await super.prepareTaskInput(options);
      observed.preparations.push(prepared);
      return prepared;
    }
    async runTask(options) {
      observed.calls.push(options);
      this.restored = Boolean(options.compactionRecovery);
      this.compacting = false;
      assert.equal(readPreparedPiInput(options.preparedInput).fingerprint, observed.preparations[0].fingerprint);
      assert.deepEqual(options.preparedInput.tools.map(tool => tool.name).sort(), ["read", "write"],
        "the dedicated channel must authorize both actual fixture tools before the source SDK starts");
      let firstProvider = true;
      return super.runTask({ ...options,
        onPreparedInputAccepted: async (receipt, signal) => {
          observed.receipts.push(receipt);
          if (options.compactionRecovery) await controls.beforeReceiver?.(options);
          await options.onPreparedInputAccepted(receipt, signal);
          observed.accepted.push(receipt);
        },
        onEvent: event => {
          if (event.type === "context_compaction_start") this.compacting = true;
          if (event.type === "context_compaction_end") this.compacting = false;
          if (event.type === "tool_end" && !event.isError) {
            if (event.toolCallId === "delegated-write-once") observed.wrote = true;
            if (event.toolCallId === "delegated-tail-read") observed.tailRead = true;
          }
          options.onEvent?.(event);
        },
        onTaskContinuationBoundary: async (boundary, modelView) => {
          if (options.compactionRecovery && boundary === "before_provider_request" && firstProvider) {
            firstProvider = false;
            await controls.beforeFirstProvider?.(options);
          }
          const directive = await options.onTaskContinuationBoundary?.(boundary, modelView);
          if (!options.compactionRecovery && boundary === "before_provider_request"
            && observed.wrote && observed.tailRead && observed.summaryRequests > 0) {
            const checkpoint = store.getLatestRunCompactionCheckpoint(options.runId);
            const tail = store.listEvents(options.runId).findLast(event => event.type === "tool_end"
              && event.data.toolCallId === "delegated-tail-read");
            assert.equal(checkpoint?.state, "committed");
            assert.ok(checkpoint.sourceEventSeq >= tail.seq, "pause only after the actual Host progress seal");
            paused.resolve(checkpoint);
            await release.promise;
          }
          return directive;
        },
      });
    }
    registerCustomProviderIfNeeded(runtime, provider) {
      super.registerCustomProviderIfNeeded(runtime, provider);
      runtime.registerProvider(provider.provider, { api: "openai-completions", apiKey: "fixture-no-network",
        streamSimple: (model, context, options) => stream(model, context, { ...options, fetch: async (_url, init) => {
          observed.wire.push({ restored: this.restored, compacting: this.compacting,
            payload: JSON.parse(init.body), modelView: structuredClone(context.messages) });
          if (this.compacting) {
            observed.summaryRequests++;
            return response({ text: "## Goal\nRead inputs, write the marker once, then inspect the tail.\n## Progress\nPrior reads have settled." });
          }
          if (this.restored) {
            observed.restoredRequests++;
            return response({ text: "The existing marker and reads are complete; no tool was repeated." });
          }
          observed.sourceRequests++;
          const index = observed.sourceRequests;
          if (index <= 12) return response({ toolCallId: `delegated-read-${index}`, name: "read",
            args: { path: join(cwd, `read-${index}.txt`) }, inputTokens: observed.summaryRequests ? 100 : 32_000 });
          if (index === 13) return response({ toolCallId: "delegated-write-once", name: "write",
            args: { path: join(cwd, "marker.txt"), content: markerText } });
          if (index === 14) return response({ toolCallId: "delegated-tail-read", name: "read",
            args: { path: join(cwd, "marker.txt") } });
          throw new Error("Source escaped the committed-compaction pause.");
        } }),
      });
    }
  }
  const adapter = new CompactionRunner();
  const supervisor = new RuntimeSupervisor(resolveConfig({ defaultWorkspaceCwd: cwd, harness: {
    continuations: { mode: "enforce" }, toolBroker: { mode: "enforce" },
    delegations: { mode: "enforce", rootBudget: { tokenBudget: 2_000_000, wallTimeBudgetMs: 120_000 } },
  } }));
  const runners = createRunnerRegistry([{ id: "pi", displayName: "Actual compaction SDK fixture", status: "enabled", adapter }]);
  const resolver = { status: ref => ({ ref, kind: "env", configured: ref === KEY_REF }),
    resolve: ref => ({ ref, configured: ref === KEY_REF, value: ref === KEY_REF ? "synthetic-no-network-key" : undefined,
      status: { ref, kind: "env", configured: ref === KEY_REF } }) };
  const composition = createOriginalDelegationStoreComposition({ supervisor, runnerRegistry: runners, secretResolver: resolver,
    delegatedDispatchAuthority: createDelegatedRunDispatchAuthority() });
  const paths = resolveStoragePaths(cwd, { homeDir: join(cwd, "fixture-home"), env: {}, workspaceStateLocation: "repo-local" }).workspace;
  store = new SqliteRunStore({ cwd, paths, delegationHostBinding: composition.binding });
  composition.bindExactStore(store);
  const registry = new RunStoreRegistry(() => store, { recoverOnOpen: false });
  assert.equal(registry.getStore(cwd), store);
  const active = new ActiveRunRegistry(), runtime = supervisor.getRuntime(cwd, store), at = clock();
  t.after(async () => {
    release.resolve(); supervisor.releaseAll(); registry.closeAll();
    await rm(cwd, { recursive: true, force: true });
  });
  await Promise.all(Array.from({ length: 12 }, (_, index) => writeFile(join(cwd, `read-${index + 1}.txt`),
    `Fixture ${index + 1}\n` + `retained-evidence-${index + 1} `.repeat(2000), "utf8")));
  store.updateApprovalPolicy({ toolDecisions: { read: "allow", write: "allow" }, allowedWritePaths: [cwd] }, at);
  patchWorkspaceRuntimeSettings(store, runners, { defaultRunnerId: "pi", allowedRunnerIds: ["pi"] }, at);
  const preset = store.createProviderPreset({ kind: "openai-compatible", displayName: "Compacting child fixture",
    providerId: "delegated-compaction-fixture", model: "fixture-model", api: "openai-completions", baseUrl: "https://delegation.invalid/v1",
    apiKeyRef: KEY_REF, authHeader: false, reasoning: false, contextWindow: 32_768, maxTokens: 256,
    capabilities: ["chat", "tool_call"], enabled: true }, at);
  store.recordProviderCheckResult(preset.id, { ok: true, code: "ready", message: "Synthetic ready", checkedAt: at });
  const provider = resolveProviderForRun(store, { providerPresetId: preset.id }, resolver);
  const channel = store.createChannel({ name: "Compacted dynamic child", boundPath: cwd, allowedTools: ["read", "write"] }, at);
  const task = store.createTask({ channelId: channel.id, title: "Parent fixture", prompt: "Parent objective must stay open." }, at);
  const taskSnapshot = { id: task.id, title: task.title, prompt: task.prompt, channelId: channel.id };
  const thread = store.createLingThread({ kind: "task", channelId: channel.id, taskId: task.id, title: task.title, objective: task.prompt }, at);
  const turn = store.createLingTurn({ threadId: thread.id, channelId: channel.id, taskId: task.id,
    kind: "initial_request", title: task.title, userInstruction: task.prompt, createdByActor: "local-user" }, at);
  const request = { cwd, workspaceCwd: cwd, task: taskSnapshot, threadId: thread.id, turnId: turn.id, providerPresetId: preset.id,
    runnerId: "pi", tools: ["read", "write"], authorizationMode: "smart", workspaceAccessMode: "workspace_write", thinkingLevel: "off",
    harnessFeatureSnapshot: createHarnessFeatureSnapshot({ harness: supervisor.getHarnessFeatures() }) };
  const unit = store.createWorkUnit({ id: "root-unit", workspaceId: DEFAULT_WORKSPACE_ID, kind: "conversation_run", ownerType: "run",
    ownerId: "root", taskId: task.id, channelId: channel.id, runnerId: "pi", effectiveRunnerId: "pi", status: "claimed",
    idempotencyKey: "root-unit", createdByActor: "system", request, now: at });
  const attempt = store.createWorkUnitAttempt({ id: "root-attempt", workUnitId: unit.id, attemptNumber: 1,
    runtimeInstanceId: runtime.runtimeInstanceId, runnerId: "pi", effectiveRunnerId: "pi", now: at });
  const root = store.createRun({ id: "root", cwd, taskId: task.id, channelId: channel.id, threadId: thread.id, turnId: turn.id,
    workUnitId: unit.id, providerPresetId: preset.id, providerName: provider.provider, providerModel: provider.model,
    taskSnapshot, providerSnapshot: {}, requestSnapshot: request, createdAt: at });
  store.linkRunToWorkUnit(root.id, unit.id, at);
  const policy = applyConversationModeToEffectiveRunPolicySnapshot(resolveSessionRunPolicy({ workspacePolicy: store.getApprovalPolicy(),
    authorizationMode: "smart", workspaceAccessMode: "workspace_write", channelBoundPath: cwd }).snapshot, thread.conversationMode.mode);
  admitOriginalDelegationRoot({ store, run: store.getRun(root.id), attempt: store.getWorkUnitAttempt(attempt.id),
    originalProvider: provider, request, effectivePolicySnapshot: policy, runtimeTools: ["read", "write"], now: at });
  // Only the pre-existing parent is seeded. The production lifecycle owns every child state.
  store.database.prepare("UPDATE run_sessions SET status='running',started_at=? WHERE id=?").run(at, root.id);
  store.database.prepare("UPDATE work_units SET status='running',started_at=? WHERE id=?").run(at, unit.id);
  store.database.prepare("UPDATE work_unit_attempts SET status='started',started_at=? WHERE id=?").run(at, attempt.id);
  store.database.prepare("UPDATE tasks SET status='running',current_run_id=? WHERE id=?").run(root.id, task.id);
  const parentFence = toRuntimeAttemptFence(store.getWorkUnitAttempt(attempt.id));
  const child = composition.lifecycle.spawn({ parentRunId: root.id, sourceFence: parentFence, spawnCallId: "compacting-child",
    objective: "Read inputs, write marker.txt exactly once, then read the marker and report. " + "goal ".repeat(100),
    requestedBudget: { tokenBudget: 1_000_000 }, required: true, now: clock() });
  const claimed = composition.lifecycle.claim({ reservationId: child.reservation.id, expectedStepRevision: 0,
    runtimeInstanceId: runtime.runtimeInstanceId, now: clock() });
  const sink = { ...createDetachedRunExecutionSink(), writeEvent: (type, data) => observed.events.push({ type, data }),
    writeError: (status, body) => observed.errors.push({ status, body }) };
  const dispatch = current => {
    const prepared = composition.lifecycle.getPreparation(current.reservation.id);
    const childRequest = rebuildDelegatedRunRequest({ store, child: current, prepared });
    return executeRunRequest(childRequest, sink, runners, registry, active, supervisor, resolver, {},
      { delegatedExecution: composition.lifecycle.createExecutionEntry(current) });
  };
  const parentBefore = { run: store.getRun(root.id), task: store.getTask(task.id), turns: store.listLingTurns({ threadId: thread.id }),
    links: store.listLingTurnRuns(turn.id) };
  const assertParentUntouched = () => {
    assert.deepEqual(store.getRun(root.id), parentBefore.run);
    assert.deepEqual(store.getTask(task.id), parentBefore.task);
    assert.deepEqual(store.listLingTurns({ threadId: thread.id }), parentBefore.turns);
    assert.deepEqual(store.listLingTurnRuns(turn.id), parentBefore.links);
  };
  return { cwd, store, composition, active, observed, controls, claimed, parentFence, paused, release, dispatch, assertParentUntouched };
}

async function interruptAndResume(f) {
  const pending = f.dispatch(f.claimed);
  void pending.catch(() => {});
  let completed = false;
  const diagnostics = () => JSON.stringify({ run: { id: f.claimed.run.id, status: f.store.getRun(f.claimed.run.id)?.status,
    errorMessage: f.store.getRun(f.claimed.run.id)?.errorMessage }, errors: f.observed.errors,
    sourceRequests: f.observed.sourceRequests, summaries: f.observed.summaryRequests,
    events: f.store.listEvents(f.claimed.run.id).filter(event => ["run_error", "context_compaction_start", "context_compaction_end", "tool_start", "tool_end"].includes(event.type))
      .map(event => ({ seq: event.seq, type: event.type, toolCallId: event.data.toolCallId, toolName: event.data.toolName,
        isError: event.data.isError, code: event.data.code, message: event.data.message, outcome: event.data.outcome })),
    completions: f.store.database.prepare("SELECT * FROM host_attempt_completions WHERE run_id=?").all(f.claimed.run.id),
    harness: f.store.listHarnessToolExecutions(f.claimed.run.id).map(item => ({ id: item.id, state: item.state, toolName: item.toolName })),
    checkpoint: f.store.getLatestRunCompactionCheckpoint(f.claimed.run.id) });
  try {
    const checkpoint = await Promise.race([f.paused.promise, pending.then(() => {
      throw new Error(`Child ended before real compaction progress: ${diagnostics()}`);
    }, error => { throw new Error(`Child failed before real compaction progress: ${diagnostics()}`, { cause: error }); })]);
    assert.ok(f.observed.summaryRequests > 0, "the actual Pi SDK must compact, not a fixture-installed summary");
    assert.equal(await readFile(join(f.cwd, "marker.txt"), "utf8"), markerText);
    const sourceFence = toRuntimeAttemptFence(f.claimed.attempt), prepared = f.composition.lifecycle.getPreparation(f.claimed.reservation.id);
    const summary = f.store.getArtifact(checkpoint.summaryArtifactId);
    assert.equal(summary.sealedPayload.boundary, "run-compaction-progress");
    assert.ok(summary.sealedPayload.modelView.some(message => message.role === "toolResult" && message.toolCallId === "delegated-write-once"));
    assert.equal(summary.sealedPayload.modelView.at(-1).toolCallId, "delegated-tail-read");
    f.composition.lifecycle.interrupt({ reservationId: f.claimed.reservation.id, parentFence: f.parentFence,
      callId: "interrupt-compacted-child", now: clock() });
    assert.equal(f.active.requestStop(f.claimed.run.id, { kind: "user_cancel", actor: "local-user", reason: "Compaction recovery fixture" }), true);
    f.release.resolve();
    assert.equal(await pending, f.claimed.run.id); completed = true;
    const state = f.composition.lifecycle.recover(f.claimed.reservation.id);
    assert.equal(state.kind, "interrupted", JSON.stringify(state));
    const completion = f.store.getHostAttemptCompletion({ runId: f.claimed.run.id, ...sourceFence });
    assert.ok(completion?.drainedAt);
    assert.equal(completion.effectCoverage, "pi_tracked_tools_v1");
    const resumed = f.composition.lifecycle.resume({ reservationId: f.claimed.reservation.id,
      expectedStepRevision: state.runtime.step.revision, parentFence: f.parentFence,
      runtimeInstanceId: f.claimed.attempt.runtimeInstanceId, callId: "resume-compacted-child", now: clock() });
    assert.equal(resumed.run.id, f.claimed.run.id);
    assert.equal(resumed.attempt.attemptNumber, 2);
    assert.deepEqual(f.composition.lifecycle.getPreparation(f.claimed.reservation.id), prepared);
    return { resumed, checkpoint, summary, prepared, sourceFence };
  } finally {
    if (!completed) {
      f.active.requestStop(f.claimed.run.id, { kind: "user_cancel", actor: "local-user", reason: "Dedicated fixture cleanup" });
      f.release.resolve(); await pending.catch(() => {});
    }
  }
}

function injectLateSourceEvent(f) {
  const seq = f.store.listEvents(f.claimed.run.id).at(-1).seq + 1;
  // Corrupt/imported persisted state only: the ordinary source-fenced writer refuses this callback.
  f.store.database.prepare("INSERT INTO run_events(id,run_id,seq,ts,type,data_json) VALUES(?,?,?,?,?,?)")
    .run(`injected-late-source-${seq}`, f.claimed.run.id, seq, clock(), "assistant_text_delta",
      JSON.stringify({ attemptId: f.claimed.attempt.id, text: "Unsealed late source progress" }));
}

test("a compacted delegated child resumes its exact Host view after a real drain without replaying reads or write", { timeout: 45_000 }, async t => {
  const f = await fixture(t), { resumed, summary, checkpoint, prepared } = await interruptAndResume(f);
  let providerBoundarySeen = false;
  f.controls.beforeFirstProvider = options => {
    const assessment = assessDelegatedRunRecovery({ store: f.store, child: resumed, prepared,
      policySnapshot: f.store.getRun(resumed.run.id).requestSnapshot.effectivePolicySnapshot, now: clock() });
    assert.equal(assessment.kind, "verified", JSON.stringify(assessment));
    assert.equal(assessment.compactionCheckpointId, checkpoint.id);
    const start = f.store.listEvents(resumed.run.id).find(event => event.type === "run_start" && event.data.attemptId === resumed.attempt.id);
    assert.ok(start, "the genuine target run_start must not invalidate the restored checkpoint");
    assert.equal(f.store.getWorkUnitAttempt(resumed.attempt.id).status, "started");
    assert.deepEqual(options.compactionRecovery.modelView, summary.sealedPayload.modelView);
    providerBoundarySeen = true;
  };
  assert.equal(await f.dispatch(resumed), resumed.run.id, JSON.stringify(f.observed.errors));
  assert.deepEqual(f.observed.errors, []);
  assert.equal(providerBoundarySeen, true);
  assert.equal(f.observed.preparations.length, 1, "resume may not re-prepare a fresh objective");
  assert.equal(f.observed.calls.length, 2);
  assert.equal(f.observed.accepted.length, 2);
  assert.equal(f.observed.accepted[1].attemptId, resumed.attempt.id);
  assert.equal(f.observed.sourceRequests, 14);
  assert.equal(f.observed.restoredRequests, 1);
  const targetWire = f.observed.wire.find(wire => wire.restored && !wire.compacting);
  assert.ok(targetWire);
  assert.ok(targetWire.payload.messages.some(message => message.role === "tool" && message.tool_call_id === "delegated-write-once"));
  assert.ok(targetWire.payload.messages.some(message => message.role === "tool" && message.tool_call_id === "delegated-tail-read"));
  const starts = f.store.listEvents(resumed.run.id).filter(event => event.type === "tool_start");
  assert.equal(starts.length, 14);
  assert.equal(starts.filter(event => event.data.toolName === "write").length, 1);
  assert.equal(new Set(starts.map(event => event.data.toolCallId)).size, 14);
  assert.ok(starts.every(event => event.data.attemptId === f.claimed.attempt.id));
  assert.equal(await readFile(join(f.cwd, "marker.txt"), "utf8"), markerText);
  const final = f.composition.lifecycle.recover(f.claimed.reservation.id);
  assert.equal(final.kind, "terminal", JSON.stringify(final));
  assert.equal(final.runtime.run.status, "succeeded");
  assert.equal(final.runtime.reservation.state, "settled");
  assert.equal(f.store.getDelegationCompletionEvidence({ rootRunIds: ["root"] }).status, "satisfied");
  f.assertParentUntouched();
});

for (const boundary of ["beforeReceiver", "beforeFirstProvider"]) {
  for (const mutation of ["late source event", "permission revocation"]) {
    test(`compacted delegated ${boundary} rechecks ${mutation} before a restored model request`, { timeout: 45_000 }, async t => {
      const f = await fixture(t), { resumed, checkpoint } = await interruptAndResume(f);
      let injected = false;
      f.controls[boundary] = () => {
        assert.equal(injected, false); injected = true;
        if (mutation === "late source event") injectLateSourceEvent(f);
        else f.store.updateApprovalPolicy({ toolDecisions: { read: "deny", write: "deny" } }, clock());
      };
      assert.equal(await f.dispatch(resumed), resumed.run.id);
      assert.equal(injected, true, "the mutation must occur after initial recovery assessment, not before dispatch");
      assert.equal(f.observed.calls.length, 2);
      assert.equal(f.observed.restoredRequests, 0, "neither failed ACK nor stale first-provider authority may call the model");
      assert.equal(f.observed.sourceRequests, 14);
      assert.equal(f.store.getLatestRunCompactionCheckpoint(resumed.run.id).id, checkpoint.id);
      assert.equal(f.store.listEvents(resumed.run.id).filter(event => event.type === "tool_start").length, 14);
      assert.equal(await readFile(join(f.cwd, "marker.txt"), "utf8"), markerText);
      const targetCharges = f.store.database.prepare("SELECT COUNT(*) AS n FROM delegation_budget_charges WHERE attempt_id=?").get(resumed.attempt.id);
      assert.equal(targetCharges.n, 0, "rejected recovery cannot reserve a new task-model invocation");
      if (boundary === "beforeReceiver") {
        assert.equal(f.observed.accepted.length, 1);
        assert.equal(f.store.getWorkUnitAttempt(resumed.attempt.id).status, "created");
        assert.equal(f.store.getDelegationStep(resumed.step.id).state, "resuming");
        assert.ok(f.observed.events.some(event => event.type === "delegation_blocked"));
        if (mutation === "late source event") assert.ok(f.observed.events.some(event => event.type === "delegation_blocked"
          && event.data.code === "checkpoint.effect_unknown"));
      } else {
        assert.equal(f.observed.accepted.length, 2);
        assert.notEqual(f.store.getRun(resumed.run.id).status, "succeeded");
      }
      f.assertParentUntouched();
    });
  }
}
