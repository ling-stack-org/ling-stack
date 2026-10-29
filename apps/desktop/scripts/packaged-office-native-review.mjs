import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { OFFICE_LOCAL_NATIVE_REVIEW_SOURCE_INPUTS } from "../../../packages/daemon/src/runtime/sandbox/packaged-office-native-published-review.ts";
import { PACKAGED_OFFICE_NATIVE_PACKAGING_SOURCE_INPUTS } from "./packaged-office-native-review-inputs.mjs";
import { observeOfficeNativeToolchain, assertOfficeNativeToolchainProfile } from "./packaged-office-native-toolchain.mjs";

const repositoryRoot = realpathSync(fileURLToPath(new URL("../../../", import.meta.url)));
const nativeRoot = join(repositoryRoot, "native/office-local");
const reviewedSourcePath = join(nativeRoot, "reviewed-packaged-source-v1.json");
const packagingPaths = PACKAGED_OFFICE_NATIVE_PACKAGING_SOURCE_INPUTS;
// Independent review grows with the fixed authored closure, not the runtime literal.
const sourceReviewMaximumBytes = 256 * 1024;
const headerNames = Object.freeze(["node_api.h", "js_native_api.h", "js_native_api_types.h", "node_api_types.h"]);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const validHash = value => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
function requireReview(value) {
  if (!value) throw new Error("packaged_office_native_source_review_invalid");
}
function exactKeys(value, keys) {
  requireReview(value !== null && typeof value === "object" && !Array.isArray(value)
    && JSON.stringify(Reflect.ownKeys(value).sort()) === JSON.stringify([...keys].sort()));
}
function bytesAt(path, maximum = 8 * 1024 * 1024) {
  const stat = lstatSync(path, { bigint: true });
  requireReview(stat.isFile() && !stat.isSymbolicLink() && realpathSync(path) === path
    && stat.size > 0n && stat.size <= BigInt(maximum));
  const bytes = readFileSync(path), after = lstatSync(path, { bigint: true });
  requireReview(bytes.length === Number(stat.size) && stat.dev === after.dev && stat.ino === after.ino
    && stat.size === after.size && stat.mtimeNs === after.mtimeNs && stat.ctimeNs === after.ctimeNs);
  return bytes;
}
function assertDigests(root, actual, paths, maximum = 8 * 1024 * 1024, totalMaximum = Number.MAX_SAFE_INTEGER) {
  exactKeys(actual, paths);
  let total = 0;
  for (const path of paths) {
    requireReview(validHash(actual[path]));
    const bytes = bytesAt(join(root, path), maximum); total += bytes.length;
    requireReview(total <= totalMaximum && hash(bytes) === actual[path]);
  }
}
function freezeReview(value) {
  for (const child of Object.values(value)) if (child && typeof child === "object") freezeReview(child);
  return Object.freeze(value);
}
function equalRecord(actual, expected) {
  exactKeys(actual, Object.keys(expected));
  requireReview(Object.keys(expected).every(key => expected[key] && typeof expected[key] === "object"
    ? equalRecord(actual[key], expected[key]) : actual[key] === expected[key]));
  return true;
}

/** Fixed independent review input. No caller path, approval updater, or build-result approval. */
export function readReviewedPackagedOfficeSource() {
  let bytes;
  try { bytes = bytesAt(reviewedSourcePath, sourceReviewMaximumBytes); }
  catch (cause) {
    if (cause?.code === "ENOENT") throw new Error("packaged_office_native_source_review_missing", { cause });
    throw cause;
  }
  let review;
  try { review = JSON.parse(bytes.toString("utf8")); }
  catch (cause) { throw new Error("packaged_office_native_source_review_invalid", { cause }); }
  const portable = review?.schemaVersion === 2;
  exactKeys(review, ["schemaVersion", "reviewId", "approval", "protocolVersion", "napiVersion", "deploymentTarget",
    "sourceSha256", "packagingSha256", ...(portable ? ["toolchains"] : ["compiler", "sdk"]), "headers", "runtime", "signing", "trust"]);
  requireReview((review.schemaVersion === 1 || portable) && review.reviewId === "packaged_office_native_v1"
    && review.approval === "approved_source_and_packaging_review" && review.protocolVersion === 2
    && review.napiVersion === 8 && review.deploymentTarget === "13.0"
    && review.trust === "original_office_source_and_packaging_v1");
  exactKeys(review.runtime, ["platform", "architecture", "electron", "node", "uv"]);
  requireReview(review.runtime.platform === "darwin" && review.runtime.architecture === "arm64"
    && ["electron", "node", "uv"].every(key => typeof review.runtime[key] === "string"
      && /^\d+\.\d+\.\d+$/u.test(review.runtime[key])));
  exactKeys(review.signing, ["profile", "mode", "identifier"]);
  requireReview(review.signing.profile === "unsigned_dev" && review.signing.mode === "adhoc"
    && review.signing.identifier === "com.ling-stack.office-local.native");
  if (portable) {
    exactKeys(review.headers, ["selector", "environment", "sha256"]);
    requireReview(review.headers.selector === "local_environment_path"
      && review.headers.environment === "LING_OFFICE_NODE_HEADERS");
    const observed = observeOfficeNativeToolchain();
    assertOfficeNativeToolchainProfile(review.toolchains, review.headers.sha256, observed);
    // Expanded paths/facts are transient observations. The approved JSON stays
    // static and its digest continues to bind the same-process publication.
    review = { ...review, compiler: observed.compiler, sdk: observed.sdk, headers: observed.headers };
  } else {
    exactKeys(review.compiler, ["path", "version", "sha256"]);
    exactKeys(review.sdk, ["root", "settingsSha256"]);
    exactKeys(review.headers, ["root", "sha256"]);
    requireReview([review.compiler.path, review.sdk.root, review.headers.root].every(path => typeof path === "string"
      && isAbsolute(path) && resolve(path) === path && realpathSync(path) === path)
      && typeof review.compiler.version === "string" && review.compiler.version.length > 0
      && review.compiler.version.length <= 4096 && validHash(review.compiler.sha256)
      && validHash(review.sdk.settingsSha256));
    requireReview(hash(bytesAt(review.compiler.path, 512 * 1024 * 1024)) === review.compiler.sha256
      && hash(bytesAt(join(review.sdk.root, "SDKSettings.json"))) === review.sdk.settingsSha256);
    assertDigests(review.headers.root, review.headers.sha256, headerNames);
  }
  assertDigests(nativeRoot, review.sourceSha256, OFFICE_LOCAL_NATIVE_REVIEW_SOURCE_INPUTS, 4 * 1024 * 1024, 16 * 1024 * 1024);
  assertDigests(repositoryRoot, review.packagingSha256, packagingPaths);
  return Object.freeze({ review: freezeReview(review), sourceReviewSha256: hash(bytes) });
}

