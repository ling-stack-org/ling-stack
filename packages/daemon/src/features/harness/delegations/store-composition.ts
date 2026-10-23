import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  applyConversationModeToEffectiveRunPolicySnapshot, assertDelegationAuthoritySubset,
  authorizationAndAccessFromLegacyPermission, captureRunProgressCheckpointLineage, delegationCapture, delegationDigest,
  delegationFence, delegationTimestamp, resolveRunAncestry, resolveSessionRunPolicy, toRuntimeAttemptFence,
  type ClaimedDelegatedChild, type DelegationAuthorityCapture, type DelegationBudgetReservation,
  type DelegationChildReceipt, type DelegationChildRuntime, type DelegationExecutionAuthority, type DelegationRootBudgetRecord,
  type DelegationPreparedExecution, type PrepareDelegatedChildInput, type PreparedDelegatedChild,
  type DelegationTokenPriceSnapshot, type DelegationUsageReceipt, type EffectiveRunPolicySnapshot,
  type RunSession, type RunStore, type RuntimeAttemptFenceV1, type SecretResolver,
  type SkillApprovalProfile, type WorkUnitAttempt, type ActivateRootRunSuspensionInput, type ActivateRootRunSuspensionResult,
} from "@ling-stack/core";
import { assertDelegationHostStoreOwner, createDelegationHostStoreBinding,
  type DelegationHostStoreBinding, type DelegationHostWriter } from "@ling-stack/core/delegation-host-store-bridge";
import type { PiRunnerProviderConfig } from "@ling-stack/runner-pi";
import { HttpError } from "../../../errors.js";
import { createRootSuspensionDispatchAuthority } from "../continuations/root-suspension-dispatch.js";
import { createFinalSettlementObservationAuthority } from "../continuations/final-settlement-observation.js";
import { isOriginalRuntimeSupervisorOfficeRoot, type RuntimeSupervisor } from "../../../runtime/supervisor.js";
import { createDelegatedTerminalHandoff, type DelegatedTerminalHandoff } from "../../../runtime/delegated-terminal-handoff.js";
import { loadWorkspaceRuntimeSettings } from "../../../runtime/runner-settings.js";
import type { RunnerRegistry } from "../../../runtime/runners.js";
import { compareProviderRuntimeObservationScope, providerPresetForRuntimeObservationScope,
  providerRuntimeScopeIdentity, runtimeObservationScopeForProvider,
  type ProviderRuntimeObservationScope } from "../../providers/runtime-observation-scope.js";
import { teammateCanWorkInEffectiveChannel } from "../../channels/channel-teammate-availability.js";
import type { RunRequest } from "../../runs/schemas.js";
import { rebuildExistingRunRequest, readStoredRunnerExecution } from "../../runs/existing-run-request.js";
import { resolveProviderForRun } from "../../runs/providers.js";
import { inlineProviderDescriptor } from "../../conversations/normal-conversation-prepared-provider.js";
import { resolveCurrentRunSkill } from "../../runs/skill-selection.js";
import { mergeApprovalProfiles } from "../../runs/run-approval-profile.js";
import { createDelegationHostAuthority } from "./host-authority.js";
import { createDelegationPriceRegistry } from "./price-registry.js";
import { rebuildDelegatedRunRequest, readOriginalDelegatedRunDispatchAuthority,
  type DelegatedRunDispatchAuthority } from "./delegated-run-dispatch.js";

const builtinTools = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;
// Dynamic children must not execute commands until the Host owns a real
// escaped-descendant containment receipt. Root runs may still use the ordinary
// command path, whose completion remains explicitly unverified/fail-closed.
const delegatedBuiltinTools = ["read", "edit", "write", "grep", "find", "ls"] as const;
const compositions = new WeakMap<RunStore, Composition>();
const lifecycleOwners = new WeakMap<OriginalDelegationLifecycle, Composition>();
const executionEntries = new WeakMap<OriginalDelegatedExecutionEntry, { readonly state: Composition; readonly execution: OriginalDelegatedExecution; consumed: boolean }>();
type PolicyIntent = Pick<RunRequest, "authorizationMode" | "workspaceAccessMode" | "permissionMode" | "permissionPreset">;
interface AdmissionFact {
  readonly rootRunId: string;
  readonly runId: string;
  readonly provider: PiRunnerProviderConfig;
  readonly providerScope: ProviderRuntimeObservationScope;
  readonly policyIntent: PolicyIntent;
  readonly approvalProfile?: SkillApprovalProfile;
  readonly requestedSkillId?: string;
  readonly teammateRevision?: string;
  readonly tools: readonly string[];
  readonly authority: DelegationExecutionAuthority;
  readonly capture: DelegationAuthorityCapture;
  readonly dynamicSurfaceVerified: boolean;
}
interface Composition {
  readonly supervisor: RuntimeSupervisor;
  readonly runnerRegistry: RunnerRegistry;
  readonly secretResolver: SecretResolver;
  readonly features: ReturnType<RuntimeSupervisor["getHarnessFeatures"]>["delegations"];
  readonly host: ReturnType<typeof createDelegationHostAuthority>;
  readonly writer: ReturnType<typeof createDelegationHostStoreBinding>["writer"];
  readonly facts: Map<string, AdmissionFact>;
  /** Synchronous activation-only receivers. Never a live admission fact. */
  readonly recoveryAuthorities: Map<string, { readonly fence: RuntimeAttemptFenceV1; readonly read: () => DelegationExecutionAuthority }>;
  readonly delegatedRecoveryAuthorities: Map<string, { readonly fence: RuntimeAttemptFenceV1; readonly read: () => DelegationExecutionAuthority }>;
  readonly startAuthorities: Map<string, { readonly fence: RuntimeAttemptFenceV1; readonly read: () => DelegationExecutionAuthority }>;
  readonly rootDispatch: ReturnType<typeof createRootSuspensionDispatchAuthority>;
  readonly finalSettlements: ReturnType<typeof createFinalSettlementObservationAuthority>;
  readonly usages: WeakMap<object, DelegationUsageReceipt>;
  readonly completions: WeakMap<object, DelegationChildReceipt>;
  readonly dispatch?: DelegatedRunDispatchAuthority;
  readonly entries: Map<string, OriginalDelegatedExecutionEntry>;
  store?: RunStore;
}
export interface OriginalDelegationRootAdmission {
  readonly store: RunStore;
  readonly run: RunSession;
  readonly attempt: WorkUnitAttempt;
  readonly originalProvider: PiRunnerProviderConfig;
  readonly effectivePolicySnapshot: EffectiveRunPolicySnapshot;
  /** Actual SDK core-tool selection; undefined uses the SDK's seven builtins. */
  readonly runtimeTools?: readonly string[];
  readonly request: RunRequest;
  readonly approvalProfile?: SkillApprovalProfile;
  /** MCP/Host/media/hydrated surfaces require their own verified inheritance producer. */
  readonly hasAdditionalToolSurfaces?: boolean;
  readonly now?: string;
}
export interface OriginalDelegatedChildAdmission extends Omit<OriginalDelegationRootAdmission, "run" | "attempt"> {
  readonly claimed: ClaimedDelegatedChild;
}

/** Private startup capability. No public Store can recover this object. */
export interface OriginalDelegationLifecycle {
  readonly spawn: (input: Omit<PrepareDelegatedChildInput, "capture"> & { readonly participantId?: string }) => PreparedDelegatedChild;
  readonly claim: DelegationHostWriter["claimDelegatedChild"];
  readonly getPreparation: DelegationHostWriter["getDelegatedChildPreparation"];
  readonly listRecoveryCandidates: DelegationHostWriter["listDelegatedRecoveryCandidates"];
  readonly commitPreparation: DelegationHostWriter["commitDelegatedChildPreparation"];
  readonly commitStart: DelegationHostWriter["commitDelegatedChildStart"];
  readonly message: DelegationHostWriter["appendDelegationInstruction"];
  readonly recover: DelegationHostWriter["classifyDelegatedChildRecovery"];
  readonly interrupt: DelegationHostWriter["requestDelegatedChildInterrupt"];
  readonly commitInterrupted: DelegationHostWriter["commitDelegatedChildInterrupted"];
  readonly resume: DelegationHostWriter["resumeDelegatedChild"];
  readonly activateSuspension: DelegationHostWriter["activateDelegatedRunSuspension"];
  readonly getSuspensionActivation: DelegationHostWriter["getDelegatedRunSuspensionActivation"];
  readonly getSuspensionStart: DelegationHostWriter["getDelegatedRunSuspensionStart"];
  /** Actual drained Host completion, measured usage settlement, then terminal step/result. */
  readonly terminal: DelegationHostWriter["commitDelegatedChildTerminal"];
  readonly prepareRunTerminalIntent: DelegationHostWriter["prepareRunTerminalIntent"];
  readonly getRunTerminalIntent: DelegationHostWriter["getRunTerminalIntent"];
  readonly listUnfinishedRunTerminalIntents: DelegationHostWriter["listUnfinishedRunTerminalIntents"];
  readonly reconcileRunTerminalIntent: DelegationHostWriter["reconcileRunTerminalIntent"];
  readonly acknowledgeRunTerminalIntent: DelegationHostWriter["acknowledgeRunTerminalIntent"];
  readonly requestRunSuspension: DelegationHostWriter["requestRunSuspension"];
  readonly sealRunSuspension: DelegationHostWriter["sealRunSuspension"];
  readonly getRunSuspensionForAttempt: DelegationHostWriter["getRunSuspensionForAttempt"];
  readonly getRunSuspension: DelegationHostWriter["getRunSuspension"];
  readonly beginRunSuspensionStop: DelegationHostWriter["beginRunSuspensionStop"];
  readonly commitRunSuspensionStopped: DelegationHostWriter["commitRunSuspensionStopped"];
  readonly getRunSuspensionStop: DelegationHostWriter["getRunSuspensionStop"];
  readonly createExecutionEntry: (claimed: ClaimedDelegatedChild) => OriginalDelegatedExecutionEntry;
}
declare const executionEntryBrand: unique symbol;
export interface OriginalDelegatedExecutionEntry { readonly [executionEntryBrand]: true }
export interface OriginalDelegatedExecution {
  readonly claimed: ClaimedDelegatedChild;
  readonly prepared?: DelegationPreparedExecution;
  readonly parentPrepared?: DelegationPreparedExecution;
  readonly dispatchAuthority: DelegatedRunDispatchAuthority;
  readonly buildRequest: () => RunRequest;
  readonly assertCurrent: () => void;
  /** Cleanup only: requires this source's durable graceful-stop provenance. */
  readonly assertSuspensionCleanupCurrent: () => void;
  readonly commitPreparation: (reference: unknown, now: string) => DelegationPreparedExecution;
  readonly commitStart: (reference: unknown, now: string) => ClaimedDelegatedChild;
  readonly isInterrupting: () => boolean;
  readonly commitInterrupted: (now: string) => ReturnType<DelegationHostWriter["commitDelegatedChildInterrupted"]>;
  readonly terminal: (now: string) => ReturnType<DelegationHostWriter["commitDelegatedChildTerminal"]>;
  /** Distinct from resumable suspension: verifies this exact original terminal chain. */
  readonly terminalHandoff: DelegatedTerminalHandoff;
}

