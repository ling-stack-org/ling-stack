import type { ReactNode } from "react";
import { AppWindow, Box, Brain, FileText, Globe2, Link2, ShieldAlert, Wrench } from "lucide-react";
import type { SourceIconKind } from "../tokens/conversation-surface-policy.js";

export type { SourceIconKind };

export interface SourceIconStackItem {
  readonly id: string;
  readonly kind: SourceIconKind;
  readonly label: string;
  readonly href?: string;
  readonly title?: string;
  readonly status?: "available" | "degraded" | "blocked";
}

export interface SourceIconStackProps {
  readonly sources: readonly SourceIconStackItem[];
  readonly maxVisible?: number;
  readonly size?: "xs" | "sm" | "md";
  readonly className?: string;
  readonly label?: string;
  readonly overflowLabel?: (count: number) => string;
  readonly onOpenSource?: (source: SourceIconStackItem) => void;
}

export function SourceIconStack({
  sources,
  maxVisible = 4,
  size = "sm",
  className,
  label,
  overflowLabel = (count) => `+${count}`,
  onOpenSource,
}: SourceIconStackProps): React.JSX.Element | null {
  if (sources.length === 0) {
    return null;
  }
  const visibleSources = sources.slice(0, maxVisible);
  const overflowCount = sources.length - visibleSources.length;
  const accessibleLabel = label ?? sources.map((source) => source.label).join(", ");
  const rootClassName = [
    "message-evidence-source-stack",
    "source-icon-stack",
    `source-icon-stack-${size}`,
    className,
  ].filter(Boolean).join(" ");

  return (
    <span className={rootClassName} title={accessibleLabel} aria-label={accessibleLabel}>
      {visibleSources.map((source, index) => renderSourceIcon(source, index, onOpenSource))}
      {overflowCount > 0 ? (
        <span className="message-evidence-source-overflow source-icon-stack-overflow" aria-hidden="true">
          {overflowLabel(overflowCount)}
        </span>
      ) : null}
    </span>
  );
}

function renderSourceIcon(
  source: SourceIconStackItem,
  index: number,
  onOpenSource: ((source: SourceIconStackItem) => void) | undefined,
): ReactNode {
  const className = [
    "message-evidence-source-icon",
    "source-icon-stack-item",
    `tone-${index % 5}`,
    source.status ? `status-${source.status}` : "",
  ].filter(Boolean).join(" ");
  const title = source.title ?? source.label;
  const content = sourceIcon(source.kind, source.status);
  if (source.href) {
    return (
      <a
        key={source.id}
        className={className}
        href={source.href}
        target="_blank"
        rel="noreferrer"
        title={title}
        aria-label={source.label}
      >
        {content}
      </a>
    );
  }
  if (onOpenSource) {
    return (
      <button
        key={source.id}
        className={className}
        type="button"
        title={title}
        aria-label={source.label}
        onClick={() => onOpenSource(source)}
      >
        {content}
      </button>
    );
  }
  return (
    <span key={source.id} className={className} title={title} aria-hidden="true">
      {content}
    </span>
  );
}

function sourceIcon(kind: SourceIconKind, status: SourceIconStackItem["status"]): ReactNode {
  if (status === "blocked") {
    return <ShieldAlert size={15} strokeWidth={1.9} />;
  }
  switch (kind) {
    case "web":
      return <Globe2 size={15} strokeWidth={1.9} />;
    case "open_url":
      return <Link2 size={15} strokeWidth={1.9} />;
    case "memory":
      return <Brain size={15} strokeWidth={1.9} />;
    case "file":
      return <FileText size={15} strokeWidth={1.9} />;
    case "tool":
      return <Wrench size={15} strokeWidth={1.9} />;
    case "artifact":
      return <Box size={15} strokeWidth={1.9} />;
    case "app":
      return <AppWindow size={15} strokeWidth={1.9} />;
    case "policy":
      return <ShieldAlert size={15} strokeWidth={1.9} />;
  }
}
