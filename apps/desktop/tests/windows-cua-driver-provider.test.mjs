import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  WINDOWS_CUA_DRIVER_RELEASE,
  inspectWindowsX64Pe,
  isPathWithin,
  sha256File,
  verifyPinnedWindowsProviderArchive,
} from "./verify-windows-cua-driver-provider.mjs";

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
    url: "https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.8.3/cua-driver-rs-0.8.3-windows-x86_64.zip",
  });
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
