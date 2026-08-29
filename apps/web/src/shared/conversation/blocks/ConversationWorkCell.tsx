import { useEffect, type ReactNode } from "react";
import { ChevronDown, CircleAlert, Clock3, FileText, History, Loader2, RefreshCw } from "lucide-react";
import { useI18n, type Translate } from "../../../i18n.js";
import { artifactStripItemOwnedByTypedFact, conversationWorkCellFactOwnership, projectConversationActivity, projectConversationTimelineItems, projectConversationWorkCellTimeline, type ConversationAgentActivitySpan, type ConversationArtifactStripItem, type ConversationOperationCellViewModel, type ConversationOperationSourceRef, type ConversationWorkCellEvidenceLink, type ConversationWorkCellGroup, type ConversationWorkCellItem, type ConversationWorkCellRow } from "../../../lib/conversation-work-cell.js";
import type { ComposerGateApprovalPresentation } from "../../../lib/runtime-approval-presentation.js";
import type { ArtifactPreviewLoader } from "../preview/ArtifactPreviewDrawer.js";
import { getConversationSurfacePolicy, type ConversationSurfaceKind, type TerminalReportProjectionPolicy } from "../tokens/conversation-surface-policy.js";
import { ConversationArtifactStrip, type ConversationWorkspaceReviewTarget } from "./ConversationArtifactStrip.js";
import { MessageBodyRenderer } from "./MessageBodyRenderer.js";
import { TerminalReportBlock, type TerminalReportFileTarget } from "./TerminalReportBlock.js";
import { useConversationBlockView } from "../view-store/use-conversation-block-view.js";
import { useWorkCellActivityVisibility } from "./use-work-cell-activity-visibility.js";
import { ConversationTimeline } from "../timeline/ConversationTimeline.js";
import type { ConversationTimelineItem, ConversationTimelineSubAgentItem } from "@ling-stack/conversation-ui-core";

export type ConversationWorkCellDetailsStatus = "not_loaded" | "loading" | "loaded" | "empty" | "error";

export interface ConversationWorkCellDetailsState {
  readonly status: ConversationWorkCellDetailsStatus;
  readonly groups?: readonly ConversationWorkCellGroup[];
  readonly evidenceLinks?: readonly ConversationWorkCellEvidenceLink[];
  readonly errorMessage?: string;
}

export interface ConversationWorkCellProps {
  readonly model: ConversationOperationCellViewModel;
  readonly surface: ConversationSurfaceKind;
  readonly cwd?: string;
  readonly detailsState?: ConversationWorkCellDetailsState;
  readonly onOpenRun?: (runId: string) => void;
  readonly onLoadDetails?: (threadId: string) => void;
  readonly loadPreview: ArtifactPreviewLoader;
  readonly renderAgentAvatar?: (span: ConversationAgentActivitySpan) => ReactNode;
  readonly renderParticipantAvatar?: (participantId: string | undefined, label: string) => ReactNode;
  readonly showArtifactStrip?: boolean;
  readonly showTerminalReport?: boolean;
  /** True when the owning surface already renders a final agent message. */
  readonly suppressTerminalReport?: boolean;
  readonly composerGateApproval?: ComposerGateApprovalPresentation;
  readonly terminalReportProjectionPolicy?: Partial<TerminalReportProjectionPolicy>;
  readonly onOpenWorkspaceFile?: (target: TerminalReportFileTarget) => void;
  readonly onOpenWorkspaceReview?: (target: ConversationWorkspaceReviewTarget) => void;
}

export function ConversationWorkCell(props: ConversationWorkCellProps): React.JSX.Element {
  if (props.composerGateApproval) {
    return <ComposerGatePendingWorkCell model={props.model} approval={props.composerGateApproval} />;
  }
  return <ConversationWorkCellContent {...props} />;
}

