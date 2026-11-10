import "./managed-integration-guard.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { cp, lstat, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { prepareGstackPlatformResourceStage } from "./prepare-platform-resource-stage.mjs";
import { REVIEWED_GSTACK_NOTICE_CATALOG_CHECKSUM } from "./install-reviewed-notices.mjs";
import { REVIEWED_PUBLIC_DOMAIN_CATALOG_CHECKSUM } from "./public-domain-package-review.mjs";
import { auditGstackRuntimeDependencies } from "./runtime-dependency-audit.mjs";
import { PINNED_SHELL_DEPENDENCY_REVIEW_CHECKSUM } from "./verify-reviewed-shell-dependencies.mjs";

const stage = process.env.LING_GSTACK_PLATFORM_RESOURCE_STAGE ? resolve(process.env.LING_GSTACK_PLATFORM_RESOURCE_STAGE) : undefined;
const native = process.env.LING_GSTACK_NATIVE_CANDIDATE ? resolve(process.env.LING_GSTACK_NATIVE_CANDIDATE) : undefined;
const parserPath = process.env.LING_GSTACK_SHELL_AST_PARSER && resolve(process.env.LING_GSTACK_SHELL_AST_PARSER);
const expectedParserChecksum = process.env.LING_GSTACK_SHELL_AST_PARSER_CHECKSUM;
const parserOptions = { parserPath, expectedParserChecksum };
const skip = !(stage && native && parserPath && expectedParserChecksum) && "Set the target resource/native stages and detached build-only AST parser identity";
const checksum = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
async function fileChecksum(path) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return `sha256:${hash.digest("hex")}`;
}

test("resource preparation records every reviewed source and dynamic site without runtime approval", { skip }, async () => {
  const record = JSON.parse(await readFile(join(stage, "resource-stage.json"), "utf8"));
  const bytes = await readFile(join(stage, "reviewed-shell-dependencies.json"));
  const review = JSON.parse(bytes);
  assert.equal(review.reviewChecksum, PINNED_SHELL_DEPENDENCY_REVIEW_CHECKSUM);
  assert.equal(review.sourceSites.length, 128);
  assert.equal(review.dynamicEvaluationSites.length, 26);
  assert.equal(review.resources.length, 20);
  assert.equal(review.sourceSites.filter(site => site.classification === "bundled-resource").length, 127);
  assert.equal(review.sourceSites.filter(site => site.classification === "generated-state").length, 1);
  assert.equal(review.unresolvedCommandExpressions, 270);
  assert.equal(review.releaseEligible, false);
  assert.equal(review.dependencyClosure, "pending");
  assert.equal(review.hostAcceptance, "pending");
  assert.equal(review.packageAcceptance, "pending");
  assert.equal(review.sourceManifestChecksum, await fileChecksum(join(stage, "source-manifest.json")));
  assert.equal(record.shellDependencyReviewChecksum, checksum(bytes));
  assert.equal(record.shellDependencyReviewCatalogChecksum, PINNED_SHELL_DEPENDENCY_REVIEW_CHECKSUM);
  assert.equal(record.shellReviewedSourceSiteCount, 128);
  assert.equal(record.shellReviewedDynamicSiteCount, 26);
  assert.equal(record.shellReviewedResourceCount, 20);
  assert.equal(record.shellDependencyReviewGraphChecksum, review.reviewGraphChecksum);
  for (const resource of review.resources) assert.equal(resource.checksum, await fileChecksum(join(stage, "runtime", resource.path)));
  for (const site of [...review.sourceSites, ...review.dynamicEvaluationSites]) {
    assert.equal(site.runtimeControlAcceptance, "pending");
    assert.equal(site.consumerChecksum, await fileChecksum(join(stage, "runtime", site.consumerPath)));
  }
});

