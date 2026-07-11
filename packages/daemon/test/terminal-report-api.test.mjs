import assert from "node:assert/strict";
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
import { collectWorkflowTerminalReportEvidence } from "../dist/features/channels/terminal-report-evidence.js";
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

  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0 });
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
