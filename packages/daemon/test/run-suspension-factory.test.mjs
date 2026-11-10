import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveConfig } from "../dist/config.js";
import { RuntimeSupervisor } from "../dist/runtime/supervisor.js";
import { createRunnerRegistry } from "../dist/runtime/runners.js";
import { createOriginalOfficeDirectoryStoreFactory } from "../dist/features/office-documents/office-local-directory-core-authority.js";
import { readOriginalRunSuspensionLifecycle } from "../dist/features/harness/delegations/store-composition.js";

test("production Store factory retains private ordinary suspension custody with dynamic delegation disabled", async t => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-suspension-original-factory-"));
  const supervisor = new RuntimeSupervisor(resolveConfig({ defaultWorkspaceCwd: cwd,
    harness: { continuations: { mode: "enforce" }, delegations: { mode: "off" } } }));
  let store, enrolled;
  t.after(async () => { supervisor.releaseAll(); store?.close(); await rm(cwd, { recursive: true, force: true }); });
  const runnerRegistry = createRunnerRegistry([{ id: "pi", displayName: "Factory only", status: "enabled", adapter: {
    async runTask() { assert.fail("factory construction must never execute a task"); },
  } }]);
  store = createOriginalOfficeDirectoryStoreFactory(supervisor, { runnerRegistry,
    secretResolver: { resolve: () => ({ configured: false }) }, onDelegationStore: value => { enrolled = value; } })(cwd);
  const lifecycle = readOriginalRunSuspensionLifecycle(store, supervisor);
  assert.equal(lifecycle.getRunSuspensionForAttempt("missing"), undefined);
  assert.equal(enrolled, store, "the original runtime registry sees the same owning Store, even with its producer disabled");
  assert.equal(supervisor.getHarnessFeatures().delegations.mode, "off");
  assert.equal("requestRunSuspension" in store, false, "no public or model-facing writer");
  assert.equal("spawn" in lifecycle, false, "ordinary suspension lookup cannot enable dynamic creation");
});
