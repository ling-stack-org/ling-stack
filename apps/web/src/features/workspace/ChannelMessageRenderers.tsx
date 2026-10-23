import type { MutableRefObject, ReactNode, RefObject } from "react";
import { terminalReportSourceRefs, visibleTerminalReportTimelineItem } from "@ling-stack/conversation-ui-core";
import { createConversationTimelineMessageItem, projectConversationMessagePresentation, type ConversationProtocolAction, type ConversationTimelineApprovalItem, type ConversationTimelineItem, type ConversationTimelineProtocolEventItem, type ConversationTimelineTerminalReportItem } from "@ling-stack/conversation-ui-core";
import {
  CheckCircle2,
  Copy,
  FileText,
  Image as ImageIcon,
  Pencil,
  Reply,
  ThumbsDown,
  ThumbsUp,
} from "lucide-react";
import { effectiveApprovalStatus } from "../../lib/approvals.js";
import { hasWorkflowTimelineContent } from "../../lib/workflow-timeline-content.js";
import type { ChannelActivityItem } from "../../lib/channel-activity.js";
import { type ConversationWorkCellViewModel } from "../../lib/conversation-work-cell.js";
import type { ConversationTurnViewModel } from "../../lib/conversation-turn-projector.js";
import { truncatePreview } from "../../lib/data.js";
import {
  channelNarrationItemIds,
  projectChannelReasoningSummaryItems,
  projectUncoveredChannelConversationItems,
} from "../../lib/channel-conversation-items.js";
import { projectChannelUserInputTimeline } from "../../lib/channel-user-input-timeline.js";
import { formatDateTime } from "../../lib/formatting.js";
import { terminalReportGeneration } from "../../lib/terminal-report-generation.js";
import type { InlineApprovalView } from "../../lib/inline-approvals.js";
import { attachmentCanPreview, type PreviewRequest } from "../../lib/previews.js";
import {
  buildComposerGateApprovalPresentationByRunId,
  composerGateApprovalPresentationForRunId,
  composerGateApprovalPresentationForRunIds,
} from "../../lib/runtime-approval-presentation.js";
import { filterUsedMemoryEventsByResponse } from "../../shared/components/index.js";
import {
  AvatarInitial,
  UsedMemorySummary,
  UsedMemorySummaryLabel,
  UserProfileAvatar,
} from "../../shared/components/index.js";
import {
  ConversationAttachmentStrip,
  ConversationGeneratedMediaBlock,
  ConversationReferenceStrip,
  ConversationReplacementRetry,
  mountConversationTimeline,
  InlineMessageEditor,
  MessageActionBar,
  MessageBodyRenderer,
  MessageEvidencePanel,
  MessageRow,
  type ConversationTimelineDisclosureIntent,
  type ConversationTimelineItemLocator,
  type ConversationViewRetainKeys,
  type TerminalReportFileTarget,
} from "../../shared/conversation/index.js";
import { InlineFeedback } from "../../shared/ui/index.js";
import { submitUserInputAnswer } from "../../api.js";
import type {
  ChannelAttachment,
  ChannelExecutionProposal,
  ChannelLinkPreview,
  ChannelMention,
  ChannelMessage,
  ChannelMessageFileRef,
  ConversationItemV1,
  ConversationReasoningSummaryRecord,
  UserInputTranscriptItemV1,
  ConversationGeneratedMedia,
  ChannelWorkflow,
  MemoryObject,
  ProposedPlanArtifact,
  PreviewContentResponse,
  StateTransitionEvent,
  TerminalReportDto,
  UsedMemoryEvent,
  UserProfile,
} from "../../types.js";
import { buildSurfaceTimelineSnapshot } from "../../domains/conversations/timeline-snapshot.js";
import type { LocalTeammateDraft } from "../teammates/index.js";
import { TeammateAvatarView } from "../teammates/TeammateAvatarView.js";
import { ChannelExecutionProposalSummary } from "./ChannelExecutionProposalPresentation.js";
import type { ChannelMessageFeedItem } from "./ChannelMessageFeed.js";
import { ChannelProposedPlanBlock } from "./ChannelProposedPlanBlock.js";
import { workflowCanAdvance, workflowCanCancel, workflowStepCanRetry } from "./ChannelWorkflowProposalCards.js";
import {
  channelApprovalTimelineStatus,
  channelDecisionTimelineStatus,
  channelHandoffTimelineStatus,
  channelRunTimelineStatus,
  channelStateTransitionTimelineStatus,
  channelTaskTimelineStatus,
  channelWorkflowStepTimelineStatus,
  channelWorkflowTimelineStatus,
} from "./channel-protocol-timeline-status.js";
import { readChannelProposedPlanMessage } from "./channel-proposed-plan-message.js";
import { conversationTimelineItemsForModel } from "../../lib/conversation-work-cell.js";
import type { WorkflowProgressModel } from "../../lib/workflow-progress.js";
import { requestTimelineWorkspaceFileOpen } from "../../shared/conversation/timeline/workspace-file-capability.js";

function channelMessageTimelineItem(
  message: ChannelMessage,
  body: string,
  streaming: boolean,
): ConversationTimelineItem {
  const role = message.authorType === "local-user" ? "user" : "agent";
  return createConversationTimelineMessageItem({
    id: `message:${role}:${message.id}`,
    role,
    markdown: body,
    waitingPlaceholder: streaming && !message.body.trim(),
    phase: role === "agent" && !streaming && message.status === "ready" ? "final" : "commentary",
    revision: message.revision,
    threadSequence: 0,
    status: streaming ? "running" : message.status === "blocked" ? "blocked" : message.status === "failed" ? "failed" : "succeeded",
    turnId: message.turnId,
    participantId: role === "agent" ? message.authorId ?? message.authorType : undefined,
    itemId: message.id,
    fileRefs: message.fileRefs,
  });
}

/**
 * The channel audit feed contains protocol records that are not execution
 * evidence (decision, handoff, task/run lifecycle, workflow, and transitions).
 * Project them into the same factual rail as normal/private/channel turns so
 * the surface never falls back to a second MessageBubble renderer.
 */
