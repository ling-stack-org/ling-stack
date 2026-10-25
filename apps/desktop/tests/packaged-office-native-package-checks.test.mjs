import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fsModule from "node:fs";
import {
  chmodSync, cpSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync,
  renameSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createPackageWithOptions } from "@electron/asar";
import { OFFICE_LOCAL_NATIVE_REVIEW_SOURCE_INPUTS } from "../../../packages/daemon/src/runtime/sandbox/packaged-office-native-published-review.ts";

const scriptPath = fileURLToPath(new URL("../scripts/packaged-office-native-package-checks.mjs", import.meta.url));
const hash = value => createHash("sha256").update(value).digest("hex");
let fixtureNumber = 0;

function newFile(path, bytes) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, bytes, { mode: 0o600 });
}

/** Real local ASAR; synthetic original readers/extractor/signer. No native build or signature. */
async function fixture(t) {
  const number = ++fixtureNumber, root = realpathSync(mkdtempSync(join(tmpdir(), "ling-office-package-checks-test-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const productFilename = "Ling [Proof].1", appOutDir = join(root, "output");
  const appPath = join(appOutDir, productFilename + ".app");
  const officeRoot = join(appPath, "Contents/Resources/office-local");
  const binaryPath = join(officeRoot, "office-local.node"), manifestPath = join(officeRoot, "build-manifest.json");
  const binary = Buffer.from("EXPLICIT SYNTHETIC FINAL SIGNED OFFICE BYTES");
  newFile(binaryPath, binary); newFile(manifestPath, "SYNTHETIC MANIFEST: byte pin only, not approval");
  const sourceSha256 = {};
  for (const name of OFFICE_LOCAL_NATIVE_REVIEW_SOURCE_INPUTS) {
    const bytes = Buffer.from("EXPLICIT SYNTHETIC SOURCE:" + name);
    newFile(join(officeRoot, "source", name), bytes); sourceSha256[name] = hash(bytes);
  }
  const descriptor = Object.freeze({
    finalBinarySha256: hash(binary), finalBinarySizeBytes: binary.length,
    buildManifestSha256: hash(readFileSync(manifestPath)), sourceSha256: Object.freeze(sourceSha256),
  });
  const cliBytes = Buffer.from("EXPLICIT TEST-ONLY ORIGINAL EMITTED CLI\n");
  const cliPins = Object.freeze({ sizeBytes: cliBytes.length, sha256: hash(cliBytes) });
  const asarSource = join(root, "asar-source"), asarPath = join(appPath, "Contents/Resources/app.asar");
  newFile(join(asarSource, "dist/daemon/cli.mjs"), cliBytes);
  await createPackageWithOptions(asarSource, asarPath, {});
  const context = { electronPlatformName: "darwin", appOutDir, packager: {
    platform: { nodeName: "darwin" }, appInfo: { productFilename }, platformSpecificBuildOptions: {},
  } };
  const signatureCalls = [], extractionCalls = [];
  const state = { active: descriptor, activeReads: 0, cleanupCalls: 0, cliPins,
    signature(command, args, options, callback) {
      signatureCalls.push({ command, args, options });
      callback(null, "", "");
    },
    async extractor(file, extractionContext) {
      extractionCalls.push({ file, context: extractionContext });
      return { artifactRoot: state.extractionRoot, async cleanup() { state.cleanupCalls++; } };
    },
  };
  const symbolName = "ling.office.package-checks.synthetic." + number;
  const symbol = Symbol.for(symbolName);
  globalThis[symbol] = state;
  t.after(() => { delete globalThis[symbol]; });
  const apiUrl = pathToFileURL(scriptPath).href + "?synthetic=" + number;
  const asarApiUrl = new URL("../scripts/packaged-office-native-asar-checks.mjs", import.meta.url).href + "?synthetic=" + number;
  const bridge = `const state = globalThis[Symbol.for(${JSON.stringify(symbolName)})];\n`;
  const sources = new Map([
    ["./build-packaged-office-native.mjs", bridge + "export function readActiveOriginalPackagedOfficeNativePublication() { state.activeReads++; return state.active; }"],
    ["./build-packaged-daemon.mjs", bridge + "export function readActiveOriginalPackagedOfficeDaemonBundle() { return state.cliPins; }"],
    ["./cua-driver-signing/final-artifact-extractor.mjs", bridge + "export function extractCuaDriverFinalArtifact(...args) { return state.extractor(...args); }"],
    ["node:child_process", bridge + "export function execFile(...args) { return state.signature(...args); }"],
  ]);
  const loader = registerHooks({ resolve(specifier, context, nextResolve) {
    if (context.parentURL === apiUrl && specifier === "./packaged-office-native-asar-checks.mjs")
      return { shortCircuit: true, url: asarApiUrl };
    if ([apiUrl, asarApiUrl].includes(context.parentURL) && sources.has(specifier)) {
      return { shortCircuit: true, url: "data:text/javascript," + encodeURIComponent(sources.get(specifier)) };
    }
    return nextResolve(specifier, context);
  } });
  t.after(() => loader.deregister());
  const api = await import(apiUrl);
  function artifact(kind, name = kind) {
    const file = join(root, name + "." + kind), extractionRoot = join(root, "extracted-" + name);
    newFile(file, "SYNTHETIC " + kind + " container, not a real archive");
    mkdirSync(extractionRoot, { mode: 0o700 });
    cpSync(appPath, join(extractionRoot, productFilename + ".app"), { recursive: true });
    state.extractionRoot = extractionRoot;
    return { event: { file, target: { name: kind }, packager: context.packager }, extractionRoot,
      appPath: join(extractionRoot, productFilename + ".app") };
  }
  return { root, api, state, descriptor, context, appPath, officeRoot, binaryPath, manifestPath, asarSource, asarPath, cliBytes,
    signatureCalls, extractionCalls, productFilename, artifact };
}

test("Office hooks load the authored review contract, never generated Daemon dist", async t => {
  const loader = registerHooks({ resolve(specifier, context, nextResolve) {
    if (context.parentURL && new URL(context.parentURL).pathname === scriptPath
      && specifier.includes("/packages/daemon/dist/")) {
      throw new Error("explicit_test_only_generated_review_contract_refused");
    }
    return nextResolve(specifier, context);
  } });
  t.after(() => loader.deregister());
  const f = await fixture(t);
  assert.equal(typeof f.api.verifyOriginalOfficeCopyInApp, "function");
  assert.equal(f.signatureCalls.length, 0);
  assert.equal(f.extractionCalls.length, 0);
});

test("Office package checks: synthetic active reader/signer/extractor, NOT real packaged validation", async t => {
  await t.test("actual local ASAR rejects stale packaged CLI instead of accepting only Office resources", async t => {
    const f = await fixture(t), source = join(f.root, "asar-source");
    newFile(join(source, "dist/daemon/cli.mjs"), "STALE CLI: NO_PACKAGED_OFFICE_NATIVE_REVIEW\n");
    await createPackageWithOptions(source, join(f.appPath, "Contents/Resources/app.asar"), {});
    assert.throws(() => f.api.verifyOriginalOfficeCopyInApp(f.appPath), /copy_invalid/u);
  });
  await t.test("actual local ASAR rejects an Office addon copied under another subtree", async t => {
    const f = await fixture(t), source = join(f.root, "asar-source");
    newFile(join(source, "dist/daemon/cli.mjs"), "EXPLICIT TEST-ONLY ORIGINAL EMITTED CLI\n");
    newFile(join(source, "foreign/native/office-local.node"), readFileSync(f.binaryPath));
    await createPackageWithOptions(source, join(f.appPath, "Contents/Resources/app.asar"), {});
    assert.throws(() => f.api.verifyOriginalOfficeCopyInApp(f.appPath), /copy_invalid/u);
  });
  await t.test("exact fixed stage and 15 sources yield frozen build-only pins", async t => {
    const f = await fixture(t), result = f.api.verifyOriginalOfficeCopyInApp(f.appPath);
    assert.equal(Object.isFrozen(result), true);
    assert.equal(result.evidenceKind, "build_byte_pins_only");
    assert.equal(result.appPath, f.appPath); assert.equal(result.binaryPath, f.binaryPath);
    assert.equal(result.finalBinarySha256, f.descriptor.finalBinarySha256);
    assert.equal(result.finalBinarySizeBytes, f.descriptor.finalBinarySizeBytes);
    assert.equal(result.buildManifestSha256, f.descriptor.buildManifestSha256);
    assert.equal("authority" in result, false); assert.equal("signed" in result, false);
    assert.equal(f.state.activeReads, 4); assert.equal(f.signatureCalls.length, 0);
  });

  const mutations = {
    "extra stage leaf": f => newFile(join(f.officeRoot, "other.node"), "EXTRA"),
    "extra empty stage directory": f => mkdirSync(join(f.officeRoot, "foreign")),
    "missing manifest": f => rmSync(f.manifestPath),
    "missing source": f => rmSync(join(f.officeRoot, "source", OFFICE_LOCAL_NATIVE_REVIEW_SOURCE_INPUTS[0])),
    "extra source leaf": f => newFile(join(f.officeRoot, "source", "unreviewed.cc"), "EXTRA"),
    "extra empty source directory": f => mkdirSync(join(f.officeRoot, "source", "foreign")),
    "binary hash mutation without new approval": f => writeFileSync(f.binaryPath, Buffer.alloc(f.descriptor.finalBinarySizeBytes, 66)),
    "binary size mutation": f => writeFileSync(f.binaryPath, "WRONG SIZE"),
    "manifest hash mutation": f => writeFileSync(f.manifestPath, "OTHER MANIFEST"),
    "source hash mutation": f => writeFileSync(join(f.officeRoot, "source", OFFICE_LOCAL_NATIVE_REVIEW_SOURCE_INPUTS[0]), "OTHER SOURCE"),
    "writable binary": f => chmodSync(f.binaryPath, 0o620),
    "world-writable source directory": f => chmodSync(join(f.officeRoot, "source/scripts"), 0o702),
    "writable app ancestor": f => chmodSync(join(f.appPath, "Contents/Resources"), 0o775),
    "binary symlink": f => {
      const displaced = join(f.root, "displaced.node"); renameSync(f.binaryPath, displaced); symlinkSync(displaced, f.binaryPath);
    },
    "source directory symlink": f => {
      const path = join(f.officeRoot, "source/scripts"), displaced = join(f.root, "displaced-scripts");
      renameSync(path, displaced); symlinkSync(displaced, path);
    },
    "hard-linked binary": f => linkSync(f.binaryPath, join(f.root, "second-binary.node")),
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    await t.test(name + " is rejected without altering original pins", async t => {
      const f = await fixture(t); mutate(f);
      assert.throws(() => f.api.verifyOriginalOfficeCopyInApp(f.appPath), /copy_invalid/u);
      assert.equal(f.state.active, f.descriptor); assert.equal(f.signatureCalls.length, 0);
    });
  }

  await t.test("relative, noncanonical and linked Apps are rejected", async t => {
    const f = await fixture(t), linked = join(f.root, "Linked.app"); symlinkSync(f.appPath, linked);
    for (const path of ["relative.app", f.context.appOutDir + "/../output/" + f.productFilename + ".app", linked])
      assert.throws(() => f.api.verifyOriginalOfficeCopyInApp(path), /copy_invalid/u);
  });
  await t.test("a different current UID is rejected", async t => {
    const f = await fixture(t), uid = process.getuid();
    t.mock.method(process, "getuid", () => uid + 1);
    assert.throws(() => f.api.verifyOriginalOfficeCopyInApp(f.appPath), /copy_invalid/u);
  });
  await t.test("same-byte path replacement during FD read is rejected", async t => {
    const f = await fixture(t), read = fsModule.readSync, bytes = readFileSync(f.binaryPath);
    let replaced = false;
    const mock = t.mock.method(fsModule, "readSync", (...args) => {
      const result = read(...args);
      if (!replaced) { replaced = true; rmSync(f.binaryPath); newFile(f.binaryPath, bytes); }
      return result;
    });
    syncBuiltinESMExports();
    t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
    assert.throws(() => f.api.verifyOriginalOfficeCopyInApp(f.appPath), /copy_invalid/u);
    assert.equal(replaced, true);
  });

  await t.test("all mac entries require active provenance; nonmac hooks do not read Office", async t => {
    const f = await fixture(t); f.state.active = undefined;
    assert.throws(() => f.api.verifyOriginalOfficeCopyInApp(f.appPath), /active_publication_missing/u);
    for (const method of ["verifyOfficeAfterPack", "verifyOfficeAfterSign"])
      await assert.rejects(f.api[method](f.context), /active_publication_missing/u);
    await assert.rejects(f.api.verifyOfficeFinalArtifact({ packager: f.context.packager }), /active_publication_missing/u);
    const reads = f.state.activeReads;
    for (const method of ["verifyOfficeAfterPack", "verifyOfficeAfterSign"])
      assert.equal(await f.api[method]({ electronPlatformName: "win32" }), undefined);
    assert.equal(await f.api.verifyOfficeFinalArtifact({ packager: { platform: { nodeName: "win32" } } }), undefined);
    assert.equal(f.state.activeReads, reads); assert.equal(f.signatureCalls.length, 0); assert.equal(f.extractionCalls.length, 0);
  });

  await t.test("afterPack preserves unrelated ignores and escapes only the actual absolute addon", async t => {
    const f = await fixture(t), prior = ["^/unrelated/helper$"];
    f.context.packager.platformSpecificBuildOptions.signIgnore = prior;
    await f.api.verifyOfficeAfterPack(f.context);
    const patterns = f.context.packager.platformSpecificBuildOptions.signIgnore;
    assert.deepEqual(prior, ["^/unrelated/helper$"]); assert.equal(patterns[0], prior[0]);
    const regex = new RegExp(patterns[1]);
    assert.equal(patterns[1].startsWith("^"), true); assert.equal(patterns[1].endsWith("$"), true);
    assert.equal(regex.test(f.binaryPath), true);
    for (const path of [f.binaryPath + ".other", f.binaryPath + "/nested.node", "prefix" + f.binaryPath,
      f.binaryPath.replace("Ling [Proof].1.app", "Ling XProofY21.app"),
      f.binaryPath.replace("Ling [Proof].1.app", "Another.app"), join(f.officeRoot, "foreign.node")])
      assert.equal(regex.test(path), false, path);
    await f.api.verifyOfficeAfterPack(f.context);
    assert.equal(f.context.packager.platformSpecificBuildOptions.signIgnore.length, 2);
    assert.equal(f.signatureCalls.length, 0);
  });
  await t.test("afterPack rejects Office-overlapping broad ignores without rewriting them", async t => {
    const f = await fixture(t);
    for (const pattern of ["\\.node$", "office-local", "source/", "^.*$"]) {
      f.context.packager.platformSpecificBuildOptions.signIgnore = pattern;
      await assert.rejects(f.api.verifyOfficeAfterPack(f.context), /broad_sign_ignore_forbidden/u);
      assert.equal(f.context.packager.platformSpecificBuildOptions.signIgnore, pattern);
    }
  });
  await t.test("afterPack fails before modifying ignores if the copied bytes are wrong", async t => {
    const f = await fixture(t); writeFileSync(f.binaryPath, "MUTATED");
    await assert.rejects(f.api.verifyOfficeAfterPack(f.context), /copy_invalid/u);
    assert.equal(f.context.packager.platformSpecificBuildOptions.signIgnore, undefined);
  });
  await t.test("afterPack rejects stale actual ASAR CLI before modifying signIgnore", async t => {
    const f = await fixture(t); newFile(join(f.asarSource, "dist/daemon/cli.mjs"), Buffer.alloc(f.cliBytes.length, 88));
    await createPackageWithOptions(f.asarSource, f.asarPath, {});
    await assert.rejects(f.api.verifyOfficeAfterPack(f.context), /copy_invalid/u);
    assert.equal(f.context.packager.platformSpecificBuildOptions.signIgnore, undefined);
  });

  await t.test("afterSign always performs the fixed bounded deep/strict command", async t => {
    const f = await fixture(t), result = await f.api.verifyOfficeAfterSign(f.context);
    assert.equal(result.evidenceKind, "build_byte_pins_only");
    assert.deepEqual(f.signatureCalls, [{ command: "/usr/bin/codesign",
      args: ["--verify", "--deep", "--strict", f.appPath], options: {
        env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }, encoding: "utf8", timeout: 60_000,
        maxBuffer: 1024 * 1024, windowsHide: true,
      } }]);
  });
  await t.test("afterSign propagates signature failure", async t => {
    const f = await fixture(t), failure = new Error("SYNTHETIC SIGNATURE FAILURE");
    f.state.signature = (_command, _args, _options, callback) => callback(failure);
    await assert.rejects(f.api.verifyOfficeAfterSign(f.context), error =>
      error.message === "packaged_office_native_signature_verification_failed" && error.cause === failure);
  });
  for (const kind of ["zip", "dmg"]) for (const timedOut of [true, false]) {
    await t.test(`${kind} signature ${timedOut ? "timeout" : "rejection"} stays fatal and cleans its extraction`, async t => {
      const f = await fixture(t), a = f.artifact(kind);
      const failure = Object.assign(new Error("SYNTHETIC SIGNATURE COMMAND FAILURE"), timedOut
        ? { code: null, signal: "SIGTERM", killed: true, stderr: "" }
        : { code: 1, signal: null, killed: false, stderr: "SYNTHETIC SIGNATURE REJECTION" });
      f.state.signature = (_command, _args, _options, callback) => callback(failure);
      await assert.rejects(f.api.verifyOfficeFinalArtifact(a.event), error =>
        error.message === "packaged_office_native_signature_verification_failed" && error.cause === failure);
      assert.equal(f.state.cleanupCalls, 1);
    });
  }
  await t.test("afterSign rechecks the actual ASAR CLI after the signature window", async t => {
    const f = await fixture(t);
    f.state.signature = (_command, _args, _options, callback) => {
      newFile(join(f.asarSource, "dist/daemon/cli.mjs"), Buffer.alloc(f.cliBytes.length, 88));
      createPackageWithOptions(f.asarSource, f.asarPath, {}).then(() => callback(null), callback);
    };
    await assert.rejects(f.api.verifyOfficeAfterSign(f.context), /copy_invalid/u);
  });
  for (const leaf of ["office-local.node", "build-manifest.json", "source/README.md"]) {
    await t.test("afterSign rejects signature-window mutation of " + leaf, async t => {
      const f = await fixture(t);
      f.state.signature = (_command, _args, _options, callback) => {
        writeFileSync(join(f.officeRoot, leaf), "SYNTHETIC MUTATION"); callback(null);
      };
      await assert.rejects(f.api.verifyOfficeAfterSign(f.context), /copy_invalid/u);
    });
  }
  await t.test("afterSign rejects retirement of active provenance during signature verification", async t => {
    const f = await fixture(t);
    f.state.signature = (_command, _args, _options, callback) => { f.state.active = undefined; callback(null); };
    await assert.rejects(f.api.verifyOfficeAfterSign(f.context), /active_publication_missing/u);
  });

  for (const kind of ["zip", "dmg"]) {
    await t.test(kind + " verification uses the real extractor interface and awaits cleanup (synthetic implementation)", async t => {
      const f = await fixture(t), a = f.artifact(kind);
      mkdirSync(join(a.appPath, "Contents/Frameworks/Internal Helper.app"), { recursive: true });
      symlinkSync("/Applications", join(a.extractionRoot, "Applications"));
      let cleaned = false;
      f.state.extractor = async (file, context) => {
        f.extractionCalls.push({ file, context });
        return { artifactRoot: a.extractionRoot, async cleanup() {
          await Promise.resolve(); f.state.cleanupCalls++; cleaned = true;
        } };
      };
      const result = await f.api.verifyOfficeFinalArtifact(a.event);
      assert.equal(result.appPath, a.appPath); assert.equal(cleaned, true); assert.equal(f.state.cleanupCalls, 1);
      assert.deepEqual(f.extractionCalls, [{ file: a.event.file, context: { platform: "darwin", artifactRole: "outer-" + kind } }]);
      assert.equal(f.signatureCalls[0].args.at(-1), a.appPath);
    });
    for (const when of ["before verification", "during signature window"]) {
      await t.test(kind + " rejects changed actual copied ASAR CLI " + when + " and cleans up", async t => {
        const f = await fixture(t), a = f.artifact(kind), path = join(a.appPath, "Contents/Resources/app.asar");
        async function mutate() {
          newFile(join(f.asarSource, "dist/daemon/cli.mjs"), Buffer.alloc(f.cliBytes.length, 88));
          await createPackageWithOptions(f.asarSource, path, {});
        }
        if (when === "before verification") await mutate();
        else f.state.signature = (_command, _args, _options, callback) => { mutate().then(() => callback(null), callback); };
        await assert.rejects(f.api.verifyOfficeFinalArtifact(a.event), /copy_invalid/u);
        assert.equal(f.state.cleanupCalls, 1);
        if (when === "before verification") assert.equal(f.signatureCalls.length, 0);
      });
    }
    await t.test(kind + " rejects a renamed Office duplicate in the actual copied ASAR", async t => {
      const f = await fixture(t), a = f.artifact(kind);
      newFile(join(f.asarSource, "foreign/renamed-addon"), readFileSync(f.binaryPath));
      await createPackageWithOptions(f.asarSource, join(a.appPath, "Contents/Resources/app.asar"), {});
      await assert.rejects(f.api.verifyOfficeFinalArtifact(a.event), /copy_invalid/u);
      assert.equal(f.state.cleanupCalls, 1); assert.equal(f.signatureCalls.length, 0);
    });
  }

  for (const invalid of ["second app", "uppercase second app", "nested second app", "wrapped expected app", "linked expected app", "wrong copied bytes"]) {
    await t.test("final artifact rejects " + invalid + " and still cleans up", async t => {
      const f = await fixture(t), a = f.artifact("zip");
      if (invalid === "second app") mkdirSync(join(a.extractionRoot, "Other.app"));
      else if (invalid === "uppercase second app") mkdirSync(join(a.extractionRoot, "Other.APP"));
      else if (invalid === "nested second app") mkdirSync(join(a.extractionRoot, "foreign/Other.app"), { recursive: true });
      else if (invalid === "wrapped expected app") {
        mkdirSync(join(a.extractionRoot, "wrapper")); renameSync(a.appPath, join(a.extractionRoot, "wrapper", f.productFilename + ".app"));
      } else if (invalid === "linked expected app") {
        const displaced = join(f.root, "displaced.app"); renameSync(a.appPath, displaced); symlinkSync(displaced, a.appPath);
      } else writeFileSync(join(a.appPath, "Contents/Resources/office-local/office-local.node"), "WRONG BYTES");
      await assert.rejects(f.api.verifyOfficeFinalArtifact(a.event), /copy_invalid/u);
      assert.equal(f.state.cleanupCalls, 1); assert.equal(f.signatureCalls.length, 0);
    });
  }
  await t.test("final artifact rejects wrong/missing targets before extraction", async t => {
    const f = await fixture(t), a = f.artifact("zip");
    for (const event of [{ ...a.event, target: null }, { ...a.event, target: { name: "dmg" } },
      { ...a.event, target: { name: "pkg" } }])
      await assert.rejects(f.api.verifyOfficeFinalArtifact(event), /copy_invalid/u);
    assert.equal(f.extractionCalls.length, 0);
  });
  await t.test("artifact changed during verification is rejected with cleanup", async t => {
    const f = await fixture(t), a = f.artifact("zip");
    f.state.signature = (_command, _args, _options, callback) => { writeFileSync(a.event.file, "MUTATED CONTAINER"); callback(null); };
    await assert.rejects(f.api.verifyOfficeFinalArtifact(a.event), /copy_invalid/u);
    assert.equal(f.state.cleanupCalls, 1);
  });
  for (const kind of ["zip", "dmg"]) {
    await t.test(kind + " original artifact stays pinned through awaited cleanup", async t => {
      const f = await fixture(t), a = f.artifact(kind);
      f.state.extractor = async () => ({ artifactRoot: a.extractionRoot, async cleanup() {
        await Promise.resolve();
        f.state.cleanupCalls++;
        writeFileSync(a.event.file, "MUTATED DURING AWAITED CLEANUP");
      } });
      await assert.rejects(f.api.verifyOfficeFinalArtifact(a.event), /copy_invalid/u);
      assert.equal(f.state.cleanupCalls, 1);
      assert.equal(f.signatureCalls.length, 1);
    });
  }
  await t.test("a second App added during verification is rejected with cleanup", async t => {
    const f = await fixture(t), a = f.artifact("zip");
    f.state.signature = (_command, _args, _options, callback) => { mkdirSync(join(a.extractionRoot, "Late.app")); callback(null); };
    await assert.rejects(f.api.verifyOfficeFinalArtifact(a.event), /copy_invalid/u);
    assert.equal(f.state.cleanupCalls, 1);
  });
  await t.test("cleanup failure is surfaced; combined verification/cleanup failure preserves both", async t => {
    const f = await fixture(t), a = f.artifact("dmg"), cleanupFailure = new Error("SYNTHETIC CLEANUP FAILURE");
    f.state.extractor = async () => ({ artifactRoot: a.extractionRoot, async cleanup() { throw cleanupFailure; } });
    await assert.rejects(f.api.verifyOfficeFinalArtifact(a.event), error => error === cleanupFailure);
    writeFileSync(join(a.appPath, "Contents/Resources/office-local/office-local.node"), "WRONG BYTES");
    await assert.rejects(f.api.verifyOfficeFinalArtifact(a.event), error => error instanceof AggregateError
      && error.message === "packaged_office_native_artifact_and_cleanup_failed"
      && /copy_invalid/u.test(error.errors[0].message) && error.errors[1] === cleanupFailure);
  });
  for (const [index, reason] of [undefined, null, false, 0, ""].entries()) {
    await t.test("cleanup rejection with falsy reason " + index + " is not swallowed", async t => {
      const f = await fixture(t), a = f.artifact("zip");
      f.state.extractor = async () => ({ artifactRoot: a.extractionRoot, async cleanup() { throw reason; } });
      await assert.rejects(f.api.verifyOfficeFinalArtifact(a.event), error => error === reason);
    });
  }
  await t.test("verification and falsy cleanup failures remain a two-cause AggregateError", async t => {
    const f = await fixture(t), a = f.artifact("zip");
    writeFileSync(join(a.appPath, "Contents/Resources/office-local/office-local.node"), "WRONG BYTES");
    f.state.extractor = async () => ({ artifactRoot: a.extractionRoot, async cleanup() { throw null; } });
    await assert.rejects(f.api.verifyOfficeFinalArtifact(a.event), error => error instanceof AggregateError
      && error.errors.length === 2 && /copy_invalid/u.test(error.errors[0].message) && error.errors[1] === null);
  });
  await t.test("falsy verification rejection is propagated after cleanup", async t => {
    const f = await fixture(t), a = f.artifact("zip");
    f.state.signature = (_command, _args, _options, callback) => {
      Object.defineProperty(f.state, "active", { get() { throw undefined; } }); callback(null);
    };
    await assert.rejects(f.api.verifyOfficeFinalArtifact(a.event), error => error === undefined);
    assert.equal(f.state.cleanupCalls, 1);
  });
  await t.test("extractor initialization failures propagate without invented cleanup", async t => {
    const f = await fixture(t), a = f.artifact("zip"), failure = new Error("SYNTHETIC EXTRACTOR FAILURE");
    f.state.extractor = async () => { throw failure; };
    await assert.rejects(f.api.verifyOfficeFinalArtifact(a.event), error => error === failure);
    assert.equal(f.state.cleanupCalls, 0); assert.equal(f.signatureCalls.length, 0);
  });
  await t.test("parallel ZIP/DMG completions retain their own App and cleanup", async t => {
    const f = await fixture(t), zip = f.artifact("zip"), dmg = f.artifact("dmg");
    const artifacts = new Map([[zip.event.file, zip], [dmg.event.file, dmg]]), cleaned = [];
    f.state.extractor = async file => {
      const a = artifacts.get(file);
      return { artifactRoot: a.extractionRoot, async cleanup() { cleaned.push(file); } };
    };
    f.state.signature = (command, args, options, callback) => {
      f.signatureCalls.push({ command, args, options }); queueMicrotask(() => callback(null));
    };
    const results = await Promise.all([f.api.verifyOfficeFinalArtifact(zip.event), f.api.verifyOfficeFinalArtifact(dmg.event)]);
    assert.deepEqual(results.map(result => result.appPath), [zip.appPath, dmg.appPath]);
    assert.deepEqual(cleaned.sort(), [zip.event.file, dmg.event.file].sort());
    assert.deepEqual(f.signatureCalls.map(call => call.args.at(-1)).sort(), [zip.appPath, dmg.appPath].sort());
  });
  t.diagnostic("Real local ASAR and real parser; synthetic original native/emitted readers, codesign and outer extractor. Green proves copied-byte/sequence/failure contracts, not token origin, real ZIP/DMG cleanup, signature, Electron or packaged acceptance.");
});
