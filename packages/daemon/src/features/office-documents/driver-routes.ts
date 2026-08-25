import type { IncomingMessage, ServerResponse } from "node:http";
import { OFFICE_DRIVER_MAX_FRAME_BYTES } from "@ling-stack/contracts";
import type { DaemonContext } from "../../context.js";
import { desktopBridgeTokenStatus } from "../computer-use/desktop-bridge-auth.js";
import { readJsonBody } from "../../shared/request.js";
import { writeJson } from "../../shared/response.js";

const ROOT = "/desktop/capabilities/office";

export async function handleOfficeDriverRoute(
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
        ? "Office driver routes require Ling Desktop."
        : "Desktop bridge authentication failed.",
    });
    return true;
  }
  if (request.method !== "POST") {
    writeJson(response, 405, { error: "method_not_allowed", message: "Office driver routes support POST only." });
    return true;
  }
  try {
    if (url.pathname === `${ROOT}/availability`) {
      const availability = context.officeDriverController.publishAvailability(
        await readJsonBody(request, Math.min(context.config.maxBodyBytes, OFFICE_DRIVER_MAX_FRAME_BYTES)),
      );
      context.officeDocumentsPlugin.handleDriverStateChange(context.config.defaultWorkspaceCwd);
      writeJson(response, 200, { accepted: true, generation: availability.generation });
      return true;
    }
    const authority = {
      desktopInstanceId: readRequiredHeader(request, "x-ling-office-desktop-instance"),
      generation: readPositiveHeader(request, "x-ling-office-generation"),
    };
    if (url.pathname === `${ROOT}/commands/claim`) {
      const abortController = new AbortController();
      const abort = () => abortController.abort();
      request.once("aborted", abort);
      response.once("close", abort);
      let command;
      try {
        command = await context.officeDriverController.claim(authority, abortController.signal);
      } finally {
        request.off("aborted", abort);
        response.off("close", abort);
      }
      writeJson(response, 200, command ? { command } : {});
      return true;
    }
    const match = new RegExp(`^${ROOT}/commands/([^/]+)/result$`, "u").exec(url.pathname);
    if (match?.[1]) {
      const body = await readJsonBody(request, Math.min(context.config.maxBodyBytes, OFFICE_DRIVER_MAX_FRAME_BYTES));
      if (!body || typeof body !== "object" || Array.isArray(body) || (body as { id?: unknown }).id !== decodeURIComponent(match[1])) {
        throw new Error("office_driver_result_id_mismatch");
      }
      context.officeDriverController.complete(authority, body);
      writeJson(response, 200, { accepted: true });
      return true;
    }
    writeJson(response, 404, { error: "not_found", message: "Office driver route was not found." });
    return true;
  } catch (error) {
    if (response.destroyed || response.writableEnded) return true;
    writeJson(response, 400, {
      error: error instanceof Error ? error.message : "office_driver_request_failed",
      message: "Office driver request was rejected.",
    });
    return true;
  }
}

function readRequiredHeader(request: IncomingMessage, name: string): string {
  const value = request.headers[name];
  const text = Array.isArray(value) ? value[0] : value;
  if (!text?.trim() || text.length > 128) throw new Error("office_driver_authority_invalid");
  return text;
}

function readPositiveHeader(request: IncomingMessage, name: string): number {
  const text = readRequiredHeader(request, name);
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("office_driver_authority_invalid");
  return value;
}
