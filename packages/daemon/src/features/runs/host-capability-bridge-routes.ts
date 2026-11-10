import type { IncomingMessage, ServerResponse } from "node:http";
import { HOST_CAPABILITY_BRIDGE_MAX_FRAME_BYTES } from "@ling-stack/contracts";
import type { DaemonContext } from "../../context.js";
import { readJsonBody } from "../../shared/request.js";
import { writeJson } from "../../shared/response.js";
import { desktopBridgeTokenStatus } from "../computer-use/desktop-bridge-auth.js";

const ROOT = "/desktop/capabilities/host";

export async function handleHostCapabilityBridgeRoute(
  request: IncomingMessage,
  response: ServerResponse,
  context: DaemonContext,
): Promise<boolean> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${context.config.host}:${context.config.port}`}`);
  if (!url.pathname.startsWith(`${ROOT}/`)) return false;
  const token = desktopBridgeTokenStatus(request, context.desktopBridgeToken);
  if (token !== "accepted") {
    writeJson(response, token === "unavailable" ? 503 : 403, {
      error: token === "unavailable" ? "desktop_bridge_unavailable" : "desktop_bridge_forbidden",
      message: token === "unavailable"
        ? "Host capability bridge routes require Ling Desktop."
        : "Desktop bridge authentication failed.",
    });
    return true;
  }
  if (request.method !== "POST") {
    writeJson(response, 405, { error: "method_not_allowed", message: "Host capability bridge routes support POST only." });
    return true;
  }
  try {
    if (url.pathname === `${ROOT}/availability`) {
      const availability = context.hostCapabilityBridge.publishAvailability(
        await readJsonBody(request, Math.min(context.config.maxBodyBytes, HOST_CAPABILITY_BRIDGE_MAX_FRAME_BYTES)),
      );
      writeJson(response, 200, { accepted: true, generation: availability.generation });
      return true;
    }
    const authority = {
      desktopInstanceId: readRequiredHeader(request, "x-ling-host-desktop-instance"),
      generation: readPositiveHeader(request, "x-ling-host-generation"),
    };
    if (url.pathname === `${ROOT}/commands/claim`) {
      const abortController = new AbortController();
      const abort = () => abortController.abort();
      request.once("aborted", abort);
      response.once("close", abort);
      let command;
      try {
        command = await context.hostCapabilityBridge.claim(authority, abortController.signal);
      } finally {
        request.off("aborted", abort);
        response.off("close", abort);
      }
      writeJson(response, 200, command ? { command } : {});
      return true;
    }
    const begin = new RegExp(`^${ROOT}/commands/([^/]+)/begin$`, "u").exec(url.pathname);
    if (begin?.[1]) {
      context.hostCapabilityBridge.begin(authority, decodeURIComponent(begin[1]));
      writeJson(response, 200, { accepted: true });
      return true;
    }
    const result = new RegExp(`^${ROOT}/commands/([^/]+)/result$`, "u").exec(url.pathname);
    if (result?.[1]) {
      const body = await readJsonBody(request, Math.min(context.config.maxBodyBytes, HOST_CAPABILITY_BRIDGE_MAX_FRAME_BYTES));
      if (!body || typeof body !== "object" || Array.isArray(body)
        || (body as { id?: unknown }).id !== decodeURIComponent(result[1])) throw new Error("host_capability_result_id_mismatch");
      context.hostCapabilityBridge.complete(authority, body);
      writeJson(response, 200, { accepted: true });
      return true;
    }
    writeJson(response, 404, { error: "not_found", message: "Host capability bridge route was not found." });
    return true;
  } catch (error) {
    if (response.destroyed || response.writableEnded) return true;
    writeJson(response, 400, {
      error: safeErrorCode(error),
      message: "Host capability bridge request was rejected.",
    });
    return true;
  }
}

function readRequiredHeader(request: IncomingMessage, name: string): string {
  const value = request.headers[name];
  const text = Array.isArray(value) ? value[0] : value;
  if (!text?.trim() || text.length > 128) throw new Error("host_capability_authority_invalid");
  return text;
}

function readPositiveHeader(request: IncomingMessage, name: string): number {
  const value = Number(readRequiredHeader(request, name));
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("host_capability_authority_invalid");
  return value;
}

function safeErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return /^[a-z0-9_:-]{1,96}$/iu.test(message) ? message : "host_capability_bridge_failed";
}
