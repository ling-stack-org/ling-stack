import { randomUUID } from "node:crypto";
import { UserInputStoreError, type RunStore, type UserInputContinuationClaim, type UserInputDelivery,
  type UserInputDispatchCandidate, type UserInputDeliveryDiscoveryCursor } from "@ling-stack/core";
import type { ActiveRunRegistry } from "../../runtime/active-runs.js";
import type { RuntimeSupervisor } from "../../runtime/supervisor.js";
import { failUserInputAnswerStartup } from "./user-input-answer-dispatch.js";

interface DiscoverySweep { readonly cutoff: string; readonly after?: UserInputDeliveryDiscoveryCursor }

export interface UserInputDeliveryScanResult {
  readonly scanned: number;
  readonly dispatched: number;
  readonly deferred: number;
}

/** Owns discovery and pre-admission retries. Existing physical bindings are never replay authority. */
export class UserInputDeliveryWorker {
  private readonly stores = new Set<RunStore>();
  private readonly sweeps = new WeakMap<RunStore, DiscoverySweep>();
  private readonly scans = new Map<RunStore, Promise<UserInputDeliveryScanResult>>();
  private readonly executions = new Map<RunStore, Set<Promise<string | undefined>>>();
  private readonly ownerId = "user-input-worker:" + randomUUID();
  private started = false;
  private closing = false;
  private timer?: ReturnType<typeof setInterval>;

  constructor(private readonly options: {
    readonly activeRuns: ActiveRunRegistry;
    readonly runtimeSupervisor: RuntimeSupervisor;
    readonly execute: (input: { readonly cwd: string; readonly claim: UserInputContinuationClaim;
      readonly onRunReady: (runId: string) => void }) => Promise<string | undefined>;
    readonly now?: () => string;
    readonly pageSize?: number;
    readonly intervalMs?: number;
    readonly maxInFlightPerStore?: number;
  }) {
    if (!Number.isSafeInteger(options.pageSize ?? 100) || (options.pageSize ?? 100) < 1 || (options.pageSize ?? 100) > 500
      || !Number.isSafeInteger(options.intervalMs ?? 5000) || (options.intervalMs ?? 5000) < 1
      || !Number.isSafeInteger(options.maxInFlightPerStore ?? 4) || (options.maxInFlightPerStore ?? 4) < 1
      || (options.maxInFlightPerStore ?? 4) > 32) throw new TypeError("Invalid answer worker limits.");
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
    this.timer = setInterval(() => { for (const store of this.stores) this.wake(store); }, this.options.intervalMs ?? 5000);
    this.timer.unref?.();
  }

  wake(store: RunStore): void {
    if (this.started && !this.isClosing()) void this.scanStore(store).catch(() => {
      console.warn("user_input_delivery_scan_failed: accepted answers remain durable");
    });
  }

