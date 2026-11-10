import type { SQLOutputValue } from "node:sqlite";
import {
  createTerminalReportId,
  type CommitLingTerminalReportInput,
  type CreateLingTerminalReportInput,
  type FailLingTerminalReportInput,
  type LingTerminalReportRecord,
  type ListLingTerminalReportsOptions,
  type MarkLingTerminalReportPublishedInput,
  type TerminalReportEvidenceSnapshot,
  type TerminalReportSourceKind,
  type UpdateLingTerminalReportDraftInput,
} from "../../terminal-report-types.js";
import {
  validateTerminalReport,
  validateTerminalReportEvidenceSnapshot,
} from "../../terminal-report-validation.js";
import { DEFAULT_WORKSPACE_ID } from "../../workspace-types.js";
import { stringifyJson } from "./helpers.js";
import { mapTerminalReport } from "./terminal-report-mappers.js";
import { terminalReportSelectSql } from "./select-sql.js";
import type { SqliteStoreContext } from "./store-context.js";

export class SqliteTerminalReportStore {
  constructor(private readonly context: SqliteStoreContext) {}

  createTerminalReportDraft(input: CreateLingTerminalReportInput, now: string): LingTerminalReportRecord {
    assertValidSnapshot(input.evidenceSnapshot);
    const generation = input.generation ?? 1;
    if (!Number.isSafeInteger(generation) || generation < 1) {
      throw new Error("Terminal report generation must be a positive integer.");
    }

    const snapshot = input.evidenceSnapshot;
    const id = input.id ?? createTerminalReportId();
    this.context.database
      .prepare(`
        INSERT INTO ling_terminal_reports (
          id,
          workspace_id,
          channel_id,
          thread_id,
          turn_id,
          source_message_id,
          source_kind,
          source_id,
          generation,
          status,
          outcome_status,
          language,
          evidence_snapshot_json,
          evidence_fingerprint,
          report_json,
          synthesis_mode,
          prompt_version,
          attempt_count,
          validation_codes_json,
          result_item_id,
          error_code,
          created_at,
          updated_at,
          committed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', NULL, ?, ?, ?, NULL, NULL, NULL, 0, '[]', NULL, NULL, ?, ?, NULL)
        ON CONFLICT(workspace_id, source_kind, source_id, generation) DO NOTHING
      `)
      .run(
        id,
        snapshot.workspaceId,
        snapshot.channelId ?? null,
        snapshot.threadId ?? null,
        snapshot.turnId ?? null,
        snapshot.sourceMessageId ?? null,
        snapshot.source.kind,
        snapshot.source.id,
        generation,
        snapshot.language,
        stringifyJson(snapshot),
        snapshot.evidenceFingerprint,
        now,
        now,
      );

    const record = this.getTerminalReportForSource(
      snapshot.source.kind,
      snapshot.source.id,
      generation,
      snapshot.workspaceId,
    );
    if (!record) {
      throw new Error(`Failed to create terminal report draft: ${id}`);
    }
    return record;
  }

  getTerminalReport(id: string): LingTerminalReportRecord | undefined {
    const row = this.context.database.prepare(terminalReportSelectSql("WHERE id = ?")).get(id);
    return row ? mapTerminalReport(row as Record<string, SQLOutputValue>) : undefined;
  }

  getTerminalReportForSource(
    sourceKind: TerminalReportSourceKind,
    sourceId: string,
    generation = 1,
    workspaceId = DEFAULT_WORKSPACE_ID,
  ): LingTerminalReportRecord | undefined {
    const row = this.context.database
      .prepare(terminalReportSelectSql("WHERE workspace_id = ? AND source_kind = ? AND source_id = ? AND generation = ?"))
      .get(workspaceId, sourceKind, sourceId, generation);
    return row ? mapTerminalReport(row as Record<string, SQLOutputValue>) : undefined;
  }

