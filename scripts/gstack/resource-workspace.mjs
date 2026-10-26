import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath, rm, stat, statfs } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

const GiB = 1024 ** 3;
export const RESOURCE_LIMITS = Object.freeze({ budgetBytes: 12 * GiB, minFreeBytes: 20 * GiB });
const marker = ".gstack-resource-workspace.json";
const lockName = ".heavy-operation.json";
const lockPath = record => join(record.storageMode === "local-bounded" ? record.localParentPath : record.mountPath,
  `.ling-gstack-${record.target}${lockName}`);
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

async function privateDirectory(path) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path
    || typeof process.getuid !== "function" || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o700) {
    throw new Error("gstack_resource_local_directory_invalid");
  }
  return info;
}

async function readWorkspaceRecord(root) {
  const path = join(root, marker), before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 16 * 1024
    || await realpath(path) !== path || typeof process.getuid === "function"
      && (before.uid !== process.getuid() || (before.mode & 0o777) !== 0o600)) {
    throw new Error("gstack_resource_workspace_receipt_invalid");
  }
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await file.stat();
    if (opened.dev !== before.dev || opened.ino !== before.ino) throw new Error("gstack_resource_workspace_receipt_invalid");
    const buffer = Buffer.alloc(16 * 1024 + 1);
    let count = 0;
    while (count < buffer.length) {
      const { bytesRead } = await file.read(buffer, count, buffer.length - count, count);
      if (!bytesRead) break;
      count += bytesRead;
    }
    const bytes = buffer.subarray(0, count), after = await file.stat(), current = await lstat(path);
    if (bytes.length > 16 * 1024 || bytes.length !== before.size || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
      || current.dev !== before.dev || current.ino !== before.ino || current.nlink !== 1) {
      throw new Error("gstack_resource_workspace_receipt_invalid");
    }
    return JSON.parse(bytes);
  } finally { await file.close(); }
}

export async function hostedRunnerStorage(root, env = process.env) {
  if (env.GITHUB_ACTIONS !== "true" || env.RUNNER_ENVIRONMENT !== "github-hosted" ||
    !/^\d+$/.test(env.GITHUB_RUN_ID ?? "") || !/^\d+$/.test(env.GITHUB_RUN_ATTEMPT ?? "") ||
    !/^[a-zA-Z0-9_-]+$/.test(env.GITHUB_JOB ?? "") || !env.RUNNER_TEMP || !isAbsolute(env.RUNNER_TEMP)) {
    throw new Error("gstack_resource_github_hosted_identity_required");
  }
  const mountPath = resolve(env.RUNNER_TEMP), path = resolve(root);
  const info = await lstat(mountPath);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(mountPath) !== mountPath ||
    path === mountPath || !within(mountPath, path) || await canonicalDestination(path) !== path) {
    throw new Error("gstack_resource_ephemeral_path_invalid");
  }
  return { mountPath, mountDevice: info.dev, mountInode: info.ino,
    storagePolicy: "github-hosted-ephemeral", runnerIdentity: {
      runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT, job: env.GITHUB_JOB } };
}

export async function initResourceWorkspace({ root, mountPath, storageMode = "external-volume", ciEphemeral = false }) {
  if (!["external-volume", "local-bounded"].includes(storageMode) || typeof ciEphemeral !== "boolean"
    || storageMode === "local-bounded" && (mountPath !== undefined || ciEphemeral)
    || ciEphemeral && mountPath !== undefined) throw new Error("gstack_resource_storage_mode_invalid");
  if (!root || !isAbsolute(root)) throw new Error("gstack_resource_workspace_required");
  const hostPath = await realpath(homedir());
  const path = resolve(root);
  const local = storageMode === "local-bounded";
  const mount = local ? undefined : ciEphemeral ? await hostedRunnerStorage(root) : await externalMount(mountPath, hostPath);
  if (await canonicalDestination(path) !== path) {
    throw new Error("gstack_resource_workspace_path_alias");
  }
  const parent = local ? await privateDirectory(dirname(path)) : undefined;
  if (!local && (!within(mount.mountPath, path) || path === mount.mountPath)) throw new Error("gstack_resource_workspace_path_alias");
  const volume = await statfs(local ? dirname(path) : mount.mountPath);
  assertResourceBudget({ usedBytes: 0, freeBytes: volume.bavail * volume.bsize });
  await mkdir(path, { mode: 0o700 });
  const created = await lstat(path);
  const record = { schemaVersion: local ? 2 : 1, owner: "ling-gstack-build", root: path, target: `${process.platform}-${process.arch}`,
    hostPath, ...(local ? { storageMode, localParentPath: dirname(path), localParentDevice: parent.dev,
      localParentInode: parent.ino, workspaceDevice: created.dev, workspaceInode: created.ino } : mount), ...RESOURCE_LIMITS };
  // mkdir and the first lstat cannot atomically prove ownership of this path.
  // On partial initialization leave it for explicit inspection, never rm it:
  // a same-UID writer might have replaced the directory before we observed it.
  const file = await open(join(path, marker), "wx", 0o600);
  try { await file.writeFile(`${JSON.stringify(record, null, 2)}\n`); }
  finally { await file.close(); }
  for (const name of ["artifacts", "cache", "runs"]) await mkdir(join(path, name), { mode: 0o700 });
  return record;
}