export function readOriginalDelegationLifecycle(reference: unknown, store: RunStore): OriginalDelegationLifecycle {
  const state = reference && typeof reference === "object" ? lifecycleOwners.get(reference as OriginalDelegationLifecycle) : undefined;
  if (!state || requiredStore(state) !== store) fail("delegation.authority_invalid");
  return reference as OriginalDelegationLifecycle;
}

export type OriginalRunSuspensionLifecycle = Pick<OriginalDelegationLifecycle,
  "requestRunSuspension" | "sealRunSuspension" | "getRunSuspensionForAttempt" | "getRunSuspension"
  | "beginRunSuspensionStop" | "commitRunSuspensionStopped" | "getRunSuspensionStop">
  & Pick<DelegationHostWriter, "readStoppedCompactionSuspensionRecovery" | "readStoppedFinalSettlementRecovery">;

/** Original constructor custody, including ordinary Pi Runs when dynamic delegation is off. */
export function readOriginalRunSuspensionLifecycle(store: RunStore, supervisor: RuntimeSupervisor): OriginalRunSuspensionLifecycle {
  const state = compositions.get(store);
  if (!state || state.supervisor !== supervisor || requiredStore(state) !== store) fail("delegation.authority_invalid");
  assertOriginal(state);
  const writer = () => { requiredStore(state); return state.writer(); };
  return Object.freeze({
    requestRunSuspension: input => writer().requestRunSuspension(input),
    sealRunSuspension: input => writer().sealRunSuspension(input),
    getRunSuspensionForAttempt: id => writer().getRunSuspensionForAttempt(id),
    getRunSuspension: id => writer().getRunSuspension(id),
    beginRunSuspensionStop: input => writer().beginRunSuspensionStop(input),
    commitRunSuspensionStopped: input => writer().commitRunSuspensionStopped(input),
    getRunSuspensionStop: id => writer().getRunSuspensionStop(id),
    readStoppedCompactionSuspensionRecovery: input => writer().readStoppedCompactionSuspensionRecovery(input),
    readStoppedFinalSettlementRecovery: input => writer().readStoppedFinalSettlementRecovery(input),
  });
}

/** Original SDK observation scope encloses only the synchronous Core transaction. */
export function commitOriginalRunFinalSettlement(input: {
  readonly store: RunStore;
  readonly supervisor: RuntimeSupervisor;
  readonly observation: Parameters<ReturnType<typeof createFinalSettlementObservationAuthority>["withObservation"]>[0];
  readonly settlement: Omit<Parameters<DelegationHostWriter["commitRunFinalSettlement"]>[0], "observation">;
}): ReturnType<DelegationHostWriter["commitRunFinalSettlement"]> {
  const state = compositions.get(input.store);
  if (!state || state.supervisor !== input.supervisor || requiredStore(state) !== input.store) fail("delegation.authority_invalid");
  assertOriginal(state);
  if (input.settlement.runId !== input.observation.runId
    || !isDeepStrictEqual(input.settlement.sourceFence, input.observation.sourceFence)) fail("delegation.authority_invalid");
  return state.finalSettlements.withObservation(input.observation,
    reference => state.writer().commitRunFinalSettlement({ ...input.settlement, observation: reference }));
}
/** Called only after the orchestrator has resolved the exact existing child Store. */
export function readOriginalDelegatedExecutionEntry(reference: unknown, store: RunStore): OriginalDelegatedExecution {
  const entry = reference && typeof reference === "object" ? executionEntries.get(reference as OriginalDelegatedExecutionEntry) : undefined;
  if (!entry || requiredStore(entry.state) !== store) fail("delegation.authority_invalid");
  if (entry.consumed) fail("delegation.recovery_required");
  assertOwner(store, entry.execution.claimed.run.id, toRuntimeAttemptFence(entry.execution.claimed.attempt));
  entry.consumed = true;
  return entry.execution;
}

/** Constructor custody only. The resulting writer is never attached to public RunStore. */
export function createOriginalDelegationStoreComposition(input: {
  readonly supervisor: RuntimeSupervisor; readonly runnerRegistry: RunnerRegistry; readonly secretResolver: SecretResolver;
  readonly delegatedDispatchAuthority?: DelegatedRunDispatchAuthority;
}): { readonly binding: DelegationHostStoreBinding; readonly bindExactStore: (store: RunStore) => void; readonly lifecycle: OriginalDelegationLifecycle } {
  if (!isOriginalRuntimeSupervisorOfficeRoot(input.supervisor)) fail("delegation.authority_invalid");
  const dispatch = input.delegatedDispatchAuthority === undefined ? undefined
    : readOriginalDelegatedRunDispatchAuthority(input.delegatedDispatchAuthority);
  const features = Object.freeze(structuredClone(input.supervisor.getHarnessFeatures().delegations));
  let state: Composition;
  const host = createDelegationHostAuthority({
    readRootAdmissionScope: (runId, fence) => {
      const fact = exactFact(state, runId, fence);
      if (fact.rootRunId !== runId) fail("delegation.lineage_invalid");
      return { ...fact.capture, sourceFence: fence };
    },
    readChildLaunchScope: (runId, fence, participantId) => {
      const fact = exactFact(state, runId, fence);
      const authority = currentAuthority(state, runId, fence);
      if (!fact.dynamicSurfaceVerified) fail("delegation.dynamic_tool_surface_unverified");
      if (participantId !== undefined && !authority.participantIds.includes(participantId)) fail("delegation.authority_invalid");
      const unit = requiredStore(state).getWorkUnit(fence.workUnitId)!;
      if ((unit.effectiveRunnerId ?? unit.runnerId) !== "pi") fail("delegation.native_dynamic_gate_unavailable");
      const { participantId: _parentParticipant, ...inherited } = authority;
      return { ...fact.capture, runId, sourceFence: fence,
        authority: { ...inherited, ...(participantId === undefined ? {} : { participantId }) },
        runnerId: unit.effectiveRunnerId ?? unit.runnerId!, provider: fact.capture.provider,
        rootRunId: fact.rootRunId, budget: undefined };
    },
    readCurrentExecutionAuthority: (runId, fence) => currentAuthority(state, runId, fence),
    readModelInvocationScope: (runId, fence) => ({ ...exactFact(state, runId, fence).capture, sourceFence: fence }),
    readProviderUsageObservation: reference => {
      const receipt = reference && typeof reference === "object" ? state.usages.get(reference) : undefined;
      if (!receipt) fail("delegation.authority_invalid");
      return receipt;
    },
    readChildCompletionObservation: reference => {
      const receipt = reference && typeof reference === "object" ? state.completions.get(reference) : undefined;
      if (!receipt) fail("delegation.authority_invalid");
      return receipt;
    },
  });
  const rootDispatch = createRootSuspensionDispatchAuthority();
  const finalSettlements = createFinalSettlementObservationAuthority();
  const custody = createDelegationHostStoreBinding({ ...host.readers,
    readFinalSettlementObservation: finalSettlements.readObservation,
    readRootSuspensionRecoveryAuthority: (runId, fence) => {
      const receiver = state.recoveryAuthorities.get(runId);
      if (!receiver || !isDeepStrictEqual(receiver.fence, fence)) fail("delegation.run_admission_missing");
      return receiver.read();
    },
    readRootSuspensionStartObservation: rootDispatch.readStartObservation,
    readDelegatedSuspensionRecoveryAuthority: (runId, fence) => {
      const receiver = state.delegatedRecoveryAuthorities.get(runId);
      if (!receiver || !isDeepStrictEqual(receiver.fence, fence)) fail("delegation.run_admission_missing");
      return receiver.read();
    },
    readRootSuspensionStartAuthority: (runId, fence) => {
      const receiver = state.startAuthorities.get(runId);
      if (!receiver || !isDeepStrictEqual(receiver.fence, fence)) fail("delegation.run_admission_missing");
      return receiver.read();
    },
    ...(dispatch ? { readExecutionPreparation: dispatch.readExecutionPreparation,
      readRunnerStartObservation: dispatch.readRunnerStartObservation } : {}) });
  state = { ...input, dispatch, rootDispatch, finalSettlements, features, host, writer: custody.writer, facts: new Map(), recoveryAuthorities: new Map(),
    delegatedRecoveryAuthorities: new Map(), startAuthorities: new Map(),
    usages: new WeakMap(), completions: new WeakMap(), entries: new Map() };
  const lifecycle = createLifecycle(state);
  lifecycleOwners.set(lifecycle, state);
  return Object.freeze({ binding: custody.binding, lifecycle, bindExactStore(store: RunStore) {
    assertDelegationHostStoreOwner(custody.binding, store);
    if (state.store || compositions.has(store)) fail("delegation.authority_invalid");
    state.store = store;
    compositions.set(store, state);
  } });
}

