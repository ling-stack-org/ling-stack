import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSqliteRunStore, planApplyPatch } from "@ling-stack/core";
import { applyPatchActionDraft, createPatchActionDraft } from "../dist/features/runs/patch-actions.js";
import { buildWorkspaceChangeReview } from "../dist/features/runs/workspace-change-review.js";
import { captureWorkspaceReviewSnapshot, hashReviewContent } from "../dist/features/runs/workspace-review-snapshot.js";
import { toPublicArtifactMetadata, projectPublicRunEventEnvelope } from "../dist/features/runs/public-artifacts.js";

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-net-review-"));
  let store = createSqliteRunStore(cwd);
  t.after(async () => { store.close(); await rm(cwd, { recursive: true, force: true }); });
  const run = (id) => store.createRun({ id, cwd, taskId: `task_${id}`, providerName: "test", providerModel: "test",
    taskSnapshot: { id: `task_${id}`, title: "Review" }, providerSnapshot: { provider: "test", model: "test" }, requestSnapshot: { cwd }, createdAt: "2026-10-01T00:00:00.000Z" });
  const apply = async (run, text) => {
    const patchText = `*** Begin Patch\n${text}\n*** End Patch`;
    const draft = createPatchActionDraft({ request: { toolName: "edit", cwd, input: { patchText } }, patchText, allowedWritePaths: [cwd] });
    const result = await applyPatchActionDraft({ draft, cwd, allowedWritePaths: [cwd], provenance: { store, run, toolCallId: `tool_${store.listWorkspaceMutationRecords({ runId: run.id }).length}` } });
    assert.notEqual(result.handledResult.isError, true, JSON.stringify(result.handledResult));
    assert.equal(result.handledResult.details.status, "applied");
    return draft;
  };
  const review = (runs) => buildWorkspaceChangeReview(store, { scope: { kind: "run", id: runs[0].id }, runs });
  return { cwd, run, apply, review, get store() { return store; }, restart() { store.close(); store = createSqliteRunStore(cwd); } };
}

test("same file edits use initial/final net diff, not summed patch counts; history survives disk changes and restart", async (t) => {
  const f = await fixture(t); const run = f.run("net");
  await writeFile(join(f.cwd, "app.txt"), "base\n");
  await f.apply(run, "*** Update File: app.txt\n@@\n-base\n+middle");
  await f.apply(run, "*** Update File: app.txt\n@@\n-middle\n+final");
  const before = f.review([run]);
  assert.equal(before.state, "exact");
  assert.equal(before.additions, 1); assert.equal(before.deletions, 1);
  assert.match(before.files[0].diff, /-base\n\+final/u); assert.doesNotMatch(before.files[0].diff, /middle/u);
  await writeFile(join(f.cwd, "app.txt"), "unrelated user WIP\n");
  f.restart();
  assert.deepEqual(f.review([run]), before);
  assert.equal(await readFile(join(f.cwd, "app.txt"), "utf8"), "unrelated user WIP\n");
});

test("edited then restored disappears; create then delete is a zero net change", async (t) => {
  const f = await fixture(t); const run = f.run("restore");
  await writeFile(join(f.cwd, "app.txt"), "base\n");
  await f.apply(run, "*** Update File: app.txt\n@@\n-base\n+middle");
  await f.apply(run, "*** Update File: app.txt\n@@\n-middle\n+base");
  await f.apply(run, "*** Add File: transient.txt\n+temporary");
  await f.apply(run, "*** Delete File: transient.txt");
  const review = f.review([run]);
  assert.equal(review.state, "exact"); assert.deepEqual(review.files, []);
  assert.deepEqual(review.coveredPaths, ["app.txt", "transient.txt"]);
  assert.equal(review.additions, 0); assert.equal(review.deletions, 0);
});

test("non-Git add/delete and same basename different paths have independent stable identities", async (t) => {
  const f = await fixture(t); const run = f.run("paths");
  await writeFile(join(f.cwd, "deleted.txt"), "one\ntwo\n");
  await f.apply(run, "*** Add File: src/file name.ts\n+one\n+two\n*** Add File: tests/file name.ts\n+test\n*** Delete File: deleted.txt");
  const review = f.review([run]);
  assert.equal(review.state, "exact"); assert.equal(review.additions, 3); assert.equal(review.deletions, 2);
  assert.deepEqual(review.files.map((file) => [file.path, file.kind]), [["src/file name.ts", "added"], ["tests/file name.ts", "added"], ["deleted.txt", "deleted"]]);
  assert.equal(new Set(review.files.map((file) => file.id)).size, 3);
  assert.match(review.files[0].diff, /\/dev\/null/u);
});

