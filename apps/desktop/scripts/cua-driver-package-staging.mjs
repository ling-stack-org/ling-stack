#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  opendir,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertDisjointRoots,
  CUA_DRIVER_COMMITTED_LOCK_SHA256,
  CUA_DRIVER_PACKAGE_DESTINATION,
  CUA_DRIVER_PACKAGE_REVISION,
  CuaDriverPackageStagingError,
  fail,
  normalizePackagePlatform,
  preSignProviderFiles,
  providerRelativePath,
  providerRootFor,
  requireAbsoluteRoot,
  resolveRelative,
} from "./cua-driver-package-staging-contract.mjs";
import {
  assertCanonicalDisjointRoots,
  assertPathAbsent,
  assertSafeTree,
  canonicalizeProspectivePath,
  canonicalPathKey,
  listTreeInventory,
  readBoundedFileSnapshot,
  readBoundedJsonSnapshot,
} from "./cua-driver-package-staging-files.mjs";
import {
  atomicPublishDirectoryNoReplace,
  CuaDriverAtomicPublishError,
  preflightAtomicPublishDirectoryNoReplace,
  readAtomicPublishDirectoryIdentities,
  removeAtomicPublishDirectoryTree,
  removeAtomicPublishUnsecuredEmptyDirectory,
  securePrivateStagingDirectory,
  verifyPrivateStagingDirectorySecurity,
  withAtomicPublishParentLease,
} from "./cua-driver-package-atomic-publish.mjs";
import { verifyCuaDriverSourceBuildOutput } from "./cua-driver-package-staging-source.mjs";
import {
  assertExactDirectoryInventory,
  assertExactFileInventory,
  assertPreSignDigest,
  assertSourceBuildReceipt,
  assertSourceDirectoryInventory,
  assertSourceInventory,
  assertTrustedLockAnchor,
  validatePackageLock,
  validateProviderIdentity,
} from "./cua-driver-package-staging-validation.mjs";
import { PROVIDER_RESOURCE_ROOT } from "./cua-driver-source-build-lib.mjs";

export {
  CUA_DRIVER_COMMITTED_LOCK_SHA256,
  CUA_DRIVER_PACKAGE_DESTINATION,
  CUA_DRIVER_PACKAGE_REVISION,
  CuaDriverPackageStagingError,
  providerRelativePath,
  providerRootFor,
};

const JSON_MAX_BYTES = 256 * 1024;
const LICENSE_MAX_BYTES = 1024 * 1024;
const NOTICES_MAX_BYTES = 4 * 1024 * 1024;
const PROVIDER_MAX_BYTES = 128 * 1024 * 1024;
const STAGING_RESIDUE_MAX_COUNT = 4;
const STAGING_RESIDUE_MAX_ENTRIES = 64;
const STAGING_RESIDUE_PARENT_SCAN_MAX_ENTRIES = 1_024;
const STAGING_RESIDUE_MAX_TOTAL_BYTES = STAGING_RESIDUE_MAX_COUNT * (
  PROVIDER_MAX_BYTES + JSON_MAX_BYTES + LICENSE_MAX_BYTES + NOTICES_MAX_BYTES
);
const NOOP_STAGING_HOOKS = Object.freeze({
  afterAtomicPublishCommitConfirmed: async () => {},
  afterAtomicPublishBeforeVerify: async () => {},
  afterCleanupIdentityBeforeSecurity: async () => {},
  afterCleanupQuarantineVerifiedBeforeRemove: async () => {},
  afterCleanupRemoveFailureBeforeRollback: async () => {},
  afterNativePublisherPreflight: async () => {},
  afterTemporaryCreateBeforeIdentity: async () => {},
  afterTemporaryIdentityBeforeSecure: async () => {},
  beforeAtomicPublish: async () => {},
  beforeRetainedResidueObservation: async () => {},
});
const PRODUCTION_STAGING_TRUST = Object.freeze({
  expectedTrustedLockSha256: CUA_DRIVER_COMMITTED_LOCK_SHA256,
  sourceBuildVerifier: verifyCuaDriverSourceBuildOutput,
  trustedResourceRoot: PROVIDER_RESOURCE_ROOT,
});
const PRODUCTION_RESIDUE_LIMITS = Object.freeze({
  maxCount: STAGING_RESIDUE_MAX_COUNT,
  maxEntries: STAGING_RESIDUE_MAX_ENTRIES,
  maxTotalBytes: STAGING_RESIDUE_MAX_TOTAL_BYTES,
});

/**
 * Copy one verified clean source-build output into a private Electron Builder
 * pre-sign root. This API never accepts final tiers and never creates or
 * validates seals, catalogs, signatures or release evidence.
 */
export async function stageCuaDriverProvider(input) {
  assertNoProductionTrustOverrides(input);
  return stageCuaDriverProviderWithHooks(
    input,
    NOOP_STAGING_HOOKS,
    PRODUCTION_STAGING_TRUST,
    PRODUCTION_RESIDUE_LIMITS,
  );
}

/**
 * Test-only phase barriers for deterministic filesystem race coverage. They
 * cannot replace the verifier, trust anchor, filesystem or native publisher,
 * and are not reachable from the CLI or environment.
 */
export function createCuaDriverPackageStagerForTest(configuration) {
  const normalized = normalizeStagingTestConfiguration(configuration);
  const stage = async (input) => {
    assertNoProductionTrustOverrides(input);
    return stageCuaDriverProviderWithHooks(
      input,
      normalized.hooks,
      normalized.trust,
      normalized.residueLimits,
    );
  };
  Object.defineProperty(stage, "verifySourceInput", {
    enumerable: true,
    value: async (input) => {
      assertNoProductionTrustOverrides(input);
      return verifyCuaDriverSourceInputWithTrust(input, normalized.trust);
    },
  });
  Object.defineProperty(stage, "cleanupResidue", {
    enumerable: true,
    value: async (input) => cleanupCuaDriverStagingResidueWithHooks(
      input,
      normalized.hooks,
      normalized.residueLimits,
    ),
  });
  return Object.freeze(stage);
}

/** Safely remove one retained staging residue named by a prior failure receipt. */
export async function cleanupCuaDriverStagingResidue(input) {
  return cleanupCuaDriverStagingResidueWithHooks(
    input,
    NOOP_STAGING_HOOKS,
    PRODUCTION_RESIDUE_LIMITS,
  );
}

/** Discover identity-bound retained residues after an ungraceful build exit. */
export async function listCuaDriverStagingResidues(input) {
  const outputRoot = requireAbsoluteRoot(input?.outputRoot, "output_root_invalid");
  const publishRoot = await canonicalizeProspectivePath(outputRoot);
  const parentRoot = dirname(publishRoot);
  try {
    const parentMetadata = await lstat(parentRoot);
    if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()) {
      fail(
        "staging_output_parent_unsafe",
        "staging output parent must be a real directory",
        parentRoot,
      );
    }
  } catch (error) {
    if (error?.code === "ENOENT") {
      return Object.freeze({
        schemaVersion: 1,
        outputRoot: publishRoot,
        residues: Object.freeze([]),
        totalMatching: 0,
        truncated: false,
      });
    }
    throw error;
  }
  await preflightAtomicPublishDirectoryNoReplace();
  return withAtomicPublishParentLease(
    { parentRoot },
    (lease) => listCuaDriverStagingResiduesUnderLease({
      lease,
      publishRoot,
      residueLimits: PRODUCTION_RESIDUE_LIMITS,
    }),
  );
}

