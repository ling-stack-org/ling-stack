import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { workflowGraphFingerprintV1 } from "@ling-stack/contracts";
import { createSqliteRunStore, createSqliteWorkflowIsolationStore, toRuntimeAttemptFence,
  workflowIsolationDigest } from "../../core/dist/index.js";
import { stream } from "../../runner-pi/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js";
import { createDaemonServer } from "../dist/index.js";
import { planWorkflowIsolatedRound } from "../dist/features/channels/workflow-isolation-planning.js";
import { listAllExecutionActionsForRun } from "../dist/features/runs/execution-actions.js";
import { ToolFreePiRunner } from "./support/tool-free-pi-runner.mjs";

const exec = promisify(execFile);
const tools = ["read", "edit", "write"];
const calls = [
  { name: "read", input: { path: "owned.txt" } },
  { name: "edit", input: { path: "owned.txt", edits: [{ oldText: "initial", newText: "edited" }] } },
  { name: "write", input: { path: "owned.txt", content: "final isolated result\n" } },
  { name: "read", input: { path: "owned.txt" } },
];

test("actual workflow Pi Run seals isolated input, approves Host edit/write, drains and never changes the target checkout",
  { skip: process.platform !== "darwin", timeout: 60_000 }, async t => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "ling-workflow-isolated-run-")));
    const cwd = join(root, "repository"), worktreeRoot = join(root, "host-worktrees");
    await mkdir(cwd); await mkdir(worktreeRoot);
    let daemon, store, execution;
    const completed = deferred(), contexts = new AsyncLocalStorage();
    t.after(async () => {
      completed.resolve();
      try { await daemon?.stop(); }
      finally { await rm(root, { recursive: true, force: true }); }
    });
    const git = async (...args) => (await exec("/usr/bin/git", args, { cwd, env: { PATH: "/usr/bin:/bin", HOME: root,
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@ling.invalid",
      GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@ling.invalid" } })).stdout.trim();
    await git("init", "--initial-branch=main");
    await writeFile(join(cwd, ".gitignore"), "*\n!owned.txt\n!.gitignore\n");
    await writeFile(join(cwd, "owned.txt"), "initial owned content\n");
    await git("add", "--", ".gitignore", "owned.txt");
    await git("commit", "-m", "initial");
    const targetHead = await git("rev-parse", "HEAD");

    class IsolatedFilesPiRunner extends ToolFreePiRunner {
      async runTask(options) {
        assert.equal(execution, undefined, "the accepted step dispatches only its original Pi Run");
        const run = store.getRun(options.runId);
        assert.equal(options.isolatedToolsProfile, "host_isolated_files_v1");
        assert.deepEqual([...options.tools].sort(), [...tools].sort());
        assert.deepEqual(options.mcpTools, []);
        assert.deepEqual(options.hostCapabilityTools, []);
        assert.deepEqual(options.mediaGenerationTools, []);
        assert.equal(options.onPermissionRequired, undefined);
        assert.equal(options.providerBudget, undefined);
        assert.notEqual(options.cwd, cwd);
        execution = { runId: run.id, options, requests: [], results: [], gates: [], events: [], reached: false };
        return contexts.run(execution, () => super.runTask({ ...options,
          onToolBefore: async request => {
            const decision = await options.onToolBefore(request);
            execution.gates.push({ request, decision }); return decision;
          },
          onIsolatedToolCall: async request => {
            const result = await options.onIsolatedToolCall(request);
            execution.results.push({ request, result }); return result;
          },
          onEvent: event => { execution.events.push(event); return options.onEvent?.(event); },
        }));
      }

      registerCustomProviderIfNeeded(runtime, provider) {
        super.registerCustomProviderIfNeeded(runtime, provider);
        runtime.registerProvider(provider.provider, { api: "openai-completions", apiKey: "fixture-no-network",
          streamSimple: (model, context, options) => stream(model, context, { ...options,
            fetch: async (_url, request) => {
              const current = contexts.getStore();
              assert.equal(current, execution, "the real SDK transport stays bound to the original Run");
              const body = JSON.parse(request.body), index = current.requests.length;
              current.requests.push(body);
              assert.deepEqual((body.tools ?? []).map(tool => tool.function.name).sort(), [...tools].sort());
              assert.equal(current.results.length, index);
              if (index) {
                const result = current.results[index - 1];
                assert.notEqual(result.result.isError, true, JSON.stringify(result));
                const outputs = body.messages.filter(message => message.role === "tool");
                assert.equal(outputs.length, index, "SDK receives each real Host result");
                if (index === 1) assert.match(JSON.stringify(outputs.at(-1).content), /initial owned content/);
                if (index === 4) assert.match(JSON.stringify(outputs.at(-1).content), /final isolated result/);
              }
              if (index < calls.length) {
                const call = calls[index];
                return sse({ tool_calls: [{ index: 0, id: `isolated-${index}`, type: "function",
                  function: { name: call.name, arguments: JSON.stringify(call.input) } }] }, "tool_calls");
              }
              assert.equal(index, calls.length);
              current.reached = true;
              await completed.promise;
              options.signal?.throwIfAborted();
              return sse({ content: "Completed the isolated file changes." }, "stop");
            },
          }),
        });
      }
    }

    daemon = createDaemonServer({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd,
      harness: { toolBroker: { mode: "enforce" } },
      channels: { autoRoute: false, intentSelector: false, terminalReports: false, teamObserverBus: false },
    }, { runner: new IsolatedFilesPiRunner(), storeFactory(storeCwd) {
      const created = createSqliteRunStore(storeCwd);
      assert.equal(storeCwd, cwd, "an isolated execution must not create a second workspace store");
      store = created; return created;
    } });
    await daemon.start();
    const address = daemon.server.address();
    assert.ok(address && typeof address === "object");
    const api = async (path, body, method = "POST") => {
      const response = await fetch(`http://127.0.0.1:${address.port}${path}${path.includes("?") ? "&" : "?"}cwd=${encodeURIComponent(cwd)}`, {
        method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(15_000),
      });
      const value = await response.json();
      assert.ok(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(value)}`);
      return value;
    };
    const provider = (await api("/providers", { kind: "glm", displayName: "Local isolated SDK transport",
      providerId: "isolated-files-scripted", model: "isolated-files-fixture", api: "openai-completions",
      baseUrl: "https://isolated-fixture.invalid/v1", capabilities: ["chat", "tool_call"], input: ["text"],
      authHeader: false, reasoning: false, enabled: true })).provider;
    store.recordProviderCheckResult(provider.id, { ok: true, code: "ready", message: "Scripted local SDK transport",
      checkedAt: new Date().toISOString() });
    await api("/approval-policy", { toolDecisions: { read: "allow", edit: "ask", write: "ask" } }, "PATCH");
    const participantId = "teammate_builtin_engineer";
    await api(`/teammates/${participantId}`, { providerPresetId: provider.id, allowedTools: tools }, "PATCH");
    const channel = (await api("/channels", { name: "Isolated file implementation", status: "active", boundPath: cwd,
      defaultProviderPresetId: provider.id, allowedTools: tools, autoReplyMode: "mentions_only",
      runtimePolicy: { maxConcurrentRuns: 1, schedulingMode: "smart", writeLockScope: "boundPath",
        allowReadOnlyParallel: true, queueOnConflict: true } })).channel;
    await api(`/channels/${channel.id}/workspace/handoff`, { mode: "local" });
    await api(`/teammates/${participantId}/channels`, { memberships: [{ channelId: channel.id }] }, "PUT");
    const graph = { schemaVersion: 1, id: "isolated-run", name: "Isolated file changes", entryNodeId: "write",
      nodes: [{ id: "write", kind: "step", name: "Write", prompt: "Edit the owned file", sideEffectClass: "workspace_write" }],
      edges: [], termination: { success: "all_required_succeeded", onFailedRequiredNode: "block_for_user", onApprovalDenied: "block_for_user" } };
    const now = new Date().toISOString();
    const workflow = store.createChannelWorkflow({ channelId: channel.id, title: "Isolated Host files",
      objective: "Edit an isolated copy without changing the target", status: "ready", createdBy: "local-user",
      metadata: { maxParallelSteps: 1, workflowGraph: graph, workflowGraphFingerprint: workflowGraphFingerprintV1(graph) } }, now);
    const step = store.createChannelWorkflowStep({ workflowId: workflow.id, title: "Change the owned file",
      prompt: "Read owned.txt, edit it, then write and read the final result.", position: 0,
      toParticipantId: participantId, toParticipantLabel: "Engineer", metadata: { autoStart: true, dependsOnStepIds: [],
        providerPresetId: provider.id, requestedRunnerId: "pi", requiredTools: tools, sideEffectClass: "workspace_write",
        parallelPolicy: { autoParallel: false, maxParallelSiblings: 1, resourceKeys: [] } } }, now);
    const planned = await planWorkflowIsolatedRound({ store, workflowId: workflow.id, roundId: "isolated-run-round",
      worktreeRoot, validationRequirements: [{ id: "fixture-inspection", fingerprint: "owned-file-v1" }] });
    const plan = planned.plans[0], isolation = createSqliteWorkflowIsolationStore(store);
    const describe = () => ({ execution: execution && { requests: execution.requests.length,
      results: execution.results.map(({ request, result }) => ({ tool: request.toolName, result })),
      reached: execution.reached }, step: store.getChannelWorkflowStep(step.id)?.status,
      runs: store.listRuns({ limit: 10 }).map(run => ({ id: run.id, status: run.status, error: run.errorMessage })),
      approvals: store.listApprovalRequests({ limit: 20 }).map(approval => ({ action: approval.actionType, status: approval.status })) });
    const started = await api(`/workflows/${workflow.id}/orchestrate`, {});
    assert.equal(started.status, "started", JSON.stringify(started));
    assert.equal(started.startedSteps.length, 1);
    for (const [index, action] of ["edit", "write"].entries()) {
      await until(() => store.listApprovalRequests({ status: "pending", limit: 20 }).length === 1,
        `${action} Host approval`, describe);
      const approval = store.listApprovalRequests({ status: "pending", limit: 20 })[0];
      assert.equal(approval.actionType, action);
      assert.equal(store.getRun(execution.runId).status, "waiting_for_approval");
      assert.equal(await readFile(join(cwd, "owned.txt"), "utf8"), "initial owned content\n");
      assert.equal(await readFile(join(plan.executionRoot, "owned.txt"), "utf8"), index ? "edited owned content\n" : "initial owned content\n",
        "the file cannot change before its own approval");
      await api(`/approvals/${approval.id}/approve`, { decisionKind: "approve_once" });
    }
    await until(() => execution?.reached, "all four real Host file operations", describe);
    const run = store.getRun(execution.runId), unit = store.getWorkUnit(run.workUnitId);
    const attempt = store.getWorkUnitAttempt(unit.activeAttemptId), fence = toRuntimeAttemptFence(attempt);
    const bindingId = workflowIsolationDigest({ runId: run.id, ...fence }, "wib_");
    const binding = isolation.getExecutionBinding(bindingId), writer = { bindingId, ...fence };
    assert.equal(binding.status, "ready");
    assert.equal(binding.location.executionRoot, plan.executionRoot);
    assert.equal(run.cwd, plan.executionRoot);
    assert.equal(run.requestSnapshot.effectivePolicySnapshot.workspaceAccessMode, "workspace_write");
    assert.deepEqual(run.requestSnapshot.effectivePolicySnapshot.allowedWritePaths, ["."]);
    assert.deepEqual(run.requestSnapshot.runnerExecutionInput, unit.request.runnerExecutionInput);
    assert.equal(run.requestSnapshot.runnerExecutionInput.input.cwd, plan.executionRoot);
    assert.equal(run.requestSnapshot.runnerExecutionInput.input.isolatedToolsProfile, "host_isolated_files_v1");
    assert.deepEqual(run.requestSnapshot.workflowIsolationPlan, { planId: plan.planId, planDigest: plan.planDigest });
    assert.equal(await readFile(join(plan.executionRoot, "owned.txt"), "utf8"), "final isolated result\n");
    assert.equal(await git("rev-parse", "HEAD"), targetHead);
    assert.equal(await git("status", "--porcelain"), "");
    const slots = store.listRuntimeSemaphoreSlots({ workUnitId: unit.id, status: "active", limit: 100 });
    assert.equal(slots.length, plan.resourcePlan.entries.length + plan.resourcePlan.resourceKeys.length);
    for (const slot of slots) for (const [key, value] of Object.entries(fence)) assert.equal(slot[key], value);
    const writes = store.listHarnessToolExecutions(run.id);
    assert.equal(writes.length, 2);
    assert.ok(writes.every(write => write.state === "succeeded" && write.evidenceArtifactIds.length > 0), JSON.stringify(writes));
    for (const write of writes) {
      const artifacts = write.evidenceArtifactIds.map(artifactId => store.getArtifact(artifactId));
      assert.ok(artifacts.every(artifact => artifact?.runId === run.id));
      const result = artifacts.find(artifact => artifact?.sealedPayload?.kind === "workflow_isolation_file_mutation");
      assert.ok(result?.contentSha256);
      assert.equal(result.sealedPayload.bindingId, bindingId);
      assert.equal(result.sealedPayload.planDigest, plan.planDigest);
      assert.deepEqual(result.sealedPayload.sourceFence, fence);
    }
    assert.deepEqual(listAllExecutionActionsForRun(store, run.id).map(action => action.actionType).sort(),
      calls.map(call => call.name).sort());
    for (const [index, result] of execution.results.entries()) {
      assert.deepEqual(result.request.input, calls[index].input);
      assert.equal(result.request.cwd, plan.executionRoot);
      assert.notEqual(result.result.isError, true);
      const gates = execution.gates.filter(gate => gate.request.toolCallId === result.request.toolCallId);
      assert.equal(gates.length, 2);
      assert.ok(gates.every(gate => gate.decision.allowed));
    }
    completed.resolve();
    await until(() => store.getRun(run.id).status === "succeeded"
      && store.getHostAttemptCompletion({ runId: run.id, ...fence })?.drainedAt
      && store.getChannelWorkflowStep(step.id).status === "succeeded"
      && store.listRuntimeSemaphoreSlots({ workUnitId: unit.id, status: "active", limit: 100 }).length === 0,
    "original Run terminal with Host drain and capacity released", describe);
    assert.equal(store.getWorkUnit(unit.id).status, "succeeded");
    assert.equal(store.getWorkUnitAttempt(attempt.id).status, "succeeded");
    const capture = isolation.assertTerminalCapture({ writer, expectedRevision: binding.revision, now: new Date().toISOString() });
    assert.equal(capture.status, "authorized", JSON.stringify(capture));
    assert.equal(capture.terminal.completion.effectCoverage, "pi_tracked_tools_v1");
    assert.equal(store.listRuns({ workflowStepId: step.id, limit: 20 }).length, 1);
    assert.equal(await readFile(join(cwd, "owned.txt"), "utf8"), "initial owned content\n");
    assert.equal(await git("rev-parse", "HEAD"), targetHead);
    assert.equal(await git("status", "--porcelain"), "");
  });

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function sse(delta, finishReason) {
  return new Response([
    { choices: [{ index: 0, delta, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: finishReason }] },
  ].map(value => `data: ${JSON.stringify(value)}\n\n`).join("") + "data: [DONE]\n\n",
  { headers: { "content-type": "text/event-stream" } });
}

async function until(predicate, label, describe) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(`Timed out waiting for ${label}: ${JSON.stringify(describe())}`);
}
