import { createHash } from "node:crypto";
import type {
  ConversationDomainRef,
  ConversationItemV1,
  ConversationAssistantMessagePayloadV1,
  ConversationItemVisibilityV1,
} from "@ling-stack/contracts";
import type { LingTurn, RunEventEnvelope, RunSession } from "./run-types.js";

/**
 * Read-only projection input for execution evidence.
 *
 * Run events remain the execution authority and Ling turns/items remain the
 * conversation authority. This function only builds a deterministic view for
 * rich timeline consumers; it never appends or mutates canonical items.
 */
export interface ProjectRunEventsToConversationItemsInput {
  readonly run: RunSession;
  readonly turn: LingTurn;
  readonly events: readonly RunEventEnvelope[];
  /** Existing projected items are used to make replay/update idempotent. */
  readonly existingItems?: readonly ConversationItemV1[];
}

/**
 * Projects typed run evidence into the existing ConversationItemV1 model.
 *
 * The returned sequence is projection-local and ordered by event sequence. A
 * caller that persists canonical items must use the ConversationItem store's
 * own sequence allocator instead of writing these values back directly.
 */
export function projectRunEventsToConversationItems(
  input: ProjectRunEventsToConversationItemsInput,
): readonly ConversationItemV1[] {
  const items = new Map<string, ConversationItemV1>();
  for (const item of input.existingItems ?? []) {
    if (item.threadId === input.turn.threadId && (!item.turnId || item.turnId === input.turn.id)) {
      items.set(item.id, item);
    }
  }

  const toolCallItemIds = new Map<string, string>();
  const approvalItemIds = new Map<string, string>();
  let assistantItem: Extract<ConversationItemV1, { readonly kind: "assistant_message" }> | undefined;
  let assistantBody = "";
  let assistantSequence = Number.POSITIVE_INFINITY;
  let assistantUpdatedAt = input.turn.updatedAt;

  for (const event of [...input.events].sort((left, right) => left.seq - right.seq)) {
    switch (event.type) {
      case "assistant_text_delta": {
        assistantBody += event.data.text;
        assistantSequence = Math.min(assistantSequence, event.seq);
        assistantUpdatedAt = event.ts;
        assistantItem = upsertAssistantItem({
          input,
          items,
          existing: assistantItem,
          body: assistantBody,
          sequence: assistantSequence,
          updatedAt: assistantUpdatedAt,
          streaming: true,
        });
        break;
      }
      case "message_end": {
        if (event.data.role === undefined || event.data.role === "assistant") {
          assistantSequence = Math.min(assistantSequence, event.seq);
          assistantUpdatedAt = event.ts;
          assistantItem = upsertAssistantItem({
            input,
            items,
            existing: assistantItem,
            body: event.data.text !== undefined ? event.data.text : assistantBody,
            sequence: assistantSequence,
            updatedAt: assistantUpdatedAt,
            streaming: false,
            errorMessage: event.data.errorMessage,
          });
        }
        break;
      }
      case "tool_start": {
        const toolCallId = event.data.toolCallId ?? `event_${event.seq}`;
        const id = deterministicItemId(input.run.id, "tool_call", toolCallId);
        toolCallItemIds.set(toolCallId, id);
        items.set(id, makeItem({
          input,
          id,
          sequence: event.seq,
          kind: "tool_call",
          payload: {
            toolCallId,
            toolName: event.data.toolName,
            title: event.data.toolName,
            ...(event.data.args !== undefined ? { inputSummary: summarizeOpaque(event.data.args) } : {}),
          },
          domainRefs: [runRef(input.run.id), turnRef(input.turn.id)],
          createdAt: event.ts,
          updatedAt: event.ts,
        }));
        break;
      }
      case "tool_end": {
        const toolCallId = event.data.toolCallId ?? `event_${event.seq}`;
        const id = deterministicItemId(input.run.id, "tool_result", toolCallId);
        const toolCallIdRef = toolCallItemIds.get(toolCallId);
        items.set(id, makeItem({
          input,
          id,
          sequence: event.seq,
          kind: "tool_result",
          payload: {
            toolCallId,
            status: event.data.isError ? "failed" : "succeeded",
            ...(event.data.result !== undefined ? { outputSummary: summarizeOpaque(event.data.result) } : {}),
          },
          domainRefs: [runRef(input.run.id), turnRef(input.turn.id), ...(toolCallIdRef ? [itemRef(toolCallIdRef)] : [])],
          createdAt: event.ts,
          updatedAt: event.ts,
        }));
        break;
      }
      case "approval_requested": {
        const id = deterministicItemId(input.run.id, "approval_request", event.data.approvalId);
        approvalItemIds.set(event.data.approvalId, id);
        items.set(id, makeItem({
          input,
          id,
          sequence: event.seq,
          kind: "approval_request",
          payload: {
            approvalRequestId: event.data.approvalId,
            title: event.data.title ?? "Approval required",
            ...(event.data.description ? { summary: event.data.description } : {}),
          },
          domainRefs: [runRef(input.run.id), turnRef(input.turn.id), approvalRef(event.data.approvalId)],
          createdAt: event.ts,
          updatedAt: event.ts,
        }));
        break;
      }
      case "approval_approved":
      case "approval_denied":
      case "approval_cancelled":
      case "approval_expired": {
        const approvalId = event.data.approvalId;
        const id = deterministicItemId(input.run.id, "approval_decision", approvalId);
        items.set(id, makeItem({
          input,
          id,
          sequence: event.seq,
          kind: "approval_decision",
          payload: {
            approvalRequestId: approvalId,
            decision: event.type === "approval_approved" ? "approved" : event.type === "approval_cancelled" ? "cancelled" : "denied",
            ...(event.data.decisionReason ? { reason: event.data.decisionReason } : {}),
          },
          domainRefs: [runRef(input.run.id), turnRef(input.turn.id), approvalRef(approvalId), ...(approvalItemIds.has(approvalId) ? [itemRef(approvalItemIds.get(approvalId)!)] : [])],
          createdAt: event.ts,
          updatedAt: event.ts,
        }));
        break;
      }
      case "artifact_created": {
        const artifactId = readArtifactId(event.data.artifactId, event.data.artifact);
        if (!artifactId) break;
        const id = deterministicItemId(input.run.id, "artifact_ref", artifactId);
        items.set(id, makeItem({
          input,
          id,
          sequence: event.seq,
          kind: "artifact_ref",
          payload: {
            artifactId,
            ...(event.data.toolName ? { title: event.data.toolName } : {}),
            ...(readArtifactKind(event.data.artifact) ? { artifactKind: readArtifactKind(event.data.artifact) } : {}),
          },
          domainRefs: [runRef(input.run.id), turnRef(input.turn.id), { type: "artifact", id: artifactId }],
          createdAt: event.ts,
          updatedAt: event.ts,
        }));
        break;
      }
      case "run_end": {
        const item = makeOperationStateItem(input, event.seq, event.ts, "succeeded", "Run completed");
        items.set(item.id, item);
        break;
      }
      case "run_cancelled": {
        const item = makeOperationStateItem(input, event.seq, event.ts, "cancelled", event.data.reason ?? "Run cancelled");
        items.set(item.id, item);
        break;
      }
      case "run_error": {
        const item = makeOperationStateItem(input, event.seq, event.ts, "failed", event.data.message);
        items.set(item.id, item);
        break;
      }
      case "run_intervention_created":
      case "run_followup_queued":
      case "run_interrupt_requested":
      case "run_continuation_starting":
      case "run_continuation_started":
      case "run_intervention_failed": {
        const operationId = event.data.interventionId ?? `event_${event.seq}`;
        const state = event.type === "run_intervention_failed" ? "failed" : event.type === "run_continuation_started" ? "running" : "pending";
        items.set(deterministicItemId(input.run.id, "operation_state", operationId), makeOperationStateItem(input, event.seq, event.ts, state, event.type, operationId));
        break;
      }
      default:
        // run_created/start, thinking, hydration, tool_update, result and
        // stale diagnostics remain execution evidence rather than timeline
        // items. They are still available through the typed event stream.
        break;
    }
  }

  return [...items.values()].sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id));
}

