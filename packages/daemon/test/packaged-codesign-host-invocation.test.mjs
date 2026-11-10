import assert from "node:assert/strict";
import test from "node:test";
import { createCodesignHostSimulation, errno, SIMULATED_APP, SIMULATED_BACKEND,
  SIMULATED_CODESIGN, SIMULATED_HELPER } from "./support/packaged-codesign-host-simulation-fixture.mjs";

const unsupportedBytes = () => Buffer.from("OBSERVER-ONLY genuinely unsupported dyld sentinel; never trusted OS bytes\n");
async function unsupportedError(f) {
  const review = await f.loadBootstrapReview(), backend = await f.loadBackend();
  let failure;
  try { review.readProtectedHostBootstrapReadRoots(backend.readMacosSandboxBackendIdentity()); }
  catch (error) { failure = error; }
  assert.ok(failure instanceof Error);
  assert.equal(failure.message, "protected_host_bootstrap_domain_unverified");
  return { review, failure };
}
function assertCandidateOnly(facts, review) {
  assert.equal(facts.protection, "candidate_unverified");
  assert.equal(facts.bootstrapReview, review);
  assert.equal(facts.registryEpoch, null);
  assert.equal(facts.appBundlePath, SIMULATED_APP);
}

// Sequential portable mechanism checks only: the fixture counterfeits Host/FS/
// profile inputs, never runs a process, and establishes no real protection fact.
// Keep the entire original 13-test source mechanism suite unchanged.
test("packaged codesign original invocation foundation simulation, never Host certification", async t => {
  await t.test("bootstrap reexports the exact original source singleton and backend Error class", async t => {
    const f = await createCodesignHostSimulation(t), api = await f.loadSource(), bootstrap = await f.loadBootstrap();
    const entry = api.readOriginalPackagedCodesignActorEntry();
    assert.equal(entry, api.readOriginalPackagedCodesignActorEntry());
    assert.equal(entry, bootstrap.PACKAGED_CODESIGN_ACTOR_ENTRY);
    assert.equal(Object.isFrozen(entry), true); assert.equal(entry.entryId, "packaged_codesign");
    const backend = await f.loadBackend(), native = await f.loadNativeCommand();
    assert.equal(native.MacosSandboxCommandError, backend.MacosSandboxCommandError);
    assert.equal(native.readMacosSandboxBackendIdentity, backend.readMacosSandboxBackendIdentity);
    assert.throws(() => bootstrap.readPackagedRestrictedCommandConfig(), /restricted_command_bundle_identity_invalid/u);
    assert.equal(f.nativeCalls.length, 1, "this exact fixture's original source observer must run");
    assert.equal(f.nativeCalls[0].command, SIMULATED_HELPER);
    assert.deepEqual(f.nativeCalls[0].args, ["--verify-packaged-codesign"]);
    assert.deepEqual(f.originalFiles(), []);
  });

  await t.test("copied source facts and cloned invocation records never enter the physical producer", async t => {
    const f = await createCodesignHostSimulation(t), api = await f.loadSource();
    const owned = api.prepareOriginalPackagedCodesignSource(), record = api.createOriginalPackagedCodesignInvocation(owned);
    const facts = api.readOriginalPackagedCodesignSource(owned), entry = api.readOriginalPackagedCodesignActorEntry();
    for (const clone of [{}, Object.freeze({ ...record }), Object.freeze({ ...facts })]) {
      assert.throws(() => entry.invoke(undefined, clone), /packaged_codesign_record_invalid/u);
    }
    assert.throws(() => api.createOriginalPackagedCodesignInvocation(Object.freeze({ ...owned })), /host_source_invalid/u);
    assertCandidateOnly(api.readOriginalPackagedCodesignSource(owned), "reviewed");
    assert.deepEqual(f.nativeCalls, []);
    api.closeOriginalPackagedCodesignIdentity(owned);
    assert.deepEqual(f.originalFiles(), []);
  });

  await t.test("another source module cannot borrow an original source or consume its invocation", async t => {
    const f = await createCodesignHostSimulation(t), api = await f.loadSource(), foreignApi = await f.loadIndependentSource();
    const owned = api.prepareOriginalPackagedCodesignSource(), foreign = foreignApi.prepareOriginalPackagedCodesignSource();
    const record = api.createOriginalPackagedCodesignInvocation(owned);
    assert.notEqual(api.readOriginalPackagedCodesignActorEntry(), foreignApi.readOriginalPackagedCodesignActorEntry());
    assert.throws(() => api.createOriginalPackagedCodesignInvocation(foreign), /host_source_invalid/u);
    assert.throws(() => foreignApi.createOriginalPackagedCodesignInvocation(owned), /host_source_invalid/u);
    assert.throws(() => foreignApi.readOriginalPackagedCodesignActorEntry().invoke(undefined, record), /record_invalid/u);
    assert.deepEqual(f.nativeCalls, []);
    assert.equal(api.readOriginalPackagedCodesignActorEntry().invoke(undefined, record).status, 1);
    assert.equal(f.nativeCalls.length, 1, "a foreign denial did not consume the actual original record");
    api.closeOriginalPackagedCodesignIdentity(owned); foreignApi.closeOriginalPackagedCodesignIdentity(foreign);
    assert.deepEqual(f.originalFiles(), []);
  });

  await t.test("nonzero native return and a second record cannot replay the consumed original source", async t => {
    const f = await createCodesignHostSimulation(t), api = await f.loadSource();
    const owned = api.prepareOriginalPackagedCodesignSource(), entry = api.readOriginalPackagedCodesignActorEntry();
    const first = api.createOriginalPackagedCodesignInvocation(owned), second = api.createOriginalPackagedCodesignInvocation(owned);
    const result = entry.invoke(undefined, first);
    assert.equal(result.status, 1); assert.equal(f.nativeCalls.length, 1);
    assert.throws(() => entry.invoke(undefined, first), /record_invalid/u);
    assert.throws(() => entry.invoke(undefined, second), /host_source_invalid/u);
    assert.throws(() => entry.invoke(undefined, second), /record_invalid/u);
    assert.throws(() => api.createOriginalPackagedCodesignInvocation(owned), /host_source_invalid/u);
    assert.equal(f.nativeCalls.length, 1);
    assertCandidateOnly(api.readOriginalPackagedCodesignSource(owned), "reviewed");
    api.closeOriginalPackagedCodesignIdentity(owned);
    assert.deepEqual(f.originalFiles(), []);
  });

  await t.test("a synchronous native failure preserves its exact Error and cannot be replayed", async t => {
    const f = await createCodesignHostSimulation(t), api = await f.loadSource();
    const owned = api.prepareOriginalPackagedCodesignSource(), record = api.createOriginalPackagedCodesignInvocation(owned);
    const failure = errno("EIO", "simulated actual producer throw");
    f.hooks.native = () => { throw failure; };
    const entry = api.readOriginalPackagedCodesignActorEntry();
    assert.throws(() => entry.invoke(undefined, record), error => error === failure);
    assert.equal(f.nativeCalls.length, 1);
    assert.throws(() => entry.invoke(undefined, record), /record_invalid/u);
    assert.throws(() => api.createOriginalPackagedCodesignInvocation(owned), /host_source_invalid/u);
    assert.equal(f.nativeCalls.length, 1);
    api.closeOriginalPackagedCodesignIdentity(owned);
    assert.deepEqual(f.originalFiles(), []);
  });

  await t.test("only an exact unsupported review permits an explicitly unreviewed candidate", async t => {
    const f = await createCodesignHostSimulation(t);
    f.dyld.bytes = unsupportedBytes();
    const api = await f.loadSource(), owned = api.prepareOriginalPackagedCodesignSource();
    const facts = api.readOriginalPackagedCodesignSource(owned);
    assertCandidateOnly(facts, "unsupported");
    api.consumeOriginalPackagedCodesignSource(owned);
    const native = api.enterOriginalPackagedCodesignSource(owned);
    assert.equal(native.executable, SIMULATED_HELPER);
    assert.deepEqual(native.argv, ["--verify-packaged-codesign"]);
    assert.equal(native.options.stdio, "pipe"); assert.equal(native.options.cwd, "/");
    assert.deepEqual(f.nativeCalls, [], "candidate preparation is not physical execution or certification");
    api.closeOriginalPackagedCodesignIdentity(owned);
    assert.deepEqual(f.originalFiles(), []);
  });

  await t.test("original unsupported Error provenance is single-use and cannot be copied from its text", async t => {
    const f = await createCodesignHostSimulation(t);
    f.dyld.bytes = unsupportedBytes();
    const { review, failure } = await unsupportedError(f);
    assert.equal(review.consumeProtectedHostBootstrapReviewUnsupported(new Error(failure.message)), false);
    assert.equal(review.consumeProtectedHostBootstrapReviewUnsupported({ message: failure.message }), false);
    assert.equal(review.consumeProtectedHostBootstrapReviewUnsupported(failure), true);
    assert.equal(review.consumeProtectedHostBootstrapReviewUnsupported(failure), false);
    assert.deepEqual(f.originalFiles(), []); assert.deepEqual(f.nativeCalls, []);
  });

  await t.test("unsupported profile bytes do not mask an invalid OS-owned dyld identity", async t => {
    const f = await createCodesignHostSimulation(t);
    f.dyld.bytes = unsupportedBytes(); f.dyld.uid = 501;
    const api = await f.loadSource();
    assert.throws(() => api.prepareOriginalPackagedCodesignSource(), { code: "macos_system_identity_invalid" });
    assert.deepEqual(f.originalFiles(), []); assert.deepEqual(f.nativeCalls, []);
  });

  await t.test("an original dyld read failure cannot use unsupported candidate fallback", async t => {
    const f = await createCodesignHostSimulation(t);
    f.dyld.bytes = unsupportedBytes();
    const failure = errno("EIO", "original dyld read failed"), api = await f.loadSource();
    f.hooks.read = slot => { if (slot.path === f.dyld.path) throw failure; };
    assert.throws(() => api.prepareOriginalPackagedCodesignSource(), error => error === failure);
    const slots = f.opens.filter(slot => slot.path === f.dyld.path);
    assert.equal(slots.length, 1); assert.equal(f.closeCount(slots[0].fd), 1);
    assert.deepEqual(f.originalFiles(), []); assert.deepEqual(f.nativeCalls, []);
  });

  await t.test("an original dyld FD close failure has no fallback or repeated integer close", async t => {
    const f = await createCodesignHostSimulation(t);
    f.dyld.bytes = unsupportedBytes();
    const failure = errno("EIO", "original dyld close unknown"), api = await f.loadSource();
    f.hooks.close = slot => { if (slot.path === f.dyld.path) throw failure; };
    assert.throws(() => api.prepareOriginalPackagedCodesignSource(), error => error === failure);
    const slots = f.opens.filter(slot => slot.path === f.dyld.path);
    assert.equal(slots.length, 1); assert.equal(f.closeCount(slots[0].fd), 1);
    assert.equal(f.descriptors.has(slots[0].fd), true, "unknown original close remains observable, never retried or retired");
    assert.deepEqual(f.originalFiles().map(slot => slot.path), [f.dyld.path]);
    assert.deepEqual(f.nativeCalls, []);
  });

  for (const stage of ["identity", "read", "close"]) {
    await t.test("reusing the same genuine unsupported Error in " + stage + " cannot retain old fallback provenance", async t => {
      const f = await createCodesignHostSimulation(t);
      f.dyld.bytes = unsupportedBytes();
      const { review, failure } = await unsupportedError(f), api = await f.loadSource();
      const hook = stage === "identity" ? "stat" : stage;
      f.hooks[hook] = slot => { if (slot.path === f.dyld.path) throw failure; };
      assert.throws(() => api.prepareOriginalPackagedCodesignSource(), error => error === failure);
      assert.equal(review.consumeProtectedHostBootstrapReviewUnsupported(failure), false,
        "the current failing original read/identity/close must revoke this same Error's prior marker");
      const slots = f.opens.filter(slot => slot.path === f.dyld.path), failedSlot = slots.at(-1);
      assert.equal(slots.length, 2);
      assert.equal(f.closeCount(failedSlot.fd), 1);
      assert.deepEqual(f.nativeCalls, []);
      if (stage === "close") {
        assert.equal(f.descriptors.has(failedSlot.fd), true);
        assert.deepEqual(f.originalFiles().map(slot => slot.path), [f.dyld.path]);
      } else assert.deepEqual(f.originalFiles(), []);
    });
  }
  t.diagnostic("All inputs, native outcomes and dyld bytes are virtual mechanism observations. No Host certificate, trusted source manifest, real OS profile support, signature success or kernel containment is issued.");
});
