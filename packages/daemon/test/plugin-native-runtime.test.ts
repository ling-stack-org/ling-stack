import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import JSZip from "jszip";
import { resolveStoragePaths } from "@ling-stack/core";
import {
  OFFICIAL_PLUGIN_RUNTIME_SIGNATURE_CONTEXT,
  readVerifiedOfficialPluginRuntime,
} from "@ling-stack/core/official-plugin-runtime";
import type { LingPluginArtifactDescriptor } from "@ling-stack/plugin-sdk";
import { installRemotePluginArtifact, rollbackRemotePluginArtifact } from "../dist/features/plugins/remote-package.js";

// The Cua and native-host cache contract is platform-neutral. The test uses
// fixture bytes and never starts an operating-system process.
const pluginId = "official:chrome-browser";
const executable = "runtime/ling-browser-host";
const manifestPath = ".ling-plugin/plugin.json";
const checksumPath = ".ling-plugin/checksums.json";

test("verified host runtime survives an offline restart, upgrades and rolls back", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ling-native-plugin-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pem = publicKey.export({ format: "pem", type: "spki" }).toString();
  const originalHome = process.env.LING_STACK_HOME;
  const originalKey = process.env.LING_PLUGIN_ARTIFACT_PUBLIC_KEY;
  process.env.LING_STACK_HOME = join(root, "config");
  process.env.LING_PLUGIN_ARTIFACT_PUBLIC_KEY = pem;
  t.after(() => {
    if (originalHome === undefined) delete process.env.LING_STACK_HOME;
    else process.env.LING_STACK_HOME = originalHome;
    if (originalKey === undefined) delete process.env.LING_PLUGIN_ARTIFACT_PUBLIC_KEY;
    else process.env.LING_PLUGIN_ARTIFACT_PUBLIC_KEY = originalKey;
  });
  const paths = resolveStoragePaths(join(root, "workspace"), { workspaceStateLocation: "repo-local" }).workspace;
  const now = "2026-11-22T00:00:00.000Z";
  const first = await createArtifact(privateKey, "1.0.0", "first");
  const second = await createArtifact(privateKey, "1.1.0", "second");
  const install = (asset: Awaited<ReturnType<typeof createArtifact>>) => installRemotePluginArtifact({
    paths, now, artifact: asset.artifact, lingVersion: "0.6.1", catalogVersion: now,
    fetchImpl: async () => new Response(new Uint8Array(asset.bytes)),
  });
  const readRuntime = () => readVerifiedOfficialPluginRuntime({
    pluginId, executable, lingVersion: "0.6.1", platform: "darwin", arch: "arm64", publicKey: pem,
  });

  assert.equal(await readRuntime(), undefined);
  const firstInstalled = await install(first);
  assert.match(firstInstalled.cacheRef, /^host\/official-remote\//u);
  assert.equal((await readRuntime())?.version, "1.0.0");
  const installed = await install(second);
  assert.equal(installed.previousVersion, "1.0.0");
  const reinstalled = await Promise.all([install(second), install(second)]);
  assert.deepEqual(reinstalled.map((result) => result.previousVersion), ["1.0.0", "1.0.0"]);
  const latest = await readRuntime();
  assert.equal(latest?.version, "1.1.0");
  assert.equal(await readFile(latest!.executablePath, "utf8"), "second");

  await writeFile(latest!.executablePath, "changed");
  await assert.rejects(readRuntime, /checksum changed/u);
  await rollbackRemotePluginArtifact({ paths, pluginId, now, cacheRef: installed.cacheRef, lingVersion: "0.6.1" });
  const restored = await readRuntime();
  assert.equal(restored?.version, "1.0.0");
  assert.equal(await readFile(restored!.executablePath, "utf8"), "first");

  await writeFile(join(restored!.root, checksumPath), '{"algorithm":"sha256","files":{}}');
  await assert.rejects(readRuntime, /signature is invalid/u);
});

async function createArtifact(key: KeyObject, version: string, payload: string) {
  const artifactId = `${pluginId}-${version}-darwin-arm64`;
  const manifest = JSON.stringify({
    id: pluginId, displayName: "Chrome", trustSummary: "Test plugin.",
    version, sourceKind: "official-remote", trustLevel: "official",
    manifestVersion: 2, lingInterfaceVersion: "2", artifactId, platform: "darwin", arch: "arm64",
    contributions: [{ kind: "mcp-server", id: "mcp:chrome", path: "./mcp-server.json" }],
  });
  const files = { [manifestPath]: manifest, [executable]: payload, "mcp-server.json": "{}" };
  const checksums = Buffer.from(JSON.stringify({
    algorithm: "sha256",
    files: Object.fromEntries(Object.entries(files).map(([path, bytes]) => [path, sha256(bytes)])),
  }));
  const zip = new JSZip();
  for (const [path, bytes] of Object.entries(files)) {
    zip.file(path, bytes, { unixPermissions: path === executable ? 0o100755 : 0o100644 });
  }
  zip.file(checksumPath, checksums);
  zip.file(".ling-plugin/provenance.json", JSON.stringify({ schemaVersion: 1, artifactId }));
  const bytes = await zip.generateAsync({ type: "nodebuffer", platform: "UNIX" });
  const artifact: LingPluginArtifactDescriptor = {
    artifactId, pluginId, version, platform: "darwin", arch: "arm64", channel: "stable",
    url: `https://github.com/ling-stack-org/ling-plugin-chrome-browser/releases/download/v${version}/plugin.zip`,
    sizeBytes: bytes.length, sha256: sha256(bytes),
    signature: `ed25519:${sign(null, bytes, key).toString("base64")}`,
    runtimeChecksumSignature: `ed25519:${sign(null, Buffer.concat([
      Buffer.from(OFFICIAL_PLUGIN_RUNTIME_SIGNATURE_CONTEXT), checksums,
    ]), key).toString("base64")}`,
  };
  return { artifact, bytes };
}

function sha256(bytes: string | Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}
