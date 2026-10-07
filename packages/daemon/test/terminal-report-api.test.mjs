import assert from "node:assert/strict";
import { appendChannelItemFixture } from "../../core/test/channel-conversation-fixture.mjs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  buildDeterministicTerminalReport,
  createSqliteRunStore,
  resolveRuntimePaths,
} from "../../core/dist/index.js";
import { createDaemonServer } from "../dist/index.js";
import {
  collectRunTerminalReportEvidence,
  collectWorkflowTerminalReportEvidence,
} from "../dist/features/channels/terminal-report-evidence.js";
import { publishTerminalReport } from "../dist/features/channels/terminal-report-publisher.js";
import { createTerminalWorkflowFixture } from "./terminal-report-coordinator-fixture.mjs";

test("terminal report API exposes committed reports without developer synthesis metadata", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-terminal-report-api-"));
  const store = createSqliteRunStore(cwd);
  const fixture = createTerminalWorkflowFixture(store, cwd, "api");
  const now = "2026-07-11T08:00:00.000Z";
  const snapshot = collectWorkflowTerminalReportEvidence(store, fixture.workflow.id, { generatedAt: now });
  const draft = store.createTerminalReportDraft({ id: "terminal_report_api", evidenceSnapshot: snapshot }, now);
  const validating = store.updateTerminalReportDraft({
    reportId: draft.id,
    expectedStatus: "draft",
    expectedEvidenceFingerprint: draft.evidenceFingerprint,
    status: "validating",
    now,
  });
  const report = buildDeterministicTerminalReport(snapshot, { id: draft.id, committedAt: now });
  store.commitTerminalReport({
    reportId: draft.id,
    expectedStatus: "validating",
    expectedEvidenceFingerprint: validating.evidenceFingerprint,
    report,
    synthesisMode: "deterministic_fallback",
    promptVersion: report.synthesis.promptVersion,
    attemptCount: 0,
    now,
  });
  store.createTerminalReportDraft({ id: "terminal_report_hidden_draft", generation: 2, evidenceSnapshot: snapshot }, now);
  const historicalInvalidReport = persistHistoricalChannelReplyTerminalReport({
    store,
    cwd,
    channel: fixture.channel,
  });
  assert.equal(store.getTerminalReport(historicalInvalidReport.report.id)?.resultItemId, historicalInvalidReport.message.id);
  store.close();

  const paths = resolveRuntimePaths(cwd);
  const database = new DatabaseSync(paths.databasePath);
  try {
    const stored = JSON.parse(database.prepare("SELECT report_json FROM ling_terminal_reports WHERE id = ?").get(report.id).report_json);
    stored.synthesis.model = "internal-model";
    stored.synthesis.providerPresetId = "provider-secret";
    stored.references.push({
      kind: "operation",
      id: "developer_operation",
      label: "Internal operation",
      visibility: "developer_only",
      sensitivity: "secret_adjacent",
    });
    database.prepare("UPDATE ling_terminal_reports SET report_json = ? WHERE id = ?").run(JSON.stringify(stored), report.id);
  } finally {
    database.close();
  }

  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd });
  await daemon.start();
  const address = daemon.server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const list = await getJson(`${baseUrl}/channels/${encodeURIComponent(fixture.channel.id)}/terminal-reports?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(list.reports.length, 1);
    assert.equal(list.reports[0].id, report.id);
    assert.equal(list.reports[0].synthesis.model, undefined);
    assert.equal(list.reports[0].synthesis.providerPresetId, undefined);
    assert.equal(list.reports[0].references.some((ref) => ref.id === "developer_operation"), false);

    const channelItems = await getJson(`${baseUrl}/channels/${encodeURIComponent(fixture.channel.id)}/items?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(channelItems.items.some((item) => item.id === historicalInvalidReport.message.id), false);

    const channelReplyReports = await getJson(`${baseUrl}/channels/${encodeURIComponent(fixture.channel.id)}/terminal-reports?cwd=${encodeURIComponent(cwd)}&sourceKind=run&sourceId=${encodeURIComponent(historicalInvalidReport.run.id)}`);
    assert.deepEqual(channelReplyReports.reports, []);

    const channelReplyReportDetail = await requestJson(`${baseUrl}/terminal-reports/${encodeURIComponent(historicalInvalidReport.report.id)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(channelReplyReportDetail.status, 404);
    assert.equal(channelReplyReportDetail.body.error, "terminal_report_not_found");

    const detail = await getJson(`${baseUrl}/terminal-reports/${encodeURIComponent(report.id)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(detail.report.id, report.id);
    assert.equal(detail.report.synthesis.model, undefined);

    const missing = await requestJson(`${baseUrl}/terminal-reports/missing?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error, "terminal_report_not_found");
  } finally {
    await daemon.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("terminal report API returns only the latest effective generation by default", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-terminal-report-api-history-"));
  const store = createSqliteRunStore(cwd);
  const fixture = createTerminalWorkflowFixture(store, cwd, "history");
  const firstNow = "2026-07-11T09:00:00.000Z";
  const firstSnapshot = collectWorkflowTerminalReportEvidence(store, fixture.workflow.id, { generatedAt: firstNow });
  const firstDraft = store.createTerminalReportDraft({ id: "terminal_report_history_1", evidenceSnapshot: firstSnapshot }, firstNow);
  const firstValidating = store.updateTerminalReportDraft({
    reportId: firstDraft.id,
    expectedStatus: "draft",
    expectedEvidenceFingerprint: firstDraft.evidenceFingerprint,
    status: "validating",
    now: firstNow,
  });
  const firstReport = buildDeterministicTerminalReport(firstSnapshot, { id: firstDraft.id, committedAt: firstNow });
  store.commitTerminalReport({
    reportId: firstDraft.id,
    expectedStatus: "validating",
    expectedEvidenceFingerprint: firstValidating.evidenceFingerprint,
    report: firstReport,
    synthesisMode: "deterministic_fallback",
    promptVersion: firstReport.synthesis.promptVersion,
    attemptCount: 0,
    now: firstNow,
  });

  const secondSnapshot = collectWorkflowTerminalReportEvidence(store, fixture.workflow.id, { generatedAt: "2026-07-11T09:01:00.000Z" });
  const secondDraft = store.createTerminalReportDraft({ id: "terminal_report_history_2", generation: 2, evidenceSnapshot: secondSnapshot }, "2026-07-11T09:01:00.000Z");
  const secondValidating = store.updateTerminalReportDraft({
    reportId: secondDraft.id,
    expectedStatus: "draft",
    expectedEvidenceFingerprint: secondDraft.evidenceFingerprint,
    status: "validating",
    now: "2026-07-11T09:01:00.000Z",
  });
  const secondReport = buildDeterministicTerminalReport(secondSnapshot, { id: secondDraft.id, committedAt: "2026-07-11T09:01:00.000Z" });
  store.commitTerminalReport({
    reportId: secondDraft.id,
    expectedStatus: "validating",
    expectedEvidenceFingerprint: secondValidating.evidenceFingerprint,
    report: secondReport,
    synthesisMode: "deterministic_fallback",
    promptVersion: secondReport.synthesis.promptVersion,
    attemptCount: 0,
    now: "2026-07-11T09:01:00.000Z",
  });
  store.close();

  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd });
  await daemon.start();
  const address = daemon.server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const current = await getJson(`${baseUrl}/channels/${encodeURIComponent(fixture.channel.id)}/terminal-reports?cwd=${encodeURIComponent(cwd)}`);
    assert.deepEqual(current.reports.map((report) => report.id), [secondReport.id]);
    const history = await getJson(`${baseUrl}/channels/${encodeURIComponent(fixture.channel.id)}/terminal-reports?cwd=${encodeURIComponent(cwd)}&includeHistory=true`);
    assert.deepEqual(history.reports.map((report) => report.id).sort(), [firstReport.id, secondReport.id].sort());
  } finally {
    await daemon.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

function persistHistoricalChannelReplyTerminalReport({ store, cwd, channel }) {
  const source = appendChannelItemFixture(store, {
    channelId: channel.id,
    authorType: "local-user",
    body: "生成一张测试图片",
  }, "2026-07-11T08:01:00.000Z");
  const reply = appendChannelItemFixture(store, {
    channelId: channel.id,
    replyToItemId: source.id,
    kind: "ai_reply",
    authorType: "ai-teammate",
    authorId: "ling_agent",
    body: "已开始生成图片。",
    status: "ready",
  }, "2026-07-11T08:01:01.000Z");
  const workUnit = store.createWorkUnit({
    workspaceId: channel.workspaceId,
    kind: "channel_ai_reply",
    ownerType: "channel_message",
    ownerId: source.id,
    channelId: channel.id,
    idempotencyKey: "terminal-report-api-historical-channel-reply",
    createdByActor: "local-user",
    request: { sourceMessageId: source.id },
    linkedMessageId: reply.id,
    now: "2026-07-11T08:01:02.000Z",
  });
  const task = store.createTask({
    channelId: channel.id,
    title: "Generate test image",
    prompt: source.body,
  }, "2026-07-11T08:01:02.000Z");
  const run = store.createRun({
    id: "run_terminal_report_api_historical_channel_reply",
    cwd,
    taskId: task.id,
    channelId: channel.id,
    threadId: source.threadId,
    turnId: source.turnId,
    providerName: "test-provider",
    providerModel: "test-model",
    taskSnapshot: { id: task.id, title: task.title },
    providerSnapshot: { provider: "test-provider", model: "test-model" },
    requestSnapshot: { cwd, sourceMessageId: source.id, linkedMessageId: reply.id },
    workUnitId: workUnit.id,
    createdAt: "2026-07-11T08:01:03.000Z",
  });
  store.linkRunToWorkUnit(run.id, workUnit.id, "2026-07-11T08:01:04.000Z");
  store.appendEvent(run.id, "tool_start", { toolCallId: "image", toolName: "image_generate", args: {} });
  store.appendEvent(run.id, "tool_end", { toolCallId: "image", toolName: "image_generate", isError: false });
  store.markRunSucceeded(run.id, "2026-07-11T08:01:05.000Z");

  const snapshot = collectRunTerminalReportEvidence(store, run.id, {
    generatedAt: "2026-07-11T08:01:06.000Z",
  });
  const draft = store.createTerminalReportDraft({
    id: "terminal_report_api_historical_channel_reply",
    evidenceSnapshot: snapshot,
  }, "2026-07-11T08:01:06.000Z");
  const validating = store.updateTerminalReportDraft({
    reportId: draft.id,
    expectedStatus: "draft",
    expectedEvidenceFingerprint: draft.evidenceFingerprint,
    status: "validating",
    now: "2026-07-11T08:01:06.000Z",
  });
  const report = buildDeterministicTerminalReport(snapshot, {
    id: draft.id,
    committedAt: "2026-07-11T08:01:06.000Z",
  });
  store.commitTerminalReport({
    reportId: draft.id,
    expectedStatus: "validating",
    expectedEvidenceFingerprint: validating.evidenceFingerprint,
    report,
    synthesisMode: "deterministic_fallback",
    promptVersion: report.synthesis.promptVersion,
    attemptCount: 0,
    now: "2026-07-11T08:01:06.000Z",
  });
  const message = publishTerminalReport({
    store,
    report,
    linkedRunId: run.id,
    now: "2026-07-11T08:01:07.000Z",
  });
  assert.ok(message);
  return { message, report, run };
}

async function getJson(url) {
  const response = await fetch(url);
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return JSON.parse(text);
}

async function requestJson(url) {
  const response = await fetch(url);
  const text = await response.text();
  return { status: response.status, body: JSON.parse(text) };
}
