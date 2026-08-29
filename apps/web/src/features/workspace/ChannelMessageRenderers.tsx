import type { ReactNode } from "react";
import { projectConversationMessagePresentation } from "@ling-stack/conversation-ui-core";
import {
  CheckCircle2,
  ChevronUp,
  CircleAlert,
  Copy,
  FileCheck2,
  FileText,
  History,
  Image as ImageIcon,
  Loader2,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Reply,
  Square,
  SquareTerminal,
  ThumbsDown,
  ThumbsUp,
  Workflow,
} from "lucide-react";
import { effectiveApprovalStatus } from "../../lib/approvals.js";
import type { ChannelActivityItem } from "../../lib/channel-activity.js";
import { artifactStripItemOwnedByTypedFact, conversationWorkCellFactOwnership, normalizeConversationWorkCellPath, type ConversationAgentActivitySpan, type ConversationWorkCellViewModel } from "../../lib/conversation-work-cell.js";
import type { ConversationTranscriptBlock, ConversationTurnViewModel } from "../../lib/conversation-turn-projector.js";
import { truncatePreview } from "../../lib/data.js";
import { formatDateTime } from "../../lib/formatting.js";
import type { InlineApprovalView } from "../../lib/inline-approvals.js";
import { attachmentCanPreview, type PreviewRequest } from "../../lib/previews.js";
import {
  buildComposerGateApprovalPresentationByRunId,
  composerGateApprovalPresentationForWorkCell,
} from "../../lib/runtime-approval-presentation.js";
import { filterUsedMemoryEventsByResponse } from "../../shared/components/index.js";
import {
  AvatarInitial,
  UsedMemorySummary,
  UsedMemorySummaryLabel,
  UserProfileAvatar,
} from "../../shared/components/index.js";
import {
  ConversationArtifactStripPanel,
  ConversationAttachmentStrip,
  ConversationGeneratedMediaBlock,
  ConversationReferenceStrip,
  ConversationReplacementRetry,
  ConversationWorkCell,
  InlineMessageEditor,
  MessageActionBar,
  MessageBodyRenderer,
  MessageBubble,
  MessageEvidencePanel,
  MessageRow,
  TerminalReportBlock,
  TranscriptBlockView,
  createTranscriptBlockRendererRegistry,
  renderTranscriptBlockFromRegistry,
  type ConversationWorkCellDetailsState,
  type ConversationWorkspaceReviewTarget,
  type TerminalReportFileTarget,
} from "../../shared/conversation/index.js";
import { InlineFeedback, Tooltip } from "../../shared/ui/index.js";
import type {
  ApprovalRequest,
  Channel,
  ChannelAttachment,
  ChannelContextSummary,
  ChannelDecision,
  ChannelExecutionProposal,
  ChannelHandoff,
  ChannelHandoffStatus,
  ChannelLinkPreview,
  ChannelMention,
  ChannelMessage,
  ChannelMessageFileRef,
  ConversationGeneratedMedia,
  ChannelWorkflow,
  ChannelWorkflowStep,
  MemoryObject,
  RunArtifact,
  RunSession,
  ProposedPlanArtifact,
  PreviewContentResponse,
  StateTransitionEvent,
  UsedMemoryEvent,
  UserProfile,
} from "../../types.js";
import type { LocalTeammateDraft } from "../teammates/index.js";
import { TeammateAvatarView } from "../teammates/TeammateAvatarView.js";
import {
  WorkflowFinalSummary,
  workflowCanAdvance,
  workflowCanCancel,
} from "./ChannelWorkflowProposalCards.js";
import { ChannelExecutionProposalSummary } from "./ChannelExecutionProposalPresentation.js";
import type { ChannelMessageFeedItem, PendingChannelSendPreview } from "./ChannelMessageFeed.js";
import { ChannelProposedPlanBlock } from "./ChannelProposedPlanBlock.js";
import { readChannelProposedPlanMessage } from "./channel-proposed-plan-message.js";

type FeedbackValue = "up" | "down";

interface WorkspaceTranscriptRenderContext {
  readonly detailsState: ConversationWorkCellDetailsState;
  readonly onLoadDetails?: (id: string) => void;
}

