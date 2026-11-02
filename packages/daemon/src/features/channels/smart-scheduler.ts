import {
  isRiskyRunTool,
  inspectWorkflowPreApproval,
  classifyWorkflowStepStartOwner,
  workflowStepStartOwnerMatches,
  type Channel,
  type ChannelWorkflow,
  type ChannelWorkflowStep,
  type RunSession,
  type RunStore,
  type RunTool,
  type WorkflowStepStartOwnerV1,
} from "@ling-stack/core";
import { listExecutableSkillDefinitions } from "../skills/registry.js";

export type SmartSchedulingEffectiveMode = "serial" | "parallel";

export type SmartSchedulingReasonCode =
  | "smart_scheduling"
  | "channel_missing_serial"
  | "max_concurrent_runs_one"
  | "no_eligible_steps"
  | "eligible_step_count_one"
  | "active_step_budget_exhausted"
  | "read_only_parallel_disabled"
  | "workflow_parallel_limit_one"
  | "approval_pending"
  | "unknown_tools_serial"
  | "side_effectful_step_serial"
  | "safety_opt_in_required"
  | "host_parallel_capability_unavailable"
  | "active_step_safety_unverified"
  | "resource_conflict"
  | "read_only_parallel_allowed";

export interface SmartSchedulingDecision {
  readonly schedulingMode: "smart";
  readonly effectiveMode: SmartSchedulingEffectiveMode;
  readonly parallelLimit: number;
  readonly runnableStepIds: readonly string[];
  readonly approvalStepIds: readonly string[];
  readonly queuedStepIds: readonly string[];
  readonly reasonCodes: readonly SmartSchedulingReasonCode[];
  readonly resourceLocks: readonly string[];
  readonly safetyEvidence: "complete" | "partial" | "unknown";
}

export interface WorkflowParallelCapabilityInput {
  readonly store: RunStore;
  readonly channel: Channel;
  readonly workflow: ChannelWorkflow;
  readonly step: ChannelWorkflowStep;
  readonly tools: readonly RunTool[];
  readonly run?: RunSession;
  readonly runRequest?: import("./workflows.js").WorkflowStepRunRequest;
}

/** Host evidence, not a declaration inferred from a prompt or a tool name. */
export interface WorkflowParallelCapability {
  readonly verified: true;
  /** Canonical exclusive keys derived by Host; declarations can only add keys. */
  readonly resourceKeys: readonly string[];
  /** Total concurrent limit after Host provider/runner/workspace constraints. */
  readonly parallelLimit?: number;
}

export type ResolveWorkflowParallelCapability = (
  input: WorkflowParallelCapabilityInput,
) => WorkflowParallelCapability | undefined;

export interface ResolveSmartSchedulingDecisionInput {
  readonly store: RunStore;
  readonly channel?: Channel;
  readonly workflow: ChannelWorkflow;
  readonly steps: readonly ChannelWorkflowStep[];
  readonly eligibleSteps: readonly ChannelWorkflowStep[];
  readonly activeStepCount?: number;
  readonly resolveParallelCapability?: ResolveWorkflowParallelCapability;
  /** Dispatch revalidation only: the exact generation already admitted by Core begin. */
  readonly preparedStartOwner?: WorkflowStepStartOwnerV1;
}