async function listCuaDriverStagingResiduesUnderLease({
  lease,
  publishRoot,
  residueLimits,
}) {
  lease.assertHeld();
  const parentRoot = dirname(publishRoot);
  const names = [];
  let scannedParentEntries = 0;
  const parentDirectory = await opendir(parentRoot);
  for await (const entry of parentDirectory) {
    lease.assertHeld();
    scannedParentEntries += 1;
    if (scannedParentEntries > STAGING_RESIDUE_PARENT_SCAN_MAX_ENTRIES) {
      fail(
        "staging_residue_scan_limit_exceeded",
        "staging output parent contains too many entries to scan safely",
        parentRoot,
      );
    }
    if (!isStagingResidueName(entry.name, publishRoot)) continue;
    const residuePath = resolve(parentRoot, entry.name);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      fail(
        "staging_residue_unsafe",
        "retained staging residue must be a real directory",
        residuePath,
      );
    }
    names.push(entry.name);
  }
  names.sort();
  const visibleNames = names.slice(0, residueLimits.maxCount);
  const residues = [];
  for (const name of visibleNames) {
    const residuePath = resolve(parentRoot, name);
    const identities = await readAtomicPublishDirectoryIdentities({
      parentRoot,
      sourceName: name,
    }, lease);
    lease.assertHeld();
    if (identities.parentIdentity !== lease.parentIdentity) {
      fail(
        "staging_parent_lock_identity_mismatch",
        "retained residue parent does not match the held staging lease",
        parentRoot,
      );
    }
    const inventory = await measureResidueTree(residuePath, residueLimits);
    lease.assertHeld();
    let securityState = "private";
    let securityErrorCode;
    try {
      await verifyPrivateStagingDirectorySecurity({
        directoryName: name,
        expectedDirectoryIdentity: identities.sourceIdentity,
        expectedParentIdentity: identities.parentIdentity,
        parentRoot,
      }, lease);
      lease.assertHeld();
    } catch (error) {
      if (isParentLeaseFailure(error)) throw error;
      const afterFailure = await readAtomicPublishDirectoryIdentities({
        parentRoot,
        sourceName: name,
      }, lease);
      lease.assertHeld();
      if (afterFailure.parentIdentity !== identities.parentIdentity
        || afterFailure.sourceIdentity !== identities.sourceIdentity) {
        fail(
          "staging_residue_identity_mismatch",
          "retained residue changed identity during security inspection",
          residuePath,
        );
      }
      securityState = "unsecured";
      securityErrorCode = typeof error?.code === "string"
        ? error.code.slice(0, 128)
        : "staging_private_directory_invalid";
    }
    residues.push(Object.freeze({
      entries: inventory.entries,
      residueIdentity: identities.sourceIdentity,
      residuePath,
      securityState,
      totalBytes: inventory.totalBytes,
      type: name.includes(".cleanup-") ? "cleanup" : "temporary",
      ...(securityErrorCode === undefined ? {} : { securityErrorCode }),
    }));
  }
  return Object.freeze({
    schemaVersion: 1,
    outputRoot: publishRoot,
    residues: Object.freeze(residues),
    totalMatching: names.length,
    truncated: names.length > visibleNames.length,
  });
}

async function cleanupCuaDriverStagingResidueWithHooks(
  input,
  hooks,
  residueLimits,
) {
  const outputRoot = requireAbsoluteRoot(input?.outputRoot, "output_root_invalid");
  const residuePath = requireAbsoluteRoot(
    input?.residuePath,
    "staging_residue_path_invalid",
  );
  const expectedResidueIdentity = requireResidueIdentity(
    input?.expectedResidueIdentity,
  );
  const publishRoot = await canonicalizeProspectivePath(outputRoot);
  assertResiduePathForOutput(residuePath, publishRoot);
  await preflightAtomicPublishDirectoryNoReplace();
  return withAtomicPublishParentLease(
    { parentRoot: dirname(residuePath) },
    (lease) => cleanupCuaDriverStagingResidueUnderLease({
      expectedResidueIdentity,
      hooks,
      lease,
      outputRoot,
      publishRoot,
      residueLimits,
      residuePath,
    }),
  );
}

async function cleanupCuaDriverStagingResidueUnderLease({
  expectedResidueIdentity,
  hooks,
  lease,
  outputRoot,
  publishRoot,
  residueLimits,
  residuePath,
}) {
  lease.assertHeld();
  const beforeIdentity = await readAtomicPublishDirectoryIdentities({
    parentRoot: dirname(residuePath),
    sourceName: basename(residuePath),
  }, lease);
  lease.assertHeld();
  if (beforeIdentity.parentIdentity !== lease.parentIdentity) {
    fail(
      "staging_parent_lock_identity_mismatch",
      "retained residue parent does not match the held staging lease",
      dirname(residuePath),
    );
  }
  if (beforeIdentity.sourceIdentity !== expectedResidueIdentity) {
    fail(
      "staging_residue_identity_mismatch",
      "retained residue no longer matches its cleanup receipt",
      residuePath,
    );
  }
  await lease.guard(() => hooks.afterCleanupIdentityBeforeSecurity(Object.freeze({
    expectedParentIdentity: beforeIdentity.parentIdentity,
    expectedResidueIdentity,
    outputRoot,
    parentLeaseHelperPid: lease.helperPid,
    parentLeaseSignal: lease.signal,
    publishRoot,
    residuePath,
  })));
  const securityRecovery = await prepareResidueSecurityForCleanup({
    expectedParentIdentity: beforeIdentity.parentIdentity,
    expectedResidueIdentity,
    lease,
    residuePath,
  });
  lease.assertHeld();
  if (securityRecovery.outcome === "removed") {
    return Object.freeze({
      schemaVersion: 1,
      outcome: "removed",
      residueIdentity: expectedResidueIdentity,
      residuePath,
      totalBytes: 0,
    });
  }
  const beforeInventory = await measureResidueTree(
    residuePath,
    residueLimits,
  );
  lease.assertHeld();
  const residueName = basename(residuePath);
  const quarantineName = `${basename(publishRoot)}.cleanup-${randomUUID()}`;
  const quarantinePath = resolve(dirname(residuePath), quarantineName);
  try {
    await lease.guard(() => atomicPublishDirectoryNoReplace({
      destinationName: quarantineName,
      expectedParentIdentity: beforeIdentity.parentIdentity,
      expectedSourceIdentity: expectedResidueIdentity,
      parentRoot: dirname(residuePath),
      sourceName: basename(residuePath),
    }, lease));
    lease.assertHeld();
  } catch (error) {
    if (isParentLeaseFailure(error)) throw error;
    if (!(error instanceof CuaDriverAtomicPublishError)) {
      throw error;
    }
    const recovery = await recoverFailedQuarantineCommit({
      expectedParentIdentity: beforeIdentity.parentIdentity,
      expectedResidueIdentity,
      quarantineName,
      quarantinePath,
      lease,
      residueLimits,
      residueName,
      residuePath,
    });
    lease.assertHeld();
    throw cleanupFailureAfterRecovery({ cause: error, recovery });
  }
  const cleanupContext = Object.freeze({
    expectedParentIdentity: beforeIdentity.parentIdentity,
    expectedResidueIdentity,
    outputRoot,
    parentLeaseHelperPid: lease.helperPid,
    parentLeaseSignal: lease.signal,
    publishRoot,
    quarantinePath,
    residuePath,
  });
  try {
    const quarantinedIdentity = await readAtomicPublishDirectoryIdentities({
      parentRoot: dirname(quarantinePath),
      sourceName: basename(quarantinePath),
    }, lease);
    lease.assertHeld();
    if (quarantinedIdentity.sourceIdentity !== expectedResidueIdentity) {
      fail(
        "staging_residue_identity_mismatch",
        "quarantined residue changed identity before cleanup",
        quarantinePath,
      );
    }
    const quarantinedInventory = await measureResidueTree(
      quarantinePath,
      residueLimits,
    );
    lease.assertHeld();
    if (JSON.stringify(quarantinedInventory) !== JSON.stringify(beforeInventory)) {
      fail(
        "staging_residue_changed_during_cleanup",
        "retained residue changed while entering cleanup quarantine",
        quarantinePath,
      );
    }
    await lease.guard(
      () => hooks.afterCleanupQuarantineVerifiedBeforeRemove(cleanupContext),
    );
    await lease.guard(() => removeAtomicPublishDirectoryTree({
      parentRoot: dirname(quarantinePath),
      sourceName: quarantineName,
      expectedParentIdentity: beforeIdentity.parentIdentity,
      expectedSourceIdentity: expectedResidueIdentity,
      expectedEntries: quarantinedInventory.entries,
      expectedTotalBytes: quarantinedInventory.totalBytes,
    }, lease));
    lease.assertHeld();
  } catch (error) {
    if (isParentLeaseFailure(error)) throw error;
    let rollbackBarrierError;
    try {
      await lease.guard(
        () => hooks.afterCleanupRemoveFailureBeforeRollback(cleanupContext),
      );
    } catch (hookError) {
      if (isParentLeaseFailure(hookError)) throw hookError;
      rollbackBarrierError = hookError;
    }
    const recovery = await rollbackQuarantinedResidue({
      expectedParentIdentity: beforeIdentity.parentIdentity,
      expectedResidueIdentity,
      quarantineName,
      quarantinePath,
      lease,
      residueLimits,
      residueName,
      residuePath,
    });
    lease.assertHeld();
    throw cleanupFailureAfterRecovery({
      cause: error,
      recovery,
      rollbackBarrierError,
    });
  }
  return Object.freeze({
    schemaVersion: 1,
    outcome: "removed",
    residueIdentity: expectedResidueIdentity,
    residuePath,
    totalBytes: beforeInventory.totalBytes,
  });
}

