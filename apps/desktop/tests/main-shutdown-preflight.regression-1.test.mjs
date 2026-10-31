import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";
import { transform } from "esbuild";
import { DesktopDaemonLifecycleError } from "../dist/main/daemon-lifecycle.js";

// Executes main.ts's actual shutdown body with resource fakes, not a duplicate
// shutdown implementation. No Electron instance, real data or GUI is touched.
const source = await readFile(new URL("../main/main.ts", import.meta.url), "utf8");
const offset = source.indexOf("async function shutdown(): Promise<void> {");
assert.ok(offset > 0);
const compiled = await transform(source.slice(offset), { loader: "ts", format: "cjs" });

for (const code of ["stop_blocked", "stop_unconfirmed"]) {
  test(`main preflight ${code} preserves IPC, window and execution owners`, async () => {
    const failure = new DesktopDaemonLifecycleError(code, "http://127.0.0.1:17928");
    const f = fixture(async () => { throw failure; });
    await assert.rejects(f.shutdown(), error => error === failure);
    assert.deepEqual(f.events, ["stop-opens", "host-preflight"]);
    assert.equal(f.context.mainWindow, f.window);
    assert.equal(f.context.desktopRuntime, f.runtime);
    assert.equal(f.context.computerUse, f.computerUse);
    assert.equal(f.context.officeDriverRuntime, f.office);
  });
}

test("main does not destroy any owned transport before Host preflight resolves", async () => {
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  const f = fixture(() => barrier);
  const stopping = f.shutdown();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.events, ["stop-opens", "host-preflight"]);
  release();
  await stopping;
  assert.ok(f.events.indexOf("computer-use") > f.events.indexOf("host-preflight"));
  assert.ok(f.events.indexOf("runtime-cleanup") > f.events.indexOf("office"));
  assert.equal(f.context.mainWindow, undefined);
  assert.equal(f.context.desktopRuntime, undefined);
});

function fixture(prepare) {
  const events = [];
  const window = { isDestroyed: () => false, destroy() { events.push("window"); },
    webContents: { session: { closeAllConnections() { events.push("http"); } } } };
  const runtime = { async prepareShutdown() { events.push("host-preflight"); await prepare(); },
    async shutdown() { events.push("runtime-cleanup"); } };
  const computerUse = { async dispose() { events.push("computer-use"); } };
  const office = { async stop() { events.push("office"); } };
  const context = vm.createContext({
    mainWindowOpenCoordinator: { stopAcceptingAndWait() { events.push("stop-opens"); return Promise.resolve(); } },
    mainWindow: window, loadingMainWindow: undefined, desktopRuntime: runtime, computerUse,
    officeDriverRuntime: office, hostCapabilityRuntime: { async stop() { events.push("host-capabilities"); } },
    unregisterLockedControlPreview() { events.push("preview-ipc"); },
    windowsProviderSmokeCommandReader: undefined, macosTccRevocationCommandReader: undefined,
    unregisterThemePackageIpc() { events.push("theme-ipc"); },
    humanEvaluation: { async dispose() { events.push("human-evaluation"); } },
    unregisterIpc() { events.push("ipc"); }, captureSmokeTargetWindows: [],
    realCaptureSmokeDescriptorRegistry: undefined, realCaptureSmokeProjectionClient: undefined,
  });
  const shutdown = vm.runInContext(`${compiled.code}\nshutdown;`, context);
  return { context, shutdown, events, window, runtime, computerUse, office };
}
