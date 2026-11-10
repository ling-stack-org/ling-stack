import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";

/** Host-selected existing local build input. Never builds or substitutes a generated fixture addon. */
export function reviewedNativeArtifact() {
  const path = process.env.OFFICE_LOCAL_NATIVE_BUILD_EVIDENCE;
  assert.ok(path?.startsWith("/"), "OFFICE_LOCAL_NATIVE_BUILD_EVIDENCE must name the explicit reviewed local build manifest");
  const evidence = JSON.parse(readFileSync(realpathSync(path), "utf8"));
  assert.equal(evidence.addon, "office-local"); assert.equal(evidence.schemaVersion, 2);
  assert.equal(evidence.scopeBinding, "unbound"); assert.equal(evidence.packaged, false); assert.equal(evidence.coreSafe, false);
  return { binaryPath: realpathSync(evidence.binary.path), reviewedBinarySha256: evidence.binary.sha256,
    reviewedSourceSha256: evidence.sourceSha256 };
}
