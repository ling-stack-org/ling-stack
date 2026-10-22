import type { SQLOutputValue } from "node:sqlite";
import { isRunEventData } from "@ling-stack/contracts";
import {
  type ListRunEventsOptions,
  type RunEventDataByType,
  type RunEventEnvelope,
  type RunEventType,
  type RunSession,
} from "../../run-types.js";
import { createEventId } from "../../run-types.js";
import { redactSecrets } from "../../redaction.js";
import { appendEventLogLine } from "../event-log.js";
import { readNullableString, readNumber, stringifyJson } from "./helpers.js";
import { mapRunEvent } from "./run-mappers.js";
import type { SqliteStoreContext } from "./store-context.js";
import type { RuntimeAttemptFenceV1 } from "../../runtime-supervisor-types.js";
import { runExecutionOwnerParameters, runExecutionOwnerSql } from "./run-execution-admission.js";
import { afterCancellationCommit } from "./cancellation-transaction.js";

type EventAdmission = { readonly kind: "host" | "audit" } | { readonly kind: "execution"; readonly sourceFence: RuntimeAttemptFenceV1 };

export interface SqliteRunEventStorePorts {
  readonly getRun: (runId: string) => RunSession | undefined;
  readonly rebuildLingThreadMetadata: (threadId: string | undefined, now: string) => void;
}

type ApprovalDecisionEventType = Extract<RunEventType,
  "approval_approved" | "approval_denied" | "approval_expired" | "approval_cancelled">;

export class SqliteRunEventStore {
  constructor(
    private readonly context: SqliteStoreContext,
    private readonly ports: SqliteRunEventStorePorts,
  ) {}

  appendEvent<K extends RunEventType>(
    runId: string,
    type: K,
    data: RunEventDataByType[K],
    now?: string,
  ): Extract<RunEventEnvelope, { readonly type: K }> {
    return this.append(runId, type, data, { kind: "host" }, now);
  }

