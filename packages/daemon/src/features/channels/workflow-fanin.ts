import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import {
  type ChannelWorkflow,
  type ChannelWorkflowStep,
  type RunSession,
  type RunStore,
  type WorkflowStepOutputRef,
} from "@ling-stack/core";
import { normalizeArtifactPath } from "../../shared/path.js";
import { readWorkflowStepOutputPacketArtifact } from "./workflow-step-packets.js";

export function maybeCreateWorkflowFanInEvidence(input: {
  readonly store: RunStore;
  readonly workflow: ChannelWorkflow;
  readonly step: ChannelWorkflowStep;
  readonly run: RunSession;
  readonly now: string;
}): ChannelWorkflowStep | undefined {
  const fanInPolicy = input.step.metadata?.fanInPolicy;
  if (!fanInPolicy) {
    return input.step;
  }
  const existingSummaryArtifactId = input.step.metadata?.fanInSummaryArtifactId;
  const existingSummaryArtifact = existingSummaryArtifactId ? input.store.getArtifact(existingSummaryArtifactId) : undefined;
  const dependencyOutputs = collectDependencyOutputs(input.store, input.workflow.id, input.step);
  const summaryArtifact = existingSummaryArtifact ?? (fanInPolicy.createSummaryArtifact
    ? writeFanInSummaryArtifact({
        store: input.store,
        workflow: input.workflow,
        step: input.step,
        run: input.run,
        dependencyOutputs,
        now: input.now,
      })
    : undefined);
  const memoryCandidateIds = fanInPolicy.createMemoryCandidates && summaryArtifact
    ? createFanInMemoryCandidates({
        store: input.store,
        workflow: input.workflow,
        step: input.step,
        run: input.run,
        summaryArtifactId: summaryArtifact.id,
        dependencyOutputs,
        now: input.now,
      })
    : [];
  const latestStep = input.store.getChannelWorkflowStep(input.step.id) ?? input.step;
  return input.store.updateChannelWorkflowStep(
    latestStep.id,
    {
      metadata: {
        ...latestStep.metadata,
        fanInSummaryArtifactId: summaryArtifact?.id ?? latestStep.metadata?.fanInSummaryArtifactId,
        outputArtifactIds: uniqueStrings([
          ...(latestStep.metadata?.outputArtifactIds ?? []),
          summaryArtifact?.id,
        ]),
        memoryCandidateIds: uniqueStrings([
          ...(latestStep.metadata?.memoryCandidateIds ?? []),
          ...memoryCandidateIds,
        ]),
      },
    },
    input.now,
  ) ?? latestStep;
}

function collectDependencyOutputs(
  store: RunStore,
  workflowId: string,
  step: ChannelWorkflowStep,
): readonly WorkflowStepOutputRef[] {
  const stepsById = new Map(store.listChannelWorkflowSteps({ workflowId, limit: 500 }).map((candidate) => [candidate.id, candidate] as const));
  return (step.metadata?.dependsOnStepIds ?? [])
    .map((dependencyId) => stepsById.get(dependencyId))
    .filter((dependency): dependency is ChannelWorkflowStep => Boolean(dependency))
    .map((dependency) => {
      const outputPacket = dependency.metadata?.outputArtifactId
        ? readWorkflowStepOutputPacketArtifact({ store, artifactId: dependency.metadata.outputArtifactId })
        : undefined;
      return {
        workflowStepId: dependency.id,
        runId: dependency.runId,
        status: dependency.status,
        resultSummary: outputPacket?.resultSummary ?? dependency.resultSummary,
        outputArtifactId: dependency.metadata?.outputArtifactId,
        artifactIds: uniqueStrings([
          ...(dependency.metadata?.outputArtifactIds ?? []),
          ...(dependency.runId ? store.listArtifacts(dependency.runId).map((artifact) => artifact.id) : []),
        ]),
        branchGroupId: dependency.metadata?.branchGroupId,
      };
    });
}

