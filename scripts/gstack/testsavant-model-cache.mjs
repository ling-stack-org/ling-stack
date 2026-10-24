import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, rmdir, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import pin from "./testsavant-model-pin.json" with { type: "json" };

const fail = code => { throw new Error(`testsavant_model_${code}`); };
const checksum = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const exists = path => lstat(path).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; });
const expectedPaths = ["config.json", "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json", "vocab.txt", "onnx/model.onnx", "README.md"];
const hosts = new Set(["huggingface.co", "cas-bridge.xethub.hf.co", "cdn-lfs.hf.co", "cdn-lfs-us-1.hf.co", "us.aws.cdn.hf.co"]);

// NTFS can briefly deny removal while another recovery holds a handle or its
// deletion is pending. Retry only lock I/O, preserving persistent errors.
async function retryLockIo(operation) {
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      if (!["EPERM", "EACCES", "EBUSY"].includes(error.code) || attempt === 7) throw error;
      await delay(25);
    }
  }
}

export function testsavantModelAcquisition(modelPin = pin) {
  if (modelPin.repository !== "testsavantai/prompt-injection-defender-small-v0-onnx" ||
    modelPin.revision !== "5bfc06f0b54950e6653f253eb7df1e3c9811b5cb" ||
    !Array.isArray(modelPin.files) || modelPin.files.length !== expectedPaths.length) fail("pin_invalid");
  let totalBytes = 0;
  for (const [index, file] of modelPin.files.entries()) {
    if (file.path !== expectedPaths[index] || file.remotePath !== (file.path === "onnx/model.onnx" ? "model.onnx" : file.path) ||
      !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 1 || file.sizeBytes > 128 * 1024 ** 2 ||
      !/^sha256:[a-f0-9]{64}$/.test(file.checksum ?? "")) fail("pin_invalid");
    totalBytes += file.sizeBytes;
  }
  if (totalBytes > 128 * 1024 ** 2) fail("pin_invalid");
  return { schemaVersion: 1, mode: "download-required", pinChecksum: checksum(JSON.stringify(modelPin)),
    repository: modelPin.repository, revision: modelPin.revision, files: modelPin.files, totalBytes };
}

async function directory(path, create = false, privateDirectory = false) {
  if (create) await mkdir(path, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
  const stat = await lstat(path);
  let canonical;
  if (!stat.isDirectory() || stat.isSymbolicLink() || (canonical = await realpath(path)) !== path ||
    process.getuid && (stat.uid !== process.getuid() || privateDirectory && stat.mode & 0o077)) {
    // Observe only a rejected directory; normal lock I/O and validation order
    // remain unchanged so diagnostics do not serialize a concurrent recovery.
    const identity = value => ({ directory: value.isDirectory(), symbolicLink: value.isSymbolicLink(),
      dev: String(value.dev), ino: String(value.ino), mode: value.mode, uid: value.uid });
    let after;
    try { after = identity(await lstat(path)); }
    catch (error) { after = { error: error.code }; }
    const error = new Error("testsavant_model_cache_directory_invalid");
    error.directoryObservation = { path: path.slice(0, 2048), canonical: canonical?.slice(0, 2048) ?? null,
      before: identity(stat), after };
    throw error;
  }
  return { dev: stat.dev, ino: stat.ino };
}

async function verifyTree(root, acquisition) {
  await directory(root);
  const observed = [];
  const walk = async (path, prefix = "") => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const name = prefix + entry.name, absolute = join(path, entry.name);
      if (entry.isDirectory() && name === "onnx") { await directory(absolute); await walk(absolute, `${name}/`); }
      else if (entry.isFile()) observed.push(name);
      else fail("cache_inventory_invalid");
    }
  };
  await walk(root);
  if (JSON.stringify(observed.sort()) !== JSON.stringify([...expectedPaths, "acquisition.json"].sort())) fail("cache_inventory_invalid");
  for (const file of acquisition.files) {
    const absolute = join(root, file.path), before = await lstat(absolute);
    if (!before.isFile() || before.isSymbolicLink() || before.size !== file.sizeBytes || await realpath(absolute) !== absolute) fail("cache_file_invalid");
    const handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await handle.stat(), hash = createHash("sha256"); let bytes = 0;
      if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) fail("cache_changed");
      for await (const part of createReadStream(absolute, { fd: handle.fd, autoClose: false })) {
        bytes += part.length; if (bytes > file.sizeBytes) fail("cache_file_invalid"); hash.update(part);
      }
      const after = await handle.stat();
      const pathname = await lstat(absolute);
      if (bytes !== file.sizeBytes || `sha256:${hash.digest("hex")}` !== file.checksum ||
        after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs ||
        pathname.dev !== opened.dev || pathname.ino !== opened.ino || pathname.size !== opened.size ||
        pathname.mtimeMs !== opened.mtimeMs || pathname.ctimeMs !== opened.ctimeMs ||
        await realpath(absolute) !== absolute) fail("cache_content_mismatch");
    } finally { await handle.close(); }
  }
  const receiptPath = join(root, "acquisition.json"), receipt = await lstat(receiptPath);
  if (!receipt.isFile() || receipt.isSymbolicLink() || receipt.size > 16 * 1024 || await realpath(receiptPath) !== receiptPath ||
    JSON.stringify(JSON.parse(await readFile(receiptPath))) !== JSON.stringify(acquisition)) fail("cache_receipt_invalid");
  const receiptAfter = await lstat(receiptPath);
  if (receiptAfter.dev !== receipt.dev || receiptAfter.ino !== receipt.ino || receiptAfter.size !== receipt.size ||
    receiptAfter.mtimeMs !== receipt.mtimeMs || receiptAfter.ctimeMs !== receipt.ctimeMs) fail("cache_changed");
  return root;
}

