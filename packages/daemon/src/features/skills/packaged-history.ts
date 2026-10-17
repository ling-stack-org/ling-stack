import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { cp, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, statfs, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { verifyBundledSkillSource } from "@ling-stack/core/bundled-skill-source";
import { verifyBundledBrowser } from "@ling-stack/core/bundled-skill-browser";
import { PackagedSkillRuntime } from "./packaged-runtime.js";

type Selection = Parameters<typeof verifyBundledSkillSource>[0];
type Identity = Omit<Selection, "rootPath" | "requireExecutable">;
const MAX_GENERATIONS = 2, MAX_BYTES = 6 * 1024 ** 3, MIN_FREE_BYTES = 2 * 1024 ** 3;
const fail = (code: string): never => { throw new Error(`packaged_skill_history_${code}`); };

async function canonicalDirectory(path: string): Promise<void> {
  if (resolve(path) !== path) fail("path_invalid");
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) fail("path_invalid");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(path) === path) throw error;
    await canonicalDirectory(dirname(path));
    try { await mkdir(path, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    await canonicalDirectory(path);
  }
}
async function treeBytes(root: string): Promise<number> {
  let bytes = 0, count = 0;
  async function walk(path: string): Promise<void> {
    const info = await lstat(path);
    if (++count > 160000 || (bytes += info.size) > MAX_BYTES) fail("budget_exceeded");
    if (info.isDirectory()) for (const name of await readdir(path)) await walk(join(path, name));
    else if (!info.isFile() && !info.isSymbolicLink()) fail("path_invalid");
  }
  await walk(root); return bytes;
}
async function admit(root: string, identity: Identity, browserChecksum?: string): Promise<PackagedSkillRuntime> {
  const source = await verifyBundledSkillSource({ ...identity, rootPath: join(root, "gstack"), requireExecutable: true });
  const receipt = source.manifest.files.some(file => file.path === "executable-build.json")
    ? JSON.parse(await source.readResource("executable-build.json")) : undefined;
  if (receipt?.browser?.componentChecksum !== browserChecksum) fail("browser_mismatch");
  const browser = browserChecksum ? verifyBundledBrowser(join(root, "gstack-browser"), browserChecksum, identity.expectedTarget!) : undefined;
  return new PackagedSkillRuntime(join(root, "gstack"), source, browser);
}
async function load(root: string): Promise<PackagedSkillRuntime> {
  const directory = await lstat(root);
  if (!directory.isDirectory() || directory.isSymbolicLink() || await realpath(root) !== root) fail("path_invalid");
  const path = join(root, "identity.json"), stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) fail("identity_invalid");
  const record = JSON.parse(await readFile(path, "utf8"));
  if (record.schemaVersion !== 1 || record.identity?.expectedManifestChecksum !== `sha256:${root.split(/[\\/]/).at(-1)}`) fail("identity_invalid");
  const expected = ["gstack", "identity.json", ...(record.browserChecksum ? ["gstack-browser"] : [])].sort();
  if (JSON.stringify((await readdir(root)).sort()) !== JSON.stringify(expected)) fail("requires_review");
  return admit(root, record.identity, record.browserChecksum);
}

/** Immutable, bounded generations with atomic publication and process-restart retention.
 * Not a power-loss durability guarantee. Interrupted ownership requires review;
 * never evict a possibly pinned run or silently recover an unknown staging tree. */
export async function retainPackagedSkillGeneration(cache: string, selection: Selection, browserRoot?: string): Promise<{
  current: PackagedSkillRuntime; retained: readonly PackagedSkillRuntime[];
}> {
  await canonicalDirectory(cache);
  const token = randomUUID(), lockPath = join(cache, ".writer.json");
  const lock = await open(lockPath, "wx", 0o600).catch(error => {
    if (error.code === "EEXIST") fail("busy_requires_review");
    throw error;
  });
  const staging = join(cache, `.staging-${token}`);
  let failed = false;
  try {
    await lock.writeFile(JSON.stringify({ schemaVersion: 1, token, pid: process.pid }));
    const names = (await readdir(cache)).filter(name => name !== ".writer.json");
    if (names.length > MAX_GENERATIONS || names.some(name => !/^[a-f0-9]{64}$/.test(name))) fail("requires_review");
    const existingBytes = await treeBytes(cache);
    const { rootPath, requireExecutable: ignored, ...identity } = selection;
    const checksum = identity.expectedManifestChecksum;
    if (typeof checksum !== "string" || !/^sha256:[a-f0-9]{64}$/.test(checksum)) throw new Error("packaged_skill_history_identity_invalid");
    const key = checksum.slice(7);
    const retained: PackagedSkillRuntime[] = [];
    for (const name of names) if (name !== key) retained.push(await load(join(cache, name)));
    if (names.includes(key)) return { current: await load(join(cache, key)), retained };
    if (names.length >= MAX_GENERATIONS) fail("retention_limit");
    const source = await verifyBundledSkillSource({ ...selection, requireExecutable: true });
    const receipt = source.manifest.files.some(file => file.path === "executable-build.json")
      ? JSON.parse(await source.readResource("executable-build.json")) : undefined;
    if (Boolean(receipt?.browser?.componentChecksum) !== Boolean(browserRoot)) fail("browser_mismatch");
    const browser = browserRoot ? verifyBundledBrowser(browserRoot, receipt.browser?.componentChecksum, identity.expectedTarget!) : undefined;
    const original = new PackagedSkillRuntime(rootPath, source, browser);
    const volume = await statfs(cache);
    const additional = await treeBytes(rootPath) + (browserRoot ? await treeBytes(browserRoot) : 0) + 65536;
    if (existingBytes + additional > MAX_BYTES || volume.bavail * volume.bsize - additional < MIN_FREE_BYTES) fail("budget_exceeded");
    await mkdir(staging, { mode: 0o700 });
    await cp(rootPath, join(staging, "gstack"), { recursive: true, force: false, errorOnExist: true, mode: constants.COPYFILE_FICLONE });
    if (browserRoot) await cp(browserRoot, join(staging, "gstack-browser"), {
      recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE,
    });
    original.assertCurrent();
    await admit(staging, identity, browser?.checksum);
    await writeFile(join(staging, "identity.json"), JSON.stringify({ schemaVersion: 1, identity, browserChecksum: browser?.checksum }), { flag: "wx", mode: 0o600 });
    await rename(staging, join(cache, key));
    return { current: await load(join(cache, key)), retained };
  } catch (error) { failed = true; throw error; }
  finally {
    // A partial ENOSPC lock write need not produce parseable JSON. Ownership
    // comes from the exclusively created inode, and closing cannot be skipped.
    const cleanupErrors: unknown[] = [];
    try { await rm(staging, { recursive: true, force: true }); }
    catch (error) { cleanupErrors.push(error); }
    try {
      const owned = await lock.stat(), current = await lstat(lockPath);
      if (current.isSymbolicLink() || owned.dev !== current.dev || owned.ino !== current.ino) fail("ownership_changed");
      await rm(lockPath);
    } catch (error) { cleanupErrors.push(error); }
    finally {
      try { await lock.close(); } catch (error) { cleanupErrors.push(error); }
    }
    if (!failed && cleanupErrors.length) throw cleanupErrors[0];
  }
}
