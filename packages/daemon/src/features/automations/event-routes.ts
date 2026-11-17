import type { IncomingMessage, ServerResponse } from "node:http";
import { parseAutomationEventSource } from "@ling-stack/core";
import type { DaemonContext } from "../../context.js";
import { HttpError } from "../../errors.js";
import { allowLocalServiceRequest } from "../../shared/local-workspace-access.js";
import { readJsonBody, readRequestBody } from "../../shared/request.js";
import { writeJson } from "../../shared/response.js";
import { authenticateAutomationEvent } from "./event-ingress.js";

export const isAutomationEventIngress = (pathname: string, method?: string): boolean =>
  method === "POST" && /^\/automation-event-sources\/[a-zA-Z0-9_.:-]{1,160}\/events$/.test(pathname);

export async function handleAutomationEventRoute(request: IncomingMessage, response: ServerResponse, url: URL, context: DaemonContext): Promise<boolean> {
  const sourceRoute = /^\/automation-event-sources(?:\/([a-zA-Z0-9_.:-]{1,160})(?:\/(events))?)?$/.exec(url.pathname);
  const deliveryRoute = /^\/automation-deliveries(?:\/([a-zA-Z0-9_.:-]{1,160})\/reconcile)?$/.exec(url.pathname);
  if (!sourceRoute && !deliveryRoute && url.pathname !== "/automation-events") return false;
  const ingress = isAutomationEventIngress(url.pathname, request.method);
  if (!ingress && !allowLocalServiceRequest(request, response)) return true;
  try {
    const cwd = url.searchParams.get("cwd");
    if (!cwd) throw new HttpError(400, "cwd_required", "cwd is required.");
    const store = context.storeRegistry.getInitializedStore(cwd);
    if (!store) throw new HttpError(404, "workspace_not_loaded", "Open this workspace before configuring event sources.");
    if (ingress) {
      const source = context.storeRegistry.isTrustedWorkspaceRoot(cwd) && store.getAutomationEventSource(sourceRoute![1]);
      if (!source) throw new HttpError(404, "automation_event_source_not_found", "Event source not found.");
      let body: Buffer;
      try { body = await readRequestBody(request, 64 * 1024); }
      catch { throw new HttpError(413, "automation_event_body_limit", "Event body exceeds its limit."); }
      const now = new Date().toISOString();
      const envelope = authenticateAutomationEvent({ source, headers: request.headers, body, secretResolver: context.secretResolver, now });
      const accepted = store.acceptAutomationEvent(envelope, source.revision, now);
      context.automationEvents.start(cwd); context.automationEvents.poke(cwd);
      writeJson(response, accepted.duplicate ? 200 : 202, { eventId: accepted.event.id, duplicate: accepted.duplicate });
    } else if (sourceRoute && !sourceRoute[2]) {
      if (request.method === "GET") {
        writeJson(response, 200, sourceRoute[1] ? { source: store.getAutomationEventSource(sourceRoute[1]) ?? null }
          : { sources: store.listAutomationEventSources(), worker: context.automationEvents.status(cwd) });
      } else if ((request.method === "POST" && !sourceRoute[1]) || (request.method === "PUT" && sourceRoute[1])) {
        const body = await readJsonBody(request, 64 * 1024) as { source?: unknown; expectedRevision?: number };
        const source = parseAutomationEventSource(body.source);
        if (sourceRoute[1] && (source.id !== sourceRoute[1] || !Number.isSafeInteger(body.expectedRevision))) throw new Error("automation_event_source_revision_required");
        if (request.method === "POST" && store.getAutomationEventSource(source.id)) throw new Error("automation_event_source_revision_conflict");
        await context.imDestinations.ensureLoaded();
        for (const rule of source.rules) for (const id of rule.destinationIds ?? []) {
          if (!context.imDestinations.list().some(destination => destination.id === id && destination.enabled)) throw new Error("automation_delivery_destination_unavailable");
        }
        const saved = store.putAutomationEventSource(source, body.expectedRevision, new Date().toISOString());
        context.automationEvents.start(cwd);
        writeJson(response, request.method === "POST" ? 201 : 200, { source: saved });
      } else writeJson(response, 405, { error: "method_not_allowed" });
    } else if (deliveryRoute) {
      if (request.method === "GET" && !deliveryRoute[1]) writeJson(response, 200, { deliveries: store.listAutomationDeliveries() });
      else if (request.method === "POST" && deliveryRoute[1]) {
        const body = await readJsonBody(request, 4096) as Record<string, unknown>;
        if (!body || !["delivered", "retry", "failed"].includes(String(body.decision)) || typeof body.reason !== "string"
          || typeof body.expectedUpdatedAt !== "string") throw new Error("automation_delivery_reconciliation_invalid");
        const delivery = store.reconcileAutomationDelivery(deliveryRoute[1], body.expectedUpdatedAt,
          body.decision as "delivered" | "retry" | "failed", body.reason, new Date().toISOString());
        context.automationEvents.start(cwd); context.automationEvents.poke(cwd); writeJson(response, 200, { delivery });
      } else writeJson(response, 405, { error: "method_not_allowed" });
    } else if (url.pathname === "/automation-events" && request.method === "GET") {
      writeJson(response, 200, { events: store.listAutomationEvents(), dispatches: store.listAutomationEventDispatches() });
    } else writeJson(response, 405, { error: "method_not_allowed" });
  } catch (error) {
    const code = error instanceof HttpError ? error.code : error instanceof Error && /^automation_[a-z_]+$/.test(error.message)
      ? error.message : "automation_event_request_invalid";
    const status = error instanceof HttpError ? error.statusCode : /rate_limit|capacity/.test(code) ? 429 : /conflict|revoked/.test(code) ? 409 : 400;
    writeJson(response, status, { error: code, message: error instanceof HttpError ? error.message : code });
  }
  return true;
}
