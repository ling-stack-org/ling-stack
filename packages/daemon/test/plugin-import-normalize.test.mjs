import assert from "node:assert/strict";
import test from "node:test";
import {
  applySecretPolicyToHttp,
  applySecretPolicyToStdio,
  importSecretRefName,
  maskSecretValue,
} from "../dist/features/plugins/import/secret-policy.js";
import {
  classifyImportCandidate,
  existingServerFingerprint,
  fingerprintImportTransport,
  importedDisplayName,
} from "../dist/features/plugins/import/normalize.js";

test("secret policy migrates secret-like env values into pending secrets", () => {
  const result = applySecretPolicyToStdio({
    source: "codex-config-toml",
    serverName: "demo",
    command: "uvx",
    args: ["demo-mcp"],
    env: {
      API_KEY: "test-secret-env-value-0123456789abcdefghij",
      LOG_LEVEL: "debug",
      HOME: "/home/demo",
    },
  });
  assert.equal(result.transport.env.API_KEY, undefined);
  assert.equal(result.transport.env.LOG_LEVEL, "debug");
  assert.deepEqual(Object.keys(result.transport.secretEnvRefs), ["API_KEY"]);
  const ref = result.transport.secretEnvRefs.API_KEY;
  assert.ok(ref.startsWith("keychain:import-codex-config-toml-demo-api_key-"));
  assert.equal(result.pendingSecrets.length, 1);
  assert.equal(result.pendingSecrets[0].value, "test-secret-env-value-0123456789abcdefghij");
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].needsInput, false);
});

test("secret policy flags suspicious high-entropy values as needing input", () => {
  const result = applySecretPolicyToHttp({
    source: "claude-plugin-mcp",
    serverName: "stitch",
    url: "https://stitch.example.com/mcp",
    headers: {
      "X-Client-Fingerprint": "Zx9K2mQ7vL4pR8sT3wY6uB1nC5fH0jD2aE4gI7kM",
      Accept: "application/json",
    },
  });
  assert.equal(result.transport.headers["X-Client-Fingerprint"], "");
  assert.deepEqual(Object.keys(result.transport.secretHeaderRefs), []);
  assert.equal(result.pendingSecrets.length, 0);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].needsInput, true);
});

test("secret policy never masks short plain values", () => {
  const result = applySecretPolicyToStdio({
    source: "claude-user-json",
    serverName: "demo",
    command: "uvx",
    args: [],
    env: { DEBUG: "1", REGION: "cn-north-1" },
  });
  assert.deepEqual(result.transport.env, { DEBUG: "1", REGION: "cn-north-1" });
  assert.deepEqual(result.transport.secretEnvRefs, {});
  assert.equal(result.pendingSecrets.length, 0);
});

test("imported secret refs are deterministic per source/server/field", () => {
  const first = importSecretRefName("codex-config-toml", "demo", "API_KEY");
  const second = importSecretRefName("codex-config-toml", "demo", "API_KEY");
  const other = importSecretRefName("codex-config-toml", "demo", "API_TOKEN");
  assert.equal(first, second);
  assert.notEqual(first, other);
  for (const ref of [first, other]) {
    assert.equal(/\s/.test(ref), false);
  }
});

test("maskSecretValue only exposes the tail", () => {
  assert.equal(maskSecretValue("test-secret-env-value-0123456789abcdefghij"), "…ghij");
  assert.equal(maskSecretValue("short"), "…");
});

test("transport fingerprints are stable and ignore refs and names", () => {
  const base = {
    type: "stdio",
    command: "uvx",
    args: ["demo-mcp"],
    env: { LOG_LEVEL: "debug" },
    secretEnvRefs: { API_KEY: "keychain:import-a" },
  };
  const sibling = {
    type: "stdio",
    command: "uvx",
    args: ["demo-mcp"],
    env: { LOG_LEVEL: "debug" },
    secretEnvRefs: { API_KEY: "keychain:import-totally-different" },
  };
  const reordered = {
    type: "stdio",
    command: "uvx",
    args: ["demo-mcp"],
    env: { LOG_LEVEL: "debug" },
    cwd: undefined,
    secretEnvRefs: {},
  };
  assert.equal(fingerprintImportTransport(base), fingerprintImportTransport(sibling));
  assert.equal(fingerprintImportTransport(base), fingerprintImportTransport(reordered));
  assert.notEqual(
    fingerprintImportTransport(base),
    fingerprintImportTransport({ type: "http", url: "https://x.example/mcp", headers: {}, secretHeaderRefs: {} }),
  );
});

test("existing MCP servers are classified as new, unchanged, or conflict", () => {
  const existingServers = [
    {
      id: "mcp_alpha",
      displayName: "alpha",
      transport: { type: "stdio", command: "uvx", args: ["alpha-mcp"], env: {}, secretEnvRefs: {} },
    },
    {
      id: "mcp_beta",
      displayName: "beta",
      transport: { type: "stdio", command: "npx", args: ["beta-mcp"], env: {}, secretEnvRefs: {} },
    },
  ];
  const candidateOf = (name, command, args) => ({
    kind: "mcp",
    source: "codex-config-toml",
    name,
    displayName: name,
    transport: { type: "stdio", command, args, env: {}, secretEnvRefs: {} },
    fingerprint: fingerprintImportTransport({ type: "stdio", command, args, env: {}, secretEnvRefs: {} }),
    findings: [],
    warnings: [],
  });

  assert.equal(classifyImportCandidate(candidateOf("gamma", "uvx", ["gamma-mcp"]), existingServers).status, "new");
  assert.equal(classifyImportCandidate(candidateOf("beta", "npx", ["beta-mcp"]), existingServers).status, "unchanged");
  const conflict = classifyImportCandidate(candidateOf("beta", "uvx", ["beta-mcp"]), existingServers);
  assert.equal(conflict.status, "conflict");
  assert.equal(importedDisplayName(conflict).includes("Codex"), true);
});

test("existing server fingerprints match reader-side fingerprints for equal transports", () => {
  const serverTransport = { type: "streamable-http", url: "https://x.example/mcp", headers: { Accept: "application/json" }, secretHeaderRefs: {} };
  const candidateTransport = { type: "streamable-http", url: "https://x.example/mcp", headers: { Accept: "application/json" }, secretHeaderRefs: {} };
  assert.equal(existingServerFingerprint(serverTransport), fingerprintImportTransport(candidateTransport));
});
