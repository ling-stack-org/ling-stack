import { createHash } from "node:crypto";
import { resolve } from "node:path";
import {
  conversationDomainRefTypes,
  type ConversationDomainRef,
  type RunnerContinuationOrigin,
  type RunnerContinuationV1,
} from "@ling-stack/contracts";
import {
  redactSecrets,
  toRuntimeAttemptFence,
  type EffectiveRunPolicySnapshot,
  type RunArtifact,
  type RunStore,
  type RuntimeAttemptFenceV1,
  type WorkUnitAttempt,
  type WorkUnitAttemptStatus,
} from "@ling-stack/core";
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "../../../shared/validation.js";
import { readPreparedRunnerInput, type PreparedRunnerInput } from "../../runs/prepared-runner-input.js";

const MAX_SOURCE_REFS = 128;
const MAX_ASSISTANT_EVIDENCE = 24;
const MAX_ASSISTANT_TEXT_BYTES = 32 * 1024;
const MAX_TOOL_EVIDENCE = 96;
const MAX_APPROVAL_EVIDENCE = 48;
const MAX_ARTIFACT_REFS = 192;

export interface RunnerReplayAssistantEvidenceV1 {
  readonly itemId: string;
  readonly text: string;
  readonly digest: string;
}

export interface RunnerReplayToolEvidenceV1 {
  readonly actionId: string;
  readonly toolCallId?: string;
  readonly status: string;
  readonly resultArtifactIds: readonly string[];
  readonly digest: string;
}

export interface RunnerReplayApprovalEvidenceV1 {
  readonly approvalId: string;
  readonly decision: "approved" | "denied" | "cancelled";
  readonly sideEffectFingerprint?: string;
}

export interface RunnerContinuationReplayPackageV1 {
  readonly schemaVersion: 1;
  readonly boundary: "runner-continuation-replay";
  readonly runId: string;
  readonly rootRunId: string;
  readonly workUnitId: string;
  readonly sourceRunId: string;
  readonly sourceWorkUnitId: string;
  readonly origin: RunnerContinuationOrigin;
  readonly workspaceIdentity: string;
  readonly contextViewId: string;
  readonly contextProjectionVersion: string;
  readonly contextSourceRefs: readonly ConversationDomainRef[];
  readonly sourceFence: RuntimeAttemptFenceV1;
  readonly priorAttempt: {
    readonly status: WorkUnitAttemptStatus;
    readonly endedAt?: string;
    readonly errorCode?: string;
  };
  readonly runnerId: string;
  readonly runnerCapabilityRevision: string;
  readonly policySnapshotFingerprint: string;
  readonly preparedExecutionFingerprint: string;
  readonly acceptedInstructionsFingerprint: string;
  readonly execution: PreparedRunnerInput;
  readonly assistantEvidence: readonly RunnerReplayAssistantEvidenceV1[];
  readonly toolEvidence: readonly RunnerReplayToolEvidenceV1[];
  readonly approvalEvidence: readonly RunnerReplayApprovalEvidenceV1[];
  readonly artifactRefs: readonly string[];
  readonly fingerprint: string;
}

export interface CaptureRunnerContinuationReplayPackageInput {
  readonly runId: string;
  readonly rootRunId: string;
  readonly workUnitId: string;
  readonly sourceRunId: string;
  readonly sourceWorkUnitId: string;
  readonly origin: RunnerContinuationOrigin;
  readonly workspaceCwd: string;
  readonly contextViewId: string;
  readonly contextProjectionVersion: string;
  readonly contextSourceRefs: readonly ConversationDomainRef[];
  readonly sourceAttempt: WorkUnitAttempt;
  readonly runnerId: string;
  readonly runnerCapabilityRevision: string;
  readonly policySnapshot: EffectiveRunPolicySnapshot;
  readonly execution: PreparedRunnerInput;
  readonly assistantEvidence?: readonly Omit<RunnerReplayAssistantEvidenceV1, "digest">[];
  readonly toolEvidence?: readonly Omit<RunnerReplayToolEvidenceV1, "digest">[];
  readonly approvalEvidence?: readonly RunnerReplayApprovalEvidenceV1[];
  readonly artifactRefs?: readonly string[];
}

