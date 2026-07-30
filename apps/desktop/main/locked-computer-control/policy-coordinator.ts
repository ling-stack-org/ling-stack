import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type {
  LockedComputerControlCapabilityV1,
  LockedComputerControlGrantV1,
  LockedComputerControlPolicyV1,
  LockedControlReasonCode,
} from "@ling-stack/contracts";
import type { DesktopCommandResult } from "../../shared/desktop-capabilities.js";
import type { LockedControlCapabilityAttestor } from "./capability-attestor.js";
import type {
  LockedControlDaemonClient,
  LockedControlDaemonGrantAuthority,
  LockedControlDaemonHandshakeAuthority,
} from "./daemon-client.js";
import type { LockedControlIdentityVerifier } from "./identity-verifier.js";

export type LockedControlLocalPhase =
  | "off"
  | "verifying"
  | "armed"
  | "attesting"
  | "active_locked"
  | "revoking";

export interface LockedControlRuntimeAuthority extends LockedControlDaemonHandshakeAuthority {
  readonly platform: "darwin" | "win32";
  readonly desktopInstanceId: string;
  readonly normalGeneration: number;
  readonly lockEpoch: number;
  readonly sessionBindingDigest?: string;
}

export interface LockedControlGenerationRuntime {
  readAuthority(): LockedControlRuntimeAuthority;
  /** Must close the daemon/provider admission gate synchronously. */
  closeCallGate(reason: LockedControlReasonCode): void;
  /** Fences input and retires the normal generation without starting another. */
  retireNormalForLock(reason: LockedControlReasonCode): Promise<void>;
  reserveLockedGeneration(): number;
  startLockedGeneration(input: {
    readonly generation: number;
    readonly grant: LockedComputerControlGrantV1;
  }): Promise<void>;
  stopLockedGeneration(reason: LockedControlReasonCode): Promise<void>;
  resumeNormal(): Promise<void>;
}

export interface LockedControlPolicyCoordinatorSnapshot {
  readonly phase: LockedControlLocalPhase;
  readonly lockEpoch: number;
  readonly grantId?: string;
  readonly expiresAt?: string;
  readonly reason?: LockedControlReasonCode;
}

/**
 * One serialized authority owner.
 *
 * OFF -> VERIFYING -> ARMED -> ATTESTING -> ACTIVE_LOCKED
 *  ^         |          |          |              |
 *  +---------+----------+----------+---- REVOKING-+
 *
 * Lock closes admission before it joins the queue. Every queued boundary then
 * rotates provider authority; no normal or restricted generation is reused.
 */
export class LockedComputerControlPolicyCoordinator {
  private operationTail: Promise<void> = Promise.resolve();
  private authorizePromise: Promise<DesktopCommandResult> | undefined;
  private phase: LockedControlLocalPhase = "off";
  private grant: LockedComputerControlGrantV1 | undefined;
  private grantDeadlineMonotonicMs: number | undefined;
  private grantDeadlineTimer: NodeJS.Timeout | undefined;
  private lockEpoch = 0;
  private attestationSequence = 0;
  private boundaryRevision = 0;
  private stopped = false;
  private reason: LockedControlReasonCode | undefined;

  constructor(private readonly options: {
    readonly policy: LockedComputerControlPolicyV1;
    readonly capability: () => LockedComputerControlCapabilityV1;
    readonly daemon: LockedControlDaemonClient;
    readonly identityVerifier: LockedControlIdentityVerifier;
    readonly attestor: LockedControlCapabilityAttestor;
    readonly runtime: LockedControlGenerationRuntime;
    readonly createRequestId?: () => string;
    readonly monotonicNowMs?: () => number;
    readonly onStateChanged?: (snapshot: LockedControlPolicyCoordinatorSnapshot) => void;
  }) {}

  snapshot(): LockedControlPolicyCoordinatorSnapshot {
    return Object.freeze({
      phase: this.phase,
      lockEpoch: this.lockEpoch,
      ...(this.grant ? { grantId: this.grant.grantId, expiresAt: this.grant.expiresAt } : {}),
      ...(this.reason ? { reason: this.reason } : {}),
    });
  }

  authorizeCurrentTask(): Promise<DesktopCommandResult> {
    if (this.stopped) return Promise.resolve({ accepted: false, reason: "locked_control_authority_rotated" });
    if (this.authorizePromise) return this.authorizePromise;
    const pending = this.enqueue(() => this.authorizeInternal());
    this.authorizePromise = pending;
    void pending.finally(() => {
      if (this.authorizePromise === pending) this.authorizePromise = undefined;
    }).catch(() => undefined);
    return pending;
  }

