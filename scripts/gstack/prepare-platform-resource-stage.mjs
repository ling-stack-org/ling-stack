import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { filterGstackNativePlatformResources } from "./filter-native-platform-resources.mjs";
import { filterGstackUpstreamSelfTestPackages } from "./filter-upstream-self-test-packages.mjs";
import { filterGstackBuildOnlyTypePackages } from "./filter-build-only-type-packages.mjs";
import { materializeGstackCommandLinks } from "./materialize-command-links.mjs";
import { installReviewedGstackNotices } from "./install-reviewed-notices.mjs";
import { auditGstackRuntimeDependencies, matchesNativeDependency } from "./runtime-dependency-audit.mjs";
import { REVIEWED_PUBLIC_DOMAIN_CATALOG_CHECKSUM } from "./public-domain-package-review.mjs";
import { readGstackClosureFileRecord, verifyGstackBundledBuildImports, verifyGstackClientCommandImports } from "./verify-shared-command-closure.mjs";
import { verifyGstackShellResourcePrerequisites } from "./verify-shell-resource-prerequisites.mjs";
import { verifyReviewedGstackShellDependencies } from "./verify-reviewed-shell-dependencies.mjs";
import { verifyReviewedGstackShellCommands } from "./verify-reviewed-shell-commands.mjs";
import { inspectGstackShellInvocations } from "./inspect-shell-invocations.mjs";
import { managedResourceWrite, resourceCheckpoint, resourceTreeBytes } from "./resource-workspace.mjs";
import { publishStagedDirectory } from "./publish-staged-directory.mjs";

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const lock = JSON.parse(await readFile(join(scriptRoot, "upstream-lock.json"), "utf8"));
const reviewed = JSON.parse(await readFile(join(scriptRoot, "reviewed-source-bundle.json"), "utf8"));
const adaptationPaths = ["prepare-platform-resource-stage.mjs", "publish-staged-directory.mjs", "filter-native-platform-resources.mjs",
  "filter-upstream-self-test-packages.mjs", "reviewed-upstream-self-test-packages.json",
  "reviewed-upstream-self-test-packages-win32-x64.json",
  "filter-reviewed-build-packages.mjs", "filter-build-only-type-packages.mjs", "reviewed-build-only-type-packages.json",
  "materialize-command-links.mjs", "runtime-dependency-audit.mjs", "install-reviewed-notices.mjs",
  "public-domain-package-review.mjs", "reviewed-public-domain-packages.json", "verify-shared-command-closure.mjs",
  "verify-shell-resource-prerequisites.mjs", "pinned-shell-inventory.json",
  "verify-reviewed-shell-dependencies.mjs", "reviewed-shell-dependencies.json", "inspect-shell-call-sites.mjs",
  "verify-reviewed-shell-commands.mjs", "reviewed-shell-commands.json",
  "inspect-shell-invocations.mjs",
  "shell-ast/main.go", "shell-ast/go.mod", "shell-ast/go.sum", "shell-ast/THIRD-PARTY-NOTICES",
  "reviewed-third-party-notices.json", "notice-source-provenance.mjs", "onnx-dev-notice-provenance.mjs", "upstream-lock.json", "reviewed-source-bundle.json"];
const checksum = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const inside = (root, path) => {
  const value = relative(root, path);
  return !value || !isAbsolute(value) && value !== ".." && !value.startsWith("../") && !value.startsWith("..\\");
};
const exists = async path => lstat(path).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; });

async function canonicalDestination(path) {
  const suffix = [basename(path)];
  let parent = dirname(path);
  while (!await exists(parent)) {
    suffix.unshift(basename(parent));
    parent = dirname(parent);
  }
  const base = await realpath(parent);
  if (!(await lstat(base)).isDirectory()) throw new Error("gstack_resource_output_parent_invalid");
  return join(base, ...suffix);
}

async function fileRecord(root, path) {
  if (!path || isAbsolute(path) || path.includes("\\") || path.split("/").some(part => !part || part === "." || part === "..")) {
    throw new Error("gstack_resource_path_invalid");
  }
  const absolute = join(root, path);
  const stat = await lstat(absolute);
  if (!stat.isFile() || stat.isSymbolicLink() || await realpath(absolute) !== absolute) throw new Error(`gstack_resource_file_invalid:${path}`);
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(absolute)) hash.update(bytes);
  return { path, sizeBytes: stat.size, checksum: `sha256:${hash.digest("hex")}`, executable: Boolean(stat.mode & 0o111) };
}

