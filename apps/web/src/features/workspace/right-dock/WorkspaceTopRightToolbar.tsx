import {
  ConversationToolbar,
  ConversationToolbarActionButton,
  ConversationToolbarCountBadge,
  ConversationToolbarIconButton,
  type ConversationToolbarActionButtonProps,
  type ConversationToolbarCountBadgeProps,
  type ConversationToolbarIconButtonProps,
  type ConversationToolbarProps,
} from "../../../shared/conversation/index.js";
import { forwardRef } from "react";

function joinClassNames(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}

export type WorkspaceTopRightToolbarProps = ConversationToolbarProps;

export function WorkspaceTopRightToolbar({
  ariaLabel,
  className,
  ...props
}: WorkspaceTopRightToolbarProps): React.JSX.Element {
  return (
    <ConversationToolbar
      {...props}
      className={joinClassNames("workspace-top-right-toolbar", className)}
      ariaLabel={ariaLabel}
    />
  );
}

export type WorkspaceToolbarCountBadgeProps = ConversationToolbarCountBadgeProps;

export function WorkspaceToolbarCountBadge({
  className,
  ...props
}: WorkspaceToolbarCountBadgeProps): React.JSX.Element {
  return (
    <ConversationToolbarCountBadge
      {...props}
      className={joinClassNames("workspace-toolbar-count-badge", className)}
    />
  );
}

export type WorkspaceToolbarIconButtonProps = ConversationToolbarIconButtonProps;

export const WorkspaceToolbarIconButton = forwardRef<HTMLButtonElement, WorkspaceToolbarIconButtonProps>(
  function WorkspaceToolbarIconButton(
    {
      active = false,
      className,
      ...props
    },
    ref,
  ) {
    return (
      <ConversationToolbarIconButton
        {...props}
        ref={ref}
        active={active}
        className={joinClassNames("workspace-toolbar-icon-button", active && "active", className)}
      />
    );
  },
);

export type WorkspaceToolbarActionButtonProps = ConversationToolbarActionButtonProps;

export const WorkspaceToolbarActionButton = forwardRef<HTMLButtonElement, WorkspaceToolbarActionButtonProps>(
  function WorkspaceToolbarActionButton(
    {
      active = false,
      className,
      ...props
    },
    ref,
  ) {
    return (
      <ConversationToolbarActionButton
        {...props}
        ref={ref}
        active={active}
        className={joinClassNames("workspace-toolbar-action-button", active && "active", className)}
      />
    );
  },
);
