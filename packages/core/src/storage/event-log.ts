import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { RunEventEnvelope, RunSummary } from "../run-types.js";

export class RunEventLogIntegrityError extends Error {}

/** An unavailable mirror is retryable; it does not invalidate the committed SQLite fact. */
export class RunEventLogIoError extends Error {
  constructor(readonly operation: "prepare_directory" | "read" | "append", cause: unknown) {
    super("Run event log mirror I/O failed.", { cause });
    this.name = "RunEventLogIoError";
  }
}

export function appendEventLogLine(eventLogPath: string, envelope: RunEventEnvelope): void {
  mkdirSync(dirname(eventLogPath), { recursive: true });
  appendFileSync(eventLogPath, `${JSON.stringify(envelope)}\n`, "utf8");
}

/** Repairable append for a stable event identity. The caller must serialize writers. */
export function ensureEventLogLine(eventLogPath: string, envelope: RunEventEnvelope): void {
  try {
    mkdirSync(dirname(eventLogPath), { recursive: true });
  } catch (error) {
    throw new RunEventLogIoError("prepare_directory", error);
  }
  let current = "";
  try {
    current = readFileSync(eventLogPath, "utf8");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw new RunEventLogIoError("read", error);
    }
  }
  let found = false;
  for (const [index, line] of current.split(/\r?\n/u).entries()) {
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      throw new RunEventLogIntegrityError(`Invalid run event log line ${index + 1}: ${eventLogPath}`);
    }
    if (!isEventWithId(parsed, envelope.id)) continue;
    if (found || !isDeepStrictEqual(parsed, envelope)) {
      throw new RunEventLogIntegrityError(`Run event log conflicts with committed event: ${envelope.id}`);
    }
    found = true;
  }
  if (found) return;
  const separator = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
  // Serialize outside the I/O boundary so programming errors remain hard failures.
  const line = `${separator}${JSON.stringify(envelope)}\n`;
  try {
    appendFileSync(eventLogPath, line, "utf8");
  } catch (error) {
    throw new RunEventLogIoError("append", error);
  }
}

export function writeRunSummary(summaryPath: string, summary: RunSummary): void {
  mkdirSync(dirname(summaryPath), { recursive: true });
  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
}

function isEventWithId(value: unknown, id: string): value is { readonly id: string } {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && "id" in value && value.id === id;
}
