import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import {
  lstat,
  mkdtemp,
  opendir,
  realpath,
  rmdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import {
  readAtomicPublishDirectoryIdentities,
  removeAtomicPublishDirectoryTree,
  removeAtomicPublishUnsecuredEmptyDirectory,
  securePrivateStagingDirectory,
  withAtomicPublishParentLease,
} from "../cua-driver-package-atomic-publish.mjs";

import { SigningContractError } from "./signing-contract.mjs";
import { createDmgInputSnapshot } from "./dmg-input-snapshot.mjs";
import { createDmgAttachmentCustody } from "./dmg-attachment-custody.mjs";

const require = createRequire(import.meta.url);
const COMMAND_TIMEOUT_MS = 120_000;
const COMMAND_MAX_BUFFER_BYTES = 1024 * 1024;
const NSIS_OUTER_MAX_ENTRIES = 256;
const FINAL_ARTIFACT_CLEANUP_MAX_ENTRIES = 100_000n;
const FINAL_ARTIFACT_CLEANUP_MAX_BYTES = 4n * 1024n * 1024n * 1024n;

export async function extractCuaDriverFinalArtifact(
  artifactPathValue,
  context = {},
  dependencies = {},
) {
  if (typeof artifactPathValue !== "string" || !isAbsolute(artifactPathValue)) {
    throw contractError("final_artifact_path_invalid", "Final artifact path must be absolute");
  }
  const artifactPath = resolve(artifactPathValue);
  await assertRegularArtifact(artifactPath);
  const platform = context.platform;
  const artifactRole = context.artifactRole;
  if (platform === "darwin" && artifactRole === "outer-zip") {
    return extractZip(artifactPath, dependencies);
  }
  if (platform === "darwin" && artifactRole === "outer-dmg") {
    return mountDmg(artifactPath, dependencies);
  }
  if (platform === "win32" && artifactRole === "outer-nsis") {
    return extractNsis(artifactPath, context, dependencies);
  }
  throw contractError(
    "final_artifact_kind_unsupported",
    `Unsupported ${String(platform)} artifact role ${String(artifactRole)}`,
  );
}

async function extractZip(artifactPath, dependencies) {
  const createTemporaryRoot = dependencies.mkdtemp ?? mkdtemp;
  const runCommand = dependencies.runCommand ?? runBoundedCommand;
  const root = await createTemporaryRoot(join(tmpdir(), "ling-cua-final-zip-"));
  const cleanup = await initializeIdentityBoundRecursiveCleanup(
    root,
    { allowDarwinArtifactSymlinks: true },
    dependencies,
  );
  try {
    await runCommand("/usr/bin/ditto", ["-x", "-k", artifactPath, root]);
    await assertRealDirectory(root);
    return Object.freeze({ artifactRoot: root, cleanup });
  } catch (error) {
    await cleanupAfterExtractionFailure(error, cleanup);
  }
}

async function mountDmg(artifactPath, dependencies) {
  const createTemporaryRoot = dependencies.mkdtemp ?? mkdtemp;
  const runCommand = dependencies.runCommand ?? runBoundedCommand;
  const createSnapshot = dependencies.createDmgInputSnapshot ?? createDmgInputSnapshot;
  // hdiutil may write checksum-cache xattrs even when the volume is read-only.
  // It must never receive the original immutable final artifact pathname.
  const snapshot = await createSnapshot(artifactPath, dependencies);
  let custody;
  try {
    const temporaryRoot = await createTemporaryRoot(join(tmpdir(), "ling-cua-final-dmg-"));
    custody = await initializeDmgMountPointCustody(temporaryRoot, dependencies);
  } catch (error) {
    await cleanupAfterExtractionFailure(error, () => snapshot.cleanup());
  }
  const mountPoint = custody.root;
  let attachment;
  let attachEntered = false;
  let detached = false;
  let hostRemoved = false;
  const cleanup = retryableCleanup(async () => {
    if (attachEntered) {
      try {
        // A previous detach does not authorize a later filesystem retry: a
        // retained backing image may have been attached again in the meantime.
        await attachment.detach();
        detached = true;
      } catch (detachError) {
        // Unknown or changed attachment ownership cannot authorize path detach
        // or deletion of a potentially mounted backing image, even on retry.
        const causes = [detachError];
        try { await snapshot.releaseHandles(); }
        catch (releaseError) { causes.push(releaseError); }
        const error = new AggregateError(causes, `final_artifact_dmg_detach_failed:${mountPoint}`);
        attachTemporaryRootCleanupReceipt(error, custody);
        Object.defineProperties(error, {
          snapshotResiduePath: { value: snapshot.path },
          attachmentReceipt: { value: attachment.receipt() },
        });
        throw error;
      }
    }
    if (detached || !attachEntered) {
      // A mounted path exposes the volume root, not these original host pins.
      // Only after detach may the exact original empty host directory be removed.
      const causes = [];
      if (!hostRemoved) {
        try {
          await removeUninitializedTemporaryRoot(custody, dependencies);
          hostRemoved = true;
        } catch (error) { causes.push(error); }
      }
      // Confirm original host recovery before deleting the backing image. A
      // failed host cleanup only releases handles; retry retains all old pins.
      try {
        if (hostRemoved) await snapshot.cleanup();
        else await snapshot.releaseHandles();
      }
      catch (error) { causes.push(error); }
      if (causes.length > 1) {
        throw new AggregateError(causes, "final_artifact_dmg_host_and_input_cleanup_failed");
      }
      if (causes.length === 1) throw causes[0];
    }
  });
  try {
    attachment = createDmgAttachmentCustody({
      snapshotPath: snapshot.path,
      mountPoint,
      runCommand,
      async beforeAttach() {
        // info is awaited. Recheck the original host inode after that read,
        // before a pathname can be handed to the OS mount command.
        await assertDmgMountPointCustody(custody, dependencies);
        await snapshot.verifySnapshot();
        await snapshot.verifyOriginal();
      },
    });
    await snapshot.verifyOriginal();
    await snapshot.verifySnapshot();
    attachEntered = true;
    await attachment.attach();
    await snapshot.verifySnapshot();
    await snapshot.verifyOriginal();
    await assertRealDirectory(mountPoint);
    return Object.freeze({ artifactRoot: mountPoint, cleanup });
  } catch (error) {
    await cleanupAfterExtractionFailure(error, cleanup);
  }
}

async function assertDmgMountPointCustody(receipt, dependencies) {
  const withParentLease = dependencies.withAtomicPublishParentLease ?? withAtomicPublishParentLease;
  const readIdentities = dependencies.readAtomicPublishDirectoryIdentities ?? readAtomicPublishDirectoryIdentities;
  await withParentLease({ parentRoot: receipt.parentRoot }, async lease => {
    const current = await guardLease(lease, () => readIdentities({
      parentRoot: receipt.parentRoot,
      sourceName: receipt.sourceName,
    }, lease));
    assertLeaseHeld(lease);
    if (current?.parentIdentity !== receipt.parentIdentity || current?.sourceIdentity !== receipt.sourceIdentity) {
      throw contractError("final_artifact_cleanup_identity_mismatch", "DMG host mountpoint changed before attach");
    }
  });
}

/** Pin the first host-directory stat, never the mounted view or a later replacement. */
async function initializeDmgMountPointCustody(rootValue, dependencies) {
  let receipt;
  try {
    const root = resolve(rootValue);
    const parentRoot = await realpath(dirname(root));
    const sourceName = basename(root);
    const [parent, source] = await Promise.all([
      lstat(parentRoot, { bigint: true }),
      lstat(root, { bigint: true }),
    ]);
    if (!parent.isDirectory() || parent.isSymbolicLink()
      || !source.isDirectory() || source.isSymbolicLink()) {
      throw contractError("final_artifact_cleanup_root_invalid", `Unsafe initial DMG mountpoint: ${root}`);
    }
    receipt = Object.freeze({
      // Darwin IdentityString casts dev/ino to uint64_t, then emits lowercase hex.
      parentIdentity: `${BigInt.asUintN(64, parent.dev).toString(16)}:${BigInt.asUintN(64, parent.ino).toString(16)}`,
      parentRoot,
      root: join(parentRoot, sourceName),
      sourceIdentity: `${BigInt.asUintN(64, source.dev).toString(16)}:${BigInt.asUintN(64, source.ino).toString(16)}`,
      sourceName,
    });
    const withParentLease = dependencies.withAtomicPublishParentLease ?? withAtomicPublishParentLease;
    const readIdentities = dependencies.readAtomicPublishDirectoryIdentities ?? readAtomicPublishDirectoryIdentities;
    const securePrivateDirectory = dependencies.securePrivateStagingDirectory ?? securePrivateStagingDirectory;
    await withParentLease({ parentRoot }, async lease => {
      const current = await guardLease(lease, () => readIdentities({ parentRoot, sourceName }, lease));
      assertLeaseHeld(lease);
      if (current?.parentIdentity !== receipt.parentIdentity || current?.sourceIdentity !== receipt.sourceIdentity) {
        throw contractError("final_artifact_cleanup_identity_mismatch", `DMG mountpoint changed before binding: ${root}`);
      }
      const secured = await guardLease(lease, () => securePrivateDirectory({
        directoryName: sourceName,
        expectedDirectoryIdentity: receipt.sourceIdentity,
        expectedParentIdentity: receipt.parentIdentity,
        parentRoot,
      }, lease));
      assertLeaseHeld(lease);
      if (secured?.parentIdentity !== receipt.parentIdentity || secured?.directoryIdentity !== receipt.sourceIdentity) {
        throw contractError("final_artifact_cleanup_identity_mismatch", `DMG mountpoint changed while securing: ${root}`);
      }
    });
    return receipt;
  } catch (initializationError) {
    if (receipt !== undefined) {
      try {
        await removeUninitializedTemporaryRoot(receipt, dependencies);
      } catch (cleanupError) {
        const aggregate = new AggregateError(
          [initializationError, cleanupError],
          "final_artifact_cleanup_initialization_and_recovery_failed",
        );
        attachTemporaryRootCleanupReceipt(aggregate, receipt);
        throw aggregate;
      }
      throw initializationError;
    }
    // No trusted initial identity: do not fall back to path-only rmdir.
    const aggregate = new AggregateError(
      [initializationError],
      "final_artifact_cleanup_initialization_and_recovery_failed",
    );
    attachTemporaryRootCleanupReceipt(aggregate, { root: resolve(rootValue) });
    throw aggregate;
  }
}

async function extractNsis(artifactPath, context, dependencies) {
  if ((context.environment ?? process.env).ELECTRON_BUILDER_7ZIP_PATH) {
    throw contractError(
      "final_artifact_7zip_override_forbidden",
      "Provider-bearing verification cannot use ELECTRON_BUILDER_7ZIP_PATH",
    );
  }
  const createTemporaryRoot = dependencies.mkdtemp ?? mkdtemp;
  const runCommand = dependencies.runCommand ?? runBoundedCommand;
  const sevenZipPath = dependencies.getPath7za
    ? await dependencies.getPath7za()
    : await resolvePinnedSevenZip();
  const containerRoot = await createTemporaryRoot(join(tmpdir(), "ling-cua-final-nsis-"));
  const outerRoot = join(containerRoot, "outer");
  const appRoot = join(containerRoot, "app");
  const cleanup = await initializeIdentityBoundRecursiveCleanup(containerRoot, {}, dependencies);
  try {
    await runCommand(sevenZipPath, ["x", "-bd", "-bb0", "-y", `-o${outerRoot}`, artifactPath]);
    const nestedArchive = await findExactNsisAppArchive(outerRoot);
    await runCommand(sevenZipPath, ["x", "-bd", "-bb0", "-y", `-o${appRoot}`, nestedArchive]);
    await assertRealDirectory(appRoot);
    return Object.freeze({ artifactRoot: appRoot, cleanup });
  } catch (error) {
    await cleanupAfterExtractionFailure(error, cleanup);
  }
}

async function resolvePinnedSevenZip() {
  const electronBuilderPackage = require.resolve("electron-builder/package.json");
  const electronBuilder = require(electronBuilderPackage);
  const electronBuilderRequire = createRequire(electronBuilderPackage);
  const appBuilderPackage = electronBuilderRequire.resolve("app-builder-lib/package.json");
  const appBuilder = electronBuilderRequire(appBuilderPackage);
  if (electronBuilder.version !== "26.15.3" || appBuilder.version !== "26.15.3") {
    throw contractError(
      "final_artifact_builder_version_mismatch",
      `Expected electron-builder/app-builder-lib 26.15.3, got ${String(electronBuilder.version)}/${String(appBuilder.version)}`,
    );
  }
  const pinnedRequire = createRequire(appBuilderPackage);
  const { getPath7za } = pinnedRequire("app-builder-lib/out/toolsets/7zip.js");
  return getPath7za();
}

async function findExactNsisAppArchive(root) {
  const candidates = [];
  let entries = 0;
  async function visit(directory) {
    const handle = await opendir(directory);
    for await (const entry of handle) {
      entries += 1;
      if (entries > NSIS_OUTER_MAX_ENTRIES) {
        throw contractError(
          "final_artifact_nsis_inventory_oversized",
          "Extracted NSIS outer inventory exceeds the fixed verification bound",
        );
      }
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw contractError("final_artifact_nsis_reparse_forbidden", `Unexpected link: ${path}`);
      }
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile() && entry.name.toLowerCase() === "app-64.7z") {
        candidates.push(path);
      }
    }
  }
  await visit(root);
  const expected = join(root, "$PLUGINSDIR", "app-64.7z");
  if (candidates.length !== 1 || resolve(candidates[0]) !== resolve(expected)) {
    throw contractError(
      "final_artifact_nsis_app_archive_invalid",
      `Expected exactly ${expected}, found ${String(candidates.length)}`,
    );
  }
  await assertRegularArtifact(expected);
  const [rootRealPath, archiveRealPath] = await Promise.all([realpath(root), realpath(expected)]);
  const relativePath = relative(rootRealPath, archiveRealPath);
  if (
    relativePath === ""
    || relativePath === ".."
    || relativePath.startsWith(`..${sep}`)
    || isAbsolute(relativePath)
  ) {
    throw contractError("final_artifact_nsis_reparse_forbidden", "Nested NSIS archive escaped extraction root");
  }
  return expected;
}

