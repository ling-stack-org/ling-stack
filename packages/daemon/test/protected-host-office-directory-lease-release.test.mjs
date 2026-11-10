import assert from "node:assert/strict";
import test from "node:test";
import {
  ProtectedHostStageRegistry,
  assertOriginalProtectedHostOfficeDirectoryLeaseReleasedV2,
  releaseOriginalProtectedHostOfficeDirectoryLeaseV2,
} from "../dist/runtime/sandbox/protected-host-staging.js";

// Portable refusals only: no Store, native addon, original window, permit mint
// or test-only registration seam. Owning conformance covers genuine release.
const releaseEntries = [releaseOriginalProtectedHostOfficeDirectoryLeaseV2,
  assertOriginalProtectedHostOfficeDirectoryLeaseReleasedV2];
const permitDenied = /office_local_native_lease_release_permit_invalid/u;
const registryDenied = /protected_host_registry_invalid/u;

test("fixed Registry lease entries accept only an original opaque Runtime permit", () => {
  const registry = new ProtectedHostStageRegistry();
  const counterfeit = { registry, window: Object.freeze({}), registration: Object.freeze({}),
    execution: Object.freeze({}), historyOnly: true, closed: true, committed: true };
  const values = [undefined, null, false, true, 0, "closed", Object.freeze({}), {},
    counterfeit, Object.freeze({ ...counterfeit }), Object.create(counterfeit), new Proxy(counterfeit, {})];
  for (const entry of releaseEntries) {
    assert.equal(entry.length, 2, "release authority must not expose a window DTO, proof callback or boolean argument");
    for (const permit of values) {
      assert.throws(() => entry(registry, permit), permitDenied);
    }
  }
});

test("forged permits are rejected by identity without consulting DTO getters or Proxy traps", () => {
  const registry = new ProtectedHostStageRegistry();
  let reads = 0, proofCalls = 0;
  const poisonous = new Proxy({}, {
    get() { reads++; assert.fail("must not read a caller permit field"); },
    ownKeys() { reads++; assert.fail("must not enumerate a caller permit"); },
    getPrototypeOf() { reads++; assert.fail("must not inspect a caller permit prototype"); },
    getOwnPropertyDescriptor() { reads++; assert.fail("must not inspect caller permit descriptors"); },
  });
  const getters = Object.defineProperties({}, Object.fromEntries(
    ["registry", "window", "registration", "execution", "historyOnly"].map(key => [key,
      { get() { reads++; assert.fail("must not read a caller permit getter"); } }])));
  const proof = () => { proofCalls++; return true; };
  for (const entry of releaseEntries) {
    for (const permit of [poisonous, getters]) {
      assert.throws(() => entry(registry, permit, poisonous, proof, true), permitDenied);
    }
  }
  assert.deepEqual([reads, proofCalls], [0, 0]);
});

test("fake, copied and Proxy Registries cannot supply a fixed lease reader", () => {
  const registry = new ProtectedHostStageRegistry();
  let publicCalls = 0, permitReads = 0;
  const fake = Object.freeze({ releaseLease() { publicCalls++; }, assertLeaseReleased() { publicCalls++; } });
  const poisonous = new Proxy({}, { get() { permitReads++; assert.fail("invalid Registry must fail before permit reads"); } });
  for (const owner of [fake, Object.freeze({ ...registry }), Object.create(registry),
    Object.create(ProtectedHostStageRegistry.prototype), new Proxy(registry, {})]) {
    for (const entry of releaseEntries) assert.throws(() => entry(owner, poisonous), registryDenied);
  }
  assert.deepEqual([publicCalls, permitReads], [0, 0]);
});

test("public close and inventory no-ops cannot mint release authority or historical success", () => {
  const registry = new ProtectedHostStageRegistry(), registration = Object.freeze({});
  let closeCalls = 0, publicProofCalls = 0;
  registry.closeStage = () => { closeCalls++; };
  registry.assertActorInventoryCurrent = () => { publicProofCalls++; };
  registry.assertHostStageSourceCurrent = () => { publicProofCalls++; };
  registry.closeStage(registration);
  const permit = Object.freeze({ registry, registration, closed: true, historyOnly: true });
  for (const entry of releaseEntries) assert.throws(() => entry(registry, permit), permitDenied);
  assert.deepEqual([closeCalls, publicProofCalls], [1, 0]);
});
