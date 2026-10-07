import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync,
  symlinkSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

const moduleUrl = new URL("../dist/runtime/sandbox/packaged-office-native-resources.js", import.meta.url);
const readerUrl = new URL("../dist/runtime/sandbox/packaged-office-native-published-review.js", import.meta.url);
const readerSpecifier = '"./packaged-office-native-published-review.js"';
const marker = 'const embeddedPublishedOfficeReviewJson = "NO_PACKAGED_OFFICE_NATIVE_REVIEW";';
const invalid = /packaged_office_native_resources_invalid/u;
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const versions = { electron: "44.5.1", node: "24.19.0", uv: "1.52.1", napi: "10" };
let sequence = 0;

/** Synthetic Host code/runtime and placeholder bytes; not a publication or real package certificate. */
async function rewrittenFixture(f, { runtime = {}, executablePath = f.executablePath, expectedUid, review = f.review } = {}) {
  const reader = readFileSync(readerUrl, "utf8");
  assert.equal(reader.split(marker).length, 2);
  const readerSource = reader.replace(marker, `const embeddedPublishedOfficeReviewJson = ${JSON.stringify(JSON.stringify(review))};`);
  const embeddedReader = `data:text/javascript;base64,${Buffer.from(readerSource).toString("base64")}#reader-${++sequence}`;
  let source = readFileSync(moduleUrl, "utf8");
  assert.equal(source.split(readerSpecifier).length, 2);
  source = source.replace(readerSpecifier, JSON.stringify(embeddedReader));
  const substitutions = new Map([
    ["process.execPath", JSON.stringify(executablePath)],
    ["process.platform", JSON.stringify(runtime.platform ?? "darwin")],
    ["process.arch", JSON.stringify(runtime.architecture ?? "arm64")],
    ["process.versions", `(${JSON.stringify({ ...versions, ...runtime.versions })})`],
  ]);
  if (expectedUid !== undefined) substitutions.set("process.getuid?.()", JSON.stringify(expectedUid));
  for (const [from, to] of substitutions) {
    assert.equal(source.split(from).length, 2, from);
    source = source.replace(from, to);
  }
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}#resources-${++sequence}`);
}

async function fixture(t) {
  const ordinary = await import(readerUrl.href);
  const root = mkdtempSync(join(realpathSync(tmpdir()), "ling-office-resource-test-"));
  const originalRoot = lstatSync(root, { bigint: true });
  t.after(() => {
    const current = lstatSync(root, { bigint: true });
    assert.equal(current.dev, originalRoot.dev); assert.equal(current.ino, originalRoot.ino);
    assert.equal(current.isSymbolicLink(), false);
    rmSync(root, { recursive: true, force: true });
  });
  const appRoot = join(root, "Fixture.app"), executablePath = join(appRoot, "Contents/MacOS/Fixture");
  const officeRoot = join(appRoot, "Contents/Resources/office-local"), binaryPath = join(officeRoot, "office-local.node");
  const sourceRoot = join(officeRoot, "source"), manifestPath = join(officeRoot, "build-manifest.json");
  mkdirSync(dirname(executablePath), { recursive: true, mode: 0o700 });
  mkdirSync(sourceRoot, { recursive: true, mode: 0o700 });
  writeFileSync(executablePath, "test-only executable placeholder", { mode: 0o700 });
  const bytes = Buffer.from("test-only final signed-byte placeholder, not a native addon");
  writeFileSync(binaryPath, bytes, { mode: 0o600 });
  // Deliberately not JSON: the resolver pins bytes but never trusts manifest fields.
  writeFileSync(manifestPath, "test-only manifest bytes, not approval", { mode: 0o600 });
  const inputs = ordinary.OFFICE_LOCAL_NATIVE_REVIEW_SOURCE_INPUTS;
  for (const name of inputs) {
    const path = join(sourceRoot, name);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, `test-only source placeholder: ${name}\n`, { mode: 0o600 });
  }
  const review = {
    schemaVersion: 1, reviewId: "packaged_office_native_v1", protocolVersion: 2, napiVersion: 8,
    deploymentTarget: "13.0", sourceReviewSha256: "a".repeat(64), buildManifestSha256: hash(readFileSync(manifestPath)),
    unsignedBinarySha256: "b".repeat(64), unsignedBinarySizeBytes: bytes.length,
    finalBinarySha256: hash(bytes), finalBinarySizeBytes: bytes.length,
    sourceSha256: Object.fromEntries(inputs.map(name => [name, hash(readFileSync(join(sourceRoot, name)))])),
    runtime: { platform: "darwin", architecture: "arm64", electron: versions.electron, node: versions.node, uv: versions.uv },
    signing: { profile: "unsigned_dev", mode: "adhoc", identifier: "com.ling-stack.office-local.native" },
    trust: "original_office_source_and_packaging_v1",
  };
  return { root, appRoot, executablePath, officeRoot, binaryPath, sourceRoot, manifestPath, review, inputs };
}

