import { CodeReviewCommentEditor } from "../review/CodeReviewCommentEditor.js";
import { codeReviewDraftKey, readCodeReviewDraft, reviewDiffContext, type CodeReviewDraft } from "../review/code-review-draft.js";
import { reviewStorage } from "../review/review-draft.js";
import { useReviewDraft } from "../review/ReviewDraftContext.js";
import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../../../i18n.js";
import { parseUnifiedDiffHunkRows, type ConversationDiffDisplayLine, type ConversationFileChange } from "../../../lib/diff-summary.js";
import { splitDiffRows } from "../../../lib/diff-split-rows.js";
import "../../../styles/assessment-diff-layout.css";
import { notifyConversationDeferredContentReady } from "./deferred-rendering.js";

export interface DiffViewerProps {
  readonly revision?: string;
  readonly change: ConversationFileChange;
  readonly maxCollapsedLines?: number;
  readonly showFoldMarkers?: boolean;
  readonly annotations?: readonly DiffLineAnnotation[];
  readonly selectedAnnotationId?: string;
  readonly onAnnotationClick?: (id: string) => void;
  readonly layout?: DiffViewerLayout;
}

export type DiffViewerLayout = "unified" | "split" | "auto";

export interface DiffLineAnnotation {
  readonly id: string;
  readonly side: "old" | "new";
  readonly startLine: number;
  readonly endLine: number;
  readonly label: string;
}

const defaultMaxCollapsedLines = 160;

export function DiffViewer(props: DiffViewerProps): React.JSX.Element {
  const review = useReviewDraft();
  const draftKey = review ? codeReviewDraftKey(review.owner, props.change.path, props.revision, props.change.diff) : undefined;
  return <DiffViewerContent key={draftKey ?? props.change.id} {...props} draftKey={draftKey} />;
}

