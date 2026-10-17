import { readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readGstackClosureFileRecord } from "./verify-shared-command-closure.mjs";

const scripts = dirname(fileURLToPath(import.meta.url));
const originalLaunch = `export function resolveServerLaunch(
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
  metaDir: string = import.meta.dir,
  execPath: string = process.execPath,
): { runtime: 'node' | 'bun'; script: string } {
  if (platform !== 'win32') return { runtime: 'bun', script: resolveServerScript(env, metaDir, execPath) };
  // On Windows, hard-fail if server-node.mjs is missing \u2014 the Bun path is known broken.
  const script = resolveNodeServerScript(metaDir, execPath);
  if (!script) throw new Error('server-node.mjs not found. Run \`bun run build\` to generate the Windows server bundle.');
  return { runtime: 'node', script };
}`;
const nodeStart = "  if (server.runtime === 'node') {";
const nodeEnd = "  } else {\n    // macOS/Linux: Bun.spawn().unref()";
const healthResult = "    return health.status === 'healthy';";
const cleanupIdentity = "readPidStartTime(pid) === startTime && readPidCmdline(pid).split(/\\s+/).includes(server.script)";
const directStates = [
  ["    const existingState = readState();", 2, "existingState"],
  ["    const stopState = readState();", 1, "stopState"],
  ["async function tunnelDaemonState(): Promise<ServerState | null> {\n  const state = readState();", 1, "state"],
  ["async function ensureServer(flags?: GlobalFlags): Promise<ServerState> {\n  const state = readState();", 1, "state"],
];

export async function readPackagedBrowseBuildPins({ root, expectedReceiptChecksum }, sourceChecksum) {
  root = resolve(root);
  const receipt = await readGstackClosureFileRecord(join(root, "browse/dist/node-server-build-provenance.json"), {
    retain: true, maximumBytes: 512 * 1024,
  });
  if (receipt.checksum !== expectedReceiptChecksum) throw new Error("packaged_browse_server_receipt_mismatch");
  const report = JSON.parse(receipt.bytes);
  if (report.sourceManifestChecksum !== sourceChecksum || report.securityActivation !== "package-relative-admission-before-server-start"
    || !/^sha256:[a-f0-9]{64}$/.test(report.securityComponentChecksum ?? "")) throw new Error("packaged_browse_server_not_admitted");
  const pins = {};
  for (const [name, path] of [["server", "browse/dist/server-node.mjs"], ["polyfill", "browse/dist/bun-polyfill.cjs"]]) {
    const expected = report.artifacts.find(file => file.path === path), actual = await readGstackClosureFileRecord(join(root, path));
    if (!expected || expected.checksum !== actual.checksum || expected.sizeBytes !== actual.sizeBytes) throw new Error("packaged_browse_server_changed");
    pins[name] = actual.checksum;
  }
  const component = await readGstackClosureFileRecord(join(root, "browse/dist/testsavant-component.json"), { retain: true, maximumBytes: 128 * 1024 });
  const data = JSON.parse(component.bytes);
  if (component.checksum !== report.securityComponentChecksum || data.runtimeMode !== "production-worker-only" || data.artifacts?.length !== 1
    || data.sourceManifestChecksum !== sourceChecksum || data.artifacts[0].path !== "testsavant-sidecar.mjs") throw new Error("packaged_browse_component_changed");
  const worker = await readGstackClosureFileRecord(join(root, "browse/dist/testsavant-sidecar.mjs"));
  if (worker.checksum !== data.artifacts[0].checksum || worker.sizeBytes !== data.artifacts[0].sizeBytes) throw new Error("packaged_browse_component_changed");
  const node = await readGstackClosureFileRecord(join(root, "tools", process.platform === "win32" ? "node.exe" : "node"));
  if (node.checksum !== data.node.checksum || node.sizeBytes !== data.node.sizeBytes) throw new Error("packaged_browse_node_changed");
  pins.node = node.checksum;
  pins.component = component.checksum;
  const browser = await readFile(join(root, "browser-selection.json"), "utf8").then(JSON.parse,
    error => { if (error.code !== "ENOENT") throw error; });
  if (browser) {
    if (browser.activation !== "package-relative-only" || !/^sha256:[a-f0-9]{64}$/.test(browser.entryChecksum)
      || browser.entryPath !== "../../gstack-browser/Chromium.app/Contents/MacOS/Chromium" || !/^sha256:[a-f0-9]{64}$/.test(browser.componentChecksum)
      || browser.target?.platform !== process.platform
      || browser.target?.arch !== process.arch) throw new Error("packaged_browse_browser_selection_invalid");
    pins.browser = { path: browser.entryPath, checksum: browser.entryChecksum, componentChecksum: browser.componentChecksum };
  }
  return pins;
}

