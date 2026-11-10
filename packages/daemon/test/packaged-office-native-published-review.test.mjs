import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const moduleUrl = new URL("../dist/runtime/sandbox/packaged-office-native-published-review.js", import.meta.url);
const marker = 'const embeddedPublishedOfficeReviewJson = "NO_PACKAGED_OFFICE_NATIVE_REVIEW";';
const invalid = /packaged_office_native_published_review_invalid/u;
const hash = "a".repeat(64);
let sequence = 0;

/** Explicitly rewritten test-only Host code, not a publisher or production certificate. */
async function fixture(value, raw = false) {
  const source = readFileSync(moduleUrl, "utf8");
  assert.equal(source.split(marker).length, 2);
  const literal = raw ? value : JSON.stringify(value);
  const rewritten = source.replace(marker, `const embeddedPublishedOfficeReviewJson = ${JSON.stringify(literal)};`);
  return import(`data:text/javascript;base64,${Buffer.from(rewritten).toString("base64")}#fixture-${++sequence}`);
}

function publication(inputs) {
  return {
    schemaVersion: 1, reviewId: "packaged_office_native_v1", protocolVersion: 2, napiVersion: 8,
    deploymentTarget: "13.0", sourceReviewSha256: hash, buildManifestSha256: hash,
    unsignedBinarySha256: hash, unsignedBinarySizeBytes: 4096,
    finalBinarySha256: "b".repeat(64), finalBinarySizeBytes: 8192,
    sourceSha256: Object.fromEntries(inputs.map(name => [name, hash])),
    runtime: { platform: "darwin", architecture: "arm64", electron: "44.5.1", node: "24.19.0", uv: "1.52.1" },
    signing: { profile: "unsigned_dev", mode: "adhoc", identifier: "com.ling-stack.office-local.native" },
    trust: "original_office_source_and_packaging_v1",
  };
}

test("ordinary module cannot acquire an Office publication from runtime data", async t => {
  const api = await import(moduleUrl.href);
  const name = "LING_PACKAGED_OFFICE_NATIVE_REVIEW", previous = process.env[name];
  const globalName = "__lingPackagedOfficeNativeReview", descriptor = Object.getOwnPropertyDescriptor(globalThis, globalName);
  t.after(() => {
    if (previous === undefined) delete process.env[name]; else process.env[name] = previous;
    if (descriptor) Object.defineProperty(globalThis, globalName, descriptor); else delete globalThis[globalName];
  });
  process.env[name] = JSON.stringify(publication(api.OFFICE_LOCAL_NATIVE_REVIEW_SOURCE_INPUTS));
  Object.defineProperty(globalThis, globalName, { configurable: true, get() { throw new Error("global must not be read"); } });
  assert.equal(api.readOriginalPublishedOfficeNativeReview(), undefined);
  process.env[name] = "{}";
  assert.equal(api.readOriginalPublishedOfficeNativeReview(), undefined);
  assert.deepEqual(Object.keys(api).sort(), ["OFFICE_LOCAL_NATIVE_REVIEW_SOURCE_INPUTS", "readOriginalPublishedOfficeNativeReview"]);
});

test("synthetic literal is immutable build-selection data, not native or Core safety", async t => {
  const ordinary = await import(moduleUrl.href), value = publication(ordinary.OFFICE_LOCAL_NATIVE_REVIEW_SOURCE_INPUTS);
  const api = await fixture(value), read = api.readOriginalPublishedOfficeNativeReview();
  assert.deepEqual(read, value);
  assert.equal(api.readOriginalPublishedOfficeNativeReview(), read);
  for (const item of [read, read.sourceSha256, read.runtime, read.signing]) assert.equal(Object.isFrozen(item), true);
  assert.throws(() => { read.finalBinarySha256 = "c".repeat(64); }, TypeError);
  assert.throws(() => { read.sourceSha256[ordinary.OFFICE_LOCAL_NATIVE_REVIEW_SOURCE_INPUTS[0]] = "c".repeat(64); }, TypeError);
  for (const field of ["coreSafe", "scope", "grant", "binaryPath", "sourceRoot", "canonicalVisibility", "packaged"]) {
    assert.equal(Object.hasOwn(read, field), false);
  }
  t.diagnostic("Synthetic literal only: no source approval, signature, native load, runtime compatibility, original producer or packaged GUI is tested.");
});