  /**
   * Publish one canonical decision fact per Approval.
   *
   * Recovery claims can expire while an old publisher is paused. A separate
   * listEvents/appendEvent pair therefore cannot provide exactly-once. The
   * stable event id makes the database insert the serialization point across
   * claim generations and SQLite connections.
   */
  appendApprovalDecisionEvent(
    runId: string,
    approvalId: string,
    type: ApprovalDecisionEventType,
    data: RunEventDataByType[ApprovalDecisionEventType],
    now?: string,
  ): Extract<RunEventEnvelope, { readonly type: ApprovalDecisionEventType }> {
    if (!approvalId || data.approvalId !== approvalId) {
      throw new Error("Approval decision event identity is invalid");
    }
    const run = this.ports.getRun(runId);
    if (!run) throw new Error(`Run session not found: ${runId}`);
    const redactedData = normalizeLegacyEventPayload(type, redactSecrets(data));
    if (!isRunEventData(type, redactedData)) {
      throw new Error(`Invalid run event payload for ${type}`);
    }

    const existing = this.findApprovalDecisionEvent(runId, approvalId);
    if (existing) return this.assertMatchingApprovalDecisionEvent(existing, type, approvalId);

    const eventId = `evt_approval_decision_${approvalId}`;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const envelope = {
        id: eventId,
        runId,
        seq: this.nextEventSeq(runId),
        ts: now ?? new Date().toISOString(),
        type,
        data: redactedData,
      } as Extract<RunEventEnvelope, { readonly type: ApprovalDecisionEventType }>;
      const inserted = this.context.database.prepare(`INSERT OR IGNORE INTO run_events
        (id, run_id, seq, ts, type, data_json)
        SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (
          SELECT 1 FROM run_sessions WHERE id=? AND status <> 'yielded'
        )`).run(envelope.id, envelope.runId, envelope.seq, envelope.ts, envelope.type,
          stringifyJson(envelope.data), runId);
      if (Number(inserted.changes) === 1) {
        afterCancellationCommit(this.context.database, () => appendEventLogLine(run.eventLogPath, envelope));
        return envelope;
      }
      const duplicate = this.findApprovalDecisionEvent(runId, approvalId);
      if (duplicate) return this.assertMatchingApprovalDecisionEvent(duplicate, type, approvalId);
      if (this.ports.getRun(runId)?.status === "yielded") {
        const error = new Error(`Run execution is closed (yielded or stale owner): ${runId}`);
        Object.assign(error, { code: "stale_run_execution" });
        throw error;
      }
      // An unrelated writer may have claimed the same next sequence. Re-read
      // the tail and retry; the stable event id still prevents duplicates.
    }
    throw new Error(`Approval decision event could not be serialized: ${approvalId}`);
  }

  appendExecutionEvent<K extends RunEventType>(runId: string, sourceFence: RuntimeAttemptFenceV1, type: K,
    data: RunEventDataByType[K], now?: string)
    : Extract<RunEventEnvelope, { readonly type: K }> {
    return this.append(runId, type, data, { kind: "execution", sourceFence }, now);
  }

  /** A fixed audit kind cannot be used to bypass execution admission for tools or results. */
  appendIgnoredRunnerCompletionEvent(runId: string, data: RunEventDataByType["stale_runner_completion_ignored"], now?: string)
    : Extract<RunEventEnvelope, { readonly type: "stale_runner_completion_ignored" }> {
    return this.append(runId, "stale_runner_completion_ignored", data, { kind: "audit" }, now);
  }

  private append<K extends RunEventType>(runId: string, type: K, data: RunEventDataByType[K], admission: EventAdmission,
    now?: string)
    : Extract<RunEventEnvelope, { readonly type: K }> {
    if (type === "host_command_prepared" || type === "host_command_settled" || type === "delegation_instruction_checkpointed") {
      throw Object.assign(new Error("Command journal requires its dedicated Host API."), { code: "host_command_event_reserved" });
    }
    const run = this.ports.getRun(runId);
    if (!run) {
      throw new Error(`Run session not found: ${runId}`);
    }

    const redactedData = normalizeLegacyEventPayload(type, redactSecrets(data));
    if (!isRunEventData(type, redactedData)) {
      throw new Error(`Invalid run event payload for ${type}`);
    }
    const attributedData = attributeExecutionToolAttempt(type, redactedData, admission);
    const envelope = {
      id: createEventId(),
      runId,
      seq: this.nextEventSeq(runId),
      ts: now ?? new Date().toISOString(),
      type,
      data: attributedData,
    } as unknown as Extract<RunEventEnvelope, { readonly type: K }>;

    // A yielded execution is immutable. Keep the admission check in the write statement,
    // before touching the event file; another connection may have committed its checkpoint.
    const executionParameters = admission.kind === "execution"
      ? runExecutionOwnerParameters(runId, admission.sourceFence, ["run_error", "run_cancelled", "tool_update", "tool_end"].includes(type)) : [];
    const inserted = this.context.database
      .prepare(`INSERT INTO run_events (id, run_id, seq, ts, type, data_json)
        SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (
          SELECT 1 FROM run_sessions WHERE id=? AND (status <> 'yielded' OR ? = 'audit')
        ) ${admission.kind === "execution" ? `AND ${runExecutionOwnerSql}` : ""}`)
      .run(envelope.id, envelope.runId, envelope.seq, envelope.ts, envelope.type, stringifyJson(envelope.data), runId, admission.kind, ...executionParameters);
    if (Number(inserted.changes) !== 1) {
      const error = new Error(`Run execution is closed (yielded or stale owner): ${runId}`);
      Object.assign(error, { code: "stale_run_execution" });
      throw error;
    }
    afterCancellationCommit(this.context.database, () => appendEventLogLine(run.eventLogPath, envelope));
    if (type === "tool_start" || type === "tool_update" || type === "tool_end") {
      this.ports.rebuildLingThreadMetadata(run.threadId, envelope.ts);
    }
    return envelope;
  }

  listEvents(runId: string, options: ListRunEventsOptions = {}): RunEventEnvelope[] {
    const afterSeq = options.afterSeq ?? 0;
    const limit = Math.min(Math.max(options.limit ?? 200, 1), 1000);
    return this.context.database
      .prepare(
        `
          SELECT id, run_id, seq, ts, type, data_json
          FROM run_events
          WHERE run_id = ? AND seq > ?
          ORDER BY seq ASC
          LIMIT ?
        `,
      )
      .all(runId, afterSeq, limit)
      .map((row) => mapRunEvent(row as Record<string, SQLOutputValue>));
  }

  getLatestRunCompactionStart(runId: string): Extract<RunEventEnvelope, { readonly type: "context_compaction_start" }> | undefined {
    const row = this.context.database.prepare(`
      SELECT id, run_id, seq, ts, type, data_json
      FROM run_events
      WHERE run_id = ? AND type = 'context_compaction_start'
      ORDER BY seq DESC LIMIT 1
    `).get(runId);
    return row ? mapRunEvent(row as Record<string, SQLOutputValue>) as Extract<RunEventEnvelope, { readonly type: "context_compaction_start" }> : undefined;
  }

  countEvents(runId: string): number {
    const row = this.context.database.prepare("SELECT COUNT(*) AS count FROM run_events WHERE run_id = ?").get(runId);
    return readNumber(row as Record<string, SQLOutputValue>, "count");
  }

  hasTerminalEvent(runId: string): boolean {
    const row = this.context.database
      .prepare("SELECT 1 AS found FROM run_events WHERE run_id = ? AND type IN ('run_end', 'run_error', 'run_cancelled', 'result') LIMIT 1")
      .get(runId);
    return Boolean(row);
  }

  readLatestRunActionActivityAt(runIds: readonly string[]): string | undefined {
    if (runIds.length === 0) {
      return undefined;
    }
    const placeholders = runIds.map(() => "?").join(", ");
    const row = this.context.database
      .prepare(`
        SELECT MAX(ts) AS latest_ts
        FROM run_events
        WHERE run_id IN (${placeholders})
          AND type IN ('tool_start', 'tool_update', 'tool_end')
      `)
      .get(...runIds);
    return row ? readNullableString(row as Record<string, SQLOutputValue>, "latest_ts") : undefined;
  }

  private nextEventSeq(runId: string): number {
    const row = this.context.database
      .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM run_events WHERE run_id = ?")
      .get(runId);
    return readNumber(row as Record<string, SQLOutputValue>, "next_seq");
  }

  private findApprovalDecisionEvent(runId: string, approvalId: string): RunEventEnvelope | undefined {
    const row = this.context.database.prepare(`
      SELECT id, run_id, seq, ts, type, data_json
      FROM run_events
      WHERE run_id = ?
        AND type IN ('approval_approved', 'approval_denied', 'approval_expired', 'approval_cancelled')
        AND json_extract(data_json, '$.approvalId') = ?
      ORDER BY seq ASC
      LIMIT 1
    `).get(runId, approvalId);
    return row ? mapRunEvent(row as Record<string, SQLOutputValue>) : undefined;
  }

  private assertMatchingApprovalDecisionEvent(
    event: RunEventEnvelope,
    type: ApprovalDecisionEventType,
    approvalId: string,
  ): Extract<RunEventEnvelope, { readonly type: ApprovalDecisionEventType }> {
    if (event.type !== type || event.data.approvalId !== approvalId) {
      throw new Error(`Approval decision event conflicts with committed fact: ${approvalId}`);
    }
    return event as Extract<RunEventEnvelope, { readonly type: ApprovalDecisionEventType }>;
  }
}

