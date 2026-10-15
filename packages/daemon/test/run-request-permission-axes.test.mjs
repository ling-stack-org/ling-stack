import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const caseEnv = "LING_A27_PERMISSION_AXES_CASE";
const TEAMMATE = "teammate_builtin_designer";
const REPLY = "A27 deterministic reply; no tools were executed.";
const TOOLS = ["read", "grep", "find", "ls", "bash", "edit", "write"];
const ASK_WRITE = { authorizationMode: "ask", workspaceAccessMode: "workspace_write", permissionPreset: "custom" };
const SMART_READ = { authorizationMode: "smart", workspaceAccessMode: "read_only", permissionPreset: "custom" };
const ASK_FULL = { authorizationMode: "ask", workspaceAccessMode: "full_access", permissionPreset: "custom" };
const cases = {};
for (const endpoint of ["collection", "sse"]) {
  // An independently selected authorization mode must override the legacy preset.
  cases[`direct-${endpoint}-workspace`] = f => directAxes(f, endpoint, {
    ...ASK_WRITE, permissionPreset: "workspace_collaboration",
  });
  cases[`direct-${endpoint}-full-access`] = f => directAxes(f, endpoint, {
    ...ASK_FULL, permissionPreset: "full_access", permissionConfirmation: confirmation(),
  });
}
for (const kind of ["conversation", "teammate_direct", "channel_discussion"]) {
  cases[`resume-${kind}-read-only`] = f => resumeAxes(f, kind, SMART_READ);
  cases[`resume-${kind}-ask-workspace`] = f => resumeAxes(f, kind, ASK_WRITE);
}
cases["resume-channel-full-access"] = f => resumeAxes(f, "channel_discussion", {
  ...ASK_FULL, permissionConfirmation: confirmation(),
});
cases["legacy-and-canonical"] = legacyAndCanonical;
cases["full-access-confirmation-fence"] = fullAccessFence;
cases["normal-prepared-retry-current-policy"] = preparedRetry;
cases["malformed-source-axis-rejected-before-input"] = malformedSource;
for (const kind of ["conversation", "teammate_direct", "channel_discussion"]) {
  cases[`fork-${kind}-read-only`] = f => forkAxes(f, kind);
}
cases["fork-conversation-full-access-receipt-not-reused"] = forkFullAccessFence;

const selected = process.env[caseEnv];
if (selected) assert.ok(Object.hasOwn(cases, selected), "only known owned-child cases may run");
for (const [label, exercise] of Object.entries(cases)) {
  if (!selected || selected === label) {
    test(`A27 permission axes HTTP integration ${label}`, { timeout: 60_000 }, t => ownedCase(t, label, exercise));
  }
}

