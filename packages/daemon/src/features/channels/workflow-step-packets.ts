import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { relative, resolve as resolvePath } from "node:path";
import {
  type ChannelWorkflow,
  type ChannelWorkflowStep,
  type ChannelWorkflowStepContextPacket,
  type ChannelWorkflowStepOutputPacket,
  type RunArtifact,
  type RunnerResolutionAudit,
  type RunSession,
  type RunStore,
  type WorkflowStepOutputRef,
} from "@ling-stack/core";
import { normalizeArtifactPath } from "../../shared/path.js";
import { isRecord } from "../../shared/validation.js";
import type { WorkflowStepRunRequest } from "./workflows.js";

export function createWorkflowStepContextArtifact(input: {
  readonly store: RunStore;
  readonly workflow: ChannelWorkflow;
  readonly step: ChannelWorkflowStep;
  readonly run: RunSession;
  readonly runRequest: WorkflowStepRunRequest;
  readonly now: string;
}): RunArtifact {
  return writeWorkflowStepPacketArtifact({
    store: input.store,
    run: input.run,
    workflowId: input.workflow.id,
    workflowStepId: input.step.id,
    kind: "context",
    title: `Workflow step context: ${input.step.title}`,
    packet: buildWorkflowStepContextPacket(input),
    now: input.now,
  });
}

export function createWorkflowStepOutputArtifact(input: {
  readonly store: RunStore;
  readonly workflow: ChannelWorkflow;
  readonly step: ChannelWorkflowStep;
  readonly run: RunSession;
  readonly now: string;
}): RunArtifact {
  return writeWorkflowStepPacketArtifact({
    store: input.store,
    run: input.run,
    workflowId: input.workflow.id,
    workflowStepId: input.step.id,
    kind: "output",
    title: `Workflow step output: ${input.step.title}`,
    packet: buildWorkflowStepOutputPacket(input),
    now: input.now,
  });
}

export function buildWorkflowStepContextPacket(input: {
  readonly store: RunStore;
  readonly workflow: ChannelWorkflow;
  readonly step: ChannelWorkflowStep;
  readonly run: RunSession;
  readonly runRequest: WorkflowStepRunRequest;
  readonly now: string;
}): ChannelWorkflowStepContextPacket {
  const dependencyRefs = buildDependencyRefs(input.store, input.workflow.id, input.step);
  const runnerAudit = readRunnerAudit(input.run);
  return omitUndefined({
    schemaVersion: 1 as const,
    workflowId: input.workflow.id,
    workflowStepId: input.step.id,
    objective: input.workflow.objective,
    stepTitle: input.step.title,
    stepPrompt: input.step.prompt,
    dependencies: dependencyRefs,
    priorOutputArtifactIds: uniqueStrings(dependencyRefs.flatMap((ref) => [
      ref.outputArtifactId,
      ...ref.artifactIds,
    ])),
    requestedRunnerId: runnerAudit?.requestedRunnerId ?? input.runRequest.runnerId,
    effectiveRunnerId: runnerAudit?.effectiveRunnerId,
    providerPresetId: input.runRequest.providerPresetId ?? input.run.providerPresetId,
    approvalGate: input.step.metadata?.approvalGate,
    generatedAt: input.now,
  });
}

export function buildWorkflowStepOutputPacket(input: {
  readonly store: RunStore;
  readonly workflow: ChannelWorkflow;
  readonly step: ChannelWorkflowStep;
  readonly run: RunSession;
  readonly now: string;
}): ChannelWorkflowStepOutputPacket {
  return omitUndefined({
    schemaVersion: 1 as const,
    workflowId: input.workflow.id,
    workflowStepId: input.step.id,
    runId: input.run.id,
    status: input.step.status,
    resultSummary: input.step.resultSummary ?? input.run.errorMessage,
    artifactIds: input.store.listArtifacts(input.run.id).map((artifact) => artifact.id),
    runnerAudit: readRunnerAudit(input.run),
    generatedAt: input.now,
  });
}

