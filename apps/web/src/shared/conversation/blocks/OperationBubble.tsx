import type { ReactNode } from "react";
import { Activity, CheckCircle2, CircleAlert, Clock3, ShieldCheck } from "lucide-react";
import { OperationBubbleHeader } from "./OperationBubbleHeader.js";

export interface OperationBubbleProps {
  readonly status: string;
  readonly active: boolean;
  readonly sourceLabel: string;
  readonly statusLabel: string;
  readonly ariaLabel: string;
  readonly actions?: ReactNode;
  readonly children: ReactNode;
  readonly expandable?: boolean;
  readonly expanded?: boolean;
  readonly toggleLabel?: string;
  readonly onToggleExpanded?: () => void;
}

export function OperationBubble({
  status,
  active,
  sourceLabel,
  statusLabel,
  ariaLabel,
  actions,
  children,
  expandable = false,
  expanded = true,
  toggleLabel,
  onToggleExpanded,
}: OperationBubbleProps): JSX.Element {
  const statusTone = operationBubbleStatusTone(status, active);
  const bodyVisible = !expandable || expanded;
  const rootClassName = [
    "conversation-operation-bubble",
    active ? "active" : "completed",
    `tone-${statusTone}`,
    expandable ? "expandable" : "",
    bodyVisible ? "expanded" : "collapsed",
  ].join(" ");
  return (
    <div className={rootClassName} aria-label={ariaLabel}>
      <OperationBubbleHeader
        icon={operationBubbleStatusIcon(statusTone)}
        sourceLabel={sourceLabel}
        statusLabel={statusLabel}
        actions={actions}
        expandable={expandable}
        expanded={bodyVisible}
        toggleLabel={toggleLabel}
        onToggleExpanded={onToggleExpanded}
      />
      {bodyVisible ? children : null}
    </div>
  );
}

function operationBubbleStatusTone(status: string, active: boolean): "running" | "waiting" | "success" | "failed" | "neutral" {
  if (status === "waiting_for_approval") {
    return "waiting";
  }
  if (status === "failed" || status === "blocked") {
    return "failed";
  }
  if (status === "cancelled" || status === "superseded") {
    return "neutral";
  }
  if (status === "succeeded") {
    return "success";
  }
  return active ? "running" : "neutral";
}

function operationBubbleStatusIcon(tone: "running" | "waiting" | "success" | "failed" | "neutral"): ReactNode {
  if (tone === "running") {
    return <Activity size={14} />;
  }
  if (tone === "waiting") {
    return <ShieldCheck size={14} />;
  }
  if (tone === "success") {
    return <CheckCircle2 size={14} />;
  }
  if (tone === "failed") {
    return <CircleAlert size={14} />;
  }
  return <Clock3 size={14} />;
}
