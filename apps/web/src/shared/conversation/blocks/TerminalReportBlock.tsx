import { CheckCircle2, ChevronDown, CircleAlert, FileCode2, FilePenLine, FileText } from "lucide-react";
import { FaJava } from "react-icons/fa";
import {
  SiCplusplus,
  SiCss,
  SiGo,
  SiHtml5,
  SiJavascript,
  SiJson,
  SiKotlin,
  SiMarkdown,
  SiPhp,
  SiPython,
  SiReact,
  SiRuby,
  SiRust,
  SiSharp,
  SiShell,
  SiSvelte,
  SiSwift,
  SiTypescript,
  SiVuedotjs,
  SiYaml,
} from "react-icons/si";
import type { IconType } from "react-icons";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { ConversationWorkCellRow } from "../../../lib/conversation-work-cell.js";
import { useI18n } from "../../../i18n.js";
import {
  getTerminalReportProjectionPolicy,
  type ConversationInteractionSurfaceKind,
  type TerminalReportProjectionPolicy,
} from "../tokens/conversation-surface-policy.js";
import { TerminalReportParticipants } from "./TerminalReportParticipants.js";
import { MessageBodyRenderer } from "./MessageBodyRenderer.js";

export interface TerminalReportFileTarget {
  readonly cwd?: string;
  readonly path: string;
  readonly line?: number;
  readonly label?: string;
}

export function TerminalReportBlock({
  blockId,
  rows,
  renderParticipantAvatar,
  surface,
  projectionPolicy,
  cwd,
  onOpenWorkspaceFile,
}: {
  readonly blockId: string;
  readonly rows: readonly ConversationWorkCellRow[];
  readonly renderParticipantAvatar?: (participantId: string | undefined, label: string) => ReactNode;
  readonly surface: ConversationInteractionSurfaceKind;
  readonly projectionPolicy?: Partial<TerminalReportProjectionPolicy>;
  readonly cwd?: string;
  readonly onOpenWorkspaceFile?: (target: TerminalReportFileTarget) => void;
}): React.JSX.Element | null {
  const resolvedProjectionPolicy = getTerminalReportProjectionPolicy(surface, projectionPolicy);
  const outcome = rows.find((row) => row.reportSection === "outcome");
  if (!outcome) {
    return null;
  }
  const participants = resolvedProjectionPolicy.showParticipants
    ? rows.filter((row) => row.reportSection === "participant")
    : [];
  const changes = rows.filter((row) => row.reportSection === "change");
  const verification = rows.filter((row) => row.reportSection === "verification");
  const corrections = rows.filter((row) => row.reportSection === "correction");
  const risks = rows.filter((row) => row.reportSection === "risk");

  return (
    <section className="terminal-report-block expanded static" data-terminal-report-block={blockId}>
      <div className="terminal-report-summary">
        <div className="terminal-report-outcome-copy">
          <strong>{outcome.title}</strong>
          {outcome.description ? <MessageBodyRenderer className="terminal-report-rich-copy" text={outcome.description} cwd={cwd} compact onOpenLocalFile={(reference) => openRichFileReference(reference, cwd, onOpenWorkspaceFile)} /> : null}
        </div>
      </div>

      <TerminalReportParticipants rows={participants} expanded cwd={cwd} renderParticipantAvatar={renderParticipantAvatar} />

      {changes.length + verification.length + corrections.length + risks.length > 0 ? (
        <div className="terminal-report-detail">
          {corrections.length > 0 ? <TerminalReportRows rows={corrections} kind="correction" cwd={cwd} onOpenWorkspaceFile={onOpenWorkspaceFile} /> : null}
          {changes.length > 0 ? <TerminalReportRows rows={changes} kind="change" cwd={cwd} onOpenWorkspaceFile={onOpenWorkspaceFile} /> : null}
          {verification.length > 0 ? <TerminalReportRows rows={verification} kind="verification" cwd={cwd} onOpenWorkspaceFile={onOpenWorkspaceFile} /> : null}
          {risks.length > 0 ? <TerminalReportRows rows={risks} kind="risk" cwd={cwd} onOpenWorkspaceFile={onOpenWorkspaceFile} /> : null}
        </div>
      ) : null}
    </section>
  );
}