/** Each real daemon runs in a fresh process with no ambient credentials or user paths. */
async function ownedCase(t, label, exercise) {
  if (selected) {
    const home = process.env.LING_STACK_HOME, cwd = process.env.LING_STACK_DEFAULT_WORKSPACE_CWD;
    for (const path of [home, cwd]) {
      assert.ok(path && isAbsolute(path) && resolve(path) === path && path !== "/" && path !== process.cwd());
      assert.equal((await stat(path)).isDirectory(), true);
    }
    assert.equal(dirname(home), dirname(cwd));
    assert.ok(basename(dirname(cwd)).startsWith(`ling-a27-${label}-`));
    assert.deepEqual(Object.keys(process.env).filter(key => /API_?KEY|TOKEN|SECRET|BASE_URL/iu.test(key)), []);
    const homeHook = t.mock.method(os, "homedir", () => home);
    syncBuiltinESMExports();
    const originalFetch = globalThis.fetch;
    let origin, fixture;
    const blockedFetches = [];
    globalThis.fetch = async function (input, init) {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      if (!origin || url.origin !== origin) {
        blockedFetches.push(`${url.origin}${url.pathname}`);
        throw new Error("A27 forbids non-owned HTTP requests");
      }
      return originalFetch.call(this, input, init);
    };
    try {
      // All product imports follow path, credential and network isolation.
      const core = await import("../../core/dist/index.js");
      const { createDaemonServer } = await import("../dist/index.js");
      const { prepareFixtureTaskInput } = await import("./support/prepared-input-fixture.mjs");
      fixture = createFixture({ core, createDaemonServer, prepareFixtureTaskInput, cwd,
        setOrigin: value => { origin = value; } });
      await fixture.start();
      console.log(`A27 actual HTTP fixture entered: ${label}`);
      await exercise(fixture);
    } finally {
      try {
        await fixture?.stop();
        assert.deepEqual(blockedFetches, [], "the fixture must never attempt a provider or other external HTTP request");
      } finally {
        globalThis.fetch = originalFetch;
        homeHook.mock.restore();
        syncBuiltinESMExports();
      }
    }
    return;
  }
  const tempRoot = await realpath(os.tmpdir());
  const root = await realpath(await mkdtemp(join(tempRoot, `ling-a27-${label}-`)));
  const home = join(root, "home"), cwd = join(root, "workspace");
  await mkdir(home); await mkdir(cwd);
  try {
    const child = spawn(process.execPath, ["--test", "--test-reporter=tap", fileURLToPath(import.meta.url)], {
      env: { PATH: process.env.PATH, LANG: "C.UTF-8", TZ: "UTC", LING_STACK_HOME: home,
        LING_STACK_DEFAULT_WORKSPACE_CWD: cwd, [caseEnv]: label },
      stdio: ["ignore", "pipe", "pipe"], timeout: 50_000,
    });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", value => { stdout += value; });
    child.stderr.on("data", value => { stderr += value; });
    const exit = await new Promise((done, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => done({ code, signal }));
    });
    process.stdout.write(stdout); process.stderr.write(stderr);
    console.log(`A27 child exit: ${JSON.stringify({ label, ...exit })}`);
    assert.ok(stdout.includes(`A27 actual HTTP fixture entered: ${label}`), "failure must not be an import/setup false RED");
    assert.equal(exit.signal, null, "the owned child must settle rather than be killed");
    assert.equal(exit.code, 0, `${label}: actual HTTP-to-SQLite permission regression failed`);
  } finally {
    assert.equal(dirname(root), tempRoot);
    assert.ok(basename(root).startsWith(`ling-a27-${label}-`));
    await rm(root, { recursive: true, force: true });
  }
}

/** No Provider transport, Git worktree, real tool execution or system Keychain is used. */
function createFixture({ core, createDaemonServer, prepareFixtureTaskInput, cwd, setOrigin }) {
  let daemon, store, provider, sequence = 0;
  const calls = [], preparations = [];
  const controls = { completeAssistantMessage: false };
  const databasePath = join(cwd, ".ling-stack", "ling-stack.sqlite");
  const secretResolver = core.createCompositeSecretResolver({ env: {} });
  const runner = {
    async prepareTaskInput(options) {
      const prepared = await prepareFixtureTaskInput(options);
      preparations.push(prepared);
      return prepared;
    },
    async runTask(options) {
      calls.push(options);
      await controls.onRun?.(options);
      options.onEvent?.({ type: "assistant_text_delta", text: REPLY });
      if (controls.completeAssistantMessage) options.onEvent?.({ type: "message_end", role: "assistant", text: REPLY });
      return { taskId: options.task.id, events: [], messages: [{ role: "assistant", content: REPLY }] };
    },
  };
  const f = {
    cwd, databasePath, calls, preparations, controls,
    get store() { return store; },
    get provider() { return provider; },
    nextKey: prefix => `${prefix}-${++sequence}`,
    sql: callback => withDatabase(databasePath, callback),
    async start() {
      assert.equal(daemon, undefined);
      store = undefined;
      daemon = createDaemonServer({
        host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd,
        channels: { autoRoute: false, intentSelector: false, terminalReports: false, teamObserverBus: false },
        cuaDriver: { bundledEmbedded: { darwin: false, win32: false }, packagedProvider: { darwin: false, win32: false } },
      }, {
        runner, secretResolver,
        externalSecretStore: { ...secretResolver,
          setSecret() { throw new Error("A27 forbids external secret writes"); },
          deleteSecret() { throw new Error("A27 forbids external secret deletes"); } },
        chromeBrowserNativeMessagingEnabled: false,
        storeFactory(storeCwd) {
          assert.equal(resolve(storeCwd), cwd, "only the owned workspace SQLite may open");
          assert.equal(store, undefined, "one live Store per daemon generation");
          store = core.createSqliteRunStore(storeCwd);
          assert.equal(store.paths.databasePath, databasePath);
          if (!provider) {
            const now = new Date().toISOString();
            provider = store.createProviderPreset({ kind: "openai-compatible", displayName: "A27 synthetic only",
              providerId: "a27-fixture", model: "a27-fixture", api: "openai-completions", authHeader: false,
              baseUrl: "https://fixture.invalid/v1", capabilities: ["chat"], input: ["text"], enabled: true,
              contextWindow: 128_000, maxTokens: 4096 }, now);
            store.recordProviderCheckResult(provider.id, { ok: true, code: "static_check",
              message: "A27 synthetic fixture; no Provider request", checkedAt: now });
            assert.ok(store.updateAiTeammate(TEAMMATE, { providerPresetId: provider.id, allowedTools: TOOLS,
              approvalProfile: { mode: "none" } }, now));
            const direct = store.getOrCreateTeammateDirectThread(TEAMMATE, now);
            store.updateTeammateDirectThreadWorkspace(direct.id, { mode: "local", status: "ready", executionPath: cwd,
              createdAt: now, checkedAt: now, updatedAt: now }, now);
          }
          return store;
        },
      });
      await daemon.start();
      const address = daemon.server.address();
      assert.ok(address && typeof address === "object");
      f.origin = `http://127.0.0.1:${address.port}`;
      setOrigin(f.origin);
      assert.ok(store);
    },
    async stop() {
      if (daemon) {
        const closing = daemon;
        daemon = undefined;
        await closing.stop();
      }
    },
    async request(path, method = "GET", body) {
      const url = new URL(path, f.origin);
      url.searchParams.set("cwd", cwd);
      return fetch(url, { method, ...(body === undefined ? {} : {
        headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      }), signal: AbortSignal.timeout(15_000) });
    },
    async json(path, method = "GET", body) {
      const response = await f.request(path, method, body);
      const data = await response.json();
      return { status: response.status, body: data };
    },
  };
  return f;
}