  revokeCurrentGrant(): Promise<DesktopCommandResult> {
    this.advanceBoundaryRevision();
    return this.enqueue(async () => {
      const authority = this.safeReadAuthority();
      await this.revokeInMemoryFirst("locked_control_grant_consumed", authority, true);
      return { accepted: true };
    });
  }

  /** Call directly from the native/Electron lock listener before awaiting. */
  handleLock(): Promise<void> {
    this.advanceBoundaryRevision();
    this.options.runtime.closeCallGate("locked_control_session_mismatch");
    return this.enqueue(() => this.handleLockInternal());
  }

  /** Unlock always consumes the grant and starts a fresh normal generation. */
  handleUnlock(): Promise<void> {
    this.advanceBoundaryRevision();
    this.options.runtime.closeCallGate("locked_control_grant_consumed");
    return this.enqueue(async () => {
      await this.options.runtime.stopLockedGeneration("locked_control_grant_consumed").catch(() => undefined);
      await this.revokeInMemoryFirst("locked_control_grant_consumed", this.safeReadAuthority(), true);
      if (!this.stopped) await this.options.runtime.resumeNormal();
    });
  }

  handleSuspend(): Promise<void> {
    this.advanceBoundaryRevision();
    this.options.runtime.closeCallGate("locked_control_suspend");
    return this.enqueue(async () => {
      await this.options.runtime.stopLockedGeneration("locked_control_suspend").catch(() => undefined);
      await this.options.runtime.retireNormalForLock("locked_control_suspend").catch(() => undefined);
      await this.revokeInMemoryFirst("locked_control_suspend", this.safeReadAuthority(), false);
    });
  }

  handleResume(): Promise<void> {
    this.advanceBoundaryRevision();
    this.options.runtime.closeCallGate("locked_control_suspend");
    return this.enqueue(async () => {
      if (!this.stopped) await this.options.runtime.resumeNormal();
    });
  }

  handleAuthorityRotated(): Promise<void> {
    this.advanceBoundaryRevision();
    this.options.runtime.closeCallGate("locked_control_authority_rotated");
    return this.enqueue(async () => {
      await this.options.runtime.stopLockedGeneration("locked_control_authority_rotated").catch(() => undefined);
      await this.revokeInMemoryFirst("locked_control_authority_rotated", this.safeReadAuthority(), false);
    });
  }

  shutdown(): Promise<void> {
    this.stopped = true;
    this.advanceBoundaryRevision();
    this.options.runtime.closeCallGate("locked_control_authority_rotated");
    return this.enqueue(async () => {
      await this.options.runtime.stopLockedGeneration("locked_control_authority_rotated").catch(() => undefined);
      await this.revokeInMemoryFirst("locked_control_authority_rotated", this.safeReadAuthority(), false);
    });
  }