/** A local packaging observation, not the independently approved release review. */
export function readLocalPackagedOfficeSource() {
  if (process.env.LING_PACKAGED_RELEASE_REVIEW_REQUIRED === "1") return readReviewedPackagedOfficeSource();
  const bytes = bytesAt(reviewedSourcePath, sourceReviewMaximumBytes);
  let approved;
  try { approved = JSON.parse(bytes.toString("utf8")); }
  catch (cause) { throw new Error("packaged_office_native_source_review_invalid", { cause }); }
  if (approved.schemaVersion !== 2) return readReviewedPackagedOfficeSource();
  exactKeys(approved, ["schemaVersion", "reviewId", "approval", "protocolVersion", "napiVersion",
    "deploymentTarget", "sourceSha256", "packagingSha256", "toolchains", "headers", "runtime", "signing", "trust"]);
  requireReview(approved.schemaVersion === 2 && approved.reviewId === "packaged_office_native_v1"
    && approved.approval === "approved_source_and_packaging_review"
    && approved.trust === "original_office_source_and_packaging_v1"
    && approved.protocolVersion === 2 && approved.napiVersion === 8
    && approved.deploymentTarget === "13.0");
  exactKeys(approved.headers, ["selector", "environment", "sha256"]);
  requireReview(approved.headers.selector === "local_environment_path"
    && approved.headers.environment === "LING_OFFICE_NODE_HEADERS");
  exactKeys(approved.headers.sha256, headerNames);
  requireReview(headerNames.every(name => validHash(approved.headers.sha256[name])));
  exactKeys(approved.packagingSha256, packagingPaths);
  requireReview(packagingPaths.every(name => validHash(approved.packagingSha256[name])));
  exactKeys(approved.sourceSha256, OFFICE_LOCAL_NATIVE_REVIEW_SOURCE_INPUTS);
  const sourceSha256 = Object.fromEntries(OFFICE_LOCAL_NATIVE_REVIEW_SOURCE_INPUTS.map(name => {
    const source = bytesAt(join(nativeRoot, name), 4 * 1024 * 1024);
    return [name, hash(source)];
  }));
  requireReview(OFFICE_LOCAL_NATIVE_REVIEW_SOURCE_INPUTS.every(name =>
    sourceSha256[name] === approved.sourceSha256[name]));
  const observed = observeOfficeNativeToolchain();
  exactKeys(observed.headers.sha256, headerNames);
  requireReview(headerNames.every(name => validHash(observed.headers.sha256[name])));
  const review = freezeReview({ ...approved, sourceSha256,
    compiler: observed.compiler, sdk: observed.sdk, headers: observed.headers });
  const packagingSha256 = Object.fromEntries(packagingPaths.map(name =>
    [name, hash(bytesAt(join(repositoryRoot, name)))]));
  const observationSha256 = hash(Buffer.from(JSON.stringify({ approvedReviewSha256: hash(bytes),
    sourceSha256, packagingSha256, compiler: observed.compiler, sdk: observed.sdk, headers: observed.headers })));
  return Object.freeze({ review, sourceReviewSha256: observationSha256 });
}

/** Validate facts from the original fresh builder; this does not mint a publication token. */
export function assertReviewedOfficeNativeBuild(evidence, expected = readLocalPackagedOfficeSource()) {
  const { review } = expected;
  requireReview(evidence?.schemaVersion === 2 && evidence.addon === "office-local"
    && evidence.protocolVersion === review.protocolVersion && evidence.napiVersion === review.napiVersion
    && evidence.deploymentTarget === review.deploymentTarget && evidence.platform === review.runtime.platform
    && evidence.architecture === review.runtime.architecture && evidence.verification?.compilation === "passed"
    && evidence.scopeBinding === "unbound" && evidence.coreSafe === false && evidence.packaged === false);
  for (const key of ["compiler", "sdk", "headers"]) {
    equalRecord(evidence[key], review[key]);
  }
  assertDigests(nativeRoot, evidence.sourceSha256, OFFICE_LOCAL_NATIVE_REVIEW_SOURCE_INPUTS, 4 * 1024 * 1024, 16 * 1024 * 1024);
  requireReview(OFFICE_LOCAL_NATIVE_REVIEW_SOURCE_INPUTS.every(path => evidence.sourceSha256[path] === review.sourceSha256[path])
    && validHash(evidence.binary?.sha256) && Number.isSafeInteger(evidence.binary.bytes)
    && evidence.binary.bytes > 0 && evidence.binary.bytes <= 64 * 1024 * 1024);
}
