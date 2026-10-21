export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function removeUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

export function stripTrailingSlashes(value: string): string;
export function stripTrailingSlashes(value: undefined): undefined;
export function stripTrailingSlashes(value: string | undefined): string | undefined;
export function stripTrailingSlashes(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") end -= 1;
  return end === value.length ? value : value.slice(0, end);
}
