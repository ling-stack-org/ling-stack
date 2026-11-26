import type { IncomingMessage, ServerResponse } from "node:http";
import type { DaemonContext } from "../context.js";
import { HttpError } from "../errors.js";
import { allowLocalWorkspaceRequest } from "../shared/local-workspace-access.js";
import { readJsonBody } from "../shared/request.js";
import { writeJson } from "../shared/response.js";
import { isRecord } from "../shared/validation.js";
import { getAppServerDevelopmentService } from "./app-server-development.js";

export async function handleWorkspaceVerificationRoute(request: IncomingMessage, response: ServerResponse, url: URL, context: DaemonContext): Promise<void> {
  const cwd = url.searchParams.get("cwd")?.trim();
  if (!cwd) {
    writeJson(response, 400, { error: "cwd_required", message: "cwd query parameter is required." });
    return;
  }
  if (!allowLocalWorkspaceRequest({ request, response, storeRegistry: context.storeRegistry, cwd })) return;
  const store = context.storeRegistry.getInitializedStore(cwd);
  if (!store) {
    writeJson(response, 404, { error: "workspace_not_loaded", message: "Open this project before reading verification." });
    return;
  }

  const development = getAppServerDevelopmentService(context);
  const cancel = url.pathname.endsWith("/cancel");
  try {
    if (!cancel && request.method === "GET") {
      writeJson(response, 200, await development.readWorkspaceVerification(store.paths.cwd, {
        operationId: readOptionalIdentifier(url.searchParams.get("operationId") ?? undefined),
        threadId: readOptionalIdentifier(url.searchParams.get("threadId") ?? undefined),
      }));
    } else if (request.method === "POST") {
      if (context.activeRuns.isShuttingDown()) throw new HttpError(503, "server_draining", "The daemon is shutting down.");
      const body = await readJsonBody(request, 16 * 1024);
      if (!isRecord(body) || typeof body.idempotencyKey !== "string") throw invalidRequest();
      if (cancel) {
        const operationId = readOptionalIdentifier(body.operationId);
        if (!operationId) throw invalidRequest();
        writeJson(response, 200, development.cancelVerification({ cwd: store.paths.cwd, operationId,
          idempotencyKey: body.idempotencyKey, expectedRevision: readOptionalIdentifier(body.expectedRevision) }));
      } else {
        const result = await development.startWorkspaceVerification(store.paths.cwd, {
          idempotencyKey: body.idempotencyKey, threadId: readOptionalIdentifier(body.threadId),
        });
        writeJson(response, 202, result);
      }
    } else {
      writeJson(response, 405, { error: "method_not_allowed" });
    }
  } catch (error) {
    const code = error instanceof HttpError ? error.code
      : isRecord(error) && typeof error.code === "string" ? error.code : "verification_unavailable";
    writeJson(response, error instanceof HttpError ? error.statusCode
      : ["stale_revision", "idempotency_conflict", "resume_blocked"].includes(code) ? 409 : 400, {
      error: code, message: error instanceof Error ? error.message : "The verification request could not be completed.",
    });
  }
}

function readOptionalIdentifier(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim() || value.length > 256 || /[\r\n\0]/u.test(value)) throw invalidRequest();
  return value;
}

function invalidRequest(): HttpError {
  return new HttpError(400, "invalid_verification_request", "Supply valid verification parameters.");
}
