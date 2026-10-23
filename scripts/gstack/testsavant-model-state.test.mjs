import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { closeTestsavantSidecar, configureTestsavantSidecar, isSidecarAvailable, scanWithSidecar } from "./testsavant-gs-client.mjs";

test("a first scan starts one acquisition and reports downloading immediately without attempting inference", async t => {
  t.after(closeTestsavantSidecar);
  let downloads = 0, finish;
  configureTestsavantSidecar({ modelMode: "download-required", stateRoot: "/owned-state",
    prepareModel: () => { downloads++; return new Promise(resolve => { finish = resolve; }); } });
  assert.equal(isSidecarAvailable().modelStatus, "not-downloaded");
  const started = Date.now();
  await assert.rejects(scanWithSidecar("content"), /testsavant_model_downloading/);
  await assert.rejects(scanWithSidecar("content"), /testsavant_model_downloading/);
  assert.ok(Date.now() - started < 1000); assert.equal(downloads, 1);
  assert.equal(isSidecarAvailable().modelStatus, "downloading");
  finish("/owned-model"); await delay(0);
  assert.equal(isSidecarAvailable().modelStatus, "ready");
});

test("download failure remains an explicit failed state and never returns a safe verdict", async t => {
  t.after(closeTestsavantSidecar);
  configureTestsavantSidecar({ modelMode: "download-required", stateRoot: "/owned-state",
    prepareModel: async () => { throw new Error("testsavant_model_download_content_mismatch"); } });
  await assert.rejects(scanWithSidecar("content"), /testsavant_model_downloading/);
  await delay(0);
  assert.equal(isSidecarAvailable().modelStatus, "failed");
  await assert.rejects(scanWithSidecar("content"), /testsavant_model_failed: testsavant_model_download_content_mismatch/);
  await assert.rejects(scanWithSidecar("content"), /testsavant_model_downloading/);
});

test("completion from a closed generation cannot activate or overwrite a new model configuration", async t => {
  t.after(closeTestsavantSidecar);
  let finish;
  configureTestsavantSidecar({ modelMode: "download-required", stateRoot: "/first",
    prepareModel: () => new Promise(resolve => { finish = resolve; }) });
  await assert.rejects(scanWithSidecar("content"), /testsavant_model_downloading/);
  await closeTestsavantSidecar();
  configureTestsavantSidecar({ modelMode: "download-required", stateRoot: "/second" });
  finish("/first/model"); await delay(0);
  assert.equal(isSidecarAvailable().modelStatus, "not-downloaded");
});
