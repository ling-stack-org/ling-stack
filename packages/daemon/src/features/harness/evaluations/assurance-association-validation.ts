import { createHash } from "node:crypto";
import { RUN_EVALUATION_GRADER_TYPES } from "@ling-stack/contracts";
import { digestRunEvaluationValue, runEvaluationIdempotencyKey, type RunEvaluationIdentityInput } from "@ling-stack/core";
import {
  ASSOCIATION_IDENTITY_FIELDS, FROZEN_INPUT_KEYS,
  type AssociationCode, type AssuranceEvaluationAssociationRequest, type AssuranceEvaluationReadPorts,
  type AssociationJsonValue, type FrozenAssociationDefinitions, type FrozenInputKey, type HostAssociationSource,
} from "./assurance-association-contract.js";
import {
  projectionArray, projectionDigest, projectionEvaluationKey, projectionIdentity,
  projectionRecord, validateProjectionArtifactRef, validateProjectionJson,
} from "./storage-projection-validation.js";

const TASK_IDENTITY_FIELDS = ["suiteId", "suiteVersion", "taskId", "taskVersion"] as const;
const COMPARISON_FIELDS = ["model", "reasoning", "executionStrategy", "node", "platform", "arch"] as const;
const RUN_STATUSES = ["queued", "running", "waiting_for_approval", "yielded", "succeeded", "failed", "cancelled"];
const WORK_UNIT_STATUSES = ["queued", "claimed", "running", "waiting_for_approval", "waiting_for_input", "cancelling", "succeeded", "failed", "cancelled", "stale"];
const ATTEMPT_STATUSES = ["created", "started", "waiting_for_approval", "cancelling", "yielded", "succeeded", "failed", "cancelled", "lost"];
const MAX_FROZEN_BYTES = 1_048_576;
const typedArrayByteLength = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), "byteLength")!.get!;

export class AssociationRefusal extends Error {
  constructor(readonly code: AssociationCode) {
    super(code);
    this.name = "AssociationRefusal";
  }
}

export function refuseAssociation(code: AssociationCode): never {
  throw new AssociationRefusal(code);
}

function checked<T>(code: AssociationCode, read: () => T): T {
  try { return read(); }
  catch (error) {
    if (error instanceof AssociationRefusal) throw error;
    return refuseAssociation(code);
  }
}

function requireAssociation(condition: unknown, code: AssociationCode): asserts condition {
  if (!condition) refuseAssociation(code);
}

function validateTaskIdentity(value: unknown): void {
  const identity = projectionRecord(value, TASK_IDENTITY_FIELDS);
  for (const field of TASK_IDENTITY_FIELDS) projectionIdentity(identity[field]);
}

function validateInputDigests(value: unknown): void {
  const digests = projectionRecord(value, FROZEN_INPUT_KEYS);
  for (const field of FROZEN_INPUT_KEYS) projectionDigest(digests[field]);
}

function validateComparison(value: unknown): void {
  const comparison = projectionRecord(value, COMPARISON_FIELDS);
  for (const field of COMPARISON_FIELDS) projectionIdentity(comparison[field]);
}

function validateCommit(value: unknown): void {
  requireAssociation(typeof value === "string" && /^[a-f0-9]{40}$/u.test(value), "association.invalid_request");
}

