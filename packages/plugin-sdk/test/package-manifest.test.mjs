import assert from "node:assert/strict";
import test from "node:test";
import {
  validateLingPluginPackageManifest,
  validateLingPluginArtifactDescriptor,
  validateLingPluginCatalog,
} from "../dist/index.js";

function validManifest(overrides = {}) {
  return {
    id: "bundled:test-plugin",
    displayName: "Test Plugin",
    version: "0.1.0",
    lingInterfaceVersion: "1",
    sourceKind: "bundled",
    trustLevel: "internal",
    description: "A bundled test plugin.",
    trustSummary: "Runs only through declared Ling plugin boundaries.",
    contributions: [
      { kind: "mcp-server", id: "mcp:test", path: "./mcp-server.json" },
      { kind: "skill-pack", id: "skill-pack:test", path: "./skills" },
    ],
    requiredSecrets: [
      { ref: "TEST_API_KEY", label: "Test API key", required: true },
    ],
    defaultApprovals: [
      { contributionId: "mcp:test", decision: "ask", reason: "External tool." },
    ],
    healthChecks: [
      { id: "manifest", label: "Manifest", kind: "descriptor" },
    ],
    ...overrides,
  };
}

test("package manifest validator accepts valid bundled package manifests", () => {
  assert.doesNotThrow(() => validateLingPluginPackageManifest(validManifest()));
});

test("package manifest validator rejects invalid required fields and interface versions", () => {
  assert.throws(() => validateLingPluginPackageManifest(validManifest({ id: "" })), /id/);
  assert.throws(() => validateLingPluginPackageManifest(validManifest({ version: "next" })), /version/);
  assert.throws(() => validateLingPluginPackageManifest(validManifest({ lingInterfaceVersion: "99" })), /interface/);
});

test("package manifest validator rejects duplicate and unsupported contributions", () => {
  assert.throws(
    () =>
      validateLingPluginPackageManifest(validManifest({
        contributions: [
          { kind: "mcp-server", id: "mcp:duplicate", path: "./one.json" },
          { kind: "skill-pack", id: "mcp:duplicate", path: "./skills" },
        ],
      })),
    /duplicate/i,
  );
  assert.throws(
    () =>
      validateLingPluginPackageManifest(validManifest({
        contributions: [
          { kind: "hook", id: "hook:test", path: "./hook.js" },
        ],
      })),
    /unsupported/i,
  );
});

test("package manifest validator rejects secret values in manifest metadata", () => {
  assert.throws(
    () =>
      validateLingPluginPackageManifest(validManifest({
        requiredSecrets: [
          { ref: "TEST_API_KEY", label: "Test API key", value: "sk-secret-token" },
        ],
      })),
    /secret value/i,
  );
});

test("distribution validators accept official platform artifacts and catalogs", () => {
  const artifact = {
    artifactId: "bundled:cua-driver-0.2.0-darwin-arm64",
    pluginId: "bundled:cua-driver",
    version: "0.2.0",
    platform: "darwin",
    arch: "arm64",
    channel: "stable",
    url: "https://github.com/ling-stack-org/ling-stack/releases/download/plugin-0.2.0/cua.ling-plugin.zip",
    sizeBytes: 1234,
    sha256: "a".repeat(64),
  };
  assert.doesNotThrow(() => validateLingPluginArtifactDescriptor(artifact));
  assert.doesNotThrow(() => validateLingPluginCatalog({
    schemaVersion: 1,
    generatedAt: "2026-11-18T00:00:00.000Z",
    source: { repository: "ling-stack-org/ling-stack", releaseTag: "plugin-0.2.0" },
    plugins: [{
      pluginId: artifact.pluginId,
      displayName: "Cua Driver",
      trustSummary: "Official plugin.",
      latestStableVersion: artifact.version,
      manifest: { contributions: [], requiredSecrets: [], defaultApprovals: [], healthChecks: [] },
      artifacts: [artifact],
    }],
  }));
  assert.throws(() => validateLingPluginArtifactDescriptor({ ...artifact, url: "http://example.test/plugin.zip" }), /HTTPS/);
  assert.throws(() => validateLingPluginArtifactDescriptor({ ...artifact, sha256: "not-a-hash" }), /SHA-256/);
});