function writeFanInSummaryArtifact(input: {
  readonly store: RunStore;
  readonly workflow: ChannelWorkflow;
  readonly step: ChannelWorkflowStep;
  readonly run: RunSession;
  readonly dependencyOutputs: readonly WorkflowStepOutputRef[];
  readonly now: string;
}) {
  const relativePath = normalizeArtifactPath(`workflows/${input.workflow.id}/${input.step.id}-fan-in.md`);
  const absolutePath = resolvePath(input.store.paths.artifactsDir, relativePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  const content = renderFanInSummary(input);
  writeFileSync(absolutePath, content, "utf8");
  return input.store.createArtifact({
    runId: input.run.id,
    type: "markdown",
    path: relativePath,
    title: `Workflow fan-in summary: ${input.step.title}`,
    contentType: "text/markdown",
    sizeBytes: Buffer.byteLength(content),
    createdAt: input.now,
  });
}

function renderFanInSummary(input: {
  readonly workflow: ChannelWorkflow;
  readonly step: ChannelWorkflowStep;
  readonly dependencyOutputs: readonly WorkflowStepOutputRef[];
  readonly now: string;
}): string {
  return [
    `# Fan-in summary: ${input.step.title}`,
    "",
    `Workflow: ${input.workflow.title}`,
    `Generated: ${input.now}`,
    "",
    "## Dependency outputs",
    "",
    ...input.dependencyOutputs.flatMap((output) => [
      `- Step: ${output.workflowStepId}`,
      `  - Status: ${output.status}`,
      `  - Run: ${output.runId ?? "none"}`,
      `  - Summary: ${output.resultSummary ?? "No summary captured."}`,
      `  - Artifacts: ${output.artifactIds.length}`,
    ]),
  ].join("\n");
}

function createFanInMemoryCandidates(input: {
  readonly store: RunStore;
  readonly workflow: ChannelWorkflow;
  readonly step: ChannelWorkflowStep;
  readonly run: RunSession;
  readonly summaryArtifactId: string;
  readonly dependencyOutputs: readonly WorkflowStepOutputRef[];
  readonly now: string;
}): readonly string[] {
  const policy = input.step.metadata?.fanInPolicy;
  if (!policy) {
    return [];
  }
  const ownerId = policy.memoryCandidateScope === "channel"
    ? input.workflow.channelId
    : policy.memoryCandidateScope === "task"
      ? input.run.taskId
      : input.run.id;
  const sourceArtifactIds = uniqueStrings([
    input.summaryArtifactId,
    ...input.dependencyOutputs.flatMap((output) => [output.outputArtifactId, ...output.artifactIds]),
  ]).slice(0, policy.maxInputArtifacts);
  const existing = input.store.listMemoryObjects({ workspaceId: input.workflow.workspaceId, reviewState: "candidate", limit: 500 })
    .filter((memory) => memory.sourceRefs.some((ref) => ref.id === input.summaryArtifactId));
  if (existing.length > 0) {
    return existing.map((memory) => memory.id);
  }
  const memory = input.store.createMemoryObject(
    {
      workspaceId: input.workflow.workspaceId,
      scopeType: policy.memoryCandidateScope,
      ownerId,
      title: `Workflow lesson: ${input.workflow.title}`,
      body: `Fan-in completed for "${input.step.title}" with ${input.dependencyOutputs.length} dependency outputs. Review before using this as active memory.`,
      tags: ["workflow-fan-in", input.step.title],
      sourceRefs: sourceArtifactIds.map((artifactId) => ({ type: "artifact", id: artifactId, label: "Workflow fan-in evidence" })),
      reviewState: "candidate",
      enabled: true,
      verifyBeforeUse: true,
      createdBy: "workflow-fan-in",
    },
    input.now,
  );
  return [memory.id];
}

function uniqueStrings(values: readonly (string | undefined)[]): readonly string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value && value.trim().length > 0)))];
}
