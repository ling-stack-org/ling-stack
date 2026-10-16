import { randomUUID } from "node:crypto";
import "./sandbox/core-original-process-bridge.js";
import {
  DEFAULT_WORKSPACE_ID,
  type ResourceLease,
  type RuntimeInstance,
  type RuntimeSemaphoreSlot,
  type RunExecutionStoreFacet,
  type RunSession,
  type RunStore,
  type RunStorePathsFacet,
  type RuntimeSupervisorStoreFacet,
  type WorkUnit,
  toRuntimeAttemptFence,
} from "@ling-stack/core";
import { assertOriginalOfficeHostBridgeForCompositionCurrent, retireOriginalOfficeHostBridgeForComposition,
  type OriginalOfficeHostBridgeSetup } from "@ling-stack/core/original-office-host-bridge";
import type { ResolvedDaemonConfig } from "../config.js";
import { NativeRestrictedCommandRuntime } from "./sandbox/restricted-command-runtime.js";
import { ProtectedHostStageRegistry } from "./sandbox/protected-host-staging.js";
import type { ProtectedHostActorEntry } from "./sandbox/protected-host-actor-inventory.js";
import { readOriginalProtectedHostActorEntries } from "./sandbox/protected-host-original-entry-manifest.js";
import type { OfficeLocalReviewedNativeArtifact } from "./sandbox/protected-host-office-native-identity.js";
import { OfficeLocalNativeRuntime } from "../features/office-documents/office-local-native-runtime.js";
import {
  isStuckWorkUnit,
  listActiveWorkUnits,
  markWorkUnitStale,
  releaseWorkUnitRuntimeResources,
  transitionWorkUnitTerminal,
} from "./work-units.js";
import {
  LockedTaskContinuationGate,
  type LockedTaskContinuationSnapshot,
} from "./locked-task-continuation.js";
import { WorkspaceRuntimeOwner } from "./workspace-runtime-owner.js";

const RUNTIME_SCHEMA_VERSION = 23;
const originalOfficeRuntimeBindings = new WeakMap<RuntimeSupervisor, {
  readonly registry: ProtectedHostStageRegistry; readonly stores: WeakMap<RunStore, RuntimeInstance>;
  readonly nativeRuntimes: WeakMap<RunStore, OfficeLocalNativeRuntime>;
  readonly storeBridges: Set<{ readonly store: RunStore; readonly setup: OriginalOfficeHostBridgeSetup }>;
  readonly issuerId: string; readonly artifact?: OfficeLocalReviewedNativeArtifact; active: boolean;
}>();

/** Exact constructor root, not public runtime/cache flags; cache ownership survives retirement for cleanup only. */
export function isOriginalRuntimeSupervisorOfficeRoot(value: unknown): value is RuntimeSupervisor {
  return typeof value === "object" && value !== null && originalOfficeRuntimeBindings.get(value as RuntimeSupervisor)?.active === true;
}
/** Fixed composition enrolls only sealed exact-owner handles; no replaceable lifecycle callback. */
export function retainOriginalRuntimeSupervisorOfficeStoreBridge(supervisor: RuntimeSupervisor, store: RunStore,
  setup: OriginalOfficeHostBridgeSetup): void {
  const original = originalOfficeRuntimeBindings.get(supervisor);
  if (!original?.active) throw new Error("office_local_directory_core_composition_invalid");
  assertOriginalOfficeHostBridgeForCompositionCurrent(setup, store);
  original.storeBridges.add(Object.freeze({ store, setup }));
}
export interface RuntimeSupervisorHostBootstrap {
  /** Explicit Host/test selection. Omitted uses the fixed original source list; incomplete/custom lists still close Office. */
  readonly actorEntries?: readonly ProtectedHostActorEntry[];
  /** Build-time Host selection only, not workspace/HTTP/model configuration or a runtime compiler. */
  readonly officeLocalNativeArtifact?: OfficeLocalReviewedNativeArtifact;
}

export type RuntimeSupervisorRuntimeStore = RunStorePathsFacet & RuntimeSupervisorStoreFacet & RunExecutionStoreFacet;

