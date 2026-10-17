import "./managed-integration-guard.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const input = process.env.LING_GSTACK_RESOURCE_STAGE && resolve(process.env.LING_GSTACK_RESOURCE_STAGE);
const skip = !input && "Set the retained resource stage and use managed supervision";
const compiler = input && join(input, "runtime/tools/bun");
const builder = fileURLToPath(new URL("./build-bun-native-resource.mjs", import.meta.url));
const hash = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const binary = `browse/dist/browse${process.platform === "win32" ? ".exe" : ""}`;

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "ling bun native artifact "));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = join(root, "runtime"), output = join(root, "output");
  await mkdir(output);
  const files = [];
  for (const [path, text] of [
    ["browse/src/cli.ts", 'import { value } from "./helper"; import { remote } from "fixture-dependency"; console.log(value,remote,__dirname); throw new Error("native entry must not execute while building");\n'],
    ["browse/src/helper.ts", 'export const value: string = "fixture-native";\n'],
  ]) {
    await mkdir(dirname(join(runtime, path)), { recursive: true });
    await writeFile(join(runtime, path), text);
    files.push({ path: `runtime/${path}`, sizeBytes: Buffer.byteLength(text), checksum: hash(text) });
  }
  const dependency = join(runtime, "node_modules/fixture-dependency/index.js");
  await mkdir(dirname(dependency), { recursive: true });
  await writeFile(join(dirname(dependency), "package.json"), JSON.stringify({ name: "fixture-dependency", version: "1.0.0", type: "module", exports: "./index.js" }));
  await writeFile(dependency, 'export const remote = "before";\n');
  const manifestPath = join(root, "source-manifest.json");
  const manifest = Buffer.from(JSON.stringify({ schemaVersion: 1, deliveryStage: "source", upstream: { revision: "f".repeat(40) }, files }));
  await writeFile(manifestPath, manifest);
  return { root, runtime, output, dependency, options: { kind: "browse", runtimeRoot: runtime, outputRoot: output,
    sourceManifestPath: manifestPath, expectedSourceManifestChecksum: hash(manifest), bunPath: compiler,
    expectedCompilerChecksum: hash(await readFile(compiler)) } };
}

function build(data, before = "", changes = {}, cwd) {
  const program = `import {buildGstackBunNativeResource} from ${JSON.stringify(builder)};
    ${before}
    console.log(JSON.stringify(await buildGstackBunNativeResource(${JSON.stringify({ ...data.options, ...changes })})));`;
  return spawnSync(process.execPath, ["--input-type=module", "-e", program], {
    cwd: cwd ?? changes.runtimeRoot ?? data.runtime, env: { ...process.env, NODE_OPTIONS: "", NODE_PATH: "" },
    encoding: "utf8", timeout: 60_000, maxBuffer: 2 * 1024 ** 2,
  });
}

async function noArtifact(data) {
  for (const path of [binary, `${binary}.build-provenance.json`]) await assert.rejects(readFile(join(data.output, path)), { code: "ENOENT" });
  assert.deepEqual((await readdir(tmpdir())).filter(name => name.startsWith(".ling-native-compile-")), []);
}

function afterSecondCompile(action) {
  return `const cp=(await import("node:child_process")).default,fs=(await import("node:fs")).default;
    const original=cp.execFileSync;let calls=0;cp.execFileSync=(...args)=>{const result=original(...args);if(++calls===2){${action}}return result;};
    (await import("node:module")).syncBuiltinESMExports();`;
}

test("native CLI builds bind the real compile metafile and two identical executable outputs without executing the entry", { skip }, async t => {
  const data = await fixture(t), result = build(data);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.compiledArtifactBinding, "repeated-native-compilation-and-emitted-byte-identity");
  assert.equal(report.releaseEligible, false);
  assert.equal(report.compiler.checksum, data.options.expectedCompilerChecksum);
  assert.equal(report.sourceManifestChecksum, data.options.expectedSourceManifestChecksum);
  assert.ok(report.inputs.some(file => file.path === "browse/src/helper.ts"));
  assert.ok(report.inputs.some(file => file.path === "node_modules/fixture-dependency/index.js"));
  assert.ok(report.inputs.some(file => file.path === "node_modules/fixture-dependency/package.json"));
  const bytes = await readFile(join(data.output, binary));
  assert.equal(report.artifact.checksum, hash(bytes));
  assert.equal(report.artifact.sizeBytes, bytes.length);
  assert.equal(bytes.includes(Buffer.from(data.root)), false);
  assert.ok(bytes.includes(Buffer.from("native entry must not execute while building")));
  assert.deepEqual(JSON.parse(await readFile(join(data.output, `${binary}.build-provenance.json`))), report);
  await assert.rejects(readFile(join(data.runtime, binary)), { code: "ENOENT" });
  assert.ok(report.compileScratchPeakBytes < 256 * 1024 ** 2);
});

