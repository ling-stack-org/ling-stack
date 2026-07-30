/**
 * Closed wire contracts for governed Computer Control while the OS session is locked.
 *
 * These contracts do not enable the feature. Packaged policy, a live Desktop capability
 * proof, a task-scoped grant and a fresh locked attestation must all intersect before any
 * runtime may treat locked control as executable authority.
 */

export const LOCKED_COMPUTER_CONTROL_SCHEMA_VERSION = 1 as const;
export const LOCKED_COMPUTER_CONTROL_MAX_GRANT_TTL_SECONDS = 900 as const;
export const LOCKED_COMPUTER_CONTROL_TOOL_POLICY_REVISION = "locked-cua-tools-v1" as const;

export const LOCKED_COMPUTER_CONTROL_REASON_CODES = [
  "locked_control_disabled_by_build",
  "locked_control_disabled_by_policy",
  "locked_control_probe_required",
  "locked_control_platform_unsupported",
  "locked_control_identity_cancelled",
  "locked_control_identity_failed",
  "locked_control_identity_unavailable",
  "locked_control_no_active_run",
  "locked_control_session_mismatch",
  "locked_control_secure_surface",
  "locked_control_capture_unavailable",
  "locked_control_input_unavailable",
  "locked_control_input_fence_timeout",
  "locked_control_grant_expired",
  "locked_control_grant_consumed",
  "locked_control_authority_rotated",
  "locked_control_suspend",
  "locked_control_user_switched",
  "locked_control_approval_required",
  "locked_control_audit_unavailable",
  "locked_control_commit_unconfirmed",
] as const;

export const LOCKED_COMPUTER_CONTROL_CAPABILITY_STATES = [
  "disabled_by_build",
  "probe_required",
  "unsupported",
  "supported_restricted",
] as const;

export const LOCKED_COMPUTER_CONTROL_IDENTITY_STATUSES = [
  "verified",
  "cancelled",
  "failed",
  "unavailable",
] as const;

export const LOCKED_COMPUTER_CONTROL_PHASES = [
  "off",
  "verifying",
  "armed",
  "active_locked",
  "paused",
] as const;

export const LOCKED_COMPUTER_CONTROL_AUDIT_EVENT_KINDS = [
  "locked_control_capability_evaluated",
  "locked_control_authorization_requested",
  "locked_control_identity_resolved",
  "locked_control_grant_armed",
  "locked_control_entered",
  "locked_control_action_denied",
  "locked_control_grant_revoked",
  "locked_control_recovered_unlocked",
] as const;

export type LockedComputerControlPlatform = "darwin" | "win32";
export type LockedControlReasonCode =
  (typeof LOCKED_COMPUTER_CONTROL_REASON_CODES)[number];
export type LockedCapabilityState =
  (typeof LOCKED_COMPUTER_CONTROL_CAPABILITY_STATES)[number];
export type LockedControlIdentityStatus =
  (typeof LOCKED_COMPUTER_CONTROL_IDENTITY_STATUSES)[number];
export type LockedComputerControlPhase =
  (typeof LOCKED_COMPUTER_CONTROL_PHASES)[number];
export type LockedComputerControlAuditEventKind =
  (typeof LOCKED_COMPUTER_CONTROL_AUDIT_EVENT_KINDS)[number];

export interface LockedComputerControlPolicyV1 {
  readonly schemaVersion: 1;
  readonly mode: "disabled" | "task_grant_required";
  readonly maxGrantTtlSeconds: number;
  readonly requireLocalUserVerification: true;
  readonly consumeOnUnlock: true;
  readonly suspendRevokes: true;
  readonly lockedToolPolicyRevision: string;
  readonly allowedLockedToolIdsSha256: string;
}

const DISABLED_LOCKED_CONTROL_POLICY: LockedComputerControlPolicyV1 = Object.freeze({
  schemaVersion: LOCKED_COMPUTER_CONTROL_SCHEMA_VERSION,
  mode: "disabled",
  maxGrantTtlSeconds: LOCKED_COMPUTER_CONTROL_MAX_GRANT_TTL_SECONDS,
  requireLocalUserVerification: true,
  consumeOnUnlock: true,
  suspendRevokes: true,
  lockedToolPolicyRevision: LOCKED_COMPUTER_CONTROL_TOOL_POLICY_REVISION,
  // The disabled policy carries no executable authority. Slice 5 replaces this sentinel
  // with the canonical daemon allowlist digest before a platform can become eligible.
  allowedLockedToolIdsSha256: "0".repeat(64),
});

