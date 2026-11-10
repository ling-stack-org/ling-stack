import "./managed-integration-guard.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const stage = process.env.LING_GSTACK_RESOURCE_STAGE && resolve(process.env.LING_GSTACK_RESOURCE_STAGE);
const skip = !stage && "Set the retained resource stage and use managed supervision";
const bun = stage && join(stage, "runtime/tools/bun");
const producer = fileURLToPath(new URL("./build-node-server-resource.mjs", import.meta.url));
const hash = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

async function fixture(t) {
  const work = await mkdtemp(join(tmpdir(), "ling security sidecar fixture "));
  t.after(() => rm(work, { recursive: true, force: true }));
  const runtime = join(work, "runtime"), output = join(work, "output"), files = [];
  await mkdir(output);
  for (const [path, text] of [
    ["package.json", '{"name":"sidecar-fixture","type":"module"}\n'],
    ["browse/src/security-sidecar-entry.ts", 'import { status } from "./security-classifier"; console.log(status); throw new Error("sidecar must not execute while compiling");\n'],
    ["browse/src/security-classifier.ts", 'export const status: string = "off"; export async function load() { return import("@huggingface/transformers"); }\n'],
  ]) {
    await mkdir(dirname(join(runtime, path)), { recursive: true });
    await writeFile(join(runtime, path), text);
    files.push({ path: `runtime/${path}`, sizeBytes: Buffer.byteLength(text), checksum: hash(text) });
  }
  const pkg = join(runtime, "node_modules/@huggingface/transformers");
  await mkdir(join(pkg, "dist"), { recursive: true });
  await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "@huggingface/transformers", version: "0.0.0-fixture", type: "module",
    exports: { node: { import: { default: "./dist/transformers.node.mjs" } } } }));
  const external = join(pkg, "dist/transformers.node.mjs");
  await writeFile(external, 'throw new Error("external ML dependency must not execute"); export const pipeline = null;\n');
  const manifest = Buffer.from(JSON.stringify({ schemaVersion: 1, deliveryStage: "source", upstream: { revision: "f".repeat(40) }, files }));
  const sourceManifestPath = join(work, "source-manifest.json");
  await writeFile(sourceManifestPath, manifest);
  return { work, runtime, output, pkg, external, options: { runtimeRoot: runtime, outputRoot: output, sourceManifestPath,
    expectedSourceManifestChecksum: hash(manifest), expectedCompilerChecksum: hash(await readFile(bun)) } };
}

function build(data, before = "", changes = {}, cwd) {
  return spawnSync(bun, ["--no-env-file", "--no-install", "-e", `import {buildGstackSecuritySidecarResource} from ${JSON.stringify(producer)};
    ${before}
    console.log(JSON.stringify(await buildGstackSecuritySidecarResource(${JSON.stringify({ ...data.options, ...changes })})));`], {
    cwd: cwd ?? data.runtime, env: { ...process.env, BUN_OPTIONS: "", NODE_OPTIONS: "", NODE_PATH: "" },
    encoding: "utf8", timeout: 30_000, maxBuffer: 2 * 1024 ** 2,
  });
}

async function absent(data) {
  for (const path of ["security-sidecar.js", "security-sidecar-build-provenance.json"]) {
    await assert.rejects(readFile(join(data.output, "browse/dist", path)), { code: "ENOENT" });
  }
}

test("security sidecar producer preserves its own entry and external Node ML dependency without executing either", { skip }, async t => {
  const data = await fixture(t), result = build(data);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.releaseEligible, false);
  assert.equal(report.compiledArtifactBinding, "repeated-compilation-and-emitted-byte-identity");
  assert.equal(report.recipe.entrypoint, "browse/src/security-sidecar-entry.ts");
  assert.deepEqual(report.recipe.external, ["@huggingface/transformers"]);
  assert.equal(report.artifacts.length, 1);
  assert.ok(report.inputs.some(file => file.path === "browse/src/security-classifier.ts"));
  assert.ok(report.externalInputs.some(file => file.path === "node_modules/@huggingface/transformers/dist/transformers.node.mjs"));
  assert.equal(report.inputs.some(file => file.path.startsWith("node_modules/@huggingface/")), false);
  const bytes = await readFile(join(data.output, "browse/dist/security-sidecar.js"));
  assert.equal(report.artifacts[0].checksum, hash(bytes));
  assert.match(bytes.toString(), /sidecar must not execute/);
  assert.equal(bytes.includes(Buffer.from(data.work)), false);
  assert.deepEqual(JSON.parse(await readFile(join(data.output, "browse/dist/security-sidecar-build-provenance.json"))), report);
  await assert.rejects(readFile(join(data.output, "browse/dist/bun-polyfill.cjs")), { code: "ENOENT" });
});