async function verifyNativeInput(root, expectedNativeBuildChecksum, target) {
  const receipt = await fileRecord(root, "native-build.json");
  if (receipt.checksum !== expectedNativeBuildChecksum) throw new Error("gstack_resource_native_receipt_mismatch");
  const native = JSON.parse(await readFile(join(root, "native-build.json"), "utf8"));
  if (native.schemaVersion !== 1 || native.deliveryStage !== "native-dependencies" ||
    native.upstreamRevision !== lock.revision || native.upstreamVersion !== lock.version ||
    native.sourceManifestChecksum !== reviewed.manifestChecksum ||
    native.target?.platform !== target.platform || native.target?.arch !== target.arch ||
    !Array.isArray(native.components) || !native.components.length || !Array.isArray(native.securityPatches)) {
    throw new Error("gstack_resource_native_stage_invalid");
  }
  if (await exists(join(root, "manifest.json"))) throw new Error("gstack_resource_input_already_executable");
  if ((await fileRecord(root, "source-manifest.json")).checksum !== reviewed.manifestChecksum) throw new Error("gstack_resource_source_manifest_mismatch");
  const paths = new Set();
  for (const component of native.components) {
    if (!component.path?.startsWith("runtime/") || paths.has(component.path)) throw new Error("gstack_resource_native_component_invalid");
    paths.add(component.path);
    const actual = await fileRecord(root, component.path);
    if (actual.checksum !== component.checksum || actual.sizeBytes !== component.sizeBytes) throw new Error(`gstack_resource_component_mismatch:${component.path}`);
    if (component.native && !await matchesNativeDependency(join(root, component.path), target)) throw new Error("gstack_resource_component_target_mismatch");
  }
  for (const patch of native.securityPatches) {
    if ((await fileRecord(root, `runtime/${patch.path}`)).checksum !== patch.afterChecksum ||
      (await fileRecord(root, `runtime/${patch.patchPath}`)).checksum !== patch.patchChecksum) throw new Error("gstack_resource_security_patch_mismatch");
  }
  const source = JSON.parse(await readFile(join(root, "source-manifest.json"), "utf8"));
  const rebuilt = new Map(native.components.map(component => [component.path, component]));
  for (const file of source.files) {
    const expected = rebuilt.get(file.path) ?? file;
    const actual = await fileRecord(root, file.path);
    if (actual.checksum !== expected.checksum || actual.sizeBytes !== expected.sizeBytes) {
      throw new Error(`gstack_resource_source_file_mismatch:${file.path}`);
    }
  }
  return native;
}

async function inventory(root, prefix = "") {
  const files = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await inventory(root, path));
    else if (entry.isFile()) files.push(await fileRecord(root, path));
    else throw new Error(`gstack_resource_kind_invalid:${path}`);
  }
  return files.sort((a, b) => a.path.localeCompare(b.path, "en"));
}