export const DEFAULT_LOCKED_COMPUTER_CONTROL_POLICIES: Readonly<
  Record<LockedComputerControlPlatform, LockedComputerControlPolicyV1>
> = Object.freeze({
  darwin: DISABLED_LOCKED_CONTROL_POLICY,
  win32: DISABLED_LOCKED_CONTROL_POLICY,
});

export interface LockedComputerControlCapabilityV1 {
  readonly schemaVersion: 1;
  readonly platform: LockedComputerControlPlatform;
  readonly state: LockedCapabilityState;
  readonly reason?: LockedControlReasonCode;
  readonly canCaptureSameUserDesktopWhileLocked: boolean;
  readonly canInjectSameUserDesktopWhileLocked: boolean;
  readonly canProveSessionContinuity: boolean;
  readonly secureSurfaceExcluded: boolean;
  readonly adapterVersion: string;
  readonly osVersion: string;
  readonly observedAt: string;
}

export interface LockedControlIdentityResultV1 {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly status: LockedControlIdentityStatus;
  readonly method: "device_owner_authentication" | "windows_user_consent";
  readonly verifiedAt?: string;
  readonly reason?: LockedControlReasonCode;
}

export interface LockedComputerControlGrantV1 {
  readonly schemaVersion: 1;
  readonly grantId: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly ttlSeconds: number;
  readonly workspaceCwd: string;
  readonly runId: string;
  readonly computerUseSessionId: string;
  readonly platform: LockedComputerControlPlatform;
  readonly desktopInstanceId: string;
  readonly desktopInstanceEpoch: number;
  readonly daemonAuthorityEpoch: string;
  readonly bridgeConnectionId: string;
  readonly authorizedNormalGeneration: number;
  readonly osSessionBindingDigest: string;
  readonly authorizedLockEpoch: number;
  readonly allowedLockedToolIdsDigest: string;
}

export interface LockedComputerControlAttestationV1 {
  readonly schemaVersion: 1;
  readonly grantId: string;
  readonly platform: LockedComputerControlPlatform;
  readonly lockEpoch: number;
  readonly sessionBindingDigest: string;
  readonly sameUserSession: boolean;
  readonly userDesktopTargeted: boolean;
  readonly captureReady: boolean;
  readonly inputReady: boolean;
  readonly secureSurfaceExcluded: boolean;
  readonly providerGeneration: number;
  readonly sequence: number;
  readonly observedAt: string;
}

export interface LockedComputerControlProjectionV1 {
  readonly schemaVersion: 1;
  readonly capability: LockedCapabilityState;
  readonly phase: LockedComputerControlPhase;
  readonly reason?: LockedControlReasonCode;
  readonly grantId?: string;
  readonly runId?: string;
  readonly computerUseSessionId?: string;
  readonly issuedAt?: string;
  readonly expiresAt?: string;
  readonly lockedSince?: string;
  readonly auditId?: string;
}

interface LockedComputerControlAuditCommonV1 {
  readonly schemaVersion: 1;
  readonly auditId: string;
  readonly event: LockedComputerControlAuditEventKind;
  readonly platform: LockedComputerControlPlatform;
  readonly occurredAt: string;
  readonly workspaceCwd?: string;
  readonly runId?: string;
  readonly computerUseSessionId?: string;
  readonly reason?: LockedControlReasonCode;
}

