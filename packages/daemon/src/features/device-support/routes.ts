import type { IncomingMessage, ServerResponse } from "node:http";

import { DeviceBrokerError } from "@ling-stack/core";
import { writePrivateJson } from "../../shared/response.js";
import type { DeviceSupportRuntime } from "./runtime.js";

export async function handleDeviceSupportRoute(
  pathname: string,
  request: IncomingMessage,
  response: ServerResponse,
  runtime: DeviceSupportRuntime,
): Promise<boolean> {
  if (pathname !== "/v1/device-support/pc/diagnose") return false;
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