export function packagedBrowseBuildPlugin({ runtimeRoot, pins }) {
  const cli = join(resolve(runtimeRoot), "browse/src/cli.ts"), helper = join(scripts, "packaged-browse-launch.mjs");
  return { name: "ling-packaged-browse-launch", setup(build) {
    build.onLoad({ filter: /(?:cli\.ts|packaged-browse-launch\.mjs)$/ }, async args => {
      if (await realpath(args.path) !== args.path) throw new Error("packaged_browse_build_alias");
      if (args.path === cli) {
        let contents = await readFile(cli, "utf8");
        for (const marker of [originalLaunch, nodeStart, nodeEnd, healthResult, cleanupIdentity]) {
          if (contents.split(marker).length !== 2) throw new Error("packaged_browse_upstream_launch_changed");
        }
        for (const [marker, count, state] of directStates) {
          if (contents.split(marker).length !== count + 1) throw new Error("packaged_browse_upstream_dispatch_changed");
          contents = contents.replaceAll(marker, `${marker}\n  await __lingPackagedBrowseAssertExisting(${state}, Boolean(${state}?.pid && isProcessAlive(${state}.pid)));`);
        }
        const start = contents.indexOf(nodeStart), end = contents.indexOf(nodeEnd, start);
        if (end < start) throw new Error("packaged_browse_upstream_launch_changed");
        contents = contents.slice(0, start) + `${nodeStart}\n    const pid = __lingPackagedBrowseSpawn(server, daemonLogPath(),
      { BROWSE_STATE_FILE: config.stateFile, BROWSE_PARENT_PID: parentPid, ...extraEnv });
    spawnedServer = { pid, startTime: __lingPackagedBrowseProcessIdentity(pid, server) };\n` + contents.slice(end);
        contents = contents.replace(originalLaunch, "export function resolveServerLaunch() { return __lingPackagedBrowseLaunch(); }")
          .replace(healthResult, "    return __lingPackagedBrowseHealth(health);")
          .replace("  } catch {\n    return false;\n  }\n}\n\n/** Best-effort tab count", "  } catch (error) {\n    if (String(error).includes('packaged_browse_existing_server_mismatch')) throw error;\n    return false;\n  }\n}\n\n/** Best-effort tab count")
          .replace(cleanupIdentity, "__lingPackagedBrowseProcessIdentity(pid, server) === startTime");
        return { contents: `import {packagedBrowseLaunch as __lingPackagedBrowseLaunch, packagedBrowseHealth as __lingPackagedBrowseHealth,
          packagedBrowseSpawn as __lingPackagedBrowseSpawn, packagedBrowseProcessIdentity as __lingPackagedBrowseProcessIdentity,
          packagedBrowseAssertExisting as __lingPackagedBrowseAssertExisting} from ${JSON.stringify(helper)};\n${contents}`,
          loader: "ts", resolveDir: dirname(cli) };
      }
      if (args.path === helper) {
        const source = await readFile(helper, "utf8"), marker = 'const packagedBrowsePins = "NO_PACKAGED_BROWSE_PINS";';
        if (source.split(marker).length !== 2) throw new Error("packaged_browse_build_marker_changed");
        return { contents: source.replace(marker, `const packagedBrowsePins = ${JSON.stringify(JSON.stringify(pins))};`), loader: "js" };
      }
    });
  } };
}
