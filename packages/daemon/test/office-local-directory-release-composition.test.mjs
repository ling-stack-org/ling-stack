import assert from "node:assert/strict";
import test from "node:test";
import * as composition from "../dist/features/office-documents/office-local-directory-core-authority.js";
import { releaseOriginalOfficeDirectoryRuntimeLeaseV2 } from "../dist/features/office-documents/office-local-native-runtime.js";

test("original composition never exposes the authority's raw runtime custody", () => {
  assert.deepEqual(Object.keys(composition).sort(), [
    "captureOriginalOfficeDirectoryAuthorityV2",
    "createOriginalOfficeDirectoryStoreFactory",
    "releaseOriginalOfficeDirectoryLeaseV2",
  ]);
  assert.equal(Object.hasOwn(composition, "readOriginalOfficeDirectoryAuthorityCustodyForReleaseV2"), false);
});

test("authority clones, getters and proxies cannot enter the private release composition", () => {
  let reads = 0;
  const bait = Object.create(null);
  for (const key of ["store", "runtime", "runtimeCustody", "executionId", "closed", "safe"]) {
    Object.defineProperty(bait, key, { get() { reads++; throw new Error("caller_custody_read"); } });
  }
  const opaque = Object.freeze({});
  for (const authority of [null, undefined, false, opaque, { ...opaque }, bait, new Proxy(bait, {
    get() { reads++; throw new Error("caller_authority_read"); },
    getOwnPropertyDescriptor() { reads++; throw new Error("caller_authority_descriptor_read"); },
  })]) {
    assert.throws(() => composition.releaseOriginalOfficeDirectoryLeaseV2(authority, opaque, opaque),
      /office_local_directory_core_composition_invalid/u);
  }
  assert.equal(reads, 0);
});

test("a public noop runtime or serialized custody cannot substitute a constructor-private release reader", () => {
  const opaque = Object.freeze({});
  let calls = 0;
  const counterfeit = { releaseLease() { calls++; }, assertClosedBoundWindow() { calls++; } };
  for (const runtime of [opaque, counterfeit, new Proxy(counterfeit, {
    get() { calls++; throw new Error("caller_runtime_read"); },
  })]) {
    assert.throws(() => releaseOriginalOfficeDirectoryRuntimeLeaseV2(runtime, opaque, opaque, opaque, opaque),
      /office_local_native_lease_release_custody_invalid/u);
  }
  assert.equal(calls, 0);
});
