import type { IncomingMessage, ServerResponse } from "node:http";
import type { DaemonContext } from "../../../context.js";
import { readJsonBody } from "../../../shared/request.js";
import { desktopBridgeTokenStatus } from "../../computer-use/desktop-bridge-auth.js";
import { HUMAN_EVALUATION_DESKTOP_ROOT, HUMAN_EVALUATION_MAX_BODY_BYTES,
  HUMAN_EVALUATION_ROOT } from "./human-evaluation-protocol.js";

/**
 * Runs before generic CORS/OPTIONS and Mobile/RPC routing. No equivalent public
 * HTTP, Renderer, MCP, Agent or Mobile ingress is registered for human facts.
 */
export async function handleHumanEvaluationDesktopRoute(
  request: IncomingMessage, response: ServerResponse, context: DaemonContext,
): Promise<boolean> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (url.pathname !== HUMAN_EVALUATION_ROOT && !url.pathname.startsWith(`${HUMAN_EVALUATION_ROOT}/`)) return false;
  response.removeHeader("Access-Control-Allow-Origin");
  response.removeHeader("Access-Control-Allow-Methods");
  response.removeHeader("Access-Control-Allow-Headers");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Referrer-Policy", "no-referrer");
  const token = desktopBridgeTokenStatus(request, context.desktopBridgeToken);
  if (token !== "accepted") return reply(response, token === "unavailable" ? 503 : 403,
    { accepted: false, reason: token === "unavailable" ? "desktop_bridge_unavailable" : "desktop_bridge_forbidden" });
  // Node's Main fetch itself adds sec-fetch-mode:cors; that header is not an
  // Origin. Browser Origin/site metadata still fails closed even with a token.
  if (!isLoopback(request.socket.remoteAddress) || request.headers.origin !== undefined
    || request.headers["sec-fetch-site"] !== undefined) {
    return reply(response, 403, { accepted: false, reason: "evaluation_human_transport_forbidden" });
  }
  if (!url.pathname.startsWith(`${HUMAN_EVALUATION_DESKTOP_ROOT}/`) || url.search) {
    return reply(response, 404, { accepted: false, reason: "not_found" });
  }
  if (request.method !== "POST") return reply(response, 405, { accepted: false, reason: "method_not_allowed" });
  const service = context.humanEvaluations;
  if (!service) return reply(response, 503, { accepted: false, reason: "evaluation_human_unavailable" });
  try {
    const body = await readJsonBody(request, Math.min(context.config.maxBodyBytes, HUMAN_EVALUATION_MAX_BODY_BYTES));
    if (request.aborted || response.destroyed) return true;
    const action = url.pathname.slice(`${HUMAN_EVALUATION_DESKTOP_ROOT}/`.length);
    if (action === "handshake") return reply(response, 200, { accepted: true, ...service.handshake(body) });
    const result = action === "intent" ? service.createIntent(body)
      : action === "commit" ? service.commit(body)
      : action === "snapshot" ? service.snapshot(body)
      : action === "revoke-authority" ? service.revokeAuthority(body) : undefined;
    return result ? reply(response, result.accepted ? 200 : 409, result)
      : reply(response, 404, { accepted: false, reason: "not_found" });
  } catch {
    // Do not echo SQLite paths, helper/native information, request payloads or signing material.
    return reply(response, 400, { accepted: false, reason: "evaluation_human_request_rejected" });
  }
}

function isLoopback(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}
function reply(response: ServerResponse, status: number, body: unknown): true {
  // The ordinary shared writer unconditionally reinstalls public CORS. This
  // private ingress must own its writer, including all rejection paths.
  if (!response.destroyed && !response.writableEnded) {
    response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    response.end(`${JSON.stringify(body)}\n`);
  }
  return true;
}