function endpoint(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash || !hosts.has(url.hostname)) fail("endpoint_invalid");
  return url;
}

async function download(file, path, acquisition, request, signal) {
  let url = endpoint(`https://huggingface.co/${acquisition.repository}/resolve/${acquisition.revision}/${file.remotePath}`), response;
  for (let redirects = 0; redirects < 5; redirects++) {
    try { response = await request(url.href, { redirect: "manual", signal, credentials: "omit", headers: { "accept-encoding": "identity" } }); }
    catch { fail(signal.aborted ? "download_timeout" : "download_failed"); }
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get("location"); await response.body?.cancel();
    if (!location || redirects === 4) fail("redirect_invalid");
    url = endpoint(new URL(location, url));
  }
  if (!response.ok || !response.body) { await response.body?.cancel(); fail(`http_${response.status}`); }
  const length = response.headers.get("content-length");
  if (length !== null && length !== String(file.sizeBytes) || response.headers.get("content-encoding") !== null) {
    await response.body.cancel(); fail("download_size_invalid");
  }
  const handle = await open(path, "wx", 0o600), hash = createHash("sha256"); let bytes = 0;
  try {
    for await (const part of response.body) {
      if (signal.aborted) fail("download_timeout");
      bytes += part.length; if (bytes > file.sizeBytes) fail("download_size_invalid");
      hash.update(part); await handle.writeFile(part);
    }
    if (bytes !== file.sizeBytes || `sha256:${hash.digest("hex")}` !== file.checksum) fail("download_content_mismatch");
    await handle.sync();
  } finally { await handle.close(); }
}

/** Dependency injection is for byte-level tests; the packaged caller always
 * constructs this with the compiler-bound pin and native fetch. No env URL or
 * request/page parameter can select a model, revision, destination or checksum. */
