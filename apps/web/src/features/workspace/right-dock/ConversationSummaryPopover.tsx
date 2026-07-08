import { useEffect, type ReactNode } from "react";
import { useI18n } from "../../../i18n.js";

export type ConversationSummaryTone = "success" | "running" | "waiting" | "blocked" | "failed" | "neutral";

export interface ConversationSummaryRow {
  readonly id: string;
  readonly icon: ReactNode;
  readonly tone?: ConversationSummaryTone;
  readonly primary: string;
  readonly secondary?: string;
  readonly onOpen?: () => void;
}

export interface ConversationSummaryPopoverProps {
  readonly title: string;
  readonly subtitle?: string;
  readonly rows: readonly ConversationSummaryRow[];
  readonly onClose?: () => void;
}

export function ConversationSummaryPopover({
  title,
  subtitle,
  rows,
  onClose,
}: ConversationSummaryPopoverProps): JSX.Element {
  const { t } = useI18n();

  useEffect(() => {
    if (!onClose) {
      return undefined;
    }
    const close = onClose;
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        close();
      }
    }
    globalThis.addEventListener("keydown", handleKeyDown);
    return () => {
      globalThis.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  return (
    <section className="attention-queue compact conversation-summary-popover" aria-label={title}>
      <div className="attention-section-head conversation-summary-head">
        <strong>{title}</strong>
        {subtitle ? <small>{subtitle}</small> : null}
      </div>
      <div className="attention-environment-list conversation-summary-list" aria-label={title}>
        {rows.length > 0 ? rows.map((row) => {
          const tone = row.tone ?? "neutral";
          const content = (
            <>
              <span className={`attention-row-icon ${tone}`}>{row.icon}</span>
              <span className="attention-environment-copy">
                <strong>{row.primary}</strong>
                {row.secondary ? <small>{row.secondary}</small> : null}
              </span>
            </>
          );
          return row.onOpen ? (
            <button key={row.id} className={`attention-environment-row ${tone} interactive`} type="button" onClick={row.onOpen}>
              {content}
            </button>
          ) : (
            <div key={row.id} className={`attention-environment-row ${tone}`}>
              {content}
            </div>
          );
        }) : (
          <div className="attention-environment-row neutral">
            <span className="attention-environment-copy">
              <strong>{t("Context ready")}</strong>
            </span>
          </div>
        )}
      </div>
    </section>
  );
}