function isParentLeaseFailure(error) {
  return typeof error?.code === "string"
    && error.code.startsWith("staging_parent_lock_");
}

async function prepareResidueSecurityForCleanup({
  expectedParentIdentity,
  expectedResidueIdentity,
  lease,
  residuePath,
}) {
  const securityInput = Object.freeze({
    directoryName: basename(residuePath),
    expectedDirectoryIdentity: expectedResidueIdentity,
    expectedParentIdentity,
    parentRoot: dirname(residuePath),
  });
  try {
    await lease.guard(() => verifyPrivateStagingDirectorySecurity(securityInput, lease));
    return Object.freeze({ outcome: "private" });
  } catch (verificationError) {
    if (isParentLeaseFailure(verificationError)) throw verificationError;
    try {
      await lease.guard(() => securePrivateStagingDirectory(securityInput, lease));
      return Object.freeze({ outcome: "private" });
    } catch (securityError) {
      if (isParentLeaseFailure(securityError)) throw securityError;
      try {
        await lease.guard(() => removeAtomicPublishUnsecuredEmptyDirectory({
          expectedParentIdentity,
          expectedSourceIdentity: expectedResidueIdentity,
          parentRoot: dirname(residuePath),
          sourceName: basename(residuePath),
        }, lease));
        return Object.freeze({ outcome: "removed" });
      } catch (removalError) {
        if (isParentLeaseFailure(removalError)) throw removalError;
        attachSecurityRecoveryDiagnostics(
          removalError,
          verificationError,
          securityError,
        );
        throw removalError;
      }
    }
  }
}

function attachSecurityRecoveryDiagnostics(
  removalError,
  verificationError,
  securityError,
) {
  if (!(removalError instanceof Error) || !Object.isExtensible(removalError)) {
    return;
  }
  for (const [key, value] of [
    ["privateSecurityVerificationError", verificationError],
    ["privateSecurityRecoveryError", securityError],
  ]) {
    try {
      Object.defineProperty(removalError, key, {
        configurable: true,
        enumerable: false,
        value,
        writable: false,
      });
    } catch {
      // Preserve the native removal classification when diagnostics are locked.
    }
  }
}

async function stageCuaDriverProviderWithHooks(input, hooks, trust, residueLimits) {
  const platform = normalizePackagePlatform(input?.platform);
  const sourceRoot = requireAbsoluteRoot(input?.sourceRoot, "source_root_invalid");
  const outputRoot = requireAbsoluteRoot(input?.outputRoot, "output_root_invalid");

  assertDisjointRoots(sourceRoot, outputRoot);
  const canonicalRoots = await assertCanonicalDisjointRoots(sourceRoot, outputRoot);
  const publishRoot = canonicalRoots.outputCanonical;
  await assertPathAbsent(outputRoot, "output_root_exists");
  await assertPathAbsent(publishRoot, "output_root_exists");
  const source = await inspectCuaDriverSourceInput({
    platform,
    sourceBuildVerifier: trust.sourceBuildVerifier,
    sourceRoot,
    trustedResourceRoot: trust.trustedResourceRoot,
    expectedTrustedLockSha256: trust.expectedTrustedLockSha256,
  });

  const temporaryRoot = `${publishRoot}.tmp-${process.pid}-${randomUUID()}`;
  await assertPathAbsent(temporaryRoot, "temporary_root_exists");
  await mkdir(dirname(publishRoot), { recursive: true });
  const outputCanonicalAfterMkdir = await canonicalizeProspectivePath(outputRoot);
  if (canonicalPathKey(outputCanonicalAfterMkdir)
    !== canonicalPathKey(canonicalRoots.outputCanonical)) {
    fail(
      "staging_output_parent_changed",
      "output root changed canonical location during staging",
      outputRoot,
    );
  }
  await preflightAtomicPublishDirectoryNoReplace();
  await hooks.afterNativePublisherPreflight(Object.freeze({
    outputRoot,
    publishRoot,
    temporaryRoot,
  }));
  let nativeCommitConfirmed = false;
  try {
    return await withAtomicPublishParentLease(
      { parentRoot: dirname(publishRoot) },
      (lease) => stageCuaDriverProviderUnderLease({
        canonicalRoots,
        confirmNativeCommit: () => {
          nativeCommitConfirmed = true;
        },
        hooks,
        lease,
        outputRoot,
        platform,
        publishRoot,
        residueLimits,
        source,
        temporaryRoot,
      }),
    );
  } catch (error) {
    if (nativeCommitConfirmed && error?.published !== true) {
      throw publishedStageVerificationError(error, publishRoot);
    }
    throw error;
  }
}

