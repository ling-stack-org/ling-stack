import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { type ApprovalRequest, DEFAULT_WORKSPACE_ID, DeviceBrokerError, DeviceFabricError, readOwnedDeviceAttemptConformance,
  readOwnedDeviceTaskJournal, readOwnedDeviceTaskTrace, requireWorkspaceDeviceTask, resolveDeviceSemanticTargets } from "@ling-stack/core";
import { HttpError } from "../../errors.js";
import { allowLocalServiceRequest } from "../../shared/local-workspace-access.js";
import { readJsonBody, readOptionalJsonBody } from "../../shared/request.js";
import { writePrivateJson } from "../../shared/response.js";
import { isRecord } from "../../shared/validation.js";
import type { DeviceDiagnosisRequest } from "./diagnosis-planner.js";
import { isHomeAssistantAutomationEntity, isHomeAssistantReloadTarget } from "./adapters/home-assistant.js";
import { isHomeAssistantCatalogKind } from "./adapters/home-assistant-catalog.js";
import { handleDeviceProtocolRoute } from "./protocol-routes.js";
import { handleDeviceResourceRoute } from "./resource-routes.js";
import { handleDeviceDeveloperRoute } from "./developer-routes.js";
import { handleEdgeRuntimeRoute } from "./edge-routes.js";
import type { DeviceSupportRuntime } from "./runtime.js";

