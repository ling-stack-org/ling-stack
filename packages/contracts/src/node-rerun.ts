import type { RunStatus } from "./shared.js";
import type { WorkUnitAttemptStatus } from "./runtime.js";

export const NODE_RERUN_INTENT_SCHEMA_VERSION = 1 as const;
export const NODE_RERUN_HOST_ADMISSION_PLAN_SCHEMA_VERSION = 1 as const;

export type NodeRerunTerminalRunStatus = "succeeded" | "failed" | "cancelled";
export type NodeRerunAttemptStatus = NodeRerunTerminalRunStatus | "lost";
export type NodeRerunRunLifecycle = "ended" | "active" | "unknown";
export type NodeRerunStopStatus = "not_required" | "confirmed" | "unconfirmed" | "unknown";
export type NodeRerunLeaseStatus = "none" | "expired" | "active" | "unknown";
export type NodeRerunFenceStatus = "released" | "active" | "unknown";
export type NodeRerunEffectStatus = "none" | "settled" | "pending" | "unknown";
export type NodeRerunExternalEffectStatus = "none" | "settled_idempotent" | "pending" | "non_idempotent" | "unknown";
export type NodeRerunPermissionStatus = "current" | "expired" | "revoked" | "unknown";

export const NODE_RERUN_BLOCKER_CODES = [
  "invalid_intent",
  "invalid_observation",
  "source_identity_mismatch",
  "source_run_not_terminal",
  "source_attempt_not_stopped",
  "source_lease_active",
  "source_fence_active",
  "source_effect_unconfirmed",
  "external_effect_not_replayable",
  "dependency_closure_incomplete",
  "dependency_evidence_missing",
  "policy_unavailable",
  "policy_drift",
  "permission_not_current",
  "target_identity_not_host_minted",
  "target_fence_not_host_minted",
  "target_approval_not_fresh",
] as const;
export type NodeRerunBlockerCode = (typeof NODE_RERUN_BLOCKER_CODES)[number];

export interface NodeRerunArtifactPinV1 {
  readonly artifactId: string;
  readonly contentSha256: string;
}

export interface NodeRerunDependencyPinV1 {
  readonly nodeId: string;
  readonly nodeVersionDigest: string;
  readonly inputArtifact: NodeRerunArtifactPinV1;
  readonly outputArtifacts: readonly NodeRerunArtifactPinV1[];
  readonly permissionFingerprint: string;
}

export interface NodeRerunDependencyClosureV1 {
  /** The Host has enumerated the complete upstream and downstream dependency set. */
  readonly complete: boolean;
  readonly upstream: readonly NodeRerunDependencyPinV1[];
  /** May be empty for a leaf node, but must still be present and complete. */
  readonly downstreamNodeIds: readonly string[];
}

export interface NodeRerunSourceRefV1 {
  readonly runId: string;
  readonly attemptId: string;
  readonly nodeId: string;
  readonly graphVersionDigest: string;
  readonly inputArtifact: NodeRerunArtifactPinV1;
  readonly dependencyClosure: NodeRerunDependencyClosureV1;
  /** Digest of the immutable source Run/Attempt/node projection used by the intent. */
  readonly sourceSnapshotDigest: string;
}

export interface NodeRerunTargetContractV1 {
  readonly executionIdentity: "host_minted";
  readonly fence: "host_minted";
  readonly approval: "fresh_current_policy";
  /** Graph edits are a separate contract and cannot be smuggled into a node rerun. */
  readonly graphMutation: "none";
}

export interface NodeRerunIntentV1 {
  readonly schemaVersion: typeof NODE_RERUN_INTENT_SCHEMA_VERSION;
  readonly kind: "node_rerun_intent";
  readonly intentId: string;
  readonly source: NodeRerunSourceRefV1;
  readonly target: NodeRerunTargetContractV1;
  readonly requestedBy: "local-user" | "system";
  readonly idempotencyKey: string;
  readonly createdAt: string;
}

export interface NodeRerunObservedSourceV1 {
  readonly source: NodeRerunSourceRefV1;
  readonly runStatus: RunStatus;
  readonly runLifecycle: NodeRerunRunLifecycle;
  readonly attemptStatus: WorkUnitAttemptStatus;
  readonly stopStatus: NodeRerunStopStatus;
  readonly leaseStatus: NodeRerunLeaseStatus;
  readonly fenceStatus: NodeRerunFenceStatus;
  readonly effectStatus: NodeRerunEffectStatus;
  readonly externalEffectStatus: NodeRerunExternalEffectStatus;
  readonly sourcePolicyFingerprint: string | null;
  readonly currentPolicyFingerprint: string | null;
  readonly currentPolicyAvailable: boolean;
  readonly permissionStatus: NodeRerunPermissionStatus;
}

export interface NodeRerunAdmissionInput {
  readonly intent: unknown;
  readonly observed: unknown;
}

