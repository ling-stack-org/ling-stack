import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync, sign } from "node:crypto";
import type { LingPluginArtifactDescriptor, LingPluginCatalog } from "@ling-stack/plugin-sdk";
import { downloadPluginBytes } from "../dist/features/plugins/plugin-download.js";
import { comparePluginVersions, fetchOfficialPluginCatalog, selectOfficialPluginArtifact } from "../dist/features/plugins/remote-catalog.js";

const catalog: LingPluginCatalog = {
  schemaVersion: 1,
  generatedAt: "2026-11-21T00:00:00.000Z",
  source: { repository: "ling-stack-org/ling-stack", releaseTag: "plugins-1.0.0" },
  plugins: [{
    pluginId: "official:test",
    displayName: "Test plugin",
    trustSummary: "Official test plugin.",
    latestStableVersion: "1.2.0",
    manifest: { contributions: [] },
    artifacts: [
      artifact("1.0.0", "stable"),
      artifact("1.2.0", "stable"),
      artifact("2.0.0-beta.1", "beta"),
      artifact("2.0.0-beta.2", "beta"),
    ],
  }],
};

test("selects the newest artifact within the requested channel and device", () => {
  assert.equal(selectOfficialPluginArtifact({
    catalog,
    pluginId: "official:test",
    platform: "darwin",
    arch: "arm64",
  }).version, "1.2.0");
  assert.equal(selectOfficialPluginArtifact({
    catalog,
    pluginId: "official:test",
    platform: "darwin",
    arch: "arm64",
    channel: "beta",
  }).version, "2.0.0-beta.2");
});

test("compares stable releases after prereleases with semver ordering", () => {
  assert.equal(comparePluginVersions("1.2.3", "1.2.3-beta.1") > 0, true);
  assert.equal(comparePluginVersions("2.0.0-beta.2", "2.0.0-beta.10") < 0, true);
  assert.equal(comparePluginVersions("1.10.0", "1.9.9") > 0, true);
});

test("rejects unsigned HTTPS catalogs", async () => {
  const previousKey = process.env.LING_PLUGIN_CATALOG_PUBLIC_KEY;
  delete process.env.LING_PLUGIN_CATALOG_PUBLIC_KEY;
  const fetchImpl = async () => new Response(JSON.stringify(catalog), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  try {
    await assert.rejects(
      fetchOfficialPluginCatalog({ url: "https://example.test/catalog.json", fetchImpl }),
      /signature key is not configured/u,
    );
  } finally {
    if (previousKey === undefined) delete process.env.LING_PLUGIN_CATALOG_PUBLIC_KEY;
    else process.env.LING_PLUGIN_CATALOG_PUBLIC_KEY = previousKey;
  }
});

function artifact(version: string, channel: LingPluginArtifactDescriptor["channel"]): LingPluginArtifactDescriptor {
  return {
    artifactId: `official:test-${version}-${channel}`,
    pluginId: "official:test",
    version,
    platform: "darwin",
    arch: "arm64",
    channel,
    url: `https://example.test/${version}.zip`,
    sizeBytes: 1,
    sha256: "a".repeat(64),
  };
}

test("selects the newest version compatible with the Ling release", () => {
  const entry = catalog.plugins[0]!;
  const current = { ...catalog, plugins: [{
    ...entry,
    artifacts: [
      ...entry.artifacts,
      { ...artifact("3.0.0", "stable"), minLingVersion: "0.8.0" },
    ],
  }] };
  assert.equal(selectOfficialPluginArtifact({
    catalog: current, pluginId: entry.pluginId, platform: "darwin", arch: "arm64",
    lingVersion: "0.7.0",
  }).version, "1.2.0");
});

test("verifies the signed standalone catalog without following redirects", async () => {
  const text = JSON.stringify(catalog);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const signature = sign(null, Buffer.from(text), privateKey).toString("base64");
  const fetchImpl: typeof fetch = async (url) => new Response(
    String(url).endsWith("catalog.sig") ? signature : text,
  );
  const result = await fetchOfficialPluginCatalog({
    url: "https://example.test/catalog.json",
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
    fetchImpl,
  });
  assert.equal(result.signatureVerified, true);
  assert.deepEqual(result.catalog, catalog);
});

test("follows an official plugin Release asset redirect to the GitHub CDN", async () => {
  const urls: string[] = [];
  const release = "https://github.com/ling-stack-org/ling-plugin-office-documents/releases/download/v1.0.0/plugin.zip";
  const asset = "https://release-assets.githubusercontent.com/asset";
  const fetchImpl: typeof fetch = async (url, options) => {
    urls.push(String(url));
    assert.equal(options?.redirect, "manual");
    return String(url) === release
      ? new Response(null, { status: 302, headers: { Location: asset } })
      : new Response("plugin");
  };
  const bytes = await downloadPluginBytes({
    url: release, maxBytes: 64, timeoutMs: 1_000, label: "Plugin package", fetchImpl,
  });
  assert.equal(bytes.toString(), "plugin");
  assert.deepEqual(urls, [release, asset]);
});

test("rejects redirects outside GitHub release assets", async () => {
  const fetchImpl: typeof fetch = async () => new Response(null, {
    status: 302, headers: { Location: "https://example.test/plugin.zip" },
  });
  await assert.rejects(downloadPluginBytes({
    url: "https://github.com/ling-stack-org/ling-plugin-office-documents/releases/download/v1.0.0/plugin.zip",
    maxBytes: 64, timeoutMs: 1_000, label: "Plugin package", fetchImpl,
  }), /outside GitHub/u);
});
