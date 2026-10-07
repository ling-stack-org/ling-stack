import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore, DEFAULT_WORKSPACE_ID, resolveSessionRunPolicy, toRuntimeAttemptFence } from "@ling-stack/core";
import { executeHarnessedFileMutationTool } from "../dist/features/harness/tool-execution/broker.js";
import { createFileMutationActionDraft } from "../dist/features/harness/tool-execution/executors/file-mutation.js";
import { buildWorkspaceChangeReview } from "../dist/features/runs/workspace-change-review.js";

/** Real broker, fenced Attempt, filesystem apply and SQLite provenance; no safety stubs. */
async function fixture(t, name) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-native-write-review-"));
  let store = createSqliteRunStore(cwd);
  t.after(async () => { store.close(); await rm(cwd, { recursive: true, force: true }); });
  const now = new Date().toISOString();
  const task = { id: `task-${name}`, title: "Native write review", prompt: "Write a synthetic fixture" };
  const runId = `run-${name}`;
  const unit = store.createWorkUnit({ workspaceId: DEFAULT_WORKSPACE_ID, kind: "task_run", ownerType: "run", ownerId: runId,
    idempotencyKey: `native-write-review-${name}`, status: "running", createdByActor: "system", request: {}, now });
  const attempt = store.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: 1, runtimeInstanceId: "native-write-review-runtime",
    runnerId: "pi", status: "started", now });
  store.createRun({ id: runId, cwd, workUnitId: unit.id, taskId: task.id, providerName: "test", providerModel: "test",
    taskSnapshot: task, providerSnapshot: {}, requestSnapshot: {}, createdAt: now });
  store.linkRunToWorkUnit(runId, unit.id, now);
  store.markRunStarted(runId, now);
  const sourceFence = toRuntimeAttemptFence(attempt);
  const effectivePolicySnapshot = resolveSessionRunPolicy({ workspacePolicy: store.getApprovalPolicy(),
    authorizationMode: "always", workspaceAccessMode: "workspace_write" }).snapshot;
  let call = 0;
  return {
    cwd,
    get store() { return store; },
    get run() { return store.getRun(runId); },
    restart() { store.close(); store = createSqliteRunStore(cwd); },
    review() { return buildWorkspaceChangeReview(store, { scope: { kind: "run", id: runId }, runs: [store.getRun(runId)] }); },
    async write(path, content, mode = "enforce") {
      const request = { toolCallId: `native-write-${++call}`, toolName: "write", cwd, task, input: { path, content } };
      const draft = createFileMutationActionDraft({ request, allowedWritePaths: [cwd] });
      const result = await executeHarnessedFileMutationTool({ mode, store, sourceFence, run: store.getRun(runId), request, draft,
        allowedWritePaths: [cwd], effectivePolicySnapshot, appendAndMaybeStream: (type, data) => store.appendEvent(runId, type, data) });
      assert.notEqual(result.isError, true, JSON.stringify(result));
      assert.equal(result.details.status, "applied");
      return draft;
    },
  };
}

for (const mode of ["off", "shadow", "enforce"]) {
  test(`absolute native write through the ${mode} production broker has immutable exact review`, async (t) => {
    const f = await fixture(t, `absolute-${mode}`);
    const path = join(f.cwd, "中文 project", "H2-result.json");
    const content = '{\n  "done": true\n}\n';
    await f.write(path, content, mode);
    assert.equal(await readFile(path, "utf8"), content);
    const [record] = f.store.listWorkspaceMutationRecords({ runId: f.run.id });
    const artifact = f.store.getArtifact(record.forwardPatchArtifactId);
    const snapshot = artifact.sealedPayload.workspaceReviewSnapshot;
    assert.equal(record.path, path, "review must not rewrite durable native path identity");
    assert.equal(snapshot.state, "exact");
    assert.equal(snapshot.files[0].path, path);
    assert.equal(snapshot.files[0].before, null);
    assert.equal(snapshot.files[0].after, content);
    const review = f.review();
    assert.equal(review.state, "exact", review.unavailableReason);
    assert.deepEqual(review.coveredPaths, ["中文 project/H2-result.json"]);
    assert.deepEqual(review.files.map((file) => [file.path, file.kind, file.additions, file.deletions]),
      [["中文 project/H2-result.json", "added", 3, 0]]);
    assert.equal(review.additions, 3);
    assert.equal(review.deletions, 0);
    assert.match(review.files[0].diff, /\/dev\/null/u);
    assert.match(review.files[0].diff, /\+  "done": true/u);
    assert.equal(f.store.listHarnessToolExecutions(f.run.id).length, mode === "off" ? 0 : 1);
  });
}

test("absolute and relative native writes use one initial/final diff, preserving both provenance identities", async (t) => {
  const f = await fixture(t, "aliases");
  const path = join(f.cwd, "same.txt");
  await writeFile(path, "baseline\n");
  await f.write(path, "intermediate\n");
  await f.write("same.txt", "final\n");
  const records = f.store.listWorkspaceMutationRecords({ runId: f.run.id });
  assert.deepEqual(records.map((record) => record.path), [path, "same.txt"]);
  const review = f.review();
  assert.equal(review.state, "exact", review.unavailableReason);
  assert.deepEqual(review.coveredPaths, ["same.txt"]);
  assert.equal(review.files.length, 1);
  assert.equal(review.additions, 1);
  assert.equal(review.deletions, 1);
  assert.match(review.files[0].diff, /-baseline\n\+final/u);
  assert.doesNotMatch(review.files[0].diff, /intermediate/u);
  assert.deepEqual(f.store.listWorkspaceMutationRecords({ runId: f.run.id }), records);
});

test("absolute native review survives restart and later disk drift without rewriting either", async (t) => {
  const f = await fixture(t, "restart");
  const path = join(f.cwd, "result.txt");
  await f.write(path, "historical result\n");
  const review = f.review();
  assert.equal(review.state, "exact", review.unavailableReason);
  const records = f.store.listWorkspaceMutationRecords({ runId: f.run.id });
  await writeFile(path, "later unrelated user edit\n");
  f.restart();
  assert.deepEqual(f.review(), review);
  assert.deepEqual(f.store.listWorkspaceMutationRecords({ runId: f.run.id }), records);
  assert.equal(await readFile(path, "utf8"), "later unrelated user edit\n");
});
