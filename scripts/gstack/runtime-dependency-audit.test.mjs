import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { auditGstackRuntimeDependencies } from "./runtime-dependency-audit.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "ling-gstack-dependencies-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "node_modules"));
  return root;
}

async function dependency(root, path, name, version, license) {
  const directory = join(root, path);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "package.json"), JSON.stringify({ name, version, license }));
  await writeFile(join(directory, "LICENSE"), "The MIT License (MIT)\nCopyright fixture\n");
}

test("dependency audit keeps nested and diagram packages separate and retains exact notice paths", async (t) => {
  const root = await fixture(t);
  await dependency(root, "node_modules/renderer", "renderer", "1.0.0", "MIT");
  await dependency(root, "node_modules/renderer/node_modules/helper", "helper", "1.0.0", "MIT");
  await dependency(root, "lib/diagram-render/node_modules/helper", "helper", "2.0.0", "MIT");
  const report = await auditGstackRuntimeDependencies({ runtimeRoot: root, target: { platform: "darwin", arch: "arm64" } });
  assert.deepEqual(report.packages.map(p => `${p.name}@${p.version}`).sort(), ["helper@1.0.0", "helper@2.0.0", "renderer@1.0.0"]);
  assert.ok(report.packages.some(p => p.noticePaths.includes("lib/diagram-render/node_modules/helper/LICENSE")));
  assert.equal(report.packages.every(p => p.metadataChecksum.startsWith("sha256:")), true);
  assert.equal(report.reviewStatus, "pending");
});

test("proprietary, copyleft and missing notices cannot masquerade as release approval", async (t) => {
  const root = await fixture(t);
  await dependency(root, "node_modules/proprietary", "proprietary", "1.0.0", "SEE LICENSE IN README.md");
  await writeFile(join(root, "node_modules/proprietary/README.md"), "All rights reserved. Use is subject to external legal agreements.");
  await dependency(root, "node_modules/native", "native", "1.0.0", "LGPL-3.0-or-later");
  await dependency(root, "node_modules/no-notice", "no-notice", "1.0.0", "MIT");
  await rm(join(root, "node_modules/no-notice/LICENSE"));
  const report = await auditGstackRuntimeDependencies({ runtimeRoot: root, target: { platform: "darwin", arch: "arm64" } });
  assert.equal(report.releaseEligible, false);
  assert.deepEqual(report.blockers.map(p => p.code).sort(), ["dependency_license_review", "dependency_license_review", "dependency_notice_missing"]);
});

test("dependency audit reports internal command links but never follows escaping links", async (t) => {
  const root = await fixture(t);
  const outside = await fixture(t);
  await dependency(root, "node_modules/parser", "parser", "1.0.0", "MIT");
  await mkdir(join(root, "node_modules/.bin"));
  await symlink("../parser/package.json", join(root, "node_modules/.bin/parser"));
  await symlink(outside, join(root, "node_modules/escape"), "junction");
  const report = await auditGstackRuntimeDependencies({ runtimeRoot: root, target: { platform: "darwin", arch: "arm64" } });
  assert.ok(report.blockers.some(b => b.code === "dependency_link_escape" && b.path === "node_modules/escape"));
  assert.ok(report.blockers.some(b => b.code === "dependency_link_materialization_required"));
  assert.equal(JSON.stringify(report).includes(outside), false);
});

test("dependency audit distinguishes native target matches from foreign bundled binaries", async (t) => {
  const root = await fixture(t);
  await dependency(root, "node_modules/native", "native", "1.0.0", "MIT");
  const macho = Buffer.alloc(32); macho.writeUInt32LE(0xfeedfacf); macho.writeUInt32LE(0x0100000c, 4);
  await writeFile(join(root, "node_modules/native/arm.node"), macho);
  macho.writeUInt32LE(0x01000007, 4);
  await writeFile(join(root, "node_modules/native/x64.node"), macho);
  const report = await auditGstackRuntimeDependencies({ runtimeRoot: root, target: { platform: "darwin", arch: "arm64" } });
  assert.equal(report.nativeComponents.length, 2);
  assert.equal(report.nativeComponents.find(n => n.path.endsWith("arm.node")).targetMatch, true);
  assert.ok(report.blockers.some(b => b.code === "dependency_native_target_mismatch" && b.path.endsWith("x64.node")));
  assert.deepEqual(await readFile(join(root, "node_modules/native/arm.node")), Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0, 0, 1, ...new Array(24).fill(0)]));
});

test("universal Mach-O libraries require a valid matching slice, not just a claimed CPU", async (t) => {
  const root = await fixture(t);
  await dependency(root, "node_modules/native", "native", "1.0.0", "MIT");
  const fat = Buffer.alloc(128);
  fat.writeUInt32BE(0xcafebabe); fat.writeUInt32BE(1, 4);
  fat.writeUInt32BE(0x0100000c, 8); fat.writeUInt32BE(64, 16); fat.writeUInt32BE(32, 20);
  fat.writeUInt32LE(0xfeedfacf, 64); fat.writeUInt32LE(0x0100000c, 68);
  await writeFile(join(root, "node_modules/native/universal.node"), fat);
  fat.writeUInt32LE(0x01000007, 68);
  await writeFile(join(root, "node_modules/native/false-claim.node"), fat);
  const report = await auditGstackRuntimeDependencies({ runtimeRoot: root, target: { platform: "darwin", arch: "arm64" } });
  assert.equal(report.nativeComponents.find(n => n.path.endsWith("universal.node")).targetMatch, true);
  assert.equal(report.nativeComponents.find(n => n.path.endsWith("false-claim.node")).targetMatch, false);
});

test("missing metadata can resolve from a complete MIT notice with explicit hashed evidence", async (t) => {
  const root = await fixture(t);
  await dependency(root, "node_modules/complete", "complete", "1.0.0", undefined);
  const mit = await readFile(new URL("../../LICENSE", import.meta.url), "utf8");
  await writeFile(join(root, "node_modules/complete/LICENSE"), mit);
  await dependency(root, "node_modules/header-only", "header-only", "1.0.0", undefined);
  await dependency(root, "node_modules/proprietary", "proprietary", "1.0.0", "SEE LICENSE IN README.md");
  await writeFile(join(root, "node_modules/proprietary/LICENSE"), mit);
  const report = await auditGstackRuntimeDependencies({ runtimeRoot: root, target: { platform: "darwin", arch: "arm64" } });
  const resolved = report.packages.find(p => p.name === "complete");
  assert.equal(resolved.license, "MIT");
  assert.equal(resolved.metadataLicense, "Unknown");
  assert.equal(resolved.licenseEvidence[0].path, "node_modules/complete/LICENSE");
  assert.match(resolved.licenseEvidence[0].checksum, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(report.blockers.filter(b => b.code === "dependency_license_review").map(b => b.path), ["node_modules/header-only", "node_modules/proprietary"]);
  assert.equal(report.releaseEligible, false);
});
