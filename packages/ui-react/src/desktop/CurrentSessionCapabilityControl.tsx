import type { HTMLAttributes, ReactNode } from "react";
import { IconButton } from "../controls/IconButton.js";
import { StatusIndicator, type StatusTone } from "../feedback/StatusIndicator.js";
import { mergeClassNames } from "../shared/merge-class-names.js";

export interface CapabilityAction {
  readonly describedBy?: string;
  readonly disabled?: boolean;
  readonly icon: ReactNode;
  readonly id: string;
  readonly label: string;
  readonly loading?: boolean;
  readonly onClick?: () => void;
  readonly pressed?: boolean;
  readonly tone?: "default" | "danger";
}

export interface CapabilityIssue {
  readonly attributes?: Readonly<Record<string, string | boolean | undefined>>;
  readonly id?: string;
  readonly message: ReactNode;
  readonly tone: "warning" | "danger";
}

export interface CurrentSessionCapabilityControlProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  readonly actions: readonly CapabilityAction[];
  readonly issue?: CapabilityIssue;
  readonly label: string;
  readonly statusLabel: string;
  readonly tone?: StatusTone;
}

export function CurrentSessionCapabilityControl({
  actions,
  className,
  issue,
  label,
  statusLabel,
  tone = "neutral",
  ...props
}: CurrentSessionCapabilityControlProps) {
  return (
    <div
      {...props}
      className={mergeClassNames("ling-ui-capability-control", className)}
      data-has-issue={issue ? "true" : undefined}
      data-tone={tone}
    >
      <div className="ling-ui-capability-control-identity">
        <span className="ling-ui-capability-control-label" title={label}>{label}</span>
        <StatusIndicator
          aria-atomic="true"
          aria-live="polite"
          label={statusLabel}
          role="status"
          tone={tone}
        />
      </div>
      <div className="ling-ui-capability-control-actions">
        {actions.map((action) => (
          <IconButton
            key={action.id}
            aria-describedby={action.describedBy}
            disabled={action.disabled}
            icon={action.icon}
            label={action.label}
            loading={action.loading}
            onClick={action.onClick}
            pressed={action.pressed}
            variant={action.tone === "danger" ? "danger" : "ghost"}
          />
        ))}
      </div>
      {issue ? (
        <div
          {...issue.attributes}
          id={issue.id}
          className="ling-ui-capability-control-issue"
          data-tone={issue.tone}
          role={issue.tone === "danger" ? "alert" : "status"}
        >
          {issue.message}
        </div>
      ) : null}
    </div>
  );
}
