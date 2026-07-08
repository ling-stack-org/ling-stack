import {
  isRiskyRunTool,
  type Channel,
  type ChannelWorkflow,
  type ChannelWorkflowStep,
  type RunStore,
  type RunTool,
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
  | "read_only_parallel_allowed";

export interface SmartSchedulingDecision {
  readonly schedulingMode: "smart";
  readonly effectiveMode: SmartSchedulingEffectiveMode;
  readonly parallelLimit: number;
  readonly runnableStepIds: readonly string[];
  readonly queuedStepIds: readonly string[];
  readonly reasonCodes: readonly SmartSchedulingReasonCode[];
  readonly resourceLocks: readonly string[];
  readonly safetyEvidence: "complete" | "partial" | "unknown";
}

export interface ResolveSmartSchedulingDecisionInput {
  readonly store: RunStore;
  readonly channel?: Channel;
  readonly workflow: ChannelWorkflow;
  readonly steps: readonly ChannelWorkflowStep[];
  readonly eligibleSteps: readonly ChannelWorkflowStep[];
  readonly activeStepCount: number;
}

export function resolveSmartSchedulingDecision(input: ResolveSmartSchedulingDecisionInput): SmartSchedulingDecision {
  const channel = input.channel;
  const maxConcurrentRuns = Math.max(channel?.runtimePolicy.maxConcurrentRuns ?? 1, 1);
  const resourceLocks = channel
    ? [
        `channel_parallel:${channel.id}:limit:${maxConcurrentRuns}`,
        `write_lock_scope:${channel.runtimePolicy.writeLockScope}`,
      ]
    : [];
  const base = {
    schedulingMode: "smart" as const,
    resourceLocks,
  };

  if (!channel) {
    return serialDecision(base, input, 1, ["channel_missing_serial"], "unknown");
  }
  if (input.eligibleSteps.length === 0) {
    return serialDecision(base, input, 1, ["no_eligible_steps"], "complete");
  }
  if (maxConcurrentRuns <= 1) {
    return serialDecision(base, input, 1, ["max_concurrent_runs_one"], "complete");
  }
  if (input.eligibleSteps.length === 1) {
    return serialDecision(base, input, 1, ["eligible_step_count_one"], "complete");
  }
  if (!channel.runtimePolicy.allowReadOnlyParallel) {
    return serialDecision(base, input, 1, ["read_only_parallel_disabled"], "complete");
  }
  if (input.eligibleSteps.some((step) => needsPreStepApproval(input.store, step))) {
    return serialDecision(base, input, 1, ["approval_pending"], "complete");
  }

  const toolSafety = input.eligibleSteps.map((step) => resolveStepToolSafety(input.store, step));
  if (toolSafety.some((safety) => safety.kind === "unknown")) {
    return serialDecision(base, input, 1, ["unknown_tools_serial"], "unknown");
  }
  if (toolSafety.some((safety) => safety.kind === "side_effectful")) {
    return serialDecision(base, input, 1, ["side_effectful_step_serial"], "complete");
  }

  const workflowParallelLimit = Math.max(1, ...input.eligibleSteps.map((step) => step.metadata?.maxParallelSiblings ?? 1));
  if (workflowParallelLimit <= 1) {
    return serialDecision(base, input, 1, ["workflow_parallel_limit_one"], "complete");
  }

  const parallelLimit = Math.max(1, Math.min(maxConcurrentRuns, workflowParallelLimit));
  const availableBudget = Math.max(parallelLimit - input.activeStepCount, 0);
  const runnableStepIds = input.eligibleSteps.slice(0, availableBudget).map((step) => step.id);
  return {
    ...base,
    effectiveMode: parallelLimit > 1 ? "parallel" : "serial",
    parallelLimit,
    runnableStepIds,
    queuedStepIds: queuedStepIds(input.eligibleSteps, runnableStepIds),
    reasonCodes: availableBudget > 0
      ? ["smart_scheduling", "read_only_parallel_allowed"]
      : ["smart_scheduling", "read_only_parallel_allowed", "active_step_budget_exhausted"],
    safetyEvidence: "complete",
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

function serialDecision(
  base: Pick<SmartSchedulingDecision, "schedulingMode" | "resourceLocks">,
  input: ResolveSmartSchedulingDecisionInput,
  parallelLimit: number,
  reasonCodes: readonly SmartSchedulingReasonCode[],
  safetyEvidence: SmartSchedulingDecision["safetyEvidence"],
): SmartSchedulingDecision {
  const availableBudget = Math.max(parallelLimit - input.activeStepCount, 0);
  const runnableStepIds = input.eligibleSteps.slice(0, availableBudget).map((step) => step.id);
  return {
    ...base,
    effectiveMode: "serial",
    parallelLimit,
    runnableStepIds,
    queuedStepIds: queuedStepIds(input.eligibleSteps, runnableStepIds),
    reasonCodes: ["smart_scheduling", ...reasonCodes],
    safetyEvidence,
  };
}

function queuedStepIds(eligibleSteps: readonly ChannelWorkflowStep[], runnableStepIds: readonly string[]): readonly string[] {
  const runnable = new Set(runnableStepIds);
  return eligibleSteps.filter((step) => !runnable.has(step.id)).map((step) => step.id);
}

function needsPreStepApproval(store: RunStore, step: ChannelWorkflowStep): boolean {
  const approvalGate = step.metadata?.approvalGate;
  if (!approvalGate || approvalGate.mode === "none") {
    return false;
  }
  const approval = step.metadata?.preStepApprovalId ? store.getApprovalRequest(step.metadata.preStepApprovalId) : undefined;
  return approval?.status !== "approved";
}

function resolveStepToolSafety(
  store: RunStore,
  step: ChannelWorkflowStep,
): { readonly kind: "read_only" | "side_effectful" | "unknown"; readonly tools?: readonly RunTool[] } {
  const tools = resolveStepTools(store, step);
  if (!tools) {
    return { kind: "unknown" };
  }
  if (tools.some(isRiskyRunTool)) {
    return { kind: "side_effectful", tools };
  }
  return { kind: "read_only", tools };
}

function resolveStepTools(store: RunStore, step: ChannelWorkflowStep): readonly RunTool[] | undefined {
  const requiredTools = step.metadata?.requiredTools;
  if (requiredTools && requiredTools.length > 0) {
    return requiredTools;
  }
  const skillId = step.metadata?.skillId;
  if (!skillId) {
    return undefined;
  }
  const skill = listExecutableSkillDefinitions(store).find((candidate) => candidate.id === skillId);
  return skill ? skill.requiredTools : undefined;
}
