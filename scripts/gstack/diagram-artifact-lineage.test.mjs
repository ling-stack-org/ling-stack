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
const builder = fileURLToPath(new URL("./build-diagram-resource.mjs", import.meta.url));
const hash = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const base = "lib/diagram-render";

async function fixture(t, producerSuffix = "") {
  const root = await mkdtemp(join(tmpdir(), "ling diagram artifact lineage "));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = join(root, "runtime"), output = join(root, "output");
  await mkdir(output);
  const producer = await readFile(join(input, "runtime", base, "scripts/build.ts"), "utf8") + producerSuffix;
  const sources = [
    [`${base}/scripts/build.ts`, producer],
    [`${base}/package.json`, JSON.stringify({ dependencies: { "fixture-dependency": "1.0.0" } })],
    [`${base}/src/entry.ts`, 'import { value } from "./helper"; import { remote } from "fixture-dependency"; console.log(value, remote, __BUNDLE_INFO_DEPS__, __dirname); throw new Error("diagram must not execute");\n'],
    [`${base}/src/helper.ts`, 'export const value: string = "</script>fixture-diagram";\n'],
  ];
  const files = [];
  for (const [path, bytes] of sources) {
    await mkdir(dirname(join(runtime, path)), { recursive: true });
    await writeFile(join(runtime, path), bytes);
    files.push({ path: `runtime/${path}`, sizeBytes: Buffer.byteLength(bytes), checksum: hash(bytes) });
  }
  const dependency = join(runtime, base, "node_modules/fixture-dependency/index.js");
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
  const program = `import {buildGstackDiagramResource} from ${JSON.stringify(builder)};
    ${before}
    const result=await buildGstackDiagramResource(${JSON.stringify({ ...data.options, ...changes })});
    console.log(JSON.stringify(result));`;
  return spawnSync(compiler, ["--no-env-file", "--no-install", "-e", program], {
    cwd: cwd ?? join(changes.runtimeRoot ?? data.runtime, base),
    env: { ...process.env, BUN_OPTIONS: "", NODE_OPTIONS: "", NODE_PATH: "" },
    encoding: "utf8", timeout: 30_000, maxBuffer: 2 * 1024 ** 2,
  });
}

async function noArtifact(data) {
  for (const name of ["diagram-render.html", "BUILD_INFO.json", "diagram-build-provenance.json"]) {
    await assert.rejects(readFile(join(data.output, base, "dist", name)), { code: "ENOENT" });
  }
}

test("actual upstream diagram assembly binds repeated compilation and emits escaped HTML without running the renderer", { skip }, async t => {
  const data = await fixture(t), result = build(data);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout.trim().split("\n").at(-1));
  assert.equal(report.compiledArtifactBinding, "repeated-upstream-assembly-and-emitted-byte-identity");
  assert.equal(report.releaseEligible, false);
  assert.equal(report.sourceManifestChecksum, data.options.expectedSourceManifestChecksum);
  assert.equal(report.compiler.checksum, data.options.expectedCompilerChecksum);
  assert.ok(report.inputs.some(file => file.path === `${base}/scripts/build.ts`));
  assert.ok(report.inputs.some(file => file.path === `${base}/src/helper.ts`));
  assert.ok(report.inputs.some(file => file.path === `${base}/node_modules/fixture-dependency/package.json`));
  const html = await readFile(join(data.output, base, "dist/diagram-render.html"));
  const info = JSON.parse(await readFile(join(data.output, base, "dist/BUILD_INFO.json")));
  assert.equal(report.artifacts.find(file => file.path.endsWith("diagram-render.html")).checksum, hash(html));
  assert.equal(`sha256:${info.sha256}`, hash(html));
  assert.equal(info.bytes, html.length);
  assert.equal(html.includes(Buffer.from(data.root)), false);
  assert.match(html.toString(), /<base href="https:\/\/gstack-render.localhost\/">/);
  assert.match(html.toString(), /<script type="module">/);
  assert.match(html.toString(), /diagram must not execute/);
  assert.ok(html.toString().includes("<\\/script>fixture-diagram"));
  assert.deepEqual(JSON.parse(await readFile(join(data.output, base, "dist/diagram-build-provenance.json"))), report);
  await assert.rejects(readFile(join(data.runtime, base, "dist/diagram-render.html")), { code: "ENOENT" });
});

