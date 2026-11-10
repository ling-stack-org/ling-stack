import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { createSourceHookFixture, loadSourceHookModule, observeSourceSpawns } from "./support/protected-host-source-hooks-fixture.mjs";

const local = await loadSourceHookModule("shared/local-path-open.js");
const files = await loadSourceHookModule("features/previews/workspace-file-actions.js");
const { readProtectedHostActorEntry } = await loadSourceHookModule("runtime/sandbox/protected-host-actor-inventory.js");
const entries = [local.LOCAL_PATH_OPEN_ACTOR_ENTRY, files.WORKSPACE_FILE_LAUNCH_ACTOR_ENTRY, files.WORKSPACE_FILE_PROBE_ACTOR_ENTRY];

test("file UI launch and separate probe exports preserve original immutable identities", () => {
  assert.deepEqual(entries.map(readProtectedHostActorEntry), [
    { entryId: "local_path_open", kind: "user_external" },
    { entryId: "workspace_file_launch", kind: "user_external" },
    { entryId: "workspace_file_probe", kind: "controlled" },
  ]);
  for (const entry of entries) {
    assert.equal(Object.isFrozen(entry), true);
    assert.throws(() => readProtectedHostActorEntry({ ...entry }), /protected_host_actor_entry_invalid/u);
  }
});

test("actual file-open public callers gate probes while preserving raw UI launches", { skip: process.platform !== "darwin" }, async t => {
  const fixture = await createSourceHookFixture(t), stage = fixture.register(), spawned = observeSourceSpawns(t), probes = [];
  const patch = t.mock.method(childProcess, "spawnSync", (...args) => {
    probes.push(args); return { status: 0, stdout: "/fixture/editor\n", stderr: "", pid: 55000, signal: null };
  });
  syncBuiltinESMExports();
  t.after(() => { patch.mock.restore(); syncBuiltinESMExports(); });
  fixture.registry.bindOriginalActorEntries(entries);
  const path = join(fixture.cwd, "fixture.txt"); writeFileSync(path, "source hook fixture");
  const options = () => {
    const reply = { setHeader() {}, writeHead(status) { this.status = status; }, end(body) { this.body = JSON.parse(body); } };
    const url = new URL("http://localhost/workspace-file-open-options");
    url.searchParams.set("cwd", fixture.cwd); url.searchParams.set("path", path);
    files.handleGetWorkspaceFileOpenOptions(reply, url);
    return reply;
  };

  await local.openLocalDirectory(fixture.cwd);
  await files.launchWorkspaceFile("finder", fixture.cwd, undefined);
  assert.equal(spawned.calls.length, 2); assert.equal(probes.length, 0);
  assert.deepEqual(spawned.calls[0].slice(0, 2), ["/usr/bin/open", [fixture.cwd]]);
  assert.deepEqual(spawned.calls[1].slice(0, 2), ["/usr/bin/open", ["-R", fixture.cwd]]);
  // Caller flags cannot turn an availability query into a certified actor.
  const denied = options();
  assert.equal(denied.status, 400);
  assert.equal(denied.body.error, "workspace_file_open_options_failed");
  assert.equal(denied.body.message, "protected_host_actor_unbound_with_active_stage");
  await assert.rejects(files.launchWorkspaceFile("vscode", fixture.cwd, 3), /protected_host_actor_unbound_with_active_stage/u);
  assert.equal(probes.length, 0); assert.equal(spawned.calls.length, 2);
  fixture.registry.closeStage(stage);
  const second = fixture.register(); // A refused probe and external UI launch did not create controlled unknown history.
  fixture.registry.closeStage(second);
  const ordinary = options();
  assert.equal(ordinary.status, 200); assert.ok(ordinary.body.options.length > 0); assert.ok(probes.length > 0);
  await files.launchWorkspaceFile("vscode", fixture.cwd, 3);
  assert.equal(spawned.calls.at(-1)[0], "/fixture/editor");
  assert.deepEqual(spawned.calls.at(-1)[1], ["-g", `${fixture.cwd}:3`]);
  assert.throws(() => fixture.register(), /protected_host_actor_coverage_unknown/u);
  t.diagnostic("Mock native producers verify source placement, not OS app launching, human gesture, a probe profile or descendants closure.");
});
