import type { DeviceAccessGrantV1 } from "./device-fabric.js";

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export const DEVICE_CONTRACT_MAJOR_V1 = 1 as const;
export const DEVICE_CONTRACT_VERSION_V1 = "1.0" as const;

export function negotiateDeviceContractMajor(
  localSupported: readonly number[],
  remoteSupported: readonly number[],
): typeof DEVICE_CONTRACT_MAJOR_V1 | undefined {
  return localSupported.includes(DEVICE_CONTRACT_MAJOR_V1) && remoteSupported.includes(DEVICE_CONTRACT_MAJOR_V1)
    ? DEVICE_CONTRACT_MAJOR_V1
    : undefined;
}

export const DEVICE_KINDS_V1 = [
  "pc",
  "linux",
  "android",
  "vehicle",
  "head_unit",
  "hardware",
  "home_assistant",
  "router",
  "printer",
  "other",
] as const;
export type DeviceKindV1 = (typeof DEVICE_KINDS_V1)[number];

export const DEVICE_LIFECYCLE_STATUSES_V1 = [
  "discovered",
  "identified",
  "enrolled",
  "healthy",
  "degraded",
  "offline",
  "maintenance",
  "upgraded",
  "recovered",
  "revoked",
  "retired",
] as const;
export type DeviceLifecycleStatusV1 = (typeof DEVICE_LIFECYCLE_STATUSES_V1)[number];

export const DEVICE_TRANSPORTS_V1 = [
  "https",
  "ssh",
  "winrm",
  "adb",
  "ble",
  "usb",
  "serial",
  "rs485",
  "can",
  "obd",
  "mqtt",
  "matter",
  "zigbee",
  "local_process",
  "vendor",
] as const;
export type DeviceTransportV1 = (typeof DEVICE_TRANSPORTS_V1)[number];

export const DEVICE_TRANSPORT_DEPLOYMENT_MODES_V1 = [
  "none",
  "target_executor",
  "hardware_bridge",
] as const;
export type DeviceTransportDeploymentModeV1 = (typeof DEVICE_TRANSPORT_DEPLOYMENT_MODES_V1)[number];

export const DEVICE_PAIRING_MODES_V1 = [
  "none",
  "user_confirmation",
  "qr_code",
  "os_permission",
  "credential_reference",
] as const;
export type DevicePairingModeV1 = (typeof DEVICE_PAIRING_MODES_V1)[number];

export const DEVICE_REMOVAL_MODES_V1 = [
  "disconnect_only",
  "revoke_credentials",
  "remove_target_executor",
  "remove_hardware_bridge",
] as const;
export type DeviceRemovalModeV1 = (typeof DEVICE_REMOVAL_MODES_V1)[number];

export const CAPABILITY_SIDE_EFFECTS_V1 = [
  "read_only",
  "reversible",
  "mutating",
  "irreversible",
  "critical",
] as const;
export type CapabilitySideEffectV1 = (typeof CAPABILITY_SIDE_EFFECTS_V1)[number];

export const CAPABILITY_APPROVAL_CLASSES_V1 = [
  "allow",
  "ask",
  "deny_by_default",
  "critical",
] as const;
export type CapabilityApprovalClassV1 = (typeof CAPABILITY_APPROVAL_CLASSES_V1)[number];

export const DEVICE_TASK_STATUSES_V1 = [
  "created",
  "target_resolved",
  "capabilities_loaded",
  "planning",
  "awaiting_approval",
  "executing",
  "verifying",
  "succeeded",
  "partial",
  "failed",
  "cancelled",
  "unknown",
] as const;
export type DeviceTaskStatusV1 = (typeof DEVICE_TASK_STATUSES_V1)[number];

export const DEVICE_OBSERVATION_QUALITIES_V1 = [
  "good",
  "degraded",
  "stale",
  "unknown",
] as const;
export type DeviceObservationQualityV1 = (typeof DEVICE_OBSERVATION_QUALITIES_V1)[number];

