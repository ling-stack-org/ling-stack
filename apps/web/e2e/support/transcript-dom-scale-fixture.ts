import type { ConversationDetailResponse, ConversationItemV1, ConversationTranscriptMessage } from "@ling-stack/contracts";
import { buildMockConversationDetail } from "./mock-daemon";
import { createBaseState, cwd } from "./mock-state";
import { installNormalWorkCellFixture } from "./conversation-work-cell-fixture";

/** A synthetic message-only history served through the real AppShell adapter. */
export function transcriptDomScaleFixture(count: 10 | 1_000 | 10_000) {
  const state = createBaseState({ approvalStatus: "expired" });
  const title = installNormalWorkCellFixture(state);
  state.executionActions = [];
  state.terminalReports = [];
  const thread = state.threads.find((entry) => entry.kind === "conversation")!;
  const base = buildMockConversationDetail(state, cwd, thread) as unknown as ConversationDetailResponse;
  const userItem = base.conversationItems.find((item) => item.kind === "user_message")!;
  const assistantItem = base.conversationItems.find((item) => item.kind === "assistant_message")!;
  const userMessage = base.messages.find((message) => message.role === "user")!;
  const assistantMessage = base.messages.find((message) => message.role === "assistant")!;
  const turnId = (index: number) => `dom-scale-turn-${Math.floor(index / 2) + 1}`;
  const text = (index: number) => `Scale ${index % 2 === 0 ? "user" : "assistant"} ${Math.floor(index / 2) + 1}`;
  const id = (index: number) => `dom-scale-item-${index + 1}`;
  const conversationItems = Array.from({ length: count }, (_, index): ConversationItemV1 => {
    const item = index % 2 === 0 ? userItem : assistantItem;
    return { ...item, id: id(index), turnId: turnId(index), sequence: index + 1,
      payload: { ...item.payload, body: text(index) }, domainRefs: [{ type: "turn", id: turnId(index) }] } as ConversationItemV1;
  });
  const messages = Array.from({ length: count }, (_, index): ConversationTranscriptMessage => ({
    ...(index % 2 === 0 ? userMessage : assistantMessage), id: id(index), turnId: turnId(index),
    runId: undefined, content: text(index), narrationSegments: undefined,
  }));
  const turns = Array.from({ length: count / 2 }, (_, index) => ({
    ...base.turns[0]!, id: turnId(index * 2), title: text(index * 2), userInstruction: text(index * 2),
    activeRunId: undefined, lastRunId: undefined,
  }));
  const detail: ConversationDetailResponse = {
    ...base, thread: { ...base.thread, lastRunId: undefined }, turns, conversationItems, messages,
    runs: [], runLinks: [], executionActions: [], artifacts: [], terminalReports: [], approvals: [],
    plans: [], contextSnapshots: [], contextSummaries: [], compactionCheckpoints: [],
  };
  return { state, title, detail, count };
}
