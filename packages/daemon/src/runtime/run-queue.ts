import { randomUUID } from "node:crypto";
import { type HostOperationSource, type RunStore,
  type RuntimeRunQueueClaim } from "@ling-stack/core";
import { RuntimeHostCapacityBridge, type HostRunCapacityStore,
  type RuntimeHostCapacityDispatchReference, type RuntimeHostCapacityJournal,
  type RuntimeHostCapacityApprovalResumePendingInput,
  type RuntimeHostCapacityUserInputPendingInput } from "@ling-stack/core/runtime-host-capacity-store-bridge";
import type { ExecuteRunRequestOptions } from "../features/runs/orchestrator.js";
import type { ActiveRunRegistry } from "./active-runs.js";
import type { RuntimeSupervisor } from "./supervisor.js";

interface StoreQueueSignals {
  wake(): void;
  hostCapacityReleased(): void;
  retain(runId: string, options: ExecuteRunRequestOptions): void;
}
export interface RuntimeHostCapacityAdmission {
  readonly getWorkspaceKey: (workspaceId: string) => string;
  readonly observeReservation?: (input: { readonly workspaceId: string; readonly intentId: string; readonly now: string }) =>
    ReturnType<RuntimeHostCapacityBridge["observeReservation"]>;
  reserveExecution(input: { readonly workspaceId: string; readonly source: HostOperationSource; readonly now: string }):
    | { readonly status: "reserved" | "duplicate"; readonly reference: RuntimeHostCapacityDispatchReference }
    | { readonly status: "full" | "unconfigured" | "changed" };
  reserveApprovalResumePending(input: RuntimeHostCapacityApprovalResumePendingInput & { readonly workspaceId: string }):
    | { readonly status: "reserved" | "duplicate"; readonly reference: RuntimeHostCapacityDispatchReference }
    | { readonly status: "full" | "unconfigured" | "changed" };
  reserveUserInputContinuation(input: RuntimeHostCapacityUserInputPendingInput & { readonly workspaceId: string }):
    | { readonly status: "reserved" | "duplicate"; readonly reference: RuntimeHostCapacityDispatchReference }
    | { readonly status: "full" | "unconfigured" | "changed" };
  getAttemptReference(input: { readonly workspaceId: string; readonly source: HostOperationSource }):
    { readonly reference: RuntimeHostCapacityDispatchReference; readonly dispatched: boolean } | undefined;
  consumeDispatch(input: { readonly workspaceId: string; readonly source: HostOperationSource;
    readonly reference: RuntimeHostCapacityDispatchReference; readonly now: string }): boolean;
  reserve(input: { readonly workspaceId: string; readonly source: HostOperationSource; readonly now: string }):
    | { readonly status: "reserved" | "duplicate"; readonly reference: RuntimeHostCapacityDispatchReference }
    | { readonly status: "full" | "unconfigured" | "changed" };
  reserveWorkflowStart(input: { readonly workspaceId: string; readonly source: HostOperationSource; readonly now: string }):
    | { readonly status: "reserved" | "duplicate"; readonly reference: RuntimeHostCapacityDispatchReference }
    | { readonly status: "full" | "unconfigured" | "changed" };
  reserveDelegationSpawn(input: { readonly workspaceId: string; readonly source: HostOperationSource; readonly now: string }):
    | { readonly status: "reserved" | "duplicate"; readonly reference: RuntimeHostCapacityDispatchReference }
    | { readonly status: "full" | "unconfigured" | "changed" };
  reserveDelegationPending(input: { readonly workspaceId: string; readonly admissionId: string; readonly now: string }):
    | { readonly status: "reserved" | "duplicate"; readonly reference: RuntimeHostCapacityDispatchReference }
    | { readonly status: "full" | "unconfigured" | "changed" };
  releaseNoDispatch(input: { readonly workspaceId: string; readonly intentId: string; readonly now: string }): boolean;
  releaseStopped(input: { readonly workspaceId: string; readonly source: HostOperationSource;
    readonly intentId: string; readonly now: string }): boolean;
}

