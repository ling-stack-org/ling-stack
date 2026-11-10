import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { SqliteRunStore, resolveStoragePaths, toRuntimeAttemptFence } from "@ling-stack/core";
import { hasDelegationRunnerStart } from "../../core/dist/storage/sqlite/delegation-resume-lineage.js";
import { resolveConfig } from "../dist/config.js";
import { createDelegatedRunDispatchAuthority } from "../dist/features/harness/delegations/delegated-run-dispatch.js";
import { assertDelegationRecoveryParentCurrent, createDelegationRuntimeRegistry, createDelegationWorkflowSelector } from "../dist/features/harness/delegations/runtime-registry.js";
import { createOriginalDelegationStoreComposition, readOriginalRunSuspensionLifecycle } from "../dist/features/harness/delegations/store-composition.js";
import { createDetachedRunExecutionSink, executeDelegatedRunRequest, executeExistingRunContinuation, executeRunRequest } from "../dist/features/runs/orchestrator.js";
import { ActiveRunRegistry } from "../dist/runtime/active-runs.js";
import { verifyDelegatedTerminalHandoff } from "../dist/runtime/delegated-terminal-handoff.js";
import { createRunShutdownCoordinator } from "../dist/runtime/run-shutdown-coordinator.js";
import { createRunnerRegistry } from "../dist/runtime/runners.js";
import { patchWorkspaceRuntimeSettings } from "../dist/runtime/runner-settings.js";
import { RunStoreRegistry } from "../dist/runtime/store-registry.js";
import { RuntimeSupervisor } from "../dist/runtime/supervisor.js";
import { createA21LoopbackTransport, createA21RealPiRunner } from "./support/noncompacted-recovery-crash-worker.mjs";

// Only the test-owned fork supplies an IPC channel and this explicit packet.
const sourceWorkerInput = typeof process.send === "function" && process.argv[2] ? JSON.parse(process.argv[2]) : undefined;
if (sourceWorkerInput) assert.equal(sourceWorkerInput.kind, "graceful_tree_owned_source");

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function within(promise, ms, description) {
  const controller = new AbortController();
  try {
    return await Promise.race([promise, delay(ms, undefined, { signal: controller.signal }).then(() => {
      throw new Error(`Timed out: ${description}`);
    })]);
  } finally { controller.abort(); }
}

async function recoverInDifferentProcess(t, input) {
  const nonce = randomUUID(), messages = [], output = [];
  const sourcePid = input.sourcePid ?? process.pid;
  const child = fork(fileURLToPath(new URL(input.automaticDaemon
    ? "./support/graceful-tree-daemon-recovery-worker.mjs" : "./support/graceful-tree-recovery-worker.mjs", import.meta.url)),
    [JSON.stringify({ ...input, nonce, sourcePid })], { cwd: input.cwd, execArgv: [],
      stdio: ["ignore", "pipe", "pipe", "ipc"], env: { PATH: process.env.PATH ?? "/usr/bin:/bin",
        LING_STACK_HOME: join(input.cwd, "fixture-home"), LING_STACK_DEFAULT_WORKSPACE_CWD: input.cwd } });
  child.stdout.on("data", chunk => output.push(chunk.toString()));
  child.stderr.on("data", chunk => output.push(chunk.toString()));
  child.on("message", message => messages.push(message));
  const exit = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal })); });
  let result;
  try { result = await within(exit, 20_000, "different-PID original Host tree recovery"); }
  finally {
    // Stop this exact fork before its caller can remove the fixture directory.
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM"); await within(exit, 3_000, "owned recovery worker stop");
    }
  }
  assert.equal(result.code, 0, JSON.stringify({ messages, output: output.join("").slice(-6000), result }));
  const report = messages.find(message => message.kind === "graceful_tree_worker_result");
  assert.ok(report); assert.equal(report.nonce, nonce); assert.equal(report.cwd, input.cwd);
  assert.equal(report.pid, child.pid); assert.equal(report.sourcePid, sourcePid); assert.notEqual(report.pid, sourcePid);
  assert.notEqual(report.pid, process.pid);
  return report;
}

