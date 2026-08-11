import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import type { WorkspaceTerminalCommandResponse, WorkspaceTerminalProfileResponse } from "@ling-stack/contracts";
import { SquareTerminal, X } from "lucide-react";
import { getWorkspaceTerminalProfile, runWorkspaceTerminalCommand } from "../../api.js";
import { useI18n } from "../../i18n.js";
import { Input, Spinner } from "../../shared/ui/index.js";
import type { ConversationPanelMotionState } from "./useConversationPanelPresence.js";

export interface WorkspaceTerminalHistoryEntry {
  readonly id: string;
  readonly command: string;
  readonly status: "running" | WorkspaceTerminalCommandResponse["status"] | "client_failed";
  readonly response?: WorkspaceTerminalCommandResponse;
  readonly error?: string;
}

export interface WorkspaceTerminalSession {
  readonly command: string;
  readonly entries: readonly WorkspaceTerminalHistoryEntry[];
  readonly prompt: string;
  readonly workspaceLabel: string;
  readonly running: boolean;
  readonly setCommand: (command: string) => void;
  readonly submitCommand: (command: string) => void;
}

export interface WorkspaceTerminalPanelProps {
  readonly cwd?: string;
  readonly className?: string;
  readonly session?: WorkspaceTerminalSession;
  readonly onClose?: () => void;
  readonly resizeHandleNode?: ReactNode;
  readonly style?: CSSProperties;
  readonly expanded?: boolean;
  readonly motionState?: ConversationPanelMotionState;
  readonly resizing?: boolean;
}

export function useWorkspaceTerminalSession(cwd?: string): WorkspaceTerminalSession {
  const { t } = useI18n();
  const [command, setCommand] = useState("");
  const [entries, setEntries] = useState<readonly WorkspaceTerminalHistoryEntry[]>([]);
  const [running, setRunning] = useState(false);
  const [profile, setProfile] = useState<WorkspaceTerminalProfileResponse | undefined>();
  const workspaceLabel = profile?.workspaceLabel ?? (cwd ? workspaceTerminalLabel(cwd) : t("Workspace"));
  const prompt = profile?.promptLabel ?? `${workspaceLabel} %`;

  useEffect(() => {
    setCommand("");
    setEntries([]);
    setProfile(undefined);
    if (!cwd) {
      return;
    }
    let cancelled = false;
    void getWorkspaceTerminalProfile(cwd)
      .then((nextProfile) => {
        if (!cancelled) {
          setProfile(nextProfile);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setProfile(undefined);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [cwd]);

  const submitCommand = useCallback((nextCommand: string) => {
    if (!cwd || running) {
      return;
    }
    const trimmedCommand = nextCommand.trim();
    if (!trimmedCommand) {
      return;
    }
    const localId = `terminal-${Date.now()}-${entries.length}`;
    setCommand("");
    setRunning(true);
    setEntries((current) => [
      ...current,
      {
        id: localId,
        command: trimmedCommand,
        status: "running",
      },
    ]);
    void runWorkspaceTerminalCommand(cwd, { command: trimmedCommand })
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
      });
  }, [cwd, entries.length, running]);

  return useMemo(() => ({
    command,
    entries,
    prompt,
    workspaceLabel,
    running,
    setCommand,
    submitCommand,
  }), [command, entries, prompt, running, submitCommand, workspaceLabel]);
}

export function WorkspaceTerminalPanel({
  cwd,
  className,
  session,
  onClose,
  resizeHandleNode,
  style,
  expanded = true,
  motionState = "open",
  resizing = false,
}: WorkspaceTerminalPanelProps): React.JSX.Element {
  const { t } = useI18n();
  const internalSession = useWorkspaceTerminalSession(session ? undefined : cwd);
  const terminalSession = session ?? internalSession;
  const historyEndRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, [cwd]);

  useEffect(() => {
    historyEndRef.current?.scrollIntoView({ block: "end" });
  }, [terminalSession.entries]);

  const handleSubmit = useCallback((event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!cwd || terminalSession.running) {
      return;
    }
    const nextCommand = (inputRef.current?.value ?? terminalSession.command).trim();
    if (!nextCommand) {
      return;
    }
    terminalSession.submitCommand(nextCommand);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [cwd, terminalSession]);

  return (
    <section
      className={["workspace-terminal-panel", `bottom-panel-motion-${motionState}`, className].filter(Boolean).join(" ")}
      data-bottom-panel-expanded={expanded ? "true" : "false"}
      data-bottom-panel-motion={resizing ? "resizing" : motionState}
      data-resizing={resizing ? "true" : undefined}
      data-computer-use-obstacle="true"
      data-computer-use-obstacle-kind="terminal"
      style={style}
      aria-label={t("Terminal session")}
    >
      {resizeHandleNode}
      <header className="workspace-terminal-head">
        <span className="workspace-terminal-tab" title={cwd}>
          <SquareTerminal size={13} />
          <strong>{terminalSession.workspaceLabel}</strong>
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
          {terminalSession.entries.map((entry) => (
            <WorkspaceTerminalHistoryLine
              key={entry.id}
              entry={entry}
              prompt={terminalSession.prompt}
            />
          ))}
          <form className="workspace-terminal-prompt-row" onSubmit={handleSubmit}>
            <span className="workspace-terminal-prompt" title={terminalSession.prompt}>{terminalSession.prompt}</span>
            <Input
              ref={inputRef}
              aria-label={t("Command")}
              autoCapitalize="off"
              autoComplete="off"
              className="workspace-terminal-command-native"
              containerClassName="workspace-terminal-command-input"
              disabled={!cwd || terminalSession.running}
              placeholder={cwd ? "" : t("Workspace folder unavailable")}
              size="sm"
              spellCheck={false}
              value={terminalSession.command}
              onChange={(event) => terminalSession.setCommand(event.target.value)}
            />
            {terminalSession.running ? <Spinner size="sm" className="workspace-terminal-running" /> : null}
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
}): React.JSX.Element {
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
