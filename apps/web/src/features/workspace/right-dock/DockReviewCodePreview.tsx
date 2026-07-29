import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { previewWorkspaceFile } from "../../../api.js";
import { useI18n } from "../../../i18n.js";
import { useTheme } from "../../../theme.js";
import {
  normalizeShikiLanguage,
  renderShikiCodeTokens,
  shikiThemeForResolvedTheme,
  useShikiHighlightedCodeLines,
  type ShikiHighlightedToken,
} from "../../../shared/conversation/code-highlighting/shiki.js";
import type {
  DockReviewArtifactRef,
  DockReviewCodeLine,
  DockReviewInlineNote,
  DockReviewItem,
} from "../../../shared/conversation/index.js";
import type { WorkspaceRightDockFileTarget } from "./WorkspaceRightDock.js";

type DockReviewCodeRenderRow =
  | {
    readonly type: "fold";
    readonly id: string;
    readonly hiddenLineCount: number;
  }
  | {
    readonly type: "line";
    readonly id: string;
    readonly line: DockReviewCodeLine;
    readonly note?: DockReviewInlineNote;
  };

export function DockReviewCodePreview({
  item,
  preview,
  focusLine,
}: {
  readonly item: DockReviewItem;
  readonly preview: NonNullable<DockReviewItem["codePreview"]>;
  readonly focusLine?: number;
}): JSX.Element {
  const { t } = useI18n();
  const [collapsed, setCollapsed] = useState(false);
  const focusedLineRef = useRef<HTMLSpanElement | null>(null);
  const primaryLabel = preview.title;
  const secondaryLabel = preview.pathLabel ?? preview.language;
  const stats = preview.stats ?? codePreviewStats(preview.lines);
  const notes = useMemo(() => inlineNotesForReviewItem(item, preview, t), [item, preview, t]);
  const rows = useMemo(() => codePreviewRenderRows(preview.lines, notes), [notes, preview.lines]);
  const highlightedLines = useShikiHighlightedCodeRows(preview, rows);

  useEffect(() => {
    setCollapsed(false);
  }, [item.id, preview.title]);

  useEffect(() => {
    if (collapsed || focusLine === undefined) {
      return;
    }
    const frameId = globalThis.requestAnimationFrame(() => {
      focusedLineRef.current?.scrollIntoView({ block: "center" });
    });
    return () => globalThis.cancelAnimationFrame(frameId);
  }, [collapsed, focusLine, item.id, preview.title]);

  return (
    <figure className={collapsed ? "right-dock-code-preview collapsed" : "right-dock-code-preview"} data-language={preview.language ?? "text"}>
      <figcaption title={preview.pathLabel ?? preview.title}>
        <button
          type="button"
          className="right-dock-code-preview-toggle"
          aria-expanded={!collapsed}
          aria-label={collapsed ? t("Expand code preview") : t("Collapse code preview")}
          onClick={() => setCollapsed((current) => !current)}
        >
          <span className="right-dock-code-title">{primaryLabel}</span>
          {stats ? <span className="right-dock-code-stat"><span>+{stats.additions}</span><span>-{stats.deletions}</span></span> : null}
          {secondaryLabel ? <small>{secondaryLabel}</small> : null}
        </button>
      </figcaption>
      {!collapsed ? (
        <>
          <pre>
            {rows.map((row) => {
              if (row.type === "fold") {
                return (
                  <span key={row.id} className="right-dock-code-fold">
                    <button type="button" aria-label={t("Show previous context")}>⌃</button>
                    <span>{t("{count} unmodified lines", { count: row.hiddenLineCount })}</span>
                    <button type="button" aria-label={t("Show next context")}>⌄</button>
                  </span>
                );
              }
              const note = row.note;
              const lineNumber = row.line.newLineNumber ?? row.line.lineNumber ?? row.line.oldLineNumber;
              const focused = focusLine !== undefined && lineNumber === focusLine;
              return (
                <span key={row.id} className="right-dock-code-row-group">
                  <span ref={focused ? focusedLineRef : undefined} className={[
                    "right-dock-code-line",
                    row.line.kind,
                    focused ? "focused" : "",
                    note ? "has-note" : "",
                    note?.severity === "blocker" ? "block-note" : "",
                  ].filter(Boolean).join(" ")}>
                    <span className="right-dock-code-number">{codeLineDisplayNumber(row.line)}</span>
                    <span className="right-dock-code-mark">{codeLineMark(row.line.kind)}</span>
                    <code>{renderCodeTokens(displayCodeLineText(row.line), highlightedLines[row.id])}</code>
                    <span className="right-dock-code-note-mark">{note ? "●" : ""}</span>
                  </span>
                  {note ? (
                    <span className={`right-dock-inline-note ${note.severity}`}>
                      <span className="right-dock-note-pill">{inlineNoteLabel(note)}</span>
                      <span>{note.body}</span>
                      {note.authorLabel ? <span className="right-dock-note-author">{note.authorLabel}</span> : null}
                    </span>
                  ) : null}
                </span>
              );
            })}
          </pre>
          {preview.truncated ? <small className="right-dock-code-truncated">{t("Preview truncated")}</small> : null}
        </>
      ) : null}
    </figure>
  );
}

