import { isAbsolute, relative, resolve as resolvePath } from "node:path";
import { hostCapabilityApprovalPayload } from "./host-capability-action.js";
import { createHostCapabilityAuthority } from "./host-capability-authority.js";
import {
  DEFAULT_WORKSPACE_ID,
  approvalSideEffectFingerprintV1,
  buildChannelTeamRiskReviewDecision,
  createApprovalResumeBasisV1,
  defaultApprovalToolDecisions,
  riskyRunTools,
  syncExternalWorkActionForApproval,
  type ApprovalStoreFacet,
  type ApprovalPayload,
  type ApprovalPolicy,
  type ApprovalRequest,
  type ApprovalRisk,
  type ApprovalToolDecision,
  type CreateApprovalRequestInput,
  type EffectiveRunPolicySnapshot,
  type ExternalWorkStoreFacet,
  type RunEventEnvelope,
  type RunEventDataByType,
  type RunEventEmitter,
  type RunEventType,
  type RunExecutionStoreFacet,
  type RunSession,
  type RunStorePathsFacet,
  type RunStore,
  type RunTool,
  type RuntimeSupervisorStoreFacet,
  type RuntimeAttemptFenceV1,
  type SkillApprovalProfile,
} from "@ling-stack/core";
import type { ChannelIntentExecutionOperationV1 } from "@ling-stack/contracts";
import type { PiRunnerApprovalRequest, PiRunnerRunOptions } from "@ling-stack/runner-pi";
import { isRecord } from "../../shared/validation.js";
import { formatEditPreview } from "./edit-diff-preview.js";
import type { ControlPlaneEventHub } from "../control-plane/events.js";
import { appendControlPlaneEvent } from "../control-plane/events.js";
import { appendExecutionActionArtifactEvents } from "./action-artifacts.js";
import { createCallbackApprovalWait, createOwnedApprovalPreviewArtifacts } from "./approval-preview-failure.js";
import {
  classifyApprovalActionType,
  classifyBashRiskFlags,
} from "./action-classifier.js";
import {
  createPatchApprovalMetadata,
} from "./patch-actions.js";
import {
  createUnifiedExecDeniedResult,
} from "./unified-exec.js";
import {
  createFileMutationDeniedResult,
  executeHarnessedFileMutationTool,
  executeHarnessedBashTool,
  failHarnessBashBeforeExecution,
  failHarnessToolBeforeExecution,
  harnessToolBrokerModeForRun,
  prepareHarnessBashApproval,
  prepareHarnessToolApproval,
  resolveHarnessBashApproval,
  resolveHarnessToolApproval,
} from "../harness/tool-execution/broker.js";
import {
  createFileMutationActionDraft,
  createFileMutationRecoveryBasis,
  type FileMutationActionDraft,
} from "../harness/tool-execution/executors/file-mutation.js";
import {
  applyRiskReviewToApprovalInput,
  applyRiskReviewToPolicyDecision,
} from "./risk-review-approval-adapter.js";
import { evaluatePlanModeApprovalDenial } from "./plan-mode-policy.js";
import { commandMatchesPolicy } from "../channels/command-operation-match.js";
import { workflowOperationEffectRejection } from "./workflow-operation-effect-gate.js";
import type { NativeRestrictedCommandRuntime } from "../../runtime/sandbox/restricted-command-runtime.js";
import type { AttemptHostOperationTracker } from "../../runtime/attempt-host-operation-tracker.js";
import type { HostCommandOperation } from "../../runtime/host-operation-effects.js";
export { mergeRunTools, mergeApprovalProfiles } from "./run-approval-profile.js";
import { reserveFileMutationAdmission, type FileMutationAdmission } from "./file-mutation-admission.js";
import { validateWorkflowOperationRunContext } from "./workflow-operation-snapshot.js";
import {
  createApprovalCommandRuleProposal,
  findMatchingApprovalCommandRulesForCommand,
} from "./approval-command-rules.js";

const APPROVAL_TIMEOUT_MS = 30 * 60 * 1000;
const APPROVAL_POLL_INTERVAL_MS = 500;
const APPROVAL_PREVIEW_LIMIT = 1_200;

type ApprovalDecisionEventStore = RunExecutionStoreFacet;
type ApprovalExpirationStore =
  ApprovalStoreFacet &
  RunExecutionStoreFacet &
  ExternalWorkStoreFacet &
  RuntimeSupervisorStoreFacet &
  RunStorePathsFacet;

export function appendApprovalDecisionEvent(
  store: ApprovalDecisionEventStore,
  approval: ApprovalRequest,
): void {
  if (!approval.runId) {
    return;
  }
  const run = store.getRun(approval.runId);
  if (!run) {
    return;
  }
  store.appendEvent(approval.runId, approvalDecisionEventType(approval), {
    approvalId: approval.id,
    status: approval.status,
    resolvedBy: approval.resolvedBy,
    decisionReason: approval.decisionReason,
    decisionKind: approval.decisionKind,
    decisionRuleId: approval.decisionRuleId,
  });
}

export function expireStalePendingApprovals(
  store: ApprovalExpirationStore,
  options: {
    readonly runId?: string;
    readonly mediaJobId?: string;
    readonly externalWorkActionId?: string;
    readonly workflowStepId?: string;
    readonly cwd?: string;
    readonly controlPlaneEvents?: ControlPlaneEventHub;
  } = {},
): void {
  const now = new Date().toISOString();
  let safety = 0;
  for (;;) {
    const pending = store.listApprovalRequests({
      status: "pending",
      runId: options.runId,
      mediaJobId: options.mediaJobId,
      externalWorkActionId: options.externalWorkActionId,
      workflowStepId: options.workflowStepId,
      limit: 500,
    });
    const expired = pending.filter((approval) => approval.expiresAt && approval.expiresAt <= now);
    if (expired.length === 0) {
      return;
    }
    for (const approval of expired) {
      expireApproval(store, approval, now, options.controlPlaneEvents, options.cwd ?? store.paths.cwd);
    }
    safety += 1;
    if (pending.length < 500 || safety > 20) {
      return;
    }
  }
}

export function expireStaleApproval(
  store: ApprovalExpirationStore,
  approvalId: string,
  controlPlaneEvents?: ControlPlaneEventHub,
  cwd = store.paths.cwd,
): void {
  const approval = store.getApprovalRequest(approvalId);
  const now = new Date().toISOString();
  if (!approval || approval.status !== "pending" || !approval.expiresAt || approval.expiresAt > now) {
    return;
  }
  expireApproval(store, approval, now, controlPlaneEvents, cwd);
}

