import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  prepareCuaDriverElectronPackage,
  runCuaDriverElectronPackageCli,
  spawnElectronBuilder,
} from "../scripts/cua-driver-electron-package.mjs";

const execFileAsync = promisify(execFile);
const desktopRoot = resolve(import.meta.dirname, "..");
const repositoryRoot = resolve(desktopRoot, "../..");
const configModule = "./scripts/cua-driver-electron-builder.config.mjs";
const HOST_AUTHORITY = Object.freeze({
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

test("repository declares a package.json workspace root for Electron Builder fallback detection", async () => {
  const rootPackage = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
  assert.deepEqual(rootPackage.workspaces, ["apps/*", "packages/*"]);
});

test("Builder CLI starts without a PATH shim or shell in a directory with spaces", async () => {
  const appRoot = await mkdtemp(join(tmpdir(), "ling-builder cli path-"));
  try {
    assert.equal(await spawnElectronBuilder({
      appRoot,
      args: ["--version"],
      environment: { ...process.env, PATH: "" },
    }), 0);
  } finally {
    await rm(appRoot, { recursive: true, force: true });
  }
});

test("Electron Builder config keeps external-only provider authority unchanged by default", async () => {
  const desktopPackage = JSON.parse(await readFile(join(desktopRoot, "package.json"), "utf8"));
  const config = await inspectConfig({
    LING_CUA_DRIVER_PACKAGE_PROVIDER: "0",
  });
  assert.deepEqual(config.extraResources, desktopPackage.build.extraResources);
  assert.equal(config.extraResources.some((resource) => resource.to === "providers/cua-driver"), false);
  assert.equal(config.extraResources.some((resource) => resource.from === "dist/distribution" && resource.to === "distribution"), true);
  assert.equal(config.extraResources.some((resource) => resource.to === "browser-extension/ling-for-chrome.zip"), true);
  assert.equal(config.extraResources.some((resource) => resource.to === "office-driver"), true);
  assert.equal(config.extraResources.some((resource) => resource.to === "browser-host"), true);
  assert.equal(config.macIdentity, "-");
  assert.equal(config.macSign, null);
  assert.equal(config.winSign, null);
  assert.equal(config.asar, true);
  assert.equal(config.electronFuses.enableEmbeddedAsarIntegrityValidation, true);
  assert.equal(config.electronFuses.onlyLoadAppFromAsar, true);
  assert.equal(config.packageAuthority.providerExpected, false);
});

test("Electron Builder config appends one private provider root and governed signing callbacks", async () => {
  const desktopPackage = JSON.parse(await readFile(join(desktopRoot, "package.json"), "utf8"));
  const packageRoot = resolve(tmpdir(), "ling-cua-config-provider-root");
  const config = await inspectConfig({
    LING_CUA_DRIVER_PACKAGE_PROVIDER: "1",
    LING_CUA_PACKAGE_RESOURCES_ROOT: packageRoot,
    LING_CUA_PACKAGE_HOST_AUTHORITY_JSON: JSON.stringify(HOST_AUTHORITY),
    LING_CUA_SIGNING_TIER: "test_signed_internal",
    LING_CUA_DISTRIBUTION_CHANNEL: "internal",
  });
  assert.deepEqual(config.extraResources, [
    ...desktopPackage.build.extraResources,
    { from: packageRoot, to: "providers/cua-driver" },
  ]);
  assert.equal(config.macSign, "./scripts/cua-driver-signing/electron-builder-mac-sign.mjs");
  assert.equal(config.macHardenedRuntime, true);
  assert.equal(config.winSign, "./scripts/cua-driver-signing/electron-builder-win-sign.mjs");
  assert.equal(config.winSignExts.length, 2);
  assert.deepEqual(config.packageAuthority, HOST_AUTHORITY);
});

test("Electron Builder config refuses a provider root without package authority", async () => {
  await assert.rejects(
    inspectConfig({
      LING_CUA_DRIVER_PACKAGE_PROVIDER: "0",
      LING_CUA_PACKAGE_RESOURCES_ROOT: resolve(tmpdir(), "untrusted-provider-root"),
    }),
    /cua_driver_package_resources_without_authority/,
  );
});

test("Electron Builder config requires an absolute root and signed-host authority", async () => {
  for (const overrides of [
    {
      LING_CUA_DRIVER_PACKAGE_PROVIDER: "1",
      LING_CUA_PACKAGE_HOST_AUTHORITY_JSON: JSON.stringify(HOST_AUTHORITY),
    },
    {
      LING_CUA_DRIVER_PACKAGE_PROVIDER: "1",
      LING_CUA_PACKAGE_RESOURCES_ROOT: "relative/provider",
      LING_CUA_PACKAGE_HOST_AUTHORITY_JSON: JSON.stringify(HOST_AUTHORITY),
    },
  ]) {
    await assert.rejects(inspectConfig(overrides), /cua_driver_package_resources_root_invalid/u);
  }
  await assert.rejects(
    inspectConfig({
      LING_CUA_DRIVER_PACKAGE_PROVIDER: "1",
      LING_CUA_PACKAGE_RESOURCES_ROOT: resolve(tmpdir(), "provider-without-host-authority"),
      LING_CUA_SIGNING_TIER: "test_signed_internal",
      LING_CUA_DISTRIBUTION_CHANNEL: "internal",
    }),
    /cua_driver_package_host_authority_invalid/u,
  );
  await assert.rejects(
    inspectConfig({
      LING_CUA_DRIVER_PACKAGE_PROVIDER: "1",
      LING_CUA_PACKAGE_RESOURCES_ROOT: resolve(tmpdir(), "provider-profile-mismatch"),
      LING_CUA_PACKAGE_HOST_AUTHORITY_JSON: JSON.stringify(HOST_AUTHORITY),
      LING_CUA_SIGNING_TIER: "production_signed",
      LING_CUA_DISTRIBUTION_CHANNEL: "production",
    }),
    /cua_driver_package_host_authority_signing_profile_mismatch/u,
  );
});

test("package preparation stages one platform and writes build-authority files", async () => {
  const sourceRoot = await mkdtemp(join(tmpdir(), "ling-cua-source-output-"));
  let prepared;
  try {
    prepared = await prepareCuaDriverElectronPackage({
      platform: "win32-x64",
      sourceRoot,
      authorityInput: {
        signingProfile: { signingTier: "unsigned_dev" },
      },
    }, {
      async stageProvider(input) {
        assert.equal(input.sourceRoot, sourceRoot);
        assert.equal(input.platform, "win32-x64");
        const providerRoot = join(
          input.outputRoot,
          "providers",
          "cua-driver",
          "0.8.3-ling.1",
        );
        await mkdir(join(providerRoot, "win32-x64", "payload"), { recursive: true });
        await writeFile(join(providerRoot, "win32-x64", "payload", "ling-cua-driver.exe"), "fixture");
        return { providerRoot, providerSha256: "a".repeat(64), stageIdentity: "1:1" };
      },
      async cleanupPublishedStage({ outputRoot }) {
        await rm(outputRoot, { recursive: true, force: true });
      },
    });
    assert.equal(prepared.expectedPreSignPayloadSha256, "a".repeat(64));
    assert.equal(
      JSON.parse(await readFile(join(
        prepared.packageResourcesRoot,
        "packaged-provider-capabilities.json",
      ), "utf8")).win32,
      true,
    );
    assert.equal(
      JSON.parse(await readFile(join(
        prepared.packageResourcesRoot,
        "runtime-trust-policy.json",
      ), "utf8")).signingPolicy.signingTier,
      "unsigned_dev",
    );
    assert.equal(prepared.evidenceRoot, join(prepared.containerRoot, "signing-evidence"));
    await prepared.cleanup();
    await prepared.cleanup();
    await assert.rejects(access(prepared.containerRoot));
  } finally {
    await prepared?.cleanup();
    await rm(sourceRoot, { recursive: true, force: true });
  }
});

test("package preparation cleanup coalesces callers and remains retryable after removal failure", async () => {
  const sourceRoot = await mkdtemp(join(tmpdir(), "ling-cua-cleanup-source-output-"));
  let prepared;
  let removeAttempts = 0;
  try {
    prepared = await prepareCuaDriverElectronPackage(
      {
        platform: "win32-x64",
        sourceRoot,
        authorityInput: { signingProfile: { signingTier: "unsigned_dev" } },
      },
      {
        async stageProvider(input) {
          const providerRoot = join(
            input.outputRoot,
            "providers",
            "cua-driver",
            "0.8.3-ling.1",
          );
          await mkdir(join(providerRoot, "win32-x64", "payload"), { recursive: true });
          await writeFile(
            join(providerRoot, "win32-x64", "payload", "ling-cua-driver.exe"),
            "fixture",
          );
          return { providerRoot, providerSha256: "d".repeat(64), stageIdentity: "1:1" };
        },
        async cleanupPublishedStage({ outputRoot }) {
          removeAttempts += 1;
          if (removeAttempts === 1) {
            throw new Error("fixture_cleanup_failed");
          }
          return rm(outputRoot, { recursive: true, force: true });
        },
      },
    );
    await assert.rejects(prepared.cleanup(), /fixture_cleanup_failed/u);
    await access(prepared.containerRoot);
    await Promise.all([prepared.cleanup(), prepared.cleanup()]);
    assert.equal(removeAttempts, 2);
    await assert.rejects(access(prepared.containerRoot));
  } finally {
    await prepared?.cleanup();
    await rm(sourceRoot, { recursive: true, force: true });
  }
});

test("package CLI keeps provider-disabled builds unchanged and cleans staged roots after Builder", async () => {
  const calls = [];
  await runCuaDriverElectronPackageCli(
    ["--platform", "darwin", "--", "--mac", "dir", "--arm64"],
    {},
    {
      async runBuilder(input) {
        calls.push(input);
        return 0;
      },
    },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].environment.LING_CUA_DRIVER_PACKAGE_PROVIDER, "0");
  assert.equal(calls[0].environment.LING_CUA_PACKAGE_RESOURCES_ROOT, undefined);
  assert.equal(calls[0].args[0], "--config");
});

test("package CLI passes only its verified temporary root and digest to Builder", async () => {
  const sourceRoot = await mkdtemp(join(tmpdir(), "ling-cua-cli-source-output-"));
  let stagedContainer;
  try {
    await runCuaDriverElectronPackageCli(
      ["--platform", "win32-x64", "--", "--win", "dir", "--x64"],
      {
        LING_CUA_DRIVER_PACKAGE_PROVIDER: "1",
        LING_CUA_DRIVER_SOURCE_BUILD_ROOT: sourceRoot,
        LING_CUA_SIGNING_EVIDENCE_DIR: resolve(tmpdir(), "caller-controlled-evidence"),
        LING_CUA_SIGNING_TIER: "unsigned_dev",
      },
      {
        async stageProvider(input) {
          const providerRoot = join(
            input.outputRoot,
            "providers",
            "cua-driver",
            "0.8.3-ling.1",
          );
          await mkdir(join(providerRoot, "win32-x64", "payload"), { recursive: true });
          await writeFile(join(providerRoot, "win32-x64", "payload", "ling-cua-driver.exe"), "fixture");
          return { providerRoot, providerSha256: "b".repeat(64), stageIdentity: "1:1" };
        },
        async cleanupPublishedStage({ outputRoot }) {
          await rm(outputRoot, { recursive: true, force: true });
        },
        async runBuilder(input) {
          assert.equal(input.environment.LING_CUA_DRIVER_PACKAGE_PROVIDER, "1");
          assert.equal(input.environment.LING_CUA_EXPECTED_PRE_SIGN_PAYLOAD_SHA256, "b".repeat(64));
          assert.equal(
            JSON.parse(input.environment.LING_CUA_PACKAGE_HOST_AUTHORITY_JSON).providerExpected,
            true,
          );
          stagedContainer = dirname(dirname(dirname(input.environment.LING_CUA_PACKAGE_RESOURCES_ROOT)));
          assert.equal(
            input.environment.LING_CUA_SIGNING_EVIDENCE_DIR,
            join(stagedContainer, "signing-evidence"),
          );
          await mkdir(input.environment.LING_CUA_SIGNING_EVIDENCE_DIR, { recursive: true });
          await writeFile(
            join(input.environment.LING_CUA_SIGNING_EVIDENCE_DIR, "provider-signing-state.json"),
            "fixture",
          );
          await access(join(
            input.environment.LING_CUA_PACKAGE_RESOURCES_ROOT,
            "packaged-provider-capabilities.json",
          ));
          return 0;
        },
      },
    );
    await assert.rejects(access(stagedContainer));
  } finally {
    await rm(sourceRoot, { recursive: true, force: true });
  }
});

test("package CLI rejects a second Builder config and cleans staging after Builder failure", async () => {
  await assert.rejects(
    runCuaDriverElectronPackageCli(
      ["--platform", "darwin", "--", "--config", "alternate.mjs", "--mac"],
      {},
    ),
    /cua_driver_electron_builder_config_override_forbidden/u,
  );

  const sourceRoot = await mkdtemp(join(tmpdir(), "ling-cua-cli-failed-source-output-"));
  let stagedContainer;
  try {
    await assert.rejects(
      runCuaDriverElectronPackageCli(
        ["--platform", "win32-x64", "--", "--win", "dir", "--x64"],
        {
          LING_CUA_DRIVER_PACKAGE_PROVIDER: "1",
          LING_CUA_DRIVER_SOURCE_BUILD_ROOT: sourceRoot,
          LING_CUA_SIGNING_TIER: "unsigned_dev",
        },
        {
          async stageProvider(input) {
            const providerRoot = join(
              input.outputRoot,
              "providers",
              "cua-driver",
              "0.8.3-ling.1",
            );
            await mkdir(join(providerRoot, "win32-x64", "payload"), { recursive: true });
            await writeFile(
              join(providerRoot, "win32-x64", "payload", "ling-cua-driver.exe"),
              "fixture",
            );
            return { providerRoot, providerSha256: "c".repeat(64), stageIdentity: "1:1" };
          },
          async cleanupPublishedStage({ outputRoot }) {
            await rm(outputRoot, { recursive: true, force: true });
          },
          async runBuilder(input) {
            stagedContainer = dirname(
              dirname(dirname(input.environment.LING_CUA_PACKAGE_RESOURCES_ROOT)),
            );
            return 7;
          },
        },
      ),
      /electron_builder_failed:7/u,
    );
    await assert.rejects(access(stagedContainer));
  } finally {
    await rm(sourceRoot, { recursive: true, force: true });
  }
});

test("package CLI preserves both Builder and staging cleanup failures", async () => {
  const sourceRoot = await mkdtemp(join(tmpdir(), "ling-cua-cli-double-failure-source-"));
  let stagedContainer;
  try {
    await assert.rejects(
      runCuaDriverElectronPackageCli(
        ["--platform", "win32-x64", "--", "--win", "dir", "--x64"],
        {
          LING_CUA_DRIVER_PACKAGE_PROVIDER: "1",
          LING_CUA_DRIVER_SOURCE_BUILD_ROOT: sourceRoot,
          LING_CUA_SIGNING_TIER: "unsigned_dev",
        },
        {
          async stageProvider(input) {
            const providerRoot = join(
              input.outputRoot,
              "providers",
              "cua-driver",
              "0.8.3-ling.1",
            );
            await mkdir(join(providerRoot, "win32-x64", "payload"), { recursive: true });
            await writeFile(
              join(providerRoot, "win32-x64", "payload", "ling-cua-driver.exe"),
              "fixture",
            );
            return { providerRoot, providerSha256: "e".repeat(64), stageIdentity: "1:1" };
          },
          async cleanupPublishedStage() {
            throw new Error("fixture_cleanup_failed");
          },
          async runBuilder(input) {
            stagedContainer = dirname(
              dirname(dirname(input.environment.LING_CUA_PACKAGE_RESOURCES_ROOT)),
            );
            return 7;
          },
        },
      ),
      (error) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.message, "electron_builder_and_package_cleanup_failed");
        assert.deepEqual(error.errors.map((entry) => entry.message), [
          "electron_builder_failed:7",
          "fixture_cleanup_failed",
        ]);
        return true;
      },
    );
    await access(stagedContainer);
  } finally {
    if (stagedContainer) await rm(stagedContainer, { recursive: true, force: true });
    await rm(sourceRoot, { recursive: true, force: true });
  }
});

