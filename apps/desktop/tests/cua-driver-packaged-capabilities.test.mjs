import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CUA_DRIVER_PACKAGED_CAPABILITIES_RESOURCE_SEGMENTS,
  CuaDriverPackagedCapabilitiesError,
  loadDesktopCuaDriverPackagedProviderCapabilities,
  validateDesktopCuaDriverPackagedProviderCapabilities,
} from "../dist/main/cua-driver/packaged-capabilities.js";

test("packaged capability validation enables exactly one governed platform", () => {
  assert.deepEqual(validateDesktopCuaDriverPackagedProviderCapabilities(capabilities("darwin")), {
    schemaVersion: 1,
    resourcesValidated: true,
    darwin: true,
    win32: false,
  });
  assert.deepEqual(validateDesktopCuaDriverPackagedProviderCapabilities(capabilities("win32")), {
    schemaVersion: 1,
    resourcesValidated: true,
    darwin: false,
    win32: true,
  });
  for (const value of [
    null,
    { ...capabilities("darwin"), schemaVersion: 2 },
    { ...capabilities("darwin"), distributionRevision: "0.8.3" },
    { ...capabilities("darwin"), resourcesValidated: false },
    { ...capabilities("darwin"), win32: true },
    { ...capabilities("darwin"), darwin: false },
    { ...capabilities("darwin"), unexpected: true },
  ]) {
    assert.throws(
      () => validateDesktopCuaDriverPackagedProviderCapabilities(value),
      schemaFailure,
    );
  }
});

test("missing packaged capability stays external-only while valid bytes enable one platform", async () => {
  const root = await mkdtemp(join(tmpdir(), "ling-cua-packaged-capabilities-"));
  try {
    assert.deepEqual(await loadDesktopCuaDriverPackagedProviderCapabilities(root), {
      schemaVersion: 1,
      resourcesValidated: true,
      darwin: false,
      win32: false,
    });
    const path = join(root, ...CUA_DRIVER_PACKAGED_CAPABILITIES_RESOURCE_SEGMENTS);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, `${JSON.stringify(capabilities("darwin"))}\n`, "utf8");
    assert.equal((await loadDesktopCuaDriverPackagedProviderCapabilities(root)).darwin, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("packaged capability loader rejects relative, symlinked, malformed, and oversized input", async () => {
  await assert.rejects(
    loadDesktopCuaDriverPackagedProviderCapabilities("relative"),
    (error) => error instanceof CuaDriverPackagedCapabilitiesError
      && error.capabilitiesCode === "path_invalid",
  );
  const root = await mkdtemp(join(tmpdir(), "ling-cua-packaged-capabilities-invalid-"));
  try {
    const path = join(root, ...CUA_DRIVER_PACKAGED_CAPABILITIES_RESOURCE_SEGMENTS);
    const target = join(root, "target.json");
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(target, `${JSON.stringify(capabilities("darwin"))}\n`, "utf8");
    await symlink(target, path);
    await assert.rejects(
      loadDesktopCuaDriverPackagedProviderCapabilities(root),
      (error) => error instanceof CuaDriverPackagedCapabilitiesError
        && error.capabilitiesCode === "path_invalid",
    );
    await rm(path);
    await writeFile(path, "{", "utf8");
    await assert.rejects(
      loadDesktopCuaDriverPackagedProviderCapabilities(root),
      (error) => error instanceof CuaDriverPackagedCapabilitiesError
        && error.capabilitiesCode === "json_invalid",
    );
    await writeFile(path, "x".repeat(16 * 1024 + 1), "utf8");
    await assert.rejects(
      loadDesktopCuaDriverPackagedProviderCapabilities(root),
      (error) => error instanceof CuaDriverPackagedCapabilitiesError
        && error.capabilitiesCode === "oversized",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("signed authority requires exact capability bytes and platform", async () => {
  const root = await mkdtemp(join(tmpdir(), "ling-cua-packaged-capabilities-authority-"));
  try {
    const path = join(root, ...CUA_DRIVER_PACKAGED_CAPABILITIES_RESOURCE_SEGMENTS);
    await mkdir(join(path, ".."), { recursive: true });
    const bytes = `${JSON.stringify(capabilities("darwin"))}\n`;
    const authority = {
      schemaVersion: 1,
      componentId: "cua-driver",
      distributionRevision: "0.8.3-ling.1",
      providerExpected: true,
      platform: "darwin",
      signingTier: "test_signed_internal",
      distributionChannel: "internal",
      capabilitiesSha256: createHash("sha256").update(bytes).digest("hex"),
      runtimeTrustPolicySha256: "b".repeat(64),
    };

    await assert.rejects(
      loadDesktopCuaDriverPackagedProviderCapabilities(root, { authority }),
      (error) => error instanceof CuaDriverPackagedCapabilitiesError
        && error.capabilitiesCode === "unavailable",
    );
    await writeFile(path, bytes, "utf8");
    assert.equal(
      (await loadDesktopCuaDriverPackagedProviderCapabilities(root, { authority })).darwin,
      true,
    );
    await assert.rejects(
      loadDesktopCuaDriverPackagedProviderCapabilities(root, {
        authority: { ...authority, capabilitiesSha256: "c".repeat(64) },
      }),
      (error) => error instanceof CuaDriverPackagedCapabilitiesError
        && error.capabilitiesCode === "digest_mismatch",
    );
    await assert.rejects(
      loadDesktopCuaDriverPackagedProviderCapabilities(root, {
        authority: { ...authority, platform: "win32" },
      }),
      (error) => error instanceof CuaDriverPackagedCapabilitiesError
        && error.capabilitiesCode === "platform_mismatch",
    );
    assert.deepEqual(
      await loadDesktopCuaDriverPackagedProviderCapabilities(root, {
        authority: {
          schemaVersion: 1,
          componentId: "cua-driver",
          distributionRevision: "0.8.3-ling.1",
          providerExpected: false,
        },
      }),
      { schemaVersion: 1, resourcesValidated: true, darwin: false, win32: false },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function capabilities(platform) {
  return {
    schemaVersion: 1,
    componentId: "cua-driver",
    distributionRevision: "0.8.3-ling.1",
    resourcesValidated: true,
    darwin: platform === "darwin",
    win32: platform === "win32",
  };
}

function schemaFailure(error) {
  return error instanceof CuaDriverPackagedCapabilitiesError
    && error.capabilitiesCode === "schema_invalid";
}