/** Capture a bounded, secret-free replay package whose fingerprint is stable across daemon restarts. */
export function captureRunnerContinuationReplayPackage(
  input: CaptureRunnerContinuationReplayPackageInput,
): RunnerContinuationReplayPackageV1 {
  const execution = readPreparedRunnerInput(input.execution, {
    cwd: input.execution.input.cwd,
    task: input.execution.input.task,
  });
  if (execution.runnerId !== input.runnerId) throw new Error("Replay execution runner lineage changed.");
  if (input.sourceAttempt.workUnitId !== input.sourceWorkUnitId) throw new Error("Replay source Attempt ownership changed.");
  const assistantEvidence = normalizeAssistantEvidence(input.assistantEvidence ?? []);
  const body = {
    schemaVersion: 1 as const,
    boundary: "runner-continuation-replay" as const,
    runId: identity(input.runId, "run id"),
    rootRunId: identity(input.rootRunId, "root run id"),
    workUnitId: identity(input.workUnitId, "work unit id"),
    sourceRunId: identity(input.sourceRunId, "source run id"),
    sourceWorkUnitId: identity(input.sourceWorkUnitId, "source work unit id"),
    origin: input.origin,
    workspaceIdentity: workspaceIdentity(input.workspaceCwd),
    contextViewId: identity(input.contextViewId, "context view id"),
    contextProjectionVersion: identity(input.contextProjectionVersion, "context projection version"),
    contextSourceRefs: normalizeSourceRefs(input.contextSourceRefs),
    sourceFence: toRuntimeAttemptFence(input.sourceAttempt),
    priorAttempt: compactAttempt(input.sourceAttempt),
    runnerId: identity(input.runnerId, "runner id"),
    runnerCapabilityRevision: identity(input.runnerCapabilityRevision, "runner capability revision"),
    policySnapshotFingerprint: hashJson(input.policySnapshot),
    preparedExecutionFingerprint: hashJson(execution),
    acceptedInstructionsFingerprint: hashJson({
      task: execution.input.task,
      systemPrompt: execution.input.systemPrompt,
      appendSystemPrompt: execution.input.appendSystemPrompt ?? [],
      preparedInputFingerprint: execution.preparedInput.fingerprint,
    }),
    execution,
    assistantEvidence,
    toolEvidence: normalizeToolEvidence(input.toolEvidence ?? []),
    approvalEvidence: normalizeApprovalEvidence(input.approvalEvidence ?? []),
    artifactRefs: normalizeIdentities(input.artifactRefs ?? [], MAX_ARTIFACT_REFS, "artifact ref"),
  };
  assertHarnessPayloadSecretFree(body, "Runner continuation replay package contains secret material.");
  return deepFreeze({ ...body, fingerprint: hashJson(body) });
}

