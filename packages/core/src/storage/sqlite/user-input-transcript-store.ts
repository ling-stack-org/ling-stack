import type { ConversationItemV1, LingThread, UserInputTranscriptItemV1, UserInputTranscriptSourceV1 } from "@ling-stack/contracts";
import type { RunStore } from "../../run-types.js";
import { ConversationItemStoreError } from "../../conversation-item-store-types.js";
import { UserInputStoreError, type ReadUserInputTranscript, type UserInputRequest } from "../../user-input-store-types.js";
import { DEFAULT_WORKSPACE_ID } from "../../workspace-types.js";
import type { SqliteStoreContext } from "./store-context.js";
import { readSqliteSnapshot } from "./read-snapshot.js";
import { readUserInputDelivery } from "./user-input-delivery-records.js";
import { readUserInputRunEventPosition } from "./user-input-event-position.js";
import { userInputHash, type UserInputRow } from "./user-input-records.js";
import { projectUserInputAnswerAuthority, type UserInputAnswerAuthorityPorts } from "./user-input-answer-authority.js";

type Ports = UserInputAnswerAuthorityPorts
  & Pick<RunStore, "getLingThread" | "getLingTurn" | "getConversationItem" | "getUserInputRequest">;
type Anchor = Extract<ConversationItemV1, { readonly kind: "user_input_request" | "user_input_answer" }>;

/** One read-only snapshot for canonical anchors, questions, answers and delivery revisions. No scheduling. */
export class SqliteUserInputTranscriptStore {
  constructor(private readonly context: SqliteStoreContext, private readonly ports: Ports,
    private readonly readReceipt: (threadId: string, deliveryId: string) => import("../../user-input-host-continuation-types.js").UserInputContinuationReceipt | undefined) {}

  read(input: ReadUserInputTranscript): readonly UserInputTranscriptItemV1[] {
    if (!input || typeof input.threadId !== "string" || !input.threadId.trim()
      || !Array.isArray(input.itemIds) || input.itemIds.length > 500
      || input.itemIds.some(id => typeof id !== "string" || !id.trim() || id.length > 256)) {
      throw new UserInputStoreError("invalid_input");
    }
    return readSqliteSnapshot(this.context.database, () => {
      const thread = this.ports.getLingThread(input.threadId);
      if (!thread || thread.workspaceId !== DEFAULT_WORKSPACE_ID || input.itemIds.length === 0) return [];
      const ids = [...new Set(input.itemIds)];
      // Scope and visibility are evaluated on columns before any model/user JSON is decoded.
      const rows = this.context.database.prepare("SELECT id,kind,visibility,visibility_owner_id,channel_id,sequence"
        + " FROM conversation_items WHERE workspace_id=? AND thread_id=? AND kind IN ('user_input_request','user_input_answer')"
        + " AND id IN (" + ids.map(() => "?").join(",") + ") ORDER BY sequence")
        .all(DEFAULT_WORKSPACE_ID, thread.id, ...ids);
      return rows.filter(row => visibleAnchor(row, thread)).map(row => {
        const itemId = String(row.id), kind = row.kind as Anchor["kind"];
        try {
          const item = this.ports.getConversationItem(itemId);
          if (!item || (item.kind !== "user_input_request" && item.kind !== "user_input_answer")) return unavailable(itemId, kind);
          return this.project(item, thread);
        } catch (error) {
          if (isInvalidContent(error)) return unavailable(itemId, kind);
          throw error; // Database/port failures are not missing content and must remain observable.
        }
      });
    });
  }

  private project(item: Anchor, thread: LingThread): UserInputTranscriptItemV1 {
    const request = this.ports.getUserInputRequest(thread.id, item.payload.requestId);
    if (!request || request.requestVersion !== item.payload.requestVersion) return unavailable(item.id, item.kind);
    const requestItem = item.kind === "user_input_request" ? item : this.ports.getConversationItem(request.itemId);
    const sourceItem = this.ports.getConversationItem(request.source.itemId);
    const turn = this.ports.getLingTurn(request.source.turnId);
    if (!turn || turn.workspaceId !== thread.workspaceId || turn.threadId !== thread.id || turn.channelId !== thread.channelId
      || !matchesRequestAnchor(requestItem, request) || !matchesSource(sourceItem, request, thread)) {
      return unavailable(item.id, item.kind);
    }
    const accepted = this.readAccepted(request);
    const source = publicSource(request);
    const runEventPosition = readUserInputRunEventPosition(this.context, item.payload.runEventPosition, request.source);
    const base = { availability: "available" as const, itemId: item.id, requestId: request.requestId,
      requestVersion: request.requestVersion, source, ...(runEventPosition ? { runEventPosition } : {}) };
    if (item.kind === "user_input_request") {
      const answerAuthority = projectUserInputAnswerAuthority(this.context, this.ports, request, new Date().toISOString());
      return { ...base, kind: item.kind, status: request.status, statusRevision: request.statusRevision,
        waitMode: request.waitMode,
        questions: request.questions.map(q => ({ questionId: q.questionId, prompt: q.prompt, required: q.required,
          allowFreeText: q.allowFreeText, options: q.options.map(o => ({ optionId: o.optionId, label: o.label })) })),
        createdAt: request.createdAt, updatedAt: request.updatedAt,
        ...(request.expiresAt ? { expiresAt: request.expiresAt } : {}),
        ...(answerAuthority ? { answerAuthority } : {}) };
    }
    if (!accepted || accepted.answer.itemId !== item.id || accepted.answer.answerId !== item.payload.answerId
      || !hasRef(item, "user_input_request", request.requestId)
      || !hasRef(item, "user_input_answer", item.payload.answerId)) return unavailable(item.id, item.kind);
    const { answer, delivery } = accepted;
    return { ...base, kind: item.kind, answerId: answer.answerId, acceptedAt: answer.acceptedAt,
      answers: answer.answers.map(value => {
        const question = request.questions.find(q => q.questionId === value.questionId)!;
        return value.kind === "option"
          ? { questionId: value.questionId, prompt: question.prompt, kind: value.kind, optionId: value.optionId,
              label: question.options.find(o => o.optionId === value.optionId)!.label }
          : { questionId: value.questionId, prompt: question.prompt, kind: value.kind, text: value.text };
      }),
      delivery: { status: delivery.status, revision: delivery.revision, updatedAt: delivery.updatedAt } };
  }

