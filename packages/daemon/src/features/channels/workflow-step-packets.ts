import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve as resolvePath } from "node:path";
import {
  type ChannelStoreFacet,
  type ChannelWorkflow,
  type ChannelWorkflowStep,
  type ChannelWorkflowStepContextPacket,
  type ChannelWorkflowStepOutputPacket,
  type DelegatedStepRequirementV1,
  type RunArtifact,
  type RunExecutionStoreFacet,
  type RunnerResolutionAudit,
  type RunSession,
  type RunStorePathsFacet,
  type WorkspaceStoreFacet,
  type WorkflowAgentContextStamp,
  type WorkflowPacketSourceRef,
  type WorkflowStepOutputRef,
} from "@ling-stack/core";
import { normalizeArtifactPath } from "../../shared/path.js";
import { isRecord } from "../../shared/validation.js";
import { isWorkflowAgentContextStamp } from "./agent-context-consistency.js";
import type { WorkflowStepContextCompactionSummary } from "./context-compaction.js";
import type { WorkflowStepRunRequest } from "./workflows.js";

type WorkflowStepPacketArtifactStore = RunExecutionStoreFacet & RunStorePathsFacet;
type WorkflowStepPacketDependencyStore = ChannelStoreFacet & RunExecutionStoreFacet;
type WorkflowStepPacketSourceStore = ChannelStoreFacet & RunExecutionStoreFacet & WorkspaceStoreFacet;
type WorkflowStepPacketStore = WorkflowStepPacketArtifactStore & WorkflowStepPacketSourceStore;

