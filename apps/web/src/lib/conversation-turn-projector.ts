import type {
  ChannelExecutionProposal,
  ChannelIntentDecision,
  ChannelMessage,
  ChannelWorkflow,
  ChannelWorkflowStep,
  ConversationItemV1,
  RunSession,
  UsedMemoryEvent,
} from "../types.js";
import type { ConversationWorkCellViewModel } from "./conversation-work-cell.js";
import type { ConversationTurn, TranscriptBlockBase, TranscriptBlockKind, TranscriptBlockStatus } from "../shared/conversation/transcript/index.js";

export type ConversationTurnOperationRef =
  | { readonly kind: "workflow"; readonly workflowId: string }
  | { readonly kind: "run_thread"; readonly threadId: string };

type ConversationGenericTranscriptBlockKind = Exclude<TranscriptBlockKind, "coordinator_message" | "conversation_item" | "operation" | "final_result">;
type ConversationGenericTranscriptBlock = {
  readonly [Kind in ConversationGenericTranscriptBlockKind]: TranscriptBlockBase<Kind>;
}[ConversationGenericTranscriptBlockKind];

export type ConversationTranscriptBlock =
  | ConversationCoordinatorMessageBlock
  | ConversationItemBlock
  | ConversationOperationBlock
  | ConversationFinalResultBlock
  | ConversationGenericTranscriptBlock;

export interface ConversationCoordinatorMessageBlock extends TranscriptBlockBase<"coordinator_message"> {
  readonly id: string;
  readonly kind: "coordinator_message";
  readonly phase: "start" | "terminal";
  readonly message: ChannelMessage;
  readonly memoryCitationEvents: readonly UsedMemoryEvent[];
}

export interface ConversationItemBlock extends TranscriptBlockBase<"conversation_item"> {
  readonly item: ConversationItemV1;
}

export interface ConversationOperationBlock extends TranscriptBlockBase<"operation"> {
  readonly id: string;
  readonly kind: "operation";
  readonly operationCell: ConversationWorkCellViewModel;
  readonly operationRef: ConversationTurnOperationRef;
}

export interface ConversationFinalResultBlock extends TranscriptBlockBase<"final_result"> {
  readonly id: string;
  readonly kind: "final_result";
  readonly terminalReportId: string;
  readonly terminalReportRevisionKey: string;
  readonly rows: ConversationWorkCellViewModel["terminalReportRows"];
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
  readonly conversationItems?: readonly ConversationItemV1[];
  readonly proposals: readonly ChannelExecutionProposal[];
  readonly intentDecisions: readonly ChannelIntentDecision[];
  readonly workflows: readonly ChannelWorkflow[];
  readonly workflowSteps: readonly ChannelWorkflowStep[];
  readonly runs: readonly RunSession[];
  readonly usedMemoryEvents: readonly UsedMemoryEvent[];
  readonly operationCellByWorkflowId: ReadonlyMap<string, ConversationWorkCellViewModel>;
  readonly operationCellByThreadId: ReadonlyMap<string, ConversationWorkCellViewModel>;
  readonly lingAgentAuthorId: string;
  readonly terminalReportResultItemIds?: ReadonlySet<string>;
  /** Same Host-evidence visibility decision used by the standalone activity feed. */
  readonly silentChannelReplyRunIds?: ReadonlySet<string>;
}

