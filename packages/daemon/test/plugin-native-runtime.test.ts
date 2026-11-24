import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import JSZip from "jszip";
import { LING_PRODUCT_VERSION } from "@ling-stack/contracts";
import { createSqliteRunStore, resolveStoragePaths } from "@ling-stack/core";
import {
  OFFICIAL_PLUGIN_RUNTIME_SIGNATURE_CONTEXT,
  isOfficialNativePluginId,
  readVerifiedOfficialPluginRuntime,
} from "@ling-stack/core/official-plugin-runtime";
import type { LingPluginArtifactDescriptor, LingPluginCatalog } from "@ling-stack/plugin-sdk";
import type { McpBroker } from "../dist/context.js";
import type { BundledPluginIndexEntry } from "../dist/features/plugins/bundled-index.js";
import { startDaemon } from "../dist/index.js";
import { createCuaDriverDescriptor, CUA_DRIVER_MCP_SERVER_ID, CUA_DRIVER_PLUGIN_ID,
  isCuaDriverPlatformSupported } from "../dist/features/plugins/presets.js";
import { installRemotePluginArtifact, readCurrentPluginPointer } from "../dist/features/plugins/remote-package.js";

const pluginId = "official:office-documents";
const executable = "runtime/ling-office-driver";
const manifestPath = ".ling-plugin/plugin.json";
const checksumPath = ".ling-plugin/checksums.json";
const platform = process.platform as LingPluginArtifactDescriptor["platform"];
const arch = process.arch as LingPluginArtifactDescriptor["arch"];

test("packaged plugin discovery supports a Desktop without bundled plugin resources", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ling-packaged-plugin-index-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const resourcesPath = join(root, "Resources");
  const indexPath = join(resourcesPath, "app.asar", "dist", "daemon", "bundled-index.mjs");
  await mkdir(dirname(indexPath), { recursive: true });
  await copyFile(new URL("../dist/features/plugins/bundled-index.js", import.meta.url), indexPath);

  const probe = `
    process.resourcesPath = process.argv[2];
    const { listBundledPluginIndexEntries } = await import(process.argv[1]);
    console.log(JSON.stringify(listBundledPluginIndexEntries()));
  `;
  const entries = (): readonly BundledPluginIndexEntry[] => JSON.parse(execFileSync(process.execPath, [
    "--input-type=module", "--eval", probe, pathToFileURL(indexPath).href, resourcesPath,
  ], { cwd: root, encoding: "utf8" }));
  assert.deepEqual(entries(), []);

  const bundledRoot = join(resourcesPath, "bundled", "cua-driver");
  await mkdir(bundledRoot, { recursive: true });
  assert.deepEqual(entries().map(({ id, packageRoot }) => [id, packageRoot]), [[CUA_DRIVER_PLUGIN_ID, bundledRoot]]);
});

