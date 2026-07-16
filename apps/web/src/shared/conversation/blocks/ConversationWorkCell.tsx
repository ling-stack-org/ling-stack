import { useEffect, useRef, useState, type ReactNode } from "react";
import { BookOpen, CheckCircle2, ChevronDown, CircleAlert, Clock3, FilePenLine, FileText, GitBranch, History, ListChecks, Loader2, RefreshCw, Search, ShieldCheck, SquareTerminal } from "lucide-react";
import { useI18n, type Translate } from "../../../i18n.js";
import { parseUnifiedDiff, summarizeFileChanges, type ConversationFileChange } from "../../../lib/diff-summary.js";
import { projectConversationCommandBatches, type ConversationAgentActivitySpan, type ConversationArtifactStripItem, type ConversationCommandBatchItem, type ConversationOperationCellViewModel, type ConversationWorkCellEvidenceLink, type ConversationWorkCellGroup, type ConversationWorkCellItem, type ConversationWorkCellRow, type ConversationWorkCellRowDetailLine } from "../../../lib/conversation-work-cell.js";
import type { PreviewContentResponse } from "../../../types.js";
import type { ArtifactPreviewLoader } from "../preview/ArtifactPreviewDrawer.js";
import type { ConversationSurfaceKind, TerminalReportProjectionPolicy } from "../tokens/conversation-surface-policy.js";
import { ConversationArtifactStrip, type ConversationWorkspaceReviewTarget } from "./ConversationArtifactStrip.js";
import { ConversationCommandBatch } from "./ConversationCommandBatch.js";
import { DiffViewer } from "./DiffViewer.js";
import { TerminalReportBlock, type TerminalReportFileTarget } from "./TerminalReportBlock.js";
import { useConversationBlockView } from "../view-store/use-conversation-block-view.js";

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
  readonly terminalReportProjectionPolicy?: Partial<TerminalReportProjectionPolicy>;
  readonly onOpenWorkspaceFile?: (target: TerminalReportFileTarget) => void;
  readonly onOpenWorkspaceReview?: (target: ConversationWorkspaceReviewTarget) => void;
}

