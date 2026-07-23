import {
  inspectArm64MachO,
  inspectWindowsPe,
} from "./cua-driver-binary-identity.mjs";
import {
  CuaDriverPackageStagingError,
  fail,
  isRecord,
  preSignProviderFiles,
  providerRelativePath,
  resolveRelative,
} from "./cua-driver-package-staging-contract.mjs";
import {
  CuaDriverProviderLockContractError,
  validateCuaDriverProviderLockContract,
} from "../shared/cua-driver-provider-lock-contract.mjs";

export function validatePackageLock({ lock, platform, licenseSha256 }) {
  let validated;
  try {
    validated = validateCuaDriverProviderLockContract(lock, {
      platform: platform === "darwin" ? "darwin" : "win32",
      architecture: platform === "darwin" ? undefined : "x86_64",
      requireReleaseEvidence: true,
    });
  } catch (error) {
    if (error instanceof CuaDriverProviderLockContractError) {
      fail(error.code, error.message);
    }
    throw error;
  }
  if (validated.upstream.licenseSha256 !== licenseSha256) {
    fail("provider_license_digest_mismatch", "license bytes do not match the provider lock");
  }
  return platform === "darwin"
    ? validated.platforms.darwin
    : validated.platforms.win32X64;
}

export function assertTrustedLockAnchor({
  expectedTrustedLockSha256,
  sourceLock,
  sourceLockPath,
  trustedLock,
  trustedLockPath,
}) {
  if (expectedTrustedLockSha256 !== undefined
    && trustedLock.sha256 !== expectedTrustedLockSha256) {
    fail(
      "trusted_provider_lock_digest_mismatch",
      `checked-in provider lock does not match its independent digest anchor ${expectedTrustedLockSha256}`,
      trustedLockPath,
    );
  }
  if (sourceLock.sha256 !== trustedLock.sha256
    || !sourceLock.bytes.equals(trustedLock.bytes)) {
    fail(
      "provider_lock_anchor_mismatch",
      `source provider lock does not match the committed anchor ${trustedLockPath}`,
      sourceLockPath,
    );
  }
}

export function assertSourceBuildReceipt({
  packageSnapshots,
  platform,
  receipt,
  sourceRoot,
}) {
  if (!isRecord(receipt)
    || receipt.platform !== platform
    || !isRecord(receipt.files)) {
    fail(
      "provider_source_build_receipt_mismatch",
      "source-build verifier receipt targets a different platform",
      sourceRoot,
    );
  }
  for (const relativePath of preSignProviderFiles(platform)) {
    const snapshot = packageSnapshots[relativePath];
    if (!snapshot || receipt.files[relativePath] !== snapshot.sha256) {
      fail(
        "provider_source_build_receipt_mismatch",
        `source-build verifier did not bind the staged bytes: ${relativePath}`,
        resolveRelative(sourceRoot, relativePath),
      );
    }
  }
}

export function assertPreSignDigest(platformLock, platform, providerSha256, providerPath) {
  const expected = platform === "darwin"
    ? platformLock.sourceBuild.binarySha256BeforeSigning
    : platformLock.sourceBuild.binariesSha256BeforeSigning.main;
  if (providerSha256 !== expected) {
    fail(
      "provider_pre_sign_digest_mismatch",
      `provider bytes do not match the committed pre-sign digest ${expected}`,
      providerPath,
    );
  }
}

export function validateProviderIdentity({
  platform,
  platformLock,
  providerBytes,
  providerPath,
}) {
  try {
    if (platform === "darwin") {
      const identity = inspectArm64MachO(providerBytes, "staged Darwin Cua Driver");
      if (identity.minimumOSVersion !== "13.0") {
        fail(
          "provider_darwin_minimum_os_mismatch",
          "Darwin provider must be arm64 and target macOS 13.0",
          providerPath,
        );
      }
      return identity;
    }
    const identity = inspectWindowsPe(providerBytes, "staged Windows Cua Driver");
    if (identity.architecture !== "x86_64"
      || identity.manifest.executionLevel !== "asInvoker"
      || identity.manifest.uiAccess !== false
      || identity.embeddedCertificateTablePresent !== false) {
      fail(
        "provider_windows_identity_mismatch",
        "pre-sign Windows provider must be x86_64, asInvoker, uiAccess=false and unsigned",
        providerPath,
      );
    }
    if (identity.manifest.sha256 !== platformLock.binary.mainManifestCanonicalSha256) {
      fail(
        "provider_windows_manifest_digest_mismatch",
        "Windows provider RT_MANIFEST bytes do not match the committed manifest digest",
        providerPath,
      );
    }
    return identity;
  } catch (error) {
    if (error instanceof CuaDriverPackageStagingError) {
      throw error;
    }
    fail(
      "provider_binary_identity_invalid",
      error instanceof Error ? error.message : String(error),
      providerPath,
    );
  }
}

