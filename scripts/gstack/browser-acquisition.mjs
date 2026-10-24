import { createHash, randomUUID } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, rmdir, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { crc32 } from "node:zlib";
import { verifyBundledBrowser } from "../../packages/core/src/bundled-skill-browser.ts";
import { inspectBrowserZip, validateBrowserMemberGraph } from "./inspect-browser-zip.mjs";

const fail = reason => { throw new Error(`gstack_browser_acquisition_${reason}`); };
const digest = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const hash = value => /^sha256:[a-f0-9]{64}$/.test(value ?? "");
const json = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const exists = path => lstat(path).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; });
const slugs = { "darwin-arm64": "mac-arm64", "darwin-x64": "mac-x64", "win32-x64": "win64" };
const hosts = new Set(["cdn.playwright.dev", "playwright.download.prss.microsoft.com", "storage.googleapis.com"]);
const maximumArchiveBytes = 512 * 1024 ** 2, maximumRecipeBytes = 4 * 1024 ** 2;
const active = new Map();

/** The caller binds this recipe to packaged inputs. Validation grants no trust
 * to a recipe obtained from a page, environment variable or mutable cache. */
export function validateBrowserAcquisition(recipe, target = recipe?.target) {
  const slug = slugs[`${target?.platform}-${target?.arch}`];
  if (!slug || recipe?.schemaVersion !== 1 || recipe.mode !== "download-required" || recipe.source !== "playwright-registry" ||
    !isDeepStrictEqual(recipe.target, target) || !/^\d{1,6}\.\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(recipe.browserVersion ?? "") ||
    !hash(recipe.archive?.checksum) || !Number.isSafeInteger(recipe.archive?.sizeBytes) || recipe.archive.sizeBytes < 1 ||
    recipe.archive.sizeBytes > maximumArchiveBytes || recipe.archive.url !==
      `https://cdn.playwright.dev/builds/cft/${recipe.browserVersion}/${slug}/chrome-${slug}.zip` ||
    !hash(recipe.componentChecksum) || !Array.isArray(recipe.members) || !recipe.members.length || recipe.members.length > 5000) fail("recipe_invalid");
  const prefix = `chrome-${slug}`, app = `${prefix}/Google Chrome for Testing.app`, framework = `${app}/Contents/Frameworks/Google Chrome for Testing Framework.framework`;
  const entryPath = target.platform === "win32" ? `${prefix}/chrome.exe` : `${app}/Contents/MacOS/Google Chrome for Testing`;
  let total = 0;
  for (const row of recipe.members) {
    if (!row || typeof row !== "object" || Array.isArray(row)) fail("member_invalid");
    const type = row.mode & 0xf000;
    if (typeof row.path !== "string" || row.path !== prefix && !row.path.startsWith(`${prefix}/`) ||
      !["directory", "file", "link"].includes(row.kind) || !Number.isSafeInteger(row.mode) || row.mode < 0 || row.mode > 0xffff || row.mode & 0o7000 ||
      !(row.kind === "directory" ? [0, 0x4000] : row.kind === "link" ? [0xa000] : [0, 0x8000]).includes(type) ||
      !Number.isSafeInteger(row.sizeBytes) || row.sizeBytes < 0 || row.sizeBytes > maximumArchiveBytes ||
      !Number.isSafeInteger(row.compressedSizeBytes) || row.compressedSizeBytes < 0 || row.compressedSizeBytes > maximumArchiveBytes ||
      row.sizeBytes > Math.max(row.compressedSizeBytes, 1) * 10000 || ![0, 8].includes(row.compressionMethod) ||
      !hash(row.checksum) || !/^[a-f0-9]{1,8}$/.test(row.crc32 ?? "") || row.kind === "directory" && row.sizeBytes !== 0 ||
      row.kind === "link" && (row.sizeBytes > 4096 || typeof row.linkTarget !== "string" ||
        Buffer.byteLength(row.linkTarget) !== row.sizeBytes || digest(row.linkTarget) !== row.checksum)) fail("member_invalid");
    total += row.sizeBytes;
  }
  if (total > 2 * 1024 ** 3) fail("member_total_size_invalid");
  const checked = structuredClone(recipe.members);
  validateBrowserMemberGraph(checked);
  if (!isDeepStrictEqual(checked, recipe.members)) fail("member_links_invalid");
  const files = recipe.members.filter(row => row.kind === "file").map(({ path, checksum, sizeBytes }) => ({ path, checksum, sizeBytes }));
  const links = recipe.members.filter(row => row.kind === "link").map(({ path, linkTarget, resolvedTarget }) => ({ path, linkTarget, resolvedTarget }));
  const component = { schemaVersion: 1, source: "playwright-registry", target, entryPath, files, links };
  if (!files.length || !isDeepStrictEqual(recipe.component, component) || json(recipe.component).length > 2 * 1024 ** 2 ||
    digest(json(recipe.component)) !== recipe.componentChecksum || json(recipe).length > maximumRecipeBytes) fail("component_invalid");
  const entry = recipe.members.find(row => row.path === entryPath);
  if (entry?.kind !== "file" || entry.native?.fileType !== "executable" || !entry.native.architectures?.includes(target.arch) ||
    target.platform === "darwin" && !(entry.mode & 0o111)) fail("entry_invalid");
  if (target.platform === "win32") {
    if (links.length || !files.some(row => row.path === `${prefix}/ABOUT`)) fail("framework_invalid");
  } else {
    const version = `${framework}/Versions/${recipe.browserVersion}`;
    const expected = new Map(["Google Chrome for Testing Framework", "Helpers", "Libraries", "Resources"].map(name =>
      [`${framework}/${name}`, `Versions/Current/${name}`]));
    expected.set(`${framework}/Versions/Current`, recipe.browserVersion);
    const library = recipe.members.find(row => row.path === `${version}/Google Chrome for Testing Framework`);
    if (links.length !== 5 || links.some(row => expected.get(row.path) !== row.linkTarget) ||
      library?.native?.fileType !== "library" || !library.native.architectures?.includes(target.arch) ||
      !files.some(row => row.path === `${version}/Libraries/WidevineCdm/LICENSE`)) fail("framework_invalid");
  }
  return recipe;
}

