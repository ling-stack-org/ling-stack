import {
  DEVICE_KINDS_V1,
  type DeviceActionRequestV1,
  type DeviceDiagnosisReportV1,
  type DeviceKindV1,
  type DeviceTaskV1,
  type JsonValue,
} from "@ling-stack/contracts";
import { buildDeviceDiagnosisReport } from "./device-diagnosis.js";
import { DeviceBrokerError, type DeviceCapabilityBroker, type DeviceSupportStoreAttemptRecord } from "./device-support.js";

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
  readonly status: "succeeded" | "partial" | "failed" | "unknown" | "cancelled";
  readonly attempts: readonly DeviceSupportStoreAttemptRecord[];
  readonly failedStepId?: string;
  readonly report: DeviceDiagnosisReportV1;
}

export function createHomeAssistantOfflinePlaybook(entityId: string): DevicePlaybookV1 {
  if (!/^([a-z0-9_]+)\.([a-z0-9_]+)$/u.test(entityId)) throw new Error("Invalid Home Assistant entity id");
  return {
    id: "home-assistant-offline-diagnosis",
    version: "1.0.0",
    displayName: "Home Assistant offline entity diagnosis",
    supportedDeviceKinds: ["home_assistant"],
    riskClass: "read_only",
    localFallback: true,
    steps: [{ id: "read-entity", capabilityId: "home_assistant.read_entity", input: { entityId } }],
  };
}

export function createPcSoftwareDiagnosisPlaybook(): DevicePlaybookV1 {
  return {
    id: "pc-software-diagnosis",
    version: "1.0.0",
    displayName: "PC software and network diagnosis",
    supportedDeviceKinds: ["pc", "linux"],
    riskClass: "read_only",
    localFallback: true,
    steps: [
      { id: "inspect-network", capabilityId: "pc.inspect.network", input: {} },
      { id: "inspect-services", capabilityId: "pc.inspect.services", input: {} },
    ],
  };
}

export function createLinuxWifiDiagnosisPlaybook(): DevicePlaybookV1 {
  return {
    id: "linux-wifi-diagnosis",
    version: "1.0.0",
    displayName: "Linux Wi-Fi and network diagnosis",
    supportedDeviceKinds: ["linux"],
    riskClass: "read_only",
    localFallback: true,
    steps: [{ id: "inspect-wifi", capabilityId: "linux.inspect.wifi", input: {} }],
  };
}

export function isDevicePlaybookV1(value: unknown): value is DevicePlaybookV1 {
  if (!isRecord(value) || !hasOnlyKeys(value, ["id", "version", "displayName", "supportedDeviceKinds", "riskClass", "localFallback", "steps"])) return false;
  if (!isBoundedString(value.id) || !isBoundedString(value.version) || !isBoundedString(value.displayName)
    || !Array.isArray(value.supportedDeviceKinds) || value.supportedDeviceKinds.length === 0
    || !value.supportedDeviceKinds.every(item => DEVICE_KINDS_V1.includes(item))
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

export function devicePlaybookNodeId(playbookId: string, stepId: string): string {
  return `${playbookId}:${stepId}`;
}

export async function runDeviceReadOnlyPlaybook(input: {
  readonly broker: DeviceCapabilityBroker;
  readonly task: DeviceTaskV1;
  readonly targetDeviceId: string;
  readonly capabilitySnapshotId: string;
  readonly playbook: DevicePlaybookV1;
  readonly proposalId?: string;
  readonly now?: () => string;
}): Promise<DevicePlaybookRunResultV1> {
  if (!isDevicePlaybookV1(input.playbook)) throw new Error("Invalid device playbook");
  if (input.playbook.riskClass !== "read_only") throw new Error("Read-only playbook runner refuses mutating steps");
  const { store } = input.broker;
  const now = input.now ?? input.broker.now;
  const target = store.getDevice(input.targetDeviceId);
  const task = store.getTask(input.task.id);
  if (!target || !task || task.ownerKind !== "daemon" || task.ownerId !== input.task.ownerId
    || !task.targetDeviceIds.includes(target.device.id) || !input.playbook.supportedDeviceKinds.includes(target.device.kind)) {
    throw new DeviceBrokerError("invalid_request", "playbook is outside the task's owner or supported targets");
  }
  if (!["planning", "executing", "partial", "succeeded", "failed", "unknown", "cancelled"].includes(task.status)) {
    throw new DeviceBrokerError("invalid_request", "task is not ready to run a diagnosis playbook");
  }

  const attempts: DeviceSupportStoreAttemptRecord[] = [];
  const finish = (outcome: DevicePlaybookRunResultV1["status"], failedStepId?: string): DevicePlaybookRunResultV1 => {
    const generatedAt = now();
    const status = store.withWriteTransaction(() => {
      const current = store.getTask(task.id)!.status;
      if (current === "unknown" || current === "cancelled") return current;
      if (store.getLeasedAttempt(task.id)) throw new DeviceBrokerError("target_busy", "task already has an active dispatch");
      if (current === "executing" || (outcome === "failed" && current === "planning")) {
        store.transitionTask(task.id, outcome, {}, generatedAt);
      }
      return outcome;
    });
    return {
      playbookId: input.playbook.id,
      status,
      attempts,
      ...(failedStepId ? { failedStepId } : {}),
      report: buildDeviceDiagnosisReport({
        taskId: task.id,
        playbookId: input.playbook.id,
        playbookVersion: input.playbook.version,
        attempts,
        observations: store.listObservations(task.id),
        failedStepId,
        generatedAt,
      }),
    };
  };
  if (task.status === "unknown" || task.status === "cancelled") {
    attempts.push(...store.listAttempts(task.id));
    return finish(task.status);
  }

  let completedSteps = 0;
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
    let attempt: DeviceSupportStoreAttemptRecord;
    try {
      attempt = await input.broker.execute(request, undefined, {
        finalizeTask: false, onlyUnattendedReads: true,
        ...(input.proposalId ? { planningNode: { proposalId: input.proposalId, nodeId: devicePlaybookNodeId(input.playbook.id, step.id) } } : {}),
      });
    } catch (error) {
      if (!(error instanceof DeviceBrokerError) || error.code === "target_busy") throw error;
      return finish(completedSteps ? "partial" : "failed", step.id);
    }
    attempts.push(attempt);
    if (attempt.attempt.status === "unknown" || store.getTask(task.id)?.status === "unknown") return finish("unknown", step.id);
    if (attempt.attempt.receipt?.status !== "completed"
      || (attempt.attempt.verification && attempt.attempt.verification.status !== "verified")) {
      return finish(completedSteps ? "partial" : "failed", step.id);
    }
    completedSteps += 1;
  }
  return finish("succeeded");
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