function retryableCleanup(operation) {
  let cleaned = false;
  let cleanupPromise;
  return async function cleanup() {
    if (cleaned) return;
    cleanupPromise ??= Promise.resolve()
      .then(operation)
      .then(() => {
        cleaned = true;
      })
      .catch((error) => {
        cleanupPromise = undefined;
        throw error;
      });
    await cleanupPromise;
  };
}

async function identityBoundRecursiveCleanup(root, options, dependencies) {
  const parentRoot = await realpath(dirname(root));
  const sourceName = basename(root);
  const withParentLease = dependencies.withAtomicPublishParentLease
    ?? withAtomicPublishParentLease;
  const readIdentities = dependencies.readAtomicPublishDirectoryIdentities
    ?? readAtomicPublishDirectoryIdentities;
  const securePrivateDirectory = dependencies.securePrivateStagingDirectory
    ?? securePrivateStagingDirectory;
  const removeDirectoryTree = dependencies.removeAtomicPublishDirectoryTree
    ?? removeAtomicPublishDirectoryTree;
  const removeUnsecuredEmptyDirectory =
    dependencies.removeAtomicPublishUnsecuredEmptyDirectory
    ?? removeAtomicPublishUnsecuredEmptyDirectory;
  const measureInventory = dependencies.testOnlyMeasureFinalArtifactCleanupInventory
    ?? measureFinalArtifactCleanupInventory;
  const beforeNativeRemove = dependencies.testOnlyAfterCleanupInventory
    ?? (() => {});
  const expected = await withParentLease({ parentRoot }, async (lease) => {
    const identities = await guardLease(lease, () => readIdentities({
      parentRoot,
      sourceName,
    }, lease));
    assertLeaseHeld(lease);
    let secured;
    try {
      secured = await guardLease(lease, () => securePrivateDirectory({
        directoryName: sourceName,
        expectedDirectoryIdentity: identities.sourceIdentity,
        expectedParentIdentity: identities.parentIdentity,
        parentRoot,
      }, lease));
    } catch (securityError) {
      try {
        await guardLease(lease, () => removeUnsecuredEmptyDirectory({
          expectedParentIdentity: identities.parentIdentity,
          expectedSourceIdentity: identities.sourceIdentity,
          parentRoot,
          sourceName,
        }, lease));
        assertLeaseHeld(lease);
      } catch (cleanupError) {
        throw new AggregateError(
          [securityError, cleanupError],
          "final_artifact_cleanup_initialization_and_cleanup_failed",
        );
      }
      throw securityError;
    }
    assertLeaseHeld(lease);
    if (secured.parentIdentity !== identities.parentIdentity
      || secured.directoryIdentity !== identities.sourceIdentity) {
      throw contractError(
        "final_artifact_cleanup_identity_mismatch",
        `Extraction root changed while binding cleanup identity: ${root}`,
      );
    }
    return Object.freeze({
      parentIdentity: identities.parentIdentity,
      sourceIdentity: identities.sourceIdentity,
    });
  });

  return retryableCleanup(async () => {
    await withParentLease({ parentRoot }, async (lease) => {
      let current;
      try {
        current = await guardLease(lease, () => readIdentities({
          parentRoot,
          sourceName,
        }, lease));
      } catch (error) {
        if (error?.nativeReason === "source_missing") return;
        throw error;
      }
      assertLeaseHeld(lease);
      if (current.parentIdentity !== expected.parentIdentity
        || current.sourceIdentity !== expected.sourceIdentity) {
        throw contractError(
          "final_artifact_cleanup_identity_mismatch",
          `Refusing to remove a replaced extraction root: ${root}`,
        );
      }
      const inventory = requireBoundedCleanupInventory(
        await guardLease(lease, () => measureInventory(root, options)),
      );
      assertLeaseHeld(lease);
      await guardLease(lease, () => beforeNativeRemove(Object.freeze({
        expectedParentIdentity: expected.parentIdentity,
        expectedSourceIdentity: expected.sourceIdentity,
        inventory,
        root,
      })));
      assertLeaseHeld(lease);
      await guardLease(lease, () => removeDirectoryTree({
        parentRoot,
        sourceName,
        expectedParentIdentity: expected.parentIdentity,
        expectedSourceIdentity: expected.sourceIdentity,
        expectedEntries: inventory.entries,
        expectedTotalBytes: inventory.totalBytes,
        entryPolicy: options.allowDarwinArtifactSymlinks
          ? "darwin-artifact-symlinks"
          : "artifact",
      }, lease));
      assertLeaseHeld(lease);
    });
  });
}

