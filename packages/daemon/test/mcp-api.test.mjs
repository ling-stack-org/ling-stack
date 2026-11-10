import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { DEFAULT_WORKSPACE_ID, createCompositeSecretResolver, createSqliteRunStore, resolveStoragePaths } from "@ling-stack/core";
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
    assert.equal(broker.calls[0].workspaceCwd, cwd);
    assert.equal(broker.calls[0].signal, runner.signal);
    const events = await getJson(`${daemon.url}/runs/${encodeURIComponent(runId)}/events?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(JSON.stringify(events).includes("run-secret-token"), false);
    assert.match(JSON.stringify(events), /\[REDACTED\]/);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

for (const [olderAction, newerAction] of [
  ["check", "check"],
  ["sync-tools", "sync-tools"],
  ["check", "sync-tools"],
  ["sync-tools", "check"],
]) {
  test(`manual MCP metadata ${olderAction}/${newerAction} preserves the latest started result`, { timeout: 15_000 }, async (t) => {
    const fixture = await createMetadataRaceFixture(t, [olderAction, newerAction]);
    try {
      const olderRequest = fixture.request(olderAction);
      await waitForMetadataEntry(fixture.gates[0], t.signal);
      const newerRequest = fixture.request(newerAction);
      await waitForMetadataEntry(fixture.gates[1], t.signal);

      fixture.gates[1].release();
      const newerResponse = await newerRequest;
      assert.equal(newerResponse.status, 200);
      assert.equal(newerResponse.json.statusSnapshot.message, "metadata-result-1");
      const winningState = fixture.publicationState();
      assert.equal(winningState.statusSnapshot.message, "metadata-result-1");
      assert.deepEqual(winningState.tools.map((tool) => tool.rawName), newerAction === "sync-tools" ? ["metadata_tool_1"] : []);

      fixture.gates[0].release();
      assertMetadataSuperseded(await olderRequest);
      assert.deepEqual(fixture.publicationState(), winningState, "the losing result must not write a snapshot, catalog, or event");
      assert.deepEqual(winningState.events.map((event) => event.action), [newerAction === "check" ? "mcp.status_checked" : "mcp.tools_synced"]);
    } finally {
      await fixture.close();
    }
  });
}

test("manual MCP metadata older completion is rejected while the latest started check is still pending", { timeout: 15_000 }, async (t) => {
  const fixture = await createMetadataRaceFixture(t, ["sync-tools", "check"]);
  try {
    const olderRequest = fixture.request("sync-tools");
    await waitForMetadataEntry(fixture.gates[0], t.signal);
    const newerRequest = fixture.request("check");
    await waitForMetadataEntry(fixture.gates[1], t.signal);
    const beforeCompletion = fixture.publicationState();

    fixture.gates[0].release();
    assertMetadataSuperseded(await olderRequest);
    assert.deepEqual(fixture.publicationState(), beforeCompletion, "latest-started is not first-completer wins");

    fixture.gates[1].release();
    assert.equal((await newerRequest).status, 200);
    assert.equal(fixture.publicationState().statusSnapshot.message, "metadata-result-1");
  } finally {
    await fixture.close();
  }
});

test("manual MCP metadata latest failed check cannot be overwritten by an older success", { timeout: 15_000 }, async (t) => {
  const fixture = await createMetadataRaceFixture(t, ["check", "check"]);
  fixture.gates[1].status = "failed";
  try {
    const olderRequest = fixture.request("check");
    await waitForMetadataEntry(fixture.gates[0], t.signal);
    const newerRequest = fixture.request("check");
    await waitForMetadataEntry(fixture.gates[1], t.signal);

    fixture.gates[1].release();
    const newerResponse = await newerRequest;
    assert.equal(newerResponse.status, 400);
    assert.equal(newerResponse.json.error, "mcp_check_failed");
    assert.equal(newerResponse.json.statusSnapshot.status, "failed");
    const winningState = fixture.publicationState();
    fixture.gates[0].release();
    assertMetadataSuperseded(await olderRequest);
    assert.deepEqual(fixture.publicationState(), winningState);
  } finally {
    await fixture.close();
  }
});

for (const action of ["check", "sync-tools"]) {
  test(`manual MCP metadata ${action} rejects a result captured before transport configuration changed`, { timeout: 15_000 }, async (t) => {
    const fixture = await createMetadataRaceFixture(t, [action]);
    try {
      const pending = fixture.request(action);
      const entry = await waitForMetadataEntry(fixture.gates[0], t.signal);
      const updated = await fixture.mutate("PATCH", {
        transport: { ...entry.server.transport, url: "https://new-metadata-config.example.test/mcp" },
      });
      assert.equal(updated.status, 200);
      const afterMutation = fixture.publicationState();
      fixture.gates[0].release();

      assertMetadataSuperseded(await pending);
      assert.deepEqual(fixture.publicationState(), afterMutation);
      assert.equal(fixture.store.getMcpServer(fixture.serverId).transport.url, "https://new-metadata-config.example.test/mcp");
    } finally {
      await fixture.close();
    }
  });

  test(`manual MCP metadata ${action} rejects same-timestamp deletion and recreation of the same server ID`, { timeout: 15_000 }, async (t) => {
    const fixture = await createMetadataRaceFixture(t, [action]);
    try {
      const pending = fixture.request(action);
      const entry = await waitForMetadataEntry(fixture.gates[0], t.signal);
      const beforeRevision = fixture.store.getMcpAuthorityRevision(fixture.serverId);
      assert.equal(fixture.store.deleteMcpServer(fixture.serverId), true);
      fixture.store.createMcpServer({
        ...fixture.serverInput,
        displayName: "Replacement metadata server",
      }, entry.server.updatedAt);
      assert.equal(fixture.store.getMcpServer(fixture.serverId).updatedAt, entry.server.updatedAt);
      assert.ok(fixture.store.getMcpAuthorityRevision(fixture.serverId).serverRevision > beforeRevision.serverRevision);
      const afterMutation = fixture.publicationState();
      fixture.gates[0].release();

      assertMetadataSuperseded(await pending);
      assert.deepEqual(fixture.publicationState(), afterMutation);
      assert.equal(fixture.store.getMcpServer(fixture.serverId).displayName, "Replacement metadata server");
    } finally {
      await fixture.close();
    }
  });

  test(`manual MCP metadata ${action} preserves the current disabled-server contract`, { timeout: 15_000 }, async (t) => {
    const fixture = await createMetadataRaceFixture(t, [action], { enabled: false });
    try {
      const pending = fixture.request(action);
      const entry = await waitForMetadataEntry(fixture.gates[0], t.signal);
      assert.equal(entry.server.enabled, false);
      fixture.gates[0].release();
      const response = await pending;

      assert.equal(response.status, action === "check" ? 200 : 400);
      if (action === "sync-tools") assert.equal(response.json.error, "mcp_tool_sync_failed");
      assert.equal(response.json.statusSnapshot.status, "disabled");
      assert.equal(response.json.server.enabled, false);
      assert.deepEqual(fixture.publicationState().tools, []);
    } finally {
      await fixture.close();
    }
  });
}

for (const action of ["check", "sync-tools"]) {
  test(`manual MCP metadata committed response ${action} remains one snapshot after a newer publication`, { timeout: 15_000 }, async (t) => {
    const fixture = await createMetadataRaceFixture(t, [action], {
      onMetadataCommitted({ store, publication, commit, cwd }) {
        const request = store.beginMcpMetadataRequest(publication.server.id, "check");
        assert.ok(request);
        const newerPublication = commit({
          request,
          statusSnapshot: {
            ...publication.statusSnapshot,
            status: "failed",
            message: "intervening-metadata-publication",
          },
          cwd,
          now: new Date().toISOString(),
        });
        assert.equal(newerPublication.published, true);
      },
    });
    try {
      const pending = fixture.request(action);
      await waitForMetadataEntry(fixture.gates[0], t.signal);
      fixture.gates[0].release();
      const response = await pending;

      assert.equal(response.status, 200);
      assert.equal(response.json.statusSnapshot.message, "metadata-result-0");
      assert.deepEqual(response.json.server.statusSnapshot, response.json.statusSnapshot, "response fields must project the same committed publication");
      assert.equal(response.json.server.status.kind, "ready");
      assert.equal(fixture.publicationState().statusSnapshot.message, "intervening-metadata-publication");
      assert.equal(fixture.publicationState().statusSnapshot.status, "failed", "the newer durable result remains authoritative");
    } finally {
      await fixture.close();
    }
  });
}

/** Explicit broker-entry and release gates control completion order without timers. */
async function createMetadataRaceFixture(t, actions, options = {}) {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-metadata-race-"));
  const gates = actions.map((action, index) => {
    let resolveEntry;
    let release;
    return {
      action,
      index,
      status: "ready",
      entered: new Promise((resolveEntryPromise) => { resolveEntry = resolveEntryPromise; }),
      released: new Promise((resolveReleasePromise) => { release = resolveReleasePromise; }),
      enter: (entry) => resolveEntry(entry),
      release: () => release(),
    };
  });
  let nextGate = 0;
  async function perform(action, server, brokerOptions) {
    const gate = gates[nextGate++];
    assert.ok(gate, "unexpected broker metadata request");
    assert.equal(gate.action, action);
    const now = brokerOptions.now();
    gate.enter({ server });
    await gate.released;
    const status = server.enabled ? gate.status : "disabled";
    const statusSnapshot = {
      serverId: server.id,
      status,
      authStatus: { kind: "not_required", refs: [], missingRefs: [] },
      missingSecretRefs: [],
      message: `metadata-result-${gate.index}`,
      checkedAt: now,
      expiresAt: "2099-01-01T00:00:00.000Z",
      ...(action === "sync-tools" ? { toolCount: status === "ready" ? 1 : 0 } : {}),
    };
    return {
      statusSnapshot,
      ...(action === "sync-tools" ? { tools: status === "ready" ? [{
        rawName: `metadata_tool_${gate.index}`,
        displayName: `Metadata tool ${gate.index}`,
        inputSchema: { type: "object" },
        callableNamespace: server.id,
        callableName: `metadata_tool_${gate.index}`,
        sideEffectLevel: "read",
        defaultApproval: "allow",
        enabled: true,
      }] : [] } : {}),
    };
  }
  const capture = { store: undefined };
  const storeFactory = (requestedCwd) => {
    assert.equal(requestedCwd, cwd, "metadata fixture must not open another workspace");
    const paths = resolveStoragePaths(requestedCwd, {
      userRootDir: resolve(cwd, "fixture-home"),
      workspaceStateLocation: "user-data-dir",
      env: {},
    }).workspace;
    const store = createSqliteRunStore(requestedCwd, paths);
    if (options.onMetadataCommitted) {
      const commit = store.commitMcpMetadataResult.bind(store);
      let hookConsumed = false;
      store.commitMcpMetadataResult = (input) => {
        const publication = commit(input);
        if (publication.published && !hookConsumed) {
          hookConsumed = true;
          options.onMetadataCommitted({ store, publication, commit, cwd });
        }
        return publication;
      };
    }
    capture.store = store;
    return store;
  };
  const daemon = await startDaemonForTest({
    checkServer: (server, brokerOptions) => perform("check", server, brokerOptions),
    listTools: (server, brokerOptions) => perform("sync-tools", server, brokerOptions),
    async callTool() { throw new Error("metadata tests must not dispatch tools"); },
  }, undefined, { storeFactory, defaultWorkspaceCwd: cwd, secretResolver: createCompositeSecretResolver({ env: {} }) });
  const requests = [];
  const serverInput = {
    id: "mcp_metadata_race",
    displayName: "Metadata race server",
    transport: { type: "streamable-http", url: "https://old-metadata-config.example.test/mcp", headers: {}, secretHeaderRefs: {} },
    enabled: options.enabled !== false,
  };
  const serverUrl = `${daemon.url}/mcp/servers/${serverInput.id}?cwd=${encodeURIComponent(cwd)}`;
  async function send(url, method, body) {
    const pending = fetch(url, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: t.signal,
    }).then(async (response) => ({ status: response.status, json: await response.json() }));
    // Cleanup owns all requests, even when an assertion rejects before awaiting one.
    requests.push(pending);
    void pending.catch(() => {});
    return pending;
  }
  async function close() {
    for (const gate of gates) gate.release();
    await Promise.allSettled(requests);
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
  try {
    const created = await send(`${daemon.url}/mcp/servers?cwd=${encodeURIComponent(cwd)}`, "POST", serverInput);
    assert.equal(created.status, 201);
    assert.ok(capture.store);
    const baselineSeq = capture.store.getLatestControlPlaneEventSeq(DEFAULT_WORKSPACE_ID);
    return {
      gates,
      store: capture.store,
      serverId: serverInput.id,
      serverInput,
      request: (action) => send(`${daemon.url}/mcp/servers/${serverInput.id}/${action}?cwd=${encodeURIComponent(cwd)}`, "POST", {}),
      mutate: (method, body) => send(serverUrl, method, body),
      publicationState: () => ({
        statusSnapshot: capture.store.getMcpStatusSnapshot(serverInput.id),
        tools: capture.store.listMcpTools({ serverId: serverInput.id }),
        events: capture.store.listControlPlaneEvents({ workspaceId: DEFAULT_WORKSPACE_ID, afterSeq: baselineSeq, domains: ["mcp"], entityId: serverInput.id }),
      }),
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

function waitForMetadataEntry(gate, signal) {
  return new Promise((resolveEntry, rejectEntry) => {
    const onAbort = () => rejectEntry(signal.reason ?? new Error("metadata test aborted before broker entry"));
    signal.addEventListener("abort", onAbort, { once: true });
    gate.entered.then((entry) => {
      signal.removeEventListener("abort", onAbort);
      resolveEntry(entry);
    }, (error) => {
      signal.removeEventListener("abort", onAbort);
      rejectEntry(error);
    });
    if (signal.aborted) onAbort();
  });
}

function assertMetadataSuperseded(response) {
  assert.equal(response.status, 409);
  assert.equal(response.json.error, "mcp_metadata_result_superseded");
  for (const field of ["server", "statusSnapshot", "tools"]) {
    assert.equal(Object.hasOwn(response.json, field), false, `stale response must not include ${field}`);
  }
  assert.equal(JSON.stringify(response.json).includes("metadata-result-0"), false);
  assert.equal(JSON.stringify(response.json).includes("old-metadata-config.example.test"), false);
}

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
    options.assertResultCurrent?.();
    this.calls.push({
      server,
      resolvedSecret,
      toolName,
      input,
      workspaceCwd: options.workspaceCwd,
      signal: options.signal,
    });
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
    this.signal = new AbortController().signal;
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
        signal: this.signal,
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
  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0,
    ...(options.defaultWorkspaceCwd ? { defaultWorkspaceCwd: options.defaultWorkspaceCwd } : {}),
  }, {
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
