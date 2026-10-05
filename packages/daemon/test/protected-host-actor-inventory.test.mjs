import assert from "node:assert/strict";
import test from "node:test";
import { defineProtectedHostActorEntry, PROTECTED_HOST_ACTOR_ENTRIES,
  readProtectedHostActorEntry } from "../dist/runtime/sandbox/protected-host-actor-inventory.js";
import { ProtectedHostStageRegistry } from "../dist/runtime/sandbox/protected-host-staging.js";
import { createProtectedHostStageFixture } from "./support/protected-host-stage-fixture.mjs";

// These are wrapper/composition contract tests. Synthetic producers are not
// installed product entries and never count as kernel actor-coverage evidence.
test("incomplete original entry inventory closes Office admission", () => {
  const registry = new ProtectedHostStageRegistry();
  assert.throws(() => registry.assertActorInventoryCurrent(), /inventory_incomplete/u);
  assert.equal(PROTECTED_HOST_ACTOR_ENTRIES.workspace_icon_probe, "controlled");
  assert.equal(PROTECTED_HOST_ACTOR_ENTRIES.docker_probe, "controlled");
});
test("a fixture list with all named slots is still not the fixed original producer-source manifest", () => {
  const entries = Object.keys(PROTECTED_HOST_ACTOR_ENTRIES).map(id => defineProtectedHostActorEntry(id, () => undefined));
  const registry = new ProtectedHostStageRegistry(); registry.bindOriginalActorEntries(entries);
  assert.throws(() => registry.assertActorInventoryCurrent(), /source_manifest_incomplete|entry_unbound/u);
});
test("an original entry invokes its captured producer and no-stage calls have no lifetime count limit", () => {
  let entered = 0;
  const entry = defineProtectedHostActorEntry("mcp_host_stdio", value => { entered++; return value; });
  const registry = new ProtectedHostStageRegistry(); registry.bindOriginalActorEntries([entry]);
  for (let i = 0; i < 4096; i++) assert.equal(entry.invoke(undefined, i), i);
  assert.equal(entered, 4096); assert.throws(() => registry.assertActorInventoryCurrent(), /inventory_incomplete/u);
});
test("immutable original invoke and private entry ownership reject clones/accessors/unknown names", () => {
  const entry = defineProtectedHostActorEntry("unified_exec_raw", () => 1);
  assert.equal(readProtectedHostActorEntry(entry).kind, "controlled");
  assert.throws(() => readProtectedHostActorEntry({ ...entry }), /entry_invalid/u);
  let accessorReads = 0;
  const fake = { entryId: "unified_exec_raw", get invoke() { accessorReads++; return entry.invoke; } };
  assert.throws(() => readProtectedHostActorEntry(fake), /entry_invalid/u); assert.equal(accessorReads, 0);
  assert.throws(() => { entry.invoke = () => 2; }, TypeError);
  assert.throws(() => defineProtectedHostActorEntry("unknown_controlled", () => 1), /entry_invalid/u);
});
test("duplicate and replacement manifest binding cannot reissue entries", () => {
  const entry = defineProtectedHostActorEntry("unified_exec_raw", () => 1), registry = new ProtectedHostStageRegistry();
  assert.throws(() => registry.bindOriginalActorEntries([entry, entry]), /inventory_duplicate/u);
  registry.bindOriginalActorEntries([entry]);
  assert.throws(() => registry.bindOriginalActorEntries([entry]), /already_bound/u);
});
test("pre-binding unknown controlled entry history is not erased by later enrollment", t => {
  const fixture = createProtectedHostStageFixture(t), entry = defineProtectedHostActorEntry("unified_exec_raw", () => 1);
  assert.equal(entry.invoke(undefined), 1); fixture.registry.bindOriginalActorEntries([entry]);
  assert.throws(() => fixture.register(), /coverage_unknown/u);
});
test("an active original stage rejects the unknown controlled producer before native entry", t => {
  const fixture = createProtectedHostStageFixture(t), stage = fixture.register();
  let entered = 0;
  const entry = defineProtectedHostActorEntry("native_input_capture", () => { entered++; });
  fixture.registry.bindOriginalActorEntries([entry]);
  assert.throws(() => entry.invoke(undefined), /unbound_with_active_stage/u); assert.equal(entered, 0);
  fixture.registry.closeStage(stage); entry.invoke(undefined); assert.equal(entered, 1);
});
test("raw producers cannot borrow a certified actor preparation or choose another registry", () => {
  let entered = 0;
  const raw = defineProtectedHostActorEntry("unified_exec_raw", () => { entered++; });
  const registry = new ProtectedHostStageRegistry(); registry.bindOriginalActorEntries([raw]);
  assert.throws(() => raw.invoke({}), /entry_proof_invalid/u); assert.equal(entered, 0);
  const native = defineProtectedHostActorEntry("macos_native_command", () => { entered++; });
  const other = new ProtectedHostStageRegistry(); other.bindOriginalActorEntries([native]);
  assert.throws(() => native.invoke({ assertActorEntryLaunchCurrent() {} }), /preparation_invalid/u); assert.equal(entered, 0);
});
