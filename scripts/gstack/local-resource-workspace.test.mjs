import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, rmdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireResourceLease, initResourceWorkspace, managedResourceWrite, openResourceWorkspace,
  requireResourceLease, RESOURCE_LIMITS } from "./resource-workspace.mjs";

async function fixture(t) {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "ling-gstack-local-")));
  const leases = [];
  t.after(async () => {
    for (const lease of leases) await lease.release();
    await rm(parent, { recursive: true, force: true });
  });
  return { parent, root: join(parent, "managed"), keepLease: lease => { leases.push(lease); return lease; } };
}

// Force filesystem interleavings without adding test hooks to the real API.
async function instrumentedWorkspace(overrides) {
  const source = await readFile(new URL("./resource-workspace.mjs", import.meta.url), "utf8");
  const key = `gstackResourceProbe${Math.random().toString(36).slice(2)}`;
  globalThis[key] = { ...fs, ...overrides };
  const imported = source.replace(/import \{ ([^}]+) \} from "node:fs\/promises";/,
    (_, names) => `const { ${names} } = globalThis[${JSON.stringify(key)}];`);
  assert.notEqual(source, imported);
  try { return await import(`data:text/javascript;base64,${Buffer.from(imported).toString("base64")}`); }
  finally { delete globalThis[key]; }
}

test("initialization failure preserves an independently replaced directory rather than cleaning unknown data", async t => {
  const { parent, root } = await fixture(t);
  let replaced = false;
  const api = await instrumentedWorkspace({ lstat: async path => {
    if (path === root && !replaced) {
      replaced = true;
      await fs.rename(root, join(parent, "actual-created"));
      await mkdir(root, { mode: 0o700 });
      await writeFile(join(root, "KEEP"), "replacement-owned");
      await writeFile(join(root, ".gstack-resource-workspace.json"), "existing marker");
    }
    return lstat(path);
  } });
  await assert.rejects(api.initResourceWorkspace({ root, storageMode: "local-bounded" }), { code: "EEXIST" });
  assert.equal(await readFile(join(root, "KEEP"), "utf8"), "replacement-owned");
});

