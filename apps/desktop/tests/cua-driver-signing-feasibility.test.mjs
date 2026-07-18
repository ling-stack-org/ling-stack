import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { createDisposableFixtureSigner } from "../scripts/cua-driver-signing/fixture-signer.mjs";
import {
  extractFixtureArtifact,
  writeFixtureArtifact,
} from "../scripts/cua-driver-signing/fixture-artifact.mjs";
import {
  configureProviderSigningHooks,
  readSigningFixtureTrace,
  resetProviderSigningHooks,
  runAfterPack,
  runAfterSign,
  runArtifactBuildCompleted,
  runProviderAwareSign,
} from "../scripts/cua-driver-signing/hooks.mjs";
import {
  resolveSigningProfile,
  sha256File,
} from "../scripts/cua-driver-signing/signing-contract.mjs";

const INTERNAL_PROFILE = Object.freeze({
  signingTier: "test_signed_internal",
  distributionChannel: "internal",
  testAuthorityKind: "ephemeral-ci",
});
const DEVELOPMENT_PROFILE = Object.freeze({
  signingTier: "unsigned_dev",
  distributionChannel: "development",
});
const PRODUCTION_PROFILE = Object.freeze({
  signingTier: "production_signed",
  distributionChannel: "production",
});

test.afterEach(() => {
  resetProviderSigningHooks();
});

test("opt-in Electron Builder 26.15.3 fixture config wires both platform signing callbacks", async () => {
  const config = (await import("../scripts/cua-driver-signing/electron-builder.signing-feasibility.config.mjs?fixture=1")).default;
  assert.equal(config.afterPack, "./scripts/cua-driver-signing/after-pack.mjs");
  assert.equal(config.afterSign, "./scripts/cua-driver-signing/after-sign.mjs");
  assert.equal(config.artifactBuildCompleted, "./scripts/cua-driver-signing/artifact-build-completed.mjs");
  assert.equal(config.mac.sign, "./scripts/cua-driver-signing/electron-builder-mac-sign.mjs");
  assert.equal(config.win.signtoolOptions.sign, "./scripts/cua-driver-signing/electron-builder-win-sign.mjs");
  assert.deepEqual(config.win.signtoolOptions.signingHashAlgorithms, ["sha256"]);
  const winCallback = (await import("../scripts/cua-driver-signing/electron-builder-win-sign.mjs?fixture=1")).default;
  const macCallback = (await import("../scripts/cua-driver-signing/electron-builder-mac-sign.mjs?fixture=1")).default;
  assert.equal(typeof winCallback, "function");
  assert.equal(typeof macCallback, "function");
});

