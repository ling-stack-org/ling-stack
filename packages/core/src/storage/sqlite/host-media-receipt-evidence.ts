import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { digestHarnessToolValue } from "../../harness/tool-executions.js";
import type { HostMediaExecutionRecord, HostMediaEffectRecord } from "../../host-media-operation-types.js";
import type { HostOperationRecord } from "../../host-operation-journal-types.js";
import type { HostMediaArtifactManifest, HostMediaCompletedResponse, HostMediaEffectNoStart,
  HostMediaLocalFinalization, HostMediaSubmission, HostMediaTerminal } from "../../host-media-receipt-types.js";
import { hostOperationTimestamp } from "./host-operation-journal-evidence.js";
import { mediaFactDigest, mediaFactFailure, mediaFactText, readHostMediaExecution, readHostMediaEffects } from "./host-media-operation-records.js";

type Receipt = HostMediaCompletedResponse | HostMediaSubmission | HostMediaTerminal | HostMediaArtifactManifest
  | HostMediaLocalFinalization | HostMediaEffectNoStart;
const invalid = (): never => mediaFactFailure("host_media_receipt_invalid");
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const equal = (a: unknown, b: unknown): boolean => digestHarnessToolValue(a) === digestHarnessToolValue(b);

/** JSON seal and media bytes digest are intentionally different domains. */
export function readHostMediaReceipt<T extends Receipt>(database: DatabaseSync, execution: HostMediaExecutionRecord,
  artifactId: string | undefined, kind: T["kind"]): { readonly payload: T; readonly hash: string; readonly createdAt: string } {
  if (!mediaFactText(artifactId)) return invalid();
  const row = database.prepare("SELECT * FROM artifacts WHERE id=?").get(artifactId);
  let payload: unknown;
  try { payload = JSON.parse(String(row?.sealed_payload_json)); } catch { return invalid(); }
  if (!row || row.run_id !== execution.source.runId || row.media_job_id !== null || row.type !== "json"
    || !record(payload) || payload.kind !== kind || !mediaFactDigest(row.content_sha256)
    || createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex") !== row.content_sha256) return invalid();
  validateIdentity(execution, payload);
  const at = hostOperationTimestamp(payload.completedAt), createdAt = hostOperationTimestamp(row.created_at);
  if (at < hostOperationTimestamp(execution.childBoundAt) || createdAt < at || createdAt > Date.now()) return invalid();
  return { payload: payload as unknown as T, hash: row.content_sha256, createdAt: String(row.created_at) };
}

function validateIdentity(execution: HostMediaExecutionRecord, payload: Record<string, unknown>): void {
  if (!execution.childFence || payload.schemaVersion !== 1 || payload.executionId !== execution.executionId
    || payload.executionIdentityDigest !== execution.identityDigest || payload.mediaJobId !== execution.mediaJobId
    || payload.executionGenerationId !== execution.executionGenerationId || payload.namespaceDigest !== execution.namespaceDigest
    || payload.protocol !== execution.protocol || !equal(payload.source, execution.source) || !equal(payload.childFence, execution.childFence)) return invalid();
}

export function validateHostMediaResponse(database: DatabaseSync, execution: HostMediaExecutionRecord,
  effect: HostMediaEffectRecord, artifactId: string): HostMediaCompletedResponse {
  const { payload } = readHostMediaReceipt<HostMediaCompletedResponse>(database, execution, artifactId, "media_response_v1");
  if (!effect.launchedAt || effect.noStartArtifactId || payload.effectId !== effect.effectId
    || payload.routeDigest !== effect.routeDigest || payload.wireDigest !== effect.wireDigest
    || payload.responseNamespaceDigest !== execution.namespaceDigest || !mediaFactDigest(payload.bodySha256)
    || !Number.isInteger(payload.httpStatus) || payload.httpStatus < 200 || payload.httpStatus >= 300
    || hostOperationTimestamp(payload.completedAt) < hostOperationTimestamp(effect.launchedAt)
    || (effect.kind === "remote_generation_submit" ? !mediaFactText(payload.externalOperationId) : payload.externalOperationId !== undefined)) return invalid();
  return payload;
}

export function validateHostMediaSubmission(database: DatabaseSync, execution: HostMediaExecutionRecord,
  effects: readonly HostMediaEffectRecord[], artifactId: string): HostMediaSubmission {
  const { payload } = readHostMediaReceipt<HostMediaSubmission>(database, execution, artifactId, "media_submission_v1");
  const effect = effects.find(member => member.effectId === payload.effectId);
  if (execution.protocol === "image_response_v1" || !effect || effect.kind !== "remote_generation_submit"
    || effect.responseArtifactId !== payload.responseArtifactId || !mediaFactText(payload.externalOperationId)
    || !mediaFactDigest(payload.statusRouteDigest)) return invalid();
  if (payload.statusRouteDigests !== undefined && (execution.protocol !== "comfy_prompt_legacy_v1"
    || !Array.isArray(payload.statusRouteDigests) || payload.statusRouteDigests.length !== 3
    || payload.statusRouteDigests[0] !== payload.statusRouteDigest
    || !payload.statusRouteDigests.every(mediaFactDigest) || new Set(payload.statusRouteDigests).size !== 3)) return invalid();
  const response = validateHostMediaResponse(database, execution, effect, payload.responseArtifactId);
  if (response.externalOperationId !== payload.externalOperationId
    || hostOperationTimestamp(payload.completedAt) < hostOperationTimestamp(response.completedAt)) return invalid();
  return payload;
}

export function validateHostMediaTerminal(database: DatabaseSync, execution: HostMediaExecutionRecord,
  effects: readonly HostMediaEffectRecord[], artifactId: string): HostMediaTerminal {
  if (!execution.submissionArtifactId) return invalid();
  const submission = validateHostMediaSubmission(database, execution, effects, execution.submissionArtifactId);
  const { payload } = readHostMediaReceipt<HostMediaTerminal>(database, execution, artifactId, "media_terminal_v1");
  const observation: unknown = payload.observation;
  if (!record(observation) || observation.protocol !== execution.protocol || observation.externalOperationId !== submission.externalOperationId
    || payload.responseNamespaceDigest !== execution.namespaceDigest
    || !(submission.statusRouteDigests ?? [submission.statusRouteDigest]).includes(payload.routeDigest)
    || !mediaFactDigest(payload.bodySha256) || !Number.isInteger(payload.httpStatus) || payload.httpStatus < 200 || payload.httpStatus >= 300
    || hostOperationTimestamp(payload.completedAt) < hostOperationTimestamp(submission.completedAt)) return invalid();
  const raw = observation.rawStatus, outcome = observation.outcome, source = observation.identitySource;
  if (execution.protocol === "seedance_task_v1") {
    if (!["echoed_id", "exact_status_route"].includes(String(source))
      || !((raw === "succeeded" && outcome === "completed") || (raw === "failed" && outcome === "failed"))) return invalid();
  } else if (execution.protocol === "comfy_jobs_v1") {
    if (source !== "echoed_id" || !((raw === "completed" && outcome === "completed") || (raw === "failed" && outcome === "failed")
      || (raw === "cancelled" && outcome === "cancelled"))) return invalid();
  } else if (execution.protocol === "comfy_prompt_legacy_v1") {
    if (source !== "exact_history_key" || !((raw === "success" && outcome === "completed") || (raw === "error" && outcome === "failed"))) return invalid();
  } else return invalid();
  return payload;
}

export function validateHostMediaManifest(database: DatabaseSync, execution: HostMediaExecutionRecord,
  effects: readonly HostMediaEffectRecord[], artifactId: string): HostMediaArtifactManifest {
  const { payload } = readHostMediaReceipt<HostMediaArtifactManifest>(database, execution, artifactId, "media_manifest_v1");
  if (!Array.isArray(payload.items) || !["collected", "collection_failed", "remote_failed", "remote_cancelled"].includes(payload.outcome)) return invalid();
  const terminal = execution.terminalArtifactId ? validateHostMediaTerminal(database, execution, effects, execution.terminalArtifactId) : undefined;
  if ((payload.outcome === "remote_failed" && terminal?.observation.outcome !== "failed")
    || (payload.outcome === "remote_cancelled" && terminal?.observation.outcome !== "cancelled")
    || (terminal && hostOperationTimestamp(payload.completedAt) < hostOperationTimestamp(terminal.completedAt))) return invalid();
  const seen = new Set<string>();
  for (const item of payload.items) {
    if (!record(item) || !mediaFactText(item.artifactId) || seen.has(item.artifactId) || !mediaFactDigest(item.bytesSha256)
      || !mediaFactDigest(item.remoteDescriptorDigest) || typeof item.sizeBytes !== "number" || !Number.isSafeInteger(item.sizeBytes) || item.sizeBytes < 0
      || typeof item.path !== "string" || !item.path || item.path.startsWith("/") || item.path.includes("\\")
      || item.path.split("/").some(part => !part || part === "." || part === "..")
      || typeof item.contentType !== "string" || !item.contentType || typeof item.type !== "string" || !item.type) return invalid();
    seen.add(item.artifactId);
    const row = database.prepare("SELECT * FROM artifacts WHERE id=?").get(item.artifactId);
    let bytesFact: unknown;
    try { bytesFact = JSON.parse(String(row?.sealed_payload_json)); } catch { return invalid(); }
    if (!row || row.media_job_id !== execution.mediaJobId || row.run_id !== null || row.type !== item.type
      || row.path !== item.path || row.content_type !== item.contentType || row.size_bytes !== item.sizeBytes
      || row.created_at !== item.collectedAt || !record(bytesFact) || bytesFact.kind !== "media_bytes_v1"
      || bytesFact.schemaVersion !== 1 || bytesFact.executionId !== execution.executionId || bytesFact.mediaJobId !== execution.mediaJobId
      || bytesFact.bytesSha256 !== item.bytesSha256 || bytesFact.remoteDescriptorDigest !== item.remoteDescriptorDigest
      || bytesFact.path !== item.path || bytesFact.contentType !== item.contentType || bytesFact.sizeBytes !== item.sizeBytes
      || bytesFact.type !== item.type || bytesFact.collectedAt !== item.collectedAt || !mediaFactDigest(row.content_sha256)
      || createHash("sha256").update(JSON.stringify(bytesFact), "utf8").digest("hex") !== row.content_sha256
      || hostOperationTimestamp(item.collectedAt) < hostOperationTimestamp(execution.childBoundAt)
      || hostOperationTimestamp(item.collectedAt) > hostOperationTimestamp(payload.completedAt)) return invalid();
  }
  const all = database.prepare("SELECT id FROM artifacts WHERE media_job_id=?").all(execution.mediaJobId);
  if (all.length !== seen.size || all.some(row => !seen.has(String(row.id)))) return invalid();
  if (payload.outcome === "collected" && (terminal && terminal.observation.outcome !== "completed"
    || !payload.items.some(item => item.type === (execution.operation === "video_generate" ? "video" : "image") && item.sizeBytes > 0))) return invalid();
  return payload;
}

export function validateHostMediaNoStart(database: DatabaseSync, execution: HostMediaExecutionRecord,
  effect: HostMediaEffectRecord, artifactId: string): HostMediaEffectNoStart {
  const { payload } = readHostMediaReceipt<HostMediaEffectNoStart>(database, execution, artifactId, "media_effect_no_start_v1");
  if (payload.effectId !== effect.effectId || effect.launchedAt || effect.responseArtifactId
    || hostOperationTimestamp(payload.completedAt) < hostOperationTimestamp(effect.preparedAt)) return invalid();
  return payload;
}

/** Independently verifies the exact scope. No mutable business job/handle status is safety authority. */
export function verifyHostMediaReceipt(database: DatabaseSync, operation: HostOperationRecord): string {
  const execution = operation.evidenceRef && readHostMediaExecution(database, operation.evidenceRef.id);
  if (!execution || !operation.settledAt || !execution.finalizationArtifactId || !execution.manifestArtifactId) return invalid();
  const effects = readHostMediaEffects(database, execution);
  const finalization = readHostMediaReceipt<HostMediaLocalFinalization>(database, execution, execution.finalizationArtifactId, "media_finalization_v1");
  const manifest = validateHostMediaManifest(database, execution, effects, execution.manifestArtifactId);
  const expected = effects.map(effect => ({ effectId: effect.effectId, ...(effect.responseArtifactId ? { responseArtifactId: effect.responseArtifactId } : {}),
    ...(effect.noStartArtifactId ? { noStartArtifactId: effect.noStartArtifactId } : {}) }));
  if (!equal(finalization.payload.effects, expected) || finalization.payload.submissionArtifactId !== execution.submissionArtifactId
    || finalization.payload.terminalArtifactId !== execution.terminalArtifactId || finalization.payload.manifestArtifactId !== execution.manifestArtifactId
    || hostOperationTimestamp(finalization.payload.completedAt) < hostOperationTimestamp(manifest.completedAt)
    || hostOperationTimestamp(finalization.createdAt) > hostOperationTimestamp(operation.settledAt)) return invalid();
  const child = database.prepare("SELECT status,ended_at FROM work_unit_attempts WHERE id=?").get(execution.childFence!.attemptId);
  if (!child || !["succeeded", "failed", "cancelled", "lost"].includes(String(child.status)) || !child.ended_at
    || hostOperationTimestamp(child.ended_at) < hostOperationTimestamp(execution.childBoundAt)
    || hostOperationTimestamp(child.ended_at) > hostOperationTimestamp(finalization.payload.completedAt)) return invalid();
  const effectDigests = effects.map(effect => {
    if (!!effect.responseArtifactId === !!effect.noStartArtifactId) return invalid();
    const fact = effect.responseArtifactId
      ? (validateHostMediaResponse(database, execution, effect, effect.responseArtifactId), readHostMediaReceipt(database, execution, effect.responseArtifactId, "media_response_v1"))
      : (validateHostMediaNoStart(database, execution, effect, effect.noStartArtifactId!), readHostMediaReceipt(database, execution, effect.noStartArtifactId, "media_effect_no_start_v1"));
    if (hostOperationTimestamp(fact.createdAt) > hostOperationTimestamp(finalization.payload.completedAt)) return invalid();
    return { effectId: effect.effectId, hash: fact.hash };
  });
  const noStart = operation.settlementKind === "known_no_start";
  if (noStart) {
    if (effects.some(effect => effect.launchedAt) || execution.submissionArtifactId || execution.terminalArtifactId || manifest.outcome !== "collection_failed") return invalid();
  } else {
    const generation = effects.filter(effect => effect.kind !== "comfy_image_upload");
    if (generation.length !== 1 || !generation[0]!.responseArtifactId || !operation.launchedAt) return invalid();
    if (execution.protocol === "image_response_v1") {
      if (execution.submissionArtifactId || execution.terminalArtifactId || !["collected", "collection_failed"].includes(manifest.outcome)) return invalid();
    } else {
      if (!execution.submissionArtifactId || !execution.terminalArtifactId) return invalid();
      validateHostMediaSubmission(database, execution, effects, execution.submissionArtifactId);
      const terminal = validateHostMediaTerminal(database, execution, effects, execution.terminalArtifactId);
      if (terminal.observation.outcome === "failed" && manifest.outcome !== "remote_failed"
        || terminal.observation.outcome === "cancelled" && manifest.outcome !== "remote_cancelled") return invalid();
    }
  }
  const expectedKind = operation.evidenceRef!.kind === "media_chain_execution" ? "media_chain_completed"
    : execution.protocol === "image_response_v1" ? "media_response_completed" : "media_remote_terminal";
  if (!noStart && operation.settlementKind !== expectedKind) return invalid();
  return digestHarnessToolValue({ identityDigest: execution.identityDigest, childFence: execution.childFence,
    effectDigests, finalizationHash: finalization.hash,
    submissionHash: execution.submissionArtifactId ? readHostMediaReceipt(database, execution, execution.submissionArtifactId, "media_submission_v1").hash : undefined,
    terminalHash: execution.terminalArtifactId ? readHostMediaReceipt(database, execution, execution.terminalArtifactId, "media_terminal_v1").hash : undefined,
    manifestHash: readHostMediaReceipt(database, execution, execution.manifestArtifactId, "media_manifest_v1").hash });
}

/** Binding checks are scoped; parent and producer must not alias one generic receipt. */
export function hostMediaOperationDomainIdentity(database: DatabaseSync, operation: HostOperationRecord, binding: boolean): string {
  const execution = operation.evidenceRef && readHostMediaExecution(database, operation.evidenceRef.id);
  if (!execution || operation.kind !== "media" || (operation.evidenceRef!.kind === "media_chain_execution"
    ? execution.parentOperationId !== operation.operationId : execution.transportOperationId !== operation.operationId)) return invalid();
  if (binding && (execution.childFence || readHostMediaEffects(database, execution).length)) return invalid();
  return digestHarnessToolValue({ scope: operation.evidenceRef!.kind, executionIdentityDigest: execution.identityDigest });
}