test("native plugin installs from a clean workspace and can roll back offline from a second workspace", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ling-native-plugin-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pem = publicKey.export({ format: "pem", type: "spki" }).toString();
  const catalogFile = join(root, "catalog.json");
  const artifactDir = join(root, "dist");
  setFixtureEnvironment(t, {
    LING_STACK_HOME: join(root, "config"),
    LING_PLUGIN_ARTIFACT_PUBLIC_KEY: pem,
    LING_PLUGIN_CATALOG_FILE: catalogFile,
    LING_PLUGIN_ARTIFACT_DIR: artifactDir,
  });
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

test("a failed plugin health check keeps the current selection when rollback cannot support Ling", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ling-plugin-rollback-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  setFixtureEnvironment(t, { LING_STACK_HOME: join(root, "config") });

  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const paths = resolveStoragePaths(workspace, { workspaceStateLocation: "repo-local" }).workspace;
  const now = "2026-11-22T00:00:00.000Z";
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const artifactPublicKey = publicKey.export({ format: "pem", type: "spki" }).toString();
  const id = "official:rollback-fixture";
  const previousLingVersion = "0.1.0";
  const first = await createArtifact(privateKey, "1.0.0", "previous", { id, maxLingVersion: previousLingVersion });
  const second = await createArtifact(privateKey, "1.1.0", "current", { id });
  const install = (asset: Awaited<ReturnType<typeof createArtifact>>, lingVersion: string) => installRemotePluginArtifact({
    paths, now, artifact: asset.artifact, lingVersion, catalogVersion: now, artifactPublicKey,
    fetchImpl: async () => new Response(new Uint8Array(asset.bytes)),
  });
  await install(first, previousLingVersion);
  const current = await install(second, LING_PRODUCT_VERSION);
  assert.equal(current.previousVersion, first.artifact.version);
  const descriptor = current.plugin.validation.compiledDescriptor;
  assert.ok(descriptor);

  const daemon = await startDaemon({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: workspace }, {
    storeFactory: (cwd) => {
      const store = createSqliteRunStore(cwd, paths);
      store.upsertManagedPlugin({ id, sourceKind: "official-remote", version: descriptor.version, enabled: true, descriptor }, now);
      store.upsertManagedPluginPackage({
        pluginId: id, sourceKind: "official-remote", version: descriptor.version, status: "installed",
        cacheRef: current.cacheRef, packageHash: current.packageHash,
        manifestJson: JSON.stringify(current.plugin.manifest), previousVersion: current.previousVersion,
      }, now);
      return store;
    },
  });
  try {
    const address = daemon.server.address();
    assert.ok(address && typeof address === "object");
    const response = await fetch(`http://127.0.0.1:${address.port}/plugins/${encodeURIComponent(id)}/check?cwd=${encodeURIComponent(workspace)}`, {
      method: "POST",
    });
    const result = await response.json();
    assert.equal(response.status, 400);
    assert.equal(result.error, "plugin_linked_resource_missing");
    assert.equal(result.plugin.package.version, second.artifact.version);
    assert.equal((await readCurrentPluginPointer(paths, id))?.cacheRef, current.cacheRef);
  } finally {
    await daemon.stop();
  }
});

test("a failed native health check keeps the selected package and live Cua runtime", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ling-cua-rollback-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  setFixtureEnvironment(t, {
    LING_STACK_HOME: join(root, "config"),
    LING_PLUGIN_ARTIFACT_PUBLIC_KEY: publicKey.export({ format: "pem", type: "spki" }).toString(),
  });
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const paths = resolveStoragePaths(workspace, { workspaceStateLocation: "repo-local" }).workspace;
  const now = "2026-11-22T00:00:00.000Z";
  const id = CUA_DRIVER_PLUGIN_ID;
  const first = await createArtifact(privateKey, "1.0.0", "previous", { id });
  const second = await createArtifact(privateKey, "1.1.0", "current", { id });
  const install = (asset: Awaited<ReturnType<typeof createArtifact>>) => installRemotePluginArtifact({
    paths, now, artifact: asset.artifact, lingVersion: LING_PRODUCT_VERSION, catalogVersion: now,
    fetchImpl: async () => new Response(new Uint8Array(asset.bytes)),
  });
  await install(first);
  const current = await install(second);
  assert.equal(current.previousVersion, first.artifact.version);
  const liveDescriptor = createCuaDriverDescriptor();
  const liveTransport = { type: "streamable-http" as const, url: "http://127.0.0.1:2/", headers: {}, secretHeaderRefs: {} };
  const probes: string[] = [];
  const mcpBroker: McpBroker = {
    async checkServer(server) {
      probes.push(server.id);
      return { statusSnapshot: {
        serverId: server.id, checkedAt: now, expiresAt: now, status: "failed", missingSecretRefs: [],
        authStatus: { kind: "not_required", refs: [], missingRefs: [] }, errorCode: "mcp_process_failed",
      } };
    },
    async listTools() { assert.fail("rollback cannot inspect tools from a runtime pending restart"); },
    async callTool() { assert.fail("rollback cannot call a runtime pending restart"); },
  };
  const store = createSqliteRunStore(workspace, paths);
  store.upsertManagedPlugin({ id, sourceKind: "official-remote", version: liveDescriptor.version, enabled: true, descriptor: liveDescriptor }, now);
  store.createMcpServer({ id: CUA_DRIVER_MCP_SERVER_ID, displayName: "Live Cua", transport: liveTransport, enabled: true, required: false }, now);
  store.replaceManagedPluginContributions(id, [{
    contributionKind: "mcp-server", contributionId: CUA_DRIVER_MCP_SERVER_ID, linkedResourceId: CUA_DRIVER_MCP_SERVER_ID, enabled: true,
  }], now);
  const daemon = await startDaemon({
    host: "127.0.0.1", port: 0, defaultWorkspaceCwd: workspace,
    cuaDriver: { catalogManaged: true, bundledEmbedded: { darwin: false, win32: false } },
  }, { storeFactory: () => store, mcpBroker });
  try {
    const address = daemon.server.address();
    assert.ok(address && typeof address === "object");
    assert.deepEqual(store.getMcpServer(CUA_DRIVER_MCP_SERVER_ID)?.transport, liveTransport);
    const response = await fetch(`http://127.0.0.1:${address.port}/plugins/${encodeURIComponent(id)}/check?cwd=${encodeURIComponent(workspace)}`, {
      method: "POST",
    });
    const result = await response.json();
    assert.equal(response.status, 400);
    assert.equal(result.error, isCuaDriverPlatformSupported() ? "mcp_process_failed" : "plugin_platform_blocked");
    assert.equal((await readCurrentPluginPointer(paths, id))?.cacheRef, current.cacheRef);
    assert.equal(result.plugin.package.version, second.artifact.version);
    assert.deepEqual(store.getManagedPlugin(id)?.descriptor, liveDescriptor);
    assert.deepEqual(store.getMcpServer(CUA_DRIVER_MCP_SERVER_ID)?.transport, liveTransport);
    assert.deepEqual(probes, isCuaDriverPlatformSupported() ? [CUA_DRIVER_MCP_SERVER_ID] : []);
  } finally {
    await daemon.stop();
  }
});

