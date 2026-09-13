import {
  authorizationModes,
  conversationModeKinds,
  sessionPermissionModes,
  workspaceAccessModes,
  type EffectiveRunPolicySnapshot,
  type RunSession,
} from "@ling-stack/core";
import type { PiRunnerProviderConfig } from "@ling-stack/runner-pi";
import type { RunnerContinuationOrigin } from "@ling-stack/contracts";
import { isRecord } from "../../shared/validation.js";
import { readPreparedRunnerInput, type PreparedRunnerInput } from "./prepared-runner-input.js";
import type { RunRequest } from "./schemas.js";

const REDACTED_VALUE = "[REDACTED]";

/**
 * Rebuild the trusted, non-secret request needed to continue one existing Run.
 * Mutable conversation context is never consulted here. Provider credentials,
 * MCP authority and Host capabilities are rebound later from current sources.
 */
export function rebuildExistingRunRequest(
  run: RunSession,
  origin: RunnerContinuationOrigin,
): RunRequest {
  if (!isRecord(run.requestSnapshot)) {
    throw new Error("Existing Run request snapshot is missing.");
  }
  const snapshot = structuredClone(run.requestSnapshot);
  const task = readStoredRunTask(run);
  const workspaceCwd = readOptionalNonEmptyString(snapshot.workspaceCwd) ?? run.cwd;
  const storedExecutionCwd = readOptionalNonEmptyString(snapshot.executionCwd)
    ?? readOptionalNonEmptyString(snapshot.cwd);
  if (storedExecutionCwd && storedExecutionCwd !== run.cwd) {
    throw new Error("Existing Run execution cwd does not match its durable snapshot.");
  }
  assertOptionalLineage(snapshot.threadId, run.threadId, "thread");
  assertOptionalLineage(snapshot.teammateId, run.teammateId, "teammate");
  assertOptionalLineage(snapshot.workflowStepId, run.workflowStepId, "workflow step");
  assertOptionalLineage(snapshot.parentRunId, run.parentRunId, "parent Run");

  const storedPresetId = readOptionalNonEmptyString(snapshot.providerPresetId);
  if (storedPresetId !== undefined && storedPresetId !== run.providerPresetId) {
    throw new Error("Existing Run provider preset lineage does not match.");
  }
  const providerPresetId = run.providerPresetId;
  const provider = providerPresetId ? undefined : readRecoverableInlineProvider(run, snapshot);
  const requestedSkillId = run.selectedSkillId
    ?? readOptionalNonEmptyString(snapshot.requestedSkillId)
    ?? readOptionalNonEmptyString(snapshot.selectedSkillId);
  if (run.selectedSkillId
    && readOptionalNonEmptyString(snapshot.selectedSkillId)
    && snapshot.selectedSkillId !== run.selectedSkillId) {
    throw new Error("Existing Run selected skill lineage does not match.");
  }
  if (!isRecord(snapshot.harnessFeatureSnapshot)
    || snapshot.harnessFeatureSnapshot.continuations !== "enforce") {
    throw new Error("Existing Run was not admitted with enforced continuation semantics.");
  }

  return {
    ...(snapshot as unknown as RunRequest),
    cwd: run.cwd,
    workspaceCwd,
    task,
    providerPresetId,
    provider,
    teammateId: run.teammateId,
    workflowStepId: run.workflowStepId,
    threadId: run.threadId,
    requestedSkillId,
    parentRunId: run.parentRunId,
    continuationReason: run.continuationReason,
    skipMemoryRecall: true,
    harnessContinuationOrigin: origin,
  };
}

export function readStoredRunnerExecution(run: RunSession): PreparedRunnerInput | undefined {
  if (!isRecord(run.requestSnapshot) || run.requestSnapshot.runnerExecutionInput === undefined) {
    return undefined;
  }
  try {
    return readPreparedRunnerInput(run.requestSnapshot.runnerExecutionInput, {
      cwd: run.cwd,
      task: readStoredRunTask(run),
    });
  } catch {
    return undefined;
  }
}

