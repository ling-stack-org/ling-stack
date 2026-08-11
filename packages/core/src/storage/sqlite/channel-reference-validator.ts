import type { ApprovalRequest } from "../../approval-types.js";
import type { ConversationItemV1 } from "@ling-stack/contracts";
import type { RunSession } from "../../run-types.js";
import {
  DEFAULT_WORKSPACE_ID,
  type AiTeammate,
  type Channel,
  type ChannelAttachment,
  type ChannelContextSummary,
  type ChannelDecision,
  type ChannelExecutionProposal,
  type ChannelHandoff,
  type ChannelLinkPreview,
  type ChannelProtocolSourceRef,
  type ChannelWorkflow,
  type ChannelWorkflowStep,
  type CreateWorkflowSelectorDecisionInput,
  type Task,
  type WorkflowHandoffIntent,
  type WorkflowPacketSourceRef,
  type WorkflowSelectorDecision,
} from "../../workspace-types.js";

export interface SqliteChannelReferenceValidatorPorts {
  readonly getChannel: (channelId: string) => Channel | undefined;
  readonly getConversationItem: (itemId: string) => ConversationItemV1 | undefined;
  readonly getChannelAttachment: (attachmentId: string) => ChannelAttachment | undefined;
  readonly getChannelLinkPreview: (linkPreviewId: string) => ChannelLinkPreview | undefined;
  readonly getTask: (taskId: string) => Task | undefined;
  readonly getRun: (runId: string) => RunSession | undefined;
  readonly getChannelWorkflow: (workflowId: string) => ChannelWorkflow | undefined;
  readonly getChannelWorkflowStep: (workflowStepId: string) => ChannelWorkflowStep | undefined;
  readonly getChannelExecutionProposal: (proposalId: string) => ChannelExecutionProposal | undefined;
  readonly getChannelDecision: (decisionId: string) => ChannelDecision | undefined;
  readonly getChannelHandoff: (handoffId: string) => ChannelHandoff | undefined;
  readonly getWorkflowHandoffIntent: (intentId: string) => WorkflowHandoffIntent | undefined;
  readonly getWorkflowSelectorDecision: (decisionId: string) => WorkflowSelectorDecision | undefined;
  readonly getChannelContextSummary: (contextSummaryId: string) => ChannelContextSummary | undefined;
  readonly getAiTeammate: (teammateId: string) => AiTeammate | undefined;
  readonly getApprovalRequest: (approvalId: string) => ApprovalRequest | undefined;
}

export class SqliteChannelReferenceValidator {
  constructor(private readonly ports: SqliteChannelReferenceValidatorPorts) {}

  assertChannelExists(channelId: string): void {
    if (!this.ports.getChannel(channelId)) {
      throw new Error(`Channel not found: ${channelId}`);
    }
  }

  assertItemInChannel(channelId: string, itemId: string): void {
    const item = this.ports.getConversationItem(itemId);
    if (!item) {
      throw new Error(`Conversation item not found: ${itemId}`);
    }
    if (item.channelId !== channelId) {
      throw new Error(`Conversation item does not belong to channel: ${itemId}`);
    }
  }

  assertAttachmentInChannel(channelId: string, attachmentId: string): void {
    const attachment = this.ports.getChannelAttachment(attachmentId);
    if (!attachment) {
      throw new Error(`Channel attachment not found: ${attachmentId}`);
    }
    if (attachment.channelId !== channelId) {
      throw new Error(`Attachment does not belong to channel: ${attachmentId}`);
    }
  }

  assertLinkPreviewInChannel(channelId: string, linkPreviewId: string): void {
    const linkPreview = this.ports.getChannelLinkPreview(linkPreviewId);
    if (!linkPreview) {
      throw new Error(`Channel link preview not found: ${linkPreviewId}`);
    }
    if (linkPreview.channelId !== channelId) {
      throw new Error(`Link preview does not belong to channel: ${linkPreviewId}`);
    }
  }

  assertTaskInChannel(channelId: string, taskId: string): void {
    const task = this.ports.getTask(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }
    if (task.channelId !== channelId) {
      throw new Error(`Task does not belong to channel: ${taskId}`);
    }
  }

  assertRunInChannel(channelId: string, runId: string): void {
    const run = this.ports.getRun(runId);
    if (!run) {
      throw new Error(`Run session not found: ${runId}`);
    }
    if (run.channelId !== channelId) {
      throw new Error(`Run does not belong to channel: ${runId}`);
    }
  }

