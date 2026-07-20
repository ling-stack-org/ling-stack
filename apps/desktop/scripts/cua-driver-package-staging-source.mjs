import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  fail,
  isRecord,
  isSha256,
  normalizePackagePlatform,
  preSignProviderFiles,
} from "./cua-driver-package-staging-contract.mjs";
import { runOwnedProcess } from "./cua-driver-owned-process.mjs";

const SOURCE_BUILD_VERIFIER = fileURLToPath(
  new URL("./verify-cua-driver-source-build.mjs", import.meta.url),
);
const MAX_VERIFIER_OUTPUT_BYTES = 8 * 1024 * 1024;
const VERIFIER_TIMEOUT_MS = 120_000;

/**
 * Invoke the existing source-build verifier as the sole authority for build,
 * attestation, runtime-probe and supply-chain evidence. Its receipt remains
 * non-promoting; package eligibility comes only from the committed lock.
 */
export async function verifyCuaDriverSourceBuildOutput({
  expectedProviderSha256,
  platform,
  sourceRoot,
  trustedResourceRoot,
}) {
  return verifyCuaDriverSourceBuildOutputWithRunner({
    expectedProviderSha256,
    platform,
    sourceRoot,
    trustedResourceRoot,
  }, runOwnedProcess);
}

/** Test-only runner seam; production always uses the fixed Node child above. */
export function createCuaDriverSourceBuildVerifierForTest(runVerifierProcess) {
  if (typeof runVerifierProcess !== "function") {
    fail(
      "source_build_verifier_runner_invalid",
      "source-build verifier test runner must be callable",
    );
  }
  return async (input) => verifyCuaDriverSourceBuildOutputWithRunner(
    input,
    runVerifierProcess,
  );
}

async function verifyCuaDriverSourceBuildOutputWithRunner({
  expectedProviderSha256,
  platform,
  sourceRoot,
  trustedResourceRoot,
}, runVerifierProcess) {
  const expectedPlatform = normalizePackagePlatform(platform);
  if (!isSha256(expectedProviderSha256)) {
    fail(
      "provider_source_build_expected_digest_invalid",
      "source-build verifier requires the trusted parent provider digest",
      sourceRoot,
    );
  }
  let stdout;
  try {
    ({ stdout } = await runVerifierProcess(
      process.execPath,
      [
        SOURCE_BUILD_VERIFIER,
        "--expected-platform",
        expectedPlatform,
        "--expected-provider-sha256",
        expectedProviderSha256,
        "--resource-root",
        resolve(trustedResourceRoot),
        "--attestation",
        resolve(sourceRoot, "source-build-attestation.json"),
        "--output-root",
        resolve(sourceRoot),
      ],
      {
        maxBuffer: MAX_VERIFIER_OUTPUT_BYTES,
        timeout: VERIFIER_TIMEOUT_MS,
        windowsHide: true,
      },
    ));
  } catch (error) {
    const detail = String(error?.stderr || error?.message || error).trim().slice(0, 2_000);
    fail(
      "provider_source_build_verification_failed",
      detail || "source-build verifier failed without diagnostics",
      sourceRoot,
    );
  }

  let receipt;
  try {
    receipt = JSON.parse(stdout);
  } catch {
    fail(
      "provider_source_build_receipt_invalid",
      "source-build verifier did not return bounded JSON",
      sourceRoot,
    );
  }
  if (!isRecord(receipt)
    || receipt.ok !== true
    || receipt.platform !== expectedPlatform
    || !isRecord(receipt.files)) {
    fail(
      "provider_source_build_receipt_invalid",
      "source-build verifier receipt is incomplete",
      sourceRoot,
    );
  }
  for (const [path, digest] of Object.entries(receipt.files)) {
    if (typeof path !== "string" || path.length === 0 || !isSha256(digest)) {
      fail(
        "provider_source_build_receipt_invalid",
        "source-build verifier receipt contains an invalid file digest",
        sourceRoot,
      );
    }
  }
  for (const path of preSignProviderFiles(expectedPlatform)) {
    if (!isSha256(receipt.files[path])) {
      fail(
        "provider_source_build_receipt_invalid",
        `source-build verifier receipt is missing a required file digest: ${path}`,
        sourceRoot,
      );
    }
  }
  return Object.freeze({
    platform: receipt.platform,
    files: Object.freeze({ ...receipt.files }),
  });
}
