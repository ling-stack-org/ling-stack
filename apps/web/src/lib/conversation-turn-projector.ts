import type {
  ChannelExecutionProposal,
  ChannelIntentDecision,
  ChannelMessage,
  ChannelWorkflow,
  ChannelWorkflowStep,
  RunSession,
  UsedMemoryEvent,
} from "../types.js";
import type { ConversationWorkCellViewModel } from "./conversation-work-cell.js";
import type { ConversationTurn, TranscriptBlockBase, TranscriptBlockKind, TranscriptBlockStatus } from "../shared/conversation/transcript/index.js";

export type ConversationTurnOperationRef =
  | { readonly kind: "workflow"; readonly workflowId: string }
  | { readonly kind: "run_thread"; readonly threadId: string };

type ConversationGenericTranscriptBlockKind = Exclude<TranscriptBlockKind, "coordinator_message" | "operation">;
type ConversationGenericTranscriptBlock = {
  readonly [Kind in ConversationGenericTranscriptBlockKind]: TranscriptBlockBase<Kind>;
}[ConversationGenericTranscriptBlockKind];

type WorkflowPacketTarget = {
  readonly artifactId: string;
  readonly packetRole: "context" | "output" | "summary";
  readonly stepTitle: string;
  readonly label: string;
};

export type ConversationTranscriptBlock =
  | ConversationCoordinatorMessageBlock
  | ConversationOperationBlock
  | ConversationGenericTranscriptBlock;

export interface ConversationCoordinatorMessageBlock extends TranscriptBlockBase<"coordinator_message"> {
  readonly id: string;
  readonly kind: "coordinator_message";
  readonly phase: "start" | "terminal";
  readonly message: ChannelMessage;
  readonly memoryCitationEvents: readonly UsedMemoryEvent[];
}

export interface ConversationOperationBlock extends TranscriptBlockBase<"operation"> {
  readonly id: string;
  readonly kind: "operation";
  readonly operationCell: ConversationWorkCellViewModel;
  readonly operationRef: ConversationTurnOperationRef;
}