export function createRunApprovalHandler(options: {
  readonly restrictedCommandRuntime?: NativeRestrictedCommandRuntime;
  readonly store: RunStore;
  readonly run: RunSession;
  readonly workUnitId: string;
  readonly attemptId: string;
  /** Captured at Runner dispatch; required for Host calls, never inferred from the latest Attempt. */
  readonly sourceFence?: RuntimeAttemptFenceV1;
  /** Captured Host operation authority, never inferred from a later Attempt. */
  readonly hostOperationTracker?: AttemptHostOperationTracker;
  readonly recordCompactionBoundaryEvidence?: boolean;
  readonly delegatedRequirementFingerprint?: string;
  readonly executionOperationBindings?: readonly ChannelIntentExecutionOperationV1[];
  readonly approvalPolicy: ApprovalPolicy;
  readonly approvalProfile?: SkillApprovalProfile;
  readonly effectivePolicySnapshot?: EffectiveRunPolicySnapshot;
  readonly appendAndMaybeStream: RunEventEmitter;
  readonly streamEnvelope: (envelope: RunEventEnvelope) => void;
  readonly signal?: AbortSignal;
  readonly extraSecrets?: readonly (string | undefined)[];
  readonly controlPlaneEvents?: ControlPlaneEventHub;
  readonly workspaceCwd?: string;
  readonly unifiedExecEnabled?: boolean;
  readonly shellSnapshotEnabled?: boolean;
  /**
   * Pauses the owning run's execution timeout before approval state is
   * materialized. This must happen before the first SQLite write because a
   * slow write must not race the hard-timeout timer while the run is becoming
   * a durable approval wait.
   */
  readonly onApprovalWaitStarted?: () => void;
  /**
   * Notifies the owning run loop after a durable approval decision is observed.
   * The decision event may have been appended by the HTTP approval route before
   * this handler polls it, so callers must not infer this transition solely
   * from appendAndMaybeStream being invoked.
   */
  readonly onApprovalResolved?: (approval: ApprovalRequest) => void;
  /** Release this callback's local pause when no durable decision can be asserted. */
  readonly onApprovalWaitAbandoned?: () => void;
  /**
   * Replays the derived projections for a decision event that was persisted by
   * the approval HTTP route before this run loop observed it.
   */
  readonly onExistingApprovalDecisionEvent?: (envelope: RunEventEnvelope) => void;
  /**
   * Optional isolated reviewer for smart authorization. The callback may
   * resolve the pending approval through the Store CAS or leave it pending for
   * the existing human path.
   */
  readonly reviewPendingApproval?: (approval: ApprovalRequest) => Promise<void>;
}): PiRunnerRunOptions["onApprovalRequired"] {
  const sourceFence = options.sourceFence ? Object.freeze({ ...options.sourceFence }) : undefined;
  const hostAuthority = createHostCapabilityAuthority({ ...options, sourceFence });
  const toolBrokerMode = harnessToolBrokerModeForRun(options.run);
  const handleRequest = async (
    request: PiRunnerApprovalRequest,
    approvalWait: ReturnType<typeof createCallbackApprovalWait>,
    fileAdmission?: FileMutationAdmission,
    commandAdmission?: { readonly operation: HostCommandOperation; dispatched: boolean },
  ) => {
    // A Run has one durable approval-wait state. Parallel tool calls must not
    // each create a pending approval against the same running -> waiting edge.
    if (options.signal?.aborted) throwIfAborted(options.signal);
    if (options.store.getRun(options.run.id)?.status !== "running") {
      return { approved: false, reason: "stale_run_execution: Run is no longer active for this approval request." } as const;
    }
    const isHost = request.toolName.startsWith("host_");
    const unifiedExecBash = options.unifiedExecEnabled === true && request.toolName === "bash";
    const fileMutation = request.toolName === "write" || request.toolName === "edit";
    const hostExecution = isHost || unifiedExecBash || (fileMutation && toolBrokerMode !== "off");
    const rejectHost = (approvalId?: string) => {
      const rejection = isHost ? hostAuthority.check(request, approvalId) : undefined;
      return rejection ? { approved: false, approvalId, reason: `${rejection.code}: ${rejection.reason}` } : undefined;
    };
    const hostRejection = rejectHost();
    if (hostRejection) return hostRejection;
    const transitionRunStatus = (input: Parameters<RunStore["transitionRunStatus"]>[0]) =>
      hostExecution && sourceFence ? options.store.transitionRunExecutionStatus({ ...input, sourceFence }) : options.store.transitionRunStatus(input);
    const createScopedApproval = (input: CreateApprovalRequestInput, now: string) => {
      try {
        return hostExecution && sourceFence
          ? options.store.createExecutionApprovalRequest({ ...input, runId: options.run.id }, sourceFence, now)
          : options.store.createApprovalRequest(input, now);
      } catch (error) {
        if (hostExecution && error instanceof Error && "code" in error && error.code === "stale_run_execution") {
          return { approved: false, reason: "host_capability_owner_invalid: Host approval lost its source execution before insertion." } as const;
        }
        throw error;
      }
    };
    if (request.toolName === "bash" && !unifiedExecBash) {
      const reason = "host_command_executor_disabled: Bash requires the journaled Host executor; SDK fallback is disabled.";
      return { approved: false, reason, handledResult: createUnifiedExecDeniedResult({ toolCallId: request.toolCallId, reason }) };
    }
    if ((unifiedExecBash || (fileMutation && toolBrokerMode !== "off")) && !sourceFence) {
      const reason = `stale_run_execution: Host ${unifiedExecBash ? "command" : "file mutation"} requires the captured source Attempt.`;
      return {
        approved: false,
        reason,
        ...(fileMutation
          ? { handledResult: createFileMutationDeniedResult({ request }, reason) }
          : { handledResult: createUnifiedExecDeniedResult({ toolCallId: request.toolCallId, reason }) }),
      };
    }
    const rejectUnboundEffect = (approvalId?: string) => {
      const rejection = workflowOperationEffectRejection({ store: options.store, run: options.run, request,
        restrictedCommandRuntime: options.restrictedCommandRuntime });
      if (!rejection) return undefined;
      const reason = rejection.code + ": " + rejection.reason;
      return {
        approved: false,
        approvalId,
        reason,
        ...(unifiedExecBash
          ? { handledResult: createUnifiedExecDeniedResult({ toolCallId: request.toolCallId, approvalId, reason }) }
          : fileMutation ? { handledResult: createFileMutationDeniedResult({ request, approvalId }, reason) } : {}),
      };
    };
    const effectRejection = rejectUnboundEffect();
    if (effectRejection) return effectRejection;
    const bindingRejection = workflowExactCommandBindingRejection({
      bindings: options.executionOperationBindings,
      request,
    });
    if (bindingRejection) {
      return {
        approved: false,
        reason: bindingRejection,
        ...(unifiedExecBash
          ? {
              handledResult: createUnifiedExecDeniedResult({
                toolCallId: request.toolCallId,
                reason: bindingRejection,
              }),
            }
          : fileMutation ? { handledResult: createFileMutationDeniedResult({ request }, bindingRejection) } : {}),
      };
    }
    let patchMetadata: ReturnType<typeof createPatchApprovalMetadata> | undefined;
    try {
      patchMetadata = createPatchApprovalMetadata(request);
    } catch (error) {
      const reason = formatPatchActionError(error);
      return {
        approved: false,
        reason,
        ...(fileMutation ? { handledResult: createFileMutationDeniedResult({ request }, reason) } : {}),
      };
    }

    let approvalInput = toCreateApprovalRequestInput(options.run, request, patchMetadata?.payload);
    let policyDecision = evaluateApprovalPolicy(options.approvalPolicy, request, approvalInput.payload);
    let fileMutationDraft: FileMutationActionDraft | undefined;
    if (fileMutation && policyDecision.decision !== "deny") {
      try {
        fileMutationDraft = createFileMutationActionDraft({
          request,
          allowedWritePaths: options.approvalPolicy.allowedWritePaths,
        });
        approvalInput = toCreateApprovalRequestInput(options.run, request, fileMutationDraft.payload);
      } catch (error) {
        const reason = formatPatchActionError(error);
        return { approved: false, reason, handledResult: createFileMutationDeniedResult({ request }, reason) };
      }
    }
    const workflowContext = fileMutation ? validateWorkflowOperationRunContext({ store: options.store, run: options.run }) : undefined;
    const typedExclusiveCreate = request.toolName === "write" && workflowContext?.status === "ready";
    if (typedExclusiveCreate && fileMutationDraft?.executorKind === "apply_patch") {
      const reason = "operation_binding_content_form_unsupported: Typed create requires a native path/content write; patch creation is not an exclusive-create capability.";
      return { approved: false, reason, handledResult: createFileMutationDeniedResult({ request }, reason) };
    }

    policyDecision = evaluateApprovalPolicy(options.approvalPolicy, request, approvalInput.payload);
    const riskReview = buildChannelTeamRiskReviewDecision({
      actionType: approvalInput.actionType,
      risk: approvalInput.risk,
      payload: approvalInput.payload,
    });
    approvalInput = applyRiskReviewToApprovalInput(approvalInput, riskReview);
    policyDecision = applyRiskReviewToPolicyDecision(policyDecision, riskReview);
    const planModeDenial = evaluatePlanModeApprovalDenial({
      effectivePolicySnapshot: options.effectivePolicySnapshot,
      actionType: approvalInput.actionType,
      payload: approvalInput.payload,
    });
    if (planModeDenial) {
      policyDecision = {
        decision: "deny",
        reason: planModeDenial.reason,
      };
    }

    const mandatoryApproval = approvalProfileRequiresApproval(
      options.approvalProfile,
      request.toolName,
      approvalInput.actionType,
    );
    if (
      policyDecision.decision === "ask" &&
      !mandatoryApproval &&
      approvalInput.payload.type === "bash"
    ) {
      const matchingRules = findMatchingApprovalCommandRulesForCommand(
        options.store,
        approvalInput.payload.command,
      );
      if (matchingRules) {
        policyDecision = {
          decision: "allow",
          reason: `Ling Stack workspace command rule allowed bash: ${matchingRules.map((rule) => rule.display).join(", ")}.`,
        };
      } else {
        const proposedCommandRule = createApprovalCommandRuleProposal({
          command: approvalInput.payload.command,
          requestedPrefix: readInputStringList(request.input, "prefix_rule"),
          risk: approvalInput.risk,
          riskFlags: approvalInput.payload.riskFlags,
        });
        if (proposedCommandRule) {
          approvalInput = {
            ...approvalInput,
            availableDecisions: ["approve_once", "approve_command_rule", "deny"],
            proposedCommandRule,
          };
        }
      }
    }

    if (policyDecision.decision === "allow") {
      const executionRejection = rejectUnboundEffect();
      if (executionRejection) return executionRejection;
      if (unifiedExecBash) {
        if (commandAdmission) commandAdmission.dispatched = true;
        return {
          approved: true,
          reason: policyDecision.reason,
          handledResult: await executeHarnessedBashTool({
            mode: toolBrokerMode,
            restrictedCommandRuntime: options.restrictedCommandRuntime,
            store: options.store,
            sourceFence: sourceFence!,
            run: options.run,
            request,
            effectivePolicySnapshot: options.effectivePolicySnapshot,
            appendAndMaybeStream: options.appendAndMaybeStream,
            signal: options.signal,
            extraSecrets: options.extraSecrets,
            shellSnapshotEnabled: options.shellSnapshotEnabled,
            hostOperation: commandAdmission?.operation,
          }),
        };
      }
      if (fileMutationDraft) {
        return {
          approved: true,
          reason: policyDecision.reason,
          handledResult: await executeHarnessedFileMutationTool({
            mode: toolBrokerMode,
            store: options.store,
            sourceFence,
            run: options.run,
            request,
            draft: fileMutationDraft,
            allowedWritePaths: options.approvalPolicy.allowedWritePaths,
            effectivePolicySnapshot: options.effectivePolicySnapshot,
            appendAndMaybeStream: options.appendAndMaybeStream,
            signal: options.signal,
            requireExistingParentsForAdds: typedExclusiveCreate,
            hostOperation: fileAdmission?.operation,
            recordCompactionBoundaryEvidence: options.recordCompactionBoundaryEvidence,
          }),
        };
      }
      return {
        approved: true,
        reason: policyDecision.reason,
      };
    }

    if (policyDecision.decision === "deny") {
      const createdAt = new Date().toISOString();
      const denied = createScopedApproval({
        ...approvalInput,
        extraSecrets: options.extraSecrets,
      }, createdAt);
      if ("approved" in denied) return denied;
      bindRunApprovalResumeBasis(options, denied, createdAt);
      appendApprovalCreatedControlPlaneEvent(
        options.store,
        options.controlPlaneEvents,
        options.workspaceCwd ?? options.run.cwd,
        denied,
        createdAt,
      );
      const previewArtifacts = createOwnedApprovalPreviewArtifacts({
        ...options, sourceFence, request, approval: denied, mode: toolBrokerMode, unifiedExecBash, fileMutationDraft,
        now: createdAt, decision: "deny", decisionReason: policyDecision.reason,
        publishDecision: (resolved) => {
          appendApprovalResolvedControlPlaneEvent(options.store, options.controlPlaneEvents,
            options.workspaceCwd ?? options.run.cwd, resolved, "pending", "denied", resolved.resolvedAt ?? new Date().toISOString());
          streamOrAppendApprovalDecisionEvent({ store: options.store, approval: resolved, afterSeq: 0,
            appendAndMaybeStream: options.appendAndMaybeStream, streamEnvelope: options.streamEnvelope,
            onExistingEvent: options.onExistingApprovalDecisionEvent });
        },
      });
      const resolved = options.store.denyApprovalRequest(
        denied.id,
        { reason: policyDecision.reason },
        new Date().toISOString(),
      );
      if (!resolved) {
        throw new Error(`Approval request not found after policy denial: ${denied.id}`);
      }
      appendApprovalResolvedControlPlaneEvent(
        options.store,
        options.controlPlaneEvents,
        options.workspaceCwd ?? options.run.cwd,
        resolved,
        "pending",
        "denied",
        resolved.resolvedAt ?? new Date().toISOString(),
      );
      const requestEvent = options.appendAndMaybeStream("approval_requested", approvalRequestEventPayload(resolved, previewArtifacts));
      appendExecutionActionArtifactEvents({
        artifacts: previewArtifacts,
        approval: resolved,
        role: "preview",
        appendAndMaybeStream: options.appendAndMaybeStream,
      });
      streamOrAppendApprovalDecisionEvent({
        store: options.store,
        approval: resolved,
        afterSeq: requestEvent?.seq ?? 0,
        appendAndMaybeStream: options.appendAndMaybeStream,
        streamEnvelope: options.streamEnvelope,
      });
      if (unifiedExecBash) {
        prepareHarnessBashApproval({
          mode: toolBrokerMode,
          store: options.store,
          sourceFence: sourceFence!,
          run: options.run,
          request,
          approvalId: resolved.id,
          effectivePolicySnapshot: options.effectivePolicySnapshot,
          approvalState: "denied",
          failureCode: "tool.policy_denied",
          resultSummary: { reason: resolved.decisionReason ?? policyDecision.reason },
        });
      } else if (fileMutationDraft && sourceFence) {
        prepareHarnessToolApproval({
          mode: toolBrokerMode,
          store: options.store,
          sourceFence,
          run: options.run,
          request,
          approvalId: resolved.id,
          effectivePolicySnapshot: options.effectivePolicySnapshot,
          executorKind: fileMutationDraft.executorKind,
          recoveryBasis: createFileMutationRecoveryBasis(fileMutationDraft),
          approvalState: "denied",
          failureCode: "tool.policy_denied",
          resultSummary: { reason: resolved.decisionReason ?? policyDecision.reason },
        });
      }
      return {
        approved: false,
        approvalId: resolved.id,
        reason: resolved.decisionReason,
        ...(unifiedExecBash
          ? {
              handledResult: createUnifiedExecDeniedResult({
                toolCallId: request.toolCallId,
                approvalId: resolved.id,
                reason: resolved.decisionReason,
              }),
            }
          : fileMutation
            ? { handledResult: createFileMutationDeniedResult({ request, approvalId: resolved.id }, resolved.decisionReason ?? policyDecision.reason) }
            : {}),
      };
    }

    // Enter the durable approval wait before creating the request, preview
    // artifacts, or changing the Run status. Those writes can be slower than
    // the remaining runtime budget, especially in a busy SQLite process.
    approvalWait.start();
    const beforeWaitRejection = rejectHost();
    if (beforeWaitRejection) return beforeWaitRejection;
    const createdAt = new Date().toISOString();
    const approval = createScopedApproval({
      ...approvalInput,
      extraSecrets: options.extraSecrets,
    }, createdAt);
    if ("approved" in approval) return approval;
    bindRunApprovalResumeBasis(options, approval, createdAt);
    if (unifiedExecBash) {
      prepareHarnessBashApproval({
        mode: toolBrokerMode,
        store: options.store,
        sourceFence: sourceFence!,
        run: options.run,
        request,
        approvalId: approval.id,
        effectivePolicySnapshot: options.effectivePolicySnapshot,
        approvalState: "approval_pending",
      });
    } else if (fileMutationDraft && sourceFence) {
      prepareHarnessToolApproval({
        mode: toolBrokerMode,
        store: options.store,
        sourceFence,
        run: options.run,
        request,
        approvalId: approval.id,
        effectivePolicySnapshot: options.effectivePolicySnapshot,
        executorKind: fileMutationDraft.executorKind,
        recoveryBasis: createFileMutationRecoveryBasis(fileMutationDraft),
        approvalState: "approval_pending",
      });
    }
    appendApprovalCreatedControlPlaneEvent(
      options.store,
      options.controlPlaneEvents,
      options.workspaceCwd ?? options.run.cwd,
      approval,
      createdAt,
    );
    const previewArtifacts = createOwnedApprovalPreviewArtifacts({
      ...options, sourceFence, request, approval, mode: toolBrokerMode, unifiedExecBash, fileMutationDraft,
      now: createdAt, decision: "ask",
      onApprovalResolved: (resolved) => approvalWait.resolve(resolved),
      onApprovalWaitAbandoned: () => approvalWait.abandon(),
      publishDecision: (resolved) => {
        appendApprovalResolvedControlPlaneEvent(options.store, options.controlPlaneEvents,
          options.workspaceCwd ?? options.run.cwd, resolved, "pending", "cancelled", resolved.resolvedAt ?? new Date().toISOString());
        streamOrAppendApprovalDecisionEvent({ store: options.store, approval: resolved, afterSeq: 0,
          appendAndMaybeStream: options.appendAndMaybeStream, streamEnvelope: options.streamEnvelope,
          onExistingEvent: options.onExistingApprovalDecisionEvent });
      },
    });
    const waitingAt = new Date().toISOString();
    const waitingTransition = transitionRunStatus({
      runId: options.run.id,
      expectedStatus: "running",
      event: "approval_requested",
      actor: "system",
      now: waitingAt,
    });
    if (hostExecution && !waitingTransition.ok) {
      const reason = "host_capability_owner_invalid: Host approval could not enter the captured execution's wait.";
      const cancelled = options.store.cancelApprovalRequest(approval.id, { reason }, new Date().toISOString());
      if (cancelled) {
        options.appendAndMaybeStream("approval_cancelled", {
          approvalId: cancelled.id,
          status: cancelled.status,
          resolvedBy: cancelled.resolvedBy,
          decisionReason: cancelled.decisionReason,
        });
        appendApprovalResolvedControlPlaneEvent(options.store, options.controlPlaneEvents,
          options.workspaceCwd ?? options.run.cwd, cancelled, "pending", "cancelled", cancelled.resolvedAt ?? new Date().toISOString());
        approvalWait.resolve(cancelled);
      }
      return { approved: false, approvalId: approval.id, reason };
    }
    const requestEvent = options.appendAndMaybeStream("approval_requested", approvalRequestEventPayload(approval, previewArtifacts));
    appendExecutionActionArtifactEvents({
      artifacts: previewArtifacts,
      approval,
      role: "preview",
      appendAndMaybeStream: options.appendAndMaybeStream,
    });

    if (
      !mandatoryApproval
      && options.effectivePolicySnapshot?.authorizationMode === "smart"
      && options.reviewPendingApproval
    ) {
      try {
        await options.reviewPendingApproval(approval);
      } catch {
        // Automatic review is advisory until its fenced Store CAS succeeds.
        // Any technical failure leaves the durable approval pending so the
        // existing human decision path remains available.
      }
    }

    const resolvedApproval = await waitForApprovalDecision(options.store, approval.id, options.signal);
    const afterWaitRejection = rejectHost(resolvedApproval.status === "approved" ? resolvedApproval.id : undefined);
    if (afterWaitRejection) {
      approvalWait.resolve(resolvedApproval);
      return afterWaitRejection;
    }
    const resolvedAt = new Date().toISOString();
    if (unifiedExecBash) {
      resolveHarnessBashApproval({
        mode: toolBrokerMode,
        store: options.store,
        sourceFence: sourceFence!,
        run: options.run,
        request,
        approvalId: resolvedApproval.id,
        effectivePolicySnapshot: options.effectivePolicySnapshot,
        nextState: resolvedApproval.status === "approved"
          ? "approved"
          : resolvedApproval.status === "denied" ? "denied" : "cancelled",
        failureCode: resolvedApproval.status === "approved"
          ? undefined
          : resolvedApproval.status === "denied" ? "tool.approval_denied" : "tool.execution_cancelled",
        ...(resolvedApproval.status === "approved" ? {} : {
          resultSummary: { reason: resolvedApproval.decisionReason ?? `approval_${resolvedApproval.status}` },
        }),
      });
    } else if (fileMutationDraft && sourceFence) {
      resolveHarnessToolApproval({
        mode: toolBrokerMode,
        store: options.store,
        sourceFence,
        run: options.run,
        request,
        approvalId: resolvedApproval.id,
        effectivePolicySnapshot: options.effectivePolicySnapshot,
        executorKind: fileMutationDraft.executorKind,
        recoveryBasis: createFileMutationRecoveryBasis(fileMutationDraft),
        nextState: resolvedApproval.status === "approved"
          ? "approved"
          : resolvedApproval.status === "denied" ? "denied" : "cancelled",
        failureCode: resolvedApproval.status === "approved"
          ? undefined
          : resolvedApproval.status === "denied" ? "tool.approval_denied" : "tool.execution_cancelled",
        ...(resolvedApproval.status === "approved" ? {} : {
          resultSummary: { reason: resolvedApproval.decisionReason ?? `approval_${resolvedApproval.status}` },
        }),
      });
    }
    if (resolvedApproval.status === "expired") {
      appendApprovalExpiredControlPlaneEvent(
        options.store,
        options.controlPlaneEvents,
        options.workspaceCwd ?? options.run.cwd,
        resolvedApproval,
        "pending",
        resolvedAt,
      );
    } else {
      appendApprovalResolvedControlPlaneEvent(
        options.store,
        options.controlPlaneEvents,
        options.workspaceCwd ?? options.run.cwd,
        resolvedApproval,
        "pending",
        resolvedApproval.status === "approved" ? "approved" : "denied",
        resolvedAt,
      );
    }
    if (resolvedApproval.status === "approved") {
      transitionRunStatus({
        runId: options.run.id,
        expectedStatus: "waiting_for_approval",
        event: "approval_approved",
        actor: resolvedApproval.resolvedBy === "system-reviewer" ? "system" : "local-user",
        reason: resolvedApproval.decisionReason,
        now: resolvedAt,
      });
    } else if (resolvedApproval.status === "expired") {
      transitionRunStatus({
        runId: options.run.id,
        expectedStatus: "waiting_for_approval",
        event: "approval_expired",
        actor: "system",
        reason: resolvedApproval.decisionReason,
        now: resolvedAt,
        endedAt: resolvedAt,
        errorMessage: resolvedApproval.decisionReason ?? "Approval expired.",
      });
    } else {
      transitionRunStatus({
        runId: options.run.id,
        expectedStatus: "waiting_for_approval",
        event: "approval_denied",
        actor: resolvedApproval.resolvedBy === "system-reviewer" ? "system" : "local-user",
        reason: resolvedApproval.decisionReason,
        now: resolvedAt,
        endedAt: resolvedAt,
        errorMessage: resolvedApproval.decisionReason ?? "Approval denied.",
      });
    }
    streamOrAppendApprovalDecisionEvent({
      store: options.store,
      approval: resolvedApproval,
      afterSeq: requestEvent?.seq ?? 0,
      appendAndMaybeStream: options.appendAndMaybeStream,
      streamEnvelope: options.streamEnvelope,
      onExistingEvent: options.onExistingApprovalDecisionEvent,
    });
    approvalWait.resolve(resolvedApproval);

    if (resolvedApproval.status === "approved") {
      const systemReviewRejection = systemReviewedApprovalExecutionRejection({
        store: options.store,
        run: options.run,
        approval: resolvedApproval,
        sourceFence,
        effectivePolicySnapshot: options.effectivePolicySnapshot,
        currentActionType: approvalInput.actionType,
        currentToolCallId: request.toolCallId,
        currentPayload: approvalInput.payload,
      });
      if (systemReviewRejection) {
        if (unifiedExecBash) {
          failHarnessBashBeforeExecution({
            mode: toolBrokerMode,
            store: options.store,
            sourceFence: sourceFence!,
            run: options.run,
            request,
            approvalId: resolvedApproval.id,
            effectivePolicySnapshot: options.effectivePolicySnapshot,
            failureCode: "tool.policy_denied",
            resultSummary: { reason: systemReviewRejection },
          });
        } else if (fileMutationDraft && sourceFence) {
          failHarnessToolBeforeExecution({
            mode: toolBrokerMode,
            store: options.store,
            sourceFence,
            run: options.run,
            request,
            approvalId: resolvedApproval.id,
            effectivePolicySnapshot: options.effectivePolicySnapshot,
            executorKind: fileMutationDraft.executorKind,
            recoveryBasis: createFileMutationRecoveryBasis(fileMutationDraft),
            failureCode: "tool.policy_denied",
            resultSummary: { reason: systemReviewRejection },
          });
        }
        return {
          approved: false,
          approvalId: resolvedApproval.id,
          reason: systemReviewRejection,
          ...(unifiedExecBash
            ? {
                handledResult: createUnifiedExecDeniedResult({
                  toolCallId: request.toolCallId,
                  approvalId: resolvedApproval.id,
                  reason: systemReviewRejection,
                }),
              }
            : fileMutation
              ? { handledResult: createFileMutationDeniedResult({ request, approvalId: resolvedApproval.id }, systemReviewRejection) }
              : {}),
        };
      }
      const beforeExecutionRejection = rejectHost(resolvedApproval.id);
      if (beforeExecutionRejection) return beforeExecutionRejection;
      let handledResult;
      // Approval does not extend authority. Re-read the immutable basis and the
      // current filesystem after the durable wait, immediately before effects.
      const executionRejection = rejectUnboundEffect(resolvedApproval.id);
      if (executionRejection) {
        if (unifiedExecBash) {
          failHarnessBashBeforeExecution({
            mode: toolBrokerMode,
            store: options.store,
            sourceFence: sourceFence!,
            run: options.run,
            request,
            approvalId: resolvedApproval.id,
            effectivePolicySnapshot: options.effectivePolicySnapshot,
            failureCode: "tool.policy_denied",
            resultSummary: { reason: executionRejection.reason },
          });
        } else if (fileMutationDraft && sourceFence) {
          failHarnessToolBeforeExecution({
            mode: toolBrokerMode,
            store: options.store,
            sourceFence,
            run: options.run,
            request,
            approvalId: resolvedApproval.id,
            effectivePolicySnapshot: options.effectivePolicySnapshot,
            executorKind: fileMutationDraft.executorKind,
            recoveryBasis: createFileMutationRecoveryBasis(fileMutationDraft),
            failureCode: "tool.policy_denied",
            resultSummary: { reason: executionRejection.reason },
          });
        }
        return executionRejection;
      }
      // Host execution has its own executor and receipt; never run file/Bash effects here.
      if (isHost) return { approved: true, approvalId: resolvedApproval.id, reason: resolvedApproval.decisionReason };
      if (unifiedExecBash) {
        if (commandAdmission) commandAdmission.dispatched = true;
        handledResult = await executeHarnessedBashTool({
          mode: toolBrokerMode,
          restrictedCommandRuntime: options.restrictedCommandRuntime,
          store: options.store,
          sourceFence: sourceFence!,
          run: options.run,
          request,
          approvalId: resolvedApproval.id,
          effectivePolicySnapshot: options.effectivePolicySnapshot,
          appendAndMaybeStream: options.appendAndMaybeStream,
          signal: options.signal,
          extraSecrets: options.extraSecrets,
          shellSnapshotEnabled: options.shellSnapshotEnabled,
          hostOperation: commandAdmission?.operation,
        });
      } else if (fileMutationDraft) {
        handledResult = await executeHarnessedFileMutationTool({
          mode: toolBrokerMode,
          store: options.store,
          sourceFence,
          run: options.run,
          request,
          draft: fileMutationDraft,
          allowedWritePaths: options.approvalPolicy.allowedWritePaths,
          approvalId: resolvedApproval.id,
          effectivePolicySnapshot: options.effectivePolicySnapshot,
          previewArtifactIds: previewArtifacts.map((artifact) => artifact.id),
          appendAndMaybeStream: options.appendAndMaybeStream,
          signal: options.signal,
          requireExistingParentsForAdds: typedExclusiveCreate,
          hostOperation: fileAdmission?.operation,
          recordCompactionBoundaryEvidence: options.recordCompactionBoundaryEvidence,
        });
      }
      return {
        approved: true,
        approvalId: resolvedApproval.id,
        reason: resolvedApproval.decisionReason,
        ...(handledResult ? { handledResult } : {}),
      };
    }

    return {
      approved: false,
      approvalId: resolvedApproval.id,
      reason:
        resolvedApproval.decisionReason ??
        `Ling Stack approval ${resolvedApproval.status} for ${resolvedApproval.actionType}.`,
      ...(unifiedExecBash
        ? {
            handledResult: createUnifiedExecDeniedResult({
              toolCallId: request.toolCallId,
              approvalId: resolvedApproval.id,
              reason:
                resolvedApproval.decisionReason ??
                `Ling Stack approval ${resolvedApproval.status} for ${resolvedApproval.actionType}.`,
            }),
          }
        : fileMutation
          ? {
              handledResult: createFileMutationDeniedResult(
                { request, approvalId: resolvedApproval.id },
                resolvedApproval.decisionReason ?? `Ling Stack approval ${resolvedApproval.status} for ${resolvedApproval.actionType}.`,
              ),
            }
          : {}),
    };
  };
  let previousRequest: Promise<void> = Promise.resolve();
  return (request) => {
    // Enrollment must precede this queue's first microtask/await, including
    // requests which later wait for human approval or are refused by policy.
    const tracker = options.hostOperationTracker;
    const fileAdmission = tracker && (request.toolName === "write" || request.toolName === "edit")
      ? reserveFileMutationAdmission(tracker, request.toolCallId) : undefined;
    const commandAdmission = tracker && request.toolName === "bash"
      ? { operation: tracker.commandOperation(tracker.beginHostCall("command", request.toolCallId)), dispatched: false }
      : undefined;
    const settleAdmissions = (): void => {
      fileAdmission?.settle();
      // Once handed to the Broker/Unified executor it alone decides whether
      // spawn was entered; an SDK return is never a command no-start receipt.
      if (commandAdmission && !commandAdmission.dispatched) {
        try { commandAdmission.operation.settleNoStart(); }
        catch (error) {
          try { commandAdmission.operation.markUnknown("command_execution_unconfirmed"); } catch { /* fail closed */ }
          throw error;
        }
      }
    };
    const decision = previousRequest.then(async () => {
      const approvalWait = createCallbackApprovalWait(options);
      let result;
      try { result = await handleRequest(request, approvalWait, fileAdmission, commandAdmission); }
      catch (error) {
        try { settleAdmissions(); } catch { /* preserve the request's original failure */ }
        try { approvalWait.abandon(); }
        catch (releaseError) {
          throw new AggregateError([error, releaseError], error instanceof Error ? error.message : String(error), { cause: error });
        }
        throw error;
      }
      approvalWait.abandon();
      settleAdmissions();
      return result;
    });
    previousRequest = decision.then(() => undefined, () => undefined);
    return decision;
  };
}

