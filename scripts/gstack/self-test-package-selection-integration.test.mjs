import "./managed-integration-guard.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";
import { filterGstackUpstreamSelfTestPackages } from "./filter-upstream-self-test-packages.mjs";
import { filterGstackBuildOnlyTypePackages } from "./filter-build-only-type-packages.mjs";
import { verifyGstackBundledBuildImports, verifyGstackClientCommandImports } from "./verify-shared-command-closure.mjs";
import { resourceCheckpoint, resourceTreeBytes } from "./resource-workspace.mjs";

const input = process.env.LING_GSTACK_RESOURCE_STAGE && resolve(process.env.LING_GSTACK_RESOURCE_STAGE);
const skip = !input && "Set the retained reviewed resource stage; this test requires the managed lease";
const hash = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const expectedSource = "sha256:2921f0cfd111004b078f33b50b91efb053e5d81a661f9fc9473c9ff0e2dcbf8d";
const expectedNative = "sha256:65eb00f9b33dffaa561804ae47e0207f9005b9b1e9c9c0ccf04078c3b5c61964";
const expectedCompiler = "sha256:35d20dd0263e5c950194434b925454fdfa9ba6e4467da960410fa05b08a7a5b5";
const sdkPaths = ["node_modules/@anthropic-ai/claude-agent-sdk", "node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64"];
const typePath = "node_modules/bun-types";

