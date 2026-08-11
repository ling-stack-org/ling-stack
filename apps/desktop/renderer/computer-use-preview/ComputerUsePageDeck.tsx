import {
  Button,
  IconButton,
  Popover,
  PopoverContent,
  PopoverTrigger,
  StatusIndicator,
} from "@ling-stack/ui-react";
import { X } from "lucide-react";
import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { ComputerUsePreviewController } from "./preview-controller.js";
import type {
  ComputerUsePipAvailablePageViewModel,
  ComputerUsePipPageDeckViewModel,
  ComputerUsePipResidentPageViewModel,
} from "./page-deck-view-model.js";
import type { ComputerUsePreviewTranslate } from "./messages.js";
import type { ComputerUsePageThumbnailState } from "./use-page-thumbnails.js";

export function ComputerUsePageDeck({
  children,
  controller,
  pageDeck,
  thumbnails,
  t,
}: {
  readonly children: ReactNode;
  readonly controller: ComputerUsePreviewController;
  readonly pageDeck: ComputerUsePipPageDeckViewModel | undefined;
  readonly thumbnails: ComputerUsePageThumbnailState;
  readonly t: ComputerUsePreviewTranslate;
}) {
  const [commandFailed, setCommandFailed] = useState(false);
  const [viewAllOpen, setViewAllOpen] = useState(false);
  const viewAllTriggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setCommandFailed(false);
    if (!pageDeck) {
      setViewAllOpen(false);
    }
  }, [pageDeck?.activePageId, pageDeck?.requestedPageId, Boolean(pageDeck)]);

  const activatePage = async (pageId: string, closeViewAll = false): Promise<void> => {
    setCommandFailed(false);
    if (closeViewAll) {
      setViewAllOpen(false);
    }
    const result = await controller.activatePage(pageId);
    setCommandFailed(!result.accepted);
  };

  const closePage = async (pageId: string): Promise<void> => {
    setCommandFailed(false);
    const result = await controller.closePage(pageId);
    setCommandFailed(!result.accepted);
    if (result.accepted) {
      const nextPage = pageDeck?.residentPages.find((page) => page.pageId !== pageId);
      window.requestAnimationFrame(() => {
        const target = nextPage
          ? document.querySelector<HTMLElement>(`[data-page-activate="${cssEscape(nextPage.pageId)}"]`)
          : viewAllTriggerRef.current;
        target?.focus();
      });
    }
  };

  if (!pageDeck?.showChrome) {
    return <div className="preview-frame">{children}</div>;
  }

  return (
    <>
      <PageDeckBackplates
        activatePage={activatePage}
        closePage={closePage}
        pageDeck={pageDeck}
        thumbnails={thumbnails}
        t={t}
      />
      <div className="preview-frame">{children}</div>
      <PageDeckChrome
        activatePage={activatePage}
        closePage={closePage}
        commandFailed={commandFailed}
        pageDeck={pageDeck}
        setViewAllOpen={setViewAllOpen}
        t={t}
        viewAllOpen={viewAllOpen}
        viewAllTriggerRef={viewAllTriggerRef}
      />
    </>
  );
}

function PageDeckBackplates({
  activatePage,
  closePage,
  pageDeck,
  thumbnails,
  t,
}: {
  readonly activatePage: (pageId: string) => void;
  readonly closePage: (pageId: string) => void;
  readonly pageDeck: ComputerUsePipPageDeckViewModel;
  readonly thumbnails: ComputerUsePageThumbnailState;
  readonly t: ComputerUsePreviewTranslate;
}) {
  return (
    <div className="page-deck-backplates" role="group" aria-label={t("pageDeckLabel")}>
      {pageDeck.inactivePages.slice(0, 4).map((page, index) => (
        <article
          className="page-deck-card"
          data-presentation-state={page.presentationState}
          key={page.pageId}
          style={{ "--page-stack-index": index } as CSSProperties}
        >
          <Button
            aria-label={pageAriaLabel(page, t)}
            className="page-deck-card-activate"
            data-page-activate={page.pageId}
            onClick={() => activatePage(page.pageId)}
            size="sm"
            variant="ghost"
          >
            <PageThumbnail page={page} source={thumbnails.get(page.pageId)} revision={thumbnails.revision} />
            <span className="page-deck-card-copy">
              <strong>{page.targetLabel}</strong>
              <small>{pageRuntimeStatusLabel(page.runtimeStatus, t)}</small>
            </span>
          </Button>
          <IconButton
            className="page-deck-card-close"
            data-page-close={page.pageId}
            icon={X}
            label={t("closePageAction", { target: page.targetLabel })}
            onClick={() => closePage(page.pageId)}
            size="sm"
            tooltip=""
          />
        </article>
      ))}
    </div>
  );
}