async function stageCuaDriverProviderUnderLease({
  canonicalRoots,
  confirmNativeCommit,
  hooks,
  lease,
  outputRoot,
  platform,
  publishRoot,
  residueLimits,
  source,
  temporaryRoot,
}) {
  lease.assertHeld();
  await assertPathAbsent(outputRoot, "output_root_exists");
  await assertPathAbsent(publishRoot, "output_root_exists");
  await assertStagingResidueBudget({
    incomingBytes: packageSnapshotBytes(source.packageSnapshots, platform),
    incomingEntries: packageSnapshotEntries(platform),
    publishRoot,
    residueLimits,
  });
  lease.assertHeld();
  let temporaryCreated = false;
  let temporaryIdentity;
  let nativePublishIdentities;
  let published = false;
  try {
    await lease.guard(() => mkdir(temporaryRoot, { mode: 0o700 }));
    lease.assertHeld();
    temporaryCreated = true;
    await lease.guard(() => hooks.afterTemporaryCreateBeforeIdentity(Object.freeze({
      outputRoot,
      parentLeaseHelperPid: lease.helperPid,
      parentLeaseSignal: lease.signal,
      publishRoot,
      temporaryRoot,
    })));
    lease.assertHeld();
    const createdDirectory = await readAtomicPublishDirectoryIdentities({
      parentRoot: dirname(temporaryRoot),
      sourceName: basename(temporaryRoot),
    }, lease);
    lease.assertHeld();
    if (createdDirectory.parentIdentity !== lease.parentIdentity) {
      fail(
        "staging_parent_lock_identity_mismatch",
        "temporary staging parent does not match the held staging lease",
        dirname(temporaryRoot),
      );
    }
    nativePublishIdentities = Object.freeze({
      parentIdentity: createdDirectory.parentIdentity,
      sourceIdentity: createdDirectory.sourceIdentity,
    });
    temporaryIdentity = await readStagingDirectoryIdentity(temporaryRoot);
    lease.assertHeld();
    await lease.guard(() => hooks.afterTemporaryIdentityBeforeSecure(Object.freeze({
      outputRoot,
      parentLeaseHelperPid: lease.helperPid,
      parentLeaseSignal: lease.signal,
      publishRoot,
      temporaryRoot,
      temporaryIdentity: nativePublishIdentities.sourceIdentity,
    })));
    const privateDirectory = await lease.guard(() => securePrivateStagingDirectory({
      directoryName: basename(temporaryRoot),
      expectedDirectoryIdentity: nativePublishIdentities.sourceIdentity,
      expectedParentIdentity: nativePublishIdentities.parentIdentity,
      parentRoot: dirname(temporaryRoot),
    }, lease));
    lease.assertHeld();
    if (privateDirectory.parentIdentity !== nativePublishIdentities.parentIdentity
      || privateDirectory.directoryIdentity !== nativePublishIdentities.sourceIdentity) {
      fail(
        "staging_private_directory_identity_changed",
        "staging directory changed identity while applying private security",
        temporaryRoot,
      );
    }
    await assertStagingDestinationStable({
      outputCanonical: canonicalRoots.outputCanonical,
      outputRoot,
      temporaryRoot,
    });
    lease.assertHeld();
    const providerRoot = providerRootFor(temporaryRoot);
    for (const relativePath of preSignProviderFiles(platform)) {
      const snapshot = source.packageSnapshots[relativePath];
      const destinationPath = resolveRelative(providerRoot, relativePath);
      await lease.guard(() => mkdir(dirname(destinationPath), { recursive: true }));
      await lease.guard(() => writeFile(destinationPath, snapshot.bytes, {
        flag: "wx",
        mode: snapshot.mode & 0o777,
        signal: lease.signal,
      }));
    }
    const staged = await verifyCuaDriverPreSignStage({
      resourcesRoot: temporaryRoot,
      platform,
    });
    lease.assertHeld();
    assertStageMatchesSource(staged, source, temporaryRoot);
    await verifyPrivateStagingDirectorySecurity({
      directoryName: basename(temporaryRoot),
      expectedDirectoryIdentity: nativePublishIdentities.sourceIdentity,
      expectedParentIdentity: nativePublishIdentities.parentIdentity,
      parentRoot: dirname(temporaryRoot),
    }, lease);
    lease.assertHeld();
    await assertStagingDestinationStable({
      outputCanonical: canonicalRoots.outputCanonical,
      outputRoot,
      temporaryRoot,
    });
    lease.assertHeld();
    await assertPathAbsent(outputRoot, "output_root_exists");
    await assertPathAbsent(publishRoot, "output_root_exists");
    const verifiedTemporaryIdentity = await readStagingDirectoryIdentity(temporaryRoot);
    lease.assertHeld();
    if (!sameFileIdentity(verifiedTemporaryIdentity, temporaryIdentity)) {
      fail(
        "staging_publish_identity_changed",
        "verified staging directory was replaced before publication",
        temporaryRoot,
      );
    }
    await lease.guard(() => hooks.beforeAtomicPublish(Object.freeze({
      outputRoot,
      parentLeaseHelperPid: lease.helperPid,
      parentLeaseSignal: lease.signal,
      publishRoot,
      temporaryRoot,
    })));
    try {
      await lease.guard(async () => {
        const commitReceipt = await atomicPublishDirectoryNoReplace({
          destinationName: basename(publishRoot),
          expectedParentIdentity: nativePublishIdentities.parentIdentity,
          expectedSourceIdentity: nativePublishIdentities.sourceIdentity,
          parentRoot: dirname(publishRoot),
          sourceName: basename(temporaryRoot),
        }, lease);
        confirmNativeCommit();
        temporaryCreated = false;
        published = true;
        await hooks.afterAtomicPublishCommitConfirmed(Object.freeze({
          commitReceipt,
          outputRoot,
          parentLeaseHelperPid: lease.helperPid,
          parentLeaseSignal: lease.signal,
          publishRoot,
          temporaryRoot,
        }));
      });
      lease.assertHeld();
    } catch (error) {
      rethrowAtomicPublishError(error, publishRoot);
    }
    await lease.guard(() => hooks.afterAtomicPublishBeforeVerify(Object.freeze({
      outputRoot,
      parentLeaseHelperPid: lease.helperPid,
      parentLeaseSignal: lease.signal,
      publishRoot,
      temporaryRoot,
    })));
    await assertPublishedStageIdentity(publishRoot, temporaryIdentity);
    lease.assertHeld();
    await verifyPrivateStagingDirectorySecurity({
      directoryName: basename(publishRoot),
      expectedDirectoryIdentity: nativePublishIdentities.sourceIdentity,
      expectedParentIdentity: nativePublishIdentities.parentIdentity,
      parentRoot: dirname(publishRoot),
    }, lease);
    lease.assertHeld();
    const publishedStage = await verifyCuaDriverPreSignStage({
      resourcesRoot: publishRoot,
      platform,
    });
    lease.assertHeld();
    assertStageMatchesSource(publishedStage, source, publishRoot);
    return Object.freeze({
      ...publishedStage,
      electronBuilderExtraResource: Object.freeze({
        from: publishedStage.providerRoot,
        to: CUA_DRIVER_PACKAGE_DESTINATION,
      }),
    });
  } catch (error) {
    if (published) {
      throw publishedStageVerificationError(error, publishRoot);
    }
    if (isParentLeaseFailure(error)) {
      const cleanup = retainedResidueAfterParentLeaseLoss({
        expectedResidueIdentity: nativePublishIdentities?.sourceIdentity,
        temporaryCreated,
        temporaryRoot,
      });
      throw attachCleanupMetadata(error, cleanup, temporaryRoot);
    }
    await hooks.beforeRetainedResidueObservation(Object.freeze({
      originalError: error,
      parentLeaseHelperPid: lease.helperPid,
      parentLeaseSignal: lease.signal,
      publishRoot,
      temporaryRoot,
    }));
    let cleanup;
    try {
      cleanup = await observeRetainedTemporaryStage({
        expectedResidueIdentity: nativePublishIdentities?.sourceIdentity,
        publishRoot,
        lease,
        residueLimits,
        temporaryCreated,
        temporaryRoot,
      });
      lease.assertHeld();
    } catch (observationError) {
      if (isParentLeaseFailure(observationError)) {
        const retained = retainedResidueAfterParentLeaseLoss({
          expectedResidueIdentity: nativePublishIdentities?.sourceIdentity,
          temporaryCreated,
          temporaryRoot,
        });
        throw attachCleanupMetadata(observationError, retained, temporaryRoot);
      }
      throw observationError;
    }
    throw attachCleanupMetadata(error, cleanup, temporaryRoot);
  }
}

function normalizeStagingTestConfiguration(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("staging_test_configuration_invalid", "test configuration must be an object");
  }
  const allowed = new Set([
    "afterAtomicPublishCommitConfirmed",
    "afterAtomicPublishBeforeVerify",
    "afterCleanupIdentityBeforeSecurity",
    "afterCleanupQuarantineVerifiedBeforeRemove",
    "afterCleanupRemoveFailureBeforeRollback",
    "afterNativePublisherPreflight",
    "afterTemporaryCreateBeforeIdentity",
    "afterTemporaryIdentityBeforeSecure",
    "beforeAtomicPublish",
    "beforeRetainedResidueObservation",
    "residueLimits",
    "sourceBuildVerifier",
    "trustedResourceRoot",
  ]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      fail("staging_test_configuration_invalid", `invalid test configuration: ${key}`);
    }
  }
  if (typeof value.sourceBuildVerifier !== "function") {
    fail(
      "staging_test_configuration_invalid",
      "test sourceBuildVerifier must be callable",
    );
  }
  const trustedResourceRoot = requireAbsoluteRoot(
    value.trustedResourceRoot,
    "staging_test_configuration_invalid",
  );
  const hooks = {};
  for (const key of [
    "afterAtomicPublishCommitConfirmed",
    "afterAtomicPublishBeforeVerify",
    "afterCleanupIdentityBeforeSecurity",
    "afterCleanupQuarantineVerifiedBeforeRemove",
    "afterCleanupRemoveFailureBeforeRollback",
    "afterNativePublisherPreflight",
    "afterTemporaryCreateBeforeIdentity",
    "afterTemporaryIdentityBeforeSecure",
    "beforeAtomicPublish",
    "beforeRetainedResidueObservation",
  ]) {
    if (value[key] !== undefined && typeof value[key] !== "function") {
      fail("staging_test_configuration_invalid", `invalid test hook: ${key}`);
    }
    hooks[key] = value[key] ?? NOOP_STAGING_HOOKS[key];
  }
  return Object.freeze({
    hooks: Object.freeze(hooks),
    residueLimits: normalizeTestResidueLimits(value.residueLimits),
    trust: Object.freeze({
      expectedTrustedLockSha256: undefined,
      sourceBuildVerifier: value.sourceBuildVerifier,
      trustedResourceRoot,
    }),
  });
}