test("a child run excludes sibling changes; a same-workspace aggregate chains their actual operations", async (t) => {
  const f = await fixture(t); const a = f.run("child_a"); const b = f.run("child_b");
  await f.apply(a, "*** Add File: shared.txt\n+one");
  await f.apply(b, "*** Update File: shared.txt\n@@\n-one\n+two");
  assert.match(f.review([a]).files[0].diff, /\+one/u); assert.doesNotMatch(f.review([a]).files[0].diff, /two/u);
  assert.match(f.review([b]).files[0].diff, /-one\n\+two/u);
  assert.equal(f.review([a, b]).additions, 1); assert.equal(f.review([a, b]).deletions, 0);
});

test("an intervening outside-scope edit invalidates exact aggregation", async (t) => {
  const f = await fixture(t); const run = f.run("gap");
  await f.apply(run, "*** Add File: app.txt\n+first");
  await writeFile(join(f.cwd, "app.txt"), "outside\n");
  await f.apply(run, "*** Update File: app.txt\n@@\n-outside\n+last");
  const review = f.review([run]);
  assert.equal(review.state, "unavailable"); assert.equal(review.additions, undefined);
  assert.match(review.files[0].unavailableReason, /intervening/u);
});

test("old/missing snapshots, failed effects and corrupted hashes do not invent line counts", async (t) => {
  const f = await fixture(t); const run = f.run("invalid");
  await f.apply(run, "*** Add File: app.txt\n+first");
  const record = f.store.listWorkspaceMutationRecords({ runId: run.id })[0];
  for (const override of [{ forwardPatchArtifactId: undefined }, { beforeSha256: "wrong" }, { effectState: "effect_unknown" }, { effectState: "failed" }]) {
    const store = new Proxy(f.store, { get(target, key) { if (key === "listWorkspaceMutationRecords") return () => [{ ...record, ...override }]; const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value; } });
    const review = buildWorkspaceChangeReview(store, { scope: { kind: "run", id: run.id }, runs: [run] });
    assert.equal(review.state, "unavailable"); assert.equal(review.additions, undefined); assert.equal(review.files[0].diff, undefined);
  }
});

test("scope/cwd/workspace mismatches are rejected instead of mixing evidence", async (t) => {
  const f = await fixture(t); const run = f.run("scope");
  await f.apply(run, "*** Add File: app.txt\n+first");
  for (const input of [{ threadId: "other" }, { turnId: "other" }, { workspaceId: "other" }, { runs: [{ ...run, cwd: join(f.cwd, "elsewhere") }] }, { runs: [run, { ...run, id: "other", cwd: join(f.cwd, "elsewhere") }] }]) {
    const review = buildWorkspaceChangeReview(f.store, { scope: { kind: "run", id: run.id }, runs: [run], ...input });
    assert.equal(review.state, "unavailable"); assert.deepEqual(review.files, []);
  }
});

test("sealed full-file snapshots never appear in public artifact/event metadata; rendered diff redacts secrets", async (t) => {
  const f = await fixture(t); const run = f.run("secret");
  // Explicit synthetic placeholder that still matches the production secret redactor.
  const secret = "sk-EXAMPLE0000000000000000000000000000";
  await writeFile(join(f.cwd, "app.txt"), `private baseline\n${secret}\n`);
  await f.apply(run, "*** Update File: app.txt\n@@\n-private baseline\n+updated");
  const [record] = f.store.listWorkspaceMutationRecords({ runId: run.id });
  const artifact = f.store.getArtifact(record.forwardPatchArtifactId);
  assert.equal(artifact.sealedPayload.workspaceReviewSnapshot.files[0].before.includes(secret), true);
  assert.equal(JSON.stringify(toPublicArtifactMetadata(artifact)).includes(secret), false);
  // Use the real store envelope to exercise the existing public SSE adapter.
  const envelope = f.store.appendEvent(run.id, "artifact_created", { artifact });
  assert.equal(JSON.stringify(projectPublicRunEventEnvelope(envelope)).includes(secret), false);
  assert.equal(f.review([run]).files[0].diff.includes(secret), false);
  assert.equal(f.review([run]).additions, 1); assert.equal(f.review([run]).deletions, 1);
});

test("snapshot capture failure does not replace actual mutation error handling", async () => {
  const plan = planApplyPatch({ patchText: "*** Begin Patch\n*** Update File: app.txt\n@@\n-old\n+new\n*** End Patch", readFile: () => "old\n" });
  const snapshot = await captureWorkspaceReviewSnapshot(plan, new Map([["app.txt", "changed\n"]]));
  assert.equal(snapshot.state, "unavailable");
});

