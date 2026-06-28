import type { ReactNode } from "react";
import { Check } from "lucide-react";
import {
  conversationActionAllowedByPolicy,
  getConversationSurfacePolicy,
  type MessageActionKind,
  type ConversationSurfaceKind,
  type ConversationSurfacePolicy,
} from "@ling-stack/conversation-ui-core";
import { CopyActionButton } from "./CopyActionButton.js";

export type { MessageActionKind };

export interface MessageActionBarAction {
  readonly id: string;
  readonly kind: MessageActionKind;
  readonly label: string;
  readonly icon?: ReactNode;
  readonly selected?: boolean;
  readonly disabled?: boolean;
  readonly danger?: boolean;
  readonly className?: string;
  readonly href?: string;
  readonly target?: string;
  readonly rel?: string;
  readonly copyText?: string;
  readonly onClick?: () => void;
}

export interface MessageActionBarProps {
  readonly surface: ConversationSurfaceKind;
  readonly policy?: Partial<ConversationSurfacePolicy>;
  readonly className?: string;
  readonly actions: readonly MessageActionBarAction[];
  readonly visibility?: "hover-focus" | "always" | "critical";
  readonly copiedLabel?: string;
}

export function MessageActionBar({
  surface,
  policy,
  className,
  actions,
  copiedLabel = "Copied",
  visibility = "hover-focus",
}: MessageActionBarProps): JSX.Element | null {
  const resolvedPolicy = {
    ...getConversationSurfacePolicy(surface),
    ...policy,
    surface,
  };
  const visibleActions = actions
    .filter((action) => action.href || action.onClick || action.copyText !== undefined)
    .filter((action) => conversationActionAllowedByPolicy(action.kind, resolvedPolicy));
  if (visibleActions.length === 0) {
    return null;
  }

  const rootClassName = [
    "message-footer-actions",
    "message-action-bar",
    `message-action-bar-${visibility}`,
    className,
  ].filter(Boolean).join(" ");

  return (
    <div className={rootClassName}>
      {visibleActions.map((action) => {
        const actionClassName = [
          "message-footer-action",
          "message-action-bar-action",
          action.kind === "reply_topic" ? "message-reply-button" : "",
          action.className,
          action.selected ? "selected" : "",
          action.danger ? "danger" : "",
        ].filter(Boolean).join(" ");
        const content = (
          <>
            {action.icon}
            <span>{action.label}</span>
          </>
        );
        if (action.href) {
          return (
            <a
              key={action.id}
              className={actionClassName}
              href={action.href}
              target={action.target}
              rel={action.rel}
              aria-label={action.label}
              title={action.label}
              data-tooltip={action.label}
            >
              {content}
            </a>
          );
        }
        if (action.copyText !== undefined) {
          return (
            <CopyActionButton
              key={action.id}
              className={actionClassName}
              text={action.copyText}
              label={action.label}
              copiedLabel={copiedLabel}
              iconSize={11}
              idleContent={content}
              copiedContent={(
                <>
                  <Check size={11} />
                  <span>{copiedLabel}</span>
                </>
              )}
            />
          );
        }
        return (
          <button
            key={action.id}
            className={actionClassName}
            type="button"
            disabled={action.disabled}
            onClick={action.onClick}
            aria-label={action.label}
            title={action.label}
            data-tooltip={action.label}
          >
            {content}
          </button>
        );
      })}
    </div>
  );
}
