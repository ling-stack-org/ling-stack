import "./managed-integration-guard.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const input = process.env.LING_GSTACK_RESOURCE_STAGE && resolve(process.env.LING_GSTACK_RESOURCE_STAGE);
const skip = !input && "Set the retained resource stage and use managed supervision";
const compiler = input && join(input, "runtime/tools/bun");
const builder = fileURLToPath(new URL("./build-node-server-resource.mjs", import.meta.url));
const hash = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "ling node artifact lineage "));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = join(root, "runtime"), output = join(root, "output");
  await mkdir(output);
  const sources = [
    ["browse/src/server.ts", 'import { value } from "./helper"; import { remote } from "fixture-dependency"; console.log(value, remote, __dirname, import.meta.dir); throw new Error("server must not execute");\n'],
    ["browse/src/helper.ts", 'export const value: string = "fixture-server";\n'],
    ["browse/src/bun-polyfill.cjs", 'throw new Error("polyfill must not execute while building");\n'],
  ];
  const files = [];
  for (const [path, text] of sources) {
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
  return { root, runtime, output, dependency, options: { runtimeRoot: runtime, outputRoot: output, sourceManifestPath: manifestPath,
    expectedSourceManifestChecksum: hash(manifest), expectedCompilerChecksum: hash(await readFile(compiler)) } };
}

function build(data, before = "", changes = {}, cwd) {
  const program = `import {buildGstackNodeServerResource} from ${JSON.stringify(builder)};
    ${before}
    const result=await buildGstackNodeServerResource(${JSON.stringify({ ...data.options, ...changes })});
    console.log(JSON.stringify(result));`;
  return spawnSync(compiler, ["--no-env-file", "--no-install", "-e", program], {
    cwd: cwd ?? changes.runtimeRoot ?? data.runtime, env: { ...process.env, BUN_OPTIONS: "", NODE_OPTIONS: "", NODE_PATH: "" },
    encoding: "utf8", timeout: 30_000, maxBuffer: 2 * 1024 ** 2,
  });
}

async function noArtifact(data) {
  await assert.rejects(readFile(join(data.output, "browse/dist/server-node.mjs")), { code: "ENOENT" });
  await assert.rejects(readFile(join(data.output, "browse/dist/node-server-build-provenance.json")), { code: "ENOENT" });
}

test("actual Node server builds bind two matching compiler invocations, source inputs and emitted bytes without running modules", { skip }, async t => {
  const data = await fixture(t), result = build(data);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.compiledArtifactBinding, "repeated-compilation-and-emitted-byte-identity");
  assert.equal(report.releaseEligible, false);
  assert.equal(report.sourceManifestChecksum, data.options.expectedSourceManifestChecksum);
  assert.equal(report.compiler.checksum, data.options.expectedCompilerChecksum);
  assert.ok(report.inputs.some(file => file.path === "browse/src/helper.ts"));
  assert.ok(report.inputs.some(file => file.path === "node_modules/fixture-dependency/index.js"));
  const bytes = await readFile(join(data.output, "browse/dist/server-node.mjs"));
  assert.equal(report.artifacts.find(file => file.path.endsWith("server-node.mjs")).checksum, hash(bytes));
  assert.equal(bytes.includes(Buffer.from(data.root)), false);
  assert.match(bytes.toString(), /server must not execute/);
  assert.deepEqual(await readFile(join(data.output, "browse/dist/bun-polyfill.cjs")), await readFile(join(data.runtime, "browse/src/bun-polyfill.cjs")));
  assert.deepEqual(JSON.parse(await readFile(join(data.output, "browse/dist/node-server-build-provenance.json"))), report);
  await assert.rejects(readFile(join(data.runtime, "browse/dist/server-node.mjs")), { code: "ENOENT" });
});

test("same-length source changes and wrong detached source/compiler identities reject before publication", { skip }, async t => {
  const data = await fixture(t);
  for (const changes of [
    { expectedSourceManifestChecksum: `sha256:${"0".repeat(64)}` },
    { expectedCompilerChecksum: `sha256:${"0".repeat(64)}` },
  ]) {
    const result = build(data, "", changes);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /gstack_node_server_(?:source_manifest|compiler)_mismatch/);
    await noArtifact(data);
  }
  const path = join(data.runtime, "browse/src/helper.ts"), bytes = await readFile(path, "utf8");
  await writeFile(path, bytes.replace("fixture-server", "changed-server"));
  const result = build(data);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /gstack_node_server_source_input_mismatch/);
  await noArtifact(data);
});

