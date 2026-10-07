import type {
  ConversationOperationSourceRef,
  ConversationTimelineItem,
} from "@ling-stack/conversation-ui-core";
import type {
  WorkspaceFileCapabilityRequest,
  WorkspaceFileCapabilityResponse,
  WorkspaceFileCapabilityScope,
  WorkspaceFileCapabilityTarget,
} from "@ling-stack/contracts";

export interface TimelineFileCapabilityContext {
  readonly cwd: string;
  readonly workspaceId?: string;
  readonly threadId?: string;
}

export interface TimelineWorkspaceFileTarget {
  readonly cwd: string;
  readonly path: string;
  readonly line?: number;
  readonly label?: string;
  readonly capabilityId: string;
  readonly capabilityTarget: WorkspaceFileCapabilityTarget;
  readonly capabilityScope: WorkspaceFileCapabilityScope;
}

export type TimelineWorkspaceFileCapabilityIssuer = (
  input: WorkspaceFileCapabilityRequest,
) => Promise<WorkspaceFileCapabilityResponse>;

/** Pure except for the injected Host issuer, so capability semantics are testable. */
export async function resolveTimelineWorkspaceFileCapability(
  ref: ConversationOperationSourceRef,
  item: ConversationTimelineItem | undefined,
  context: TimelineFileCapabilityContext,
  issueCapability: TimelineWorkspaceFileCapabilityIssuer,
): Promise<TimelineWorkspaceFileTarget> {
  const scope = timelineCapabilityScope(ref, item, context);
  if (!scope) {
    throw new Error("This file reference has no executable evidence lineage.");
  }
  const refId = ref.id.trim() || ref.path?.trim();
  if (!refId) {
    throw new Error("This file reference has no durable source id.");
  }
  const response = await issueCapability({
    cwd: context.cwd,
    capabilityTarget: capabilityTargetForRef(ref),
    refId,
    scope,
  });
  return {
    cwd: response.cwd,
    path: response.capability.displayPath,
    label: ref.label ?? response.capability.displayPath.split(/[\\/]/u).filter(Boolean).at(-1) ?? response.capability.displayPath,
    capabilityId: response.capability.capabilityId,
    capabilityTarget: response.capability.capabilityTarget,
    capabilityScope: response.capability.scope,
  };
}

export function capabilityTargetForRef(
  ref: Pick<ConversationOperationSourceRef, "kind" | "hostTarget">,
): WorkspaceFileCapabilityTarget {
  if (ref.hostTarget === "open_artifact") return "open_artifact";
  if (ref.hostTarget === "open_diff") return "open_diff";
  if (ref.kind === "artifact") return "open_artifact";
  if (ref.kind === "diff") return "open_diff";
  return "open_file";
}

/** A failed Host request cannot publish a target to any conversation surface. */
export async function publishTimelineWorkspaceFileCapability(
  ref: ConversationOperationSourceRef,
  item: ConversationTimelineItem | undefined,
  context: TimelineFileCapabilityContext,
  onOpen: (target: TimelineWorkspaceFileTarget) => void,
  issueCapability: TimelineWorkspaceFileCapabilityIssuer,
): Promise<void> {
  const target = await resolveTimelineWorkspaceFileCapability(ref, item, context, issueCapability);
  onOpen(target);
}

export function timelineCapabilityScope(
  ref: ConversationOperationSourceRef,
  item: ConversationTimelineItem | undefined,
  context: Pick<TimelineFileCapabilityContext, "workspaceId" | "threadId">,
): WorkspaceFileCapabilityScope | undefined {
  const workspaceId = context.workspaceId ?? ref.workspaceId;
  const threadId = context.threadId;
  const runId = item?.runId;
  const actionId = item?.actionId;
  const participantId = item?.participantId;
  if (!workspaceId?.trim() || !threadId?.trim() || !runId?.trim() || !actionId?.trim() || !participantId?.trim()) {
    return undefined;
  }
  const workflowStepId = item?.workflowStepId?.trim();
  return {
    workspaceId: workspaceId.trim(),
    threadId: threadId.trim(),
    runId: runId.trim(),
    actionId: actionId.trim(),
    participantId: participantId.trim(),
    ...(workflowStepId ? { workflowStepId } : {}),
  };
}
