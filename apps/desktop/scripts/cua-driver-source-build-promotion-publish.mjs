import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import {
  atomicPublishDirectoryNoReplace,
  preflightAtomicPublishDirectoryNoReplace,
  readAtomicPublishDirectoryIdentities,
  removeAtomicPublishDirectoryTree,
  removeAtomicPublishUnsecuredEmptyDirectory,
  securePrivateStagingDirectory,
  verifyPrivateStagingDirectorySecurity,
  withAtomicPublishParentLease,
} from "./cua-driver-package-atomic-publish.mjs";
import {
  assertPathAbsent,
  canonicalizeProspectivePath,
  canonicalPathKey,
  listTreeInventory,
  readBoundedFileSnapshot,
} from "./cua-driver-package-staging-files.mjs";
import {
  assertDeepEqual,
  fail,
} from "./cua-driver-source-build-promotion-records.mjs";

const PROPOSAL_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Capture the exact native output-parent identity before either candidate is
 * executed. Promotion later refuses to publish through a replaced parent.
 */
export async function preparePromotionOutput(outputRoot) {
  const publishRoot = await canonicalizeProspectivePath(outputRoot);
  const parentRoot = dirname(publishRoot);
  await assertPathAbsent(outputRoot, "promotion_output_exists");
  await assertPathAbsent(publishRoot, "promotion_output_exists");
  await preflightAtomicPublishDirectoryNoReplace();
  const parentIdentity = await withAtomicPublishParentLease(
    { parentRoot },
    async (lease) => {
      await assertOutputPathStable(outputRoot, publishRoot);
      return lease.parentIdentity;
    },
  );
  return Object.freeze({ outputRoot, parentIdentity, parentRoot, publishRoot });
}

/**
 * Write a private sibling directory and publish it with the existing native
 * no-replace primitive while the originally captured parent identity is held.
 */
export async function publishPromotionOutput({
  outputAuthority,
  proposedProviderLockBytes,
  promotionReceiptBytes,
}) {
  return publishPromotionOutputInternal({
    outputAuthority,
    proposedProviderLockBytes,
    promotionReceiptBytes,
  }, NOOP_PUBLISH_HOOKS);
}

/** Test-only factory for deterministic publication-boundary races. */
export function createPromotionOutputPublisherForTest(hooks) {
  const allowed = new Set([
    "afterAtomicPublish",
    "afterFilesWritten",
    "afterPrivateSecured",
    "afterTemporaryIdentityBeforeSecure",
  ]);
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)
    || Object.keys(hooks).some((key) => !allowed.has(key))
    || Object.values(hooks).some((value) => typeof value !== "function")) {
    throw new TypeError("promotion output test hooks must be known functions");
  }
  return (input) => publishPromotionOutputInternal(input, Object.freeze({
    ...NOOP_PUBLISH_HOOKS,
    ...hooks,
  }));
}

const NOOP_PUBLISH_HOOKS = Object.freeze({
  afterAtomicPublish: async () => {},
  afterFilesWritten: async () => {},
  afterPrivateSecured: async () => {},
  afterTemporaryIdentityBeforeSecure: async () => {},
});

