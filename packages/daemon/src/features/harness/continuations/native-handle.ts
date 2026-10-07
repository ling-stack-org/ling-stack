import { createHash } from "node:crypto";
import type { RunArtifact, RunStore } from "@ling-stack/core";
import { isRecord } from "../../../shared/validation.js";
import { assertHarnessPayloadSecretFree, runnerWorkspaceIdentity } from "./replay-package.js";

export interface RunnerNativeResumeHandleV1 {
  readonly schemaVersion: 1;
  readonly boundary: "runner-native-resume-handle";
  readonly sourceRunId: string;
  readonly rootRunId: string;
  readonly sourceWorkUnitId: string;
  readonly sourceAttemptId: string;
  readonly workspaceIdentity: string;
  readonly runnerId: string;
  readonly runnerCapabilityRevision: string;
  readonly policySnapshotFingerprint: string;
  readonly opaqueHandle: string;
  readonly issuedAt: string;
  readonly fingerprint: string;
}

export function captureRunnerNativeResumeHandle(input: {
  readonly sourceRunId: string;
  readonly rootRunId: string;
  readonly sourceWorkUnitId: string;
  readonly sourceAttemptId: string;
  readonly workspaceCwd: string;
  readonly runnerId: string;
  readonly runnerCapabilityRevision: string;
  readonly policySnapshotFingerprint: string;
  readonly opaqueHandle: string;
  readonly issuedAt: string;
}): RunnerNativeResumeHandleV1 {
  const body = {
    schemaVersion: 1 as const,
    boundary: "runner-native-resume-handle" as const,
    sourceRunId: identity(input.sourceRunId),
    rootRunId: identity(input.rootRunId),
    sourceWorkUnitId: identity(input.sourceWorkUnitId),
    sourceAttemptId: identity(input.sourceAttemptId),
    workspaceIdentity: runnerWorkspaceIdentity(input.workspaceCwd),
    runnerId: identity(input.runnerId),
    runnerCapabilityRevision: identity(input.runnerCapabilityRevision),
    policySnapshotFingerprint: identity(input.policySnapshotFingerprint),
    opaqueHandle: identity(input.opaqueHandle),
    issuedAt: canonicalTimestamp(input.issuedAt),
  };
  assertHarnessPayloadSecretFree(body, "Runner native handle contains secret material.");
  return deepFreeze({ ...body, fingerprint: hashJson(body) });
}

export function readRunnerNativeResumeHandle(value: unknown): RunnerNativeResumeHandleV1 {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.boundary !== "runner-native-resume-handle"
    || Object.keys(value).sort().join("\0") !== ["schemaVersion", "boundary", "sourceRunId", "rootRunId",
      "sourceWorkUnitId", "sourceAttemptId", "workspaceIdentity", "runnerId", "runnerCapabilityRevision",
      "policySnapshotFingerprint", "opaqueHandle", "issuedAt", "fingerprint"].sort().join("\0")) throw invalid();
  for (const key of ["sourceRunId", "rootRunId", "sourceWorkUnitId", "sourceAttemptId", "workspaceIdentity", "runnerId",
    "runnerCapabilityRevision", "policySnapshotFingerprint", "opaqueHandle"] as const) identity(value[key]);
  canonicalTimestamp(value.issuedAt);
  const { fingerprint, ...body } = value;
  if (typeof fingerprint !== "string" || fingerprint !== hashJson(body)) throw invalid();
  assertHarnessPayloadSecretFree(value, "Runner native handle contains secret material.");
  return deepFreeze(structuredClone(value) as unknown as RunnerNativeResumeHandleV1);
}

export function createRunnerNativeResumeHandleArtifact(input: {
  readonly store: Pick<RunStore, "createArtifact">;
  readonly handle: RunnerNativeResumeHandleV1;
  readonly artifactId?: string;
}): RunArtifact {
  const handle = readRunnerNativeResumeHandle(input.handle);
  return input.store.createArtifact({
    id: input.artifactId,
    runId: handle.sourceRunId,
    type: "json",
    path: `harness/runner-handles/${handle.sourceRunId}/${handle.fingerprint}.json`,
    title: "Runner native resume handle",
    contentType: "application/vnd.ling.runner-native-resume-handle+json",
    sealedPayload: handle,
    createdAt: handle.issuedAt,
  });
}

export function readRunnerNativeResumeHandleArtifact(input: {
  readonly store: Pick<RunStore, "getArtifact">;
  readonly artifactId: string;
}): RunnerNativeResumeHandleV1 {
  const artifact = input.store.getArtifact(input.artifactId);
  if (!artifact || artifact.type !== "json" || artifact.contentType !== "application/vnd.ling.runner-native-resume-handle+json"
    || artifact.sealedPayload === undefined || artifact.contentSha256 !== hashJson(artifact.sealedPayload)) throw invalid();
  const handle = readRunnerNativeResumeHandle(artifact.sealedPayload);
  if (artifact.runId !== handle.sourceRunId) throw invalid();
  return handle;
}

function identity(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > 4096) throw invalid();
  return value;
}

function canonicalTimestamp(value: unknown): string {
  if (typeof value !== "string") throw invalid();
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) throw invalid();
  return value;
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function invalid(): Error {
  return new Error("Invalid runner native resume handle.");
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
