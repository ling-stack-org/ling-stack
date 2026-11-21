import {
  DEVICE_KINDS_V1,
  type DeviceKindV1,
  type DeviceLifecycleStatusV1,
  type DeviceTaskStatusV1,
  type DeviceTaskV1,
  type JsonValue,
} from "./device.js";

export type DeviceGraphNodeKindV1 = "device" | "component" | "connection" | "location";

export interface DeviceGraphNodeV1 {
  readonly nodeId: string;
  readonly kind: DeviceGraphNodeKindV1;
  readonly deviceId?: string;
  readonly parentNodeId?: string;
  readonly label: string;
  readonly deviceKind?: DeviceKindV1;
  readonly identityRefs: readonly string[];
  readonly properties: JsonValue;
  readonly revision: number;
}

export interface DeviceGraphRelationshipV1 {
  readonly relationshipId: string;
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly type: "contains" | "connects" | "controls" | "located_at" | "part_of";
  readonly provenance: readonly string[];
  readonly revision: number;
}

export interface DeviceTwinValueV1 {
  readonly key: string;
  readonly reported?: JsonValue;
  readonly desired?: JsonValue;
  readonly pending?: JsonValue;
  readonly verified?: JsonValue;
  readonly source: string;
  readonly quality: "good" | "degraded" | "stale" | "unknown";
  readonly observedAt: string;
  readonly freshnessUntil: string;
}

export interface DeviceTwinV1 {
  readonly deviceId: string;
  readonly revision: number;
  readonly values: readonly DeviceTwinValueV1[];
  readonly updatedAt: string;
}

export interface DeviceTaskGraphNodeV1 {
  readonly nodeId: string;
  readonly targetDeviceId: string;
  readonly ownerKind: "daemon" | "mobile" | "edge";
  readonly ownerId: string;
  readonly capabilityId: string;
  readonly capabilitySnapshotId: string;
  readonly dependencies: readonly string[];
  readonly status: DeviceTaskStatusV1;
  readonly attemptId?: string;
  readonly resultRef?: string;
}