export function browserAcquisitionBytes(recipe) {
  validateBrowserAcquisition(recipe);
  return json(recipe);
}

function validDirectory(path, stat, privateDirectory) {
  return stat.isDirectory() && !stat.isSymbolicLink() && (!process.getuid || stat.uid === process.getuid() &&
    (!privateDirectory || !(stat.mode & 0o077)));
}

async function directory(path, create = false, privateDirectory = true) {
  if (create) await mkdir(path, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
  const stat = await lstat(path);
  if (!validDirectory(path, stat, privateDirectory) || await realpath(path) !== path) fail("cache_directory_invalid");
  return { path, stat, privateDirectory };
}

function assertDirectories(records) {
  for (const { path, stat, privateDirectory } of records) {
    const current = lstatSync(path);
    if (!validDirectory(path, current, privateDirectory) || current.dev !== stat.dev || current.ino !== stat.ino || realpathSync(path) !== path) fail("cache_directory_changed");
  }
}

function sameStat(first, second) {
  return ["dev", "ino", "mode", "size", "mtimeMs", "ctimeMs", "nlink"].every(key => first[key] === second[key]);
}

async function verifyCache(root, acquisition, bytes, parents, signal) {
  if (signal.aborted) fail("timeout");
  assertDirectories(parents);
  const container = await directory(root);
  if (!isDeepStrictEqual((await readdir(root)).sort(), ["acquisition.json", "browser"])) fail("cache_inventory_invalid");
  const receipt = join(root, "acquisition.json"), before = await lstat(receipt);
  if (!before.isFile() || before.isSymbolicLink() || before.size !== bytes.length || await realpath(receipt) !== receipt ||
    !(await readFile(receipt)).equals(bytes) || !sameStat(before, await lstat(receipt))) fail("cache_receipt_invalid");
  const browserRoot = join(root, "browser"), expected = new Map([["browser-component.json", "file"]]);
  for (const row of acquisition.members) {
    expected.set(row.path, row.kind);
    const parts = row.path.split("/");
    for (let index = 1; index < parts.length; index++) expected.set(parts.slice(0, index).join("/"), "directory");
  }
  let observed = 0;
  const walk = async (path, prefix = "") => {
    for (const name of await readdir(path)) {
      if (signal.aborted) fail("timeout");
      const relative = prefix + name, full = join(path, name), stat = await lstat(full);
      const kind = stat.isSymbolicLink() ? "link" : stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "special";
      if (++observed > 6000 || expected.get(relative) !== kind) fail("cache_inventory_invalid");
      expected.delete(relative);
      if (kind === "directory") { await directory(full); await walk(full, `${relative}/`); }
    }
  };
  await directory(browserRoot); await walk(browserRoot);
  if (expected.size) fail("cache_inventory_invalid");
  const verified = verifyBundledBrowser(browserRoot, acquisition.componentChecksum, acquisition.target);
  if (signal.aborted) fail("timeout");
  const assertCurrent = () => {
    assertDirectories([...parents, container]);
    if (!sameStat(container.stat, lstatSync(root))) fail("cache_inventory_changed");
    if (!sameStat(before, lstatSync(receipt))) fail("cache_receipt_changed");
    verified.assertCurrent();
  };
  assertCurrent();
  return Object.freeze({ root: verified.root, entry: verified.entry, checksum: verified.checksum, assertCurrent });
}

function endpoint(value, acquisition) {
  let url;
  try { url = new URL(value); } catch { fail("endpoint_invalid"); }
  const slug = slugs[`${acquisition.target.platform}-${acquisition.target.arch}`];
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash || url.href.length > 16384 || !hosts.has(url.hostname) ||
    !url.pathname.endsWith(`/${acquisition.browserVersion}/${slug}/chrome-${slug}.zip`)) fail("endpoint_invalid");
  return url;
}