export const DEVICE_ERROR_CODES_V1 = [
  "unsupported_contract",
  "unsupported_capability",
  "missing_target",
  "invalid_request",
  "authentication_required",
  "permission_denied",
  "stale_snapshot",
  "device_offline",
  "service_unavailable",
  "timeout",
  "connection_failed",
  "target_busy",
  "target_changed",
  "unknown_outcome",
] as const;
export type DeviceErrorCodeV1 = (typeof DEVICE_ERROR_CODES_V1)[number];

export interface DeviceDisplayMetadataV1 {
  readonly label?: string;
  readonly description?: string;
  readonly icon?: string;
  readonly category?: string;
}

export interface DeviceTransportDeploymentV1 {
  readonly transport: DeviceTransportV1;
  readonly mode: DeviceTransportDeploymentModeV1;
  readonly pairing: DevicePairingModeV1;
  readonly removal: DeviceRemovalModeV1;
}

export interface DeviceIdentityV1 {
  readonly id: string;
  readonly ownerScope: string;
  readonly displayName: string;
  readonly kind: DeviceKindV1;
  readonly vendor?: string;
  readonly model?: string;
  readonly serialHint?: string;
  readonly firmwareVersion?: string;
  readonly lifecycleStatus: DeviceLifecycleStatusV1;
  readonly locationId?: string;
  readonly runtimeOwnerId?: string;
  readonly profileRevision: string;
  readonly lastSeenAt?: string;
  readonly lastCapabilitySnapshotId?: string;
}

export interface DeviceProfileV1 {
  readonly device: DeviceIdentityV1;
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly transports: readonly DeviceTransportV1[];
  readonly connectionRefs: readonly string[];
  readonly transportDeployments: readonly DeviceTransportDeploymentV1[];
  readonly supportedFirmwareRanges?: readonly string[];
  readonly profileRevision: string;
  readonly source: "adapter" | "operator" | "imported";
}

export interface CapabilityDescriptorV1 {
  readonly id: string;
  readonly schemaVersion: string;
  readonly semanticVerb: string;
  readonly inputSchema: JsonValue;
  readonly outputSchema: JsonValue;
  readonly sideEffect: CapabilitySideEffectV1;
  readonly approvalClass: CapabilityApprovalClassV1;
  readonly requiredPermissions: readonly string[];
  readonly prerequisites: readonly string[];
  readonly timeoutMs: number;
  readonly responseBytesLimit: number;
  readonly idempotency: "none" | "request" | "target_revision";
  readonly verificationCapabilityId?: string;
  readonly rollbackCapabilityId?: string;
  readonly requiresRecovery?: true;
  readonly supportedDeviceKinds: readonly DeviceKindV1[];
  readonly supportedTransports: readonly DeviceTransportV1[];
  readonly displayMetadata?: DeviceDisplayMetadataV1;
}

export interface AdapterManifestV1 {
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly contractMajor: typeof DEVICE_CONTRACT_MAJOR_V1;
  readonly supportedDeviceKinds: readonly DeviceKindV1[];
  readonly supportedTransports: readonly DeviceTransportV1[];
  readonly transportDeployments: readonly DeviceTransportDeploymentV1[];
  readonly requiredRuntime: "pc" | "mobile" | "edge" | "target";
  readonly authenticationMethods: readonly string[];
  readonly capabilities: readonly CapabilityDescriptorV1[];
  readonly supportedModels?: readonly string[];
  readonly supportedFirmwareRanges?: readonly string[];
  readonly removalBehavior: "revoke_and_disconnect" | "disable_only";
  readonly displayMetadata?: DeviceDisplayMetadataV1;
}

export interface DeviceCapabilitySnapshotV1 {
  readonly snapshotId: string;
  readonly deviceId: string;
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly contractMajor: typeof DEVICE_CONTRACT_MAJOR_V1;
  readonly connectionRevision: string;
  readonly capabilities: readonly CapabilityDescriptorV1[];
  readonly observedAt: string;
  readonly freshnessUntil: string;
}

export interface DeviceObservationV1 {
  readonly id: string;
  readonly subjectId: string;
  readonly source: string;
  readonly value: JsonValue;
  readonly observedAt: string;
  readonly receivedAt: string;
  readonly freshnessUntil: string;
  readonly quality: DeviceObservationQualityV1;
  readonly provenance: readonly string[];
  readonly redactionClass: "public" | "sensitive" | "secret_adjacent";
}