export function buildConversationTurnProjection(input: BuildConversationTurnProjectionInput): ConversationTurnProjection {
  const hiddenActivityIds = new Set<string>();
  const channelMessages = input.messages.filter((message) => message.channelId === input.channelId);
  const conversationItems = (input.conversationItems ?? []).filter((item) =>
    item.channelId === input.channelId && (item.visibility === "channel" || item.visibility === "thread_participants"));
  const itemsByTurnId = groupBy(conversationItems.filter((item) => Boolean(item.turnId)), (item) => item.turnId ?? "");
  const itemsByThreadId = groupBy(conversationItems, (item) => item.threadId);
  const messagesByTurnId = groupBy(channelMessages.filter((message) => Boolean(message.turnId)), (message) => message.turnId ?? "");
  const messagesByThreadId = groupBy(channelMessages.filter((message) => Boolean(message.threadId)), (message) => message.threadId ?? "");
  const legacyChildMessagesBySourceItemId = groupBy(
    channelMessages.filter((message) => !message.turnId && Boolean(message.threadId)),
    (message) => message.threadId ?? "",
  );
  const proposalsBySourceMessageId = groupBy(
    input.proposals.filter((proposal) => proposal.channelId === input.channelId && proposal.status !== "cancelled" && proposal.status !== "superseded"),
    (proposal) => proposal.sourceMessageId,
  );
  const intentDecisionsBySourceMessageId = groupBy(
    input.intentDecisions.filter((decision) => decision.channelId === input.channelId && decision.status === "accepted"),
    (decision) => decision.sourceItemId,
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
      silentChannelReplyRunIds: input.silentChannelReplyRunIds,
    });
    const childMessages = uniqueMessages([
      ...(sourceMessage.turnId ? messagesByTurnId.get(sourceMessage.turnId) ?? [] : []),
      ...(legacyChildMessagesBySourceItemId.get(sourceMessage.id) ?? []),
      ...threadMessagesForSource(sourceMessage, messagesByThreadId),
    ])
      .filter((message) => message.id !== sourceMessage.id)
      .sort(compareByCreatedAtThenId);
    const allCoordinatorMessages = childMessages.filter((message) => isLingAgentMessage(message, input.lingAgentAuthorId));
    const coordinatorMessages = allCoordinatorMessages.filter((message) => !input.terminalReportResultItemIds?.has(message.id));
    const turnId = `conversation-turn:${sourceMessage.id}`;
    const turnConversationItems = conversationItemsForSource({
      sourceMessage,
      itemsByTurnId,
      itemsByThreadId,
      rootMessages,
    });
    const narrationItemIds = new Set(turnConversationItems
      .filter((item) => item.kind === "assistant_message" && item.payload.presentationRole === "narration")
      .map((item) => item.id));
    const { startMessages, terminalMessages } = splitCoordinatorMessages(coordinatorMessages, operation?.cell, narrationItemIds);
    const blocks = buildTranscriptBlocks({
      turnId,
      proposals,
      workflowSteps: input.workflowSteps,
      startMessages,
      terminalMessages,
      operation,
      usedMemoryEventsByResponseId,
      conversationItems: turnConversationItems,
    });
    const updatedAt = maxIsoString([
      sourceMessage.updatedAt,
      ...turnConversationItems.map((item) => item.updatedAt),
      ...proposals.map((proposal) => proposal.updatedAt),
      ...input.workflowSteps
        .filter((step) => operation?.ref.kind === "workflow" && step.workflowId === operation.ref.workflowId)
        .map((step) => step.updatedAt),
      ...allCoordinatorMessages.map((message) => message.updatedAt),
      ...allCoordinatorMessages.flatMap((message) => (usedMemoryEventsByResponseId.get(message.id) ?? []).map((event) => event.createdAt)),
      operation?.cell.updatedAt,
    ]);

    hiddenActivityIds.add(`message:${sourceMessage.id}`);
    for (const message of allCoordinatorMessages) {
      hiddenActivityIds.add(`message:${message.id}`);
    }
    for (const item of turnConversationItems) {
      if (item.kind !== "user_message" && item.kind !== "assistant_message") {
        hiddenActivityIds.add(`message:${item.id}`);
      }
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
  // A channel-root user message may carry the channel discussion thread id.
  // Treat every local message as a turn root and let threadMessagesForSource
  // assign same-thread coordinator replies to the nearest preceding request.
  // The previous `!message.threadId` guard left those replies in the activity
  // feed, where the internal workflow prompt was rendered as user-facing text.
  return message.authorType === "local-user" && message.kind === "message";
}

