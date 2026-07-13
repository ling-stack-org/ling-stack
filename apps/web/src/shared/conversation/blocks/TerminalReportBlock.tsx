import { CheckCircle2, ChevronDown, CircleAlert, FilePenLine } from "lucide-react";
import type { ReactNode } from "react";
import type { ConversationWorkCellRow } from "../../../lib/conversation-work-cell.js";
import {
  getTerminalReportProjectionPolicy,
  type ConversationSurfaceKind,
  type TerminalReportProjectionPolicy,
} from "../tokens/conversation-surface-policy.js";
import { useConversationBlockView } from "../view-store/use-conversation-block-view.js";
import { TerminalReportParticipants } from "./TerminalReportParticipants.js";

export function TerminalReportBlock({
  blockId,
  revisionKey,
  rows,
  renderParticipantAvatar,
  surface,
  projectionPolicy,
}: {
  readonly blockId: string;
  readonly revisionKey: string;
  readonly rows: readonly ConversationWorkCellRow[];
  readonly renderParticipantAvatar?: (participantId: string | undefined, label: string) => ReactNode;
  readonly surface: ConversationSurfaceKind;
  readonly projectionPolicy?: Partial<TerminalReportProjectionPolicy>;
}): JSX.Element | null {
  const resolvedProjectionPolicy = getTerminalReportProjectionPolicy(surface, projectionPolicy);
  const outcome = rows.find((row) => row.reportSection === "outcome");
  if (!outcome) {
    return null;
  }
  const participants = resolvedProjectionPolicy.showParticipants
    ? rows.filter((row) => row.reportSection === "participant")
    : [];
  const changes = rows.filter((row) => row.reportSection === "change");
  const verification = rows.filter((row) => row.reportSection === "verification");
  const corrections = rows.filter((row) => row.reportSection === "correction");
  const risks = rows.filter((row) => row.reportSection === "risk");
  const hasExpandedDetail = changes.length + verification.length + corrections.length + risks.length + participants.length > 0;
  const disclosure = useConversationBlockView({
    blockId: `terminal-report:${blockId}`,
    revisionKey,
    defaultExpanded: false,
  });
  const expanded = hasExpandedDetail && disclosure.expanded;

  return (
    <section className={`terminal-report-block ${expanded ? "expanded" : "collapsed"}`} data-terminal-report-block={blockId}>
      <button
        className="terminal-report-summary"
        type="button"
        aria-expanded={expanded}
        disabled={!hasExpandedDetail}
        onClick={disclosure.toggleExpanded}
      >
        <span className="terminal-report-outcome-copy">
          <strong>{outcome.title}</strong>
          {outcome.description ? <span>{outcome.description}</span> : null}
        </span>
        {hasExpandedDetail ? (
          <span className="terminal-report-toggle" aria-hidden="true">
            <ChevronDown size={14} />
          </span>
        ) : null}
      </button>

      <TerminalReportParticipants rows={participants} expanded={expanded} renderParticipantAvatar={renderParticipantAvatar} />

      {expanded ? (
        <div className="terminal-report-detail">
          {corrections.length > 0 ? <TerminalReportRows rows={corrections} kind="correction" /> : null}
          {changes.length > 0 ? <TerminalReportRows rows={changes} kind="change" /> : null}
          {verification.length > 0 ? <TerminalReportRows rows={verification} kind="verification" /> : null}
          {risks.length > 0 ? <TerminalReportRows rows={risks} kind="risk" /> : null}
        </div>
      ) : null}
    </section>
  );
}

function TerminalReportRows({
  rows,
  kind,
}: {
  readonly rows: readonly ConversationWorkCellRow[];
  readonly kind: "correction" | "change" | "verification" | "risk";
}): JSX.Element {
  return (
    <section className={`terminal-report-section kind-${kind}`}>
      <div className="terminal-report-row-list">
        {rows.map((row) => (
          <div className={`terminal-report-row tone-${row.tone ?? "neutral"}`} key={row.id}>
            <span className="terminal-report-row-icon" aria-hidden="true">{reportRowIcon(kind)}</span>
            <span className="terminal-report-row-copy">
              <span className="terminal-report-row-title">
                <span>{row.title}</span>
                {row.meta ? <small>{row.meta}</small> : null}
              </span>
              {row.description ? <span className="terminal-report-row-description">{row.description}</span> : null}
              {row.commandText ? <code>{row.commandText}</code> : null}
              {row.detailLines?.length ? (
                <span className="terminal-report-row-paths">
                  {row.detailLines.map((line, index) => <code key={`${row.id}:detail:${index}`}>{line.text}</code>)}
                </span>
              ) : null}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

function reportRowIcon(kind: "correction" | "change" | "verification" | "risk"): JSX.Element {
  if (kind === "change") {
    return <FilePenLine size={13} />;
  }
  if (kind === "verification") {
    return <CheckCircle2 size={13} />;
  }
  return <CircleAlert size={13} />;
}
