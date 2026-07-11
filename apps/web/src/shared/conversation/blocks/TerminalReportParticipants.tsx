import type { ConversationWorkCellRow } from "../../../lib/conversation-work-cell.js";

export function TerminalReportParticipants({
  rows,
  expanded,
}: {
  readonly rows: readonly ConversationWorkCellRow[];
  readonly expanded: boolean;
}): JSX.Element | null {
  if (rows.length === 0) {
    return null;
  }
  if (!expanded) {
    return (
      <div className="terminal-report-participants compact" aria-label="Participants">
        {rows.map((row, index) => (
          <span key={row.id}>
            <strong>{row.title}</strong>
            {index < rows.length - 1 ? <span className="terminal-report-participant-separator">、</span> : null}
          </span>
        ))}
      </div>
    );
  }
  return (
    <section className="terminal-report-section terminal-report-participants" aria-label="Participants">
      <div className="terminal-report-participant-list">
        {rows.map((row) => (
          <div className={`terminal-report-participant tone-${row.tone ?? "neutral"}`} key={row.id} data-participant-id={row.participantId}>
            <strong>{row.title}</strong>
            {row.description ? <span>{row.description}</span> : null}
          </div>
        ))}
      </div>
    </section>
  );
}