  scanStore(store: RunStore): Promise<UserInputDeliveryScanResult> {
    const current = this.scans.get(store);
    if (current) return current;
    if (this.isClosing()) return Promise.resolve({ scanned: 0, dispatched: 0, deferred: 0 });
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

  async close(): Promise<void> {
    this.beginShutdown();
    while (this.scans.size) await Promise.allSettled([...this.scans.values()]);
    while (this.executions.size) await Promise.allSettled([...this.executions.values()].flatMap(executions => [...executions]));
    this.stores.clear();
  }

  private isClosing(): boolean { return this.closing || this.options.activeRuns.isShuttingDown(); }
  private now(): string { return this.options.now?.() ?? new Date().toISOString(); }

  private async scanPage(store: RunStore): Promise<UserInputDeliveryScanResult> {
    if (this.isClosing()) return { scanned: 0, dispatched: 0, deferred: 0 };
    this.options.runtimeSupervisor.getRuntime(store.paths.cwd, store);
    const sweep = this.sweeps.get(store) ?? { cutoff: this.now() }, limit = this.options.pageSize ?? 100;
    const page = store.listUserInputDispatchCandidates({ createdAtOrBefore: sweep.cutoff, after: sweep.after, limit }, this.now());
    let scanned = 0, dispatched = 0, deferred = 0;
    for (const delivery of page) {
      if (this.isClosing() || (this.executions.get(store)?.size ?? 0) >= (this.options.maxInFlightPerStore ?? 4)) break;
      scanned += 1;
      try {
        if (await this.dispatchOne(store, delivery)) dispatched += 1;
        else deferred += 1;
      } catch {
        deferred += 1;
        console.warn("user_input_delivery_candidate_rejected: answer retained for reconciliation");
      }
      this.sweeps.set(store, { cutoff: sweep.cutoff, after: { createdAt: delivery.createdAt, deliveryId: delivery.deliveryId } });
    }
    if (scanned === page.length && page.length < limit) this.sweeps.delete(store);
    return { scanned, dispatched, deferred };
  }

  private async dispatchOne(store: RunStore, candidate: UserInputDispatchCandidate): Promise<boolean> {
    const discovered = store.getUserInputDelivery(candidate.threadId, candidate.deliveryId);
    if (!discovered) return false;
    if (store.getUserInputContinuationBinding(discovered.threadId, discovered.deliveryId)) return false;
    let claimed: UserInputDelivery | null;
    try {
      claimed = store.claimUserInputDelivery({ threadId: discovered.threadId, deliveryId: discovered.deliveryId,
        expectedRevision: discovered.revision, ownerId: this.ownerId, leaseMs: 60_000 }, this.now());
    } catch (error) {
      if (error instanceof UserInputStoreError && ["delivery_conflict", "delivery_not_ready"].includes(error.code)) return false;
      throw error;
    }
    if (!claimed?.claim) return false;
    const claim: UserInputContinuationClaim = { threadId: claimed.threadId, deliveryId: claimed.deliveryId,
      expectedRevision: claimed.revision, ownerId: claimed.claim.ownerId, claimToken: claimed.claim.token };
    let ready!: (id: string) => void;
    const startup = new Promise<string>(resolve => { ready = resolve; });
    const executions = this.executions.get(store) ?? new Set<Promise<string | undefined>>();
    this.executions.set(store, executions);
    const execution = this.executeClaim(store, claimed, claim, runId => {
      if (store.getUserInputContinuationBinding(claim.threadId, claim.deliveryId)?.runId === runId) ready(runId);
    });
    executions.add(execution);
    void execution.catch(() => {
      console.warn("user_input_delivery_execution_failed: answer retained for reconciliation");
    }).finally(() => {
      executions.delete(execution);
      if (!executions.size) this.executions.delete(store);
      setImmediate(() => this.wake(store));
    });
    return (await Promise.race([startup, execution])) !== undefined;
  }

  private async executeClaim(store: RunStore, claimed: UserInputDelivery, claim: UserInputContinuationClaim,
    onRunReady: (runId: string) => void): Promise<string | undefined> {
    let id: string | undefined;
    try {
      if (!this.isClosing()) id = await this.options.execute({ cwd: store.paths.cwd, claim, onRunReady });
    } finally {
      const binding = store.getUserInputContinuationBinding(claimed.threadId, claimed.deliveryId);
      if (binding) {
        if (!id && !this.options.activeRuns.get(binding.runId)) failUserInputAnswerStartup(store, binding,
          "user_input_delivery_startup_failed", "Answer execution could not start; no automatic replay was attempted.", this.now());
      } else {
        const current = store.getUserInputDelivery(claimed.threadId, claimed.deliveryId), now = this.now();
        if (current?.status === "claimed" && current.revision === claim.expectedRevision && current.claim?.ownerId === claim.ownerId
          && current.claim.token === claim.claimToken && current.claim.expiresAt > now) {
          const delayMs = Math.min(300_000, 5000 * 2 ** Math.min(current.attemptCount - 1, 6));
          store.retryUserInputDelivery({ ...claim, errorCode: "receiver_unavailable",
            retryAt: new Date(Date.parse(now) + delayMs).toISOString() }, now);
        }
      }
    }
    return id;
  }
}
