import { memoryEligibilityForView } from "./memory.js";
import type { ChannelContextDroppedReason, ChannelContextSource, ChannelContextViewKind } from "./types.js";

export function sourceDropReasonForView(
  source: ChannelContextSource,
  viewKind: ChannelContextViewKind,
  consumerTeammateId?: string,
): ChannelContextDroppedReason | undefined {
  const memoryEligibility = memoryEligibilityForView(source, viewKind, consumerTeammateId);
  if (memoryEligibility?.mode === "excluded") {
    return memoryEligibility.droppedReason;
  }

  if (source.sensitivity === "secret_adjacent" && viewKind !== "evidence_inspect_view") {
    return "sensitivity";
  }
  if (source.sensitivity === "private" && !isPrivateSourceAllowed(source, viewKind, consumerTeammateId)) {
    return "sensitivity";
  }
  if (viewKind === "selector_view") {
    if (source.kind === "artifact" || source.kind === "workflow_packet") {
      return "scope";
    }
    if (source.kind === "evidence") {
      return "raw_evidence";
    }
  }
  if (viewKind === "ling_agent_channel_view") {
    if (source.kind === "workflow_packet" || source.kind === "artifact") {
      return "raw_evidence";
    }
  }
  if (viewKind === "workflow_step_view" || viewKind === "specialist_task_view") {
    if (source.kind === "recent_message" && source.freshness !== "current_turn") {
      return "scope";
    }
  }
  if (viewKind === "private_chat_view" && source.kind === "recent_message") {
    return "scope";
  }
  return undefined;
}

function isPrivateSourceAllowed(
  source: ChannelContextSource,
  viewKind: ChannelContextViewKind,
  consumerTeammateId?: string,
): boolean {
  if (viewKind === "evidence_inspect_view") {
    return true;
  }
  if (viewKind !== "private_chat_view" && viewKind !== "workflow_step_view" && viewKind !== "specialist_task_view") {
    return false;
  }
  return Boolean(consumerTeammateId && source.teammateId === consumerTeammateId);
}