async function initializeIdentityBoundRecursiveCleanup(root, options, dependencies) {
  let receipt;
  try {
    receipt = await captureTemporaryRootReceipt(root, dependencies);
  } catch (initializationError) {
    let cleanupError;
    try {
      await removeFreshEmptyTemporaryRoot(root, dependencies);
    } catch (error) {
      cleanupError = error;
    }
    if (!cleanupError) throw initializationError;
    const aggregate = new AggregateError(
      [initializationError, cleanupError],
      "final_artifact_cleanup_initialization_and_recovery_failed",
    );
    attachTemporaryRootCleanupReceipt(aggregate, { root });
    throw aggregate;
  }
  try {
    return await identityBoundRecursiveCleanup(root, options, dependencies);
  } catch (initializationError) {
    try {
      await lstat(root);
    } catch (error) {
      if (error?.code === "ENOENT") throw initializationError;
      throw error;
    }
    let cleanupError;
    try {
      await removeUninitializedTemporaryRoot(receipt, dependencies);
    } catch (error) {
      cleanupError = error;
    }
    if (!cleanupError) throw initializationError;
    const aggregate = new AggregateError(
      [initializationError, cleanupError],
      "final_artifact_cleanup_initialization_and_recovery_failed",
    );
    attachTemporaryRootCleanupReceipt(aggregate, receipt);
    throw aggregate;
  }
}