test("wrong detached identities, unknown recipes and equal-length changed source reject without artifacts", { skip }, async t => {
  const data = await fixture(t);
  for (const [changes, expected] of [
    [{ expectedSourceManifestChecksum: `sha256:${"0".repeat(64)}` }, /gstack_bun_native_source_manifest_mismatch/],
    [{ expectedCompilerChecksum: `sha256:${"0".repeat(64)}` }, /gstack_bun_native_compiler_mismatch/],
    [{ kind: "../arbitrary-entry" }, /gstack_bun_native_recipe_invalid/],
  ]) {
    const result = build(data, "", changes);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, expected);
    await noArtifact(data);
  }
  const source = join(data.runtime, "browse/src/helper.ts");
  await writeFile(source, (await readFile(source, "utf8")).replace("fixture-native", "changed-native"));
  const result = build(data);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /gstack_bun_native_source_input_mismatch/);
  await noArtifact(data);
});

test("dependencies changed after compilation cannot acquire matching native lineage", { skip }, async t => {
  const data = await fixture(t);
  const result = build(data, afterSecondCompile(`fs.writeFileSync(${JSON.stringify(data.dependency)},'export const remote = "after!";\\n');`));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /gstack_bun_native_build_inputs_changed/);
  await noArtifact(data);
});

test("missing required imports and source manifests fail and remove compiler scratch", { skip }, async t => {
  const data = await fixture(t);
  await rm(data.dependency);
  let result = build(data);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /gstack_bun_native_compile_failed/);
  await noArtifact(data);
  await rm(data.options.sourceManifestPath);
  result = build(data);
  assert.notEqual(result.status, 0);
  await noArtifact(data);
});

test("existing native outputs, linked inputs and output aliases preserve unrelated bytes", { skip }, async t => {
  const data = await fixture(t), target = join(data.output, binary);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, "user-owned binary");
  let result = build(data);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /gstack_bun_native_output_already_exists/);
  assert.equal(await readFile(target, "utf8"), "user-owned binary");
  await rm(target);
  const helper = join(data.runtime, "browse/src/helper.ts"), outside = join(data.root, "outside.ts");
  await rename(helper, outside);
  await symlink(outside, helper);
  result = build(data);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /(?:file_invalid|graph_path_invalid)/);
  await noArtifact(data);
  const alias = join(data.root, "output-alias");
  await symlink(data.output, alias);
  result = build(data, "", { outputRoot: alias });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /gstack_bun_native_output_root_invalid/);
  assert.match(await readFile(outside, "utf8"), /fixture-native/);
});

test("retained trees and missing leases are rejected while private native staging can build", { skip }, async t => {
  const data = await fixture(t);
  let result = build(data, "", { outputRoot: data.runtime });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /gstack_bun_native_private_staging_required/);
  await noArtifact(data);
  const candidate = join(data.root, ".gstack-native-stage-fixture/candidate");
  await mkdir(candidate, { recursive: true });
  const runtime = join(candidate, "runtime"), manifest = join(candidate, "manifest.json");
  await rename(data.runtime, runtime);
  await copyFile(data.options.sourceManifestPath, manifest);
  const changes = { runtimeRoot: runtime, outputRoot: runtime, sourceManifestPath: manifest };
  result = build(data, "delete process.env.LING_GSTACK_RESOURCE_TOKEN;", changes);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /gstack_resource_lease_required/);
  await assert.rejects(readFile(join(runtime, binary)), { code: "ENOENT" });
  result = build(data, "", changes);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(await readFile(join(runtime, `${binary}.build-provenance.json`))).releaseEligible, false);
});

test("ambient working directories cannot contribute compiler configuration", { skip }, async t => {
  const data = await fixture(t), result = build(data, "", {}, data.root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /gstack_bun_native_build_cwd_required/);
  await noArtifact(data);
});

test("a publication collision preserves its owner and removes only the newly linked executable", { skip }, async t => {
  const data = await fixture(t), colliding = join(data.output, `${binary}.build-provenance.json`);
  await mkdir(dirname(colliding), { recursive: true });
  const result = build(data, afterSecondCompile(`fs.writeFileSync(${JSON.stringify(colliding)},"concurrent owner bytes");`));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /EEXIST/);
  await assert.rejects(readFile(join(data.output, binary)), { code: "ENOENT" });
  assert.equal(await readFile(colliding, "utf8"), "concurrent owner bytes");
  assert.deepEqual((await readdir(tmpdir())).filter(name => name.startsWith(".ling-native-compile-")), []);
});
