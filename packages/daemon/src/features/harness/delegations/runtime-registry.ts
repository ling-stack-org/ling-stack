import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import {
  delegationBudget, delegationFence, delegationId, delegationInteger, delegationRecord, delegationTimestamp,
  toRuntimeAttemptFence,
  type ClaimedDelegatedChild, type DelegationChildRuntime, type DelegationRecoveryClassification,
  type RunSession, type RunStore, type RuntimeAttemptFenceV1,
} from "@ling-stack/core";
import type { DelegationBudgetV1 } from "@ling-stack/contracts";
import type { ActiveRunRegistry } from "../../../runtime/active-runs.js";
import { isOriginalRuntimeSupervisorOfficeRoot, type RuntimeSupervisor } from "../../../runtime/supervisor.js";
import { rebuildDelegatedRunRequest } from "./delegated-run-dispatch.js";
import {
  readOriginalDelegationLifecycle, type OriginalDelegatedExecutionEntry, type OriginalDelegationLifecycle,
} from "./store-composition.js";
import type { RunRequest } from "../../runs/schemas.js";
import { isRecord } from "../../../shared/validation.js";

export interface DelegationRuntimeDiscoveryCursor { readonly createdAt: string; readonly reservationId: string }
export interface DelegationRuntimeDispatchInput {
  readonly store: RunStore;
  readonly request: RunRequest;
  readonly executionEntry: OriginalDelegatedExecutionEntry;
}
export interface DelegationRuntimeObservation {
  readonly reservationId: string;
  readonly stepId: string;
  readonly childRunId: string;
  readonly rootRunId: string;
  readonly state: DelegationChildRuntime["step"]["state"];
  readonly stepRevision: number;
  readonly code?: string;
  readonly runStatus: RunSession["status"];
  readonly attemptId?: string;
  /** A terminal classification is an observation, not a fan-in success certificate. */
  readonly classification: DelegationRecoveryClassification["kind"];
}
export interface DelegationRuntimeParentTools {
  spawn(input: { readonly spawnCallId: string; readonly objective: string; readonly requestedBudget: DelegationBudgetV1;
    readonly required: boolean; readonly participantId?: string }): DelegationRuntimeObservation & { readonly replayed: boolean };
  message(input: { readonly reservationId: string; readonly messageCallId: string; readonly text: string }): {
    readonly status: "durable_queued"; readonly messageId: string; readonly replayed: boolean;
  };
  wait(input: { readonly reservationId: string; readonly timeoutMs: number; readonly signal?: AbortSignal }): Promise<{
    readonly timedOut: boolean; readonly observation: DelegationRuntimeObservation;
  }>;
  interrupt(input: { readonly reservationId: string; readonly callId: string }): DelegationRuntimeObservation & { readonly replayed: boolean };
  resume(input: { readonly reservationId: string; readonly expectedStepRevision: number;
    readonly callId: string }): DelegationRuntimeObservation & { readonly replayed: boolean };
}
export interface DelegationRuntimeParentBinding {
  readonly store: RunStore;
  readonly runId: string;
  readonly sourceFence: RuntimeAttemptFenceV1;
  /** Original live orchestrator authority; never accepted from a model/HTTP DTO. */
  readonly assertCurrent: () => void;
}
export interface DelegationRuntimeRecoveryResult {
  readonly status: "scanned" | "disabled" | "recovery_unavailable";
  readonly scanned: number;
  readonly dispatched: number;
  readonly retained: number;
}
export interface DelegationRuntimeRegistryOptions {
  readonly supervisor: RuntimeSupervisor;
  readonly activeRuns: ActiveRunRegistry;
  /** Composition-root executor; never a tool argument or a second Runner loop. */
  readonly executeDelegatedRunRequest: (input: DelegationRuntimeDispatchInput) => Promise<string | undefined>;
  /** Host-selected current workflow snapshot. Absent selection always denies ordinary producers. */
  readonly isWorkflowSelected?: (input: { readonly store: RunStore;
    readonly run: Pick<RunSession, "workflowStepId" | "channelId"> }) => boolean;
  /** Current Host authority for a resumed parent during startup discovery. Missing means observe only. */
  readonly assertRecoveryParentCurrent?: (input: Omit<DelegationRuntimeParentBinding, "assertCurrent">) => void;
  readonly now?: () => string;
}
export interface DelegationRuntimeRegistry {
  registerStore(store: RunStore, lifecycle: OriginalDelegationLifecycle): void;
  /** Schema preparation can precede Run persistence; this is not execution admission. */
  isSelectedWorkflow(input: { readonly store: RunStore; readonly workflowStepId?: string; readonly channelId?: string }): boolean;
  bindParent(input: DelegationRuntimeParentBinding): DelegationRuntimeParentTools;
  recoverStore(store: RunStore): DelegationRuntimeRecoveryResult;
  stopAdmission(): void;
  abortOwned(): void;
  settle(): Promise<void>;
  /** Effective producer selection, not proof that packaged acceptance has passed. */
  isEnabled(): boolean;
}

