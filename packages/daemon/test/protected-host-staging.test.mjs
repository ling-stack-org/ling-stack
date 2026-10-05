import assert from "node:assert/strict";
import fs, { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { NativeRestrictedCommandRuntime } from "../dist/runtime/sandbox/restricted-command-runtime.js";
import { ProtectedHostStageRegistry } from "../dist/runtime/sandbox/protected-host-staging.js";
import { captureProtectedHostStagePaths } from "../dist/runtime/sandbox/protected-host-stage-paths.js";
import { readPreparedMacosSandboxAuthority } from "../dist/runtime/sandbox/macos-native-command.js";
import { assertProtectedHostDomainExcludesStage } from "../dist/runtime/sandbox/protected-host-actor-domain.js";
import { readProtectedHostBootstrapReadRoots } from "../dist/runtime/sandbox/protected-host-bootstrap-domain.js";
import { readMacosSandboxBackendIdentity } from "../dist/runtime/sandbox/macos-native-command.js";
import { MACOS_DYLD_PROFILE } from "../dist/runtime/sandbox/macos-seatbelt-profile.js";
import { commandFor, createProtectedHostStageFixture, waitActor } from "./support/protected-host-stage-fixture.mjs";

const native = { skip: process.platform !== "darwin" };
function patchFs(replacements, effect) {
  const originals = new Map(Object.keys(replacements).map(name => [name, fs[name]]));
  for (const [name, replacement] of Object.entries(replacements)) fs[name] = replacement(originals.get(name));
  syncBuiltinESMExports();
  try { return effect(); }
  finally { for (const [name, original] of originals) fs[name] = original; syncBuiltinESMExports(); }
}

test("protected issuer rejects cloned/cross-registry source, stage and original prepared capabilities", native, async t => {
  const f = createProtectedHostStageFixture(t), command = commandFor("process.exit(0)"), input = f.input(command), stage = f.register();
  assert.throws(() => new NativeRestrictedCommandRuntime(f.config, Object.create(f.registry)), /protected_host_registry_invalid/);
  await assert.rejects(f.runtime.prepare({ ...input, protectedActorSource: { ...input.protectedActorSource } }), /protected_host_actor_source_invalid/);
  await assert.rejects(f.runtime.prepare({ ...input, policy: { ...input.policy, allowedWritePaths: [] } }), /protected_host_actor_binding_invalid/);
  const other = new ProtectedHostStageRegistry();
  await assert.rejects(new NativeRestrictedCommandRuntime(f.config, other).prepare(input), /protected_host_actor_source_invalid/);
  assert.throws(() => f.registry.assertStageCurrent({ ...stage }), /protected_host_stage_registration_invalid/);
  const original = f.directPrepared();
  assert.throws(() => readPreparedMacosSandboxAuthority({ ...original.prepared }), /macos_prepared_capability_invalid/);
  assert.throws(() => f.registry.bindPreparedActor(original.token, { ...original.prepared }), /macos_prepared_capability_invalid/);
  const actor = f.registry.bindPreparedActor(original.token, original.prepared);
  assert.throws(() => f.registry.beginActorLaunch({ ...actor }), /protected_host_actor_preparation_invalid/);
  assert.throws(() => other.beginActorLaunch(actor), /protected_host_actor_preparation_invalid/);
});

test("no-op caller guard cannot bypass original owner epoch or source policy", native, async t => {
  const f = createProtectedHostStageFixture(t), stage = f.register(), command = commandFor("process.exit(0)");
  const prepared = await f.runtime.prepare(f.input(command));
  f.store.createWorkUnitAttempt({ workUnitId: f.current.run.workUnitId, attemptNumber: 2, runtimeInstanceId: "successor",
    runnerId: "pi", status: "started", now: new Date().toISOString() });
  assert.throws(() => prepared.spawn(), /protected_host_source_obsolete/);
  assert.throws(() => f.registry.assertStageCurrent(stage), /protected_host_source_obsolete/);
  prepared.dispose(); f.registry.closeStage(stage);
  const successor = f.createRun(), newStage = f.register(successor);
  f.registry.assertStageCurrent(newStage);
  const next = await f.runtime.prepare(f.input(command, successor)); await waitActor(next.spawn()); next.dispose();
});

test("workspace approval revision closes a captured source even with a no-op guard", native, async t => {
  const f = createProtectedHostStageFixture(t), command = commandFor("process.exit(0)");
  const prepared = await f.runtime.prepare(f.input(command));
  f.store.updateApprovalPolicy({ toolDecisions: { bash: "deny" } }, new Date(Date.now() + 1000).toISOString());
  assert.throws(() => prepared.spawn(), /protected_host_source_obsolete/);
  prepared.dispose();
});

test("capture refuses a Run effective-policy snapshot already stale before the no-op guard exists", native, t => {
  const f = createProtectedHostStageFixture(t), command = commandFor("process.exit(0)");
  f.store.updateApprovalPolicy({ allowedWritePaths: [] }, new Date(Date.now() + 1000).toISOString());
  assert.throws(() => f.input(command), /protected_host_actor_policy_obsolete/);
});

test("capture refuses actual workspace bash deny even when the Run effective snapshot says allow", native, t => {
  const f = createProtectedHostStageFixture(t), command = commandFor("process.exit(0)");
  f.store.updateApprovalPolicy({ toolDecisions: { bash: "deny" } }, f.current.policy.workspacePolicyUpdatedAt);
  assert.throws(() => f.input(command), /protected_host_actor_policy_obsolete/);
});

test("terminal original run stage closes explicitly and a new run can register and execute", native, async t => {
  const f = createProtectedHostStageFixture(t), stage = f.register(), command = commandFor("process.exit(0)");
  const original = await f.runtime.prepare(f.input(command)); await waitActor(original.spawn()); original.dispose();
  f.store.markRunSucceeded(f.current.run.id, new Date().toISOString());
  assert.throws(() => f.registry.assertStageCurrent(stage), /protected_host_source_obsolete/);
  f.registry.closeStage(stage);
  const next = f.createRun(), nextStage = f.register(next); f.registry.assertStageCurrent(nextStage);
  const prepared = await f.runtime.prepare(f.input(command, next)); await waitActor(prepared.spawn()); prepared.dispose();
});

for (const before of [false, true]) test("real controlled actor denies stage read/write and ancestor rename, actor-before-stage=" + before, native, async t => {
  const f = createProtectedHostStageFixture(t), secret = join(f.stagePath, "secret"), destination = f.root + "-moved";
  writeFileSync(secret, "original");
  const code = `const fs=require("node:fs");const out={};for(const [k,fn] of Object.entries({read:()=>fs.readFileSync(${JSON.stringify(secret)}),write:()=>fs.writeFileSync(${JSON.stringify(secret)},"changed"),rename:()=>fs.renameSync(${JSON.stringify(f.root)},${JSON.stringify(destination)})})){try{fn();out[k]="allowed"}catch(e){out[k]=e.code}}fs.writeFileSync(process.env.TMPDIR+"scratch-proof","ok");console.log(JSON.stringify(out))`;
  const command = commandFor(code);
  let stage = before ? undefined : f.register();
  const prepared = await f.runtime.prepare(f.input(command));
  if (before) stage = f.register();
  f.registry.assertStageCurrent(stage);
  const result = JSON.parse(await waitActor(prepared.spawn()));
  for (const key of ["read", "write", "rename"]) assert.ok(["EPERM", "EACCES"].includes(result[key]), key + ": " + result[key]);
  assert.equal(readFileSync(secret, "utf8"), "original");
  prepared.dispose(); f.registry.assertStageCurrent(stage);
});

test("launched actor is covered when stage is registered after native launch", native, async t => {
  const f = createProtectedHostStageFixture(t), secret = join(f.stagePath, "secret"); writeFileSync(secret, "original");
  const command = commandFor(`setTimeout(()=>{try{require("node:fs").readFileSync(${JSON.stringify(secret)});process.exit(8)}catch(e){console.log(e.code)}},100)`);
  const prepared = await f.runtime.prepare(f.input(command)), child = prepared.spawn(), stage = f.register();
  f.registry.assertStageCurrent(stage); assert.match(await waitActor(child), /EPERM|EACCES/); prepared.dispose();
});

test("the arena family and static runtime read scopes cannot become protected stage roots", native, t => {
  const f = createProtectedHostStageFixture(t), original = f.directPrepared();
  f.registry.bindPreparedActor(original.token, original.prepared);
  const nested = join(original.scratch, "stage"); mkdirSync(nested, { mode: 0o700 });
  assert.throws(() => f.register(f.current, nested), /protected_host_stage_actor_conflict|protected_host_stage_ancestor_conflict/);
  assert.throws(() => f.register(f.current, "/private/tmp"), /protected_host_stage_not_private/);
  assert.throws(() => f.register(f.current, "/usr/bin"), /protected_host_stage_not_private/);
  const sibling = f.register(); f.registry.assertStageCurrent(sibling);
});

test("stage privacy is rechecked, and actual bootstrap/device data scopes are conservatively reserved", native, t => {
  const f = createProtectedHostStageFixture(t), stage = f.register();
  chmodSync(f.stagePath, 0o755);
  assert.throws(() => f.registry.assertStageCurrent(stage), /protected_host_stage_not_private/);
  assert.throws(() => f.register(), /protected_host_stage_not_private/);
  f.registry.closeStage(stage); chmodSync(f.stagePath, 0o700);
  const backend = readMacosSandboxBackendIdentity(), roots = readProtectedHostBootstrapReadRoots(backend);
  const domain = { backend, staticReadRoots: roots };
  for (const path of ["/dev", "/dev/null", "/System", "/System/Volumes/Preboot/Cryptexes/OS", "/System/Cryptexes/OS"]) {
    assert.throws(() => assertProtectedHostDomainExcludesStage(domain, { stagePath: path, ancestors: [] }), /protected_host_stage_actor_conflict/);
  }
  for (const path of ["/dev", "/System"]) assert.throws(() => f.register(f.current, path), /protected_host_stage_not_private/);
  f.registry.assertStageCurrent(f.register());
});

test("unknown actual bootstrap bytes close registration/current Office only, without blocking no-stage execution", native, async t => {
  const f = createProtectedHostStageFixture(t), stage = f.register(), command = commandFor("process.exit(0)");
  const descriptors = new Set();
  const corrupt = effect => patchFs({
    openSync: original => (...args) => {
      const fd = original(...args);
      if (args[0] === MACOS_DYLD_PROFILE && typeof args[1] === "number" && (args[1] & fs.constants.O_NOFOLLOW)) descriptors.add(fd);
      return fd;
    },
    readSync: original => (...args) => {
      if (!descriptors.has(args[0])) return original(...args);
      const count = original(...args);
      if (count > 0) args[1][args[2]] ^= 1;
      return count;
    },
    closeSync: original => fd => { descriptors.delete(fd); return original(fd); },
  }, effect);
  corrupt(() => {
    assert.throws(() => f.registry.assertStageCurrent(stage), /protected_host_bootstrap_domain_unverified/);
    assert.throws(() => f.register(), /protected_host_bootstrap_domain_unverified/);
  });
  f.registry.closeStage(stage);
  const prepared = await corrupt(() => f.runtime.prepare(f.input(command)));
  await waitActor(prepared.spawn()); prepared.dispose();
  assert.throws(() => f.register(), /protected_host_actor_coverage_unknown/);
});

test("more than 256 real ordinary commands and more than 64 closed stage lifetimes do not exhaust history budgets", native, async t => {
  const f = createProtectedHostStageFixture(t), command = commandFor("process.exit(0)");
  for (let i = 0; i < 258; i++) {
    const prepared = await f.runtime.prepare(f.input(command, f.current, "many-call-" + i));
    await waitActor(prepared.spawn()); prepared.dispose();
  }
  for (let i = 0; i < 66; i++) {
    const stage = f.register(); f.registry.assertStageCurrent(stage); f.registry.closeStage(stage); f.registry.closeStage(stage);
    assert.throws(() => f.registry.assertStageCurrent(stage), /protected_host_stage_closed/);
  }
  const stage = f.register(); f.registry.assertStageCurrent(stage);
});

test("unknown original launch closes Office coverage without imposing a no-stage execution limit", native, async t => {
  const f = createProtectedHostStageFixture(t), original = f.directPrepared(), actor = f.registry.bindPreparedActor(original.token, original.prepared);
  f.registry.beginActorLaunch(actor);
  assert.throws(() => f.registry.recordActorLaunched(actor, {}), /protected_host_actor_launch_unknown/);
  f.registry.markActorLaunchUnknown(actor);
  assert.throws(() => f.register(), /protected_host_actor_coverage_unknown/);
  const prepared = await f.runtime.prepare(f.input(commandFor("process.exit(0)"))); await waitActor(prepared.spawn()); prepared.dispose();
});

test("unknown fixed topology does not claim coverage and does not poison ordinary no-stage execution", native, async t => {
  const f = createProtectedHostStageFixture(t), original = f.directPrepared(f.current, input => { input.policy.allowedWritePaths = ["."]; });
  const actor = f.registry.bindPreparedActor(original.token, original.prepared);
  f.registry.beginActorLaunch(actor);
  const child = original.prepared.spawn(() => {}); f.registry.recordActorLaunched(actor, child); await waitActor(child);
  assert.throws(() => f.register(), /protected_host_actor_coverage_unknown/);
  const prepared = await f.runtime.prepare(f.input(commandFor("process.exit(0)"))); await waitActor(prepared.spawn()); prepared.dispose();
});

test("original stage pathname identity replacement closes forward and new launch, not original FD cleanup", native, async t => {
  const f = createProtectedHostStageFixture(t), stage = f.register(), command = commandFor("process.exit(0)");
  const prepared = await f.runtime.prepare(f.input(command));
  renameSync(f.stagePath, join(f.root, "displaced-stage")); mkdirSync(f.stagePath);
  assert.throws(() => f.registry.assertStageCurrent(stage), /protected_host_stage_identity_changed/);
  assert.throws(() => prepared.spawn(), /protected_host_stage_identity_changed/);
  f.registry.closeStage(stage); prepared.dispose();
});

test("partial ancestor capture closes every acquired original FD once, including the failed first fstat", native, t => {
  const f = createProtectedHostStageFixture(t), opened = [], closed = [];
  patchFs({ openSync: original => (...args) => { const fd = original(...args); opened.push(fd); return fd; },
    fstatSync: original => (...args) => { if (opened.length === 3) throw Object.assign(new Error("capture EIO"), { code: "EIO" }); return original(...args); },
    closeSync: original => fd => { closed.push(fd); return original(fd); } }, () => {
    assert.throws(() => captureProtectedHostStagePaths(f.stagePath), /capture EIO/);
  });
  assert.equal(opened.length, 3); assert.deepEqual(closed, [...opened].reverse());
});

test("initial actual fstat EBADF tombstones before foreign reuse and partial cleanup never retries that integer", native, t => {
  const f = createProtectedHostStageFixture(t), closes = []; let triggered = false, victim, foreign;
  patchFs({ fstatSync: original => (...args) => {
    if (!triggered) {
      triggered = true; victim = args[0]; fs.closeSync(victim);
      try { original(...args); assert.fail("a genuinely closed descriptor must return EBADF"); }
      catch (error) {
        assert.equal(error.code, "EBADF");
        foreign = fs.openSync("/dev/null", fs.constants.O_RDONLY); assert.equal(foreign, victim);
        throw error;
      }
    }
    return original(...args);
  }, closeSync: original => fd => { closes.push(fd); return original(fd); } }, () => {
    assert.throws(() => captureProtectedHostStagePaths(f.stagePath), error => {
      assert.equal(error.message, "protected_host_stage_capture_unknown");
      assert.equal(error.errors[0].code, "EBADF"); return true;
    });
  });
  assert.deepEqual(closes, [victim]); assert.ok(fs.fstatSync(foreign).isCharacterDevice()); fs.closeSync(foreign);
});

test("initial path versus just-acquired original FD identity mismatch still closes the original once", native, t => {
  const f = createProtectedHostStageFixture(t), opened = [], closed = []; let changed = false;
  patchFs({ openSync: original => (...args) => { const fd = original(...args); opened.push(fd); return fd; },
    fstatSync: original => (...args) => {
      const stat = original(...args);
      if (!changed) { changed = true; return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { ino: stat.ino + 1n }); }
      return stat;
    }, closeSync: original => fd => { closed.push(fd); return original(fd); } }, () => {
    assert.throws(() => captureProtectedHostStagePaths(f.stagePath), /protected_host_stage_identity_changed/);
  });
  assert.equal(opened.length, 1); assert.deepEqual(closed, opened);
});

