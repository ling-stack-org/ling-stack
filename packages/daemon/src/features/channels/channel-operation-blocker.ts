import type { Channel, ChannelMessage, RunStore } from "@ling-stack/core";
import { HttpError } from "../../errors.js";
import { buildConversationContextProjection } from "./context-processing/conversation-context-projector.js";
import { getChannelMessageView } from "./conversation-item-messages.js";
import { LING_AGENT_EXECUTOR_ID } from "./ling-agent-executor.js";
import { resolveChannelResponseLanguage } from "./response-language.js";

const errorCode = "operation_binding_host_capability_unavailable" as const;
type Input = { readonly store: RunStore; readonly channel: Channel; readonly sourceMessage: ChannelMessage };
export interface ChannelOperationBlockedResult {
  readonly action: "blocked";
  readonly errorCode: typeof errorCode;
  readonly aiReply: ChannelMessage;
  readonly intentDecisionId: string;
}

/** A Host publication failure cannot be caught as an invalid model response. */
export class ChannelOperationBlockerPublicationError extends Error {
  constructor(cause: unknown) { super("Could not persist the Host capability blocker.", { cause }); }
}

/** Replay a committed blocker, including recovery after its decision write failed. */
export function recoverChannelOperationBlocker(input: Input): ChannelOperationBlockedResult | undefined {
  try { return readChannelOperationBlocker(input); }
  catch (error) { throw error instanceof ChannelOperationBlockerPublicationError ? error : new ChannelOperationBlockerPublicationError(error); }
}

function readChannelOperationBlocker(input: Input): ChannelOperationBlockedResult | undefined {
  const source = input.store.getConversationItem(input.sourceMessage.id);
  if (!source?.turnId || source.channelId !== input.channel.id) return undefined;
  // Indexed lookup, never a scan of a long-running conversation's transcript.
  const item = input.store.getConversationItemByIdempotencyKey(source.threadId, blockerKey(source.id));
  const decision = input.store.listChannelIntentDecisions({ channelId: input.channel.id,
    sourceItemId: input.sourceMessage.id, limit: 100 }).find((item) => item.status === "failed" && item.errorCode === errorCode);
  if (!decision && !item) return undefined;
  if (!item || item.kind !== "assistant_message" || item.status !== "committed"
    || item.channelId !== source.channelId || item.threadId !== source.threadId || item.turnId !== source.turnId
    || item.actorType !== "ling_agent" || item.actorId !== LING_AGENT_EXECUTOR_ID
    || item.payload.deliveryStatus !== "blocked" || item.payload.errorMessage !== errorCode
    || !item.domainRefs.some((ref) => ref.type === "conversation_item" && ref.id === source.id)
    || input.store.getEffectiveConversationItem(item.id)?.id !== item.id) {
    throw new ChannelOperationBlockerPublicationError(new Error("Host capability blocker item has invalid ownership or state."));
  }
  const reply = getChannelMessageView(input.store, item.id);
  if (!reply) throw new ChannelOperationBlockerPublicationError(new Error("Host capability blocker item is unavailable."));
  if (decision && (decision.action !== "reply" || decision.resultItemIds.length !== 1 || decision.resultItemIds[0] !== reply.id)) {
    throw new ChannelOperationBlockerPublicationError(new Error("Host capability blocker lineage is incomplete."));
  }
  return decision ? { action: "blocked", errorCode, aiReply: reply, intentDecisionId: decision.id }
    : persistChannelOperationBlocker(input, reply);
}

export function publishChannelOperationBlocker(input: Input): ChannelOperationBlockedResult {
  return recoverChannelOperationBlocker(input) ?? persistChannelOperationBlocker(input);
}

/**
 * Publish one committed diagnostic and one failed decision. The committed item
 * is the recovery anchor if the second write fails; no plan or effect exists.
 * This is failure handling, not an implementation of the missing Host opener.
 */
function persistChannelOperationBlocker(input: Input, committedReply?: ChannelMessage): ChannelOperationBlockedResult {
  try {
    const source = input.store.getConversationItem(input.sourceMessage.id);
    if (!source?.turnId || source.channelId !== input.channel.id || source.status !== "committed") {
      throw new HttpError(409, "channel_operation_blocker_source_invalid", "Host capability blocker requires its committed source turn.");
    }
    const now = new Date().toISOString();
    const language = resolveChannelResponseLanguage({ store: input.store, channel: input.channel, sourceText: input.sourceMessage.body }).language;
    const body = language.startsWith("zh")
      ? "当前运行环境尚未接通打开本地文件的 Host 工具，未执行打开操作，也未启动任务。补充文件内容或授予 Bash 权限不能解决此能力缺失。"
      : "The Host tool for opening local files is not connected in this runtime. No file was opened and no task was started. Providing file contents or granting Bash access cannot enable this missing capability.";
    const item = committedReply ? undefined : input.store.appendConversationItem({
      channelId: source.channelId, threadId: source.threadId, turnId: source.turnId,
      kind: "assistant_message", status: "committed", actorType: "ling_agent", actorId: LING_AGENT_EXECUTOR_ID,
      visibility: "channel", payload: { body, format: "markdown", streaming: false, deliveryStatus: "blocked",
        presentationRole: "reply_result", errorMessage: errorCode },
      domainRefs: [{ type: "conversation_item", id: source.id }],
      idempotencyKey: blockerKey(source.id),
    }, now);
    const aiReply = committedReply ?? (item ? getChannelMessageView(input.store, item.id) : undefined);
    if (!aiReply) throw new Error("Host capability blocker item was not persisted.");
    const projection = buildConversationContextProjection({ store: input.store, sourceItemId: source.id, view: "selector" });
    const decision = input.store.createChannelIntentDecision({
      channelId: input.channel.id, sourceItemId: source.id, contextProjection: projection.metadata,
      // No executable plan was admitted. The reply is a FAILED diagnostic, not
      // an accepted ordinary-response fallback or a fabricated execute plan.
      action: "reply", status: "failed", createdBy: "model_policy", errorCode,
      reason: "Host rejected open_local_target: its independent executor and authorization are not connected.",
      resultItemIds: [aiReply.id],
    }, now);
    return { action: "blocked", errorCode, aiReply, intentDecisionId: decision.id };
  } catch (error) {
    throw error instanceof ChannelOperationBlockerPublicationError ? error : new ChannelOperationBlockerPublicationError(error);
  }
}
function blockerKey(sourceId: string): string { return `channel-operation-capability-blocker:${sourceId}`; }
