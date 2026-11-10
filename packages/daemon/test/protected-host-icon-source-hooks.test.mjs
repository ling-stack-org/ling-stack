import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import test from "node:test";
import { createSourceHookFixture, loadSourceHookModule } from "./support/protected-host-source-hooks-fixture.mjs";
import { observeDefaultIconDependencies } from "./support/protected-host-icon-source-hooks-fixture.mjs";

test("workspace icon original source placement (not kernel or descendant isolation)", { skip: process.platform !== "darwin" }, async t => {
  const observed = observeDefaultIconDependencies(t);
  const icons = await loadSourceHookModule("features/previews/workspace-file-open-icons.js");
  const entry = icons.WORKSPACE_ICON_PROBE_ACTOR_ENTRY;
  assert.ok(entry, "the public default loader must export its original source-owned gate");
  let originalRefusal;

  for (const command of ["mdfind", "plutil"]) {
    await t.test(`public default loader refuses ${command} before its physical producer without fallback`, async t => {
      const f = await createSourceHookFixture(t), stage = f.register();
      f.registry.bindOriginalActorEntries([entry]);
      const state = observed.configure({ discovery: command === "mdfind" }), before = observed.calls.length,
        temporaryBefore = observed.temporaries.length;
      const result = await capture(icons.loadWorkspaceFileOpenIcon("vscode"));
      t.diagnostic(`Original default native placements: ${observed.calls.slice(before).map(call => call.command).join(", ") || "none"}`);
      assert.equal(observed.calls.length, before, "registered Host stage must prevent the original default execFile producer");
      assert.match(result.error?.message ?? "", /protected_host_actor_unbound_with_active_stage/u);
      assert.equal(result.value, undefined);
      assert.equal(state.directoryReads, 0, "a protection refusal is not a readdir fallback");
      assert.equal(state.outputReads, 0);
      assert.equal(observed.temporaries.length, temporaryBefore, "discovery/plist refusal must not reach conversion staging");
      originalRefusal = result.error;
      f.registry.closeStage(stage);
    });
  }

  await t.test("the exact shared entry rejects all three native tools before physical entry", async t => {
    const f = await createSourceHookFixture(t), stage = f.register();
    f.registry.bindOriginalActorEntries([entry]);
    const before = observed.calls.length;
    for (const command of ["/usr/bin/mdfind", "/usr/bin/plutil", "/usr/bin/sips"]) {
      const launch = { command, args: [], producerEntered: false };
      assert.throws(() => entry.invoke(undefined, launch), /protected_host_actor_unbound_with_active_stage/u);
      assert.equal(launch.producerEntered, false);
    }
    assert.equal(observed.calls.length, before);
    f.registry.closeStage(stage);
    const fresh = f.register(); f.registry.closeStage(fresh); // Refusals did not create a controlled descendant.
  });

  await t.test("a custom runtime cannot inherit a default producer's private refusal provenance", async t => {
    assert.ok(originalRefusal, "custom provenance must be tested using an actual default-source refusal");
    const f = await createSourceHookFixture(t), stage = f.register(); f.registry.bindOriginalActorEntries([entry]);
    const calls = [], before = observed.calls.length, runtime = customRuntime(originalRefusal, calls);
    const result = await icons.createWorkspaceFileOpenIconLoader(runtime)("vscode");
    assert.deepEqual(result.bytes, Buffer.from("custom-png"));
    assert.deepEqual(calls, ["/usr/bin/plutil", "/usr/bin/sips"]);
    assert.equal(observed.calls.length, before);
    f.registry.closeStage(stage);
  });

  await t.test("public sips refusal preserves the original temporary-directory finally (late attach placement only)", async t => {
    const f = await createSourceHookFixture(t), stage = f.register();
    const before = observed.calls.length, temporaryBefore = observed.temporaries.length;
    observed.configure({ applicationName: "Cursor", afterProducer(call) {
      if (call.command === "/usr/bin/plutil") f.registry.bindOriginalActorEntries([entry]);
    } });
    const result = await capture(icons.loadWorkspaceFileOpenIcon("cursor"));
    assert.match(result.error?.message ?? "", /protected_host_actor_unbound_with_active_stage/u);
    assert.deepEqual(observed.calls.slice(before).map(call => call.command), ["/usr/bin/plutil"]);
    assert.equal(observed.temporaries.length, temporaryBefore + 1);
    const path = observed.temporaries.at(-1);
    assert.ok(observed.removed.includes(path));
    await assert.rejects(stat(path), error => error.code === "ENOENT");
    f.registry.closeStage(stage);
    assert.throws(() => f.register(), /protected_host_actor_coverage_unknown/u);
    t.diagnostic("Late attach intentionally leaves the earlier original plutil launch unknown; this only proves the public sips gate and finally placement, not Supervisor front-door safety.");
  });

  for (const failure of [undefined, "/usr/bin/plutil", "/usr/bin/sips"]) {
    await t.test(`no-stage default flow retains ordinary ${failure ?? "success"} and cleanup behavior`, async t => {
      const f = await createSourceHookFixture(t);
      f.registry.bindOriginalActorEntries([entry]);
      observed.configure({ applicationName: "Zed", failCommand: failure });
      const before = observed.calls.length, temporaryBefore = observed.temporaries.length;
      const result = await icons.loadWorkspaceFileOpenIcon("zed");
      if (failure === "/usr/bin/sips") assert.equal(result, undefined);
      else assert.deepEqual(result.bytes, Buffer.from("source-placement-only-png"));
      assert.deepEqual(observed.calls.slice(before).map(call => call.command), ["/usr/bin/plutil", "/usr/bin/sips"]);
      assert.equal(observed.temporaries.length, temporaryBefore + 1);
      assert.ok(observed.removed.includes(observed.temporaries.at(-1)));
      await assert.rejects(stat(observed.temporaries.at(-1)), error => error.code === "ENOENT");
      assert.throws(() => f.register(), /protected_host_actor_coverage_unknown/u);
    });
  }

  await t.test("a real public-loader cache hit with an active stage starts no new native process", async t => {
    observed.configure({ applicationName: "TextEdit" });
    const first = await icons.loadWorkspaceFileOpenIcon("textedit");
    const f = await createSourceHookFixture(t), stage = f.register();
    f.registry.bindOriginalActorEntries([entry]);
    const before = observed.calls.length, temporaryBefore = observed.temporaries.length;
    assert.equal(await icons.loadWorkspaceFileOpenIcon("textedit"), first);
    assert.equal(observed.calls.length, before);
    assert.equal(observed.temporaries.length, temporaryBefore);
    f.registry.closeStage(stage);
  });
  t.diagnostic("Native calls are mocked placement observations; png bytes are fixture data, not app icon generation, a sandbox profile, process drain or descendant-closure evidence.");
});