test("resource preparation records the complete pinned shell census and reviewed helper edges", { skip }, async () => {
  const record = JSON.parse(await readFile(join(stage, "resource-stage.json"), "utf8"));
  const shell = JSON.parse(await readFile(join(stage, "shell-resource-prerequisites.json"), "utf8"));
  assert.equal(shell.releaseEligible, false);
  assert.equal(shell.hostAcceptance, "pending");
  assert.equal(shell.packageAcceptance, "pending");
  assert.equal(shell.validationMode, "parse-only");
  assert.equal(shell.upstreamRevision, record.upstreamRevision);
  assert.equal(shell.sourceManifestChecksum, await fileChecksum(join(stage, "source-manifest.json")));
  assert.equal(shell.scripts.length, 136);
  assert.equal(record.shellScriptCount, 136);
  assert.equal(record.shellSourceEdgeCount, shell.sourceEdges.length);
  assert.equal(record.shellPrerequisiteChecksum, await fileChecksum(join(stage, "shell-resource-prerequisites.json")));
  assert.equal(shell.scriptGraphChecksum, checksum(JSON.stringify(shell.scripts)));
  assert.equal(shell.sourceEdgeGraphChecksum, checksum(JSON.stringify(shell.sourceEdges)));
  for (const script of shell.scripts) {
    assert.equal(script.checksum, await fileChecksum(join(stage, "runtime", script.path)), script.path);
  }
  assert.ok(shell.scripts.some(script => script.path === "gstack-upgrade/migrations/v1.91.65.0.sh"));
  assert.ok(shell.sourceEdges.some(edge => edge.consumerPath === "bin/gstack-lease" && edge.path === "bin/gstack-harness-pid.sh"));
  assert.ok(shell.pendingGates.includes("complete-shell-and-dynamic-resource-closure"));
});

