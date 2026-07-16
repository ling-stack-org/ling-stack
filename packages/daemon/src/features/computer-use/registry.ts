import { resolve } from "node:path";
import type {
  ComputerUsePreviewEvent,
  ComputerUsePreviewEventsResponse,
  ComputerUsePreviewProjection,
} from "@ling-stack/contracts";
import { isTerminalComputerUseStatus } from "@ling-stack/contracts";

export interface ComputerUseProjectionSubscription {
  close(): void;
}

export interface ComputerUseProjectionSnapshot {
  readonly cwd: string;
  readonly projections: readonly ComputerUsePreviewProjection[];
  readonly latestSeq: number;
}

export interface ComputerUseProjectionReplay {
  readonly cwd: string;
  readonly afterSeq: number;
  readonly latestSeq: number;
  readonly events: readonly ComputerUsePreviewEvent[];
  readonly subscription: ComputerUseProjectionSubscription;
}

export interface ComputerUseStopAuditRecord {
  readonly auditId: string;
  readonly cwd: string;
  readonly sessionId: string;
  readonly requestedAt: string;
  readonly reason?: string;
  readonly accepted: boolean;
  readonly acknowledged: boolean;
  readonly acknowledgedAt?: string;
  readonly resultReason?: string;
}

export interface ComputerUsePrivatePreviewDescriptor {
  readonly descriptorId: string;
  readonly revision: number;
  readonly platform: "macos" | "windows";
  readonly sourceKind: "window" | "display";
  readonly target: {
    readonly applicationId?: string;
    readonly processId?: number;
    readonly nativeWindowId?: string;
    readonly electronSourceId?: string;
  };
  readonly authorization: {
    readonly grantId: string;
    readonly expiresAt: string;
  };
}

/**
 * Retention and lease defaults are intentionally bounded. Terminal projections
 * remain available long enough for a reconnecting Desktop client to consume
 * the terminal event, while the in-memory registry cannot grow forever.
 */
export const COMPUTER_USE_TERMINAL_RETENTION_MS = 5 * 60 * 1_000;
export const COMPUTER_USE_EVENT_RETENTION_MS = 10 * 60 * 1_000;
export const COMPUTER_USE_DESCRIPTOR_LEASE_MS = 15 * 60 * 1_000;
export const COMPUTER_USE_DESCRIPTOR_MAX_LIFETIME_MS = 24 * 60 * 60 * 1_000;

export interface ComputerUseProjectionRegistryOptions {
  readonly now?: () => Date;
  readonly terminalRetentionMs?: number;
  readonly eventRetentionMs?: number;
  readonly descriptorLeaseMs?: number;
  readonly descriptorMaxLifetimeMs?: number;
  readonly maxEventCount?: number;
}

interface WorkspaceComputerUseState {
  readonly projections: Map<string, ComputerUsePreviewProjection>;
  events: ComputerUsePreviewEvent[];
  nextSeq: number;
}

interface ProjectionListener {
  readonly cwd: string;
  readonly onEvent: (event: ComputerUsePreviewEvent) => void;
}

interface PrivateDescriptorLease {
  readonly issuedAtMs: number;
  readonly hardExpiresAtMs: number;
  descriptor: ComputerUsePrivatePreviewDescriptor;
}

export class ComputerUseProjectionRegistry {
  private readonly workspaces = new Map<string, WorkspaceComputerUseState>();
  private readonly listeners = new Set<ProjectionListener>();
  private readonly stopAudits: ComputerUseStopAuditRecord[] = [];
  private readonly privateDescriptors = new Map<string, Map<string, PrivateDescriptorLease>>();
  private readonly now: () => Date;
  private readonly terminalRetentionMs: number;
  private readonly eventRetentionMs: number;
  private readonly descriptorLeaseMs: number;
  private readonly descriptorMaxLifetimeMs: number;
  private readonly maxEventCount: number;
  private readonly startedAtMs: number;

  constructor(options: ComputerUseProjectionRegistryOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.terminalRetentionMs = nonNegativeDuration(
      options.terminalRetentionMs,
      COMPUTER_USE_TERMINAL_RETENTION_MS,
      "terminalRetentionMs",
    );
    this.eventRetentionMs = nonNegativeDuration(
      options.eventRetentionMs,
      COMPUTER_USE_EVENT_RETENTION_MS,
      "eventRetentionMs",
    );
    this.descriptorLeaseMs = positiveDuration(
      options.descriptorLeaseMs,
      COMPUTER_USE_DESCRIPTOR_LEASE_MS,
      "descriptorLeaseMs",
    );
    this.descriptorMaxLifetimeMs = positiveDuration(
      options.descriptorMaxLifetimeMs,
      COMPUTER_USE_DESCRIPTOR_MAX_LIFETIME_MS,
      "descriptorMaxLifetimeMs",
    );
    this.maxEventCount = positiveInteger(options.maxEventCount, 2_000, "maxEventCount");
    this.startedAtMs = this.now().getTime();
  }

  list(cwd: string): readonly ComputerUsePreviewProjection[] {
    this.prune();
    const state = this.workspace(cwd);
    return [...state.projections.values()].sort(compareLatestProjection);
  }

  snapshot(cwd: string): ComputerUseProjectionSnapshot {
    this.prune();
    const normalizedCwd = normalizeCwd(cwd);
    const state = this.workspace(normalizedCwd);
    return {
      cwd: normalizedCwd,
      projections: [...state.projections.values()].sort(compareLatestProjection),
      latestSeq: state.nextSeq - 1,
    };
  }

  get(cwd: string, sessionId: string): ComputerUsePreviewProjection | undefined {
    this.prune();
    return this.workspace(cwd).projections.get(sessionId);
  }

  upsert(
    cwd: string,
    projection: ComputerUsePreviewProjection,
    occurredAt = new Date().toISOString(),
  ): ComputerUsePreviewProjection {
    validateProjection(projection);
    const normalizedCwd = normalizeCwd(cwd);
    const state = this.workspace(normalizedCwd);
    const current = state.projections.get(projection.sessionId);
    if (current && !shouldReplaceProjection(current, projection)) {
      return current;
    }
    if (current && JSON.stringify(current) === JSON.stringify(projection)) {
      return current;
    }
    state.projections.set(projection.sessionId, projection);
    if (isTerminalComputerUseStatus(projection.status) && projection.preview) {
      this.revokePrivateDescriptor(normalizedCwd, projection.preview.descriptorId);
    }
    this.publish(normalizedCwd, {
      seq: state.nextSeq,
      kind: "upsert",
      sessionId: projection.sessionId,
      projection,
      occurredAt,
    });
    state.nextSeq += 1;
    return projection;
  }

  remove(cwd: string, sessionId: string, occurredAt = new Date().toISOString()): boolean {
    this.prune();
    const normalizedCwd = normalizeCwd(cwd);
    const state = this.workspace(normalizedCwd);
    const previous = state.projections.get(sessionId);
    if (!state.projections.delete(sessionId)) {
      return false;
    }
    if (previous?.preview) {
      this.revokePrivateDescriptor(normalizedCwd, previous.preview.descriptorId);
    }
    this.publish(normalizedCwd, {
      seq: state.nextSeq,
      kind: "remove",
      sessionId,
      occurredAt,
    });
    state.nextSeq += 1;
    return true;
  }

  listEvents(cwd: string, afterSeq = 0, limit = 500): ComputerUsePreviewEventsResponse {
    this.prune();
    const normalizedCwd = normalizeCwd(cwd);
    const state = this.workspace(normalizedCwd);
    const safeLimit = Math.min(Math.max(limit, 1), 1_000);
    return {
      cwd: normalizedCwd,
      afterSeq,
      latestSeq: state.nextSeq - 1,
      events: state.events.filter((event) => event.seq > afterSeq).slice(0, safeLimit),
    };
  }

