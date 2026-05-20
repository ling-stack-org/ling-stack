import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { RunEventEnvelope, RunSummary } from "../run-types.js";

export function appendEventLogLine(eventLogPath: string, envelope: RunEventEnvelope): void {
  mkdirSync(dirname(eventLogPath), { recursive: true });
  appendFileSync(eventLogPath, `${JSON.stringify(envelope)}\n`, "utf8");
}

export function writeRunSummary(summaryPath: string, summary: RunSummary): void {
  mkdirSync(dirname(summaryPath), { recursive: true });
  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
}
