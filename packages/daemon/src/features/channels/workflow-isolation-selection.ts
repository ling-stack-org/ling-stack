import { randomUUID } from "node:crypto";
import { createSqliteWorkflowIsolationStore, type RunStore, type WorkflowIsolationSelection } from "@ling-stack/core";
import { PiRunnerAdapter } from "@ling-stack/runner-pi";
import { HttpError } from "../../errors.js";
import { loadWorkspaceRuntimeSettings } from "../../runtime/runner-settings.js";
import type { RunnerRegistry } from "../../runtime/runners.js";
import { WORKFLOW_CANDIDATE_VALIDATORS } from "./workflow-candidate-validation.js";
import { planWorkflowIsolatedRound } from "./workflow-isolation-planning.js";

export interface WorkflowIsolationHost {
  readonly enabled: () => boolean;
  readonly toolBrokerMode: () => string;
  /** Trusted Host ceiling for a newly selected isolated writing round. */
  readonly maxConcurrentSteps?: () => number;
}

const MIN_ISOLATED_WRITE_STEPS = 2;
const MAX_ISOLATED_WRITE_STEPS = 4;

function hostParallelLimit(host: WorkflowIsolationHost | undefined): number {
  const value = host?.maxConcurrentSteps?.() ?? MIN_ISOLATED_WRITE_STEPS;
  if (!Number.isSafeInteger(value) || value < MIN_ISOLATED_WRITE_STEPS || value > MAX_ISOLATED_WRITE_STEPS) {
    unavailable("workflow_isolation_parallel_limit_invalid", "The Host isolated-files parallel limit is invalid.");
  }
  return value;
}

function validParallelLimit(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value)
    && value >= MIN_ISOLATED_WRITE_STEPS && value <= MAX_ISOLATED_WRITE_STEPS;
}

function unavailable(code: string, message: string): never { throw new HttpError(409, code, message); }

export function assertWorkflowIsolationHost(store: RunStore, runnerRegistry: RunnerRegistry | undefined,
  host: WorkflowIsolationHost | undefined): void {
  if (!host || host.enabled() !== true) unavailable("workflow_isolation_disabled", "The Host isolated-files workflow profile is disabled.");
  if (process.platform !== "darwin") unavailable("workflow_isolation_platform_unavailable", "The isolated-files Host profile requires verified macOS enforcement.");
  if (host.toolBrokerMode() !== "enforce") unavailable("workflow_isolation_broker_required", "Isolated writes require the enforced Host Tool Broker.");
  try {
    if (!runnerRegistry) throw new Error("Runner registry is unavailable.");
    const settings = loadWorkspaceRuntimeSettings(store, runnerRegistry);
    const actual = runnerRegistry.resolve({ requestedRunnerId: "pi", allowFallback: false, allowedRunnerIds: settings.allowedRunnerIds });
    if (actual.effectiveRunnerId !== "pi" || !(actual.runner.adapter instanceof PiRunnerAdapter)) throw new Error("The original Pi adapter is unavailable.");
  } catch { unavailable("workflow_isolation_runner_unavailable", "The registered and workspace-enabled Pi Host adapter is required."); }
}

/** Retained rounds remain observable when the Host disables new execution admission. */
export function assertWorkflowIsolationSelectionIntegrity(store: RunStore, workflowId: string,
  host?: WorkflowIsolationHost): WorkflowIsolationSelection | undefined {
  const isolation = createSqliteWorkflowIsolationStore(store), selection = isolation.getSelection(workflowId);
  if (!selection) return;
  if (selection.phase !== "ready") unavailable("workflow_isolation_planning", "Isolation planning is incomplete. Retry the explicit selection before starting.");
  const round = isolation.getIntegrationRound(selection.roundId);
  const steps = store.listChannelWorkflowSteps({ workflowId, complete: true });
  const parallelLimit = round?.inputs.parallelExecution?.maxConcurrentSteps;
  if (!round || round.inputs.workflowId !== workflowId || round.inputs.mode !== "candidate_only"
    || round.inputs.optionalFailurePolicy !== "require_success" || !validParallelLimit(parallelLimit)
    || host !== undefined && parallelLimit > hostParallelLimit(host)
    || steps.length !== round.inputs.participants.length || steps.some(step => {
      const pin = step.metadata?.isolationScopePlan, plan = pin && isolation.getScopePlan(pin.planId);
      return !plan || plan.planDigest !== pin!.planDigest || plan.workflowStepId !== step.id
        || plan.integrationRoundId !== selection.roundId || plan.generation !== round.generation
        || step.metadata?.safetyPlan?.profile !== selection.profile
        || !round.inputs.participants.some(participant => participant.workflowStepId === step.id);
    })) unavailable("workflow_isolation_selection_changed", "The selected isolation round or complete participant inventory cannot be verified.");
  return selection;
}

/** All production start paths check Host authority before approval, Task or dispatch. */
export function assertWorkflowIsolationSelectionReady(store: RunStore, workflowId: string,
  runnerRegistry?: RunnerRegistry, host?: WorkflowIsolationHost): void {
  if (assertWorkflowIsolationSelectionIntegrity(store, workflowId, host)) assertWorkflowIsolationHost(store, runnerRegistry, host);
}

/** The request selects a fixed Host profile, never a command, path, parallel limit or target-apply permission. */
export async function selectWorkflowIsolatedExecution(input: { readonly store: RunStore; readonly workflowId: string;
  readonly runnerRegistry: RunnerRegistry; readonly host: WorkflowIsolationHost }): Promise<void> {
  assertWorkflowIsolationHost(input.store, input.runnerRegistry, input.host);
  if (!input.store.getChannelWorkflow(input.workflowId)) throw new HttpError(404, "workflow_not_found", "Workflow not found.");
  const isolation = createSqliteWorkflowIsolationStore(input.store);
  const maxConcurrentSteps = hostParallelLimit(input.host);
  const selected = isolation.beginSelection({ workflowId: input.workflowId, roundId: `wir_${randomUUID()}`, now: new Date().toISOString() });
  if (!("value" in selected)) unavailable(selected.code, "Isolation must be explicitly selected before any step approval or start.");
  if (selected.value.phase === "planning") await planWorkflowIsolatedRound({ store: input.store,
    workflowId: input.workflowId, roundId: selected.value.roundId, mode: "candidate_only", optionalFailurePolicy: "require_success",
    parallelExecution: { profile: "isolated_siblings_v1", maxConcurrentSteps, writeLockScope: "boundPath" },
    validationRequirements: WORKFLOW_CANDIDATE_VALIDATORS.map(({ id, fingerprint }) => ({ id, fingerprint })) });
  assertWorkflowIsolationSelectionReady(input.store, input.workflowId, input.runnerRegistry, input.host);
}
