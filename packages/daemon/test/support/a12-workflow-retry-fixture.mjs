import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const [lane, scenario] = process.argv.slice(2);
assert.ok(["existing", "manifest"].includes(lane));
const root = process.env.A12_OWNED_ROOT;
const cwd = process.env.LING_STACK_DEFAULT_WORKSPACE_CWD;
const home = process.env.LING_STACK_HOME;
for (const path of [root, cwd, home]) {
  assert.ok(path && isAbsolute(path) && resolve(path) === path && path !== "/");
}
assert.equal(cwd, join(root, "workspace"));
assert.equal(home, join(root, "home"));

const observations = { modelRequests: 0, blockedExternalFetches: 0, keychainAccesses: 0, points: [] };
const originalStat = fs.stat;
const originalHomedir = os.homedir;
const originalExecFileSync = childProcess.execFileSync;
const originalFetch = globalThis.fetch;
const releaseGate = deferred();
const enteredGate = deferred();
let gatePath;
let armed = false;
let consumed = false;
let gatePromise;
let allowedOrigin;

// Install before importing product modules, so their named builtin imports use
// this child-local gate. A real stat succeeds first; only its Promise is held.
fs.stat = async function (path, ...args) {
  const result = await originalStat.call(this, path, ...args);
  if (armed && !consumed && typeof path === "string" && path === gatePath) {
    consumed = true;
    gatePromise = releaseGate.promise;
    enteredGate.resolve();
    await gatePromise;
  }
  return result;
};
os.homedir = () => home;
childProcess.execFileSync = function (file, ...args) {
  if (file === "/usr/bin/security") {
    observations.keychainAccesses += 1;
    throw new Error("A12 fixture refuses system Keychain access");
  }
  return originalExecFileSync.call(this, file, ...args);
};
syncBuiltinESMExports();
globalThis.fetch = async function (input, init) {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (url.origin !== allowedOrigin) {
    observations.blockedExternalFetches += 1;
    observations.modelRequests += 1;
    throw new Error(`A12 refuses non-Daemon fetch: ${url.origin}`);
  }
  return originalFetch.call(this, input, init);
};

