import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { cp, copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleFile, bundleInventory, digest, readExecutableBundle } from "./executable-bundle.mjs";
import { materializeLocalBrowser, materializeLocalFfmpeg } from "./materialize-local-browser.mjs";
import { materializePlaywrightBrowser } from "./materialize-playwright-browser.mjs";
import { managedResourceWrite, resourceCheckpoint } from "./resource-workspace.mjs";
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
  const lease = await managedResourceWrite(outputRoot, { kind: "native", additionalBytes: 4 * 1024 ** 3 });
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
  let completed = false;
  try {
    await mkdir(candidate);
    onProgress("materialize one no-link local candidate from retained prerequisites");
    await cp(stageRoot, mainRoot, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE, errorOnExist: true, force: false });
    if (canonical(await bundleInventory(mainRoot)) !== canonical(actual)) throw new Error("gstack_executable_copied_input_changed");
    const runtime = join(mainRoot, "runtime"), retainedRuntime = join(stageRoot, "runtime"), compiled = join(work, "compiled");
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
      cacheOutputRoot: join(runtime, "browser-cache"), managedRoot: lease.root, target: stage.target, browserMode })
      : await materializeLocalBrowser({ inspectionRoot: browserInspectionRoot, runtimeRoot: retainedRuntime,
        outputRoot: join(candidate, "gstack-browser"), managedRoot: lease.root });
    if (!browserArchivesRoot) browser.ffmpeg = await materializeLocalFfmpeg({ archiveRoot: resolve(archiveRoot),
      runtimeRoot: retainedRuntime, cacheRoot: join(runtime, "browser-cache"), managedRoot: lease.root });
    await mkdir(join(compiled, "tools"));
    await copyFile(join(retainedRuntime, `tools/node${suffix}`), join(compiled, `tools/node${suffix}`));
    // Browser pins become compiler input, not a runtime environment override.
    await writeFile(join(compiled, "browser-selection.json"), `${JSON.stringify(browser, null, 2)}\n`, { flag: "wx" });
    build("build-bun-native-resource.mjs", ["packaged-browse", retainedRuntime, compiled]);
    for (const path of [`browse/dist/browse${suffix}`, `browse/dist/browse${suffix}.build-provenance.json`, "browse/dist/server-node.mjs",
      "browse/dist/bun-polyfill.cjs", "browse/dist/node-server-build-provenance.json", "browse/dist/testsavant-component.json",
      "browse/dist/testsavant-sidecar.mjs", "browser-selection.json"]) {
      const destination = join(runtime, path);
      if (await exists(destination)) await rm(destination);
      await copyFile(join(compiled, path), destination, constants.COPYFILE_EXCL);
    }
    if (modelMode === "bundled") {
      await mkdir(join(runtime, "models"), { recursive: true });
      await cp(modelRoot, join(runtime, "models/testsavant-small"), { recursive: true, errorOnExist: true, force: false });
    } else {
      if (await exists(join(runtime, "models"))) throw new Error("gstack_executable_unexpected_bundled_models");
      await writeFile(join(runtime, "testsavant-model-acquisition.json"), `${JSON.stringify(modelAcquisition, null, 2)}\n`, { flag: "wx" });
    }
    await resourceCheckpoint(lease.root);
    if (canonical(tools) !== canonical(await Promise.all(toolPaths.map(path => bundleFile(repo, path))))) throw new Error("gstack_executable_build_inputs_changed");
    const adaptationRevision = `ling-${digest(Buffer.from(canonical(tools))).slice(7)}`;
    await writeFile(join(mainRoot, "executable-build.json"), `${JSON.stringify({ schemaVersion: 1, scope: "isolated-local-client",
      releaseEligible: false, packageAcceptance: "pending", upstreamRevision: source.upstream.revision,
      retainedStageChecksum: expectedResourceStageChecksum, stageSelection: "explicit-detached-rebuilt-or-retained",
      adaptationRevision, toolInputs: tools, browser,
      ...(modelAcquisition ? { modelAcquisition } : {}),
      pendingGates: ["whole-package-review", "installed-client-all57", "native-windows", "redistribution-notices-and-authorization"] }, null, 2)}\n`, { flag: "wx" });
    onProgress("seal exact executable inventory and verify every byte, all57 skills and zero links");
    const manifest = { ...source, deliveryStage: "executable", target: stage.target, adaptationRevision,
      files: await bundleInventory(mainRoot) };
    await writeFile(join(mainRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
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
