import assert from "node:assert/strict";
import test from "node:test";
import { comparePluginVersions, fetchOfficialPluginCatalog, selectOfficialPluginArtifact } from "../dist/features/plugins/remote-catalog.js";

const catalog = {
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

function artifact(version, channel) {
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