async function directRequest(f, endpoint, selection) {
  const path = `/teammates/${encodeURIComponent(TEAMMATE)}/direct-messages${endpoint === "sse" ? "/stream" : ""}`;
  const response = await f.request(path, "POST", { body: `A27 synthetic private request ${f.nextKey(endpoint)}`,
    providerPresetId: f.provider.id, requestAiReply: true, ...selection });
  if (endpoint === "collection") {
    const body = await response.json();
    assert.equal(response.status, 201, JSON.stringify(body));
    return { reply: body.aiReply, events: [] };
  }
  const text = await response.text();
  assert.equal(response.status, 200, text);
  const events = parseSse(text);
  const terminal = events.findLast(event => ["done", "blocked", "error"].includes(event.event));
  assert.ok(terminal?.data.aiReply, text);
  return { reply: terminal.data.aiReply, events };
}

async function directAxes(f, endpoint, selection) {
  const { reply, events } = await directRequest(f, endpoint, selection);
  assert.equal(reply.status, "ready", JSON.stringify(reply));
  assert.equal(reply.body, REPLY);
  assert.ok(reply.linkedRunId);
  assert.equal(f.calls.length, 1, "a blocked reply must not satisfy the success case");
  if (endpoint === "sse") {
    assert.deepEqual(events.map(event => event.event), ["ready", "run_linked", "delta", "done"]);
    assert.equal(events[1].data.linkedRunId, reply.linkedRunId);
    assert.equal(events[2].data.delta, REPLY);
  }
  const run = await persistedRun(f, reply.linkedRunId);
  assertAxes(run.requestSnapshot, selection);
  assertPolicy(run.requestSnapshot.effectivePolicySnapshot, selection, {
    bash: "ask", edit: "ask", write: "ask",
  }, selection.workspaceAccessMode === "full_access" ? ["/"] : [f.cwd]);
  assert.deepEqual(run.requestSnapshot.permissionConfirmation, selection.permissionConfirmation);
  assert.equal(run.requestSnapshot.directWorkspaceBinding.mode, "local");
  assert.equal(run.requestSnapshot.directWorkspaceBinding.status, "ready");
}

