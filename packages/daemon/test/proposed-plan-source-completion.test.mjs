import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const NOW = "2026-10-15T02:00:00.000Z";
const LATER = "2026-10-15T02:00:01.000Z";
const caseEnv = "LING_A26_PLAN_SOURCE_CASE";
const cases = { insertion: insertion, "existing-completion": existingCompletion, hydration: hydration };
const selected = process.env[caseEnv];
if (selected) assert.ok(Object.hasOwn(cases, selected));
for (const [label, exercise] of Object.entries(cases)) {
  if (!selected || selected === label) {
    test(`A26 source completion integration ${label}`, { timeout: 60_000 }, t => ownedCase(t, label, exercise));
  }
}

/** Completion integration only: not a real model, orchestrator, crash, or scheduler replay. */
async function ownedCase(t, label, exercise) {
  if (selected) {
    const home = process.env.LING_STACK_HOME, cwd = process.env.LING_STACK_DEFAULT_WORKSPACE_CWD;
    for (const path of [home, cwd]) {
      assert.ok(path && isAbsolute(path) && resolve(path) === path && path !== "/" && path !== process.cwd());
      assert.equal((await stat(path)).isDirectory(), true);
    }
    assert.equal(dirname(home), dirname(cwd));
    assert.ok(basename(dirname(cwd)).startsWith(`ling-a26-source-${label}-`));
    assert.deepEqual(Object.keys(process.env).filter(key => /API_?KEY|TOKEN|SECRET|BASE_URL/iu.test(key)), []);
    const homeHook = t.mock.method(os, "homedir", () => home);
    syncBuiltinESMExports();
    const originalFetch = globalThis.fetch;
    let allowedOrigin;
    const blockedFetches = [];
    globalThis.fetch = async function (input, init) {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      if (!allowedOrigin || url.origin !== allowedOrigin) {
        blockedFetches.push({ origin: url.origin, path: url.pathname, stack: new Error("blocked fixture fetch").stack });
        throw new Error("A26 source integration forbids non-owned HTTP requests");
      }
      return originalFetch.call(this, input, init);
    };
    const handles = [];
    try {
      // Product imports happen only after all ambient paths and network inputs are owned.
      const core = await import("../../core/dist/index.js");
      const { appendChannelItemFixture } = await import("../../core/test/channel-conversation-fixture.mjs");
      const { createAiChannelReply } = await import("../dist/features/channels/ai-replies.js");
      const own = handle => {
        let closed = false;
        const close = () => { if (!closed) { handle.close(); closed = true; } };
        handles.push(close);
        return { handle, close };
      };
      let live = own(core.createSqliteRunStore(cwd));
      const databasePath = join(cwd, ".ling-stack", "ling-stack.sqlite");
      assert.equal(live.handle.paths.databasePath, databasePath);
      const provider = live.handle.createProviderPreset({ kind: "openai-compatible", displayName: "A26 completion fixture",
        providerId: "a26-completion-fixture", model: "a26-completion-fixture", api: "openai-completions",
        capabilities: ["chat"], input: ["text"], authHeader: false, enabled: true,
        contextWindow: 128_000, maxTokens: 4096 }, NOW);
      const channel = live.handle.createChannel({ name: `A26 source ${label}`, boundPath: cwd,
        defaultProviderPresetId: provider.id, defaultTeammateId: "ling_agent", autoReplyMode: "mentions_only" }, NOW);
      const f = {
        core, cwd, home, databasePath, provider, channel,
        secretResolver: core.createCompositeSecretResolver({ env: {} }),
        get store() { return live.handle; },
        closeStore: () => live.close(),
        reopen() { live.close(); live = own(core.createSqliteRunStore(cwd)); return live.handle; },
        append: input => appendChannelItemFixture(live.handle, input, NOW),
        sql: callback => withDatabase(databasePath, callback),
        facts: () => databaseFacts(databasePath),
        allowOrigin(origin) { allowedOrigin = origin; },
        createAiChannelReply, completionCalls: [],
      };
      console.log(`A26 source real fixture entered: ${label}`);
      await exercise(f);
      assert.deepEqual(blockedFetches, [], "source integration cannot attempt non-owned HTTP");
    } finally {
      try { for (const close of handles.reverse()) close(); }
      finally {
        globalThis.fetch = originalFetch;
        homeHook.mock.restore();
        syncBuiltinESMExports();
      }
    }
    return;
  }
  const tempRoot = await realpath(os.tmpdir());
  const root = await realpath(await mkdtemp(join(tempRoot, `ling-a26-source-${label}-`)));
  const home = join(root, "home"), cwd = join(root, "workspace");
  await mkdir(home); await mkdir(cwd);
  try {
    const child = spawn(process.execPath, ["--test", "--test-reporter=tap", fileURLToPath(import.meta.url)], {
      env: { PATH: process.env.PATH, LANG: "C.UTF-8", TZ: "UTC", LING_STACK_HOME: home,
        LING_STACK_DEFAULT_WORKSPACE_CWD: cwd, [caseEnv]: label },
      stdio: ["ignore", "pipe", "pipe"], timeout: 45_000,
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
    console.log(`A26 source child exit: ${JSON.stringify({ label, ...exit })}`);
    assert.ok(stdout.includes(`A26 source real fixture entered: ${label}`));
    assert.equal(exit.signal, null, "the owned child must settle rather than be killed");
    assert.equal(exit.code, 0, `${label}: actual completion and SQLite regression failed`);
  } finally {
    assert.equal(dirname(root), tempRoot);
    assert.ok(basename(root).startsWith(`ling-a26-source-${label}-`));
    await rm(root, { recursive: true, force: true });
  }
}

/** The exported wrapper really reaches its private parser/writer on first completion. */
async function insertion(f) {
  const source = userSource(f, "insertion");
  const replyId = "a26_source_reply_insertion";
  const raw = 'Completion fixture finished.\n<proposed_plan title="Source-owned title"># Initial body\nKeep these exact bytes.</proposed_plan>';
  const result = await complete(f, source, replyId, raw);
  assertReady(f, result, replyId, raw, 1);
  const planId = `proposed_plan_${replyId}`;
  const plan = f.store.getProposedPlanArtifact(planId);
  assert.ok(plan, "the completion must actually insert the stable source plan");
  assert.equal(plan.threadId, source.threadId);
  assert.equal(plan.channelId, f.channel.id);
  assert.equal(plan.sourceMessageId, replyId);
  assert.equal(plan.sourceRunId, f.completionCalls[0].runId);
  assert.equal(plan.title, "Source-owned title");
  assert.equal(plan.bodyMarkdown, "# Initial body\nKeep these exact bytes.");
  assert.equal(plan.status, "draft");
  assert.equal(plan.version, 1);
  assert.equal(plan.revision, 1);
  const settled = f.facts();
  assert.equal(settled.plans.length, 1);
  assert.equal(settled.tasks.length, 0);
  assert.equal(settled.workflows.length, 0);
  // This second public call exercises only wrapper dedupe, not writer replay.
  const duplicate = await complete(f, source, replyId, "must not execute again");
  assert.deepEqual(duplicate.reply, result.reply);
  assert.equal(duplicate.runId, undefined);
  assert.deepEqual(duplicate.observed, { ready: [], done: [], blocked: [], delta: [] });
  assert.equal(f.completionCalls.length, 1);
  assert.deepEqual(f.facts(), settled);
  f.reopen();
  assert.deepEqual(f.store.getProposedPlanArtifact(planId), plan);
  assert.deepEqual(f.facts(), settled);
}

/** Pending + durable-plan fixtures exercise completion re-entry, not a simulated OS crash. */
async function existingCompletion(f) {
  for (const lifecycle of ["draft", "accepted-archived"]) {
    const source = userSource(f, lifecycle);
    const replyId = `a26_source_reply_${lifecycle}`;
    const pending = f.append({ id: replyId, channelId: f.channel.id, threadId: source.threadId,
      replyToItemId: source.id, authorType: "ai-teammate", authorId: "ling_agent", kind: "ai_reply",
      body: "Pending completion fixture", status: "pending" });
    assert.equal(pending.status, "pending");
    const planId = `proposed_plan_${replyId}`;
    const initial = f.store.upsertProposedPlanArtifact({ id: planId, threadId: source.threadId,
      sourceMessageId: replyId, title: "Original source title", bodyMarkdown: "Original source body" }, NOW);
    const edited = f.store.updateProposedPlanArtifact(planId, { title: `Canonical ${lifecycle} title`,
      bodyMarkdown: `Canonical ${lifecycle} body\r\nDo not replay over this.`, expectedRevision: initial.revision }, NOW);
    assert.equal(edited.revision, initial.revision + 1);
    let taskId;
    if (lifecycle === "accepted-archived") {
      const accepted = f.store.applyProposedPlanArtifactAction(planId, { threadId: source.threadId, action: "accept" }, NOW);
      taskId = accepted.taskId;
      assert.ok(taskId);
      const archived = f.store.applyProposedPlanArtifactAction(planId, { threadId: source.threadId, action: "archive" }, LATER).plan;
      assert.equal(archived.status, "archived");
      assert.equal(archived.acceptedTaskId, taskId);
      assert.equal(archived.acceptedAt, accepted.plan.acceptedAt);
    }
    const canonical = f.store.getProposedPlanArtifact(planId);
    assert.equal(canonical.status, lifecycle === "draft" ? "draft" : "archived");
    const before = f.facts();
    const task = taskId ? before.tasks.find(row => row.id === taskId) : undefined;
    if (taskId) {
      assert.ok(task);
      assert.ok(task.prompt.includes(edited.bodyMarkdown));
      assert.equal(task.prompt.includes("Obsolete reply body"), false);
    }
    const raw = `Completion re-entry finished for ${lifecycle}.\n<proposed_plan title="Obsolete reply title">Obsolete reply body</proposed_plan>`;
    const expectedCalls = f.completionCalls.length + 1;
    const result = await complete(f, source, replyId, raw);
    // Removing the source-id guard must fail here: Core rejection is caught as blocked.
    assertReady(f, result, replyId, raw, expectedCalls);
    assert.deepEqual(f.store.getProposedPlanArtifact(planId), canonical, `${lifecycle} completion cannot overwrite the canonical plan`);
    const after = f.facts();
    assert.deepEqual(after.plans, before.plans);
    assert.deepEqual(after.tasks, before.tasks, `${lifecycle} completion preserves every real Task and its exact prompt`);
    assert.deepEqual(after.workflows, before.workflows);
    assert.deepEqual(after.steps, before.steps);
    assert.deepEqual(after.runs.filter(row => row.id !== result.runId), before.runs);
    assert.equal(after.runs.length, before.runs.length + 1, "only the fixture's explicit completion Run is added");
    assert.equal(after.runs.find(row => row.id === result.runId)?.status, "succeeded");
    assert.equal(after.items.find(row => row.id === replyId)?.status, "committed");
    f.reopen();
    assert.deepEqual(f.store.getProposedPlanArtifact(planId), canonical);
    assert.deepEqual(f.facts(), after, `${lifecycle} plan and Task preservation survive actual Store reopen`);
  }
}

/** Real HTTP source hydration is a view projection, never a write-back or body refill. */
async function hydration(f) {
  const source = userSource(f, "hydration");
  const replyId = "a26_source_reply_hydration";
  const raw = 'Hydration completion finished.\n<proposed_plan title="Hydration canonical">Keep canonical plan body, not source message body.</proposed_plan>';
  assertReady(f, await complete(f, source, replyId, raw), replyId, raw, 1);
  const availableId = `proposed_plan_${replyId}`;
  const accepted = f.store.applyProposedPlanArtifactAction(availableId, { threadId: source.threadId, action: "accept" }, NOW);
  const archived = f.store.applyProposedPlanArtifactAction(availableId, { threadId: source.threadId, action: "archive" }, LATER).plan;
  assert.equal(archived.acceptedTaskId, accepted.taskId);
  assert.equal(archived.status, "archived");
  const otherChannel = f.store.createChannel({ name: "A26 unrelated source channel", boundPath: f.cwd }, NOW);
  const crossed = f.append({ channelId: otherChannel.id, authorType: "local-user", body: "Unrelated source body must not fill a plan." });
  const expected = new Map([[availableId, "available"]]);
  for (const [suffix, sourceMessageId, state] of [["missing", "a26_missing_source", "deleted"],
    ["crossed", crossed.id, "deleted"], ["none", undefined, undefined]]) {
    const plan = f.store.upsertProposedPlanArtifact({ id: `proposed_plan_a26_hydration_${suffix}`,
      threadId: source.threadId, channelId: f.channel.id, sourceMessageId,
      title: `Hydration ${suffix}`, bodyMarkdown: `Exact ${suffix} audit history\r\n` }, NOW);
    expected.set(plan.id, state);
  }
  // Completion used the synthetic adapter above. The read-only Daemon must not
  // perform the unrelated startup health probe of that deliberately fake provider.
  assert.equal(f.store.updateProviderPreset(f.provider.id, { enabled: false }, NOW)?.enabled, false);
  const baseline = f.facts();
  const canonical = new Map([...expected.keys()].map(id => [id, f.store.getProposedPlanArtifact(id)]));
  f.closeStore();
  let daemon, daemonStore, modelCalls = 0;
  try {
    const { createDaemonServer } = await import("../dist/index.js");
    const resolver = f.secretResolver;
    daemon = createDaemonServer({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: f.cwd,
      channels: { autoRoute: false, intentSelector: false, terminalReports: false, teamObserverBus: false },
      cuaDriver: { bundledEmbedded: { darwin: false, win32: false }, packagedProvider: { darwin: false, win32: false } },
    }, { secretResolver: resolver, chromeBrowserNativeMessagingEnabled: false,
      externalSecretStore: { ...resolver,
        setSecret() { throw new Error("A26 hydration forbids external secret writes"); },
        deleteSecret() { throw new Error("A26 hydration forbids external secret deletes"); } },
      runner: { async runTask() { modelCalls++; throw new Error("A26 hydration cannot start a model"); } },
      storeFactory(storeCwd) {
        assert.equal(resolve(storeCwd), f.cwd);
        assert.equal(daemonStore, undefined);
        daemonStore = f.core.createSqliteRunStore(storeCwd);
        return daemonStore;
      },
    });
    await daemon.start();
    const address = daemon.server.address();
    assert.ok(address && typeof address === "object");
    const origin = `http://127.0.0.1:${address.port}`;
    f.allowOrigin(origin);
    const threadPath = `/threads/${encodeURIComponent(source.threadId)}/proposed-plans`;
    for (const [id, state] of expected) {
      const result = await getJson(origin, f.cwd, `${threadPath}/${encodeURIComponent(id)}`);
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assertHydrated(result.body.plan, canonical.get(id), state);
      assert.deepEqual(f.facts(), baseline, "an item GET cannot persist source state or refill body content");
    }
    for (const path of [threadPath, `/channels/${encodeURIComponent(f.channel.id)}/proposed-plans`]) {
      const result = await getJson(origin, f.cwd, path);
      assert.equal(result.status, 200, JSON.stringify(result.body));
      for (const [id, state] of expected) {
        const view = result.body.plans.find(plan => plan.id === id);
        assert.ok(view);
        assertHydrated(view, canonical.get(id), state);
      }
      assert.deepEqual(f.facts(), baseline, "list hydration cannot mutate durable history or accepted work");
    }
    assert.equal(modelCalls, 0);
  } finally {
    if (daemon) await daemon.stop();
    f.allowOrigin(undefined);
  }
  f.reopen();
  assert.deepEqual(f.facts(), baseline);
  for (const [id, plan] of canonical) assert.deepEqual(f.store.getProposedPlanArtifact(id), plan);
}

function userSource(f, suffix) {
  return f.append({ id: `a26_user_source_${suffix}`, channelId: f.channel.id,
    authorType: "local-user", body: `Please prepare a plan for ${suffix}.` });
}

/** Synthetic adapter owns only Run persistence and sink delivery; no runner or provider. */
async function complete(f, source, replyId, raw) {
  let runId;
  const observed = { ready: [], done: [], blocked: [], delta: [] };
  const reply = await f.createAiChannelReply({ store: f.store, channel: f.channel, sourceMessage: source,
    providerPresetId: f.provider.id, teammateId: "ling_agent", replyMessageId: replyId,
    secretResolver: f.secretResolver, disableWebEvidence: true, teamObserverBusEnabled: false, completionMode: "inline",
    stream: { onReady: value => observed.ready.push(value), onDone: value => observed.done.push(value),
      onBlocked: value => observed.blocked.push(value), onDelta: (value, delta) => observed.delta.push({ value, delta }) },
    async startRun(request, sink) {
      assert.deepEqual(request.tools, []);
      assert.equal(request.authorizationMode, "always");
      assert.equal(request.workspaceAccessMode, "read_only");
      assert.equal(request.sourceMessageId, source.id);
      assert.equal(request.linkedMessageId, replyId);
      runId = `a26_completion_run_${f.completionCalls.length + 1}`;
      f.completionCalls.push({ runId, sourceId: source.id, replyId });
      f.store.createRun({ id: runId, cwd: f.cwd, taskId: request.task.id, channelId: f.channel.id,
        teammateId: "ling_agent", providerPresetId: f.provider.id, providerName: "a26-synthetic-completion",
        providerModel: "a26-synthetic-completion", taskSnapshot: request.task, providerSnapshot: {},
        requestSnapshot: request, threadId: request.threadId, turnId: request.turnId, createdAt: NOW });
      f.store.markRunStarted(runId, NOW);
      sink.writeReady({ runId });
      sink.writeEvent("assistant_text_delta", { type: "assistant_text_delta", runId, ts: NOW, data: { text: raw } });
      f.store.markRunSucceeded(runId, LATER);
      return runId;
    },
  });
  return { reply, runId, observed };
}

function assertReady(f, result, replyId, raw, calls) {
  assert.equal(result.reply.id, replyId);
  assert.equal(result.reply.status, "ready", JSON.stringify(result.reply));
  assert.equal(result.reply.body, raw);
  assert.equal(result.observed.ready.length, 1);
  assert.equal(result.observed.done.length, 1);
  assert.equal(result.observed.blocked.length, 0);
  assert.ok(result.observed.delta.some(event => event.delta.includes("<proposed_plan")));
  assert.equal(f.completionCalls.length, calls);
  assert.ok(result.runId);
  assert.equal(f.store.getRun(result.runId)?.status, "succeeded");
  assert.equal(f.store.getConversationItem(replyId)?.status, "committed");
}

function assertHydrated(view, canonical, state) {
  assert.ok(canonical);
  assert.equal(view.sourceMessageState, state);
  if (state === undefined) assert.equal(Object.hasOwn(view, "sourceMessageState"), false);
  const { sourceMessageState, ...content } = view;
  assert.deepEqual(content, JSON.parse(JSON.stringify(canonical)), "hydration adds only the transient source-state view");
}

async function getJson(origin, cwd, path) {
  const response = await fetch(`${origin}${path}?cwd=${encodeURIComponent(cwd)}&limit=100`);
  return { status: response.status, body: await response.json() };
}

function withDatabase(databasePath, callback) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try { return callback(database); }
  finally { database.close(); }
}

function databaseFacts(databasePath) {
  return withDatabase(databasePath, database => {
    const rows = table => database.prepare(`SELECT * FROM ${table} ORDER BY id`).all().map(row => ({ ...row }));
    return { plans: rows("ling_thread_proposed_plans"), tasks: rows("tasks"), workflows: rows("channel_workflows"),
      steps: rows("channel_workflow_steps"), runs: rows("run_sessions"), items: rows("conversation_items") };
  });
}