function ConversationWorkCellContent({
  model,
  surface,
  cwd,
  detailsState,
  onOpenRun,
  onLoadDetails,
  loadPreview,
  renderAgentAvatar,
  renderParticipantAvatar,
  showArtifactStrip = true,
  showTerminalReport = true,
  suppressTerminalReport = false,
  terminalReportProjectionPolicy,
  onOpenWorkspaceFile,
  onOpenWorkspaceReview,
}: ConversationWorkCellProps): React.JSX.Element {
  const { t } = useI18n();
  const timelinePolicy = getConversationSurfacePolicy(surface);
  const active = model.mode === "active";
  const { rootRef, activityVisibility } = useWorkCellActivityVisibility(active);
  const singleAgentSpan = model.agentSpans.length === 1 ? model.agentSpans[0] : undefined;
  const visibleAgentSpans = model.agentSpans.length > 1 ? model.agentSpans : [];
  const singleAgentRows = singleAgentSpan?.rows ?? [];
  const fallbackRows: readonly ConversationWorkCellRow[] = model.operationRows.length === 0 && model.agentSpans.length === 0
    ? [{
      id: "operation:fallback",
      kind: "watch",
      title: model.title,
      description: model.summary && model.summary !== model.title ? model.summary : undefined,
      tone: active ? "running" : model.status === "succeeded" ? "success" : model.status === "failed" ? "failed" : "neutral",
    }]
    : [];
  const operationRows = model.operationRows.length > 0
    ? model.operationRows
    : singleAgentRows.length > 0
      ? singleAgentRows
      : fallbackRows;
  const operationItems = model.operationItems ?? projectConversationActivity(operationRows);
  const usingCanonicalTimeline = Boolean(model.typedTimelineItems && model.typedTimelineItems.length > 0);
  // A successful final agent message is the completion prose. TerminalReport is
  // retained as audit data and only appears inline when the turn needs attention.
  // Canonical typed items own the visible evidence rail. Keeping the legacy
  // summary/report shell beside it would create the duplicate completion block
  // that the Codex-style contract explicitly forbids.
  const terminalReportRendered = showTerminalReport && !usingCanonicalTimeline && model.terminalReportRows.length > 0 && (!suppressTerminalReport || model.status !== "succeeded");
  const reportOwnsChanges = terminalReportRendered && model.terminalReportRows.some((row) => row.reportSection === "change");
  const visibleOperationItems = reportOwnsChanges
    ? operationItems.filter((item) => item.kind !== "operation" || item.row.kind !== "edit")
    : operationItems;
  const statusLabel = model.kicker ?? workCellStatusLabel(model.status, active, t);
  const timelineItems = model.typedTimelineItems && model.typedTimelineItems.length > 0
    ? model.typedTimelineItems
    : buildTimelineItems(visibleOperationItems, visibleAgentSpans, model.turnId);
  const factOwnership = conversationWorkCellFactOwnership({ ...model, operationItems: visibleOperationItems, agentSpans: visibleAgentSpans });
  const visibleArtifactItems = showArtifactStrip && !usingCanonicalTimeline
    ? model.artifactStripItems.filter((item) => !artifactStripItemOwnedByTypedFact(item, factOwnership))
    : [];
  const artifactStripSummary = showArtifactStrip ? buildArtifactStripSummary(visibleArtifactItems, t) : undefined;
  const recoveryTarget = visibleArtifactItems.find((item) => item.kind === "changed")?.recoveryTarget;
  const referencesOnly = !showArtifactStrip;
  const evidenceSummary = model.terminalReportRows.length > 0
    ? buildReferenceSummary(model.evidenceLinks.length, t)
    : referencesOnly
    ? buildReferenceSummary(model.evidenceLinks.length, t)
    : artifactStripSummary ?? buildEvidenceSummary(model, t);
  const diagnosticsHandler = model.showDiagnostics === true && !referencesOnly && !evidenceSummary ? onOpenRun : undefined;
  const rootClassName = [
    "conversation-work-cell",
    "conversation-operation-cell",
    active ? "active" : "completed",
    `status-${model.status}`,
    "no-rail",
    model.presentation ? `presentation-${model.presentation}` : "",
  ].filter(Boolean).join(" ");
  const currentDetailsState: ConversationWorkCellDetailsState = referencesOnly
    ? {
      status: "loaded",
      groups: [],
      evidenceLinks: model.evidenceLinks,
    }
    : detailsState ?? {
      status: onLoadDetails ? "not_loaded" : "loaded",
      groups: model.groups,
      evidenceLinks: model.evidenceLinks,
    };
  const detailsDisclosure = useConversationBlockView({
    blockId: `operation-details:${model.id}`,
    revisionKey: operationBubbleRevisionKey(model, evidenceSummary),
    defaultExpanded: operationDetailsDefaultExpanded(model.status),
  });
  const detailsExpanded = Boolean(evidenceSummary && detailsDisclosure.expanded);
  useEffect(() => {
    if (detailsExpanded && currentDetailsState.status === "not_loaded") {
      onLoadDetails?.(model.threadId);
    }
  }, [currentDetailsState.status, detailsExpanded, model.threadId, onLoadDetails]);

  function toggleDetails(): void {
    const nextExpanded = !detailsExpanded;
    detailsDisclosure.setExpanded(nextExpanded);
    if (nextExpanded && (currentDetailsState.status === "not_loaded" || currentDetailsState.status === "error")) {
      onLoadDetails?.(model.threadId);
    }
  }

  const evidenceDisclosure = (
    <>
      {evidenceSummary ? (
        <button
          className={artifactStripSummary ? "conversation-work-cell-evidence-summary conversation-work-cell-artifact-strip" : "conversation-work-cell-evidence-summary"}
          type="button"
          onClick={toggleDetails}
          aria-expanded={detailsExpanded}
        >
          <ChevronDown size={14} aria-hidden="true" />
          <span>{evidenceSummary}</span>
        </button>
      ) : null}

      {diagnosticsHandler ? (
        <div className="conversation-work-cell-actions">
          <button
            className="secondary-button compact-button"
            type="button"
            onClick={() => diagnosticsHandler(model.anchorRunId)}
          >
            <History size={13} />
            {t("Diagnostics")}
          </button>
        </div>
      ) : null}

      {detailsExpanded ? (
        <WorkCellDetails
          state={currentDetailsState}
          turnId={model.turnId}
          cwd={cwd}
          loadPreview={loadPreview}
          showGroups={!referencesOnly}
          onOpenSourceRef={onOpenWorkspaceFile ? (ref) => {
            if ((ref.kind === "file" || ref.kind === "path") && ref.path) {
              onOpenWorkspaceFile({ cwd, path: ref.path, label: ref.label });
            }
          } : undefined}
          onRetry={() => onLoadDetails?.(model.threadId)}
        />
      ) : null}
    </>
  );

  return (
    <article
      ref={rootRef}
      className={rootClassName}
      data-thread-id={model.threadId}
      data-operation-source={model.sourceKind}
      data-work-cell-activity={activityVisibility}
      data-conversation-typed-transcript
      aria-label={statusLabel}
    >
      <span className="visually-hidden" role="status" aria-live="polite" aria-label={statusLabel} />
      <div className="conversation-work-cell-body conversation-typed-transcript-body">
        {timelineItems.length > 0 ? (
          <ActiveTurnItemStream
            items={timelineItems}
            cwd={cwd}
            loadPreview={loadPreview}
            policy={timelinePolicy}
            onOpenSourceRef={onOpenWorkspaceFile ? (ref) => {
              if ((ref.kind === "file" || ref.kind === "path") && ref.path) {
                onOpenWorkspaceFile({ cwd, path: ref.path, label: ref.label });
              }
            } : undefined}
            renderAgentAvatar={(item) => {
              if (renderParticipantAvatar) return renderParticipantAvatar(item.participantId, item.label);
              const span = visibleAgentSpans.find((candidate) => (candidate.participantId ?? candidate.id) === item.participantId);
              return span ? renderAgentAvatar?.(span) : undefined;
            }}
          />
        ) : null}
        {!terminalReportRendered && !usingCanonicalTimeline ? evidenceDisclosure : null}
      </div>
      {terminalReportRendered ? (
        <TerminalReportBlock
          blockId={model.id}
          rows={model.terminalReportRows}
          renderParticipantAvatar={renderParticipantAvatar}
          surface={surface}
          cwd={cwd}
          projectionPolicy={terminalReportProjectionPolicy}
          onOpenWorkspaceFile={onOpenWorkspaceFile ? (target) => onOpenWorkspaceFile({ ...target, cwd }) : undefined}
        />
      ) : null}
      {visibleArtifactItems.length > 0 ? (
        <ConversationArtifactStrip
          items={visibleArtifactItems}
          cwd={cwd}
          hideChangedFileDetails={reportOwnsChanges}
          recoveryTarget={recoveryTarget}
          loadPreview={loadPreview}
          onOpenWorkspaceReview={onOpenWorkspaceReview}
        />
      ) : null}
      {terminalReportRendered && (evidenceSummary || diagnosticsHandler || detailsExpanded) ? (
        <div className="conversation-work-cell-body conversation-work-cell-post-report-evidence">
          {evidenceDisclosure}
        </div>
      ) : null}
    </article>
  );
}

