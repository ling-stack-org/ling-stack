import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { execFile, fork } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const filename = fileURLToPath(import.meta.url);
const exec = promisify(execFile);
const now = () => new Date().toISOString();
const branches = [
  { id: "left", participantId: "teammate_builtin_engineer", name: "Engineer", path: "left.txt", content: "left through parallel Host\n" },
  { id: "right", participantId: "teammate_builtin_qa", name: "QA", path: "right.txt", content: "right through parallel Host\n" },
];

/** Runs the real daemon/SDK in a child with an explicit, credential-free environment. */
export async function startWorkflowIsolationLiveFixture({ holdReturn = false, port = 0 } = {}) {
  assert.equal(typeof holdReturn, "boolean");
  assert.ok(Number.isInteger(port) && port >= 0 && port <= 65535);
  const root = await realpath(await mkdtemp(join(tmpdir(), "ling-workflow-live-")));
  await Promise.all(["home", "tmp", "state"].map(path => mkdir(join(root, path))));
  const child = fork(filename, ["--fixture-child", root, JSON.stringify({ holdReturn, port })], {
    cwd: root, execArgv: [], stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: join(root, "home"),
      TMPDIR: join(root, "tmp"), LING_STACK_HOME: join(root, "state"), SHELL: "/bin/sh", LANG: "en_US.UTF-8",
      XDG_CONFIG_HOME: join(root, "home", ".config"), XDG_CACHE_HOME: join(root, "home", ".cache"),
      XDG_DATA_HOME: join(root, "home", ".local", "share"), XDG_STATE_HOME: join(root, "home", ".local", "state"),
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "Live Fixture", GIT_AUTHOR_EMAIL: "fixture@ling.invalid",
      GIT_COMMITTER_NAME: "Live Fixture", GIT_COMMITTER_EMAIL: "fixture@ling.invalid", NO_COLOR: "1" },
  });
  child.stdout.pipe(process.stderr);
  child.stderr.pipe(process.stderr);
  const ready = deferred(), pending = new Map();
  let manifest, sequence = 0, closing, stopRequested = false;
  const exited = new Promise(done => child.once("exit", (code, signal) => {
    const error = new Error(`Live fixture exited: ${code ?? signal}`);
    ready.reject(error);
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
    done();
  }));
  child.on("error", ready.reject);
  child.on("message", message => {
    if (message.kind === "ready") { manifest = message.value; ready.resolve(); return; }
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error));
    else { if (message.value?.daemonUrl) manifest = message.value; entry.resolve(message.value); }
  });
  const command = async input => {
    assert.ok(child.connected, "Fixture is closed");
    if (input.op === "stop") stopRequested = true;
    const id = ++sequence, result = deferred();
    pending.set(id, result);
    child.send({ id, input });
    return bounded(result.promise, 60_000, `fixture command ${input.op}`).finally(() => pending.delete(id));
  };
  const close = () => closing ??= (async () => {
    try {
      if (child.connected && !stopRequested) {
        try { await command({ op: "stop" }); }
        catch (error) { if (child.exitCode !== 0) throw error; }
      }
      await bounded(exited, 20_000, "fixture shutdown");
    }
    finally { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
      await rm(root, { recursive: true, force: true }); }
  })();
  try { await bounded(ready.promise, 60_000, "fixture startup"); }
  catch (error) { await close(); throw error; }
  return { get manifest() { return manifest; }, get url() { return manifest.daemonUrl; },
    get cwd() { return manifest.workspaceCwd; }, closed: exited, command, close };
}

