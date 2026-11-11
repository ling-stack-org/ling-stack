import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { workflowGraphFingerprintV1 } from "@ling-stack/contracts";
import { createSqliteRunStore, createSqliteWorkflowIntegrationCoordinatorStore, createSqliteWorkflowIsolationStore,
  createSqliteWorkflowMergeApplyStore, createSqliteWorkflowMergeApprovalStore, createSqliteWorkflowWorktreeCleanupStore,
  toRuntimeAttemptFence, workflowIsolationDigest } from "../../core/dist/index.js";
import { stream } from "../../runner-pi/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js";
import { createDaemonServer } from "../dist/index.js";
import { workflowGitPacketDigest } from "../dist/features/channels/workflow-branch-result.js";
import { WORKFLOW_CANDIDATE_VALIDATORS } from "../dist/features/channels/workflow-candidate-validation.js";
import { coordinateWorkflowIntegration, reconcileWorkflowIntegrations } from "../dist/features/channels/workflow-integration-coordinator.js";
import { captureWorkflowIsolatedResult } from "../dist/features/channels/workflow-isolated-result.js";
import { planWorkflowIsolatedRound } from "../dist/features/channels/workflow-isolation-planning.js";
import { recoverWorkflowIsolationsAtStartup } from "../dist/features/channels/workflow-isolation-recovery.js";
import { waitForWorkflowIsolationIdle } from "../dist/features/channels/workflow-isolation-lifecycle.js";
import { reconcileWorkflowMergeApplication } from "../dist/features/channels/workflow-merge-apply.js";
import { cleanupWorkflowWorktrees } from "../dist/features/channels/workflow-worktree-cleanup.js";
import { listAllExecutionActionsForRun } from "../dist/features/runs/execution-actions.js";
import { verifyApprovalPostCommitEvidence } from "../dist/features/runs/approval-postcommit-evidence.js";
import { ToolFreePiRunner } from "./support/tool-free-pi-runner.mjs";

const exec = promisify(execFile);
const tools = ["read", "edit", "write"];
const branches = [
  { participantId: "teammate_builtin_engineer", name: "Engineer", path: "left.txt", final: "left delivered through Host\n" },
  { participantId: "teammate_builtin_qa", name: "QA", path: "right.txt", final: "right delivered through Host\n" },
];
const callsFor = branch => [
  { name: "read", input: { path: branch.path } },
  { name: "edit", input: { path: branch.path, edits: [{ oldText: "initial", newText: "edited" }] } },
  { name: "write", input: { path: branch.path, content: branch.final } },
  { name: "read", input: { path: branch.path } },
];
const now = () => new Date().toISOString();