/** The source itself is dispatched over HTTP, not a hand-authored persisted snapshot. */
async function sourceRun(f, kind, selection, { approvalProfile } = {}) {
  if (kind === "conversation") {
    const response = await f.request("/conversations/stream", "POST", { message: "A27 original normal input",
      providerPresetId: f.provider.id, tools: TOOLS, idempotencyKey: f.nextKey("normal-source"), ...selection });
    const text = await response.text();
    assert.equal(response.status, 200, text);
    const done = parseSse(text).findLast(event => event.event === "done");
    assert.ok(done?.data.run?.id, text);
    const run = await persistedRun(f, done.data.run.id);
    const acceptedSource = run.requestSnapshot.normalConversationContext.hydration.source;
    assert.equal(acceptedSource.threadId, run.threadId);
    assert.equal(acceptedSource.turnId, f.store.getLingTurnForRun(run.id).id);
    assert.ok(f.store.getConversationItem(acceptedSource.itemId));
    return run;
  }
  const now = new Date().toISOString();
  const channel = kind === "channel_discussion" ? f.store.createChannel({ name: "A27 channel",
    boundPath: f.cwd, allowedTools: TOOLS, defaultProviderPresetId: f.provider.id, autoReplyMode: "mentions_only" }, now) : undefined;
  const thread = f.store.createLingThread({ kind, channelId: channel?.id, teammateId: kind === "teammate_direct" ? TEAMMATE : undefined,
    title: `A27 ${kind}`, objective: "Preserve independent source permissions" }, now);
  const taskId = f.nextKey("source-task");
  const response = await f.request("/runs", "POST", { cwd: f.cwd, workspaceCwd: f.cwd, threadId: thread.id,
    teammateId: kind === "teammate_direct" ? TEAMMATE : undefined, providerPresetId: f.provider.id,
    task: { id: taskId, title: taskId, prompt: "A27 synthetic source", channelId: channel?.id }, tools: TOOLS,
    approvalProfile: approvalProfile ?? { mode: "none" }, idempotencyKey: f.nextKey("source-run"), ...selection });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  const ready = parseSse(text).find(event => event.event === "ready" && event.data.runId);
  assert.ok(ready?.data.runId, text);
  const run = await persistedRun(f, ready.data.runId);
  assert.equal(run.threadId, thread.id);
  return run;
}

async function resume(f, source, body = {}) {
  return f.json(`/threads/${encodeURIComponent(source.threadId)}/resume`, "POST", {
    sourceRunId: source.id, instruction: "A27 manual continuation", idempotencyKey: f.nextKey("resume"), ...body,
  });
}

async function resumeAxes(f, kind, selection) {
  const source = await sourceRun(f, kind, selection);
  assertAxes(source.requestSnapshot, selection);
  const sourceBefore = structuredClone(source.requestSnapshot);
  const result = await resume(f, source);
  assert.equal(result.status, 202, JSON.stringify(result.body));
  assert.equal(result.body.sourceRun.id, source.id);
  assert.equal(result.body.continuationReason, "manual_resume");
  const run = await persistedRun(f, result.body.runId);
  assert.equal(f.calls.length, 2);
  assert.equal(run.parentRunId, source.id);
  assert.equal(run.continuationReason, "manual_resume");
  assert.equal(run.threadId, source.threadId);
  assertAxes(run.requestSnapshot, selection);
  const readOnly = selection.workspaceAccessMode === "read_only";
  assertPolicy(run.requestSnapshot.effectivePolicySnapshot, selection,
    { bash: readOnly ? "deny" : "ask", edit: readOnly ? "deny" : "ask", write: readOnly ? "deny" : "ask" },
    readOnly ? [] : selection.workspaceAccessMode === "full_access" ? ["/"] : [f.cwd]);
  assert.deepEqual(run.requestSnapshot.permissionConfirmation, selection.permissionConfirmation);
  assert.deepEqual(f.store.getRun(source.id).requestSnapshot, sourceBefore, "resume must not rewrite the source authority");
  if (kind === "conversation") assertPreparedRequest(f, run, selection);
}

