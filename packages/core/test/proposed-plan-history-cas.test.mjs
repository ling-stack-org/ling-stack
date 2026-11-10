import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const NOW = "2026-10-15T01:00:00.000Z";
const LATER = "2026-10-15T01:00:01.000Z";
const caseEnv = "LING_A26_CORE_HISTORY_CASE";
const cases = {
  "draft-cas": draftCas,
  "metadata-cas": metadataCas,
  "action-cas": actionCas,
  "two-connections": twoConnections,
  "sealed-archive": sealedArchive,
  "normal-actions": normalActions,
  "historical-lifecycle": historicalLifecycle,
  "snapshot-conflicts": snapshotConflicts,
  "task-rollback": taskRollback,
  "workflow-rollback": workflowRollback,
  "child-rollback": childRollback,
  "child-cas-rollback": childCasRollback,
  "refine-retry": refineRetry,
  "bad-successor": badSuccessor,
  "nested-action": nestedAction,
  "migration": migration,
};
const selected = process.env[caseEnv];
if (selected) assert.ok(Object.hasOwn(cases, selected));
for (const [label, exercise] of Object.entries(cases)) {
  if (!selected || selected === label) {
    test(`A26 Core proposed plan history ${label}`, { timeout: 60_000 }, t => ownedCase(t, label, exercise));
  }
}