export function systemReviewedApprovalExecutionRejection(input: {
  readonly store: Pick<RunStore, "getApprovalPolicy" | "isCurrentRunExecutionOwner">;
  readonly run: RunSession;
  readonly approval: ApprovalRequest;
  readonly sourceFence?: RuntimeAttemptFenceV1;
  readonly effectivePolicySnapshot?: EffectiveRunPolicySnapshot;
  readonly currentActionType: ApprovalRequest["actionType"];
  readonly currentToolCallId: string;
  readonly currentPayload: ApprovalPayload;
}): string | undefined {
  if (input.approval.resolvedBy !== "system-reviewer") return undefined;
  if (!input.sourceFence || !input.effectivePolicySnapshot) {
    return "system_review_execution_fence_missing: Automatic approval cannot execute without its captured policy and Attempt.";
  }
  if (input.store.getApprovalPolicy().updatedAt !== input.effectivePolicySnapshot.workspacePolicyUpdatedAt) {
    return "system_review_policy_changed: Approval policy changed after automatic review; manual review is required.";
  }
  if (!input.store.isCurrentRunExecutionOwner(input.run.id, input.sourceFence, false)) {
    return "system_review_execution_stale: The reviewed Run/Attempt is no longer the active execution owner.";
  }
  if (!input.approval.toolCallId) {
    return "system_review_identity_missing: The reviewed tool call identity is missing.";
  }
  const reviewedFingerprint = approvalSideEffectFingerprintV1({
    actionType: input.approval.actionType,
    toolCallId: input.approval.toolCallId,
    sideEffect: input.approval.payload,
  });
  const currentFingerprint = approvalSideEffectFingerprintV1({
    actionType: input.currentActionType,
    toolCallId: input.currentToolCallId,
    sideEffect: input.currentPayload,
  });
  return reviewedFingerprint === currentFingerprint
    ? undefined
    : "system_review_effect_changed: The command, target, cwd, or payload changed after automatic review.";
}

