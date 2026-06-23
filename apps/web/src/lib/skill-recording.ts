import type {
  ProcedureObservationJobTerminalStatus,
  ProcedureObservationStep,
  ProcedureObservationValidationStep,
  RunArtifact,
  RunEventEnvelope,
  RunSession,
  SkillRecordingEligibilityResponse,
  SkillRecordingObservationRequest,
} from "../types.js";
import { readDataString } from "./data.js";
import { titleFromPrompt } from "./formatting.js";
import { readTaskPrompt, readTaskTitle } from "./run-evidence.js";

export type SkillRecordingDestinationHint = NonNullable<SkillRecordingObservationRequest["destinationHint"]>;
export type RunSkillRecordingDraftSource = "run" | "artifact";

export interface RunSkillRecordingDraft {
  readonly runId: string;
  readonly workspaceCwd: string;
  readonly source: RunSkillRecordingDraftSource;
  readonly sourceLabel?: string;
  readonly terminalStatus?: ProcedureObservationJobTerminalStatus;
  readonly destinationHint: SkillRecordingDestinationHint;
  readonly title: string;
  readonly summary: string;
  readonly normalizedGoal: string;
  readonly positiveTriggersText: string;
  readonly negativeTriggersText: string;
  readonly procedureStepsText: string;
  readonly validationStepsText: string;
  readonly toolLabels: readonly string[];
  readonly validationLabels: readonly string[];
  readonly artifactRefs: readonly string[];
  readonly duplicateHint?: string;
}

export interface RunSkillRecordingEligibility {
  readonly visible: boolean;
  readonly recommended: boolean;
  readonly reasonCode:
    | "available"
    | "missing_run"
    | "not_terminal"
    | "missing_evidence"
    | "permission_expansion"
    | "duplicate_existing"
    | "duplicate_analysis"
    | "recording_disabled"
    | "routed_elsewhere"
    | "missing_validation";
  readonly duplicateHint?: string;
  readonly serverPrecheck?: SkillRecordingEligibilityResponse;
}

export function buildRunSkillRecordingEligibility(run: RunSession | undefined, events: readonly RunEventEnvelope[]): RunSkillRecordingEligibility {
  if (!run || !isTerminalRunStatus(run.status)) {
    return { visible: false, recommended: false, reasonCode: "not_terminal" };
  }
  const toolLabels = toolLabelsFromEvents(events);
  const validationLabels = validationLabelsFromRun(run, events);
  const taskTitle = readTaskTitle(run.taskSnapshot);
  const taskPrompt = readTaskPrompt(run.taskSnapshot);
  const hasEvidence = Boolean(
    taskTitle ||
    taskPrompt ||
    run.selectedSkillId ||
    run.summaryPath ||
    run.eventLogPath ||
    toolLabels.length > 0 ||
    validationLabels.length > 0,
  );
  if (!hasEvidence) {
    return { visible: false, recommended: false, reasonCode: "missing_evidence" };
  }
  if (hasPermissionExpansionSignal([taskTitle, taskPrompt])) {
    return { visible: true, recommended: false, reasonCode: "permission_expansion" };
  }
  if (run.selectedSkillId) {
    return {
      visible: true,
      recommended: false,
      reasonCode: "duplicate_existing",
      duplicateHint: `This run already used skill ${run.selectedSkillId}. Prefer appending evidence or improving that skill unless this workflow is intentionally separate.`,
    };
  }
  return {
    visible: true,
    recommended: run.status === "succeeded" && (toolLabels.length >= 2 || validationLabels.length > 0),
    reasonCode: "available",
  };
}

