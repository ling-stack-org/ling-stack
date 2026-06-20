import {
  type AiTeammate,
  type Channel,
  type ChannelExecutionProposal,
  type ChannelExecutionProposalStep,
  type ResponseLanguage,
  type ChannelWorkflow,
  type ChannelWorkflowStep,
  type RunStore,
  type WorkflowGraph,
  type WorkflowGraphNode,
} from "@ling-stack/core";
import { HttpError } from "../../errors.js";
import type { RunnerRegistry } from "../../runtime/runners.js";
import { teammateCanWorkInEffectiveChannel } from "./channel-teammate-availability.js";
import { responseLanguageInstruction } from "./response-language.js";
import { createLingAgentExecutor, isLingAgentExecutorId } from "./ling-agent-executor.js";
import { compileWorkflowGraph } from "./workflow-graph.js";
import type { ValidateWorkflowStepRunRequest, WorkflowStepRunRequest } from "./workflows.js";

export interface ConfirmChannelExecutionProposalWorkflowInput {
  readonly store: RunStore;
  readonly cwd: string;
  readonly proposalId: string;
  readonly runnerRegistry?: RunnerRegistry;
  readonly validateRunRequest: ValidateWorkflowStepRunRequest;
  readonly now?: string;
}

export interface ConfirmChannelExecutionProposalWorkflowResult {
  readonly proposal: ChannelExecutionProposal;
  readonly workflow: ChannelWorkflow;
  readonly workflowSteps: readonly ChannelWorkflowStep[];
}

type ProposalParticipant = {
  readonly step: ChannelExecutionProposalStep;
  readonly teammate: AiTeammate;
  readonly providerPresetId?: string;
};

const confirmableProposalStatuses = new Set<ChannelExecutionProposal["status"]>(["draft", "blocked", "run_failed"]);

export function confirmChannelExecutionProposalWorkflow(
  input: ConfirmChannelExecutionProposalWorkflowInput,
): ConfirmChannelExecutionProposalWorkflowResult {
  const now = input.now ?? new Date().toISOString();
  const proposal = input.store.getChannelExecutionProposal(input.proposalId);
  if (!proposal) {
    throw new HttpError(404, "proposal_not_found", `Channel proposal not found: ${input.proposalId}`);
  }

  const existing = existingLinkedWorkflow(input.store, proposal);
  if (existing && proposal.status === "accepted") {
    return existing;
  }

  try {
    return confirmChannelExecutionProposalWorkflowOrThrow(input, proposal, now);
  } catch (error) {
    if (error instanceof HttpError && error.statusCode !== 404) {
      input.store.updateChannelExecutionProposal(proposal.id, {
        status: "blocked",
        errorMessage: error.message,
      }, now);
    }
    throw error;
  }
}

function confirmChannelExecutionProposalWorkflowOrThrow(
  input: ConfirmChannelExecutionProposalWorkflowInput,
  proposal: ChannelExecutionProposal,
  now: string,
): ConfirmChannelExecutionProposalWorkflowResult {
  if (!confirmableProposalStatuses.has(proposal.status)) {
    throw new HttpError(409, "proposal_not_confirmable", `Proposal cannot be confirmed from status: ${proposal.status}`);
  }
  const channel = input.store.getChannel(proposal.channelId);
  if (!channel) {
    throw new HttpError(404, "channel_not_found", `Channel not found: ${proposal.channelId}`);
  }
  if (channel.status !== "active") {
    throw new HttpError(400, "channel_not_active", `Channel is ${channel.status}; resume it before starting a workflow.`);
  }

  const participants = resolveProposalParticipants(input.store, channel, proposal);
  validateProposalRequiredTools(channel, proposal, participants);
  for (const participant of participants) {
    input.validateRunRequest(buildValidationRunRequest(input.cwd, channel, proposal, participant));
  }

  const graph = buildProposalWorkflowGraph(proposal, participants);
  const responseLanguage = proposalResponseLanguage(proposal);
  const compiled = compileWorkflowGraph(
    input.store,
    {
      channelId: channel.id,
      workflowGraph: graph,
      title: proposal.title.trim() || "Channel execution proposal",
      objective: proposal.prompt.trim() || proposal.title.trim() || "Complete channel execution proposal.",
      createdBy: proposal.proposedByTeammateId,
      autoStart: true,
      confirmUnsafeAutoStart: true,
    },
    now,
    input.runnerRegistry,
  );

  const workflow = input.store.updateChannelWorkflow(
    compiled.workflow.id,
    {
      metadata: {
        ...compiled.workflow.metadata,
        sourceProposalId: proposal.id,
        sourceMessageId: proposal.sourceMessageId,
        responseLanguage,
      },
    },
    now,
  ) ?? compiled.workflow;

  const workflowSteps = compiled.workflowSteps.map((step) =>
    input.store.updateChannelWorkflowStep(step.id, {
      metadata: {
        ...step.metadata,
        sourceProposalId: proposal.id,
        sourceMessageId: proposal.sourceMessageId,
      },
    }, now) ?? step
  );

  const accepted = input.store.updateChannelExecutionProposal(proposal.id, {
    status: "accepted",
    linkedTaskId: null,
    linkedRunId: null,
    linkedWorkflowId: workflow.id,
    ...(proposal.shaping ? { shaping: { ...proposal.shaping, status: "converted_to_task" as const, updatedAt: now } } : {}),
    errorMessage: null,
  }, now) ?? proposal;

  return { proposal: accepted, workflow, workflowSteps };
}

