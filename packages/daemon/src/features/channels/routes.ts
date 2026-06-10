import type { IncomingMessage, ServerResponse } from "node:http";
import { createChannelId } from "@ling-stack/core";
import type { ResolvedDaemonConfig } from "../../config.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { readJsonBody, readOptionalIntegerQuery } from "../../shared/request.js";
import { writeJson } from "../../shared/response.js";
import {
  createEmptyChannelBrief,
  validateChannelBriefReferences,
  validateChannelContextSummaryReferences,
  validateChannelDecisionOwner,
  validateChannelMessageOwner,
  validateProtocolSourceReferences,
} from "./protocol.js";
import {
  parseChannelBriefRequest,
  parseChannelContextSummaryRequest,
  parseChannelContextSummaryUpdateRequest,
  parseChannelDecisionRequest,
  parseChannelDecisionUpdateRequest,
  parseChannelExecutionProposalRequest,
  parseChannelExecutionProposalUpdateInput,
  parseChannelHandoffRequest,
  parseChannelHandoffUpdateRequest,
  parseChannelUpdateInput,
  parseCreateChannelInput,
  readOptionalChannelDecisionStatusQuery,
  readOptionalChannelContextSummaryTargetTypeQuery,
  readOptionalChannelExecutionProposalStatusQuery,
  readOptionalChannelMessageRouteDecisionStatusQuery,
  readOptionalChannelHandoffStatusQuery,
} from "./schemas.js";
import { createManagedWorktreeBinding } from "./workspace.js";

