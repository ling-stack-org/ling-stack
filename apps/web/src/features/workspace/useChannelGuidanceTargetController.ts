import { useMemo } from "react";
import type { ChannelMention, ChannelMessage, ConversationActiveReplyTarget, RunSession, WorkUnit } from "../../types.js";
import {
  deriveChannelReplyGuidanceTargets,
  resolveChannelMessageTargetTeammateId,
  resolveChannelGuidanceTarget,
  type ChannelGuidanceTarget,
} from "./channel-guidance-targets.js";

export interface ChannelGuidanceTargetController {
  readonly activeTarget: ChannelGuidanceTarget | undefined;
  readonly activeRun: RunSession | undefined;
  readonly sourceRunId: string;
  readonly guidanceModeActive: boolean;
  readonly replyTargets: readonly ChannelGuidanceTarget[];
  readonly targetTeammateId: string;
}

export function useChannelGuidanceTargetController(input: {
  readonly selectedChannelId: string;
  readonly conversationLineThreadId?: string;
  readonly channelMessages: readonly ChannelMessage[];
  readonly channelRuns: readonly RunSession[];
  readonly workUnits: readonly WorkUnit[];
  readonly transientReplies?: readonly ConversationActiveReplyTarget[];
  readonly fallbackRun: RunSession | undefined;
  readonly messageMentions: readonly ChannelMention[];
  readonly teammateLabel: (teammateId: string | undefined) => string;
}): ChannelGuidanceTargetController {
  const replyTargets = useMemo(
    () => deriveChannelReplyGuidanceTargets({
      channelId: input.selectedChannelId,
      conversationLineThreadId: input.conversationLineThreadId,
      channelMessages: input.channelMessages,
      runs: input.fallbackRun
        ? [input.fallbackRun, ...input.channelRuns.filter((run) => run.id !== input.fallbackRun?.id)]
        : input.channelRuns,
      workUnits: input.workUnits,
      transientReplies: input.transientReplies,
      teammateLabel: input.teammateLabel,
    }),
    [input.channelMessages, input.channelRuns, input.conversationLineThreadId, input.fallbackRun, input.selectedChannelId, input.teammateLabel, input.transientReplies, input.workUnits],
  );
  const guidanceModeActive = replyTargets.length > 0;
  const targetTeammateId = resolveChannelMessageTargetTeammateId({ mentions: input.messageMentions });

  const activeTarget = resolveChannelGuidanceTarget({
    replyTargets,
  });

  return {
    activeTarget,
    activeRun: activeTarget?.run,
    sourceRunId: activeTarget?.activeReply.sourceRunId ?? "",
    guidanceModeActive,
    replyTargets,
    targetTeammateId,
  };
}