async function bounded(promise, signal) {
  if (signal.aborted) fail("timeout");
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error("gstack_browser_acquisition_timeout"));
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

async function download(acquisition, destination, request, signal) {
  let url = endpoint(acquisition.archive.url, acquisition), response;
  for (let redirects = 0; redirects < 6; redirects++) {
    try { response = await bounded(request(url.href, { redirect: "manual", signal, credentials: "omit", cache: "no-store",
      referrerPolicy: "no-referrer", headers: { "accept-encoding": "identity" } }), signal); }
    catch (error) { if (signal.aborted) fail("timeout"); throw new Error("gstack_browser_acquisition_download_failed", { cause: error }); }
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get("location"); await response.body?.cancel();
    if (!location || redirects === 5) fail("redirect_invalid");
    url = endpoint(new URL(location, url), acquisition);
  }
  if (response.status !== 200 || !response.body) { await response.body?.cancel(); fail(`http_${response.status}`); }
  const length = response.headers.get("content-length");
  if (length !== null && length !== String(acquisition.archive.sizeBytes) || response.headers.get("content-encoding") !== null) {
    await response.body.cancel(); fail("download_size_invalid");
  }
  const file = await open(destination, "wx", 0o600), stream = Readable.fromWeb(response.body), hash = createHash("sha256");
  const abort = () => stream.destroy(new Error("gstack_browser_acquisition_timeout"));
  signal.addEventListener("abort", abort, { once: true });
  let size = 0;
  try {
    if (signal.aborted) fail("timeout");
    for await (const part of stream) {
      if (signal.aborted) fail("timeout");
      size += part.length; if (size > acquisition.archive.sizeBytes) fail("download_size_invalid");
      hash.update(part); await file.writeFile(part);
    }
    if (size !== acquisition.archive.sizeBytes || `sha256:${hash.digest("hex")}` !== acquisition.archive.checksum) fail("download_content_mismatch");
    await file.sync();
  } finally { signal.removeEventListener("abort", abort); stream.destroy(); await file.close(); }
}