function normalizeTestResidueLimits(value) {
  if (value === undefined) {
    return PRODUCTION_RESIDUE_LIMITS;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("staging_test_configuration_invalid", "residueLimits must be an object");
  }
  const result = {};
  for (const [key, productionMaximum] of [
    ["maxCount", STAGING_RESIDUE_MAX_COUNT],
    ["maxEntries", STAGING_RESIDUE_MAX_ENTRIES],
    ["maxTotalBytes", STAGING_RESIDUE_MAX_TOTAL_BYTES],
  ]) {
    const candidate = value[key] ?? productionMaximum;
    if (!Number.isSafeInteger(candidate)
      || candidate < 1
      || candidate > productionMaximum) {
      fail(
        "staging_test_configuration_invalid",
        `residueLimits.${key} must be a positive bounded integer`,
      );
    }
    result[key] = candidate;
  }
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(result, key)) {
      fail("staging_test_configuration_invalid", `invalid residue limit: ${key}`);
    }
  }
  return Object.freeze(result);
}

function packageSnapshotBytes(packageSnapshots, platform) {
  return preSignProviderFiles(platform).reduce(
    (total, relativePath) => total + packageSnapshots[relativePath].size,
    0,
  );
}

function packageSnapshotEntries(platform) {
  const entries = new Set();
  for (const relativePath of preSignProviderFiles(platform)) {
    const parts = `${CUA_DRIVER_PACKAGE_DESTINATION}/${relativePath}`.split("/");
    for (let length = 1; length <= parts.length; length += 1) {
      entries.add(parts.slice(0, length).join("/"));
    }
  }
  return entries.size;
}

async function assertStagingResidueBudget({
  incomingBytes,
  incomingEntries,
  publishRoot,
  residueLimits,
}) {
  const residues = await inspectStagingResidues(publishRoot, residueLimits);
  if (residues.count >= residueLimits.maxCount
    || residues.totalEntries + incomingEntries > residueLimits.maxEntries
    || residues.totalBytes + incomingBytes > residueLimits.maxTotalBytes) {
    fail(
      "staging_residue_quota_exceeded",
      "retained staging residue count, entry or total-byte quota is exhausted",
      dirname(publishRoot),
    );
  }
}

async function inspectStagingResidues(publishRoot, residueLimits) {
  const parentRoot = dirname(publishRoot);
  let count = 0;
  let scannedParentEntries = 0;
  let totalBytes = 0;
  let totalEntries = 0;
  const parentDirectory = await opendir(parentRoot);
  for await (const entry of parentDirectory) {
    scannedParentEntries += 1;
    if (scannedParentEntries > STAGING_RESIDUE_PARENT_SCAN_MAX_ENTRIES) {
      fail(
        "staging_residue_scan_limit_exceeded",
        "staging output parent contains too many entries to scan safely",
        parentRoot,
      );
    }
    if (!isStagingResidueName(entry.name, publishRoot)) {
      continue;
    }
    const residuePath = resolve(parentRoot, entry.name);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      fail(
        "staging_residue_unsafe",
        "retained staging residue must be a real directory",
        residuePath,
      );
    }
    count += 1;
    if (count > residueLimits.maxCount) {
      fail(
        "staging_residue_quota_exceeded",
        "retained staging residue count quota is exceeded",
        parentRoot,
      );
    }
    const measured = await measureResidueTree(residuePath, residueLimits);
    totalBytes += measured.totalBytes;
    totalEntries += measured.entries;
    if (totalBytes > residueLimits.maxTotalBytes
      || totalEntries > residueLimits.maxEntries) {
      fail(
        "staging_residue_quota_exceeded",
        "retained staging residue entry or total-byte quota is exceeded",
        parentRoot,
      );
    }
  }
  return Object.freeze({ count, totalBytes, totalEntries });
}

async function measureResidueTree(root, residueLimits) {
  let entries = 0;
  let totalBytes = 0;
  async function visit(directory) {
    const handle = await opendir(directory);
    for await (const entry of handle) {
      entries += 1;
      if (entries > residueLimits.maxEntries) {
        fail(
          "staging_residue_quota_exceeded",
          "retained staging residue entry quota is exceeded",
          root,
        );
      }
      const path = resolve(directory, entry.name);
      const metadata = await lstat(path, { bigint: true });
      if (entry.isSymbolicLink() || metadata.isSymbolicLink()) {
        fail(
          "staging_residue_unsafe",
          "retained staging residue contains a reparse entry",
          path,
        );
      }
      if (entry.isDirectory() && metadata.isDirectory()) {
        await visit(path);
        continue;
      }
      if (!entry.isFile() || !metadata.isFile() || metadata.nlink !== 1n) {
        fail(
          "staging_residue_unsafe",
          "retained staging residue contains a non-regular or hard-linked entry",
          path,
        );
      }
      if (metadata.size > BigInt(Number.MAX_SAFE_INTEGER)) {
        fail(
          "staging_residue_quota_exceeded",
          "retained staging residue file is too large to measure safely",
          path,
        );
      }
      totalBytes += Number(metadata.size);
      if (totalBytes > residueLimits.maxTotalBytes) {
        fail(
          "staging_residue_quota_exceeded",
          "retained staging residue total-byte quota is exceeded",
          root,
        );
      }
    }
  }
  await visit(root);
  return Object.freeze({ entries, totalBytes });
}

function isStagingResidueName(name, publishRoot) {
  const temporaryPrefix = `${basename(publishRoot)}.tmp-`;
  if (name.startsWith(temporaryPrefix)) {
    return /^\d+-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
      .test(name.slice(temporaryPrefix.length));
  }
  const cleanupPrefix = `${basename(publishRoot)}.cleanup-`;
  return name.startsWith(cleanupPrefix)
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
      .test(name.slice(cleanupPrefix.length));
}

function assertResiduePathForOutput(residuePath, publishRoot) {
  if (canonicalPathKey(dirname(residuePath)) !== canonicalPathKey(dirname(publishRoot))
    || !isStagingResidueName(basename(residuePath), publishRoot)) {
    fail(
      "staging_residue_path_invalid",
      "residuePath must name an exact retained sibling for outputRoot",
      residuePath,
    );
  }
}

function requireResidueIdentity(value) {
  if (typeof value !== "string"
    || value.length === 0
    || value.length > 128
    || !/^[0-9a-f]+:[0-9a-f]+$/u.test(value)) {
    fail(
      "staging_residue_identity_invalid",
      "expectedResidueIdentity must be a native directory identity receipt",
    );
  }
  return value;
}

async function rollbackQuarantinedResidue({
  expectedParentIdentity,
  expectedResidueIdentity,
  quarantineName,
  quarantinePath,
  lease,
  residueLimits,
  residueName,
  residuePath,
}) {
  const beforeRollback = await observeIdentityBoundResidue({
    expectedParentIdentity,
    expectedResidueIdentity,
    lease,
    path: quarantinePath,
    residueLimits,
  });
  if (!beforeRollback.identityMatches) {
    return Object.freeze({
      ...beforeRollback,
      outcome: "unrecoverable",
      reason: beforeRollback.reason ?? "quarantine_identity_unavailable",
    });
  }
  try {
    await lease.guard(() => atomicPublishDirectoryNoReplace({
      destinationName: residueName,
      expectedParentIdentity,
      expectedSourceIdentity: expectedResidueIdentity,
      parentRoot: dirname(quarantinePath),
      sourceName: quarantineName,
    }, lease));
  } catch (error) {
    if (isParentLeaseFailure(error)) throw error;
    const retained = await observeIdentityBoundResidue({
      expectedParentIdentity,
      expectedResidueIdentity,
      lease,
      path: quarantinePath,
      residueLimits,
    });
    return Object.freeze({
      ...retained,
      outcome: retained.identityMatches ? "retained" : "unrecoverable",
      reason: retained.identityMatches
        ? `quarantine_retained_${String(error?.nativeReason ?? "rollback_failed")}`
        : retained.reason ?? "quarantine_rollback_ambiguous",
      rollbackError: boundedErrorDetail(error),
    });
  }
  const restored = await observeIdentityBoundResidue({
    expectedParentIdentity,
    expectedResidueIdentity,
    lease,
    path: residuePath,
    residueLimits,
  });
  if (!restored.identityMatches) {
    return Object.freeze({
      ...restored,
      outcome: "unrecoverable",
      reason: restored.reason ?? "restored_residue_identity_unavailable",
    });
  }
  return Object.freeze({
    ...restored,
    outcome: "restored",
    reason: "cleanup_failed_residue_restored",
  });
}