function upsertAssistantItem(input: {
  readonly input: ProjectRunEventsToConversationItemsInput;
  readonly items: Map<string, ConversationItemV1>;
  readonly existing?: Extract<ConversationItemV1, { readonly kind: "assistant_message" }>;
  readonly body: string;
  readonly sequence: number;
  readonly updatedAt: string;
  readonly streaming: boolean;
  readonly errorMessage?: string;
}): Extract<ConversationItemV1, { readonly kind: "assistant_message" }> {
  const id = deterministicItemId(input.input.run.id, "assistant_message", "run");
  const existing = input.existing ?? input.items.get(id);
  const deliveryStatus: ConversationAssistantMessagePayloadV1["deliveryStatus"] = input.errorMessage
    ? "failed"
    : input.streaming
      ? "pending"
      : "ready";
  const item = makeItem({
    input: input.input,
    id,
    sequence: Number.isFinite(input.sequence) ? input.sequence : 1,
    kind: "assistant_message",
    payload: {
      body: input.body,
      format: "markdown",
      streaming: input.streaming,
      deliveryStatus,
      ...(input.errorMessage ? { errorMessage: input.errorMessage } : {}),
    },
    domainRefs: [runRef(input.input.run.id), turnRef(input.input.turn.id)],
    createdAt: existing?.createdAt ?? input.updatedAt,
    updatedAt: input.updatedAt,
    revision: existing?.revision ?? 0,
  });
  input.items.set(id, item);
  return item;
}

