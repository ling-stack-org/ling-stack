import { isWorkflowStepStartOwnerV1, workflowStepStartAuthorityBasis, workflowStepStartOwnerMatches,
  type RunSession } from "@ling-stack/core";
import { isRecord } from "../../shared/validation.js";
import {
  createStartOrchestratedRun,
  type ChannelTurnDispatchExecutorOptions,
} from "../channels/channel-turn-dispatch-executor.js";
import { orchestrateChannelWorkflow } from "../channels/orchestrator.js";
import { resolveProviderForRun } from "./providers.js";

export function createUserInputWorkflowTerminalHook(options: ChannelTurnDispatchExecutorOptions) {
  return async (terminalRun: RunSession): Promise<void> => {
    await options.afterRunTerminal?.(terminalRun);
    if (terminalRun.continuationReason !== "user_input_answer" || terminalRun.status !== "succeeded" || !terminalRun.workflowStepId) return;
    const store = options.storeRegistry.findStoreForRun(terminalRun.id, terminalRun.cwd);
    if (!store) return;
    const run = store.getRun(terminalRun.id), step = store.getChannelWorkflowStep(terminalRun.workflowStepId);
    const owner = isRecord(run?.requestSnapshot) ? run.requestSnapshot.workflowStartOwner : undefined;
    const workflow = step ? store.getChannelWorkflow(step.workflowId) : undefined;
    if (!run || run.status !== "succeeded" || run.continuationReason !== "user_input_answer"
      || !step || step.status !== "succeeded" || step.runId !== run.id || step.taskId !== run.taskId
      || run.workflowStepId !== step.id || !isWorkflowStepStartOwnerV1(owner)
      || !workflowStepStartOwnerMatches(step.metadata?.startOwner, owner)
      || workflowStepStartAuthorityBasis(store, step) !== owner.authorityBasis
      || !workflow || workflow.status !== "running") return;
    await orchestrateChannelWorkflow({ store, cwd: store.paths.cwd, workflowId: workflow.id,
      secretResolver: options.secretResolver,
      validateRunRequest: request => resolveProviderForRun(store, request, options.secretResolver),
      startRun: createStartOrchestratedRun(options, store, store.paths.cwd) });
  };
}