export interface NodeRerunAdmissionResult {
  readonly schemaVersion: typeof NODE_RERUN_INTENT_SCHEMA_VERSION;
  readonly kind: "node_rerun_admission";
  readonly decision: "eligible_for_host_admission" | "blocked";
  /** This contract never grants execution authority. */
  readonly executionAuthorized: false;
  readonly intentId: string | null;
  readonly source: {
    readonly runId: string | null;
    readonly attemptId: string | null;
    readonly nodeId: string | null;
  } | null;
  readonly blockers: readonly NodeRerunBlockerCode[];
  readonly nextStep: "host_must_revalidate_and_mint_identity" | "manual_review_required";
}

export interface NodeRerunHostAdmissionPlanV1 {
  readonly schemaVersion: typeof NODE_RERUN_HOST_ADMISSION_PLAN_SCHEMA_VERSION;
  readonly kind: "node_rerun_host_admission_plan";
  /** Deterministic identity for the read-only plan; it is not a persisted execution identity. */
  readonly planId: string;
  readonly planFingerprint: string;
  readonly intentId: string;
  readonly idempotencyKey: string;
  readonly source: NodeRerunSourceRefV1;
  readonly sourcePolicyFingerprint: string;
  readonly currentPolicyFingerprint: string;
  readonly actions: {
    readonly workUnit: "host_minted";
    readonly run: "host_minted";
    readonly attempt: "host_minted";
    readonly fence: "host_minted";
    readonly approval: "fresh_current_policy";
    readonly graphMutation: "none";
    readonly providerDispatch: "disabled";
  };
  readonly preconditions: {
    readonly sourceSnapshotDigest: string;
    readonly policyFingerprint: string;
    readonly idempotencyKey: string;
    readonly revalidateBeforeWrite: true;
  };
}

export interface NodeRerunHostAdmissionPlanInputV1 {
  readonly intent: NodeRerunIntentV1;
  readonly observed: NodeRerunObservedSourceV1;
  readonly admission: NodeRerunAdmissionResult;
}

export interface NodeRerunHostAdmissionResponseV1 {
  readonly schemaVersion: typeof NODE_RERUN_HOST_ADMISSION_PLAN_SCHEMA_VERSION;
  readonly kind: "node_rerun_host_admission_response";
  readonly runId: string;
  readonly admission: NodeRerunAdmissionResult;
  readonly evaluationInvoked: boolean;
  readonly plan: NodeRerunHostAdmissionPlanV1 | null;
}

export interface NodeRerunIntentSubmissionV1 {
  readonly intent: NodeRerunIntentV1;
  readonly planFingerprint: string;
}

export interface NodeRerunPreparedIntentV1 extends NodeRerunIntentSubmissionV1 {
  readonly schemaVersion: 1;
  readonly kind: "node_rerun_prepared_intent";
  readonly id: string;
  readonly workspaceId: string;
  readonly status: "prepared";
  readonly policyFingerprint: string;
  readonly preparedAt: string;
  readonly executionAuthorized: false;
}

export interface NodeRerunIntentResponseV1 {
  readonly schemaVersion: 1;
  readonly kind: "node_rerun_intent_response";
  readonly record: NodeRerunPreparedIntentV1;
  readonly executionAuthorized: false;
}

/** Frozen consent for one Host-minted generation; never an execution permit. */
export interface NodeRerunApprovalPayloadV1 extends NodeRerunIntentSubmissionV1 {
  readonly schemaVersion: 1;
  readonly type: "node_rerun";
  readonly nodeRerunIntentId: string;
  readonly generationId: string;
  readonly policyFingerprint: string;
  readonly expiresAt: string;
  readonly fingerprint: string;
}

export interface NodeRerunApprovalResponseV1 {
  readonly schemaVersion: 1;
  readonly kind: "node_rerun_approval_response";
  readonly record: NodeRerunPreparedIntentV1;
  readonly approval: import("./approvals.js").ApprovalRequest;
  readonly executionAuthorized: false;
}

/** Durable preparation receipt; dispatch still requires the dedicated Host admission boundary. */
export interface NodeRerunPreparedTargetV1 {
  readonly schemaVersion: 1;
  readonly kind: "node_rerun_prepared_target";
  readonly recordId: string;
  readonly workspaceId: string;
  readonly generationId: string;
  readonly approvalId: string;
  readonly source: NodeRerunSourceRefV1;
  readonly runId: string;
  readonly taskId: string;
  readonly fence: import("./runtime.js").RuntimeAttemptFenceV1;
  readonly frozenExecutionDigest: string;
  readonly preparedAt: string;
  readonly executionAuthorized: false;
}

export interface NodeRerunTargetResponseV1 {
  readonly schemaVersion: 1;
  readonly kind: "node_rerun_target_response";
  readonly target: NodeRerunPreparedTargetV1;
  readonly executionAuthorized: false;
}

/** Receipt returned after the dedicated Host receiver consumes a target gate. */
export interface NodeRerunTargetDispatchResponseV1 {
  readonly schemaVersion: 1;
  readonly kind: "node_rerun_target_dispatch_response";
  readonly target: NodeRerunPreparedTargetV1;
  readonly runId: string;
  readonly dispatchStatus: "dispatched" | "already_dispatched";
  readonly executionAuthorized: true;
}

