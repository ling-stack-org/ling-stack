import type { SQLOutputValue } from "node:sqlite";

export function stringifyJson(value: unknown): string {
  return JSON.stringify(value);
}

export function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse JSON from SQLite: ${message}`);
  }
}

export function parseNullableJson(value: string | undefined): unknown {
  return value === undefined ? undefined : parseJson(value);
}

export function parseJsonObject(value: string): Record<string, unknown> {
  const parsed = parseJson(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Expected JSON object from SQLite");
  }
  return parsed as Record<string, unknown>;
}

export function parseJsonStringRecord(value: string): Record<string, string> {
  const parsed = parseJsonObject(value);
  const result: Record<string, string> = {};
  for (const [key, entryValue] of Object.entries(parsed)) {
    if (typeof entryValue !== "string") {
      throw new Error("Expected JSON string record from SQLite");
    }
    result[key] = entryValue;
  }
  return result;
}

export function parseJsonStringArray(value: string): string[] {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error("Expected JSON string array from SQLite");
  }
  return parsed as string[];
}

export function parseNullableJsonStringArray(value: string | undefined): string[] | undefined {
  return value ? parseJsonStringArray(value) : undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readString(row: Record<string, SQLOutputValue> | undefined, key: string): string {
  const value = row?.[key];
  if (typeof value !== "string") {
    throw new Error(`Expected SQLite column ${key} to be a string`);
  }
  return value;
}

export function readBoolean(row: Record<string, SQLOutputValue>, key: string): boolean {
  const value = row[key];
  if (typeof value === "number") {
    return value === 1;
  }
  if (typeof value === "bigint") {
    return value === 1n;
  }
  throw new Error(`Expected SQLite column ${key} to be a boolean integer`);
}

export function readNullableBoolean(row: Record<string, SQLOutputValue>, key: string): boolean | undefined {
  const value = row[key];
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === "number") {
    return value === 1;
  }
  if (typeof value === "bigint") {
    return value === 1n;
  }
  throw new Error(`Expected SQLite column ${key} to be a boolean integer or null`);
}

export function readNullableString(row: Record<string, SQLOutputValue>, key: string): string | undefined {
  const value = row[key];
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`Expected SQLite column ${key} to be a string or null`);
  }
  return value;
}

export function readNullableNumber(row: Record<string, SQLOutputValue>, key: string): number | undefined {
  const value = row[key];
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  throw new Error(`Expected SQLite column ${key} to be a number or null`);
}

export function readNumber(row: Record<string, SQLOutputValue> | undefined, key: string): number {
  const value = row?.[key];
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  throw new Error(`Expected SQLite column ${key} to be a number`);
}

export function booleanToSql(value: boolean | undefined): number | null {
  if (value === undefined) {
    return null;
  }
  return value ? 1 : 0;
}

export function nullableUpdate<T>(value: T | null | undefined, existing: T | undefined): T | undefined {
  if (value === undefined) {
    return existing;
  }
  if (value === null) {
    return undefined;
  }
  return value;
}

export function omitUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entryValue]) => entryValue !== undefined)) as T;
}
