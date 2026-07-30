import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type {
  LockedComputerControlAttestationV1,
  LockedComputerControlAuditEventV1,
  LockedComputerControlCapabilityV1,
  LockedComputerControlGrantV1,
  LockedComputerControlPlatform,
  LockedComputerControlPolicyV1,
  LockedComputerControlProjectionV1,
  LockedControlIdentityResultV1,
  LockedControlReasonCode,
} from "@ling-stack/contracts";
import {
  isLockedComputerControlAttestationV1,
  isLockedComputerControlCapabilityV1,
  isLockedComputerControlGrantV1,
  isLockedComputerControlPolicyV1,
  isLockedControlIdentityResultV1,
  isPositiveLockedComputerControlAttestationV1,
} from "@ling-stack/contracts";

export const LOCKED_CONTROL_PREPARED_TTL_MS = 30_000;
export const LOCKED_CONTROL_ATTESTATION_FRESHNESS_MS = 3_000;

export interface LockedControlRegistrySnapshot {
  readonly revision: number;
  readonly projection: LockedComputerControlProjectionV1;
}

export interface LockedControlAuthorizationIntentInput {
  readonly requestId: string;
  readonly expectedRevision: number;
  readonly workspaceCwd: string;
  readonly runId: string;
  readonly computerUseSessionId: string;
}

export interface LockedControlGrantAuthorityInput {
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

export interface LockedControlPrepareInput {
  readonly requestId: string;
  readonly expectedRevision: number;
  readonly identity: LockedControlIdentityResultV1;
  readonly authority: LockedControlGrantAuthorityInput;
  readonly requestedTtlSeconds?: number;
}

export interface LockedControlCommitInput {
  readonly requestId: string;
  readonly grantId: string;
  readonly expectedRevision: number;
}

export type LockedControlMutationResult =
  | { readonly accepted: true; readonly snapshot: LockedControlRegistrySnapshot }
  | { readonly accepted: false; readonly reason: LockedControlReasonCode; readonly snapshot: LockedControlRegistrySnapshot };

export type LockedControlPrepareResult =
  | {
      readonly accepted: true;
      readonly grant: LockedComputerControlGrantV1;
      readonly snapshot: LockedControlRegistrySnapshot;
    }
  | {
      readonly accepted: false;
      readonly reason: LockedControlReasonCode;
      readonly snapshot: LockedControlRegistrySnapshot;
    };

export interface LockedControlRegistryOptions {
  readonly policy: LockedComputerControlPolicyV1;
  readonly capability: LockedComputerControlCapabilityV1;
  readonly isScopeActive: (input: {
    readonly workspaceCwd: string;
    readonly runId: string;
    readonly computerUseSessionId: string;
  }) => boolean;
  readonly isAuthorityCurrent: (input: LockedControlGrantAuthorityInput & { readonly workspaceCwd: string }) => boolean;
  readonly appendAudit: (event: LockedComputerControlAuditEventV1) => void;
  readonly now?: () => Date;
  readonly monotonicNowMs?: () => number;
  readonly createId?: () => string;
  readonly scheduleDeadline?: (callback: () => void, delayMs: number) => { cancel(): void };
}

interface AuthorizationIntent {
  readonly requestId: string;
  readonly workspaceCwd: string;
  readonly runId: string;
  readonly computerUseSessionId: string;
  readonly auditId: string;
}

interface PreparedGrant {
  readonly requestId: string;
  readonly grant: LockedComputerControlGrantV1;
  readonly expiresMonotonicMs: number;
}

interface LiveGrant {
  readonly grant: LockedComputerControlGrantV1;
  readonly expiresMonotonicMs: number;
  attestation?: LockedComputerControlAttestationV1;
  attestationAcceptedMonotonicMs?: number;
}

export class LockedComputerControlRegistry {
  private readonly policy: LockedComputerControlPolicyV1;
  private capability: LockedComputerControlCapabilityV1;
  private readonly now: () => Date;
  private readonly monotonicNowMs: () => number;
  private readonly createId: () => string;
  private readonly scheduleDeadline: NonNullable<LockedControlRegistryOptions["scheduleDeadline"]>;
  private revision = 0;
  private projection: LockedComputerControlProjectionV1;
  private intent: AuthorizationIntent | undefined;
  private prepared: PreparedGrant | undefined;
  private live: LiveGrant | undefined;
  private deadline: { cancel(): void } | undefined;