  subscribe(cwd: string, onEvent: (event: ComputerUsePreviewEvent) => void): ComputerUseProjectionSubscription {
    this.prune();
    const listener: ProjectionListener = { cwd: normalizeCwd(cwd), onEvent };
    this.listeners.add(listener);
    return { close: () => this.listeners.delete(listener) };
  }

  subscribeFrom(
    cwd: string,
    afterSeq: number,
    onEvent: (event: ComputerUsePreviewEvent) => void,
  ): ComputerUseProjectionReplay {
    this.prune();
    const normalizedCwd = normalizeCwd(cwd);
    const state = this.workspace(normalizedCwd);
    const listener: ProjectionListener = { cwd: normalizedCwd, onEvent };

    // Register before taking the replay boundary. JavaScript runs this block
    // synchronously, so a publisher cannot land between listener registration
    // and the sequence snapshot. The caller can then write replay followed by
    // live events without a replay/subscribe gap.
    this.listeners.add(listener);
    const latestSeq = state.nextSeq - 1;
    const events = state.events.filter((event) => event.seq > afterSeq);
    return {
      cwd: normalizedCwd,
      afterSeq,
      latestSeq,
      events,
      subscription: { close: () => this.listeners.delete(listener) },
    };
  }

  registerPrivateDescriptor(cwd: string, descriptor: ComputerUsePrivatePreviewDescriptor): void {
    if (!descriptor.descriptorId.trim() || !Number.isInteger(descriptor.revision) || descriptor.revision < 0) {
      throw new Error("Computer Use private descriptor identity is invalid");
    }
    if (!descriptor.authorization.grantId.trim() || !Number.isFinite(Date.parse(descriptor.authorization.expiresAt))) {
      throw new Error("Computer Use private descriptor authorization is invalid");
    }
    const normalizedCwd = normalizeCwd(cwd);
    const nowMs = this.now().getTime();
    const suppliedExpiresAtMs = Date.parse(descriptor.authorization.expiresAt);
    const descriptors = this.privateDescriptors.get(normalizedCwd) ?? new Map<string, PrivateDescriptorLease>();
    const existing = descriptors.get(descriptor.descriptorId);
    const sameRevision = existing?.descriptor.revision === descriptor.revision;
    const issuedAtMs = sameRevision ? existing.issuedAtMs : nowMs;
    const hardExpiresAtMs = sameRevision
      ? existing.hardExpiresAtMs
      : nowMs + this.descriptorMaxLifetimeMs;
    const expiresAtMs = Math.min(suppliedExpiresAtMs, nowMs + this.descriptorLeaseMs, hardExpiresAtMs);
    const normalizedDescriptor: ComputerUsePrivatePreviewDescriptor = {
      ...descriptor,
      authorization: {
        ...descriptor.authorization,
        expiresAt: new Date(expiresAtMs).toISOString(),
      },
    };
    descriptors.set(descriptor.descriptorId, {
      issuedAtMs,
      hardExpiresAtMs,
      descriptor: normalizedDescriptor,
    });
    this.privateDescriptors.set(normalizedCwd, descriptors);
  }

  resolvePrivateDescriptor(
    cwd: string,
    descriptorId: string,
    revision: number,
    now = new Date(),
  ): ComputerUsePrivatePreviewDescriptor | undefined {
    this.prune(now);
    const descriptors = this.privateDescriptors.get(normalizeCwd(cwd));
    const lease = descriptors?.get(descriptorId);
    const descriptor = lease?.descriptor;
    if (!lease || !descriptor || descriptor.revision !== revision) {
      return undefined;
    }
    if (Date.parse(descriptor.authorization.expiresAt) <= now.getTime()) {
      descriptors?.delete(descriptorId);
      return undefined;
    }
    return descriptor;
  }