export interface DeviceActionRequestV1 {
  readonly actionId: string;
  readonly taskId: string;
  readonly targetDeviceId: string;
  readonly capabilityId: string;
  readonly capabilitySchemaVersion: string;
  readonly capabilitySnapshotId: string;
  readonly normalizedInput: JsonValue;
  readonly idempotencyKey: string;
  readonly approvalId?: string;
  readonly approval?: DeviceApprovalBindingV1;
  readonly expectedVerification?: JsonValue;
  readonly recoveryPlan?: DeviceRecoveryPlanV1;
}

/** Route revisions identify verified connections and carry no endpoint or credential. */
export type DeviceRecoveryPlanV1 = {
  readonly kind: "alternate_route";
  readonly routeRevision: string;
  readonly baselineObservationId: string;
  readonly verifyBy: string;
};

export interface DeviceApprovalBindingV1 {
  readonly approvalId: string;
  readonly taskId: string;
  readonly actionId: string;
  readonly targetDeviceId: string;
  readonly capabilitySnapshotId: string;
  readonly connectionRevision: string;
  readonly policyRevision: string;
  readonly normalizedInputDigest: string;
  readonly expiresAt: string;
  readonly recoveryScope?: JsonValue;
}

export interface DeviceActionResultV1 {
  readonly actionId: string;
  readonly status: "accepted" | "completed" | "rejected" | "uncertain";
  readonly errorCode?: DeviceErrorCodeV1;
  readonly redactedDetails?: string;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly observationIds: readonly string[];
}

export interface DeviceVerificationResultV1 {
  readonly actionId: string;
  readonly status: "verified" | "failed" | "not_evaluable";
  readonly rule: JsonValue;
  readonly observationIds: readonly string[];
  readonly checkedAt: string;
  readonly reason?: string;
}

export interface DeviceTaskReconciliationV1 {
  readonly reconciliationId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly capabilitySnapshotId: string;
  readonly connectionRevision: string;
  readonly readCapabilityId?: string;
  readonly authority?: DeviceActionAuthorityV1;
  readonly verification: DeviceVerificationResultV1;
  readonly status: "verified" | "unresolved";
  readonly recordedAt: string;
}

export interface DeviceDispatchStopV1 {
  readonly deviceId: string;
  readonly active: boolean;
  readonly revision: number;
  readonly changedAt?: string;
}

/** Authority observed by the owning broker at admission. */
export interface DeviceActionAuthorityV1 {
  readonly workspaceId: string;
  readonly policyRevision: string;
  readonly dispatchStop: DeviceDispatchStopV1;
  readonly accessGrant?: DeviceAccessGrantV1;
  readonly approvalPrincipal?: DeviceApprovalPrincipalV1;
}

export interface DeviceApprovalPrincipalV1 {
  readonly kind: "paired_mobile";
  readonly deviceId: string;
  readonly deviceEpoch: number;
  readonly sessionId: string;
}

export interface DeviceTaskV1 {
  readonly id: string;
  readonly ownerKind: "daemon" | "mobile" | "edge";
  readonly ownerId: string;
  readonly targetDeviceIds: readonly string[];
  readonly status: DeviceTaskStatusV1;
  readonly capabilitySnapshotIds: readonly string[];
  readonly accessGrantId?: string;
  readonly policyRevision?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly currentActionId?: string;
  readonly lastVerificationId?: string;
}

export interface DevicePlanningNodeRefV1 {
  readonly proposalId: string;
  readonly nodeId: string;
}