export function buildRunSkillRecordingDraft(
  run: RunSession,
  events: readonly RunEventEnvelope[],
  artifacts: readonly RunArtifact[] = [],
): RunSkillRecordingDraft {
  const taskTitle = readTaskTitle(run.taskSnapshot);
  const taskPrompt = readTaskPrompt(run.taskSnapshot);
  const title = taskTitle || titleFromPrompt(taskPrompt) || `Recorded run ${shortId(run.id)}`;
  const toolLabels = toolLabelsFromEvents(events);
  const validationLabels = validationLabelsFromRun(run, events);
  const normalizedGoal = normalizeGoal(taskTitle || taskPrompt || title);
  const terminalStatus = terminalStatusFromRun(run);
  const duplicateHint = run.selectedSkillId
    ? `This run already used skill ${run.selectedSkillId}. Prefer appending evidence or improving that skill unless this workflow is intentionally separate.`
    : undefined;

  return {
    runId: run.id,
    workspaceCwd: readDataString(run.requestSnapshot, "workspaceCwd") || run.cwd,
    source: "run",
    sourceLabel: `Run ${shortId(run.id)}`,
    terminalStatus,
    destinationHint: defaultDestinationHint(run),
    title,
    summary: buildRunRecordingSummary(run, toolLabels),
    normalizedGoal,
    positiveTriggersText: [normalizedGoal, run.selectedSkillId ? `runs that use ${run.selectedSkillId}` : ""].filter(Boolean).join("\n"),
    negativeTriggersText: ["one-off chat", "sensitive access changes"].join("\n"),
    procedureStepsText: procedureStepText(toolLabels),
    validationStepsText: validationStepText(run, validationLabels),
    toolLabels,
    validationLabels,
    artifactRefs: artifacts.map((artifact) => artifact.id),
    duplicateHint,
  };
}

export function buildArtifactSkillRecordingDraft(
  run: RunSession,
  events: readonly RunEventEnvelope[],
  artifact: RunArtifact,
): RunSkillRecordingDraft {
  const artifactLabel = artifact.title || artifact.path || artifact.id;
  const draft = buildRunSkillRecordingDraft(run, events, [artifact]);
  return {
    ...draft,
    source: "artifact",
    sourceLabel: artifactLabel,
    summary: `${draft.summary} Artifact evidence: ${artifactLabel}.`,
    artifactRefs: [artifact.id],
  };
}

export function mergeRunSkillRecordingEligibility(
  local: RunSkillRecordingEligibility,
  server: SkillRecordingEligibilityResponse | undefined,
): RunSkillRecordingEligibility {
  if (!server) {
    return local;
  }
  return {
    visible: server.visible,
    recommended: server.recommended,
    reasonCode: server.reasonCode,
    duplicateHint: duplicateHintFromServerEligibility(server),
    serverPrecheck: server,
  };
}

function duplicateHintFromServerEligibility(server: SkillRecordingEligibilityResponse): string | undefined {
  if (server.selectedSkillId) {
    return `This run already used skill ${server.selectedSkillId}. Prefer appending evidence or improving that skill unless this workflow is intentionally separate.`;
  }
  if (!server.duplicateAnalysis || server.duplicateAnalysis.decision === "no_overlap") {
    return undefined;
  }
  const matched = [
    ...server.duplicateAnalysis.matchedSkillIds,
    ...server.duplicateAnalysis.matchedCandidateIds,
  ].join(", ");
  return matched
    ? `${server.duplicateAnalysis.rationale} Matched: ${matched}.`
    : server.duplicateAnalysis.rationale;
}

export function buildSkillRecordingRequestFromDraft(
  draft: RunSkillRecordingDraft,
  run: RunSession,
): SkillRecordingObservationRequest {
  return removeUndefined<SkillRecordingObservationRequest>({
    runId: run.id,
    channelId: run.channelId,
    teammateId: run.teammateId,
    taskId: run.taskId,
    selectedSkillId: run.selectedSkillId,
    terminalStatus: draft.terminalStatus,
    toolLabels: draft.toolLabels.length > 0 ? draft.toolLabels : undefined,
    validationLabels: draft.validationLabels.length > 0 ? draft.validationLabels : undefined,
    artifactRefs: draft.artifactRefs.length > 0 ? draft.artifactRefs : undefined,
    destinationHint: draft.destinationHint,
    title: draft.title.trim(),
    summary: draft.summary.trim(),
    normalizedGoal: draft.normalizedGoal.trim(),
    positiveTriggers: splitLines(draft.positiveTriggersText),
    negativeTriggers: splitLines(draft.negativeTriggersText),
    procedureSteps: procedureStepsFromText(draft.procedureStepsText, draft.toolLabels),
    validationSteps: validationStepsFromText(draft.validationStepsText),
    confidence: draft.terminalStatus === "succeeded" ? "high" : "medium",
    reusableScore: draft.terminalStatus === "succeeded" ? 80 : 65,
  });
}

