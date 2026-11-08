import assert from "node:assert/strict";
import test from "node:test";
import type { RunEventDataByType, RunEventEnvelope, RunEventType } from "@ling-stack/contracts";
import type { ConversationTimelineItem, ConversationTimelineMessageItem, TimelineSnapshot } from "@ling-stack/conversation-ui-core";
import { formatCatalogMessage } from "@ling-stack/localization";
import { conversationFeedbackReadTargets, projectConversationFeedbackSnapshot, projectConversationRunFeedback } from "../src/domains/conversations/run-feedback.ts";
import { enUS } from "../src/i18n/locales/en-US.ts";
import { zhCN } from "../src/i18n/locales/zh-CN.ts";
import type { ChannelMessage } from "@ling-stack/contracts";
import { projectTopicReplyTimeline } from "../src/features/workspace/topic-reply-timeline.ts";

const diagnostic = { schemaVersion: 1, category: "rate_limited", basis: "structured_http_status", httpStatus: 429 } as const;
const english = (key: string, values?: Readonly<Record<string, string | number>>): string => formatCatalogMessage(enUS, enUS, key, values);
const chinese = (key: string, values?: Readonly<Record<string, string | number>>): string => formatCatalogMessage(zhCN, enUS, key, values);

test("replayed retries update one stable status row with only the real SDK counter", () => {
  const first = project([retry(1)]);
  const second = project([retry(2), retry(1), retry(2)]);
  assert.equal(first.items.length, 1);
  assert.equal(second.items.length, 1);
  assert.equal(first.items[0]!.id, second.items[0]!.id);
  assert.equal(first.items[0]!.revision, 1);
  assert.equal(second.items[0]!.revision, 2);
  assert.equal(feedbackRow(first).meta, "Retry 1 of 3");
  assert.equal(feedbackRow(second).meta, "Retry 2 of 3");
  assert.equal(feedbackRow(second).title, "Retrying automatically...");
});

test("native reconnect/retry evidence never invents a retry budget", () => {
  const native = event(1, "progress", { nativeKind: "error", retrying: true });
  const feedback = projectConversationRunFeedback("run-1", [native]);
  assert.equal(feedback?.status, "retrying");
  assert.equal(feedback?.retryAttempt, undefined);
  assert.equal(feedback?.maxRetryAttempts, undefined);
  assert.equal(feedbackRow(project([native])).meta, undefined);
  assert.equal(projectConversationRunFeedback("run-1", [native, event(2, "progress", { nativeKind: "error", retrying: false })]), undefined);
});

test("real resumed model or tool activity clears automatic retry status", () => {
  for (const resumed of [event(2, "assistant_text_delta", { text: "Recovered" }),
    event(2, "assistant_thinking_delta", { text: "Working" }),
    event(2, "tool_start", { toolName: "read" }),
    event(2, "approval_requested", { approvalId: "approval-1" }),
    event(2, "provider_retry", { policyVersion: "pi_sdk_retry_v1", scope: "assistant", phase: "settled", retryAttempt: 1, outcome: "succeeded" })]) {
    assert.equal(projectConversationRunFeedback("run-1", [retry(1), resumed]), undefined);
  }
  assert.equal(projectConversationRunFeedback("run-1", [retry(1), event(2, "assistant_text_delta", { text: "" })])?.status, "retrying");
});

test("message errors and exhausted SDK retries are not terminal Host outcomes", () => {
  const intermediate = [event(1, "message_end", { role: "assistant", stopReason: "error", errorDiagnostic: diagnostic }),
    event(2, "provider_retry", { policyVersion: "pi_sdk_retry_v1", scope: "assistant", phase: "settled", retryAttempt: 3,
      outcome: "failed", errorDiagnostic: diagnostic })];
  assert.equal(projectConversationRunFeedback("run-1", intermediate), undefined);
  assert.equal(projectConversationRunFeedback("run-1", intermediate, { id: "run-1", status: "failed" })?.status, "failed");
});

test("summarization retries cannot masquerade as an assistant model failure", () => {
  const events = [event(1, "provider_retry", { policyVersion: "pi_sdk_retry_v1", scope: "summarization", phase: "scheduled",
    retryAttempt: 1, maxRetryAttempts: 2, delayMs: 1000, errorDiagnostic: diagnostic }),
    event(2, "provider_retry", { policyVersion: "pi_sdk_retry_v1", scope: "summarization", phase: "settled" })];
  assert.equal(projectConversationRunFeedback("run-1", events), undefined);
  assert.equal(projectConversationRunFeedback("run-1", events, { id: "run-1", status: "failed" })?.diagnostic, undefined);
});

