import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCuaDriverResourcePaths } from "../../dist/main/cua-driver/resource-path.js";

/**
 * Self-owned synthetic resources for the lazy coordinator ordering regression.
 * The payload is not executable code and must never be spawned. Hash/identity
 * fields below are fixture data, not signing, release, TCC or packaged evidence.
 */
export async function createA34CoordinatorArtifactFixture(t) {
  const temp = await mkdtemp(join(tmpdir(), "ling-a34-coordinator-fixture-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const resourcesPath = join(temp, "resources");
  const userDataPath = join(temp, "user-data");
  const workspaceCwd = join(temp, "workspace");
  const paths = resolveCuaDriverResourcePaths({ resourcesPath, platform: "darwin", architecture: "arm64" });
  await mkdir(paths.platformRoot, { recursive: true });
  await mkdir(userDataPath);
  await mkdir(workspaceCwd);
  const license = Buffer.from("fixture MIT license\n", "utf8");
  const lock = createFixtureLock(sha256(license));
  const lockBytes = Buffer.from(`${JSON.stringify(lock, null, 2)}\n`, "utf8");
  const payload = Buffer.from("fixture-cua-driver-0.8.3", "utf8");
  const lockDigest = sha256(lockBytes);
  const executableDigest = sha256(payload);
  await writeFile(paths.lockPath, lockBytes);
  await writeFile(paths.licensePath, license);
  await writeFile(paths.noticesPath, "fixture third-party notices\n", "utf8");
  await writeFile(paths.executablePath, payload, { mode: 0o700 });
  await writeFile(paths.sealPath, `${JSON.stringify({
    schemaVersion: 1,
    componentId: "cua-driver-darwin",
    lockSha256: lockDigest,
    distributionRevision: "ling.1",
    executableRelativePath: "ling-cua-driver",
    executableSha256: executableDigest,
    architectures: ["arm64"],
    cdhashes: { arm64: "abc" },
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
  })}\n`, "utf8");
  return { temp, resourcesPath, userDataPath, workspaceCwd, paths, lockDigest, executableDigest };
}

function createFixtureLock(licenseSha256) {
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
      licenseSha256,
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
          filename: "reference.tar.gz", sizeBytes: 123, sha256: "1".repeat(64),
          binaryArchivePath: "cua-driver", teamId: "TRYCUATEAM",
          authority: "Developer ID Application: Fixture", hardenedRuntime: true,
          entitlementsCanonicalSha256: "2".repeat(64),
        },
        sourceBuild: {
          cargoLockSha256: "3".repeat(64), rustcVersion: "rustc 1.88.0",
          cargoVersion: "cargo 1.88.0", xcodeBuildVersion: "17A400",
          macOSSDKVersion: "26.0", targets: ["aarch64-apple-darwin"],
          patchSet: {
            id: "ling-managed-embedded-v1", sha256: "7".repeat(64),
            patches: [
              { id: "ling-embedded-state-home-v1", sha256: "8".repeat(64) },
              { id: "ling-managed-readiness-v1", sha256: "9".repeat(64) },
              { id: "ling-managed-lifetime-v1", sha256: "a".repeat(64) },
              { id: "ling-windows-capability-errors-v1", sha256: "b".repeat(64) },
              { id: "ling-provider-input-fence-v1", sha256: "c".repeat(64) },
            ],
            touchedPaths: ["libs/cua-driver/rust/src/main.rs"],
          },
          binarySha256BeforeSigning: "4".repeat(64),
        },
        binary: {
          architectures: ["arm64"], minimumMacOS: "13.0",
          supportedMacOSCells: [{ major: "13", architectures: ["arm64"] }],
          expectedUpstreamVersion: "0.8.3", lingBuild: 1, hardenedRuntime: true,
          requiredEntitlements: {
            "com.apple.security.automation.apple-events": true,
            "com.apple.security.device.screen-capture": true,
          },
          requiredEntitlementsCanonicalSha256: "5".repeat(64),
        },
        runtime: {
          args: ["mcp", "--embedded", "--host-bundle-id", "com.lingstack.desktop"],
          stateHomeEnvironmentVariable: "CUA_DRIVER_STATE_HOME",
          inputFencePortEnvironmentVariable: "CUA_DRIVER_INPUT_FENCE_PORT",
          inputFenceTokenEnvironmentVariable: "CUA_DRIVER_INPUT_FENCE_TOKEN",
          inputEpochEnvironmentVariable: "CUA_DRIVER_INPUT_EPOCH",
          inputFenceProtocolVersion: 1,
          inputFenceAdmission: "mutating_tool_call_v1",
          stateSchemaVersion: 1, stateHomeRequiredInEmbeddedMode: true,
          telemetryEnabled: false, startupUpdateCheckEnabled: false,
          managedUpdaterToolsAllowed: false,
        },
        compatibility: {
          mcpClientSdk: "@modelcontextprotocol/sdk@1.29.0",
          clientInitializeProtocolVersion: "2025-11-25",
          serverInitializeProtocolVersion: "2025-06-18", healthSchemaVersion: "1",
          embeddedHealthSkipChecks: ["bundle_identity"],
          toolsListSha256: "6".repeat(64),
        },
      },
    },
  };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
