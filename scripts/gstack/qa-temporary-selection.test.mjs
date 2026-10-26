import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { link, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { acquireResourceLease, initResourceWorkspace, RESOURCE_REVIEW_HOLD_NAME } from "./resource-workspace.mjs";
import { claimQaTemporarySelection, withQaTemporarySelection } from "./qa-temporary-selection.mjs";

const checksum = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

async function fixture(t) {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "gstack-qa-selection-test-")));
  const root = join(parent, "managed");
  await initResourceWorkspace({ root, storageMode: "local-bounded" });
  const lease = await acquireResourceLease(root);
  t.after(async () => {
    // Fixture-only bytes: no real bundle or external consumer is ever started.
    await rm(join(lease.scratchPath, RESOURCE_REVIEW_HOLD_NAME), { force: true });
    await lease.release();
    await rm(parent, { recursive: true, force: true });
  });
  const selectionDirectory = join(parent, "selection");
  await mkdir(selectionDirectory, { mode: 0o700 });
  const selectionPath = join(selectionDirectory, "gstack-desktop-selection.json");
  const previous = Buffer.from(' {"root":"/fixture-only-old-object","identity":{"key":"fixture"}} \n');
  await writeFile(selectionPath, previous, { flag: "wx", mode: 0o600 });
  const candidateRoot = join(lease.scratchPath, "candidate");
  await mkdir(candidateRoot, { mode: 0o700 });
  const candidate = { root: candidateRoot, identity: { manifestChecksum: "sha256:" + "a".repeat(64) } };
  return { parent, root, lease, previous, options: { selectionPath, expectedPreviousChecksum: checksum(previous), candidate, env: lease.env } };
}

test("owned selection survives async consumption and restores exact predecessor inode, mode and bytes", async t => {
  const { lease, previous, options } = await fixture(t), before = await lstat(options.selectionPath);
  let custody;
  const result = await withQaTemporarySelection(options, async selection => {
    custody = selection.custodyDirectory;
    await selection.checkpoint();
    assert.deepEqual(JSON.parse(await readFile(options.selectionPath, "utf8")), options.candidate);
    await assert.rejects(lease.release(), /scratch_retained_for_review/);
    await Promise.resolve();
    await selection.checkpoint();
    return "consumed";
  });
  assert.equal(result, "consumed");
  const after = await lstat(options.selectionPath);
  assert.equal(after.ino, before.ino); assert.equal(after.dev, before.dev);
  assert.equal(after.mode, before.mode); assert.equal(after.nlink, 1);
  assert.deepEqual(await readFile(options.selectionPath), previous);
  assert.equal(JSON.parse(await readFile(join(custody, "restoration.json"), "utf8")).releaseAuthorized, true);
  await assert.rejects(readFile(join(lease.scratchPath, RESOURCE_REVIEW_HOLD_NAME)), { code: "ENOENT" });
});

test("a consumer failure restores its own pointer then preserves the original exception", async t => {
  const { previous, options } = await fixture(t), failure = new Error("fixture consumer failed");
  await assert.rejects(withQaTemporarySelection(options, async selection => {
    await selection.checkpoint(); throw failure;
  }), error => error === failure);
  assert.deepEqual(await readFile(options.selectionPath), previous);
});

test("a replaced pointer is never overwritten on checkpoint or restore and keeps the resource lease", async t => {
  const { root, lease, previous, options } = await fixture(t);
  const selection = await claimQaTemporarySelection(options);
  const foreign = Buffer.from('{"root":"/fixture-foreign"}\n');
  await unlink(options.selectionPath);
  await writeFile(options.selectionPath, foreign, { mode: 0o600, flag: "wx" });
  await assert.rejects(selection.checkpoint(), /ownership_changed/);
  await assert.rejects(selection.restore(), /ownership_changed/);
  assert.deepEqual(await readFile(options.selectionPath), foreign);
  assert.deepEqual(await readFile(join(selection.custodyDirectory, "previous.json")), previous);
  await assert.rejects(lease.release(), /scratch_retained_for_review/);
  await assert.rejects(acquireResourceLease(root), /workspace_busy/);
});

test("same pointer bytes under a different inode are not accepted as owned", async t => {
  const { options } = await fixture(t), selection = await claimQaTemporarySelection(options);
  const bytes = await readFile(options.selectionPath);
  // Keep the old inode allocated so this cannot accidentally reuse its number.
  const retained = join(selection.custodyDirectory, "fixture-retained-candidate.json");
  await link(options.selectionPath, retained);
  await unlink(options.selectionPath);
  await writeFile(options.selectionPath, bytes, { flag: "wx", mode: 0o600 });
  await assert.rejects(selection.restore(), /ownership_changed/);
  assert.deepEqual(await readFile(options.selectionPath), bytes);
});