export async function handleDeviceSupportRoute(
  url: URL,
  request: IncomingMessage,
  response: ServerResponse,
  runtime: DeviceSupportRuntime,
  onApprovalCreated?: (approval: ApprovalRequest) => void,
): Promise<boolean> {
  if (url.pathname.startsWith("/v1/device-support/developer/")) return await handleDeviceDeveloperRoute(url, request, response, runtime);
  if (url.pathname.startsWith("/v1/device-support/resources")) return await handleDeviceResourceRoute(url, request, response, runtime);
  if (url.pathname.startsWith("/v1/device-support/protocol/")) return await handleDeviceProtocolRoute(url, request, response, runtime);
  if (url.pathname.startsWith("/v1/device-support/fabric/edge-runtimes")) return await handleEdgeRuntimeRoute(url, request, response, runtime);
  const taskPath = /^\/v1\/device-support\/tasks\/([^/]+)\/(events|trace|conformance|resume)$/u.exec(url.pathname);
  const deviceOperation = /^\/v1\/device-support\/devices\/([^/]+)\/(dispatch-stop|retirement)$/u.exec(url.pathname);
  const accessGrantOperation = /^\/v1\/device-support\/devices\/([^/]+)\/access-grants\/([^/]+)$/u.exec(url.pathname);
  const configuredTargetRoute = /^\/v1\/device-support\/(linux|android)\/(targets|enroll|diagnose)$/u.exec(url.pathname);
  const modbusDiagnosis = url.pathname === "/v1/device-support/modbus/diagnose";
  const homeAssistant = url.pathname === "/v1/device-support/home-assistant/diagnose";
  const homeAssistantProposal = /^\/v1\/device-support\/home-assistant\/(reload-proposals|automation-enable-proposals)$/u.exec(url.pathname)?.[1];
  const homeAssistantCatalog = url.pathname === "/v1/device-support/home-assistant/catalog";
  const fleetHealth = url.pathname === "/v1/device-support/fleet/health";
  const capabilityLookup = url.pathname === "/v1/device-support/capabilities";
  const fabricGraph = url.pathname === "/v1/device-support/fabric/graph";
  const fabricTaskGraph = /^\/v1\/device-support\/fabric\/task-graphs\/([^/]+)$/u.exec(url.pathname);
  if (url.pathname !== "/v1/device-support/pc/diagnose" && !taskPath && !deviceOperation && !accessGrantOperation
    && !configuredTargetRoute && !modbusDiagnosis && !homeAssistant && !homeAssistantProposal && !homeAssistantCatalog && !fleetHealth && !capabilityLookup
    && !fabricGraph && !fabricTaskGraph) return false;
  if (!allowLocalServiceRequest(request, response)) return true;
  if (taskPath) {
    if (taskPath[2] === "resume") await resumeDiagnosis(taskPath[1]!, request, response, runtime);
    else writeTaskProjection(url, taskPath[1]!, taskPath[2]!, request, response, runtime);
    return true;
  }
  if (deviceOperation) {
    const handle = deviceOperation[2] === "retirement" ? handleDeviceRetirement : handleDispatchStop;
    await handle(deviceOperation[1]!, request, response, runtime);
    return true;
  }
  if (accessGrantOperation) {
    await handleDeviceAccessGrant(accessGrantOperation[1]!, accessGrantOperation[2]!, request, response, runtime);
    return true;
  }
  if (configuredTargetRoute) {
    await handleConfiguredDeviceRequest(configuredTargetRoute[1]!, configuredTargetRoute[2]!, request, response, runtime);
    return true;
  }
  if (modbusDiagnosis) {
    await handleModbusDiagnosis(request, response, runtime);
    return true;
  }
  if (homeAssistant) {
    await handleHomeAssistantDiagnosis(request, response, runtime);
    return true;
  }
  if (homeAssistantProposal) {
    await handleHomeAssistantProposal(request, response, runtime, homeAssistantProposal === "reload-proposals", onApprovalCreated);
    return true;
  }
  if (homeAssistantCatalog) {
    await handleHomeAssistantCatalog(url, request, response, runtime);
    return true;
  }
  if (capabilityLookup) {
    writeSemanticTargets(url, request, response, runtime);
    return true;
  }
  if (fabricGraph) {
    writeFabricGraph(request, response, runtime);
    return true;
  }
  if (fabricTaskGraph) {
    writeFabricTaskGraph(fabricTaskGraph[1]!, request, response, runtime);
    return true;
  }
  if (fleetHealth) {
    if (request.method !== "GET") {
      response.setHeader("Allow", "GET");
      writePrivateJson(response, 405, { error: "method_not_allowed" });
      return true;
    }
    try {
      writePrivateJson(response, 200, runtime.fleetHealth());
    } catch {
      writePrivateJson(response, 503, { error: "service_unavailable" });
    }
    return true;
  }
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    writePrivateJson(response, 405, { error: "method_not_allowed" });
    return true;
  }
  try {
    let requestBody: unknown;
    try {
      requestBody = await readOptionalJsonBody(request, 4096);
    } catch {
      throw new DeviceBrokerError("invalid_request", "invalid PC diagnosis request");
    }
    const { status, report } = await runtime.diagnoseLocalPc(readDiagnosisOptions(requestBody));
    writePrivateJson(response, 200, { status, report });
  } catch (error) {
    writeDeviceOperationError(response, error);
  }
  return true;
}

