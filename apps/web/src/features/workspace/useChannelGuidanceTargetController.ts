import { useEffect, useMemo, useState } from "react";
import type { RunSession, WorkUnit } from "../../types.js";
import {
  deriveChannelReplyGuidanceTargets,
  resolveChannelGuidanceRun,
  type ChannelGuidanceTarget,
} from "./channel-guidance-targets.js";

export interface ChannelGuidanceTargetController {
  readonly activeRun: RunSession | undefined;
  readonly sourceRunId: string;
  readonly guidanceModeActive: boolean;
  readonly replyTargets: readonly ChannelGuidanceTarget[];
  readonly targetSelectionRequired: boolean;
  readonly selectedReplyRunId: string;
  readonly selectReplyRun: (runId: string) => void;
}

export function useChannelGuidanceTargetController(input: {
  readonly selectedChannelId: string;
  readonly channelRuns: readonly RunSession[];
  readonly workUnits: readonly WorkUnit[];
  readonly fallbackRun: RunSession | undefined;
  readonly teammateLabel: (teammateId: string | undefined) => string;
}): ChannelGuidanceTargetController {
  const [selectedReplyRunId, setSelectedReplyRunId] = useState("");
  const replyTargets = useMemo(
    () => deriveChannelReplyGuidanceTargets({
      channelId: input.selectedChannelId,
      runs: input.channelRuns,
      workUnits: input.workUnits,
      teammateLabel: input.teammateLabel,
    }),
    [input.channelRuns, input.selectedChannelId, input.teammateLabel, input.workUnits],
  );

  useEffect(() => {
    setSelectedReplyRunId("");
  }, [input.selectedChannelId]);

  const activeRun = resolveChannelGuidanceRun({
    replyTargets,
    selectedReplyRunId,
    fallbackRun: input.fallbackRun,
  });

  return {
    activeRun,
    sourceRunId: activeRun ? activeRun.parentRunId ?? activeRun.id : "",
    guidanceModeActive: replyTargets.length > 0 || Boolean(input.fallbackRun),
    replyTargets,
    targetSelectionRequired: replyTargets.length > 1,
    selectedReplyRunId: replyTargets.length === 1 ? replyTargets[0]?.run.id ?? "" : selectedReplyRunId,
    selectReplyRun: setSelectedReplyRunId,
  };
}
