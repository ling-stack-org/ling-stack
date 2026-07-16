import { randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  ComputerUsePreviewProjection,
  StopComputerUseRequest,
  StopComputerUseResponse,
} from "@ling-stack/contracts";
import {
  COMPUTER_USE_ROUTE_TOKEN_HEADER,
  isTerminalComputerUseStatus,
} from "@ling-stack/contracts";
import type { DaemonContext } from "../../context.js";
import { ensureRunCancelled } from "../runs/cancellation.js";
import { isAllowedLocalOrigin } from "../../shared/local-workspace-access.js";
import { readOptionalJsonBody } from "../../shared/request.js";
import { writeJson, writeSse, writeSseHead } from "../../shared/response.js";

const STOP_ACK_TIMEOUT_MS = 10_000;

export async function handleComputerUseRoute(
  request: IncomingMessage,
  response: ServerResponse,
  context: DaemonContext,
): Promise<boolean> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${context.config.host}:${context.config.port}`}`);
  if (!url.pathname.startsWith("/computer-use/")) {
    return false;
  }

  try {
    if (!isAllowedLocalOrigin(request.headers.origin)) {
      writePrivateJson(response, 403, {
        error: "forbidden_origin",
        message: "Computer Use routes are only available from local Ling Stack pages.",
      });
      return true;
    }

    if (url.pathname === "/computer-use/desktop-bridge/handshake") {
      if (request.method !== "GET") {
        writePrivateJson(response, 405, {
          error: "method_not_allowed",
          message: "Desktop bridge handshake supports GET only.",
        });
        return true;
      }
      const tokenStatus = desktopBridgeTokenStatus(request, context);
      if (tokenStatus === "unavailable") {
        writePrivateJson(response, 503, {
          error: "desktop_bridge_unavailable",
          message: "The daemon was not started with a Desktop bridge token.",
        });
        return true;
      }
      if (tokenStatus === "forbidden") {
        writePrivateJson(response, 403, {
          error: "desktop_bridge_forbidden",
          message: "Desktop bridge authentication failed.",
        });
        return true;
      }
      writePrivateJson(response, 200, {
        protocolVersion: 1,
        capabilities: ["preview-source"],
        bridgeTokenAccepted: true,
      });
      return true;
    }

    const sourceRoute = parseSourceRoute(url.pathname);
    if (!sourceRoute) {
      // Browser requests carry a local Origin and are protected by the local
      // origin/CSRF boundary above. Native fetches (Electron main, CLI, tests,
      // and other non-browser clients) generally have no Origin at all; those
      // requests must present the installation-scoped Computer Use route token.
      // Do not silently treat a missing token configuration as open access.
      const routeAuthorization = computerUseRouteAuthorization(request, context);
      if (routeAuthorization !== "accepted") {
        writePrivateJson(
          response,
          routeAuthorization === "unavailable" ? 503 : 403,
          routeAuthorization === "unavailable"
            ? {
                error: "computer_use_route_auth_unavailable",
                message: "The daemon was not started with a Computer Use route token.",
              }
            : {
                error: "computer_use_route_unauthorized",
                message: "Computer Use native requests require the scoped route token.",
              },
        );
        return true;
      }
    }

    if (url.pathname === "/computer-use/sessions") {
      if (request.method !== "GET") {
        writeJson(response, 405, { error: "method_not_allowed", message: "Computer Use sessions support GET only." });
        return true;
      }
      const cwd = readCwd(url);
      writeJson(response, 200, { cwd, projections: context.computerUsePreviews.list(cwd) });
      return true;
    }

    if (url.pathname === "/computer-use/snapshot") {
      if (request.method !== "GET") {
        writeJson(response, 405, { error: "method_not_allowed", message: "Computer Use snapshot supports GET only." });
        return true;
      }
      const cwd = readCwd(url);
      writeJson(response, 200, context.computerUsePreviews.snapshot(cwd));
      return true;
    }

    if (url.pathname === "/computer-use/events") {
      if (request.method !== "GET") {
        writeJson(response, 405, { error: "method_not_allowed", message: "Computer Use events support GET only." });
        return true;
      }
      const cwd = readCwd(url);
      writeJson(response, 200, context.computerUsePreviews.listEvents(cwd, readAfterSeq(url), readLimit(url)));
      return true;
    }

    if (url.pathname === "/computer-use/stream") {
      if (request.method !== "GET") {
        writeJson(response, 405, { error: "method_not_allowed", message: "Computer Use stream supports GET only." });
        return true;
      }
      const cwd = readCwd(url);
      const afterSeq = readAfterSeq(url);
      const replay = context.computerUsePreviews.subscribeFrom(cwd, afterSeq, (event) => {
        if (!response.writableEnded) {
          writeSse(response, "computer_use_event", event);
        }
      });
      const subscription = replay.subscription;
      try {
        writeSseHead(response);
        for (const event of replay.events) {
          writeSse(response, "computer_use_event", event);
        }
        writeSse(response, "heartbeat", {
          ts: new Date().toISOString(),
          latestSeq: replay.latestSeq,
        });
      } catch (error) {
        subscription.close();
        throw error;
      }
      const heartbeat = setInterval(() => {
        if (!response.writableEnded) {
          writeSse(response, "heartbeat", {
            ts: new Date().toISOString(),
            latestSeq: context.computerUsePreviews.listEvents(cwd).latestSeq,
          });
        }
      }, 15_000);
      const close = (): void => {
        clearInterval(heartbeat);
        subscription.close();
      };
      request.once("aborted", close);
      request.once("close", close);
      response.once("close", close);
      return true;
    }

    if (sourceRoute) {
      if (request.method !== "GET") {
        writeJson(response, 405, { error: "method_not_allowed", message: "Computer Use private source supports GET only." });
        return true;
      }
      handlePrivatePreviewSource(request, response, url, context, sourceRoute.sessionId);
      return true;
    }

    const stopRoute = parseStopRoute(url.pathname);
    if (stopRoute) {
      if (request.method !== "POST") {
        writeJson(response, 405, { error: "method_not_allowed", message: "Computer Use stop supports POST only." });
        return true;
      }
      await handleStopComputerUse(request, response, url, context, stopRoute.sessionId);
      return true;
    }

    writeJson(response, 404, { error: "not_found", message: `No Computer Use route for ${url.pathname}` });
    return true;
  } catch (error) {
    writeJson(response, 400, {
      error: "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
    return true;
  }
}

function handlePrivatePreviewSource(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  context: DaemonContext,
  sessionId: string,
): void {
  response.removeHeader("Access-Control-Allow-Origin");
  const tokenStatus = desktopBridgeTokenStatus(request, context);
  if (tokenStatus === "unavailable") {
    writePrivateJson(response, 503, { error: "desktop_bridge_unavailable", message: "The daemon was not started with a Desktop bridge token." });
    return;
  }
  if (tokenStatus === "forbidden") {
    writePrivateJson(response, 403, { error: "desktop_bridge_forbidden", message: "Desktop bridge authentication failed." });
    return;
  }
  const cwd = readCwd(url);
  const projection = context.computerUsePreviews.get(cwd, sessionId);
  if (!projection?.preview) {
    writePrivateJson(response, 404, { error: "computer_use_preview_not_found", message: "The Computer Use preview projection is unavailable." });
    return;
  }
  const resolvedDescriptor = context.computerUsePreviews.resolvePrivateDescriptor(
    cwd,
    projection.preview.descriptorId,
    projection.preview.revision,
  );
  const descriptor = resolvedDescriptor
    ? context.computerUsePreviews.renewPrivateDescriptor(
        cwd,
        resolvedDescriptor.descriptorId,
        resolvedDescriptor.revision,
      ) ?? resolvedDescriptor
    : undefined;
  if (!descriptor) {
    writePrivateJson(response, 404, { error: "computer_use_descriptor_not_found", message: "The authorized preview descriptor is unavailable or expired." });
    return;
  }
  writePrivateJson(response, 200, descriptor);
}

async function handleStopComputerUse(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  context: DaemonContext,
  sessionId: string,
): Promise<void> {
  const cwd = readCwd(url);
  const projection = context.computerUsePreviews.get(cwd, sessionId);
  if (!projection) {
    writeJson(response, 404, { error: "computer_use_session_not_found", message: `Computer Use session was not found: ${sessionId}` });
    return;
  }
  if (isTerminalComputerUseStatus(projection.status)) {
    writeJson(response, 409, { error: "computer_use_session_terminal", message: `Computer Use session is already ${projection.status}.` });
    return;
  }

  const body = readStopRequest(await readOptionalJsonBody(request, context.config.maxBodyBytes));
  const requestedAt = new Date().toISOString();
  const auditId = `computer_use_stop_${randomUUID()}`;
  const stopping = context.computerUsePreviews.upsert(cwd, {
    ...projection,
    status: "stopping",
    updatedAt: requestedAt,
  });
  const result = await requestRuntimeStop(context, cwd, stopping, body.reason);
  const acknowledgedAt = result.acknowledged ? new Date().toISOString() : undefined;
  const currentProjection = context.computerUsePreviews.get(cwd, sessionId);
  const finalProjection = result.acknowledged
    ? context.computerUsePreviews.upsert(cwd, {
        ...stopping,
        status: "cancelled",
        updatedAt: acknowledgedAt as string,
        terminalAt: acknowledgedAt,
      })
    : currentProjection?.status === "stopping"
      ? context.computerUsePreviews.upsert(cwd, {
          ...projection,
          updatedAt: nextIsoTimestampAfter(stopping.updatedAt),
        })
      : currentProjection ?? projection;
  context.computerUsePreviews.recordStopAudit({
    auditId,
    cwd,
    sessionId,
    requestedAt,
    reason: body.reason,
    accepted: result.accepted,
    acknowledged: result.acknowledged,
    acknowledgedAt,
    resultReason: result.reason,
  });
  const responseBody: StopComputerUseResponse & { readonly error?: string; readonly message?: string } = {
    sessionId,
    accepted: result.accepted,
    acknowledged: result.acknowledged,
    auditId,
    projection: finalProjection,
    reason: result.reason,
    acknowledgedAt,
    ...(!result.acknowledged
      ? {
          error: result.reason ?? "computer_use_stop_not_acknowledged",
          message: result.accepted
            ? "Computer Use runtime did not acknowledge Stop. The task may still be running; retry Stop."
            : "Computer Use Stop was rejected before runtime acknowledgement.",
        }
      : {}),
  };
  writeJson(response, result.acknowledged ? 200 : result.accepted ? 504 : 409, responseBody);
}

function nextIsoTimestampAfter(value: string): string {
  return new Date(Math.max(Date.now(), Date.parse(value) + 1)).toISOString();
}

async function requestRuntimeStop(
  context: DaemonContext,
  cwd: string,
  projection: ComputerUsePreviewProjection,
  reason: string | undefined,
): Promise<{ readonly accepted: boolean; readonly acknowledged: boolean; readonly reason?: string }> {
  if (context.computerUseStop) {
    return context.computerUseStop({ cwd, projection, reason });
  }
  if (!projection.runId) {
    return { accepted: false, acknowledged: false, reason: "computer_use_stop_handler_unavailable" };
  }
  const store = context.storeRegistry.findStoreForRun(projection.runId, cwd);
  const run = store?.getRun(projection.runId);
  if (!store || !run) {
    return { accepted: false, acknowledged: false, reason: "computer_use_run_not_found" };
  }
  if (run.status === "succeeded" || run.status === "failed" || run.status === "cancelled") {
    return { accepted: true, acknowledged: true, reason: `run_already_${run.status}` };
  }
  const activeRun = context.activeRuns.get(run.id);
  if (!activeRun?.completion) {
    return { accepted: false, acknowledged: false, reason: "computer_use_run_not_active" };
  }
  ensureRunCancelled({
    store,
    runId: run.id,
    taskId: run.taskId,
    startedAt: run.startedAt,
    reason: reason ?? "computer_use_stop_requested",
    active: true,
    streamEnvelope: activeRun.streamEnvelope,
  });
  activeRun.abortController.abort();
  if (!await waitForRuntimeCompletion(activeRun.completion, STOP_ACK_TIMEOUT_MS)) {
    return { accepted: true, acknowledged: false, reason: "computer_use_stop_ack_timeout" };
  }
  const terminalRun = store.getRun(run.id);
  if (!terminalRun || !["succeeded", "failed", "cancelled"].includes(terminalRun.status)) {
    return { accepted: true, acknowledged: false, reason: "computer_use_run_not_terminal" };
  }
  return { accepted: true, acknowledged: true, reason: `run_${terminalRun.status}` };
}

async function waitForRuntimeCompletion(completion: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      completion.then(() => true, () => true),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function readStopRequest(value: unknown): StopComputerUseRequest {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    throw new Error("Computer Use stop body must be a JSON object");
  }
  if (value.reason !== undefined && typeof value.reason !== "string") {
    throw new Error("Computer Use stop reason must be a string");
  }
  return typeof value.reason === "string" && value.reason.trim() ? { reason: value.reason.trim() } : {};
}

function parseStopRoute(pathname: string): { readonly sessionId: string } | undefined {
  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  return segments.length === 4 && segments[0] === "computer-use" && segments[1] === "sessions" && segments[3] === "stop"
    ? { sessionId: segments[2] }
    : undefined;
}

function parseSourceRoute(pathname: string): { readonly sessionId: string } | undefined {
  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  return segments.length === 4 && segments[0] === "computer-use" && segments[1] === "sessions" && segments[3] === "source"
    ? { sessionId: segments[2] }
    : undefined;
}

function readCwd(url: URL): string {
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    throw new Error("cwd query parameter is required");
  }
  return cwd;
}

