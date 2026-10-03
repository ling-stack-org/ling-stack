import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { homeMessageFromTranscript } from "../src/features/workspace/normal-conversation-transcript-message.ts";
import { flattenNormalTimelineItems, selectNormalTimelineItems } from "../src/features/workspace/normal-conversation-timeline-items.ts";

function transcript(overrides = {}) {
  return {
    id: "assistant-1", threadId: "thread-1", turnId: "turn-1", runId: "run-1",
    role: "assistant", authorLabel: "Ling", content: "Before tool.\n\nAfter tool.",
    contentSource: "run_narration",
    status: "succeeded", revision: 9, editedAt: "2026-09-05T00:00:08Z",
    errorMessage: "Separate runtime error", attachments: [{ id: "attachment-1", workspaceId: "workspace-1", kind: "image", fileName: "preview.png", contentType: "image/png", sizeBytes: 3, path: "attachments/preview.png", createdAt: "2026-09-05T00:00:00Z" }],
    fileRefs: [{ path: "morning-todo/todo.mjs", label: "todo.mjs" }],
    pendingReplacement: { supersessionId: "supersession-1", idempotencyKey: "replacement-1", failureReason: "Retry pending" },
    narrationSegments: [
      { content: "Before tool.", firstEventId: "event-5", lastEventId: "event-48", startEventSequence: 5, endEventSequence: 48, completed: true },
      { content: "After tool.", firstEventId: "event-59", lastEventId: "event-98", startEventSequence: 59, endEventSequence: 98, completed: true },
    ],
    createdAt: "2026-09-05T00:00:00Z", updatedAt: "2026-09-05T00:00:10Z",
    ...overrides,
  };
}

test("normal transcript mapper retains narration boundaries and existing UI fields", () => {
  const dto = transcript();
  const original = structuredClone(dto);
  const home = homeMessageFromTranscript(dto);
  assert.deepEqual(home.narrationSegments, dto.narrationSegments);
  for (const key of Object.keys(dto)) assert.deepEqual(home[key], dto[key], `lost DTO field: ${key}`);
  assert.equal(home.narrationSegments, dto.narrationSegments);
  assert.equal(home.fileRefs, dto.fileRefs);
  assert.equal(home.attachments, dto.attachments);
  assert.deepEqual(dto, original);
  assert.notEqual(home, dto);
});

test("detail and SSE mapping never drop Host status provenance or infer it from words", () => {
  for (const contentSource of ["host_status", "run_narration", undefined]) {
    const dto = transcript({ contentSource, content: "Ling 助手暂时无法完成这次请求。", narrationSegments: [], status: "failed" });
    assert.equal(homeMessageFromTranscript(dto).contentSource, contentSource);
  }
});

test("normal transcript mapper keeps optional fields absent and file references on user messages", () => {
  const dto = { id: "user-1", role: "user", threadId: "thread-1", content: "Read this file.", status: "succeeded", fileRefs: [{ path: "README.md" }], createdAt: "2026-09-05T00:00:00Z", updatedAt: "2026-09-05T00:00:00Z" };
  const home = homeMessageFromTranscript(dto);
  assert.equal(home.narrationSegments, undefined);
  assert.equal(home.runId, undefined);
  assert.deepEqual(home.fileRefs, dto.fileRefs);
  assert.equal(home.content, dto.content);
  assert.equal(home.fileRefs, dto.fileRefs);
});

test("normal transcript mapper never changes runtime statuses or folds errors into narrative", () => {
  for (const status of ["pending", "running", "succeeded", "failed", "blocked", "cancelled"]) {
    const dto = transcript({ status });
    const home = homeMessageFromTranscript(dto);
    assert.equal(home.status, status);
    assert.equal(home.content, dto.content);
    assert.equal(home.errorMessage, dto.errorMessage);
    assert.equal(home.pendingReplacement, dto.pendingReplacement);
  }
});

test("detail and SSE DTO mapping preserves narration order through the production timeline selector", () => {
  const dto = transcript({ errorMessage: undefined });
  const user = { id: "message:user:user-1", kind: "userMessage", itemId: "user-1", turnId: "turn-1", threadSequence: 1, partIndex: 0, revision: 1, markdown: "Inspect.", sourceRefs: [{ kind: "conversation_item", id: "user-1" }] };
  const read = { id: "action:read", kind: "exploration", actionId: "read", runId: "run-1", turnId: "turn-1", threadSequence: 1, partIndex: 1, sourceEventSequence: 49, revision: 51, operation: "read", targets: [], title: "Read README.md", sourceRefs: [] };
  const feed = (message) => ({ message, timelineItems: [{ id: "message:agent:assistant-1", kind: "agentMessage", itemId: message.id, runId: message.runId, turnId: message.turnId, markdown: message.content, phase: "final", sourceRefs: [], revision: message.revision, threadSequence: 0, partIndex: 0 }, read] });
  const userFeed = { message: { id: "user-1", role: "user", turnId: "turn-1" }, timelineItems: [user] };
  const detail = selectNormalTimelineItems([user, read], [userFeed, feed([dto].map(homeMessageFromTranscript)[0])]);
  const live = flattenNormalTimelineItems([userFeed, feed(homeMessageFromTranscript(dto))]);
  for (const projected of [detail, live]) {
    assert.deepEqual(projected.map((item) => item.markdown ?? item.title), ["Inspect.", "Before tool.", "Read README.md", "After tool."]);
  }
  assert.deepEqual(detail.filter((item) => item.kind === "agentMessage").map((item) => item.id), live.filter((item) => item.kind === "agentMessage").map((item) => item.id));
});

test("AppShell detail and stream entry points use one shared transcript mapper", () => {
  const source = readFileSync(new URL("../src/app/AppShell.tsx", import.meta.url), "utf8");
  assert.match(source, /import \{ homeMessageFromTranscript \} from "\.\.\/features\/workspace\/normal-conversation-transcript-message\.js"/u);
  assert.match(source, /selectedConversationDetail\?\.messages \?\? \[\]\)\.map\(homeMessageFromTranscript\)/u);
  assert.doesNotMatch(source, /function homeMessageFromTranscript\(/u);
  assert.equal((source.match(/homeMessageFromTranscript\(event\.assistantMessage\)/gu) ?? []).length, 4);
});
