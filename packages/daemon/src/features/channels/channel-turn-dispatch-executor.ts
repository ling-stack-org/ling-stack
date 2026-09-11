import type { ChannelTurnDispatchRequestV1, RunSession, RunStore } from "@ling-stack/core";
import type { ResolvedDaemonConfig } from "../../config.js";
import type { McpBroker } from "../../context.js";
import type { ActiveRunRegistry } from "../../runtime/active-runs.js";
import type { RunnerRegistry } from "../../runtime/runners.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import type { RuntimeSupervisor } from "../../runtime/supervisor.js";
import type { StartupStateRegistry } from "../../startup/state.js";
import type { ControlPlaneEventHub } from "../control-plane/events.js";
import type { ComputerUseProjectionRegistry } from "../computer-use/registry.js";
import {
  createDetachedRunExecutionSink,
  executeRunRequest,
  type RunExecutionSink,
} from "../runs/orchestrator.js";
import type { RunRequest } from "../runs/schemas.js";
import type { HostCapabilityBridgeController } from "../runs/host-capability-bridge-controller.js";
import { resolveProviderForRun } from "../runs/providers.js";
import { createAiChannelReply } from "./ai-replies.js";
import {
  findChannelAssistantReplyForSource,
  getChannelMessageView,
} from "./conversation-item-messages.js";
import {
  blockUnavailableChannelParticipants,
  transitionChannelTurnToBlocked,
  transitionChannelTurnToSucceeded,
} from "./channel-turn-dispatch-lifecycle.js";
import type { ChannelReplyDispatchCoordinator } from "./channel-reply-dispatch-coordinator.js";
import type { CreateChannelAiReply } from "./channel-reply-dispatch-lane.js";
import type {
  ChannelTurnDispatchExecution,
  ExecuteClaimedChannelTurnDispatch,
} from "./channel-turn-dispatch-worker.js";
import { handleLingAgentChannelMessage } from "./messages.js";
import type { LingImageVisionSummarizer } from "./materialization/registry.js";
import {
  finalizeOrchestratedWorkflowStepRun,
  orchestrateChannelWorkflow,
  type StartOrchestratedWorkflowStepRun,
} from "./orchestrator.js";
import { confirmChannelExecutionProposalWorkflow } from "./proposal-workflows.js";

export interface ChannelTurnDispatchExecutorOptions {
  readonly config: ResolvedDaemonConfig;
  readonly storeRegistry: RunStoreRegistry;
  readonly runnerRegistry: RunnerRegistry;
  readonly activeRuns: ActiveRunRegistry;
  readonly runtimeSupervisor: RuntimeSupervisor;
  readonly secretResolver: Parameters<typeof resolveProviderForRun>[2];
  readonly mcpBroker: McpBroker;
  readonly controlPlaneEvents: ControlPlaneEventHub;
  readonly startupState: StartupStateRegistry;
  readonly computerUsePreviews: ComputerUseProjectionRegistry;
  readonly hostCapabilityBridge: HostCapabilityBridgeController;
  readonly replyDispatchCoordinator: ChannelReplyDispatchCoordinator;
  readonly imageVisionSummarizer?: LingImageVisionSummarizer;
  readonly webFetch?: typeof globalThis.fetch;
  readonly webResolveHostAddresses?: (hostname: string) => Promise<readonly string[]>;
  readonly afterRunTerminal?: (run: RunSession) => Promise<void>;
}