function channelProtocolTimelineItem(
  item: Exclude<ChannelActivityItem, { readonly kind: "message" }>,
  t: (key: string, values?: Record<string, string | number>) => string,
  descriptionOverride?: string,
  options?: {
    readonly handoffWorkflowStarted?: boolean;
    readonly actionBusy?: boolean;
    readonly actionFeedback?: string;
  },
): ConversationTimelineProtocolEventItem | ConversationTimelineApprovalItem {
  const sourceRefs = [{
    kind: `channel_${item.kind}`,
    id: item.record.id,
    label: item.kind,
    visibility: "audit" as const,
  }];
  if (item.kind === "approval") {
    const status = effectiveApprovalStatus(item.record);
    return {
      id: `approval:${item.record.id}`,
      kind: "approval",
      revision: protocolRevision(item.createdAt),
      threadSequence: 0,
      partIndex: 0,
      status: channelApprovalTimelineStatus(status),
      ...(item.record.runId ? { runId: item.record.runId } : {}),
      ...(item.record.workflowStepId ? { workflowStepId: item.record.workflowStepId } : {}),
      sourceRefs,
      title: item.record.title,
      description: item.record.description,
      meta: status,
      approvalId: item.record.id,
      availableActions: ["open_approval", "open_details"],
      decision: status === "approved"
        ? "allowed"
        : status === "denied"
          ? "denied"
          : status === "expired"
            ? "expired"
            : status === "cancelled"
              ? "cancelled"
              : undefined,
    };
  }
  const base = {
    id: `protocol:${item.id}`,
    kind: "protocolEvent" as const,
    revision: protocolRevision(item.createdAt),
    threadSequence: 0,
    partIndex: 0,
    sourceRefs,
  };
  if (item.kind === "decision") {
    return {
      ...base,
      protocolKind: "decision",
      title: item.record.title,
      meta: item.record.status,
      status: channelDecisionTimelineStatus(item.record.status),
      availableActions: protocolActions(
        item.record.status === "active" && !options?.actionBusy ? "supersede_decision" : undefined,
        item.record.status === "active" && !options?.actionBusy ? "reject_decision" : undefined,
        "open_source",
        "open_details",
      ),
      description: [item.record.decision, item.record.rationale, item.record.alternatives.length > 0 ? item.record.alternatives.join("\n") : undefined, options?.actionFeedback]
        .filter(Boolean)
        .join("\n\n"),
    };
  }
  if (item.kind === "handoff") {
    return {
      ...base,
      protocolKind: "handoff",
      title: `${item.record.fromParticipantLabel} → ${item.record.toParticipantLabel}`,
      meta: item.record.status,
      status: channelHandoffTimelineStatus(item.record.status),
      availableActions: options?.handoffWorkflowStarted
        ? ["open_source", "open_details"]
        : ["start_workflow", "open_source", "open_details"],
      description: [item.record.reason, item.record.requiredInput ? t("Required input: {value}", { value: item.record.requiredInput }) : undefined, item.record.expectedOutput ? t("Expected output: {value}", { value: item.record.expectedOutput }) : undefined]
        .filter(Boolean)
        .join("\n\n"),
    };
  }
  if (item.kind === "summary") {
    return {
      ...base,
      protocolKind: "summary",
      title: t("Context summary"),
      meta: item.record.targetType,
      status: "succeeded",
      availableActions: ["create_task", "open_source", "open_details"],
      description: item.record.summary,
    };
  }
  if (item.kind === "workflow") {
    return {
      ...base,
      protocolKind: "workflow",
      title: cleanGeneratedWorkflowText(item.record.title) ?? item.record.objective,
      meta: item.record.status,
      status: channelWorkflowTimelineStatus(item.record.status),
      availableActions: protocolActions(
        workflowCanAdvance(item.record.status) && !options?.actionBusy ? "advance_workflow" : undefined,
        workflowCanCancel(item.record.status) && !options?.actionBusy ? "cancel_workflow" : undefined,
        "open_source",
        "open_details",
      ),
      description: [descriptionOverride?.trim() || item.record.objective, options?.actionFeedback].filter(Boolean).join("\n\n"),
    };
  }
  if (item.kind === "workflow-step") {
    return {
      ...base,
      protocolKind: "workflow-step",
      title: cleanGeneratedWorkflowText(item.record.title) ?? item.record.prompt,
      meta: item.record.status,
      status: channelWorkflowStepTimelineStatus(item.record.status),
      availableActions: protocolActions(
        workflowStepCanRetry(item.record.status) && !options?.actionBusy ? "retry_step" : undefined,
        "open_source",
        "open_details",
      ),
      description: [item.record.prompt, item.record.blocker, item.record.resultSummary, options?.actionFeedback].filter(Boolean).join("\n\n"),
    };
  }
  if (item.kind === "task") {
    return {
      ...base,
      protocolKind: "task",
      title: item.record.title,
      meta: item.record.status,
      status: channelTaskTimelineStatus(item.record.status),
      availableActions: ["open_task", "open_details"],
      description: item.record.prompt,
    };
  }
  if (item.kind === "run") {
    const taskTitle = item.task?.title ?? item.record.taskId;
    return {
      ...base,
      protocolKind: "run",
      title: t("Run for {title}", { title: taskTitle }),
      meta: item.record.status,
      status: channelRunTimelineStatus(item.record.status),
      availableActions: ["open_run", "open_details"],
      description: item.record.errorMessage ?? item.record.providerName,
    };
  }
  return {
    ...base,
    protocolKind: "state-transition",
    title: `${item.record.entityType} ${item.record.entityId}`,
    meta: item.record.toStatus,
    status: channelStateTransitionTimelineStatus(item.record),
    availableActions: ["open_details"],
    description: `${item.record.fromStatus} → ${item.record.toStatus} via ${item.record.event}${item.record.reason ? `\n\n${item.record.reason}` : ""}`,
  };
}

function protocolActions(
  ...actions: readonly (ConversationProtocolAction | undefined | false)[]
): readonly ConversationProtocolAction[] {
  return actions.filter((action): action is ConversationProtocolAction => Boolean(action));
}

