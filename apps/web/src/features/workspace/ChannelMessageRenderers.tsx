import type { ReactNode } from "react";
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
  Play,
  Plus,
  RefreshCw,
  Reply,
  Save,
  Square,
  SquareTerminal,
  ThumbsDown,
  ThumbsUp,
  Workflow,
} from "lucide-react";
import { effectiveApprovalStatus } from "../../lib/approvals.js";
import type { ChannelActivityItem } from "../../lib/channel-activity.js";
import { conversationAgentActivitySummary, type ConversationAgentActivitySpan, type ConversationWorkCellViewModel } from "../../lib/conversation-work-cell.js";
import type { ConversationTranscriptBlock, ConversationTurnViewModel } from "../../lib/conversation-turn-projector.js";
import { truncatePreview } from "../../lib/data.js";
import { formatDateTime } from "../../lib/formatting.js";
import { attachmentCanPreview, type PreviewRequest } from "../../lib/previews.js";
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
  ConversationWorkCell,
  FileRefChip,
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
} from "../../shared/conversation/index.js";
import type {
  ApprovalRequest,
  Channel,
  ChannelAttachment,
  ChannelContextSummary,
  ChannelDecision,
  ChannelExecutionProposal,
  ChannelHandoff,
  ChannelHandoffStatus,
  ChannelMention,
  ChannelMessage,
  ChannelTeamEvidenceStatus,
  ChannelMessageFileRef,
  ChannelWorkflow,
  ChannelWorkflowStep,
  FoldedExpertsReadModel,
  MemoryObject,
  RunArtifact,
  RunSession,
  ProposedPlanArtifact,
  PreviewContentResponse,
  StateTransitionEvent,
  UsedMemoryEvent,
  UpdateChannelExecutionProposalRequest,
  UserProfile,
} from "../../types.js";
import type { LocalTeammateDraft } from "../teammates/index.js";
import { TeammateAvatarView } from "../teammates/TeammateAvatarView.js";
import { ChannelTeamExpertsSummary } from "./ChannelTeamExpertsSummary.js";
import {
  ChannelExecutionProposalCard,
  WorkflowFinalSummary,
  workflowCanAdvance,
  workflowCanCancel,
} from "./ChannelWorkflowProposalCards.js";
import type { ChannelMessageFeedItem, PendingChannelSendPreview } from "./ChannelMessageFeed.js";

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
  readonly channelAttachmentById: ReadonlyMap<string, ChannelAttachment>;
  readonly channelMessageFeedbackById: Readonly<Record<string, FeedbackValue>>;
  readonly channelMessagesLoadingOlder: boolean;
  readonly channelTeamExpertsByTurn: Readonly<Record<string, ChannelTeamExpertsState>>;
  readonly channelTeamExpertsExpandedByTurn: Readonly<Record<string, boolean>>;
  readonly channelWorkflowSteps: readonly ChannelWorkflowStep[];
  readonly channelWorkflows: readonly ChannelWorkflow[];
  readonly conversationWorkCellByThreadId: ReadonlyMap<string, ConversationWorkCellViewModel>;
  readonly conversationWorkCellByWorkflowId: ReadonlyMap<string, ConversationWorkCellViewModel>;
  readonly conversationWorkCellDetailsByKey: Readonly<Record<string, ConversationWorkCellDetailsState>>;
  readonly cwd: string;
  readonly executionProposalsByMessageId: ReadonlyMap<string, readonly ChannelExecutionProposal[]>;
  readonly formatBytes: (value: number) => string;
  readonly latestStatus: string;
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
  readonly activityActionRow: (activityItemId: string, children?: ReactNode) => JSX.Element;
  readonly conversationWorkCellDetailsCacheKey: (threadId: string) => string;
  readonly onCancelExecutionProposal: (proposal: ChannelExecutionProposal) => void;
  readonly onCancelWorkflow: (workflow: ChannelWorkflow) => void;
  readonly onConfirmExecutionProposal: (proposal: ChannelExecutionProposal) => void;
  readonly onCreateTaskFromContextSummary: (summary: ChannelContextSummary) => void;
  readonly onAcceptProposedPlan: (plan: ProposedPlanArtifact) => void;
  readonly onConvertProposedPlan: (plan: ProposedPlanArtifact) => void;
  readonly onLoadConversationWorkCellDetails: (threadId: string) => void;
  readonly onLoadWorkflowWorkCellDetails: (workflowIdOrThreadId: string, options?: { readonly force?: boolean }) => void;
  readonly onOpenApprovalDetail: (approval: ApprovalRequest | undefined) => void;
  readonly onOpenContextSummaryInConversationDetail: (summary: ChannelContextSummary) => void;
  readonly onOpenRun: (runId: string) => void;
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
  readonly onToggleChannelTeamExpertsExpanded: (turnId: string) => void;
  readonly onUpdateExecutionProposal: (
    proposal: ChannelExecutionProposal,
    input: UpdateChannelExecutionProposalRequest,
  ) => Promise<ChannelExecutionProposal | undefined>;
  readonly onUpdateHandoffStatus: (handoff: ChannelHandoff, status: ChannelHandoffStatus) => void;
  readonly readRunTitle: (run: RunSession) => string;
  readonly resolveExpertTeammate: (agentId: string | undefined) => LocalTeammateDraft | undefined;
  readonly planActionBusyId: string;
  readonly proposedPlanArtifactsById: ReadonlyMap<string, ProposedPlanArtifact>;
  readonly workflowWorkCellDetailsCacheKey: (workflowId: string) => string;
}

