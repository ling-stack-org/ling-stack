import { useEffect, useState, type ReactNode } from "react";
import {
  Archive,
  Command,
  FileCheck2,
  FolderOpen,
  GitBranch,
  ListChecks,
  Loader2,
  Search,
  SquareTerminal,
  X,
} from "lucide-react";
import { selectWorkspaceDirectory } from "../../api/workspace-directory.js";
import { useI18n, type Translate } from "../../i18n.js";
import type {
  ChannelWorkspaceBinding,
  ChannelWorkspaceMode,
  WorkspaceGitStatus,
} from "../../types.js";

export type ChannelEnvironmentRowTone = "success" | "running" | "waiting" | "blocked" | "failed" | "neutral" | "info";

export interface ChannelEnvironmentWorkspace {
  readonly mode: ChannelWorkspaceMode;
  readonly modeLabel: string;
  readonly status: ChannelWorkspaceBinding["status"];
  readonly path: string;
  readonly shortPath: string;
  readonly errorMessage?: string;
}

export type ChannelGitStatusLoadState =
  | { readonly status: "idle" }
  | { readonly status: "loading"; readonly requestKey: string }
  | { readonly status: "loaded"; readonly requestKey: string; readonly statusValue: WorkspaceGitStatus }
  | { readonly status: "error"; readonly requestKey: string; readonly errorMessage: string };

export interface ChannelEnvironmentGitChanges {
  readonly changedFileCount: number;
  readonly stagedFileCount: number;
  readonly unstagedFileCount: number;
  readonly untrackedFileCount: number;
  readonly conflictedFileCount: number;
  readonly additions?: number;
  readonly deletions?: number;
  readonly label: string;
}

export interface ChannelEnvironmentReviewSummary {
  readonly reviewItemCount: number;
  readonly actionItemCount: number;
  readonly label: string;
}

export interface ChannelEnvironmentGitStatus {
  readonly branchName: string;
  readonly baseBranch?: string;
}

export interface ChannelEnvironmentEvidenceSummary {
  readonly count: number;
  readonly label: string;
}

export interface ChannelEnvironmentOutputSummary {
  readonly count: number;
  readonly label: string;
}

export interface ChannelEnvironmentPopoverRow {
  readonly id: "changes" | "review" | "local" | "git-branch" | "commit-push";
  readonly icon: ReactNode;
  readonly label: string;
  readonly value?: string;
  readonly stats?: { readonly additions: number; readonly deletions: number };
  readonly tone: ChannelEnvironmentRowTone;
  readonly onOpen?: () => void;
  readonly disabled?: boolean;
  readonly disabledReason?: string;
}

export interface ChannelEnvironmentSummary {
  readonly workspace?: ChannelEnvironmentWorkspace;
  readonly gitStatusLoadState: ChannelGitStatusLoadState;
  readonly changes?: ChannelEnvironmentGitChanges;
  readonly review?: ChannelEnvironmentReviewSummary;
  readonly git?: ChannelEnvironmentGitStatus;
  readonly browser?: ChannelEnvironmentEvidenceSummary;
  readonly sources?: ChannelEnvironmentEvidenceSummary;
  readonly output?: ChannelEnvironmentOutputSummary;
  readonly commitAction?: {
    readonly disabledReason: string;
  };
  readonly popoverRows: readonly ChannelEnvironmentPopoverRow[];
}

