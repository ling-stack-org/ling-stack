import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_WORKSPACE_ID,
  isExternalExecutionEngineId,
  resolveConfigPaths,
  type RunnerFallbackPolicy,
  type RunStorePathsFacet,
  type WorkspaceRuntimeSettings,
} from "@ling-stack/core";
import { parseExecutionBindingRequest, type ExecutionBindingRequest, type RunnerToolHydrationCapability } from "@ling-stack/contracts";
import {
  DEFAULT_RUNNER_ID,
  normalizeRunnerId,
  type RegisteredRunner,
  type RunnerRegistry,
} from "./runners.js";
import type { RunnerReadinessSummary } from "./runner-readiness.js";

const RUNTIME_SETTINGS_FILE = "runtime-settings.json";
const DEFAULT_UPDATED_AT = "1970-01-01T00:00:00.000Z";
const USER_CONFIG_DIAGNOSTIC_PREFIX = "user_runtime_defaults";

export interface WorkspaceRuntimeSettingsPatch {
  readonly schemaVersion?: 2;
  readonly confirmNativeMigration?: boolean;
  readonly defaultExecutionBinding?: ExecutionBindingRequest | null;
  readonly expectedUpdatedAt?: string;
  readonly defaultRunnerId?: string;
  readonly allowedRunnerIds?: readonly string[];
  readonly explicitRunnerFallback?: RunnerFallbackPolicy;
  readonly implicitRunnerFallback?: RunnerFallbackPolicy;
}

export class RuntimeSettingsConflictError extends Error {
  constructor() { super("runtime_settings_conflict"); }
}

export interface RunnerListItem {
  readonly id: string;
  readonly displayName: string;
  readonly status: RegisteredRunner["status"];
  readonly profileSelection?: RegisteredRunner["profileSelection"];
  readonly aliases?: readonly string[];
  readonly supportedProviderApis?: readonly string[];
  readonly supportedTools?: readonly string[];
  readonly capabilities?: readonly string[];
  readonly toolHydration?: RunnerToolHydrationCapability;
  readonly featureFlag?: string;
  readonly disabledReason?: string;
  readonly readiness?: RunnerReadinessSummary;
}

