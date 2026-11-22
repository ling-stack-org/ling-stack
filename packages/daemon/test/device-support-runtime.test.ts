import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { WebSocketServer } from "ws";

import type {
  ApprovalRequest, DeviceActionRequestV1, DeviceAttemptConformanceReportV1, DeviceDeveloperSessionV1, DeviceDiagnosisReportV1, DeviceFleetHealthProjectionV1, DeviceResourceManifestV1,
  DeviceProfileV1, DeviceRetirementStateV1, DeviceRetirementV1, DeviceTaskAttemptV1, DeviceTaskJournalPageV1, DeviceTaskStatusV1, DeviceTaskTraceV1,
} from "@ling-stack/contracts";
import {
  buildOwnedDevicePlanningInput, createEnvSecretResolver, createSqliteRunStore, DEFAULT_WORKSPACE_ID, DeviceBrokerError, digestRequest,
  HardwareProtocolWorkbench, modbusRtuRegisterCodec, readOwnedDeviceAttemptConformance, readOwnedDeviceTaskTrace,
  SqliteDeviceFabricStore, SqliteDeviceSupportStore,
} from "@ling-stack/core";
import { canonicalJsonBytes } from "@ling-stack/remote-protocol";
import { createDeviceSupportRuntime } from "../dist/features/device-support/runtime.js";
import { createDaemonServer } from "../dist/index.js";
import { startLoopbackPiProvider } from "./support/loopback-pi-provider-fixture.mjs";

