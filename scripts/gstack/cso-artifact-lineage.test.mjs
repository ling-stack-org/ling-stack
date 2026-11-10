import "./managed-integration-guard.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseCsoCompilerDependencies } from "./build-cso-resource.mjs";
import { buildEnvironment } from "./build-native-runtime.mjs";
import { readGstackClosureFileRecord } from "./verify-shared-command-closure.mjs";
import { resourceTreeBytes } from "./resource-workspace.mjs";

const retained = process.env.LING_GSTACK_RESOURCE_STAGE && resolve(process.env.LING_GSTACK_RESOURCE_STAGE);
const skip = (process.platform !== "darwin" || !retained) && "Use retained Darwin resources under managed supervision";
const hash = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const builder = fileURLToPath(new URL("./build-cso-resource.mjs", import.meta.url));
const paths = ["bin/gstack-cso-core", "bin/gstack-cso-watchdog", "bin/.gstack-cso-generation", "bin/gstack-cso-launcher", "bin/cso-build-provenance.json"];
const expectedSource = "sha256:2921f0cfd111004b078f33b50b91efb053e5d81a661f9fc9473c9ff0e2dcbf8d";
const expectedNative = "sha256:65eb00f9b33dffaa561804ae47e0207f9005b9b1e9c9c0ccf04078c3b5c61964";
const expectedResource = "sha256:ab63d645623de138a7bec3b0cf4a58271fadf6f25b907b1c313ae314e38d818b";
const expectedCompiler = "sha256:35d20dd0263e5c950194434b925454fdfa9ba6e4467da960410fa05b08a7a5b5";

async function fixture(t, mirror = false) {
  const work = await realpath(await mkdtemp(join(tmpdir(), "ling cso lineage ")));
  t.after(() => rm(work, { recursive: true, force: true }));
  const output = join(work, "output"), runtime = mirror ? join(work, "runtime") : join(retained, "runtime");
  await mkdir(output);
  const sourceManifestPath = join(retained, "source-manifest.json");
  if (mirror) {
    const manifest = JSON.parse(await readFile(sourceManifestPath));
    for (const file of manifest.files) {
      const path = file.path.slice(8);
      if (!file.path.startsWith("runtime/") || !(path === "VERSION" || path === "scripts/build-cso.sh" ||
        ["package.json", "tsconfig.json", "bunfig.toml"].includes(path) ||
        path.startsWith("lib/") && !path.startsWith("lib/diagram-render/") && /\.(?:ts|js|json|c|h)$/.test(path))) continue;
      await mkdir(dirname(join(runtime, path)), { recursive: true });
      await copyFile(join(retained, file.path), join(runtime, path));
    }
  }
  return { work, runtime, output, options: { runtimeRoot: runtime, outputRoot: output, sourceManifestPath,
    expectedSourceManifestChecksum: expectedSource, bunPath: join(retained, "runtime/tools/bun"), expectedCompilerChecksum: expectedCompiler } };
}

function build(data, before = "", changes = {}, cwd = data.runtime) {
  const code = `import {buildGstackCsoResource} from ${JSON.stringify(builder)};
    ${before}
    console.log(JSON.stringify(await buildGstackCsoResource(${JSON.stringify({ ...data.options, ...changes })})));`;
  return spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    cwd, env: { ...process.env, NODE_OPTIONS: "", NODE_PATH: "" }, encoding: "utf8", timeout: 180_000, maxBuffer: 4 * 1024 ** 2,
  });
}

async function noOutputs(data) {
  for (const path of paths) await assert.rejects(lstat(join(data.output, path)), { code: "ENOENT" });
  assert.deepEqual((await readdir(tmpdir())).filter(path => path.startsWith(".ling-cso-build-")), []);
}

function afterSecondBuild(action) {
  return `const cp=(await import("node:child_process")).default,fs=(await import("node:fs")).default;
    const original=cp.execFileSync;let builds=0;cp.execFileSync=(command,args,...rest)=>{const value=original(command,args,...rest);
      if(command==="/bin/bash"&&args[0]==="scripts/build-cso.sh"&&++builds===2){${action}}return value;};
    (await import("node:module")).syncBuiltinESMExports();`;
}

test("Clang dependency records preserve escaped paths and reject malformed make syntax", () => {
  assert.deepEqual(parseCsoCompilerDependencies("ling: lib/cso/launcher.c \\\n /sdk/a\\ b.h /sdk/a\\#b.h\n"), ["lib/cso/launcher.c", "/sdk/a b.h", "/sdk/a#b.h"]);
  for (const value of ["other: x", "ling:", "ling: x x", "ling: $(shell rm)", "ling: x\\", "ling: x\nother: y"]) {
    assert.throws(() => parseCsoCompilerDependencies(value), /dependency_record_invalid/);
  }
});