interface StoreState {
  readonly store: RunStore;
  readonly lifecycle: OriginalDelegationLifecycle;
  readonly pending: Map<string, Promise<void>>;
  readonly owned: Map<string, RuntimeAttemptFenceV1>;
  readonly dispatchBlocks: Map<string, string>;
  sweep?: { readonly cutoff: string; readonly after?: DelegationRuntimeDiscoveryCursor };
}
const registries = new WeakMap<RuntimeSupervisor, DelegationRuntimeRegistry>();
const blocked = (code: string): never => { throw Object.assign(new Error(code), { code }); };
const RECOVERY_SCAN_INTERVAL_MS = 5_000;

/** Recovery launch requires both the live process owner and the same durable execution fence. */
export function assertDelegationRecoveryParentCurrent(input: Omit<DelegationRuntimeParentBinding, "assertCurrent"> & {
  readonly activeRuns: ActiveRunRegistry;
}): void {
  const active = input.activeRuns.get(input.runId);
  if (!active || active.abortController.signal.aborted
    || active.workUnitId !== input.sourceFence.workUnitId
    || active.attemptId !== input.sourceFence.attemptId
    || active.runtimeInstanceId !== input.sourceFence.runtimeInstanceId
    || active.fencingToken !== input.sourceFence.fencingToken
    || !input.store.isCurrentRunExecutionOwner(input.runId, input.sourceFence)) {
    return blocked("delegation.source_attempt_stale");
  }
}

/** Only the original startup Supervisor can select this process-local Host registry. */
export function readOriginalDelegationRuntimeRegistry(supervisor: RuntimeSupervisor): DelegationRuntimeRegistry | undefined {
  if (!isOriginalRuntimeSupervisorOfficeRoot(supervisor)) return blocked("delegation.authority_invalid");
  return registries.get(supervisor);
}