function writeFabricGraph(request: IncomingMessage, response: ServerResponse, runtime: DeviceSupportRuntime): void {
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    writePrivateJson(response, 405, { error: "method_not_allowed" });
    return;
  }
  try {
    const generatedAt = new Date().toISOString();
    const now = Date.parse(generatedAt);
    const profiles = runtime.store.listDevices().filter(profile => profile.device.ownerScope === DEFAULT_WORKSPACE_ID);
    const registry = new Map(profiles.map(profile => {
      const { id } = profile.device;
      const { profileRevision, connectionRevision, lifecycleStatus } = runtime.store.getDeviceRetirementState(id, DEFAULT_WORKSPACE_ID);
      return [id, { profileRevision, connectionRevision, lifecycleStatus }] as const;
    }));
    const graphNodes = runtime.fabricStore.listGraphNodes()
      .filter(node => node.deviceId !== undefined && registry.has(node.deviceId));
    const nodeIds = new Set(graphNodes.map(node => node.nodeId));
    const representedDeviceIds = new Set(graphNodes.filter(node => node.kind === "device").map(node => node.deviceId));
    const registryNodes = profiles.filter(profile => !representedDeviceIds.has(profile.device.id)).map(profile => {
      const { id: deviceId, kind: deviceKind, displayName: label } = profile.device;
      const digest = createHash("sha256").update(deviceId).digest("hex");
      return {
        nodeId: `registry:${digest}`, kind: "device", deviceId, label, deviceKind, revision: 0,
        source: "registry", ...registry.get(deviceId),
      };
    });
    const relationships = runtime.fabricStore.listGraphRelationships()
      .filter(relationship => nodeIds.has(relationship.fromNodeId) && nodeIds.has(relationship.toNodeId));
    const twins = [...registry.keys()].flatMap(deviceId => {
      const twin = runtime.fabricStore.getTwin(deviceId);
      const current = registry.get(deviceId);
      return twin ? [{
        deviceId, revision: twin.revision, updatedAt: twin.updatedAt,
        values: twin.values.map(value => ({
          key: value.key, observedAt: value.observedAt, freshnessUntil: value.freshnessUntil,
          quality: Date.parse(value.freshnessUntil) <= now
            || (value.reportedEvidence && (value.reportedEvidence.connectionRevision !== current?.connectionRevision
              || value.reportedEvidence.profileRevision !== current.profileRevision
              || current.lifecycleStatus !== "healthy")) ? "stale" : value.quality,
          ...(value.reportedEvidence ? { reportedEvidence: value.reportedEvidence } : {}),
          hasReported: value.reported !== undefined, hasDesired: value.desired !== undefined,
          hasPending: value.pending !== undefined, hasVerified: value.verified !== undefined,
        })),
      }] : [];
    });
    writePrivateJson(response, 200, {
      generatedAt,
      nodes: [
        ...graphNodes.map(({ nodeId, kind, deviceId, parentNodeId, label, deviceKind, revision }) => ({
          nodeId, kind, deviceId, parentNodeId: parentNodeId && nodeIds.has(parentNodeId) ? parentNodeId : undefined,
          label, deviceKind, revision,
          ...(kind === "device" && deviceId ? registry.get(deviceId) : undefined),
        })),
        ...registryNodes,
      ],
      relationships: relationships.map(({ relationshipId, fromNodeId, toNodeId, type, revision }) => ({
        relationshipId, fromNodeId, toNodeId, type, revision,
      })),
      twins,
    });
  } catch (error) {
    writeDeviceOperationError(response, error);
  }
}

function writeFabricTaskGraph(encodedGraphId: string, request: IncomingMessage, response: ServerResponse, runtime: DeviceSupportRuntime): void {
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    writePrivateJson(response, 405, { error: "method_not_allowed" });
    return;
  }
  try {
    const graphId = readDeviceReference(encodedGraphId);
    requireWorkspaceDeviceTask(runtime.store, graphId, DEFAULT_WORKSPACE_ID);
    const graph = runtime.readDiagnosisGraph(graphId);
    if (!graph) {
      throw new DeviceBrokerError("missing_target", "device task graph is unavailable in this workspace");
    }
    writePrivateJson(response, 200, graph);
  } catch (error) {
    writeDeviceOperationError(response, error);
  }
}

function writeSemanticTargets(url: URL, request: IncomingMessage, response: ServerResponse, runtime: DeviceSupportRuntime): void {
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    writePrivateJson(response, 405, { error: "method_not_allowed" });
    return;
  }
  const verb = url.searchParams.get("verb");
  const deviceId = url.searchParams.get("deviceId");
  try {
    if (verb === null || !/^[a-z][a-z0-9_.-]{0,127}$/u.test(verb)
      || (deviceId !== null && (!validBoundedText(deviceId, 512) || deviceId !== deviceId.trim()))) {
      throw new DeviceBrokerError("invalid_request", "invalid semantic capability lookup");
    }
    const evaluatedAt = new Date().toISOString();
    const targets = resolveDeviceSemanticTargets({ store: runtime.store, workspaceId: DEFAULT_WORKSPACE_ID,
      semanticVerb: verb, targetDeviceId: deviceId ?? undefined, evaluatedAt });
    writePrivateJson(response, 200, { semanticVerb: verb, evaluatedAt, targets });
  } catch (error) {
    writeDeviceOperationError(response, error);
  }
}