export function ChannelEnvironmentPage({
  summary,
  channelName,
  workspacePickerCwd,
  onChangeWorkspacePath,
  onOpenReview,
  onOpenCommit,
}: {
  readonly summary: ChannelEnvironmentSummary;
  readonly channelName?: string;
  readonly workspacePickerCwd: string;
  readonly onChangeWorkspacePath: (path: string) => Promise<void>;
  readonly onOpenReview: () => void;
  readonly onOpenCommit: () => void;
}): JSX.Element {
  const { t } = useI18n();
  const [selectingDirectory, setSelectingDirectory] = useState(false);
  const [directoryError, setDirectoryError] = useState("");

  async function changeWorkspaceDirectory(): Promise<void> {
    if (selectingDirectory) {
      return;
    }
    const pickerCwd = summary.workspace?.path.trim() || workspacePickerCwd.trim();
    if (!pickerCwd) {
      setDirectoryError(t("Workspace folder unavailable"));
      return;
    }
    setSelectingDirectory(true);
    setDirectoryError("");
    try {
      const result = await selectWorkspaceDirectory(pickerCwd);
      if (result.cancelled) {
        return;
      }
      await onChangeWorkspacePath(result.path);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setDirectoryError(message || t("Folder picker unavailable."));
    } finally {
      setSelectingDirectory(false);
    }
  }

  return (
    <section className="channel-environment-page" aria-label={t("Environment")}>
      <div className="channel-environment-stack">
        <section className="channel-environment-section local" aria-label={t("Local environment")}>
          <header>
            <span>
              <Command size={15} />
              <strong>{t("Local environment")}</strong>
            </span>
            <small>{channelName ? `#${channelName}` : t("Current channel")}</small>
          </header>
          {summary.workspace ? (
            <div className="channel-environment-row interactive">
              <span className={`channel-environment-row-icon ${summary.workspace.status}`}>
                <FolderOpen size={16} />
              </span>
              <span className="channel-environment-row-copy">
                <strong>{summary.workspace.modeLabel}</strong>
                <small title={summary.workspace.path}>{summary.workspace.path || t("No workspace path")}</small>
                {summary.workspace.errorMessage ? <small className="danger-text">{summary.workspace.errorMessage}</small> : null}
              </span>
              <button className="secondary-button compact-button" type="button" onClick={() => void changeWorkspaceDirectory()} disabled={selectingDirectory}>
                {selectingDirectory ? <Loader2 className="spin" size={14} /> : <FolderOpen size={14} />}
                {selectingDirectory ? t("Selecting project...") : t("Change directory")}
              </button>
            </div>
          ) : (
            <div className="channel-environment-empty">{t("No local workspace is bound to this channel.")}</div>
          )}
          {directoryError ? <small className="channel-environment-directory-error danger-text" role="alert">{directoryError}</small> : null}
        </section>

        <section className="channel-environment-section changes" aria-label={t("Changes")}>
          <header>
            <span>
              <ListChecks size={15} />
              <strong>{t("Changes")}</strong>
            </span>
            {summary.changes
              ? environmentChangesHaveDiffStats(summary.changes)
                ? <ChannelEnvironmentDiffStat additions={summary.changes.additions ?? 0} deletions={summary.changes.deletions ?? 0} />
                : <small>{summary.changes.label}</small>
              : <small>{environmentGitStatusLabel(summary.gitStatusLoadState, t)}</small>}
          </header>
          {summary.changes ? (
            <div className="channel-environment-row">
              <span className="channel-environment-row-icon waiting">
                <ListChecks size={16} />
              </span>
              <span className="channel-environment-row-copy">
                <strong>{summary.changes.label}</strong>
                <small>{environmentChangesDetail(summary.changes, t)}</small>
              </span>
            </div>
          ) : (
            <div className="channel-environment-empty">{environmentGitStatusEmptyMessage(summary.gitStatusLoadState, t)}</div>
          )}
        </section>

        <section className="channel-environment-section review" aria-label={t("Review")}>
          <header>
            <span>
              <ListChecks size={15} />
              <strong>{t("Review")}</strong>
            </span>
            <small>{summary.review?.label ?? t("No review items")}</small>
          </header>
          {summary.review ? (
            <div className="channel-environment-row interactive">
              <span className="channel-environment-row-icon waiting">
                <ListChecks size={16} />
              </span>
              <span className="channel-environment-row-copy">
                <strong>{summary.review.label}</strong>
                <small>{t("Open the Review page to inspect runtime issues, evidence gaps, and approval gates.")}</small>
              </span>
              <button className="secondary-button compact-button" type="button" onClick={onOpenReview}>
                <ListChecks size={14} />
                {t("View review")}
              </button>
            </div>
          ) : (
            <div className="channel-environment-empty">{t("No review items")}</div>
          )}
        </section>

        <section className="channel-environment-section git" aria-label={t("Working branch")}>
          <header>
            <span>
              <GitBranch size={15} />
              <strong>{t("Working branch")}</strong>
            </span>
            <small>{summary.git?.branchName ?? t("Unavailable")}</small>
          </header>
          {summary.git ? (
            <div className="channel-environment-row">
              <span className="channel-environment-row-icon info">
                <GitBranch size={16} />
              </span>
              <span className="channel-environment-row-copy">
                <strong>{summary.git.branchName}</strong>
                <small>{summary.git.baseBranch ? t("Base branch: {branch}", { branch: summary.git.baseBranch }) : t("Git branch from channel workspace binding.")}</small>
              </span>
            </div>
          ) : (
            <div className="channel-environment-empty">{t("Working branch unavailable")}</div>
          )}
        </section>

        <section className="channel-environment-section commit" aria-label={t("Commit or push")}>
          <header>
            <span>
              <SquareTerminal size={15} />
              <strong>{t("Commit or push")}</strong>
            </span>
            <small>{t("Read-only shell")}</small>
          </header>
          <div className="channel-environment-row interactive">
            <span className="channel-environment-row-icon neutral">
              <SquareTerminal size={16} />
            </span>
            <span className="channel-environment-row-copy">
              <strong>{t("Commit shell is disabled")}</strong>
              <small>{summary.commitAction?.disabledReason ?? t("Commit and push require a daemon Git action and approval policy. This first version is read-only.")}</small>
            </span>
            <button className="secondary-button compact-button" type="button" onClick={onOpenCommit}>
              {t("Open")}
            </button>
          </div>
        </section>

        <section className="channel-environment-section browser" aria-label={t("Browser")}>
          <header>
            <span>
              <Search size={15} />
              <strong>{t("Browser")}</strong>
            </span>
            <small>{summary.browser?.label ?? t("No browser evidence")}</small>
          </header>
          <div className="channel-environment-empty">{summary.browser?.label ?? t("No browser evidence")}</div>
        </section>

        <section className="channel-environment-section sources" aria-label={t("Sources")}>
          <header>
            <span>
              <FileCheck2 size={15} />
              <strong>{t("Sources")}</strong>
            </span>
            <small>{summary.sources?.label ?? t("No sources")}</small>
          </header>
          <div className="channel-environment-empty">{summary.sources?.label ?? t("No sources")}</div>
        </section>

        <section className="channel-environment-section output" aria-label={t("Output")}>
          <header>
            <span>
              <Archive size={15} />
              <strong>{t("Output")}</strong>
            </span>
            <small>{summary.output?.label ?? t("No artifacts")}</small>
          </header>
          <div className="channel-environment-empty">{summary.output?.label ?? t("No artifacts")}</div>
        </section>
      </div>
    </section>
  );
}