export function createWorkflowStepContextArtifact(input: {
  readonly store: WorkflowStepPacketStore;
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
  const compactionArtifacts = createWorkflowStepCompactionArtifacts(input);
  const runRequest = withCompactionArtifactIds(input.runRequest, compactionArtifacts);
  return writeWorkflowStepPacketArtifact({
    store: input.store,
    run: input.run,
    workflowId: input.workflow.id,
    workflowStepId: input.step.id,
    kind: "context",
    title: `Workflow step context: ${input.step.title}`,
    packet: buildWorkflowStepContextPacket({ ...input, runRequest }),
    now: input.now,
  });
}

export function createWorkflowStepOutputArtifact(input: {
  readonly store: WorkflowStepPacketStore;
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

export function prepareDeterministicWorkflowStepOutputArtifact(input: {
  readonly store: WorkflowStepPacketStore;
  readonly workflow: ChannelWorkflow;
  readonly step: ChannelWorkflowStep;
  readonly run: RunSession;
  readonly requirement: DelegatedStepRequirementV1;
  readonly now: string;
}): RunArtifact {
  const events = input.store.listEvents(input.run.id, { limit: 1000 });
  const basis = {
    schemaVersion: 1,
    workflowId: input.workflow.id,
    workflowStepId: input.step.id,
    runId: input.run.id,
    runStatus: input.run.status,
    runUpdatedAt: input.run.updatedAt,
    terminalEventCount: input.store.countEvents(input.run.id),
    terminalEventSeq: events.at(-1)?.seq ?? 0,
    requirementFingerprint: input.requirement.fingerprint,
    dependencyStepIds: [...input.requirement.requiredDependencyStepIds].sort(),
    sourceRefs: buildDeterministicOutputPacketSourceIdentity(input),
  };
  const fingerprint = createHash("sha256").update(JSON.stringify(basis)).digest("hex");
  const artifactId = `artifact_workflow_output_${fingerprint.slice(0, 32)}`;
  const existing = existingPacketArtifact(input.store, artifactId);
  const artifact = existing ?? writeWorkflowStepPacketArtifact({
    store: input.store,
    run: input.run,
    workflowId: input.workflow.id,
    workflowStepId: input.step.id,
    kind: "output",
    artifactId,
    artifactFileName: `output-${fingerprint}.json`,
    title: `Workflow step output: ${input.step.title}`,
    packet: buildWorkflowStepOutputPacket(input),
    now: input.now,
  });
  if (artifact.runId !== input.run.id) {
    throw new Error(`Deterministic workflow output artifact owner mismatch: ${artifact.id}`);
  }
  const packet = readWorkflowStepOutputPacketArtifact({ store: input.store, artifactId: artifact.id });
  if (!packet || packet.workflowId !== input.workflow.id || packet.workflowStepId !== input.step.id
    || packet.runId !== input.run.id || packet.teammateId !== input.step.toParticipantId) {
    throw new Error(`Deterministic workflow output artifact content mismatch: ${artifact.id}`);
  }
  const latestStep = input.store.getChannelWorkflowStep(input.step.id) ?? input.step;
  if (latestStep.runId !== input.run.id) {
    throw new Error(`Deterministic workflow output artifact linked Run changed: ${input.step.id}`);
  }
  if (latestStep.metadata?.outputArtifactId !== artifact.id) {
    input.store.updateChannelWorkflowStep(input.step.id, {
      metadata: {
        ...latestStep.metadata,
        outputArtifactId: artifact.id,
        outputArtifactIds: uniqueStrings([
          artifact.id,
          ...(latestStep.metadata?.outputArtifactIds ?? []),
          ...input.store.listArtifacts(input.run.id).map((candidate) => candidate.id),
        ]),
      },
    }, input.now);
  }
  return artifact;
}

export function buildWorkflowStepContextPacket(input: {
  readonly store: WorkflowStepPacketSourceStore;
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
    agentContext: input.runRequest.contextPack?.agentContext,
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
  readonly store: WorkflowStepPacketStore;
  readonly workflow: ChannelWorkflow;
  readonly step: ChannelWorkflowStep;
  readonly run: RunSession;
  readonly now: string;
}): ChannelWorkflowStepOutputPacket {
  const artifacts = input.store.listArtifacts(input.run.id);
  const contextPacket = input.step.metadata?.contextArtifactId
    ? readWorkflowStepContextPacketArtifact({
        store: input.store,
        artifactId: input.step.metadata.contextArtifactId,
      })
    : undefined;
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
    agentContext: contextPacket?.agentContext ?? readWorkflowAgentContextFromRunSnapshot(input.run),
    selectorDecisionIds: input.step.metadata?.selectorDecisionIds,
    handoffIntentIds: input.step.metadata?.handoffIntentIds,
    runnerAudit: readRunnerAudit(input.run),
    generatedAt: input.now,
  });
}

export function buildWorkflowPacketSourceRefs(input: {
  readonly store: WorkflowStepPacketSourceStore;
  readonly workflow: ChannelWorkflow;
  readonly step: ChannelWorkflowStep;
  readonly run?: RunSession;
}): readonly WorkflowPacketSourceRef[] {
  const refs: WorkflowPacketSourceRef[] = [
    { type: "workflow", id: input.workflow.id, label: input.workflow.title },
    { type: "workflow_step", id: input.step.id, label: input.step.title },
  ];
  for (const dependencyId of input.step.metadata?.dependsOnStepIds ?? []) {
    const dependency = input.store.getChannelWorkflowStep(dependencyId);
    refs.push({ type: "workflow_step", id: dependencyId, label: dependency?.title });
  }
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
  readonly store: WorkflowStepPacketArtifactStore;
  readonly artifactId: string;
}): ChannelWorkflowStepContextPacket | undefined {
  const packet = readWorkflowStepPacketArtifact(input.store, input.artifactId, false);
  if (!isRecord(packet) || packet.schemaVersion !== 1 || typeof packet.workflowId !== "string" || typeof packet.workflowStepId !== "string") {
    return undefined;
  }
  if (packet.agentContext !== undefined && !isWorkflowAgentContextStamp(packet.agentContext)) {
    return undefined;
  }
  return packet as unknown as ChannelWorkflowStepContextPacket;
}

export function readWorkflowStepOutputPacketArtifact(input: {
  readonly store: WorkflowStepPacketArtifactStore;
  readonly artifactId: string;
}): ChannelWorkflowStepOutputPacket | undefined {
  const packet = readWorkflowStepPacketArtifact(input.store, input.artifactId, true);
  if (!isRecord(packet) || packet.schemaVersion !== 1 || typeof packet.workflowId !== "string" || typeof packet.workflowStepId !== "string") {
    return undefined;
  }
  if (packet.agentContext !== undefined && !isWorkflowAgentContextStamp(packet.agentContext)) {
    return undefined;
  }
  return packet as unknown as ChannelWorkflowStepOutputPacket;
}