let phase = "fixture_setup";
let daemon;
let store;
let runner;
let pendingRequest;
let failure;
let report;
let restoreSessions;
let observeState;
try {
  const core = await import("../../../core/dist/index.js");
  const contracts = await import("../../../contracts/dist/index.js");
  const { createDaemonServer } = await import("../../dist/index.js");
  const { materializeWorkflowDelegatedStepRequirements } = await import("../../dist/features/channels/workflow-step-requirement.js");
  const { finalizeOrchestratedWorkflowStepRun } = await import("../../dist/features/channels/orchestrator.js");
  const { preflightWorkflowParticipantProvider } = await import("../../dist/features/channels/workflow-participant-provider.js");
  const { resolveProviderForRun } = await import("../../dist/features/runs/providers.js");
  const { listAllExecutionActionsForRun } = await import("../../dist/features/runs/execution-actions.js");
  const { appendChannelItemFixture } = await import("../../../core/test/channel-conversation-fixture.mjs");
  runner = createLocalReadRunner(cwd);
  const secretResolver = core.createCompositeSecretResolver({ env: {} });
  await fs.writeFile(join(cwd, "evidence.txt"), "A12 real local read evidence\n");
  daemon = createDaemonServer({
    host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd,
    channels: { autoRoute: false, intentSelector: false, terminalReports: false, teamObserverBus: false },
    cuaDriver: { bundledEmbedded: { darwin: false, win32: false }, packagedProvider: { darwin: false, win32: false } },
  }, {
    runner,
    chromeBrowserNativeMessagingEnabled: false,
    secretResolver,
    storeFactory: (storeCwd) => {
      assert.equal(resolve(storeCwd), cwd, "A12 may only open its owned workspace store");
      store = core.createSqliteRunStore(storeCwd);
      return store;
    },
  });
  await daemon.start();
  const address = daemon.server.address();
  assert.ok(address && typeof address === "object");
  allowedOrigin = `http://127.0.0.1:${address.port}`;
  const fixture = await createWorkflow({ contracts, appendChannelItemFixture, materializeWorkflowDelegatedStepRequirements,
    preflightWorkflowParticipantProvider, resolveProviderForRun, secretResolver });
  gatePath = core.resolveStoragePaths(cwd).workspace.sessionsDir;
  assert.ok(gatePath.startsWith(`${cwd}/.ling-stack/`), "A12 requires isolated repo-local runtime state");
  const { workflow, step } = fixture;
  const observe = (label) => {
    const current = store.getChannelWorkflowStep(step.id);
    const runs = store.listRuns({ workflowStepId: step.id, limit: 100 });
    const point = {
      label, workflow: store.getChannelWorkflow(workflow.id), step: current,
      tasks: store.listTasks({ channelId: fixture.channel.id, limit: 100 }),
      runs: runs.map((run) => ({ ...run,
        workUnit: run.workUnitId ? store.getWorkUnit(run.workUnitId) : undefined,
        attempts: run.workUnitId ? store.listWorkUnitAttempts(run.workUnitId) : [],
        events: store.listEvents(run.id, { limit: 1000 }),
        actions: listAllExecutionActionsForRun(store, run.id),
      })),
      leases: store.listResourceLeases({ resourceType: "workflow_step", resourceKey: step.id, limit: 100 }),
      transitions: store.listStateTransitionEvents({ entityType: "workflow_step", entityId: step.id, limit: 100 }),
      runnerTaskIds: runner.runs.map((options) => options.task.id),
    };
    observations.points.push(point);
    return point;
  };
  observeState = observe;
  const orchestrate = () => request(`/workflows/${workflow.id}/orchestrate`, {});
  const retry = () => request(`/workflow-steps/${step.id}/retry`, {});

  if (scenario === "reject-non-blocked") {
    phase = "product_assertion";
    const before = observe("queued-before-retry");
    const rejected = await retry();
    assert.equal(rejected.status, 409, JSON.stringify(rejected));
    assert.equal(rejected.body.error, "workflow_step_not_retryable");
    const after = observe("queued-after-retry");
    assert.equal(after.step.status, "queued");
    assert.equal(after.tasks.length, before.tasks.length);
    assert.equal(after.runs.length, 0);
  } else {
    const first = await orchestrate();
    observe("A-orchestrate-returned");
    assert.equal(first.status, 200, JSON.stringify(first));
    assert.equal(first.body.status, "started", JSON.stringify(first));
    const oldRunId = first.body.runId;
    assert.ok(oldRunId, "setup must create a real old Run A");
    await eventually(() => store.getRun(oldRunId)?.status === "failed"
      && store.getChannelWorkflowStep(step.id)?.status === "blocked", "real A terminal and step blocked");
    const oldRun = store.getRun(oldRunId);
    const oldTaskId = oldRun.taskId;
    assert.equal(runner.runs.length, 1);
    assert.equal(store.getChannelWorkflowStep(step.id).taskId, oldTaskId);
    assert.equal(store.getChannelWorkflowStep(step.id).runId, oldRunId);
    const baseline = observe("real-A-failed");
    phase = "product_assertion";

    if (scenario === "reject-terminal-workflow") {
      phase = "fixture_precondition";
      const cancelled = await request(`/workflows/${workflow.id}/cancel`, {});
      assert.equal(cancelled.status, 200, JSON.stringify(cancelled));
      assert.equal(cancelled.body.workflow.status, "cancelled");
      const before = observe("terminal-before-retry");
      phase = "product_assertion";
      const rejected = await retry();
      assert.equal(rejected.status, 409, JSON.stringify(rejected));
      assert.ok(["workflow_terminal", "workflow_step_not_retryable"].includes(rejected.body.error));
      const after = observe("terminal-after-retry");
      assert.equal(after.tasks.length, before.tasks.length);
      assert.equal(after.runs.length, before.runs.length);
    } else if (scenario === "reject-incomplete-dependency") {
      phase = "fixture_precondition";
      // Add a real queued predecessor as a corrected workflow definition; do
      // not fake an old Run or any execution outcome to form this rejection.
      const predecessor = store.createChannelWorkflowStep({
        workflowId: workflow.id, position: 0, title: "Required predecessor", prompt: "Inspect first",
        toParticipantId: step.toParticipantId, toParticipantLabel: "Engineer",
        participantAuthority: step.participantAuthority,
        metadata: { graphId: "a12-single-step", graphNodeId: "predecessor", requiredTools: ["read"],
          providerPresetId: step.metadata.providerPresetId,
          ...(step.metadata.providerBinding ? { providerBinding: step.metadata.providerBinding } : {}) },
      }, new Date().toISOString());
      const current = store.getChannelWorkflowStep(step.id);
      store.updateChannelWorkflowStep(step.id, { metadata: { ...current.metadata, dependsOnStepIds: [predecessor.id] } }, new Date().toISOString());
      if (lane === "manifest") {
        const currentWorkflow = store.getChannelWorkflow(workflow.id);
        const graph = currentWorkflow.metadata.workflowGraph;
        const updatedGraph = {
          ...graph, entryNodeId: "predecessor",
          nodes: [{ id: "predecessor", kind: "step", name: "Required predecessor", prompt: "Inspect first", teammateId: step.toParticipantId }, ...graph.nodes],
          edges: [{ id: "predecessor-inspect", fromNodeId: "predecessor", toNodeId: "inspect", condition: { kind: "all_succeeded" } }],
        };
        const updatedWorkflow = store.updateChannelWorkflow(workflow.id, {
          metadata: { ...currentWorkflow.metadata, workflowGraph: updatedGraph,
            workflowGraphFingerprint: contracts.workflowGraphFingerprintV1(updatedGraph) },
        }, new Date().toISOString());
        materializeWorkflowDelegatedStepRequirements({ store, workflow: updatedWorkflow,
          manifest: updatedWorkflow.metadata.requiredParticipantManifest, now: new Date().toISOString() });
      }
      const before = observe("dependency-before-retry");
      phase = "product_assertion";
      const rejected = await retry();
      assert.equal(rejected.status, 200, JSON.stringify(rejected));
      assert.equal(rejected.body.status, "blocked");
      assert.match(rejected.body.blocker, /dependencies/i);
      const after = observe("dependency-after-retry");
      assert.equal(after.tasks.length, before.tasks.length);
      assert.equal(after.runs.length, before.runs.length);
    } else if (scenario === "reject-nonretryable-loop") {
      phase = "fixture_precondition";
      // A real failed Run is retained. This isolated rejection fixture records
      // only the typed nonretryable event, not a fabricated terminal outcome.
      const attempt = store.getWorkUnit(oldRun.workUnitId)?.activeAttemptId;
      assert.ok(attempt, "A must have an actual Attempt");
      store.appendEvent(oldRun.id, "loop_detected", {
        code: "execution_loop_detected", attemptId: attempt, loopKind: "exact_repeat",
        observedEventType: "tool_start", observedEventSeq: 0, repeatedCount: 3,
        noProgressActionCount: 3, fingerprint: createHash("sha256").update("A12-rejection-only").digest("hex"),
        message: "A12 explicit nonretryable loop rejection fixture", retryable: false,
      });
      const before = observe("loop-before-retry");
      phase = "product_assertion";
      const rejected = await retry();
      assert.equal(rejected.status, 409, JSON.stringify(rejected));
      assert.equal(rejected.body.error, "workflow_step_loop_failure_not_retryable");
      const after = observe("loop-after-retry");
      assert.equal(after.tasks.length, before.tasks.length);
      assert.equal(after.runs.length, before.runs.length);
    } else if (scenario === "preparation-failure") {
      phase = "fixture_precondition";
      // Preserve the owned directory, replace its pathname with a real regular
      // file, and let the unmodified startup mkdir fail. No synthetic EACCES.
      const backup = `${gatePath}.a12-retained`;
      await fs.rename(gatePath, backup);
      restoreSessions = async () => {
        try { await fs.unlink(gatePath); } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        await fs.rename(backup, gatePath);
      };
      await fs.writeFile(gatePath, "A12 intentionally not a directory\n");
      phase = "product_assertion";
      const rejected = await retry();
      const failed = observe("B-real-preparation-failed");
      assert.equal(rejected.status, 200, JSON.stringify(rejected));
      assert.equal(rejected.body.status, "blocked", JSON.stringify(rejected));
      assert.equal(failed.step.status, "blocked");
      assert.equal(failed.tasks.length, baseline.tasks.length + 1);
      assert.equal(failed.runs.length, baseline.runs.length, "startup failed before Run B creation");
      assert.notEqual(failed.step.taskId, oldTaskId);
      assert.notEqual(failed.step.runId, oldRunId, "failed B preparation must not retain A as its owner");
      assert.equal(runner.runs.length, 1, "B must not execute after failed preparation");
      phase = "fixture_restore";
      await restoreSessions();
      restoreSessions = undefined;
      phase = "product_assertion";
      const repaired = await retry();
      assert.equal(repaired.status, 200, JSON.stringify(repaired));
      assert.equal(repaired.body.status, "started", JSON.stringify(repaired));
      await assertCompleted(repaired.body.runId, observe, fixture, oldRunId, listAllExecutionActionsForRun);
    } else if (scenario === "normal-retry" || scenario === "old-terminal-after-ready") {
      runner.holdSuccess = scenario === "old-terminal-after-ready";
      const retried = await retry();
      assert.equal(retried.status, 200, JSON.stringify(retried));
      assert.equal(retried.body.status, "started", JSON.stringify(retried));
      assert.notEqual(retried.body.runId, oldRunId);
      if (runner.holdSuccess) {
        phase = "fixture_runner_wait";
        await bounded(runner.successEntered.promise, "B runner entered");
        phase = "product_assertion";
        const before = observe("B-ready-before-old-A-terminal-callback");
        assert.equal(before.step.runId, retried.body.runId);
        finalizeOrchestratedWorkflowStepRun(store, step.id, oldTaskId, oldRun);
        const reconciled = await orchestrate();
        assert.equal(reconciled.status, 200, JSON.stringify(reconciled));
        const after = observe("B-ready-after-old-A-terminal-callback");
        assert.equal(after.step.status, "running", "A callback cannot finalize current B");
        assert.equal(after.step.runId, before.step.runId);
        assert.equal(after.step.taskId, before.step.taskId);
        runner.releaseSuccess.resolve();
      }
      await assertCompleted(retried.body.runId, observe, fixture, oldRunId, listAllExecutionActionsForRun);
    } else {
      phase = "fixture_gate_wait";
      armed = true;
      const direct = scenario === "late-direct-ready-after-cancel";
      pendingRequest = direct
        ? request(`/workflow-steps/${step.id}/start`, { mode: "create_and_run_task" }, true)
        : retry();
      // Observe rejection immediately, without replacing/swallowing the source
      // Promise: later await/cleanup still sees its original failure.
      void pendingRequest.catch((error) => {
        observations.pendingRequestFailure = { name: error.name, message: error.message, requestPath: error.a12RequestPath };
      });
      await bounded(Promise.race([
        enteredGate.promise,
        pendingRequest.then((response) => {
          throw new Error(`A12 fixture request settled before gate entry: ${JSON.stringify(response)}`);
        }),
      ]), "B exact startup stat entered");
      phase = "product_assertion";
      const held = observe("B-startup-held");
      assert.notEqual(held.step.taskId, oldTaskId, "B must own a fresh Task before gate entry");
      assert.equal(held.runs.length, 1, "B gate is before Run creation");
      assert.equal(runner.runs.length, 1, "B tool execution must not start before release");
      assert.equal(held.step.status, "running");

      if (scenario === "duplicate-retry") {
        const rejected = await retry();
        assert.equal(rejected.status, 409, JSON.stringify(rejected));
        const duplicate = observe("duplicate-retry-rejected-while-B-held");
        assert.equal(duplicate.step.taskId, held.step.taskId);
        assert.equal(duplicate.tasks.length, held.tasks.length);
        assert.equal(duplicate.runs.length, held.runs.length);
        assert.deepEqual(duplicate.leases.filter((lease) => lease.status === "active").map((lease) => lease.id),
          held.leases.filter((lease) => lease.status === "active").map((lease) => lease.id));
      } else if (scenario.startsWith("late-")) {
        const cancelled = await request(`/workflows/${workflow.id}/cancel`, {});
        assert.equal(cancelled.status, 200, JSON.stringify(cancelled));
        const terminal = observe("workflow-cancelled-before-B-ready");
        assert.equal(terminal.workflow.status, "cancelled");
        assert.equal(terminal.step.status, "cancelled");
        releaseGate.resolve();
        phase = "fixture_request_drain";
        await bounded(pendingRequest, "late-ready request drain");
        pendingRequest = undefined;
        phase = "product_terminal_observation";
        await eventually(() => terminalRunsForStep(step.id), "late B drain");
        phase = "product_assertion";
        const after = observe("late-B-ready-after-cancel");
        assert.equal(after.workflow.status, "cancelled");
        assert.equal(after.step.status, "cancelled");
        assert.equal(after.step.taskId, terminal.step.taskId, "late ready cannot replace terminal owner Task");
        assert.equal(after.step.runId, terminal.step.runId, "late ready cannot attach its Run to a terminal step");
        assert.equal(after.runs.filter((run) => ["queued", "running", "waiting_for_approval"].includes(run.status)).length, 0);
        assert.equal(runner.runs.length, 1, "cancelled preparing B must not enter Runner.runTask");
        for (const subsequent of after.runs.filter((run) => run.id !== oldRunId)) {
          assert.notEqual(subsequent.status, "succeeded", "cancelled B cannot succeed as an orphan Run");
          assert.equal(subsequent.actions.filter((action) => action.status === "succeeded").length, 0,
            "cancelled B cannot produce successful tool actions after cancellation");
        }
      } else {
        assert.equal(scenario, "preparing-reconcile");
        const reconciled = await orchestrate();
        assert.equal(reconciled.status, 200, JSON.stringify(reconciled));
        const after = observe("concurrent-reconcile-while-B-held");
        assert.equal(after.step.status, "running", "old A must not re-block preparing B");
        assert.equal(after.step.taskId, held.step.taskId);
        assert.equal(after.runs.length, held.runs.length);
        assert.equal(runner.runs.length, 1);
      }
      if (pendingRequest) {
        releaseGate.resolve();
        phase = "fixture_request_drain";
        const retried = await bounded(pendingRequest, "B ready HTTP result");
        pendingRequest = undefined;
        phase = "product_assertion";
        assert.equal(retried.status, 200, JSON.stringify(retried));
        assert.equal(retried.body.status, "started", JSON.stringify(retried));
        await assertCompleted(retried.body.runId, observe, fixture, oldRunId, listAllExecutionActionsForRun);
      }
    }
  }
  report = { verdict: "passed", lane, scenario, phase, root, observations };
} catch (error) {
  failure = error;
  try { observeState?.("failure-before-cleanup"); } catch (observationError) {
    observations.diagnosticFailure = observationError.message;
  }
  report = { verdict: "failed", lane, scenario, phase, root, observations,
    failure: { name: error.name, message: error.message, stack: error.stack, requestPath: error.a12RequestPath } };
} finally {
  releaseGate.resolve();
  runner?.releaseSuccess.resolve();
  if (pendingRequest) {
    await bounded(pendingRequest.catch((error) => {
      observations.pendingRequestFailure ??= { name: error.name, message: error.message, requestPath: error.a12RequestPath };
      failure ??= error;
    }), "request cleanup").catch((error) => {
      (observations.cleanupErrors ??= []).push({ name: error.name, message: error.message });
      failure ??= error;
    });
  }
  if (gatePromise) await gatePromise;
  if (restoreSessions) await restoreSessions().catch((error) => {
    (observations.cleanupErrors ??= []).push({ name: error.name, message: error.message });
    failure ??= error;
  });
  if (daemon) await daemon.stop().catch((error) => {
    (observations.cleanupErrors ??= []).push({ name: error.name, message: error.message });
    failure ??= error;
  });
  fs.stat = originalStat;
  os.homedir = originalHomedir;
  childProcess.execFileSync = originalExecFileSync;
  globalThis.fetch = originalFetch;
  syncBuiltinESMExports();
}
if (failure && report?.verdict === "passed") {
  report.verdict = "failed";
  report.phase = "fixture_teardown";
  report.failure = { name: failure.name, message: failure.message, stack: failure.stack };
}
process.stdout.write(`A12_RESULT ${JSON.stringify(report)}\n`);
process.exitCode = failure ? 1 : 0;