async function captureTemporaryRootReceipt(rootValue, dependencies) {
  const root = resolve(rootValue);
  const parentRoot = await realpath(dirname(root));
  const sourceName = basename(root);
  const [parent, source] = await Promise.all([
    lstat(parentRoot, { bigint: true }),
    lstat(root, { bigint: true }),
  ]);
  if (
    !parent.isDirectory()
    || parent.isSymbolicLink()
    || !source.isDirectory()
    || source.isSymbolicLink()
  ) {
    throw contractError(
      "final_artifact_cleanup_root_invalid",
      `Fresh extraction root is not a real directory: ${root}`,
    );
  }
  const readIdentities = dependencies.readAtomicPublishDirectoryIdentities
    ?? readAtomicPublishDirectoryIdentities;
  const identities = await readIdentities({ parentRoot, sourceName });
  if (
    typeof identities?.parentIdentity !== "string"
    || typeof identities?.sourceIdentity !== "string"
  ) {
    throw contractError(
      "final_artifact_cleanup_identity_invalid",
      `Unable to bind the fresh extraction root identity: ${root}`,
    );
  }
  return Object.freeze({
    parentIdentity: identities.parentIdentity,
    parentRoot,
    root,
    sourceIdentity: identities.sourceIdentity,
    sourceName,
  });
}

