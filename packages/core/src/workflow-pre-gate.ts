import { createHash } from "node:crypto";
import type { ApprovalRequest } from "./approval-types.js";
import type { RunStore } from "./run-types.js";
import type { SkillApprovalProfile } from "./skill-types.js";
import { channelWorkflowStepStatuses, type ChannelWorkflowStep, type ChannelWorkflowStepMetadata, type ChannelWorkflowStepStartMode,
  type ChannelWorkflowStepStatus, type WorkflowStepGate } from "./workspace-types.js";
import { workflowStepStartAuthorityBasis, type WorkflowStepStartExpectedBasis,
  type WorkflowStepStartReadStore } from "./workflow-step-start-owner.js";

/** Host-created, frozen admission basis. Mutable progress never enters authorityBasis. */
export interface WorkflowPreGateBasisV1 {
  readonly schemaVersion: 1;
  readonly startNonce: string;
  readonly authorityBasis: string;
  readonly requestedStatus: ChannelWorkflowStepStatus;
  readonly gateFingerprint: string;
  readonly executionPermit: WorkflowPreGateExecutionPermitV1;
  readonly fingerprint: string;
}
export interface WorkflowPreGateExecutionPermitV1 {
  readonly schemaVersion: 1;
  readonly mode: ChannelWorkflowStepStartMode;
  readonly taskTitle: string;
  readonly taskPrompt: string;
  readonly providerPresetId?: string;
  readonly runnerId?: string;
  readonly assigneeTeammateId: string;
  readonly skipProviderPreflight: boolean;
  readonly fingerprint: string;
}
export interface WorkflowPreGateMarkerV1 {
  readonly basis: WorkflowPreGateBasisV1;
  readonly consumedByTaskId?: string;
}
export interface WorkflowStepPreApprovalInput {
  readonly workflowStepId: string;
  readonly expected: WorkflowStepStartExpectedBasis;
  readonly executionPermit: WorkflowPreGateExecutionPermitV1;
  readonly now: string;
}
export interface WorkflowStepPreApprovalResolveInput {
  readonly workflowStepId: string;
  readonly approvalId: string;
  readonly actor?: "system" | "local-user";
  readonly now: string;
}
export type WorkflowStepPreApprovalResult =
  | { readonly status: "not_required" }
  | { readonly status: "requested"; readonly approval: ApprovalRequest }
  | { readonly status: "duplicate"; readonly approval: ApprovalRequest }
  | { readonly status: "approved"; readonly approval: ApprovalRequest }
  | { readonly status: "blocked"; readonly code: string; readonly blocker: string; readonly failed: boolean; readonly approval?: ApprovalRequest }
  | { readonly status: "stale" | "invalid"; readonly code: string };
export interface EffectiveWorkflowPreGate {
  readonly approvalProfile: SkillApprovalProfile;
  readonly title: string;
  readonly reason: string;
  readonly fingerprint: string;
}
type PreGateReadStore = WorkflowStepStartReadStore & Pick<RunStore, "getApprovalRequest">;
export type WorkflowPreGateInspection =
  | { readonly status: "not_required" }
  | { readonly status: "required"; readonly gate: EffectiveWorkflowPreGate }
  | { readonly status: "pending"; readonly gate: EffectiveWorkflowPreGate; readonly basis: WorkflowPreGateBasisV1; readonly approval: ApprovalRequest }
  | { readonly status: "approved"; readonly gate: EffectiveWorkflowPreGate; readonly basis: WorkflowPreGateBasisV1; readonly approval: ApprovalRequest }
  | { readonly status: "blocked"; readonly gate: EffectiveWorkflowPreGate; readonly basis: WorkflowPreGateBasisV1; readonly approval: ApprovalRequest; readonly code: string }
  | { readonly status: "stale"; readonly code: string };

/** One exact selector for both stages: absent statuses mean any; an empty array means none. */
export function selectWorkflowStepGate(step: ChannelWorkflowStep, stage: WorkflowStepGate["stage"],
  status: ChannelWorkflowStepStatus): WorkflowStepGate | undefined {
  return step.metadata?.gates?.find(gate => gate.stage === stage && gate.approvalProfile.mode !== "none"
    && (gate.requiredForStatuses === undefined || gate.requiredForStatuses.includes(status)));
}