export function readRunnerContinuationReplayPackage(value: unknown): RunnerContinuationReplayPackageV1 {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.boundary !== "runner-continuation-replay") {
    throw invalidReplay();
  }
  const expectedKeys = [
    "schemaVersion", "boundary", "runId", "rootRunId", "workUnitId", "sourceRunId", "sourceWorkUnitId", "origin", "workspaceIdentity",
    "contextViewId", "contextProjectionVersion", "contextSourceRefs", "sourceFence", "priorAttempt", "runnerId",
    "runnerCapabilityRevision", "policySnapshotFingerprint", "preparedExecutionFingerprint",
    "acceptedInstructionsFingerprint", "execution", "assistantEvidence", "toolEvidence", "approvalEvidence",
    "artifactRefs", "fingerprint",
  ];
  if (!sameKeys(value, expectedKeys) || typeof value.fingerprint !== "string") throw invalidReplay();
  const { fingerprint, ...body } = value;
  if (fingerprint !== hashJson(body)) throw invalidReplay();
  assertHarnessPayloadSecretFree(value, "Runner continuation replay package contains secret material.");
  if (!["manual_resume", "queued_followup", "interrupt_redirect", "approval_resume", "runner_retry", "daemon_recovery"].includes(String(value.origin))) {
    throw invalidReplay();
  }
  for (const key of ["runId", "rootRunId", "workUnitId", "sourceRunId", "sourceWorkUnitId", "workspaceIdentity", "contextViewId",
    "contextProjectionVersion", "runnerId", "runnerCapabilityRevision", "policySnapshotFingerprint",
    "preparedExecutionFingerprint", "acceptedInstructionsFingerprint"] as const) identity(value[key], key);
  const sourceFence = readFence(value.sourceFence);
  const priorAttempt = readPriorAttempt(value.priorAttempt);
  const execution = readPreparedRunnerInput(value.execution, readExecutionRequest(value.execution));
  if (execution.runnerId !== value.runnerId || hashJson(execution) !== value.preparedExecutionFingerprint
    || hashJson({ task: execution.input.task, systemPrompt: execution.input.systemPrompt,
      appendSystemPrompt: execution.input.appendSystemPrompt ?? [],
      preparedInputFingerprint: execution.preparedInput.fingerprint }) !== value.acceptedInstructionsFingerprint) throw invalidReplay();
  const sourceRefs = normalizeSourceRefs(readArray(value.contextSourceRefs));
  const assistantEvidence = normalizeAssistantEvidence(readArray(value.assistantEvidence).map(readAssistantEvidence));
  const toolEvidence = normalizeToolEvidence(readArray(value.toolEvidence).map(readToolEvidence));
  const approvalEvidence = normalizeApprovalEvidence(readArray(value.approvalEvidence).map(readApprovalEvidence));
  const artifactRefs = normalizeIdentities(readArray(value.artifactRefs), MAX_ARTIFACT_REFS, "artifact ref");
  return deepFreeze({
    ...(structuredClone(value) as unknown as RunnerContinuationReplayPackageV1),
    sourceFence,
    priorAttempt,
    execution,
    contextSourceRefs: sourceRefs,
    assistantEvidence,
    toolEvidence,
    approvalEvidence,
    artifactRefs,
  });
}

export function createRunnerContinuationReplayArtifact(input: {
  readonly store: Pick<RunStore, "createArtifact">;
  readonly replayPackage: RunnerContinuationReplayPackageV1;
  readonly artifactId?: string;
  readonly createdAt: string;
}): RunArtifact {
  const replayPackage = readRunnerContinuationReplayPackage(input.replayPackage);
  return input.store.createArtifact({
    id: input.artifactId,
    runId: replayPackage.runId,
    type: "json",
    path: `harness/continuations/${replayPackage.runId}/${replayPackage.fingerprint}.json`,
    title: "Runner continuation replay package",
    contentType: "application/vnd.ling.runner-continuation-replay+json",
    sealedPayload: replayPackage,
    createdAt: input.createdAt,
  });
}

/** Read from SQLite-owned sealed evidence; mutable chat windows and artifact files are never consulted. */
export function readRunnerContinuationReplayArtifact(input: {
  readonly store: Pick<RunStore, "getArtifact">;
  readonly continuation: RunnerContinuationV1;
}): RunnerContinuationReplayPackageV1 {
  const artifact = input.store.getArtifact(input.continuation.contextSnapshotArtifactId);
  if (!artifact || artifact.runId !== input.continuation.runId || artifact.type !== "json"
    || artifact.contentType !== "application/vnd.ling.runner-continuation-replay+json"
    || artifact.sealedPayload === undefined || artifact.contentSha256 !== hashJson(artifact.sealedPayload)) {
    throw new RunnerReplayArtifactError("continuation.context_snapshot_missing");
  }
  let replay: RunnerContinuationReplayPackageV1;
  try { replay = readRunnerContinuationReplayPackage(artifact.sealedPayload); }
  catch { throw new RunnerReplayArtifactError("continuation.context_snapshot_missing"); }
  if (replay.runId !== input.continuation.runId
    || replay.workUnitId !== input.continuation.workUnitId
    || replay.origin !== input.continuation.origin
    || replay.runnerId !== input.continuation.runnerId
    || replay.runnerCapabilityRevision !== input.continuation.runnerCapabilityRevision
    || replay.contextViewId !== input.continuation.contextViewId
    || replay.sourceFence.attemptId !== input.continuation.sourceAttemptId
    || replay.sourceFence.workUnitId !== replay.sourceWorkUnitId) {
    throw new RunnerReplayArtifactError("continuation.context_snapshot_missing");
  }
  return replay;
}

export class RunnerReplayArtifactError extends Error {
  constructor(readonly code: "continuation.context_snapshot_missing") {
    super(code);
    this.name = "RunnerReplayArtifactError";
  }
}