test("unmodified upstream CSO builds bind signed core, C inputs, native publication and launcher generation", { skip }, async t => {
  const data = await fixture(t);
  const protectedPaths = [["source-manifest.json", expectedSource], ["native-build.json", expectedNative], ["resource-stage.json", expectedResource], ["runtime/tools/bun", expectedCompiler]];
  for (const [path, expected] of protectedPaths) assert.equal((await readGstackClosureFileRecord(join(retained, path))).checksum, expected);
  const buildEnv = buildEnvironment({ bunPath: data.options.bunPath, nodePath: process.execPath, home: data.work, temporary: tmpdir() });
  for (const key of ["LING_GSTACK_RESOURCE_ROOT", "LING_GSTACK_RESOURCE_TOKEN"]) buildEnv[key] = process.env[key];
  const result = spawnSync(data.options.bunPath, ["--no-env-file", "--no-install", builder, data.runtime, data.output], {
    cwd: data.runtime, env: buildEnv, encoding: "utf8", timeout: 180_000, maxBuffer: 4 * 1024 ** 2,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /built CSO with/);
  const report = JSON.parse(await readFile(join(data.output, paths.at(-1))));
  assert.equal(report.compiledArtifactBinding, "repeated-unmodified-upstream-cso-build-and-signed-byte-identity");
  assert.equal(report.releaseEligible, false);
  assert.equal(report.invocations.length, 4);
  assert.ok(report.inputs.some(file => file.path === "lib/cso/runtime-catalog.json"));
  assert.ok(report.cDependencies.some(file => file.path === "lib/cso/launcher.c"));
  assert.ok(report.cDependencies.some(file => file.path.startsWith("sdk/")));
  assert.ok(report.sourceMirrorBytes < 8 * 1024 ** 2);
  assert.ok(report.compileScratchPeakBytes < 256 * 1024 ** 2);
  assert.equal(report.peakAccounting, "owned-compiler-scratch-plus-simultaneously-published-copies");
  assert.ok(report.compileScratchPeakBytes > 2 * report.artifacts.find(file => file.path === "bin/gstack-cso-core").sizeBytes);
  const prior = JSON.parse(await readFile(join(retained, "native-build.json")));
  const comparisons = [];
  for (const artifact of report.artifacts) {
    const actual = await readGstackClosureFileRecord(join(data.output, artifact.path));
    assert.equal(actual.checksum, artifact.checksum);
    assert.equal((await lstat(join(data.output, artifact.path))).nlink, 1);
    const old = prior.components.find(file => file.path === `runtime/${artifact.path}`);
    comparisons.push({ path: artifact.path, retainedChecksum: old?.checksum, rebuiltChecksum: actual.checksum, equal: old?.checksum === actual.checksum });
  }
  assert.deepEqual(JSON.parse(await readFile(join(data.output, paths.at(-1)))), report);
  for (const file of report.sourceInputs) assert.equal((await readGstackClosureFileRecord(join(data.runtime, file.path))).checksum, file.checksum);
  const env = buildEnvironment({ bunPath: data.options.bunPath, nodePath: process.execPath, home: data.work, temporary: tmpdir() });
  env.PATH = "/usr/bin:/bin";
  const version = () => spawnSync(join(data.output, "bin/gstack-cso-launcher"), ["--version"], {
    cwd: data.work, env, encoding: "utf8", timeout: 10_000, maxBuffer: 1024 ** 2,
  });
  const valid = version();
  assert.equal(valid.status, 0, valid.stderr);
  assert.equal(JSON.parse(valid.stdout).abi, 3);
  const generationPath = join(data.output, "bin/.gstack-cso-generation"), generation = await readFile(generationPath);
  await writeFile(generationPath, `${"0".repeat(64)}\n`);
  const badGeneration = version();
  assert.equal(badGeneration.status, 69);
  assert.match(badGeneration.stderr, /generations do not match/);
  await writeFile(generationPath, generation);
  const corePath = join(data.output, "bin/gstack-cso-core"), core = await readFile(corePath);
  await writeFile(corePath, Buffer.concat([core, Buffer.from("tampered")]));
  const badCore = version();
  assert.equal(badCore.status, 69);
  assert.match(badCore.stderr, /compiled helper/);
  await writeFile(corePath, core);
  assert.equal((await readGstackClosureFileRecord(corePath)).checksum, report.coreChecksum);
  const launcherChecks = { version: JSON.parse(valid.stdout), generationMismatchExitCode: badGeneration.status, coreMismatchExitCode: badCore.status };
  for (const [path, expected] of protectedPaths) assert.equal((await readGstackClosureFileRecord(join(retained, path))).checksum, expected);
  const peakScratchBytes = Math.max(report.compileScratchPeakBytes, await resourceTreeBytes(data.work));
  await rm(data.work, { recursive: true });
  await assert.rejects(lstat(data.work), { code: "ENOENT" });
  assert.deepEqual((await readdir(tmpdir())).filter(path => path.startsWith(".ling-cso-build-")), []);
  if (process.env.LING_GSTACK_CSO_LINEAGE_PROOF_OUTPUT) {
    const output = resolve(process.env.LING_GSTACK_CSO_LINEAGE_PROOF_OUTPUT);
    assert.equal(output, join(process.env.LING_GSTACK_RESOURCE_ROOT, "artifacts/report/cso-artifact-lineage-proof.json"));
    const testInputs = [{ path: "scripts/gstack/cso-artifact-lineage.test.mjs", ...await readGstackClosureFileRecord(fileURLToPath(import.meta.url)) }];
    const proof = { schemaVersion: 1, deliveryStage: "compiled-resource-prerequisites", releaseEligible: false,
      verificationScope: "darwin-cso-unmodified-upstream-build-and-signed-artifact-lineage-only", report, comparisons, launcherChecks, testInputs,
      retainedResourceChecksum: expectedResource, nativeReceiptChecksum: expectedNative, peakScratchBytes, cleanup: "complete",
      completeNativeBuild: "pending", completeResourcePreparation: "pending" };
    const bytes = Buffer.from(`${JSON.stringify(proof, null, 2)}\n`);
    await writeFile(output, bytes, { flag: "wx" });
    t.diagnostic(JSON.stringify({ sizeBytes: bytes.length, checksum: hash(bytes), sourceMirrorBytes: report.sourceMirrorBytes,
      inputCount: report.inputs.length, cDependencyCount: report.cDependencies.length, peakScratchBytes, comparisons }));
  }
});

test("CSO requires detached identities, canonical cwd, a live lease and unpublished output", { skip }, async t => {
  const data = await fixture(t);
  for (const [before, changes, cwd, pattern] of [
    ["", { expectedSourceManifestChecksum: `sha256:${"0".repeat(64)}` }, data.runtime, /source_manifest_mismatch/],
    ["", { expectedCompilerChecksum: `sha256:${"0".repeat(64)}` }, data.runtime, /compiler_mismatch/],
    ["", {}, data.work, /build_cwd_required/],
    ["delete process.env.LING_GSTACK_RESOURCE_TOKEN;", {}, data.runtime, /resource_lease_required/],
    ["", { outputRoot: data.runtime }, data.runtime, /private_staging_required/],
  ]) {
    const result = build(data, before, changes, cwd);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, pattern);
    await noOutputs(data);
  }
});

