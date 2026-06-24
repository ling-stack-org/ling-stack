import { useEffect, useMemo, useState, type ReactNode } from "react";
import { CheckCircle2, ChevronDown, CircleAlert, Clock3, Eye, FileText, History, Image as ImageIcon, Loader2, RefreshCw, ShieldCheck } from "lucide-react";
import { useI18n, type Translate } from "../../../i18n.js";
import type { ConversationAgentActivitySpan, ConversationArtifactStripItem, ConversationOperationCellViewModel, ConversationWorkCellEvidenceLink, ConversationWorkCellGroup, ConversationWorkCellRow } from "../../../lib/conversation-work-cell.js";
import { ArtifactPreviewDrawer, type ArtifactPreviewLoader } from "../preview/ArtifactPreviewDrawer.js";
import { CopyActionButton } from "../feedback/CopyActionButton.js";

export type ConversationWorkCellDetailsStatus = "not_loaded" | "loading" | "loaded" | "empty" | "error";

export interface ConversationWorkCellDetailsState {
  readonly status: ConversationWorkCellDetailsStatus;
  readonly groups?: readonly ConversationWorkCellGroup[];
  readonly evidenceLinks?: readonly ConversationWorkCellEvidenceLink[];
  readonly errorMessage?: string;
}

export interface ConversationWorkCellProps {
  readonly model: ConversationOperationCellViewModel;
  readonly cwd?: string;
  readonly detailsState?: ConversationWorkCellDetailsState;
  readonly onOpenRun?: (runId: string) => void;
  readonly onLoadDetails?: (threadId: string) => void;
  readonly loadPreview: ArtifactPreviewLoader;
  readonly renderAgentAvatar?: (span: ConversationAgentActivitySpan) => ReactNode;
}