function useShikiHighlightedCodeRows(
  preview: NonNullable<DockReviewItem["codePreview"]>,
  rows: readonly DockReviewCodeRenderRow[],
): Readonly<Record<string, readonly ShikiHighlightedToken[]>> {
  const { resolvedTheme } = useTheme();
  const shikiTheme = shikiThemeForResolvedTheme(resolvedTheme);
  const language = useMemo(() => shikiLanguageForPreview(preview), [preview]);
  const source = useMemo(() => rows.map((row) => (row.type === "line" ? displayCodeLineText(row.line) : "")).join("\n"), [rows]);
  const rowIds = useMemo(() => rows.map((row) => (row.type === "line" ? row.id : "")), [rows]);
  const highlighted = useShikiHighlightedCodeLines({
    enabled: true,
    language,
    source,
    theme: shikiTheme,
  });

  return useMemo(() => {
    const next: Record<string, readonly ShikiHighlightedToken[]> = {};
    highlighted.lines.forEach((tokens, index) => {
      const rowId = rowIds[index];
      if (rowId && tokens.length > 0) {
        next[rowId] = tokens;
      }
    });
    return next;
  }, [highlighted.lines, rowIds]);
}

function shikiLanguageForPreview(preview: NonNullable<DockReviewItem["codePreview"]>): string {
  const explicit = normalizeShikiLanguage(preview.language);
  if (explicit && explicit !== "diff") {
    return explicit;
  }
  const source = `${preview.title} ${preview.pathLabel ?? ""}`;
  const extensionMatch = /(?:^|[^\w.-])[\w.-]+\.([a-z0-9]+)\b/iu.exec(source);
  return normalizeShikiLanguage(extensionMatch?.[1]) ?? explicit ?? "text";
}

export function reviewMinimapSegments(
  item: DockReviewItem,
  preview: NonNullable<DockReviewItem["codePreview"]>,
): readonly {
  readonly id: string;
  readonly tone: "green" | "amber" | "red" | "gray";
  readonly label: string;
  readonly fill: number;
}[] {
  const stats = item.stats ?? preview.stats ?? codePreviewStats(preview.lines);
  const total = Math.max(1, (stats?.additions ?? 0) + (stats?.deletions ?? 0));
  const additionFill = Math.min(94, Math.max(24, Math.round(((stats?.additions ?? 0) / total) * 100)));
  const riskFill = item.severity === "warning" || item.status === "pending" ? 42 : 18;
  const blockerFill = item.severity === "danger" || item.status === "blocked" || item.status === "failed" ? 34 : 14;
  return [
    { id: "changes", tone: "green", label: "Changed lines", fill: additionFill },
    { id: "risk", tone: "amber", label: "Review notes and risks", fill: riskFill },
    { id: "blocker", tone: "red", label: "Blockers", fill: blockerFill },
    { id: "fallback", tone: "gray", label: "Fallback previews", fill: item.artifactRef ? 34 : 0 },
  ];
}

function inlineNotesForReviewItem(
  item: DockReviewItem,
  preview: NonNullable<DockReviewItem["codePreview"]>,
  t: (key: string, values?: Readonly<Record<string, string | number>>) => string,
): readonly DockReviewInlineNote[] {
  if (preview.inlineNotes && preview.inlineNotes.length > 0) {
    return preview.inlineNotes;
  }
  const anchor = preferredInlineNoteAnchor(preview.lines, item);
  if (!anchor) {
    return [];
  }
  if (item.severity === "danger" || item.status === "blocked" || item.status === "failed") {
    return [{
      id: `${item.id}:blocker-note`,
      severity: "blocker",
      label: "BLOCKER",
      authorLabel: item.sourceLabel,
      body: item.reason,
      oldLineNumber: anchor.oldLineNumber,
      newLineNumber: anchor.newLineNumber,
      lineKind: anchor.kind,
    }];
  }
  if (item.severity === "warning" || item.kind === "approval_gate") {
    return [{
      id: `${item.id}:risk-note`,
      severity: "risk",
      label: "RISK",
      authorLabel: item.sourceLabel,
      body: item.reason,
      oldLineNumber: anchor.oldLineNumber,
      newLineNumber: anchor.newLineNumber,
      lineKind: anchor.kind,
    }];
  }
  if (item.kind === "code_change" && item.status === "pending") {
    return [{
      id: `${item.id}:qa-note`,
      severity: "suggestion",
      label: "QA",
      authorLabel: item.sourceLabel,
      body: t("Check whether this change matches the current goal and code context."),
      oldLineNumber: anchor.oldLineNumber,
      newLineNumber: anchor.newLineNumber,
      lineKind: anchor.kind,
    }];
  }
  return [];
}

