import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createDaemonServer } from "../dist/index.js";

function createMemorySecretStore() {
  const secrets = new Map();
  return {
    secrets,
    status(ref) {
      return { ref, kind: "keychain", configured: secrets.has(ref) };
    },
    resolve(ref) {
      const value = secrets.get(ref);
      return value === undefined ? { ref, configured: false } : { ref, configured: true, value };
    },
    setSecret(ref, value) {
      secrets.set(ref, value);
      return { ref, kind: "keychain", configured: true };
    },
    deleteSecret(ref) {
      secrets.delete(ref);
      return { ref, kind: "keychain", configured: false };
    },
  };
}

async function startDaemonForTest(dependencies = {}) {
  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0 }, dependencies);
  await daemon.start();
  const address = daemon.server.address();
  assert.ok(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => daemon.stop(),
  };
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    assert.fail(`${response.status} ${response.statusText}: ${await response.text()}`);
  }
  return await response.json();
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    assert.fail(`${response.status} ${response.statusText}: ${await response.text()}`);
  }
  return await response.json();
}

const SECRET_ENV_VALUE = "test-secret-env-value-0123456789abcdefghij";
const SECRET_HEADER_VALUE = "test-secret-header-value-0123456789abcdefgh";

async function withFixtureHome(fixtureFiles, run) {
  const home = await mkdtemp(resolve(tmpdir(), "ling-stack-plugin-import-"));
  for (const [relativePath, content] of Object.entries(fixtureFiles)) {
    const target = join(home, relativePath);
    await mkdir(resolve(target, ".."), { recursive: true });
    await writeFile(target, content);
  }
  const originalHome = process.env.HOME;
  process.env.HOME = home;
  assert.equal(homedir(), home);
  try {
    return await run(home);
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    await rm(home, { recursive: true, force: true });
  }
}

const codexTomlWithSecret = `
[mcp_servers.demo]
command = "uvx"
args = ["demo-mcp"]

[mcp_servers.demo.env]
API_KEY = "${SECRET_ENV_VALUE}"
LOG_LEVEL = "debug"
`;