test("real target staging preserves all skill sources and independently hashed resources without executable approval", { skip }, async () => {
  const record = JSON.parse(await readFile(join(stage, "resource-stage.json"), "utf8"));
  assert.equal(record.deliveryStage, "resource-prerequisites");
  assert.equal(record.hostAcceptance, "pending");
  assert.equal(record.packageAcceptance, "pending");
  assert.equal(record.releaseEligible, false);
  assert.deepEqual(record.target, { platform: process.platform, arch: process.arch });
  assert.equal(record.inputNativeBuildChecksum, await fileChecksum(join(native, "native-build.json")));
  const inventoryBytes = await readFile(join(stage, "resource-inventory.json"));
  assert.equal(checksum(inventoryBytes), record.inventoryChecksum);
  const inventory = JSON.parse(inventoryBytes);
  assert.equal(inventory.files.length, record.fileCount);
  const files = new Map(inventory.files.map(file => [file.path, file]));
  for (const file of inventory.files) {
    const path = join(stage, file.path);
    const stat = await lstat(path);
    assert.equal(stat.isSymbolicLink(), false, file.path);
    assert.equal(stat.size, file.sizeBytes, file.path);
    assert.equal(await fileChecksum(path), file.checksum, file.path);
  }
  const source = JSON.parse(await readFile(join(stage, "source-manifest.json"), "utf8"));
  const components = new Map(JSON.parse(await readFile(join(stage, "native-build.json"), "utf8")).components.map(file => [file.path, file]));
  assert.equal(source.skills.length, 57);
  for (const file of source.files) {
    assert.equal(files.get(file.path)?.checksum, components.get(file.path)?.checksum ?? file.checksum, file.path);
  }
  const filter = JSON.parse(await readFile(join(stage, "platform-resource-filter.json"), "utf8"));
  assert.ok(filter.removedResources.length > 0);
  if (process.platform === "darwin" && process.arch === "arm64") {
    assert.equal(filter.removedResources.length, 14);
    assert.equal(filter.removedSizeBytes, 184081728);
  }
  for (const file of filter.removedResources) {
    await assert.rejects(lstat(join(stage, "runtime", file.path)), { code: "ENOENT" });
    assert.equal(await fileChecksum(join(native, "runtime", file.path)), file.checksum);
  }
  for (const file of filter.retainedResources) {
    assert.equal(await fileChecksum(join(stage, "runtime", file.path)), await fileChecksum(join(native, "runtime", file.path)));
  }
  const audit = JSON.parse(await readFile(join(stage, "dependency-audit.json"), "utf8"));
  assert.equal(audit.links.length, 0);
  if (process.platform === "darwin" && process.arch === "arm64") assert.equal(audit.nativeComponents.length, 8);
  assert.equal(audit.blockers.some(b => b.code === "dependency_native_target_mismatch"), false);
  const khroma = audit.packages.find(p => p.name === "khroma");
  assert.equal(khroma.license, "MIT");
  assert.equal(khroma.metadataLicense, "Unknown");
  assert.equal(khroma.licenseEvidence.length, 1);
  assert.equal(audit.checksPassed, false);
  const shared = JSON.parse(await readFile(join(stage, "shared-command-closure.json"), "utf8"));
  assert.equal(shared.releaseEligible, false);
  assert.equal(shared.dependencyScope, "client-command-imports");
  assert.equal(record.sharedCommandDependencyScope, shared.dependencyScope);
  assert.equal(shared.runtimeResourceSelection, "pending");
  assert.equal(shared.dynamicPaidEntrypoints, 0);
  assert.equal(shared.unselectedSelfTestEntrypoints.length, 108);
  assert.equal(shared.entrypoints.length, record.sharedCommandEntrypoints);
  assert.equal(shared.bunCommandCount, 57);
  assert.equal(record.sharedCommandBunCommandCount, shared.bunCommandCount);
  assert.equal(shared.entrypoints.length, 58);
  assert.equal(shared.inputs.length, record.sharedCommandInputCount);
  assert.equal(shared.inputGraphChecksum, record.sharedCommandGraphChecksum);
  assert.deepEqual(shared.dynamicChildEntrypoints, []);
  assert.ok(shared.entrypoints.includes("bin/gstack-claude-code"));
  assert.equal(shared.inputs.some(input => input.path.includes("@anthropic-ai/claude-agent-sdk")), false);
  assert.equal(shared.dynamicResources.length, 7);
  assert.equal(record.sharedCommandDynamicResourceCount, 7);
  assert.equal(shared.dynamicResourceGraphChecksum, record.sharedCommandDynamicResourceGraphChecksum);
  assert.equal(checksum(JSON.stringify(shared.dynamicResources)), record.sharedCommandDynamicResourceGraphChecksum);
  for (const resource of shared.dynamicResources) {
    assert.equal(files.get(`runtime/${resource.path}`)?.checksum, resource.checksum, resource.path);
    assert.equal(files.get(`runtime/${resource.consumerPath}`)?.checksum, resource.consumerChecksum, resource.consumerPath);
  }
  for (const input of shared.inputs) assert.equal(files.get(`runtime/${input.path}`)?.checksum, input.checksum, input.path);
  const buildBytes = await readFile(join(stage, "bundled-build-imports.json"));
  assert.equal(checksum(buildBytes), record.bundledBuildImportChecksum);
  const builds = JSON.parse(buildBytes);
  assert.deepEqual(builds.map(({ dependencyScope, inputGraphChecksum, compiledArtifactBinding }) => ({
    dependencyScope, inputGraphChecksum, compiledArtifactBinding,
  })), record.bundledBuildImportScopes);
  assert.deepEqual(builds.map(build => build.compilationTarget), ["bun", "node", "browser", "node"]);
  assert.equal(builds.at(-1).dependencyScope, "security-sidecar-build-imports");
  for (const build of builds) {
    assert.equal(build.compiledArtifactBinding, "pending");
    assert.equal(build.releaseEligible, false);
    for (const input of build.inputs) assert.equal(files.get(`runtime/${input.path}`)?.checksum, input.checksum, input.path);
  }
  const selectionBytes = await readFile(join(stage, "self-test-package-selection.json"));
  assert.equal(checksum(selectionBytes), record.selfTestPackageSelectionChecksum);
  const selection = JSON.parse(selectionBytes);
  assert.equal(selection.excludedPackages.length, record.excludedUpstreamSelfTestPackages);
  assert.equal(selection.excludedPackages.length, 2);
  assert.equal(selection.removedSizeBytes, record.removedSelfTestPackageBytes);
  for (const pkg of selection.excludedPackages) await assert.rejects(lstat(join(stage, "runtime", pkg.path)), { code: "ENOENT" });
  assert.equal(selection.completeRuntimeSelection, "pending");
  assert.equal(selection.compiledArtifactBinding, "pending");
  assert.equal(selection.releaseEligible, false);
  const typeSelectionBytes = await readFile(join(stage, "build-only-type-package-selection.json"));
  assert.equal(checksum(typeSelectionBytes), record.buildOnlyTypePackageSelectionChecksum);
  const typeSelection = JSON.parse(typeSelectionBytes);
  assert.equal(typeSelection.selectionScope, "reviewed-build-only-type-packages");
  assert.equal(typeSelection.excludedPackages.length, record.excludedBuildOnlyTypePackages);
  assert.equal(typeSelection.excludedPackages.length, 1);
  assert.equal(typeSelection.removedResources.length, 368);
  assert.equal(typeSelection.removedSizeBytes, record.removedBuildOnlyTypePackageBytes);
  assert.equal(typeSelection.removedSizeBytes, 2967599);
  assert.equal(typeSelection.releaseEligible, false);
  assert.equal(typeSelection.completeRuntimeSelection, "pending");
  for (const pkg of typeSelection.excludedPackages) await assert.rejects(lstat(join(stage, "runtime", pkg.path)), { code: "ENOENT" });
  assert.ok(files.has("runtime/tools/bun"));
  await assert.rejects(readFile(join(stage, "manifest.json")), { code: "ENOENT" });
});