function preferredInlineNoteAnchor(
  lines: readonly DockReviewCodeLine[],
  item: DockReviewItem,
): DockReviewCodeLine | undefined {
  if (item.severity === "danger" || item.status === "blocked" || item.status === "failed") {
    return lines.find((line) => line.kind === "delete") ?? lines.find((line) => line.kind === "add") ?? lines.find((line) => line.kind === "context");
  }
  return lines.find((line) => line.kind === "add") ?? lines.find((line) => line.kind === "delete") ?? lines.find((line) => line.kind === "context");
}

function codePreviewRenderRows(
  lines: readonly DockReviewCodeLine[],
  notes: readonly DockReviewInlineNote[],
): readonly DockReviewCodeRenderRow[] {
  const rows: DockReviewCodeRenderRow[] = [];
  let previousOldLine: number | undefined;
  let previousNewLine: number | undefined;
  lines.forEach((line, index) => {
    if (line.kind === "hunk") {
      const hunkStart = hunkStartLineNumbers(line.text);
      const foldCount = unchangedLineGap(previousOldLine, previousNewLine, hunkStart?.oldLineNumber, hunkStart?.newLineNumber);
      if (foldCount > 8) {
        rows.push({
          type: "fold",
          id: `fold:${index}:${foldCount}`,
          hiddenLineCount: foldCount,
        });
      }
    }
    rows.push({
      type: "line",
      id: `line:${index}:${line.oldLineNumber ?? ""}:${line.newLineNumber ?? ""}:${line.text}`,
      line,
      note: noteForLine(line, notes),
    });
    if (line.oldLineNumber !== undefined) {
      previousOldLine = line.oldLineNumber;
    }
    if (line.newLineNumber !== undefined) {
      previousNewLine = line.newLineNumber;
    }
  });
  return rows;
}

function hunkStartLineNumbers(text: string): { readonly oldLineNumber: number; readonly newLineNumber: number } | undefined {
  const previewMarkerMatch = /^#(\d+)$/u.exec(text.trim());
  if (previewMarkerMatch) {
    const lineNumber = Number(previewMarkerMatch[1]);
    return {
      oldLineNumber: lineNumber,
      newLineNumber: lineNumber,
    };
  }
  const match = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?/u.exec(text);
  if (!match) {
    return undefined;
  }
  return {
    oldLineNumber: Number(match[1]),
    newLineNumber: Number(match[2]),
  };
}

function unchangedLineGap(
  previousOldLine: number | undefined,
  previousNewLine: number | undefined,
  nextOldLine: number | undefined,
  nextNewLine: number | undefined,
): number {
  if (nextOldLine === undefined || nextNewLine === undefined) {
    return 0;
  }
  if (previousOldLine === undefined && previousNewLine === undefined) {
    return Math.max(0, Math.min(nextOldLine, nextNewLine) - 1);
  }
  const oldGap = previousOldLine === undefined ? 0 : nextOldLine - previousOldLine - 1;
  const newGap = previousNewLine === undefined ? 0 : nextNewLine - previousNewLine - 1;
  return Math.max(0, Math.min(oldGap || newGap, newGap || oldGap));
}

function noteForLine(
  line: DockReviewCodeLine,
  notes: readonly DockReviewInlineNote[],
): DockReviewInlineNote | undefined {
  return notes.find((note) => {
    if (note.lineKind && note.lineKind !== line.kind) {
      return false;
    }
    if (note.oldLineNumber !== undefined && note.oldLineNumber !== line.oldLineNumber) {
      return false;
    }
    if (note.newLineNumber !== undefined && note.newLineNumber !== line.newLineNumber) {
      return false;
    }
    return note.oldLineNumber !== undefined || note.newLineNumber !== undefined || note.lineKind === line.kind;
  });
}

