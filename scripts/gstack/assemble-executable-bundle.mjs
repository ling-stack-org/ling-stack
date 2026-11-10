import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { cp, copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleFile, bundleInventory, digest, readExecutableBundle } from "./executable-bundle.mjs";
import { materializeLocalBrowser, materializeLocalFfmpeg } from "./materialize-local-browser.mjs";
import { materializePlaywrightBrowser } from "./materialize-playwright-browser.mjs";
import { managedResourceWrite, resourceCheckpoint, resourceTreeBytes } from "./resource-workspace.mjs";
import { testsavantArtifactName, verifyTestsavantModel } from "./collect-testsavant-model.mjs";
import { verifyBrowserArchiveSource } from "./collect-browser-archives.mjs";
import { testsavantModelAcquisition } from "./testsavant-model-cache.mjs";
import { publishStagedDirectory } from "./publish-staged-directory.mjs";

const scripts = dirname(fileURLToPath(import.meta.url));
const exists = path => lstat(path).then(() => true, error => { if (error.code !== "ENOENT") throw error; return false; });
const toolNames = ["assemble-executable-bundle.mjs", "publish-staged-directory.mjs", "executable-bundle.mjs", "materialize-local-browser.mjs",
  "build-managed-node-server.mjs", "build-node-server-resource.mjs", "build-testsavant-component.mjs", "build-portable-resources.ts",
  "build-bun-native-resource.mjs", "packaged-browse-build.mjs", "packaged-browse-launch.mjs", "testsavant-packaged-client.mjs",
  "testsavant-gs-client.mjs", "testsavant-client.mjs", "testsavant-runtime.mjs", "testsavant-worker.mjs", "testsavant-offline-guard.mjs",
  "testsavant-model-pin.json", "upstream-lock.json", "packaged-browser-source.mjs", "collect-browser-archives.mjs",
  "reviewed-source-bundle.json", "runtime-dependency-audit.mjs", "testsavant-model-cache.mjs", "materialize-playwright-browser.mjs",
  "inspect-browser-archives.mjs", "inspect-browser-zip.mjs", "browser-acquisition.mjs"];