test("ordinary dev cannot obtain resources from caller, environment or globals", async t => {
  const api = await import(moduleUrl.href);
  const key = "LING_PACKAGED_OFFICE_NATIVE_ROOT", old = process.env[key];
  const name = "__lingPackagedOfficeNativeResources", descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  t.after(() => {
    if (old === undefined) delete process.env[key]; else process.env[key] = old;
    if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name];
  });
  process.env[key] = "/caller/Fake.app";
  Object.defineProperty(globalThis, name, { configurable: true, get() { throw new Error("global must not be read"); } });
  assert.equal(api.resolveOriginalPackagedOfficeResources(), undefined);
  assert.equal(api.resolveOriginalPackagedOfficeResources({ appRoot: "/caller/Fake.app", coreSafe: true }), undefined);
  assert.deepEqual(Object.keys(api), ["resolveOriginalPackagedOfficeResources"]);
});

test("synthetic fixed app returns frozen paths/data only and revalidates on every call", async t => {
  const f = await fixture(t), api = await rewrittenFixture(f);
  const key = "LING_PACKAGED_OFFICE_NATIVE_ROOT", old = process.env[key];
  const name = "__lingPackagedOfficeNativeResources", descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  t.after(() => {
    if (old === undefined) delete process.env[key]; else process.env[key] = old;
    if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name];
  });
  process.env[key] = "/caller/Fake.app";
  Object.defineProperty(globalThis, name, { configurable: true, get() { throw new Error("global must not be read"); } });
  const result = api.resolveOriginalPackagedOfficeResources();
  assert.deepEqual(Object.keys(result).sort(), ["appRoot", "binaryPath", "executablePath", "officeRoot", "review", "sourceRoot"]);
  for (const name of ["appRoot", "binaryPath", "executablePath", "officeRoot", "sourceRoot"]) assert.equal(result[name], f[name]);
  assert.equal(Object.isFrozen(result), true);
  for (const value of [result.review, result.review.sourceSha256, result.review.runtime, result.review.signing])
    assert.equal(Object.isFrozen(value), true);
  assert.throws(() => { result.sourceRoot = "/caller/source"; }, TypeError);
  assert.deepEqual(api.resolveOriginalPackagedOfficeResources("/caller/Fake.app"), result);
  for (const name of ["coreSafe", "signatureVerified", "scope", "grant", "packaged"]) assert.equal(Object.hasOwn(result, name), false);
  writeFileSync(f.binaryPath, "same path changed after first read");
  assert.throws(() => api.resolveOriginalPackagedOfficeResources(), invalid);
  t.diagnostic("Synthetic runtime/source rewrite and placeholder bytes only; no signer, N-API load, real Electron/app, or Core authority tested.");
});

for (const [name, runtime] of [
  ["non-darwin", { platform: "linux" }], ["non-arm64", { architecture: "x64" }],
  ["missing Electron", { versions: { electron: undefined } }],
  ["wrong Electron", { versions: { electron: "44.5.2" } }], ["wrong Node", { versions: { node: "24.19.1" } }],
  ["wrong uv", { versions: { uv: "1.52.2" } }], ["old N-API", { versions: { napi: "7" } }],
  ["non-numeric N-API", { versions: { napi: "8x" } }], ["missing N-API", { versions: { napi: undefined } }],
]) test(`resource resolver rejects synthetic ${name} tuple`, async t => {
  const f = await fixture(t), api = await rewrittenFixture(f, { runtime });
  assert.throws(() => api.resolveOriginalPackagedOfficeResources(), invalid);
});

for (const [name, change] of [
  ["outside app", f => f.binaryPath], ["relative executable", () => "Fixture.app/Contents/MacOS/Fixture"],
  ["dot-segment executable", f => join(dirname(f.executablePath), "../MacOS") + "/../MacOS/Fixture"],
]) test(`resource resolver rejects ${name}`, async t => {
  const f = await fixture(t), api = await rewrittenFixture(f, { executablePath: change(f) });
  assert.throws(() => api.resolveOriginalPackagedOfficeResources(), invalid);
});

