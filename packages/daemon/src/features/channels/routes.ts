import type { IncomingMessage, ServerResponse } from "node:http";
import { createChannelBranchId, createChannelId, type Channel, type ChannelBranch, type ProposedPlanArtifactStatus, type RunStore, type SecretResolver } from "@ling-stack/core";
import { HttpError } from "../../errors.js";
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
  parseChannelBranchUpdateInput,
  parseChannelContextSummaryRequest,
  parseChannelContextSummaryUpdateRequest,
  parseChannelDecisionRequest,
  parseChannelDecisionUpdateRequest,
  parseChannelExecutionProposalRequest,
  parseChannelExecutionProposalUpdateInput,
  parseChannelHandoffRequest,
  parseChannelHandoffUpdateRequest,
  parseChannelUpdateInput,
  parseCreateChannelBranchInput,
  parseCreateChannelInput,
  readOptionalChannelDecisionStatusQuery,
  readOptionalChannelContextSummaryTargetTypeQuery,
  readOptionalChannelExecutionProposalStatusQuery,
  readOptionalChannelIntentDecisionActionQuery,
  readOptionalChannelIntentDecisionStatusQuery,
  readOptionalChannelMessageRouteDecisionStatusQuery,
  readOptionalChannelHandoffStatusQuery,
} from "./schemas.js";
import { validateChannelModelUpdate } from "./model-binding-validation.js";
import { createInitialChannelWorkspaceBinding } from "./workspace.js";
import { hydrateProposedPlanSourceStates } from "../runs/proposed-plan-source-state.js";
import { assertRunnableConversationProvider } from "../providers/conversation-model-validation.js";