function PageDeckChrome({
  activatePage,
  closePage,
  commandFailed,
  pageDeck,
  setViewAllOpen,
  t,
  viewAllOpen,
  viewAllTriggerRef,
}: {
  readonly activatePage: (pageId: string, closeViewAll?: boolean) => void;
  readonly closePage: (pageId: string) => void;
  readonly commandFailed: boolean;
  readonly pageDeck: ComputerUsePipPageDeckViewModel;
  readonly setViewAllOpen: (open: boolean) => void;
  readonly t: ComputerUsePreviewTranslate;
  readonly viewAllOpen: boolean;
  readonly viewAllTriggerRef: React.RefObject<HTMLButtonElement | null>;
}) {
  const activePage = pageDeck.residentPages.find((page) => page.active);
  const viewAllPanelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!viewAllOpen) {
      return undefined;
    }
    const handleOutsidePointer = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      if (
        viewAllPanelRef.current?.contains(target)
        || viewAllTriggerRef.current?.contains(target)
      ) {
        return;
      }
      setViewAllOpen(false);
    };
    document.addEventListener("pointerdown", handleOutsidePointer);
    return () => document.removeEventListener("pointerdown", handleOutsidePointer);
  }, [setViewAllOpen, viewAllOpen, viewAllTriggerRef]);
  const handleTabKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    const currentIndex = pageDeck.residentPages.findIndex(
      (page) => page.pageId === target.dataset.pageActivate,
    );
    if (currentIndex < 0) {
      return;
    }
    if (event.key === "Delete") {
      event.preventDefault();
      closePage(pageDeck.residentPages[currentIndex].pageId);
      return;
    }
    const nextIndex = tabDestination(event.key, currentIndex, pageDeck.residentPages.length);
    if (nextIndex === undefined) {
      return;
    }
    event.preventDefault();
    const nextPageId = pageDeck.residentPages[nextIndex].pageId;
    event.currentTarget
      .querySelector<HTMLElement>(`[data-page-activate="${cssEscape(nextPageId)}"]`)
      ?.focus();
  };

  return (
    <div className="page-deck-chrome">
      <div
        aria-label={t("pageDeckLabel")}
        className="page-deck-tabs"
        onKeyDown={handleTabKeyDown}
        role="tablist"
      >
        {pageDeck.residentPages.map((page) => (
          <Button
            aria-label={pageAriaLabel(page, t)}
            aria-selected={page.active}
            className={`page-deck-tab${page.active ? " active" : ""}${page.requested ? " requested" : ""}`}
            data-page-activate={page.pageId}
            key={page.pageId}
            onClick={() => activatePage(page.pageId)}
            role="tab"
            size="sm"
            tabIndex={page.requested || (page.active && !pageDeck.requestedPageId) ? 0 : -1}
            variant="ghost"
          >
            {page.targetLabel}
          </Button>
        ))}
      </div>
      <div className="page-deck-actions">
        {activePage ? (
          <IconButton
            className="page-deck-close-active"
            data-page-close={activePage.pageId}
            icon={X}
            label={t("closePageAction", { target: activePage.targetLabel })}
            onClick={() => closePage(activePage.pageId)}
            size="sm"
            tooltip=""
          />
        ) : null}
        <Popover modal={false} onOpenChange={setViewAllOpen} open={viewAllOpen}>
          <PopoverTrigger asChild>
            <Button
              aria-expanded={viewAllOpen}
              className="page-deck-view-all"
              ref={viewAllTriggerRef}
              size="sm"
              variant="secondary"
            >
              {t("viewAllPagesAction", { count: pageDeck.availablePages.length })}
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="end"
            aria-label={t("availablePagesLabel")}
            className="page-deck-view-all-panel"
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              window.requestAnimationFrame(() => {
                document.querySelector<HTMLElement>(
                  '.page-deck-view-all-panel [data-page-activate]',
                )?.focus();
              });
            }}
            role="dialog"
            ref={viewAllPanelRef}
            side="top"
            size="content"
          >
            {pageDeck.availablePages.map((page) => (
              <ViewAllPageRow
                activatePage={activatePage}
                closePage={closePage}
                key={page.pageId}
                page={page}
                t={t}
              />
            ))}
          </PopoverContent>
        </Popover>
      </div>
      {commandFailed ? (
        <span className="page-deck-command-failure" role="alert">{t("failedLabel")}</span>
      ) : null}
    </div>
  );
}