async function removeFreshEmptyTemporaryRoot(rootValue, dependencies) {
  const root = resolve(rootValue);
  const metadata = await lstat(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw contractError(
      "final_artifact_cleanup_root_invalid",
      `Fresh extraction root is not a real directory: ${root}`,
    );
  }
  await (dependencies.rmdir ?? rmdir)(root);
}

async function removeUninitializedTemporaryRoot(receipt, dependencies) {
  const withParentLease = dependencies.withAtomicPublishParentLease
    ?? withAtomicPublishParentLease;
  const readIdentities = dependencies.readAtomicPublishDirectoryIdentities
    ?? readAtomicPublishDirectoryIdentities;
  const removeEmptyDirectory = dependencies.removeAtomicPublishUnsecuredEmptyDirectory
    ?? removeAtomicPublishUnsecuredEmptyDirectory;
  await withParentLease({ parentRoot: receipt.parentRoot }, async (lease) => {
    const current = await guardLease(lease, () => readIdentities({
      parentRoot: receipt.parentRoot,
      sourceName: receipt.sourceName,
    }, lease));
    assertLeaseHeld(lease);
    if (
      current.parentIdentity !== receipt.parentIdentity
      || current.sourceIdentity !== receipt.sourceIdentity
    ) {
      throw contractError(
        "final_artifact_cleanup_identity_mismatch",
        `Refusing to remove a replaced extraction root: ${receipt.root}`,
      );
    }
    await guardLease(lease, () => removeEmptyDirectory({
      expectedParentIdentity: receipt.parentIdentity,
      expectedSourceIdentity: receipt.sourceIdentity,
      parentRoot: receipt.parentRoot,
      sourceName: receipt.sourceName,
    }, lease));
    assertLeaseHeld(lease);
  });
}