export function createRuntimeHostCapacityAdmission(input: {
  readonly host: HostRunCapacityStore;
  readonly workspace: (workspaceId: string) => RuntimeHostCapacityJournal;
  readonly onReleased?: () => void;
}): RuntimeHostCapacityAdmission {
  const bridgeFor = (workspaceId: string): RuntimeHostCapacityBridge =>
    new RuntimeHostCapacityBridge(input.workspace(workspaceId), input.host);
  const reservedReference = (result: ReturnType<RuntimeHostCapacityBridge["reserveAttempt"]>) => {
    if (result.status === "reserved" || result.status === "duplicate") {
      const dispatchToken = result.record.dispatchToken;
      if (!result.record.reservation || !dispatchToken) return { status: "changed" } as const;
      return { status: result.status, reference: { intentId: result.record.intent.intentId, dispatchToken } };
    }
    return { status: result.status === "retained" ? "changed" as const : result.status };
  };
  return {
    getWorkspaceKey(workspaceId) {
      return input.workspace(workspaceId).getWorkspaceKey();
    },
    observeReservation({ workspaceId, intentId, now }) {
      return new RuntimeHostCapacityBridge(input.workspace(workspaceId), input.host).observeReservation(intentId, now);
    },
    reserveExecution({ workspaceId, source, now }) {
      return reservedReference(bridgeFor(workspaceId).reserveExecution({ source, now }));
    },
    reserveApprovalResumePending({ workspaceId, ...pending }) {
      return reservedReference(bridgeFor(workspaceId).reserveApprovalResumePending(pending));
    },
    reserveUserInputContinuation({ workspaceId, ...pending }) {
      return reservedReference(bridgeFor(workspaceId).reserveUserInputContinuation(pending));
    },
    getAttemptReference({ workspaceId, source }) {
      const record = input.workspace(workspaceId).getAttemptIntent(source);
      if (!record?.reservation || !record.dispatchToken || record.revokedAt || input.workspace(workspaceId).getRelease(record.intent.intentId)) return undefined;
      return { reference: { intentId: record.intent.intentId, dispatchToken: record.dispatchToken }, dispatched: !!record.dispatchedAt };
    },
    consumeDispatch({ workspaceId, source, reference, now }) {
      return input.workspace(workspaceId).consumeDispatchGate({ intentId: reference.intentId, token: reference.dispatchToken, source, now });
    },
    reserve({ workspaceId, source, now }) {
      const result = bridgeFor(workspaceId).reserveAttempt({ source, now });
      if (result.status === "reserved" || result.status === "duplicate") {
        const dispatchToken = result.record.dispatchToken;
        if (!result.record.reservation || !dispatchToken) return { status: "changed" } as const;
        return { status: result.status as "reserved" | "duplicate", reference: { intentId: result.record.intent.intentId, dispatchToken } };
      }
      return { status: result.status === "retained" ? "changed" : result.status };
    },
    reserveWorkflowStart({ workspaceId, source, now }) {
      const result = bridgeFor(workspaceId).reserveWorkflowStart({ source, now });
      if (result.status === "reserved" || result.status === "duplicate") {
        const dispatchToken = result.record.dispatchToken;
        if (!result.record.reservation || !dispatchToken) return { status: "changed" } as const;
        return { status: result.status as "reserved" | "duplicate", reference: { intentId: result.record.intent.intentId, dispatchToken } };
      }
      return { status: result.status === "retained" ? "changed" : result.status };
    },
    reserveDelegationSpawn({ workspaceId, source, now }) {
      const result = bridgeFor(workspaceId).reserveDelegationSpawn({ source, now });
      if (result.status === "reserved" || result.status === "duplicate") {
        const dispatchToken = result.record.dispatchToken;
        if (!result.record.reservation || !dispatchToken) return { status: "changed" } as const;
        return { status: result.status as "reserved" | "duplicate", reference: { intentId: result.record.intent.intentId, dispatchToken } };
      }
      return { status: result.status === "retained" ? "changed" : result.status };
    },
    reserveDelegationPending({ workspaceId, admissionId, now }) {
      const result = bridgeFor(workspaceId).reserveDelegationPending({ admissionId, now });
      if (result.status === "reserved" || result.status === "duplicate") {
        const dispatchToken = result.record.dispatchToken;
        if (!result.record.reservation || !dispatchToken) return { status: "changed" } as const;
        return { status: result.status as "reserved" | "duplicate", reference: { intentId: result.record.intent.intentId, dispatchToken } };
      }
      return { status: result.status === "retained" ? "changed" : result.status };
    },
    releaseNoDispatch({ workspaceId, intentId, now }) {
      const journal = input.workspace(workspaceId), prepared = journal.prepareNoDispatchRelease({ intentId, now });
      if (prepared.status === "changed") return false;
      const released = bridgeFor(workspaceId).flushRelease(intentId, now);
      if (released) input.onReleased?.();
      return released;
    },
    releaseStopped({ workspaceId, source, intentId, now }) {
      const journal = input.workspace(workspaceId), record = journal.getIntent(intentId);
      if (!record?.source || record.source.runId !== source.runId || record.source.attemptId !== source.attemptId) return false;
      const prepared = journal.prepareStoppedRelease({ intentId, now });
      if (prepared.status === "changed") return false;
      const released = bridgeFor(workspaceId).flushRelease(intentId, now);
      if (released) input.onReleased?.();
      return released;
    },
  };
}
const signals = new WeakMap<RunStore, StoreQueueSignals>();
const MINIMUM_QUEUE_PREPARATIONS = 4;
const MAX_QUEUE_SCAN_ATTEMPTS = 16;

