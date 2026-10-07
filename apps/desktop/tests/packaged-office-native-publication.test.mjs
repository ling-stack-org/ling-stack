import assert from "node:assert/strict";
import test from "node:test";
import childProcess from "node:child_process";
import fsModule from "node:fs";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { OFFICE_LOCAL_NATIVE_REVIEW_SOURCE_INPUTS } from "../../../packages/daemon/dist/runtime/sandbox/packaged-office-native-published-review.js";

const repositoryRoot = realpathSync(fileURLToPath(new URL("../../../", import.meta.url)));
const scriptRoot = join(repositoryRoot, "apps/desktop/scripts");
const compiledListUrl = pathToFileURL(join(repositoryRoot,
  "packages/daemon/dist/runtime/sandbox/packaged-office-native-published-review.js")).href;
const hash = value => createHash("sha256").update(value).digest("hex");
function newFile(path, value) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value); }

/** Disposable, explicitly synthetic compiler/signature fixture. It never approves product sources. */
async function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ling-office-publication-test-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scripts = join(root, "apps/desktop/scripts"), nativeRoot = join(root, "native/office-local");
  const reviewSource = readFileSync(join(scriptRoot, "packaged-office-native-review.mjs"), "utf8");
  const paths = JSON.parse(reviewSource.match(/const packagingPaths = Object\.freeze\((\[[\s\S]*?\])\);/u)[1]
    .replace(/,\s*\]/gu, "]"));
  for (const name of paths) {
    const original = join(repositoryRoot, name);
    newFile(join(root, name), existsSync(original) ? readFileSync(original) : "EXPLICIT TEST-ONLY PACKAGING INPUT\n");
  }
  for (const name of OFFICE_LOCAL_NATIVE_REVIEW_SOURCE_INPUTS) {
    newFile(join(nativeRoot, name), readFileSync(join(repositoryRoot, "native/office-local", name)));
  }
  const reviewModule = join(scripts, "packaged-office-native-review.mjs");
  writeFileSync(reviewModule, reviewSource.replace(
    '"../../../packages/daemon/dist/runtime/sandbox/packaged-office-native-published-review.js"', JSON.stringify(compiledListUrl)));
  const producerModule = join(scripts, "build-packaged-office-native.mjs");
  const producer = readFileSync(producerModule, "utf8")
    .replace('"../../../packages/daemon/dist/runtime/sandbox/packaged-office-native-published-review.js"', JSON.stringify(compiledListUrl))
    .replace('import { tmpdir } from "node:os";', `const tmpdir = () => ${JSON.stringify(join(root, "temporary"))};`)
    .replace('import { resolveSigningProfile } from "./cua-driver-signing/signing-contract.mjs";',
      'const resolveSigningProfile = () => ({ signingTier: "unsigned_dev" });');
  writeFileSync(producerModule, producer);
  mkdirSync(join(root, "temporary"));
  const compilerPath = join(root, "toolchain/clang++"), sdkRoot = join(root, "sdk"), headersRoot = join(root, "headers");
  newFile(compilerPath, "SYNTHETIC COMPILER IDENTITY"); newFile(join(sdkRoot, "SDKSettings.json"), "SYNTHETIC SDK");
  const headerNames = ["node_api.h", "js_native_api.h", "js_native_api_types.h", "node_api_types.h"];
  for (const name of headerNames) newFile(join(headersRoot, name), "SYNTHETIC HEADER:" + name);
  const review = { schemaVersion: 1, reviewId: "packaged_office_native_v1", approval: "approved_source_and_packaging_review",
    protocolVersion: 2, napiVersion: 8, deploymentTarget: "13.0",
    sourceSha256: Object.fromEntries(OFFICE_LOCAL_NATIVE_REVIEW_SOURCE_INPUTS.map(name => [name, hash(readFileSync(join(nativeRoot, name)))])),
    packagingSha256: Object.fromEntries(paths.map(name => [name, hash(readFileSync(join(root, name)))])),
    compiler: { path: compilerPath, version: "explicit synthetic compiler", sha256: hash(readFileSync(compilerPath)) },
    sdk: { root: sdkRoot, settingsSha256: hash(readFileSync(join(sdkRoot, "SDKSettings.json"))) },
    headers: { root: headersRoot, sha256: Object.fromEntries(headerNames.map(name => [name, hash(readFileSync(join(headersRoot, name)))])) },
    runtime: { platform: "darwin", architecture: "arm64", electron: "44.5.1", node: "24.14.0", uv: "1.51.0" },
    signing: { profile: "unsigned_dev", mode: "adhoc", identifier: "com.ling-stack.office-local.native" },
    trust: "original_office_source_and_packaging_v1" };
  const reviewPath = join(nativeRoot, "reviewed-packaged-source-v1.json");
  writeFileSync(reviewPath, JSON.stringify(review));
  let signCalls = 0, verifyCalls = 0;
  const loader = registerHooks({ load(url, context, nextLoad) {
    if (url === pathToFileURL(join(nativeRoot, "scripts/build.mjs")).href) {
      return { format: "module", shortCircuit: true, source: `
        import { mkdirSync, writeFileSync } from "node:fs";
        import { join } from "node:path";
        import { createHash } from "node:crypto";
        const review = ${JSON.stringify(review)};
        export function buildNativeEvidence({output}) {
          mkdirSync(output); const bytes = Buffer.from("EXPLICIT SYNTHETIC UNSIGNED OFFICE ADDON");
          writeFileSync(join(output, "office-local.node"), bytes);
          return { schemaVersion:2,addon:"office-local",protocolVersion:2,napiVersion:8,deploymentTarget:"13.0",
            platform:"darwin",architecture:"arm64",compiler:review.compiler,sdk:review.sdk,headers:review.headers,
            sourceSha256:review.sourceSha256,binary:{sha256:createHash("sha256").update(bytes).digest("hex"),bytes:bytes.length},
            verification:{compilation:"passed"},scopeBinding:"unbound",coreSafe:false,packaged:false };
        }
      ` };
    }
    return nextLoad(url, context);
  } });
  t.after(() => loader.deregister());
  for (const [key, value] of [["platform", "darwin"], ["arch", "arm64"]]) {
    const original = Object.getOwnPropertyDescriptor(process, key);
    Object.defineProperty(process, key, { ...original, value });
    t.after(() => Object.defineProperty(process, key, original));
  }
  const mock = t.mock.method(childProcess, "spawnSync", (command, argv) => {
    assert.equal(command, "/usr/bin/codesign");
    if (argv[0] === "--force") {
      signCalls++;
      const path = argv.at(-1); writeFileSync(path, Buffer.concat([readFileSync(path), Buffer.from(":SYNTHETIC SIGN TRANSFORM")]));
    } else { assert.equal(argv[0], "--verify"); verifyCalls++; }
    return { status: 0, signal: null };
  });
  syncBuiltinESMExports();
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
  const api = await import(pathToFileURL(producerModule).href);
  const reviewApi = await import(pathToFileURL(reviewModule).href);
  return { root, api, reviewApi, review, reviewPath, paths, stage: join(root, "apps/desktop/dist/office-local"),
    counts: () => ({ signCalls, verifyCalls }) };
}

