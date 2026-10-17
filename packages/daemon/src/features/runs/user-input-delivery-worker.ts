import { randomUUID } from "node:crypto";
import type {
  RunStore,
  UserInputContinuationBinding,
  UserInputContinuationClaim,
  UserInputDelivery,
} from "@ling-stack/core";
import type { RunRequest } from "./schemas.js";
import {
  prepareUserInputContinuationRequest,
  readUserInputContinuationPreparedRequest,
} from "./user-input-prepared-request.js";

export interface UserInputDeliveryExecution {
  readonly store: RunStore;
  readonly threadId: string;
  readonly deliveryId: string;
  readonly request: RunRequest;
  readonly claim?: UserInputContinuationClaim;
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
  readonly ownerId?: string;
  readonly concurrency?: number;
  readonly scanIntervalMs?: number;
  readonly leaseMs?: number;
  readonly retryDelayMs?: number;
  readonly now?: () => string;
  /** Receives identifiers and stable codes only. Error messages can contain answer text and are never forwarded. */
  readonly onError?: (failure: UserInputDeliveryWorkerFailure) => void;
}

interface WorkerEntry {
  readonly store: RunStore;
  timer?: ReturnType<typeof setInterval>;
}

export interface UserInputDeliveryWorkerSnapshot {
  readonly accepting: boolean;
  readonly registeredWorkspaceCount: number;
  readonly pendingWorkspaceCount: number;
  readonly activeCount: number;
  readonly inFlightDeliveryCount: number;
}

type ProcessDisposition = "idle" | "processed" | "claim_lost" | "retained_binding";

/**
 * Durable answer outbox consumer. SQLite claims, bindings and receipts are the
 * authority; timers only wake the scanner and never carry delivery state.
 */
export class UserInputDeliveryWorkerRegistry {
  private readonly entries = new Map<string, WorkerEntry>();
  private readonly pending = new Set<string>();
  private readonly inFlight = new Set<Promise<void>>();
  private readonly activeDeliveryKeys = new Set<string>();
  private readonly concurrency: number;
  private readonly scanIntervalMs: number;
  private readonly leaseMs: number;
  private readonly retryDelayMs: number;
  private readonly ownerId: string;
  private accepting = true;
  private active = 0;

  constructor(private readonly options: UserInputDeliveryWorkerOptions) {
    this.concurrency = positiveInteger(options.concurrency, 1, "delivery worker concurrency");
    this.scanIntervalMs = positiveInteger(options.scanIntervalMs, 5_000, "delivery scan interval");
    this.leaseMs = positiveInteger(options.leaseMs, 60_000, "delivery lease");
    this.retryDelayMs = positiveInteger(options.retryDelayMs, 5_000, "delivery retry delay");
    this.ownerId = options.ownerId ?? `user_input_delivery_worker_${randomUUID()}`;
  }

  registerStore(store: RunStore): void {
    if (!this.accepting || this.entries.has(store.paths.cwd)) return;
    const entry: WorkerEntry = { store };
    entry.timer = setInterval(() => this.wake(store), this.scanIntervalMs);
    entry.timer.unref?.();
    this.entries.set(store.paths.cwd, entry);
    this.wake(store);
  }

  wake(store: RunStore): void {
    if (!this.accepting) return;
    if (!this.entries.has(store.paths.cwd)) this.registerStore(store);
    if (!this.entries.has(store.paths.cwd)) return;
    this.pending.add(store.paths.cwd);
    this.pump();
  }

  beginShutdown(): void {
    this.accepting = false;
    this.pending.clear();
    for (const entry of this.entries.values()) {
      if (entry.timer) clearInterval(entry.timer);
      entry.timer = undefined;
    }
  }