/** A generation-scoped dependency view rebuilt from durable preparation evidence. */
export interface NodeRerunGenerationProjectionV1 {
  readonly schemaVersion: 1;
  readonly kind: "node_rerun_generation_projection";
  readonly recordId: string;
  readonly workspaceId: string;
  readonly generationId: string;
  readonly approvalId: string;
  readonly graphVersionDigest: string;
  readonly source: {
    readonly runId: string;
    readonly attemptId: string;
    readonly nodeId: string;
    readonly sourceSnapshotDigest: string;
  };
  readonly replacement: {
    readonly nodeId: string;
    readonly runId: string;
    readonly taskId: string;
    readonly fence: import("./runtime.js").RuntimeAttemptFenceV1;
    readonly frozenExecutionDigest: string;
  };
  readonly reusedUpstream: readonly NodeRerunDependencyPinV1[];
  readonly invalidatedDownstream: readonly {
    readonly nodeId: string;
    readonly status: "invalidated";
    readonly executionAuthorized: false;
  }[];
  readonly preparedAt: string;
  readonly evidenceBasis: "frozen_target_preparation";
  readonly revalidateBeforeExecution: true;
  readonly graphMutation: "none";
  readonly downstreamDispatch: "disabled";
  readonly executionAuthorized: false;
}

export interface NodeRerunGenerationResponseV1 {
  readonly schemaVersion: 1;
  readonly kind: "node_rerun_generation_response";
  readonly generation: NodeRerunGenerationProjectionV1;
  readonly executionAuthorized: false;
}

/** Exact-fence cancellation receipt for a target that never entered execution. */
export interface NodeRerunTargetCancellationV1 {
  readonly schemaVersion: 1;
  readonly kind: "node_rerun_target_cancellation";
  readonly recordId: string;
  readonly generationId: string;
  readonly runId: string;
  readonly fence: import("./runtime.js").RuntimeAttemptFenceV1;
  readonly releasedAt: string;
  readonly stopEvidence: "never_dispatched";
  readonly executionAuthorized: false;
}

export interface NodeRerunTargetCancellationResponseV1 {
  readonly schemaVersion: 1;
  readonly kind: "node_rerun_target_cancellation_response";
  readonly cancellation: NodeRerunTargetCancellationV1;
  readonly executionAuthorized: false;
}

/** Response after an already-dispatched target enters its exact-fence stop boundary. */
export interface NodeRerunTargetStopResponseV1 {
  readonly schemaVersion: 1;
  readonly kind: "node_rerun_target_stop_response";
  readonly target: NodeRerunPreparedTargetV1;
  readonly runId: string;
  readonly stopStatus: "requested" | "already_requested" | "awaiting_recovery";
  readonly executionAuthorized: false;
}

export type NodeRerunTargetReadinessBlockerCode = "target_released" | "target_not_pristine"
  | "approval_not_current" | "runtime_changed" | "source_not_current" | "source_plan_changed"
  | "frozen_execution_unavailable" | "local_execution_unconfirmed";

/** Current preconditions for resource admission; the observation cannot authorize dispatch. */
export interface NodeRerunTargetReadinessV1 {
  readonly schemaVersion: 1;
  readonly kind: "node_rerun_target_readiness";
  readonly target: NodeRerunPreparedTargetV1;
  readonly observedAt: string;
  readonly decision: "eligible_for_resource_admission" | "blocked";
  readonly blockers: readonly NodeRerunTargetReadinessBlockerCode[];
  readonly revalidateBeforeDispatch: true;
  readonly executionAuthorized: false;
}

export interface NodeRerunTargetReadinessResponseV1 {
  readonly schemaVersion: 1;
  readonly kind: "node_rerun_target_readiness_response";
  readonly readiness: NodeRerunTargetReadinessV1;
  readonly executionAuthorized: false;
}

export class NodeRerunValidationError extends Error {
  readonly code = "node_rerun_invalid" as const;

  constructor(message: string) {
    super(message);
    this.name = "NodeRerunValidationError";
  }
}

function invalid(message: string): never {
  throw new NodeRerunValidationError(message);
}

function record(value: unknown, keys: readonly string[], path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${path}: expected an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid(`${path}: expected a plain object`);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some(key => typeof key !== "string" || !keys.includes(key))) invalid(`${path}: unknown field`);
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const rawKey of ownKeys) {
    if (typeof rawKey !== "string") invalid(`${path}: unknown field`);
    const key = rawKey;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) invalid(`${path}.${key}: accessors are not allowed`);
    output[key] = descriptor.value;
  }
  return output;
}

function array(value: unknown, path: string, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) {
    invalid(`${path}: expected a bounded array`);
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== value.length + 1 || ownKeys.some(key => key !== "length" && !/^\d+$/u.test(String(key)))) {
    invalid(`${path}: expected a dense JSON array`);
  }
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) invalid(`${path}[${index}]: invalid array value`);
    return descriptor.value;
  });
}

