import {
  toRuntimeAttemptFence,
  type EffectiveRunPolicySnapshot,
  type RunSession,
  type RunStore,
  type SecretResolver,
} from "@ling-stack/core";
import type { PiRunnerProviderConfig } from "@ling-stack/runner-pi";
import type { RuntimeSupervisor } from "../../runtime/supervisor.js";
import { loadWorkspaceRuntimeSettings } from "../../runtime/runner-settings.js";
import { DEFAULT_RUNNER_ID, type RunnerRegistry } from "../../runtime/runners.js";
import { ApprovalResumeCoordinator } from "./approval-resume-coordinator.js";
import { reviewPendingApprovalAutomatically } from "./approval-auto-review-host.js";
import { appendApprovalDecisionEvent } from "./approvals.js";
import { resolveProviderForRun } from "./providers.js";

export interface ApprovalAutoReviewRecoveryResult {
  readonly reviewed: number;
  readonly approved: number;
  readonly denied: number;
  readonly manual: number;
  readonly skipped: number;
}

/**
 * Restores only approval reviews whose original execution was durably suspended
 * before the approved side effect started. Provider secrets are re-materialized
 * from the current preset and never read from the historical Run snapshot.
 */
export class ApprovalAutoReviewRecoveryCoordinator {
  private readonly recoveries = new WeakMap<RunStore, Promise<ApprovalAutoReviewRecoveryResult>>();

  constructor(private readonly options: {
    readonly runtimeSupervisor: RuntimeSupervisor;
    readonly runnerRegistry: RunnerRegistry;
    readonly secretResolver: SecretResolver;
    readonly approvalResumeCoordinator: ApprovalResumeCoordinator;
  }) {}

  registerStore(store: RunStore): void {
    void this.recoverStore(store).catch(() => undefined);
  }

  recoverStore(store: RunStore): Promise<ApprovalAutoReviewRecoveryResult> {
    const existing = this.recoveriesFor(store);
    if (existing) return existing;
    const recovery = this.runRecovery(store).finally(() => {
      if (this.recoveries.get(store) === recovery) this.recoveries.delete(store);
    });
    this.recoveries.set(store, recovery);
    return recovery;
  }

  private recoveriesFor(store: RunStore): Promise<ApprovalAutoReviewRecoveryResult> | undefined {
    return this.recoveries.get(store);
  }

  private async runRecovery(store: RunStore): Promise<ApprovalAutoReviewRecoveryResult> {
    this.options.runtimeSupervisor.getRuntime(store.paths.cwd, store);
    this.options.approvalResumeCoordinator.registerStore(store);
    let reviewed = 0;
    let approved = 0;
    let denied = 0;
    let manual = 0;
    let skipped = 0;

    for (const approval of store.listApprovalRequests({ status: "denied", limit: 500 })) {
      if (approval.resolvedBy !== "system-reviewer") continue;
      const finalized = this.options.approvalResumeCoordinator.finalizeSuspendedApprovalDenial({ store, approval });
      if (finalized.status === "finalized") denied += 1;
    }

    for (const approval of store.listApprovalRequests({ status: "pending", limit: 500 })) {
      const prepared = prepareRecoverableReview(store, approval.id);
      if (!prepared) {
        skipped += 1;
        continue;
      }
      let provider: PiRunnerProviderConfig;
      try {
        provider = resolveProviderForRun(store, {
          providerPresetId: prepared.run.providerPresetId,
          skipProviderPreflight: false,
        }, this.options.secretResolver, {
          providerWebSocketFallbackEnabled: this.options.runtimeSupervisor.getTransportFeatures().providerWebSocketFallback,
        });
      } catch {
        manual += 1;
        continue;
      }
      let runner;
      try {
        const runtimeSettings = loadWorkspaceRuntimeSettings(store, this.options.runnerRegistry);
        runner = this.options.runnerRegistry.resolve({
          requestedRunnerId: DEFAULT_RUNNER_ID,
          allowFallback: false,
          allowedRunnerIds: runtimeSettings.allowedRunnerIds,
          providerApi: provider.api,
          tools: [],
        }).runner.adapter;
      } catch {
        manual += 1;
        continue;
      }
      let outcome;
      try {
        outcome = await reviewPendingApprovalAutomatically({
          store,
          runtimeSupervisor: this.options.runtimeSupervisor,
          runner,
          provider,
          providerPresetId: prepared.run.providerPresetId,
          run: prepared.run,
          approval: prepared.approval,
          sourceFence: prepared.sourceFence,
          sourceAuthority: "recoverable_suspension",
          effectivePolicySnapshot: prepared.policy,
          extraSecrets: providerSecrets(provider),
        });
      } catch {
        manual += 1;
        continue;
      }
      reviewed += 1;
      if (outcome.status === "manual") {
        manual += 1;
        continue;
      }
      if (outcome.approval.status === "approved") {
        ensureApprovalDecisionEvent(store, outcome.approval.id);
        const resumed = this.options.approvalResumeCoordinator.resumeAfterApproval({
          store,
          approval: outcome.approval,
        });
        if (resumed.status === "started" || resumed.status === "already_active") approved += 1;
        else manual += 1;
        continue;
      }
      const finalized = this.options.approvalResumeCoordinator.finalizeSuspendedApprovalDenial({
        store,
        approval: outcome.approval,
      });
      if (finalized.status === "finalized") denied += 1;
      else manual += 1;
    }
    return { reviewed, approved, denied, manual, skipped };
  }
}