/**
 * Enforce workflow-owned exact commands before approval or execution. Completion
 * Gate still rechecks the resulting Host evidence after the tool returns.
 */
export function workflowExactCommandBindingRejection(input: {
  readonly bindings?: readonly ChannelIntentExecutionOperationV1[];
  readonly request: Pick<PiRunnerApprovalRequest, "toolName" | "input">;
}): string | undefined {
  if (input.request.toolName !== "bash") return undefined;
  const exactBindings = (input.bindings ?? []).filter((operation) =>
    operation.kind === "run_command"
      && operation.targetKind === "command"
      && operation.commandMatchPolicy?.kind === "exact_command",
  );
  if (exactBindings.length === 0) return undefined;
  const command = readInputString(input.request.input, "command", "");
  if (exactBindings.some((operation) =>
    operation.commandMatchPolicy?.kind === "exact_command"
      && commandMatchesPolicy(command, operation.commandMatchPolicy))) {
    return undefined;
  }
  const expected = exactBindings
    .map((operation) => operation.commandMatchPolicy)
    .filter((policy): policy is Extract<NonNullable<ChannelIntentExecutionOperationV1["commandMatchPolicy"]>, { kind: "exact_command" }> =>
      policy?.kind === "exact_command")
    .map((policy) => policy.command);
  return `Workflow exact command binding rejected bash. Expected one of: ${expected.join("; ")}`;
}