export function createChannelTurnDispatchExecutor(
  options: ChannelTurnDispatchExecutorOptions,
): ExecuteClaimedChannelTurnDispatch {
  const startRun = createStartRun(options);
  return async ({ store, channel, sourceMessage, request, observer }) => {
    if (request.unavailableRequestedParticipantIds?.length) {
      const blocker = blockUnavailableChannelParticipants(
        store,
        sourceMessage,
        request.unavailableRequestedParticipantIds,
      );
      if (blocker) observer.onBlocked?.(blocker);
      return { result: blocker ? { aiReply: blocker } : {} };
    }
    const replyCompletions: Promise<void>[] = [];
    const createAiReply: CreateChannelAiReply = async (replyInput) => {
      const replyMessageId = channelReplyMessageId(request.sourceTurnId, replyInput.teammateId);
      const checkpoint = findReplyCheckpoint(store, replyMessageId);
      if (checkpoint?.terminal || checkpoint?.activeChild) {
        observer.onReplyReady?.(checkpoint.reply);
        if (checkpoint.activeChild) observer.onRunLinked?.(checkpoint.reply);
        return checkpoint.reply;
      }
      let settle!: () => void;
      const completion = new Promise<void>((resolve) => {
        settle = resolve;
      });
      replyCompletions.push(completion);
      return await createAiChannelReply({
        ...replyInput,
        startRun,
        secretResolver: options.secretResolver,
        webFetch: options.webFetch,
        webResolveHostAddresses: options.webResolveHostAddresses,
        completionMode: "background",
        trackCompletion: (pending) => options.activeRuns.trackCompletion(pending),
        teamObserverBusEnabled: options.config.channels.teamObserverBus === true,
        replyMessageId,
        ...(checkpoint?.recoveryAttempt ? { replyRecoveryAttempt: checkpoint.recoveryAttempt } : {}),
        onDispatchSettled: () => {
          replyInput.onDispatchSettled?.();
          settle();
        },
        stream: {
          onReady: (reply) => observer.onReplyReady?.(reply),
          onRunLinked: (reply) => observer.onRunLinked?.(reply),
          onDelta: (reply, delta) => observer.onDelta?.(reply, delta),
          onDone: (reply) => observer.onDone?.(reply),
          onBlocked: (reply) => observer.onBlocked?.(reply),
        },
      });
    };
    const result = await handleLingAgentChannelMessage({
      store,
      channel,
      sourceMessage,
      requestedProviderPresetId: request.requestedProviderPresetId,
      requestedTeammateId: request.requestedTeammateId,
      explicitContextSegmentId: request.explicitContextSegmentId,
      requestAiReply: request.requestAiReply,
      replyDisposition: request.replyDisposition,
      createAiReply,
      startExecutionProposalWorkflow: async ({ store: workflowStore, proposalId }) =>
        await confirmAndOrchestrateProposal(options, workflowStore, proposalId),
      config: options.config,
      routeDependencies: {
        runnerRegistry: options.runnerRegistry,
        secretResolver: options.secretResolver,
        config: options.config,
        hostCapabilityAvailable: (capabilityId) => options.hostCapabilityBridge.hasCapability(capabilityId),
      },
      imageVisionSummarizer: options.imageVisionSummarizer,
      replyDispatchCoordinator: options.replyDispatchCoordinator,
      onReplyPending: observer.onReplyPending,
    });
    if (result.routeDecisionId && result.aiReply) {
      store.updateChannelMessageRouteDecision(result.routeDecisionId, {
        replyMessageId: result.aiReply.id,
      }, new Date().toISOString());
    }
    const settled = replyCompletions.length > 0
      ? Promise.allSettled(replyCompletions).then(() => {
          const replies = result.aiReplies?.length
            ? result.aiReplies
            : result.aiReply
              ? [result.aiReply]
              : [];
          reconcileNoRunTurnOutcome(store, request, replies, result);
        })
      : undefined;
    if (!settled) reconcileNoRunTurnOutcome(store, request, [], result);
    return {
      result,
      ...(settled ? { settled } : {}),
    } satisfies ChannelTurnDispatchExecution;
  };
}

function reconcileNoRunTurnOutcome(
  store: RunStore,
  request: ChannelTurnDispatchRequestV1,
  replies: readonly NonNullable<ReturnType<typeof findChannelAssistantReplyForSource>>[],
  result: Awaited<ReturnType<typeof handleLingAgentChannelMessage>> | undefined,
): void {
  const turn = store.getLingTurn(request.sourceTurnId);
  if (!turn || turn.status === "succeeded" || turn.status === "failed" || turn.status === "cancelled" || turn.status === "superseded") {
    return;
  }
  if (turn.activeRunId || turn.lastRunId || result?.autoStartedWorkflow) return;
  const latestDecision = store.listChannelIntentDecisions({
    channelId: request.channelId,
    sourceItemId: request.sourceItemId,
    limit: 100,
  }).find((decision) => decision.status === "accepted" || decision.status === "suppressed");
  const latestRoute = store.listChannelMessageRouteDecisions({
    channelId: request.channelId,
    sourceMessageId: request.sourceItemId,
    limit: 100,
  }).find((decision) => decision.status === "accepted" || decision.status === "suppressed");
  if (latestDecision?.workflowId) return;
  const latestReplies = replies.length > 0
    ? replies.map((reply) => store.getConversationItem(reply.id)).filter((item) => Boolean(item))
    : store.listConversationItemsForTurn({ turnId: request.sourceTurnId })
      .filter((item) => item.kind === "assistant_message");
  if (latestReplies.some((item) =>
    item?.status === "failed"
    || (item?.kind === "assistant_message" && item.payload.deliveryStatus === "blocked")
  )) {
    transitionChannelTurnToBlocked(store, request.sourceTurnId, "channel_turn_reply_blocked");
    return;
  }
  if (latestDecision?.action === "clarify" || latestDecision?.action === "workflow_proposal" || latestDecision?.action === "execute") {
    transitionChannelTurnToBlocked(store, request.sourceTurnId, `channel_turn_${latestDecision.action}_awaiting_user`);
    return;
  }
  if (
    latestDecision?.action === "no_reply"
    || latestRoute?.action === "no_reply"
    || latestReplies.some((item) => item?.status === "committed")
  ) {
    transitionChannelTurnToSucceeded(store, request.sourceTurnId, `channel_turn_${latestDecision?.action ?? "reply"}_completed`);
  }
}