test("real resource staging installs exact reviewed notices without modifying dependency metadata or clearing unrelated gates", { skip }, async () => {
  const record = JSON.parse(await readFile(join(stage, "resource-stage.json"), "utf8"));
  const receipt = JSON.parse(await readFile(join(stage, "third-party-notice-installation.json"), "utf8"));
  const catalog = JSON.parse(await readFile(new URL("./reviewed-third-party-notices.json", import.meta.url), "utf8"));
  const entries = new Map(catalog.entries.map(entry => [`${entry.name}@${entry.version}`, entry]));
  assert.equal(receipt.releaseEligible, false);
  assert.equal(receipt.catalogChecksum, REVIEWED_GSTACK_NOTICE_CATALOG_CHECKSUM);
  assert.equal(receipt.installed.length, record.installedNoticeLocations);
  assert.ok(receipt.installed.length >= catalog.entries.length);
  const before = await auditGstackRuntimeDependencies({ runtimeRoot: join(native, "runtime"), target: record.target });
  const after = JSON.parse(await readFile(join(stage, "dependency-audit.json"), "utf8"));
  const selection = JSON.parse(await readFile(join(stage, "self-test-package-selection.json"), "utf8"));
  const typeSelection = JSON.parse(await readFile(join(stage, "build-only-type-package-selection.json"), "utf8"));
  const excluded = path => [...selection.excludedPackages, ...typeSelection.excludedPackages]
    .some(pkg => path === pkg.path || path.startsWith(`${pkg.path}/`));
  assert.equal(after.packages.length, before.packages.filter(pkg => !excluded(pkg.path)).length);
  const originalPackages = new Map(before.packages.map(pkg => [pkg.path, pkg]));
  const missingBefore = before.blockers.filter(b => b.code === "dependency_notice_missing" && !excluded(b.path)).length;
  assert.equal(after.blockers.filter(b => b.code === "dependency_notice_missing").length, missingBefore - receipt.installed.length);
  assert.equal(after.blockers.filter(b => b.code === "dependency_license_review").length, before.blockers.filter(b => b.code === "dependency_license_review" && !excluded(b.path)).length);
  for (const pkg of after.packages) {
    assert.equal(pkg.metadataChecksum, originalPackages.get(pkg.path).metadataChecksum, pkg.path);
    assert.deepEqual(await readFile(join(stage, "runtime", pkg.path, "package.json")), await readFile(join(native, "runtime", pkg.path, "package.json")));
    if (!receipt.installed.includes(pkg.path)) continue;
    const entry = entries.get(`${pkg.name}@${pkg.version}`);
    const bytes = await readFile(join(stage, "runtime", pkg.path, "LICENSE.ling-upstream"));
    const sourceBytes = Buffer.from(entry.source.contentBase64, "base64");
    const expected = entry.notice ? sourceBytes.subarray(entry.notice.startByte, entry.notice.endByte) : sourceBytes;
    assert.deepEqual(bytes, expected);
    assert.equal(checksum(bytes), entry.notice?.checksum ?? entry.source.checksum);
    assert.equal(pkg.noticePaths.some(path => path.endsWith("ling-upstream-license-provenance.json")), false);
    const provenance = JSON.parse(await readFile(join(stage, "runtime", pkg.path, "ling-upstream-license-provenance.json"), "utf8"));
    assert.equal(provenance.package.metadataChecksum, pkg.metadataChecksum);
    assert.equal(provenance.source.revision, entry.registry.gitHead ?? entry.source.revisionProof.revision);
    if (entry.notice) assert.deepEqual(provenance.notice, entry.notice);
    await assert.rejects(readFile(join(native, "runtime", pkg.path, "LICENSE.ling-upstream")), { code: "ENOENT" });
  }
  assert.equal(after.blockers.some(b => b.code === "dependency_notice_missing" && b.path.endsWith("bun-types")), true);
  assert.equal(after.blockers.some(b => b.code === "dependency_license_review" && b.path.includes("sharp-libvips")), true);
  assert.equal(record.releaseEligible, false);
});

