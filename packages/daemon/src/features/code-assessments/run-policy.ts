import type { RunStore } from "@ling-stack/core";
import type { PiRunnerRunOptions } from "@ling-stack/runner-pi";
import { PiRunnerAdapter } from "@ling-stack/runner-pi";
import type { RunRequest } from "../runs/schemas.js";
import { HttpError } from "../../errors.js";

export function assertCodeAssessmentRequest(store: RunStore, request: RunRequest, adapter?: unknown): void {
  if (!request.codeAssessment) return;
  const detail = store.getCodeAssessment(request.codeAssessment.id);
  const phase = request.codeAssessment.phase ?? "reviewing_code";
  const phaseAllowed = detail && (phase === "threat_model"
    ? detail.assessment.kind === "security" && !detail.assessment.threatModelArtifactId && ["collecting_diff", "threat_model"].includes(detail.assessment.phase)
    : phase === "reviewing_code" && (detail.assessment.kind === "review" || Boolean(detail.assessment.threatModelArtifactId))
      && ["collecting_diff", "reviewing_code"].includes(detail.assessment.phase));
  if (!detail || detail.snapshot.digest !== request.codeAssessment.snapshotDigest
    || !phaseAllowed
    || !["queued", "analyzing"].includes(detail.assessment.status)
    || request.cwd !== store.paths.cwd || request.runnerId !== "pi" || request.tools?.length !== 0
    || request.teammateId || request.requestedSkillId || request.workspaceAccessMode !== "read_only"
    || adapter !== undefined && !(adapter instanceof PiRunnerAdapter)) {
    throw new HttpError(409, "assessment_execution_changed", "Assessment execution requires its captured snapshot and the tool-free Pi Runner.");
  }
}

/** Applied to preparation and the final executable options, after ordinary tool injection. */
export function restrictCodeAssessmentTools(request: RunRequest, options: PiRunnerRunOptions): PiRunnerRunOptions {
  if (!request.codeAssessment) return options;
  return { ...options, tools: [], mcpTools: [], hostCapabilityTools: [], mediaGenerationTools: [],
    hooks: undefined,
    initialToolSurface: { toolHydration: false, mediaGeneration: false, userInput: false, delegation: false, nativeFileCreate: false },
    runtimeToolFeatures: { ...options.runtimeToolFeatures, requestPermissions: false, unifiedExec: false, shellSnapshot: false },
    readonlyToolsProfile: undefined, isolatedToolsProfile: undefined,
    onReadonlyToolCall: undefined, onIsolatedToolCall: undefined, onHostCapabilityCall: undefined,
    onMcpToolCall: undefined, onMediaGenerationToolCall: undefined, onToolHydrationRequest: undefined,
    onDelegationToolCall: undefined, onUserInputRequest: undefined, onPermissionRequired: undefined,
    onApprovalRequired: undefined,
    onToolBefore: () => ({ allowed: false, code: "assessment_tools_disabled", reason: "Assessment Runs only consume their immutable Diff input." }),
  };
}
