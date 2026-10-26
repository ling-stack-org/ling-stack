import { execFileSync } from "node:child_process";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { initResourceWorkspace, requireResourceLease, resourceCheckpoint } from "./resource-workspace.mjs";
import { runManagedNode } from "./run-managed.mjs";
import { buildGstackSourceBundle } from "./build-source-bundle.mjs";
import { buildGstackNativeRuntime } from "./build-native-runtime.mjs";
import { prepareGstackPlatformResourceStage } from "./prepare-platform-resource-stage.mjs";
import { buildShellParser } from "./build-shell-parser-binary.mjs";
import { collectGstackBrowserArchives } from "./collect-browser-archives.mjs";
import { inspectGstackBrowserArchives } from "./inspect-browser-archives.mjs";
import { collectTestsavantModel } from "./collect-testsavant-model.mjs";
import { assembleExecutableBundle } from "./assemble-executable-bundle.mjs";
import { digest, readExecutableBundle } from "./executable-bundle.mjs";

const ownPath = fileURLToPath(import.meta.url);
const lock = JSON.parse(await readFile(new URL("./upstream-lock.json", import.meta.url)));
const exists = path => lstat(path).then(() => true, error => { if (error.code !== "ENOENT") throw error; return false; });
const steps = ["source", "native", "resource", "archives", "inspection", "model", "assembly"];

export function parseDesktopCandidateArguments(args) {
  const flags = new Set(["workspace", "mount", "bun", "shell", "source", "go", "selection", "stop-after"]);
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === "--ci-ephemeral") {
      if (options.ciEphemeral) throw new Error("gstack_desktop_duplicate_argument");
      options.ciEphemeral = true; continue;
    }
    const key = flag.slice(2);
    if (!flag.startsWith("--") || !flags.has(key) || options[key] !== undefined || !args[index + 1] || args[index + 1].startsWith("--")) {
      throw new Error("gstack_desktop_arguments_invalid");
    }
    options[key] = args[++index];
  }
  if (!options.workspace || !options.bun || !options.shell || !["source", "native", "resource", "complete"].includes(options["stop-after"] ?? "complete")) {
    throw new Error("Usage: prepare-desktop-candidate.mjs --workspace <new-root> --bun <absolute-bun> --shell <absolute-bash> [--mount <external-volume>|--ci-ephemeral] [--source <pinned-checkout>] [--go <go>] [--selection <new-selection.json>] [--stop-after source|native|resource|complete]");
  }
  for (const key of ["workspace", "bun", "shell", "mount", "source", "selection"]) {
    if (options[key] && !isAbsolute(options[key])) throw new Error(`gstack_desktop_absolute_path_required:${key}`);
  }
  if (options.mount && options.ciEphemeral) throw new Error("gstack_desktop_storage_policy_conflict");
  return options;
}

// Each admitted native target has an independent fixed SDK/compiler/graph review.
// Other targets keep their complete dependencies until their evidence is approved.
export function desktopCandidatePackageSelection(target = { platform: process.platform, arch: process.arch }) {
  return target.platform === "darwin" && target.arch === "arm64" || target.platform === "win32" && target.arch === "x64"
    ? "reviewed-sdk-only" : "retain-complete-upstream";
}

export function desktopCandidatePaths(root) {
  return { source: join(root, "artifacts/source/desktop-source"), native: join(root, "artifacts/native/desktop-native"),
    resource: join(root, "artifacts/resource/desktop-resources"), archives: join(root, "artifacts/browser/desktop-archives"),
    inspection: join(root, "artifacts/browser/desktop-inspection"), executable: join(root, "artifacts/native/desktop-executable"),
    parser: join(root, `artifacts/report/shell-parser${process.platform === "win32" ? ".exe" : ""}`) };
}

async function executeStep(step, options) {
  const lease = await requireResourceLease(), paths = desktopCandidatePaths(lease.root);
  const checksum = async (root, name) => digest(await readFile(join(root, name)));
  const progress = message => process.stderr.write(`${message}\n`);
  if (step === "source") {
    let sourcePath = options.source;
    if (!sourcePath) {
      sourcePath = join(lease.scratchPath, "tmp/upstream");
      await mkdir(sourcePath);
      const git = args => execFileSync("git", args, { cwd: sourcePath, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
        encoding: "utf8", timeout: 5 * 60_000, maxBuffer: 4 * 1024 ** 2 });
      git(["init"]); git(["remote", "add", "origin", lock.repository]);
      git(["fetch", "--depth", "1", "origin", lock.revision]);
      git(["-c", "core.autocrlf=false", "-c", "core.symlinks=true", "checkout", "--detach", "FETCH_HEAD"]);
    }
    await buildGstackSourceBundle({ sourcePath, outputPath: paths.source, bunCommand: options.bun });
  } else if (step === "native") await buildGstackNativeRuntime({ sourceBundlePath: paths.source, outputPath: paths.native,
    bunCommand: options.bun, shellCommand: options.shell, onProgress: progress });
  else if (step === "resource") {
    const parser = await buildShellParser({ outputPath: paths.parser, goCommand: options.go ?? "go" });
    await prepareGstackPlatformResourceStage({ nativeCandidatePath: paths.native, outputPath: paths.resource,
      expectedNativeBuildChecksum: await checksum(paths.native, "native-build.json"), shellPath: options.shell,
      parserPath: paths.parser, expectedParserChecksum: parser.artifact.checksum, parserProvenance: parser,
      packageSelection: desktopCandidatePackageSelection(), onProgress: progress });
  } else if (step === "archives") await collectGstackBrowserArchives({ resourceStagePath: paths.resource, outputPath: paths.archives,
    expectedResourceStageChecksum: await checksum(paths.resource, "resource-stage.json"), onProgress: progress });
  else if (step === "inspection") await inspectGstackBrowserArchives({ resourceStagePath: paths.resource, archivePath: paths.archives,
    outputPath: paths.inspection, expectedResourceStageChecksum: await checksum(paths.resource, "resource-stage.json"),
    expectedArchiveReceiptChecksum: await checksum(paths.archives, "browser-archives.json"),
    target: { platform: process.platform, arch: process.arch }, onProgress: progress });
  else if (step === "model") await collectTestsavantModel({ onProgress: progress });
  else if (step === "assembly") await assembleExecutableBundle({ stageRoot: paths.resource, browserInspectionRoot: paths.inspection,
    browserArchivesRoot: paths.archives, outputRoot: paths.executable, modelMode: "download-required", browserMode: "download-required",
    expectedResourceStageChecksum: await checksum(paths.resource, "resource-stage.json"),
    expectedArchiveReceiptChecksum: await checksum(paths.archives, "browser-archives.json"),
    expectedBrowserInspectionChecksum: await checksum(paths.inspection, "browser-member-inspection.json"), onProgress: progress });
  else throw new Error("gstack_desktop_step_invalid");
}