test("configured Windows callback keeps provider sealed while signing app, uninstaller, and NSIS roles", async () => {
  const fixture = await createFixture("win32", INTERNAL_PROFILE);
  try {
    const signer = createDisposableFixtureSigner();
    const context = { appOutDir: fixture.appOutDir, electronPlatformName: "win32" };
    await runAfterPack(context, {
      profile: INTERNAL_PROFILE,
      signer,
      stateDirectory: fixture.stateDirectory,
      requireProvider: true,
    });
    const providerSha256 = await sha256File(fixture.providerPath);
    const outerPaths = [
      join(fixture.appOutDir, "Ling Stack.exe"),
      join(fixture.appOutDir, "Uninstall Ling Stack.exe"),
      join(fixture.root, "Ling Stack Setup.exe"),
    ];
    await Promise.all(outerPaths.map((path) => writeFile(path, Buffer.from(`outer:${path}`))));
    const packager = {
      __lingSigningAppOutDir: fixture.appOutDir,
      __lingSigningProfile: INTERNAL_PROFILE,
      __lingSigningSigner: signer,
      __lingSigningOuterSigner: signer,
      __lingSigningStateDirectory: fixture.stateDirectory,
    };
    const callback = (await import("../scripts/cua-driver-signing/electron-builder-win-sign.mjs?callback=1")).default;
    const skipped = await callback({ path: fixture.providerPath }, packager);
    assert.equal(skipped.skipped, true);
    for (const path of outerPaths) {
      const delegated = await callback({ path }, packager);
      assert.equal(delegated.signed, true);
    }
    assert.equal(await sha256File(fixture.providerPath), providerSha256);
    const trace = await readSigningFixtureTrace(fixture.stateDirectory);
    assert.deepEqual(
      trace.events
        .filter((event) => event.hook === "platformSign" && event.event === "outer-path-signed")
        .map((event) => event.role),
      ["outer-app", "outer-uninstaller", "outer-nsis"],
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("configured macOS callback delegates the outer app without changing the sealed provider", async () => {
  const fixture = await createFixture("darwin", INTERNAL_PROFILE);
  try {
    const signer = createDisposableFixtureSigner();
    await runAfterPack(
      { appOutDir: fixture.appOutDir, electronPlatformName: "darwin" },
      {
        profile: INTERNAL_PROFILE,
        signer,
        stateDirectory: fixture.stateDirectory,
        requireProvider: true,
      },
    );
    const providerSha256 = await sha256File(fixture.providerPath);
    const appPath = join(fixture.appOutDir, "Ling Stack.app");
    const executablePath = join(appPath, "Contents", "MacOS", "Ling Stack");
    await mkdir(join(appPath, "Contents", "MacOS"), { recursive: true });
    await writeFile(executablePath, Buffer.from("outer:mac-app"));
    const callback = (await import("../scripts/cua-driver-signing/electron-builder-mac-sign.mjs?callback=1")).default;
    const result = await callback(
      { app: appPath },
      {
        appInfo: { productFilename: "Ling Stack" },
        __lingSigningAppOutDir: fixture.appOutDir,
        __lingSigningProfile: INTERNAL_PROFILE,
        __lingSigningSigner: signer,
        __lingSigningOuterSigner: signer,
        __lingSigningStateDirectory: fixture.stateDirectory,
      },
    );
    assert.equal(result.signed, true);
    assert.equal(result.identity.role, "outer-app");
    assert.equal(await sha256File(fixture.providerPath), providerSha256);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("signed platform callback fails closed when the outer signer is missing", async () => {
  const fixture = await createFixture("win32", INTERNAL_PROFILE);
  try {
    const signer = createDisposableFixtureSigner();
    await runAfterPack(
      { appOutDir: fixture.appOutDir, electronPlatformName: "win32" },
      {
        profile: INTERNAL_PROFILE,
        signer,
        stateDirectory: fixture.stateDirectory,
        requireProvider: true,
      },
    );
    const outerPath = join(fixture.appOutDir, "Ling Stack Setup.exe");
    await writeFile(outerPath, Buffer.from("unsigned outer fixture"));
    await assert.rejects(
      runProviderAwareSign(
        { appOutDir: fixture.appOutDir, electronPlatformName: "win32", path: outerPath },
        { profile: INTERNAL_PROFILE, stateDirectory: fixture.stateDirectory },
      ),
      /outer_signer_unconfigured/u,
    );
    const trace = await readSigningFixtureTrace(fixture.stateDirectory);
    assert.deepEqual(
      trace.events.at(-1),
      {
        sequence: trace.events.length,
        hook: "platformSign",
        event: "outer-signing-failed",
        errorCode: "outer_signer_unconfigured",
        platform: "win32",
        role: "outer-nsis",
        targetName: "Ling Stack Setup.exe",
      },
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

for (const platform of ["darwin", "win32"]) {
  test(`${platform} fixture proves hook order and final digest invariants`, async () => {
    const fixture = await createFixture(platform, INTERNAL_PROFILE);
    try {
      const signer = createDisposableFixtureSigner({
        signerSubject: `CN=Ling ${platform} Disposable CI`,
      });
      const context = {
        appOutDir: fixture.appOutDir,
        electronPlatformName: platform,
      };
      const packed = await runAfterPack(context, {
        profile: INTERNAL_PROFILE,
        signer,
        stateDirectory: fixture.stateDirectory,
        requireProvider: true,
      });
      assert.equal(packed.skipped, false);
      assert.equal(packed.state.sealedProviderSha256, await sha256File(fixture.providerPath));

      const outerPath = join(fixture.appOutDir, platform === "win32" ? "Ling Stack.exe" : "Ling Stack");
      await writeFile(outerPath, Buffer.from(`${platform}-outer-app`));
      const outerResult = await runProviderAwareSign(
        { ...context, path: outerPath },
        {
          profile: INTERNAL_PROFILE,
          signer: undefined,
          outerSigner: signer,
          outerRole: "outer-app",
          stateDirectory: fixture.stateDirectory,
        },
      );
      assert.equal(outerResult.signed, true);

      const providerResult = await runProviderAwareSign(
        { ...context, path: fixture.providerPath },
        { profile: INTERNAL_PROFILE, outerSigner: signer, stateDirectory: fixture.stateDirectory },
      );
      assert.deepEqual(providerResult, {
        skipped: true,
        reason: "sealed_provider_path",
        sha256: packed.state.sealedProviderSha256,
      });

      const signed = await runAfterSign(context, {
        profile: INTERNAL_PROFILE,
        stateDirectory: fixture.stateDirectory,
      });
      assert.equal(signed.verification.providerSha256, packed.state.sealedProviderSha256);
      assert.equal(signed.verification.sealSha256, packed.state.sealSha256);
      if (platform === "win32") {
        assert.match(signed.verification.catalogSha256, /^[0-9a-f]{64}$/u);
      } else {
        assert.equal(signed.verification.catalogSha256, null);
      }

      const artifactPath = join(fixture.root, `${platform}-fixture.zip`);
      await writeFixtureArtifact({
        sourceRoot: fixture.appOutDir,
        artifactPath,
        kind: "zip",
      });
      const artifact = await runArtifactBuildCompleted(
        { ...context, artifactPath },
        {
          profile: INTERNAL_PROFILE,
          stateDirectory: fixture.stateDirectory,
          extractArtifact: (path) =>
            extractFixtureArtifact({
              artifactPath: path,
              destinationRoot: fixture.artifactRoot,
              expectedKind: "zip",
            }),
        },
      );
      assert.equal(artifact.verification.providerSha256, packed.state.sealedProviderSha256);

      const trace = await readSigningFixtureTrace(fixture.stateDirectory);
      assert.deepEqual(
        trace.events.map((event) => `${event.hook}:${event.event}`),
        [
          "afterPack:started",
          "afterPack:provider-pre-sign-digest",
          "afterPack:provider-signed",
          "afterPack:provider-sealed",
          ...(platform === "win32" ? ["afterPack:provider-catalog-signed"] : []),
          "afterPack:complete",
          "platformSign:outer-path-signed",
          "platformSign:sealed-provider-path-skipped",
          "afterSign:started",
          "afterSign:verified",
          "artifactBuildCompleted:started",
          "artifactBuildCompleted:verified",
        ],
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
}

test("unsigned development tuple writes explicit NotSigned seal and no Windows catalog", async () => {
  const fixture = await createFixture("win32", DEVELOPMENT_PROFILE);
  try {
    const context = { appOutDir: fixture.appOutDir, electronPlatformName: "win32" };
    const packed = await runAfterPack(context, {
      profile: DEVELOPMENT_PROFILE,
      stateDirectory: fixture.stateDirectory,
      requireProvider: true,
    });
    const seal = JSON.parse(await readFile(fixture.sealPath, "utf8"));
    assert.equal(seal.signingTier, "unsigned_dev");
    assert.equal(seal.distributionChannel, "development");
    assert.equal(seal.main.authenticodeStatus, "NotSigned");
    assert.equal(seal.integrityCatalogRelativePath, null);
    assert.equal(packed.state.catalogSha256, null);
    await runAfterSign(context, {
      profile: DEVELOPMENT_PROFILE,
      stateDirectory: fixture.stateDirectory,
    });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("provider mutation after seal fails closed in afterSign and artifact verification", async () => {
  const fixture = await createFixture("win32", INTERNAL_PROFILE);
  try {
    const signer = createDisposableFixtureSigner();
    const context = { appOutDir: fixture.appOutDir, electronPlatformName: "win32" };
    await runAfterPack(context, {
      profile: INTERNAL_PROFILE,
      signer,
      stateDirectory: fixture.stateDirectory,
      requireProvider: true,
    });
    await writeFile(fixture.providerPath, Buffer.from("post-seal mutation"), { flag: "a" });
    await assert.rejects(
      runAfterSign(context, { profile: INTERNAL_PROFILE, stateDirectory: fixture.stateDirectory }),
      /provider_post_seal_mutation/u,
    );

    const artifactPath = join(fixture.root, "mutated.zip");
    await writeFixtureArtifact({
      sourceRoot: fixture.appOutDir,
      artifactPath,
      kind: "zip",
    });
    await rm(fixture.artifactRoot, { recursive: true, force: true });
    await extractFixtureArtifact({
      artifactPath,
      destinationRoot: fixture.artifactRoot,
      expectedKind: "zip",
    });
    await writeFile(join(fixture.artifactRoot, "resources/providers/cua-driver/0.8.3-ling.1/win32-x64/payload/cua-driver.exe"), Buffer.from("artifact mutation"), { flag: "a" });
    await assert.rejects(
      runArtifactBuildCompleted(
        { ...context, artifactPath },
        {
          profile: INTERNAL_PROFILE,
          stateDirectory: fixture.stateDirectory,
          artifactRoot: fixture.artifactRoot,
        },
      ),
      /provider_post_seal_mutation/u,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("second afterPack invocation and second provider signing both fail closed", async () => {
  const fixture = await createFixture("darwin", INTERNAL_PROFILE);
  try {
    const signer = createDisposableFixtureSigner();
    const context = { appOutDir: fixture.appOutDir, electronPlatformName: "darwin" };
    await runAfterPack(context, {
      profile: INTERNAL_PROFILE,
      signer,
      stateDirectory: fixture.stateDirectory,
      requireProvider: true,
    });
    await assert.rejects(
      runAfterPack(context, {
        profile: INTERNAL_PROFILE,
        signer,
        stateDirectory: fixture.stateDirectory,
        requireProvider: true,
      }),
      /provider_double_sign/u,
    );
    await assert.rejects(
      signer.signFile({
        filePath: fixture.providerPath,
        platform: "darwin",
        role: "provider",
        profile: resolveSigningProfile(INTERNAL_PROFILE),
      }),
      /provider_double_sign/u,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("mixed tier/channel state is rejected and fixture signer cannot produce production bytes", async () => {
  const fixture = await createFixture("win32", INTERNAL_PROFILE);
  try {
    const signer = createDisposableFixtureSigner();
    const context = { appOutDir: fixture.appOutDir, electronPlatformName: "win32" };
    await runAfterPack(context, {
      profile: INTERNAL_PROFILE,
      signer,
      stateDirectory: fixture.stateDirectory,
      requireProvider: true,
    });
    await assert.rejects(
      runAfterSign(context, {
        profile: PRODUCTION_PROFILE,
        stateDirectory: fixture.stateDirectory,
      }),
      /mixed_signing_tier/u,
    );

    const productionFixture = await createFixture("win32", PRODUCTION_PROFILE);
    try {
      const cleanDigest = await sha256File(productionFixture.providerPath);
      await assert.rejects(
        runAfterPack(
          { appOutDir: productionFixture.appOutDir, electronPlatformName: "win32" },
          {
            profile: PRODUCTION_PROFILE,
            signer,
            stateDirectory: productionFixture.stateDirectory,
            expectedPreSignPayloadSha256: cleanDigest,
            requireProvider: true,
          },
        ),
        /fixture_signer_production_forbidden/u,
      );
    } finally {
      await rm(productionFixture.root, { recursive: true, force: true });
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("production hook rejects a reused internal signed payload even with a matching test digest", async () => {
  const fixture = await createFixture("win32", INTERNAL_PROFILE);
  try {
    const signer = createDisposableFixtureSigner();
    const context = { appOutDir: fixture.appOutDir, electronPlatformName: "win32" };
    await runAfterPack(context, {
      profile: INTERNAL_PROFILE,
      signer,
      stateDirectory: fixture.stateDirectory,
      requireProvider: true,
    });
    const reusedDigest = await sha256File(fixture.providerPath);
    const productionRoot = join(fixture.root, "production-reused");
    await cp(fixture.appOutDir, productionRoot, { recursive: true });
    await rm(join(productionRoot, "resources/providers/cua-driver/0.8.3-ling.1/win32-x64/payload/provider-seal.json"), { force: true });
    await rm(join(productionRoot, "resources/providers/cua-driver/0.8.3-ling.1/win32-x64/provider-integrity.cat"), { force: true });
    const reusedProviderPath = join(productionRoot, "resources/providers/cua-driver/0.8.3-ling.1/win32-x64/payload/cua-driver.exe");
    const productionStateDirectory = join(fixture.root, "production-evidence");
    await assert.rejects(
      runAfterPack({ appOutDir: productionRoot, electronPlatformName: "win32" }, {
        profile: PRODUCTION_PROFILE,
        signer,
        stateDirectory: productionStateDirectory,
        expectedPreSignPayloadSha256: reusedDigest,
        requireProvider: true,
      }),
      /production_pre_sign_payload_not_clean/u,
    );
    assert.equal(await sha256File(reusedProviderPath), reusedDigest);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("unexpected Windows executable in private payload is rejected before signing", async () => {
  const fixture = await createFixture("win32", INTERNAL_PROFILE);
  try {
    await writeFile(join(fixture.payloadRoot, "cua-driver-uia.exe"), Buffer.from("audit-only"));
    await assert.rejects(
      runAfterPack(
        { appOutDir: fixture.appOutDir, electronPlatformName: "win32" },
        {
          profile: INTERNAL_PROFILE,
          signer: createDisposableFixtureSigner(),
          stateDirectory: fixture.stateDirectory,
          requireProvider: true,
        },
      ),
      /unexpected_provider_executable/u,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

for (const [platform, kind] of [
  ["darwin", "zip"],
  ["darwin", "dmg"],
  ["win32", "nsis"],
]) {
  test(`${platform} ${kind} fixture is reopened and rehashed by artifactBuildCompleted`, async () => {
    const fixture = await createFixture(platform, INTERNAL_PROFILE);
    try {
      const signer = createDisposableFixtureSigner();
      const context = { appOutDir: fixture.appOutDir, electronPlatformName: platform };
      await runAfterPack(context, {
        profile: INTERNAL_PROFILE,
        signer,
        stateDirectory: fixture.stateDirectory,
        requireProvider: true,
      });
      const artifactPath = join(fixture.root, `Ling-${kind}.${kind === "nsis" ? "exe" : kind}`);
      await writeFixtureArtifact({ sourceRoot: fixture.appOutDir, artifactPath, kind });
      const extractedRoot = join(fixture.root, `${kind}-reopened`);
      const result = await runArtifactBuildCompleted(
        { ...context, artifactPath },
        {
          profile: INTERNAL_PROFILE,
          stateDirectory: fixture.stateDirectory,
          extractArtifact: (path) =>
            extractFixtureArtifact({
              artifactPath: path,
              destinationRoot: extractedRoot,
              expectedKind: kind,
            }),
        },
      );
      assert.equal(result.verification.providerSha256, await sha256File(fixture.providerPath));
      const trace = await readSigningFixtureTrace(fixture.stateDirectory);
      const artifactEvent = trace.events.find(
        (event) => event.hook === "artifactBuildCompleted" && event.event === "verified",
      );
      assert.match(artifactEvent.artifactSha256, /^[0-9a-f]{64}$/u);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
}

test("packaging without a staged provider remains a no-op for the existing external baseline", async () => {
  const root = await mkdtemp(join(tmpdir(), "ling-cua-no-provider-"));
  try {
    const result = await runAfterPack(
      { appOutDir: root, electronPlatformName: "darwin" },
      { profile: DEVELOPMENT_PROFILE, stateDirectory: join(root, "evidence") },
    );
    assert.deepEqual(result.skipped, true);
    assert.equal(result.reason, "provider_not_staged");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function createFixture(platform, profile) {
  const root = await mkdtemp(join(tmpdir(), `ling-cua-signing-${platform}-`));
  const appOutDir = join(root, "app-output");
  const stateDirectory = join(root, "evidence");
  const artifactRoot = join(root, "artifact-root");
  const revision = "0.8.3-ling.1";
  const platformRoot =
    platform === "win32"
      ? join(appOutDir, "resources", "providers", "cua-driver", revision, "win32-x64")
      : join(appOutDir, "Contents", "Resources", "providers", "cua-driver", revision, "darwin");
  const payloadRoot = platform === "win32" ? join(platformRoot, "payload") : platformRoot;
  await mkdir(payloadRoot, { recursive: true });
  await writeFile(join(platformRoot, "..", "provider-lock.json"), `${platform}-fixture-lock-v1\n`);
  const providerPath = join(payloadRoot, platform === "win32" ? "cua-driver.exe" : "cua-driver");
  await writeFile(providerPath, Buffer.from(`MZ-or-MACHO-fixture:${platform}`));
  return {
    root,
    appOutDir,
    stateDirectory,
    artifactRoot,
    platformRoot,
    payloadRoot,
    providerPath,
    sealPath:
      platform === "win32" ? join(payloadRoot, "provider-seal.json") : join(platformRoot, "provider-seal.json"),
    profile,
  };
}
