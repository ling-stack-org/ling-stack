import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  CorrectChannelTurnContextRequest,
  CorrectChannelTurnContextResponse,
  ConversationItemV1,
} from "@ling-stack/contracts";
import type { RunStore } from "@ling-stack/core";
import type { ResolvedDaemonConfig } from "../../config.js";
import { HttpError } from "../../errors.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { readJsonBody } from "../../shared/request.js";
import { writeJson } from "../../shared/response.js";
import { isRecord, readString } from "../../shared/validation.js";
import { buildConversationContextProjection } from "./context-processing/conversation-context-projector.js";

const USER_CONTEXT_CORRECTION_POLICY_VERSION = "continuity-v2-user-correction-v1";

export async function handleChannelTurnContext(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  channelId: string,
  turnId: string,
  correction: boolean,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }
  try {
    const store = storeRegistry.getStore(cwd);
    const lineage = resolveChannelTurnLineage(store, channelId, turnId);
    if (correction) {
      if (request.method !== "POST") {
        writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for context corrections` });
        return;
      }
      const body = await readJsonBody(request, config.maxBodyBytes);
      const input = parseContextCorrection(body);
      const target = store.getContextSegment(input.segmentId);
      if (!target || target.threadId !== lineage.thread.id || target.state === "archived" || target.state === "merged") {
        throw new HttpError(400, "context_segment_unavailable", `Context segment is not available to this turn: ${input.segmentId}`);
      }
      const previousAssignment = store.getEffectiveTurnContextAssignment(turnId);
      if (!previousAssignment) {
        throw new HttpError(409, "context_assignment_missing", `Turn has no effective context assignment: ${turnId}`);
      }
      let result;
      try {
        result = store.applyTurnContextAssignment({
          turnId,
          expectedPreviousRevision: input.expectedAssignmentRevision,
          target: { kind: "existing", segmentId: target.id },
          status: "committed",
          decisionSource: "user",
          evidenceRefs: [
            { type: "turn", id: turnId },
            { type: "segment", id: target.id },
          ],
          policyVersion: USER_CONTEXT_CORRECTION_POLICY_VERSION,
        }, new Date().toISOString());
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("Context assignment revision conflict:")) {
          throw new HttpError(409, "context_assignment_revision_conflict", error.message);
        }
        throw error;
      }
      const projection = buildConversationContextProjection({
        store,
        sourceItemId: lineage.sourceItem.id,
        view: "inspect",
      });
      const payload: CorrectChannelTurnContextResponse = {
        cwd,
        channelId,
        thread: lineage.thread,
        turn: lineage.turn,
        segment: result.segment,
        assignment: result.assignment,
        previousAssignment,
        invalidatedSummaryIds: result.invalidatedSummaryIds,
        projection: projection.metadata,
        idempotentReplay: result.idempotentReplay,
      };
      writeJson(response, 200, payload);
      return;
    }

    if (request.method !== "GET") {
      writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for context inspect` });
      return;
    }
    const projection = buildConversationContextProjection({
      store,
      sourceItemId: lineage.sourceItem.id,
      view: "inspect",
    });
    const candidates = store.listConversationItemsForSegment({
      threadId: lineage.thread.id,
      segmentId: projection.segment.id,
      throughSequence: lineage.sourceItem.sequence,
      order: "oldest",
      limit: 500,
    });
    const projectedIds = new Set(projection.items.map((item) => item.id));
    const redactedItemCount = candidates.filter((item) =>
      item.visibility === "agent_private" && !projectedIds.has(item.id)).length;
    writeJson(response, 200, {
      cwd,
      channelId,
      thread: lineage.thread,
      turn: lineage.turn,
      sourceItemId: lineage.sourceItem.id,
      segment: projection.segment,
      assignment: projection.assignment,
      projection: projection.metadata,
      summaries: projection.summaries,
      sourceRefs: projection.metadata.sourceRefs,
      droppedItemCount: Math.max(0, candidates.length - projection.items.length),
      redactedItemCount,
      safety: {
        rawPromptTextIncluded: false,
        hiddenReasoningIncluded: false,
        privateMemoryBodiesIncluded: false,
        secretValuesIncluded: false,
      },
    });
  } catch (error) {
    writeJson(response, error instanceof HttpError ? error.statusCode : 400, {
      error: error instanceof HttpError ? error.code : "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function resolveChannelTurnLineage(store: RunStore, channelId: string, turnId: string): {
  readonly turn: NonNullable<ReturnType<RunStore["getLingTurn"]>>;
  readonly thread: NonNullable<ReturnType<RunStore["getLingThread"]>>;
  readonly sourceItem: ConversationItemV1;
} {
  const channel = store.getChannel(channelId);
  if (!channel) throw new HttpError(404, "channel_not_found", `Channel not found: ${channelId}`);
  const turn = store.getLingTurn(turnId);
  if (!turn || turn.channelId !== channelId) {
    throw new HttpError(404, "channel_turn_not_found", `Channel turn not found: ${turnId}`);
  }
  const thread = store.getLingThread(turn.threadId);
  if (!thread || thread.channelId !== channelId) {
    throw new HttpError(404, "channel_thread_not_found", `Channel thread not found: ${turn.threadId}`);
  }
  const sourceItem = turn.sourceItemId
    ? store.getEffectiveConversationItem(turn.sourceItemId)
    : store.listConversationItemsForTurn({ turnId }).find((item) => item.kind === "user_message");
  if (!sourceItem || sourceItem.threadId !== thread.id || sourceItem.turnId !== turn.id) {
    throw new HttpError(409, "channel_turn_source_missing", `Channel turn has no effective source item: ${turnId}`);
  }
  return { turn, thread, sourceItem };
}

function parseContextCorrection(value: unknown): CorrectChannelTurnContextRequest {
  if (!isRecord(value)) throw new Error("Context correction body must be a JSON object");
  const allowed = new Set(["segmentId", "expectedAssignmentRevision"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`Context correction contains unsupported field: ${key}`);
  }
  const segmentId = readString(value, "segmentId");
  const expectedAssignmentRevision = value.expectedAssignmentRevision;
  if (!Number.isSafeInteger(expectedAssignmentRevision) || Number(expectedAssignmentRevision) < 1) {
    throw new Error("expectedAssignmentRevision must be a positive safe integer");
  }
  return { segmentId, expectedAssignmentRevision: Number(expectedAssignmentRevision) };
}