export interface ConversationTurnViewModel extends ConversationTurn<ConversationTranscriptBlock> {
  readonly id: string;
  readonly sourceMessageId: string;
  readonly sourceMessage: ChannelMessage;
  readonly blocks: readonly ConversationTranscriptBlock[];
  readonly coordinatorStartMessages: readonly ChannelMessage[];
  readonly coordinatorTerminalMessages: readonly ChannelMessage[];
  readonly operationCell?: ConversationWorkCellViewModel;
  readonly operationRef?: ConversationTurnOperationRef;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ConversationTurnProjection {
  readonly turns: readonly ConversationTurnViewModel[];
  readonly hiddenActivityIds: ReadonlySet<string>;
}

export interface BuildConversationTurnProjectionInput {
  readonly channelId: string;
  readonly messages: readonly ChannelMessage[];
  readonly proposals: readonly ChannelExecutionProposal[];
  readonly intentDecisions: readonly ChannelIntentDecision[];
  readonly workflows: readonly ChannelWorkflow[];
  readonly workflowSteps: readonly ChannelWorkflowStep[];
  readonly runs: readonly RunSession[];
  readonly usedMemoryEvents: readonly UsedMemoryEvent[];
  readonly operationCellByWorkflowId: ReadonlyMap<string, ConversationWorkCellViewModel>;
  readonly operationCellByThreadId: ReadonlyMap<string, ConversationWorkCellViewModel>;
  readonly lingAgentAuthorId: string;
}

export function buildConversationTurnProjection(input: BuildConversationTurnProjectionInput): ConversationTurnProjection {
  const hiddenActivityIds = new Set<string>();
  const channelMessages = input.messages.filter((message) => message.channelId === input.channelId);
  const childMessagesByThreadId = groupBy(channelMessages.filter((message) => Boolean(message.threadId)), (message) => message.threadId ?? "");
  const proposalsBySourceMessageId = groupBy(
    input.proposals.filter((proposal) => proposal.channelId === input.channelId && proposal.status !== "cancelled" && proposal.status !== "superseded"),
    (proposal) => proposal.sourceMessageId,
  );
  const intentDecisionsBySourceMessageId = groupBy(
    input.intentDecisions.filter((decision) => decision.channelId === input.channelId && decision.status === "accepted"),
    (decision) => decision.sourceMessageId,
  );
  const workflowById = new Map(input.workflows.filter((workflow) => workflow.channelId === input.channelId).map((workflow) => [workflow.id, workflow]));
  const runsById = new Map(input.runs.map((run) => [run.id, run]));
  const usedMemoryEventsByResponseId = groupBy(
    input.usedMemoryEvents
      .filter((event) => Boolean(event.responseId) && (!event.channelId || event.channelId === input.channelId))
      .sort(compareByCreatedAtThenId),
    (event) => event.responseId ?? "",
  );
  const rootMessages = channelMessages
    .filter(isRootUserMessage)
    .sort(compareByCreatedAtThenId);

  const turns = rootMessages.map((sourceMessage) => {
    const proposals = proposalsBySourceMessageId.get(sourceMessage.id) ?? [];
    const intentDecisions = intentDecisionsBySourceMessageId.get(sourceMessage.id) ?? [];
    const operation = findTurnOperation({
      sourceMessage,
      proposals,
      intentDecisions,
      workflows: input.workflows,
      workflowById,
      runsById,
      operationCellByWorkflowId: input.operationCellByWorkflowId,
      operationCellByThreadId: input.operationCellByThreadId,
    });
    const childMessages = (childMessagesByThreadId.get(sourceMessage.id) ?? []).sort(compareByCreatedAtThenId);
    const coordinatorMessages = childMessages.filter((message) => isLingAgentMessage(message, input.lingAgentAuthorId));
    const { startMessages, terminalMessages } = splitCoordinatorMessages(coordinatorMessages, operation?.cell);
    const turnId = `conversation-turn:${sourceMessage.id}`;
    const blocks = buildTranscriptBlocks({
      turnId,
      proposals,
      workflowSteps: input.workflowSteps,
      startMessages,
      terminalMessages,
      operation,
      usedMemoryEventsByResponseId,
    });
    const updatedAt = maxIsoString([
      sourceMessage.updatedAt,
      ...proposals.map((proposal) => proposal.updatedAt),
      ...input.workflowSteps
        .filter((step) => operation?.ref.kind === "workflow" && step.workflowId === operation.ref.workflowId)
        .map((step) => step.updatedAt),
      ...coordinatorMessages.map((message) => message.updatedAt),
      ...coordinatorMessages.flatMap((message) => (usedMemoryEventsByResponseId.get(message.id) ?? []).map((event) => event.createdAt)),
      operation?.cell.updatedAt,
    ]);

    hiddenActivityIds.add(`message:${sourceMessage.id}`);
    for (const message of coordinatorMessages) {
      hiddenActivityIds.add(`message:${message.id}`);
    }
    if (operation?.ref.kind === "workflow") {
      hiddenActivityIds.add(`workflow:${operation.ref.workflowId}`);
      for (const step of input.workflowSteps) {
        if (step.workflowId === operation.ref.workflowId) {
          hiddenActivityIds.add(`workflow-step:${step.id}`);
        }
      }
    }
    if (operation?.cell) {
      for (const runId of operation.cell.runIds) {
        hiddenActivityIds.add(`run:${runId}`);
      }
    }

    return {
      id: turnId,
      sourceMessageId: sourceMessage.id,
      sourceMessage,
      blocks,
      coordinatorStartMessages: startMessages,
      coordinatorTerminalMessages: terminalMessages,
      operationCell: operation?.cell,
      operationRef: operation?.ref,
      createdAt: sourceMessage.createdAt,
      updatedAt,
    } satisfies ConversationTurnViewModel;
  });

  return { turns, hiddenActivityIds };
}

function isRootUserMessage(message: ChannelMessage): boolean {
  return message.authorType === "local-user" && message.kind === "message" && !message.threadId;
}

function isLingAgentMessage(message: ChannelMessage, lingAgentAuthorId: string): boolean {
  return message.authorType === "ai-teammate" && message.authorId === lingAgentAuthorId;
}

function findTurnOperation(input: {
  readonly sourceMessage: ChannelMessage;
  readonly proposals: readonly ChannelExecutionProposal[];
  readonly intentDecisions: readonly ChannelIntentDecision[];
  readonly workflows: readonly ChannelWorkflow[];
  readonly workflowById: ReadonlyMap<string, ChannelWorkflow>;
  readonly runsById: ReadonlyMap<string, RunSession>;
  readonly operationCellByWorkflowId: ReadonlyMap<string, ConversationWorkCellViewModel>;
  readonly operationCellByThreadId: ReadonlyMap<string, ConversationWorkCellViewModel>;
}): { readonly cell: ConversationWorkCellViewModel; readonly ref: ConversationTurnOperationRef } | undefined {
  const workflowIds = uniqueStrings([
    ...input.proposals.map((proposal) => proposal.linkedWorkflowId).filter(isString),
    ...input.intentDecisions.map((decision) => decision.workflowId).filter(isString),
    ...input.workflows
      .filter((workflow) =>
        workflow.metadata?.sourceMessageId === input.sourceMessage.id ||
        (workflow.metadata?.sourceProposalId && input.proposals.some((proposal) => proposal.id === workflow.metadata?.sourceProposalId))
      )
      .map((workflow) => workflow.id),
  ]);
  const workflow = workflowIds
    .map((workflowId) => input.workflowById.get(workflowId))
    .filter(isDefined)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  if (workflow) {
    const cell = input.operationCellByWorkflowId.get(workflow.id);
    if (cell) {
      return { cell, ref: { kind: "workflow", workflowId: workflow.id } };
    }
  }

  const linkedRunIds = input.proposals.map((proposal) => proposal.linkedRunId).filter(isString);
  for (const runId of linkedRunIds) {
    const threadId = input.runsById.get(runId)?.threadId;
    if (!threadId) {
      continue;
    }
    const cell = input.operationCellByThreadId.get(threadId);
    if (cell) {
      return { cell, ref: { kind: "run_thread", threadId } };
    }
  }

  return undefined;
}

function splitCoordinatorMessages(
  messages: readonly ChannelMessage[],
  operationCell: ConversationWorkCellViewModel | undefined,
): { readonly startMessages: readonly ChannelMessage[]; readonly terminalMessages: readonly ChannelMessage[] } {
  if (messages.length === 0) {
    return { startMessages: [], terminalMessages: [] };
  }

  if (operationCell && isTerminalOperationStatus(operationCell.status)) {
    if (messages.length > 1) {
      return {
        startMessages: messages.slice(0, -1),
        terminalMessages: messages.slice(-1),
      };
    }
    return { startMessages: [], terminalMessages: messages };
  }

  if (operationCell && messages.length > 1) {
    return {
      startMessages: messages.slice(0, -1),
      terminalMessages: messages.slice(-1),
    };
  }

  return { startMessages: messages, terminalMessages: [] };
}

function buildTranscriptBlocks(input: {
  readonly turnId: string;
  readonly proposals: readonly ChannelExecutionProposal[];
  readonly workflowSteps: readonly ChannelWorkflowStep[];
  readonly startMessages: readonly ChannelMessage[];
  readonly terminalMessages: readonly ChannelMessage[];
  readonly operation: { readonly cell: ConversationWorkCellViewModel; readonly ref: ConversationTurnOperationRef } | undefined;
  readonly usedMemoryEventsByResponseId: ReadonlyMap<string, readonly UsedMemoryEvent[]>;
}): readonly ConversationTranscriptBlock[] {
  const blocks: ConversationTranscriptBlock[] = [];
  blocks.push(...buildRequirementShapingBlocks(input.turnId, input.proposals));
  for (const message of input.startMessages) {
    blocks.push({
      id: `coordinator-start:${message.id}`,
      turnId: input.turnId,
      kind: "coordinator_message",
      phase: "start",
      status: transcriptStatusFromMessage(message),
      revision: 1,
      updatedAt: message.updatedAt,
      ownerId: message.authorId,
      display: [{ id: `display:${message.id}`, text: message.body }],
      message,
      memoryCitationEvents: input.usedMemoryEventsByResponseId.get(message.id) ?? [],
    });
  }
  if (input.operation) {
    blocks.push({
      id: `operation:${input.operation.cell.id}`,
      turnId: input.turnId,
      kind: "operation",
      status: transcriptStatusFromOperation(input.operation.cell.status),
      revision: 1,
      updatedAt: input.operation.cell.updatedAt,
      display: [
        {
          id: `display:${input.operation.cell.id}:title`,
          text: input.operation.cell.title,
          meta: input.operation.cell.summary,
        },
      ],
      previewTargets: input.operation.cell.artifactStripItems.map((item) => ({
        id: item.id,
        kind: item.previewKind === "image" ? "image" : item.kind === "artifact" ? "artifact" : item.kind === "changed" ? "diff" : "file",
        label: item.label,
        href: item.href,
      })),
      operationCell: input.operation.cell,
      operationRef: input.operation.ref,
    });
    if (input.operation.ref.kind === "workflow") {
      blocks.push(...buildWorkflowPacketSummaryBlocks({
        turnId: input.turnId,
        workflowId: input.operation.ref.workflowId,
        workflowSteps: input.workflowSteps,
      }));
    }
  }
  for (const message of input.terminalMessages) {
    blocks.push({
      id: `coordinator-terminal:${message.id}`,
      turnId: input.turnId,
      kind: "coordinator_message",
      phase: "terminal",
      status: transcriptStatusFromMessage(message),
      revision: 1,
      updatedAt: message.updatedAt,
      ownerId: message.authorId,
      display: [{ id: `display:${message.id}`, text: message.body }],
      message,
      memoryCitationEvents: input.usedMemoryEventsByResponseId.get(message.id) ?? [],
    });
  }
  return blocks;
}

function buildRequirementShapingBlocks(
  turnId: string,
  proposals: readonly ChannelExecutionProposal[],
): readonly ConversationGenericTranscriptBlock[] {
  const blocks: ConversationGenericTranscriptBlock[] = [];
  for (const proposal of proposals.filter((item) => item.shaping && item.status === "draft")) {
    const shaping = proposal.shaping;
    if (!shaping) {
      continue;
    }
    const contributionLines = [
      ...proposal.collaborationSteps
        .filter(requirementShapingContributionAffectsScope)
        .map((step, index) => ({
          id: `proposal:${proposal.id}:contribution:${index}`,
          text: `${step.teammateId}: ${step.summary}`,
          tone: step.action === "flagged_risk" ? "waiting" as const : "default" as const,
          meta: step.action,
        })),
      ...shaping.clarifications.map((clarification) => ({
        id: `proposal:${proposal.id}:clarification:${clarification.id}`,
        text: `${clarification.authorType}: ${clarification.body}`,
        tone: "muted" as const,
        meta: "clarification",
      })),
    ];
    blocks.push({
      id: `requirement-shaping:${proposal.id}`,
      turnId,
      kind: "requirement_shaping",
      status: requirementShapingTranscriptStatus(shaping.status),
      revision: 1,
      updatedAt: shaping.updatedAt ?? proposal.updatedAt,
      display: [{
        id: `display:${proposal.id}:shaping`,
        text: shaping.summary?.trim() || proposal.title,
        meta: requirementShapingStatusLabel(shaping.status),
      }],
      expanded: {
        mode: "inline",
        title: "Requirement shaping",
        summary: proposal.riskSummary,
        lines: contributionLines,
      },
    });
    if (shaping.openQuestions.length > 0 && shaping.status === "needs_user_clarification") {
      blocks.push({
        id: `decision-needed:${proposal.id}`,
        turnId,
        kind: "decision_needed",
        status: "waiting_for_approval",
        revision: 1,
        updatedAt: shaping.updatedAt ?? proposal.updatedAt,
        display: [{
          id: `display:${proposal.id}:decision`,
          text: shaping.openQuestions[0] ?? "Decision needed",
          meta: shaping.openQuestions.length === 1 ? "1 open question" : `${shaping.openQuestions.length} open questions`,
        }],
        expanded: {
          mode: "inline",
          title: "Decision needed",
          lines: shaping.openQuestions.map((question, index) => ({
            id: `proposal:${proposal.id}:question:${index}`,
            text: question,
            tone: "waiting",
          })),
        },
      });
    }
  }
  return blocks;
}

function requirementShapingContributionAffectsScope(step: ChannelExecutionProposal["collaborationSteps"][number]): boolean {
  const summary = step.summary.trim();
  if (!summary) {
    return false;
  }
  if (step.action === "flagged_risk") {
    return true;
  }
  return /\b(scope|scoped|boundary|requirement|acceptance|criteria|risk|blocker|conflict|decision|decide|approval|clarify|clarification|question|assumption|constraint|permission|security|cost|latency|handoff|owner|proposal)\b|范围|边界|需求|验收|风险|阻塞|冲突|决策|决定|审批|澄清|问题|假设|约束|权限|安全|成本|延迟|交接|负责人|提案/u.test(summary);
}

function buildWorkflowPacketSummaryBlocks(input: {
  readonly turnId: string;
  readonly workflowId: string;
  readonly workflowSteps: readonly ChannelWorkflowStep[];
}): readonly ConversationGenericTranscriptBlock[] {
  const steps = input.workflowSteps.filter((step) => step.workflowId === input.workflowId);
  const packetTargets = steps.flatMap((step) => workflowPacketTargetsForStep(step));
  if (packetTargets.length === 0) {
    return [];
  }
  const contextCount = packetTargets.filter((target) => target.packetRole === "context").length;
  const outputCount = packetTargets.filter((target) => target.packetRole === "output").length;
  const summaryCount = packetTargets.filter((target) => target.packetRole === "summary").length;
  const labels = [
    contextCount > 0 ? `${contextCount} context` : undefined,
    outputCount > 0 ? `${outputCount} output` : undefined,
    summaryCount > 0 ? `${summaryCount} summary` : undefined,
  ].filter(isString);
  return [{
    id: `workflow-packet-summary:${input.workflowId}`,
    turnId: input.turnId,
    kind: "workflow_packet_summary",
    status: workflowPacketSummaryStatus(steps),
    revision: 1,
    updatedAt: maxIsoString(steps.map((step) => step.updatedAt)),
    display: [{
      id: `display:${input.workflowId}:packet-summary`,
      text: "Workflow packet summary",
      meta: labels.length > 0 ? labels.join(" · ") : `${packetTargets.length} packet refs`,
    }],
    expanded: {
      mode: "inline",
      title: "Workflow packet summary",
      summary: "Packet bodies stay in artifacts; this turn only shows bounded refs and metadata.",
      lines: packetTargets.map((target) => ({
        id: `workflow-packet:${target.artifactId}`,
        text: `${target.stepTitle}: ${target.label}`,
        tone: "muted",
        meta: target.packetRole,
      })),
    },
    previewTargets: packetTargets.map((target) => ({
      id: target.artifactId,
      kind: "artifact",
      label: target.label,
      metadata: [
        { id: `${target.artifactId}:step`, text: target.stepTitle },
        { id: `${target.artifactId}:role`, text: target.packetRole },
      ],
    })),
  }];
}

function requirementShapingTranscriptStatus(
  status: NonNullable<ChannelExecutionProposal["shaping"]>["status"],
): TranscriptBlockStatus {
  if (status === "needs_user_clarification" || status === "ready_for_confirmation") {
    return "waiting_for_approval";
  }
  if (status === "converted_to_task") {
    return "succeeded";
  }
  if (status === "dismissed") {
    return "cancelled";
  }
  return "running";
}

function requirementShapingStatusLabel(
  status: NonNullable<ChannelExecutionProposal["shaping"]>["status"],
): string {
  if (status === "collecting_context") {
    return "Collecting context";
  }
  if (status === "collecting_teammate_input") {
    return "Collecting teammate input";
  }
  if (status === "needs_user_clarification") {
    return "Needs user clarification";
  }
  if (status === "ready_for_confirmation") {
    return "Ready for confirmation";
  }
  if (status === "converted_to_task") {
    return "Converted to task";
  }
  return "Dismissed";
}

function workflowPacketSummaryStatus(steps: readonly ChannelWorkflowStep[]): TranscriptBlockStatus {
  if (steps.some((step) => step.status === "failed")) {
    return "failed";
  }
  if (steps.some((step) => step.status === "blocked")) {
    return "blocked";
  }
  if (steps.some((step) => step.status === "waiting_for_approval")) {
    return "waiting_for_approval";
  }
  if (steps.some((step) => step.status === "running" || step.status === "claimed")) {
    return "running";
  }
  if (steps.some((step) => step.status === "queued")) {
    return "queued";
  }
  if (steps.length > 0 && steps.every((step) => step.status === "cancelled")) {
    return "cancelled";
  }
  return "succeeded";
}

function workflowPacketTargetsForStep(step: ChannelWorkflowStep): readonly WorkflowPacketTarget[] {
  const targets: WorkflowPacketTarget[] = [];
  if (step.metadata?.contextArtifactId) {
    targets.push({
      artifactId: step.metadata.contextArtifactId,
      packetRole: "context",
      stepTitle: step.title,
      label: "Context packet",
    });
  }
  if (step.metadata?.outputArtifactId) {
    targets.push({
      artifactId: step.metadata.outputArtifactId,
      packetRole: "output",
      stepTitle: step.title,
      label: "Output packet",
    });
  }
  for (const artifactId of step.metadata?.outputArtifactIds ?? []) {
    targets.push({
      artifactId,
      packetRole: "output",
      stepTitle: step.title,
      label: "Output packet",
    });
  }
  if (step.metadata?.fanInSummaryArtifactId) {
    targets.push({
      artifactId: step.metadata.fanInSummaryArtifactId,
      packetRole: "summary",
      stepTitle: step.title,
      label: "Fan-in summary",
    });
  }
  return uniquePacketTargets(targets);
}

function uniquePacketTargets(targets: readonly WorkflowPacketTarget[]): readonly WorkflowPacketTarget[] {
  const seenArtifactIds = new Set<string>();
  const uniqueTargets: WorkflowPacketTarget[] = [];
  for (const target of targets) {
    if (seenArtifactIds.has(target.artifactId)) {
      continue;
    }
    seenArtifactIds.add(target.artifactId);
    uniqueTargets.push(target);
  }
  return uniqueTargets;
}

function transcriptStatusFromMessage(message: ChannelMessage): TranscriptBlockStatus {
  if (message.status === "pending") {
    return "running";
  }
  if (message.status === "failed") {
    return "failed";
  }
  if (message.status === "blocked") {
    return "blocked";
  }
  return "succeeded";
}

function transcriptStatusFromOperation(status: ConversationWorkCellViewModel["status"]): TranscriptBlockStatus {
  if (status === "waiting_for_approval") {
    return "waiting_for_approval";
  }
  if (status === "blocked") {
    return "blocked";
  }
  if (status === "failed") {
    return "failed";
  }
  if (status === "cancelled" || status === "superseded") {
    return "cancelled";
  }
  if (status === "succeeded") {
    return "succeeded";
  }
  return "running";
}

function isTerminalOperationStatus(status: ConversationWorkCellViewModel["status"]): boolean {
  return status === "succeeded" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "superseded";
}

function groupBy<T>(items: readonly T[], keyForItem: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyForItem(item);
    const existing = groups.get(key) ?? [];
    existing.push(item);
    groups.set(key, existing);
  }
  return groups;
}

function compareByCreatedAtThenId(left: { readonly createdAt: string; readonly id: string }, right: { readonly createdAt: string; readonly id: string }): number {
  const timeComparison = left.createdAt.localeCompare(right.createdAt);
  return timeComparison === 0 ? left.id.localeCompare(right.id) : timeComparison;
}

function maxIsoString(values: readonly (string | undefined)[]): string {
  return values.filter(isString).sort((left, right) => right.localeCompare(left))[0] ?? "";
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function isString(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