export function runnerPolicySnapshotFingerprint(snapshot: EffectiveRunPolicySnapshot): string {
  return hashJson(snapshot);
}

export function runnerWorkspaceIdentity(cwd: string): string {
  return workspaceIdentity(cwd);
}

/** Ignore known non-secret fence/hash fields while retaining prompt and payload secret scanning. */
export function assertHarnessPayloadSecretFree(value: unknown, message: string): void {
  const comparable = structuredClone(value);
  scrubNonSecretIdentities(comparable);
  if (!isDeepStrictEqual(redactSecrets(comparable), comparable)) throw new Error(message);
}

function normalizeAssistantEvidence(
  values: readonly Omit<RunnerReplayAssistantEvidenceV1, "digest">[] | readonly RunnerReplayAssistantEvidenceV1[],
): readonly RunnerReplayAssistantEvidenceV1[] {
  if (values.length > MAX_ASSISTANT_EVIDENCE) throw invalidReplay();
  let bytes = 0;
  return values.map((value) => {
    const itemId = identity(value.itemId, "assistant item id");
    if (typeof value.text !== "string") throw invalidReplay();
    bytes += Buffer.byteLength(value.text, "utf8");
    if (bytes > MAX_ASSISTANT_TEXT_BYTES) throw invalidReplay();
    const digest = hashJson({ itemId, text: value.text });
    if ("digest" in value && value.digest !== digest) throw invalidReplay();
    return { itemId, text: value.text, digest };
  });
}

function normalizeToolEvidence(
  values: readonly Omit<RunnerReplayToolEvidenceV1, "digest">[] | readonly RunnerReplayToolEvidenceV1[],
): readonly RunnerReplayToolEvidenceV1[] {
  if (values.length > MAX_TOOL_EVIDENCE) throw invalidReplay();
  return values.map((value) => {
    const normalized = {
      actionId: identity(value.actionId, "tool action id"),
      ...(value.toolCallId === undefined ? {} : { toolCallId: identity(value.toolCallId, "tool call id") }),
      status: identity(value.status, "tool status"),
      resultArtifactIds: normalizeIdentities(value.resultArtifactIds, 16, "tool artifact ref"),
    };
    const digest = hashJson(normalized);
    if ("digest" in value && value.digest !== digest) throw invalidReplay();
    return { ...normalized, digest };
  });
}

function normalizeApprovalEvidence(values: readonly RunnerReplayApprovalEvidenceV1[]): readonly RunnerReplayApprovalEvidenceV1[] {
  if (values.length > MAX_APPROVAL_EVIDENCE) throw invalidReplay();
  return values.map((value) => {
    if (!["approved", "denied", "cancelled"].includes(value.decision)) throw invalidReplay();
    return {
      approvalId: identity(value.approvalId, "approval id"),
      decision: value.decision,
      ...(value.sideEffectFingerprint === undefined ? {} : {
        sideEffectFingerprint: identity(value.sideEffectFingerprint, "side-effect fingerprint"),
      }),
    };
  });
}

function normalizeSourceRefs(values: readonly unknown[]): readonly ConversationDomainRef[] {
  if (values.length > MAX_SOURCE_REFS) throw invalidReplay();
  const keys = new Set<string>();
  return values.map((value) => {
    if (!isRecord(value) || typeof value.type !== "string" || !conversationDomainRefTypes.includes(value.type as ConversationDomainRef["type"])
      || typeof value.id !== "string"
      || value.label !== undefined && typeof value.label !== "string") throw invalidReplay();
    const ref = { type: value.type, id: identity(value.id, "source ref id"),
      ...(value.label === undefined ? {} : { label: value.label }) } as ConversationDomainRef;
    const key = `${ref.type}:${ref.id}`;
    if (keys.has(key)) throw invalidReplay();
    keys.add(key);
    return ref;
  });
}

function normalizeIdentities(values: readonly unknown[], limit: number, label: string): readonly string[] {
  if (values.length > limit) throw invalidReplay();
  const result = values.map((value) => identity(value, label));
  if (new Set(result).size !== result.length) throw invalidReplay();
  return result;
}