export async function prepareDesktopCandidate(options) {
  if (!(["darwin", "win32"].includes(process.platform) && (process.platform === "darwin" ? process.arch === "arm64" : process.arch === "x64"))) {
    throw new Error("gstack_desktop_native_host_required");
  }
  const root = resolve(options.workspace);
  if (await exists(root)) throw new Error("gstack_desktop_new_workspace_required");
  options = { ...options, bun: await realpath(options.bun), shell: await realpath(options.shell) };
  await initResourceWorkspace({ root, mountPath: options.mount, ciEphemeral: options.ciEphemeral });
  const stop = options["stop-after"] ?? "complete";
  for (const step of steps) {
    if (step === "model") continue; // Runtime acquires pinned weights into owned state on first use.
    process.stderr.write(`gstack desktop candidate: ${step}\n`);
    await writeFile(join(root, "desktop-candidate-progress.json"), `${JSON.stringify({
      schemaVersion: 1, scope: "desktop-candidate-progress", stage: step, status: "running",
      target: { platform: process.platform, arch: process.arch }, releaseEligible: false }, null, 2)}\n`);
    try {
      const result = await runManagedNode({ root, args: [ownPath, "--internal-step", step, JSON.stringify(options)],
        additionalBytes: step === "native" ? 6 * 1024 ** 3 : 0 });
      if (result.exitCode !== 0) throw new Error(`gstack_desktop_step_failed:${step}:${result.reason ?? result.exitCode}`);
    } catch (error) {
      // Small diagnostics survive managed scratch cleanup; do not retain a
      // partially built multi-GiB tree or treat failed output as a candidate.
      await writeFile(join(root, "desktop-candidate-failure.json"), `${JSON.stringify({
        schemaVersion: 1, scope: "desktop-candidate-failure", stage: step,
        target: { platform: process.platform, arch: process.arch }, releaseEligible: false,
        error: String(error?.message ?? error).slice(0, 2000),
        retainedEvidence: ["desktop-candidate-progress.json", "last-run.json",
          "artifacts/source/desktop-source/manifest.json", "artifacts/native/desktop-native/native-build.json",
          "artifacts/resource/desktop-resources/shared-command-closure.json",
          "artifacts/resource/desktop-resources/bundled-build-imports.json",
          "artifacts/resource/desktop-resources/resource-stage.json"],
        boundary: "Evidence paths are optional completed prerequisites; failed stages never imply native or release approval." }, null, 2)}\n`);
      throw error;
    }
    if (step === stop) break;
  }
  const paths = desktopCandidatePaths(root);
  let selection;
  if (stop === "complete") {
    const bundle = await readExecutableBundle(join(paths.executable, "gstack"));
    selection = { root: bundle.root, identity: bundle.identity };
    if (options.selection) {
      await mkdir(dirname(options.selection), { recursive: true });
      await writeFile(options.selection, `${JSON.stringify(selection, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    }
  }
  const summary = { schemaVersion: 1, scope: "unsigned-development-candidate", releaseEligible: false,
    upstreamRevision: lock.revision, upstreamVersion: lock.version, target: { platform: process.platform, arch: process.arch },
    completedStage: stop, paths, ...(selection ? { selection } : {}),
    modelMode: "download-required",
    pendingGates: ["whole-package-review", "installed-client-all57", "platform-native-acceptance", "redistribution-notices-and-authorization"] };
  await writeFile(join(root, "desktop-candidate.json"), `${JSON.stringify(summary, null, 2)}\n`, { flag: "wx" });
  await writeFile(join(root, "desktop-candidate-progress.json"), `${JSON.stringify({
    schemaVersion: 1, scope: "desktop-candidate-progress", stage: stop, status: "complete",
    target: summary.target, releaseEligible: false }, null, 2)}\n`);
  await resourceCheckpoint(root);
  return summary;
}

if (process.argv[1] && resolve(process.argv[1]) === ownPath) {
  if (process.argv[2] === "--internal-step") {
    if (process.argv.length !== 5) throw new Error("gstack_desktop_internal_arguments_invalid");
    await executeStep(process.argv[3], JSON.parse(process.argv[4]));
  } else console.log(JSON.stringify(await prepareDesktopCandidate(parseDesktopCandidateArguments(process.argv.slice(2))), null, 2));
}
