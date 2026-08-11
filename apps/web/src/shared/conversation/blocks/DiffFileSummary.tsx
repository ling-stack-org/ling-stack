import type { ConversationFileChange } from "../../../lib/diff-summary.js";

export interface DiffFileSummaryProps {
  readonly change: ConversationFileChange;
  readonly selected?: boolean;
  readonly onSelect?: () => void;
}

export function DiffFileSummary({ change, selected = false, onSelect }: DiffFileSummaryProps): React.JSX.Element {
  return (
    <button className={selected ? "diff-file-summary selected" : "diff-file-summary"} type="button" onClick={onSelect}>
      <span>
        <strong>{change.path}</strong>
        <small>{change.kind} · {change.status}{change.malformed ? " · malformed" : ""}</small>
      </span>
      <span className="diff-stat">
        <strong className="add">+{change.additions ?? 0}</strong>
        <strong className="delete">-{change.deletions ?? 0}</strong>
      </span>
    </button>
  );
}