function buildDependencyRefs(
  store: RunStore,
  workflowId: string,
  step: ChannelWorkflowStep,
): WorkflowStepOutputRef[] {
  const stepsById = new Map(
    store.listChannelWorkflowSteps({ workflowId, limit: 500 }).map((candidate) => [candidate.id, candidate]),
  );
  return (step.metadata?.dependsOnStepIds ?? [])
    .map((stepId) => stepsById.get(stepId))
    .filter((candidate): candidate is ChannelWorkflowStep => candidate !== undefined)
    .map((dependency) => buildWorkflowStepOutputRef(store, dependency));
}

function buildWorkflowStepOutputRef(store: RunStore, step: ChannelWorkflowStep): WorkflowStepOutputRef {
  const runArtifacts = step.runId ? store.listArtifacts(step.runId).map((artifact) => artifact.id) : [];
  const metadataArtifactIds = [
    step.metadata?.outputArtifactId,
    ...(step.metadata?.outputArtifactIds ?? []),
  ];
  return omitUndefined({
    workflowStepId: step.id,
    runId: step.runId,
    status: step.status,
    resultSummary: step.resultSummary,
    outputArtifactId: step.metadata?.outputArtifactId,
    artifactIds: uniqueStrings([...metadataArtifactIds, ...runArtifacts]),
  });
}

function writeWorkflowStepPacketArtifact(input: {
  readonly store: RunStore;
  readonly run: RunSession;
  readonly workflowId: string;
  readonly workflowStepId: string;
  readonly kind: "context" | "output";
  readonly title: string;
  readonly packet: ChannelWorkflowStepContextPacket | ChannelWorkflowStepOutputPacket;
  readonly now: string;
}): RunArtifact {
  const artifactDir = resolvePath(
    input.store.paths.artifactsDir,
    input.run.id,
    "workflows",
    input.workflowId,
    "steps",
    input.workflowStepId,
  );
  mkdirSync(artifactDir, { recursive: true });
  const artifactPath = resolvePath(artifactDir, `${input.kind}.json`);
  const content = `${JSON.stringify(input.packet, null, 2)}\n`;
  writeFileSync(artifactPath, content, "utf8");
  const stats = statSync(artifactPath);

  return input.store.createArtifact({
    runId: input.run.id,
    type: "json",
    path: normalizeArtifactPath(relative(input.store.paths.artifactsDir, artifactPath)),
    title: input.title,
    contentType: "application/json; charset=utf-8",
    sizeBytes: Number(stats.size),
    createdAt: input.now,
  });
}

function readRunnerAudit(run: RunSession): RunnerResolutionAudit | undefined {
  const requestSnapshot = isRecord(run.requestSnapshot) ? run.requestSnapshot : undefined;
  const runnerResolution = requestSnapshot && isRecord(requestSnapshot.runnerResolution)
    ? requestSnapshot.runnerResolution
    : undefined;
  if (!runnerResolution) {
    return undefined;
  }
  const requestedRunnerId = readOptionalStringField(runnerResolution, "requestedRunnerId");
  const effectiveRunnerId = readOptionalStringField(runnerResolution, "effectiveRunnerId");
  if (!requestedRunnerId || !effectiveRunnerId) {
    return undefined;
  }
  return omitUndefined({
    requestedRunnerId,
    effectiveRunnerId,
    requestSource: readOptionalStringField(runnerResolution, "requestSource") as RunnerResolutionAudit["requestSource"],
    fallbackAllowed: readOptionalBooleanField(runnerResolution, "fallbackAllowed"),
    fallbackReason: readRunnerFallbackReason(runnerResolution.fallbackReason),
  });
}

function readRunnerFallbackReason(value: unknown): RunnerResolutionAudit["fallbackReason"] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const code = readOptionalStringField(value, "code");
  const message = readOptionalStringField(value, "message");
  if (!code || !message) {
    return undefined;
  }
  return { code: code as NonNullable<RunnerResolutionAudit["fallbackReason"]>["code"], message };
}

function readOptionalStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readOptionalBooleanField(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

function uniqueStrings(values: readonly (string | undefined)[]): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0))];
}

function omitUndefined<T extends Record<string, unknown>>(record: T): T {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as T;
}