export interface DeviceTaskGraphV1 {
  readonly graphId: string;
  readonly revision: number;
  readonly status: "planned" | "executing" | "partial" | "succeeded" | "failed" | "unknown" | "cancelled";
  readonly nodes: readonly DeviceTaskGraphNodeV1[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface EdgeRuntimeEnrollmentV1 {
  readonly runtimeId: string;
  readonly displayName: string;
  readonly publicKeyFingerprint: string;
  readonly contractMajor: number;
  readonly supportedTransports: readonly string[];
  readonly status: "pending" | "enrolled" | "offline" | "revoked";
  readonly revision: number;
  readonly lastSeenAt?: string;
}

export interface DeviceBridgeFrameV1 {
  readonly frameId: string;
  readonly runtimeId: string;
  readonly ownerTaskId: string;
  readonly direction: "request" | "response" | "event";
  readonly sequence: number;
  readonly payload: JsonValue;
  readonly sentAt: string;
}

export interface DeviceEventEnvelopeV1 {
  readonly eventId: string;
  readonly traceId: string;
  /** Stable owner stream used for cursor and snapshot synchronization. */
  readonly streamId?: string;
  /** Stream generation changes when an owner replaces its journal. */
  readonly generation?: number;
  readonly sourceKind: "model" | "graph" | "runtime" | "adapter" | "protocol" | "target" | "verification";
  readonly sourceId: string;
  readonly sequence: number;
  readonly kind: string;
  readonly payload: JsonValue;
  readonly occurredAt: string;
  readonly observedAt?: string;
  readonly provenance?: readonly string[];
  readonly quality?: "good" | "degraded" | "stale" | "unknown";
  readonly redactionClass?: "public" | "sensitive" | "secret_adjacent";
  readonly evidenceRefs?: readonly string[];
  readonly retentionClass?: "durable" | "bounded" | "telemetry";
}

export interface DeviceTaskJournalPageV1 {
  readonly streamId: string;
  readonly generation: number;
  readonly latestSequence: number;
  readonly task: DeviceTaskV1;
  readonly events: readonly DeviceEventEnvelopeV1[];
  readonly hasMore: boolean;
  readonly requiresSnapshot: boolean;
}

export const DEVICE_TASK_JOURNAL_PUBLIC_EVENTS_V1 = {
  task_created: { sourceKind: "runtime", fields: ["status"] },
  task_transition: { sourceKind: "runtime", fields: ["from", "to"] },
  device_plan_accepted: { sourceKind: "graph", fields: ["proposalId", "contextId", "source"] },
  attempt_prepared: { sourceKind: "runtime", fields: ["attemptId", "actionId"] },
  attempt_updated: { sourceKind: "runtime", fields: ["attemptId", "status", "receiptStatus", "verificationStatus"] },
  task_stop_requested: { sourceKind: "runtime", fields: ["attemptId", "status"] },
  attempt_reconciled: { sourceKind: "verification", fields: ["attemptId", "status", "reconciliationId"] },
  observation_recorded: { sourceKind: "adapter", fields: ["observationId"] },
  journal_changed: { sourceKind: "runtime", fields: [] },
} as const;

const deviceResourceKinds = ["adapter", "playbook", "codec", "firmware", "schema"] as const;
const deviceResourcePlatforms = ["ios", "android", "macos", "windows", "linux"] as const;

export interface DeviceResourceManifestV1 {
  readonly resourceId: string;
  readonly version: string;
  readonly kind: (typeof deviceResourceKinds)[number];
  readonly digest: string;
  readonly license: string;
  readonly dependencies: readonly string[];
  readonly signature: string;
  readonly supportedDeviceKinds: readonly DeviceKindV1[];
  readonly entrypoint: string;
  readonly contractMajor?: number;
  readonly supportedPlatforms?: readonly (typeof deviceResourcePlatforms)[number][];
  readonly supportedFirmwareRanges?: readonly string[];
  readonly requiredPermissions?: readonly string[];
}

export function isDeviceResourceManifestV1(value: unknown): value is DeviceResourceManifestV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const manifest = value as Record<string, unknown>;
  const fields = [
    "resourceId", "version", "kind", "digest", "license", "dependencies", "signature", "supportedDeviceKinds",
    "entrypoint", "contractMajor", "supportedPlatforms", "supportedFirmwareRanges", "requiredPermissions",
  ];
  return Object.keys(manifest).every(key => fields.includes(key))
    && typeof manifest.resourceId === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/u.test(manifest.resourceId)
    && isResourceString(manifest.version, 128)
    && deviceResourceKinds.some(kind => manifest.kind === kind)
    && typeof manifest.digest === "string" && /^[0-9a-f]{64}$/u.test(manifest.digest)
    && isResourceString(manifest.license, 128)
    && isResourceList(manifest.dependencies, item => typeof item === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/u.test(item))
    && !manifest.dependencies.includes(manifest.resourceId)
    && isResourceString(manifest.signature, 512)
    && isResourceList(manifest.supportedDeviceKinds, item => DEVICE_KINDS_V1.some(kind => item === kind))
    && isResourceString(manifest.entrypoint, 512)
    && (manifest.contractMajor === undefined || (Number.isSafeInteger(manifest.contractMajor) && Number(manifest.contractMajor) > 0))
    && (manifest.supportedPlatforms === undefined || isResourceList(manifest.supportedPlatforms, item => deviceResourcePlatforms.some(platform => item === platform)))
    && (manifest.supportedFirmwareRanges === undefined || isResourceList(manifest.supportedFirmwareRanges, item => isResourceString(item, 128)))
    && (manifest.requiredPermissions === undefined || isResourceList(manifest.requiredPermissions, item => isResourceString(item, 128)));
}

function isResourceString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength && value.trim() === value
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function isResourceList(value: unknown, validate: (item: unknown) => boolean): value is readonly string[] {
  return Array.isArray(value) && value.length <= 64 && value.every(validate) && new Set(value).size === value.length;
}

export interface DeviceSafetyContextV1 {
  readonly targetDeviceId: string;
  readonly policyRevision: string;
  readonly physicalState: "unknown" | "stationary" | "moving" | "maintenance";
  readonly emergencyStop: boolean;
  readonly requiredSecretRefs: readonly string[];
  readonly observedAt: string;
}

export type DeviceSafetyControllerKindV1 = "adapter" | "vendor_workflow" | "certified_controller";

export interface DeviceSafetyActionPolicyV1 {
  readonly policyRevision: string;
  readonly capabilityId: string;
  readonly sideEffect: "read_only" | "reversible" | "mutating" | "irreversible" | "critical";
  readonly requiredPhysicalState: DeviceSafetyContextV1["physicalState"];
  readonly requiredSecretRefs: readonly string[];
  readonly controller: DeviceSafetyControllerKindV1;
  readonly operatorHandoffRequired: boolean;
  readonly cancellationSupported: boolean;
}

export interface DeviceSafetyDecisionV1 {
  readonly decisionId: string;
  readonly targetDeviceId: string;
  readonly capabilityId: string;
  readonly policyRevision: string;
  readonly status: "authorized" | "denied";
  readonly reason?: string;
  readonly evaluatedAt: string;
}

export interface DeviceSecretUseV1 {
  readonly useId: string;
  readonly taskId: string;
  readonly attemptId?: string;
  readonly targetDeviceId: string;
  readonly secretRef: string;
  readonly purpose: string;
  readonly policyRevision: string;
  readonly usedAt: string;
}

export interface DeviceLifecycleRecordV1 {
  readonly deviceId: string;
  readonly status: "discovered" | "identified" | "enrolled" | "healthy" | "degraded" | "offline" | "maintenance" | "upgraded" | "recovered" | "revoked" | "retired";
  readonly revision: number;
  readonly reason: string;
  readonly authority: string;
  readonly changedAt: string;
}

export interface DeviceOwnershipRevisionV1 {
  readonly deviceId: string;
  readonly ownerScope: string;
  readonly runtimeOwnerId?: string;
  readonly revision: number;
  readonly authority: string;
  readonly changedAt: string;
}

export interface DeviceAccessGrantV1 {
  readonly grantId: string;
  readonly targetDeviceId: string;
  readonly principalId: string;
  readonly scope: "read_only" | "developer" | "owner";
  readonly capabilityIds: readonly string[];
  readonly revision: number;
  readonly status: "active" | "revoked";
  readonly expiresAt: string;
  readonly authority: string;
  readonly changedAt: string;
}

export interface DeviceCredentialRevisionV1 {
  readonly credentialId: string;
  readonly targetDeviceId: string;
  readonly secretRef: string;
  readonly kind: "ssh_key" | "password" | "token" | "certificate" | "vendor_key";
  readonly fingerprint: string;
  readonly revision: number;
  readonly status: "active" | "rotated" | "revoked";
  readonly authority: string;
  readonly changedAt: string;
}

export type DeviceFleetHealthStatusV1 = "healthy" | "degraded" | "offline" | "maintenance" | "revoked" | "retired" | "unknown";

export interface DeviceFleetHealthItemV1 {
  readonly deviceId: string;
  readonly ownerScope: string;
  readonly displayName: string;
  readonly kind: DeviceKindV1;
  readonly lifecycleStatus: DeviceLifecycleStatusV1;
  readonly health: DeviceFleetHealthStatusV1;
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly profileRevision: string;
  readonly runtimeOwnerId?: string;
  readonly runtimeStatus?: EdgeRuntimeEnrollmentV1["status"];
  readonly lastSeenAt?: string;
  readonly reasons: readonly string[];
  readonly evaluatedAt: string;
}

export interface DeviceFleetHealthProjectionV1 {
  readonly projectionId: string;
  readonly ownerScope: string;
  readonly generatedAt: string;
  readonly items: readonly DeviceFleetHealthItemV1[];
  readonly counts: Readonly<Record<DeviceFleetHealthStatusV1, number>>;
}

export interface DeviceContextPackV1 {
  readonly contextId: string;
  readonly taskId: string;
  readonly maxBytes: number;
  readonly facts: readonly JsonValue[];
  readonly hypotheses: readonly JsonValue[];
  readonly observations: readonly string[];
  readonly untrustedTextRefs: readonly string[];
  readonly factMetadata?: readonly DeviceContextFactMetadataV1[];
  readonly generatedAt: string;
}

export interface DeviceContextFactMetadataV1 {
  readonly observationId: string;
  readonly source: string;
  readonly observedAt?: string;
  readonly freshnessUntil?: string;
  readonly quality: "good" | "degraded" | "stale" | "unknown";
  readonly redactionClass: "public" | "sensitive" | "secret_adjacent";
}

export interface DeviceTraceSpanV1 {
  readonly spanId: string;
  readonly traceId: string;
  readonly parentSpanId?: string;
  readonly kind: DeviceEventEnvelopeV1["sourceKind"];
  readonly sourceId: string;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly status: "running" | "ok" | "failed" | "unknown";
  readonly metadata: JsonValue;
}

export interface DeviceConformanceReportV1 {
  readonly reportId: string;
  readonly runtimeId: string;
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly targetProfile: string;
  readonly transport: string;
  readonly checks: readonly { readonly id: string; readonly status: "pass" | "fail" | "skip"; readonly evidenceRef?: string }[];
  readonly generatedAt: string;
}

export interface DevicePlannerProposalV1 {
  readonly proposalId: string;
  readonly taskId: string;
  readonly contextId: string;
  readonly source: "model" | "local_playbook";
  readonly providerId?: string;
  readonly modelTurnId?: string;
  readonly graph: DeviceTaskGraphV1;
  readonly planningInputRefs: readonly string[];
  readonly createdAt: string;
  readonly runnerId?: string;
  readonly runnerCapabilityRevision?: string;
}

export interface DevicePlannerAcceptanceV1 {
  readonly proposalId: string;
  readonly taskId: string;
  readonly contextId: string;
  readonly graph: DeviceTaskGraphV1;
  readonly contextDigest: string;
  readonly requiredApprovalNodeIds: readonly string[];
  readonly acceptedAt: string;
  readonly runnerId?: string;
  readonly runnerCapabilityRevision?: string;
}
