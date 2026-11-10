import { RunEvaluationInputError } from "@ling-stack/core";
import type {
  ShadowPromotionArtifactRef, ShadowPromotionCorpusManifest, ShadowPromotionGradeRef,
  StoredShadowPromotionRequest,
} from "./storage-projection-contract.js";

/** Only plain, owned data properties; never execute an artifact/request accessor. */
export function projectionRecord(value: unknown, fields: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid("input record is invalid");
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !fields.includes(key)) invalid("input field is invalid");
    projectionField(value, key);
  }
  for (const key of fields)
    if (!Object.hasOwn(value, key) && (!optional.includes(key) || key in value)) invalid("input field requires an owned data property");
  return value as Record<string, unknown>;
}

export function projectionField(value: object, field: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, field);
  if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalid("input requires an owned data property");
  return descriptor.value;
}

export function projectionArray(value: unknown, limit: number): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > limit
    || Reflect.ownKeys(value).length !== value.length + 1) invalid("input array bound or shape is invalid");
  for (let index = 0; index < value.length; index += 1) projectionField(value, String(index));
  return value;
}

export function projectionIdentity(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.length || value.length > 500 || value.trim() !== value) invalid("input identity is invalid");
}

export function projectionDigest(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) invalid("input digest is invalid");
}

export function projectionEvaluationKey(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^run-evaluation:[a-f0-9]{64}$/u.test(value)) invalid("input evaluation key is invalid");
}

export function validateProjectionArtifactRef(value: unknown): asserts value is ShadowPromotionArtifactRef {
  const ref = projectionRecord(value, ["artifactId", "contentSha256"]);
  projectionIdentity(ref.artifactId); projectionDigest(ref.contentSha256);
}

function validateGradeRef(value: unknown): asserts value is ShadowPromotionGradeRef {
  const ref = projectionRecord(value, ["gradeId", "gradeDigest", "rawOutputArtifact", "rationaleArtifact"],
    ["rawOutputArtifact", "rationaleArtifact"]);
  projectionIdentity(ref.gradeId); projectionDigest(ref.gradeDigest);
  for (const field of ["rawOutputArtifact", "rationaleArtifact"])
    if (Object.hasOwn(ref, field)) validateProjectionArtifactRef(ref[field]);
}

export function validateStoredProjectionRequest(value: unknown): asserts value is StoredShadowPromotionRequest {
  const request = projectionRecord(value, ["schemaVersion", "rootRunId", "manifestArtifact"]);
  if (request.schemaVersion !== 1) invalid("input schema is invalid");
  projectionIdentity(request.rootRunId); validateProjectionArtifactRef(request.manifestArtifact);
}

export function validateProjectionManifest(value: unknown): asserts value is ShadowPromotionCorpusManifest {
  const manifest = projectionRecord(value, ["schemaVersion", "kind", "rootRunId", "frozenGraderArtifact", "frozenGraderDigest", "cases"]);
  if (manifest.schemaVersion !== 1 || manifest.kind !== "shadow_promotion_corpus") invalid("input manifest schema is invalid");
  projectionIdentity(manifest.rootRunId); projectionDigest(manifest.frozenGraderDigest);
  validateProjectionArtifactRef(manifest.frozenGraderArtifact);
  const rows = projectionArray(manifest.cases, 500);
  const evaluations = new Set<string>(), grades = new Set<string>();
  for (const value of rows) {
    const row = projectionRecord(value, ["evaluationId", "evaluationKey", "modelGrade", "humanGrade"], ["modelGrade", "humanGrade"]);
    projectionIdentity(row.evaluationId); projectionEvaluationKey(row.evaluationKey);
    if (evaluations.has(row.evaluationId)) invalid("input repeated evaluation is invalid");
    evaluations.add(row.evaluationId);
    for (const field of ["modelGrade", "humanGrade"] as const) {
      if (!Object.hasOwn(row, field)) continue;
      const grade = row[field]; validateGradeRef(grade);
      if (grades.has(grade.gradeId)) invalid("input repeated grade is invalid");
      grades.add(grade.gradeId);
    }
  }
}

/** Bound serialized artifacts before stringify/hash, including plain JSON shape and depth. */
export function validateProjectionJson(value: unknown): void {
  let nodes = 0, characters = 0;
  const seen = new Set<object>();
  function visit(item: unknown, depth: number): void {
    if (++nodes > 100_000 || depth > 64) invalid("input artifact tree limit exceeded");
    if (item === null || typeof item === "boolean") return;
    if (typeof item === "number" && Number.isFinite(item)) return;
    if (typeof item === "string") {
      characters += item.length;
      if (characters > 1_048_576) invalid("input artifact character limit exceeded");
      return;
    }
    if (!item || typeof item !== "object" || seen.has(item)) invalid("input artifact is not plain JSON");
    seen.add(item);
    if (Array.isArray(item)) {
      for (const child of projectionArray(item, 100_000)) visit(child, depth + 1);
    } else {
      if (![Object.prototype, null].includes(Object.getPrototypeOf(item))) invalid("input artifact is not plain JSON");
      for (const key of Reflect.ownKeys(item)) {
        if (typeof key !== "string") invalid("input artifact field is invalid");
        characters += key.length;
        if (characters > 1_048_576) invalid("input artifact character limit exceeded");
        visit(projectionField(item, key), depth + 1);
      }
    }
    seen.delete(item);
  }
  visit(value, 0);
}

function invalid(message: string): never { throw new RunEvaluationInputError(message); }