/** Child Provider identity is obtained from its own real preflight, never copied from its parent. */
export function admitOriginalDelegatedChild(input: OriginalDelegatedChildAdmission): {
  readonly root: DelegationRootBudgetRecord; readonly reservation: DelegationBudgetReservation;
} {
  const state = compositions.get(input.store);
  if (!state) fail("delegation.store_composition_unavailable");
  assertOriginal(state);
  if (state.features.mode === "off") fail("delegation.dynamic_gate_unavailable");
  const claimed = verifyClaim(state, input.claimed);
  const { run, attempt, workUnit: unit, step, reservation } = claimed;
  const now = delegationTimestamp(input.now ?? new Date().toISOString()), fence = toRuntimeAttemptFence(attempt);
  const root = state.writer().getRootDelegationBudget(step.rootRunId);
  if (!root) fail("delegation.root_budget_missing");
  if (now < root.frozenAt || now >= root.deadlineAt || now >= reservation.deadlineAt) fail("delegation.deadline_exceeded");
  if ((unit.effectiveRunnerId ?? unit.runnerId) !== "pi") fail("delegation.native_dynamic_gate_unavailable");
  const pinned = readChildPinnedCapture(input.store, run);
  const providerScope = runtimeObservationScopeForProvider(input.store, input.originalProvider);
  const identity = providerScope ? providerRuntimeScopeIdentity(providerScope) : undefined;
  if (!providerScope || !identity || identity.providerPresetId !== run.providerPresetId
    || input.request.providerPresetId !== run.providerPresetId || !input.originalProvider.baseUrl || !input.originalProvider.api) {
    fail("delegation.provider_authority_unavailable");
  }
  const provider = { providerId: input.originalProvider.provider, model: input.originalProvider.model,
    baseUrl: input.originalProvider.baseUrl, api: input.originalProvider.api };
  if (!isDeepStrictEqual(provider, pinned.provider)) fail("delegation.provider_revoked");
  const tools = Object.freeze([...(input.runtimeTools ?? builtinTools)]);
  if (input.hasAdditionalToolSurfaces === true || tools.some(tool => !(delegatedBuiltinTools as readonly string[]).includes(tool))) {
    fail(tools.includes("bash") ? "delegation.command_containment_unverified" : "delegation.dynamic_tool_surface_unverified");
  }
  const provisional: AdmissionFact = { rootRunId: root.rootRunId, runId: run.id, provider: input.originalProvider, providerScope,
    policyIntent: { authorizationMode: input.request.authorizationMode, workspaceAccessMode: input.request.workspaceAccessMode,
      permissionMode: input.request.permissionMode, permissionPreset: input.request.permissionPreset },
    approvalProfile: input.approvalProfile ? structuredClone(input.approvalProfile) : undefined,
    requestedSkillId: input.request.requestedSkillId, teammateRevision: teammateAuthorityRevision(input.store, run.teammateId),
    tools, authority: pinned.authority, capture: pinned, dynamicSurfaceVerified: true };
  const old = state.facts.get(run.id);
  state.facts.set(run.id, provisional);
  try {
    const policy = currentPolicy(state, run, provisional);
    if (!isDeepStrictEqual(policy, input.effectivePolicySnapshot)) fail("delegation.policy_changed");
    const current = buildAuthority(state, run, fence, provisional, policy, pinned.authority.authoritySetId);
    // The physical SDK selection itself must fit both the frozen allocation
    // and current revocation policy. A narrowed preflight is not permission to
    // run a previously broader frozen allocation unchanged.
    assertDelegationAuthoritySubset(pinned.authority, current);
    assertDelegationAuthoritySubset(current, pinned.authority);
    const capture = delegationCapture({ rootRunId: root.rootRunId, runId: run.id, sourceFence: fence,
      authority: pinned.authority, budget: { tokenBudget: reservation.tokenReserved,
        costBudgetMicros: reservation.costReservedMicros, wallTimeBudgetMs: step.wallTimeBudgetMs },
      price: pinned.price, currency: pinned.currency, provider, runnerId: "pi" });
    state.facts.set(run.id, { ...provisional, capture });
    return Object.freeze({ root, reservation });
  } catch (error) {
    if (old) state.facts.set(run.id, old); else state.facts.delete(run.id);
    throw error;
  }
}