function makeOperationStateItem(
  input: ProjectRunEventsToConversationItemsInput,
  sequence: number,
  updatedAt: string,
  state: "pending" | "running" | "succeeded" | "failed" | "cancelled",
  summary: string,
  operationId = input.run.id,
): Extract<ConversationItemV1, { readonly kind: "operation_state" }> {
  return makeItem({
    input,
    id: deterministicItemId(input.run.id, "operation_state", operationId),
    sequence,
    kind: "operation_state",
    payload: { operationId, state, title: "Run operation", summary },
    domainRefs: [runRef(input.run.id), turnRef(input.turn.id)],
    createdAt: updatedAt,
    updatedAt,
  });
}

function makeItem<K extends ConversationItemV1["kind"]>(input: {
  readonly input: ProjectRunEventsToConversationItemsInput;
  readonly id: string;
  readonly sequence: number;
  readonly kind: K;
  readonly payload: Extract<ConversationItemV1, { readonly kind: K }>["payload"];
  readonly domainRefs: readonly ConversationDomainRef[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revision?: number;
}): Extract<ConversationItemV1, { readonly kind: K }> {
  const channelId = input.input.turn.channelId ?? input.input.run.channelId;
  const visibility: ConversationItemVisibilityV1 = channelId ? "channel" : "thread_participants";
  return {
    schemaVersion: 1,
    id: input.id,
    workspaceId: input.input.turn.workspaceId,
    ...(channelId ? { channelId } : {}),
    threadId: input.input.turn.threadId,
    turnId: input.input.turn.id,
    sequence: input.sequence,
    kind: input.kind,
    status: "committed",
    actorType: "ling_agent",
    visibility,
    payload: input.payload,
    domainRefs: input.domainRefs,
    revision: input.revision ?? 0,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    committedAt: input.updatedAt,
  } as Extract<ConversationItemV1, { readonly kind: K }>;
}

function deterministicItemId(runId: string, kind: string, key: string): string {
  const digest = createHash("sha256").update(`${runId}\0${kind}\0${key}`).digest("hex").slice(0, 24);
  return `projection_${kind}_${digest}`;
}

function runRef(id: string): ConversationDomainRef {
  return { type: "run", id };
}

function turnRef(id: string): ConversationDomainRef {
  return { type: "turn", id };
}

function approvalRef(id: string): ConversationDomainRef {
  return { type: "approval", id };
}

function itemRef(id: string): ConversationDomainRef {
  return { type: "conversation_item", id };
}

function summarizeOpaque(value: unknown): string {
  if (typeof value === "string") return value.slice(0, 500);
  try {
    return JSON.stringify(value).slice(0, 500);
  } catch {
    return "[unserializable]";
  }
}

function readArtifactId(explicitId: string | undefined, artifact: unknown): string | undefined {
  if (explicitId) return explicitId;
  if (typeof artifact === "object" && artifact !== null && !Array.isArray(artifact)) {
    const id = (artifact as Record<string, unknown>).id;
    return typeof id === "string" && id.length > 0 ? id : undefined;
  }
  return undefined;
}

function readArtifactKind(artifact: unknown): string | undefined {
  if (typeof artifact !== "object" || artifact === null || Array.isArray(artifact)) return undefined;
  const type = (artifact as Record<string, unknown>).type;
  return typeof type === "string" ? type : undefined;
}
