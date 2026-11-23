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
  let failure;
  try {
    await runOwnedProcess(join(installed, "Contents/MacOS/Ling Stack"),
      ["--ling-desktop-smoke-headless", `--user-data-dir=${userData}`],
      { cwd: workspace, env, timeout: 240_000 });
  } catch (error) {
    failure = error;
  }
  const durationMs = Math.round(performance.now() - started);
  const startupLog = await readFile(join(userData, "desktop-startup.log"), "utf8").catch(error => {
    if (error.code !== "ENOENT") throw error;
    return "";
  });
  const events = startupLog.split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line));
  const names = events.map(event => event.event);
  console.log("Installed macOS Desktop events", events.map(({ ts, event }) => ({ ts, event })));
  if (failure) throw failure;
  const app = events.findIndex(event => event.event === "app.ready" && event.packaged === true);
  const daemon = events.findIndex(event => event.event === "daemon.connected" && event.ownedByDesktop === true);
  const renderer = names.indexOf("main_window.loaded");
  if (app < 0 || daemon <= app || renderer <= daemon
    || names.includes("app.startup_failed") || names.includes("app.shutdown_failed")) {
    throw new Error("Installed Desktop did not load the main window with its own daemon and exit normally.");
  }
  const preparing = names.indexOf("daemon.resources_preparing");
  const ready = names.indexOf("daemon.resources_ready");
  const resourcePreparationMs = Date.parse(events[ready]?.ts) - Date.parse(events[preparing]?.ts);
  if (!(preparing > app && ready > preparing && ready < daemon && resourcePreparationMs >= 0)) {
    throw new Error("The owned daemon did not report successful resource preparation.");
  }
  const evidence = {
    sourceSha: report.sourceSha, target, pluginMode: report.pluginMode, dmgSha256: observed.sha256,
    status: "passed", daemonOwnedByDesktop: true, normalExit: true, durationMs, resourcePreparationMs,
    signingTier: report.signingTier, interactiveAcceptance: "not_run",
  };
  await writeFile(join(evidenceRoot, "macos-installed-startup.json"), JSON.stringify(evidence, null, 2) + "\n", { flag: "wx" });
} finally {
  await rm(root, { recursive: true, force: true });
}