function createLifecycle(state: Composition): OriginalDelegationLifecycle {
  const writer = () => { requiredStore(state); return state.writer(); };
  const lifecycle: OriginalDelegationLifecycle = Object.freeze({
    spawn(input) {
      if (state.features.mode === "off" || !state.dispatch) fail("delegation.dynamic_gate_unavailable");
      const { participantId, ...request } = input;
      const participant = participantId ?? exactFact(state, request.parentRunId, request.sourceFence).authority.participantId;
      return writer().prepareDelegatedChild({ ...request,
        capture: state.host.captureChild(request.parentRunId, request.sourceFence, participant) });
    },
    claim: input => writer().claimDelegatedChild(input),
    getPreparation: id => writer().getDelegatedChildPreparation(id),
    listRecoveryCandidates: input => writer().listDelegatedRecoveryCandidates(input),
    commitPreparation: input => writer().commitDelegatedChildPreparation(input),
    commitStart: input => writer().commitDelegatedChildStart(input),
    message: input => writer().appendDelegationInstruction(input),
    recover: id => writer().classifyDelegatedChildRecovery(id),
    interrupt: input => writer().requestDelegatedChildInterrupt(input),
    commitInterrupted: input => writer().commitDelegatedChildInterrupted(input),
    resume: input => writer().resumeDelegatedChild(input),
    activateSuspension: activation => activateOriginalDelegatedRunSuspension({ store: requiredStore(state), supervisor: state.supervisor, activation }),
    getSuspensionActivation: query => writer().getDelegatedRunSuspensionActivation(query),
    getSuspensionStart: query => writer().getDelegatedRunSuspensionStart(query),
    terminal(input) {
      const store = requiredStore(state), runtime = writer().classifyDelegatedChildRecovery(input.reservationId).runtime;
      const completion = store.getHostAttemptCompletion({ runId: runtime.run.id, ...input.sourceFence });
      if (!completion?.drainedAt || !completion.effectCoverage || completion.drainedAt > input.now) fail("delegation.recovery_required");
      const reference = Object.freeze({});
      state.completions.set(reference, { kind: "verified_usage", childRunId: runtime.run.id, sourceFence: input.sourceFence });
      writer().settleDelegatedChild({ reservationId: input.reservationId,
        receipt: state.host.captureChildReceipt(reference), now: input.now });
      return writer().commitDelegatedChildTerminal(input);
    },
    prepareRunTerminalIntent: input => writer().prepareRunTerminalIntent(input),
    getRunTerminalIntent: id => writer().getRunTerminalIntent(id),
    listUnfinishedRunTerminalIntents: input => writer().listUnfinishedRunTerminalIntents(input),
    acknowledgeRunTerminalIntent: input => writer().acknowledgeRunTerminalIntent(input),
    requestRunSuspension: input => writer().requestRunSuspension(input),
    sealRunSuspension: input => writer().sealRunSuspension(input),
    getRunSuspensionForAttempt: id => writer().getRunSuspensionForAttempt(id),
    getRunSuspension: id => writer().getRunSuspension(id),
    beginRunSuspensionStop: input => writer().beginRunSuspensionStop(input),
    commitRunSuspensionStopped: input => writer().commitRunSuspensionStopped(input),
    getRunSuspensionStop: id => writer().getRunSuspensionStop(id),
    reconcileRunTerminalIntent(input) {
      const store = requiredStore(state), intent = writer().getRunTerminalIntent(input.attemptId);
      const run = intent ? store.getRun(intent.payload.runId) : undefined;
      const unit = run?.workUnitId ? store.getWorkUnit(run.workUnitId) : undefined;
      const completion = intent ? store.getHostAttemptCompletion({ runId: intent.payload.runId, ...intent.payload.sourceFence }) : undefined;
      if (intent && unit?.ownerType === "delegation_step" && completion?.drainedAt && completion.effectCoverage) {
        const reference = Object.freeze({});
        state.completions.set(reference, { kind: "verified_usage", childRunId: intent.payload.runId, sourceFence: intent.payload.sourceFence });
        return writer().reconcileRunTerminalIntent({ ...input, receipt: state.host.captureChildReceipt(reference) });
      }
      return writer().reconcileRunTerminalIntent(input);
    },
    createExecutionEntry(input) {
      if (state.features.mode === "off" || !state.dispatch) fail("delegation.dynamic_gate_unavailable");
      const child = freezeData(verifyClaim(state, input));
      const key = child.attempt.id, existing = state.entries.get(key);
      if (existing) return existing; // A fresh object must never reset dispatch custody.
      const prepared = writer().getDelegatedChildPreparation(child.reservation.id);
      const parentPrepared = child.reservation.parentReservationId
        ? writer().getDelegatedChildPreparation(child.reservation.parentReservationId) : undefined;
      const sourceFence = toRuntimeAttemptFence(child.attempt);
      let capturedIntent: { readonly id: string; readonly digest: string } | undefined;
      const terminalHandoff = createDelegatedTerminalHandoff({ runId: child.run.id, ...sourceFence }, phase => {
        const store = requiredStore(state), intent = writer().getRunTerminalIntent(sourceFence.attemptId);
        const run = store.getRun(child.run.id), unit = store.getWorkUnit(sourceFence.workUnitId);
        const attempt = store.getWorkUnitAttempt(sourceFence.attemptId);
        if (!intent || intent.payload.runId !== child.run.id || !isDeepStrictEqual(intent.payload.sourceFence, sourceFence)
          || !run || !unit || run.workUnitId !== unit.id || unit.linkedRunId !== run.id || unit.activeAttemptId !== attempt?.id
          || !attempt || !isDeepStrictEqual(toRuntimeAttemptFence(attempt), sourceFence)
          || capturedIntent && (capturedIntent.id !== intent.id || capturedIntent.digest !== intent.digest)) {
          fail("delegation.terminal_handoff_unverified");
        }
        if (phase === "capture") {
          if (!store.isCurrentRunExecutionOwner(child.run.id, sourceFence, true)) fail("delegation.source_attempt_stale");
          capturedIntent ??= { id: intent.id, digest: intent.digest };
          return;
        }
        if (!capturedIntent || intent.state !== "committed") fail("delegation.terminal_handoff_unverified");
        // Include the original incoming edge, not just this Run's descendants.
        // Core validates atomic results, exact Host drain/effects/quiescence,
        // reservations and measured usage. Sibling corruption also vetoes.
        const evidence = store.getDelegationCompletionEvidence({ rootRunIds: [child.step.parentRunId] });
        const own = evidence.steps.find(read => read.step.id === child.step.id);
        if (evidence.issues.length || !own || own.childRun?.id !== child.run.id
          || own.reservation?.id !== child.reservation.id || !isDeepStrictEqual(own.attempt?.sourceFence, sourceFence)
          || own.step.state !== intent.payload.desiredOutcome) fail("delegation.terminal_handoff_unverified");
        const selected = new Set([child.run.id]);
        for (let changed = true; changed;) {
          changed = false;
          for (const read of evidence.steps) if (selected.has(read.step.parentRunId) && read.childRun && !selected.has(read.childRun.id)) {
            selected.add(read.childRun.id); changed = true;
          }
        }
        if (evidence.steps.some(read => read.step.id === child.step.id || selected.has(read.step.parentRunId)
          ? !["succeeded", "failed", "cancelled"].includes(read.step.state) : false)) fail("delegation.terminal_handoff_unverified");
      });
      const execution: OriginalDelegatedExecution = Object.freeze({ claimed: child,
        terminalHandoff,
        ...(prepared ? { prepared: freezeData(prepared) } : {}), dispatchAuthority: state.dispatch,
        ...(parentPrepared ? { parentPrepared: freezeData(parentPrepared) } : {}),
        buildRequest: () => rebuildDelegatedRunRequest({ store: requiredStore(state), child, prepared, parentPrepared }),
        assertCurrent: () => assertExecutionCurrent(state, child),
        assertSuspensionCleanupCurrent: () => assertSuspensionCleanupCurrent(state, child),
        commitPreparation: (preparation: unknown, now: string) => writer().commitDelegatedChildPreparation({
          reservationId: child.reservation.id, sourceFence, preparation, now }),
        commitStart: (observation: unknown, now: string) => writer().commitDelegatedChildStart({
          reservationId: child.reservation.id, sourceFence, observation, now }),
        isInterrupting() {
          const current = writer().classifyDelegatedChildRecovery(child.reservation.id);
          if (!current.runtime.attempt || current.runtime.run.id !== child.run.id
            || delegationDigest(toRuntimeAttemptFence(current.runtime.attempt)) !== delegationDigest(sourceFence)) fail("delegation.source_attempt_stale");
          return current.kind === "interrupting";
        },
        commitInterrupted: (now: string) => writer().commitDelegatedChildInterrupted({
          reservationId: child.reservation.id, sourceFence, now }),
        terminal: (now: string) => lifecycle.terminal({ reservationId: child.reservation.id, sourceFence, now }),
      });
      const reference = Object.freeze(Object.create(null) as OriginalDelegatedExecutionEntry);
      executionEntries.set(reference, { state, execution, consumed: false });
      state.entries.set(key, reference);
      return reference;
    },
  } satisfies OriginalDelegationLifecycle);
  return lifecycle;
}

function verifyClaim(state: Composition, claimed: ClaimedDelegatedChild): ClaimedDelegatedChild {
  const store = requiredStore(state);
  // Validate data descriptors before reading or projecting a supplied claim.
  delegationDigest(claimed);
  if (claimed.replayed) fail("delegation.recovery_required");
  const current = state.writer().classifyDelegatedChildRecovery(claimed.reservation.id).runtime;
  if (!current.attempt || !sameDelegatedClaimIdentity(current, claimed)
    || !["spawning", "resuming"].includes(current.step.state) || current.workUnit.status !== "claimed"
    || current.attempt.status !== "created" || current.reservation.state !== "reserved") fail("delegation.source_attempt_stale");
  assertOwner(store, current.run.id, toRuntimeAttemptFence(current.attempt));
  return { ...current, attempt: current.attempt, replayed: false };
}

function sameDelegatedClaimIdentity(current: DelegationChildRuntime, claimed: ClaimedDelegatedChild): boolean {
  // Semaphore acquisition and preparation progress update activity clocks
  // before the SDK ACK. These clocks do not change custody. Keep every other
  // field, including lifecycle timestamps, frozen requests and budget revisions.
  const identity = (runtime: DelegationChildRuntime) => {
    const { updatedAt: _runActivity, ...run } = runtime.run;
    const { updatedAt: _unitActivity, lastEventAt: _unitEvent, lastHeartbeatAt: _unitHeartbeat,
      ...workUnit } = runtime.workUnit;
    const { lastEventAt: _attemptEvent, lastHeartbeatAt: _attemptHeartbeat,
      ...attempt } = runtime.attempt ?? {};
    return { step: runtime.step, reservation: runtime.reservation, run, workUnit, attempt };
  };
  return isDeepStrictEqual(identity(current), identity(claimed));
}

function freezeData<T>(value: T): T {
  const copy = structuredClone(value);
  function freeze(item: unknown): void { if (item && typeof item === "object") { for (const child of Object.values(item)) freeze(child); Object.freeze(item); } }
  freeze(copy);
  return copy;
}

function assertExecutionCurrent(state: Composition, child: ClaimedDelegatedChild): void {
  const store = requiredStore(state), fence = toRuntimeAttemptFence(child.attempt);
  assertOwner(store, child.run.id, fence);
  const reservation = state.writer().getDelegationBudgetReservation(child.reservation.id), step = store.getDelegationStep(child.step.id);
  const now = new Date().toISOString();
  if (!reservation || !step || reservation.state !== "reserved" || reservation.childRunId !== child.run.id
    || reservation.delegationStepId !== step.id || reservation.rootRunId !== child.step.rootRunId
    || !["spawning", "resuming", "running", "waiting"].includes(step.state)
    || step.parentRunId !== child.step.parentRunId || step.childRunId !== undefined && step.childRunId !== child.run.id) fail("delegation.source_attempt_stale");
  const root = state.writer().getRootDelegationBudget(reservation.rootRunId);
  if (!root || now >= root.deadlineAt || now >= reservation.deadlineAt) fail("delegation.deadline_exceeded");
  const pinned = readChildPinnedCapture(store, store.getRun(child.run.id)!);
  assertDelegationAuthoritySubset(currentAuthority(state, child.run.id, fence), pinned.authority);
}

function assertSuspensionCleanupCurrent(state: Composition, child: ClaimedDelegatedChild): void {
  const store = requiredStore(state), writer = state.writer(), fence = toRuntimeAttemptFence(child.attempt);
  const suspension = writer.getRunSuspensionForAttempt(fence.attemptId);
  const stopped = suspension ? writer.getRunSuspensionStop(suspension.id) : undefined;
  const source = stopped?.begin.source;
  const current = writer.classifyDelegatedChildRecovery(child.reservation.id);
  // Core begin-stop deliberately requests the original child's interruption.
  // This is not live execution admission: only the exact private stopped chain
  // may pass while cancelling, never a generic interrupt or replacement fence.
  if (!suspension || suspension.state !== "sealed" || !stopped || stopped.state !== "stopping"
    || stopped.begin.runId !== child.run.id || !isDeepStrictEqual(stopped.begin.sourceFence, fence)
    || source?.kind !== "delegated" || source.reservationId !== child.reservation.id
    || source.stepId !== child.step.id || source.parentRunId !== child.step.parentRunId
    || current.kind !== "interrupting" || current.runtime.run.id !== child.run.id
    || !current.runtime.attempt || !isDeepStrictEqual(toRuntimeAttemptFence(current.runtime.attempt), fence)
    || !store.isCurrentRunExecutionOwner(child.run.id, fence, true)) fail("delegation.source_attempt_stale");
  const run = current.runtime.run, fact = state.facts.get(run.id);
  if (!fact || !isDeepStrictEqual(fact.capture.sourceFence, fence)) fail("delegation.run_admission_missing");
  const pinned = readChildPinnedCapture(store, run);
  // Keep current permission/provider revocation checks, but not the live
  // assertOwner guard which must reject begin-stop's abortRequestedAt.
  assertDelegationAuthoritySubset(buildAuthority(state, run, fence, fact,
    currentPolicy(state, run, fact), fact.authority.authoritySetId), pinned.authority);
}