async function startChild(root, options) {
  const [core, { PiRunnerAdapter }, { stream }, { createDaemonServer }, { workflowGraphFingerprintV1 },
    { planWorkflowIsolatedRound }, { WORKFLOW_CANDIDATE_VALIDATORS }, { appendChannelItemFixture }] = await Promise.all([
    import("../../../core/dist/index.js"), import("../../../runner-pi/dist/index.js"),
    import("../../../runner-pi/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js"),
    import("../../dist/index.js"), import("@ling-stack/contracts"),
    import("../../dist/features/channels/workflow-isolation-planning.js"),
    import("../../dist/features/channels/workflow-candidate-validation.js"),
    import("../../../core/test/channel-conversation-fixture.mjs"),
  ]);
  let current, control, stopping, queue = Promise.resolve();
  const token = randomBytes(24).toString("hex");
  const contexts = new AsyncLocalStorage();

  class LivePiRunner extends PiRunnerAdapter {
    async runTask(input) {
      const s = current, run = input.runId ? s.store.getRun(input.runId) : undefined;
      // Terminal report synthesis also uses the real SDK, without a persisted Run or branch gates.
      if (!run) return contexts.run(undefined, () => super.runTask(input));
      assert.notEqual(s.dispatchClosed, true, "Terminal-scenario restart is observation-only; workflow Run redispatch is forbidden");
      assert.equal(run.workflowId ?? s.store.getChannelWorkflowStep(run.workflowStepId)?.workflowId, s.workflow.id);
      const index = branches.findIndex(branch => branch.participantId === run.teammateId);
      assert.ok(index >= 0 && run.workflowStepId);
      assert.equal(s.executions.has(index), false, "Original branch must not be replaced by another Run");
      assert.equal(input.isolatedToolsProfile, "host_isolated_files_v1");
      assert.deepEqual(input.tools, ["write"]);
      for (const key of ["mcpTools", "hostCapabilityTools", "mediaGenerationTools"]) assert.deepEqual(input[key], []);
      const execution = { runId: run.id, branch: branches[index].id, requests: [], writes: [], approvals: [],
        boundaryFailures: [], reached: false, sdkSettled: false, returned: false };
      s.executions.set(index, execution);
      try {
        return await contexts.run(execution, () => super.runTask({ ...input,
          onToolBefore: async request => {
            const decision = await input.onToolBefore(request);
            execution.approvals.push({ request, decision }); return decision;
          },
          onIsolatedToolCall: async request => {
            const result = await input.onIsolatedToolCall(request);
            execution.writes.push({ request, result }); return result;
          },
          onTaskContinuationBoundary: async (...args) => {
            try { return await input.onTaskContinuationBoundary(...args); }
            catch (error) { execution.boundaryFailures.push({ point: args[0], code: error.code, message: error.message }); throw error; }
          },
        }));
      } finally {
        execution.sdkSettled = true;
        await s.hostGates[index].promise;
        execution.returned = true;
      }
    }
    registerCustomProviderIfNeeded(runtime, provider) {
      super.registerCustomProviderIfNeeded(runtime, provider);
      assert.equal(provider.baseUrl, current.upstream.baseUrl);
      runtime.registerProvider(provider.provider, { api: "openai-completions", apiKey: "static-loopback-only",
        streamSimple: (model, context, streamOptions) => stream(model, context, { ...streamOptions,
          fetch: (url, init) => {
            assert.equal(new URL(String(url)).origin, new URL(current.upstream.baseUrl).origin);
            const headers = new Headers(init?.headers), execution = contexts.getStore();
            if (execution) headers.set("x-ling-live-run-id", execution.runId);
            return fetch(url, { ...init, headers });
          },
        }),
      });
    }
  }

  async function createScenario({ holdReturn = false, port = 0 } = {}) {
    const directory = await mkdtemp(join(root, "scenario-"));
    const s = { directory, cwd: join(directory, "repository"), worktreeRoot: join(directory, "worktrees"),
      holdReturn, executions: new Map(), providerRequests: [], errors: [], providerGates: branches.map(deferred), hostGates: branches.map(deferred) };
    current = s;
    if (!holdReturn) for (const gate of s.hostGates) gate.resolve();
    await Promise.all([mkdir(s.cwd), mkdir(s.worktreeRoot)]);
    s.git = async (...args) => (await exec("/usr/bin/git", args, { cwd: s.cwd, env: process.env })).stdout.trim();
    await s.git("init", "--initial-branch=main");
    await writeFile(join(s.cwd, ".gitignore"), "*\n!.gitignore\n!left.txt\n!right.txt\n");
    for (const branch of branches) await writeFile(join(s.cwd, branch.path), `initial ${branch.path}\n`);
    await s.git("add", "--", ".gitignore", ...branches.map(branch => branch.path));
    await s.git("commit", "-m", "initial isolated live inputs");
    s.target = async () => ({ head: await s.git("rev-parse", "HEAD"),
      status: await s.git("status", "--porcelain=v1", "--untracked-files=all"),
      files: await Promise.all(branches.map(branch => readFile(join(s.cwd, branch.path), "utf8"))) });
    s.initialTarget = await s.target();
    s.upstream = await startProvider(async (body, runId) => {
      s.providerRequests.push({ runId, body });
      if (!body.stream) return { text: "Static loopback provider check OK." };
      const system = body.messages.filter(message => ["system", "developer"].includes(message.role)).map(messageText).join("\n");
      if (/context segmentation policy proposer/i.test(system)) return { text: JSON.stringify({ action: "uncertain", candidateSegmentIds: [] }) };
      if (/terminal report synthesizer/i.test(system)) {
        const snapshot = body.messages.map(messageText).join("\n").match(/Evidence snapshot: (\{[^\n]+\})/u)?.[1];
        assert.ok(snapshot, "Report must receive real Host evidence");
        return { text: JSON.stringify(core.buildDeterministicTerminalReportContent(JSON.parse(snapshot))) };
      }
      const index = branches.findIndex((_, index) => s.executions.get(index)?.runId === runId);
      assert.ok(index >= 0, "Provider request must belong to an original workflow Run");
      const execution = s.executions.get(index), branch = branches[index];
      execution.requests.push(body);
      assert.deepEqual((body.tools ?? []).map(tool => tool.function.name), ["write"]);
      if (execution.requests.length === 1) {
        assert.equal(execution.writes.length, 0, "Only the original request may dispatch a write");
        return { tool: "write", input: { path: branch.path, content: branch.content } };
      }
      if (execution.requests.length > 2) {
        assert.ok(execution.reached, "Only a held post-write response may be retried");
        assert.deepEqual(body, execution.requests[1], "Provider retry must replay the identical post-write request");
      }
      assert.equal(execution.sdkSettled, false, "Provider retry cannot outlive its original SDK execution");
      assert.equal(execution.writes.length, 1);
      assert.notEqual(execution.writes[0].result.isError, true);
      assert.equal(body.messages.filter(message => message.role === "tool").length, 1, "SDK must consume the actual Host result");
      execution.reached = true;
      await s.providerGates[index].promise;
      return { text: `${branch.name} finished its isolated Host write.` };
    }, error => s.errors.push(error.stack ?? String(error)));
    s.open = async daemonPort => {
      const denySecrets = () => { throw new Error("Live fixture forbids external credential access"); };
      s.daemon = createDaemonServer({ host: "127.0.0.1", port: daemonPort, defaultWorkspaceCwd: s.cwd,
        transports: { localWebSocketRpc: false }, harness: { toolBroker: { mode: "enforce" } },
        channels: { autoRoute: false, intentSelector: false, terminalReports: true, teamObserverBus: false, workflowIsolatedFiles: true },
        cuaDriver: { bundledEmbedded: { darwin: false, win32: false }, packagedProvider: { darwin: false, win32: false } },
      }, { runner: new LivePiRunner(), chromeBrowserNativeMessagingEnabled: false,
        secretResolver: core.createCompositeSecretResolver({ env: { LING_TEST_LOOPBACK_KEY: "static-loopback-only" } }),
        externalSecretStore: { status: denySecrets, resolve: denySecrets, setSecret: denySecrets, deleteSecret: denySecrets },
        storeFactory(cwd) { assert.equal(cwd, s.cwd, "Only the temporary fixture workspace may be opened");
          s.store = core.createSqliteRunStore(cwd); return s.store; },
      });
      await s.daemon.start();
      s.url = `http://127.0.0.1:${s.daemon.server.address().port}`;
    };
    s.api = async (path, body, method = body === undefined ? "GET" : "POST") => {
      const response = await fetch(`${s.url}${path}${path.includes("?") ? "&" : "?"}cwd=${encodeURIComponent(s.cwd)}`, {
        method, signal: AbortSignal.timeout(45_000), ...(body === undefined ? {} : {
          headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      });
      const value = await response.json();
      assert.ok(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(value)}`); return value;
    };
    await s.open(port);
    const provider = (await s.api("/providers", { kind: "glm", displayName: "P3 live loopback Pi", providerId: "loopback-static",
      model: "static-tools", api: "openai-completions", baseUrl: s.upstream.baseUrl, apiKeyRef: "env:LING_TEST_LOOPBACK_KEY",
      capabilities: ["chat", "tool_call"], input: ["text"], authHeader: false, reasoning: false, enabled: true })).provider;
    s.store.recordProviderCheckResult(provider.id, { ok: true, code: "ready", message: "Fixture scripted loopback readiness", checkedAt: now() });
    await s.api("/approval-policy", { toolDecisions: { write: "ask" } }, "PATCH");
    for (const branch of branches) await s.api(`/teammates/${branch.participantId}`, { providerPresetId: provider.id, allowedTools: ["write"] }, "PATCH");
    s.channel = (await s.api("/channels", { name: "P3 live isolated writing siblings", status: "active", boundPath: s.cwd,
      defaultProviderPresetId: provider.id, allowedTools: ["write"], autoReplyMode: "mentions_only",
      runtimePolicy: { maxConcurrentRuns: 2, schedulingMode: "smart", writeLockScope: "boundPath", allowReadOnlyParallel: false, queueOnConflict: true } })).channel;
    await s.api(`/channels/${s.channel.id}/workspace/cleanup`, {});
    await s.api(`/channels/${s.channel.id}/workspace/handoff`, { mode: "local" });
    for (const branch of branches) await s.api(`/teammates/${branch.participantId}/channels`, { memberships: [{ channelId: s.channel.id }] }, "PUT");
    s.source = appendChannelItemFixture(s.store, { channelId: s.channel.id, authorType: "local-user",
      body: "Write both isolated files and retain the target until approved." }, now());
    const graph = { schemaVersion: 1, id: "live-isolated", name: "Two independent writing siblings", entryNodeId: "left",
      nodes: branches.map(branch => ({ id: branch.id, kind: "step", name: branch.name, prompt: `Write ${branch.path}.`, sideEffectClass: "workspace_write" })),
      edges: [], termination: { success: "all_required_succeeded", onFailedRequiredNode: "block_for_user", onApprovalDenied: "block_for_user" } };
    s.workflow = s.store.createChannelWorkflow({ channelId: s.channel.id, title: "P3 live Pi Host isolated writes", objective: "Fan in two owned writes",
      status: "ready", createdBy: "local-user", metadata: { maxParallelSteps: 2, workflowGraph: graph,
        workflowGraphFingerprint: workflowGraphFingerprintV1(graph), sourceMessageId: s.source.id, sourceTurnId: s.source.turnId } }, now());
    s.steps = branches.map((branch, position) => s.store.createChannelWorkflowStep({ workflowId: s.workflow.id, title: branch.name,
      prompt: `Write ${branch.path}.`, position, toParticipantId: branch.participantId, toParticipantLabel: branch.name,
      metadata: { autoStart: true, dependsOnStepIds: [], providerPresetId: provider.id, requestedRunnerId: "pi", requiredTools: ["write"],
        sideEffectClass: "workspace_write", maxParallelSiblings: 2, sourceMessageId: s.source.id,
        parallelPolicy: { autoParallel: true, maxParallelSiblings: 2, resourceKeys: [] } } }, now()));
    s.roundId = "live-isolated-round";
    // Freeze an internal apply-to-target plan; the browser still owns actual start and all approvals.
    s.planned = await planWorkflowIsolatedRound({ store: s.store, workflowId: s.workflow.id, roundId: s.roundId,
      worktreeRoot: s.worktreeRoot, mode: "apply_to_target", parallelExecution: {
        profile: "isolated_siblings_v1", maxConcurrentSteps: 2, writeLockScope: "boundPath" },
      validationRequirements: WORKFLOW_CANDIDATE_VALIDATORS.map(({ id, fingerprint }) => ({ id, fingerprint })) });
    return s;
  }

  function manifest() {
    const s = current, source = s.store.getConversationItem(s.source.id);
    const scope = `cwd=${encodeURIComponent(s.cwd)}`;
    return { kind: "workflow-isolation-live-fixture", pid: process.pid, daemonUrl: s.url, daemonAuthToken: "",
      workspaceCwd: s.cwd, workspaceId: source.workspaceId, channelId: s.channel.id, workflowId: s.workflow.id,
      threadId: source.threadId, sourceTurnId: source.turnId, sourceMessageId: source.id,
      stepIds: Object.fromEntries(branches.map((branch, index) => [branch.id, s.steps[index].id])), roundId: s.roundId,
      providerBaseUrl: s.upstream.baseUrl, holdReturn: s.holdReturn,
      databasePath: s.store.database.prepare("PRAGMA database_list").all().find(row => row.name === "main")?.file,
      control: { url: `http://127.0.0.1:${control.address().port}`, token, authorization: `Bearer ${token}`,
        read: ["GET /status", "GET /evidence", "GET /check?kind=parallel"], write: "POST /control (JSON command)" },
      api: { snapshot: `${s.url}/control-plane/snapshot?${scope}`,
        sse: `${s.url}/control-plane/stream?${scope}&afterSeq=0&domains=runs,work_units,approvals,artifacts`,
        workflowEvidence: `${s.url}/workflows/${s.workflow.id}/evidence?${scope}`,
        sourceTurns: `${s.url}/threads/${source.threadId}/turns?${scope}` },
      web: { workspaceStorageKey: "ling-stack.workspaceCwd", websocketRpc: false },
      limits: ["Scripted provider, real Pi SDK/Host/Git/SQLite; no real model or credentials.",
        "Internally preplanned apply_to_target; not public execution-profile selection.", "Browser start/approve/cancel/reload and SSE evidence belong to the caller."] };
  }

  async function status(full = false) {
    const s = current, isolation = core.createSqliteWorkflowIsolationStore(s.store);
    const runs = s.store.listRuns({ limit: 100 }).map(run => {
      const unit = run.workUnitId ? s.store.getWorkUnit(run.workUnitId) : undefined;
      const attempt = unit?.activeAttemptId ? s.store.getWorkUnitAttempt(unit.activeAttemptId) : undefined;
      const fence = attempt ? core.toRuntimeAttemptFence(attempt) : undefined;
      const binding = fence ? isolation.getExecutionBinding(core.workflowIsolationDigest({ runId: run.id, ...fence }, "wib_")) : undefined;
      return { run, attempt, binding, completion: fence ? s.store.getHostAttemptCompletion({ runId: run.id, ...fence }) : undefined,
        terminalIntent: binding ? isolation.getTerminalResultIntent(binding.bindingId) : undefined,
        slots: unit ? s.store.listRuntimeSemaphoreSlots({ workUnitId: unit.id, status: "active", limit: 100 }) : [],
        ...(full ? { toolExecutions: s.store.listHarnessToolExecutions(run.id), artifacts: s.store.listArtifacts(run.id),
          events: s.store.listEvents(run.id, { afterSeq: 0, limit: 1000 }) } : {}) };
    });
    return { manifest: manifest(), workflow: s.store.getChannelWorkflow(s.workflow.id),
      steps: s.steps.map(step => s.store.getChannelWorkflowStep(step.id)), sourceTurn: s.store.getLingTurn(s.source.turnId),
      target: await s.target(), initialTarget: s.initialTarget, round: isolation.getIntegrationRound(s.roundId),
      parent: s.store.database.prepare("SELECT * FROM workflow_parallel_parent_fences WHERE round_id=? AND generation=1").get(s.roundId),
      approvals: s.store.listApprovalRequests({ status: "pending", limit: 100 }), runs,
      executions: [...s.executions.values()].map(execution => ({ ...execution, requests: full ? execution.requests : execution.requests.length })),
      gates: branches.map((branch, index) => ({ branch: branch.id, providerReleased: s.providerGates[index].settled, hostReleased: s.hostGates[index].settled })),
      reports: s.store.listTerminalReports({ sourceKind: "workflow", sourceId: s.workflow.id, limit: 100 }), errors: s.errors,
      ...(full ? { workflowEvidence: await s.api(`/workflows/${s.workflow.id}/evidence`),
        sourceTurns: await s.api(`/threads/${s.store.getConversationItem(s.source.id).threadId}/turns`), providerRequests: s.providerRequests } : {}) };
  }

  async function check(kind) {
    const value = await status(), s = current;
    assert.deepEqual(value.errors, [], "Loopback provider has failed");
    if (kind === "ready") { assert.equal(value.workflow.status, "ready"); assert.equal(value.runs.length, 0); }
    else if (kind === "approvals") {
      assert.equal(value.approvals.filter(item => item.actionType === "write").length, 2);
      assert.equal(value.runs.filter(item => item.run.status === "waiting_for_approval").length, 2);
    } else if (kind === "parallel") {
      assert.equal(value.executions.length, 2);
      assert.ok(value.executions.every(item => item.reached && !item.returned && item.writes.length === 1));
      assert.ok(value.runs.every(item => item.run.status === "running" && item.slots.length > 0 && item.binding?.status === "ready"));
      assert.equal(new Set(value.runs.map(item => item.run.cwd)).size, 2);
      assert.equal(value.parent.state, "held");
      for (const [index, plan] of s.planned.plans.entries()) {
        assert.equal(await readFile(join(plan.executionRoot, branches[index].path), "utf8"), branches[index].content);
        assert.equal(await readFile(join(plan.executionRoot, branches[1 - index].path), "utf8"), `initial ${branches[1 - index].path}\n`);
      }
    } else if (kind === "cancelled" || kind === "retained") {
      assert.equal(value.workflow.status, "cancelled");
      assert.equal(value.runs.length, 2);
      assert.ok(value.runs.every(item => item.run.status === "cancelled"));
      assert.notEqual(value.round.phase, "applied");
      if (kind === "retained") {
        assert.equal(value.parent.state, "held");
        assert.ok(value.executions.every(item => !item.returned));
        assert.ok(value.runs.every(item => !item.completion?.drainedAt && item.slots.length > 0));
      }
    } else if (kind === "drained" || kind === "succeeded") {
      assert.equal(value.executions.length, 2);
      assert.ok(value.executions.every(item => item.returned));
      assert.ok(value.runs.every(item => item.completion?.drainedAt && item.slots.length === 0));
      if (kind === "succeeded") {
        assert.equal(value.workflow.status, "succeeded"); assert.equal(value.sourceTurn.status, "succeeded");
        assert.equal(value.round.phase, "applied"); assert.equal(value.parent.state, "released");
        assert.equal(value.target.head, value.round.candidate.commit); assert.equal(value.target.status, "");
        assert.deepEqual(value.target.files, branches.map(branch => branch.content));
        assert.equal(value.reports.length, 1); assert.ok(value.reports[0].resultItemId);
        assert.equal(value.reports[0].synthesisMode, "model");
        assert.equal(s.store.getConversationItem(value.reports[0].resultItemId).kind, "terminal_report");
      }
    } else throw new Error("kind must be ready, approvals, parallel, cancelled, retained, drained or succeeded");
    if (!["succeeded", "drained"].includes(kind)) assert.deepEqual(value.target, value.initialTarget, "Target must remain unchanged");
    return { ok: true, kind, workflowStatus: value.workflow.status, sourceTurnStatus: value.sourceTurn.status,
      parentState: value.parent?.state, returned: value.executions.map(item => item.returned) };
  }

  async function closeScenario() {
    const s = current;
    if (!s) return;
    for (const gate of [...s.providerGates, ...s.hostGates]) gate.resolve();
    try { await s.daemon?.stop({ waitForOwnedDrain: true }); }
    finally { await s.upstream?.close(); }
  }
  const shutdown = () => stopping ??= (async () => {
    try { await closeScenario(); if (control) await closeHttp(control); }
    finally { if (process.connected) process.disconnect(); }
  })();
  const dispatch = input => {
    const result = queue.then(async () => {
      assert.ok(input && typeof input === "object");
      if (input.op === "status") return status();
      if (input.op === "evidence") return status(true);
      if (input.op === "check") return check(input.kind);
      if (input.op === "release") {
        const branch = input.branch ?? "all", gate = input.gate ?? "provider";
        assert.ok(["left", "right", "all"].includes(branch)); assert.ok(["provider", "host", "all"].includes(gate));
        for (const [index, item] of branches.entries()) if (branch === "all" || branch === item.id) {
          if (gate !== "host") current.providerGates[index].resolve();
          if (gate !== "provider") current.hostGates[index].resolve();
        }
        return status();
      }
      if (input.op === "fresh" || input.op === "restart") {
        const before = await status();
        assert.ok(before.executions.every(item => item.returned), "Release and drain original Hosts before changing scenario");
        assert.ok(before.runs.every(item => item.completion?.drainedAt && item.slots.length === 0), "Original completion receipts must be drained");
        const port = Number(new URL(current.url).port);
        if (input.op === "restart") {
          assert.ok(["ready", "succeeded", "failed", "cancelled"].includes(before.workflow.status), "Restart requires a ready or terminal workflow");
          current.dispatchClosed = before.workflow.status !== "ready";
          await current.daemon.stop({ waitForOwnedDrain: true }); await current.open(port);
          await current.api(`/channels/${current.channel.id}/workflows`);
          assert.deepEqual(current.store.listRuns({ limit: 100 }).map(run => run.id).sort(), before.runs.map(item => item.run.id).sort(),
            "Restart must preserve original Runs without redispatch");
          assert.equal(current.store.getChannelWorkflow(current.workflow.id).status, before.workflow.status);
        } else {
          assert.equal(typeof (input.holdReturn ?? false), "boolean");
          await closeScenario(); await createScenario({ port, holdReturn: input.holdReturn ?? false });
        }
        return manifest();
      }
      if (input.op === "stop") { setImmediate(() => void shutdown().catch(error => { console.error(error); process.exitCode = 1; })); return { stopping: true }; }
      throw new Error("op must be status, evidence, check, release, fresh, restart or stop; start/approve/cancel belong to the UI");
    });
    queue = result.catch(() => undefined); return result;
  };
  process.on("message", async message => {
    try { const value = await dispatch(message.input); process.send?.({ id: message.id, value }); }
    catch (error) { process.send?.({ id: message.id, error: error.stack ?? String(error) }); }
  });
  process.once("disconnect", () => void shutdown());
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => void shutdown());
  try {
    await createScenario(options);
    control = createServer(async (request, response) => {
      try {
        assert.equal(request.headers.origin, undefined, "Control endpoint is not a browser API");
        assert.equal(request.headers.authorization, `Bearer ${token}`, "Fixture control token required");
        const url = new URL(request.url, "http://127.0.0.1");
        let input;
        if (request.method === "GET" && ["/status", "/evidence", "/check"].includes(url.pathname)) {
          input = { op: url.pathname.slice(1), kind: url.searchParams.get("kind") };
        } else {
          assert.equal(request.method, "POST"); assert.equal(url.pathname, "/control"); input = await readJson(request);
        }
        sendJson(response, 200, await dispatch(input));
      } catch (error) { sendJson(response, 409, { error: error.message }); }
    });
    await listen(control);
    process.send?.({ kind: "ready", value: manifest() });
  } catch (error) { await shutdown(); throw error; }
}

