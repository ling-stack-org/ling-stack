import { WorkSummaryPanel } from "../work-summary/WorkSummaryPanel.js";
import type { CSSProperties, ReactNode } from "react";
import { useI18n } from "../../../i18n.js";
import { Popover, PopoverAnchor, PopoverContent } from "../../../shared/ui/index.js";
import type { ConversationPanelMotionState } from "../useConversationPanelPresence.js";

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
  readonly onOpenChanges: (cwd: string) => void;
  readonly open: boolean;
  readonly title: string;
  readonly subtitle?: string;
  readonly rows: readonly ConversationSummaryRow[];
  readonly className?: string;
  readonly dockOffset?: number;
  readonly dockMotion?: string;
  readonly motionState: ConversationPanelMotionState;
  readonly onClose: () => void;
}

export function ConversationSummaryPopover({
  open,
  title,
  subtitle,
  rows,
  className,
  dockOffset = 0,
  dockMotion,
  motionState,
  onClose,
  onOpenChanges,
}: ConversationSummaryPopoverProps): React.JSX.Element {
  const { t } = useI18n();
  const resolvedClassName = [
    "conversation-summary-layer",
    open ? "is-popover-expanded" : "is-popover-collapsed",
    className,
  ].filter(Boolean).join(" ");

  return (
    <Popover open={open} onOpenChange={(nextOpen) => {
      if (!nextOpen) onClose();
    }}>
      <PopoverAnchor asChild>
        <span className="conversation-summary-anchor" aria-hidden="true" />
      </PopoverAnchor>
      <PopoverContent
        className={resolvedClassName}
        size="content"
        side="bottom"
        align="end"
        sideOffset={8}
        data-summary-placement-motion={dockMotion}
        data-right-dock-motion={motionState}
        data-resizing={motionState === "resizing" ? "true" : undefined}
        data-computer-use-obstacle="true"
        data-computer-use-obstacle-kind="summary"
        style={{ "--conversation-summary-dock-offset": `${dockOffset}px` } as CSSProperties}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
      >
        <WorkSummaryPanel visible={open} onClose={onClose} onOpenChanges={onOpenChanges}>
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
        </WorkSummaryPanel>
      </PopoverContent>
    </Popover>
  );
}