/** Explicit startup selection; a model cannot enroll a workflow through its request or metadata. */
export function createDelegationWorkflowSelector(selectedWorkflowIds: readonly string[]): NonNullable<DelegationRuntimeRegistryOptions["isWorkflowSelected"]> {
  if (!Array.isArray(selectedWorkflowIds) || selectedWorkflowIds.length > 100) return blocked("delegation.invalid_workflow_selection");
  const selected = new Set(selectedWorkflowIds.map(id => delegationId(id)));
  const snapshots = new WeakMap<RunStore, Map<string, unknown>>();
  return ({ store, run }) => {
    const step = run.workflowStepId ? store.getChannelWorkflowStep(run.workflowStepId) : undefined;
    const workflow = step ? store.getChannelWorkflow(step.workflowId) : undefined;
    if (!step || !workflow || !selected.has(workflow.id) || !["ready", "running"].includes(workflow.status)
      || !["queued", "claimed", "running"].includes(step.status)
      || workflow.channelId !== run.channelId || step.channelId !== run.channelId) return false;
    // Freeze design/participant input, not mutable progress/status/output. A
    // later plan/permission change requires a fresh explicit Host selection.
    const snapshot = { workflow: { id: workflow.id, workspaceId: workflow.workspaceId, channelId: workflow.channelId,
      title: workflow.title, objective: workflow.objective, createdAt: workflow.createdAt, createdBy: workflow.createdBy,
      sourceHandoffId: workflow.sourceHandoffId, metadata: workflow.metadata }, step: { id: step.id,
      workflowId: step.workflowId, position: step.position, title: step.title, prompt: step.prompt,
      toParticipantId: step.toParticipantId, participantAuthority: step.participantAuthority } };
    let captured = snapshots.get(store);
    if (!captured) { captured = new Map(); snapshots.set(store, captured); }
    const previous = captured.get(step.id);
    if (previous) return isDeepStrictEqual(previous, snapshot);
    captured.set(step.id, structuredClone(snapshot));
    return true;
  };
}

