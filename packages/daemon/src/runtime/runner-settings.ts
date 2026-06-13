import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_WORKSPACE_ID,
  resolveConfigPaths,
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
const USER_CONFIG_DIAGNOSTIC_PREFIX = "user_runtime_defaults";

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

export type RuntimeSettingsSource = "workspace" | "user" | "built_in";

export interface RuntimeSettingsSourceInfo {
  readonly source: RuntimeSettingsSource;
  readonly path?: string;
}

export interface RuntimeSettingsSources {
  readonly defaultRunnerId: RuntimeSettingsSourceInfo;
  readonly explicitRunnerFallback: RuntimeSettingsSourceInfo;
  readonly implicitRunnerFallback: RuntimeSettingsSourceInfo;
}

export interface RuntimeSettingsDiagnostic {
  readonly level: "warning";
  readonly code: string;
  readonly message: string;
  readonly path?: string;
}

export interface UserRuntimeDefaults {
  readonly defaultRunnerId?: string;
  readonly explicitRunnerFallback?: RunnerFallbackPolicy;
  readonly implicitRunnerFallback?: RunnerFallbackPolicy;
}

export interface LoadWorkspaceRuntimeSettingsOptions {
  readonly userConfigPath?: string;
  readonly userRuntimeDefaults?: UserRuntimeDefaults;
  readonly diagnostics?: RuntimeSettingsDiagnostic[];
}

export interface RuntimeSettingsResolution {
  readonly settings: WorkspaceRuntimeSettings;
  readonly sources: RuntimeSettingsSources;
}

export function loadWorkspaceRuntimeSettings(
  store: RunStore,
  runnerRegistry: RunnerRegistry,
  options: LoadWorkspaceRuntimeSettingsOptions = {},
): WorkspaceRuntimeSettings {
  return loadWorkspaceRuntimeSettingsWithSources(store, runnerRegistry, options).settings;
}