export type LockedComputerControlAuditEventV1 =
  | (LockedComputerControlAuditCommonV1 & {
      readonly event: "locked_control_capability_evaluated";
      readonly capability: LockedCapabilityState;
      readonly adapterVersion: string;
      readonly buildId: string;
    })
  | (LockedComputerControlAuditCommonV1 & {
      readonly event: "locked_control_authorization_requested";
      readonly intentId: string;
      readonly runId: string;
      readonly computerUseSessionId: string;
      readonly ttlCeilingSeconds: number;
    })
  | (LockedComputerControlAuditCommonV1 & {
      readonly event: "locked_control_identity_resolved";
      readonly identityStatus: LockedControlIdentityStatus;
      readonly identityMethod: "device_owner_authentication" | "windows_user_consent";
    })
  | (LockedComputerControlAuditCommonV1 & {
      readonly event: "locked_control_grant_armed";
      readonly grantId: string;
      readonly runId: string;
      readonly computerUseSessionId: string;
      readonly expiresAt: string;
      readonly authorityDigest: string;
      readonly generationDigest: string;
    })
  | (LockedComputerControlAuditCommonV1 & {
      readonly event: "locked_control_entered";
      readonly grantId: string;
      readonly lockEpoch: number;
      readonly providerGeneration: number;
      readonly sameUserSession: boolean;
      readonly userDesktopTargeted: boolean;
      readonly captureReady: boolean;
      readonly inputReady: boolean;
      readonly secureSurfaceExcluded: boolean;
    })
  | (LockedComputerControlAuditCommonV1 & {
      readonly event: "locked_control_action_denied";
      readonly toolId: string;
      readonly toolCallId: string;
      readonly reason: LockedControlReasonCode;
      readonly approvalId?: string;
    })
  | (LockedComputerControlAuditCommonV1 & {
      readonly event: "locked_control_grant_revoked";
      readonly grantId: string;
      readonly trigger: LockedControlReasonCode;
      readonly acknowledged: boolean;
      readonly terminalAt: string;
    })
  | (LockedComputerControlAuditCommonV1 & {
      readonly event: "locked_control_recovered_unlocked";
      readonly previousGeneration: number;
      readonly nextGeneration: number;
      readonly result: "ready" | "unavailable";
    });

const POLICY_KEYS = new Set([
  "schemaVersion", "mode", "maxGrantTtlSeconds", "requireLocalUserVerification",
  "consumeOnUnlock", "suspendRevokes", "lockedToolPolicyRevision",
  "allowedLockedToolIdsSha256",
]);
const CAPABILITY_KEYS = new Set([
  "schemaVersion", "platform", "state", "reason",
  "canCaptureSameUserDesktopWhileLocked", "canInjectSameUserDesktopWhileLocked",
  "canProveSessionContinuity", "secureSurfaceExcluded", "adapterVersion", "osVersion",
  "observedAt",
]);
const IDENTITY_KEYS = new Set([
  "schemaVersion", "requestId", "status", "method", "verifiedAt", "reason",
]);
const GRANT_KEYS = new Set([
  "schemaVersion", "grantId", "issuedAt", "expiresAt", "ttlSeconds", "workspaceCwd",
  "runId", "computerUseSessionId", "platform", "desktopInstanceId",
  "desktopInstanceEpoch", "daemonAuthorityEpoch", "bridgeConnectionId",
  "authorizedNormalGeneration", "osSessionBindingDigest", "authorizedLockEpoch",
  "allowedLockedToolIdsDigest",
]);
const ATTESTATION_KEYS = new Set([
  "schemaVersion", "grantId", "platform", "lockEpoch", "sessionBindingDigest",
  "sameUserSession", "userDesktopTargeted", "captureReady", "inputReady",
  "secureSurfaceExcluded", "providerGeneration", "sequence", "observedAt",
]);
const PROJECTION_KEYS = new Set([
  "schemaVersion", "capability", "phase", "reason", "grantId", "runId",
  "computerUseSessionId", "issuedAt", "expiresAt", "lockedSince", "auditId",
]);
const AUDIT_COMMON_KEYS = [
  "schemaVersion", "auditId", "event", "platform", "occurredAt", "workspaceCwd", "runId",
  "computerUseSessionId", "reason",
] as const;
const AUDIT_EVENT_KEYS: Readonly<Record<LockedComputerControlAuditEventKind, readonly string[]>> = {
  locked_control_capability_evaluated: ["capability", "adapterVersion", "buildId"],
  locked_control_authorization_requested: ["intentId", "ttlCeilingSeconds"],
  locked_control_identity_resolved: ["identityStatus", "identityMethod"],
  locked_control_grant_armed: ["grantId", "expiresAt", "authorityDigest", "generationDigest"],
  locked_control_entered: [
    "grantId", "lockEpoch", "providerGeneration", "sameUserSession", "userDesktopTargeted",
    "captureReady", "inputReady", "secureSurfaceExcluded",
  ],
  locked_control_action_denied: ["toolId", "toolCallId", "approvalId"],
  locked_control_grant_revoked: ["grantId", "trigger", "acknowledged", "terminalAt"],
  locked_control_recovered_unlocked: ["previousGeneration", "nextGeneration", "result"],
};