  async waitForIdle(): Promise<void> {
    // Completion callbacks can synchronously queue another page while an
    // earlier task settles, so observe until both queues are actually empty.
    while (this.active > 0 || this.inFlight.size > 0 || this.pending.size > 0) {
      if (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight]);
      else await Promise.resolve();
    }
  }

  snapshot(): UserInputDeliveryWorkerSnapshot {
    return {
      accepting: this.accepting,
      registeredWorkspaceCount: this.entries.size,
      pendingWorkspaceCount: this.pending.size,
      activeCount: this.active,
      inFlightDeliveryCount: this.activeDeliveryKeys.size,
    };
  }

  private pump(): void {
    while (this.accepting && this.active < this.concurrency && this.pending.size > 0) {
      const cwd = [...this.pending].sort()[0]!;
      this.pending.delete(cwd);
      const entry = this.entries.get(cwd);
      if (!entry) continue;
      this.active += 1;
      let task!: Promise<void>;
      task = this.drain(entry.store).catch(() => undefined).finally(() => {
        this.active -= 1;
        this.inFlight.delete(task);
        this.pump();
      });
      this.inFlight.add(task);
    }
  }

  private async drain(store: RunStore): Promise<void> {
    let after: { readonly createdAt: string; readonly deliveryId: string } | undefined;
    while (this.accepting) {
      const scannedAt = this.now();
      let page: readonly UserInputDelivery[];
      try {
        page = store.listDueUserInputDeliveries({ after, limit: 500 }, scannedAt);
      } catch {
        this.failure({ cwd: store.paths.cwd, phase: "scan", code: "delivery_invalid" });
        return;
      }
      if (page.length === 0) return;
      for (const delivery of page) {
        if (!this.accepting) return;
        const key = `${store.paths.cwd}\0${delivery.deliveryId}`;
        if (this.activeDeliveryKeys.has(key)) continue;
        this.activeDeliveryKeys.add(key);
        try {
          await this.process(store, delivery);
        } finally {
          this.activeDeliveryKeys.delete(key);
        }
      }
      const last = page.at(-1)!;
      after = { createdAt: last.createdAt, deliveryId: last.deliveryId };
      if (page.length < 500) return;
    }
  }

  private async process(store: RunStore, candidate: UserInputDelivery): Promise<ProcessDisposition> {
    const receipt = store.getUserInputContinuationReceipt(candidate.threadId, candidate.deliveryId);
    if (receipt) return "processed";
    let binding: UserInputContinuationBinding | undefined;
    try {
      binding = store.getUserInputContinuationBinding(candidate.threadId, candidate.deliveryId);
    } catch {
      this.failure({ cwd: store.paths.cwd, deliveryId: candidate.deliveryId, phase: "scan", code: "delivery_invalid" });
      return "claim_lost";
    }
    if (binding) {
      return this.executeBinding(store, candidate, binding);
    }

    const claimAt = this.now();
    let claimed: UserInputDelivery | null;
    try {
      claimed = store.claimUserInputDelivery({
        threadId: candidate.threadId,
        deliveryId: candidate.deliveryId,
        expectedRevision: candidate.revision,
        ownerId: this.ownerId,
        leaseMs: this.leaseMs,
      }, claimAt);
    } catch {
      this.failure({ cwd: store.paths.cwd, deliveryId: candidate.deliveryId, phase: "claim", code: "claim_lost" });
      return "claim_lost";
    }
    if (!claimed) return "processed";
    const claim = continuationClaim(claimed);
    let prepared: ReturnType<typeof prepareUserInputContinuationRequest>;
    try {
      prepared = prepareUserInputContinuationRequest(store, claim, claimAt);
    } catch {
      this.failure({ cwd: store.paths.cwd, deliveryId: candidate.deliveryId, phase: "prepare", code: "delivery_invalid" });
      return "claim_lost";
    }
    try {
      await this.options.execute({ store, threadId: candidate.threadId, deliveryId: candidate.deliveryId,
        request: prepared.request, claim });
      if (store.getUserInputContinuationReceipt(candidate.threadId, candidate.deliveryId)) return "processed";
      if (store.getUserInputContinuationBinding(candidate.threadId, candidate.deliveryId)) return "retained_binding";
      // Detached orchestration reports many pre-admission failures through its
      // sink and resolves undefined. Durable state, not Promise rejection, is
      // the completion receipt. Without binding or ACK this attempt must retry.
      this.failure({ cwd: store.paths.cwd, deliveryId: candidate.deliveryId, phase: "execute", code: "receiver_unavailable" });
      return this.retry(store, claim, candidate.deliveryId);
    } catch {
      if (store.getUserInputContinuationReceipt(candidate.threadId, candidate.deliveryId)) return "processed";
      if (store.getUserInputContinuationBinding(candidate.threadId, candidate.deliveryId)) {
        this.failure({ cwd: store.paths.cwd, deliveryId: candidate.deliveryId, phase: "execute", code: "receiver_unavailable" });
        return "retained_binding";
      }
      this.failure({ cwd: store.paths.cwd, deliveryId: candidate.deliveryId, phase: "execute", code: "receiver_unavailable" });
      return this.retry(store, claim, candidate.deliveryId);
    }
  }

  private async executeBinding(store: RunStore, delivery: UserInputDelivery,
    binding: UserInputContinuationBinding): Promise<ProcessDisposition> {
    let prepared: ReturnType<typeof readUserInputContinuationPreparedRequest>;
    try {
      prepared = readUserInputContinuationPreparedRequest(store, delivery.threadId, delivery.deliveryId);
    } catch {
      this.failure({ cwd: store.paths.cwd, deliveryId: delivery.deliveryId, phase: "prepare", code: "delivery_invalid" });
      return "retained_binding";
    }
    if (!prepared) {
      this.failure({ cwd: store.paths.cwd, deliveryId: delivery.deliveryId, phase: "prepare", code: "delivery_invalid" });
      return "retained_binding";
    }
    try {
      await this.options.execute({ store, threadId: delivery.threadId, deliveryId: delivery.deliveryId,
        request: prepared.request, binding });
      return store.getUserInputContinuationReceipt(delivery.threadId, delivery.deliveryId) ? "processed" : "retained_binding";
    } catch {
      // Binding is immutable and owns a single successor. Never convert this
      // path back to a fresh delivery retry or allocate another Run/Attempt.
      this.failure({ cwd: store.paths.cwd, deliveryId: delivery.deliveryId, phase: "execute", code: "receiver_unavailable" });
      return "retained_binding";
    }
  }

  private retry(store: RunStore, claim: UserInputContinuationClaim, deliveryId: string): ProcessDisposition {
    const settledAt = this.now();
    try {
      store.retryUserInputDelivery({
        ...claim,
        retryAt: new Date(Date.parse(settledAt) + this.retryDelayMs).toISOString(),
        errorCode: "receiver_unavailable",
      }, settledAt);
      return "processed";
    } catch {
      this.failure({ cwd: store.paths.cwd, deliveryId, phase: "retry", code: "retry_lost" });
      return "claim_lost";
    }
  }

  private failure(failure: UserInputDeliveryWorkerFailure): void {
    try { this.options.onError?.(failure); } catch { /* observers never own scheduling */ }
  }

  private now(): string {
    return this.options.now?.() ?? new Date().toISOString();
  }
}

function continuationClaim(delivery: UserInputDelivery): UserInputContinuationClaim {
  if (delivery.status !== "claimed" || !delivery.claim) throw new Error("Claimed delivery has no lease identity.");
  return {
    threadId: delivery.threadId,
    deliveryId: delivery.deliveryId,
    expectedRevision: delivery.revision,
    ownerId: delivery.claim.ownerId,
    claimToken: delivery.claim.token,
  };
}

function positiveInteger(value: number | undefined, fallback: number, field: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) throw new Error(`${field} must be a positive integer.`);
  return resolved;
}