function threadMessagesForSource(
  sourceMessage: ChannelMessage,
  messagesByThreadId: ReadonlyMap<string, readonly ChannelMessage[]>,
): readonly ChannelMessage[] {
  // A canonical item without a turn id has no reliable parent relation. Do
  // not infer ownership from adjacency alone: an unrelated assistant message
  // in the same channel-root thread must remain a standalone activity row.
  const sourceTurnId = sourceMessage.turnId?.trim();
  if (!sourceTurnId) {
    return [];
  }
  const threadId = sourceMessage.threadId?.trim();
  if (!threadId) {
    return [];
  }
  const threadMessages = messagesByThreadId.get(threadId);
  if (!threadMessages || threadMessages.length === 0) {
    return [];
  }
  const ordered = [...threadMessages].sort(compareByCreatedAtThenId);
  const sourceIndex = ordered.findIndex((message) => message.id === sourceMessage.id);
  if (sourceIndex < 0) {
    return [];
  }
  const result: ChannelMessage[] = [];
  for (const message of ordered.slice(sourceIndex + 1)) {
    if (message.authorType === "local-user" && message.kind === "message") {
      break;
    }
    if (message.turnId === sourceTurnId) {
      result.push(message);
    }
  }
  return result;
}

function uniqueMessages(messages: readonly ChannelMessage[]): readonly ChannelMessage[] {
  return [...new Map(messages.map((message) => [message.id, message])).values()];
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
  readonly silentChannelReplyRunIds?: ReadonlySet<string>;
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

  // The canonical channel message projection carries the turn's active/last
  // run directly. Prefer that lineage when a turn has no proposal/workflow
  // wrapper (for example a direct teammate reply or a resumed run). The
  // operation still resolves through the thread-scoped WorkCell map, so this
  // does not bypass the existing attempt/participant ownership checks.
  const linkedRunIds = uniqueStrings([
    ...(input.sourceMessage.linkedRunId ? [input.sourceMessage.linkedRunId] : []),
    ...input.proposals.map((proposal) => proposal.linkedRunId).filter(isString),
  ]);
  for (const runId of linkedRunIds) {
    if (input.silentChannelReplyRunIds?.has(runId)) {
      continue;
    }
    const threadId = input.runsById.get(runId)?.threadId;
    if (!threadId) {
      continue;
    }
    const cell = input.operationCellByThreadId.get(threadId);
    // The map is thread-scoped and may already contain another turn's cell.
    // A shared thread alone cannot transfer that execution to this request.
    if (cell && cell.runIds.includes(runId) &&
      (!input.sourceMessage.turnId || !cell.turnId || input.sourceMessage.turnId === cell.turnId)) {
      return { cell, ref: { kind: "run_thread", threadId } };
    }
  }

  return undefined;
}

