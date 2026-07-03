import { useCallback, useEffect, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import type { WorkspaceTerminalCommandResponse } from "@ling-stack/contracts";
import { LoaderCircle, SquareTerminal, X } from "lucide-react";
import { runWorkspaceTerminalCommand } from "../../api.js";
import { useI18n } from "../../i18n.js";

interface WorkspaceTerminalHistoryEntry {
  readonly id: string;
  readonly command: string;
  readonly status: "running" | WorkspaceTerminalCommandResponse["status"] | "client_failed";
  readonly response?: WorkspaceTerminalCommandResponse;
  readonly error?: string;
}

export interface WorkspaceTerminalPanelProps {
  readonly cwd?: string;
  readonly className?: string;
  readonly onClose?: () => void;
  readonly resizeHandleNode?: ReactNode;
  readonly style?: CSSProperties;
}

export function WorkspaceTerminalPanel({
  cwd,
  className,
  onClose,
  resizeHandleNode,
  style,
}: WorkspaceTerminalPanelProps): JSX.Element {
  const { t } = useI18n();
  const [command, setCommand] = useState("");
  const [entries, setEntries] = useState<readonly WorkspaceTerminalHistoryEntry[]>([]);
  const [running, setRunning] = useState(false);
  const historyEndRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const workspaceLabel = cwd ? workspaceTerminalLabel(cwd) : t("Workspace");
  const prompt = `${workspaceLabel} %`;

  useEffect(() => {
    inputRef.current?.focus();
  }, [cwd]);

  useEffect(() => {
    historyEndRef.current?.scrollIntoView({ block: "end" });
  }, [entries]);

  const handleSubmit = useCallback((event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!cwd || running) {
      return;
    }
    const nextCommand = (inputRef.current?.value ?? command).trim();
    if (!nextCommand) {
      return;
    }
    const localId = `terminal-${Date.now()}-${entries.length}`;
    if (inputRef.current) {
      inputRef.current.value = "";
    }
    setCommand("");
    setRunning(true);
    setEntries((current) => [
      ...current,
      {
        id: localId,
        command: nextCommand,
        status: "running",
      },
    ]);
    void runWorkspaceTerminalCommand(cwd, { command: nextCommand })
      .then((response) => {
        setEntries((current) => current.map((entry) => entry.id === localId
          ? { ...entry, response, status: response.status }
          : entry));
      })
      .catch((error: unknown) => {
        setEntries((current) => current.map((entry) => entry.id === localId
          ? {
              ...entry,
              status: "client_failed",
              error: error instanceof Error ? error.message : String(error),
            }
          : entry));
      })
      .finally(() => {
        setRunning(false);
        requestAnimationFrame(() => inputRef.current?.focus());
      });
  }, [command, cwd, entries.length, running]);

  return (
    <section className={["workspace-terminal-panel", className].filter(Boolean).join(" ")} style={style} aria-label={t("Terminal session")}>
      {resizeHandleNode}
      <header className="workspace-terminal-head">
        <span className="workspace-terminal-tab" title={cwd}>
          <SquareTerminal size={13} />
          <strong>{workspaceLabel}</strong>
        </span>
        <span className="workspace-terminal-tab-plus" aria-hidden="true">+</span>
        {onClose ? (
          <button
            className="workspace-terminal-close"
            type="button"
            aria-label={t("Close terminal panel")}
            title={t("Close terminal panel")}
            onClick={onClose}
          >
            <X size={15} />
          </button>
        ) : null}
      </header>
      <div className="workspace-terminal-screen">
        <div className="workspace-terminal-history" role="log" aria-live="polite">
          {entries.map((entry) => (
            <WorkspaceTerminalHistoryLine
              key={entry.id}
              entry={entry}
              prompt={prompt}
            />
          ))}
          <form className="workspace-terminal-prompt-row" onSubmit={handleSubmit}>
            <span className="workspace-terminal-prompt" title={prompt}>{prompt}</span>
            <input
              ref={inputRef}
              aria-label={t("Command")}
              autoCapitalize="off"
              autoComplete="off"
              disabled={!cwd || running}
              placeholder={cwd ? "" : t("Workspace folder unavailable")}
              spellCheck={false}
              value={command}
              onChange={(event) => setCommand(event.target.value)}
            />
            {running ? <LoaderCircle size={14} className="spin-icon workspace-terminal-running" /> : null}
          </form>
          <div ref={historyEndRef} />
        </div>
      </div>
    </section>
  );
}

function WorkspaceTerminalHistoryLine({
  entry,
  prompt,
}: {
  readonly entry: WorkspaceTerminalHistoryEntry;
  readonly prompt: string;
}): JSX.Element {
  const { t } = useI18n();
  const response = entry.response;
  const hasStdout = Boolean(response?.stdout);
  const hasStderr = Boolean(response?.stderr);
  const statusLabel = terminalStatusLabel(entry, t);
  return (
    <article className={`workspace-terminal-entry status-${entry.status}`}>
      <div className="workspace-terminal-command-line">
        <span>{prompt}</span>
        <code>{entry.command}</code>
      </div>
      {entry.status === "running" ? (
        <p className="workspace-terminal-output muted">{t("Running...")}</p>
      ) : null}
      {hasStdout ? (
        <pre className="workspace-terminal-output">{response?.stdout ?? ""}{response?.stdoutTruncated ? `\n${t("Output truncated")}` : ""}</pre>
      ) : null}
      {hasStderr ? (
        <pre className="workspace-terminal-output stderr">{response?.stderr ?? ""}{response?.stderrTruncated ? `\n${t("Output truncated")}` : ""}</pre>
      ) : null}
      {entry.error ? <pre className="workspace-terminal-output stderr">{entry.error}</pre> : null}
      {entry.status !== "running" && !hasStdout && !hasStderr && !entry.error ? (
        <p className="workspace-terminal-output muted">{t("No output")}</p>
      ) : null}
      {entry.status !== "running" ? <small className="workspace-terminal-status">{statusLabel}</small> : null}
    </article>
  );
}

function terminalStatusLabel(
  entry: WorkspaceTerminalHistoryEntry,
  t: ReturnType<typeof useI18n>["t"],
): string {
  if (entry.status === "succeeded") {
    return entry.response?.exitCode === undefined
      ? t("Done")
      : t("Exit {code}", { code: entry.response.exitCode });
  }
  if (entry.status === "timed_out") {
    return t("Timed out");
  }
  if (entry.status === "client_failed") {
    return t("Command failed");
  }
  if (entry.status === "failed") {
    return entry.response?.exitCode === undefined
      ? t("Command failed")
      : t("Exit {code}", { code: entry.response.exitCode });
  }
  return t("Running...");
}

function workspaceTerminalLabel(cwd: string): string {
  const normalized = cwd.trim().replace(/\/+$/, "");
  return normalized.split("/").filter(Boolean).at(-1) ?? normalized;
}