  listTerminalReports(options: ListLingTerminalReportsOptions = {}): LingTerminalReportRecord[] {
    const clauses = ["workspace_id = ?"];
    const params: Array<string | number> = [options.workspaceId ?? DEFAULT_WORKSPACE_ID];
    if (options.channelId) {
      clauses.push("channel_id = ?");
      params.push(options.channelId);
    }
    if (options.threadId) {
      clauses.push("thread_id = ?");
      params.push(options.threadId);
    }
    if (options.sourceKind) {
      clauses.push("source_kind = ?");
      params.push(options.sourceKind);
    }
    if (options.sourceId) {
      clauses.push("source_id = ?");
      params.push(options.sourceId);
    }
    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    }
    if (options.publishedOnly) {
      clauses.push("status IN ('committed', 'fallback')");
      clauses.push(publishedReportPredicate("ling_terminal_reports"));
    }
    if (options.effectiveOnly) {
      // Internal coordination still selects the newest committed evidence.
      // Display/context readers additionally require a canonical publication,
      // both here and in the successor test, before applying the result limit.
      clauses.push(`NOT EXISTS (
        SELECT 1
        FROM ling_terminal_reports AS newer
        WHERE newer.workspace_id = ling_terminal_reports.workspace_id
          AND newer.source_kind = ling_terminal_reports.source_kind
          AND newer.source_id = ling_terminal_reports.source_id
          AND newer.generation > ling_terminal_reports.generation
          AND newer.status IN ('committed', 'fallback')
          ${options.publishedOnly ? `AND ${publishedReportPredicate("newer")}` : ""}
      )`);
      clauses.push("status IN ('committed', 'fallback')");
    }
    params.push(Math.min(Math.max(options.limit ?? 100, 1), 500));
    return this.context.database
      .prepare(`${terminalReportSelectSql(`WHERE ${clauses.join(" AND ")}`)} ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(...params)
      .map((row) => mapTerminalReport(row as Record<string, SQLOutputValue>));
  }

  updateTerminalReportDraft(input: UpdateLingTerminalReportDraftInput): LingTerminalReportRecord {
    const current = this.requireMutableReport(input.reportId);
    assertExpectedDraft(current, input.expectedStatus, input.expectedEvidenceFingerprint);
    const snapshot = input.evidenceSnapshot ?? current.evidenceSnapshot;
    assertValidSnapshot(snapshot);
    assertSameSource(current, snapshot);

    const result = this.context.database
      .prepare(`
        UPDATE ling_terminal_reports
        SET
          status = ?,
          language = ?,
          evidence_snapshot_json = ?,
          evidence_fingerprint = ?,
          prompt_version = ?,
          attempt_count = ?,
          validation_codes_json = ?,
          updated_at = ?
        WHERE id = ? AND status = ? AND evidence_fingerprint = ? AND report_json IS NULL
      `)
      .run(
        input.status ?? current.status,
        snapshot.language,
        stringifyJson(snapshot),
        snapshot.evidenceFingerprint,
        input.promptVersion ?? current.promptVersion ?? null,
        input.attemptCount ?? current.attemptCount,
        stringifyJson(input.validationCodes ?? current.validationCodes),
        input.now,
        input.reportId,
        input.expectedStatus,
        input.expectedEvidenceFingerprint,
      );
    if (result.changes !== 1) {
      throw new Error(`Terminal report draft compare-and-set failed: ${input.reportId}`);
    }
    return this.requireReport(input.reportId);
  }

  commitTerminalReport(input: CommitLingTerminalReportInput): LingTerminalReportRecord {
    const current = this.requireMutableReport(input.reportId);
    assertExpectedDraft(current, input.expectedStatus, input.expectedEvidenceFingerprint);
    const validation = validateTerminalReport(input.report, current.evidenceSnapshot);
    if (!validation.ok) {
      throw new Error(`Invalid terminal report: ${validation.issues.map((item) => item.code).join(", ")}`);
    }
    if (
      input.report.status !== (input.synthesisMode === "deterministic_fallback" ? "fallback" : "committed") ||
      input.report.synthesis.mode !== input.synthesisMode ||
      input.report.synthesis.promptVersion !== input.promptVersion ||
      input.report.synthesis.attemptCount !== input.attemptCount
    ) {
      throw new Error("Terminal report synthesis metadata does not match the commit request.");
    }

    const validationCodes = input.validationCodes ?? input.report.synthesis.validationCodes;
    const result = this.context.database
      .prepare(`
        UPDATE ling_terminal_reports
        SET
          status = ?,
          outcome_status = ?,
          report_json = ?,
          synthesis_mode = ?,
          prompt_version = ?,
          attempt_count = ?,
          validation_codes_json = ?,
          error_code = NULL,
          updated_at = ?,
          committed_at = ?
        WHERE id = ? AND status = ? AND evidence_fingerprint = ? AND report_json IS NULL
      `)
      .run(
        input.report.status,
        input.report.outcome.status,
        stringifyJson(input.report),
        input.synthesisMode,
        input.promptVersion,
        input.attemptCount,
        stringifyJson(validationCodes),
        input.now,
        input.now,
        input.reportId,
        input.expectedStatus,
        input.expectedEvidenceFingerprint,
      );
    if (result.changes !== 1) {
      throw new Error(`Terminal report commit compare-and-set failed: ${input.reportId}`);
    }
    return this.requireReport(input.reportId);
  }

  markTerminalReportPublished(input: MarkLingTerminalReportPublishedInput): LingTerminalReportRecord {
    const current = this.requireReport(input.reportId);
    if (current.status !== "committed" && current.status !== "fallback") {
      throw new Error(`Only committed terminal reports can be published: ${input.reportId}`);
    }
    if (current.resultItemId) {
      if (current.resultItemId !== input.messageId) {
        throw new Error(`Terminal report is already published by another message: ${input.reportId}`);
      }
      return current;
    }

    const result = this.context.database
      .prepare(`
        UPDATE ling_terminal_reports
        SET result_item_id = ?, updated_at = ?
        WHERE id = ? AND result_item_id IS NULL AND status IN ('committed', 'fallback')
      `)
      .run(input.messageId, input.now, input.reportId);
    if (result.changes !== 1) {
      const raced = this.requireReport(input.reportId);
      if (raced.resultItemId === input.messageId) {
        return raced;
      }
      throw new Error(`Terminal report publication compare-and-set failed: ${input.reportId}`);
    }
    return this.requireReport(input.reportId);
  }

  failTerminalReport(input: FailLingTerminalReportInput): LingTerminalReportRecord {
    const current = this.requireReport(input.reportId);
    if (current.status === "failed") {
      return current;
    }
    if (current.status === "committed" || current.status === "fallback") {
      throw new Error(`Committed terminal reports are immutable: ${input.reportId}`);
    }
    if (input.expectedStatus && current.status !== input.expectedStatus) {
      throw new Error(`Terminal report status compare-and-set failed: ${input.reportId}`);
    }
    if (input.expectedEvidenceFingerprint && current.evidenceFingerprint !== input.expectedEvidenceFingerprint) {
      throw new Error(`Terminal report fingerprint compare-and-set failed: ${input.reportId}`);
    }

    this.context.database
      .prepare(`
        UPDATE ling_terminal_reports
        SET status = 'failed', error_code = ?, validation_codes_json = ?, attempt_count = ?, updated_at = ?
        WHERE id = ? AND status IN ('draft', 'validating') AND report_json IS NULL
      `)
      .run(
        input.errorCode,
        stringifyJson(input.validationCodes ?? current.validationCodes),
        input.attemptCount ?? current.attemptCount,
        input.now,
        input.reportId,
      );
    return this.requireReport(input.reportId);
  }

  private requireReport(id: string): LingTerminalReportRecord {
    const report = this.getTerminalReport(id);
    if (!report) {
      throw new Error(`Terminal report not found: ${id}`);
    }
    return report;
  }

  private requireMutableReport(id: string): LingTerminalReportRecord {
    const report = this.requireReport(id);
    if (report.status !== "draft" && report.status !== "validating") {
      throw new Error(`Terminal report is immutable: ${id}`);
    }
    return report;
  }
}

/** Fixed internal aliases only; no caller data is interpolated into this SQL. */
function publishedReportPredicate(alias: "ling_terminal_reports" | "newer"): string {
  return `EXISTS (
    SELECT 1 FROM conversation_items AS publication
    WHERE publication.id = ${alias}.result_item_id
      AND publication.workspace_id = ${alias}.workspace_id
      AND publication.channel_id IS ${alias}.channel_id
      AND (${alias}.thread_id IS NULL OR publication.thread_id = ${alias}.thread_id)
      AND (${alias}.turn_id IS NULL OR publication.turn_id = ${alias}.turn_id)
      AND publication.kind = 'terminal_report' AND publication.status = 'committed'
      AND publication.visibility IN ('channel', 'thread_participants')
      AND publication.visibility_owner_id IS NULL
      AND json_extract(publication.payload_json, '$.reportId') = ${alias}.id
      AND json_extract(publication.payload_json, '$.generation') = ${alias}.generation
      AND json_extract(publication.payload_json, '$.sourceKind') = ${alias}.source_kind
      AND json_extract(publication.payload_json, '$.sourceId') = ${alias}.source_id
      AND json_extract(publication.payload_json, '$.evidenceFingerprint') = ${alias}.evidence_fingerprint
      AND json_extract(publication.payload_json, '$.outcomeStatus') = ${alias}.outcome_status
      AND (${alias}.source_message_id IS NULL OR EXISTS (
        SELECT 1 FROM conversation_items AS source
        WHERE source.id = ${alias}.source_message_id
          AND source.workspace_id = publication.workspace_id
          AND source.channel_id IS publication.channel_id
          AND source.thread_id = publication.thread_id AND source.turn_id = publication.turn_id
      ))
  )`;
}

function assertValidSnapshot(snapshot: TerminalReportEvidenceSnapshot): void {
  const validation = validateTerminalReportEvidenceSnapshot(snapshot);
  if (!validation.ok) {
    throw new Error(`Invalid terminal report evidence snapshot: ${validation.issues.map((item) => item.code).join(", ")}`);
  }
}

function assertExpectedDraft(
  current: LingTerminalReportRecord,
  expectedStatus: "draft" | "validating",
  expectedFingerprint: string,
): void {
  if (current.status !== expectedStatus) {
    throw new Error(`Terminal report status compare-and-set failed: ${current.id}`);
  }
  if (current.evidenceFingerprint !== expectedFingerprint) {
    throw new Error(`Terminal report fingerprint compare-and-set failed: ${current.id}`);
  }
}

function assertSameSource(current: LingTerminalReportRecord, snapshot: TerminalReportEvidenceSnapshot): void {
  if (
    current.workspaceId !== snapshot.workspaceId ||
    current.channelId !== snapshot.channelId ||
    current.threadId !== snapshot.threadId ||
    current.turnId !== snapshot.turnId ||
    current.sourceMessageId !== snapshot.sourceMessageId ||
    current.sourceKind !== snapshot.source.kind ||
    current.sourceId !== snapshot.source.id
  ) {
    throw new Error(`Terminal report draft source identity cannot change: ${current.id}`);
  }
}
