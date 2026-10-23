import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initResourceWorkspace } from "./resource-workspace.mjs";
import { managedNodeArguments, runManagedNode } from "./run-managed.mjs";

async function fixture(t) {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "gstack-supervisor-test-")));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, "managed");
  await initResourceWorkspace(process.env.LING_GSTACK_TEST_MOUNT
    ? { root, mountPath: process.env.LING_GSTACK_TEST_MOUNT } : { root, storageMode: "local-bounded" });
  return { root, additionalBytes: 1024 * 1024, onOutput: () => {} };
}

test("the managed test CLI enforces serial files and rejects injected node flags", () => {
  const args = managedNodeArguments("test", ["scripts/gstack/resource-workspace.test.mjs"]);
  assert.ok(args.includes("--test-concurrency=1"));
  assert.throws(() => managedNodeArguments("test", ["--test-concurrency=16"]), /test_path/);
  assert.throws(() => managedNodeArguments("unknown", []), /operation/);
  assert.throws(() => managedNodeArguments("resource", ["a", "b"]), /arguments/);
  assert.throws(() => managedNodeArguments("browser-archives", ["a", "b", "c", "ignored"]), /arguments/);
  assert.ok(managedNodeArguments("testsavant-model", [])[0].endsWith("collect-testsavant-model.mjs"));
  assert.throws(() => managedNodeArguments("testsavant-model", ["override"]), /arguments/);
  assert.throws(() => managedNodeArguments("executable", ["stage", "inspection", "output"]), /arguments/);
  assert.ok(managedNodeArguments("executable", ["stage", "inspection", "archives", "output", "sha256:fixture"])[0].endsWith("assemble-executable-bundle.mjs"));
  assert.ok(managedNodeArguments("browser-inputs", ["stage", "output", "hash"])[0].endsWith("collect-executable-browser-inputs.mjs"));
  assert.ok(managedNodeArguments("select-executable", ["root", "hash"])[0].endsWith("select-executable-bundle.mjs"));
  assert.ok(managedNodeArguments("reviewed-resource", ["source", "output", "parser", "hash"])[0].endsWith("rebuild-reviewed-resource-stage.mjs"));
  assert.throws(() => managedNodeArguments("reviewed-resource", ["source", "output"]), /arguments/);
});

test("real-resource test entrypoints refuse ungoverned invocation before reading inputs", () => {
  const env = { ...process.env, LING_GSTACK_PLATFORM_RESOURCE_STAGE: "/must-not-read-this-input" };
  delete env.LING_GSTACK_RESOURCE_ROOT;
  delete env.LING_GSTACK_RESOURCE_TOKEN;
  delete env.NODE_TEST_CONTEXT;
  const run = spawnSync(process.execPath, ["--test", "scripts/gstack/bundle-inventory-integration.test.mjs"], { env, encoding: "utf8" });
  assert.notEqual(run.status, 0);
  assert.match(run.stdout + run.stderr, /gstack_resource_lease_required/);
  assert.doesNotMatch(run.stdout + run.stderr, /ENOENT/);
});

test("supervision preserves real exit status, external tmp/cache, and removes only owned scratch", async t => {
  const options = await fixture(t);
  const leaseModule = new URL("./resource-workspace.mjs", import.meta.url).href;
  const script = `(async () => { const fs = require('fs'); const path = require('path');
    await (await import(${JSON.stringify(leaseModule)})).requireResourceLease();
    for (const name of ['TMPDIR', 'TEMP', 'TMP', 'BUN_INSTALL_CACHE_DIR']) {
      if (!process.env[name].startsWith(process.env.LING_GSTACK_RESOURCE_ROOT + path.sep)) process.exit(9);
    }
    fs.writeFileSync(path.join(process.env.TMPDIR, 'owned'), 'tiny fixture'); process.exit(3);
    })().catch(() => process.exit(8));`;
  const result = await runManagedNode({ ...options, args: ["-e", script] });
  assert.equal(result.exitCode, 3);
  assert.equal(result.reason, null);
  assert.deepEqual(await readdir(join(options.root, "runs")), []);
  assert.ok(!(await readdir(options.root)).includes(".heavy-operation.json"));
});

test("a timed-out child and oversized output are terminal failures, not successful retries", async t => {
  const options = await fixture(t);
  const timedOut = await runManagedNode({ ...options, args: ["-e", "setInterval(() => {}, 1000)"], timeoutMs: 150 });
  assert.equal(timedOut.reason, "deadline_exceeded");
  assert.notEqual(timedOut.exitCode, 0);
  const output = await runManagedNode({ ...options, args: ["-e", "process.stdout.write('x'.repeat(2048))"], maxOutputBytes: 100 });
  assert.equal(output.reason, "output_budget_exceeded");
  assert.notEqual(output.exitCode, 0);
  assert.deepEqual(await readdir(join(options.root, "runs")), []);
});
