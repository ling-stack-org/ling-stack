import type {
  ChannelConversationItemDecoration,
  ChannelConversationItemPageResponse,
  ChannelConversationThread,
  ChannelConversationTurnResponse,
  ConversationItemV1,
  LingTurn,
} from "@ling-stack/contracts";
import type { Channel, ChannelMessage, RunSession, RunStore } from "@ling-stack/core";
import {
  filterSupersededChannelMessages,
  projectChannelMessageRevisionMetadata,
  buildConversationSupersessionProjection,
} from "../conversations/supersession-projection.js";
import {
  enrichChannelMessageWithWebEvidence,
  enrichChannelMessagesWithWebEvidence,
} from "../web/message-web-evidence.js";
import { filterQueuedChannelReplyMessages } from "./channel-reply-message-visibility.js";
import type { ChannelReplyDispatchCoordinator } from "./channel-reply-dispatch-coordinator.js";
import { getChannelMessageView } from "./conversation-item-messages.js";
import { buildConversationGeneratedMediaProjection } from "../media/conversation-projection.js";
import { terminalReportIsEligibleForDisplay } from "./terminal-report-eligibility.js";
import { projectConversationUserInputs } from "../conversations/user-input-transcript.js";
import { projectConversationRuntimeMetrics } from "../conversations/runtime-metrics-projection.js";
import { listAllConversationTurns } from "../conversations/all-turns.js";
import { projectConversationReasoningSummaries } from "../conversations/reasoning-summary-projection.js";
import { projectConversationContextCompactions } from "../conversations/context-compaction-projection.js";
import { projectPublicConversationItem, projectPublicLingThread, projectPublicLingTurn } from "../runs/public-execution-snapshots.js";

export function listChannelConversationItems(input: {
  readonly store: RunStore;
  readonly cwd: string;
  readonly channel: Channel;
  readonly thread: ChannelConversationThread;
  readonly beforeSequence?: number;
  readonly limit?: number;
  readonly replyDispatchCoordinator?: ChannelReplyDispatchCoordinator;
}): ChannelConversationItemPageResponse {
  assertChannelThread(input.channel.id, input.thread);
  const page = input.store.listConversationItemsPage({
    threadId: input.thread.id,
    ...(input.beforeSequence !== undefined ? { beforeSequence: input.beforeSequence } : {}),
    effectiveOnly: true,
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
  });
  const selectedItems = filterVisibleTimelineItems({
    store: input.store,
    channelId: input.channel.id,
    items: page.items,
    replyDispatchCoordinator: input.replyDispatchCoordinator,
  });
  const { conversationItems: visibleItems, userInputs } = projectConversationUserInputs(input.store, input.thread.id, selectedItems);
  const turns = turnsForItems(input.store, visibleItems);
  const decorations = decorationsForItems(input.store, visibleItems);
  const runLinks = turns.flatMap((turn) => input.store.listLingTurnRuns(turn.id));
  const runs = runLinks
    .map((link) => input.store.getRun(link.runId))
    .filter((run): run is RunSession => Boolean(run));
  const channelThreads = input.store.listLingThreads({ kind: "channel_discussion", channelId: input.channel.id, includeArchived: true, limit: 500 })
    .filter((thread) => thread.workspaceId === input.thread.workspaceId && thread.channelId === input.channel.id);
  const allTurns = channelThreads.flatMap((thread) => listAllConversationTurns(input.store, thread.id));
  const allRuns = allTurns.flatMap((turn) => input.store.listLingTurnRuns(turn.id))
    .map((link) => input.store.getRun(link.runId))
    .filter((run): run is RunSession => Boolean(run));
  return {
    cwd: input.cwd,
    channelId: input.channel.id,
    thread: projectPublicLingThread(input.thread),
    turns: turns.map(turn => projectPublicLingTurn(turn, input.thread)),
    items: visibleItems.map(item => projectPublicConversationItem(item, input.thread, turns.find(turn => turn.id === item.turnId))),
    runtimeMetrics: projectConversationRuntimeMetrics({ store: input.store, thread: input.thread, channelThreads, turns: allTurns, runs: allRuns,
      enumerationMayBeTruncated: channelThreads.length === 500 }),
    turnContextAssignments: turns.flatMap((turn) => {
      const assignment = input.store.getEffectiveTurnContextAssignment(turn.id);
      return assignment ? [assignment] : [];
    }),
    userInputs,
    reasoningSummaries: projectConversationReasoningSummaries({
      store: input.store,
      thread: input.thread,
      runLinks,
      runs,
      items: visibleItems,
    }),
    contextCompactions: projectConversationContextCompactions({
      store: input.store,
      thread: input.thread,
      runLinks,
      runs,
      items: visibleItems,
    }),
    decorations,
    generatedMedia: buildConversationGeneratedMediaProjection({
      store: input.store,
      runIds: decorations.flatMap((decoration) => decoration.linkedRunId ? [decoration.linkedRunId] : []),
    }),
    hasMore: page.nextBeforeSequence !== undefined,
    ...(page.nextBeforeSequence !== undefined ? { nextBeforeSequence: page.nextBeforeSequence } : {}),
  };
}

