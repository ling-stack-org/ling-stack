import {
  companionEventTypes,
  companionPhases,
  companionStatuses,
  normalizeCompanionBehaviorPolicy,
  normalizeCompanionManifest,
  type CompanionInteractionRequest,
  type CompanionMessageRequest,
  type CompanionProactiveRequest,
  type CreateCompanionInput,
  type UpdateCompanionInput,
} from "@ling-stack/core";
import {
  isRecord,
  readOptionalBoolean,
  readOptionalNumber,
  readOptionalObject,
  readOptionalString,
  readString,
} from "../../shared/validation.js";

export function parseCreateCompanionInput(value: unknown): CreateCompanionInput {
  if (!isRecord(value)) throw new Error("Companion request must be a JSON object");
  const manifestValue = readOptionalObject(value, "manifest");
  const behaviorValue = readOptionalObject(value, "behaviorPolicy");
  return {
    id: readOptionalString(value, "id"),
    teammateId: readString(value, "teammateId"),
    displayName: readString(value, "displayName"),
    description: readOptionalString(value, "description"),
    manifest: manifestValue ? parseManifest(manifestValue) : undefined,
    behaviorPolicy: behaviorValue ? parseBehaviorPolicy(behaviorValue) : undefined,
  };
}

export function parseUpdateCompanionInput(value: unknown): UpdateCompanionInput {
  if (!isRecord(value)) throw new Error("Companion update must be a JSON object");
  const manifestValue = readOptionalObject(value, "manifest");
  const behaviorValue = readOptionalObject(value, "behaviorPolicy");
  const status = readOptionalString(value, "status");
  if (status !== undefined && !companionStatuses.includes(status as (typeof companionStatuses)[number])) {
    throw new Error(`status must be one of: ${companionStatuses.join(", ")}`);
  }
  return {
    displayName: readOptionalString(value, "displayName"),
    description: readOptionalString(value, "description"),
    manifest: manifestValue ? parseManifest(manifestValue) : undefined,
    behaviorPolicy: behaviorValue ? parseBehaviorPolicy(behaviorValue) : undefined,
    status: status as UpdateCompanionInput["status"],
  };
}

export function parseCompanionStatus(value: string | null): (typeof companionStatuses)[number] | undefined {
  if (value === null) return undefined;
  if (!companionStatuses.includes(value as (typeof companionStatuses)[number])) {
    throw new Error(`status must be one of: ${companionStatuses.join(", ")}`);
  }
  return value as (typeof companionStatuses)[number];
}

export function parseCompanionInteractionRequest(value: unknown): CompanionInteractionRequest {
  if (!isRecord(value)) throw new Error("Companion interaction must be a JSON object");
  const type = readString(value, "type");
  const allowed = companionEventTypes.filter((entry) => entry !== "message" && entry !== "memory_candidate" && entry !== "proactive_prompt");
  if (!allowed.includes(type as (typeof allowed)[number])) {
    throw new Error(`type must be one of: ${allowed.join(", ")}`);
  }
  const phase = readOptionalString(value, "phase");
  if (phase !== undefined && !companionPhases.includes(phase as (typeof companionPhases)[number])) {
    throw new Error(`phase must be one of: ${companionPhases.join(", ")}`);
  }
  const payload = readOptionalObject(value, "payload");
  return {
    type: type as CompanionInteractionRequest["type"],
    emotionId: readOptionalString(value, "emotionId"),
    emotionIntensity: readOptionalNumber(value, "emotionIntensity"),
    actionId: readOptionalString(value, "actionId"),
    phase: phase as CompanionInteractionRequest["phase"],
    energy: readOptionalNumber(value, "energy"),
    payload,
  };
}

export function parseCompanionMessageRequest(value: unknown): CompanionMessageRequest {
  if (!isRecord(value)) throw new Error("Companion message must be a JSON object");
  const idempotencyKey = readOptionalString(value, "idempotencyKey");
  if (idempotencyKey !== undefined && idempotencyKey.trim().length > 200) {
    throw new Error("idempotencyKey must be at most 200 characters");
  }
  return {
    body: readString(value, "body"),
    ...(idempotencyKey?.trim() ? { idempotencyKey: idempotencyKey.trim() } : {}),
  };
}

export function parseCompanionProactiveRequest(value: unknown | undefined): CompanionProactiveRequest {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Error("Companion proactive request must be a JSON object");
  const idempotencyKey = readOptionalString(value, "idempotencyKey");
  if (idempotencyKey !== undefined && idempotencyKey.trim().length > 200) {
    throw new Error("idempotencyKey must be at most 200 characters");
  }
  return {
    force: readOptionalBoolean(value, "force"),
    ...(idempotencyKey?.trim() ? { idempotencyKey: idempotencyKey.trim() } : {}),
  };
}

function parseManifest(value: Record<string, unknown>) {
  const emotions = readManifestEntries(value, "emotions");
  const actions = readManifestEntries(value, "actions");
  const version = value.version;
  if (version !== 1) throw new Error("manifest.version must be 1");
  return normalizeCompanionManifest({
    version: 1,
    defaultEmotionId: readString(value, "defaultEmotionId"),
    emotions: emotions.map((entry) => ({
      id: readString(entry, "id"),
      label: readString(entry, "label"),
      description: readOptionalString(entry, "description"),
    })),
    actions: actions.map((entry) => ({
      id: readString(entry, "id"),
      label: readString(entry, "label"),
      description: readOptionalString(entry, "description"),
      cooldownMs: readOptionalNumber(entry, "cooldownMs"),
    })),
  });
}

function parseBehaviorPolicy(value: Record<string, unknown>) {
  const quietHours = value.quietHours;
  let parsedQuietHours: readonly [number, number] | undefined;
  if (quietHours !== undefined) {
    if (!Array.isArray(quietHours) || quietHours.length !== 2 || quietHours.some((hour) => typeof hour !== "number")) {
      throw new Error("behaviorPolicy.quietHours must contain exactly two numbers");
    }
    parsedQuietHours = [quietHours[0] as number, quietHours[1] as number];
  }
  return normalizeCompanionBehaviorPolicy({
    proactiveEnabled: readOptionalBoolean(value, "proactiveEnabled"),
    cooldownMs: readOptionalNumber(value, "cooldownMs"),
    quietHours: parsedQuietHours,
  });
}

function readManifestEntries(value: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const entries = value[key];
  if (!Array.isArray(entries) || entries.length === 0 || entries.some((entry) => !isRecord(entry))) {
    throw new Error(`manifest.${key} must be a non-empty array of objects`);
  }
  return entries as Record<string, unknown>[];
}
