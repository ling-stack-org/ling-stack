/** Product-facing runner identifiers and their historical aliases. */
export const DEFAULT_RUNNER_ID = "pi";
export const LEGACY_PI_RUNNER_ID = "pi-coding-agent";

/** Return the canonical identifier used by new requests and mutable writes. */
export function normalizeRunnerId(id: string | undefined): string | undefined {
  if (!id) return undefined;
  return id === LEGACY_PI_RUNNER_ID ? DEFAULT_RUNNER_ID : id;
}

/**
 * Project historical JSON for current callers without changing the stored
 * bytes or any user-authored text. Only identity fields are normalized.
 */
export function normalizeRunnerIdsInSnapshot<T>(value: T): T {
  return projectRunnerIds(value).value as T;
}

/** Internal migration/test shape that also reports whether a projection changed. */
export function normalizeRunnerIdsInJson(value: unknown): { readonly value: unknown; readonly changed: boolean } {
  return projectRunnerIds(value);
}

function projectRunnerIds(value: unknown): { readonly value: unknown; readonly changed: boolean } {
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((entry) => {
      const projected = projectRunnerIds(entry);
      changed ||= projected.changed;
      return projected.value;
    });
    return { value: changed ? next : value, changed };
  }
  if (!value || typeof value !== "object") return { value, changed: false };

  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const projected = projectRunnerIds(child);
    let nextChild = projected.value;
    if (isRunnerIdKey(key) && nextChild === LEGACY_PI_RUNNER_ID) {
      nextChild = DEFAULT_RUNNER_ID;
    }
    changed ||= projected.changed || nextChild !== child;
    next[key] = nextChild;
  }
  return { value: changed ? next : value, changed };
}

function isRunnerIdKey(key: string): boolean {
  return key === "runnerId" || key === "requestedRunnerId" || key === "effectiveRunnerId"
    || key === "runner_id" || key === "requested_runner_id" || key === "effective_runner_id";
}
