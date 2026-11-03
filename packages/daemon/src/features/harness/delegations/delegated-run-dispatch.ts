import { isDeepStrictEqual } from "node:util";
import {
  delegationCapture, delegationDigest, delegationFence, delegationJson, delegationTimestamp, toRuntimeAttemptFence,
  delegationPreparedExecutionJson, delegationPreparedExecutionDigest,
  type ClaimedDelegatedChild, type DelegationPreparedExecution, type DelegationPreparedExecutionV1,
  type DelegationRunnerStartObservation, type EffectiveRunPolicySnapshot, type RunStore,
} from "@ling-stack/core";
import { PiRunnerAdapter, readPreparedPiInput, type PiRunnerRunOptions } from "@ling-stack/runner-pi";
import type { RunnerAdapter } from "../../../context.js";
import { HttpError } from "../../../errors.js";
import { rebuildExistingRunRequest, readStoredEffectivePolicySnapshot } from "../../runs/existing-run-request.js";
import { readPreparedRunnerInput, type PreparedRunnerInput } from "../../runs/prepared-runner-input.js";
import type { RunRequest } from "../../runs/schemas.js";
import { inlineProviderDescriptor } from "../../conversations/normal-conversation-prepared-provider.js";

type DispatchStore = Pick<RunStore, "getRun" | "getWorkUnit" | "getWorkUnitAttempt" | "getArtifact" | "getLingTurnForRun">;
const reject = (code = "delegation.authority_invalid"): never => { throw new HttpError(409, code, "Delegated execution has no current Host authority."); };
/**
 * Dynamic children cannot receive command execution until the Host can prove
 * escaped-descendant containment. A process-group close is not that proof on
 * macOS (a child can create a new session), so `bash` remains fail-closed.
 */
const delegatedTools = ["read", "edit", "write", "grep", "find", "ls"] as const;
const delegatedToolSet = new Set<string>(delegatedTools);

/**
 * A request for the existing child, never executeRunRequest/new Task admission.
 * Initial input comes only from frozen parent input and the child's sealed
 * objective/authority. Resume comes only from the original child preparation.
 */
export function rebuildDelegatedRunRequest(input: {
  readonly store: DispatchStore; readonly child: ClaimedDelegatedChild; readonly prepared?: DelegationPreparedExecution;
  readonly parentPrepared?: DelegationPreparedExecution;
}): RunRequest {
  const { child, store } = input;
  assertClaimedChild(store, child);
  if (input.prepared) {
    const plan = readDelegatedPreparation(store, child, input.prepared);
    const request = plan.payload.requestSnapshot as unknown as RunRequest;
    assertDelegatedToolSurface(request.tools);
    return { ...structuredClone(request), skipMemoryRecall: true,
      runnerExecutionInput: readPreparedRunnerInput(plan.payload.runnerExecutionInput, { cwd: child.run.cwd, task: request.task }) };
  }
  if (child.step.state !== "spawning" || child.attempt.attemptNumber !== 1) return reject("delegation.recovery_required");
  const parent = store.getRun(child.step.parentRunId);
  if (!parent) return reject("delegation.lineage_invalid");
  const original = input.parentPrepared
    ? readParentPreparedRequest(store, child, input.parentPrepared)
    : rebuildExistingRunRequest(parent, "daemon_recovery");
  if (original.executionBinding?.kind === "native_profile" || original.runnerId && original.runnerId !== "pi") return reject("delegation.native_execution_unsupported");
  const pinned = store.getArtifact(child.step.permissionSnapshotArtifactId);
  const payload = pinned?.sealedPayload as { kind?: unknown; capture?: unknown } | undefined;
  if (!pinned || pinned.runId !== parent.id || payload?.kind !== "delegation.authority.v1"
    || pinned.contentSha256 !== delegationDigest(payload)) return reject();
  const capture = delegationCapture(payload.capture);
  if (capture.runId !== parent.id || capture.rootRunId !== child.step.rootRunId
    || capture.sourceFence.attemptId !== child.step.parentAttemptId) return reject("delegation.lineage_invalid");
  const task = structuredClone(child.run.taskSnapshot) as RunRequest["task"];
  if (!task || task.id !== child.run.taskId || task.channelId !== child.run.channelId || typeof task.prompt !== "string") return reject("delegation.lineage_invalid");
  if (original.providerPresetId && child.run.providerPresetId !== original.providerPresetId) {
    // A missing frozen preset is not permission to substitute the current
    // workspace default or serialize the parent's plaintext credentials.
    return reject("delegation.provider_snapshot_incomplete");
  }
  const parentTurn = store.getLingTurnForRun(parent.id);
  return {
    cwd: child.run.cwd, workspaceCwd: original.workspaceCwd ?? child.run.cwd, task,
    providerPresetId: child.run.providerPresetId,
    provider: child.run.providerPresetId || !original.provider ? undefined : inlineProviderDescriptor(original.provider),
    executionBinding: original.executionBinding?.kind === "pi_provider" ? original.executionBinding : undefined,
    teammateId: child.run.teammateId, workflowStepId: child.run.workflowStepId, threadId: child.run.threadId,
    turnId: parentTurn?.id ?? original.turnId, parentRunId: child.step.parentRunId, runnerId: "pi",
    tools: (original.tools ?? delegatedTools).filter(tool => delegatedToolSet.has(tool)
      && capture.authority.tools.includes(tool) && capture.authority.toolDecisions[tool] !== "deny"),
    approvalProfile: original.approvalProfile, authorizationMode: original.authorizationMode, workspaceAccessMode: original.workspaceAccessMode,
    permissionPreset: original.permissionPreset, permissionMode: original.permissionMode, permissionConfirmation: original.permissionConfirmation,
    requestedSkillId: original.requestedSkillId, skillOptimizationMode: original.skillOptimizationMode,
    thinkingLevel: original.thinkingLevel, reasoningSummary: original.reasoningSummary,
    systemPrompt: original.systemPrompt, appendSystemPrompt: original.appendSystemPrompt,
    runtimeToolFeatures: original.runtimeToolFeatures, lingConversationTone: original.lingConversationTone,
    responseLanguage: original.responseLanguage, skipMemoryRecall: true, createdByActor: "system",
    idempotencyKey: `delegation-execution:${child.step.id}:${child.attempt.id}`,
    harnessFeatureSnapshot: original.harnessFeatureSnapshot,
  };
}

