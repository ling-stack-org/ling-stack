import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  createBuiltinAiTeammateId,
  createSqliteRunStore,
} from "../dist/index.js";

test("sqlite persists MCP server refs, status snapshots, discovered tools, and teammate bindings", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-mcp-store-"));
  const store = createSqliteRunStore(cwd);
  const now = "2026-06-03T00:00:00.000Z";
  const engineerId = createBuiltinAiTeammateId("engineer");
  try {
    const server = store.createMcpServer(
      {
        id: "mcp_github",
        displayName: "GitHub",
        transport: {
          type: "streamable-http",
          url: "https://api.githubcopilot.com/mcp/",
          headers: { "X-Client": "Ling Stack" },
          secretHeaderRefs: { Authorization: "env:GITHUB_TOKEN" },
        },
        enabled: true,
        required: true,
        startupTimeoutSec: 12,
        toolTimeoutSec: 30,
        enabledTools: ["list_pull_requests", "get_ci_status"],
      },
      now,
    );

    assert.equal(server.id, "mcp_github");
    assert.equal(server.status.kind, "unknown");
    assert.equal(server.transport.type, "streamable-http");
    assert.deepEqual(server.transport.secretHeaderRefs, { Authorization: "env:GITHUB_TOKEN" });
    assert.deepEqual(server.enabledTools, ["list_pull_requests", "get_ci_status"]);
    assert.deepEqual(store.getMcpAuthorityRevision(server.id), {
      serverRevision: 1,
      toolsRevision: 0,
    });
    assert.ok(store.database.prepare(
      "SELECT version FROM schema_migrations WHERE version = 106 AND name = 'add_mcp_authority_revisions'",
    ).get());

    store.updateMcpServer(server.id, { enabled: false }, now);
    store.updateMcpServer(server.id, { enabled: true }, now);
    assert.equal(store.getMcpAuthorityRevision(server.id)?.serverRevision, 3);

    assert.throws(
      () => store.setMcpServerSecret(server.id, "Authorization", "Bearer secret-token", now),
      /raw secret writes are disabled/,
    );
    assert.equal(store.hasMcpServerSecret(server.id, "Authorization"), false);
    assert.equal(store.countLegacyMcpServerSecrets(server.id), 0);

    const checked = store.upsertMcpStatusSnapshot(
      {
        serverId: server.id,
        status: "ready",
        authStatus: {
          kind: "configured",
          refs: ["env:GITHUB_TOKEN"],
          missingRefs: [],
        },
        missingSecretRefs: [],
        message: "2 tools discovered",
        checkedAt: "2026-06-03T00:01:00.000Z",
        expiresAt: "2026-06-03T00:06:00.000Z",
      },
      "2026-06-03T00:01:00.000Z",
    );
    assert.equal(checked.status, "ready");
    assert.equal(store.getMcpStatusSnapshot(server.id)?.status, "ready");

    const tools = store.replaceMcpServerTools(
      server.id,
      [
        {
          rawName: "list_pull_requests",
          displayName: "List pull requests",
          description: "List pull requests for a repository.",
          inputSchema: { type: "object", properties: { repository: { type: "string" } } },
          callableNamespace: "mcp_github",
          callableName: "list_pull_requests",
          sideEffectLevel: "read",
          defaultApproval: "allow",
          enabled: true,
        },
        {
          rawName: "merge_pull_request",
          displayName: "Merge pull request",
          description: "Merge an approved pull request.",
          inputSchema: { type: "object", properties: { number: { type: "number" } } },
          callableNamespace: "mcp_github",
          callableName: "merge_pull_request",
          sideEffectLevel: "external",
          defaultApproval: "ask",
          enabled: true,
        },
      ],
      "2026-06-03T00:02:00.000Z",
    );

    assert.deepEqual(tools.map((tool) => [tool.rawName, tool.defaultApproval]), [
      ["list_pull_requests", "allow"],
      ["merge_pull_request", "ask"],
    ]);
    const firstToolsRevision = store.getMcpAuthorityRevision(server.id)?.toolsRevision;
    assert.ok(firstToolsRevision > 0);

    store.replaceMcpServerTools(server.id, [], now);
    store.replaceMcpServerTools(server.id, tools, now);
    const replacedToolsRevision = store.getMcpAuthorityRevision(server.id)?.toolsRevision;
    assert.ok(replacedToolsRevision > firstToolsRevision);

    const bindings = store.replaceTeammateMcpBindings(
      engineerId,
      [
        {
          serverId: server.id,
          mode: "selected",
          selectedToolNames: ["list_pull_requests"],
          approvalOverrides: { merge_pull_request: "deny" },
          enabled: true,
        },
      ],
      "2026-06-03T00:03:00.000Z",
    );

    assert.deepEqual(bindings.map((binding) => [binding.serverId, binding.mode, binding.selectedToolNames]), [
      ["mcp_github", "selected", ["list_pull_requests"]],
    ]);

    store.close();
    const reopened = createSqliteRunStore(cwd);
    try {
      assert.equal(reopened.getMcpServer(server.id)?.displayName, "GitHub");
      assert.deepEqual(reopened.getMcpAuthorityRevision(server.id), {
        serverRevision: 3,
        toolsRevision: replacedToolsRevision,
      });
      assert.deepEqual(reopened.getMcpServer(server.id)?.transport.secretHeaderRefs, { Authorization: "env:GITHUB_TOKEN" });
      assert.equal(reopened.getMcpStatusSnapshot(server.id)?.status, "ready");
      assert.deepEqual(reopened.listMcpTools({ serverId: server.id }).map((tool) => tool.rawName), [
        "list_pull_requests",
        "merge_pull_request",
      ]);
      assert.deepEqual(reopened.listTeammateMcpBindings(engineerId).map((binding) => binding.serverId), [server.id]);

      assert.equal(reopened.deleteMcpServer(server.id), true);
      assert.equal(reopened.getMcpServer(server.id), undefined);
      assert.equal(reopened.getMcpStatusSnapshot(server.id), undefined);
      assert.equal(reopened.hasMcpServerSecret(server.id, "Authorization"), false);
      assert.deepEqual(reopened.listMcpTools({ serverId: server.id }), []);
      assert.deepEqual(reopened.listTeammateMcpBindings(engineerId), []);
    } finally {
      reopened.close();
    }
  } finally {
    if (store.database?.isOpen) {
      store.close();
    }
    await rm(cwd, { recursive: true, force: true });
  }
});

