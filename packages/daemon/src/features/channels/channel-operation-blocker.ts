import type { Channel, ChannelMessage, RunStore } from "@ling-stack/core";
import { HttpError } from "../../errors.js";
import { buildConversationContextProjection } from "./context-processing/conversation-context-projector.js";
import { getChannelMessageView } from "./conversation-item-messages.js";
import { LING_AGENT_EXECUTOR_ID } from "./ling-agent-executor.js";
import { resolveChannelResponseLanguage } from "./response-language.js";

const blockers = {
  operation_binding_input_read_unavailable: {
    key: "channel-operation-input-read-blocker",
    reason: "Host could not verify effective channel/participant read authority or the execution root. No inherited inputs or commands were started.",
    zh: "Host 无法确认本次命令的频道/队友有效读取权限或工作区位置，未准备额外依赖，也未启动任务。请检查该项目位置及读取权限；重复提供依赖目录不能代替权限校验，命令审批也不会自动授予额外读取权限。",
    en: "The Host could not verify effective channel/participant read permission or the project location. No extra dependencies or task were started. Check that project's location and read permission; repeating a directory or approving the command does not grant additional read access.",
  },
  operation_binding_host_capability_unavailable: {
    key: "channel-operation-capability-blocker",
    reason: "Host rejected open_local_target: its independent executor and authorization are not connected.",
    zh: "当前运行环境尚未接通打开本地文件的 Host 工具，未执行打开操作，也未启动任务。补充文件内容或授予 Bash 权限不能解决此能力缺失。",
    en: "The Host tool for opening local files is not connected in this runtime. No file was opened and no task was started. Providing file contents or granting Bash access cannot enable this missing capability.",
  },
  channel_intent_selection_failed: {
    key: "channel-intent-selection-blocker",
    reason: "Channel intent selection failed before a source-bound plan could be admitted. No ordinary-reply fallback or execution was started.",
    zh: "本次请求的操作规划未能完成校验，未启动任何队友、工具或任务。请重试本次请求；无需额外授予权限。",
    en: "The request could not be validated during operation planning. No teammate, tool or task was started. Retry the request; no additional permissions are needed.",
  },
  channel_operation_plan_invalid: {
    key: "channel-operation-plan-blocker",
    reason: "The model operation candidate failed Host schema or source binding after bounded selection. No plan or execution was admitted.",
    zh: "本次操作规划未通过格式或来源校验，未启动任何队友、工具或任务。无需重新列出本来没有的文件，也无需增加权限；可重试本次请求。",
    en: "The operation plan failed schema or source validation. No teammate, tool or task was started. No extra file inputs or permissions are needed; retry the request.",
  },
  channel_pending_operation_authority_changed: {
    key: "channel-pending-authority-blocker",
    reason: "The pending operation's frozen authority no longer matches the effective channel, participant, workspace or sandbox policy. No plan or execution was admitted; restoring permissions does not resume it.",
    zh: "等待确认期间，频道、队友、工作范围或沙盒权限已变化，原待执行操作已过期，未启动任何队友、工具或任务。补充回答或恢复原权限都不会自动继续；如仍需执行，请按当前权限发起新的任务。",
    en: "Channel, participant, workspace or sandbox authorization changed while confirmation was pending. The original operation has expired; no teammate, tool or task was started. Answering or restoring permissions will not resume it. If execution is still needed, create a new task under the current permissions.",
  },
} as const;
type BlockerCode = keyof typeof blockers;
const capabilityCode = "operation_binding_host_capability_unavailable" as const;
type Input = { readonly store: RunStore; readonly channel: Channel; readonly sourceMessage: ChannelMessage };
export interface ChannelOperationBlockedResult {
  readonly action: "blocked";
  readonly errorCode: BlockerCode;
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
  // Fixed indexed lookups, never a scan of a long-running transcript. Each
  // diagnostic keeps its own error identity and the original capability key.
  for (const errorCode of Object.keys(blockers) as BlockerCode[]) {
    const result = readBlocker(input, errorCode);
    if (result) return result;
  }
  return undefined;
}

function readBlocker(input: Input, errorCode: BlockerCode): ChannelOperationBlockedResult | undefined {
  const source = input.store.getConversationItem(input.sourceMessage.id)!;
  const item = input.store.getConversationItemByIdempotencyKey(source.threadId, blockerKey(source.id, errorCode));
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
    : persistChannelOperationBlocker(input, errorCode, reply);
}

export function publishChannelOperationBlocker(input: Input, errorCode: BlockerCode = capabilityCode): ChannelOperationBlockedResult {
  return recoverChannelOperationBlocker(input) ?? persistChannelOperationBlocker(input, errorCode);
}

/**
 * Publish one committed diagnostic and one failed decision. The committed item
 * is the recovery anchor if the second write fails; no plan or effect exists.
 * This is failure handling, not an implementation of the missing Host opener.
 */
function persistChannelOperationBlocker(input: Input, errorCode: BlockerCode, committedReply?: ChannelMessage): ChannelOperationBlockedResult {
  try {
    const source = input.store.getConversationItem(input.sourceMessage.id);
    if (!source?.turnId || source.channelId !== input.channel.id || source.status !== "committed") {
      throw new HttpError(409, "channel_operation_blocker_source_invalid", "Host capability blocker requires its committed source turn.");
    }
    const now = new Date().toISOString();
    const language = resolveChannelResponseLanguage({ store: input.store, channel: input.channel, sourceText: input.sourceMessage.body }).language;
    const diagnostic = blockers[errorCode];
    const body = language.startsWith("zh") ? diagnostic.zh : diagnostic.en;
    const item = committedReply ? undefined : input.store.appendConversationItem({
      channelId: source.channelId, threadId: source.threadId, turnId: source.turnId,
      kind: "assistant_message", status: "committed", actorType: "ling_agent", actorId: LING_AGENT_EXECUTOR_ID,
      visibility: "channel", payload: { body, format: "markdown", streaming: false, deliveryStatus: "blocked",
        presentationRole: "reply_result", errorMessage: errorCode },
      domainRefs: [{ type: "conversation_item", id: source.id }],
      idempotencyKey: blockerKey(source.id, errorCode),
    }, now);
    const aiReply = committedReply ?? (item ? getChannelMessageView(input.store, item.id) : undefined);
    if (!aiReply) throw new Error("Host capability blocker item was not persisted.");
    const projection = buildConversationContextProjection({ store: input.store, sourceItemId: source.id, view: "selector" });
    const decision = input.store.createChannelIntentDecision({
      channelId: input.channel.id, sourceItemId: source.id, contextProjection: projection.metadata,
      // No executable plan was admitted. The reply is a FAILED diagnostic, not
      // an accepted ordinary-response fallback or a fabricated execute plan.
      action: "reply", status: "failed", createdBy: "model_policy", errorCode,
      reason: diagnostic.reason,
      resultItemIds: [aiReply.id],
    }, now);
    return { action: "blocked", errorCode, aiReply, intentDecisionId: decision.id };
  } catch (error) {
    throw error instanceof ChannelOperationBlockerPublicationError ? error : new ChannelOperationBlockerPublicationError(error);
  }
}
function blockerKey(sourceId: string, code: BlockerCode): string { return `${blockers[code].key}:${sourceId}`; }