/** Called with original execution inputs, after durable admission and before actual Runner start. */
export function admitOriginalDelegationRoot(input: OriginalDelegationRootAdmission): DelegationRootBudgetRecord | undefined {
  const state = compositions.get(input.store);
  if (!state) fail("delegation.store_composition_unavailable");
  assertOriginal(state);
  if (state.features.mode === "off" || input.run.parentRunId !== undefined) return undefined;
  const now = delegationTimestamp(input.now ?? new Date().toISOString());
  const fence = toRuntimeAttemptFence(input.attempt);
  assertOwner(input.store, input.run.id, fence);
  const run = input.store.getRun(input.run.id)!;
  const unit = input.store.getWorkUnit(fence.workUnitId)!;
  if (!isDeepStrictEqual(run, input.run) || !isDeepStrictEqual(input.store.getWorkUnitAttempt(input.attempt.id), input.attempt)) fail("delegation.source_attempt_stale");
  const existing = state.writer().getRootDelegationBudget(run.id);
  if (!existing && (run.status !== "queued" || unit.status !== "claimed" || input.attempt.status !== "created")) fail("delegation.parent_not_running");
  const runnerId = unit.effectiveRunnerId ?? unit.runnerId;
  if (!runnerId) fail("delegation.authority_invalid");
  if (runnerId !== "pi" && (state.features.rootBudget?.tokenBudget !== undefined || state.features.rootBudget?.costBudgetMicros !== undefined)) {
    fail("delegation.native_budget_gate_unavailable");
  }
  const providerScope = runtimeObservationScopeForProvider(input.store, input.originalProvider);
  if (!providerScope) fail("delegation.provider_authority_unavailable");
  const identity = providerRuntimeScopeIdentity(providerScope);
  const preset = providerPresetForRuntimeObservationScope(providerScope);
  if (!identity || !preset || !input.originalProvider.baseUrl || !input.originalProvider.api) fail("delegation.provider_authority_unavailable");
  const policyIntent: PolicyIntent = { authorizationMode: input.request.authorizationMode,
    workspaceAccessMode: input.request.workspaceAccessMode, permissionMode: input.request.permissionMode, permissionPreset: input.request.permissionPreset };
  const tools = Object.freeze([...(input.runtimeTools ?? builtinTools)]);
  const historical = existing ? readHistoricalCapture(input.store, existing) : undefined;
  const provider = { providerId: input.originalProvider.provider, baseUrl: input.originalProvider.baseUrl,
    api: input.originalProvider.api, model: input.originalProvider.model };
  const price = existing ? historical?.price : createDelegationPriceRegistry(state.features.prices ?? []).lookup(provider, state.features.currency ?? "USD");
  const provisional: AdmissionFact = { rootRunId: run.id, runId: run.id, provider: input.originalProvider, providerScope, policyIntent,
    approvalProfile: input.approvalProfile ? structuredClone(input.approvalProfile) : undefined, tools,
    requestedSkillId: input.request.requestedSkillId,
    teammateRevision: teammateAuthorityRevision(input.store, run.teammateId),
    dynamicSurfaceVerified: input.hasAdditionalToolSurfaces !== true && tools.every(tool => (builtinTools as readonly string[]).includes(tool)),
    authority: historical?.authority ?? {} as DelegationExecutionAuthority,
    capture: historical ?? {} as DelegationAuthorityCapture };
  const old = state.facts.get(run.id);
  state.facts.set(run.id, provisional);
  try {
    const policy = currentPolicy(state, run, provisional);
    if (!isDeepStrictEqual(policy, input.effectivePolicySnapshot)) fail("delegation.policy_changed");
    const current = buildAuthority(state, run, fence, provisional, policy,
      historical?.authority.authoritySetId ?? `delegation_authority_${randomUUID()}`);
    if (historical) assertDelegationAuthoritySubset(current, historical.authority);
    const authority = historical?.authority ?? current;
    const capture = delegationCapture({ rootRunId: run.id, runId: run.id, sourceFence: fence, authority,
      budget: historical?.budget ?? state.features.rootBudget, price, currency: historical?.currency ?? state.features.currency ?? "USD",
      provider, runnerId });
    const fact = { ...provisional, authority, capture };
    state.facts.set(run.id, fact);
    if (existing) return existing; // Never replace the frozen budget or extend its deadline on a new Attempt.
    return state.writer().freezeRootDelegationBudget({ runId: run.id, sourceFence: fence,
      capture: state.host.captureRoot(run.id, fence), now });
  } catch (error) {
    if (old) state.facts.set(run.id, old); else state.facts.delete(run.id);
    throw error;
  }
}

/**
 * Rebind a stopped root from durable Host input and today's actual resolver.
 * Nothing supplied by a route/model can stand in for the current Provider or
 * policy; the receiver exists only during Core's synchronous activation lock.
 */
export function activateOriginalRootRunSuspension(input: {
  readonly store: RunStore;
  readonly supervisor: RuntimeSupervisor;
  readonly activation: ActivateRootRunSuspensionInput;
}): ActivateRootRunSuspensionResult {
  const state = compositions.get(input.store);
  if (!state || state.supervisor !== input.supervisor) fail("delegation.authority_invalid");
  assertOriginal(state);
  const writer = state.writer(), sourceFence = delegationFence(input.activation.sourceFence);
  const suspension = writer.getRunSuspension(input.activation.suspensionId);
  if (!suspension) fail("delegation.source_attempt_stale");
  const runId = suspension.request.runId;
  // A consumed record is audit-only. Core must never return dispatch custody
  // again, including after a crash between activation and the actual SDK ACK.
  if (writer.getRootRunSuspensionActivation(input.activation.suspensionId)) {
    return writer.activateRootRunSuspension(input.activation);
  }
  const assertStoppedSource = (): RunSession => {
    requiredStore(state);
    const run = input.store.getRun(runId), unit = input.store.getWorkUnit(sourceFence.workUnitId);
    const attempt = input.store.getWorkUnitAttempt(sourceFence.attemptId);
    const stop = writer.getRunSuspensionStop(input.activation.suspensionId);
    if (!run || run.parentRunId || run.endedAt || run.status !== "running"
      || !unit || unit.linkedRunId !== run.id || run.workUnitId !== unit.id || unit.status !== "stale"
      || unit.activeAttemptId !== sourceFence.attemptId || !attempt || attempt.status !== "lost"
      || attempt.errorCode !== "runtime_graceful_suspend" || !isDeepStrictEqual(toRuntimeAttemptFence(attempt), sourceFence)
      || suspension.state !== "sealed" || !isDeepStrictEqual(suspension.request.sourceFence, sourceFence)
      || stop?.state !== "stopped" || stop.begin.source.kind !== "root"
      || !isDeepStrictEqual(stop.begin.sourceFence, sourceFence) || stop.receiptDigest !== input.activation.expectedReceiptDigest) {
      fail("delegation.source_attempt_stale");
    }
    return run;
  };
  const run = assertStoppedSource(), request = rebuildExistingRunRequest(run, "daemon_recovery");
  const execution = readStoredRunnerExecution(run);
  if (!execution || execution.runnerId !== "pi") fail("delegation.preparation_unavailable");
  const provider = resolveProviderForRun(input.store, request, state.secretResolver, {
    providerWebSocketFallbackEnabled: state.supervisor.getTransportFeatures().providerWebSocketFallback,
  });
  const descriptor = JSON.parse(JSON.stringify(inlineProviderDescriptor(provider))) as unknown;
  if (!isDeepStrictEqual(execution.input.provider, descriptor)) fail("delegation.provider_revoked");
  const providerScope = runtimeObservationScopeForProvider(input.store, provider);
  if (run.providerPresetId && !providerScope) fail("delegation.provider_authority_unavailable");
  const root = writer.getRootDelegationBudget(run.id);
  if (root && state.features.mode === "off") fail("delegation.dynamic_gate_unavailable");
  const historical = root ? readHistoricalCapture(input.store, root) : undefined;
  // An inline source cannot invent the persistent Provider scope required by
  // an existing delegated tree. Anonymous ordinary Runs have no such budget.
  if (historical && !providerScope) fail("delegation.provider_authority_unavailable");
  const tools = Object.freeze([...(execution.input.tools ?? builtinTools)]);
  const authoritySetId = historical?.authority.authoritySetId ?? `suspension_authority_${randomUUID()}`;
  const read = (): DelegationExecutionAuthority => {
    const currentRun = assertStoppedSource();
    if (!isDeepStrictEqual(currentRun.requestSnapshot, run.requestSnapshot)) fail("delegation.source_attempt_stale");
    const { policySnapshot } = captureRunProgressCheckpointLineage(input.store, currentRun);
    if (providerScope) {
      const fact: AdmissionFact = { rootRunId: run.id, runId: run.id, provider, providerScope, tools,
        policyIntent: request, requestedSkillId: request.requestedSkillId,
        teammateRevision: teammateAuthorityRevision(input.store, run.teammateId), dynamicSurfaceVerified: false,
        authority: historical?.authority ?? {} as DelegationExecutionAuthority,
        capture: historical ?? {} as DelegationAuthorityCapture };
      return requireFrozenSuspensionTools(buildAuthority(state, currentRun, sourceFence, fact, policySnapshot, authoritySetId), tools);
    }
    return requireFrozenSuspensionTools(buildScopeAuthority(state, currentRun, sourceFence, { provider, tools }, policySnapshot,
      authoritySetId, { inline: descriptor }, []), tools);
  };
  if (state.recoveryAuthorities.has(run.id)) fail("delegation.recovery_required");
  state.recoveryAuthorities.set(run.id, { fence: sourceFence, read });
  try { return writer.activateRootRunSuspension(input.activation); }
  finally { state.recoveryAuthorities.delete(run.id); }
}