async function startProvider(respond, onError) {
  let sequence = 0;
  const server = createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/v1/models") return sendJson(response, 200, { object: "list", data: [{ id: "static-tools", object: "model" }] });
      assert.equal(request.method, "POST"); assert.equal(request.url, "/v1/chat/completions");
      const body = await readJson(request), id = ++sequence;
      const answer = await respond(body, request.headers["x-ling-live-run-id"]);
      if (response.destroyed) return;
      const delta = answer.tool ? { role: "assistant", tool_calls: [{ index: 0, id: `live-tool-${id}`, type: "function",
        function: { name: answer.tool, arguments: JSON.stringify(answer.input) } }] } : { role: "assistant", content: answer.text };
      const base = { id: `live-response-${id}`, object: "chat.completion.chunk", created: 1, model: "static-tools" };
      const finish = answer.tool ? "tool_calls" : "stop";
      if (!body.stream) return sendJson(response, 200, { ...base, object: "chat.completion", choices: [{ index: 0, message: delta, finish_reason: finish }] });
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const choice of [{ index: 0, delta, finish_reason: null }, { index: 0, delta: {}, finish_reason: finish }]) {
        response.write(`data: ${JSON.stringify({ ...base, choices: [choice] })}\n\n`);
      }
      response.end("data: [DONE]\n\n");
    } catch (error) { onError(error); if (!response.destroyed) sendJson(response, 500, { error: error.message }); }
  });
  await listen(server);
  return { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, close: () => closeHttp(server) };
}