  /**
   * Extend an active descriptor's sliding lease without allowing it to live
   * past the bounded absolute lifetime established at registration.
   */
  renewPrivateDescriptor(
    cwd: string,
    descriptorId: string,
    revision: number,
    now = this.now(),
  ): ComputerUsePrivatePreviewDescriptor | undefined {
    const normalizedCwd = normalizeCwd(cwd);
    const descriptors = this.privateDescriptors.get(normalizedCwd);
    const lease = descriptors?.get(descriptorId);
    if (!lease || lease.descriptor.revision !== revision) {
      return undefined;
    }
    const nowMs = now.getTime();
    const currentExpiresAtMs = Date.parse(lease.descriptor.authorization.expiresAt);
    if (!Number.isFinite(currentExpiresAtMs) || currentExpiresAtMs <= nowMs || lease.hardExpiresAtMs <= nowMs) {
      descriptors?.delete(descriptorId);
      return undefined;
    }
    const nextExpiresAtMs = Math.min(nowMs + this.descriptorLeaseMs, lease.hardExpiresAtMs);
    lease.descriptor = {
      ...lease.descriptor,
      authorization: {
        ...lease.descriptor.authorization,
        expiresAt: new Date(nextExpiresAtMs).toISOString(),
      },
    };
    return lease.descriptor;
  }

  revokePrivateDescriptor(cwd: string, descriptorId: string): void {
    this.privateDescriptors.get(normalizeCwd(cwd))?.delete(descriptorId);
  }

  /**
   * Remove expired descriptors, terminal projections past their reconnect
   * window, and stale event history. Pruning is lazy so the registry does not
   * keep a process-wide timer alive; every public read/write boundary invokes
   * it before exposing state.
   */
  prune(now = this.now()): void {
    const nowMs = now.getTime();
    const terminalCutoffMs = nowMs - this.terminalRetentionMs;
    const eventCutoffMs = nowMs - this.eventRetentionMs;

    for (const [cwd, state] of this.workspaces) {
      for (const projection of state.projections.values()) {
        if (!isTerminalComputerUseStatus(projection.status)) {
          continue;
        }
        const terminalAtMs = Date.parse(projection.terminalAt ?? projection.updatedAt);
        if (Number.isFinite(terminalAtMs) && terminalAtMs >= this.startedAtMs && terminalAtMs <= terminalCutoffMs) {
          this.removeWithoutPrune(cwd, projection.sessionId, now.toISOString());
        }
      }
      state.events = state.events.filter((event) => {
        const occurredAtMs = Date.parse(event.occurredAt);
        return !Number.isFinite(occurredAtMs)
          || occurredAtMs < this.startedAtMs
          || occurredAtMs > eventCutoffMs;
      });
      if (state.events.length > this.maxEventCount) {
        state.events.splice(0, state.events.length - this.maxEventCount);
      }
    }

    for (const [cwd, descriptors] of this.privateDescriptors) {
      for (const [descriptorId, lease] of descriptors) {
        if (Date.parse(lease.descriptor.authorization.expiresAt) <= nowMs || lease.hardExpiresAtMs <= nowMs) {
          descriptors.delete(descriptorId);
        }
      }
      if (descriptors.size === 0) {
        this.privateDescriptors.delete(cwd);
      }
    }
  }

  recordStopAudit(record: ComputerUseStopAuditRecord): void {
    this.stopAudits.push({ ...record, cwd: normalizeCwd(record.cwd) });
    if (this.stopAudits.length > 1_000) {
      this.stopAudits.splice(0, this.stopAudits.length - 1_000);
    }
  }

  listStopAudits(cwd: string, sessionId?: string): readonly ComputerUseStopAuditRecord[] {
    const normalizedCwd = normalizeCwd(cwd);
    return this.stopAudits.filter(
      (record) => record.cwd === normalizedCwd && (!sessionId || record.sessionId === sessionId),
    );
  }

  closeAll(): void {
    this.listeners.clear();
    this.privateDescriptors.clear();
    this.workspaces.clear();
  }