/** Child source authority is reconstructed separately; it never becomes a live admission fact. */
export function activateOriginalDelegatedRunSuspension(input: {
  readonly store: RunStore;
  readonly supervisor: RuntimeSupervisor;
  readonly activation: Parameters<DelegationHostWriter["activateDelegatedRunSuspension"]>[0];
}): ReturnType<DelegationHostWriter["activateDelegatedRunSuspension"]> {
  const state = compositions.get(input.store);
  if (!state || state.supervisor !== input.supervisor || !state.dispatch || state.features.mode === "off") fail("delegation.authority_invalid");
  assertOriginal(state); requiredStore(state);
  const writer = state.writer(), sourceFence = delegationFence(input.activation.sourceFence);
  if (writer.getDelegatedRunSuspensionActivation(input.activation.suspensionId)) {
    return writer.activateDelegatedRunSuspension(input.activation); // Audit only; no receiver or dispatch grant.
  }
  const suspension = writer.getRunSuspension(input.activation.suspensionId);
  if (!suspension?.seal) fail("delegation.recovery_required");
  const assertStoppedSource = (): RunSession => {
    requiredStore(state);
    const run = input.store.getRun(suspension.request.runId), unit = input.store.getWorkUnit(sourceFence.workUnitId);
    const attempt = input.store.getWorkUnitAttempt(sourceFence.attemptId), stop = writer.getRunSuspensionStop(suspension.id);
    if (!run || !run.parentRunId || run.status !== "running" || run.endedAt || run.workUnitId !== sourceFence.workUnitId
      || !unit || unit.ownerType !== "delegation_step" || unit.linkedRunId !== run.id || unit.status !== "cancelled"
      || unit.activeAttemptId !== sourceFence.attemptId || !attempt || attempt.status !== "cancelled"
      || attempt.errorCode !== "delegation_interrupted" || !attempt.endedAt || !attempt.abortRequestedAt
      || !isDeepStrictEqual(toRuntimeAttemptFence(attempt), sourceFence) || suspension.state !== "sealed"
      || !isDeepStrictEqual(suspension.request.sourceFence, sourceFence) || stop?.state !== "stopped"
      || stop.begin.source.kind !== "delegated" || stop.begin.source.parentRunId !== run.parentRunId
      || stop.begin.source.stepId !== unit.ownerId || stop.receiptDigest !== input.activation.expectedReceiptDigest
      || !isDeepStrictEqual(stop.begin.sourceFence, sourceFence)) fail("delegation.source_attempt_stale");
    return run;
  };
  const run = assertStoppedSource(), request = rebuildExistingRunRequest(run, "daemon_recovery");
  const execution = readStoredRunnerExecution(run), pinned = readChildPinnedCapture(input.store, run);
  if (!execution || execution.runnerId !== "pi") fail("delegation.preparation_unavailable");
  const provider = resolveProviderForRun(input.store, request, state.secretResolver, {
    providerWebSocketFallbackEnabled: state.supervisor.getTransportFeatures().providerWebSocketFallback,
  });
  if (!isDeepStrictEqual(JSON.parse(JSON.stringify(inlineProviderDescriptor(provider))), execution.input.provider)) fail("delegation.provider_revoked");
  const providerScope = runtimeObservationScopeForProvider(input.store, provider);
  if (!providerScope) fail("delegation.provider_authority_unavailable");
  const tools = Object.freeze([...(execution.input.tools ?? builtinTools)]);
  const read = (): DelegationExecutionAuthority => {
    const currentRun = assertStoppedSource();
    if (!isDeepStrictEqual(currentRun.requestSnapshot, run.requestSnapshot)) fail("delegation.source_attempt_stale");
    const parent = currentAuthority(state, run.parentRunId!, input.activation.parentFence);
    assertDelegationAuthoritySubset(parent, pinned.authority);
    const { policySnapshot } = captureRunProgressCheckpointLineage(input.store, currentRun);
    const fact: AdmissionFact = { rootRunId: pinned.rootRunId, runId: run.id, provider, providerScope, tools,
      policyIntent: request, requestedSkillId: request.requestedSkillId,
      teammateRevision: teammateAuthorityRevision(input.store, run.teammateId), dynamicSurfaceVerified: false,
      authority: pinned.authority, capture: pinned };
    const authority = requireFrozenSuspensionTools(buildAuthority(state, currentRun, sourceFence, fact, policySnapshot,
      pinned.authority.authoritySetId), tools);
    assertDelegationAuthoritySubset(authority, pinned.authority);
    assertDelegationAuthoritySubset(pinned.authority, authority);
    return authority;
  };
  if (state.delegatedRecoveryAuthorities.has(run.id)) fail("delegation.recovery_required");
  state.delegatedRecoveryAuthorities.set(run.id, { fence: sourceFence, read });
  try { return writer.activateDelegatedRunSuspension(input.activation); }
  finally { state.delegatedRecoveryAuthorities.delete(run.id); }
}

/** Internal audit lookup. An existing activation never regrants a dispatch claim. */
export function readOriginalRootRunSuspensionActivation(store: RunStore, supervisor: RuntimeSupervisor,
  query: Parameters<DelegationHostWriter["getRootRunSuspensionActivation"]>[0]) {
  const state = compositions.get(store);
  if (!state || state.supervisor !== supervisor) fail("delegation.authority_invalid");
  assertOriginal(state); requiredStore(state);
  return state.writer().getRootRunSuspensionActivation(query);
}

/** SDK callback-only start authority, separate from the old stopped-source receiver and live admission. */
export function withOriginalRootRunSuspensionReceiver(input: Omit<
  Parameters<ReturnType<typeof createRootSuspensionDispatchAuthority>["withReceiver"]>[0], "onAccepted"> & {
    readonly supervisor: RuntimeSupervisor;
    readonly beforeAccepted?: () => void;
    readonly onAccepted: (result: Extract<ReturnType<DelegationHostWriter["acknowledgeRootRunSuspensionStart"]>,
      { kind: "started" }>, at: string) => void | Promise<void>;
  }) {
  const state = compositions.get(input.store);
  if (!state || state.supervisor !== input.supervisor) fail("delegation.authority_invalid");
  assertOriginal(state); requiredStore(state);
  const writer = state.writer(), saved = writer.getRootRunSuspensionActivation(input.record.activation.suspensionId);
  if (!saved || !isDeepStrictEqual(saved, input.record)) fail("delegation.persisted_fact_invalid");
  const { activation } = saved, fence = activation.targetFence;
  const run = input.store.getRun(activation.runId);
  if (!run) fail("delegation.source_attempt_stale");
  const request = rebuildExistingRunRequest(run, "daemon_recovery"), execution = readStoredRunnerExecution(run);
  if (!execution || execution.runnerId !== "pi") fail("delegation.preparation_unavailable");
  const originalScope = runtimeObservationScopeForProvider(input.store, input.options.provider);
  if (run.providerPresetId && !originalScope) fail("delegation.provider_authority_unavailable");
  const root = writer.getRootDelegationBudget(run.id), historical = root ? readHistoricalCapture(input.store, root) : undefined;
  if (root && state.features.mode === "off") fail("delegation.dynamic_gate_unavailable");
  if (historical && !originalScope) fail("delegation.provider_authority_unavailable");
  const authoritySetId = historical?.authority.authoritySetId ?? `suspension_start_authority_${randomUUID()}`;
  const tools = Object.freeze([...(execution.input.tools ?? builtinTools)]);
  const read = (): DelegationExecutionAuthority => {
    requiredStore(state);
    const currentRun = input.store.getRun(run.id), unit = input.store.getWorkUnit(fence.workUnitId);
    const attempt = input.store.getWorkUnitAttempt(fence.attemptId);
    if (!currentRun || currentRun.parentRunId || currentRun.status !== "running" || currentRun.endedAt
      || !isDeepStrictEqual(currentRun.requestSnapshot, run.requestSnapshot)
      || !unit || unit.linkedRunId !== run.id || unit.status !== "claimed" || unit.activeAttemptId !== fence.attemptId
      || !attempt || attempt.status !== "created" || attempt.endedAt || attempt.abortRequestedAt
      || !isDeepStrictEqual(toRuntimeAttemptFence(attempt), fence)) fail("delegation.source_attempt_stale");
    const provider = resolveProviderForRun(input.store, request, state.secretResolver, {
      providerWebSocketFallbackEnabled: state.supervisor.getTransportFeatures().providerWebSocketFallback,
    });
    const descriptor = JSON.parse(JSON.stringify(inlineProviderDescriptor(provider))) as unknown;
    if (!isDeepStrictEqual(descriptor, execution.input.provider)
      || !isDeepStrictEqual(descriptor, JSON.parse(JSON.stringify(inlineProviderDescriptor(input.options.provider))))) fail("delegation.provider_revoked");
    const { policySnapshot } = captureRunProgressCheckpointLineage(input.store, currentRun);
    if (originalScope) {
      const fact: AdmissionFact = { rootRunId: run.id, runId: run.id, provider, providerScope: originalScope, tools,
        policyIntent: request, requestedSkillId: request.requestedSkillId,
        teammateRevision: teammateAuthorityRevision(input.store, run.teammateId), dynamicSurfaceVerified: false,
        authority: historical?.authority ?? {} as DelegationExecutionAuthority,
        capture: historical ?? {} as DelegationAuthorityCapture };
      return requireFrozenSuspensionTools(buildAuthority(state, currentRun, fence, fact, policySnapshot, authoritySetId), tools);
    }
    return requireFrozenSuspensionTools(buildScopeAuthority(state, currentRun, fence, { provider, tools }, policySnapshot, authoritySetId, { inline: descriptor }, []), tools);
  };
  return state.rootDispatch.withReceiver({ ...input, onAccepted: async (reference, at) => {
    input.options.signal?.throwIfAborted();
    input.beforeAccepted?.();
    if (state.startAuthorities.has(run.id)) fail("delegation.recovery_required");
    state.startAuthorities.set(run.id, { fence, read });
    let result: ReturnType<DelegationHostWriter["acknowledgeRootRunSuspensionStart"]>;
    try {
      result = writer.acknowledgeRootRunSuspensionStart({ suspensionId: activation.suspensionId, targetFence: fence,
        claimOwner: input.execution.claimOwner, claimToken: input.execution.claimToken,
        expectedRevision: input.execution.continuation.revision, observationRef: reference, now: at });
    } finally { state.startAuthorities.delete(run.id); }
    if (result.kind !== "started") fail("suspension_start.already_received");
    await input.onAccepted(result, at);
  } });
}

