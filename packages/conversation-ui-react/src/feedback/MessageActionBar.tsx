import { useState, type ReactElement, type ReactNode } from "react";
import { Check, Loader2 } from "lucide-react";
import { Tooltip } from "@ling-stack/ui-react";
import {
  conversationActionAllowedByPolicy,
  getConversationSurfacePolicy,
  type MessageActionKind,
  type ConversationSurfaceKind,
  type ConversationSurfacePolicy,
} from "@ling-stack/conversation-ui-core";

export type { MessageActionKind };

export interface MessageActionBarAction {
  readonly id: string;
  readonly kind: MessageActionKind;
  readonly label: string;
  readonly icon?: ReactNode;
  readonly selected?: boolean;
  readonly disabled?: boolean;
  readonly loading?: boolean;
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
        const unavailable = action.disabled || action.loading;
        const actionClassName = [
          "message-footer-action",
          "message-action-bar-action",
          action.kind === "reply_topic" ? "message-reply-button" : "",
          action.className,
          action.selected ? "selected" : "",
          action.danger ? "danger" : "",
          action.loading ? "loading" : "",
        ].filter(Boolean).join(" ");
        const content = (
          <>
            {action.loading ? <Loader2 className="message-action-bar-spinner" aria-hidden="true" /> : action.icon}
            <span className="message-action-bar-label">{action.label}</span>
          </>
        );
        if (action.href) {
          return (
            <MessageActionTooltip key={action.id} label={action.label}>
              <a
                className={actionClassName}
                href={action.href}
                target={action.target}
                rel={action.rel}
                aria-label={action.label}
                aria-busy={action.loading || undefined}
                aria-disabled={unavailable || undefined}
                tabIndex={unavailable ? -1 : undefined}
                onClick={unavailable ? (event) => event.preventDefault() : undefined}
              >
                {content}
              </a>
            </MessageActionTooltip>
          );
        }
        if (action.copyText !== undefined) {
          return (
            <MessageActionBarCopyButton
              key={action.id}
              action={action}
              actionClassName={actionClassName}
              copiedLabel={copiedLabel}
            />
          );
        }
        return (
          <MessageActionTooltip key={action.id} label={action.label}>
            <button
              className={actionClassName}
              type="button"
              disabled={unavailable}
              aria-busy={action.loading || undefined}
              onClick={action.onClick}
              aria-label={action.label}
            >
              {content}
            </button>
          </MessageActionTooltip>
        );
      })}
    </div>
  );
}

interface MessageActionTooltipProps {
  readonly children: ReactElement;
  readonly label: string;
}

function MessageActionTooltip({ children, label }: MessageActionTooltipProps): JSX.Element {
  return (
    <Tooltip content={label} side="top" sideOffset={6}>
      <span className="message-action-bar-tooltip-trigger">{children}</span>
    </Tooltip>
  );
}

interface MessageActionBarCopyButtonProps {
  readonly action: MessageActionBarAction;
  readonly actionClassName: string;
  readonly copiedLabel: string;
}

function MessageActionBarCopyButton({
  action,
  actionClassName,
  copiedLabel,
}: MessageActionBarCopyButtonProps): JSX.Element {
  const [copied, setCopied] = useState(false);
  const currentLabel = copied ? copiedLabel : action.label;
  const unavailable = action.disabled || action.loading;

  async function copyText(): Promise<void> {
    if (!globalThis.navigator?.clipboard?.writeText) {
      setCopied(false);
      return;
    }

    try {
      await globalThis.navigator.clipboard.writeText(action.copyText ?? "");
      setCopied(true);
      globalThis.setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
    }
  }

  return (
    <MessageActionTooltip label={currentLabel}>
      <button
        className={actionClassName}
        type="button"
        disabled={unavailable}
        aria-busy={action.loading || undefined}
        aria-label={currentLabel}
        onClick={() => void copyText()}
      >
        {action.loading ? (
          <Loader2 className="message-action-bar-spinner" aria-hidden="true" />
        ) : copied ? (
          <Check aria-hidden="true" />
        ) : action.icon}
        <span className="message-action-bar-label">{currentLabel}</span>
      </button>
    </MessageActionTooltip>
  );
}
