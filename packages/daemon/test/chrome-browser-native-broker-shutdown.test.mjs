import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { connect } from "node:net";
import { join } from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import { bounded, descriptorPathForA01, observeA01Descriptor, runA01Child } from "./support/a01-browser-descriptor-fixture.mjs";

const caseName = process.env.LING_A01_CASE;
if (!caseName) {
  for (const name of ["shutdown-helper", "daemon-stop"]) test(`A01 deferred broker shutdown: ${name}`,
    { timeout: 50_000 }, () => runA01Child(name, import.meta.url));
} else if (caseName === "shutdown-helper") {
  test("A01 actual shutdown-helper child", async () => {
    console.log("A01 child entered: shutdown-helper");
    const { shutdownAfterNativeBroker } = await import("../dist/features/browser-extension/native-broker-shutdown.js");
    const original = new Error("test-broker-close"), downstream = new Error("test-downstream");
    const values = [undefined, null, original];
    const order = [];
    await shutdownAfterNativeBroker(async () => { order.push("broker"); }, async () => { order.push("remaining"); });
    assert.deepEqual(order, ["broker", "remaining"]);
    let absentDrains = 0;
    await shutdownAfterNativeBroker(async () => {}, async () => { absentDrains++; });
    assert.equal(absentDrains, 1);
    for (const value of values) {
      let completed = false, rejected = false;
      try { await shutdownAfterNativeBroker(async () => { throw value; }, async () => { completed = true; }); }
      catch (error) { rejected = true; assert.equal(error, value); }
      assert.equal(completed, true); assert.equal(rejected, true);
      let both;
      try { await shutdownAfterNativeBroker(async () => { throw value; }, async () => { throw downstream; }); }
      catch (error) { both = error; }
      assert.ok(both instanceof AggregateError); assert.deepEqual(both.errors, [value, downstream]);
    }
    await assert.rejects(shutdownAfterNativeBroker(async () => {}, async () => { throw downstream; }), error => error === downstream);
    console.log("A01 D1-D3 actual evidence: success/absence/single/dual failures, undefined/null preserved");
  });
} else {
  assert.equal(caseName, "daemon-stop");
  test("A01 actual daemon-stop child", { timeout: 35_000 }, async t => {
    console.log("A01 child entered: daemon-stop");
    const path = descriptorPathForA01(), observed = observeA01Descriptor(t, path);
    const actual = { rename: fs.rename, rm: fs.rm };
    const { createDaemonServer } = await import("../dist/index.js");
    const { RunStoreRegistry } = await import("../dist/runtime/store-registry.js");
    const { RuntimeSupervisor, isOriginalRuntimeSupervisorOfficeRoot } = await import("../dist/runtime/supervisor.js");
    const { HostCapabilityBridgeController } = await import("../dist/features/runs/host-capability-bridge-controller.js");
    const events = [], stores = [], supervisors = [];
    const getStore = RunStoreRegistry.prototype.getStore, releaseAll = RuntimeSupervisor.prototype.releaseAll,
      bridgeClose = HostCapabilityBridgeController.prototype.close;
    const storePatches = [], patches = [];
    let shutdownPhase = false, actualRemoveError, daemon, rpc, stop;
    patches.push(t.mock.method(RunStoreRegistry.prototype, "getStore", function (cwd) {
      const store = getStore.call(this, cwd);
      if (!stores.includes(store)) {
        stores.push(store);
        const close = store.close.bind(store);
        storePatches.push(t.mock.method(store, "close", () => { close(); if (shutdownPhase) events.push("store-close"); }));
      }
      return store;
    }));
    patches.push(t.mock.method(RuntimeSupervisor.prototype, "releaseAll", function () {
      releaseAll.call(this);
      if (shutdownPhase) { supervisors.push(this); events.push("runtime-release"); }
    }));
    patches.push(t.mock.method(HostCapabilityBridgeController.prototype, "close", function () {
      bridgeClose.call(this); if (shutdownPhase) events.push("bridge-close");
    }));
    patches.push(t.mock.method(fs, "rm", async (target, ...args) => {
      try { return await actual.rm(target, ...args); }
      catch (error) {
        if (target === path) { actualRemoveError = error; events.push("descriptor-remove-error"); }
        throw error;
      }
    }));
    syncBuiltinESMExports();
    const workspace = process.env.LING_STACK_DEFAULT_WORKSPACE_CWD;
    const secretResolver = {
      status: ref => ({ ref, kind: ref.startsWith("keychain:") ? "keychain" : "env", configured: false, errorCode: "secret_missing" }),
      resolve: ref => ({ ref, configured: false }),
    };
    try {
      daemon = createDaemonServer({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: workspace,
        channels: { intentSelector: false, terminalReports: false },
        cuaDriver: { bundledEmbedded: { darwin: false, win32: false } }, harness: { evaluations: { mode: "off" } } }, {
        runner: { async runTask() { throw new Error("A01 D4 must not call a model"); } }, secretResolver,
        chromeBrowserNativeMessagingEnabled: true,
        chromeBrowserRuntimeDescriptorPath: path,
        chromeBrowserHostPath: join(workspace, "missing-owned-native-host"),
      });
      await daemon.start();
      assert.equal(daemon.server.listening, true);
      const descriptor = await observed.actualRead();
      assert.ok(descriptor?.generation, "real broker actually published before fault");
      const port = daemon.server.address().port;
      rpc = new WebSocket(`ws://127.0.0.1:${port}/rpc/stream?cwd=${encodeURIComponent(workspace)}`);
      await bounded(new Promise((done, reject) => { rpc.once("open", done); rpc.once("error", reject); }), "real RPC connection open");
      const rpcClosed = new Promise(done => rpc.once("close", () => { events.push("rpc-close"); done(); }));
      daemon.server.once("close", () => events.push("http-close"));
      const gate = observed.readGate(descriptor.generation);
      shutdownPhase = true;
      stop = daemon.stop().then(() => ({ resolved: true }), error => ({ error }));
      await bounded(gate.entered.promise, "actual daemon broker removal read matched generation");
      await actual.rename(path, `${path}.fault-backup`); await fs.mkdir(path);
      gate.release.complete();
      const result = await bounded(stop, "actual daemon stop completes remaining drain");
      assert.ok(actualRemoveError, "real fs.rm must reject the owned directory pathname");
      assert.equal(result.error, actualRemoveError, "actual index stop returns the original broker error after drain");
      await bounded(rpcClosed, "daemon closes RPC client itself");
      assert.equal(daemon.server.listening, false);
      assert.equal(rpc.readyState, WebSocket.CLOSED);
      assert.equal(supervisors.length, 1);
      assert.equal(isOriginalRuntimeSupervisorOfficeRoot(supervisors[0]), false, "original root really retired");
      assert.ok(stores.length >= 1);
      assert.equal(events.filter(event => event === "store-close").length, stores.length);
      assert.equal(events.filter(event => event === "bridge-close").length, 1);
      assert.ok(events.indexOf("descriptor-remove-error") < events.indexOf("bridge-close"));
      assert.ok(events.indexOf("runtime-release") < events.indexOf("store-close"));
      const refused = await bounded(new Promise(done => {
        const probe = connect({ host: "127.0.0.1", port });
        probe.once("connect", () => { probe.destroy(); done(false); });
        probe.once("error", () => { probe.destroy(); done(true); });
      }), "closed HTTP port");
      assert.equal(refused, true);
      console.log(`A01 D4 actual evidence: ${JSON.stringify({ port, descriptorPath: path, workspace,
        originalErrorCode: actualRemoveError.code, returnedSameError: true, httpClosed: !daemon.server.listening,
        rpcClosed: rpc.readyState === WebSocket.CLOSED, originalRootRetired: true, events })}`);
    } finally {
      observed.releaseAll();
      if (stop) await stop;
      else if (daemon) await daemon.stop();
      rpc?.terminate();
      for (const patch of [...patches, ...storePatches].reverse()) patch.mock.restore(); syncBuiltinESMExports();
      observed.restore();
    }
  });
}
