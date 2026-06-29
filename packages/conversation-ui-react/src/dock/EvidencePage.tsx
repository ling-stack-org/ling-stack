import type { DockEvidenceGroupView } from "@ling-stack/conversation-ui-core";
import { DockEmptyState } from "./DockEmptyState.js";

export interface EvidencePageProps {
  readonly groups: readonly DockEvidenceGroupView[];
  readonly emptyTitle: string;
  readonly emptyDescription?: string;
  readonly onOpenItem?: (itemId: string) => void;
}

export function EvidencePage({
  groups,
  emptyTitle,
  emptyDescription,
  onOpenItem,
}: EvidencePageProps): JSX.Element {
  const visibleGroups = groups.filter((group) => group.items.length > 0);
  if (visibleGroups.length === 0) {
    return <DockEmptyState title={emptyTitle} description={emptyDescription} />;
  }
  return (
    <div className="right-dock-evidence-page">
      {visibleGroups.map((group) => (
        <section className="right-dock-section" key={group.id} aria-label={group.label}>
          <h3>{group.label}</h3>
          {group.items.map((item) => (
            <button
              key={item.id}
              className={["right-dock-row", "right-dock-evidence-row", item.status ? `status-${item.status}` : ""].filter(Boolean).join(" ")}
              type="button"
              onClick={() => onOpenItem?.(item.id)}
              disabled={!onOpenItem}
            >
              <span className="right-dock-row-copy">
                <strong>{item.title}</strong>
                {item.summary ? <small>{item.summary}</small> : null}
              </span>
              <span className="right-dock-row-meta">
                {item.sourceLabel ? <small>{item.sourceLabel}</small> : null}
                {item.timestampLabel ? <small>{item.timestampLabel}</small> : null}
              </span>
            </button>
          ))}
        </section>
      ))}
    </div>
  );
}
