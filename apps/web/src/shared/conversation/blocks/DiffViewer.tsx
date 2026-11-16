import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../../../i18n.js";
import { parseUnifiedDiffHunkRows, type ConversationDiffDisplayLine, type ConversationFileChange } from "../../../lib/diff-summary.js";
import { splitDiffRows } from "../../../lib/diff-split-rows.js";
import "../../../styles/assessment-diff-layout.css";
import { notifyConversationDeferredContentReady } from "./deferred-rendering.js";

export interface DiffViewerProps {
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

export function DiffViewer({ change, maxCollapsedLines = defaultMaxCollapsedLines, showFoldMarkers = true, annotations = [], selectedAnnotationId, onAnnotationClick, layout = "unified" }: DiffViewerProps): React.JSX.Element {
  const { t } = useI18n();
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
    return <span key={key} className={`diff-line ${line.kind}${side ? " diff-split-cell" : ""}${marks.length ? " annotated" : ""}${selected ? " selected" : ""}`}
      data-diff-side={side} data-old-line={side === "new" ? undefined : line.oldLineNumber} data-new-line={side === "old" ? undefined : line.newLineNumber}
      data-annotation-selected={selected || undefined} tabIndex={selected ? -1 : undefined}>
      <span className="diff-line-number">{side ? String((side === "old" ? line.oldLineNumber : line.newLineNumber) ?? "") : lineNumberLabel(line)}</span>
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
            {row.oldLine ? renderLine(row.oldLine, "old") : <span className="diff-split-empty" data-diff-side="old" aria-hidden="true" />}
            {row.newLine ? renderLine(row.newLine, "new") : <span className="diff-split-empty" data-diff-side="new" aria-hidden="true" />}
          </span>;
          return renderLine(row.line, undefined, row.id);
        })}
      </pre>
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

function lineNumberLabel(line: ConversationDiffDisplayLine): string {
  if (line.kind === "delete") {
    return line.oldLineNumber === undefined ? "" : String(line.oldLineNumber);
  }
  if (line.kind === "add") {
    return line.newLineNumber === undefined ? "" : String(line.newLineNumber);
  }
  return line.newLineNumber === undefined && line.oldLineNumber === undefined
    ? line.lineNumber === undefined ? "" : String(line.lineNumber)
    : String(line.newLineNumber ?? line.oldLineNumber);
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