test("missing, linked or remapped external ML runtime rejects even though Bun externalizes the import", { skip }, async t => {
  const data = await fixture(t), original = await readFile(data.external);
  await rm(data.external);
  let result = build(data);
  assert.notEqual(result.status, 0);
  await absent(data);
  const outside = join(data.work, "external.mjs");
  await writeFile(outside, original);
  await symlink(outside, data.external);
  result = build(data);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /file_invalid/);
  await absent(data);
  await rm(data.external);
  await writeFile(data.external, original);
  const metadata = JSON.parse(await readFile(join(data.pkg, "package.json")));
  metadata.exports.node.import.default = "./dist/transformers.web.js";
  await writeFile(join(data.pkg, "package.json"), JSON.stringify(metadata));
  result = build(data);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /gstack_security_sidecar_external_entry_invalid/);
  await absent(data);
});

test("security sidecar source and detached compiler/source identities cannot be substituted", { skip }, async t => {
  const data = await fixture(t);
  for (const changes of [
    { expectedCompilerChecksum: `sha256:${"0".repeat(64)}` },
    { expectedSourceManifestChecksum: `sha256:${"0".repeat(64)}` },
  ]) {
    const result = build(data, "", changes);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /gstack_security_sidecar_(?:compiler|source_manifest)_mismatch/);
    await absent(data);
  }
  const path = join(data.runtime, "browse/src/security-classifier.ts");
  await writeFile(path, (await readFile(path, "utf8")).replace('"off"', '"bad"'));
  const result = build(data);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /gstack_security_sidecar_source_input_mismatch/);
  await absent(data);
});

test("external runtime mutations between the two real compiles cannot receive a current sidecar receipt", { skip }, async t => {
  const data = await fixture(t);
  const result = build(data, `const original=Bun.build; let calls=0; Bun.build=async options=>{
    const result=await original(options); if(++calls===2) await Bun.write(${JSON.stringify(data.external)},"changed external bytes"); return result; };`);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /gstack_security_sidecar_build_inputs_changed/);
  await absent(data);
});

test("sidecar output, lease and working-directory guards preserve retained and unrelated data", { skip }, async t => {
  const data = await fixture(t);
  for (const [before, changes, cwd, error] of [
    ["delete process.env.LING_GSTACK_RESOURCE_TOKEN;", {}, undefined, /gstack_resource_lease_required/],
    ["", { outputRoot: data.runtime }, undefined, /gstack_security_sidecar_private_staging_required/],
    ["", {}, data.work, /gstack_security_sidecar_build_cwd_required/],
  ]) {
    const result = build(data, before, changes, cwd);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, error);
    await absent(data);
  }
  const output = join(data.output, "browse/dist/security-sidecar.js");
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, "other owner");
  const result = build(data);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /gstack_security_sidecar_output_already_exists/);
  assert.equal(await readFile(output, "utf8"), "other owner");
});

test("a colliding sidecar receipt removes only the executable created by this attempt", { skip }, async t => {
  const data = await fixture(t), receipt = join(data.output, "browse/dist/security-sidecar-build-provenance.json");
  await mkdir(dirname(receipt), { recursive: true });
  const result = build(data, `const original=Bun.build; let calls=0; Bun.build=async options=>{
    const result=await original(options); if(++calls===2) await Bun.write(${JSON.stringify(receipt)},"other receipt"); return result; };`);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /EEXIST/);
  await assert.rejects(readFile(join(data.output, "browse/dist/security-sidecar.js")), { code: "ENOENT" });
  assert.equal(await readFile(receipt, "utf8"), "other receipt");
});