function deferred() {
  let done, fail;
  const gate = { settled: false, promise: new Promise((resolve, reject) => { done = resolve; fail = reject; }),
    resolve(value) { gate.settled = true; done(value); }, reject(error) { fail(error); } };
  return gate;
}
async function bounded(promise, milliseconds, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
function messageText(message) { return typeof message.content === "string" ? message.content : (message.content ?? []).map(part => part.text ?? "").join("\n"); }
async function readJson(request) {
  const chunks = []; let size = 0;
  for await (const chunk of request) { size += chunk.length; assert.ok(size <= 4 * 1024 * 1024, "Fixture request too large"); chunks.push(Buffer.from(chunk)); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
function sendJson(response, code, value) { response.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); response.end(JSON.stringify(value)); }
function listen(server) { return new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); }); }
function closeHttp(server) { return new Promise((done, reject) => { server.close(error => error ? reject(error) : done()); server.closeAllConnections(); }); }

if (process.argv[1] && resolve(process.argv[1]) === filename) {
  if (process.argv[2] === "--fixture-child") {
    await startChild(process.argv[3], JSON.parse(process.argv[4]));
  } else {
    const fixture = await startWorkflowIsolationLiveFixture({ holdReturn: process.argv.includes("--hold-return") });
    console.log(JSON.stringify(fixture.manifest));
    const lines = createInterface({ input: process.stdin });
    void fixture.closed.then(() => lines.close());
    let commands = Promise.resolve();
    lines.on("line", line => { if (!line.trim()) return;
      commands = commands.then(async () => {
        try { const command = JSON.parse(line); console.log(JSON.stringify({ ok: true, value: await fixture.command(command) }));
          if (command.op === "stop") lines.close(); }
        catch (error) { console.log(JSON.stringify({ ok: false, error: error.message })); }
      });
    });
    for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { lines.close(); void fixture.close(); });
    await new Promise(done => lines.once("close", done));
    await commands;
    await fixture.close();
  }
}