function splitCoordinatorMessages(
  messages: readonly ChannelMessage[],
  operationCell: ConversationWorkCellViewModel | undefined,
  narrationItemIds: ReadonlySet<string>,
): { readonly startMessages: readonly ChannelMessage[]; readonly terminalMessages: readonly ChannelMessage[] } {
  if (messages.length === 0) {
    return { startMessages: [], terminalMessages: [] };
  }

  if (operationCell && (isTerminalOperationStatus(operationCell.status) || messages.length > 1)) {
    // A durable Host narration role survives workflow completion. Keep the
    // existing fallback only among other coordinator messages; text never grants
    // a startup acknowledgement ownership of the terminal result slot.
    const terminalMessage = messages.filter((message) => !narrationItemIds.has(message.id)).at(-1);
    if (terminalMessage) return {
      startMessages: messages.filter((message) => message.id !== terminalMessage.id),
      terminalMessages: [terminalMessage],
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
  readonly conversationItems: readonly ConversationItemV1[];
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
  blocks.push(...buildConversationItemBlocks(input.turnId, input.conversationItems, input.operation));
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
    if (
      input.operation.cell.terminalReportId &&
      input.operation.cell.terminalReportRevisionKey &&
      input.operation.cell.terminalReportRows.length > 0
    ) {
      const outcome = input.operation.cell.terminalReportRows.find((row) => row.reportSection === "outcome");
      blocks.push({
        id: `final-result:${input.operation.cell.terminalReportId}`,
        turnId: input.turnId,
        kind: "final_result",
        status: transcriptStatusFromOperation(input.operation.cell.status),
        revision: 1,
        updatedAt: input.operation.cell.updatedAt,
        display: [{
          id: `display:${input.operation.cell.terminalReportId}:outcome`,
          text: outcome?.title ?? input.operation.cell.title,
          meta: outcome?.description,
        }],
        terminalReportId: input.operation.cell.terminalReportId,
        terminalReportRevisionKey: input.operation.cell.terminalReportRevisionKey,
        rows: input.operation.cell.terminalReportRows,
      });
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

function buildConversationItemBlocks(
  turnId: string,
  items: readonly ConversationItemV1[],
  operation: { readonly cell: ConversationWorkCellViewModel; readonly ref: ConversationTurnOperationRef } | undefined,
): readonly ConversationItemBlock[] {
  return items
    .filter((item) => item.kind !== "user_message" && item.kind !== "assistant_message")
    // U1 anchors are not generic successful operations. U4 supplies the shared domain renderer.
    .filter((item) => item.kind !== "user_input_request" && item.kind !== "user_input_answer")
    .filter((item) => !conversationItemCoveredByOperation(item, operation))
    .sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id))
    .map((item) => {
      const display = conversationItemDisplay(item);
      return {
        id: `conversation-item:${item.id}`,
        turnId,
        kind: "conversation_item",
        status: conversationItemTranscriptStatus(item),
        revision: item.revision,
        updatedAt: item.updatedAt,
        ownerId: item.actorId,
        display: [{ id: `display:${item.id}`, text: display.title, meta: display.meta }],
        expanded: display.detail ? { mode: "inline", title: display.title, summary: display.detail } : undefined,
        ...(item.kind === "artifact_ref" ? {
          previewTargets: [{
            id: `artifact:${item.payload.artifactId}`,
            kind: "artifact" as const,
            label: item.payload.title ?? item.payload.artifactId,
          }],
        } : {}),
        raw: { id: `raw:${item.id}`, source: `conversation-item:${item.id}` },
        item,
      } satisfies ConversationItemBlock;
    });
}

function conversationItemsForSource(input: {
  readonly sourceMessage: ChannelMessage;
  readonly itemsByTurnId: ReadonlyMap<string, readonly ConversationItemV1[]>;
  readonly itemsByThreadId: ReadonlyMap<string, readonly ConversationItemV1[]>;
  readonly rootMessages: readonly ChannelMessage[];
}): readonly ConversationItemV1[] {
  const explicit = input.sourceMessage.turnId
    ? input.itemsByTurnId.get(input.sourceMessage.turnId) ?? []
    : [];
  const fallback = input.itemsByThreadId.get(input.sourceMessage.threadId ?? "") ?? [];
  const fallbackCandidates = fallback.filter((item) => !item.turnId && item.domainRefs.some((ref) =>
    (ref.type === "turn" && ref.id === input.sourceMessage.turnId) ||
    (ref.type === "message" && ref.id === input.sourceMessage.id) ||
    (ref.type === "conversation_item" && ref.id === input.sourceMessage.id),
  ));
  const sameThreadRootCount = input.rootMessages.filter((message) => message.threadId === input.sourceMessage.threadId).length;
  const candidates = fallbackCandidates.length > 0 || sameThreadRootCount === 1
    ? [...explicit, ...(fallbackCandidates.length > 0 ? fallbackCandidates : fallback.filter((item) => !item.turnId))]
    : explicit;
  return [...new Map(candidates.map((item) => [item.id, item])).values()]
    .sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id));
}

function conversationItemCoveredByOperation(
  item: ConversationItemV1,
  operation: { readonly cell: ConversationWorkCellViewModel; readonly ref: ConversationTurnOperationRef } | undefined,
): boolean {
  if (!operation) return false;
  const refs = item.domainRefs;
  if (refs.some((ref) => ref.type === "run" && operation.cell.runIds.includes(ref.id))) return true;
  if (refs.some((ref) => ref.type === "thread" && ref.id === operation.cell.threadId)) return true;
  if (refs.some((ref) => ref.type === "operation" && ref.id === operation.cell.id)) return true;
  if (item.kind === "operation_state" && item.payload.operationId === operation.cell.id) return true;
  const operationRef = operation.ref;
  if (operationRef.kind === "workflow") {
    return refs.some((ref) => ref.type === "workflow" && ref.id === operationRef.workflowId);
  }
  return refs.some((ref) => ref.type === "run" && ref.id === operation.cell.anchorRunId);
}

