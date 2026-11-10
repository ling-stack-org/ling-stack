import assert from "node:assert/strict";
import fsPromises, { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireResourceLease, assertResourceBudget, initResourceWorkspace,
  managedResourceWrite, openResourceWorkspace, requireResourceLease } from "./resource-workspace.mjs";
import * as resourceWorkspace from "./resource-workspace.mjs";

test("capacity admission reserves the complete copy and free-space floor, never clone savings", () => {
  const limits = { budgetBytes: 100, minFreeBytes: 200 };
  assert.doesNotThrow(() => assertResourceBudget({ ...limits, usedBytes: 30, freeBytes: 270, additionalBytes: 70 }));
  assert.throws(() => assertResourceBudget({ ...limits, usedBytes: 31, freeBytes: 270, additionalBytes: 70 }), /workspace_budget/);
  assert.throws(() => assertResourceBudget({ ...limits, usedBytes: 30, freeBytes: 269, additionalBytes: 70 }), /free_space/);
  for (const additionalBytes of [-1, NaN, Infinity, "10"]) {
    assert.throws(() => assertResourceBudget({ ...limits, usedBytes: 0, freeBytes: 1000, additionalBytes }), /invalid_bytes/);
  }
});

async function workspace(t, { localOnly = false } = {}) {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "gstack-governance-test-")));
  const leases = [];
  t.after(async () => {
    for (const lease of leases) await lease.release();
    await rm(parent, { recursive: true, force: true });
  });
  const root = join(parent, "managed");
  await initResourceWorkspace(process.env.LING_GSTACK_TEST_MOUNT && !localOnly
    ? { root, mountPath: process.env.LING_GSTACK_TEST_MOUNT } : { root, storageMode: "local-bounded" });
  return { root, parent, async acquire(options) {
    const lease = await acquireResourceLease(root, options);
    leases.push(lease);
    return lease;
  } };
}