export function readStoredEffectivePolicySnapshot(value: unknown): EffectiveRunPolicySnapshot | undefined {
  if (!isRecord(value) || !isRecord(value.effectivePolicySnapshot)) return undefined;
  const snapshot = value.effectivePolicySnapshot;
  if (typeof snapshot.mode !== "string"
    || !sessionPermissionModes.includes(snapshot.mode as EffectiveRunPolicySnapshot["mode"])
    || (snapshot.authorizationMode !== undefined
      && (typeof snapshot.authorizationMode !== "string"
        || !authorizationModes.includes(snapshot.authorizationMode as NonNullable<EffectiveRunPolicySnapshot["authorizationMode"]>)))
    || (snapshot.workspaceAccessMode !== undefined
      && (typeof snapshot.workspaceAccessMode !== "string"
        || !workspaceAccessModes.includes(snapshot.workspaceAccessMode as NonNullable<EffectiveRunPolicySnapshot["workspaceAccessMode"]>)))
    || (snapshot.conversationMode !== undefined
      && (typeof snapshot.conversationMode !== "string"
        || !conversationModeKinds.includes(snapshot.conversationMode as NonNullable<EffectiveRunPolicySnapshot["conversationMode"]>)))
    || (snapshot.planModeMutationPolicy !== undefined
      && snapshot.planModeMutationPolicy !== "deny_repo_tracked_mutation")
    || typeof snapshot.workspacePolicyUpdatedAt !== "string"
    || !snapshot.workspacePolicyUpdatedAt
    || !isRecord(snapshot.toolDecisions)
    || !Array.isArray(snapshot.allowedWritePaths)
    || !snapshot.allowedWritePaths.every((path) => typeof path === "string")
    || !Array.isArray(snapshot.riskNotes)
    || !snapshot.riskNotes.every((note) => isRecord(note)
      && typeof note.code === "string"
      && typeof note.message === "string")) {
    return undefined;
  }
  return structuredClone(snapshot) as unknown as EffectiveRunPolicySnapshot;
}

function readStoredRunTask(run: RunSession): RunRequest["task"] {
  if (!isRecord(run.taskSnapshot)) {
    throw new Error("Existing Run task snapshot is missing.");
  }
  const id = readOptionalNonEmptyString(run.taskSnapshot.id);
  const title = readOptionalNonEmptyString(run.taskSnapshot.title);
  const prompt = typeof run.taskSnapshot.prompt === "string" ? run.taskSnapshot.prompt : undefined;
  const channelId = readOptionalNonEmptyString(run.taskSnapshot.channelId);
  if (!id || id !== run.taskId || !title || prompt === undefined) {
    throw new Error("Existing Run task snapshot is invalid.");
  }
  if (channelId !== run.channelId) {
    throw new Error("Existing Run task channel lineage does not match.");
  }
  return { id, title, prompt, channelId };
}

function readRecoverableInlineProvider(
  run: RunSession,
  requestSnapshot: Record<string, unknown>,
): PiRunnerProviderConfig {
  const value = isRecord(requestSnapshot.provider)
    ? requestSnapshot.provider
    : isRecord(run.providerSnapshot) ? run.providerSnapshot : undefined;
  if (!value
    || readOptionalNonEmptyString(value.provider) !== run.providerName
    || readOptionalNonEmptyString(value.model) !== run.providerModel) {
    throw new Error("Existing Run inline provider snapshot is missing or does not match.");
  }
  if (containsRedactedValue(value)) {
    throw new Error("Existing Run inline provider credentials are not recoverable; select a configured provider preset.");
  }
  return structuredClone(value) as unknown as PiRunnerProviderConfig;
}

function assertOptionalLineage(stored: unknown, current: string | undefined, label: string): void {
  const value = readOptionalNonEmptyString(stored);
  if (value !== undefined && value !== current) {
    throw new Error(`Existing Run ${label} lineage does not match.`);
  }
}

function readOptionalNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function containsRedactedValue(value: unknown): boolean {
  if (value === REDACTED_VALUE) return true;
  if (Array.isArray(value)) return value.some(containsRedactedValue);
  return isRecord(value) && Object.values(value).some(containsRedactedValue);
}
