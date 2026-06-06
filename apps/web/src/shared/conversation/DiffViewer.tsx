import type { ConversationFileChange } from "../../lib/diff-summary.js";

export interface DiffViewerProps {
  readonly change: ConversationFileChange;
}

export function DiffViewer({ change }: DiffViewerProps): JSX.Element {
  const lines = change.diff.replace(/\r\n?/g, "\n").split("\n");
  return (
    <pre className="diff-viewer" aria-label={change.path}>
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
  );
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
