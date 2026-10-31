import { createHash } from "node:crypto";
import type { SkillCandidateSourceRef } from "./skill-candidate-types.js";
import {
  type CreateProcedureObservationInput,
  type ProcedureObservationSignal,
  type ProcedureObservationSource,
  type ProcedureObservationStep,
  type ProcedureObservationValidationStep,
} from "./procedure-observation-types.js";
import { DEFAULT_WORKSPACE_ID } from "./workspace-types.js";

export type ProcedureObservationJobTerminalStatus = "succeeded" | "failed" | "cancelled";

export interface ProcedureObservationJobInput {
  readonly id?: string;
  readonly workspaceId?: string;
  readonly source: ProcedureObservationSource;
  readonly signals: readonly ProcedureObservationSignal[];
  readonly runId?: string;
  readonly effectiveAttemptId?: string;
  readonly evidenceVersion?: string;
  readonly messageId?: string;
  readonly reviewActionId?: string;
  readonly channelId?: string;
  readonly teammateId?: string;
  readonly taskId?: string;
  readonly selectedSkillId?: string;
  /** Daemon-owned provenance; never accepted from observation HTTP requests. */
  readonly learningReviewJobId?: string;
  readonly terminalStatus?: ProcedureObservationJobTerminalStatus;
  readonly toolLabels?: readonly string[];
  readonly validationLabels?: readonly string[];
  readonly artifactRefs?: readonly string[];
  readonly userConfirmed: boolean;
  readonly destinationHint?: "skill" | "channel_protocol" | "playbook" | "automation" | "memory";
  readonly title: string;
  readonly summary: string;
  readonly normalizedGoal: string;
  readonly positiveTriggers?: readonly string[];
  readonly negativeTriggers?: readonly string[];
  readonly procedureSteps?: readonly ProcedureObservationStep[];
  readonly validationSteps?: readonly ProcedureObservationValidationStep[];
  readonly confidence?: "low" | "medium" | "high";
  readonly reusableScore?: number;
}

export type SkillRecordingObservationInput = Omit<
  ProcedureObservationJobInput,
  "source" | "signals" | "userConfirmed"
>;

export interface ProcedureObservationJobBuildResult {
  readonly jobKey: string;
  readonly legacyJobKey?: string;
  readonly observationInput: CreateProcedureObservationInput;
}

export function createProcedureObservationJobFromRecording(input: SkillRecordingObservationInput): ProcedureObservationJobInput {
  return {
    ...input,
    source: "manual_recording",
    signals: ["save_as_skill", "user_approved_recording"],
    userConfirmed: true,
    destinationHint: input.destinationHint ?? "skill",
  };
}

export function createProcedureObservationJobKey(input: ProcedureObservationJobInput): string {
  const payload = JSON.stringify([
    "v2", input.workspaceId ?? DEFAULT_WORKSPACE_ID, input.source,
    input.runId ?? input.messageId ?? input.reviewActionId ?? input.id ?? "manual",
    input.channelId ?? null, input.teammateId ?? null, input.taskId ?? null,
    input.effectiveAttemptId ?? null, input.evidenceVersion ?? null,
    input.destinationHint ?? inferDestinationHint(input), normalizeSignaturePart(input.normalizedGoal),
  ]);
  return `observation_job_${createHash("sha256").update(payload).digest("hex").slice(0, 24)}`;
}

function legacyProcedureObservationJobKey(input: ProcedureObservationJobInput): string {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const sourceId = input.runId ?? input.messageId ?? input.reviewActionId ?? input.id ?? "manual";
  const payload = [
    workspaceId,
    input.source,
    sourceId,
    input.destinationHint ?? inferDestinationHint(input),
    normalizeSignaturePart(input.normalizedGoal),
  ].join("|");
  return `observation_job_${createHash("sha256").update(payload).digest("hex").slice(0, 24)}`;
}

export function createProcedureObservationInputFromJob(input: ProcedureObservationJobInput): ProcedureObservationJobBuildResult {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const jobKey = createProcedureObservationJobKey(input);
  const procedureSteps = input.procedureSteps && input.procedureSteps.length > 0
    ? input.procedureSteps
    : procedureStepsFromToolLabels(input.toolLabels ?? []);
  const validationSteps = input.validationSteps && input.validationSteps.length > 0
    ? input.validationSteps
    : validationStepsFromLabels(input.validationLabels ?? []);
  const sourceRefs = sourceRefsFromJob(input, jobKey);
  return {
    jobKey,
    ...(input.effectiveAttemptId === undefined && input.evidenceVersion === undefined
      ? { legacyJobKey: legacyProcedureObservationJobKey(input) } : {}),
    observationInput: {
      id: input.id,
      workspaceId,
      channelId: input.channelId,
      teammateId: input.teammateId,
      taskId: input.taskId,
      runId: input.runId,
      source: input.source,
      signals: uniqueStrings(input.signals),
      title: input.title,
      summary: input.summary,
      normalizedGoal: input.normalizedGoal,
      positiveTriggers: input.positiveTriggers,
      negativeTriggers: input.negativeTriggers,
      procedureSteps,
      validationSteps,
      sourceRefs,
      confidence: input.confidence ?? (input.userConfirmed ? "high" : "medium"),
      reusableScore: input.reusableScore ?? reusableScore(input, validationSteps),
    },
  };
}

