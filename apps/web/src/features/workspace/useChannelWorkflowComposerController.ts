import { useRef, useState } from "react";
import type { ChannelWorkflow, ChannelWorkflowOrchestrationRequest, ChannelWorkflowStep, RunSession, WorkflowIntegrationRoundEvidenceV1 } from "../../types.js";
import { canRequestWorkflowIsolation } from "../../lib/workflow-isolated-action.js";
import { workflowConflictRecoveryRound, type WorkflowIsolationObservation } from "../../lib/workflow-isolation-evidence.js";

interface WorkflowComposerInput {
  readonly workflows: readonly ChannelWorkflow[];
  readonly steps: readonly ChannelWorkflowStep[];
  readonly runs: readonly RunSession[];
  readonly workflowIds: ReadonlySet<string>;
  readonly activeRunId?: string;
  readonly pendingApproval: boolean;
  readonly observations: ReadonlyMap<string, WorkflowIsolationObservation>;
}

export interface ChannelWorkflowComposerControl {
  readonly workflow: ChannelWorkflow;
  readonly intent?: "start" | "continue" | "stop";
  readonly retryStep?: ChannelWorkflowStep;
  readonly conflictRound?: WorkflowIntegrationRoundEvidenceV1;
  readonly canStartIsolated?: boolean;
}

/** Only durable session membership can select the workflow controlled by the composer. */
export function selectChannelWorkflowComposerControl(input: WorkflowComposerInput): ChannelWorkflowComposerControl | undefined {
  const owned = input.workflows.filter(workflow => input.workflowIds.has(workflow.id));
  const activeRun = input.runs.find(run => run.id === input.activeRunId);
  const activeStep = input.activeRunId ? input.steps.find(step => step.runId === input.activeRunId || step.id === activeRun?.workflowStepId) : undefined;
  const workflow = input.activeRunId
    ? owned.find(candidate => candidate.id === activeStep?.workflowId)
    : [...owned].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))[0];
  if (!workflow) return;
  const control = { workflow };
  if (input.pendingApproval) return control;
  const steps = input.steps.filter(step => step.workflowId === workflow.id && step.channelId === workflow.channelId);
  const active = steps.some(step => step.status === "running" || step.status === "claimed")
    || input.runs.some(run => steps.some(step => step.id === run.workflowStepId || step.runId === run.id)
      && ["queued", "starting", "running"].includes(run.status));
  if (active && !["succeeded", "failed", "cancelled"].includes(workflow.status)) return { ...control, intent: "stop" };
  const observation = input.observations.get(workflow.id);
  const conflictRound = workflowConflictRecoveryRound(workflow, observation);
  if (conflictRound) return { ...control, intent: "continue", conflictRound };
  if (!["ready", "running", "blocked"].includes(workflow.status) || !steps.length) return control;
  if (steps.some(step => step.status === "waiting_for_approval" || step.status === "waiting_for_input")) return control;
  if (observation?.expected && (observation.status !== "loaded" || !observation.isolation
    || observation.isolation.status !== "available" || observation.isolation.gitEffects !== "confirmed"
    || observation.isolation.hostOperationPending)) return control;
  const blocked = steps.filter(step => step.status === "blocked");
  const retryStep = blocked.filter(step => !(step.metadata?.delegatedOutcome?.kind === "blocked"
    && step.metadata.delegatedOutcome.code === "execution_loop_detected") && dependenciesReady(step, steps))
    .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))[0];
  if (retryStep) return { ...control, intent: "continue", retryStep };
  if (blocked.length) return control;
  return { ...control, intent: workflow.status === "ready" ? "start" : "continue",
    canStartIsolated: canRequestWorkflowIsolation(workflow, steps) };
}

function dependenciesReady(step: ChannelWorkflowStep, steps: readonly ChannelWorkflowStep[]): boolean {
  const ids = step.metadata?.dependsOnStepIds ?? [];
  const dependencies = ids.map(id => steps.find(candidate => candidate.id === id));
  if (dependencies.some(dependency => !dependency)) return false;
  const terminal = (dependency: ChannelWorkflowStep | undefined) => Boolean(dependency && ["succeeded", "skipped", "failed", "cancelled"].includes(dependency.status));
  if (step.metadata?.fanInPolicy?.requireAllBranchesTerminal && !dependencies.every(terminal)) return false;
  if (step.metadata?.dependencyMode === "any_succeeded") return !dependencies.length || dependencies.some(dependency => dependency?.status === "succeeded");
  if (step.metadata?.dependencyMode === "all_terminal") return dependencies.every(terminal);
  return dependencies.every(dependency => dependency?.status === "succeeded" || dependency?.status === "skipped");
}

export function useChannelWorkflowComposerController(input: WorkflowComposerInput & {
  readonly ownerKey: string;
  readonly enabled: boolean;
  readonly advanceAllowed: boolean;
  readonly pendingWorkflowId?: string;
  readonly pendingStepId?: string;
  readonly onOrchestrate: (workflow: ChannelWorkflow, request?: ChannelWorkflowOrchestrationRequest) => Promise<void>;
  readonly onRetry: (step: ChannelWorkflowStep) => Promise<void>;
  readonly onCancel: (workflow: ChannelWorkflow) => Promise<void>;
  readonly onRecoverConflict: (workflowId: string, roundId: string, generation: number, revision: number) => Promise<void>;
  readonly onError: (message: string) => void;
}) {
  const flight = useRef(new Set<string>());
  const currentOwner = useRef({ key: input.ownerKey });
  if (currentOwner.current.key !== input.ownerKey) currentOwner.current = { key: input.ownerKey };
  const owner = currentOwner.current;
  const [busyOwners, setBusyOwners] = useState<ReadonlySet<string>>(new Set());
  const control = selectChannelWorkflowComposerControl(input);
  const actionPending = input.workflowIds.has(input.pendingWorkflowId ?? "")
    || input.steps.some(step => step.id === input.pendingStepId && input.workflowIds.has(step.workflowId));
  const busy = busyOwners.has(input.ownerKey) || actionPending;

  async function submit(isolated = false): Promise<void> {
    if (!input.enabled || currentOwner.current !== owner || flight.current.has(input.ownerKey) || actionPending || !control?.intent
      || !input.advanceAllowed && control.intent !== "stop" || isolated && !control.canStartIsolated) return;
    const ownerKey = input.ownerKey;
    flight.current.add(ownerKey);
    setBusyOwners(new Set(flight.current));
    try {
      if (isolated) await input.onOrchestrate(control.workflow, { executionProfile: "pi_host_isolated_files_v1" });
      else if (control.intent === "stop") await input.onCancel(control.workflow);
      else if (control.conflictRound) await input.onRecoverConflict(control.workflow.id, control.conflictRound.roundId, control.conflictRound.generation, control.conflictRound.revision);
      else if (control.retryStep) await input.onRetry(control.retryStep);
      else await input.onOrchestrate(control.workflow);
    } catch (error) {
      if (currentOwner.current === owner) input.onError(error instanceof Error ? error.message : String(error));
    } finally {
      flight.current.delete(ownerKey);
      setBusyOwners(new Set(flight.current));
    }
  }

  return { control, busy, submit };
}
