import { isDeepStrictEqual } from "node:util";

export interface PublishedOriginalCodesignReview {
  readonly schemaVersion: 1;
  readonly reviewId: "packaged_codesign_original_host_v1";
  readonly sourceReviewSha256: string;
  readonly manifestSha256: string;
  readonly helperVersion: string;
  readonly unsignedBinarySha256: string;
  readonly unsignedBinarySizeBytes: number;
  readonly sourceSha256: Readonly<Record<string, string>>;
  readonly runtime: Readonly<{ platform: "darwin"; architecture: "arm64"; electron: string; node: string; uv: string }>;
  readonly os: Readonly<{ release: string; backendHelperVersion: string; backendSha256: string; codesignSha256: string;
    templateSha256: string; taskgatedBinding: "reviewed_xml_v1" }>;
  readonly trust: "original_host_and_trusted_packaging_transform_v1";
}
// A lexical module constant, not a global/env/property/config authorization hook.
// The fixed desktop bundler replaces precisely this declaration before packaging;
// the ordinary unbundled module cannot acquire support from globalThis or JSON.
const embeddedPublishedReviewJson: string = "NO_PACKAGED_CODESIGN_REVIEW";
let snapshot: PublishedOriginalCodesignReview | undefined;
let read = false;
const sources = ["Cargo.toml", "Cargo.lock", "rust-toolchain.toml", "src/main.rs", "src/protocol.rs",
  "src/input_read.rs", "src/codesign.rs", "src/codesign_darwin.rs", "src/codesign_mach.rs", "scripts/build.mjs",
  "tests/protocol-smoke.mjs", "tests/input-read-smoke.mjs", "tests/codesign-leaf-smoke.mjs", "tests/build-evidence.test.mjs",
  "src/codesign_faults.rs", "src/codesign_darwin_tests.rs", "src/codesign_capability_tests.rs",
  "tests/support/codesign-capability-wire.rs", "tests/support/codesign-capability-observer.rs"];
const validHash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
function requireReview(condition: unknown): asserts condition {
  if (!condition) throw new Error("packaged_codesign_published_review_invalid");
}
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  requireReview(value !== null && typeof value === "object" && !Array.isArray(value));
  requireReview(isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort()));
  return value as Record<string, unknown>;
}
/** Loaded original Host code only. Not an issuer, caller review reader, or publisher-signature assertion. */
export function readOriginalPublishedCodesignReview(): PublishedOriginalCodesignReview | undefined {
  if (read) return snapshot;
  if (embeddedPublishedReviewJson === "NO_PACKAGED_CODESIGN_REVIEW") { read = true; return undefined; }
  requireReview(Buffer.byteLength(embeddedPublishedReviewJson) <= 32_768);
  const value = record(JSON.parse(embeddedPublishedReviewJson), ["schemaVersion", "reviewId", "sourceReviewSha256",
    "manifestSha256", "helperVersion", "unsignedBinarySha256", "unsignedBinarySizeBytes", "sourceSha256",
    "runtime", "os", "trust"]);
  requireReview(value.schemaVersion === 1 && value.reviewId === "packaged_codesign_original_host_v1"
    && value.trust === "original_host_and_trusted_packaging_transform_v1"
    && validHash(value.sourceReviewSha256) && validHash(value.manifestSha256) && validHash(value.unsignedBinarySha256)
    && typeof value.helperVersion === "string" && /^[\w.+-]{1,128}$/u.test(value.helperVersion)
    && typeof value.unsignedBinarySizeBytes === "number" && Number.isSafeInteger(value.unsignedBinarySizeBytes)
    && value.unsignedBinarySizeBytes > 0 && value.unsignedBinarySizeBytes <= 64 * 1024 * 1024);
  const nativeSources = record(value.sourceSha256, sources);
  requireReview(Object.values(nativeSources).every(validHash));
  const runtime = record(value.runtime, ["platform", "architecture", "electron", "node", "uv"]);
  requireReview(runtime.platform === "darwin" && runtime.architecture === "arm64"
    && ["electron", "node", "uv"].every(key => typeof runtime[key] === "string" && /^\d+\.\d+\.\d+$/u.test(runtime[key])));
  const os = record(value.os, ["release", "backendHelperVersion", "backendSha256", "codesignSha256", "templateSha256", "taskgatedBinding"]);
  requireReview(typeof os.release === "string" && /^\d+\.\d+\.\d+$/u.test(os.release)
    && typeof os.backendHelperVersion === "string" && os.backendHelperVersion.startsWith("ling-seatbelt-v1:" + os.release + ":")
    && /^[a-f0-9]{64}$/u.test(os.backendHelperVersion.slice(("ling-seatbelt-v1:" + os.release + ":").length))
    && ["backendSha256", "codesignSha256", "templateSha256"].every(key => validHash(os[key]))
    && os.taskgatedBinding === "reviewed_xml_v1");
  Object.freeze(nativeSources); Object.freeze(runtime); Object.freeze(os);
  snapshot = Object.freeze(value) as unknown as PublishedOriginalCodesignReview;
  read = true;
  return snapshot;
}