async function publishPromotionOutputInternal({
  outputAuthority,
  proposedProviderLockBytes,
  promotionReceiptBytes,
}, hooks) {
  const files = Object.freeze([
    Object.freeze({ name: "provider-lock.json", bytes: proposedProviderLockBytes }),
    Object.freeze({ name: "source-build-promotion-receipt.json", bytes: promotionReceiptBytes }),
  ]);
  for (const file of files) {
    if (!Buffer.isBuffer(file.bytes) || file.bytes.byteLength > PROPOSAL_MAX_BYTES) {
      fail("promotion_output_bytes_invalid", `${file.name} is not a bounded Buffer`);
    }
  }

  return withAtomicPublishParentLease(
    { parentRoot: outputAuthority.parentRoot },
    async (lease) => {
      if (lease.parentIdentity !== outputAuthority.parentIdentity) {
        fail(
          "promotion_output_parent_changed",
          "promotion output parent identity changed while candidates were verified",
        );
      }
      await assertOutputPathStable(
        outputAuthority.outputRoot,
        outputAuthority.publishRoot,
      );
      await assertPathAbsent(outputAuthority.outputRoot, "promotion_output_exists");
      await assertPathAbsent(outputAuthority.publishRoot, "promotion_output_exists");

      const temporaryName = `${basename(outputAuthority.publishRoot)}.tmp-${process.pid}-${randomUUID()}`;
      const temporaryRoot = join(outputAuthority.parentRoot, temporaryName);
      let temporaryCreated = false;
      let temporaryIdentity;
      let privateDirectory = false;
      let published = false;
      let writtenEntries = 0;
      let writtenBytes = 0;
      try {
        await lease.guard(() => mkdir(temporaryRoot, { mode: 0o700 }));
        temporaryCreated = true;
        const identities = await readAtomicPublishDirectoryIdentities({
          parentRoot: outputAuthority.parentRoot,
          sourceName: temporaryName,
        }, lease);
        if (identities.parentIdentity !== outputAuthority.parentIdentity) {
          fail(
            "promotion_output_parent_changed",
            "temporary proposal directory was not created under the captured parent",
          );
        }
        temporaryIdentity = identities.sourceIdentity;
        await lease.guard(() => hooks.afterTemporaryIdentityBeforeSecure(Object.freeze({
          outputRoot: outputAuthority.outputRoot,
          temporaryRoot,
        })));
        await securePrivateStagingDirectory({
          directoryName: temporaryName,
          expectedDirectoryIdentity: temporaryIdentity,
          expectedParentIdentity: outputAuthority.parentIdentity,
          parentRoot: outputAuthority.parentRoot,
        }, lease);
        privateDirectory = true;
        await lease.guard(() => hooks.afterPrivateSecured(Object.freeze({
          outputRoot: outputAuthority.outputRoot,
          temporaryRoot,
        })));

        for (const file of files) {
          await lease.guard(() => writeFile(join(temporaryRoot, file.name), file.bytes, {
            flag: "wx",
            mode: 0o600,
            signal: lease.signal,
          }));
          writtenEntries += 1;
          writtenBytes += file.bytes.byteLength;
        }
        await lease.guard(() => hooks.afterFilesWritten(Object.freeze({
          outputRoot: outputAuthority.outputRoot,
          temporaryRoot,
        })));
        await verifyPrivateStagingDirectorySecurity({
          directoryName: temporaryName,
          expectedDirectoryIdentity: temporaryIdentity,
          expectedParentIdentity: outputAuthority.parentIdentity,
          parentRoot: outputAuthority.parentRoot,
        }, lease);
        await verifyProposalFiles(temporaryRoot, files);
        await assertOutputPathStable(
          outputAuthority.outputRoot,
          outputAuthority.publishRoot,
        );
        await assertPathAbsent(outputAuthority.outputRoot, "promotion_output_exists");
        await assertPathAbsent(outputAuthority.publishRoot, "promotion_output_exists");

        await atomicPublishDirectoryNoReplace({
          destinationName: basename(outputAuthority.publishRoot),
          expectedParentIdentity: outputAuthority.parentIdentity,
          expectedSourceIdentity: temporaryIdentity,
          parentRoot: outputAuthority.parentRoot,
          sourceName: temporaryName,
        }, lease);
        published = true;
        temporaryCreated = false;
        await lease.guard(() => hooks.afterAtomicPublish(Object.freeze({
          outputRoot: outputAuthority.publishRoot,
          temporaryRoot,
        })));

        const publishedIdentity = await readAtomicPublishDirectoryIdentities({
          parentRoot: outputAuthority.parentRoot,
          sourceName: basename(outputAuthority.publishRoot),
        }, lease);
        if (publishedIdentity.parentIdentity !== outputAuthority.parentIdentity
          || publishedIdentity.sourceIdentity !== temporaryIdentity) {
          fail(
            "promotion_output_identity_changed",
            "published proposal no longer matches its private staging identity",
          );
        }
        await verifyPrivateStagingDirectorySecurity({
          directoryName: basename(outputAuthority.publishRoot),
          expectedDirectoryIdentity: temporaryIdentity,
          expectedParentIdentity: outputAuthority.parentIdentity,
          parentRoot: outputAuthority.parentRoot,
        }, lease);
        await verifyProposalFiles(outputAuthority.publishRoot, files);
        return Object.freeze({
          proposedLockPath: join(outputAuthority.publishRoot, files[0].name),
          receiptPath: join(outputAuthority.publishRoot, files[1].name),
        });
      } catch (error) {
        if (!published && temporaryCreated && temporaryIdentity !== undefined) {
          try {
            if (privateDirectory) {
              await removeAtomicPublishDirectoryTree({
                expectedEntries: writtenEntries,
                expectedParentIdentity: outputAuthority.parentIdentity,
                expectedSourceIdentity: temporaryIdentity,
                expectedTotalBytes: writtenBytes,
                parentRoot: outputAuthority.parentRoot,
                sourceName: temporaryName,
              }, lease);
            } else {
              await removeAtomicPublishUnsecuredEmptyDirectory({
                expectedParentIdentity: outputAuthority.parentIdentity,
                expectedSourceIdentity: temporaryIdentity,
                parentRoot: outputAuthority.parentRoot,
                sourceName: temporaryName,
              }, lease);
            }
          } catch (cleanupError) {
            attachCleanupError(error, cleanupError, temporaryRoot);
          }
        }
        throw error;
      }
    },
  );
}

async function assertOutputPathStable(outputRoot, expectedCanonical) {
  const currentCanonical = await canonicalizeProspectivePath(outputRoot);
  if (canonicalPathKey(currentCanonical) !== canonicalPathKey(expectedCanonical)) {
    fail(
      "promotion_output_parent_changed",
      "promotion output path changed canonical location while candidates were verified",
    );
  }
}

async function verifyProposalFiles(root, files) {
  const inventory = await listTreeInventory(root);
  assertDeepEqual(
    inventory.directories,
    [],
    "promotion_output_inventory_invalid",
    "promotion output contains an unexpected directory",
  );
  assertDeepEqual(
    inventory.files,
    files.map((file) => file.name).sort(),
    "promotion_output_inventory_invalid",
    "promotion output contains a missing or unexpected file",
  );
  for (const file of files) {
    const snapshot = await readBoundedFileSnapshot(
      join(root, file.name),
      PROPOSAL_MAX_BYTES,
      "promotion_output_file",
    );
    if (!snapshot.bytes.equals(file.bytes)) {
      fail("promotion_output_changed", `${file.name} changed before publication completed`);
    }
  }
}

function attachCleanupError(error, cleanupError, temporaryRoot) {
  if (!(error instanceof Error) || !Object.isExtensible(error)) return;
  try {
    Object.defineProperties(error, {
      promotionCleanupError: {
        configurable: true,
        enumerable: false,
        value: cleanupError,
      },
      promotionResiduePath: {
        configurable: true,
        enumerable: false,
        value: temporaryRoot,
      },
    });
  } catch {
    // Preserve the promotion failure when diagnostic metadata is locked.
  }
}