async function createWorkflow({ contracts, appendChannelItemFixture, materializeWorkflowDelegatedStepRequirements,
  preflightWorkflowParticipantProvider, resolveProviderForRun, secretResolver }) {
  const provider = await request("/providers", {
    kind: "glm", displayName: "A12 static nontransport", providerId: "a12-static",
    model: "a12-static", api: "google-generative-ai", authHeader: false,
    capabilities: ["chat", "reasoning", "tool_call"], input: ["text"], enabled: true,
  });
  assert.equal(provider.status, 201, JSON.stringify(provider));
  const providerId = provider.body.provider.id;
  const checked = await request(`/providers/${providerId}/check`, {});
  assert.equal(checked.status, 200, JSON.stringify(checked));
  const channelResponse = await request("/channels", {
    name: `A12 ${lane}`, status: "active", boundPath: cwd,
    defaultProviderPresetId: providerId, allowedTools: ["read"],
    runtimePolicy: { maxConcurrentRuns: 1, schedulingMode: "smart", writeLockScope: "boundPath",
      allowReadOnlyParallel: true, queueOnConflict: true },
  });
  assert.equal(channelResponse.status, 201, JSON.stringify(channelResponse));
  const channel = channelResponse.body.channel;
  const now = new Date().toISOString();
  const participantId = "teammate_builtin_engineer";
  let providerBinding;
  if (lane === "manifest") {
    store.updateWorkspaceSettings({ defaultProviderPresetId: providerId }, now);
    const teammate = store.getAiTeammate(participantId);
    assert.ok(teammate, "manifest fixture requires the real builtin participant");
    const preflight = preflightWorkflowParticipantProvider({
      store, channel, teammate, cwd, requiredTools: ["read"],
      validateRunRequest: (candidate) => { resolveProviderForRun(store, candidate, secretResolver); },
    });
    assert.equal(preflight.kind, "ready", JSON.stringify(preflight));
    providerBinding = preflight.binding;
    assert.equal(providerBinding.providerPresetId, providerId);
    assert.equal(providerBinding.participantId, participantId);
    observations.manifestBindingProducer = { name: "preflightWorkflowParticipantProvider", binding: providerBinding };
  }
  const manifest = contracts.createRequiredParticipantManifestV1([{
    participantId, role: "engineer", requirement: "required", expectedOutcome: "execution",
    requiredOperationIds: [], requestedBy: "explicit_role",
  }]);
  const graph = {
    schemaVersion: 1, id: "a12-single-step", name: "A12 inspect", entryNodeId: "inspect",
    nodes: [{ id: "inspect", kind: "step", name: "Inspect", prompt: "Read evidence.txt", teammateId: participantId,
      ...(providerBinding ? { providerPresetId: providerId, providerBinding } : {}) }],
    edges: [], termination: { success: "all_required_succeeded", onFailedRequiredNode: "block_for_user", onApprovalDenied: "block_for_user" },
  };
  let modernMetadata = {};
  if (lane === "manifest") {
    const source = appendChannelItemFixture(store, { channelId: channel.id, authorType: "local-user", body: "Inspect the workspace by reading evidence.txt" }, now);
    const item = store.getConversationItem(source.id);
    const assignment = store.getEffectiveTurnContextAssignment(item.turnId);
    const decision = store.createChannelIntentDecision({
      channelId: channel.id, sourceItemId: item.id,
      contextProjection: {
        projectionVersion: `projection:${item.id}:${assignment.revision}`,
        sourceStateFingerprint: `source-state:${item.id}:${assignment.revision}`,
        threadId: item.threadId, turnId: item.turnId, segmentId: assignment.segmentId,
        throughItemSequence: item.sequence, summaryIds: [],
        sourceRefs: [{ type: "thread", id: item.threadId }, { type: "turn", id: item.turnId }, { type: "conversation_item", id: item.id }],
        policyVersion: "test-projector-v1", visibilityFingerprint: "channel_shared",
      },
      action: "execute", selectedTeammateIds: [participantId], participantManifest: manifest,
      execution: { operations: [{ id: "workflow_execution", kind: "run_command", targetKind: "workspace",
        targetRef: { type: "operation", id: "generic-workflow", label: "Inspect workspace" }, required: false, dependsOn: [] }] },
      reason: "Inspect workspace", status: "accepted", createdBy: "deterministic",
    }, now);
    modernMetadata = {
      sourceIntentDecisionId: decision.id, requiredParticipantManifest: manifest,
      workflowGraph: graph, workflowGraphId: graph.id,
      workflowGraphFingerprint: contracts.workflowGraphFingerprintV1(graph), termination: graph.termination,
    };
  }
  const workflow = store.createChannelWorkflow({
    channelId: channel.id, title: "A12 inspect", objective: "Read the owned evidence file",
    status: "running", createdBy: "local-user", metadata: modernMetadata,
  }, now);
  let step = store.createChannelWorkflowStep({
    workflowId: workflow.id, position: 1, title: "Inspect", prompt: "Read evidence.txt",
    toParticipantId: participantId, toParticipantLabel: "Engineer",
    participantAuthority: contracts.createWorkflowParticipantAuthorityV1({
      kind: "workflow_definition", origin: "workflow_graph", participantId, sourceId: workflow.id,
    }),
    metadata: { graphId: graph.id, graphNodeId: "inspect", providerPresetId: providerId, requiredTools: ["read"],
      ...(providerBinding ? { providerBinding } : {}),
      policy: { onRunFailed: "block_for_user", onRunCancelled: "block_for_user", onApprovalDenied: "block_for_user", retryable: true } },
  }, now);
  if (lane === "manifest") {
    [step] = materializeWorkflowDelegatedStepRequirements({ store, workflow, manifest, now });
    assert.equal(step.metadata.delegatedRequirement.workflowStepId, step.id);
    assert.equal(step.metadata.delegatedRequirement.participantId, participantId);
    assert.equal(step.metadata.delegatedRequirement.expectedOutcome, "execution");
  }
  return { workflow, step, channel };
}