export function notifyRuntimeRunQueued(store: RunStore, runId: string, options: ExecuteRunRequestOptions): void {
  signals.get(store)?.retain(runId, options);
  signals.get(store)?.wake();
}

export function notifyRuntimeRunResourcesReleased(store: RunStore): void {
  signals.get(store)?.wake();
}

export function notifyRuntimeRunHostCapacityReleased(store: RunStore): void {
  signals.get(store)?.hostCapacityReleased();
}

/** Durable claims arbitrate across processes; this coordinator only discovers and starts preparations. */
export class RuntimeRunQueueCoordinator {
  private readonly stores = new Set<RunStore>();
  private readonly preparing = new WeakMap<RunStore, Set<symbol>>();
  private readonly retainedOptions = new WeakMap<RunStore, Map<string, ExecuteRunRequestOptions>>();
  private readonly workspaceScanCursors = new WeakMap<RunStore, string>();
  private readonly scanning = new WeakSet<RunStore>();
  private readonly pendingWake = new WeakSet<RunStore>();
  private readonly pendingResourceWake = new WeakSet<RunStore>();
  private readonly inFlight = new Set<Promise<unknown>>();
  private readonly ownerId = `run-queue:${randomUUID()}`;
  private started = false;
  private closed = false;
  private timer?: ReturnType<typeof setInterval>;

  constructor(private readonly options: {
    readonly runtimeSupervisor: RuntimeSupervisor;
    readonly activeRuns: ActiveRunRegistry;
    readonly execute: (input: { readonly store: RunStore; readonly claim: RuntimeRunQueueClaim;
      readonly executionOptions?: ExecuteRunRequestOptions }) => Promise<unknown>;
    readonly hostCapacity?: RuntimeHostCapacityAdmission;
    readonly intervalMs?: number;
  }) {}

  registerStore(store: RunStore): void {
    if (this.closed || this.stores.has(store)) return;
    this.stores.add(store);
    const retained = new Map<string, ExecuteRunRequestOptions>();
    this.retainedOptions.set(store, retained);
    this.preparing.set(store, new Set());
    signals.set(store, { wake: () => this.wakeStore(store), hostCapacityReleased: () => this.wakeAllStores(true), retain: (runId, options) => {
      retained.set(runId, { ...options, onRunReady: undefined });
    } });
    this.wakeStore(store);
  }