test("real CC0 package review retains notices, ordering behavior and unrelated redistribution gates", { skip }, async t => {
  const record = JSON.parse(await readFile(join(stage, "resource-stage.json"), "utf8"));
  const report = JSON.parse(await readFile(join(stage, "dependency-audit.json"), "utf8"));
  assert.equal(record.reviewedPublicDomainLocations, 1);
  assert.equal(record.publicDomainCatalogChecksum, REVIEWED_PUBLIC_DOMAIN_CATALOG_CHECKSUM);
  const pkg = report.packages.find(pkg => pkg.name === "fractional-indexing");
  assert.equal(pkg.version, "3.2.0");
  assert.equal(pkg.license, "CC0-1.0");
  assert.equal(pkg.licenseEvidence.length, 1);
  assert.equal(pkg.licenseEvidence[0].method, "exact-reviewed-public-domain-package");
  assert.equal(pkg.licenseEvidence[0].catalogChecksum, record.publicDomainCatalogChecksum);
  assert.equal(pkg.licenseEvidence[0].installedFileCount, 5);
  assert.equal(report.blockers.some(b => b.code === "dependency_license_review" && b.path === pkg.path), false);
  assert.deepEqual(await readFile(join(stage, "runtime", pkg.path, "LICENSE")), await readFile(join(native, "runtime", pkg.path, "LICENSE")));
  assert.equal(report.blockers.filter(b => b.code === "dependency_license_review").length, 1);
  assert.equal(report.blockers.some(b => b.code === "dependency_license_review" && b.path.includes("claude-agent-sdk")), false);
  assert.equal(report.blockers.some(b => b.code === "dependency_license_review" && b.path.includes("sharp-libvips")), true);
  assert.equal(record.releaseEligible, false);
  const home = await mkdtemp(join(tmpdir(), "ling-gstack-ordering-smoke-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const runtime = join(stage, "runtime");
  const script = `const {pathToFileURL}=require('node:url');
    (async()=>{const m=await import(pathToFileURL(process.argv[1]+'/lib/diagram-render/node_modules/fractional-indexing/src/index.js').href);
    const keys=m.generateNKeysBetween(null,null,3);console.log(JSON.stringify({keys,between:m.generateKeyBetween(keys[0],keys[1])}));
    })().catch(error=>{console.error(error);process.exitCode=1;});`;
  const result = spawnSync(join(runtime, `tools/node${process.platform === "win32" ? ".exe" : ""}`), ["-e", script, runtime], {
    cwd: home, env: { PATH: process.platform === "win32" ? process.env.SystemRoot : "/usr/bin:/bin", HOME: home,
      USERPROFILE: home, TMPDIR: home, TMP: home, TEMP: home, SystemRoot: process.env.SystemRoot },
    encoding: "utf8", timeout: 30_000, maxBuffer: 128 * 1024,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  const actual = JSON.parse(result.stdout);
  assert.deepEqual(actual.keys, ["a0", "a1", "a2"]);
  assert.ok(actual.keys[0] < actual.between && actual.between < actual.keys[1]);
});

test("packaged Node executes real ONNX CPU inference after foreign resources are removed", { skip }, async (t) => {
  const home = await mkdtemp(join(tmpdir(), "ling-gstack-onnx-smoke-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const runtime = join(stage, "runtime");
  // ONNX IR 8 / opset 13: a float32 Identity graph mapping X[2] to Y[2].
  const model = "0808120c4c696e6720666978747572653a4b0a100a015812015922084964656e7469747912154c696e6720706c6174666f726d20666978747572655a0f0a0158120a0a08080112040a020802620f0a0159120a0a08080112040a0208024202100d";
  const script = `const ort=require(process.argv[1]+"/node_modules/onnxruntime-node");
    (async()=>{const session=await ort.InferenceSession.create(Buffer.from(${JSON.stringify(model)},"hex"),{executionProviders:["cpu"]});
    try{const result=await session.run({X:new ort.Tensor("float32",Float32Array.from([1.25,-3.5]),[2])});
    console.log(JSON.stringify({Y:[...result.Y.data],type:result.Y.type,dims:result.Y.dims}));}
    finally{await session.release();}})().catch(error=>{console.error(error);process.exitCode=1;});`;
  const result = spawnSync(join(runtime, `tools/node${process.platform === "win32" ? ".exe" : ""}`), ["-e", script, runtime], {
    cwd: home, env: { PATH: process.platform === "win32" ? process.env.SystemRoot : "/usr/bin:/bin", HOME: home,
      USERPROFILE: home, TMPDIR: home, TMP: home, TEMP: home, SystemRoot: process.env.SystemRoot },
    encoding: "utf8", timeout: 30_000, maxBuffer: 128 * 1024,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { Y: [1.25, -3.5], type: "float32", dims: [2] });
});

test("native receipt alone cannot accept a changed skill body or publish a corrupted stage", { skip }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ling-gstack-corrupt-resource-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = join(root, "input");
  await cp(native, input, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
  const entry = join(input, "runtime/autoplan/SKILL.md");
  await writeFile(entry, `${await readFile(entry, "utf8")}\nUnreviewed instructions.\n`);
  await assert.rejects(prepareGstackPlatformResourceStage({ nativeCandidatePath: input, outputPath: join(root, "output"),
    expectedNativeBuildChecksum: await fileChecksum(join(native, "native-build.json")), ...parserOptions }), /gstack_resource_source_file_mismatch:runtime\/autoplan\/SKILL.md/);
  await assert.rejects(lstat(join(root, "output")), { code: "ENOENT" });
});

test("a missing actual optional judge API module prevents resource publication and cleans the failed stage", { skip }, async t => {
  const root = await mkdtemp(join(tmpdir(), "ling missing shared SDK "));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = join(root, "input"), output = join(root, "output");
  await cp(native, input, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
  await rm(join(input, "runtime/node_modules/@anthropic-ai/sdk/index.mjs"));
  await assert.rejects(prepareGstackPlatformResourceStage({ nativeCandidatePath: input, outputPath: output,
    expectedNativeBuildChecksum: "sha256:65eb00f9b33dffaa561804ae47e0207f9005b9b1e9c9c0ccf04078c3b5c61964", ...parserOptions }), /gstack_shared_command_build_failed/);
  await assert.rejects(lstat(output), { code: "ENOENT" });
  assert.deepEqual(await readdir(root), ["input"]);
  assert.equal(await fileChecksum(join(native, "runtime/node_modules/@anthropic-ai/sdk/index.mjs")),
    JSON.parse(await readFile(join(stage, "shared-command-closure.json"), "utf8")).inputs.find(input => input.path === "node_modules/@anthropic-ai/sdk/index.mjs").checksum);
});

test("target resource preparation is reproducible in an unrelated directory with spaces", { skip }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ling gstack resource reproducibility "));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = join(root, "application resources");
  const result = await prepareGstackPlatformResourceStage({ nativeCandidatePath: native, outputPath: output,
    expectedNativeBuildChecksum: await fileChecksum(join(native, "native-build.json")), ...parserOptions });
  const original = JSON.parse(await readFile(join(stage, "resource-stage.json"), "utf8"));
  assert.deepEqual(result, original);
  for (const name of ["resource-inventory.json", "platform-resource-filter.json", "command-link-materialization.json", "third-party-notice-installation.json", "dependency-audit.json", "shared-command-closure.json", "shell-resource-prerequisites.json", "reviewed-shell-dependencies.json"]) {
    assert.deepEqual(await readFile(join(output, name)), await readFile(join(stage, name)), name);
  }
});

test("a verified native stage cannot bypass the detached build-only AST parser gate", { skip }, async t => {
  const root = await mkdtemp(join(tmpdir(), "ling required AST identity "));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = { nativeCandidatePath: native, outputPath: join(root, "output"),
    expectedNativeBuildChecksum: await fileChecksum(join(native, "native-build.json")) };
  await assert.rejects(prepareGstackPlatformResourceStage(options), /shell_ast_parser_required/);
  await assert.rejects(prepareGstackPlatformResourceStage({ ...options, ...parserOptions,
    expectedParserChecksum: checksum("different") }), /shell_ast_parser_mismatch/);
  assert.deepEqual(await readdir(root), []);
});