export function resolveSmartSchedulingDecision(input: ResolveSmartSchedulingDecisionInput): SmartSchedulingDecision {
  const channel = input.channel;
  const maxConcurrentRuns = positiveLimit(channel?.runtimePolicy.maxConcurrentRuns);
  const resourceLocks = channel
    ? [
        `channel_parallel:${channel.id}:limit:${maxConcurrentRuns}`,
        `write_lock_scope:${channel.runtimePolicy.writeLockScope}`,
      ]
    : [];
  const eligible = [...input.eligibleSteps].filter(step => step.metadata?.autoStart !== false).sort(compareSteps);
  const active = input.steps.filter(step => isWorkflowStepExecutionActive(input.store, step));
  const activeStepCount = Math.max(active.length, input.activeStepCount ?? 0);
  const reasons = new Set<SmartSchedulingReasonCode>(["smart_scheduling"]);
  const runnableStepIds: string[] = [];
  const approvalStepIds: string[] = [];
  let parallelLimit = Math.min(maxConcurrentRuns, input.workflow.metadata?.maxParallelSteps === undefined
    ? maxConcurrentRuns : positiveLimit(input.workflow.metadata.maxParallelSteps));
  let safetyEvidence: SmartSchedulingDecision["safetyEvidence"] = "complete";
  let parallel = Boolean(channel?.runtimePolicy.allowReadOnlyParallel && input.resolveParallelCapability);
  const heldResources = new Set<string>();
  const now = new Date().toISOString();

  const finish = (): SmartSchedulingDecision => ({
    schedulingMode: "smart",
    resourceLocks: [...new Set([...resourceLocks, ...heldResources])],
    effectiveMode: parallel && parallelLimit > 1 ? "parallel" : "serial",
    parallelLimit,
    runnableStepIds,
    approvalStepIds,
    queuedStepIds: queuedStepIds(eligible, runnableStepIds),
    reasonCodes: [...reasons],
    safetyEvidence,
  });
  if (!channel) {
    parallel = false;
    reasons.add("channel_missing_serial");
    safetyEvidence = "unknown";
  } else if (maxConcurrentRuns <= 1) {
    reasons.add("max_concurrent_runs_one");
  } else if (!channel.runtimePolicy.allowReadOnlyParallel) {
    reasons.add("read_only_parallel_disabled");
  }
  if (eligible.length === 0) reasons.add("no_eligible_steps");
  if (["succeeded", "failed", "cancelled", "blocked"].includes(input.workflow.status)
    || input.workflow.status === "waiting_for_approval"
      && (!input.steps.some(step => isIndependentWorkflowPreApprovalWait(input.store, step))
        || input.steps.some(step => step.status === "waiting_for_approval" && step.metadata?.activeGateStage === "post"))) {
    parallel = false;
    parallelLimit = 1;
    reasons.add("approval_pending");
    return finish();
  }
  const hasPreApprovalWait = input.steps.some(step => isIndependentWorkflowPreApprovalWait(input.store, step));
  if (hasPreApprovalWait) reasons.add("approval_pending");
  // Caller counts can tighten admission but can never hide actual preparing/active siblings.
  if (activeStepCount !== active.length) parallel = false;
  for (const step of active) {
    const safety = resolveStepParallelSafety(input, step);
    if (!safety.capability) {
      parallel = false;
      reasons.add("active_step_safety_unverified");
      safetyEvidence = "partial";
    } else {
      parallelLimit = Math.min(parallelLimit, safety.limit);
      for (const key of safety.resources) heldResources.add(key);
    }
  }
  if (!parallel) parallelLimit = 1;
  if (activeStepCount >= parallelLimit) {
    reasons.add("active_step_budget_exhausted");
    return finish();
  }

  let earlierApproval = hasPreApprovalWait;
  for (const step of eligible) {
    const approval = inspectSchedulingPreApproval(input, step, now);
    if (approval.status !== "not_required" && approval.status !== "approved") {
      reasons.add("approval_pending");
      earlierApproval = true;
      if (approval.status !== "pending" && approval.status !== "blocked") approvalStepIds.push(step.id);
      continue;
    }
    const safety = resolveStepParallelSafety(input, step);
    if (earlierApproval && !safety.capability) continue;
    const sharing = activeStepCount + runnableStepIds.length > 0;
    if (!safety.capability || !parallel) {
      if (sharing) continue;
      parallel = false;
      parallelLimit = 1;
      reasons.add(safety.reason ?? "host_parallel_capability_unavailable");
      if (safety.reason === "unknown_tools_serial") safetyEvidence = "unknown";
      runnableStepIds.push(step.id);
      break;
    }
    const nextLimit = Math.min(parallelLimit, safety.limit);
    if (activeStepCount + runnableStepIds.length >= nextLimit) {
      reasons.add("workflow_parallel_limit_one");
      continue;
    }
    if (safety.resources.some(key => heldResources.has(key))) {
      reasons.add("resource_conflict");
      continue;
    }
    parallelLimit = nextLimit;
    for (const key of safety.resources) heldResources.add(key);
    runnableStepIds.push(step.id);
    reasons.add("read_only_parallel_allowed");
    if (activeStepCount + runnableStepIds.length >= parallelLimit) break;
  }
  if (!parallel && runnableStepIds.length === 0) approvalStepIds.splice(1);
  if (activeStepCount + runnableStepIds.length >= parallelLimit && eligible.length > runnableStepIds.length) {
    reasons.add("active_step_budget_exhausted");
  }
  return finish();
}

function inspectSchedulingPreApproval(input: ResolveSmartSchedulingDecisionInput, step: ChannelWorkflowStep, now: string) {
  const owner = input.preparedStartOwner;
  const marker = step.metadata?.preStepApprovalMarker;
  if (owner && marker?.consumedByTaskId === owner.taskId) {
    const ownership = classifyWorkflowStepStartOwner(input.store, step, now);
    if (ownership.status === "preparing" && workflowStepStartOwnerMatches(ownership.owner, owner)) {
      // Reinspect the original approval for this admitted owner, never grant another start.
      return inspectWorkflowPreApproval(input.store, { ...step, metadata: { ...step.metadata,
        preStepApprovalMarker: { basis: marker.basis } } }, now);
    }
  }
  return inspectWorkflowPreApproval(input.store, step, now);
}

export function isWorkflowStepExecutionActive(store: RunStore, step: ChannelWorkflowStep): boolean {
  if (step.metadata?.startOwner?.phase === "preparing" || step.status === "claimed") return true;
  const run = step.runId ? store.getRun(step.runId) : undefined;
  if (run && !["succeeded", "failed", "cancelled"].includes(run.status)) return true;
  return ["running", "waiting_for_approval", "waiting_for_input"].includes(step.status)
    && Boolean(step.taskId || step.runId);
}

