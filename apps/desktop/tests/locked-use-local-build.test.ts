import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  lockedUseLocalBuilderConfig,
  validateLocalAuthority,
  verifyPackagedLockedUseLocalMetadata,
} from "../scripts/locked-use-local-build.ts";
import {
  LOCKED_USE_LOCAL_AUTHORITY_METADATA_KEY,
  loadPackagedLocalDarwinLockedUseBackend,
} from "../dist/main/locked-computer-control/packaged-release-authority.js";

const team = "ABCDE12345";
const manifestSha256 = "a".repeat(64);

function authority(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    platform: "darwin",
    profile: "local_development",
    nativeAcceptance: "local_development",
    expectedTeamId: team,
    expectedBuildManifestSha256: manifestSha256,
    ...overrides,
  };
}

function bytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`);
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

test("local authority is a separate Apple Development package lane", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ling-locked-use-local-build-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const authorityBytes = bytes(authority());
  await writeFile(join(root, "local-authority.json"), authorityBytes, "utf8");

  assert.deepEqual(validateLocalAuthority(authorityBytes), { team, manifestSha256 });
  assert.deepEqual(await lockedUseLocalBuilderConfig({
    localRoot: root,
    signingTier: "test_signed_internal",
    providerExpected: true,
  }), {
    extraMetadata: { [LOCKED_USE_LOCAL_AUTHORITY_METADATA_KEY]: sha256(authorityBytes) },
    extraResources: [{ from: join(root, "local-authority.json"), to: "locked-use/local-authority.json" }],
  });

  for (const input of [
    { signingTier: "unsigned_dev", providerExpected: true },
    { signingTier: "production_signed", providerExpected: true },
    { signingTier: "test_signed_internal", providerExpected: false },
    { signingTier: "test_signed_internal", providerExpected: true, releaseRoot: root },
    { signingTier: "test_signed_internal", providerExpected: true, validationRoot: root },
  ]) {
    await assert.rejects(lockedUseLocalBuilderConfig({ localRoot: root, ...input }), /internal_provider_package/u);
  }

  verifyPackagedLockedUseLocalMetadata({
    metadata: { [LOCKED_USE_LOCAL_AUTHORITY_METADATA_KEY]: sha256(authorityBytes) },
    authorityBytes,
  });
  assert.throws(() => verifyPackagedLockedUseLocalMetadata({
    metadata: {
      [LOCKED_USE_LOCAL_AUTHORITY_METADATA_KEY]: sha256(authorityBytes),
      lingLockedUseReleaseAuthoritySha256: "b".repeat(64),
    },
    authorityBytes,
  }), /packaged_local_mismatch/u);
});

test("packaged local authority pins the local profile and never loads the release lane", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ling-locked-use-local-authority-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "locked-use"), { recursive: true });
  await mkdir(join(root, "app.asar"), { recursive: true });
  const authorityBytes = bytes(authority());
  await writeFile(join(root, "locked-use/local-authority.json"), authorityBytes);
  await writeFile(join(root, "app.asar/package.json"), JSON.stringify({
    [LOCKED_USE_LOCAL_AUTHORITY_METADATA_KEY]: sha256(authorityBytes),
  }));
  let loaded = false;
  const backend = await loadPackagedLocalDarwinLockedUseBackend({
    packaged: true, platform: "darwin", appPath: join(root, "app.asar"), resourcesRoot: root,
  }, {
    async loadBackend(input) {
      loaded = true;
      assert.deepEqual(input, {
        expectedTeamId: team,
        expectedBuildManifestSha256: manifestSha256,
        expectedProfile: "local_development",
      });
      return undefined;
    },
  });
  assert.equal(backend, undefined);
  assert.equal(loaded, true);

  await writeFile(join(root, "locked-use/local-authority.json"), bytes(authority({ profile: "local_identity" })));
  loaded = false;
  assert.equal(await loadPackagedLocalDarwinLockedUseBackend({
    packaged: true, platform: "darwin", appPath: join(root, "app.asar"), resourcesRoot: root,
  }, { loadBackend: async () => { loaded = true; return undefined; } }), undefined);
  assert.equal(loaded, false);
});

test("electron builder composes local authority only with the internal Apple Development lane", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ling-locked-use-local-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const authorityBytes = bytes(authority());
  await writeFile(join(root, "local-authority.json"), authorityBytes);
  const packageAuthority = {
    schemaVersion: 1,
    componentId: "cua-driver",
    distributionRevision: "0.8.3-ling.1",
    providerExpected: true,
    platform: "darwin",
    signingTier: "test_signed_internal",
    distributionChannel: "internal",
    capabilitiesSha256: "b".repeat(64),
    runtimeTrustPolicySha256: "c".repeat(64),
  };
  const module = new URL("../scripts/cua-driver-electron-builder.config.mjs", import.meta.url).href;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import config from ${JSON.stringify(module)};
    process.stdout.write(JSON.stringify({ extraMetadata: config.extraMetadata, extraResources: config.extraResources, mac: config.mac }));
  `], {
    encoding: "utf8",
    env: {
      ...process.env,
      LING_CUA_DRIVER_PACKAGE_PROVIDER: "1",
      LING_CUA_PACKAGE_RESOURCES_ROOT: root,
      LING_CUA_PACKAGE_HOST_AUTHORITY_JSON: JSON.stringify(packageAuthority),
      LING_CUA_SIGNING_TIER: "test_signed_internal",
      LING_CUA_DISTRIBUTION_CHANNEL: "internal",
      LING_CUA_DARWIN_EXPECTED_TEAM_ID: team,
      LING_LOCKED_USE_LOCAL_ROOT: root,
      LING_CUA_DARWIN_SIGNING_IDENTITY: "Apple Development: Fixture (ABCDE12345)",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(result.stdout);
  assert.equal(config.extraMetadata[LOCKED_USE_LOCAL_AUTHORITY_METADATA_KEY], sha256(authorityBytes));
  assert.ok(config.extraResources.some((resource: { to: string }) => resource.to === "locked-use/local-authority.json"));
  assert.equal(config.extraMetadata.lingLockedUseReleaseAuthoritySha256, undefined);
  assert.equal(config.mac.identity, "Apple Development: Fixture (ABCDE12345)");
  assert.equal(config.mac.type, "development");
  assert.equal(config.mac.hardenedRuntime, true);
});
