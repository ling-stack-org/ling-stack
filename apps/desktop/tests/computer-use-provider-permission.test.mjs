import assert from "node:assert/strict";
import test from "node:test";
import { resolveWindowsProviderPermissionState } from "../dist/main/computer-use/provider-permission.js";

test("Windows permission preflight is bound to an exact provider HWND and pid", async () => {
  const input = { descriptorId: "windows-provider-1", revision: 3 };
  assert.equal(
    await resolveWindowsProviderPermissionState(resolverFor({
      descriptorId: input.descriptorId,
      revision: input.revision,
      platform: "windows",
      sourceKind: "window",
      target: { processId: 4321, nativeWindowId: "7788" },
      authorization: validAuthorization(),
    }), input),
    "granted",
  );

  for (const descriptor of [
    {
      descriptorId: input.descriptorId,
      revision: input.revision,
      platform: "macos",
      sourceKind: "window",
      target: { processId: 4321, nativeWindowId: "7788" },
      authorization: validAuthorization(),
    },
    {
      descriptorId: input.descriptorId,
      revision: input.revision,
      platform: "windows",
      sourceKind: "window",
      target: { nativeWindowId: "7788" },
      authorization: validAuthorization(),
    },
  ]) {
    assert.equal(await resolveWindowsProviderPermissionState(resolverFor(descriptor), input), "denied");
  }
});

test("Windows permission preflight fails closed on stale or unavailable provider descriptors", async () => {
  const input = { descriptorId: "windows-provider-1", revision: 3 };
  assert.equal(
    await resolveWindowsProviderPermissionState({
      async resolve() {
        throw new Error("computer_use_descriptor_not_found");
      },
    }, input),
    "denied",
  );
});

function resolverFor(descriptor) {
  return {
    async resolve(descriptorId, revision) {
      assert.equal(descriptorId, descriptor.descriptorId);
      assert.equal(revision, descriptor.revision);
      return descriptor;
    },
  };
}

function validAuthorization() {
  return { grantId: "provider-grant-1", expiresAt: "2099-01-01T00:00:00.000Z" };
}