for (const [name, target] of [
  ["app root", f => f.appRoot], ["MacOS ancestor", f => dirname(f.executablePath)],
  ["executable", f => f.executablePath], ["office root", f => f.officeRoot],
  ["source root", f => f.sourceRoot], ["source ancestor", f => join(f.sourceRoot, "src")],
  ["source leaf", f => join(f.sourceRoot, f.inputs[0])], ["addon", f => f.binaryPath], ["manifest", f => f.manifestPath],
]) test(`resource resolver rejects symlink ${name}`, async t => {
  const f = await fixture(t), path = target(f), moved = join(f.root, `symlink-original-${++sequence}`);
  renameSync(path, moved); symlinkSync(moved, path);
  const api = await rewrittenFixture(f);
  assert.throws(() => api.resolveOriginalPackagedOfficeResources(), invalid);
});

for (const [name, target] of [
  ["app root", f => f.appRoot], ["Contents", f => join(f.appRoot, "Contents")],
  ["Resources", f => join(f.appRoot, "Contents/Resources")], ["office root", f => f.officeRoot],
  ["source directory", f => join(f.sourceRoot, "tests")], ["source leaf", f => join(f.sourceRoot, f.inputs[0])],
  ["addon", f => f.binaryPath], ["manifest", f => f.manifestPath], ["executable", f => f.executablePath],
]) test(`resource resolver rejects group/world-writable ${name}`, async t => {
  const f = await fixture(t), path = target(f), stat = lstatSync(path);
  chmodSync(path, stat.mode | 0o022);
  const api = await rewrittenFixture(f);
  assert.throws(() => api.resolveOriginalPackagedOfficeResources(), invalid);
});

test("resource resolver rejects synthetic current-UID mismatch and nonexecutable image", async t => {
  const f = await fixture(t), api = await rewrittenFixture(f, { expectedUid: process.getuid() + 1 });
  assert.throws(() => api.resolveOriginalPackagedOfficeResources(), invalid);
  chmodSync(f.executablePath, 0o600);
  const normalUid = await rewrittenFixture(f);
  assert.throws(() => normalUid.resolveOriginalPackagedOfficeResources(), invalid);
});

for (const [name, mutate] of [
  ["missing addon", f => unlinkSync(f.binaryPath)],
  ["wrong final addon digest", f => { f.review.finalBinarySha256 = "c".repeat(64); }],
  ["wrong final addon size", f => { f.review.finalBinarySizeBytes++; }],
  ["changed manifest bytes", f => writeFileSync(f.manifestPath, "not original manifest bytes")],
  ["changed source bytes", f => writeFileSync(join(f.sourceRoot, f.inputs[0]), "foreign source")],
  ["missing source leaf", f => unlinkSync(join(f.sourceRoot, f.inputs[0]))],
  ["foreign source leaf", f => writeFileSync(join(f.sourceRoot, "src/foreign.cc"), "extra")],
  ["foreign empty source directory", f => mkdirSync(join(f.sourceRoot, "foreign"))],
  ["foreign office resource", f => writeFileSync(join(f.officeRoot, "foreign.node"), "extra")],
  ["directory instead of addon", f => { unlinkSync(f.binaryPath); mkdirSync(f.binaryPath); }],
  ["directory instead of source leaf", f => { const path = join(f.sourceRoot, f.inputs[0]); unlinkSync(path); mkdirSync(path); }],
  ["directory instead of manifest", f => { unlinkSync(f.manifestPath); mkdirSync(f.manifestPath); }],
  ["oversize manifest", f => truncateSync(f.manifestPath, 1024 * 1024 + 1)],
]) test(`resource resolver rejects ${name}`, async t => {
  const f = await fixture(t); mutate(f);
  const api = await rewrittenFixture(f);
  assert.throws(() => api.resolveOriginalPackagedOfficeResources(), invalid);
});

test("resource resolver bounds each source file before reading its bytes", async t => {
  const f = await fixture(t), path = join(f.sourceRoot, f.inputs[0]);
  truncateSync(path, 4 * 1024 * 1024 + 1);
  const api = await rewrittenFixture(f);
  assert.throws(() => api.resolveOriginalPackagedOfficeResources(), invalid);
});

test("resource resolver bounds aggregate source bytes without trusting manifest fields", async t => {
  const f = await fixture(t);
  for (const name of f.inputs.slice(0, 5)) {
    const path = join(f.sourceRoot, name);
    truncateSync(path, 4 * 1024 * 1024);
    f.review.sourceSha256[name] = hash(readFileSync(path));
  }
  const api = await rewrittenFixture(f);
  assert.throws(() => api.resolveOriginalPackagedOfficeResources(), invalid);
});