export async function handleChannelsCollection(
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

  try {
    const store = storeRegistry.getStore(cwd);
    if (request.method === "GET") {
      writeJson(response, 200, {
        cwd,
        channels: store.listChannels({ limit: readOptionalIntegerQuery(url, "limit", 1) }),
      });
      return;
    }

    if (request.method === "POST") {
      const body = await readJsonBody(request, config.maxBodyBytes);
      const input = parseCreateChannelInput(body);
      if (input.autoReplyMode === "auto_route" && !config.channels.autoRoute) {
        writeJson(response, 400, { error: "auto_route_disabled", message: "Channel auto_route is disabled." });
        return;
      }
      const channelId = createChannelId();
      const worktreeResult = await createManagedWorktreeBinding(
        {
          id: channelId,
          boundPath: input.boundPath,
          workspaceBinding: undefined,
        },
        cwd,
      );
      if (!worktreeResult.ok) {
        writeJson(response, 400, { error: worktreeResult.code, message: worktreeResult.message });
        return;
      }
      const channel = store.createChannel(
        {
          ...input,
          id: channelId,
          workspaceBinding: worktreeResult.binding,
        },
        new Date().toISOString(),
      );
      writeJson(response, 201, { channel });
      return;
    }

    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for /channels` });
  } catch (error) {
    writeJson(response, 400, {
      error: "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function handleChannelItem(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  channelId: string,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    const channel = store.getChannel(channelId);
    if (!channel) {
      writeJson(response, 404, { error: "channel_not_found", message: `Channel not found: ${channelId}` });
      return;
    }

    if (request.method === "GET") {
      writeJson(response, 200, { channel });
      return;
    }

    if (request.method === "PATCH") {
      const body = await readJsonBody(request, config.maxBodyBytes);
      const input = parseChannelUpdateInput(body);
      if (input.autoReplyMode === "auto_route" && !config.channels.autoRoute) {
        writeJson(response, 400, { error: "auto_route_disabled", message: "Channel auto_route is disabled." });
        return;
      }
      const updated = store.updateChannel(channelId, input, new Date().toISOString());
      writeJson(response, 200, { channel: updated });
      return;
    }

    if (request.method === "DELETE") {
      const tasks = store.listTasks({ channelId, limit: 1 });
      if (tasks.length > 0) {
        writeJson(response, 409, { error: "channel_has_tasks", message: `Channel has tasks and cannot be deleted: ${channelId}` });
        return;
      }
      store.deleteChannel(channelId);
      writeJson(response, 200, { ok: true });
      return;
    }

    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for channels` });
  } catch (error) {
    writeJson(response, 400, {
      error: "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function handleChannelExecutionProposalsCollection(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  channelId: string,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    const channel = store.getChannel(channelId);
    if (!channel) {
      writeJson(response, 404, { error: "channel_not_found", message: `Channel not found: ${channelId}` });
      return;
    }

    if (request.method === "GET") {
      writeJson(response, 200, {
        cwd,
        channelId,
        proposals: store.listChannelExecutionProposals({
          channelId,
          sourceMessageId: url.searchParams.get("sourceMessageId") ?? undefined,
          status: readOptionalChannelExecutionProposalStatusQuery(url),
          limit: readOptionalIntegerQuery(url, "limit", 1),
        }),
      });
      return;
    }

    if (request.method === "POST") {
      const body = await readJsonBody(request, config.maxBodyBytes);
      const input = parseChannelExecutionProposalRequest(body);
      const messageError = validateChannelMessageOwner(store, channelId, input.sourceMessageId);
      if (messageError) {
        writeJson(response, messageError.statusCode === 404 ? 400 : messageError.statusCode, {
          error: messageError.code,
          message: messageError.message,
        });
        return;
      }
      const proposal = store.createChannelExecutionProposal({ channelId, ...input }, new Date().toISOString());
      writeJson(response, 201, { proposal });
      return;
    }

    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for channel proposals` });
  } catch (error) {
    writeJson(response, 400, {
      error: "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function handleChannelExecutionProposalItem(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  proposalId: string,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    const proposal = store.getChannelExecutionProposal(proposalId);
    if (!proposal) {
      writeJson(response, 404, { error: "proposal_not_found", message: `Channel proposal not found: ${proposalId}` });
      return;
    }

    if (request.method === "GET") {
      writeJson(response, 200, { proposal });
      return;
    }

    if (request.method === "PATCH") {
      const body = await readJsonBody(request, config.maxBodyBytes);
      const input = parseChannelExecutionProposalUpdateInput(body);
      const updated = store.updateChannelExecutionProposal(proposalId, input, new Date().toISOString());
      writeJson(response, 200, { proposal: updated ?? proposal });
      return;
    }

    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for channel proposal` });
  } catch (error) {
    writeJson(response, 400, {
      error: "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function handleChannelMessageRouteDecisionsCollection(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  channelId: string,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    const channel = store.getChannel(channelId);
    if (!channel) {
      writeJson(response, 404, { error: "channel_not_found", message: `Channel not found: ${channelId}` });
      return;
    }

    if (request.method === "GET") {
      const sourceMessageId = url.searchParams.get("sourceMessageId") ?? undefined;
      if (sourceMessageId) {
        const messageError = validateChannelMessageOwner(store, channelId, sourceMessageId);
        if (messageError) {
          writeJson(response, messageError.statusCode, {
            error: messageError.code,
            message: messageError.message,
          });
          return;
        }
      }
      writeJson(response, 200, {
        cwd,
        channelId,
        decisions: store.listChannelMessageRouteDecisions({
          channelId,
          sourceMessageId,
          status: readOptionalChannelMessageRouteDecisionStatusQuery(url),
          limit: readOptionalIntegerQuery(url, "limit", 1),
        }),
      });
      return;
    }

    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for channel route decisions` });
  } catch (error) {
    writeJson(response, 400, {
      error: "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function handleChannelDecisionsCollection(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  channelId: string,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    if (!store.getChannel(channelId)) {
      writeJson(response, 404, { error: "channel_not_found", message: `Channel not found: ${channelId}` });
      return;
    }

    if (request.method === "GET") {
      const status = readOptionalChannelDecisionStatusQuery(url, "status");
      writeJson(response, 200, {
        cwd,
        channelId,
        decisions: store.listChannelDecisions({ channelId, status, limit: readOptionalIntegerQuery(url, "limit", 1) }),
      });
      return;
    }

    if (request.method === "POST") {
      const body = await readJsonBody(request, config.maxBodyBytes);
      const input = parseChannelDecisionRequest(body);
      const referenceError = validateProtocolSourceReferences(store, channelId, input) ??
        (input.supersedesDecisionId ? validateChannelDecisionOwner(store, channelId, input.supersedesDecisionId) : undefined);
      if (referenceError) {
        writeJson(response, referenceError.statusCode, { error: referenceError.code, message: referenceError.message });
        return;
      }
      const decision = store.createChannelDecision({ ...input, channelId }, new Date().toISOString());
      writeJson(response, 201, { decision });
      return;
    }

    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for channel decisions` });
  } catch (error) {
    writeJson(response, 400, { error: "bad_request", message: error instanceof Error ? error.message : String(error) });
  }
}

export async function handleChannelDecisionItem(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  decisionId: string,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    const existing = store.getChannelDecision(decisionId);
    if (!existing) {
      writeJson(response, 404, { error: "decision_not_found", message: `Channel decision not found: ${decisionId}` });
      return;
    }
    if (request.method !== "PATCH") {
      writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for channel decision` });
      return;
    }
    const body = await readJsonBody(request, config.maxBodyBytes);
    const input = parseChannelDecisionUpdateRequest(body);
    const decision = store.updateChannelDecision(decisionId, input, new Date().toISOString());
    writeJson(response, 200, { decision: decision ?? existing });
  } catch (error) {
    writeJson(response, 400, { error: "bad_request", message: error instanceof Error ? error.message : String(error) });
  }
}

export async function handleChannelHandoffsCollection(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  channelId: string,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    if (!store.getChannel(channelId)) {
      writeJson(response, 404, { error: "channel_not_found", message: `Channel not found: ${channelId}` });
      return;
    }

    if (request.method === "GET") {
      const status = readOptionalChannelHandoffStatusQuery(url, "status");
      writeJson(response, 200, {
        cwd,
        channelId,
        handoffs: store.listChannelHandoffs({ channelId, status, limit: readOptionalIntegerQuery(url, "limit", 1) }),
      });
      return;
    }

    if (request.method === "POST") {
      const body = await readJsonBody(request, config.maxBodyBytes);
      const input = parseChannelHandoffRequest(body);
      const referenceError = validateProtocolSourceReferences(store, channelId, input);
      if (referenceError) {
        writeJson(response, referenceError.statusCode, { error: referenceError.code, message: referenceError.message });
        return;
      }
      const handoff = store.createChannelHandoff({ ...input, channelId }, new Date().toISOString());
      writeJson(response, 201, { handoff });
      return;
    }

    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for channel handoffs` });
  } catch (error) {
    writeJson(response, 400, { error: "bad_request", message: error instanceof Error ? error.message : String(error) });
  }
}