/** Read only a binding issued by the original Supervisor for this exact store and shared registry. */
export function readRuntimeSupervisorOfficeBinding(supervisor: RuntimeSupervisor, store: RunStore,
  registry: ProtectedHostStageRegistry): RuntimeInstance {
  const original = originalOfficeRuntimeBindings.get(supervisor), runtime = original?.stores.get(store);
  if (!runtime || !original?.active || original.registry !== registry || runtime.schemaVersion !== RUNTIME_SCHEMA_VERSION
    || runtime.pid !== process.pid || runtime.status !== "healthy") throw new Error("office_local_native_runtime_binding_invalid");
  return runtime;
}
export function readRuntimeSupervisorOfficeIssuerId(supervisor: RuntimeSupervisor, store: RunStore,
  registry: ProtectedHostStageRegistry): string {
  readRuntimeSupervisorOfficeBinding(supervisor, store, registry);
  return originalOfficeRuntimeBindings.get(supervisor)!.issuerId;
}
export function readRuntimeSupervisorOfficeArtifact(supervisor: RuntimeSupervisor, store: RunStore,
  registry: ProtectedHostStageRegistry): OfficeLocalReviewedNativeArtifact {
  readRuntimeSupervisorOfficeBinding(supervisor, store, registry);
  const artifact = originalOfficeRuntimeBindings.get(supervisor)!.artifact;
  if (!artifact) throw new Error("office_local_native_artifact_unconfigured");
  return artifact;
}
/** Object ownership only: remains readable for cleanup after release, never reopens forward admission. */
export function isRuntimeSupervisorOfficeCacheEntry(supervisor: RuntimeSupervisor, store: RunStore,
  registry: ProtectedHostStageRegistry, runtime: OfficeLocalNativeRuntime): boolean {
  const original = originalOfficeRuntimeBindings.get(supervisor);
  return original?.registry === registry && original.nativeRuntimes.get(store) === runtime;
}

function captureHostBootstrap(input?: RuntimeSupervisorHostBootstrap): RuntimeSupervisorHostBootstrap | undefined {
  if (!input) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(input);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string" || !["actorEntries", "officeLocalNativeArtifact"].includes(key)
      || !Object.hasOwn(descriptors[key]!, "value")) throw new Error("office_local_native_host_bootstrap_invalid");
  }
  const actorEntries = descriptors.actorEntries?.value as readonly ProtectedHostActorEntry[] | undefined;
  if (actorEntries && !Array.isArray(actorEntries)) throw new Error("office_local_native_host_bootstrap_invalid");
  const artifact = descriptors.officeLocalNativeArtifact?.value as OfficeLocalReviewedNativeArtifact | undefined;
  let originalArtifact: OfficeLocalReviewedNativeArtifact | undefined;
  if (artifact) {
    const fields = Object.getOwnPropertyDescriptors(artifact);
    if (Reflect.ownKeys(fields).length !== 3 || !["binaryPath", "reviewedBinarySha256", "reviewedSourceSha256"].every(key =>
      fields[key] && Object.hasOwn(fields[key]!, "value"))) throw new Error("office_local_native_host_bootstrap_invalid");
    const sourceFields = Object.getOwnPropertyDescriptors(fields.reviewedSourceSha256!.value);
    const sources: Record<string, string> = Object.create(null);
    for (const key of Reflect.ownKeys(sourceFields)) {
      if (typeof key !== "string" || !Object.hasOwn(sourceFields[key]!, "value") || typeof sourceFields[key]!.value !== "string")
        throw new Error("office_local_native_host_bootstrap_invalid");
      sources[key] = sourceFields[key]!.value as string;
    }
    originalArtifact = Object.freeze({ binaryPath: fields.binaryPath!.value as string,
      reviewedBinarySha256: fields.reviewedBinarySha256!.value as string, reviewedSourceSha256: Object.freeze(sources) });
  }
  return Object.freeze({ ...(actorEntries ? { actorEntries: Object.freeze([...actorEntries]) } : {}),
    ...(originalArtifact ? { officeLocalNativeArtifact: originalArtifact } : {}) });
}

export type RuntimeSupervisorWorkUnitTransitionObserver = (input: {
  readonly store: RuntimeSupervisorRuntimeStore;
  readonly cwd: string;
  readonly workUnit: WorkUnit;
  readonly previousStatus: WorkUnit["status"];
  readonly status: WorkUnit["status"];
  readonly reason: string;
  readonly now: string;
}) => void;