function attachTemporaryRootCleanupReceipt(error, receipt) {
  Object.defineProperty(error, "cleanup", {
    configurable: true,
    enumerable: true,
    value: Object.freeze({
      outcome: "residue",
      reason: "cleanup_initialization_failed",
      residuePath: receipt.root,
      ...(typeof receipt.sourceIdentity === "string"
        ? { residueIdentity: receipt.sourceIdentity }
        : {}),
    }),
    writable: false,
  });
}

async function measureFinalArtifactCleanupInventory(root, options) {
  const rootMetadata = await lstat(root, { bigint: true });
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw contractError("final_artifact_cleanup_root_invalid", `Unsafe cleanup root: ${root}`);
  }
  let entries = 0n;
  let totalBytes = 0n;
  async function visit(directory) {
    const handle = await opendir(directory);
    for await (const entry of handle) {
      const path = join(directory, entry.name);
      const metadata = await lstat(path, { bigint: true });
      if (metadata.dev !== rootMetadata.dev) {
        throw contractError(
          "final_artifact_cleanup_mount_forbidden",
          `Cleanup inventory crossed a filesystem boundary: ${path}`,
        );
      }
      entries += 1n;
      if (entries > FINAL_ARTIFACT_CLEANUP_MAX_ENTRIES) {
        throw contractError(
          "final_artifact_cleanup_inventory_oversized",
          `Cleanup inventory exceeds ${String(FINAL_ARTIFACT_CLEANUP_MAX_ENTRIES)} entries`,
        );
      }
      if (metadata.isSymbolicLink()) {
        if (!options.allowDarwinArtifactSymlinks) {
          throw contractError(
            "final_artifact_cleanup_reparse_forbidden",
            `Cleanup inventory contains an unexpected link: ${path}`,
          );
        }
        continue;
      }
      if (metadata.isDirectory()) {
        await visit(path);
        continue;
      }
      if (!metadata.isFile() || metadata.nlink !== 1n) {
        throw contractError(
          "final_artifact_cleanup_entry_invalid",
          `Cleanup inventory contains a non-regular or hard-linked entry: ${path}`,
        );
      }
      totalBytes += metadata.size;
      if (totalBytes > FINAL_ARTIFACT_CLEANUP_MAX_BYTES) {
        throw contractError(
          "final_artifact_cleanup_inventory_oversized",
          `Cleanup inventory exceeds ${String(FINAL_ARTIFACT_CLEANUP_MAX_BYTES)} bytes`,
        );
      }
    }
  }
  await visit(root);
  return Object.freeze({
    entries: Number(entries),
    totalBytes: Number(totalBytes),
  });
}