  start(): void {
    if (this.closed || this.started) return;
    this.started = true;
    for (const store of this.stores) this.wakeStore(store);
    this.timer = setInterval(() => {
      for (const store of this.stores) this.wakeStore(store);
    }, this.options.intervalMs ?? 1_000);
    this.timer.unref?.();
  }

  beginShutdown(): void {
    this.closed = true;
    this.started = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const store of this.stores) signals.delete(store);
  }

  async waitForIdle(): Promise<void> {
    while (this.inFlight.size) await Promise.allSettled([...this.inFlight]);
  }

  wakeStore(store: RunStore): void {
    this.scheduleStoreWake(store, false);
  }

  private wakeAllStores(ignoreRetryAt: boolean): void {
    for (const store of this.stores) this.scheduleStoreWake(store, ignoreRetryAt);
  }

  private scheduleStoreWake(store: RunStore, ignoreRetryAt: boolean): void {
    if (!this.started || this.closed || this.options.activeRuns.isShuttingDown()) return;
    if (ignoreRetryAt) this.pendingResourceWake.add(store);
    if (this.pendingWake.has(store)) return;
    this.pendingWake.add(store);
    queueMicrotask(() => {
      this.pendingWake.delete(store);
      if (this.closed || this.options.activeRuns.isShuttingDown()) return;
      const bypassRetryAt = this.pendingResourceWake.delete(store);
      try { this.scanStore(store, bypassRetryAt); }
      catch { console.warn("runtime_run_queue_scan_incomplete: durable claims remain authoritative"); }
    });
  }

  private scanStore(store: RunStore, ignoreRetryAt = false): void {
    if (this.scanning.has(store)) return;
    this.scanning.add(store);
    try {
      const preparing = this.preparing.get(store);
      if (!preparing) return;
      const runtime = this.options.runtimeSupervisor.getRuntime(store.paths.cwd, store);
      const capacity = this.options.hostCapacity ?? this.options.runtimeSupervisor.getHostCapacityAdmission?.(store);
      // Preparation is a bounded handoff queue, not execution admission. Keep
      // enough independent preparations in flight for one blocked group not to
      // starve another; the policy still raises the bound for larger budgets.
      const preparingLimit = Math.max(MINIMUM_QUEUE_PREPARATIONS,
        this.options.runtimeSupervisor.getConcurrencyPolicy().maxConcurrentRuns);
      const workspaceIds = [...store.listWorkspaceIds()];
      const workspaceRuntimes = new Map<string, ReturnType<RuntimeSupervisor["getRuntime"]>>();
      const cursor = this.workspaceScanCursors.get(store);
      let workspaceIndex = cursor ? workspaceIds.indexOf(cursor) : 0;
      if (workspaceIndex < 0) workspaceIndex = 0;
      let visited = 0;
      while (visited < MAX_QUEUE_SCAN_ATTEMPTS && workspaceIds.length > 0
        && preparing.size < preparingLimit && !this.closed) {
        const workspaceId = workspaceIds[workspaceIndex]!;
        const workspaceRuntime = workspaceRuntimes.get(workspaceId) ?? (workspaceId === runtime.workspaceId ? runtime
          : this.options.runtimeSupervisor.getRuntimeForWorkspace(store.paths.cwd, store, workspaceId));
        workspaceRuntimes.set(workspaceId, workspaceRuntime);
        const selected = store.claimNextRuntimeRun({ workspaceId,
          runtimeInstanceId: workspaceRuntime.runtimeInstanceId, ownerId: this.ownerId, leaseMs: 30_000, now: new Date().toISOString(),
          ...(ignoreRetryAt ? { ignoreRetryAt: true } : {}) });
        if (selected.status === "empty") {
          workspaceIds.splice(workspaceIndex, 1);
          if (workspaceIds.length > 0) {
            workspaceIndex %= workspaceIds.length;
            this.workspaceScanCursors.set(store, workspaceIds[workspaceIndex]!);
          } else {
            this.workspaceScanCursors.delete(store);
          }
          continue;
        }
        if (selected.status !== "claimed") {
          if (workspaceIds.length > 1) {
            workspaceIndex = (workspaceIndex + 1) % workspaceIds.length;
            this.workspaceScanCursors.set(store, workspaceIds[workspaceIndex]!);
          }
          break;
        }
        visited += 1;
        workspaceIndex = (workspaceIndex + 1) % workspaceIds.length;
        this.workspaceScanCursors.set(store, workspaceIds[workspaceIndex]!);
        const { claim } = selected;
        const now = new Date().toISOString();
        const hostCapacity = capacity?.reserve({
          workspaceId: selected.entry.workspaceId,
          source: { runId: claim.runId, ...claim.sourceFence },
          now,
        });
        if (hostCapacity?.status === "full" || hostCapacity?.status === "unconfigured") {
          store.deferRuntimeQueuedRun({ claim, reason: "runtime_semaphore_conflict", now,
            retryAt: new Date(Date.parse(now) + (hostCapacity.status === "full" ? 1_000 : 30_000)).toISOString() });
          continue;
        }
        if (hostCapacity?.status === "changed") {
          store.deferRuntimeQueuedRun({ claim, reason: selected.entry.reason, now,
            retryAt: new Date(Date.parse(now) + 1_000).toISOString() });
          continue;
        }
        // A reclaimed Run can still have an unfinished preparation from an earlier claim.
        const preparation = Symbol(claim.runId);
        preparing.add(preparation);
        const prepared = (): void => {
          if (preparing.delete(preparation)) this.wakeStore(store);
        };
        const reservedHostCapacity = hostCapacity?.status === "reserved" || hostCapacity?.status === "duplicate"
          ? hostCapacity : undefined;
        const completion = Promise.resolve().then(() => {
          if (this.closed || this.options.activeRuns.isShuttingDown()) return;
          return this.options.execute({ store, claim, executionOptions: {
            ...this.retainedOptions.get(store)?.get(claim.runId), onRunReady: prepared,
            ...(reservedHostCapacity ? { queuedHostCapacity: reservedHostCapacity.reference } : {}),
            ...(reservedHostCapacity && capacity ? {
              afterRunTerminal: async (terminalRun) => {
                try { await this.retainedOptions.get(store)?.get(claim.runId)?.afterRunTerminal?.(terminalRun); }
                finally {
                  capacity.releaseStopped({ workspaceId: selected.entry.workspaceId,
                  source: { runId: claim.runId, ...claim.sourceFence }, intentId: reservedHostCapacity.reference.intentId,
                    now: new Date().toISOString() });
                }
              },
            } : {}),
          } });
        }).catch(() => {
          console.warn("runtime_run_queue_preparation_incomplete: no dispatch permission is reissued");
        }).finally(() => {
          try {
            const now = new Date().toISOString();
            if (reservedHostCapacity) {
              try {
                capacity?.releaseNoDispatch({ workspaceId: selected.entry.workspaceId,
                  intentId: reservedHostCapacity.reference.intentId, now });
              } catch {
                console.warn("runtime_run_queue_host_release_incomplete: reservation remains recoverable");
              }
            }
            store.deferRuntimeQueuedRun({ claim, reason: selected.entry.reason, now,
              retryAt: new Date(Date.parse(now) + 1_000).toISOString() });
            const run = store.getRun(claim.runId);
            if (!run || !["queued", "running", "waiting_for_approval"].includes(run.status)) {
              this.retainedOptions.get(store)?.delete(claim.runId);
            }
          } catch {
            console.warn("runtime_run_queue_cleanup_incomplete: execution custody was retained");
          } finally {
            prepared();
            this.inFlight.delete(completion);
            this.wakeStore(store);
          }
        });
        this.inFlight.add(completion);
      }
    } finally { this.scanning.delete(store); }
  }
}
