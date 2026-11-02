import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fsModule from "node:fs";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const script = fileURLToPath(new URL("../scripts/build-packaged-daemon.mjs", import.meta.url));
const sourceScript = fileURLToPath(new URL("../scripts/packaged-office-daemon-source-inputs.mjs", import.meta.url));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
let fixtureNumber = 0;
function newFile(path, bytes) { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); writeFileSync(path, bytes, { mode: 0o600 }); }

/** Real esbuild/source projection; native/codesign origin, review and external gstack selection are explicitly synthetic. */
async function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ling-office-emitted-test-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const modulePath = join(root, "apps/desktop/scripts/build-packaged-daemon.mjs");
  mkdirSync(dirname(modulePath), { recursive: true }); copyFileSync(script, modulePath);
  copyFileSync(sourceScript, join(dirname(modulePath), "packaged-office-daemon-source-inputs.mjs"));
  const runtime = join(root, "packages/daemon/dist/runtime/sandbox");
  const sourceRuntime = join(root, "packages/daemon/src/runtime/sandbox");
  const codesignModule = join(sourceRuntime, "packaged-codesign-published-review.ts");
  const officeModule = join(sourceRuntime, "packaged-office-native-published-review.ts");
  const codesignMarker = 'const embeddedPublishedReviewJson: string = "NO_PACKAGED_CODESIGN_REVIEW";';
  const officeMarker = 'const embeddedPublishedOfficeReviewJson: string = "NO_PACKAGED_OFFICE_NATIVE_REVIEW";';
  newFile(codesignModule, codesignMarker + "\nexport const codesign = embeddedPublishedReviewJson;\n");
  newFile(officeModule, officeMarker + "\nexport const office = embeddedPublishedOfficeReviewJson;\n");
  newFile(join(runtime, "packaged-codesign-published-review.js"), readFileSync(codesignModule, "utf8").replace(": string", ""));
  newFile(join(runtime, "packaged-office-native-published-review.js"), readFileSync(officeModule, "utf8").replace(": string", ""));
  const entry = join(root, "packages/daemon/dist/cli.js");
  newFile(entry, 'export { codesign } from "./runtime/sandbox/packaged-codesign-published-review.js";\n'
    + 'export { office } from "./runtime/sandbox/packaged-office-native-published-review.js";\n');
  const sourceEntry = join(root, "packages/daemon/src/cli.ts");
  newFile(sourceEntry, readFileSync(entry));
  const sourceFiles = [sourceEntry, codesignModule, officeModule];
  for (const name of ["browser-host", "contracts", "core", "daemon", "localization", "plugin-sdk", "providers", "remote-protocol", "runner-pi"]) {
    const packagePath = join(root, "packages", name, "package.json"), configPath = join(root, "packages", name, "tsconfig.json");
    newFile(packagePath, JSON.stringify({ name: "@ling-stack/" + name, type: "module", main: "./dist/index.js" }));
    newFile(configPath, JSON.stringify({ compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", target: "ES2022",
      outDir: "dist", rootDir: "src", strict: true }, include: ["src/**/*.ts"] }));
    sourceFiles.push(packagePath, configPath);
  }
  const sourceReviewSha256 = hash("EXPLICIT SYNTHETIC REVIEW (not production approval)");
  const sourceReview = Object.freeze({ sourceReviewSha256, review: Object.freeze({ packagingSha256: Object.freeze(
    Object.fromEntries(sourceFiles.map(path => [path.slice(root.length + 1), hash(readFileSync(path))]))) }) });
  const cliPath = join(root, "apps/desktop/dist/daemon/cli.mjs");
  const token = Object.freeze({ synthetic: "original native token" });
  const publication = Object.freeze({ synthetic: "native publication (not approval)", sourceReviewSha256, uniqueFixture: ++fixtureNumber });
  const codesignToken = Object.freeze({ synthetic: "codesign token" });
  const codesign = Object.freeze({ synthetic: "codesign publication (not approval)" });
  const state = { active: publication, original: publication, token, publication, codesignToken, codesign, sourceReview,
    nativeBuilds: 0, codesignBuilds: 0, buildCompleted: false, builds: [], outputs: [], afterBuild: undefined, afterOriginalRead: undefined,
    gstackPreparations: [],
    readOriginal(receipt) {
      if (receipt !== token || !state.original) throw new Error("synthetic_original_token_invalid");
      state.afterOriginalRead?.(); return state.original;
    },
    async build(options) {
      state.builds.push(options);
      const result = await build({ ...options, logLevel: "silent" });
      state.outputs.push(result.outputFiles?.map(file => Buffer.from(file.contents)));
      state.buildCompleted = true; state.afterBuild?.(result); return result;
    },
  };
  const symbolName = "ling.office.emitted.synthetic." + fixtureNumber, symbol = Symbol.for(symbolName);
  globalThis[symbol] = state; t.after(() => { delete globalThis[symbol]; });
  const url = pathToFileURL(modulePath).href;
  const bridge = `const state = globalThis[Symbol.for(${JSON.stringify(symbolName)})];\n`;
  const sources = new Map([
    ["esbuild", bridge + "export const build = (...args) => state.build(...args);"],
    ["./build-packaged-office-native.mjs", bridge + `
      export function buildFreshPackagedOfficeNativePublication() { state.nativeBuilds++; state.active = state.publication; return state.token; }
      export function readOriginalPackagedOfficeNativePublication(receipt) { return state.readOriginal(receipt); }
      export function readActiveOriginalPackagedOfficeNativePublication() { return state.active; }`],
    ["./build-restricted-command-helper.mjs", bridge + `
      export function buildFreshRestrictedCommandHelperPublication() { state.codesignBuilds++; return state.codesignToken; }
      export function readOriginalRestrictedCommandBuildPublication(receipt) {
        if (receipt !== state.codesignToken) throw new Error("synthetic_codesign_token_invalid"); return state.codesign;
      }`],
    ["./packaged-office-native-review.mjs", bridge + "export function readReviewedPackagedOfficeSource() { return state.sourceReview; }"],
    ["./packaged-gstack-resources.mjs", bridge + `
      export async function preparePackagedGstackBuild(options) { state.gstackPreparations.push(options); return undefined; }
      export function packagedGstackIdentityPlugin({ identity }) {
        if (identity !== undefined) throw new Error("synthetic_gstack_identity_unexpected");
        return { plugin: { name: "synthetic-gstack-identity", setup() {} }, assertIncluded() {} };
      }`],
  ]);
  const loader = registerHooks({ resolve(specifier, context, nextResolve) {
    if ([url, pathToFileURL(join(dirname(modulePath), "packaged-office-daemon-source-inputs.mjs")).href].includes(context.parentURL)
      && sources.has(specifier))
      return { shortCircuit: true, url: "data:text/javascript," + encodeURIComponent(sources.get(specifier)) };
    return nextResolve(specifier, context);
  } });
  t.after(() => loader.deregister());
  for (const [name, value] of [["platform", "darwin"], ["arch", "arm64"]]) {
    const original = Object.getOwnPropertyDescriptor(process, name);
    Object.defineProperty(process, name, { ...original, value });
    t.after(() => Object.defineProperty(process, name, original));
  }
  const priorIntent = process.env.LING_PACKAGED_CODESIGN_REVIEW_REQUIRED;
  delete process.env.LING_PACKAGED_CODESIGN_REVIEW_REQUIRED;
  t.after(() => { if (priorIntent === undefined) delete process.env.LING_PACKAGED_CODESIGN_REVIEW_REQUIRED;
    else process.env.LING_PACKAGED_CODESIGN_REVIEW_REQUIRED = priorIntent; });
  return { root, api: await import(url), state, publication, token, entry: sourceEntry, cliPath, officeModule, officeMarker, codesignModule, codesignMarker };
}