export function ChannelEnvironmentCommitDialog({
  message,
  includeUnstaged,
  disabledReason,
  onMessageChange,
  onIncludeUnstagedChange,
  onClose,
}: {
  readonly message: string;
  readonly includeUnstaged: boolean;
  readonly disabledReason: string;
  readonly onMessageChange: (message: string) => void;
  readonly onIncludeUnstagedChange: (include: boolean) => void;
  readonly onClose: () => void;
}): JSX.Element {
  const { t } = useI18n();
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        onClose();
      }
    }
    globalThis.addEventListener("keydown", onKeyDown);
    return () => globalThis.removeEventListener("keydown", onKeyDown);
  }, [onClose]);
  return (
    <div
      className="environment-commit-dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <section className="environment-commit-dialog" role="dialog" aria-modal="true" aria-label={t("Commit or push")}>
        <header className="environment-commit-dialog-head">
          <span>
            <SquareTerminal size={16} />
            <strong>{t("Commit or push")}</strong>
          </span>
          <button className="icon-button" type="button" onClick={onClose} aria-label={t("Close")} title={t("Close")}>
            <X size={14} />
          </button>
        </header>
        <label className="field">
          <span>{t("Commit message")}</span>
          <textarea
            className="environment-commit-message"
            value={message}
            onChange={(event) => onMessageChange(event.target.value)}
            placeholder={t("Describe the change")}
          />
        </label>
        <label className="checkbox-row environment-include-unstaged">
          <input
            type="checkbox"
            checked={includeUnstaged}
            onChange={(event) => onIncludeUnstagedChange(event.target.checked)}
          />
          <span>{t("Include unstaged changes")}</span>
        </label>
        <p>{disabledReason}</p>
        <div className="environment-commit-actions">
          <button className="secondary-button compact-button" type="button" disabled title={disabledReason}>{t("Commit")}</button>
          <button className="secondary-button compact-button" type="button" disabled title={disabledReason}>{t("Commit and push")}</button>
          <button className="secondary-button compact-button" type="button" disabled title={disabledReason}>{t("Push")}</button>
          <button className="secondary-button compact-button" type="button" onClick={onClose}>{t("Cancel")}</button>
        </div>
      </section>
    </div>
  );
}