function validateHostSourceShape(value: unknown, code: AssociationCode): void {
  const source = projectionRecord(value, ["comparison", "execution", "snapshots", "artifacts"]);
  validateComparison(source.comparison);
  const execution = projectionRecord(source.execution, ["runId", "workUnitId", "attemptId", "runtimeInstanceId",
    "fencingToken", "runStatus", "workUnitStatus", "attemptStatus", "claimStatus", "effectStatus"]);
  for (const key of ["runId", "workUnitId", "attemptId", "runtimeInstanceId", "fencingToken"]) projectionIdentity(execution[key]);
  if (!RUN_STATUSES.includes(execution.runStatus as string)
    || !WORK_UNIT_STATUSES.includes(execution.workUnitStatus as string)
    || !ATTEMPT_STATUSES.includes(execution.attemptStatus as string)
    || !["unclaimed", "held", "expired", "terminal_retained"].includes(execution.claimStatus as string)
    || !["none", "confirmed", "unknown"].includes(execution.effectStatus as string)) {
    refuseAssociation(code);
  }
  const snapshots = projectionRecord(source.snapshots, ["run", "workUnit", "attempt"]);
  for (const key of ["run", "workUnit", "attempt"]) {
    const snapshot = projectionRecord(snapshots[key], ["revision", "sha256"]);
    requireAssociation(Number.isSafeInteger(snapshot.revision) && (snapshot.revision as number) >= 0,
      code);
    projectionDigest(snapshot.sha256);
  }
  const artifacts = projectionArray(source.artifacts, 100);
  requireAssociation(artifacts.length > 0, code);
  const ids = new Set<unknown>();
  for (const item of artifacts) {
    const artifact = projectionRecord(item, ["role", "artifactId", "contentSha256"]);
    projectionIdentity(artifact.role); projectionIdentity(artifact.artifactId); projectionDigest(artifact.contentSha256);
    requireAssociation(!ids.has(artifact.artifactId), code);
    ids.add(artifact.artifactId);
  }
}

export function validateAssociationHostSource(value: unknown): asserts value is HostAssociationSource {
  checked("association.host_source_unavailable", () => {
    validateProjectionJson(value);
    validateHostSourceShape(value, "association.host_source_unavailable");
  });
}

/** Validate the complete request without consulting any read port. */
export function validateAssociationRequest(value: unknown): asserts value is AssuranceEvaluationAssociationRequest {
  checked("association.invalid_request", () => {
    validateProjectionJson(value);
    const request = projectionRecord(value, ["schemaVersion", "observation", "source", "evaluationId",
      "evaluationKey", "mapping", "mappingDigest", "gradePins"]);
    requireAssociation(request.schemaVersion === 1, "association.invalid_request");
    projectionIdentity(request.evaluationId); projectionEvaluationKey(request.evaluationKey); projectionDigest(request.mappingDigest);
    validateHostSourceShape(request.source, "association.invalid_request");
    const observation = projectionRecord(request.observation, ["observationId", "invocationId", "caseId",
      "taskIdentity", "sourceCommit", "inputDigests", "comparison", "evidenceKind", "assessment"]);
    for (const field of ["observationId", "invocationId", "caseId"]) projectionIdentity(observation[field]);
    validateTaskIdentity(observation.taskIdentity); validateInputDigests(observation.inputDigests);
    validateComparison(observation.comparison); validateCommit(observation.sourceCommit);
    requireAssociation(observation.assessment === "not_assessed"
      && ["live_execution", "fixture_replay"].includes(observation.evidenceKind as string), "association.invalid_request");

    const mapping = projectionRecord(request.mapping, ["schemaVersion", "kind", "definitionEncoding", "taskIdentity",
      "observationCaseId", "sourceCommit", "inputDigests", "evaluationIdentity", "candidate"]);
    requireAssociation(mapping.schemaVersion === 1 && mapping.kind === "assurance_evaluation_mapping"
      && mapping.definitionEncoding === "json_parse_stringify_v1", "association.invalid_request");
    validateTaskIdentity(mapping.taskIdentity); validateInputDigests(mapping.inputDigests); validateCommit(mapping.sourceCommit);
    projectionIdentity(mapping.observationCaseId);
    const identity = projectionRecord(mapping.evaluationIdentity, ASSOCIATION_IDENTITY_FIELDS);
    for (const field of ASSOCIATION_IDENTITY_FIELDS) {
      if (field.endsWith("Digest")) projectionDigest(identity[field]);
      else projectionIdentity(identity[field]);
    }
    const candidate = projectionRecord(mapping.candidate, ["role", "artifactId", "contentSha256"]);
    projectionIdentity(candidate.role); projectionIdentity(candidate.artifactId); projectionDigest(candidate.contentSha256);
    const grades = projectionArray(request.gradePins, 8), gradeIds = new Set<unknown>();
    for (const value of grades) {
      const pin = projectionRecord(value, ["gradeId", "gradeDigest", "graderType", "graderId", "graderVersion",
        "rawOutputArtifact", "rationaleArtifact"], ["rawOutputArtifact", "rationaleArtifact"]);
      for (const field of ["gradeId", "graderId", "graderVersion"]) projectionIdentity(pin[field]);
      projectionDigest(pin.gradeDigest);
      requireAssociation((RUN_EVALUATION_GRADER_TYPES as readonly unknown[]).includes(pin.graderType)
        && !gradeIds.has(pin.gradeId), "association.invalid_request");
      gradeIds.add(pin.gradeId);
      for (const field of ["rawOutputArtifact", "rationaleArtifact"]) {
        if (Object.hasOwn(pin, field)) validateProjectionArtifactRef(pin[field]);
      }
    }
    requireAssociation(digestRunEvaluationValue(mapping) === request.mappingDigest, "association.mapping_mismatch");
    requireAssociation(runEvaluationIdempotencyKey(identity as unknown as RunEvaluationIdentityInput) === request.evaluationKey,
      "association.evaluation_identity_mismatch");
    const source = request.source as HostAssociationSource;
    requireAssociation(identity.runId === source.execution.runId, "association.lineage_mismatch");
    requireAssociation(candidate.artifactId === identity.candidateArtifactId && candidate.contentSha256 === identity.candidateDigest
      && source.artifacts.some(pin => pin.artifactId === candidate.artifactId
        && pin.role === candidate.role && pin.contentSha256 === candidate.contentSha256), "association.mapping_mismatch");
    const task = mapping.taskIdentity as Record<string, unknown>, observedTask = observation.taskIdentity as Record<string, unknown>;
    requireAssociation(TASK_IDENTITY_FIELDS.every(key => task[key] === observedTask[key])
      && observation.caseId === mapping.observationCaseId && observation.sourceCommit === mapping.sourceCommit
      && identity.suiteId === task.suiteId && identity.suiteVersion === task.suiteVersion
      && FROZEN_INPUT_KEYS.every(key => (mapping.inputDigests as Record<string, unknown>)[key]
        === (observation.inputDigests as Record<string, unknown>)[key])
      && COMPARISON_FIELDS.every(key => (observation.comparison as Record<string, unknown>)[key] === source.comparison[key]),
    "association.mapping_mismatch");
  });
}

