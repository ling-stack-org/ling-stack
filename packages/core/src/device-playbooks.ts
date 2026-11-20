import type {
  DeviceActionRequestV1,
  DeviceKindV1,
  DeviceTaskV1,
  JsonValue,
} from "@ling-stack/contracts";
import { type DeviceCapabilityBroker, type DeviceSupportStoreAttemptRecord } from "./device-support.js";

export const DEVICE_PLAYBOOK_MAX_STEPS_V1 = 32 as const;

export interface DevicePlaybookStepV1 {
  readonly id: string;
  readonly capabilityId: string;
  readonly input: JsonValue;
  readonly expectedVerification?: JsonValue;
}

export interface DevicePlaybookV1 {
  readonly id: string;
  readonly version: string;
  readonly displayName: string;
  readonly supportedDeviceKinds: readonly DeviceKindV1[];
  readonly riskClass: "read_only" | "reversible" | "mutating";
  readonly localFallback: boolean;
  readonly steps: readonly DevicePlaybookStepV1[];
}

export interface DevicePlaybookRunResultV1 {
  readonly playbookId: string;
  readonly status: "succeeded" | "partial" | "failed" | "unknown";
  readonly attempts: readonly DeviceSupportStoreAttemptRecord[];
  readonly failedStepId?: string;
}

export function isDevicePlaybookV1(value: unknown): value is DevicePlaybookV1 {
  if (!isRecord(value) || !hasOnlyKeys(value, ["id", "version", "displayName", "supportedDeviceKinds", "riskClass", "localFallback", "steps"])) return false;
  if (!isBoundedString(value.id) || !isBoundedString(value.version) || !isBoundedString(value.displayName)
    || !Array.isArray(value.supportedDeviceKinds) || value.supportedDeviceKinds.length === 0
    || !value.supportedDeviceKinds.every(item => typeof item === "string")
    || !["read_only", "reversible", "mutating"].includes(value.riskClass as string)
    || typeof value.localFallback !== "boolean"
    || !Array.isArray(value.steps) || value.steps.length === 0 || value.steps.length > DEVICE_PLAYBOOK_MAX_STEPS_V1) return false;
  const ids = new Set<string>();
  return value.steps.every(step => {
    if (!isRecord(step) || !hasOnlyKeys(step, ["id", "capabilityId", "input", "expectedVerification"])
      || !isBoundedString(step.id) || ids.has(step.id) || !isBoundedString(step.capabilityId)
      || !isJsonValue(step.input) || (step.expectedVerification !== undefined && !isJsonValue(step.expectedVerification))) return false;
    ids.add(step.id);
    return true;
  });
}

export async function runDeviceReadOnlyPlaybook(input: {
  readonly broker: DeviceCapabilityBroker;
  readonly task: DeviceTaskV1;
  readonly targetDeviceId: string;
  readonly capabilitySnapshotId: string;
  readonly playbook: DevicePlaybookV1;
  readonly now?: () => string;
}): Promise<DevicePlaybookRunResultV1> {
  if (!isDevicePlaybookV1(input.playbook)) throw new Error("Invalid device playbook");
  if (input.playbook.riskClass !== "read_only") throw new Error("Read-only playbook runner refuses mutating steps");
  const attempts: DeviceSupportStoreAttemptRecord[] = [];
  for (const step of input.playbook.steps) {
    const request: DeviceActionRequestV1 = {
      actionId: `${input.task.id}:${step.id}`,
      taskId: input.task.id,
      targetDeviceId: input.targetDeviceId,
      capabilityId: step.capabilityId,
      capabilitySchemaVersion: "1.0",
      capabilitySnapshotId: input.capabilitySnapshotId,
      normalizedInput: step.input,
      idempotencyKey: `${input.task.id}:${step.id}`,
      expectedVerification: step.expectedVerification,
    };
    try {
      const attempt = await input.broker.execute(request, undefined, { finalizeTask: false });
      attempts.push(attempt);
      if (attempt.attempt.status === "unknown" || attempt.attempt.receipt?.status === "uncertain") {
        return { playbookId: input.playbook.id, status: "unknown", attempts, failedStepId: step.id };
      }
      if (attempt.attempt.receipt?.status !== "completed") {
        return { playbookId: input.playbook.id, status: "failed", attempts, failedStepId: step.id };
      }
    } catch {
      return { playbookId: input.playbook.id, status: "failed", attempts, failedStepId: step.id };
    }
  }
  input.broker.store.transitionTask(input.task.id, "succeeded", {}, (input.now ?? (() => new Date().toISOString()))());
  return { playbookId: input.playbook.id, status: "succeeded", attempts };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every(key => allowed.has(key));
}

function isBoundedString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}