function ComposerGatePendingWorkCell({
  model,
  approval,
}: {
  readonly model: ConversationOperationCellViewModel;
  readonly approval: ComposerGateApprovalPresentation;
}): React.JSX.Element {
  const { t } = useI18n();
  const statusLabel = `${t("Waiting for approval")}: ${approval.actionSentence}`;
  return (
    <article
      className="conversation-work-cell conversation-operation-cell active status-waiting_for_approval no-rail presentation-composer-gate-pending"
      data-thread-id={model.threadId}
      data-operation-source={model.sourceKind}
      data-approval-presentation-owner="composer_gate"
      data-approval-id={approval.approvalId}
      aria-label={statusLabel}
    >
      <span className="visually-hidden" role="status" aria-live="polite">{statusLabel}</span>
      <div className="conversation-operation-shell conversation-operation-bubble active tone-waiting collapsed">
        <div className="conversation-operation-shell-static-content">
          <div className="conversation-composer-gate-approval-marker">
            <CircleAlert aria-hidden="true" size={15} />
            <strong>{t("Waiting for approval")}</strong>
            <span>{approval.actionSentence}</span>
          </div>
        </div>
      </div>
    </article>
  );
}

export function ConversationArtifactStripPanel({
  items,
  cwd,
  recoveryTarget,
  loadPreview,
  onOpenWorkspaceReview,
}: {
  readonly items: readonly ConversationArtifactStripItem[];
  readonly cwd?: string;
  readonly recoveryTarget?: ConversationArtifactStripItem["recoveryTarget"];
  readonly loadPreview: ArtifactPreviewLoader;
  readonly onOpenWorkspaceReview?: (target: ConversationWorkspaceReviewTarget) => void;
}): React.JSX.Element | null {
  const visibleItems = items.filter((item) => item.kind === "artifact" || item.kind === "changed");
  if (visibleItems.length === 0) {
    return null;
  }
  return (
    <ConversationArtifactStrip
      items={visibleItems}
      cwd={cwd}
      recoveryTarget={recoveryTarget}
      loadPreview={loadPreview}
      onOpenWorkspaceReview={onOpenWorkspaceReview}
    />
  );
}