async function assertCompleted(runId, observe, fixture, oldRunId, listAllExecutionActionsForRun) {
  assert.ok(runId);
  assert.notEqual(runId, oldRunId);
  phase = "product_completion_observation";
  await eventually(() => {
    const run = store.getRun(runId);
    const unit = run?.workUnitId ? store.getWorkUnit(run.workUnitId) : undefined;
    const attempt = unit?.activeAttemptId ? store.getWorkUnitAttempt(unit.activeAttemptId) : undefined;
    return run?.status === "succeeded" && unit?.status === "succeeded" && attempt?.status === "succeeded"
      && store.getChannelWorkflowStep(fixture.step.id)?.status === "succeeded";
  }, "B Run, WorkUnit, Attempt and workflow step complete");
  phase = "product_assertion";
  const completed = observe("B-completed");
  const run = store.getRun(runId);
  assert.equal(completed.step.runId, runId);
  assert.equal(completed.step.taskId, run.taskId);
  assert.equal(completed.workflow.status, "succeeded");
  assert.equal(store.getRun(oldRunId).status, "failed", "A history remains intact");
  assert.ok(run.workUnitId);
  const unit = store.getWorkUnit(run.workUnitId);
  assert.ok(unit.activeAttemptId);
  const attempt = store.getWorkUnitAttempt(unit.activeAttemptId);
  assert.equal(unit.status, "succeeded");
  assert.equal(attempt.status, "succeeded");
  assert.equal(unit.taskId, run.taskId);
  assert.equal(unit.teammateId, run.teammateId);
  assert.equal(attempt.workUnitId, unit.id);
  assert.equal(unit.linkedRunId, runId);
  assert.equal(unit.activeAttemptId, attempt.id);
  const source = store.listEvents(runId, { limit: 1000 }).find((event) => event.type === "run_created");
  assert.ok(source, "B requires the actual run_created source event");
  assert.equal(source.data.workUnitId, unit.id);
  assert.equal(source.data.attemptId, attempt.id);
  assert.equal(source.data.taskId, run.taskId);
  assert.equal(source.data.workflowStepId, fixture.step.id);
  const actions = listAllExecutionActionsForRun(store, runId);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].actionType, "read");
  assert.equal(actions[0].status, "succeeded");
  assert.equal(actions[0].attemptId, attempt.id);
  assert.ok(Number.isSafeInteger(actions[0].sourceEventSequence));
  assert.equal(runner.runs.filter((options) => options.task.id === run.taskId).length, 1);
  assert.equal(completed.leases.filter((lease) => lease.status === "active").length, 0);
  if (lane === "manifest") {
    const outcome = completed.step.metadata.delegatedOutcome;
    assert.equal(outcome.kind, "completed");
    assert.equal(outcome.lineage.runId, runId);
    assert.equal(outcome.lineage.attemptId, attempt.id);
    assert.equal(outcome.participantId, completed.step.toParticipantId);
    assert.ok(outcome.evidenceRefs.some((ref) => ref.kind === "execution_action"));
    assert.equal(completed.workflow.metadata.completionGate.status, "verified");
  }
}