test("Office emitted CLI pins: real esbuild, synthetic publication/signature, not macOS package acceptance", async t => {
  await t.test("original emitted bytes cannot be adopted from a modified post-build path", async t => {
    const f = await fixture(t), replacement = Buffer.from("FOREIGN CLI: NO_PACKAGED_OFFICE_NATIVE_REVIEW\n");
    let injected = false;
    f.state.afterOriginalRead = () => {
      if (f.state.buildCompleted && !injected) { injected = true; newFile(f.cliPath, replacement); }
    };
    let rejected = false;
    try { await f.api.buildFreshPackagedDaemonForMacOffice(); }
    catch { rejected = true; }
    if (!rejected) assert.notEqual(f.api.readActiveOriginalPackagedOfficeDaemonBundle().sha256, hash(replacement),
      "a late foreign path snapshot must never become original emitted pins");
    assert.equal(injected, true);
    if (!rejected) assert.deepEqual(readFileSync(f.cliPath), f.state.outputs[0][0]);
  });
  await t.test("only private exact active identity yields frozen byte pins for the actual CLI", async t => {
    const f = await fixture(t);
    assert.throws(() => f.api.readActiveOriginalPackagedOfficeDaemonBundle(), /emitted_bundle_invalid/u);
    assert.equal(await f.api.buildFreshPackagedDaemonForMacOffice(), f.token);
    const pins = f.api.readActiveOriginalPackagedOfficeDaemonBundle();
    assert.equal(Object.isFrozen(pins), true); assert.equal(Object.isFrozen(pins.identity), true);
    assert.equal(pins.evidenceKind, "original_emitted_cli_byte_pins_only"); assert.equal(pins.path, f.cliPath);
    assert.equal(pins.sizeBytes, readFileSync(f.cliPath).length); assert.equal(pins.sha256, hash(readFileSync(f.cliPath)));
    assert.deepEqual(readFileSync(f.cliPath), f.state.outputs[0][0]); assert.equal(f.state.builds[0].write, false);
    assert.deepEqual(f.state.gstackPreparations, [{ required: true }]);
    assert.doesNotMatch(readFileSync(f.cliPath, "utf8"), /NO_PACKAGED_(?:OFFICE_NATIVE|CODESIGN)_REVIEW/u);
    assert.equal("bytes" in pins, false); assert.equal("token" in pins, false); assert.equal("authority" in pins, false);
    assert.equal(f.api.readActiveOriginalPackagedOfficeDaemonBundle.length, 0);
    for (const active of [undefined, Object.freeze({ ...f.publication }), JSON.stringify(f.publication)]) {
      f.state.active = active; assert.throws(() => f.api.readActiveOriginalPackagedOfficeDaemonBundle(), /emitted_bundle_invalid/u);
    }
    f.state.active = f.publication;
    assert.equal(f.api.readActiveOriginalPackagedOfficeDaemonBundle(), pins);
    f.state.original = undefined;
    assert.throws(() => f.api.readActiveOriginalPackagedOfficeDaemonBundle(), /synthetic_original_token_invalid/u);
  });
  for (const replacement of ["changed bytes", "same bytes new inode"]) {
    await t.test(replacement + " cannot refresh the original emitted record", async t => {
      const f = await fixture(t); await f.api.buildFreshPackagedDaemonForMacOffice();
      const pins = f.api.readActiveOriginalPackagedOfficeDaemonBundle();
      if (replacement === "changed bytes") writeFileSync(f.cliPath, Buffer.alloc(pins.sizeBytes, 88));
      else { const next = join(f.root, "replacement.mjs"); newFile(next, readFileSync(f.cliPath)); renameSync(next, f.cliPath); }
      assert.throws(() => f.api.readActiveOriginalPackagedOfficeDaemonBundle(), /emitted_bundle_invalid/u);
    });
  }
  await t.test("ordinary dev bundle never creates pins and cannot leave an old Office record usable", async t => {
    const f = await fixture(t); await f.api.buildPackagedDaemon();
    assert.equal(f.state.nativeBuilds, 0); assert.equal(f.state.codesignBuilds, 0);
    assert.throws(() => f.api.readActiveOriginalPackagedOfficeDaemonBundle(), /emitted_bundle_invalid/u);
    await f.api.buildFreshPackagedDaemonForMacOffice(); await f.api.buildPackagedDaemon();
    assert.throws(() => f.api.readActiveOriginalPackagedOfficeDaemonBundle(), /emitted_bundle_invalid/u);
  });
  await t.test("existing dist/daemon directories and repeat real Office build are accepted without re-mkdir", async t => {
    const f = await fixture(t); mkdirSync(dirname(f.cliPath), { recursive: true, mode: 0o700 });
    for (let index = 0; index < 2; index++) {
      await f.api.buildFreshPackagedDaemonForMacOffice();
      assert.deepEqual(readFileSync(f.cliPath), f.state.outputs[index][0]);
      assert.equal(f.api.readActiveOriginalPackagedOfficeDaemonBundle().sha256, hash(f.state.outputs[index][0]));
    }
    assert.deepEqual(readdirSync(dirname(f.cliPath)), ["cli.mjs"]);
  });
  await t.test("linked output parent is not followed by the fixed Office publication", async t => {
    const f = await fixture(t), foreign = join(f.root, "foreign-dist");
    mkdirSync(foreign); symlinkSync(foreign, join(f.root, "apps/desktop/dist"));
    await assert.rejects(f.api.buildFreshPackagedDaemonForMacOffice(), /emitted_bundle_invalid/u);
    assert.deepEqual(readdirSync(foreign), []);
  });
  for (const invalid of ["no output", "multiple outputs", "wrong path", "empty bytes", "oversized bytes"]) {
    await t.test(invalid + " from the esbuild API cannot mint original pins", async t => {
      const f = await fixture(t);
      f.state.afterBuild = result => {
        if (invalid === "no output") result.outputFiles = [];
        else if (invalid === "multiple outputs") result.outputFiles.push(result.outputFiles[0]);
        else if (invalid === "wrong path") result.outputFiles[0].path += ".foreign";
        else result.outputFiles[0].contents = new Uint8Array(invalid === "empty bytes" ? 0 : 64 * 1024 * 1024 + 1);
      };
      await assert.rejects(f.api.buildFreshPackagedDaemonForMacOffice(), /emitted_bundle_invalid/u);
      assert.throws(() => f.api.readActiveOriginalPackagedOfficeDaemonBundle(), /emitted_bundle_invalid/u);
    });
  }
  await t.test("interrupted bounded staging write cleans only its original temporary file and releases the bundle lock", async t => {
    const f = await fixture(t);
    const mock = t.mock.method(fsModule, "writeSync", () => 0); syncBuiltinESMExports();
    t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
    await assert.rejects(f.api.buildFreshPackagedDaemonForMacOffice(), /emitted_bundle_invalid/u);
    assert.deepEqual(readdirSync(dirname(f.cliPath)), []);
    assert.throws(() => f.api.readActiveOriginalPackagedOfficeDaemonBundle(), /emitted_bundle_invalid/u);
    mock.mock.restore(); syncBuiltinESMExports();
    await f.api.buildFreshPackagedDaemonForMacOffice();
    assert.equal(f.api.readActiveOriginalPackagedOfficeDaemonBundle().sha256, hash(readFileSync(f.cliPath)));
  });
  for (const kind of ["zero write and cleanup Error", "null primary and undefined cleanup", "undefined primary and null cleanup"]) {
    await t.test(kind + " retains both failures and still releases the bundle lock", async t => {
      const f = await fixture(t), zeroWrite = kind.startsWith("zero");
      const primary = kind.startsWith("null") ? null : undefined;
      const cleanup = zeroWrite ? new Error("SYNTHETIC UNLINK REFUSAL") : kind.startsWith("null") ? undefined : null;
      const writeMock = t.mock.method(fsModule, "writeSync", () => { if (zeroWrite) return 0; throw primary; });
      const unlinkMock = t.mock.method(fsModule, "unlinkSync", () => { throw cleanup; });
      function restore() { writeMock.mock.restore(); unlinkMock.mock.restore(); syncBuiltinESMExports(); }
      syncBuiltinESMExports(); t.after(restore);
      await assert.rejects(f.api.buildFreshPackagedDaemonForMacOffice(), error => error instanceof AggregateError
        && error.errors.length === 2 && (zeroWrite ? /emitted_bundle_invalid/u.test(error.errors[0]?.message) : error.errors[0] === primary)
        && error.errors[1] === cleanup);
      assert.throws(() => f.api.readActiveOriginalPackagedOfficeDaemonBundle(), /emitted_bundle_invalid/u);
      restore();
      for (const name of readdirSync(dirname(f.cliPath))) {
        assert.match(name, /^\.office-daemon-next-[a-f0-9-]+\.mjs$/u); rmSync(join(dirname(f.cliPath), name));
      }
      await f.api.buildFreshPackagedDaemonForMacOffice();
      assert.equal(f.api.readActiveOriginalPackagedOfficeDaemonBundle().sha256, hash(readFileSync(f.cliPath)));
    });
  }
  await t.test("failed write cannot delete a replaced temporary inode, and both causes are retained", async t => {
    const f = await fixture(t), originalOpen = fsModule.openSync, originalUnlink = fsModule.unlinkSync;
    const foreign = join(f.root, "foreign-temp"); newFile(foreign, "FOREIGN INODE: DO NOT DELETE");
    let temporary, unlinkCalls = 0;
    const openMock = t.mock.method(fsModule, "openSync", (...args) => {
      const fd = originalOpen(...args); if (String(args[0]).includes(".office-daemon-next-")) temporary = args[0]; return fd;
    });
    const writeMock = t.mock.method(fsModule, "writeSync", () => {
      renameSync(foreign, temporary); return 0;
    });
    const unlinkMock = t.mock.method(fsModule, "unlinkSync", (...args) => { unlinkCalls++; return originalUnlink(...args); });
    function restore() { openMock.mock.restore(); writeMock.mock.restore(); unlinkMock.mock.restore(); syncBuiltinESMExports(); }
    syncBuiltinESMExports(); t.after(restore);
    await assert.rejects(f.api.buildFreshPackagedDaemonForMacOffice(), error => error instanceof AggregateError
      && error.errors.length === 2 && error.errors.every(cause => /emitted_bundle_invalid/u.test(cause?.message)));
    assert.equal(readFileSync(temporary, "utf8"), "FOREIGN INODE: DO NOT DELETE"); assert.equal(unlinkCalls, 0);
    restore(); await f.api.buildFreshPackagedDaemonForMacOffice();
    assert.equal(f.api.readActiveOriginalPackagedOfficeDaemonBundle().sha256, hash(readFileSync(f.cliPath)));
  });
  for (const invalid of ["missing Office marker", "duplicate Office marker", "wrong review module", "Office module not visited", "interrupted esbuild"]) {
    await t.test(invalid + " cannot publish an emitted record", async t => {
      const f = await fixture(t);
      if (invalid === "missing Office marker") writeFileSync(f.officeModule, 'export const office = "FOREIGN";\n');
      else if (invalid === "duplicate Office marker") writeFileSync(f.officeModule, f.officeMarker + "\n" + f.officeMarker);
      else if (invalid === "wrong review module") {
        const foreign = join(f.root, "packages/daemon/dist/foreign/packaged-office-native-published-review.js");
        newFile(foreign, readFileSync(f.officeModule));
        writeFileSync(f.entry, 'export { office } from "./foreign/packaged-office-native-published-review.js";\n');
      } else if (invalid === "Office module not visited") writeFileSync(f.entry,
        'export { codesign } from "./runtime/sandbox/packaged-codesign-published-review.js";\n');
      else writeFileSync(f.entry, "export const syntactically invalid [\n");
      await assert.rejects(f.api.buildFreshPackagedDaemonForMacOffice());
      assert.throws(() => f.api.readActiveOriginalPackagedOfficeDaemonBundle(), /emitted_bundle_invalid/u);
    });
  }
  await t.test("overlapping bundle is rejected before invoking another native or codesign publisher", async t => {
    const f = await fixture(t), first = f.api.buildFreshPackagedDaemonForMacOffice();
    await assert.rejects(f.api.buildFreshPackagedDaemonForMacOffice(), /bundle_busy/u);
    await first;
    assert.equal(f.state.nativeBuilds, 1); assert.equal(f.state.codesignBuilds, 1);
    assert.equal(f.api.readActiveOriginalPackagedOfficeDaemonBundle().sha256, hash(readFileSync(f.cliPath)));
  });
  t.diagnostic("Real esbuild/source projection and disposable inputs only; synthetic source review, original native/codesign readers and external gstack selection/identity. These output custody contracts do not replace the real source-review integration, gstack resource/identity validation, real signatures, Electron, ZIP/DMG, or packaged acceptance.");
});
