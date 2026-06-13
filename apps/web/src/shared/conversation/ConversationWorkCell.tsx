import { useState } from "react";
import { CheckCircle2, ChevronDown, CircleAlert, Clock3, FileText, History, Loader2, RefreshCw, ShieldCheck } from "lucide-react";
import { useI18n, type Translate } from "../../i18n.js";
import type { ConversationWorkCellBranch, ConversationWorkCellEvidenceLink, ConversationWorkCellGroup, ConversationWorkCellRow, ConversationWorkCellViewModel } from "../../lib/conversation-work-cell.js";

export type ConversationWorkCellDetailsStatus = "not_loaded" | "loading" | "loaded" | "empty" | "error";

export interface ConversationWorkCellDetailsState {
  readonly status: ConversationWorkCellDetailsStatus;
  readonly groups?: readonly ConversationWorkCellGroup[];
  readonly evidenceLinks?: readonly ConversationWorkCellEvidenceLink[];
  readonly errorMessage?: string;
}

export interface ConversationWorkCellProps {
  readonly model: ConversationWorkCellViewModel;
  readonly detailsState?: ConversationWorkCellDetailsState;
  readonly onOpenRun?: (runId: string) => void;
  readonly onOpenDetails?: (threadId: string) => void;
  readonly onLoadDetails?: (threadId: string) => void;
}

export function ConversationWorkCell({
  model,
  detailsState,
  onOpenRun,
  onOpenDetails,
  onLoadDetails,
}: ConversationWorkCellProps): JSX.Element {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const active = model.mode === "active";
  const statusLabel = model.kicker ?? workCellStatusLabel(model.status, active, t);
  const rootClassName = [
    "conversation-work-cell",
    active ? "active" : "completed",
    `status-${model.status}`,
    model.presentation ? `presentation-${model.presentation}` : "",
  ].filter(Boolean).join(" ");
  const currentDetailsState: ConversationWorkCellDetailsState = detailsState ?? {
    status: onLoadDetails ? "not_loaded" : "loaded",
    groups: model.groups,
    evidenceLinks: model.evidenceLinks,
  };

  function toggleDetails(): void {
    const nextExpanded = !expanded;
    setExpanded(nextExpanded);
    if (nextExpanded && (currentDetailsState.status === "not_loaded" || currentDetailsState.status === "error")) {
      onLoadDetails?.(model.threadId);
    }
  }

  return (
    <article className={rootClassName} data-thread-id={model.threadId} aria-label={statusLabel}>
      <div className="conversation-work-cell-rail" aria-hidden="true">
        <WorkCellStatusIcon status={model.status} active={active} />
      </div>
      <div className="conversation-work-cell-body">
        <header className="conversation-work-cell-head">
          <div>
            <span className="conversation-work-cell-kicker">{statusLabel}</span>
            <strong>{model.title}</strong>
          </div>
          <span className={`status-badge ${model.status}`}>{t(model.status)}</span>
        </header>

        <p className="conversation-work-cell-summary">{model.summary}</p>

        <div className="conversation-work-cell-stats" aria-label={t("Work summary")}>
          {model.stats.map((stat) => (
            <span key={stat.id}>
              <small>{stat.label}</small>
              <strong>{stat.value}</strong>
            </span>
          ))}
        </div>

        {model.branchRows && model.branchRows.length > 0 ? (
          <BranchRows branches={model.branchRows} />
        ) : null}

        {active ? (
          <ActiveTurnItemStream rows={model.activeRows} />
        ) : null}

        {model.finalReportRows && model.finalReportRows.length > 0 ? (
          <FinalReportRows rows={model.finalReportRows} />
        ) : null}

        <div className="conversation-work-cell-actions">
          {model.showDiagnostics === false || !onOpenRun ? null : (
            <button
              className="secondary-button compact-button"
              type="button"
              onClick={() => onOpenRun(model.anchorRunId)}
            >
              <History size={13} />
              {t("Open diagnostics")}
            </button>
          )}
          {onOpenDetails ? (
            <button className="secondary-button compact-button" type="button" onClick={() => onOpenDetails(model.threadId)}>
              <FileText size={13} />
              {model.detailsLabel ?? t("Details")}
            </button>
          ) : null}
          <button className="secondary-button compact-button" type="button" onClick={toggleDetails} aria-expanded={expanded}>
            {expanded ? t("Hide details") : t("Show details")}
          </button>
        </div>

        {expanded ? (
          <WorkCellDetails
            state={currentDetailsState}
            onRetry={() => onLoadDetails?.(model.threadId)}
          />
        ) : null}
      </div>
    </article>
  );
}