export function mergeApprovalPolicyWithProfile(policy: ApprovalPolicy, profile: SkillApprovalProfile | undefined): ApprovalPolicy {
  if (!profile || profile.mode === "none") {
    return policy;
  }

  const requiredTools = new Set<RunTool>();
  for (const tool of profile.requiredForTools ?? []) {
    requiredTools.add(tool);
  }
  for (const action of profile.requiredForActions ?? []) {
    if (isRunTool(action)) {
      requiredTools.add(action);
    }
  }
  if (profile.mode === "strict") {
    for (const tool of riskyRunTools) {
      requiredTools.add(tool);
    }
  }
  if (requiredTools.size === 0) {
    return policy;
  }

  const toolDecisions = { ...policy.toolDecisions };
  for (const tool of requiredTools) {
    if (toolDecisions[tool] !== "deny") {
      toolDecisions[tool] = "ask";
    }
  }
  return { ...policy, toolDecisions };
}

export function usesSideEffectTools(tools: readonly RunTool[]): boolean {
  return tools.some((tool) => tool === "bash" || tool === "edit" || tool === "write");
}

export function isRunTool(value: unknown): value is RunTool {
  return value === "read" || value === "grep" || value === "find" || value === "ls" || value === "bash" || value === "edit" || value === "write";
}

