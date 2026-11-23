import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runOwnedProcess } from "../../apps/desktop/scripts/cua-driver-owned-process.mjs";
import { extractCuaDriverFinalArtifact } from "../../apps/desktop/scripts/cua-driver-signing/final-artifact-extractor.mjs";
import { extractedApplicationPath } from "./desktop-payload.mjs";
import { fileRecord, targetAssets } from "./desktop-release.mjs";

if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("Use a native Apple Silicon host for the installed startup check.");
}

const [evidenceArgument = ".codex-artifacts/desktop-release", releaseArgument = "apps/desktop/release"] = process.argv.slice(2);
const evidenceRoot = resolve(evidenceArgument);
const target = "macos-arm64";
const report = JSON.parse(await readFile(join(evidenceRoot, "package-verification.json"), "utf8"));
if (!/^[0-9a-f]{40}$/u.test(process.env.DESKTOP_SOURCE_SHA ?? "")
  || report.sourceSha !== process.env.DESKTOP_SOURCE_SHA || report.target !== target
  || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(report.version)
  || report.status !== "passed" || report.signingTier !== "unsigned_dev"
  || !["bundled", "on-demand"].includes(report.pluginMode)) {
  throw new Error("Matching verified macOS development package evidence is required.");
}
const name = targetAssets(report, target).find(asset => asset.endsWith(".dmg"));
const image = resolve(releaseArgument, name);
const dmg = report.archives.find(archive => archive.name === name);
const observed = await fileRecord(image);
if (!dmg || observed.sha256 !== dmg.sha256 || observed.sizeBytes !== dmg.sizeBytes) {
  throw new Error("The DMG bytes do not match package verification.");
}

// Packaged resource authentication requires canonical paths for the staged
// application and the user cache. macOS temporary paths can have OS aliases.
const temporary = await realpath(process.env.RUNNER_TEMP ?? tmpdir());
const root = await mkdtemp(join(temporary, "ling-mac-installed-"));
try {
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  const userData = join(root, "user-data");
  const applications = join(root, "Applications");
  const installed = join(applications, "Ling Stack.app");
  await Promise.all([mkdir(applications), mkdir(home), mkdir(workspace)]);

  const extraction = await extractCuaDriverFinalArtifact(image, { platform: "darwin", artifactRole: "outer-dmg" });
  try {
    const source = await extractedApplicationPath(extraction.artifactRoot, target);
    await runOwnedProcess("/usr/bin/ditto", [source, installed], { timeout: 120_000 });
  } finally {
    await extraction.cleanup();
  }
  await runOwnedProcess("/usr/bin/codesign", ["--verify", "--deep", "--strict", installed], { timeout: 60_000 });

  const listener = createServer();
  const listening = once(listener, "listening");
  listener.listen(0, "127.0.0.1");
  await listening;
  const { port } = listener.address();
  await new Promise((done, fail) => listener.close(error => error ? fail(error) : done()));

  const env = {
    ...process.env,
    HOME: home,
    LING_STACK_HOME: join(root, "ling-home"),
    LING_STACK_DEFAULT_WORKSPACE_CWD: workspace,
    LING_STACK_DAEMON_URL: `http://127.0.0.1:${port}`,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  const started = performance.now();
  const executable = join(installed, "Contents/MacOS/Ling Stack");
  const entry = join(installed, "Contents/Resources/app.asar/dist/daemon/cli.mjs");
  const child = spawn(executable, [entry], {
    cwd: workspace,
    env: { ...env, ELECTRON_RUN_AS_NODE: "1", LING_STACK_PACKAGED_DESKTOP: "1",
      LING_STACK_HOST: "127.0.0.1", LING_STACK_PORT: String(port),
      LING_STACK_RESOURCE_BOOTSTRAP_FD: "4", LING_STACK_SHUTDOWN_OBSERVER_FD: "5" },
    stdio: ["ignore", "ignore", "pipe", "ignore", "pipe", "pipe"],
  });
  const exited = once(child, "close");
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", text => { stderr = (stderr + text).slice(-2000); });
  child.stdio[5].resume();
  const terminate = setTimeout(() => child.kill("SIGKILL"), 235_000);
  try {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of child.stdio[4]) {
      bytes += chunk.length;
      if (bytes > 1024) throw new Error("Resource receipt exceeded its bound.");
      chunks.push(chunk);
    }
    const resourcePreparationMs = Math.round(performance.now() - started);
    const receipt = JSON.parse(Buffer.concat(chunks).toString());
    if (receipt.schemaVersion !== 1 || receipt.phase !== "resources_ready" || receipt.pid !== child.pid) {
      throw new Error("The installed daemon did not authenticate its resources.");
    }

    let serviceReady = false;
    const readinessDeadline = Date.now() + 20_000;
    do {
      const health = await fetch(env.LING_STACK_DAEMON_URL + "/health", { signal: AbortSignal.timeout(800) })
        .then(x => x.ok ? x.json() : undefined).catch(() => undefined);
      if (health?.service === "ling-stack-daemon" && health.defaultWorkspaceCwd === workspace) {
        serviceReady = true;
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    } while (Date.now() < readinessDeadline && child.exitCode === null && child.signalCode === null);
    if (!serviceReady) throw new Error("The installed daemon did not become ready after authenticating resources.");
    const serviceReadyMs = Math.round(performance.now() - started);
    child.kill("SIGTERM");
    const [code, signal] = await exited;
    if (code !== 0 || signal !== null) throw new Error("The installed daemon did not stop normally.");
    const result = {
      target, pluginMode: report.pluginMode, sourceSha: report.sourceSha, dmgSha256: observed.sha256,
      resourcePreparationMs, serviceReadyMs, normalExit: true,
    };
    console.log(result);
    await writeFile(join(evidenceRoot, "macos-installed-daemon-probe.json"), JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
  } catch (error) {
    child.kill("SIGKILL");
    await exited;
    if (stderr) console.error(stderr);
    throw error;
  } finally {
    clearTimeout(terminate);
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