// Serial admission, actual Pi SDK and Host executors; only the provider's HTTP transport is scripted.
test("serial SDK/Host writing Runs fan in, approve_once delivers once, and reopen only observes retained evidence",
  { skip: process.platform !== "darwin", timeout: 180_000 }, async t => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "ling-workflow-isolated-delivery-")));
    const cwd = join(root, "repository"), worktreeRoot = join(root, "host-worktrees");
    await mkdir(cwd); await mkdir(worktreeRoot);
    const contexts = new AsyncLocalStorage(), executions = new Map();
    const releases = branches.map(() => deferred()), reached = branches.map(() => deferred());
    const notifications = changes();
    let daemon, store, reopened;
    t.after(async () => {
      for (const release of releases) release.resolve();
      try { await daemon?.stop(); }
      finally { reopened?.close(); await rm(root, { recursive: true, force: true }); }
    });
    const gitAt = async (directory, ...args) => (await exec("/usr/bin/git", args, { cwd: directory,
      env: { PATH: "/usr/bin:/bin", HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_OPTIONAL_LOCKS: "0", GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@ling.invalid",
        GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@ling.invalid" } })).stdout.trim();
    const git = (...args) => gitAt(cwd, ...args);
    await git("init", "--initial-branch=main");
    await git("config", "core.logAllRefUpdates", "always");
    // Only the initial repository inputs are fixture-written. All subsequent content mutations use Host tools.
    await writeFile(join(cwd, ".gitignore"), "*\n!.gitignore\n!left.txt\n!right.txt\n");
    for (const branch of branches) await writeFile(join(cwd, branch.path), `initial ${branch.path}\n`);
    await git("add", "--", ".gitignore", ...branches.map(branch => branch.path));
    await git("commit", "-m", "initial delivery basis");
    const gitDir = await git("rev-parse", "--absolute-git-dir");
    const filesAt = async directory => Object.fromEntries(await Promise.all(branches.map(async branch =>
      [branch.path, await readFile(join(directory, branch.path), "utf8")])));
    const target = async () => ({ head: await git("rev-parse", "HEAD"), branch: await git("symbolic-ref", "HEAD"),
      status: await git("status", "--porcelain=v1", "--untracked-files=all"), files: await filesAt(cwd),
      index: await readFile(join(gitDir, "index")) });
    const initialTarget = await target();

    class DeliveryPiRunner extends ToolFreePiRunner {
      async runTask(options) {
        const run = store.getRun(options.runId), index = branches.findIndex(branch => branch.participantId === run.teammateId);
        assert.ok(index >= 0 && run.workflowStepId, "only the two accepted steps may dispatch this SDK");
        assert.equal(executions.has(index), false, "each step dispatches one original Run");
        assert.equal(options.isolatedToolsProfile, "host_isolated_files_v1");
        assert.deepEqual([...options.tools].sort(), [...tools].sort());
        for (const key of ["mcpTools", "hostCapabilityTools", "mediaGenerationTools"]) assert.deepEqual(options[key], []);
        assert.notEqual(options.cwd, cwd);
        assert.equal(typeof options.onIsolatedToolCall, "function");
        assert.equal(options.onPermissionRequired, undefined);
        if (index === 1) {
          const previous = executions.get(0), first = store.getRun(previous.runId);
          const unit = store.getWorkUnit(first.workUnitId), fence = toRuntimeAttemptFence(store.getWorkUnitAttempt(unit.activeAttemptId));
          assert.equal(releases[0].settled, true, "second dispatch requires the first terminal response");
          assert.equal(first.status, "succeeded");
          assert.equal(store.getChannelWorkflowStep(first.workflowStepId).status, "succeeded");
          assert.ok(store.getHostAttemptCompletion({ runId: first.id, ...fence })?.drainedAt);
          assert.deepEqual(store.listRuntimeSemaphoreSlots({ workUnitId: unit.id, status: "active", limit: 100 }), []);
          assert.equal(createSqliteWorkflowIsolationStore(store).getTerminalResultIntent(
            workflowIsolationDigest({ runId: first.id, ...fence }, "wib_")).status, "confirmed");
        }
        const execution = { runId: run.id, index, options, requests: [], gates: [], results: [] };
        executions.set(index, execution);
        return contexts.run(execution, () => super.runTask({ ...options,
          onToolBefore: async request => {
            const decision = await options.onToolBefore(request);
            execution.gates.push({ request, decision }); return decision;
          },
          onIsolatedToolCall: async request => {
            const result = await options.onIsolatedToolCall(request);
            execution.results.push({ request, result }); return result;
          },
        }));
      }

      registerCustomProviderIfNeeded(runtime, provider) {
        super.registerCustomProviderIfNeeded(runtime, provider);
        runtime.registerProvider(provider.provider, { api: "openai-completions", apiKey: "fixture-no-network",
          streamSimple: (model, context, options) => stream(model, context, { ...options,
            fetch: async (_url, request) => {
              const execution = contexts.getStore();
              assert.ok(execution, "SDK transport has an original Run context");
              assert.equal(executions.get(execution?.index), execution, "SDK transport keeps its original Run identity");
              const branch = branches[execution.index], calls = callsFor(branch), index = execution.requests.length;
              const body = JSON.parse(request.body);
              execution.requests.push(body);
              assert.deepEqual((body.tools ?? []).map(tool => tool.function.name).sort(), [...tools].sort());
              assert.equal(execution.results.length, index);
              if (index) {
                const result = execution.results[index - 1];
                assert.notEqual(result.result.isError, true, JSON.stringify(result));
                const outputs = body.messages.filter(message => message.role === "tool");
                assert.equal(outputs.length, index, "every SDK follow-up contains its actual Host results");
                if (index === 1) assert.ok(JSON.stringify(outputs.at(-1).content).includes(`initial ${branch.path}`));
                if (index === calls.length) assert.ok(JSON.stringify(outputs.at(-1).content).includes(branch.final.trim()));
              }
              if (index < calls.length) {
                const call = calls[index];
                return sse({ tool_calls: [{ index: 0, id: `delivery-${execution.index}-${index}`, type: "function",
                  function: { name: call.name, arguments: JSON.stringify(call.input) } }] }, "tool_calls");
              }
              assert.equal(index, calls.length, "one read/edit/write/read sequence per Run");
              reached[execution.index].resolve();
              notifications.notify();
              await releases[execution.index].promise;
              options.signal?.throwIfAborted();
              return sse({ content: `${branch.name} completed its isolated result.` }, "stop");
            },
          }),
        });
      }
    }

    daemon = createDaemonServer({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd,
      harness: { toolBroker: { mode: "enforce" } },
      channels: { autoRoute: false, intentSelector: false, terminalReports: false, teamObserverBus: false },
    }, { runner: new DeliveryPiRunner(), storeFactory(storeCwd) {
      assert.equal(storeCwd, cwd, "isolated Runs use the canonical SQLite store");
      store = createSqliteRunStore(storeCwd);
      // Observe real committed changes; no return values, execution rows or capability decisions are substituted.
      for (const name of ["appendEvent", "createApprovalRequest", "createArtifact", "transitionRunStatus",
        "updateChannelWorkflowStep", "transitionChannelWorkflowStepStatus", "transitionWorkUnitStatus", "releaseHostAttemptResources"]) {
        const original = store[name];
        assert.equal(typeof original, "function", name);
        t.mock.method(store, name, function(...args) {
          const result = original.apply(this, args);
          queueMicrotask(notifications.notify);
          return result;
        });
      }
      return store;
    } });
    await daemon.start();
    const address = daemon.server.address();
    assert.ok(address && typeof address === "object");
    const api = async (path, body, method = "POST", expectedStatus) => {
      const response = await fetch(`http://127.0.0.1:${address.port}${path}?cwd=${encodeURIComponent(cwd)}`, { method,
        ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(60_000) });
      const value = await response.json();
      if (expectedStatus === undefined) assert.ok(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(value)}`);
      else assert.equal(response.status, expectedStatus, `${method} ${path}: ${JSON.stringify(value)}`);
      return value;
    };
    const provider = (await api("/providers", { kind: "glm", displayName: "Local serial delivery SDK transport",
      providerId: "isolated-delivery-scripted", model: "delivery-fixture", api: "openai-completions",
      baseUrl: "https://delivery-fixture.invalid/v1", capabilities: ["chat", "tool_call"], input: ["text"],
      authHeader: false, reasoning: false, enabled: true })).provider;
    assert.ok(store.database, "the actual daemon owns a real SQLite store");
    store.recordProviderCheckResult(provider.id, { ok: true, code: "ready", message: "Scripted local SDK transport", checkedAt: now() });
    await api("/approval-policy", { toolDecisions: { read: "allow", edit: "ask", write: "ask" } }, "PATCH");
    for (const branch of branches) await api(`/teammates/${branch.participantId}`,
      { providerPresetId: provider.id, allowedTools: tools }, "PATCH");
    const channel = (await api("/channels", { name: "Serial isolated delivery", status: "active", boundPath: cwd,
      defaultProviderPresetId: provider.id, allowedTools: tools, autoReplyMode: "mentions_only",
      runtimePolicy: { maxConcurrentRuns: 1, schedulingMode: "smart", writeLockScope: "boundPath",
        allowReadOnlyParallel: true, queueOnConflict: true } })).channel;
    await api(`/channels/${channel.id}/workspace/handoff`, { mode: "local" });
    for (const branch of branches) await api(`/teammates/${branch.participantId}/channels`,
      { memberships: [{ channelId: channel.id }] }, "PUT");
    const graph = { schemaVersion: 1, id: "isolated-delivery", name: "Two serial isolated writing steps", entryNodeId: "left",
      nodes: branches.map((branch, index) => ({ id: index ? "right" : "left", kind: "step", name: branch.name,
        prompt: `Read, edit, write and read ${branch.path}.`, sideEffectClass: "workspace_write" })), edges: [],
      termination: { success: "all_required_succeeded", onFailedRequiredNode: "block_for_user", onApprovalDenied: "block_for_user" } };
    const workflow = store.createChannelWorkflow({ channelId: channel.id, title: "SDK Host isolated delivery",
      objective: "Deliver two isolated writing results after exact target consent", status: "ready", createdBy: "local-user",
      metadata: { maxParallelSteps: 1, workflowGraph: graph, workflowGraphFingerprint: workflowGraphFingerprintV1(graph) } }, now());
    const steps = branches.map((branch, position) => store.createChannelWorkflowStep({ workflowId: workflow.id,
      title: `${branch.name} isolated change`, prompt: `Read ${branch.path}, edit initial to edited, write the final result, then read it.`,
      position, toParticipantId: branch.participantId, toParticipantLabel: branch.name,
      metadata: { autoStart: true, dependsOnStepIds: [], providerPresetId: provider.id, requestedRunnerId: "pi", requiredTools: tools,
        sideEffectClass: "workspace_write", parallelPolicy: { autoParallel: false, maxParallelSiblings: 1, resourceKeys: [] } } }, now()));
    const roundId = "isolated-delivery-round";
    const planned = await planWorkflowIsolatedRound({ store, workflowId: workflow.id, roundId, worktreeRoot,
      mode: "apply_to_target", validationRequirements: WORKFLOW_CANDIDATE_VALIDATORS.map(({ id, fingerprint }) => ({ id, fingerprint })) });
    const plans = planned.plans;
    const isolation = () => createSqliteWorkflowIsolationStore(store);
    const round = () => isolation().getIntegrationRound(roundId);
    const coordinator = () => createSqliteWorkflowIntegrationCoordinatorStore(store);
    const applications = () => createSqliteWorkflowMergeApplyStore(store);
    const cleanup = () => createSqliteWorkflowWorktreeCleanupStore(store);
    const scope = { roundId, generation: 1 };
    const journal = () => ({ effects: coordinator().listEffects(scope), receipts: coordinator().listReceipts(scope) });
    const describe = () => ({ executions: [...executions.values()].map(execution => ({ runId: execution.runId,
      requests: execution.requests.length, results: execution.results })),
      steps: steps.map(step => store.getChannelWorkflowStep(step.id)?.status), round: round(),
      runs: store.listRuns({ limit: 20 }).map(run => ({ id: run.id, status: run.status, error: run.errorMessage })),
      approvals: store.listApprovalRequests({ limit: 20 }).map(approval => ({ action: approval.actionType, status: approval.status })) });
    const wait = (predicate, label) => notifications.wait(predicate, label, describe);
    const pending = () => store.listApprovalRequests({ status: "pending", limit: 20 });
    assert.equal(planned.round.inputs.mode, "apply_to_target");
    assert.equal(plans.length, 2);
    assert.deepEqual(round().inputs.mergeOrder, steps.map(step => step.id));
    assert.deepEqual(round().inputs.participants.map(participant => participant.workflowStepId), steps.map(step => step.id));
    assert.deepEqual(await target(), initialTarget);
    const started = await api(`/workflows/${workflow.id}/orchestrate`, {});
    assert.equal(started.status, "started", JSON.stringify(started));
    assert.deepEqual(started.startedSteps.map(start => start.workflowStep.id), [steps[0].id]);

    const evidence = [];
    for (const [index, branch] of branches.entries()) {
      const plan = plans[index];
      for (const action of ["edit", "write"]) {
        await wait(() => pending().length === 1 && pending()[0].actionType === action
          && executions.has(index) && store.getRun(executions.get(index).runId).status === "waiting_for_approval",
        `${branch.name} ${action} approval`);
        const approval = pending()[0];
        assert.equal(approval.runId, executions.get(index).runId);
        assert.equal(await readFile(join(plan.executionRoot, branch.path), "utf8"),
          `${action === "edit" ? "initial" : "edited"} ${branch.path}\n`, "own effect cannot precede its HTTP approval");
        assert.deepEqual(await target(), initialTarget);
        await api(`/approvals/${approval.id}/approve`, { decisionKind: "approve_once" });
      }
      await wait(() => reached[index].settled, `${branch.name} real Host read/edit/write/read barrier`);
      const execution = executions.get(index), run = store.getRun(execution.runId), unit = store.getWorkUnit(run.workUnitId);
      const attempt = store.getWorkUnitAttempt(unit.activeAttemptId), fence = toRuntimeAttemptFence(attempt);
      const bindingId = workflowIsolationDigest({ runId: run.id, ...fence }, "wib_");
      const binding = isolation().getExecutionBinding(bindingId), writer = { bindingId, ...fence };
      assert.equal(binding.status, "ready");
      assert.equal(run.cwd, plan.executionRoot);
      assert.equal(binding.location.executionRoot, plan.executionRoot);
      assert.equal(run.workflowStepId, steps[index].id);
      assert.equal(run.requestSnapshot.effectivePolicySnapshot.workspaceAccessMode, "workspace_write");
      assert.deepEqual(run.requestSnapshot.effectivePolicySnapshot.allowedWritePaths, ["."]);
      assert.deepEqual(run.requestSnapshot.workflowIsolationPlan, { planId: plan.planId, planDigest: plan.planDigest });
      assert.deepEqual(run.requestSnapshot.runnerExecutionInput, unit.request.runnerExecutionInput);
      assert.equal(run.requestSnapshot.runnerExecutionInput.input.cwd, plan.executionRoot);
      assert.equal(run.requestSnapshot.runnerExecutionInput.input.isolatedToolsProfile, "host_isolated_files_v1");
      const slots = store.listRuntimeSemaphoreSlots({ workUnitId: unit.id, status: "active", limit: 100 });
      assert.equal(slots.length, plan.resourcePlan.entries.length + plan.resourcePlan.resourceKeys.length);
      for (const slot of slots) for (const [key, value] of Object.entries(fence)) assert.equal(slot[key], value);
      const writes = store.listHarnessToolExecutions(run.id);
      assert.equal(writes.length, 2);
      for (const write of writes) {
        assert.equal(write.state, "succeeded");
        const artifacts = write.evidenceArtifactIds.map(id => store.getArtifact(id));
        assert.ok(artifacts.every(artifact => artifact?.runId === run.id));
        const mutationArtifact = artifacts.find(artifact => artifact.sealedPayload?.kind === "workflow_isolation_file_mutation");
        assert.ok(mutationArtifact?.contentSha256);
        const mutation = mutationArtifact.sealedPayload;
        assert.equal(mutation.bindingId, bindingId);
        assert.equal(mutation.planDigest, plan.planDigest);
        assert.deepEqual(mutation.sourceFence, fence);
      }
      const calls = callsFor(branch);
      assert.deepEqual(listAllExecutionActionsForRun(store, run.id).map(action => action.actionType).sort(), calls.map(call => call.name).sort());
      for (const [callIndex, { request, result }] of execution.results.entries()) {
        assert.deepEqual(request.input, calls[callIndex].input);
        assert.equal(request.cwd, plan.executionRoot);
        assert.notEqual(result.isError, true);
        const gates = execution.gates.filter(gate => gate.request.toolCallId === request.toolCallId);
        assert.equal(gates.length, 2, "SDK admission and Host execution both consult the real gate");
        assert.ok(gates.every(gate => gate.decision.allowed));
      }
      assert.equal(await readFile(join(plan.executionRoot, branch.path), "utf8"), branch.final);
      assert.deepEqual(await target(), initialTarget);
      assert.equal((await coordinateWorkflowIntegration({ store, roundId })).status, "waiting");
      assert.equal(round().candidate, undefined, "a live branch cannot supply an early candidate");
      assert.equal(journal().effects.length, 0);
      if (index === 0) {
        const tick = await api(`/workflows/${workflow.id}/orchestrate`, {});
        assert.equal(tick.status, "idle", JSON.stringify(tick));
        assert.equal(executions.size, 1, "the unreleased first SDK terminal response prevents second dispatch");
        assert.equal(store.getChannelWorkflowStep(steps[1].id).runId, undefined);
      }
      releases[index].resolve();
      await wait(() => store.getRun(run.id).status === "succeeded"
        && store.getChannelWorkflowStep(steps[index].id).status === "succeeded"
        && store.getHostAttemptCompletion({ runId: run.id, ...fence })?.drainedAt
        && store.listRuntimeSemaphoreSlots({ workUnitId: unit.id, status: "active", limit: 100 }).length === 0,
      `${branch.name} terminal, Host drain and serial capacity release`);
      assert.equal(store.getWorkUnit(unit.id).status, "succeeded");
      assert.equal(store.getWorkUnitAttempt(attempt.id).status, "succeeded");
      const capture = isolation().assertTerminalCapture({ writer, expectedRevision: binding.revision, now: now() });
      assert.equal(capture.status, "authorized", JSON.stringify(capture));
      assert.equal(capture.terminal.completion.effectCoverage, "pi_tracked_tools_v1");
      const intent = isolation().getTerminalResultIntent(bindingId);
      assert.equal(intent.status, "confirmed");
      assert.equal(intent.proofDigest, capture.proofDigest);
      const packet = store.getArtifact(intent.packetArtifactId).sealedPayload;
      assert.equal(packet.kind, "workflow_branch_result");
      assert.equal(packet.context.lineage.bindingId, bindingId);
      assert.deepEqual(packet.changedPaths.map(change => change.path), [branch.path]);
      assert.deepEqual(packet.terminal.validations, [], "file tools do not invent project command validation");
      assert.equal(await git("rev-parse", packet.resultRef), packet.commit);
      assert.equal(await git("show", `${packet.commit}:${branch.path}`), branch.final.trim());
      for (const id of [intent.packetArtifactId, packet.terminal.terminalArtifactRef, packet.terminal.quiescenceArtifactRef,
        packet.terminal.toolCompletionArtifactRef, packet.terminal.outputPacketArtifactRef, ...packet.terminal.contextArtifactRefs]) {
        const artifact = store.getArtifact(id);
        assert.equal(artifact.runId, run.id);
        assert.ok(artifact.contentSha256);
      }
      evidence.push({ run, unit, attempt, fence, writer, binding, packet });
    }
    for (const key of ["workUnitId", "attemptId"]) assert.notEqual(evidence[0].fence[key], evidence[1].fence[key]);
    assert.notDeepEqual(evidence[0].fence, evidence[1].fence);
    assert.equal(evidence[0].fence.runtimeInstanceId, evidence[1].fence.runtimeInstanceId, "both Attempts belong to this daemon instance");
    assert.notEqual(evidence[0].run.id, evidence[1].run.id);
    assert.notEqual(evidence[0].run.cwd, evidence[1].run.cwd);
    assert.notEqual(evidence[0].writer.bindingId, evidence[1].writer.bindingId);
    await waitForWorkflowIsolationIdle(store, workflow.id);
    await wait(() => pending().length === 1 && pending()[0].actionType === "workflow_merge", "production merge approval proposal");
    const reconciled = await reconcileWorkflowIntegrations(store, workflow.id);
    assert.equal(reconciled[0].status, "awaiting_approval", JSON.stringify(reconciled));
    const approval = pending()[0], candidate = round().candidate;
    const proposal = createSqliteWorkflowMergeApprovalStore(store).getRequest(roundId, 1);
    assert.equal(proposal.approvalId, approval.id);
    assert.equal(round().outstandingApprovalId, approval.id);
    assert.equal(round().phase, "awaiting_approval");
    assert.equal(approval.payload.type, "workflow_merge");
    assert.equal(approval.runId, undefined, "target consent is not a tool approval owned by either Run");
    assert.equal(approval.payload.candidate.commit, candidate.commit);
    const candidateArtifact = evidence.flatMap(item => store.listArtifacts(item.run.id))
      .find(artifact => artifact.sealedPayload?.kind === "workflow_integration_candidate"
        && workflowGitPacketDigest(artifact.sealedPayload) === candidate.packetDigest);
    assert.ok(candidateArtifact?.contentSha256);
    const candidatePacket = candidateArtifact.sealedPayload;
    assert.deepEqual(candidatePacket.includedStepIds, round().inputs.mergeOrder);
    assert.deepEqual(candidatePacket.merges.map(merge => merge.workflowStepId), steps.map(step => step.id));
    assert.deepEqual(candidate.branchResultDigests, evidence.map(item => isolation().getTerminalResultIntent(item.writer.bindingId).packetDigest));
    for (const branch of branches) assert.equal(await git("show", `${candidate.commit}:${branch.path}`), branch.final.trim());
    const verification = journal().receipts.map(receipt => store.getArtifact(receipt.artifactId).sealedPayload.evidence)
      .find(payload => payload?.kind === "workflow_candidate_verification");
    assert.equal(verification.status, "passed");
    assert.equal(verification.projectTestsRun, false);
    assert.deepEqual(verification.validationRequirements, WORKFLOW_CANDIDATE_VALIDATORS.map(({ id, fingerprint }) => ({ id, fingerprint })));
    assert.ok(verification.results.every(result => result.status === "passed" && result.exitCode === 0));
    assert.equal(applications().getPermit(roundId, 1), undefined);
    assert.deepEqual(cleanup().listIntents({ workflowId: workflow.id }), []);
    assert.deepEqual(await target(), initialTarget, "candidate computation and verification cannot apply target changes");
    assert.notEqual(store.getChannelWorkflow(workflow.id).status, "succeeded");
    const sources = async () => Promise.all(plans.map(async plan => ({ files: await filesAt(plan.executionRoot),
      head: await gitAt(plan.executionRoot, "rev-parse", "HEAD"),
      status: await gitAt(plan.executionRoot, "status", "--porcelain=v1", "--untracked-files=all") })));
    const sourceBefore = await sources(), refsBefore = await git("for-each-ref", "--format=%(refname) %(objectname)");
    for (const [index, source] of sourceBefore.entries()) assert.deepEqual(source.files,
      Object.fromEntries(branches.map((branch, other) => [branch.path, index === other ? branch.final : `initial ${branch.path}\n`])),
    "each source contains only its own Host changes, not the sibling result");
    await api(`/approvals/${approval.id}/approve`, { decisionKind: "approve_once" });
    assert.equal(store.getApprovalRequest(approval.id).decisionKind, "approve_once");
    assert.equal(round().phase, "applied");
    assert.equal(store.getChannelWorkflow(workflow.id).status, "succeeded");
    assert.equal((await target()).head, candidate.commit);
    assert.deepEqual((await target()).files, Object.fromEntries(branches.map(branch => [branch.path, branch.final])));
    assert.equal((await target()).status, "");
    assert.deepEqual(await sources(), sourceBefore, "no-force cleanup retains both genuinely modified source worktrees");
    assert.equal(await git("for-each-ref", "--format=%(refname) %(objectname)", "refs/ling/"),
      refsBefore.split("\n").filter(line => line.startsWith("refs/ling/")).join("\n"));
    const permit = applications().getPermit(roundId, 1);
    assert.ok(permit);
    assert.equal(permit.approvalId, approval.id);
    assert.equal(applications().inspectApplication({ approvalId: approval.id, now: now() }).status, "applied");
    assert.equal(store.database.prepare("SELECT COUNT(*) n FROM workflow_merge_apply_permits").get().n, 1);
    assert.equal(store.database.prepare("SELECT status FROM resource_leases WHERE id=?").get(permit.leaseId).status, "released");
    assert.equal(applications().assertPermit({ permitId: permit.permitId, ownerToken: permit.ownerToken, now: now() }).status, "blocked");
    assert.equal(journal().effects.filter(effect => effect.kind === "target_apply").length, 1);
    const applyReceipts = journal().receipts.filter(receipt => receipt.intentId === permit.intentId);
    assert.equal(applyReceipts.length, 1);
    assert.equal(applyReceipts[0].outcome, "confirmed");
    const applyEvidence = store.getArtifact(applyReceipts[0].artifactId).sealedPayload.evidence;
    assert.equal(applyEvidence.disposition, "applied");
    assert.equal(applyEvidence.observation.verifiedClean, true);
    assert.equal(applyEvidence.observation.head, candidate.commit);
    assert.equal(verifyApprovalPostCommitEvidence(store, store.getApprovalRequest(approval.id), "owner").status, "applied");
    assert.equal(coordinator().readCompletionBlocker(workflow.id), undefined);
    assert.equal(coordinator().readPublicationBlocker(workflow.id), undefined);
    const intents = cleanup().listIntents({ workflowId: workflow.id });
    assert.equal(intents.length, 3, "cleanup separately journals the integration directory and both sources");
    for (const intent of intents) {
      const receipts = cleanup().listReceipts(intent.cleanupId);
      assert.equal(receipts.length, 1);
      const observation = store.getArtifact(receipts[0].artifactId).sealedPayload.observation;
      assert.equal(observation.worktreeId, intent.worktreeId);
      assert.deepEqual(observation.retainedRefs, intent.plan.retainedRefs);
      assert.ok(intent.plan.retainedRefs.length);
      for (const retained of intent.plan.retainedRefs) assert.equal(await git("rev-parse", retained.ref), retained.commit);
      assert.equal(await git("rev-parse", intent.plan.scope.branchRef), planned.round.inputs.baseCommit, "cleanup never deletes branches");
      if (intent.plan.role === "integration") {
        assert.equal(observation.state, "removed");
        await assert.rejects(access(intent.plan.scope.executionRoot), { code: "ENOENT" });
        assert.ok(!(await git("worktree", "list", "--porcelain")).includes(`worktree ${intent.plan.scope.executionRoot}\n`));
      } else {
        assert.equal(observation.state, "unknown");
        assert.match(observation.code, /dirty/);
        await access(intent.plan.scope.executionRoot);
      }
      for (const id of intent.plan.artifactIds) assert.ok(store.getArtifact(id)?.contentSha256);
    }
    for (const item of evidence) {
      assert.equal(store.listRuns({ workflowStepId: item.run.workflowStepId, limit: 20 }).length, 1);
      assert.deepEqual(store.listRuntimeSemaphoreSlots({ workUnitId: item.unit.id, status: "active", limit: 100 }), []);
      assert.deepEqual(store.listResourceLeases({ ownerType: "workflow_step", ownerId: item.run.workflowStepId, status: "active", limit: 100 }), []);
    }
    const snapshot = async () => ({ target: await target(), sources: await sources(),
      refs: await git("for-each-ref", "--format=%(refname) %(objectname)"), reflogs: await git("reflog", "show", "--all", "--format=%H %gD"),
      worktrees: await git("worktree", "list", "--porcelain"), round: round(), journal: journal(), permit: applications().getPermit(roundId, 1),
      cleanup: cleanup().listIntents({ workflowId: workflow.id }).map(intent => ({ intent, receipts: cleanup().listReceipts(intent.cleanupId) })),
      artifacts: evidence.flatMap(item => store.listArtifacts(item.run.id)),
      executions: evidence.map(item => ({ runs: store.listRuns({ workflowStepId: item.run.workflowStepId, limit: 20 }),
        attempt: store.getWorkUnitAttempt(item.attempt.id), binding: isolation().getExecutionBinding(item.writer.bindingId),
        completion: store.getHostAttemptCompletion({ runId: item.run.id, ...item.fence }),
        slots: store.listRuntimeSemaphoreSlots({ workUnitId: item.unit.id, limit: 100 }) })) });
    const delivered = await snapshot();
    const duplicate = await api(`/approvals/${approval.id}/approve`, { decisionKind: "approve_once" }, "POST", 400);
    assert.equal(duplicate.error, "approval_not_pending");
    assert.equal((await api(`/workflows/${workflow.id}/orchestrate`, {})).status, "completed");
    assert.deepEqual(await snapshot(), delivered, "duplicate HTTP consent and orchestration do not replay any Git/journal effect");
    await daemon.stop(); daemon = undefined;
    reopened = createSqliteRunStore(cwd); store = reopened;
    await recoverWorkflowIsolationsAtStartup(store);
    assert.equal((await reconcileWorkflowMergeApplication({ store, approvalId: approval.id })).status, "applied");
    assert.equal((await coordinateWorkflowIntegration({ store, roundId })).status, "applied");
    await cleanupWorkflowWorktrees(store, workflow.id, { observeOnly: true });
    for (const item of evidence) {
      const packet = (await captureWorkflowIsolatedResult({ store, writer: item.writer })).packet;
      assert.deepEqual(packet, item.packet);
    }
    assert.deepEqual(await snapshot(), delivered, "SQLite reopen observes sealed refs, cleanup tombstones and one consumed permit");
    assert.equal(executions.size, 2, "no provider or Host tool is dispatched during duplicate/reopen observation");
  });

function deferred() {
  let resolve;
  const result = { settled: false, promise: new Promise(done => { resolve = done; }), resolve: () => {
    result.settled = true; resolve();
  } };
  return result;
}

function sse(delta, finishReason) {
  return new Response([
    { choices: [{ index: 0, delta, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: finishReason }] },
  ].map(value => `data: ${JSON.stringify(value)}\n\n`).join("") + "data: [DONE]\n\n",
  { headers: { "content-type": "text/event-stream" } });
}

function changes() {
  const listeners = new Set();
  return {
    notify: () => { for (const check of [...listeners]) check(); },
    wait: (predicate, label, describe) => new Promise((resolve, reject) => {
      // A timeout bounds failures only. Progress and ordering are driven by actual store/SDK notifications.
      const timer = setTimeout(() => { listeners.delete(check);
        reject(new Error(`Timed out waiting for ${label}: ${JSON.stringify(describe())}`)); }, 40_000);
      const check = () => {
        try {
          if (!predicate()) return;
          clearTimeout(timer); listeners.delete(check); resolve();
        } catch (error) { clearTimeout(timer); listeners.delete(check); reject(error); }
      };
      listeners.add(check); check();
    }),
  };
}