// This small runtime extractor intentionally has no producer/resource-lease
// imports. The pure inspector authenticates the complete ZIP again beforehand.
async function extract(zipPath, outputRoot, acquisition, yauzl, signal) {
  const remaining = new Map(acquisition.members.map(row => [row.path, row]));
  await mkdir(outputRoot, { mode: 0o700 });
  const archive = await yauzl.openPromise(zipPath, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true, autoClose: false });
  let operation, activeStream, stop;
  const abort = () => stop?.(new Error("gstack_browser_acquisition_timeout"));
  try {
    await new Promise((resolve, reject) => {
      let settled = false;
      stop = error => { if (settled) return; settled = true; if (error) { activeStream?.destroy(error); archive.close(); reject(error); } else resolve(); };
      signal.addEventListener("abort", abort, { once: true });
      archive.once("error", stop); archive.once("end", () => stop());
      archive.on("entry", entry => {
        operation = (async () => {
          if (settled || signal.aborted) fail("timeout");
          const path = entry.fileName.replace(/\/$/, ""), row = remaining.get(path);
          if (!row || entry.fileName !== `${path}${row.kind === "directory" ? "/" : ""}` || entry.uncompressedSize !== row.sizeBytes ||
            entry.compressedSize !== row.compressedSizeBytes || entry.compressionMethod !== row.compressionMethod ||
            entry.externalFileAttributes >>> 16 !== row.mode || entry.generalPurposeBitFlag & 0x41) fail("archive_member_changed");
          const full = join(outputRoot, path);
          if (row.kind === "directory") await mkdir(full, { recursive: true, mode: 0o700 });
          else await mkdir(dirname(full), { recursive: true, mode: 0o700 });
          const file = row.kind === "file" ? await open(full, "wx", 0o600) : undefined;
          let size = 0, crc = 0; const hash = createHash("sha256"), chunks = [];
          try {
            activeStream = await archive.openReadStreamPromise(entry);
            for await (const part of activeStream) {
              if (signal.aborted) fail("timeout");
              size += part.length; if (size > row.sizeBytes) fail("archive_member_changed");
              hash.update(part); crc = crc32(part, crc);
              if (file) await file.writeFile(part); else if (row.kind === "link") chunks.push(part);
            }
          } finally { await file?.close(); }
          activeStream = undefined;
          if (size !== row.sizeBytes || `sha256:${hash.digest("hex")}` !== row.checksum || crc.toString(16).padStart(8, "0") !== row.crc32 ||
            row.kind === "link" && !Buffer.concat(chunks).equals(Buffer.from(row.linkTarget))) fail("archive_member_changed");
          if (row.kind === "file" && acquisition.target.platform !== "win32") await chmod(full, row.mode & 0o111 ? 0o755 : 0o644);
          remaining.delete(path);
          if (!settled) archive.readEntry();
        })().catch(stop);
      });
      if (signal.aborted) abort(); else archive.readEntry();
    });
    if (remaining.size) fail("archive_member_missing");
  } finally { signal.removeEventListener("abort", abort); activeStream?.destroy(); archive.close(); await operation; }
  for (const row of acquisition.members.filter(row => row.kind === "link")) {
    if (signal.aborted) fail("timeout");
    await mkdir(dirname(join(outputRoot, row.path)), { recursive: true, mode: 0o700 });
    await symlink(row.linkTarget, join(outputRoot, row.path));
  }
  for (const row of acquisition.component.links) if (await realpath(join(outputRoot, row.path)) !== join(outputRoot, row.resolvedTarget)) fail("link_target_changed");
  if (signal.aborted) fail("timeout");
  await writeFile(join(outputRoot, "browser-component.json"), json(acquisition.component), { flag: "wx", mode: 0o600 });
}

async function retryLockIo(operation) {
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); }
    catch (error) { if (!["EPERM", "EACCES", "EBUSY"].includes(error.code) || attempt === 7) throw error; await delay(25); }
  }
}