export function ConversationWorkCell({
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
  terminalReportProjectionPolicy,
  onOpenWorkspaceFile,
  onOpenWorkspaceReview,
}: ConversationWorkCellProps): JSX.Element {
  const { t } = useI18n();
  const active = model.mode === "active";
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
  const operationItems = model.operationItems ?? projectConversationCommandBatches(operationRows);
  const showOperationRows = operationItems.length > 0;
  const terminalReportRendered = showTerminalReport && model.terminalReportRows.length > 0;
  const statusLabel = model.kicker ?? workCellStatusLabel(model.status, active, t);
  const artifactStripSummary = showArtifactStrip ? buildArtifactStripSummary(model.artifactStripItems, t) : undefined;
  const visibleArtifactItems = showArtifactStrip
    ? model.artifactStripItems.filter((item) => item.kind === "artifact" || item.kind === "changed")
    : [];
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
  const shellExpandable = operationShellExpandable(model.status, active);
  const shellDisclosure = useConversationBlockView({
    blockId: operationShellViewKey(model.id),
    revisionKey: operationShellRevisionKey(model, active),
    defaultExpanded: !shellExpandable,
  });
  const shellExpanded = !shellExpandable || shellDisclosure.expanded;
  const shellStatusLabel = operationShellStatusLabel(model, active, t);
  const shellClassName = [
    "conversation-operation-shell",
    "conversation-operation-bubble",
    active ? "active" : "completed",
    `tone-${operationShellTone(model.status, active)}`,
    shellExpandable ? "expandable" : "",
    shellExpanded ? "expanded" : "collapsed",
  ].filter(Boolean).join(" ");

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
          cwd={cwd}
          loadPreview={loadPreview}
          showGroups={!referencesOnly}
          onRetry={() => onLoadDetails?.(model.threadId)}
        />
      ) : null}
    </>
  );

  return (
    <article className={rootClassName} data-thread-id={model.threadId} data-operation-source={model.sourceKind} aria-label={statusLabel}>
      <span className="visually-hidden" role="status" aria-live="polite" aria-label={statusLabel} />
      <div className={shellClassName} aria-label={statusLabel}>
        {shellExpandable ? (
          <button
            className="conversation-operation-shell-head conversation-operation-bubble-header"
            type="button"
            aria-expanded={shellExpanded}
            aria-label={shellExpanded ? t("Collapse operation") : t("Expand operation")}
            onClick={shellDisclosure.toggleExpanded}
          >
            <span className="conversation-operation-shell-toggle conversation-operation-bubble-toggle" aria-hidden="true">
              <ChevronDown size={13} />
            </span>
            <span className="conversation-operation-shell-status conversation-operation-bubble-status">{shellStatusLabel}</span>
          </button>
        ) : null}
        {shellExpanded ? (
          <div className="conversation-operation-shell-body conversation-operation-bubble-body">
          <div className="conversation-work-cell-body">
            {visibleAgentSpans.length > 0 ? (
              <AgentActivitySpans
                spans={visibleAgentSpans}
                cwd={cwd}
                loadPreview={loadPreview}
                renderAgentAvatar={renderAgentAvatar}
              />
            ) : null}

            {showOperationRows ? (
              <ActiveTurnItemStream items={operationItems} cwd={cwd} loadPreview={loadPreview} />
            ) : null}
            {!terminalReportRendered ? evidenceDisclosure : null}
          </div>
          </div>
        ) : null}
      </div>
      {terminalReportRendered ? (
        <TerminalReportBlock
          blockId={model.id}
          rows={model.terminalReportRows}
          renderParticipantAvatar={renderParticipantAvatar}
          surface={surface}
          projectionPolicy={terminalReportProjectionPolicy}
          onOpenWorkspaceFile={onOpenWorkspaceFile ? (target) => onOpenWorkspaceFile({ ...target, cwd }) : undefined}
        />
      ) : null}
      {visibleArtifactItems.length > 0 ? (
        <ConversationArtifactStrip
          items={visibleArtifactItems}
          cwd={cwd}
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
}): JSX.Element | null {
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
  ].join("|");
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

function AgentActivitySpans({
  spans,
  cwd,
  loadPreview,
  renderAgentAvatar,
}: {
  readonly spans: readonly ConversationAgentActivitySpan[];
  readonly cwd?: string;
  readonly loadPreview: ArtifactPreviewLoader;
  readonly renderAgentAvatar?: (span: ConversationAgentActivitySpan) => ReactNode;
}): JSX.Element {
  const { t } = useI18n();
  return (
    <section className="conversation-work-cell-agent-spans" aria-label={t("Agent activity")}>
      <div className="conversation-work-cell-agent-span-list">
        {spans.map((span) => (
          <AgentActivitySpanItem
            key={span.id}
            span={span}
            cwd={cwd}
            loadPreview={loadPreview}
            renderAgentAvatar={renderAgentAvatar}
          />
        ))}
      </div>
    </section>
  );
}

function AgentActivitySpanItem({
  span,
  cwd,
  loadPreview,
  renderAgentAvatar,
}: {
  readonly span: ConversationAgentActivitySpan;
  readonly cwd?: string;
  readonly loadPreview: ArtifactPreviewLoader;
  readonly renderAgentAvatar?: (span: ConversationAgentActivitySpan) => ReactNode;
}): JSX.Element {
  const { t } = useI18n();
  const items = span.items ?? projectConversationCommandBatches(span.rows, { participantScope: span.participantId ?? span.id });
  const hasDetail = items.length > 0;
  const avatar = renderAgentAvatar?.(span);
  const headContent = (
    <>
      <span className="conversation-work-cell-agent-avatar" aria-hidden="true">
        {avatar ?? agentAvatarLabel(span.label)}
      </span>
      <span className="conversation-work-cell-agent-span-copy">
        <strong>{span.label}</strong>
      </span>
      {span.stateLabel ? <span className="conversation-work-cell-agent-span-state">{span.stateLabel}</span> : null}
    </>
  );
  return (
    <div
      className={["conversation-work-cell-agent-span", `kind-${span.kind ?? "agent"}`, span.tone ?? "neutral"].filter(Boolean).join(" ")}
      data-agent-span-kind={span.kind ?? "agent"}
      data-agent-participant-id={span.participantId}
    >
      <div className="conversation-work-cell-agent-span-head">
        {headContent}
      </div>
      {hasDetail ? (
        <div className="conversation-work-cell-agent-span-detail" aria-label={t("Agent activity detail")}>
          <ActiveTurnItemStream items={items} cwd={cwd} loadPreview={loadPreview} />
        </div>
      ) : null}
    </div>
  );
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
  cwd,
  loadPreview,
  showGroups,
  onRetry,
}: {
  readonly state: ConversationWorkCellDetailsState;
  readonly cwd?: string;
  readonly loadPreview: ArtifactPreviewLoader;
  readonly showGroups: boolean;
  readonly onRetry: () => void;
}): JSX.Element {
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
          <div className="conversation-work-cell-row-list">
            {group.rows.map((row) => (
              <WorkCellRow key={row.id} row={row} showIcon={false} cwd={cwd} loadPreview={loadPreview} />
            ))}
          </div>
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
}: {
  readonly items: readonly ConversationWorkCellItem[];
  readonly cwd?: string;
  readonly loadPreview: ArtifactPreviewLoader;
}): JSX.Element {
  const { t } = useI18n();
  if (items.length === 0) {
    return (
      <div className="conversation-work-cell-active-stream empty">
        <Clock3 size={13} />
        <span>{t("Waiting for activity")}</span>
      </div>
    );
  }
  return (
    <div className="conversation-work-cell-active-stream" aria-label={t("Active work stream")}>
      {items.map((item) => item.kind === "command_batch" ? (
        <ConversationCommandBatch
          key={item.batch.id}
          batch={item.batch}
          renderCommand={(command) => (
            <WorkCellRow
              key={command.id}
              row={commandBatchRow(command)}
              compact
              cwd={cwd}
              loadPreview={loadPreview}
            />
          )}
        />
      ) : (
        <WorkCellRow key={item.row.id} row={item.row} compact cwd={cwd} loadPreview={loadPreview} />
      ))}
    </div>
  );
}

