import type { DockFileItem } from "@ling-stack/conversation-ui-core";
import { Button, InlineFeedback } from "@ling-stack/ui-react";
import { DockEmptyState } from "./DockEmptyState.js";

export interface FilesPageProps {
  readonly items: readonly DockFileItem[];
  readonly emptyTitle: string;
  readonly emptyDescription?: string;
  readonly groupFallbackLabel?: string;
  readonly kindLabels?: Partial<Record<DockFileItem["kind"], string>>;
  readonly statusLabels?: Partial<Record<NonNullable<DockFileItem["status"]>, string>>;
  readonly error?: string;
  readonly onOpenItem?: (itemId: string) => void;
}

export function FilesPage({
  items,
  emptyTitle,
  emptyDescription,
  groupFallbackLabel = "Files",
  kindLabels,
  statusLabels,
  error,
  onOpenItem,
}: FilesPageProps): JSX.Element {
  const groups = groupFileItems(items, groupFallbackLabel);
  return (
    <div className="right-dock-files-page">
      {error ? <InlineFeedback tone="danger" role="alert">{error}</InlineFeedback> : null}
      {items.length === 0 ? <DockEmptyState title={emptyTitle} description={emptyDescription} /> : null}
      {groups.map((group) => (
        <section className="right-dock-section right-dock-file-group" aria-label={group.label} key={group.id}>
          <header className="right-dock-file-group-header">
            <strong>{group.label}</strong>
            {group.detail ? <small>{group.detail}</small> : null}
          </header>
          {group.items.map((item) => (
            <Button
              key={item.id}
              className={["right-dock-row", "right-dock-file-row", item.status ? `status-${item.status}` : ""].filter(Boolean).join(" ")}
              size="md"
              variant="ghost"
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
            </Button>
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
