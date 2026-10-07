import {
  DEFAULT_WORKSPACE_ID,
  type RunEventEnvelope,
  type RunStore,
} from "@ling-stack/core";
import type { ControlPlaneEventHub } from "../control-plane/events.js";
import { appendControlPlaneEvent } from "../control-plane/events.js";

/**
 * Publish the durable revision of one tool action through the existing
 * control-plane stream. The Run event remains authoritative; this event only
 * invalidates live projections so tool_update is visible before tool_end.
 */
export function appendExecutionActionInvalidation(input: {
  readonly store: RunStore;
  readonly hub: ControlPlaneEventHub | undefined;
  readonly cwd: string;
  readonly event: RunEventEnvelope;
}): void {
  if (!input.hub || !isToolLifecycleEvent(input.event)) {
    return;
  }
  const toolCallId = readToolCallId(input.event);
  if (!toolCallId) {
    return;
  }
  const actionId = `tool:${input.event.runId}:${toolCallId}`;
  appendControlPlaneEvent(input.store, input.hub, {
    workspaceId: DEFAULT_WORKSPACE_ID,
    cwd: input.cwd,
    domain: "runs",
    entityType: "execution_action",
    entityId: actionId,
    action: "execution_action.revised",
    data: {
      runId: input.event.runId,
      toolCallId,
      runEventType: input.event.type,
      actionRevision: input.event.seq,
    },
    idempotencyKey: `execution-action-revision:${actionId}:${input.event.seq}`,
  }, input.event.ts);
}

function isToolLifecycleEvent(event: RunEventEnvelope): boolean {
  return event.type === "tool_start" || event.type === "tool_update" || event.type === "tool_end";
}

function readToolCallId(event: RunEventEnvelope): string | undefined {
  if (!event.data || typeof event.data !== "object" || !("toolCallId" in event.data)) {
    return undefined;
  }
  const value = event.data.toolCallId;
  return typeof value === "string" && value.trim() ? value : undefined;
}
