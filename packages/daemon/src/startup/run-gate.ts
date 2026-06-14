import type { StartupPhase, StartupPhaseStatus } from "@ling-stack/contracts";
import type { SecretResolver } from "@ling-stack/core";
import { HttpError } from "../errors.js";
import type { RunnerRegistry } from "../runtime/runners.js";
import type { RunStoreRegistry } from "../runtime/store-registry.js";
import { requiredStartupPhases, type StartupStateRegistry } from "./state.js";
import { warmDefaultWorkspaceStartup } from "./warmup.js";

export async function ensureStartupReadyForRun(input: {
  readonly cwd: string;
  readonly startupState?: StartupStateRegistry;
  readonly storeRegistry: RunStoreRegistry;
  readonly runnerRegistry: RunnerRegistry;
  readonly secretResolver: SecretResolver;
}): Promise<void> {
  if (!input.startupState) {
    return;
  }

  let status = input.startupState.snapshot(input.cwd);
  if (!status || status.state === "starting") {
    await warmDefaultWorkspaceStartup({
      cwd: input.cwd,
      startupState: input.startupState,
      storeRegistry: input.storeRegistry,
      runnerRegistry: input.runnerRegistry,
      secretResolver: input.secretResolver,
    });
    status = input.startupState.ensureWorkspace(input.cwd);
  }

  if (status.state === "starting") {
    throw new HttpError(
      503,
      "startup_not_ready",
      "Workspace startup is still loading. Retry after startup status reaches ready, degraded, or failed.",
    );
  }

  if (status.state !== "failed") {
    return;
  }

  const failedPhase = selectFailedRequiredPhase(status.phases);
  const diagnostic = status.diagnostics.find((item) => item.phase === failedPhase && item.level === "error") ??
    status.diagnostics.find((item) => item.level === "error");
  throw new HttpError(
    statusCodeForFailedPhase(failedPhase),
    errorCodeForFailedPhase(failedPhase),
    diagnostic?.nextAction ? `${diagnostic.message} Next: ${diagnostic.nextAction}` : diagnostic?.message ?? `Startup phase failed: ${failedPhase}`,
  );
}

function selectFailedRequiredPhase(phases: Readonly<Record<StartupPhase, StartupPhaseStatus>>): StartupPhase {
  if (phases.workspace_store === "failed") {
    return "workspace_store";
  }
  if (phases.runtime_policy === "failed") {
    return "runtime_policy";
  }
  return derivePhaseSelection(phases);
}

function derivePhaseSelection(phases: Readonly<Record<StartupPhase, StartupPhaseStatus>>): StartupPhase {
  return requiredStartupPhases.find((phase) => phases[phase] === "failed") ?? "process_config";
}

function statusCodeForFailedPhase(phase: StartupPhase): number {
  return phase === "workspace_store" ? 503 : 409;
}

function errorCodeForFailedPhase(phase: StartupPhase): string {
  if (phase === "runtime_policy") {
    return "runtime_policy_invalid";
  }
  if (phase === "workspace_store") {
    return "workspace_startup_failed";
  }
  if (phase === "effective_config") {
    return "effective_config_invalid";
  }
  return "startup_required_phase_failed";
}
