import { createHash } from "node:crypto";
import {
  workflowCompletionBasisFingerprintV1,
  type ChannelIntentDecisionV2,
} from "@ling-stack/contracts";
import type { ApprovalRequest } from "./approval-types.js";
import type { RunArtifact, RunSession, RunStore } from "./run-types.js";
import type { ChannelWorkflow, ChannelWorkflowStep } from "./workspace-types.js";

export interface WorkflowCompletionDerivedEvidenceV1 {
  readonly executionActionProjectionFingerprint: string;
  readonly referencedActionIds: readonly string[];
}

export interface WorkflowCompletionExpectedReadSetV1 {
  readonly schemaVersion: 1;
  readonly workflow: WorkflowCompletionEntityReadV1;
  readonly sourceDecision: WorkflowCompletionOptionalEntityReadV1;
  readonly steps: readonly WorkflowCompletionStepReadV1[];
  readonly runs: readonly WorkflowCompletionRunReadV1[];
  readonly approvals: readonly WorkflowCompletionApprovalReadV1[];
  readonly artifacts: readonly WorkflowCompletionArtifactReadV1[];
  readonly canonicalFingerprint: string;
  readonly derivedEvidence: WorkflowCompletionDerivedEvidenceV1;
}

export interface WorkflowCompletionEvaluationV1 {
  readonly gate: import("@ling-stack/contracts").WorkflowCompletionGateV1;
  readonly expectedReadSet: WorkflowCompletionExpectedReadSetV1;
}

export interface WorkflowCompletionEntityReadV1 {
  readonly id: string;
  readonly status: string;
  readonly updatedAt: string;
  readonly semanticFingerprint: string;
}

export type WorkflowCompletionOptionalEntityReadV1 =
  | { readonly id?: string; readonly present: false }
  | (WorkflowCompletionEntityReadV1 & { readonly present: true });

export interface WorkflowCompletionStepReadV1 extends WorkflowCompletionEntityReadV1 {
  readonly runId?: string;
  readonly delegatedRequirementFingerprint?: string;
  readonly delegatedOutcomeBasisFingerprint?: string;
  readonly outputArtifactId?: string;
}

export type WorkflowCompletionRunReadV1 =
  | { readonly id: string; readonly present: false }
  | (WorkflowCompletionEntityReadV1 & {
      readonly present: true;
      readonly eventCount: number;
      readonly latestEventSeq: number;
    });

export interface WorkflowCompletionApprovalReadV1 {
  readonly id: string;
  readonly status: string;
  readonly resolvedAt?: string;
  readonly semanticFingerprint: string;
}

export interface WorkflowCompletionArtifactReadV1 {
  readonly id: string;
  readonly runId?: string;
  readonly path: string;
  readonly sizeBytes?: number;
  readonly createdAt: string;
  readonly contentSha256?: string;
  readonly sealedPayloadFingerprint?: string;
  readonly sealedPayloadValid: boolean;
  readonly semanticFingerprint: string;
}

type WorkflowCompletionReadStore = Pick<RunStore,
  | "getChannelIntentDecision"
  | "getRun"
  | "listEvents"
  | "countEvents"
  | "listApprovalRequests"
  | "getArtifact"
  | "listArtifacts"
>;

export function buildWorkflowCompletionExpectedReadSet(input: {
  readonly store: WorkflowCompletionReadStore;
  readonly workflow: ChannelWorkflow;
  readonly steps: readonly ChannelWorkflowStep[];
  readonly derivedEvidence: WorkflowCompletionDerivedEvidenceV1;
}): WorkflowCompletionExpectedReadSetV1 {
  const sourceDecisionId = input.workflow.metadata?.sourceIntentDecisionId;
  const sourceDecision = sourceDecisionId
    ? input.store.getChannelIntentDecision(sourceDecisionId)
    : undefined;
  const runIds = uniqueSorted(input.steps.flatMap((step) => step.runId ? [step.runId] : []));
  const runs = runIds.map((runId) => runRead(input.store, runId));
  const approvals = collectApprovals(input.store, input.steps, runIds)
    .map(approvalRead)
    .sort(byId);
  const artifacts = collectArtifacts(input.store, input.steps, runIds)
    .map(artifactRead)
    .sort(byId);
  const canonical = {
    schemaVersion: 1 as const,
    workflow: entityRead(input.workflow),
    sourceDecision: sourceDecisionRead(sourceDecisionId, sourceDecision),
    steps: [...input.steps].sort(byId).map(stepRead),
    runs,
    approvals,
    artifacts,
  };
  return {
    ...canonical,
    canonicalFingerprint: workflowCompletionReadSetFingerprintV1(canonical),
    derivedEvidence: {
      executionActionProjectionFingerprint: input.derivedEvidence.executionActionProjectionFingerprint,
      referencedActionIds: uniqueSorted(input.derivedEvidence.referencedActionIds),
    },
  };
}

export function workflowCompletionReadSetFingerprintV1(value: unknown): string {
  return workflowCompletionBasisFingerprintV1({ kind: "workflow_completion_read_set_v1", value });
}