export function listRunnerItems(
  runnerRegistry: RunnerRegistry,
  options: { readonly readinessByRunnerId?: ReadonlyMap<string, RunnerReadinessSummary> } = {},
): RunnerListItem[] {
  return runnerRegistry.list().map((runner) => ({
    id: runner.id,
    displayName: runner.displayName,
    status: runner.status,
    profileSelection: runner.profileSelection,
    aliases: runner.aliases,
    supportedProviderApis: runner.supportedProviderApis,
    supportedTools: runner.supportedTools,
    capabilities: runner.capabilities,
    toolHydration: runner.toolHydration,
    featureFlag: runner.featureFlag,
    disabledReason: runner.disabledReason,
    readiness: options.readinessByRunnerId?.get(runner.id),
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
  store: RunStorePathsFacet,
  runnerRegistry: RunnerRegistry,
  options: LoadWorkspaceRuntimeSettingsOptions = {},
): WorkspaceRuntimeSettings {
  return loadWorkspaceRuntimeSettingsWithSources(store, runnerRegistry, options).settings;
}

export function loadWorkspaceRuntimeSettingsWithSources(
  store: RunStorePathsFacet,
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
  store: RunStorePathsFacet,
  runnerRegistry: RunnerRegistry,
  input: WorkspaceRuntimeSettingsPatch,
  now: string = new Date().toISOString(),
): WorkspaceRuntimeSettings {
  const current = loadWorkspaceRuntimeSettings(store, runnerRegistry);
  if (input.expectedUpdatedAt !== undefined && input.expectedUpdatedAt !== current.updatedAt) {
    throw new RuntimeSettingsConflictError();
  }
  const defaultRunnerId = input.defaultRunnerId ?? current.defaultRunnerId;
  const allowedRunnerIds = input.allowedRunnerIds ?? current.allowedRunnerIds;
  const nativeSelectionChanged = allowedRunnerIds.some(id => isExternalExecutionEngineId(id) && !current.allowedRunnerIds.includes(id))
    || isExternalExecutionEngineId(defaultRunnerId) && (defaultRunnerId !== current.defaultRunnerId
      || input.defaultExecutionBinding !== undefined && JSON.stringify(input.defaultExecutionBinding) !== JSON.stringify(current.defaultExecutionBinding));
  if ((current.migration || nativeSelectionChanged) && (isExternalExecutionEngineId(defaultRunnerId) || allowedRunnerIds.some(isExternalExecutionEngineId))
    && (input.schemaVersion !== 2 || input.confirmNativeMigration !== true || input.expectedUpdatedAt === undefined)) {
    throw new Error("migration_confirmation_required");
  }
  if ((current.allowedRunnerIds.some(isExternalExecutionEngineId) || allowedRunnerIds.some(isExternalExecutionEngineId))
    && input.expectedUpdatedAt === undefined) throw new RuntimeSettingsConflictError();
  const defaultExecutionBinding = input.defaultExecutionBinding === undefined
    ? (input.defaultRunnerId !== undefined && input.defaultRunnerId !== current.defaultRunnerId ? undefined : current.defaultExecutionBinding)
    : input.defaultExecutionBinding ?? undefined;
  if (isExternalExecutionEngineId(defaultRunnerId)
    && (defaultExecutionBinding?.kind !== "native_profile" || defaultExecutionBinding.engineId !== defaultRunnerId)) {
    throw new Error("native_default_binding_required");
  }
  if (defaultExecutionBinding && (defaultExecutionBinding.kind === "pi_provider" ? defaultRunnerId !== DEFAULT_RUNNER_ID
    : defaultExecutionBinding.engineId !== defaultRunnerId)) throw new Error("default_execution_binding_mismatch");
  if (input.defaultRunnerId !== undefined && input.defaultRunnerId !== current.defaultRunnerId) {
    normalizeEnabledRunnerId(runnerRegistry, input.defaultRunnerId, "defaultRunnerId");
  }
  for (const id of input.allowedRunnerIds ?? []) {
    if (!current.allowedRunnerIds.includes(id)) normalizeEnabledRunnerId(runnerRegistry, id, "allowedRunnerIds");
  }
  const updatedAt = new Date(Math.max(Date.parse(now), (Date.parse(current.updatedAt) || 0) + 1)).toISOString();
  const next = normalizeWorkspaceRuntimeSettings(
    runnerRegistry,
    {
      ...current,
      ...input,
      schemaVersion: 2,
      defaultExecutionBinding,
      updatedAt,
    },
    updatedAt,
  );
  if ((input.defaultRunnerId !== undefined || input.allowedRunnerIds !== undefined)
    && next.allowedRunnerIds.length > 0 && !next.allowedRunnerIds.includes(next.defaultRunnerId)) {
    throw new Error(`defaultRunnerId must be included in allowedRunnerIds: ${next.defaultRunnerId}`);
  }
  mkdirSync(store.paths.rootDir, { recursive: true });
  const path = runtimeSettingsPath(store);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    if (current.migration && existsSync(path)) {
      writeFileSync(`${path}.v1-${randomUUID()}.bak`, readFileSync(path), { flag: "wx", mode: 0o600 });
    }
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
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
  // Preserve existing Pi/plugin defaults, but host availability cannot opt a workspace
  // into an external engine. Explicit empty policy is a deny-all, not a missing value.
  const implicitRunnerIds = runnerRegistry.list()
    .filter((runner) => runner.status === "enabled" && !isExternalExecutionEngineId(runner.id))
    .map((runner) => runner.id);
  const storedAllowedRunnerIds = normalizeAllowedRunnerIds(
    runnerRegistry,
    input?.allowedRunnerIds ?? implicitRunnerIds,
  );
  const defaultRunnerId = normalizeKnownRunnerId(runnerRegistry, input?.defaultRunnerId ?? DEFAULT_RUNNER_ID, "defaultRunnerId");
  const schemaVersion = input?.schemaVersion ?? (input?.allowedRunnerIds || input?.defaultRunnerId ? 1 : 2);
  const legacyAllowedRunnerIds = schemaVersion === 1 ? storedAllowedRunnerIds.filter(isExternalExecutionEngineId) : [];
  const legacyDefaultRunnerId = schemaVersion === 1 && isExternalExecutionEngineId(defaultRunnerId) ? defaultRunnerId : undefined;
  const allowedRunnerIds = schemaVersion === 1 ? storedAllowedRunnerIds.filter(id => !isExternalExecutionEngineId(id)) : storedAllowedRunnerIds;
  return {
    schemaVersion,
    workspaceId: input?.workspaceId ?? DEFAULT_WORKSPACE_ID,
    defaultRunnerId,
    ...(schemaVersion === 2 && input?.defaultExecutionBinding ? { defaultExecutionBinding: parseExecutionBindingRequest(input.defaultExecutionBinding) } : {}),
    ...(legacyAllowedRunnerIds.length || legacyDefaultRunnerId ? { migration: { status: "required" as const, legacyAllowedRunnerIds,
      ...(legacyDefaultRunnerId ? { legacyDefaultRunnerId } : {}) } } : {}),
    allowedRunnerIds,
    explicitRunnerFallback: readFallbackPolicy(input?.explicitRunnerFallback, "explicitRunnerFallback", "disabled"),
    implicitRunnerFallback: readFallbackPolicy(input?.implicitRunnerFallback, "implicitRunnerFallback", "allow_to_default"),
    updatedAt,
  };
}

function normalizeAllowedRunnerIds(runnerRegistry: RunnerRegistry, ids: readonly string[]): string[] {
  const normalized = new Set<string>();
  for (const id of ids) {
    normalized.add(normalizeKnownRunnerId(runnerRegistry, id, "allowedRunnerIds"));
  }
  return [...normalized];
}

function normalizeEnabledRunnerId(runnerRegistry: RunnerRegistry, id: string, field: string): string {
  const normalized = normalizeKnownRunnerId(runnerRegistry, id, field);
  const runner = runnerRegistry.get(normalized);
  if (runner?.status !== "enabled" && runner?.profileSelection !== "supported") {
    throw new Error(`${field} references a disabled runner: ${id}`);
  }
  return normalized;
}

function normalizeKnownRunnerId(runnerRegistry: RunnerRegistry, id: string, field: string): string {
  const normalized = normalizeRunnerId(id) ?? id;
  const runner = runnerRegistry.get(normalized);
  if (!runner) {
    throw new Error(`${field} references an unavailable runner: ${id}`);
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

function readStoredRuntimeSettings(store: RunStorePathsFacet): Partial<WorkspaceRuntimeSettings> | undefined {
  const path = runtimeSettingsPath(store);
  if (!existsSync(path)) {
    return undefined;
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("runtime-settings.json must contain a JSON object");
  }
  return {
    schemaVersion: parsed.schemaVersion === undefined ? 1 : readSchemaVersion(parsed.schemaVersion),
    workspaceId: readOptionalString(parsed, "workspaceId"),
    defaultRunnerId: readOptionalString(parsed, "defaultRunnerId"),
    defaultExecutionBinding: parsed.defaultExecutionBinding === undefined ? undefined : parseExecutionBindingRequest(parsed.defaultExecutionBinding),
    allowedRunnerIds: readOptionalStringArray(parsed, "allowedRunnerIds"),
    explicitRunnerFallback: readOptionalString(parsed, "explicitRunnerFallback") as RunnerFallbackPolicy | undefined,
    implicitRunnerFallback: readOptionalString(parsed, "implicitRunnerFallback") as RunnerFallbackPolicy | undefined,
    updatedAt: readOptionalString(parsed, "updatedAt"),
  };
}

function readSchemaVersion(value: unknown): 1 | 2 {
  if (value === 1 || value === 2) return value;
  throw new Error("runtime-settings.json has an unsupported schemaVersion");
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

function runtimeSettingsPath(store: RunStorePathsFacet): string {
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