function ensureApprovalDecisionEvent(store: RunStore, approvalId: string): void {
  const approval = store.getApprovalRequest(approvalId);
  if (!approval?.runId) return;
  const exists = store.listEvents(approval.runId, { limit: 1000 }).some((event) =>
    (event.type === "approval_approved" || event.type === "approval_denied" || event.type === "approval_expired")
    && isRecord(event.data)
    && event.data.approvalId === approval.id);
  if (!exists) appendApprovalDecisionEvent(store, approval);
}

function prepareRecoverableReview(store: RunStore, approvalId: string): {
  readonly approval: NonNullable<ReturnType<RunStore["getApprovalRequest"]>>;
  readonly run: RunSession;
  readonly sourceFence: ReturnType<typeof toRuntimeAttemptFence>;
  readonly policy: EffectiveRunPolicySnapshot;
} | undefined {
  const approval = store.getApprovalRequest(approvalId);
  if (!approval || approval.status !== "pending" || !approval.runId) return undefined;
  if (approval.expiresAt) {
    const expiresAt = Date.parse(approval.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return undefined;
  }
  const checkpoint = store.getApprovalCheckpointForApproval(approval.id);
  const basis = checkpoint?.resumeBasis;
  if (!checkpoint || checkpoint.status !== "pending" || !basis || basis.approvalId !== approval.id) return undefined;
  const run = store.getRun(basis.runId);
  const attempt = store.getWorkUnitAttempt(basis.priorAttemptId);
  if (!run || run.id !== approval.runId || !run.providerPresetId || !attempt) return undefined;
  const sourceFence = toRuntimeAttemptFence(attempt);
  if (!store.isRecoverableApprovalReviewOwner(approval.id, sourceFence)) return undefined;
  const policy = readEffectivePolicySnapshot(run.requestSnapshot);
  if (!policy
    || policy.authorizationMode !== "smart"
    || policy.workspacePolicyUpdatedAt !== store.getApprovalPolicy().updatedAt) {
    return undefined;
  }
  return { approval, run, sourceFence, policy };
}

function readEffectivePolicySnapshot(value: unknown): EffectiveRunPolicySnapshot | undefined {
  if (!isRecord(value) || !isRecord(value.effectivePolicySnapshot)) return undefined;
  const snapshot = value.effectivePolicySnapshot;
  if (typeof snapshot.mode !== "string"
    || typeof snapshot.workspacePolicyUpdatedAt !== "string"
    || !isRecord(snapshot.toolDecisions)
    || !Array.isArray(snapshot.allowedWritePaths)
    || !snapshot.allowedWritePaths.every((path) => typeof path === "string")
    || !Array.isArray(snapshot.riskNotes)) {
    return undefined;
  }
  return snapshot as unknown as EffectiveRunPolicySnapshot;
}

function providerSecrets(provider: PiRunnerProviderConfig): readonly (string | undefined)[] {
  return [provider.apiKey, ...Object.values(provider.headers ?? {})];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