function WorkCellRow({
  row,
  compact = false,
  showIcon = true,
  cwd,
  loadPreview,
}: {
  readonly row: ConversationWorkCellRow;
  readonly compact?: boolean;
  readonly showIcon?: boolean;
  readonly cwd?: string;
  readonly loadPreview?: ArtifactPreviewLoader;
}): JSX.Element {
  const [expanded, setExpanded] = useState(row.commandExecution?.status === "executing");
  const previousCommandStatusRef = useRef(row.commandExecution?.status);
  const [changePreview, setChangePreview] = useState<InlineChangePreviewState>({ status: "idle", changes: [] });
  const displayDescription = displayableRowDescription(row.title, row.description);
  const displayMeta = displayableRowMeta(row.meta);
  const baseDetailLines = displayableRowDetailLines(row.detailLines);
  const shellCommand = row.presentation === "shell" ? shellCommandText(row, baseDetailLines) : undefined;
  const detailLines = shellCommand
    ? baseDetailLines.filter((line) => stripShellPrompt(line.text) !== shellCommand)
    : baseDetailLines;
  const changeSummary = changePreview.status === "loaded" && !changePreview.truncated
    ? summarizeFileChanges(changePreview.changes)
    : undefined;
  const hasDetail = Boolean(shellCommand || displayDescription || detailLines.length > 0 || changePreview.changes.length > 0);
  const showRowIcon = showIcon && row.presentation !== "note";
  const rowClassName = [
    "conversation-work-cell-row",
    row.presentation === "shell" ? "shell" : "",
    row.commandExecution ? "command-execution" : "",
    row.presentation === "note" ? "note" : "",
    row.tone ?? "neutral",
    compact ? "compact" : "",
    showRowIcon ? "" : "iconless",
    expanded ? "expanded" : "",
  ].filter(Boolean).join(" ");

  useEffect(() => {
    const currentStatus = row.commandExecution?.status;
    const previousStatus = previousCommandStatusRef.current;
    if (currentStatus === "executing" && previousStatus !== "executing") {
      setExpanded(true);
    } else if (previousStatus === "executing" && currentStatus !== "executing") {
      setExpanded(false);
    }
    previousCommandStatusRef.current = currentStatus;
  }, [row.commandExecution?.actionId, row.commandExecution?.status]);

  useEffect(() => {
    const preview = row.changePreview;
    if (!preview || !cwd || !loadPreview) {
      setChangePreview({ status: "idle", changes: [] });
      return;
    }
    let cancelled = false;
    setChangePreview({ status: "loading", changes: [] });
    void loadPreview({
      source: "artifact",
      cwd,
      artifactId: preview.artifactId,
      maxBytes: 64 * 1024,
    }).then((response) => {
      if (cancelled) {
        return;
      }
      setChangePreview(inlineChangePreviewState(response, preview.path, preview.artifactId));
    }, () => {
      if (!cancelled) {
        setChangePreview({ status: "error", changes: [] });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [cwd, loadPreview, row.changePreview?.artifactId, row.changePreview?.path]);

  const rowMain = (
    <>
      {showRowIcon ? (
        <span className="conversation-work-cell-row-icon" aria-hidden="true">
          <WorkCellRowIcon kind={row.kind} tone={row.tone ?? "neutral"} />
        </span>
      ) : null}
      <span className="conversation-work-cell-row-copy">
        <strong>{row.title}</strong>
        {changeSummary ? (
          <span className="conversation-work-cell-change-stat" aria-label={`+${changeSummary.additions} -${changeSummary.deletions}`}>
            <span className="add">+{changeSummary.additions}</span>
            <span className="delete">-{changeSummary.deletions}</span>
          </span>
        ) : null}
        {displayMeta ? <small>{displayMeta}</small> : null}
      </span>
      {hasDetail ? (
        <span className="conversation-work-cell-row-toggle" aria-hidden="true">
          <ChevronDown size={13} />
        </span>
      ) : null}
    </>
  );
  return (
    <div className={rowClassName}>
      {hasDetail ? (
        <button
          className="conversation-work-cell-row-main"
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {rowMain}
        </button>
      ) : (
        <div className="conversation-work-cell-row-main static">
          {rowMain}
        </div>
      )}
      {expanded && hasDetail ? (
        <div className={row.presentation === "shell" ? "conversation-work-cell-row-detail conversation-work-cell-shell-detail" : "conversation-work-cell-row-detail"}>
          {shellCommand ? <code className="conversation-work-cell-shell-command">$ {shellCommand}</code> : null}
          {displayDescription ? <small>{displayDescription}</small> : null}
          {detailLines.map((line, index) => (
            line.kind === "code"
              ? <code key={`${line.kind}:${index}`}>{line.text}</code>
              : <small key={`${line.kind ?? "text"}:${index}`}>{line.text}</small>
          ))}
          {changePreview.changes.length > 0 ? (
            <InlineChangePreview changes={changePreview.changes} />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function commandBatchRow(command: ConversationCommandBatchItem): ConversationWorkCellRow {
  const commandText = stripShellPrompt(command.commandText) ?? command.commandText;
  const detailLines = (command.row.detailLines ?? []).filter((line) => stripShellPrompt(line.text) !== commandText);
  const meta = [
    command.exitCode !== undefined ? `exit ${command.exitCode}` : undefined,
    formatCompactCommandDuration(command.durationMs),
  ].filter((value): value is string => Boolean(value)).join(" · ");
  return {
    ...command.row,
    id: command.id,
    title: commandText,
    description: undefined,
    commandText: undefined,
    commandExecution: undefined,
    detailLines,
    meta: meta || undefined,
  };
}

function formatCompactCommandDuration(durationMs: number | undefined): string | undefined {
  if (durationMs === undefined || durationMs < 0) {
    return undefined;
  }
  if (durationMs < 1000) {
    return `${Math.max(1, Math.round(durationMs))}ms`;
  }
  const seconds = durationMs / 1000;
  return seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`;
}

interface InlineChangePreviewState {
  readonly status: "idle" | "loading" | "loaded" | "error";
  readonly changes: readonly ConversationFileChange[];
  readonly truncated?: boolean;
}

function inlineChangePreviewState(
  response: PreviewContentResponse,
  fallbackPath: string | undefined,
  artifactId: string,
): InlineChangePreviewState {
  if (response.kind !== "diff" || !response.text?.trim()) {
    return { status: "error", changes: [] };
  }
  return {
    status: "loaded",
    changes: parseUnifiedDiff(response.text, {
      idPrefix: `work-cell:${artifactId}`,
      fallbackPath: fallbackPath || response.ref.displayPath || response.ref.label || "change.diff",
      status: "completed",
      artifactId,
    }),
    truncated: response.truncated,
  };
}

function InlineChangePreview({ changes }: { readonly changes: readonly ConversationFileChange[] }): JSX.Element {
  const visibleChanges = changes.slice(0, 2);
  return (
    <div className="conversation-work-cell-change-preview">
      {visibleChanges.map((change) => (
        <section className="conversation-work-cell-change-preview-file" key={change.id}>
          {changes.length > 1 ? (
            <div className="conversation-work-cell-change-preview-file-head">
              <code>{change.path}</code>
              <span>+{change.additions ?? 0} -{change.deletions ?? 0}</span>
            </div>
          ) : null}
          <DiffViewer change={change} maxCollapsedLines={12} showFoldMarkers={false} />
        </section>
      ))}
    </div>
  );
}

function shellCommandText(
  row: ConversationWorkCellRow,
  detailLines: readonly ConversationWorkCellRowDetailLine[],
): string | undefined {
  const command = stripShellPrompt(row.commandText);
  if (command) {
    return command;
  }
  const detailCommand = detailLines.find((line) => line.kind === "code" && line.text.trim().startsWith("$ "))?.text;
  return stripShellPrompt(detailCommand);
}

function stripShellPrompt(value?: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.replace(/^\$\s*/u, "").trim() || undefined;
}

function displayableRowDetailLines(lines?: readonly ConversationWorkCellRowDetailLine[]): readonly ConversationWorkCellRowDetailLine[] {
  if (!lines || lines.length === 0) {
    return [];
  }
  const result: ConversationWorkCellRowDetailLine[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const text = line.text.trim();
    if (!text || isLowSignalRowMeta(text) || seen.has(text)) {
      continue;
    }
    seen.add(text);
    result.push(line.kind === "file_ref" ? { ...line, text } : { kind: line.kind, text });
    if (result.length >= 5) {
      break;
    }
  }
  return result;
}

function displayableRowDescription(title: string, description?: string): string | undefined {
  const trimmed = description?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (sameVisibleRowText(title, trimmed)) {
    return undefined;
  }
  return trimmed;
}

function displayableRowMeta(meta?: string): string | undefined {
  const trimmed = meta?.trim();
  if (!trimmed || isLowSignalRowMeta(trimmed)) {
    return undefined;
  }
  return trimmed;
}

function sameVisibleRowText(title: string, description: string): boolean {
  const normalizedTitle = normalizeVisibleRowText(title);
  const normalizedDescription = normalizeVisibleRowText(description);
  return normalizedTitle === normalizedDescription || normalizedTitle.endsWith(` ${normalizedDescription}`);
}

function normalizeVisibleRowText(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^[^:：]{1,32}\s*[:：]\s*/u, "")
    .replace(/[。.!！?？]+$/u, "")
    .replace(/\s+/gu, " ");
}

function isLowSignalRowMeta(value: string): boolean {
  return /^(file|diff|json|log|artifact|text|markdown|patch|succeeded|completed|success)$/iu.test(value) ||
    /^(text\/|application\/json|text\/x-diff)/iu.test(value) ||
    /\.jsonl?$/iu.test(value) ||
    /\.log$/iu.test(value);
}

function agentAvatarLabel(label: string): string {
  const normalized = label.trim();
  if (!normalized) {
    return "A";
  }
  if (/^[\x00-\x7F]+$/.test(normalized)) {
    const words = normalized.split(/[\s._-]+/u).filter(Boolean);
    if (words.length > 1) {
      return words.slice(0, 2).map((word) => word[0]?.toUpperCase() ?? "").join("") || "A";
    }
    const compact = normalized.replace(/[^A-Za-z0-9]/g, "");
    return compact.length <= 2 ? compact.toUpperCase() : compact[0]?.toUpperCase() ?? "A";
  }
  return Array.from(normalized)[0] ?? "A";
}

function WorkCellRowIcon({
  kind,
  tone,
}: {
  readonly kind: ConversationWorkCellRow["kind"];
  readonly tone: ConversationWorkCellRow["tone"] | "neutral";
}): JSX.Element {
  if (tone === "failed") {
    return <CircleAlert size={13} />;
  }
  if (tone === "waiting" || kind === "approval") {
    return <ShieldCheck size={13} />;
  }
  if (kind === "read") {
    return <BookOpen size={13} />;
  }
  if (kind === "edit") {
    return <FilePenLine size={13} />;
  }
  if (kind === "run_command") {
    return <SquareTerminal size={13} />;
  }
  if (kind === "search") {
    return <Search size={13} />;
  }
  if (kind === "verify") {
    return <CheckCircle2 size={13} />;
  }
  if (kind === "handoff") {
    return <GitBranch size={13} />;
  }
  if (kind === "plan") {
    return <ListChecks size={13} />;
  }
  return <Clock3 size={13} />;
}