export interface DeviceTaskAttemptV1 {
  readonly attemptId: string;
  readonly taskId: string;
  readonly actionId: string;
  readonly ownerKind: "daemon" | "mobile" | "edge";
  readonly ownerId: string;
  readonly targetDeviceId: string;
  readonly dispatchIntentAt: string;
  readonly authority?: DeviceActionAuthorityV1;
  readonly accessGrantRevision?: number;
  readonly connectionRevision?: string;
  readonly requestDigest?: string;
  readonly approvalId?: string;
  readonly adapterBinding?: {
    readonly adapterId: string;
    readonly adapterVersion: string;
    readonly profileRevision: string;
  };
  readonly planningNode?: DevicePlanningNodeRefV1;
  readonly recoveryPathVerifiedAt?: string;
  readonly status: "prepared" | "dispatched" | "completed" | "failed" | "unknown" | "cancelled";
  readonly receipt?: DeviceActionResultV1;
  readonly verification?: DeviceVerificationResultV1;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 512;

const isIsoTimestamp = (value: unknown): value is string =>
  typeof value === "string" && !Number.isNaN(Date.parse(value));

const isEnum = <T extends string>(value: unknown, choices: readonly T[]): value is T =>
  typeof value === "string" && choices.includes(value as T);

const isJsonValue = (value: unknown): value is JsonValue => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (!isRecord(value)) return false;
  return Object.values(value).every(isJsonValue);
};

const hasOnlyKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
};

const isStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every(isNonEmptyString);

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0;

const isTransportArray = (value: unknown): value is readonly DeviceTransportV1[] =>
  Array.isArray(value) && value.every((item) => isEnum(item, DEVICE_TRANSPORTS_V1));

const isKindArray = (value: unknown): value is readonly DeviceKindV1[] =>
  Array.isArray(value) && value.every((item) => isEnum(item, DEVICE_KINDS_V1));

const isDeviceDisplayMetadataV1 = (value: unknown): value is DeviceDisplayMetadataV1 =>
  isRecord(value)
  && hasOnlyKeys(value, ["label", "description", "icon", "category"])
  && (value.label === undefined || isNonEmptyString(value.label))
  && (value.description === undefined || isNonEmptyString(value.description))
  && (value.icon === undefined || isNonEmptyString(value.icon))
  && (value.category === undefined || isNonEmptyString(value.category));

const isTransportDeploymentV1 = (value: unknown): value is DeviceTransportDeploymentV1 =>
  isRecord(value)
  && hasOnlyKeys(value, ["transport", "mode", "pairing", "removal"])
  && isEnum(value.transport, DEVICE_TRANSPORTS_V1)
  && isEnum(value.mode, DEVICE_TRANSPORT_DEPLOYMENT_MODES_V1)
  && isEnum(value.pairing, DEVICE_PAIRING_MODES_V1)
  && isEnum(value.removal, DEVICE_REMOVAL_MODES_V1);

const isTransportDeploymentArray = (value: unknown): value is readonly DeviceTransportDeploymentV1[] =>
  Array.isArray(value)
  && value.length > 0
  && value.every(isTransportDeploymentV1)
  && new Set(value.map((item) => item.transport)).size === value.length;

export function isDeviceIdentityV1(value: unknown): value is DeviceIdentityV1 {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "id", "ownerScope", "displayName", "kind", "vendor", "model", "serialHint",
    "firmwareVersion", "lifecycleStatus", "locationId", "runtimeOwnerId",
    "profileRevision", "lastSeenAt", "lastCapabilitySnapshotId",
  ])) return false;
  return isNonEmptyString(value.id)
    && isNonEmptyString(value.ownerScope)
    && isNonEmptyString(value.displayName)
    && isEnum(value.kind, DEVICE_KINDS_V1)
    && isEnum(value.lifecycleStatus, DEVICE_LIFECYCLE_STATUSES_V1)
    && isNonEmptyString(value.profileRevision)
    && (value.vendor === undefined || isNonEmptyString(value.vendor))
    && (value.model === undefined || isNonEmptyString(value.model))
    && (value.serialHint === undefined || isNonEmptyString(value.serialHint))
    && (value.firmwareVersion === undefined || isNonEmptyString(value.firmwareVersion))
    && (value.locationId === undefined || isNonEmptyString(value.locationId))
    && (value.runtimeOwnerId === undefined || isNonEmptyString(value.runtimeOwnerId))
    && (value.lastSeenAt === undefined || isIsoTimestamp(value.lastSeenAt))
    && (value.lastCapabilitySnapshotId === undefined || isNonEmptyString(value.lastCapabilitySnapshotId));
}