test("snapshot storage and read/diff budgets fail closed without fake zero statistics", async (t) => {
  const huge = "x".repeat(5 * 1024 * 1024);
  const plan = planApplyPatch({ patchText: `*** Begin Patch\n*** Add File: huge.txt\n+${huge}\n*** End Patch`, readFile: () => undefined });
  assert.equal((await captureWorkspaceReviewSnapshot(plan, new Map())).state, "unavailable");
  const f = await fixture(t); const run = f.run("budget");
  await f.apply(run, "*** Add File: app.txt\n+one");
  const [record] = f.store.listWorkspaceMutationRecords({ runId: run.id });
  const store = new Proxy(f.store, { get(target, key) { if (key === "listWorkspaceMutationRecords") return () => Array.from({ length: 2001 }, (_, index) => ({ ...record, id: `r${index}` })); const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value; } });
  assert.equal(buildWorkspaceChangeReview(store, { scope: { kind: "run", id: run.id }, runs: [run] }).state, "unavailable");
  assert.notEqual(hashReviewContent(null), hashReviewContent(""));
});

test("delete then recreate uses the original and final contents with stable Unicode path identity", async (t) => {
  const f = await fixture(t); const run = f.run("recreate");
  const path = "中文 file.txt";
  await writeFile(join(f.cwd, path), "original\n");
  await f.apply(run, `*** Delete File: ${path}`);
  await f.apply(run, `*** Add File: ${path}\n+final`);
  const review = f.review([run]);
  assert.equal(review.state, "exact");
  assert.deepEqual(review.files.map((file) => [file.path, file.kind, file.additions, file.deletions]), [[path, "modified", 1, 1]]);
  assert.match(review.files[0].diff, /-original\n\+final/u);
});

test("binary content has no fake line statistics while exact sibling changes remain reviewable", async (t) => {
  const f = await fixture(t); const run = f.run("binary");
  // The current patch parser rejects NUL bodies; project a matching immutable
  // mutation/snapshot pair to exercise the defensive historical-reader branch.
  await f.apply(run, "*** Add File: binary.dat\n+placeholder");
  await f.apply(run, "*** Add File: text.txt\n+text");
  const records = f.store.listWorkspaceMutationRecords({ runId: run.id });
  const binaryRecord = records.find((record) => record.path === "binary.dat");
  const binaryContent = "has\u0000binary\n";
  const store = new Proxy(f.store, { get(target, key) {
    if (key === "listWorkspaceMutationRecords") return () => records.map((record) => record.id === binaryRecord.id ? { ...record, afterSha256: hashReviewContent(binaryContent) } : record);
    if (key === "getArtifact") return (id) => {
      const artifact = target.getArtifact(id);
      return id === binaryRecord.forwardPatchArtifactId ? { ...artifact, sealedPayload: { ...artifact.sealedPayload, workspaceReviewSnapshot: { schemaVersion: 1, state: "exact", files: [{ path: "binary.dat", before: null, after: binaryContent }] } } } : artifact;
    };
    const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
  } });
  const review = buildWorkspaceChangeReview(store, { scope: { kind: "run", id: run.id }, runs: [run] });
  assert.equal(review.state, "partial");
  assert.equal(review.additions, undefined);
  const binary = review.files.find((file) => file.path === "binary.dat");
  assert.match(binary.unavailableReason, /Binary/u);
  assert.equal(binary.diff, undefined); assert.equal(binary.additions, undefined);
  assert.equal(review.files.find((file) => file.path === "text.txt").additions, 1);
});

test("oversized historical text diff is unavailable instead of sending unbounded output", async (t) => {
  const f = await fixture(t); const run = f.run("large_diff");
  await f.apply(run, `*** Add File: large.txt\n+${"x".repeat(600 * 1024)}`);
  const review = f.review([run]);
  assert.equal(review.state, "unavailable");
  assert.equal(review.additions, undefined); assert.equal(review.files[0].diff, undefined);
  assert.match(review.files[0].unavailableReason, /display budget/u);
});