  constructor(private readonly options: LockedControlRegistryOptions) {
    if (!isLockedComputerControlPolicyV1(options.policy)
      || !isLockedComputerControlCapabilityV1(options.capability)) {
      throw new Error("locked_control_registry_policy_invalid");
    }
    this.policy = options.policy;
    this.capability = options.capability;
    this.now = options.now ?? (() => new Date());
    this.monotonicNowMs = options.monotonicNowMs ?? (() => performance.now());
    this.createId = options.createId ?? randomUUID;
    this.scheduleDeadline = options.scheduleDeadline ?? defaultScheduleDeadline;
    this.projection = offProjection(options.capability);
  }

  snapshot(): LockedControlRegistrySnapshot {
    this.expireDue();
    return this.currentSnapshot();
  }

  evaluateCapability(capability: LockedComputerControlCapabilityV1, buildId: string): LockedControlMutationResult {
    if (!isLockedComputerControlCapabilityV1(capability)
      || capability.platform !== this.capability.platform
      || !isText(buildId)) {
      return this.denied("locked_control_probe_required");
    }
    if (this.live || this.prepared || this.intent) {
      this.revokeInMemory("locked_control_authority_rotated", true);
    }
    const reason = capability.state === "supported_restricted" ? undefined : capability.reason;
    this.options.appendAudit({
      schemaVersion: 1,
      auditId: this.createId(),
      event: "locked_control_capability_evaluated",
      platform: capability.platform,
      occurredAt: this.now().toISOString(),
      capability: capability.state,
      adapterVersion: capability.adapterVersion,
      buildId,
      ...(reason ? { reason } : {}),
    });
    this.capability = capability;
    this.transition(offProjection(capability));
    return { accepted: true, snapshot: this.currentSnapshot() };
  }

  beginAuthorization(input: LockedControlAuthorizationIntentInput): LockedControlMutationResult {
    this.expireDue();
    if (!this.matchesRevision(input.expectedRevision)) {
      return this.denied("locked_control_authority_rotated");
    }
    const eligibility = this.authorizationEligibility(input);
    if (eligibility) {
      return this.denied(eligibility);
    }
    if (this.intent) {
      return this.intent.requestId === input.requestId
        ? { accepted: true, snapshot: this.currentSnapshot() }
        : this.denied("locked_control_commit_unconfirmed");
    }
    const auditId = this.createId();
    this.options.appendAudit({
      schemaVersion: 1,
      auditId,
      event: "locked_control_authorization_requested",
      platform: this.capability.platform,
      occurredAt: this.now().toISOString(),
      workspaceCwd: input.workspaceCwd,
      intentId: input.requestId,
      runId: input.runId,
      computerUseSessionId: input.computerUseSessionId,
      ttlCeilingSeconds: this.policy.maxGrantTtlSeconds,
    });
    this.intent = {
      requestId: input.requestId,
      workspaceCwd: input.workspaceCwd,
      runId: input.runId,
      computerUseSessionId: input.computerUseSessionId,
      auditId,
    };
    this.transition({
      schemaVersion: 1,
      capability: "supported_restricted",
      phase: "verifying",
      auditId,
    });
    return { accepted: true, snapshot: this.currentSnapshot() };
  }