export function splitLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function isTerminalRunStatus(status: RunSession["status"]): status is ProcedureObservationJobTerminalStatus {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

function terminalStatusFromRun(run: RunSession): ProcedureObservationJobTerminalStatus | undefined {
  return isTerminalRunStatus(run.status) ? run.status : undefined;
}

function toolLabelsFromEvents(events: readonly RunEventEnvelope[]): readonly string[] {
  return uniqueStrings(events
    .filter((event) => event.type.startsWith("tool_"))
    .map((event) => readDataString(event.data, "toolName") || readDataString(event.data, "tool"))
    .filter(Boolean));
}

function validationLabelsFromRun(run: RunSession, events: readonly RunEventEnvelope[]): readonly string[] {
  const labels = events
    .filter((event) => event.type === "result" || event.type === "run_end" || event.type === "run_error" || event.type === "run_cancelled")
    .map((event) => {
      const label = readDataString(event.data, "message") || readDataString(event.data, "reason") || readDataString(event.data, "status");
      return label || event.type.replace(/_/g, " ");
    });
  if (run.status === "succeeded") {
    labels.push("Run completed successfully");
  }
  if (run.status === "failed") {
    labels.push("Run failure captured for troubleshooting review");
  }
  if (run.status === "cancelled") {
    labels.push("Run cancellation captured for review");
  }
  return uniqueStrings(labels);
}

function procedureStepText(toolLabels: readonly string[]): string {
  if (toolLabels.length === 0) {
    return "Review the selected run evidence and repeat the confirmed workflow.";
  }
  return toolLabels.map((tool) => `Use ${tool} as part of the recorded workflow.`).join("\n");
}

function validationStepText(run: RunSession, validationLabels: readonly string[]): string {
  if (validationLabels.length > 0) {
    return validationLabels.join("\n");
  }
  if (run.status === "succeeded") {
    return "Confirm the run completed successfully and produced expected evidence.";
  }
  return "Review terminal run evidence before reusing this workflow.";
}

function procedureStepsFromText(value: string, toolLabels: readonly string[]): readonly ProcedureObservationStep[] {
  const tools = new Set(toolLabels.map((tool) => tool.toLowerCase()));
  return splitLines(value).map((line) => {
    const requiredTools = toolLabels.filter((tool) => tools.has(tool.toLowerCase()) && line.toLowerCase().includes(tool.toLowerCase()));
    return {
      title: line,
      instruction: line,
      requiredTools: requiredTools.length > 0 ? requiredTools : undefined,
    };
  });
}

function validationStepsFromText(value: string): readonly ProcedureObservationValidationStep[] {
  return splitLines(value).map((line) => ({
    title: line,
    commandOrCheck: line,
    expectedResult: "Validation evidence is present.",
  }));
}

function buildRunRecordingSummary(run: RunSession, toolLabels: readonly string[]): string {
  const pieces = [
    `Record terminal run ${shortId(run.id)} as reusable workflow evidence.`,
    `Status: ${run.status}.`,
    run.selectedSkillId ? `Selected skill: ${run.selectedSkillId}.` : "",
    toolLabels.length > 0 ? `Tools: ${toolLabels.join(", ")}.` : "",
  ].filter(Boolean);
  return pieces.join(" ");
}

function defaultDestinationHint(run: RunSession): SkillRecordingDestinationHint {
  return run.workflowStepId ? "channel_protocol" : "skill";
}

function normalizeGoal(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 96) || "record reusable run workflow";
}

function hasPermissionExpansionSignal(values: readonly string[]): boolean {
  const haystack = values.join(" ").toLowerCase();
  return [
    "skip approval",
    "without approval",
    "without asking",
    "always allow",
    "default allow",
    "跳过审批",
    "无需审批",
    "默认允许",
  ].some((needle) => haystack.includes(needle));
}

function uniqueStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    const key = trimmed.toLowerCase();
    if (!trimmed || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

function shortId(value: string): string {
  return value.length > 10 ? value.slice(0, 10) : value;
}

function removeUndefined<T extends object>(input: T): T {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as T;
}