function buildArtifactStripSummary(items: readonly ConversationArtifactStripItem[], t: Translate): string | undefined {
  if (items.length === 0) {
    return undefined;
  }
  const artifactCount = items.filter((item) => item.kind === "artifact").length;
  const changedItem = items.find((item) => item.kind === "changed");
  const checkedItem = items.find((item) => item.kind === "checked");
  const attentionItem = items.find((item) => item.kind === "attention");
  const approvalItem = items.find((item) => item.kind === "approval");
  const pieces = [
    artifactCount > 0 ? (artifactCount === 1 ? t("1 artifact") : t("{count} artifacts", { count: artifactCount })) : undefined,
    changedItem?.label,
    checkedItem?.label,
    attentionItem?.label,
    approvalItem?.label,
  ].filter((piece): piece is string => Boolean(piece));
  return pieces.join(" · ");
}

function buildEvidenceSummary(model: ConversationOperationCellViewModel, t: Translate): string | undefined {
  const changedCount = model.groups.find((group) => group.id === "changed")?.rows.length ?? 0;
  const checkedCount = model.groups.find((group) => group.id === "checked")?.rows.length ?? 0;
  const evidenceCount = model.groups.find((group) => group.id === "evidence")?.rows.length ?? 0;
  const attentionCount = model.groups.find((group) => group.id === "attention")?.rows.length ?? 0;
  const approvalStat = model.stats.find((stat) => stat.id === "approvals");
  const approvalCount = approvalStat ? Number.parseInt(approvalStat.value, 10) : 0;
  const pieces: string[] = [];

  if (attentionCount > 0) {
    pieces.push(t("{count} attention items", { count: attentionCount }));
  }
  if (approvalCount > 0) {
    pieces.push(t("{count} approvals", { count: approvalCount }));
  }
  if (changedCount > 0) {
    pieces.push(t("{count} changed items", { count: changedCount }));
  }
  if (checkedCount > 0) {
    pieces.push(t("{count} checks", { count: checkedCount }));
  }
  if (pieces.length === 0 && evidenceCount > 0) {
    pieces.push(t("{count} records", { count: evidenceCount }));
  }
  if (model.evidenceLinks.length > 0) {
    pieces.push(t("{count} references", { count: model.evidenceLinks.length }));
  }

  return pieces.length > 0 ? pieces.join(" · ") : undefined;
}

