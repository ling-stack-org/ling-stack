import type { IncomingMessage, ServerResponse } from "node:http";
import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { SecretResolver } from "@ling-stack/core";
import type { ResolvedDaemonConfig } from "../../config.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import type { RunnerRegistry } from "../../runtime/runners.js";
import { HttpError } from "../../errors.js";
import { allowLocalServiceRequest, allowLocalWorkspaceRequest } from "../../shared/local-workspace-access.js";
import { readJsonBody } from "../../shared/request.js";
import { writeJson } from "../../shared/response.js";
import { deliberationChannelId, readWorkspaceDeliberationPolicy, updateWorkspaceDeliberationPolicy,
  workspaceDeliberationPolicyUpdate } from "../../server/app-server-deliberation-config.js";
import { buildEffectiveConfigResponse, parseWorkspaceSettingsUpdate } from "./effective-config.js";
import { redactWorktreePolicy, restoreRedactedWorktreePolicy } from "../workspaces/worktree-policy.js";
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
  onBrowserPolicyChanged?: (cwd: string) => void,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  if (!allowLocalWorkspaceRequest({ request, response, storeRegistry, cwd })) return;

  try {
    const body = request.method === "PATCH" ? await readJsonBody(request, config.maxBodyBytes) : undefined;
    const store = storeRegistry.getStore(cwd);
    if (request.method === "GET") {
      const settings = store.getWorkspaceSettings();
      writeJson(response, 200, { cwd, settings: { ...settings, worktreePolicy: redactWorktreePolicy(settings.worktreePolicy) } });
      return;
    }
    if (request.method === "PATCH") {
      const current = store.getWorkspaceSettings();
      const parsed = parseWorkspaceSettingsUpdate(body);
      const update = { ...parsed, worktreePolicy: restoreRedactedWorktreePolicy(parsed.worktreePolicy, current.worktreePolicy) };
      assertMediaGenerationDefaultUpdate({
        current: store.getWorkspaceSettings().mediaGenerationDefaults,
        next: update.mediaGenerationDefaults,
        targets: listConversationMediaGenerationTargets(store, secretResolver),
      });
      const settings = store.updateWorkspaceSettings(update, new Date().toISOString());
      if (update.desktopBrowserPolicy !== undefined) onBrowserPolicyChanged?.(cwd);
      writeJson(response, 200, { cwd, settings: { ...settings, worktreePolicy: redactWorktreePolicy(settings.worktreePolicy) } });
      return;
    }
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for workspace settings` });
  } catch (error) {
    writeJson(response, error instanceof HttpError ? error.statusCode : 400, {
      error: error instanceof HttpError ? error.code : "bad_request",
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

  if (!allowLocalWorkspaceRequest({ request, response, storeRegistry, cwd })) return;

  try {
    const store = storeRegistry.getStore(cwd);
    writeJson(response, 200, await buildEffectiveConfigResponse({ cwd, store, runnerRegistry }));
  } catch (error) {
    writeJson(response, error instanceof HttpError ? error.statusCode : 400, {
      error: error instanceof HttpError ? error.code : "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function handleWorkspaceDeliberationPolicy(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
): Promise<void> {
  const workspace = url.searchParams.get("cwd");
  const channel = deliberationChannelId.safeParse(url.searchParams.get("channelId"));
  if (!workspace || !isAbsolute(workspace) || !channel.success) {
    writeJson(response, 400, { error: "bad_request", message: "Supply an absolute cwd and the channel ID." });
    return;
  }
  if (!allowLocalServiceRequest(request, response)) return;
  if (request.method !== "GET" && request.method !== "PATCH") {
    writeJson(response, 405, { error: "method_not_allowed", message: "Deliberation policy supports GET and PATCH." });
    return;
  }
  let cwd: string;
  try {
    cwd = realpathSync(workspace);
  } catch {
    writeJson(response, 403, { error: "workspace_not_trusted", message: "The workspace path could not be resolved." });
    return;
  }
  if (!allowLocalWorkspaceRequest({ request, response, storeRegistry, cwd })) return;
  const store = storeRegistry.getStore(cwd);
  const channelId = channel.data;
  if (!store.getChannel(channelId)) {
    writeJson(response, 404, { error: "channel_not_found", message: "The channel is unavailable in this workspace." });
    return;
  }
  const policies = config.appServerDeliberationPolicies;
  if (request.method === "GET") {
    writeJson(response, 200, readWorkspaceDeliberationPolicy(store, cwd, channelId, policies));
    return;
  }
  let body: unknown;
  try {
    body = await readJsonBody(request, config.maxBodyBytes);
  } catch (error) {
    writeJson(response, 400, { error: "bad_request", message: error instanceof Error ? error.message : String(error) });
    return;
  }
  const update = workspaceDeliberationPolicyUpdate.safeParse(body);
  if (!update.success) {
    writeJson(response, 400, { error: "bad_request", message: "Supply a policy and the current settings revision." });
    return;
  }
  try {
    writeJson(response, 200, updateWorkspaceDeliberationPolicy(store, cwd, channelId, policies, update.data, new Date().toISOString()));
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    writeJson(response, error.statusCode, { error: error.code, message: error.message });
  }
}
