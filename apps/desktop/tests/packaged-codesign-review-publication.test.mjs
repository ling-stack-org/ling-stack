import assert from "node:assert/strict";
import test from "node:test";
import childProcess from "node:child_process";
import os from "node:os";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const desktopRoot = realpathSync(fileURLToPath(new URL("../", import.meta.url)));
const nativeRoot = resolve(desktopRoot, "../../native/sandbox");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
async function fixture(t, { hostRelease } = {}) {
  const root = realpathSync(mkdtempSync("/private/tmp/ling-codesign-publication-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scripts = join(root, "apps/desktop/scripts"), dist = join(root, "apps/desktop/dist");
  mkdirSync(scripts, { recursive: true }); mkdirSync(dist);
  const review = JSON.parse(readFileSync(join(nativeRoot, "reviewed-codesign-source-v1.json"), "utf8"));
  const releaseMock = t.mock.method(os, "release", () => hostRelease ?? review.os.release);
  t.after(() => { releaseMock.mock.restore(); syncBuiltinESMExports(); });
  const fixtureNative = join(root, "native/sandbox"); mkdirSync(fixtureNative, { recursive: true });
  for (const path of Object.keys(review.sourceSha256)) {
    const output = join(fixtureNative, path); mkdirSync(dirname(output), { recursive: true });
    copyFileSync(join(nativeRoot, path), output);
  }
  const reviewPath = join(fixtureNative, "reviewed-codesign-source-v1.json");
  writeFileSync(reviewPath, JSON.stringify(review));
  for (const name of ["packaged-codesign-review-publication.mjs", "build-restricted-command-helper.mjs"]) {
    copyFileSync(join(desktopRoot, "scripts", name), join(scripts, name));
  }
  const nativeModuleUrl = pathToFileURL(join(fixtureNative, "scripts/build.mjs")).href;
  const fixtureNativeSource = String.raw`
    import { mkdirSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    import { createHash } from "node:crypto";
    export function buildNativeEvidence({target, output}) {
      mkdirSync(output); mkdirSync(join(output, "licenses"));
      const bytes = Buffer.from("SYNTHETIC NORMALIZED HELPER:LINKER-SIGNATURE");
      writeFileSync(join(output, "ling-sandbox-runner"), bytes);
      writeFileSync(join(output, "licenses", "notice.txt"), "fixture notice");
      const sourceSha256 = FIXTURE_SOURCES;
      return { schemaVersion:1, helperName:"ling-sandbox-runner", helperVersion:"publication-simulation-v1",
        target, host:target, toolchain:"1.97.1", sourceSha256,
        verification:{format:"passed",releaseBuild:"passed",inputCapture:"passed"},
        fixedCodesignLeaf:{parserProtocol:"passed"},
        binary:{filename:"ling-sandbox-runner",sha256:createHash("sha256").update(bytes).digest("hex"),sizeBytes:bytes.length} };
    }
  `.replace("FIXTURE_SOURCES", JSON.stringify(review.sourceSha256));
  let freshCalls = 0, signingCalls = 0;
  const loader = registerHooks({ load(url, context, nextLoad) {
    if (url === nativeModuleUrl) { freshCalls++; return { format: "module", source: fixtureNativeSource, shortCircuit: true }; }
    return nextLoad(url, context);
  } });
  t.after(() => loader.deregister());
  for (const [key, value] of [["platform", "darwin"], ["arch", "arm64"]]) {
    const original = Object.getOwnPropertyDescriptor(process, key);
    Object.defineProperty(process, key, { ...original, value });
    t.after(() => Object.defineProperty(process, key, original));
  }
  const mock = t.mock.method(childProcess, "spawnSync", (command, args) => {
    assert.equal(command, "/usr/bin/codesign"); assert.equal(args[0], "--remove-signature"); signingCalls++;
    const before = readFileSync(args[1]);
    assert.ok(before.toString("utf8").endsWith(":LINKER-SIGNATURE"));
    writeFileSync(args[1], before.subarray(0, before.length - ":LINKER-SIGNATURE".length));
    return { status: 0, signal: null, stdout: "", stderr: "" };
  });
  syncBuiltinESMExports();
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
  const api = await import(pathToFileURL(join(scripts, "build-restricted-command-helper.mjs")).href);
  return { root, review, reviewPath, api, stagedRoot: join(dist, "restricted-command"),
    counts: () => ({ freshCalls, signingCalls }) };
}
test("same-process original trusted build receipt (explicit synthetic builder, no compile/signature)", async t => {
  await t.test("ordinary caller tokens and self-created staged manifests cannot mint a publication", async t => {
    const f = await fixture(t);
    mkdirSync(f.stagedRoot);
    writeFileSync(join(f.stagedRoot, "ling-sandbox-runner"), "caller helper");
    writeFileSync(join(f.stagedRoot, "manifest.json"), JSON.stringify({ sourceSha256: f.review.sourceSha256, binary: { sha256: hash("caller helper") } }));
    for (const fake of [{}, Object.freeze({}), Object.freeze({ manifest: {} })]) {
      assert.throws(() => f.api.readOriginalRestrictedCommandBuildPublication(fake), /package_build_invalid/u);
    }
    assert.deepEqual(f.counts(), { freshCalls: 1, signingCalls: 0 }); // Module load, no build invocation/normalizer.
  });
  await t.test("only fixed fresh pipeline returns its private receipt and stale dist is replaced", async t => {
    const f = await fixture(t);
    mkdirSync(f.stagedRoot);
    writeFileSync(join(f.stagedRoot, "ling-sandbox-runner"), "untrusted stale bytes");
    writeFileSync(join(f.stagedRoot, "manifest.json"), "{}");
    const token = f.api.buildFreshRestrictedCommandHelperPublication(), value = f.api.readOriginalRestrictedCommandBuildPublication(token);
    assert.equal(Object.isFrozen(token), true); assert.deepEqual(Reflect.ownKeys(token), []);
    assert.equal(value.unsignedBinarySha256, hash(readFileSync(join(f.stagedRoot, "ling-sandbox-runner"))));
    assert.equal(value.manifestSha256, hash(readFileSync(join(f.stagedRoot, "manifest.json"))));
    assert.deepEqual(f.counts(), { freshCalls: 1, signingCalls: 1 });
    assert.throws(() => f.api.readOriginalRestrictedCommandBuildPublication(Object.freeze({ ...token })), /package_build_invalid/u);
  });
  await t.test("changing real generated artifact after private receipt rejects read-back", async t => {
    const f = await fixture(t), token = f.api.buildFreshRestrictedCommandHelperPublication();
    writeFileSync(join(f.stagedRoot, "ling-sandbox-runner"), "different normalized helper");
    assert.throws(() => f.api.readOriginalRestrictedCommandBuildPublication(token), /package_build_invalid/u);
  });
  await t.test("a prior owned receipt cannot authorize a replacement fresh build", async t => {
    const f = await fixture(t), prior = f.api.buildFreshRestrictedCommandHelperPublication();
    const current = f.api.buildFreshRestrictedCommandHelperPublication();
    assert.notEqual(prior, current);
    assert.throws(() => f.api.readOriginalRestrictedCommandBuildPublication(prior), /package_build_invalid/u);
    assert.equal(f.api.readOriginalRestrictedCommandBuildPublication(current).schemaVersion, 1);
    assert.equal(f.counts().signingCalls, 2);
  });
  await t.test("pending source review does not auto-approve itself or call normalizer", async t => {
    const f = await fixture(t);
    f.review.approval = "pending"; writeFileSync(f.reviewPath, JSON.stringify(f.review));
    assert.throws(() => f.api.buildFreshRestrictedCommandHelperPublication(), /build_review_invalid/u);
    assert.equal(f.counts().signingCalls, 0);
  });
  await t.test("each exact reviewed OS builds a descriptor bound to just that tuple", async t => {
    const current = JSON.parse(readFileSync(join(nativeRoot, "reviewed-codesign-source-v1.json"), "utf8"));
    for (const selected of [current.os, ...current.additionalOs]) {
      await t.test(selected.release, async t => {
        const f = await fixture(t, { hostRelease: selected.release });
        const token = f.api.buildFreshRestrictedCommandHelperPublication();
        const descriptor = f.api.readOriginalRestrictedCommandBuildPublication(token);
        assert.deepEqual(descriptor.os, selected);
        assert.equal(descriptor.schemaVersion, 1);
        assert.equal(descriptor.sourceReviewSha256, hash(readFileSync(f.reviewPath)));
        assert.equal(Object.hasOwn(descriptor, "additionalOs"), false);
      });
    }
  });
  await t.test("an unknown OS fails before the fresh builder or normalizer runs", async t => {
    const f = await fixture(t, { hostRelease: "99.0.0" });
    assert.throws(() => f.api.buildFreshRestrictedCommandHelperPublication(), /package_build_invalid/u);
    assert.deepEqual(f.counts(), { freshCalls: 1, signingCalls: 0 });
    assert.equal(existsSync(f.stagedRoot), false);
  });
  await t.test("legacy single-OS source reviews keep their original descriptor contract", async t => {
    const f = await fixture(t);
    f.review.schemaVersion = 1;
    delete f.review.additionalOs;
    writeFileSync(f.reviewPath, JSON.stringify(f.review));
    const token = f.api.buildFreshRestrictedCommandHelperPublication();
    assert.deepEqual(f.api.readOriginalRestrictedCommandBuildPublication(token).os, f.review.os);
  });
  for (const mutation of ["duplicate", "unknown-field", "invalid-unselected"]) {
    await t.test(`all OS rows are validated before selection: ${mutation}`, async t => {
      const f = await fixture(t);
      if (mutation === "duplicate") f.review.additionalOs = [{ ...f.review.os }];
      if (mutation === "unknown-field") f.review.additionalOs[0].unknown = true;
      if (mutation === "invalid-unselected") f.review.additionalOs[0].codesignSha256 = "invalid";
      writeFileSync(f.reviewPath, JSON.stringify(f.review));
      assert.throws(() => f.api.buildFreshRestrictedCommandHelperPublication(), /build_review_invalid/u);
      assert.equal(f.counts().signingCalls, 0);
    });
  }
  t.diagnostic("The loader replaces only the native builder in a disposable fixture and the normalizer is explicitly mocked. It tests private same-process origin, source binding and read-back, not native compilation, a real signature, Host certification or packaged GUI.");
});
