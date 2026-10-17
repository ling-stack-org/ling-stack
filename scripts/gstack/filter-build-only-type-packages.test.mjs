import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { filterGstackBuildOnlyTypePackages } from "./filter-build-only-type-packages.mjs";

const hash = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const packagePath = "node_modules/bun-types";
const scopes = ["client-command-imports", "native-build-imports", "node-browser-build-imports", "diagram-build-imports", "security-sidecar-build-imports"];

async function fixture(t) {
  const parent = await mkdtemp(join(tmpdir(), "gstack-type-selection-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const stage = await mkdtemp(join(parent, ".gstack-resource-stage-"));
  const candidate = join(stage, "candidate"), runtime = join(candidate, "runtime");
  async function write(path, text) {
    const absolute = join(candidate, path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, text);
    return { path, checksum: hash(text), sizeBytes: Buffer.byteLength(text) };
  }
  const files = [];
  for (const [path, text] of [
    ["runtime/bin/gstack-fixture", '#!/usr/bin/env bun\nthrow new Error("client must not execute");\n'],
    ["runtime/bun.lock", '{"bun-types":"1.4.2"}\n'],
    ["runtime/lib/helper.ts", 'export const value = "preserved";\n'],
  ]) files.push(await write(path, text));
  const source = { schemaVersion: 1, deliveryStage: "source", upstream: { revision: "a".repeat(40) }, files };
  const sourceBytes = JSON.stringify(source);
  await write("source-manifest.json", sourceBytes);
  const native = { schemaVersion: 1, deliveryStage: "native-dependencies", upstreamRevision: source.upstream.revision,
    sourceManifestChecksum: hash(sourceBytes), target: { platform: "darwin", arch: "arm64" }, components: [] };
  await write("native-build.json", JSON.stringify(native));
  const metadata = { name: "bun-types", version: "1.4.2", license: "MIT", types: "./index.d.ts",
    dependencies: { "@types/node": "*" } };
  const metadataBytes = JSON.stringify(metadata);
  await write(`runtime/${packagePath}/package.json`, metadataBytes);
  await write(`runtime/${packagePath}/index.d.ts`, "declare const testType: string;\n");
  await write(`runtime/${packagePath}/docs/runtime.mdx`, "# Runtime documentation\n");
  const protectedFiles = [
    await write("runtime/tools/bun", "Bun executable preserved\n"),
    await write("runtime/node_modules/@types/node/index.d.ts", "declare const nodeType: string;\n"),
  ];
  const inputs = [files[0], files[2]].map(file => ({ path: file.path.slice(8), checksum: file.checksum, sizeBytes: file.sizeBytes }));
  const importReports = scopes.map(dependencyScope => ({ dependencyScope, sourceManifestChecksum: hash(sourceBytes),
    compilerChecksum: hash("fixture compiler"), inputs, inputGraphChecksum: hash(JSON.stringify(inputs)) }));
  const review = { schemaVersion: 1, target: native.target, sourceManifestChecksum: hash(sourceBytes),
    upstreamRevision: source.upstream.revision, sourceFileCount: files.length, marker: "bun-types", compilerChecksum: hash("fixture compiler"),
    importGraphs: importReports.map(({ dependencyScope, inputGraphChecksum }) => ({ dependencyScope, inputGraphChecksum })),
    references: [{ path: "runtime/bun.lock", checksum: files[1].checksum, classification: "upstream-dependency-metadata" }],
    packages: [{ path: packagePath, name: metadata.name, version: metadata.version, metadataChecksum: hash(metadataBytes) }] };
  const reviewPath = join(parent, "review.json");
  const options = { runtimeRoot: runtime, stagingRoot: stage, target: native.target,
    expectedNativeBuildChecksum: hash(JSON.stringify(native)), importReports, reviewPath };
  async function rebindPackage() {
    const inventory = [];
    async function walk(prefix = "") {
      for (const entry of await readdir(join(runtime, packagePath, prefix), { withFileTypes: true })) {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await walk(path);
        else {
          const bytes = await readFile(join(runtime, packagePath, path));
          inventory.push({ path, sizeBytes: bytes.length, checksum: hash(bytes) });
        }
      }
    }
    await walk();
    inventory.sort((a, b) => a.path.localeCompare(b.path, "en"));
    Object.assign(review.packages[0], { fileCount: inventory.length, sizeBytes: inventory.reduce((n, file) => n + file.sizeBytes, 0),
      inventoryChecksum: hash(JSON.stringify(inventory)), metadataChecksum: hash(await readFile(join(runtime, packagePath, "package.json"))) });
  }
  async function rebind() {
    const sourceBytes = JSON.stringify(source);
    await writeFile(join(candidate, "source-manifest.json"), sourceBytes);
    native.sourceManifestChecksum = review.sourceManifestChecksum = hash(sourceBytes);
    await writeFile(join(candidate, "native-build.json"), JSON.stringify(native));
    for (const graph of importReports) graph.sourceManifestChecksum = review.sourceManifestChecksum;
    await writeFile(reviewPath, JSON.stringify(review));
    options.expectedNativeBuildChecksum = hash(JSON.stringify(native));
    options.expectedReviewChecksum = hash(JSON.stringify(review));
  }
  await rebindPackage();
  await rebind();
  return { parent, candidate, stage, runtime, write, source, metadata, protectedFiles, review, options, rebind, rebindPackage };
}

test("type-only exclusion removes the exact reviewed package, preserving executable, other declarations and source bodies", async t => {
  const f = await fixture(t);
  const result = await filterGstackBuildOnlyTypePackages(f.options);
  assert.equal(result.selectionScope, "reviewed-build-only-type-packages");
  assert.equal(result.excludedPackages.length, 1);
  assert.equal(result.removedResources.length, 3);
  assert.equal(result.reviewedReferenceCount, 1);
  assert.equal(result.releaseEligible, false);
  assert.equal(result.completeRuntimeSelection, "pending");
  await assert.rejects(readFile(join(f.runtime, packagePath, "package.json")), { code: "ENOENT" });
  for (const file of [...f.source.files, ...f.protectedFiles]) assert.equal(hash(await readFile(join(f.candidate, file.path))), file.checksum);
});

test("type-only filtering refuses retained roots, aliases, wrong targets and detached input drift before unlink", async t => {
  const f = await fixture(t);
  await assert.rejects(filterGstackBuildOnlyTypePackages({ ...f.options, stagingRoot: f.parent }), /private_staging_required/);
  const alias = join(f.parent, ".gstack-resource-stage-alias");
  await symlink(f.stage, alias, "dir");
  await assert.rejects(filterGstackBuildOnlyTypePackages({ ...f.options, stagingRoot: alias }), /private_staging_required/);
  await assert.rejects(filterGstackBuildOnlyTypePackages({ ...f.options, target: { platform: "win32", arch: "x64" } }), /target_not_reviewed/);
  await assert.rejects(filterGstackBuildOnlyTypePackages({ ...f.options, expectedReviewChecksum: hash("changed") }), /review_mismatch/);
  await assert.rejects(filterGstackBuildOnlyTypePackages({ ...f.options, expectedNativeBuildChecksum: hash("changed") }), /native_receipt_mismatch/);
  assert.ok(await readFile(join(f.runtime, packagePath, "package.json")));
});

test("changed declaration bytes, omitted files and extra executable files reject exact inventory review", async t => {
  const f = await fixture(t);
  const path = join(f.runtime, packagePath, "index.d.ts"), original = await readFile(path);
  await writeFile(path, original.toString().replace("testType", "evilType"));
  await assert.rejects(filterGstackBuildOnlyTypePackages(f.options), /inventory_not_reviewed/);
  await rm(path);
  await assert.rejects(filterGstackBuildOnlyTypePackages(f.options), /inventory_not_reviewed/);
  await writeFile(path, original);
  await f.write(`runtime/${packagePath}/runtime.js`, 'throw new Error("never execute");\n');
  await f.rebindPackage();
  await f.rebind();
  await assert.rejects(filterGstackBuildOnlyTypePackages(f.options), /non_type_resource/);
  assert.ok(await readFile(join(f.runtime, packagePath, "package.json")));
});

test("a runtime export, wrong type entry or version cannot be accepted by rebinding package metadata", async t => {
  const f = await fixture(t);
  for (const patch of [{ bin: { tool: "index.d.ts" } }, { main: "index.d.ts" }, { exports: "./index.d.ts" },
    { types: "./runtime.js" }, { version: "1.4.3" }]) {
    await writeFile(join(f.runtime, packagePath, "package.json"), JSON.stringify({ ...f.metadata, ...patch }));
    await f.rebindPackage();
    await f.rebind();
    await assert.rejects(filterGstackBuildOnlyTypePackages(f.options), /metadata_not_reviewed/);
  }
});

test("a type package input in any compiler graph rejects even with a rebound graph review", async t => {
  const f = await fixture(t);
  await assert.rejects(filterGstackBuildOnlyTypePackages({ ...f.options, importReports: f.options.importReports.slice(1) }), /import_coverage_required/);
  await assert.rejects(filterGstackBuildOnlyTypePackages({ ...f.options, importReports: f.options.importReports.slice(0, -1) }), /import_coverage_required/);
  const bytes = await readFile(join(f.runtime, packagePath, "index.d.ts"));
  const graph = f.options.importReports.at(-1);
  graph.inputs = [{ path: `${packagePath}/index.d.ts`, sizeBytes: bytes.length, checksum: hash(bytes) }];
  graph.inputGraphChecksum = f.review.importGraphs.at(-1).inputGraphChecksum = hash(JSON.stringify(graph.inputs));
  await f.rebind();
  await assert.rejects(filterGstackBuildOnlyTypePackages(f.options), /required_import/);
  assert.ok(await readFile(join(f.runtime, packagePath, "package.json")));
});

test("new source references and equal-length source mutation reject stale classification", async t => {
  const f = await fixture(t);
  const path = join(f.runtime, "bin/gstack-fixture"), original = await readFile(path);
  await writeFile(path, original.toString().replace("client", "mutate"));
  await assert.rejects(filterGstackBuildOnlyTypePackages(f.options), /source_changed/);
  await writeFile(path, original);
  f.source.files.push(await f.write("runtime/bin/new-reader", 'readFileSync("node_modules/bun-types/index.d.ts");\n'));
  f.review.sourceFileCount++;
  await f.rebind();
  await assert.rejects(filterGstackBuildOnlyTypePackages(f.options), /unreviewed_reference/);
  assert.ok(await readFile(join(f.runtime, packagePath, "package.json")));
});

test("linked or missing resources never cause partial type-package deletion", async t => {
  const f = await fixture(t);
  const path = join(f.runtime, packagePath, "index.d.ts");
  await rm(path);
  await symlink(join(f.runtime, "lib/helper.ts"), path);
  await assert.rejects(filterGstackBuildOnlyTypePackages(f.options), /linked_resource/);
  await rm(path);
  await rm(join(f.runtime, packagePath), { recursive: true });
  await assert.rejects(filterGstackBuildOnlyTypePackages(f.options), { code: "ENOENT" });
  assert.ok(await readFile(join(f.runtime, "tools/bun")));
});
