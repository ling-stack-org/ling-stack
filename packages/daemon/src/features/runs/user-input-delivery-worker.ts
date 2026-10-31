import { randomUUID } from "node:crypto";
import {
  UserInputStoreError,
  type RunStore,
  type UserInputContinuationBinding,
  type UserInputContinuationClaim,
  type UserInputDelivery,
  type UserInputDeliveryDiscoveryCursor,
  type UserInputDispatchCandidate,
} from "@ling-stack/core";
import type { ActiveRunRegistry } from "../../runtime/active-runs.js";
import type { RuntimeSupervisor } from "../../runtime/supervisor.js";
import type { RunRequest } from "./schemas.js";
import {
  prepareUserInputContinuationRequest,
  readUserInputContinuationPreparedRequest,
} from "./user-input-prepared-request.js";

interface DiscoverySweep {
  readonly cutoff: string;
  readonly after?: UserInputDeliveryDiscoveryCursor;
}

export interface UserInputDeliveryExecution {
  readonly store: RunStore;
  readonly threadId: string;
  readonly deliveryId: string;
  readonly request: RunRequest;
  readonly claim: UserInputContinuationClaim;
  readonly binding?: UserInputContinuationBinding;
}

export type ExecuteUserInputDelivery = (input: UserInputDeliveryExecution) => Promise<string | undefined>;

export interface UserInputDeliveryWorkerFailure {
  readonly cwd: string;
  readonly deliveryId?: string;
  readonly phase: "scan" | "claim" | "prepare" | "execute" | "retry";
  readonly code: "claim_lost" | "delivery_invalid" | "receiver_unavailable" | "retry_lost";
}

export interface UserInputDeliveryWorkerOptions {
  readonly execute: ExecuteUserInputDelivery;
  readonly activeRuns?: Pick<ActiveRunRegistry, "isShuttingDown">;
  readonly runtimeSupervisor?: RuntimeSupervisor;
  readonly ownerId?: string;
  readonly pageSize?: number;
  readonly maxInFlightPerStore?: number;
  readonly scanIntervalMs?: number;
  readonly leaseMs?: number;
  readonly retryDelayMs?: number;
  readonly now?: () => string;
  /** Receives identifiers and stable codes only. Error messages can contain answer text and are never forwarded. */
  readonly onError?: (failure: UserInputDeliveryWorkerFailure) => void;
}

export interface UserInputDeliveryScanResult {
  readonly scanned: number;
  readonly dispatched: number;
  readonly deferred: number;
}

export interface UserInputDeliveryWorkerSnapshot {
  readonly accepting: boolean;
  readonly started: boolean;
  readonly registeredWorkspaceCount: number;
  readonly activeScanCount: number;
  readonly inFlightDeliveryCount: number;
}

type ProcessDisposition = "processed" | "deferred" | "claim_lost";

interface ClaimLeaseExecution<T> {
  readonly ok: boolean;
  readonly lost: boolean;
  readonly value?: T;
  readonly error?: unknown;
}

function emptyScan(): UserInputDeliveryScanResult {
  return { scanned: 0, dispatched: 0, deferred: 0 };
}

/**
 * Durable answer outbox consumer. SQLite claims, prepared requests, immutable
 * bindings and receiver receipts are authoritative. The process-local timer
 * only wakes bounded discovery sweeps.
 */
export class UserInputDeliveryWorker {
  private readonly stores = new Set<RunStore>();
  private readonly sweeps = new WeakMap<RunStore, DiscoverySweep>();
  private readonly scans = new Map<RunStore, Promise<UserInputDeliveryScanResult>>();
  private readonly executions = new Map<RunStore, Set<Promise<ProcessDisposition>>>();
  private readonly activeDeliveryKeys = new Set<string>();
  private readonly ownerId: string;
  private readonly pageSize: number;
  private readonly maxInFlightPerStore: number;
  private readonly scanIntervalMs: number;
  private readonly leaseMs: number;
  private readonly retryDelayMs: number;
  private started = false;
  private closing = false;
  private timer?: ReturnType<typeof setInterval>;