async function handleHomeAssistantDiagnosis(request: IncomingMessage, response: ServerResponse, runtime: DeviceSupportRuntime): Promise<void> {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    writePrivateJson(response, 405, { error: "method_not_allowed" });
    return;
  }
  try {
    const body = await readJsonBody(request, 4096).catch(() => undefined);
    if (!isRecord(body) || typeof body.entityId !== "string" || body.entityId.length > 160
      || !/^[a-z0-9_]+\.[a-z0-9_]+$/u.test(body.entityId)) {
      throw new DeviceBrokerError("invalid_request", "Home Assistant diagnosis requires an entity ID");
    }
    const { entityId, entryId, maxReportAgeMs, ...options } = body;
    if (entryId !== undefined && (!isHomeAssistantReloadTarget({ entryId, entityId }) || maxReportAgeMs !== undefined)) {
      throw new DeviceBrokerError("invalid_request", "invalid Home Assistant integration diagnosis request");
    }
    if (maxReportAgeMs !== undefined && (typeof maxReportAgeMs !== "number" || !Number.isSafeInteger(maxReportAgeMs) || maxReportAgeMs < 1)) {
      throw new DeviceBrokerError("invalid_request", "invalid Home Assistant max report age");
    }
    const { status, report } = await runtime.diagnoseHomeAssistant(entityId, {
      ...readDiagnosisOptions(options), maxReportAgeMs, entryId: typeof entryId === "string" ? entryId : undefined,
    });
    writePrivateJson(response, 200, { status, report });
  } catch (error) {
    writeDeviceOperationError(response, error);
  }
}

async function handleHomeAssistantProposal(request: IncomingMessage, response: ServerResponse,
  runtime: DeviceSupportRuntime, reload: boolean, onApprovalCreated?: (approval: ApprovalRequest) => void): Promise<void> {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    writePrivateJson(response, 405, { error: "method_not_allowed" });
    return;
  }
  try {
    const body = await readJsonBody(request, 4096).catch(() => undefined);
    if (!isRecord(body)) throw new DeviceBrokerError("invalid_request", "Home Assistant proposal requires a target");
    let approval: ApprovalRequest;
    if (reload) {
      if (Object.keys(body).length !== 2 || !isHomeAssistantReloadTarget(body)) {
        throw new DeviceBrokerError("invalid_request", "Home Assistant reload proposal requires an integration and an entity");
      }
      approval = await runtime.proposeHomeAssistantReload(body);
    } else {
      if (Object.keys(body).length !== 1 || !isHomeAssistantAutomationEntity(body.entityId)) {
        throw new DeviceBrokerError("invalid_request", "Home Assistant enable proposal requires an automation entity");
      }
      approval = await runtime.proposeHomeAssistantAutomationEnable(body.entityId);
    }
    onApprovalCreated?.(approval);
    writePrivateJson(response, 201, { approval });
  } catch (error) {
    writeDeviceOperationError(response, error);
  }
}

export async function handleDeviceApprovalItem(request: IncomingMessage, response: ServerResponse,
  runtime: DeviceSupportRuntime, route: { readonly approvalId: string; readonly action?: "approve" | "deny" },
  workspaceMatches: boolean, onResolved: (approval: ApprovalRequest) => void): Promise<void> {
  if (!allowLocalServiceRequest(request, response)) return;
  if (!workspaceMatches) {
    writePrivateJson(response, 404, { error: "approval_not_found" });
    return;
  }
  const method = route.action ? "POST" : "GET";
  if (request.method !== method) {
    response.setHeader("Allow", method);
    writePrivateJson(response, 405, { error: "method_not_allowed" });
    return;
  }
  try {
    if (!route.action) {
      const approval = runtime.approvalQueue.get(route.approvalId);
      if (!approval) {
        writePrivateJson(response, 404, { error: "approval_not_found" });
        return;
      }
      writePrivateJson(response, 200, { approval });
      return;
    }
    const body = await readOptionalJsonBody(request, 4096).catch(() => null);
    if (body !== undefined && (!isRecord(body) || Object.keys(body).some(key => key !== "reason" && key !== "decisionKind")
      || (body.reason !== undefined && typeof body.reason !== "string")
      || (body.decisionKind !== undefined && (route.action !== "approve" || body.decisionKind !== "approve_once")))) {
      throw new DeviceBrokerError("invalid_request", "device actions require a one-time approval or denial");
    }
    const approval = await runtime.approvalQueue.resolve(route.approvalId, route.action);
    onResolved(approval);
    writePrivateJson(response, 200, { approval });
  } catch (error) {
    writeDeviceOperationError(response, error);
  }
}

