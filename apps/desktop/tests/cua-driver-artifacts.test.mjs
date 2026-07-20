import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CuaDriverArtifactLockError,
  readCuaDriverProviderLock,
  validateCuaDriverProviderLock,
} from "../dist/main/cua-driver/artifact-lock.js";
import {
  readCuaDriverProviderSeal,
  verifyCuaDriverProviderArtifacts,
} from "../dist/main/cua-driver/provider-seal.js";
import {
  assertCuaDriverResourceTree,
  resolveCuaDriverResourcePaths,
} from "../dist/main/cua-driver/resource-path.js";
import {
  createCuaDriverStateRoot,
  reverifyCuaDriverStateRoot,
  resolveCuaDriverStateRootPath,
} from "../dist/main/cua-driver/state-root.js";

test("bundled resource resolution is fixed under resourcesPath and never consults PATH", () => {
  const resourcesPath = "/opt/Ling Stack/resources";
  const resolved = resolveCuaDriverResourcePaths({
    resourcesPath,
    platform: "win32",
    architecture: "x86_64",
  });
  assert.equal(
    resolved.executablePath,
    "/opt/Ling Stack/resources/providers/cua-driver/0.8.3-ling.1/win32-x64/payload/cua-driver.exe",
  );
  assert.equal(resolved.executablePath.includes("CuaDriver.app"), false);
  assert.equal(resolved.executablePath.includes(".local/bin"), false);
  assert.throws(
    () => resolveCuaDriverResourcePaths({ resourcesPath: ".", platform: "darwin", architecture: "arm64" }),
    /resources_path_must_be_absolute/,
  );
  assert.throws(
    () => resolveCuaDriverResourcePaths({ resourcesPath, platform: "win32", architecture: "arm64" }),
    /windows_architecture_unsupported/,
  );
});

test("provider lock and final seal bind the exact packaged bytes", async (t) => {
  const fixture = await createDarwinArtifactFixture(t);
  const lock = await readCuaDriverProviderLock(fixture.paths.lockPath, {
    platform: "darwin",
    architecture: "arm64",
    requireReleaseEvidence: false,
  });
  const verified = await verifyCuaDriverProviderArtifacts({
    platform: "darwin",
    architecture: "arm64",
    paths: fixture.paths,
    lock,
    platformIdentityVerifier: {
      async verify(input) {
        assert.equal(input.executableDigest, fixture.executableDigest);
        assert.equal(input.lockDigest, fixture.lockDigest);
      },
    },
    requirePlatformIdentityVerification: true,
  });
  assert.equal(verified.executablePath, fixture.paths.executablePath);
  assert.equal(verified.sealDigest, sha256(await readFile(fixture.paths.sealPath)));

  await writeFile(fixture.paths.executablePath, "tampered-provider", "utf8");
  await assert.rejects(
    verifyCuaDriverProviderArtifacts({
      platform: "darwin",
      architecture: "arm64",
      paths: fixture.paths,
      lock,
    }),
    /provider_seal_executable_digest_mismatch/,
  );
});

test("missing provider payload and symlink escapes fail closed", async (t) => {
  const fixture = await createDarwinArtifactFixture(t);
  const outside = join(fixture.temp, "outside-provider");
  await writeFile(outside, "not packaged", "utf8");
  await writeFile(fixture.paths.executablePath, "placeholder", "utf8");
  await chmod(fixture.paths.executablePath, 0o600);
  const replacement = `${fixture.paths.executablePath}.link`;
  await symlink(outside, replacement);
  const escaped = { ...fixture.paths, executablePath: replacement };
  await assert.rejects(assertCuaDriverResourceTree(escaped), /provider_executable_symlink_forbidden/);

  const missing = resolveCuaDriverResourcePaths({
    resourcesPath: join(fixture.temp, "missing-resources"),
    platform: "darwin",
    architecture: "arm64",
  });
  await assert.rejects(assertCuaDriverResourceTree(missing), /provider_root_missing/);
});

test("provider resource layout rejects UIAccess helpers, downloaders and extra payload executables", async (t) => {
  const fixture = await createDarwinArtifactFixture(t);
  await writeFile(join(fixture.paths.platformRoot, "cua-driver-uia"), "audit-only", "utf8");
  await assert.rejects(assertCuaDriverResourceTree(fixture.paths), /darwin_provider_extra_entry/);
});

test("provider lock rejects a platform record that is not explicitly enabled", () => {
  const lock = createDarwinLock();
  assert.throws(
    () => validateCuaDriverProviderLock({ ...lock, enabledPlatforms: ["win32-x64"] }, {
      platform: "darwin",
      architecture: "arm64",
      requireReleaseEvidence: false,
    }),
    /provider_lock_platform_not_enabled/,
  );
});