/**
 * Private composition-root custody for actual preflight and Pi session ACK.
 * It owns no Runner, Task, orchestration loop or database. The existing Run
 * orchestrator retains policy/tool enforcement, physical stop and Host drain.
 */
export interface DelegatedRunDispatchAuthority {
  readonly capturePreparation: (input: { readonly child: ClaimedDelegatedChild; readonly request: RunRequest;
    readonly execution: PreparedRunnerInput; readonly policy: EffectiveRunPolicySnapshot; readonly now: string }) => object;
  readonly readExecutionPreparation: (reference: unknown) => DelegationPreparedExecutionV1;
  readonly readRunnerStartObservation: (reference: unknown) => DelegationRunnerStartObservation;
  readonly withReceiver: (input: { readonly store: DispatchStore; readonly child: ClaimedDelegatedChild;
    readonly prepared: DelegationPreparedExecution; readonly adapter: RunnerAdapter; readonly options: PiRunnerRunOptions;
    readonly now?: () => string; readonly onAccepted: (startReference: object, acceptedAt: string) => void | Promise<void> }) => PiRunnerRunOptions;
}
const originalDispatchAuthorities = new WeakSet<DelegatedRunDispatchAuthority>();

/** Exact factory custody, not a structurally compatible pair of injected readers. */
export function readOriginalDelegatedRunDispatchAuthority(reference: unknown): DelegatedRunDispatchAuthority {
  if (!reference || typeof reference !== "object" || !originalDispatchAuthorities.has(reference as DelegatedRunDispatchAuthority)) return reject();
  return reference as DelegatedRunDispatchAuthority;
}

