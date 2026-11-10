import assert from "node:assert/strict";
import test from "node:test";
import {
  createCodesignHostSimulation, errno, SIMULATED_APP, SIMULATED_EXECUTABLE,
  SIMULATED_CODESIGN, SIMULATED_BACKEND, SIMULATED_HELPER,
} from "./support/packaged-codesign-host-simulation-fixture.mjs";

// No machine-App check, platform skip, real process launch or kernel certification.
// Await each subtest because builtin observers and Host snapshots are process-global.
test("packaged codesign Host source mechanism simulation, never protection certification", async t => {
  await t.test("forged opaque sources and copied facts cannot reach any owned source operation", async t => {
    const f = await createCodesignHostSimulation(t), source = await f.loadSource();
    for (const forged of [{}, Object.freeze({}), Object.freeze({ sourceId: "packaged_codesign",
      protection: "candidate_unverified", registryEpoch: null })]) {
      for (const method of ["readOriginalPackagedCodesignSource", "consumeOriginalPackagedCodesignSource",
        "enterOriginalPackagedCodesignSource", "closeOriginalPackagedCodesignIdentity"]) {
        assert.throws(() => source[method](forged), { message: "packaged_codesign_host_source_invalid" });
      }
    }
    assert.deepEqual(f.opens, []); assert.deepEqual(f.nativeCalls, []);
  });

  await t.test("owned simulation remains an unverified candidate and consume/enter cannot replay", async t => {
    const f = await createCodesignHostSimulation(t), api = await f.loadSource();
    const owned = api.prepareOriginalPackagedCodesignSource(), facts = api.readOriginalPackagedCodesignSource(owned);
    assert.equal(Object.isFrozen(owned), true); assert.equal(Object.isFrozen(facts), true);
    assert.equal(facts.protection, "candidate_unverified"); assert.equal(facts.registryEpoch, null);
    assert.equal(facts.sourceKind, "original_host_process"); assert.equal(facts.appBundlePath, SIMULATED_APP);
    assert.equal(facts.hostExecutablePath, SIMULATED_EXECUTABLE);
    assert.equal(facts.staticReadRoots.includes(SIMULATED_APP), true);
    for (const forged of [Object.freeze({ ...owned }), Object.freeze({ ...facts })]) {
      assert.throws(() => api.readOriginalPackagedCodesignSource(forged), /host_source_invalid/u);
    }
    assert.throws(() => api.enterOriginalPackagedCodesignSource(owned), /host_source_invalid/u);
    api.consumeOriginalPackagedCodesignSource(owned);
    assert.throws(() => api.consumeOriginalPackagedCodesignSource(owned), /host_source_invalid/u);
    const native = api.enterOriginalPackagedCodesignSource(owned);
    assert.equal(native.executable, SIMULATED_HELPER);
    assert.deepEqual(native.argv, ["--verify-packaged-codesign"]);
    assert.equal(native.options.input, undefined, "private request Buffer is not exposed by enterSource");
    assert.equal(native.options.cwd, "/"); assert.equal(Object.isFrozen(native), true);
    assert.equal(Object.isFrozen(native.argv), true); assert.equal(Object.isFrozen(native.options.env), true);
    assert.throws(() => api.enterOriginalPackagedCodesignSource(owned), /host_source_invalid/u);
    api.closeOriginalPackagedCodesignIdentity(owned);
    const closed = f.closes.length; api.closeOriginalPackagedCodesignIdentity(owned);
    assert.equal(f.closes.length, closed); assert.deepEqual(f.originalFiles(), []);
    assert.throws(() => api.readOriginalPackagedCodesignSource(owned), /host_source_invalid/u);
    assert.deepEqual(f.nativeCalls, [], "enter returns immutable inputs; the simulation launches no process");
  });

  await t.test("closing a prepared identity cannot be revived by later consume or enter", async t => {
    const f = await createCodesignHostSimulation(t), api = await f.loadSource();
    const owned = api.prepareOriginalPackagedCodesignSource();
    api.closeOriginalPackagedCodesignIdentity(owned);
    assert.throws(() => api.consumeOriginalPackagedCodesignSource(owned), /host_source_invalid/u);
    assert.throws(() => api.enterOriginalPackagedCodesignSource(owned), /host_source_invalid/u);
    assert.deepEqual(f.originalFiles(), []); assert.deepEqual(f.nativeCalls, []);
  });

  await t.test("first lstat/open inode mismatch closes the just-acquired original FD once", async t => {
    const f = await createCodesignHostSimulation(t), api = await f.loadSource(); let acquired;
    f.hooks.open = slot => {
      if (slot.path === SIMULATED_EXECUTABLE) {
        acquired = slot; slot.row = { ...slot.row, ino: slot.row.ino + 1 };
      }
    };
    assert.throws(() => api.prepareOriginalPackagedCodesignSource(), /original_file_changed/u);
    assert.ok(acquired); assert.equal(f.closeCount(acquired.fd), 1);
    assert.deepEqual(f.originalFiles(), []); assert.deepEqual(f.nativeCalls, []);
  });

  await t.test("a first non-EBADF fstat failure still cleans the newly acquired original FD", async t => {
    const f = await createCodesignHostSimulation(t), api = await f.loadSource(); let acquired;
    const failure = errno("EIO", "first original fstat failed");
    f.hooks.stat = slot => {
      if (slot.path === SIMULATED_EXECUTABLE && slot.statCalls === 1) { acquired = slot; throw failure; }
    };
    assert.throws(() => api.prepareOriginalPackagedCodesignSource(), error => error === failure);
    assert.ok(acquired); assert.equal(f.closeCount(acquired.fd), 1); assert.deepEqual(f.originalFiles(), []);
  });

  await t.test("read EBADF tombstones its lost original and never closes a reused foreign integer", async t => {
    const f = await createCodesignHostSimulation(t), api = await f.loadSource(); let lost;
    const failure = errno("EBADF", "original read lifetime disappeared");
    f.hooks.read = slot => {
      if (slot.path === SIMULATED_EXECUTABLE) { lost = slot; f.replaceWithForeign(slot); throw failure; }
    };
    assert.throws(() => api.prepareOriginalPackagedCodesignSource(), error => error === failure);
    assert.ok(lost); assert.equal(f.closeCount(lost.fd), 0);
    assert.equal(f.descriptors.get(lost.fd)?.row.foreign, true); assert.deepEqual(f.originalFiles(), []);
  });

  await t.test("a later sealed-FD inode change is unknown and must not close the foreign reused integer", async t => {
    const f = await createCodesignHostSimulation(t), api = await f.loadSource(); let lost;
    f.hooks.stat = slot => {
      if (slot.path === SIMULATED_EXECUTABLE && slot.statCalls === 2) { lost = slot; f.replaceWithForeign(slot); }
    };
    assert.throws(() => api.prepareOriginalPackagedCodesignSource(), /original_file_changed/u);
    assert.ok(lost); assert.equal(f.closeCount(lost.fd), 0);
    assert.equal(f.descriptors.get(lost.fd)?.row.foreign, true); assert.deepEqual(f.originalFiles(), []);
  });

  await t.test("identity close aggregates independent errors and never retries unknown original integers", async t => {
    const f = await createCodesignHostSimulation(t), api = await f.loadSource();
    const owned = api.prepareOriginalPackagedCodesignSource();
    const backendFailure = errno("EIO", "backend close unknown"), codesignFailure = errno("EIO", "codesign close unknown");
    f.hooks.close = slot => {
      if (slot.path === SIMULATED_BACKEND) throw backendFailure;
      if (slot.path === SIMULATED_CODESIGN) throw codesignFailure;
    };
    let failure;
    try { api.closeOriginalPackagedCodesignIdentity(owned); } catch (error) { failure = error; }
    assert.ok(failure instanceof AggregateError); assert.equal(failure.message, "packaged_codesign_identity_close_unknown");
    assert.deepEqual(failure.errors, [backendFailure, codesignFailure]);
    const attempts = f.closes.length;
    assert.throws(() => api.closeOriginalPackagedCodesignIdentity(owned), /host_source_invalid/u);
    assert.throws(() => api.readOriginalPackagedCodesignSource(owned), /host_source_invalid/u);
    assert.equal(f.closes.length, attempts);
    for (const path of [SIMULATED_BACKEND, SIMULATED_CODESIGN]) {
      const slot = f.opens.find(open => open.path === path);
      assert.ok(slot); assert.equal(f.closeCount(slot.fd), 1);
    }
  });

  await t.test("simulated true-default bootstrap retains original verification failure alongside cleanup failure", async t => {
    const f = await createCodesignHostSimulation(t), bootstrap = await f.loadBootstrap();
    const closeFailure = errno("EIO", "default candidate cleanup unknown");
    f.hooks.close = slot => { if (slot.path === SIMULATED_CODESIGN) throw closeFailure; };
    let failure;
    try { bootstrap.readPackagedRestrictedCommandConfig(); } catch (error) { failure = error; }
    assert.ok(failure instanceof AggregateError); assert.equal(failure.message, "packaged_codesign_identity_close_unknown");
    assert.equal(failure.errors[0].message, "restricted_command_bundle_identity_invalid");
    assert.ok(failure.errors[1] instanceof AggregateError);
    assert.equal(failure.errors[1].errors[0], closeFailure);
    assert.equal(f.nativeCalls.length, 1); assert.equal(f.nativeCalls[0].command, SIMULATED_HELPER);
    assert.deepEqual(f.nativeCalls[0].args, ["--verify-packaged-codesign"]);
    t.diagnostic("Public default wiring is simulated here; the separate real Electron invocation remains required.");
  });

  await t.test("packaged flags and injected App layout do not turn a plain Node Host into a candidate", async t => {
    const f = await createCodesignHostSimulation(t, { electron: false }), api = await f.loadSource();
    assert.throws(() => api.prepareOriginalPackagedCodesignSource(), /host_source_invalid/u);
    assert.deepEqual(f.opens, []); assert.deepEqual(f.nativeCalls, []);
  });

  await t.test("custom dummy verification keeps its exact error without preparing or certifying an original Host", async t => {
    const f = await createCodesignHostSimulation(t, { electron: false }), bootstrap = await f.loadBootstrap();
    const failure = new Error("custom dummy verification"); let calls = 0;
    assert.throws(() => bootstrap.readPackagedRestrictedCommandConfig({
      executablePath: SIMULATED_EXECUTABLE, architecture: "arm64",
      environment: { LING_STACK_PACKAGED_DESKTOP: "1", ELECTRON_RUN_AS_NODE: "1" },
      verifyBundle(path) { calls++; assert.equal(path, SIMULATED_APP); throw failure; },
    }), error => error === failure);
    assert.equal(calls, 1); assert.deepEqual(f.opens, []); assert.deepEqual(f.nativeCalls, []);
  });

  await t.test("injected dummy resources use only the legacy controlled observer, never the original-source candidate", async t => {
    const f = await createCodesignHostSimulation(t, { electron: false }), bootstrap = await f.loadBootstrap();
    assert.throws(() => bootstrap.readPackagedRestrictedCommandConfig({
      executablePath: SIMULATED_EXECUTABLE, architecture: "arm64",
      environment: { LING_STACK_PACKAGED_DESKTOP: "1", ELECTRON_RUN_AS_NODE: "1" },
    }), /restricted_command_bundle_identity_invalid/u);
    assert.equal(f.nativeCalls.length, 1); assert.equal(f.nativeCalls[0].command, SIMULATED_CODESIGN);
    assert.deepEqual(f.nativeCalls[0].args, ["--verify", "--deep", "--strict", SIMULATED_APP]);
    assert.deepEqual(f.opens, [], "no original Host identity capability was prepared for injected resources");
  });

  t.diagnostic("All Host, FS, dyld digest and native-launch observations are simulations. No real Electron signature, kernel denial, trusted binary, registry certification, full manifest or descendant closure is established.");
});