/** No inherited home, credentials, product imports, or ambient workspace in a child. */
async function ownedCase(t, label, exercise) {
  if (selected) {
    const home = process.env.LING_STACK_HOME, cwd = process.env.LING_STACK_DEFAULT_WORKSPACE_CWD;
    for (const path of [home, cwd]) {
      assert.ok(path && isAbsolute(path) && resolve(path) === path && path !== "/" && path !== process.cwd());
      assert.equal((await stat(path)).isDirectory(), true);
    }
    assert.equal(dirname(home), dirname(cwd));
    assert.ok(basename(dirname(cwd)).startsWith(`ling-a26-core-${label}-`));
    assert.deepEqual(Object.keys(process.env).filter(key => /API_?KEY|TOKEN|SECRET|BASE_URL/iu.test(key)), []);
    const homeHook = t.mock.method(os, "homedir", () => home);
    const originalFetch = globalThis.fetch;
    let networkCalls = 0;
    globalThis.fetch = async () => { networkCalls++; throw new Error("A26 Core forbids network access"); };
    syncBuiltinESMExports();
    const handles = [];
    try {
      const core = await import("../dist/index.js");
      const own = handle => {
        let closed = false;
        const close = () => { if (!closed) { handle.close(); closed = true; } };
        handles.push(close);
        return { handle, close };
      };
      const first = own(core.createSqliteRunStore(cwd));
      const store = first.handle;
      const databasePath = join(cwd, ".ling-stack", "ling-stack.sqlite");
      assert.equal(store.paths.databasePath, databasePath);
      const channel = store.createChannel({ name: `A26 Core ${label}`, boundPath: cwd, allowedTools: ["read"] }, NOW);
      const thread = store.createLingThread({ kind: "channel_discussion", channelId: channel.id,
        title: `A26 ${label}`, objective: "Verify actual plan history and SQLite atomicity", status: "open" }, NOW);
      const f = { core, cwd, channel, thread, store, databasePath, own, closeStore: first.close,
        openStore: () => own(core.createSqliteRunStore(cwd)),
        sql: callback => withDatabase(databasePath, callback),
        facts: () => databaseFacts(databasePath),
      };
      console.log(`A26 Core real fixture entered: ${label}`);
      await exercise(f);
      assert.equal(networkCalls, 0);
      assert.equal(f.facts().runs.length, 0, "Core plan actions cannot manufacture an unconfirmed Run");
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
  const root = await realpath(await mkdtemp(join(tempRoot, `ling-a26-core-${label}-`)));
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
    console.log(`A26 Core child exit: ${JSON.stringify({ label, ...exit })}`);
    assert.ok(stdout.includes(`A26 Core real fixture entered: ${label}`));
    assert.equal(exit.signal, null, "the owned child must settle rather than be killed");
    assert.equal(exit.code, 0, `${label}: actual Core and SQLite regression failed`);
  } finally {
    assert.equal(dirname(root), tempRoot);
    assert.ok(basename(root).startsWith(`ling-a26-core-${label}-`));
    await rm(root, { recursive: true, force: true });
  }
}

/** Same semantic version is deliberately not a lock; missing/stale revisions conflict. */
function draftCas(f) {
  const initial = draft(f, "cas");
  assert.equal(initial.revision, 1);
  assert.equal(initial.version, 1);
  const baseline = f.facts();
  conflict(f, () => f.store.updateProposedPlanArtifact(initial.id, { bodyMarkdown: "missing token", version: 1 }, NOW));
  conflict(f, () => f.store.updateProposedPlanArtifact(initial.id, { bodyMarkdown: "next version is not a lock", version: 2 }, NOW));
  conflict(f, () => f.store.upsertProposedPlanArtifact({ ...writePayload(initial), bodyMarkdown: "missing upsert token" }, NOW));
  for (const expectedRevision of [0, -1, 1.5, "1", null, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => f.store.updateProposedPlanArtifact(initial.id, { title: "invalid token", expectedRevision }, NOW),
      error => domainError(error, [400, 409]));
    assert.deepEqual(f.facts(), baseline);
  }
  const unchanged = f.store.upsertProposedPlanArtifact(writePayload(initial), LATER);
  assert.deepEqual(unchanged, initial, "an identical tokenless complete write is read-only idempotency");
  assert.deepEqual(f.facts(), baseline);
  const edited = f.store.updateProposedPlanArtifact(initial.id, { bodyMarkdown: "same version new content",
    version: 1, expectedRevision: initial.revision }, NOW);
  assert.equal(edited.version, 1);
  assert.equal(edited.revision, initial.revision + 1);
  assert.equal(edited.updatedAt, initial.updatedAt, "fixed time makes timestamp-only CAS insufficient");
  conflict(f, () => f.store.updateProposedPlanArtifact(initial.id, { bodyMarkdown: "stale token", expectedRevision: initial.revision }, NOW));
  const second = f.store.upsertProposedPlanArtifact({ ...writePayload(edited), title: "tokened upsert",
    expectedRevision: edited.revision }, NOW);
  assert.equal(second.version, edited.version);
  assert.equal(second.revision, edited.revision + 1);
  assert.equal(second.bodyMarkdown, edited.bodyMarkdown);
}

/** Metadata edits obey the same durable CAS rule; exact repeats remain read-only. */
function metadataCas(f) {
  for (const [field, first, second] of [["savedAt", LATER, NOW], ["archivedAt", LATER, NOW],
    ["archivedReason", "first reason", "different reason"]]) {
    const initial = draft(f, `metadata_${field}`);
    conflict(f, () => f.store.updateProposedPlanArtifact(initial.id, { [field]: first }, NOW));
    conflict(f, () => f.store.upsertProposedPlanArtifact({ ...writePayload(initial), [field]: first }, NOW));
    const changed = f.store.updateProposedPlanArtifact(initial.id, { [field]: first,
      expectedRevision: initial.revision }, NOW);
    assert.equal(changed[field], first);
    assert.equal(changed.revision, initial.revision + 1);
    assert.equal(changed.status, initial.status);
    const settled = f.facts();
    assert.deepEqual(f.store.updateProposedPlanArtifact(initial.id, { [field]: first }, LATER), changed);
    assert.deepEqual(f.store.upsertProposedPlanArtifact({ ...writePayload(changed), [field]: first }, LATER), changed);
    assert.deepEqual(f.facts(), settled, "identical metadata must not advance revision or updatedAt");
    conflict(f, () => f.store.updateProposedPlanArtifact(initial.id, { [field]: second,
      expectedRevision: initial.revision }, LATER));
  }
}

/** An action's optional top-level revision is authoritative before any side effect. */
function actionCas(f) {
  for (const kind of ["save", "archive", "accept", "convert-workflow", "refine"]) {
    const initial = draft(f, `action_cas_${kind}`);
    const current = f.store.updateProposedPlanArtifact(initial.id, { title: `current ${kind}`,
      expectedRevision: initial.revision }, NOW);
    conflict(f, () => action(f, initial.id, kind, { expectedRevision: initial.revision, ...workflowInput() }));
    for (const expectedRevision of [0, 1.5, "2", null]) {
      const before = f.facts();
      assert.throws(() => action(f, initial.id, kind, { expectedRevision, ...workflowInput() }),
        error => domainError(error, [400]));
      assert.deepEqual(f.facts(), before);
    }
    const result = action(f, initial.id, kind, { expectedRevision: current.revision, ...workflowInput() });
    assert.ok(result.plan);
    if (kind === "refine") {
      assert.equal(result.plan.parentPlanId, initial.id);
      const parent = f.store.getProposedPlanArtifact(initial.id);
      assert.equal(parent.revision, current.revision + 1);
      conflict(f, () => action(f, initial.id, kind, { expectedRevision: current.revision }));
      const settled = f.facts();
      assert.equal(action(f, initial.id, kind, { expectedRevision: parent.revision }).plan.id, result.plan.id);
      assert.deepEqual(f.facts(), settled);
    } else assert.equal(result.plan.revision, current.revision + 1);
  }
  const initial = draft(f, "snapshot_reference");
  const accepted = action(f, initial.id, "accept");
  const reference = { ...writePayload(accepted.plan), expectedRevision: accepted.plan.revision };
  const saved = action(f, initial.id, "save").plan;
  assert.equal(saved.revision, reference.expectedRevision + 1);
  const beforeReplay = f.facts();
  const replay = action(f, initial.id, "accept", { plan: reference, expectedRevision: saved.revision });
  assert.equal(replay.taskId, accepted.taskId);
  assert.deepEqual(replay.plan, saved);
  assert.deepEqual(f.facts(), beforeReplay, "a matching reference may carry an old nested metadata revision");
  conflict(f, () => action(f, initial.id, "accept", { plan: reference, expectedRevision: reference.expectedRevision }));
  assert.throws(() => action(f, initial.id, "accept", { plan: { ...reference, expectedRevision: 0 },
    expectedRevision: saved.revision }), error => domainError(error, [400]));
  assert.deepEqual(f.facts(), beforeReplay, "a nested reference token still has to be correctly formatted");
}

/** Both independent live connections capture the same revision before either writes. */
function twoConnections(f) {
  const initial = draft(f, "connections");
  const other = f.openStore().handle;
  assert.notEqual(other, f.store);
  const left = f.store.getProposedPlanArtifact(initial.id), right = other.getProposedPlanArtifact(initial.id);
  assert.deepEqual(left, right);
  const winner = f.store.updateProposedPlanArtifact(initial.id, { title: "first connection wins",
    expectedRevision: left.revision }, NOW);
  conflict(f, () => other.updateProposedPlanArtifact(initial.id, { bodyMarkdown: "stale second connection",
    expectedRevision: right.revision }, NOW));
  assert.deepEqual(other.getProposedPlanArtifact(initial.id), winner);
  assert.equal(winner.version, 1);
  assert.equal(winner.updatedAt, initial.updatedAt);
  const saved = other.updateProposedPlanArtifact(initial.id, { savedAt: LATER, expectedRevision: winner.revision }, NOW);
  assert.equal(saved.title, winner.title);
  assert.equal(saved.bodyMarkdown, winner.bodyMarkdown);
  assert.equal(saved.revision, winner.revision + 1);
  conflict(f, () => f.store.updateProposedPlanArtifact(initial.id, { savedAt: NOW, expectedRevision: winner.revision }, NOW));
  assert.deepEqual(f.store.getProposedPlanArtifact(initial.id), saved);
}

/** An archived acceptance remains sealed, including its sources and established IDs. */
function sealedArchive(f) {
  const original = draft(f, "sealed");
  const accepted = action(f, original.id, "accept").plan;
  const saved = action(f, original.id, "save").plan;
  assert.equal(saved.status, "accepted");
  assert.equal(saved.acceptedTaskId, accepted.acceptedTaskId);
  const archived = action(f, original.id, "archive").plan;
  assert.equal(archived.status, "archived");
  assert.deepEqual(sealedContent(archived), sealedContent(accepted));
  const patches = [
    { title: "rewrite archive" }, { bodyMarkdown: "rewrite archive" }, { version: archived.version + 1 },
    { status: "draft" }, { acceptedTaskId: null }, { acceptedAt: null }, { sourceMessageId: "forged_source" },
    { sourceAgentId: "forged_agent" }, { ownerAgentId: "forged_owner" }, { parentPlanId: "forged_parent" },
    { planGroupId: "forged_group" }, { supersededByPlanId: "forged_successor" },
  ];
  for (const patch of patches) {
    conflict(f, () => f.store.updateProposedPlanArtifact(archived.id, { ...patch, expectedRevision: archived.revision }, NOW));
  }
  conflict(f, () => f.store.upsertProposedPlanArtifact({ ...writePayload(archived), bodyMarkdown: "upsert archive rewrite",
    expectedRevision: archived.revision }, NOW));
  assert.deepEqual(f.store.getProposedPlanArtifact(archived.id), archived);
  const metadata = f.store.updateProposedPlanArtifact(archived.id, { savedAt: LATER, expectedRevision: archived.revision }, LATER);
  assert.equal(metadata.status, "archived");
  assert.deepEqual(sealedContent(metadata), sealedContent(accepted));
  assert.equal(metadata.revision, archived.revision + 1);
  conflict(f, () => f.store.updateProposedPlanArtifact(archived.id, { savedAt: NOW, expectedRevision: archived.revision }, LATER));
}

/** Normal accept/convert/save/archive remain usable and never execute a Run. */
function normalActions(f) {
  const original = draft(f, "normal");
  const accepted = action(f, original.id, "accept");
  const afterAccept = f.facts();
  assert.equal(afterAccept.tasks.length, 1);
  assert.equal(afterAccept.tasks[0].id, accepted.taskId);
  assert.match(afterAccept.tasks[0].prompt, /A26_BODY_normal/u);
  assert.equal(action(f, original.id, "accept").taskId, accepted.taskId);
  assert.deepEqual(f.facts(), afterAccept);
  const converted = action(f, original.id, "convert-workflow", workflowInput());
  assert.ok(converted.workflowId);
  assert.ok(converted.workflowStepId);
  assert.equal(converted.plan.acceptedTaskId, accepted.taskId);
  assert.equal(converted.plan.acceptedAt, accepted.plan.acceptedAt);
  const afterConvert = f.facts();
  assert.deepEqual(afterConvert.tasks, afterAccept.tasks);
  assert.equal(afterConvert.workflows.length, 1);
  assert.equal(afterConvert.steps.length, 2);
  assert.equal(afterConvert.steps.every(step => step.workflow_id === converted.workflowId), true);
  assert.equal(afterConvert.workflows[0].status, "draft");
  assert.equal(action(f, original.id, "convert-workflow", workflowInput()).workflowId, converted.workflowId);
  assert.deepEqual(f.facts(), afterConvert);
  const saved = action(f, original.id, "save", {}, LATER).plan;
  assert.equal(saved.savedAt, LATER);
  assert.equal(saved.acceptedTaskId, accepted.taskId);
  assert.equal(saved.acceptedWorkflowId, converted.workflowId);
  const archived = action(f, original.id, "archive", {}, LATER).plan;
  assert.equal(archived.status, "archived");
  assert.equal(archived.acceptedTaskId, accepted.taskId);
  assert.equal(archived.acceptedWorkflowId, converted.workflowId);
  assert.deepEqual(f.facts().tasks, afterAccept.tasks);
  const afterArchive = f.facts();
  assert.equal(action(f, original.id, "archive", {}, LATER).plan.id, original.id);
  assert.deepEqual(f.facts(), afterArchive);
  for (const patch of [{ acceptedWorkflowId: null }, { acceptedWorkflowStepId: null }]) {
    conflict(f, () => f.store.updateProposedPlanArtifact(original.id, { ...patch, expectedRevision: archived.revision }, NOW));
  }
}

/** Historical states allow Save/Refine and existing-ID replay, not new work on a parent. */
function historicalLifecycle(f) {
  for (const lifecycle of ["superseded", "archived"]) {
    const original = draft(f, `lifecycle_empty_${lifecycle}`);
    let child;
    if (lifecycle === "superseded") child = action(f, original.id, "refine").plan;
    else action(f, original.id, "archive");
    const historical = f.store.getProposedPlanArtifact(original.id);
    assert.equal(historical.status, lifecycle);
    assert.equal(historical.acceptedTaskId, undefined);
    assert.equal(historical.acceptedWorkflowId, undefined);
    conflict(f, () => action(f, original.id, "accept"));
    conflict(f, () => action(f, original.id, "convert-workflow", workflowInput()));
    const saved = action(f, original.id, "save", {}, LATER).plan;
    assert.equal(saved.status, lifecycle);
    assert.equal(saved.savedAt, LATER);
    assert.equal(saved.revision, historical.revision + 1);
    assert.deepEqual(sealedContent(saved), sealedContent(historical));
    const refined = action(f, original.id, "refine", {}, LATER).plan;
    if (child) assert.equal(refined.id, child.id, "a superseded parent permanently reuses its first child");
    child = refined;
    assert.equal(child.parentPlanId, original.id);
    assert.equal(child.status, "draft");
    assert.equal(f.store.getProposedPlanArtifact(original.id).status, lifecycle);
    const settled = f.facts();
    assert.equal(action(f, original.id, "refine", {}, LATER).plan.id, child.id);
    assert.deepEqual(f.facts(), settled);
    const accepted = action(f, child.id, "accept");
    assert.ok(accepted.taskId, "new acceptance must target the live child");
    const converted = action(f, child.id, "convert-workflow", workflowInput());
    assert.ok(converted.workflowId, "new conversion must target the live child");
    assert.equal(converted.plan.acceptedTaskId, accepted.taskId);
    assert.equal(f.store.getProposedPlanArtifact(original.id).acceptedTaskId, undefined);
  }
  for (const lifecycle of ["archived", "superseded"]) {
    const original = draft(f, `lifecycle_existing_${lifecycle}`);
    const accepted = action(f, original.id, "accept");
    const converted = action(f, original.id, "convert-workflow", workflowInput());
    if (lifecycle === "archived") action(f, original.id, "archive");
    else {
      // Only the owned fixture simulates a legacy superseded row with accepted IDs.
      f.sql(database => database.prepare("UPDATE ling_thread_proposed_plans SET status='superseded', revision=revision+1 WHERE id=?")
        .run(original.id));
    }
    const historical = f.store.getProposedPlanArtifact(original.id);
    const beforeReplay = f.facts();
    const replayAccept = action(f, original.id, "accept", {}, LATER);
    assert.equal(replayAccept.taskId, accepted.taskId);
    assert.deepEqual(replayAccept.plan, historical);
    assert.deepEqual(f.facts(), beforeReplay);
    const replayConvert = action(f, original.id, "convert-workflow", workflowInput(), LATER);
    assert.equal(replayConvert.workflowId, converted.workflowId);
    assert.equal(replayConvert.workflowStepId, converted.workflowStepId);
    assert.deepEqual(replayConvert.plan, historical);
    assert.deepEqual(f.facts(), beforeReplay, "historical existing-ID retries are read-only");
    const saved = action(f, original.id, "save", {}, LATER).plan;
    assert.equal(saved.status, lifecycle);
    assert.equal(saved.revision, historical.revision + 1);
    assert.deepEqual(sealedContent(saved), sealedContent(historical));
    const child = action(f, original.id, "refine", {}, LATER).plan;
    assert.equal(child.parentPlanId, original.id);
    assert.equal(child.status, "draft");
    assert.equal(child.acceptedTaskId, undefined);
    assert.equal(child.acceptedWorkflowId, undefined);
    assert.equal(f.store.getProposedPlanArtifact(original.id).status, lifecycle);
    const afterRefine = f.facts();
    assert.deepEqual(afterRefine.tasks, beforeReplay.tasks);
    assert.deepEqual(afterRefine.workflows, beforeReplay.workflows);
    assert.deepEqual(afterRefine.steps, beforeReplay.steps);
    assert.equal(action(f, original.id, "refine", {}, LATER).plan.id, child.id);
    assert.deepEqual(f.facts(), afterRefine);
  }
}

/** Existing action.plan is a snapshot, never a hidden draft editing/upsert channel. */
function snapshotConflicts(f) {
  for (const kind of ["save", "accept", "refine"]) {
    const old = draft(f, `snapshot_${kind}`);
    f.store.updateProposedPlanArtifact(old.id, { title: "canonical revised plan", bodyMarkdown: "canonical revision body",
      expectedRevision: old.revision }, NOW);
    const accepted = action(f, old.id, "accept").plan;
    conflict(f, () => action(f, old.id, kind, { plan: writePayload(old) }));
    assert.equal(f.store.getProposedPlanArtifact(old.id).acceptedTaskId, accepted.acceptedTaskId);
  }
}

/** The fault proves a real Task row exists before the acceptance-fact write fails. */
function taskRollback(f) {
  const original = draft(f, "task_fault");
  const before = f.facts();
  installTrigger(f, `CREATE TRIGGER a26_task_fault BEFORE UPDATE ON ling_thread_proposed_plans
    WHEN NEW.id = '${original.id}' AND NEW.accepted_task_id IS NOT NULL
    BEGIN SELECT CASE WHEN (SELECT COUNT(*) FROM tasks WHERE id=NEW.accepted_task_id)=1
      THEN RAISE(ABORT, 'A26 real Task exists before acceptance fault')
      ELSE RAISE(ABORT, 'A26 fixture did not observe the real Task') END; END;`);
  assert.throws(() => action(f, original.id, "accept"), /A26 real Task exists before acceptance fault/u);
  assert.deepEqual(f.facts(), before, "Task insertion and acceptance facts must roll back as one unit");
  dropTrigger(f, "a26_task_fault");
  assert.ok(action(f, original.id, "accept").taskId, "the same plan must remain usable after rollback");
}

/** Reject step two only after the real workflow and first real step are visible. */
function workflowRollback(f) {
  const original = draft(f, "workflow_fault");
  const before = f.facts();
  installTrigger(f, `CREATE TRIGGER a26_step_fault BEFORE INSERT ON channel_workflow_steps
    WHEN NEW.title = 'A26 workflow step two'
    BEGIN SELECT CASE WHEN (SELECT COUNT(*) FROM channel_workflows WHERE id=NEW.workflow_id)=1
      AND (SELECT COUNT(*) FROM channel_workflow_steps WHERE workflow_id=NEW.workflow_id)=1
      THEN RAISE(ABORT, 'A26 real workflow and first step exist before second step fault')
      ELSE RAISE(ABORT, 'A26 fixture did not observe workflow and first step') END; END;`);
  assert.throws(() => action(f, original.id, "convert-workflow", workflowInput()),
    /A26 real workflow and first step exist before second step fault/u);
  assert.deepEqual(f.facts(), before, "workflow, prior steps and plan metadata must all roll back");
  dropTrigger(f, "a26_step_fault");
  assert.ok(action(f, original.id, "convert-workflow", workflowInput()).workflowId);
}

/** Inserted child and parent pointer are atomic, not two independently durable writes. */
function childRollback(f) {
  const original = draft(f, "child_fault");
  const accepted = action(f, original.id, "accept").plan;
  const before = f.facts();
  installTrigger(f, `CREATE TRIGGER a26_child_fault BEFORE UPDATE ON ling_thread_proposed_plans
    WHEN NEW.id = '${original.id}' AND NEW.superseded_by_plan_id IS NOT NULL
    BEGIN SELECT CASE WHEN (SELECT COUNT(*) FROM ling_thread_proposed_plans
      WHERE id=NEW.superseded_by_plan_id AND parent_plan_id=NEW.id)=1
      THEN RAISE(ABORT, 'A26 real child exists before parent pointer fault')
      ELSE RAISE(ABORT, 'A26 fixture did not observe the real child') END; END;`);
  assert.throws(() => action(f, original.id, "refine"), /A26 real child exists before parent pointer fault/u);
  assert.deepEqual(f.facts(), before);
  assert.equal(f.store.getProposedPlanArtifact(original.id).acceptedTaskId, accepted.acceptedTaskId);
  dropTrigger(f, "a26_child_fault");
  assert.notEqual(action(f, original.id, "refine").plan.id, original.id);
}

/** Actual zero-changes SQL is a CAS rejection and must not commit its inserted child. */
function childCasRollback(f) {
  const original = draft(f, "child_cas_fault");
  const before = f.facts();
  installTrigger(f, `CREATE TRIGGER a26_child_cas_fault BEFORE UPDATE ON ling_thread_proposed_plans
    WHEN NEW.id = '${original.id}' AND NEW.superseded_by_plan_id IS NOT NULL
    BEGIN SELECT CASE WHEN (SELECT COUNT(*) FROM ling_thread_proposed_plans
      WHERE id=NEW.superseded_by_plan_id AND parent_plan_id=NEW.id)=1
      THEN RAISE(IGNORE) ELSE RAISE(ABORT, 'A26 fixture did not observe CAS child') END; END;`);
  conflict(f, () => action(f, original.id, "refine"));
  assert.deepEqual(f.facts(), before);
  dropTrigger(f, "a26_child_cas_fault");
}

/** A single direct child is permanent retry identity; continuation refines that child. */
function refineRetry(f) {
  const original = draft(f, "retry");
  const accepted = action(f, original.id, "accept").plan;
  const before = f.facts();
  const child = action(f, original.id, "refine").plan;
  assert.notEqual(child.id, original.id);
  assert.equal(child.parentPlanId, original.id);
  assert.equal(child.planGroupId, accepted.planGroupId);
  assert.equal(child.channelId, f.channel.id);
  assert.equal(child.version, accepted.version + 1);
  assert.equal(child.revision, 1);
  assert.equal(child.status, "draft");
  assert.equal(child.title, accepted.title);
  assert.equal(child.bodyMarkdown, accepted.bodyMarkdown);
  for (const key of ["acceptedTaskId", "acceptedWorkflowId", "acceptedWorkflowStepId", "acceptedRunId",
    "acceptedAt", "convertedAt", "archivedAt", "archivedReason", "savedAt", "supersededByPlanId"]) {
    assert.equal(child[key], undefined, `a draft successor must not inherit ${key}`);
  }
  const parent = f.store.getProposedPlanArtifact(original.id);
  assert.equal(parent.status, "accepted");
  assert.equal(parent.revision, accepted.revision + 1);
  assert.equal(parent.supersededByPlanId, child.id);
  assert.deepEqual(sealedContent(parent), sealedContent(accepted));
  const lineagePatches = [{ parentPlanId: null }, { parentPlanId: "forged_parent" },
    { planGroupId: "forged_group" }, { version: child.version + 1 }, { channelId: null }, { channelId: "forged_channel" },
    { goalId: "forged_goal" }, { sourceAgentId: "forged_source_agent" }, { ownerAgentId: "forged_owner" },
    { sourceTurnId: "forged_turn" }, { sourceMessageId: "forged_message" }, { sourceRunId: "forged_run" }];
  for (const patch of lineagePatches) {
    conflict(f, () => f.store.updateProposedPlanArtifact(child.id, { ...patch, expectedRevision: child.revision }, NOW));
    conflict(f, () => f.store.upsertProposedPlanArtifact({ ...writePayload(child), ...patch,
      expectedRevision: child.revision }, NOW));
  }
  const editedChild = f.store.updateProposedPlanArtifact(child.id, { title: "editable child title",
    bodyMarkdown: "editable child body", expectedRevision: child.revision }, NOW);
  assert.equal(editedChild.revision, child.revision + 1);
  assert.equal(editedChild.version, child.version);
  assert.equal(editedChild.parentPlanId, child.parentPlanId);
  assert.equal(editedChild.planGroupId, child.planGroupId);
  const settled = f.facts();
  assert.deepEqual(settled.tasks, before.tasks);
  assert.deepEqual(action(f, original.id, "refine").plan, editedChild,
    "parent retry must preserve the same child after its legitimate body/title edit");
  assert.deepEqual(f.facts(), settled);
  f.closeStore();
  const reopened = f.openStore().handle;
  const replay = reopened.applyProposedPlanArtifactAction(original.id, { threadId: f.thread.id, action: "refine" }, LATER);
  assert.deepEqual(replay.plan, editedChild);
  assert.deepEqual(f.facts(), settled);
  const grandchild = reopened.applyProposedPlanArtifactAction(child.id, { threadId: f.thread.id, action: "refine" }, LATER).plan;
  assert.equal(grandchild.parentPlanId, child.id);
  assert.equal(grandchild.version, child.version + 1);
  assert.equal(grandchild.title, editedChild.title);
  assert.equal(grandchild.bodyMarkdown, editedChild.bodyMarkdown);
  assert.equal(reopened.getProposedPlanArtifact(child.id).status, "superseded");
  assert.equal(reopened.getProposedPlanArtifact(original.id).status, "accepted");
  assert.deepEqual(f.facts().tasks, before.tasks);
  const afterGrandchild = f.facts();
  assert.equal(reopened.applyProposedPlanArtifactAction(original.id, { threadId: f.thread.id, action: "refine" }, LATER).plan.id, child.id);
  assert.deepEqual(f.facts(), afterGrandchild, "a parent never skips its direct child to return a grandchild");
}

/** Deliberately corrupt only fixture rows, never guess repairs for legacy pointers. */
function badSuccessor(f) {
  const original = draft(f, "bad_pointer");
  const unrelated = draft(f, "unrelated");
  for (const target of ["proposed_plan_a26_missing_child", unrelated.id]) {
    f.sql(database => database.prepare("UPDATE ling_thread_proposed_plans SET superseded_by_plan_id=? WHERE id=?")
      .run(target, original.id));
    conflict(f, () => action(f, original.id, "refine"));
  }
  for (const [group, version] of [[`${original.planGroupId}_wrong`, original.version + 1],
    [original.planGroupId, original.version + 5]]) {
    f.sql(database => {
      database.prepare("UPDATE ling_thread_proposed_plans SET parent_plan_id=?, plan_group_id=?, version=? WHERE id=?")
        .run(original.id, group, version, unrelated.id);
      database.prepare("UPDATE ling_thread_proposed_plans SET superseded_by_plan_id=? WHERE id=?").run(unrelated.id, original.id);
    });
    conflict(f, () => action(f, original.id, "refine"));
  }
  const otherThread = f.store.createLingThread({ kind: "channel_discussion", channelId: f.channel.id,
    title: "A26 other thread", objective: "Reject a cross-thread child", status: "open" }, NOW);
  const crossed = f.store.upsertProposedPlanArtifact({ id: "proposed_plan_a26_crossed", threadId: otherThread.id,
    title: "wrong scope", bodyMarkdown: "wrong scope" }, NOW);
  f.sql(database => {
    database.prepare("UPDATE ling_thread_proposed_plans SET parent_plan_id=?, plan_group_id=?, version=? WHERE id=?")
      .run(original.id, original.planGroupId, original.version + 1, crossed.id);
    database.prepare("UPDATE ling_thread_proposed_plans SET superseded_by_plan_id=? WHERE id=?").run(crossed.id, original.id);
  });
  conflict(f, () => action(f, original.id, "refine"));
}

/** Core action savepoints must not commit or roll back a caller's outer transaction. */
function nestedAction(f) {
  const original = draft(f, "nested");
  const before = f.facts();
  const database = f.store.database;
  assert.ok(database instanceof DatabaseSync, "use the actual Store's owned SQLite connection");
  database.exec("BEGIN IMMEDIATE");
  try {
    const accepted = action(f, original.id, "accept");
    assert.ok(accepted.taskId);
    assert.equal(f.store.getProposedPlanArtifact(original.id).acceptedTaskId, accepted.taskId);
    // A separate real reader still observes the old committed snapshot.
    assert.deepEqual(f.facts(), before);
  } finally {
    database.exec("ROLLBACK");
  }
  assert.deepEqual(f.facts(), before, "a successful nested action belongs to the caller's rollback");
  assert.ok(action(f, original.id, "accept").taskId);
}

/** Downgrade only the owned plan table/marker, then run the real full Store migration. */
function migration(f) {
  const original = draft(f, "migration");
  f.store.updateProposedPlanArtifact(original.id, { version: 7, bodyMarkdown: "legacy exact plan bytes\r\n",
    expectedRevision: original.revision }, NOW);
  action(f, original.id, "accept");
  const before = f.facts();
  f.closeStore();
  // Verified from proposed-plan-revision-migration.ts and schema_migrations DDL.
  const migrationVersion = 163, migrationName = "add_proposed_plan_revision";
  let otherMarkers;
  f.sql(database => {
    const markers = database.prepare("SELECT * FROM schema_migrations WHERE version=? OR name=?").all(migrationVersion, migrationName);
    assert.equal(markers.length, 1, "the exact revision marker must not collide with another version or name");
    const marker = markers[0];
    assert.equal(marker.version, migrationVersion);
    assert.equal(marker.name, migrationName);
    otherMarkers = database.prepare("SELECT * FROM schema_migrations WHERE version<>? ORDER BY version").all(migrationVersion).map(plain);
    database.exec("ALTER TABLE ling_thread_proposed_plans DROP COLUMN revision");
    assert.equal(database.prepare("DELETE FROM schema_migrations WHERE version=? AND name=?").run(marker.version, migrationName).changes, 1);
    assert.equal(database.prepare("PRAGMA table_info(ling_thread_proposed_plans)").all().some(row => row.name === "revision"), false);
  });
  const reopened = f.openStore();
  const migrated = reopened.handle.getProposedPlanArtifact(original.id);
  assert.equal(migrated.version, 7, "migration must not replace lineage version with revision");
  assert.equal(migrated.revision, 1);
  const after = f.facts();
  assert.deepEqual(withoutRevisions(after.plans), withoutRevisions(before.plans));
  assert.deepEqual(after.tasks, before.tasks);
  assert.deepEqual(after.workflows, before.workflows);
  assert.deepEqual(after.steps, before.steps);
  let migratedMarker, migratedColumns;
  f.sql(database => {
    migratedColumns = database.prepare("PRAGMA table_info(ling_thread_proposed_plans)").all().map(plain);
    const column = migratedColumns.find(row => row.name === "revision");
    assert.ok(column);
    assert.equal(column.notnull, 1);
    assert.equal(Number(column.dflt_value), 1);
    assert.deepEqual(database.prepare("SELECT * FROM schema_migrations WHERE version<>? ORDER BY version").all(migrationVersion).map(plain), otherMarkers);
    const markers = database.prepare("SELECT * FROM schema_migrations WHERE version=? OR name=?").all(migrationVersion, migrationName).map(plain);
    assert.equal(markers.length, 1);
    migratedMarker = markers[0];
    assert.equal(migratedMarker.version, migrationVersion);
    assert.equal(migratedMarker.name, migrationName);
    assert.equal(typeof migratedMarker.applied_at, "string");
    assert.ok(migratedMarker.applied_at.length > 0);
  });
  reopened.close();
  const again = f.openStore().handle;
  assert.deepEqual(again.getProposedPlanArtifact(original.id), migrated);
  assert.deepEqual(f.facts(), after);
  f.sql(database => {
    assert.deepEqual(database.prepare("SELECT * FROM schema_migrations WHERE version=? OR name=?")
      .all(migrationVersion, migrationName).map(plain), [migratedMarker]);
    assert.deepEqual(database.prepare("SELECT * FROM schema_migrations WHERE version<>? ORDER BY version")
      .all(migrationVersion).map(plain), otherMarkers);
    assert.deepEqual(database.prepare("PRAGMA table_info(ling_thread_proposed_plans)").all().map(plain), migratedColumns);
  });
}

function draft(f, suffix) {
  return f.store.upsertProposedPlanArtifact({ id: `proposed_plan_a26_${suffix}`, threadId: f.thread.id,
    title: `A26 ${suffix}`, bodyMarkdown: `A26_BODY_${suffix}`, status: "draft", version: 1 }, NOW);
}

function action(f, planId, kind, input = {}, now = NOW) {
  return f.store.applyProposedPlanArtifactAction(planId, { threadId: f.thread.id, action: kind, ...input }, now);
}

function workflowInput() {
  return { createdBy: "local-user", workflowTitle: "A26 workflow draft",
    workflowSteps: ["A26 workflow step one", "A26 workflow step two"] };
}

function writePayload(plan) {
  return { id: plan.id, threadId: plan.threadId, channelId: plan.channelId, goalId: plan.goalId,
    sourceAgentId: plan.sourceAgentId, ownerAgentId: plan.ownerAgentId, sourceTurnId: plan.sourceTurnId,
    sourceMessageId: plan.sourceMessageId, sourceRunId: plan.sourceRunId, parentPlanId: plan.parentPlanId,
    supersededByPlanId: plan.supersededByPlanId, planGroupId: plan.planGroupId, version: plan.version,
    title: plan.title, bodyMarkdown: plan.bodyMarkdown, status: plan.status };
}

function sealedContent(plan) {
  const { status, revision, updatedAt, savedAt, archivedAt, archivedReason, supersededByPlanId, ...content } = plan;
  return content;
}

function conflict(f, mutate) {
  const before = f.facts();
  assert.throws(mutate, error => domainError(error, [409]));
  assert.deepEqual(f.facts(), before, "a rejected mutation cannot leave any durable plan/Task/workflow/Run change");
}

function domainError(error, statuses) {
  assert.equal(error?.constructor?.name, "ProposedPlanMutationError");
  assert.equal(typeof error.code, "string");
  assert.ok(error.code.length > 0);
  assert.ok(statuses.includes(error.statusCode), `unexpected mutation error status ${error.statusCode}`);
  return true;
}

function installTrigger(f, sql) { f.sql(database => database.exec(sql)); }
function dropTrigger(f, name) { f.sql(database => database.exec(`DROP TRIGGER ${name}`)); }
function plain(row) { return { ...row }; }
function withoutRevisions(rows) { return rows.map(({ revision, ...row }) => row); }

function withDatabase(databasePath, callback) {
  const database = new DatabaseSync(databasePath);
  try { return callback(database); }
  finally { database.close(); }
}

function databaseFacts(databasePath) {
  return withDatabase(databasePath, database => {
    const rows = table => database.prepare(`SELECT * FROM ${table} ORDER BY id`).all().map(plain);
    return { plans: rows("ling_thread_proposed_plans"), tasks: rows("tasks"), workflows: rows("channel_workflows"),
      steps: rows("channel_workflow_steps"), runs: rows("run_sessions") };
  });
}
