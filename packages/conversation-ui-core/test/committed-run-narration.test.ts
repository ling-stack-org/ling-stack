import assert from "node:assert/strict";
import test from "node:test";
import type {
  CanonicalConversationItem,
  CanonicalExecutionAction,
  CanonicalTranscriptScope,
} from "../dist/index.js";
import { projectCanonicalConversationTimeline } from "../dist/index.js";

function fixture() {
  const source = { workspaceId: "workspace", threadId: "thread", turnId: "turn", runId: "run",
    workUnitId: "unit", attemptId: "attempt", participantId: "ling_agent" };
  const base = { workspaceId: "workspace", threadId: "thread", turnId: "turn", status: "committed" as const, revision: 0 };
  const user = { ...base, id: "user", sequence: 1, kind: "user_message" as const, actorType: "local_user" as const, payload: { body: "Read" } };
  const assistant = { ...base, id: "narration:run", sequence: 2, kind: "assistant_message" as const, actorType: "ling_agent" as const, actorId: "ling_agent",
    domainRefs: [{ type: "run", id: "run" }, { type: "conversation_item", id: "user" }],
    payload: { body: "Before.\n\nAfter.", deliveryStatus: "ready", streaming: false, presentationRole: "narration",
      runNarration: { schemaVersion: 1, messageId: "conversation-assistant:turn", sourceItemId: "user", source,
        throughEventSequence: 8, throughEventId: "e8", segments: [
          { content: "Before.", firstEventId: "e2", lastEventId: "e3", startEventSequence: 2, endEventSequence: 3, completed: true },
          { content: "After.", firstEventId: "e6", lastEventId: "e7", startEventSequence: 6, endEventSequence: 7, completed: true },
        ] } } };
  const scope: Pick<CanonicalTranscriptScope, "threadId" | "workspaceId"> &
    { surface: "normal"; depth: 0; attemptId?: string } = { surface: "normal", depth: 0, threadId: "thread", workspaceId: "workspace" };
  return { scope,
    items: [user, assistant] satisfies [CanonicalConversationItem, CanonicalConversationItem],
    // A legacy read may reach the projector without an action title.
    actions: [{ id: "read", workspaceId: "workspace", threadId: "thread", turnId: "turn", runId: "run",
      attemptId: "attempt", workUnitId: "unit", participantId: "ling_agent", workflowStepId: null,
      actionType: "file_read", status: "succeeded", revision: 1, sourceEventSequence: 4,
      sourceRefs: [{ kind: "conversation_item", id: "user" }, { kind: "file", id: "readme.md" }] } satisfies Omit<CanonicalExecutionAction, "title">] as unknown as CanonicalExecutionAction[],
    turnRuns: [{ turnId: "turn", runId: "run", attemptNumber: 1, role: "primary" as const }], sourceSequence: 2, sourceRevision: "published" };
}
test("canonical terminal narration keeps streaming IDs, original tool positions and exactly one final owner", () => {
  const result = projectCanonicalConversationTimeline(fixture());
  assert.deepEqual(result.items.map(item => ("markdown" in item ? item.markdown : undefined) ?? item.actionId), ["Read", "Before.", "read", "After."]);
  const messages = result.items.filter(item => item.kind === "agentMessage");
  assert.deepEqual(messages.map(item => item.id), ["message:agent:conversation-assistant:turn:event:e2", "message:agent:conversation-assistant:turn:event:e6"]);
  assert.deepEqual(messages.map(item => "phase" in item ? item.phase : undefined), ["commentary", "final"]);
  assert.ok(messages.every(item => item.itemId === "narration:run" && item.sourceRefs.some(ref => ref.kind === "conversation_item" && ref.id === "narration:run")));
  assert.ok(messages.every(item => item.attemptId === "attempt" && item.participantId === "ling_agent"));
  assert.equal(result.terminalEvidence.length, 1, "narration is not completion evidence");
});
const mutations: ((input: ReturnType<typeof fixture>) => void)[] = [
  input => { input.items[1].payload.runNarration.source.threadId = "foreign"; },
  input => { input.items[1].payload.runNarration.source.participantId = "foreign"; },
  input => { input.items[1].payload.runNarration.source.runId = "foreign"; },
  input => { input.items[1].payload.runNarration.source.attemptId = "foreign"; input.scope.attemptId = "attempt"; },
  input => { input.items[1].payload.runNarration.segments[0].content = "Mismatch"; },
];
for (const mutate of mutations) {
  test("canonical narration rejects scope/body conflicts without falling back to an aggregate claim: " + mutate.toString(), () => {
    const input = fixture(); mutate(input);
    const result = projectCanonicalConversationTimeline(input);
    assert.equal(result.items.some(item => item.kind === "agentMessage"), false);
    assert.ok(result.diagnostics.length > 0);
  });
}