test("durable terminal error replaces thinking before run polling catches up", () => {
  const original = snapshot();
  const result = projectConversationFeedbackSnapshot(original, new Map([["run-1", [retry(1), failure(2)]]]), english);
  assert.equal(result.activeRun, null);
  assert.equal(result.items.length, 1);
  assert.equal(feedbackRow(result).status, "failed");
  assert.equal(feedbackRow(result).title, "Model response failed");
  assert.equal(result.items[0]!.id, project([retry(1)]).items[0]!.id);
  assert.equal(original.items[0]!.status, "running", "the source snapshot is immutable");
  assert.equal(original.activeRun?.runId, "run-1");
});

test("partial model prose survives failure while all empty waiting segments disappear", () => {
  const original = snapshot("running", [message({ id: "partial", markdown: "Already delivered text", waitingPlaceholder: false }),
    message({ id: "waiting-1" }), message({ id: "waiting-2", markdown: "", waitingPlaceholder: false })]);
  const result = projectConversationFeedbackSnapshot(original, new Map([["run-1", [failure(1)]]]), english);
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0]!.id, "partial");
  assert.equal(result.items[0]!.status, "failed");
  assert.equal(result.items[0]!.kind === "agentMessage" && result.items[0].markdown, "Already delivered text");
  assert.equal(feedbackRow(result).status, "failed");
});

test("a failed lifecycle without provider diagnostics uses a generic failure, never raw error text", () => {
  const generic = event(1, "run_error", { message: "secret provider response" });
  const result = project([generic], snapshot("failed"));
  assert.equal(feedbackRow(result).title, "Response failed");
  assert.equal(feedbackRow(result).description, undefined);
  assert.equal(JSON.stringify(result).includes("secret provider response"), false);
  assert.equal(feedbackRow(project([], snapshot("failed"))).status, "failed");
});

test("completed and cancelled lifecycles override stale retry/error journals", () => {
  for (const status of ["succeeded", "cancelled", "yielded"]) {
    assert.equal(projectConversationRunFeedback("run-1", [retry(1), failure(2)], { id: "run-1", status }), undefined);
    assert.deepEqual(conversationFeedbackReadTargets(snapshot(status)), []);
  }
  assert.equal(projectConversationRunFeedback("run-1", [retry(1), event(2, "run_end", {})]), undefined);
  assert.equal(projectConversationRunFeedback("run-1", [retry(1), event(2, "run_cancelled", {})]), undefined);
});

test("an accepted same-run continuation clears the previous terminal failure", () => {
  const resumed = projectConversationRunFeedback("run-1", [failure(1), event(2, "run_continuation_started", {})]);
  assert.equal(resumed, undefined);
});

test("journal reads require a scoped visible fact and matching lifecycle identity", () => {
  const own = snapshot();
  const withGlobalFailure = { ...own, runLifecycles: new Map([ ["run-1", { id: "run-1", status: "running" }],
    ["automation-run", { id: "automation-run", status: "failed" }] ]) };
  assert.deepEqual(conversationFeedbackReadTargets(withGlobalFailure), ["run-1"]);
  const result = projectConversationFeedbackSnapshot(withGlobalFailure, new Map([["automation-run", [failure(1, "automation-run")]]]), english);
  assert.equal(result, withGlobalFailure);
  const unscoped = { ...own, scope: { ...own.scope, threadId: "" } };
  assert.deepEqual(conversationFeedbackReadTargets(unscoped), []);
  assert.equal(projectConversationFeedbackSnapshot(unscoped, new Map([["run-1", [failure(1)]]]), english), unscoped);
  assert.equal(projectConversationRunFeedback("run-1", [], { id: "other-run", status: "failed" }), undefined);
});

test("foreign events and malformed retry diagnostics never create status or expose payloads", () => {
  assert.equal(projectConversationRunFeedback("run-1", [failure(1, "other-run")]), undefined);
  const unsafe = { ...retry(1), data: { ...retry(1).data, errorDiagnostic: { ...diagnostic, body: "secret" } } } as RunEventEnvelope;
  assert.equal(projectConversationRunFeedback("run-1", [unsafe]), undefined);
  const unsafeFailure = event(1, "run_error", { message: "secret", errorDiagnostic: { ...diagnostic, code: "unsafe-provider-code" } });
  assert.equal(feedbackRow(project([unsafeFailure])).title, "Response failed");
  assert.equal(JSON.stringify(project([unsafeFailure])).includes("unsafe-provider-code"), false);
});

test("pending approvals retain their original fact and do not acquire retry commands", () => {
  const approval: ConversationTimelineItem = { id: "approval-1", kind: "approval", approvalId: "approval-1", runId: "run-1",
    revision: 1, threadSequence: 1, partIndex: 1, status: "waiting", title: "Approve write", sourceRefs: [] };
  const original = snapshot("waiting_for_approval", [approval]);
  const result = projectConversationFeedbackSnapshot(original, new Map([["run-1", [retry(1)]]]), english);
  assert.equal(result, original);
  assert.equal(result.items[0], approval);
  assert.equal("availableActions" in result.items[0]!, false);
});