test("the configured Home Assistant instance supplies PC-owned diagnosis evidence", async t => {
  const cwd = mkdtempSync(join(tmpdir(), "ling-home-assistant-"));
  const workspace = createSqliteRunStore(cwd);
  const accessToken = "fixture-ha-access-token";
  const paths: string[] = [];
  const home = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${accessToken}`) {
      res.writeHead(401).end();
      return;
    }
    paths.push(req.url ?? "");
    if (req.url === "/api/config") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ version: "2026.11.4" }));
    } else if (req.url === "/api/states/sensor.garage") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
        entity_id: "sensor.garage", state: "unavailable", attributes: { description: "private device output" },
      }));
    } else if (req.url === "/api/states/sensor.reporting") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
        entity_id: "sensor.reporting", state: "on", last_reported: "2026-01-01T01:00:00.123456+01:00",
      }));
    } else if (req.url === "/api/states") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify([
        { entity_id: "sensor.garage", state: "unavailable", attributes: { description: "private device output" } },
        { entity_id: "light.kitchen", state: "on", attributes: { description: "private device output" } },
      ]));
    } else if (req.url === "/api/services") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify([
        { domain: "light", services: { turn_on: { target: {}, description: "private device output" } } },
      ]));
    } else {
      res.writeHead(404).end();
    }
  });
  const registry = new WebSocketServer({ server: home, path: "/api/websocket" });
  registry.on("connection", socket => {
    paths.push("/api/websocket");
    let authenticated = false;
    socket.send(JSON.stringify({ type: "auth_required", ha_version: "2026.11.4" }));
    socket.on("message", raw => {
      const frame = JSON.parse(raw.toString()) as { type: string; access_token?: string; id?: number };
      if (!authenticated && frame.type === "auth" && frame.access_token === accessToken) {
        authenticated = true;
        socket.send(JSON.stringify({ type: "auth_ok", ha_version: "2026.11.4" }));
      } else if (authenticated && frame.type === "config/device_registry/list") {
        socket.send(JSON.stringify({
          id: frame.id, type: "result", success: true, result: [{
            id: "0123456789abcdef0123456789abcdef", disabled_by: "user", name: "private device output",
          }],
        }));
      } else {
        socket.close();
      }
    });
  });
  let daemon: ReturnType<typeof createDaemonServer> | undefined;
  t.after(async () => {
    await daemon?.stop();
    await new Promise<void>(resolve => registry.close(() => resolve()));
    await new Promise<void>(resolve => home.close(() => resolve()));
    rmSync(cwd, { recursive: true, force: true });
  });
  home.listen(0, "127.0.0.1");
  await once(home, "listening");
  const homeAddress = home.address();
  assert.ok(homeAddress && typeof homeAddress === "object");
  const authToken = "fixture-daemon-authority";
  daemon = createDaemonServer({
    host: "127.0.0.1", port: 0, authToken, defaultWorkspaceCwd: cwd,
    deviceSupport: { homeAssistant: { origin: `http://127.0.0.1:${homeAddress.port}`, tokenRef: "env:HA_FIXTURE" } },
  }, {
    storeFactory: () => workspace, secretResolver: createEnvSecretResolver({ HA_FIXTURE: accessToken }),
    chromeBrowserNativeMessagingEnabled: false, remoteReplyDispatcher: null,
  });
  await daemon.start();
  const address = daemon.server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}/v1/device-support`;
  const headers = { Authorization: `Bearer ${authToken}`, "Content-Type": "application/json" };
  const post = (body: object, extraHeaders: Record<string, string> = {}) => fetch(base + "/home-assistant/diagnose", {
    method: "POST", headers: { ...headers, ...extraHeaders }, body: JSON.stringify(body),
  });
  assert.equal((await post({ entityId: "sensor.garage" }, { Origin: "https://foreign.example" })).status, 403);
  assert.equal((await post({ entityId: "sensor.garage", origin: "https://other.example" })).status, 400);
  assert.equal((await post({ entityId: "sensor.reporting", maxReportAgeMs: 0 })).status, 400);
  assert.equal((await fetch(base + "/pc/diagnose", {
    method: "POST", headers, body: JSON.stringify({ maxReportAgeMs: 1000 }),
  })).status, 400);
  assert.deepEqual(paths, []);
  const response = await post({ entityId: "sensor.garage" });
  assert.equal(response.status, 200);
  const { status, report } = await response.json() as { status: string; report: DeviceDiagnosisReportV1 };
  assert.equal(status, "succeeded");
  assert.deepEqual(report.facts.map(fact => fact.value), [{ availability: "unavailable" }]);
  assert.equal(report.hypotheses[0]?.code, "integration_or_device_issue");
  assert.deepEqual(paths, ["/api/config", "/api/config", "/api/states/sensor.garage"]);
  const getCatalog = (query: string, extras: Record<string, string> = {}) =>
    fetch(base + "/home-assistant/catalog?" + query, { headers: { ...headers, ...extras } });
  assert.equal((await getCatalog("kind=entities", { Origin: "https://foreign.example" })).status, 403);
  assert.equal((await getCatalog("kind=entities&origin=https://foreign.example")).status, 400);
  assert.equal((await getCatalog("kind=entities&limit=101")).status, 400);
  assert.deepEqual(paths, ["/api/config", "/api/config", "/api/states/sensor.garage"]);
  const pages = [];
  for (const [query, items, nextAfter] of [
    ["kind=entities&limit=1", [{ id: "light.kitchen", availability: "available" }], "light.kitchen"],
    ["kind=entities&after=light.kitchen", [{ id: "sensor.garage", availability: "unavailable" }]],
    ["kind=services", [{ id: "light.turn_on", acceptsTarget: true }]],
    ["kind=devices", [{ id: "0123456789abcdef0123456789abcdef", disabled: true }]],
  ] as const) {
    const response = await getCatalog(query);
    assert.equal(response.status, 200);
    const page = await response.json() as { taskId: string; deviceId: string; catalog: { items: unknown; nextAfter?: string } };
    assert.deepEqual(page.catalog.items, items);
    assert.equal(page.catalog.nextAfter, nextAfter);
    pages.push(page);
  }
  const freshnessResponse = await post({ entityId: "sensor.reporting", maxReportAgeMs: 1000 });
  assert.equal(freshnessResponse.status, 200);
  const freshness = (await freshnessResponse.json() as { report: DeviceDiagnosisReportV1 }).report;
  assert.deepEqual(freshness.facts[0]?.value, {
    availability: "available", lastReportedAt: "2026-01-01T00:00:00.123Z", reportTimestampStatus: "valid", reportFreshness: "stale",
  });
  assert.equal(freshness.hypotheses[0]?.code, "stale_entity_report");
  const store = new SqliteDeviceSupportStore({ databasePath: workspace.paths.databasePath });
  try {
    const registered = store.listDevices().find(profile => profile.device.kind === "home_assistant");
    assert.ok(registered);
    const deviceId = registered.device.id;
    const foreignId = "home-assistant:foreign";
    assert.equal(store.registerDevice({ ...registered, device: { ...registered.device, id: foreignId, ownerScope: "foreign" } },
      new Date().toISOString()), true);
    const fabric = new SqliteDeviceFabricStore({ databasePath: workspace.paths.databasePath });
    try {
      const node = { nodeId: "integration", deviceId, kind: "device" as const, label: "Integration", revision: 1,
        identityRefs: ["private-identity-detail"], properties: { detail: "private-node-detail" } };
      fabric.upsertGraphNode(node);
      fabric.upsertGraphNode({ ...node, nodeId: "component", kind: "component", parentNodeId: "integration" });
      fabric.upsertGraphNode({ ...node, nodeId: "foreign", deviceId: foreignId, label: "foreign-node" });
      fabric.addGraphRelationship({ relationshipId: "contains-component", fromNodeId: "integration", toNodeId: "component",
        type: "contains", provenance: ["private-graph-provenance"], revision: 1 });
      fabric.addGraphRelationship({ relationshipId: "foreign-link", fromNodeId: "integration", toNodeId: "foreign",
        type: "connects", provenance: [], revision: 1 });
      const past = "2025-01-01T00:00:00.000Z";
      fabric.saveTwin({
        deviceId, revision: 1, updatedAt: past,
        values: [{ key: "availability", reported: "private-twin-value", quality: "good", source: "fixture", observedAt: past, freshnessUntil: past }],
      });
      fabric.saveEdgeRuntime({ runtimeId: "bench-edge", displayName: "Bench Edge", publicKeyFingerprint: "fixture-edge-fingerprint",
        contractMajor: 1, supportedTransports: ["rs485"], status: "offline", revision: 1 });
    } finally {
      fabric.close();
    }
    const graphResponse = await fetch(base + "/fabric/graph", { headers });
    assert.equal(graphResponse.status, 200);
    const graph = await graphResponse.json() as {
      generatedAt: string;
      nodes: { nodeId: string; deviceId: string }[];
      relationships: { relationshipId: string }[];
      twins: { deviceId: string; values: { quality: string; hasReported: boolean }[] }[];
    };
    assert.ok(Number.isFinite(Date.parse(graph.generatedAt)));
    assert.deepEqual(graph.nodes.map(node => [node.nodeId, node.deviceId]), [["component", deviceId], ["integration", deviceId]]);
    assert.deepEqual(graph.relationships.map(link => link.relationshipId), ["contains-component"]);
    assert.equal(graph.twins.length, 1);
    assert.equal(graph.twins[0]?.deviceId, deviceId);
    assert.equal(graph.twins[0]?.values[0]?.quality, "stale");
    assert.equal(graph.twins[0]?.values[0]?.hasReported, true);
    assert.doesNotMatch(JSON.stringify(graph), /foreign-node|foreign-link|private-/u);
    const edgeResponse = await fetch(base + "/fabric/edge-runtimes", { headers });
    assert.equal(edgeResponse.status, 200);
    const edge = await edgeResponse.json() as { runtimes: { runtimeId: string; status: string; revision: number }[] };
    assert.deepEqual(edge.runtimes.map(item => [item.runtimeId, item.status, item.revision]), [["bench-edge", "offline", 1]]);
    assert.doesNotMatch(JSON.stringify(edge), /fixture-edge-fingerprint/u);
    assert.equal((await fetch(base + "/fabric/graph", { headers: { ...headers, Origin: "https://foreign.example" } })).status, 403);
    assert.equal(store.getTask(report.taskId)?.ownerKind, "daemon");
    assert.equal(store.getObservation(freshness.taskId, freshness.facts[0]!.observationId)?.subjectId, "sensor.reporting");
    assert.equal(store.listDevices().find(profile => profile.device.kind === "home_assistant")?.device.firmwareVersion, "2026.11.4");
    assert.doesNotMatch(JSON.stringify([report, store.listEvents(report.taskId), store.listObservations(report.taskId)]),
      /private device output|fixture-ha-access-token/u);
    for (const page of pages) {
      assert.equal(store.getTask(page.taskId)?.status, "succeeded");
      assert.deepEqual(store.getTask(page.taskId)?.targetDeviceIds, [page.deviceId]);
      const attempts = store.listAttempts(page.taskId);
      assert.equal(attempts.length, 1);
      assert.match(attempts[0]!.request.capabilityId, /^home_assistant\.list_/u);
      assert.deepEqual(store.listObservations(page.taskId)[0]?.value, page.catalog);
      assert.doesNotMatch(JSON.stringify([page, store.listEvents(page.taskId)]), /private device output|fixture-ha-access-token/u);
    }
  } finally {
    store.close();
  }
});

test("Home Assistant automation recovery verifies the exact registry entity and writes once", async t => {
  const cwd = mkdtempSync(join(tmpdir(), "ling-automation-approval-"));
  const entityId = "automation.fixture";
  const originalRegistryId = "a".repeat(32);
  const lastTriggered = new Date(Date.now() - 60_000).toISOString();
  let registryId = originalRegistryId;
  let state = "off";
  let applyService = true;
  const writes: unknown[] = [];
  const home = createServer(async (request, response) => {
    if (request.url === "/api/config") {
      response.end(JSON.stringify({ version: "2026.11.2" }));
    } else if (request.url === `/api/states/${entityId}`) {
      response.end(JSON.stringify({ entity_id: entityId, state, attributes: { last_triggered: lastTriggered, private_marker: "private-fixture-value" } }));
    } else if (request.url === "/api/services/automation/turn_on" && request.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      writes.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      if (applyService) state = "on";
      response.end("[]");
    } else response.writeHead(404).end();
  });
  const registry = new WebSocketServer({ server: home, path: "/api/websocket" });
  registry.on("connection", socket => {
    socket.send(JSON.stringify({ type: "auth_required", ha_version: "2026.11.2" }));
    socket.on("message", raw => {
      const message = JSON.parse(raw.toString("utf8"));
      if (message.type === "auth" && message.access_token === "automation-fixture-secret") {
        socket.send(JSON.stringify({ type: "auth_ok", ha_version: "2026.11.2" }));
      } else if (message.type === "config/entity_registry/get") {
        socket.send(JSON.stringify({ id: message.id, type: "result", success: true,
          result: { entity_id: entityId, platform: "automation", id: registryId, disabled_by: null } }));
      } else socket.close();
    });
  });
  home.listen(0, "127.0.0.1");
  await once(home, "listening");
  const homeAddress = home.address();
  assert.ok(homeAddress && typeof homeAddress === "object");
  const daemon = createDaemonServer({
    host: "127.0.0.1", port: 0, authToken: "fixture-operator", defaultWorkspaceCwd: cwd,
    deviceSupport: { homeAssistant: { origin: `http://127.0.0.1:${homeAddress.port}`, tokenRef: "env:HA_FIXTURE" } },
  }, { secretResolver: createEnvSecretResolver({ HA_FIXTURE: "automation-fixture-secret" }),
    chromeBrowserNativeMessagingEnabled: false, remoteReplyDispatcher: null });
  t.after(async () => {
    await daemon.stop();
    await new Promise<void>(resolve => registry.close(() => resolve()));
    await new Promise<void>(resolve => home.close(() => resolve()));
    rmSync(cwd, { recursive: true, force: true });
  });
  await daemon.start();
  const address = daemon.server.address();
  assert.ok(address && typeof address === "object");
  const post = (path: string, body: object) => fetch(`http://127.0.0.1:${address.port}${path}`, {
    method: "POST", headers: { Authorization: "Bearer fixture-operator", "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const proposalPath = "/v1/device-support/home-assistant/automation-enable-proposals";
  async function propose(): Promise<ApprovalRequest> {
    const response = await post(proposalPath, { entityId });
    assert.equal(response.status, 201);
    return (await response.json()).approval as ApprovalRequest;
  }
  const approve = (approval: ApprovalRequest) => post(`/approvals/${approval.id}/approve?cwd=${encodeURIComponent(cwd)}`, {});
  const diagnosis = await post("/v1/device-support/home-assistant/diagnose", { entityId });
  assert.equal(diagnosis.status, 200);
  const { report } = await diagnosis.json() as { report: DeviceDiagnosisReportV1 };
  assert.deepEqual(report.facts[0]?.value, { availability: "available", automationEnabled: false, lastTriggeredAt: lastTriggered });
  assert.equal((await post(proposalPath, { entityId: "switch.fixture" })).status, 400);
  const stale = await propose();
  registryId = "b".repeat(32);
  assert.equal((await approve(stale)).status, 200);
  assert.deepEqual(writes, []);
  registryId = originalRegistryId;
  const live = await propose();
  assert.match(live.title, /Enable Home Assistant automation/u);
  assert.equal((live.payload as { automationRegistryId: string }).automationRegistryId, originalRegistryId);
  for (const response of await Promise.all([approve(live), approve(live)])) assert.equal(response.status, 200);
  assert.deepEqual(writes, [{ entity_id: entityId }]);
  assert.equal((await post(proposalPath, { entityId })).status, 409);
  state = "off";
  applyService = false;
  const unchanged = await propose();
  assert.equal((await approve(unchanged)).status, 200);
  assert.equal(writes.length, 2);
  const workspace = createSqliteRunStore(cwd);
  const store = new SqliteDeviceSupportStore({ databasePath: workspace.paths.databasePath });
  try {
    assert.equal(store.listAttempts(stale.deviceTaskId!)[0]?.attempt.receipt?.errorCode, "target_changed");
    assert.equal(store.getTask(live.deviceTaskId!)?.status, "succeeded");
    assert.deepEqual(store.listAttempts(live.deviceTaskId!).map(record => record.attempt.verification?.status), ["verified"]);
    assert.deepEqual(store.listAttempts(unchanged.deviceTaskId!).map(record => record.attempt.verification?.status), ["failed"]);
    assert.doesNotMatch(JSON.stringify(store.listObservations(live.deviceTaskId!)), /automation-fixture-secret|private-fixture-value/u);
  } finally {
    store.close();
    workspace.close();
  }
});

test("the local Home Assistant approval queue persists exact decisions and never repeats a reload", async t => {
  const cwd = mkdtempSync(join(tmpdir(), "ling-home-assistant-approval-"));
  const accessToken = "fixture-ha-queue-token";
  const entryId = "0123456789abcdef0123456789abcdef";
  const otherEntryId = "0123456789abcdef0123456789abcdee";
  const entityId = "sensor.garage";
  let registryEntry = entryId;
  let loseReloadResponse = false;
  let reads = 0;
  const writes: unknown[] = [];
  const home = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${accessToken}`) {
      res.writeHead(401).end();
      return;
    }
    if (req.url === "/api/config" && req.method === "GET") {
      res.writeHead(200).end(JSON.stringify({ version: "2026.11.4" }));
    } else if (req.url === "/api/services/homeassistant/reload_config_entry" && req.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      writes.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      if (loseReloadResponse) res.destroy();
      else res.writeHead(200).end("[]");
    } else if (req.url === `/api/states/${entityId}` && req.method === "GET") {
      reads++;
      res.writeHead(200).end(JSON.stringify({ entity_id: entityId, state: "on" }));
    } else res.writeHead(404).end();
  });
  const registry = new WebSocketServer({ server: home, path: "/api/websocket" });
  registry.on("connection", socket => {
    let authenticated = false;
    socket.send(JSON.stringify({ type: "auth_required", ha_version: "2026.11.4" }));
    socket.on("message", raw => {
      const message = JSON.parse(raw.toString()) as { type: string; entity_id?: string; entry_id?: string; access_token?: string; id?: number };
      if (!authenticated && message.type === "auth" && message.access_token === accessToken) {
        authenticated = true;
        socket.send(JSON.stringify({ type: "auth_ok", ha_version: "2026.11.4" }));
      } else if (authenticated && message.type === "config/entity_registry/get" && message.entity_id === entityId) {
        socket.send(JSON.stringify({ id: message.id, type: "result", success: true,
          result: { entity_id: entityId, config_entry_id: registryEntry, private_field: "fixture-hidden-registry-field" } }));
      } else if (authenticated && message.type === "config_entries/get_single" && message.entry_id === entryId) {
        socket.send(JSON.stringify({ id: message.id, type: "result", success: true,
          result: { config_entry: { entry_id: entryId, domain: "garage", state: "setup_retry",
            disabled_by: null, reason: "fixture-hidden-integration-reason" } } }));
      } else socket.close();
    });
  });
  let daemon: ReturnType<typeof createDaemonServer> | undefined;
  t.after(async () => {
    await daemon?.stop();
    await new Promise<void>(resolve => registry.close(() => resolve()));
    await new Promise<void>(resolve => home.close(() => resolve()));
    rmSync(cwd, { recursive: true, force: true });
  });
  home.listen(0, "127.0.0.1");
  await once(home, "listening");
  const homeAddress = home.address();
  assert.ok(homeAddress && typeof homeAddress === "object");
  const authToken = "fixture-daemon-queue-authority";
  const options = {
    host: "127.0.0.1", port: 0, authToken, defaultWorkspaceCwd: cwd,
    deviceSupport: { homeAssistant: { origin: `http://127.0.0.1:${homeAddress.port}`, tokenRef: "env:HA_FIXTURE" } },
  };
  let base = "";
  async function restart(): Promise<void> {
    await daemon?.stop();
    daemon = createDaemonServer(options, {
      secretResolver: createEnvSecretResolver({ HA_FIXTURE: accessToken }), chromeBrowserNativeMessagingEnabled: false,
      remoteReplyDispatcher: null,
    });
    await daemon.start();
    const address = daemon.server.address();
    assert.ok(address && typeof address === "object");
    base = `http://127.0.0.1:${address.port}`;
  }
  await restart();
  const headers = { Authorization: `Bearer ${authToken}`, "Content-Type": "application/json" };
  const workspaceQuery = `cwd=${encodeURIComponent(cwd)}`;
  const approvals = (query = workspaceQuery, extraHeaders: Record<string, string> = {}) =>
    fetch(base + "/approvals?" + query, { headers: { ...headers, ...extraHeaders } });
  const propose = (id = entryId, extraHeaders: Record<string, string> = {}) =>
    fetch(base + "/v1/device-support/home-assistant/reload-proposals", {
      method: "POST", headers: { ...headers, ...extraHeaders }, body: JSON.stringify({ entryId: id, entityId }),
    });
  const decision = (approvalId: string, action: "approve" | "deny", body: object = {},
    extraHeaders: Record<string, string> = {}, query = workspaceQuery) => fetch(base + `/approvals/${approvalId}/${action}?${query}`, {
    method: "POST", headers: { ...headers, ...extraHeaders }, body: JSON.stringify(body),
  });
  async function createProposal(): Promise<ApprovalRequest> {
    const response = await propose();
    assert.equal(response.status, 201);
    return (await response.json() as { approval: ApprovalRequest }).approval;
  }
  const workspace = createSqliteRunStore(cwd);
  const databasePath = workspace.paths.databasePath;
  workspace.close();

  const integrationDiagnosis = await fetch(base + "/v1/device-support/home-assistant/diagnose", {
    method: "POST", headers, body: JSON.stringify({ entityId, entryId }),
  });
  assert.equal(integrationDiagnosis.status, 200);
  const integration = await integrationDiagnosis.json() as { report: DeviceDiagnosisReportV1 };
  assert.deepEqual(integration.report.facts[0]?.value, {
    entryId, entityId, domain: "garage", state: "setup_retry", integrationDisabled: false, entityDisabled: false,
  });
  assert.equal(integration.report.hypotheses[0]?.code, "integration_or_device_issue");
  assert.doesNotMatch(JSON.stringify(integration), /fixture-hidden-integration-reason|fixture-hidden-registry-field/u);

  assert.equal((await propose(otherEntryId)).status, 409);
  assert.equal((await propose(entryId, { Origin: "https://foreign.example" })).status, 403);
  const pending = await createProposal();
  assert.equal(pending.status, "pending");
  assert.deepEqual(pending.availableDecisions, ["approve_once", "deny"]);
  assert.deepEqual(pending.payload, {
    type: "device_action", targetDeviceId: (pending.payload as { targetDeviceId: string }).targetDeviceId,
    capabilityId: "home_assistant.reload_config_entry", entryId, entityId, expectedAvailability: "available",
  });
  assert.match((pending.payload as { targetDeviceId: string }).targetDeviceId, /^home-assistant:[a-f0-9]{24}$/u);
  assert.deepEqual(writes, []);
  await restart();
  assert.deepEqual((await (await approvals(workspaceQuery + "&status=pending")).json() as { approvals: ApprovalRequest[] }).approvals,
    [pending]);
  const foreign = await approvals(workspaceQuery, { Origin: "https://foreign.example" });
  assert.deepEqual((await foreign.json() as { approvals: ApprovalRequest[] }).approvals, []);
  assert.equal((await decision(pending.id, "approve", { decisionKind: "approve_command_rule" })).status, 400);
  assert.equal((await decision(pending.id, "approve", {}, { Origin: "https://foreign.example" })).status, 403);
  assert.equal((await decision(pending.id, "approve", {}, {}, `cwd=${encodeURIComponent(join(cwd, "other"))}`)).status, 404);
  assert.deepEqual(writes, []);

  const approvalsTogether = await Promise.all([decision(pending.id, "approve", { decisionKind: "approve_once" }),
    decision(pending.id, "approve", { decisionKind: "approve_once" })]);
  for (const response of approvalsTogether) {
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { approval: ApprovalRequest }).approval.status, "approved");
  }
  assert.deepEqual(writes, [{ entry_id: entryId }]);
  assert.equal(reads, 1);
  await restart();
  assert.equal((await decision(pending.id, "approve")).status, 200);
  assert.equal((await decision(pending.id, "deny")).status, 409);
  assert.equal(writes.length, 1);

  const denied = await createProposal();
  assert.equal((await decision(denied.id, "deny")).status, 200);
  assert.equal((await decision(denied.id, "approve")).status, 409);

  const superseded = await createProposal();
  const proposalStore = new SqliteDeviceSupportStore({ databasePath });
  try {
    const proposal = proposalStore.getActionProposal(superseded.deviceTaskId!);
    assert.ok(proposal);
    proposalStore.saveActionProposal({ ...proposal.request, idempotencyKey: "replacement-key" }, proposal.requestDigest, new Date().toISOString());
  } finally {
    proposalStore.close();
  }
  const staleReceipt = await fetch(base + `/approvals/${superseded.id}?${workspaceQuery}`, { headers });
  assert.equal(staleReceipt.status, 200);
  assert.equal((await staleReceipt.json() as { approval: ApprovalRequest }).approval.status, "cancelled");
  assert.equal((await decision(superseded.id, "approve")).status, 409);
  assert.equal(writes.length, 1);

  const changed = await createProposal();
  registryEntry = otherEntryId;
  assert.equal((await decision(changed.id, "approve")).status, 200);
  assert.equal(writes.length, 1);
  registryEntry = entryId;
  const interrupted = await createProposal();
  loseReloadResponse = true;
  assert.equal((await decision(interrupted.id, "approve")).status, 200);
  assert.equal(writes.length, 2);
  await restart();
  assert.equal((await decision(interrupted.id, "approve")).status, 200);
  assert.equal(writes.length, 2);
  assert.equal(reads, 1);
  const store = new SqliteDeviceSupportStore({ databasePath });
  try {
    assert.equal(store.getTask(pending.deviceTaskId!)?.status, "succeeded");
    assert.equal(store.getTask(denied.deviceTaskId!)?.status, "cancelled");
    assert.equal(store.getTask(changed.deviceTaskId!)?.status, "failed");
    assert.equal(store.getTask(interrupted.deviceTaskId!)?.status, "unknown");
    assert.deepEqual(store.listAttempts(denied.deviceTaskId!), []);
    assert.deepEqual(store.listAttempts(superseded.deviceTaskId!), []);
    assert.equal(store.listAttempts(changed.deviceTaskId!)[0]?.attempt.receipt?.errorCode, "target_changed");
    assert.equal(store.listAttempts(pending.deviceTaskId!)[0]?.attempt.verification?.status, "verified");
    assert.equal(store.listAttempts(interrupted.deviceTaskId!).length, 1);
    const events = store.listEvents(pending.deviceTaskId!);
    assert.equal(events.filter(event => event.type === "queued_approval_resolved").length, 1);
    assert.doesNotMatch(JSON.stringify([pending, events]), /fixture-ha-queue-token|fixture-hidden-registry-field/u);
  } finally {
    store.close();
  }
});

