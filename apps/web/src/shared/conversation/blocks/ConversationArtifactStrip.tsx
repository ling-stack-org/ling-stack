import { useEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Code2, FilePenLine, FileText, Image as ImageIcon, Loader2, Redo2, Undo2 } from "lucide-react";
import {
  getTurnWorkspaceChanges,
  getRunWorkspaceChanges,
  getWorkflowWorkspaceChanges,
} from "../../../api.js";
import { useI18n, type Translate } from "../../../i18n.js";
import { parseUnifiedDiff, summarizeFileChanges, type ConversationFileChange } from "../../../lib/diff-summary.js";
import type { ConversationArtifactStripChangeArtifact, ConversationArtifactStripItem, ConversationWorkspaceRecoveryTarget } from "../../../lib/conversation-work-cell.js";
import type { PreviewContentResponse, RunWorkspaceChangesResponse, TurnWorkspaceChangesResponse, WorkflowWorkspaceChangesResponse } from "../../../types.js";
import type { ArtifactPreviewLoader } from "../preview/ArtifactPreviewDrawer.js";
import {
  ConversationArtifactRecoveryDialog,
  type ConversationArtifactRecoveryAction,
} from "./ConversationArtifactRecoveryDialog.js";
import { DiffViewer } from "./DiffViewer.js";
import { WorkspaceFileOpenMenu } from "./WorkspaceFileOpenMenu.js";

const artifactHoverDelayMs = 2_000;
const artifactHoverHideDelayMs = 300;
const collapsedChangeFileCount = 3;
type WorkspaceRecoveryResponse = RunWorkspaceChangesResponse | TurnWorkspaceChangesResponse | WorkflowWorkspaceChangesResponse;

export interface ConversationWorkspaceReviewTarget {
  readonly cwd: string;
  readonly runId?: string;
  readonly path?: string;
}

export function ConversationArtifactStrip({
  items,
  cwd,
  hideChangedFileDetails = false,
  recoveryTarget,
  loadPreview,
  onOpenWorkspaceReview,
}: {
  readonly items: readonly ConversationArtifactStripItem[];
  readonly cwd?: string;
  /** Keep the compact change count while another block owns file-level details. */
  readonly hideChangedFileDetails?: boolean;
  readonly recoveryTarget?: ConversationWorkspaceRecoveryTarget;
  readonly loadPreview: ArtifactPreviewLoader;
  readonly onOpenWorkspaceReview?: (target: ConversationWorkspaceReviewTarget) => void;
}): React.JSX.Element | null {
  const { t } = useI18n();
  const artifactItems = items.filter((item) => item.kind === "artifact");
  const changedItems = items.filter((item) => item.kind === "changed" && (item.changeArtifacts?.length ?? 0) > 0);
  const hoverPreview = useArtifactHoverPreview({ cwd, loadPreview });

  if (artifactItems.length === 0 && changedItems.length === 0) {
    return null;
  }

  return (
    <div className="conversation-work-cell-artifacts" aria-label={t("Artifacts")}>
      {artifactItems.map((item) => (
        <ArtifactOutputRow
          item={item}
          cwd={cwd}
          key={item.id}
          onPreviewEnter={hoverPreview.scheduleArtifact}
          onPreviewLeave={hoverPreview.leaveSource}
          onPreviewNow={hoverPreview.showArtifactNow}
        />
      ))}
      {changedItems.map((item) => (
        <ChangedFilesGroup
          item={item}
          cwd={cwd}
          hideFileDetails={hideChangedFileDetails}
          recoveryTarget={item.recoveryTarget ?? recoveryTarget}
          key={item.id}
          loadPreview={loadPreview}
          onOpenWorkspaceReview={onOpenWorkspaceReview}
          onPreviewEnter={hoverPreview.scheduleChange}
          onPreviewLeave={hoverPreview.leaveSource}
          onPreviewNow={hoverPreview.showChangeNow}
        />
      ))}
      {hoverPreview.node}
    </div>
  );
}