function text(value: unknown, path: string, maximum = 256): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || value.trim() !== value
    || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) invalid(`${path}: invalid bounded text`);
  return value;
}

function identifier(value: unknown, path: string): string {
  return text(value, path, 256);
}

function digest(value: unknown, path: string): string {
  const result = text(value, path, 64);
  if (!/^[0-9a-f]{64}$/u.test(result)) invalid(`${path}: expected a lowercase SHA-256 digest`);
  return result;
}

function nullableDigest(value: unknown, path: string): string | null {
  return value === null ? null : digest(value, path);
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") invalid(`${path}: expected boolean`);
  return value;
}

function choice<T extends string>(value: unknown, values: readonly T[], path: string): T {
  if (typeof value !== "string" || !values.includes(value as T)) invalid(`${path}: unknown value`);
  return value as T;
}

function timestamp(value: unknown, path: string): string {
  const result = text(value, path, 64);
  if (!Number.isFinite(Date.parse(result)) || new Date(result).toISOString() !== result) invalid(`${path}: expected an ISO timestamp`);
  return result;
}

function uniqueStrings(value: unknown, path: string, maximum: number): readonly string[] {
  const values = array(value, path, maximum).map((entry, index) => identifier(entry, `${path}[${index}]`));
  if (new Set(values).size !== values.length) invalid(`${path}: duplicate value`);
  return values;
}

function parseArtifactPin(value: unknown, path: string): NodeRerunArtifactPinV1 {
  const pin = record(value, ["artifactId", "contentSha256"], path);
  return { artifactId: identifier(pin.artifactId, `${path}.artifactId`), contentSha256: digest(pin.contentSha256, `${path}.contentSha256`) };
}

function parseDependencyPin(value: unknown, path: string): NodeRerunDependencyPinV1 {
  const pin = record(value, ["nodeId", "nodeVersionDigest", "inputArtifact", "outputArtifacts", "permissionFingerprint"], path);
  const outputArtifacts = array(pin.outputArtifacts, `${path}.outputArtifacts`, 64)
    .map((entry, index) => parseArtifactPin(entry, `${path}.outputArtifacts[${index}]`));
  return {
    nodeId: identifier(pin.nodeId, `${path}.nodeId`),
    nodeVersionDigest: digest(pin.nodeVersionDigest, `${path}.nodeVersionDigest`),
    inputArtifact: parseArtifactPin(pin.inputArtifact, `${path}.inputArtifact`),
    outputArtifacts,
    permissionFingerprint: digest(pin.permissionFingerprint, `${path}.permissionFingerprint`),
  };
}

function parseDependencyClosure(value: unknown, path: string, nodeId: string): NodeRerunDependencyClosureV1 {
  const closure = record(value, ["complete", "upstream", "downstreamNodeIds"], path);
  const upstream = array(closure.upstream, `${path}.upstream`, 256)
    .map((entry, index) => parseDependencyPin(entry, `${path}.upstream[${index}]`));
  if (new Set(upstream.map(entry => entry.nodeId)).size !== upstream.length) invalid(`${path}.upstream: duplicate node`);
  const downstreamNodeIds = uniqueStrings(closure.downstreamNodeIds, `${path}.downstreamNodeIds`, 256);
  if (downstreamNodeIds.includes(nodeId)) invalid(`${path}.downstreamNodeIds: source node cannot be its own dependent`);
  return { complete: boolean(closure.complete, `${path}.complete`), upstream, downstreamNodeIds };
}

function parseSourceRef(value: unknown, path: string): NodeRerunSourceRefV1 {
  const source = record(value, ["runId", "attemptId", "nodeId", "graphVersionDigest", "inputArtifact", "dependencyClosure", "sourceSnapshotDigest"], path);
  const nodeId = identifier(source.nodeId, `${path}.nodeId`);
  return {
    runId: identifier(source.runId, `${path}.runId`),
    attemptId: identifier(source.attemptId, `${path}.attemptId`),
    nodeId,
    graphVersionDigest: digest(source.graphVersionDigest, `${path}.graphVersionDigest`),
    inputArtifact: parseArtifactPin(source.inputArtifact, `${path}.inputArtifact`),
    dependencyClosure: parseDependencyClosure(source.dependencyClosure, `${path}.dependencyClosure`, nodeId),
    sourceSnapshotDigest: digest(source.sourceSnapshotDigest, `${path}.sourceSnapshotDigest`),
  };
}

