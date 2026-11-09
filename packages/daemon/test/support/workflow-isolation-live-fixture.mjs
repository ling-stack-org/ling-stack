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
const defaultBranches = [
  { id: "left", participantId: "teammate_builtin_engineer", name: "Engineer", path: "left.txt", content: "left through parallel Host\n" },
  { id: "right", participantId: "teammate_builtin_qa", name: "QA", path: "right.txt", content: "right through parallel Host\n" },
];

/** Runs the real daemon/SDK in a child with an explicit, credential-free environment. */
export async function startWorkflowIsolationLiveFixture({ holdReturn = false, port = 0, authoring = false,
  publicSelection = false, conflictRecovery = false } = {}) {
  assert.equal(typeof holdReturn, "boolean");
  assert.equal(typeof authoring, "boolean");
  assert.equal(typeof publicSelection, "boolean");
  assert.equal(typeof conflictRecovery, "boolean");
  publicSelection ||= conflictRecovery;
  assert.equal(authoring && publicSelection, false);
  assert.ok(Number.isInteger(port) && port >= 0 && port <= 65535);
  const root = await realpath(await mkdtemp(join(tmpdir(), "ling-workflow-live-")));
  await Promise.all(["home", "tmp", "state"].map(path => mkdir(join(root, path))));
  const child = fork(filename, ["--fixture-child", root, JSON.stringify({ holdReturn, port, authoring, publicSelection, conflictRecovery })], {
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
  const branches = options.publicSelection ? [{ id: "prepare", participantId: "teammate_builtin_architect", name: "Architect",
    path: "prepare.txt", content: "prepare through selected Host\n" }, ...defaultBranches] : defaultBranches;
  const conflictBranches = branches.map(branch => branch.id === "prepare" ? branch : {
    ...branch, path: "shared.txt", content: `${branch.id} through conflicting Host\n` });
  const repairBranches = branches.map(branch => branch.id === "prepare" ? branch : {
    ...branch, content: `${branch.id} through recovery Host\n` });
  const [core, { PiRunnerAdapter }, { stream }, { createDaemonServer }, { workflowGraphFingerprintV1 },
    { planWorkflowIsolatedRound }, { WORKFLOW_CANDIDATE_VALIDATORS }, { appendChannelItemFixture },
    { workflowIsolationIsDraining }] = await Promise.all([
    import("../../../core/dist/index.js"), import("../../../runner-pi/dist/index.js"),
    import("../../../runner-pi/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js"),
    import("../../dist/index.js"), import("@ling-stack/contracts"),
    import("../../dist/features/channels/workflow-isolation-planning.js"),
    import("../../dist/features/channels/workflow-candidate-validation.js"),
    import("../../../core/test/channel-conversation-fixture.mjs"),
    import("../../dist/features/channels/workflow-isolation-lifecycle.js"),
  ]);
  let current, control, stopping, queue = Promise.resolve();
  const token = randomBytes(24).toString("hex");
  const contexts = new AsyncLocalStorage();

  function workflowGates(s, workflowId) {
    let gates = s.workflowGates.get(workflowId);
    if (!gates) {
      gates = { provider: branches.map(deferred), host: branches.map(deferred) };
      if (!s.holdReturn) for (const gate of gates.host) gate.resolve();
      s.workflowGates.set(workflowId, gates);
    }
    return gates;
  }

  class LivePiRunner extends PiRunnerAdapter {
    async runTask(input) {
      const s = current, run = input.runId ? s.store.getRun(input.runId) : undefined;
      // Terminal report synthesis also uses the real SDK, without a persisted Run or branch gates.
      if (!run) return contexts.run(undefined, () => super.runTask(input));
      if (options.authoring) {
        const step = s.store.getChannelWorkflowStep(run.workflowStepId);
        const workflow = s.store.getChannelWorkflow(step.workflowId);
        assert.equal(workflow.metadata.templateCompilation.source, "registry");
        // No skill is bound: the frozen template grants no tools even though
        // the channel allows reads.
        assert.deepEqual(input.tools, []);
        assert.equal(input.readonlyToolsProfile, "host_readonly_v1");
        assert.equal(s.executions.has(run.id), false, "An authored step must dispatch only once");
        const execution = { runId: run.id, requests: [], sdkSettled: false, returned: false };
        s.executions.set(run.id, execution);
        try { return await contexts.run(execution, () => super.runTask(input)); }
        finally { execution.sdkSettled = true; execution.returned = true; }
      }
      const step = s.store.getChannelWorkflowStep(run.workflowStepId), workflowId = step?.workflowId;
      assert.ok(workflowId, "An isolated Run must belong to a workflow step");
      if (run.workflowId) assert.equal(run.workflowId, workflowId);
      assert.equal(s.dispatchClosedWorkflows.has(workflowId), false, "Retained workflow executions cannot redispatch after restart");
      const recovery = workflowId === s.workflow.id ? undefined
        : core.createSqliteWorkflowConflictRecoveryStore(s.store).getBySuccessor(workflowId);
      if (workflowId !== s.workflow.id) {
        assert.equal(options.conflictRecovery, true);
        assert.equal(recovery?.predecessor.workflowId, s.workflow.id, "Only the explicit conflict successor may execute");
        const selection = core.createSqliteWorkflowIsolationStore(s.store).getSelection(workflowId);
        assert.equal(selection?.phase, "ready");
        assert.equal(selection.roundId, recovery.successor.roundId);
        assert.equal(recovery.successor.generation, 1);
      }
      const index = workflowId === s.workflow.id ? s.steps.findIndex(item => item.id === step.id)
        : branches.findIndex(branch => branch.id === step.metadata?.graphNodeId);
      assert.ok(index >= 0 && run.workflowStepId);
      assert.equal(branches[index].participantId, run.teammateId);
      assert.equal(s.executions.has(run.id), false, "Each Run may dispatch only once");
      assert.ok(![...s.executions.values()].some(item => item.workflowId === workflowId && item.stepId === step.id),
        "Each workflow step owns one SDK execution");
      assert.ok([...s.executions.values()].filter(item => !item.returned).length < 2, "The fixture permits at most two active workflow Runs");
      assert.equal(input.isolatedToolsProfile, "host_isolated_files_v1");
      assert.deepEqual(input.tools, ["write"]);
      for (const key of ["mcpTools", "hostCapabilityTools", "mediaGenerationTools"]) assert.deepEqual(input[key], []);
      const branch = options.conflictRecovery ? (recovery ? repairBranches : conflictBranches)[index] : branches[index];
      const gates = workflowGates(s, workflowId);
      const execution = { workflowId, stepId: step.id, runId: run.id, branch: branch.id, sequence: recovery?.sequence ?? 0,
        roundId: core.createSqliteWorkflowIsolationStore(s.store).getSelection(workflowId)?.roundId ?? s.roundId,
        path: branch.path, content: branch.content, requests: [], writes: [], approvals: [],
        boundaryFailures: [], reached: false, sdkSettled: false, returned: false };
      s.executions.set(run.id, execution);
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
        await gates.host[index].promise;
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
            return fetch(url, { ...init, headers, redirect: "error" });
          },
        }),
      });
    }
  }

  async function createScenario({ holdReturn = false, port = 0 } = {}) {
    const directory = await mkdtemp(join(root, "scenario-"));
    const s = { directory, cwd: join(directory, "repository"), worktreeRoot: join(directory, "worktrees"),
      holdReturn, executions: new Map(), providerRequests: [], errors: [], workflowGates: new Map(), dispatchClosedWorkflows: new Set(),
      trackedPaths: [...branches.map(branch => branch.path), ...(options.conflictRecovery ? ["shared.txt"] : [])] };
    current = s;
    await Promise.all([mkdir(s.cwd), mkdir(s.worktreeRoot)]);
    s.git = async (...args) => (await exec("/usr/bin/git", args, { cwd: s.cwd, env: process.env })).stdout.trim();
    await s.git("init", "--initial-branch=main");
    await writeFile(join(s.cwd, ".gitignore"), `*\n!.gitignore\n${s.trackedPaths.map(path => `!${path}\n`).join("")}`);
    for (const path of s.trackedPaths) await writeFile(join(s.cwd, path), `initial ${path}\n`);
    await s.git("add", "--", ".gitignore", ...s.trackedPaths);
    await s.git("commit", "-m", "initial isolated live inputs");
    s.target = async () => ({ head: await s.git("rev-parse", "HEAD"),
      status: await s.git("status", "--porcelain=v1", "--untracked-files=all"),
      files: await Promise.all(s.trackedPaths.map(path => readFile(join(s.cwd, path), "utf8"))),
      ...(options.conflictRecovery ? { paths: s.trackedPaths } : {}) });
    s.initialTarget = await s.target();
    s.upstream = await startProvider(async (body, runId) => {
      const execution = s.executions.get(runId);
      s.providerRequests.push({ runId, workflowId: execution?.workflowId, stepId: execution?.stepId, body });
      if (!body.stream) return { text: "Static loopback provider check OK." };
      const system = body.messages.filter(message => ["system", "developer"].includes(message.role)).map(messageText).join("\n");
      if (/context segmentation policy proposer/i.test(system)) return { text: JSON.stringify({ action: "uncertain", candidateSegmentIds: [] }) };
      if (/terminal report synthesizer/i.test(system)) {
        const snapshot = body.messages.map(messageText).join("\n").match(/Evidence snapshot: (\{[^\n]+\})/u)?.[1];
        assert.ok(snapshot, "Report must receive real Host evidence");
        return { text: JSON.stringify(core.buildDeterministicTerminalReportContent(JSON.parse(snapshot))) };
      }
      if (options.authoring) {
        assert.ok(execution, "Only a user-started authored Run may reach the Provider");
        assert.deepEqual((body.tools ?? []).map(tool => tool.function.name), ["request_user_input"]);
        execution.requests.push(body);
        return { text: "Authored analysis completed through the original Pi SDK Run." };
      }
      assert.ok(execution, "Provider request must belong to an explicitly started workflow Run");
      const index = branches.findIndex(branch => branch.id === execution.branch), branch = branches[index];
      assert.ok(index >= 0);
      if (execution.sequence > 0) {
        const recovery = core.createSqliteWorkflowConflictRecoveryStore(s.store).getBySuccessor(execution.workflowId);
        assert.ok(body.messages.map(messageText).join("\n").includes(recovery.repairInstruction),
          "Successor SDK context must contain the explicit repair requirements");
      }
      execution.requests.push(body);
      assert.deepEqual((body.tools ?? []).map(tool => tool.function.name), ["write"]);
      if (execution.requests.length === 1) {
        assert.equal(execution.writes.length, 0, "Only the original request may dispatch a write");
        return { tool: "write", input: { path: execution.path, content: execution.content } };
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
      await workflowGates(s, execution.workflowId).provider[index].promise;
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
    const tools = options.authoring ? ["read"] : ["write"];
    for (const branch of branches) await s.api(`/teammates/${branch.participantId}`, { providerPresetId: provider.id, allowedTools: tools }, "PATCH");
    s.channel = (await s.api("/channels", { name: options.authoring ? "P4 live authored workflow" : "P3 live isolated writing siblings", status: "active", boundPath: s.cwd,
      defaultProviderPresetId: provider.id, allowedTools: tools, autoReplyMode: "mentions_only",
      runtimePolicy: { maxConcurrentRuns: 2, schedulingMode: "smart", writeLockScope: "boundPath", allowReadOnlyParallel: false, queueOnConflict: true } })).channel;
    await s.api(`/channels/${s.channel.id}/workspace/cleanup`, {});
    await s.api(`/channels/${s.channel.id}/workspace/handoff`, { mode: "local" });
    for (const branch of branches) await s.api(`/teammates/${branch.participantId}/channels`, { memberships: [{ channelId: s.channel.id }] }, "PUT");
    s.source = appendChannelItemFixture(s.store, { channelId: s.channel.id, authorType: "local-user",
      body: options.conflictRecovery ? "Write competing left and right changes to shared.txt in isolated branches; retain the target."
        : "Write both isolated files and retain the target until approved." }, now());
    if (options.authoring) return s;
    if (options.publicSelection) {
      const graph = { schemaVersion: 1, id: "live-public-selection", name: "Prepare then fork two isolated writes", entryNodeId: "prepare",
        maxParallelSteps: 2, nodes: branches.map(branch => ({ id: branch.id, kind: "step", name: branch.name,
          prompt: options.conflictRecovery ? `Perform the ${branch.id} isolated write according to the workflow objective.` : `Write ${branch.path}.`,
          teammateId: branch.participantId, requestedRunnerId: "pi", providerPresetId: provider.id,
          autoStart: true, requiredTools: ["write"], sideEffectClass: "workspace_write",
          parallelPolicy: { autoParallel: true, maxParallelSiblings: 2, resourceKeys: [] } })),
        edges: defaultBranches.map(branch => ({ id: `prepare-${branch.id}`, fromNodeId: "prepare", toNodeId: branch.id,
          condition: { kind: "all_succeeded" } })),
        termination: { success: "all_required_succeeded", onFailedRequiredNode: "block_for_user", onApprovalDenied: "block_for_user" } };
      const compiled = await s.api(`/channels/${s.channel.id}/workflows`, { workflowGraph: graph,
        title: "P3 live Pi Host isolated writes", objective: options.conflictRecovery
          ? "Create an isolated candidate with competing left and right edits to shared.txt; retain the target."
          : "Create an isolated candidate through the public profile",
        confirmUnsafeAutoStart: true });
      s.workflow = compiled.workflow;
      s.steps = branches.map(branch => compiled.workflowSteps.find(step => step.metadata.graphNodeId === branch.id));
      assert.ok(s.steps.every(Boolean));
      workflowGates(s, s.workflow.id);
      s.source = s.store.getConversationItem(s.workflow.metadata.sourceMessageId);
      assert.equal(core.createSqliteWorkflowIsolationStore(s.store).getSelection(s.workflow.id), undefined);
      assert.equal(s.store.listRuns({ limit: 100 }).length, 0);
      return s;
    }
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
    workflowGates(s, s.workflow.id);
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
    if (options.authoring) return { daemonUrl: s.url, workspaceCwd: s.cwd, channelId: s.channel.id,
      threadId: source.threadId, participantId: branches[0].participantId };
    return { kind: "workflow-isolation-live-fixture", pid: process.pid, daemonUrl: s.url, daemonAuthToken: "",
      workspaceCwd: s.cwd, workspaceId: source.workspaceId, channelId: s.channel.id, workflowId: s.workflow.id,
      threadId: source.threadId, sourceTurnId: source.turnId, sourceMessageId: source.id,
      stepIds: Object.fromEntries(branches.map((branch, index) => [branch.id, s.steps[index].id])), roundId: s.roundId ?? "",
      providerBaseUrl: s.upstream.baseUrl, holdReturn: s.holdReturn, publicSelection: options.publicSelection,
      conflictRecovery: options.conflictRecovery,
      databasePath: s.store.database.prepare("PRAGMA database_list").all().find(row => row.name === "main")?.file,
      control: { url: `http://127.0.0.1:${control.address().port}`, token, authorization: `Bearer ${token}`,
        read: ["GET /status", "GET /evidence", "GET /check?kind=parallel"], write: "POST /control (JSON command)",
        ...(options.conflictRecovery ? { scope: "release/check.workflowId defaults to the predecessor; successor gates are independent." } : {}) },
      api: { snapshot: `${s.url}/control-plane/snapshot?${scope}`,
        sse: `${s.url}/control-plane/stream?${scope}&afterSeq=0&domains=runs,work_units,approvals,artifacts`,
        workflowEvidence: `${s.url}/workflows/${s.workflow.id}/evidence?${scope}`,
        sourceTurns: `${s.url}/threads/${source.threadId}/turns?${scope}`,
        ...(options.conflictRecovery ? { conflictRecovery: `${s.url}/workflows/${s.workflow.id}/conflict-recovery?${scope}` } : {}) },
      ...(options.conflictRecovery ? { repairInstruction: "Write left to left.txt and right to right.txt; leave shared.txt unchanged.",
        writes: { predecessor: conflictBranches.map(({ id, path, content }) => ({ branch: id, path, content })),
          successor: repairBranches.map(({ id, path, content }) => ({ branch: id, path, content })) } } : {}),
      web: { workspaceStorageKey: "ling-stack.workspaceCwd", websocketRpc: false },
      limits: ["Scripted provider, real Pi SDK/Host/Git/SQLite; no real model or credentials.",
        options.publicSelection ? "Unselected until the browser explicitly requests candidate-only execution."
          : "Internally preplanned apply_to_target; not public execution-profile selection.",
        ...(options.conflictRecovery ? ["Recovery POST creates a candidate-only successor; GET is read-only; orchestration belongs to the caller."] : []),
        "Browser start/approve/cancel/reload and SSE evidence belong to the caller."] };
  }

  async function status(full = false) {
    const s = current, target = await s.target();
    // Git inspection yields; canonical publication and turn state must share one SQLite snapshot.
    const state = s.store.readSnapshot(() => statusSnapshot(s, target, full));
    if (!full || options.authoring) return state;
    return { ...state, ...(state.successor?.selection?.phase === "ready" ? { successor: { ...state.successor,
      workflowEvidence: await s.api(`/workflows/${state.successor.workflow.id}/evidence`) } } : {}),
      workflowEvidence: await s.api(`/workflows/${s.workflow.id}/evidence`),
      sourceTurns: await s.api(`/threads/${s.store.getConversationItem(s.source.id).threadId}/turns`), providerRequests: s.providerRequests };
  }

  function statusSnapshot(s, target, full) {
    if (options.authoring) {
      const workflows = s.store.listChannelWorkflows({ channelId: s.channel.id });
      return { workflows, steps: workflows.flatMap(workflow => s.store.listChannelWorkflowSteps({ workflowId: workflow.id, complete: true })),
        runs: s.store.listRuns({ limit: 100 }), approvals: s.store.listApprovalRequests({ status: "pending", limit: 100 }),
        templates: core.createSqliteWorkflowTemplateRegistryStore(s.store).list(),
        reports: workflows.flatMap(workflow => s.store.listTerminalReports({ sourceKind: "workflow", sourceId: workflow.id, limit: 100 })),
        executions: [...s.executions.values()].map(execution => ({ ...execution, requests: execution.requests.length })),
        target, initialTarget: s.initialTarget, errors: s.errors };
    }
    const predecessor = workflowSnapshot(s, s.workflow.id, full);
    const recovery = options.conflictRecovery
      ? core.createSqliteWorkflowConflictRecoveryStore(s.store).getByPredecessor(s.workflow.id) : undefined;
    return { manifest: manifest(), ...predecessor, target, initialTarget: s.initialTarget,
      ...(options.conflictRecovery ? { recovery,
        successor: recovery ? workflowSnapshot(s, recovery.successor.workflowId, full) : undefined } : {}), errors: s.errors };
  }

  function workflowSnapshot(s, workflowId, full) {
    const isolation = core.createSqliteWorkflowIsolationStore(s.store), selection = isolation.getSelection(workflowId);
    if (workflowId === s.workflow.id) s.roundId ??= selection?.roundId;
    const roundId = selection?.roundId ?? (workflowId === s.workflow.id ? s.roundId : undefined);
    const workflow = s.store.getChannelWorkflow(workflowId), source = s.store.getConversationItem(workflow.metadata.sourceMessageId);
    const steps = workflowId === s.workflow.id ? s.steps.map(step => s.store.getChannelWorkflowStep(step.id))
      : s.store.listChannelWorkflowSteps({ workflowId, complete: true });
    const stepIds = new Set(steps.map(step => step.id));
    const runs = s.store.listRuns({ limit: 100 }).filter(run => stepIds.has(run.workflowStepId)).map(run => {
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
    const runIds = new Set(runs.map(item => item.run.id)), gates = s.workflowGates.get(workflowId);
    return { workflow, steps, sourceTurn: s.store.getLingTurn(source.turnId), sourceMessage: source, selection,
      draining: workflowIsolationIsDraining(s.store, workflowId),
      round: roundId ? isolation.getIntegrationRound(roundId) : undefined,
      parent: roundId ? s.store.database.prepare("SELECT * FROM workflow_parallel_parent_fences WHERE round_id=? AND generation=1").get(roundId) : undefined,
      approvals: s.store.listApprovalRequests({ status: "pending", limit: 100 }).filter(approval => !options.conflictRecovery
        || runIds.has(approval.runId) || stepIds.has(approval.workflowStepId)
        || steps.some(step => step.metadata?.preStepApprovalId === approval.id)), runs,
      executions: [...s.executions.values()].filter(execution => execution.workflowId === workflowId)
        .map(execution => ({ ...execution, requests: full ? execution.requests : execution.requests.length })),
      gates: branches.map((branch, index) => ({ branch: branch.id, providerReleased: gates?.provider[index].settled ?? false,
        hostReleased: gates?.host[index].settled ?? !s.holdReturn })),
      reports: s.store.listTerminalReports({ sourceKind: "workflow", sourceId: workflowId, limit: 100 }) };
  }

  async function check(kind, workflowId = current.workflow.id) {
    const state = await status(), s = current;
    assert.deepEqual(state.errors, [], "Loopback provider has failed");
    const value = workflowId === s.workflow.id ? state : state.successor;
    assert.equal(value?.workflow.id, workflowId, "Check scope must be the predecessor or its retained successor");
    if (kind === "ready") { assert.equal(value.workflow.status, "ready"); assert.equal(value.runs.length, 0); }
    else if (kind === "approvals") {
      const expected = options.publicSelection && value.steps.find(step => step.metadata.graphNodeId === "prepare")?.status !== "succeeded" ? 1 : 2;
      assert.equal(value.approvals.filter(item => item.actionType === "write").length, expected);
      assert.equal(value.runs.filter(item => item.run.status === "waiting_for_approval").length, expected);
    } else if (kind === "parallel") {
      const executions = value.executions.filter(item => item.branch !== "prepare");
      const runs = value.runs.filter(item => executions.some(execution => execution.runId === item.run.id));
      assert.equal(executions.length, 2);
      assert.ok(executions.every(item => item.reached && !item.returned && item.writes.length === 1));
      assert.equal(runs.length, 2);
      assert.ok(runs.every(item => item.run.status === "running" && item.slots.length > 0 && item.binding?.status === "ready"));
      assert.equal(new Set(runs.map(item => item.run.cwd)).size, 2);
      assert.equal(value.parent.state, "held");
      for (const execution of executions) {
        const run = runs.find(item => item.run.id === execution.runId);
        assert.equal(await readFile(join(run.run.cwd, execution.path), "utf8"), execution.content);
        const other = executions.find(item => item !== execution);
        if (execution.path !== other.path) assert.equal(await readFile(join(run.run.cwd, other.path), "utf8"), `initial ${other.path}\n`);
      }
    } else if (kind === "cancelled" || kind === "retained") {
      assert.equal(value.workflow.status, "cancelled");
      assert.equal(value.runs.length, branches.length);
      assert.ok(value.runs.every(item => item.run.status === "cancelled"));
      assert.notEqual(value.round.phase, "applied");
      if (kind === "retained") {
        assert.equal(value.parent.state, "held");
        assert.ok(value.executions.every(item => !item.returned));
        assert.ok(value.runs.every(item => !item.completion?.drainedAt && item.slots.length > 0));
      }
    } else if (kind === "drained" || kind === "succeeded") {
      assert.equal(value.executions.length, branches.length);
      assert.ok(value.executions.every(item => item.returned));
      assert.ok(value.runs.every(item => item.completion?.drainedAt && item.slots.length === 0));
      if (kind === "succeeded") {
        assert.equal(value.workflow.status, "succeeded"); assert.equal(value.sourceTurn.status, "succeeded");
        assert.equal(value.parent.state, "released");
        if (value.round.inputs.mode === "candidate_only") {
          assert.equal(value.round.phase, "awaiting_approval"); assert.ok(value.round.candidate.validationDigest);
          assert.equal(value.round.outstandingApprovalId, undefined);
          assert.deepEqual(state.target, state.initialTarget, "Candidate-only execution retains the target");
          for (const execution of value.executions) {
            assert.equal(await s.git("show", `${value.round.candidate.commit}:${execution.path}`), execution.content.trim());
          }
          if (options.conflictRecovery) assert.equal(await s.git("show", `${value.round.candidate.commit}:shared.txt`), "initial shared.txt");
        } else {
          assert.equal(value.round.phase, "applied");
          assert.equal(state.target.head, value.round.candidate.commit); assert.equal(state.target.status, "");
          assert.deepEqual(state.target.files, branches.map(branch => branch.content));
        }
        assert.equal(value.reports.length, 1); assert.ok(value.reports[0].resultItemId);
        assert.equal(value.reports[0].synthesisMode, "model");
        assert.equal(s.store.getConversationItem(value.reports[0].resultItemId).kind, "terminal_report");
      }
    } else if (kind === "conflicted") {
      assert.equal(options.conflictRecovery, true); assert.equal(workflowId, s.workflow.id);
      assert.ok(["running", "blocked"].includes(value.workflow.status));
      assert.equal(value.round.phase, "conflicted"); assert.equal(value.round.reason, "workflow_integration.text_conflict");
      assert.equal(value.round.inputs.mode, "candidate_only"); assert.equal(value.parent.state, "held");
      assert.equal(value.executions.length, branches.length);
      assert.ok(value.steps.every(step => step.status === "succeeded"));
      assert.ok(value.executions.every(item => item.returned));
      assert.ok(value.runs.every(item => item.completion?.drainedAt && item.slots.length === 0));
      assert.equal(value.draining, false);
      assert.equal(state.recovery, undefined); assert.deepEqual(value.reports, []);
    } else if (kind === "recovery-ready") {
      assert.equal(options.conflictRecovery, true); assert.equal(workflowId, s.workflow.id);
      assert.equal(value.workflow.status, "failed"); assert.equal(value.round.phase, "conflicted");
      assert.equal(value.parent.state, "released");
      const { recovery, successor } = state;
      assert.equal(recovery.predecessor.workflowId, workflowId);
      assert.equal(recovery.successor.workflowId, successor.workflow.id);
      assert.notEqual(successor.workflow.id, workflowId); assert.notEqual(successor.round.roundId, value.round.roundId);
      assert.equal(successor.selection.phase, "ready"); assert.equal(successor.round.generation, 1);
      assert.equal(successor.round.inputs.mode, "candidate_only"); assert.equal(successor.workflow.status, "ready");
      assert.notEqual(successor.sourceTurn.id, value.sourceTurn.id); assert.notEqual(successor.sourceMessage.id, value.sourceMessage.id);
      assert.ok(successor.steps.every(step => step.status === "queued" && !step.runId && !step.taskId));
      assert.deepEqual(successor.runs, []); assert.deepEqual(successor.executions, []); assert.deepEqual(successor.reports, []);
    } else throw new Error("kind must be ready, approvals, parallel, cancelled, retained, drained, succeeded, conflicted or recovery-ready");
    if (!["succeeded", "drained"].includes(kind)) assert.deepEqual(state.target, state.initialTarget, "Target must remain unchanged");
    return { ok: true, kind, workflowId, workflowStatus: value.workflow.status, sourceTurnStatus: value.sourceTurn.status,
      parentState: value.parent?.state, returned: value.executions.map(item => item.returned) };
  }

  async function closeScenario() {
    const s = current;
    if (!s) return;
    for (const gates of s.workflowGates.values()) for (const gate of [...gates.provider, ...gates.host]) gate.resolve();
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
      if (input.op === "check") return check(input.kind, input.workflowId);
      if (input.op === "release") {
        const branch = input.branch ?? "all", gate = input.gate ?? "provider";
        assert.ok(["prepare", "left", "right", "all"].includes(branch)); assert.ok(["provider", "host", "all"].includes(gate));
        const workflowId = input.workflowId ?? current.workflow.id;
        if (workflowId !== current.workflow.id) {
          assert.equal(options.conflictRecovery, true);
          assert.equal(core.createSqliteWorkflowConflictRecoveryStore(current.store).getByPredecessor(current.workflow.id)?.successor.workflowId,
            workflowId, "Release scope must be the predecessor or its retained successor");
        }
        const gates = workflowGates(current, workflowId);
        for (const [index, item] of branches.entries()) if (branch === "all" || branch === item.id) {
          if (gate !== "host") gates.provider[index].resolve();
          if (gate !== "provider") gates.host[index].resolve();
        }
        return status();
      }
      if (input.op === "fresh" || input.op === "restart") {
        const before = await status();
        const scopes = [before, ...(before.successor ? [before.successor] : [])];
        assert.ok(scopes.every(scope => scope.executions.every(item => item.returned)), "Release and drain original Hosts before changing scenario");
        assert.ok(scopes.every(scope => scope.runs.every(item => item.completion?.drainedAt && item.slots.length === 0)),
          "Workflow completion receipts must be drained");
        const port = Number(new URL(current.url).port);
        if (input.op === "restart") {
          assert.ok(scopes.every(scope => ["ready", "succeeded", "failed", "cancelled"].includes(scope.workflow.status)
            || options.conflictRecovery && scope.round?.phase === "conflicted"), "Restart requires ready, terminal or drained conflicted workflows");
          for (const scope of scopes) if (scope.workflow.status !== "ready") current.dispatchClosedWorkflows.add(scope.workflow.id);
          await current.daemon.stop({ waitForOwnedDrain: true }); await current.open(port);
          await current.api(`/channels/${current.channel.id}/workflows`);
          assert.deepEqual(current.store.listRuns({ limit: 100 }).map(run => run.id).sort(),
            scopes.flatMap(scope => scope.runs.map(item => item.run.id)).sort(), "Restart must preserve workflow Runs without redispatch");
          for (const scope of scopes) assert.equal(current.store.getChannelWorkflow(scope.workflow.id).status, scope.workflow.status);
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
          input = { op: url.pathname.slice(1), kind: url.searchParams.get("kind"), workflowId: url.searchParams.get("workflowId") ?? undefined };
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
    const fixture = await startWorkflowIsolationLiveFixture({ holdReturn: process.argv.includes("--hold-return"),
      authoring: process.argv.includes("--authoring"), publicSelection: process.argv.includes("--public-selection"),
      conflictRecovery: process.argv.includes("--conflict-recovery") });
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