function BranchRows({ branches }: { readonly branches: readonly ConversationWorkCellBranch[] }): JSX.Element {
  const { t } = useI18n();
  const [expandedBranchId, setExpandedBranchId] = useState<string>();
  return (
    <section className="conversation-work-cell-branches" aria-label={t("Parallel branches")}>
      <header>
        <strong>{t("Parallel branches")}</strong>
        <small>{t("{count} branches", { count: branches.length })}</small>
      </header>
      <div className="conversation-work-cell-branch-list">
        {branches.map((branch) => {
          const expanded = expandedBranchId === branch.id;
          return (
            <div key={branch.id} className={["conversation-work-cell-branch", branch.tone ?? "neutral", expanded ? "expanded" : ""].filter(Boolean).join(" ")}>
              <button
                className="conversation-work-cell-branch-head"
                type="button"
                aria-expanded={expanded}
                onClick={() => setExpandedBranchId(expanded ? undefined : branch.id)}
              >
                <span className="conversation-work-cell-row-dot" aria-hidden="true" />
                <span className="conversation-work-cell-branch-copy">
                  <strong>{branch.label}</strong>
                  {branch.summary ? <small>{branch.summary}</small> : null}
                </span>
                {branch.meta ? <code>{branch.meta}</code> : null}
                <span className="conversation-work-cell-branch-toggle">
                  <ChevronDown size={13} aria-hidden="true" />
                  <span>{expanded ? t("Collapse branch") : t("Expand branch")}</span>
                </span>
              </button>
              {expanded ? (
                <div className="conversation-work-cell-branch-detail" aria-label={t("Branch steps")}>
                  {branch.stateLabel ? <small>{branch.stateLabel}</small> : null}
                  <div className="conversation-work-cell-row-list">
                    {branch.rows.map((row) => <WorkCellRow key={row.id} row={row} compact />)}
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

function workCellStatusLabel(
  status: ConversationWorkCellViewModel["status"],
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

function FinalReportRows({ rows }: { readonly rows: readonly ConversationWorkCellRow[] }): JSX.Element {
  const { t } = useI18n();
  return (
    <section className="conversation-work-cell-final-report" aria-label={t("Final Ling report")}>
      <header>
        <ShieldCheck size={13} />
        <strong>{t("Final Ling report")}</strong>
      </header>
      <div className="conversation-work-cell-row-list">
        {rows.map((row) => <WorkCellRow key={row.id} row={row} />)}
      </div>
    </section>
  );
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
          <Clock3 size={13} />
          <span>{t("Details are loaded on demand.")}</span>
          <button className="secondary-button compact-button" type="button" onClick={onRetry}>
            {t("Load details")}
          </button>
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
            {t("Retry details")}
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
            {group.rows.map((row) => <WorkCellRow key={row.id} row={row} />)}
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
      {rows.map((row) => <WorkCellRow key={row.id} row={row} compact />)}
    </div>
  );
}

function WorkCellRow({ row, compact = false }: { readonly row: ConversationWorkCellRow; readonly compact?: boolean }): JSX.Element {
  return (
    <div className={["conversation-work-cell-row", row.tone ?? "neutral", compact ? "compact" : ""].filter(Boolean).join(" ")}>
      <span className="conversation-work-cell-row-dot" aria-hidden="true" />
      <span className="conversation-work-cell-row-copy">
        <strong>{row.title}</strong>
        {row.description ? <small>{row.description}</small> : null}
      </span>
      {row.meta ? <code>{row.meta}</code> : null}
    </div>
  );
}

function WorkCellStatusIcon({ status, active }: { readonly status: ConversationWorkCellViewModel["status"]; readonly active: boolean }): JSX.Element {
  if (status === "succeeded") {
    return <CheckCircle2 size={17} />;
  }
  if (status === "failed" || status === "cancelled" || status === "superseded") {
    return <CircleAlert size={17} />;
  }
  if (status === "waiting_for_approval") {
    return <ShieldCheck size={17} />;
  }
  if (active) {
    return <Loader2 className="spin" size={17} />;
  }
  return <Clock3 size={17} />;
}