// A reproducible preparation receipt is not an executable bundle or release approval.
export async function prepareGstackPlatformResourceStage({ nativeCandidatePath, outputPath,
  expectedNativeBuildChecksum, target = { platform: process.platform, arch: process.arch },
  shellPath = process.platform === "win32" ? undefined : "/bin/bash", parserPath, expectedParserChecksum,
  parserProvenance, packageSelection = "reviewed-prune", onProgress = () => {} }) {
  if (!["reviewed-prune", "reviewed-sdk-only", "retain-complete-upstream"].includes(packageSelection)) throw new Error("gstack_resource_package_selection_invalid");
  if (!/^sha256:[a-f0-9]{64}$/.test(expectedNativeBuildChecksum ?? "")) throw new Error("gstack_resource_native_receipt_required");
  if (!["darwin", "win32"].includes(target.platform) || !["arm64", "x64"].includes(target.arch)) throw new Error("gstack_resource_target_invalid");
  if (typeof shellPath !== "string" || !isAbsolute(shellPath)) throw new Error("gstack_resource_shell_interpreter_required");
  const requestedOutput = resolve(outputPath);
  if (await exists(requestedOutput)) throw new Error("gstack_resource_output_already_exists");
  const output = await canonicalDestination(requestedOutput);
  const requested = resolve(nativeCandidatePath);
  const stat = await lstat(requested);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("gstack_resource_input_root_invalid");
  const source = await realpath(requested);
  if (inside(source, output) || inside(output, source)) throw new Error("gstack_resource_input_output_overlap");
  onProgress("verify detached native receipt and existing security backports");
  const native = await verifyNativeInput(source, expectedNativeBuildChecksum, target);
  if (typeof parserPath !== "string" || !isAbsolute(parserPath) || !/^sha256:[a-f0-9]{64}$/.test(expectedParserChecksum ?? "")) {
    throw new Error("gstack_resource_shell_ast_parser_required");
  }
  if ((await readGstackClosureFileRecord(resolve(parserPath))).checksum !== expectedParserChecksum) {
    throw new Error("gstack_resource_shell_ast_parser_mismatch");
  }
  const adaptationInputs = Buffer.concat(await Promise.all(adaptationPaths.map(path => readFile(join(scriptRoot, path)))));
  const lease = await managedResourceWrite(output, { kind: "resource", additionalBytes: (await resourceTreeBytes(source)) * 2 + 512 * 1024 ** 2 });
  await mkdir(dirname(output), { recursive: true });
  const temporary = await realpath(await mkdtemp(join(dirname(output), ".gstack-resource-stage-")));
  try {
    const candidate = join(temporary, "candidate");
    onProgress("clone native prerequisites into exclusively owned staging");
    await cp(source, candidate, { recursive: true, errorOnExist: true, force: false,
      verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
    await resourceCheckpoint(lease.root);
    await verifyNativeInput(candidate, expectedNativeBuildChecksum, target);
    const runtime = join(candidate, "runtime");
    if (parserProvenance) {
      if (parserProvenance.binding !== "pinned-module-and-repeated-native-byte-identity" ||
        parserProvenance.artifact?.checksum !== expectedParserChecksum || parserProvenance.releaseEligible !== false ||
        parserProvenance.target?.platform !== target.platform || parserProvenance.target?.arch !== target.arch) {
        throw new Error("gstack_resource_parser_provenance_invalid");
      }
      await writeFile(join(candidate, "shell-parser-build.json"), `${JSON.stringify(parserProvenance, null, 2)}\n`, { flag: "wx" });
    }
    onProgress("materialize package commands using packaged Node");
    const links = await materializeGstackCommandLinks({ runtimeRoot: runtime, target });
    await writeFile(join(candidate, "command-link-materialization.json"), `${JSON.stringify({
      schemaVersion: 1, deliveryStage: "resource-staging", packageAcceptance: "pending", target, links,
    }, null, 2)}\n`);
    onProgress("retain reviewed ONNX target resources and record foreign resource hashes");
    const platformResources = await filterGstackNativePlatformResources({ runtimeRoot: runtime, target });
    await writeFile(join(candidate, "platform-resource-filter.json"), `${JSON.stringify(platformResources, null, 2)}\n`);
    onProgress("compile client command imports, including optional judge, without upstream paid self-tests or provider execution");
    const bun = native.components.find(component => component.path === `runtime/tools/bun${target.platform === "win32" ? ".exe" : ""}`);
    if (!bun) throw new Error("gstack_resource_shared_compiler_missing");
    const sharedCommands = await verifyGstackClientCommandImports({ runtimeRoot: runtime,
      bunPath: join(candidate, bun.path), expectedBunChecksum: bun.checksum,
      expectedSourceManifestChecksum: reviewed.manifestChecksum });
    await writeFile(join(candidate, "shared-command-closure.json"), `${JSON.stringify(sharedCommands, null, 2)}\n`);
    onProgress("record native, Node browser and diagram compiler inputs without claiming existing artifact provenance");
    const bundledBuildImports = await verifyGstackBundledBuildImports({ runtimeRoot: runtime,
      bunPath: join(candidate, bun.path), expectedBunChecksum: bun.checksum,
      expectedSourceManifestChecksum: reviewed.manifestChecksum });
    const buildImportBytes = Buffer.from(`${JSON.stringify(bundledBuildImports, null, 2)}\n`);
    await writeFile(join(candidate, "bundled-build-imports.json"), buildImportBytes);
    // Every exclusion still requires its exact platform, compiler and import
    // graph review. SDK-only selection leaves the separate declaration-package
    // review untouched; other targets can retain the complete upstream tree.
    const retainedSelection = category => ({ schemaVersion: 1, deliveryStage: "resource-prerequisites",
      selectionScope: "complete-upstream-retained", category, releaseEligible: false, target,
      sourceManifestChecksum: reviewed.manifestChecksum, inputNativeBuildChecksum: expectedNativeBuildChecksum,
      importGraphs: [sharedCommands, ...bundledBuildImports].map(({ dependencyScope, inputGraphChecksum, compilerChecksum }) => ({
        dependencyScope, inputGraphChecksum, compilerChecksum,
      })), excludedPackages: [], removedResources: [], removedSizeBytes: 0,
      completeRuntimeSelection: "pending", compiledArtifactBinding: "pending",
      pendingGates: ["toolchain-specific-pruning-review", "complete-dynamic-resource-selection", "redistribution-review", "installed-client-acceptance"] });
    onProgress(packageSelection !== "retain-complete-upstream" ? "exclude exact reviewed upstream self-test packages from private staging, preserving client API and external CLI paths"
      : "retain complete upstream self-test dependencies; historical toolchain-specific exclusions are not reused");
    const selfTestSelection = packageSelection !== "retain-complete-upstream" ? await filterGstackUpstreamSelfTestPackages({ runtimeRoot: runtime, stagingRoot: temporary,
      target, expectedNativeBuildChecksum, importReports: [sharedCommands, ...bundledBuildImports] }) : retainedSelection("upstream-self-test-packages");
    const selectionBytes = Buffer.from(`${JSON.stringify(selfTestSelection, null, 2)}\n`);
    await writeFile(join(candidate, "self-test-package-selection.json"), selectionBytes);
    onProgress(packageSelection === "reviewed-prune" ? "exclude exact reviewed build-only declarations, preserving Bun and upstream build inputs"
      : "retain complete build-only declarations; all command and bundled import verification remains required");
    const typeSelection = packageSelection === "reviewed-prune" ? await filterGstackBuildOnlyTypePackages({ runtimeRoot: runtime, stagingRoot: temporary,
      target, expectedNativeBuildChecksum, importReports: [sharedCommands, ...bundledBuildImports] }) : retainedSelection("build-only-type-packages");
    const typeSelectionBytes = Buffer.from(`${JSON.stringify(typeSelection, null, 2)}\n`);
    await writeFile(join(candidate, "build-only-type-package-selection.json"), typeSelectionBytes);
    const selectedImports = [await verifyGstackClientCommandImports({ runtimeRoot: runtime,
      bunPath: join(candidate, bun.path), expectedBunChecksum: bun.checksum, expectedSourceManifestChecksum: reviewed.manifestChecksum }),
    ...await verifyGstackBundledBuildImports({ runtimeRoot: runtime, bunPath: join(candidate, bun.path),
      expectedBunChecksum: bun.checksum, expectedSourceManifestChecksum: reviewed.manifestChecksum })];
    if (selectedImports.some((graph, index) => graph.inputGraphChecksum !== [sharedCommands, ...bundledBuildImports][index].inputGraphChecksum)) {
      throw new Error("gstack_resource_client_imports_changed_after_selection");
    }
    onProgress("install only reviewed exact-version notice texts for retained packages, keeping native redistribution gates");
    const notices = await installReviewedGstackNotices({ runtimeRoot: runtime, target });
    await writeFile(join(candidate, "third-party-notice-installation.json"), `${JSON.stringify(notices, null, 2)}\n`);
    onProgress("audit retained staged dependencies independently of the Ling pnpm graph");
    const audit = await auditGstackRuntimeDependencies({ runtimeRoot: runtime, target });
    await writeFile(join(candidate, "dependency-audit.json"), `${JSON.stringify(audit, null, 2)}\n`);
    if (audit.links.length || audit.blockers.some(blocker => /dependency_(?:link|resource_kind)/.test(blocker.code))) {
      throw new Error("gstack_resource_shared_command_unsafe_tree");
    }
    await resourceCheckpoint(lease.root);
    onProgress("parse all pinned shell resources and verify reviewed helper edges without executing scripts");
    const interpreter = await realpath(shellPath);
    const shellResources = await verifyGstackShellResourcePrerequisites({ runtimeRoot: runtime,
      expectedSourceManifestChecksum: reviewed.manifestChecksum, expectedUpstreamRevision: lock.revision,
      shellPath: interpreter, expectedShellChecksum: (await readGstackClosureFileRecord(interpreter)).checksum });
    const shellBytes = Buffer.from(`${JSON.stringify(shellResources, null, 2)}\n`);
    await writeFile(join(candidate, "shell-resource-prerequisites.json"), shellBytes);
    onProgress("verify every reviewed source and dynamic call-site mapping without resolving runtime state");
    const shellDependencies = await verifyReviewedGstackShellDependencies({ runtimeRoot: runtime, parserPath, expectedParserChecksum,
      expectedSourceManifestChecksum: reviewed.manifestChecksum, expectedUpstreamRevision: lock.revision,
      shellPath: interpreter, expectedShellChecksum: shellResources.interpreterChecksum });
    const dependencyBytes = Buffer.from(`${JSON.stringify(shellDependencies, null, 2)}\n`);
    await writeFile(join(candidate, "reviewed-shell-dependencies.json"), dependencyBytes);
    onProgress("verify all reviewed indirect command expressions and original resource counterparts without executing them");
    const shellCommands = await verifyReviewedGstackShellCommands({ runtimeRoot: runtime, parserPath, expectedParserChecksum,
      expectedSourceManifestChecksum: reviewed.manifestChecksum, expectedUpstreamRevision: lock.revision,
      shellPath: interpreter, expectedShellChecksum: shellResources.interpreterChecksum });
    const commandBytes = Buffer.from(`${JSON.stringify(shellCommands, null, 2)}\n`);
    await writeFile(join(candidate, "reviewed-shell-commands.json"), commandBytes);
    onProgress("identify wrapped executables and interpreter resources without evaluating dynamic arguments");
    const shellInvocations = await inspectGstackShellInvocations({ runtimeRoot: runtime, parserPath, expectedParserChecksum,
      expectedSourceManifestChecksum: reviewed.manifestChecksum, expectedUpstreamRevision: lock.revision,
      shellPath: interpreter, expectedShellChecksum: shellResources.interpreterChecksum });
    const invocationBytes = Buffer.from(`${JSON.stringify(shellInvocations, null, 2)}\n`);
    await writeFile(join(candidate, "shell-invocations.json"), invocationBytes);
    onProgress("hash every staged resource; retain all unresolved release gates");
    await resourceCheckpoint(lease.root);
    const files = await inventory(candidate);
    const inventoryBytes = Buffer.from(`${JSON.stringify({ schemaVersion: 1,
      excludedReceiptPaths: ["resource-inventory.json", "resource-stage.json"], files }, null, 2)}\n`);
    await writeFile(join(candidate, "resource-inventory.json"), inventoryBytes);
    if (!adaptationInputs.equals(Buffer.concat(await Promise.all(adaptationPaths.map(path => readFile(join(scriptRoot, path))))))) throw new Error("gstack_resource_build_inputs_changed");
    const record = { schemaVersion: 1, deliveryStage: "resource-prerequisites", hostAcceptance: "pending",
      packageAcceptance: "pending", releaseEligible: false, upstreamRevision: native.upstreamRevision,
      upstreamVersion: native.upstreamVersion, nativeAdaptationRevision: native.adaptationRevision,
      adaptationRevision: `ling-${createHash("sha256").update(adaptationInputs).digest("hex")}`,
      inputNativeBuildChecksum: expectedNativeBuildChecksum, target, packageSelection, inventoryChecksum: checksum(inventoryBytes),
      fileCount: files.length, materializedCommands: links.length, removedPlatformFiles: platformResources.removedResources.length,
      sharedCommandEntrypoints: sharedCommands.entrypoints.length, sharedCommandInputCount: sharedCommands.inputs.length,
      sharedCommandDependencyScope: sharedCommands.dependencyScope,
      sharedCommandBunCommandCount: sharedCommands.bunCommandCount,
      sharedCommandGraphChecksum: sharedCommands.inputGraphChecksum,
      selfTestPackageSelectionChecksum: checksum(selectionBytes),
      excludedUpstreamSelfTestPackages: selfTestSelection.excludedPackages.length,
      removedSelfTestPackageBytes: selfTestSelection.removedSizeBytes,
      buildOnlyTypePackageSelectionChecksum: checksum(typeSelectionBytes),
      excludedBuildOnlyTypePackages: typeSelection.excludedPackages.length,
      removedBuildOnlyTypePackageBytes: typeSelection.removedSizeBytes,
      bundledBuildImportChecksum: checksum(buildImportBytes),
      bundledBuildImportScopes: bundledBuildImports.map(({ dependencyScope, inputGraphChecksum, compiledArtifactBinding }) => ({
        dependencyScope, inputGraphChecksum, compiledArtifactBinding,
      })),
      sharedCommandDynamicResourceCount: sharedCommands.dynamicResources.length,
      sharedCommandDynamicResourceGraphChecksum: sharedCommands.dynamicResourceGraphChecksum,
      shellScriptCount: shellResources.scripts.length, shellSourceEdgeCount: shellResources.sourceEdges.length,
      shellPrerequisiteChecksum: checksum(shellBytes), shellInventoryChecksum: shellResources.inventoryChecksum,
      shellDependencyReviewChecksum: checksum(dependencyBytes), shellDependencyReviewCatalogChecksum: shellDependencies.reviewChecksum,
      shellReviewedSourceSiteCount: shellDependencies.sourceSites.length, shellReviewedDynamicSiteCount: shellDependencies.dynamicEvaluationSites.length,
      shellReviewedResourceCount: shellDependencies.resources.length, shellDependencyReviewGraphChecksum: shellDependencies.reviewGraphChecksum,
      shellCommandReviewChecksum: checksum(commandBytes), shellCommandReviewCatalogChecksum: shellCommands.reviewChecksum,
      shellReviewedCommandExpressionCount: shellCommands.commandExpressionCount, shellReviewedCommandGroupCount: shellCommands.commandGroupCount,
      shellCommandReviewGraphChecksum: shellCommands.reviewGraphChecksum, shellCommandResourceCount: shellCommands.resources.length,
      shellCommandResourceGraphChecksum: shellCommands.resourceGraphChecksum,
      shellInvocationAnalysisChecksum: checksum(invocationBytes), shellInvocationCount: shellInvocations.invocations.length,
      shellInvocationGraphChecksum: shellInvocations.invocationGraphChecksum,
      installedNoticeLocations: notices.installed.length, noticeCatalogChecksum: notices.catalogChecksum,
      reviewedPublicDomainLocations: audit.packages.filter(pkg => pkg.licenseEvidence.some(e => e.method === "exact-reviewed-public-domain-package")).length,
      publicDomainCatalogChecksum: REVIEWED_PUBLIC_DOMAIN_CATALOG_CHECKSUM,
      removedPlatformBytes: platformResources.removedSizeBytes, auditChecksPassed: audit.checksPassed,
      auditBlockerCounts: Object.fromEntries([...new Set(audit.blockers.map(b => b.code))].sort().map(code => [code, audit.blockers.filter(b => b.code === code).length])) };
    await writeFile(join(candidate, "resource-stage.json"), `${JSON.stringify(record, null, 2)}\n`);
    await resourceCheckpoint(lease.root);
    await publishStagedDirectory(candidate, output);
    return record;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [nativeCandidatePath, outputPath, expectedNativeBuildChecksum, platform = process.platform, arch = process.arch,
    shellPath, parserPath, expectedParserChecksum] = process.argv.slice(2);
  if (!nativeCandidatePath || !outputPath) throw new Error("Usage: prepare-platform-resource-stage.mjs <native-candidate> <new-output> <detached-native-receipt-sha256> [platform] [arch] <bash-path> <ast-parser-path> <ast-parser-sha256>");
  const record = await prepareGstackPlatformResourceStage({ nativeCandidatePath, outputPath, expectedNativeBuildChecksum,
    target: { platform, arch }, shellPath, parserPath, expectedParserChecksum, onProgress: message => process.stderr.write(`${message}\n`) });
  process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
}