  prepare(input: LockedControlPrepareInput): LockedControlPrepareResult {
    this.expireDue();
    const intent = this.intent;
    if (!intent || intent.requestId !== input.requestId || !this.matchesRevision(input.expectedRevision)) {
      return this.prepareDenied("locked_control_commit_unconfirmed");
    }
    if (!isLockedControlIdentityResultV1(input.identity)
      || input.identity.requestId !== input.requestId
      || input.identity.status !== "verified"
      || input.identity.method !== identityMethodForPlatform(input.authority.platform)) {
      return this.prepareDenied("locked_control_identity_failed");
    }
    if (!this.options.isScopeActive(intent)
      || input.authority.platform !== this.capability.platform
      || !this.options.isAuthorityCurrent({ ...input.authority, workspaceCwd: intent.workspaceCwd })) {
      return this.prepareDenied("locked_control_authority_rotated");
    }
    const ttlSeconds = input.requestedTtlSeconds ?? this.policy.maxGrantTtlSeconds;
    const issuedAt = this.now();
    const grant: LockedComputerControlGrantV1 = {
      schemaVersion: 1,
      grantId: this.createId(),
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + ttlSeconds * 1_000).toISOString(),
      ttlSeconds,
      workspaceCwd: intent.workspaceCwd,
      runId: intent.runId,
      computerUseSessionId: intent.computerUseSessionId,
      platform: input.authority.platform,
      desktopInstanceId: input.authority.desktopInstanceId,
      desktopInstanceEpoch: input.authority.desktopInstanceEpoch,
      daemonAuthorityEpoch: input.authority.daemonAuthorityEpoch,
      bridgeConnectionId: input.authority.bridgeConnectionId,
      authorizedNormalGeneration: input.authority.authorizedNormalGeneration,
      osSessionBindingDigest: input.authority.osSessionBindingDigest,
      authorizedLockEpoch: input.authority.authorizedLockEpoch,
      allowedLockedToolIdsDigest: input.authority.allowedLockedToolIdsDigest,
    };
    if (!isLockedComputerControlGrantV1(grant, this.policy.maxGrantTtlSeconds)) {
      return this.prepareDenied("locked_control_disabled_by_policy");
    }
    this.options.appendAudit({
      schemaVersion: 1,
      auditId: this.createId(),
      event: "locked_control_identity_resolved",
      platform: grant.platform,
      occurredAt: issuedAt.toISOString(),
      workspaceCwd: grant.workspaceCwd,
      runId: grant.runId,
      computerUseSessionId: grant.computerUseSessionId,
      identityStatus: "verified",
      identityMethod: input.identity.method,
    });
    this.prepared = {
      requestId: input.requestId,
      grant,
      expiresMonotonicMs: this.monotonicNowMs() + LOCKED_CONTROL_PREPARED_TTL_MS,
    };
    this.bumpRevision();
    this.rescheduleDeadline();
    return { accepted: true, grant, snapshot: this.currentSnapshot() };
  }

  commit(input: LockedControlCommitInput): LockedControlMutationResult {
    this.expireDue();
    const prepared = this.prepared;
    if (!prepared
      || prepared.requestId !== input.requestId
      || prepared.grant.grantId !== input.grantId
      || !this.matchesRevision(input.expectedRevision)
      || !this.options.isScopeActive(prepared.grant)
      || !this.options.isAuthorityCurrent(prepared.grant)) {
      return this.denied("locked_control_commit_unconfirmed");
    }
    const wallNow = this.now();
    const remainingWallMs = Date.parse(prepared.grant.expiresAt) - wallNow.getTime();
    if (remainingWallMs <= 0) {
      this.clearPending();
      this.transition(offProjection(this.capability, "locked_control_grant_expired"));
      return this.denied("locked_control_grant_expired");
    }
    const auditId = this.createId();
    this.options.appendAudit({
      schemaVersion: 1,
      auditId,
      event: "locked_control_grant_armed",
      platform: prepared.grant.platform,
      occurredAt: wallNow.toISOString(),
      workspaceCwd: prepared.grant.workspaceCwd,
      runId: prepared.grant.runId,
      computerUseSessionId: prepared.grant.computerUseSessionId,
      grantId: prepared.grant.grantId,
      expiresAt: prepared.grant.expiresAt,
      authorityDigest: digestFields([
        prepared.grant.desktopInstanceId,
        String(prepared.grant.desktopInstanceEpoch),
        prepared.grant.daemonAuthorityEpoch,
        prepared.grant.bridgeConnectionId,
        prepared.grant.osSessionBindingDigest,
      ]),
      generationDigest: digestFields([
        String(prepared.grant.authorizedNormalGeneration),
        String(prepared.grant.authorizedLockEpoch),
        prepared.grant.allowedLockedToolIdsDigest,
      ]),
    });
    this.live = {
      grant: prepared.grant,
      expiresMonotonicMs: this.monotonicNowMs() + Math.min(
        remainingWallMs,
        prepared.grant.ttlSeconds * 1_000,
      ),
    };
    this.intent = undefined;
    this.prepared = undefined;
    this.transition({
      schemaVersion: 1,
      capability: "supported_restricted",
      phase: "armed",
      grantId: this.live.grant.grantId,
      runId: this.live.grant.runId,
      computerUseSessionId: this.live.grant.computerUseSessionId,
      issuedAt: this.live.grant.issuedAt,
      expiresAt: this.live.grant.expiresAt,
      auditId,
    });
    this.rescheduleDeadline();
    return { accepted: true, snapshot: this.currentSnapshot() };
  }

