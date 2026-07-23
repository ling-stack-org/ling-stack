import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CuaDriverPackagedAuthorityError,
  loadDesktopCuaDriverPackageAuthority,
  packagedProviderIntentCapabilities,
} from "../dist/main/cua-driver/packaged-authority.js";
import {
  resolveDesktopCuaDriverPackagedStartupAuthority,
} from "../dist/main/cua-driver/packaged-startup.js";
import {
  CUA_DRIVER_DISTRIBUTION_REVISION,
  CUA_DRIVER_RESOURCE_ROOT_SEGMENTS,
} from "../dist/main/cua-driver/resource-path.js";
import {
  CUA_DRIVER_STATE_DISTRIBUTION_ID,
  resolveCuaDriverStateRootPath,
} from "../dist/main/cua-driver/state-root.js";

const PACKAGE_AUTHORITY_KEY = "lingCuaDriverPackageAuthority";
const WIN32_AUTHORITY = Object.freeze({
  schemaVersion: 1,
  componentId: "cua-driver",
  distributionRevision: "0.8.3-ling.1",
  providerExpected: true,
  platform: "win32",
  signingTier: "test_signed_internal",
  distributionChannel: "internal",
  capabilitiesSha256: "a".repeat(64),
  runtimeTrustPolicySha256: "b".repeat(64),
});

test("packaged app metadata loads a valid provider authority and keeps every runtime path on one revision", async () => {
  const appPath = await createPackagedApp({ [PACKAGE_AUTHORITY_KEY]: WIN32_AUTHORITY });
  try {
    const authority = await loadDesktopCuaDriverPackageAuthority(appPath);
    assert.deepEqual(authority, WIN32_AUTHORITY);
    assert.equal(Object.isFrozen(authority), true);
    assert.deepEqual(packagedProviderIntentCapabilities(authority), {
      schemaVersion: 1,
      resourcesValidated: true,
      darwin: false,
      win32: true,
    });

    assert.equal(authority.distributionRevision, "0.8.3-ling.1");
    assert.equal(CUA_DRIVER_DISTRIBUTION_REVISION, authority.distributionRevision);
    assert.equal(CUA_DRIVER_STATE_DISTRIBUTION_ID, authority.distributionRevision);
    assert.equal(CUA_DRIVER_RESOURCE_ROOT_SEGMENTS.at(-1), authority.distributionRevision);
    assert.equal(
      resolveCuaDriverStateRootPath(join(appPath, "user-data")).split(/[\\/]/u).at(-1),
      authority.distributionRevision,
    );
  } finally {
    await rm(appPath, { recursive: true, force: true });
  }
});

test("legacy packaged app metadata without an authority remains external-only", async () => {
  const appPath = await createPackagedApp({ name: "legacy-ling-desktop" });
  try {
    assert.deepEqual(await loadDesktopCuaDriverPackageAuthority(appPath), {
      schemaVersion: 1,
      componentId: "cua-driver",
      distributionRevision: "0.8.3-ling.1",
      providerExpected: false,
    });
  } finally {
    await rm(appPath, { recursive: true, force: true });
  }
});

test("malformed JSON and invalid authority schemas fail closed", async (t) => {
  const scenarios = [
    {
      name: "malformed JSON",
      packageBytes: "{",
      authorityCode: "json_invalid",
    },
    {
      name: "invalid authority schema",
      packageBytes: JSON.stringify({
        [PACKAGE_AUTHORITY_KEY]: { ...WIN32_AUTHORITY, unexpected: true },
      }),
      authorityCode: "schema_invalid",
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const appPath = await createPackagedAppBytes(scenario.packageBytes);
      try {
        await assert.rejects(
          loadDesktopCuaDriverPackageAuthority(appPath),
          (error) => error instanceof CuaDriverPackagedAuthorityError
            && error.authorityCode === scenario.authorityCode,
        );
      } finally {
        await rm(appPath, { recursive: true, force: true });
      }
    });
  }
});

test("packaged authority rejects invalid paths, missing metadata, non-objects, and oversized bytes", async () => {
  await assert.rejects(
    loadDesktopCuaDriverPackageAuthority("relative/app"),
    (error) => error instanceof CuaDriverPackagedAuthorityError
      && error.authorityCode === "path_invalid",
  );

  const appPath = await mkdtemp(join(tmpdir(), "ling-cua-packaged-authority-invalid-"));
  try {
    await assert.rejects(
      loadDesktopCuaDriverPackageAuthority(appPath),
      (error) => error instanceof CuaDriverPackagedAuthorityError
        && error.authorityCode === "unavailable",
    );
    await mkdir(join(appPath, "package.json"));
    await assert.rejects(
      loadDesktopCuaDriverPackageAuthority(appPath),
      (error) => error instanceof CuaDriverPackagedAuthorityError
        && error.authorityCode === "path_invalid",
    );
    await rm(join(appPath, "package.json"), { recursive: true, force: true });
    await writeFile(join(appPath, "package.json"), "[]", "utf8");
    await assert.rejects(
      loadDesktopCuaDriverPackageAuthority(appPath),
      (error) => error instanceof CuaDriverPackagedAuthorityError
        && error.authorityCode === "schema_invalid",
    );
    await writeFile(join(appPath, "package.json"), "x".repeat(1024 * 1024 + 1), "utf8");
    await assert.rejects(
      loadDesktopCuaDriverPackageAuthority(appPath),
      (error) => error instanceof CuaDriverPackagedAuthorityError
        && error.authorityCode === "oversized",
    );
  } finally {
    await rm(appPath, { recursive: true, force: true });
  }
});

test("a Win32 packaged intent on Darwin stays bundled-authoritative but cannot start", async () => {
  const appPath = await createPackagedApp({ [PACKAGE_AUTHORITY_KEY]: WIN32_AUTHORITY });
  try {
    const startup = await resolveDesktopCuaDriverPackagedStartupAuthority(
      {
        packaged: true,
        appPath,
        resourcesPath: join(appPath, "resources"),
        platform: "darwin",
      },
      {
        async loadCapabilities() {
          assert.fail("cross-platform package intent must fail before reading loose capabilities");
        },
        async loadPolicy() {
          assert.fail("cross-platform package intent must fail before reading loose policy");
        },
      },
    );

    assert.equal(startup.runtimeEligible, false);
    assert.equal(startup.authority?.platform, "win32");
    assert.match(String(startup.failure), /cua_driver_package_authority_platform_mismatch/u);
    assert.deepEqual(startup.featureFlags.packagedProvider, { darwin: true, win32: false });
    assert.deepEqual(startup.featureFlags.bundledEmbedded, { darwin: true, win32: false });
  } finally {
    await rm(appPath, { recursive: true, force: true });
  }
});

async function createPackagedApp(packageJson) {
  return createPackagedAppBytes(`${JSON.stringify(packageJson)}\n`);
}

async function createPackagedAppBytes(packageBytes) {
  const appPath = await mkdtemp(join(tmpdir(), "ling-cua-packaged-authority-"));
  await writeFile(join(appPath, "package.json"), packageBytes, "utf8");
  return appPath;
}