test("daemon device-support runtime composes the durable store, broker and remote facade", () => {
  const root = mkdtempSync(join(tmpdir(), "ling-device-runtime-"));
  const runtime = createDeviceSupportRuntime({ databasePath: join(root, "workspace.sqlite") });
  assert.ok(runtime.store.database);
  assert.ok(runtime.fabricStore.database);
  assert.ok(runtime.developerStore.database);
  assert.ok(runtime.protocolStore.database);
  assert.equal(runtime.broker.store, runtime.store);
  assert.ok(runtime.collaboration);
  assert.ok(runtime.edgeRuntimes);
  assert.equal(runtime.edgeJournal.read("edge-fixture", "task-fixture").length, 0);
  assert.ok(runtime.access);
  assert.equal(runtime.remoteFacade.listDevices("workspace-1").devices.length, 0);
  const now = new Date().toISOString();
  const session = runtime.developerSessions.createSession({
    sessionId: "local-developer-session", workspaceId: DEFAULT_WORKSPACE_ID, ownerKind: "daemon", ownerId: "local-runtime",
    targetDeviceId: "fixture-target", targetKind: "android", mode: "developer", authorizationRevision: "local-confirmation",
    status: "created", revision: 1, createdAt: now, updatedAt: now,
  });
  assert.deepEqual(runtime.developerStore.getSession(session.sessionId), session);
  runtime.close();
});

