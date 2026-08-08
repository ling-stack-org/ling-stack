import type { ChannelReplyDisposition } from "@ling-stack/contracts";
import type { Channel, ChannelMessage, RunSession, RunStore } from "@ling-stack/core";
import {
  type ChannelReplyDispatchCoordinator,
  type ChannelReplyLaneOwner,
} from "./channel-reply-dispatch-coordinator.js";
import { findActiveChannelReplyRun } from "./channel-reply-dispatch.js";
import { resolveChannelConversationLineKey } from "./conversation-surface.js";
import type { LingAgentTurnEnvelope } from "./ling-agent-turn-envelope.js";

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
    readonly onRunLinked?: (message: ChannelMessage) => void;
    readonly onDelta: (message: ChannelMessage, delta: string) => void;
    readonly onDone: (message: ChannelMessage) => void;
    readonly onBlocked: (message: ChannelMessage) => void;
  };
  readonly onRunLinked?: (runId: string) => void;
  readonly onDispatchSettled?: () => void;
}) => Promise<ChannelMessage>;

export async function acquireChannelReplyLane(input: {
  readonly coordinator?: ChannelReplyDispatchCoordinator;
  readonly store: RunStore;
  readonly sourceMessage: ChannelMessage;
  readonly channelId: string;
  readonly replyDisposition?: ChannelReplyDisposition;
}): Promise<{ readonly activeRun?: RunSession; readonly owner?: ChannelReplyLaneOwner }> {
  const current = input.replyDisposition?.activeRunId
    ? findActiveChannelReplyRun({
        store: input.store,
        channelId: input.channelId,
        sourceMessage: input.sourceMessage,
        activeRunId: input.replyDisposition.activeRunId,
      })
    : undefined;
  if (current || !input.coordinator || !canDispatchChannelReply(input.sourceMessage)) {
    return { activeRun: current };
  }
  if (input.replyDisposition?.activeRunId) {
    return {};
  }


  const laneKey = {
    workspaceId: input.sourceMessage.workspaceId,
    channelId: input.channelId,
    conversationLineKey: resolveChannelConversationLineKey(
      input.store,
      input.channelId,
      input.sourceMessage,
    ),
  };
  if (input.replyDisposition) {
    const follower = input.coordinator.follow(laneKey);
    if (!follower) {
      return {};
    }
    const runId = await follower.waitForRun();
    const linkedRun = runId
      ? findActiveChannelReplyRun({
          store: input.store,
          channelId: input.channelId,
          sourceMessage: input.sourceMessage,
          activeRunId: runId,
        })
      : undefined;
    return { activeRun: linkedRun };
  }

  while (true) {
    const claim = input.coordinator.claim(laneKey, input.sourceMessage.id);
    if (claim.kind === "owner") {
      return { owner: claim };
    }
    return {};
  }
}

export function createLaneTrackedAiReply(input: {
  readonly createAiReply: CreateChannelAiReply;
  readonly owner?: ChannelReplyLaneOwner;
  readonly store: RunStore;
  readonly teammateId: string;
}): {
  readonly createAiReply: CreateChannelAiReply;
  readonly releaseIfUnused: () => void;
} {
  if (!input.owner) {
    return {
      createAiReply: input.createAiReply,
      releaseIfUnused: () => undefined,
    };
  }

  let invoked = false;
  let linked = false;
  let pending = 0;
  const releaseIfSettled = (): void => {
    queueMicrotask(() => {
      if (!linked && pending === 0) input.owner?.release();
    });
  };
  const createAiReply: CreateChannelAiReply = async (replyInput) => {
    invoked = true;
    pending += 1;
    let settled = false;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      pending -= 1;
      try {
        replyInput.onDispatchSettled?.();
      } finally {
        releaseIfSettled();
      }
    };
    try {
      return await input.createAiReply({
        ...replyInput,
        teammateId: replyInput.teammateId ?? input.teammateId,
        onRunLinked: (runId) => {
          replyInput.onRunLinked?.(runId);
          const run = input.store.getRun(runId);
          if (!linked && run?.channelId === replyInput.channel.id) {
            linked = true;
            input.owner?.linkRun(runId);
          }
        },
        onDispatchSettled: settle,
      });
    } catch (error) {
      settle();
      throw error;
    }
  };
  return {
    createAiReply,
    releaseIfUnused: () => {
      if (!invoked) input.owner?.release();
    },
  };
}

function canDispatchChannelReply(message: ChannelMessage): boolean {
  return message.authorType === "local-user" && message.kind === "message" && message.intent === "discuss";
}
