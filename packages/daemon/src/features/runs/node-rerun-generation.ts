import type { IncomingMessage, ServerResponse } from "node:http";
import type { NodeRerunGenerationResponseV1 } from "@ling-stack/contracts";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { writeJson } from "../../shared/response.js";

/** Read one generation's frozen dependency view without runtime or execution preparation. */
export function handleGetNodeRerunGeneration(
  request: IncomingMessage, response: ServerResponse, url: URL,
  storeRegistry: RunStoreRegistry, runId: string, recordId: string,
): void {
  if (request.method !== "GET") {
    writeJson(response, 405, { error: "method_not_allowed", message: "Node rerun generation reads require GET." });
    return;
  }
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "cwd_required", message: "cwd query parameter is required" });
    return;
  }
  try {
    const store = storeRegistry.getInitializedStore(cwd);
    if (!store) {
      writeJson(response, 503, { error: "node_rerun_generation_unavailable", message: "Node rerun generations require an initialized workspace Store." });
      return;
    }
    const result = store.readSnapshot(() => {
      const record = store.getNodeRerunIntent(recordId);
      if (!record || record.intent.source.runId !== runId) return undefined;
      return store.getNodeRerunGeneration(recordId);
    });
    if (!result) {
      writeJson(response, 404, { error: "node_rerun_generation_not_found", message: "No prepared node rerun generation was found under the source Run." });
      return;
    }
    const output: NodeRerunGenerationResponseV1 = { schemaVersion: 1, kind: "node_rerun_generation_response",
      generation: result, executionAuthorized: false };
    writeJson(response, 200, output);
  } catch {
    writeJson(response, 503, { error: "node_rerun_generation_unavailable", message: "The Host could not read a consistent node rerun generation." });
  }
}
