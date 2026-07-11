import type { SQLOutputValue } from "node:sqlite";
import type {
  LingTerminalReportRecord,
  TerminalReport,
  TerminalReportEvidenceSnapshot,
} from "../../terminal-report-types.js";
import {
  omitUndefined,
  parseJson,
  parseJsonStringArray,
  readNullableString,
  readNumber,
  readString,
} from "./helpers.js";

export function mapTerminalReport(row: Record<string, SQLOutputValue>): LingTerminalReportRecord {
  const reportJson = readNullableString(row, "report_json");
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    channelId: readNullableString(row, "channel_id"),
    threadId: readNullableString(row, "thread_id"),
    turnId: readNullableString(row, "turn_id"),
    sourceMessageId: readNullableString(row, "source_message_id"),
    sourceKind: readString(row, "source_kind") as LingTerminalReportRecord["sourceKind"],
    sourceId: readString(row, "source_id"),
    generation: readNumber(row, "generation"),
    status: readString(row, "status") as LingTerminalReportRecord["status"],
    outcomeStatus: readNullableString(row, "outcome_status") as LingTerminalReportRecord["outcomeStatus"],
    language: readString(row, "language") as LingTerminalReportRecord["language"],
    evidenceSnapshot: parseJson(readString(row, "evidence_snapshot_json")) as TerminalReportEvidenceSnapshot,
    evidenceFingerprint: readString(row, "evidence_fingerprint"),
    report: reportJson ? parseJson(reportJson) as TerminalReport : undefined,
    synthesisMode: readNullableString(row, "synthesis_mode") as LingTerminalReportRecord["synthesisMode"],
    promptVersion: readNullableString(row, "prompt_version"),
    attemptCount: readNumber(row, "attempt_count"),
    validationCodes: parseJsonStringArray(readString(row, "validation_codes_json")),
    publishedMessageId: readNullableString(row, "published_message_id"),
    errorCode: readNullableString(row, "error_code"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
    committedAt: readNullableString(row, "committed_at"),
  });
}
