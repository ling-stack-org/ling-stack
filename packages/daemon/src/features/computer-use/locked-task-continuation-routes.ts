import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import type { DaemonContext } from "../../context.js";
import { readOptionalJsonBody } from "../../shared/request.js";
import { desktopBridgeTokenStatus } from "./desktop-bridge-auth.js";

const LOCKED_TASK_CONTINUATION_STATE_PATH =
  "/computer-use/locked-task-continuation/desktop/state";
const LOCKED_TASK_CONTINUATION_RELEASE_PATH =
  "/computer-use/locked-task-continuation/desktop/release";
const MIN_LEASE_TTL_MS = 5_000;
const MAX_LEASE_TTL_MS = 60_000;

/** Desktop-only mutation route. Renderer and route tokens cannot access it. */
export async function handleLockedTaskContinuationDesktopRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  context: DaemonContext,
): Promise<boolean> {
  if (url.pathname !== LOCKED_TASK_CONTINUATION_STATE_PATH
    && url.pathname !== LOCKED_TASK_CONTINUATION_RELEASE_PATH) return false;
  response.removeHeader("Access-Control-Allow-Origin");
  response.removeHeader("Access-Control-Allow-Methods");
  response.removeHeader("Access-Control-Allow-Headers");
  const token = desktopBridgeTokenStatus(request, context.desktopBridgeToken);
  if (token !== "accepted") {
    writePrivateJson(response, token === "unavailable" ? 503 : 403, {
      error: token === "unavailable" ? "desktop_bridge_unavailable" : "desktop_bridge_forbidden",
    });
    return true;
  }
  if (request.method !== "POST") {
    writePrivateJson(response, 405, { error: "method_not_allowed" });
    return true;
  }
  const body = readRecord(await readOptionalJsonBody(request, context.config.maxBodyBytes));
  assertOnlyKeys(body, url.pathname === LOCKED_TASK_CONTINUATION_STATE_PATH
    ? ["continueWhileLocked", "desktopInstanceId", "leaseTtlMs", "locked", "workspaceCwd"]
    : ["desktopInstanceId", "workspaceCwd"]);
  const workspaceCwd = readText(body.workspaceCwd, 4_096);
  if (resolve(workspaceCwd) !== resolve(context.config.defaultWorkspaceCwd)) {
    writePrivateJson(response, 409, { error: "locked_task_continuation_workspace_mismatch" });
    return true;
  }
  const desktopInstanceId = readText(body.desktopInstanceId, 256);
  if (url.pathname === LOCKED_TASK_CONTINUATION_RELEASE_PATH) {
    writePrivateJson(response, 200, context.runtimeSupervisor.releaseLockedTaskContinuation(desktopInstanceId));
    return true;
  }
  if (typeof body.continueWhileLocked !== "boolean" || typeof body.locked !== "boolean") {
    throw new Error("locked_task_continuation_request_invalid");
  }
  const leaseTtlMs = readInteger(body.leaseTtlMs, MIN_LEASE_TTL_MS, MAX_LEASE_TTL_MS);
  writePrivateJson(response, 200, context.runtimeSupervisor.updateLockedTaskContinuation({
    desktopInstanceId,
    leaseTtlMs,
    continueWhileLocked: body.continueWhileLocked,
    locked: body.locked,
  }));
  return true;
}

function writePrivateJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(body));
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("locked_task_continuation_request_invalid");
  }
  return value as Readonly<Record<string, unknown>>;
}

function assertOnlyKeys(value: Readonly<Record<string, unknown>>, allowed: readonly string[]): void {
  const allowedKeys = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new Error("locked_task_continuation_request_invalid");
  }
}

function readText(value: unknown, maxLength: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new Error("locked_task_continuation_request_invalid");
  }
  return value;
}

function readInteger(value: unknown, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error("locked_task_continuation_request_invalid");
  }
  return value as number;
}