function normalizeLegacyEventPayload<K extends RunEventType>(type: K, data: unknown): RunEventDataByType[K] {
  // Older callers emitted tool_end without an explicit success flag. Preserve
  // those rows while making the persisted typed payload total and deterministic.
  if (type === "tool_end" && typeof data === "object" && data !== null && !Array.isArray(data)) {
    const record = data as Record<string, unknown>;
    return { ...record, isError: record.isError ?? false } as RunEventDataByType[K];
  }
  return data as RunEventDataByType[K];
}

/** Attribute new execution facts at Host admission, never by replaying old history. */
function attributeExecutionToolAttempt<K extends RunEventType>(
  type: K,
  data: RunEventDataByType[K],
  admission: EventAdmission,
): RunEventDataByType[K] {
  if (admission.kind !== "execution" || (type !== "tool_start" && type !== "tool_update" && type !== "tool_end")) {
    return data;
  }
  const toolData = data as RunEventDataByType["tool_start" | "tool_update" | "tool_end"];
  if (toolData.attemptId !== undefined && toolData.attemptId !== admission.sourceFence.attemptId) {
    throw Object.assign(new Error("Execution tool Attempt does not match its captured Host fence."), {
      code: "run_event_attempt_mismatch",
    });
  }
  return { ...data, attemptId: admission.sourceFence.attemptId } as RunEventDataByType[K];
}