export function isDeviceProfileV1(value: unknown): value is DeviceProfileV1 {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "device", "adapterId", "adapterVersion", "transports", "connectionRefs", "transportDeployments",
    "supportedFirmwareRanges", "profileRevision", "source",
  ])) return false;
  return isDeviceIdentityV1(value.device)
    && isNonEmptyString(value.adapterId)
    && isNonEmptyString(value.adapterVersion)
    && isTransportArray(value.transports)
    && isStringArray(value.connectionRefs)
    && isTransportDeploymentArray(value.transportDeployments)
    && isNonEmptyString(value.profileRevision)
    && isEnum(value.source, ["adapter", "operator", "imported"] as const)
    && (value.supportedFirmwareRanges === undefined || isStringArray(value.supportedFirmwareRanges));
}

export function isCapabilityDescriptorV1(value: unknown): value is CapabilityDescriptorV1 {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "id", "schemaVersion", "semanticVerb", "inputSchema", "outputSchema", "sideEffect",
    "approvalClass", "requiredPermissions", "prerequisites", "timeoutMs",
    "responseBytesLimit", "idempotency", "verificationCapabilityId",
    "rollbackCapabilityId", "requiresRecovery", "supportedDeviceKinds", "supportedTransports", "displayMetadata",
  ])) return false;
  return isNonEmptyString(value.id)
    && isNonEmptyString(value.schemaVersion)
    && isNonEmptyString(value.semanticVerb)
    && isJsonValue(value.inputSchema)
    && isJsonValue(value.outputSchema)
    && isEnum(value.sideEffect, CAPABILITY_SIDE_EFFECTS_V1)
    && isEnum(value.approvalClass, CAPABILITY_APPROVAL_CLASSES_V1)
    && isStringArray(value.requiredPermissions)
    && isStringArray(value.prerequisites)
    && isPositiveInteger(value.timeoutMs)
    && isPositiveInteger(value.responseBytesLimit)
    && isEnum(value.idempotency, ["none", "request", "target_revision"] as const)
    && (value.verificationCapabilityId === undefined || isNonEmptyString(value.verificationCapabilityId))
    && (value.rollbackCapabilityId === undefined || isNonEmptyString(value.rollbackCapabilityId))
    && (value.requiresRecovery === undefined || (value.requiresRecovery === true && value.sideEffect !== "read_only"
      && isNonEmptyString(value.verificationCapabilityId)))
    && isKindArray(value.supportedDeviceKinds)
    && isTransportArray(value.supportedTransports)
    && (value.displayMetadata === undefined || isDeviceDisplayMetadataV1(value.displayMetadata));
}

export function isAdapterManifestV1(value: unknown): value is AdapterManifestV1 {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "adapterId", "adapterVersion", "contractMajor", "supportedDeviceKinds",
    "supportedTransports", "transportDeployments", "requiredRuntime", "authenticationMethods",
    "capabilities", "supportedModels", "supportedFirmwareRanges", "removalBehavior", "displayMetadata",
  ])) return false;
  return isNonEmptyString(value.adapterId)
    && isNonEmptyString(value.adapterVersion)
    && value.contractMajor === DEVICE_CONTRACT_MAJOR_V1
    && isKindArray(value.supportedDeviceKinds)
    && isTransportArray(value.supportedTransports)
    && isTransportDeploymentArray(value.transportDeployments)
    && isEnum(value.requiredRuntime, ["pc", "mobile", "edge", "target"] as const)
    && isStringArray(value.authenticationMethods)
    && Array.isArray(value.capabilities)
    && value.capabilities.every(isCapabilityDescriptorV1)
    && (value.supportedModels === undefined || isStringArray(value.supportedModels))
    && (value.supportedFirmwareRanges === undefined || isStringArray(value.supportedFirmwareRanges))
    && isEnum(value.removalBehavior, ["revoke_and_disconnect", "disable_only"] as const)
    && (value.displayMetadata === undefined || isDeviceDisplayMetadataV1(value.displayMetadata));
}

