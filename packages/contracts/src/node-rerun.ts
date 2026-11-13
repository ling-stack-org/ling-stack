import type { RunStatus } from "./shared.js";
import type { WorkUnitAttemptStatus } from "./runtime.js";

export const NODE_RERUN_INTENT_SCHEMA_VERSION = 1 as const;

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
