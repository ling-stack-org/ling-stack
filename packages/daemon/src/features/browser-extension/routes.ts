import type { IncomingMessage, ServerResponse } from "node:http";
import {
  CHROME_BROWSER_PROTOCOL,
  parseChromeBrowserPairingRequest,
} from "@ling-stack/contracts";
import type { ResolvedDaemonConfig } from "../../config.js";
import { readJsonBody } from "../../shared/request.js";
import { writeJson } from "../../shared/response.js";
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
  if (!extensionId || !isLoopbackAddress(request.socket.remoteAddress)) {
    writeJson(response, 403, { error: "chrome_browser_extension_forbidden", message: "Trusted Chrome extension required." });
    return;
  }
  response.setHeader("Access-Control-Allow-Origin", origin!);
  response.setHeader("Vary", "Origin");
  if (request.method === "OPTIONS") {
    response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type");
    response.statusCode = 204;
    response.end();
    return;
  }
  if (request.method !== "POST") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported.` });
    return;
  }
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  if (!isLoopbackHostname(url.hostname)) {
    writeJson(response, 403, { error: "chrome_browser_extension_forbidden", message: "Loopback Chrome pairing required." });
    return;
  }
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }
  try {
    const body = await readJsonBody(request, config.maxBodyBytes);
    const input = parseChromeBrowserPairingRequest(body);
    const paired = controller.pair(cwd, extensionId, input);
    writeJson(response, 200, {
      protocol: CHROME_BROWSER_PROTOCOL,
      credential: paired.credential,
      workspaceCwd: paired.workspaceCwd,
    });
  } catch (error) {
    writeJson(response, error instanceof ChromeBrowserSessionError ? 403 : 400, {
      error: error instanceof ChromeBrowserSessionError ? error.code : "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
}

function isLoopbackAddress(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}