function requireBoundedCleanupInventory(value) {
  if (!Number.isSafeInteger(value?.entries)
    || value.entries < 0
    || BigInt(value.entries) > FINAL_ARTIFACT_CLEANUP_MAX_ENTRIES
    || !Number.isSafeInteger(value?.totalBytes)
    || value.totalBytes < 0
    || BigInt(value.totalBytes) > FINAL_ARTIFACT_CLEANUP_MAX_BYTES) {
    throw contractError(
      "final_artifact_cleanup_inventory_oversized",
      "Cleanup inventory must stay within the fixed entry and byte bounds",
    );
  }
  return Object.freeze({ entries: value.entries, totalBytes: value.totalBytes });
}

function guardLease(lease, operation) {
  return typeof lease?.guard === "function" ? lease.guard(operation) : operation();
}

function assertLeaseHeld(lease) {
  if (typeof lease?.assertHeld === "function") lease.assertHeld();
}

async function cleanupAfterExtractionFailure(error, cleanup) {
  try {
    await cleanup();
  } catch (cleanupError) {
    throw new AggregateError(
      [error, cleanupError],
      "final_artifact_extraction_and_cleanup_failed",
    );
  }
  throw error;
}

async function assertRegularArtifact(path) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    throw contractError("final_artifact_unavailable", `Unable to open ${path}`, error);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw contractError("final_artifact_path_invalid", `Artifact is not a regular file: ${path}`);
  }
}

async function assertRealDirectory(path) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    throw contractError("final_artifact_root_unavailable", `Unable to open ${path}`, error);
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw contractError("final_artifact_root_invalid", `Artifact root is not a real directory: ${path}`);
  }
}

export async function runBoundedCommand(command, args, options = {}) {
  if (options.stdin !== undefined && typeof options.stdin !== "string") {
    throw contractError("final_artifact_command_input_invalid", "Command stdin must be text");
  }
  if (options.stdin !== undefined && Buffer.byteLength(options.stdin, "utf8") > COMMAND_MAX_BUFFER_BYTES) {
    throw contractError("final_artifact_command_input_oversized", "Command stdin exceeds the fixed bound");
  }
  return new Promise((settle, reject) => {
    let inputError;
    const child = execFile(command, args, {
      encoding: "utf8",
      maxBuffer: COMMAND_MAX_BUFFER_BYTES,
      timeout: options.timeoutMs ?? COMMAND_TIMEOUT_MS,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      const boundedOutput = typeof stdout === "string" && typeof stderr === "string"
        && Buffer.byteLength(stdout, "utf8") <= COMMAND_MAX_BUFFER_BYTES
        && Buffer.byteLength(stderr, "utf8") <= COMMAND_MAX_BUFFER_BYTES;
      if (error || inputError || !boundedOutput) {
        const cause = error && inputError ? new AggregateError([error, inputError], "command_and_stdin_failed")
          : error ?? inputError;
        const failure = contractError(
          "final_artifact_command_failed",
          `${basename(command)} failed with ${String(error?.code ?? "unknown")}`,
          cause,
        );
        Object.defineProperty(failure, "commandReceipt", { value: Object.freeze({
          stdout: boundedOutput ? stdout : "",
          stderr: boundedOutput ? stderr : "",
          // Only a completed nonzero exit can retain a complete partial-attach
          // receipt. Timeout, signal, pipe failure and maxBuffer are unknown.
          outputComplete: boundedOutput && !inputError && Number.isInteger(error?.code)
            && error.killed !== true && !error.signal,
        }) });
        reject(failure);
      } else {
        settle(Object.freeze({ stdout, stderr }));
      }
    });
    child.stdin?.on("error", error => { inputError = error; });
    child.stdin?.end(options.stdin);
  });
}

function contractError(code, message, cause) {
  return new SigningContractError(code, message, cause ? { cause } : undefined);
}