export function sealedArtifactPayloadFingerprintV1(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function entityRead(entity: ChannelWorkflow): WorkflowCompletionEntityReadV1 {
  return {
    id: entity.id,
    status: entity.status,
    updatedAt: entity.updatedAt,
    semanticFingerprint: semanticFingerprint("workflow", entity),
  };
}

function sourceDecisionRead(
  id: string | undefined,
  decision: ChannelIntentDecisionV2 | undefined,
): WorkflowCompletionOptionalEntityReadV1 {
  if (!decision) return { ...(id ? { id } : {}), present: false };
  return {
    id: decision.id,
    present: true,
    status: decision.status,
    updatedAt: decision.updatedAt,
    semanticFingerprint: semanticFingerprint("source_decision", decision),
  };
}

function stepRead(step: ChannelWorkflowStep): WorkflowCompletionStepReadV1 {
  return omitUndefined({
    id: step.id,
    status: step.status,
    updatedAt: step.updatedAt,
    semanticFingerprint: semanticFingerprint("workflow_step", step),
    runId: step.runId,
    delegatedRequirementFingerprint: step.metadata?.delegatedRequirement?.fingerprint,
    delegatedOutcomeBasisFingerprint: step.metadata?.delegatedOutcomeBasisFingerprint,
    outputArtifactId: step.metadata?.outputArtifactId,
  });
}

function runRead(store: WorkflowCompletionReadStore, runId: string): WorkflowCompletionRunReadV1 {
  const run = store.getRun(runId);
  if (!run) return { id: runId, present: false };
  const eventCount = store.countEvents(runId);
  const latestEventSeq = readLatestEventSeq(store, runId);
  return {
    id: run.id,
    present: true,
    status: run.status,
    updatedAt: run.updatedAt,
    semanticFingerprint: semanticFingerprint("run", run),
    eventCount,
    latestEventSeq,
  };
}

function readLatestEventSeq(store: WorkflowCompletionReadStore, runId: string): number {
  let afterSeq = 0;
  while (true) {
    const events = store.listEvents(runId, { afterSeq, limit: 1000 });
    if (events.length === 0) return afterSeq;
    const latest = events.at(-1)?.seq ?? afterSeq;
    if (latest <= afterSeq) {
      throw new Error(`Run event pagination did not advance: ${runId}`);
    }
    afterSeq = latest;
    if (events.length < 1000) return afterSeq;
  }
}

function approvalRead(approval: ApprovalRequest): WorkflowCompletionApprovalReadV1 {
  return omitUndefined({
    id: approval.id,
    status: approval.status,
    resolvedAt: approval.resolvedAt,
    semanticFingerprint: semanticFingerprint("approval", approval),
  });
}

function artifactRead(artifact: RunArtifact): WorkflowCompletionArtifactReadV1 {
  const sealedPayloadFingerprint = artifact.sealedPayload === undefined
    ? undefined
    : sealedArtifactPayloadFingerprintV1(artifact.sealedPayload);
  return omitUndefined({
    id: artifact.id,
    runId: artifact.runId,
    path: artifact.path,
    sizeBytes: artifact.sizeBytes,
    createdAt: artifact.createdAt,
    contentSha256: artifact.contentSha256,
    sealedPayloadFingerprint,
    sealedPayloadValid: sealedPayloadFingerprint !== undefined
      && sealedPayloadFingerprint === artifact.contentSha256,
    semanticFingerprint: semanticFingerprint("artifact", artifact),
  });
}

function collectApprovals(
  store: WorkflowCompletionReadStore,
  steps: readonly ChannelWorkflowStep[],
  runIds: readonly string[],
): ApprovalRequest[] {
  const byId = new Map<string, ApprovalRequest>();
  for (const runId of runIds) {
    for (const approval of store.listApprovalRequests({ runId, limit: 500 })) byId.set(approval.id, approval);
  }
  for (const step of steps) {
    for (const approval of store.listApprovalRequests({ workflowStepId: step.id, limit: 500 })) byId.set(approval.id, approval);
  }
  return [...byId.values()];
}

function collectArtifacts(
  store: WorkflowCompletionReadStore,
  steps: readonly ChannelWorkflowStep[],
  runIds: readonly string[],
): RunArtifact[] {
  const byId = new Map<string, RunArtifact>();
  for (const runId of runIds) {
    for (const artifact of store.listArtifacts(runId)) byId.set(artifact.id, artifact);
  }
  for (const step of steps) {
    const artifactId = step.metadata?.outputArtifactId;
    const artifact = artifactId ? store.getArtifact(artifactId) : undefined;
    if (artifact) byId.set(artifact.id, artifact);
  }
  return [...byId.values()];
}

function semanticFingerprint(kind: string, value: unknown): string {
  return workflowCompletionBasisFingerprintV1({ kind, value });
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function byId<T extends { readonly id: string }>(left: T, right: T): number {
  return left.id.localeCompare(right.id);
}

function omitUndefined<T extends object>(record: T): T {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as T;
}
