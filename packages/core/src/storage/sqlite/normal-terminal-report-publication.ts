import type { ConversationItemV1 } from "@ling-stack/contracts";
import { captureNormalTerminalReportBasis } from "../../normal-terminal-report-basis.js";
import { computeTerminalReportEvidenceFingerprint, validateTerminalReport } from "../../terminal-report-validation.js";
import type { AppendControlPlaneEventInput } from "../../run-types.js";
import type {
  CommitNormalTerminalReportPublicationInput,
  CommitTerminalReportPublicationResult,
  TerminalReportPublicationConflictCode,
} from "../../terminal-report-publication-types.js";
import type { SqliteStoreContext } from "./store-context.js";
import type { SqliteTerminalReportPublicationStorePorts } from "./terminal-report-publication-store.js";
import { readSqliteWithinTransaction } from "./read-snapshot.js";

/** Caller owns BEGIN/COMMIT: report, result, supersession and outbox are indivisible. */
export function commitNormalTerminalReportWithinTransaction(
  context: SqliteStoreContext,
  ports: SqliteTerminalReportPublicationStorePorts,
  input: CommitNormalTerminalReportPublicationInput,
): CommitTerminalReportPublicationResult {
  const record = ports.getTerminalReport(input.reportId);
  const candidate = input.report;
  if (!record || (record.status !== "validating" && record.status !== "committed" && record.status !== "fallback")
    || record.evidenceFingerprint !== input.expectedEvidenceFingerprint
    || candidate.id !== record.id || candidate.evidenceFingerprint !== record.evidenceFingerprint
    || candidate.source.kind !== record.sourceKind || candidate.source.id !== record.sourceId
    || candidate.workspaceId !== record.workspaceId || candidate.threadId !== record.threadId
    || candidate.turnId !== record.turnId || candidate.sourceMessageId !== record.sourceMessageId
    || candidate.channelId || record.channelId || record.evidenceSnapshot.surface !== "normal_conversation"
    || (record.report && JSON.stringify(record.report) !== JSON.stringify(candidate))
    || (record.report && (record.status !== candidate.status || record.outcomeStatus !== candidate.outcome.status))
    || (record.report && input.expectedReportStatus !== "validating" && input.expectedReportStatus !== record.status)
    || (record.status === "validating" && input.expectedReportStatus !== "validating")) return conflict("report_conflict");
  if (!validateTerminalReport(candidate, record.evidenceSnapshot).ok) return conflict("report_conflict");

  const basis = captureNormalTerminalReportBasis(ports.normalReadStore, input.expectedNormalBasis.source);
  if (!basis || basis.workspaceId !== record.workspaceId || basis.threadId !== record.threadId
    || basis.turnId !== record.turnId || basis.sourceItemId !== record.sourceMessageId
    || basis.source.kind !== record.sourceKind || basis.source.id !== record.sourceId) return conflict("source_turn_conflict");
  if (!basis.settled || JSON.stringify(basis) !== JSON.stringify(input.expectedNormalBasis)) return conflict("stale_completion_basis");
  if (basis.source.kind === "run" && basis.source.id !== basis.effectiveRunId) return conflict("stale_completion_basis");

  const latest = context.database.prepare(`SELECT MAX(generation) AS generation FROM ling_terminal_reports
    WHERE workspace_id = ? AND source_kind = ? AND source_id = ?`).get(record.workspaceId, record.sourceKind, record.sourceId);
  if (latest?.generation !== record.generation) return conflict("stale_completion_basis");
  const competingSource = context.database.prepare(`SELECT report.id FROM ling_terminal_reports AS report
    JOIN conversation_items AS item ON item.id = report.result_item_id
    WHERE report.workspace_id = ? AND report.turn_id = ?
      AND (report.source_kind != ? OR report.source_id != ?)
      AND NOT EXISTS (SELECT 1 FROM conversation_items AS replacement WHERE replacement.supersedes_item_id = item.id)
    LIMIT 1`).get(record.workspaceId, basis.turnId, record.sourceKind, record.sourceId);
  if (competingSource) return conflict("source_turn_conflict");
  // Do not accept a caller's hash as evidence. Reuse the host's full collector
  // under the same SQLite transaction, with all writes/async callbacks denied.
  const evidence = readSqliteWithinTransaction(context.database, input.readEvidence);
  if (evidence.source.kind !== record.sourceKind || evidence.source.id !== record.sourceId
    || evidence.workspaceId !== basis.workspaceId || evidence.threadId !== basis.threadId
    || evidence.turnId !== basis.turnId || evidence.sourceMessageId !== basis.sourceItemId
    || evidence.channelId || evidence.surface !== "normal_conversation"
    || computeTerminalReportEvidenceFingerprint(evidence) !== record.evidenceFingerprint
    || evidence.evidenceFingerprint !== record.evidenceFingerprint) return conflict("stale_completion_basis");
  if (candidate.outcome.status !== evidence.terminalState
    || (candidate.outcome.status === "succeeded" && (basis.turnStatus !== "succeeded" || !basis.successAllowed))) {
    return conflict("outcome_conflict");
  }

  const previous = context.database.prepare(`SELECT id, result_item_id FROM ling_terminal_reports
    WHERE workspace_id = ? AND source_kind = ? AND source_id = ? AND generation < ?
      AND result_item_id IS NOT NULL ORDER BY generation DESC LIMIT 1`)
    .get(record.workspaceId, record.sourceKind, record.sourceId, record.generation);
  const supersedesItemId = typeof previous?.result_item_id === "string" ? previous.result_item_id : undefined;
  const itemInput = input.publicationItem;
  const expectedRefs = [
    { type: "terminal_report", id: record.id }, { type: "conversation_item", id: basis.sourceItemId },
    { type: "turn", id: basis.turnId }, ...basis.runIds.map((id) => ({ type: "run", id })),
  ];
  if (itemInput.id !== `result_terminal_report:${record.id}` || itemInput.idempotencyKey !== `terminal-report:${record.id}`
    || itemInput.channelId || itemInput.threadId !== basis.threadId || itemInput.turnId !== basis.turnId
    || itemInput.kind !== "terminal_report" || itemInput.status !== "committed" || itemInput.actorType !== "system"
    || itemInput.actorId !== undefined || itemInput.visibility !== "thread_participants" || itemInput.visibilityOwnerId !== undefined
    || itemInput.supersedesItemId !== supersedesItemId
    || JSON.stringify(itemInput.domainRefs) !== JSON.stringify(expectedRefs)
    || JSON.stringify(itemInput.payload) !== JSON.stringify({ reportId: record.id, generation: record.generation,
      sourceKind: record.sourceKind, sourceId: record.sourceId, evidenceFingerprint: record.evidenceFingerprint,
      outcomeStatus: candidate.outcome.status })) return conflict("item_conflict");
  if (supersedesItemId) {
    const previousItem = ports.getConversationItem(supersedesItemId);
    const previousReport = typeof previous?.id === "string" ? ports.getTerminalReport(previous.id) : undefined;
    if (!previousItem || previousItem.kind !== "terminal_report" || previousItem.threadId !== basis.threadId
      || previousItem.turnId !== basis.turnId || previousItem.visibility !== "thread_participants" || previousItem.channelId
      || previousItem.visibilityOwnerId !== undefined || previousItem.status !== "committed"
      || !previousReport?.report || previousReport.sourceKind !== record.sourceKind || previousReport.sourceId !== record.sourceId
      || previousReport.threadId !== basis.threadId || previousReport.turnId !== basis.turnId
      || previousItem.payload.reportId !== previousReport.id || previousItem.payload.generation !== previousReport.generation
      || previousItem.payload.evidenceFingerprint !== previousReport.evidenceFingerprint
      || !previousItem.domainRefs.some((ref) => ref.type === "terminal_report" && ref.id === previousReport.id)) {
      return conflict("item_conflict");
    }
  }
  if (input.publicationEventIdempotencyKey !== `terminal-report:${record.id}:published`) return conflict("publication_event_conflict");
  const eventInput: AppendControlPlaneEventInput = {
    workspaceId: record.workspaceId, cwd: ports.cwd, domain: "work_units", entityType: "terminal_report",
    entityId: record.id, action: "terminal_report.published", idempotencyKey: input.publicationEventIdempotencyKey,
    data: { threadId: basis.threadId, turnId: basis.turnId, sourceKind: record.sourceKind, sourceId: record.sourceId,
      generation: record.generation, resultItemId: itemInput.id, status: candidate.status },
  };
  const byId = ports.getConversationItem(itemInput.id!);
  const byKey = ports.getConversationItemByIdempotencyKey(basis.threadId, itemInput.idempotencyKey!);
  if (byId && byKey && byId.id !== byKey.id) return conflict("item_conflict");
  const existing = byId ?? byKey;
  if (existing && !sameItem(existing, input)) return conflict("item_conflict");
  const event = ports.getControlPlaneEventByIdempotency(record.workspaceId, input.publicationEventIdempotencyKey);
  if (event && (event.workspaceId !== record.workspaceId || event.cwd !== eventInput.cwd || event.domain !== eventInput.domain
    || event.entityType !== eventInput.entityType || event.entityId !== record.id || event.action !== eventInput.action
    || JSON.stringify(event.data) !== JSON.stringify(eventInput.data))) return conflict("publication_event_conflict");
  if (existing || record.resultItemId || event) {
    if (!existing || !record.report || record.resultItemId !== existing.id || !event) return conflict("item_conflict");
    return { ok: true, reportId: record.id, item: existing, sourceTurnId: basis.turnId,
      sourceTurnStatus: ports.getLingTurn(basis.turnId)!.status, controlPlaneEvent: event, duplicate: true };
  }

  if (!record.report) {
    ports.commitTerminalReport({ reportId: record.id, expectedStatus: "validating",
      expectedEvidenceFingerprint: record.evidenceFingerprint, report: candidate,
      synthesisMode: candidate.synthesis.mode, promptVersion: candidate.synthesis.promptVersion,
      attemptCount: candidate.synthesis.attemptCount, validationCodes: candidate.synthesis.validationCodes, now: input.now });
  }
  const item = ports.appendConversationItemWithinTransaction(itemInput, input.now);
  const marker = context.database.prepare(`UPDATE ling_terminal_reports SET result_item_id = ?, updated_at = ?
    WHERE workspace_id = ? AND id = ? AND result_item_id IS NULL AND status = ? AND evidence_fingerprint = ?`)
    .run(item.id, input.now, record.workspaceId, record.id, candidate.status, record.evidenceFingerprint);
  if (Number(marker.changes) !== 1) return conflict("report_conflict");
  const controlPlaneEvent = ports.appendControlPlaneEventWithinTransaction(eventInput, input.now);
  return { ok: true, reportId: record.id, item, sourceTurnId: basis.turnId,
    sourceTurnStatus: ports.getLingTurn(basis.turnId)!.status, controlPlaneEvent, duplicate: false };
}

function sameItem(existing: ConversationItemV1, input: CommitNormalTerminalReportPublicationInput): boolean {
  const item = input.publicationItem;
  return existing.workspaceId === input.report.workspaceId && existing.id === item.id
    && existing.threadId === item.threadId && existing.turnId === item.turnId && !existing.channelId
    && existing.kind === item.kind && existing.status === item.status && existing.actorType === item.actorType
    && existing.actorId === undefined && existing.visibility === item.visibility && existing.visibilityOwnerId === undefined
    && existing.idempotencyKey === item.idempotencyKey && existing.supersedesItemId === item.supersedesItemId
    && JSON.stringify(existing.payload) === JSON.stringify(item.payload) && JSON.stringify(existing.domainRefs) === JSON.stringify(item.domainRefs);
}

function conflict(code: TerminalReportPublicationConflictCode): CommitTerminalReportPublicationResult {
  return { ok: false, code };
}
