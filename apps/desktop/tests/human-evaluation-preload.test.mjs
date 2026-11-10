import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { DESKTOP_HUMAN_EVALUATION_IPC_CHANNELS as channels } from "../dist/shared/ipc-channels.js";

async function fixture(platform) {
  const url = new URL("../dist/preload/main-window.cjs", import.meta.url);
  const filename = fileURLToPath(url), calls = [];
  const require = createRequire(import.meta.url);
  let capabilities, rejection;
  const electron = {
    contextBridge: { exposeInMainWorld(name, value) { assert.equal(name, "lingDesktop"); capabilities = value; } },
    ipcRenderer: {
      invoke(channel, ...args) {
        calls.push({ channel, args });
        return rejection ? Promise.reject(rejection) : Promise.resolve({ accepted: false, reason: "native_unavailable" });
      },
      send() {}, on() {}, off() {},
    },
  };
  const module = { exports: {} };
  vm.runInNewContext(await readFile(url, "utf8"), {
    Buffer, URL, console, clearTimeout, setTimeout, module, exports: module.exports,
    __filename: filename, __dirname: dirname(filename),
    process: new Proxy(process, { get(target, key, receiver) {
      return key === "platform" ? platform : key === "argv" ? ["electron", "app"] : Reflect.get(target, key, receiver);
    } }),
    require: specifier => specifier === "electron" ? electron : require(specifier),
  }, { filename });
  return { capabilities, calls, reject(error) { rejection = error; } };
}

test("actual bundled preload exposes only scoped macOS human capabilities with no identity or credentials", async () => {
  const f = await fixture("darwin");
  const capability = f.capabilities.humanEvaluation;
  assert.deepEqual(Object.keys(capability).sort(), ["cancel", "generateReport", "inspect", "list", "submit"]);
  const request = { taskId: "qa", requestId: "once", submission: { kind: "revoke", revokesEventId: "old", rationale: "withdraw" } };
  const inspect = { taskId: "qa", afterRevision: 100, reportRef: { taskId: "qa", eventId: "old", revision: 1 } };
  assert.equal((await capability.submit(request)).reason, "native_unavailable");
  await capability.cancel("once");
  await capability.inspect(inspect);
  const list = { limit: 25 }, report = { taskId: "qa", eventId: "old", revision: 1 };
  await capability.list(list); await capability.generateReport(report);
  assert.deepEqual(f.calls, [
    { channel: channels.submit, args: [request] },
    { channel: channels.cancel, args: ["once"] },
    { channel: channels.inspect, args: [inspect] },
    { channel: channels.list, args: [list] },
    { channel: channels.generateReport, args: [report] },
  ]);
  const error = new Error("response lost");
  f.reject(error);
  await assert.rejects(capability.submit(request), value => value === error);
  assert.equal(f.calls.length, 6, "a lost IPC result never retries the human submission");
});

test("actual bundled preload does not expose macOS human authority on other platforms", async () => {
  for (const platform of ["win32", "linux"]) {
    assert.equal((await fixture(platform)).capabilities.humanEvaluation, undefined);
  }
});