async function handleHomeAssistantCatalog(url: URL, request: IncomingMessage, response: ServerResponse, runtime: DeviceSupportRuntime): Promise<void> {
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    writePrivateJson(response, 405, { error: "method_not_allowed" });
    return;
  }
  try {
    const params = url.searchParams;
    const keys = [...params.keys()];
    const kind = params.get("kind");
    const limit = params.get("limit");
    if (!isHomeAssistantCatalogKind(kind) || keys.some(key => !["kind", "limit", "after"].includes(key))
      || new Set(keys).size !== keys.length || (limit !== null && !/^\d{1,3}$/u.test(limit))) {
      throw new DeviceBrokerError("invalid_request", "Home Assistant catalog query is invalid");
    }
    const page = await runtime.readHomeAssistantCatalog({ kind, limit: limit === null ? 50 : Number(limit), after: params.get("after") ?? undefined });
    writePrivateJson(response, 200, page);
  } catch (error) {
    writeDeviceOperationError(response, error);
  }
}

async function handleDispatchStop(
  encodedDeviceId: string, request: IncomingMessage, response: ServerResponse, runtime: DeviceSupportRuntime,
): Promise<void> {
  if (request.method !== "GET" && request.method !== "PUT") {
    response.setHeader("Allow", "GET, PUT");
    writePrivateJson(response, 405, { error: "method_not_allowed" });
    return;
  }
  try {
    const deviceId = readDeviceReference(encodedDeviceId);
    if (request.method === "GET") {
      if (runtime.store.getDevice(deviceId)?.device.ownerScope !== DEFAULT_WORKSPACE_ID) {
        throw new DeviceBrokerError("missing_target", "device is unavailable in this workspace");
      }
      writePrivateJson(response, 200, runtime.store.getDispatchStop(deviceId));
      return;
    }
    const body = await readJsonBody(request, 1024).catch(() => undefined);
    if (!isRecord(body) || Object.keys(body).length !== 2 || typeof body.active !== "boolean"
      || typeof body.expectedRevision !== "number" || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0) {
      throw new DeviceBrokerError("invalid_request", "invalid device dispatch stop");
    }
    writePrivateJson(response, 200, runtime.broker.setDispatchStop({
      deviceId, workspaceId: DEFAULT_WORKSPACE_ID, active: body.active, expectedRevision: body.expectedRevision,
    }));
  } catch (error) {
    writeDeviceOperationError(response, error);
  }
}

async function handleDeviceRetirement(
  encodedDeviceId: string, request: IncomingMessage, response: ServerResponse, runtime: DeviceSupportRuntime,
): Promise<void> {
  if (request.method !== "GET" && request.method !== "PUT") {
    response.setHeader("Allow", "GET, PUT");
    writePrivateJson(response, 405, { error: "method_not_allowed" });
    return;
  }
  try {
    const deviceId = readDeviceReference(encodedDeviceId);
    if (request.method === "GET") {
      writePrivateJson(response, 200, runtime.store.getDeviceRetirementState(deviceId, DEFAULT_WORKSPACE_ID));
      return;
    }
    const body = await readJsonBody(request, 4096).catch(() => undefined);
    if (!isRecord(body) || Object.keys(body).length !== 2
      || !validBoundedText(body.expectedProfileRevision, 512) || !validBoundedText(body.expectedConnectionRevision, 512)) {
      throw new DeviceBrokerError("invalid_request", "invalid device retirement request");
    }
    writePrivateJson(response, 200, runtime.broker.retireDevice({
      deviceId, workspaceId: DEFAULT_WORKSPACE_ID,
      expectedProfileRevision: body.expectedProfileRevision, expectedConnectionRevision: body.expectedConnectionRevision,
    }));
  } catch (error) {
    writeDeviceOperationError(response, error);
  }
}