test("runtime provider-lock wrapper preserves shared error codes and clone isolation", () => {
  const original = createDarwinLock();
  const validated = validateCuaDriverProviderLock(original, {
    platform: "darwin",
    architecture: "arm64",
    requireReleaseEvidence: false,
  });
  assert.notEqual(validated, original);
  assert.notEqual(validated.platforms.darwin, original.platforms.darwin);
  validated.platforms.darwin.runtime.args[0] = "mutated-clone";
  assert.equal(original.platforms.darwin.runtime.args[0], "mcp");

  const invalid = structuredClone(original);
  invalid.platforms.darwin.sourceBuild.cargoLockSha256 = "invalid";
  assert.throws(
    () => validateCuaDriverProviderLock(invalid, {
      platform: "darwin",
      architecture: "arm64",
      requireReleaseEvidence: false,
    }),
    (error) => {
      assert.ok(error instanceof CuaDriverArtifactLockError);
      assert.equal(error.code, "cua_driver_artifact_lock_invalid");
      assert.equal(error.message, "provider_lock_darwin_source_build_invalid");
      return true;
    },
  );
});

test("state root is version isolated, private and rejects symlinked ancestors", async (t) => {
  const temp = await mkdtemp(join(tmpdir(), "ling-cua-state-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(temp, { recursive: true, force: true });
  });
  const userData = join(temp, "user-data");
  await mkdir(userData);
  const state = await createCuaDriverStateRoot({ userDataPath: userData, platform: "darwin" });
  assert.equal(state.rootPath, resolveCuaDriverStateRootPath(userData));
  assert.equal(state.environment.CUA_DRIVER_STATE_HOME, state.rootPath);
  assert.equal(state.environment.CUA_DRIVER_TELEMETRY_HOME, state.telemetryPath);
  assert.equal((await lstat(state.rootPath)).mode & 0o777, 0o700);

  const escapedUserData = join(temp, "escaped-user-data");
  await mkdir(escapedUserData);
  const outside = join(temp, "outside");
  await mkdir(outside);
  await symlink(outside, join(escapedUserData, "providers"));
  await assert.rejects(
    createCuaDriverStateRoot({ userDataPath: escapedUserData, platform: "darwin" }),
    /state_path_symlink_forbidden/,
  );
});

test("Windows state root requires the native ACL/reparse protector", async (t) => {
  const temp = await mkdtemp(join(tmpdir(), "ling-cua-state-win-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(temp, { recursive: true, force: true });
  });
  const userData = join(temp, "user-data");
  await mkdir(userData);
  await assert.rejects(
    createCuaDriverStateRoot({ userDataPath: userData, platform: "win32" }),
    /windows_state_root_protector_required/,
  );
  let protectedRoot;
  const state = await createCuaDriverStateRoot({
    userDataPath: userData,
    platform: "win32",
    platformProtector: {
      async protect(input) {
        protectedRoot = input.stateRootPath;
      },
    },
  });
  assert.equal(protectedRoot, state.rootPath);
});

test("lazy-spawn state reverify rejects a root swapped to a symlink", async (t) => {
  const temp = await mkdtemp(join(tmpdir(), "ling-cua-state-swap-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(temp, { recursive: true, force: true });
  });
  const userData = join(temp, "user-data");
  const outside = join(temp, "outside");
  await mkdir(userData);
  await mkdir(outside);
  const state = await createCuaDriverStateRoot({ userDataPath: userData, platform: "darwin" });
  await rename(state.rootPath, `${state.rootPath}.original`);
  await symlink(outside, state.rootPath);

  await assert.rejects(
    reverifyCuaDriverStateRoot({ stateRoot: state, platform: "darwin" }),
    /state_path_symlink_forbidden/,
  );
});

test("Windows lazy-spawn reverify reruns the ACL and reparse protector", async (t) => {
  const temp = await mkdtemp(join(tmpdir(), "ling-cua-state-win-reverify-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(temp, { recursive: true, force: true });
  });
  const userData = join(temp, "user-data");
  await mkdir(userData);
  let protectorCalls = 0;
  const platformProtector = {
    async protect() {
      protectorCalls += 1;
    },
  };
  const state = await createCuaDriverStateRoot({ userDataPath: userData, platform: "win32", platformProtector });
  await reverifyCuaDriverStateRoot({ stateRoot: state, platform: "win32", platformProtector });
  assert.equal(protectorCalls, 2);
});

