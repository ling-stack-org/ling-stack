import type { WorkIntakeBudget, WorkIntakeQuietHours } from "@ling-stack/contracts";
import { isRecord } from "../../shared/validation.js";

export function parseIntakeBudget(value: unknown): WorkIntakeBudget {
  if (!isRecord(value) || !integerInRange(value.maxConcurrent, 1, 16)
    || !integerInRange(value.maxStartsPerWindow, 1, 500)
    || !integerInRange(value.windowMs, 60_000, 7 * 86_400_000)) {
    throw new Error("Automatic intake requires bounded concurrency and a rolling start budget.");
  }
  return { maxConcurrent: value.maxConcurrent, maxStartsPerWindow: value.maxStartsPerWindow, windowMs: value.windowMs };
}

export function parseIntakeQuietHours(value: unknown): WorkIntakeQuietHours | undefined {
  if (value === undefined) return undefined;
  const time = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;
  if (!isRecord(value) || typeof value.timeZone !== "string" || value.timeZone.length > 80 || !value.timeZone.trim()
    || typeof value.start !== "string" || !time.test(value.start) || typeof value.end !== "string" || !time.test(value.end)
    || value.start === value.end) {
    throw new Error("Invalid intake quiet hours.");
  }
  const timeZone = new Intl.DateTimeFormat("en-US", { timeZone: value.timeZone }).resolvedOptions().timeZone;
  return { timeZone, start: value.start, end: value.end };
}

export function isIntakeQuiet(quiet: WorkIntakeQuietHours | undefined, now: Date): boolean {
  if (!quiet) return false;
  const { timeZone, start, end } = quiet;
  const clock = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now);
  return start < end ? clock >= start && clock < end : clock >= start || clock < end;
}

function integerInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}