function setFixtureEnvironment(t: TestContext, entries: Record<string, string>) {
  for (const [name, value] of Object.entries(entries)) {
    const previous = process.env[name];
    process.env[name] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
  }
}

async function createArtifact(key: KeyObject, version: string, payload: string, options?: { id: string; maxLingVersion?: string }) {
  const id = options?.id ?? pluginId;
  const native = isOfficialNativePluginId(id);
  const artifactId = `${id}-${version}-${platform}-${arch}`;
  const compatibility = options?.maxLingVersion ? { maxLingVersion: options.maxLingVersion } : {};
  const manifest = JSON.stringify({
    id, displayName: id === pluginId ? "Office" : "Rollback fixture", trustSummary: "Test plugin.",
    version, sourceKind: "official-remote", trustLevel: "official",
    manifestVersion: 2, lingInterfaceVersion: "2", artifactId, platform, arch, ...compatibility,
    contributions: [{ kind: "mcp-server", id: id === CUA_DRIVER_PLUGIN_ID ? "mcp:cua-driver" : `mcp:${id.replace(":", "-")}`,
      path: "./mcp-server.json" }],
  });
  const files = {
    [manifestPath]: manifest, [executable]: payload,
    "mcp-server.json": id === pluginId ? "{}" : JSON.stringify({ transport: { type: "streamable-http", url: "http://127.0.0.1:1/" } }),
  };
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
    artifactId, pluginId: id, version, platform, arch, channel: "stable", ...compatibility,
    url: native ? `https://github.com/ling-stack-org/ling-plugin-${id.slice("official:".length)}/releases/download/v${version}/plugin.zip`
      : `https://example.test/${version}/plugin.zip`,
    sizeBytes: bytes.length, sha256: sha256(bytes),
    signature: `ed25519:${sign(null, bytes, key).toString("base64")}`,
    ...(native ? { runtimeChecksumSignature: `ed25519:${sign(null, Buffer.concat([
      Buffer.from(OFFICIAL_PLUGIN_RUNTIME_SIGNATURE_CONTEXT), checksums,
    ]), key).toString("base64")}` } : {}),
  };
  return { artifact, bytes };
}

function sha256(bytes: string | Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}
