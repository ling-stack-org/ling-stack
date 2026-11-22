import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import JSZip from "jszip";
import { resolveStoragePaths } from "@ling-stack/core";
import {
  OFFICIAL_PLUGIN_RUNTIME_SIGNATURE_CONTEXT,
  readVerifiedOfficialPluginRuntime,
} from "@ling-stack/core/official-plugin-runtime";
import type { LingPluginArtifactDescriptor, LingPluginCatalog } from "@ling-stack/plugin-sdk";
import { startDaemon } from "../dist/index.js";
import { installRemotePluginArtifact } from "../dist/features/plugins/remote-package.js";

const pluginId = "official:office-documents";
const executable = "runtime/ling-office-driver";
const manifestPath = ".ling-plugin/plugin.json";
const checksumPath = ".ling-plugin/checksums.json";
const platform = process.platform as LingPluginArtifactDescriptor["platform"];
const arch = process.arch as LingPluginArtifactDescriptor["arch"];

test("native plugin installs from a clean workspace and can roll back offline from a second workspace", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ling-native-plugin-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pem = publicKey.export({ format: "pem", type: "spki" }).toString();
  const catalogFile = join(root, "catalog.json");
  const artifactDir = join(root, "dist");
  for (const [name, value] of Object.entries({
    LING_STACK_HOME: join(root, "config"),
    LING_PLUGIN_ARTIFACT_PUBLIC_KEY: pem,
    LING_PLUGIN_CATALOG_FILE: catalogFile,
    LING_PLUGIN_ARTIFACT_DIR: artifactDir,
  })) {
    const previous = process.env[name];
    process.env[name] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
  }
  const firstWorkspace = join(root, "workspace");
  const secondWorkspace = join(root, "other-workspace");
  await Promise.all([mkdir(firstWorkspace), mkdir(secondWorkspace), mkdir(artifactDir)]);
  const paths = resolveStoragePaths(firstWorkspace, { workspaceStateLocation: "repo-local" }).workspace;
  const now = "2026-11-22T00:00:00.000Z";
  const first = await createArtifact(privateKey, "1.0.0", "first");
  const second = await createArtifact(privateKey, "1.1.0", "second");
  const catalog: LingPluginCatalog = {
    schemaVersion: 1,
    generatedAt: now,
    source: { repository: "ling-stack-org/ling-stack", releaseTag: "local-dev" },
    plugins: [{
      pluginId, displayName: "Office", trustSummary: "Test plugin.",
      latestStableVersion: first.artifact.version,
      manifest: { contributions: [] },
      artifacts: [{
        ...first.artifact,
        url: first.artifact.url.replace("/v1.0.0/", "/local-dev/"),
      }],
    }],
  };
  await Promise.all([
    writeFile(catalogFile, JSON.stringify(catalog)),
    writeFile(join(artifactDir, "plugin.zip"), first.bytes),
  ]);
  const install = (asset: Awaited<ReturnType<typeof createArtifact>>) => installRemotePluginArtifact({
    paths, now, artifact: asset.artifact, lingVersion: "0.6.1", catalogVersion: now,
    fetchImpl: async () => new Response(new Uint8Array(asset.bytes)),
  });
  const readRuntime = () => readVerifiedOfficialPluginRuntime({
    pluginId, executable, lingVersion: "0.6.1", platform, arch, publicKey: pem,
  });

  const daemon = await startDaemon({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: firstWorkspace });
  try {
    const address = daemon.server.address();
    assert.ok(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}/plugins`;
    const route = `${base}/${encodeURIComponent(pluginId)}`;
    const cwd = (path: string) => `?cwd=${encodeURIComponent(path)}`;
    assert.equal(await readRuntime(), undefined);
    const initial = await fetch(`${route}/install-remote${cwd(firstWorkspace)}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    });
    const initialInstall = await initial.json();
    assert.equal(initial.status, 200, initialInstall.message);
    assert.match(initialInstall.package.cacheRef, /^host\/official-remote\//u);
    assert.notEqual(initialInstall.plugin.status, "enabled");
    assert.equal((await readRuntime())?.version, "1.0.0");
    const enable = await fetch(`${route}/enable${cwd(firstWorkspace)}`, { method: "POST" });
    assert.equal(enable.status, 200);

    assert.equal((await install(second)).previousVersion, "1.0.0");
    const reinstalled = await Promise.all([install(second), install(second)]);
    assert.deepEqual(reinstalled.map((result) => result.previousVersion), ["1.0.0", "1.0.0"]);
    const latest = await readRuntime();
    assert.equal(latest?.version, "1.1.0");
    assert.equal(await readFile(latest!.executablePath, "utf8"), "second");
    const updated = await fetch(route + cwd(firstWorkspace));
    assert.equal(updated.status, 200);
    assert.equal((await updated.json()).plugin.package.version, "1.1.0");

    const collection = await fetch(base + cwd(secondWorkspace));
    assert.equal(collection.status, 200);
    const shared = (await collection.json()).plugins.find((plugin: { id: string }) => plugin.id === pluginId);
    assert.notEqual(shared.status, "enabled");
    assert.equal(shared.package.version, "1.1.0");
    assert.equal(shared.package.previousVersion, "1.0.0");
    assert.equal(shared.actions.canRollback, true);

    await writeFile(latest!.executablePath, "changed");
    await assert.rejects(readRuntime, /checksum changed/u);
    await unlink(catalogFile);
    const rollback = await fetch(`${route}/rollback${cwd(secondWorkspace)}`, { method: "POST" });
    const rolledBack = await rollback.json();
    assert.equal(rollback.status, 200, rolledBack.message);
    assert.equal(rolledBack.package.version, "1.0.0");
    const firstAfterRollback = await fetch(route + cwd(firstWorkspace));
    assert.equal(firstAfterRollback.status, 200);
    const refreshed = (await firstAfterRollback.json()).plugin;
    assert.equal(refreshed.status, "enabled");
    assert.equal(refreshed.package.version, "1.0.0");
  } finally {
    await daemon.stop();
  }
  const restored = await readRuntime();
  assert.equal(restored?.version, "1.0.0");
  assert.equal(await readFile(restored!.executablePath, "utf8"), "first");

  await writeFile(join(restored!.root, checksumPath), '{"algorithm":"sha256","files":{}}');
  await assert.rejects(readRuntime, /signature is invalid/u);
});

async function createArtifact(key: KeyObject, version: string, payload: string) {
  const artifactId = `${pluginId}-${version}-${platform}-${arch}`;
  const manifest = JSON.stringify({
    id: pluginId, displayName: "Office", trustSummary: "Test plugin.",
    version, sourceKind: "official-remote", trustLevel: "official",
    manifestVersion: 2, lingInterfaceVersion: "2", artifactId, platform, arch,
    contributions: [{ kind: "mcp-server", id: "mcp:official-office-documents", path: "./mcp-server.json" }],
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
    artifactId, pluginId, version, platform, arch, channel: "stable",
    url: `https://github.com/ling-stack-org/ling-plugin-office-documents/releases/download/v${version}/plugin.zip`,
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