test("package CLI rejects every Builder project/config escape before staging", async () => {
  for (const argument of [
    "--config.afterPack=null",
    "-c.extraResources=[]",
    "--projectDir=/tmp/evil",
    "--project=/tmp/evil",
    "--prepackaged=/tmp/evil",
  ]) {
    await assert.rejects(
      runCuaDriverElectronPackageCli(
        ["--platform", "darwin", "--", "--mac", "dmg", "--arm64", argument],
        {},
      ),
      /cua_driver_electron_builder_(?:config_override|argument)_forbidden/u,
    );
  }
  await assert.rejects(
    runCuaDriverElectronPackageCli(
      ["--platform", "darwin", "--", "--mac", "dmg", "--x64"],
      {},
    ),
    /cua_driver_electron_builder_argument_forbidden/u,
  );
});

test("package CLI requires package authority and source root together", async () => {
  await assert.rejects(
    runCuaDriverElectronPackageCli(
      ["--platform", "win32-x64", "--", "--win", "nsis", "--x64"],
      { LING_CUA_DRIVER_PACKAGE_PROVIDER: "1" },
    ),
    /cua_driver_source_build_root_missing/u,
  );
  await assert.rejects(
    runCuaDriverElectronPackageCli(
      ["--platform", "win32-x64", "--", "--win", "nsis", "--x64"],
      { LING_CUA_DRIVER_SOURCE_BUILD_ROOT: resolve(tmpdir(), "untrusted-source") },
    ),
    /cua_driver_source_build_root_without_package_authority/u,
  );
});

