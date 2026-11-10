import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { MACOS_NATIVE_COMMAND_ACTOR_ENTRY } from "../dist/runtime/sandbox/macos-native-command.js";
import { defineProtectedHostActorEntry, isProtectedHostActorEntryLaunchRefusal,
  readOriginalProtectedHostActorDomainHistory } from "../dist/runtime/sandbox/protected-host-actor-inventory.js";
import { ProtectedHostStageRegistry, readOriginalProtectedHostActorLaunchDomain } from "../dist/runtime/sandbox/protected-host-staging.js";
import { commandFor, createProtectedHostStageFixture, waitActor } from "./support/protected-host-stage-fixture.mjs";

// Each child is a real, fresh product-source lifetime. Unknown descendant
// history is deliberately permanent and is never reset between scenarios.
// Inside each case, both/all Supervisors share the very same process and
// canonical physical launcher. No mock bootstrap or native spawn is used.
const scenarios = {
  async "two default Supervisors validate one actual actor against both original stages"(t) {
    const a = createProtectedHostStageFixture(t), b = createProtectedHostStageFixture(t);
    const first = a.register(), second = b.register();
    const paths = [join(a.stagePath, "secret"), join(b.stagePath, "secret")];
    for (const path of paths) writeFileSync(path, "retained");
    const code = `const fs=require("node:fs");console.log(JSON.stringify(${JSON.stringify(paths)}.map(p=>{try{fs.readFileSync(p);return "allowed"}catch(e){return e.code}})))`;
    const prepared = await a.runtime.prepare(a.input(commandFor(code)));
    const result = JSON.parse(await waitActor(prepared.spawn()));
    prepared.dispose();
    assert.equal(result.length, 2);
    for (const denial of result) assert.ok(["EPERM", "EACCES"].includes(denial), denial);
    a.registry.assertStageCurrent(first); b.registry.assertStageCurrent(second);
    a.registry.assertActorInventoryCurrent(); b.registry.assertActorInventoryCurrent();
  },
  async "reverse Supervisor order accepts the owning actor without lending foreign source authority"(t) {
    const observer = createProtectedHostStageFixture(t), owner = createProtectedHostStageFixture(t);
    const observedStage = observer.register(), ownedStage = owner.register();
    const original = owner.directPrepared(), actor = owner.registry.bindPreparedActor(original.token, original.prepared);
    assert.throws(() => observer.registry.beginActorLaunch(actor), /protected_host_actor_preparation_invalid/u);
    assert.throws(() => observer.registry.protectedRoots(original.token), /protected_host_actor_source_invalid/u);
    assert.throws(() => readOriginalProtectedHostActorLaunchDomain({ ...actor }), /protected_host_actor_preparation_invalid/u);
    assert.throws(() => readOriginalProtectedHostActorDomainHistory(MACOS_NATIVE_COMMAND_ACTOR_ENTRY, {}), /protected_host_actor_entry_invalid/u);
    const synthetic = defineProtectedHostActorEntry("macos_native_command", () => assert.fail("synthetic producer cannot borrow an original actor"));
    const fakeRegistry = new ProtectedHostStageRegistry(); fakeRegistry.bindOriginalActorEntries([synthetic]);
    assert.throws(() => synthetic.invoke(actor), /protected_host_actor_entry_proof_invalid/u);
    MACOS_NATIVE_COMMAND_ACTOR_ENTRY.assertMayInvoke(actor);
    owner.registry.beginActorLaunch(actor);
    const child = original.prepared.spawn(() => {}, actor); owner.registry.recordActorLaunched(actor, child);
    await waitActor(child);
    observer.registry.assertStageCurrent(observedStage); owner.registry.assertStageCurrent(ownedStage);
  },
  async "a later Registry readonly refusal preserves both original Registries without committing launch history"(t) {
    const a = createProtectedHostStageFixture(t), b = createProtectedHostStageFixture(t);
    const first = a.register(), second = b.register();
    const original = a.directPrepared(a.current, input => input.runtimeReadRoots.push(b.stagePath));
    const actor = a.registry.bindPreparedActor(original.token, original.prepared);
    // These replaceable methods cannot become a constructor-private reader.
    t.mock.method(a.registry, "assertActorLaunchCurrent", () => {});
    t.mock.method(b.registry, "assertActorEntryLaunchCurrent", () => {});
    assert.throws(() => MACOS_NATIVE_COMMAND_ACTOR_ENTRY.assertMayInvoke(actor), /protected_host_stage_actor_conflict/u);
    a.registry.assertStageCurrent(first); b.registry.assertStageCurrent(second);
    b.registry.closeStage(second);
    const replacement = b.register(); b.registry.assertStageCurrent(replacement);
    b.registry.closeStage(replacement);
    a.registry.beginActorLaunch(actor);
    const child = original.prepared.spawn(() => {}, actor); a.registry.recordActorLaunched(actor, child);
    await waitActor(child);
    // Only the actual producer entry above commits the original permission
    // domain. Closing the old stage does not erase this descendant history.
    assert.throws(() => b.register(), /protected_host_stage_actor_conflict/u);
    a.registry.assertStageCurrent(first);
  },
  async "a late default Supervisor inherits actual launcher domain before admitting a conflicting stage"(t) {
    const owner = createProtectedHostStageFixture(t);
    const original = owner.directPrepared(owner.current, input => input.runtimeReadRoots.push(owner.stagePath));
    const actor = owner.registry.bindPreparedActor(original.token, original.prepared);
    owner.registry.beginActorLaunch(actor);
    const child = original.prepared.spawn(() => {}, actor); owner.registry.recordActorLaunched(actor, child);
    await waitActor(child);
    const late = createProtectedHostStageFixture(t);
    late.registry.assertActorInventoryCurrent();
    assert.throws(() => late.register(late.current, owner.stagePath), /protected_host_stage_actor_conflict/u);
    const safeStage = late.register(); late.registry.assertStageCurrent(safeStage);
  },
  async "public owner no-op cannot admit an obsolete original actor or poison a never-entered foreign Registry"(t) {
    const a = createProtectedHostStageFixture(t), b = createProtectedHostStageFixture(t);
    const original = a.directPrepared(), actor = a.registry.bindPreparedActor(original.token, original.prepared);
    t.mock.method(a.registry, "assertActorLaunchCurrent", () => {});
    a.store.createWorkUnitAttempt({ workUnitId: a.current.run.workUnitId, attemptNumber: 2, runtimeInstanceId: "successor",
      runnerId: "pi", status: "started", now: new Date().toISOString() });
    assert.throws(() => MACOS_NATIVE_COMMAND_ACTOR_ENTRY.assertMayInvoke(actor), /protected_host_source_obsolete/u);
    assert.throws(() => a.registry.beginActorLaunch(actor), /protected_host_source_obsolete/u);
    const stage = b.register(); b.registry.assertStageCurrent(stage); b.registry.assertActorInventoryCurrent();
  },
  async "a genuine actor cannot lend its domain to a different prepared source record before rejection"(t) {
    const owner = createProtectedHostStageFixture(t), observer = createProtectedHostStageFixture(t);
    const first = owner.directPrepared(owner.current, input => input.runtimeReadRoots.push(owner.stagePath));
    const actor = owner.registry.bindPreparedActor(first.token, first.prepared);
    owner.registry.beginActorLaunch(actor);
    const different = owner.directPrepared(); let failure;
    try { different.prepared.spawn(() => {}, actor); } catch (error) { failure = error; }
    assert.equal(failure?.message, "protected_host_actor_prepared_binding_invalid");
    assert.equal(isProtectedHostActorEntryLaunchRefusal(MACOS_NATIVE_COMMAND_ACTOR_ENTRY, failure), false);
    const observed = observer.register(observer.current, owner.stagePath);
    observer.registry.assertStageCurrent(observed); observer.registry.closeStage(observed);
    const late = createProtectedHostStageFixture(t), stillSafe = late.register(late.current, owner.stagePath);
    late.registry.assertStageCurrent(stillSafe); late.registry.assertActorInventoryCurrent();
  },
  async "reentry preserves newer actual domain history and refuses the stale outer producer before entry"(t) {
    const a = createProtectedHostStageFixture(t), b = createProtectedHostStageFixture(t), observer = createProtectedHostStageFixture(t);
    const firstRoot = join(a.root, "additional-read-root"), secondRoot = join(b.root, "additional-read-root");
    mkdirSync(firstRoot, { mode: 0o700 }); mkdirSync(secondRoot, { mode: 0o700 });
    const first = a.directPrepared(a.current, input => input.runtimeReadRoots.push(firstRoot));
    const firstActor = a.registry.bindPreparedActor(first.token, first.prepared);
    const second = b.directPrepared(b.current, input => input.runtimeReadRoots.push(secondRoot));
    const secondActor = b.registry.bindPreparedActor(second.token, second.prepared);
    const stage = observer.register();
    a.registry.beginActorLaunch(firstActor); b.registry.beginActorLaunch(secondActor);
    const readSnapshot = observer.store.readSnapshot;
    let entered = false, innerChild;
    t.mock.method(observer.store, "readSnapshot", function (...args) {
      if (!entered) {
        entered = true;
        innerChild = second.prepared.spawn(() => {}, secondActor);
        b.registry.recordActorLaunched(secondActor, innerChild);
      }
      return Reflect.apply(readSnapshot, this, args);
    });
    assert.throws(() => first.prepared.spawn(() => {}, firstActor), /protected_host_actor_history_changed/u);
    assert.equal(entered, true); assert.ok(innerChild); await waitActor(innerChild);
    observer.registry.assertStageCurrent(stage);
    const late = createProtectedHostStageFixture(t);
    assert.throws(() => late.register(late.current, secondRoot), /protected_host_stage_actor_conflict/u);
    const unentered = late.register(late.current, firstRoot); late.registry.assertStageCurrent(unentered);
    late.registry.assertActorInventoryCurrent();
  },
  async "commit-preview reentry cannot overwrite a newer Registry domain and closes incomplete fan-out"(t) {
    const a = createProtectedHostStageFixture(t), b = createProtectedHostStageFixture(t), observer = createProtectedHostStageFixture(t);
    const firstRoot = join(a.root, "additional-read-root"), secondRoot = join(b.root, "additional-read-root");
    mkdirSync(firstRoot, { mode: 0o700 }); mkdirSync(secondRoot, { mode: 0o700 });
    const first = a.directPrepared(a.current, input => input.runtimeReadRoots.push(firstRoot));
    const firstActor = a.registry.bindPreparedActor(first.token, first.prepared);
    const second = b.directPrepared(b.current, input => input.runtimeReadRoots.push(secondRoot));
    const secondActor = b.registry.bindPreparedActor(second.token, second.prepared);
    const stage = observer.register();
    a.registry.beginActorLaunch(firstActor); b.registry.beginActorLaunch(secondActor);
    const readSnapshot = observer.store.readSnapshot;
    let calls = 0, entered = false, innerChild;
    t.mock.method(observer.store, "readSnapshot", function (...args) {
      calls++;
      // First = all-Registry readonly preflight; second = the same original
      // Registry's private commit preview. No public gate is replaced here.
      if (!entered && calls === 2) {
        entered = true;
        innerChild = second.prepared.spawn(() => {}, secondActor);
        b.registry.recordActorLaunched(secondActor, innerChild);
      }
      return Reflect.apply(readSnapshot, this, args);
    });
    assert.throws(() => first.prepared.spawn(() => {}, firstActor), /protected_host_actor_history_changed/u);
    assert.equal(entered, true); assert.ok(innerChild); await waitActor(innerChild);
    assert.throws(() => observer.registry.assertStageCurrent(stage), /protected_host_actor_coverage_unknown/u);
    observer.registry.closeStage(stage);
    for (const f of [a, b, observer]) assert.throws(() => f.register(), /protected_host_actor_coverage_unknown/u);
    const late = createProtectedHostStageFixture(t);
    assert.throws(() => late.register(), /protected_host_actor_coverage_unknown/u);
  },
  async "unknown actual launcher domain remains sticky across all and late Supervisors while no-stage commands work"(t) {
    const a = createProtectedHostStageFixture(t), b = createProtectedHostStageFixture(t);
    const original = a.directPrepared(a.current, input => { input.policy.allowedWritePaths = ["."]; });
    const actor = a.registry.bindPreparedActor(original.token, original.prepared);
    a.registry.beginActorLaunch(actor);
    const child = original.prepared.spawn(() => {}, actor); a.registry.recordActorLaunched(actor, child);
    await waitActor(child);
    assert.throws(() => a.register(), /protected_host_actor_coverage_unknown/u);
    assert.throws(() => b.register(), /protected_host_actor_coverage_unknown/u);
    const late = createProtectedHostStageFixture(t);
    assert.throws(() => late.register(), /protected_host_actor_coverage_unknown/u);
    const prepared = await b.runtime.prepare(b.input(commandFor("process.exit(0)")));
    await waitActor(prepared.spawn()); prepared.dispose();
    assert.throws(() => b.register(), /protected_host_actor_coverage_unknown/u);
    assert.throws(() => late.register(), /protected_host_actor_coverage_unknown/u);
  },
};

const selected = process.env.LING_STACK_ORIGINAL_DOMAIN_SCENARIO;
if (selected !== undefined) assert.ok(Object.hasOwn(scenarios, selected), "unknown child scenario");
for (const name of selected ? [selected] : Object.keys(scenarios)) {
  test(name, { skip: process.platform !== "darwin" }, async t => {
    if (selected) { await scenarios[name](t); return; }
    const env = { ...process.env, LING_STACK_ORIGINAL_DOMAIN_SCENARIO: name };
    delete env.NODE_TEST_CONTEXT;
    delete env.NODE_OPTIONS;
    const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", fileURLToPath(import.meta.url)],
      { env, encoding: "utf8", timeout: 30_000, maxBuffer: 2_000_000 });
    assert.ifError(result.error); assert.equal(result.signal, null, result.stderr);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    for (const [field, expected] of Object.entries({ tests: 1, pass: 1, fail: 0, cancelled: 0, skipped: 0, todo: 0 })) {
      const statistic = result.stdout.match(new RegExp(`^# ${field} (\\d+)$`, "mu"));
      assert.ok(statistic, `missing actual child ${field} statistic: ${result.stdout}`);
      assert.equal(Number(statistic[1]), expected, result.stdout);
    }
  });
}
