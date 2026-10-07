import type { IncomingMessage, ServerResponse } from "node:http";
import "../../runtime/sandbox/core-original-process-bridge.js";
import {
  parseExternalWorkflowMarkdown,
  pollGitHubExternalWork,
  pollLinearExternalWork,
  reconcileExternalWork,
  type ExternalWorkPollResponse,
  type ExternalWorkReconcileResponse,
  type ExternalWorkflowDefinition,
  type SecretResolver,
} from "@ling-stack/core";
import type { ResolvedDaemonConfig } from "../../config.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { readJsonBody } from "../../shared/request.js";
import { writeJson } from "../../shared/response.js";
import {
  parseExternalGitHubPollRequest,
  parseExternalLinearPollRequest,
  parseExternalWorkReconcileRequest,
} from "./schemas.js";
import {
  readExternalWorkflowFile,
  resolveExternalGitHubToken,
  resolveExternalSourceToken,
} from "./workflow.js";

export async function handleExternalGitHubPoll(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  secretResolver: SecretResolver,
  externalWorkFetch?: typeof globalThis.fetch,
): Promise<void> {
  if (request.method !== "POST") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for GitHub external work poll` });
    return;
  }

  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    const body = await readJsonBody(request, config.maxBodyBytes);
    const input = parseExternalGitHubPollRequest(body);
    const channel = store.getChannel(input.channelId);
    if (!channel) {
      writeJson(response, 404, { error: "channel_not_found", message: `Channel not found: ${input.channelId}` });
      return;
    }
    const workflowFile = readExternalWorkflowFile(input, channel, cwd);
    const workflowDefinition = parseExternalWorkflowMarkdown(workflowFile.markdown);
    if (workflowDefinition.config.source.kind !== "github") {
      writeJson(response, 400, { error: "unsupported_source", message: `Unsupported external source kind: ${workflowDefinition.config.source.kind}` });
      return;
    }
    const githubToken = resolveExternalGitHubToken(workflowDefinition, secretResolver);
    const pollResponse: ExternalWorkPollResponse = await pollGitHubExternalWork({
      store,
      cwd,
      channelId: input.channelId,
      workflowDefinition,
      workflowDirectory: workflowFile.directory,
      githubToken,
      fetch: externalWorkFetch,
      limit: input.limit,
      executeHooks: input.executeHooks === true,
    });
    writeJson(response, 200, pollResponse);
  } catch (error) {
    writeJson(response, 400, { error: "bad_request", message: error instanceof Error ? error.message : String(error) });
  }
}

export async function handleExternalLinearPoll(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  secretResolver: SecretResolver,
  externalWorkFetch?: typeof globalThis.fetch,
): Promise<void> {
  if (request.method !== "POST") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for Linear external work poll` });
    return;
  }

  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    const body = await readJsonBody(request, config.maxBodyBytes);
    const input = parseExternalLinearPollRequest(body);
    const channel = store.getChannel(input.channelId);
    if (!channel) {
      writeJson(response, 404, { error: "channel_not_found", message: `Channel not found: ${input.channelId}` });
      return;
    }
    const workflowFile = readExternalWorkflowFile(input, channel, cwd);
    const workflowDefinition = parseExternalWorkflowMarkdown(workflowFile.markdown);
    if (workflowDefinition.config.source.kind !== "linear") {
      writeJson(response, 400, { error: "unsupported_source", message: `Unsupported external source kind: ${workflowDefinition.config.source.kind}` });
      return;
    }
    const linearToken = resolveExternalSourceToken(workflowDefinition, secretResolver, "linear_token", "Linear");
    const pollResponse: ExternalWorkPollResponse = await pollLinearExternalWork({
      store,
      cwd,
      channelId: input.channelId,
      workflowDefinition,
      workflowDirectory: workflowFile.directory,
      linearToken,
      fetch: externalWorkFetch,
      limit: input.limit,
      executeHooks: input.executeHooks === true,
    });
    writeJson(response, 200, pollResponse);
  } catch (error) {
    writeJson(response, 400, { error: "bad_request", message: error instanceof Error ? error.message : String(error) });
  }
}

export async function handleExternalWorkReconcile(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  secretResolver: SecretResolver,
  externalWorkFetch?: typeof globalThis.fetch,
): Promise<void> {
  if (request.method !== "POST") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for external work reconcile` });
    return;
  }

  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    const body = await readJsonBody(request, config.maxBodyBytes);
    const input = parseExternalWorkReconcileRequest(body);
    let workflowDefinition: ExternalWorkflowDefinition | undefined;
    let githubToken: string | undefined;
    if (input.workflowPath) {
      const channel = input.channelId ? store.getChannel(input.channelId) : undefined;
      if (input.channelId && !channel) {
        writeJson(response, 404, { error: "channel_not_found", message: `Channel not found: ${input.channelId}` });
        return;
      }
      const workflowFile = readExternalWorkflowFile(input, channel, cwd);
      workflowDefinition = parseExternalWorkflowMarkdown(workflowFile.markdown);
      githubToken = workflowDefinition.config.source.kind === "github"
        ? resolveExternalGitHubToken(workflowDefinition, secretResolver)
        : undefined;
    }
    const reconcileResponse: ExternalWorkReconcileResponse = await reconcileExternalWork({
      store,
      channelId: input.channelId,
      workflowDefinition,
      githubToken,
      fetch: externalWorkFetch,
    });
    writeJson(response, 200, reconcileResponse);
  } catch (error) {
    writeJson(response, 400, { error: "bad_request", message: error instanceof Error ? error.message : String(error) });
  }
}