test("CSO refuses changed authenticated source, unsafe aliases and existing outputs", { skip }, async t => {
  const data = await fixture(t, true);
  const source = join(data.runtime, "lib/cso/cli.ts"), original = await readFile(source, "utf8");
  await writeFile(source, original.replace("node:fs", "node:os"));
  let result = build(data);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /source_input_mismatch/);
  await noOutputs(data);
  await writeFile(source, original);
  await symlink(data.output, join(data.work, "alias"));
  result = build(data, "", { outputRoot: join(data.work, "alias") });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /output_root_invalid/);
  await mkdir(join(data.output, "bin"));
  await writeFile(join(data.output, paths[0]), "other owner");
  result = build(data);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /output_already_exists/);
  assert.equal(await readFile(join(data.output, paths[0]), "utf8"), "other owner");
});

test("CSO rechecks original source after actual signed compilation and leaves no output on mutation", { skip }, async t => {
  const data = await fixture(t, true), source = join(data.runtime, "lib/cso/cli.ts");
  const result = build(data, afterSecondBuild(`fs.writeFileSync(${JSON.stringify(source)},fs.readFileSync(${JSON.stringify(source)},"utf8").replace("node:fs","node:os"));`));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /source_input_mismatch/);
  await noOutputs(data);
});

test("CSO partial-publication cleanup preserves a competing report owner", { skip }, async t => {
  const data = await fixture(t), collision = join(data.output, paths.at(-1));
  await mkdir(dirname(collision));
  const result = build(data, afterSecondBuild(`fs.writeFileSync(${JSON.stringify(collision)},"other owner");`));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /EEXIST/);
  assert.equal(await readFile(collision, "utf8"), "other owner");
  for (const path of paths.slice(0, -1)) await assert.rejects(lstat(join(data.output, path)), { code: "ENOENT" });
  assert.deepEqual((await readdir(tmpdir())).filter(path => path.startsWith(".ling-cso-build-")), []);
});