function ArtifactOutputRow({
  item,
  cwd,
  onPreviewEnter,
  onPreviewLeave,
  onPreviewNow,
}: {
  readonly item: ConversationArtifactStripItem;
  readonly cwd?: string;
  readonly onPreviewEnter: (item: ConversationArtifactStripItem, element: HTMLElement) => void;
  readonly onPreviewLeave: () => void;
  readonly onPreviewNow: (item: ConversationArtifactStripItem, element: HTMLElement) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const previewable = Boolean(item.previewable && item.artifactId && cwd);
  const workspaceFilePath = item.workspaceFilePath?.trim();
  const meta = artifactItemMeta(item, t);
  const icon = item.previewKind === "image" ? <ImageIcon size={13} aria-hidden="true" /> : <FileText size={13} aria-hidden="true" />;
  const content = (
    <>
      <span className="conversation-work-cell-artifact-thumb" aria-hidden="true">
        {item.previewKind === "image" && item.href ? <img src={item.href} alt="" loading="lazy" /> : icon}
      </span>
      <span className="conversation-work-cell-artifact-copy">
        <strong>{item.label}</strong>
        {meta ? <small>{meta}</small> : null}
      </span>
    </>
  );

  const main = previewable ? (
    <button
      className="conversation-work-cell-artifact-main"
      type="button"
      aria-label={`${t("Preview")}: ${item.label}`}
      onPointerEnter={(event) => onPreviewEnter(item, event.currentTarget)}
      onPointerLeave={onPreviewLeave}
      onFocus={(event) => onPreviewNow(item, event.currentTarget)}
      onBlur={onPreviewLeave}
      onClick={(event) => onPreviewNow(item, event.currentTarget)}
    >
      {content}
    </button>
  ) : item.href ? (
    <a className="conversation-work-cell-artifact-main" href={item.href} target="_blank" rel="noreferrer" title={item.label}>
      {content}
    </a>
  ) : (
    <span className="conversation-work-cell-artifact-main">{content}</span>
  );

  return (
    <div className="conversation-work-cell-artifact-row">
      {main}
      {cwd && workspaceFilePath ? (
        <WorkspaceFileOpenMenu cwd={cwd} path={workspaceFilePath} placement="auto" />
      ) : null}
    </div>
  );
}

function ChangedFilesGroup({
  item,
  cwd,
  hideFileDetails,
  recoveryTarget,
  loadPreview,
  onOpenWorkspaceReview,
  onPreviewEnter,
  onPreviewLeave,
  onPreviewNow,
}: {
  readonly item: ConversationArtifactStripItem;
  readonly cwd?: string;
  readonly hideFileDetails: boolean;
  readonly recoveryTarget?: ConversationWorkspaceRecoveryTarget;
  readonly loadPreview: ArtifactPreviewLoader;
  readonly onOpenWorkspaceReview?: (target: ConversationWorkspaceReviewTarget) => void;
  readonly onPreviewEnter: (change: LoadedChangeFile, element: HTMLElement) => void;
  readonly onPreviewLeave: () => void;
  readonly onPreviewNow: (change: LoadedChangeFile, element: HTMLElement) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const [showAll, setShowAll] = useState(false);
  const [loadedChanges, setLoadedChanges] = useState<readonly LoadedChangeFile[]>(() => fallbackChangeFiles(item.changeArtifacts ?? []));
  const [recovery, setRecovery] = useState<WorkspaceRecoveryResponse>();
  const [recoveryStatus, setRecoveryStatus] = useState<"idle" | "loading" | "loaded" | "unavailable">("idle");
  const [recoveryAction, setRecoveryAction] = useState<ConversationArtifactRecoveryAction>();
  const recoveryActionRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const artifacts = item.changeArtifacts ?? [];
    if (!cwd || artifacts.length === 0) {
      setLoadedChanges(fallbackChangeFiles(artifacts));
      return;
    }
    let cancelled = false;
    void Promise.all(artifacts.map(async (artifact) => loadChangedArtifact({ artifact, cwd, loadPreview })))
      .then((entries) => {
        if (!cancelled) {
          setLoadedChanges(mergeLoadedChangeFiles(entries.flat()));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [cwd, item.changeArtifacts, loadPreview]);

  useEffect(() => {
    if (!cwd || !recoveryTarget) {
      setRecovery(undefined);
      setRecoveryStatus("idle");
      return;
    }
    let cancelled = false;
    setRecovery(undefined);
    setRecoveryStatus("loading");
    void getWorkspaceRecovery(cwd, recoveryTarget).then((response) => {
      if (!cancelled) {
        setRecovery(response);
        setRecoveryStatus("loaded");
      }
    }, () => {
      if (!cancelled) {
        setRecovery(undefined);
        setRecoveryStatus("unavailable");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [cwd, recoveryTarget?.id, recoveryTarget?.kind]);

  const fileCount = loadedChanges.length || item.changeArtifacts?.length || 0;
  const exactChanges = loadedChanges.filter((entry) => entry.change && entry.exact);
  const summary = exactChanges.length === loadedChanges.length && loadedChanges.length > 0
    ? summarizeFileChanges(exactChanges.map((entry) => entry.change as ConversationFileChange))
    : undefined;
  const title = fileCount === 1 ? t("Edited 1 file") : t("Edited {count} files", { count: fileCount });
  const visibleChanges = showAll ? loadedChanges : loadedChanges.slice(0, collapsedChangeFileCount);
  const hiddenCount = Math.max(0, loadedChanges.length - visibleChanges.length);
  const undoUnavailableReason = recovery?.unavailableReason ?? t("Undo is unavailable for this work");

  function openReview(path?: string): void {
    if (cwd) {
      onOpenWorkspaceReview?.({
        cwd,
        runId: recoveryTarget?.kind === "run" ? recoveryTarget.id : undefined,
        path,
      });
    }
  }

  return (
    <section className="conversation-work-cell-change-group">
      <div className="conversation-work-cell-change-summary">
        <span className="conversation-work-cell-artifact-thumb" aria-hidden="true">
          <FilePenLine size={14} />
        </span>
        <span className="conversation-work-cell-change-summary-copy">
          <strong>{title}</strong>
          {summary ? <ChangeStat additions={summary.additions} deletions={summary.deletions} /> : null}
        </span>
        <span className="conversation-work-cell-change-actions">
          {recovery?.canReapply ? (
            <button ref={recoveryActionRef} type="button" onClick={() => setRecoveryAction("reapply")}>
              <Redo2 size={13} />
              {t("Reapply")}
            </button>
          ) : recoveryTarget ? (
            <button
              ref={recoveryActionRef}
              type="button"
              onClick={() => setRecoveryAction("undo")}
              disabled={recoveryStatus !== "loaded" || !recovery?.canUndo}
              title={recovery?.canUndo ? undefined : undoUnavailableReason}
            >
              {recoveryStatus === "loading" ? <Loader2 className="spin" size={13} /> : <Undo2 size={13} />}
              {t("Undo")}
            </button>
          ) : null}
          {cwd && onOpenWorkspaceReview ? (
            <button type="button" onClick={() => openReview()}>
              <Code2 size={13} />
              {t("Review changes")}
            </button>
          ) : null}
        </span>
      </div>
      {!hideFileDetails ? <div className="conversation-work-cell-change-files">
        {visibleChanges.map((entry) => {
          const previewable = Boolean(entry.change);
          const content = (
            <>
              <code>{entry.path}</code>
              {entry.change && entry.exact ? (
                <ChangeStat additions={entry.change.additions ?? 0} deletions={entry.change.deletions ?? 0} />
              ) : null}
            </>
          );
          return previewable || (cwd && onOpenWorkspaceReview) ? (
            <button
              className="conversation-work-cell-change-file"
              type="button"
              key={entry.id}
              onPointerEnter={(event) => onPreviewEnter(entry, event.currentTarget)}
              onPointerLeave={onPreviewLeave}
              onFocus={(event) => onPreviewNow(entry, event.currentTarget)}
              onBlur={onPreviewLeave}
              onClick={(event) => {
                if (cwd && onOpenWorkspaceReview) {
                  onPreviewLeave();
                  openReview(entry.path);
                } else {
                  onPreviewNow(entry, event.currentTarget);
                }
              }}
            >
              {content}
            </button>
          ) : (
            <div className="conversation-work-cell-change-file static" key={entry.id}>{content}</div>
          );
        })}
        {hiddenCount > 0 ? (
          <button className="conversation-work-cell-change-more" type="button" onClick={() => setShowAll(true)}>
            {t("Show {count} more files", { count: hiddenCount })}
            <ChevronDown size={13} aria-hidden="true" />
          </button>
        ) : showAll && loadedChanges.length > collapsedChangeFileCount ? (
          <button className="conversation-work-cell-change-more" type="button" onClick={() => setShowAll(false)}>
            {t("Show fewer files")}
            <ChevronDown className="expanded" size={13} aria-hidden="true" />
          </button>
        ) : null}
      </div> : null}
      <ConversationArtifactRecoveryDialog
        action={recoveryAction}
        cwd={cwd}
        fileCount={recovery?.summary.fileCount ?? fileCountFromChanges(loadedChanges)}
        returnFocusRef={recoveryActionRef}
        target={recoveryTarget}
        onClose={() => setRecoveryAction(undefined)}
        onRecovered={(response) => {
          setRecovery(response);
          setRecoveryStatus("loaded");
        }}
      />
    </section>
  );
}

function getWorkspaceRecovery(
  cwd: string,
  target: ConversationWorkspaceRecoveryTarget,
): Promise<WorkspaceRecoveryResponse> {
  return target.kind === "workflow"
    ? getWorkflowWorkspaceChanges(cwd, target.id)
    : target.kind === "turn"
      ? getTurnWorkspaceChanges(cwd, target.id)
    : getRunWorkspaceChanges(cwd, target.id);
}

function fileCountFromChanges(changes: readonly LoadedChangeFile[]): number {
  return new Set(changes.map((change) => change.path)).size;
}

function ChangeStat({ additions, deletions }: { readonly additions: number; readonly deletions: number }): React.JSX.Element {
  return (
    <span className="conversation-work-cell-change-stat">
      <span className="add">+{additions}</span>
      <span className="delete">-{deletions}</span>
    </span>
  );
}

interface LoadedChangeFile {
  readonly id: string;
  readonly path: string;
  readonly change?: ConversationFileChange;
  readonly exact: boolean;
}

async function loadChangedArtifact(input: {
  readonly artifact: ConversationArtifactStripChangeArtifact;
  readonly cwd: string;
  readonly loadPreview: ArtifactPreviewLoader;
}): Promise<readonly LoadedChangeFile[]> {
  if (!input.artifact.artifactId || input.artifact.previewable === false) {
    return fallbackChangeFiles([input.artifact]);
  }
  try {
    const preview = await input.loadPreview({
      source: "artifact",
      cwd: input.cwd,
      artifactId: input.artifact.artifactId,
      maxBytes: 64 * 1024,
    });
    if (preview.kind !== "diff" || !preview.text?.trim()) {
      return fallbackChangeFiles([input.artifact]);
    }
    return parseUnifiedDiff(preview.text, {
      idPrefix: `artifact-strip:${input.artifact.artifactId}`,
      fallbackPath: input.artifact.path || input.artifact.label,
      status: "completed",
      artifactId: input.artifact.artifactId,
    }).map((change) => ({
      id: change.id,
      path: change.path,
      change,
      exact: !preview.truncated,
    }));
  } catch {
    return fallbackChangeFiles([input.artifact]);
  }
}

function fallbackChangeFiles(artifacts: readonly ConversationArtifactStripChangeArtifact[]): readonly LoadedChangeFile[] {
  return artifacts.map((artifact) => ({
    id: artifact.id,
    path: artifact.path || artifact.label,
    exact: false,
  }));
}

function mergeLoadedChangeFiles(entries: readonly LoadedChangeFile[]): readonly LoadedChangeFile[] {
  const byPath = new Map<string, LoadedChangeFile>();
  for (const entry of entries) {
    const existing = byPath.get(entry.path);
    if (!existing || !existing.change || !entry.change) {
      byPath.set(entry.path, entry.change ? entry : existing ?? entry);
      continue;
    }
    byPath.set(entry.path, {
      id: existing.id,
      path: entry.path,
      exact: existing.exact && entry.exact,
      change: {
        ...existing.change,
        diff: `${existing.change.diff}\n${entry.change.diff}`,
        additions: (existing.change.additions ?? 0) + (entry.change.additions ?? 0),
        deletions: (existing.change.deletions ?? 0) + (entry.change.deletions ?? 0),
      },
    });
  }
  return [...byPath.values()];
}

type HoverPreviewTarget =
  | { readonly kind: "artifact"; readonly item: ConversationArtifactStripItem; readonly preview: PreviewContentResponse }
  | { readonly kind: "change"; readonly entry: LoadedChangeFile };

interface HoverPreviewState {
  readonly target: HoverPreviewTarget;
  readonly position: CSSProperties;
}

function useArtifactHoverPreview(input: {
  readonly cwd?: string;
  readonly loadPreview: ArtifactPreviewLoader;
}): {
  readonly node: ReactNode;
  readonly scheduleArtifact: (item: ConversationArtifactStripItem, element: HTMLElement) => void;
  readonly showArtifactNow: (item: ConversationArtifactStripItem, element: HTMLElement) => void;
  readonly scheduleChange: (entry: LoadedChangeFile, element: HTMLElement) => void;
  readonly showChangeNow: (entry: LoadedChangeFile, element: HTMLElement) => void;
  readonly leaveSource: () => void;
} {
  const [preview, setPreview] = useState<HoverPreviewState | undefined>();
  const showTimerRef = useRef<number | undefined>(undefined);
  const hideTimerRef = useRef<number | undefined>(undefined);
  const requestIdRef = useRef(0);
  const previewRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!preview) {
      return;
    }
    const scrollOptions = { capture: true, passive: true } as const;
    const hide = (): void => setPreview(undefined);
    const handleScroll = (event: Event): void => {
      const target = event.target;
      if (target instanceof Node && previewRef.current?.contains(target)) {
        return;
      }
      hide();
    };
    globalThis.addEventListener("scroll", handleScroll, scrollOptions);
    globalThis.addEventListener("resize", hide);
    globalThis.addEventListener("keydown", handleEscape);
    return () => {
      globalThis.removeEventListener("scroll", handleScroll, scrollOptions);
      globalThis.removeEventListener("resize", hide);
      globalThis.removeEventListener("keydown", handleEscape);
    };

    function handleEscape(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        hide();
      }
    }
  }, [preview]);

  useEffect(() => () => {
    if (showTimerRef.current !== undefined) {
      globalThis.clearTimeout(showTimerRef.current);
    }
    if (hideTimerRef.current !== undefined) {
      globalThis.clearTimeout(hideTimerRef.current);
    }
  }, []);

  function cancelHide(): void {
    if (hideTimerRef.current !== undefined) {
      globalThis.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = undefined;
    }
  }

  function cancelPending(): void {
    requestIdRef.current += 1;
    if (showTimerRef.current !== undefined) {
      globalThis.clearTimeout(showTimerRef.current);
      showTimerRef.current = undefined;
    }
  }

  function leaveSource(): void {
    cancelPending();
    cancelHide();
    hideTimerRef.current = globalThis.setTimeout(() => {
      setPreview(undefined);
      hideTimerRef.current = undefined;
    }, artifactHoverHideDelayMs);
  }

  function scheduleArtifact(item: ConversationArtifactStripItem, element: HTMLElement): void {
    cancelHide();
    cancelPending();
    const rect = element.getBoundingClientRect();
    showTimerRef.current = globalThis.setTimeout(() => {
      showTimerRef.current = undefined;
      void showArtifact(item, rect);
    }, artifactHoverDelayMs);
  }

  function showArtifactNow(item: ConversationArtifactStripItem, element: HTMLElement): void {
    cancelHide();
    cancelPending();
    void showArtifact(item, element.getBoundingClientRect());
  }

  async function showArtifact(item: ConversationArtifactStripItem, rect: DOMRect): Promise<void> {
    if (!input.cwd || !item.artifactId || item.previewable === false) {
      return;
    }
    const requestId = ++requestIdRef.current;
    try {
      const response = await input.loadPreview({
        source: "artifact",
        cwd: input.cwd,
        artifactId: item.artifactId,
        maxBytes: 64 * 1024,
      });
      if (requestId === requestIdRef.current) {
        setPreview({
          target: { kind: "artifact", item, preview: response },
          position: hoverPreviewPosition(rect),
        });
      }
    } catch {
      // Hover previews fail silently; the owning artifact remains visible.
    }
  }

  function scheduleChange(entry: LoadedChangeFile, element: HTMLElement): void {
    if (!entry.change) {
      return;
    }
    cancelHide();
    cancelPending();
    const rect = element.getBoundingClientRect();
    showTimerRef.current = globalThis.setTimeout(() => {
      showTimerRef.current = undefined;
      setPreview({ target: { kind: "change", entry }, position: hoverPreviewPosition(rect) });
    }, artifactHoverDelayMs);
  }

  function showChangeNow(entry: LoadedChangeFile, element: HTMLElement): void {
    if (!entry.change) {
      return;
    }
    cancelHide();
    cancelPending();
    setPreview({ target: { kind: "change", entry }, position: hoverPreviewPosition(element.getBoundingClientRect()) });
  }

  const node = preview && typeof document !== "undefined"
    ? createPortal(
      <ArtifactHoverPreview
        previewRef={previewRef}
        state={preview}
        onPointerEnter={cancelHide}
        onPointerLeave={leaveSource}
      />,
      document.body,
    )
    : null;

  return {
    node,
    scheduleArtifact,
    showArtifactNow,
    scheduleChange,
    showChangeNow,
    leaveSource,
  };
}

function ArtifactHoverPreview({
  previewRef,
  state,
  onPointerEnter,
  onPointerLeave,
}: {
  readonly previewRef: RefObject<HTMLElement | null>;
  readonly state: HoverPreviewState;
  readonly onPointerEnter: () => void;
  readonly onPointerLeave: () => void;
}): React.JSX.Element {
  const target = state.target;
  const label = target.kind === "change" ? target.entry.path : target.item.label;
  const change = target.kind === "change" ? target.entry.change : previewDiffChange(target.preview, label);
  return (
    <aside
      ref={previewRef}
      className="conversation-artifact-hover-preview"
      data-desktop-window-no-drag="true"
      style={state.position}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
    >
      <header>
        <strong>{label}</strong>
        {change ? <ChangeStat additions={change.additions ?? 0} deletions={change.deletions ?? 0} /> : null}
      </header>
      <div className="conversation-artifact-hover-preview-body">
        {change ? (
          <DiffViewer change={change} maxCollapsedLines={18} showFoldMarkers={false} />
        ) : target.kind === "artifact" ? (
          <CompactArtifactPreview preview={target.preview} />
        ) : null}
      </div>
    </aside>
  );
}

function CompactArtifactPreview({ preview }: { readonly preview: PreviewContentResponse }): React.JSX.Element {
  if (preview.kind === "image" && preview.imageUrl) {
    return <img className="conversation-artifact-hover-preview-image" src={preview.imageUrl} alt="" />;
  }
  if (preview.text !== undefined) {
    return <pre className="conversation-artifact-hover-preview-text">{compactPreviewText(preview.text)}</pre>;
  }
  return <span className="conversation-artifact-hover-preview-empty">{preview.ref.label}</span>;
}

function previewDiffChange(preview: PreviewContentResponse, fallbackPath: string): ConversationFileChange | undefined {
  if (preview.kind !== "diff" || !preview.text?.trim()) {
    return undefined;
  }
  return parseUnifiedDiff(preview.text, {
    idPrefix: `hover:${preview.ref.id}`,
    fallbackPath: preview.ref.displayPath || fallbackPath,
    status: "completed",
    artifactId: preview.ref.id,
  })[0];
}

function compactPreviewText(value: string): string {
  const lines = value.replace(/\r\n?/gu, "\n").split("\n");
  return lines.slice(0, 18).join("\n").slice(0, 8_000);
}

function hoverPreviewPosition(rect: DOMRect): CSSProperties {
  const margin = 12;
  const gap = 8;
  const width = Math.min(560, Math.max(0, globalThis.innerWidth - margin * 2));
  const left = Math.max(margin, Math.min(rect.left, globalThis.innerWidth - width - margin));
  const estimatedHeight = 240;
  const fitsAbove = rect.top - gap - estimatedHeight >= margin;
  if (fitsAbove) {
    return { left, top: rect.top - gap, width, transform: "translateY(-100%)" };
  }
  const maxTop = Math.max(margin, globalThis.innerHeight - estimatedHeight - margin);
  return { left, top: Math.min(rect.bottom + gap, maxTop), width };
}

function artifactItemMeta(item: ConversationArtifactStripItem, t: Translate): string | undefined {
  return [
    artifactTypeLabel(item, t),
    item.sizeBytes !== undefined ? formatArtifactSize(item.sizeBytes) : undefined,
  ].filter(Boolean).join(" · ") || undefined;
}

function artifactTypeLabel(item: ConversationArtifactStripItem, t: Translate): string | undefined {
  if (item.previewKind === "image") {
    return t("Image");
  }
  return item.artifactType?.toUpperCase();
}

function formatArtifactSize(sizeBytes: number): string {
  if (sizeBytes < 1024) {
    return `${sizeBytes} B`;
  }
  if (sizeBytes < 1024 * 1024) {
    return `${(sizeBytes / 1024).toFixed(1)} KB`;
  }
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}
