import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initResourceWorkspace, openResourceWorkspace } from "./resource-workspace.mjs";

// Regression: MAIN-INTEGRATION storage modes must not inherit each other's authority.
// Found by /qa on 2026-10-26.
// Report: output/e6-20260928/p5-main-integration-20261026/qa-report-main-integration-2026-10-26.md
async function fixture(t) {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "gstack-storage-modes-")));
  t.after(() => rm(parent, { recursive: true, force: true }));
  return { parent, root: join(parent, "managed") };
}

function hostedEnvironment(t, parent) {
  const values = { GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted", GITHUB_RUN_ID: "123",
    GITHUB_RUN_ATTEMPT: "2", GITHUB_JOB: "macos-fixture", RUNNER_TEMP: parent };
  const before = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
}

test("invalid storage-policy combinations reject before creating a workspace", async t => {
  const { parent, root } = await fixture(t);
  for (const options of [{ ciEphemeral: "true" }, { ciEphemeral: null },
    { storageMode: "local-bounded", ciEphemeral: true },
    { storageMode: "local-bounded", mountPath: parent }, { ciEphemeral: true, mountPath: parent }]) {
    await assert.rejects(initResourceWorkspace({ root, ...options }), /storage_mode_invalid/);
    assert.deepEqual(await readdir(parent), []);
  }
});

test("local receipts cannot be promoted to hosted authority or an unknown storage policy", async t => {
  const { parent, root } = await fixture(t);
  hostedEnvironment(t, parent);
  await initResourceWorkspace({ root, storageMode: "local-bounded" });
  const path = join(root, ".gstack-resource-workspace.json"), original = await readFile(path, "utf8");
  for (const storagePolicy of ["github-hosted-ephemeral", "unrecognized"]) {
    await writeFile(path, JSON.stringify({ ...JSON.parse(original), storagePolicy }));
    await assert.rejects(openResourceWorkspace(root), /storage_mode_invalid|runner_identity_mismatch/);
  }
  await writeFile(path, original);
  assert.equal((await openResourceWorkspace(root)).storageMode, "local-bounded");
});

test("hosted receipt reopens only in its original job and never falls back to local storage", async t => {
  const { parent, root } = await fixture(t);
  hostedEnvironment(t, parent);
  const record = await initResourceWorkspace({ root, ciEphemeral: true });
  assert.equal(record.schemaVersion, 1);
  assert.equal(record.storageMode, undefined);
  assert.deepEqual(await openResourceWorkspace(root), record);
  for (const [key, value] of [["GITHUB_RUN_ID", "456"], ["GITHUB_RUN_ATTEMPT", "3"],
    ["GITHUB_JOB", "different-job"], ["RUNNER_ENVIRONMENT", "self-hosted"], ["GITHUB_ACTIONS", "false"]]) {
    const previous = process.env[key];
    process.env[key] = value;
    try { await assert.rejects(openResourceWorkspace(root), /runner_identity_mismatch|hosted_identity_required/); }
    finally { process.env[key] = previous; }
  }
  const path = join(root, ".gstack-resource-workspace.json");
  await writeFile(path, JSON.stringify({ ...record, mountPath: join(parent, "foreign-lock-root") }));
  await assert.rejects(openResourceWorkspace(root), /mount_identity_mismatch/);
  await writeFile(path, JSON.stringify({ ...record, storageMode: "local-bounded" }));
  await assert.rejects(openResourceWorkspace(root), /storage_mode_invalid/);
});