export function parseNodeRerunIntent(value: unknown): NodeRerunIntentV1 {
  const input = record(value, ["schemaVersion", "kind", "intentId", "source", "target", "requestedBy", "idempotencyKey", "createdAt"], "intent");
  if (input.schemaVersion !== NODE_RERUN_INTENT_SCHEMA_VERSION) invalid("intent.schemaVersion: unsupported schema");
  if (input.kind !== "node_rerun_intent") invalid("intent.kind: unsupported kind");
  const target = record(input.target, ["executionIdentity", "fence", "approval", "graphMutation"], "intent.target");
  return {
    schemaVersion: NODE_RERUN_INTENT_SCHEMA_VERSION,
    kind: "node_rerun_intent",
    intentId: identifier(input.intentId, "intent.intentId"),
    source: parseSourceRef(input.source, "intent.source"),
    target: {
      executionIdentity: choice(target.executionIdentity, ["host_minted"], "intent.target.executionIdentity"),
      fence: choice(target.fence, ["host_minted"], "intent.target.fence"),
      approval: choice(target.approval, ["fresh_current_policy"], "intent.target.approval"),
      graphMutation: choice(target.graphMutation, ["none"], "intent.target.graphMutation"),
    },
    requestedBy: choice(input.requestedBy, ["local-user", "system"], "intent.requestedBy"),
    idempotencyKey: identifier(input.idempotencyKey, "intent.idempotencyKey"),
    createdAt: timestamp(input.createdAt, "intent.createdAt"),
  };
}

export function parseNodeRerunIntentSubmission(value: unknown): NodeRerunIntentSubmissionV1 {
  const input = record(value, ["intent", "planFingerprint"], "submission");
  const planFingerprint = text(input.planFingerprint, "submission.planFingerprint", 23);
  if (!/^nrhpv1_[0-9a-f]{16}$/u.test(planFingerprint)) invalid("submission.planFingerprint: invalid Host plan fingerprint");
  return { intent: parseNodeRerunIntent(input.intent), planFingerprint };
}

/** Project frozen dependency evidence without changing source results or authorizing downstream work. */
export function projectNodeRerunGenerationV1(input: {
  readonly record: NodeRerunPreparedIntentV1;
  readonly target: NodeRerunPreparedTargetV1;
}): NodeRerunGenerationProjectionV1 {
  const pair = record(input, ["record", "target"], "projection");
  const saved = record(pair.record, ["schemaVersion", "kind", "id", "workspaceId", "status", "intent",
    "planFingerprint", "policyFingerprint", "preparedAt", "executionAuthorized"], "record");
  const target = record(pair.target, ["schemaVersion", "kind", "recordId", "workspaceId", "generationId", "approvalId",
    "source", "runId", "taskId", "fence", "frozenExecutionDigest", "preparedAt", "executionAuthorized"], "target");
  if (saved.schemaVersion !== 1 || saved.kind !== "node_rerun_prepared_intent" || saved.status !== "prepared"
    || saved.executionAuthorized !== false || target.schemaVersion !== 1 || target.kind !== "node_rerun_prepared_target"
    || target.executionAuthorized !== false) invalid("projection: invalid preparation evidence");
  const submission = parseNodeRerunIntentSubmission({ intent: saved.intent, planFingerprint: saved.planFingerprint });
  const policyFingerprint = digest(saved.policyFingerprint, "record.policyFingerprint");
  if (submission.planFingerprint !== nodeRerunHostAdmissionPlanFingerprintV1({ intent: submission.intent,
    source: submission.intent.source, sourcePolicyFingerprint: policyFingerprint, currentPolicyFingerprint: policyFingerprint }))
    invalid("projection: invalid saved plan");
  const recordId = identifier(saved.id, "record.id"), workspaceId = identifier(saved.workspaceId, "record.workspaceId");
  const source = parseSourceRef(target.source, "target.source");
  const preparedAt = timestamp(target.preparedAt, "target.preparedAt");
  if (target.recordId !== recordId || target.workspaceId !== workspaceId || !sameSource(submission.intent.source, source)
    || preparedAt < timestamp(saved.preparedAt, "record.preparedAt")) invalid("projection: preparation lineage mismatch");
  const closure = source.dependencyClosure;
  if (!closure.complete || closure.upstream.some(pin => pin.nodeId === source.nodeId
    || closure.downstreamNodeIds.includes(pin.nodeId) || pin.outputArtifacts.length === 0
    || new Set(pin.outputArtifacts.map(artifact => artifact.artifactId)).size !== pin.outputArtifacts.length))
    invalid("projection: incomplete or overlapping dependency evidence");
  const rawFence = record(target.fence, ["workUnitId", "attemptId", "runtimeInstanceId", "fencingToken"], "target.fence");
  const fence = {
    workUnitId: identifier(rawFence.workUnitId, "target.fence.workUnitId"),
    attemptId: identifier(rawFence.attemptId, "target.fence.attemptId"),
    runtimeInstanceId: identifier(rawFence.runtimeInstanceId, "target.fence.runtimeInstanceId"),
    fencingToken: identifier(rawFence.fencingToken, "target.fence.fencingToken"),
  };
  const runId = identifier(target.runId, "target.runId");
  if (runId === source.runId || fence.attemptId === source.attemptId) invalid("projection: replacement must have a new identity");
  return {
    schemaVersion: 1, kind: "node_rerun_generation_projection", recordId, workspaceId,
    generationId: identifier(target.generationId, "target.generationId"), approvalId: identifier(target.approvalId, "target.approvalId"),
    graphVersionDigest: source.graphVersionDigest,
    source: { runId: source.runId, attemptId: source.attemptId, nodeId: source.nodeId, sourceSnapshotDigest: source.sourceSnapshotDigest },
    replacement: { nodeId: source.nodeId, runId, taskId: identifier(target.taskId, "target.taskId"), fence,
      frozenExecutionDigest: digest(target.frozenExecutionDigest, "target.frozenExecutionDigest") },
    reusedUpstream: closure.upstream,
    invalidatedDownstream: closure.downstreamNodeIds.map(nodeId => ({ nodeId, status: "invalidated", executionAuthorized: false })),
    preparedAt, evidenceBasis: "frozen_target_preparation", revalidateBeforeExecution: true, graphMutation: "none",
    downstreamDispatch: "disabled", executionAuthorized: false,
  };
}