export async function handleChannelsCollection(
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
      const archived = readOptionalArchivedQuery(url);
      const channels = store.listChannels({ archived, limit: readOptionalIntegerQuery(url, "limit", 1) });
      const channelById = new Map(channels.map((channel) => [channel.id, channel]));
      const now = new Date().toISOString();
      writeJson(response, 200, {
        cwd,
        channels,
        branches: archived === true
          ? []
          : store.listChannelBranches({
            limit: 1000,
            archived: false,
          })
            .filter((branch) => channelById.has(branch.channelId))
            .map((branch) => ensureChannelBranchRootThread(store, channelById.get(branch.channelId), branch, now) ?? branch),
      });
      return;
    }

    if (request.method === "POST") {
      const body = await readJsonBody(request, config.maxBodyBytes);
      const input = parseCreateChannelInput(body);
      const defaultProviderPresetId = assertRunnableConversationProvider({
        store,
        cwd,
        providerPresetId: input.defaultProviderPresetId,
        secretResolver,
        ownerLabel: "Channel Ling Agent",
      });
      if (input.autoReplyMode === "auto_route" && !config.channels.autoRoute) {
        writeJson(response, 400, { error: "auto_route_disabled", message: "Channel auto_route is disabled." });
        return;
      }
      const channelId = createChannelId();
      const workspaceResult = await createInitialChannelWorkspaceBinding(
        {
          id: channelId,
          boundPath: input.boundPath,
          workspaceBinding: undefined,
        },
        cwd,
        store.paths,
      );
      if (!workspaceResult.ok) {
        writeJson(response, 400, { error: workspaceResult.code, message: workspaceResult.message });
        return;
      }
      const channel = store.createChannel(
        {
          ...input,
          defaultProviderPresetId,
          id: channelId,
          workspaceBinding: workspaceResult.binding,
        },
        new Date().toISOString(),
      );
      writeJson(response, 201, { channel });
      return;
    }

    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for /channels` });
  } catch (error) {
    writeJson(response, error instanceof HttpError ? error.statusCode : 400, {
      error: error instanceof HttpError ? error.code : "bad_request",
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
      if (input.autoReplyMode === "auto_route" && channel.autoReplyMode !== "auto_route" && !config.channels.autoRoute) {
        writeJson(response, 400, { error: "auto_route_disabled", message: "Channel auto_route is disabled." });
        return;
      }
      validateChannelModelUpdate({ store, cwd, channel, update: input, secretResolver });
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
    writeJson(response, error instanceof HttpError ? error.statusCode : 400, {
      error: error instanceof HttpError ? error.code : "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function handleChannelProposedPlans(
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
  if (request.method !== "GET") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for channel proposed plans` });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    const channel = store.getChannel(channelId);
    if (!channel) {
      writeJson(response, 404, { error: "channel_not_found", message: `Channel not found: ${channelId}` });
      return;
    }
    const scope = url.searchParams.get("scope") ?? "channel";
    const threadId = url.searchParams.get("threadId") ?? undefined;
    if (scope === "thread" && !threadId) {
      writeJson(response, 400, { error: "thread_id_required", message: "threadId is required when scope=thread." });
      return;
    }
    const plans = store.listProposedPlanArtifacts({
      channelId,
      threadId: scope === "thread" ? threadId : undefined,
      goalId: url.searchParams.get("goalId") ?? undefined,
      agentId: url.searchParams.get("agentId") ?? undefined,
      statuses: readOptionalProposedPlanStatusListQuery(url),
      limit: readOptionalIntegerQuery(url, "limit", 1),
    });
    writeJson(response, 200, {
      cwd,
      channelId,
      threadId: scope === "thread" ? threadId : undefined,
      plans: hydrateProposedPlanSourceStates(store, plans),
    });
  } catch (error) {
    writeJson(response, 400, {
      error: "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function handleChannelBranchesCollection(
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
      const now = new Date().toISOString();
      writeJson(response, 200, {
        cwd,
        channelId,
        branches: store.listChannelBranches({
          channelId,
          archived: readOptionalArchivedQuery(url),
          limit: readOptionalIntegerQuery(url, "limit", 1),
        }).map((branch) => ensureChannelBranchRootThread(store, channel, branch, now) ?? branch),
      });
      return;
    }

    if (request.method === "POST") {
      if (channel.status === "archived") {
        writeJson(response, 409, { error: "channel_archived", message: `Archived channel cannot create branches: ${channelId}` });
        return;
      }
      const body = await readJsonBody(request, config.maxBodyBytes);
      const input = parseCreateChannelBranchInput(body);
      const now = new Date().toISOString();
      const thread = createChannelBranchRootThread(store, channel, input.name, now, input.status ?? "active");
      const branch = store.createChannelBranch({
        ...input,
        id: createChannelBranchId(),
        channelId,
        rootThreadId: thread.id,
      }, now);
      writeJson(response, 201, { branch });
      return;
    }

    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for channel branches` });
  } catch (error) {
    writeJson(response, 400, {
      error: "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function handleChannelBranchItem(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  channelId: string,
  branchId: string,
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
    const branch = ensureChannelBranchRootThread(store, channel, store.getChannelBranch(branchId), new Date().toISOString());
    if (!branch || branch.channelId !== channelId) {
      writeJson(response, 404, { error: "channel_branch_not_found", message: `Channel branch not found: ${branchId}` });
      return;
    }

    if (request.method === "GET") {
      writeJson(response, 200, { branch });
      return;
    }

    if (request.method === "PATCH") {
      const body = await readJsonBody(request, config.maxBodyBytes);
      const input = parseChannelBranchUpdateInput(body);
      const now = new Date().toISOString();
      const updated = store.updateChannelBranch(branchId, {
        ...input,
        archivedAt: input.status === "archived" ? now : input.status === "active" ? null : undefined,
      }, now);
      if (updated) {
        syncChannelBranchRootThreadArchive(store, updated, now);
      }
      writeJson(response, 200, { branch: updated });
      return;
    }

    if (request.method === "DELETE") {
      if (branch.status !== "archived") {
        writeJson(response, 409, { error: "channel_branch_not_archived", message: `Channel branch must be archived before delete: ${branchId}` });
        return;
      }
      store.deleteChannelBranch(branchId);
      writeJson(response, 200, { ok: true });
      return;
    }

    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for channel branch` });
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