export function buildChannelConversationTurnResponse(input: {
  readonly store: RunStore;
  readonly userItemId: string;
  readonly assistantItemIds?: readonly string[];
  readonly replyDispatch?: ChannelConversationTurnResponse["replyDispatch"];
  readonly autoStartedWorkflow?: ChannelConversationTurnResponse["autoStartedWorkflow"];
}): ChannelConversationTurnResponse {
  const userItem = requiredEffectiveItem(input.store, input.userItemId);
  if (!userItem.channelId || !userItem.turnId || userItem.kind !== "user_message") {
    throw new Error(`Channel turn source is not a user conversation item: ${input.userItemId}`);
  }
  const turn = input.store.getLingTurn(userItem.turnId);
  const thread = input.store.getLingThread(userItem.threadId);
  if (!turn || !thread) {
    throw new Error(`Channel turn lineage is incomplete for item: ${input.userItemId}`);
  }
  const assistantItems = uniqueStrings(input.assistantItemIds ?? [])
    .map((itemId) => requiredEffectiveItem(input.store, itemId))
    .filter((item) => item.turnId === turn.id && item.kind === "assistant_message");
  const items = [userItem, ...assistantItems];
  return {
    thread: projectPublicLingThread(thread),
    turn: projectPublicLingTurn(turn, thread),
    userItem: projectPublicConversationItem(userItem, thread, turn),
    ...(assistantItems.length > 0 ? { assistantItems: assistantItems.map(item => projectPublicConversationItem(item, thread, turn)) } : {}),
    decorations: decorationsForItems(input.store, items),
    ...(input.replyDispatch ? { replyDispatch: input.replyDispatch } : {}),
    ...(input.autoStartedWorkflow ? { autoStartedWorkflow: input.autoStartedWorkflow } : {}),
  };
}

export function buildChannelConversationItemDecoration(
  store: RunStore,
  itemId: string,
): ChannelConversationItemDecoration | undefined {
  const message = getChannelMessageView(store, itemId);
  if (!message) return undefined;
  return decorationFromMessage(
    enrichChannelMessageWithWebEvidence(
      store,
      projectChannelMessageRevisionMetadata(store, message),
    ),
  );
}

function filterVisibleTimelineItems(input: {
  readonly store: RunStore;
  readonly channelId: string;
  readonly items: readonly ConversationItemV1[];
  readonly replyDispatchCoordinator?: ChannelReplyDispatchCoordinator;
}): readonly ConversationItemV1[] {
  const messageItems = input.items.filter(isMessageLikeItem);
  const messages = messageItems
    .map((item) => getChannelMessageView(input.store, item.id))
    .filter((message): message is ChannelMessage => Boolean(message));
  const supersession = buildConversationSupersessionProjection(input.store, {
    surfaces: ["channel_root", "channel_branch", "topic_reply"], ownerId: input.channelId,
  });
  const visibleMessages = filterQueuedChannelReplyMessages(
    input.store,
    filterSupersededChannelMessages(
      messages,
      supersession,
    ),
    (message) => Boolean(input.replyDispatchCoordinator?.isMessageClassificationPending(
      message.workspaceId,
      message.id,
    )),
  );
  const visibleMessageIds = new Set(visibleMessages.map((message) => message.id));
  return input.items.filter((item) =>
    ((item.kind !== "user_input_request" && item.kind !== "user_input_answer")
      || (item.turnId && !supersession.supersededTurnIds.has(item.turnId)
        && input.store.getLingTurn(item.turnId)?.status !== "superseded")) &&
    !isIneligibleTerminalReportMessage(input.store, item.id) &&
    (!isMessageLikeItem(item) || visibleMessageIds.has(item.id))
  );
}

function isIneligibleTerminalReportMessage(store: RunStore, itemId: string): boolean {
  const prefix = "result_terminal_report:";
  if (!itemId.startsWith(prefix)) return false;
  const record = store.getTerminalReport(itemId.slice(prefix.length));
  return Boolean(record && !terminalReportIsEligibleForDisplay(store, record));
}

function decorationsForItems(
  store: RunStore,
  items: readonly ConversationItemV1[],
): readonly ChannelConversationItemDecoration[] {
  const messages = items
    .filter(isMessageLikeItem)
    .map((item) => getChannelMessageView(store, item.id))
    .filter((message): message is ChannelMessage => Boolean(message))
    .map((message) => projectChannelMessageRevisionMetadata(store, message));
  return enrichChannelMessagesWithWebEvidence(store, messages).map(decorationFromMessage);
}

function decorationFromMessage(message: ChannelMessage): ChannelConversationItemDecoration {
  return {
    itemId: message.id,
    ...(message.linkedRunId ? { linkedRunId: message.linkedRunId } : {}),
    ...(message.editedAt ? { editedAt: message.editedAt } : {}),
    ...(message.pendingReplacement ? { pendingReplacement: message.pendingReplacement } : {}),
    ...(message.webEvidence ? { webEvidence: message.webEvidence } : {}),
  };
}

function turnsForItems(
  store: RunStore,
  items: readonly ConversationItemV1[],
): readonly LingTurn[] {
  const turns: LingTurn[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (!item.turnId || seen.has(item.turnId)) continue;
    const turn = store.getLingTurn(item.turnId);
    if (!turn) throw new Error(`Conversation item references a missing turn: ${item.id}`);
    seen.add(turn.id);
    turns.push(turn);
  }
  return turns;
}

function requiredEffectiveItem(
  store: RunStore,
  itemId: string,
): ConversationItemV1 {
  const item = store.getEffectiveConversationItem(itemId);
  if (!item) throw new Error(`Conversation item not found: ${itemId}`);
  return item;
}

function assertChannelThread(channelId: string, thread: ChannelConversationThread): void {
  if (thread.channelId !== channelId) {
    throw new Error(`Conversation thread does not belong to channel: ${thread.id}`);
  }
}

function isMessageLikeItem(item: ConversationItemV1): boolean {
  return item.kind === "user_message" || item.kind === "assistant_message" || item.kind === "system_event";
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}
