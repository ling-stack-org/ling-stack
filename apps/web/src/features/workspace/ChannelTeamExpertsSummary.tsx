import type { FoldedExpertChip, FoldedExpertEvidenceEntry, FoldedExpertsReadModel } from "@ling-stack/contracts";
import { TeammateAvatarView, type TeammateAvatarLike } from "../teammates/TeammateAvatarView.js";

export interface ChannelTeamExpertsSummaryProps {
  readonly experts: FoldedExpertsReadModel;
  readonly expanded?: boolean;
  readonly onToggleExpanded?: () => void;
  readonly cwd?: string;
  readonly resolveExpertTeammate?: (agentId: string) => TeammateAvatarLike | undefined;
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
  cwd,
  resolveExpertTeammate,
  labels = {},
}: ChannelTeamExpertsSummaryProps) {
  if (experts.totalCount === 0) {
    return null;
  }

  const text = {
    experts: labels.experts ?? "Teammates",
    active: labels.active ?? "active",
    done: labels.done ?? "done",
    delayed: labels.delayed ?? "delayed",
    unavailable: labels.unavailable ?? "unavailable",
  };
  const summary = [
    experts.activeCount > 0 ? { label: `${experts.activeCount} ${text.active}`, tone: "active" } : undefined,
    experts.completedCount > 0 ? { label: `${experts.completedCount} ${text.done}`, tone: "done" } : undefined,
    experts.delayedCount > 0 ? { label: `${experts.delayedCount} ${text.delayed}`, tone: "delayed" } : undefined,
    experts.unavailableCount > 0 ? { label: `${experts.unavailableCount} ${text.unavailable}`, tone: "unavailable" } : undefined,
  ].filter((item): item is { readonly label: string; readonly tone: "active" | "done" | "delayed" | "unavailable" } => Boolean(item));

  return (
    <section className="channel-team-experts-summary" aria-label={text.experts}>
      <button
        type="button"
        className="channel-team-experts-summary-toggle"
        aria-expanded={expanded}
        aria-label={`${text.experts}: ${summary.length > 0 ? summary.map((item) => item.label).join(", ") : `${experts.totalCount} ${text.done}`}`}
        onClick={onToggleExpanded}
      >
        <span className="channel-team-experts-summary-chips" aria-hidden="true">
          {experts.chips.slice(0, 4).map((chip, index) => (
            <ExpertChip
              chip={chip}
              cwd={cwd}
              index={index}
              key={chip.agentId}
              teammate={resolveExpertTeammate?.(chip.agentId)}
            />
          ))}
          {experts.chips.length > 4 ? (
            <span className="channel-team-experts-chip more">+{experts.chips.length - 4}</span>
          ) : null}
        </span>
        <span className="channel-team-experts-summary-meta">
          {summary.length > 0 ? summary.map((item, index) => (
            <span className={`channel-team-experts-summary-meta-item tone-${item.tone}`} key={item.tone}>
              {item.label}
              {index < summary.length - 1 ? <span className="channel-team-experts-summary-meta-separator">,</span> : null}
            </span>
          )) : (
            <span className="channel-team-experts-summary-meta-item tone-done">{experts.totalCount} {text.done}</span>
          )}
        </span>
      </button>
      {expanded ? (
        <div className="channel-team-experts-summary-panel">
          {experts.entries.map((entry) => (
            <ExpertEntry
              cwd={cwd}
              entry={entry}
              key={entry.id}
              teammate={entry.agentId ? resolveExpertTeammate?.(entry.agentId) : undefined}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function ExpertEntry({
  cwd,
  entry,
  teammate,
}: {
  readonly cwd?: string;
  readonly entry: FoldedExpertEvidenceEntry;
  readonly teammate?: TeammateAvatarLike;
}) {
  const agentLabel = teammate?.displayName ?? entry.agentId ?? entry.kind;
  const statusLabel = entry.evidenceGrade ?? entry.status;
  return (
    <article className={`channel-team-experts-summary-entry status-${entry.status}`} aria-label={`${agentLabel} ${statusLabel}: ${entry.summary}`}>
      <span className="channel-team-experts-summary-entry-dot" aria-hidden="true" />
      <span className="channel-team-experts-summary-entry-avatar" aria-hidden="true">
        {teammate && cwd?.trim()
          ? <TeammateAvatarView teammate={teammate} cwd={cwd} compact />
          : fallbackInitials(agentLabel)}
      </span>
      <strong className="channel-team-experts-summary-entry-agent">{agentLabel}</strong>
      <p className="channel-team-experts-summary-entry-summary">{entry.summary}</p>
    </article>
  );
}

function ExpertChip({
  chip,
  cwd,
  index,
  teammate,
}: {
  readonly chip: FoldedExpertChip;
  readonly cwd?: string;
  readonly index: number;
  readonly teammate?: TeammateAvatarLike;
}) {
  const title = teammate ? `${teammate.displayName}: ${chip.latestSummary}` : chip.latestSummary;
  if (teammate && cwd?.trim()) {
    return (
      <span className={`channel-team-experts-chip status-${chip.status} has-avatar`} title={title}>
        <TeammateAvatarView teammate={teammate} cwd={cwd} compact />
      </span>
    );
  }
  const initials = fallbackInitials(chip.agentId);
  return (
    <span className={`channel-team-experts-chip status-${chip.status} tone-${index % 6}`} title={title}>
      {initials || chip.agentId.slice(0, 2).toUpperCase()}
    </span>
  );
}

function fallbackInitials(value: string): string {
  const normalized = value.trim();
  return normalized
    .split(/[\s_-]+/)
    .filter(Boolean)
    .slice(-2)
    .map((part) => part.slice(0, 1).toUpperCase())
    .join("") || normalized.slice(0, 2).toUpperCase();
}
