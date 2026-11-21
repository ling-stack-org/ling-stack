import type { IncomingMessage, ServerResponse } from "node:http";

import { DEFAULT_WORKSPACE_ID, DeviceBrokerError, DeviceFabricError, readOwnedDeviceTaskJournal, readOwnedDeviceTaskTrace } from "@ling-stack/core";
import { HttpError } from "../../errors.js";
import { allowLocalServiceRequest } from "../../shared/local-workspace-access.js";
import { readJsonBody, readOptionalJsonBody } from "../../shared/request.js";
import { writePrivateJson } from "../../shared/response.js";
import { isRecord } from "../../shared/validation.js";
import type { DeviceDiagnosisRequest } from "./diagnosis-planner.js";
import { handleDeviceProtocolRoute } from "./protocol-routes.js";
import { handleDeviceResourceRoute } from "./resource-routes.js";
import type { DeviceSupportRuntime } from "./runtime.js";

export async function handleDeviceSupportRoute(
  url: URL,
  request: IncomingMessage,
  response: ServerResponse,
  runtime: DeviceSupportRuntime,
): Promise<boolean> {
  if (url.pathname.startsWith("/v1/device-support/resources")) return await handleDeviceResourceRoute(url, request, response, runtime);
  if (url.pathname.startsWith("/v1/device-support/protocol/")) return await handleDeviceProtocolRoute(url, request, response, runtime);
  const taskPath = /^\/v1\/device-support\/tasks\/([^/]+)\/(events|trace)$/u.exec(url.pathname);
  const linuxAction = /^\/v1\/device-support\/linux\/(targets|enroll|diagnose)$/u.exec(url.pathname)?.[1];
  const fleetHealth = url.pathname === "/v1/device-support/fleet/health";
  if (url.pathname !== "/v1/device-support/pc/diagnose" && !taskPath && !linuxAction && !fleetHealth) return false;
  if (!allowLocalServiceRequest(request, response)) return true;
  if (taskPath) {
    writeTaskProjection(url, taskPath[1]!, taskPath[2] === "trace", request, response, runtime);
    return true;
  }
  if (linuxAction) {
    await handleLinuxSshRequest(linuxAction, request, response, runtime);
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

async function handleLinuxSshRequest(
  action: string, request: IncomingMessage, response: ServerResponse, runtime: DeviceSupportRuntime,
): Promise<void> {
  const method = action === "targets" ? "GET" : "POST";
  if (request.method !== method) {
    response.setHeader("Allow", method);
    writePrivateJson(response, 405, { error: "method_not_allowed" });
    return;
  }
  try {
    if (action === "targets") {
      writePrivateJson(response, 200, { targets: runtime.listLinuxSshTargets() });
      return;
    }
    const body = await readJsonBody(request, 4096).catch(() => { throw new DeviceBrokerError("invalid_request", "Invalid Linux SSH request"); });
    const key = action === "enroll" ? "connectionId" : "deviceId";
    const id = isRecord(body) ? body[key] : undefined;
    if (!isRecord(body) || !validBoundedText(id, 256) || id.trim() !== id) {
      throw new DeviceBrokerError("invalid_request", "Linux SSH request requires a target reference");
    }
    if (action === "enroll") {
      if (Object.keys(body).length !== 1) throw new DeviceBrokerError("invalid_request", "invalid Linux SSH enrollment request");
      writePrivateJson(response, 200, { profile: await runtime.enrollLinuxSshTarget(id) });
      return;
    }
    const { deviceId: _deviceId, ...options } = body;
    const { status, report } = await runtime.diagnoseLinuxSshTarget(id, readDiagnosisOptions(options));
    writePrivateJson(response, 200, { status, report });
  } catch (error) {
    writeDeviceOperationError(response, error);
  }
}

function readDiagnosisOptions(value: unknown): DeviceDiagnosisRequest {
  if (value === undefined) return {};
  if (!isRecord(value) || Object.keys(value).some(key => key !== "providerPresetId" && key !== "symptom")) {
    throw new DeviceBrokerError("invalid_request", "invalid device diagnosis options");
  }
  const { providerPresetId, symptom } = value;
  if (providerPresetId !== undefined && (!validBoundedText(providerPresetId, 256) || providerPresetId.trim() !== providerPresetId)) {
    throw new DeviceBrokerError("invalid_request", "invalid diagnosis provider");
  }
  if (symptom !== undefined && (providerPresetId === undefined || !validBoundedText(symptom, 2048))) {
    throw new DeviceBrokerError("invalid_request", "invalid diagnosis symptom");
  }
  return { providerPresetId, symptom };
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
  const statuses = { invalid_request: 400, missing_target: 404, permission_denied: 403, target_changed: 409, target_busy: 409 };
  writePrivateJson(response, Object.hasOwn(statuses, code) ? statuses[code as keyof typeof statuses] : 503, { error: code });
}

function writeTaskProjection(
  url: URL, encodedTaskId: string, trace: boolean, request: IncomingMessage, response: ServerResponse, runtime: DeviceSupportRuntime,
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
    writePrivateJson(response, 200, trace ? readOwnedDeviceTaskTrace(scope) : readOwnedDeviceTaskJournal({
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

function optionalCursorNumber(url: URL, key: string): number | undefined {
  const value = url.searchParams.get(key);
  if (value === null) return undefined;
  if (!/^\d+$/u.test(value)) throw new DeviceBrokerError("invalid_request", "device journal cursor is invalid");
  return Number(value);
}