export function createDelegatedRunDispatchAuthority(): DelegatedRunDispatchAuthority {
  const preparations = new WeakMap<object, DelegationPreparedExecutionV1>();
  const starts = new WeakMap<object, DelegationRunnerStartObservation>();
  const read = <T>(map: WeakMap<object, T>, reference: unknown): T => {
    if (!reference || typeof reference !== "object" || !map.has(reference)) return reject();
    return structuredClone(map.get(reference)!);
  };
  const authority = Object.freeze({
    capturePreparation({ child, request, execution, policy, now }) {
      assertDelegatedToolSurface(request.tools);
      const frozen = readPreparedRunnerInput(execution, { cwd: child.run.cwd, task: request.task });
      if (frozen.runnerId !== "pi" || request.runnerId !== "pi" || request.executionBinding?.kind === "native_profile"
        || request.cwd !== child.run.cwd || !isDeepStrictEqual(json(request.task), child.run.taskSnapshot)
        || !readStoredEffectivePolicySnapshot({ effectivePolicySnapshot: policy })) return reject();
      const payload: DelegationPreparedExecutionV1 = { schemaVersion: 1, kind: "delegation.execution.v1",
        stepId: child.step.id, reservationId: child.reservation.id, rootRunId: child.step.rootRunId,
        parentRunId: child.step.parentRunId, childRunId: child.run.id, sourceFence: toRuntimeAttemptFence(child.attempt),
        runnerId: "pi", requestSnapshot: json({ ...request, runnerExecutionInput: undefined,
          provider: request.provider ? inlineProviderDescriptor(request.provider) : undefined }) as unknown as Record<string, unknown>,
        runnerExecutionInput: frozen as unknown as Record<string, unknown>, effectivePolicySnapshot: structuredClone(policy),
        preparedAt: delegationTimestamp(now) };
      const token = Object.freeze(Object.create(null) as object);
      // The data-only canonical serializer rejects functions/getters/Proxy and
      // snapshots mutable callers before any future asynchronous dispatch.
      preparations.set(token, JSON.parse(delegationPreparedExecutionJson(payload)) as DelegationPreparedExecutionV1);
      return token;
    },
    readExecutionPreparation: reference => read(preparations, reference),
    readRunnerStartObservation: reference => read(starts, reference),
    withReceiver(input) {
      const { child, options, store } = input;
      assertClaimedChild(store, child);
      if (!(input.adapter instanceof PiRunnerAdapter)) return reject("delegation.native_execution_unsupported");
      if (options.onPreparedInputAccepted !== undefined) return reject("delegation.receiver_conflict");
      const plan = readDelegatedPreparation(store, child, input.prepared);
      const task = plan.payload.requestSnapshot.task as RunRequest["task"];
      const execution = readPreparedRunnerInput(plan.payload.runnerExecutionInput, { cwd: child.run.cwd, task });
      const preparedInput = readPreparedPiInput(execution.preparedInput);
      if (options.cwd !== child.run.cwd || !isDeepStrictEqual(json(options.task), task)
        || options.provider.provider !== child.run.providerName || options.provider.model !== child.run.providerModel
        || !isDeepStrictEqual(json(inlineProviderDescriptor(options.provider)), execution.input.provider)
        || options.runId !== undefined && options.runId !== child.run.id
        || options.runnerAttemptId !== undefined && options.runnerAttemptId !== child.attempt.id
        || options.preparedInput !== undefined && readPreparedPiInput(options.preparedInput).fingerprint !== preparedInput.fingerprint) return reject();
      let accepted = false;
      return { ...options, runId: child.run.id, runnerAttemptId: child.attempt.id, preparedInput,
        async onPreparedInputAccepted(receipt, signal) {
          signal.throwIfAborted();
          if (accepted) return reject("delegation.already_received");
          assertClaimedChild(store, child);
          if (receipt.schemaVersion !== 1 || receipt.boundary !== "pi-session-ready" || receipt.runId !== child.run.id
            || receipt.attemptId !== child.attempt.id || receipt.taskId !== task.id
            || receipt.preparedInputFingerprint !== preparedInput.fingerprint) return reject();
          readDelegatedPreparation(store, child, plan);
          const at = delegationTimestamp(input.now?.() ?? new Date().toISOString());
          if (at >= child.reservation.deadlineAt) return reject("delegation.deadline_exceeded");
          const reference = Object.freeze(Object.create(null) as object);
          starts.set(reference, Object.freeze({ childRunId: child.run.id, sourceFence: toRuntimeAttemptFence(child.attempt),
            runnerId: "pi", observationId: `pi-session:${child.attempt.id}:${preparedInput.fingerprint}`, observedAt: at }));
          // ACK is attempted once. A failed/aborted callback cannot retry model
          // execution with the same physical session or manufacture a new start.
          accepted = true;
          await input.onAccepted(reference, at);
          signal.throwIfAborted();
        } };
    },
  } satisfies DelegatedRunDispatchAuthority);
  originalDispatchAuthorities.add(authority);
  return authority;
}