  private publish(cwd: string, event: ComputerUsePreviewEvent): void {
    const state = this.workspace(cwd);
    state.events.push(event);
    if (state.events.length > this.maxEventCount) {
      state.events.splice(0, state.events.length - this.maxEventCount);
    }
    for (const listener of this.listeners) {
      if (listener.cwd === cwd) {
        listener.onEvent(event);
      }
    }
  }

  private workspace(cwd: string): WorkspaceComputerUseState {
    const normalizedCwd = normalizeCwd(cwd);
    const existing = this.workspaces.get(normalizedCwd);
    if (existing) {
      return existing;
    }
    const created: WorkspaceComputerUseState = {
      projections: new Map(),
      events: [],
      nextSeq: 1,
    };
    this.workspaces.set(normalizedCwd, created);
    return created;
  }

  private removeWithoutPrune(cwd: string, sessionId: string, occurredAt: string): boolean {
    const normalizedCwd = normalizeCwd(cwd);
    const state = this.workspace(normalizedCwd);
    const previous = state.projections.get(sessionId);
    if (!state.projections.delete(sessionId)) {
      return false;
    }
    if (previous?.preview) {
      this.revokePrivateDescriptor(normalizedCwd, previous.preview.descriptorId);
    }
    const event: ComputerUsePreviewEvent = {
      seq: state.nextSeq,
      kind: "remove",
      sessionId,
      occurredAt,
    };
    this.publish(normalizedCwd, event);
    state.nextSeq += 1;
    return true;
  }
}

function shouldReplaceProjection(
  current: ComputerUsePreviewProjection,
  incoming: ComputerUsePreviewProjection,
): boolean {
  if (isTerminalComputerUseStatus(current.status) && !isTerminalComputerUseStatus(incoming.status)) {
    return false;
  }
  const currentTime = Date.parse(current.updatedAt);
  const incomingTime = Date.parse(incoming.updatedAt);
  if (incomingTime !== currentTime) {
    return incomingTime > currentTime;
  }
  if (statusRank(incoming.status) < statusRank(current.status)) {
    return false;
  }
  const currentRevision = current.preview?.revision ?? -1;
  const incomingRevision = incoming.preview?.revision ?? -1;
  if (incomingRevision !== currentRevision) {
    return incomingRevision > currentRevision;
  }
  return statusRank(incoming.status) >= statusRank(current.status);
}

function statusRank(status: ComputerUsePreviewProjection["status"]): number {
  return {
    starting: 0,
    running: 1,
    waiting_for_approval: 2,
    paused: 2,
    stopping: 3,
    succeeded: 4,
    failed: 4,
    cancelled: 4,
  }[status];
}

function validateProjection(projection: ComputerUsePreviewProjection): void {
  for (const [label, value] of [
    ["sessionId", projection.sessionId],
    ["conversationId", projection.conversationId],
    ["target.displayName", projection.target.displayName],
  ] as const) {
    if (!value.trim()) {
      throw new Error(`${label} is required`);
    }
  }
  if (!Number.isFinite(Date.parse(projection.startedAt)) || !Number.isFinite(Date.parse(projection.updatedAt))) {
    throw new Error("startedAt and updatedAt must be valid ISO timestamps");
  }
  if (projection.preview && (!projection.preview.descriptorId.trim() || projection.preview.revision < 0)) {
    throw new Error("preview descriptorId and non-negative revision are required");
  }
}

function compareLatestProjection(left: ComputerUsePreviewProjection, right: ComputerUsePreviewProjection): number {
  return Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || right.sessionId.localeCompare(left.sessionId);
}

function normalizeCwd(cwd: string): string {
  return resolve(cwd);
}

function positiveDuration(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved <= 0) {
    throw new Error(`${label} must be a positive finite number`);
  }
  return Math.floor(resolved);
}

function nonNegativeDuration(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved < 0) {
    throw new Error(`${label} must be a non-negative finite number`);
  }
  return Math.floor(resolved);
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return resolved;
}
