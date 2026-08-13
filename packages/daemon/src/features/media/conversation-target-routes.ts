import type { IncomingMessage, ServerResponse } from "node:http";
import type { ConversationMediaGenerationTargetsResponse } from "@ling-stack/contracts";
import type { SecretResolver } from "@ling-stack/core";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { writeJson } from "../../shared/response.js";
import { listConversationMediaGenerationTargets } from "./conversation-targets.js";

export function handleConversationMediaGenerationTargets(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  storeRegistry: RunStoreRegistry,
  secretResolver: SecretResolver,
): void {
  if (request.method !== "GET") {
    writeJson(response, 405, {
      error: "method_not_allowed",
      message: `${request.method} is not supported for conversation media generation targets`,
    });
    return;
  }
  const cwd = url.searchParams.get("cwd")?.trim();
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    const body: ConversationMediaGenerationTargetsResponse = {
      cwd,
      defaults: store.getWorkspaceSettings().mediaGenerationDefaults ?? {},
      targets: listConversationMediaGenerationTargets(store, secretResolver).map((target) => ({
        id: target.id,
        ref: target.ref,
        generationKind: target.generationKind,
        displayName: target.displayName,
        runnable: target.runnable,
        ...(target.unavailableReason ? { unavailableReason: target.unavailableReason } : {}),
      })),
    };
    writeJson(response, 200, body);
  } catch (error) {
    writeJson(response, 400, {
      error: "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
