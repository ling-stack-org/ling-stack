import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdtemp, open, opendir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  readAtomicPublishDirectoryIdentities,
  removeAtomicPublishDirectoryTree,
  removeAtomicPublishUnsecuredEmptyDirectory,
  securePrivateStagingDirectory,
  verifyPrivateStagingDirectorySecurity,
  withAtomicPublishParentLease,
} from "../cua-driver-package-atomic-publish.mjs";

const MAXIMUM_BYTES = 4n * 1024n * 1024n * 1024n;
const CHUNK_BYTES = 64 * 1024;
const LEAF_NAME = "input.dmg";
const IDENTITY_KEYS = ["dev", "ino", "mode", "uid", "gid", "nlink"];
const BYTE_KEYS = [...IDENTITY_KEYS, "size", "mtimeNs"];

/**
 * Retain the original O_NOFOLLOW readonly handle and stream its bounded bytes
 * into one exclusive private image. Only this image pathname may reach hdiutil.
 * Original complete metadata and payload pins never refresh. The native parent
 * lease/security/remover is reused; this is not malicious same-UID isolation.
 * Filesystem seams are explicitly named and are only for deterministic tests.
 */
export async function createDmgInputSnapshot(originalPath, dependencies = {}) {
  requireCondition(typeof originalPath === "string" && isAbsolute(originalPath)
    && resolve(originalPath) === originalPath && !originalPath.includes("\0"), "path_invalid");
  const inspect = dependencies.dmgSnapshotLstat ?? lstat;
  const openFile = dependencies.dmgSnapshotOpen ?? open;
  const makeTemporaryRoot = dependencies.dmgSnapshotMkdtemp ?? mkdtemp;
  const withLease = dependencies.withAtomicPublishParentLease ?? withAtomicPublishParentLease;
  const readIdentities = dependencies.readAtomicPublishDirectoryIdentities ?? readAtomicPublishDirectoryIdentities;
  const secure = dependencies.securePrivateStagingDirectory ?? securePrivateStagingDirectory;
  const verifyPrivate = dependencies.verifyPrivateStagingDirectorySecurity ?? verifyPrivateStagingDirectorySecurity;
  const removeTree = dependencies.removeAtomicPublishDirectoryTree ?? removeAtomicPublishDirectoryTree;
  const removeEmpty = dependencies.removeAtomicPublishUnsecuredEmptyDirectory ?? removeAtomicPublishUnsecuredEmptyDirectory;
  let originalHandle, snapshotHandle, originalStat, leafIdentity, snapshotStat, digest, directory, unboundRoot;
  let removed = false, closed = false, closeFailures = [], closePromise;
  let lifecycleTail = Promise.resolve(), cleanupInFlight, cleanupResult;
  let firstCleanup = true, validated = false;
  const stickyFailures = [];

  const serialized = operation => {
    const result = lifecycleTail.then(operation);
    lifecycleTail = result.catch(() => {});
    return result;
  };
  const receipt = (validation = validated ? "verified" : "not_verified") => Object.freeze({
    outcome: removed ? "removed" : "residue",
    validation,
    originalPath,
    ...(directory === undefined ? unboundRoot === undefined ? {} : {
      residuePath: unboundRoot,
      reason: "initial_identity_unavailable",
    } : {
      residuePath: directory.root,
      residueIdentity: directory.sourceIdentity,
      parentIdentity: directory.parentIdentity,
      snapshotPath: join(directory.root, LEAF_NAME),
    }),
    ...(leafIdentity === undefined ? {} : { snapshotIdentity: nativeIdentity(leafIdentity) }),
  });
  const failure = (causes, code, validation) => {
    const error = new AggregateError(causes, `dmg_input_snapshot_${code}`);
    Object.defineProperty(error, "cleanup", { enumerable: true, value: receipt(validation) });
    return error;
  };
  const closeHandles = () => {
    if (closePromise !== undefined) return closePromise;
    closed = true;
    closePromise = (async () => {
      // Neither a falsy thrown value nor failure of the first close skips the
      // second close. A retained handle is never reopened or closed twice.
      for (const handle of [snapshotHandle, originalHandle]) {
        if (handle !== undefined) {
          try { await handle.close(); } catch (cause) { closeFailures.push(cause); }
        }
      }
      return closeFailures;
    })();
    return closePromise;
  };
  const assertOpen = () => requireCondition(!closed, "handles_closed");
  const checkFile = async (path, handle, expected, allowCacheCtime) => {
    const keys = allowCacheCtime ? BYTE_KEYS : [...BYTE_KEYS, "ctimeNs"];
    const fence = async () => {
      const fdStat = await handle.stat({ bigint: true });
      const pathStat = await inspect(path, { bigint: true });
      requireCondition(sameMetadata(fdStat, expected, keys) && sameMetadata(pathStat, expected, keys), "identity_mismatch");
    };
    await fence();
    const actualDigest = await readDigest(handle, expected.size);
    await fence();
    requireCondition(actualDigest === digest, "bytes_mismatch");
  };
  const verifyOriginal = async () => {
    assertOpen();
    await checkFile(originalPath, originalHandle, originalStat, false);
  };
  const verifySnapshot = async () => {
    assertOpen();
    await checkFile(join(directory.root, LEAF_NAME), snapshotHandle, snapshotStat, true);
  };
  const guardDirectory = async lease => {
    const current = await guardLease(lease, () => readIdentities({
      parentRoot: directory.parentRoot, sourceName: directory.sourceName,
    }, lease));
    assertLease(lease);
    requireCondition(current?.parentIdentity === directory.parentIdentity
      && current?.sourceIdentity === directory.sourceIdentity, "directory_identity_mismatch");
  };
  const removeOwnedDirectory = async () => {
    if (directory === undefined || removed) return;
    await withLease({ parentRoot: directory.parentRoot }, async lease => {
      await guardDirectory(lease);
      if (leafIdentity === undefined) {
        await guardLease(lease, () => removeEmpty({
          ...removalPins(directory),
        }, lease));
      } else {
        await guardLease(lease, () => verifyPrivate({
          parentRoot: directory.parentRoot,
          directoryName: directory.sourceName,
          expectedParentIdentity: directory.parentIdentity,
          expectedDirectoryIdentity: directory.sourceIdentity,
        }, lease));
        assertLease(lease);
        const current = await inspect(join(directory.root, LEAF_NAME), { bigint: true });
        // In failed initialization, only the identity pinned immediately after
        // O_EXCL is authority; current size is bounded inventory, not new pins.
        requireCondition(sameMetadata(current, snapshotStat ?? leafIdentity,
          snapshotStat === undefined ? IDENTITY_KEYS : BYTE_KEYS), "cleanup_leaf_identity_mismatch");
        requireCondition(current.size >= 0n && current.size <= MAXIMUM_BYTES, "budget_exceeded");
        await requireExactLeafInventory(directory.root);
        await guardDirectory(lease);
        const leafAfterInventory = await inspect(join(directory.root, LEAF_NAME), { bigint: true });
        requireCondition(sameMetadata(leafAfterInventory, current, BYTE_KEYS), "cleanup_leaf_identity_mismatch");
        await guardLease(lease, () => removeTree({
          ...removalPins(directory), entryPolicy: "artifact",
          expectedEntries: 1, expectedTotalBytes: Number(current.size),
        }, lease));
      }
      assertLease(lease);
      removed = true;
    });
  };

  try {
    originalStat = await inspect(originalPath, { bigint: true });
    requireCondition(ordinaryFile(originalStat) && originalStat.size > 0n, "original_invalid");
    requireCondition(originalStat.size <= MAXIMUM_BYTES, "budget_exceeded");
    originalHandle = await openFile(originalPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    requireCondition(sameMetadata(await originalHandle.stat({ bigint: true }), originalStat,
      [...BYTE_KEYS, "ctimeNs"]), "identity_mismatch");
    requireCondition(sameMetadata(await inspect(originalPath, { bigint: true }), originalStat,
      [...BYTE_KEYS, "ctimeNs"]), "identity_mismatch");
    const root = await makeTemporaryRoot(join(tmpdir(), "ling-cua-dmg-input-"));
    requireCondition(typeof root === "string" && isAbsolute(root) && !root.includes("\0"), "directory_invalid");
    // Allocation does not grant deletion authority. Keep the observed pathname
    // for residue reporting if canonical-parent/first-stat pinning fails.
    unboundRoot = root;
    const parentRoot = await realpath(dirname(root)), sourceName = basename(root);
    const [parent, source] = await Promise.all([
      inspect(parentRoot, { bigint: true }), inspect(root, { bigint: true }),
    ]);
    requireCondition(parent.isDirectory() && !parent.isSymbolicLink()
      && source.isDirectory() && !source.isSymbolicLink(), "directory_invalid");
    directory = Object.freeze({ parentRoot, sourceName, root: join(parentRoot, sourceName),
      parentIdentity: nativeIdentity(parent), sourceIdentity: nativeIdentity(source) });
    await withLease({ parentRoot }, async lease => {
      await guardDirectory(lease);
      const secured = await guardLease(lease, () => secure({ parentRoot,
        directoryName: sourceName, expectedParentIdentity: directory.parentIdentity,
        expectedDirectoryIdentity: directory.sourceIdentity }, lease));
      assertLease(lease);
      requireCondition(secured?.parentIdentity === directory.parentIdentity
        && secured?.directoryIdentity === directory.sourceIdentity, "directory_identity_mismatch");
      await guardLease(lease, () => verifyPrivate({ parentRoot, directoryName: sourceName,
        expectedParentIdentity: directory.parentIdentity,
        expectedDirectoryIdentity: directory.sourceIdentity }, lease));
      assertLease(lease);
      snapshotHandle = await openFile(join(directory.root, LEAF_NAME),
        constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      leafIdentity = await snapshotHandle.stat({ bigint: true });
      requireCondition(ordinaryFile(leafIdentity) && leafIdentity.uid === BigInt(process.getuid())
        && (leafIdentity.mode & 0o777n) === 0o600n && leafIdentity.size === 0n, "snapshot_invalid");
      requireCondition(sameMetadata(await inspect(join(directory.root, LEAF_NAME), { bigint: true }),
        leafIdentity, IDENTITY_KEYS), "identity_mismatch");
      digest = await copyDigest(originalHandle, snapshotHandle, originalStat.size);
      await snapshotHandle.sync();
      requireCondition(sameMetadata(await originalHandle.stat({ bigint: true }), originalStat,
        [...BYTE_KEYS, "ctimeNs"]) && sameMetadata(await inspect(originalPath, { bigint: true }),
        originalStat, [...BYTE_KEYS, "ctimeNs"]), "identity_mismatch");
      snapshotStat = await snapshotHandle.stat({ bigint: true });
      requireCondition(sameMetadata(snapshotStat, leafIdentity, IDENTITY_KEYS)
        && snapshotStat.size === originalStat.size, "identity_mismatch");
      await verifySnapshot();
      await verifyOriginal();
      await guardDirectory(lease);
    });
  } catch (primaryCause) {
    const causes = [primaryCause];
    try { await removeOwnedDirectory(); } catch (cause) { causes.push(cause); }
    finally { causes.push(...await closeHandles()); }
    throw failure(causes, "creation_failed", "not_verified");
  }

  const cleanupAttempt = async () => {
    const causes = [];
    if (firstCleanup) {
      firstCleanup = false;
      try {
        if (closed) {
          stickyFailures.push(snapshotError("validation_unavailable"));
          try { await removeOwnedDirectory(); } catch (cause) { causes.push(cause); }
        } else {
          let snapshotPassed = false, originalPassed = false;
          try { await verifySnapshot(); snapshotPassed = true; }
          catch (cause) { stickyFailures.push(cause); }
          if (snapshotPassed) {
            try { await removeOwnedDirectory(); } catch (cause) { causes.push(cause); }
          }
          // Final original full-ctime/payload verification follows native removal;
          // on native failure it still captures a diagnostic before releasing FD.
          try { await verifyOriginal(); originalPassed = true; }
          catch (cause) { stickyFailures.push(cause); }
          validated = snapshotPassed && originalPassed;
        }
      } finally { stickyFailures.push(...await closeHandles()); }
    } else {
      try { await removeOwnedDirectory(); } catch (cause) { causes.push(cause); }
    }
    causes.unshift(...stickyFailures);
    if (causes.length > 0) throw failure(causes, "cleanup_failed",
      stickyFailures.length > 0 ? "not_verified" : validated ? "verified" : "not_verified");
    return receipt();
  };
  return Object.freeze({
    path: join(directory.root, LEAF_NAME),
    async verifyOriginal() { return serialized(verifyOriginal); },
    async verifySnapshot() { return serialized(verifySnapshot); },
    async releaseHandles() {
      return serialized(async () => {
        const causes = await closeHandles();
        if (causes.length > 0) throw failure([...causes], "release_failed", "not_verified");
        return receipt("not_verified");
      });
    },
    async cleanup() {
      if (cleanupResult !== undefined) return cleanupResult;
      if (cleanupInFlight === undefined) {
        cleanupInFlight = serialized(cleanupAttempt);
        cleanupInFlight.then(result => { cleanupResult = result; }, () => {}).finally(() => { cleanupInFlight = undefined; });
      }
      return cleanupInFlight;
    },
  });
}

function ordinaryFile(stat) {
  return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n;
}
function sameMetadata(actual, expected, keys) {
  return ordinaryFile(actual) && ordinaryFile(expected) && keys.every(key => actual[key] === expected[key]);
}
function nativeIdentity(stat) {
  return `${BigInt.asUintN(64, stat.dev).toString(16)}:${BigInt.asUintN(64, stat.ino).toString(16)}`;
}
function removalPins(directory) {
  return { parentRoot: directory.parentRoot, sourceName: directory.sourceName,
    expectedParentIdentity: directory.parentIdentity, expectedSourceIdentity: directory.sourceIdentity };
}
function snapshotError(code) { return new Error(`dmg_input_snapshot_${code}`); }
function requireCondition(condition, code) { if (!condition) throw snapshotError(code); }
function guardLease(lease, operation) { return typeof lease?.guard === "function" ? lease.guard(operation) : operation(); }
function assertLease(lease) { if (typeof lease?.assertHeld === "function") lease.assertHeld(); }

async function requireExactLeafInventory(root) {
  const stream = await opendir(root);
  try {
    const first = await stream.read(), second = await stream.read();
    requireCondition(first?.name === LEAF_NAME && second === null, "cleanup_inventory_mismatch");
  } finally { await stream.close(); }
}

async function readChunks(handle, size, consume) {
  requireCondition(size >= 0n && size <= MAXIMUM_BYTES, "budget_exceeded");
  const buffer = Buffer.alloc(CHUNK_BYTES), bytes = Number(size);
  let offset = 0, attempts = 0;
  // Limited extra partial-read attempts prevent an injected/misbehaving reader
  // from turning a bounded image into an unbounded operation count.
  const maximumAttempts = Math.ceil(bytes / CHUNK_BYTES) + 1024;
  while (offset < bytes) {
    requireCondition(attempts++ < maximumAttempts, "read_attempt_budget_exceeded");
    const length = Math.min(CHUNK_BYTES, bytes - offset);
    const result = await handle.read(buffer, 0, length, offset);
    requireCondition(Number.isSafeInteger(result.bytesRead) && result.bytesRead > 0
      && result.bytesRead <= length, "short_read");
    await consume(buffer.subarray(0, result.bytesRead), offset);
    offset += result.bytesRead;
  }
  requireCondition((await handle.read(buffer, 0, 1, bytes)).bytesRead === 0, "appended_bytes");
}
async function readDigest(handle, size) {
  const hash = createHash("sha256");
  await readChunks(handle, size, async bytes => { hash.update(bytes); });
  return hash.digest("hex");
}
async function copyDigest(source, destination, size) {
  const hash = createHash("sha256");
  let attempts = 0;
  const maximumAttempts = Math.ceil(Number(size) / CHUNK_BYTES) + 1024;
  await readChunks(source, size, async (bytes, position) => {
    hash.update(bytes);
    let offset = 0;
    while (offset < bytes.length) {
      requireCondition(attempts++ < maximumAttempts, "write_attempt_budget_exceeded");
      const length = bytes.length - offset;
      const result = await destination.write(bytes, offset, length, position + offset);
      requireCondition(Number.isSafeInteger(result.bytesWritten) && result.bytesWritten > 0
        && result.bytesWritten <= length, "short_write");
      offset += result.bytesWritten;
    }
  });
  return hash.digest("hex");
}
