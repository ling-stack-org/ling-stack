import { randomUUID } from "node:crypto";
import { DEFAULT_WORKSPACE_ID, type Channel, type ChannelMessage, type RunStore } from "@ling-stack/core";
import type { ChannelOperationCandidateShapeIssue } from "./channel-operation-bindings.js";

export type ChannelIntentRequestPurpose = "initial" | "compaction_retry" | "format_repair" | "binding_repair";
type Observation = {
  readonly phase: "request_started" | "request_finished" | "validation";
  readonly outcome: "started" | "completed" | "context_length_error" | "transport_error"
    | "intent_schema_rejected" | "intent_schema_accepted" | "shape_rejected" | "binding_rejected"
    | "bound" | "capability_blocked" | "repair_action_rejected";
  readonly issue?: ChannelOperationCandidateShapeIssue;
  readonly fields?: readonly string[];
};

/** Do not turn Host persistence errors into a model failure or a repair request. */
export class ChannelIntentDiagnosticPersistenceError extends Error {
  constructor(cause: unknown) { super("Could not persist channel planning diagnostics.", { cause }); }
}

/** Lineage and fixed validation codes only; no model output or exception text. */
export function createChannelIntentDiagnostics(input: {
  readonly store: RunStore; readonly channel: Channel; readonly sourceMessage: ChannelMessage;
}) {
  const selectionId = randomUUID();
  let observation = 0;
  return (requestOrdinal: number, purpose: ChannelIntentRequestPurpose, event: Observation): void => {
    try {
      input.store.appendControlPlaneEvent({
        workspaceId: DEFAULT_WORKSPACE_ID, cwd: input.store.paths.cwd,
        domain: "runners", entityType: "channel_intent_selection", entityId: input.sourceMessage.id,
        action: `channel_intent.${event.phase}`,
        idempotencyKey: `channel-intent:${selectionId}:${++observation}`,
        data: { schemaVersion: 1, selectionId, channelId: input.channel.id, sourceItemId: input.sourceMessage.id,
          requestOrdinal, purpose, outcome: event.outcome,
          ...(event.issue ? { issue: event.issue } : {}), ...(event.fields ? { fields: event.fields } : {}) },
      }, new Date().toISOString());
    } catch (cause) {
      throw new ChannelIntentDiagnosticPersistenceError(cause);
    }
  };
}