export function assertSourceInventory(files, platform, sourceRoot) {
  const allowed = new Set([
    "LICENSE.md",
    "THIRD_PARTY_NOTICES.md",
    "cua-driver.spdx.json",
    "provider-lock.json",
    "source-build-attestation.json",
    "source-build-inputs.json",
    "source-build-manifest.json",
    "source-build-promotion-inputs.json",
    providerRelativePath(platform),
    ...(platform === "win32-x64"
      ? ["audit/win32-x64/cua-driver-uia.exe"]
      : []),
  ]);
  for (const file of files) {
    if (file.endsWith("/cua-driver-uia.exe")
      && file !== "audit/win32-x64/cua-driver-uia.exe") {
      fail(
        "provider_uia_payload_forbidden",
        "cua-driver-uia.exe is audit-only and cannot enter the package payload",
        resolveRelative(sourceRoot, file),
      );
    }
    if (!allowed.has(file)) {
      fail(
        "provider_source_extra_entry",
        `unexpected source-build staging entry: ${file}`,
        resolveRelative(sourceRoot, file),
      );
    }
  }
  for (const required of preSignProviderFiles(platform)) {
    if (!files.includes(required)) {
      fail(
        "provider_source_entry_missing",
        `required source-build staging entry is missing: ${required}`,
        resolveRelative(sourceRoot, required),
      );
    }
  }
}

export function assertSourceDirectoryInventory(directories, platform, sourceRoot) {
  const allowed = new Set(
    platform === "darwin"
      ? ["darwin"]
      : ["audit", "audit/win32-x64", "win32-x64", "win32-x64/payload"],
  );
  for (const directory of directories) {
    if (!allowed.has(directory)) {
      fail(
        "provider_source_extra_entry",
        `unexpected source-build staging directory: ${directory}`,
        resolveRelative(sourceRoot, directory),
      );
    }
  }
  for (const required of platform === "darwin"
    ? ["darwin"]
    : ["win32-x64", "win32-x64/payload"]) {
    if (!directories.includes(required)) {
      fail(
        "provider_source_entry_missing",
        `required source-build staging directory is missing: ${required}`,
        resolveRelative(sourceRoot, required),
      );
    }
  }
}

export function assertExactFileInventory(actual, expected, providerRoot) {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  for (const file of actual) {
    if (file.endsWith("cua-driver-uia.exe")) {
      fail(
        "provider_uia_payload_forbidden",
        "cua-driver-uia.exe is forbidden in the standard package",
        resolveRelative(providerRoot, file),
      );
    }
    if (!expectedSet.has(file)) {
      fail(
        "provider_stage_extra_entry",
        `unexpected provider package entry: ${file}`,
        resolveRelative(providerRoot, file),
      );
    }
  }
  for (const file of expected) {
    if (!actualSet.has(file)) {
      fail(
        "provider_stage_entry_missing",
        `required provider package entry is missing: ${file}`,
        resolveRelative(providerRoot, file),
      );
    }
  }
}

export function assertExactDirectoryInventory(actual, platform, providerRoot) {
  const expected = platform === "darwin"
    ? ["darwin"]
    : ["win32-x64", "win32-x64/payload"];
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    const firstUnexpected = actual.find((directory) => !expected.includes(directory));
    if (firstUnexpected) {
      fail(
        "provider_stage_extra_entry",
        `unexpected provider package directory: ${firstUnexpected}`,
        resolveRelative(providerRoot, firstUnexpected),
      );
    }
    const firstMissing = expected.find((directory) => !actual.includes(directory));
    fail(
      "provider_stage_entry_missing",
      `required provider package directory is missing: ${firstMissing ?? "unknown"}`,
      firstMissing ? resolveRelative(providerRoot, firstMissing) : providerRoot,
    );
  }
}