  constructor(private readonly options: UserInputDeliveryWorkerOptions) {
    this.ownerId = options.ownerId ?? `user_input_delivery_worker_${randomUUID()}`;
    this.pageSize = boundedInteger(options.pageSize, 100, 1, 500, "delivery page size");
    this.maxInFlightPerStore = boundedInteger(
      options.maxInFlightPerStore,
      1,
      1,
      32,
      "delivery per-store concurrency",
    );
    this.scanIntervalMs = positiveInteger(options.scanIntervalMs, 5_000, "delivery scan interval");
    this.leaseMs = boundedInteger(options.leaseMs, 60_000, 1, 60_000, "delivery lease");
    this.retryDelayMs = boundedInteger(options.retryDelayMs, 5_000, 1, 300_000, "delivery retry delay");
  }

  registerStore(store: RunStore): void {
    if (this.closing) return;
    this.stores.add(store);
    if (this.started) this.wake(store);
  }

  start(): void {
    if (this.closing || this.started) return;
    this.started = true;
    for (const store of this.stores) this.wake(store);
    this.timer = setInterval(() => {
      for (const store of this.stores) this.wake(store);
    }, this.scanIntervalMs);
    this.timer.unref?.();
  }

  wake(store: RunStore): void {
    if (this.closing) return;
    if (!this.stores.has(store)) this.registerStore(store);
    if (!this.started || this.isClosing()) return;
    void this.scanStore(store).catch(() => {
      this.failure({ cwd: store.paths.cwd, phase: "scan", code: "delivery_invalid" });
    });
  }

  scanStore(store: RunStore): Promise<UserInputDeliveryScanResult> {
    const current = this.scans.get(store);
    if (current) return current;
    if (this.isClosing()) return Promise.resolve(emptyScan());
    const scan = Promise.resolve().then(() => this.scanPage(store)).finally(() => {
      if (this.scans.get(store) === scan) this.scans.delete(store);
    });
    this.scans.set(store, scan);
    return scan;
  }

