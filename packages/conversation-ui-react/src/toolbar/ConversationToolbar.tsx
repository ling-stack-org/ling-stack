import {
  Button,
  IconButton,
  Tooltip,
  type ButtonProps,
  type IconButtonProps,
} from "@ling-stack/ui-react";
import type { HTMLAttributes, ReactNode } from "react";
import { forwardRef } from "react";

function mergeClassNames(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}

export interface ConversationToolbarProps extends Omit<HTMLAttributes<HTMLDivElement>, "aria-label"> {
  readonly ariaLabel: string;
}

export function ConversationToolbar({
  ariaLabel,
  children,
  className,
  ...props
}: ConversationToolbarProps): JSX.Element {
  return (
    <div
      {...props}
      className={mergeClassNames("ling-conversation-toolbar", className)}
      data-conversation-toolbar="true"
      aria-label={ariaLabel}
      role="toolbar"
    >
      {children}
    </div>
  );
}

export interface ConversationToolbarCountBadgeProps {
  readonly className?: string;
  readonly count: number | string;
}

export function ConversationToolbarCountBadge({
  className,
  count,
}: ConversationToolbarCountBadgeProps): JSX.Element {
  return (
    <span
      className={mergeClassNames("ling-conversation-toolbar-count", className)}
      data-conversation-count="true"
      aria-hidden="true"
    >
      {count}
    </span>
  );
}

export interface ConversationToolbarIconButtonProps extends Omit<IconButtonProps, "pressed"> {
  readonly actionId?: string;
  readonly active?: boolean;
  readonly count?: number;
}

export const ConversationToolbarIconButton = forwardRef<HTMLButtonElement, ConversationToolbarIconButtonProps>(
  function ConversationToolbarIconButton(
    {
      actionId,
      active = false,
      className,
      count,
      label,
      tooltip,
      ...props
    },
    ref,
  ) {
    return (
      <span
        className="ling-conversation-toolbar-button-frame"
        data-active={active ? "true" : undefined}
        data-conversation-toolbar-frame="icon"
      >
        <IconButton
          {...props}
          ref={ref}
          className={mergeClassNames("ling-conversation-toolbar-icon-button", className)}
          data-active={active ? "true" : undefined}
          data-conversation-action={actionId}
          label={label}
          pressed={active ? true : undefined}
          size="sm"
          tooltip={tooltip ?? label}
          variant="ghost"
        />
        {typeof count === "number" && count > 0 ? <ConversationToolbarCountBadge count={count} /> : null}
      </span>
    );
  },
);

export interface ConversationToolbarActionButtonProps extends Omit<ButtonProps, "children" | "leadingIcon"> {
  readonly actionId?: string;
  readonly active?: boolean;
  readonly count?: number;
  readonly icon: ReactNode;
  readonly label: string;
  readonly tooltip?: string;
  readonly visibleLabel: string;
}

export const ConversationToolbarActionButton = forwardRef<HTMLButtonElement, ConversationToolbarActionButtonProps>(
  function ConversationToolbarActionButton(
    {
      actionId,
      active = false,
      className,
      count,
      icon,
      label,
      tooltip = label,
      visibleLabel,
      ...props
    },
    ref,
  ) {
    const button = (
      <Button
        {...props}
        ref={ref}
        className={mergeClassNames("ling-conversation-toolbar-action-button", className)}
        data-active={active ? "true" : undefined}
        data-conversation-action={actionId}
        aria-label={props["aria-label"] ?? label}
        aria-pressed={active ? true : undefined}
        leadingIcon={icon}
        size="sm"
        title={props.title ?? label}
        variant="ghost"
      >
        {visibleLabel}
      </Button>
    );

    return (
      <span
        className="ling-conversation-toolbar-action-frame"
        data-active={active ? "true" : undefined}
        data-conversation-toolbar-frame="action"
      >
        {tooltip ? <Tooltip content={tooltip}>{button}</Tooltip> : button}
        {typeof count === "number" && count > 0 ? (
          <ConversationToolbarCountBadge className="ling-conversation-toolbar-count-inline" count={count} />
        ) : null}
      </span>
    );
  },
);
