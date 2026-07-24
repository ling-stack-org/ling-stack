import assert from "node:assert/strict";
import test from "node:test";

import {
  CUA_DRIVER_ARTIFACT_LAYOUT,
  cuaDriverArtifactLayoutFor,
  cuaDriverArtifactPlatformForRuntime,
  normalizeCuaDriverArtifactPlatform,
} from "../shared/cua-driver-artifact-layout.mjs";

test("artifact layout separates upstream build names from Ling package names", () => {
  assert.deepEqual(CUA_DRIVER_ARTIFACT_LAYOUT, {
    darwin: {
      architecture: "arm64",
      packagedExecutableName: "ling-cua-driver",
      packagedExecutableRelativePath: "darwin/ling-cua-driver",
      platformDirectory: "darwin",
      providerSealRelativePath: "darwin/provider-seal.json",
      upstreamExecutableName: "cua-driver",
    },
    "win32-x64": {
      architecture: "x86_64",
      packagedExecutableName: "ling-cua-driver.exe",
      packagedExecutableRelativePath: "win32-x64/payload/ling-cua-driver.exe",
      platformDirectory: "win32-x64",
      providerSealRelativePath: "win32-x64/payload/provider-seal.json",
      upstreamExecutableName: "cua-driver.exe",
    },
  });
});

test("artifact layout maps runtime platforms and rejects unsupported values", () => {
  assert.equal(cuaDriverArtifactPlatformForRuntime("darwin"), "darwin");
  assert.equal(cuaDriverArtifactPlatformForRuntime("win32"), "win32-x64");
  assert.equal(cuaDriverArtifactLayoutFor("darwin").packagedExecutableName, "ling-cua-driver");
  assert.equal(normalizeCuaDriverArtifactPlatform("win32-x64"), "win32-x64");
  assert.throws(() => cuaDriverArtifactPlatformForRuntime("linux"), /unsupported_cua_driver_runtime_platform/);
  assert.throws(() => normalizeCuaDriverArtifactPlatform("win32"), /unsupported_cua_driver_artifact_platform/);
});