function DiffViewerContent({ change, revision, maxCollapsedLines = defaultMaxCollapsedLines, showFoldMarkers = true, annotations = [], selectedAnnotationId, onAnnotationClick, layout = "unified", draftKey }: DiffViewerProps & { readonly draftKey?: string }): React.JSX.Element {
  const { t } = useI18n();
  const review = useReviewDraft();
  const [pending, setPending] = useState<CodeReviewDraft | undefined>(() => readCodeReviewDraft(draftKey, reviewStorage()));
  const selection = pending?.selection;
  const [storageError, setStorageError] = useState(false);
  const anchor = useRef<{ side: "left" | "right"; line: number; source: number } | undefined>(undefined);
  const rootRef = useRef<HTMLPreElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [containerWidth, setContainerWidth] = useState(0);
  const diffRows = useMemo(() => parseUnifiedDiffHunkRows(change.diff), [change.diff]);
  const displayRows = showFoldMarkers ? diffRows.rows : diffRows.rows.filter((row) => row.type !== "fold");
  const shouldCollapse = displayRows.length > maxCollapsedLines;
  const visibleRows = shouldCollapse && !expanded ? displayRows.slice(0, maxCollapsedLines) : displayRows;
  const hiddenLineCount = Math.max(0, displayRows.length - maxCollapsedLines);
  const resolvedLayout = diffRows.structured && (layout === "split" || layout === "auto" && containerWidth >= 840) ? "split" : "unified";
  const renderedRows = resolvedLayout === "split" ? splitDiffRows(visibleRows) : visibleRows;

  useEffect(() => {
    const root = rootRef.current;
    if (layout !== "auto" || !root) return;
    setContainerWidth(root.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(entries => {
      const entry = entries[0];
      if (entry) setContainerWidth(entry.contentRect.width);
    });
    observer.observe(root);
    return () => observer.disconnect();
  }, [layout]);

  useEffect(() => {
    if (!selectedAnnotationId) return;
    setExpanded(true);
  }, [selectedAnnotationId, change.diff]);

  useEffect(() => {
    if (!selectedAnnotationId) return;
    const frame = requestAnimationFrame(() => {
      const element = rootRef.current?.querySelector<HTMLElement>("[data-annotation-selected='true']");
      element?.scrollIntoView({ block: "nearest", inline: "nearest" });
      element?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [selectedAnnotationId, change.diff, expanded, resolvedLayout]);

  useEffect(() => {
    if (!draftKey) return;
    try {
      const storage = reviewStorage();
      if (!storage) throw new Error("Storage unavailable");
      storage.setItem(draftKey, JSON.stringify(pending ?? null));
      setStorageError(false);
    } catch { setStorageError(true); }
  }, [draftKey, pending]);

  useEffect(() => {
    const frameId = globalThis.requestAnimationFrame(() => {
      notifyConversationDeferredContentReady(rootRef.current);
    });
    return () => globalThis.cancelAnimationFrame(frameId);
  }, [expanded, visibleRows.length, resolvedLayout]);

  function renderLine(line: ConversationDiffDisplayLine, side?: "old" | "new", key?: string): React.JSX.Element {
    const marks = annotations.filter(annotation => {
      if (side && annotation.side !== side) return false;
      const number = annotation.side === "old" ? line.oldLineNumber : line.newLineNumber;
      return number !== undefined && number >= annotation.startLine && number <= annotation.endLine;
    });
    const selected = marks.some(annotation => annotation.id === selectedAnnotationId);
    const reviewSide = side === "old" || !side && line.kind === "delete" ? "left" : "right";
    const lineNumber = side === "old" ? line.oldLineNumber : side === "new" ? line.newLineNumber : line.kind === "delete" ? line.oldLineNumber : line.newLineNumber;
    const reviewSelected = selection && lineNumber !== undefined && selection.side === reviewSide && lineNumber >= selection.startLine && lineNumber <= selection.line;
    const canSelectForReview = Boolean(review && diffRows.structured && lineNumber !== undefined && line.lineNumber !== undefined);

    function selectLine(event: React.MouseEvent<HTMLButtonElement>): void {
      if (!canSelectForReview || lineNumber === undefined || line.lineNumber === undefined) return;
      const start = event.shiftKey && anchor.current?.side === reviewSide
        ? anchor.current
        : { line: lineNumber, source: line.lineNumber };
      if (!event.shiftKey) anchor.current = { side: reviewSide, line: lineNumber, source: line.lineNumber };
      setPending(current => ({
        text: current?.text ?? "",
        selection: {
          side: reviewSide,
          startLine: Math.min(start.line, lineNumber),
          line: Math.max(start.line, lineNumber),
          sourceStart: Math.min(start.source, line.lineNumber!),
          sourceEnd: Math.max(start.source, line.lineNumber!),
        },
      }));
    }

    const numberLabel = lineNumber === undefined ? "" : String(lineNumber);
    return <span key={key} className={`diff-line ${line.kind}${side ? " diff-split-cell" : ""}${marks.length ? " annotated" : ""}${selected ? " selected" : ""}${reviewSelected ? " review-selected" : ""}`}
      data-diff-side={side} data-old-line={side === "new" ? undefined : line.oldLineNumber} data-new-line={side === "old" ? undefined : line.newLineNumber}
      data-annotation-selected={selected || undefined} tabIndex={selected ? -1 : undefined}>
      {canSelectForReview
        ? <button type="button" className="diff-line-number review-line-target" aria-label={t("Comment on line {line}", { line: numberLabel })} onClick={selectLine}>{numberLabel}</button>
        : <span className="diff-line-number">{numberLabel}</span>}
      <span className="diff-gutter">{gutterForKind(line.kind)}</span>
      <code>{line.text || " "}{marks.map(annotation => <button key={annotation.id} type="button" className="diff-finding-marker" aria-label={annotation.label} title={annotation.label}
        onClick={() => onAnnotationClick?.(annotation.id)}>●</button>)}</code>
    </span>;
  }

  return (
    <>
      <pre
        ref={rootRef}
        className={[
          "diff-viewer",
          diffRows.structured ? "structured" : "raw",
          `diff-layout-${resolvedLayout}`,
          shouldCollapse && !expanded ? "collapsed" : "",
        ].filter(Boolean).join(" ")}
        aria-label={change.path}
        data-diff-layout={resolvedLayout}
      >
        {renderedRows.map((row) => {
          if (row.type === "fold") {
            return (
              <span key={row.id} className="diff-fold">
                <span className="diff-fold-rule" aria-hidden="true" />
                <span>{t("{count} unmodified lines", { count: row.hiddenLineCount })}</span>
                <span className="diff-fold-rule" aria-hidden="true" />
              </span>
            );
          }
          if (row.type === "split") return <span key={row.id} className="diff-split-row">
            {row.oldLine ? renderLine(row.oldLine, "old", `${row.id}:old`) : <span className="diff-split-empty" data-diff-side="old" aria-hidden="true" />}
            {row.newLine ? renderLine(row.newLine, "new", `${row.id}:new`) : <span className="diff-split-empty" data-diff-side="new" aria-hidden="true" />}
          </span>;
          return renderLine(row.line, undefined, row.id);
        })}
      </pre>
      {pending ? <CodeReviewCommentEditor path={change.path} selection={pending.selection} revision={revision} diffHunk={reviewDiffContext(change.diff, pending.selection)} text={pending.text} storageError={storageError} onTextChange={text => setPending({ ...pending, text })} onClose={() => setPending(undefined)} /> : null}
      {shouldCollapse ? (
        <button
          className="message-code-expand"
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? t("Collapse diff ranges") : t("Show remaining diff ranges ({count} more lines)", { count: hiddenLineCount })}
        </button>
      ) : null}
    </>
  );
}

function gutterForKind(kind: ConversationDiffDisplayLine["kind"]): string {
  if (kind === "add") {
    return "+";
  }
  if (kind === "delete") {
    return "-";
  }
  return " ";
}