test("daemon startup recovers interrupted dispatch and readback from the owner journal", async t => {
  const root = mkdtempSync(join(tmpdir(), "ling-runtime-recovery-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const databasePath = join(root, "workspace.sqlite");
  const startedAt = "2026-11-21T00:00:00.000Z";
  const restartedAt = "2026-11-21T00:01:00.000Z";
  const first = createDeviceSupportRuntime({ databasePath, now: () => startedAt });
  function record(taskId: string, taskStatus: DeviceTaskStatusV1, attemptStatus: DeviceTaskAttemptV1["status"], ownerKind: DeviceTaskAttemptV1["ownerKind"] = "daemon") {
    const request: DeviceActionRequestV1 = {
      taskId, actionId: "inspect-network", targetDeviceId: "device-1", capabilityId: "pc.inspect.network",
      capabilitySchemaVersion: "1.0", capabilitySnapshotId: "snapshot-1", idempotencyKey: "original-request",
      normalizedInput: {},
    };
    first.store.createTask({
      id: taskId, ownerKind, ownerId: "runtime-1", targetDeviceIds: [request.targetDeviceId],
      capabilitySnapshotIds: [request.capabilitySnapshotId], status: taskStatus,
      currentActionId: request.actionId, createdAt: startedAt, updatedAt: startedAt,
    }, startedAt);
    first.store.createAttempt({
      request, requestDigest: digestRequest(request),
      attempt: {
        attemptId: `${taskId}:attempt-1`, taskId, ownerKind, actionId: request.actionId, ownerId: "runtime-1",
        targetDeviceId: request.targetDeviceId, status: attemptStatus, dispatchIntentAt: startedAt,
        ...(attemptStatus === "completed" ? {
          receipt: { actionId: request.actionId, status: "completed", startedAt, finishedAt: startedAt, observationIds: [] },
        } : {}),
      },
    }, startedAt);
    return request;
  }
  const dispatch = record("interrupted-dispatch", "executing", "dispatched");
  const readback = record("interrupted-verification", "verifying", "completed");
  const peer = record("peer-task", "executing", "dispatched", "mobile");
  first.close();

  const restarted = createDeviceSupportRuntime({ databasePath, now: () => restartedAt });
  try {
    assert.equal(restarted.store.getTask(dispatch.taskId)?.status, "unknown");
    assert.equal(restarted.store.getTask(readback.taskId)?.status, "unknown");
    assert.equal(restarted.store.getTask(peer.taskId)?.status, "executing");
    assert.equal((await restarted.broker.execute(dispatch)).attempt.status, "unknown");
    const priorReadback = (await restarted.broker.execute(readback)).attempt;
    assert.equal(priorReadback.receipt?.status, "completed");
    assert.equal(priorReadback.verification, undefined);
    await assert.rejects(() => restarted.broker.execute({ ...readback, idempotencyKey: "changed-request" }), (error: unknown) =>
      error instanceof DeviceBrokerError && error.code === "unknown_outcome");
    assert.deepEqual(restarted.store.recoverAfterRestart(restartedAt), []);
  } finally {
    restarted.close();
  }
});

test("daemon runtime registers the Modbus codec and restores offline captures with loss evidence", t => {
  const root = mkdtempSync(join(tmpdir(), "ling-device-protocol-replay-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const databasePath = join(root, "workspace.sqlite");
  const captureTime = "2026-11-21T00:00:00.000Z";
  const owner = createDeviceSupportRuntime({ databasePath });
  try {
    assert.deepEqual(owner.protocolProfiles.list().map(profile => profile.profileId), ["modbus-rtu-registers"]);
    assert.equal(owner.protocolStore.getProfile("modbus-rtu-registers")?.codecId, modbusRtuRegisterCodec.manifest.codecId);
    const capture = owner.protocolWorkbench.capture({
      captureId: "modbus-temperature-register", targetDeviceId: "fixture-rs485", transport: "rs485", source: "imported",
      createdAt: captureTime, loss: { reason: "connection_interrupted" },
      frames: [{ direction: "rx", bytes: Buffer.from("010302000a3843", "hex"), capturedAt: captureTime }],
    });
    owner.protocolStore.saveCapture(capture);
  } finally {
    owner.close();
  }
  const reopened = createDeviceSupportRuntime({ databasePath });
  try {
    const codec = reopened.protocolStore.getCodec(modbusRtuRegisterCodec.manifest.codecId);
    assert.equal(reopened.protocolStore.getProfile("modbus-rtu-registers")?.transport, "rs485");
    assert.deepEqual(codec, modbusRtuRegisterCodec.manifest);
    const capture = reopened.protocolStore.getCapture("modbus-temperature-register");
    assert.ok(capture && codec);
    assert.deepEqual(capture.loss, { reason: "connection_interrupted" });
    assert.equal(reopened.protocolWorkbench.decode(capture, codec.codecId)[0]?.fields.register0, 10);
  } finally {
    reopened.close();
  }
});

test("the Daemon captures and reopens loss-aware frames from an authorized live transport", { timeout: 15_000 }, async t => {
  const cwd = mkdtempSync(join(tmpdir(), "ling-live-protocol-route-"));
  const timestamp = new Date().toISOString();
  const profile: DeviceProfileV1 = {
    device: {
      id: "fixture-register-bank", kind: "hardware", displayName: "Fixture register bank",
      ownerScope: DEFAULT_WORKSPACE_ID, lifecycleStatus: "healthy", profileRevision: "board-r1",
    },
    adapterId: "fixture-registers", adapterVersion: "1.0.0", profileRevision: "board-r1", source: "operator",
    transports: ["rs485"], connectionRefs: ["fixture-rs485-r1"],
    transportDeployments: [{ transport: "rs485", mode: "hardware_bridge", pairing: "os_permission", removal: "disconnect_only" }],
  };
  const authToken = "fixture-live-capture-authority";
  const headers = { Authorization: `Bearer ${authToken}`, "Content-Type": "application/json" };
  let daemon: ReturnType<typeof createDaemonServer> | undefined;
  let captures = 0;
  async function start(enroll: boolean) {
    const workspace = createSqliteRunStore(cwd);
    if (enroll) {
      const devices = new SqliteDeviceSupportStore({ databasePath: workspace.paths.databasePath });
      try { devices.registerDevice(profile, timestamp); } finally { devices.close(); }
    }
    daemon = createDaemonServer({ host: "127.0.0.1", port: 0, authToken, defaultWorkspaceCwd: cwd }, {
      storeFactory: () => workspace, chromeBrowserNativeMessagingEnabled: false, remoteReplyDispatcher: null,
      deviceProtocolTransports: [{
        transportId: "fixture-rs485", targetDeviceId: profile.device.id, connectionRevision: "fixture-rs485-r1", transport: "rs485",
        async *capture() {
          captures += 1;
          yield { direction: "rx", bytes: Buffer.from("010302000a3843", "hex") };
          throw new Error("fixture cable disconnected");
        },
      }],
    });
    await daemon.start();
    const address = daemon.server.address();
    assert.ok(address && typeof address === "object");
    return `http://127.0.0.1:${address.port}/v1/device-support/protocol`;
  }
  t.after(async () => {
    await daemon?.stop();
    rmSync(cwd, { recursive: true, force: true });
  });
  const initial = await start(true);
  const post = (url: string, body: object) => fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  const selection = { profileId: "modbus-rtu-registers", targetDeviceId: profile.device.id, transportId: "fixture-rs485" };
  assert.equal((await post(initial + "/sessions", { ...selection, targetDeviceId: "another-device" })).status, 404);
  const sessionResponse = await post(initial + "/sessions", selection);
  assert.equal(sessionResponse.status, 201);
  const { session } = await sessionResponse.json() as { session: DeviceDeveloperSessionV1 };
  const path = `/sessions/${session.sessionId}/capture`;
  const identity = { authorizationRevision: session.authorizationRevision };
  assert.equal((await post(initial + path, { authorizationRevision: "wrong" })).status, 403);
  assert.equal(captures, 0);
  const response = await post(initial + path, identity);
  assert.equal(response.status, 201);
  const receipt = await response.json();
  assert.equal(receipt.job.taskStatus, "partial");
  assert.match(receipt.job.outputDigest, /^[0-9a-f]{64}$/u);
  assert.equal(receipt.replay.source, "live");
  assert.equal(receipt.replay.frames[0].fields.register0, 10);
  assert.deepEqual(receipt.replay.loss, { reason: "connection_interrupted" });
  assert.equal(captures, 1);
  await daemon?.stop();
  daemon = undefined;
  const reopened = await start(false);
  assert.deepEqual(await (await fetch(reopened + path, { headers })).json(), receipt);
  const repeated = await post(reopened + path, identity);
  assert.equal(repeated.status, 200);
  assert.deepEqual(await repeated.json(), receipt);
  assert.equal(captures, 1);
});

test("the local protocol workbench imports target-bound capture evidence and resumes the same job after restart", { timeout: 15_000 }, async t => {
  const cwd = mkdtempSync(join(tmpdir(), "ling-device-workbench-route-"));
  const authToken = "fixture-daemon-authority";
  const headers = { Authorization: `Bearer ${authToken}`, "Content-Type": "application/json" };
  let server: ReturnType<typeof createDaemonServer> | undefined;
  let databasePath: string;
  async function start() {
    const workspace = createSqliteRunStore(cwd);
    databasePath = workspace.paths.databasePath;
    server = createDaemonServer({ host: "127.0.0.1", port: 0, authToken, defaultWorkspaceCwd: cwd }, {
      storeFactory: () => workspace, chromeBrowserNativeMessagingEnabled: false, remoteReplyDispatcher: null,
    });
    await server.start();
    const address = server.server.address();
    assert.ok(address && typeof address === "object");
    return `http://127.0.0.1:${address.port}/v1/device-support/protocol`;
  }
  t.after(async () => {
    await server?.stop();
    rmSync(cwd, { recursive: true, force: true });
  });
  const origin = await start();
  const targetDeviceId = "offline-rs485";
  const post = (url: string, body: unknown, extraHeaders: Record<string, string> = {}) => fetch(url, {
    method: "POST", headers: { ...headers, ...extraHeaders }, body: JSON.stringify(body),
  });
  const input = { profileId: "modbus-rtu-registers", targetDeviceId };
  assert.equal((await fetch(origin + "/profiles")).status, 401);
  assert.equal((await post(origin + "/sessions", input, { Origin: "https://example.invalid" })).status, 403);
  const created = await post(origin + "/sessions", input);
  assert.equal(created.status, 201);
  const { session } = await created.json() as { session: DeviceDeveloperSessionV1 };
  assert.equal(session.targetDeviceId, targetDeviceId);
  assert.equal(session.protocolReplay?.codecVersion, "1.0.0");
  const replayPath = `/sessions/${session.sessionId}/replay`;
  const url = origin + replayPath;
  const at = "2026-11-21T00:00:00.000Z";
  const capture = new HardwareProtocolWorkbench().capture({
    captureId: "temperature", targetDeviceId, transport: "rs485", source: "imported", createdAt: at,
    loss: { reason: "adapter_overrun", droppedFrames: 1 },
    frames: [{ direction: "rx", bytes: Buffer.from("010302000a3843", "hex"), capturedAt: at }],
  });
  const replayInput = { authorizationRevision: session.authorizationRevision, capture };
  assert.equal((await post(url, { ...replayInput, authorizationRevision: "expired-revision" })).status, 403);
  assert.equal((await post(url, { ...replayInput, capture: { ...capture, targetDeviceId: "other-target" } })).status, 409);
  assert.equal((await post(url, { ...replayInput, capture: { ...capture, frames: [{ ...capture.frames[0], digest: "0".repeat(64) }] } })).status, 409);
  const database = new DatabaseSync(databasePath!);
  try {
    database.exec("CREATE TRIGGER fixture_unavailable_capture BEFORE INSERT ON device_protocol_captures BEGIN SELECT RAISE(ABORT, 'capture storage unavailable'); END;");
    assert.equal((await post(url, replayInput)).status, 503);
    assert.equal((await fetch(url, { headers })).status, 404);
    database.exec("DROP TRIGGER fixture_unavailable_capture;");
  } finally {
    database.close();
  }
  await server?.stop();
  server = undefined;
  const reopenedUrl = await start() + replayPath;
  assert.equal((await post(reopenedUrl, { ...replayInput, capture: { ...capture, captureId: "changed" } })).status, 409);
  const completed = await post(reopenedUrl, replayInput);
  assert.equal(completed.status, 201);
  const result = await completed.json();
  assert.equal(result.job.taskStatus, "succeeded");
  assert.equal(result.replay.frames[0].fields.register0, 10);
  assert.deepEqual(result.replay.loss, capture.loss);
  assert.equal(result.replay.frames[0].digest, capture.frames[0]?.digest);
  assert.deepEqual(await (await fetch(reopenedUrl, { headers })).json(), result);
  const repeated = await post(reopenedUrl, replayInput);
  assert.equal(repeated.status, 200);
  assert.deepEqual(await repeated.json(), result);
});

test("the local daemon activates and rolls back Ed25519-signed resource imports", async t => {
  const root = mkdtempSync(join(tmpdir(), "ling-device-resource-policy-"));
  const workspace = createSqliteRunStore(root);
  const trustPath = join(root, "device-resource-trust.json");
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const keyId = "fixture-release";
  writeFileSync(trustPath, JSON.stringify({
    version: 1, allowedLicenses: ["MIT"],
    signingKeys: [{ keyId, publicKeyPem: publicKey.export({ type: "spki", format: "pem" }) }],
  }));
  const authToken = "fixture-daemon-authority";
  const headers = { Authorization: "Bearer " + authToken, "Content-Type": "application/json" };
  const daemon = createDaemonServer({
    host: "127.0.0.1", port: 0, authToken, defaultWorkspaceCwd: root, deviceSupport: { resourceTrustFile: trustPath },
  }, { storeFactory: () => workspace });
  t.after(async () => {
    await daemon.stop();
    rmSync(root, { recursive: true, force: true });
  });
  await daemon.start();
  const address = daemon.server.address();
  assert.ok(address && typeof address === "object");
  const url = "http://127.0.0.1:" + address.port + "/v1/device-support/resources";
  const resourceUrl = url + "/profile-fixture";
  const post = (value: unknown, extraHeaders: Record<string, string> = {}) => fetch(url, {
    method: "POST", headers: { ...headers, ...extraHeaders }, body: JSON.stringify(value),
  });
  const manifestBase = {
    resourceId: "profile-fixture", version: "1.0.0", kind: "schema", license: "MIT",
    dependencies: [], supportedDeviceKinds: ["linux"], entrypoint: "profile.json", contractMajor: 1,
  } as const;
  function signedFile(text: string, changes: Partial<Omit<DeviceResourceManifestV1, "signature" | "digest">> = {}) {
    const payload = Buffer.from(text);
    const unsigned = { ...manifestBase, ...changes, digest: createHash("sha256").update(payload).digest("hex") };
    const bytes = canonicalJsonBytes({ purpose: "ling.device-resource-manifest.v1", keyId, manifest: unsigned });
    return {
      manifest: { ...unsigned, signature: "ed25519:" + keyId + ":" + sign(null, bytes, privateKey).toString("base64url") },
      payloadBase64Url: payload.toString("base64url"),
    };
  }
  const original = signedFile('{"profile":"original"}');
  assert.equal((await post(original, { Origin: "https://elsewhere.example" })).status, 403);
  assert.equal((await fetch(resourceUrl)).status, 401);
  assert.equal((await fetch(resourceUrl, { headers })).status, 404);
  assert.equal((await post({ ...original, manifest: { ...original.manifest, version: "2.0.0" } })).status, 409);
  assert.equal((await post({ ...original, payloadBase64Url: Buffer.from("altered").toString("base64url") })).status, 409);
  const fakeKey = { ...original.manifest, signature: original.manifest.signature.replace(keyId, "unknown-key") };
  assert.equal((await post({ ...original, manifest: fakeKey })).status, 409);
  assert.equal((await post(signedFile("unsupported", { license: "Unapproved" }))).status, 409);
  assert.equal((await post(signedFile("unsupported", { supportedPlatforms: ["ios"] }))).status, 409);
  assert.equal((await post(signedFile("unsupported", { dependencies: ["missing-profile"] }))).status, 409);
  assert.equal((await post({ ...original, manifest: { ...original.manifest, extra: "unknown" } })).status, 400);
  const activated = await post(original);
  assert.equal(activated.status, 201);
  assert.match(activated.headers.get("cache-control") ?? "", /no-store/u);
  assert.equal((await post(original)).status, 200);
  assert.equal((await post(signedFile('{"profile":"conflicting content"}'))).status, 409);
  const update = signedFile('{"profile":"replacement"}', { version: "2.0.0" });
  assert.equal((await post(update)).status, 201);
  const rollback = await fetch(resourceUrl + "/rollback", { method: "POST", headers });
  assert.equal(rollback.status, 200);
  const { record } = await rollback.json() as { record: { manifest: DeviceResourceManifestV1; payloadDigest: string; status: string } };
  assert.deepEqual(record.manifest, original.manifest);
  assert.equal(record.payloadDigest, original.manifest.digest);
  const disabled = await fetch(resourceUrl + "/disable", { method: "POST", headers });
  assert.equal(disabled.status, 200);
  const status = await (await fetch(resourceUrl, { headers })).json() as { record: { status: string } };
  assert.equal(status.record.status, "disabled");
});

test("the local daemon exposes its PC report and sequenced task journal only on direct loopback", { timeout: 15_000 }, async t => {
  const cwd = mkdtempSync(join(tmpdir(), "ling-device-pc-diagnosis-"));
  const workspace = createSqliteRunStore(cwd);
  const authToken = "fixture-daemon-authority";
  const headers = { Authorization: `Bearer ${authToken}` };
  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0, authToken, defaultWorkspaceCwd: cwd }, { storeFactory: () => workspace });
  t.after(async () => {
    await daemon.stop();
    rmSync(cwd, { recursive: true, force: true });
  });
  await daemon.start();
  const address = daemon.server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}/v1/device-support/pc/diagnose`;
  const fleetUrl = `http://127.0.0.1:${address.port}/v1/device-support/fleet/health`;
  assert.equal((await fetch(fleetUrl, { headers: { Origin: "https://example.invalid", ...headers } })).status, 403);
  assert.equal((await fetch(fleetUrl, { headers })).status, 200);
  const fleet = await (await fetch(fleetUrl, { headers })).json() as DeviceFleetHealthProjectionV1;
  assert.equal(fleet.projectionId, "fleet:workspace_default");
  assert.deepEqual(fleet.items, []);
  assert.equal(fleet.counts.unknown, 0);
  assert.equal((await fetch(fleetUrl, { method: "POST", headers })).status, 405);
  assert.equal((await fetch(url, { method: "POST", headers: { ...headers, Origin: "https://example.invalid" } })).status, 403);
  assert.equal((await fetch(url, { method: "POST" })).status, 401);
  assert.equal((await fetch(url, { headers })).status, 405);
  const response = await fetch(url, { method: "POST", headers });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/u);
  const { status, report } = await response.json() as { status: string; report: DeviceDiagnosisReportV1 };
  assert.equal(status, "succeeded");
  assert.equal(report.playbookId, "pc-software-diagnosis");
  assert.deepEqual(report.actions.map(action => action.capabilityId), ["pc.inspect.network", "pc.inspect.services", "pc.inspect.processes", "pc.inspect.logs", "pc.inspect.software"]);
  const network = report.facts.find(fact => fact.source === "pc.network");
  assert.ok(network);
  assert.equal(typeof (network.value as { connected?: unknown }).connected, "boolean");
  assert.doesNotMatch(JSON.stringify(network.value), /gatewayReachable|dnsReachable/u);
  const liveFleet = await (await fetch(fleetUrl, { headers })).json() as DeviceFleetHealthProjectionV1;
  assert.equal(liveFleet.counts.healthy, 1);
  assert.equal(liveFleet.items[0]?.kind, "pc");
  assert.ok(liveFleet.items[0]?.capabilitySnapshotId);
  assert.ok(liveFleet.items[0]?.lastSeenAt);
  assert.equal(liveFleet.items[0]?.runtimeStatus, undefined);

  const eventsUrl = `http://127.0.0.1:${address.port}/v1/device-support/tasks/${encodeURIComponent(report.taskId)}/events`;
  assert.equal((await fetch(eventsUrl, { headers: { ...headers, "X-Forwarded-For": "192.0.2.42" } })).status, 403);
  assert.equal((await fetch(`${eventsUrl}?limit=101`, { headers })).status, 400);
  const pageResponse = await fetch(`${eventsUrl}?limit=1`, { headers });
  assert.equal(pageResponse.status, 200);
  assert.match(pageResponse.headers.get("cache-control") ?? "", /no-store/u);
  const firstPage = await pageResponse.json() as DeviceTaskJournalPageV1;
  assert.equal(firstPage.events[0]?.kind, "task_created");
  assert.equal(firstPage.events[0]?.sequence, 1);
  assert.equal(firstPage.hasMore, true);
  const remainder = await (await fetch(`${eventsUrl}?afterSequence=1`, { headers })).json() as DeviceTaskJournalPageV1;
  assert.equal(remainder.events[0]?.sequence, 2);
  assert.equal(remainder.task.status, "succeeded");
  assert.ok(remainder.events.some(event => event.kind === "device_plan_accepted"));

  const traceUrl = new URL("trace", eventsUrl).href;
  assert.equal((await fetch(traceUrl)).status, 401);
  assert.equal((await fetch(traceUrl, { headers: { ...headers, Origin: "https://example.invalid" } })).status, 403);
  const traceResponse = await fetch(traceUrl, { headers });
  assert.equal(traceResponse.status, 200);
  assert.match(traceResponse.headers.get("cache-control") ?? "", /no-store/u);
  const trace = await traceResponse.json() as DeviceTaskTraceV1;
  assert.equal(trace.traceId, remainder.events[0]?.traceId);
  assert.equal(trace.taskStatus, "succeeded");
  const graph = trace.spans.find(span => span.kind === "graph");
  assert.ok(graph);
  const adapterSpans = trace.spans.filter(span => span.kind === "adapter");
  assert.deepEqual(adapterSpans.map(span => span.lineage?.attemptId).sort(), report.actions.map(action => action.attemptId).sort());
  assert.ok(adapterSpans.every(span => span.status === "ok" && span.parentSpanId === graph.spanId
    && span.lineage?.graphId === report.taskId && span.lineage.nodeId && span.lineage.connectionRevision));
  const [snapshotEvidence] = trace.capabilitySnapshots ?? [];
  assert.ok(snapshotEvidence?.state === "recorded");
  assert.equal(snapshotEvidence.snapshotId, liveFleet.items[0]?.capabilitySnapshotId);
  assert.ok(snapshotEvidence.capabilities.some(capability => capability.id === "pc.inspect.network" && capability.sideEffect === "read_only"));
  assert.ok(adapterSpans.every(span => (span.metadata as { authority?: { state?: string } }).authority?.state === "recorded"));

  const conformanceUrl = new URL("conformance", eventsUrl).href;
  const attemptId = report.actions[0]!.attemptId;
  const captureUrl = `${conformanceUrl}?attemptId=${encodeURIComponent(attemptId)}`;
  assert.equal((await fetch(captureUrl)).status, 401);
  assert.equal((await fetch(captureUrl, { headers: { ...headers, Origin: "https://example.invalid" } })).status, 403);
  assert.equal((await fetch(`${captureUrl}&reportId=other`, { headers })).status, 400);
  assert.equal((await fetch(`${conformanceUrl}?attemptId=foreign`, { headers })).status, 404);
  const conformanceResponse = await fetch(captureUrl, { headers });
  assert.equal(conformanceResponse.status, 200);
  const conformance = await conformanceResponse.json() as DeviceAttemptConformanceReportV1;
  assert.equal(conformance.source.attemptId, attemptId);
  assert.equal(conformance.source.taskId, report.taskId);
  assert.equal(conformance.source.traceId, trace.traceId);
  assert.equal(conformance.source.journalSequence, remainder.latestSequence);
  assert.equal(conformance.transport, "local_process");
  assert.equal(conformance.source.capabilitySnapshotId, snapshotEvidence.snapshotId);
  assert.equal(conformance.checks.find(check => check.id === "capability_binding")?.status, "pass");
  assert.equal(conformance.checks.find(check => check.id === "adapter_receipt")?.status, "pass");
  assert.deepEqual(await (await fetch(captureUrl, { headers })).json(), conformance);
  assert.deepEqual(await (await fetch(`${conformanceUrl}?reportId=${conformance.reportId}`, { headers })).json(), conformance);
  const reports = new SqliteDeviceFabricStore({ databasePath: workspace.paths.databasePath });
  try {
    assert.deepEqual(reports.getConformanceReport(conformance.reportId), conformance);
  } finally {
    reports.close();
  }

  const deviceId = adapterSpans[0]?.lineage?.deviceId;
  assert.ok(deviceId);
  const stopUrl = `http://127.0.0.1:${address.port}/v1/device-support/devices/${encodeURIComponent(deviceId)}/dispatch-stop`;
  const setStop = (active: boolean, expectedRevision: number, extraHeaders: Record<string, string> = {}) => fetch(stopUrl, {
    method: "PUT", headers: { ...headers, ...extraHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ active, expectedRevision }),
  });
  assert.equal((await fetch(stopUrl)).status, 401);
  assert.equal((await setStop(true, 0, { Origin: "https://example.invalid" })).status, 403);
  assert.equal((await setStop(true, 0)).status, 200);
  assert.equal((await (await fetch(stopUrl, { headers })).json()).active, true);
  assert.equal((await setStop(false, 0)).status, 409);
  assert.equal((await setStop(false, 1)).status, 200);

  const journal = new SqliteDeviceSupportStore({ databasePath: workspace.paths.databasePath });
  try {
    const tasks = journal.listRecentDaemonTasks(DEFAULT_WORKSPACE_ID, 10);
    assert.deepEqual(tasks.map(task => task.id), [report.taskId]);
    assert.equal(tasks[0]?.status, "succeeded");
    assert.equal(tasks[0]?.ownerId, tasks[0]?.targetDeviceIds[0]);
    const observations = journal.listObservations(report.taskId);
    assert.equal(observations.length, 5);
    const processes = observations.find(observation => observation.source === "pc.processes");
    assert.ok(processes);
    const processFact = report.facts.find(fact => fact.observationId === processes.id);
    if (processes.quality === "good") {
      const inventory = processes.value as { processes: { pid: number; name: string }[] };
      assert.ok(inventory.processes.length > 0);
      assert.ok(inventory.processes.every(entry => Object.keys(entry).length === 2
        && Number.isSafeInteger(entry.pid) && typeof entry.name === "string"));
      assert.deepEqual(processFact?.value, { count: inventory.processes.length });
    } else {
      assert.deepEqual(processes.value, { status: "unavailable" });
      assert.equal(processFact, undefined);
      assert.ok(report.remainingUncertainty.some(entry => entry.ref === processes.id && entry.code === "unusable_observation"));
    }
    const logs = observations.find(observation => observation.source === "pc.logs");
    assert.ok(logs);
    const logFact = report.facts.find(fact => fact.observationId === logs.id);
    if (logs.quality === "good") {
      const { entries } = logs.value as { entries: { timestamp?: string; level: "error" | "warning" | "unknown"; source: string }[] };
      assert.ok(entries.length <= 200);
      assert.ok(entries.every(entry => Object.keys(entry).every(key => ["timestamp", "level", "source"].includes(key))
        && typeof entry.source === "string" && (entry.timestamp === undefined || Number.isFinite(Date.parse(entry.timestamp)))));
      assert.deepEqual(logFact?.value, {
        count: entries.length,
        error: entries.filter(entry => entry.level === "error").length,
        warning: entries.filter(entry => entry.level === "warning").length,
        unknown: entries.filter(entry => entry.level === "unknown").length,
      });
    } else {
      assert.deepEqual(logs.value, { status: "unavailable" });
      assert.equal(logFact, undefined);
      assert.ok(report.remainingUncertainty.some(entry => entry.ref === logs.id && entry.code === "unusable_observation"));
    }
    const events = journal.listEvents(report.taskId);
    const planIndex = events.findIndex(event => event.type === "device_plan_accepted");
    const firstDispatch = events.findIndex(event => event.type === "attempt_prepared");
    assert.ok(planIndex >= 0 && firstDispatch > planIndex);
    assert.equal(events[planIndex]?.body.source, "local_playbook");
    assert.equal(events[planIndex]?.body.taskId, report.taskId);
    const traceScope = { store: journal, taskId: report.taskId, workspaceId: DEFAULT_WORKSPACE_ID };
    assert.deepEqual(readOwnedDeviceTaskTrace(traceScope), trace);
    assert.deepEqual(readOwnedDeviceAttemptConformance({ ...traceScope, attemptId }), conformance);
    assert.throws(() => readOwnedDeviceTaskTrace({ ...traceScope, workspaceId: "elsewhere" }), /unavailable in this workspace/);
    const input = {
      store: journal, taskId: report.taskId, ownerId: tasks[0]!.ownerId, workspaceId: DEFAULT_WORKSPACE_ID,
      contextId: "fixture-context", maxBytes: 4096, now: new Date().toISOString(),
    };
    const planned = buildOwnedDevicePlanningInput(input);
    assert.deepEqual(planned.context.facts, report.facts.map(fact => fact.value));
    assert.deepEqual(planned.targets.map(target => target.snapshot.deviceId), tasks[0]?.targetDeviceIds);
    assert.throws(() => buildOwnedDevicePlanningInput({ ...input, workspaceId: "elsewhere" }), /outside the workspace/);
  } finally {
    journal.close();
  }

  const retirementUrl = stopUrl.replace(/dispatch-stop$/u, "retirement");
  assert.equal((await fetch(retirementUrl)).status, 401);
  const preview = await fetch(retirementUrl, { headers });
  assert.equal(preview.status, 200);
  const { lifecycleStatus, profileRevision, connectionRevision } = await preview.json() as DeviceRetirementStateV1;
  assert.equal(lifecycleStatus, "healthy");
  const confirm = (revision: string, extraHeaders: Record<string, string> = {}) => fetch(retirementUrl, {
    method: "PUT", headers: { ...headers, ...extraHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ expectedProfileRevision: profileRevision, expectedConnectionRevision: revision }),
  });
  assert.equal((await confirm(connectionRevision, { Origin: "https://example.invalid" })).status, 403);
  assert.equal((await confirm("stale")).status, 409);
  const retired = await confirm(connectionRevision);
  assert.equal(retired.status, 200);
  const retirement = await retired.json() as DeviceRetirementV1;
  assert.equal(retirement.previousStatus, "healthy");
  assert.deepEqual(await (await confirm(connectionRevision)).json(), retirement);
  const retiredFleet = await (await fetch(fleetUrl, { headers })).json() as DeviceFleetHealthProjectionV1;
  assert.equal(retiredFleet.items[0]?.health, "retired");
  assert.equal(retiredFleet.items[0]?.capabilitySnapshotId, undefined);
  const freshDiagnosis = await fetch(url, { method: "POST", headers });
  assert.equal(freshDiagnosis.status, 403);
  assert.deepEqual(await freshDiagnosis.json(), { error: "permission_denied" });
  assert.deepEqual(await (await fetch(traceUrl, { headers })).json(), trace);
  assert.deepEqual(await (await fetch(captureUrl, { headers })).json(), conformance);
  const reopened = new SqliteDeviceSupportStore({ databasePath: workspace.paths.databasePath });
  try {
    assert.deepEqual(reopened.getDeviceRetirementState(deviceId, DEFAULT_WORKSPACE_ID), {
      deviceId, profileRevision, connectionRevision, lifecycleStatus: "retired", retirement,
    });
    assert.ok(reopened.getRecordedCapabilitySnapshot(deviceId, snapshotEvidence.snapshotId));
  } finally {
    reopened.close();
  }
});

