import { useEffect, useRef, useState } from "react";
import { useI18n } from "../../../i18n.js";
import type { ConversationFileChange } from "../../../lib/diff-summary.js";
import { notifyConversationDeferredContentReady } from "./deferred-rendering.js";

export interface DiffViewerProps {
  readonly change: ConversationFileChange;
  readonly maxCollapsedLines?: number;
}

const defaultMaxCollapsedLines = 160;

export function DiffViewer({ change, maxCollapsedLines = defaultMaxCollapsedLines }: DiffViewerProps): JSX.Element {
  const { t } = useI18n();
  const rootRef = useRef<HTMLPreElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const lineCount = countLines(change.diff);
  const shouldCollapse = lineCount > maxCollapsedLines;
  const visibleDiff = shouldCollapse && !expanded ? takeLines(change.diff, maxCollapsedLines) : change.diff;
  const lines = visibleDiff.replace(/\r\n?/g, "\n").split("\n");
  const hiddenLineCount = Math.max(0, lineCount - maxCollapsedLines);

  useEffect(() => {
    const frameId = globalThis.requestAnimationFrame(() => {
      notifyConversationDeferredContentReady(rootRef.current);
    });
    return () => globalThis.cancelAnimationFrame(frameId);
  }, [expanded, visibleDiff]);

  return (
    <>
      <pre ref={rootRef} className={`diff-viewer${shouldCollapse && !expanded ? " collapsed" : ""}`} aria-label={change.path}>
        {lines.map((line, index) => {
          const kind = diffLineKind(line);
          return (
            <span key={`${index}-${line}`} className={`diff-line ${kind}`}>
              <span className="diff-gutter">{gutterForKind(kind)}</span>
              <code>{line || " "}</code>
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
          {expanded ? t("Collapse diff") : t("Show full diff ({count} more lines)", { count: hiddenLineCount })}
        </button>
      ) : null}
    </>
  );
}

function countLines(value: string): number {
  if (value.length === 0) {
    return 0;
  }
  let count = 1;
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) === 10) {
      count += 1;
    }
  }
  return count;
}

function takeLines(value: string, count: number): string {
  if (count <= 0) {
    return "";
  }
  let seen = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 10) {
      continue;
    }
    seen += 1;
    if (seen >= count) {
      return value.slice(0, index);
    }
  }
  return value;
}

function diffLineKind(line: string): "add" | "delete" | "hunk" | "meta" | "context" {
  if (line.startsWith("+") && !line.startsWith("+++")) {
    return "add";
  }
  if (line.startsWith("-") && !line.startsWith("---")) {
    return "delete";
  }
  if (line.startsWith("@@")) {
    return "hunk";
  }
  if (line.startsWith("diff ") || line.startsWith("---") || line.startsWith("+++") || line.startsWith("index ")) {
    return "meta";
  }
  return "context";
}

function gutterForKind(kind: ReturnType<typeof diffLineKind>): string {
  if (kind === "add") {
    return "+";
  }
  if (kind === "delete") {
    return "-";
  }
  return " ";
}