/** Legacy gates cannot be disabled or weakened by a declarative gate. */
export function effectiveWorkflowPreGate(step: ChannelWorkflowStep, status: ChannelWorkflowStepStatus,
  workflowTitle: string): EffectiveWorkflowPreGate | undefined {
  const legacy = step.metadata?.approvalGate?.mode !== "none" ? step.metadata?.approvalGate : undefined;
  const selected = selectWorkflowStepGate(step, "pre", status);
  if (!legacy && !selected) return undefined;
  const approvalProfile = mergeWorkflowPreApprovalProfiles(legacy, selected?.approvalProfile)!;
  const title = selected?.title ?? `Approve workflow step: ${step.title}`;
  const legacyReason = legacy ? `Approve starting workflow step "${step.title}" for workflow "${workflowTitle}".` : undefined;
  const reason = [legacyReason, selected?.reason].filter(Boolean).join("\n");
  return { approvalProfile, title, reason,
    fingerprint: digest("wpgate1", { legacy, selected, approvalProfile, title, reason }) };
}

/** Conservative mode/risk maximum and requirement union; no override may lower a risk. */
export function mergeWorkflowPreApprovalProfiles(left: SkillApprovalProfile | undefined,
  right: SkillApprovalProfile | undefined): SkillApprovalProfile | undefined {
  if (!left) return right;
  if (!right) return left;
  const modes = { none: 0, standard: 1, strict: 2 } as const;
  const risks = { low: 0, medium: 1, high: 2, critical: 3 } as const;
  const risk = (profile: SkillApprovalProfile) => profile.risk ?? (profile.mode === "strict" ? "high" : "medium");
  const tools = [...new Set([...(left.requiredForTools ?? []), ...(right.requiredForTools ?? [])])];
  const actions = [...new Set([...(left.requiredForActions ?? []), ...(right.requiredForActions ?? [])])];
  return { mode: modes[left.mode] >= modes[right.mode] ? left.mode : right.mode,
    risk: risks[risk(left)] >= risks[risk(right)] ? risk(left) : risk(right),
    requiredForTools: tools.length > 0 ? tools : undefined,
    requiredForActions: actions.length > 0 ? actions : undefined };
}

export function createWorkflowPreGateBasis(input: Omit<WorkflowPreGateBasisV1, "schemaVersion" | "fingerprint">): WorkflowPreGateBasisV1 {
  const basis = { schemaVersion: 1 as const, ...input };
  return { ...basis, fingerprint: digest("wpg1", basis) };
}
export function createWorkflowPreGateExecutionPermit(input: Omit<WorkflowPreGateExecutionPermitV1, "schemaVersion" | "fingerprint">): WorkflowPreGateExecutionPermitV1 {
  const permit = { schemaVersion: 1 as const, ...input };
  return { ...permit, fingerprint: digest("wpgpermit1", permit) };
}
export function isWorkflowPreGateExecutionPermitV1(value: unknown): value is WorkflowPreGateExecutionPermitV1 {
  const v = record(value);
  if (!v || v.schemaVersion !== 1 || (v.mode !== "create_task" && v.mode !== "create_and_run_task")
    || typeof v.taskTitle !== "string" || typeof v.taskPrompt !== "string"
    || (v.providerPresetId !== undefined && typeof v.providerPresetId !== "string")
    || (v.runnerId !== undefined && typeof v.runnerId !== "string")
    || typeof v.assigneeTeammateId !== "string" || v.assigneeTeammateId.length === 0
    || typeof v.skipProviderPreflight !== "boolean"
    || typeof v.fingerprint !== "string"
    || Object.keys(v).some(key => !["schemaVersion", "mode", "taskTitle", "taskPrompt", "providerPresetId", "runnerId",
      "assigneeTeammateId", "skipProviderPreflight", "fingerprint"].includes(key))) return false;
  const { fingerprint, ...permit } = v;
  return fingerprint === digest("wpgpermit1", permit);
}
export function isWorkflowPreGateBasisV1(value: unknown): value is WorkflowPreGateBasisV1 {
  const v = record(value);
  if (!v || v.schemaVersion !== 1 || typeof v.startNonce !== "string" || !v.startNonce
    || typeof v.authorityBasis !== "string" || !/^wso1_[a-f0-9]{64}$/u.test(v.authorityBasis)
    || typeof v.gateFingerprint !== "string" || !/^wpgate1_[a-f0-9]{64}$/u.test(v.gateFingerprint)
    || !isWorkflowPreGateExecutionPermitV1(v.executionPermit)
    || !channelWorkflowStepStatuses.includes(v.requestedStatus as ChannelWorkflowStepStatus)
    || typeof v.fingerprint !== "string" || Object.keys(v).some(key => !["schemaVersion", "startNonce", "authorityBasis", "requestedStatus", "gateFingerprint", "executionPermit", "fingerprint"].includes(key))) return false;
  const { fingerprint, ...basis } = v;
  return fingerprint === digest("wpg1", basis);
}
export function isWorkflowPreGateMarkerV1(value: unknown): value is WorkflowPreGateMarkerV1 {
  const v = record(value);
  return Boolean(v && isWorkflowPreGateBasisV1(v.basis)
    && (v.consumedByTaskId === undefined || typeof v.consumedByTaskId === "string" && v.consumedByTaskId.length > 0)
    && Object.keys(v).every(key => key === "basis" || key === "consumedByTaskId"));
}