function assertClaimedChild(store: DispatchStore, child: ClaimedDelegatedChild): void {
  const run = store.getRun(child.run.id), unit = store.getWorkUnit(child.workUnit.id), attempt = store.getWorkUnitAttempt(child.attempt.id);
  if (!run || !unit || !attempt || !["queued", "running"].includes(run.status) || run.endedAt
    || unit.status !== "claimed" || unit.activeAttemptId !== attempt.id || unit.linkedRunId !== run.id
    || unit.ownerType !== "delegation_step" || unit.ownerId !== child.step.id || run.workUnitId !== unit.id
    || run.parentRunId !== child.step.parentRunId || attempt.status !== "created" || attempt.endedAt || attempt.abortRequestedAt
    || !isDeepStrictEqual(toRuntimeAttemptFence(attempt), toRuntimeAttemptFence(child.attempt))) return reject("delegation.source_attempt_stale");
}
function readDelegatedPreparation(store: DispatchStore, child: ClaimedDelegatedChild, plan: DelegationPreparedExecution): DelegationPreparedExecution {
  const artifact = store.getArtifact(plan.artifactId), payload = artifact?.sealedPayload as DelegationPreparedExecutionV1 | undefined;
  if (!artifact || artifact.runId !== child.run.id || artifact.path !== "sqlite:delegation-execution"
    || artifact.contentSha256 !== plan.digest || !payload || delegationPreparedExecutionDigest(payload) !== plan.digest
    || !isDeepStrictEqual(payload, plan.payload) || payload.childRunId !== child.run.id || payload.stepId !== child.step.id
    || payload.reservationId !== child.reservation.id || payload.rootRunId !== child.step.rootRunId
    || payload.parentRunId !== child.step.parentRunId || payload.runnerId !== "pi") return reject("delegation.preparation_changed");
  const fence = delegationFence(payload.sourceFence), original = store.getWorkUnitAttempt(fence.attemptId);
  if (fence.workUnitId !== child.workUnit.id || !original || original.attemptNumber !== 1
    || !isDeepStrictEqual(fence, toRuntimeAttemptFence(original))) return reject("delegation.preparation_changed");
  return { artifactId: artifact.id, digest: plan.digest, payload };
}
function readParentPreparedRequest(store: DispatchStore, child: ClaimedDelegatedChild, plan: DelegationPreparedExecution): RunRequest {
  const parent = store.getRun(child.step.parentRunId), artifact = store.getArtifact(plan.artifactId);
  const payload = artifact?.sealedPayload as DelegationPreparedExecutionV1 | undefined;
  if (!parent || !parent.parentRunId || !artifact || artifact.runId !== parent.id || artifact.path !== "sqlite:delegation-execution"
    || artifact.contentSha256 !== plan.digest || !payload || delegationPreparedExecutionDigest(payload) !== plan.digest
    || !isDeepStrictEqual(payload, plan.payload) || payload.childRunId !== parent.id
    || payload.rootRunId !== child.step.rootRunId || payload.parentRunId !== parent.parentRunId
    || payload.runnerId !== "pi" || payload.kind !== "delegation.execution.v1" || payload.schemaVersion !== 1) return reject("delegation.preparation_changed");
  const fence = delegationFence(payload.sourceFence), original = store.getWorkUnitAttempt(fence.attemptId);
  const request = payload.requestSnapshot as unknown as RunRequest;
  if (fence.workUnitId !== parent.workUnitId || !original || original.attemptNumber !== 1
    || !isDeepStrictEqual(fence, toRuntimeAttemptFence(original)) || request.cwd !== parent.cwd
    || request.providerPresetId !== parent.providerPresetId || !isDeepStrictEqual(json(request.task), parent.taskSnapshot)) return reject("delegation.preparation_changed");
  return structuredClone(request);
}
function json<T>(value: T): T { return JSON.parse(delegationJson(value)) as T; }
function assertDelegatedToolSurface(tools: readonly string[] | undefined): void {
  if ((tools ?? delegatedTools).some(tool => !delegatedToolSet.has(tool))) {
    reject("delegation.command_containment_unverified");
  }
}