test("close-after-actual-close EIO tombstones before an integer is reused and never closes the foreign lifetime", native, t => {
  const f = createProtectedHostStageFixture(t), stage = f.register(); let foreign, reused, calls = 0;
  patchFs({ closeSync: original => fd => {
    calls++; original(fd);
    if (foreign === undefined) {
      reused = fd; foreign = fs.openSync("/dev/null", fs.constants.O_RDONLY); assert.equal(foreign, reused);
      throw Object.assign(new Error("post-close EIO"), { code: "EIO" });
    }
  } }, () => {
    assert.throws(() => f.registry.closeStage(stage), /protected_host_stage_close_unknown/);
    const count = calls;
    assert.throws(() => f.registry.closeStage(stage), /protected_host_stage_close_unknown/); assert.equal(calls, count);
  });
  assert.ok(fs.fstatSync(foreign).isCharacterDevice()); fs.closeSync(foreign);
});

for (const failure of ["EBADF", "reused_inode"]) test("real lost original FD " + failure + " cannot later close a reused foreign integer", native, t => {
  const f = createProtectedHostStageFixture(t), originals = [], closeCalls = []; let paths, victim, foreign;
  patchFs({ openSync: original => (...args) => { const fd = original(...args); originals.push(fd); return fd; } }, () => {
    paths = captureProtectedHostStagePaths(f.stagePath);
  });
  victim = originals.at(-1); fs.closeSync(victim);
  if (failure === "reused_inode") { foreign = fs.openSync("/dev/null", fs.constants.O_RDONLY); assert.equal(foreign, victim); }
  assert.throws(() => paths.assertCurrent(), failure === "EBADF" ? /EBADF/ : /protected_host_stage_identity_changed/);
  if (foreign === undefined) { foreign = fs.openSync("/dev/null", fs.constants.O_RDONLY); assert.equal(foreign, victim); }
  patchFs({ closeSync: original => fd => { closeCalls.push(fd); return original(fd); } }, () => {
    assert.throws(() => paths.close(), /protected_host_stage_close_unknown/);
    assert.throws(() => paths.close(), /protected_host_stage_close_unknown/);
  });
  assert.equal(closeCalls.includes(victim), false); assert.equal(new Set(closeCalls).size, originals.length - 1);
  assert.ok(fs.fstatSync(foreign).isCharacterDevice()); fs.closeSync(foreign);
});

for (const code of ["EIO", "EINTR"]) test("ordinary fstat " + code + " does not invent descriptor loss and the original FD is closed once", native, t => {
  const f = createProtectedHostStageFixture(t), paths = captureProtectedHostStagePaths(f.stagePath), closed = [];
  patchFs({ fstatSync: () => () => { throw Object.assign(new Error("temporary " + code), { code }); } }, () => {
    assert.throws(() => paths.assertCurrent(), new RegExp("temporary " + code));
  });
  paths.assertCurrent();
  patchFs({ closeSync: original => fd => { closed.push(fd); original(fd); } }, () => { paths.close(); paths.close(); });
  assert.equal(new Set(closed).size, closed.length); assert.ok(closed.length > 1);
});