function existingLinkedWorkflow(
  store: RunStore,
  proposal: ChannelExecutionProposal,
): ConfirmChannelExecutionProposalWorkflowResult | undefined {
  if (!proposal.linkedWorkflowId) {
    return undefined;
  }
  const workflow = store.getChannelWorkflow(proposal.linkedWorkflowId);
  if (!workflow) {
    return undefined;
  }
  return {
    proposal,
    workflow,
    workflowSteps: store.listChannelWorkflowSteps({ workflowId: workflow.id, limit: 500 }),
  };
}

function resolveProposalParticipants(
  store: RunStore,
  channel: Channel,
  proposal: ChannelExecutionProposal,
): readonly ProposalParticipant[] {
  const sourceSteps = proposal.collaborationSteps.length > 0
    ? proposal.collaborationSteps
    : [{ teammateId: proposal.assigneeTeammateId, action: "coordinated", summary: "Complete the confirmed execution proposal." } satisfies ChannelExecutionProposalStep];
  return sourceSteps.map((step) => {
    const teammate = isLingAgentExecutorId(step.teammateId)
      ? store.getAiTeammate(step.teammateId) ?? createLingAgentExecutor()
      : store.getAiTeammate(step.teammateId);
    if (!teammate) {
      throw new HttpError(400, "proposal_teammate_not_found", `Proposal teammate not found: ${step.teammateId}`);
    }
    if (teammate.status !== "active") {
      throw new HttpError(400, "proposal_teammate_unavailable", `${teammate.displayName} is ${teammate.status}. Enable it or edit the proposal before starting.`);
    }
    if (teammate.hidden) {
      throw new HttpError(400, "proposal_teammate_unavailable", `${teammate.displayName} is hidden. Show it or edit the proposal before starting.`);
    }
    if (!teammateCanWorkInEffectiveChannel(store, channel, teammate.id)) {
      throw new HttpError(400, "proposal_teammate_not_in_channel", `${teammate.displayName} is not available in this channel. Add it to the channel or edit the proposal before starting.`);
    }
    return {
      step,
      teammate,
      ...((teammate.providerPresetId ?? channel.defaultProviderPresetId)
        ? { providerPresetId: teammate.providerPresetId ?? channel.defaultProviderPresetId }
        : {}),
    };
  });
}

function buildValidationRunRequest(
  cwd: string,
  channel: Channel,
  proposal: ChannelExecutionProposal,
  participant: ProposalParticipant,
): WorkflowStepRunRequest {
  return {
    workspaceCwd: cwd,
    cwd,
    ...(participant.providerPresetId ? { providerPresetId: participant.providerPresetId } : {}),
    ...(participant.teammate.runnerId ? { runnerId: participant.teammate.runnerId } : {}),
    teammateId: participant.teammate.id,
    task: {
      id: `${proposal.id}:${participant.teammate.id}`,
      title: stepTitle(participant.step, participant.teammate),
      prompt: stepPrompt(proposal, participant.step, participant.teammate),
      channelId: channel.id,
    },
    tools: participant.teammate.allowedTools,
    approvalProfile: participant.teammate.approvalProfile,
    thinkingLevel: "low",
  };
}

