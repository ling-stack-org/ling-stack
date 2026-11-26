import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { verifyOfficialReleaseSidecar } from "../plugins/official-release-sidecar.mjs";

const artifact = {
  artifactId: "official:cua-driver-0.2.0-win32-x64",
  pluginId: "official:cua-driver",
  version: "0.2.0",
  platform: "win32",
  arch: "x64",
  url: "https://github.com/ling-stack-org/ling-plugin-cua-driver/releases/download/v0.2.0/official-cua-driver-0.2.0-win32-x64.ling-plugin.zip",
  sizeBytes: 2048,
  sha256: "a".repeat(64),
  minLingVersion: "0.6.1",
  maxLingVersion: undefined,
  rollbackAllowed: true,
};

test("official catalog accepts a stable producer sidecar bound to the reviewed archive and manifest", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ling-release-sidecar-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "plugin.ling-plugin.zip.json");
  await writeFile(path, JSON.stringify({ ...artifact, channel: "stable" }));
  await verifyOfficialReleaseSidecar(path, artifact);
});

test("official catalog rejects a missing sidecar, a development sidecar, or a disagreement with the release", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ling-release-sidecar-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "plugin.ling-plugin.zip.json");
  await assert.rejects(verifyOfficialReleaseSidecar(path, artifact), { code: "ENOENT" });
  await writeFile(path, JSON.stringify({ ...artifact, channel: "dev" }));
  await assert.rejects(verifyOfficialReleaseSidecar(path, artifact), /stable release sidecar/u);
  for (const [field, value] of Object.entries({
    artifactId: "official:cua-driver-0.2.0-darwin-arm64",
    arch: "arm64",
    url: artifact.url.replace("v0.2.0", "local-dev"),
    sha256: "b".repeat(64),
    sizeBytes: 4096,
    minLingVersion: undefined,
    maxLingVersion: "0.6.2",
    rollbackAllowed: false,
  })) {
    await writeFile(path, JSON.stringify({ ...artifact, channel: "stable", [field]: value }));
    await assert.rejects(verifyOfficialReleaseSidecar(path, artifact), new RegExp(`field ${field} does not match`, "u"));
  }
});
