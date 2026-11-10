import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunnerAcceptanceStore, runnerAcceptanceFingerprint } from "../dist/runtime/runner-acceptance-store.js";
import { assessRunnerAcceptance } from "../dist/runtime/runner-acceptance.js";
import { fixtureNativeAcceptance } from "./support/fixture-native-acceptance.mjs";

const identity = { runnerId: "codex-app-server", runtimeVersion: "fixture", sdkVersion: "fixture", adapterVersion: "fixture",
  executableDigest: "fixture", platform: process.platform, architecture: process.arch, profileId: "fixture", profileRevision: 1,
  configurationFingerprint: "fixture", workspaceId: "fixture", policyFingerprint: "fixture", workflowSurface: "task" };
function fixture(t) {
  const rootDir = fs.mkdtempSync(join(tmpdir(), "ling-acceptance-store-"));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const store = new RunnerAcceptanceStore({ rootDir });
  const directory = join(rootDir, "state", "execution-engine-acceptance-v1");
  const path = join(directory, `${runnerAcceptanceFingerprint(identity)}.json`);
  return { rootDir, directory, path, store };
}

test("trusted candidate publication requires every check and a stable identity", async t => {
  const f = fixture(t);
  const input = { readCurrentIdentity: async () => identity, verifyRelease: async () => "passed", verifyHost: async () => "passed", validityMs: 10000 };
  await assert.rejects(f.store.verifyAndPublish({ ...input, verifyRelease: async check => check === "cancellation" ? "not_run" : "passed" }), /verification_incomplete/);
  assert.equal(f.store.read(identity), undefined);
  let revision = 1;
  await assert.rejects(f.store.verifyAndPublish({ ...input, readCurrentIdentity: async () => ({ ...identity, profileRevision: revision++ }) }), /verification_mismatch/);
  assert.equal(f.store.read(identity), undefined);
  const evidence = await f.store.verifyAndPublish(input);
  assert.deepEqual(f.store.read(identity), evidence);
  assert.equal(assessRunnerAcceptance(identity, evidence).status, "accepted");
  fs.chmodSync(f.path, 0o644);
  if (process.platform !== "win32") assert.equal(f.store.read(identity), undefined);
});

test("workspace-linked acceptance directories cannot supply trusted evidence", t => {
  const f = fixture(t);
  const workspace = join(f.rootDir, "workspace");
  fs.mkdirSync(workspace, { mode: 0o700 }); fs.mkdirSync(join(f.rootDir, "state"), { mode: 0o700 });
  fs.symlinkSync(workspace, f.directory, "dir");
  const untrusted = join(workspace, `${runnerAcceptanceFingerprint(identity)}.json`);
  fs.writeFileSync(untrusted, JSON.stringify(fixtureNativeAcceptance(identity)), { mode: 0o600 });
  assert.equal(f.store.read(identity), undefined);
});

test("replacement after metadata inspection cannot redirect acceptance reads", t => {
  const f = fixture(t);
  fs.mkdirSync(f.directory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(f.path, JSON.stringify(fixtureNativeAcceptance(identity)), { mode: 0o600 });
  const other = join(f.rootDir, "untrusted.json");
  fs.writeFileSync(other, JSON.stringify(fixtureNativeAcceptance(identity)), { mode: 0o600 });
  const original = fs.lstatSync;
  let swapped = false;
  t.mock.method(fs, "lstatSync", (...args) => {
    const info = original(...args);
    if (args[0] === f.path && !swapped) { swapped = true; fs.unlinkSync(f.path); fs.symlinkSync(other, f.path); }
    return info;
  });
  syncBuiltinESMExports();
  try { assert.equal(f.store.read(identity), undefined); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});