async function acquire({ stateRoot, acquisition, yauzl, request, timeoutMs, pollMs, signal }, bytes) {
  if (typeof stateRoot !== "string" || !isAbsolute(stateRoot) || resolve(stateRoot) !== stateRoot) fail("state_root_required");
  const started = Date.now();
  const state = await directory(stateRoot, false, false);
  const cache = join(stateRoot, "browser-cache"), registry = join(cache, "playwright");
  const parents = [state, await directory(cache, true), await directory(registry, true)];
  const key = digest(bytes).slice(7), final = join(registry, key), lock = `${final}.lock`;
  if (await exists(final)) return verifyCache(final, acquisition, bytes, parents, signal);
  const token = randomUUID(), ownerName = `owner-${token}.json`;
  let candidate = join(registry, `.${key}.${token}.lock-candidate`), temporary, locked = false, lockIdentity;
  const removeEmptyLock = async () => {
    try { await rmdir(lock); } catch (error) { if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) throw error; }
  };
  const recover = async () => {
    const abandoned = new Set();
    await retryLockIo(async () => {
      try {
        await directory(lock);
        const names = await readdir(lock);
        if (!names.length) return removeEmptyLock();
        if (names.length !== 1 || !/^owner-[a-f0-9-]{36}\.json$/.test(names[0])) fail("cache_lock_invalid");
        const path = join(lock, names[0]), before = await lstat(path);
        if (!before.isFile() || before.isSymbolicLink() || before.size > 512 || await realpath(path) !== path) fail("cache_lock_invalid");
        const owner = JSON.parse(await readFile(path));
        if (!sameStat(before, await lstat(path)) || !Number.isSafeInteger(owner.pid) || owner.pid < 1 ||
          !/^[a-f0-9-]{36}$/.test(owner.token ?? "") || names[0] !== `owner-${owner.token}.json`) fail("cache_lock_invalid");
        try { process.kill(owner.pid, 0); return; } catch (error) { if (error.code !== "ESRCH") return; }
        abandoned.add(join(registry, `.${key}.${owner.token}.partial`));
        try { await unlink(path); } catch (error) { if (error.code !== "ENOENT") throw error; }
        await removeEmptyLock();
      } catch (error) { if (error.code !== "ENOENT") throw error; }
    });
    for (const path of abandoned) {
      try { if (await exists(path)) { await directory(path); await rm(path, { recursive: true }); } }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  };
  try {
    await mkdir(candidate, { mode: 0o700 });
    await writeFile(join(candidate, ownerName), JSON.stringify({ pid: process.pid, token }), { flag: "wx", mode: 0o600 });
    let vanished = 0;
    while (!locked) {
      try { await rename(candidate, lock); candidate = undefined; locked = true; lockIdentity = await directory(lock); }
      catch (error) {
        if (!["EEXIST", "ENOTEMPTY", "EPERM", "EACCES"].includes(error.code)) throw error;
        if (!await exists(lock)) { if (++vanished >= 8 || signal.aborted) throw error; await delay(25); continue; }
        vanished = 0; await recover();
        if (await exists(final)) return verifyCache(final, acquisition, bytes, parents, signal);
        if (signal.aborted) fail("cache_busy_timeout");
        await delay(pollMs);
      }
    }
    if (await exists(final)) return verifyCache(final, acquisition, bytes, parents, signal);
    temporary = join(registry, `.${key}.${token}.partial`); await mkdir(temporary, { mode: 0o700 });
    const archive = join(temporary, "archive.zip");
    await download(acquisition, archive, request, signal);
    if (signal.aborted) fail("timeout");
    const remainingMs = Math.min(timeoutMs - (Date.now() - started), 120000);
    if (remainingMs < 1) fail("timeout");
    const inspected = await inspectBrowserZip({ zipPath: archive, yauzl, target: acquisition.target,
      rootPrefix: `chrome-${slugs[`${acquisition.target.platform}-${acquisition.target.arch}`]}`,
      limits: { maxDurationMs: remainingMs } });
    if (!isDeepStrictEqual(inspected.members, acquisition.members)) fail("archive_inventory_mismatch");
    await extract(archive, join(temporary, "browser"), acquisition, yauzl, signal);
    await unlink(archive);
    await writeFile(join(temporary, "acquisition.json"), bytes, { flag: "wx", mode: 0o600 });
    await verifyCache(temporary, acquisition, bytes, parents, signal);
    assertDirectories([...parents, lockIdentity]);
    if (signal.aborted) fail("timeout");
    if (await exists(final)) fail("cache_publication_conflict");
    // The private parent and held interprocess lock serialize every publisher.
    // A previously published (including invalid) cache is never overwritten.
    await rename(temporary, final); temporary = undefined;
    return await verifyCache(final, acquisition, bytes, parents, signal);
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true });
    if (candidate) await rm(candidate, { recursive: true, force: true });
    if (locked) {
      assertDirectories([lockIdentity]);
      await retryLockIo(() => unlink(join(lock, ownerName))); await retryLockIo(removeEmptyLock);
    }
  }
}

/** request is test injection only. Packaged callers supply the compiler-bound
 * recipe, a verified parser and native fetch, never a user-selected endpoint. */
export async function ensureBrowserAcquisition({ stateRoot, acquisition, yauzl, request = fetch, timeoutMs = 180000, pollMs = 100 }) {
  acquisition = structuredClone(acquisition);
  validateBrowserAcquisition(acquisition, { platform: process.platform, arch: process.arch });
  if (typeof yauzl?.openPromise !== "function" || typeof yauzl?.fromRandomAccessReaderPromise !== "function" ||
    typeof yauzl?.RandomAccessReader !== "function" || typeof request !== "function" ||
    !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 180000 || !Number.isSafeInteger(pollMs) || pollMs < 1 || pollMs > 1000) fail("limits_invalid");
  const bytes = browserAcquisitionBytes(acquisition), key = `${stateRoot}\0${digest(bytes)}`;
  if (active.has(key)) return active.get(key);
  // AbortSignal.timeout uses an unreferenced timer. An idle response body can
  // otherwise let Node exit before abort and ownership cleanup have completed.
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(new Error("gstack_browser_acquisition_timeout")), timeoutMs);
  const pending = acquire({ stateRoot, acquisition, yauzl, request, timeoutMs, pollMs, signal: controller.signal }, bytes);
  active.set(key, pending);
  try { return await pending; }
  finally { clearTimeout(deadline); if (active.get(key) === pending) active.delete(key); }
}