async function createDarwinArtifactFixture(t) {
  const temp = await mkdtemp(join(tmpdir(), "ling-cua-artifact-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(temp, { recursive: true, force: true });
  });
  const resourcesPath = join(temp, "resources");
  const paths = resolveCuaDriverResourcePaths({ resourcesPath, platform: "darwin", architecture: "arm64" });
  await mkdir(paths.platformRoot, { recursive: true });
  const lock = createDarwinLock();
  const licenseBytes = Buffer.from("fixture MIT license\n", "utf8");
  lock.upstream.licenseSha256 = sha256(licenseBytes);
  const lockBytes = Buffer.from(`${JSON.stringify(lock, null, 2)}\n`, "utf8");
  const executableBytes = Buffer.from("fixture-cua-driver-0.8.3", "utf8");
  await writeFile(paths.lockPath, lockBytes);
  await writeFile(paths.licensePath, licenseBytes);
  await writeFile(paths.noticesPath, "fixture third-party notices\n", "utf8");
  await writeFile(paths.executablePath, executableBytes, { mode: 0o700 });
  const lockDigest = sha256(lockBytes);
  const executableDigest = sha256(executableBytes);
  const seal = {
    schemaVersion: 1,
    componentId: "cua-driver-darwin",
    lockSha256: lockDigest,
    distributionRevision: "ling.1",
    executableRelativePath: "cua-driver",
    executableSha256: executableDigest,
    architectures: ["arm64", "x86_64"],
    cdhashes: { arm64: "abc", x86_64: "def" },
    codeIdentifier: "com.lingstack.desktop.cua-driver",
    teamId: "LINGTEAM01",
    designatedRequirement: "identifier com.lingstack.desktop.cua-driver",
    designatedRequirementSha256: "d".repeat(64),
    hardenedRuntime: true,
    entitlementsCanonicalSha256: "e".repeat(64),
    providerVersion: "0.8.3",
    serverInitializeProtocolVersion: "2025-06-18",
    healthSchemaVersion: "1",
    toolsListCanonicalSha256: "f".repeat(64),
    stateSchemaVersion: 1,
  };
  await writeFile(paths.sealPath, `${JSON.stringify(seal)}\n`, "utf8");
  return { temp, paths, lock, seal, lockDigest, executableDigest };
}

function createDarwinLock() {
  return {
    schemaVersion: 2,
    componentId: "cua-driver",
    distributionRevision: "ling.1",
    upstream: {
      repository: "https://github.com/trycua/cua",
      tag: "cua-driver-rs-v0.8.3",
      commit: "0612c26b2c7b8556f6de7f6b4f3927ecac914e4f",
      tree: "831819eaf2b79c4d81c2b68773cd5920772e91e9",
      version: "0.8.3",
      releaseStage: "prerelease",
      license: "MIT",
      licenseSha256: "a".repeat(64),
    },
    enabledPlatforms: ["darwin"],
    platforms: {
      darwin: {
        schemaVersion: 1,
        componentId: "cua-driver-darwin",
        integrationMode: "embedded-stdio",
        distributionRevision: "ling.1",
        productVersionLabel: "0.8.3 (Ling build 1)",
        referenceReleaseArtifact: {
          filename: "reference.tar.gz",
          sizeBytes: 123,
          sha256: "1".repeat(64),
          binaryArchivePath: "cua-driver",
          teamId: "TRYCUATEAM",
          authority: "Developer ID Application: Fixture",
          hardenedRuntime: true,
          entitlementsCanonicalSha256: "2".repeat(64),
        },
        sourceBuild: {
          cargoLockSha256: "3".repeat(64),
          rustcVersion: "rustc 1.88.0",
          cargoVersion: "cargo 1.88.0",
          xcodeBuildVersion: "17A400",
          macOSSDKVersion: "26.0",
          targets: ["aarch64-apple-darwin", "x86_64-apple-darwin"],
          patchSet: createPatchSet(),
          universalBinarySha256BeforeSigning: "4".repeat(64),
        },
        binary: {
          architectures: ["arm64", "x86_64"],
          minimumMacOS: "13.0",
          supportedMacOSCells: [{ major: "13", architectures: ["arm64", "x86_64"] }],
          expectedUpstreamVersion: "0.8.3",
          lingBuild: 1,
          hardenedRuntime: true,
          requiredEntitlements: {
            "com.apple.security.automation.apple-events": true,
            "com.apple.security.device.screen-capture": true,
          },
          requiredEntitlementsCanonicalSha256: "5".repeat(64),
        },
        runtime: {
          args: ["mcp", "--embedded", "--host-bundle-id", "com.lingstack.desktop"],
          stateHomeEnvironmentVariable: "CUA_DRIVER_STATE_HOME",
          stateSchemaVersion: 1,
          stateHomeRequiredInEmbeddedMode: true,
          telemetryEnabled: false,
          startupUpdateCheckEnabled: false,
          managedUpdaterToolsAllowed: false,
        },
        compatibility: {
          mcpClientSdk: "@modelcontextprotocol/sdk@1.29.0",
          clientInitializeProtocolVersion: "2025-11-25",
          serverInitializeProtocolVersion: "2025-06-18",
          healthSchemaVersion: "1",
          embeddedHealthSkipChecks: ["bundle_identity"],
          toolsListSha256: "6".repeat(64),
        },
      },
    },
  };
}

function createPatchSet() {
  return {
    id: "ling-managed-embedded-v1",
    sha256: "7".repeat(64),
    patches: [
      { id: "ling-embedded-state-home-v1", sha256: "8".repeat(64) },
      { id: "ling-managed-readiness-v1", sha256: "9".repeat(64) },
      { id: "ling-managed-lifetime-v1", sha256: "a".repeat(64) },
      { id: "ling-windows-capability-errors-v1", sha256: "b".repeat(64) },
    ],
    touchedPaths: ["libs/cua-driver/rust/src/main.rs"],
  };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