async function handleDeviceAccessGrant(
  encodedDeviceId: string, encodedGrantId: string, request: IncomingMessage, response: ServerResponse, runtime: DeviceSupportRuntime,
): Promise<void> {
  if (request.method !== "GET" && request.method !== "PUT") {
    response.setHeader("Allow", "GET, PUT");
    writePrivateJson(response, 405, { error: "method_not_allowed" });
    return;
  }
  try {
    const deviceId = readDeviceReference(encodedDeviceId);
    const grantId = readDeviceReference(encodedGrantId);
    if (request.method === "GET") {
      writePrivateJson(response, 200, runtime.getAccessGrant(deviceId, grantId));
      return;
    }
    const body = await readJsonBody(request, 16 * 1024).catch(() => undefined);
    if (!isRecord(body) || typeof body.expectedRevision !== "number" || !Number.isSafeInteger(body.expectedRevision)
      || body.expectedRevision < 0 || body.expectedRevision === Number.MAX_SAFE_INTEGER) {
      throw new DeviceBrokerError("invalid_request", "invalid device access grant revision");
    }
    const { expectedRevision } = body;
    if (body.action === "revoke") {
      if (expectedRevision < 1 || Object.keys(body).length !== 2) {
        throw new DeviceBrokerError("invalid_request", "invalid device access grant revoke");
      }
      writePrivateJson(response, 200, runtime.revokeAccessGrant({ deviceId, grantId, expectedRevision }));
      return;
    }
    if (Object.keys(body).length !== 6 || body.action !== "grant"
      || !validBoundedText(body.principalId, 512) || (body.scope !== "read_only" && body.scope !== "developer")
      || !Array.isArray(body.capabilityIds) || body.capabilityIds.length > 100
      || !body.capabilityIds.every(value => validBoundedText(value, 256))
      || typeof body.expiresAt !== "string" || !Number.isFinite(Date.parse(body.expiresAt))
      || new Date(body.expiresAt).toISOString() !== body.expiresAt) {
      throw new DeviceBrokerError("invalid_request", "invalid device access grant");
    }
    writePrivateJson(response, 200, runtime.saveAccessGrant({
      deviceId, grantId, expectedRevision, principalId: body.principalId, scope: body.scope,
      capabilityIds: body.capabilityIds, expiresAt: body.expiresAt,
    }));
  } catch (error) {
    writeDeviceOperationError(response, error);
  }
}

function readDeviceReference(encodedDeviceId: string): string {
  let deviceId: string;
  try {
    deviceId = decodeURIComponent(encodedDeviceId);
  } catch {
    throw new DeviceBrokerError("invalid_request", "invalid device reference");
  }
  if (!validBoundedText(deviceId, 512) || deviceId.trim() !== deviceId) {
    throw new DeviceBrokerError("invalid_request", "invalid device reference");
  }
  return deviceId;
}