function conversationItemDisplay(item: ConversationItemV1): { readonly title: string; readonly meta?: string; readonly detail?: string } {
  switch (item.kind) {
    case "user_input_request":
    case "user_input_answer":
      throw new Error("User-input anchors require domain projection");
    case "tool_call":
      return { title: item.payload.title ?? item.payload.toolName, meta: item.payload.toolName, detail: item.payload.inputSummary };
    case "tool_result":
      return { title: item.payload.outputSummary ?? item.payload.status, meta: item.payload.status, detail: item.payload.errorCode };
    case "approval_request":
      return { title: item.payload.title, detail: item.payload.summary };
    case "approval_decision":
      return { title: item.payload.decision, detail: item.payload.reason };
    case "handoff":
      return { title: item.payload.summary, meta: item.payload.targetTeammateId };
    case "operation_state":
      return { title: item.payload.title, meta: item.payload.state, detail: item.payload.summary };
    case "artifact_ref":
      return { title: item.payload.title ?? item.payload.artifactId, meta: item.payload.artifactKind ?? "Artifact" };
    case "terminal_report":
      return { title: item.payload.outcomeStatus, meta: `generation ${item.payload.generation}`, detail: item.payload.evidenceFingerprint };
    case "system_event":
      return { title: item.payload.summary, meta: item.payload.eventType };
    case "user_message":
    case "assistant_message":
      return { title: item.payload.body };
  }
}

function conversationItemTranscriptStatus(item: ConversationItemV1): TranscriptBlockStatus {
  if (item.status === "failed") return "failed";
  if (item.kind === "approval_request") return "waiting_for_approval";
  if (item.status === "pending") return "running";
  if (item.kind === "tool_result") {
    if (item.payload.status === "failed") return "failed";
    if (item.payload.status === "cancelled") return "cancelled";
    return "succeeded";
  }
  if (item.kind === "approval_decision") {
    if (item.payload.decision === "denied") return "failed";
    if (item.payload.decision === "cancelled") return "cancelled";
    return "succeeded";
  }
  if (item.kind === "operation_state") {
    if (item.payload.state === "failed") return "failed";
    if (item.payload.state === "cancelled") return "cancelled";
    if (item.payload.state === "succeeded") return "succeeded";
    return "running";
  }
  return "succeeded";
}

function buildRequirementShapingBlocks(
  turnId: string,
  proposals: readonly ChannelExecutionProposal[],
): readonly ConversationGenericTranscriptBlock[] {
  const blocks: ConversationGenericTranscriptBlock[] = [];
  for (const proposal of proposals.filter((item) => item.shaping && item.status === "draft")) {
    const shaping = proposal.shaping;
    if (!shaping || shaping.status !== "needs_user_clarification" || shaping.openQuestions.length === 0) {
      continue;
    }
    const remainingQuestions = shaping.openQuestions.slice(1);
    blocks.push({
      id: `decision-needed:${proposal.id}`,
      turnId,
      kind: "decision_needed",
      status: "waiting_for_approval",
      revision: 1,
      updatedAt: shaping.updatedAt ?? proposal.updatedAt,
      display: [{
        id: `display:${proposal.id}:decision`,
        text: shaping.openQuestions[0] ?? proposal.title,
      }],
      ...(remainingQuestions.length > 0 ? {
        expanded: {
          mode: "inline" as const,
          lines: remainingQuestions.map((question, index) => ({
            id: `proposal:${proposal.id}:question:${index + 1}`,
            text: question,
            tone: "waiting" as const,
          })),
        },
      } : {}),
    });
  }
  return blocks;
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