/** Remap only lexical provenance to exercise non-native OS semantics, never disk content. */
function remapReviewProvenance(f, run, cwd, path, artifactOverride = {}, runOverride = {}) {
  const [record] = f.store.listWorkspaceMutationRecords({ runId: run.id });
  const store = new Proxy(f.store, { get(target, key) {
    if (key === "listWorkspaceMutationRecords") return () => [{ ...record, cwd, path }];
    if (key === "getArtifact") return (id) => {
      const artifact = target.getArtifact(id);
      return id === record.forwardPatchArtifactId ? { ...artifact, sealedPayload: { ...artifact.sealedPayload,
        workspaceReviewSnapshot: { ...artifact.sealedPayload.workspaceReviewSnapshot,
          files: artifact.sealedPayload.workspaceReviewSnapshot.files.map((file) => ({ ...file, path })), ...artifactOverride } } } : artifact;
    };
    const value = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  return buildWorkspaceChangeReview(store, { scope: { kind: "run", id: run.id }, runs: [{ ...run, cwd, ...runOverride }] });
}

test("Host-captured private worktree root permits project diffs but not its internal metadata or siblings", async (t) => {
  const f = await fixture(t); const run = f.run("private-managed-review");
  await f.apply(run, "*** Add File: original.txt\n+historical");
  const cwd = "/captured/workspace/.ling-stack/worktrees/teammates/engineer/dm-proof";
  const snapshot = { mode: "managed_worktree", status: "ready", workspaceCwd: "/captured/workspace",
    executionCwd: cwd, worktreePath: cwd };
  const owner = { teammateId: "engineer", requestSnapshot: { ...run.requestSnapshot,
    teammateId: "engineer", directWorkspaceSnapshot: snapshot } };
  for (const path of ["src/file.txt", `${cwd}/src/file.txt`]) {
    const review = remapReviewProvenance(f, run, cwd, path, {}, owner);
    assert.equal(review.state, "exact", review.unavailableReason);
    assert.deepEqual(review.coveredPaths, ["src/file.txt"]);
    assert.equal(review.additions, 1); assert.equal(review.deletions, 0);
  }
  for (const path of [".ling-stack/internal.txt", `${cwd}/.LING-STACK/internal.txt`,
    `${cwd}-sibling/file.txt`, "../sibling/file.txt", "src/../file.txt"]) {
    const review = remapReviewProvenance(f, run, cwd, path, {}, owner);
    assert.equal(review.state, "unavailable", path);
    assert.deepEqual(review.files, []); assert.equal(review.additions, undefined);
  }
  for (const override of [
    {},
    { ...owner, teammateId: "other" },
    { ...owner, requestSnapshot: { ...owner.requestSnapshot, directWorkspaceSnapshot: { ...snapshot, mode: "local" } } },
    { ...owner, requestSnapshot: { ...owner.requestSnapshot, directWorkspaceSnapshot: { ...snapshot, executionCwd: `${cwd}-sibling` } } },
    { ...owner, requestSnapshot: { ...owner.requestSnapshot, directWorkspaceSnapshot: { ...snapshot, worktreePath: `${cwd}-sibling` } } },
  ]) {
    const review = remapReviewProvenance(f, run, cwd, "src/file.txt", {}, override);
    assert.equal(review.state, "unavailable"); assert.deepEqual(review.files, []);
  }
});

test("absolute review projection preserves POSIX and Windows captured-root semantics", async (t) => {
  const f = await fixture(t); const run = f.run("path-semantics");
  await f.apply(run, "*** Add File: original.txt\n+historical");
  const cases = [
    ["/captured/workspace", "/captured/workspace/中文 file.txt", "中文 file.txt"],
    ["C:\\captured\\workspace", "C:\\captured\\workspace\\nested\\中文 file.txt", "nested/中文 file.txt"],
    ["C:\\captured\\workspace", "c:/captured/workspace/nested/file.txt", "nested/file.txt"],
    ["C:\\captured\\workspace", "nested\\file.txt", "nested/file.txt"],
    ["\\\\server\\share\\workspace", "\\\\server\\share\\workspace\\nested\\file.txt", "nested/file.txt"],
    ["//server/share/workspace", "//server/share/workspace/nested/file.txt", "nested/file.txt"],
  ];
  for (const [cwd, path, expected] of cases) {
    const review = remapReviewProvenance(f, run, cwd, path);
    assert.equal(review.state, "exact", `${cwd}: ${path}: ${review.unavailableReason}`);
    assert.deepEqual(review.coveredPaths, [expected]);
    assert.equal(review.files[0].path, expected);
    assert.equal(review.additions, 1);
    assert.equal(review.deletions, 0);
  }
});

test("review rejects outside, sibling-prefix, traversal, internal and malformed paths without fake statistics", async (t) => {
  const f = await fixture(t); const run = f.run("unsafe-paths");
  await f.apply(run, "*** Add File: original.txt\n+historical");
  const cases = [
    ["/captured/workspace", "/outside/file.txt"],
    ["/captured/workspace", "/captured/workspace-sibling/file.txt"],
    ["/captured/workspace", "../outside.txt"],
    ["/captured/workspace", "nested/../file.txt"],
    ["/captured/workspace", "/captured/workspace/nested/../file.txt"],
    ["/captured/workspace", "/captured/workspace/.ling-stack/internal.txt"],
    ["/captured/workspace", "nested/.ling-stack/internal.txt"],
    ["/captured/workspace", "/captured/workspace/.LING-STACK/internal.txt"],
    ["/captured/workspace", "nested/.LING-STACK/internal.txt"],
    ["/captured/workspace", "nul\0.txt"],
    ["/captured/workspace", "header\n+++ forged.txt"],
    ["/captured/workspace", "header\rforged.txt"],
    ["/captured/workspace", "C:\\foreign\\file.txt"],
    ["/captured/workspace", "literal\\name.txt"],
    ["/captured/../workspace", "file.txt"],
    ["/captured/.LING-STACK", "internal.txt"],
    ["/captured/header\nforged", "file.txt"],
    ["C:\\captured\\workspace", "C:\\outside\\file.txt"],
    ["C:\\captured\\workspace", "C:\\captured\\workspace-sibling\\file.txt"],
    ["C:\\captured\\workspace", "D:\\captured\\workspace\\file.txt"],
    ["C:\\captured\\workspace", "C:file.txt"],
    ["C:\\captured\\workspace", "\\captured\\workspace\\file.txt"],
    ["C:\\captured\\workspace", "nested\\..\\file.txt"],
    ["C:\\captured\\workspace", "C:\\captured\\workspace\\.LING-STACK\\internal.txt"],
    ["C:\\captured\\workspace", "nul\0.txt"],
    ["C:\\captured\\workspace", "file.txt:stream"],
    ["C:\\captured\\workspace", "nested\\file.txt."],
    ["C:\\captured\\workspace", "nested\\file.txt "],
    ["C:\\captured\\workspace", ".ling-stack.\\internal.txt"],
    ["C:\\captured\\workspace", ".ling-stack \\internal.txt"],
    ["C:\\captured\\workspace\\..\\root", "file.txt"],
    ["C:\\captured\\workspace ", "file.txt"],
    ["C:\\captured\\.LING-STACK", "internal.txt"],
    ["C:\\captured\\workspace", "\\\\?\\C:\\captured\\workspace\\file.txt"],
    ["C:\\captured\\workspace", "\\\\.\\C:\\captured\\workspace\\file.txt"],
    ["\\\\server\\share\\workspace", "\\\\server\\other-share\\workspace\\file.txt"],
    ["\\\\server\\share\\workspace", "\\\\other-server\\share\\workspace\\file.txt"],
    ["\\\\server\\share\\workspace", "\\\\server\\share\\workspace-sibling\\file.txt"],
  ];
  for (const [cwd, path] of cases) {
    const review = remapReviewProvenance(f, run, cwd, path);
    assert.equal(review.state, "unavailable", `${cwd}: ${path}`);
    assert.deepEqual(review.files, [], `${cwd}: ${path}`);
    assert.deepEqual(review.coveredPaths, []);
    assert.equal(review.additions, undefined);
    assert.equal(review.deletions, undefined);
    assert.match(review.unavailableReason, /non-reviewable path/u);
  }
});

test("normalizing an absolute display path never relaxes raw snapshot identity, uniqueness or hashes", async (t) => {
  const f = await fixture(t); const run = f.run("absolute-integrity");
  await f.apply(run, "*** Add File: original.txt\n+historical");
  const cwd = "/captured/workspace";
  const path = `${cwd}/original.txt`;
  const file = { path, before: null, after: "historical\n" };
  for (const files of [
    [{ ...file, path: "original.txt" }],
    [file, file],
    [{ ...file, before: "unexpected baseline\n" }],
    [{ ...file, after: "tampered result\n" }],
  ]) {
    const review = remapReviewProvenance(f, run, cwd, path, { files });
    assert.equal(review.state, "unavailable");
    assert.equal(review.files.length, 1);
    assert.equal(review.files[0].path, "original.txt");
    assert.equal(review.files[0].diff, undefined);
    assert.equal(review.additions, undefined);
    assert.equal(review.deletions, undefined);
    assert.match(review.files[0].unavailableReason, /fingerprints/u);
  }
});