/** Narrow internal port, not an accessor for the underlying writer or receipt issuer. */
export interface OriginalDelegationProviderBinding {
  readonly root: DelegationRootBudgetRecord;
  readonly price?: DelegationTokenPriceSnapshot;
  readonly reserve: (invocationId: string, tokens: number | undefined, cost: number | undefined, now: string) => { readonly id: string };
  readonly settle: (chargeId: string, usage: Omit<DelegationUsageReceipt, "runId" | "attemptId" | "invocationId">, invocationId: string, now: string) => void;
}
export function captureOriginalDelegationProviderBinding(input: {
  readonly store: RunStore; readonly run: RunSession; readonly attempt: WorkUnitAttempt; readonly originalProvider: PiRunnerProviderConfig;
}): OriginalDelegationProviderBinding | undefined {
  const state = compositions.get(input.store);
  if (!state) fail("delegation.store_composition_unavailable");
  if (state.features.mode === "off") return undefined;
  const fence = toRuntimeAttemptFence(input.attempt), fact = exactFact(state, input.run.id, fence);
  if (fact.provider !== input.originalProvider) fail("delegation.provider_authority_unavailable");
  const root = state.writer().getRootDelegationBudget(fact.rootRunId);
  if (!root) fail("delegation.root_budget_missing");
  return Object.freeze({ root, price: fact.capture.price,
    reserve(invocationId: string, tokens: number | undefined, cost: number | undefined, now: string) {
      currentAuthority(state, input.run.id, fence);
      const capture = state.host.captureModelInvocation(input.run.id, fence);
      return state.writer().reserveModelInvocation({ runId: input.run.id, sourceFence: fence, invocationId,
        reservedTokens: tokens, reservedCostMicros: cost, capture, now });
    },
    settle(chargeId: string, usage: Omit<DelegationUsageReceipt, "runId" | "attemptId" | "invocationId">, invocationId: string, now: string) {
      // A terminal receipt belongs to its original Attempt even if policy was subsequently revoked.
      assertOriginal(state);
      const reference = Object.freeze({});
      state.usages.set(reference, { ...usage, runId: input.run.id, attemptId: input.attempt.id, invocationId });
      state.writer().settleModelInvocation({ chargeId, receipt: state.host.captureUsageReceipt(reference), now });
    },
  });
}

function assertOriginal(state: Composition): void {
  if (!isOriginalRuntimeSupervisorOfficeRoot(state.supervisor)) fail("delegation.authority_invalid");
  state.writer(); // Also checks close/retirement of the exact owning Store.
}
function requiredStore(state: Composition): RunStore { assertOriginal(state); if (!state.store) fail("delegation.authority_invalid"); return state.store; }
function assertOwner(store: RunStore, runId: string, rawFence: RuntimeAttemptFenceV1): void {
  const fence = delegationFence(rawFence), run = store.getRun(runId), unit = store.getWorkUnit(fence.workUnitId);
  const attempt = store.getWorkUnitAttempt(fence.attemptId);
  if (!run || !unit || !attempt || run.workUnitId !== unit.id || unit.linkedRunId !== run.id
    || unit.activeAttemptId !== attempt.id || attempt.workUnitId !== unit.id
    || attempt.runtimeInstanceId !== fence.runtimeInstanceId || attempt.fencingToken !== fence.fencingToken
    || attempt.abortRequestedAt || attempt.endedAt || unit.endedAt || run.endedAt) {
    fail("delegation.source_attempt_stale");
  }
}
function exactFact(state: Composition, runId: string, fence: RuntimeAttemptFenceV1): AdmissionFact {
  const store = requiredStore(state);
  assertOwner(store, runId, fence);
  const ancestry = resolveRunAncestry({ getRun: id => store.getRun(id), getWorkspaceId: run => run.workUnitId ? store.getWorkUnit(run.workUnitId)?.workspaceId : undefined }, { leafRunId: runId });
  const fact = state.facts.get(runId);
  if (!fact || fact.runId !== runId || fact.rootRunId !== ancestry.rootRunId
    || delegationDigest(fact.capture.sourceFence) !== delegationDigest(fence)) fail("delegation.run_admission_missing");
  return fact;
}
function currentPolicy(state: Composition, run: RunSession, fact: AdmissionFact): EffectiveRunPolicySnapshot {
  const store = requiredStore(state), channel = run.channelId ? store.getChannel(run.channelId) : undefined;
  if (run.channelId && (!channel || channel.status !== "active")) fail("delegation.authority_invalid");
  const thread = run.threadId ? store.getLingThread(run.threadId) : undefined;
  if (!thread) fail("delegation.authority_invalid");
  const teammate = run.teammateId ? store.getAiTeammate(run.teammateId) : undefined;
  if (run.teammateId && (!teammate || teammate.status !== "active" || teammate.hidden)) fail("delegation.participant_revoked");
  // The original profile includes request/skill composition. Do not replace it
  // with a looser teammate profile, nor let a changed profile silently reuse it.
  if (teammate && teammateAuthorityRevision(store, teammate.id) !== fact.teammateRevision) fail("delegation.participant_profile_changed");
  const skill = resolveCurrentRunSkill(store, { teammateId: run.teammateId, requestedSkillId: fact.requestedSkillId,
    providerPresetId: providerRuntimeScopeIdentity(fact.providerScope)?.providerPresetId, task: { channelId: run.channelId } });
  const profile = skill ? mergeApprovalProfiles(fact.approvalProfile, skill.skill.approvalProfile) : fact.approvalProfile;
  return applyConversationModeToEffectiveRunPolicySnapshot(resolveSessionRunPolicy({ workspacePolicy: store.getApprovalPolicy(),
    ...fact.policyIntent, channelBoundPath: channel?.boundPath || run.cwd,
    approvalProfile: profile }).snapshot, thread.conversationMode.mode);
}
function currentAuthority(state: Composition, runId: string, fence: RuntimeAttemptFenceV1): DelegationExecutionAuthority {
  const store = requiredStore(state);
  assertOwner(store, runId, fence);
  const run = store.getRun(runId)!;
  // Claiming precedes the child's actual Provider preflight. This is a static
  // parent-scope revocation check only, never a child Provider admission fact.
  // Model invocation still requires exactFact(child) and its own D1 original.
  const ownFact = state.facts.get(runId);
  if ((!ownFact || delegationDigest(ownFact.capture.sourceFence) !== delegationDigest(fence)) && run.parentRunId
    && store.getWorkUnitAttempt(fence.attemptId)?.status === "created") return currentChildClaimAuthority(state, run, fence);
  const fact = exactFact(state, runId, fence);
  return buildAuthority(state, run, fence, fact, currentPolicy(state, run, fact), fact.authority.authoritySetId);
}

function currentChildClaimAuthority(state: Composition, run: RunSession, fence: RuntimeAttemptFenceV1): DelegationExecutionAuthority {
  const store = requiredStore(state), parentFact = run.parentRunId ? state.facts.get(run.parentRunId) : undefined;
  if (!parentFact) fail("delegation.parent_admission_missing");
  const parent = exactFact(state, run.parentRunId!, parentFact.capture.sourceFence);
  const pinned = readChildPinnedCapture(store, run);
  if (pinned.rootRunId !== parent.rootRunId) fail("delegation.lineage_invalid");
  const parentCurrent = currentAuthority(state, parent.runId, parent.capture.sourceFence);
  assertDelegationAuthoritySubset(parentCurrent, pinned.authority);
  const teammate = run.teammateId ? store.getAiTeammate(run.teammateId) : undefined;
  const provisional: AdmissionFact = { ...parent, runId: run.id, tools: pinned.authority.tools,
    authority: pinned.authority, capture: { ...pinned, runId: run.id, sourceFence: fence },
    approvalProfile: teammate ? mergeApprovalProfiles(parent.approvalProfile, teammate.approvalProfile) : parent.approvalProfile,
    teammateRevision: teammateAuthorityRevision(store, run.teammateId) };
  const current = buildAuthority(state, run, fence, provisional, currentPolicy(state, run, provisional), pinned.authority.authoritySetId);
  assertDelegationAuthoritySubset(current, pinned.authority);
  return current;
}

