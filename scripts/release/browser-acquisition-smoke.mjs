import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { readExecutableBundle } from "../gstack/executable-bundle.mjs";
import { initResourceWorkspace, managedResourceWrite, requireResourceLease } from "../gstack/resource-workspace.mjs";
import { ensureBrowserAcquisition } from "../gstack/browser-acquisition.mjs";
import { loadPackagedBrowserZipParser } from "../gstack/packaged-browse-launch.mjs";

/** Real native CLI/browser acceptance on a disposable runner, distinct from GUI
 * installation or model/Office acceptance. No system browser or Node fallback. */
export async function smokeBrowserAcquisition(bundleRoot) {
  const lease = await requireResourceLease(), bundle = await readExecutableBundle(bundleRoot);
  assert.equal(bundle.receipt.browser.activation, "download-required");
  const acquisition = JSON.parse(await readFile(bundle.browser.entry));
  const runtime = join(bundle.root, "runtime"), suffix = process.platform === "win32" ? ".exe" : "";
  const cli = join(runtime, `browse/dist/browse${suffix}`);
  const pins = JSON.parse(await readFile(`${cli}.build-provenance.json`)).launchPins;
  const parser = pins.browser.parser;
  assert.equal(parser.path, "node_modules/playwright-core/lib/utilsBundle.js");
  const yauzl = loadPackagedBrowserZipParser(join(runtime, parser.path), parser.checksum);
  // Detached services outlive the supervisor's process group. Keep ownership
  // evidence outside auto-cleaned scratch until a normal stop is confirmed.
  const work = join(lease.root, "artifacts/report", `browser-native-smoke-${lease.token}`);
  await managedResourceWrite(work, { kind: "report", additionalBytes: 2 * 1024 ** 3 });
  await mkdir(work, { recursive: true, mode: 0o700 });
  const stateRoot = join(work, "state"), stateFile = join(stateRoot, "browse.json");
  for (const path of [stateRoot, join(work, "home")]) await mkdir(path, { mode: 0o700 });
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end('<!doctype html><title>Ling native browser smoke</title><h1>Cache ready</h1><button onclick="document.querySelector(\'h1\').textContent=\'Interaction passed\'">Verify</button>');
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const commands = [], ownedPids = new Set();
  const env = { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, LANG: "en_US.UTF-8",
    HOME: join(work, "home"), USERPROFILE: join(work, "home"), PATH: join(work, "no-system-node"),
    TMPDIR: join(lease.scratchPath, "tmp"), TMP: join(lease.scratchPath, "tmp"), TEMP: join(lease.scratchPath, "tmp"),
    GSTACK_HOME: stateRoot, GSTACK_STATE_ROOT: stateRoot, CHROMIUM_PROFILE: join(stateRoot, "profile"),
    BROWSE_EXTENSIONS_DIR: join(runtime, "extension"),
    BROWSE_STATE_FILE: stateFile, BROWSE_PARENT_PID: "0", BROWSE_START_TIMEOUT: "30000",
    GSTACK_CHROMIUM_PATH: "/untrusted/browser", PLAYWRIGHT_BROWSERS_PATH: "/untrusted/cache",
    NODE_OPTIONS: "--require=/untrusted/preload", NODE_PATH: "/untrusted/dependencies" };
  let live = false, completed = false;
  async function command(args, timeout = 45000, expectedStatus = 0) {
    const child = spawn(cli, args, { cwd: work, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", error = "", bytes = 0;
    for (const [stream, append] of [[child.stdout, value => { output += value; }], [child.stderr, value => { error += value; }]]) {
      stream.on("data", value => { bytes += value.length; if (bytes > 1024 ** 2) child.kill(); else append(value.toString()); });
    }
    const timer = setTimeout(() => child.kill(), timeout);
    const status = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); })
      .finally(() => clearTimeout(timer));
    commands.push({ args, status });
    assert.equal(status, expectedStatus, `${args.join(" ")}\n${output}\n${error}`);
    if (args[0] === "status" && status === 0) {
      const state = await readFile(stateFile).then(JSON.parse, cause => {
        throw new Error(`browser_smoke_state_unavailable\nstdout: ${output.slice(0, 4096)}\nstderr: ${error.slice(0, 4096)}`, { cause });
      });
      assert.ok(Number.isSafeInteger(state.pid) && state.pid > 0);
      ownedPids.add(state.pid);
    }
    if (args[0] === "stop") {
      for (const pid of ownedPids) {
        const deadline = Date.now() + 10000;
        for (;;) {
          try { process.kill(pid, 0); }
          catch (error) { if (error.code !== "ESRCH") throw error; break; }
          if (Date.now() >= deadline) throw new Error("browser_smoke_owned_service_did_not_exit");
          await delay(100);
        }
      }
      ownedPids.clear();
    }
    return expectedStatus === 0 ? output : error;
  }
  try {
    assert.match(await command(["--version"]), /\S/u, "the native CLI must execute its entry point");
    env.BROWSE_NO_AUTOSTART = "1";
    assert.match(await command(["status"], 45000, 1), /Server not available/u);
    delete env.BROWSE_NO_AUTOSTART;
    // Empty state: exercise the compiled acquisition path and real official URL.
    live = true;
    await command(["status"], 240000);
    await command(["goto", `http://127.0.0.1:${server.address().port}/`]);
    await command(["click", "button"]);
    assert.match(await command(["text"]), /Interaction passed/);
    await command(["stop"]); live = false;
    let networkRequests = 0;
    const cached = await ensureBrowserAcquisition({ stateRoot, acquisition, yauzl,
      request: async () => { networkRequests++; throw new Error("offline smoke: network disabled"); } });
    assert.equal(networkRequests, 0);
    cached.assertCurrent();
    // Restart with failed outbound proxy: still exercise the compiled launcher
    // and real local navigation. This is proxy simulation, not an OS firewall.
    env.HTTPS_PROXY = "http://127.0.0.1:1"; env.HTTP_PROXY = env.HTTPS_PROXY; env.NO_PROXY = "127.0.0.1,localhost";
    live = true;
    await command(["status"]);
    await command(["goto", `http://127.0.0.1:${server.address().port}/`]);
    assert.match(await command(["text"]), /Cache ready/);
    await command(["stop"]); live = false;
    bundle.browser.assertCurrent(); cached.assertCurrent();
    completed = true;
    return { status: "passed", scope: "native-packaged-cli-browser-acquisition-and-cache",
      browserVersion: acquisition.browserVersion, archive: acquisition.archive,
      descriptorChecksum: bundle.browser.checksum, componentChecksum: cached.checksum,
      officialFirstDownload: true, cacheReuseNetworkRequests: networkRequests,
      browserInteraction: "passed", restartWithUnavailableProxy: "passed", systemNodeRequired: false,
      commands, ownedServicesReaped: true, installedGuiAcceptance: "not_run", modelAndOfficeAcceptance: "not_run" };
  } finally {
    let cleanupError;
    if (live) {
      try { await command(["stop"]); live = false; }
      catch (error) { cleanupError = error; }
    }
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    if (!live && ownedPids.size === 0) {
      if (completed) await rm(work, { recursive: true, force: true });
      else console.error(`browser_smoke_failed_state_retained:${work}`);
    } else throw new Error(`browser_smoke_cleanup_failed_state_retained:${work}`, { cause: cleanupError });
  }
}

export async function prepareBrowserSmokeWorkspace() {
  // The build's two retained report slots hold its parser and provenance.
  // A fresh workspace keeps those inputs intact and keeps the retention gate.
  const root = join(process.env.RUNNER_TEMP, "gstack-browser-smoke");
  await initResourceWorkspace({ root, ciEphemeral: true });
  return root;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [root, report, ...extra] = process.argv.slice(2);
  if (!root || !report || extra.length) throw new Error("browser_smoke_arguments_invalid");
  await writeFile(report, `${JSON.stringify(await smokeBrowserAcquisition(resolve(root)), null, 2)}\n`, { flag: "wx" });
}