export function isDeviceCapabilitySnapshotV1(value: unknown): value is DeviceCapabilitySnapshotV1 {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "snapshotId", "deviceId", "adapterId", "adapterVersion", "contractMajor",
    "connectionRevision", "capabilities", "observedAt", "freshnessUntil",
  ])) return false;
  return isNonEmptyString(value.snapshotId)
    && isNonEmptyString(value.deviceId)
    && isNonEmptyString(value.adapterId)
    && isNonEmptyString(value.adapterVersion)
    && value.contractMajor === DEVICE_CONTRACT_MAJOR_V1
    && isNonEmptyString(value.connectionRevision)
    && Array.isArray(value.capabilities)
    && value.capabilities.every(isCapabilityDescriptorV1)
    && isIsoTimestamp(value.observedAt)
    && isIsoTimestamp(value.freshnessUntil)
    && Date.parse(value.freshnessUntil) >= Date.parse(value.observedAt);
}

export function isDeviceObservationV1(value: unknown): value is DeviceObservationV1 {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "id", "subjectId", "source", "value", "observedAt", "receivedAt",
    "freshnessUntil", "quality", "provenance", "redactionClass",
  ])) return false;
  return isNonEmptyString(value.id)
    && isNonEmptyString(value.subjectId)
    && isNonEmptyString(value.source)
    && isJsonValue(value.value)
    && isIsoTimestamp(value.observedAt)
    && isIsoTimestamp(value.receivedAt)
    && isIsoTimestamp(value.freshnessUntil)
    && Date.parse(value.freshnessUntil) >= Date.parse(value.observedAt)
    && isEnum(value.quality, DEVICE_OBSERVATION_QUALITIES_V1)
    && isStringArray(value.provenance)
    && isEnum(value.redactionClass, ["public", "sensitive", "secret_adjacent"] as const);
}

export function isDeviceActionRequestV1(value: unknown): value is DeviceActionRequestV1 {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "actionId", "taskId", "targetDeviceId", "capabilityId", "capabilitySchemaVersion",
    "capabilitySnapshotId", "normalizedInput", "idempotencyKey", "approvalId",
    "approval", "expectedVerification", "recoveryPlan",
  ])) return false;
  return isNonEmptyString(value.actionId)
    && isNonEmptyString(value.taskId)
    && isNonEmptyString(value.targetDeviceId)
    && isNonEmptyString(value.capabilityId)
    && isNonEmptyString(value.capabilitySchemaVersion)
    && isNonEmptyString(value.capabilitySnapshotId)
    && isJsonValue(value.normalizedInput)
    && isNonEmptyString(value.idempotencyKey)
    && (value.approvalId === undefined || isNonEmptyString(value.approvalId))
    && (value.approval === undefined || isDeviceApprovalBindingV1(value.approval))
    && (value.approvalId === undefined || value.approval === undefined || value.approvalId === value.approval.approvalId)
    && (value.expectedVerification === undefined || isJsonValue(value.expectedVerification))
    && (value.recoveryPlan === undefined || isDeviceRecoveryPlanV1(value.recoveryPlan));
}

export function isDeviceRecoveryPlanV1(value: unknown): value is DeviceRecoveryPlanV1 {
  return isRecord(value) && hasOnlyKeys(value, ["kind", "routeRevision", "baselineObservationId", "verifyBy"])
    && value.kind === "alternate_route"
    && typeof value.routeRevision === "string" && /^[a-zA-Z0-9_.:-]{1,192}$/u.test(value.routeRevision)
    && isNonEmptyString(value.baselineObservationId)
    && typeof value.verifyBy === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value.verifyBy)
    && isIsoTimestamp(value.verifyBy);
}