export function parseNodeRerunObservedSource(value: unknown): NodeRerunObservedSourceV1 {
  const input = record(value, ["source", "runStatus", "runLifecycle", "attemptStatus", "stopStatus", "leaseStatus", "fenceStatus",
    "effectStatus", "externalEffectStatus", "sourcePolicyFingerprint", "currentPolicyFingerprint", "currentPolicyAvailable", "permissionStatus"], "observed");
  return {
    source: parseSourceRef(input.source, "observed.source"),
    runStatus: choice(input.runStatus, ["queued", "running", "waiting_for_approval", "yielded", "succeeded", "failed", "cancelled"], "observed.runStatus"),
    runLifecycle: choice(input.runLifecycle, ["ended", "active", "unknown"], "observed.runLifecycle"),
    attemptStatus: choice(input.attemptStatus, ["created", "started", "waiting_for_approval", "cancelling", "yielded", "succeeded", "failed", "cancelled", "lost"], "observed.attemptStatus"),
    stopStatus: choice(input.stopStatus, ["not_required", "confirmed", "unconfirmed", "unknown"], "observed.stopStatus"),
    leaseStatus: choice(input.leaseStatus, ["none", "expired", "active", "unknown"], "observed.leaseStatus"),
    fenceStatus: choice(input.fenceStatus, ["released", "active", "unknown"], "observed.fenceStatus"),
    effectStatus: choice(input.effectStatus, ["none", "settled", "pending", "unknown"], "observed.effectStatus"),
    externalEffectStatus: choice(input.externalEffectStatus,
      ["none", "settled_idempotent", "pending", "non_idempotent", "unknown"], "observed.externalEffectStatus"),
    sourcePolicyFingerprint: nullableDigest(input.sourcePolicyFingerprint, "observed.sourcePolicyFingerprint"),
    currentPolicyFingerprint: nullableDigest(input.currentPolicyFingerprint, "observed.currentPolicyFingerprint"),
    currentPolicyAvailable: boolean(input.currentPolicyAvailable, "observed.currentPolicyAvailable"),
    permissionStatus: choice(input.permissionStatus, ["current", "expired", "revoked", "unknown"], "observed.permissionStatus"),
  };
}

function sameArtifact(left: NodeRerunArtifactPinV1, right: NodeRerunArtifactPinV1): boolean {
  return left.artifactId === right.artifactId && left.contentSha256 === right.contentSha256;
}

function sameDependency(left: NodeRerunDependencyPinV1, right: NodeRerunDependencyPinV1): boolean {
  return left.nodeId === right.nodeId
    && left.nodeVersionDigest === right.nodeVersionDigest
    && sameArtifact(left.inputArtifact, right.inputArtifact)
    && left.permissionFingerprint === right.permissionFingerprint
    && left.outputArtifacts.length === right.outputArtifacts.length
    && left.outputArtifacts.every((artifact, index) => sameArtifact(artifact, right.outputArtifacts[index]!));
}

function sameSource(left: NodeRerunSourceRefV1, right: NodeRerunSourceRefV1): boolean {
  return left.runId === right.runId
    && left.attemptId === right.attemptId
    && left.nodeId === right.nodeId
    && left.graphVersionDigest === right.graphVersionDigest
    && sameArtifact(left.inputArtifact, right.inputArtifact)
    && left.sourceSnapshotDigest === right.sourceSnapshotDigest
    && left.dependencyClosure.complete === right.dependencyClosure.complete
    && left.dependencyClosure.downstreamNodeIds.length === right.dependencyClosure.downstreamNodeIds.length
    && left.dependencyClosure.downstreamNodeIds.every((node, index) => node === right.dependencyClosure.downstreamNodeIds[index])
    && left.dependencyClosure.upstream.length === right.dependencyClosure.upstream.length
    && left.dependencyClosure.upstream.every((dependency, index) => sameDependency(dependency, right.dependencyClosure.upstream[index]!));
}

