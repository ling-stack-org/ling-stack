import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const vite = await createServer({
  root: fileURLToPath(new URL("..", import.meta.url)),
  configFile: false,
  logLevel: "silent",
  server: { middlewareMode: true },
});
const { projectNormalConversationFeedItems } = await vite.ssrLoadModule(
  "/src/features/workspace/normal-conversation-feed-view-models.ts",
);
after(async () => vite.close());

const t = (value) => value;

test("normal feed keeps canonical atomic facts when no WorkCell adapter is available", () => {
  const message = {
    id: "assistant-message",
    threadId: "thread-normal",
    turnId: "turn-normal",
    runId: "run-normal",
    role: "assistant",
    content: "I inspected the file.",
    status: "succeeded",
    revision: 2,
    createdAt: "2026-09-19T00:00:00.000Z",
  };
  const canonicalFact = {
    id: "action:read-canonical",
    kind: "exploration",
    title: "Read parser.ts",
    operation: "read",
    status: "succeeded",
    revision: 4,
    threadSequence: 2,
    partIndex: 1,
    runId: "run-normal",
    turnId: "turn-normal",
    attemptId: "attempt-normal",
    participantId: "ling-agent",
    workflowStepId: null,
    actionId: "action:read-canonical",
    sourceRefs: [{ kind: "execution_action", id: "action:read-canonical" }],
    targets: [{ kind: "file", id: "parser.ts", path: "parser.ts" }],
  };
  const [projected] = projectNormalConversationFeedItems({
    messages: [message],
    visibleMessages: [message],
    runById: new Map([[
      "run-normal",
      { id: "run-normal", threadId: "thread-normal", status: "succeeded", cwd: "/workspace" },
    ]]),
    detailContext: {
      threadId: "thread-normal",
      conversationItems: [],
      runLinks: [],
      turns: [],
      runs: [],
      executionActions: [],
      approvals: [],
      interventions: [],
      terminalReports: [],
      artifacts: [],
      generatedMedia: [],
      timelineProjection: {
        items: [canonicalFact],
        diagnostics: [],
        sourceSequence: 4,
        terminalEvidence: [],
      },
    },
    workspaceCwd: "/workspace",
    t,
  });

  assert.ok(projected);
  assert.deepEqual(projected.timelineItems.map((item) => item.id), [
    "message:agent:assistant-message",
    "action:read-canonical",
  ]);
  assert.equal("workCell" in projected, false);
});