async function handleConfiguredDeviceRequest(
  ecosystem: string, action: string, request: IncomingMessage, response: ServerResponse, runtime: DeviceSupportRuntime,
): Promise<void> {
  const method = action === "targets" ? "GET" : "POST";
  if (request.method !== method) {
    response.setHeader("Allow", method);
    writePrivateJson(response, 405, { error: "method_not_allowed" });
    return;
  }
  const target = ecosystem === "android" ? {
    list: runtime.listAndroidAdbTargets, enroll: runtime.enrollAndroidAdbTarget, diagnose: runtime.diagnoseAndroidAdbTarget,
  } : {
    list: runtime.listLinuxSshTargets, enroll: runtime.enrollLinuxSshTarget, diagnose: runtime.diagnoseLinuxSshTarget,
  };
  try {
    if (action === "targets") {
      writePrivateJson(response, 200, { targets: target.list() });
      return;
    }
    const body = await readJsonBody(request, 4096).catch(() => { throw new DeviceBrokerError("invalid_request", "Invalid device target request"); });
    const key = action === "enroll" ? "connectionId" : "deviceId";
    const id = isRecord(body) ? body[key] : undefined;
    if (!isRecord(body) || !validBoundedText(id, 256) || id.trim() !== id) {
      throw new DeviceBrokerError("invalid_request", "Device request requires a target reference");
    }
    if (action === "enroll") {
      if (Object.keys(body).length !== 1) throw new DeviceBrokerError("invalid_request", "invalid device enrollment request");
      writePrivateJson(response, 200, { profile: await target.enroll(id) });
      return;
    }
    const { deviceId: _deviceId, ...options } = body;
    const { status, report } = await target.diagnose(id, readDiagnosisOptions(options));
    writePrivateJson(response, 200, { status, report });
  } catch (error) {
    writeDeviceOperationError(response, error);
  }
}

async function handleModbusDiagnosis(request: IncomingMessage, response: ServerResponse, runtime: DeviceSupportRuntime): Promise<void> {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    writePrivateJson(response, 405, { error: "method_not_allowed" });
    return;
  }
  try {
    const body = await readJsonBody(request, 4096).catch(() => { throw new DeviceBrokerError("invalid_request", "Invalid Modbus diagnosis request"); });
    if (!isRecord(body) || !validBoundedText(body.deviceId, 256) || body.deviceId.trim() !== body.deviceId) {
      throw new DeviceBrokerError("invalid_request", "Modbus diagnosis requires a device reference");
    }
    const { deviceId, ...options } = body;
    const { status, report } = await runtime.diagnoseModbusTarget(deviceId, readDiagnosisOptions(options));
    writePrivateJson(response, 200, { status, report });
  } catch (error) {
    writeDeviceOperationError(response, error);
  }
}

function readDiagnosisOptions(value: unknown): DeviceDiagnosisRequest {
  if (value === undefined) return {};
  if (!isRecord(value) || Object.keys(value).some(key => !["providerPresetId", "fallbackProviderPresetId", "symptom"].includes(key))) {
    throw new DeviceBrokerError("invalid_request", "invalid device diagnosis options");
  }
  const { providerPresetId, fallbackProviderPresetId, symptom } = value;
  if (providerPresetId !== undefined && (!validBoundedText(providerPresetId, 256) || providerPresetId.trim() !== providerPresetId)) {
    throw new DeviceBrokerError("invalid_request", "invalid diagnosis provider");
  }
  if (fallbackProviderPresetId !== undefined && (!providerPresetId || !validBoundedText(fallbackProviderPresetId, 256)
    || fallbackProviderPresetId.trim() !== fallbackProviderPresetId || fallbackProviderPresetId === providerPresetId)) {
    throw new DeviceBrokerError("invalid_request", "invalid fallback diagnosis provider");
  }
  if (symptom !== undefined && (providerPresetId === undefined || !validBoundedText(symptom, 2048))) {
    throw new DeviceBrokerError("invalid_request", "invalid diagnosis symptom");
  }
  return { providerPresetId, fallbackProviderPresetId, symptom };
}

function validBoundedText(value: unknown, maxBytes: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && Buffer.byteLength(value, "utf8") <= maxBytes;
}

