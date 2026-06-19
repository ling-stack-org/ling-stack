import {
  type ChannelStoreFacet,
  type ChannelWorkflow,
  type ChannelWorkflowStep,
  type WorkflowSelectorAlternative,
  type WorkflowSelectorDecision,
} from "@ling-stack/core";
import { isLingAgentExecutorId } from "./ling-agent-executor.js";

export function ensureDeterministicWorkflowSelectorDecision(input: {
  readonly store: ChannelStoreFacet;
  readonly workflow: ChannelWorkflow;
  readonly selectedStep: ChannelWorkflowStep;
  readonly eligibleSteps: readonly ChannelWorkflowStep[];
  readonly now: string;
}): {
  readonly decision: WorkflowSelectorDecision;
  readonly workflowStep: ChannelWorkflowStep;
} {
  const existingDecision = findExistingAcceptedStepDecision(input.store, input.selectedStep);
  if (existingDecision) {
    return { decision: existingDecision, workflowStep: input.selectedStep };
  }

  const alternatives = input.eligibleSteps
    .filter((step) => step.id !== input.selectedStep.id)
    .map((step): WorkflowSelectorAlternative => ({
      targetKind: "workflow_step",
      targetId: step.id,
      label: step.title,
      reason: `Eligible workflow step for ${step.toParticipantLabel}.`,
    }));

  const decision = input.store.createWorkflowSelectorDecision(
    {
      channelId: input.workflow.channelId,
      workflowId: input.workflow.id,
      targetKind: "workflow_step",
      selectedWorkflowStepId: input.selectedStep.id,
      selectedGraphNodeId: input.selectedStep.metadata?.graphNodeId,
      ...(isLingAgentExecutorId(input.selectedStep.toParticipantId) ? {} : { selectedTeammateId: input.selectedStep.toParticipantId }),
      selectedSkillId: input.selectedStep.metadata?.skillId,
      reason: alternatives.length === 0
        ? `Only eligible step: ${input.selectedStep.title}.`
        : `Selected ${input.selectedStep.title} from ${alternatives.length + 1} eligible steps by deterministic workflow order.`,
      alternativesConsidered: alternatives,
      confidence: "high",
      requiresUserConfirmation: false,
      status: "accepted",
      sourceRefs: [
        { type: "workflow", id: input.workflow.id, label: input.workflow.title },
        { type: "workflow_step", id: input.selectedStep.id, label: input.selectedStep.title },
      ],
      createdBy: "deterministic",
    },
    input.now,
  );

  const latestStep = input.store.getChannelWorkflowStep(input.selectedStep.id) ?? input.selectedStep;
  const workflowStep = input.store.updateChannelWorkflowStep(
    latestStep.id,
    {
      metadata: {
        ...latestStep.metadata,
        selectorDecisionIds: uniqueStrings([
          ...(latestStep.metadata?.selectorDecisionIds ?? []),
          decision.id,
        ]),
      },
    },
    input.now,
  ) ?? latestStep;

  return { decision, workflowStep };
}

function findExistingAcceptedStepDecision(store: ChannelStoreFacet, step: ChannelWorkflowStep): WorkflowSelectorDecision | undefined {
  for (const decisionId of step.metadata?.selectorDecisionIds ?? []) {
    const decision = store.getWorkflowSelectorDecision(decisionId);
    if (decision?.status === "accepted" && decision.selectedWorkflowStepId === step.id) {
      return decision;
    }
  }
  return store.listWorkflowSelectorDecisions({
    workflowId: step.workflowId,
    selectedWorkflowStepId: step.id,
    status: "accepted",
    limit: 1,
  })[0];
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}