  reconcile(requestId: string, grantId: string): LockedControlRegistrySnapshot {
    this.expireDue();
    if (!this.live
      || this.live.grant.grantId !== grantId
      || this.prepared?.requestId === requestId) {
      return this.currentSnapshot();
    }
    return this.currentSnapshot();
  }

  acceptAttestation(attestation: LockedComputerControlAttestationV1): LockedControlMutationResult {
    this.expireDue();
    const live = this.live;
    if (!live || !isLockedComputerControlAttestationV1(attestation)) {
      return this.denied("locked_control_session_mismatch");
    }
    const previous = live.attestation;
    if (!isPositiveLockedComputerControlAttestationV1(attestation)
      || !attestationMatchesGrant(attestation, live.grant)
      || attestation.providerGeneration <= live.grant.authorizedNormalGeneration
      || (previous && attestation.providerGeneration !== previous.providerGeneration)) {
      this.revokeInMemory(reasonForNegativeAttestation(attestation), false);
      return this.denied(reasonForNegativeAttestation(attestation));
    }
    if (previous && attestation.sequence <= previous.sequence) {
      return this.denied("locked_control_authority_rotated");
    }
    const firstEntry = !previous;
    if (firstEntry) {
      const auditId = this.createId();
      this.options.appendAudit({
        schemaVersion: 1,
        auditId,
        event: "locked_control_entered",
        platform: live.grant.platform,
        occurredAt: this.now().toISOString(),
        workspaceCwd: live.grant.workspaceCwd,
        runId: live.grant.runId,
        computerUseSessionId: live.grant.computerUseSessionId,
        grantId: live.grant.grantId,
        lockEpoch: attestation.lockEpoch,
        providerGeneration: attestation.providerGeneration,
        sameUserSession: attestation.sameUserSession,
        userDesktopTargeted: attestation.userDesktopTargeted,
        captureReady: attestation.captureReady,
        inputReady: attestation.inputReady,
        secureSurfaceExcluded: attestation.secureSurfaceExcluded,
      });
      this.transition({
        schemaVersion: 1,
        capability: "supported_restricted",
        phase: "active_locked",
        grantId: live.grant.grantId,
        runId: live.grant.runId,
        computerUseSessionId: live.grant.computerUseSessionId,
        issuedAt: live.grant.issuedAt,
        expiresAt: live.grant.expiresAt,
        lockedSince: this.now().toISOString(),
        auditId,
      });
    }
    live.attestation = attestation;
    live.attestationAcceptedMonotonicMs = this.monotonicNowMs();
    this.rescheduleDeadline();
    return { accepted: true, snapshot: this.currentSnapshot() };
  }