function createLocalReadRunner(workspace) {
  return {
    workspace,
    runs: [],
    holdSuccess: false,
    successEntered: deferred(),
    releaseSuccess: deferred(),
    async runTask(options) {
      this.runs.push(options);
      if (this.runs.length === 1) throw new Error("A12 real Runner A controlled failure");
      this.successEntered.resolve();
      if (this.holdSuccess) await bounded(this.releaseSuccess.promise, "controlled B runner release");
      if (options.signal?.aborted) throw options.signal.reason ?? new Error("A12 B aborted");
      const toolCallId = `a12_read_${options.task.id}`;
      options.onEvent?.({ type: "tool_start", toolName: "read", toolCallId, args: { path: "evidence.txt" } });
      const text = await fs.readFile(join(this.workspace, "evidence.txt"), "utf8");
      options.onEvent?.({ type: "tool_end", toolName: "read", toolCallId, isError: false,
        result: { path: "evidence.txt", content: [{ type: "text", text }] } });
      const message = "Read the owned evidence file successfully.";
      options.onEvent?.({ type: "assistant_text_delta", text: message });
      return { taskId: options.task.id, messages: [message], events: [] };
    },
  };
}

async function request(path, body, sse = false) {
  try {
    const response = await fetch(`${allowedOrigin}${path}?cwd=${encodeURIComponent(cwd)}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await response.text();
    return { status: response.status, body: sse ? { sse: text } : JSON.parse(text) };
  } catch (error) {
    error.a12RequestPath = path;
    throw error;
  }
}

function terminalRunsForStep(stepId) {
  return store.listRuns({ workflowStepId: stepId, limit: 100 })
    .every((run) => ["succeeded", "failed", "cancelled"].includes(run.status));
}

function deferred() {
  let resolvePromise;
  const promise = new Promise((resolve) => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
}

async function bounded(promise, label, timeoutMs = 10_000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`A12 fixture timeout: ${label}`)), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

async function eventually(check, label, timeoutMs = 10_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`A12 observation timeout: ${label}`);
}