  private readAccepted(request: UserInputRequest): ReturnType<typeof readUserInputDelivery> {
    const rows = this.context.database.prepare("SELECT d.delivery_id FROM user_input_answers a"
      + " LEFT JOIN user_input_deliveries d ON d.answer_id=a.answer_id WHERE a.request_id=? AND a.request_version=?")
      .all(request.requestId, request.requestVersion);
    if (rows.length === 0 && request.status !== "answered") return undefined;
    if (rows.length !== 1 || typeof rows[0]!.delivery_id !== "string"
      || request.status === "pending" || request.status === "skipped") throw new UserInputStoreError("invalid_record");
    const record = readUserInputDelivery(this.context, this.ports, request.source.threadId, rows[0]!.delivery_id);
    // A bare applied bit is not receiver evidence. This joins the existing read snapshot.
    if (!record || record.delivery.status === "applied" && !this.readReceipt(request.source.threadId, record.delivery.deliveryId)) {
      throw new UserInputStoreError("invalid_record");
    }
    return record;
  }
}

function unavailable(itemId: string, kind: Anchor["kind"]): UserInputTranscriptItemV1 {
  return { itemId, kind, availability: "unavailable" };
}
function visibleAnchor(row: UserInputRow, thread: LingThread): boolean {
  if ((row.channel_id ?? undefined) !== thread.channelId) return false;
  if (row.visibility === "thread_participants") return row.visibility_owner_id === null;
  if (row.visibility === "channel") return Boolean(thread.channelId) && row.visibility_owner_id === null;
  return thread.kind === "teammate_direct" && !thread.channelId && row.visibility === "agent_private"
    && Boolean(thread.teammateId) && row.visibility_owner_id === thread.teammateId;
}
function sameItemScope(item: ConversationItemV1, request: UserInputRequest): boolean {
  const source = request.source;
  return item.workspaceId === source.workspaceId && item.threadId === source.threadId && item.turnId === source.turnId
    && item.channelId === source.channelId && item.visibility === source.visibility && item.visibilityOwnerId === source.visibilityOwnerId;
}
function hasRef(item: ConversationItemV1, type: string, id: string): boolean {
  return item.domainRefs.some(ref => ref.type === type && ref.id === id);
}
function matchesRequestAnchor(item: ConversationItemV1 | undefined, request: UserInputRequest): boolean {
  return Boolean(item && item.id === request.itemId && item.kind === "user_input_request" && item.status === "committed"
    && sameItemScope(item, request) && item.actorId === request.source.participantId
    && item.actorType === (request.source.participantId === "ling_agent" ? "ling_agent" : "teammate")
    && userInputHash(item.payload) === userInputHash({ requestId: request.requestId, requestVersion: request.requestVersion,
      ...(item.payload.runEventPosition ? { runEventPosition: item.payload.runEventPosition } : {}) })
    && hasRef(item, "user_input_request", request.requestId) && hasRef(item, "run", request.source.runId)
    && hasRef(item, "conversation_item", request.source.itemId));
}
function matchesSource(item: ConversationItemV1 | undefined, request: UserInputRequest, thread: LingThread): boolean {
  return Boolean(item && item.status === "committed" && sameItemScope(item, request)
    && request.source.workspaceId === thread.workspaceId && request.source.threadId === thread.id
    && request.source.channelId === thread.channelId
    && (thread.kind !== "teammate_direct" || request.source.participantId === thread.teammateId));
}
function publicSource(request: UserInputRequest): UserInputTranscriptSourceV1 {
  const source = request.source;
  return { workspaceId: source.workspaceId, threadId: source.threadId, turnId: source.turnId,
    runId: source.runId, attemptId: source.fence.attemptId, workUnitId: source.fence.workUnitId,
    participantId: source.participantId, sourceItemId: source.itemId,
    ...(source.workflowStepId ? { workflowStepId: source.workflowStepId } : {}) };
}
function isInvalidContent(error: unknown): boolean {
  return (error instanceof UserInputStoreError && (error.code === "invalid_record" || error.code === "sensitive_input"))
    || (error instanceof ConversationItemStoreError && error.code === "item_invalid");
}
