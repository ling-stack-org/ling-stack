import type { ReactNode } from "react";
import { Check } from "lucide-react";
import { useI18n } from "../../../i18n.js";
import { CopyActionButton } from "../feedback/CopyActionButton.js";

export interface MessageFooterAction {
  readonly id: string;
  readonly label: string;
  readonly icon?: ReactNode;
  readonly disabled?: boolean;
  readonly danger?: boolean;
  readonly className?: string;
  readonly href?: string;
  readonly target?: string;
  readonly rel?: string;
  readonly copyText?: string;
  readonly onClick?: () => void;
}

export interface MessageFooterActionsProps {
  readonly className?: string;
  readonly actions: readonly MessageFooterAction[];
}

export function MessageFooterActions({
  className,
  actions,
}: MessageFooterActionsProps): JSX.Element | null {
  const { t } = useI18n();
  const visibleActions = actions.filter((action) => action.href || action.onClick || action.copyText);
  if (visibleActions.length === 0) {
    return null;
  }

  const rootClassName = ["message-footer-actions", className].filter(Boolean).join(" ");

  return (
    <div className={rootClassName}>
      {visibleActions.map((action) => {
        const actionClassName = [
          "message-footer-action",
          action.className,
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
              copiedLabel={t("Copied")}
              iconSize={11}
              idleContent={content}
              copiedContent={(
                <>
                  <Check size={11} />
                  <span>{t("Copied")}</span>
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
