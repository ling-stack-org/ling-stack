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

function failedFeed(contentSource, reportOverrides = {}, messageOverrides = {}) {
  const message = { id: "assistant", role: "assistant", threadId: "thread", turnId: "turn", runId: "run",
    contentSource, content: "Ling 助手暂时无法完成这次请求。", errorMessage: "runtime_interrupted_no_checkpoint",
    narrationSegments: [], status: "failed", createdAt: "2026-10-02T00:00:00.000Z", ...messageOverrides };
  const report = { id: "report", kind: "terminalReport", reportId: "report", resultItemId: "result", generation: 1,
    runId: "run", turnId: "turn", revision: 1, threadSequence: 2, partIndex: 0, sourceRefs: [],
    status: "failed", outcomeStatus: "failed", summary: "任务执行失败。", ...reportOverrides };
  return projectNormalConversationFeedItems({ messages: [message], visibleMessages: [message],
    runById: new Map([["run", { id: "run", threadId: "thread", status: "failed", cwd: "/workspace" }]]),
    detailContext: { threadId: "thread", conversationItems: [], runLinks: [], turns: [], runs: [], executionActions: [],
      approvals: [], interventions: [], terminalReports: [], artifacts: [], generatedMedia: [],
      timelineProjection: { items: [report], diagnostics: [], sourceSequence: 2, terminalEvidence: [] } },
    workspaceCwd: "/workspace", t })[0];
}

test("a canonical failure report owns the result instead of a second Host status message or raw error", () => {
  const feed = failedFeed("host_status");
  assert.equal(feed.body, "");
  assert.equal(feed.errorText, "");
  assert.deepEqual(feed.timelineItems.map(item => item.kind), ["terminalReport"]);
  assert.equal(feed.message.content, "Ling 助手暂时无法完成这次请求。", "the DTO/history is not changed");
});

test("prose equality is never authority to suppress real or unattributed model commentary", () => {
  for (const source of ["run_narration", undefined]) {
    const feed = failedFeed(source);
    assert.equal(feed.body, "Ling 助手暂时无法完成这次请求。");
    assert.equal(feed.timelineItems[0].kind, "agentMessage");
  }
  assert.equal(failedFeed("host_status", {}, { narrationSegments: [{ content: "Real narration." }] }).timelineItems[0].kind,
    "agentMessage", "conflicting provenance fails closed");
});

test("Host failure placeholder remains without a settled, same-owner, published report", () => {
  for (const report of [{ kind: "diagnostic" }, { status: "running" }, { status: undefined },
    { runId: "foreign-run" }, { turnId: "foreign-turn" }, { resultItemId: undefined }, { reportId: "" }, { generation: 0 }]) {
    const feed = failedFeed("host_status", report);
    assert.equal(feed.timelineItems[0].kind, "agentMessage");
    assert.ok(feed.body);
    assert.ok(feed.errorText);
  }
});

test("a live Host placeholder is not suppressed by stale terminal facts", () => {
  assert.equal(failedFeed("host_status", {}, { status: "running" }).timelineItems[0].kind, "agentMessage");
});

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