/** Read-only fact inspection. An id or an approved boolean alone can never grant admission. */
export function inspectWorkflowPreApproval(store: PreGateReadStore, step: ChannelWorkflowStep, now: string,
  expectedExecutionPermit?: WorkflowPreGateExecutionPermitV1): WorkflowPreGateInspection {
  const workflow = store.getChannelWorkflow(step.workflowId);
  const authorityBasis = workflowStepStartAuthorityBasis(store, step);
  if (!workflow || !authorityBasis || ["succeeded", "failed", "cancelled"].includes(workflow.status)) {
    return { status: "stale", code: "workflow_pre_approval_basis_stale" };
  }
  const marker = step.metadata?.preStepApprovalMarker;
  if (marker !== undefined && !isWorkflowPreGateMarkerV1(marker)) return { status: "stale", code: "workflow_pre_approval_basis_stale" };
  if (marker === undefined && step.metadata?.preStepApprovalId && !step.taskId && !step.runId) {
    return { status: "stale", code: "workflow_pre_approval_basis_stale" };
  }
  const unconsumed = marker && !marker.consumedByTaskId ? marker : undefined;
  const gate = effectiveWorkflowPreGate(step, unconsumed?.basis.requestedStatus ?? step.status, workflow.title);
  if (unconsumed && (unconsumed.basis.authorityBasis !== authorityBasis
    || unconsumed.basis.gateFingerprint !== gate?.fingerprint
    || expectedExecutionPermit && unconsumed.basis.executionPermit.fingerprint !== expectedExecutionPermit.fingerprint)) {
    return { status: "stale", code: "workflow_pre_approval_basis_stale" };
  }
  if (!gate) return { status: "not_required" };
  if (!unconsumed) return { status: "required", gate };
  const approval = step.metadata?.preStepApprovalId ? store.getApprovalRequest(step.metadata.preStepApprovalId) : undefined;
  const basis = unconsumed.basis;
  if (!approval || approval.channelId !== step.channelId || approval.workflowStepId !== step.id
    || approval.actionType !== "workflow_step" || approval.payload.type !== "workflow_step"
    || approval.payload.gateStage !== "pre" || approval.payload.workflowId !== workflow.id
    || approval.payload.workflowStepId !== step.id || !isWorkflowPreGateBasisV1(approval.payload.preGateBasis)
    || approval.payload.preGateBasis.fingerprint !== basis.fingerprint) return { status: "stale", code: "workflow_pre_approval_basis_stale" };
  if (approval.expiresAt && (!Number.isFinite(Date.parse(approval.expiresAt))
    || !Number.isFinite(Date.parse(now)) || Date.parse(approval.expiresAt) <= Date.parse(now))) {
    return { status: "blocked", gate, basis, approval, code: "workflow_pre_approval_expired" };
  }
  if (approval.status === "approved" || approval.status === "pending") return { status: approval.status, gate, basis, approval };
  return { status: "blocked", gate, basis, approval, code: `workflow_pre_approval_${approval.status}` };
}

/** Keep definitions and approval audit pointers, not a previous Task's derived result projection. */
export function workflowStepNewStartMetadata(metadata: ChannelWorkflowStepMetadata = {}): ChannelWorkflowStepMetadata {
  const { startOwner, executionVerification, delegatedOutcome, delegatedOutcomeBasisFingerprint, contextArtifactId,
    outputArtifactId, outputArtifactIds, fanInSummaryArtifactId, fanInContextReviews, resultContextReview, memoryCandidateIds,
    postStepApprovalId, activeGateStage, ...definition } = metadata;
  return { ...definition, ...(activeGateStage === "pre" ? { activeGateStage } : {}) };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function digest(prefix: string, value: unknown): string {
  return `${prefix}_${createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex")}`;
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  const object = record(value);
  return object ? Object.fromEntries(Object.keys(object).sort().filter(key => object[key] !== undefined).map(key => [key, canonical(object[key])])) : value;
}