export class RuntimeSupervisor {
  private readonly hostBootstrap?: RuntimeSupervisorHostBootstrap;
  private restrictedCommandRuntime: NativeRestrictedCommandRuntime | undefined;
  private readonly protectedHostStages = new ProtectedHostStageRegistry();
  private readonly officeNativeRuntimes = new Map<RunStore, OfficeLocalNativeRuntime>();
  private readonly runtimesByCwd = new Map<string, RuntimeInstance>();
  private readonly runtimeOwnersByCwd = new Map<string, WorkspaceRuntimeOwner>();
  private readonly reconciledCwds = new Set<string>();
  private readonly lockedTaskContinuation = new LockedTaskContinuationGate();
  private lockedTaskContinuationOwnerId: string | undefined;
  private lockedTaskContinuationLeaseTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly config: ResolvedDaemonConfig,
    private readonly onWorkUnitTransition?: RuntimeSupervisorWorkUnitTransitionObserver,
    hostBootstrap?: RuntimeSupervisorHostBootstrap,
  ) {
    this.hostBootstrap = captureHostBootstrap(hostBootstrap);
    originalOfficeRuntimeBindings.set(this, { registry: this.protectedHostStages, stores: new WeakMap(), nativeRuntimes: new WeakMap(), storeBridges: new Set(),
      issuerId: `protected_host_supervisor_${randomUUID()}`, artifact: this.hostBootstrap?.officeLocalNativeArtifact, active: true });
    this.protectedHostStages.bindOriginalActorEntries(this.hostBootstrap?.actorEntries ?? readOriginalProtectedHostActorEntries());
  }

  getRuntimeToolFeatures(): ResolvedDaemonConfig["runtimeTools"] {
    return this.config.runtimeTools;
  }

  getTransportFeatures(): ResolvedDaemonConfig["transports"] {
    return this.config.transports;
  }

  getSandboxFeatures(): ResolvedDaemonConfig["sandbox"] {
    return this.config.sandbox;
  }

  getHarnessFeatures(): ResolvedDaemonConfig["harness"] {
    return this.config.harness;
  }

  getRestrictedCommandRuntime(): NativeRestrictedCommandRuntime | undefined {
    const config = this.config.sandbox.restrictedCommands;
    if (config) this.restrictedCommandRuntime ??= new NativeRestrictedCommandRuntime(config, this.protectedHostStages);
    return this.restrictedCommandRuntime;
  }

  /** Shared original issuer for the future fixed Office adapter; never construct a second protection registry. */
  getProtectedHostStageRegistry(): ProtectedHostStageRegistry { return this.protectedHostStages; }

  getOfficeLocalNativeRuntime(cwd: string, store: RunStore): OfficeLocalNativeRuntime | undefined {
    const artifact = this.hostBootstrap?.officeLocalNativeArtifact;
    if (!artifact) return undefined;
    if (!originalOfficeRuntimeBindings.get(this)!.active) throw new Error("office_local_native_runtime_closed");
    if (cwd !== store.paths.cwd) throw new Error("office_local_native_runtime_workspace_invalid");
    const runtime = this.getRuntime(cwd, store);
    originalOfficeRuntimeBindings.get(this)!.stores.set(store, runtime);
    let nativeRuntime = this.officeNativeRuntimes.get(store);
    if (!nativeRuntime) {
      nativeRuntime = new OfficeLocalNativeRuntime(this, this.protectedHostStages, store);
      this.officeNativeRuntimes.set(store, nativeRuntime);
      originalOfficeRuntimeBindings.get(this)!.nativeRuntimes.set(store, nativeRuntime);
    }
    return nativeRuntime;
  }

  getLockedTaskContinuationSnapshot(): LockedTaskContinuationSnapshot {
    return this.lockedTaskContinuation.snapshot();
  }

  updateLockedTaskContinuation(input: {
    readonly desktopInstanceId: string;
    readonly leaseTtlMs: number;
    readonly continueWhileLocked: boolean;
    readonly locked: boolean;
  }): LockedTaskContinuationSnapshot {
    this.clearLockedTaskContinuationLease();
    this.lockedTaskContinuationOwnerId = input.desktopInstanceId;
    const ownerId = input.desktopInstanceId;
    this.lockedTaskContinuationLeaseTimer = setTimeout(() => {
      if (this.lockedTaskContinuationOwnerId !== ownerId) return;
      this.lockedTaskContinuationOwnerId = undefined;
      this.lockedTaskContinuationLeaseTimer = undefined;
      this.lockedTaskContinuation.update({ continueWhileLocked: true, locked: false });
    }, input.leaseTtlMs);
    if (typeof this.lockedTaskContinuationLeaseTimer.unref === "function") {
      this.lockedTaskContinuationLeaseTimer.unref();
    }
    return this.lockedTaskContinuation.update(input);
  }

  releaseLockedTaskContinuation(desktopInstanceId: string): LockedTaskContinuationSnapshot {
    if (this.lockedTaskContinuationOwnerId !== desktopInstanceId) {
      return this.lockedTaskContinuation.snapshot();
    }
    this.clearLockedTaskContinuationLease();
    this.lockedTaskContinuationOwnerId = undefined;
    return this.lockedTaskContinuation.update({ continueWhileLocked: true, locked: false });
  }

  isLockedTaskContinuationBlocked(): boolean {
    return this.lockedTaskContinuation.isBlocked();
  }

  waitForLockedTaskContinuation(signal?: AbortSignal): Promise<void> {
    return this.lockedTaskContinuation.waitUntilAllowed(signal);
  }

  getRuntime(cwd: string, store: RuntimeSupervisorRuntimeStore): RuntimeInstance {
    if (!originalOfficeRuntimeBindings.get(this)!.active) throw new Error("runtime_supervisor_released");
    const existing = this.runtimesByCwd.get(cwd);
    if (existing) {
      const owner = this.runtimeOwnersByCwd.get(cwd);
      if (!owner) throw new Error("runtime_owner_lease_unknown");
      owner.assertCurrent(cwd, store.paths.rootDir);
      return existing;
    }
    if (this.runtimeOwnersByCwd.has(cwd)) throw new Error("runtime_startup_incomplete");
    const owner = new WorkspaceRuntimeOwner({ rootDir: store.paths.rootDir, cwd,
      host: this.config.host, port: this.config.port });
    this.runtimeOwnersByCwd.set(cwd, owner);
    try {
      owner.acquire();
      this.reconcileStartup(cwd, store);
      const runtime: RuntimeInstance = {
        workspaceId: DEFAULT_WORKSPACE_ID,
        runtimeInstanceId: `runtime_${randomUUID()}`,
        pid: process.pid,
        host: this.config.host,
        port: this.config.port,
        startedAt: new Date().toISOString(),
        version: "0.0.0",
        schemaVersion: RUNTIME_SCHEMA_VERSION,
        status: "healthy",
      };
      owner.publish(runtime);
      this.runtimesByCwd.set(cwd, runtime);
      return runtime;
    } catch (error) {
      this.reconciledCwds.delete(cwd);
      try { owner.release(); }
      catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "runtime_startup_failed_cleanup_incomplete", { cause: error });
      } finally {
        if (owner.isReleased) this.runtimeOwnersByCwd.delete(cwd);
      }
      throw error;
    }
  }

  getDiagnostics(cwd: string, store: RuntimeSupervisorRuntimeStore): {
    readonly runtime: RuntimeInstance;
    readonly active: readonly WorkUnit[];
    readonly stuck: readonly WorkUnit[];
    readonly queued: readonly WorkUnit[];
    readonly stale: readonly WorkUnit[];
    readonly leases: readonly ResourceLease[];
    readonly semaphoreSlots: readonly RuntimeSemaphoreSlot[];
  } {
    const runtime = this.getRuntime(cwd, store);
    const active = listActiveWorkUnits(store);
    return {
      runtime,
      active,
      stuck: active.filter((workUnit) => isStuckWorkUnit(workUnit, new Date())),
      queued: store.listWorkUnits({ status: "queued", limit: 200 }),
      stale: store.listWorkUnits({ status: "stale", limit: 200 }),
      leases: store.listResourceLeases({ status: "active", limit: 500 }),
      semaphoreSlots: store.listRuntimeSemaphoreSlots({ status: "active", limit: 500 }),
    };
  }

  releaseAll(): void {
    const original = originalOfficeRuntimeBindings.get(this)!;
    original.active = false;
    for (const bridge of original.storeBridges) retireOriginalOfficeHostBridgeForComposition(bridge.setup, bridge.store);
    original.storeBridges.clear();
    const nativeCloseErrors: unknown[] = [];
    for (const runtime of this.officeNativeRuntimes.values()) {
      try { runtime.releaseIdentity(); } catch (error) { nativeCloseErrors.push(error); }
    }
    this.clearLockedTaskContinuationLease();
    this.lockedTaskContinuationOwnerId = undefined;
    this.lockedTaskContinuation.update({ continueWhileLocked: true, locked: false });
    const ownerCloseErrors: unknown[] = [];
    for (const [cwd, owner] of this.runtimeOwnersByCwd) {
      try { owner.release(); } catch (error) { ownerCloseErrors.push(error); }
      if (owner.isReleased) this.runtimeOwnersByCwd.delete(cwd);
    }
    this.runtimesByCwd.clear();
    this.reconciledCwds.clear();
    if (ownerCloseErrors.length) {
      const failures = [
        ...(nativeCloseErrors.length ? [new AggregateError(nativeCloseErrors, "office_local_native_identity_close_unknown")] : []),
        ...ownerCloseErrors,
      ];
      throw new AggregateError(failures, "runtime_supervisor_release_incomplete", { cause: failures[0] });
    }
    if (nativeCloseErrors.length) throw new AggregateError(nativeCloseErrors, "office_local_native_identity_close_unknown");
  }

  private clearLockedTaskContinuationLease(): void {
    if (!this.lockedTaskContinuationLeaseTimer) return;
    clearTimeout(this.lockedTaskContinuationLeaseTimer);
    this.lockedTaskContinuationLeaseTimer = undefined;
  }

  private reconcileStartup(cwd: string, store: RuntimeSupervisorRuntimeStore): void {
    if (this.reconciledCwds.has(cwd)) {
      return;
    }
    const now = new Date().toISOString();
    const candidates = [
      ...store.listWorkUnits({ status: "claimed", limit: 500 }),
      ...store.listWorkUnits({ status: "running", limit: 500 }),
      ...store.listWorkUnits({ status: "waiting_for_approval", limit: 500 }),
      ...store.listWorkUnits({ status: "cancelling", limit: 500 }),
    ];
    for (const workUnit of candidates) {
      const reason = "runtime-startup-reconcile";
      const reconciled = preserveRecoverableApprovalWorkUnit(store, workUnit, now) ??
        reconcileActiveWorkUnitFromLinkedTerminalRun(store, workUnit, now) ??
        markWorkUnitStale(store, workUnit, now, reason);
      this.notifyWorkUnitTransition(store, cwd, workUnit, reconciled, reason, now);
    }
    for (const workUnit of store.listWorkUnits({ kind: "channel_turn_dispatch", status: "stale", limit: 500 })) {
      const retried = store.transitionWorkUnitStatus({
        workUnitId: workUnit.id,
        expectedStatus: "stale",
        event: "retry",
        actor: "system",
        reason: "runtime-startup-requeue-channel-turn-dispatch",
        idempotencyKey: `runtime-startup-requeue:${workUnit.id}:${now}`,
        now,
        activeAttemptId: null,
        endedAt: null,
        errorCode: null,
        errorMessage: null,
      });
      if (retried.ok) {
        store.appendRuntimeEvent({
          workUnitId: workUnit.id,
          type: "work_unit_queued",
          actor: "system",
          ts: now,
          data: { reason: "runtime-startup-requeue-channel-turn-dispatch" },
        });
      }
    }
    store.expireRuntimeSemaphoreSlots(now);
    this.reconciledCwds.add(cwd);
  }

  private notifyWorkUnitTransition(
    store: RuntimeSupervisorRuntimeStore,
    cwd: string,
    before: WorkUnit,
    after: WorkUnit,
    reason: string,
    now: string,
  ): void {
    if (before.status === after.status) {
      return;
    }
    this.onWorkUnitTransition?.({
      store,
      cwd,
      workUnit: before,
      previousStatus: before.status,
      status: after.status,
      reason,
      now,
    });
  }
}

