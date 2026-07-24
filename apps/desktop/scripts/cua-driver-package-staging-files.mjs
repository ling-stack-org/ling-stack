import { createHash } from "node:crypto";
import {
  constants as fsConstants,
  lstat,
  open,
  opendir,
  realpath,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import { fail, isWithin } from "./cua-driver-package-staging-contract.mjs";

// The fixed 0.8.3-ling.1 inventory needs at most four directories plus fourteen
// files, three relative path components, and far less than 128 MiB in total.
// Keep traversal bounded before the exact platform inventory is evaluated.
export const CUA_DRIVER_PACKAGE_TREE_LIMITS = Object.freeze({
  maxCumulativeBytes: 128 * 1024 * 1024,
  maxDepth: 3,
  maxEntries: 18,
});

export async function assertSafeTree(boundaryRoot, treeRoot) {
  const context = await prepareSafeTree(boundaryRoot, treeRoot);
  await walkSafeTree(context);
}

export async function listTreeInventory(root) {
  const context = await prepareSafeTree(root, root);
  const inventory = { directories: [], files: [] };
  await walkSafeTree(context, inventory);
  return Object.freeze({
    directories: Object.freeze(inventory.directories.sort()),
    files: Object.freeze(inventory.files.sort()),
  });
}

export async function readBoundedJsonSnapshot(path, maxBytes, label) {
  const snapshot = await readBoundedFileSnapshot(path, maxBytes, label);
  try {
    return Object.freeze({
      ...snapshot,
      value: JSON.parse(snapshot.bytes.toString("utf8")),
    });
  } catch {
    fail(`${label}_json_invalid`, `${label} is not valid JSON`, path);
  }
}

/**
 * Open one regular file without following a final symlink, then derive the
 * parsed value and digest from the same immutable Buffer snapshot. The opened
 * handle, rather than a second path lookup, is the authority for the bytes.
 */
export async function readBoundedFileSnapshot(path, maxBytes, label) {
  let handle;
  try {
    handle = await open(
      path,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
  } catch (error) {
    if (error?.code === "ELOOP") {
      fail("provider_reparse_forbidden", "symlink/junction/reparse entry is forbidden", path);
    }
    if (error?.code === "ENOENT") {
      fail(`${label}_missing`, `${label} is missing`, path);
    }
    throw error;
  }
  try {
    const before = await handle.stat({ bigint: true });
    assertRegularSnapshot(before, maxBytes, label, path);
    const bytes = await readExactBoundedSnapshot(handle, before.size, label, path);
    const after = await handle.stat({ bigint: true });
    assertRegularSnapshot(after, maxBytes, label, path);
    if (!sameFileSnapshot(before, after)
      || bytes.byteLength !== Number(after.size)) {
      fail(
        "provider_file_changed_during_read",
        `${label} changed while it was being read`,
        path,
      );
    }
    const named = await lstat(path, { bigint: true });
    if (named.isSymbolicLink() || !sameFileIdentity(named, after)) {
      fail(
        "provider_file_changed_during_read",
        `${label} path no longer names the verified file`,
        path,
      );
    }
    return Object.freeze({
      bytes,
      mode: Number(after.mode),
      sha256: sha256Bytes(bytes),
      size: bytes.byteLength,
    });
  } finally {
    await handle.close();
  }
}

async function readExactBoundedSnapshot(handle, size, label, path) {
  const expectedBytes = Number(size);
  const bytes = Buffer.allocUnsafe(expectedBytes);
  let offset = 0;
  while (offset < expectedBytes) {
    const result = await handle.read(
      bytes,
      offset,
      expectedBytes - offset,
      offset,
    );
    if (result.bytesRead === 0) {
      fail(
        "provider_file_changed_during_read",
        `${label} changed while it was being read`,
        path,
      );
    }
    offset += result.bytesRead;
  }
  const overflow = Buffer.allocUnsafe(1);
  const result = await handle.read(overflow, 0, 1, expectedBytes);
  if (result.bytesRead !== 0) {
    fail(
      "provider_file_changed_during_read",
      `${label} exceeded its verified size while it was being read`,
      path,
    );
  }
  return bytes;
}

export function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

export async function assertPathAbsent(path, code) {
  try {
    await lstat(path);
    fail(code, "refusing to overwrite an existing staging path", path);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

export async function assertCanonicalDisjointRoots(
  sourceRoot,
  outputRoot,
  code = "staging_roots_overlap",
  message = "source and output roots must not contain each other after canonical resolution",
) {
  const sourceCanonical = await realpath(sourceRoot);
  const outputCanonical = await canonicalizeProspectivePath(outputRoot);
  if (isWithin(sourceCanonical, outputCanonical)
    || isWithin(outputCanonical, sourceCanonical)) {
    fail(
      code,
      message,
      outputRoot,
    );
  }
  return Object.freeze({ sourceCanonical, outputCanonical });
}

export async function canonicalizeProspectivePath(path) {
  const missing = [];
  let cursor = resolve(path);
  while (true) {
    try {
      const canonical = await realpath(cursor);
      return resolve(canonical, ...missing.reverse());
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
      const parent = dirname(cursor);
      if (parent === cursor) {
        throw error;
      }
      missing.push(basename(cursor));
      cursor = parent;
    }
  }
}

export function canonicalPathKey(path) {
  const canonical = resolve(path);
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

async function prepareSafeTree(boundaryRoot, treeRoot) {
  const boundary = resolve(boundaryRoot);
  const tree = resolve(treeRoot);
  const boundaryStat = await lstatOrFail(boundary, "staging_boundary_missing");
  const treeStat = await lstatOrFail(tree, "staging_tree_missing");
  if (!boundaryStat.isDirectory() || boundaryStat.isSymbolicLink()) {
    fail("staging_boundary_unsafe", "staging boundary must be a real directory", boundary);
  }
  if (!treeStat.isDirectory() || treeStat.isSymbolicLink()) {
    fail("staging_tree_unsafe", "provider staging root must be a real directory", tree);
  }
  const boundaryReal = await realpath(boundary);
  const treeReal = await realpath(tree);
  assertCanonicalLocation(boundary, boundary, boundaryReal, boundaryReal);
  assertCanonicalLocation(tree, boundary, treeReal, boundaryReal);
  return Object.freeze({ boundary, boundaryReal, tree });
}

async function walkSafeTree(context, inventory) {
  const state = { cumulativeBytes: 0n, entries: 0 };
  await visitSafeDirectory(context.tree, context, inventory, state);
}

async function visitSafeDirectory(directory, context, inventory, state) {
  const directoryHandle = await opendir(directory, {
    bufferSize: CUA_DRIVER_PACKAGE_TREE_LIMITS.maxEntries + 1,
  });
  for await (const entry of directoryHandle) {
    const path = join(directory, entry.name);
    const metadata = await lstat(path, { bigint: true });
    if (entry.isSymbolicLink() || metadata.isSymbolicLink()) {
      fail("provider_reparse_forbidden", "symlink/junction/reparse entry is forbidden", path);
    }
    const canonical = await realpath(path);
    assertCanonicalLocation(
      path,
      context.boundary,
      canonical,
      context.boundaryReal,
    );
    const relativePath = relative(context.tree, path).split(sep).join("/");
    assertTreeEntryBudget(relativePath, path, state);
    if (entry.isDirectory() && metadata.isDirectory()) {
      inventory?.directories.push(relativePath);
      await visitSafeDirectory(path, context, inventory, state);
      continue;
    }
    if (!entry.isFile() || !metadata.isFile()) {
      fail("provider_non_regular_entry", "provider tree contains a non-regular entry", path);
    }
    if (metadata.nlink !== 1n) {
      fail("provider_hardlink_forbidden", "provider package files must not be hard links", path);
    }
    state.cumulativeBytes += metadata.size;
    if (state.cumulativeBytes
      > BigInt(CUA_DRIVER_PACKAGE_TREE_LIMITS.maxCumulativeBytes)) {
      fail(
        "provider_tree_cumulative_size_exceeded",
        `provider tree exceeds ${CUA_DRIVER_PACKAGE_TREE_LIMITS.maxCumulativeBytes} cumulative bytes`,
        path,
      );
    }
    inventory?.files.push(relativePath);
  }
}

function assertTreeEntryBudget(relativePath, path, state) {
  const depth = relativePath.split("/").length;
  if (depth > CUA_DRIVER_PACKAGE_TREE_LIMITS.maxDepth) {
    fail(
      "provider_tree_depth_exceeded",
      `provider tree exceeds maximum depth ${CUA_DRIVER_PACKAGE_TREE_LIMITS.maxDepth}`,
      path,
    );
  }
  state.entries += 1;
  if (state.entries > CUA_DRIVER_PACKAGE_TREE_LIMITS.maxEntries) {
    fail(
      "provider_tree_entry_count_exceeded",
      `provider tree exceeds ${CUA_DRIVER_PACKAGE_TREE_LIMITS.maxEntries} entries`,
      path,
    );
  }
}

function assertCanonicalLocation(path, boundary, canonical, boundaryReal) {
  const lexicalRelative = relative(boundary, path);
  const expectedCanonical = resolve(boundaryReal, lexicalRelative);
  if (canonicalPathKey(canonical) !== canonicalPathKey(expectedCanonical)
    || !isWithin(canonical, boundaryReal)) {
    fail(
      "provider_reparse_forbidden",
      "provider path resolves through a symlink, junction or reparse point",
      path,
    );
  }
}

function assertRegularSnapshot(metadata, maxBytes, label, path) {
  if (!metadata.isFile()
    || metadata.isSymbolicLink()
    || metadata.nlink !== 1n
    || metadata.size <= 0n
    || metadata.size > BigInt(maxBytes)) {
    fail(
      `${label}_size_invalid`,
      `${label} must be one non-hardlinked, non-empty bounded regular file`,
      path,
    );
  }
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFileSnapshot(left, right) {
  return sameFileIdentity(left, right)
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

async function lstatOrFail(path, code) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") {
      fail(code, "required staging path is missing", path);
    }
    throw error;
  }
}
