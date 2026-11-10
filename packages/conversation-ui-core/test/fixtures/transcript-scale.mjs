/** Synthetic canonical inputs only. This fixture never reads persisted conversations. */
export function transcriptScaleFixture(count, kind = "exploration") {
  const scope = { surface: "normal", workspaceId: "performance-workspace", threadId: "performance-thread", depth: 0 };
  const items = Array.from({ length: count }, (_, index) => ({
    id: `performance-item-${index}`, workspaceId: scope.workspaceId, threadId: scope.threadId,
    turnId: "performance-turn", sequence: index + 1, revision: 1, status: "committed",
    kind: kind === "message" ? "assistant_message" : "tool_call", actorType: "ling_agent",
    payload: kind === "message"
      ? { body: `Synthetic narration ${index + 1}.`, deliveryStatus: "ready", presentationRole: "narration" }
      : { toolCallId: `performance-call-${index}`, toolName: "read" },
  }));
  const actions = kind === "message" ? [] : items.map((item, index) => ({
    id: `performance-action-${index}`, revision: 1, workspaceId: scope.workspaceId, threadId: scope.threadId,
    turnId: item.turnId, runId: "performance-run", attemptId: "performance-attempt", attemptNumber: 1,
    turnRunRole: "primary", participantId: "performance-agent", toolCallId: `performance-call-${index}`,
    actionType: "read", risk: "low", status: "succeeded", title: `Read fixture ${index + 1}`,
    summary: "Synthetic read evidence.", sourceRefs: [
      { kind: "conversation_item", id: item.id },
      { kind: "file", id: `fixtures/example-${index + 1}.txt` },
    ],
  }));
  return { scope, items, actions, sourceSequence: count, sourceRevision: `synthetic-${kind}-${count}`,
    turnRuns: [{ runId: "performance-run", turnId: "performance-turn", attemptNumber: 1, role: "primary" }] };
}
