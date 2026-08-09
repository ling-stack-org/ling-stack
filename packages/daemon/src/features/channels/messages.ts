import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { ChannelMessageStreamReplyPendingEvent, ChannelReplyDispatch, ChannelReplyDisposition } from "@ling-stack/contracts";
import {
  projectConversationItemToChannelMessage,
  type Channel,
  type ChannelExecutionProposal,
  type ChannelMessage,
  type ChannelWorkflow,
  type ChannelWorkflowStep,
  type RunSession,
  type RunStore,
} from "@ling-stack/core";
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
import { buildLingAgentTurnEnvelope, type LingAgentTurnEnvelope } from "./ling-agent-turn-envelope.js";
import {
  queueChannelReplyFollowup,
  resolveChannelReplyTargetTeammateId,
} from "./channel-reply-dispatch.js";
import type { ChannelReplyDispatchCoordinator } from "./channel-reply-dispatch-coordinator.js";
import {
  acquireChannelReplyLane,
  createLaneTrackedAiReply,
  type CreateChannelAiReply,
} from "./channel-reply-dispatch-lane.js";
import { resolveChannelConversationThread } from "./conversation-thread-resolution.js";
import {
  listChannelMessageViewsPage,
  updatePendingAssistantMessage,
} from "./conversation-item-messages.js";
import { assignContextSegmentForTurn } from "./context-processing/context-segmentation-policy.js";
import { createModelContextSegmentProposer } from "./context-processing/context-segmentation-model.js";
import { buildConversationContextProjection } from "./context-processing/conversation-context-projector.js";
import { filterQueuedChannelReplyMessages } from "./channel-reply-message-visibility.js";
import { materializeInlineChannelInputs } from "./materialization/inline.js";
import { createProviderBackedImageVisionSummarizer } from "./materialization/provider-vision.js";
import type { LingImageVisionSummarizer } from "./materialization/registry.js";
import { validateChannelMessageReferences } from "./protocol.js";
import { parseChannelMessageRequest } from "./schemas.js";
import {
  enrichChannelMessageWithWebEvidence,
  enrichChannelMessagesWithWebEvidence,
} from "../web/message-web-evidence.js";
import {
  buildConversationSupersessionProjection,
  filterSupersededChannelMessages,
  projectChannelMessageRevisionMetadata,
} from "../conversations/supersession-projection.js";
import { projectConversationActiveReplyTarget } from "../conversations/active-reply-target.js";
import { resolveChannelReplyExecutionTarget } from "./channel-reply-execution-target.js";
import { resolveProviderContextBudget } from "./context-packs.js";
import { createModelConversationSummaryGenerator } from "./context-processing/conversation-summary-model.js";
import {
  executeConversationSummaryPlan,
  planConversationContextSummary,
  type ConversationSummaryPlan,
  type GenerateConversationSummary,
} from "./context-processing/conversation-summary-coordinator.js";

