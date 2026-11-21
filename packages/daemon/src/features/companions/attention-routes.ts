import type { IncomingMessage, ServerResponse } from "node:http";
import type { ResolvedDaemonConfig } from "../../config.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { writeJson } from "../../shared/response.js";
import { buildCompanionAttentionProjection } from "./attention.js";

export async function handleCompanionAttention(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }
  if (request.method !== "GET") {
    writeJson(response, 405, { error: "method_not_allowed", message: "Companion attention is read-only." });
    return;
  }
  try {
    const projection = buildCompanionAttentionProjection({
      store: storeRegistry.getStore(cwd),
      cwd,
      limit: readLimit(url.searchParams.get("limit")),
    });
    writeJson(response, 200, projection);
  } catch (error) {
    writeJson(response, 400, {
      error: "companion_attention_unavailable",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function readLimit(value: string | null): number | undefined {
  if (value === null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 500) : undefined;
}
