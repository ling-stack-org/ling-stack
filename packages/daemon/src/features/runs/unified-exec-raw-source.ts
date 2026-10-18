import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { authorizationAndAccessFromLegacyPermission, isAuthorizationMode, isWorkspaceAccessMode,
  isPermissionPreset, isSessionPermissionMode, resolveSessionRunPolicy, readOnlyRunTools, riskyRunTools,
  type EffectiveRunPolicySnapshot, type RunSession, type RunStore, type RuntimeAttemptFenceV1,
  type UnifiedExecRequest, type SkillApprovalProfile } from "@ling-stack/core";
import type { PiRunnerApprovalRequest } from "@ling-stack/runner-pi";
import { isDelegatedStepRequirementV1 } from "@ling-stack/contracts";
import { defineProtectedHostActorEntry, type ProtectedHostActorEntryId } from "../../runtime/sandbox/protected-host-actor-inventory.js";
import { isRecord } from "../../shared/validation.js";
import { readStoredEffectivePolicySnapshot } from "./existing-run-request.js";
import { assertCommandLaunchApproval } from "./command-launch-approval.js";
import { readCurrentRunApprovalProfile } from "./run-approval-profile.js";
import { validateWorkflowOperationRunContext } from "./workflow-operation-snapshot.js";
import { evaluatePlanModeApprovalDenial } from "./plan-mode-policy.js";
import { normalizeBashRequest } from "./unified-exec-request.js";

interface RawLaunch {
  readonly entryId: "unified_exec_raw" | "unified_exec_full_access";
  readonly request: UnifiedExecRequest;
  readonly environment: NodeJS.ProcessEnv;
  readonly assertCurrent: () => void;
  readonly onProducerEntered: () => void;
}
// No public flag, command label, cloned record or ordinary raw token grants this exclusion.
const ownedLaunches = new WeakMap<object, RawLaunch>();
function requireSource(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(code);
}

/** Last source check and one-shot consumption precede the original native producer. */
function spawnOwnedRaw(token: object, expectedEntry: ProtectedHostActorEntryId): ChildProcessWithoutNullStreams {
  const launch = ownedLaunches.get(token);
  requireSource(launch?.entryId === expectedEntry, "unified_exec_raw_launch_record_invalid");
  ownedLaunches.delete(token);
  launch.assertCurrent();
  launch.onProducerEntered();
  const command = launch.request.command;
  const options = { cwd: launch.request.cwd, env: launch.environment,
    detached: process.platform !== "win32", stdio: "pipe" as const };
  if (command.kind === "argv") {
    const [file, ...args] = command.argv;
    requireSource(file, "unified_exec_raw_argv_invalid");
    return spawn(file, args, options);
  }
  const shellCommand = launch.environment.LING_GSTACK_PATH_PREFIX
    ? 'PATH="$LING_GSTACK_PATH_PREFIX:$PATH"; export PATH; ' + command.command
    : command.command;
  return spawn(command.shell ?? "bash", ["-lc", shellCommand], options);
}
export const UNIFIED_EXEC_RAW_ACTOR_ENTRY = defineProtectedHostActorEntry("unified_exec_raw",
  (token: object) => spawnOwnedRaw(token, "unified_exec_raw"));
export const UNIFIED_EXEC_FULL_ACCESS_ACTOR_ENTRY = defineProtectedHostActorEntry("unified_exec_full_access",
  (token: object) => spawnOwnedRaw(token, "unified_exec_full_access"));

/**
 * Capture before the first await. SQLite remains the source at the atomic preflight
 * and native entry; absence of a typed sandbox dispatch is never Full Access.
 * Policyless internal legacy Runs retain their ordinary controlled classification.
 */
