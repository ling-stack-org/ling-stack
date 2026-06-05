import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_WORKSPACE_ID,
  type RunnerFallbackPolicy,
  type RunStore,
  type WorkspaceRuntimeSettings,
} from "@ling-stack/core";
import {
  DEFAULT_RUNNER_ID,
  normalizeRunnerId,
  type RegisteredRunner,
  type RunnerRegistry,
} from "./runners.js";

const RUNTIME_SETTINGS_FILE = "runtime-settings.json";
const DEFAULT_UPDATED_AT = "1970-01-01T00:00:00.000Z";

export interface WorkspaceRuntimeSettingsPatch {
  readonly defaultRunnerId?: string;
  readonly allowedRunnerIds?: readonly string[];
  readonly explicitRunnerFallback?: RunnerFallbackPolicy;
  readonly implicitRunnerFallback?: RunnerFallbackPolicy;
}

export interface RunnerListItem {
  readonly id: string;
  readonly displayName: string;
  readonly status: RegisteredRunner["status"];
  readonly aliases?: readonly string[];
  readonly supportedProviderApis?: readonly string[];
  readonly supportedTools?: readonly string[];
  readonly capabilities?: readonly string[];
  readonly featureFlag?: string;
  readonly disabledReason?: string;
}

export function listRunnerItems(runnerRegistry: RunnerRegistry): RunnerListItem[] {
  return runnerRegistry.list().map((runner) => ({
    id: runner.id,
    displayName: runner.displayName,
    status: runner.status,
    aliases: runner.aliases,
    supportedProviderApis: runner.supportedProviderApis,
    supportedTools: runner.supportedTools,
    capabilities: runner.capabilities,
    featureFlag: runner.featureFlag,
    disabledReason: runner.disabledReason,
  }));
}

export function loadWorkspaceRuntimeSettings(store: RunStore, runnerRegistry: RunnerRegistry): WorkspaceRuntimeSettings {
  const parsed = readStoredRuntimeSettings(store);
  return normalizeWorkspaceRuntimeSettings(runnerRegistry, parsed, parsed?.updatedAt ?? DEFAULT_UPDATED_AT);
}

export function patchWorkspaceRuntimeSettings(
  store: RunStore,
  runnerRegistry: RunnerRegistry,
  input: WorkspaceRuntimeSettingsPatch,
  now: string = new Date().toISOString(),
): WorkspaceRuntimeSettings {
  const current = loadWorkspaceRuntimeSettings(store, runnerRegistry);
  const next = normalizeWorkspaceRuntimeSettings(
    runnerRegistry,
    {
      ...current,
      ...input,
      updatedAt: now,
    },
    now,
  );
  mkdirSync(store.paths.rootDir, { recursive: true });
  writeFileSync(runtimeSettingsPath(store), `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

function normalizeWorkspaceRuntimeSettings(
  runnerRegistry: RunnerRegistry,
  input: Partial<WorkspaceRuntimeSettings> | undefined,
  updatedAt: string,
): WorkspaceRuntimeSettings {
  const enabledRunnerIds = runnerRegistry.list().filter((runner) => runner.status === "enabled").map((runner) => runner.id);
  const allowedRunnerIds = normalizeAllowedRunnerIds(
    runnerRegistry,
    input?.allowedRunnerIds && input.allowedRunnerIds.length > 0 ? input.allowedRunnerIds : enabledRunnerIds,
  );
  const defaultRunnerId = normalizeEnabledRunnerId(runnerRegistry, input?.defaultRunnerId ?? DEFAULT_RUNNER_ID, "defaultRunnerId");
  if (!allowedRunnerIds.includes(defaultRunnerId)) {
    throw new Error(`defaultRunnerId must be included in allowedRunnerIds: ${defaultRunnerId}`);
  }
  return {
    workspaceId: input?.workspaceId ?? DEFAULT_WORKSPACE_ID,
    defaultRunnerId,
    allowedRunnerIds,
    explicitRunnerFallback: readFallbackPolicy(input?.explicitRunnerFallback, "explicitRunnerFallback", "disabled"),
    implicitRunnerFallback: readFallbackPolicy(input?.implicitRunnerFallback, "implicitRunnerFallback", "allow_to_default"),
    updatedAt,
  };
}

function normalizeAllowedRunnerIds(runnerRegistry: RunnerRegistry, ids: readonly string[]): string[] {
  const normalized = new Set<string>();
  for (const id of ids) {
    normalized.add(normalizeEnabledRunnerId(runnerRegistry, id, "allowedRunnerIds"));
  }
  return [...normalized];
}

function normalizeEnabledRunnerId(runnerRegistry: RunnerRegistry, id: string, field: string): string {
  const normalized = normalizeRunnerId(id) ?? id;
  const runner = runnerRegistry.get(normalized);
  if (!runner) {
    throw new Error(`${field} references an unavailable runner: ${id}`);
  }
  if (runner.status !== "enabled") {
    throw new Error(`${field} references a disabled runner: ${id}`);
  }
  return runner.id;
}

function readFallbackPolicy(
  value: unknown,
  field: string,
  fallback: RunnerFallbackPolicy,
): RunnerFallbackPolicy {
  if (value === undefined) {
    return fallback;
  }
  if (value === "disabled" || value === "allow_to_default") {
    return value;
  }
  throw new Error(`${field} must be disabled or allow_to_default`);
}

function readStoredRuntimeSettings(store: RunStore): Partial<WorkspaceRuntimeSettings> | undefined {
  const path = runtimeSettingsPath(store);
  if (!existsSync(path)) {
    return undefined;
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("runtime-settings.json must contain a JSON object");
  }
  return {
    workspaceId: readOptionalString(parsed, "workspaceId"),
    defaultRunnerId: readOptionalString(parsed, "defaultRunnerId"),
    allowedRunnerIds: readOptionalStringArray(parsed, "allowedRunnerIds"),
    explicitRunnerFallback: readOptionalString(parsed, "explicitRunnerFallback") as RunnerFallbackPolicy | undefined,
    implicitRunnerFallback: readOptionalString(parsed, "implicitRunnerFallback") as RunnerFallbackPolicy | undefined,
    updatedAt: readOptionalString(parsed, "updatedAt"),
  };
}

function runtimeSettingsPath(store: RunStore): string {
  return join(store.paths.rootDir, RUNTIME_SETTINGS_FILE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readOptionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${key} must be a string`);
  }
  return value;
}

function readOptionalStringArray(record: Record<string, unknown>, key: string): readonly string[] | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${key} must be a string array`);
  }
  return value;
}