export function appendApprovalCreatedControlPlaneEvent(
  store: RunStore,
  hub: ControlPlaneEventHub | undefined,
  cwd: string,
  approval: ApprovalRequest,
  now: string,
): void {
  if (!hub) {
    return;
  }
  const owner = resolveApprovalOwner(approval);
  appendControlPlaneEvent(store, hub, {
    workspaceId: DEFAULT_WORKSPACE_ID,
    cwd,
    domain: "approvals",
    entityType: "approval",
    entityId: approval.id,
    action: "approval.created",
    data: {
      ownerType: owner.type,
      ownerId: owner.id,
      actionType: approval.actionType,
      risk: approval.risk,
      expiresAt: approval.expiresAt ?? null,
    },
  }, now);
}

export function appendApprovalResolvedControlPlaneEvent(
  store: RunStore,
  hub: ControlPlaneEventHub | undefined,
  cwd: string,
  approval: ApprovalRequest,
  previousStatus: ApprovalRequest["status"],
  decision: "approved" | "denied" | "cancelled",
  now: string,
): void {
  if (!hub) {
    return;
  }
  const owner = resolveApprovalOwner(approval);
  appendControlPlaneEvent(store, hub, {
    workspaceId: DEFAULT_WORKSPACE_ID,
    cwd,
    domain: "approvals",
    entityType: "approval",
    entityId: approval.id,
    action: "approval.resolved",
    idempotencyKey: `approval-resolved:${approval.id}`,
    data: {
      ownerType: owner.type,
      ownerId: owner.id,
      previousStatus,
      status: approval.status,
      decision,
      resolvedBy: approval.resolvedBy ?? (decision === "cancelled" ? "system" : "local-user"),
    },
  }, now);
}

export function appendApprovalExpiredControlPlaneEvent(
  store: RunExecutionStoreFacet,
  hub: ControlPlaneEventHub | undefined,
  cwd: string,
  approval: ApprovalRequest,
  previousStatus: ApprovalRequest["status"],
  now: string,
): void {
  if (!hub) {
    return;
  }
  const owner = resolveApprovalOwner(approval);
  appendControlPlaneEvent(store, hub, {
    workspaceId: DEFAULT_WORKSPACE_ID,
    cwd,
    domain: "approvals",
    entityType: "approval",
    entityId: approval.id,
    action: "approval.expired",
    idempotencyKey: `approval-expired:${approval.id}`,
    data: {
      ownerType: owner.type,
      ownerId: owner.id,
      previousStatus,
      status: approval.status,
      decision: "expired",
      resolvedBy: "system",
    },
  }, now);
}