/** One complete local candidate, reusing authenticated prerequisites without dependency installs. */
export async function assembleExecutableBundle({ stageRoot, browserInspectionRoot, archiveRoot, outputRoot,
  expectedResourceStageChecksum, browserArchivesRoot, expectedArchiveReceiptChecksum,
  expectedBrowserInspectionChecksum, modelMode = "bundled", browserMode = "bundled", onProgress = () => {} }) {
  if (!/^sha256:[a-f0-9]{64}$/.test(expectedResourceStageChecksum ?? "")) throw new Error("gstack_executable_stage_receipt_required");
  if (!(typeof archiveRoot === "string" && archiveRoot || typeof browserArchivesRoot === "string" && browserArchivesRoot)) {
    throw new Error("gstack_executable_archive_root_required");
  }
  if (!["bundled", "download-required"].includes(modelMode)) throw new Error("gstack_executable_model_mode_invalid");
  if (!["bundled", "download-required"].includes(browserMode) || browserMode === "download-required" && !browserArchivesRoot) {
    throw new Error("gstack_executable_browser_mode_invalid");
  }
  stageRoot = resolve(stageRoot); browserInspectionRoot = resolve(browserInspectionRoot); outputRoot = resolve(outputRoot);
  if (await exists(outputRoot)) throw new Error("gstack_executable_output_exists");
  if (await realpath(stageRoot) !== stageRoot) throw new Error("gstack_executable_stage_alias");
  await verifyBrowserArchiveSource({ resourceStagePath: stageRoot, expectedResourceStageChecksum,
    target: { platform: process.platform, arch: process.arch } });
  const stageBytes = await readFile(join(stageRoot, "resource-stage.json"));
  if (digest(stageBytes) !== expectedResourceStageChecksum) throw new Error("gstack_executable_prerequisites_changed");
  const stage = JSON.parse(stageBytes), inventoryBytes = await readFile(join(stageRoot, "resource-inventory.json"));
  if (stage.schemaVersion !== 1 || stage.deliveryStage !== "resource-prerequisites" || stage.releaseEligible !== false) throw new Error("gstack_executable_stage_invalid");
  if (digest(inventoryBytes) !== stage.inventoryChecksum || stage.target.platform !== process.platform
    || stage.target.arch !== process.arch) throw new Error("gstack_executable_prerequisites_changed");
  const inputInventory = JSON.parse(inventoryBytes).files;
  // Only this mode avoids copying a bundled model/browser. Keep all ownership,
  // generation and budget gates; the other modes retain their original gate.
  const measuredDownload = modelMode === "download-required" && browserMode === "download-required";
  const lease = await managedResourceWrite(outputRoot, { kind: "native", additionalBytes: measuredDownload ? 0 : 4 * 1024 ** 3 });
  const repo = resolve(scripts, "../..");
  const toolPaths = [...toolNames.map(name => `scripts/gstack/${name}`), "packages/core/src/bundled-skill-source.ts", "packages/core/src/bundled-skill-browser.ts"];
  const tools = await Promise.all(toolPaths.map(path => bundleFile(repo, path)));
  onProgress("verify retained complete resource inventory before copying");
  const actual = await bundleInventory(stageRoot);
  const expected = [...inputInventory, ...await Promise.all(["resource-stage.json", "resource-inventory.json"].map(path => bundleFile(stageRoot, path)))];
  const canonical = rows => JSON.stringify(rows.map(({ path, checksum, sizeBytes }) => ({ path, checksum, sizeBytes })).sort((a, b) => a.path.localeCompare(b.path, "en")));
  if (canonical(actual) !== canonical(expected)) throw new Error("gstack_executable_prerequisites_changed");
  const source = JSON.parse(await readFile(join(stageRoot, "source-manifest.json")));
  const reviewed = JSON.parse(await readFile(join(scripts, "reviewed-source-bundle.json")));
  if ((await bundleFile(stageRoot, "source-manifest.json")).checksum !== reviewed.manifestChecksum
    || source.upstream.revision !== reviewed.upstreamRevision || source.adaptationRevision !== reviewed.adaptationRevision
    || (await bundleFile(stageRoot, "native-build.json")).checksum !== stage.inputNativeBuildChecksum) {
    throw new Error("gstack_executable_prerequisites_changed");
  }
  const modelRoot = join(lease.root, "artifacts/resource", testsavantArtifactName);
  if (modelMode === "bundled") await verifyTestsavantModel(modelRoot);
  const modelAcquisition = modelMode === "download-required" ? testsavantModelAcquisition() : undefined;
  await mkdir(dirname(outputRoot), { recursive: true });
  const work = await mkdtemp(join(lease.scratchPath, "tmp", "gstack-executable-")), candidate = join(work, "candidate"), mainRoot = join(candidate, "gstack");
  const serialize = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  const assertTools = async () => {
    if (canonical(tools) !== canonical(await Promise.all(toolPaths.map(path => bundleFile(repo, path))))) throw new Error("gstack_executable_build_inputs_changed");
  };
  const assertStage = async () => {
    if (canonical(await bundleInventory(stageRoot)) !== canonical(actual)) throw new Error("gstack_executable_prerequisites_changed");
  };
  const writeBudgeted = async (path, bytes) => {
    await resourceCheckpoint(lease.root, bytes.length);
    await writeFile(path, bytes, { flag: "wx" });
    // Entry/parent metadata is measured after creation, not assumed to be zero.
    await resourceCheckpoint(lease.root);
  };
  const copyStage = async (followingBytes = 0) => {
    await assertTools(); await assertStage();
    const treeBytes = await resourceTreeBytes(stageRoot);
    const admission = await resourceCheckpoint(lease.root, treeBytes + followingBytes);
    onProgress(`assembly copy admission ${JSON.stringify({ ...admission, sourceTreeBytes: treeBytes, followingBytes })}`);
    let entries = 0, bytes = 0, checking;
    await cp(stageRoot, mainRoot, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE,
      errorOnExist: true, force: false,
      filter: measuredDownload ? async path => {
        // cp's filter runs BEFORE copying; it is not a completion receipt. Do
        // not subtract predicted file sizes from current usage here. The full
        // payload is admitted above; periodically remeasure actual growth and
        // preserve headroom for all remaining replacements/serialized writes.
        const info = await lstat(path);
        if (!info.isDirectory() && !info.isFile()) throw new Error("gstack_executable_prerequisites_changed");
        bytes += info.size; entries++;
        if (checking || bytes >= 64 * 1024 ** 2 || entries >= 1024) {
          checking ??= resourceCheckpoint(lease.root, followingBytes).finally(() => {
            checking = undefined; bytes = 0; entries = 0;
          });
          await checking;
        }
        return true;
      } : undefined });
    const copiedTreeBytes = await resourceTreeBytes(mainRoot);
    const usage = await resourceCheckpoint(lease.root, followingBytes);
    onProgress(`assembly copy measured ${JSON.stringify({ ...usage, sourceTreeBytes: treeBytes, copiedTreeBytes })}`);
    if (canonical(await bundleInventory(mainRoot)) !== canonical(actual)) throw new Error("gstack_executable_copied_input_changed");
    await assertStage(); await assertTools();
  };
  let completed = false;
  try {
    await mkdir(candidate);
    const runtime = join(mainRoot, "runtime"), retainedRuntime = join(stageRoot, "runtime"), compiled = join(work, "compiled");
    if (!measuredDownload) await copyStage();
    await mkdir(compiled);
    const env = { ...process.env, NODE_OPTIONS: "", NODE_PATH: "" };
    const suffix = stage.target.platform === "win32" ? ".exe" : "";
    const build = (script, args) => execFileSync(join(retainedRuntime, `tools/bun${suffix}`), ["--no-env-file", "--no-install", join(scripts, script), ...args],
      { cwd: retainedRuntime, env, encoding: "utf8", timeout: 120_000, maxBuffer: 1024 ** 2 });
    onProgress("compile current production-only TestSavant server and pinned native CLI");
    build("build-portable-resources.ts", [modelMode === "download-required" ? "node-server-download" : "node-server", retainedRuntime, compiled]);
    onProgress(browserMode === "download-required" ? "seal official browser acquisition metadata without redistributing Chrome" :
      "materialize independently verified browser with original framework aliases and signatures");
    const browser = browserArchivesRoot ? await materializePlaywrightBrowser({ resourceStagePath: stageRoot,
      archivePath: browserArchivesRoot, inspectionPath: browserInspectionRoot,
      expectedResourceStageChecksum, expectedArchiveReceiptChecksum,
      expectedInspectionChecksum: expectedBrowserInspectionChecksum, browserOutputRoot: join(candidate, "gstack-browser"),
      cacheOutputRoot: join(measuredDownload ? compiled : runtime, "browser-cache"), managedRoot: lease.root, target: stage.target, browserMode })
      : await materializeLocalBrowser({ inspectionRoot: browserInspectionRoot, runtimeRoot: retainedRuntime,
        outputRoot: join(candidate, "gstack-browser"), managedRoot: lease.root });
    if (!browserArchivesRoot) browser.ffmpeg = await materializeLocalFfmpeg({ archiveRoot: resolve(archiveRoot),
      runtimeRoot: retainedRuntime, cacheRoot: join(runtime, "browser-cache"), managedRoot: lease.root });
    await mkdir(join(compiled, "tools"));
    const nodePath = `tools/node${suffix}`, node = await bundleFile(retainedRuntime, nodePath);
    await resourceCheckpoint(lease.root, node.sizeBytes);
    await copyFile(join(retainedRuntime, `tools/node${suffix}`), join(compiled, `tools/node${suffix}`), constants.COPYFILE_EXCL);
    if (canonical([await bundleFile(compiled, nodePath)]) !== canonical([node])) throw new Error("gstack_executable_build_inputs_changed");
    await resourceCheckpoint(lease.root);
    // Browser pins become compiler input, not a runtime environment override.
    await writeBudgeted(join(compiled, "browser-selection.json"), serialize(browser));
    build("build-bun-native-resource.mjs", ["packaged-browse", retainedRuntime, compiled]);
    const replacementPaths = [`browse/dist/browse${suffix}`, `browse/dist/browse${suffix}.build-provenance.json`, "browse/dist/server-node.mjs",
      "browse/dist/bun-polyfill.cjs", "browse/dist/node-server-build-provenance.json", "browse/dist/testsavant-component.json",
      "browse/dist/testsavant-sidecar.mjs", "browser-selection.json"];
    const replacements = await Promise.all(replacementPaths.map(path => bundleFile(compiled, path)));
    const adaptationRevision = `ling-${digest(Buffer.from(canonical(tools))).slice(7)}`;
    const executableBytes = serialize({ schemaVersion: 1, scope: "isolated-local-client",
      releaseEligible: false, packageAcceptance: "pending", upstreamRevision: source.upstream.revision,
      retainedStageChecksum: expectedResourceStageChecksum, stageSelection: "explicit-detached-rebuilt-or-retained",
      adaptationRevision, toolInputs: tools, browser, ...(modelAcquisition ? { modelAcquisition } : {}),
      pendingGates: ["whole-package-review", "installed-client-all57", "native-windows", "redistribution-notices-and-authorization"] });
    const acquisitionBytes = modelAcquisition && serialize(modelAcquisition);
    let plannedFiles;
    if (measuredDownload) {
      // All preparation trees already count in current used bytes. Admit the
      // complete stage (including directories and BOTH receipts), every fresh
      // replacement copy and exact serialized metadata, without credit for
      // deleting old candidate files or retiring any prerequisite generation.
      const files = new Map(actual.map(row => [row.path, row]));
      if (files.has("manifest.json") || files.has("executable-build.json") ||
        [...files.keys()].some(path => path.startsWith("runtime/models/") || path.startsWith("runtime/browser-cache/"))) {
        throw new Error("gstack_executable_unexpected_bundled_resources");
      }
      for (const row of replacements) files.set(`runtime/${row.path}`, { ...row, path: `runtime/${row.path}` });
      for (const [path, bytes] of [["executable-build.json", executableBytes], ["runtime/testsavant-model-acquisition.json", acquisitionBytes]]) {
        if (files.has(path)) throw new Error("gstack_executable_prerequisites_changed");
        files.set(path, { path, checksum: digest(bytes), sizeBytes: bytes.length });
      }
      const cacheRoot = join(compiled, "browser-cache");
      for (const row of await bundleInventory(cacheRoot)) files.set(`runtime/browser-cache/${row.path}`,
        { ...row, path: `runtime/browser-cache/${row.path}` });
      plannedFiles = [...files.values()].sort((a, b) => a.path.localeCompare(b.path, "en"));
      const manifestBytes = serialize({ ...source, deliveryStage: "executable", target: stage.target, adaptationRevision, files: plannedFiles });
      const followingBytes = replacements.reduce((sum, row) => sum + row.sizeBytes, 0) +
        executableBytes.length + acquisitionBytes.length + manifestBytes.length;
      await copyStage(followingBytes);
      // This is a same-lease, same-device move, not another full ffmpeg copy.
      const destination = join(runtime, "browser-cache"), cacheInfo = await lstat(cacheRoot);
      if (await exists(destination) || !cacheInfo.isDirectory() || await realpath(cacheRoot) !== cacheRoot ||
        await realpath(runtime) !== runtime || cacheInfo.dev !== (await lstat(runtime)).dev) {
        throw new Error("gstack_executable_browser_cache_move_invalid");
      }
      await rename(cacheRoot, destination); // EXDEV deliberately propagates; no copy fallback.
      await resourceCheckpoint(lease.root, followingBytes);
    }
    for (const row of replacements) {
      const path = row.path;
      if (canonical([await bundleFile(compiled, path)]) !== canonical([row])) throw new Error("gstack_executable_build_inputs_changed");
      await resourceCheckpoint(lease.root, row.sizeBytes);
      const destination = join(runtime, path);
      if (await exists(destination)) await rm(destination);
      await copyFile(join(compiled, path), destination, constants.COPYFILE_EXCL);
      if (canonical([await bundleFile(runtime, path)]) !== canonical([row])) throw new Error("gstack_executable_build_inputs_changed");
      await resourceCheckpoint(lease.root);
    }
    if (modelMode === "bundled") {
      await mkdir(join(runtime, "models"), { recursive: true });
      await cp(modelRoot, join(runtime, "models/testsavant-small"), { recursive: true, errorOnExist: true, force: false });
    } else {
      if (await exists(join(runtime, "models"))) throw new Error("gstack_executable_unexpected_bundled_models");
      await writeBudgeted(join(runtime, "testsavant-model-acquisition.json"), acquisitionBytes);
    }
    await resourceCheckpoint(lease.root);
    await assertTools();
    await writeBudgeted(join(mainRoot, "executable-build.json"), executableBytes);
    onProgress("seal exact executable inventory and verify every byte, all57 skills and zero links");
    const manifest = { ...source, deliveryStage: "executable", target: stage.target, adaptationRevision,
      files: await bundleInventory(mainRoot) };
    if (plannedFiles && canonical(manifest.files) !== canonical(plannedFiles)) throw new Error("gstack_executable_copied_input_changed");
    await writeBudgeted(join(mainRoot, "manifest.json"), serialize(manifest));
    const verified = await readExecutableBundle(mainRoot);
    await resourceCheckpoint(lease.root);
    await publishStagedDirectory(candidate, outputRoot);
    completed = true;
    return { identity: verified.identity, fileCount: manifest.files.length, sizeBytes: manifest.files.reduce((sum, row) => sum + row.sizeBytes, 0) };
  } finally {
    if (completed) await rm(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [stageRoot, browserInspectionRoot, archiveRoot, outputRoot, expectedResourceStageChecksum, ...extra] = process.argv.slice(2);
  if (!expectedResourceStageChecksum || extra.length) throw new Error("gstack_executable_arguments_invalid");
  console.log(JSON.stringify(await assembleExecutableBundle({ stageRoot, browserInspectionRoot, archiveRoot, outputRoot,
    expectedResourceStageChecksum, onProgress: console.error })));
}