function inlineNoteLabel(note: DockReviewInlineNote): string {
  if (note.label) {
    return note.label;
  }
  if (note.severity === "blocker") {
    return "BLOCKER";
  }
  if (note.severity === "risk") {
    return "RISK";
  }
  return "QA";
}

function renderCodeTokens(text: string, shikiTokens: readonly ShikiHighlightedToken[] | undefined): ReactNode {
  const shikiNodes = renderShikiCodeTokens(shikiTokens, "right-dock-code-token shiki");
  if (shikiNodes) {
    return shikiNodes;
  }
  const pattern = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\b(?:async|await|break|case|catch|class|const|continue|default|else|export|extends|false|finally|for|from|function|if|implements|import|interface|let|new|null|readonly|return|switch|throw|true|try|type|undefined|var|while)\b|[A-Za-z_$][\w$]*(?=\s*\())/gu;
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > cursor) {
      nodes.push(text.slice(cursor, match.index));
    }
    const token = match[0];
    const className = /^["'`]/u.test(token)
      ? "str"
      : /\b(?:async|await|break|case|catch|class|const|continue|default|else|export|extends|false|finally|for|from|function|if|implements|import|interface|let|new|null|readonly|return|switch|throw|true|try|type|undefined|var|while)\b/u.test(token)
        ? "kw"
        : "fn";
    nodes.push(<span key={`${match.index}:${token}`} className={`right-dock-code-token ${className}`}>{token}</span>);
    cursor = match.index + token.length;
  }
  if (cursor < text.length) {
    nodes.push(text.slice(cursor));
  }
  return nodes.length > 0 ? nodes : text;
}

export function codePreviewFromArtifact(
  artifactRef: DockReviewArtifactRef,
  text: string,
  kind: string,
  truncated: boolean,
): NonNullable<DockReviewItem["codePreview"]> {
  const language = kind === "diff" ? "diff" : kind === "json" ? "json" : kind === "log" ? "log" : "text";
  const lines = textToCodeLines(text, language);
  const stats = codePreviewStats(lines);
  return {
    title: artifactRef.title ?? artifactRef.path ?? artifactRef.id,
    language,
    pathLabel: artifactRef.path,
    lines: lines.slice(0, 180),
    stats,
    truncated: truncated || lines.length > 180,
  };
}

export function workspaceFileCodePreview(
  target: WorkspaceRightDockFileTarget,
  response: Awaited<ReturnType<typeof previewWorkspaceFile>>,
): NonNullable<DockReviewItem["codePreview"]> | undefined {
  if (response.text === undefined) {
    return undefined;
  }
  const language = response.kind === "json"
    ? "json"
    : response.kind === "diff"
      ? "diff"
      : response.kind === "log"
        ? "log"
        : "text";
  const textStartLine = response.textStartLine ?? 1;
  const allLines = textToCodeLines(response.text, language, textStartLine);
  const focusIndex = target.line === undefined ? -1 : Math.max(0, target.line - textStartLine);
  const startIndex = focusIndex >= 0 ? Math.max(0, focusIndex - 90) : 0;
  const endIndex = Math.min(allLines.length, startIndex + 180);
  const visibleLines = allLines.slice(startIndex, endIndex);
  return {
    title: target.label || fileNameFromPath(target.path) || response.ref.label,
    language,
    pathLabel: response.ref.displayPath || target.path,
    lines: visibleLines,
    truncated: response.truncated || startIndex > 0 || endIndex < allLines.length,
  };
}

function textToCodeLines(text: string, language: string, startLine = 1): readonly DockReviewCodeLine[] {
  if (language !== "diff") {
    return text.split(/\r?\n/u).map((line, index) => ({
      kind: "context",
      text: line || " ",
      lineNumber: startLine + index,
      oldLineNumber: startLine + index,
      newLineNumber: startLine + index,
    }));
  }
  const lines: DockReviewCodeLine[] = [];
  let oldLine: number | undefined;
  let newLine: number | undefined;
  text.split(/\r?\n/u).forEach((line, index) => {
    const kind = diffLineKind(line);
    if (kind === "hunk") {
      const hunkStart = hunkStartLineNumbers(line);
      oldLine = hunkStart?.oldLineNumber;
      newLine = hunkStart?.newLineNumber;
      lines.push({ kind, text: line || " ", lineNumber: index + 1 });
      return;
    }
    if (kind === "add") {
      lines.push({ kind, text: line || " ", lineNumber: index + 1, newLineNumber: newLine });
      if (newLine !== undefined) {
        newLine += 1;
      }
      return;
    }
    if (kind === "delete") {
      lines.push({ kind, text: line || " ", lineNumber: index + 1, oldLineNumber: oldLine });
      if (oldLine !== undefined) {
        oldLine += 1;
      }
      return;
    }
    if (kind === "context") {
      lines.push({ kind, text: line || " ", lineNumber: index + 1, oldLineNumber: oldLine, newLineNumber: newLine });
      if (oldLine !== undefined) {
        oldLine += 1;
      }
      if (newLine !== undefined) {
        newLine += 1;
      }
      return;
    }
    lines.push({ kind, text: line || " ", lineNumber: index + 1 });
  });
  return lines;
}

