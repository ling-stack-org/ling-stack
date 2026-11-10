import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertNativeTarget, buildEnvironment, buildGstackNativeRuntime } from "./build-native-runtime.mjs";

test("native dependency builds reject cross-platform labels before creating outputs", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ling-gstack-native-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(buildGstackNativeRuntime({
    sourceBundlePath: join(root, "missing-source"), outputPath: join(root, "output"),
    target: { platform: process.platform === "darwin" ? "win32" : "darwin", arch: "x64" },
  }), /gstack_native_build_requires_matching_host/);
  await assert.rejects(readFile(join(root, "output", "native-build.json")), { code: "ENOENT" });
});

test("native builds cannot overwrite an existing output or mutate its contents", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ling-gstack-native-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outputPath = join(root, "existing");
  await writeFile(outputPath, "user-owned output");
  await assert.rejects(buildGstackNativeRuntime({
    sourceBundlePath: join(root, "missing-source"), outputPath,
  }), /gstack_native_output_already_exists/);
  assert.equal(await readFile(outputPath, "utf8"), "user-owned output");
});

test("native builds reject unauthenticated source evidence before installing or compiling", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ling-gstack-native-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  await mkdir(source);
  await writeFile(join(source, "manifest.json"), JSON.stringify({
    schemaVersion: 1, packId: "gstack-default", deliveryStage: "source",
    upstream: { repository: "https://github.com/garrytan/gstack", revision: "0".repeat(40), version: "1.91.100.0" },
    adaptationRevision: "untrusted-fixture", licensePath: "LICENSE",
    skills: [{ id: "office-hours", entryPath: "SKILL.md", resourcePaths: [] }],
    files: [{ path: "LICENSE", checksum: `sha256:${"0".repeat(64)}`, sizeBytes: 1 }],
  }));
  await assert.rejects(buildGstackNativeRuntime({ sourceBundlePath: source, outputPath: join(root, "output"), bunCommand: "must-not-be-called" }), { code: "bundle_manifest_checksum_mismatch" });
  await assert.rejects(readFile(join(root, "output", "native-build.json")), { code: "ENOENT" });
});

test("native build environment does not inherit credentials or runtime injection", () => {
  const env = buildEnvironment({ bunPath: "/owned/bin/bun", nodePath: "/owned/bin/node", home: "/build/home", temporary: "/build/tmp", inherited: {
    PATH: "/usr/bin", ANTHROPIC_API_KEY: "fixture-secret", AWS_SECRET_ACCESS_KEY: "fixture-secret",
    GSTACK_HOME: "/user/state", GSTACK_CHROMIUM_NO_SANDBOX: "1", BUN_OPTIONS: "--preload malicious.ts",
    NODE_OPTIONS: "--require malicious.cjs", DYLD_INSERT_LIBRARIES: "/malicious.dylib",
  } });
  assert.equal(env.HOME, "/build/home");
  assert.equal(env.GSTACK_HOME, "/build/home/.gstack");
  for (const key of ["ANTHROPIC_API_KEY", "AWS_SECRET_ACCESS_KEY", "GSTACK_CHROMIUM_NO_SANDBOX", "BUN_OPTIONS", "NODE_OPTIONS", "DYLD_INSERT_LIBRARIES"]) {
    assert.equal(env[key], undefined);
  }
});

test("native outputs require the actual Mach-O or PE target architecture", () => {
  const macho = Buffer.alloc(32);
  macho.writeUInt32LE(0xfeedfacf);
  macho.writeUInt32LE(0x0100000c, 4);
  assertNativeTarget(macho, { platform: "darwin", arch: "arm64" });
  assert.throws(() => assertNativeTarget(macho, { platform: "darwin", arch: "x64" }), /target_mismatch/);
  assert.throws(() => assertNativeTarget(macho, { platform: "win32", arch: "arm64" }), /target_mismatch/);
  const pe = Buffer.alloc(128);
  pe.write("MZ"); pe.writeUInt32LE(64, 0x3c); pe.writeUInt32LE(0x00004550, 64); pe.writeUInt16LE(0x8664, 68);
  assertNativeTarget(pe, { platform: "win32", arch: "x64" });
  assert.throws(() => assertNativeTarget(pe, { platform: "win32", arch: "arm64" }), /target_mismatch/);
  pe.writeUInt32LE(0xffffffff, 0x3c);
  assert.throws(() => assertNativeTarget(pe, { platform: "win32", arch: "x64" }), /target_mismatch/);
  assert.throws(() => assertNativeTarget(Buffer.from("#!/bin/sh\n"), { platform: "darwin", arch: "arm64" }), /target_mismatch/);
});

test("universal Node binaries require every actual slice header and the native host architecture", () => {
  const fat = Buffer.alloc(128);
  fat.writeUInt32BE(0xcafebabe); fat.writeUInt32BE(2, 4);
  for (const [index, cpu] of [0x01000007, 0x0100000c].entries()) {
    const row = 8 + index * 20, offset = 64 + index * 32;
    fat.writeUInt32BE(cpu, row); fat.writeUInt32BE(offset, row + 8); fat.writeUInt32BE(32, row + 12);
    fat.writeUInt32LE(0xfeedfacf, offset); fat.writeUInt32LE(cpu, offset + 4);
  }
  assert.doesNotThrow(() => assertNativeTarget(fat, { platform: "darwin", arch: "arm64" }));
  assert.doesNotThrow(() => assertNativeTarget(fat, { platform: "darwin", arch: "x64" }));
  for (const mutate of [bytes => bytes.writeUInt32LE(0x01000007, 100), bytes => bytes.writeUInt32BE(64, 36),
    bytes => bytes.writeUInt32BE(0xffffffff, 36), bytes => bytes.writeUInt32BE(33, 44)]) {
    const changed = Buffer.from(fat); mutate(changed);
    assert.throws(() => assertNativeTarget(changed, { platform: "darwin", arch: "arm64" }), /target_mismatch/);
  }
});