  isCurrentPositiveAttestation(input: {
    readonly grantId: string;
    readonly platform: LockedComputerControlPlatform;
    readonly lockEpoch: number;
    readonly sessionBindingDigest: string;
    readonly providerGeneration: number;
    readonly sequence: number;
  }): boolean {
    this.expireDue();
    const live = this.live;
    const attestation = live?.attestation;
    return Boolean(
      live
      && attestation
      && isPositiveLockedComputerControlAttestationV1(attestation)
      && input.grantId === live.grant.grantId
      && input.grantId === attestation.grantId
      && input.platform === live.grant.platform
      && input.platform === attestation.platform
      && input.lockEpoch === live.grant.authorizedLockEpoch
      && input.lockEpoch === attestation.lockEpoch
      && input.sessionBindingDigest === live.grant.osSessionBindingDigest
      && input.sessionBindingDigest === attestation.sessionBindingDigest
      && input.providerGeneration === attestation.providerGeneration
      && input.sequence === attestation.sequence
      && live.attestationAcceptedMonotonicMs !== undefined
      && this.monotonicNowMs() - live.attestationAcceptedMonotonicMs <= LOCKED_CONTROL_ATTESTATION_FRESHNESS_MS,
    );
  }

  pause(reason: "locked_control_approval_required"): LockedControlMutationResult {
    this.expireDue();
    if (!this.live || !this.live.attestation || this.projection.phase !== "active_locked") {
      return this.denied("locked_control_session_mismatch");
    }
    this.transition({ ...this.projection, phase: "paused", reason });
    return { accepted: true, snapshot: this.currentSnapshot() };
  }

  revoke(reason: LockedControlReasonCode, acknowledged = true): LockedControlMutationResult {
    this.expireDue();
    return this.revokeInMemory(reason, acknowledged);
  }

  close(): void {
    this.deadline?.cancel();
    this.deadline = undefined;
    this.intent = undefined;
    this.prepared = undefined;
    this.live = undefined;
  }

  private authorizationEligibility(input: LockedControlAuthorizationIntentInput): LockedControlReasonCode | undefined {
    if (this.policy.mode !== "task_grant_required") {
      return this.policy.mode === "disabled"
        ? "locked_control_disabled_by_build"
        : "locked_control_disabled_by_policy";
    }
    if (this.capability.state !== "supported_restricted") {
      return this.capability.reason ?? "locked_control_probe_required";
    }
    if (!isText(input.requestId)
      || !isText(input.workspaceCwd, 4096)
      || !isText(input.runId)
      || !isText(input.computerUseSessionId)
      || !this.options.isScopeActive(input)) {
      return "locked_control_no_active_run";
    }
    if (this.live) {
      return "locked_control_commit_unconfirmed";
    }
    return undefined;
  }

  private expireDue(): void {
    const monotonicNow = this.monotonicNowMs();
    if (this.prepared && monotonicNow >= this.prepared.expiresMonotonicMs) {
      this.clearPending();
      this.transition(offProjection(this.capability, "locked_control_commit_unconfirmed"));
    }
    if (this.live && (
      monotonicNow >= this.live.expiresMonotonicMs
      || Date.parse(this.live.grant.expiresAt) <= this.now().getTime()
    )) {
      this.revokeInMemory("locked_control_grant_expired", false);
    } else if (this.live?.attestationAcceptedMonotonicMs !== undefined
      && monotonicNow - this.live.attestationAcceptedMonotonicMs > LOCKED_CONTROL_ATTESTATION_FRESHNESS_MS) {
      this.revokeInMemory("locked_control_session_mismatch", false);
    }
    this.rescheduleDeadline();
  }

  private revokeInMemory(reason: LockedControlReasonCode, acknowledged: boolean): LockedControlMutationResult {
    const grant = this.live?.grant ?? this.prepared?.grant;
    this.intent = undefined;
    this.prepared = undefined;
    this.live = undefined;
    this.transition(offProjection(this.capability, reason));
    this.rescheduleDeadline();
    if (grant) {
      const now = this.now().toISOString();
      try {
        this.options.appendAudit({
          schemaVersion: 1,
          auditId: this.createId(),
          event: "locked_control_grant_revoked",
          platform: grant.platform,
          occurredAt: now,
          workspaceCwd: grant.workspaceCwd,
          runId: grant.runId,
          computerUseSessionId: grant.computerUseSessionId,
          grantId: grant.grantId,
          trigger: reason,
          reason,
          acknowledged,
          terminalAt: now,
        });
      } catch {
        // Memory authority is already gone. Durable reconciliation is allowed to retry,
        // but an audit failure must never resurrect or extend a grant.
      }
    }
    return { accepted: true, snapshot: this.currentSnapshot() };
  }