  private async authorizeInternal(): Promise<DesktopCommandResult> {
    if (this.options.policy.mode !== "task_grant_required") {
      return { accepted: false, reason: "locked_control_disabled_by_build" };
    }
    const capability = this.options.capability();
    if (capability.state !== "supported_restricted") {
      return { accepted: false, reason: capability.reason ?? "locked_control_probe_required" };
    }
    if (this.phase !== "off" || this.grant) {
      return { accepted: false, reason: "locked_control_commit_unconfirmed" };
    }
    const authority = this.safeReadAuthority();
    if (!authority?.sessionBindingDigest || authority.lockEpoch !== this.lockEpoch) {
      return { accepted: false, reason: "locked_control_session_mismatch" };
    }
    if (this.lockEpoch >= Number.MAX_SAFE_INTEGER) {
      return { accepted: false, reason: "locked_control_authority_rotated" };
    }
    const requestId = this.options.createRequestId?.() ?? `locked-control-${randomUUID()}`;
    const authorizationBoundaryRevision = this.boundaryRevision;
    const daemonSnapshot = await this.options.daemon.snapshot();
    const begun = await this.options.daemon.beginAuthorization({
      requestId,
      expectedRevision: daemonSnapshot.revision,
    });
    if (!begun.accepted) return { accepted: false, reason: begun.reason };
    this.transition("verifying");
    const identity = await this.options.identityVerifier.verify(requestId);
    if (identity.status !== "verified") {
      await this.revokeInMemoryFirst(identity.reason ?? "locked_control_identity_failed", authority, false);
      return { accepted: false, reason: identity.reason ?? "locked_control_identity_failed" };
    }
    const afterIdentity = this.safeReadAuthority();
    if (authorizationBoundaryRevision !== this.boundaryRevision
      || !sameAuthority(authority, afterIdentity)
      || !afterIdentity?.sessionBindingDigest
      || afterIdentity.lockEpoch !== this.lockEpoch) {
      await this.revokeInMemoryFirst("locked_control_authority_rotated", afterIdentity, false);
      return { accepted: false, reason: "locked_control_authority_rotated" };
    }
    const grantAuthority: LockedControlDaemonGrantAuthority = {
      platform: afterIdentity.platform,
      desktopInstanceId: afterIdentity.desktopInstanceId,
      desktopInstanceEpoch: afterIdentity.desktopInstanceEpoch,
      daemonAuthorityEpoch: afterIdentity.daemonAuthorityEpoch,
      bridgeConnectionId: afterIdentity.bridgeConnectionId,
      workspaceCwd: afterIdentity.workspaceCwd,
      authorizedNormalGeneration: afterIdentity.normalGeneration,
      authorizedLockEpoch: this.lockEpoch + 1,
      osSessionBindingDigest: afterIdentity.sessionBindingDigest,
      allowedLockedToolIdsDigest: this.options.policy.allowedLockedToolIdsSha256,
    };
    const prepared = await this.options.daemon.prepare({
      requestId,
      expectedRevision: begun.snapshot.revision,
      identity,
      authority: grantAuthority,
    });
    if (!prepared.accepted) {
      this.transition("off", prepared.reason);
      return { accepted: false, reason: prepared.reason };
    }
    this.installGrant(prepared.grant);
    let committed;
    try {
      committed = await this.options.daemon.commit({
        requestId,
        grantId: prepared.grant.grantId,
        expectedRevision: prepared.snapshot.revision,
        authority: afterIdentity,
      });
    } catch {
      const reconciled = await this.options.daemon.reconcile({
        requestId,
        grantId: prepared.grant.grantId,
        authority: afterIdentity,
      }).catch(() => undefined);
      if (reconciled?.projection.grantId === prepared.grant.grantId
        && reconciled.projection.phase === "armed") {
        this.transition("armed");
        return { accepted: true };
      }
      await this.revokeInMemoryFirst("locked_control_commit_unconfirmed", afterIdentity, false);
      return { accepted: false, reason: "locked_control_commit_unconfirmed" };
    }
    if (!committed.accepted) {
      await this.revokeInMemoryFirst(committed.reason, afterIdentity, false);
      return { accepted: false, reason: committed.reason };
    }
    this.transition("armed");
    return { accepted: true };
  }

  private async handleLockInternal(): Promise<void> {
    if (this.lockEpoch >= Number.MAX_SAFE_INTEGER) {
      await this.revokeInMemoryFirst("locked_control_authority_rotated", this.safeReadAuthority(), false);
      return;
    }
    this.lockEpoch += 1;
    const grant = this.grant;
    const authority = this.safeReadAuthority();
    const grantCurrent = grant
      && this.phase === "armed"
      && this.grantIsCurrent(grant, authority);
    try {
      await this.options.runtime.retireNormalForLock("locked_control_session_mismatch");
    } catch {
      await this.revokeInMemoryFirst("locked_control_input_fence_timeout", authority, false);
      return;
    }
    if (!grantCurrent || !grant || !authority) {
      await this.revokeInMemoryFirst(
        grant ? "locked_control_authority_rotated" : "locked_control_grant_consumed",
        authority,
        false,
      );
      return;
    }
    const generation = this.options.runtime.reserveLockedGeneration();
    this.transition("attesting");
    const attested = await this.options.attestor.attest({
      capability: this.options.capability(),
      grant,
      lockEpoch: this.lockEpoch,
      reservedProviderGeneration: generation,
      sequence: ++this.attestationSequence,
    });
    if (!attested.ok) {
      await this.revokeInMemoryFirst(attested.reason, authority, false);
      return;
    }
    const published = await this.options.daemon.publishAttestation({
      authority,
      attestation: attested.attestation,
    });
    if (!published.accepted) {
      await this.revokeInMemoryFirst(published.reason, authority, false);
      return;
    }
    try {
      await this.options.runtime.startLockedGeneration({ generation, grant });
      this.transition("active_locked");
    } catch {
      await this.revokeInMemoryFirst("locked_control_input_unavailable", authority, false);
    }
  }

  private grantIsCurrent(
    grant: LockedComputerControlGrantV1,
    authority: LockedControlRuntimeAuthority | undefined,
  ): boolean {
    return Boolean(
      authority
      && authority.sessionBindingDigest
      && grant.desktopInstanceId === authority.desktopInstanceId
      && grant.desktopInstanceEpoch === authority.desktopInstanceEpoch
      && grant.daemonAuthorityEpoch === authority.daemonAuthorityEpoch
      && grant.bridgeConnectionId === authority.bridgeConnectionId
      && grant.workspaceCwd === authority.workspaceCwd
      && grant.platform === authority.platform
      && grant.authorizedNormalGeneration === authority.normalGeneration
      && grant.authorizedLockEpoch === this.lockEpoch
      && grant.osSessionBindingDigest === authority.sessionBindingDigest
      && !this.grantExpired(grant),
    );
  }

