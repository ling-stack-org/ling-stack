import type { IncomingMessage, ServerResponse } from "node:http";
import { browserInteger, browserString, DESKTOP_BROWSER_MAX_RESULT_BYTES } from "@ling-stack/contracts";
import type { DaemonContext } from "../../context.js";
import { desktopBridgeTokenStatus } from "../computer-use/desktop-bridge-auth.js";
import { readJsonBody } from "../../shared/request.js";
import { writeJson } from "../../shared/response.js";

const ROOT = "/desktop/capabilities/browser";

export async function handleDesktopBrowserRoute(request: IncomingMessage, response: ServerResponse, context: DaemonContext): Promise<boolean> {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (!url.pathname.startsWith(`${ROOT}/`)) return false;
  const auth = desktopBridgeTokenStatus(request, context.desktopBridgeToken);
  if (auth !== "accepted" || request.headers.origin !== undefined) {
    writeJson(response, auth === "unavailable" ? 503 : 403, { error: "browser_bridge_forbidden" }); return true;
  }
  if (request.method !== "POST") { writeJson(response, 405, { error: "method_not_allowed" }); return true; }
  const controller = context.desktopBrowser;
  try {
    if (url.pathname === `${ROOT}/availability`) {
      controller.publish(await readJsonBody(request, Math.min(context.config.maxBodyBytes, 128 * 1024)));
      context.desktopBrowserPlugin.sync(context.config.defaultWorkspaceCwd);
      writeJson(response, 200, { accepted: true, runtimeId: controller.runtimeId }); return true;
    }
    const authority = { desktopInstanceId: browserString(request.headers["x-ling-browser-instance"], 128),
      generation: browserInteger(Number(request.headers["x-ling-browser-generation"]), 1) };
    const abort = new AbortController(), onClose = (): void => abort.abort();
    request.once("aborted", onClose); response.once("close", onClose);
    try {
      if (url.pathname === `${ROOT}/commands/claim`) {
        const command = await controller.claim(authority, abort.signal);
        if (!response.destroyed) writeJson(response, 200, command ? { command } : {});
        return true;
      }
      const match = new RegExp(`^${ROOT}/commands/([a-zA-Z0-9-]{1,128})/(start|cancelled|result)$`, "u").exec(url.pathname);
      if (match) {
        const [, id, action] = match;
        if (action === "start") { controller.start(authority, id!); writeJson(response, 200, { accepted: true }); }
        else if (action === "cancelled") {
          const cancelled = await controller.waitForCancellation(authority, id!, abort.signal);
          if (!response.destroyed) writeJson(response, 200, { cancelled });
        } else {
          const body = await readJsonBody(request, Math.min(context.config.maxBodyBytes, DESKTOP_BROWSER_MAX_RESULT_BYTES));
          if (!body || typeof body !== "object" || (body as { id?: unknown }).id !== id) throw new Error("browser_result_id_mismatch");
          controller.complete(authority, body); writeJson(response, 200, { accepted: true });
        }
        return true;
      }
    } finally { request.off("aborted", onClose); response.off("close", onClose); }
    writeJson(response, 404, { error: "not_found" });
  } catch (error) {
    if (!response.destroyed && !response.writableEnded) writeJson(response, 409, { error: error instanceof Error ? error.message : "browser_request_failed" });
  }
  return true;
}
