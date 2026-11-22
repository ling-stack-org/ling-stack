import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { DeviceDeveloperSessionV1 } from "@ling-stack/contracts";
import { DEFAULT_WORKSPACE_ID, DeviceBrokerError, DeviceFabricError } from "@ling-stack/core";
import { allowLocalServiceRequest } from "../../shared/local-workspace-access.js";
import { readJsonBody } from "../../shared/request.js";
import { writePrivateJson } from "../../shared/response.js";
import { isRecord } from "../../shared/validation.js";
import type { DeviceSupportRuntime } from "./runtime.js";

const developerPath = "/v1/device-support/developer/sessions";
const sessionPath = /^\/v1\/device-support\/developer\/sessions\/([^/]+)(?:\/(authorize)|\/jobs\/([^/]+))?$/u;

export async function handleDeviceDeveloperRoute(
  url: URL,
  request: IncomingMessage,
  response: ServerResponse,
  runtime: DeviceSupportRuntime,
): Promise<boolean> {
  const match = sessionPath.exec(url.pathname);
  if (!match && url.pathname !== developerPath) return false;
  if (!allowLocalServiceRequest(request, response)) return true;
  const [sessionId, authorize, jobId] = match?.slice(1) ?? [];
  const method = !sessionId || authorize ? "POST" : "GET";
  if (request.method !== method) {
    response.setHeader("Allow", method);
    writePrivateJson(response, 405, { error: "method_not_allowed" });
    return true;
  }
  try {
    if (!sessionId) {
      await createSession(request, response, runtime);
      return true;
    }
    if (authorize) {
      await authorizeSession(sessionId, request, response, runtime);
      return true;
    }
    const session = requireSession(runtime, sessionId);
    if (!jobId) {
      writePrivateJson(response, 200, { session });
      return true;
    }
    const job = runtime.developerSessions.getJob(readReference(jobId));
    if (!job || job.sessionId !== session.sessionId || job.targetDeviceId !== session.targetDeviceId) {
      throw new DeviceBrokerError("missing_target", "developer job is unavailable");
    }
    writePrivateJson(response, 200, { job });
  } catch (error) {
    writeDeveloperError(response, error);
  }
  return true;
}

async function createSession(request: IncomingMessage, response: ServerResponse, runtime: DeviceSupportRuntime): Promise<void> {
  const body = await readJsonBody(request, 4096).catch(() => undefined);
  if (!isRecord(body) || Object.keys(body).length !== 2 || !boundedReference(body.targetDeviceId)
    || (body.mode !== "standard" && body.mode !== "developer")) {
    throw new DeviceBrokerError("invalid_request", "invalid device session");
  }
  const target = runtime.store.getDeviceRetirementState(body.targetDeviceId, DEFAULT_WORKSPACE_ID);
  assertTargetActive(target.lifecycleStatus);
  const profile = runtime.store.getDevice(target.deviceId)!;
  const now = new Date().toISOString();
  const session = runtime.developerSessions.createSession({
    sessionId: `developer_${randomUUID()}`, workspaceId: DEFAULT_WORKSPACE_ID,
    ownerKind: "daemon", ownerId: DEFAULT_WORKSPACE_ID, targetDeviceId: target.deviceId,
    targetKind: profile.device.kind, mode: body.mode, authorizationRevision: `pending_${randomUUID()}`,
    targetBinding: { profileRevision: target.profileRevision, connectionRevision: target.connectionRevision },
    status: "created", revision: 1, createdAt: now, updatedAt: now,
  });
  writePrivateJson(response, 201, { session });
}

async function authorizeSession(
  encoded: string,
  request: IncomingMessage,
  response: ServerResponse,
  runtime: DeviceSupportRuntime,
): Promise<void> {
  const body = await readJsonBody(request, 2048).catch(() => undefined);
  if (!isRecord(body) || Object.keys(body).length !== 1 || typeof body.expectedRevision !== "number"
    || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 1) {
    throw new DeviceBrokerError("invalid_request", "invalid device session authorization");
  }
  const session = requireSession(runtime, encoded);
  if (!session.targetBinding || session.protocolReplay) {
    throw new DeviceBrokerError("permission_denied", "session has a separate authorization flow");
  }
  if (body.expectedRevision !== session.revision || session.status !== "created") {
    throw new DeviceBrokerError("target_changed", "device session authorization changed");
  }
  const target = runtime.store.getDeviceRetirementState(session.targetDeviceId, session.workspaceId);
  assertTargetActive(target.lifecycleStatus);
  if (session.targetBinding.profileRevision !== target.profileRevision || session.targetBinding.connectionRevision !== target.connectionRevision) {
    throw new DeviceBrokerError("target_changed", "device session target binding changed");
  }
  const authorized = runtime.developerSessions.authorize(
    session.sessionId, `auth_${randomUUID()}`, new Date().toISOString(), body.expectedRevision,
  );
  writePrivateJson(response, 200, { session: authorized });
}

function assertTargetActive(lifecycleStatus: string): void {
  if (["revoked", "retired", "offline"].includes(lifecycleStatus)) {
    throw new DeviceBrokerError("target_changed", "device session target is unavailable");
  }
}

function requireSession(runtime: DeviceSupportRuntime, encoded: string): DeviceDeveloperSessionV1 {
  const session = runtime.developerSessions.getSession(readReference(encoded));
  if (!session || session.workspaceId !== DEFAULT_WORKSPACE_ID || session.ownerKind !== "daemon"
    || session.ownerId !== DEFAULT_WORKSPACE_ID
    || runtime.store.getDevice(session.targetDeviceId)?.device.ownerScope !== session.workspaceId) {
    throw new DeviceBrokerError("missing_target", "device session is unavailable");
  }
  return session;
}

function readReference(encoded: string): string {
  const value = decodeURIComponent(encoded);
  if (!boundedReference(value)) throw new DeviceBrokerError("invalid_request", "invalid device session reference");
  return value;
}

function boundedReference(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0
    && Buffer.byteLength(value, "utf8") <= 512 && !/[\u0000-\u001f\u007f]/u.test(value);
}

function writeDeveloperError(response: ServerResponse, error: unknown): void {
  const code = error instanceof DeviceBrokerError || error instanceof DeviceFabricError ? error.code
    : error instanceof URIError ? "invalid_request" : "service_unavailable";
  const status = code === "target_missing" || code === "missing_target" ? 404
    : code === "safety_denied" || code === "permission_denied" ? 403
    : code === "target_changed" || code === "revision_conflict" ? 409
    : code === "invalid_request" ? 400 : 503;
  writePrivateJson(response, status, { error: code });
}