export function ConversationWorkCell({
  model,
  cwd,
  detailsState,
  onOpenRun,
  onLoadDetails,
  loadPreview,
  renderAgentAvatar,
}: ConversationWorkCellProps): JSX.Element {
  const { t } = useI18n();
  const [detailsCollapsed, setDetailsCollapsed] = useState(true);
  const [previewItem, setPreviewItem] = useState<ConversationArtifactStripItem | undefined>();
  const active = model.mode === "active";
  const fallbackRows: readonly ConversationWorkCellRow[] = model.operationRows.length === 0 && model.agentSpans.length === 0
    ? [{
      id: "operation:fallback",
      kind: "watch",
      title: model.title,
      description: model.summary && model.summary !== model.title ? model.summary : undefined,
      tone: active ? "running" : model.status === "succeeded" ? "success" : model.status === "failed" ? "failed" : "neutral",
    }]
    : [];
  const operationRows = model.operationRows.length > 0 ? model.operationRows : fallbackRows;
  const agentSpans = model.agentSpans;
  const showOperationRows = operationRows.length > 0;
  const statusLabel = model.kicker ?? workCellStatusLabel(model.status, active, t);
  const artifactStripSummary = buildArtifactStripSummary(model.artifactStripItems, t);
  const visibleArtifactItems = model.artifactStripItems.filter((item) => item.kind === "artifact");
  const evidenceSummary = artifactStripSummary ?? buildEvidenceSummary(model, t);
  const diagnosticsHandler = model.showDiagnostics === true && !evidenceSummary ? onOpenRun : undefined;
  const rootClassName = [
    "conversation-work-cell",
    "conversation-operation-cell",
    active ? "active" : "completed",
    `status-${model.status}`,
    "no-rail",
    model.presentation ? `presentation-${model.presentation}` : "",
  ].filter(Boolean).join(" ");
  const currentDetailsState: ConversationWorkCellDetailsState = detailsState ?? {
    status: onLoadDetails ? "not_loaded" : "loaded",
    groups: model.groups,
    evidenceLinks: model.evidenceLinks,
  };
  const detailsExpanded = Boolean(evidenceSummary && !detailsCollapsed);

  useEffect(() => {
    if (detailsExpanded && currentDetailsState.status === "not_loaded") {
      onLoadDetails?.(model.threadId);
    }
  }, [currentDetailsState.status, detailsExpanded, model.threadId, onLoadDetails]);

  function toggleDetails(): void {
    const nextExpanded = detailsCollapsed;
    setDetailsCollapsed(!detailsCollapsed);
    if (nextExpanded && (currentDetailsState.status === "not_loaded" || currentDetailsState.status === "error")) {
      onLoadDetails?.(model.threadId);
    }
  }

  return (
    <article className={rootClassName} data-thread-id={model.threadId} data-operation-source={model.sourceKind} aria-label={statusLabel}>
      <span className="visually-hidden" role="status" aria-live="polite" aria-label={statusLabel} />
      <div className="conversation-work-cell-body">
        {agentSpans.length > 0 ? (
          <AgentActivitySpans spans={agentSpans} renderAgentAvatar={renderAgentAvatar} />
        ) : null}

        {showOperationRows ? (
          <ActiveTurnItemStream rows={operationRows} />
        ) : null}

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

        {visibleArtifactItems.length > 0 ? (
          <ConversationArtifactStrip
            items={visibleArtifactItems}
            cwd={cwd}
            onPreview={setPreviewItem}
          />
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
            onRetry={() => onLoadDetails?.(model.threadId)}
          />
        ) : null}

        <ArtifactPreviewDrawer
          request={previewItem?.artifactId && cwd ? {
            source: "artifact",
            cwd,
            artifactId: previewItem.artifactId,
          } : undefined}
          loadPreview={loadPreview}
          openHref={previewItem?.href}
          downloadHref={previewItem?.href}
          downloadName={previewItem?.label}
          variant="lightbox"
          onClose={() => setPreviewItem(undefined)}
        />
      </div>
    </article>
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

function ConversationArtifactStrip({
  items,
  cwd,
  onPreview,
}: {
  readonly items: readonly ConversationArtifactStripItem[];
  readonly cwd?: string;
  readonly onPreview: (item: ConversationArtifactStripItem) => void;
}): JSX.Element | null {
  const { t } = useI18n();
  if (items.length === 0) {
    return null;
  }
  return (
    <div className="conversation-work-cell-artifacts" aria-label={t("Artifacts")}>
      {items.map((item) => {
        const previewable = Boolean(item.previewable && item.artifactId && cwd);
        const meta = artifactItemMeta(item, t);
        const icon = item.previewKind === "image" ? <ImageIcon size={13} aria-hidden="true" /> : <FileText size={13} aria-hidden="true" />;
        const content = (
          <>
            <span className="conversation-work-cell-artifact-thumb" aria-hidden="true">
              {item.previewKind === "image" && item.href ? <img src={item.href} alt="" loading="lazy" /> : icon}
            </span>
            <span className="conversation-work-cell-artifact-copy">
              <strong>{item.label}</strong>
              {meta ? <small>{meta}</small> : null}
            </span>
          </>
        );
        return previewable ? (
          <button
            key={item.id}
            className="conversation-work-cell-artifact-row"
            type="button"
            onClick={() => onPreview(item)}
            aria-label={`${t("Preview")}: ${item.label}`}
          >
            {content}
            <Eye size={13} aria-hidden="true" />
          </button>
        ) : item.href ? (
          <a
            key={item.id}
            className="conversation-work-cell-artifact-row"
            href={item.href}
            target="_blank"
            rel="noreferrer"
            title={item.label}
          >
            {content}
          </a>
        ) : (
          <span key={item.id} className="conversation-work-cell-artifact-row">
            {content}
          </span>
        );
      })}
    </div>
  );
}

function artifactItemMeta(item: ConversationArtifactStripItem, t: Translate): string | undefined {
  return [
    artifactTypeLabel(item, t),
    item.sizeBytes !== undefined ? formatArtifactSize(item.sizeBytes) : undefined,
  ].filter(Boolean).join(" · ") || undefined;
}

function artifactTypeLabel(item: ConversationArtifactStripItem, t: Translate): string | undefined {
  if (item.previewKind === "image") {
    return t("Image");
  }
  if (item.artifactType) {
    return item.artifactType.toUpperCase();
  }
  return undefined;
}

function formatArtifactSize(sizeBytes: number): string {
  if (sizeBytes < 1024) {
    return `${sizeBytes} B`;
  }
  if (sizeBytes < 1024 * 1024) {
    return `${(sizeBytes / 1024).toFixed(1)} KB`;
  }
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
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

function AgentActivitySpans({
  spans,
  renderAgentAvatar,
}: {
  readonly spans: readonly ConversationAgentActivitySpan[];
  readonly renderAgentAvatar?: (span: ConversationAgentActivitySpan) => ReactNode;
}): JSX.Element {
  const { t } = useI18n();
  const autoExpandedSpanIds = useMemo(
    () => new Set(spans.filter(shouldAutoExpandAgentActivitySpan).map((span) => span.id)),
    [spans],
  );
  const autoExpandedSpanKey = useMemo(
    () => [...autoExpandedSpanIds].sort().join("\n"),
    [autoExpandedSpanIds],
  );
  const [expandedSpanIds, setExpandedSpanIds] = useState<ReadonlySet<string>>(() => autoExpandedSpanIds);
  const [manuallyCollapsedSpanIds, setManuallyCollapsedSpanIds] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    if (autoExpandedSpanIds.size === 0) {
      return;
    }
    setExpandedSpanIds((current) => {
      const next = new Set(current);
      let changed = false;
      for (const spanId of autoExpandedSpanIds) {
        if (manuallyCollapsedSpanIds.has(spanId) || next.has(spanId)) {
          continue;
        }
        next.add(spanId);
        changed = true;
      }
      return changed ? next : current;
    });
  }, [autoExpandedSpanIds, autoExpandedSpanKey, manuallyCollapsedSpanIds]);

  return (
    <section className="conversation-work-cell-agent-spans" aria-label={t("Agent activity")}>
      <div className="conversation-work-cell-agent-span-list">
        {spans.map((span) => {
          const hasDetail = span.rows.length > 0;
          const expanded = hasDetail && expandedSpanIds.has(span.id);
          const latestRow = span.latestRow;
          const currentSummary = agentActivityCurrentSummary(latestRow, span.summary);
          const avatar = renderAgentAvatar?.(span);
          const headContent = (
            <>
              <span className="conversation-work-cell-agent-avatar" aria-hidden="true">
                {avatar ?? agentAvatarLabel(span.label)}
              </span>
              <span className="conversation-work-cell-agent-span-copy">
                <strong>{span.label}</strong>
                {currentSummary ? <small>{currentSummary}</small> : null}
              </span>
              {span.stateLabel ? <span className="conversation-work-cell-agent-span-state">{span.stateLabel}</span> : null}
              {hasDetail ? (
                <span className="conversation-work-cell-agent-span-toggle" aria-hidden="true">
                  <ChevronDown size={13} aria-hidden="true" />
                </span>
              ) : null}
            </>
          );
          return (
            <div
              key={span.id}
              className={["conversation-work-cell-agent-span", `kind-${span.kind ?? "agent"}`, span.tone ?? "neutral", expanded ? "expanded" : ""].filter(Boolean).join(" ")}
              data-agent-span-kind={span.kind ?? "agent"}
            >
              {hasDetail ? (
                <button
                  className="conversation-work-cell-agent-span-head"
                  type="button"
                  aria-expanded={expanded}
                  aria-label={expanded ? t("Collapse agent activity") : t("Expand agent activity")}
                  onClick={() => {
                    setExpandedSpanIds((current) => {
                      const next = new Set(current);
                      if (expanded) {
                        next.delete(span.id);
                      } else {
                        next.add(span.id);
                      }
                      return next;
                    });
                    setManuallyCollapsedSpanIds((current) => {
                      const next = new Set(current);
                      if (expanded) {
                        next.add(span.id);
                      } else {
                        next.delete(span.id);
                      }
                      return next;
                    });
                  }}
                >
                  {headContent}
                </button>
              ) : (
                <div className="conversation-work-cell-agent-span-head static">
                  {headContent}
                </div>
              )}
              {expanded && hasDetail ? (
                <div className="conversation-work-cell-agent-span-detail" aria-label={t("Agent activity detail")}>
                  <div className="conversation-work-cell-row-list">
                    {span.rows.map((row) => <WorkCellRow key={row.id} row={row} compact showIcon={false} />)}
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function shouldAutoExpandAgentActivitySpan(span: ConversationAgentActivitySpan): boolean {
  return span.tone === "waiting" ||
    span.tone === "failed" ||
    span.latestRow?.tone === "waiting" ||
    span.latestRow?.tone === "failed" ||
    span.rows.some((row) => row.tone === "waiting" || row.tone === "failed");
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
  onRetry,
}: {
  readonly state: ConversationWorkCellDetailsState;
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

  const groups = state.groups ?? [];
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
            {group.rows.map((row) => <WorkCellRow key={row.id} row={row} showIcon={false} />)}
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

function agentActivityCurrentSummary(row: ConversationWorkCellRow | undefined, fallback: string | undefined): string | undefined {
  if (!row) {
    return fallback;
  }
  const title = row.title.trim();
  if (!isExecutionActionRow(row)) {
    return title || fallback;
  }
  const detailLines = displayableRowDetailLines(row.detailLines);
  const primaryDetail = row.kind === "run_command"
    ? detailLines.find((line) => line.kind === "code")?.text ?? displayableRowDescription(title, row.description)
    : displayableRowDescription(title, row.description) ?? detailLines[0]?.text;
  if (!primaryDetail || sameVisibleRowText(title, primaryDetail)) {
    return title || fallback;
  }
  return truncateVisibleSummary(`${title}: ${primaryDetail}`);
}

function isExecutionActionRow(row: ConversationWorkCellRow): boolean {
  return /(?:^|:)action:/u.test(row.id);
}

function truncateVisibleSummary(value: string, maxLength = 180): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function ActiveTurnItemStream({ rows }: { readonly rows: readonly ConversationWorkCellRow[] }): JSX.Element {
  const { t } = useI18n();
  if (rows.length === 0) {
    return (
      <div className="conversation-work-cell-active-stream empty">
        <Clock3 size={13} />
        <span>{t("Waiting for activity")}</span>
      </div>
    );
  }
  return (
    <div className="conversation-work-cell-active-stream" aria-label={t("Active work stream")}>
      {rows.map((row) => <WorkCellRow key={row.id} row={row} compact showIcon={false} />)}
    </div>
  );
}

function WorkCellRow({
  row,
  compact = false,
  showIcon = true,
}: {
  readonly row: ConversationWorkCellRow;
  readonly compact?: boolean;
  readonly showIcon?: boolean;
}): JSX.Element {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const displayDescription = displayableRowDescription(row.title, row.description);
  const displayMeta = displayableRowMeta(row.meta);
  const detailLines = displayableRowDetailLines(row.detailLines);
  const hasDetail = Boolean(displayDescription || detailLines.length > 0);
  const detailCopyText = [
    displayDescription,
    ...detailLines.map((line) => line.text),
  ].filter((line): line is string => Boolean(line)).join("\n");
  const rowClassName = [
    "conversation-work-cell-row",
    row.presentation === "shell" ? "shell" : "",
    row.tone ?? "neutral",
    compact ? "compact" : "",
    showIcon ? "" : "iconless",
    expanded ? "expanded" : "",
  ].filter(Boolean).join(" ");
  if (row.presentation === "shell") {
    const shellCommand = shellCommandText(row, detailLines);
    const shellMain = (
      <>
        <span className="conversation-work-cell-shell-card">
          <span className="conversation-work-cell-shell-topline">
            <span className="conversation-work-cell-shell-label">{t("Shell")}</span>
            <span className={`conversation-work-cell-shell-state ${row.tone ?? "neutral"}`} aria-hidden="true" />
            <strong className="conversation-work-cell-shell-title">{row.title}</strong>
            {displayMeta ? <small className="conversation-work-cell-shell-status">{displayMeta}</small> : null}
          </span>
          {shellCommand ? <code className="conversation-work-cell-shell-command">$ {shellCommand}</code> : null}
          {displayDescription ? <small className="conversation-work-cell-shell-output">{displayDescription}</small> : null}
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
            className="conversation-work-cell-row-main conversation-work-cell-shell-main"
            type="button"
            aria-expanded={expanded}
            aria-label={shellCommand ? `${row.title}: $ ${shellCommand}` : row.title}
            onClick={() => setExpanded((value) => !value)}
          >
            {shellMain}
          </button>
        ) : (
          <div className="conversation-work-cell-row-main conversation-work-cell-shell-main static">
            {shellMain}
          </div>
        )}
        {expanded && hasDetail ? (
          <div className="conversation-work-cell-row-detail conversation-work-cell-shell-detail">
            {detailCopyText ? (
              <CopyActionButton text={detailCopyText} label={t("Copy output")} className="conversation-work-cell-detail-copy" iconSize={12} />
            ) : null}
            {displayDescription ? <small>{displayDescription}</small> : null}
            {detailLines.map((line, index) => (
              line.kind === "code"
                ? <code key={`${line.kind}:${index}`}>{line.text}</code>
                : <small key={`${line.kind ?? "text"}:${index}`}>{line.text}</small>
            ))}
          </div>
        ) : null}
      </div>
    );
  }
  const rowMain = (
    <>
      {showIcon ? (
        <span className="conversation-work-cell-row-icon" aria-hidden="true">
          <WorkCellRowIcon tone={row.tone ?? "neutral"} />
        </span>
      ) : null}
      <span className="conversation-work-cell-row-copy">
        <strong>{row.title}</strong>
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
        <div className="conversation-work-cell-row-detail">
          {detailCopyText ? (
            <CopyActionButton text={detailCopyText} label={t("Copy details")} className="conversation-work-cell-detail-copy" iconSize={12} />
          ) : null}
          {displayDescription ? <small>{displayDescription}</small> : null}
          {detailLines.map((line, index) => (
            line.kind === "code"
              ? <code key={`${line.kind}:${index}`}>{line.text}</code>
              : <small key={`${line.kind ?? "text"}:${index}`}>{line.text}</small>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function shellCommandText(
  row: ConversationWorkCellRow,
  detailLines: readonly { readonly kind?: "text" | "code"; readonly text: string }[],
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

function displayableRowDetailLines(lines?: readonly { readonly kind?: "text" | "code"; readonly text: string }[]): readonly { readonly kind?: "text" | "code"; readonly text: string }[] {
  if (!lines || lines.length === 0) {
    return [];
  }
  const result: Array<{ readonly kind?: "text" | "code"; readonly text: string }> = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const text = line.text.trim();
    if (!text || isLowSignalRowMeta(text) || seen.has(text)) {
      continue;
    }
    seen.add(text);
    result.push({ kind: line.kind, text });
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

function WorkCellRowIcon({ tone }: { readonly tone: ConversationWorkCellRow["tone"] | "neutral" }): JSX.Element {
  if (tone === "running") {
    return <Loader2 className="spin" size={13} />;
  }
  if (tone === "waiting") {
    return <ShieldCheck size={13} />;
  }
  if (tone === "failed") {
    return <CircleAlert size={13} />;
  }
  if (tone === "success") {
    return <CheckCircle2 size={13} />;
  }
  return <Clock3 size={13} />;
}
