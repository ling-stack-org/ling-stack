import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve as resolvePath } from "node:path";
import {
  type ChannelWorkflow,
  type ChannelWorkflowStep,
  type ChannelWorkflowStepContextPacket,
  type ChannelWorkflowStepOutputPacket,
  type RunArtifact,
  type RunnerResolutionAudit,
  type RunSession,
  type RunStore,
  type WorkflowPacketSourceRef,
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
  const existing = input.step.metadata?.contextArtifactId ? existingPacketArtifact(input.store, input.step.metadata.contextArtifactId) : undefined;
  if (existing) {
    return existing;
  }
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
  const existing = input.step.metadata?.outputArtifactId ? existingPacketArtifact(input.store, input.step.metadata.outputArtifactId) : undefined;
  if (existing) {
    return existing;
  }
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
  const graphId = input.step.metadata?.graphId ?? input.workflow.metadata?.workflowGraphId;
  const graphNodeId = input.step.metadata?.graphNodeId ?? input.step.metadata?.templateStepId;
  return omitUndefined({
    schemaVersion: 1 as const,
    workflowId: input.workflow.id,
    workflowStepId: input.step.id,
    graphId,
    graphNodeId,
    teammateId: input.step.toParticipantId,
    skillId: input.step.metadata?.skillId,
    objective: input.workflow.objective,
    stepTitle: input.step.title,
    stepPrompt: input.step.prompt,
    dependencies: dependencyRefs,
    priorOutputArtifactIds: uniqueStrings(dependencyRefs.flatMap((ref) => [
      ref.outputArtifactId,
      ...ref.artifactIds,
    ])),
    sourceRefs: buildWorkflowPacketSourceRefs(input),
    selectorDecisionIds: input.step.metadata?.selectorDecisionIds,
    handoffIntentIds: input.step.metadata?.handoffIntentIds,
    requestedRunnerId: runnerAudit?.requestedRunnerId ?? input.runRequest.runnerId,
    effectiveRunnerId: runnerAudit?.effectiveRunnerId,
    providerPresetId: input.runRequest.providerPresetId ?? input.run.providerPresetId,
    approvalGate: input.step.metadata?.approvalGate,
    contextPack: input.runRequest.contextPack,
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
  const artifacts = input.store.listArtifacts(input.run.id);
  const graphId = input.step.metadata?.graphId ?? input.workflow.metadata?.workflowGraphId;
  const graphNodeId = input.step.metadata?.graphNodeId ?? input.step.metadata?.templateStepId;
  return omitUndefined({
    schemaVersion: 1 as const,
    workflowId: input.workflow.id,
    workflowStepId: input.step.id,
    runId: input.run.id,
    graphId,
    graphNodeId,
    teammateId: input.step.toParticipantId,
    skillId: input.step.metadata?.skillId,
    status: input.step.status,
    resultSummary: input.step.resultSummary ?? input.run.errorMessage,
    artifactIds: artifacts.map((artifact) => artifact.id),
    blockers: uniqueStrings([input.step.blocker, input.run.errorMessage ?? undefined]),
    changedPaths: extractWorkflowStepChangedPaths({ artifacts }),
    sourceRefs: buildWorkflowPacketSourceRefs(input),
    selectorDecisionIds: input.step.metadata?.selectorDecisionIds,
    handoffIntentIds: input.step.metadata?.handoffIntentIds,
    runnerAudit: readRunnerAudit(input.run),
    generatedAt: input.now,
  });
}

export function buildWorkflowPacketSourceRefs(input: {
  readonly store: RunStore;
  readonly workflow: ChannelWorkflow;
  readonly step: ChannelWorkflowStep;
  readonly run?: RunSession;
}): readonly WorkflowPacketSourceRef[] {
  const refs: WorkflowPacketSourceRef[] = [
    { type: "workflow", id: input.workflow.id, label: input.workflow.title },
    { type: "workflow_step", id: input.step.id, label: input.step.title },
  ];
  if (input.step.contextSummaryId) {
    const summary = input.store.getChannelContextSummary(input.step.contextSummaryId);
    refs.push({ type: "context_summary", id: input.step.contextSummaryId, label: summary?.summary });
  }
  const taskId = input.step.taskId ?? input.run?.taskId;
  if (taskId) {
    const task = input.store.getTask(taskId);
    refs.push({ type: "task", id: taskId, label: task?.title });
  }
  if (input.run) {
    refs.push({ type: "run", id: input.run.id, label: readRunTitle(input.run) });
    for (const artifact of input.store.listArtifacts(input.run.id)) {
      refs.push({ type: "artifact", id: artifact.id, label: artifact.title ?? artifact.path });
    }
  }
  for (const decisionId of input.step.metadata?.selectorDecisionIds ?? []) {
    const decision = input.store.getWorkflowSelectorDecision(decisionId);
    refs.push({ type: "workflow_selector_decision", id: decisionId, label: decision?.reason });
  }
  for (const intentId of input.step.metadata?.handoffIntentIds ?? []) {
    const intent = input.store.getWorkflowHandoffIntent(intentId);
    refs.push({ type: "workflow_handoff_intent", id: intentId, label: intent?.reason });
  }
  return uniqueSourceRefs(refs);
}

export function readWorkflowStepContextPacketArtifact(input: {
  readonly store: RunStore;
  readonly artifactId: string;
}): ChannelWorkflowStepContextPacket | undefined {
  const packet = readWorkflowStepPacketArtifact(input.store, input.artifactId);
  if (!isRecord(packet) || packet.schemaVersion !== 1 || typeof packet.workflowId !== "string" || typeof packet.workflowStepId !== "string") {
    return undefined;
  }
  return packet as unknown as ChannelWorkflowStepContextPacket;
}

export function readWorkflowStepOutputPacketArtifact(input: {
  readonly store: RunStore;
  readonly artifactId: string;
}): ChannelWorkflowStepOutputPacket | undefined {
  const packet = readWorkflowStepPacketArtifact(input.store, input.artifactId);
  if (!isRecord(packet) || packet.schemaVersion !== 1 || typeof packet.workflowId !== "string" || typeof packet.workflowStepId !== "string") {
    return undefined;
  }
  return packet as unknown as ChannelWorkflowStepOutputPacket;
}

export function extractWorkflowStepChangedPaths(input: {
  readonly artifacts: readonly RunArtifact[];
}): readonly string[] {
  return uniqueStrings(input.artifacts
    .filter((artifact) => artifact.type === "file" || artifact.type === "diff")
    .map((artifact) => artifact.path)
    .filter((path) => !path.startsWith("workflows/")));
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
    branchGroupId: step.metadata?.branchGroupId,
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

function existingPacketArtifact(store: RunStore, artifactId: string): RunArtifact | undefined {
  const artifact = store.getArtifact(artifactId);
  if (!artifact) {
    return undefined;
  }
  return artifactPathExists(store, artifact) ? artifact : undefined;
}

function readWorkflowStepPacketArtifact(store: RunStore, artifactId: string): unknown {
  const artifact = existingPacketArtifact(store, artifactId);
  if (!artifact) {
    return undefined;
  }
  try {
    const content = readFileSync(resolveArtifactContentPath(store, artifact), "utf8");
    return JSON.parse(content) as unknown;
  } catch {
    return undefined;
  }
}

function artifactPathExists(store: RunStore, artifact: RunArtifact): boolean {
  try {
    return existsSync(resolveArtifactContentPath(store, artifact));
  } catch {
    return false;
  }
}

function resolveArtifactContentPath(store: RunStore, artifact: RunArtifact): string {
  const artifactRoot = store.paths.artifactsDir;
  const absolutePath = isAbsolute(artifact.path) ? artifact.path : resolvePath(artifactRoot, artifact.path);
  const relativePath = relative(artifactRoot, absolutePath);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`Artifact content path is outside artifact root: ${artifact.path}`);
  }
  return absolutePath;
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

function uniqueSourceRefs(refs: readonly WorkflowPacketSourceRef[]): readonly WorkflowPacketSourceRef[] {
  const seen = new Set<string>();
  const result: WorkflowPacketSourceRef[] = [];
  for (const ref of refs) {
    const key = `${ref.type}:${ref.id}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(omitUndefined(ref));
  }
  return result;
}

function readRunTitle(run: RunSession): string {
  if (typeof run.taskSnapshot === "object" && run.taskSnapshot !== null && "title" in run.taskSnapshot) {
    const title = (run.taskSnapshot as { readonly title?: unknown }).title;
    if (typeof title === "string" && title.trim()) {
      return title.trim();
    }
  }
  return run.taskId || run.id;
}

function omitUndefined<T extends object>(record: T): T {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as T;
}