function preserveRecoverableApprovalWorkUnit(
  store: RuntimeSupervisorRuntimeStore,
  workUnit: WorkUnit,
  now: string,
): WorkUnit | undefined {
  if (!workUnit.linkedRunId || (workUnit.status !== "waiting_for_approval" && workUnit.status !== "running")) {
    return undefined;
  }
  if (!("listApprovalRequests" in store) || !("getApprovalCheckpointForApproval" in store)) {
    return undefined;
  }
  const approvalStore = store as RuntimeSupervisorRuntimeStore & Pick<
    import("@ling-stack/core").RunStore,
    "listApprovalRequests" | "getApprovalCheckpointForApproval"
  >;
  const run = store.getRun(workUnit.linkedRunId);
  if (!run || (run.status !== "waiting_for_approval" && run.status !== "running")) {
    return undefined;
  }
  const approval = approvalStore.listApprovalRequests({ runId: run.id, limit: 100 }).find((candidate) => {
    const checkpoint = approvalStore.getApprovalCheckpointForApproval(candidate.id);
    return checkpoint?.resumeBasis?.runId === run.id
      && checkpoint.resumeBasis.workUnitId === workUnit.id
      && (checkpoint.status === "pending" || checkpoint.status === "approved" || checkpoint.status === "resume_pending");
  });
  if (!approval) return undefined;
  const attempt = workUnit.activeAttemptId ? store.getWorkUnitAttempt(workUnit.activeAttemptId) : undefined;
  if (attempt && !isTerminalAttemptStatus(attempt.status)) {
    store.updateWorkUnitAttemptStatus({
      attemptId: attempt.id,
      workUnitId: attempt.workUnitId,
      runtimeInstanceId: attempt.runtimeInstanceId,
      fencingToken: attempt.fencingToken,
      status: "lost",
      now,
      endedAt: now,
      errorCode: "runtime_suspend",
      errorMessage: "runtime-startup-recoverable-approval",
    });
    store.releaseRuntimeSemaphoreSlotsForAttempt(toRuntimeAttemptFence(attempt), now, "runtime-startup-recoverable-approval");
    const lostAttempt = store.getWorkUnitAttempt(attempt.id) ?? attempt;
    store.appendTerminalRuntimeAudit({
      capability: {
        workUnitId: lostAttempt.workUnitId,
        attemptId: lostAttempt.id,
        runtimeInstanceId: lostAttempt.runtimeInstanceId,
        fencingToken: lostAttempt.fencingToken,
        attemptStatus: "lost",
        transitionedAt: now,
      },
      type: "work_unit_stale",
      actor: "system",
      data: { reason: "runtime_suspend", recoverableApprovalId: approval.id },
    });
  }
  return store.getWorkUnit(workUnit.id) ?? workUnit;
}

