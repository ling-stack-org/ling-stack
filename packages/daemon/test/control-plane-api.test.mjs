import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { DEFAULT_WORKSPACE_ID, createCompositeSecretResolver, createSqliteRunStore } from "@ling-stack/core";
import { WebSocket } from "ws";
import { createDaemonServer } from "../dist/index.js";
import { checkProviderPreset } from "../dist/features/providers/preflight.js";
import { resolveProviderForRun } from "../dist/features/runs/providers.js";
import { appendApprovalCreatedControlPlaneEvent } from "../dist/features/runs/approvals.js";

test("control-plane snapshot returns requested redacted domains and isolates domain failures", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-control-plane-snapshot-"));
  const daemon = await startDaemonForTest({
    secretResolver: createCompositeSecretResolver({ env: { LOCAL_RELAY_API_KEY: "sk-test-provider-secret-value" } }),
  });
  try {
    const provider = (await postJson(`${daemon.url}/providers?cwd=${encodeURIComponent(cwd)}`, {
      kind: "openai-compatible",
      displayName: "Local Relay",
      providerId: "local-relay",
      model: "gpt-5.5",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:8317/v1",
      apiKeyRef: "env:LOCAL_RELAY_API_KEY",
      capabilities: ["chat", "tool_call"],
      input: ["text"],
      enabled: true,
    })).provider;
    await postJson(`${daemon.url}/mcp/servers?cwd=${encodeURIComponent(cwd)}`, {
      id: "mcp_secret_ref",
      displayName: "Secret MCP",
      transport: {
        type: "streamable-http",
        url: "https://api.example.test/mcp",
        secretHeaderRefs: { Authorization: "env:MCP_AUTHORIZATION" },
      },
      enabled: true,
    });
    await postJson(`${daemon.url}/memory?cwd=${encodeURIComponent(cwd)}`, {
      scopeType: "workspace",
      ownerId: DEFAULT_WORKSPACE_ID,
      title: "Deploy rule",
      body: "forbidden-memory-body sk-test-memory-secret-value",
      sourceKind: "user_explicit",
      confidence: "high",
      reasonCode: "test_fixture",
    });

    const snapshot = await getJson(`${daemon.url}/control-plane/snapshot?cwd=${encodeURIComponent(cwd)}&domains=runs,skills,approvals,providers,memory,mcp,runners,artifacts`);
    assert.equal(snapshot.cwd, cwd);
    assert.equal(snapshot.workspaceId, DEFAULT_WORKSPACE_ID);
    assert.equal(typeof snapshot.latestEventSeq, "number");
    assert.deepEqual(Object.keys(snapshot.domains).sort(), ["approvals", "artifacts", "mcp", "memory", "providers", "runners", "runs", "skills"]);
    assert.equal(snapshot.domains.providers.ok, true);
    assert.equal(snapshot.domains.providers.data.providers[0].id, provider.id);
    assert.equal(snapshot.domains.providers.data.providers[0].secretStatus, "configured");
    assert.equal(snapshot.domains.providers.data.providers[0].secretRefKind, "env");
    assert.equal(snapshot.domains.providers.data.providers[0].apiKeyRef, undefined);
    assert.equal(snapshot.domains.memory.data.recentCandidates[0].title, "Deploy rule");
    assert.equal(snapshot.domains.memory.data.recentCandidates[0].body, undefined);
    assert.equal(snapshot.domains.mcp.data.servers[0].missingSecretCount, 1);
    assertControlPlanePayloadRedacted(snapshot, [
      "sk-test-provider-secret-value",
      "env:LOCAL_RELAY_API_KEY",
      "env:MCP_AUTHORIZATION",
      "forbidden-memory-body",
      "sk-test-memory-secret-value",
    ]);

    const badDomain = await requestJson(`${daemon.url}/control-plane/snapshot?cwd=${encodeURIComponent(cwd)}&domains=unknown`, { method: "GET" });
    assert.equal(badDomain.status, 400);
    assert.equal(badDomain.json.error, "bad_domain");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("control-plane snapshot isolates known domain reader failures", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-control-plane-partial-"));
  const daemon = await startDaemonForTest({
    wrapStore: (store) => new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === "listSkillRegistryEntries") {
          return () => {
            throw new Error("skill registry fixture failure");
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }),
  });
  try {
    const snapshot = await getJson(`${daemon.url}/control-plane/snapshot?cwd=${encodeURIComponent(cwd)}&domains=runs,skills`);
    assert.equal(snapshot.domains.runs.ok, true);
    assert.equal(snapshot.domains.skills.ok, false);
    assert.equal(snapshot.domains.skills.error.code, "domain_snapshot_failed");
    assert.match(snapshot.domains.skills.error.message, /skill registry fixture failure/);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("control-plane artifact snapshot exposes summaries without local artifact paths", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-control-plane-artifacts-"));
  const stores = new Map();
  const daemon = await startDaemonForTest({ stores });
  try {
    const store = stores.get(cwd) ?? createStoreForCwd(stores, cwd);
    const createdAt = "2026-06-22T00:00:00.000Z";
    store.createRun({
      id: "run_control_plane_artifact_snapshot",
      cwd,
      taskId: "task_control_plane_artifact_snapshot",
      providerName: "test-provider",
      providerModel: "test-model",
      taskSnapshot: { id: "task_control_plane_artifact_snapshot" },
      providerSnapshot: { provider: "test-provider", model: "test-model" },
      requestSnapshot: { cwd },
      createdAt,
    });
    store.createArtifact({
      id: "artifact_control_plane_summary",
      runId: "run_control_plane_artifact_snapshot",
      type: "markdown",
      path: ".ling-stack/sessions/run_control_plane_artifact_snapshot/secret-output.md",
      title: "Control plane summary",
      contentType: "text/markdown; charset=utf-8",
      sizeBytes: 128,
      createdAt,
    });
    const mediaJob = store.createMediaJob({
      providerPresetId: "provider_control_plane_media",
      operation: "image_generate",
      prompt: "forbidden-media-prompt sk-media-secret-value",
      input: { size: "1024x1024" },
    }, "2026-06-22T00:00:01.000Z");
    store.createArtifact({
      id: "artifact_control_plane_media_summary",
      mediaJobId: mediaJob.id,
      type: "image",
      path: ".ling-stack/media/secret-render.png",
      title: "Control plane media render",
      contentType: "image/png",
      sizeBytes: 256,
      createdAt: "2026-06-22T00:00:02.000Z",
    });

    const snapshot = await getJson(`${daemon.url}/control-plane/snapshot?cwd=${encodeURIComponent(cwd)}&domains=artifacts`);
    assert.equal(snapshot.domains.artifacts.ok, true);
    assert.equal(snapshot.domains.artifacts.data.counts.recent, 2);
    assert.equal(snapshot.domains.artifacts.data.counts.byKind.markdown, 1);
    assert.equal(snapshot.domains.artifacts.data.counts.byKind.image, 1);
    const artifact = snapshot.domains.artifacts.data.recent.find((item) => item.id === "artifact_control_plane_summary");
    assert.equal(artifact.id, "artifact_control_plane_summary");
    assert.equal(artifact.runId, "run_control_plane_artifact_snapshot");
    assert.equal(artifact.title, "Control plane summary");
    assert.equal(artifact.kind, "markdown");
    assert.equal(artifact.contentType, "text/markdown; charset=utf-8");
    assert.equal(artifact.sizeBytes, 128);
    assert.equal(artifact.path, undefined);
    assert.equal(artifact.contentHref, `/artifacts/artifact_control_plane_summary/content?cwd=${encodeURIComponent(cwd)}`);
    const mediaArtifact = snapshot.domains.artifacts.data.recent.find((item) => item.id === "artifact_control_plane_media_summary");
    assert.equal(mediaArtifact.mediaJobId, mediaJob.id);
    assert.equal(mediaArtifact.runId, undefined);
    assert.equal(mediaArtifact.kind, "image");
    assert.equal(mediaArtifact.contentHref, `/artifacts/artifact_control_plane_media_summary/content?cwd=${encodeURIComponent(cwd)}`);
    assertControlPlanePayloadRedacted(snapshot, [
      ".ling-stack/sessions",
      "secret-output.md",
      ".ling-stack/media",
      "secret-render.png",
      "forbidden-media-prompt",
      "sk-media-secret-value",
    ]);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("control-plane events endpoint validates queries and lists filtered redacted events", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-control-plane-events-"));
  const stores = new Map();
  const daemon = await startDaemonForTest({ stores });
  try {
    const store = stores.get(cwd) ?? createStoreForCwd(stores, cwd);
    store.appendControlPlaneEvent({
      workspaceId: DEFAULT_WORKSPACE_ID,
      cwd,
      domain: "runs",
      entityType: "run",
      entityId: "run_1",
      action: "run.created",
      data: { status: "queued", taskId: "task_1", authorization: "Bearer secret-token-value" },
    }, "2026-06-06T00:00:00.000Z");
    store.appendControlPlaneEvent({
      workspaceId: DEFAULT_WORKSPACE_ID,
      cwd,
      domain: "skills",
      entityType: "registry",
      entityId: "default",
      action: "skill.registry_changed",
      data: { registryGeneration: 2, changeType: "refresh" },
    }, "2026-06-06T00:00:01.000Z");

    const listed = await getJson(`${daemon.url}/control-plane/events?cwd=${encodeURIComponent(cwd)}&afterSeq=0&limit=10&domains=runs`);
    assert.equal(listed.cwd, cwd);
    assert.equal(listed.window.disposition, "complete");
    assert.equal(listed.window.requestedAfterSeq, 0);
    assert.equal(listed.window.upperBoundSeq, 2);
    assert.equal(listed.window.nextAfterSeq, 2);
    assert.deepEqual(listed.events.map((event) => event.action), ["run.created"]);
    assertControlPlanePayloadRedacted(listed, ["Bearer secret-token-value"]);

    const badDomain = await requestJson(`${daemon.url}/control-plane/events?cwd=${encodeURIComponent(cwd)}&domains=unknown`, { method: "GET" });
    assert.equal(badDomain.status, 400);
    assert.equal(badDomain.json.error, "bad_domain");

    const badLimit = await requestJson(`${daemon.url}/control-plane/events?cwd=${encodeURIComponent(cwd)}&limit=1001`, { method: "GET" });
    assert.equal(badLimit.status, 400);
    assert.equal(badLimit.json.error, "bad_request");

    const badAfterSeq = await requestJson(`${daemon.url}/control-plane/events?cwd=${encodeURIComponent(cwd)}&afterSeq=-1`, { method: "GET" });
    assert.equal(badAfterSeq.status, 400);
    assert.equal(badAfterSeq.json.error, "bad_request");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("work unit control APIs append compact redacted control-plane transition events", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-control-plane-work-unit-controls-"));
  const daemon = await startDaemonForTest();
  try {
    const store = createSqliteRunStore(cwd);
    try {
      store.createWorkUnit({
        id: "wu_control_failed_retry",
        workspaceId: DEFAULT_WORKSPACE_ID,
        kind: "task_run",
        ownerType: "task",
        ownerId: "task_control_failed_retry",
        idempotencyKey: "control-failed-retry",
        status: "failed",
        createdByActor: "system",
        request: { prompt: "forbidden-work-unit-prompt sk-test-workunit-secret-value" },
        now: "2026-06-22T00:00:00.000Z",
      });
      const running = store.createWorkUnit({
        id: "wu_control_running_reconcile",
        workspaceId: DEFAULT_WORKSPACE_ID,
        kind: "task_run",
        ownerType: "task",
        ownerId: "task_control_running_reconcile",
        idempotencyKey: "control-running-reconcile",
        status: "running",
        createdByActor: "system",
        request: { prompt: "forbidden-work-unit-prompt sk-test-workunit-secret-value" },
        now: "2026-06-22T00:01:00.000Z",
      });
      store.createWorkUnitAttempt({
        id: "attempt_control_running_reconcile",
        workUnitId: running.id,
        attemptNumber: 1,
        runtimeInstanceId: "runtime_control_plane_test",
        runnerId: "runner_pi_embedded",
        now: "2026-06-22T00:01:01.000Z",
      });
      store.createWorkUnit({
        id: "wu_control_queued_cancel",
        workspaceId: DEFAULT_WORKSPACE_ID,
        kind: "task_run",
        ownerType: "task",
        ownerId: "task_control_queued_cancel",
        idempotencyKey: "control-queued-cancel",
        status: "queued",
        createdByActor: "system",
        request: { prompt: "forbidden-work-unit-prompt sk-test-workunit-secret-value" },
        now: "2026-06-22T00:02:00.000Z",
      });
    } finally {
      store.close();
    }

    const retried = await postJson(`${daemon.url}/work-units/wu_control_failed_retry/retry?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(retried.workUnit.status, "queued");
    const reconciled = await postJson(`${daemon.url}/work-units/wu_control_running_reconcile/reconcile?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(reconciled.workUnit.status, "stale");
    const cancelled = await postJson(`${daemon.url}/work-units/wu_control_queued_cancel/cancel?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(cancelled.workUnit.status, "cancelled");

    const listed = await getJson(`${daemon.url}/control-plane/events?cwd=${encodeURIComponent(cwd)}&afterSeq=0&limit=1000&domains=work_units`);
    const transitions = new Map(
      listed.events
        .filter((event) => event.action === "work_unit.transitioned")
        .map((event) => [event.entityId, event]),
    );
    assert.deepEqual(
      {
        previousStatus: transitions.get("wu_control_failed_retry")?.data.previousStatus,
        status: transitions.get("wu_control_failed_retry")?.data.status,
        reason: transitions.get("wu_control_failed_retry")?.data.reason,
      },
      { previousStatus: "failed", status: "queued", reason: "manual_retry" },
    );
    assert.deepEqual(
      {
        previousStatus: transitions.get("wu_control_running_reconcile")?.data.previousStatus,
        status: transitions.get("wu_control_running_reconcile")?.data.status,
        reason: transitions.get("wu_control_running_reconcile")?.data.reason,
      },
      { previousStatus: "running", status: "stale", reason: "runtime-startup-reconcile" },
    );
    assert.deepEqual(
      {
        previousStatus: transitions.get("wu_control_queued_cancel")?.data.previousStatus,
        status: transitions.get("wu_control_queued_cancel")?.data.status,
        reason: transitions.get("wu_control_queued_cancel")?.data.reason,
      },
      { previousStatus: "queued", status: "cancelled", reason: "work_unit_cancel_requested" },
    );
    assert.equal(transitions.get("wu_control_running_reconcile")?.data.runId, null);
    assert.equal(transitions.get("wu_control_running_reconcile")?.data.attemptId, "attempt_control_running_reconcile");
    assertControlPlanePayloadRedacted(listed, ["forbidden-work-unit-prompt", "sk-test-workunit-secret-value"]);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("runtime startup reconcile appends work-unit control-plane events outside work-unit routes", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-control-plane-runtime-reconcile-"));
  const daemon = await startDaemonForTest();
  try {
    const store = createSqliteRunStore(cwd);
    try {
      const running = store.createWorkUnit({
        id: "wu_control_runtime_reconcile",
        workspaceId: DEFAULT_WORKSPACE_ID,
        kind: "task_run",
        ownerType: "task",
        ownerId: "task_control_runtime_reconcile",
        idempotencyKey: "control-runtime-reconcile",
        status: "running",
        createdByActor: "system",
        request: { prompt: "forbidden-runtime-reconcile-prompt sk-test-runtime-secret-value" },
        now: "2026-06-22T00:03:00.000Z",
      });
      store.createWorkUnitAttempt({
        id: "attempt_control_runtime_reconcile",
        workUnitId: running.id,
        attemptNumber: 1,
        runtimeInstanceId: "runtime_control_plane_test",
        runnerId: "runner_pi_embedded",
        now: "2026-06-22T00:03:01.000Z",
      });
    } finally {
      store.close();
    }

    await getJson(`${daemon.url}/runtime?cwd=${encodeURIComponent(cwd)}`);

    const listed = await getJson(`${daemon.url}/control-plane/events?cwd=${encodeURIComponent(cwd)}&afterSeq=0&limit=1000&domains=work_units`);
    const reconciled = listed.events.find((event) => event.entityId === "wu_control_runtime_reconcile");
    assert.equal(reconciled.action, "work_unit.transitioned");
    assert.equal(reconciled.data.previousStatus, "running");
    assert.equal(reconciled.data.status, "stale");
    assert.equal(reconciled.data.reason, "runtime-startup-reconcile");
    assert.equal(reconciled.data.attemptId, "attempt_control_runtime_reconcile");
    assertControlPlanePayloadRedacted(listed, ["forbidden-runtime-reconcile-prompt", "sk-test-runtime-secret-value"]);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("control-plane SSE stream replays events and emits heartbeat without using run streams", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-control-plane-sse-"));
  const stores = new Map();
  const daemon = await startDaemonForTest({ stores });
  try {
    const store = stores.get(cwd) ?? createStoreForCwd(stores, cwd);
    store.appendControlPlaneEvent({
      workspaceId: DEFAULT_WORKSPACE_ID,
      cwd,
      domain: "providers",
      entityType: "provider",
      entityId: "provider_1",
      action: "provider.updated",
      data: { providerId: "provider_1", apiKeyRef: "env:LOCAL_RELAY_API_KEY" },
    }, "2026-06-06T00:00:00.000Z");

    const response = await fetch(`${daemon.url}/control-plane/stream?cwd=${encodeURIComponent(cwd)}&afterSeq=0&domains=providers`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Content-Type")?.startsWith("text/event-stream"), true);
    const reader = createSseReader(response);
    const replay = await reader.nextEvent();
    assert.equal(replay.event, "control_plane_event");
    assert.equal(replay.data.action, "provider.updated");
    assertControlPlanePayloadRedacted(replay.data, ["env:LOCAL_RELAY_API_KEY"]);
    const ready = await reader.nextEvent();
    assert.equal(ready.event, "control_plane_replay_ready");
    assert.equal(ready.data.disposition, "complete");
    assert.equal(ready.data.nextAfterSeq, 1);
    const heartbeat = await reader.nextEvent();
    assert.equal(heartbeat.event, "heartbeat");
    assert.equal(typeof heartbeat.data.latestEventSeq, "number");
    await reader.close();
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("control-plane REST and SSE return typed snapshot-required for an unavailable cursor", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-control-plane-snapshot-required-"));
  const daemon = await startDaemonForTest();
  try {
    const listed = await getJson(`${daemon.url}/control-plane/events?cwd=${encodeURIComponent(cwd)}&afterSeq=7&limit=10&domains=providers`);
    assert.equal(listed.window.disposition, "snapshot_required");
    assert.equal(listed.window.reason, "cursor_unavailable");
    assert.deepEqual(listed.events, []);

    const response = await fetch(`${daemon.url}/control-plane/stream?cwd=${encodeURIComponent(cwd)}&afterSeq=7&domains=providers`);
    assert.equal(response.status, 200);
    const [required] = parseSseText(await response.text());
    assert.ok(required);
    assert.equal(required.event, "control_plane_snapshot_required");
    assert.equal(required.data.reason, "cursor_unavailable");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("provider check for OpenAI Codex Responses is static and redacted", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-codex-provider-check-"));
  const store = createSqliteRunStore(cwd);
  const originalFetch = globalThis.fetch;
  try {
    const provider = store.createProviderPreset(
      {
        kind: "openai",
        displayName: "Codex Responses",
        providerId: "openai-codex",
        model: "gpt-5.5-codex",
        api: "openai-codex-responses",
        providerTransport: "auto",
        baseUrl: "https://chatgpt.com/backend-api",
        apiKeyRef: "env:OPENAI_CODEX_API_KEY",
        capabilities: ["chat", "tool_call"],
        enabled: true,
      },
      "2026-06-10T00:00:00.000Z",
    );
    globalThis.fetch = async () => {
      throw new Error("provider preflight must not open a live WebSocket or HTTP model request");
    };

    const result = await checkProviderPreset(
      store,
      provider,
      createCompositeSecretResolver({ env: { OPENAI_CODEX_API_KEY: "sk-codex-secret-value" } }),
    );

    assert.equal(result.ok, true);
    assert.equal(result.code, "static_check");
    assert.match(result.message, /does not open a live WebSocket/);
    assertControlPlanePayloadRedacted(result, ["sk-codex-secret-value", "env:OPENAI_CODEX_API_KEY"]);
  } finally {
    globalThis.fetch = originalFetch;
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("provider resolution only enables WebSocket fallback for explicit Codex Responses", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-provider-transport-resolution-"));
  const store = createSqliteRunStore(cwd);
  const secretResolver = createCompositeSecretResolver({ env: { OPENAI_CODEX_API_KEY: "sk-codex-secret-value" } });
  try {
    const codexProvider = store.createProviderPreset(
      {
        kind: "openai",
        displayName: "Codex Responses",
        providerId: "openai-codex",
        model: "gpt-5.5-codex",
        api: "openai-codex-responses",
        providerTransport: "websocket-cached",
        baseUrl: "https://chatgpt.com/backend-api",
        apiKeyRef: "env:OPENAI_CODEX_API_KEY",
        capabilities: ["chat", "tool_call"],
        enabled: true,
      },
      "2026-06-10T00:00:00.000Z",
    );
    const responsesProvider = store.createProviderPreset(
      {
        kind: "openai",
        displayName: "OpenAI Responses",
        providerId: "openai",
        model: "gpt-5.5",
        api: "openai-responses",
        providerTransport: "websocket",
        baseUrl: "https://api.openai.com/v1",
        apiKeyRef: "env:OPENAI_CODEX_API_KEY",
        capabilities: ["chat", "tool_call"],
        enabled: true,
      },
      "2026-06-10T00:01:00.000Z",
    );
    for (const provider of [codexProvider, responsesProvider]) {
      store.recordProviderCheckResult(provider.id, {
        ok: true,
        code: "static_check",
        message: "ready",
        checkedAt: "2026-06-10T00:02:00.000Z",
      });
    }

    const baseRunRequest = {
      cwd,
      task: { id: "task_provider_transport", title: "Provider transport", prompt: "Run" },
      tools: ["read"],
      skipProviderPreflight: false,
    };
    assert.equal(
      resolveProviderForRun(store, { ...baseRunRequest, providerPresetId: codexProvider.id }, secretResolver, {
        providerWebSocketFallbackEnabled: true,
      }).providerTransport,
      "websocket-cached",
    );
    assert.equal(
      resolveProviderForRun(store, { ...baseRunRequest, providerPresetId: codexProvider.id }, secretResolver, {
        providerWebSocketFallbackEnabled: false,
      }).providerTransport,
      "sse",
    );
    assert.equal(
      resolveProviderForRun(store, { ...baseRunRequest, providerPresetId: responsesProvider.id }, secretResolver, {
        providerWebSocketFallbackEnabled: true,
      }).providerTransport,
      undefined,
    );
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("local WebSocket RPC gates initialize and validates methods", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-rpc-init-"));
  const daemon = await startDaemonForTest();
  const rpc = await openRpcClient(daemon.url, cwd);
  try {
    rpc.send(1, "daemon.health");
    const notInitialized = await rpc.next((message) => message.id === 1);
    assert.equal(notInitialized.error?.data?.code, "not_initialized");

    rpc.send(2, "initialize", {});
    const initialized = await rpc.next((message) => message.id === 2);
    assert.equal(initialized.result.ok, true);
    assert.equal(initialized.result.transport, "websocket");
    assert.equal(initialized.result.cwd, cwd);
    assert.equal(initialized.result.features.transports.localWebSocketRpc, true);

    rpc.send(3, "unknown.method", {});
    const unsupported = await rpc.next((message) => message.id === 3);
    assert.equal(unsupported.error?.data?.code, "method_not_found");
  } finally {
    await rpc.close();
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("local WebSocket RPC schedules one terminal report after executed work", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-rpc-terminal-report-"));
  const stores = new Map();
  const daemon = await startDaemonForTest({ stores, runner: new RpcTerminalReportRunner() });
  const provider = (await postJson(`${daemon.url}/providers?cwd=${encodeURIComponent(cwd)}`, {
    kind: "openai-compatible",
    displayName: "Terminal report test provider",
    providerId: "terminal-report-test-provider",
    model: "test-model",
    api: "openai-completions",
    baseUrl: "http://127.0.0.1:8317/v1",
    authHeader: false,
    capabilities: ["chat", "tool_call"],
    input: ["text"],
    enabled: true,
  })).provider;
  const store = stores.get(cwd);
  assert.ok(store);
  const channel = store.createChannel({ name: "RPC terminal report", boundPath: cwd }, "2026-07-11T12:00:00.000Z");
  const task = store.createTask({
    channelId: channel.id,
    title: "Inspect package",
    prompt: "Read package.json without modifying files.",
  }, "2026-07-11T12:00:00.000Z");
  const rpc = await openRpcClient(daemon.url, cwd);
  try {
    rpc.send(1, "initialize", {});
    await rpc.next((message) => message.id === 1);
    rpc.send(2, "runs.start", {
      cwd,
      providerPresetId: provider.id,
      skipProviderPreflight: true,
      task: { id: task.id, title: task.title, prompt: task.prompt, channelId: channel.id },
      tools: ["read"],
    });
    const accepted = await rpc.next((message) => message.id === 2);
    assert.equal(accepted.result.accepted, true);
    await rpc.next((message) => message.method === "$/run_event" && message.params?.kind === "end");

    const run = store.listRuns({ limit: 100 }).find((item) => item.taskId === task.id);
    assert.ok(run);
    const report = await waitForTerminalReport(store, "run", run.id);
    assert.ok(report);
    assert.equal(report.sourceKind, "run");
    assert.equal(report.sourceId, run.id);
    assert.equal(store.listTerminalReports({ sourceKind: "run", sourceId: run.id, limit: 100 }).length, 1);
  } finally {
    await rpc.close();
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("local WebSocket RPC returns control-plane data and subscriptions", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-rpc-control-plane-"));
  const stores = new Map();
  const daemon = await startDaemonForTest({ stores });
  const store = stores.get(cwd) ?? createStoreForCwd(stores, cwd);
  store.appendControlPlaneEvent({
    workspaceId: DEFAULT_WORKSPACE_ID,
    cwd,
    domain: "providers",
    entityType: "provider",
    entityId: "provider_replay",
    action: "provider.updated",
    data: { providerId: "provider_replay", apiKeyRef: "env:OPENAI_CODEX_API_KEY" },
  }, "2026-06-10T00:00:00.000Z");
  const rpc = await openRpcClient(daemon.url, cwd);
  try {
    rpc.send(1, "initialize", {});
    await rpc.next((message) => message.id === 1);

    rpc.send(2, "controlPlane.snapshot", { domains: ["providers"] });
    const snapshot = await rpc.next((message) => message.id === 2);
    assert.equal(snapshot.result.cwd, cwd);
    assert.deepEqual(Object.keys(snapshot.result.domains), ["providers"]);

    rpc.send(3, "controlPlane.events", { afterSeq: 0, limit: 10, domains: ["providers"] });
    const events = await rpc.next((message) => message.id === 3);
    assert.equal(events.result.window.disposition, "complete");
    assert.deepEqual(events.result.events.map((event) => event.action), ["provider.updated"]);
    assertControlPlanePayloadRedacted(events.result, ["env:OPENAI_CODEX_API_KEY"]);

    rpc.send(4, "controlPlane.subscribe", { afterSeq: 0, domains: ["providers"] });
    const subscribed = await rpc.next((message) => message.id === 4);
    assert.equal(subscribed.result.disposition, "complete");
    assert.match(subscribed.result.subscriptionId, /^cp_/);
    const replay = await rpc.next((message) =>
      message.method === "$/control_plane_event" &&
      message.params?.event?.entityId === "provider_replay"
    );
    assert.equal(replay.params.event.action, "provider.updated");
    assertControlPlanePayloadRedacted(replay, ["env:OPENAI_CODEX_API_KEY"]);

    const created = (await postJson(`${daemon.url}/providers?cwd=${encodeURIComponent(cwd)}`, {
      kind: "openai",
      displayName: "Codex Responses Live",
      providerId: "openai-codex-live",
      model: "gpt-5.5-codex",
      api: "openai-codex-responses",
      providerTransport: "websocket",
      baseUrl: "https://chatgpt.com/backend-api",
      apiKeyRef: "env:OPENAI_CODEX_LIVE_API_KEY",
      capabilities: ["chat", "tool_call"],
      input: ["text"],
      enabled: true,
    })).provider;
    const live = await rpc.next((message) =>
      message.method === "$/control_plane_event" &&
      message.params?.event?.entityId === created.id
    );
    assert.equal(live.params.event.action, "provider.updated");
    assert.equal(live.params.event.domain, "providers");
    assertControlPlanePayloadRedacted(live, ["env:OPENAI_CODEX_LIVE_API_KEY"]);

    rpc.send(5, "controlPlane.unsubscribe", { subscriptionId: subscribed.result.subscriptionId });
    const unsubscribed = await rpc.next((message) => message.id === 5);
    assert.equal(unsubscribed.result.ok, true);
  } finally {
    await rpc.close();
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("local WebSocket RPC returns snapshot-required without retaining a subscription", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-rpc-snapshot-required-"));
  const daemon = await startDaemonForTest();
  const rpc = await openRpcClient(daemon.url, cwd);
  try {
    rpc.send(1, "initialize", {});
    await rpc.next((message) => message.id === 1);
    rpc.send(2, "controlPlane.subscribe", { afterSeq: 9, domains: ["providers"] });
    const result = await rpc.next((message) => message.id === 2);
    assert.equal(result.result.disposition, "snapshot_required");
    assert.equal(result.result.window.reason, "cursor_unavailable");
    assert.equal(result.result.subscriptionId, undefined);
    await assert.rejects(
      rpc.next((message) => message.method === "$/control_plane_event"),
      /Timed out waiting for RPC message/u,
    );
  } finally {
    await rpc.close();
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("local WebSocket RPC can be disabled by feature flag", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-rpc-disabled-"));
  const daemon = await startDaemonForTest({ config: { transports: { localWebSocketRpc: false } } });
  try {
    await assert.rejects(
      openRpcClient(daemon.url, cwd),
      /Unexpected server response: 404|WebSocket was closed before the connection was established/,
    );
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("daemon stop closes active local WebSocket RPC clients", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-rpc-stop-"));
  const daemon = await startDaemonForTest();
  const rpc = await openRpcClient(daemon.url, cwd);
  try {
    rpc.send(1, "initialize", {});
    await rpc.next((message) => message.id === 1);

    await daemon.close();
    await rpc.waitForClose();
  } finally {
    await rpc.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("domain mutations append control-plane invalidation events", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-control-plane-mutations-"));
  const daemon = await startDaemonForTest();
  try {
    const provider = (await postJson(`${daemon.url}/providers?cwd=${encodeURIComponent(cwd)}`, {
      kind: "openai-compatible",
      displayName: "Local Relay",
      providerId: "local-relay",
      model: "gpt-5.5",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:8317/v1",
      apiKeyRef: "env:LOCAL_RELAY_API_KEY",
      capabilities: ["chat"],
      input: ["text"],
      enabled: true,
    })).provider;
    await postJson(`${daemon.url}/skills/refresh?cwd=${encodeURIComponent(cwd)}`, {});
    const createdMemory = await postJson(`${daemon.url}/memory?cwd=${encodeURIComponent(cwd)}`, {
      scopeType: "workspace",
      ownerId: DEFAULT_WORKSPACE_ID,
      title: "Review candidate",
      body: "secret memory body",
      sourceKind: "user_explicit",
      confidence: "medium",
      reasonCode: "test_fixture",
    });
    await postJson(`${daemon.url}/memory/${encodeURIComponent(createdMemory.memory.id)}/review?cwd=${encodeURIComponent(cwd)}`, {
      action: "approve",
      actor: "local-user",
    });
    await patchJson(`${daemon.url}/memory/review-policy?cwd=${encodeURIComponent(cwd)}`, {
      mode: "fast",
    });
    const mcp = await postJson(`${daemon.url}/mcp/servers?cwd=${encodeURIComponent(cwd)}`, {
      id: "mcp_mutation",
      displayName: "Mutation MCP",
      transport: { type: "streamable-http", url: "https://api.example.test/mcp" },
      enabled: true,
    });
    await patchJson(`${daemon.url}/runtime/settings?cwd=${encodeURIComponent(cwd)}`, {
      explicitRunnerFallback: "allow_to_default",
    });
    await fetch(`${daemon.url}/providers/${encodeURIComponent(provider.id)}?cwd=${encodeURIComponent(cwd)}`, { method: "DELETE" });
    await fetch(`${daemon.url}/mcp/servers/${encodeURIComponent(mcp.server.id)}?cwd=${encodeURIComponent(cwd)}`, { method: "DELETE" });

    const listed = await getJson(`${daemon.url}/control-plane/events?cwd=${encodeURIComponent(cwd)}&afterSeq=0&limit=1000`);
    const actions = listed.events.map((event) => event.action);
    assert.ok(actions.includes("provider.updated"));
    assert.ok(actions.includes("skill.registry_changed"));
    assert.ok(actions.includes("memory.candidate_created"));
    assert.ok(actions.includes("memory.reviewed"));
    assert.ok(actions.includes("memory.policy_updated"));
    assert.ok(actions.includes("mcp.server_updated"));
    assert.ok(actions.includes("runner.settings_updated"));
    assertControlPlanePayloadRedacted(listed, ["env:LOCAL_RELAY_API_KEY", "secret memory body"]);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("run execution appends redacted run work-unit and artifact control-plane events", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-control-plane-run-events-"));
  const daemon = await startDaemonForTest({
    runner: new ControlPlaneRunRunner(),
  });
  try {
    const { runId } = await postRunAndCollectEvents(daemon.url, {
      cwd,
      task: {
        id: "task_control_plane_run",
        title: "Control plane run",
        prompt: "forbidden-run-prompt sk-test-run-secret-value",
      },
      provider: {
        provider: "test-provider",
        model: "test-model",
      },
      tools: ["write"],
      thinkingLevel: "off",
    });
    assert.ok(runId);

    const listed = await getJson(`${daemon.url}/control-plane/events?cwd=${encodeURIComponent(cwd)}&afterSeq=0&limit=1000`);
    const actions = listed.events.map((event) => event.action);
    assert.ok(actions.includes("run.created"));
    assert.ok(actions.includes("run.completed"));
    assert.ok(actions.includes("work_unit.created"));
    assert.ok(actions.includes("work_unit.transitioned"));
    assert.ok(actions.includes("artifact.created"));

    const runCreated = listed.events.find((event) => event.action === "run.created");
    assert.equal(runCreated.data.status, "queued");
    assert.equal(runCreated.data.taskId, "task_control_plane_run");
    assert.equal(runCreated.data.channelId, null);
    assert.equal(runCreated.data.teammateId, null);
    assert.equal(runCreated.data.providerPresetId, null);
    assert.equal(runCreated.data.requestedSkillId, null);
    assert.equal(typeof runCreated.data.workUnitId, "string");
    const artifactCreated = listed.events.find((event) => event.action === "artifact.created" && event.data.type === "markdown");
    assert.ok(artifactCreated);
    assert.equal(artifactCreated.data.runId, runId);
    assert.equal(artifactCreated.data.type, "markdown");
    assert.equal(artifactCreated.data.contentType.startsWith("text/markdown"), true);
    assert.equal(typeof artifactCreated.data.sizeBytes, "number");
    assert.equal(artifactCreated.data.path, undefined);
    assertControlPlanePayloadRedacted(listed, [
      "forbidden-run-prompt",
      "sk-test-run-secret-value",
      "sk-test-artifact-secret-value",
      "secret-output.md",
    ]);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("run approvals append redacted control-plane created and resolved events", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-control-plane-approval-events-"));
  const stores = new Map();
  const daemon = await startDaemonForTest({ stores });
  try {
    const store = stores.get(cwd) ?? createStoreForCwd(stores, cwd);
    const createdAt = "2026-06-06T00:00:00.000Z";
    store.createRun({
      id: "run_control_plane_approval",
      cwd,
      taskId: "task_control_plane_approval",
      providerName: "test-provider",
      providerModel: "test-model",
      taskSnapshot: { id: "task_control_plane_approval" },
      providerSnapshot: { provider: "test-provider", model: "test-model" },
      requestSnapshot: { cwd },
      createdAt,
    });
    const approval = store.createApprovalRequest({
      runId: "run_control_plane_approval",
      taskId: "task_control_plane_approval",
      toolCallId: "tool_control_plane_approval",
      actionType: "bash",
      risk: "high",
      title: "Control plane approval",
      description: "Approval description should not be copied to control-plane events.",
      payload: {
        type: "bash",
        cwd,
        command: "echo sk-test-approval-secret-value",
        riskFlags: ["test"],
      },
      expiresAt: "2999-01-01T00:00:00.000Z",
    }, createdAt);
    appendApprovalCreatedControlPlaneEvent(store, { publish() {} }, cwd, approval, createdAt);

    await postJson(`${daemon.url}/approvals/${encodeURIComponent(approval.id)}/approve?cwd=${encodeURIComponent(cwd)}`, {
      reason: "approved for control-plane test",
    });

    const listed = await getJson(`${daemon.url}/control-plane/events?cwd=${encodeURIComponent(cwd)}&afterSeq=0&limit=1000&domains=approvals`);
    const actions = listed.events.map((event) => event.action);
    assert.ok(actions.includes("approval.created"));
    assert.ok(actions.includes("approval.resolved"));
    const created = listed.events.find((event) => event.action === "approval.created");
    assert.equal(created.data.ownerType, "run");
    assert.equal(created.data.ownerId, "run_control_plane_approval");
    assert.equal(created.data.actionType, "bash");
    assert.equal(created.data.risk, "high");
    const resolved = listed.events.find((event) => event.action === "approval.resolved");
    assert.equal(resolved.data.previousStatus, "pending");
    assert.equal(resolved.data.status, "approved");
    assert.equal(resolved.data.decision, "approved");
    assert.equal(resolved.data.ownerType, "run");
    assert.equal(resolved.data.ownerId, "run_control_plane_approval");
    assert.equal(resolved.data.resolvedBy, "local-user");
    assertControlPlanePayloadRedacted(listed, [
      "echo sk-test-approval-secret-value",
      "sk-test-approval-secret-value",
      "approved for control-plane test",
      "Approval description should not be copied",
    ]);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("teammate binding mutations append compact control-plane events", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-control-plane-teammate-events-"));
  const daemon = await startDaemonForTest();
  try {
    const provider = (await postJson(`${daemon.url}/providers?cwd=${encodeURIComponent(cwd)}`, {
      kind: "glm",
      displayName: "Control Plane Chat",
      providerId: "control-plane-chat",
      model: "control-plane-chat",
      api: "google-generative-ai",
      capabilities: ["chat"],
      input: ["text"],
      authHeader: false,
      enabled: true,
    })).provider;
    await postJson(`${daemon.url}/providers/${encodeURIComponent(provider.id)}/check?cwd=${encodeURIComponent(cwd)}`, {});
    const created = await postJson(`${daemon.url}/teammates?cwd=${encodeURIComponent(cwd)}`, {
      roleKey: "engineer",
      displayName: "Control Plane Teammate",
      description: "Teammate private notes must not be copied into events.",
      modelBindingMode: "fixed",
      providerPresetId: provider.id,
      allowedTools: ["read"],
      approvalProfile: { mode: "none" },
      status: "active",
    });
    const teammateId = created.teammate.id;
    await putJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/skills?cwd=${encodeURIComponent(cwd)}`, {
      bindings: [{ skillId: "review", source: "user", enabled: true }],
    });
    await putJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/memory-scopes?cwd=${encodeURIComponent(cwd)}`, {
      scopes: [{ kind: "private-notes", enabled: true }],
    });
    await postJson(`${daemon.url}/mcp/servers?cwd=${encodeURIComponent(cwd)}`, {
      id: "mcp_teammate_event",
      displayName: "Teammate Event MCP",
      transport: {
        type: "streamable-http",
        url: "https://api.example.test/mcp",
        secretHeaderRefs: { Authorization: "env:MCP_TEAMMATE_SECRET" },
      },
      enabled: true,
    });
    await putJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/mcp?cwd=${encodeURIComponent(cwd)}`, {
      bindings: [{ serverId: "mcp_teammate_event", mode: "selected", selectedToolNames: ["search"], enabled: true }],
    });

    const listed = await getJson(`${daemon.url}/control-plane/events?cwd=${encodeURIComponent(cwd)}&afterSeq=0&limit=1000&domains=teammates`);
    const actions = listed.events.map((event) => event.action);
    assert.ok(actions.includes("teammate.skills_changed"));
    assert.ok(actions.includes("teammate.memory_scopes_changed"));
    assert.ok(actions.includes("teammate.mcp_bindings_changed"));
    for (const event of listed.events) {
      assert.equal(event.entityId, teammateId);
      assert.equal(event.data.teammateId, teammateId);
      assert.equal(typeof event.data.added, "number");
      assert.equal(typeof event.data.enabled, "number");
      assert.equal(event.data.skillIds, undefined);
      assert.equal(event.data.serverIds, undefined);
    }
    assertControlPlanePayloadRedacted(listed, [
      "Teammate private notes must not be copied",
      "env:MCP_TEAMMATE_SECRET",
    ]);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

async function startDaemonForTest(options = {}) {
  const stores = options.stores ?? new Map();
  const daemon = createDaemonServer({
    host: "127.0.0.1",
    port: 0,
    ...(options.config ?? {}),
  }, {
    runner: options.runner,
    secretResolver: options.secretResolver,
    storeFactory: (cwd) => {
      const store = createStoreForCwd(stores, cwd);
      return options.wrapStore ? options.wrapStore(store) : store;
    },
    mcpBroker: new FakeMcpBroker(),
  });
  await daemon.start();
  const address = daemon.server.address();
  assert.ok(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => daemon.stop(),
  };
}

async function openRpcClient(baseUrl, cwd) {
  const url = `${baseUrl.replace(/^http/, "ws")}/rpc/stream?cwd=${encodeURIComponent(cwd)}`;
  const socket = new WebSocket(url);
  const messages = [];
  const waiters = [];
  socket.on("message", (data) => {
    const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
    const message = JSON.parse(text);
    messages.push(message);
    for (const waiter of [...waiters]) {
      if (waiter.predicate(message)) {
        waiter.resolve(message);
        clearTimeout(waiter.timer);
        waiters.splice(waiters.indexOf(waiter), 1);
      }
    }
  });
  await once(socket, "open");
  return {
    send: (id, method, params) => {
      socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    },
    next: (predicate) => {
      for (const message of messages) {
        if (predicate(message)) {
          return Promise.resolve(message);
        }
      }
      return new Promise((resolveNext, rejectNext) => {
        const waiter = {
          predicate,
          resolve: resolveNext,
          timer: setTimeout(() => {
            waiters.splice(waiters.indexOf(waiter), 1);
            rejectNext(new Error("Timed out waiting for RPC message"));
          }, 2_000),
        };
        waiters.push(waiter);
      });
    },
    close: async () => {
      if (socket.readyState === WebSocket.CLOSED) {
        return;
      }
      socket.close();
      await Promise.race([
        once(socket, "close"),
        new Promise((resolveTimeout) => setTimeout(resolveTimeout, 250)),
      ]);
    },
    waitForClose: async () => {
      if (socket.readyState === WebSocket.CLOSED) {
        return;
      }
      await once(socket, "close");
    },
  };
}

function createStoreForCwd(stores, cwd) {
  const store = createSqliteRunStore(cwd);
  stores.set(cwd, store);
  return store;
}

async function waitForTerminalReport(store, sourceKind, sourceId) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const report = store.listTerminalReports({ sourceKind, sourceId, limit: 100 })[0];
    if (report?.status === "committed" || report?.status === "fallback") {
      return report;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  return undefined;
}

class FakeMcpBroker {
  async checkServer(server) {
    return {
      statusSnapshot: {
        serverId: server.id,
        status: "ready",
        checkedAt: "2026-06-06T00:00:00.000Z",
        toolCount: 0,
        missingSecretRefs: [],
      },
    };
  }

  async listTools(server) {
    return {
      statusSnapshot: {
        serverId: server.id,
        status: "ready",
        checkedAt: "2026-06-06T00:00:00.000Z",
        toolCount: 0,
        missingSecretRefs: [],
      },
      tools: [],
    };
  }

  async callTool() {
    return { content: [] };
  }
}

class ControlPlaneRunRunner {
  async runTask(options) {
    options.onEvent?.({
      type: "run_start",
      taskId: options.task.id,
      cwd: options.cwd,
      provider: options.provider.provider,
      model: options.provider.model,
    });
    options.onEvent?.({
      type: "tool_start",
      toolCallId: "tool_write_control_plane_artifact",
      toolName: "write",
      args: {
        path: "secret-output.md",
        content: "# Control plane artifact\n\nsk-test-artifact-secret-value\n",
      },
    });
    options.onEvent?.({
      type: "tool_end",
      toolCallId: "tool_write_control_plane_artifact",
      toolName: "write",
      result: { path: "secret-output.md", content: [{ type: "text", text: "wrote secret-output.md\n" }] },
      isError: false,
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

class RpcTerminalReportRunner {
  async runTask(options) {
    options.onEvent?.({
      type: "tool_start",
      toolCallId: "rpc_terminal_report_read",
      toolName: "read",
      args: { path: "package.json" },
    });
    options.onEvent?.({
      type: "tool_end",
      toolCallId: "rpc_terminal_report_read",
      toolName: "read",
      result: { content: [{ type: "text", text: "{\"name\":\"ling-stack\"}" }] },
      isError: false,
    });
    options.onEvent?.({ type: "assistant_text_delta", text: "Read package.json successfully." });
    return {
      taskId: options.task.id,
      events: [],
      messages: [{ role: "assistant", content: "Read package.json successfully." }],
    };
  }
}

async function getJson(url) {
  const response = await fetch(url);
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return JSON.parse(text);
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  assert.ok(response.status >= 200 && response.status < 300, text);
  return JSON.parse(text);
}

async function patchJson(url, body) {
  const response = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  assert.ok(response.status >= 200 && response.status < 300, text);
  return JSON.parse(text);
}

async function putJson(url, body) {
  const response = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  assert.ok(response.status >= 200 && response.status < 300, text);
  return JSON.parse(text);
}

async function requestJson(url, options) {
  const response = await fetch(url, {
    method: options.method,
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  let json;
  try {
    json = await response.json();
  } catch {
    json = {};
  }
  return { status: response.status, json };
}

async function postRunAndCollectEvents(baseUrl, body) {
  const response = await postRunStream(baseUrl, body);
  const text = await response.text();
  const events = parseSseText(text);
  return {
    events,
    runId: events.find((event) => event.event === "ready")?.data.runId,
  };
}

async function postRunStream(baseUrl, body) {
  const response = await fetch(`${baseUrl}/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = response.status === 200 ? undefined : await response.text();
  assert.equal(response.status, 200, text);
  assert.ok(response.body);
  return response;
}

function createSseReader(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  return {
    async nextEvent() {
      for (;;) {
        const delimiter = buffer.indexOf("\n\n");
        if (delimiter >= 0) {
          const block = buffer.slice(0, delimiter);
          buffer = buffer.slice(delimiter + 2);
          const parsed = parseSseBlock(block);
          if (parsed) {
            return parsed;
          }
        }
        const { value, done } = await reader.read();
        if (done) {
          throw new Error("SSE stream ended before next event");
        }
        buffer += decoder.decode(value, { stream: true });
      }
    },
    async close() {
      reader.cancel().catch(() => {});
    },
  };
}

function parseSseText(text) {
  return text
    .split("\n\n")
    .map(parseSseBlock)
    .filter(Boolean);
}

function parseSseBlock(block) {
  const lines = block.split("\n");
  let event = "message";
  const dataLines = [];
  for (const line of lines) {
    if (line.startsWith(":")) {
      continue;
    }
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart());
    }
  }
  if (dataLines.length === 0) {
    return undefined;
  }
  return { event, data: JSON.parse(dataLines.join("\n")) };
}

function assertControlPlanePayloadRedacted(payload, forbiddenValues) {
  const text = JSON.stringify(payload);
  for (const value of forbiddenValues) {
    assert.equal(text.includes(value), false, `control-plane payload leaked forbidden value: ${value}`);
  }
}
