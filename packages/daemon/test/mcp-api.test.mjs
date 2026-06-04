import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { createDaemonServer } from "../dist/index.js";

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
        secretHeaderNames: ["Authorization"],
      },
      required: true,
      enabledTools: ["list_pull_requests"],
      secrets: { Authorization: "Bearer secret-token" },
    });

    assert.equal(created.server.id, "mcp_github");
    assert.equal(created.server.secretConfigured.Authorization, true);
    assert.equal(JSON.stringify(created).includes("secret-token"), false);

    const listed = await getJson(`${daemon.url}/mcp/servers?cwd=${encodeURIComponent(cwd)}`);
    assert.deepEqual(listed.servers.map((server) => server.id), ["mcp_github"]);
    assert.equal(listed.servers[0].secretConfigured.Authorization, true);
    assert.equal(JSON.stringify(listed).includes("secret-token"), false);

    const checked = await postJson(`${daemon.url}/mcp/servers/${encodeURIComponent(created.server.id)}/check?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(checked.server.status.kind, "ready");
    assert.equal(broker.checks[0].secrets.Authorization, "Bearer secret-token");

    const synced = await postJson(`${daemon.url}/mcp/servers/${encodeURIComponent(created.server.id)}/sync-tools?cwd=${encodeURIComponent(cwd)}`, {});
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
        secretHeaderNames: ["Authorization"],
      },
      secrets: { Authorization: "Bearer run-secret-token" },
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
    assert.deepEqual(run.requestSnapshot.mcpToolAccess.servers[0].missingSecretNames, []);
    assert.equal(JSON.stringify(run).includes("run-secret-token"), false);
    assert.equal(JSON.stringify(run).includes("merge_pull_request"), false);
    assert.equal(runner.runs.length, 1);
    assert.deepEqual(runner.runs[0].mcpTools.map((tool) => tool.rawName), ["list_pull_requests"]);
    assert.equal(runner.mcpResults[0].content[0].text, "called list_pull_requests");
    assert.equal(broker.calls[0].toolName, "list_pull_requests");
    assert.deepEqual(broker.calls[0].input, { repository: "openclaw/ling-stack" });
    assert.equal(broker.calls[0].secrets.Authorization, "Bearer run-secret-token");
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

  async checkServer(server, secrets) {
    this.checks.push({ server, secrets });
    return {
      status: {
        kind: "ready",
        message: "Connected",
        checkedAt: "2026-06-03T00:00:00.000Z",
      },
    };
  }

  async listTools() {
    return [
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
    ];
  }

  async callTool(server, secrets, toolName, input) {
    this.calls.push({ server, secrets, toolName, input });
    return {
      content: [{ type: "text", text: `called ${toolName}` }],
      details: { ok: true },
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
    if (firstMcpTool && options.onMcpToolCall) {
      this.mcpResults.push(await options.onMcpToolCall({
        toolCallId: "tool_mcp_proxy",
        registeredName: firstMcpTool.registeredName,
        serverId: firstMcpTool.serverId,
        rawName: firstMcpTool.rawName,
        input: { repository: "openclaw/ling-stack" },
        task: options.task,
        cwd: options.cwd,
        defaultApproval: firstMcpTool.defaultApproval,
      }));
    }
    options.onEvent?.({
      type: "run_start",
      taskId: options.task.id,
      cwd: options.cwd,
      provider: options.provider.provider,
      model: options.provider.model,
    });
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

async function startDaemonForTest(mcpBroker, runner) {
  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0 }, {
    mcpBroker,
    ...(runner ? { runner } : {}),
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