function expireApproval(
  store: ApprovalExpirationStore,
  approval: ApprovalRequest,
  now: string,
  controlPlaneEvents?: ControlPlaneEventHub,
  cwd = store.paths.cwd,
): ApprovalRequest | undefined {
  const expired = store.expireApprovalRequest(
    approval.id,
    { reason: "Approval request expired before a decision was received." },
    now,
  );
  if (expired) {
    appendApprovalDecisionEvent(store, expired);
    syncExternalWorkActionForApproval(store, expired, now);
    appendApprovalExpiredControlPlaneEvent(store, controlPlaneEvents, cwd, expired, "pending", now);
  }
  return expired;
}

function resolveApprovalOwner(approval: ApprovalRequest): { readonly type: string; readonly id: string | null } {
  if (approval.runId) {
    return { type: "run", id: approval.runId };
  }
  if (approval.mediaJobId) {
    return { type: "media_job", id: approval.mediaJobId };
  }
  if (approval.externalWorkActionId) {
    return { type: "external_work_action", id: approval.externalWorkActionId };
  }
  if (approval.workflowStepId) {
    return { type: "workflow_step", id: approval.workflowStepId };
  }
  if (approval.taskId) {
    return { type: "task", id: approval.taskId };
  }
  if (approval.channelId) {
    return { type: "channel", id: approval.channelId };
  }
  return { type: "unknown", id: null };
}

function approvalDecisionEventType(approval: ApprovalRequest): Extract<RunEventType, "approval_approved" | "approval_denied" | "approval_expired" | "approval_cancelled"> {
  if (approval.status === "approved") {
    return "approval_approved";
  }
  if (approval.status === "expired") {
    return "approval_expired";
  }
  if (approval.status === "cancelled") {
    return "approval_cancelled";
  }
  return "approval_denied";
}

function approvalRequestEventPayload(
  approval: ApprovalRequest,
  previewArtifacts: readonly { readonly id: string }[] = [],
): RunEventDataByType["approval_requested"] {
  return {
    approvalId: approval.id,
    toolCallId: approval.toolCallId,
    actionType: approval.actionType,
    risk: approval.risk,
    title: approval.title,
    description: approval.description,
    payload: approval.payload,
    previewArtifactIds: previewArtifacts.map((artifact) => artifact.id),
    expiresAt: approval.expiresAt,
    availableDecisions: approval.availableDecisions,
    proposedCommandRule: approval.proposedCommandRule,
  };
}

function approvalProfileRequiresApproval(
  profile: SkillApprovalProfile | undefined,
  toolName: string,
  actionType: ApprovalRequest["actionType"],
): boolean {
  if (!profile || profile.mode === "none") return false;
  if (profile.mode === "strict" && riskyRunTools.includes(toolName as (typeof riskyRunTools)[number])) {
    return true;
  }
  return profile.requiredForTools?.includes(toolName as RunTool) === true ||
    profile.requiredForActions?.includes(actionType) === true;
}

function evaluateApprovalPolicy(
  policy: ApprovalPolicy,
  request: PiRunnerApprovalRequest,
  payload: ApprovalPayload,
): { readonly decision: ApprovalToolDecision; readonly reason: string } {
  if (payload.type === "host_capability") {
    if (request.defaultApproval === "deny") return { decision: "deny", reason: `Host policy denied ${payload.capabilityId}.` };
    return { decision: "ask", reason: `Separate approval is required for ${payload.capabilityId}.` };
  }
  const toolDecision = isRunTool(request.toolName)
    ? policy.toolDecisions[request.toolName] ?? defaultApprovalToolDecisions[request.toolName]
    : request.defaultApproval ?? "ask";
  if (toolDecision === "deny") {
    return {
      decision: "deny",
      reason: `Ling Stack policy denied ${request.toolName}.`,
    };
  }

  if (payload.type === "file_write" || payload.type === "file_edit") {
    const deniedPath = getPayloadWritePaths(payload).find((path) => !isPathWithinAllowedWritePaths(path, request.cwd, policy.allowedWritePaths));
    if (deniedPath) {
      return {
        decision: "deny",
        reason: `Ling Stack policy denied ${request.toolName}: ${deniedPath} is outside allowed write paths.`,
      };
    }
  }

  if (toolDecision === "allow") {
    return {
      decision: "allow",
      reason: `Ling Stack policy allowed ${request.toolName}.`,
    };
  }

  return {
    decision: "ask",
    reason: `Ling Stack policy requires approval for ${request.toolName}.`,
  };
}

function toCreateApprovalRequestInput(
  run: RunSession,
  request: PiRunnerApprovalRequest,
  payloadOverride?: ApprovalPayload,
): CreateApprovalRequestInput {
  const payload = payloadOverride ?? toApprovalPayload(request);
  const risk = classifyApprovalRisk(request, payload);
  return {
    runId: run.id,
    taskId: run.taskId,
    channelId: run.channelId,
    toolCallId: request.toolCallId,
    actionType: classifyApprovalActionType(request.toolName, payload),
    risk,
    title: approvalTitle(request.toolName, risk),
    description: approvalDescription(request.toolName, payload),
    payload,
    expiresAt: new Date(Date.now() + APPROVAL_TIMEOUT_MS).toISOString(),
  };
}

function bindRunApprovalResumeBasis(
  options: Parameters<typeof createRunApprovalHandler>[0],
  approval: ApprovalRequest,
  now: string,
): void {
  if (!approval.runId || !approval.toolCallId) {
    throw new Error(`Run approval is missing resume ownership: ${approval.id}`);
  }
  const checkpoint = options.store.getApprovalCheckpointForApproval(approval.id);
  if (!checkpoint) {
    throw new Error(`Approval checkpoint was not created: ${approval.id}`);
  }
  const resumeBasis = createApprovalResumeBasisV1({
    approvalId: approval.id,
    runId: approval.runId,
    workUnitId: options.workUnitId,
    priorAttemptId: options.attemptId,
    workflowStepId: options.run.workflowStepId,
    toolCallId: approval.toolCallId,
    actionType: approval.actionType,
    sideEffectFingerprint: approvalSideEffectFingerprintV1({
      actionType: approval.actionType,
      toolCallId: approval.toolCallId,
      sideEffect: approval.payload,
    }),
    delegatedRequirementFingerprint: options.delegatedRequirementFingerprint,
  });
  const bound = options.store.updateApprovalCheckpointStatus(
    checkpoint.id,
    {
      status: checkpoint.status,
      expectedStatus: checkpoint.status,
      expectedRevision: checkpoint.revision,
      resumeBasis,
    },
    now,
  );
  if (!bound || bound.resumeBasis?.fingerprint !== resumeBasis.fingerprint) {
    throw new Error(`Approval checkpoint resume basis could not be bound: ${approval.id}`);
  }
}

function toApprovalPayload(request: PiRunnerApprovalRequest): ApprovalPayload {
  const host = hostCapabilityApprovalPayload(request);
  if (host) return host;
  if (request.toolName === "bash") {
    const command = readInputString(request.input, "command", "");
    return {
      type: "bash",
      cwd: request.cwd,
      command,
      riskFlags: classifyBashRiskFlags(command),
    };
  }

  if (request.toolName === "write") {
    const path = readInputString(request.input, "path", "<unknown>");
    const content = readInputString(request.input, "content", "");
    return {
      type: "file_write",
      path,
      bytes: Buffer.byteLength(content, "utf8"),
      preview: truncatePreview(content),
    };
  }

  if (!isRunTool(request.toolName)) {
    return {
      type: "mcp_tool_call",
      toolName: request.toolName,
      cwd: request.cwd,
      input: request.input,
    };
  }

  if (
    request.toolName === "read" ||
    request.toolName === "grep" ||
    request.toolName === "find" ||
    request.toolName === "ls"
  ) {
    return {
      type: "tool_call",
      toolName: request.toolName,
      cwd: request.cwd,
      input: request.input,
    };
  }

  const path = readInputString(request.input, "path", "<unknown>");
  return {
    type: "file_edit",
    path,
    diffPreview: truncatePreview(formatEditPreview(readInputArray(request.input, "edits"), { maxTextCharacters: 320 })),
  };
}