export async function handleChannelHandoffItem(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  handoffId: string,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    const existing = store.getChannelHandoff(handoffId);
    if (!existing) {
      writeJson(response, 404, { error: "handoff_not_found", message: `Channel handoff not found: ${handoffId}` });
      return;
    }
    if (request.method !== "PATCH") {
      writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for channel handoff` });
      return;
    }
    const body = await readJsonBody(request, config.maxBodyBytes);
    const input = parseChannelHandoffUpdateRequest(body);
    const handoff = store.updateChannelHandoff(handoffId, input, new Date().toISOString());
    writeJson(response, 200, { handoff: handoff ?? existing });
  } catch (error) {
    writeJson(response, 400, { error: "bad_request", message: error instanceof Error ? error.message : String(error) });
  }
}

export async function handleChannelBrief(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  channelId: string,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    const channel = store.getChannel(channelId);
    if (!channel) {
      writeJson(response, 404, { error: "channel_not_found", message: `Channel not found: ${channelId}` });
      return;
    }

    if (request.method === "GET") {
      writeJson(response, 200, {
        cwd,
        channelId,
        brief: store.getChannelBrief(channelId) ?? createEmptyChannelBrief(channel),
      });
      return;
    }

    if (request.method === "PATCH") {
      const body = await readJsonBody(request, config.maxBodyBytes);
      const input = parseChannelBriefRequest(body);
      const referenceError = validateChannelBriefReferences(store, channelId, input);
      if (referenceError) {
        writeJson(response, referenceError.statusCode, { error: referenceError.code, message: referenceError.message });
        return;
      }
      const brief = store.updateChannelBrief(channelId, input, new Date().toISOString());
      writeJson(response, 200, { brief });
      return;
    }

    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for channel brief` });
  } catch (error) {
    writeJson(response, 400, { error: "bad_request", message: error instanceof Error ? error.message : String(error) });
  }
}

export async function handleChannelContextSummariesCollection(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  channelId: string,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    if (!store.getChannel(channelId)) {
      writeJson(response, 404, { error: "channel_not_found", message: `Channel not found: ${channelId}` });
      return;
    }

    if (request.method === "GET") {
      const targetType = readOptionalChannelContextSummaryTargetTypeQuery(url, "targetType");
      writeJson(response, 200, {
        cwd,
        channelId,
        contextSummaries: store.listChannelContextSummaries({
          channelId,
          targetType,
          targetId: url.searchParams.get("targetId") ?? undefined,
          limit: readOptionalIntegerQuery(url, "limit", 1),
        }),
      });
      return;
    }

    if (request.method === "POST") {
      const body = await readJsonBody(request, config.maxBodyBytes);
      const input = parseChannelContextSummaryRequest(body);
      const referenceError = validateChannelContextSummaryReferences(store, channelId, input);
      if (referenceError) {
        writeJson(response, referenceError.statusCode, { error: referenceError.code, message: referenceError.message });
        return;
      }
      const contextSummary = store.createChannelContextSummary({ ...input, channelId }, new Date().toISOString());
      writeJson(response, 201, { contextSummary });
      return;
    }

    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for channel context summaries` });
  } catch (error) {
    writeJson(response, 400, { error: "bad_request", message: error instanceof Error ? error.message : String(error) });
  }
}

export async function handleChannelContextSummaryItem(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  contextSummaryId: string,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    const existing = store.getChannelContextSummary(contextSummaryId);
    if (!existing) {
      writeJson(response, 404, { error: "context_summary_not_found", message: `Channel context summary not found: ${contextSummaryId}` });
      return;
    }
    if (request.method !== "PATCH") {
      writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for channel context summary` });
      return;
    }
    const body = await readJsonBody(request, config.maxBodyBytes);
    const input = parseChannelContextSummaryUpdateRequest(body);
    const referenceError = validateChannelContextSummaryReferences(store, existing.channelId, {
      targetType: input.targetType ?? existing.targetType,
      targetId: input.targetId ?? existing.targetId,
      sourceMessageIds: input.sourceMessageIds ?? existing.sourceMessageIds,
      decisionIds: input.decisionIds ?? existing.decisionIds,
    });
    if (referenceError) {
      writeJson(response, referenceError.statusCode, { error: referenceError.code, message: referenceError.message });
      return;
    }
    const contextSummary = store.updateChannelContextSummary(contextSummaryId, input, new Date().toISOString());
    writeJson(response, 200, { contextSummary: contextSummary ?? existing });
  } catch (error) {
    writeJson(response, 400, { error: "bad_request", message: error instanceof Error ? error.message : String(error) });
  }
}
