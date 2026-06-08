import { useState } from "react";
import { CheckCircle2, CircleAlert, Clock3, FileText, History, Loader2, ShieldCheck } from "lucide-react";
import { useI18n } from "../../i18n.js";
import type { ConversationWorkCellRow, ConversationWorkCellViewModel } from "../../lib/conversation-work-cell.js";

export interface ConversationWorkCellProps {
  readonly model: ConversationWorkCellViewModel;
  readonly onOpenRun?: (runId: string) => void;
  readonly onOpenDetails?: (threadId: string) => void;
}

export function ConversationWorkCell({
  model,
  onOpenRun,
  onOpenDetails,
}: ConversationWorkCellProps): JSX.Element {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const active = model.mode === "active";
  const rootClassName = [
    "conversation-work-cell",
    active ? "active" : "completed",
    `status-${model.status}`,
  ].join(" ");

  return (
    <article className={rootClassName} data-thread-id={model.threadId} aria-label={t("Work result")}>
      <div className="conversation-work-cell-rail" aria-hidden="true">
        <WorkCellStatusIcon status={model.status} active={active} />
      </div>
      <div className="conversation-work-cell-body">
        <header className="conversation-work-cell-head">
          <div>
            <span className="conversation-work-cell-kicker">{active ? t("Work in progress") : t("Work result")}</span>
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

        {active ? (
          <ActiveTurnItemStream rows={model.activeRows} />
        ) : null}

        <div className="conversation-work-cell-actions">
          <button
            className="secondary-button compact-button"
            type="button"
            onClick={() => onOpenRun?.(model.anchorRunId)}
            disabled={!onOpenRun}
          >
            <History size={13} />
            {t("Open run")}
          </button>
          {onOpenDetails ? (
            <button className="secondary-button compact-button" type="button" onClick={() => onOpenDetails(model.threadId)}>
              <FileText size={13} />
              {t("Details")}
            </button>
          ) : null}
          <button className="secondary-button compact-button" type="button" onClick={() => setExpanded((current) => !current)} aria-expanded={expanded}>
            {expanded ? t("Hide details") : t("Show details")}
          </button>
        </div>

        {expanded ? (
          <div className="conversation-work-cell-details">
            {model.groups.map((group) => (
              <section key={group.id} className={`conversation-work-cell-group ${group.id}`} aria-label={group.label}>
                <header>
                  <strong>{group.label}</strong>
                  <small>{group.summary}</small>
                </header>
                {group.rows.length > 0 ? (
                  <div className="conversation-work-cell-row-list">
                    {group.rows.map((row) => <WorkCellRow key={row.id} row={row} />)}
                  </div>
                ) : (
                  <p className="conversation-work-cell-empty">{t("No items recorded")}</p>
                )}
              </section>
            ))}
            {model.evidenceLinks.length > 0 ? (
              <div className="conversation-work-cell-evidence-links" aria-label={t("Evidence links")}>
                {model.evidenceLinks.map((link) => (
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
        ) : null}
      </div>
    </article>
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
  if (status === "failed" || status === "cancelled") {
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
