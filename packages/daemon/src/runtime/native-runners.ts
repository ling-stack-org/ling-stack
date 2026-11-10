import { externalExecutionEngineIds } from "@ling-stack/contracts";
import type { RegisteredRunner, RunnerRegistry, RunnerResolution } from "./runners.js";
import type { NativeBoundRunRequest } from "../features/runs/native-run-dispatcher.js";
import { createUnverifiedToolExecutionConformance } from "./runner-tool-conformance.js";
import { HttpError } from "../errors.js";

/** Catalog support describes selection. Executability is assessed for each profile/workspace/surface. */
export function listNativeRunnerRegistrations(): RegisteredRunner[] {
  const names = { "codex-app-server": "Codex", "kimi-acp": "Kimi Code CLI", "openclaw-acp": "OpenClaw", "claude-agent-sdk": "Claude Code" };
  return externalExecutionEngineIds.map(id => {
    const adapterRevision = `${id}:native-adapter-v1`;
    return { id, displayName: names[id], status: "disabled", profileSelection: id === "claude-agent-sdk" ? "unsupported" : "supported",
      adapter: { async runTask() { throw new Error("legacy_runner_migration_required: select a verified native profile"); } },
      executionBoundary: "external", adapterRevision, toolSideEffects: {}, supportedTools: [], capabilities: [],
      toolExecutionConformance: createUnverifiedToolExecutionConformance(adapterRevision),
      resumeCapabilities: { nativeResume: false, hostApprovalContinuation: [] },
      nativeResumeConformance: { revision: `${id}:native-resume-unverified:v1`, readinessPassed: false,
        conformancePassed: false, abortPropagationVerified: false, approvalBridgeVerified: false },
      disabledReason: id === "claude-agent-sdk" ? "native_execution_unsupported"
        : "legacy_runner_migration_required: select a native profile with current execution verification",
    };
  });
}

/** Resolve catalog identity and policy only. The target admission check is independently mandatory. */
export function resolveNativeRunnerSelection(registry: RunnerRegistry, request: NativeBoundRunRequest,
  allowedRunnerIds: readonly string[], hasAdmission: boolean): RunnerResolution {
  const id = request.executionBinding.engineId;
  const runner = registry.get(id);
  if (runner?.profileSelection !== undefined) {
    if (runner.profileSelection !== "supported") throw new HttpError(409, "native_execution_unsupported", "This engine does not support execution.");
    if (!allowedRunnerIds.includes(id)) throw new HttpError(409, "native_execution_not_allowed", "This workspace has not authorized the native engine.");
    if (!hasAdmission) throw new HttpError(409, "native_execution_unavailable", "Native execution verification is unavailable.");
    return { requestedRunnerId: id, effectiveRunnerId: id, requestSource: "run_request", fallbackAllowed: false, runner };
  }
  // Trusted embedded registries remain a test/embedding seam. The production catalog always uses admission.
  return registry.resolve({ requestedRunnerId: id, allowedRunnerIds, requestSource: "run_request", allowFallback: false });
}
