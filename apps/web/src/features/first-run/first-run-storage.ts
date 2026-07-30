export const FIRST_RUN_PREFERENCE_KEY = "ling-first-run:v1";

export interface FirstRunPreferenceV1 {
  readonly status: "completed" | "skipped";
  readonly updatedAt: string;
  readonly version: 1;
  readonly workspaceIdentity?: string;
}

export interface FirstRunStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function readFirstRunPreference(
  storage: FirstRunStorage | undefined = browserStorage(),
): FirstRunPreferenceV1 | undefined {
  if (!storage) return undefined;
  try {
    const raw = storage.getItem(FIRST_RUN_PREFERENCE_KEY);
    if (!raw) return undefined;
    const value = JSON.parse(raw) as Partial<FirstRunPreferenceV1>;
    if (
      value.version !== 1
      || (value.status !== "completed" && value.status !== "skipped")
      || typeof value.updatedAt !== "string"
      || (value.workspaceIdentity !== undefined && typeof value.workspaceIdentity !== "string")
    ) return undefined;
    return Object.freeze({
      status: value.status,
      updatedAt: value.updatedAt,
      version: 1,
      ...(value.workspaceIdentity ? { workspaceIdentity: value.workspaceIdentity } : {}),
    });
  } catch {
    return undefined;
  }
}

export function writeFirstRunPreference(
  status: FirstRunPreferenceV1["status"],
  workspaceCwd: string,
  storage: FirstRunStorage | undefined = browserStorage(),
  now = new Date().toISOString(),
): FirstRunPreferenceV1 {
  const preference = Object.freeze({
    status,
    updatedAt: now,
    version: 1 as const,
    ...(normalizeWorkspaceIdentity(workspaceCwd)
      ? { workspaceIdentity: normalizeWorkspaceIdentity(workspaceCwd) }
      : {}),
  });
  try {
    storage?.setItem(FIRST_RUN_PREFERENCE_KEY, JSON.stringify(preference));
  } catch {
    // First Run remains skippable for this session when storage is restricted.
  }
  return preference;
}

export function normalizeWorkspaceIdentity(workspaceCwd: string): string {
  return workspaceCwd.trim().replace(/[\\/]+$/u, "");
}

function browserStorage(): FirstRunStorage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}