function readOptionalArchivedQuery(url: URL): boolean | undefined {
  const value = url.searchParams.get("archived");
  if (value === null) {
    return undefined;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new Error("archived must be true or false");
}

function readOptionalProposedPlanStatusListQuery(url: URL): readonly ProposedPlanArtifactStatus[] | undefined {
  const value = url.searchParams.get("status");
  if (!value) {
    return undefined;
  }
  const statuses = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (statuses.length === 0) {
    return undefined;
  }
  for (const status of statuses) {
    if (!proposedPlanArtifactStatuses.includes(status as ProposedPlanArtifactStatus)) {
      throw new Error(`status must be one of: ${proposedPlanArtifactStatuses.join(", ")}`);
    }
  }
  return statuses as ProposedPlanArtifactStatus[];
}

const proposedPlanArtifactStatuses = [
  "draft",
  "accepted",
  "superseded",
  "archived",
] as const satisfies readonly ProposedPlanArtifactStatus[];

function ensureChannelBranchRootThread(
  store: RunStore,
  channel: Channel | undefined,
  branch: ChannelBranch | undefined,
  now: string,
): ChannelBranch | undefined {
  if (!channel || !branch) {
    return branch;
  }
  if (branch.rootThreadId) {
    const existingThread = store.getLingThread(branch.rootThreadId);
    if (existingThread?.kind === "channel_discussion" && existingThread.channelId === channel.id) {
      return branch;
    }
  }
  const thread = createChannelBranchRootThread(store, channel, branch.name, now, branch.status, branch.archivedAt);
  return store.updateChannelBranch(branch.id, { rootThreadId: thread.id }, now) ?? { ...branch, rootThreadId: thread.id };
}

function createChannelBranchRootThread(
  store: RunStore,
  channel: Channel,
  branchName: string,
  now: string,
  branchStatus: ChannelBranch["status"],
  archivedAt?: string,
) {
  return store.createLingThread(
    {
      kind: "channel_discussion",
      channelId: channel.id,
      title: branchName || "Channel branch",
      objective: `Conversation branch "${branchName || "Channel branch"}" for ${channel.name}.`,
      status: "open",
      archivedAt: branchStatus === "archived" ? archivedAt ?? now : undefined,
      archivedReason: branchStatus === "archived" ? "channel_branch_archived" : undefined,
    },
    now,
  );
}

function syncChannelBranchRootThreadArchive(store: RunStore, branch: ChannelBranch, now: string): void {
  if (!branch.rootThreadId) {
    return;
  }
  const thread = store.getLingThread(branch.rootThreadId);
  if (!thread || thread.kind !== "channel_discussion" || thread.channelId !== branch.channelId) {
    return;
  }
  if (branch.status === "archived") {
    store.updateLingThread(branch.rootThreadId, {
      archivedAt: branch.archivedAt ?? now,
      archivedReason: "channel_branch_archived",
    }, now);
    return;
  }
  store.updateLingThread(branch.rootThreadId, {
    archivedAt: null,
    archivedReason: null,
    status: thread.status === "archived" ? "open" : thread.status,
  }, now);
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

export async function handleChannelIntentDecisionsCollection(
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
      const sourceItemId = url.searchParams.get("sourceItemId") ?? undefined;
      if (sourceItemId) {
        const messageError = validateChannelMessageOwner(store, channelId, sourceItemId);
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
        decisions: store.listChannelIntentDecisions({
          channelId,
          sourceItemId,
          action: readOptionalChannelIntentDecisionActionQuery(url),
          status: readOptionalChannelIntentDecisionStatusQuery(url),
          limit: readOptionalIntegerQuery(url, "limit", 1),
        }),
      });
      return;
    }

    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for channel intent decisions` });
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