async function legacyAndCanonical(f) {
  // Legacy read_only means ask_everything, NOT the new first-class hard read-only policy.
  const legacy = await directRequest(f, "collection", { permissionPreset: "read_only" });
  assert.equal(legacy.reply.status, "ready", JSON.stringify(legacy.reply));
  const oldRun = await persistedRun(f, legacy.reply.linkedRunId);
  assert.equal(oldRun.requestSnapshot.authorizationMode, undefined);
  assert.equal(oldRun.requestSnapshot.workspaceAccessMode, undefined);
  assertPolicy(oldRun.requestSnapshot.effectivePolicySnapshot,
    { authorizationMode: "ask", workspaceAccessMode: "read_only" }, { bash: "ask", edit: "ask", write: "ask" }, ["."]);
  const oldResumed = await resume(f, oldRun);
  assert.equal(oldResumed.status, 202, JSON.stringify(oldResumed.body));
  const legacyResume = await persistedRun(f, oldResumed.body.runId);
  assert.equal(legacyResume.requestSnapshot.authorizationMode, undefined);
  assert.equal(legacyResume.requestSnapshot.workspaceAccessMode, undefined);
  assert.deepEqual(legacyResume.requestSnapshot.effectivePolicySnapshot, oldRun.requestSnapshot.effectivePolicySnapshot);

  const canonical = { authorizationMode: "smart", workspaceAccessMode: "workspace_write", permissionPreset: "workspace_collaboration" };
  const source = await sourceRun(f, "channel_discussion", canonical, {
    approvalProfile: { mode: "strict", requiredForTools: ["edit"] },
  });
  const result = await resume(f, source);
  assert.equal(result.status, 202, JSON.stringify(result.body));
  const run = await persistedRun(f, result.body.runId);
  assertAxes(run.requestSnapshot, canonical);
  assert.deepEqual(run.requestSnapshot.approvalProfile, source.requestSnapshot.approvalProfile);
  assertPolicy(run.requestSnapshot.effectivePolicySnapshot, canonical, { bash: "ask", edit: "ask", write: "ask" }, [f.cwd]);
  assert.equal(f.calls.length, 4);
}

async function fullAccessFence(f) {
  for (const endpoint of ["collection", "sse"]) {
    for (const permissionPreset of ["custom", "full_access"]) {
      const before = facts(f);
      const { reply, events } = await directRequest(f, endpoint, { ...ASK_FULL, permissionPreset });
      assert.equal(reply.status, "blocked", JSON.stringify(reply));
      assert.match(reply.errorMessage, /Full access runs require explicit permission confirmation/);
      assert.equal(reply.linkedRunId, undefined);
      assert.equal(f.calls.length, 0, "a Full Access request without confirmation must not reach the Runner");
      assert.equal(facts(f).runs, before.runs);
      assert.equal(facts(f).workUnits, before.workUnits);
      if (endpoint === "sse") assert.deepEqual(events.map(event => event.event), ["ready", "blocked"]);
    }
  }
}

