import assert from "node:assert/strict";
import test from "node:test";
import {
  validateLingPluginPackageManifest,
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