test("provider-bearing package rejects an Electron Builder 7zip override", async () => {
  await assert.rejects(
    runCuaDriverElectronPackageCli(
      ["--platform", "win32-x64", "--", "--win", "nsis", "--x64"],
      {
        ELECTRON_BUILDER_7ZIP_PATH: resolve(tmpdir(), "attacker-7za.exe"),
        LING_CUA_DRIVER_PACKAGE_PROVIDER: "1",
        LING_CUA_DRIVER_SOURCE_BUILD_ROOT: resolve(tmpdir(), "source"),
      },
    ),
    /cua_driver_electron_builder_7zip_override_forbidden/u,
  );
});

async function inspectConfig(overrides) {
  const script = `
    import config from ${JSON.stringify(configModule)};
    process.stdout.write(JSON.stringify({
      extraResources: config.extraResources,
      macIdentity: config.mac?.identity ?? null,
      macSign: config.mac?.sign ?? null,
      macHardenedRuntime: config.mac?.hardenedRuntime ?? null,
      winSign: config.win?.signtoolOptions?.sign ?? null,
      winSignExts: config.win?.signExts ?? [],
      asar: config.asar,
      electronFuses: config.electronFuses,
      packageAuthority: config.extraMetadata?.lingCuaDriverPackageAuthority,
    }));
  `;
  const environment = { ...process.env };
  for (const key of [
    "LING_CUA_DRIVER_PACKAGE_PROVIDER",
    "LING_CUA_PACKAGE_RESOURCES_ROOT",
    "LING_CUA_PACKAGE_HOST_AUTHORITY_JSON",
    "LING_CUA_SIGNING_TIER",
    "LING_CUA_DISTRIBUTION_CHANNEL",
  ]) {
    delete environment[key];
  }
  Object.assign(environment, overrides);
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--input-type=module", "--eval", script],
    { cwd: desktopRoot, env: environment },
  );
  return JSON.parse(stdout);
}
