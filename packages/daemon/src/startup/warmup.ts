import type { EffectiveConfigDiagnostic, StartupDiagnostic, StartupPhase } from "@ling-stack/contracts";
import type { SecretResolver } from "@ling-stack/core";
import type { RunnerRegistry } from "../runtime/runners.js";
import type { RunStoreRegistry } from "../runtime/store-registry.js";
import { buildEffectiveConfigResponse } from "../features/settings/effective-config.js";
import type { StartupStateRegistry } from "./state.js";

export interface StartupWarmupInput {
  readonly cwd: string;
  readonly startupState: StartupStateRegistry;
  readonly storeRegistry: RunStoreRegistry;
  readonly runnerRegistry: RunnerRegistry;
  readonly secretResolver: SecretResolver;
}

export async function warmDefaultWorkspaceStartup(input: StartupWarmupInput): Promise<void> {
  const { cwd, startupState } = input;
  startupState.ensureWorkspace(cwd);
  startupState.setPhase(cwd, "process_config", "ready");
  startupState.setPhase(cwd, "user_config", "loading");
  startupState.setPhase(cwd, "workspace_store", "loading");

  let store: ReturnType<RunStoreRegistry["getStore"]>;
  try {
    store = input.storeRegistry.getStore(cwd);
    startupState.setPhase(cwd, "workspace_store", "ready");
  } catch (error) {
    startupState.setPhase(cwd, "workspace_store", "failed");
    startupState.addDiagnostic(cwd, {
      level: "error",
      code: "workspace_store_open_failed",
      phase: "workspace_store",
      message: errorMessage(error),
      nextAction: "Run ling-stack doctor config for this workspace.",
    });
    markSkippedRequiredPhases(input, ["effective_config", "runtime_policy", "secret_resolver"]);
    return;
  }

  startupState.setPhase(cwd, "effective_config", "loading");
  startupState.setPhase(cwd, "runtime_policy", "loading");
  try {
    const response = await buildEffectiveConfigResponse({ cwd, store, runnerRegistry: input.runnerRegistry });
    for (const diagnostic of response.diagnostics) {
      startupState.addDiagnostic(cwd, toStartupDiagnostic(diagnostic));
    }
    startupState.setPhase(cwd, "user_config", response.diagnostics.length > 0 ? "degraded" : "ready");
    startupState.recordEffectiveConfigSnapshot(cwd, {
      cwd: response.cwd,
      loadedAt: new Date().toISOString(),
      source: "startup",
      response,
    });
    startupState.setPhase(cwd, "effective_config", "ready");
    startupState.setPhase(cwd, "runtime_policy", "ready");
  } catch (error) {
    startupState.setPhase(cwd, "effective_config", "failed");
    startupState.setPhase(cwd, "runtime_policy", "failed");
    startupState.addDiagnostic(cwd, {
      level: "error",
      code: "effective_config_load_failed",
      phase: "effective_config",
      message: errorMessage(error),
      nextAction: "Inspect user config, workspace settings, and runtime-settings.json.",
    });
    return;
  }

  startupState.setPhase(cwd, "secret_resolver", "loading");
  const keychainStatus = input.secretResolver.status("keychain:ling_stack_startup_probe", "provider_api_key");
  if (keychainStatus.errorCode === "secret_store_unavailable" || keychainStatus.errorCode === "secret_access_denied") {
    startupState.setPhase(cwd, "secret_resolver", "degraded");
    startupState.addDiagnostic(cwd, {
      level: "warning",
      code: keychainStatus.errorCode,
      phase: "secret_resolver",
      message: keychainStatus.message ?? "Secret resolver capability is degraded.",
      nextAction: "Use env: refs or configure desktop keychain support.",
    });
  } else {
    startupState.setPhase(cwd, "secret_resolver", "ready");
  }
}

function markSkippedRequiredPhases(input: StartupWarmupInput, phases: readonly StartupPhase[]): void {
  for (const phase of phases) {
    input.startupState.setPhase(input.cwd, phase, "failed");
  }
}

function toStartupDiagnostic(diagnostic: EffectiveConfigDiagnostic): StartupDiagnostic {
  return {
    level: diagnostic.level,
    code: diagnostic.code,
    phase: classifyEffectiveConfigDiagnostic(diagnostic.code),
    message: diagnostic.message,
    path: diagnostic.path,
  };
}

function classifyEffectiveConfigDiagnostic(code: string): StartupPhase {
  if (code.startsWith("user_config") || code.startsWith("user_settings") || code.startsWith("user_runtime_defaults")) {
    return "user_config";
  }
  return "effective_config";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
