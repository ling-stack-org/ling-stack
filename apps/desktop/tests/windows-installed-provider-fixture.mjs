import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { verifyInstalledWindowsProvider } from "./verify-windows-cua-driver-provider.mjs";

export async function createInstalledProviderFixture() {
  const fixtureRoot = await mkdtemp(
    join(tmpdir(), "ling-cua-installed-identity-test-"),
  );
  const distributionRoot = join(
    fixtureRoot,
    "resources",
    "providers",
    "cua-driver",
    "0.8.3-ling.1",
  );
  const platformRoot = join(distributionRoot, "win32-x64");
  const payload = join(platformRoot, "payload");
  await mkdir(payload, { recursive: true });
  const providerPath = join(payload, "cua-driver.exe");
  const sealPath = join(payload, "provider-seal.json");
  const catalogPath = join(platformRoot, "provider-integrity.cat");
  const lockPath = join(distributionRoot, "provider-lock.json");
  const providerBytes = fakePe({ certificateTablePresent: true });
  const providerSha256 = sha256(providerBytes);
  const lock = windowsProviderLock();
  const lockBytes = Buffer.from(`${JSON.stringify(lock)}\n`, "utf8");
  const providerLockSha256 = sha256(lockBytes);
  const seal = windowsProviderSeal({
    providerSha256,
    providerLockSha256,
    lock,
  });
  let providerSealSha256;
  const identity = {
    authenticode: {
      checked: true,
      files: [
        signature(providerPath, seal.main.signerSubject, seal.main.certificateSha256),
        signature(catalogPath, "CN=Ling Catalog", "d".repeat(64)),
      ],
    },
    catalogMembership: {
      checked: true,
      validationStatus: "Valid",
      members: [],
    },
  };
  const writeSeal = async () => {
    const bytes = Buffer.from(`${JSON.stringify(seal)}\n`, "utf8");
    providerSealSha256 = sha256(bytes);
    await writeFile(sealPath, bytes);
    identity.catalogMembership.members = [
      { relativePath: "payload/cua-driver.exe", sha256: providerSha256 },
      { relativePath: "payload/provider-seal.json", sha256: providerSealSha256 },
    ];
  };
  await Promise.all([
    writeFile(providerPath, providerBytes),
    writeFile(lockPath, lockBytes),
    writeFile(catalogPath, "fixture catalog\n", "utf8"),
  ]);
  await writeSeal();
  return {
    distributionRoot,
    providerPath,
    providerSha256,
    providerLockSha256,
    get providerSealSha256() { return providerSealSha256; },
    lock,
    seal,
    identity,
    writeSeal,
    verify: () => verifyInstalledWindowsProvider(providerPath, {
      platform: "win32",
      identityInspector: async (paths) => {
        assert.equal(paths.providerPath, providerPath);
        assert.equal(paths.sealPath, sealPath);
        assert.equal(paths.catalogPath, catalogPath);
        assert.equal(paths.payloadDirectory, payload);
        return structuredClone(identity);
      },
      versionProbe: async (path) => ({
        checked: true,
        expectedVersion: "0.8.3",
        output: path === providerPath ? "cua-driver 0.8.3" : "wrong path",
      }),
    }),
    cleanup: () => rm(fixtureRoot, { recursive: true, force: true }),
  };
}

function windowsProviderSeal({ providerSha256, providerLockSha256, lock }) {
  return {
    schemaVersion: 2,
    componentId: "cua-driver-win32-x64",
    lockSha256: providerLockSha256,
    distributionRevision: "ling.1",
    providerVersion: "0.8.3",
    serverInitializeProtocolVersion: "2025-06-18",
    healthSchemaVersion: "1",
    toolsListCanonicalSha256:
      lock.platforms.win32X64.compatibility.toolsListSha256,
    stateSchemaVersion: 1,
    limitations: ["elevated_pixel_input", "uwp_send_input"],
    signingTier: "test_signed_internal",
    distributionChannel: "internal",
    productionEligible: false,
    testAuthorityKind: "ephemeral-ci",
    main: {
      relativePath: "payload/cua-driver.exe",
      sha256: providerSha256,
      architecture: "x86_64",
      peManifestCanonicalSha256:
        lock.platforms.win32X64.binary.mainManifestCanonicalSha256,
      authenticodeStatus: "Valid",
      signerSubject: "CN=Ling Provider",
      certificateSha256: "c".repeat(64),
      timestampPolicy: "internal-policy",
      timestampStatus: "NotRequired",
    },
    integrityCatalogRelativePath: "provider-integrity.cat",
  };
}