/** Synthetic pre-Run dispatch failure, not a claim of real process-crash/recovery coverage. */
async function preparedRetry(f) {
  const source = await sourceRun(f, "conversation", ASK_WRITE);
  const body = { sourceRunId: source.id, instruction: "A27 frozen retry", idempotencyKey: "a27-stable-retry" };
  const beforePreview = facts(f);
  const preview = await f.json(`/threads/${encodeURIComponent(source.threadId)}/resume-preview`, "POST", body);
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.equal(preview.body.sourceRun.id, source.id);
  assert.deepEqual(facts(f), beforePreview, "preview cannot dispatch, accept a new input, or persist preparation");
  assert.equal(f.calls.length, 1);

  const createWorkUnit = f.store.createWorkUnit;
  let faultReached = false;
  f.store.createWorkUnit = function () {
    faultReached = true;
    throw new Error("A27 synthetic stop after preparation, before WorkUnit/Run creation");
  };
  let failed;
  try { failed = await resume(f, source, body); }
  finally { f.store.createWorkUnit = createWorkUnit; }
  assert.equal(faultReached, true, JSON.stringify(failed));
  assert.equal(failed.status, 500, JSON.stringify(failed.body));
  assert.equal(failed.body.error, "resume_start_failed");
  assert.equal(facts(f).runs, beforePreview.runs);
  assert.equal(facts(f).workUnits, beforePreview.workUnits);
  assert.equal(f.calls.length, 1);
  const turn = f.store.listLingTurns({ threadId: source.threadId }).find(value => value.userInstruction === body.instruction);
  assert.ok(turn?.sourceItemId);
  const request = f.store.getConversationPreparedInput(turn.sourceItemId, "request");
  const execution = f.store.getConversationPreparedInput(turn.sourceItemId, "execution");
  assert.ok(request && execution, "both preparations must really precede the injected failure");
  assertAxes(request.payload.request, ASK_WRITE);
  assert.equal(execution.parentSnapshotId, request.id);
  const originalPreparationCount = f.preparations.length;
  await f.stop();
  await f.start();
  assert.deepEqual(f.store.getConversationPreparedInput(turn.sourceItemId, "request"), request);
  assert.deepEqual(f.store.getConversationPreparedInput(turn.sourceItemId, "execution"), execution);
  const tightened = await f.json("/approval-policy", "PATCH", { toolDecisions: { read: "deny", edit: "deny", write: "allow", bash: "allow" } });
  assert.equal(tightened.status, 200, JSON.stringify(tightened.body));
  let hostDecision;
  f.controls.onRun = async options => {
    // Exercise the actual Host approval handler without executing a tool or reading this path.
    hostDecision = await options.onApprovalRequired({ toolCallId: "a27-denied-read", toolName: "read",
      input: { path: "a27-never-read.txt" }, task: options.task, cwd: f.cwd, defaultApproval: "allow" });
  };
  const retry = await resume(f, source, body);
  assert.equal(retry.status, 202, JSON.stringify(retry.body));
  const run = await persistedRun(f, retry.body.runId);
  assertAxes(run.requestSnapshot, ASK_WRITE);
  assertPolicy(run.requestSnapshot.effectivePolicySnapshot, ASK_WRITE, { read: "deny", edit: "deny", write: "ask", bash: "ask" }, [f.cwd]);
  assert.equal(run.requestSnapshot.effectivePolicySnapshot.workspacePolicyUpdatedAt, tightened.body.policy.updatedAt);
  assert.equal(hostDecision?.approved, false, "prepared input cannot bypass a current workspace deny at the Host gate");
  assertPreparedRequest(f, run, ASK_WRITE);
  assert.deepEqual(f.store.getConversationPreparedInput(turn.sourceItemId, "request"), request);
  assert.deepEqual(f.store.getConversationPreparedInput(turn.sourceItemId, "execution"), execution);
  assert.equal(f.preparations.length, originalPreparationCount, "a no-Run retry must consume the persisted prepared SDK input");
  assert.deepEqual(f.calls.at(-1).preparedInput, execution.payload.preparedInput);
  const beforeDuplicate = facts(f);
  const duplicate = await resume(f, source, body);
  assert.equal(duplicate.status, 202, JSON.stringify(duplicate.body));
  assert.equal(duplicate.body.runId, run.id);
  assert.equal(f.calls.length, 2, "the identical HTTP retry must not execute again");
  assert.deepEqual(facts(f), beforeDuplicate);
}

async function malformedSource(f) {
  const source = await sourceRun(f, "conversation", ASK_WRITE);
  for (const [field, invalid] of [["authorizationMode", "a27_invalid_authorization"], ["workspaceAccessMode", "a27_invalid_access"]]) {
    const corrupted = { ...source.requestSnapshot, [field]: invalid };
    // Deliberate corruption of this owned fixture only. Public request parsers cannot create it.
    const db = new DatabaseSync(f.databasePath);
    try {
      assert.equal(db.prepare("UPDATE run_sessions SET request_snapshot_json=? WHERE id=?")
        .run(JSON.stringify(corrupted), source.id).changes, 1);
    } finally { db.close(); }
    const before = facts(f);
    const result = await resume(f, source, { idempotencyKey: `a27-reject-${field}` });
    assert.equal(result.status, 400, JSON.stringify(result.body));
    assert.match(result.body.message, new RegExp(field));
    assert.equal(f.calls.length, 1, "a present invalid source axis must not acquire authority at the Runner");
    assert.deepEqual(facts(f), before, "reject malformed source axes before accepting input or persisting preparation");
    assert.deepEqual(f.store.getRun(source.id).requestSnapshot, corrupted);
  }
}

async function persistedRun(f, runId) {
  assert.ok(runId, "the actual HTTP flow must produce a durable Run id");
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && !["succeeded", "failed", "cancelled"].includes(f.store.getRun(runId)?.status)) await delay(10);
  const result = await f.json(`/runs/${encodeURIComponent(runId)}`);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const run = result.body;
  assert.equal(run.status, "succeeded", JSON.stringify(run));
  const row = f.sql(db => db.prepare("SELECT request_snapshot_json, status FROM run_sessions WHERE id=?").get(runId));
  assert.ok(row);
  assert.equal(row.status, "succeeded");
  assert.deepEqual(JSON.parse(row.request_snapshot_json), run.requestSnapshot,
    "HTTP serialization must match a second read-only SQLite connection");
  assert.equal(run.cwd, f.cwd);
  return run;
}