test("workspace icon export has portable original immutable identity, never a clone", async () => {
  const icons = await loadSourceHookModule("features/previews/workspace-file-open-icons.js");
  const { readProtectedHostActorEntry } = await loadSourceHookModule("runtime/sandbox/protected-host-actor-inventory.js");
  const entry = icons.WORKSPACE_ICON_PROBE_ACTOR_ENTRY;
  assert.ok(entry, "source export must never disappear behind a skipped test");
  assert.deepEqual(readProtectedHostActorEntry(entry), { entryId: "workspace_icon_probe", kind: "controlled" });
  assert.equal(Object.isFrozen(entry), true);
  assert.throws(() => readProtectedHostActorEntry({ ...entry }), /protected_host_actor_entry_invalid/u);
});

async function capture(promise) {
  try { return { value: await promise }; } catch (error) { return { error }; }
}

function customRuntime(originalRefusal, calls) {
  const applicationPath = "/Applications/Visual Studio Code.app", iconPath = `${applicationPath}/Contents/Resources/fixture.icns`;
  return { platform: "darwin", homeDirectory: () => "/fixture/home", temporaryDirectory: () => "/fixture/tmp",
    async stat(path) {
      if (path === applicationPath) return { isDirectory: () => true, isFile: () => false, mtimeMs: 1 };
      if (path === iconPath) return { isDirectory: () => false, isFile: () => true, mtimeMs: 1 };
      throw new Error("missing");
    }, async readdir() { return ["fixture.icns"]; }, async readFile() { return Buffer.from("custom-png"); },
    async mkdtemp() { return "/fixture/tmp/icon"; }, async rm() {},
    async execFile(command) { calls.push(command); if (command === "/usr/bin/plutil") throw originalRefusal; return { stdout: "converted", stderr: "" }; },
  };
}