async function recoverFailedQuarantineCommit({
  expectedParentIdentity,
  expectedResidueIdentity,
  quarantineName,
  quarantinePath,
  lease,
  residueLimits,
  residueName,
  residuePath,
}) {
  const original = await observeIdentityBoundResidue({
    expectedParentIdentity,
    expectedResidueIdentity,
    lease,
    path: residuePath,
    residueLimits,
  });
  if (original.identityMatches) {
    return Object.freeze({
      ...original,
      outcome: "retained",
      reason: "cleanup_quarantine_not_committed",
    });
  }
  const quarantine = await observeIdentityBoundResidue({
    expectedParentIdentity,
    expectedResidueIdentity,
    lease,
    path: quarantinePath,
    residueLimits,
  });
  if (!quarantine.identityMatches) {
    return Object.freeze({
      ...quarantine,
      outcome: "unrecoverable",
      reason: "cleanup_quarantine_commit_ambiguous",
    });
  }
  return rollbackQuarantinedResidue({
    expectedParentIdentity,
    expectedResidueIdentity,
    quarantineName,
    quarantinePath,
    lease,
    residueLimits,
    residueName,
    residuePath,
  });
}

async function observeIdentityBoundResidue({
  expectedParentIdentity,
  expectedResidueIdentity,
  lease,
  path,
  residueLimits,
}) {
  let identities;
  try {
    identities = await lease.guard(() => readAtomicPublishDirectoryIdentities({
      parentRoot: dirname(path),
      sourceName: basename(path),
    }, lease));
  } catch (error) {
    if (isParentLeaseFailure(error)) throw error;
    return Object.freeze({
      identityMatches: false,
      reason: "residue_identity_unavailable",
      residuePath: path,
      detail: boundedErrorDetail(error),
    });
  }
  if (identities.parentIdentity !== expectedParentIdentity
    || identities.sourceIdentity !== expectedResidueIdentity) {
    return Object.freeze({
      identityMatches: false,
      reason: "residue_identity_mismatch",
      residuePath: path,
    });
  }
  let measured;
  let detail;
  try {
    measured = await lease.guard(() => measureResidueTree(path, residueLimits));
  } catch (error) {
    if (isParentLeaseFailure(error)) throw error;
    detail = boundedErrorDetail(error);
  }
  return Object.freeze({
    identityMatches: true,
    residueIdentity: expectedResidueIdentity,
    residuePath: path,
    ...(measured
      ? {
          residueBytes: measured.totalBytes,
          residueEntries: measured.entries,
        }
      : {}),
    ...(detail ? { detail } : {}),
  });
}

function cleanupFailureAfterRecovery({
  cause,
  recovery,
  rollbackBarrierError,
}) {
  const ambiguous = cause?.outcome === "ambiguous"
    || recovery.outcome === "unrecoverable"
    || rollbackBarrierError !== undefined;
  const code = ambiguous
    ? "staging_residue_cleanup_ambiguous"
    : "staging_residue_cleanup_failed";
  const path = recovery.residuePath ?? cause?.path;
  const wrapped = new CuaDriverPackageStagingError(
    code,
    errorMessageWithoutCode(cause),
    path,
  );
  wrapped.cause = cause;
  wrapped.outcome = ambiguous ? "ambiguous" : "not_committed";
  if (cause?.nativeReason !== undefined) {
    wrapped.nativeReason = cause.nativeReason;
  }
  if (cause?.nativeCode !== undefined) {
    wrapped.nativeCode = cause.nativeCode;
  }
  if (rollbackBarrierError !== undefined) {
    wrapped.rollbackBarrierError = rollbackBarrierError;
  }
  wrapped.cleanup = freezeCleanupMetadata({
    outcome: "residue",
    reason: recovery.reason,
    nativeCode: Number.isSafeInteger(cause?.nativeCode) ? cause.nativeCode : 0,
    residuePath: recovery.residuePath,
    residueIdentity: recovery.residueIdentity,
    residueEntries: recovery.residueEntries,
    residueBytes: recovery.residueBytes,
    detail: [recovery.detail, recovery.rollbackError].filter(Boolean).join("; "),
  });
  return wrapped;
}

function rethrowAtomicPublishError(error, publishRoot) {
  if (!(error instanceof CuaDriverAtomicPublishError)) {
    throw error;
  }
  const wrapped = new CuaDriverPackageStagingError(
    error.code,
    errorMessageWithoutCode(error),
    publishRoot,
  );
  wrapped.cause = error;
  wrapped.outcome = error.outcome;
  wrapped.nativeReason = error.nativeReason;
  wrapped.nativeCode = error.nativeCode;
  throw wrapped;
}

async function observeRetainedTemporaryStage({
  expectedResidueIdentity,
  lease,
  publishRoot,
  residueLimits,
  temporaryCreated,
  temporaryRoot,
}) {
  if (!temporaryCreated) {
    return Object.freeze({
      outcome: "residue",
      reason: "temporary_stage_not_created",
      nativeCode: 0,
    });
  }
  try {
    await lstat(temporaryRoot);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return Object.freeze({
        outcome: "residue",
        reason: "temporary_stage_not_observed",
        nativeCode: 0,
      });
    }
    return Object.freeze({
      outcome: "residue",
      reason: "residue_observation_failed",
      nativeCode: 0,
      residuePath: temporaryRoot,
      detail: boundedErrorDetail(error),
    });
  }
  if (typeof expectedResidueIdentity !== "string") {
    return Object.freeze({
      outcome: "residue",
      reason: "residue_identity_unavailable",
      nativeCode: 0,
      residuePath: temporaryRoot,
    });
  }
  try {
    const identity = await readAtomicPublishDirectoryIdentities({
      parentRoot: dirname(temporaryRoot),
      sourceName: basename(temporaryRoot),
    }, lease);
    if (identity.sourceIdentity !== expectedResidueIdentity) {
      return Object.freeze({
        outcome: "residue",
        reason: "retained_identity_mismatch",
        nativeCode: 0,
        residueIdentity: expectedResidueIdentity,
        residuePath: temporaryRoot,
      });
    }
    const measured = await measureResidueTree(temporaryRoot, residueLimits);
    const aggregate = await inspectStagingResidues(publishRoot, residueLimits);
    return Object.freeze({
      outcome: "residue",
      reason: aggregate.count > residueLimits.maxCount
        || aggregate.totalBytes > residueLimits.maxTotalBytes
        ? "retained_quota_exceeded"
        : "retained_fail_closed",
      nativeCode: 0,
      residueBytes: measured.totalBytes,
      residueEntries: measured.entries,
      residueIdentity: expectedResidueIdentity,
      residuePath: temporaryRoot,
    });
  } catch (error) {
    if (isParentLeaseFailure(error)) throw error;
    return Object.freeze({
      outcome: "residue",
      reason: error?.code === "staging_residue_quota_exceeded"
        ? "retained_quota_exceeded"
        : "residue_observation_failed",
      nativeCode: 0,
      residueIdentity: expectedResidueIdentity,
      residuePath: temporaryRoot,
      detail: boundedErrorDetail(error),
    });
  }
}

function retainedResidueAfterParentLeaseLoss({
  expectedResidueIdentity,
  temporaryCreated,
  temporaryRoot,
}) {
  if (!temporaryCreated) {
    return Object.freeze({
      outcome: "residue",
      reason: "parent_lock_lost_before_temporary_stage",
      nativeCode: 0,
    });
  }
  return Object.freeze({
    outcome: "residue",
    reason: "parent_lock_lost",
    nativeCode: 0,
    residuePath: temporaryRoot,
    ...(typeof expectedResidueIdentity === "string"
      ? { residueIdentity: expectedResidueIdentity }
      : {}),
  });
}