function ViewAllPageRow({
  activatePage,
  closePage,
  page,
  t,
}: {
  readonly activatePage: (pageId: string, closeViewAll?: boolean) => void;
  readonly closePage: (pageId: string) => void;
  readonly page: ComputerUsePipAvailablePageViewModel;
  readonly t: ComputerUsePreviewTranslate;
}) {
  const status = pageRuntimeStatusLabel(page.runtimeStatus, t);
  return (
    <div className="page-deck-view-all-row" data-resident={page.resident}>
      <Button
        aria-current={page.active ? "page" : false}
        className="page-deck-view-all-item"
        data-page-activate={page.pageId}
        onClick={() => activatePage(page.pageId, true)}
        size="sm"
        variant="ghost"
      >
        <span className="page-deck-view-all-copy">
          <strong>{page.targetLabel}</strong>
          <StatusIndicator compact label={status} tone={runtimeStatusTone(page.runtimeStatus)} />
        </span>
      </Button>
      {page.resident ? (
        <IconButton
          className="page-deck-view-all-close"
          data-page-close={page.pageId}
          icon={X}
          label={t("closePageAction", { target: page.targetLabel })}
          onClick={() => closePage(page.pageId)}
          size="sm"
          tooltip=""
        />
      ) : null}
    </div>
  );
}

function PageThumbnail({
  page,
  revision,
  source,
}: {
  readonly page: ComputerUsePipResidentPageViewModel;
  readonly revision: number;
  readonly source: HTMLCanvasElement | undefined;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    if (!source || !canvasRef.current) {
      return;
    }
    const canvas = canvasRef.current;
    canvas.width = source.width;
    canvas.height = source.height;
    canvas.getContext("2d")?.drawImage(source, 0, 0);
  }, [revision, source]);
  if (!source) {
    return (
      <span aria-hidden="true" className="page-deck-card-placeholder">
        {page.targetLabel.trim().slice(0, 1).toLocaleUpperCase() || "•"}
      </span>
    );
  }
  return <canvas aria-hidden="true" className="page-deck-card-thumbnail" ref={canvasRef} />;
}

function pageAriaLabel(
  page: ComputerUsePipResidentPageViewModel,
  t: ComputerUsePreviewTranslate,
): string {
  return t("pagePositionLabel", {
    target: page.targetLabel,
    status: pageRuntimeStatusLabel(page.runtimeStatus, t),
    position: page.position,
    count: page.count,
  });
}

function pageRuntimeStatusLabel(
  status: ComputerUsePipResidentPageViewModel["runtimeStatus"],
  t: ComputerUsePreviewTranslate,
): string {
  if (status === "failed") return t("failedLabel");
  if (status === "succeeded") return t("completedLabel");
  if (status === "cancelled") return t("stoppedLabel");
  if (status === "stopping") return t("stoppingLabel");
  if (status === "waiting_for_approval") return t("approvalRequiredLabel");
  if (status === "paused") return t("pausedLabel");
  if (status === "starting") return t("connectingLabel");
  return t("liveLabel");
}

function runtimeStatusTone(
  status: ComputerUsePipResidentPageViewModel["runtimeStatus"],
): "neutral" | "success" | "warning" | "danger" {
  if (status === "failed") return "danger";
  if (status === "succeeded") return "success";
  if (status === "waiting_for_approval" || status === "stopping") return "warning";
  return "neutral";
}

function tabDestination(key: string, current: number, count: number): number | undefined {
  if (key === "ArrowRight" || key === "ArrowDown") return (current + 1) % count;
  if (key === "ArrowLeft" || key === "ArrowUp") return (current - 1 + count) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return undefined;
}

function cssEscape(value: string): string {
  return globalThis.CSS?.escape ? globalThis.CSS.escape(value) : value.replace(/[^A-Za-z0-9_-]/g, "\\$&");
}
