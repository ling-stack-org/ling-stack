import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  DEFAULT_WORKSPACE_ID,
  createSqliteRunStore,
} from "../../core/dist/index.js";
import { createDaemonServer } from "../dist/index.js";

test("tool surfaces api exposes policy and MCP-disabled catalog state", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-tool-surfaces-"));
  const store = createSqliteRunStore(cwd);
  const daemon = createDaemonServer({
    host: "127.0.0.1",
    port: 0,
    defaultWorkspaceCwd: cwd,
  }, {
    runner: new NoopRunner(),
    storeFactory: () => store,
  });

  try {
    seedToolSurfaceFixture(store, cwd);
    await daemon.start();
    const baseUrl = serverBaseUrl(daemon);

    const body = await getJson(`${baseUrl}/tool-surfaces?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(body.cwd, cwd);
    assert.equal(body.catalog.schemaVersion, 1);

    const core = body.catalog.namespaces.find((namespace) => namespace.id === "core");
    assert.ok(core);
    const write = core.tools.find((tool) => tool.id === "core:write");
    assert.equal(write.executionApproval, "deny");
    assert.equal(write.enabled, false);
    assert.deepEqual(write.disabledReasons.map((reason) => reason.code), ["policy_deny"]);

    const files = body.catalog.namespaces.find((namespace) => namespace.id === "mcp:mcp_files");
    assert.ok(files);
    const readFile = files.tools.find((tool) => tool.name === "read_file");
    assert.equal(readFile.enabled, true);
    assert.deepEqual(readFile.inputSchema.properties.path, { type: "string" });

    const writeFile = files.tools.find((tool) => tool.name === "write_file");
    assert.equal(writeFile.enabled, false);
    assert.deepEqual(writeFile.disabledReasons.map((reason) => reason.code), ["server_disabled_tools_includes"]);
  } finally {
    await daemon.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("tool load requests materialize catalog summary without changing execution approval", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-tool-load-"));
  const store = createSqliteRunStore(cwd);
  const daemon = createDaemonServer({
    host: "127.0.0.1",
    port: 0,
    defaultWorkspaceCwd: cwd,
  }, {
    runner: new NoopRunner(),
    storeFactory: () => store,
  });

  try {
    const fixture = seedToolSurfaceFixture(store, cwd);
    await daemon.start();
    const baseUrl = serverBaseUrl(daemon);

    const response = await postJson(
      `${baseUrl}/runs/${encodeURIComponent(fixture.runId)}/tool-load-requests?cwd=${encodeURIComponent(cwd)}`,
      {
        scope: { kind: "namespace", namespaceId: "mcp:mcp_files" },
        reason: "need schema for reason-secret",
        idempotencyKey: "load-mcp-files-once",
      },
    );

    assert.equal(response.cwd, cwd);
    assert.equal(response.runId, fixture.runId);
    assert.equal(response.materialization.namespaceId, "mcp:mcp_files");
    assert.deepEqual(response.materialization.toolIds, ["mcp:mcp_files:read_file", "mcp:mcp_files:write_file"]);
    assert.equal(response.materialization.materializedToolCount, 2);
    assert.equal(response.materialization.disabledToolCount, 1);
    assert.deepEqual(response.materialization.executionApprovalSummary, { allow: 1, ask: 1, deny: 0 });
    assert.equal(response.materialization.budget.decision, "within_budget");
    assert.equal(response.materialization.budget.requestedToolCount, 2);
    assert.equal(response.materialization.budget.maxMaterializedToolCount, 64);
    assert.equal(response.materialization.budget.mode, "model_known");
    assert.equal(typeof response.materialization.budget.estimatedTokens, "number");
    assert.ok(response.materialization.budget.estimatedTokens > 0);
    assert.ok(response.materialization.budget.remainingBudgetTokens > 0);

    const retry = await postJson(
      `${baseUrl}/runs/${encodeURIComponent(fixture.runId)}/tool-load-requests?cwd=${encodeURIComponent(cwd)}`,
      {
        scope: { kind: "namespace", namespaceId: "mcp:mcp_files" },
        reason: "need schema for reason-secret",
        idempotencyKey: "load-mcp-files-once",
      },
    );
    assert.equal(retry.materialization.id, response.materialization.id);
    assert.deepEqual(retry.materialization.budget, response.materialization.budget);

    assert.equal(store.getApprovalPolicy().toolDecisions.write, "deny");

    const events = store.listRuntimeEvents(fixture.workUnitId, { limit: 10 });
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "tool_namespace_materialized");
    assert.equal(events[0].attemptId, fixture.attemptId);
    assert.deepEqual(events[0].data.executionApprovalSummary, { allow: 1, ask: 1, deny: 0 });
    assert.equal(events[0].data.reasonProvided, true);
    assert.equal(events[0].data.idempotencyKeyProvided, true);
    assert.equal(typeof events[0].data.idempotencyDigest, "string");
    assert.deepEqual(events[0].data.budget, response.materialization.budget);
    const runtimeEventJson = JSON.stringify(events[0].data);
    assert.doesNotMatch(runtimeEventJson, /inputSchema|properties|reason-secret|load-mcp-files-once/);
  } finally {
    await daemon.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("tool load requests reject over-budget namespace materialization before runtime evidence", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-tool-load-budget-"));
  const store = createSqliteRunStore(cwd);
  const daemon = createDaemonServer({
    host: "127.0.0.1",
    port: 0,
    defaultWorkspaceCwd: cwd,
  }, {
    runner: new NoopRunner(),
    storeFactory: () => store,
  });

  try {
    const fixture = seedToolSurfaceFixture(store, cwd);
    seedManyToolServer(store, 65);
    await daemon.start();
    const baseUrl = serverBaseUrl(daemon);

    const response = await postJsonResponse(
      `${baseUrl}/runs/${encodeURIComponent(fixture.runId)}/tool-load-requests?cwd=${encodeURIComponent(cwd)}`,
      {
        scope: { kind: "namespace", namespaceId: "mcp:mcp_many" },
        reason: "need schema for over-budget-secret",
        idempotencyKey: "load-too-many-tools",
      },
    );

    assert.equal(response.status, 413);
    assert.equal(response.body.error, "tool_materialization_over_budget");
    assert.equal(response.body.budget.decision, "over_budget");
    assert.equal(response.body.budget.requestedToolCount, 65);
    assert.equal(response.body.budget.maxMaterializedToolCount, 64);
    assert.equal(response.body.budget.mode, "model_known");
    assert.equal(response.body.budget.overBudgetByTokens, 0);
    assert.equal(store.listRuntimeEvents(fixture.workUnitId, { limit: 10 }).length, 0);
    const errorJson = JSON.stringify(response.body);
    assert.doesNotMatch(errorJson, /inputSchema|over-budget-secret|load-too-many-tools|schema-secret-marker/);
  } finally {
    await daemon.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

function seedToolSurfaceFixture(store, cwd) {
  const now = "2026-06-19T04:00:00.000Z";
  const provider = store.createProviderPreset(
    {
      kind: "openai-compatible",
      displayName: "Tool Surface Provider",
      providerId: "tool-surface",
      model: "tool-surface-model",
      api: "openai-responses",
      capabilities: ["chat", "tool_call"],
      input: ["text"],
      contextWindow: 32768,
      maxTokens: 1024,
      authHeader: false,
      enabled: true,
    },
    now,
  );
  store.updateApprovalPolicy({ toolDecisions: { write: "deny" } }, now);
  store.createMcpServer(
    {
      id: "mcp_files",
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
      enabledTools: ["read_file", "write_file"],
      disabledTools: ["write_file"],
    },
    now,
  );
  store.replaceMcpServerTools(
    "mcp_files",
    [
      {
        rawName: "read_file",
        displayName: "Read file",
        description: "Read a workspace file.",
        inputSchema: { type: "object", properties: { path: { type: "string" } } },
        callableNamespace: "mcp_files",
        callableName: "read_file",
        sideEffectLevel: "read",
        defaultApproval: "allow",
        enabled: true,
      },
      {
        rawName: "write_file",
        displayName: "Write file",
        description: "Write a workspace file.",
        inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } } },
        callableNamespace: "mcp_files",
        callableName: "write_file",
        sideEffectLevel: "write",
        defaultApproval: "ask",
        enabled: true,
      },
    ],
    "2026-06-19T04:00:01.000Z",
  );

  const workUnit = store.createWorkUnit({
    id: "work_unit_tool_surface",
    workspaceId: DEFAULT_WORKSPACE_ID,
    kind: "task_run",
    ownerType: "task",
    ownerId: "task_tool_surface",
    taskId: "task_tool_surface",
    providerPresetId: provider.id,
    idempotencyKey: "work-unit-tool-surface",
    createdByActor: "system",
    request: { prompt: "load tools" },
    now: "2026-06-19T04:00:02.000Z",
  });
  const attempt = store.createWorkUnitAttempt({
    id: "attempt_tool_surface",
    workUnitId: workUnit.id,
    attemptNumber: 1,
    runtimeInstanceId: "runtime_tool_surface",
    runnerId: "pi",
    providerPresetId: provider.id,
    now: "2026-06-19T04:00:03.000Z",
  });
  store.createRun({
    id: "run_tool_surface",
    cwd,
    taskId: "task_tool_surface",
    providerPresetId: provider.id,
    providerName: "test-provider",
    providerModel: "test-model",
    taskSnapshot: {},
    providerSnapshot: {},
    requestSnapshot: {},
    workUnitId: workUnit.id,
    createdAt: "2026-06-19T04:00:04.000Z",
  });
  return {
    runId: "run_tool_surface",
    workUnitId: workUnit.id,
    attemptId: attempt.id,
    providerId: provider.id,
  };
}

function seedManyToolServer(store, toolCount) {
  store.createMcpServer(
    {
      id: "mcp_many",
      displayName: "Many MCP",
      transport: {
        type: "stdio",
        command: "many-mcp",
        args: [],
        env: {},
        secretEnvRefs: {},
      },
      enabled: true,
      required: false,
    },
    "2026-06-19T04:00:05.000Z",
  );
  store.replaceMcpServerTools(
    "mcp_many",
    Array.from({ length: toolCount }, (_, index) => ({
      rawName: `many_tool_${index}`,
      displayName: `Many tool ${index}`,
      description: "Small schema marker should not leak into over-budget errors.",
      inputSchema: { type: "object", properties: { value: { type: "string", description: "schema-secret-marker" } } },
      callableNamespace: "mcp_many",
      callableName: `many_tool_${index}`,
      sideEffectLevel: "read",
      defaultApproval: "allow",
      enabled: true,
    })),
    "2026-06-19T04:00:06.000Z",
  );
}

function serverBaseUrl(daemon) {
  const address = daemon.server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

class NoopRunner {
  async runTask() {
    return { events: [], messages: [] };
  }
}

async function getJson(url) {
  const response = await fetch(url);
  const text = await response.text();
  const body = text.trim() ? JSON.parse(text) : {};
  if (!response.ok) {
    assert.fail(JSON.stringify(body));
  }
  return body;
}

async function postJson(url, input) {
  const response = await postJsonResponse(url, input);
  if (response.status < 200 || response.status >= 300) {
    assert.fail(JSON.stringify(response.body));
  }
  return response.body;
}

async function postJsonResponse(url, input) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const text = await response.text();
  const body = text.trim() ? JSON.parse(text) : {};
  return { status: response.status, body };
}
