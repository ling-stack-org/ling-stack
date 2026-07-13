import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createSqliteRunStore, planApplyPatch } from "../../core/dist/index.js";
import { buildWorkspaceFilePreview } from "../dist/features/previews/content-preview.js";
import { inspectWorkspaceChanges } from "../dist/features/previews/workspace-changes.js";
import {
  buildRunWorkspaceChangesResponse,
  recoverRunWorkspaceChanges,
} from "../dist/features/runs/workspace-change-recovery.js";
import { RunStoreRegistry } from "../dist/runtime/store-registry.js";
import { isAllowedLocalOrigin } from "../dist/shared/local-workspace-access.js";

const execFileAsync = promisify(execFile);

test("run patch changes can be undone and reapplied without overwriting later edits", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-run-patch-recovery-"));
  const store = createSqliteRunStore(cwd);
  const filePath = resolve(cwd, "src.txt");
  try {
    await writeFile(filePath, "old\n", "utf8");
    const plan = planApplyPatch({
      patchText: `*** Begin Patch
*** Update File: src.txt
@@
-old
+new
*** End Patch`,
      readFile: (path) => readFileSync(resolve(cwd, path), "utf8"),
    });
    await writeFile(filePath, "new\n", "utf8");

    const run = store.createRun({
      id: "run_workspace_recovery",
      cwd,
      taskId: "task_workspace_recovery",
      providerName: "test-provider",
      providerModel: "test-model",
      taskSnapshot: { id: "task_workspace_recovery", title: "Recover patch" },
      providerSnapshot: { provider: "test-provider", model: "test-model" },
      requestSnapshot: {
        cwd,
        effectivePolicySnapshot: {
          mode: "workspace_write",
          toolDecisions: {},
          allowedWritePaths: [cwd],
          workspacePolicyUpdatedAt: "2026-07-13T00:00:00.000Z",
          riskNotes: [],
        },
      },
      createdAt: "2026-07-13T00:00:00.000Z",
    });
    const approval = store.createApprovalRequest({
      runId: run.id,
      taskId: "task_workspace_recovery",
      toolCallId: "tool_patch_recovery",
      actionType: "edit",
      risk: "medium",
      title: "Edit src.txt",
      description: "Apply a reversible patch.",
      payload: {
        type: "file_edit",
        path: "src.txt",
        diffPreview: "-old\n+new",
        patchFormat: plan.format,
        touchedPaths: [...plan.touchedPaths],
        summary: { ...plan.summary },
        rawPatchSha256: plan.rawPatchSha256,
        patchPlan: {
          ...plan,
          touchedPaths: [...plan.touchedPaths],
          summary: { ...plan.summary },
          operations: plan.operations.map((operation) => ({
            ...operation,
            hunks: operation.hunks.map((hunk) => ({ ...hunk, lines: hunk.lines.map((line) => ({ ...line })) })),
          })),
        },
      },
    }, "2026-07-13T00:00:01.000Z");
    store.approveApprovalRequest(approval.id, { reason: "test", resolvedBy: "local-user" }, "2026-07-13T00:00:02.000Z");
    for (let index = 0; index < 1_005; index += 1) {
      store.appendEvent(run.id, "tool_update", { toolCallId: `tool_noise_${index}`, toolName: "read", index });
    }
    store.appendEvent(run.id, "tool_end", { toolCallId: "tool_patch_recovery", toolName: "edit", isError: false });
    store.markRunSucceeded(run.id, "2026-07-13T00:00:03.000Z");

    const applied = await buildRunWorkspaceChangesResponse(store, store.getRun(run.id));
    assert.equal(applied.state, "applied");
    assert.equal(applied.canUndo, true);

    const interruptedStore = new Proxy(store, {
      get(target, property) {
        if (property === "appendEvent") {
          return (eventRunId, type, data) => {
            if (type === "workspace_changes_undone") {
              throw new Error("simulated event persistence failure");
            }
            return target.appendEvent(eventRunId, type, data);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await assert.rejects(
      () => recoverRunWorkspaceChanges(interruptedStore, store.getRun(run.id), "undo"),
      /simulated event persistence failure/,
    );
    assert.equal(await readFile(filePath, "utf8"), "old\n");
    const undone = await buildRunWorkspaceChangesResponse(store, store.getRun(run.id));
    assert.equal(undone.state, "undone");
    assert.equal(undone.canReapply, true);

    const reapplied = await recoverRunWorkspaceChanges(store, store.getRun(run.id), "reapply");
    assert.equal(await readFile(filePath, "utf8"), "new\n");
    assert.equal(reapplied.state, "applied");
    assert.equal(reapplied.canUndo, true);

    store.updateApprovalPolicy({ allowedWritePaths: ["revoked"] }, "2026-07-13T00:00:04.000Z");
    await assert.rejects(
      () => recoverRunWorkspaceChanges(store, store.getRun(run.id), "undo"),
      /outside allowed write paths/,
    );
    assert.equal(await readFile(filePath, "utf8"), "new\n");
    store.updateApprovalPolicy({ allowedWritePaths: ["."] }, "2026-07-13T00:00:05.000Z");

    await writeFile(filePath, "user edit\n", "utf8");
    await assert.rejects(
      () => recoverRunWorkspaceChanges(store, store.getRun(run.id), "undo"),
      /changed after preview/,
    );
    assert.equal(await readFile(filePath, "utf8"), "user edit\n");
    const conflicted = await buildRunWorkspaceChangesResponse(store, store.getRun(run.id));
    assert.equal(conflicted.state, "conflicted");
    assert.equal(conflicted.canUndo, false);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("workspace review includes staged unstaged and untracked changes with context", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-workspace-review-"));
  try {
    await git(cwd, "init");
    await git(cwd, "config", "user.email", "test@example.com");
    await git(cwd, "config", "user.name", "Ling Test");
    await writeFile(resolve(cwd, "tracked.txt"), "one\ntwo\nthree\nfour\nfive\n", "utf8");
    await git(cwd, "add", "tracked.txt");
    await git(cwd, "commit", "-m", "initial");

    await writeFile(resolve(cwd, "tracked.txt"), "one\ntwo\nTHREE\nfour\nfive\n", "utf8");
    await writeFile(resolve(cwd, "staged.txt"), "staged\n", "utf8");
    await git(cwd, "add", "staged.txt");
    await writeFile(resolve(cwd, "untracked.txt"), "untracked\n", "utf8");
    await writeFile(resolve(cwd, "中文.txt"), "unicode\n", "utf8");
    await mkdir(resolve(cwd, "nested"));

    const review = await inspectWorkspaceChanges(resolve(cwd, "nested"), "2026-07-13T00:00:00.000Z");
    assert.equal(review.state, "dirty");
    assert.deepEqual(new Set(review.files.map((file) => file.path)), new Set(["tracked.txt", "staged.txt", "untracked.txt", "中文.txt"]));
    assert.equal(review.totalFileCount, 4);
    assert.equal(review.truncated, false);
    assert.equal(review.files.find((file) => file.path === "tracked.txt")?.unstaged, true);
    assert.equal(review.files.find((file) => file.path === "staged.txt")?.staged, true);
    assert.equal(review.files.find((file) => file.path === "untracked.txt")?.untracked, true);
    assert.match(review.files.find((file) => file.path === "tracked.txt")?.diff ?? "", / two\n-three\n\+THREE\n four/u);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("workspace review preserves staged changes when unstaged content returns to HEAD", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-workspace-review-layered-"));
  try {
    await git(cwd, "init");
    await git(cwd, "config", "user.email", "test@example.com");
    await git(cwd, "config", "user.name", "Ling Test");
    await writeFile(resolve(cwd, "layered.txt"), "HEAD\n", "utf8");
    await git(cwd, "add", "layered.txt");
    await git(cwd, "commit", "-m", "initial");

    await writeFile(resolve(cwd, "layered.txt"), "INDEX\n", "utf8");
    await git(cwd, "add", "layered.txt");
    await writeFile(resolve(cwd, "layered.txt"), "HEAD\n", "utf8");

    const review = await inspectWorkspaceChanges(cwd, "2026-07-13T00:00:00.000Z");
    const file = review.files.find((candidate) => candidate.path === "layered.txt");
    assert.equal(file?.staged, true);
    assert.equal(file?.unstaged, true);
    assert.equal(file?.truncated, false);
    assert.equal(file?.additions, 2);
    assert.equal(file?.deletions, 2);
    assert.match(file?.diff ?? "", /-HEAD\n\+INDEX/u);
    assert.match(file?.diff ?? "", /-INDEX\n\+HEAD/u);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("workspace review truncates large tracked diffs without losing stats", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-workspace-review-large-tracked-"));
  try {
    await git(cwd, "init");
    await git(cwd, "config", "user.email", "test@example.com");
    await git(cwd, "config", "user.name", "Ling Test");
    await writeFile(resolve(cwd, "large.txt"), "before\n".repeat(300_000), "utf8");
    await git(cwd, "add", "large.txt");
    await git(cwd, "commit", "-m", "initial");
    await writeFile(resolve(cwd, "large.txt"), "after\n".repeat(300_000), "utf8");

    const review = await inspectWorkspaceChanges(cwd, "2026-07-13T00:00:00.000Z");
    const file = review.files.find((candidate) => candidate.path === "large.txt");
    assert.equal(file?.truncated, true);
    assert.ok((file?.diff?.length ?? 0) > 0);
    assert.equal(file?.additions, 300_000);
    assert.equal(file?.deletions, 300_000);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("workspace review marks large untracked text previews as truncated", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-workspace-review-large-untracked-"));
  try {
    await git(cwd, "init");
    await writeFile(resolve(cwd, "large-untracked.txt"), "untracked line\n".repeat(40_000), "utf8");

    const review = await inspectWorkspaceChanges(cwd, "2026-07-13T00:00:00.000Z");
    const file = review.files.find((candidate) => candidate.path === "large-untracked.txt");
    assert.equal(file?.untracked, true);
    assert.equal(file?.truncated, true);
    assert.ok((file?.diff?.length ?? 0) > 0);
    assert.ok((file?.additions ?? 0) > 0);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("workspace review reports when the changed-file list is truncated", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-workspace-review-limit-"));
  try {
    await git(cwd, "init");
    await Promise.all(Array.from({ length: 161 }, (_, index) => writeFile(resolve(cwd, `file-${String(index).padStart(3, "0")}.txt`), `${index}\n`, "utf8")));
    const review = await inspectWorkspaceChanges(cwd, "2026-07-13T00:00:00.000Z");
    assert.equal(review.files.length, 160);
    assert.equal(review.totalFileCount, 161);
    assert.equal(review.truncated, true);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("workspace file preview returns a bounded window around the requested line", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-workspace-preview-line-"));
  const filePath = resolve(cwd, "large.txt");
  try {
    await writeFile(filePath, Array.from({ length: 400 }, (_, index) => `line ${index + 1}`).join("\n") + "\n", "utf8");
    const preview = await buildWorkspaceFilePreview({
      contentPath: filePath,
      displayPath: "large.txt",
      focusLine: 300,
      maxBytes: 64 * 1024,
    });
    assert.equal(preview.textStartLine, 210);
    assert.match(preview.text ?? "", /line 300/u);
    assert.doesNotMatch(preview.text ?? "", /line 100/u);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("workspace file line preview rejects invalid UTF-8", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-workspace-preview-invalid-"));
  const filePath = resolve(cwd, "invalid.txt");
  try {
    await writeFile(filePath, Buffer.from([0xff, 0xfe, 0x0a, 0x61]));
    const preview = await buildWorkspaceFilePreview({
      contentPath: filePath,
      displayPath: "invalid.txt",
      focusLine: 1,
      maxBytes: 64 * 1024,
    });
    assert.equal(preview.kind, "unsupported");
    assert.equal(preview.ref.previewable, false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("workspace review keeps an external symlink visible without following it", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-workspace-review-symlink-"));
  const outside = await mkdtemp(resolve(tmpdir(), "ling-stack-workspace-review-outside-"));
  try {
    await git(cwd, "init");
    await writeFile(resolve(outside, "target.txt"), "outside\n", "utf8");
    await symlink(resolve(outside, "target.txt"), resolve(cwd, "link.txt"));
    const review = await inspectWorkspaceChanges(cwd, "2026-07-13T00:00:00.000Z");
    const link = review.files.find((file) => file.path === "link.txt");
    assert.equal(review.state, "dirty");
    assert.equal(link?.untracked, true);
    assert.equal(link?.diff, undefined);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("local workspace access accepts only local browser origins and trusted roots", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-workspace-trust-"));
  const registry = new RunStoreRegistry((root) => createSqliteRunStore(root), { trustedWorkspaceRoots: [cwd] });
  try {
    await mkdir(resolve(cwd, "nested"));
    assert.equal(isAllowedLocalOrigin("http://127.0.0.1:5173"), true);
    assert.equal(isAllowedLocalOrigin("https://localhost:5173"), true);
    assert.equal(isAllowedLocalOrigin("https://example.com"), false);
    assert.equal(registry.isTrustedWorkspaceRoot(cwd), true);
    assert.equal(registry.isTrustedWorkspaceRoot(resolve(cwd, "nested")), true);
    assert.equal(registry.isTrustedWorkspaceRoot(resolve(cwd, "..")), false);
  } finally {
    registry.closeAll();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("run and artifact lookup use the persistent workspace store for execution cwd requests", async () => {
  const workspaceCwd = await mkdtemp(resolve(tmpdir(), "ling-stack-persistent-store-"));
  const executionCwd = resolve(workspaceCwd, "managed-worktree");
  const registry = new RunStoreRegistry((root) => createSqliteRunStore(root), { trustedWorkspaceRoots: [workspaceCwd] });
  try {
    await mkdir(executionCwd);
    const store = registry.getStore(workspaceCwd);
    const run = store.createRun({
      id: "run_persistent_store_lookup",
      cwd: executionCwd,
      taskId: "task_persistent_store_lookup",
      providerName: "test-provider",
      providerModel: "test-model",
      taskSnapshot: { id: "task_persistent_store_lookup", title: "Persistent store lookup" },
      providerSnapshot: { provider: "test-provider", model: "test-model" },
      requestSnapshot: { cwd: executionCwd, workspaceCwd },
      createdAt: "2026-07-13T00:00:00.000Z",
    });
    const artifactPath = resolve(store.paths.artifactsDir, "persistent-store.txt");
    await writeFile(artifactPath, "artifact\n", "utf8");
    const artifact = store.createArtifact({
      runId: run.id,
      type: "file",
      path: "persistent-store.txt",
      title: "Persistent store artifact",
      contentType: "text/plain",
      sizeBytes: 9,
      createdAt: "2026-07-13T00:00:01.000Z",
    });

    assert.equal(registry.findStoreForRun(run.id, executionCwd), store);
    assert.equal(registry.findStoreForArtifact(artifact.id, executionCwd)?.store, store);
    assert.equal(registry.findStoreForArtifact(artifact.id, executionCwd)?.artifact.id, artifact.id);
  } finally {
    registry.closeAll();
    await rm(workspaceCwd, { recursive: true, force: true });
  }
});

async function git(cwd, ...args) {
  await execFileAsync("git", args, { cwd });
}