export function createUnifiedExecRawDispatch(input: {
  readonly store: RunStore;
  readonly run: RunSession;
  readonly sourceFence: RuntimeAttemptFenceV1;
  readonly approvalRequest: PiRunnerApprovalRequest;
  readonly request: UnifiedExecRequest;
  readonly approvalId?: string;
  readonly signal?: AbortSignal;
  readonly extraSecrets?: readonly (string | undefined)[];
}) {
  const { store, signal } = input;
  const source = structuredClone(input.run), approvalRequest = structuredClone(input.approvalRequest);
  const request = structuredClone(input.request), fence = Object.freeze({ ...input.sourceFence });
  const approvalId = input.approvalId, secrets = [...(input.extraSecrets ?? [])];
  const assertRequest = (run: RunSession): void => {
    const normalized = normalizeBashRequest(run, approvalRequest, approvalId);
    requireSource(!("error" in normalized) && Object.keys(request).every(key => Object.hasOwn(normalized.request, key))
      && Object.entries(normalized.request).every(([key, value]) => isDeepStrictEqual(value, Reflect.get(request, key))),
      "unified_exec_raw_command_binding_invalid");
  };
  assertRequest(source);
  const workspacePolicy = structuredClone(store.getApprovalPolicy());
  const snapshot = isRecord(source.requestSnapshot) ? source.requestSnapshot : {};
  const policy = readStoredEffectivePolicySnapshot(snapshot);
  const approvalProfile = readCurrentRunApprovalProfile(store, source);
  const requirement = readRawWorkflowRequirement(store, source);
  const command = request.command.kind === "shell" ? request.command.command : "";
  const fullAccess = validateSelection(snapshot, policy, workspacePolicy, source, store, approvalProfile, command);
  const entry = fullAccess ? UNIFIED_EXEC_FULL_ACCESS_ACTOR_ENTRY : UNIFIED_EXEC_RAW_ACTOR_ENTRY;
  const check = (): void => {
    signal?.throwIfAborted();
    store.readSnapshot(() => {
      const current = store.getRun(source.id);
      requireSource(current?.status === "running" && source.workUnitId === fence.workUnitId
        && store.isCurrentRunExecutionOwner(source.id, fence), "stale_run_execution");
      assertRequest(current);
      requireSource((["cwd", "taskId", "workUnitId", "channelId", "threadId", "teammateId", "workflowStepId"] as const)
        .every(key => current[key] === source[key]) && isDeepStrictEqual(current.requestSnapshot, source.requestSnapshot)
        && request.runId === source.id && request.taskId === source.taskId && approvalRequest.task.id === source.taskId
        && request.toolCallId === approvalRequest.toolCallId && approvalRequest.toolName === "bash"
        && request.command.kind === "shell" && isRecord(approvalRequest.input)
        && request.command.command === approvalRequest.input.command,
        "unified_exec_raw_source_changed");
      const currentPolicy = store.getApprovalPolicy();
      requireSource(isDeepStrictEqual(currentPolicy, workspacePolicy) && currentPolicy.toolDecisions.bash !== "deny",
        "unified_exec_raw_policy_changed");
      const currentProfile = readCurrentRunApprovalProfile(store, current);
      requireSource(isDeepStrictEqual(currentProfile, approvalProfile), "unified_exec_raw_profile_changed");
      requireSource(isDeepStrictEqual(readRawWorkflowRequirement(store, current), requirement), "unified_exec_raw_requirement_changed");
      requireSource(validateSelection(snapshot, policy, currentPolicy, current, store, currentProfile, command) === fullAccess,
        "unified_exec_raw_selection_changed");
      if (policy) assertCommandLaunchApproval({ store, source, fence, request: approvalRequest, policy, approvalId,
        extraSecrets: secrets, approvalProfile: currentProfile, delegatedRequirementFingerprint: requirement?.fingerprint,
        codePrefix: "unified_exec_raw" });
    });
  };
  check();
  let consumed = false;
  const dispatch = Object.freeze({
    assertMayLaunch(): void {
      requireSource(!consumed, "unified_exec_raw_launch_already_consumed");
      check();
      entry.assertMayInvoke(undefined);
    },
    spawn(environment: NodeJS.ProcessEnv, onProducerEntered: () => void): ChildProcessWithoutNullStreams {
      requireSource(this === dispatch && !consumed && typeof onProducerEntered === "function", "unified_exec_raw_launch_invalid");
      consumed = true; // Never replay a refused, thrown or post-spawn failed invocation.
      const token = Object.freeze({});
      ownedLaunches.set(token, { entryId: entry.entryId as RawLaunch["entryId"], request,
        environment: { ...environment }, assertCurrent: check, onProducerEntered });
      try { return entry.invoke(undefined, token); }
      finally { ownedLaunches.delete(token); }
    },
  });
  return dispatch;
}

/** Untyped delegated steps also carry required-evidence lineage. They are not ordinary unowned text. */
function readRawWorkflowRequirement(store: RunStore, run: RunSession) {
  requireSource(validateWorkflowOperationRunContext({ store, run }).status === "legacy", "unified_exec_raw_workflow_source_invalid");
  const snapshot = isRecord(run.requestSnapshot) ? run.requestSnapshot : {};
  const requirement = snapshot.delegatedRequirement;
  const step = run.workflowStepId ? store.getChannelWorkflowStep(run.workflowStepId) : undefined;
  const current = step?.metadata?.delegatedRequirement;
  if (requirement === undefined && current === undefined) return undefined;
  requireSource(step && step.runId === run.id && step.toParticipantId === run.teammateId
    && store.getChannelWorkflow(step.workflowId)?.channelId === run.channelId
    && isDelegatedStepRequirementV1(requirement) && isDelegatedStepRequirementV1(current)
    && requirement.workflowId === step.workflowId && requirement.workflowStepId === step.id
    && requirement.participantId === step.toParticipantId && isDeepStrictEqual(requirement, current),
    "unified_exec_raw_requirement_invalid");
  return structuredClone(current);
}