/** Owns dispatch/stop lifetimes; all durable mutations still belong to the existing Core lifecycle. */
export function createDelegationRuntimeRegistry(options: DelegationRuntimeRegistryOptions): DelegationRuntimeRegistry {
  if (!isOriginalRuntimeSupervisorOfficeRoot(options.supervisor) || registries.has(options.supervisor)
    || typeof options.executeDelegatedRunRequest !== "function") return blocked("delegation.authority_invalid");
  const states = new Map<RunStore, StoreState>();
  const work = new Set<Promise<unknown>>(), failures: unknown[] = [];
  const shutdown = new AbortController();
  let accepting = true;
  let recoveryTimer: ReturnType<typeof setInterval> | undefined;
  const now = (): string => delegationTimestamp(options.now?.() ?? new Date().toISOString());
  const enabled = (): boolean => {
    const features = options.supervisor.getHarnessFeatures();
    return features.delegations.mode === "enforce" && features.continuations.mode === "enforce"
      && features.toolBroker.mode === "enforce" && typeof options.isWorkflowSelected === "function";
  };
  const requireState = (store: RunStore): StoreState => {
    const state = states.get(store);
    if (!state) return blocked("delegation.store_composition_unavailable");
    readOriginalDelegationLifecycle(state.lifecycle, store);
    return state;
  };
  const observe = (state: StoreState, value: DelegationRecoveryClassification): DelegationRuntimeObservation => ({
    ...observation(value), ...(state.dispatchBlocks.has(value.runtime.reservation.id)
      ? { code: state.dispatchBlocks.get(value.runtime.reservation.id) } : {}),
  });
  const track = <T>(promise: Promise<T>, retainFailure: boolean): Promise<T> => {
    work.add(promise);
    void promise.then(() => { work.delete(promise); }, error => {
      work.delete(promise);
      if (retainFailure) failures.push(error);
    });
    return promise;
  };
  const assertParent = (binding: DelegationRuntimeParentBinding): { readonly state: StoreState; readonly run: RunSession } => {
    if (!accepting || options.activeRuns.isShuttingDown()) return blocked("delegation.admission_closed");
    if (!enabled()) return blocked("delegation.dynamic_gate_unavailable");
    const state = requireState(binding.store);
    binding.assertCurrent();
    const run = binding.store.getRun(binding.runId), unit = binding.store.getWorkUnit(binding.sourceFence.workUnitId);
    const attempt = binding.store.getWorkUnitAttempt(binding.sourceFence.attemptId);
    if (!run || !unit || !attempt || run.status !== "running" || run.endedAt || run.workUnitId !== unit.id
      || unit.status !== "running" || unit.endedAt || unit.linkedRunId !== run.id || unit.activeAttemptId !== attempt.id
      || attempt.status !== "started" || attempt.abortRequestedAt || attempt.endedAt
      || !isDeepStrictEqual(toRuntimeAttemptFence(attempt), binding.sourceFence)
      || !binding.store.isCurrentRunExecutionOwner(run.id, binding.sourceFence)) return blocked("delegation.source_attempt_stale");
    // Enabling a feature now cannot retroactively admit an old parent. Check
    // before allocating a child, not after claiming its budget and Attempt.
    const features = isRecord(run.requestSnapshot) ? run.requestSnapshot.harnessFeatureSnapshot : undefined;
    if (!isRecord(features) || features.schemaVersion !== 1 || features.continuations !== "enforce"
      || features.toolBroker !== "enforce" || features.delegations !== "enforce") return blocked("delegation.dynamic_gate_unavailable");
    // A normal conversation or an arbitrary request boolean cannot opt itself into dynamic execution.
    const step = run.workflowStepId ? binding.store.getChannelWorkflowStep(run.workflowStepId) : undefined;
    const workflow = step ? binding.store.getChannelWorkflow(step.workflowId) : undefined;
    if (!step || !workflow || step.channelId !== run.channelId || workflow.channelId !== run.channelId
      || step.workspaceId !== unit.workspaceId || workflow.workspaceId !== unit.workspaceId
      || options.isWorkflowSelected?.({ store: binding.store, run }) !== true) return blocked("delegation.workflow_not_selected");
    return { state, run };
  };
  const childFor = (binding: DelegationRuntimeParentBinding, reservationId: string): DelegationRecoveryClassification => {
    const { state, run } = assertParent(binding), child = state.lifecycle.recover(reservationId), value = child.runtime;
    const parentUnit = binding.store.getWorkUnit(binding.sourceFence.workUnitId)!;
    if (value.step.parentRunId !== run.id || value.run.parentRunId !== run.id
      || value.reservation.childRunId !== value.run.id || value.reservation.delegationStepId !== value.step.id
      || value.workUnit.linkedRunId !== value.run.id || value.workUnit.ownerType !== "delegation_step"
      || value.workUnit.ownerId !== value.step.id || value.workUnit.workspaceId !== parentUnit.workspaceId
      || value.run.threadId !== run.threadId || value.run.channelId !== run.channelId
      || value.run.workflowStepId !== run.workflowStepId) return blocked("delegation.lineage_invalid");
    return child;
  };
  const stopExact = (state: StoreState, runId: string, fence: RuntimeAttemptFenceV1, suspend: boolean): void => {
    const active = options.activeRuns.get(runId);
    if (!active || active.workUnitId !== fence.workUnitId || active.attemptId !== fence.attemptId
      || active.runtimeInstanceId !== fence.runtimeInstanceId || active.fencingToken !== fence.fencingToken) return;
    const run = state.store.getRun(runId), step = run?.workflowStepId ? state.store.getChannelWorkflowStep(run.workflowStepId) : undefined;
    options.activeRuns.requestStop(runId, suspend
      ? { kind: "runtime_suspend", cause: "daemon_restart", runtimeInstanceId: fence.runtimeInstanceId }
      : { kind: "workflow_cancel", workflowId: step?.workflowId ?? "delegation", reason: "Host delegated child interruption" });
    // Aborting is only a request. The actual original completion stays owned until it settles.
    if (active.completion) track(Promise.resolve(active.completion), true);
  };
  const dispatch = (binding: DelegationRuntimeParentBinding, child: ClaimedDelegatedChild): void => {
    if (child.replayed) return; // Response-loss replay is observation-only.
    const { state } = assertParent(binding);
    if (state.pending.has(child.reservation.id)) return;
    const fence = Object.freeze(toRuntimeAttemptFence(child.attempt));
    state.owned.set(child.run.id, fence);
    let executionEntered = false;
    const task = Promise.resolve().then(async () => {
      assertParent(binding);
      const current = childFor(binding, child.reservation.id);
      if (!current.runtime.attempt || !isDeepStrictEqual(toRuntimeAttemptFence(current.runtime.attempt), fence)
        || !["spawning", "resuming"].includes(current.runtime.step.state)) return blocked("delegation.source_attempt_stale");
      const prepared = state.lifecycle.getPreparation(child.reservation.id);
      const parentPrepared = child.reservation.parentReservationId
        ? state.lifecycle.getPreparation(child.reservation.parentReservationId) : undefined;
      const request = rebuildDelegatedRunRequest({ store: state.store, child, prepared, parentPrepared });
      const executionEntry = state.lifecycle.createExecutionEntry(child);
      assertParent(binding);
      executionEntered = true;
      await options.executeDelegatedRunRequest({ store: state.store, request, executionEntry });
    }).catch(error => {
      if (executionEntered) throw error;
      // No executor entered: preserve the claimed/unknown durable state. It is
      // not a refund or permission to replay, nor a physical drain failure.
      state.dispatchBlocks.set(child.reservation.id, publicBlockCode(error));
    }).finally(() => {
      if (state.pending.get(child.reservation.id) === task) state.pending.delete(child.reservation.id);
      if (state.owned.get(child.run.id) === fence) state.owned.delete(child.run.id);
    });
    state.pending.set(child.reservation.id, task);
    track(task, true);
  };
  const startQueued = (binding: DelegationRuntimeParentBinding, classification: DelegationRecoveryClassification): void => {
    if (classification.kind !== "queued_unclaimed") return;
    const { state } = assertParent(binding);
    const child = state.lifecycle.claim({ reservationId: classification.runtime.reservation.id,
      expectedStepRevision: classification.runtime.step.revision,
      runtimeInstanceId: options.supervisor.getRuntime(state.store.paths.cwd, state.store).runtimeInstanceId, now: now() });
    dispatch(binding, child);
  };

  const registry: DelegationRuntimeRegistry = Object.freeze({
    registerStore(store, lifecycle) {
      if (!accepting) return blocked("delegation.admission_closed");
      readOriginalDelegationLifecycle(lifecycle, store);
      options.supervisor.getRuntime(store.paths.cwd, store);
      const existing = states.get(store);
      if (existing && existing.lifecycle !== lifecycle) return blocked("delegation.authority_invalid");
      if (!existing) states.set(store, { store, lifecycle, pending: new Map(), owned: new Map(), dispatchBlocks: new Map() });
    },
    isSelectedWorkflow(input) {
      if (!accepting || !enabled() || !states.has(input.store)) return false;
      requireState(input.store);
      return options.isWorkflowSelected?.({ store: input.store,
        run: { workflowStepId: input.workflowStepId, channelId: input.channelId } }) === true;
    },
    bindParent(raw) {
      const input = delegationRecord(raw, ["store", "runId", "sourceFence", "assertCurrent"]);
      if (typeof input.assertCurrent !== "function") return blocked("delegation.authority_invalid");
      const binding: DelegationRuntimeParentBinding = Object.freeze({ store: input.store as RunStore,
        runId: delegationId(input.runId), sourceFence: delegationFence(input.sourceFence), assertCurrent: input.assertCurrent as () => void });
      assertParent(binding);
      return Object.freeze({
        spawn(raw) {
          const input = delegationRecord(raw, ["spawnCallId", "objective", "requestedBudget", "required", "participantId"]);
          if (typeof input.required !== "boolean") return blocked("delegation.invalid_input");
          const { state } = assertParent(binding);
          const child = state.lifecycle.spawn({ parentRunId: binding.runId, sourceFence: binding.sourceFence,
            spawnCallId: delegationId(input.spawnCallId), objective: delegationId(input.objective),
            requestedBudget: delegationBudget(input.requestedBudget), required: input.required,
            ...(input.participantId === undefined ? {} : { participantId: delegationId(input.participantId) }), now: now() });
          const classification = childFor(binding, child.reservation.id);
          if (!child.replayed) startQueued(binding, classification);
          return { ...observe(state, childFor(binding, child.reservation.id)), replayed: child.replayed };
        },
        message(raw) {
          const input = delegationRecord(raw, ["reservationId", "messageCallId", "text"]);
          const reservationId = delegationId(input.reservationId);
          childFor(binding, reservationId);
          const result = requireState(binding.store).lifecycle.message({ reservationId, parentFence: binding.sourceFence,
            messageCallId: delegationId(input.messageCallId), text: delegationId(input.text), now: now() });
          return { status: "durable_queued" as const, messageId: result.message.id, replayed: result.replayed };
        },
        wait(raw) {
          const input = delegationRecord(raw, ["reservationId", "timeoutMs", "signal"]);
          const reservationId = delegationId(input.reservationId), timeout = delegationInteger(input.timeoutMs);
          if (timeout > 60_000 || input.signal !== undefined && !(input.signal instanceof AbortSignal)) return blocked("delegation.invalid_wait_timeout");
          const signal = AbortSignal.any([shutdown.signal, ...(input.signal ? [input.signal as AbortSignal] : [])]);
          const initial = childFor(binding, reservationId);
          const state = requireState(binding.store);
          const deadline = Math.min(Date.now() + timeout, Date.parse(initial.runtime.reservation.deadlineAt));
          return track((async () => {
            let current = initial;
            while (current.kind !== "terminal" && !state.dispatchBlocks.has(reservationId) && Date.now() < deadline) {
              signal.throwIfAborted();
              await delay(Math.min(100, deadline - Date.now()), undefined, { signal });
              current = childFor(binding, reservationId);
            }
            signal.throwIfAborted();
            return { timedOut: current.kind !== "terminal" && !state.dispatchBlocks.has(reservationId), observation: observe(state, current) };
          })(), false);
        },
        interrupt(raw) {
          const input = delegationRecord(raw, ["reservationId", "callId"]), reservationId = delegationId(input.reservationId);
          childFor(binding, reservationId);
          const state = requireState(binding.store), result = state.lifecycle.interrupt({ reservationId,
            parentFence: binding.sourceFence, callId: delegationId(input.callId), now: now() });
          state.owned.set(result.run.id, Object.freeze({ ...result.sourceFence }));
          stopExact(state, result.run.id, result.sourceFence, false);
          return { ...observe(state, childFor(binding, reservationId)), replayed: result.replayed };
        },
        resume(raw) {
          const input = delegationRecord(raw, ["reservationId", "expectedStepRevision", "callId"]), reservationId = delegationId(input.reservationId);
          childFor(binding, reservationId);
          const state = requireState(binding.store), child = state.lifecycle.resume({ reservationId,
            expectedStepRevision: delegationInteger(input.expectedStepRevision), parentFence: binding.sourceFence,
            callId: delegationId(input.callId),
            runtimeInstanceId: options.supervisor.getRuntime(state.store.paths.cwd, state.store).runtimeInstanceId, now: now() });
          dispatch(binding, child);
          return { ...observe(state, childFor(binding, reservationId)), replayed: child.replayed };
        },
      } satisfies DelegationRuntimeParentTools);
    },
    recoverStore(store) {
      const empty = { scanned: 0, dispatched: 0, retained: 0 };
      if (!accepting || !enabled()) return { status: "disabled", ...empty };
      const state = requireState(store);
      const sweep = state.sweep ?? { cutoff: now() };
      const page = state.lifecycle.listRecoveryCandidates({ cutoffAt: sweep.cutoff, cursor: sweep.after, limit: 100 });
      if (page.reservationIds.length > 100 || new Set(page.reservationIds).size !== page.reservationIds.length
        || page.nextCursor && (!page.reservationIds.length || page.nextCursor.createdAt > sweep.cutoff
          || page.nextCursor.reservationId !== page.reservationIds.at(-1)
          || sweep.after && compareCursor(page.nextCursor, sweep.after) <= 0)) return blocked("delegation.invalid_discovery_page");
      if (page.nextCursor) { delegationTimestamp(page.nextCursor.createdAt); delegationId(page.nextCursor.reservationId); }
      let dispatched = 0, retained = 0;
      for (const reservationId of page.reservationIds) {
        const classification = state.lifecycle.recover(delegationId(reservationId)), child = classification.runtime;
        // A created/unknown, stopped or terminal child never becomes permission to re-dispatch.
        if (classification.kind !== "queued_unclaimed" || !options.assertRecoveryParentCurrent) { retained++; continue; }
        const run = store.getRun(child.step.parentRunId), unit = run?.workUnitId ? store.getWorkUnit(run.workUnitId) : undefined;
        const attempt = unit?.activeAttemptId ? store.getWorkUnitAttempt(unit.activeAttemptId) : undefined;
        if (!run || !attempt) { retained++; continue; }
        const binding: DelegationRuntimeParentBinding = { store, runId: run.id, sourceFence: toRuntimeAttemptFence(attempt),
          assertCurrent: () => options.assertRecoveryParentCurrent!({ store, runId: run.id, sourceFence: toRuntimeAttemptFence(attempt) }) };
        try { childFor(binding, reservationId); startQueued(binding, classification); dispatched++; }
        catch (error) {
          if (process.env.LING_DEBUG_DELEGATION_STACK === "1") console.error("delegation.recovery", error);
          retained++;
        } // Original durable classification/reservation remains authoritative.
      }
      state.sweep = page.nextCursor ? { cutoff: sweep.cutoff, after: page.nextCursor } : undefined;
      return { status: "scanned", scanned: page.reservationIds.length, dispatched, retained };
    },
    stopAdmission() {
      accepting = false;
      shutdown.abort();
      if (recoveryTimer) clearInterval(recoveryTimer);
      recoveryTimer = undefined;
    },
    abortOwned() {
      for (const state of states.values()) for (const [runId, fence] of state.owned) stopExact(state, runId, fence, true);
    },
    async settle() {
      while (work.size) await Promise.allSettled([...work]);
      if (failures.length) throw new AggregateError([...failures], "delegation_runtime_settlement_failed");
    },
    isEnabled: enabled,
  } satisfies DelegationRuntimeRegistry);
  registries.set(options.supervisor, registry);
  if (enabled()) {
    recoveryTimer = setInterval(() => {
      if (!accepting) return;
      for (const state of states.values()) {
        try { registry.recoverStore(state.store); }
        catch { /* Durable rows remain retryable; the next bounded sweep retries. */ }
      }
    }, RECOVERY_SCAN_INTERVAL_MS);
    recoveryTimer.unref?.();
  }
  return registry;
}

function observation(value: DelegationRecoveryClassification): DelegationRuntimeObservation {
  const { runtime } = value;
  return { reservationId: runtime.reservation.id, stepId: runtime.step.id, childRunId: runtime.run.id,
    rootRunId: runtime.step.rootRunId, state: runtime.step.state, stepRevision: runtime.step.revision, runStatus: runtime.run.status,
    ...(runtime.attempt ? { attemptId: runtime.attempt.id } : {}), classification: value.kind };
}
function compareCursor(left: DelegationRuntimeDiscoveryCursor, right: DelegationRuntimeDiscoveryCursor): number {
  delegationTimestamp(left.createdAt); delegationId(left.reservationId);
  return left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1
    : left.reservationId < right.reservationId ? -1 : left.reservationId > right.reservationId ? 1 : 0;
}
function publicBlockCode(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  return typeof code === "string" && /^delegation\.[a-z_]+$/.test(code) ? code : "delegation.dispatch_blocked";
}
