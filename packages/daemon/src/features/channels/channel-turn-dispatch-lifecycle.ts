import type {
  ChannelIntentDecision,
  ChannelMessage,
  ChannelMessageRouteDecision,
  RunStore,
  WorkUnit,
} from "@ling-stack/core";
import type { ChannelReplyDispatch } from "@ling-stack/contracts";
import type { RuntimeSupervisor } from "../../runtime/supervisor.js";
import { transitionWorkUnitTerminal } from "../../runtime/work-units.js";
import { LING_AGENT_EXECUTOR_ID } from "./ling-agent-executor.js";
import type { LingAgentChannelMessageResult } from "./messages.js";
import {
  appendChannelAssistantMessage,
  findChannelAssistantReplyForSource,
  listChannelAssistantRepliesForSource,
  updatePendingAssistantMessage,
} from "./conversation-item-messages.js";

export interface ClaimedChannelTurnDispatch {
  readonly workUnit: WorkUnit;
  readonly workUnitId: string;
  readonly attemptId: string;
  readonly sourceItemId: string;
  readonly sourceTurnId: string;
}

export type ChannelTurnDispatchClaim =
  | { readonly kind: "claimed"; readonly dispatch: ClaimedChannelTurnDispatch }
  | { readonly kind: "replay"; readonly result: LingAgentChannelMessageResult }
  | { readonly kind: "owned"; readonly workUnit: WorkUnit };

export function findAcceptedChannelTurnDispatch(
  store: RunStore,
  message: ChannelMessage,
): WorkUnit {
  const sourceItem = store.getConversationItem(message.id);
  if (!sourceItem?.turnId) throw new Error(`Accepted Channel item has no turn: ${message.id}`);
  const workUnit = store.findWorkUnitByIdempotency({
    kind: "channel_turn_dispatch",
    ownerType: "ling_turn",
    ownerId: sourceItem.turnId,
    idempotencyKey: `channel-turn-dispatch:${sourceItem.turnId}`,
  });
  if (!workUnit) throw new Error(`Accepted Channel turn has no dispatch work unit: ${sourceItem.turnId}`);
  return workUnit;
}

export function claimAcceptedChannelTurnDispatch(input: {
  readonly store: RunStore;
  readonly workUnit: WorkUnit;
  readonly runtimeSupervisor: RuntimeSupervisor;
}): ChannelTurnDispatchClaim {
  const sourceItem = input.workUnit.linkedMessageId
    ? input.store.getConversationItem(input.workUnit.linkedMessageId)
    : undefined;
  if (!sourceItem?.turnId || sourceItem.turnId !== input.workUnit.ownerId) {
    throw new Error(`Channel turn dispatch lineage is invalid: ${input.workUnit.id}`);
  }
  if (isTerminalDispatch(input.workUnit)) {
    return { kind: "replay", result: replayAcceptedChannelTurnDispatch(input.store, sourceItem.id) };
  }
  if (input.workUnit.status !== "queued") {
    return { kind: "owned", workUnit: input.workUnit };
  }

  const runtime = input.runtimeSupervisor.getRuntime(input.store.paths.cwd, input.store);
  const startedAt = new Date().toISOString();
  const claimed = input.store.transitionWorkUnitStatus({
    workUnitId: input.workUnit.id,
    expectedStatus: "queued",
    event: "claim",
    actor: "system",
    now: startedAt,
  });
  if (!claimed.ok) {
    return {
      kind: "owned",
      workUnit: input.store.getWorkUnit(input.workUnit.id) ?? input.workUnit,
    };
  }

  const claimedWorkUnit = input.store.getWorkUnit(input.workUnit.id) ?? input.workUnit;
  const attempt = input.store.createWorkUnitAttempt({
    workUnitId: claimedWorkUnit.id,
    attemptNumber: claimedWorkUnit.attemptCount + 1,
    runtimeInstanceId: runtime.runtimeInstanceId,
    runnerId: "daemon",
    effectiveRunnerId: "daemon",
    status: "started",
    now: startedAt,
  });
  const running = input.store.transitionWorkUnitStatus({
    workUnitId: claimedWorkUnit.id,
    expectedStatus: "claimed",
    event: "runner_started",
    actor: "system",
    now: startedAt,
    activeAttemptId: attempt.id,
    startedAt,
    lastEventAt: startedAt,
    lastHeartbeatAt: startedAt,
  });
  if (!running.ok) throw new Error(`Channel turn dispatch start failed: ${claimedWorkUnit.id}/${running.code}`);
  input.store.appendRuntimeEvent({
    workUnitId: claimedWorkUnit.id,
    attemptId: attempt.id,
    type: "work_unit_started",
    actor: "system",
    ts: startedAt,
    data: { sourceItemId: sourceItem.id, sourceTurnId: sourceItem.turnId },
  });
  input.store.transitionLingTurnStatus({
    turnId: sourceItem.turnId,
    expectedStatus: "open",
    event: "start",
    actor: "system",
    reason: `channel_turn_dispatch:${claimedWorkUnit.id}`,
    idempotencyKey: `channel-turn-dispatch-start:${claimedWorkUnit.id}`,
    now: startedAt,
  });
  return {
    kind: "claimed",
    dispatch: {
      workUnit: input.store.getWorkUnit(claimedWorkUnit.id) ?? claimedWorkUnit,
      workUnitId: claimedWorkUnit.id,
      attemptId: attempt.id,
      sourceItemId: sourceItem.id,
      sourceTurnId: sourceItem.turnId,
    },
  };
}