export function isDeviceApprovalBindingV1(value: unknown): value is DeviceApprovalBindingV1 {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "approvalId", "taskId", "actionId", "targetDeviceId", "capabilitySnapshotId",
    "connectionRevision", "policyRevision", "normalizedInputDigest", "expiresAt", "recoveryScope",
  ])) return false;
  return isNonEmptyString(value.approvalId)
    && isNonEmptyString(value.taskId)
    && isNonEmptyString(value.actionId)
    && isNonEmptyString(value.targetDeviceId)
    && isNonEmptyString(value.capabilitySnapshotId)
    && isNonEmptyString(value.connectionRevision)
    && isNonEmptyString(value.policyRevision)
    && isNonEmptyString(value.normalizedInputDigest)
    && isIsoTimestamp(value.expiresAt)
    && (value.recoveryScope === undefined || isJsonValue(value.recoveryScope));
}

export function isDeviceActionResultV1(value: unknown): value is DeviceActionResultV1 {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "actionId", "status", "errorCode", "redactedDetails", "startedAt",
    "finishedAt", "observationIds",
  ])) return false;
  return isNonEmptyString(value.actionId)
    && isEnum(value.status, ["accepted", "completed", "rejected", "uncertain"] as const)
    && (value.errorCode === undefined || isEnum(value.errorCode, DEVICE_ERROR_CODES_V1))
    && (value.redactedDetails === undefined || (typeof value.redactedDetails === "string" && value.redactedDetails.length <= 4096))
    && isIsoTimestamp(value.startedAt)
    && (value.finishedAt === undefined || isIsoTimestamp(value.finishedAt))
    && isStringArray(value.observationIds);
}

export function isDeviceVerificationResultV1(value: unknown): value is DeviceVerificationResultV1 {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "actionId", "status", "rule", "observationIds", "checkedAt", "reason",
  ])) return false;
  return isNonEmptyString(value.actionId)
    && isEnum(value.status, ["verified", "failed", "not_evaluable"] as const)
    && isJsonValue(value.rule)
    && isStringArray(value.observationIds)
    && isIsoTimestamp(value.checkedAt)
    && (value.reason === undefined || (typeof value.reason === "string" && value.reason.length <= 4096));
}

export function isDeviceTaskV1(value: unknown): value is DeviceTaskV1 {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "id", "ownerKind", "ownerId", "targetDeviceIds", "status",
    "capabilitySnapshotIds", "accessGrantId", "policyRevision", "createdAt", "updatedAt", "currentActionId",
    "lastVerificationId",
  ])) return false;
  return isNonEmptyString(value.id)
    && isEnum(value.ownerKind, ["daemon", "mobile", "edge"] as const)
    && isNonEmptyString(value.ownerId)
    && isStringArray(value.targetDeviceIds)
    && value.targetDeviceIds.length > 0
    && isEnum(value.status, DEVICE_TASK_STATUSES_V1)
    && isStringArray(value.capabilitySnapshotIds)
    && (value.accessGrantId === undefined || isNonEmptyString(value.accessGrantId))
    && (value.policyRevision === undefined || isNonEmptyString(value.policyRevision))
    && isIsoTimestamp(value.createdAt)
    && isIsoTimestamp(value.updatedAt)
    && Date.parse(value.updatedAt) >= Date.parse(value.createdAt)
    && (value.currentActionId === undefined || isNonEmptyString(value.currentActionId))
    && (value.lastVerificationId === undefined || isNonEmptyString(value.lastVerificationId));
}