export function isLockedControlReasonCode(value: unknown): value is LockedControlReasonCode {
  return typeof value === "string"
    && (LOCKED_COMPUTER_CONTROL_REASON_CODES as readonly string[]).includes(value);
}

export function isLockedComputerControlPolicyV1(
  value: unknown,
): value is LockedComputerControlPolicyV1 {
  return isRecordWithOnlyKeys(value, POLICY_KEYS)
    && value.schemaVersion === 1
    && (value.mode === "disabled" || value.mode === "task_grant_required")
    && isPositiveIntegerAtMost(value.maxGrantTtlSeconds, LOCKED_COMPUTER_CONTROL_MAX_GRANT_TTL_SECONDS)
    && value.requireLocalUserVerification === true
    && value.consumeOnUnlock === true
    && value.suspendRevokes === true
    && isBoundedText(value.lockedToolPolicyRevision)
    && isSha256(value.allowedLockedToolIdsSha256);
}

export function isLockedComputerControlCapabilityV1(
  value: unknown,
): value is LockedComputerControlCapabilityV1 {
  if (!isRecordWithOnlyKeys(value, CAPABILITY_KEYS)
    || value.schemaVersion !== 1
    || !isPlatform(value.platform)
    || !isCapabilityState(value.state)
    || !isBoundedText(value.adapterVersion)
    || !isBoundedText(value.osVersion)
    || !isCanonicalTimestamp(value.observedAt)
    || !areBooleans(value, [
      "canCaptureSameUserDesktopWhileLocked", "canInjectSameUserDesktopWhileLocked",
      "canProveSessionContinuity", "secureSurfaceExcluded",
    ])) {
    return false;
  }
  const allProofs = value.canCaptureSameUserDesktopWhileLocked === true
    && value.canInjectSameUserDesktopWhileLocked === true
    && value.canProveSessionContinuity === true
    && value.secureSurfaceExcluded === true;
  return value.state === "supported_restricted"
    ? allProofs && value.reason === undefined
    : !allProofs && isLockedControlReasonCode(value.reason);
}

export function isLockedControlIdentityResultV1(
  value: unknown,
): value is LockedControlIdentityResultV1 {
  if (!isRecordWithOnlyKeys(value, IDENTITY_KEYS)
    || value.schemaVersion !== 1
    || !isBoundedText(value.requestId)
    || !(LOCKED_COMPUTER_CONTROL_IDENTITY_STATUSES as readonly unknown[]).includes(value.status)
    || (value.method !== "device_owner_authentication" && value.method !== "windows_user_consent")) {
    return false;
  }
  if (value.status === "verified") {
    return isCanonicalTimestamp(value.verifiedAt) && value.reason === undefined;
  }
  if (value.verifiedAt !== undefined) {
    return false;
  }
  if (value.status === "cancelled") {
    return value.reason === "locked_control_identity_cancelled";
  }
  if (value.status === "unavailable") {
    return value.reason === "locked_control_identity_unavailable";
  }
  return value.status === "failed" && IDENTITY_FAILURE_REASONS.has(value.reason as LockedControlReasonCode);
}

export function isLockedComputerControlGrantV1(
  value: unknown,
  maxTtlSeconds: number = LOCKED_COMPUTER_CONTROL_MAX_GRANT_TTL_SECONDS,
): value is LockedComputerControlGrantV1 {
  if (!isRecordWithOnlyKeys(value, GRANT_KEYS)
    || value.schemaVersion !== 1
    || !isBoundedText(value.grantId)
    || !isCanonicalTimestamp(value.issuedAt)
    || !isCanonicalTimestamp(value.expiresAt)
    || !isPositiveIntegerAtMost(value.ttlSeconds, Math.min(maxTtlSeconds, LOCKED_COMPUTER_CONTROL_MAX_GRANT_TTL_SECONDS))
    || !isBoundedText(value.workspaceCwd, 4096)
    || !isBoundedText(value.runId)
    || !isBoundedText(value.computerUseSessionId)
    || !isPlatform(value.platform)
    || !isBoundedText(value.desktopInstanceId)
    || !isPositiveInteger(value.desktopInstanceEpoch)
    || !isBoundedText(value.daemonAuthorityEpoch)
    || !isBoundedText(value.bridgeConnectionId)
    || !isNonNegativeInteger(value.authorizedNormalGeneration)
    || !isSha256(value.osSessionBindingDigest)
    || !isPositiveInteger(value.authorizedLockEpoch)
    || !isSha256(value.allowedLockedToolIdsDigest)) {
    return false;
  }
  return Date.parse(value.expiresAt) - Date.parse(value.issuedAt) === value.ttlSeconds * 1_000;
}