/**
 * Stable identity for an admission plan. Arrays retain their contract order;
 * object keys are sorted so the identity does not depend on object construction order.
 */
export function nodeRerunHostAdmissionPlanFingerprintV1(input: {
  readonly intent: NodeRerunIntentV1;
  readonly source: NodeRerunSourceRefV1;
  readonly sourcePolicyFingerprint: string;
  readonly currentPolicyFingerprint: string;
}): string {
  const value = sortJson({
    schemaVersion: NODE_RERUN_HOST_ADMISSION_PLAN_SCHEMA_VERSION,
    kind: "node_rerun_host_admission_plan",
    intent: input.intent,
    source: input.source,
    sourcePolicyFingerprint: input.sourcePolicyFingerprint,
    currentPolicyFingerprint: input.currentPolicyFingerprint,
    actions: {
      workUnit: "host_minted",
      run: "host_minted",
      attempt: "host_minted",
      fence: "host_minted",
      approval: "fresh_current_policy",
      graphMutation: "none",
      providerDispatch: "disabled",
    },
  });
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(JSON.stringify(value))) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `nrhpv1_${hash.toString(16).padStart(16, "0")}`;
}

/**
 * Build a deterministic Host-owned admission plan after the read-only
 * observation has passed the pure evaluator. This function never allocates
 * execution IDs, fences, approvals or Provider work.
 */
export function createNodeRerunHostAdmissionPlanV1(
  input: NodeRerunHostAdmissionPlanInputV1,
): NodeRerunHostAdmissionPlanV1 {
  let intent: NodeRerunIntentV1;
  let observed: NodeRerunObservedSourceV1;
  try {
    intent = parseNodeRerunIntent(input.intent);
    observed = parseNodeRerunObservedSource(input.observed);
  } catch {
    throw new NodeRerunValidationError("The Host plan input is not a valid intent and observation pair.");
  }

  const { admission } = input;
  if (admission.schemaVersion !== NODE_RERUN_INTENT_SCHEMA_VERSION
    || admission.kind !== "node_rerun_admission"
    || admission.decision !== "eligible_for_host_admission"
    || admission.executionAuthorized !== false
    || !Array.isArray(admission.blockers)
    || admission.blockers.length !== 0
    || admission.nextStep !== "host_must_revalidate_and_mint_identity") {
    throw new NodeRerunValidationError("A blocked admission cannot produce a Host plan.");
  }
  const reevaluated = evaluateNodeRerunAdmission({ intent, observed });
  if (!sameAdmissionResult(admission, reevaluated)
    || reevaluated.decision !== "eligible_for_host_admission"
    || !sameSource(intent.source, observed.source)) {
    throw new NodeRerunValidationError("The admission result and Host observation do not bind to the same source.");
  }
  if (!observed.currentPolicyAvailable
    || !observed.sourcePolicyFingerprint
    || !observed.currentPolicyFingerprint
    || observed.sourcePolicyFingerprint !== observed.currentPolicyFingerprint) {
    throw new NodeRerunValidationError("A current policy fingerprint is required to build a Host plan.");
  }

  const sourcePolicyFingerprint = observed.sourcePolicyFingerprint;
  const currentPolicyFingerprint = observed.currentPolicyFingerprint;
  const planFingerprint = nodeRerunHostAdmissionPlanFingerprintV1({
    intent,
    source: observed.source,
    sourcePolicyFingerprint,
    currentPolicyFingerprint,
  });
  return {
    schemaVersion: NODE_RERUN_HOST_ADMISSION_PLAN_SCHEMA_VERSION,
    kind: "node_rerun_host_admission_plan",
    planId: `node_rerun_plan_${planFingerprint}`,
    planFingerprint,
    intentId: intent.intentId,
    idempotencyKey: intent.idempotencyKey,
    source: observed.source,
    sourcePolicyFingerprint,
    currentPolicyFingerprint,
    actions: {
      workUnit: "host_minted",
      run: "host_minted",
      attempt: "host_minted",
      fence: "host_minted",
      approval: "fresh_current_policy",
      graphMutation: "none",
      providerDispatch: "disabled",
    },
    preconditions: {
      sourceSnapshotDigest: observed.source.sourceSnapshotDigest,
      policyFingerprint: currentPolicyFingerprint,
      idempotencyKey: intent.idempotencyKey,
      revalidateBeforeWrite: true,
    },
  };
}

function sameAdmissionResult(left: NodeRerunAdmissionResult, right: NodeRerunAdmissionResult): boolean {
  return left.schemaVersion === right.schemaVersion
    && left.kind === right.kind
    && left.decision === right.decision
    && left.executionAuthorized === right.executionAuthorized
    && left.intentId === right.intentId
    && sameAdmissionSource(left.source, right.source)
    && left.blockers.length === right.blockers.length
    && left.blockers.every((blocker, index) => blocker === right.blockers[index])
    && left.nextStep === right.nextStep;
}