function findReplyCheckpoint(
  store: RunStore,
  replyMessageId: string,
): {
  readonly reply: NonNullable<ReturnType<typeof findChannelAssistantReplyForSource>>;
  readonly terminal: boolean;
  readonly activeChild: boolean;
  readonly recoveryAttempt?: number;
} | undefined {
  const reply = getChannelMessageView(store, replyMessageId);
  if (!reply) return undefined;
  const item = store.getConversationItem(reply.id);
  const children = store.listWorkUnits({
    kind: "channel_ai_reply",
    linkedMessageId: reply.id,
    limit: 500,
  });
  const activeChild = children.some((workUnit) =>
    workUnit.status === "queued"
    || workUnit.status === "claimed"
    || workUnit.status === "running"
    || workUnit.status === "waiting_for_approval"
    || workUnit.status === "cancelling"
  );
  return {
    reply,
    terminal: item?.status === "committed" || item?.status === "failed",
    activeChild,
    ...(!activeChild && item?.status === "pending" && children.length > 0
      ? { recoveryAttempt: children.length + 1 }
      : {}),
  };
}

function channelReplyMessageId(sourceTurnId: string, teammateId: string | undefined): string {
  return `item_channel_reply_${sourceTurnId}_${teammateId ?? "ling_agent"}`;
}

function createStartRun(options: ChannelTurnDispatchExecutorOptions) {
  return async (runRequest: RunRequest, sink: RunExecutionSink): Promise<string | undefined> =>
    await executeRunRequest(
      runRequest,
      sink,
      options.runnerRegistry,
      options.storeRegistry,
      options.activeRuns,
      options.runtimeSupervisor,
      options.secretResolver,
      options.mcpBroker,
      {
        afterRunTerminal: options.afterRunTerminal,
        controlPlaneEvents: options.controlPlaneEvents,
        startupState: options.startupState,
        computerUsePreviews: options.computerUsePreviews,
        hostCapabilityBridge: options.hostCapabilityBridge,
      },
    );
}

async function confirmAndOrchestrateProposal(
  options: ChannelTurnDispatchExecutorOptions,
  store: RunStore,
  proposalId: string,
) {
  const cwd = store.paths.cwd;
  const validateRunRequest = (request: RunRequest): void => {
    resolveProviderForRun(store, request, options.secretResolver);
  };
  const confirmed = confirmChannelExecutionProposalWorkflow({
    restrictedCommandRuntime: options.runtimeSupervisor.getRestrictedCommandRuntime(),
    hostCapabilityAvailable: (capabilityId) => options.hostCapabilityBridge.hasCapability(capabilityId),
    store,
    cwd,
    proposalId,
    runnerRegistry: options.runnerRegistry,
    validateRunRequest,
  });
  const startRun = createStartOrchestratedRun(options, store, cwd);
  const orchestration = await orchestrateChannelWorkflow({
    store,
    cwd,
    workflowId: confirmed.workflow.id,
    validateRunRequest,
    startRun,
  });
  return {
    proposal: store.getChannelExecutionProposal(proposalId) ?? confirmed.proposal,
    workflow: orchestration.workflow,
    workflowSteps: store.listChannelWorkflowSteps({ workflowId: confirmed.workflow.id, complete: true }),
    orchestration,
  };
}

function createStartOrchestratedRun(
  options: ChannelTurnDispatchExecutorOptions,
  store: RunStore,
  cwd: string,
): StartOrchestratedWorkflowStepRun {
  const startRun: StartOrchestratedWorkflowStepRun = ({ workflow, workflowStep, taskId, runRequest }) =>
    new Promise((resolve) => {
      let resolved = false;
      const resolveOnce = (runId: string | undefined): void => {
        if (resolved) return;
        resolved = true;
        resolve(runId);
      };
      void executeRunRequest(
        runRequest,
        createDetachedRunExecutionSink(),
        options.runnerRegistry,
        options.storeRegistry,
        options.activeRuns,
        options.runtimeSupervisor,
        options.secretResolver,
        options.mcpBroker,
        {
          onRunReady: (runId) => {
            store.updateChannelWorkflowStep(workflowStep.id, { taskId, runId }, new Date().toISOString());
            resolveOnce(runId);
          },
          afterRunTerminal: async (terminalRun) => {
            finalizeOrchestratedWorkflowStepRun(store, workflowStep.id, taskId, terminalRun);
            await options.afterRunTerminal?.(terminalRun);
            if (terminalRun.status === "succeeded") {
              await orchestrateChannelWorkflow({
                store,
                cwd,
                workflowId: workflow.id,
                validateRunRequest: (request) => resolveProviderForRun(store, request, options.secretResolver),
                startRun,
              });
            }
          },
          controlPlaneEvents: options.controlPlaneEvents,
          startupState: options.startupState,
          computerUsePreviews: options.computerUsePreviews,
          hostCapabilityBridge: options.hostCapabilityBridge,
        },
      ).then(resolveOnce, () => resolveOnce(undefined));
    });
  return startRun;
}