export function loadWorkspaceRuntimeSettingsWithSources(
  store: RunStore,
  runnerRegistry: RunnerRegistry,
  options: LoadWorkspaceRuntimeSettingsOptions = {},
): RuntimeSettingsResolution {
  const workspacePath = runtimeSettingsPath(store);
  const workspaceInput = readStoredRuntimeSettings(store);
  const userConfigPath = options.userConfigPath ?? resolveConfigPaths(store.paths.cwd).user.configPath;
  const userRuntimeDefaults = Object.hasOwn(options, "userRuntimeDefaults")
    ? options.userRuntimeDefaults
    : readUserRuntimeDefaultsFromConfig(userConfigPath, runnerRegistry, options.diagnostics);
  const merged = mergeRuntimeSettingsInputs(workspaceInput, workspacePath, userRuntimeDefaults, userConfigPath);
  return {
    settings: normalizeWorkspaceRuntimeSettings(runnerRegistry, merged.input, workspaceInput?.updatedAt ?? DEFAULT_UPDATED_AT),
    sources: merged.sources,
  };
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

export function normalizeUserRuntimeDefaults(
  runnerRegistry: RunnerRegistry,
  value: unknown,
  path: string | undefined,
  diagnostics?: RuntimeSettingsDiagnostic[],
): UserRuntimeDefaults | undefined {
  if (!isRecord(value)) {
    if (value !== undefined) {
      pushRuntimeSettingsDiagnostic(diagnostics, {
        code: `${USER_CONFIG_DIAGNOSTIC_PREFIX}_invalid`,
        message: "runtimeDefaults must be a JSON object.",
        path,
      });
    }
    return undefined;
  }
  const result: {
    defaultRunnerId?: string;
    explicitRunnerFallback?: RunnerFallbackPolicy;
    implicitRunnerFallback?: RunnerFallbackPolicy;
  } = {};
  const defaultRunnerId = normalizeOptionalUserRunnerId(runnerRegistry, value.defaultRunnerId, "runtimeDefaults.defaultRunnerId", path, diagnostics);
  if (defaultRunnerId) {
    result.defaultRunnerId = defaultRunnerId;
  }
  const explicitRunnerFallback = normalizeOptionalUserFallbackPolicy(value.explicitRunnerFallback, "runtimeDefaults.explicitRunnerFallback", path, diagnostics);
  if (explicitRunnerFallback) {
    result.explicitRunnerFallback = explicitRunnerFallback;
  }
  const implicitRunnerFallback = normalizeOptionalUserFallbackPolicy(value.implicitRunnerFallback, "runtimeDefaults.implicitRunnerFallback", path, diagnostics);
  if (implicitRunnerFallback) {
    result.implicitRunnerFallback = implicitRunnerFallback;
  }
  return Object.keys(result).length > 0 ? result : undefined;
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

function readUserRuntimeDefaultsFromConfig(
  path: string,
  runnerRegistry: RunnerRegistry,
  diagnostics?: RuntimeSettingsDiagnostic[],
): UserRuntimeDefaults | undefined {
  if (!existsSync(path)) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    pushRuntimeSettingsDiagnostic(diagnostics, {
      code: `${USER_CONFIG_DIAGNOSTIC_PREFIX}_invalid_json`,
      message: error instanceof Error ? error.message : String(error),
      path,
    });
    return undefined;
  }
  if (!isRecord(parsed)) {
    pushRuntimeSettingsDiagnostic(diagnostics, {
      code: `${USER_CONFIG_DIAGNOSTIC_PREFIX}_invalid_config`,
      message: "User config must contain a JSON object.",
      path,
    });
    return undefined;
  }
  return normalizeUserRuntimeDefaults(runnerRegistry, parsed.runtimeDefaults, path, diagnostics);
}

function mergeRuntimeSettingsInputs(
  workspaceInput: Partial<WorkspaceRuntimeSettings> | undefined,
  workspacePath: string,
  userRuntimeDefaults: UserRuntimeDefaults | undefined,
  userConfigPath: string,
): {
  readonly input: Partial<WorkspaceRuntimeSettings>;
  readonly sources: RuntimeSettingsSources;
} {
  const defaultRunnerId = workspaceInput?.defaultRunnerId ?? userRuntimeDefaults?.defaultRunnerId;
  const explicitRunnerFallback = workspaceInput?.explicitRunnerFallback ?? userRuntimeDefaults?.explicitRunnerFallback;
  const implicitRunnerFallback = workspaceInput?.implicitRunnerFallback ?? userRuntimeDefaults?.implicitRunnerFallback;
  return {
    input: {
      ...workspaceInput,
      defaultRunnerId,
      explicitRunnerFallback,
      implicitRunnerFallback,
    },
    sources: {
      defaultRunnerId: fieldSource(workspaceInput?.defaultRunnerId, workspacePath, userRuntimeDefaults?.defaultRunnerId, userConfigPath),
      explicitRunnerFallback: fieldSource(workspaceInput?.explicitRunnerFallback, workspacePath, userRuntimeDefaults?.explicitRunnerFallback, userConfigPath),
      implicitRunnerFallback: fieldSource(workspaceInput?.implicitRunnerFallback, workspacePath, userRuntimeDefaults?.implicitRunnerFallback, userConfigPath),
    },
  };
}

function fieldSource(
  workspaceValue: unknown,
  workspacePath: string,
  userValue: unknown,
  userConfigPath: string,
): RuntimeSettingsSourceInfo {
  if (workspaceValue !== undefined) {
    return { source: "workspace", path: workspacePath };
  }
  if (userValue !== undefined) {
    return { source: "user", path: userConfigPath };
  }
  return { source: "built_in" };
}

function normalizeOptionalUserRunnerId(
  runnerRegistry: RunnerRegistry,
  value: unknown,
  field: string,
  path: string | undefined,
  diagnostics?: RuntimeSettingsDiagnostic[],
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    pushRuntimeSettingsDiagnostic(diagnostics, {
      code: `${USER_CONFIG_DIAGNOSTIC_PREFIX}_invalid_runner`,
      message: `${field} must be a non-empty string.`,
      path,
    });
    return undefined;
  }
  const normalized = normalizeRunnerId(value) ?? value;
  const runner = runnerRegistry.get(normalized);
  if (!runner || runner.status !== "enabled") {
    pushRuntimeSettingsDiagnostic(diagnostics, {
      code: `${USER_CONFIG_DIAGNOSTIC_PREFIX}_unavailable_runner`,
      message: `${field} references an unavailable or disabled runner: ${value}.`,
      path,
    });
    return undefined;
  }
  return runner.id;
}

function normalizeOptionalUserFallbackPolicy(
  value: unknown,
  field: string,
  path: string | undefined,
  diagnostics?: RuntimeSettingsDiagnostic[],
): RunnerFallbackPolicy | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "disabled" || value === "allow_to_default") {
    return value;
  }
  pushRuntimeSettingsDiagnostic(diagnostics, {
    code: `${USER_CONFIG_DIAGNOSTIC_PREFIX}_invalid_fallback_policy`,
    message: `${field} must be disabled or allow_to_default.`,
    path,
  });
  return undefined;
}

function pushRuntimeSettingsDiagnostic(
  diagnostics: RuntimeSettingsDiagnostic[] | undefined,
  input: Omit<RuntimeSettingsDiagnostic, "level">,
): void {
  diagnostics?.push({
    level: "warning",
    ...input,
  });
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
