import type { ReactNode } from "react";

export interface TeammateAvatarStackItem {
  readonly id: string;
  readonly label: string;
  readonly avatarNode?: ReactNode;
  readonly status?: "active" | "done" | "delayed" | "unavailable";
  readonly title?: string;
}

export interface TeammateAvatarStackProps {
  readonly items: readonly TeammateAvatarStackItem[];
  readonly maxVisible?: number;
  readonly size?: "xs" | "sm" | "md";
  readonly className?: string;
  readonly label?: string;
  readonly overflowLabel?: (count: number) => string;
  readonly onOpen?: () => void;
}

export function TeammateAvatarStack({
  items,
  maxVisible = 4,
  size = "sm",
  className,
  label,
  overflowLabel = (count) => `+${count}`,
  onOpen,
}: TeammateAvatarStackProps): JSX.Element | null {
  if (items.length === 0) {
    return null;
  }
  const visibleItems = items.slice(0, maxVisible);
  const overflowCount = items.length - visibleItems.length;
  const accessibleLabel = label ?? visibleItems.map((item) => item.label).join(", ");
  const rootClassName = [
    "teammate-avatar-stack",
    `teammate-avatar-stack-${size}`,
    onOpen ? "interactive" : "",
    className,
  ].filter(Boolean).join(" ");
  const stack = (
    <>
      {visibleItems.map((item, index) => (
        <span
          key={item.id}
          className={[
            "teammate-avatar-stack-item",
            `tone-${index % 5}`,
            item.status ? `status-${item.status}` : "",
          ].filter(Boolean).join(" ")}
          title={item.title ?? item.label}
          aria-hidden="true"
        >
          {item.avatarNode ?? <span className="teammate-avatar-stack-fallback">{avatarInitials(item.label)}</span>}
        </span>
      ))}
      {overflowCount > 0 ? (
        <span className="teammate-avatar-stack-overflow" aria-hidden="true">
          {overflowLabel(overflowCount)}
        </span>
      ) : null}
    </>
  );
  if (onOpen) {
    return (
      <button className={rootClassName} type="button" title={accessibleLabel} aria-label={accessibleLabel} onClick={onOpen}>
        {stack}
      </button>
    );
  }
  return (
    <span className={rootClassName} title={accessibleLabel} aria-label={accessibleLabel}>
      {stack}
    </span>
  );
}

function avatarInitials(value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    return "?";
  }
  const parts = normalized.split(/\s+/u).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}`.toUpperCase();
  }
  return normalized.slice(0, 2).toUpperCase();
}
