import type { IncomingMessage, ServerResponse } from "node:http";
import type { Channel, ChannelExecutionProposal, ChannelMessage, ChannelWorkflow, ChannelWorkflowStep, RunIntervention, RunInterventionMessagePayload, RunSession, RunStore } from "@ling-stack/core";
import type { ResolvedDaemonConfig } from "../../config.js";
import { HttpError } from "../../errors.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { readJsonBody, readOptionalIntegerQuery } from "../../shared/request.js";
import { writeJson, writeSse, writeSseHead } from "../../shared/response.js";
import {
  routeChannelMessageReply,
  routeExplicitChannelMention,
  type ChannelMessageRouteInput,
} from "./channel-message-router.js";
import { selectChannelWorkflowIntent } from "./channel-intent-selector.js";
import { decideLingAgentAutoStart, type LingAutoStartDecision } from "./ling-agent-auto-start.js";
import { LING_AGENT_EXECUTOR_ID } from "./ling-agent-executor.js";
import { buildLingAgentSessionViewForChannel } from "./ling-agent-session-view.js";
import { buildLingAgentTurnEnvelope, type LingAgentTurnEnvelope } from "./ling-agent-turn-envelope.js";
import { materializeInlineChannelInputs } from "./materialization/inline.js";
import { createProviderBackedImageVisionSummarizer } from "./materialization/provider-vision.js";
import type { LingImageVisionSummarizer } from "./materialization/registry.js";
import { validateChannelMessageReferences } from "./protocol.js";
import { parseChannelMessageRequest } from "./schemas.js";

export type CreateChannelAiReply = (input: {
  readonly store: RunStore;
  readonly channel: Channel;
  readonly sourceMessage: ChannelMessage;
  readonly turnEnvelope?: LingAgentTurnEnvelope;
  readonly providerPresetId?: string;
  readonly teammateId?: string;
  readonly proposalMode?: "allow" | "disabled";
  readonly channelParallelLimit?: number;
  readonly visibleParticipantTeammateIds?: readonly string[];
  readonly completionMode?: "background" | "inline";
  readonly stream?: {
    readonly onReady: (message: ChannelMessage) => void;
    readonly onDelta: (message: ChannelMessage, delta: string) => void;
    readonly onDone: (message: ChannelMessage) => void;
    readonly onBlocked: (message: ChannelMessage) => void;
  };
}) => Promise<ChannelMessage>;

export type StartChannelExecutionProposalWorkflow = (input: {
  readonly store: RunStore;
  readonly proposalId: string;
  readonly autoStartDecision: LingAutoStartDecision;
}) => Promise<{
  readonly proposal: ChannelExecutionProposal;
  readonly workflow: ChannelWorkflow;
  readonly workflowSteps: readonly ChannelWorkflowStep[];
  readonly orchestration?: unknown;
}>;

interface LingAgentChannelMessageInput {
  readonly store: RunStore;
  readonly channel: Channel;
  readonly sourceMessage: ChannelMessage;
  readonly turnEnvelope?: LingAgentTurnEnvelope;
  readonly requestedProviderPresetId?: string;
  readonly requestedTeammateId?: string;
  readonly requestAiReply: boolean;
  readonly createAiReply: CreateChannelAiReply;
  readonly startExecutionProposalWorkflow?: StartChannelExecutionProposalWorkflow;
  readonly config: ResolvedDaemonConfig;
  readonly routeDependencies: Omit<ChannelMessageRouteInput, "store" | "channel" | "sourceMessage" | "requestedProviderPresetId" | "requestedTeammateId">;
  readonly imageVisionSummarizer?: LingImageVisionSummarizer;
}

