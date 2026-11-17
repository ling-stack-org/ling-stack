import { CodeReviewCommentEditor } from "../review/CodeReviewCommentEditor.js";
import { codeReviewDraftKey, readCodeReviewDraft, reviewDiffContext, type CodeReviewDraft } from "../review/code-review-draft.js";
import { reviewStorage } from "../review/review-draft.js";
import { useReviewDraft } from "../review/ReviewDraftContext.js";
import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../../../i18n.js";
import { parseUnifiedDiffHunkRows, type ConversationDiffDisplayLine, type ConversationFileChange } from "../../../lib/diff-summary.js";
import { notifyConversationDeferredContentReady } from "./deferred-rendering.js";

export interface DiffViewerProps {
  readonly revision?: string;
  readonly change: ConversationFileChange;
  readonly maxCollapsedLines?: number;
  readonly showFoldMarkers?: boolean;
}

const defaultMaxCollapsedLines = 160;

export function DiffViewer(props: DiffViewerProps): React.JSX.Element {
  const review = useReviewDraft();
  const draftKey = review ? codeReviewDraftKey(review.owner, props.change.path, props.revision, props.change.diff) : undefined;
  return <DiffViewerContent key={draftKey ?? props.change.id} {...props} draftKey={draftKey} />;
}

function DiffViewerContent({ change, revision, maxCollapsedLines = defaultMaxCollapsedLines, showFoldMarkers = true, draftKey }: DiffViewerProps & { readonly draftKey?: string }): React.JSX.Element {
  const { t } = useI18n();
  const review = useReviewDraft();
  const [pending, setPending] = useState<CodeReviewDraft | undefined>(() => readCodeReviewDraft(draftKey, reviewStorage()));
  const selection = pending?.selection;
  const [storageError, setStorageError] = useState(false);
  const anchor = useRef<{ side: "left" | "right"; line: number; source: number } | undefined>(undefined);
  const rootRef = useRef<HTMLPreElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const diffRows = useMemo(() => parseUnifiedDiffHunkRows(change.diff), [change.diff]);
  const displayRows = showFoldMarkers ? diffRows.rows : diffRows.rows.filter((row) => row.type !== "fold");
  const shouldCollapse = displayRows.length > maxCollapsedLines;
  const visibleRows = shouldCollapse && !expanded ? displayRows.slice(0, maxCollapsedLines) : displayRows;
  const hiddenLineCount = Math.max(0, displayRows.length - maxCollapsedLines);

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
            <span key={row.id} className={`diff-line ${line.kind}${selection && selection.side === (line.kind === "delete" ? "left" : "right") && (line.kind === "delete" ? line.oldLineNumber ?? 0 : line.newLineNumber ?? 0) >= selection.startLine && (line.kind === "delete" ? line.oldLineNumber ?? 0 : line.newLineNumber ?? 0) <= selection.line ? " review-selected" : ""}`}>
              {review && diffRows.structured ? <button type="button" className="diff-line-number review-line-target" aria-label={t("Comment on line {line}", { line: lineNumberLabel(line) })} onClick={event => {
                const side = line.kind === "delete" ? "left" : "right";
                const number = side === "left" ? line.oldLineNumber : line.newLineNumber;
                if (!number || !line.lineNumber) return;
                const start = event.shiftKey && anchor.current?.side === side ? anchor.current : { line: number, source: line.lineNumber };
                if (!event.shiftKey) anchor.current = { side, line: number, source: line.lineNumber };
                setPending(current => ({ text: current?.text ?? "", selection: {
                  side, startLine: Math.min(start.line, number), line: Math.max(start.line, number),
                  sourceStart: Math.min(start.source, line.lineNumber!), sourceEnd: Math.max(start.source, line.lineNumber!),
                } }));
              }}>{lineNumberLabel(line)}</button> : <span className="diff-line-number">{lineNumberLabel(line)}</span>}
              <span className="diff-gutter">{gutterForKind(line.kind)}</span>
              <code>{line.text || " "}</code>
            </span>
          );
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
