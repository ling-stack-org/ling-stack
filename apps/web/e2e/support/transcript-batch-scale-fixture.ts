import type { ConversationDetailResponse } from "@ling-stack/contracts";
import { installNormalWorkCellFixture } from "./conversation-work-cell-fixture";
import { buildMockConversationDetail } from "./mock-daemon";
import { createBaseState, cwd } from "./mock-state";

/** Synthetic Host-shaped facts; no files are read and no commands are executed. */
export function transcriptBatchScaleFixture(kind: "read" | "command", count: 10 | 1_000 | 10_000) {
  const state = createBaseState({ approvalStatus: "expired" });
  const title = installNormalWorkCellFixture(state);
  state.terminalReports = [];
  const thread = state.threads.find((entry) => entry.kind === "conversation");
  const command = state.executionActions[0];
  if (!thread || !command?.commandEvidence) throw new Error("Batch scale fixture requires the normal command seed");
  const turn = state.turns.find((entry) => entry.threadId === thread.id);
  if (!turn) throw new Error("Batch scale fixture requires a source turn");
  state.executionActions = Array.from({ length: count }, (_, index) => {
    const ordinal = index + 1;
    const path = `fixture-${ordinal}.txt`;
    const commandText = `node --version # fixture-${ordinal}`;
    const eventSeq = ordinal * 2;
    const common = {
      ...command, id: `batch-scale-${kind}-${ordinal}`, toolCallId: `batch-scale-call-${kind}-${ordinal}`,
      revision: eventSeq, sourceEventSequence: eventSeq - 1,
      sourceRefs: [{ kind: "conversation_item", id: `conversation-user:${turn.id}` }],
    };
    return kind === "read" ? {
      ...common, actionType: "read", title: "read", summary: path,
      targetRefs: [{ type: "file", id: path, path }], commandEvidence: undefined,
      toolEvidence: { toolName: "read", inputSummary: path, outputText: `Fixture ${ordinal}\n`,
        outputTruncated: false, latestEventSeq: eventSeq },
    } : {
      ...common, title: "bash", summary: commandText,
      targetRefs: [{ type: "command", label: commandText }],
      commandEvidence: { ...command.commandEvidence!, command: commandText, latestEventSeq: eventSeq,
        outputTail: [{ ...command.commandEvidence!.outputTail[0]!, eventSeq, text: "v24.15.0\n", byteCount: 9 }],
        outputByteCount: 9, outputLineCount: 1 },
    };
  });
  const base = buildMockConversationDetail(state, cwd, thread) as unknown as ConversationDetailResponse;
  // The general mock sorts equal-time messages by id. Give this fixture explicit
  // canonical order so a synthetic assistant id cannot precede its source user.
  const conversationItems = [...base.conversationItems]
    .sort((left, right) => Number(left.kind !== "user_message") - Number(right.kind !== "user_message"))
    .map((item, index) => ({ ...item, sequence: index + 1 }));
  const detail: ConversationDetailResponse = { ...base, conversationItems,
    plans: [], contextSummaries: [], compactionCheckpoints: [] };
  return { state, title, detail, kind, count };
}