test("receipt growth between identity check and read stays within a fixed 16KiB plus sentinel buffer", async t => {
  const { root } = await fixture(t);
  await initResourceWorkspace({ root, storageMode: "local-bounded" });
  const marker = join(root, ".gstack-resource-workspace.json");
  let readBytes = 0, grown = false;
  const api = await instrumentedWorkspace({ open: async (path, flags, ...args) => {
    const handle = await fs.open(path, flags, ...args);
    if (path !== marker || typeof flags !== "number") return handle;
    return new Proxy(handle, { get(target, name) {
      if (name === "read" || name === "readFile") return async (...readArgs) => {
        if (!grown) { grown = true; await fs.appendFile(marker, Buffer.alloc(64 * 1024, " ")); }
        const result = await target[name](...readArgs);
        readBytes += name === "readFile" ? result.length : result.bytesRead;
        return result;
      };
      const value = Reflect.get(target, name, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
  } });
  await assert.rejects(api.openResourceWorkspace(root), /workspace_receipt_invalid/);
  assert.ok(grown);
  assert.ok(readBytes > 0 && readBytes <= 16 * 1024 + 1, `read ${readBytes} bytes`);
});

test("pre-existing aliased cache cannot escape the managed budget or be deleted by failure cleanup", async t => {
  const { parent, root } = await fixture(t);
  await initResourceWorkspace({ root, storageMode: "local-bounded" });
  const sibling = join(parent, "outside-cache");
  await mkdir(sibling, { mode: 0o700 });
  await writeFile(join(sibling, "KEEP"), "unmanaged");
  await symlink(sibling, join(root, "cache/npm"));
  let unexpected;
  try { await assert.rejects(async () => { unexpected = await acquireResourceLease(root); }, /local_directory_invalid/); }
  finally { await unexpected?.release(); }
  assert.equal(await readFile(join(sibling, "KEEP"), "utf8"), "unmanaged");
  assert.equal((await lstat(join(root, "cache/npm"))).isSymbolicLink(), true);
});

test("bounded local storage is explicit; an omitted or invalid mode never falls back from external admission", async t => {
  const { parent, root } = await fixture(t);
  await assert.rejects(initResourceWorkspace({ root }), /external_mount_required/);
  await assert.rejects(initResourceWorkspace({ root, storageMode: "typo" }), /storage_mode_invalid/);
  await assert.rejects(initResourceWorkspace({ root, storageMode: "local-bounded", mountPath: parent }), /storage_mode_invalid/);
  assert.deepEqual(await readdir(parent), []);
});

test("explicit local initialization freezes private directory identity and the original byte limits", async t => {
  const { root } = await fixture(t);
  const record = await initResourceWorkspace({ root, storageMode: "local-bounded" });
  assert.equal(record.schemaVersion, 2);
  assert.equal(record.storageMode, "local-bounded");
  assert.equal(record.budgetBytes, RESOURCE_LIMITS.budgetBytes);
  assert.equal(record.minFreeBytes, RESOURCE_LIMITS.minFreeBytes);
  assert.equal((await lstat(root)).mode & 0o777, 0o700);
  assert.equal((await lstat(join(root, ".gstack-resource-workspace.json"))).mode & 0o777, 0o600);
  assert.deepEqual(await openResourceWorkspace(root), record);
});

test("eight local contenders and a different process share one parent lease, including sibling generations", async t => {
  const { parent, root, keepLease } = await fixture(t);
  await initResourceWorkspace({ root, storageMode: "local-bounded" });
  const sibling = join(parent, "other");
  await initResourceWorkspace({ root: sibling, storageMode: "local-bounded" });
  const attempts = await Promise.allSettled(Array.from({ length: 8 }, () => acquireResourceLease(root)));
  const accepted = attempts.filter(item => item.status === "fulfilled");
  for (const item of accepted) keepLease(item.value);
  assert.equal(accepted.length, 1);
  const lease = accepted[0].value;
  for (const item of attempts.filter(item => item.status === "rejected")) assert.match(item.reason.message, /workspace_busy/);
  await assert.rejects(acquireResourceLease(sibling), /workspace_busy/);
  const module = new URL("./resource-workspace.mjs", import.meta.url).href;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e",
    `import { acquireResourceLease } from ${JSON.stringify(module)};
     try { const lease = await acquireResourceLease(${JSON.stringify(sibling)}); await lease.release(); process.exitCode = 2; }
     catch (error) { if (!error.message.includes('workspace_busy')) throw error; }`],
  { encoding: "utf8", env: { PATH: process.env.PATH, LANG: "C" }, timeout: 10000 });
  assert.equal(child.status, 0, child.stderr);
  await requireResourceLease(lease.env);
  for (const key of ["TMPDIR", "TMP", "TEMP"]) assert.equal(lease.env[key], join(lease.scratchPath, "tmp"));
  assert.equal(lease.env.BUN_INSTALL_CACHE_DIR, join(root, "cache/bun"));
  await lease.release();
  const next = await acquireResourceLease(sibling);
  await next.release();
});

test("local initialization rejects public or aliased parents and never deletes a pre-existing destination", async t => {
  const { parent, root } = await fixture(t);
  await chmod(parent, 0o755);
  await assert.rejects(initResourceWorkspace({ root, storageMode: "local-bounded" }), /local_directory_invalid/);
  await chmod(parent, 0o700);
  await mkdir(root);
  await writeFile(join(root, "KEEP"), "user-owned");
  await assert.rejects(initResourceWorkspace({ root, storageMode: "local-bounded" }), { code: "EEXIST" });
  assert.equal(await readFile(join(root, "KEEP"), "utf8"), "user-owned");
  await symlink(parent, join(parent, "alias"));
  await assert.rejects(initResourceWorkspace({ root: join(parent, "alias/new"), storageMode: "local-bounded" }), /path_alias/);
  await assert.rejects(lstat(join(parent, "new")), { code: "ENOENT" });
});

test("local receipt, permissions and pinned directory changes reject reopening rather than adopting new authority", async t => {
  const { root } = await fixture(t);
  await initResourceWorkspace({ root, storageMode: "local-bounded" });
  const file = join(root, ".gstack-resource-workspace.json"), bytes = await readFile(file, "utf8");
  for (const change of [record => { record.budgetBytes++; }, record => { record.localParentInode++; },
    record => { record.workspaceInode++; }, record => { record.storageMode = "external-volume"; }]) {
    const record = JSON.parse(bytes); change(record);
    await writeFile(file, JSON.stringify(record));
    await assert.rejects(openResourceWorkspace(root), /identity_mismatch|storage_mode_invalid/);
  }
  await writeFile(file, bytes);
  await chmod(root, 0o755);
  await assert.rejects(openResourceWorkspace(root), /local_directory_invalid/);
  await chmod(root, 0o700);
  await link(file, join(root, "receipt-alias"));
  await assert.rejects(openResourceWorkspace(root), /workspace_receipt_invalid/);
});

test("an interrupted scratch directory stays blocked and a third retained generation is still refused", async t => {
  const { root, keepLease } = await fixture(t);
  await initResourceWorkspace({ root, storageMode: "local-bounded" });
  await mkdir(join(root, "runs/interrupted"));
  await assert.rejects(acquireResourceLease(root), /scratch_requires_review/);
  assert.deepEqual(await readdir(join(root, "runs")), ["interrupted"]);
  await rmdir(join(root, "runs/interrupted"));
  const lease = keepLease(await acquireResourceLease(root));
  await mkdir(join(root, "artifacts/resource"));
  for (const name of ["current", "previous"]) await mkdir(join(root, "artifacts/resource", name));
  await assert.rejects(managedResourceWrite(join(root, "artifacts/resource/third"), { kind: "resource", env: lease.env }), /retention_limit/);
  await symlink(root, join(lease.scratchPath, "alias"));
  await assert.rejects(managedResourceWrite(join(lease.scratchPath, "alias/escape"), { kind: "resource", env: lease.env }), /path_alias/);
  await assert.rejects(managedResourceWrite(join(root, "escape"), { kind: "resource", env: lease.env }), /outside_workspace/);
  assert.deepEqual(await readdir(join(root, "artifacts/resource")), ["current", "previous"]);
});