function readChildPinnedCapture(store: RunStore, run: RunSession): DelegationAuthorityCapture {
  const unit = run.workUnitId ? store.getWorkUnit(run.workUnitId) : undefined;
  const step = unit?.ownerType === "delegation_step" ? store.getDelegationStep(unit.ownerId) : undefined;
  if (!unit || !step || !run.parentRunId || step.parentRunId !== run.parentRunId
    || unit.linkedRunId !== run.id || step.childRunId !== undefined && step.childRunId !== run.id) fail("delegation.lineage_invalid");
  const payload = readPinnedValue(store, step.permissionSnapshotArtifactId, step.parentRunId) as { readonly kind?: unknown; readonly capture?: unknown };
  if (payload?.kind !== "delegation.authority.v1") fail("delegation.persisted_fact_invalid");
  const capture = delegationCapture(payload.capture), a = capture.authority;
  if (capture.runId !== step.parentRunId || capture.rootRunId !== step.rootRunId
    || a.workspaceId !== unit.workspaceId || a.channelId !== run.channelId || a.workflowStepId !== run.workflowStepId
    || a.participantId !== run.teammateId) fail("delegation.lineage_invalid");
  const identity = { authoritySetId: a.authoritySetId, sourceRevision: a.sourceRevision };
  const expected = [
    [step.toolAllowlistArtifactId, { kind: "delegation.tools.v1", ...identity, tools: a.tools, toolDecisions: a.toolDecisions }],
    [step.workspaceScopeArtifactId, { kind: "delegation.workspace.v1", ...identity, workspaceId: a.workspaceId, roots: a.workspaceRoots }],
    [step.providerPolicyArtifactId, { kind: "delegation.provider.v1", ...identity, providers: a.providers, networkScopes: a.networkScopes, secretRefs: a.secretRefs }],
  ] as const;
  if (expected.some(([id, value]) => delegationDigest(readPinnedValue(store, id, step.parentRunId)) !== delegationDigest(value))) {
    fail("delegation.persisted_fact_invalid");
  }
  return capture;
}
function readPinnedValue(store: RunStore, id: string, owner: string): unknown {
  const artifact = store.getArtifact(id);
  if (!artifact || artifact.runId !== owner || artifact.sealedPayload === undefined
    || !artifact.contentSha256 || delegationDigest(artifact.sealedPayload) !== artifact.contentSha256) fail("delegation.persisted_fact_invalid");
  return artifact.sealedPayload;
}
function teammateAuthorityRevision(store: RunStore, id: string | undefined): string | undefined {
  const teammate = id ? store.getAiTeammate(id) : undefined;
  return teammate ? delegationDigest({ id: teammate.id, updatedAt: teammate.updatedAt, status: teammate.status,
    hidden: teammate.hidden, allowedTools: teammate.allowedTools, approvalProfile: teammate.approvalProfile,
    runnerId: teammate.runnerId, providerPresetId: teammate.providerPresetId, modelBindingMode: teammate.modelBindingMode }) : undefined;
}
function buildAuthority(state: Composition, run: RunSession, fence: RuntimeAttemptFenceV1, fact: AdmissionFact,
  policy: EffectiveRunPolicySnapshot, authoritySetId: string): DelegationExecutionAuthority {
  const store = requiredStore(state), unit = store.getWorkUnit(fence.workUnitId)!;
  const comparison = compareProviderRuntimeObservationScope({ store, scope: fact.providerScope, secretResolver: state.secretResolver });
  if (comparison.state !== "managed_generation_match" && comparison.state !== "sampled_value_match") fail("delegation.provider_revoked");
  const preset = providerPresetForRuntimeObservationScope(fact.providerScope)!;
  const identity = providerRuntimeScopeIdentity(fact.providerScope)!;
  if (!preset.enabled || run.providerName !== fact.provider.provider || run.providerModel !== fact.provider.model) fail("delegation.provider_revoked");
  return buildScopeAuthority(state, run, fence, fact, policy, authoritySetId, identity,
    [...new Set([...(preset.apiKeyRef ? [preset.apiKeyRef] : []), ...Object.values(preset.secretHeaderRefs)]
      .map(ref => ref.startsWith("local:") ? `managed:provider/${ref.slice("local:".length)}` : ref))]);
}
/** Common scope projection; Provider provenance is checked by its owning caller. */
function buildScopeAuthority(state: Composition, run: RunSession, fence: RuntimeAttemptFenceV1,
  fact: Pick<AdmissionFact, "provider" | "tools">, policy: EffectiveRunPolicySnapshot,
  authoritySetId: string, providerIdentity: unknown, secretRefs: readonly string[]): DelegationExecutionAuthority {
  const store = requiredStore(state), unit = store.getWorkUnit(fence.workUnitId)!;
  const runtime = loadWorkspaceRuntimeSettings(store, state.runnerRegistry);
  const runnerId = unit.effectiveRunnerId ?? unit.runnerId!;
  state.runnerRegistry.resolve({ requestedRunnerId: runnerId, allowFallback: false, allowedRunnerIds: runtime.allowedRunnerIds,
    providerApi: fact.provider.api, tools: fact.tools, requestSource: "product_default" });
  const channel = run.channelId ? store.getChannel(run.channelId) : undefined;
  const step = run.workflowStepId ? store.getChannelWorkflowStep(run.workflowStepId) : undefined;
  const workflow = step ? store.getChannelWorkflow(step.workflowId) : undefined;
  if (run.workflowStepId && (!step || !workflow || step.channelId !== run.channelId || step.workspaceId !== unit.workspaceId)) fail("delegation.workflow_lineage_invalid");
  const manifest = workflow?.metadata?.requiredParticipantManifest;
  if (manifest) {
    const decision = workflow?.metadata?.sourceIntentDecisionId ? store.getChannelIntentDecision(workflow.metadata.sourceIntentDecisionId) : undefined;
    if (!decision || !isDeepStrictEqual(decision.participantManifest, manifest)) fail("delegation.authority_invalid");
  }
  const selected = manifest?.participants.map(participant => participant.participantId) ?? (run.teammateId ? [run.teammateId] : []);
  const participantIds = selected.filter(id => {
    const teammate = store.getAiTeammate(id);
    return teammate?.status === "active" && !teammate.hidden && (!channel || teammateCanWorkInEffectiveChannel(store, channel, id));
  });
  const teammate = run.teammateId ? store.getAiTeammate(run.teammateId) : undefined;
  if (run.teammateId && !participantIds.includes(run.teammateId)) fail("delegation.participant_revoked");
  const tools = fact.tools.filter((tool): tool is typeof builtinTools[number] => (builtinTools as readonly string[]).includes(tool))
    .filter(tool => (!teammate || teammate.allowedTools.includes(tool)) && (!channel || channel.allowedTools.includes(tool)));
  const planMode = policy.conversationMode === "plan" || policy.planModeMutationPolicy === "deny_repo_tracked_mutation";
  const access = policy.workspaceAccessMode ?? authorizationAndAccessFromLegacyPermission(policy.mode, undefined).workspaceAccessMode;
  const roots = new Map<string, "read" | "write">([[realpathSync.native(store.paths.cwd), "read"]]);
  if (access !== "read_only" && !planMode) for (const path of policy.allowedWritePaths) {
    roots.set(realpathSync.native(isAbsolute(path) ? path : resolve(store.paths.cwd, path)), "write");
  }
  return { schemaVersion: 1, authoritySetId,
    sourceRevision: delegationDigest({ policy, runtime, providerIdentity, participants: participantIds,
      tools, roots: [...roots], channelRevision: channel?.updatedAt, teammateRevision: teammate?.updatedAt }),
    workspaceId: unit.workspaceId, channelId: run.channelId, workflowId: step?.workflowId, workflowStepId: run.workflowStepId,
    ...(run.teammateId ? { participantId: run.teammateId } : {}), participantIds, runnerIds: [runnerId], maxDepth: state.features.maxDepth,
    sandbox: access, mayEscalate: false, tools,
    toolDecisions: Object.fromEntries(tools.map(tool => [tool, planMode && ["bash", "edit", "write"].includes(tool) ? "deny" : policy.toolDecisions[tool]])),
    workspaceRoots: [...roots].map(([path, rootAccess]) => ({ path, access: rootAccess })),
    providers: [{ providerId: fact.provider.provider, model: fact.provider.model, api: fact.provider.api!, baseUrl: fact.provider.baseUrl! }],
    networkScopes: [], secretRefs,
  };
}
/** The SDK resumes its frozen tools; a narrowed projection cannot authorize that old surface. */
function requireFrozenSuspensionTools(authority: DelegationExecutionAuthority, tools: readonly string[]): DelegationExecutionAuthority {
  if (tools.some(tool => !authority.tools.includes(tool))) {
    throw new HttpError(409, "delegation.tool_revoked", "The frozen recovery tool surface is no longer authorized.");
  }
  return authority;
}
function readHistoricalCapture(store: RunStore, root: DelegationRootBudgetRecord): DelegationAuthorityCapture {
  const artifact = store.getArtifact(root.authorityArtifactId), payload = artifact?.sealedPayload as { readonly kind?: unknown; readonly capture?: unknown } | undefined;
  if (!artifact || artifact.runId !== root.rootRunId || artifact.contentSha256 !== root.authorityDigest
    || delegationDigest(payload) !== root.authorityDigest || payload?.kind !== "delegation.authority.v1") fail("delegation.persisted_fact_invalid");
  const capture = delegationCapture(payload.capture);
  if (capture.rootRunId !== root.rootRunId || capture.runId !== root.rootRunId) fail("delegation.persisted_fact_invalid");
  return capture;
}
function fail(code: string): never { throw Object.assign(new Error(code), { code }); }