export function isDeviceTaskAttemptV1(value: unknown): value is DeviceTaskAttemptV1 {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "attemptId", "taskId", "actionId", "ownerKind", "ownerId", "targetDeviceId",
    "dispatchIntentAt", "authority", "accessGrantRevision", "connectionRevision", "requestDigest", "approvalId", "adapterBinding",
    "planningNode", "recoveryPathVerifiedAt", "status", "receipt", "verification",
  ])) return false;
  return isNonEmptyString(value.attemptId)
    && isNonEmptyString(value.taskId)
    && isNonEmptyString(value.actionId)
    && isEnum(value.ownerKind, ["daemon", "mobile", "edge"] as const)
    && isNonEmptyString(value.ownerId)
    && isNonEmptyString(value.targetDeviceId)
    && isIsoTimestamp(value.dispatchIntentAt)
    && (value.authority === undefined || (isDeviceActionAuthorityV1(value.authority)
      && value.authority.dispatchStop.deviceId === value.targetDeviceId
      && value.authority.accessGrant?.revision === value.accessGrantRevision
      && (value.authority.approvalPrincipal === undefined || isNonEmptyString(value.approvalId))
      && (value.authority.accessGrant === undefined || (
        value.authority.accessGrant.targetDeviceId === value.targetDeviceId && value.authority.accessGrant.principalId === value.ownerId
      ))))
    && (value.accessGrantRevision === undefined || isPositiveInteger(value.accessGrantRevision))
    && (value.connectionRevision === undefined || isNonEmptyString(value.connectionRevision))
    && (value.requestDigest === undefined || isNonEmptyString(value.requestDigest))
    && (value.approvalId === undefined || isNonEmptyString(value.approvalId))
    && (value.adapterBinding === undefined || (isRecord(value.adapterBinding)
      && hasOnlyKeys(value.adapterBinding, ["adapterId", "adapterVersion", "profileRevision"])
      && isNonEmptyString(value.adapterBinding.adapterId) && isNonEmptyString(value.adapterBinding.adapterVersion)
      && isNonEmptyString(value.adapterBinding.profileRevision)))
    && (value.planningNode === undefined || (isRecord(value.planningNode)
      && hasOnlyKeys(value.planningNode, ["proposalId", "nodeId"])
      && isNonEmptyString(value.planningNode.proposalId) && isNonEmptyString(value.planningNode.nodeId)))
    && (value.recoveryPathVerifiedAt === undefined || (isIsoTimestamp(value.recoveryPathVerifiedAt)
      && isNonEmptyString(value.approvalId) && Date.parse(value.recoveryPathVerifiedAt) <= Date.parse(value.dispatchIntentAt)))
    && isEnum(value.status, ["prepared", "dispatched", "completed", "failed", "unknown", "cancelled"] as const)
    && (value.receipt === undefined || isDeviceActionResultV1(value.receipt))
    && (value.verification === undefined || isDeviceVerificationResultV1(value.verification));
}

function isDeviceActionAuthorityV1(value: unknown): value is DeviceActionAuthorityV1 {
  if (!isRecord(value) || !hasOnlyKeys(value, ["workspaceId", "policyRevision", "dispatchStop", "accessGrant", "approvalPrincipal"])
    || !isNonEmptyString(value.workspaceId) || !isNonEmptyString(value.policyRevision)) return false;
  const stop = value.dispatchStop;
  if (!isRecord(stop) || !hasOnlyKeys(stop, ["deviceId", "active", "revision", "changedAt"]) || !isNonEmptyString(stop.deviceId)
    || typeof stop.active !== "boolean" || typeof stop.revision !== "number" || !Number.isSafeInteger(stop.revision) || stop.revision < 0
    || (stop.changedAt !== undefined && !isIsoTimestamp(stop.changedAt))) return false;
  const principal = value.approvalPrincipal;
  if (principal !== undefined && (!isRecord(principal) || !hasOnlyKeys(principal, ["kind", "deviceId", "deviceEpoch", "sessionId"])
    || principal.kind !== "paired_mobile" || !isNonEmptyString(principal.deviceId) || !isNonEmptyString(principal.sessionId)
    || !isPositiveInteger(principal.deviceEpoch) || !Number.isSafeInteger(principal.deviceEpoch))) return false;
  const grant = value.accessGrant;
  return grant === undefined || (isRecord(grant) && hasOnlyKeys(grant, [
    "grantId", "targetDeviceId", "principalId", "scope", "capabilityIds", "revision", "status", "expiresAt", "authority", "changedAt",
  ]) && isNonEmptyString(grant.grantId) && isNonEmptyString(grant.targetDeviceId) && isNonEmptyString(grant.principalId)
    && isEnum(grant.scope, ["read_only", "developer", "owner"] as const) && isStringArray(grant.capabilityIds)
    && Number.isSafeInteger(grant.revision) && isPositiveInteger(grant.revision) && grant.status === "active"
    && isIsoTimestamp(grant.expiresAt) && isNonEmptyString(grant.authority) && isIsoTimestamp(grant.changedAt));
}