test("workspace initialization refuses an internal or missing volume without creating a root", async t => {
  const parent = await mkdtemp(join(tmpdir(), "gstack-mount-test-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, "managed");
  await assert.rejects(initResourceWorkspace({ root, mountPath: "/" }), /external_mount/);
  await assert.rejects(initResourceWorkspace({ root, mountPath: join(parent, "missing") }), /ENOENT/);
  assert.deepEqual(await readdir(parent), []);
});

test("one exclusive lease routes temporary and cache writes externally and refuses alternate roots", async t => {
  const { root, parent, acquire } = await workspace(t);
  const lease = await acquire({ additionalBytes: 1024 });
  assert.equal(lease.env.TMPDIR, join(lease.scratchPath, "tmp"));
  assert.equal(lease.env.BUN_INSTALL_CACHE_DIR, join(root, "cache/bun"));
  assert.equal(lease.env.HOME, join(lease.scratchPath, "home"));
  await assert.rejects(acquireResourceLease(root), /workspace_busy/);
  const alternate = process.env.LING_GSTACK_TEST_MOUNT ? await workspace(t) : { root: join(parent, "alternate") };
  if (!process.env.LING_GSTACK_TEST_MOUNT) await initResourceWorkspace({ root: alternate.root, storageMode: "local-bounded" });
  await assert.rejects(acquireResourceLease(alternate.root), /workspace_busy/);
  await assert.rejects(managedResourceWrite(join(parent, "escape"), { kind: "resource", env: lease.env }), /outside_workspace/);
  await assert.rejects(managedResourceWrite(join(root, "artifacts/resource/new"), { kind: "resource", env: {} }), /lease_required/);
  await assert.rejects(managedResourceWrite(join(root, "artifacts/resource/new"), { kind: "resource",
    env: { ...lease.env, LING_GSTACK_RESOURCE_TOKEN: "wrong" } }), /lease_mismatch/);
  await lease.release();
  const next = await acquireResourceLease(root);
  await next.release();
  assert.deepEqual(await readdir(join(root, "runs")), []);
});

test("retention refuses a third successful generation instead of inventing another v-number", async t => {
  const { root, parent, acquire } = await workspace(t);
  const lease = await acquire();
  const artifacts = join(root, "artifacts/resource");
  await mkdir(artifacts, { recursive: true });
  await mkdir(join(artifacts, "current"));
  await mkdir(join(artifacts, "previous"));
  await assert.rejects(managedResourceWrite(join(artifacts, "v-next"), { kind: "resource", env: lease.env }), /retention_limit/);
  await symlink(parent, join(lease.scratchPath, "alias"), "junction");
  await assert.rejects(managedResourceWrite(join(lease.scratchPath, "alias/escape"), { kind: "resource", env: lease.env }), /outside_workspace|path_alias/);
  await managedResourceWrite(join(lease.scratchPath, "fixture"), { kind: "resource", env: lease.env, additionalBytes: 32 });
  assert.deepEqual(await readdir(artifacts), ["current", "previous"]);
});

test("a changed storage receipt and abandoned scratch both fail closed", async t => {
  const { root } = await workspace(t);
  await mkdir(join(root, "runs/interrupted"));
  await assert.rejects(acquireResourceLease(root), /scratch_requires_review/);
  await rm(join(root, "runs/interrupted"), { recursive: true });
  const path = join(root, ".gstack-resource-workspace.json");
  const receipt = JSON.parse(await readFile(path, "utf8"));
  if (receipt.storageMode === "local-bounded") receipt.localParentInode += 1;
  else receipt.mountInode += 1;
  await writeFile(path, JSON.stringify(receipt));
  await assert.rejects(openResourceWorkspace(root), /(?:mount|local)_identity/);
});

test("a persistent external-consumer hold prevents scratch and lease removal until its owner clears it", async t => {
  const { root, acquire } = await workspace(t);
  const lease = await acquire(), hold = join(lease.scratchPath, ".retain-for-review.json");
  await writeFile(hold, JSON.stringify({ reason: "temporary selection still references this scratch" }), { flag: "wx", mode: 0o600 });
  try {
    await assert.rejects(lease.release(), /scratch_retained_for_review/);
    assert.equal(JSON.parse(await readFile(hold, "utf8")).reason, "temporary selection still references this scratch");
    await assert.rejects(acquireResourceLease(root), /workspace_busy/);
  } finally {
    // This isolated fixture owns the marker; no real selection was created.
    await rm(hold, { force: true });
  }
  await lease.release();
  assert.deepEqual(await readdir(join(root, "runs")), []);
});

test("the recovery gate accessor validates the workspace before returning its fixed sibling path", async t => {
  const { root, parent } = await workspace(t, { localOnly: true });
  assert.equal(typeof resourceWorkspace.resourceRecoveryGatePath, "function");
  assert.equal(await resourceWorkspace.resourceRecoveryGatePath(root),
    join(parent, `.ling-gstack-${process.platform}-${process.arch}.recovery-operation.json`));
  const sibling = join(parent, "alternate");
  await initResourceWorkspace({ root: sibling, storageMode: "local-bounded" });
  assert.equal(await resourceWorkspace.resourceRecoveryGatePath(sibling), await resourceWorkspace.resourceRecoveryGatePath(root));
  await assert.rejects(resourceWorkspace.resourceRecoveryGatePath(join(parent, "missing")), /ENOENT/);
  const receiptPath = join(root, ".gstack-resource-workspace.json");
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  receipt.target = "foreign-target";
  await writeFile(receiptPath, JSON.stringify(receipt));
  await assert.rejects(resourceWorkspace.resourceRecoveryGatePath(root), /mount_identity_mismatch/);
});

// Regression: QA recovery candidate must survive cancellation before selection.
test("an independent handoff hold vetoes release in every unknown-node shape", async t => {
  for (const kind of ["file", "directory", "dangling-symlink"]) await t.test(kind, async t => {
    const { root, parent, acquire } = await workspace(t, { localOnly: true });
    const lease = await acquire(), hold = join(lease.scratchPath, ".retain-recovered-executable.json");
    if (kind === "file") await writeFile(hold, "unreleased candidate", { flag: "wx", mode: 0o600 });
    if (kind === "directory") await mkdir(hold, { mode: 0o700 });
    if (kind === "dangling-symlink") await symlink(join(parent, "missing"), hold);
    const before = await lstat(hold);
    await assert.rejects(lease.release(), /scratch_retained_for_review/);
    assert.equal((await lstat(hold)).ino, before.ino);
    assert.equal((await requireResourceLease(lease.env)).root, root);
    await rm(hold, { recursive: kind === "directory", force: false });
    await lease.release();
  });
});

test("any unknown recovery-gate node refuses acquisition without deleting it or creating scratch", async t => {
  for (const kind of ["file", "directory", "dangling-symlink"]) await t.test(kind, async t => {
    const { root, parent, acquire } = await workspace(t, { localOnly: true });
    const gate = join(parent, `.ling-gstack-${process.platform}-${process.arch}.recovery-operation.json`);
    if (kind === "file") await writeFile(gate, "unknown recovery owner", { flag: "wx", mode: 0o600 });
    else if (kind === "directory") await mkdir(gate);
    else await symlink(join(parent, "missing-gate-target"), gate);
    const before = await lstat(gate);
    const heavy = join(parent, `.ling-gstack-${process.platform}-${process.arch}.heavy-operation.json`);
    const originalOpen = fsPromises.open;
    let opened = 0;
    const mocked = t.mock.method(fsPromises, "open", async (path, ...args) => {
      if (path === heavy) opened += 1;
      return originalOpen(path, ...args);
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(acquire(), /gstack_resource_recovery_in_progress/);
    } finally {
      mocked.mock.restore();
      syncBuiltinESMExports();
    }
    assert.equal(opened, 0);
    const after = await lstat(gate);
    assert.equal(after.dev, before.dev);
    assert.equal(after.ino, before.ino);
    assert.equal(after.mode, before.mode);
    if (kind === "file") assert.equal(await readFile(gate, "utf8"), "unknown recovery owner");
    assert.deepEqual(await readdir(join(root, "runs")), []);
    await assert.rejects(lstat(heavy), /ENOENT/);
  });
});

test("a recovery gate cannot replace or revoke a live normal lease", async t => {
  const { root, parent, acquire } = await workspace(t, { localOnly: true });
  const lease = await acquire();
  const heavy = join(parent, `.ling-gstack-${process.platform}-${process.arch}.heavy-operation.json`);
  const before = await readFile(heavy, "utf8");
  const gate = join(parent, `.ling-gstack-${process.platform}-${process.arch}.recovery-operation.json`);
  await writeFile(gate, "unknown recovery owner", { flag: "wx", mode: 0o600 });
  await assert.rejects(acquireResourceLease(root), /gstack_resource_recovery_in_progress/);
  assert.equal(await readFile(heavy, "utf8"), before);
  assert.equal((await requireResourceLease(lease.env)).token, lease.env.LING_GSTACK_RESOURCE_TOKEN);
  await lease.release();
  assert.equal(await readFile(gate, "utf8"), "unknown recovery owner");
  await assert.rejects(acquire(), /gstack_resource_recovery_in_progress/);
  assert.deepEqual(await readdir(join(root, "runs")), []);
});

test("a recovery gate inserted across the real heavy-lock open boundary stops admission before scratch", async t => {
  const { root, parent, acquire } = await workspace(t, { localOnly: true });
  const heavy = join(parent, `.ling-gstack-${process.platform}-${process.arch}.heavy-operation.json`);
  const gate = join(parent, `.ling-gstack-${process.platform}-${process.arch}.recovery-operation.json`);
  const originalOpen = fsPromises.open;
  const originalStatfs = fsPromises.statfs;
  let opened = 0, budgetWalks = 0;
  // Force the exact filesystem interleaving, without adding a production hook:
  // the first gate check has passed, and the exclusive heavy lock really opens.
  const mocked = t.mock.method(fsPromises, "open", async (path, ...args) => {
    const handle = await originalOpen(path, ...args);
    if (path === heavy) {
      opened += 1;
      await writeFile(gate, "recovery acquired during normal open", { flag: "wx", mode: 0o600 });
    }
    return handle;
  });
  const mockedStatfs = t.mock.method(fsPromises, "statfs", async (path, ...args) => {
    if (path === root) budgetWalks += 1;
    return originalStatfs(path, ...args);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(acquire(), /gstack_resource_recovery_in_progress/);
  } finally {
    mocked.mock.restore();
    mockedStatfs.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(opened, 1);
  assert.equal(budgetWalks, 0);
  assert.equal(await readFile(gate, "utf8"), "recovery acquired during normal open");
  assert.deepEqual(await readdir(join(root, "runs")), []);
  await assert.rejects(lstat(heavy), /ENOENT/);
});
