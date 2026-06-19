import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildLingToolNamespaceCatalog,
  defaultApprovalToolDecisions,
} from "../dist/index.js";

test("builds core tool namespace without granting denied execution", () => {
  const catalog = buildLingToolNamespaceCatalog({
    approvalPolicy: {
      toolDecisions: {
        ...defaultApprovalToolDecisions,
        write: "deny",
      },
    },
    skills: [
      { id: "ship", requiredTools: ["read", "grep", "bash"] },
      { id: "docs", requiredTools: ["read", "write"] },
    ],
    runners: [
      { id: "read-runner", status: "enabled", supportedTools: ["read", "grep", "find", "ls"] },
    ],
    generatedAt: "2026-06-19T03:00:00.000Z",
  });

  const core = catalog.namespaces.find((namespace) => namespace.id === "core");
  assert.ok(core);
  const read = core.tools.find((tool) => tool.name === "read");
  const bash = core.tools.find((tool) => tool.name === "bash");
  const write = core.tools.find((tool) => tool.name === "write");

  assert.equal(catalog.generatedAt, "2026-06-19T03:00:00.000Z");
  assert.equal(read.enabled, true);
  assert.deepEqual(read.requiredBySkillIds, ["ship", "docs"]);
  assert.deepEqual(read.supportedByRunnerIds, ["read-runner"]);
  assert.equal(bash.enabled, false);
  assert.equal(bash.executionApproval, "ask");
  assert.deepEqual(bash.disabledReasons.map((reason) => reason.code), ["runner_unsupported"]);
  assert.equal(write.enabled, false);
  assert.equal(write.executionApproval, "deny");
  assert.deepEqual(write.disabledReasons.map((reason) => reason.code), ["policy_deny", "runner_unsupported"]);
});

test("builds MCP namespaces while preserving server and tool disabled reasons", () => {
  const now = "2026-06-19T03:00:00.000Z";
  const server = {
    id: "mcp_files",
    workspaceId: "workspace_default",
    displayName: "Files MCP",
    transport: {
      type: "stdio",
      command: "files-mcp",
      args: [],
      env: {},
      secretEnvRefs: {},
    },
    enabled: true,
    required: false,
    status: { kind: "ready" },
    enabledTools: ["read_file", "write_file"],
    disabledTools: ["write_file"],
    createdAt: now,
    updatedAt: now,
  };
  const disabledServer = {
    ...server,
    id: "mcp_disabled",
    displayName: "Disabled MCP",
    enabled: false,
    enabledTools: undefined,
    disabledTools: [],
  };
  const catalog = buildLingToolNamespaceCatalog({
    mcpServers: [server, disabledServer],
    mcpTools: [
      {
        serverId: "mcp_files",
        rawName: "read_file",
        displayName: "Read file",
        inputSchema: { type: "object" },
        callableNamespace: "mcp_files",
        callableName: "read_file",
        sideEffectLevel: "read",
        defaultApproval: "allow",
        enabled: true,
        firstSeenAt: now,
        lastSeenAt: now,
        updatedAt: now,
      },
      {
        serverId: "mcp_files",
        rawName: "write_file",
        displayName: "Write file",
        inputSchema: { type: "object" },
        callableNamespace: "mcp_files",
        callableName: "write_file",
        sideEffectLevel: "write",
        defaultApproval: "ask",
        enabled: true,
        firstSeenAt: now,
        lastSeenAt: now,
        updatedAt: now,
      },
      {
        serverId: "mcp_disabled",
        rawName: "danger",
        displayName: "Danger",
        inputSchema: { type: "object" },
        callableNamespace: "mcp_disabled",
        callableName: "danger",
        sideEffectLevel: "external",
        defaultApproval: "deny",
        enabled: true,
        firstSeenAt: now,
        lastSeenAt: now,
        updatedAt: now,
      },
    ],
  });

  const files = catalog.namespaces.find((namespace) => namespace.id === "mcp:mcp_files");
  const disabled = catalog.namespaces.find((namespace) => namespace.id === "mcp:mcp_disabled");
  assert.ok(files);
  assert.ok(disabled);
  assert.equal(files.tools.find((tool) => tool.name === "read_file").enabled, true);
  const write = files.tools.find((tool) => tool.name === "write_file");
  assert.equal(write.enabled, false);
  assert.deepEqual(write.disabledReasons.map((reason) => reason.code), ["server_disabled_tools_includes"]);
  const danger = disabled.tools.find((tool) => tool.name === "danger");
  assert.equal(danger.enabled, false);
  assert.equal(danger.executionApproval, "deny");
  assert.deepEqual(danger.disabledReasons.map((reason) => reason.code), ["server_disabled", "policy_deny"]);
});
