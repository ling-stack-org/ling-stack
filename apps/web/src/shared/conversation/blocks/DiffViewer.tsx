import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../../../i18n.js";
import { parseUnifiedDiffHunkRows, type ConversationDiffDisplayLine, type ConversationFileChange } from "../../../lib/diff-summary.js";
import { notifyConversationDeferredContentReady } from "./deferred-rendering.js";

export interface DiffViewerProps {
  readonly change: ConversationFileChange;
  readonly maxCollapsedLines?: number;
  readonly showFoldMarkers?: boolean;
}

const defaultMaxCollapsedLines = 160;

export function DiffViewer({ change, maxCollapsedLines = defaultMaxCollapsedLines, showFoldMarkers = true }: DiffViewerProps): React.JSX.Element {
  const { t } = useI18n();
  const rootRef = useRef<HTMLPreElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const diffRows = useMemo(() => parseUnifiedDiffHunkRows(change.diff), [change.diff]);
  const displayRows = showFoldMarkers ? diffRows.rows : diffRows.rows.filter((row) => row.type !== "fold");
  const shouldCollapse = displayRows.length > maxCollapsedLines;
  const visibleRows = shouldCollapse && !expanded ? displayRows.slice(0, maxCollapsedLines) : displayRows;
  const hiddenLineCount = Math.max(0, displayRows.length - maxCollapsedLines);

  useEffect(() => {
    const frameId = globalThis.requestAnimationFrame(() => {
      notifyConversationDeferredContentReady(rootRef.current);
    });
    return () => globalThis.cancelAnimationFrame(frameId);
  }, [expanded, visibleRows.length]);

  return (
    <>
      <pre
        ref={rootRef}
        className={[
          "diff-viewer",
          diffRows.structured ? "structured" : "raw",
          shouldCollapse && !expanded ? "collapsed" : "",
        ].filter(Boolean).join(" ")}
        aria-label={change.path}
      >
        {visibleRows.map((row) => {
          if (row.type === "fold") {
            return (
              <span key={row.id} className="diff-fold">
                <span className="diff-fold-rule" aria-hidden="true" />
                <span>{t("{count} unmodified lines", { count: row.hiddenLineCount })}</span>
                <span className="diff-fold-rule" aria-hidden="true" />
              </span>
            );
          }
          const { line } = row;
          return (
            <span key={row.id} className={`diff-line ${line.kind}`}>
              <span className="diff-line-number">{lineNumberLabel(line)}</span>
              <span className="diff-gutter">{gutterForKind(line.kind)}</span>
              <code>{line.text || " "}</code>
            </span>
          );
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