test("a PC adapter upgrade refreshes the enrolled target while retaining its historical capability snapshot", async t => {
  const cwd = mkdtempSync(join(tmpdir(), "ling-device-pc-upgrade-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const databasePath = join(cwd, "device.sqlite");
  const initial = createDeviceSupportRuntime({ databasePath });
  const adapterId = "pc-target-executor";
  let deviceId: string;
  const snapshotId = "pc-before-log-inventory";
  try {
    const pc = await initial.broker.discover(adapterId, { ownerId: DEFAULT_WORKSPACE_ID, connectionRef: "local_process" });
    deviceId = pc.device.id;
    const snapshot = initial.store.getCurrentCapabilitySnapshot(deviceId);
    assert.ok(snapshot);
    const legacyVersion = "1.2.0";
    const at = new Date().toISOString();
    assert.equal(initial.store.registerDevice({ ...pc, adapterVersion: legacyVersion }, at), true);
    initial.store.saveCapabilitySnapshot({
      ...snapshot, snapshotId, adapterVersion: legacyVersion,
      capabilities: snapshot.capabilities.filter(capability => capability.id !== "pc.inspect.logs" && capability.id !== "pc.inspect.software"),
    }, at);
  } finally {
    initial.close();
  }

  const upgraded = createDeviceSupportRuntime({ databasePath });
  try {
    assert.equal(upgraded.store.getCurrentCapabilitySnapshot(deviceId), undefined);
    const result = await upgraded.diagnoseLocalPc();
    assert.equal(result.status, "succeeded");
    assert.equal(upgraded.store.listDevices().length, 1);
    assert.deepEqual(result.attempts.map(attempt => attempt.request.targetDeviceId), [deviceId, deviceId, deviceId, deviceId, deviceId]);
    assert.equal(result.report.playbookVersion, "1.3.0");
    const current = upgraded.store.getCurrentCapabilitySnapshot(deviceId);
    assert.equal(current?.adapterVersion, "1.3.0");
    assert.ok(current?.capabilities.some(capability => capability.id === "pc.inspect.logs"));
    const historical = upgraded.store.getRecordedCapabilitySnapshot(deviceId, snapshotId);
    assert.equal(historical?.snapshot.adapterVersion, "1.2.0");
    assert.deepEqual(historical?.snapshot.capabilities.map(capability => capability.id), [
      "pc.inspect.network", "pc.inspect.services", "pc.inspect.processes", "pc.repair.network",
    ]);
  } finally {
    upgraded.close();
  }
});

test("the Daemon reuses Pi for typed diagnosis and preserves provider, fallback and invalid-plan evidence", { timeout: 30_000 }, async t => {
  const cwd = mkdtempSync(join(tmpdir(), "ling-device-pi-diagnosis-"));
  let secondPlan = '{"stepIds":["inspect-network"]}';
  const firstProvider = await startLoopbackPiProvider(() => ({ text: '{"stepIds":["inspect-services"]}' }));
  const secondProvider = await startLoopbackPiProvider(() => ({ text: secondPlan }));
  let secondOnline = true;
  const workspace = createSqliteRunStore(cwd);
  const authToken = "fixture-daemon-authority";
  const headers = { Authorization: `Bearer ${authToken}`, "Content-Type": "application/json" };
  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0, authToken, defaultWorkspaceCwd: cwd }, {
    storeFactory: () => workspace, chromeBrowserNativeMessagingEnabled: false, remoteReplyDispatcher: null,
  });
  t.after(async () => {
    await daemon.stop();
    await firstProvider.close();
    if (secondOnline) await secondProvider.close();
    rmSync(cwd, { recursive: true, force: true });
  });
  const preset = (providerId: string, baseUrl: string) => {
    const at = new Date().toISOString();
    const row = workspace.createProviderPreset({
      kind: "openai-compatible", displayName: providerId, providerId, baseUrl, model: "static-tools",
      api: "openai-completions", capabilities: ["chat"], authHeader: false, reasoning: false,
    }, at);
    workspace.recordProviderCheckResult(row.id, { ok: true, code: "ready", message: "Loopback ready", checkedAt: at });
    return row.id;
  };
  const firstPreset = preset("first-loopback", firstProvider.baseUrl);
  const secondPreset = preset("second-loopback", secondProvider.baseUrl);
  await daemon.start();
  const address = daemon.server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}/v1/device-support`;
  const diagnose = (providerPresetId: string, fallbackProviderPresetId?: string) => fetch(origin + "/pc/diagnose", {
    method: "POST", headers, body: JSON.stringify({ providerPresetId, fallbackProviderPresetId, symptom: "Check a local PC service" }),
  });
  async function checkDiagnosis(
    providerPresetId: string, expectedCapabilities: readonly string[], source: "model" | "graph", fallbackProviderPresetId?: string,
  ) {
    const response = await diagnose(providerPresetId, fallbackProviderPresetId);
    const body = await response.json() as { status: string; report: DeviceDiagnosisReportV1 };
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.status, "succeeded");
    assert.deepEqual(body.report.actions.map(action => action.capabilityId), expectedCapabilities);
    const traceResponse = await fetch(`${origin}/tasks/${body.report.taskId}/trace`, { headers });
    assert.equal(traceResponse.status, 200);
    const trace = await traceResponse.json() as DeviceTaskTraceV1;
    const planning = trace.spans.find(span => span.kind === source);
    assert.ok(planning);
    return { taskId: body.report.taskId, planning, adapters: trace.spans.filter(span => span.kind === "adapter") };
  }
  const first = await checkDiagnosis(firstPreset, ["pc.inspect.services"], "model");
  assert.match(first.planning.lineage?.modelTurnId ?? "", /^device_plan_turn_/u);
  assert.equal(first.adapters[0]?.lineage?.modelTurnId, first.planning.lineage?.modelTurnId);
  assert.match(JSON.stringify(first.planning.metadata), new RegExp(firstPreset, "u"));
  const second = await checkDiagnosis(secondPreset, ["pc.inspect.network"], "model");
  assert.notEqual(second.planning.lineage?.modelTurnId, first.planning.lineage?.modelTurnId);
  assert.match(JSON.stringify(second.planning.metadata), new RegExp(secondPreset, "u"));
  for (const provider of [firstProvider, secondProvider]) {
    const streamed = provider.requests.filter((request: { readonly stream?: boolean }) => request.stream);
    assert.equal(streamed.length, 1);
    assert.equal(streamed[0]?.tools?.length ?? 0, 0);
    assert.match(JSON.stringify(streamed[0]?.messages), /Check a local PC service/u);
    assert.doesNotMatch(JSON.stringify(streamed[0]?.messages), /android\.install|ssh\.write|expectedVerification/u);
  }

  secondPlan = '{"stepIds":["unknown-step"]}';
  assert.equal((await diagnose(firstPreset, firstPreset)).status, 400);
  const invalid = await diagnose(secondPreset, firstPreset);
  assert.equal(invalid.status, 422);
  assert.deepEqual(await invalid.json(), { error: "invalid_device_plan" });
  assert.equal(firstProvider.requests.filter(request => request.stream).length, 1);
  const journal = new SqliteDeviceSupportStore({ databasePath: workspace.paths.databasePath });
  try {
    const rejected = journal.listRecentDaemonTasks(DEFAULT_WORKSPACE_ID, 10).find(task => task.status === "failed");
    assert.ok(rejected);
    assert.deepEqual(journal.listAttempts(rejected.id), []);
    assert.deepEqual(journal.listPlanningAcceptances(rejected.id), []);
  } finally {
    journal.close();
  }
  await secondProvider.close();
  secondOnline = false;
  const fallback = await checkDiagnosis(secondPreset, ["pc.inspect.network", "pc.inspect.services", "pc.inspect.processes", "pc.inspect.logs", "pc.inspect.software"], "graph");
  assert.match(JSON.stringify(fallback.planning.metadata), /runner_unavailable/u);
  const switched = await checkDiagnosis(secondPreset, ["pc.inspect.services"], "model", firstPreset);
  assert.equal(switched.adapters.length, 1);
  assert.equal(switched.adapters[0]?.lineage?.graphId, switched.taskId);
  assert.equal(switched.adapters[0]?.lineage?.modelTurnId, switched.planning.lineage?.modelTurnId);
  const reopened = new SqliteDeviceSupportStore({ databasePath: workspace.paths.databasePath });
  try {
    const plans = reopened.listPlanningAcceptances(switched.taskId);
    assert.equal(plans.length, 1);
    const plan = plans[0]!;
    assert.equal(plan.graph.graphId, switched.taskId);
    assert.equal(plan.providerId, firstPreset);
    const handoff = plan.providerHandoff;
    assert.ok(handoff);
    assert.equal(handoff.fromProviderPresetId, secondPreset);
    assert.equal(handoff.toProviderPresetId, firstPreset);
    assert.equal(handoff.reason, "runner_unavailable");
    assert.notEqual(handoff.fromContextId, plan.contextId);
    assert.deepEqual(switched.planning.metadata, readOwnedDeviceTaskTrace({
      store: reopened, workspaceId: DEFAULT_WORKSPACE_ID, taskId: switched.taskId,
    }).spans.find(span => span.spanId === switched.planning.spanId)?.metadata);
  } finally {
    reopened.close();
  }
  assert.equal((await diagnose("missing-provider")).status, 404);
});