test("plugin import preview masks codex secret values and never returns plaintext", async () => {
  await withFixtureHome({ ".codex/config.toml": codexTomlWithSecret }, async () => {
    const daemon = await startDaemonForTest();
    const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-plugin-import-cwd-"));
    try {
      const preview = await postJson(`${daemon.url}/plugins/import/preview?cwd=${encodeURIComponent(cwd)}`, {
        source: "codex-config-toml",
      });
      assert.equal(preview.sourceFound, true);
      assert.equal(preview.candidates.length, 1);
      const candidate = preview.candidates[0];
      assert.equal(candidate.name, "demo");
      assert.equal(candidate.status, "new");
      assert.equal(candidate.transportSummary, "uvx demo-mcp");
      assert.equal(candidate.secrets.length, 1);
      assert.equal(candidate.secrets[0].field, "API_KEY");
      assert.equal(candidate.secrets[0].needsInput, false);
      assert.equal(candidate.secrets[0].masked.endsWith(SECRET_ENV_VALUE.slice(-4)), true);
      assert.equal(JSON.stringify(preview).includes(SECRET_ENV_VALUE), false);
    } finally {
      await daemon.close();
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

test("plugin import apply creates a disabled trusted-local plugin and is idempotent", async () => {
  await withFixtureHome({ ".codex/config.toml": codexTomlWithSecret }, async () => {
    const secretStore = createMemorySecretStore();
    const daemon = await startDaemonForTest({ externalSecretStore: secretStore });
    const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-plugin-import-apply-"));
    try {
      const report = await postJson(`${daemon.url}/plugins/import/apply?cwd=${encodeURIComponent(cwd)}`, {
        source: "codex-config-toml",
        names: ["demo"],
      });
      assert.equal(report.imported.length, 1);
      assert.ok(report.imported[0].pluginId.startsWith("trusted-local:"));
      assert.equal(report.secretsMigrated, 1);
      assert.equal(report.secretsNeedsInput, 0);
      assert.equal(JSON.stringify(report).includes(SECRET_ENV_VALUE), false);

      const storedRef = [...secretStore.secrets.keys()][0];
      assert.ok(storedRef.startsWith("keychain:import-codex-config-toml-demo-api_key-"));
      assert.equal(secretStore.secrets.get(storedRef), SECRET_ENV_VALUE);

      const pluginDetail = await getJson(`${daemon.url}/plugins/${encodeURIComponent(report.imported[0].pluginId)}?cwd=${encodeURIComponent(cwd)}`);
      assert.equal(pluginDetail.plugin.sourceKind, "trusted-local-preset");
      assert.equal(pluginDetail.plugin.status, "disabled");
      assert.equal(pluginDetail.plugin.events.some((event) => event.type === "installed"), true);

      const servers = await getJson(`${daemon.url}/mcp/servers?cwd=${encodeURIComponent(cwd)}`);
      const server = servers.servers.find((entry) => entry.id === report.imported[0].mcpServerId);
      assert.ok(server);
      assert.equal(server.enabled, false);
      assert.equal(Object.keys(server.transport.secretEnvRefs).length, 1);
      assert.equal(server.transport.env.API_KEY, undefined);
      assert.equal(server.transport.env.LOG_LEVEL, "debug");

      const repeat = await postJson(`${daemon.url}/plugins/import/apply?cwd=${encodeURIComponent(cwd)}`, {
        source: "codex-config-toml",
        names: ["demo"],
      });
      assert.equal(repeat.imported.length, 0);
      assert.equal(repeat.skipped.length, 1);
      assert.equal(repeat.skipped[0].reason, "unchanged");

      const catalog = await getJson(`${daemon.url}/plugins?cwd=${encodeURIComponent(cwd)}`);
      assert.equal(catalog.plugins.filter((plugin) => plugin.displayName.startsWith("demo")).length, 1);
    } finally {
      await daemon.close();
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

test("plugin import apply keeps both candidates when the same display name carries a different transport", async () => {
  await withFixtureHome({
    ".codex/config.toml": `
[mcp_servers.demo]
command = "uvx"
args = ["demo-mcp"]
`,
  }, async () => {
    const daemon = await startDaemonForTest({ externalSecretStore: createMemorySecretStore() });
    const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-plugin-import-conflict-"));
    try {
      await postJson(`${daemon.url}/plugins?cwd=${encodeURIComponent(cwd)}`, {
        displayName: "demo",
        description: "hand-written twin",
        transport: { type: "stdio", command: "npx", args: ["other-mcp"], env: {}, secretEnvRefs: {} },
      });
      const report = await postJson(`${daemon.url}/plugins/import/apply?cwd=${encodeURIComponent(cwd)}`, {
        source: "codex-config-toml",
        names: ["demo"],
      });
      assert.equal(report.imported.length, 1);
      const catalog = await getJson(`${daemon.url}/plugins?cwd=${encodeURIComponent(cwd)}`);
      const names = catalog.plugins.filter((plugin) => plugin.displayName.includes("demo")).map((plugin) => plugin.displayName);
      assert.equal(names.length, 2);
      assert.equal(names.some((name) => name.includes("来自")), true);
    } finally {
      await daemon.close();
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

test("plugin import preview strips secret headers from claude plugin manifests", async () => {
  await withFixtureHome({
    ".claude/plugins/cache/demo-mkt/sample-plugin/1.0.0/.mcp.json": JSON.stringify({
      mcpServers: {
        stitch: {
          type: "http",
          url: "https://stitch.example.com/mcp",
          headers: { "X-Goog-Api-Key": SECRET_HEADER_VALUE, Accept: "application/json" },
        },
      },
    }),
  }, async () => {
    const daemon = await startDaemonForTest();
    const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-plugin-import-claude-"));
    try {
      const preview = await postJson(`${daemon.url}/plugins/import/preview?cwd=${encodeURIComponent(cwd)}`, {
        source: "claude-plugin-mcp",
      });
      assert.equal(preview.sourceFound, true);
      assert.equal(preview.candidates.length, 1);
      const candidate = preview.candidates[0];
      assert.equal(candidate.name, "plugin:sample-plugin:stitch");
      assert.equal(candidate.transportSummary, "https://stitch.example.com/mcp");
      const secretFields = candidate.secrets.map((secret) => secret.field);
      assert.deepEqual(secretFields, ["X-Goog-Api-Key"]);
      assert.equal(JSON.stringify(preview).includes(SECRET_HEADER_VALUE), false);
    } finally {
      await daemon.close();
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

test("plugin import previews Claude global and project servers and dsh cordis inserts", async () => {
  await withFixtureHome({
    ".claude.json": JSON.stringify({
      mcpServers: {
        global: { command: "npx", args: ["global-mcp"] },
      },
      projects: {
        "/workspace/demo": {
          mcpServers: {
            project: { url: "https://project.example.com/mcp" },
          },
        },
      },
    }),
    ".dsh/cordis.patch.yml": [
      "insert:",
      "  - name: \"@deepseek-ai/dsh-mcp-client\"",
      "    id: dsh-demo",
      "    config:",
      "      serverName: dsh-demo",
      "      transport: stdio",
      "      command: npx",
      "      args:",
      "        - dsh-mcp",
    ].join("\n"),
  }, async () => {
    const daemon = await startDaemonForTest();
    const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-plugin-import-multi-source-"));
    try {
      const claude = await postJson(`${daemon.url}/plugins/import/preview?cwd=${encodeURIComponent(cwd)}`, {
        source: "claude-user-json",
      });
      assert.equal(claude.sourceFound, true);
      assert.deepEqual(claude.candidates.map((candidate) => candidate.name), [
        "global",
        "/workspace/demo:project",
      ]);
      assert.equal(claude.candidates[1].displayName, "project (/workspace/demo)");

      const dsh = await postJson(`${daemon.url}/plugins/import/preview?cwd=${encodeURIComponent(cwd)}`, {
        source: "dsh-cordis-patch",
      });
      assert.equal(dsh.sourceFound, true);
      assert.equal(dsh.candidates.length, 1);
      assert.equal(dsh.candidates[0].name, "dsh-demo");
      assert.equal(dsh.candidates[0].transportSummary, "npx dsh-mcp");
    } finally {
      await daemon.close();
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

test("uninstalling an imported plugin disables its MCP contribution and records the event", async () => {
  await withFixtureHome({
    ".codex/config.toml": `
[mcp_servers.demo]
command = "uvx"
args = ["demo-mcp"]
`,
  }, async () => {
    const daemon = await startDaemonForTest({ externalSecretStore: createMemorySecretStore() });
    const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-plugin-import-uninstall-"));
    try {
      const report = await postJson(`${daemon.url}/plugins/import/apply?cwd=${encodeURIComponent(cwd)}`, {
        source: "codex-config-toml",
        names: ["demo"],
      });
      const pluginId = report.imported[0].pluginId;
      const result = await postJson(`${daemon.url}/plugins/${encodeURIComponent(pluginId)}/uninstall?cwd=${encodeURIComponent(cwd)}`, {
        reason: "L1 acceptance cleanup",
      });
      assert.equal(result.plugin.status, "disabled");
      assert.equal(result.plugin.events.some((event) => event.type === "uninstalled"), true);

      const servers = await getJson(`${daemon.url}/mcp/servers?cwd=${encodeURIComponent(cwd)}`);
      const server = servers.servers.find((entry) => entry.id === report.imported[0].mcpServerId);
      assert.ok(server);
      assert.equal(server.enabled, false);
    } finally {
      await daemon.close();
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

test("claude command import creates a skill draft and reports inline-execution degradation", async () => {
  await withFixtureHome({
    ".claude/commands/deploy-check.md": [
      "---",
      "name: Deploy Check",
      "description: Verify the deploy target is healthy.",
      "---",
      "",
      "Run the smoke suite with !`npm run smoke` and report failures first.",
    ].join("\n"),
  }, async () => {
    const daemon = await startDaemonForTest();
    const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-plugin-import-commands-"));
    try {
      const preview = await postJson(`${daemon.url}/plugins/import/preview?cwd=${encodeURIComponent(cwd)}`, {
        source: "claude-commands",
      });
      assert.equal(preview.sourceFound, true);
      assert.equal(preview.candidates.length, 1);
      assert.equal(preview.candidates[0].kind, "command");
      assert.equal(preview.candidates[0].status, "new");
      assert.deepEqual(preview.candidates[0].inlineExecutions, ["npm run smoke"]);

      const report = await postJson(`${daemon.url}/plugins/import/apply?cwd=${encodeURIComponent(cwd)}`, {
        source: "claude-commands",
        names: ["deploy-check"],
      });
      assert.equal(report.imported.length, 1);
      assert.ok(report.imported[0].draftId);
      assert.equal(report.imported[0].skillId, "deploy-check");
      assert.equal(report.degradations.length, 1);
      assert.equal(report.degradations[0].includes("npm run smoke"), true);

      const repeat = await postJson(`${daemon.url}/plugins/import/apply?cwd=${encodeURIComponent(cwd)}`, {
        source: "claude-commands",
        names: ["deploy-check"],
      });
      assert.equal(repeat.imported.length, 0);
      assert.equal(repeat.skipped.length, 1);
      assert.equal(repeat.skipped[0].reason, "unchanged");
    } finally {
      await daemon.close();
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

test("plugin import rejects unknown sources without touching the store", async () => {
  const daemon = await startDaemonForTest();
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-plugin-import-badsource-"));
  try {
    const response = await fetch(`${daemon.url}/plugins/import/preview?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: "not-a-source" }),
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error, "bad_request");
    assert.equal(body.message.includes("Plugin import source must be one of"), true);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
