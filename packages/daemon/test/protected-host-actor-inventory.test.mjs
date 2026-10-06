import assert from "node:assert/strict";
import test from "node:test";
import * as actorInventoryContract from "../dist/runtime/sandbox/protected-host-actor-inventory.js";
import { defineProtectedHostActorEntry, PROTECTED_HOST_ACTOR_ENTRIES,
  readProtectedHostActorEntry } from "../dist/runtime/sandbox/protected-host-actor-inventory.js";
import { ProtectedHostStageRegistry } from "../dist/runtime/sandbox/protected-host-staging.js";
import { createProtectedHostStageFixture as createSharedProtectedHostStageFixture } from "./support/protected-host-stage-fixture.mjs";
import { observeSourceHookBootstrap } from "./support/protected-host-source-bootstrap-observer.mjs";

// These are wrapper/composition contract tests. Synthetic producers are not
// installed product entries and never count as kernel actor-coverage evidence.
// Keep counterfeit bootstrap input local: the shared fixture also serves real
// native/Seatbelt cases. This file starts no native actors and proves no OS trust.
function createProtectedHostStageFixture(t) {
  observeSourceHookBootstrap(t);
  return createSharedProtectedHostStageFixture(t, { registry: new ProtectedHostStageRegistry() });
}

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

test("generic source consumers and exact readonly refusal provenance", async t => {
  // Namespace access keeps the original eight tests collectible on old dist.
  // This single prerequisite failure is missing contract wiring, not evidence
  // that a public default producer was blocked (the source suite proves that).
  const isRefusal = actorInventoryContract.isProtectedHostActorEntryLaunchRefusal;
  assert.equal(typeof isRefusal, "function", "new generic refusal contract is not connected in this dist");

  await t.test("AsyncFunction consumer is rejected by the factory before producer or consumer execution", () => {
    let producerCalls = 0, consumerCalls = 0;
    assert.throws(() => defineProtectedHostActorEntry("keychain_security", () => { producerCalls++; },
      async () => { consumerCalls++; }), { message: "protected_host_actor_entry_invalid" });
    assert.deepEqual([producerCalls, consumerCalls], [0, 0]);
  });

  for (const rejected of [false, true]) {
    await t.test((rejected ? "rejected" : "resolved") + " native Promise consumer result is synchronously invalid and never unhandled", async t => {
      const f = createProtectedHostStageFixture(t), unhandled = [], nativeFailure = new Error("consumer-native-promise");
      const listener = error => unhandled.push(error); process.on("unhandledRejection", listener);
      t.after(() => process.removeListener("unhandledRejection", listener));
      let producerCalls = 0, consumerCalls = 0, thenReads = 0, caught;
      const entry = defineProtectedHostActorEntry("keychain_security", () => { producerCalls++; }, () => {
        consumerCalls++;
        const promise = rejected ? Promise.reject(nativeFailure) : Promise.resolve();
        Object.defineProperty(promise, "then", { get() { thenReads++; throw new Error("must-not-read-own-then"); } });
        return promise;
      });
      f.registry.bindOriginalActorEntries([entry]);
      try { entry.invoke(undefined, {}); } catch (error) { caught = error; }
      assert.equal(caught?.message, "protected_host_actor_entry_invalid");
      assert.equal(isRefusal(entry, caught), false); assert.equal(isRefusal(entry, nativeFailure), false);
      assert.deepEqual([producerCalls, consumerCalls, thenReads], [0, 1, 0]);
      const stage = f.register(); f.registry.closeStage(stage);
      await new Promise(resolve => setImmediate(resolve));
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(unhandled, []);
    });
  }

  await t.test("every non-undefined synchronous consumer result fails before readonly gate and native history", t => {
    for (const value of [null, false, 0, "", true, {}]) {
      const f = createProtectedHostStageFixture(t); let producerCalls = 0, gateCalls = 0;
      const entry = defineProtectedHostActorEntry("keychain_security", () => { producerCalls++; }, () => value);
      f.registry.bindOriginalActorEntries([entry]);
      const originalGate = f.registry.assertActorEntryLaunchCurrent;
      t.mock.method(f.registry, "assertActorEntryLaunchCurrent", function (...args) {
        gateCalls++; return Reflect.apply(originalGate, this, args);
      });
      let failure;
      try { entry.invoke(undefined, {}); } catch (error) { failure = error; }
      assert.equal(failure?.message, "protected_host_actor_entry_invalid"); assert.equal(isRefusal(entry, failure), false);
      assert.deepEqual([producerCalls, gateCalls], [0, 0]);
      const stage = f.register(); f.registry.closeStage(stage);
    }
  });

  await t.test("an ordinary thenable consumer result does not execute or read its then getter", t => {
    const f = createProtectedHostStageFixture(t); let producerCalls = 0, thenReads = 0, thenCalls = 0;
    const thenable = Object.defineProperty({}, "then", { get() {
      thenReads++; return () => { thenCalls++; };
    } });
    const entry = defineProtectedHostActorEntry("keychain_security", () => { producerCalls++; }, () => thenable);
    f.registry.bindOriginalActorEntries([entry]);
    assert.throws(() => entry.invoke(undefined, {}), { message: "protected_host_actor_entry_invalid" });
    assert.deepEqual([producerCalls, thenReads, thenCalls], [0, 0, 0]);
    const stage = f.register(); f.registry.closeStage(stage);
  });

  await t.test("consumer failure and invalid record cannot borrow readonly-gate denial provenance", t => {
    const f = createProtectedHostStageFixture(t), stage = f.register(), unit = singleUseActor("keychain_security");
    f.registry.bindOriginalActorEntries([unit.entry]);
    const sameMessage = Object.assign(new Error("protected_host_actor_unbound_with_active_stage"),
      { code: "protected_host_actor_unbound_with_active_stage" });
    assert.throws(() => unit.entry.invoke(undefined, {}), { message: "fixture_original_record_invalid" });
    unit.afterConsume = () => { throw sameMessage; };
    assert.throws(() => unit.entry.invoke(undefined, unit.capture("input")), error => error === sameMessage);
    assert.equal(isRefusal(unit.entry, sameMessage), false); assert.equal(unit.producerCalls, 0);
    f.registry.closeStage(stage); const resumed = f.register(); f.registry.closeStage(resumed);
  });

  await t.test("the exact entry alone recognizes its real readonly refusal; clones, other entries, and matching errors cannot", t => {
    const f = createProtectedHostStageFixture(t), stage = f.register();
    const unit = singleUseActor("keychain_security"), other = singleUseActor("packaged_codesign");
    f.registry.bindOriginalActorEntries([unit.entry, other.entry]);
    let refusal;
    try { unit.entry.invoke(undefined, unit.capture("input")); } catch (error) { refusal = error; }
    assert.equal(refusal?.message, "protected_host_actor_unbound_with_active_stage");
    assert.equal(isRefusal(unit.entry, refusal), true); assert.equal(isRefusal(other.entry, refusal), false);
    assert.equal(isRefusal(unit.entry, Object.assign(new Error(refusal.message), { code: refusal.message })), false);
    assert.equal(isRefusal(unit.entry, { message: refusal.message, code: refusal.message }), false);
    assert.equal(isRefusal(unit.entry, null), false);
    assert.throws(() => isRefusal({ ...unit.entry }, refusal), { message: "protected_host_actor_entry_invalid" });
    assert.equal(unit.producerCalls, 0); assert.equal(other.producerCalls, 0);
    f.registry.closeStage(stage); const resumed = f.register(); f.registry.closeStage(resumed);
  });

  await t.test("assertMayInvoke is readonly preflight, not record consumption or invocation refusal branding", t => {
    const f = createProtectedHostStageFixture(t), stage = f.register(), unit = singleUseActor("keychain_security");
    f.registry.bindOriginalActorEntries([unit.entry]); const record = unit.capture("input"); let refusal;
    try { unit.entry.assertMayInvoke(undefined); } catch (error) { refusal = error; }
    assert.equal(refusal?.message, "protected_host_actor_unbound_with_active_stage");
    assert.equal(isRefusal(unit.entry, refusal), false); assert.equal(unit.consumerCalls, 0);
    assert.equal(unit.producerCalls, 0);
    f.registry.closeStage(stage); const resumed = f.register(); f.registry.closeStage(resumed);
    assert.equal(unit.entry.invoke(undefined, record), "input"); assert.equal(unit.producerCalls, 1);
    assert.throws(() => f.register(), /protected_host_actor_coverage_unknown/u);
  });

  await t.test("a record is consumed before the readonly gate; refused invocation and replay never enter its producer", t => {
    const f = createProtectedHostStageFixture(t), stage = f.register(), unit = singleUseActor("keychain_security");
    f.registry.bindOriginalActorEntries([unit.entry]); const events = [], record = unit.capture("input");
    unit.afterConsume = () => events.push("consume");
    const originalGate = f.registry.assertActorEntryLaunchCurrent;
    t.mock.method(f.registry, "assertActorEntryLaunchCurrent", function (entry, actor, trackEntry) {
      events.push("gate"); assert.equal(trackEntry, false);
      assert.equal(unit.isConsumed(record), true);
      return Reflect.apply(originalGate, this, [entry, actor, trackEntry]);
    });
    let refusal;
    try { unit.entry.invoke(undefined, record); } catch (error) { refusal = error; }
    assert.equal(isRefusal(unit.entry, refusal), true); assert.deepEqual(events, ["consume", "gate"]);
    let replay;
    try { unit.entry.invoke(undefined, record); } catch (error) { replay = error; }
    assert.equal(replay?.message, "fixture_original_record_consumed"); assert.equal(isRefusal(unit.entry, replay), false);
    assert.deepEqual(events, ["consume", "gate"]); assert.equal(unit.producerCalls, 0);
    f.registry.closeStage(stage); const resumed = f.register(); f.registry.closeStage(resumed);
  });

  await t.test("reentrant invocation during consumption cannot replay the record or run an extra gate", t => {
    const f = createProtectedHostStageFixture(t), unit = singleUseActor("keychain_security");
    f.registry.bindOriginalActorEntries([unit.entry]); const record = unit.capture("input"); let gateCalls = 0, reentrantFailure;
    const originalGate = f.registry.assertActorEntryLaunchCurrent;
    t.mock.method(f.registry, "assertActorEntryLaunchCurrent", function (...args) {
      gateCalls++; assert.equal(args[2], false); return Reflect.apply(originalGate, this, args);
    });
    unit.afterConsume = () => {
      try { unit.entry.invoke(undefined, record); } catch (error) { reentrantFailure = error; }
      assert.equal(reentrantFailure?.message, "fixture_original_record_consumed");
      assert.equal(isRefusal(unit.entry, reentrantFailure), false);
    };
    assert.equal(unit.entry.invoke(undefined, record), "input");
    assert.equal(unit.producerCalls, 1); assert.equal(gateCalls, 1);
    assert.throws(() => unit.entry.invoke(undefined, record), { message: "fixture_original_record_consumed" });
    assert.throws(() => f.register(), /protected_host_actor_coverage_unknown/u);
  });

  await t.test("a reused genuine gate Error thrown by the consumer loses its old marker without creating native history", t => {
    const f = createProtectedHostStageFixture(t), stage = f.register(), unit = singleUseActor("keychain_security");
    f.registry.bindOriginalActorEntries([unit.entry]); let reused;
    try { unit.entry.invoke(undefined, unit.capture("first")); } catch (error) { reused = error; }
    assert.equal(isRefusal(unit.entry, reused), true); f.registry.closeStage(stage);
    unit.afterConsume = () => { throw reused; };
    assert.throws(() => unit.entry.invoke(undefined, unit.capture("second")), error => error === reused);
    assert.equal(isRefusal(unit.entry, reused), false); assert.equal(unit.producerCalls, 0);
    const resumed = f.register(); f.registry.closeStage(resumed);
  });

  await t.test("an entered coverage notification failure revokes a reused refusal without clearing sticky history", t => {
    const f = createProtectedHostStageFixture(t), stage = f.register(), unit = singleUseActor("keychain_security");
    f.registry.bindOriginalActorEntries([unit.entry]); let reused;
    try { unit.entry.invoke(undefined, unit.capture("first")); } catch (error) { reused = error; }
    assert.equal(isRefusal(unit.entry, reused), true); f.registry.closeStage(stage);
    t.mock.method(f.registry, "markActorEntryCoverageUnknown", () => { throw reused; });
    assert.throws(() => unit.entry.invoke(undefined, unit.capture("second")), error => error === reused);
    assert.equal(isRefusal(unit.entry, reused), false);
    assert.equal(unit.producerCalls, 0, "notification failed before the original producer could run");
    const late = createProtectedHostStageFixture(t); late.registry.bindOriginalActorEntries([unit.entry]);
    assert.throws(() => late.register(), /protected_host_actor_coverage_unknown/u);
  });

  for (const asynchronous of [false, true]) {
    await t.test((asynchronous ? "native Promise rejection" : "synchronous producer failure") + " revokes a reused refusal but preserves unknown launch history", async t => {
      const f = createProtectedHostStageFixture(t), stage = f.register(); let reused, originalResult;
      const unit = singleUseActor("keychain_security", () => {
        if (!asynchronous) throw reused;
        originalResult = Promise.reject(reused); return originalResult;
      });
      f.registry.bindOriginalActorEntries([unit.entry]);
      try { unit.entry.invoke(undefined, unit.capture("first")); } catch (error) { reused = error; }
      assert.equal(isRefusal(unit.entry, reused), true); assert.equal(unit.producerCalls, 0);
      f.registry.closeStage(stage);
      if (asynchronous) {
        const result = unit.entry.invoke(undefined, unit.capture("second"));
        assert.equal(result, originalResult, "the original native Promise is returned unchanged");
        await assert.rejects(result, error => error === reused);
      } else assert.throws(() => unit.entry.invoke(undefined, unit.capture("second")), error => error === reused);
      assert.equal(isRefusal(unit.entry, reused), false); assert.equal(unit.producerCalls, 1);
      assert.throws(() => f.register(), /protected_host_actor_coverage_unknown/u);
      const late = createProtectedHostStageFixture(t); late.registry.bindOriginalActorEntries([unit.entry]);
      assert.throws(() => late.register(), /protected_host_actor_coverage_unknown/u);
    });
  }

  await t.test("producer ordinary thenable result keeps exact identity and never reads its then getter", t => {
    const f = createProtectedHostStageFixture(t); let getterReads = 0;
    const thenable = Object.defineProperty({}, "then", { get() { getterReads++; throw new Error("must-not-read-then"); } });
    const unit = singleUseActor("keychain_security", () => thenable); f.registry.bindOriginalActorEntries([unit.entry]);
    assert.equal(unit.entry.invoke(undefined, unit.capture("input")), thenable);
    assert.equal(getterReads, 0); assert.equal(unit.producerCalls, 1);
    assert.throws(() => f.register(), /protected_host_actor_coverage_unknown/u);
  });

  t.diagnostic("Synthetic source-owned records exercise wrapper contracts only: they are not original installed sources, certified profiles, complete manifests, native process starts, or descendant-closure evidence.");
});

/** Private fixture capabilities model source consumption; no installed-source authority is claimed. */
function singleUseActor(entryId, producer = value => value) {
  const records = new WeakMap();
  const unit = { consumerCalls: 0, producerCalls: 0, afterConsume: undefined,
    capture(value) {
      const record = Object.freeze({}); records.set(record, { value, consumed: false }); return record;
    },
    isConsumed(record) { return records.get(record)?.consumed === true; },
  };
  unit.entry = defineProtectedHostActorEntry(entryId, record => {
    unit.producerCalls++; return producer(records.get(record).value);
  }, record => {
    unit.consumerCalls++;
    const state = records.get(record);
    if (!state) throw new Error("fixture_original_record_invalid");
    if (state.consumed) throw new Error("fixture_original_record_consumed");
    state.consumed = true;
    unit.afterConsume?.(record);
  });
  return unit;
}