/** Invalid Full Access claims are refusals, never a downgrade to permissive ordinary raw execution. */
function validateSelection(snapshot: Record<string, unknown>, policy: EffectiveRunPolicySnapshot | undefined,
  workspacePolicy: ReturnType<RunStore["getApprovalPolicy"]>, run: RunSession, store: RunStore,
  approvalProfile: SkillApprovalProfile | undefined, command: string): boolean {
  const authorizationMode = snapshot.authorizationMode, workspaceAccessMode = snapshot.workspaceAccessMode;
  const permissionMode = snapshot.permissionMode, permissionPreset = snapshot.permissionPreset;
  requireSource((authorizationMode === undefined || typeof authorizationMode === "string" && isAuthorizationMode(authorizationMode))
    && (workspaceAccessMode === undefined || typeof workspaceAccessMode === "string" && isWorkspaceAccessMode(workspaceAccessMode))
    && (permissionMode === undefined || typeof permissionMode === "string" && isSessionPermissionMode(permissionMode))
    && (permissionPreset === undefined || typeof permissionPreset === "string" && isPermissionPreset(permissionPreset)),
    "unified_exec_raw_selection_invalid");
  const legacy = authorizationAndAccessFromLegacyPermission(permissionMode, permissionPreset);
  const access = workspaceAccessMode ?? legacy.workspaceAccessMode;
  const fullAccessClaimed = access === "full_access" || policy?.workspaceAccessMode === "full_access"
    || policy?.mode === "full_access" || (isRecord(snapshot.effectivePolicySnapshot)
      && (snapshot.effectivePolicySnapshot.workspaceAccessMode === "full_access" || snapshot.effectivePolicySnapshot.mode === "full_access"));
  const threadMode = run.threadId ? store.getLingThread(run.threadId)?.conversationMode.mode : undefined;
  const planActive = threadMode === "plan" || snapshot.conversationMode === "plan" || policy?.conversationMode === "plan"
    || policy?.planModeMutationPolicy === "deny_repo_tracked_mutation";
  // Reuse the existing per-command Plan denial. This projection can only deny,
  // never authorize a command or claim that a raw shell is OS-isolated.
  const planDenial = planActive ? evaluatePlanModeApprovalDenial({ actionType: "bash",
    effectivePolicySnapshot: { ...(policy ?? resolveSessionRunPolicy({ workspacePolicy }).snapshot), conversationMode: "plan" },
    payload: { type: "bash", cwd: run.cwd, command, riskFlags: [] } }) : undefined;
  requireSource(!planDenial && access !== "read_only", "unified_exec_raw_operation_denied");
  requireSource(snapshot.effectivePolicySnapshot === undefined || policy, "unified_exec_raw_policy_invalid");
  if (policy) {
    requireSource(policy.workspacePolicyUpdatedAt === workspacePolicy.updatedAt
      && Number.isFinite(Date.parse(policy.workspacePolicyUpdatedAt)) && Date.parse(policy.workspacePolicyUpdatedAt) <= Date.now()
      && policy.toolDecisions.bash !== "deny" && policy.workspaceAccessMode !== "read_only"
      && [...readOnlyRunTools, ...riskyRunTools].every(tool => ["allow", "ask", "deny"].includes(policy.toolDecisions[tool]))
      && policy.allowedWritePaths.length <= 128, "unified_exec_raw_policy_invalid");
  }
  // Recompute real production selections, not caller-provided effective grants.
  // Old policy-only internal fixtures are controlled; they cannot claim the
  // Full Access exclusion or elevate a requested independent selection.
  if (policy && (fullAccessClaimed || authorizationMode !== undefined || workspaceAccessMode !== undefined
    || permissionMode !== undefined || permissionPreset !== undefined)) {
    const expected = resolveSessionRunPolicy({ workspacePolicy, authorizationMode, workspaceAccessMode,
      permissionMode, permissionPreset, channelBoundPath: run.channelId ? store.getChannel(run.channelId)?.boundPath || run.cwd : run.cwd,
      approvalProfile }).snapshot;
    requireSource(expected.workspaceAccessMode === policy.workspaceAccessMode
      && expected.authorizationMode === policy.authorizationMode && expected.mode === policy.mode
      && isDeepStrictEqual(expected.allowedWritePaths, policy.allowedWritePaths)
      && [...readOnlyRunTools, ...riskyRunTools].every(tool => expected.toolDecisions[tool] === policy.toolDecisions[tool]),
      "unified_exec_raw_effective_policy_invalid");
  }
  if (!fullAccessClaimed) return false;
  requireSource(policy && access === "full_access" && policy.workspaceAccessMode === "full_access"
    && policy.authorizationMode !== undefined, "unified_exec_raw_full_access_source_invalid");
  const confirmation = snapshot.permissionConfirmation;
  requireSource(isRecord(confirmation) && confirmation.mode === "full_access" && confirmation.confirmed === true
    && typeof confirmation.reason === "string" && confirmation.reason.trim()
    && typeof confirmation.confirmedAt === "string" && Number.isFinite(Date.parse(confirmation.confirmedAt))
    && Date.parse(confirmation.confirmedAt) <= Date.now(), "unified_exec_raw_full_access_confirmation_required");
  return true;
}