  private rescheduleDeadline(): void {
    this.deadline?.cancel();
    this.deadline = undefined;
    const candidates = [
      this.prepared?.expiresMonotonicMs,
      this.live?.expiresMonotonicMs,
      this.live?.attestationAcceptedMonotonicMs === undefined
        ? undefined
        : this.live.attestationAcceptedMonotonicMs + LOCKED_CONTROL_ATTESTATION_FRESHNESS_MS + 1,
    ].filter((value): value is number => value !== undefined);
    if (candidates.length === 0) {
      return;
    }
    const delayMs = Math.max(0, Math.min(...candidates) - this.monotonicNowMs());
    this.deadline = this.scheduleDeadline(() => {
      this.deadline = undefined;
      this.expireDue();
    }, delayMs);
  }

  private clearPending(): void {
    this.intent = undefined;
    this.prepared = undefined;
  }

  private matchesRevision(expectedRevision: number): boolean {
    return Number.isSafeInteger(expectedRevision) && expectedRevision === this.revision;
  }

  private denied(reason: LockedControlReasonCode): LockedControlMutationResult {
    return { accepted: false, reason, snapshot: this.currentSnapshot() };
  }

  private prepareDenied(reason: LockedControlReasonCode): LockedControlPrepareResult {
    return { accepted: false, reason, snapshot: this.currentSnapshot() };
  }

  private transition(projection: LockedComputerControlProjectionV1): void {
    this.projection = Object.freeze(projection);
    this.bumpRevision();
  }

  private bumpRevision(): void {
    if (this.revision >= Number.MAX_SAFE_INTEGER) {
      throw new Error("locked_control_projection_revision_exhausted");
    }
    this.revision += 1;
  }

  private currentSnapshot(): LockedControlRegistrySnapshot {
    return Object.freeze({ revision: this.revision, projection: this.projection });
  }
}

function offProjection(
  capability: LockedComputerControlCapabilityV1,
  reason = capability.state === "supported_restricted" ? undefined : capability.reason,
): LockedComputerControlProjectionV1 {
  return {
    schemaVersion: 1,
    capability: capability.state,
    phase: "off",
    ...(reason ? { reason } : {}),
  };
}

function identityMethodForPlatform(
  platform: LockedComputerControlPlatform,
): LockedControlIdentityResultV1["method"] {
  return platform === "darwin" ? "device_owner_authentication" : "windows_user_consent";
}

function attestationMatchesGrant(
  attestation: LockedComputerControlAttestationV1,
  grant: LockedComputerControlGrantV1,
): boolean {
  return attestation.grantId === grant.grantId
    && attestation.platform === grant.platform
    && attestation.lockEpoch === grant.authorizedLockEpoch
    && attestation.sessionBindingDigest === grant.osSessionBindingDigest;
}

function reasonForNegativeAttestation(
  attestation: LockedComputerControlAttestationV1,
): LockedControlReasonCode {
  if (!attestation.sameUserSession || !attestation.userDesktopTargeted) {
    return "locked_control_session_mismatch";
  }
  if (!attestation.secureSurfaceExcluded) {
    return "locked_control_secure_surface";
  }
  if (!attestation.captureReady) {
    return "locked_control_capture_unavailable";
  }
  if (!attestation.inputReady) {
    return "locked_control_input_unavailable";
  }
  return "locked_control_authority_rotated";
}

function defaultScheduleDeadline(callback: () => void, delayMs: number): { cancel(): void } {
  const timer = setTimeout(callback, delayMs);
  timer.unref?.();
  return { cancel: () => clearTimeout(timer) };
}

function digestFields(fields: readonly string[]): string {
  return createHash("sha256").update(fields.join("\u001f"), "utf8").digest("hex");
}

function isText(value: unknown, maxLength = 256): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maxLength
    && value.trim() === value;
}