export function readWorkflowAgentContextFromRunSnapshot(
  run: Pick<RunSession, "requestSnapshot">,
): WorkflowAgentContextStamp | undefined {
  if (!isRecord(run.requestSnapshot)) return undefined;
  const contextPack = run.requestSnapshot.contextPack;
  if (!isRecord(contextPack)) return undefined;
  return isWorkflowAgentContextStamp(contextPack.agentContext)
    ? contextPack.agentContext
    : undefined;
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
  store: WorkflowStepPacketDependencyStore,
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

function buildWorkflowStepOutputRef(store: WorkflowStepPacketDependencyStore, step: ChannelWorkflowStep): WorkflowStepOutputRef {
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
  readonly store: WorkflowStepPacketArtifactStore;
  readonly run: RunSession;
  readonly workflowId: string;
  readonly workflowStepId: string;
  readonly kind: "context" | "output";
  readonly artifactId?: string;
  readonly artifactFileName?: string;
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
  const artifactPath = resolvePath(artifactDir, input.artifactFileName ?? `${input.kind}.json`);
  const content = `${JSON.stringify(input.packet, null, 2)}\n`;
  if (existsSync(artifactPath)) {
    if (readFileSync(artifactPath, "utf8") !== content) {
      throw new Error(`Workflow packet projection content conflict: ${artifactPath}`);
    }
  } else {
    writeFileSync(artifactPath, content, { encoding: "utf8", flag: "wx" });
  }
  const stats = statSync(artifactPath);

  return input.store.createArtifact({
    id: input.artifactId,
    runId: input.run.id,
    type: "json",
    path: normalizeArtifactPath(relative(input.store.paths.artifactsDir, artifactPath)),
    title: input.title,
    contentType: "application/json; charset=utf-8",
    sizeBytes: Number(stats.size),
    ...(input.kind === "output" ? { sealedPayload: input.packet } : {}),
    createdAt: input.now,
  });
}

function buildDeterministicOutputPacketSourceIdentity(input: {
  readonly workflow: ChannelWorkflow;
  readonly step: ChannelWorkflowStep;
  readonly run: RunSession;
  readonly requirement: DelegatedStepRequirementV1;
}): readonly string[] {
  return uniqueStrings([
    `workflow:${input.workflow.id}`,
    `workflow_step:${input.step.id}`,
    `run:${input.run.id}`,
    input.step.taskId ? `task:${input.step.taskId}` : undefined,
    input.step.contextSummaryId ? `context_summary:${input.step.contextSummaryId}` : undefined,
    input.step.metadata?.sourceMessageId ? `conversation_item:${input.step.metadata.sourceMessageId}` : undefined,
    ...input.requirement.requiredDependencyStepIds.map((id) => `workflow_step:${id}`),
  ]).sort();
}

function createWorkflowStepCompactionArtifacts(input: {
  readonly store: WorkflowStepPacketArtifactStore;
  readonly workflow: ChannelWorkflow;
  readonly step: ChannelWorkflowStep;
  readonly run: RunSession;
  readonly runRequest: WorkflowStepRunRequest;
  readonly now: string;
}): readonly RunArtifact[] {
  const summaries = input.runRequest.contextCompactions ?? [];
  if (summaries.length === 0) {
    return [];
  }
  return summaries.map((summary) => writeWorkflowStepCompactionArtifact({
    store: input.store,
    run: input.run,
    workflow: input.workflow,
    step: input.step,
    summary,
    now: input.now,
  }));
}

function writeWorkflowStepCompactionArtifact(input: {
  readonly store: WorkflowStepPacketArtifactStore;
  readonly run: RunSession;
  readonly workflow: ChannelWorkflow;
  readonly step: ChannelWorkflowStep;
  readonly summary: WorkflowStepContextCompactionSummary;
  readonly now: string;
}): RunArtifact {
  const artifactDir = resolvePath(
    input.store.paths.artifactsDir,
    input.run.id,
    "workflows",
    input.workflow.id,
    "steps",
    input.step.id,
    "compactions",
  );
  mkdirSync(artifactDir, { recursive: true });
  const artifactPath = resolvePath(artifactDir, `${input.summary.id}.json`);
  const content = `${JSON.stringify(input.summary, null, 2)}\n`;
  writeFileSync(artifactPath, content, "utf8");
  const stats = statSync(artifactPath);

  return input.store.createArtifact({
    runId: input.run.id,
    type: "json",
    path: normalizeArtifactPath(relative(input.store.paths.artifactsDir, artifactPath)),
    title: `Workflow packet summary: ${input.step.title}`,
    contentType: "application/json; charset=utf-8",
    sizeBytes: Number(stats.size),
    createdAt: input.now,
  });
}

function withCompactionArtifactIds(
  runRequest: WorkflowStepRunRequest,
  artifacts: readonly RunArtifact[],
): WorkflowStepRunRequest {
  if (artifacts.length === 0 || !runRequest.contextPack) {
    return runRequest;
  }
  return {
    ...runRequest,
    contextPack: {
      ...runRequest.contextPack,
      compactionIds: artifacts.map((artifact) => artifact.id),
      sourceRefs: uniqueContextPackSourceRefs([
        ...runRequest.contextPack.sourceRefs,
        ...artifacts.map((artifact) => ({
          type: "artifact" as const,
          id: artifact.id,
          label: artifact.title ?? artifact.path,
        })),
      ]),
    },
  };
}

function uniqueContextPackSourceRefs(
  refs: WorkflowStepRunRequest["contextPack"] extends infer Pack
    ? Pack extends { readonly sourceRefs: infer Refs }
      ? Refs
      : never
    : never,
): WorkflowStepRunRequest["contextPack"] extends infer Pack
  ? Pack extends { readonly sourceRefs: infer Refs }
    ? Refs
    : never
  : never {
  const seen = new Set<string>();
  const unique: { readonly type: string; readonly id: string; readonly label?: string }[] = [];
  for (const ref of refs as readonly { readonly type: string; readonly id: string; readonly label?: string }[]) {
    const key = `${ref.type}:${ref.id}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(ref);
  }
  return unique as WorkflowStepRunRequest["contextPack"] extends infer Pack
    ? Pack extends { readonly sourceRefs: infer Refs }
      ? Refs
      : never
    : never;
}

function existingPacketArtifact(store: WorkflowStepPacketArtifactStore, artifactId: string): RunArtifact | undefined {
  const artifact = store.getArtifact(artifactId);
  if (!artifact) {
    return undefined;
  }
  return sealedArtifactPayloadIsValid(artifact) || artifactPathExists(store, artifact)
    ? artifact
    : undefined;
}

function readWorkflowStepPacketArtifact(
  store: WorkflowStepPacketArtifactStore,
  artifactId: string,
  requireSealedPayload: boolean,
): unknown {
  const artifact = existingPacketArtifact(store, artifactId);
  if (!artifact) {
    return undefined;
  }
  if (sealedArtifactPayloadIsValid(artifact)) {
    return artifact.sealedPayload;
  }
  if (requireSealedPayload) {
    return undefined;
  }
  try {
    const content = readFileSync(resolveArtifactContentPath(store, artifact), "utf8");
    return JSON.parse(content) as unknown;
  } catch {
    return undefined;
  }
}

function sealedArtifactPayloadIsValid(artifact: RunArtifact): boolean {
  if (artifact.sealedPayload === undefined || !artifact.contentSha256) return false;
  return createHash("sha256")
    .update(JSON.stringify(artifact.sealedPayload), "utf8")
    .digest("hex") === artifact.contentSha256;
}

function artifactPathExists(store: WorkflowStepPacketArtifactStore, artifact: RunArtifact): boolean {
  try {
    return existsSync(resolveArtifactContentPath(store, artifact));
  } catch {
    return false;
  }
}

function resolveArtifactContentPath(store: WorkflowStepPacketArtifactStore, artifact: RunArtifact): string {
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