function writeDeviceOperationError(response: ServerResponse, error: unknown): void {
  if (error instanceof HttpError) {
    writePrivateJson(response, error.statusCode, { error: error.code });
    return;
  }
  if (error instanceof DeviceFabricError && error.code === "invalid_graph") {
    writePrivateJson(response, 422, { error: "invalid_device_plan" });
    return;
  }
  const code = error instanceof DeviceBrokerError || (error instanceof DeviceFabricError && error.code === "target_changed")
    ? error.code : "service_unavailable";
  const statuses = { invalid_request: 400, missing_target: 404, permission_denied: 403, target_changed: 409, target_busy: 409, stale_snapshot: 409,
    authentication_required: 409 };
  writePrivateJson(response, Object.hasOwn(statuses, code) ? statuses[code as keyof typeof statuses] : 503, { error: code });
}

function writeTaskProjection(
  url: URL, encodedTaskId: string, projection: string, request: IncomingMessage, response: ServerResponse, runtime: DeviceSupportRuntime,
): void {
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    writePrivateJson(response, 405, { error: "method_not_allowed" });
    return;
  }
  try {
    const taskId = decodeURIComponent(encodedTaskId);
    if (!taskId.trim() || Buffer.byteLength(taskId, "utf8") > 256) {
      throw new DeviceBrokerError("invalid_request", "device task id is invalid");
    }
    const scope = { store: runtime.store, workspaceId: DEFAULT_WORKSPACE_ID, taskId };
    if (projection === "conformance") {
      writePrivateJson(response, 200, taskConformance(url.searchParams, taskId, runtime));
      return;
    }
    writePrivateJson(response, 200, projection === "trace" ? readOwnedDeviceTaskTrace(scope) : readOwnedDeviceTaskJournal({
      ...scope, afterSequence: optionalCursorNumber(url, "afterSequence"),
      generation: optionalCursorNumber(url, "generation"), limit: optionalCursorNumber(url, "limit"),
    }));
  } catch (error) {
    if (error instanceof URIError || (error instanceof DeviceBrokerError && error.code === "invalid_request")) {
      writePrivateJson(response, 400, { error: "invalid_request" });
    } else if (error instanceof DeviceBrokerError && error.code === "missing_target") {
      writePrivateJson(response, 404, { error: "missing_target" });
    } else {
      writePrivateJson(response, 503, { error: "service_unavailable" });
    }
  }
}

async function resumeDiagnosis(encodedTaskId: string, request: IncomingMessage, response: ServerResponse, runtime: DeviceSupportRuntime): Promise<void> {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    writePrivateJson(response, 405, { error: "method_not_allowed" });
    return;
  }
  try {
    const { status, report } = await runtime.resumeDiagnosis(readDeviceReference(encodedTaskId));
    writePrivateJson(response, 200, { status, report });
  } catch (error) {
    writeDeviceOperationError(response, error);
  }
}

function taskConformance(params: URLSearchParams, taskId: string, runtime: DeviceSupportRuntime) {
  const keys = [...params.keys()];
  const attemptId = params.get("attemptId");
  const reportId = params.get("reportId");
  if (keys.length !== 1 || !validBoundedText(attemptId ?? reportId, 512)) {
    throw new DeviceBrokerError("invalid_request", "device conformance requires one attempt or report ID");
  }
  const scope = { store: runtime.store, workspaceId: DEFAULT_WORKSPACE_ID, taskId };
  if (attemptId !== null) {
    const report = readOwnedDeviceAttemptConformance({ ...scope, attemptId });
    runtime.fabricStore.saveConformanceReport(report);
    return report;
  }
  requireWorkspaceDeviceTask(runtime.store, taskId, scope.workspaceId);
  const report = reportId === null ? undefined : runtime.fabricStore.getConformanceReport(reportId);
  const source = report && "source" in report ? report.source : undefined;
  if (!report || !isRecord(source) || source.workspaceId !== scope.workspaceId || source.taskId !== taskId) {
    throw new DeviceBrokerError("missing_target", "device conformance report is unavailable in this task");
  }
  return report;
}

function optionalCursorNumber(url: URL, key: string): number | undefined {
  const value = url.searchParams.get(key);
  if (value === null) return undefined;
  if (!/^\d+$/u.test(value)) throw new DeviceBrokerError("invalid_request", "device journal cursor is invalid");
  return Number(value);
}