function classifyApprovalRisk(request: PiRunnerApprovalRequest, payload: ApprovalPayload): ApprovalRisk {
  if (payload.type === "bash") {
    if (payload.riskFlags.includes("git_force_push")) {
      return "critical";
    }
    return payload.riskFlags.length > 0 ? "high" : "medium";
  }

  if (payload.type === "file_write" || payload.type === "file_edit") {
    return getPayloadWritePaths(payload).some((path) => isOutsideWorkspace(path, request.cwd)) ? "high" : "medium";
  }

  if (payload.type === "tool_call") {
    return "low";
  }

  if (payload.type === "mcp_tool_call") {
    return "medium";
  }

  return "medium";
}

function approvalTitle(toolName: PiRunnerApprovalRequest["toolName"], risk: ApprovalRisk): string {
  if (toolName === "host_open_local_target") return "Approve opening local file";
  if (toolName === "host_local_network_info") return "Approve reading local network information";
  if (toolName === "bash") {
    return risk === "high" ? "Approve high-risk shell command" : "Approve shell command";
  }
  if (toolName === "write") {
    return "Approve file write";
  }
  if (toolName === "edit") {
    return "Approve file edit";
  }
  if (!isRunTool(toolName)) {
    return "Approve MCP tool call";
  }
  return `Approve ${toolName}`;
}

function approvalDescription(toolName: PiRunnerApprovalRequest["toolName"], payload: ApprovalPayload): string {
  if (payload.type === "host_capability") {
    return payload.capabilityId === "host.open_local_target" ? `Display workspace file: ${payload.input.path}`
      : `Read local interface addresses: ${payload.input.family}; include loopback: ${payload.input.includeLoopback}`;
  }
  if (payload.type === "bash") {
    return payload.command || "The agent requested a shell command.";
  }
  if (payload.type === "file_write") {
    if (payload.patchFormat) {
      return `The agent requested applying a patch to ${(payload.touchedPaths ?? [payload.path]).join(", ")}.`;
    }
    return `The agent requested writing ${payload.bytes} bytes to ${payload.path}.`;
  }
  if (payload.type === "file_edit") {
    if (payload.patchFormat) {
      return `The agent requested applying a patch to ${(payload.touchedPaths ?? [payload.path]).join(", ")}.`;
    }
    return `The agent requested editing ${payload.path}.`;
  }
  if (payload.type === "tool_call") {
    return `The agent requested ${payload.toolName}.`;
  }
  if (payload.type === "mcp_tool_call") {
    return `The agent requested MCP tool ${payload.toolName}.`;
  }
  return `The agent requested ${toolName}.`;
}

export async function waitForApprovalDecision(store: RunStore, approvalId: string, signal?: AbortSignal): Promise<ApprovalRequest> {
  const deadline = Date.now() + APPROVAL_TIMEOUT_MS;
  while (Date.now() <= deadline) {
    throwIfAborted(signal);
    const approval = store.getApprovalRequest(approvalId);
    if (!approval) {
      throw new Error(`Approval request not found: ${approvalId}`);
    }
    if (approval.status !== "pending") {
      return approval;
    }
    await delay(APPROVAL_POLL_INTERVAL_MS);
  }

  const expired = store.expireApprovalRequest(
    approvalId,
    { reason: "Approval request timed out before a decision was received." },
    new Date().toISOString(),
  );
  if (!expired) {
    throw new Error(`Approval request not found after timeout: ${approvalId}`);
  }
  appendApprovalDecisionEvent(store, expired);
  return expired;
}

export function streamOrAppendApprovalDecisionEvent(options: {
  readonly store: RunStore;
  readonly approval: ApprovalRequest;
  readonly afterSeq: number;
  readonly appendAndMaybeStream: RunEventEmitter;
  readonly streamEnvelope: (envelope: RunEventEnvelope) => void;
  readonly onExistingEvent?: (envelope: RunEventEnvelope) => void;
}): void {
  const existingEvent = findApprovalDecisionEvent(options.store, options.approval, options.afterSeq);
  if (existingEvent) {
    options.onExistingEvent?.(existingEvent);
    options.streamEnvelope(existingEvent);
    return;
  }

  options.appendAndMaybeStream(approvalDecisionEventType(options.approval), {
    approvalId: options.approval.id,
    status: options.approval.status,
    resolvedBy: options.approval.resolvedBy,
    decisionReason: options.approval.decisionReason,
  });
}

function findApprovalDecisionEvent(
  store: RunStore,
  approval: ApprovalRequest,
  afterSeq: number,
): RunEventEnvelope | undefined {
  if (!approval.runId) {
    return undefined;
  }
  return store
    .listEvents(approval.runId, { afterSeq, limit: 1000 })
    .find(
      (event) =>
        (event.type === "approval_approved" || event.type === "approval_denied" || event.type === "approval_expired") &&
        isRecord(event.data) &&
        event.data.approvalId === approval.id,
    );
}

function isOutsideWorkspace(inputPath: string, cwd: string): boolean {
  if (inputPath === "<unknown>") {
    return true;
  }
  const absolutePath = isAbsolute(inputPath) ? inputPath : resolvePath(cwd, inputPath);
  const relativePath = relative(cwd, absolutePath);
  return relativePath.startsWith("..") || isAbsolute(relativePath);
}

function isPathWithinAllowedWritePaths(inputPath: string, cwd: string, allowedWritePaths: readonly string[]): boolean {
  if (inputPath === "<unknown>") {
    return false;
  }
  const absolutePath = isAbsolute(inputPath) ? inputPath : resolvePath(cwd, inputPath);
  return allowedWritePaths.some((allowedPath) => {
    const scopePath = isAbsolute(allowedPath) ? allowedPath : resolvePath(cwd, allowedPath);
    const relativePath = relative(scopePath, absolutePath);
    return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
  });
}

function getPayloadWritePaths(payload: Extract<ApprovalPayload, { readonly type: "file_write" | "file_edit" }>): readonly string[] {
  return payload.touchedPaths && payload.touchedPaths.length > 0 ? payload.touchedPaths : [payload.path];
}

function readInputString(input: unknown, key: string, fallback: string): string {
  if (!isRecord(input)) {
    return fallback;
  }
  const value = input[key];
  return typeof value === "string" ? value : fallback;
}

function readInputArray(input: unknown, key: string): unknown[] {
  if (!isRecord(input)) {
    return [];
  }
  const value = input[key];
  return Array.isArray(value) ? value : [];
}

function readInputStringList(input: unknown, key: string): string[] | undefined {
  const values = readInputArray(input, key);
  if (values.length === 0 || values.some((item) => typeof item !== "string")) return undefined;
  return values as string[];
}

function truncatePreview(value: string, limit = APPROVAL_PREVIEW_LIMIT): string {
  return value.length > limit ? `${value.slice(0, limit)}...` : value;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) {
    return;
  }
  throw createAbortError();
}

function createAbortError(): Error {
  const error = new Error("Run cancelled.");
  error.name = "AbortError";
  return error;
}

function formatPatchActionError(error: unknown): string {
  return `Ling Stack patch rejected: ${error instanceof Error ? error.message : String(error)}`;
}
