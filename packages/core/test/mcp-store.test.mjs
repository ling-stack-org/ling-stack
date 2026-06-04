import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  createBuiltinAiTeammateId,
  createSqliteRunStore,
} from "../dist/index.js";

test("sqlite persists MCP servers, secrets, discovered tools, and teammate bindings", async () => {
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
          secretHeaderNames: ["Authorization"],
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
    assert.deepEqual(server.enabledTools, ["list_pull_requests", "get_ci_status"]);

    store.setMcpServerSecret(server.id, "Authorization", "Bearer secret-token", now);
    assert.equal(store.hasMcpServerSecret(server.id, "Authorization"), true);
    assert.equal(store.getMcpServerSecret(server.id, "Authorization"), "Bearer secret-token");

    const checked = store.updateMcpServerStatus(
      server.id,
      {
        kind: "ready",
        message: "2 tools discovered",
        checkedAt: "2026-06-03T00:01:00.000Z",
      },
      "2026-06-03T00:01:00.000Z",
    );
    assert.equal(checked?.status.kind, "ready");

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
      assert.equal(reopened.hasMcpServerSecret(server.id, "Authorization"), true);
      assert.deepEqual(reopened.listMcpTools({ serverId: server.id }).map((tool) => tool.rawName), [
        "list_pull_requests",
        "merge_pull_request",
      ]);
      assert.deepEqual(reopened.listTeammateMcpBindings(engineerId).map((binding) => binding.serverId), [server.id]);

      assert.equal(reopened.deleteMcpServer(server.id), true);
      assert.equal(reopened.getMcpServer(server.id), undefined);
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
