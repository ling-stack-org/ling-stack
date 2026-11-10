import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const caseEnv = "LING_A26_HISTORY_ACTION_CASE";
const scenarios = [
  { id: "stale-save", name: "A26 accepted history survives a stale complete UI save payload", action: "save" },
  { id: "stale-accept", name: "A26 accepted history survives a stale complete UI accept payload", action: "accept" },
  { id: "refine-empty", name: "A26 accepted refinement without a body creates a separate plan version", action: "refine" },
];
const selectedCase = process.env[caseEnv];
if (selectedCase) assert.ok(scenarios.some(scenario => scenario.id === selectedCase));
for (const scenario of scenarios) {
  // Register only the selected case in a child, without recursive placeholder skips.
  if (!selectedCase || selectedCase === scenario.id) {
    test(scenario.name, { timeout: 60_000 }, t => runOwnedCase(t, scenario));
  }
}

/** Each regression owns its process, home, default workspace and actual HTTP server. */
async function runOwnedCase(t, scenario) {
  if (selectedCase) return exercisePublicAction(t, scenario);
  const tempRoot = await realpath(os.tmpdir());
  const root = await realpath(await mkdtemp(join(tempRoot, `ling-a26-${scenario.id}-`)));
  const home = join(root, "home"), cwd = join(root, "workspace");
  await mkdir(home); await mkdir(cwd);
  try {
    const child = spawn(process.execPath, ["--test", "--test-reporter=tap", fileURLToPath(import.meta.url)], {
      env: { PATH: process.env.PATH, LANG: "C.UTF-8", TZ: "UTC", LING_STACK_HOME: home,
        LING_STACK_DEFAULT_WORKSPACE_CWD: cwd, [caseEnv]: scenario.id },
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
    console.log(`A26 child exit: ${JSON.stringify({ scenario: scenario.id, ...exit })}`);
    assert.ok(stdout.includes(`A26 real public action entered: ${scenario.id}`));
    assert.equal(exit.signal, null, "the owned child must settle rather than be killed");
    assert.equal(exit.code, 0, `${scenario.id}: actual HTTP and SQLite regression failed`);
  } finally {
    assert.equal(dirname(root), tempRoot);
    assert.ok(basename(root).startsWith(`ling-a26-${scenario.id}-`));
    await rm(root, { recursive: true, force: true });
  }
}

/** Keep the original action route, Store, SQLite and real Task creation untouched. */
async function exercisePublicAction(t, scenario) {
  const cwd = process.env.LING_STACK_DEFAULT_WORKSPACE_CWD, home = process.env.LING_STACK_HOME;
  for (const path of [cwd, home]) {
    assert.ok(path && isAbsolute(path) && resolve(path) === path && path !== "/" && path !== process.cwd());
    assert.equal((await stat(path)).isDirectory(), true);
  }
  assert.equal(dirname(cwd), dirname(home));
  assert.ok(basename(dirname(cwd)).startsWith(`ling-a26-${scenario.id}-`));
  assert.deepEqual(Object.keys(process.env).filter(key => /API_?KEY|TOKEN|SECRET|BASE_URL/iu.test(key)), []);
  console.log(`A26 real public action entered: ${scenario.id}`);
  const homeHook = t.mock.method(os, "homedir", () => home);
  syncBuiltinESMExports();
  const originalFetch = globalThis.fetch;
  let allowedOrigin, daemon, store, reopened, modelCalls = 0, blockedFetches = 0;
  globalThis.fetch = async function (input, init) {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (!allowedOrigin || url.origin !== allowedOrigin) {
      blockedFetches++;
      throw new Error("A26 forbids non-owned HTTP requests");
    }
    return originalFetch.call(this, input, init);
  };
  try {
    // No product module is imported until the child owns all home/workspace inputs.
    const core = await import("../../core/dist/index.js");
    const { createDaemonServer } = await import("../dist/index.js");
    const secretResolver = core.createCompositeSecretResolver({ env: {} });
    daemon = createDaemonServer({
      host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd,
      channels: { autoRoute: false, intentSelector: false, terminalReports: false, teamObserverBus: false },
      cuaDriver: { bundledEmbedded: { darwin: false, win32: false }, packagedProvider: { darwin: false, win32: false } },
    }, {
      secretResolver,
      externalSecretStore: { ...secretResolver,
        setSecret() { throw new Error("A26 forbids external secret writes"); },
        deleteSecret() { throw new Error("A26 forbids external secret deletes"); } },
      chromeBrowserNativeMessagingEnabled: false,
      runner: { async runTask() { modelCalls++; throw new Error("A26 forbids model execution"); } },
      storeFactory(storeCwd) {
        assert.equal(resolve(storeCwd), cwd, "only the owned temporary workspace SQLite may be opened");
        assert.equal(store, undefined, "the fixture must not create a second live Store");
        store = core.createSqliteRunStore(storeCwd);
        return store;
      },
    });
    await daemon.start();
    const address = daemon.server.address();
    assert.ok(address && typeof address === "object");
    allowedOrigin = `http://127.0.0.1:${address.port}`;
    assert.ok(store);
    const databasePath = join(cwd, ".ling-stack", "ling-stack.sqlite");
    assert.equal(store.paths.databasePath, databasePath);
    const now = "2026-10-15T00:00:00.000Z";
    // Channel/thread setup uses the real Store without invoking Git or a model.
    const channel = store.createChannel({ name: `A26 ${scenario.id}`, boundPath: cwd, allowedTools: ["read"] }, now);
    const thread = store.createLingThread({ kind: "channel_discussion", channelId: channel.id,
      title: `A26 history ${scenario.id}`, objective: "Preserve accepted plan history", status: "open" }, now);
    const planId = `proposed_plan_a26_${scenario.id}`;
    const planPath = `/threads/${encodeURIComponent(thread.id)}/proposed-plans/${encodeURIComponent(planId)}`;
    const request = (path, method, body) => publicJson(allowedOrigin, cwd, path, method, body);

    const initial = await request(planPath, "PUT", {
      title: "A26 first draft", bodyMarkdown: "A26_STALE_DRAFT_V1", version: 1, status: "draft",
    });
    assert.equal(initial.status, 201, JSON.stringify(initial.body));
    const staleUiPayload = completeUiPayload(initial.body.plan);
    assert.equal(staleUiPayload.status, "draft");
    assert.equal(staleUiPayload.version, 1);

    const revised = await request(planPath, "PATCH", {
      title: "A26 actually accepted revision", bodyMarkdown: "A26_ACCEPTED_REVISION_V2", version: 2,
      // New explicit draft-edit CAS contract; all original history/Task assertions stay intact.
      expectedRevision: initial.body.plan.revision,
    });
    assert.equal(revised.status, 200, JSON.stringify(revised.body));
    assert.equal(revised.body.plan.bodyMarkdown, "A26_ACCEPTED_REVISION_V2");
    const accepted = await request(`${planPath}/accept`, "POST", {});
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    assert.equal(accepted.body.plan.status, "accepted");
    assert.equal(accepted.body.plan.version, 2);
    assert.ok(accepted.body.taskId);
    assert.equal(accepted.body.plan.acceptedTaskId, accepted.body.taskId);

    const beforeSave = readDatabaseFacts(databasePath, planId);
    assert.equal(beforeSave.tasks.length, 1, "a real public accept must create exactly one Task");
    assert.equal(beforeSave.tasks[0].id, accepted.body.taskId);
    assert.match(beforeSave.tasks[0].prompt, /A26_ACCEPTED_REVISION_V2/u);
    assert.equal(beforeSave.tasks[0].prompt.includes("A26_STALE_DRAFT_V1"), false);
    assert.equal(beforeSave.runCount, 0);

    // Positive metadata control: accepting a plan must not prohibit a legal Save.
    const legalSave = await request(`${planPath}/save`, "POST", {});
    assert.equal(legalSave.status, 200, JSON.stringify(legalSave.body));
    assert.equal(legalSave.body.plan.status, "accepted");
    assert.equal(typeof legalSave.body.plan.savedAt, "string");
    assert.equal(legalSave.body.plan.revision, beforeSave.plan.revision + 1);
    const baseline = readDatabaseFacts(databasePath, planId);
    assert.equal(baseline.plan.revision, beforeSave.plan.revision + 1);
    assert.deepEqual(acceptedHistory(baseline.plan), acceptedHistory(beforeSave.plan));
    assert.deepEqual(baseline.tasks, beforeSave.tasks);
    assert.equal(baseline.runCount, 0);

    const actionBody = scenario.id === "refine-empty" ? {} : { plan: staleUiPayload };
    const actionResult = await request(`${planPath}/${scenario.action}`, "POST", actionBody);
    const fetched = await request(planPath, "GET");
    const history = await request(`/threads/${encodeURIComponent(thread.id)}/proposed-plans`, "GET");
    const durable = readDatabaseFacts(databasePath, planId);
    await daemon.stop(); daemon = undefined;
    reopened = core.createSqliteRunStore(cwd);
    const afterReopen = readDatabaseFacts(databasePath, planId);
    const reopenedAccepted = reopened.getProposedPlanArtifact(planId);
    console.log(`A26 public history evidence: ${JSON.stringify({ scenario: scenario.id,
      staleUiPayload, baseline, actionResult, fetched, history, durable, afterReopen,
      reopenedAccepted, modelCalls, blockedFetches })}`);

    // Collect every durable observation before asserting the expected regression.
    assert.equal(modelCalls, 0, "plan actions cannot start an unconfirmed model Run");
    assert.equal(blockedFetches, 0, "no external HTTP request may be attempted");
    assert.deepEqual(afterReopen, durable, "the observed plan and Task facts must survive actual Store close/reopen");
    assert.deepEqual(durable.tasks, baseline.tasks, "the accepted Task row and exact prompt must not change or duplicate");
    assert.equal(durable.runCount, baseline.runCount, "no action may start a new Run");
    assert.equal(reopenedAccepted.acceptedTaskId, accepted.body.taskId);
    assert.deepEqual(acceptedHistory(durable.plan), acceptedHistory(baseline.plan),
      "an old action payload or refine without a body must preserve the accepted history row");
    assert.equal(fetched.status, 200);
    assert.equal(fetched.body.plan.status, "accepted");
    assert.equal(fetched.body.plan.bodyMarkdown, "A26_ACCEPTED_REVISION_V2");
    assert.equal(history.status, 200);

    if (scenario.id === "refine-empty") {
      // Existing A26 repair contract, post-review-repair-plan.md:49: refine is a
      // parentPlanId/version successor even without a body, not an in-place reset.
      assert.equal(actionResult.status, 200, JSON.stringify(actionResult.body));
      assert.equal(durable.plan.revision, baseline.plan.revision + 1);
      const successor = actionResult.body.plan;
      assert.notEqual(successor.id, planId);
      assert.equal(successor.parentPlanId, planId);
      assert.equal(successor.version, baseline.plan.version + 1);
      assert.equal(successor.status, "draft");
      assert.equal(durable.plans.length, baseline.plans.length + 1);
      const successorRow = durable.plans.find(plan => plan.id === successor.id);
      assert.ok(successorRow, "the returned successor must be genuinely durable");
      assert.equal(successorRow.parent_plan_id, planId);
      assert.equal(successorRow.version, successor.version);
      assert.equal(successorRow.status, "draft");
      assert.equal(history.body.plans.some(plan => plan.id === planId && plan.status === "accepted"), true);
      assert.equal(history.body.plans.some(plan => plan.id === successor.id), true);
    } else {
      // A conflict or a canonical idempotent action is safe; neither may first
      // overwrite history. Do not invent a new draft concurrency token contract.
      assert.ok([200, 409].includes(actionResult.status), JSON.stringify(actionResult.body));
      assert.equal(durable.plan.revision, baseline.plan.revision);
      assert.equal(durable.plans.length, baseline.plans.length);
      if (actionResult.status === 200) {
        assert.equal(actionResult.body.plan.id, planId);
        assert.equal(actionResult.body.plan.status, "accepted");
        assert.equal(actionResult.body.plan.version, baseline.plan.version);
        assert.equal(actionResult.body.plan.bodyMarkdown, "A26_ACCEPTED_REVISION_V2");
        if (scenario.action === "accept") assert.equal(actionResult.body.taskId, accepted.body.taskId);
      }
    }
  } finally {
    try {
      if (daemon) await daemon.stop();
    } finally {
      reopened?.close();
      globalThis.fetch = originalFetch;
      homeHook.mock.restore();
      syncBuiltinESMExports();
    }
  }
}

/** Copy the current ordinary UI action payload, including its nullable fields. */
function completeUiPayload(plan) {
  return {
    id: plan.id, threadId: plan.threadId, channelId: plan.channelId ?? null, goalId: plan.goalId ?? null,
    sourceAgentId: plan.sourceAgentId ?? null, ownerAgentId: plan.ownerAgentId ?? null,
    sourceTurnId: plan.sourceTurnId ?? null, sourceMessageId: plan.sourceMessageId ?? null,
    sourceRunId: plan.sourceRunId ?? null, parentPlanId: plan.parentPlanId ?? null,
    supersededByPlanId: plan.supersededByPlanId ?? null, planGroupId: plan.planGroupId ?? null,
    version: plan.version ?? null, title: plan.title, bodyMarkdown: plan.bodyMarkdown, status: plan.status,
  };
}

/** Read raw rows and exact counts through a second real, read-only SQLite connection. */
function readDatabaseFacts(databasePath, planId) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const plain = row => ({ ...row });
    const plan = database.prepare("SELECT * FROM ling_thread_proposed_plans WHERE id = ?").get(planId);
    assert.ok(plan);
    return {
      plan: plain(plan),
      plans: database.prepare("SELECT * FROM ling_thread_proposed_plans ORDER BY id").all().map(plain),
      tasks: database.prepare("SELECT * FROM tasks ORDER BY id").all().map(plain),
      runCount: Number(database.prepare("SELECT COUNT(*) AS count FROM run_sessions").get().count),
    };
  } finally {
    database.close();
  }
}

/** Protocol revision is checked separately; accepted content and lineage remain exact. */
function acceptedHistory(row) {
  const { updated_at, saved_at, superseded_by_plan_id, revision, ...history } = row;
  return history;
}

/** Read actual response bytes; callers decide lifecycle-specific allowed statuses. */
async function publicJson(origin, cwd, path, method, body) {
  const response = await fetch(`${origin}${path}?cwd=${encodeURIComponent(cwd)}`, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(5_000),
  });
  const text = await response.text();
  return { status: response.status, body: JSON.parse(text) };
}