const mutations = [
  ["foreign review", value => { value.reviewId = "packaged_codesign_original_host_v1"; }],
  ["wrong schema", value => { value.schemaVersion = 2; }],
  ["old native protocol", value => { value.protocolVersion = 1; }],
  ["wrong N-API contract", value => { value.napiVersion = 9; }],
  ["wrong deployment target", value => { value.deploymentTarget = "14.0"; }],
  ["unreviewed trust", value => { value.trust = "local_build_evidence"; }],
  ["missing build digest", value => { delete value.buildManifestSha256; }],
  ["uppercase source review digest", value => { value.sourceReviewSha256 = "A".repeat(64); }],
  ["short final byte digest", value => { value.finalBinarySha256 = "b".repeat(63); }],
  ["caller binary path", value => { value.binaryPath = "/caller/office-local.node"; }],
  ["caller source root", value => { value.sourceRoot = "/caller/native/"; }],
  ["invented Core safety", value => { value.coreSafe = true; }],
  ["missing original source", value => { delete value.sourceSha256[Object.keys(value.sourceSha256)[0]]; }],
  ["additional source", value => { value.sourceSha256["caller.cc"] = hash; }],
  ["zero binary", value => { value.unsignedBinarySizeBytes = 0; }],
  ["fractional binary", value => { value.finalBinarySizeBytes = 8192.5; }],
  ["oversize final binary", value => { value.finalBinarySizeBytes = 64 * 1024 * 1024 + 1; }],
  ["unbounded signature growth", value => { value.finalBinarySizeBytes = value.unsignedBinarySizeBytes + 1024 * 1024 + 1; }],
  ["unreviewed architecture", value => { value.runtime.architecture = "x64"; }],
  ["non-macOS runtime", value => { value.runtime.platform = "linux"; }],
  ["version range instead of tuple", value => { value.runtime.electron = "^44.5.1"; }],
  ["extra runtime selector", value => { value.runtime.executablePath = "/caller/Electron"; }],
  ["foreign signature profile", value => { value.signing.profile = "production_signed"; }],
  ["unsigned result", value => { value.signing.mode = "unsigned"; }],
  ["caller signing identifier", value => { value.signing.identifier = "caller.office"; }],
];

for (const [name, mutate] of mutations) {
  test(`published Office literal rejects ${name}`, async () => {
    const ordinary = await import(moduleUrl.href), value = publication(ordinary.OFFICE_LOCAL_NATIVE_REVIEW_SOURCE_INPUTS);
    mutate(value);
    const api = await fixture(value);
    assert.throws(() => api.readOriginalPublishedOfficeNativeReview(), invalid);
    assert.throws(() => api.readOriginalPublishedOfficeNativeReview(), invalid);
  });
}

for (const [name, input] of [["malformed JSON", "{"], ["null", "null"], ["array", "[]"],
  ["oversize literal", " ".repeat(32_769)]]) {
  test(`published Office literal rejects ${name}`, async () => {
    const api = await fixture(input, true);
    assert.throws(() => api.readOriginalPublishedOfficeNativeReview(), invalid);
  });
}

test("shared native source list exactly matches the original fixed build closure", async () => {
  const api = await import(moduleUrl.href);
  const build = await import(new URL("../../../native/office-local/scripts/build.mjs", import.meta.url));
  assert.equal(Object.isFrozen(api.OFFICE_LOCAL_NATIVE_REVIEW_SOURCE_INPUTS), true);
  assert.equal(api.OFFICE_LOCAL_NATIVE_REVIEW_SOURCE_INPUTS.length, 15);
  assert.deepEqual([...api.OFFICE_LOCAL_NATIVE_REVIEW_SOURCE_INPUTS].sort(), Object.keys(build.sourceDigests()).sort());
});