  beginShutdown(): void {
    this.closing = true;
    this.started = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async waitForIdle(): Promise<void> {
    while (this.scans.size > 0 || this.executions.size > 0) {
      const pending = [
        ...this.scans.values(),
        ...[...this.executions.values()].flatMap((executions) => [...executions]),
      ];
      if (pending.length === 0) break;
      await Promise.allSettled(pending);
    }
  }

  async close(): Promise<void> {
    this.beginShutdown();
    await this.waitForIdle();
    this.stores.clear();
  }

  snapshot(): UserInputDeliveryWorkerSnapshot {
    return {
      accepting: !this.closing,
      started: this.started,
      registeredWorkspaceCount: this.stores.size,
      activeScanCount: this.scans.size,
      inFlightDeliveryCount: this.activeDeliveryKeys.size,
    };
  }

  private isClosing(): boolean {
    return this.closing || this.options.activeRuns?.isShuttingDown() === true;
  }

  private now(): string {
    return this.options.now?.() ?? new Date().toISOString();
  }

  private async scanPage(store: RunStore): Promise<UserInputDeliveryScanResult> {
    if (this.isClosing()) return emptyScan();
    this.options.runtimeSupervisor?.getRuntime(store.paths.cwd, store);
    const sweep = this.sweeps.get(store) ?? { cutoff: this.now() };
    const capacity = this.maxInFlightPerStore - (this.executions.get(store)?.size ?? 0);
    if (capacity <= 0) return emptyScan();

    let page: readonly UserInputDispatchCandidate[];
    try {
      page = store.listUserInputDispatchCandidates(
        { createdAtOrBefore: sweep.cutoff, after: sweep.after, limit: this.pageSize },
        this.now(),
      );
    } catch {
      this.failure({ cwd: store.paths.cwd, phase: "scan", code: "delivery_invalid" });
      return emptyScan();
    }

    if (page.length === 0) {
      this.sweeps.delete(store);
      return emptyScan();
    }

    const scheduled: Promise<ProcessDisposition>[] = [];
    let scanned = 0;
    let deferred = 0;
    let after = sweep.after;

    for (const delivery of page) {
      if (this.isClosing() || scheduled.length >= capacity) break;
      scanned += 1;
      after = { createdAt: delivery.createdAt, deliveryId: delivery.deliveryId };
      const key = deliveryKey(store, delivery.deliveryId);
      if (this.activeDeliveryKeys.has(key)) {
        deferred += 1;
        continue;
      }
      scheduled.push(this.trackExecution(store, delivery, key));
    }

    if (after) this.sweeps.set(store, { cutoff: sweep.cutoff, after });
    const results = await Promise.all(scheduled);
    const dispatched = results.filter((result) => result === "processed").length;
    deferred += results.length - dispatched;

    const exhaustedPage = scanned === page.length && page.length < this.pageSize;
    if (exhaustedPage) this.sweeps.delete(store);

    if (!this.isClosing() && !exhaustedPage) {
      setImmediate(() => this.wake(store));
    }
    return { scanned, dispatched, deferred };
  }

  private trackExecution(
    store: RunStore,
    delivery: UserInputDispatchCandidate,
    key: string,
  ): Promise<ProcessDisposition> {
    this.activeDeliveryKeys.add(key);
    const executions = this.executions.get(store) ?? new Set<Promise<ProcessDisposition>>();
    this.executions.set(store, executions);
    let execution!: Promise<ProcessDisposition>;
    execution = this.process(store, delivery).catch(() => {
      this.failure({
        cwd: store.paths.cwd,
        deliveryId: delivery.deliveryId,
        phase: "scan",
        code: "delivery_invalid",
      });
      return "claim_lost" as const;
    }).finally(() => {
      this.activeDeliveryKeys.delete(key);
      executions.delete(execution);
      if (executions.size === 0) this.executions.delete(store);
      if (!this.isClosing()) setImmediate(() => this.wake(store));
    });
    executions.add(execution);
    return execution;
  }

  private async process(store: RunStore, candidate: UserInputDispatchCandidate): Promise<ProcessDisposition> {
    if (store.getUserInputContinuationReceipt(candidate.threadId, candidate.deliveryId)) return "processed";

    let binding: UserInputContinuationBinding | undefined;
    try {
      binding = store.getUserInputContinuationBinding(candidate.threadId, candidate.deliveryId);
    } catch {
      this.failure({
        cwd: store.paths.cwd,
        deliveryId: candidate.deliveryId,
        phase: "scan",
        code: "delivery_invalid",
      });
      return "claim_lost";
    }
    if (binding) return this.executeBinding(store, candidate, binding);

    const current = store.getUserInputDelivery(candidate.threadId, candidate.deliveryId);
    if (!current) return "claim_lost";
    const claimAt = this.now();
    let claimed: UserInputDelivery | null;
    try {
      claimed = store.claimUserInputDelivery({
        threadId: current.threadId,
        deliveryId: current.deliveryId,
        expectedRevision: current.revision,
        ownerId: this.ownerId,
        leaseMs: this.leaseMs,
      }, claimAt);
    } catch (error) {
      if (error instanceof UserInputStoreError
        && (error.code === "delivery_conflict" || error.code === "delivery_not_ready")) {
        return "claim_lost";
      }
      this.failure({
        cwd: store.paths.cwd,
        deliveryId: candidate.deliveryId,
        phase: "claim",
        code: "claim_lost",
      });
      return "claim_lost";
    }
    if (!claimed) return "processed";

    const claim = continuationClaim(claimed);
    let phase: "prepare" | "execute" = "prepare";
    const execution = await this.withClaimLease(store, claim, async () => {
      const prepared = prepareUserInputContinuationRequest(store, claim, claimAt);
      phase = "execute";
      return this.options.execute({
        store,
        threadId: candidate.threadId,
        deliveryId: candidate.deliveryId,
        request: prepared.request,
        claim,
      });
    });
    if (store.getUserInputContinuationReceipt(candidate.threadId, candidate.deliveryId)) return "processed";
    if (execution.lost) {
      this.failure({ cwd: store.paths.cwd, deliveryId: candidate.deliveryId, phase: "claim", code: "claim_lost" });
      return "claim_lost";
    }
    if (!execution.ok && phase === "prepare") {
      this.failure({
        cwd: store.paths.cwd,
        deliveryId: candidate.deliveryId,
        phase: "prepare",
        code: "delivery_invalid",
      });
      return "claim_lost";
    }
    binding = store.getUserInputContinuationBinding(candidate.threadId, candidate.deliveryId);
    if (binding) {
      this.failure({
        cwd: store.paths.cwd,
        deliveryId: candidate.deliveryId,
        phase: "execute",
        code: "receiver_unavailable",
      });
      // Admission advances the delivery revision without rotating this lease.
      // Core still checks the exact current binding, owner and token atomically;
      // a replaced worker cannot use this revision to defer another owner's work.
      return this.deferBinding(store, { ...claim, expectedRevision: binding.deliveryRevision }, binding, claimed.attemptCount);
    }
    this.failure({
      cwd: store.paths.cwd,
      deliveryId: candidate.deliveryId,
      phase: "execute",
      code: "receiver_unavailable",
    });
    return this.retry(store, claim, claimed);
  }

  private async executeBinding(
    store: RunStore,
    delivery: UserInputDispatchCandidate,
    binding: UserInputContinuationBinding,
  ): Promise<ProcessDisposition> {
    const claimAt = this.now();
    const claimed = store.claimUserInputContinuationRecovery({
      threadId: delivery.threadId,
      deliveryId: delivery.deliveryId,
      bindingRef: { id: binding.id, fingerprint: binding.fingerprint },
      sourceFence: binding.fence,
      ownerId: this.ownerId,
      leaseMs: this.leaseMs,
    }, claimAt);
    if (claimed.status !== "claimed") return claimed.status === "busy" ? "deferred" : "claim_lost";
    const claim = claimed.claim;
    let prepared: ReturnType<typeof readUserInputContinuationPreparedRequest>;
    try {
      prepared = readUserInputContinuationPreparedRequest(store, delivery.threadId, delivery.deliveryId);
    } catch {
      this.failure({
        cwd: store.paths.cwd,
        deliveryId: delivery.deliveryId,
        phase: "prepare",
        code: "delivery_invalid",
      });
      return this.deferBinding(store, claim, binding, 1);
    }
    if (!prepared) {
      this.failure({
        cwd: store.paths.cwd,
        deliveryId: delivery.deliveryId,
        phase: "prepare",
        code: "delivery_invalid",
      });
      return this.deferBinding(store, claim, binding, 1);
    }
    const execution = await this.withClaimLease(store, claim, () => this.options.execute({
        store,
        threadId: delivery.threadId,
        deliveryId: delivery.deliveryId,
        request: prepared.request,
        claim,
        binding,
      }));
    if (store.getUserInputContinuationReceipt(delivery.threadId, delivery.deliveryId)) return "processed";
    if (execution.lost) {
      this.failure({ cwd: store.paths.cwd, deliveryId: delivery.deliveryId, phase: "claim", code: "claim_lost" });
      return "claim_lost";
    }
    // A binding owns exactly one successor. Release only this recovery claim
    // and retry the same frozen Run/Attempt; never allocate another successor.
    this.failure({
      cwd: store.paths.cwd,
      deliveryId: delivery.deliveryId,
      phase: "execute",
      code: "receiver_unavailable",
    });
    return this.deferBinding(store, claim, binding, 1);
  }

  private async withClaimLease<T>(
    store: RunStore,
    claim: UserInputContinuationClaim,
    operation: () => Promise<T>,
  ): Promise<ClaimLeaseExecution<T>> {
    let lost = false;
    const timer = setInterval(() => {
      if (lost) return;
      try {
        const renewed = store.renewUserInputContinuationLease({
          threadId: claim.threadId,
          deliveryId: claim.deliveryId,
          ownerId: claim.ownerId,
          claimToken: claim.claimToken,
          leaseMs: this.leaseMs,
        }, this.now());
        if (renewed.status === "lost") lost = true;
      } catch {
        lost = true;
      }
    }, Math.max(1, Math.floor(this.leaseMs / 3)));
    timer.unref?.();
    try {
      const value = await operation();
      return { ok: true, lost, value };
    } catch (error) {
      return { ok: false, lost, error };
    } finally {
      clearInterval(timer);
    }
  }

  private deferBinding(
    store: RunStore,
    claim: UserInputContinuationClaim,
    binding: UserInputContinuationBinding,
    attemptCount: number,
  ): ProcessDisposition {
    const settledAt = this.now();
    const retryAt = new Date(Date.parse(settledAt) + this.retryDelay(attemptCount)).toISOString();
    const deferred = store.deferUserInputContinuationRecovery({
      ...claim,
      bindingRef: { id: binding.id, fingerprint: binding.fingerprint },
      sourceFence: binding.fence,
      retryAt,
      errorCode: "recoverable_failure",
    }, settledAt);
    if (deferred) return "deferred";
    this.failure({ cwd: store.paths.cwd, deliveryId: binding.deliveryId, phase: "retry", code: "retry_lost" });
    return "claim_lost";
  }

  private retry(
    store: RunStore,
    claim: UserInputContinuationClaim,
    delivery: UserInputDelivery,
  ): ProcessDisposition {
    const settledAt = this.now();
    const delayMs = this.retryDelay(delivery.attemptCount);
    try {
      store.retryUserInputDelivery({
        ...claim,
        retryAt: new Date(Date.parse(settledAt) + delayMs).toISOString(),
        errorCode: "receiver_unavailable",
      }, settledAt);
      return "deferred";
    } catch {
      this.failure({
        cwd: store.paths.cwd,
        deliveryId: delivery.deliveryId,
        phase: "retry",
        code: "retry_lost",
      });
      return "claim_lost";
    }
  }

  private retryDelay(attemptCount: number): number {
    const multiplier = 2 ** Math.min(Math.max(attemptCount - 1, 0), 6);
    return Math.min(300_000, this.retryDelayMs * multiplier);
  }

  private failure(failure: UserInputDeliveryWorkerFailure): void {
    try {
      this.options.onError?.(failure);
    } catch {
      // Observers never own scheduling or durable delivery state.
    }
  }
}

/** Transitional source alias; composition must instantiate exactly one worker. */
export { UserInputDeliveryWorker as UserInputDeliveryWorkerRegistry };

function continuationClaim(delivery: UserInputDelivery): UserInputContinuationClaim {
  if (delivery.status !== "claimed" || !delivery.claim) {
    throw new Error("Claimed delivery has no lease identity.");
  }
  return {
    threadId: delivery.threadId,
    deliveryId: delivery.deliveryId,
    expectedRevision: delivery.revision,
    ownerId: delivery.claim.ownerId,
    claimToken: delivery.claim.token,
  };
}

function deliveryKey(store: RunStore, deliveryId: string): string {
  return `${store.paths.cwd}\0${deliveryId}`;
}

function positiveInteger(value: number | undefined, fallback: number, field: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new TypeError(`${field} must be a positive integer.`);
  }
  return resolved;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  field: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new TypeError(`${field} must be an integer from ${minimum} to ${maximum}.`);
  }
  return resolved;
}