export function completeAcceptedChannelTurnDispatch(
  store: RunStore,
  dispatch: ClaimedChannelTurnDispatch,
): void {
  transitionWorkUnitTerminal(store, {
    workUnitId: dispatch.workUnitId,
    attemptId: dispatch.attemptId,
    event: "runner_succeeded",
    attemptStatus: "succeeded",
    runtimeEventType: "work_unit_succeeded",
    actor: "system",
    now: new Date().toISOString(),
  });
}

export function failAcceptedChannelTurnDispatch(
  store: RunStore,
  dispatch: ClaimedChannelTurnDispatch,
  error: unknown,
): void {
  const message = error instanceof Error ? error.message : String(error);
  transitionWorkUnitTerminal(store, {
    workUnitId: dispatch.workUnitId,
    attemptId: dispatch.attemptId,
    event: "runner_failed",
    attemptStatus: "failed",
    runtimeEventType: "work_unit_failed",
    actor: "system",
    now: new Date().toISOString(),
    errorCode: "channel_turn_dispatch_failed",
    errorMessage: message,
  });
}

export function blockAcceptedChannelTurnDispatch(
  store: RunStore,
  message: ChannelMessage,
  error: unknown,
): ChannelMessage | undefined {
  const sourceItem = store.getConversationItem(message.id);
  if (!sourceItem?.turnId) return undefined;
  const detail = error instanceof Error ? error.message : String(error);
  const existing = findChannelAssistantReplyForSource({ store, sourceItemId: sourceItem.id });
  const existingItem = existing ? store.getConversationItem(existing.id) : undefined;
  const blocker = existing && existingItem?.status === "pending"
    ? updatePendingAssistantMessage({
        store,
        itemId: existing.id,
        body: "本轮消息在回复派发前失败，请重试。原消息和上下文已经保留。",
        status: "blocked",
        errorMessage: detail,
        now: new Date().toISOString(),
      })
    : existing ?? appendChannelAssistantMessage({
    store,
    sourceItemId: sourceItem.id,
    actorId: LING_AGENT_EXECUTOR_ID,
    body: "本轮消息在回复派发前失败，请重试。原消息和上下文已经保留。",
    status: "blocked",
    errorMessage: detail,
    idempotencyKey: `channel-turn-dispatch-blocker:${sourceItem.turnId}`,
    now: new Date().toISOString(),
      });
  transitionChannelTurnToBlocked(store, sourceItem.turnId, `channel_turn_dispatch_failed:${detail}`);
  return blocker;
}

export function blockUnavailableChannelParticipants(
  store: RunStore,
  message: ChannelMessage,
  participantIds: readonly string[],
): ChannelMessage | undefined {
  const sourceItem = store.getConversationItem(message.id);
  if (!sourceItem?.turnId || participantIds.length === 0) return undefined;
  const ids = [...new Set(participantIds)].sort();
  const detail = `participant_unavailable_in_channel:${ids.join(",")}`;
  const body = `这些协作成员当前无法在此频道参与：${ids.join("、")}。请启用或加入频道后重新发起。`;
  const existing = findChannelAssistantReplyForSource({ store, sourceItemId: sourceItem.id });
  const existingItem = existing ? store.getConversationItem(existing.id) : undefined;
  const blocker = existing && existingItem?.status === "pending"
    ? updatePendingAssistantMessage({
        store,
        itemId: existing.id,
        body,
        status: "blocked",
        errorMessage: detail,
        now: new Date().toISOString(),
      })
    : existing ?? appendChannelAssistantMessage({
        store,
        sourceItemId: sourceItem.id,
        actorId: LING_AGENT_EXECUTOR_ID,
        body,
        status: "blocked",
        errorMessage: detail,
        idempotencyKey: `channel-turn-participant-unavailable:${sourceItem.turnId}`,
        now: new Date().toISOString(),
      });
  transitionChannelTurnToBlocked(store, sourceItem.turnId, detail);
  return blocker;
}

export function transitionChannelTurnToBlocked(store: RunStore, turnId: string, reason: string): void {
  const turn = store.getLingTurn(turnId);
  if (!turn || (turn.status !== "open" && turn.status !== "running" && turn.status !== "waiting_for_approval")) {
    return;
  }
  store.transitionLingTurnStatus({
    turnId,
    expectedStatus: turn.status,
    event: "block",
    actor: "system",
    reason,
    idempotencyKey: `channel-turn-dispatch-block:${turnId}:${reason.split(":", 1)[0]}`,
    now: new Date().toISOString(),
  });
}

