import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = realpathSync(fileURLToPath(new URL("../", import.meta.url)));
const nativeRoot = resolve(desktopRoot, "../../native/sandbox");
const reviewedSourcePath = join(nativeRoot, "reviewed-codesign-source-v1.json");
const sourcePaths = ["Cargo.toml", "Cargo.lock", "rust-toolchain.toml", "src/main.rs", "src/protocol.rs",
  "src/input_read.rs", "src/codesign.rs", "src/codesign_darwin.rs", "src/codesign_mach.rs", "scripts/build.mjs",
  "tests/protocol-smoke.mjs", "tests/input-read-smoke.mjs", "tests/codesign-leaf-smoke.mjs", "tests/build-evidence.test.mjs",
  "src/codesign_faults.rs", "src/codesign_darwin_tests.rs", "src/codesign_capability_tests.rs",
  "tests/support/codesign-capability-wire.rs", "tests/support/codesign-capability-observer.rs"];
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const validHash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function requirePublication(condition) {
  if (!condition) throw new Error("packaged_codesign_build_review_invalid");
}
function fixedBytes(path, maximum) {
  const stat = lstatSync(path);
  requirePublication(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= maximum
    && realpathSync(path) === path);
  const bytes = readFileSync(path);
  requirePublication(bytes.length === stat.size);
  return bytes;
}
function exactKeys(value, keys) {
  requirePublication(value && typeof value === "object" && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()));
}
function sameSources(actual, expected) {
  exactKeys(actual, sourcePaths); exactKeys(expected, sourcePaths);
  requirePublication(sourcePaths.every(path => validHash(actual[path]) && actual[path] === expected[path]
    && hash(fixedBytes(join(nativeRoot, path), 4 * 1024 * 1024)) === expected[path]));
}
/** A fixed reviewed source input, not a runtime config or automatic test-result approval. */
export function readReviewedCodesignSource() {
  const bytes = fixedBytes(reviewedSourcePath, 32_768), review = JSON.parse(bytes.toString("utf8"));
  exactKeys(review, ["schemaVersion", "reviewId", "approval", "target", "toolchain", "sourceSha256", "runtime", "os", "trust"]);
  requirePublication(review.schemaVersion === 1 && review.reviewId === "packaged_codesign_original_host_v1"
    && review.approval === "approved_source_and_packaging_review"
    && review.target === "aarch64-apple-darwin" && review.toolchain === "1.97.1"
    && review.trust === "original_host_and_trusted_packaging_transform_v1");
  exactKeys(review.runtime, ["platform", "architecture", "electron", "node", "uv"]);
  requirePublication(review.runtime.platform === "darwin" && review.runtime.architecture === "arm64"
    && ["electron", "node", "uv"].every(key => typeof review.runtime[key] === "string" && /^\d+\.\d+\.\d+$/.test(review.runtime[key])));
  exactKeys(review.os, ["release", "backendHelperVersion", "backendSha256", "codesignSha256", "templateSha256", "taskgatedBinding"]);
  requirePublication(typeof review.os.release === "string" && /^\d+\.\d+\.\d+$/.test(review.os.release)
    && review.os.backendHelperVersion?.startsWith("ling-seatbelt-v1:" + review.os.release + ":")
    && validHash(review.os.backendHelperVersion.slice(("ling-seatbelt-v1:" + review.os.release + ":").length))
    && ["backendSha256", "codesignSha256", "templateSha256"].every(key => validHash(review.os[key]))
    && review.os.taskgatedBinding === "reviewed_xml_v1");
  sameSources(review.sourceSha256, review.sourceSha256);
  Object.freeze(review.sourceSha256); Object.freeze(review.runtime); Object.freeze(review.os);
  return Object.freeze({ review: Object.freeze(review), sourceReviewSha256: hash(bytes) });
}
/** The existing fresh native build must match the independently reviewed source closure. */
export function assertReviewedCodesignBuildManifest(manifest) {
  const { review } = readReviewedCodesignSource();
  requirePublication(manifest?.schemaVersion === 1 && manifest.helperName === "ling-sandbox-runner"
    && manifest.target === review.target && manifest.host === review.target && manifest.toolchain === review.toolchain
    && manifest.verification?.format === "passed" && manifest.verification?.releaseBuild === "passed"
    && manifest.fixedCodesignLeaf?.parserProtocol === "passed");
  sameSources(manifest.sourceSha256, review.sourceSha256);
}
