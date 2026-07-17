import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { createCompositeSecretResolver } from "@ling-stack/core";
import { createDaemonServer } from "../dist/index.js";
import {
  createCapturedStoreFactory,
  seedManagedCuaProvider,
} from "./computer-use-test-fixtures.mjs";

test("daemon manages MCP servers, discovered tools, and teammate bindings without exposing secrets", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-mcp-api-"));
  const broker = new FakeMcpBroker();
  const daemon = await startDaemonForTest(broker);
  try {
    const created = await postJson(`${daemon.url}/mcp/servers?cwd=${encodeURIComponent(cwd)}`, {
      id: "mcp_github",
      displayName: "GitHub",
      transport: {
        type: "streamable-http",
        url: "https://api.githubcopilot.com/mcp/",
        headers: { "X-Client": "Ling Stack" },
        secretHeaderRefs: { Authorization: "env:MCP_AUTHORIZATION" },
      },
      required: true,
      enabledTools: ["list_pull_requests"],
    });

    assert.equal(created.server.id, "mcp_github");
    assert.equal(created.server.secretConfigured.Authorization, true);
    assert.equal(JSON.stringify(created).includes("secret-token"), false);

    const listed = await getJson(`${daemon.url}/mcp/servers?cwd=${encodeURIComponent(cwd)}`);
    assert.deepEqual(listed.servers.map((server) => server.id), ["mcp_github"]);
    assert.equal(listed.servers[0].secretConfigured.Authorization, true);
    assert.equal(JSON.stringify(listed).includes("secret-token"), false);

    const checked = await postJson(`${daemon.url}/mcp/servers/${encodeURIComponent(created.server.id)}/check?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(checked.statusSnapshot.status, "ready");
    assert.equal(checked.server.status.kind, "ready");
    assert.equal(broker.checks[0].resolvedSecret.value, "Bearer secret-token");

    const synced = await postJson(`${daemon.url}/mcp/servers/${encodeURIComponent(created.server.id)}/sync-tools?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(synced.statusSnapshot.status, "ready");
    assert.deepEqual(synced.tools.map((tool) => [tool.rawName, tool.defaultApproval]), [
      ["list_pull_requests", "allow"],
      ["merge_pull_request", "ask"],
    ]);

    const tools = await getJson(`${daemon.url}/mcp/tools?cwd=${encodeURIComponent(cwd)}`);
    assert.deepEqual(tools.tools.map((tool) => tool.rawName), ["list_pull_requests", "merge_pull_request"]);

    const teammateId = "teammate_builtin_engineer";
    const bindings = await putJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/mcp?cwd=${encodeURIComponent(cwd)}`, {
      bindings: [
        {
          serverId: created.server.id,
          mode: "selected",
          selectedToolNames: ["list_pull_requests"],
          approvalOverrides: { merge_pull_request: "deny" },
          enabled: true,
        },
      ],
    });
    assert.deepEqual(bindings.bindings.map((binding) => [binding.serverId, binding.selectedToolNames]), [
      ["mcp_github", ["list_pull_requests"]],
    ]);

    const loadedBindings = await getJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/mcp?cwd=${encodeURIComponent(cwd)}`);
    assert.deepEqual(loadedBindings.bindings.map((binding) => binding.serverId), ["mcp_github"]);

    const deleted = await fetch(`${daemon.url}/mcp/servers/${encodeURIComponent(created.server.id)}?cwd=${encodeURIComponent(cwd)}`, {
      method: "DELETE",
    });
    assert.equal(deleted.status, 200);
    const afterDelete = await getJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/mcp?cwd=${encodeURIComponent(cwd)}`);
    assert.deepEqual(afterDelete.bindings, []);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("generic MCP routes reject managed-plugin reserved server ids", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-mcp-reserved-"));
  const { capture, storeFactory } = createCapturedStoreFactory();
  const daemon = await startDaemonForTest(undefined, undefined, { storeFactory });
  try {
    for (const id of ["mcp_cua_driver", "mcp:cua-driver"]) {
      const created = await requestJson(`${daemon.url}/mcp/servers?cwd=${encodeURIComponent(cwd)}`, {
        method: "POST",
        body: {
          id,
          displayName: "Forged Cua Driver",
          transport: {
            type: "streamable-http",
            url: "http://127.0.0.1:19999/mcp",
          },
        },
      });
      assert.equal(created.status, 409);
      assert.equal(created.json.error, "mcp_server_id_reserved");
    }

    assert.ok(capture.store);
    seedManagedCuaProvider(capture.store);
    const updated = await requestJson(
      `${daemon.url}/mcp/servers/${encodeURIComponent("mcp_cua_driver")}?cwd=${encodeURIComponent(cwd)}`,
      {
        method: "PATCH",
        body: {
          displayName: "Forged Cua Driver",
          transport: {
            type: "streamable-http",
            url: "http://127.0.0.1:19999/mcp",
          },
        },
      },
    );
    assert.equal(updated.status, 409);
    assert.equal(updated.json.error, "mcp_server_id_reserved");
    const deleted = await requestJson(
      `${daemon.url}/mcp/servers/${encodeURIComponent("mcp_cua_driver")}?cwd=${encodeURIComponent(cwd)}`,
      { method: "DELETE" },
    );
    assert.equal(deleted.status, 409);
    assert.equal(deleted.json.error, "mcp_server_id_reserved");
    assert.equal(capture.store.getMcpServer("mcp_cua_driver")?.transport.type, "stdio");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("daemon rejects removed MCP secret writes and serves status snapshots without live checks", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-mcp-boundary-"));
  const broker = new FakeMcpBroker();
  const daemon = await startDaemonForTest(broker);
  try {
    const rawSecretCreate = await requestJson(`${daemon.url}/mcp/servers?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      body: {
        id: "mcp_raw_secret",
        displayName: "Raw secret",
        transport: {
          type: "streamable-http",
          url: "https://api.example.test/mcp",
          secretHeaderRefs: { Authorization: "env:MCP_AUTHORIZATION" },
        },
        secrets: { Authorization: "raw-secret-value" },
      },
    });
    assert.equal(rawSecretCreate.status, 400);
    assert.equal(rawSecretCreate.json.error, "bad_request");
    assert.match(rawSecretCreate.json.message, /secret refs and status snapshots/);

    const legacyTransportCreate = await requestJson(`${daemon.url}/mcp/servers?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      body: {
        id: "mcp_legacy_secret_names",
        displayName: "Legacy secret names",
        transport: {
          type: "streamable-http",
          url: "https://api.example.test/mcp",
          secretHeaderNames: ["Authorization"],
        },
      },
    });
    assert.equal(legacyTransportCreate.status, 400);
    assert.equal(legacyTransportCreate.json.error, "bad_request");
    assert.match(legacyTransportCreate.json.message, /legacy-only/);

    const created = await postJson(`${daemon.url}/mcp/servers?cwd=${encodeURIComponent(cwd)}`, {
      id: "mcp_status_only",
      displayName: "Status only",
      transport: {
        type: "streamable-http",
        url: "https://api.example.test/mcp",
        secretHeaderRefs: { Authorization: "env:MCP_AUTHORIZATION" },
      },
    });

    const removedSecretEndpoint = await requestJson(`${daemon.url}/mcp/servers/${encodeURIComponent(created.server.id)}/secret?cwd=${encodeURIComponent(cwd)}`, {
      method: "GET",
    });
    assert.equal(removedSecretEndpoint.status, 410);
    assert.equal(removedSecretEndpoint.json.error, "mcp_secret_endpoint_removed");

    const emptyStatus = await getJson(`${daemon.url}/mcp/servers/${encodeURIComponent(created.server.id)}/status?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(emptyStatus.statusSnapshot, null);
    assert.equal(broker.checks.length, 0);

    const removedPatchFields = await requestJson(`${daemon.url}/mcp/servers/${encodeURIComponent(created.server.id)}?cwd=${encodeURIComponent(cwd)}`, {
      method: "PATCH",
      body: {
        clearSecretNames: ["Authorization"],
      },
    });
    assert.equal(removedPatchFields.status, 400);
    assert.equal(removedPatchFields.json.error, "bad_request");
    assert.match(removedPatchFields.json.message, /secret refs and status snapshots/);

    const checked = await postJson(`${daemon.url}/mcp/servers/${encodeURIComponent(created.server.id)}/check?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(checked.statusSnapshot.status, "ready");
    assert.equal(broker.checks.length, 1);

    const persistedStatus = await getJson(`${daemon.url}/mcp/servers/${encodeURIComponent(created.server.id)}/status?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(persistedStatus.statusSnapshot.status, "ready");
    assert.equal(persistedStatus.statusSnapshot.serverId, created.server.id);
    assert.equal(broker.checks.length, 1);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("daemon MCP check fails closed with a status snapshot when secret refs are missing", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-mcp-missing-ref-"));
  const daemon = await startDaemonForTest(undefined, undefined, {
    secretResolver: createCompositeSecretResolver({ env: {} }),
  });
  try {
    const created = await postJson(`${daemon.url}/mcp/servers?cwd=${encodeURIComponent(cwd)}`, {
      id: "mcp_missing_secret",
      displayName: "Missing secret",
      transport: {
        type: "streamable-http",
        url: "https://api.example.test/mcp",
        secretHeaderRefs: { Authorization: "env:MISSING_MCP_AUTHORIZATION" },
      },
    });
    assert.equal(created.server.secretStatuses[0].configured, false);
    assert.equal(created.server.secretStatuses[0].errorCode, "secret_missing");

    const checked = await requestJson(`${daemon.url}/mcp/servers/${encodeURIComponent(created.server.id)}/check?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      body: {},
    });
    assert.equal(checked.status, 400);
    assert.equal(checked.json.error, "mcp_check_failed");
    assert.equal(checked.json.statusSnapshot.status, "failed");
    assert.equal(checked.json.statusSnapshot.errorCode, "mcp_secret_missing");
    assert.deepEqual(checked.json.statusSnapshot.missingSecretRefs, ["env:MISSING_MCP_AUTHORIZATION"]);
    assert.match(checked.json.statusSnapshot.message, /MISSING_MCP_AUTHORIZATION/);

    const persistedStatus = await getJson(`${daemon.url}/mcp/servers/${encodeURIComponent(created.server.id)}/status?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(persistedStatus.statusSnapshot.status, "failed");
    assert.equal(persistedStatus.statusSnapshot.errorCode, "mcp_secret_missing");
    assert.deepEqual(persistedStatus.statusSnapshot.missingSecretRefs, ["env:MISSING_MCP_AUTHORIZATION"]);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("runs snapshot only explicitly authorized teammate MCP tools", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-mcp-run-"));
  const broker = new FakeMcpBroker();
  const runner = new SnapshotRunner();
  const daemon = await startDaemonForTest(broker, runner);
  try {
    const created = await postJson(`${daemon.url}/mcp/servers?cwd=${encodeURIComponent(cwd)}`, {
      id: "mcp_github",
      displayName: "GitHub",
      transport: {
        type: "streamable-http",
        url: "https://api.githubcopilot.com/mcp/",
        secretHeaderRefs: { Authorization: "env:MCP_RUN_AUTHORIZATION" },
      },
    });
    await postJson(`${daemon.url}/mcp/servers/${encodeURIComponent(created.server.id)}/sync-tools?cwd=${encodeURIComponent(cwd)}`, {});

    const teammateId = "teammate_builtin_engineer";
    await putJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/mcp?cwd=${encodeURIComponent(cwd)}`, {
      bindings: [
        {
          serverId: created.server.id,
          mode: "selected",
          selectedToolNames: ["list_pull_requests"],
          enabled: true,
        },
      ],
    });

    const { runId } = await postRunAndCollectEvents(daemon.url, {
      cwd,
      teammateId,
      task: {
        id: "task_mcp_snapshot",
        title: "Inspect assigned MCP tools",
        prompt: "Check the available external tool access.",
      },
      provider: {
        provider: "static-chat",
        model: "static-model",
      },
      tools: ["read"],
    });
    assert.ok(runId);

    const run = await getJson(`${daemon.url}/runs/${encodeURIComponent(runId)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(run.teammateId, teammateId);
    assert.equal(run.requestSnapshot.mcpToolAccess.teammateId, teammateId);
    assert.equal(run.requestSnapshot.mcpToolAccess.totalToolCount, 1);
    assert.deepEqual(run.requestSnapshot.mcpToolAccess.servers.map((server) => server.serverId), ["mcp_github"]);
    assert.deepEqual(run.requestSnapshot.mcpToolAccess.servers[0].tools.map((tool) => tool.rawName), ["list_pull_requests"]);
    assert.deepEqual(run.requestSnapshot.mcpToolAccess.servers[0].configuredSecretNames, ["Authorization"]);
    assert.deepEqual(run.requestSnapshot.mcpToolAccess.servers[0].missingSecretRefs, []);
    assert.equal(JSON.stringify(run).includes("run-secret-token"), false);
    assert.equal(JSON.stringify(run).includes("merge_pull_request"), false);
    assert.equal(runner.runs.length, 1);
    assert.deepEqual(runner.runs[0].mcpTools.map((tool) => tool.rawName), ["list_pull_requests"]);
    assert.equal(runner.mcpResults[0].content[0].text, "called list_pull_requests");
    assert.equal(JSON.stringify(runner.mcpResults[0]).includes("run-secret-token"), false);
    assert.match(JSON.stringify(runner.mcpResults[0]), /\[REDACTED\]/);
    assert.equal(broker.calls[0].toolName, "list_pull_requests");
    assert.deepEqual(broker.calls[0].input, { repository: "openclaw/ling-stack" });
    assert.equal(broker.calls[0].resolvedSecret.value, "Bearer run-secret-token");
    const events = await getJson(`${daemon.url}/runs/${encodeURIComponent(runId)}/events?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(JSON.stringify(events).includes("run-secret-token"), false);
    assert.match(JSON.stringify(events), /\[REDACTED\]/);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

class FakeMcpBroker {
  constructor() {
    this.checks = [];
    this.calls = [];
  }

  async checkServer(server, options) {
    const resolvedSecret = options.secretResolver.resolve("env:MCP_AUTHORIZATION", "custom_header");
    const now = options.now();
    const expiresAt = new Date(Date.parse(now) + 5 * 60 * 1000).toISOString();
    this.checks.push({ server, resolvedSecret });
    return {
      statusSnapshot: {
        serverId: server.id,
        status: "ready",
        authStatus: {
          kind: "configured",
          refs: ["env:MCP_AUTHORIZATION"],
          missingRefs: [],
        },
        missingSecretRefs: [],
        message: "Connected",
        checkedAt: now,
        expiresAt,
      },
    };
  }

  async listTools(server, options) {
    const now = options.now();
    const expiresAt = new Date(Date.parse(now) + 5 * 60 * 1000).toISOString();
    return {
      statusSnapshot: {
        serverId: server.id,
        status: "ready",
        authStatus: {
          kind: "configured",
          refs: ["env:MCP_AUTHORIZATION"],
          missingRefs: [],
        },
        missingSecretRefs: [],
        message: "2 tools discovered",
        checkedAt: now,
        expiresAt,
        toolCount: 2,
      },
      tools: [
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
    };
  }

  async callTool(server, options, toolName, input) {
    const resolvedSecret = options.secretResolver.resolve("env:MCP_RUN_AUTHORIZATION", "custom_header");
    this.calls.push({ server, resolvedSecret, toolName, input });
    return {
      content: [{ type: "text", text: `called ${toolName}` }],
      details: { ok: true, note: `broker observed ${resolvedSecret.value}` },
    };
  }
}

class SnapshotRunner {
  constructor() {
    this.runs = [];
    this.mcpResults = [];
  }

  async runTask(options) {
    this.runs.push({
      cwd: options.cwd,
      taskId: options.task.id,
      provider: options.provider.provider,
      model: options.provider.model,
      mcpTools: options.mcpTools ?? [],
    });
    const firstMcpTool = options.mcpTools?.[0];
    let firstMcpResult;
    if (firstMcpTool && options.onMcpToolCall) {
      firstMcpResult = await options.onMcpToolCall({
        toolCallId: "tool_mcp_proxy",
        registeredName: firstMcpTool.registeredName,
        serverId: firstMcpTool.serverId,
        rawName: firstMcpTool.rawName,
        input: { repository: "openclaw/ling-stack" },
        task: options.task,
        cwd: options.cwd,
        defaultApproval: firstMcpTool.defaultApproval,
      });
      this.mcpResults.push(firstMcpResult);
    }
    options.onEvent?.({
      type: "run_start",
      taskId: options.task.id,
      cwd: options.cwd,
      provider: options.provider.provider,
      model: options.provider.model,
    });
    if (firstMcpTool && firstMcpResult) {
      options.onEvent?.({
        type: "tool_end",
        toolCallId: "tool_mcp_proxy",
        toolName: firstMcpTool.registeredName,
        result: firstMcpResult,
        isError: false,
      });
    }
    options.onEvent?.({
      type: "run_end",
      taskId: options.task.id,
      messageCount: 1,
    });
    return {
      taskId: options.task.id,
      events: [],
      messages: [{ role: "assistant", content: "done" }],
    };
  }
}

async function startDaemonForTest(mcpBroker, runner, options = {}) {
  const secretResolver = options.secretResolver ?? createCompositeSecretResolver({
    env: {
      MCP_AUTHORIZATION: "Bearer secret-token",
      MCP_RUN_AUTHORIZATION: "Bearer run-secret-token",
    },
  });
  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0 }, {
    secretResolver,
    ...(mcpBroker ? { mcpBroker } : {}),
    ...(runner ? { runner } : {}),
    ...(options.storeFactory ? { storeFactory: options.storeFactory } : {}),
  });
  await daemon.start();
  const address = daemon.server.address();
  assert.ok(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => daemon.stop(),
  };
}

async function postRunAndCollectEvents(baseUrl, body) {
  const response = await fetch(`${baseUrl}/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    assert.fail(`${response.status} ${response.statusText}: ${await response.text()}`);
  }
  const events = parseSseText(await response.text());
  return {
    events,
    runId: events.find((event) => event.event === "ready")?.data.runId,
  };
}

function parseSseText(text) {
  const events = [];
  for (const block of text.trim().split(/\n\n+/)) {
    if (!block.trim()) {
      continue;
    }
    let event = "message";
    const dataLines = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) {
        event = line.slice("event:".length).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:".length).trim());
      }
    }
    if (dataLines.length === 0 || dataLines.join("").trim().length === 0) {
      continue;
    }
    events.push({ event, data: JSON.parse(dataLines.join("\n")) });
  }
  return events;
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

async function requestJson(url, options) {
  const response = await fetch(url, {
    method: options.method,
    headers: options.body === undefined ? undefined : { "Content-Type": "application/json" },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return {
    status: response.status,
    json: await response.json(),
  };
}

async function putJson(url, body) {
  const response = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    assert.fail(`${response.status} ${response.statusText}: ${await response.text()}`);
  }
  return await response.json();
}