export function transitionChannelTurnToSucceeded(store: RunStore, turnId: string, reason: string): void {
  const turn = store.getLingTurn(turnId);
  if (!turn || (turn.status !== "open" && turn.status !== "running" && turn.status !== "waiting_for_approval")) {
    return;
  }
  store.transitionLingTurnStatus({
    turnId,
    expectedStatus: turn.status,
    event: "succeed",
    actor: "system",
    reason,
    idempotencyKey: `channel-turn-dispatch-succeed:${turnId}`,
    now: new Date().toISOString(),
  });
}

export function replayAcceptedChannelTurnDispatch(
  store: RunStore,
  sourceItemId: string,
): LingAgentChannelMessageResult {
  const sourceItem = store.getConversationItem(sourceItemId);
  if (!sourceItem?.channelId) return {};
  const intentDecision = store.listChannelIntentDecisions({
    channelId: sourceItem.channelId,
    sourceItemId,
    limit: 500,
  })[0];
  const routeDecision = store.listChannelMessageRouteDecisions({
    channelId: sourceItem.channelId,
    sourceMessageId: sourceItemId,
    limit: 500,
  })[0];
  const discoveredReplies = listChannelAssistantRepliesForSource({ store, sourceItemId });
  const repliesById = new Map(discoveredReplies.map((reply) => [reply.id, reply]));
  const preferredReplyIds = [
    ...(intentDecision?.resultItemIds ?? []),
    ...(routeDecision?.replyMessageId ? [routeDecision.replyMessageId] : []),
  ];
  const aiReplies = [...new Set([...preferredReplyIds, ...discoveredReplies.map((reply) => reply.id)])]
    .flatMap((replyId) => repliesById.get(replyId) ? [repliesById.get(replyId)!] : []);
  const aiReply = aiReplies[0];
  const replyDispatch = replayChannelReplyDispatch(store, sourceItemId, intentDecision, routeDecision, aiReplies);
  const autoStartedWorkflow = replayAutoStartedWorkflow(store, intentDecision);
  return {
    ...(aiReply ? { aiReply } : {}),
    ...(aiReplies.length > 1 || intentDecision?.action === "visible_multi_reply" ? { aiReplies } : {}),
    ...(routeDecision ? { routeDecisionId: routeDecision.id } : {}),
    ...(replyDispatch ? { replyDispatch } : {}),
    ...(autoStartedWorkflow ? { autoStartedWorkflow } : {}),
  };
}

function replayChannelReplyDispatch(
  store: RunStore,
  sourceItemId: string,
  intentDecision: ChannelIntentDecision | undefined,
  routeDecision: ChannelMessageRouteDecision | undefined,
  aiReplies: readonly ChannelMessage[],
): ChannelReplyDispatch | undefined {
  const intervention = store.listRunInterventions({
    mode: "queue_followup",
    sourceMessageIds: [sourceItemId],
    limit: 500,
  }).find((candidate) => candidate.messagePayload?.sourceMessageId === sourceItemId);
  if (intervention) {
    return {
      targetTeammateId: intervention.messagePayload?.targetTeammateId ?? LING_AGENT_EXECUTOR_ID,
      disposition: "followup_queued",
      sourceRunId: intervention.sourceRunId,
      intervention,
    };
  }
  if (routeDecision?.action === "reply") {
    return {
      targetTeammateId: routeDecision.selectedTeammateId ?? aiReplies[0]?.authorId ?? LING_AGENT_EXECUTOR_ID,
      disposition: "reply_requested",
    };
  }
  if (intentDecision?.action === "reply"
    || (intentDecision?.action === "visible_multi_reply" && aiReplies.length === 1)) {
    return {
      targetTeammateId: intentDecision.selectedTeammateIds[0] ?? aiReplies[0]?.authorId ?? LING_AGENT_EXECUTOR_ID,
      disposition: "reply_requested",
    };
  }
  return undefined;
}

function replayAutoStartedWorkflow(
  store: RunStore,
  intentDecision: ChannelIntentDecision | undefined,
): LingAgentChannelMessageResult["autoStartedWorkflow"] {
  if (!intentDecision?.proposalId || !intentDecision.workflowId) return undefined;
  const proposal = store.getChannelExecutionProposal(intentDecision.proposalId);
  const workflow = store.getChannelWorkflow(intentDecision.workflowId);
  if (!proposal || !workflow || proposal.linkedWorkflowId !== workflow.id) return undefined;
  return {
    proposal,
    workflow,
    workflowSteps: store.listChannelWorkflowSteps({ workflowId: workflow.id, limit: 500 }),
  };
}

function isTerminalDispatch(workUnit: WorkUnit): boolean {
  return workUnit.status === "succeeded" || workUnit.status === "failed" || workUnit.status === "cancelled";
}
