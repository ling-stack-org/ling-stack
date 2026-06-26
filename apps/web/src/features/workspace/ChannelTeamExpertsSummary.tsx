import type { FoldedExpertChip, FoldedExpertsReadModel } from "@ling-stack/contracts";

export interface ChannelTeamExpertsSummaryProps {
  readonly experts: FoldedExpertsReadModel;
  readonly expanded?: boolean;
  readonly onToggleExpanded?: () => void;
  readonly labels?: Partial<{
    readonly experts: string;
    readonly active: string;
    readonly done: string;
    readonly delayed: string;
    readonly unavailable: string;
  }>;
}

export function ChannelTeamExpertsSummary({
  experts,
  expanded = false,
  onToggleExpanded,
  labels = {},
}: ChannelTeamExpertsSummaryProps) {
  if (experts.totalCount === 0) {
    return null;
  }

  const text = {
    experts: labels.experts ?? "Experts",
    active: labels.active ?? "active",
    done: labels.done ?? "done",
    delayed: labels.delayed ?? "delayed",
    unavailable: labels.unavailable ?? "unavailable",
  };
  const summary = [
    experts.activeCount > 0 ? `${experts.activeCount} ${text.active}` : undefined,
    experts.completedCount > 0 ? `${experts.completedCount} ${text.done}` : undefined,
    experts.delayedCount > 0 ? `${experts.delayedCount} ${text.delayed}` : undefined,
    experts.unavailableCount > 0 ? `${experts.unavailableCount} ${text.unavailable}` : undefined,
  ].filter((item): item is string => Boolean(item));

  return (
    <section className="channel-team-experts-summary" aria-label={text.experts}>
      <button
        type="button"
        className="channel-team-experts-summary-toggle"
        aria-expanded={expanded}
        onClick={onToggleExpanded}
      >
        <span className="channel-team-experts-summary-title">{text.experts}</span>
        <span className="channel-team-experts-summary-meta">
          {summary.length > 0 ? summary.join(", ") : `${experts.totalCount} ${text.done}`}
        </span>
        <span className="channel-team-experts-summary-chips" aria-hidden="true">
          {experts.chips.slice(0, 3).map((chip) => (
            <ExpertChip chip={chip} key={chip.agentId} />
          ))}
          {experts.chips.length > 3 ? (
            <span className="channel-team-experts-chip more">+{experts.chips.length - 3}</span>
          ) : null}
        </span>
      </button>
      {expanded ? (
        <div className="channel-team-experts-summary-panel">
          {experts.entries.map((entry) => (
            <article className="channel-team-experts-summary-entry" key={entry.id}>
              <div className="channel-team-experts-summary-entry-head">
                <strong>{entry.agentId ?? entry.kind}</strong>
                <span>{entry.evidenceGrade ?? entry.status}</span>
              </div>
              <p>{entry.summary}</p>
            </article>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function ExpertChip({ chip }: { readonly chip: FoldedExpertChip }) {
  const initials = chip.agentId
    .split(/[_-]+/)
    .filter(Boolean)
    .slice(-2)
    .map((part) => part.slice(0, 1).toUpperCase())
    .join("");
  return (
    <span className={`channel-team-experts-chip status-${chip.status}`} title={chip.latestSummary}>
      {initials || chip.agentId.slice(0, 2).toUpperCase()}
    </span>
  );
}