function readAfterSeq(url: URL): number {
  return readIntegerQuery(url, "afterSeq", 0, 0);
}

function readLimit(url: URL): number {
  return readIntegerQuery(url, "limit", 500, 1);
}

function readIntegerQuery(url: URL, key: string, fallback: number, minimum: number): number {
  const raw = url.searchParams.get(key);
  if (raw === null) {
    return fallback;
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < minimum || String(value) !== raw) {
    throw new Error(`${key} must be an integer greater than or equal to ${minimum}`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeTokenEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.byteLength === rightBuffer.byteLength && timingSafeEqual(leftBuffer, rightBuffer);
}

function desktopBridgeTokenStatus(
  request: IncomingMessage,
  context: DaemonContext,
): "accepted" | "unavailable" | "forbidden" {
  const configuredToken = context.desktopBridgeToken;
  if (!configuredToken) {
    return "unavailable";
  }
  const providedToken = request.headers["x-ling-desktop-bridge-token"];
  return typeof providedToken === "string" && safeTokenEquals(providedToken, configuredToken)
    ? "accepted"
    : "forbidden";
}

function computerUseRouteAuthorization(
  request: IncomingMessage,
  context: DaemonContext,
): "accepted" | "unavailable" | "forbidden" {
  const origin = request.headers.origin;
  if (origin !== undefined) {
    // The caller already passed isAllowedLocalOrigin() in the route entrypoint.
    // A local Origin is the browser-side CSRF boundary; do not require a
    // native secret to be copied into the Web renderer.
    return "accepted";
  }
  const configuredToken = context.computerUseRouteToken;
  if (!configuredToken) {
    return "unavailable";
  }
  const providedToken = request.headers[COMPUTER_USE_ROUTE_TOKEN_HEADER.toLowerCase()];
  return typeof providedToken === "string" && safeTokenEquals(providedToken, configuredToken)
    ? "accepted"
    : "forbidden";
}

function writePrivateJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.removeHeader("Access-Control-Allow-Origin");
  response.removeHeader("Access-Control-Allow-Methods");
  response.removeHeader("Access-Control-Allow-Headers");
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(`${JSON.stringify(body)}\n`);
}
