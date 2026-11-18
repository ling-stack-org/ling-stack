import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import test, { type TestContext } from "node:test";
import { CuaDriverProviderHost } from "../dist/main/cua-driver/provider-host.js";
import { deferred } from "./locked-use-fixtures.ts";

function fixture(t: TestContext, register: (pid: number, signal: AbortSignal) => Promise<void>) {
  const children: ChildProcess[] = [];
  let initialized = false;
  const host = new CuaDriverProviderHost({
    executablePath: "/fixture/provider", platform: "darwin", generation: 4, hostProcessId: 123,
    registerProcess: register,
    stateRoot: {
      userDataPath: "/tmp/ling-registration", rootPath: "/tmp/ling-registration/state",
      telemetryPath: "/tmp/ling-registration/telemetry", versionCheckPath: "/tmp/ling-registration/version",
      environment: { CUA_DRIVER_STATE_HOME: "/tmp/ling-registration/state", CUA_DRIVER_TELEMETRY_HOME: "/tmp/ling-registration/telemetry" },
    },
    lifecycle: {
      lifetimeBoundary: "test-fixture",
      spawn(input) {
        assert.equal(input.environment.CUA_DRIVER_HOST_PID, "123");
        const child = spawn(process.execPath, ["-e", String.raw`
          require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
            const message=JSON.parse(line);
            process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result:{
              protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'cua-driver',version:'0.8.3'}
            }})+'\n');
          });
        `], { stdio: ["pipe", "pipe", "pipe"] });
        child.stdout.on("data", () => { initialized = true; });
        children.push(child);
        return child;
      },
      async terminate(child) { child.kill("SIGKILL"); },
      async terminateImmediately(child) { child.kill("SIGKILL"); },
    },
  });
  t.after(async () => { await host.stop("test_complete"); });
  return { host, children, initialized: () => initialized };
}

const initialize = { jsonrpc: "2.0" as const, id: 1, method: "initialize",
  params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "fixture", version: "1" } } };

test("exact child registration completes before the first MCP write", async (t) => {
  const entered = deferred<number>(); const release = deferred();
  const fx = fixture(t, async (pid, signal) => { signal.throwIfAborted(); entered.resolve(pid); await release.promise; });
  const pending = fx.host.exchange(initialize);
  assert.equal(await entered.promise, fx.children[0]?.pid);
  assert.equal(fx.initialized(), false);
  release.resolve();
  const reply = await pending;
  assert.ok(reply && "result" in reply);
  assert.equal(fx.initialized(), true);
});

test("failed native registration terminates the retained child without MCP initialization", async (t) => {
  const fx = fixture(t, async () => { throw new Error("native_registration_denied"); });
  await assert.rejects(fx.host.exchange(initialize), /native_registration_denied/u);
  assert.equal(fx.initialized(), false);
  assert.equal(fx.children.length, 1);
  assert.ok(fx.children[0]!.exitCode !== null || fx.children[0]!.signalCode !== null);
  await assert.rejects(fx.host.exchange(initialize));
  assert.equal(fx.children.length, 1);
});

test("stop during registration cannot initialize or restart a late child", async (t) => {
  const entered = deferred(); const release = deferred();
  const fx = fixture(t, async () => { entered.resolve(); await release.promise; });
  const pending = fx.host.exchange(initialize);
  const rejected = assert.rejects(pending);
  await entered.promise;
  const stopping = fx.host.stop("native_helper_exited");
  release.resolve();
  await rejected; await stopping;
  assert.equal(fx.initialized(), false);
  assert.equal(fx.children.length, 1);
});
