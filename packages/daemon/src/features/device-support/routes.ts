import type { IncomingMessage, ServerResponse } from "node:http";

import { DEFAULT_WORKSPACE_ID, DeviceBrokerError, readOwnedDeviceTaskJournal } from "@ling-stack/core";
import { allowLocalServiceRequest } from "../../shared/local-workspace-access.js";
import { readJsonBody } from "../../shared/request.js";
import { writePrivateJson } from "../../shared/response.js";
import { handleDeviceResourceRoute } from "./resource-routes.js";
import type { DeviceSupportRuntime } from "./runtime.js";

export async function handleDeviceSupportRoute(
  url: URL,
  request: IncomingMessage,
  response: ServerResponse,
  runtime: DeviceSupportRuntime,
): Promise<boolean> {
  if (url.pathname.startsWith("/v1/device-support/resources")) return await handleDeviceResourceRoute(url, request, response, runtime);
  const eventsPath = /^\/v1\/device-support\/tasks\/([^/]+)\/events$/u.exec(url.pathname);
  const linuxAction = /^\/v1\/device-support\/linux\/(targets|enroll|diagnose)$/u.exec(url.pathname)?.[1];
  if (url.pathname !== "/v1/device-support/pc/diagnose" && !eventsPath && !linuxAction) return false;
  if (!allowLocalServiceRequest(request, response)) return true;
  if (eventsPath) {
    writeTaskEvents(url, eventsPath[1]!, request, response, runtime);
    return true;
  }
  if (linuxAction) {
    await handleLinuxSshRequest(linuxAction, request, response, runtime);
    return true;
  }
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    writePrivateJson(response, 405, { error: "method_not_allowed" });
    return true;
  }
  try {
    const { status, report } = await runtime.diagnoseLocalPc();
    writePrivateJson(response, 200, { status, report });
  } catch (error) {
    const code = error instanceof DeviceBrokerError ? error.code : "service_unavailable";
    writePrivateJson(response, code === "target_busy" ? 409 : 503, { error: code });
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
    const id = body !== null && typeof body === "object" && !Array.isArray(body) && Object.keys(body).length === 1
      ? (body as Record<string, unknown>)[key] : undefined;
    if (typeof id !== "string" || id.trim().length === 0 || Buffer.byteLength(id, "utf8") > 256) {
      throw new DeviceBrokerError("invalid_request", "Linux SSH request requires a target reference");
    }
    if (action === "enroll") {
      writePrivateJson(response, 200, { profile: await runtime.enrollLinuxSshTarget(id) });
      return;
    }
    const { status, report } = await runtime.diagnoseLinuxSshTarget(id);
    writePrivateJson(response, 200, { status, report });
  } catch (error) {
    const code = error instanceof DeviceBrokerError ? error.code : "service_unavailable";
    const statuses = { invalid_request: 400, missing_target: 404, permission_denied: 403, target_changed: 409, target_busy: 409 };
    writePrivateJson(response, Object.hasOwn(statuses, code) ? statuses[code as keyof typeof statuses] : 503, { error: code });
  }
}

function writeTaskEvents(
  url: URL, encodedTaskId: string, request: IncomingMessage, response: ServerResponse, runtime: DeviceSupportRuntime,
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
    const page = readOwnedDeviceTaskJournal({
      store: runtime.store, workspaceId: DEFAULT_WORKSPACE_ID, taskId,
      afterSequence: optionalCursorNumber(url, "afterSequence"),
      generation: optionalCursorNumber(url, "generation"),
      limit: optionalCursorNumber(url, "limit"),
    });
    writePrivateJson(response, 200, page);
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
