import type { IncomingMessage, ServerResponse } from "node:http";
import {
  CHROME_BROWSER_PROTOCOL,
  parseChromeBrowserPairingRequest,
} from "@ling-stack/contracts";
import type { ResolvedDaemonConfig } from "../../config.js";
import { isDirectLoopbackRequest } from "../../shared/local-workspace-access.js";
import { readJsonBody } from "../../shared/request.js";
import { writePrivateJson } from "../../shared/response.js";
import {
  ChromeBrowserSessionError,
  chromeExtensionIdFromOrigin,
  type ChromeBrowserSessionController,
} from "./session-controller.js";

export async function handleChromeBrowserPair(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  controller: ChromeBrowserSessionController,
): Promise<void> {
  const origin = request.headers.origin;
  const extensionId = chromeExtensionIdFromOrigin(origin);
  if (!origin || !extensionId || !controller.isAllowedExtensionId(extensionId) || !isDirectLoopbackRequest(request)) {
    writePrivateJson(response, 403, { error: "chrome_browser_extension_forbidden", message: "Trusted Chrome extension and direct loopback access required." });
    return;
  }
  response.setHeader("Access-Control-Allow-Origin", origin);
  response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Vary", "Origin");
  if (request.method === "OPTIONS") {
    response.statusCode = 204;
    response.end();
    return;
  }
  if (request.method !== "POST") {
    writePairJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported.` });
    return;
  }
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writePairJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }
  try {
    const body = await readJsonBody(request, config.maxBodyBytes);
    const input = parseChromeBrowserPairingRequest(body);
    const paired = controller.pair(cwd, extensionId, input);
    writePairJson(response, 200, {
      protocol: CHROME_BROWSER_PROTOCOL,
      credential: paired.credential,
      workspaceCwd: paired.workspaceCwd,
    });
  } catch (error) {
    writePairJson(response, error instanceof ChromeBrowserSessionError ? 403 : 400, {
      error: error instanceof ChromeBrowserSessionError ? error.code : "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function writePairJson(response: ServerResponse, statusCode: number, body: object): void {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(body)}\n`);
}