const inFlightConversationSummaries = new Map<string, Promise<void>>();

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
  readonly explicitContextSegmentId?: string;
  readonly requestAiReply: boolean;
  readonly replyDisposition?: ChannelReplyDisposition;
  readonly createAiReply: CreateChannelAiReply;
  readonly startExecutionProposalWorkflow?: StartChannelExecutionProposalWorkflow;
  readonly config: ResolvedDaemonConfig;
  readonly routeDependencies: Omit<ChannelMessageRouteInput, "store" | "channel" | "sourceMessage" | "requestedProviderPresetId" | "requestedTeammateId">;
  readonly imageVisionSummarizer?: LingImageVisionSummarizer;
  readonly replyDispatchCoordinator?: ChannelReplyDispatchCoordinator;
  readonly onReplyPending?: (pending: ChannelMessageStreamReplyPendingEvent) => void;
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
  replyDispatchCoordinator?: ChannelReplyDispatchCoordinator,
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
    const message = persistChannelUserMessage({
      store,
      channel,
      input,
      requestIdempotencyKey: readIdempotencyKey(request),
      now,
    });
    const releaseMessageClassification = beginChannelMessageClassification(
      replyDispatchCoordinator,
      message,
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
        explicitContextSegmentId: input.contextSegmentId,
        requestAiReply: Boolean(input.requestAiReply),
        replyDisposition: input.replyDisposition,
        createAiReply: async (replyInput) =>
          await createAiReply({
            ...replyInput,
            completionMode: "inline",
            stream: {
              onReady: (aiReply) => {
                const aiReplies = upsertAiReply(aiReply);
                safeWriteSse("ready", { message, aiReply, aiReplies });
              },
              onRunLinked: (aiReply) => {
                upsertAiReply(aiReply);
                if (aiReply.linkedRunId) {
                  const activeReply = projectConversationActiveReplyTarget({
                    store,
                    runId: aiReply.linkedRunId,
                    channelId,
                    teammateId: aiReply.authorType === "ai-teammate" ? aiReply.authorId : undefined,
                  });
                  safeWriteSse("run_linked", {
                    messageId: aiReply.id,
                    linkedRunId: aiReply.linkedRunId,
                    ...(activeReply ? { activeReply } : {}),
                  });
                }
              },
              onDelta: (aiReply, delta) => {
                upsertAiReply(aiReply);
                safeWriteSse("delta", { messageId: aiReply.id, delta, body: aiReply.body });
              },
              onDone: (aiReply) => {
                upsertAiReply(enrichChannelMessageWithWebEvidence(store, aiReply));
              },
              onBlocked: (aiReply) => {
                upsertAiReply(enrichChannelMessageWithWebEvidence(store, aiReply));
              },
            },
          }),
        startExecutionProposalWorkflow,
        config,
        routeDependencies,
        imageVisionSummarizer,
        replyDispatchCoordinator,
        onReplyPending: (pending) => {
          releaseMessageClassification();
          safeWriteSse("reply_pending", pending);
        },
      });
      releaseMessageClassification();

      if (result.routeDecisionId && result.aiReply) {
        store.updateChannelMessageRouteDecision(result.routeDecisionId, {
          replyMessageId: result.aiReply.id,
        }, new Date().toISOString());
      }

      const rawAiReplies = result.aiReplies?.length
        ? result.aiReplies
        : result.aiReply
          ? [result.aiReply]
          : Array.from(aiRepliesById.values());
      const aiReplies = enrichChannelMessagesWithWebEvidence(store, rawAiReplies);
      for (const aiReply of aiReplies) {
        upsertAiReply(aiReply);
      }
      const aiReply = result.aiReply
        ? aiReplies.find((reply) => reply.id === result.aiReply?.id) ?? enrichChannelMessageWithWebEvidence(store, result.aiReply)
        : undefined;
      const streamPayload = {
        message,
        ...(aiReply ? { aiReply } : {}),
        ...(aiReplies.length > 0 ? { aiReplies } : {}),
        ...(result.replyDispatch ? { replyDispatch: result.replyDispatch } : {}),
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
      releaseMessageClassification();
      const aiReplies = Array.from(aiRepliesById.values());
      safeWriteSse("error", {
        message,
        ...(aiReplies[0] ? { aiReply: aiReplies[0] } : {}),
        ...(aiReplies.length > 0 ? { aiReplies } : {}),
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      releaseMessageClassification();
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

interface LingAgentChannelMessageResult {
  readonly aiReply?: ChannelMessage;
  readonly aiReplies?: readonly ChannelMessage[];
  readonly routeDecisionId?: string;
  readonly replyDispatch?: ChannelReplyDispatch;
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
  replyDispatchCoordinator?: ChannelReplyDispatchCoordinator,
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
      const thread = resolveChannelConversationThread({
        store,
        channel,
        surfaceRefId: url.searchParams.get("threadId") ?? undefined,
        now: new Date().toISOString(),
      });
      const page = listChannelMessageViewsPage({
        store,
        channelId,
        threadId: thread.id,
        beforeItemId: url.searchParams.get("beforeMessageId") ?? undefined,
        limit: readOptionalIntegerQuery(url, "limit", 1),
      });
      const visibleMessages = url.searchParams.get("includeSuperseded") === "true"
        ? page.messages
        : filterSupersededChannelMessages(page.messages, buildConversationSupersessionProjection(store, {
            surfaces: ["channel_root", "channel_branch", "topic_reply"],
            ownerId: channelId,
          }));
      const messages = enrichChannelMessagesWithWebEvidence(
        store,
        filterQueuedChannelReplyMessages(
          store,
          visibleMessages,
          (message) => Boolean(replyDispatchCoordinator?.isMessageClassificationPending(
            message.workspaceId,
            message.id,
          )),
        )
          .map((message) => projectChannelMessageRevisionMetadata(store, message)),
      );
      writeJson(response, 200, {
        cwd,
        channelId,
        messages,
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
      const message = persistChannelUserMessage({
        store,
        channel,
        input,
        requestIdempotencyKey: readIdempotencyKey(request),
        now,
      });
      const releaseMessageClassification = beginChannelMessageClassification(
        replyDispatchCoordinator,
        message,
      );
      let result: LingAgentChannelMessageResult;
      try {
        result = await handleLingAgentChannelMessage({
          store,
          channel,
          sourceMessage: message,
          requestedProviderPresetId: input.providerPresetId,
          requestedTeammateId: input.teammateId,
          explicitContextSegmentId: input.contextSegmentId,
          requestAiReply: Boolean(input.requestAiReply),
          replyDisposition: input.replyDisposition,
          createAiReply,
          startExecutionProposalWorkflow,
          config,
          routeDependencies,
          imageVisionSummarizer,
          replyDispatchCoordinator,
          onReplyPending: releaseMessageClassification,
        });
      } finally {
        releaseMessageClassification();
      }

      if (result.routeDecisionId && result.aiReply) {
        store.updateChannelMessageRouteDecision(result.routeDecisionId, {
          replyMessageId: result.aiReply.id,
        }, new Date().toISOString());
      }
      const aiReply = result.aiReply ? enrichChannelMessageWithWebEvidence(store, result.aiReply) : undefined;
      const aiReplies = result.aiReplies ? enrichChannelMessagesWithWebEvidence(store, result.aiReplies) : undefined;

      writeJson(response, 201, {
        message,
        ...(aiReply ? { aiReply } : {}),
        ...(aiReplies ? { aiReplies } : {}),
        ...(result.replyDispatch ? { replyDispatch: result.replyDispatch } : {}),
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
  const modelProposer = createModelContextSegmentProposer({
    store: input.store,
    channel: input.channel,
    runnerRegistry: input.routeDependencies.runnerRegistry,
    secretResolver: input.routeDependencies.secretResolver,
    requestedProviderPresetId: input.requestedProviderPresetId,
  });
  await assignContextSegmentForTurn({
    store: input.store,
    sourceItemId: input.sourceMessage.id,
    explicitSegmentId: input.explicitContextSegmentId,
    propose: modelProposer
      ? async (view) => {
          try {
            return await modelProposer(view);
          } catch {
            return {
              action: "uncertain" as const,
              candidateSegmentIds: view.candidates.map((candidate) => candidate.segmentId),
            };
          }
        }
      : undefined,
    now: new Date().toISOString(),
  });
  const targetTeammateId = resolveChannelReplyTargetTeammateId({
    store: input.store,
    sourceMessage: input.sourceMessage,
    requestedTeammateId: input.requestedTeammateId,
  });
  const summaryProviderPresetId = resolveChannelReplyExecutionTarget({
    store: input.store,
    channel: input.channel,
    requestedTeammateId: targetTeammateId,
    requestedProviderPresetId: input.requestedProviderPresetId,
  }).providerPresetId;
  let summaryPlan = prepareConversationSummaryPlan(input, summaryProviderPresetId);
  const summaryGenerator = createModelConversationSummaryGenerator({
    store: input.store,
    channel: input.channel,
    runnerRegistry: input.routeDependencies.runnerRegistry,
    secretResolver: input.routeDependencies.secretResolver,
    requestedProviderPresetId: summaryProviderPresetId,
  });
  if (summaryPlan?.trigger === "hard") {
    const summaryKey = conversationSummaryPlanKey(input.store, summaryPlan);
    await inFlightConversationSummaries.get(summaryKey);
    summaryPlan = prepareConversationSummaryPlan(input, summaryProviderPresetId);
    if (summaryPlan?.trigger === "hard") {
      await executeConversationSummaryPlanOnce(input.store, summaryPlan, summaryGenerator);
    }
  }
  const lane = await acquireChannelReplyLane({
    coordinator: input.replyDispatchCoordinator,
    store: input.store,
    sourceMessage: input.sourceMessage,
    channelId: input.channel.id,
    replyDisposition: input.replyDisposition,
  });
  if (!lane.activeRun && canDispatchChannelReply(input.sourceMessage)) {
    notifyReplyPending(input.onReplyPending, {
      sourceMessageId: input.sourceMessage.id,
      targetTeammateId,
      startedAt: new Date().toISOString(),
    });
  }
  const trackedReply = createLaneTrackedAiReply({
    createAiReply: input.createAiReply,
    owner: lane.owner,
    store: input.store,
    teammateId: targetTeammateId,
  });
  try {
    return await dispatchLingAgentChannelMessage(
      input,
      targetTeammateId,
      lane.activeRun,
      trackedReply.createAiReply,
    );
  } finally {
    trackedReply.releaseIfUnused();
    if (summaryPlan?.trigger === "soft") {
      void executeConversationSummaryPlanOnce(input.store, summaryPlan, summaryGenerator);
    }
  }
}

function executeConversationSummaryPlanOnce(
  store: RunStore,
  plan: ConversationSummaryPlan,
  generate: GenerateConversationSummary | undefined,
): Promise<void> {
  const key = conversationSummaryPlanKey(store, plan);
  const existing = inFlightConversationSummaries.get(key);
  if (existing) return existing;
  const execution = executeConversationSummaryPlan({ store, plan, generate })
    .then(() => undefined)
    .catch(() => undefined)
    .finally(() => {
      if (inFlightConversationSummaries.get(key) === execution) {
        inFlightConversationSummaries.delete(key);
      }
    });
  inFlightConversationSummaries.set(key, execution);
  return execution;
}

function conversationSummaryPlanKey(store: RunStore, plan: ConversationSummaryPlan): string {
  return `${store.paths.databasePath}:${plan.projection.metadata.threadId}:${plan.projection.metadata.segmentId}`;
}

function prepareConversationSummaryPlan(
  input: LingAgentChannelMessageInput,
  providerPresetId: string | undefined,
): ConversationSummaryPlan | undefined {
  try {
    const providerPreset = providerPresetId ? input.store.getProviderPreset(providerPresetId) : undefined;
    const budget = resolveProviderContextBudget(providerPreset, "channel_reply");
    return planConversationContextSummary({
      store: input.store,
      sourceItemId: input.sourceMessage.id,
      inputBudgetTokens: budget.inputBudgetTokens,
    });
  } catch {
    return undefined;
  }
}

async function dispatchLingAgentChannelMessage(
  input: LingAgentChannelMessageInput,
  targetTeammateId: string,
  activeReplyRun: RunSession | undefined,
  createAiReply: CreateChannelAiReply,
): Promise<LingAgentChannelMessageResult> {
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
  if (
    input.replyDisposition?.mode === "queue_followup" &&
    activeReplyRun &&
    canDispatchChannelReply(input.sourceMessage) &&
    hasChannelReplyPayload(input.sourceMessage, turnEnvelope)
  ) {
    const replyDispatch = queueChannelReplyFollowup({
      store: input.store,
      activeRun: activeReplyRun,
      sourceMessage: input.sourceMessage,
      targetTeammateId,
      turnEnvelope,
    });
    return { replyDispatch };
  }

  if (targetTeammateId !== LING_AGENT_EXECUTOR_ID) {
    const route = routeExplicitChannelMention({
      ...input.routeDependencies,
      store: input.store,
      channel: input.channel,
      sourceMessage: input.sourceMessage,
      turnEnvelope,
      requestedProviderPresetId: input.requestedProviderPresetId,
      requestedTeammateId: targetTeammateId,
    });
    return {
      routeDecisionId: route.decisionId,
      aiReply: await createAiReply({
        store: input.store,
        channel: input.channel,
        sourceMessage: input.sourceMessage,
        turnEnvelope,
        providerPresetId: route.action === "reply" ? route.providerPresetId ?? input.requestedProviderPresetId : input.requestedProviderPresetId,
        teammateId: targetTeammateId,
        proposalMode: "allow",
      }),
      replyDispatch: {
        targetTeammateId,
        disposition: "reply_requested",
      },
    };
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
    const typedExecution = input.store.getChannelIntentDecision(workflowIntent.intentDecisionId)?.execution
      ?? { kind: "run_command" as const, targetKind: "workspace" as const };
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
        coordinatorReply = updatePendingAssistantMessage({
          store: input.store,
          itemId: coordinatorReply.id,
          body: coordinatorWorkflowStartBody(autoStartedWorkflow.proposal, input.sourceMessage),
          status: "ready",
          now: new Date().toISOString(),
        });
        persistChannelIntentDecision(input.store, input.channel, input.sourceMessage, {
          action: "execute",
          proposalId: autoStartedWorkflow.proposal.id,
          workflowId: autoStartedWorkflow.workflow.id,
          resultItemIds: [coordinatorReply.id],
          execution: typedExecution,
          reason: `Ling Agent Session auto-started proposal ${autoStartedWorkflow.proposal.id}. ${autoStartDecision.reason}`,
          status: "accepted",
          createdBy: "deterministic",
        });
        return { aiReply: coordinatorReply, autoStartedWorkflow };
      } catch (error) {
        coordinatorReply = updatePendingAssistantMessage({
          store: input.store,
          itemId: coordinatorReply.id,
          body: coordinatorWorkflowStartFailedBody(workflowIntent.proposal, error),
          status: "failed",
          errorMessage: error instanceof Error ? error.message : String(error),
          now: new Date().toISOString(),
        });
        persistChannelIntentDecision(input.store, input.channel, input.sourceMessage, {
          action: "execute",
          proposalId: workflowIntent.proposal.id,
          resultItemIds: [coordinatorReply.id],
          execution: typedExecution,
          reason: `Ling Agent Session auto-start failed; proposal remains available for confirmation. ${autoStartDecision.reason}`,
          status: "failed",
          createdBy: "deterministic",
          errorCode: "auto_start_failed",
        });
        return { aiReply: coordinatorReply };
      }
    }
    if (!autoStartDecision.allowed && autoStartDecision.blockReason === "tool_denied") {
      persistChannelIntentDecision(input.store, input.channel, input.sourceMessage, {
        action: "execute",
        proposalId: workflowIntent.proposal.id,
        execution: typedExecution,
        reason: `Ling Agent Session auto-start blocked by approval policy. ${autoStartDecision.reason}`,
        status: "failed",
        createdBy: "deterministic",
        errorCode: "tool_denied",
      });
    }
    return {};
  }
  if (workflowIntent.action === "visible_multi_reply") {
    if (input.sourceMessage.mentions.filter((mention) => mention.kind === "ai-teammate").length > 1) {
      return {
        aiReply: await createAiReply({
          store: input.store,
          channel: input.channel,
          sourceMessage: input.sourceMessage,
          turnEnvelope,
          providerPresetId: input.requestedProviderPresetId,
          teammateId: LING_AGENT_EXECUTOR_ID,
          proposalMode: "allow",
        }),
        replyDispatch: {
          targetTeammateId: LING_AGENT_EXECUTOR_ID,
          disposition: "reply_requested",
        },
      };
    }
    const aiReplies = workflowIntent.aiReplies ?? await Promise.all(workflowIntent.teammateIds.map((teammateId) => createAiReply({
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
      persistChannelIntentDecision(input.store, input.channel, input.sourceMessage, {
        action: "visible_multi_reply",
        selectedTeammateIds: workflowIntent.teammateIds,
        resultItemIds: aiReplies.map((reply) => reply.id),
        reason: workflowIntent.reason,
        status: "accepted",
        createdBy: workflowIntent.createdBy,
      });
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
      requestedTeammateId: targetTeammateId,
    });
    return {
      routeDecisionId: route.decisionId,
      aiReply: await createAiReply({
        store: input.store,
        channel: input.channel,
        sourceMessage: input.sourceMessage,
        turnEnvelope,
        providerPresetId: route.action === "reply" ? route.providerPresetId ?? input.requestedProviderPresetId : input.requestedProviderPresetId,
        teammateId: route.action === "reply" ? route.teammateId : targetTeammateId,
        proposalMode: "allow",
      }),
      replyDispatch: {
        targetTeammateId: route.action === "reply" ? route.teammateId : targetTeammateId,
        disposition: "reply_requested",
      },
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
    aiReply: await createAiReply({
      store: input.store,
      channel: input.channel,
      sourceMessage: input.sourceMessage,
      turnEnvelope,
      providerPresetId: route.providerPresetId ?? input.requestedProviderPresetId,
      teammateId: route.teammateId,
      proposalMode: "disabled",
    }),
    replyDispatch: {
      targetTeammateId: route.teammateId ?? LING_AGENT_EXECUTOR_ID,
      disposition: "reply_requested",
    },
  };
}

function createCoordinatorWorkflowStartReply(input: {
  readonly store: RunStore;
  readonly channel: Channel;
  readonly sourceMessage: ChannelMessage;
  readonly proposal: ChannelExecutionProposal;
}): ChannelMessage {
  const now = new Date().toISOString();
  const sourceItem = input.store.getConversationItem(input.sourceMessage.id);
  if (!sourceItem?.turnId || sourceItem.channelId !== input.channel.id) {
    throw new Error(`Coordinator reply source item has no owning turn: ${input.sourceMessage.id}`);
  }
  const item = input.store.appendConversationItem({
    channelId: input.channel.id,
    threadId: sourceItem.threadId,
    turnId: sourceItem.turnId,
    kind: "assistant_message",
    status: "pending",
    actorType: "ling_agent",
    actorId: LING_AGENT_EXECUTOR_ID,
    visibility: "channel",
    payload: {
      body: coordinatorWorkflowStartBody(input.proposal, input.sourceMessage),
      format: "markdown",
      streaming: true,
      deliveryStatus: "pending",
    },
    domainRefs: [{ type: "conversation_item", id: sourceItem.id }],
  }, now);
  return projectConversationItemToChannelMessage(item);
}

function coordinatorWorkflowStartBody(
  proposal: ChannelExecutionProposal,
  sourceMessage: ChannelMessage,
): string {
  const title = proposal.title.trim() || sourceMessage.body.trim() || "this task";
  if (proposal.responseLanguage === "en-US") {
    return `Confirmed: "${title}". Starting now.`;
  }
  return `确认需求：「${title}」。开始处理。`;
}

function coordinatorWorkflowStartFailedBody(proposal: ChannelExecutionProposal, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (proposal.responseLanguage === "en-US") {
    return `I tried to start this workflow, but it was blocked before execution: ${message}`;
  }
  return `我尝试开始这次 workflow，但执行前被阻塞：${message}`;
}

function persistChannelIntentDecision(
  store: RunStore,
  channel: Channel,
  sourceMessage: ChannelMessage,
  decision: Omit<Parameters<RunStore["createChannelIntentDecision"]>[0], "channelId" | "sourceItemId" | "contextProjection">,
): void {
  const projection = buildConversationContextProjection({
    store,
    sourceItemId: sourceMessage.id,
    view: "selector",
  });
  store.createChannelIntentDecision({
    ...decision,
    channelId: channel.id,
    sourceItemId: sourceMessage.id,
    contextProjection: projection.metadata,
  }, new Date().toISOString());
}

function canDispatchChannelReply(message: ChannelMessage): boolean {
  return message.authorType === "local-user" && message.kind === "message" && message.intent === "discuss";
}

function beginChannelMessageClassification(
  coordinator: ChannelReplyDispatchCoordinator | undefined,
  message: ChannelMessage,
): () => void {
  if (!coordinator || !canDispatchChannelReply(message)) {
    return () => undefined;
  }
  return coordinator.beginMessageClassification(message.workspaceId, message.id);
}

function hasChannelReplyPayload(message: ChannelMessage, turnEnvelope: LingAgentTurnEnvelope): boolean {
  return Boolean(
    message.body.trim() ||
    turnEnvelope.attachments.length ||
    turnEnvelope.linkPreviews.length ||
    turnEnvelope.fileRefs.length
  );
}

function notifyReplyPending(
  callback: ((pending: ChannelMessageStreamReplyPendingEvent) => void) | undefined,
  pending: ChannelMessageStreamReplyPendingEvent,
): void {
  try {
    callback?.(pending);
  } catch {
    // Dispatch remains authoritative if an SSE observer disconnects after message acceptance.
  }
}

function persistChannelUserMessage(input: {
  readonly store: RunStore;
  readonly channel: Channel;
  readonly input: import("./schemas.js").ChannelMessageRequest;
  readonly requestIdempotencyKey?: string;
  readonly now: string;
}): ChannelMessage {
  if (input.input.authorType !== "local-user" || (input.input.kind && input.input.kind !== "message")) {
    throw new Error("Channel message ingest accepts local-user messages only");
  }
  const thread = resolveChannelConversationThread({
    store: input.store,
    channel: input.channel,
    surfaceRefId: input.input.threadId,
    now: input.now,
  });
  const anchor = input.input.threadId ? input.store.getConversationItem(input.input.threadId) : undefined;
  const result = input.store.appendConversationUserTurn({
    channelId: input.channel.id,
    threadId: thread.id,
    turnKind: input.input.replyDisposition?.mode === "queue_followup"
      ? "queued_followup"
      : thread.nextItemSequence > 1
        ? "manual_followup"
        : "initial_request",
    title: channelTurnTitle(input.input.body),
    userInstruction: input.input.body || "Channel input with materialized references.",
    ...(input.input.authorId ? { actorId: input.input.authorId } : {}),
    payload: {
      body: input.input.body,
      format: "plain_text",
      mentions: input.input.mentions.map((mention) => ({
        id: mention.id,
        label: mention.label,
        kind: mention.kind === "ai-teammate"
          ? "ai_teammate" as const
          : mention.kind === "local-user"
            ? "local_user" as const
            : "channel" as const,
      })),
      attachmentIds: input.input.attachmentIds,
      linkPreviewIds: input.input.linkPreviewIds,
      fileRefs: input.input.fileRefs,
      ...(anchor ? { replyToItemId: anchor.id } : {}),
    },
    domainRefs: [
      ...(input.input.linkedTaskId ? [{ type: "task" as const, id: input.input.linkedTaskId }] : []),
      ...(input.input.linkedRunId ? [{ type: "run" as const, id: input.input.linkedRunId }] : []),
    ],
    ...(input.input.replyDisposition?.activeRunId && input.store.getLingTurnForRun(input.input.replyDisposition.activeRunId)
      ? { sourceTurnId: input.store.getLingTurnForRun(input.input.replyDisposition.activeRunId)!.id }
      : {}),
    idempotencyKey: input.input.idempotencyKey
      ?? input.requestIdempotencyKey
      ?? `channel-request:${randomUUID()}`,
  }, input.now);
  return projectConversationItemToChannelMessage(result.item);
}

function readIdempotencyKey(request: IncomingMessage): string | undefined {
  const value = request.headers["idempotency-key"];
  return Array.isArray(value) ? value[0] : value;
}

function channelTurnTitle(body: string): string {
  const compact = body.replace(/\s+/gu, " ").trim();
  return compact ? compact.slice(0, 160) : "Channel input";
}
