import type { IncomingMessage, ServerResponse } from "node:http";
import { DEFAULT_WORKSPACE_ID } from "@ling-stack/core";
import type { DaemonContext } from "../../context.js";
import { setCorsHeaders, writeJson } from "../../shared/response.js";
import {
  ControlPlaneBadDomainError,
  ControlPlaneBadRequestError,
  buildControlPlaneSnapshot,
  latestControlPlaneEventSeq,
  listControlPlaneEventsForResponse,
  parseControlPlaneDomains,
  readControlPlaneAfterSeq,
  readControlPlaneLimit,
} from "./processors.js";

export async function handleControlPlaneRoute(
  request: IncomingMessage,
  response: ServerResponse,
  context: DaemonContext,
): Promise<boolean> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${context.config.host}:${context.config.port}`}`);
  if (!url.pathname.startsWith("/control-plane/")) {
    return false;
  }

  try {
    if (url.pathname === "/control-plane/snapshot") {
      if (request.method !== "GET") {
        writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for /control-plane/snapshot` });
        return true;
      }
      const cwd = readCwd(url);
      const domains = parseControlPlaneDomains(url.searchParams.get("domains"));
      writeJson(response, 200, buildControlPlaneSnapshot(context, { cwd, domains }));
      return true;
    }

    if (url.pathname === "/control-plane/events") {
      if (request.method !== "GET") {
        writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for /control-plane/events` });
        return true;
      }
      const cwd = readCwd(url);
      const domains = parseControlPlaneDomains(url.searchParams.get("domains"));
      const afterSeq = readControlPlaneAfterSeq(url);
      const limit = readControlPlaneLimit(url);
      writeJson(response, 200, listControlPlaneEventsForResponse(context, { cwd, domains, afterSeq, limit }));
      return true;
    }

    if (url.pathname === "/control-plane/stream") {
      if (request.method !== "GET") {
        writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for /control-plane/stream` });
        return true;
      }
      const cwd = readCwd(url);
      const domains = parseControlPlaneDomains(url.searchParams.get("domains"));
      const afterSeq = readControlPlaneAfterSeq(url);
      writeControlPlaneSseHead(response);
      const cleanup = (): void => {
        request.off("aborted", closeSubscription);
        request.off("close", closeSubscription);
        response.off("close", closeSubscription);
      };
      let close = (): void => {};
      let closeRequested = false;
      const closeSubscription = (): void => { closeRequested = true; cleanup(); close(); };
      request.on("aborted", closeSubscription);
      request.on("close", closeSubscription);
      response.on("close", closeSubscription);
      const subscription = context.controlPlaneEvents.subscribe({
        workspaceId: DEFAULT_WORKSPACE_ID,
        cwd,
        domains,
        response,
        initialComment: "ling-stack control-plane stream",
        writerOptions: { onClose: cleanup },
        latestEventSeq: () => latestControlPlaneEventSeq(context, cwd),
        replayWindow: () => listControlPlaneEventsForResponse(context, {
          cwd,
          domains,
          afterSeq,
          limit: 1_000,
        }),
      });
      close = () => subscription.close();
      if (closeRequested) subscription.close();
      return true;
    }

    writeJson(response, 404, { error: "not_found", message: `No route for ${request.method} ${url.pathname}` });
    return true;
  } catch (error) {
    if (response.headersSent) {
      response.destroy();
      return true;
    }
    if (error instanceof ControlPlaneBadDomainError) {
      writeJson(response, 400, { error: "bad_domain", message: error.message });
      return true;
    }
    if (error instanceof ControlPlaneBadRequestError) {
      writeJson(response, 400, { error: "bad_request", message: error.message });
      return true;
    }
    writeJson(response, 400, {
      error: "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
    return true;
  }
}

function readCwd(url: URL): string {
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    throw new ControlPlaneBadRequestError("cwd query parameter is required");
  }
  return cwd;
}

function writeControlPlaneSseHead(response: ServerResponse): void {
  setCorsHeaders(response);
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
}
