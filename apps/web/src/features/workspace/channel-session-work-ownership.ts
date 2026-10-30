import type { ChannelSessionSummary, ConversationItemV1 } from "@ling-stack/contracts";
import type { ApprovalRequest, ChannelMessage, ChannelWorkflow, ChannelWorkflowStep, RunSession } from "../../types.js";

/** Server summaries own active execution membership; canonical references add visible historical evidence. */
export function channelSessionWorkOwnership(input: {
  readonly channelId: string;
  readonly threadId?: string;
  readonly session?: ChannelSessionSummary;
  readonly items: readonly ConversationItemV1[];
  readonly messages: readonly ChannelMessage[];
  readonly workflows: readonly ChannelWorkflow[];
  readonly steps: readonly ChannelWorkflowStep[];
  readonly approvals?: readonly ApprovalRequest[];
  readonly runs?: readonly RunSession[];
}) {
  const session = input.session?.channelId === input.channelId && input.session.id === input.threadId ? input.session : undefined;
  const runIds = new Set<string>(session?.activeRunIds ?? []);
  const approvalIds = new Set<string>(session?.pendingApprovalIds ?? []);
  for (const run of input.runs ?? []) {
    if (input.threadId && run.threadId === input.threadId && (!run.channelId || run.channelId === input.channelId)) runIds.add(run.id);
  }
  const sourceItemIds = new Set<string>();
  const sourceTurnIds = new Set<string>();
  for (const item of input.items) {
    if (!input.threadId || item.threadId !== input.threadId || item.channelId !== input.channelId) continue;
    sourceItemIds.add(item.id);
    if (item.turnId) sourceTurnIds.add(item.turnId);
    for (const ref of item.domainRefs) {
      if (ref.type === "run") runIds.add(ref.id);
      if (ref.type === "approval") approvalIds.add(ref.id);
    }
  }
  for (const message of input.messages) {
    if (!input.threadId || message.threadId !== input.threadId || message.channelId !== input.channelId) continue;
    sourceItemIds.add(message.id);
    if (message.linkedRunId) runIds.add(message.linkedRunId);
  }
  const workflowIds = new Set(input.workflows.filter(workflow => workflow.channelId === input.channelId && (
    Boolean(workflow.metadata?.sourceMessageId && sourceItemIds.has(workflow.metadata.sourceMessageId))
    || Boolean(workflow.metadata?.sourceTurnId && sourceTurnIds.has(workflow.metadata.sourceTurnId))
  )).map(workflow => workflow.id));
  const stepIds = new Set<string>();
  for (const approval of input.approvals ?? []) {
    if ((!approval.channelId || approval.channelId === input.channelId) && approvalIds.has(approval.id) && approval.workflowStepId) stepIds.add(approval.workflowStepId);
  }
  for (const step of input.steps) if (step.channelId === input.channelId && (stepIds.has(step.id) || Boolean(step.runId && runIds.has(step.runId)))) workflowIds.add(step.workflowId);
  for (const step of input.steps) if (step.channelId === input.channelId && workflowIds.has(step.workflowId)) {
    stepIds.add(step.id);
    if (step.runId) runIds.add(step.runId);
  }
  for (const run of input.runs ?? []) {
    if ((!run.channelId || run.channelId === input.channelId) && run.workflowStepId && stepIds.has(run.workflowStepId)) runIds.add(run.id);
  }
  return {
    runIds, approvalIds, workflowIds, stepIds,
    ownsRun: (run: RunSession): boolean => (!run.channelId || run.channelId === input.channelId) && Boolean(input.threadId && (run.threadId === input.threadId || runIds.has(run.id))),
    ownsApproval: (approval: ApprovalRequest): boolean => (!approval.channelId || approval.channelId === input.channelId) && (
      approvalIds.has(approval.id) || Boolean(approval.runId && runIds.has(approval.runId)) || Boolean(approval.workflowStepId && stepIds.has(approval.workflowStepId))
    ),
  };
}
