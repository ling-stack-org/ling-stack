import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { createSqliteRunStore } from "../dist/index.js";
import { buildTerminalReportSnapshot } from "./terminal-report-fixture.mjs";

test("terminal report source generation owns logical create races", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-terminal-report-idempotency-"));
  try {
    const store = createSqliteRunStore(cwd);
    try {
      const snapshot = buildTerminalReportSnapshot();
      const first = store.createTerminalReportDraft({ id: "terminal_report_first", evidenceSnapshot: snapshot }, "2026-07-11T01:05:01.000Z");
      const duplicate = store.createTerminalReportDraft({
        id: "terminal_report_duplicate",
        evidenceSnapshot: buildTerminalReportSnapshot({ objective: "A racing caller used a different snapshot." }),
      }, "2026-07-11T01:05:02.000Z");
      assert.equal(duplicate.id, first.id);
      assert.equal(store.listTerminalReports().length, 1);

      const secondGeneration = store.createTerminalReportDraft({
        id: "terminal_report_generation_two",
        generation: 2,
        evidenceSnapshot: snapshot,
      }, "2026-07-11T01:05:03.000Z");
      assert.equal(secondGeneration.generation, 2);
      assert.equal(store.listTerminalReports().length, 2);
    } finally {
      store.close();
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("terminal report draft CAS and failure lifecycle reject stale writers", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-terminal-report-cas-"));
  try {
    const store = createSqliteRunStore(cwd);
    try {
      const snapshot = buildTerminalReportSnapshot();
      const draft = store.createTerminalReportDraft({ evidenceSnapshot: snapshot }, "2026-07-11T01:05:01.000Z");
      assert.throws(() => store.updateTerminalReportDraft({
        reportId: draft.id,
        expectedStatus: "draft",
        expectedEvidenceFingerprint: "stale-fingerprint",
        now: "2026-07-11T01:05:02.000Z",
      }), /fingerprint compare-and-set/);

      const failed = store.failTerminalReport({
        reportId: draft.id,
        expectedStatus: "draft",
        expectedEvidenceFingerprint: snapshot.evidenceFingerprint,
        errorCode: "terminal_report_synthesis_failed",
        validationCodes: ["terminal_report_schema_invalid"],
        attemptCount: 2,
        now: "2026-07-11T01:05:03.000Z",
      });
      assert.equal(failed.status, "failed");
      assert.equal(failed.errorCode, "terminal_report_synthesis_failed");
      assert.equal(failed.attemptCount, 2);
      assert.deepEqual(failed.validationCodes, ["terminal_report_schema_invalid"]);
      assert.equal(store.failTerminalReport({
        reportId: draft.id,
        errorCode: "ignored_repeat",
        now: "2026-07-11T01:05:04.000Z",
      }).errorCode, "terminal_report_synthesis_failed");
    } finally {
      store.close();
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