function sameAdmissionSource(
  left: NodeRerunAdmissionResult["source"],
  right: NodeRerunAdmissionResult["source"],
): boolean {
  return left === null && right === null
    || left !== null && right !== null
      && left.runId === right.runId && left.attemptId === right.attemptId && left.nodeId === right.nodeId;
}

function result(input: {
  readonly decision: NodeRerunAdmissionResult["decision"];
  readonly intentId: string | null;
  readonly source: NodeRerunAdmissionResult["source"];
  readonly blockers: readonly NodeRerunBlockerCode[];
}): NodeRerunAdmissionResult {
  return {
    schemaVersion: NODE_RERUN_INTENT_SCHEMA_VERSION,
    kind: "node_rerun_admission",
    decision: input.decision,
    executionAuthorized: false,
    intentId: input.intentId,
    source: input.source,
    blockers: [...new Set(input.blockers)],
    nextStep: input.decision === "blocked" ? "manual_review_required" : "host_must_revalidate_and_mint_identity",
  };
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(record).sort().map((key) => [key, sortJson(record[key])]));
}

/**
 * Pure A17 preflight. It compares an immutable intent with a Host observation;
 * it never creates a Run, Attempt, lease, approval, Provider call or database row.
 */
export function evaluateNodeRerunAdmission(input: NodeRerunAdmissionInput): NodeRerunAdmissionResult {
  let envelope: Record<string, unknown>;
  try {
    // Treat the outer admission envelope as untrusted too. In particular, do
    // not dereference getters before the parser's fail-closed boundary runs.
    envelope = record(input, ["intent", "observed"], "input");
  } catch {
    return result({ decision: "blocked", intentId: null, source: null, blockers: ["invalid_intent"] });
  }

  let intent: NodeRerunIntentV1;
  try {
    intent = parseNodeRerunIntent(envelope.intent);
  } catch {
    return result({ decision: "blocked", intentId: null, source: null, blockers: ["invalid_intent"] });
  }

  let observed: NodeRerunObservedSourceV1;
  try {
    observed = parseNodeRerunObservedSource(envelope.observed);
  } catch {
    return result({
      decision: "blocked",
      intentId: intent.intentId,
      source: { runId: intent.source.runId, attemptId: intent.source.attemptId, nodeId: intent.source.nodeId },
      blockers: ["invalid_observation"],
    });
  }

  const blockers: NodeRerunBlockerCode[] = [];
  if (!sameSource(intent.source, observed.source)
    || observed.source.runId !== intent.source.runId
    || observed.source.attemptId !== intent.source.attemptId) blockers.push("source_identity_mismatch");
  if (!(["succeeded", "failed", "cancelled"] as readonly string[]).includes(observed.runStatus)
    || observed.runLifecycle !== "ended") blockers.push("source_run_not_terminal");
  const terminalAttempt = observed.attemptStatus === "succeeded" || observed.attemptStatus === "failed" || observed.attemptStatus === "cancelled";
  const attemptStopped = observed.attemptStatus === "lost"
    ? observed.stopStatus === "confirmed"
    : terminalAttempt && (observed.attemptStatus === "cancelled"
      ? observed.stopStatus === "confirmed"
      : observed.stopStatus === "not_required" || observed.stopStatus === "confirmed");
  if (!attemptStopped) blockers.push("source_attempt_not_stopped");
  if (observed.leaseStatus === "active" || observed.leaseStatus === "unknown") blockers.push("source_lease_active");
  if (observed.fenceStatus !== "released") blockers.push("source_fence_active");
  if (observed.effectStatus === "pending" || observed.effectStatus === "unknown") blockers.push("source_effect_unconfirmed");
  if (observed.externalEffectStatus === "pending" || observed.externalEffectStatus === "non_idempotent" || observed.externalEffectStatus === "unknown") {
    blockers.push("external_effect_not_replayable");
  }
  if (!intent.source.dependencyClosure.complete) blockers.push("dependency_closure_incomplete");
  if (intent.source.dependencyClosure.upstream.some(dependency => dependency.outputArtifacts.length === 0)) {
    blockers.push("dependency_evidence_missing");
  }
  if (!observed.currentPolicyAvailable || !observed.sourcePolicyFingerprint || !observed.currentPolicyFingerprint) {
    blockers.push("policy_unavailable");
  } else if (observed.sourcePolicyFingerprint !== observed.currentPolicyFingerprint) {
    blockers.push("policy_drift");
  }
  if (observed.permissionStatus !== "current") blockers.push("permission_not_current");
  if (intent.target.executionIdentity !== "host_minted") blockers.push("target_identity_not_host_minted");
  if (intent.target.fence !== "host_minted") blockers.push("target_fence_not_host_minted");
  if (intent.target.approval !== "fresh_current_policy") blockers.push("target_approval_not_fresh");

  return result({
    decision: blockers.length === 0 ? "eligible_for_host_admission" : "blocked",
    intentId: intent.intentId,
    source: { runId: intent.source.runId, attemptId: intent.source.attemptId, nodeId: intent.source.nodeId },
    blockers,
  });
}