function attachCleanupMetadata(error, cleanup, temporaryRoot) {
  const metadata = freezeCleanupMetadata(cleanup);
  if (error instanceof Error && Object.isExtensible(error)) {
    try {
      Object.defineProperty(error, "cleanup", {
        configurable: true,
        enumerable: true,
        value: metadata,
        writable: false,
      });
      return error;
    } catch {
      // Preserve the original failure below even when a custom Error blocks metadata.
    }
  }
  const code = typeof error?.code === "string" ? error.code : "staging_failed";
  const wrapped = new CuaDriverPackageStagingError(
    code,
    error instanceof Error ? errorMessageWithoutCode(error) : String(error),
    temporaryRoot,
  );
  wrapped.cause = error;
  wrapped.cleanup = metadata;
  for (const key of ["nativeCode", "nativeReason", "outcome"]) {
    if (error?.[key] !== undefined) {
      wrapped[key] = error[key];
    }
  }
  return wrapped;
}

function freezeCleanupMetadata(value) {
  return Object.freeze({
    outcome: "residue",
    reason: String(value?.reason ?? "cleanup_unknown").slice(0, 128),
    nativeCode: Number.isSafeInteger(value?.nativeCode) ? value.nativeCode : 0,
    ...(typeof value?.residuePath === "string"
      ? { residuePath: value.residuePath.slice(0, 2_000) }
      : {}),
    ...(typeof value?.residueIdentity === "string"
      ? { residueIdentity: value.residueIdentity.slice(0, 128) }
      : {}),
    ...(Number.isSafeInteger(value?.residueEntries)
      ? { residueEntries: value.residueEntries }
      : {}),
    ...(Number.isSafeInteger(value?.residueBytes)
      ? { residueBytes: value.residueBytes }
      : {}),
    ...(typeof value?.detail === "string"
      ? { detail: value.detail.slice(0, 500) }
      : {}),
  });
}

function errorMessageWithoutCode(error) {
  const message = error instanceof Error ? error.message : String(error);
  const prefix = typeof error?.code === "string" ? `${error.code}:` : "";
  return prefix && message.startsWith(prefix) ? message.slice(prefix.length) : message;
}

