import {
  type ChannelMessageFileRef,
  type ChannelMessageFileRefSource,
} from "../../workspace-types.js";
import { isRecord, parseJson } from "./helpers.js";

export function normalizeChannelMessageFileRefs(fileRefs: readonly ChannelMessageFileRef[] | undefined): readonly ChannelMessageFileRef[] {
  if (!fileRefs || fileRefs.length === 0) {
    return [];
  }
  const normalized: ChannelMessageFileRef[] = [];
  const seen = new Set<string>();
  for (const fileRef of fileRefs) {
    const path = fileRef.path.trim();
    if (!path || path.length > 2_000) {
      continue;
    }
    const line = fileRef.line === undefined ? undefined : Math.max(1, Math.trunc(fileRef.line));
    const key = `${path}\0${line ?? ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    normalized.push({
      path,
      ...(fileRef.label?.trim() ? { label: fileRef.label.trim().slice(0, 240) } : {}),
      ...(fileRef.source && isChannelMessageFileRefSource(fileRef.source) ? { source: fileRef.source } : {}),
      ...(line !== undefined ? { line } : {}),
    });
    if (normalized.length >= 12) {
      break;
    }
  }
  return normalized;
}

export function parseChannelMessageFileRefs(value: string): readonly ChannelMessageFileRef[] {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed)) {
    throw new Error("Expected channel message file refs array from SQLite");
  }
  return normalizeChannelMessageFileRefs(parsed.map((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`Expected channel message file ref object at index ${index}`);
    }
    const source = typeof item.source === "string" && isChannelMessageFileRefSource(item.source) ? item.source : undefined;
    const line = typeof item.line === "number" && Number.isFinite(item.line) ? item.line : undefined;
    return {
      path: readRecordString(item, "path"),
      ...(typeof item.label === "string" ? { label: item.label } : {}),
      ...(source ? { source } : {}),
      ...(line !== undefined ? { line } : {}),
    };
  }));
}

function readRecordString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new Error(`${key} must be a string`);
  }
  return value;
}

function isChannelMessageFileRefSource(value: string): value is ChannelMessageFileRefSource {
  return value === "composer" || value === "explicit_text" || value === "api";
}
