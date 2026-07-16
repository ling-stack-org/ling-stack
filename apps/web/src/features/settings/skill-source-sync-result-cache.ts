import type {
  SkillSourceSyncApplyResponse,
  SkillSourceSyncApplySummary,
} from "../../types.js";

export interface SkillSourceSyncResultView {
  readonly completedAt: string;
  readonly summary: SkillSourceSyncApplySummary;
}

const storageKeyPrefix = "ling-stack.skill-source-sync-result.v2";

export function syncResultViewFromResponse(response: SkillSourceSyncApplyResponse): SkillSourceSyncResultView {
  return {
    completedAt: response.completedAt,
    summary: response.summary,
  };
}

export function readSavedSkillSourceSyncResult(cwd: string, lastCheckedAt: string | undefined): SkillSourceSyncResultView | undefined {
  const storage = readStorage();
  const key = storageKey(cwd);
  if (!storage || !key || !lastCheckedAt) {
    return undefined;
  }
  try {
    const saved = parseSavedResult(storage.getItem(key));
    if (!saved) {
      return undefined;
    }
    if (saved.completedAt !== lastCheckedAt) {
      storage.removeItem(key);
      return undefined;
    }
    return saved;
  } catch {
    return undefined;
  }
}

export function saveSkillSourceSyncResult(cwd: string, result: SkillSourceSyncResultView): void {
  const storage = readStorage();
  const key = storageKey(cwd);
  if (!storage || !key) {
    return;
  }
  try {
    storage.setItem(key, JSON.stringify(result));
  } catch {
    // Storage can be unavailable in private or restricted browser contexts.
  }
}

function storageKey(cwd: string): string | undefined {
  const normalizedCwd = cwd.trim();
  return normalizedCwd ? `${storageKeyPrefix}:${encodeURIComponent(normalizedCwd)}` : undefined;
}

function readStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function parseSavedResult(value: string | null): SkillSourceSyncResultView | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed) || typeof parsed.completedAt !== "string" || !isSummary(parsed.summary)) {
      return undefined;
    }
    return {
      completedAt: parsed.completedAt,
      summary: parsed.summary,
    };
  } catch {
    return undefined;
  }
}

function isSummary(value: unknown): value is SkillSourceSyncApplySummary {
  return isRecord(value) &&
    typeof value.synced === "number" &&
    typeof value.unchanged === "number";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