// One real selected-workflow tree, not a synthetic suspension/receipt fixture.
// The only provider is deterministic SSE on this test's owned loopback server.
const scenarios = sourceWorkerInput ? [{ recover: true, differentProcess: true }] : [
  { recover: false }, { recover: true }, { recover: true, rejectChildAck: true }, { recover: true, failActivationOnce: true },
  { recover: true, parentInFlight: true },
  { recover: true, manualResume: true },
  { recover: true, queuedChild: true },
  { recover: true, compactedGrandchild: true },
  { recover: true, finalGrandchild: true },
  { recover: true, finalRootWait: true },
  { recover: true, finalRootWait: true, repeatFinalSuspension: true },
  { recover: false, optionalTerminalShutdown: true },
];
for (const { recover, rejectChildAck = false, failActivationOnce = false, parentInFlight = false, differentProcess = false, manualResume = false, queuedChild = false, compactedGrandchild = false, finalGrandchild = false, finalRootWait = false, repeatFinalSuspension = false, optionalTerminalShutdown = false } of scenarios)
test(optionalTerminalShutdown ? "shutdown during actual optional stop waits for verified terminal handoff without reclassifying aborted children as resumable"
  : repeatFinalSuspension ? "a restored-complete root can suspend again during real required fan-in and recover a third SDK lifetime without any new root wire"
  : finalRootWait ? "shutdown arriving during actual required fan-in retains the original final SDK boundary and restores the root without a new wire"
  : finalGrandchild ? "a real final-assistant grandchild restores complete through actual child ACK and required fan-in with zero new child wire"
  : compactedGrandchild ? "a real compacted grandchild resumes through delegated activation and actual ACK without replaying the three-level tree"
  : queuedChild ? "a durable never-dispatched child starts once only after its restored parent's actual SDK ACK"
  : manualResume ? "a restored child can be explicitly interrupted and resumed twice from each own new checkpoint"
  : differentProcess ? "the owned source Host seals and drains its three-level SDK tree before normal process exit"
  : parentInFlight ? "child actual SDK ACK preserves a live parent's in-flight reserved usage without blocking tree recovery"
  : failActivationOnce ? "failed child activation rolls back every write and a later live-parent scan can activate once" : rejectChildAck
  ? "failed child SDK ACK retains its claimed successor and cannot release the grandchild"
  : recover ? "fresh Host restores the stopped root → optional child → required grandchild with original SDK results"
  : "unified graceful shutdown stops the original SDK root → optional child → required grandchild leaf-first",
{ timeout: recover ? 60_000 : 25_000 }, async t => {
  const cwd = sourceWorkerInput?.cwd ?? await mkdtemp(join(tmpdir(), "ling-graceful-real-tree-"));
  const finalRoot = finalRootWait || optionalTerminalShutdown;
  const rootPrompt = "TREE_ROOT: spawn the optional child and read fixture.txt once."
    + (differentProcess ? " Write journaled-marker.txt once before stopping." : "");
  const childPrompt = "TREE_CHILD: spawn the required grandchild and read fixture.txt once.";
  const grandchildPrompt = "TREE_GRANDCHILD: read fixture.txt once, preserving this required work.";
  const queuedPrompt = "TREE_QUEUED: perform the durable required work that has never been dispatched.";
  const allAtBoundary = deferred(), releaseBoundaries = deferred();
  const parentRequestHeld = deferred(), releaseParentResponse = deferred();
  const repeatedBoundaryReady = deferred(), releaseRepeatedBoundary = deferred(), repeatedSources = new Map();
  let repeatedShutdownCompleted = false;
  const manualCheckpointReady = [deferred(), deferred()], releaseManualBoundary = [deferred(), deferred()];
  const manuallyInterruptedAttempts = [];
  const observed = { calls: [], boundaries: new Map(), directives: [], errors: [], delegated: [], acknowledgements: [], ackErrors: [], blockers: [] };
  const requiredFlags = finalRootWait ? [true, true] : [false, true];
  let activeRuns = new ActiveRunRegistry(), recovering = false, activationRollbackVerified = false, activationFaults = 0;
  let concurrentParentChargeId, queued;
  let compactingGrandchild = false, grandchildSummaries = 0;
  const config = resolveConfig({ defaultWorkspaceCwd: cwd, channels: { terminalReports: false }, harness: {
    continuations: { mode: "enforce" }, toolBroker: { mode: "enforce" },
    delegations: { mode: "enforce", maxDepth: 3, rootBudget: { tokenBudget: compactedGrandchild ? 2_000_000 : 100_000, wallTimeBudgetMs: 120_000 } },
  } });
  let supervisor = new RuntimeSupervisor(config);
  let transport, stores, registry, shutdown, rootExecution, shutdownWork, store;
  t.after(async () => {
    releaseBoundaries.resolve();
    releaseParentResponse.resolve();
    releaseRepeatedBoundary.resolve();
    for (const boundary of releaseManualBoundary) boundary.resolve();
    if (shutdown) await within(shutdownWork ?? shutdown.shutdown("daemon_restart"), 3_000, "owned tree cleanup").catch(() => undefined);
    await transport?.close(); supervisor.releaseAll(); stores?.closeAll();
    if (sourceWorkerInput) process.disconnect();
    else await rm(cwd, { recursive: true, force: true });
  });
  await writeFile(join(cwd, "fixture.txt"), "one owned read per original tree source\n");
  if (compactedGrandchild) await Promise.all(Array.from({ length: 12 }, (_, i) => writeFile(join(cwd, `compaction-${i + 1}.txt`),
    `Owned grandchild evidence ${i + 1}.\n` + `grandchild-evidence-${i + 1} `.repeat(2_000))));
  const wireByLevel = new Map();
  transport = await createA21LoopbackTransport(async (_count, request) => {
    if (compactedGrandchild && compactingGrandchild) {
      grandchildSummaries++;
      return { content: "## Goal\nFinish TREE_GRANDCHILD evidence.\n## Progress\nKeep all completed reads; do not repeat tools.",
        usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 } };
    }
    const user = request.body.messages.filter(message => message.role === "user").at(-1)?.content;
    const text = typeof user === "string" ? user : JSON.stringify(user);
    const level = text.includes(queuedPrompt) ? "queued" : text.includes(grandchildPrompt) ? "grandchild" : text.includes(childPrompt) ? "child" : "root";
    const previous = wireByLevel.get(level) ?? [];
    previous.push(request); wireByLevel.set(level, previous);
    if ((finalGrandchild && level === "grandchild" || finalRoot && level === "root") && !recovering && previous.length === 2) {
      if (optionalTerminalShutdown) {
        await within((async () => {
          const deadline = Date.now() + 4_900;
          while (!["child", "grandchild"].every(level => observed.boundaries.has(level))) {
            if (Date.now() >= deadline) throw new Error("Optional executors did not reach their original safe boundary");
            await delay(10);
          }
        })(), 5_000, "original child executors exist before the parent final response");
      }
      return { content: "The required grandchild finished its actual read before suspension.",
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
    }
    if (compactedGrandchild && level === "grandchild" && !recovering) {
      assert.ok(previous.length <= 12, "the actual SDK must compact bounded owned evidence");
      return { usage: { prompt_tokens: grandchildSummaries ? 100 : 32_000, completion_tokens: 5,
        total_tokens: grandchildSummaries ? 105 : 32_005 }, tool_calls: [{ index: 0,
        id: grandchildSummaries ? "grandchild-read" : `grandchild-evidence-${previous.length}`, type: "function",
        function: { name: "read", arguments: JSON.stringify({ path: grandchildSummaries ? "fixture.txt" : `compaction-${previous.length}.txt` }) } }] };
    }
    if (previous.length > 1) {
      assert.equal(recovering, true, `unexpected second request for ${level}`);
      assert.ok(observed.acknowledgements.includes(level), `${level} must actually ACK before its recovered wire`);
      if ((parentInFlight || manualResume) && level === "root" && previous.length === 2) {
        parentRequestHeld.resolve();
        await releaseParentResponse.promise;
      }
      const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
      if (manualResume && level === "child" && [2, 3].includes(previous.length)) {
        return { usage, tool_calls: [{ index: 0, id: previous.length === 2 ? "child-new-read" : "child-next-read", type: "function",
          function: { name: "read", arguments: JSON.stringify({ path: "fixture.txt" }) } }] };
      }
      if (previous.length === 2 && ["root", "child"].includes(level)) {
        const reservation = store.database.prepare(`SELECT r.id FROM delegation_budget_reservations r
          JOIN delegation_steps s ON s.id=r.delegation_step_id WHERE s.parent_run_id=? AND s.spawn_call_id=?`)
          .get(observed.boundaries.get(level).runId, `${level}-spawn`);
        assert.ok(reservation);
        return { usage, tool_calls: [{ index: 0, id: `${level}-wait`, type: "function",
          function: { name: "wait_agent", arguments: JSON.stringify({ reservationId: reservation.id, timeoutMs: 10_000 }) } }] };
      }
      return { content: `Recovered ${level} without repeating its original tools.`, usage };
    }
    const calls = [];
    if (["root", "child"].includes(level)) calls.push({ index: 0, id: `${level}-spawn`, type: "function",
      function: { name: "spawn_agent", arguments: JSON.stringify({
        objective: level === "root" ? childPrompt : grandchildPrompt, required: finalRootWait || level !== "root",
        requestedBudget: { tokenBudget: compactedGrandchild ? (level === "root" ? 1_000_000 : 600_000) : (level === "root" ? 50_000 : 20_000) },
      }) } });
    calls.push({ index: calls.length, id: `${level}-read`, type: "function",
      function: { name: "read", arguments: JSON.stringify({ path: "fixture.txt" }) } });
    if (differentProcess && level === "root") calls.push({ index: calls.length, id: "root-write", type: "function",
      function: { name: "write", arguments: JSON.stringify({ path: join(cwd, "journaled-marker.txt"),
        content: "one journaled write before restart\n" }) } });
    // Supply actual wire usage through the SDK parser. Zero/omitted SDK
    // placeholders must stay unresolved rather than being called free usage.
    return { tool_calls: calls, usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
  });
  const runner = createA21RealPiRunner(transport), realRunTask = runner.runTask.bind(runner);
  runner.runTask = options => {
    observed.calls.push(options);
    const level = options.task.prompt === queuedPrompt ? "queued" : options.task.prompt === rootPrompt ? "root" : options.task.prompt === childPrompt ? "child" : "grandchild";
    return realRunTask({ ...options,
      ...((finalGrandchild && level === "grandchild" || finalRoot && level === "root") ? { onTaskSettledBoundary: async modelView => {
        assert.equal(recovering, false, "a restored complete view does not generate a second SDK settlement");
        assert.equal(modelView.at(-1)?.role, "assistant"); assert.equal(modelView.at(-1)?.stopReason, "stop");
        assert.equal(observed.boundaries.has(level), false);
        observed.boundaries.set(level, { runId: options.runId, attemptId: options.runnerAttemptId,
          modelView: structuredClone(modelView), signal: options.signal });
        if (observed.boundaries.size === 3) allAtBoundary.resolve();
        // The root must enter the actual Host fan-in, not a test-held callback.
        if (!finalRoot) await releaseBoundaries.promise;
        try {
          const directive = await options.onTaskSettledBoundary(modelView);
          observed.directives.push({ level, directive }); return directive;
        } catch (error) { observed.errors.push({ level, boundary: "task_settled", error: error.stack ?? String(error) }); throw error; }
      } } : {}),
      ...(repeatFinalSuspension && recovering && !repeatedShutdownCompleted && level === "root" ? {
        onTaskRestoredCompleteBoundary: async modelView => {
          assert.equal(modelView.at(-1)?.stopReason, "stop");
          repeatedSources.set(level, { runId: options.runId, attemptId: options.runnerAttemptId });
          if (repeatedSources.size === 3) repeatedBoundaryReady.resolve();
          const directive = await options.onTaskRestoredCompleteBoundary(modelView);
          observed.directives.push({ level, directive }); return directive;
        },
      } : {}),
      ...(compactedGrandchild && level === "grandchild" ? { onEvent: event => {
        if (event.type === "context_compaction_start") compactingGrandchild = true;
        if (event.type === "context_compaction_end") compactingGrandchild = false;
        options.onEvent?.(event);
      } } : {}),
      ...(recovering ? { onPreparedInputAccepted: async (receipt, signal) => {
        assert.ok(options.onPreparedInputAccepted);
        if (rejectChildAck && level === "child") throw new Error("Owned child prepared ACK failure");
        if (failActivationOnce && level === "root") {
          store.database.function("e6_note_activation_fault", () => { activationFaults++; return 1; });
          store.database.exec(`CREATE TEMP TRIGGER e6_owned_child_activation_fault
            BEFORE INSERT ON run_suspension_delegated_activations
            BEGIN SELECT e6_note_activation_fault(); SELECT RAISE(ABORT, 'owned child activation commit fault'); END`);
        }
        if (parentInFlight && level === "child") {
          await within(parentRequestHeld.promise, 5_000, "actual live parent's recovered HTTP request");
          const parent = store.getRun(observed.boundaries.get("root").runId);
          const attemptId = store.getWorkUnit(parent.workUnitId).activeAttemptId;
          const charge = store.database.prepare("SELECT * FROM delegation_budget_charges WHERE run_id=? AND attempt_id=? AND state='reserved'")
            .get(parent.id, attemptId);
          assert.ok(charge, "the original Host budget port must reserve this still in-flight parent invocation");
          concurrentParentChargeId = charge.id;
        }
        try { await options.onPreparedInputAccepted(receipt, signal); }
        catch (error) { observed.ackErrors.push({ level, code: error.code, message: error.message }); throw error; }
        finally { if (parentInFlight && level === "child") releaseParentResponse.resolve(); }
        if (level !== "root") assert.ok(observed.acknowledgements.includes(level === "grandchild" ? "child" : "root"));
        observed.acknowledgements.push(level);
        if (failActivationOnce && level === "root") {
          const childId = observed.boundaries.get("child").runId;
          const child = store.getRun(childId), unit = store.getWorkUnit(child.workUnitId);
          const snapshot = () => ({ unit: store.getWorkUnit(unit.id), attempts: store.listWorkUnitAttempts(unit.id),
            step: store.getDelegationStep(unit.ownerId),
            messages: store.database.prepare("SELECT * FROM delegation_messages ORDER BY id").all(),
            activations: store.database.prepare("SELECT * FROM run_suspension_delegated_activations ORDER BY id").all(),
            artifacts: store.database.prepare("SELECT * FROM artifacts ORDER BY id").all(),
            pins: store.database.prepare("SELECT * FROM harness_artifact_pins ORDER BY artifact_id,holder").all(),
          });
          const before = snapshot(), priorFaults = activationFaults;
          const rejected = registry.recoverStore(store);
          assert.equal(rejected.dispatched, 0);
          assert.equal(activationFaults, priorFaults + 1, "the original activation transaction must reach the owned commit fault");
          assert.deepEqual(snapshot(), before, "the failed joined activation must roll back Attempt, control, artifact and pins together");
          assert.equal(before.attempts.length, 1);
          assert.equal(before.step.state, "interrupted");
          assert.equal(before.activations.length, 0);
          store.database.exec("DROP TRIGGER e6_owned_child_activation_fault");
          assert.equal(registry.recoverStore(store).dispatched, 1, "failed activation releases its private receiver, not the original reservation");
          activationRollbackVerified = true;
        }
      } } : {}), onTaskContinuationBoundary: async (boundary, modelView) => {
      if (repeatFinalSuspension && recovering && !repeatedShutdownCompleted && level !== "root"
        && boundary === "before_provider_request" && !repeatedSources.has(level)) {
        repeatedSources.set(level, { runId: options.runId, attemptId: options.runnerAttemptId });
        if (repeatedSources.size === 3) repeatedBoundaryReady.resolve();
        await releaseRepeatedBoundary.promise;
        const directive = await options.onTaskContinuationBoundary(boundary, modelView);
        observed.directives.push({ level, directive }); return directive;
      }
      if (manualResume && recovering && level === "child" && manuallyInterruptedAttempts.length < 2
        && boundary === "before_provider_request"
        && modelView?.some(message => message.role === "toolResult"
          && message.toolCallId === (manuallyInterruptedAttempts.length === 0 ? "child-new-read" : "child-next-read"))) {
        // B must own a real new checkpoint before the explicit interruption.
        const directive = await options.onTaskContinuationBoundary(boundary, modelView);
        const round = manuallyInterruptedAttempts.length;
        manuallyInterruptedAttempts.push(options.runnerAttemptId);
        manualCheckpointReady[round].resolve();
        await releaseManualBoundary[round].promise;
        return directive;
      }
      if (!recovering && !(finalGrandchild && level === "grandchild" || finalRoot && level === "root") && boundary === "before_provider_request"
        && modelView?.some(message => message.role === "toolResult" && message.toolCallId === `${level}-read`)) {
        assert.equal(observed.boundaries.has(level), false, `${level} may reach its paired boundary only once`);
        observed.boundaries.set(level, { runId: options.runId, attemptId: options.runnerAttemptId,
          modelView: structuredClone(modelView), signal: options.signal });
        if (observed.boundaries.size === 3) allAtBoundary.resolve();
        // Hold only before the original Host admission callback. The actual
        // shutdown callback must persist intent; no directive/error is forged.
        await releaseBoundaries.promise;
        try {
          const directive = await options.onTaskContinuationBoundary(boundary, modelView);
          observed.directives.push({ level, directive });
          return directive;
        } catch (error) { observed.errors.push({ level, boundary, error: error.stack ?? String(error) }); throw error; }
      }
      return options.onTaskContinuationBoundary?.(boundary, modelView);
    } });
  };
  const runners = createRunnerRegistry([{ id: "pi", displayName: "Real SDK offline graceful tree", status: "enabled", adapter: runner }]);
  const keyRef = "env:GRACEFUL_TREE_FIXTURE_KEY";
  const resolver = { status: ref => ({ ref, kind: "env", configured: ref === keyRef }),
    resolve: ref => ({ ref, configured: ref === keyRef, value: ref === keyRef ? "synthetic-no-network-key" : undefined,
      status: { ref, kind: "env", configured: ref === keyRef } }) };
  const paths = resolveStoragePaths(cwd, { homeDir: join(cwd, "fixture-home"), env: {}, workspaceStateLocation: "repo-local" }).workspace;
  let composition;
  const open = () => {
    composition = createOriginalDelegationStoreComposition({ supervisor, runnerRegistry: runners, secretResolver: resolver,
      delegatedDispatchAuthority: createDelegatedRunDispatchAuthority() });
    store = new SqliteRunStore({ cwd, paths, delegationHostBinding: composition.binding });
    composition.bindExactStore(store);
    stores = new RunStoreRegistry(() => store, { recoverOnOpen: false }); stores.getStore(cwd);
  };
  open();
  const now = new Date().toISOString();
  if (differentProcess) {
    // This case explicitly authorizes one fixture-local journaled write before
    // freezing the root/child policy. Do not omit the selected teammate profile
    // or weaken the later current-policy equality check to make it run.
    assert.ok(store.updateAiTeammate("teammate_builtin_engineer", { approvalProfile: { mode: "none" } }, now));
  }
  patchWorkspaceRuntimeSettings(store, runners, { defaultRunnerId: "pi", allowedRunnerIds: ["pi"] }, now);
  const preset = store.createProviderPreset({ kind: "openai-compatible", displayName: "Owned graceful-tree provider",
    providerId: "graceful-tree-fixture", model: "fixture-model", api: "openai-completions", baseUrl: "https://fixture.invalid/v1",
    apiKeyRef: keyRef, reasoning: false, contextWindow: compactedGrandchild ? 32_768 : 16_000, maxTokens: compactedGrandchild ? 256 : 1_000,
    capabilities: ["chat", "tool_call"], enabled: true }, now);
  store.recordProviderCheckResult(preset.id, { ok: true, code: "ready", message: "Owned deterministic loopback", checkedAt: now });
  const tools = differentProcess ? ["read", "write"] : ["read"];
  const channel = store.createChannel({ name: "Graceful real tree", boundPath: cwd, allowedTools: tools }, now);
  store.replaceTeammateChannelMemberships("teammate_builtin_engineer", [{ channelId: channel.id }], now);
  const workflow = store.createChannelWorkflow({ channelId: channel.id, title: "Graceful tree workflow", objective: rootPrompt,
    createdBy: "local-user", status: "ready" }, now);
  config.harness.delegations.selectedWorkflowIds = Object.freeze([workflow.id]);
  const createdStep = store.createChannelWorkflowStep({ workflowId: workflow.id, title: "Original root", prompt: rootPrompt,
    toParticipantId: "teammate_builtin_engineer", toParticipantLabel: "Engineer" }, now);
  const lease = store.acquireResourceLease({ workspaceId: channel.workspaceId, resourceType: "workflow_step",
    resourceKey: createdStep.id, ownerType: "workflow_step", ownerId: createdStep.id, acquiredAt: now,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString() }); assert.ok(lease);
  const begun = store.beginChannelWorkflowStepStart({ workflowStepId: createdStep.id,
    expected: store.getChannelWorkflowStep(createdStep.id), leaseId: lease.id,
    task: { channelId: channel.id, assigneeTeammateId: "teammate_builtin_engineer", title: "Graceful tree", prompt: rootPrompt }, now });
  assert.equal(begun.status, "begun");
  const task = begun.task;
  const thread = store.createLingThread({ kind: "task", channelId: channel.id, taskId: task.id, title: task.title, objective: task.prompt }, now);
  const turn = store.createLingTurn({ threadId: thread.id, kind: "initial_request", taskId: task.id, channelId: channel.id,
    title: task.title, userInstruction: task.prompt, createdByActor: "local-user" }, now);
  const sink = () => ({ ...createDetachedRunExecutionSink(), writeError: (status, body) => observed.errors.push({ status, body }),
    writeEvent: (name, body) => { if (name === "delegation_blocked") observed.blockers.push(body); } });
  const startRegistry = () => {
    registry = createDelegationRuntimeRegistry({ supervisor, activeRuns,
    isWorkflowSelected: createDelegationWorkflowSelector([workflow.id]), executeDelegatedRunRequest: input => {
      observed.delegated.push(input);
      return executeDelegatedRunRequest(input, sink(), runners, stores, activeRuns, supervisor, resolver, {});
    }, assertRecoveryParentCurrent: input => assertDelegationRecoveryParentCurrent({ ...input, activeRuns }) });
    registry.registerStore(store, composition.lifecycle);
    shutdown = createRunShutdownCoordinator({ activeRuns, delegations: registry });
  };
  startRegistry();
  rootExecution = executeRunRequest({ cwd, workspaceCwd: cwd, threadId: thread.id, turnId: turn.id,
    workflowStepId: createdStep.id, workflowStartOwner: begun.owner, teammateId: "teammate_builtin_engineer",
    task: { id: task.id, channelId: channel.id, title: task.title, prompt: task.prompt }, providerPresetId: preset.id,
    runnerId: "pi", tools, authorizationMode: "smart",
    workspaceAccessMode: "workspace_write",
    ...(differentProcess ? { approvalProfile: store.getAiTeammate("teammate_builtin_engineer").approvalProfile } : {}),
    createdByActor: "local-user" }, sink(), runners, stores, activeRuns, supervisor, resolver, {});
  void rootExecution.catch(() => undefined);
  try {
    await within(Promise.race([allAtBoundary.promise, rootExecution.then(() => {
      throw new Error("Root returned before the real three-source boundary");
    })]), 12_000, "three actual SDK tool-result boundaries");
    assert.equal(observed.calls.length, 3); assert.equal(observed.delegated.length, 2);
    if (optionalTerminalShutdown) {
      await within((async () => {
        const deadline = Date.now() + 1_900;
        while (!["child", "grandchild"].every(level => observed.boundaries.get(level).signal.aborted)) {
          if (Date.now() >= deadline) throw new Error("Optional subtree was not actually stopped by its parent's final callback");
          await delay(10);
        }
      })(), 2_000, "original optional stop has aborted the exact child executors but not drained them");
      assert.equal(observed.boundaries.get("root").signal.aborted, false);
    }
    if (finalRootWait) {
      const source = observed.boundaries.get("root");
      await within((async () => {
        const deadline = Date.now() + 1_900;
        while (!store.listRuntimeEvents(store.getRun(source.runId).workUnitId, { limit: 1000 })
          .some(event => event.data.kind === "delegation_fan_in" && event.data.status === "pending")) {
          if (Date.now() >= deadline) throw new Error("No actual required fan-in observation");
          await delay(10);
        }
      })(), 2_000, "actual required fan-in pending before shutdown");
      assert.equal(activeRuns.get(source.runId).abortController.signal.aborted, false);
    }
    const sourceWireCount = transport.requests.length;
    const sourceWireCounts = new Map([...wireByLevel].map(([level, requests]) => [level, requests.length]));
    if (compactedGrandchild) {
      assert.ok(grandchildSummaries > 0, "the grandchild must actually install a real SDK compaction");
      assert.equal(observed.boundaries.get("grandchild").modelView[0].role, "compactionSummary");
    }
    const before = store.getDelegationCompletionEvidence({ rootRunIds: [observed.boundaries.get("root").runId] });
    assert.deepEqual(before.steps.map(read => read.step.required).sort(), requiredFlags);
    if (!optionalTerminalShutdown) assert.ok(before.steps.every(read => read.step.state === "running"));
    if (queuedChild) {
      const rootSource = observed.boundaries.get("root"), rootRun = store.getRun(rootSource.runId);
      // Persist the exact spawn-committed/claim-not-yet-entered crash window
      // through the original Host composition. This additional edge is a durable
      // state fixture, not a fabricated SDK toolResult in the parent's context.
      queued = composition.lifecycle.spawn({ parentRunId: rootRun.id,
        sourceFence: toRuntimeAttemptFence(store.getWorkUnitAttempt(rootSource.attemptId)),
        spawnCallId: "queued-crash-window", objective: queuedPrompt, required: true,
        requestedBudget: { tokenBudget: 20_000 }, now: new Date().toISOString() });
      assert.equal(store.listWorkUnitAttempts(queued.childWorkUnit.id).length, 0);
      assert.equal(queued.childRun.status, "queued");
    }
    const terminalCandidates = optionalTerminalShutdown ? ["child", "grandchild"].map(level => {
      const source = observed.boundaries.get(level), active = activeRuns.get(source.runId);
      return { reference: active.terminalHandoff, source: { runId: source.runId, workUnitId: active.workUnitId,
        attemptId: active.attemptId, runtimeInstanceId: active.runtimeInstanceId, fencingToken: active.fencingToken } };
    }) : [];
    shutdownWork = shutdown.shutdown("daemon_restart");
    assert.equal(shutdown.shutdown("desktop_quit"), shutdownWork, "one exact tree shutdown shares its first cause");
    for (const candidate of terminalCandidates) assert.throws(() => verifyDelegatedTerminalHandoff(candidate.reference,
      candidate.source, "settled"), /terminal_handoff_unverified/, "the actual pending intent is not a drain or result receipt");
    if (!optionalTerminalShutdown) for (const source of observed.boundaries.values()) assert.equal(source.signal.aborted, false);
    releaseBoundaries.resolve();
    await within(Promise.all([rootExecution, shutdownWork]), 12_000, "original SDK and durable leaf-first tree stop");
    if (optionalTerminalShutdown) {
      await within(registry.settle(), 5_000, "optional terminal result publication");
      const root = observed.boundaries.get("root"), suspension = composition.lifecycle.getRunSuspensionForAttempt(root.attemptId);
      assert.equal(composition.lifecycle.getRunSuspensionStop(suspension.id).state, "stopped");
      assert.equal(suspension.seal.witness.kind, "settlement");
      assert.equal(store.getRun(root.runId).status, "running");
      const complete = store.getDelegationCompletionEvidence({ rootRunIds: [root.runId] });
      assert.deepEqual(complete.issues, []);
      assert.ok(complete.steps.every(read => read.step.state === "cancelled" && read.results.length === 1
        && read.hostCompletion?.drainedAt && read.quiescence === "verified" && read.reservation.state === "settled"));
      for (const level of ["child", "grandchild"]) {
        const source = observed.boundaries.get(level);
        assert.equal(composition.lifecycle.getRunSuspensionForAttempt(source.attemptId), undefined,
          "an already aborted optional executor must use its real terminal chain, never a resumable checkpoint");
        assert.equal(store.getRun(source.runId).status, "cancelled");
      }
      assert.equal(transport.requests.length, sourceWireCount);
      for (const candidate of terminalCandidates) {
        verifyDelegatedTerminalHandoff(candidate.reference, candidate.source, "settled");
        for (const corruption of ["missing_host_completion", "source_pointer_replaced"]) {
          // Isolated corruption probe only. Restore the real original facts in
          // the same connection; no production guard or trigger is disabled.
          store.database.exec("SAVEPOINT terminal_handoff_probe");
          try {
            if (corruption === "missing_host_completion") store.database.prepare(
              "DELETE FROM host_attempt_completions WHERE attempt_id=?").run(candidate.source.attemptId);
            else store.database.prepare("UPDATE work_units SET active_attempt_id=? WHERE id=?")
              .run(root.attemptId, candidate.source.workUnitId);
            assert.throws(() => verifyDelegatedTerminalHandoff(candidate.reference, candidate.source, "settled"),
              /terminal_handoff_unverified/, `${corruption} must not adopt a terminal Run status as proof`);
          } finally {
            store.database.exec("ROLLBACK TO terminal_handoff_probe; RELEASE terminal_handoff_probe");
          }
          verifyDelegatedTerminalHandoff(candidate.reference, candidate.source, "settled");
        }
      }
      return;
    }
    assert.deepEqual(observed.errors, []);
    assert.deepEqual(observed.directives.map(item => item.level), ["grandchild", "child", "root"], "Core begin-stop readiness is leaf-first");
    assert.equal(transport.requests.length, sourceWireCount, "no post-seal provider request may escape from any original source");
    if (!compactedGrandchild) assert.deepEqual([...wireByLevel].map(([level, requests]) => [level, requests.length]).sort(),
      [["child", 1], ["grandchild", finalGrandchild ? 2 : 1], ["root", finalRootWait ? 2 : 1]]);
    const lifecycle = readOriginalRunSuspensionLifecycle(store, supervisor), receipts = new Map();
    for (const [level, source] of observed.boundaries) {
      assert.equal(source.signal.aborted, false, "graceful SDK stop is not an external cancellation");
      const run = store.getRun(source.runId), unit = store.getWorkUnit(run.workUnitId), attempt = store.getWorkUnitAttempt(source.attemptId);
      assert.equal(run.status, "running", `${level} logical Run must stay open`);
      assert.equal(store.listWorkUnitAttempts(unit.id).length, 1, "shutdown cannot create a recovery Attempt");
      const suspension = lifecycle.getRunSuspensionForAttempt(attempt.id), stopped = lifecycle.getRunSuspensionStop(suspension.id);
      assert.equal(suspension.request.cause, "daemon_restart"); assert.equal(suspension.state, "sealed");
      if (compactedGrandchild) assert.equal(suspension.seal.witness.kind, level === "grandchild" ? "compaction" : "ordinary");
      if (finalGrandchild) assert.equal(suspension.seal.witness.kind, level === "grandchild" ? "settlement" : "ordinary");
      if (finalRootWait) assert.equal(suspension.seal.witness.kind, level === "root" ? "settlement" : "ordinary");
      assert.equal(stopped.state, "stopped"); assert.equal(stopped.begin.source.kind, level === "root" ? "root" : "delegated");
      assert.equal(stopped.receipt.sourceFence.attemptId, attempt.id); receipts.set(level, stopped);
      assert.equal(attempt.status, level === "root" ? "lost" : "cancelled");
      const completion = store.getHostAttemptCompletion({ runId: run.id, ...stopped.begin.sourceFence });
      assert.ok(completion?.drainedAt); assert.equal(completion.effectCoverage, "pi_tracked_tools_v1");
      const events = store.listEvents(run.id, { limit: 1000 });
      assert.equal(events.filter(event => event.type === "tool_end" && event.data.toolCallId === `${level}-read`).length, 1);
      assert.equal(events.filter(event => event.type === "tool_end" && event.data.toolName === "spawn_agent").length, level === "grandchild" ? 0 : 1);
      assert.equal(events.some(event => ["run_end", "run_error", "run_cancelled"].includes(event.type)), false);
      assert.equal(source.modelView.filter(message => message.role === "toolResult" && message.toolCallId === `${level}-read`).length, 1);
      const paired = source.modelView.find(message => message.role === "toolResult" && message.toolCallId === `${level}-read`);
      assert.equal(paired.isError, false); assert.match(JSON.stringify(paired.content), /one owned read per original tree source/u);
    }
    assert.deepEqual(receipts.get("root").receipt.descendants.map(proof => proof.runId).sort(),
      [observed.boundaries.get("child").runId, observed.boundaries.get("grandchild").runId,
        ...(queued ? [queued.childRun.id] : [])].sort());
    assert.deepEqual(receipts.get("child").receipt.descendants.map(proof => proof.runId), [observed.boundaries.get("grandchild").runId]);
    assert.ok([...receipts.values()].every(record => record.receipt.descendants.every(proof =>
      proof.kind === (proof.runId === queued?.childRun.id ? "never_dispatched" : "stopped"))));
    const after = store.getDelegationCompletionEvidence({ rootRunIds: [observed.boundaries.get("root").runId] });
    assert.deepEqual(after.steps.map(read => read.step.required).sort(), queued ? [false, true, true] : requiredFlags);
    assert.ok(after.steps.every(read => read.step.state === (read.childRun.id === queued?.childRun.id ? "spawning" : "interrupted") && read.results.length === 0));
    assert.equal(store.getChannelWorkflowStep(createdStep.id).status, "running");
    assert.equal(store.database.prepare("SELECT COUNT(*) n FROM run_suspension_stops WHERE state='stopped'").get().n, 3);
    assert.equal(store.database.prepare("SELECT COUNT(*) n FROM schema_migrations WHERE version=183").get().n, 1);
    const charges = store.database.prepare("SELECT run_id,state,input_tokens,output_tokens FROM delegation_budget_charges ORDER BY run_id").all();
    assert.equal(charges.length, sourceWireCount);
    assert.ok(charges.every(charge => charge.state === "measured" && charge.input_tokens > 0 && charge.output_tokens === 5));
    if (!compactedGrandchild) assert.ok(charges.every(charge => charge.input_tokens === 10));
    assert.deepEqual([...new Set(charges.map(charge => charge.run_id))].sort(), [...observed.boundaries.values()].map(source => source.runId).sort());
    t.diagnostic(JSON.stringify({ sdkSources: 3, providerRequests: transport.requests.length, originalReads: 3,
      stopped183: 3, readyOrder: observed.directives.map(item => item.level), requiredEdgesPreserved: requiredFlags }));
    if (recover) {
      const rootId = observed.boundaries.get("root").runId;
      const budgetBefore = store.database.prepare("SELECT * FROM delegation_root_budgets WHERE root_run_id=?").get(rootId);
      const reservationQuery = "SELECT id,child_run_id,parent_reservation_id,token_reserved,cost_reserved_micros,deadline_at FROM delegation_budget_reservations ORDER BY id";
      const reservationsBefore = store.database.prepare(reservationQuery).all();
      if (differentProcess) {
        const writes = store.listHarnessToolExecutions(rootId).filter(execution => execution.toolCallId === "root-write");
        assert.equal(writes.length, 1); assert.equal(writes[0].state, "succeeded");
        assert.ok(writes[0].evidenceArtifactIds.length);
        supervisor.releaseAll(); stores.closeAll();
        await new Promise((resolve, reject) => process.send({ kind: "graceful_tree_source_stopped",
          nonce: sourceWorkerInput.nonce, cwd, workflowId: workflow.id, rootId, pid: process.pid,
          sources: [...observed.boundaries].map(([level, source]) => ({ level, runId: source.runId, attemptId: source.attemptId })) },
        error => error ? reject(error) : resolve()));
        return;
      }
      supervisor.releaseAll(); stores.closeAll();
      activeRuns = new ActiveRunRegistry(); supervisor = new RuntimeSupervisor(config);
      recovering = true; shutdownWork = undefined; open(); startRegistry();
      registry.recoverStore(store);
      assert.equal(observed.acknowledgements.length, 0, "children cannot start before their stopped parent actually ACKs");
      if (queued) assert.equal(store.listWorkUnitAttempts(queued.childWorkUnit.id).length, 0);
      const pendingBeforeRecovery = store.listRuntimeEvents(store.getRun(rootId).workUnitId, { limit: 1000 })
        .filter(event => event.data.kind === "delegation_fan_in" && event.data.status === "pending").length;
      let rootRecovery = executeExistingRunContinuation({ cwd, runId: rootId, origin: "daemon_recovery",
        idempotencyDiscriminator: "graceful-tree-reopen" }, sink(), runners, stores, activeRuns, supervisor, resolver, {});
      if (repeatFinalSuspension) {
        await within(repeatedBoundaryReady.promise, 8_000, "three actual restored SDK boundaries before second shutdown");
        await within((async () => {
          const deadline = Date.now() + 1_900;
          while (store.listRuntimeEvents(store.getRun(rootId).workUnitId, { limit: 1000 })
            .filter(event => event.data.kind === "delegation_fan_in" && event.data.status === "pending").length <= pendingBeforeRecovery) {
            if (Date.now() >= deadline) throw new Error("Restored-complete root did not enter actual required fan-in");
            await delay(10);
          }
        })(), 2_000, "restored-complete SDK window remains live during required fan-in");
        const chargesBeforeSecondStop = store.database.prepare("SELECT * FROM delegation_budget_charges ORDER BY id").all();
        assert.equal(transport.requests.length, sourceWireCount, "B has neither new root nor child wire before the next safe stop");
        shutdownWork = shutdown.shutdown("daemon_restart");
        releaseRepeatedBoundary.resolve();
        await within(Promise.all([rootRecovery, shutdownWork, activeRuns.waitForIdle()]), 12_000, "second actual SDK tree stop");
        await within(registry.settle(), 5_000, "second tree registry drain");
        assert.deepEqual(observed.errors, []);
        assert.deepEqual(observed.ackErrors, []);
        for (const [level, source] of repeatedSources) {
          const suspension = composition.lifecycle.getRunSuspensionForAttempt(source.attemptId);
          const stopped = composition.lifecycle.getRunSuspensionStop(suspension.id);
          assert.equal(stopped.state, "stopped");
          assert.equal(suspension.seal.witness.kind, level === "root" ? "settlement" : "ordinary");
          assert.notEqual(source.attemptId, observed.boundaries.get(level).attemptId);
          assert.equal(store.listWorkUnitAttempts(store.getRun(source.runId).workUnitId).length, 2);
          assert.equal(store.getRun(source.runId).status, "running", "physical suspension is not logical task completion");
          receipts.set(level, stopped);
        }
        assert.deepEqual(store.database.prepare("SELECT * FROM delegation_budget_charges ORDER BY id").all(), chargesBeforeSecondStop);
        assert.deepEqual(store.database.prepare("SELECT * FROM delegation_root_budgets WHERE root_run_id=?").get(rootId), budgetBefore);
        assert.deepEqual(store.database.prepare(reservationQuery).all(), reservationsBefore);
        assert.equal(transport.requests.length, sourceWireCount);
        repeatedShutdownCompleted = true;
        supervisor.releaseAll(); stores.closeAll();
        activeRuns = new ActiveRunRegistry(); supervisor = new RuntimeSupervisor(config);
        shutdownWork = undefined; open(); startRegistry();
        registry.recoverStore(store);
        rootRecovery = executeExistingRunContinuation({ cwd, runId: rootId, origin: "daemon_recovery",
          idempotencyDiscriminator: "graceful-tree-second-reopen" }, sink(), runners, stores, activeRuns, supervisor, resolver, {});
      }
      if (manualResume) {
        await within(Promise.all([manualCheckpointReady[0].promise, parentRequestHeld.promise]), 8_000, "restored child's own checkpoint");
        await within((async () => {
          while (store.getRun(observed.boundaries.get("grandchild").runId).status !== "succeeded") await delay(10);
        })(), 5_000, "required grandchild completes before the explicit child interruption");
        const parent = store.getRun(rootId), parentUnit = store.getWorkUnit(parent.workUnitId);
        const binding = { store, runId: rootId, sourceFence: toRuntimeAttemptFence(store.getWorkUnitAttempt(parentUnit.activeAttemptId)) };
        const tools = registry.bindParent({ ...binding,
          assertCurrent: () => assertDelegationRecoveryParentCurrent({ ...binding, activeRuns }) });
        const reservation = store.database.prepare("SELECT id FROM delegation_budget_reservations WHERE child_run_id=?")
          .get(observed.boundaries.get("child").runId);
        for (let round = 0; round < 2; round++) {
          await within(manualCheckpointReady[round].promise, 8_000, `explicit successor ${round} owns its new checkpoint`);
          tools.interrupt({ reservationId: reservation.id, callId: `manual-after-restored-read-${round}` });
          releaseManualBoundary[round].resolve();
          await within(registry.settle(), 5_000, "explicit interruption's original SDK drain");
          assert.equal(store.getWorkUnitAttempt(manuallyInterruptedAttempts[round]).status, "cancelled");
          const interrupted = composition.lifecycle.recover(reservation.id);
          assert.equal(interrupted.kind, "interrupted");
          assert.equal(hasDelegationRunnerStart(store.database, interrupted.runtime.run.id, toRuntimeAttemptFence(interrupted.runtime.attempt)), true);
          const beforeScan = observed.calls.length;
          assert.equal(registry.recoverStore(store).dispatched, 0, "a manual interrupt is never automatic restart authority");
          await registry.settle();
          assert.equal(observed.calls.length, beforeScan);
          tools.resume({ reservationId: reservation.id, expectedStepRevision: interrupted.runtime.step.revision,
            callId: `explicit-resume-after-restored-read-${round}` });
        }
        await within(registry.settle(), 8_000, "explicit resumed child");
        releaseParentResponse.resolve();
      }
      await within(Promise.all([rootRecovery, activeRuns.waitForIdle()]), 20_000, "fresh Host tree recovery");
      await within(registry.settle(), 5_000, "recovered child result publication");
      assert.deepEqual(observed.errors, []);
      if (rejectChildAck) {
        assert.deepEqual(observed.acknowledgements, ["root"]);
        assert.equal(observed.calls.length, 5, "a failed child ACK must not launch the grandchild");
        const childRun = store.getRun(observed.boundaries.get("child").runId);
        const childUnit = store.getWorkUnit(childRun.workUnitId);
        assert.equal(childUnit.status, "claimed");
        assert.equal(store.getWorkUnitAttempt(childUnit.activeAttemptId).status, "created");
        const childActivation = composition.lifecycle.getSuspensionActivation(receipts.get("child").suspensionId);
        assert.ok(childActivation, "the failed SDK callback retains the one-shot child activation");
        assert.equal(childActivation.activation.targetFence.attemptId, childUnit.activeAttemptId);
        assert.equal(composition.lifecycle.getSuspensionStart(receipts.get("child").suspensionId), undefined,
          "a failed SDK callback cannot manufacture a durable start receipt");
        const grandchildRun = store.getRun(observed.boundaries.get("grandchild").runId);
        assert.equal(store.listWorkUnitAttempts(grandchildRun.workUnitId).length, 1);
        assert.equal(store.getWorkUnit(grandchildRun.workUnitId).status, "cancelled");
        assert.equal(wireByLevel.get("child").length, 1);
        assert.equal(wireByLevel.get("grandchild").length, 1);
        assert.equal(store.getRun(rootId).status, "running", "unknown descendant start is not whole-tree completion");
        assert.equal(registry.recoverStore(store).dispatched, 0, "a consumed child activation is never redispatched");
        await registry.settle();
        assert.equal(observed.calls.length, 5);
        return;
      }
      assert.deepEqual(observed.acknowledgements.filter(level => level !== "queued"), repeatFinalSuspension
        ? ["root", "child", "grandchild", "root", "child", "grandchild"]
        : manualResume ? ["root", "child", "grandchild", "child", "child"] : ["root", "child", "grandchild"]);
      if (queued) {
        assert.equal(observed.acknowledgements.filter(level => level === "queued").length, 1);
        assert.equal(store.listWorkUnitAttempts(queued.childWorkUnit.id).length, 1);
        assert.equal(store.getRun(queued.childRun.id).status, "succeeded");
        assert.equal(store.listEvents(queued.childRun.id).filter(event => event.type === "tool_end" && event.data.toolCallId === "queued-read").length, 1);
        assert.equal(registry.recoverStore(store).dispatched, 0);
        await registry.settle();
      }
      assert.deepEqual(observed.ackErrors, []);
      if (parentInFlight) {
        assert.ok(concurrentParentChargeId);
        assert.equal(store.database.prepare("SELECT state FROM delegation_budget_charges WHERE id=?").get(concurrentParentChargeId).state,
          "measured", "a live charge remains reserved until actual SDK usage settles it, not cancelled or refunded to admit a child");
      }
      assert.equal(activationRollbackVerified, failActivationOnce);
      assert.equal(observed.calls.length, repeatFinalSuspension ? 9 : manualResume ? 8 : queued ? 7 : 6, "each restart or explicit resume has exactly one SDK lifetime");
      for (const [level, parentLevel] of [["child", "root"], ["grandchild", "child"]]) {
        const suspensionId = receipts.get(level).suspensionId;
        const activation = composition.lifecycle.getSuspensionActivation(suspensionId);
        const start = composition.lifecycle.getSuspensionStart(suspensionId);
        assert.ok(activation); assert.ok(start);
        assert.equal(activation.activation.runId, observed.boundaries.get(level).runId);
        assert.equal(activation.activation.parentRunId, observed.boundaries.get(parentLevel).runId);
        const parent = store.getRun(activation.activation.parentRunId);
        assert.equal(activation.activation.parentFence.attemptId, manualResume && level === "grandchild"
          ? manuallyInterruptedAttempts[0] : store.getWorkUnit(parent.workUnitId).activeAttemptId,
        "the immutable activation keeps its actual parent at activation, not a later explicit successor");
        assert.equal(start.start.activationArtifactId, activation.artifactId);
        assert.equal(start.start.activationDigest, activation.digest);
        assert.deepEqual(start.start.observation.sourceFence, activation.activation.targetFence);
        if (level === "grandchild") {
          const parentStart = composition.lifecycle.getSuspensionStart(receipts.get("child").suspensionId);
          assert.equal(activation.activation.parentStartArtifactId, parentStart.artifactId);
          assert.equal(activation.activation.parentStartDigest, parentStart.digest,
            "grandchild recovery is linked to its direct parent's real SDK ACK, not only root ACK");
        }
      }
      for (const [level, source] of observed.boundaries) {
        assert.equal(store.getRun(source.runId).status, "succeeded", `${level} must complete with real descendant results`);
        assert.equal(store.listWorkUnitAttempts(store.getRun(source.runId).workUnitId).length, repeatFinalSuspension ? 3 : manualResume && level === "child" ? 4 : 2);
        const events = store.listEvents(source.runId, { limit: 1000 });
        assert.equal(events.filter(event => event.type === "tool_end" && event.data.toolCallId === `${level}-read`).length, 1);
        assert.equal(events.filter(event => event.type === "tool_end" && event.data.toolCallId === `${level}-spawn`).length, level === "grandchild" ? 0 : 1);
        if (finalGrandchild && level === "grandchild" || finalRootWait && level === "root") assert.equal(wireByLevel.get(level).length, sourceWireCounts.get(level),
          "the actual complete child restores/ACKs and settles required fan-in with no new provider request");
        else assert.match(JSON.stringify(wireByLevel.get(level)[sourceWireCounts.get(level)].body.messages), /one owned read per original tree source/u);
        if (manualResume && level === "child") {
          assert.equal(events.filter(event => event.type === "tool_end" && event.data.toolCallId === "child-new-read").length, 1);
          assert.match(JSON.stringify(wireByLevel.get(level)[2].body.messages), /child-new-read/u,
            "resume must install B's new checkpoint, not reuse A's old view");
          assert.equal(events.filter(event => event.type === "tool_end" && event.data.toolCallId === "child-next-read").length, 1);
          assert.match(JSON.stringify(wireByLevel.get(level)[3].body.messages), /child-next-read/u,
            "a second explicit resume must preserve the ordinary predecessor too");
        }
      }
      assert.deepEqual(store.database.prepare("SELECT * FROM delegation_root_budgets WHERE root_run_id=?").get(rootId), budgetBefore);
      assert.deepEqual(store.database.prepare(reservationQuery).all(), reservationsBefore);
      const completed = store.getDelegationCompletionEvidence({ rootRunIds: [rootId] });
      assert.ok(completed.steps.every(item => item.step.state === "succeeded" && item.results.length === 1));
      assert.deepEqual(completed.steps.map(item => item.step.required).sort(), queued ? [false, true, true] : requiredFlags);
      assert.equal(store.database.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
      for (const table of ["run_suspension_delegated_activations", "run_suspension_delegated_starts"]) {
        const rows = store.database.prepare(`SELECT * FROM ${table} ORDER BY id`).all();
        assert.equal(rows.length, repeatFinalSuspension ? 4 : 2);
        const changed = { ...rows[0], digest: "c".repeat(64) }, columns = Object.keys(changed);
        assert.throws(() => store.database.prepare(`INSERT OR REPLACE INTO ${table}
          (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`).run(...Object.values(changed)), /immutable/u);
        assert.deepEqual(store.database.prepare(`SELECT * FROM ${table} ORDER BY id`).all(), rows,
          "the actual SDK's FK-bound immutable receipts survive replacement attempts intact");
      }
    }
  } catch (error) {
    if (optionalTerminalShutdown) t.diagnostic(JSON.stringify({ terminalDiagnostics: {
      blockers: observed.blockers,
      intents: store.database.prepare("SELECT run_id,attempt_id,state FROM run_terminal_intents").all(),
      steps: store.database.prepare("SELECT child_run_id,state FROM delegation_steps").all(),
      charges: store.database.prepare("SELECT run_id,attempt_id,state FROM delegation_budget_charges").all(),
      completion: store.database.prepare("SELECT run_id,attempt_id,registered_at,drained_at,effect_coverage FROM host_attempt_completions").all(),
    } }));
    t.diagnostic(JSON.stringify({ observed: { calls: observed.calls.map(options => ({ runId: options.runId, prompt: options.task.prompt })),
      boundaries: [...observed.boundaries.keys()], directives: observed.directives, errors: observed.errors, ackErrors: observed.ackErrors,
      concurrentParentChargeId },
      runs: store.listRuns().map(run => ({ id: run.id, parentRunId: run.parentRunId, status: run.status,
        events: store.listEvents(run.id, { limit: 1000 }).map(event => ({ seq: event.seq, type: event.type, data: event.data })) })) }));
    throw error;
  }
});

if (!sourceWorkerInput) for (const automaticDaemon of [false, true]) test(automaticDaemon
  ? "a new default Daemon automatically recovers the exited Host's SDK tree and never redispatches it on later startup"
  : "source Host exits normally before a new PID restores the tree without replaying a journaled write",
{ timeout: 40_000 }, async t => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-graceful-exited-host-tree-"));
  const nonce = randomUUID(), messages = [], output = [];
  const source = fork(fileURLToPath(import.meta.url), [JSON.stringify({ kind: "graceful_tree_owned_source", cwd, nonce })],
    { cwd, execArgv: [], stdio: ["ignore", "pipe", "pipe", "ipc"], env: { PATH: process.env.PATH ?? "/usr/bin:/bin",
      LING_STACK_HOME: join(cwd, "fixture-home"), LING_STACK_DEFAULT_WORKSPACE_CWD: cwd } });
  source.on("message", message => messages.push(message));
  source.stdout.on("data", chunk => output.push(chunk.toString()));
  source.stderr.on("data", chunk => output.push(chunk.toString()));
  const exit = new Promise((resolve, reject) => { source.once("error", reject); source.once("close", (code, signal) => resolve({ code, signal })); });
  t.after(async () => {
    if (source.pid && source.exitCode === null && source.signalCode === null) {
      source.kill("SIGTERM"); await within(exit, 3_000, "owned source worker stop");
    }
    await rm(cwd, { recursive: true, force: true });
  });
  const stopped = await within(exit, 15_000, "source SDK Host normal exit after durable stop");
  assert.deepEqual(stopped, { code: 0, signal: null }, JSON.stringify({ messages, output: output.join("").slice(-6000) }));
  const original = messages.find(message => message.kind === "graceful_tree_source_stopped");
  assert.ok(original); assert.equal(original.nonce, nonce); assert.equal(original.pid, source.pid); assert.equal(original.cwd, cwd);
  const marker = join(cwd, "journaled-marker.txt"), beforeWrite = await stat(marker);
  // The old process is known to have exited, not merely closed its Store.
  const report = await recoverInDifferentProcess(t, { ...original, sourcePid: original.pid, automaticDaemon });
  if (automaticDaemon) assert.equal(report.automaticDaemon, true);
  assert.deepEqual(report.acknowledgements, ["root", "child", "grandchild"]);
  assert.equal(report.sdkLifetimes, 3); assert.equal(report.journaledWrites, 1);
  assert.equal(await readFile(marker, "utf8"), "one journaled write before restart\n");
  assert.equal((await stat(marker)).mtimeMs, beforeWrite.mtimeMs);
  t.diagnostic(JSON.stringify({ sourceExit: stopped, ...report }));
});