export async function openResourceWorkspace(root) {
  if (!root || !isAbsolute(root)) throw new Error("gstack_resource_workspace_required");
  const path = resolve(root);
  if (await realpath(path) !== path || !(await lstat(path)).isDirectory()) throw new Error("gstack_resource_workspace_path_alias");
  const record = await readWorkspaceRecord(path);
  if (!record.hostPath || !isAbsolute(record.hostPath)) throw new Error("gstack_resource_mount_identity_mismatch");
  if (record.owner !== "ling-gstack-build" || record.root !== path || record.target !== `${process.platform}-${process.arch}`
    || record.budgetBytes !== RESOURCE_LIMITS.budgetBytes || record.minFreeBytes !== RESOURCE_LIMITS.minFreeBytes) {
    throw new Error("gstack_resource_mount_identity_mismatch");
  }
  if (record.storagePolicy !== undefined && record.storagePolicy !== "github-hosted-ephemeral") {
    throw new Error("gstack_resource_runner_identity_mismatch");
  }
  if (record.schemaVersion === 2 && record.storageMode === "local-bounded" && record.storagePolicy === undefined) {
    const parent = await privateDirectory(dirname(path)), workspace = await privateDirectory(path);
    if (record.localParentPath !== dirname(path) || record.localParentDevice !== parent.dev || record.localParentInode !== parent.ino
      || record.workspaceDevice !== workspace.dev || record.workspaceInode !== workspace.ino || workspace.dev !== parent.dev) {
      throw new Error("gstack_resource_local_identity_mismatch");
    }
  } else if (record.schemaVersion === 1 && record.storageMode === undefined) {
    const mount = record.storagePolicy === "github-hosted-ephemeral"
      ? await hostedRunnerStorage(root) : await externalMount(record.mountPath, record.hostPath);
    if (record.storagePolicy === "github-hosted-ephemeral"
      && JSON.stringify(record.runnerIdentity) !== JSON.stringify(mount.runnerIdentity)) {
      throw new Error("gstack_resource_runner_identity_mismatch");
    }
    if (record.mountPath !== mount.mountPath || !within(mount.mountPath, path)
      || record.mountDevice !== mount.mountDevice || record.mountInode !== mount.mountInode
      || (await stat(path)).dev !== mount.mountDevice) throw new Error("gstack_resource_mount_identity_mismatch");
  } else throw new Error("gstack_resource_storage_mode_invalid");
  for (const name of ["artifacts", "cache", "runs"]) {
    const child = join(path, name);
    if (await realpath(child) !== child || !(await lstat(child)).isDirectory()) throw new Error("gstack_resource_workspace_path_alias");
    if (record.storageMode === "local-bounded") await privateDirectory(child);
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
    for (const name of ["tmp", "home", "state", "plans"]) await mkdir(join(scratchPath, name), { recursive: true, mode: 0o700 });
    for (const name of ["bun", "npm", "xdg", "go-build", "go-modules", "playwright", "pip", "uv"]) {
      const cache = join(root, "cache", name);
      await mkdir(cache, { recursive: true, mode: 0o700 });
      if (await realpath(cache) !== cache || !(await lstat(cache)).isDirectory()) throw new Error("gstack_resource_local_directory_invalid");
      if (record.storageMode === "local-bounded") await privateDirectory(cache);
    }
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