  assertWorkflowInChannel(channelId: string, workflowId: string): void {
    const workflow = this.ports.getChannelWorkflow(workflowId);
    if (!workflow) {
      throw new Error(`Channel workflow not found: ${workflowId}`);
    }
    if (workflow.channelId !== channelId) {
      throw new Error(`Workflow does not belong to channel: ${workflowId}`);
    }
  }

  assertProposalInChannel(channelId: string, proposalId: string): void {
    const proposal = this.ports.getChannelExecutionProposal(proposalId);
    if (!proposal) {
      throw new Error(`Channel proposal not found: ${proposalId}`);
    }
    if (proposal.channelId !== channelId) {
      throw new Error(`Proposal does not belong to channel: ${proposalId}`);
    }
  }

  assertWorkflowStepInChannel(channelId: string, workflowStepId: string): void {
    const step = this.ports.getChannelWorkflowStep(workflowStepId);
    if (!step) {
      throw new Error(`Channel workflow step not found: ${workflowStepId}`);
    }
    if (step.channelId !== channelId) {
      throw new Error(`Workflow step does not belong to channel: ${workflowStepId}`);
    }
  }

  assertDecisionInChannel(channelId: string, decisionId: string): void {
    const decision = this.ports.getChannelDecision(decisionId);
    if (!decision) {
      throw new Error(`Channel decision not found: ${decisionId}`);
    }
    if (decision.channelId !== channelId) {
      throw new Error(`Decision does not belong to channel: ${decisionId}`);
    }
  }

  assertHandoffInChannel(channelId: string, handoffId: string): void {
    const handoff = this.ports.getChannelHandoff(handoffId);
    if (!handoff) {
      throw new Error(`Channel handoff not found: ${handoffId}`);
    }
    if (handoff.channelId !== channelId) {
      throw new Error(`Handoff does not belong to channel: ${handoffId}`);
    }
  }

  assertWorkflowHandoffIntentInChannel(channelId: string, intentId: string): void {
    const intent = this.ports.getWorkflowHandoffIntent(intentId);
    if (!intent) {
      throw new Error(`Workflow handoff intent not found: ${intentId}`);
    }
    if (intent.channelId !== channelId) {
      throw new Error(`Workflow handoff intent does not belong to channel: ${intentId}`);
    }
  }

  assertWorkflowSelectorDecisionInChannel(channelId: string, decisionId: string): void {
    const decision = this.ports.getWorkflowSelectorDecision(decisionId);
    if (!decision) {
      throw new Error(`Workflow selector decision not found: ${decisionId}`);
    }
    if (decision.channelId !== channelId) {
      throw new Error(`Workflow selector decision does not belong to channel: ${decisionId}`);
    }
  }

  assertContextSummaryInChannel(channelId: string, contextSummaryId: string): void {
    const contextSummary = this.ports.getChannelContextSummary(contextSummaryId);
    if (!contextSummary) {
      throw new Error(`Channel context summary not found: ${contextSummaryId}`);
    }
    if (contextSummary.channelId !== channelId) {
      throw new Error(`Context summary does not belong to channel: ${contextSummaryId}`);
    }
  }

  assertSourceRefsInChannel(
    channelId: string,
    input: { readonly sourceMessageId?: string; readonly sourceTaskId?: string; readonly sourceRunId?: string },
  ): void {
    if (input.sourceMessageId) {
      this.assertItemInChannel(channelId, input.sourceMessageId);
    }
    if (input.sourceTaskId) {
      this.assertTaskInChannel(channelId, input.sourceTaskId);
    }
    if (input.sourceRunId) {
      this.assertRunInChannel(channelId, input.sourceRunId);
    }
  }

  assertWorkflowCoordinationRefsInChannel(
    channelId: string,
    refs: {
      readonly workflowId?: string;
      readonly workflowStepId?: string;
      readonly runId?: string;
      readonly messageId?: string;
      readonly handoffId?: string;
    },
  ): void {
    if (refs.workflowId) {
      this.assertWorkflowInChannel(channelId, refs.workflowId);
    }
    if (refs.workflowStepId) {
      this.assertWorkflowStepInChannel(channelId, refs.workflowStepId);
      if (refs.workflowId) {
        const step = this.ports.getChannelWorkflowStep(refs.workflowStepId);
        if (step?.workflowId !== refs.workflowId) {
          throw new Error(`Workflow step does not belong to workflow: ${refs.workflowStepId}`);
        }
      }
    }
    if (refs.runId) {
      this.assertRunInChannel(channelId, refs.runId);
    }
    if (refs.messageId) {
      this.assertItemInChannel(channelId, refs.messageId);
    }
    if (refs.handoffId) {
      this.assertHandoffInChannel(channelId, refs.handoffId);
    }
  }