export function isLockedComputerControlAttestationV1(
  value: unknown,
): value is LockedComputerControlAttestationV1 {
  return isRecordWithOnlyKeys(value, ATTESTATION_KEYS)
    && value.schemaVersion === 1
    && isBoundedText(value.grantId)
    && isPlatform(value.platform)
    && isPositiveInteger(value.lockEpoch)
    && isSha256(value.sessionBindingDigest)
    && areBooleans(value, [
      "sameUserSession", "userDesktopTargeted", "captureReady", "inputReady",
      "secureSurfaceExcluded",
    ])
    && isPositiveInteger(value.providerGeneration)
    && isPositiveInteger(value.sequence)
    && isCanonicalTimestamp(value.observedAt);
}

export function isPositiveLockedComputerControlAttestationV1(
  value: unknown,
): value is LockedComputerControlAttestationV1 {
  return isLockedComputerControlAttestationV1(value)
    && value.sameUserSession
    && value.userDesktopTargeted
    && value.captureReady
    && value.inputReady
    && value.secureSurfaceExcluded;
}

export function isLockedComputerControlProjectionV1(
  value: unknown,
): value is LockedComputerControlProjectionV1 {
  if (!isRecordWithOnlyKeys(value, PROJECTION_KEYS)
    || value.schemaVersion !== 1
    || !isCapabilityState(value.capability)
    || !(LOCKED_COMPUTER_CONTROL_PHASES as readonly unknown[]).includes(value.phase)
    || (value.reason !== undefined && !isLockedControlReasonCode(value.reason))
    || (value.auditId !== undefined && !isBoundedText(value.auditId))) {
    return false;
  }
  const grantFieldsValid = isBoundedText(value.grantId)
    && isBoundedText(value.runId)
    && isBoundedText(value.computerUseSessionId)
    && isCanonicalTimestamp(value.issuedAt)
    && isCanonicalTimestamp(value.expiresAt)
    && Date.parse(value.expiresAt) > Date.parse(value.issuedAt);
  const hasNoGrantFields = [
    value.grantId, value.runId, value.computerUseSessionId, value.issuedAt, value.expiresAt,
    value.lockedSince,
  ].every((item) => item === undefined);

  if (value.capability !== "supported_restricted") {
    return value.phase === "off" && hasNoGrantFields && isLockedControlReasonCode(value.reason);
  }
  switch (value.phase) {
    case "off":
      return hasNoGrantFields;
    case "verifying":
      return hasNoGrantFields && value.reason === undefined;
    case "armed":
      return grantFieldsValid && value.lockedSince === undefined && value.reason === undefined;
    case "active_locked":
      return grantFieldsValid && isCanonicalTimestamp(value.lockedSince)
        && value.reason === undefined;
    case "paused":
      return grantFieldsValid && isCanonicalTimestamp(value.lockedSince)
        && isLockedControlReasonCode(value.reason);
  }
  return false;
}