function assertPreparedRequest(f, run, selection) {
  const sourceId = run.requestSnapshot.normalConversationContext.hydration.source.itemId;
  const request = f.store.getConversationPreparedInput(sourceId, "request");
  assert.ok(request);
  assertAxes(request.payload.request, selection);
  assert.deepEqual(run.requestSnapshot.normalConversationPreparedRequestRef, { id: request.id, fingerprint: request.fingerprint });
  const raw = f.sql(db => db.prepare("SELECT payload_json FROM conversation_context_snapshots WHERE id=?").get(request.id));
  assert.deepEqual(JSON.parse(raw.payload_json), request, "the prepared request must persist the original first-class selection");
}

function assertAxes(snapshot, selection) {
  assert.equal(snapshot.authorizationMode, selection.authorizationMode, "authorizationMode must survive HTTP-to-Run reconstruction");
  assert.equal(snapshot.workspaceAccessMode, selection.workspaceAccessMode, "workspaceAccessMode must remain independent from legacy preset");
}

function assertPolicy(policy, selection, decisions, paths) {
  assert.ok(policy, "assert the orchestrator's effective snapshot, not only a callback's input");
  assertAxes(policy, selection);
  for (const [tool, decision] of Object.entries(decisions)) assert.equal(policy.toolDecisions[tool], decision, `effective ${tool} decision`);
  assert.deepEqual(policy.allowedWritePaths, paths);
}

function facts(f) {
  // These are the precise no-dispatch facts asserted, not a claim that every database table is unchanged.
  return f.sql(db => Object.fromEntries(Object.entries({ runs: "run_sessions", workUnits: "work_units", turns: "ling_turns",
    items: "conversation_items", contextSnapshots: "conversation_context_snapshots" })
    .map(([key, table]) => [key, db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count])));
}

function withDatabase(path, callback) {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return callback(db); } finally { db.close(); }
}

function confirmation() {
  return { mode: "full_access", confirmed: true, reason: "A27 synthetic no-effect Runner confirmation", confirmedAt: new Date().toISOString() };
}

function parseSse(text) {
  return text.split(/\r?\n\r?\n/u).flatMap(block => {
    const lines = block.split(/\r?\n/u);
    const event = lines.find(line => line.startsWith("event:"));
    const data = lines.find(line => line.startsWith("data:"));
    return event && data ? [{ event: event.slice(6).trim(), data: JSON.parse(data.slice(5).trim()) }] : [];
  });
}

/** Channel forks require a committed canonical item, not only a Run-created turn. */
async function forkSourceRun(f, kind, selection) {
  if (kind === "conversation") f.controls.completeAssistantMessage = true;
  if (kind !== "channel_discussion") return sourceRun(f, kind, selection);
  const now = new Date().toISOString();
  const channel = f.store.createChannel({ name: "A27 canonical fork channel", boundPath: f.cwd,
    allowedTools: TOOLS, defaultProviderPresetId: f.provider.id, autoReplyMode: "mentions_only" }, now);
  const thread = f.store.resolveOrCreateConversationThread({ surfaceKind: "channel_root", channelId: channel.id,
    title: "A27 channel fork source", objective: "Preserve independent fork permissions" }, now).thread;
  const accepted = f.store.appendConversationUserTurn({ channelId: channel.id, threadId: thread.id,
    title: "A27 channel fork source", userInstruction: "A27 channel fork source",
    payload: { body: "A27 channel fork source", format: "plain_text", mentions: [], attachmentIds: [],
      linkPreviewIds: [], fileRefs: [] }, idempotencyKey: f.nextKey("fork-source-input") }, now);
  const taskId = f.nextKey("fork-source-task");
  const response = await f.request("/runs", "POST", { cwd: f.cwd, workspaceCwd: f.cwd, threadId: thread.id,
    turnId: accepted.turnId, providerPresetId: f.provider.id, task: { id: taskId, title: taskId,
      prompt: "A27 channel fork source", channelId: channel.id }, tools: TOOLS, approvalProfile: { mode: "none" },
    idempotencyKey: f.nextKey("fork-source-run"), ...selection });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  const ready = parseSse(text).find(event => event.event === "ready" && event.data.runId);
  assert.ok(ready?.data.runId, text);
  const run = await persistedRun(f, ready.data.runId);
  assert.equal(run.threadId, thread.id);
  const turn = f.store.getLingTurnForRun(run.id);
  assert.equal(turn?.id, accepted.turnId);
  assert.equal(turn.sourceItemId, accepted.item.id, "the channel fork source must have a committed canonical item");
  return run;
}