test("Office publication private origin and final-byte contracts (synthetic compiler/signature, not packaged validation)", async t => {
  await t.test("fixed review accepts its exact closure and rejects pending approval", async t => {
    const f = await fixture(t);
    assert.equal(Object.isFrozen(f.reviewApi.readReviewedPackagedOfficeSource().review.headers.sha256), true);
    f.review.approval = "pending"; writeFileSync(f.reviewPath, JSON.stringify(f.review));
    assert.throws(() => f.api.buildFreshPackagedOfficeNativePublication(), /source_review_invalid/u);
    assert.equal(f.counts().signCalls, 0);
  });
  await t.test("fake/clone/JSON tokens cannot select a build; signed bytes are pinned separately", async t => {
    const f = await fixture(t);
    for (const token of [{}, Object.freeze({}), Object.freeze({ review: f.review })]) {
      assert.throws(() => f.api.readOriginalPackagedOfficeNativePublication(token), /publication_invalid/u);
    }
    const token = f.api.buildFreshPackagedOfficeNativePublication(), value = f.api.readOriginalPackagedOfficeNativePublication(token);
    assert.deepEqual(Reflect.ownKeys(token), []); assert.equal(Object.isFrozen(value.sourceSha256), true);
    assert.notEqual(value.unsignedBinarySha256, value.finalBinarySha256);
    assert.equal(value.finalBinarySha256, hash(readFileSync(join(f.stage, "office-local.node"))));
    assert.equal(value.buildManifestSha256, hash(readFileSync(join(f.stage, "build-manifest.json"))));
    assert.deepEqual(f.counts(), { signCalls: 1, verifyCalls: 1 });
    assert.throws(() => f.api.readOriginalPackagedOfficeNativePublication(Object.freeze({ ...token })), /publication_invalid/u);
  });
  await t.test("a source or packaging input change does not auto-refresh review", async t => {
    const f = await fixture(t), token = f.api.buildFreshPackagedOfficeNativePublication();
    writeFileSync(join(f.root, f.paths[0]), "CHANGED PACKAGING CODE");
    assert.throws(() => f.api.readOriginalPackagedOfficeNativePublication(token), /source_review_invalid/u);
    assert.throws(() => f.api.buildFreshPackagedOfficeNativePublication(), /source_review_invalid/u);
    assert.equal(f.counts().signCalls, 1);
  });
  await t.test("mutation during stage publication is rejected before minting a token", async t => {
    const f = await fixture(t), rename = fsModule.renameSync;
    const mock = t.mock.method(fsModule, "renameSync", (from, to) => {
      rename(from, to);
      if (to === f.stage) writeFileSync(join(to, "office-local.node"), "MUTATION BETWEEN FINAL HASH AND PRIVATE PIN CAPTURE");
    });
    syncBuiltinESMExports();
    t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
    assert.throws(() => f.api.buildFreshPackagedOfficeNativePublication(), /publication_invalid/u);
  });
  await t.test("same-bytes replacement, mutated bytes, and extra staged leaves reject read-back", async t => {
    for (const mutation of ["replace", "write", "extra", "empty-directory"]) {
      await t.test(mutation, async t => {
        const f = await fixture(t), token = f.api.buildFreshPackagedOfficeNativePublication(), path = join(f.stage, "office-local.node");
        if (mutation === "replace") { const bytes = readFileSync(path); rmSync(path); writeFileSync(path, bytes); }
        else if (mutation === "write") writeFileSync(path, "OTHER FINAL BYTES");
        else if (mutation === "empty-directory") mkdirSync(join(f.stage, "foreign"));
        else writeFileSync(join(f.stage, "unreviewed.node"), "EXTRA");
        assert.throws(() => f.api.readOriginalPackagedOfficeNativePublication(token), /publication_invalid/u);
      });
    }
  });
  await t.test("new build retires old token without deleting the old generated stage", async t => {
    const f = await fixture(t), previous = f.api.buildFreshPackagedOfficeNativePublication();
    const current = f.api.buildFreshPackagedOfficeNativePublication();
    assert.notEqual(current, previous);
    assert.throws(() => f.api.readOriginalPackagedOfficeNativePublication(previous), /publication_invalid/u);
    assert.equal(f.api.readOriginalPackagedOfficeNativePublication(current).schemaVersion, 1);
  });
  await t.test("active hook origin survives await, rejects overlap/fresh replacement, and releases on failure", async t => {
    const f = await fixture(t), token = f.api.buildFreshPackagedOfficeNativePublication();
    assert.throws(() => f.api.readActiveOriginalPackagedOfficeNativePublication(), /publication_invalid/u);
    await f.api.withOriginalPackagedOfficeNativePublication(token, async () => {
      assert.equal(f.api.readActiveOriginalPackagedOfficeNativePublication().schemaVersion, 1);
      await Promise.resolve();
      assert.equal(f.api.readActiveOriginalPackagedOfficeNativePublication().schemaVersion, 1);
      await assert.rejects(f.api.withOriginalPackagedOfficeNativePublication(token, async () => {}), /publication_invalid/u);
      assert.throws(() => f.api.buildFreshPackagedOfficeNativePublication(), /publication_invalid/u);
    });
    assert.throws(() => f.api.readActiveOriginalPackagedOfficeNativePublication(), /publication_invalid/u);
    await assert.rejects(f.api.withOriginalPackagedOfficeNativePublication(token, async () => { throw Error("test-only builder failure"); }), /test-only builder failure/u);
    assert.throws(() => f.api.readActiveOriginalPackagedOfficeNativePublication(), /publication_invalid/u);
  });
  t.diagnostic("Explicit disposable test-only approved row and mocked compiler/codesign: green tests prove data/provenance/final-byte guards only. No production approval, actual signature, native compilation, Electron or GUI pass.");
});
