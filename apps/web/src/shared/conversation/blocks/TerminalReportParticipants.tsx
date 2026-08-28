import { Fragment, type ReactNode } from "react";
import type { ConversationWorkCellRow } from "../../../lib/conversation-work-cell.js";
import { AvatarInitial } from "../../components/index.js";
import { MessageBodyRenderer } from "./MessageBodyRenderer.js";

export function TerminalReportParticipants({
  rows,
  expanded,
  renderParticipantAvatar,
  cwd,
}: {
  readonly rows: readonly ConversationWorkCellRow[];
  readonly expanded: boolean;
  readonly renderParticipantAvatar?: (participantId: string | undefined, label: string) => ReactNode;
  readonly cwd?: string;
}): React.JSX.Element | null {
  if (rows.length === 0) {
    return null;
  }
  if (!expanded) {
    return (
      <div className="terminal-report-participants compact" aria-label="Participants">
        {rows.map((row, index) => (
          <Fragment key={row.id}>
            <span className="terminal-report-participant-compact">
              <ParticipantAvatar row={row} renderParticipantAvatar={renderParticipantAvatar} />
              <strong>{row.title}</strong>
            </span>
            {index < rows.length - 1 ? <span className="terminal-report-participant-separator">、</span> : null}
          </Fragment>
        ))}
      </div>
    );
  }
  return (
    <section className="terminal-report-section terminal-report-participants" aria-label="Participants">
      <div className="terminal-report-participant-list">
        {rows.map((row) => (
          <div className={`terminal-report-participant tone-${row.tone ?? "neutral"}`} key={row.id} data-participant-id={row.participantId}>
            <ParticipantAvatar row={row} renderParticipantAvatar={renderParticipantAvatar} />
            <div className="terminal-report-participant-copy">
              <strong>{row.title}</strong>
              {row.description ? <MessageBodyRenderer className="terminal-report-participant-rich-description" text={row.description} cwd={cwd} compact /> : null}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function ParticipantAvatar({
  row,
  renderParticipantAvatar,
}: {
  readonly row: ConversationWorkCellRow;
  readonly renderParticipantAvatar?: (participantId: string | undefined, label: string) => ReactNode;
}): React.JSX.Element {
  return (
    <span className="terminal-report-participant-avatar" aria-hidden="true">
      {renderParticipantAvatar?.(row.participantId, row.title) ?? <AvatarInitial label={row.title.trim().charAt(0).toUpperCase() || "A"} tone="gray" />}
    </span>
  );
}
