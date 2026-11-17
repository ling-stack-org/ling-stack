import { useEffect, useRef, useState } from "react";
import { ChevronUp, FileDiff } from "lucide-react";
import type { WorkspaceChangeReview } from "@ling-stack/contracts";
import { useI18n } from "../../../i18n.js";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "../../ui/index.js";
import { isChangeSummaryTurnActive } from "./change-summary-observer.js";
import { useConversationChangeSummary } from "./useConversationChangeSummary.js";

export interface ConversationChangeReviewTarget {
  readonly cwd: string;
  readonly scope: WorkspaceChangeReview["scope"];
  readonly path?: string;
  readonly liveThreadId: string;
}

export function ConversationChangeSummary(props: {
  readonly cwd: string;
  readonly threadId?: string;
  readonly active: boolean;
  readonly submitting: boolean;
  readonly onOpenReview: (target: ConversationChangeReviewTarget) => void;
}): React.JSX.Element | null {
  const { t, locale } = useI18n();
  const threadId = props.threadId;
  const summary = useConversationChangeSummary(props);
  const review = summary?.review;
  const [openScope, setOpenScope] = useState("");
  const scope = review?.files.length ? JSON.stringify([props.cwd, props.threadId, summary?.turn?.id]) : "";
  const open = Boolean(scope) && openScope === scope;
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const keyboardOpen = useRef(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const restoreTriggerFocus = useRef(false);
  const cancelClose = () => clearTimeout(closeTimer.current);
  const hoverOpen = () => { cancelClose(); setOpenScope(scope); };
  const hoverClose = () => {
    cancelClose();
    if (!keyboardOpen.current) closeTimer.current = setTimeout(() => setOpenScope(""), 180);
  };
  useEffect(() => () => clearTimeout(closeTimer.current), []);
  useEffect(() => { cancelClose(); keyboardOpen.current = false; setOpenScope(""); }, [scope]);
  if (!review || !threadId || !summary?.turn || review.state === "exact" && !review.files.length) return null;
  const running = isChangeSummaryTurnActive(summary?.turn?.status);
  const label = review.files.length ? running
    ? t("Editing {target}", { target: t("{count} files", { count: review.files.length }) })
    : t("Edited {count} files", { count: review.files.length }) : t("Historical diff unavailable");
  const openReview = (path?: string) => {
    cancelClose(); setOpenScope(""); keyboardOpen.current = false;
    props.onOpenReview({ cwd: props.cwd.trim(), scope: review.scope, path, liveThreadId: threadId });
  };
  const counts = (additions: number | undefined, deletions: number | undefined) => additions !== undefined && deletions !== undefined ? (
    <span className="conversation-change-summary-counts">
      <span className="add">+{additions.toLocaleString(locale)}</span>
      <span className="delete">−{deletions.toLocaleString(locale)}</span>
    </span>
  ) : null;
  return (
    <div className="conversation-change-summary" data-conversation-change-summary={summary.turn.id} data-change-summary-revision={review.revision}>
      <Popover open={open} onOpenChange={(value) => { keyboardOpen.current = value; setOpenScope(value ? scope : ""); }}>
        <PopoverAnchor asChild>
          <div className="conversation-change-summary-chip" onPointerEnter={(event) => { if (event.pointerType === "mouse") hoverOpen(); }} onPointerLeave={hoverClose}>
            <button type="button" className="conversation-change-summary-main" title={t("View changes")} onClick={() => openReview()}>
              <FileDiff size={14} aria-hidden="true" />
              <span aria-live="polite" aria-atomic="true">{label}</span>
              {review.state === "exact" ? counts(review.additions, review.deletions) : review.files.length ? <small>{t("Partial statistics")}</small> : null}
            </button>
            {review.files.length ? <PopoverTrigger asChild>
              <button ref={triggerRef} type="button" className="conversation-change-summary-list-trigger" aria-label={t("Changed files")}
                onClick={(event) => {
                  event.preventDefault(); keyboardOpen.current = true; hoverOpen();
                  contentRef.current?.querySelector<HTMLButtonElement>("li button")?.focus();
                }}>
                <ChevronUp size={14} aria-hidden="true" />
              </button>
            </PopoverTrigger> : null}
          </div>
        </PopoverAnchor>
        <PopoverContent ref={contentRef} side="top" align="center" size="content" className="conversation-change-summary-popover" aria-label={t("Changed files")}
          onOpenAutoFocus={(event) => { if (!keyboardOpen.current) event.preventDefault(); }}
          onEscapeKeyDown={() => { restoreTriggerFocus.current = true; }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (restoreTriggerFocus.current) { restoreTriggerFocus.current = false; triggerRef.current?.focus(); }
          }}
          onPointerEnter={cancelClose} onPointerLeave={hoverClose}>
          <div className="conversation-change-summary-heading">{t("Changed files")}</div>
          {review.state !== "exact" ? <p className="conversation-change-summary-incomplete">{t("Historical diff unavailable")}</p> : null}
          <ul className="conversation-change-summary-files">
            {review.files.map((file) => (
              <li key={file.id}>
                <button type="button" title={file.path} onClick={() => openReview(file.path)} aria-label={file.path}>
                  <span className="conversation-change-summary-kind" aria-label={t(file.kind === "added" ? "Create files" : file.kind === "deleted" ? "Delete" : "Modify files")}>
                    {file.kind === "added" ? "A" : file.kind === "deleted" ? "D" : "M"}
                  </span>
                  <span className="conversation-change-summary-path">{file.path}</span>
                  {file.state === "exact" ? counts(file.additions, file.deletions) : <small>{t("Unavailable")}</small>}
                </button>
              </li>
            ))}
          </ul>
        </PopoverContent>
      </Popover>
    </div>
  );
}