function buildProposalWorkflowGraph(
  proposal: ChannelExecutionProposal,
  participants: readonly ProposalParticipant[],
): WorkflowGraph {
  const boundedRequiredTools = isSingleStepBoundedToolsProposal(proposal) ? proposal.requiredTools : [];
  const nodes = participants.map((participant, index): WorkflowGraphNode => ({
    id: `proposal_step_${index + 1}`,
    kind: "step" as const,
    name: stepTitle(participant.step, participant.teammate),
    prompt: stepPrompt(proposal, participant.step, participant.teammate),
    teammateId: participant.teammate.id,
    ...(participant.providerPresetId ? { providerPresetId: participant.providerPresetId } : {}),
    ...(participant.teammate.runnerId ? { requestedRunnerId: participant.teammate.runnerId } : {}),
    ...(boundedRequiredTools.length > 0 ? { requiredTools: boundedRequiredTools } : {}),
    ...(participant.step.sources?.length ? { proposalStepSources: participant.step.sources } : {}),
    autoStart: true,
  }));
  return {
    schemaVersion: 1,
    id: `proposal_${proposal.id}`,
    name: proposal.title.trim() || "Channel execution proposal",
    summary: proposal.riskSummary,
    entryNodeId: nodes[0]?.id ?? "proposal_step_1",
    nodes,
    edges: nodes.slice(1).map((node, index) => ({
      id: `proposal_edge_${index + 1}`,
      fromNodeId: nodes[index]?.id ?? "proposal_step_1",
      toNodeId: node.id,
      condition: { kind: "all_succeeded" as const },
    })),
    termination: {
      success: "all_required_succeeded",
      onFailedRequiredNode: "block_for_user",
      onApprovalDenied: "block_for_user",
    },
    maxParallelSteps: 1,
  };
}

function isSingleStepBoundedToolsProposal(proposal: ChannelExecutionProposal): boolean {
  return proposal.collaborationSteps.length === 1;
}

function validateProposalRequiredTools(
  channel: Channel,
  proposal: ChannelExecutionProposal,
  participants: readonly ProposalParticipant[],
): void {
  if (!isSingleStepBoundedToolsProposal(proposal) || proposal.requiredTools.length === 0) {
    return;
  }
  for (const participant of participants) {
    const missingTeammateTools = proposal.requiredTools.filter((tool) => !participant.teammate.allowedTools.includes(tool));
    if (missingTeammateTools.length > 0) {
      throw new HttpError(
        400,
        "proposal_required_tools_not_available",
        `${participant.teammate.displayName} is missing required tools: ${missingTeammateTools.join(", ")}.`,
      );
    }
  }
}


function stepTitle(step: ChannelExecutionProposalStep, teammate: AiTeammate): string {
  const verb = step.action === "reviewed"
    ? "Review"
    : step.action === "consulted"
      ? "Consult"
      : step.action === "flagged_risk"
        ? "Risk review"
        : "Coordinate";
  return `${teammate.displayName}: ${verb}`;
}

function stepPrompt(
  proposal: ChannelExecutionProposal,
  step: ChannelExecutionProposalStep,
  teammate: AiTeammate,
): string {
  const responseLanguage = proposalResponseLanguage(proposal);
  return [
    `Confirmed proposal:\n${proposal.title}`,
    `Overall scope:\n${proposal.prompt}`,
    `Assigned teammate: ${teammate.displayName}`,
    `Step action: ${step.action}`,
    `Step summary:\n${step.summary}`,
    proposal.acceptanceCriteria.length > 0
      ? `Acceptance criteria:\n${proposal.acceptanceCriteria.map((criterion) => `- ${criterion}`).join("\n")}`
      : undefined,
    isSingleStepBoundedToolsProposal(proposal) && proposal.requiredTools.length > 0
      ? `Confirmed task-scoped tools:\n${proposal.requiredTools.join(", ")}`
      : undefined,
    proposal.riskSummary ? `Risk summary:\n${proposal.riskSummary}` : undefined,
    responseLanguageInstruction(responseLanguage),
    "Complete only this step. Do not start or approve later workflow steps.",
    "Do not use tools, write paths, commands, MCP actions, or external side effects beyond the confirmed task scope; request runtime permission if the work needs an undeclared escalation.",
    "Return a concise terminal summary and any artifacts or decisions needed by later steps.",
  ].filter((part): part is string => Boolean(part)).join("\n\n");
}

function proposalResponseLanguage(proposal: ChannelExecutionProposal): ResponseLanguage {
  return proposal.responseLanguage ?? (/[\u3400-\u9fff]/u.test(`${proposal.title}\n${proposal.prompt}`) ? "zh-CN" : "en-US");
}
