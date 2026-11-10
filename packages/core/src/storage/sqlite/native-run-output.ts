import type { SQLOutputValue } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { isRunEventData } from "@ling-stack/contracts";
import { NativeExecutionJournalError, type AppendNativeRunEventsInput, type NativeRunOutput, type NativeSubmission } from "../../native-execution-types.js";
import type { RunStore } from "../../run-types.js";
import { redactSecrets } from "../../redaction.js";
import { mapRunEvent } from "./run-mappers.js";
import type { SqliteStoreContext } from "./store-context.js";
import type { PublishedNativeOutput } from "./native-run-artifacts.js";

const types = new Set(["turn_start", "turn_end", "assistant_text_delta", "assistant_thinking_delta",
  "tool_start", "tool_update", "tool_end", "message_end", "progress"]);

export function validateNativeRunOutput(input: AppendNativeRunEventsInput): readonly NativeRunOutput[] {
  if (!Number.isSafeInteger(input.firstSequence) || input.firstSequence < 1 || !Array.isArray(input.events)
    || input.events.length < 1 || input.events.length > 256 || !Number.isSafeInteger(input.firstSequence + input.events.length)
    || (input.terminal !== undefined && !["completed", "failed", "cancelled"].includes(input.terminal))) invalid();
  let encoded: string;
  try { encoded = JSON.stringify(input.events); } catch { return invalid(); }
  if (Buffer.byteLength(encoded, "utf8") > 4 * 1024 * 1024) invalid();
  for (const event of input.events) {
    if (!event || !types.has(event.type) || !isRunEventData(event.type, event.data)
      || Object.hasOwn(event.data, "nativeOutput")) invalid();
  }
  // Normalize optional fields and redact both authorization values and standalone key patterns.
  return JSON.parse(JSON.stringify(redactSecrets(redactSecrets(input.events, input.extraSecrets), input.extraSecrets))) as NativeRunOutput[];
}

/** Caller owns the journal transaction and complete Attempt/native identity validation. */
export function appendNativeRunOutput(context: SqliteStoreContext, ports: Pick<RunStore, "appendEvent">,
  current: NativeSubmission, input: AppendNativeRunEventsInput, events: readonly PublishedNativeOutput[]) {
  if (!Number.isSafeInteger(input.firstSequence + events.length)) invalid();
  const db = context.database;
  const last = db.prepare(`SELECT json_extract(data_json, '$.nativeOutput.sequence') AS sequence FROM run_events WHERE run_id = ?
    AND json_extract(data_json, '$.nativeOutput.submissionId') = ? ORDER BY seq DESC LIMIT 1`)
    .get(current.runId, current.id);
  const lastSequence = last ? Number(last.sequence) : 0;
  const normalized = events.map((event, index) => ({ ...event, data: { ...event.data,
    nativeOutput: { submissionId: current.id, sequence: input.firstSequence + index,
      ...(input.terminal ? { terminal: input.terminal } : {}) },
  } }));
  if (input.firstSequence <= lastSequence) {
    const rows = db.prepare(`SELECT * FROM run_events WHERE run_id = ?
      AND json_extract(data_json, '$.nativeOutput.submissionId') = ?
      AND json_extract(data_json, '$.nativeOutput.sequence') >= ?
      AND json_extract(data_json, '$.nativeOutput.sequence') < ? ORDER BY seq`)
      .all(current.runId, current.id, input.firstSequence, input.firstSequence + events.length) as Record<string, SQLOutputValue>[];
    const saved = rows.map(mapRunEvent);
    if (saved.length !== events.length || saved.some((event, index) => event.type !== normalized[index]!.type
      || !isDeepStrictEqual(event.data, normalized[index]!.data))) conflict();
    return { events: saved, created: false };
  }
  if (input.firstSequence !== lastSequence + 1 || current.status !== "accepted") conflict();
  return { events: normalized.map(event => ports.appendEvent(current.runId, event.type, event.data)), created: true };
}

function invalid(): never { throw new NativeExecutionJournalError("native_journal_invalid"); }
function conflict(): never { throw new NativeExecutionJournalError("native_output_conflict"); }
