import { appendChannelItemFixture, getChannelItemViewFixture, listChannelItemViewsFixture, updateChannelItemFixture } from "../../core/test/channel-conversation-fixture.mjs";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createSqliteRunStore, resolveRuntimePaths } from "../../core/dist/index.js";
import {
  configureTerminalReportStore,
  processRunTerminalReport,
  processTurnTerminalReport,
  processWorkflowTerminalReport,
  recoverTerminalReports,
} from "../dist/features/channels/terminal-report-coordinator.js";
import { ControlPlaneEventHub } from "../dist/features/control-plane/events.js";
import { maybeCreateWorkflowTerminalCoordinatorReply } from "../dist/features/channels/workflows.js";
import { buildLingAgentSessionViewForChannel } from "../dist/features/channels/ling-agent-session-view.js";
import { createTerminalWorkflowFixture } from "./terminal-report-coordinator-fixture.mjs";

test("terminal report flag off does not publish a legacy workflow terminal message", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-terminal-report-flag-off-"));
  const store = createSqliteRunStore(cwd);
  try {
    const fixture = createTerminalWorkflowFixture(store, cwd, "flag-off");
    configureTerminalReportStore(store, { enabled: false });
    const result = maybeCreateWorkflowTerminalCoordinatorReply(store, fixture.workflow.id, {
      now: "2026-07-11T05:04:00.000Z",
    });
    assert.equal(result, undefined);
    assert.equal(store.getConversationItem(`message_workflow_terminal_${fixture.workflow.id}`), undefined);
    assert.equal(store.listConversationItemsByChannelPage({
      channelId: fixture.channel.id,
      kinds: ["assistant_message"],
      effectiveOnly: true,
      limit: 100,
    }).items.some((item) => item.id === `message_workflow_terminal_${fixture.workflow.id}`), false);
    assert.equal(store.listTerminalReports({ sourceKind: "workflow", sourceId: fixture.workflow.id }).length, 0);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("terminal report coordinator stores executed conversation turns and skips plain replies", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-terminal-report-turn-coordinator-"));
  const store = createSqliteRunStore(cwd);
  try {
    configureTerminalReportStore(store, { enabled: true });
    const now = "2026-07-11T06:00:00.000Z";
    const channel = store.createChannel({ name: "Conversation backing", boundPath: cwd }, now);
    const task = store.createTask({ channelId: channel.id, title: "Edit report UI", prompt: "Edit report UI" }, now);
    const thread = store.createLingThread({ kind: "conversation", title: "Edit report UI", objective: "Edit and verify report UI" }, now);
    const turn = store.createLingTurn({
      threadId: thread.id,
      kind: "initial_request",
      title: "Edit report UI",
      userInstruction: "Edit and verify report UI",
    }, now);
    const run = store.createRun({
      id: "run_terminal_turn_executed",
      cwd,
      taskId: task.id,
      providerName: "test-provider",
      providerModel: "test-model",
      taskSnapshot: { id: task.id, title: task.title },
      providerSnapshot: { provider: "test-provider", model: "test-model" },
      requestSnapshot: { cwd, responseLanguage: "zh-CN" },
      threadId: thread.id,
      turnId: turn.id,
      createdAt: "2026-07-11T06:01:00.000Z",
    });
    store.appendEvent(run.id, "tool_start", { toolCallId: "edit_ui", toolName: "edit", args: { path: "apps/web/src/view.tsx" } });
    store.appendEvent(run.id, "tool_end", { toolCallId: "edit_ui", toolName: "edit", isError: false });
    store.createArtifact({ runId: run.id, type: "file", path: "apps/web/src/view.tsx", title: "view.tsx", createdAt: "2026-07-11T06:01:30.000Z" });
    store.markRunSucceeded(run.id, "2026-07-11T06:02:00.000Z");

    const result = await processTurnTerminalReport(store, turn.id, { now: "2026-07-11T06:03:00.000Z" });
    assert.ok(result);
    assert.equal(result.record.report?.source.kind, "turn");
    assert.equal(result.record.report?.threadId, thread.id);
    assert.equal(result.message, undefined);
    assert.equal(store.getWorkUnit(result.workUnit?.id ?? "")?.ownerType, "turn");

    const plainTask = store.createTask({ channelId: channel.id, title: "Answer question", prompt: "Answer question" }, now);
    const plainRun = store.createRun({
      id: "run_terminal_plain_reply",
      cwd,
      taskId: plainTask.id,
      providerName: "test-provider",
      providerModel: "test-model",
      taskSnapshot: { id: plainTask.id, title: plainTask.title },
      providerSnapshot: { provider: "test-provider", model: "test-model" },
      requestSnapshot: { cwd, responseLanguage: "zh-CN" },
      createdAt: "2026-07-11T06:04:00.000Z",
    });
    store.appendEvent(plainRun.id, "assistant_text_delta", { text: "这是一个普通回答。" });
    store.markRunSucceeded(plainRun.id, "2026-07-11T06:05:00.000Z");
    assert.equal(await processRunTerminalReport(store, plainRun.id, { now: "2026-07-11T06:06:00.000Z" }), undefined);
    assert.equal(store.listTerminalReports({ sourceKind: "run", sourceId: plainRun.id }).length, 0);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("terminal report recovery never turns an ordinary channel reply into a task completion message", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-terminal-report-channel-reply-recovery-"));
  const store = createSqliteRunStore(cwd);
  try {
    configureTerminalReportStore(store, { enabled: true });
    const now = "2026-07-12T06:00:00.000Z";
    const channel = store.createChannel({ name: "Conversation channel", boundPath: cwd }, now);
    const source = appendChannelItemFixture(store, {
      channelId: channel.id,
      authorType: "local-user",
      body: "请生成一张图片",
    }, now);
    const reply = appendChannelItemFixture(store, {
      channelId: channel.id,
      replyToItemId: source.id,
      kind: "ai_reply",
      authorType: "ai-teammate",
      authorId: "ling_agent",
      body: "已开始生成图片。",
      status: "ready",
    }, "2026-07-12T06:00:01.000Z");
    const runId = "run_terminal_report_channel_reply_recovery";
    const task = store.createTask({ channelId: channel.id, title: "Channel reply", prompt: source.body }, now);
    const run = store.createRun({
      id: runId,
      cwd,
      taskId: task.id,
      channelId: channel.id,
      threadId: source.threadId,
      providerName: "test-provider",
      providerModel: "test-model",
      taskSnapshot: { id: task.id, title: task.title },
      providerSnapshot: { provider: "test-provider", model: "test-model" },
      requestSnapshot: { cwd, sourceMessageId: source.id, linkedMessageId: reply.id },
      createdAt: "2026-07-12T06:00:03.000Z",
    });
    const workUnit = store.createWorkUnit({
      workspaceId: channel.workspaceId,
      kind: "channel_ai_reply",
      ownerType: "channel_message",
      ownerId: source.id,
      channelId: channel.id,
      idempotencyKey: "terminal-report-channel-reply-recovery",
      createdByActor: "local-user",
      request: { sourceMessageId: source.id },
      linkedRunId: run.id,
      linkedMessageId: reply.id,
      now: "2026-07-12T06:00:04.000Z",
    });
    assert.equal(run.workUnitId, undefined);
    assert.equal(store.listWorkUnits({ kind: "channel_ai_reply", linkedRunId: run.id })[0]?.id, workUnit.id);
    store.appendEvent(run.id, "tool_start", { toolCallId: "image", toolName: "image_generate", args: {} });
    store.appendEvent(run.id, "tool_end", { toolCallId: "image", toolName: "image_generate", isError: false });
    store.markRunSucceeded(run.id, "2026-07-12T06:00:05.000Z");

    await recoverTerminalReports(store);

    assert.equal(store.listTerminalReports({ sourceKind: "run", sourceId: run.id }).length, 0);
    assert.equal(
      listChannelItemViewsFixture(store, { channelId: channel.id, limit: 100 })
        .filter((message) => message.id.startsWith("result_terminal_report:"))
        .length,
      0,
    );
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("terminal report coordinator commits fallback, publishes once, and closes its work unit", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-terminal-report-coordinator-"));
  const store = createSqliteRunStore(cwd);
  try {
    const fixture = createTerminalWorkflowFixture(store, cwd, "enabled");
    const controlPlaneEvents = new ControlPlaneEventHub();
    configureTerminalReportStore(store, {
      enabled: true,
      barrierDeadlineMs: 50,
      barrierPollIntervalMs: 5,
      onPublished: ({ event }) => controlPlaneEvents.publish(event),
    });
    const result = await processWorkflowTerminalReport(store, fixture.workflow.id, {
      now: "2026-07-11T05:04:00.000Z",
    });
    assert.equal(result.record.status, "fallback");
    assert.ok(result.record.resultItemId);
    assert.equal(result.message?.id, result.record.resultItemId);
    assert.equal(result.message?.body, "succeeded");
    assert.match(result.record.report?.outcome.summary ?? "", /完成 2\/2/u);
    assert.deepEqual(
      result.record.report?.participants.map((participant) => participant.displayName),
      ["Engineer", "QA"],
    );
    assert.equal(store.getWorkUnit(result.workUnit?.id ?? "")?.status, "succeeded");
    const sessionView = buildLingAgentSessionViewForChannel({ store, channelId: fixture.channel.id });
    assert.equal(sessionView.status, "succeeded");
    assert.equal(sessionView.finalResult?.summary, result.record.report?.outcome.summary);
    assert.deepEqual(sessionView.finalResult?.artifactIds, result.record.report?.artifacts.map((artifact) => artifact.id));

    const repeated = await processWorkflowTerminalReport(store, fixture.workflow.id, {
      now: "2026-07-11T05:05:00.000Z",
    });
    assert.equal(repeated.record.id, result.record.id);
    assert.equal(repeated.message?.id, result.message?.id);
    assert.equal(store.listConversationItemsByChannelPage({
      channelId: fixture.channel.id,
      kinds: ["terminal_report"],
      effectiveOnly: true,
      limit: 100,
    }).items.filter((item) => item.id === result.message?.id).length, 1);
    assert.equal(store.listTerminalReports({ sourceKind: "workflow", sourceId: fixture.workflow.id }).length, 1);
    const publicationEvents = store.listControlPlaneEvents({
      workspaceId: "workspace_default",
      domains: ["work_units"],
      limit: 100,
    }).filter((event) => event.action === "terminal_report.published");
    assert.equal(publicationEvents.length, 1);
    assert.deepEqual(publicationEvents[0]?.data, {
      channelId: fixture.channel.id,
      sourceKind: "workflow",
      sourceId: fixture.workflow.id,
      resultItemId: result.message?.id,
      status: "fallback",
    });
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("terminal report recovery reuses the atomic publication event without duplicating the result", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-terminal-report-publication-recovery-"));
  const store = createSqliteRunStore(cwd);
  try {
    const fixture = createTerminalWorkflowFixture(store, cwd, "publication-recovery");
    configureTerminalReportStore(store, {
      enabled: true,
      barrierDeadlineMs: 50,
      barrierPollIntervalMs: 5,
    });
    const published = await processWorkflowTerminalReport(store, fixture.workflow.id, {
      now: "2026-07-11T05:04:00.000Z",
    });
    assert.ok(published.message);
    assert.equal(store.listControlPlaneEvents({
      workspaceId: "workspace_default",
      domains: ["work_units"],
      entityType: "terminal_report",
      entityId: published.record.id,
      action: "terminal_report.published",
      limit: 10,
    }).length, 1);

    const controlPlaneEvents = new ControlPlaneEventHub();
    configureTerminalReportStore(store, {
      enabled: true,
      barrierDeadlineMs: 50,
      barrierPollIntervalMs: 5,
      onPublished: ({ event }) => controlPlaneEvents.publish(event),
    });
    await recoverTerminalReports(store);
    const recovered = store.getTerminalReport(published.record.id);
    assert.equal(recovered?.id, published.record.id);
    assert.equal(recovered?.resultItemId, published.message?.id);
    assert.equal(store.listConversationItemsByChannelPage({
      channelId: fixture.channel.id,
      kinds: ["terminal_report"],
      effectiveOnly: true,
      limit: 100,
    }).items.filter((item) => item.id === published.message?.id).length, 1);
    assert.equal(store.listControlPlaneEvents({
      workspaceId: "workspace_default",
      domains: ["work_units"],
      entityType: "terminal_report",
      entityId: published.record.id,
      action: "terminal_report.published",
      limit: 10,
    }).length, 1);

    await processWorkflowTerminalReport(store, fixture.workflow.id, {
      now: "2026-07-11T05:06:00.000Z",
    });
    assert.equal(store.listControlPlaneEvents({
      workspaceId: "workspace_default",
      domains: ["work_units"],
      entityType: "terminal_report",
      entityId: published.record.id,
      action: "terminal_report.published",
      limit: 10,
    }).length, 1);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("workflow terminal report creates a superseding revision when late Host evidence arrives", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-terminal-report-revision-"));
  const store = createSqliteRunStore(cwd);
  try {
    const fixture = createTerminalWorkflowFixture(store, cwd, "revision");
    store.updateChannelWorkflow(fixture.workflow.id, { status: "blocked" }, "2026-07-11T05:09:00.000Z");
    configureTerminalReportStore(store, { enabled: true, barrierDeadlineMs: 50, barrierPollIntervalMs: 5 });

    const first = await processWorkflowTerminalReport(store, fixture.workflow.id, {
      now: "2026-07-11T05:10:00.000Z",
    });
    assert.ok(first.message);
    assert.equal(first.record.generation, 1);

    // A retry reopens the blocked source turn and workflow before producing
    // new evidence. This is the supported path for changing a terminal
    // report's outcome; a succeeded source turn remains immutable.
    const sourceTurnId = fixture.workflow.metadata.sourceTurnId;
    assert.ok(sourceTurnId);
    store.transitionLingTurnStatus({
      turnId: sourceTurnId,
      expectedStatus: "blocked",
      event: "start",
      actor: "system",
      reason: "workflow retry",
      idempotencyKey: `test-retry:${fixture.workflow.id}:source-turn:start`,
      now: "2026-07-11T05:10:10.000Z",
    });
    store.transitionChannelWorkflowStatus({
      workflowId: fixture.workflow.id,
      expectedStatus: "blocked",
      event: "start",
      actor: "system",
      reason: "workflow retry",
      now: "2026-07-11T05:10:11.000Z",
    });
    store.transitionChannelWorkflowStatus({
      workflowId: fixture.workflow.id,
      expectedStatus: "running",
      event: "all_steps_succeeded",
      actor: "system",
      reason: "workflow retry completed",
      now: "2026-07-11T05:10:12.000Z",
    });

    // A late, durable Host action is new evidence for the same workflow. The
    // second projection must not reuse the old report or leave both messages
    // visible as independent terminal outcomes.
    store.appendEvent(fixture.qaRun.id, "tool_start", {
      toolCallId: "qa_late_typecheck",
      toolName: "bash",
      args: { command: "pnpm test" },
    });
    store.appendEvent(fixture.qaRun.id, "tool_end", {
      toolCallId: "qa_late_typecheck",
      toolName: "bash",
      isError: false,
    });

    const second = await processWorkflowTerminalReport(store, fixture.workflow.id, {
      now: "2026-07-11T05:11:00.000Z",
    });
    assert.ok(second.message);
    assert.notEqual(second.message?.id, first.message?.id);
    assert.equal(second.record.generation, 2);
    assert.equal(store.listTerminalReports({ sourceKind: "workflow", sourceId: fixture.workflow.id }).length, 2);
    assert.equal(store.getConversationItem(second.message?.id ?? "")?.supersedesItemId, first.message?.id);
    assert.deepEqual(
      store.listConversationItemsByChannelPage({
        channelId: fixture.channel.id,
        kinds: ["terminal_report"],
        effectiveOnly: true,
        limit: 100,
      }).items
        .filter((item) => item.id.startsWith("result_terminal_report:"))
        .map((item) => item.id),
      [second.message?.id],
    );
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("terminal report recovery republishes only the latest committed revision per source", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-terminal-report-recovery-history-"));
  const store = createSqliteRunStore(cwd);
  let reopened;
  try {
    const fixture = createTerminalWorkflowFixture(store, cwd, "recovery-history");
    store.updateChannelWorkflow(fixture.workflow.id, { status: "blocked" }, "2026-07-11T05:19:00.000Z");
    configureTerminalReportStore(store, { enabled: true, barrierDeadlineMs: 50, barrierPollIntervalMs: 5 });

    const first = await processWorkflowTerminalReport(store, fixture.workflow.id, {
      now: "2026-07-11T05:20:00.000Z",
    });
    assert.ok(first.message);

    // Leave generation 1 committed but without its publication marker, as if
    // the daemon crashed between report commit and message publication.
    store.close();
    const database = new DatabaseSync(resolveRuntimePaths(cwd).databasePath);
    try {
      database.prepare("UPDATE ling_terminal_reports SET result_item_id = NULL WHERE id = ?").run(first.record.id);
      database.prepare("DELETE FROM conversation_items WHERE id = ?").run(first.message?.id);
    } finally {
      database.close();
    }
    reopened = createSqliteRunStore(cwd);
    configureTerminalReportStore(reopened, { enabled: true, barrierDeadlineMs: 50, barrierPollIntervalMs: 5 });
    const sourceTurnId = fixture.workflow.metadata.sourceTurnId;
    assert.ok(sourceTurnId);
    reopened.transitionLingTurnStatus({
      turnId: sourceTurnId,
      expectedStatus: "blocked",
      event: "start",
      actor: "system",
      reason: "workflow retry",
      idempotencyKey: "recovery-history-retry",
      now: "2026-07-11T05:20:10.000Z",
    });
    reopened.transitionChannelWorkflowStatus({
      workflowId: fixture.workflow.id,
      expectedStatus: "blocked",
      event: "start",
      actor: "system",
      reason: "workflow retry",
      now: "2026-07-11T05:20:11.000Z",
    });
    reopened.transitionChannelWorkflowStatus({
      workflowId: fixture.workflow.id,
      expectedStatus: "running",
      event: "all_steps_succeeded",
      actor: "system",
      reason: "workflow retry completed",
      now: "2026-07-11T05:20:12.000Z",
    });
    reopened.appendEvent(fixture.qaRun.id, "tool_start", {
      toolCallId: "qa_recovery_history",
      toolName: "bash",
      args: { command: "pnpm test" },
    });
    reopened.appendEvent(fixture.qaRun.id, "tool_end", {
      toolCallId: "qa_recovery_history",
      toolName: "bash",
      isError: false,
    });
    const second = await processWorkflowTerminalReport(reopened, fixture.workflow.id, {
      now: "2026-07-11T05:21:00.000Z",
    });
    assert.ok(second.message);
    assert.equal(second.record.generation, 2);

    await recoverTerminalReports(reopened);
    assert.deepEqual(
      reopened.listConversationItemsByChannelPage({
        channelId: fixture.channel.id,
        kinds: ["terminal_report"],
        effectiveOnly: true,
        limit: 100,
      }).items
        .filter((item) => item.id.startsWith("result_terminal_report:"))
        .map((item) => item.id),
      [second.message?.id],
    );
  } finally {
    try { store.close(); } catch {}
    try { reopened?.close(); } catch {}
    await rm(cwd, { recursive: true, force: true });
  }
});
