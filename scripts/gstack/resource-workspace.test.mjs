import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireResourceLease, assertResourceBudget, initResourceWorkspace,
  managedResourceWrite, openResourceWorkspace } from "./resource-workspace.mjs";

test("capacity admission reserves the complete copy and free-space floor, never clone savings", () => {
  const limits = { budgetBytes: 100, minFreeBytes: 200 };
  assert.doesNotThrow(() => assertResourceBudget({ ...limits, usedBytes: 30, freeBytes: 270, additionalBytes: 70 }));
  assert.throws(() => assertResourceBudget({ ...limits, usedBytes: 31, freeBytes: 270, additionalBytes: 70 }), /workspace_budget/);
  assert.throws(() => assertResourceBudget({ ...limits, usedBytes: 30, freeBytes: 269, additionalBytes: 70 }), /free_space/);
  for (const additionalBytes of [-1, NaN, Infinity, "10"]) {
    assert.throws(() => assertResourceBudget({ ...limits, usedBytes: 0, freeBytes: 1000, additionalBytes }), /invalid_bytes/);
  }
});

async function workspace(t) {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "gstack-governance-test-")));
  const leases = [];
  t.after(async () => {
    for (const lease of leases) await lease.release();
    await rm(parent, { recursive: true, force: true });
  });
  const root = join(parent, "managed");
  await initResourceWorkspace(process.env.LING_GSTACK_TEST_MOUNT
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