interface ChannelTeamExpertsState {
  readonly channelId: string;
  readonly turnId: string;
  readonly experts: FoldedExpertsReadModel;
}

export interface ChannelMessageRenderers {
  readonly renderMessageFeedItem: (feedItem: ChannelMessageFeedItem | undefined) => ReactNode;
}

export function createChannelMessageRenderers(input: ChannelMessageRenderersInput): ChannelMessageRenderers {
  function renderChannelMessageAvatar(message: ChannelMessage): ReactNode {
    if (message.authorType === "ai-teammate") {
      const teammate = input.allLocalTeammateById.get(message.authorId ?? "");
      return teammate
        ? <TeammateAvatarView teammate={teammate} cwd={input.cwd} compact />
        : message.authorId === LING_AGENT_AUTHOR_ID
          ? <AvatarInitial label="L" tone="violet" />
          : <AvatarInitial label="A" tone="teal" />;
    }
    if (message.authorType === "system") {
      return <AvatarInitial label="S" tone="violet" />;
    }
    return <UserProfileAvatar profile={input.userProfile} fallbackLabel={input.localUserDisplayName} />;
  }

  function renderConversationAgentAvatar(span: ConversationAgentActivitySpan): ReactNode {
    const participantId = span.participantId?.trim();
    const teammate = (participantId ? input.allLocalTeammateById.get(participantId) : undefined) ??
      input.allLocalTeammateByName.get(span.label.trim().toLowerCase());
    return teammate ? <TeammateAvatarView teammate={teammate} cwd={input.cwd} compact /> : undefined;
  }

  function renderConversationTurnAgentParticipationSummary(
    spans: readonly ConversationAgentActivitySpan[],
    operationStatus: string | undefined,
    expanded: boolean,
    onToggleExpanded: () => void,
  ): ReactNode {
    const entries = spans.map((span, index) => ({
      span,
      index,
      status: conversationAgentParticipationStatus(span, operationStatus),
      summary: conversationAgentActivitySummary(span),
    }));
    const activeCount = entries.filter((entry) => entry.status === "pending").length;
    const completedCount = entries.filter((entry) => entry.status === "completed" || entry.status === "adopted").length;
    const delayedCount = entries.filter((entry) => entry.status === "timeout" || entry.status === "expired").length;
    const unavailableCount = entries.filter((entry) => entry.status === "unavailable" || entry.status === "rejected").length;
    const summaryItems = [
      activeCount > 0 ? { label: `${activeCount} ${input.t("active")}`, tone: "active" as const } : undefined,
      completedCount > 0 ? { label: `${completedCount} ${input.t("done")}`, tone: "done" as const } : undefined,
      delayedCount > 0 ? { label: `${delayedCount} ${input.t("delayed")}`, tone: "delayed" as const } : undefined,
      unavailableCount > 0 ? { label: `${unavailableCount} ${input.t("unavailable")}`, tone: "unavailable" as const } : undefined,
    ].filter((item): item is { readonly label: string; readonly tone: "active" | "done" | "delayed" | "unavailable" } => Boolean(item));
    const ariaLabel = `${input.t("Teammates")}: ${summaryItems.map((item) => item.label).join(", ") || `${entries.length} ${input.t("done")}`}`;

    return (
      <section className="channel-team-experts-summary" aria-label={input.t("Teammates")}>
        <button
          type="button"
          className="channel-team-experts-summary-toggle"
          aria-expanded={expanded}
          aria-label={ariaLabel}
          onClick={onToggleExpanded}
        >
          <span className="channel-team-experts-summary-chips" aria-hidden="true">
            {entries.slice(0, 4).map((entry) => {
              const avatar = renderConversationAgentAvatar(entry.span);
              const title = entry.summary ? `${entry.span.label}: ${entry.summary}` : entry.span.label;
              return avatar ? (
                <span className={`channel-team-experts-chip status-${entry.status} has-avatar`} title={title} key={entry.span.id}>
                  {avatar}
                </span>
              ) : (
                <span className={`channel-team-experts-chip status-${entry.status} tone-${entry.index % 6}`} title={title} key={entry.span.id}>
                  {conversationAgentInitials(entry.span.label)}
                </span>
              );
            })}
            {entries.length > 4 ? (
              <span className="channel-team-experts-chip more">+{entries.length - 4}</span>
            ) : null}
          </span>
          <span className="channel-team-experts-summary-meta">
            {summaryItems.map((item, index) => (
              <span className={`channel-team-experts-summary-meta-item tone-${item.tone}`} key={item.tone}>
                {item.label}
                {index < summaryItems.length - 1 ? <span className="channel-team-experts-summary-meta-separator">,</span> : null}
              </span>
            ))}
          </span>
        </button>
        {expanded ? (
          <div className="channel-team-experts-summary-panel">
            {entries.map((entry) => (
              <article className={`channel-team-experts-summary-entry status-${entry.status}`} aria-label={`${entry.span.label}: ${entry.summary}`} key={entry.span.id}>
                <span className="channel-team-experts-summary-entry-dot" aria-hidden="true" />
                <span className="channel-team-experts-summary-entry-avatar" aria-hidden="true">
                  {renderConversationAgentAvatar(entry.span) ?? conversationAgentInitials(entry.span.label)}
                </span>
                <strong className="channel-team-experts-summary-entry-agent">{entry.span.label}</strong>
                <p className="channel-team-experts-summary-entry-summary">{entry.summary}</p>
              </article>
            ))}
          </div>
        ) : null}
      </section>
    );
  }

  const conversationTranscriptBlockRenderers = createTranscriptBlockRendererRegistry<
    ConversationTurnViewModel,
    ConversationTranscriptBlock,
    WorkspaceTranscriptRenderContext
  >({
    coordinator_message: renderCoordinatorMessageTranscriptBlock,
    operation: renderOperationTranscriptBlock,
    agent_activity: renderGenericTranscriptBlock,
    approval: renderGenericTranscriptBlock,
    artifact_strip: renderGenericTranscriptBlock,
    source_summary: renderGenericTranscriptBlock,
    workflow_packet_summary: renderGenericTranscriptBlock,
    requirement_shaping: renderGenericTranscriptBlock,
    decision_needed: renderGenericTranscriptBlock,
    final_result: renderFinalResultTranscriptBlock,
    raw_debug_ref: renderGenericTranscriptBlock,
  });

  function renderConversationTurnItem(turn: ConversationTurnViewModel): ReactNode {
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
    const teamExpertsState = input.channelTeamExpertsByTurn[turn.sourceMessage.id];
    const teamExperts = teamExpertsState?.channelId === input.selectedChannelId && teamExpertsState.turnId === turn.sourceMessage.id
      ? teamExpertsState.experts
      : undefined;
    const terminalSummaryRendered = conversationTurnHasTerminalSummary(turn);
    const hasStructuredTerminalReport = Boolean(turn.operationCell?.terminalReportRows.length);
    const hasTeamExpertsSummary = !hasStructuredTerminalReport && Boolean(teamExperts && teamExperts.totalCount > 1);
    const fallbackParticipationSpans = terminalSummaryRendered && !hasStructuredTerminalReport && !hasTeamExpertsSummary
      ? uniqueAgentParticipationSpans(turn.operationCell?.agentSpans ?? [])
      : [];
    const teamExpertsExpanded = input.channelTeamExpertsExpandedByTurn[turn.sourceMessage.id] ?? false;
    const externalArtifactItems = terminalSummaryRendered
      ? turn.operationCell?.artifactStripItems ?? []
      : [];

    return (
      <MessageRow
        className={[
          "channel-message-row conversation-turn-assistant-row",
          hasTeamExpertsSummary || fallbackParticipationSpans.length > 1 ? "has-team-experts" : "",
        ].filter(Boolean).join(" ")}
        authorType="ai-teammate"
        avatar={anchorMessage ? renderChannelMessageAvatar(anchorMessage) : <AvatarInitial label="L" tone="violet" />}
        authorName={authorName}
        createdAtLabel={formatDateTime(createdAt)}
        bodyNode={(
          <div className="conversation-turn-assistant-transcript">
            {turn.blocks.map((block) => renderTranscriptBlockFromRegistry(conversationTranscriptBlockRenderers, {
              turn,
              block,
              context: transcriptContext,
            }))}
            {teamExperts && hasTeamExpertsSummary ? (
              <ChannelTeamExpertsSummary
                experts={teamExperts}
                expanded={teamExpertsExpanded}
                onToggleExpanded={() => input.onToggleChannelTeamExpertsExpanded(turn.sourceMessage.id)}
                cwd={input.cwd}
                resolveExpertTeammate={input.resolveExpertTeammate}
                labels={{
                  experts: input.t("Teammates"),
                  active: input.t("active"),
                  done: input.t("done"),
                  delayed: input.t("delayed"),
                  unavailable: input.t("unavailable"),
                }}
              />
            ) : fallbackParticipationSpans.length > 1 ? (
              renderConversationTurnAgentParticipationSummary(
                fallbackParticipationSpans,
                turn.operationCell?.status,
                teamExpertsExpanded,
                () => input.onToggleChannelTeamExpertsExpanded(turn.sourceMessage.id),
              )
            ) : null}
            {externalArtifactItems.length > 0 ? (
              <div className="conversation-turn-artifacts">
                <ConversationArtifactStripPanel
                  items={externalArtifactItems}
                  cwd={input.cwd}
                  loadPreview={input.loadPreview}
                />
              </div>
            ) : null}
            {renderChannelAiMessageActions(turn.sourceMessage, copyText)}
          </div>
        )}
      />
    );
  }

  function renderChannelAiMessageActions(message: ChannelMessage, copyText: string): ReactNode {
    const feedback = input.channelMessageFeedbackById[message.id];
    const surface = input.selectedChannelBranchRootThreadId ? "channel_branch" : "channel_root";
    return (
      <div className="channel-message-row-footer-stack">
        <MessageActionBar
          surface={surface}
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
    if (!body) {
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
        <MessageBodyRenderer text={body} cwd={input.cwd} compact streaming={pendingCoordinatorMessage} />
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
    return (
      <div className="conversation-turn-operation" key={block.id}>
        <ConversationWorkCell
          model={block.operationCell}
          cwd={input.cwd}
          detailsState={context.detailsState}
          onOpenRun={block.operationCell.anchorRunId.startsWith("workflow:") ? undefined : input.onOpenRun}
          onLoadDetails={context.onLoadDetails}
          loadPreview={input.loadPreview}
          renderAgentAvatar={renderConversationAgentAvatar}
          showArtifactStrip={!conversationTurnHasTerminalSummary(turn)}
          showTerminalReport={!turn.blocks.some((item) => item.kind === "final_result")}
        />
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
        revisionKey={block.terminalReportRevisionKey}
        rows={block.rows}
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
      ? readProposedPlanBlock(pendingAiReplyBody, message)
      : undefined;
    const proposedPlan = proposedPlanBlock
      ? input.proposedPlanArtifactsById.get(proposedPlanBlock.plan.id) ?? proposedPlanBlock.plan
      : undefined;
    const visibleMessageBody = proposedPlanBlock?.displayBody ?? pendingAiReplyBody;
    if (plainChatMessage) {
      return (
        <div className="message-group">
          <MessageRow
            className={message.status === "blocked" ? "channel-message-row blocked" : "channel-message-row"}
            authorType={message.authorType}
            avatar={renderChannelMessageAvatar(message)}
            authorName={messageAuthorLabel(message, input.teammateOptions, input.t("Deleted teammate"), input.localUserDisplayName, input.allLocalTeammateById)}
            createdAtLabel={formatDateTime(message.createdAt)}
            bodyNode={(
              <div className={pendingAiReply ? "message-body-shell message-body-with-spinner" : "message-body-shell"}>
                {pendingAiReply ? <Loader2 className="message-pending-spinner spin" size={13} /> : null}
                {visibleMessageBody.trim() ? <MessageBodyRenderer text={visibleMessageBody} cwd={input.cwd} compact streaming={pendingAiReply} /> : null}
                {proposedPlanBlock ? (
                  <ProposedPlanBlock
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
            attachmentsNode={renderChannelMessageAssets(message.attachmentIds, messageFileRefs, message.channelId)}
            evidenceNode={(messageUsedMemoryEvents.length > 0 || message.webEvidence) ? (
              <MessageEvidencePanel
                memoryContent={usedMemorySummary}
                memorySummary={messageUsedMemoryEvents.length > 0 ? <UsedMemorySummaryLabel events={messageUsedMemoryEvents} /> : undefined}
                webEvidence={message.webEvidence}
              />
            ) : null}
            actionsNode={message.authorType === "ai-teammate" ? renderChannelAiMessageActions(message, message.body) : null}
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
            <button className="message-reply-button" type="button" onClick={() => input.onOpenThreadForMessage(message)} aria-label={input.t("Reply in topic")} data-tooltip={input.t("Reply in topic")}>
              <Reply size={11} />
            </button>
          ) : undefined}
          action={plainChatMessage ? usedMemorySummary : nonChatAction}
        />
        {executionProposals.map((proposal) => renderExecutionProposalCard(proposal))}
      </div>
    );
  }

  function renderExecutionProposalCard(proposal: ChannelExecutionProposal): ReactNode {
    return (
      <ChannelExecutionProposalCard
        key={proposal.id}
        proposal={proposal}
        assigneeLabel={teammateLabel(proposal.assigneeTeammateId, input.teammateOptions, input.t("Deleted teammate"))}
        teammates={input.teammateOptions}
        linkedRun={proposal.linkedRunId ? input.runById.get(proposal.linkedRunId) : undefined}
        linkedWorkflow={proposal.linkedWorkflowId ? input.channelWorkflows.find((workflow) => workflow.id === proposal.linkedWorkflowId) : undefined}
        activeRunId={input.activeRunId}
        latestStatus={input.latestStatus}
        onConfirm={() => input.onConfirmExecutionProposal(proposal)}
        onCancel={() => input.onCancelExecutionProposal(proposal)}
        onUpdate={input.onUpdateExecutionProposal}
        onOpenRun={input.onOpenRun}
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
          cwd={input.cwd}
          detailsState={input.conversationWorkCellDetailsByKey[detailsKey] ?? { status: "not_loaded" }}
          onOpenRun={workCell.anchorRunId.startsWith("workflow:") ? undefined : input.onOpenRun}
          onLoadDetails={input.onLoadWorkflowWorkCellDetails}
          loadPreview={input.loadPreview}
          renderAgentAvatar={renderConversationAgentAvatar}
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
          cwd={input.cwd}
          detailsState={input.conversationWorkCellDetailsByKey[input.conversationWorkCellDetailsCacheKey(workCell.threadId)] ?? { status: "not_loaded" }}
          onOpenRun={input.onOpenRun}
          onLoadDetails={input.onLoadConversationWorkCellDetails}
          loadPreview={input.loadPreview}
          renderAgentAvatar={renderConversationAgentAvatar}
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
      return renderConversationTurnItem(feedItem.turn);
    }
    return renderMessageFeedActivityItem(feedItem.item);
  }

  function renderPendingChannelSendPreview(preview: PendingChannelSendPreview, showSentMessage: boolean): ReactNode {
    return (
      <div className="message-group channel-pending-send-group">
        {showSentMessage ? (
          <MessageRow
            className="channel-message-row pending-send"
            authorType="local-user"
            avatar={<UserProfileAvatar profile={input.userProfile} fallbackLabel={input.localUserDisplayName} />}
            authorName={input.localUserDisplayName}
            createdAtLabel={formatDateTime(preview.createdAt)}
            bodyNode={(
              <div className="message-body-shell">
                <MessageBodyRenderer text={preview.body} cwd={input.cwd} compact />
              </div>
            )}
            attachmentsNode={renderChannelMessageAssets(preview.attachmentIds, preview.fileRefs, preview.channelId)}
          />
        ) : null}
        <div className="channel-send-thinking-row" role="status" aria-live="polite">
          <Loader2 className="message-pending-spinner spin" size={13} />
          <span>{input.t("Thinking...")}</span>
        </div>
      </div>
    );
  }

  function renderChannelMessageAssets(
    attachmentIds: readonly string[],
    fileRefs: readonly ChannelMessageFileRef[] = [],
    channelId: string = input.selectedChannelId,
  ): ReactNode {
    const attachments = attachmentIds
      .map((id) => input.channelAttachmentById.get(id))
      .filter((attachment): attachment is ChannelAttachment => Boolean(attachment));
    if (attachments.length === 0 && fileRefs.length === 0) {
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
        {fileRefs.length > 0 ? (
          <div className="conversation-attachment-strip channel-file-ref-strip" aria-label={input.t("Workspace file references")}>
            {fileRefs.map((fileRef, index) => (
              <FileRefChip
                key={`${fileRef.path}:${fileRef.line ?? ""}:${index}`}
                icon={<FileText size={13} />}
                label={fileRef.label ?? fileRef.path}
                meta={fileRef.line !== undefined ? `:${fileRef.line}` : undefined}
              />
            ))}
          </div>
        ) : null}
      </>
    );
  }

  return { renderMessageFeedItem };
}

export const LING_AGENT_AUTHOR_ID = "ling_agent";
const LING_AGENT_AUTHOR_LABEL = "Ling Agent";

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
  if (!turn.operationCell || !shouldSanitizeGeneratedCoordinatorBody(message.body)) {
    return message.body;
  }
  if (phase === "terminal" && isGeneratedWorkflowCoordinatorBody(message.body)) {
    const fallback = conversationCoordinatorTerminalFallback(turn, t);
    return isDuplicateCoordinatorDisplayBody(turn, fallback) ? "" : fallback;
  }
  const cleaned = cleanGeneratedWorkflowText(message.body);
  if (cleaned) {
    return isDuplicateCoordinatorDisplayBody(turn, cleaned) ? "" : cleaned;
  }
  const fallback = phase === "terminal"
    ? conversationCoordinatorTerminalFallback(turn, t)
    : conversationCoordinatorStartFallback(turn, t);
  return isDuplicateCoordinatorDisplayBody(turn, fallback) ? "" : fallback;
}

interface ParsedProposedPlanBlock {
  readonly displayBody: string;
  readonly plan: ProposedPlanArtifact;
}

const proposedPlanPattern = /<proposed_plan(?:\s+title=(?:"([^"]+)"|'([^']+)'))?\s*>([\s\S]*?)<\/proposed_plan>/i;

function readProposedPlanBlock(text: string, message: ChannelMessage): ParsedProposedPlanBlock | undefined {
  const match = proposedPlanPattern.exec(text);
  if (!match) {
    return undefined;
  }
  const bodyMarkdown = (match[3] ?? "").trim();
  if (!bodyMarkdown) {
    return undefined;
  }
  const before = text.slice(0, match.index).trim();
  const after = text.slice(match.index + match[0].length).trim();
  const title = (match[1] ?? match[2] ?? readFirstMarkdownHeading(bodyMarkdown) ?? "Proposed plan").trim();
  return {
    displayBody: [before, after].filter(Boolean).join("\n\n"),
    plan: {
      id: `proposed_plan_${message.id}`,
      workspaceId: message.workspaceId,
      threadId: message.threadId ?? message.id,
      sourceMessageId: message.id,
      sourceRunId: message.linkedRunId,
      title,
      bodyMarkdown,
      status: "draft",
      createdAt: message.createdAt,
      updatedAt: message.updatedAt,
    },
  };
}

function readFirstMarkdownHeading(markdown: string): string | undefined {
  const heading = markdown.split(/\n/u).map((line) => /^#{1,3}\s+(.+)$/.exec(line.trim())?.[1]?.trim()).find(Boolean);
  return heading;
}

function ProposedPlanBlock({
  plan,
  cwd,
  t,
  busy,
  onAccept,
  onConvert,
  onRefine,
  onSave,
}: {
  readonly plan: ProposedPlanArtifact;
  readonly cwd: string;
  readonly t: (key: string, values?: Record<string, string | number>) => string;
  readonly busy: boolean;
  readonly onAccept: (plan: ProposedPlanArtifact) => void;
  readonly onConvert: (plan: ProposedPlanArtifact) => void;
  readonly onRefine: (plan: ProposedPlanArtifact) => void;
  readonly onSave: (plan: ProposedPlanArtifact) => void;
}): JSX.Element {
  return (
    <section className="proposed-plan-block" aria-label={t("Proposed plan")}>
      <header className="proposed-plan-head">
        <span className="proposed-plan-icon" aria-hidden="true">
          <FileCheck2 size={15} />
        </span>
        <span>
          <strong>{plan.title}</strong>
          <small>{t("Proposed plan")} · {plan.status === "accepted" ? t("Accepted") : plan.savedAt ? t("Saved") : t("Draft")}</small>
        </span>
      </header>
      <div className="proposed-plan-body">
        <MessageBodyRenderer text={plan.bodyMarkdown} cwd={cwd} compact />
      </div>
      <footer className="proposed-plan-actions">
        <button className="secondary-button compact-button" type="button" onClick={() => onSave(plan)} disabled={busy}>
          {busy ? <Loader2 className="spin" size={14} /> : <Save size={14} />}
          {t("Save")}
        </button>
        <button className="secondary-button compact-button" type="button" onClick={() => onConvert(plan)} disabled={busy}>
          {busy ? <Loader2 className="spin" size={14} /> : <Workflow size={14} />}
          {t("Convert to workflow")}
        </button>
        <button className="secondary-button compact-button" type="button" onClick={() => onRefine(plan)} disabled={busy}>
          {busy ? <Loader2 className="spin" size={14} /> : <RefreshCw size={14} />}
          {t("Refine plan")}
        </button>
        <button className="primary-button compact-button" type="button" onClick={() => onAccept(plan)} disabled={busy}>
          {busy ? <Loader2 className="spin" size={14} /> : <CheckCircle2 size={14} />}
          {t("Implement")}
        </button>
      </footer>
    </section>
  );
}

function shouldSanitizeGeneratedCoordinatorBody(body: string): boolean {
  const text = body.trim();
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
  return false;
}

function isGeneratedWorkflowCoordinatorBody(body: string): boolean {
  return /Smoke ID\s*:/iu.test(body) ||
    /开始\s*workflow\s*[:：]/iu.test(body) ||
    /^(Done|Stopped|Not completed):\s*"/iu.test(body.trim()) ||
    /^(完成|已停止|未完成)\s*[:：]/u.test(body.trim());
}

function conversationTurnHasTerminalSummary(turn: ConversationTurnViewModel): boolean {
  return Boolean(turn.operationCell?.terminalReportRows.length) ||
    turn.blocks.some((block) => block.kind === "coordinator_message" && block.phase === "terminal");
}

function uniqueAgentParticipationSpans(spans: readonly ConversationAgentActivitySpan[]): readonly ConversationAgentActivitySpan[] {
  const byKey = new Map<string, ConversationAgentActivitySpan>();
  for (const span of spans) {
    if (span.kind === "overflow") {
      continue;
    }
    const key = (span.participantId?.trim() || span.label.trim()).toLowerCase();
    if (!key) {
      continue;
    }
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, span);
      continue;
    }
    byKey.set(key, {
      ...existing,
      summary: span.summary ?? existing.summary,
      meta: span.meta ?? existing.meta,
      tone: span.tone ?? existing.tone,
      stateLabel: span.stateLabel ?? existing.stateLabel,
      latestRow: span.latestRow ?? existing.latestRow,
      rows: [...existing.rows, ...span.rows],
    });
  }
  return [...byKey.values()];
}

function conversationAgentParticipationStatus(
  span: ConversationAgentActivitySpan,
  operationStatus: string | undefined,
): ChannelTeamEvidenceStatus {
  const tone = span.tone ?? span.latestRow?.tone;
  if (tone === "running") {
    return "pending";
  }
  if (tone === "waiting") {
    return "timeout";
  }
  if (tone === "failed") {
    return "unavailable";
  }
  if (tone === "success") {
    return "completed";
  }
  if (operationStatus === "active" || operationStatus === "running" || operationStatus === "waiting_for_approval") {
    return "pending";
  }
  if (operationStatus === "blocked" || operationStatus === "cancelled" || operationStatus === "superseded") {
    return "timeout";
  }
  if (operationStatus === "failed") {
    return "unavailable";
  }
  return "completed";
}

function conversationAgentInitials(value: string): string {
  const normalized = value.trim();
  return normalized
    .split(/[\s_-]+/u)
    .filter(Boolean)
    .slice(-2)
    .map((part) => part.slice(0, 1).toUpperCase())
    .join("") || normalized.slice(0, 2).toUpperCase();
}

function conversationCoordinatorStartFallback(
  turn: ConversationTurnViewModel,
  t: (key: string, values?: Record<string, string | number>) => string,
): string {
  const task = conversationTurnTaskText(turn);
  const agents = conversationTurnAgentLabels(turn);
  const delegation = agents.length > 0
    ? ` ${t("This task is assigned to {agents}.", { agents: formatAgentLabelList(agents) })}`
    : "";
  return `${ensureSentenceEnding(task)}${delegation}`.trim();
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
