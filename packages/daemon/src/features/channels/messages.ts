import type { IncomingMessage, ServerResponse } from "node:http";
import type { Channel, ChannelMessage, RunIntervention, RunSession, RunStore } from "@ling-stack/core";
import type { ResolvedDaemonConfig } from "../../config.js";
import { HttpError } from "../../errors.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { readJsonBody, readOptionalIntegerQuery } from "../../shared/request.js";
import { writeJson } from "../../shared/response.js";
import {
  routeChannelMessageReply,
  routeExplicitChannelMention,
  type ChannelMessageRouteInput,
} from "./channel-message-router.js";
import { selectChannelWorkflowIntent } from "./channel-intent-selector.js";
import { buildLingAgentSessionViewForChannel } from "./ling-agent-session-view.js";
import { validateChannelMessageReferences } from "./protocol.js";
import { parseChannelMessageRequest } from "./schemas.js";

export type CreateChannelAiReply = (input: {
  readonly store: RunStore;
  readonly channel: Channel;
  readonly sourceMessage: ChannelMessage;
  readonly providerPresetId?: string;
  readonly teammateId?: string;
  readonly proposalMode?: "allow" | "disabled";
  readonly channelParallelLimit?: number;
  readonly visibleParticipantTeammateIds?: readonly string[];
}) => Promise<ChannelMessage>;

interface LingAgentChannelMessageInput {
  readonly store: RunStore;
  readonly channel: Channel;
  readonly sourceMessage: ChannelMessage;
  readonly requestedProviderPresetId?: string;
  readonly requestedTeammateId?: string;
  readonly requestAiReply: boolean;
  readonly createAiReply: CreateChannelAiReply;
  readonly config: ResolvedDaemonConfig;
  readonly routeDependencies: Omit<ChannelMessageRouteInput, "store" | "channel" | "sourceMessage" | "requestedProviderPresetId" | "requestedTeammateId">;
}

interface LingAgentActiveSessionAction {
  readonly mode: "queue_followup" | "interrupt_redirect";
  readonly status: "created" | "requires_confirmation";
  readonly sourceRunId: string;
  readonly interventionId?: string;
  readonly instruction: string;
}

interface LingAgentChannelMessageResult {
  readonly aiReply?: ChannelMessage;
  readonly aiReplies?: readonly ChannelMessage[];
  readonly routeDecisionId?: string;
  readonly intervention?: RunIntervention;
  readonly activeSessionAction?: LingAgentActiveSessionAction;
}