function buildReferenceSummary(referenceCount: number, t: Translate): string | undefined {
  if (referenceCount === 1) {
    return t("1 reference");
  }
  return referenceCount > 1 ? t("{count} references", { count: referenceCount }) : undefined;
}

function operationShellTone(status: ConversationOperationCellViewModel["status"], active: boolean): "running" | "waiting" | "success" | "failed" | "neutral" {
  if (status === "waiting_for_approval") {
    return "waiting";
  }
  if (status === "failed" || status === "blocked") {
    return "failed";
  }
  if (status === "cancelled" || status === "superseded") {
    return "neutral";
  }
  if (status === "succeeded") {
    return "success";
  }
  return active ? "running" : "neutral";
}

function operationShellStatusLabel(
  model: ConversationOperationCellViewModel,
  active: boolean,
  t: Translate,
): string {
  const elapsed = formatElapsedDuration(model.elapsedMs);
  const suffix = elapsed ? ` ${elapsed}` : "";
  if (model.status === "succeeded") {
    const activitySummary = completedActivitySummary(model, t);
    if (activitySummary) {
      return activitySummary;
    }
    return t("Processed{duration}", { duration: suffix });
  }
  if (model.status === "failed") {
    return t("Failed{duration}", { duration: suffix });
  }
  if (model.status === "blocked") {
    return t("Blocked");
  }
  if (model.status === "waiting_for_approval") {
    return t("Waiting for approval");
  }
  if (model.status === "cancelled" || model.status === "superseded") {
    return t("Stopped{duration}", { duration: suffix });
  }
  return active ? t("Processing") : t("Processed{duration}", { duration: suffix });
}

function completedActivitySummary(
  model: ConversationOperationCellViewModel,
  t: Translate,
): string | undefined {
  if (model.mode !== "completed" || !model.activitySummary?.hasStructuredActions) {
    return undefined;
  }
  const summary = model.activitySummary;
  const pieces = [
    summary.editedFileCount > 0
      ? summary.editedFileCount === 1
        ? t("Edited 1 file")
        : t("Edited {count} files", { count: summary.editedFileCount })
      : undefined,
    summary.readItemCount > 0
      ? summary.readItemCount === 1
        ? t("Read 1 item")
        : t("Read {count} items", { count: summary.readItemCount })
      : undefined,
    summary.commandCount > 0
      ? summary.commandCount === 1
        ? t("Ran 1 command")
        : t("Ran {count} commands", { count: summary.commandCount })
      : undefined,
  ].filter((piece): piece is string => Boolean(piece));
  return pieces.length > 0 ? pieces.join(" · ") : undefined;
}