  private installGrant(grant: LockedComputerControlGrantV1): void {
    this.clearDeadline();
    this.grant = grant;
    const remainingWallMs = Date.parse(grant.expiresAt) - Date.now();
    const ttlMs = Math.max(0, Math.min(remainingWallMs, grant.ttlSeconds * 1_000));
    this.grantDeadlineMonotonicMs = this.monotonicNowMs() + ttlMs;
    this.grantDeadlineTimer = setTimeout(() => {
      this.grantDeadlineTimer = undefined;
      void this.enqueue(() => this.revokeInMemoryFirst(
        "locked_control_grant_expired",
        this.safeReadAuthority(),
        false,
      ));
    }, ttlMs);
    this.grantDeadlineTimer.unref?.();
  }

  private grantExpired(grant: LockedComputerControlGrantV1): boolean {
    return Date.parse(grant.expiresAt) <= Date.now()
      || this.grantDeadlineMonotonicMs === undefined
      || this.monotonicNowMs() >= this.grantDeadlineMonotonicMs;
  }

  private async revokeInMemoryFirst(
    reason: LockedControlReasonCode,
    authority: LockedControlRuntimeAuthority | undefined,
    acknowledged: boolean,
  ): Promise<void> {
    const hadDaemonState = this.phase !== "off" || Boolean(this.grant);
    this.clearDeadline();
    this.grant = undefined;
    this.transition("revoking", reason);
    if (hadDaemonState && authority) {
      await this.options.daemon.revoke({ authority, reason, acknowledged }).catch(() => undefined);
    }
    this.transition("off", reason);
  }

  private safeReadAuthority(): LockedControlRuntimeAuthority | undefined {
    try {
      const authority = this.options.runtime.readAuthority();
      return isRuntimeAuthority(authority) ? authority : undefined;
    } catch {
      return undefined;
    }
  }

  private transition(phase: LockedControlLocalPhase, reason?: LockedControlReasonCode): void {
    this.phase = phase;
    this.reason = reason;
    try {
      this.options.onStateChanged?.(this.snapshot());
    } catch {
      // Projection observers do not own authority.
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.operationTail.then(operation, operation);
    this.operationTail = pending.then(() => undefined, () => undefined);
    return pending;
  }

  private monotonicNowMs(): number {
    return this.options.monotonicNowMs?.() ?? performance.now();
  }

  private clearDeadline(): void {
    if (this.grantDeadlineTimer) clearTimeout(this.grantDeadlineTimer);
    this.grantDeadlineTimer = undefined;
    this.grantDeadlineMonotonicMs = undefined;
  }

  private advanceBoundaryRevision(): void {
    if (this.boundaryRevision >= Number.MAX_SAFE_INTEGER) {
      this.boundaryRevision = Number.MAX_SAFE_INTEGER;
      return;
    }
    this.boundaryRevision += 1;
  }
}

function sameAuthority(
  left: LockedControlRuntimeAuthority,
  right: LockedControlRuntimeAuthority | undefined,
): boolean {
  return Boolean(
    right
    && left.platform === right.platform
    && left.desktopInstanceId === right.desktopInstanceId
    && left.desktopInstanceEpoch === right.desktopInstanceEpoch
    && left.daemonAuthorityEpoch === right.daemonAuthorityEpoch
    && left.bridgeConnectionId === right.bridgeConnectionId
    && left.workspaceCwd === right.workspaceCwd
    && left.normalGeneration === right.normalGeneration
    && left.lockEpoch === right.lockEpoch
    && left.sessionBindingDigest === right.sessionBindingDigest,
  );
}

function isRuntimeAuthority(value: LockedControlRuntimeAuthority): boolean {
  return (value.platform === "darwin" || value.platform === "win32")
    && isText(value.desktopInstanceId)
    && Number.isSafeInteger(value.desktopInstanceEpoch) && value.desktopInstanceEpoch > 0
    && isText(value.daemonAuthorityEpoch)
    && isText(value.bridgeConnectionId)
    && isText(value.workspaceCwd, 4_096)
    && Number.isSafeInteger(value.normalGeneration) && value.normalGeneration >= 0
    && Number.isSafeInteger(value.lockEpoch) && value.lockEpoch >= 0
    && (value.sessionBindingDigest === undefined || /^[a-f0-9]{64}$/u.test(value.sessionBindingDigest));
}

function isText(value: unknown, maxLength = 256): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength && value.trim() === value;
}