function diffLineKind(line: string): DockReviewCodeLine["kind"] {
  if (/^#\d+$/u.test(line.trim())) {
    return "hunk";
  }
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

export function reviewKindLabel(kind: DockReviewItem["kind"], t: (key: string, values?: Readonly<Record<string, string | number>>) => string): string {
  switch (kind) {
    case "approval_gate":
      return t("Approval gate");
    case "code_change":
      return t("Code change");
    case "runtime_issue":
      return t("Runtime issue");
    case "evidence_gap":
      return t("Evidence gap");
    case "message_issue":
      return t("Message issue");
    case "protocol_signal":
      return t("Protocol signal");
    default:
      return t("Review item");
  }
}

function codeLineNumber(value: number | undefined, kind: NonNullable<DockReviewItem["codePreview"]>["lines"][number]["kind"]): string {
  if (kind === "hunk" || kind === "meta") {
    return "";
  }
  return value === undefined ? "" : String(value);
}

function codeLineDisplayNumber(line: DockReviewCodeLine): string {
  if (line.kind === "hunk" || line.kind === "meta") {
    return "";
  }
  if (line.kind === "delete") {
    return codeLineNumber(line.oldLineNumber, line.kind);
  }
  if (line.kind === "add") {
    return codeLineNumber(line.newLineNumber, line.kind);
  }
  return codeLineNumber(line.newLineNumber ?? line.oldLineNumber ?? line.lineNumber, line.kind);
}

function codeLineMark(kind: NonNullable<DockReviewItem["codePreview"]>["lines"][number]["kind"]): string {
  if (kind === "add") {
    return "+";
  }
  if (kind === "delete") {
    return "-";
  }
  if (kind === "command") {
    return "$";
  }
  if (kind === "hunk") {
    return "";
  }
  return "";
}

function displayCodeLineText(line: DockReviewCodeLine): string {
  if ((line.kind === "add" || line.kind === "delete") && /^[+-]/u.test(line.text)) {
    return line.text.slice(1) || " ";
  }
  if (line.kind === "context" && line.text.startsWith(" ")) {
    return line.text.slice(1) || " ";
  }
  return line.text || " ";
}

export function codePreviewStats(lines: readonly DockReviewCodeLine[]): { readonly additions: number; readonly deletions: number } | undefined {
  const additions = lines.filter((line) => line.kind === "add").length;
  const deletions = lines.filter((line) => line.kind === "delete").length;
  return additions > 0 || deletions > 0 ? { additions, deletions } : undefined;
}

function reviewDetailTitle(item: DockReviewItem): string {
  return item.codePreview?.title || fileNameFromPath(item.pathLabel) || item.title;
}

function reviewDetailSubtitle(item: DockReviewItem): string | undefined {
  const path = item.codePreview?.pathLabel ?? item.pathLabel;
  return path ? directoryNameFromPath(path) : item.sourceLabel;
}

export function reviewDetailPathLabel(
  item: DockReviewItem,
  preview: NonNullable<DockReviewItem["codePreview"]>,
): string | undefined {
  const path = preview.pathLabel ?? item.pathLabel;
  if (!path) {
    return preview.language ? preview.language.toUpperCase() : undefined;
  }
  const directory = directoryNameFromPath(path);
  return directory || path;
}

export function fileTypeLabel(preview: NonNullable<DockReviewItem["codePreview"]>): string {
  const path = preview.pathLabel ?? preview.title;
  const ext = path.split(".").pop()?.trim();
  if (ext && ext.length > 0 && ext.length <= 5 && ext !== path) {
    return ext.toUpperCase();
  }
  return (preview.language ?? "TXT").slice(0, 4).toUpperCase();
}

export function fileNameFromPath(path: string | undefined): string | undefined {
  if (!path) {
    return undefined;
  }
  const normalized = path.replace(/\\/g, "/");
  return normalized.split("/").filter(Boolean).at(-1) || normalized;
}

function directoryNameFromPath(path: string): string | undefined {
  const normalized = path.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length <= 1) {
    return undefined;
  }
  return parts.slice(0, -1).join("/");
}