export function procedureObservationHasJobKey(input: {
  readonly sourceRefs: readonly SkillCandidateSourceRef[];
}, jobKey: string): boolean {
  return input.sourceRefs.some((ref) => ref.type === "observation-job" && ref.id === jobKey);
}

export function procedureObservationHasTerminalStatus(input: {
  readonly sourceRefs: readonly SkillCandidateSourceRef[];
}, terminalStatus: ProcedureObservationJobTerminalStatus): boolean {
  return input.sourceRefs.some((ref) => ref.type === "decision" && ref.id === terminalStatusSourceRefId(terminalStatus));
}

export function isExplicitObservationJob(input: ProcedureObservationJobInput): boolean {
  return input.userConfirmed && (
    input.source === "manual_recording" ||
    input.signals.includes("save_as_skill") ||
    input.signals.includes("user_approved_recording")
  );
}

function inferDestinationHint(input: ProcedureObservationJobInput): string {
  if (input.destinationHint) {
    return input.destinationHint;
  }
  if (input.source === "multi_agent_handoff" || input.signals.includes("handoff_stabilized")) {
    return "channel_protocol";
  }
  if (input.signals.includes("save_as_skill") || input.signals.includes("user_approved_recording")) {
    return "skill";
  }
  return "unknown";
}

function procedureStepsFromToolLabels(toolLabels: readonly string[]): ProcedureObservationStep[] {
  return uniqueStrings(toolLabels).map((label) => ({
    title: `Run ${label}`,
    instruction: `Use ${label} as part of the observed workflow.`,
    requiredTools: [label],
  }));
}

function validationStepsFromLabels(validationLabels: readonly string[]): ProcedureObservationValidationStep[] {
  return uniqueStrings(validationLabels).map((label) => ({
    title: label,
    commandOrCheck: label,
    expectedResult: "Validation evidence is present.",
  }));
}

function sourceRefsFromJob(input: ProcedureObservationJobInput, jobKey: string): SkillCandidateSourceRef[] {
  const refs: SkillCandidateSourceRef[] = [{
    type: "observation-job",
    id: jobKey,
    label: "Observation job idempotency key",
  }];
  if (input.runId) {
    refs.push({ type: "run", id: input.runId, label: "Observed run" });
  }
  if (input.messageId) {
    refs.push({ type: "message", id: input.messageId, label: "User confirmation message" });
  }
  if (input.reviewActionId) {
    refs.push({ type: "decision", id: input.reviewActionId, label: "Review action" });
  }
  if (input.learningReviewJobId) refs.push({ type: "learning-review", id: input.learningReviewJobId, label: "Learning review evidence" });
  if (input.selectedSkillId) {
    refs.push({ type: "skill", id: input.selectedSkillId, label: "Selected skill" });
  }
  if (input.terminalStatus) {
    refs.push({ type: "decision", id: terminalStatusSourceRefId(input.terminalStatus), label: `Terminal status: ${input.terminalStatus}` });
  }
  for (const artifactRef of uniqueStrings(input.artifactRefs ?? [])) {
    refs.push({ type: "artifact", id: artifactRef, label: "Validation artifact" });
  }
  return refs;
}

function terminalStatusSourceRefId(status: ProcedureObservationJobTerminalStatus): string {
  return `terminal_status:${status}`;
}

function reusableScore(input: ProcedureObservationJobInput, validationSteps: readonly ProcedureObservationValidationStep[]): number {
  let score = 0;
  if (input.userConfirmed) {
    score += 50;
  }
  if (input.signals.includes("same_sequence_repeated")) {
    score += 20;
  }
  if (validationSteps.length > 0) {
    score += 15;
  }
  if ((input.negativeTriggers ?? []).length > 0) {
    score += 10;
  }
  if (input.channelId || input.teammateId) {
    score += 5;
  }
  return Math.min(score, 100);
}

function uniqueStrings<T extends string>(values: readonly T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    result.push(trimmed as T);
  }
  return result;
}

function normalizeSignaturePart(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}