function TerminalReportRows({
  rows,
  kind,
  cwd,
  onOpenWorkspaceFile,
}: {
  readonly rows: readonly ConversationWorkCellRow[];
  readonly kind: "correction" | "change" | "verification" | "risk";
  readonly cwd?: string;
  readonly onOpenWorkspaceFile?: (target: TerminalReportFileTarget) => void;
}): React.JSX.Element {
  return (
    <section className={`terminal-report-section kind-${kind}`}>
      <div className="terminal-report-row-list">
        {rows.map((row) => {
          const hideRedundantTitle = kind === "change" && changeCopyMatchesFileReference(row.title, row.detailLines);
          const hideRedundantDescription = kind === "change" && row.description
            ? changeCopyMatchesFileReference(row.description, row.detailLines, true)
            : false;
          const fileReferenceOnly = hideRedundantTitle &&
            (!row.description || hideRedundantDescription) &&
            !row.commandText &&
            Boolean(row.detailLines?.length) &&
            row.detailLines?.every((line) => line.kind === "file_ref");
          return (
            <div className={`terminal-report-row tone-${row.tone ?? "neutral"}${fileReferenceOnly ? " file-reference-only" : ""}`} key={row.id}>
              {!fileReferenceOnly ? <span className="terminal-report-row-icon" aria-hidden="true">{reportRowIcon(kind)}</span> : null}
              <div className="terminal-report-row-copy">
                {!hideRedundantTitle ? (
                  <span className="terminal-report-row-title">
                    <span>{row.title}</span>
                    {row.meta && kind !== "change" && kind !== "verification" ? <small>{row.meta}</small> : null}
                  </span>
                ) : null}
                {row.description && !hideRedundantDescription ? <MessageBodyRenderer className="terminal-report-row-rich-description" text={row.description} cwd={cwd} compact onOpenLocalFile={(reference) => openRichFileReference(reference, cwd, onOpenWorkspaceFile)} /> : null}
                {row.commandText ? <TerminalReportCommandDisclosure command={row.commandText} /> : null}
                {row.detailLines?.length ? (
                  <span className="terminal-report-row-paths">
                    {row.detailLines.map((line, index) => line.kind === "file_ref" ? (
                      <TerminalReportFileReference
                        key={`${row.id}:detail:${index}`}
                        target={{ path: line.path, line: line.line, label: line.text }}
                        onOpen={onOpenWorkspaceFile}
                      />
                    ) : (
                      <code key={`${row.id}:detail:${index}`}>{line.text}</code>
                    ))}
                  </span>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function TerminalReportCommandDisclosure({ command }: { readonly command: string }): React.JSX.Element {
  const { t } = useI18n();
  return (
    <details className="terminal-report-command-disclosure" data-terminal-report-command-disclosure>
      <summary>
        <ChevronDown size={13} aria-hidden="true" />
        <span className="terminal-report-command-show-label">{t("Show details")}</span>
        <span className="terminal-report-command-hide-label">{t("Hide details")}</span>
      </summary>
      <code>{command}</code>
    </details>
  );
}

function openRichFileReference(
  reference: { readonly displayPath: string; readonly location?: string },
  cwd: string | undefined,
  onOpenWorkspaceFile: ((target: TerminalReportFileTarget) => void) | undefined,
): void {
  if (!onOpenWorkspaceFile) {
    return;
  }
  const path = reference.location
    ? reference.displayPath.slice(0, -reference.location.length)
    : reference.displayPath;
  const lineMatch = reference.location?.match(/(?:#L|:)(\d+)/u);
  onOpenWorkspaceFile({
    cwd,
    path,
    line: lineMatch ? Number.parseInt(lineMatch[1] ?? "", 10) : undefined,
    label: reference.displayPath,
  });
}

function changeCopyMatchesFileReference(
  value: string,
  detailLines: ConversationWorkCellRow["detailLines"],
  stripUpdatePrefix = false,
): boolean {
  const normalizedValue = normalizeChangeCopy(stripUpdatePrefix
    ? value.replace(/^(?:已更新|Updated)\s*[:：]?\s*/iu, "")
    : value);
  return (detailLines ?? []).some((line) => {
    if (line.kind !== "file_ref") {
      return false;
    }
    const normalizedPath = normalizeChangeCopy(line.path);
    return normalizedValue === normalizedPath || normalizedValue === normalizeChangeCopy(terminalReportFileName(normalizedPath));
  });
}

function normalizeChangeCopy(value: string): string {
  return value.trim().replace(/\\/gu, "/");
}

function TerminalReportFileReference({
  target,
  onOpen,
}: {
  readonly target: TerminalReportFileTarget;
  readonly onOpen?: (target: TerminalReportFileTarget) => void;
}): React.JSX.Element {
  const tooltipId = useId();
  const timerRef = useRef<number | undefined>(undefined);
  const [tooltipVisible, setTooltipVisible] = useState(false);
  const fileName = terminalReportFileName(target.path);
  const fileIcon = terminalReportFileIcon(target.path);

  useEffect(() => () => {
    if (timerRef.current !== undefined) {
      globalThis.clearTimeout(timerRef.current);
    }
  }, []);

  function scheduleTooltip(): void {
    if (timerRef.current !== undefined) {
      globalThis.clearTimeout(timerRef.current);
    }
    timerRef.current = globalThis.setTimeout(() => {
      timerRef.current = undefined;
      setTooltipVisible(true);
    }, 1_000);
  }

  function hideTooltip(): void {
    if (timerRef.current !== undefined) {
      globalThis.clearTimeout(timerRef.current);
      timerRef.current = undefined;
    }
    setTooltipVisible(false);
  }

  return (
    <button
      className="terminal-report-file-reference"
      type="button"
      aria-describedby={tooltipVisible ? tooltipId : undefined}
      data-terminal-report-file-reference={target.path}
      onClick={() => onOpen?.({ ...target, label: fileName })}
      onMouseEnter={scheduleTooltip}
      onMouseLeave={hideTooltip}
      onFocus={scheduleTooltip}
      onBlur={hideTooltip}
    >
      <span className="terminal-report-file-type-icon" data-file-kind={fileIcon.kind} aria-hidden="true">
        <fileIcon.Icon size={12} />
      </span>
      <span>{fileName}</span>
      {tooltipVisible ? <span id={tooltipId} role="tooltip">{target.path}{target.line === undefined ? "" : `:${target.line}`}</span> : null}
    </button>
  );
}

const terminalReportFileIconByExtension: Readonly<Record<string, { readonly kind: string; readonly Icon: IconType }>> = {
  ".bash": { kind: "shell", Icon: SiShell },
  ".cc": { kind: "cpp", Icon: SiCplusplus },
  ".cjs": { kind: "javascript", Icon: SiJavascript },
  ".cpp": { kind: "cpp", Icon: SiCplusplus },
  ".cs": { kind: "csharp", Icon: SiSharp },
  ".css": { kind: "css", Icon: SiCss },
  ".cxx": { kind: "cpp", Icon: SiCplusplus },
  ".go": { kind: "go", Icon: SiGo },
  ".htm": { kind: "html", Icon: SiHtml5 },
  ".html": { kind: "html", Icon: SiHtml5 },
  ".java": { kind: "java", Icon: FaJava },
  ".js": { kind: "javascript", Icon: SiJavascript },
  ".json": { kind: "json", Icon: SiJson },
  ".jsonc": { kind: "json", Icon: SiJson },
  ".jsx": { kind: "react", Icon: SiReact },
  ".kt": { kind: "kotlin", Icon: SiKotlin },
  ".kts": { kind: "kotlin", Icon: SiKotlin },
  ".less": { kind: "css", Icon: SiCss },
  ".md": { kind: "markdown", Icon: SiMarkdown },
  ".mdx": { kind: "markdown", Icon: SiMarkdown },
  ".mjs": { kind: "javascript", Icon: SiJavascript },
  ".php": { kind: "php", Icon: SiPhp },
  ".py": { kind: "python", Icon: SiPython },
  ".rb": { kind: "ruby", Icon: SiRuby },
  ".rs": { kind: "rust", Icon: SiRust },
  ".sass": { kind: "css", Icon: SiCss },
  ".scss": { kind: "css", Icon: SiCss },
  ".sh": { kind: "shell", Icon: SiShell },
  ".svelte": { kind: "svelte", Icon: SiSvelte },
  ".swift": { kind: "swift", Icon: SiSwift },
  ".ts": { kind: "typescript", Icon: SiTypescript },
  ".tsx": { kind: "react", Icon: SiReact },
  ".vue": { kind: "vue", Icon: SiVuedotjs },
  ".yaml": { kind: "yaml", Icon: SiYaml },
  ".yml": { kind: "yaml", Icon: SiYaml },
  ".zsh": { kind: "shell", Icon: SiShell },
};

export function terminalReportFileIcon(path: string): { readonly kind: string; readonly Icon: IconType } {
  const fileName = terminalReportFileName(path).toLowerCase();
  const extensionIndex = fileName.lastIndexOf(".");
  const extension = extensionIndex > 0 ? fileName.slice(extensionIndex) : "";
  return terminalReportFileIconByExtension[extension] ?? {
    kind: isTextDocumentExtension(extension) ? "text" : "code",
    Icon: isTextDocumentExtension(extension) ? FileText : FileCode2,
  };
}

export function terminalReportFileName(path: string): string {
  const normalized = path.replace(/\\/gu, "/");
  return normalized.split("/").filter(Boolean).at(-1) || normalized;
}

function isTextDocumentExtension(extension: string): boolean {
  return extension === ".txt" || extension === ".log" || extension === ".csv" || extension === ".rst";
}

function reportRowIcon(kind: "correction" | "change" | "verification" | "risk"): React.JSX.Element {
  if (kind === "change") {
    return <FilePenLine size={13} />;
  }
  if (kind === "verification") {
    return <CheckCircle2 size={13} />;
  }
  return <CircleAlert size={13} />;
}