function isTerminalAttemptStatus(status: import("@ling-stack/core").WorkUnitAttempt["status"]): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled" || status === "lost";
}

function reconcileActiveWorkUnitFromLinkedTerminalRun(store: RuntimeSupervisorRuntimeStore, workUnit: WorkUnit, now: string): WorkUnit | undefined {
  if (workUnit.kind === "media_job" || !workUnit.linkedRunId) {
    return undefined;
  }
  const run = store.getRun(workUnit.linkedRunId);
  const terminal = run ? terminalWorkUnitTransitionForRun(run) : undefined;
  if (!terminal) {
    return undefined;
  }
  const attemptId = workUnit.activeAttemptId ?? store.listWorkUnitAttempts(workUnit.id).at(-1)?.id;
  if (!attemptId) {
    return undefined;
  }

  transitionWorkUnitTerminal(store, {
    workUnitId: workUnit.id,
    attemptId,
    event: terminal.event,
    attemptStatus: terminal.attemptStatus,
    runtimeEventType: terminal.runtimeEventType,
    actor: "system",
    now,
    errorCode: terminal.errorCode,
    errorMessage: terminal.errorMessage,
  });
  const reconciled = store.getWorkUnit(workUnit.id);
  if (reconciled?.status !== terminal.workUnitStatus) {
    return undefined;
  }
  releaseWorkUnitRuntimeResources(store, reconciled, now, "linked-terminal-run-reconcile");
  return store.getWorkUnit(workUnit.id) ?? reconciled;
}

function terminalWorkUnitTransitionForRun(run: RunSession):
  | {
    readonly workUnitStatus: "succeeded";
    readonly event: "runner_succeeded";
    readonly attemptStatus: "succeeded";
    readonly runtimeEventType: "work_unit_succeeded";
    readonly errorCode?: undefined;
    readonly errorMessage?: undefined;
  }
  | {
    readonly workUnitStatus: "failed";
    readonly event: "runner_failed";
    readonly attemptStatus: "failed";
    readonly runtimeEventType: "work_unit_failed";
    readonly errorCode: "linked_run_failed";
    readonly errorMessage: string;
  }
  | undefined {
  if (run.status === "succeeded") {
    return {
      workUnitStatus: "succeeded",
      event: "runner_succeeded",
      attemptStatus: "succeeded",
      runtimeEventType: "work_unit_succeeded",
    };
  }
  if (run.status === "failed") {
    return {
      workUnitStatus: "failed",
      event: "runner_failed",
      attemptStatus: "failed",
      runtimeEventType: "work_unit_failed",
      errorCode: "linked_run_failed",
      errorMessage: run.errorMessage ?? "Linked run failed before runtime startup reconcile.",
    };
  }
  return undefined;
}