export async function handleChannelMessageStream(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  channelId: string,
  createAiReply: CreateChannelAiReply,
  startExecutionProposalWorkflow: StartChannelExecutionProposalWorkflow | undefined,
  routeDependencies: Omit<ChannelMessageRouteInput, "store" | "channel" | "sourceMessage" | "requestedProviderPresetId" | "requestedTeammateId">,
  imageVisionSummarizer?: LingImageVisionSummarizer,
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
    if (request.method !== "POST") {
      writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for channel message stream` });
      return;
    }

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
        fileRefs: input.fileRefs,
        linkedTaskId: input.linkedTaskId,
        linkedRunId: input.linkedRunId,
      },
      now,
    );

    let closed = false;
    response.on("close", () => {
      closed = true;
    });
    const safeWriteSse = (event: string, data: unknown): void => {
      if (!closed && !response.destroyed) {
        writeSse(response, event, data);
      }
    };
    const aiRepliesById = new Map<string, ChannelMessage>();
    const upsertAiReply = (aiReply: ChannelMessage): readonly ChannelMessage[] => {
      aiRepliesById.set(aiReply.id, aiReply);
      return Array.from(aiRepliesById.values());
    };

    writeSseHead(response);
    safeWriteSse("ready", { message });
    try {
      const result = await handleLingAgentChannelMessage({
        store,
        channel,
        sourceMessage: message,
        requestedProviderPresetId: input.providerPresetId,
        requestedTeammateId: input.teammateId,
        requestAiReply: Boolean(input.requestAiReply),
        createAiReply: async (replyInput) =>
          await createAiReply({
            ...replyInput,
            completionMode: "inline",
            stream: {
              onReady: (aiReply) => {
                const aiReplies = upsertAiReply(aiReply);
                safeWriteSse("ready", { message, aiReply, aiReplies });
              },
              onDelta: (aiReply, delta) => {
                upsertAiReply(aiReply);
                safeWriteSse("delta", { messageId: aiReply.id, delta, body: aiReply.body });
              },
              onDone: (aiReply) => {
                upsertAiReply(aiReply);
              },
              onBlocked: (aiReply) => {
                upsertAiReply(aiReply);
              },
            },
          }),
        startExecutionProposalWorkflow,
        config,
        routeDependencies,
        imageVisionSummarizer,
      });

      if (result.routeDecisionId && result.aiReply) {
        store.updateChannelMessageRouteDecision(result.routeDecisionId, {
          replyMessageId: result.aiReply.id,
        }, new Date().toISOString());
      }

      const aiReplies = result.aiReplies?.length
        ? result.aiReplies
        : result.aiReply
          ? [result.aiReply]
          : Array.from(aiRepliesById.values());
      for (const aiReply of aiReplies) {
        upsertAiReply(aiReply);
      }
      const streamPayload = {
        message,
        ...(result.aiReply ? { aiReply: result.aiReply } : {}),
        ...(aiReplies.length > 0 ? { aiReplies } : {}),
        ...(result.autoStartedWorkflow ? { autoStartedWorkflow: result.autoStartedWorkflow } : {}),
      };
      const failedReply = aiReplies.find((reply) => reply.status === "failed");
      const blockedReply = aiReplies.find((reply) => reply.status === "blocked");
      if (failedReply) {
        safeWriteSse("error", { ...streamPayload, error: failedReply.errorMessage });
      } else if (blockedReply) {
        safeWriteSse("blocked", { ...streamPayload, error: blockedReply.errorMessage });
      } else {
        safeWriteSse("done", streamPayload);
      }
    } catch (error) {
      const aiReplies = Array.from(aiRepliesById.values());
      safeWriteSse("error", {
        message,
        ...(aiReplies[0] ? { aiReply: aiReplies[0] } : {}),
        ...(aiReplies.length > 0 ? { aiReplies } : {}),
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (!closed && !response.destroyed) {
        response.end();
      }
    }
  } catch (error) {
    if (response.headersSent) {
      response.end();
      return;
    }
    writeJson(response, error instanceof HttpError ? error.statusCode : 400, {
      error: error instanceof HttpError ? error.code : "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
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
  readonly autoStartedWorkflow?: Awaited<ReturnType<StartChannelExecutionProposalWorkflow>>;
}

export async function handleChannelMessagesCollection(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  channelId: string,
  createAiReply: CreateChannelAiReply,
  startExecutionProposalWorkflow: StartChannelExecutionProposalWorkflow | undefined,
  routeDependencies: Omit<ChannelMessageRouteInput, "store" | "channel" | "sourceMessage" | "requestedProviderPresetId" | "requestedTeammateId">,
  imageVisionSummarizer?: LingImageVisionSummarizer,
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
          fileRefs: input.fileRefs,
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
        startExecutionProposalWorkflow,
        config,
        routeDependencies,
        imageVisionSummarizer,
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
        ...(result.autoStartedWorkflow ? { autoStartedWorkflow: result.autoStartedWorkflow } : {}),
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
  const imageVisionSummarizer = input.imageVisionSummarizer ?? createProviderBackedImageVisionSummarizer({
    store: input.store,
    channel: input.channel,
    requestedProviderPresetId: input.requestedProviderPresetId,
    secretResolver: input.routeDependencies.secretResolver,
  });
  await materializeInlineChannelInputs({
    store: input.store,
    channel: input.channel,
    sourceMessage: input.sourceMessage,
    now: new Date().toISOString(),
    imageVisionSummarizer,
  });
  const turnEnvelope = buildLingAgentTurnEnvelope({
    store: input.store,
    channel: input.channel,
    sourceMessage: input.sourceMessage,
  });
  const envelopeInput = { ...input, turnEnvelope };

  const activeSession = maybeHandleActiveSessionMessage(envelopeInput);
  if (activeSession) {
    return activeSession;
  }

  const workflowIntent = await selectChannelWorkflowIntent({
    store: input.store,
    channel: input.channel,
    sourceMessage: input.sourceMessage,
    turnEnvelope,
    requestedProviderPresetId: input.requestedProviderPresetId,
    secretResolver: input.routeDependencies.secretResolver,
    config: input.config,
    runnerRegistry: input.routeDependencies.runnerRegistry,
  });
  if (workflowIntent.action === "workflow_proposal") {
    const autoStartDecision = decideLingAgentAutoStart({
      store: input.store,
      channel: input.channel,
      sourceMessage: input.sourceMessage,
      proposal: workflowIntent.proposal,
    });
    if (autoStartDecision.allowed && input.startExecutionProposalWorkflow) {
      let coordinatorReply = createCoordinatorWorkflowStartReply({
        store: input.store,
        channel: input.channel,
        sourceMessage: input.sourceMessage,
        proposal: workflowIntent.proposal,
      });
      try {
        const autoStartedWorkflow = await input.startExecutionProposalWorkflow({
          store: input.store,
          proposalId: workflowIntent.proposal.id,
          autoStartDecision,
        });
        input.store.createChannelIntentDecision({
          channelId: input.channel.id,
          sourceMessageId: input.sourceMessage.id,
          action: "direct_workflow",
          proposalId: autoStartedWorkflow.proposal.id,
          workflowId: autoStartedWorkflow.workflow.id,
          reason: `Ling Agent Session auto-started proposal ${autoStartedWorkflow.proposal.id}. ${autoStartDecision.reason}`,
          status: "accepted",
          createdBy: "deterministic",
        }, new Date().toISOString());
        return { aiReply: coordinatorReply, autoStartedWorkflow };
      } catch (error) {
        coordinatorReply = input.store.updateChannelMessageRuntime(
          coordinatorReply.id,
          {
            body: coordinatorWorkflowStartFailedBody(workflowIntent.proposal, error),
            status: "failed",
            errorMessage: error instanceof Error ? error.message : String(error),
          },
          new Date().toISOString(),
        ) ?? coordinatorReply;
        input.store.createChannelIntentDecision({
          channelId: input.channel.id,
          sourceMessageId: input.sourceMessage.id,
          action: "direct_workflow",
          proposalId: workflowIntent.proposal.id,
          reason: `Ling Agent Session auto-start failed; proposal remains available for confirmation. ${autoStartDecision.reason}`,
          status: "failed",
          createdBy: "deterministic",
          errorMessage: error instanceof Error ? error.message : String(error),
        }, new Date().toISOString());
        return { aiReply: coordinatorReply };
      }
    }
    if (!autoStartDecision.allowed && autoStartDecision.blockReason === "tool_denied") {
      input.store.createChannelIntentDecision({
        channelId: input.channel.id,
        sourceMessageId: input.sourceMessage.id,
        action: "direct_workflow",
        proposalId: workflowIntent.proposal.id,
        reason: `Ling Agent Session auto-start blocked by approval policy. ${autoStartDecision.reason}`,
        status: "failed",
        createdBy: "deterministic",
        errorMessage: autoStartDecision.reason,
      }, new Date().toISOString());
    }
    return {};
  }
  if (workflowIntent.action === "visible_multi_reply") {
    const aiReplies = workflowIntent.aiReplies ?? await Promise.all(workflowIntent.teammateIds.map((teammateId) => input.createAiReply({
      store: input.store,
      channel: input.channel,
      sourceMessage: input.sourceMessage,
      turnEnvelope,
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

  if (input.requestAiReply) {
    const route = routeExplicitChannelMention({
      ...input.routeDependencies,
      store: input.store,
      channel: input.channel,
      sourceMessage: input.sourceMessage,
      turnEnvelope,
      requestedProviderPresetId: input.requestedProviderPresetId,
      requestedTeammateId: input.requestedTeammateId,
    });
    return {
      routeDecisionId: route.decisionId,
      aiReply: await input.createAiReply({
        store: input.store,
        channel: input.channel,
        sourceMessage: input.sourceMessage,
        turnEnvelope,
        providerPresetId: route.action === "reply" ? route.providerPresetId ?? input.requestedProviderPresetId : input.requestedProviderPresetId,
        teammateId: route.action === "reply" ? route.teammateId : input.requestedTeammateId,
        proposalMode: "allow",
      }),
    };
  }

  const route = await routeChannelMessageReply({
    ...input.routeDependencies,
    store: input.store,
    channel: input.channel,
    sourceMessage: input.sourceMessage,
    turnEnvelope,
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
      turnEnvelope,
      providerPresetId: route.providerPresetId ?? input.requestedProviderPresetId,
      teammateId: route.teammateId,
      proposalMode: "disabled",
    }),
  };
}

function createCoordinatorWorkflowStartReply(input: {
  readonly store: RunStore;
  readonly channel: Channel;
  readonly sourceMessage: ChannelMessage;
  readonly proposal: ChannelExecutionProposal;
}): ChannelMessage {
  const now = new Date().toISOString();
  return input.store.createChannelMessage(
    {
      channelId: input.channel.id,
      threadId: input.sourceMessage.threadId ?? input.sourceMessage.id,
      kind: "ai_reply",
      intent: "discuss",
      authorType: "ai-teammate",
      authorId: LING_AGENT_EXECUTOR_ID,
      body: coordinatorWorkflowStartBody(input.proposal, input.sourceMessage),
      status: "ready",
    },
    now,
  );
}

function coordinatorWorkflowStartBody(
  proposal: ChannelExecutionProposal,
  sourceMessage: ChannelMessage,
): string {
  const title = proposal.title.trim() || sourceMessage.body.trim() || "this task";
  if (proposal.responseLanguage === "en-US") {
    return `I have enough context to start "${title}". I will keep the main thread focused on key status and the final result; files, checks, and run details stay in the folded evidence summary.`;
  }
  return `我已确认任务边界，开始处理「${title}」。我会在主会话同步关键状态和最终结果；具体文件、检查和运行细节放在折叠证据摘要里。`;
}

function coordinatorWorkflowStartFailedBody(proposal: ChannelExecutionProposal, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (proposal.responseLanguage === "en-US") {
    return `I tried to start this workflow, but it was blocked before execution: ${message}`;
  }
  return `我尝试开始这次 workflow，但执行前被阻塞：${message}`;
}

function maybeHandleActiveSessionMessage(input: LingAgentChannelMessageInput): LingAgentChannelMessageResult | undefined {
  if (!canTreatAsActiveSessionInput(input.sourceMessage)) {
    return undefined;
  }
  const text = normalizeWhitespace(input.sourceMessage.body);
  const activeRun = findActiveSessionRun(input.store, input.channel.id);
  if (!activeRun) {
    return undefined;
  }
  const hasGuidanceAssets = (input.turnEnvelope?.attachments.length ?? input.sourceMessage.attachmentIds.length) > 0 ||
    (input.turnEnvelope?.linkPreviews.length ?? input.sourceMessage.linkPreviewIds.length) > 0 ||
    (input.turnEnvelope?.fileRefs.length ?? input.sourceMessage.fileRefs.length) > 0;
  if (!text && !hasGuidanceAssets) {
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
  if (text && !looksLikeQueuedFollowUp(text)) {
    return undefined;
  }
  const instruction = text || "User added attachments, link previews, or workspace file refs for the active run.";
  const now = new Date().toISOString();
  const intervention = input.store.createRunIntervention({
    sourceRunId: activeRun.id,
    sourceWorkUnitId: activeRun.workUnitId,
    mode: "queue_followup",
    instruction,
    messagePayload: buildRunInterventionMessagePayload(text, input.sourceMessage, input.turnEnvelope),
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

function buildRunInterventionMessagePayload(
  body: string,
  sourceMessage: ChannelMessage,
  turnEnvelope: LingAgentTurnEnvelope | undefined,
): RunInterventionMessagePayload {
  return {
    body,
    attachmentIds: sourceMessage.attachmentIds,
    linkPreviewIds: sourceMessage.linkPreviewIds,
    ...(turnEnvelope?.attachments.length
      ? {
          attachments: turnEnvelope.attachments.map((attachment) => ({
            id: attachment.id,
            fileName: attachment.fileName,
            kind: attachment.kind,
            contentType: attachment.contentType,
            sizeBytes: attachment.sizeBytes,
            materializationStatus: attachment.materializationStatus,
            previewStatus: attachment.previewStatus,
            ...(attachment.previewText ? { previewText: attachment.previewText } : {}),
            ...(attachment.reason ? { reason: attachment.reason } : {}),
          })),
        }
      : {}),
    ...(turnEnvelope?.linkPreviews.length
      ? {
          linkPreviews: turnEnvelope.linkPreviews.map((preview) => ({
            id: preview.id,
            url: preview.url,
            normalizedUrl: preview.normalizedUrl,
            ...(preview.title ? { title: preview.title } : {}),
            ...(preview.description ? { description: preview.description } : {}),
            ...(preview.siteName ? { siteName: preview.siteName } : {}),
            status: preview.status,
            materializationStatus: preview.materializationStatus,
            ...(preview.previewText ? { previewText: preview.previewText } : {}),
            ...(preview.reason ? { reason: preview.reason } : {}),
          })),
        }
      : {}),
    ...(turnEnvelope?.fileRefs.length
      ? {
          fileRefs: turnEnvelope.fileRefs.map((ref) => ({
            path: ref.path,
            ...(ref.label ? { label: ref.label } : {}),
            rootRelation: ref.rootRelation,
            kind: ref.kind,
            materializationStatus: ref.materializationStatus,
            ...(ref.previewText ? { previewText: ref.previewText } : {}),
            ...(ref.blockedReason ? { blockedReason: ref.blockedReason } : {}),
          })),
        }
      : {}),
  };
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}