test("normal, private and channel snapshots use the same localized safe presentation", () => {
  for (const kind of ["normal", "private", "channel_root", "branch", "topic"] as const) {
    const original = snapshot();
    const scoped = { ...original, scope: { ...original.scope, kind } };
    const events = new Map([["run-1", [retry(2)]]]);
    const englishRow = feedbackRow(projectConversationFeedbackSnapshot(scoped, events, english));
    const chineseRow = feedbackRow(projectConversationFeedbackSnapshot(scoped, events, chinese));
    assert.equal(englishRow.meta, "Retry 2 of 3");
    assert.equal(chineseRow.meta, "第 2 次重试，共 3 次");
    assert.equal(chineseRow.title, "正在自动重试...");
    assert.match(chineseRow.description!, /HTTP 状态 429/u);
    assert.equal(chineseRow.id, englishRow.id);
  }
  assert.equal(feedbackRow(projectConversationFeedbackSnapshot(snapshot(), new Map([["run-1", [failure(1)]]]), chinese)).title, "模型回复失败");
});

test("topic replies authorize their own journal while the quoted parent cannot", () => {
  const root: ChannelMessage = { id: "parent", workspaceId: "workspace", channelId: "channel", threadId: "parent-thread",
    kind: "ai_reply", intent: "discuss", authorType: "ai-teammate", body: "Quoted parent", linkedRunId: "parent-run",
    mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [], status: "ready", createdAt: "2026-11-04T01:00:00Z", updatedAt: "2026-11-04T01:00:00Z" };
  const items = projectTopicReplyTimeline({ workspaceId: "workspace", channelId: "channel", threadId: "thread-1",
    rootMessage: root, replies: [{ ...root, id: "reply", threadId: "thread-1", linkedRunId: "run-1", body: "", status: "pending" }],
    conversationItems: [], userInputs: [], reasoningSummaries: [] });
  const original = { ...snapshot("running", items), scope: { ...snapshot().scope, kind: "topic" as const } };
  assert.equal(items[0]!.runId, undefined);
  assert.equal(items[1]!.runId, "run-1");
  assert.deepEqual(conversationFeedbackReadTargets(original), ["run-1"]);
  const projected = projectConversationFeedbackSnapshot(original, new Map([["run-1", [failure(1)]]]), english);
  assert.equal(feedbackRow(projected).status, "failed");
  assert.equal(projected.items.some(item => item.kind === "agentMessage" && item.waitingPlaceholder), false);
  assert.equal(projected.items[0], items[0]);
});

function snapshot(status = "running", items: readonly ConversationTimelineItem[] = [message()]): TimelineSnapshot {
  return { scope: { kind: "normal", threadId: "thread-1", parentThreadId: null, anchorItemId: null, depth: 0 }, items,
    activeRun: { runId: "run-1", status: "working", workspaceLabel: "qa", cwd: "/qa", branch: null, modelLabel: null, sourceRefs: [] },
    canonicalRevision: 1, sseCursor: null, contextSegmentIdByItemId: new Map(), runLifecycles: new Map([["run-1", { id: "run-1", status }]]) };
}

function message(overrides: Partial<ConversationTimelineMessageItem> = {}): ConversationTimelineMessageItem {
  return { id: "message-1", kind: "agentMessage", markdown: "Thinking...", waitingPlaceholder: true, runId: "run-1", turnId: "turn-1",
    revision: 1, threadSequence: 2, partIndex: 0, status: "running", sourceRefs: [], ...overrides };
}

function event<K extends RunEventType>(seq: number, type: K, data: RunEventDataByType[K], runId = "run-1"): RunEventEnvelope {
  return { id: `event:${seq}`, runId, seq, type, data, ts: "2026-11-04T01:00:00.000Z" } as RunEventEnvelope;
}

function retry(attempt: number): RunEventEnvelope {
  return event(attempt, "provider_retry", { policyVersion: "pi_sdk_retry_v1", scope: "assistant", phase: "scheduled",
    retryAttempt: attempt, maxRetryAttempts: 3, delayMs: 1000, errorDiagnostic: diagnostic });
}

function failure(seq: number, runId = "run-1"): RunEventEnvelope {
  return event(seq, "run_error", { message: "private provider error", errorDiagnostic: diagnostic }, runId);
}

function project(events: readonly RunEventEnvelope[], original = snapshot()): TimelineSnapshot {
  return projectConversationFeedbackSnapshot(original, new Map([["run-1", events]]), english);
}

function feedbackRow(result: TimelineSnapshot) {
  const row = result.items.find(item => item.kind === "diagnostic" && item.code === "run_feedback");
  assert.ok(row?.kind === "diagnostic");
  return row;
}
