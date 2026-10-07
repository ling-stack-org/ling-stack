import type {
  ConversationOperationSourceRef,
  ConversationTimelineItem,
} from "@ling-stack/conversation-ui-core";
import { issueWorkspaceFileCapability } from "../../../api.js";
import {
  publishTimelineWorkspaceFileCapability,
  resolveTimelineWorkspaceFileCapability,
  type TimelineFileCapabilityContext,
  type TimelineWorkspaceFileTarget,
} from "./workspace-file-capability-core.js";

export type {
  TimelineFileCapabilityContext,
  TimelineWorkspaceFileCapabilityIssuer,
  TimelineWorkspaceFileTarget,
} from "./workspace-file-capability-core.js";
export { capabilityTargetForRef, timelineCapabilityScope } from "./workspace-file-capability-core.js";

/**
 * Mint a Host capability from an atomic timeline item's durable lineage and
 * return a Dock target carrying the capability. Raw paths never become
 * authority and are not used as a fallback when lineage is incomplete.
 */
export async function openTimelineWorkspaceFile(
  ref: ConversationOperationSourceRef,
  item: ConversationTimelineItem | undefined,
  context: TimelineFileCapabilityContext,
): Promise<TimelineWorkspaceFileTarget> {
  return resolveTimelineWorkspaceFileCapability(ref, item, context, issueWorkspaceFileCapability);
}

/**
 * Resolve a lineaged file ref and publish it to a surface only after the Host
 * has issued the capability. A failed request therefore cannot open the Dock.
 */
export async function requestTimelineWorkspaceFileOpen(
  ref: ConversationOperationSourceRef,
  item: ConversationTimelineItem | undefined,
  context: TimelineFileCapabilityContext,
  onOpen: (target: TimelineWorkspaceFileTarget) => void,
): Promise<void> {
  return publishTimelineWorkspaceFileCapability(ref, item, context, onOpen, issueWorkspaceFileCapability);
}