export interface ChannelMessageRenderersInput {
  readonly activeRunId: string;
  readonly allLocalTeammateById: ReadonlyMap<string, LocalTeammateDraft>;
  readonly allLocalTeammateByName: ReadonlyMap<string, LocalTeammateDraft>;
  readonly approvals: readonly ApprovalRequest[];
  readonly attachmentContentUrl: (attachment: ChannelAttachment) => string;
  readonly auditActivityVisible: boolean;
  readonly channelArtifactsByRun: Readonly<Record<string, readonly RunArtifact[]>>;
  readonly generatedMedia: readonly ConversationGeneratedMedia[];
  readonly channelAttachmentById: ReadonlyMap<string, ChannelAttachment>;
  readonly channelLinkPreviewById: ReadonlyMap<string, ChannelLinkPreview>;
  readonly channelMessageFeedbackById: Readonly<Record<string, FeedbackValue>>;
  readonly channelMessagesLoadingOlder: boolean;
  readonly channelWorkflowSteps: readonly ChannelWorkflowStep[];
  readonly channelWorkflows: readonly ChannelWorkflow[];
  readonly conversationWorkCellByThreadId: ReadonlyMap<string, ConversationWorkCellViewModel>;
  readonly conversationWorkCellByWorkflowId: ReadonlyMap<string, ConversationWorkCellViewModel>;
  readonly conversationWorkCellDetailsByKey: Readonly<Record<string, ConversationWorkCellDetailsState>>;
  readonly composerGateApprovals: readonly InlineApprovalView[];
  readonly cwd: string;
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
  readonly orchestratingWorkflowId: string;
  readonly runningWorkflowStepId: string;
  readonly runById: ReadonlyMap<string, RunSession>;
  readonly selectedChannelBranchRootThreadId: string | undefined;
  readonly selectedChannelId: string;
  readonly teammateOptions: readonly ChannelMention[];
  readonly t: (key: string, values?: Record<string, string | number>) => string;
  readonly usedMemoryEvents: readonly UsedMemoryEvent[];
  readonly userProfile?: UserProfile;
  readonly workflowProgressByWorkflowId: ReadonlyMap<string, unknown>;
  readonly activityActionRow: (activityItemId: string, children?: ReactNode) => React.JSX.Element;
  readonly conversationWorkCellDetailsCacheKey: (threadId: string) => string;
  readonly onCancelWorkflow: (workflow: ChannelWorkflow) => void;
  readonly onCreateTaskFromContextSummary: (summary: ChannelContextSummary) => void;
  readonly onAcceptProposedPlan: (plan: ProposedPlanArtifact) => void;
  readonly onConvertProposedPlan: (plan: ProposedPlanArtifact) => void;
  readonly onLoadConversationWorkCellDetails: (threadId: string) => void;
  readonly onLoadWorkflowWorkCellDetails: (workflowIdOrThreadId: string, options?: { readonly force?: boolean }) => void;
  readonly onOpenApprovalDetail: (approval: ApprovalRequest | undefined) => void;
  readonly onOpenContextSummaryInConversationDetail: (summary: ChannelContextSummary) => void;
  readonly onOpenRun: (runId: string) => void;
  readonly onOpenExecutionProposal: (proposal: ChannelExecutionProposal) => void;
  readonly onOpenFileReference: () => void;
  readonly onOpenTerminalReportFile: (target: TerminalReportFileTarget) => void;
  readonly onOpenWorkspaceReview: (target: ConversationWorkspaceReviewTarget) => void;
  readonly onOpenThreadForMessage: (message: ChannelMessage) => void;
  readonly onOrchestrateWorkflow: (workflow: ChannelWorkflow) => void;
  readonly onRejectDecision: (decision: ChannelDecision) => void;
  readonly onRefineProposedPlan: (plan: ProposedPlanArtifact) => void;
  readonly onSaveProposedPlan: (plan: ProposedPlanArtifact) => void;
  readonly onRetryWorkflowStep: (step: ChannelWorkflowStep) => void;
  readonly onRevealReviewInConversation: () => void;
  readonly onRevealRunFromActivity: (runId: string) => void;
  readonly onRevealTaskFromActivity: (taskId: string) => void;
  readonly onStartWorkflowFromHandoff: (handoff: ChannelHandoff) => void;
  readonly onSupersedeDecision: (decision: ChannelDecision) => void;
  readonly onToggleChannelMessageFeedback: (messageId: string, feedback: FeedbackValue) => void;
  readonly onBeginMessageEdit: (messageId: string) => void;
  readonly onCancelMessageEdit: () => void;
  readonly onSaveMessageEdit: (message: ChannelMessage, body: string) => void | Promise<void>;
  readonly onRetryMessageReplacement: (message: ChannelMessage) => void | Promise<void>;
  readonly onUpdateHandoffStatus: (handoff: ChannelHandoff, status: ChannelHandoffStatus) => void;
  readonly readRunTitle: (run: RunSession) => string;
  readonly planActionBusyId: string;
  readonly proposedPlanArtifactsById: ReadonlyMap<string, ProposedPlanArtifact>;
  readonly workflowWorkCellDetailsCacheKey: (workflowId: string) => string;
}

export interface ChannelMessageRenderers {
  readonly renderMessageFeedItem: (feedItem: ChannelMessageFeedItem | undefined) => ReactNode;
}