export async function handleChannelMessagesCollection(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  channelId: string,
  createAiReply: CreateChannelAiReply,
  routeDependencies: Omit<ChannelMessageRouteInput, "store" | "channel" | "sourceMessage" | "requestedProviderPresetId" | "requestedTeammateId">,
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
      const page = store.listChannelMessagesPage({
        channelId,
        threadId: url.searchParams.get("threadId") ?? undefined,
        beforeMessageId: url.searchParams.get("beforeMessageId") ?? undefined,
        limit: readOptionalIntegerQuery(url, "limit", 1),
      });
      writeJson(response, 200, {
        cwd,
        channelId,
        messages: page.messages,
        hasMore: page.hasMore,
        nextBeforeMessageId: page.nextBeforeMessageId,
      });
      return;
    }

    if (request.method === "POST") {
      const body = await readJsonBody(request, config.maxBodyBytes);
      const input = parseChannelMessageRequest(body);
      const referenceError = validateChannelMessageReferences(store, channelId, input.attachmentIds, input.linkPreviewIds);
      if (referenceError) {
        writeJson(response, referenceError.statusCode, {
          error: referenceError.code,
          message: referenceError.message,
        });
        return;
      }
      const now = new Date().toISOString();
      const message = store.createChannelMessage(
        {
          channelId,
          threadId: input.threadId,
          kind: input.kind ?? "message",
          intent: input.intent ?? "discuss",
          authorType: input.authorType,
          authorId: input.authorId,
          body: input.body,
          mentions: input.mentions,
          attachmentIds: input.attachmentIds,
          linkPreviewIds: input.linkPreviewIds,
          linkedTaskId: input.linkedTaskId,
          linkedRunId: input.linkedRunId,
        },
        now,
      );

      const result = await handleLingAgentChannelMessage({
        store,
        channel,
        sourceMessage: message,
        requestedProviderPresetId: input.providerPresetId,
        requestedTeammateId: input.teammateId,
        requestAiReply: Boolean(input.requestAiReply),
        createAiReply,
        config,
        routeDependencies,
      });

      if (result.routeDecisionId && result.aiReply) {
        store.updateChannelMessageRouteDecision(result.routeDecisionId, {
          replyMessageId: result.aiReply.id,
        }, new Date().toISOString());
      }

      writeJson(response, 201, {
        message,
        ...(result.aiReply ? { aiReply: result.aiReply } : {}),
        ...(result.aiReplies ? { aiReplies: result.aiReplies } : {}),
        ...(result.intervention ? { intervention: result.intervention } : {}),
        ...(result.activeSessionAction ? { activeSessionAction: result.activeSessionAction } : {}),
      });
      return;
    }

    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for channel messages` });
  } catch (error) {
    writeJson(response, error instanceof HttpError ? error.statusCode : 400, {
      error: error instanceof HttpError ? error.code : "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function handleLingAgentChannelMessage(input: LingAgentChannelMessageInput): Promise<LingAgentChannelMessageResult> {
  const activeSession = maybeHandleActiveSessionMessage(input);
  if (activeSession) {
    return activeSession;
  }

  if (input.requestAiReply) {
    const route = routeExplicitChannelMention({
      ...input.routeDependencies,
      store: input.store,
      channel: input.channel,
      sourceMessage: input.sourceMessage,
      requestedProviderPresetId: input.requestedProviderPresetId,
      requestedTeammateId: input.requestedTeammateId,
    });
    return {
      routeDecisionId: route.decisionId,
      aiReply: await input.createAiReply({
        store: input.store,
        channel: input.channel,
        sourceMessage: input.sourceMessage,
        providerPresetId: route.action === "reply" ? route.providerPresetId ?? input.requestedProviderPresetId : input.requestedProviderPresetId,
        teammateId: route.action === "reply" ? route.teammateId : input.requestedTeammateId,
        proposalMode: "allow",
      }),
    };
  }

  const workflowIntent = await selectChannelWorkflowIntent({
    store: input.store,
    channel: input.channel,
    sourceMessage: input.sourceMessage,
    requestedProviderPresetId: input.requestedProviderPresetId,
    secretResolver: input.routeDependencies.secretResolver,
    config: input.config,
    runnerRegistry: input.routeDependencies.runnerRegistry,
  });
  if (workflowIntent.action === "no_reply" || workflowIntent.action === "workflow_proposal") {
    return {};
  }
  if (workflowIntent.action === "visible_multi_reply") {
    const aiReplies = workflowIntent.aiReplies ?? await Promise.all(workflowIntent.teammateIds.map((teammateId) => input.createAiReply({
      store: input.store,
      channel: input.channel,
      sourceMessage: input.sourceMessage,
      providerPresetId: input.requestedProviderPresetId,
      teammateId,
      proposalMode: "disabled",
      channelParallelLimit: workflowIntent.teammateIds.length,
      visibleParticipantTeammateIds: workflowIntent.teammateIds,
    })));
    if (!workflowIntent.intentDecisionId) {
      input.store.createChannelIntentDecision({
        channelId: input.channel.id,
        sourceMessageId: input.sourceMessage.id,
        action: "visible_multi_reply",
        selectedTeammateIds: workflowIntent.teammateIds,
        replyMessageIds: aiReplies.map((reply) => reply.id),
        reason: workflowIntent.reason,
        status: "accepted",
        createdBy: workflowIntent.createdBy,
      }, new Date().toISOString());
    }
    return { aiReply: aiReplies[0], aiReplies };
  }
  if (workflowIntent.action === "clarify") {
    return { aiReply: workflowIntent.aiReply };
  }

  const route = await routeChannelMessageReply({
    ...input.routeDependencies,
    store: input.store,
    channel: input.channel,
    sourceMessage: input.sourceMessage,
    requestedProviderPresetId: input.requestedProviderPresetId,
    requestedTeammateId: input.requestedTeammateId,
  });
  if (route.action !== "reply") {
    return { routeDecisionId: route.decisionId };
  }
  return {
    routeDecisionId: route.decisionId,
    aiReply: await input.createAiReply({
      store: input.store,
      channel: input.channel,
      sourceMessage: input.sourceMessage,
      providerPresetId: route.providerPresetId ?? input.requestedProviderPresetId,
      teammateId: route.teammateId,
      proposalMode: "disabled",
    }),
  };
}

function maybeHandleActiveSessionMessage(input: LingAgentChannelMessageInput): LingAgentChannelMessageResult | undefined {
  if (!canTreatAsActiveSessionInput(input.sourceMessage)) {
    return undefined;
  }
  const text = normalizeWhitespace(input.sourceMessage.body);
  if (!text) {
    return undefined;
  }
  const activeRun = findActiveSessionRun(input.store, input.channel.id);
  if (!activeRun) {
    return undefined;
  }
  if (looksLikeInterruptRedirect(text)) {
    return {
      activeSessionAction: {
        mode: "interrupt_redirect",
        status: "requires_confirmation",
        sourceRunId: activeRun.id,
        instruction: text,
      },
    };
  }
  if (!looksLikeQueuedFollowUp(text)) {
    return undefined;
  }
  const now = new Date().toISOString();
  const intervention = input.store.createRunIntervention({
    sourceRunId: activeRun.id,
    sourceWorkUnitId: activeRun.workUnitId,
    mode: "queue_followup",
    instruction: text,
    requestedBy: "local-user",
    idempotencyKey: `channel_message:${input.sourceMessage.id}:queue_followup`,
  }, now);
  appendRunInterventionEvent(input.store, activeRun.id, "run_intervention_created", {
    interventionId: intervention.id,
    mode: intervention.mode,
    status: intervention.status,
  });
  appendRunInterventionEvent(input.store, activeRun.id, "run_followup_queued", {
    interventionId: intervention.id,
    instruction: intervention.instruction,
  });
  return {
    intervention,
    activeSessionAction: {
      mode: "queue_followup",
      status: "created",
      sourceRunId: activeRun.id,
      interventionId: intervention.id,
      instruction: intervention.instruction,
    },
  };
}

function canTreatAsActiveSessionInput(message: ChannelMessage): boolean {
  return message.authorType === "local-user" && message.kind === "message" && message.intent === "discuss";
}

function findActiveSessionRun(store: RunStore, channelId: string): RunSession | undefined {
  const session = buildLingAgentSessionViewForChannel({ store, channelId });
  if (!session.activeRunId) {
    return undefined;
  }
  const run = store.getRun(session.activeRunId);
  if (!run || !isActiveRunStatus(run.status)) {
    return undefined;
  }
  return run;
}

function isActiveRunStatus(status: RunSession["status"]): boolean {
  return status === "queued" || status === "running" || status === "waiting_for_approval";
}

function looksLikeQueuedFollowUp(text: string): boolean {
  if (/(完成后|结束后|跑完|做完|之后|随后|接着|顺便|另外|同时|记得|回头|after (that|this|it)|when (you|this|it).*(done|finishes|finished)|also|follow-?up|then|next)/iu.test(text)) {
    return true;
  }
  return /(也|再)/iu.test(text) && /(更新|修改|检查|验证|跑|补|添加|追加|实现|修复|review|update|check|verify|run|add|append|fix)/iu.test(text);
}

function looksLikeInterruptRedirect(text: string): boolean {
  return /(停|停止|先别|别继续|不要继续|取消当前|打断|中断|改用|换成|stop|cancel|interrupt|redirect|use .* instead|switch to)/iu.test(text);
}

function appendRunInterventionEvent(store: RunStore, runId: string, type: "run_intervention_created" | "run_followup_queued", data: unknown): void {
  try {
    store.appendEvent(runId, type, data);
  } catch {
    // The intervention row is authoritative; run events are audit hints.
  }
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}