export function createTestsavantModelCache({ modelPin = pin, request = fetch, timeoutMs = 180000, pollMs = 100 } = {}) {
  const acquisition = testsavantModelAcquisition(structuredClone(modelPin));
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 180000 || !Number.isSafeInteger(pollMs) || pollMs < 1 || pollMs > 1000) fail("limits_invalid");
  const active = new Map();
  async function acquire(stateRoot) {
    if (typeof stateRoot !== "string" || !isAbsolute(stateRoot) || resolve(stateRoot) !== stateRoot) fail("state_root_required");
    const stateIdentity = await directory(stateRoot);
    const cache = join(stateRoot, "model-cache"); await directory(cache, true, true);
    const models = join(cache, "testsavant"); await directory(models, true, true);
    const final = join(models, acquisition.revision), lock = join(models, `${acquisition.revision}.lock`);
    if (await exists(final)) return verifyTree(final, acquisition);
    const signal = AbortSignal.timeout(timeoutMs), token = randomUUID(), ownerName = `owner-${token}.json`;
    let locked = false, temporary, lockIdentity, vanishedLockRetries = 0, lockCandidate = join(models, `.${acquisition.revision}.${token}.lock-candidate`);
    const removeEmptyLock = async () => {
      try { await rmdir(lock); } catch (error) { if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) throw error; }
    };
    const recoverDeadOwner = async () => {
      const abandoned = new Set();
      await retryLockIo(async () => {
        try {
          await directory(lock, false, true);
          const names = await readdir(lock);
          if (!names.length) {
            // A terminated writer/recovery may leave an empty lock. Nonrecursive
            // removal cannot delete a competing writer's nonempty owner directory.
            await removeEmptyLock();
            return;
          }
          if (names.length !== 1 || !/^owner-[a-f0-9-]{36}\.json$/.test(names[0])) fail("cache_lock_invalid");
          const path = join(lock, names[0]), before = await lstat(path);
          if (!before.isFile() || before.isSymbolicLink() || before.size > 512 || await realpath(path) !== path) fail("cache_lock_invalid");
          const owner = JSON.parse(await readFile(path)), after = await lstat(path);
          if (before.dev !== after.dev || before.ino !== after.ino || !Number.isSafeInteger(owner.pid) || owner.pid < 1 ||
            names[0] !== `owner-${owner.token}.json` || !/^[a-f0-9-]{36}$/.test(owner.token)) fail("cache_lock_invalid");
          try { process.kill(owner.pid, 0); return; }
          catch (error) { if (error.code !== "ESRCH") return; }
          abandoned.add(join(models, `.${acquisition.revision}.${owner.token}.partial`));
          // Only the dead writer's unique owner filename is unlinked. A new
          // writer's nonempty canonical directory cannot be removed by rmdir.
          try { await unlink(path); } catch (error) { if (error.code !== "ENOENT") throw error; }
          await removeEmptyLock();
        } catch (error) { if (error.code !== "ENOENT") throw error; }
      });
      for (const path of abandoned) {
        try { if (await exists(path)) { await directory(path, false, true); await rm(path, { recursive: true }); } }
        catch (error) { if (error.code !== "ENOENT") throw error; }
      }
    };
    try {
      await mkdir(lockCandidate, { mode: 0o700 });
      const owner = await open(join(lockCandidate, ownerName), "wx", 0o600);
      try { await owner.writeFile(JSON.stringify({ pid: process.pid, token, startedAt: Date.now() })); } finally { await owner.close(); }
      while (!locked) {
        try { await rename(lockCandidate, lock); lockCandidate = undefined; locked = true; lockIdentity = await directory(lock, false, true); }
        catch (error) {
          if (!["EEXIST", "ENOTEMPTY", "EPERM", "EACCES"].includes(error.code)) throw error;
          if (!await exists(lock)) {
            if (++vanishedLockRetries === 8 || signal.aborted) throw error;
            await delay(25); continue;
          }
          vanishedLockRetries = 0;
          await recoverDeadOwner();
          if (await exists(final)) return verifyTree(final, acquisition);
          if (signal.aborted) fail("cache_busy_timeout: another process is preparing the fixed model; retry after it completes");
          await delay(pollMs); continue;
        }
      }
      // A previous writer can finish between our first lookup and lock claim.
      if (await exists(final)) return verifyTree(final, acquisition);
      temporary = join(models, `.${acquisition.revision}.${token}.partial`); await mkdir(temporary, { mode: 0o700 });
      for (const file of acquisition.files) {
        if (signal.aborted) fail("download_timeout");
        if (file.path.startsWith("onnx/")) await directory(join(temporary, "onnx"), true, true);
        await download(file, join(temporary, file.path), acquisition, request, signal);
      }
      const receipt = await open(join(temporary, "acquisition.json"), "wx", 0o600);
      try { await receipt.writeFile(`${JSON.stringify(acquisition, null, 2)}\n`); await receipt.sync(); } finally { await receipt.close(); }
      await verifyTree(temporary, acquisition);
      const currentState = await directory(stateRoot);
      if (currentState.dev !== stateIdentity.dev || currentState.ino !== stateIdentity.ino) fail("state_root_changed");
      await directory(cache, false, true); await directory(models, false, true);
      const currentLock = await directory(lock, false, true);
      if (currentLock.dev !== lockIdentity.dev || currentLock.ino !== lockIdentity.ino) fail("cache_lock_changed");
      if (signal.aborted) fail("download_timeout");
      if (await exists(final)) fail("cache_publication_conflict");
      await rename(temporary, final); temporary = undefined;
      return await verifyTree(final, acquisition);
    } finally {
      if (temporary) await rm(temporary, { recursive: true, force: true });
      if (lockCandidate) await rm(lockCandidate, { recursive: true, force: true });
      if (locked) {
        const currentLock = await directory(lock, false, true);
        if (currentLock.dev !== lockIdentity?.dev || currentLock.ino !== lockIdentity?.ino) fail("cache_lock_changed");
        await retryLockIo(() => unlink(join(lock, ownerName))); await retryLockIo(removeEmptyLock);
      }
    }
  }
  return async stateRoot => {
    const previous = active.get(stateRoot); if (previous) return previous;
    const work = acquire(stateRoot); active.set(stateRoot, work);
    try { return await work; } finally { if (active.get(stateRoot) === work) active.delete(stateRoot); }
  };
}

export const ensureTestsavantModelCache = createTestsavantModelCache();