export function ChannelEnvironmentDiffStat({
  additions,
  deletions,
}: {
  readonly additions: number;
  readonly deletions: number;
}): JSX.Element {
  return (
    <span className="channel-environment-diff-stat" aria-label={`+${additions} -${deletions}`}>
      <span className="add">+{additions}</span>
      <span className="del">-{deletions}</span>
    </span>
  );
}

export function environmentChangesHaveDiffStats(changes: ChannelEnvironmentGitChanges): boolean {
  return typeof changes.additions === "number" && typeof changes.deletions === "number" && (changes.additions !== 0 || changes.deletions !== 0);
}

export function environmentChangesLabel(changedFileCount: number, t: Translate): string {
  if (changedFileCount === 1) {
    return t("1 changed file");
  }
  return t("{count} changed files", { count: changedFileCount });
}

function environmentChangesDetail(changes: ChannelEnvironmentGitChanges, t: Translate): string {
  const parts = [
    changes.stagedFileCount > 0 ? t("{count} staged", { count: changes.stagedFileCount }) : "",
    changes.unstagedFileCount > 0 ? t("{count} unstaged", { count: changes.unstagedFileCount }) : "",
    changes.untrackedFileCount > 0 ? t("{count} untracked", { count: changes.untrackedFileCount }) : "",
    changes.conflictedFileCount > 0 ? t("{count} conflicted", { count: changes.conflictedFileCount }) : "",
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : t("Git working tree has local changes.");
}

export function environmentReviewLabel(reviewItemCount: number, t: Translate): string {
  if (reviewItemCount === 1) {
    return t("1 review item");
  }
  return t("{count} review items", { count: reviewItemCount });
}

function environmentGitStatusLabel(state: ChannelGitStatusLoadState, t: Translate): string {
  if (state.status === "loading") {
    return t("Loading Git status");
  }
  if (state.status === "error") {
    return t("Git status unavailable");
  }
  if (state.status !== "loaded") {
    return t("Git status unavailable");
  }
  switch (state.statusValue.state) {
    case "clean":
      return t("No code changes");
    case "not_git_repo":
      return t("Not a Git repository");
    case "unavailable":
      return state.statusValue.unavailableReason ?? t("Git status unavailable");
    case "error":
      return state.statusValue.errorMessage ?? t("Git status failed");
    case "dirty":
      return environmentChangesLabel(state.statusValue.changedFileCount, t);
    default:
      return t("Git status unavailable");
  }
}

function environmentGitStatusEmptyMessage(state: ChannelGitStatusLoadState, t: Translate): string {
  if (state.status === "loading") {
    return t("Loading Git status");
  }
  if (state.status === "error") {
    return t("Git status unavailable");
  }
  if (state.status !== "loaded") {
    return t("Git status unavailable");
  }
  switch (state.statusValue.state) {
    case "clean":
      return t("No code changes");
    case "not_git_repo":
      return t("Not a Git repository");
    case "unavailable":
      return t("Git status unavailable");
    case "error":
      return t("Git status failed");
    case "dirty":
      return environmentChangesLabel(state.statusValue.changedFileCount, t);
    default:
      return t("Git status unavailable");
  }
}