function formatElapsedDuration(elapsedMs: number | undefined): string | undefined {
  if (!elapsedMs || elapsedMs < 1000) {
    return undefined;
  }
  const totalSeconds = Math.max(1, Math.round(elapsedMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

function operationBubbleRevisionKey(
  model: ConversationOperationCellViewModel,
  evidenceSummary: string | undefined,
): string {
  return [
    model.updatedAt,
    model.status,
    model.operationRows.length,
    model.agentSpans.length,
    model.artifactStripItems.length,
    evidenceSummary ?? "",
    activitySummaryRevisionKey(model),
    operationItemsRevisionKey(model.operationItems),
  ].join("|");
}

function operationShellViewKey(operationId: string): string {
  return `operation-shell:${operationId}`;
}

function operationShellRevisionKey(
  model: ConversationOperationCellViewModel,
  active: boolean,
): string {
  return [
    model.updatedAt,
    model.status,
    active ? "active" : "completed",
    model.operationRows.length,
    model.agentSpans.length,
    model.artifactStripItems.length,
    activitySummaryRevisionKey(model),
    operationItemsRevisionKey(model.operationItems),
  ].join("|");
}

function activitySummaryRevisionKey(model: ConversationOperationCellViewModel): string {
  const summary = model.activitySummary;
  return summary
    ? [summary.editedFileCount, summary.editedItemCount, summary.readItemCount, summary.commandCount, summary.hasStructuredActions ? "structured" : "plain"].join(":")
    : "";
}

function operationItemsRevisionKey(items: readonly ConversationWorkCellItem[] | undefined): string {
  if (!items) {
    return "";
  }
  return items.map((item) => {
    if (item.kind === "operation") {
      const execution = item.row.operationExecution;
      return `operation:${item.row.id}:${execution?.actionId ?? ""}:${execution?.status ?? ""}:${execution?.updatedAt ?? ""}`;
    }
    return `${item.kind}:${item.batch.id}:${item.batch.revisionKey}`;
  }).join("|");
}

function operationShellExpandable(
  status: ConversationOperationCellViewModel["status"],
  active: boolean,
): boolean {
  if (active) {
    return false;
  }
  return status === "succeeded" || status === "cancelled" || status === "superseded";
}

function operationDetailsDefaultExpanded(status: ConversationOperationCellViewModel["status"]): boolean {
  return status === "waiting_for_approval" || status === "blocked" || status === "failed";
}

function buildTimelineItems(
  operationItems: readonly ConversationWorkCellItem[],
  spans: readonly ConversationAgentActivitySpan[],
  turnId: string | undefined,
): readonly ConversationTimelineItem[] {
  return projectConversationWorkCellTimeline({ operationItems, agentSpans: spans, turnId });
}

function workCellStatusLabel(
  status: ConversationOperationCellViewModel["status"],
  active: boolean,
  t: Translate,
): string {
  if (status === "succeeded") {
    return t("Task completed");
  }
  if (status === "failed") {
    return t("Task failed");
  }
  if (status === "cancelled" || status === "superseded") {
    return t("Task cancelled");
  }
  if (status === "blocked") {
    return t("Task blocked");
  }
  if (status === "waiting_for_approval") {
    return t("Task waiting for approval");
  }
  return active ? t("Task in progress") : t("Work result");
}

function WorkCellDetails({
  state,
  turnId,
  cwd,
  loadPreview,
  showGroups,
  onOpenSourceRef,
  onRetry,
}: {
  readonly state: ConversationWorkCellDetailsState;
  readonly turnId?: string;
  readonly cwd?: string;
  readonly loadPreview: ArtifactPreviewLoader;
  readonly showGroups: boolean;
  readonly onOpenSourceRef?: (ref: ConversationOperationSourceRef) => void;
  readonly onRetry: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  if (state.status === "not_loaded") {
    return (
      <div className="conversation-work-cell-details">
        <div className="conversation-work-cell-details-state">
          <Loader2 className="spin" size={13} />
          <span>{t("Loading details...")}</span>
        </div>
      </div>
    );
  }
  if (state.status === "loading") {
    return (
      <div className="conversation-work-cell-details">
        <div className="conversation-work-cell-details-state">
          <Loader2 className="spin" size={13} />
          <span>{t("Loading details...")}</span>
        </div>
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div className="conversation-work-cell-details">
        <div className="conversation-work-cell-details-state failed">
          <CircleAlert size={13} />
          <span>{state.errorMessage || t("Evidence failed to load.")}</span>
          <button className="secondary-button compact-button" type="button" onClick={onRetry}>
            <RefreshCw size={13} />
            {t("Retry evidence")}
          </button>
        </div>
      </div>
    );
  }

  const groups = showGroups ? state.groups ?? [] : [];
  const visibleGroups = groups.filter((group) => group.rows.length > 0);
  const evidenceLinks = state.evidenceLinks ?? [];
  const empty = state.status === "empty" || (visibleGroups.length === 0 && evidenceLinks.length === 0);
  return (
    <div className="conversation-work-cell-details">
      {empty ? (
        <div className="conversation-work-cell-details-state">
          <FileText size={13} />
          <span>{t("No evidence captured yet.")}</span>
        </div>
      ) : null}
      {visibleGroups.map((group) => (
        <section key={group.id} className={`conversation-work-cell-group ${group.id}`} aria-label={group.label}>
          <header>
            <strong>{group.label}</strong>
            <small>{group.summary}</small>
          </header>
          <ConversationTimeline
            items={projectConversationTimelineItems(group.rows, { turnId })}
            policy={getConversationSurfacePolicy("run_thread")}
            className="conversation-work-cell-details-timeline"
            dataDensity={group.rows.length > 10 ? "dense" : "default"}
            ariaLabel={group.label}
            cwd={cwd}
            loadPreview={loadPreview}
            onOpenSourceRef={onOpenSourceRef}
            renderMessage={(markdown) => <MessageBodyRenderer text={markdown} cwd={cwd} compact />}
          />
        </section>
      ))}
      {evidenceLinks.length > 0 ? (
        <div className="conversation-work-cell-evidence-links" aria-label={t("Evidence links")}>
          {evidenceLinks.map((link) => (
            link.href ? (
              <a key={link.id} href={link.href} target="_blank" rel="noreferrer">
                <FileText size={13} />
                <span>{link.label}</span>
                {link.meta ? <small>{link.meta}</small> : null}
              </a>
            ) : (
              <span key={link.id}>
                <FileText size={13} />
                <span>{link.label}</span>
                {link.meta ? <small>{link.meta}</small> : null}
              </span>
            )
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ActiveTurnItemStream({
  items,
  cwd,
  loadPreview,
  policy,
  onOpenSourceRef,
  renderAgentAvatar,
}: {
  readonly items: readonly ConversationTimelineItem[];
  readonly cwd?: string;
  readonly loadPreview: ArtifactPreviewLoader;
  readonly policy: import("../tokens/conversation-surface-policy.js").ConversationSurfacePolicy;
  readonly onOpenSourceRef?: (ref: ConversationOperationSourceRef) => void;
  readonly renderAgentAvatar?: (item: ConversationTimelineSubAgentItem) => ReactNode;
}): React.JSX.Element {
  const { t } = useI18n();
  const className = "conversation-work-cell-active-stream";
  const atomicItemCount = countTimelineItems(items);
  const density = atomicItemCount > 10 ? "dense" : "default";
  if (items.length === 0) {
    return <ConversationTimeline
      items={items}
      policy={policy}
      className={className}
      dataDensity={density}
      ariaLabel={t("Active work stream")}
      emptyLabel={<><Clock3 size={13} /><span>{t("Waiting for activity")}</span></>}
      cwd={cwd}
      loadPreview={loadPreview}
      onOpenSourceRef={onOpenSourceRef}
      renderMessage={(markdown) => <MessageBodyRenderer text={markdown} cwd={cwd} compact />}
      renderSubAgentAvatar={renderAgentAvatar}
    />;
  }
  return (
    <ConversationTimeline
      items={items}
      policy={policy}
      className={className}
      dataDensity={density}
    ariaLabel={t("Active work stream")}
      cwd={cwd}
      loadPreview={loadPreview}
      onOpenSourceRef={onOpenSourceRef}
      renderMessage={(markdown) => <MessageBodyRenderer text={markdown} cwd={cwd} compact />}
      renderSubAgentAvatar={renderAgentAvatar}
    />
  );
}

function countTimelineItems(items: readonly ConversationTimelineItem[]): number {
  return items.reduce((count, item) => {
    if (item.kind === "commandBatch") {
      return count + item.batch.commands.reduce((childCount, command) => childCount + 1 + (command.leadingItems?.length ?? 0), 0);
    }
    if (item.kind === "explorationBatch") return count + item.batch.children.length;
    if (item.kind === "subAgentActivity") return count + 1 + countTimelineItems(item.childItems);
    return count + 1;
  }, 0);
}
