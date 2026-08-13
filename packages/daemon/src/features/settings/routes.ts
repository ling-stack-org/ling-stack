import type { IncomingMessage, ServerResponse } from "node:http";
import type { SecretResolver } from "@ling-stack/core";
import type { ResolvedDaemonConfig } from "../../config.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import type { RunnerRegistry } from "../../runtime/runners.js";
import { readJsonBody } from "../../shared/request.js";
import { writeJson } from "../../shared/response.js";
import { buildEffectiveConfigResponse, parseWorkspaceSettingsUpdate } from "./effective-config.js";
import {
  assertMediaGenerationDefaultUpdate,
  listConversationMediaGenerationTargets,
} from "../media/conversation-targets.js";

export async function handleWorkspaceSettings(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  secretResolver: SecretResolver,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    if (request.method === "GET") {
      writeJson(response, 200, { cwd, settings: store.getWorkspaceSettings() });
      return;
    }
    if (request.method === "PATCH") {
      const body = await readJsonBody(request, config.maxBodyBytes);
      const update = parseWorkspaceSettingsUpdate(body);
      assertMediaGenerationDefaultUpdate({
        current: store.getWorkspaceSettings().mediaGenerationDefaults,
        next: update.mediaGenerationDefaults,
        targets: listConversationMediaGenerationTargets(store, secretResolver),
      });
      const settings = store.updateWorkspaceSettings(update, new Date().toISOString());
      writeJson(response, 200, { cwd, settings });
      return;
    }
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for workspace settings` });
  } catch (error) {
    writeJson(response, 400, {
      error: "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function handleEffectiveConfig(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  runnerRegistry: RunnerRegistry,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }
  if (request.method !== "GET") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for effective config` });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    writeJson(response, 200, await buildEffectiveConfigResponse({ cwd, store, runnerRegistry }));
  } catch (error) {
    writeJson(response, 400, {
      error: "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
