import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import JSZip from "jszip";
import test from "node:test";
import { resolveStoragePaths } from "@ling-stack/core";
import { installRemotePluginArtifact, readCurrentPluginPointer, rollbackRemotePluginArtifact } from "../dist/features/plugins/remote-package.js";

test("remote plugin installation verifies identity, caches atomically, and rolls back", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "ling-remote-plugin-"));
  const cwd = join(root, "workspace");
  const paths = resolveStoragePaths(cwd, { homeDir: join(root, "home"), env: {}, workspaceStateLocation: "repo-local" }).workspace;
  const first = await createArtifact("0.2.0", "a".repeat(3));
  const second = await createArtifact("0.3.0", "b".repeat(3));
  const fetchImpl = async (url) => new Response(url.endsWith("second.zip") ? second.bytes : first.bytes, { status: 200 });
  const base = { paths, catalogVersion: "2026-11-18T00:00:00.000Z", lingVersion: "0.6.1", now: "2026-11-18T00:00:00.000Z", fetchImpl };
  try {
    const installed = await installRemotePluginArtifact({ ...base, artifact: first.artifact });
    assert.equal(installed.plugin.validation.ok, true);
    assert.equal((await readCurrentPluginPointer(paths, first.artifact.pluginId)).version, "0.2.0");
    const upgraded = await installRemotePluginArtifact({ ...base, artifact: second.artifact, now: "2026-11-18T00:01:00.000Z" });
    assert.equal(upgraded.previousVersion, "0.2.0");
    const rolledBack = await rollbackRemotePluginArtifact({ paths, pluginId: first.artifact.pluginId, now: "2026-11-18T00:02:00.000Z" });
    assert.equal(rolledBack.plugin.manifest.version, "0.2.0");
    assert.equal((await readCurrentPluginPointer(paths, first.artifact.pluginId)).version, "0.2.0");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("remote plugin installation rejects a changed artifact digest", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "ling-remote-plugin-hash-"));
  const paths = resolveStoragePaths(join(root, "workspace"), { homeDir: join(root, "home"), env: {}, workspaceStateLocation: "repo-local" }).workspace;
  const artifact = {
    artifactId: "official:test-0.1.0-linux-x64",
    pluginId: "official:test",
    version: "0.1.0",
    platform: "linux",
    arch: "x64",
    channel: "stable",
    url: "https://example.test/test.zip",
    sizeBytes: 1,
    sha256: "0".repeat(64),
  };
  try {
    await assert.rejects(() => installRemotePluginArtifact({
      paths,
      artifact,
      catalogVersion: "catalog",
      lingVersion: "0.6.1",
      now: "2026-11-18T00:00:00.000Z",
      fetchImpl: async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
    }), /SHA-256/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("remote plugin installation rejects checksum metadata tampering", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "ling-remote-plugin-checksum-"));
  const paths = resolveStoragePaths(join(root, "workspace"), { homeDir: join(root, "home"), env: {}, workspaceStateLocation: "repo-local" }).workspace;
  const original = await createArtifact("0.4.0", "c".repeat(3));
  const zip = await JSZip.loadAsync(original.bytes);
  zip.file(".ling-plugin/checksums.json", JSON.stringify({ algorithm: "sha256", files: { ".ling-plugin/plugin.json": "0".repeat(64) } }));
  const bytes = await zip.generateAsync({ type: "nodebuffer" });
  const artifact = { ...original.artifact, sha256: createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.length };
  try {
    await assert.rejects(() => installRemotePluginArtifact({
      paths,
      artifact,
      catalogVersion: "catalog",
      lingVersion: "0.6.1",
      now: "2026-11-18T00:00:00.000Z",
      fetchImpl: async () => new Response(bytes, { status: 200 }),
    }), /checksum verification failed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("remote plugin installation rejects zip path traversal", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "ling-remote-plugin-path-"));
  const paths = resolveStoragePaths(join(root, "workspace"), { homeDir: join(root, "home"), env: {}, workspaceStateLocation: "repo-local" }).workspace;
  const zip = new JSZip();
  zip.file("../escape.txt", "escape");
  const bytes = await zip.generateAsync({ type: "nodebuffer" });
  const artifact = {
    artifactId: "official:test-0.5.0-linux-x64",
    pluginId: "official:test",
    version: "0.5.0",
    platform: "linux",
    arch: "x64",
    channel: "stable",
    url: "https://example.test/path.zip",
    sizeBytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  try {
    await assert.rejects(() => installRemotePluginArtifact({
      paths,
      artifact,
      catalogVersion: "catalog",
      lingVersion: "0.6.1",
      now: "2026-11-18T00:00:00.000Z",
      fetchImpl: async () => new Response(bytes, { status: 200 }),
    }), /unsafe path/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function createArtifact(version, fill) {
  const zip = new JSZip();
  const manifest = {
    id: "official:test",
    displayName: "Test plugin",
    version,
    manifestVersion: 2,
    lingInterfaceVersion: "2",
    sourceKind: "official-remote",
    trustLevel: "official",
    trustSummary: "Test official plugin.",
    artifactId: `official:test-${version}-darwin-arm64`,
    platform: "darwin",
    arch: "arm64",
    contributions: [{ kind: "mcp-server", id: "mcp:test", path: "./mcp-server.json" }],
  };
  zip.file(".ling-plugin/plugin.json", `${JSON.stringify(manifest)}\n`);
  zip.file("mcp-server.json", JSON.stringify({ command: "ling-test" }));
  zip.file("payload.bin", fill);
  const checksums = {};
  checksums[".ling-plugin/plugin.json"] = createHash("sha256").update(`${JSON.stringify(manifest)}\n`).digest("hex");
  checksums["mcp-server.json"] = createHash("sha256").update(JSON.stringify({ command: "ling-test" })).digest("hex");
  checksums["payload.bin"] = createHash("sha256").update(fill).digest("hex");
  zip.file(".ling-plugin/checksums.json", `${JSON.stringify({ algorithm: "sha256", files: checksums })}\n`);
  zip.file(".ling-plugin/provenance.json", `${JSON.stringify({ schemaVersion: 1, artifactId: manifest.artifactId })}\n`);
  const bytes = await zip.generateAsync({ type: "nodebuffer" });
  return {
    bytes,
    artifact: {
      artifactId: manifest.artifactId,
      pluginId: manifest.id,
      version,
      platform: manifest.platform,
      arch: manifest.arch,
      channel: "stable",
      url: version === "0.3.0" ? "https://example.test/second.zip" : "https://example.test/first.zip",
      sizeBytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
  };
}
