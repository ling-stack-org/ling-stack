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

export interface SqliteRunEventStorePorts {
  readonly getRun: (runId: string) => RunSession | undefined;
  readonly rebuildLingThreadMetadata: (threadId: string | undefined, now: string) => void;
}

export class SqliteRunEventStore {
  constructor(
    private readonly context: SqliteStoreContext,
    private readonly ports: SqliteRunEventStorePorts,
  ) {}

  appendEvent<K extends RunEventType>(
    runId: string,
    type: K,
    data: RunEventDataByType[K],
  ): Extract<RunEventEnvelope, { readonly type: K }> {
    const run = this.ports.getRun(runId);
    if (!run) {
      throw new Error(`Run session not found: ${runId}`);
    }

    const redactedData = normalizeLegacyEventPayload(type, redactSecrets(data));
    if (!isRunEventData(type, redactedData)) {
      throw new Error(`Invalid run event payload for ${type}`);
    }
    const envelope = {
      id: createEventId(),
      runId,
      seq: this.nextEventSeq(runId),
      ts: new Date().toISOString(),
      type,
      data: redactedData,
    } as unknown as Extract<RunEventEnvelope, { readonly type: K }>;

    this.context.database
      .prepare("INSERT INTO run_events (id, run_id, seq, ts, type, data_json) VALUES (?, ?, ?, ?, ?, ?)")
      .run(envelope.id, envelope.runId, envelope.seq, envelope.ts, envelope.type, stringifyJson(envelope.data));
    appendEventLogLine(run.eventLogPath, envelope);
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