export function createChannelMessageRenderers(input: ChannelMessageRenderersInput): ChannelMessageRenderers {
  const channelSurface = input.selectedChannelBranchRootThreadId ? "channel_branch" : "channel_root";
  const composerGateApprovalByRunId = buildComposerGateApprovalPresentationByRunId(input.composerGateApprovals, input.t);
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

  function renderConversationAgentAvatar(span: ConversationAgentActivitySpan): ReactNode {
    return renderConversationParticipantAvatar(span.participantId, span.label);
  }

  const conversationTranscriptBlockRenderers = createTranscriptBlockRendererRegistry<
    ConversationTurnViewModel,
    ConversationTranscriptBlock,
    WorkspaceTranscriptRenderContext
  >({
    coordinator_message: renderCoordinatorMessageTranscriptBlock,
    conversation_item: renderConversationItemTranscriptBlock,
    operation: renderOperationTranscriptBlock,
    agent_activity: renderGenericTranscriptBlock,
    approval: renderGenericTranscriptBlock,
    artifact_strip: renderGenericTranscriptBlock,
    source_summary: renderGenericTranscriptBlock,
    requirement_shaping: renderGenericTranscriptBlock,
    decision_needed: renderGenericTranscriptBlock,
    final_result: renderFinalResultTranscriptBlock,
    raw_debug_ref: renderGenericTranscriptBlock,
  });

  function renderConversationTurnItem(turn: ConversationTurnViewModel, pendingReplyPreview?: PendingChannelSendPreview): ReactNode {
    const operationCell = turn.operationCell;
    const operationRef = turn.operationRef;
    let detailsState: ConversationWorkCellDetailsState = { status: "not_loaded" };
    let onLoadDetails: ((id: string) => void) | undefined;
    if (operationCell && operationRef?.kind === "workflow") {
      detailsState = input.conversationWorkCellDetailsByKey[input.workflowWorkCellDetailsCacheKey(operationRef.workflowId)] ?? { status: "not_loaded" };
      onLoadDetails = input.onLoadWorkflowWorkCellDetails;
    } else if (operationCell && operationRef?.kind === "run_thread") {
      detailsState = input.conversationWorkCellDetailsByKey[input.conversationWorkCellDetailsCacheKey(operationRef.threadId)] ?? { status: "not_loaded" };
      onLoadDetails = input.onLoadConversationWorkCellDetails;
    }

    return (
      <div className="conversation-turn" data-conversation-turn-id={turn.id}>
        {renderMessageFeedActivityItem(channelMessageToActivityItem(turn.sourceMessage))}
        {renderConversationTurnAssistantTranscript(turn, detailsState, onLoadDetails)}
        {pendingReplyPreview ? renderPendingChannelReplyStatus() : null}
      </div>
    );
  }

  function renderConversationTurnAssistantTranscript(
    turn: ConversationTurnViewModel,
    detailsState: ConversationWorkCellDetailsState,
    onLoadDetails: ((id: string) => void) | undefined,
  ): ReactNode {
    if (turn.blocks.length === 0) {
      return null;
    }

    const anchorMessage = turn.blocks.find((block) => block.kind === "coordinator_message")?.message;
    const authorName = anchorMessage
      ? messageAuthorLabel(anchorMessage, input.teammateOptions, input.t("Deleted teammate"), input.localUserDisplayName, input.allLocalTeammateById)
      : input.t("Ling Agent");
    const createdAt = anchorMessage?.createdAt ?? turn.createdAt;
    const copyText = conversationTurnAssistantCopyText(turn, input.t);
    const transcriptContext: WorkspaceTranscriptRenderContext = { detailsState, onLoadDetails };
    const terminalSummaryRendered = conversationTurnHasTerminalSummary(turn);
    const terminalReportOwnsChanges = Boolean(
      turn.operationCell?.terminalReportRows.some((row) => row.reportSection === "change"),
    );
    const terminalReportChangedPaths = new Set(
      (turn.operationCell?.terminalReportRows ?? []).flatMap((row) =>
        row.reportSection === "change"
          ? (row.detailLines ?? []).flatMap((line) => line.kind === "file_ref" ? [line.path] : [])
          : []),
    );
    const typedFactOwnership = turn.operationCell
      ? conversationWorkCellFactOwnership(turn.operationCell)
      : { artifactIds: new Set<string>(), filePaths: new Set<string>() };
    const reportChangedPaths = new Set([...terminalReportChangedPaths].map(normalizeConversationWorkCellPath));
    const externalArtifactItems = terminalSummaryRendered
      ? (turn.operationCell?.artifactStripItems ?? []).filter((item) => {
        if (artifactStripItemOwnedByTypedFact(item, typedFactOwnership)) {
          return false;
        }
        if (item.kind === "changed") {
          return !terminalReportOwnsChanges && ![...(item.changeArtifacts ?? [])]
            .map((artifact) => artifact.path)
            .filter((path): path is string => Boolean(path))
            .map(normalizeConversationWorkCellPath)
            .some((path) => reportChangedPaths.has(path));
        }
        if (item.kind === "artifact" && terminalReportOwnsChanges) {
          const path = item.workspaceFilePath ?? item.path;
          if (path && reportChangedPaths.has(normalizeConversationWorkCellPath(path))) {
            return false;
          }
        }
        return true;
      })
      : [];
    const hasExternalArtifactContent = externalArtifactItems.some((item) =>
      item.kind === "artifact" || item.kind === "changed",
    );
    const externalArtifactCwd = turn.operationCell
      ? input.runById.get(turn.operationCell.anchorRunId)?.cwd ?? input.cwd
      : input.cwd;
    const generatedMedia = anchorMessage ? generatedMediaForMessage(input.generatedMedia, anchorMessage) : [];

    return (
      <MessageRow
        surface={channelSurface}
        className="channel-message-row conversation-turn-assistant-row"
        authorType="ai-teammate"
        avatar={anchorMessage ? renderChannelMessageAvatar(anchorMessage) : renderLingAgentAvatar()}
        authorName={authorName}
        createdAtLabel={formatDateTime(createdAt)}
        bodyNode={(
          <div className="conversation-turn-assistant-transcript">
            {turn.blocks.map((block) => renderTranscriptBlockFromRegistry(conversationTranscriptBlockRenderers, {
              turn,
              block,
              context: transcriptContext,
            }))}
            {hasExternalArtifactContent ? (
              <div className="conversation-turn-artifacts">
                <ConversationArtifactStripPanel
                  items={externalArtifactItems}
                  cwd={externalArtifactCwd}
                  recoveryTarget={externalArtifactItems.find((item) => item.kind === "changed")?.recoveryTarget}
                  loadPreview={input.loadPreview}
                  onOpenWorkspaceReview={input.onOpenWorkspaceReview}
                />
              </div>
            ) : null}
            <ConversationGeneratedMediaBlock items={generatedMedia} cwd={input.cwd} />
            {renderChannelAiMessageActions(turn.sourceMessage, copyText)}
          </div>
        )}
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

  function renderCoordinatorMessageTranscriptBlock({
    turn,
    block,
  }: {
    readonly turn: ConversationTurnViewModel;
    readonly block: Extract<ConversationTranscriptBlock, { readonly kind: "coordinator_message" }>;
    readonly context: WorkspaceTranscriptRenderContext;
  }): ReactNode {
    const pendingCoordinatorMessage = block.message.status === "pending";
    const body = conversationCoordinatorDisplayBody(turn, block.message, block.phase, input.t).trim();
    const proposedPlanBlock = readChannelProposedPlanMessage(body, block.message);
    const proposedPlan = proposedPlanBlock
      ? input.proposedPlanArtifactsById.get(proposedPlanBlock.plan.id) ?? proposedPlanBlock.plan
      : undefined;
    const visibleBody = proposedPlanBlock?.displayBody.trim() ?? body;
    const evidenceNode = (block.memoryCitationEvents.length > 0 || block.message.webEvidence) ? (
      <MessageEvidencePanel
        memoryContent={block.memoryCitationEvents.length > 0 ? (
          <UsedMemorySummary
            variant="inline"
            events={block.memoryCitationEvents}
            memoryById={input.memoryById}
          />
        ) : undefined}
        memorySummary={block.memoryCitationEvents.length > 0 ? <UsedMemorySummaryLabel events={block.memoryCitationEvents} /> : undefined}
        webEvidence={block.message.webEvidence}
      />
    ) : null;
    if (!visibleBody && !proposedPlanBlock) {
      return evidenceNode ? <div className="conversation-turn-assistant-copy" key={block.id}>{evidenceNode}</div> : null;
    }
    return (
      <div
        className={[
          block.phase === "terminal" ? "conversation-turn-assistant-copy terminal" : "conversation-turn-assistant-copy",
          pendingCoordinatorMessage ? "message-body-with-spinner" : "",
        ].filter(Boolean).join(" ")}
        key={block.id}
      >
        {pendingCoordinatorMessage ? <Loader2 className="message-pending-spinner spin" size={13} /> : null}
        {visibleBody ? <MessageBodyRenderer text={visibleBody} cwd={input.cwd} compact streaming={pendingCoordinatorMessage} onOpenLocalFile={input.onOpenFileReference} /> : null}
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
        {evidenceNode}
      </div>
    );
  }

  function renderOperationTranscriptBlock({
    turn,
    block,
    context,
  }: {
    readonly turn: ConversationTurnViewModel;
    readonly block: Extract<ConversationTranscriptBlock, { readonly kind: "operation" }>;
    readonly context: WorkspaceTranscriptRenderContext;
  }): ReactNode {
    const operationCwd = input.runById.get(block.operationCell.anchorRunId)?.cwd ?? input.cwd;
    return (
      <div className="conversation-turn-operation" key={block.id}>
        <ConversationWorkCell
          model={block.operationCell}
          surface={channelSurface}
          composerGateApproval={composerGateApprovalPresentationForWorkCell(block.operationCell, composerGateApprovalByRunId)}
          cwd={operationCwd}
          detailsState={context.detailsState}
          onOpenRun={block.operationCell.anchorRunId.startsWith("workflow:") ? undefined : input.onOpenRun}
          onLoadDetails={context.onLoadDetails}
          loadPreview={input.loadPreview}
          renderAgentAvatar={renderConversationAgentAvatar}
          renderParticipantAvatar={renderConversationParticipantAvatar}
          showArtifactStrip={!conversationTurnHasTerminalSummary(turn)}
          showTerminalReport={!turn.blocks.some((item) => item.kind === "final_result")}
          suppressTerminalReport={turn.blocks.some((item) => item.kind === "coordinator_message" && item.phase === "terminal")}
          onOpenWorkspaceFile={input.onOpenTerminalReportFile}
          onOpenWorkspaceReview={input.onOpenWorkspaceReview}
        />
      </div>
    );
  }

  function renderConversationItemTranscriptBlock({
    block,
  }: {
    readonly turn: ConversationTurnViewModel;
    readonly block: Extract<ConversationTranscriptBlock, { readonly kind: "conversation_item" }>;
    readonly context: WorkspaceTranscriptRenderContext;
  }): ReactNode {
    return (
      <div className="conversation-turn-structured-item" key={block.id} data-conversation-item-kind={block.item.kind}>
        <TranscriptBlockView block={block} cwd={input.cwd} />
      </div>
    );
  }

  function renderFinalResultTranscriptBlock({
    block,
  }: {
    readonly turn: ConversationTurnViewModel;
    readonly block: Extract<ConversationTranscriptBlock, { readonly kind: "final_result" }>;
    readonly context: WorkspaceTranscriptRenderContext;
  }): ReactNode {
    return (
      <TerminalReportBlock
        key={block.id}
        blockId={block.terminalReportId}
        rows={block.rows}
        renderParticipantAvatar={renderConversationParticipantAvatar}
        surface={channelSurface}
        cwd={input.cwd}
        onOpenWorkspaceFile={input.onOpenTerminalReportFile}
      />
    );
  }

  function renderGenericTranscriptBlock({
    block,
  }: {
    readonly turn: ConversationTurnViewModel;
    readonly block: Exclude<ConversationTranscriptBlock, { readonly kind: "coordinator_message" | "operation" }>;
    readonly context: WorkspaceTranscriptRenderContext;
  }): ReactNode {
    return (
      <TranscriptBlockView
        key={block.id}
        block={block}
        cwd={input.cwd}
      />
    );
  }

  function channelMessageToActivityItem(message: ChannelMessage): ChannelActivityItem {
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

  function renderMessageFeedActivityItem(item: ChannelActivityItem): ReactNode {
    if (item.kind === "message") {
      return renderMessageActivityItem(item);
    }
    if (item.kind === "decision") {
      const decision = item.record;
      return (
        <MessageBubble
          tone="protocol"
          avatar={<AvatarInitial label="D" tone="violet" />}
          author={input.t("Decision log")}
          tag={decision.status}
          time={formatDateTime(decision.createdAt)}
          body={`${decision.title}: ${decision.decision}`}
          action={
            input.activityActionRow(item.id, <>
              <button className="secondary-button compact-button" type="button" onClick={() => input.onSupersedeDecision(decision)}>
                <FileCheck2 size={14} />
                {input.t("Supersede")}
              </button>
              <button className="secondary-button compact-button" type="button" onClick={() => input.onRejectDecision(decision)}>
                <CircleAlert size={14} />
                {input.t("Reject")}
              </button>
              <button className="secondary-button compact-button" type="button" onClick={input.onRevealReviewInConversation}>
                <CheckCircle2 size={14} />
                {input.t("Review source")}
              </button>
            </>)
          }
        />
      );
    }
    if (item.kind === "handoff") {
      const handoff = item.record;
      const handoffWorkflow = input.channelWorkflows.find((workflow) => workflow.sourceHandoffId === handoff.id);
      return (
        <MessageBubble
          tone="protocol"
          avatar={<AvatarInitial label="H" tone="teal" />}
          author={input.t("Handoff")}
          tag={handoff.status}
          time={formatDateTime(handoff.createdAt)}
          body={`${handoff.fromParticipantLabel} -> ${handoff.toParticipantLabel}: ${handoff.reason}`}
          action={
            input.activityActionRow(item.id, <>
              <button className="secondary-button compact-button" type="button" onClick={() => input.onStartWorkflowFromHandoff(handoff)} disabled={Boolean(handoffWorkflow)}>
                <Play size={14} />
                {handoffWorkflow ? input.t("Workflow started") : input.t("Start workflow")}
              </button>
              <button className="secondary-button compact-button" type="button" onClick={() => input.onUpdateHandoffStatus(handoff, "accepted")}>
                {input.t("Accept")}
              </button>
              <button className="secondary-button compact-button" type="button" onClick={() => input.onUpdateHandoffStatus(handoff, "completed")}>
                {input.t("Complete")}
              </button>
              <button className="secondary-button compact-button" type="button" onClick={input.onRevealReviewInConversation}>
                <CheckCircle2 size={14} />
                {input.t("Review source")}
              </button>
            </>)
          }
        />
      );
    }
    if (item.kind === "workflow") {
      return renderWorkflowActivityItem(item);
    }
    if (item.kind === "workflow-step") {
      return renderWorkflowStepActivityItem(item);
    }
    if (item.kind === "task") {
      const task = item.record;
      return (
        <MessageBubble
          tone="work"
          avatar={<AvatarInitial label="T" tone="orange" />}
          author={input.t("Task event")}
          tag={task.status}
          time={formatDateTime(task.updatedAt)}
          body={input.t("Task {title} is {status}.", { title: task.title, status: task.status })}
          action={
            input.activityActionRow(item.id, (
              <button className="secondary-button compact-button" type="button" onClick={() => input.onRevealTaskFromActivity(task.id)}>
                <SquareTerminal size={14} />
                {input.t("Show in transcript")}
              </button>
            ))
          }
        />
      );
    }
    if (item.kind === "run") {
      return renderRunActivityItem(item);
    }
    if (item.kind === "approval") {
      const approval = item.record;
      const approvalStatus = effectiveApprovalStatus(approval);
      return (
        <MessageBubble
          tone="approval"
          avatar={<AvatarInitial label="A" tone="teal" />}
          author={input.t("Approval event")}
          tag={approvalStatus}
          time={formatDateTime(approval.resolvedAt ?? approval.createdAt)}
          body={input.t("{title} is {status}.", { title: approval.title, status: approvalStatus })}
          action={
            input.activityActionRow(item.id, (
              <button className="secondary-button compact-button" type="button" onClick={() => input.onOpenApprovalDetail(approval)}>
                <CheckCircle2 size={14} />
                {input.t("Open approval")}
              </button>
            ))
          }
        />
      );
    }
    if (item.kind === "state-transition") {
      return renderStateTransitionActivityItem(item);
    }
    const summary = item.record;
    return (
      <MessageBubble
        tone="protocol"
        avatar={<AvatarInitial label="C" tone="orange" />}
        author={input.t("Context summary")}
        tag={summary.targetType}
        time={formatDateTime(summary.updatedAt)}
        body={summary.summary}
        action={
          input.activityActionRow(item.id, <>
            <button className="secondary-button compact-button" type="button" onClick={() => input.onCreateTaskFromContextSummary(summary)}>
              <Plus size={14} />
              {input.t("Create task")}
            </button>
            <button className="secondary-button compact-button" type="button" onClick={() => input.onOpenContextSummaryInConversationDetail(summary)}>
              <CheckCircle2 size={14} />
              {input.t("Review source")}
            </button>
          </>)
        }
      />
    );
  }

  function renderMessageActivityItem(item: Extract<ChannelActivityItem, { readonly kind: "message" }>): ReactNode {
    const message = item.record;
    const plainChatMessage = message.kind === "message" || message.kind === "ai_reply";
    const pendingAiReply = message.kind === "ai_reply" && message.status === "pending";
    const pendingAiReplyBody = pendingAiReply && !message.body.trim() ? input.t("Thinking...") : message.body;
    const executionProposals = (input.executionProposalsByMessageId.get(message.id) ?? [])
      .filter((proposal) => input.auditActivityVisible || !proposalShouldHideInDefaultFeed(proposal, input.channelWorkflows));
    const messageUsedMemoryEvents = filterUsedMemoryEventsByResponse(input.usedMemoryEvents, message.id);
    const usedMemorySummary = messageUsedMemoryEvents.length > 0 ? (
      <UsedMemorySummary variant="inline" events={messageUsedMemoryEvents} memoryById={input.memoryById} />
    ) : undefined;
    const messageFileRefs = message.fileRefs ?? [];
    const nonChatAction = message.linkedTaskId
      ? input.activityActionRow(item.id, <code>{message.linkedTaskId}</code>)
      : input.activityActionRow(item.id);
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
              : message.authorType === "system" ? "system" : "chat"}
            avatar={renderChannelMessageAvatar(message)}
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
              <div className={pendingAiReply ? "message-body-shell message-body-with-spinner" : "message-body-shell"}>
                {pendingAiReply ? <Loader2 className="message-pending-spinner spin" size={13} /> : null}
                {messagePresentation.body.trim() ? <MessageBodyRenderer text={messagePresentation.body} cwd={input.cwd} compact streaming={pendingAiReply} onOpenLocalFile={input.onOpenFileReference} /> : null}
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
            actionsNode={!editing && message.status !== "blocked" && message.authorType === "ai-teammate"
              ? renderChannelAiMessageActions(message, message.body)
              : !editing && message.status !== "blocked" && message.authorType === "local-user"
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
    return (
      <div className="message-group">
        <MessageBubble
          tone={message.status === "blocked" ? "chat-blocked" : plainChatMessage ? "chat" : "system"}
          side={plainChatMessage && message.authorType === "local-user" ? "end" : "start"}
          avatar={renderChannelMessageAvatar(message)}
          author={messageAuthorLabel(message, input.teammateOptions, input.t("Deleted teammate"), input.localUserDisplayName, input.allLocalTeammateById)}
          tag={message.kind === "task_link" ? "Task" : undefined}
          time={formatDateTime(message.createdAt)}
          body={pendingAiReplyBody}
          pending={pendingAiReply}
          metaAction={plainChatMessage ? (
            <Tooltip content={input.t("Reply in topic")}>
              <button
                className="message-reply-button"
                type="button"
                onClick={() => input.onOpenThreadForMessage(message)}
                aria-label={input.t("Reply in topic")}
              >
                <Reply size={11} />
              </button>
            </Tooltip>
          ) : undefined}
          action={plainChatMessage ? usedMemorySummary : nonChatAction}
        />
        {executionProposals.map((proposal) => renderExecutionProposalCard(proposal))}
      </div>
    );
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

  function renderWorkflowActivityItem(item: Extract<ChannelActivityItem, { readonly kind: "workflow" }>): ReactNode {
    const workflow = item.record;
    const steps = input.channelWorkflowSteps.filter((step) => step.workflowId === workflow.id);
    const progressModel = input.workflowProgressByWorkflowId.get(workflow.id);
    if (progressModel && !input.auditActivityVisible) {
      const workCell = input.conversationWorkCellByWorkflowId.get(workflow.id);
      if (!workCell) {
        return null;
      }
      const detailsKey = input.workflowWorkCellDetailsCacheKey(workflow.id);
      return (
        <ConversationWorkCell
          model={workCell}
          surface={channelSurface}
          composerGateApproval={composerGateApprovalPresentationForWorkCell(workCell, composerGateApprovalByRunId)}
          cwd={input.runById.get(workCell.anchorRunId)?.cwd ?? input.cwd}
          detailsState={input.conversationWorkCellDetailsByKey[detailsKey] ?? { status: "not_loaded" }}
          onOpenRun={workCell.anchorRunId.startsWith("workflow:") ? undefined : input.onOpenRun}
          onLoadDetails={input.onLoadWorkflowWorkCellDetails}
          loadPreview={input.loadPreview}
          renderAgentAvatar={renderConversationAgentAvatar}
          renderParticipantAvatar={renderConversationParticipantAvatar}
          onOpenWorkspaceFile={input.onOpenTerminalReportFile}
          onOpenWorkspaceReview={input.onOpenWorkspaceReview}
        />
      );
    }
    return (
      <MessageBubble
        tone="runtime"
        avatar={<AvatarInitial label="W" tone="violet" />}
        author={input.t("Workflow")}
        tag={workflow.status}
        time={formatDateTime(workflow.updatedAt)}
        body={`${workflow.title}: ${workflow.objective}`}
        action={
          input.activityActionRow(item.id, <>
            <small>{input.t("{count} steps", { count: steps.length })}</small>
            {workflow.status === "succeeded" ? (
              <WorkflowFinalSummary
                workflow={workflow}
                steps={steps}
                artifactsByRun={input.channelArtifactsByRun}
              />
            ) : null}
            <button
              className="secondary-button compact-button"
              type="button"
              onClick={() => input.onOrchestrateWorkflow(workflow)}
              disabled={input.orchestratingWorkflowId === workflow.id || !workflowCanAdvance(workflow.status)}
            >
              {input.orchestratingWorkflowId === workflow.id ? <Loader2 className="spin" size={14} /> : <Play size={14} />}
              {input.t("Advance")}
            </button>
            <button
              className="secondary-button compact-button"
              type="button"
              onClick={() => input.onCancelWorkflow(workflow)}
              disabled={input.orchestratingWorkflowId === workflow.id || !workflowCanCancel(workflow.status)}
            >
              <Square size={14} />
              {input.t("Cancel")}
            </button>
            <button className="secondary-button compact-button" type="button" onClick={input.onRevealReviewInConversation}>
              <CheckCircle2 size={14} />
              {input.t("Review source")}
            </button>
          </>)
        }
      />
    );
  }

  function renderWorkflowStepActivityItem(item: Extract<ChannelActivityItem, { readonly kind: "workflow-step" }>): ReactNode {
    const step = item.record;
    return (
      <MessageBubble
        tone="runtime"
        avatar={<AvatarInitial label="S" tone="teal" />}
        author={input.t("Workflow step")}
        tag={step.status}
        time={formatDateTime(step.updatedAt)}
        body={`${step.title}: ${step.prompt}`}
        action={
          step.blocker ? (
            input.activityActionRow(item.id, <>
              <div className="provider-run-notice compact">
                <CircleAlert size={14} />
                <span>{step.blocker}</span>
              </div>
              <button className="secondary-button compact-button" type="button" onClick={() => input.onRetryWorkflowStep(step)} disabled={input.runningWorkflowStepId === step.id || step.status !== "blocked"}>
                {input.runningWorkflowStepId === step.id ? <Loader2 className="spin" size={14} /> : <RefreshCw size={14} />}
                {input.t("Retry")}
              </button>
              <button className="secondary-button compact-button" type="button" onClick={input.onRevealReviewInConversation}>
                <CheckCircle2 size={14} />
                {input.t("Review source")}
              </button>
            </>)
          ) : step.taskId ? (
            input.activityActionRow(item.id, <>
              <span>{input.t("Task linked")}</span>
              <button className="secondary-button compact-button" type="button" onClick={input.onRevealReviewInConversation}>
                <CheckCircle2 size={14} />
                {input.t("Review source")}
              </button>
            </>)
          ) : (
            input.activityActionRow(item.id, (
              <button className="secondary-button compact-button" type="button" onClick={input.onRevealReviewInConversation}>
                <CheckCircle2 size={14} />
                {input.t("Review source")}
              </button>
            ))
          )
        }
      />
    );
  }

  function renderRunActivityItem(item: Extract<ChannelActivityItem, { readonly kind: "run" }>): ReactNode {
    const run = item.record;
    const workCell = run.threadId ? input.conversationWorkCellByThreadId.get(run.threadId) : undefined;
    if (workCell) {
      if (workCell.anchorRunId !== run.id) {
        return null;
      }
      return (
        <ConversationWorkCell
          model={workCell}
          surface={channelSurface}
          composerGateApproval={composerGateApprovalPresentationForWorkCell(workCell, composerGateApprovalByRunId)}
          cwd={run.cwd}
          detailsState={input.conversationWorkCellDetailsByKey[input.conversationWorkCellDetailsCacheKey(workCell.threadId)] ?? { status: "not_loaded" }}
          onOpenRun={input.onOpenRun}
          onLoadDetails={input.onLoadConversationWorkCellDetails}
          loadPreview={input.loadPreview}
          renderAgentAvatar={renderConversationAgentAvatar}
          renderParticipantAvatar={renderConversationParticipantAvatar}
          onOpenWorkspaceFile={input.onOpenTerminalReportFile}
          onOpenWorkspaceReview={input.onOpenWorkspaceReview}
        />
      );
    }
    const taskTitle = item.task?.title ?? input.readRunTitle(run);
    return (
      <MessageBubble
        tone="work"
        avatar={<AvatarInitial label="R" tone="violet" />}
        author={input.t("Run event")}
        tag={run.status}
        time={formatDateTime(run.endedAt ?? run.startedAt ?? run.updatedAt)}
        body={input.t("Run for {title} is {status}.", { title: taskTitle, status: run.status })}
        action={
          input.activityActionRow(item.id, (
            <button className="secondary-button compact-button" type="button" onClick={() => input.onRevealRunFromActivity(run.id)}>
              <History size={14} />
              {input.t("Show in transcript")}
            </button>
          ))
        }
      />
    );
  }

  function renderStateTransitionActivityItem(item: Extract<ChannelActivityItem, { readonly kind: "state-transition" }>): ReactNode {
    const transition = item.record;
    return (
      <MessageBubble
        tone="runtime"
        avatar={<AvatarInitial label="S" tone="violet" />}
        author={input.t("State change")}
        tag={transition.entityType}
        time={formatDateTime(transition.createdAt)}
        body={input.t("{entityType} {entityId}: {fromStatus} -> {toStatus} via {event}.", {
          entityType: transition.entityType,
          entityId: transition.entityId,
          fromStatus: transition.fromStatus,
          toStatus: transition.toStatus,
          event: transition.event,
        })}
        action={
          input.activityActionRow(item.id, (
            <button
              className="secondary-button compact-button"
              type="button"
              onClick={() => {
                if (transition.entityType === "task") {
                  input.onRevealTaskFromActivity(transition.entityId);
                } else if (transition.entityType === "run") {
                  input.onRevealRunFromActivity(transition.entityId);
                } else if (transition.entityType === "approval") {
                  input.onOpenApprovalDetail(input.approvals.find((approval) => approval.id === transition.entityId));
                } else {
                  input.onRevealReviewInConversation();
                }
              }}
            >
              {transition.entityType === "task" ? <SquareTerminal size={14} /> : transition.entityType === "run" ? <History size={14} /> : <Workflow size={14} />}
              {input.t("Open event")}
            </button>
          ))
        }
      />
    );
  }

  function renderMessageFeedItem(feedItem: ChannelMessageFeedItem | undefined): ReactNode {
    if (!feedItem) {
      return null;
    }
    if (feedItem.kind === "older-loader") {
      return (
        <div className="message-feed-loader-row" role="status">
          {input.channelMessagesLoadingOlder ? <Loader2 className="spin" size={14} /> : <ChevronUp size={14} />}
          <span>{input.channelMessagesLoadingOlder ? input.t("Loading earlier messages...") : input.t("Scroll up to load earlier messages")}</span>
        </div>
      );
    }
    if (feedItem.kind === "pending-send") {
      return renderPendingChannelSendPreview(feedItem.preview, feedItem.showSentMessage);
    }
    if (feedItem.kind === "turn") {
      return renderConversationTurnItem(feedItem.turn, feedItem.pendingReplyPreview);
    }
    return renderMessageFeedActivityItem(feedItem.item);
  }

  function renderPendingChannelSendPreview(preview: PendingChannelSendPreview, showSentMessage: boolean): ReactNode {
    return (
      <div className="message-group channel-pending-send-group">
        {showSentMessage ? (
          <MessageRow
            surface={channelSurface}
            className="channel-message-row pending-send"
            authorType="local-user"
            avatar={<UserProfileAvatar profile={input.userProfile} fallbackLabel={input.localUserDisplayName} />}
            authorName={input.localUserDisplayName}
            createdAtLabel={formatDateTime(preview.createdAt)}
            bodyNode={(
              <div className="message-body-shell">
                <MessageBodyRenderer text={preview.body} cwd={input.cwd} compact onOpenLocalFile={input.onOpenFileReference} />
              </div>
            )}
            attachmentsNode={renderChannelMessageAssets(preview.attachmentIds, preview.fileRefs, preview.linkPreviewIds, preview.channelId)}
          />
        ) : null}
        {renderPendingChannelReplyStatus()}
      </div>
    );
  }

  function renderPendingChannelReplyStatus(): ReactNode {
    return (
      <MessageRow
        surface={channelSurface}
        className="channel-message-row channel-send-thinking-message"
        authorType="ai-teammate"
        avatar={renderLingAgentAvatar()}
        authorName={input.t("Ling Agent")}
        body={input.t("Thinking...")}
        bodyCompact
        bodyStreaming
      />
    );
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

  return { renderMessageFeedItem };
}

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

function conversationTurnHasTerminalSummary(turn: ConversationTurnViewModel): boolean {
  return Boolean(turn.operationCell?.terminalReportRows.length) ||
    turn.blocks.some((block) => block.kind === "coordinator_message" && block.phase === "terminal");
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