test("MCP authority revisions survive same-timestamp server delete and recreate ABA", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-mcp-authority-aba-"));
  const store = createSqliteRunStore(cwd);
  const now = "2026-07-21T00:00:00.000Z";
  const input = {
    id: "mcp_recreated",
    displayName: "Recreated MCP",
    transport: {
      type: "stdio",
      command: "/fixture/mcp",
      args: [],
      env: {},
      secretEnvRefs: {},
    },
    enabled: true,
  };
  const tool = {
    rawName: "read_fixture",
    displayName: "Read fixture",
    inputSchema: { type: "object" },
    callableNamespace: "mcp_recreated",
    callableName: "read_fixture",
    sideEffectLevel: "read",
    defaultApproval: "allow",
    enabled: true,
  };
  try {
    store.createMcpServer(input, now);
    store.replaceMcpServerTools(input.id, [tool], now);
    const before = store.getMcpAuthorityRevision(input.id);
    assert.ok(before);

    assert.equal(store.deleteMcpServer(input.id), true);
    store.createMcpServer(input, now);
    store.replaceMcpServerTools(input.id, [tool], now);
    const after = store.getMcpAuthorityRevision(input.id);
    assert.ok(after);
    assert.ok(after.serverRevision > before.serverRevision);
    assert.ok(after.toolsRevision > before.toolsRevision);
    assert.equal(store.getMcpServer(input.id)?.updatedAt, now);
    assert.equal(store.listMcpTools({ serverId: input.id })[0]?.updatedAt, now);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
