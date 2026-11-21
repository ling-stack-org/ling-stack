import type { IncomingMessage, ServerResponse } from "node:http";

import { DEFAULT_WORKSPACE_ID, DeviceBrokerError, readOwnedDeviceTaskJournal } from "@ling-stack/core";
import { allowLocalServiceRequest } from "../../shared/local-workspace-access.js";
import { writePrivateJson } from "../../shared/response.js";
import type { DeviceSupportRuntime } from "./runtime.js";

export async function handleDeviceSupportRoute(
  url: URL,
  request: IncomingMessage,
  response: ServerResponse,
  runtime: DeviceSupportRuntime,
): Promise<boolean> {
  const eventsPath = /^\/v1\/device-support\/tasks\/([^/]+)\/events$/u.exec(url.pathname);
  if (url.pathname !== "/v1/device-support/pc/diagnose" && !eventsPath) return false;
  if (!allowLocalServiceRequest(request, response)) return true;
  if (eventsPath) {
    writeTaskEvents(url, eventsPath[1]!, request, response, runtime);
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