test("wrong source/compiler identities and equal-length changed renderer sources reject before publication", { skip }, async t => {
  const data = await fixture(t);
  for (const changes of [
    { expectedSourceManifestChecksum: `sha256:${"0".repeat(64)}` },
    { expectedCompilerChecksum: `sha256:${"0".repeat(64)}` },
  ]) {
    const result = build(data, "", changes);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /gstack_diagram_(?:source_manifest|compiler)_mismatch/);
    await noArtifact(data);
  }
  const helper = join(data.runtime, base, "src/helper.ts");
  await writeFile(helper, (await readFile(helper, "utf8")).replace("fixture-diagram", "changed-diagram"));
  const result = build(data);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /gstack_diagram_source_input_mismatch/);
  await noArtifact(data);
});

test("a dependency mutated by the producer after compilation cannot receive a matching lineage report", { skip }, async t => {
  const data = await fixture(t, '\nawait (await import("node:fs/promises")).writeFile(path.join(ROOT,"node_modules/fixture-dependency/index.js"),\'export const remote = "after!";\\n\');\n');
  const result = build(data);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /gstack_diagram_build_inputs_changed/);
  await noArtifact(data);
});

test("missing required dependencies and manifests fail without executing or publishing the renderer", { skip }, async t => {
  const data = await fixture(t);
  await rm(data.dependency);
  let result = build(data);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /gstack_diagram_compile_failed/);
  await noArtifact(data);
  await rm(data.options.sourceManifestPath);
  result = build(data);
  assert.notEqual(result.status, 0);
  await noArtifact(data);
});

test("existing outputs, linked sources and aliased output directories preserve their owners' bytes", { skip }, async t => {
  const data = await fixture(t), target = join(data.output, base, "dist/diagram-render.html");
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, "user-owned diagram");
  let result = build(data);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /gstack_diagram_output_already_exists/);
  assert.equal(await readFile(target, "utf8"), "user-owned diagram");
  await rm(target);
  const source = join(data.runtime, base, "src/helper.ts"), outside = join(data.root, "outside.ts");
  await rename(source, outside);
  await symlink(outside, source);
  result = build(data);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /(?:file_invalid|graph_path_invalid)/);
  await noArtifact(data);
  const alias = join(data.root, "output-alias");
  await symlink(data.output, alias);
  result = build(data, "", { outputRoot: alias });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /gstack_diagram_output_root_invalid/);
  assert.match(await readFile(outside, "utf8"), /fixture-diagram/);
});

test("only private staging or disjoint managed scratch is writable, and a live lease is required", { skip }, async t => {
  const data = await fixture(t);
  let result = build(data, "", { outputRoot: data.runtime });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /gstack_diagram_private_staging_required/);
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
  await assert.rejects(readFile(join(runtime, base, "dist/diagram-render.html")), { code: "ENOENT" });
  result = build(data, "", changes);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(await readFile(join(runtime, base, "dist/diagram-build-provenance.json"))).releaseEligible, false);
});

test("working directories outside the authenticated diagram project cannot contribute ambient build configuration", { skip }, async t => {
  const data = await fixture(t), result = build(data, "", {}, data.root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /gstack_diagram_build_cwd_required/);
  await noArtifact(data);
});

test("an output collision after compilation cleans only newly created artifacts", { skip }, async t => {
  const data = await fixture(t, '\nawait (await import("node:fs/promises")).writeFile(process.env.LING_GSTACK_TEST_COLLISION,"concurrent owner bytes");\n');
  const colliding = join(data.output, base, "dist/BUILD_INFO.json");
  await mkdir(dirname(colliding), { recursive: true });
  const result = build(data, `process.env.LING_GSTACK_TEST_COLLISION=${JSON.stringify(colliding)};`);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /EEXIST/);
  assert.equal(await readFile(colliding, "utf8"), "concurrent owner bytes");
  for (const name of ["diagram-render.html", "diagram-build-provenance.json"]) {
    await assert.rejects(readFile(join(data.output, base, "dist", name)), { code: "ENOENT" });
  }
});