test("a dependency changed after the second actual compile cannot receive a matching provenance report", { skip }, async t => {
  const data = await fixture(t);
  const hook = `const original=Bun.build;let calls=0;Bun.build=async options=>{
    const result=await original(options);if(++calls===2)await Bun.write(${JSON.stringify(data.dependency)},'export const remote = "after!";\\n');return result;};`;
  const result = build(data, hook);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /gstack_node_server_build_inputs_changed/);
  await noArtifact(data);
});

test("missing required imports and missing source manifests fail without emitting artifacts", { skip }, async t => {
  const data = await fixture(t);
  await rm(data.dependency);
  let result = build(data);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /gstack_node_server_compile_failed/);
  await noArtifact(data);
  await rm(data.options.sourceManifestPath);
  result = build(data);
  assert.notEqual(result.status, 0);
  await noArtifact(data);
});

test("existing outputs, linked inputs and output aliases preserve user-owned bytes", { skip }, async t => {
  const data = await fixture(t), target = join(data.output, "browse/dist/server-node.mjs");
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, "user-owned output");
  let result = build(data);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /gstack_node_server_output_already_exists/);
  assert.equal(await readFile(target, "utf8"), "user-owned output");
  await rm(target);
  const source = join(data.runtime, "browse/src/helper.ts"), outside = join(data.root, "outside.ts");
  await writeFile(outside, await readFile(source));
  await rm(source);
  await symlink(outside, source);
  result = build(data);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /(?:file_invalid|source_input|graph_path_invalid)/);
  await noArtifact(data);
  const alias = join(data.root, "output-alias");
  await symlink(data.output, alias);
  result = build(data, "", { outputRoot: alias });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /gstack_node_server_output_root_invalid/);
  assert.equal(await readFile(outside, "utf8"), 'export const value: string = "fixture-server";\n');
});

test("a retained runtime is never a writable output root", { skip }, async t => {
  const data = await fixture(t), result = build(data, "", { outputRoot: data.runtime });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /gstack_node_server_private_staging_required/);
  await noArtifact(data);
  await assert.rejects(readFile(join(data.runtime, "browse/dist/server-node.mjs")), { code: "ENOENT" });
});

test("private native staging uses the same real producer and cannot bypass the live managed lease", { skip }, async t => {
  const data = await fixture(t), candidate = join(data.root, ".gstack-native-stage-fixture/candidate");
  await mkdir(candidate, { recursive: true });
  const runtime = join(candidate, "runtime"), manifest = join(candidate, "manifest.json");
  await rename(data.runtime, runtime);
  await copyFile(data.options.sourceManifestPath, manifest);
  const options = { runtimeRoot: runtime, outputRoot: runtime, sourceManifestPath: manifest };
  const rejected = build(data, "delete process.env.LING_GSTACK_RESOURCE_TOKEN;", options);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /gstack_resource_lease_required/);
  await assert.rejects(readFile(join(runtime, "browse/dist/server-node.mjs")), { code: "ENOENT" });
  const result = build(data, "", options);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(await readFile(join(runtime, "browse/dist/node-server-build-provenance.json"))).releaseEligible, false);
});

test("compilation cannot inherit configuration from a working directory outside the authenticated runtime", { skip }, async t => {
  const data = await fixture(t);
  await writeFile(join(data.root, "tsconfig.json"), '{"compilerOptions":{"target":"ES2022"}}');
  const result = build(data, "", {}, data.root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /gstack_node_server_build_cwd_required/);
  await noArtifact(data);
});

test("a publication race removes only already-created artifacts and preserves the colliding file", { skip }, async t => {
  const data = await fixture(t), colliding = join(data.output, "browse/dist/bun-polyfill.cjs");
  await mkdir(dirname(colliding), { recursive: true });
  const hook = `const original=Bun.build;let calls=0;Bun.build=async options=>{
    const result=await original(options);if(++calls===2)await Bun.write(${JSON.stringify(colliding)},"concurrent owner bytes");return result;};`;
  const result = build(data, hook);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /EEXIST/);
  await noArtifact(data);
  assert.equal(await readFile(colliding, "utf8"), "concurrent owner bytes");
});