  assertWorkflowSelectorTargetsInChannel(
    channelId: string,
    input: Pick<CreateWorkflowSelectorDecisionInput, "workflowId" | "selectedWorkflowStepId" | "selectedTeammateId" | "selectedHandoffIntentId">,
  ): void {
    if (input.selectedWorkflowStepId) {
      this.assertWorkflowStepInChannel(channelId, input.selectedWorkflowStepId);
      const step = this.ports.getChannelWorkflowStep(input.selectedWorkflowStepId);
      if (step?.workflowId !== input.workflowId) {
        throw new Error(`Selected workflow step does not belong to workflow: ${input.selectedWorkflowStepId}`);
      }
    }
    if (input.selectedTeammateId) {
      const teammate = this.ports.getAiTeammate(input.selectedTeammateId);
      if (!teammate) {
        throw new Error(`AI teammate not found: ${input.selectedTeammateId}`);
      }
      if (teammate.workspaceId !== DEFAULT_WORKSPACE_ID) {
        throw new Error(`AI teammate does not belong to workspace: ${input.selectedTeammateId}`);
      }
    }
    if (input.selectedHandoffIntentId) {
      this.assertWorkflowHandoffIntentInChannel(channelId, input.selectedHandoffIntentId);
    }
  }

  assertWorkflowPacketSourceRefsInChannel(channelId: string, sourceRefs: readonly WorkflowPacketSourceRef[]): void {
    for (const sourceRef of sourceRefs) {
      switch (sourceRef.type) {
        case "channel_message":
          this.assertItemInChannel(channelId, sourceRef.id);
          break;
        case "channel_decision":
          this.assertDecisionInChannel(channelId, sourceRef.id);
          break;
        case "context_summary":
          this.assertContextSummaryInChannel(channelId, sourceRef.id);
          break;
        case "task":
          this.assertTaskInChannel(channelId, sourceRef.id);
          break;
        case "run":
          this.assertRunInChannel(channelId, sourceRef.id);
          break;
        case "workflow":
          this.assertWorkflowInChannel(channelId, sourceRef.id);
          break;
        case "workflow_step":
          this.assertWorkflowStepInChannel(channelId, sourceRef.id);
          break;
        case "workflow_handoff_intent":
          this.assertWorkflowHandoffIntentInChannel(channelId, sourceRef.id);
          break;
        case "workflow_selector_decision":
          this.assertWorkflowSelectorDecisionInChannel(channelId, sourceRef.id);
          break;
        case "approval": {
          const approval = this.ports.getApprovalRequest(sourceRef.id);
          if (!approval) {
            throw new Error(`Approval request not found: ${sourceRef.id}`);
          }
          if (approval.channelId !== channelId) {
            throw new Error(`Approval request does not belong to channel: ${sourceRef.id}`);
          }
          break;
        }
        case "artifact":
        case "channel_brief":
        case "memory":
          break;
      }
    }
  }

  assertChannelProtocolSourceRefsInChannel(channelId: string, sourceRefs: readonly ChannelProtocolSourceRef[]): void {
    for (const sourceRef of sourceRefs) {
      switch (sourceRef.type) {
        case "message":
          this.assertItemInChannel(channelId, sourceRef.id);
          break;
        case "channel_decision":
          this.assertDecisionInChannel(channelId, sourceRef.id);
          break;
        case "context_summary":
          this.assertContextSummaryInChannel(channelId, sourceRef.id);
          break;
        case "task":
          this.assertTaskInChannel(channelId, sourceRef.id);
          break;
        case "run":
          this.assertRunInChannel(channelId, sourceRef.id);
          break;
        case "workflow":
          this.assertWorkflowInChannel(channelId, sourceRef.id);
          break;
        case "workflow_step":
          this.assertWorkflowStepInChannel(channelId, sourceRef.id);
          break;
        default:
          throw new Error(`Unsupported channel protocol source ref type: ${String(sourceRef.type)}`);
      }
    }
  }
}