export function isIndependentWorkflowPreApprovalWait(store: RunStore, step: ChannelWorkflowStep): boolean {
  if (step.status !== "waiting_for_approval" || step.taskId || step.runId || step.metadata?.startOwner
    || step.metadata?.activeGateStage === "post" || !step.metadata?.preStepApprovalId) return false;
  const approval = store.getApprovalRequest(step.metadata.preStepApprovalId);
  return approval?.status === "pending" && approval.workflowStepId === step.id && approval.channelId === step.channelId
    && approval.payload.type === "workflow_step" && approval.payload.gateStage === "pre"
    && approval.payload.workflowId === step.workflowId && approval.payload.workflowStepId === step.id;
}

function resolveStepParallelSafety(input: ResolveSmartSchedulingDecisionInput, step: ChannelWorkflowStep): {
  readonly capability?: WorkflowParallelCapability;
  readonly reason?: SmartSchedulingReasonCode;
  readonly limit: number;
  readonly resources: readonly string[];
} {
  const blocked = (reason: SmartSchedulingReasonCode) => ({ reason, limit: 1, resources: [] });
  const tools = resolveStepTools(input.store, step);
  if (!tools) return blocked("unknown_tools_serial");
  if (tools.some(isRiskyRunTool)) return blocked("side_effectful_step_serial");
  if (step.metadata?.sideEffectClass !== "analysis_readonly" || step.metadata.parallelPolicy?.autoParallel !== true) {
    return blocked("safety_opt_in_required");
  }
  if (!input.channel || !input.resolveParallelCapability) return blocked("host_parallel_capability_unavailable");
  let capability: WorkflowParallelCapability | undefined;
  try {
    capability = input.resolveParallelCapability({ store: input.store, channel: input.channel, workflow: input.workflow,
      step, tools, run: step.runId ? input.store.getRun(step.runId) : undefined });
  } catch {
    return blocked("host_parallel_capability_unavailable");
  }
  const declaredResources = step.metadata.parallelPolicy.resourceKeys ?? [];
  if (capability?.verified !== true || !validResourceKeys(capability.resourceKeys) || !validResourceKeys(declaredResources)) {
    return blocked("host_parallel_capability_unavailable");
  }
  const limits = [step.metadata.parallelPolicy.maxParallelSiblings, step.metadata.maxParallelSiblings, capability.parallelLimit]
    .filter((limit): limit is number => limit !== undefined);
  return {
    capability,
    limit: limits.length > 0 ? Math.min(...limits.map(positiveLimit)) : 1,
    resources: [...new Set([...capability.resourceKeys, ...declaredResources])],
  };
}

export function withSmartSchedulingReason(
  decision: SmartSchedulingDecision,
  reasonCode: SmartSchedulingReasonCode,
): SmartSchedulingDecision {
  return {
    ...decision,
    effectiveMode: reasonCode === "read_only_parallel_allowed" ? decision.effectiveMode : "serial",
    parallelLimit: reasonCode === "read_only_parallel_allowed" ? decision.parallelLimit : 1,
    runnableStepIds: reasonCode === "read_only_parallel_allowed" ? decision.runnableStepIds : [],
    queuedStepIds: reasonCode === "read_only_parallel_allowed"
      ? decision.queuedStepIds
      : [...new Set([...decision.runnableStepIds, ...decision.queuedStepIds])],
    reasonCodes: [...new Set([...decision.reasonCodes, reasonCode])],
    safetyEvidence: reasonCode === "unknown_tools_serial" ? "unknown" : decision.safetyEvidence,
  };
}

function queuedStepIds(eligibleSteps: readonly ChannelWorkflowStep[], runnableStepIds: readonly string[]): readonly string[] {
  const runnable = new Set(runnableStepIds);
  return eligibleSteps.filter((step) => !runnable.has(step.id)).map((step) => step.id);
}

function positiveLimit(value: number | undefined): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : 1;
}

function validResourceKeys(keys: readonly string[]): boolean {
  return Array.isArray(keys) && keys.every(key => typeof key === "string" && key.length > 0 && key.trim() === key);
}

function compareSteps(left: ChannelWorkflowStep, right: ChannelWorkflowStep): number {
  return left.position - right.position || (left.id < right.id ? -1 : left.id === right.id ? 0 : 1);
}

function resolveStepTools(store: RunStore, step: ChannelWorkflowStep): readonly RunTool[] | undefined {
  const requiredTools = step.metadata?.requiredTools;
  const skillId = step.metadata?.skillId;
  const skill = skillId ? listExecutableSkillDefinitions(store).find(candidate => candidate.id === skillId) : undefined;
  if (skillId && !skill || requiredTools === undefined && !skill) return undefined;
  return [...new Set([...(requiredTools ?? []), ...(skill?.requiredTools ?? [])])];
}