async function forkRun(f, source) {
  const sourceTurn = f.store.getLingTurnForRun(source.id);
  assert.ok(sourceTurn);
  return f.json(`/threads/${encodeURIComponent(source.threadId)}/fork-run`, "POST", {
    sourceRunId: source.id, turnId: sourceTurn.id, instruction: "A27 fork child", idempotencyKey: f.nextKey("fork"),
  });
}

async function forkAxes(f, kind) {
  const source = await forkSourceRun(f, kind, SMART_READ);
  assertAxes(source.requestSnapshot, SMART_READ);
  const sourceBefore = structuredClone(source.requestSnapshot);
  const sourceTurn = f.store.getLingTurnForRun(source.id);
  const result = await forkRun(f, source);
  assert.equal(result.status, 202, JSON.stringify(result.body));
  assert.equal(result.body.status, "run_started");
  assert.equal(result.body.sourceRun.id, source.id);
  assert.equal(result.body.sourceTurn.id, sourceTurn.id);
  const run = await persistedRun(f, result.body.runId);
  assert.equal(f.calls.length, 2, "both the source and child must actually reach the owned Runner");
  assert.notEqual(run.threadId, source.threadId);
  assert.equal(run.threadId, result.body.childThread.id);
  const childThread = f.store.getLingThread(run.threadId);
  assert.equal(childThread.parentThreadId, source.threadId);
  assert.equal(childThread.parentTurnId, sourceTurn.id);
  assert.equal(childThread.forkedFromRunId, source.id);
  assertAxes(run.requestSnapshot, SMART_READ);
  assertPolicy(run.requestSnapshot.effectivePolicySnapshot, SMART_READ, { bash: "deny", edit: "deny", write: "deny" }, []);
  assert.deepEqual(f.store.getRun(source.id).requestSnapshot, sourceBefore, "fork must not rewrite the source authority");
  if (kind === "conversation") assertPreparedRequest(f, run, SMART_READ);
}

async function forkFullAccessFence(f) {
  const selection = { ...ASK_FULL, permissionConfirmation: confirmation() };
  f.controls.completeAssistantMessage = true;
  const source = await sourceRun(f, "conversation", selection);
  assertAxes(source.requestSnapshot, selection);
  assert.deepEqual(source.requestSnapshot.permissionConfirmation, selection.permissionConfirmation);
  const sourceBefore = structuredClone(source.requestSnapshot);
  const before = facts(f);
  // No new receipt is submitted. A parent's historical receipt cannot authorize this child.
  const result = await forkRun(f, source);
  assert.equal(result.status, 400, JSON.stringify(result.body));
  assert.equal(result.body.error, "full_access_confirmation_required");
  assert.equal(f.calls.length, 1, "a Full Access child without fresh confirmation must not reach the Runner");
  assert.equal(facts(f).runs, before.runs);
  assert.equal(facts(f).workUnits, before.workUnits);
  assert.deepEqual(f.store.getRun(source.id).requestSnapshot, sourceBefore, "rejecting a child must retain the parent's receipt");
  // Canonical acceptance may precede validation; do not pretend every table is unchanged.
  const children = f.store.listLingThreads({ limit: 100 }).filter(thread => thread.parentThreadId === source.threadId);
  for (const child of children) {
    for (const turn of f.store.listLingTurns({ threadId: child.id })) {
      assert.equal(turn.activeRunId, undefined);
      assert.equal(turn.lastRunId, undefined);
      if (turn.sourceItemId) {
        assert.equal(f.store.getConversationPreparedInput(turn.sourceItemId, "request"), undefined);
        assert.equal(f.store.getConversationPreparedInput(turn.sourceItemId, "execution"), undefined);
      }
    }
  }
}