function windowsProviderLock() {
  const digest = (character) => character.repeat(64);
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
      licenseSha256: digest("1"),
    },
    enabledPlatforms: ["win32-x64"],
    platforms: {
      win32X64: {
        schemaVersion: 1,
        componentId: "cua-driver-win32-x64",
        integrationMode: "embedded-stdio",
        distributionRevision: "ling.1",
        productVersionLabel: "0.8.3 (Ling build 1)",
        referenceReleaseArtifact: {
          filename: "cua-driver-rs-0.8.3-windows-x86_64.zip",
          sizeBytes: 10_585_087,
          sha256: digest("2"),
          binaries: {
            "cua-driver.exe": { sha256: digest("3") },
            "cua-driver-uia.exe": { sha256: digest("4") },
          },
          authenticodeStatus: "unsigned-reference",
        },
        sourceBuild: {
          cargoLockSha256: digest("5"),
          rustcVersion: "rustc 1.97.1",
          cargoVersion: "cargo 1.97.1",
          windowsSdkVersion: "10.0.26100.0",
          msvcToolsetVersion: "14.44",
          target: "x86_64-pc-windows-msvc",
          patchSet: {
            id: "ling-managed-embedded-v1",
            sha256: digest("6"),
            patches: [
              { id: "ling-embedded-state-home-v1", sha256: digest("7") },
              { id: "ling-managed-readiness-v1", sha256: digest("8") },
              { id: "ling-managed-lifetime-v1", sha256: digest("9") },
              { id: "ling-windows-capability-errors-v1", sha256: digest("a") },
            ],
            touchedPaths: ["libs/cua-driver/rust/src/main.rs"],
          },
          binariesSha256BeforeSigning: {
            main: digest("b"),
            uiaAuditArtifact: digest("c"),
          },
        },
        binary: {
          architecture: "x86_64",
          expectedUpstreamVersion: "0.8.3",
          lingBuild: 1,
          mainRelativePath: "payload/cua-driver.exe",
          providerSealRelativePath: "payload/provider-seal.json",
          mainManifestCanonicalSha256: digest("d"),
          integrityCatalogRelativePathBySigningTier: {
            unsigned_dev: null,
            test_signed_internal: "provider-integrity.cat",
            production_signed: "provider-integrity.cat",
          },
          packagedFilesBySigningTier: {
            unsigned_dev: ["payload/cua-driver.exe", "payload/provider-seal.json"],
            test_signed_internal: ["provider-integrity.cat", "payload/cua-driver.exe", "payload/provider-seal.json"],
            production_signed: ["provider-integrity.cat", "payload/cua-driver.exe", "payload/provider-seal.json"],
          },
          uiaAuditArtifact: {
            packaged: false,
            relativeBuildOutput: "cua-driver-uia.exe",
            manifestCanonicalSha256: digest("e"),
            requestedExecutionLevel: "asInvoker",
            uiAccess: true,
          },
        },
        runtime: {
          args: ["mcp", "--embedded", "--host-bundle-id", "com.lingstack.desktop"],
          requiredSession: "interactive-user",
          rejectSessionZero: true,
          stateHomeEnvironmentVariable: "CUA_DRIVER_STATE_HOME",
          stateSchemaVersion: 1,
          managedReadinessMethod: "ling/managed_readiness",
          managedReadinessChangedNotification: "ling/managed_readiness_changed",
          childInstanceNonceEnvironmentVariable: "CUA_DRIVER_CHILD_INSTANCE_NONCE",
          leaseGenerationEnvironmentVariable: "CUA_DRIVER_LEASE_GENERATION",
          killOnJobCloseRequired: true,
          defaultIntegrityCoverage: "standard",
          limitations: ["elevated_pixel_input", "uwp_send_input"],
        },
        compatibility: {
          mcpClientSdk: "@modelcontextprotocol/sdk@1.29.0",
          clientInitializeProtocolVersion: "2025-11-25",
          serverInitializeProtocolVersion: "2025-06-18",
          healthSchemaVersion: "1",
          toolsListSha256: digest("f"),
        },
      },
    },
  };
}

function signature(path, signerSubject, certificateSha256) {
  return {
    path,
    status: "Valid",
    statusMessage: "Signature verified.",
    signerSubject,
    certificateSha256,
    timestampStatus: "NotRequired",
  };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function fakePe({ machine = 0x8664, certificateTablePresent = false } = {}) {
  const buffer = Buffer.alloc(512);
  const peOffset = 0x80;
  const optionalHeaderOffset = peOffset + 24;
  buffer.write("MZ", 0, "ascii");
  buffer.writeUInt32LE(peOffset, 0x3c);
  buffer.write("PE\0\0", peOffset, "binary");
  buffer.writeUInt16LE(machine, peOffset + 4);
  buffer.writeUInt16LE(0xf0, peOffset + 20);
  buffer.writeUInt16LE(0x20b, optionalHeaderOffset);
  if (certificateTablePresent) {
    const certificateDirectoryOffset = optionalHeaderOffset + 112 + 4 * 8;
    buffer.writeUInt32LE(0x1a0, certificateDirectoryOffset);
    buffer.writeUInt32LE(0x20, certificateDirectoryOffset + 4);
  }
  return buffer;
}