function compactAttempt(attempt: WorkUnitAttempt): RunnerContinuationReplayPackageV1["priorAttempt"] {
  return {
    status: attempt.status,
    ...(attempt.endedAt ? { endedAt: attempt.endedAt } : {}),
    ...(attempt.errorCode ? { errorCode: attempt.errorCode } : {}),
  };
}

function readFence(value: unknown): RuntimeAttemptFenceV1 {
  if (!isRecord(value) || !sameKeys(value, ["workUnitId", "attemptId", "runtimeInstanceId", "fencingToken"])) throw invalidReplay();
  return {
    workUnitId: identity(value.workUnitId, "source work unit id"),
    attemptId: identity(value.attemptId, "source attempt id"),
    runtimeInstanceId: identity(value.runtimeInstanceId, "source runtime instance id"),
    fencingToken: identity(value.fencingToken, "source fencing token"),
  };
}

function readPriorAttempt(value: unknown): RunnerContinuationReplayPackageV1["priorAttempt"] {
  if (!isRecord(value) || Object.keys(value).some((key) => !["status", "endedAt", "errorCode"].includes(key))
    || !["created", "started", "waiting_for_approval", "cancelling", "yielded", "succeeded", "failed", "cancelled", "lost"].includes(String(value.status))
    || value.endedAt !== undefined && typeof value.endedAt !== "string"
    || value.errorCode !== undefined && typeof value.errorCode !== "string") throw invalidReplay();
  return structuredClone(value) as RunnerContinuationReplayPackageV1["priorAttempt"];
}

function readAssistantEvidence(value: unknown): RunnerReplayAssistantEvidenceV1 {
  if (!isRecord(value) || !sameKeys(value, ["itemId", "text", "digest"])
    || typeof value.itemId !== "string" || typeof value.text !== "string" || typeof value.digest !== "string") throw invalidReplay();
  return value as unknown as RunnerReplayAssistantEvidenceV1;
}

function readToolEvidence(value: unknown): RunnerReplayToolEvidenceV1 {
  if (!isRecord(value) || Object.keys(value).some((key) => !["actionId", "toolCallId", "status", "resultArtifactIds", "digest"].includes(key))
    || typeof value.actionId !== "string" || value.toolCallId !== undefined && typeof value.toolCallId !== "string"
    || typeof value.status !== "string" || !Array.isArray(value.resultArtifactIds) || typeof value.digest !== "string") throw invalidReplay();
  return value as unknown as RunnerReplayToolEvidenceV1;
}

function readApprovalEvidence(value: unknown): RunnerReplayApprovalEvidenceV1 {
  if (!isRecord(value) || Object.keys(value).some((key) => !["approvalId", "decision", "sideEffectFingerprint"].includes(key))
    || typeof value.approvalId !== "string" || !["approved", "denied", "cancelled"].includes(String(value.decision))
    || value.sideEffectFingerprint !== undefined && typeof value.sideEffectFingerprint !== "string") throw invalidReplay();
  return value as unknown as RunnerReplayApprovalEvidenceV1;
}

function readExecutionRequest(value: unknown): { readonly cwd: string; readonly task: PreparedRunnerInput["input"]["task"] } {
  if (!isRecord(value) || !isRecord(value.input) || typeof value.input.cwd !== "string" || !isRecord(value.input.task)) throw invalidReplay();
  return { cwd: value.input.cwd, task: value.input.task as unknown as PreparedRunnerInput["input"]["task"] };
}

function readArray(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) throw invalidReplay();
  return value;
}

function workspaceIdentity(cwd: string): string {
  return `workspace:sha256:${createHash("sha256").update(resolve(identity(cwd, "workspace cwd"))).digest("hex")}`;
}

function identity(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > 4096) {
    throw new Error(`Invalid runner replay ${label}.`);
  }
  return value;
}

function sameKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function invalidReplay(): Error {
  return new Error("Invalid runner continuation replay package.");
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function scrubNonSecretIdentities(value: unknown): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const child of value) scrubNonSecretIdentities(child);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (/^(?:fingerprint|digest|.*Fingerprint|.*Digest|.*Sha256|workspaceIdentity|fencingToken)$/u.test(key)) {
      (value as Record<string, unknown>)[key] = "[REDACTED]";
    } else {
      scrubNonSecretIdentities(child);
    }
  }
}