function frozenRecord(value: unknown, required: readonly string[]): Record<string, unknown> {
  requireAssociation(value !== null && typeof value === "object" && !Array.isArray(value), "association.frozen_input_mismatch");
  return projectionRecord(value, [...new Set([...Object.keys(value), ...required])]);
}

function frozenReference(value: unknown): Record<string, unknown> {
  const ref = projectionRecord(value, ["path", "sha256", "mediaType"]);
  projectionDigest(ref.sha256);
  requireAssociation(typeof ref.path === "string" && ref.path.length <= 1024
    && /^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/u.test(ref.path)
    && ref.path.split("/").every(part => part !== "" && part !== "." && part !== "..")
    && ref.mediaType === "application/json", "association.frozen_input_mismatch");
  return ref;
}

function jsonBytes(value: unknown): string {
  const json = JSON.stringify(value);
  requireAssociation(typeof json === "string" && Buffer.byteLength(json, "utf8") <= MAX_FROZEN_BYTES,
    "association.frozen_input_mismatch");
  return createHash("sha256").update(json, "utf8").digest("hex");
}

/** Check raw byte pins and association references; definitions keep their parsed property order. */
export function validateFrozenAssociationInputs(
  ports: Pick<AssuranceEvaluationReadPorts, "getFrozenInput">,
  request: AssuranceEvaluationAssociationRequest,
): FrozenAssociationDefinitions {
  validateAssociationRequest(request);
  return checked("association.frozen_input_mismatch", () => {
    const parsed: Partial<Record<FrozenInputKey, AssociationJsonValue>> = {};
    let total = 0;
    for (const key of FROZEN_INPUT_KEYS) {
      const input = checked("association.read_failed", () => ports.getFrozenInput(key));
      if (input === undefined) refuseAssociation("association.frozen_input_missing");
      requireAssociation(input instanceof Uint8Array, "association.frozen_input_mismatch");
      const length = typedArrayByteLength.call(input) as number;
      total += length;
      requireAssociation(length <= MAX_FROZEN_BYTES && total <= MAX_FROZEN_BYTES * FROZEN_INPUT_KEYS.length,
        "association.frozen_input_mismatch");
      const bytes = new Uint8Array(length);
      Uint8Array.prototype.set.call(bytes, input);
      const rawDigest = createHash("sha256").update(bytes).digest("hex");
      requireAssociation(rawDigest === request.mapping.inputDigests[key] && rawDigest === request.observation.inputDigests[key],
        "association.frozen_input_mismatch");
      const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      if (key !== "lockBytes") {
        const value: unknown = JSON.parse(text);
        validateProjectionJson(value);
        parsed[key] = value as AssociationJsonValue;
      }
    }

    const suite = frozenRecord(parsed.suiteBytes, ["schemaVersion", "suiteId", "suiteVersion", "tasks"]);
    const task = frozenRecord(parsed.taskBytes, ["schemaVersion", "taskId", "taskVersion", "source", "ruleCase", "expected", "validationProfile"]);
    const identity = request.mapping.taskIdentity;
    requireAssociation(suite.schemaVersion === 1 && task.schemaVersion === 1
      && suite.suiteId === identity.suiteId && suite.suiteVersion === identity.suiteVersion
      && task.taskId === identity.taskId && task.taskVersion === identity.taskVersion, "association.frozen_input_mismatch");
    const tasks = projectionArray(suite.tasks, 100), taskIds = new Set<unknown>();
    requireAssociation(tasks.length > 0, "association.frozen_input_mismatch");
    let selected = 0;
    for (const value of tasks) {
      const entry = projectionRecord(value, ["taskId", "taskVersion", "task"]);
      projectionIdentity(entry.taskId); projectionIdentity(entry.taskVersion);
      requireAssociation(!taskIds.has(entry.taskId), "association.frozen_input_mismatch");
      taskIds.add(entry.taskId);
      const reference = frozenReference(entry.task);
      if (entry.taskId === identity.taskId && entry.taskVersion === identity.taskVersion) {
        selected += 1;
        requireAssociation(reference.sha256 === request.mapping.inputDigests.taskBytes, "association.frozen_input_mismatch");
      }
    }
    requireAssociation(selected === 1, "association.frozen_input_mismatch");
    const source = frozenRecord(task.source, ["commit", "lockSha256"]);
    requireAssociation(source.commit === request.mapping.sourceCommit
      && source.lockSha256 === request.mapping.inputDigests.lockBytes, "association.frozen_input_mismatch");
    for (const [field, key] of [["ruleCase", "ruleBytes"], ["expected", "expectedBytes"]] as const) {
      requireAssociation(frozenReference(task[field]).sha256 === request.mapping.inputDigests[key], "association.frozen_input_mismatch");
    }
    const profileRef = frozenRecord(task.validationProfile, ["id", "version", "artifact"]);
    projectionIdentity(profileRef.id); projectionIdentity(profileRef.version);
    requireAssociation(frozenReference(profileRef.artifact).sha256 === request.mapping.inputDigests.profileBytes,
      "association.frozen_input_mismatch");
    const profile = frozenRecord(parsed.profileBytes, ["schemaVersion", "profileId", "profileVersion"]);
    requireAssociation(profile.schemaVersion === 1 && profile.profileId === profileRef.id
      && profile.profileVersion === profileRef.version, "association.frozen_input_mismatch");

    const evaluation = request.mapping.evaluationIdentity;
    requireAssociation(jsonBytes(suite) === evaluation.suiteDigest && jsonBytes(parsed.ruleBytes) === evaluation.caseDigest
      && jsonBytes(parsed.expectedBytes) === evaluation.baselineDigest, "association.mapping_mismatch");
    return {
      suite: suite as Readonly<Record<string, AssociationJsonValue>>,
      rule: parsed.ruleBytes!,
      expected: parsed.expectedBytes!,
    };
  });
}