test("mutation of predecessor custody or hold cannot be interpreted as permission to restore or clean", async t => {
  for (const target of ["previous", "hold"]) {
    const { lease, options } = await fixture(t), selection = await claimQaTemporarySelection(options);
    const path = target === "previous" ? join(selection.custodyDirectory, "previous.json") : selection.holdPath;
    await writeFile(path, '{"fixture":"changed"}\n');
    await assert.rejects(selection.restore(), /ownership_changed/);
    await assert.rejects(lease.release(), /scratch_retained_for_review/);
    assert.deepEqual(JSON.parse(await readFile(options.selectionPath, "utf8")), options.candidate);
  }
});

test("consumption and restoration errors are both preserved without overwriting a foreign selection", async t => {
  const { options } = await fixture(t), failure = new Error("fixture first error");
  await assert.rejects(withQaTemporarySelection(options, async () => {
    await writeFile(options.selectionPath, '{"foreign":true}\n'); throw failure;
  }), error => error instanceof AggregateError && error.errors[0] === failure
    && /ownership_changed/.test(error.errors[1].message));
  assert.deepEqual(JSON.parse(await readFile(options.selectionPath, "utf8")), { foreign: true });
});

test("stale predecessor, outside-scratch candidate and unknown custody refuse before moving selection", async t => {
  for (const kind of ["stale", "outside", "existing"]) {
    const { previous, lease, options } = await fixture(t);
    const attempt = { ...options };
    if (kind === "stale") attempt.expectedPreviousChecksum = "sha256:" + "b".repeat(64);
    if (kind === "outside") attempt.candidate = { ...options.candidate, root: dirname(lease.scratchPath) };
    if (kind === "existing") await mkdir(join(dirname(options.selectionPath), `.gstack-qa-selection-${lease.env.LING_GSTACK_RESOURCE_TOKEN}`), { mode: 0o700 });
    await assert.rejects(claimQaTemporarySelection(attempt), /predecessor_changed|inputs_invalid|EEXIST/);
    assert.deepEqual(await readFile(options.selectionPath), previous);
  }
});

test("aliased parent, symlinked or multiply linked original selection are refused", async t => {
  for (const kind of ["parent", "file", "hardlink"]) {
    const { parent, previous, options } = await fixture(t), attempt = { ...options };
    if (kind === "parent") {
      const alias = join(parent, "alias");
      await symlink(dirname(options.selectionPath), alias);
      attempt.selectionPath = join(alias, "gstack-desktop-selection.json");
    } else if (kind === "file") {
      const original = join(parent, "original.json");
      await writeFile(original, previous, { mode: 0o600 });
      await unlink(options.selectionPath); await symlink(original, options.selectionPath);
    } else await link(options.selectionPath, join(parent, "extra-link.json"));
    await assert.rejects(claimQaTemporarySelection(attempt), /directory_invalid|file_invalid/);
    assert.deepEqual(await readFile(options.selectionPath), previous);
  }
});

test("the asynchronous body is never entered when the live resource lease cannot be authenticated", async t => {
  const { previous, options } = await fixture(t);
  let called = false;
  await assert.rejects(withQaTemporarySelection({ ...options, env: { ...options.env, LING_GSTACK_RESOURCE_TOKEN: "wrong" } },
    async () => { called = true; }), /lease_mismatch/);
  assert.equal(called, false);
  assert.deepEqual(await readFile(options.selectionPath), previous);
});

test("candidate bytes are captured before the caller can mutate inputs across the first await", async t => {
  const { options } = await fixture(t);
  const expected = structuredClone(options.candidate);
  const claiming = claimQaTemporarySelection(options);
  options.candidate.root = "/fixture-outside-scratch";
  options.candidate.identity.manifestChecksum = "sha256:" + "b".repeat(64);
  const selection = await claiming;
  assert.deepEqual(JSON.parse(await readFile(options.selectionPath, "utf8")), expected);
  await selection.checkpoint();
  await selection.restore();
});

test("lease environment is captured for both admission and later checkpoints", async t => {
  const { options } = await fixture(t);
  const env = { ...options.env };
  const claiming = claimQaTemporarySelection({ ...options, env });
  env.LING_GSTACK_RESOURCE_TOKEN = "changed-after-call";
  env.TMPDIR = "/fixture-outside-scratch";
  const selection = await claiming;
  env.LING_GSTACK_RESOURCE_ROOT = "/fixture-outside-workspace";
  await selection.checkpoint();
  await selection.restore();
});

test("concurrent restoration callers share one operation and cannot move the predecessor twice", async t => {
  const { previous, options } = await fixture(t);
  const selection = await claimQaTemporarySelection(options);
  const attempts = await Promise.allSettled(Array.from({ length: 8 }, () => selection.restore()));
  assert.deepEqual(attempts.map(attempt => attempt.status), Array(8).fill("fulfilled"));
  assert.deepEqual(await readFile(options.selectionPath), previous);
  assert.equal((await lstat(options.selectionPath)).nlink, 1);
});