export function isLockedComputerControlAuditEventV1(
  value: unknown,
): value is LockedComputerControlAuditEventV1 {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || !isBoundedText(value.auditId)
    || !isAuditEventKind(value.event)
    || !isPlatform(value.platform)
    || !isCanonicalTimestamp(value.occurredAt)
    || !isOptionalBoundedText(value.workspaceCwd, 4096)
    || !isOptionalBoundedText(value.runId)
    || !isOptionalBoundedText(value.computerUseSessionId)
    || (value.reason !== undefined && !isLockedControlReasonCode(value.reason))) {
    return false;
  }
  const allowedKeys = new Set([...AUDIT_COMMON_KEYS, ...AUDIT_EVENT_KEYS[value.event]]);
  if (!Object.keys(value).every((key) => allowedKeys.has(key))) {
    return false;
  }
  switch (value.event) {
    case "locked_control_capability_evaluated":
      return isCapabilityState(value.capability)
        && isBoundedText(value.adapterVersion)
        && isBoundedText(value.buildId)
        && (value.capability === "supported_restricted"
          ? value.reason === undefined
          : isLockedControlReasonCode(value.reason));
    case "locked_control_authorization_requested":
      return isBoundedText(value.intentId)
        && isBoundedText(value.runId)
        && isBoundedText(value.computerUseSessionId)
        && isPositiveIntegerAtMost(value.ttlCeilingSeconds, LOCKED_COMPUTER_CONTROL_MAX_GRANT_TTL_SECONDS)
        && value.reason === undefined;
    case "locked_control_identity_resolved":
      return (LOCKED_COMPUTER_CONTROL_IDENTITY_STATUSES as readonly unknown[]).includes(value.identityStatus)
        && (value.identityMethod === "device_owner_authentication" || value.identityMethod === "windows_user_consent")
        && isIdentityStatusReasonTuple(value.identityStatus, value.reason);
    case "locked_control_grant_armed":
      return isBoundedText(value.grantId)
        && isBoundedText(value.runId)
        && isBoundedText(value.computerUseSessionId)
        && isCanonicalTimestamp(value.expiresAt)
        && isSha256(value.authorityDigest)
        && isSha256(value.generationDigest)
        && value.reason === undefined;
    case "locked_control_entered":
      return isBoundedText(value.grantId)
        && isPositiveInteger(value.lockEpoch)
        && isPositiveInteger(value.providerGeneration)
        && areBooleans(value, [
          "sameUserSession", "userDesktopTargeted", "captureReady", "inputReady",
          "secureSurfaceExcluded",
        ])
        && value.reason === undefined;
    case "locked_control_action_denied":
      return isBoundedText(value.toolId)
        && isBoundedText(value.toolCallId)
        && isLockedControlReasonCode(value.reason)
        && isOptionalBoundedText(value.approvalId);
    case "locked_control_grant_revoked":
      return isBoundedText(value.grantId)
        && isLockedControlReasonCode(value.trigger)
        && typeof value.acknowledged === "boolean"
        && isCanonicalTimestamp(value.terminalAt)
        && value.reason === value.trigger;
    case "locked_control_recovered_unlocked":
      return isPositiveInteger(value.previousGeneration)
        && isPositiveInteger(value.nextGeneration)
        && value.nextGeneration > value.previousGeneration
        && (value.result === "ready" || value.result === "unavailable")
        && (value.result === "ready"
          ? value.reason === undefined
          : isLockedControlReasonCode(value.reason));
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRecordWithOnlyKeys(
  value: unknown,
  allowedKeys: ReadonlySet<string>,
): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).every((key) => allowedKeys.has(key));
}

function isBoundedText(value: unknown, maxLength = 256): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maxLength
    && value.trim() === value;
}

function isOptionalBoundedText(value: unknown, maxLength = 256): value is string | undefined {
  return value === undefined || isBoundedText(value, maxLength);
}

function isPlatform(value: unknown): value is LockedComputerControlPlatform {
  return value === "darwin" || value === "win32";
}

function isCapabilityState(value: unknown): value is LockedCapabilityState {
  return (LOCKED_COMPUTER_CONTROL_CAPABILITY_STATES as readonly unknown[]).includes(value);
}

function isAuditEventKind(value: unknown): value is LockedComputerControlAuditEventKind {
  return (LOCKED_COMPUTER_CONTROL_AUDIT_EVENT_KINDS as readonly unknown[]).includes(value);
}

const IDENTITY_FAILURE_REASONS: ReadonlySet<LockedControlReasonCode> = new Set([
  "locked_control_identity_failed",
  "locked_control_no_active_run",
  "locked_control_session_mismatch",
  "locked_control_authority_rotated",
  "locked_control_suspend",
  "locked_control_user_switched",
]);

function isIdentityStatusReasonTuple(status: unknown, reason: unknown): boolean {
  if (status === "verified") {
    return reason === undefined;
  }
  if (status === "cancelled") {
    return reason === "locked_control_identity_cancelled";
  }
  if (status === "unavailable") {
    return reason === "locked_control_identity_unavailable";
  }
  return status === "failed" && IDENTITY_FAILURE_REASONS.has(reason as LockedControlReasonCode);
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isPositiveIntegerAtMost(value: unknown, ceiling: number): value is number {
  return isPositiveInteger(value) && value <= ceiling;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    return false;
  }
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function areBooleans(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => typeof value[key] === "boolean");
}
