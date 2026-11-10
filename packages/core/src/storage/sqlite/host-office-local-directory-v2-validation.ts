import { isAbsolute, relative, resolve, sep } from "node:path";
import { digestHarnessToolValue } from "../../harness/tool-executions.js";
import { hostOperationFailure, hostOperationTimestamp } from "./host-operation-journal-evidence.js";

export const directoryV2Failure = (): never => hostOperationFailure("host_office_local_directory_v2_evidence_invalid");
export const v2Object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
export const v2Text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 4096 && !value.includes("\0");
export const v2Digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export const v2Size = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
export const v2Exact = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
export const v2OptionalKeys = (value: Record<string, unknown>, keys: readonly string[]): string[] => keys.filter(key => Object.hasOwn(value, key));
export const v2Same = (a: unknown, b: unknown): boolean => digestHarnessToolValue(a) === digestHarnessToolValue(b);
export const v2Canonical = (value: unknown): value is string => v2Text(value) && isAbsolute(value) && resolve(value) === value;
export const v2Component = (value: unknown): value is string => v2Text(value) && Buffer.byteLength(value) <= 255
  && value !== "." && value !== ".." && !value.includes("/");
export function v2Inside(root: string, path: string): boolean {
  const rel = relative(root, path); return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
/** Decimal precision stays in BigInt. No silently rounded native identity or clock conversion. */
export function v2Decimal(value: unknown, max = (1n << 64n) - 1n): value is string {
  return typeof value === "string" && /^(0|[1-9][0-9]{0,19})$/.test(value) && BigInt(value) <= max;
}
export function v2SignedDecimal(value: unknown): value is string {
  return typeof value === "string" && /^(0|-?[1-9][0-9]{0,28})$/.test(value)
    && BigInt(value) >= -(1n << 63n) * 1_000_000_000n && BigInt(value) <= ((1n << 63n) - 1n) * 1_000_000_000n + 999_999_999n;
}
export function v2Timestamp(value: unknown): number {
  const time = hostOperationTimestamp(value);
  if (typeof value !== "string" || new Date(time).toISOString() !== value) return directoryV2Failure();
  return time;
}
export const V2_SOURCE_KEYS = ["runId", "workUnitId", "attemptId", "runtimeInstanceId", "fencingToken"] as const;
export function v2Source(value: unknown): boolean {
  return v2Object(value) && v2Exact(value, V2_SOURCE_KEYS) && V2_SOURCE_KEYS.every(key => v2Text(value[key]));
}
