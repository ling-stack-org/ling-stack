import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { verifyBundledBrowser } from "../../packages/core/src/bundled-skill-browser.ts";

const packagedBrowsePins = "NO_PACKAGED_BROWSE_PINS";

function verify(path, expected, maximumBytes) {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || realpathSync(path) !== path || before.size > maximumBytes) {
    throw new Error("packaged_browse_resource_invalid");
  }
  const bytes = readFileSync(path), after = lstatSync(path);
  if (bytes.length !== before.size || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
    `sha256:${createHash("sha256").update(bytes).digest("hex")}` !== expected) throw new Error("packaged_browse_resource_mismatch");
}

/** The executable's own adjacent resources are authoritative, never PATH/env. */
export function packagedBrowseLaunch() {
  const pins = JSON.parse(packagedBrowsePins);
  const dist = dirname(process.execPath), runtime = resolve(dist, "../..");
  const node = resolve(runtime, "tools", process.platform === "win32" ? "node.exe" : "node");
  const script = resolve(dist, "server-node.mjs");
  verify(node, pins.node, 256 * 1024 ** 2);
  verify(script, pins.server, 16 * 1024 ** 2);
  verify(resolve(dist, "bun-polyfill.cjs"), pins.polyfill, 2 * 1024 ** 2);
  let browser;
  if (pins.browser) {
    if (pins.browser.path !== "../../gstack-browser/Chromium.app/Contents/MacOS/Chromium") throw new Error("packaged_browse_browser_selection_invalid");
    browser = verifyBundledBrowser(resolve(runtime, "../../gstack-browser"), pins.browser.componentChecksum,
      { platform: process.platform, arch: process.arch }).entry;
    verify(browser, pins.browser.checksum, 256 * 1024 ** 2);
  }
  return { runtime: "node", script, node, ...(browser ? { browser } : {}) };
}

export function packagedBrowseHealth(health) {
  if (health?.lingComponent !== JSON.parse(packagedBrowsePins).component) {
    throw new Error("packaged_browse_existing_server_mismatch: use the owning CLI to stop the existing service");
  }
  return health.status === "healthy";
}

export async function packagedBrowseAssertExisting(state, alive) {
  if (!state) return;
  if (!Number.isInteger(state.port) || state.port < 1 || state.port > 65535 ||
    !Number.isSafeInteger(state.pid) || state.pid < 1) throw new Error("packaged_browse_existing_server_mismatch");
  let health;
  try {
    const response = await fetch(`http://127.0.0.1:${state.port}/health`, { signal: AbortSignal.timeout(2000) });
    if (!response.ok) throw new Error("health_unavailable");
    const reader = response.body?.getReader();
    if (!reader) throw new Error("health_unavailable");
    const chunks = []; let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 16384) throw new Error("health_over_budget");
        chunks.push(value);
      }
    } finally { await reader.cancel(); reader.releaseLock(); }
    health = JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
  } catch {
    if (alive) throw new Error("packaged_browse_server_identity_unavailable: refusing to replace an unidentified live service");
    return;
  }
  packagedBrowseHealth(health);
}

export function packagedBrowseEnvironment(source = process.env, extra = {}) {
  const output = {};
  const allowed = new Set(["PATH", "HOME", "USERPROFILE", "TMPDIR", "TMP", "TEMP", "SystemRoot", "WINDIR",
    "LANG", "LC_ALL", "DISPLAY", "XAUTHORITY", "CHROMIUM_PROFILE", "CI", "AUTH_TOKEN", "NGROK_AUTHTOKEN", "NGROK_DOMAIN",
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"]);
  for (const [key, value] of Object.entries({ ...source, ...extra })) {
    if (value !== undefined && (allowed.has(key) || /^(?:BROWSE|GSTACK)_/.test(key))) output[key] = value;
  }
  return output;
}

/** Only the launcher receives this environment; Node preload/load paths never cross it. */
export function packagedBrowseSpawn(server, logPath, extra) {
  const code = `const fs=require('node:fs'),{spawn}=require('node:child_process');
    let fd;try{fd=fs.openSync(${JSON.stringify(logPath)},'a')}catch{fd='ignore'}
    const child=spawn(process.execPath,[${JSON.stringify(server.script)}],{detached:true,windowsHide:true,
      stdio:['ignore',fd,fd],env:process.env});
    child.once('error',()=>{process.exitCode=1});
    child.once('spawn',()=>{fs.writeSync(1,String(child.pid));child.unref()});
    if(typeof fd==='number')fs.closeSync(fd);`;
  const env = packagedBrowseEnvironment(process.env, extra);
  if (server.browser) {
    env.GSTACK_CHROMIUM_PATH = server.browser;
    delete env.BROWSE_HEADLESS_SKIP;
    env.PLAYWRIGHT_BROWSERS_PATH = resolve(dirname(server.script), "../../browser-cache");
    delete env.CI;
    delete env.CONTAINER;
    delete env.GSTACK_CHROMIUM_NO_SANDBOX;
  }
  const result = Bun.spawnSync([server.node, "-e", code], {
    env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, timeout: 5000,
  });
  const value = result.stdout.toString().trim(), pid = Number(value);
  if (result.exitCode !== 0 || !/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(pid)) {
    throw new Error("packaged_browse_launcher_failed");
  }
  return pid;
}

/** Birth identity plus the exact fixed argv handles spaces without broad PID killing. */
export function packagedBrowseProcessIdentity(pid, server) {
  let command, birth;
  if (process.platform === "darwin") {
    const read = field => {
      const result = Bun.spawnSync(["/bin/ps", "-p", String(pid), "-o", `${field}=`], { stdout: "pipe", stderr: "pipe", timeout: 2000 });
      return result.exitCode === 0 ? result.stdout.toString().trim() : "";
    };
    birth = read("lstart"); command = read("command");
  } else if (process.platform === "win32") {
    const shell = resolve(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe");
    const result = Bun.spawnSync([shell, "-NoProfile", "-NonInteractive", "-Command",
      `$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}';if($p){@{birth=$p.CreationDate.ToUniversalTime().ToString('o');command=$p.CommandLine}|ConvertTo-Json -Compress}`],
    { stdout: "pipe", stderr: "pipe", timeout: 2000, windowsHide: true });
    if (result.exitCode !== 0) return "";
    try { ({ birth, command } = JSON.parse(result.stdout.toString())); } catch { return ""; }
  }
  if (!birth || typeof command !== "string") return "";
  return packagedBrowseCommandMatches(command, server) ? `${birth}\n${command}` : "";
}

export function packagedBrowseCommandMatches(command, server) {
  // Windows paths cannot contain a double quote. JSON encoding is not command
  // line quoting: doubling backslashes would reject every quoted Windows path.
  const quote = value => `"${value}"`;
  const allowed = [server.node, quote(server.node)].flatMap(node =>
    [server.script, quote(server.script)].map(script => `${node} ${script}`));
  return typeof command === "string" && allowed.includes(command.trim());
}