test("frozen real command/build imports remain identical after separate self-test and type-only exclusions in a bounded thin mirror", { skip }, async t => {
  const stage = await realpath(await mkdtemp(join(tmpdir(), ".gstack-resource-stage-")));
  t.after(() => rm(stage, { recursive: true, force: true }));
  const candidate = join(stage, "candidate"), runtime = join(candidate, "runtime");
  const sourceBytes = await readFile(join(input, "source-manifest.json"));
  const nativeBytes = await readFile(join(input, "native-build.json"));
  assert.equal(hash(sourceBytes), expectedSource);
  assert.equal(hash(nativeBytes), expectedNative);
  const resourceBytes = await readFile(join(input, "resource-stage.json"));
  assert.equal(hash(resourceBytes), "sha256:ab63d645623de138a7bec3b0cf4a58271fadf6f25b907b1c313ae314e38d818b");
  const source = JSON.parse(sourceBytes), native = JSON.parse(nativeBytes);
  const originalOptions = { runtimeRoot: join(input, "runtime"), bunPath: join(input, "runtime/tools/bun"),
    expectedBunChecksum: expectedCompiler, expectedSourceManifestChecksum: expectedSource };
  const before = [await verifyGstackClientCommandImports(originalOptions), ...await verifyGstackBundledBuildImports(originalOptions)];
  const toolPaths = ["filter-upstream-self-test-packages.mjs", "reviewed-upstream-self-test-packages.json",
    "verify-shared-command-closure.mjs", "prepare-platform-resource-stage.mjs",
    "filter-upstream-self-test-packages.test.mjs", "self-test-package-selection-integration.test.mjs"];
  toolPaths.push("filter-reviewed-build-packages.mjs", "filter-build-only-type-packages.mjs",
    "reviewed-build-only-type-packages.json", "filter-build-only-type-packages.test.mjs");
  const tools = async () => Promise.all(toolPaths.map(async path => ({ path: `scripts/gstack/${path}`,
    checksum: hash(await readFile(new URL(path, import.meta.url))) })));
  const toolInputs = await tools();
  const paths = new Set([...source.files.map(file => file.path), "source-manifest.json", "native-build.json", "runtime/tools/bun",
    ...before.flatMap(graph => graph.inputs.map(file => `runtime/${file.path}`))]);
  // A metafile omits tree-shaken exports, but resolving them still needs their
  // files. Mirror complete used packages and installed dependency/peer closures;
  // this is a bounded test fixture, not the production runtime selection policy.
  const packages = new Set();
  for (const path of paths) {
    const index = path.lastIndexOf("/node_modules/");
    if (index < 0) continue;
    const prefix = path.slice(0, index + 14), parts = path.slice(index + 14).split("/");
    packages.add(prefix + parts.slice(0, parts[0].startsWith("@") ? 2 : 1).join("/"));
  }
  const hasMetadata = async path => lstat(join(input, path, "package.json")).then(stat => {
    assert.ok(stat.isFile() && !stat.isSymbolicLink(), path);
    return true;
  }, error => { if (error.code === "ENOENT") return false; throw error; });
  for (const path of packages) {
    assert.ok(packages.size < 1000, "test package closure exceeds limit");
    const pkg = JSON.parse(await readFile(join(input, path, "package.json")));
    const names = new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.optionalDependencies ?? {}),
      ...Object.keys(pkg.peerDependencies ?? {})]);
    for (const name of names) {
      assert.match(name, /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i);
      let directory = path, found;
      while (directory !== ".") {
        const target = join(directory, "node_modules", name);
        if (basename(directory) !== "node_modules" && await hasMetadata(target)) { found = target; break; }
        directory = dirname(directory);
      }
      if (found) packages.add(found);
      else assert.ok(!pkg.dependencies?.[name] || pkg.optionalDependencies?.[name], `missing dependency: ${path}: ${name}`);
    }
  }
  async function collect(directory, skipNestedDependencies) {
    for (const entry of await readdir(join(input, directory), { withFileTypes: true })) {
      if (skipNestedDependencies && entry.name === "node_modules") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await collect(path, skipNestedDependencies);
      else { assert.ok(entry.isFile() && !entry.isSymbolicLink(), path); paths.add(path); }
    }
  }
  for (const path of packages) await collect(path, true);
  const protectedPackages = [];
  for (const path of [...sdkPaths, typePath]) {
    protectedPackages.push({ path, metadataChecksum: hash(await readFile(join(input, "runtime", path, "package.json"))) });
    await collect(`runtime/${path}`, false);
  }
  assert.ok(paths.size < 100_000, "test file count exceeds limit");
  let mirrorFileBytes = 0;
  for (const path of paths) {
    const stat = await lstat(join(input, path));
    assert.ok(stat.isFile() && !stat.isSymbolicLink(), path);
    mirrorFileBytes += stat.size;
  }
  const estimatedScratchBytes = mirrorFileBytes + 4096 * (paths.size + 1);
  assert.ok(estimatedScratchBytes < 1024 ** 3, `thin mirror exceeds 1 GiB before copying: ${estimatedScratchBytes}`);
  await resourceCheckpoint(process.env.LING_GSTACK_RESOURCE_ROOT, estimatedScratchBytes);
  let proof;
  try {
    for (const path of paths) {
      await mkdir(dirname(join(candidate, path)), { recursive: true });
      await copyFile(join(input, path), join(candidate, path), constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL);
    }
    const peakScratchBytes = await resourceTreeBytes(stage);
    assert.ok(peakScratchBytes >= mirrorFileBytes && peakScratchBytes <= estimatedScratchBytes,
      `unexpected directory overhead: ${peakScratchBytes - mirrorFileBytes}`);
    assert.ok(peakScratchBytes < 1024 ** 3, `thin mirror exceeds 1 GiB: ${peakScratchBytes}`);
    await resourceCheckpoint(process.env.LING_GSTACK_RESOURCE_ROOT);
    const selected = await filterGstackUpstreamSelfTestPackages({ runtimeRoot: runtime, stagingRoot: stage,
      expectedNativeBuildChecksum: expectedNative, target: native.target, importReports: before });
    assert.equal(selected.sourceFileCount, 3714);
    assert.equal(selected.reviewedReferenceCount, 29);
    assert.equal(selected.excludedPackages.length, 2);
    for (const path of sdkPaths) await assert.rejects(lstat(join(runtime, path)), { code: "ENOENT" });
    const typeSelected = await filterGstackBuildOnlyTypePackages({ runtimeRoot: runtime, stagingRoot: stage,
      expectedNativeBuildChecksum: expectedNative, target: native.target, importReports: before });
    assert.equal(typeSelected.reviewedReferenceCount, 1);
    assert.equal(typeSelected.excludedPackages.length, 1);
    assert.equal(typeSelected.removedResources.length, 368);
    assert.equal(typeSelected.removedSizeBytes, 2967599);
    await assert.rejects(lstat(join(runtime, typePath)), { code: "ENOENT" });
    assert.equal(hash(await readFile(join(runtime, "tools/bun"))), expectedCompiler);
    const afterOptions = { ...originalOptions, runtimeRoot: runtime, bunPath: join(runtime, "tools/bun") };
    const after = [await verifyGstackClientCommandImports(afterOptions), ...await verifyGstackBundledBuildImports(afterOptions)];
    assert.deepEqual(after.map(graph => graph.inputGraphChecksum), before.map(graph => graph.inputGraphChecksum));
    assert.deepEqual(after.slice(0, 4).map(graph => graph.inputs.length), [274, 416, 81, 982]);
    assert.equal(after.at(-1).dependencyScope, "security-sidecar-build-imports");
    assert.ok(after.at(-1).inputs.some(input => input.path === "browse/src/security-classifier.ts"));
    assert.equal(after[0].bunCommandCount, 57);
    assert.equal(after[0].entrypoints.length, 58);
    assert.equal(source.skills.length, 57);
    for (const skill of source.skills) {
      assert.equal(hash(await readFile(join(candidate, skill.entryPath))), hash(await readFile(join(input, skill.entryPath))), skill.id);
    }
    assert.equal(hash(await readFile(join(runtime, "node_modules/@anthropic-ai/sdk/index.mjs"))),
      before[0].inputs.find(file => file.path === "node_modules/@anthropic-ai/sdk/index.mjs").checksum);
    for (const pkg of protectedPackages) assert.equal(hash(await readFile(join(input, "runtime", pkg.path, "package.json"))), pkg.metadataChecksum);
    assert.deepEqual(await tools(), toolInputs);
    assert.equal(hash(await readFile(join(input, "native-build.json"))), expectedNative);
    assert.equal(hash(await readFile(join(input, "source-manifest.json"))), expectedSource);
    assert.equal(hash(await readFile(join(input, "resource-stage.json"))), hash(resourceBytes));
    proof = { schemaVersion: 1, deliveryStage: "resource-prerequisites", releaseEligible: false,
      verificationScope: "thin-mirror-source-import-and-package-exclusion-only", completeResourcePreparation: "pending",
      compiledArtifactBinding: "pending", toolInputs, protectedPackages,
      retainedResourceChecksum: hash(resourceBytes), selected, buildOnlyTypeSelection: typeSelected, peakScratchBytes,
      mirrorPackageCount: packages.size, mirrorFileCount: paths.size, mirrorFileBytes, estimatedScratchBytes,
      retainedScratchBytesBeforeCleanup: await resourceTreeBytes(stage),
      afterGraphs: after.map(({ dependencyScope, inputGraphChecksum, inputs }) => ({ dependencyScope, inputGraphChecksum, inputCount: inputs.length })),
      preservedSkillBodies: source.skills.length, cleanup: "pending" };
  } finally { await rm(stage, { recursive: true, force: true }); }
  await assert.rejects(lstat(stage), { code: "ENOENT" });
  proof.cleanup = "complete";
  if (process.env.LING_GSTACK_SELECTION_PROOF_OUTPUT) {
    const output = resolve(process.env.LING_GSTACK_SELECTION_PROOF_OUTPUT);
    assert.equal(output, join(process.env.LING_GSTACK_RESOURCE_ROOT, "artifacts/report/self-test-package-selection-proof.json"));
    const bytes = Buffer.from(`${JSON.stringify(proof, null, 2)}\n`);
    await writeFile(output, bytes, { flag: "wx" });
    t.diagnostic(JSON.stringify({ proofPath: output, checksum: hash(bytes), sizeBytes: bytes.length,
      removedSizeBytes: proof.selected.removedSizeBytes, peakScratchBytes: proof.peakScratchBytes, cleanup: proof.cleanup }));
  }
});