function boundedErrorDetail(error) {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

function publishedStageVerificationError(error, publishRoot) {
  const detail = error instanceof Error ? error.message : String(error);
  const wrapped = new CuaDriverPackageStagingError(
    "published_stage_verification_failed",
    `published output retained for diagnosis after verification failed: ${detail}`,
    publishRoot,
  );
  wrapped.cause = error;
  wrapped.outcome = "ambiguous";
  if (error?.nativeReason !== undefined) {
    wrapped.nativeReason = error.nativeReason;
  }
  if (error?.nativeCode !== undefined) {
    wrapped.nativeCode = error.nativeCode;
  }
  wrapped.published = true;
  return wrapped;
}

function assertStageMatchesSource(stage, source, root) {
  if (stage.lockSha256 !== source.lockSha256
    || stage.providerSha256 !== source.providerSha256
    || stage.licenseSha256 !== source.licenseSha256
    || stage.noticesSha256 !== source.noticesSha256) {
    fail(
      "staged_digest_mismatch",
      "staged bytes differ from the verified source snapshots",
      root,
    );
  }
}

async function assertStagingDestinationStable({
  outputCanonical,
  outputRoot,
  temporaryRoot,
}) {
  const actualOutputCanonical = await canonicalizeProspectivePath(outputRoot);
  const actualTemporaryCanonical = await canonicalizeProspectivePath(temporaryRoot);
  const expectedTemporaryCanonical = resolve(
    dirname(outputCanonical),
    basename(temporaryRoot),
  );
  if (canonicalPathKey(actualOutputCanonical) !== canonicalPathKey(outputCanonical)
    || canonicalPathKey(actualTemporaryCanonical)
      !== canonicalPathKey(expectedTemporaryCanonical)) {
    fail(
      "staging_output_parent_changed",
      "output root changed canonical location during staging",
      outputRoot,
    );
  }
}

async function assertPublishedStageIdentity(publishRoot, expectedIdentity) {
  const actualIdentity = await readStagingDirectoryIdentity(publishRoot);
  if (!sameFileIdentity(actualIdentity, expectedIdentity)) {
    fail(
      "staging_publish_identity_changed",
      "published output is not the verified staging directory",
      publishRoot,
    );
  }
  const publishedCanonical = await canonicalizeProspectivePath(publishRoot);
  if (canonicalPathKey(publishedCanonical) !== canonicalPathKey(publishRoot)) {
    fail(
      "staging_output_parent_changed",
      "published output changed canonical location during staging",
      publishRoot,
    );
  }
}

async function readStagingDirectoryIdentity(path) {
  let metadata;
  try {
    metadata = await lstat(path, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      fail("staging_publish_missing", "staging directory disappeared", path);
    }
    throw error;
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    fail(
      "staging_publish_identity_changed",
      "staging path is not a real directory",
      path,
    );
  }
  return Object.freeze({ dev: metadata.dev, ino: metadata.ino });
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

/** Verify only the clean pre-sign provider tree. */
export async function verifyCuaDriverPreSignStage(input) {
  const platform = normalizePackagePlatform(input?.platform);
  const resourcesRoot = requireAbsoluteRoot(input?.resourcesRoot, "resources_root_invalid");
  const providerRoot = providerRootFor(resourcesRoot);

  await assertSafeTree(resourcesRoot, providerRoot);
  const inventory = await listTreeInventory(providerRoot);
  assertExactFileInventory(
    inventory.files,
    preSignProviderFiles(platform),
    providerRoot,
  );
  assertExactDirectoryInventory(inventory.directories, platform, providerRoot);
  return inspectProviderFiles({
    resourcesRoot,
    providerRoot,
    actualFiles: inventory.files,
    platform,
  });
}

/** Verify a source-build output against independent committed package authority. */
export async function verifyCuaDriverSourceInput(input) {
  assertNoProductionTrustOverrides(input);
  return verifyCuaDriverSourceInputWithTrust(input, PRODUCTION_STAGING_TRUST);
}

async function verifyCuaDriverSourceInputWithTrust(input, trust) {
  const platform = normalizePackagePlatform(input?.platform);
  const sourceRoot = requireAbsoluteRoot(input?.sourceRoot, "source_root_invalid");
  const inspected = await inspectCuaDriverSourceInput({
    platform,
    sourceBuildVerifier: trust.sourceBuildVerifier,
    sourceRoot,
    trustedResourceRoot: trust.trustedResourceRoot,
    expectedTrustedLockSha256: trust.expectedTrustedLockSha256,
  });
  const { packageSnapshots: _packageSnapshots, ...publicResult } = inspected;
  return Object.freeze(publicResult);
}

async function inspectCuaDriverSourceInput({
  expectedTrustedLockSha256,
  platform,
  sourceBuildVerifier,
  sourceRoot,
  trustedResourceRoot,
}) {
  assertDisjointRoots(
    sourceRoot,
    trustedResourceRoot,
    "provider_trust_root_overlap",
    "source-build output and trusted lock root must be independent",
  );
  await assertCanonicalDisjointRoots(
    sourceRoot,
    trustedResourceRoot,
    "provider_trust_root_overlap",
    "source-build output and trusted lock root must be independent after canonical resolution",
  );
  await assertSafeTree(trustedResourceRoot, trustedResourceRoot);
  await assertSafeTree(sourceRoot, sourceRoot);
  const inventory = await listTreeInventory(sourceRoot);
  assertSourceInventory(inventory.files, platform, sourceRoot);
  assertSourceDirectoryInventory(inventory.directories, platform, sourceRoot);

  const packageSnapshots = await readPackageSnapshots(sourceRoot, platform);
  const trustedLockPath = resolveRelative(trustedResourceRoot, "provider-lock.json");
  const trustedLock = await readBoundedJsonSnapshot(
    trustedLockPath,
    JSON_MAX_BYTES,
    "trusted_provider_lock",
  );
  assertTrustedLockAnchor({
    expectedTrustedLockSha256,
    sourceLock: packageSnapshots["provider-lock.json"],
    sourceLockPath: resolveRelative(sourceRoot, "provider-lock.json"),
    trustedLock,
    trustedLockPath,
  });

  const inspected = inspectPackageSnapshots({
    actualFiles: inventory.files,
    packageSnapshots,
    platform,
    providerRoot: sourceRoot,
    resourcesRoot: sourceRoot,
  });
  const receipt = await sourceBuildVerifier({
    expectedProviderSha256:
      packageSnapshots[providerRelativePath(platform)].sha256,
    platform,
    sourceRoot,
    trustedResourceRoot,
  });
  assertSourceBuildReceipt({
    packageSnapshots,
    platform,
    receipt,
    sourceRoot,
  });

  await assertSafeTree(sourceRoot, sourceRoot);
  const finalInventory = await listTreeInventory(sourceRoot);
  if (JSON.stringify(finalInventory) !== JSON.stringify(inventory)) {
    fail(
      "provider_source_tree_changed",
      "source-build tree changed during package verification",
      sourceRoot,
    );
  }
  return Object.freeze({
    ...inspected,
    packageSnapshots,
    sourceRoot,
    sourceBuildVerified: true,
    trustedLockPath,
  });
}

function assertNoProductionTrustOverrides(input) {
  for (const key of [
    "expectedTrustedLockSha256",
    "sourceBuildVerifier",
    "trustedResourceRoot",
  ]) {
    if (input && Object.hasOwn(input, key)) {
      fail(
        "staging_trust_override_forbidden",
        `production staging does not accept ${key}`,
      );
    }
  }
}

async function inspectProviderFiles({
  resourcesRoot,
  providerRoot,
  actualFiles,
  platform,
}) {
  const packageSnapshots = await readPackageSnapshots(providerRoot, platform);
  return inspectPackageSnapshots({
    resourcesRoot,
    providerRoot,
    actualFiles,
    packageSnapshots,
    platform,
  });
}

function inspectPackageSnapshots({
  resourcesRoot,
  providerRoot,
  actualFiles,
  packageSnapshots,
  platform,
}) {
  const lockPath = resolveRelative(providerRoot, "provider-lock.json");
  const licensePath = resolveRelative(providerRoot, "LICENSE.md");
  const noticesPath = resolveRelative(providerRoot, "THIRD_PARTY_NOTICES.md");
  const providerPath = resolveRelative(providerRoot, providerRelativePath(platform));
  const lockSnapshot = packageSnapshots["provider-lock.json"];
  const licenseSnapshot = packageSnapshots["LICENSE.md"];
  const noticesSnapshot = packageSnapshots["THIRD_PARTY_NOTICES.md"];
  const providerSnapshot = packageSnapshots[providerRelativePath(platform)];

  if (platform === "darwin" && (providerSnapshot.mode & 0o111) === 0) {
    fail(
      "provider_darwin_not_executable",
      "Darwin provider must retain an executable file mode",
      providerPath,
    );
  }
  const platformLock = validatePackageLock({
    lock: lockSnapshot.value,
    platform,
    licenseSha256: licenseSnapshot.sha256,
  });
  const identity = validateProviderIdentity({
    platform,
    platformLock,
    providerBytes: providerSnapshot.bytes,
    providerPath,
  });
  assertPreSignDigest(
    platformLock,
    platform,
    providerSnapshot.sha256,
    providerPath,
  );
  return Object.freeze({
    platform,
    resourcesRoot,
    providerRoot,
    providerPath,
    lockPath,
    lockSha256: lockSnapshot.sha256,
    providerSha256: providerSnapshot.sha256,
    licenseSha256: licenseSnapshot.sha256,
    noticesSha256: noticesSnapshot.sha256,
    identity: Object.freeze(identity),
    files: Object.freeze([...actualFiles]),
  });
}

async function readPackageSnapshots(root, platform) {
  const values = await Promise.all(preSignProviderFiles(platform).map(async (relativePath) => {
    const path = resolveRelative(root, relativePath);
    const label = relativePath === "provider-lock.json"
      ? "provider_lock"
      : relativePath === "LICENSE.md"
        ? "provider_license"
        : relativePath === "THIRD_PARTY_NOTICES.md"
          ? "provider_notices"
          : "provider_binary";
    const maxBytes = relativePath === "provider-lock.json"
      ? JSON_MAX_BYTES
      : relativePath === "LICENSE.md"
        ? LICENSE_MAX_BYTES
        : relativePath === "THIRD_PARTY_NOTICES.md"
          ? NOTICES_MAX_BYTES
          : PROVIDER_MAX_BYTES;
    const snapshot = relativePath === "provider-lock.json"
      ? await readBoundedJsonSnapshot(path, maxBytes, label)
      : await readBoundedFileSnapshot(path, maxBytes, label);
    return [relativePath, snapshot];
  }));
  return Object.freeze(Object.fromEntries(values));
}

function parseArgs(values) {
  const result = {};
  const booleanFlags = new Set(["list-residue"]);
  for (let index = 0; index < values.length; index += 1) {
    const token = values[index];
    if (!token.startsWith("--")) {
      fail("cli_argument_invalid", `unexpected argument: ${token}`);
    }
    const key = token.slice(2);
    if (booleanFlags.has(key)) {
      if (Object.hasOwn(result, key)) {
        fail("cli_argument_duplicate", `duplicate argument: --${key}`);
      }
      result[key] = true;
      continue;
    }
    const value = values[index + 1];
    if (!value || value.startsWith("--")) {
      fail("cli_argument_missing", `missing value for --${key}`);
    }
    if (Object.hasOwn(result, key)) {
      fail("cli_argument_duplicate", `duplicate argument: --${key}`);
    }
    result[key] = value;
    index += 1;
  }
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let result;
  if (args["list-residue"]) {
    if (!args["output-root"]) {
      fail(
        "cli_mode_invalid",
        "residue listing requires --list-residue and --output-root",
      );
    }
    assertCliKeys(args, ["list-residue", "output-root"]);
    result = await listCuaDriverStagingResidues({
      outputRoot: resolve(args["output-root"]),
    });
  } else if (args["cleanup-residue"] || args["expected-residue-identity"]) {
    if (!args["cleanup-residue"]
      || !args["expected-residue-identity"]
      || !args["output-root"]) {
      fail(
        "cli_mode_invalid",
        "residue cleanup requires --cleanup-residue, --output-root and --expected-residue-identity",
      );
    }
    assertCliKeys(args, [
      "cleanup-residue",
      "expected-residue-identity",
      "output-root",
    ]);
    result = await cleanupCuaDriverStagingResidue({
      expectedResidueIdentity: args["expected-residue-identity"],
      outputRoot: resolve(args["output-root"]),
      residuePath: resolve(args["cleanup-residue"]),
    });
  } else if (args["source-root"] || args["output-root"]) {
    if (!args["source-root"] || !args["output-root"] || args["resources-root"]) {
      fail(
        "cli_mode_invalid",
        "staging requires --source-root, --output-root and --platform only",
      );
    }
    assertCliKeys(args, ["output-root", "platform", "source-root"]);
    result = await stageCuaDriverProvider({
      sourceRoot: resolve(args["source-root"]),
      outputRoot: resolve(args["output-root"]),
      platform: args.platform,
    });
  } else {
    if (!args["resources-root"]) {
      fail("cli_mode_invalid", "pre-sign verification requires --resources-root and --platform");
    }
    assertCliKeys(args, ["platform", "resources-root"]);
    const inspected = await verifyCuaDriverPreSignStage({
      resourcesRoot: resolve(args["resources-root"]),
      platform: args.platform,
    });
    result = Object.freeze({
      ...inspected,
      authority: "inspection_only",
    });
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function assertCliKeys(args, allowedKeys) {
  const allowed = new Set(allowedKeys);
  const unexpected = Object.keys(args).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    fail("cli_argument_invalid", `unexpected argument: --${unexpected[0]}`);
  }
}

if (process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    process.stderr.write(
      `error: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
