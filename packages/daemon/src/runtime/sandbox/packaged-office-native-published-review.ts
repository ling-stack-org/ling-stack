/** Fixed source closure shared by the local loader and the packaged literal reader. */
export const OFFICE_LOCAL_NATIVE_REVIEW_SOURCE_INPUTS = Object.freeze([
  "src/runtime.h", "src/runtime-internal.h", "src/runtime.cc", "src/publication.cc", "src/addon.cc",
  "scripts/build.mjs", "tests/primitive.test.mjs", "tests/readback.test.mjs", "tests/publication.test.mjs",
  "tests/test-helpers.mjs", "tests/runtime-lifetime.test.cc", "tests/runtime-budget-injected.test.cc",
  "tests/runtime-publication.test.cc", "tests/run-isolated.mjs", "README.md",
] as const);

export interface PublishedOriginalOfficeNativeReview {
  readonly schemaVersion: 1;
  readonly reviewId: "packaged_office_native_v1";
  readonly protocolVersion: 2;
  readonly napiVersion: 8;
  readonly deploymentTarget: "13.0";
  readonly sourceReviewSha256: string;
  readonly buildManifestSha256: string;
  readonly unsignedBinarySha256: string;
  readonly unsignedBinarySizeBytes: number;
  readonly finalBinarySha256: string;
  readonly finalBinarySizeBytes: number;
  readonly sourceSha256: Readonly<Record<string, string>>;
  readonly runtime: Readonly<{
    platform: "darwin";
    architecture: "arm64";
    electron: string;
    node: string;
    uv: string;
  }>;
  readonly signing: Readonly<{
    profile: "unsigned_dev";
    mode: "adhoc";
    identifier: "com.ling-stack.office-local.native";
  }>;
  readonly trust: "original_office_source_and_packaging_v1";
}

// Only the fixed same-process desktop bundler may replace this declaration.
// Runtime JSON, environment values, caller fields and globals are not readers.
const embeddedPublishedOfficeReviewJson: string = "NO_PACKAGED_OFFICE_NATIVE_REVIEW";
let snapshot: PublishedOriginalOfficeNativeReview | undefined;
let read = false;
const maximumBinarySize = 64 * 1024 * 1024;
const validHash = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);

function requireReview(value: unknown): asserts value {
  if (!value) throw new Error("packaged_office_native_published_review_invalid");
}

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  requireReview(value !== null && typeof value === "object" && !Array.isArray(value));
  const actual = Reflect.ownKeys(value).sort();
  const expected = [...keys].sort();
  requireReview(actual.length === expected.length && actual.every((key, index) => key === expected[index]));
  return value as Record<string, unknown>;
}

function binarySize(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= maximumBinarySize;
}

/**
 * Read immutable build-selection evidence from original bundled Host code.
 * This is not a Core grant, source issuer, signature verification or N-API load.
 * The ordinary unbundled module permanently returns no publication.
 */
export function readOriginalPublishedOfficeNativeReview(): PublishedOriginalOfficeNativeReview | undefined {
  if (read) return snapshot;
  if (embeddedPublishedOfficeReviewJson === "NO_PACKAGED_OFFICE_NATIVE_REVIEW") {
    read = true;
    return undefined;
  }
  requireReview(Buffer.byteLength(embeddedPublishedOfficeReviewJson) <= 32_768);
  let parsed: unknown;
  try { parsed = JSON.parse(embeddedPublishedOfficeReviewJson); }
  catch (cause) { throw new Error("packaged_office_native_published_review_invalid", { cause }); }
  const value = record(parsed, ["schemaVersion", "reviewId", "protocolVersion", "napiVersion", "deploymentTarget",
    "sourceReviewSha256", "buildManifestSha256", "unsignedBinarySha256", "unsignedBinarySizeBytes",
    "finalBinarySha256", "finalBinarySizeBytes", "sourceSha256", "runtime", "signing", "trust"]);
  requireReview(value.schemaVersion === 1 && value.reviewId === "packaged_office_native_v1"
    && value.protocolVersion === 2 && value.napiVersion === 8 && value.deploymentTarget === "13.0"
    && value.trust === "original_office_source_and_packaging_v1"
    && ["sourceReviewSha256", "buildManifestSha256", "unsignedBinarySha256", "finalBinarySha256"]
      .every(key => validHash(value[key]))
    && binarySize(value.unsignedBinarySizeBytes) && binarySize(value.finalBinarySizeBytes)
    && value.finalBinarySizeBytes <= value.unsignedBinarySizeBytes + 1024 * 1024);
  const sources = record(value.sourceSha256, OFFICE_LOCAL_NATIVE_REVIEW_SOURCE_INPUTS);
  requireReview(Object.values(sources).every(validHash));
  const runtime = record(value.runtime, ["platform", "architecture", "electron", "node", "uv"]);
  requireReview(runtime.platform === "darwin" && runtime.architecture === "arm64"
    && ["electron", "node", "uv"].every(key => typeof runtime[key] === "string"
      && /^\d+\.\d+\.\d+$/u.test(runtime[key])));
  const signing = record(value.signing, ["profile", "mode", "identifier"]);
  requireReview(signing.profile === "unsigned_dev" && signing.mode === "adhoc"
    && signing.identifier === "com.ling-stack.office-local.native");
  Object.freeze(sources);
  Object.freeze(runtime);
  Object.freeze(signing);
  snapshot = Object.freeze(value) as unknown as PublishedOriginalOfficeNativeReview;
  read = true;
  return snapshot;
}
