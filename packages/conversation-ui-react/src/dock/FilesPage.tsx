import type { DockFileItem } from "@ling-stack/conversation-ui-core";
import { DockEmptyState } from "./DockEmptyState.js";

export interface FilesPageProps {
  readonly items: readonly DockFileItem[];
  readonly emptyTitle: string;
  readonly emptyDescription?: string;
  readonly kindLabels?: Partial<Record<DockFileItem["kind"], string>>;
  readonly statusLabels?: Partial<Record<NonNullable<DockFileItem["status"]>, string>>;
  readonly onOpenItem?: (itemId: string) => void;
}

export function FilesPage({
  items,
  emptyTitle,
  emptyDescription,
  kindLabels,
  statusLabels,
  onOpenItem,
}: FilesPageProps): JSX.Element {
  if (items.length === 0) {
    return <DockEmptyState title={emptyTitle} description={emptyDescription} />;
  }
  return (
    <div className="right-dock-files-page">
      <section className="right-dock-section" aria-label="Files">
        {items.map((item) => (
          <button
            key={item.id}
            className={["right-dock-row", "right-dock-file-row", item.status ? `status-${item.status}` : ""].filter(Boolean).join(" ")}
            type="button"
            onClick={() => onOpenItem?.(item.id)}
            disabled={!onOpenItem}
          >
            <span className="right-dock-row-copy">
              <strong>{item.name}</strong>
              {item.pathLabel ? <small>{item.pathLabel}</small> : null}
            </span>
            <span className="right-dock-row-meta">
              <small>{kindLabels?.[item.kind] ?? item.kind}</small>
              {item.status ? <small>{statusLabels?.[item.status] ?? item.status}</small> : null}
            </span>
          </button>
        ))}
      </section>
    </div>
  );
}
