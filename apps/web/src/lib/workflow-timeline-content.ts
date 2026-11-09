import { projectWorkflowGraph, type ConversationTimelineItem, type ConversationTimelineProtocolEventItem } from "@ling-stack/conversation-ui-core";
import type { ChannelWorkflowStep } from "../types.js";
import { isWorkflowIsolationTimelineItem } from "./workflow-isolation-evidence.js";

/** Participant ids and accepted dependencies, not labels or step count, establish collaboration. */
export function hasCollaborativeWorkflowGraph(workflowId: string, steps: readonly ChannelWorkflowStep[]): boolean {
  const ownedSteps = steps.filter(step => step.workflowId === workflowId);
  if (new Set(ownedSteps.map(step => step.id)).size < 2) return false;
  if (new Set(ownedSteps.map(step => step.toParticipantId).filter(Boolean)).size > 1) return true;
  const model = projectWorkflowGraph({ workflowId, steps: ownedSteps, observation: "current" });
  if (model.omittedStepCount || model.nodes.some(node => node.issues.length)) return false;
  const remaining = new Set(model.nodes.map(node => node.id));
  while (remaining.size) {
    const ready = model.nodes.filter(node => remaining.has(node.id) && node.dependencyIds.every(id => !remaining.has(id)));
    if (ready.length > 1) return true;
    if (!ready.length) return false;
    remaining.delete(ready[0]!.id);
  }
  return false;
}

/** Display availability is not execution evidence or workflow completion. */
export function hasWorkflowTimelineContent(item: ConversationTimelineItem): boolean {
  if (item.kind === "subAgentActivity") return item.childItems.some(hasWorkflowTimelineContent);
  if (item.kind === "commandBatch") return item.batch.commands.some(hasWorkflowTimelineContent);
  if (item.kind === "explorationBatch") return item.batch.children.some(hasWorkflowTimelineContent);
  if (item.kind === "diagnostic") return item.code === "user_input_order_unavailable";
  if (item.kind === "agentMessage") return !!item.markdown.trim();
  if (item.kind === "protocolEvent") return Boolean(item.blockedExplanation) || isWorkflowIsolationTimelineItem(item);
  return ["userInputRequest", "userInputAnswer", "terminalReport", "approval",
    "commandExecution", "fileChange", "exploration", "mcpToolCall", "dynamicToolCall",
    "collabAgentToolCall", "imageView"].includes(item.kind);
}

/** A collaborative graph can accompany execution facts without replacing their native presentation. */
export function selectWorkflowTimelineItems(
  facts: readonly ConversationTimelineItem[],
  summary: ConversationTimelineProtocolEventItem,
  retainSummary: boolean,
): readonly ConversationTimelineItem[] {
  if (!facts.some(hasWorkflowTimelineContent)) return [summary];
  if (!retainSummary || facts.some(item => item.id === summary.id)) return facts;
  return [summary, ...facts];
}

/** Integration has one concise status owner; rounds and journals remain retained evidence. */
export function workflowConversationTimelineItems(
  items: readonly ConversationTimelineItem[],
  graphWorkflowIds: ReadonlySet<string>,
): readonly ConversationTimelineItem[] {
  const owners = new Set(items.flatMap(item => item.kind === "protocolEvent" && item.protocolKind === "workflow"
    ? item.sourceRefs.filter(ref => ref.kind === "channel_workflow" && graphWorkflowIds.has(ref.id)).map(ref => ref.id) : []));
  const approvalOwners = new Set(items.flatMap(item => item.kind === "protocolEvent" && isWorkflowIsolationTimelineItem(item)
    && item.availableActions?.includes("open_approval")
    ? item.sourceRefs.filter(ref => ref.kind === "workflow").map(ref => ref.id) : []));
  const terminalRoundOwners = new Set(items.flatMap(item => item.kind === "protocolEvent" && isWorkflowIsolationTimelineItem(item)
    && item.id.includes(":round:") && item.status === "succeeded"
    ? item.sourceRefs.filter(ref => ref.kind === "workflow").map(ref => ref.id) : []));
  return items.flatMap(item => {
    if (!isWorkflowIsolationTimelineItem(item) || item.kind !== "protocolEvent") return [item];
    const approval = item.availableActions?.includes("open_approval");
    const isRound = item.id.includes(":round:");
    const terminalRound = item.id.includes(":round:") && item.status === "succeeded";
    if (!isRound && !approval && item.sourceRefs.some(ref => ref.kind === "workflow" && terminalRoundOwners.has(ref.id))) return [];
    if (item.id.includes(":round:") && !approval && !terminalRound) return [];
    if (!approval && !terminalRound && (item.sourceRefs.some(ref => ref.kind === "workflow" && approvalOwners.has(ref.id))
      || item.status === "succeeded" && item.sourceRefs.some(ref => ref.kind === "workflow" && owners.has(ref.id)))) return [];
    return [{ ...item, title: item.status === "cancelled" && item.meta ? `${item.title} · ${item.meta}` : item.meta || item.title,
      meta: undefined, description: undefined, detailLines: undefined,
      availableActions: approval ? ["open_approval" as const] : [] }];
  });
}