function protocolRevision(value: string): number {
  const parsed = Date.parse(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function channelTurnTimelineItems(
  turn: ConversationTurnViewModel,
  surface: "channel_root" | "topic" | "branch",
  conversationItems: readonly ConversationItemV1[],
  reasoningSummaries: readonly ConversationReasoningSummaryRecord[],
  contextCompactions: readonly import("../../types.js").ConversationContextCompactionRecord[],
  t: (key: string, values?: Record<string, string | number>) => string,
  terminalReportById: ReadonlyMap<string, TerminalReportDto>,
  workflowById: ReadonlyMap<string, ChannelWorkflow>,
  workflowProgressByWorkflowId: ReadonlyMap<string, WorkflowProgressModel>,
  workflowErrors: Readonly<Record<string, string>>,
  orchestratingWorkflowId: string,
  composerApprovalId?: string,
): readonly ConversationTimelineItem[] {
  const projectNarration = (
    messages: readonly ChannelMessage[],
    phase: "start" | "terminal",
  ): readonly ConversationTimelineItem[] => messages.flatMap((message) => {
      // The interactive proposed-plan block is message chrome for this durable
      // coordinator item. Keep the message anchor in the Timeline, but leave
      // its Markdown lane empty so the surrounding prose/plan body is not
      // rendered a second time next to the structured plan block.
      const proposedPlan = readChannelProposedPlanMessage(message.body, message);
      const body = proposedPlan
        ? ""
        : conversationCoordinatorDisplayBody(turn, message, phase, t);
      if (!proposedPlan && !body.trim()) {
        return [];
      }
      return [channelMessageTimelineItem(
        message,
        body,
        message.status === "pending",
      )];
    });
  const startNarration = projectNarration(turn.coordinatorStartMessages, "start");
  const terminalNarration = projectNarration(turn.coordinatorTerminalMessages, "terminal");
  const turnId = turn.sourceMessage.turnId;
  const reasoning = turnId
    ? projectChannelReasoningSummaryItems(
        conversationItems.filter((item) => item.turnId === turnId),
        reasoningSummaries.filter((summary) => summary.turnId === turnId),
        surface,
        contextCompactions.filter(record => record.turnId === turnId),
      )
    : [];
  const uncoveredConversationItems = projectUncoveredChannelConversationItems(
    turn.blocks.flatMap((block) => block.kind === "conversation_item" ? [block.item] : []),
    surface,
  );
  const projectedFacts = turn.operationCell
    ? conversationTimelineItemsForModel(turn.operationCell, composerApprovalId)
    : [];
  const workflow = turn.operationRef?.kind === "workflow" ? workflowById.get(turn.operationRef.workflowId) : undefined;
  const facts = projectedFacts.some(hasWorkflowTimelineContent) || !workflow
    ? projectedFacts
    : [channelProtocolTimelineItem({
        id: `workflow:${workflow.id}`,
        kind: "workflow",
        createdAt: workflow.updatedAt,
        record: workflow,
        category: "runtime",
        attention: workflow.status === "blocked"
          ? "blocked"
          : workflow.status === "failed" || workflow.status === "cancelled"
            ? "failed"
            : workflow.status === "running" || workflow.status === "waiting_for_approval"
              ? "pending"
              : "none",
        searchText: `${workflow.title} ${workflow.objective}`.toLowerCase(),
      }, t, workflowProgressByWorkflowId.get(workflow.id)?.summary, {
        actionBusy: orchestratingWorkflowId === workflow.id,
        actionFeedback: workflowErrors[workflow.id],
      })];
  const terminalReport = channelTurnTerminalReportTimelineItem(
    turn, terminalReportById.get(turn.operationCell?.terminalReportId ?? ""), conversationItems,
  );
  const ordered = [...startNarration, ...uncoveredConversationItems, ...facts, ...reasoning, ...terminalNarration, ...(terminalReport ? [terminalReport] : [])]
    .filter((item, index, all) => all.findIndex((candidate) => candidate.id === item.id) === index);
  // The feed assigns a large base sequence per turn. Normalize the already
  // projected turn-local order so equal legacy sequence values cannot reorder
  // narration ahead of the source user message by string id.
  return ordered.map((item, index) => ({
    ...item,
    threadSequence: index + 1,
  }));
}

function channelTurnTerminalReportTimelineItem(
  turn: ConversationTurnViewModel,
  report: TerminalReportDto | undefined,
  conversationItems: readonly ConversationItemV1[],
): ConversationTimelineTerminalReportItem | undefined {
  const block = turn.blocks.find((candidate): candidate is Extract<ConversationTurnViewModel["blocks"][number], { kind: "final_result" }> => candidate.kind === "final_result");
  if (!block || !turn.operationCell) {
    return undefined;
  }
  const countRows = (section: string): number => block.rows.filter((row) => row.reportSection === section).length;
  const outcome = block.rows.find((row) => row.reportSection === "outcome");
  const generation = terminalReportGeneration(report, block.terminalReportId, conversationItems, {
    workspaceId: turn.sourceMessage.workspaceId,
    channelId: turn.sourceMessage.channelId,
    threadId: turn.sourceMessage.threadId ?? "",
    turnId: turn.operationCell.turnId ?? turn.sourceMessage.turnId ?? "",
  });
  if (generation === undefined) return undefined;
  const fallbackStatus = terminalReportTimelineStatus(turn.operationCell.status);
  const outcomeStatus = report?.outcome.status ?? (fallbackStatus === "failed" || fallbackStatus === "blocked" || fallbackStatus === "cancelled"
    ? fallbackStatus : "succeeded");
  const timelineStatus = report?.outcome.status ?? fallbackStatus;
  return visibleTerminalReportTimelineItem({
    id: `terminal-report:${block.terminalReportId}`,
    kind: "terminalReport",
    language: report?.language,
    outcomeSourceRefs: terminalReportSourceRefs(report?.outcome.sourceRefs ?? []),
    revision: block.revision ?? 1,
    threadSequence: Number.MAX_SAFE_INTEGER - 1,
    partIndex: 0,
    status: timelineStatus,
    // ConversationTurnViewModel.id is a presentation-only grouping key. Recovery
    // and lineage must use the durable LingTurn id carried by the operation cell.
    turnId: turn.operationCell.turnId ?? turn.id,
    sourceRefs: [{ kind: "terminal_report", id: block.terminalReportId }],
    title: outcome?.title ?? turn.operationCell.title,
    description: outcome?.description,
    meta: `generation ${generation}`,
    reportId: block.terminalReportId,
    generation,
    resultItemId: terminalReportResultItemId(report, block.terminalReportId),
    outcomeStatus,
    summary: outcome?.description ?? turn.operationCell.summary,
    changeCount: report?.changes.length ?? countRows("change"),
    verificationCount: report?.verification.length ?? countRows("verification"),
    participantCount: report?.participants.length ?? countRows("participant"),
    artifactCount: report?.artifacts.length ?? 0,
    riskCount: report?.risks.length ?? countRows("risk"),
    corrections: report?.outcome.corrections.map((correction) => ({
      ...correction,
      sourceRefs: terminalReportSourceRefs(correction.sourceRefs),
    })) ?? [],
    changes: report?.changes.map((change) => ({
      ...change,
      sourceRefs: terminalReportSourceRefs(change.sourceRefs),
    })) ?? block.rows.filter((row) => row.reportSection === "change").map((row) => ({
      id: row.id,
      kind: "other",
      title: row.title,
      summary: row.description ?? "",
      paths: row.detailLines?.filter((line) => line.kind === "file_ref").map((line) => line.path) ?? [],
      sourceRefs: [],
    })),
    verification: report?.verification.map((verification) => ({
      ...verification,
      sourceRefs: terminalReportSourceRefs(verification.sourceRefs),
    })) ?? block.rows.filter((row) => row.reportSection === "verification").map((row) => ({
      id: row.id,
      title: row.title,
      status: row.tone === "success" ? "passed" : row.tone === "failed" ? "failed" : "unknown",
      summary: row.description,
      sourceRefs: [],
    })),
    participants: report?.participants.map((participant) => ({
      ...participant,
      sourceRefs: terminalReportSourceRefs(participant.sourceRefs),
    })) ?? block.rows.filter((row) => row.reportSection === "participant").map((row) => ({
      agentId: row.participantId ?? row.id,
      displayName: row.title,
      status: row.tone === "failed" ? "failed" : "completed",
      contribution: row.description ?? "",
      sourceRefs: [],
    })),
    artifacts: report?.artifacts.map((artifact) => ({
      ...artifact,
      sourceRefs: terminalReportSourceRefs(artifact.sourceRefs),
    })) ?? [],
    risks: report?.risks.map((risk) => ({
      ...risk,
      sourceRefs: terminalReportSourceRefs(risk.sourceRefs),
    })) ?? block.rows.filter((row) => row.reportSection === "risk").map((row) => ({
      id: row.id,
      severity: row.tone === "failed" ? "critical" : "warning",
      status: "unresolved",
      summary: row.title,
      nextAction: row.description,
      sourceRefs: [],
    })),
    references: report ? terminalReportSourceRefs(report.references) : [],
  });
}

function terminalReportResultItemId(report: TerminalReportDto | undefined, reportId: string): string {
  if (report && "resultItemId" in report && typeof report.resultItemId === "string" && report.resultItemId) return report.resultItemId;
  return `result_terminal_report:${reportId}`;
}

function terminalReportTimelineStatus(status: ConversationWorkCellViewModel["status"]): Exclude<ConversationTimelineTerminalReportItem["status"], undefined> {
  if (status === "failed") return "failed";
  if (status === "blocked") return "blocked";
  if (status === "cancelled") return "cancelled";
  if (status === "active") return "running";
  return "succeeded";
}

type FeedbackValue = "up" | "down";

export interface ChannelMessageRenderersInput {
  readonly runLifecycles?: import("@ling-stack/conversation-ui-core").TimelineSnapshot["runLifecycles"];
  readonly allLocalTeammateById: ReadonlyMap<string, LocalTeammateDraft>;
  readonly allLocalTeammateByName: ReadonlyMap<string, LocalTeammateDraft>;
  readonly attachmentContentUrl: (attachment: ChannelAttachment) => string;
  readonly auditActivityVisible: boolean;
  readonly generatedMedia: readonly ConversationGeneratedMedia[];
  readonly channelAttachmentById: ReadonlyMap<string, ChannelAttachment>;
  readonly channelLinkPreviewById: ReadonlyMap<string, ChannelLinkPreview>;
  readonly channelMessageFeedbackById: Readonly<Record<string, FeedbackValue>>;
  readonly channelConversationItems: readonly ConversationItemV1[];
  readonly channelUserInputs: readonly UserInputTranscriptItemV1[];
  readonly channelReasoningSummaries: readonly ConversationReasoningSummaryRecord[];
  readonly channelContextCompactions?: readonly import("../../types.js").ConversationContextCompactionRecord[];
  readonly channelWorkflows: readonly ChannelWorkflow[];
  readonly terminalReports: readonly TerminalReportDto[];
  readonly conversationWorkCellByThreadId: ReadonlyMap<string, ConversationWorkCellViewModel>;
  readonly conversationWorkCellByWorkflowId: ReadonlyMap<string, ConversationWorkCellViewModel>;
  readonly composerGateApprovals: readonly InlineApprovalView[];
  readonly cwd: string;
  readonly workspaceId?: string;
  readonly executionProposalsByMessageId: ReadonlyMap<string, readonly ChannelExecutionProposal[]>;
  readonly formatBytes: (value: number) => string;
  readonly latestStatus: string;
  readonly latestEditableMessageId?: string;
  readonly editingMessageId?: string;
  readonly editSaving?: boolean;
  readonly editError?: string;
  readonly replacementRetryingMessageId?: string;
  readonly replacementRetryError?: string;
  readonly localUserDisplayName: string;
  readonly loadPreview: (request: PreviewRequest) => Promise<PreviewContentResponse>;
  readonly memoryById: ReadonlyMap<string, MemoryObject>;
  readonly selectedChannelBranchRootThreadId: string | undefined;
  readonly selectedChannelId: string;
  readonly selectedChannelThreadId: string;
  readonly teammateOptions: readonly ChannelMention[];
  readonly t: (key: string, values?: Record<string, string | number>) => string;
  readonly timelineItemLocatorRef: MutableRefObject<ConversationTimelineItemLocator | null>;
  readonly timelineScrollRef: RefObject<HTMLDivElement | null>;
  readonly timelineViewRetainKeys: ConversationViewRetainKeys;
  readonly onTimelineDisclosureIntent: (intent: ConversationTimelineDisclosureIntent) => void;
  readonly usedMemoryEvents: readonly UsedMemoryEvent[];
  readonly userProfile?: UserProfile;
  readonly workflowProgressByWorkflowId: ReadonlyMap<string, WorkflowProgressModel>;
  readonly workflowErrors: Readonly<Record<string, string>>;
  readonly orchestratingWorkflowId: string;
  readonly runningWorkflowStepId: string;
  readonly onAcceptProposedPlan: (plan: ProposedPlanArtifact) => void;
  readonly onConvertProposedPlan: (plan: ProposedPlanArtifact) => void;
  readonly onOpenExecutionProposal: (proposal: ChannelExecutionProposal) => void;
  readonly onOpenFileReference: () => void;
  readonly onOpenTerminalReportFile: (target: TerminalReportFileTarget) => void;
  readonly onOpenReview: (target: import("./right-dock/WorkspaceRightDock.js").WorkspaceRightDockReviewTarget) => void;
  readonly onOpenThreadForMessage: (message: ChannelMessage) => void;
  readonly onInvokeProtocolAction: (
    item: ConversationTimelineProtocolEventItem | ConversationTimelineApprovalItem,
    action: ConversationProtocolAction,
  ) => void | Promise<void>;
  readonly onRefineProposedPlan: (plan: ProposedPlanArtifact) => void;
  readonly onSaveProposedPlan: (plan: ProposedPlanArtifact) => void;
  readonly onToggleChannelMessageFeedback: (messageId: string, feedback: FeedbackValue) => void;
  readonly onBeginMessageEdit: (messageId: string) => void;
  readonly onCancelMessageEdit: () => void;
  readonly onSaveMessageEdit: (message: ChannelMessage, body: string) => void | Promise<void>;
  readonly onRetryMessageReplacement: (message: ChannelMessage) => void | Promise<void>;
  readonly planActionBusyId: string;
  readonly proposedPlanArtifactsById: ReadonlyMap<string, ProposedPlanArtifact>;
}

export interface ChannelMessageRenderers {
  /** Builds the single channel/topic/branch Timeline root from the feed snapshot. */
  readonly renderUnifiedTimeline: (feedItems: readonly ChannelMessageFeedItem[]) => ReactNode;
}

export function createChannelMessageRenderers(input: ChannelMessageRenderersInput): ChannelMessageRenderers {
  const channelSurface = input.selectedChannelBranchRootThreadId ? "channel_branch" : "channel_root";
  const narrationItemIds = channelNarrationItemIds(input.channelConversationItems, {
    workspaceId: input.workspaceId,
    channelId: input.selectedChannelId,
    threadId: input.selectedChannelThreadId,
  });
  const terminalReportById = new Map(input.terminalReports.map((report) => [report.id, report]));
  const workflowById = new Map(input.channelWorkflows.map((workflow) => [workflow.id, workflow]));
  const composerGateApprovalByRunId = buildComposerGateApprovalPresentationByRunId(input.composerGateApprovals, input.t);
  async function handleOpenTimelineSourceRef(
    ref: import("@ling-stack/conversation-ui-core").ConversationOperationSourceRef,
    item?: import("@ling-stack/conversation-ui-core").ConversationTimelineItem,
  ): Promise<void> {
    if (ref.kind !== "file" && ref.kind !== "path" && ref.kind !== "diff" && ref.kind !== "artifact") {
      throw new Error("This source is not an openable workspace resource.");
    }
    await requestTimelineWorkspaceFileOpen(ref, item, {
      cwd: input.cwd.trim(),
      workspaceId: input.workspaceId,
      threadId: input.selectedChannelThreadId,
    }, input.onOpenTerminalReportFile);
  }
  function renderLingAgentAvatar(): ReactNode {
    const teammate = input.allLocalTeammateById.get(LING_AGENT_AUTHOR_ID);
    return (
      <TeammateAvatarView
        teammate={teammate ?? {
          displayName: LING_AGENT_AUTHOR_LABEL,
          templateId: LING_AGENT_AUTHOR_ID,
          kind: "system_teammate",
          systemRole: "ling_agent",
          roleKey: "custom",
          avatarTone: "violet",
        }}
        cwd={input.cwd}
        compact
      />
    );
  }

  function renderChannelMessageAvatar(message: ChannelMessage): ReactNode {
    if (message.authorType === "ai-teammate") {
      const teammate = input.allLocalTeammateById.get(message.authorId ?? "");
      return teammate
        ? <TeammateAvatarView teammate={teammate} cwd={input.cwd} compact />
        : message.authorId === LING_AGENT_AUTHOR_ID
          ? renderLingAgentAvatar()
          : <AvatarInitial label="A" tone="teal" />;
    }
    if (message.authorType === "system") {
      return <AvatarInitial label="S" tone="violet" />;
    }
    return <UserProfileAvatar profile={input.userProfile} fallbackLabel={input.localUserDisplayName} />;
  }

  function renderConversationParticipantAvatar(participantId: string | undefined, label: string): ReactNode {
    const teammate = resolveConversationParticipantTeammate(participantId, label);
    return teammate ? <TeammateAvatarView teammate={teammate} cwd={input.cwd} compact /> : undefined;
  }

  function resolveConversationParticipantTeammate(participantId: string | undefined, label: string): LocalTeammateDraft | undefined {
    const normalizedParticipantId = participantId?.trim();
    const normalizedLabel = normalizeAgentLabel(label);
    return (normalizedParticipantId ? input.allLocalTeammateById.get(normalizedParticipantId) : undefined) ??
      input.allLocalTeammateByName.get(label.trim().toLowerCase()) ??
      [...input.allLocalTeammateById.values()].find((candidate) =>
        candidate.templateId === normalizedParticipantId ||
        candidate.roleKey === normalizedParticipantId ||
        normalizeAgentLabel(candidate.displayName) === normalizedLabel,
      );
  }

  function renderExecutionProposalAssigneeAvatar(proposal: ChannelExecutionProposal, assigneeLabel: string): ReactNode {
    const teammate = resolveConversationParticipantTeammate(proposal.assigneeTeammateId, assigneeLabel);
    return (
      <TeammateAvatarView
        teammate={teammate ?? {
          displayName: assigneeLabel,
          roleKey: "custom",
          avatarTone: "gray",
        }}
        cwd={input.cwd}
        compact
      />
    );
  }

  function renderChannelAiMessageActions(message: ChannelMessage, copyText: string): ReactNode {
    const feedback = input.channelMessageFeedbackById[message.id];
    return (
      <div className="channel-message-row-footer-stack">
        <MessageActionBar
          surface={channelSurface}
          className="channel-message-ai-actions"
          copiedLabel={input.t("Copied")}
          actions={[
            {
              id: "copy",
              kind: "copy",
              label: input.t("Copy message"),
              icon: <Copy size={14} />,
              copyText,
            },
            {
              id: "like",
              kind: "like",
              label: input.t("Like response"),
              icon: <ThumbsUp size={14} />,
              selected: feedback === "up",
              onClick: () => input.onToggleChannelMessageFeedback(message.id, "up"),
            },
            {
              id: "dislike",
              kind: "dislike",
              label: input.t("Dislike response"),
              icon: <ThumbsDown size={14} />,
              selected: feedback === "down",
              onClick: () => input.onToggleChannelMessageFeedback(message.id, "down"),
            },
            {
              id: "reply",
              kind: "reply_topic",
              label: input.t("Reply in topic"),
              icon: <Reply size={14} />,
              onClick: () => input.onOpenThreadForMessage(message),
            },
          ]}
        />
      </div>
    );
  }

  function channelMessageToActivityItem(message: ChannelMessage): Extract<ChannelActivityItem, { readonly kind: "message" }> {
    return {
      id: `message:${message.id}`,
      kind: "message",
      createdAt: message.createdAt,
      record: message,
      category: "message",
      attention: message.status === "blocked" ? "blocked" : message.status === "failed" ? "failed" : message.status === "pending" ? "pending" : "none",
      searchText: message.body.toLowerCase(),
    };
  }

  function renderMessageActivityItem(
    item: Extract<ChannelActivityItem, { readonly kind: "message" }>,
    bodyOverride?: ReactNode,
    ownsIdentity = true,
  ): ReactNode {
    const message = item.record;
    const plainChatMessage = message.kind === "message" || message.kind === "ai_reply" || message.kind === "system" || message.kind === "task_link";
    const pendingAiReply = message.kind === "ai_reply" && message.status === "pending";
    const pendingAiReplyBody = pendingAiReply && !message.body.trim() ? input.t("Thinking...") : message.body;
    const executionProposals = (input.executionProposalsByMessageId.get(message.id) ?? [])
      .filter((proposal) => input.auditActivityVisible || !proposalShouldHideInDefaultFeed(proposal, input.channelWorkflows));
    const messageUsedMemoryEvents = filterUsedMemoryEventsByResponse(input.usedMemoryEvents, message.id);
    const usedMemorySummary = messageUsedMemoryEvents.length > 0 ? (
      <UsedMemorySummary variant="inline" events={messageUsedMemoryEvents} memoryById={input.memoryById} />
    ) : undefined;
    const messageFileRefs = message.fileRefs ?? [];
    const proposedPlanBlock = message.kind === "ai_reply" && message.authorType === "ai-teammate"
      ? readChannelProposedPlanMessage(pendingAiReplyBody, message)
      : undefined;
    const proposedPlan = proposedPlanBlock
      ? input.proposedPlanArtifactsById.get(proposedPlanBlock.plan.id) ?? proposedPlanBlock.plan
      : undefined;
    const visibleMessageBody = proposedPlanBlock?.displayBody ?? pendingAiReplyBody;
    const displayableMessageBody = shouldHideStandaloneCoordinatorBody(message, visibleMessageBody)
      ? ""
      : visibleMessageBody;
    const messagePresentation = projectConversationMessagePresentation({
      content: displayableMessageBody,
      errorMessage: message.errorMessage,
      status: message.status,
      streaming: pendingAiReply,
      streamingPlaceholder: input.t("Thinking..."),
    });
    const editing = input.editingMessageId === message.id;
    const generatedMedia = generatedMediaForMessage(input.generatedMedia, message);
    if (plainChatMessage) {
      return (
        <div className="message-group">
          <MessageRow
            surface={channelSurface}
            className={message.status === "blocked" ? "channel-message-row blocked" : "channel-message-row"}
            authorType={message.authorType}
            tone={message.authorType === "ai-teammate" && message.status === "blocked"
              ? "chat-blocked"
              : message.authorType === "system" ? "system" : "document"}
            avatar={renderChannelMessageAvatar(message)}
            identityContinuation={message.authorType === "ai-teammate" && !ownsIdentity}
            authorName={messageAuthorLabel(message, input.teammateOptions, input.t("Deleted teammate"), input.localUserDisplayName, input.allLocalTeammateById)}
            createdAtLabel={formatDateTime(message.createdAt)}
            statusNode={message.editedAt ? <span className="conversation-message-edited-label">{input.t("Edited")}</span> : undefined}
            bodyNode={editing ? (
              <div className="conversation-inline-message-editor-stack">
                <InlineMessageEditor
                  initialValue={message.body}
                  cwd={input.cwd}
                  ariaLabel={input.t("Edit message")}
                  saveLabel={input.t("Save and resend")}
                  cancelLabel={input.t("Cancel")}
                  saving={input.editSaving}
                  onCancel={input.onCancelMessageEdit}
                  onSave={(value) => input.onSaveMessageEdit(message, value)}
                />
                {input.editError ? <div className="inline-error compact-inline-error" role="alert">{input.editError}</div> : null}
              </div>
            ) : (
              <div className="message-body-shell">
                {bodyOverride ?? (
                  <MessageBodyRenderer
                    text={messagePresentation.body}
                    cwd={input.cwd}
                    compact
                    streaming={pendingAiReply}
                    // Model-text paths are display-only; only typed timeline
                    // evidence may open a workspace file.
                    onOpenLocalFile={undefined}
                  />
                )}
                {proposedPlanBlock ? (
                  <ChannelProposedPlanBlock
                    plan={proposedPlan ?? proposedPlanBlock.plan}
                    cwd={input.cwd}
                    t={input.t}
                    busy={input.planActionBusyId === (proposedPlan ?? proposedPlanBlock.plan).id}
                    onAccept={input.onAcceptProposedPlan}
                    onConvert={input.onConvertProposedPlan}
                    onRefine={input.onRefineProposedPlan}
                    onSave={input.onSaveProposedPlan}
                  />
                ) : null}
              </div>
            )}
            attachmentsNode={renderChannelMessageAssets(message.attachmentIds, messageFileRefs, message.linkPreviewIds, message.channelId)}
            workCellNode={message.authorType === "ai-teammate" ? (
              <ConversationGeneratedMediaBlock items={generatedMedia} cwd={input.cwd} />
            ) : null}
            evidenceNode={(messageUsedMemoryEvents.length > 0 || message.webEvidence) ? (
              <MessageEvidencePanel
                memoryContent={usedMemorySummary}
                memorySummary={messageUsedMemoryEvents.length > 0 ? <UsedMemorySummaryLabel events={messageUsedMemoryEvents} /> : undefined}
                webEvidence={message.webEvidence}
              />
            ) : null}
            errorNode={messagePresentation.errorText || message.pendingReplacement ? (
              <>
                {messagePresentation.errorText ? (
                  <InlineFeedback className="channel-message-error" tone="danger">
                    {messagePresentation.errorText}
                  </InlineFeedback>
                ) : null}
                {message.pendingReplacement ? (
                  <ConversationReplacementRetry
                    failureReason={input.replacementRetryError || message.pendingReplacement.failureReason}
                    retryLabel={input.t("Retry response")}
                    retrying={input.replacementRetryingMessageId === message.id}
                    onRetry={() => void input.onRetryMessageReplacement(message)}
                  />
                ) : null}
              </>
            ) : null}
            actionsNode={!editing && message.status !== "blocked" && message.authorType === "local-user"
                ? (
                    <MessageActionBar
                      surface={channelSurface}
                      className="channel-message-user-actions"
                      actions={[
                        {
                          id: "copy",
                          kind: "copy",
                          label: input.t("Copy message"),
                          icon: <Copy size={14} />,
                          copyText: message.body,
                        },
                        ...(input.latestEditableMessageId === message.id ? [{
                          id: "edit",
                          kind: "edit_latest" as const,
                          label: input.t("Edit message"),
                          icon: <Pencil size={14} />,
                          onClick: () => input.onBeginMessageEdit(message.id),
                        }] : []),
                      ]}
                    />
                  )
                : null}
          />
          {executionProposals.map((proposal) => renderExecutionProposalCard(proposal))}
        </div>
      );
    }
    // ChannelMessageKind is exhaustive above; keep a defensive null for a
    // future kind until it gets a typed Timeline message adapter.
    return null;
  }

  function renderExecutionProposalCard(proposal: ChannelExecutionProposal): ReactNode {
    const assigneeLabel = teammateLabel(
      proposal.assigneeTeammateId,
      input.teammateOptions,
      input.t("Deleted teammate"),
      input.allLocalTeammateById,
    );
    return (
      <ChannelExecutionProposalSummary
        key={proposal.id}
        proposal={proposal}
        assigneeAvatar={renderExecutionProposalAssigneeAvatar(proposal, assigneeLabel)}
        assigneeLabel={assigneeLabel}
        onOpen={() => input.onOpenExecutionProposal(proposal)}
      />
    );
  }

  function renderUnifiedTimeline(feedItems: readonly ChannelMessageFeedItem[]): ReactNode {
    const timelineItems: ConversationTimelineItem[] = [];
    const messageByTimelineItemId = new Map<string, ChannelMessage>();
    const addItem = (item: ConversationTimelineItem, sequence: number): void => {
      if (timelineItems.some((candidate) => candidate.id === item.id)) return;
      timelineItems.push({
        ...item,
        ...(item.kind === "agentMessage" && item.itemId && narrationItemIds.has(item.itemId)
          ? { phase: "commentary" as const } : {}),
        // Every adapter emits turn-local offsets. The feed base is applied
        // exactly once here so optimistic rows cannot overtake later items.
        threadSequence: sequence + item.threadSequence,
      });
    };
    const addMessage = (message: ChannelMessage, body: string, sequence: number): void => {
      const pending = message.kind === "ai_reply" && message.status === "pending";
      const item = channelMessageTimelineItem(message, body, pending);
      addItem(item, sequence);
      messageByTimelineItemId.set(item.id, message);
    };

    feedItems.forEach((feedItem, feedIndex) => {
      const sequence = feedIndex * 1_000_000;
      if (feedItem.kind === "older-loader") return;
      if (feedItem.kind === "pending-send") {
        addItem(createConversationTimelineMessageItem({
          id: `message:user:pending:${feedItem.preview.id}`,
          role: "user",
          markdown: feedItem.preview.body,
          status: "pending",
          threadSequence: 0,
          sourceRefs: [],
        }), sequence);
        if (feedItem.preview.requestAiReply) {
          addItem(createConversationTimelineMessageItem({
            id: `message:agent:pending:${feedItem.preview.id}`,
            role: "agent",
            markdown: input.t("Thinking..."),
            waitingPlaceholder: true,
            status: "running",
            threadSequence: 1,
            sourceRefs: [],
          }), sequence);
        }
        return;
      }
      if (feedItem.kind === "turn") {
        const turn = feedItem.turn;
        addMessage(turn.sourceMessage, turn.sourceMessage.body, sequence);
        for (const item of channelTurnTimelineItems(
          turn,
          turn.sourceMessage.threadSurfaceKind === "topic"
            ? "topic"
            : turn.sourceMessage.threadSurfaceKind === "branch" || channelSurface === "channel_branch"
              ? "branch"
              : "channel_root",
          input.channelConversationItems,
          input.channelReasoningSummaries,
          input.channelContextCompactions ?? [],
          input.t,
          terminalReportById,
          workflowById,
          input.workflowProgressByWorkflowId,
          input.workflowErrors,
          input.orchestratingWorkflowId,
          composerGateApprovalPresentationForRunIds(
            turn.operationCell?.runIds ?? [],
            composerGateApprovalByRunId,
          )?.approvalId,
        )) {
          addItem(item, sequence);
          if ((item.kind === "userMessage" || item.kind === "agentMessage") && item.itemId) {
            const message = turn.coordinatorStartMessages
              .concat(turn.coordinatorTerminalMessages)
              .find((candidate) => candidate.id === item.itemId);
            if (message) messageByTimelineItemId.set(item.id, message);
          }
        }
        if (feedItem.pendingReplyPreview) {
          addItem(createConversationTimelineMessageItem({
            id: `message:agent:pending:${feedItem.pendingReplyPreview.id}`,
            role: "agent",
            markdown: input.t("Thinking..."),
            waitingPlaceholder: true,
            status: "running",
            threadSequence: 999_999,
            sourceRefs: [],
          }), sequence);
        }
        return;
      }

      const activity = feedItem.item;
      if (activity.kind === "message") {
        const message = activity.record;
        const pending = message.kind === "ai_reply" && message.status === "pending";
        const pendingBody = pending && !message.body.trim() ? input.t("Thinking...") : message.body;
        const proposedPlan = message.kind === "ai_reply" && message.authorType === "ai-teammate"
          ? readChannelProposedPlanMessage(pendingBody, message)
          : undefined;
        const visibleBody = proposedPlan?.displayBody ?? pendingBody;
        const displayBody = shouldHideStandaloneCoordinatorBody(message, visibleBody) ? "" : visibleBody;
        addMessage(message, displayBody, sequence);
        return;
      }
      if (activity.kind === "workflow") {
        const progressModel = input.workflowProgressByWorkflowId.get(activity.record.id);
        const workCell = progressModel ? input.conversationWorkCellByWorkflowId.get(activity.record.id) : undefined;
        const workCellItems = workCell && !input.auditActivityVisible
          ? conversationTimelineItemsForModel(
            workCell,
            composerGateApprovalPresentationForRunIds(
              progressModel?.runIds ?? workCell.runIds,
              composerGateApprovalByRunId,
            )?.approvalId,
          )
          : [];
        if (workCellItems.some(hasWorkflowTimelineContent)) {
          for (const item of workCellItems) addItem(item, sequence);
        } else {
          addItem(channelProtocolTimelineItem(activity, input.t, progressModel?.summary, {
            actionBusy: input.orchestratingWorkflowId === activity.record.id,
            actionFeedback: input.workflowErrors[activity.record.id],
          }), sequence);
        }
        return;
      }
      if (activity.kind === "run") {
        const run = activity.record;
        const workCell = run.threadId ? input.conversationWorkCellByThreadId.get(run.threadId) : undefined;
        if (workCell && workCell.anchorRunId === run.id && !input.auditActivityVisible) {
          for (const item of conversationTimelineItemsForModel(
            workCell,
            composerGateApprovalPresentationForRunId(run.id, composerGateApprovalByRunId)?.approvalId,
          )) addItem(item, sequence);
        } else {
          addItem(channelProtocolTimelineItem(activity, input.t), sequence);
        }
        return;
      }
      addItem(channelProtocolTimelineItem(
        activity,
        input.t,
        undefined,
        activity.kind === "handoff"
          ? { handoffWorkflowStarted: input.channelWorkflows.some((workflow) => workflow.sourceHandoffId === activity.record.id) }
          : activity.kind === "workflow-step"
            ? {
                actionBusy: input.runningWorkflowStepId === activity.record.id,
                actionFeedback: input.workflowErrors[activity.record.id],
              }
            : undefined,
      ), sequence);
    });

    timelineItems.sort((left, right) => left.threadSequence - right.threadSequence || left.partIndex - right.partIndex || left.id.localeCompare(right.id));
    const projectedTimelineItems = projectChannelUserInputTimeline({
      workspaceId: input.workspaceId, channelId: input.selectedChannelId,
      threadId: input.selectedChannelThreadId, surface: channelSurface === "channel_branch" ? "branch" : "channel_root",
      items: timelineItems, conversationItems: input.channelConversationItems, userInputs: input.channelUserInputs,
    });
    const snapshot = buildSurfaceTimelineSnapshot({
      surface: channelSurface,
      threadId: input.selectedChannelThreadId,
      items: projectedTimelineItems,
      runLifecycles: input.runLifecycles,
      canonicalRevision: projectedTimelineItems.reduce((max, item) => Math.max(max, item.revision), 0),
    });
    if (snapshot.items.length === 0) return null;
    return mountConversationTimeline({
      snapshot,
      depth: 0,
      cwd: input.cwd,
      onSubmitUserInputAnswer: (command) => submitUserInputAnswer(input.cwd, command),
      renderSubAgentAvatar: (item) => renderConversationParticipantAvatar(item.participantId, item.label),
      renderUserInputAvatar: (item) => {
        if (item.kind === "userInputAnswer") return <UserProfileAvatar profile={input.userProfile} fallbackLabel={input.localUserDisplayName} />;
        const teammate = input.allLocalTeammateById.get(item.participantId ?? "");
        return teammate ? <TeammateAvatarView teammate={teammate} cwd={input.cwd} compact /> : <AvatarInitial label="A" tone="teal" />;
      },
      onOpenSourceRef: handleOpenTimelineSourceRef,
      onOpenReview: input.onOpenReview,
      onInvokeProtocolAction: input.onInvokeProtocolAction,
      onDisclosureIntent: input.onTimelineDisclosureIntent,
      renderResponseActions: (response, copyText) => {
        const message = response.message?.itemId ? messageByTimelineItemId.get(`message:agent:${response.message.itemId}`) : undefined;
        return message ? renderChannelAiMessageActions(message, copyText) : undefined;
      },
      renderMessageChrome: (messageItem, body, presentation) => {
        const message = messageItem.itemId ? messageByTimelineItemId.get(`message:${messageItem.kind === "userMessage" ? "user" : "agent"}:${messageItem.itemId}`) : undefined;
        if (!message) return body;
        return renderMessageActivityItem(channelMessageToActivityItem(message), body, presentation.ownsIdentity);
      },
      itemLocatorRef: input.timelineItemLocatorRef,
      virtualScrollRef: input.timelineScrollRef,
      viewStateRetainKeys: input.timelineViewRetainKeys,
      ariaLabel: input.t("Channel conversation transcript"),
    }).node;
  }

  function renderChannelMessageAssets(
    attachmentIds: readonly string[],
    fileRefs: readonly ChannelMessageFileRef[] = [],
    linkPreviewIds: readonly string[] = [],
    channelId: string = input.selectedChannelId,
  ): ReactNode {
    const attachments = attachmentIds
      .map((id) => input.channelAttachmentById.get(id))
      .filter((attachment): attachment is ChannelAttachment => Boolean(attachment));
    const linkPreviews = linkPreviewIds
      .map((id) => input.channelLinkPreviewById.get(id))
      .filter((preview): preview is ChannelLinkPreview => preview?.status === "ready");
    if (attachments.length === 0 && fileRefs.length === 0 && linkPreviews.length === 0) {
      return null;
    }
    return (
      <>
        <ConversationAttachmentStrip
          loadPreview={input.loadPreview}
          attachments={attachments.map((attachment) => ({
            id: attachment.id,
            label: attachment.fileName,
            meta: input.formatBytes(attachment.sizeBytes),
            href: input.attachmentContentUrl(attachment),
            target: "_blank",
            rel: "noreferrer",
            icon: attachment.kind === "image" ? <ImageIcon size={13} /> : <FileText size={13} />,
            previewRequest: attachmentCanPreview(attachment) ? {
              source: "attachment",
              cwd: input.cwd,
              attachmentId: attachment.id,
              scope: "channel",
              channelId,
            } : undefined,
          }))}
        />
        <ConversationReferenceStrip
          ariaLabel={input.t("References")}
          references={[
            ...fileRefs.map((fileRef, index) => ({
              id: `file:${fileRef.path}:${fileRef.line ?? ""}:${index}`,
              kind: "workspace_file" as const,
              label: fileRef.label ?? fileNameFromReferencePath(fileRef.path),
              meta: fileRef.line !== undefined ? `${fileRef.path}:${fileRef.line}` : fileRef.path,
              previewTitle: fileRef.label ?? fileNameFromReferencePath(fileRef.path),
              previewText: fileRef.path,
              onOpen: input.onOpenFileReference,
            })),
            ...linkPreviews.map((preview) => ({
              id: `web:${preview.id}`,
              kind: "web" as const,
              label: preview.title ?? preview.siteName ?? webReferenceHost(preview.normalizedUrl || preview.url),
              meta: preview.siteName ?? webReferenceHost(preview.normalizedUrl || preview.url),
              href: preview.normalizedUrl || preview.url,
              previewTitle: preview.title,
              previewText: preview.description,
            })),
          ]}
        />
      </>
    );
  }

  return { renderUnifiedTimeline };
}

// Content selection lives in workflow-timeline-content; completion remains Host-owned.

function generatedMediaForMessage(
  items: readonly ConversationGeneratedMedia[],
  message: ChannelMessage,
): readonly ConversationGeneratedMedia[] {
  return items.filter((item) => item.messageId
    ? item.messageId === message.id
    : Boolean(message.linkedRunId && item.runId === message.linkedRunId));
}

function fileNameFromReferencePath(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

function webReferenceHost(value: string): string {
  try {
    return new URL(value).hostname.replace(/^www\./iu, "");
  } catch {
    return value;
  }
}

export const LING_AGENT_AUTHOR_ID = "ling_agent";
const LING_AGENT_AUTHOR_LABEL = "Ling Agent";

function normalizeAgentLabel(value: string): string {
  return value.trim().toLowerCase().replace(/^ling\s+/u, "");
}

export function messageAuthorLabel(
  message: ChannelMessage,
  teammates: readonly ChannelMention[],
  deletedTeammateLabel = "Deleted teammate",
  localUserLabel = "You",
  teammateById?: ReadonlyMap<string, { readonly displayName: string }>,
): string {
  if (message.authorType === "system") {
    return "Ling Stack";
  }
  if (message.authorType === "ai-teammate") {
    if (message.authorId === LING_AGENT_AUTHOR_ID) {
      return teammateLabel(message.authorId, teammates, LING_AGENT_AUTHOR_LABEL, teammateById);
    }
    return teammateLabel(message.authorId, teammates, deletedTeammateLabel, teammateById);
  }
  return localUserLabel;
}

export function teammateLabel(
  teammateId: string | undefined,
  teammates: readonly ChannelMention[],
  fallback = "AI teammate",
  teammateById?: ReadonlyMap<string, { readonly displayName: string }>,
): string {
  if (!teammateId) {
    return fallback;
  }
  const teammate = teammateById?.get(teammateId);
  if (teammate) {
    return teammate.displayName;
  }
  return teammates.find((teammate) => teammate.id === teammateId)?.label ?? fallback;
}

function conversationTurnAssistantCopyText(
  turn: ConversationTurnViewModel,
  t: (key: string, values?: Record<string, string | number>) => string,
): string {
  return turn.blocks
    .flatMap((block) => {
      if (block.kind === "coordinator_message") {
        const body = conversationCoordinatorDisplayBody(turn, block.message, block.phase, t).trim();
        return body ? [body] : [];
      }
      if (block.kind === "operation") {
        return [block.operationCell.title];
      }
      return block.display.map((line) => line.text);
    })
    .join("\n\n")
    .trim();
}

function conversationCoordinatorDisplayBody(
  turn: ConversationTurnViewModel,
  message: ChannelMessage,
  phase: "start" | "terminal",
  t: (key: string, values?: Record<string, string | number>) => string,
): string {
  if (message.status === "pending" && !message.body.trim()) {
    return t("Thinking...");
  }
  if (isGeneratedWorkflowCoordinatorBody(message.body) && !turn.operationCell) {
    return "";
  }
  if (!turn.operationCell || !shouldSanitizeGeneratedCoordinatorBody(message.body)) {
    return message.body;
  }
  if (isGeneratedWorkflowCoordinatorBody(message.body)) {
    const fallback = phase === "terminal"
      ? conversationCoordinatorTerminalFallback(turn, t)
      : conversationCoordinatorStartFallback(turn);
    return isDuplicateCoordinatorDisplayBody(turn, fallback) ? "" : fallback;
  }
  const cleaned = cleanGeneratedWorkflowText(message.body);
  if (cleaned) {
    return isDuplicateCoordinatorDisplayBody(turn, cleaned) ? "" : cleaned;
  }
  const fallback = phase === "terminal"
    ? conversationCoordinatorTerminalFallback(turn, t)
    : conversationCoordinatorStartFallback(turn);
  return isDuplicateCoordinatorDisplayBody(turn, fallback) ? "" : fallback;
}

function shouldSanitizeGeneratedCoordinatorBody(body: string): boolean {
  const text = trimGeneratedWorkflowDecoration(body);
  if (!text) {
    return false;
  }
  if (/^(确认需求|完成|已完成)\s*[:：]/u.test(text) || /^(Confirm requirement|Completed)\s*:/iu.test(text)) {
    return true;
  }
  if (/Smoke ID\s*:/iu.test(text) || /开始\s*workflow\s*[:：]/iu.test(text)) {
    return true;
  }
  if (/(Confirmed proposal|Overall scope|Assigned teammate|Step action|Acceptance criteria)\s*:/u.test(text)) {
    return true;
  }
  if (generatedWorkflowBodyPrefix.test(text)) {
    return true;
  }
  return false;
}

function isGeneratedWorkflowCoordinatorBody(body: string): boolean {
  const text = trimGeneratedWorkflowDecoration(body);
  return /Smoke ID\s*:/iu.test(text) ||
    /开始\s*workflow\s*[:：]/iu.test(text) ||
    generatedWorkflowBodyPrefix.test(text) ||
    /^(Done|Stopped|Not completed):\s*"/iu.test(text) ||
    /^(完成|已停止|未完成)\s*[:：]/u.test(text);
}

const generatedWorkflowBodyPrefix = /^(?:这条用户消息(?:看起来是|是一个)|The user message (?:looks like|is a))/iu;

function shouldHideStandaloneCoordinatorBody(message: ChannelMessage, body: string): boolean {
  return message.kind === "ai_reply" &&
    message.authorType === "ai-teammate" &&
    message.authorId === LING_AGENT_AUTHOR_ID &&
    isGeneratedWorkflowCoordinatorBody(body);
}

function trimGeneratedWorkflowDecoration(value: string): string {
  return value.trim().replace(/^(?:[*_`>#-]+\s*)+/u, "");
}

function conversationCoordinatorStartFallback(turn: ConversationTurnViewModel): string {
  return ensureSentenceEnding(conversationTurnTaskText(turn));
}

function conversationCoordinatorTerminalFallback(
  turn: ConversationTurnViewModel,
  t: (key: string, values?: Record<string, string | number>) => string,
): string {
  const operationCell = turn.operationCell;
  const result = conversationTurnResultText(turn);
  const agents = conversationTurnAgentLabels(turn);
  const teammateSuffix = agents.length > 0
    ? ` ${t("Teammates: {agents}.", { agents: formatAgentLabelList(agents) })}`
    : "";
  if (operationCell?.status === "blocked") {
    return t("Blocked: {reason}.", { reason: result });
  }
  if (operationCell?.status === "failed") {
    return t("Failed: {summary}.", { summary: result });
  }
  if (operationCell?.status === "cancelled" || operationCell?.status === "superseded") {
    return t("Cancelled: {summary}.", { summary: result });
  }
  return `${ensureSentenceEnding(result)}${teammateSuffix ? ` ${teammateSuffix}` : ""}`.trim();
}

function conversationTurnTaskText(turn: ConversationTurnViewModel): string {
  return cleanGeneratedWorkflowText(turn.operationCell?.title) ??
    cleanGeneratedWorkflowText(turn.operationCell?.summary) ??
    cleanGeneratedWorkflowText(turn.sourceMessage.body) ??
    "current task";
}

function conversationTurnResultText(turn: ConversationTurnViewModel): string {
  return cleanGeneratedWorkflowText(turn.operationCell?.summary) ??
    cleanGeneratedWorkflowText(turn.operationCell?.title) ??
    cleanGeneratedWorkflowText(turn.sourceMessage.body) ??
    "current task";
}

function conversationTurnAgentLabels(turn: ConversationTurnViewModel): readonly string[] {
  return uniqueStrings(
    (turn.operationCell?.agentSpans ?? [])
      .filter((span) => span.kind !== "overflow")
      .map((span) => span.label.trim())
      .filter(Boolean),
  );
}

function proposalShouldHideInDefaultFeed(proposal: ChannelExecutionProposal, workflows: readonly ChannelWorkflow[]): boolean {
  if (proposal.status === "accepted" && proposal.linkedWorkflowId) {
    return true;
  }
  return proposalHasTerminalWorkflow(proposal, workflows);
}

function proposalHasTerminalWorkflow(proposal: ChannelExecutionProposal, workflows: readonly ChannelWorkflow[]): boolean {
  if (!proposal.linkedWorkflowId) {
    return false;
  }
  const workflow = workflows.find((candidate) => candidate.id === proposal.linkedWorkflowId);
  return Boolean(workflow && workflowIsTerminal(workflow.status));
}

function workflowIsTerminal(status: ChannelWorkflow["status"]): boolean {
  return status === "succeeded" || status === "blocked" || status === "failed" || status === "cancelled";
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function formatAgentLabelList(labels: readonly string[]): string {
  return labels.join("、");
}

function ensureSentenceEnding(value: string): string {
  const text = value.trim();
  if (!text) {
    return "";
  }
  return /[。.!?！？]$/u.test(text) ? text : /[\u3400-\u9fff]/u.test(text) ? `${text}。` : `${text}.`;
}

function isDuplicateCoordinatorDisplayBody(turn: ConversationTurnViewModel, value: string): boolean {
  const normalizedValue = normalizeCoordinatorDisplayComparison(value);
  if (!normalizedValue) {
    return true;
  }
  const operationCell = turn.operationCell;
  const candidates = [
    turn.sourceMessage.body,
    operationCell?.title,
    operationCell?.summary,
    ...(operationCell?.operationRows ?? []).map((row) => row.title),
  ];
  return candidates.some((candidate) => normalizeCoordinatorDisplayComparison(candidate) === normalizedValue);
}

function normalizeCoordinatorDisplayComparison(value: string | undefined): string {
  const cleaned = stripGeneratedWorkflowNoise(value)
    .toLowerCase()
    .replace(/[。.!?！？]+$/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  return cleaned;
}

function cleanGeneratedWorkflowText(value: string | undefined): string | undefined {
  const cleaned = stripGeneratedWorkflowNoise(value);
  if (!cleaned) {
    return undefined;
  }
  return truncatePreview(cleaned, 120);
}

function stripGeneratedWorkflowNoise(value: string | undefined): string {
  if (!value) {
    return "";
  }
  let text = value.trim();
  text = text
    .replace(/^确认需求\s*[:：]\s*/u, "")
    .replace(/^(完成|已完成)\s*[:：]\s*/u, "")
    .replace(/^Confirm requirement\s*:\s*/iu, "")
    .replace(/^Completed\s*:\s*/iu, "")
    .replace(/^["“「']+|["”」']+$/gu, "")
    .replace(/^[“「"]?开始\s*workflow\s*[:：]\s*/iu, "")
    .replace(/^\s*workflow\s*[:：]\s*/iu, "")
    .replace(/\s*Smoke ID\s*:\s*[\w.-]+[。.]?/giu, "")
    .replace(/\s*开始处理[。.]?$/u, "")
    .replace(/[」”"]+[。.]?$/u, "")
    .replace(/\s+/gu, " ")
    .trim();
  text = text.replace(/[。.]$/u, "").trim();
  return text;
}
