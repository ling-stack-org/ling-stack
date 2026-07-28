import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  WINDOWS_CUA_DRIVER_RELEASE,
  WINDOWS_INSTALLED_PROVIDER_IDENTITY_SCRIPT,
  inspectWindowsX64Pe,
  isPathWithin,
  matchesPinnedProviderVersionOutput,
  resolveUnzipExecutable,
  resolveWindowsSystemExecutable,
  runChild,
  sha256File,
  verifyPinnedWindowsProviderArchive,
  verifyWindowsProviderBinary,
} from "./verify-windows-cua-driver-provider.mjs";
import { createInstalledProviderFixture } from "./windows-installed-provider-fixture.mjs";

test("external provider tooling resolves to fixed system paths instead of PATH", () => {
  assert.equal(
    resolveWindowsSystemExecutable("taskkill.exe", { SystemRoot: "C:\\Windows" }),
    "C:\\Windows\\System32\\taskkill.exe",
  );
  assert.equal(
    resolveWindowsSystemExecutable(
      "WindowsPowerShell\\v1.0\\powershell.exe",
      { SystemRoot: "D:\\Windows" },
    ),
    "D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  );
  assert.equal(resolveUnzipExecutable("linux"), "/usr/bin/unzip");
  assert.throws(() => resolveUnzipExecutable("win32"), /not used on Windows/u);
});

test("provider verifier child execution has a bounded timeout", async () => {
  const startedAt = Date.now();
  await assert.rejects(
    runChild(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { timeoutMs: 25 },
    ),
    /timed out after 25ms/u,
  );
  assert.ok(Date.now() - startedAt < 2_000);
});

test("pins the reviewed cua-driver-rs v0.8.3 Windows x86_64 release asset", () => {
  assert.deepEqual(WINDOWS_CUA_DRIVER_RELEASE, {
    repository: "trycua/cua",
    component: "cua-driver-rs",
    version: "0.8.3",
    tag: "cua-driver-rs-v0.8.3",
    assetName: "cua-driver-rs-0.8.3-windows-x86_64.zip",
    assetRoot: "cua-driver-rs-0.8.3-windows-x86_64",
    assetBytes: 10_585_087,
    sha256: "6acdc84b98629fcd0be2368cc16565c18d5f21d9dedd4e10fdb6f58547fce9d0",
    binaries: {
      "cua-driver.exe": {
        sha256: "3cc33572defac29e23bc07e211c20245da9f6ebe8e6481f865b31534b1de8cee",
      },
      "cua-driver-uia.exe": {
        sha256: "1b35a27d41008507d66f819248751b9e79a15c9e6e03390c56749c6fe5daca1c",
      },
    },
    url: "https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.8.3/cua-driver-rs-0.8.3-windows-x86_64.zip",
  });
  assert.equal(matchesPinnedProviderVersionOutput("cua-driver 0.8.3"), true);
  assert.equal(matchesPinnedProviderVersionOutput("cua-driver v0.8.3 (reviewed build)"), true);
  assert.equal(matchesPinnedProviderVersionOutput("cua-driver 0.8.3.1"), false);
  assert.equal(matchesPinnedProviderVersionOutput("cua-driver 0.8.3-beta"), false);
  assert.equal(matchesPinnedProviderVersionOutput("cua-driver 0.8.30"), false);
});

test("installed provider verification rejects a PE with an unreviewed binary hash before execution", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ling-cua-provider-binary-test-"));
  try {
    const binaryPath = join(directory, "cua-driver.exe");
    await writeFile(binaryPath, fakePe());
    await assert.rejects(
      verifyWindowsProviderBinary(binaryPath, "cua-driver.exe"),
      /SHA-256 mismatch/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("accepts an x86_64 PE32+ binary without treating its certificate table as trusted", () => {
  const pe = fakePe({ certificateTablePresent: true });
  assert.deepEqual(inspectWindowsX64Pe(pe, "fixture.exe"), {
    format: "PE32+",
    machine: "0x8664",
    architecture: "x86_64",
    embeddedCertificateTablePresent: true,
  });
});

test("rejects a non-x86_64 PE binary", () => {
  const pe = fakePe({ machine: 0xaa64 });
  assert.throws(() => inspectWindowsX64Pe(pe, "fixture.exe"), /must target Windows x86_64/);
});

test("rejects an archive before extraction when size or SHA-256 does not match", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ling-cua-provider-test-"));
  try {
    const archivePath = join(directory, WINDOWS_CUA_DRIVER_RELEASE.assetName);
    await writeFile(archivePath, "not the pinned archive");
    assert.equal(
      await sha256File(archivePath),
      "31336d9bb85e0c667eaf14a4d15c09de4e080feae928930ec0775a3ca5e8f9ef",
    );
    await assert.rejects(verifyPinnedWindowsProviderArchive(archivePath), /size mismatch/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("temp output boundary accepts descendants but not the root or siblings", () => {
  const root = join(tmpdir(), "ling-provider-boundary-root");
  assert.equal(isPathWithin(join(root, "provider"), root), true);
  assert.equal(isPathWithin(root, root), false);
  assert.equal(isPathWithin(join(dirnameForTest(root), "other"), root), false);
});

test("installed bundled provider rejects every payload entry outside the exact two-file inventory", async () => {
  const cases = [
    ["cua-driver-uia.exe", async (payload) => writeFile(join(payload, "cua-driver-uia.exe"), "unexpected\n")],
    ["extra executable", async (payload) => writeFile(join(payload, "unexpected.exe"), "unexpected\n")],
    ["extra DLL", async (payload) => writeFile(join(payload, "unexpected.dll"), "unexpected\n")],
    ["extra data file", async (payload) => writeFile(join(payload, "unexpected.txt"), "unexpected\n")],
    ["nested payload directory", async (payload) => {
      await mkdir(join(payload, "nested"));
      await writeFile(join(payload, "nested", "unexpected.exe"), "unexpected\n");
    }],
  ];
  for (const [label, addUnexpectedEntry] of cases) {
    const fixture = await createInstalledProviderFixture();
    try {
      const payload = dirnameForTest(fixture.providerPath);
      await addUnexpectedEntry(payload);
      await assert.rejects(
        fixture.verify(),
        /must contain exactly two ordinary files/u,
        label,
      );
    } finally {
      await fixture.cleanup();
    }
  }
});

test("installed bundled provider rejects siblings outside the exact distribution tree", async (t) => {
  const cases = [
    ["distribution sibling", (fixture) =>
      writeFile(join(fixture.distributionRoot, "unexpected.exe"), "unexpected\n")],
    ["platform sibling", (fixture) =>
      writeFile(join(fixture.distributionRoot, "win32-x64", "unexpected.dat"), "unexpected\n")],
  ];
  for (const [label, addUnexpectedEntry] of cases) {
    await t.test(label, async () => {
      const fixture = await createInstalledProviderFixture();
      try {
        await addUnexpectedEntry(fixture);
        await assert.rejects(
          fixture.verify(),
          /must contain exactly/u,
        );
      } finally {
        await fixture.cleanup();
      }
    });
  }
});

test("installed bundled provider rejects a payload symlink before probing", {
  skip: process.platform === "win32",
}, async () => {
  const fixture = await createInstalledProviderFixture();
  try {
    const payload = dirnameForTest(fixture.providerPath);
    await symlink("provider-seal.json", join(payload, "provider-alias.json"));
    await assert.rejects(
      fixture.verify(),
      /must contain exactly two ordinary files/u,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("installed bundled provider binds the final PE, source lock, seal tuple, and real catalog membership", async () => {
  const fixture = await createInstalledProviderFixture();
  try {
    const report = await fixture.verify();
    assert.equal(report.schemaVersion, 2);
    assert.equal(report.provider.sha256, fixture.providerSha256);
    assert.equal(report.providerLock.sha256, fixture.providerLockSha256);
    assert.equal(report.providerLock.sourceTarget, "x86_64-pc-windows-msvc");
    assert.equal(
      report.providerLock.sourceBuild.binariesSha256BeforeSigning.main,
      fixture.lock.platforms.win32X64.sourceBuild.binariesSha256BeforeSigning.main,
    );
    assert.equal(report.providerSeal.lockSha256, fixture.providerLockSha256);
    assert.equal(report.providerSeal.signingTier, "test_signed_internal");
    assert.equal(report.providerSeal.distributionChannel, "internal");
    assert.equal(report.providerSeal.main.architecture, "x86_64");
    assert.deepEqual(report.providerCatalog.membership.members, [
      {
        relativePath: "payload/ling-cua-driver.exe",
        sha256: fixture.providerSha256,
      },
      {
        relativePath: "payload/provider-seal.json",
        sha256: fixture.providerSealSha256,
      },
    ]);
    assert.equal(report.authenticode.trustRequired, true);
    assert.deepEqual(report.packageLayout, {
      distributionRootEntryNames: ["provider-lock.json", "win32-x64"],
      platformRootEntryNames: ["payload", "provider-integrity.cat"],
      payloadFileNames: ["ling-cua-driver.exe", "provider-seal.json"],
      unexpectedPaths: [],
    });
  } finally {
    await fixture.cleanup();
  }
});

test("installed bundled provider accepts the exact production seal and timestamp tuple", async () => {
  const fixture = await createInstalledProviderFixture();
  try {
    fixture.seal.signingTier = "production_signed";
    fixture.seal.distributionChannel = "production";
    fixture.seal.productionEligible = true;
    delete fixture.seal.testAuthorityKind;
    fixture.seal.main.timestampPolicy = "rfc3161-required";
    fixture.seal.main.timestampStatus = "Valid";
    fixture.identity.authenticode.files[0].timestampStatus = "Valid";
    fixture.identity.authenticode.files[1].timestampStatus = "Valid";
    await fixture.writeSeal();

    const report = await fixture.verify();
    assert.equal(report.providerSeal.signingTier, "production_signed");
    assert.equal(report.providerSeal.distributionChannel, "production");
    assert.equal(report.providerSeal.productionEligible, true);
    assert.equal(report.providerSeal.main.timestampStatus, "Valid");
  } finally {
    await fixture.cleanup();
  }
});

test("installed bundled provider rejects source-lock, seal, and catalog identity drift", async (t) => {
  const cases = [
    ["main digest", ({ seal }) => { seal.main.sha256 = "f".repeat(64); }, /provider\/source-lock tuple/u, true],
    ["lock digest", ({ seal }) => { seal.lockSha256 = "e".repeat(64); }, /provider\/source-lock tuple/u, true],
    ["architecture", ({ seal }) => { seal.main.architecture = "arm64"; }, /provider\/source-lock tuple/u, true],
    ["tier channel", ({ seal }) => { seal.distributionChannel = "production"; }, /signing tier\/channel tuple/u, true],
    ["provider signer", ({ identity }) => { identity.authenticode.files[0].signerSubject = "CN=Other"; }, /Authenticode identity/u, false],
    ["catalog validation", ({ identity }) => { identity.catalogMembership.validationStatus = "ValidationFailed"; }, /identity evidence/u, false],
    ["catalog missing seal", ({ identity }) => { identity.catalogMembership.members.pop(); }, /cover exactly/u, false],
    ["catalog extra member", ({ identity }) => { identity.catalogMembership.members.push({ relativePath: "payload/extra.dll", sha256: "d".repeat(64) }); }, /cover exactly/u, false],
  ];
  for (const [name, mutate, pattern, rewriteSeal] of cases) {
    await t.test(name, async () => {
      const fixture = await createInstalledProviderFixture();
      try {
        mutate(fixture);
        if (rewriteSeal) await fixture.writeSeal();
        await assert.rejects(fixture.verify(), pattern);
      } finally {
        await fixture.cleanup();
      }
    });
  }
});

test("installed verifier calls the same Windows catalog membership API as production identity", () => {
  assert.match(
    WINDOWS_INSTALLED_PROVIDER_IDENTITY_SCRIPT,
    /Microsoft\.PowerShell\.Security\\Test-FileCatalog\s+-CatalogFilePath\s+\$env:LING_CUA_PROVIDER_CATALOG\s+-Path\s+\$env:LING_CUA_PROVIDER_PAYLOAD\s+-Detailed/u,
  );
  assert.match(
    WINDOWS_INSTALLED_PROVIDER_IDENTITY_SCRIPT,
    /Microsoft\.PowerShell\.Security\\Get-AuthenticodeSignature\s+-LiteralPath/u,
  );
  assert.match(
    WINDOWS_INSTALLED_PROVIDER_IDENTITY_SCRIPT,
    /Microsoft\.PowerShell\.Management\\Get-ChildItem\s+-LiteralPath\s+\$payloadRoot\s+-File\s+-Force\s+-Recurse/u,
  );
});

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

function dirnameForTest(pathValue) {
  const lastSeparator = Math.max(pathValue.lastIndexOf("/"), pathValue.lastIndexOf("\\"));
  return lastSeparator >= 0 ? pathValue.slice(0, lastSeparator) : pathValue;
}
