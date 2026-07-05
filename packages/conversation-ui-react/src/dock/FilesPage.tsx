import type { DockFileItem } from "@ling-stack/conversation-ui-core";
import { DockEmptyState } from "./DockEmptyState.js";

export interface FilesPageProps {
  readonly items: readonly DockFileItem[];
  readonly emptyTitle: string;
  readonly emptyDescription?: string;
  readonly groupFallbackLabel?: string;
  readonly kindLabels?: Partial<Record<DockFileItem["kind"], string>>;
  readonly statusLabels?: Partial<Record<NonNullable<DockFileItem["status"]>, string>>;
  readonly onOpenItem?: (itemId: string) => void;
}

export function FilesPage({
  items,
  emptyTitle,
  emptyDescription,
  groupFallbackLabel = "Files",
  kindLabels,
  statusLabels,
  onOpenItem,
}: FilesPageProps): JSX.Element {
  if (items.length === 0) {
    return <DockEmptyState title={emptyTitle} description={emptyDescription} />;
  }
  const groups = groupFileItems(items, groupFallbackLabel);
  return (
    <div className="right-dock-files-page">
      {groups.map((group) => (
        <section className="right-dock-section right-dock-file-group" aria-label={group.label} key={group.id}>
          <header className="right-dock-file-group-header">
            <strong>{group.label}</strong>
            {group.detail ? <small>{group.detail}</small> : null}
          </header>
          {group.items.map((item) => (
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
      ))}
    </div>
  );
}

interface FileItemGroup {
  readonly id: string;
  readonly label: string;
  readonly detail?: string;
  readonly order: number;
  readonly items: readonly DockFileItem[];
}

function groupFileItems(items: readonly DockFileItem[], fallbackLabel: string): readonly FileItemGroup[] {
  const byId = new Map<string, { label: string; detail?: string; order: number; items: DockFileItem[] }>();
  for (const item of items) {
    const scope = item.ownerScope;
    const id = scope ? `${scope.kind}:${scope.id}` : "unscoped";
    const current = byId.get(id) ?? {
      label: scope?.label ?? fallbackLabel,
      detail: scope?.detail,
      order: scope?.order ?? Number.MAX_SAFE_INTEGER,
      items: [],
    };
    current.items.push(item);
    byId.set(id, current);
  }
  return [...byId.entries()]
    .map(([id, group]) => ({ id, ...group }))
    .sort((left, right) => left.order - right.order || left.label.localeCompare(right.label));
}
