import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, realpath, rm, stat, statfs } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

const GiB = 1024 ** 3;
export const RESOURCE_LIMITS = Object.freeze({ budgetBytes: 12 * GiB, minFreeBytes: 20 * GiB });
const marker = ".gstack-resource-workspace.json";
const lockName = ".heavy-operation.json";
const lockPath = record => join(record.mountPath, `.ling-gstack-${record.target}${lockName}`);
export const within = (root, path) => {
  const suffix = relative(root, path);
  return !suffix || !isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`);
};

export function assertResourceBudget({ usedBytes, freeBytes, additionalBytes = 0,
  budgetBytes = RESOURCE_LIMITS.budgetBytes, minFreeBytes = RESOURCE_LIMITS.minFreeBytes }) {
  for (const value of [usedBytes, freeBytes, additionalBytes, budgetBytes, minFreeBytes]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("gstack_resource_invalid_bytes");
  }
  if (usedBytes + additionalBytes > budgetBytes) throw new Error("gstack_resource_workspace_budget_exceeded");
  if (freeBytes - additionalBytes < minFreeBytes) throw new Error("gstack_resource_free_space_insufficient");
}

async function canonicalDestination(path) {
  const suffix = [];
  let parent = resolve(path);
  while (true) {
    try { return join(await realpath(parent), ...suffix); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      suffix.unshift(basename(parent));
      parent = dirname(parent);
    }
  }
}

async function externalMount(mountPath, hostPath) {
  if (!mountPath || !isAbsolute(mountPath)) throw new Error("gstack_resource_external_mount_required");
  const path = resolve(mountPath);
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path ||
    info.dev === (await stat(hostPath)).dev ||
    dirname(path) !== path && info.dev === (await stat(dirname(path))).dev) {
    throw new Error("gstack_resource_external_mount_required");
  }
  return { mountPath: path, mountDevice: info.dev, mountInode: info.ino };
}

export async function initResourceWorkspace({ root, mountPath }) {
  const hostPath = await realpath(homedir());
  const mount = await externalMount(mountPath, hostPath);
  const path = resolve(root);
  if (!within(mount.mountPath, path) || path === mount.mountPath || await canonicalDestination(path) !== path) {
    throw new Error("gstack_resource_workspace_path_alias");
  }
  const volume = await statfs(mount.mountPath);
  assertResourceBudget({ usedBytes: 0, freeBytes: volume.bavail * volume.bsize });
  await mkdir(path);
  const record = { schemaVersion: 1, owner: "ling-gstack-build", root: path, target: `${process.platform}-${process.arch}`,
    hostPath, ...mount, ...RESOURCE_LIMITS };
  try {
    const file = await open(join(path, marker), "wx", 0o600);
    try { await file.writeFile(`${JSON.stringify(record, null, 2)}\n`); }
    finally { await file.close(); }
    for (const name of ["artifacts", "cache", "runs"]) await mkdir(join(path, name));
  } catch (error) {
    // Only this just-created empty workspace is ours; never clean an existing root.
    await rm(path, { recursive: true, force: true });
    throw error;
  }
  return record;
}

export async function openResourceWorkspace(root) {
  if (!root || !isAbsolute(root)) throw new Error("gstack_resource_workspace_required");
  const path = resolve(root);
  if (await realpath(path) !== path || !(await lstat(path)).isDirectory()) throw new Error("gstack_resource_workspace_path_alias");
  const record = JSON.parse(await readFile(join(path, marker), "utf8"));
  if (!record.hostPath || !isAbsolute(record.hostPath)) throw new Error("gstack_resource_mount_identity_mismatch");
  const mount = await externalMount(record.mountPath, record.hostPath);
  if (record.schemaVersion !== 1 || record.owner !== "ling-gstack-build" || record.root !== path ||
    record.target !== `${process.platform}-${process.arch}` || !within(mount.mountPath, path) ||
    record.mountDevice !== mount.mountDevice || record.mountInode !== mount.mountInode ||
    record.budgetBytes !== RESOURCE_LIMITS.budgetBytes || record.minFreeBytes !== RESOURCE_LIMITS.minFreeBytes ||
    (await stat(path)).dev !== mount.mountDevice) throw new Error("gstack_resource_mount_identity_mismatch");
  for (const name of ["artifacts", "cache", "runs"]) {
    const child = join(path, name);
    if (await realpath(child) !== child || !(await lstat(child)).isDirectory()) throw new Error("gstack_resource_workspace_path_alias");
  }
  return record;
}

// Logical bytes deliberately do not assume APFS clone sharing or sparse-file savings.
export async function resourceTreeBytes(path) {
  const info = await lstat(path);
  if (!info.isDirectory()) return info.size;
  let size = info.size;
  for (const entry of await readdir(path)) {
    size += await resourceTreeBytes(join(path, entry)).catch(error => { if (error.code === "ENOENT") return 0; throw error; });
  }
  return size;
}

export async function resourceCheckpoint(root, additionalBytes = 0) {
  const record = await openResourceWorkspace(root);
  const free = await statfs(root);
  const usedBytes = await resourceTreeBytes(root);
  const freeBytes = free.bavail * free.bsize;
  assertResourceBudget({ ...record, usedBytes, freeBytes, additionalBytes });
  return { usedBytes, freeBytes, additionalBytes };
}

export async function acquireResourceLease(root, { additionalBytes = 0 } = {}) {
  const record = await openResourceWorkspace(root);
  root = record.root;
  const path = lockPath(record);
  let handle;
  try { handle = await open(path, "wx", 0o600); }
  catch (error) { if (error.code === "EEXIST") throw new Error("gstack_resource_workspace_busy; inspect owner before stale-lock recovery"); throw error; }
  const token = randomUUID();
  const scratchPath = join(root, "runs", token);
  let released = false;
  try {
    if ((await readdir(join(root, "runs"))).length) throw new Error("gstack_resource_scratch_requires_review");
    await resourceCheckpoint(root, additionalBytes);
    await handle.writeFile(`${JSON.stringify({ token, pid: process.pid, root, scratchPath })}\n`);
    for (const name of ["tmp", "home", "state", "plans"]) await mkdir(join(scratchPath, name), { recursive: true });
    for (const name of ["bun", "npm", "xdg", "go-build", "go-modules", "playwright", "pip", "uv"]) await mkdir(join(root, "cache", name), { recursive: true });
    const env = { ...process.env, LING_GSTACK_RESOURCE_ROOT: root, LING_GSTACK_RESOURCE_TOKEN: token,
      HOME: join(scratchPath, "home"), USERPROFILE: join(scratchPath, "home"),
      TMPDIR: join(scratchPath, "tmp"), TMP: join(scratchPath, "tmp"), TEMP: join(scratchPath, "tmp"),
      BUN_INSTALL_CACHE_DIR: join(root, "cache/bun"), npm_config_cache: join(root, "cache/npm"),
      PLAYWRIGHT_BROWSERS_PATH: join(root, "cache/playwright"), PIP_CACHE_DIR: join(root, "cache/pip"), UV_CACHE_DIR: join(root, "cache/uv"),
      XDG_CACHE_HOME: join(root, "cache/xdg"), XDG_CONFIG_HOME: join(scratchPath, "home/.config"),
      GOCACHE: join(root, "cache/go-build"), GOMODCACHE: join(root, "cache/go-modules"),
      GSTACK_HOME: join(scratchPath, "state"), GSTACK_PLAN_DIR: join(scratchPath, "plans") };
    return { ...record, scratchPath, env, checkpoint: additional => resourceCheckpoint(root, additional),
      async release() {
        if (released) return;
        const current = JSON.parse(await readFile(path, "utf8"));
        if (current.token !== token) throw new Error("gstack_resource_lease_mismatch");
        await rm(scratchPath, { recursive: true, force: true });
        await handle.close();
        await rm(path);
        released = true;
      } };
  } catch (error) {
    await rm(scratchPath, { recursive: true, force: true });
    await handle.close();
    await rm(path);
    throw error;
  }
}

export async function requireResourceLease(env = process.env) {
  if (!env.LING_GSTACK_RESOURCE_ROOT || !env.LING_GSTACK_RESOURCE_TOKEN) throw new Error("gstack_resource_lease_required; use scripts/gstack/run-managed.mjs");
  const root = env.LING_GSTACK_RESOURCE_ROOT;
  const record = await openResourceWorkspace(root);
  const lease = JSON.parse(await readFile(lockPath(record), "utf8"));
  if (lease.token !== env.LING_GSTACK_RESOURCE_TOKEN || lease.root !== root ||
    lease.scratchPath !== join(root, "runs", lease.token) || !Number.isSafeInteger(lease.pid) || lease.pid < 1) throw new Error("gstack_resource_lease_mismatch");
  try { process.kill(lease.pid, 0); } catch { throw new Error("gstack_resource_lease_owner_missing"); }
  for (const key of ["TMPDIR", "TMP", "TEMP"]) {
    if (env[key] !== join(lease.scratchPath, "tmp") || await realpath(env[key]) !== env[key]) throw new Error("gstack_resource_temp_outside_workspace");
  }
  return lease;
}

export async function managedResourceWrite(outputPath, { kind, additionalBytes = 0, env = process.env } = {}) {
  const lease = await requireResourceLease(env);
  const output = resolve(outputPath);
  if (await canonicalDestination(output) !== output) throw new Error("gstack_resource_output_path_alias");
  const scratch = within(lease.scratchPath, output) && output !== lease.scratchPath;
  const artifactRoot = join(lease.root, "artifacts", kind ?? "invalid");
  if (!/^(source|native|resource|browser|report)$/.test(kind ?? "") ||
    !scratch && dirname(output) !== artifactRoot) throw new Error("gstack_resource_output_outside_workspace");
  if (!scratch) {
    const generations = await readdir(artifactRoot).catch(error => { if (error.code === "ENOENT") return []; throw error; });
    if (generations.length >= 2) throw new Error(`gstack_resource_retention_limit:${kind}; review current and previous before cleanup`);
  }
  await resourceCheckpoint(lease.root, additionalBytes);
  return lease;
}
