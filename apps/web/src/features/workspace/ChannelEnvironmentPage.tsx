import { useState, type ReactNode } from "react";
import {
  Archive,
  FileCheck2,
  FolderOpen,
  GitBranch,
  ListChecks,
  Search,
  SquareTerminal,
} from "lucide-react";
import { selectWorkspaceDirectory } from "../../api/workspace-directory.js";
import { useI18n, type Translate } from "../../i18n.js";
import {
  Button,
  DataRow,
  InlineFeedback,
  InspectorSection,
  StatusIndicator,
  type StatusTone,
} from "../../shared/ui/index.js";
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
  readonly commitAction?: { readonly disabledReason: string };
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
  const surfaceState = deriveEnvironmentSurfaceState(summary);
  const gitState = deriveGitRowState(summary, t);
  const workspaceReady = summary.workspace?.status === "ready";
  const commitDisabledReason = summary.commitAction?.disabledReason
    ?? t("Commit and push require a daemon Git action and approval policy. This first version is read-only.");

  async function changeWorkspaceDirectory(): Promise<void> {
    if (selectingDirectory) return;
    const pickerCwd = summary.workspace?.path.trim() || workspacePickerCwd.trim();
    if (!pickerCwd) {
      setDirectoryError(t("Workspace folder unavailable"));
      return;
    }
    setSelectingDirectory(true);
    setDirectoryError("");
    try {
      const result = await selectWorkspaceDirectory(pickerCwd);
      if (!result.cancelled) await onChangeWorkspacePath(result.path);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setDirectoryError(message || t("Folder picker unavailable."));
    } finally {
      setSelectingDirectory(false);
    }
  }

  return (
    <section
      className="channel-environment-page"
      aria-label={t("Environment")}
      data-ui2-channel-environment="true"
      data-environment-state={surfaceState.id}
    >
      <header className="channel-environment-page-header">
        <div>
          <h2>{t("Environment")}</h2>
          <span>{channelName ? `#${channelName}` : t("Current channel")}</span>
        </div>
        <StatusIndicator label={t(surfaceState.label)} tone={surfaceState.tone} />
      </header>

      {summary.gitStatusLoadState.status === "error" ? (
        <InlineFeedback tone="danger" title={t("Git status unavailable")}>
          {summary.gitStatusLoadState.errorMessage}
        </InlineFeedback>
      ) : null}
      {directoryError ? <InlineFeedback tone="danger">{directoryError}</InlineFeedback> : null}
      {summary.workspace?.errorMessage ? (
        <InlineFeedback tone="danger" title={t("Workspace folder unavailable")}>
          {summary.workspace.errorMessage}
        </InlineFeedback>
      ) : null}

      <div className="channel-environment-list" role="list">
        <DataRow
          compact
          role="listitem"
          data-environment-row="workspace"
          identity={<EnvironmentIdentity icon={<FolderOpen />} label={t("Local environment")} />}
          summary={summary.workspace?.path || t("No local workspace is bound to this channel.")}
          status={<StatusIndicator label={summary.workspace?.modeLabel ?? t("Unavailable")} tone={workspaceReady ? "success" : "danger"} />}
          actions={(
            <Button
              size="sm"
              variant="secondary"
              leadingIcon={<FolderOpen size={14} />}
              loading={selectingDirectory}
              loadingLabel={t("Selecting project...")}
              onClick={() => void changeWorkspaceDirectory()}
              disabled={!summary.workspace && !workspacePickerCwd.trim()}
            >
              {t("Change directory")}
            </Button>
          )}
        />
        <DataRow
          compact
          role="listitem"
          data-environment-row="changes"
          identity={<EnvironmentIdentity icon={<ListChecks />} label={t("Changes")} />}
          summary={summary.changes ? environmentChangesDetail(summary.changes, t) : environmentGitStatusEmptyMessage(summary.gitStatusLoadState, t)}
          status={(
            <span className="channel-environment-change-status">
              {summary.changes && environmentChangesHaveDiffStats(summary.changes)
                ? <ChannelEnvironmentDiffStat additions={summary.changes.additions ?? 0} deletions={summary.changes.deletions ?? 0} />
                : null}
              <StatusIndicator label={gitState.label} tone={gitState.tone} />
            </span>
          )}
        />
        <DataRow
          compact
          role="listitem"
          data-environment-row="review"
          identity={<EnvironmentIdentity icon={<ListChecks />} label={t("Review")} />}
          summary={summary.review?.label ?? t("No review items")}
          status={<StatusIndicator label={summary.review ? t("Needs attention") : t("Ready")} tone={summary.review ? "warning" : "neutral"} />}
          actions={summary.review ? (
            <Button size="sm" variant="secondary" onClick={onOpenReview}>{t("View review")}</Button>
          ) : undefined}
        />
        <DataRow
          compact
          role="listitem"
          data-environment-row="branch"
          identity={<EnvironmentIdentity icon={<GitBranch />} label={t("Working branch")} />}
          summary={summary.git?.baseBranch ? t("Base branch: {branch}", { branch: summary.git.baseBranch }) : t("Git branch from channel workspace binding.")}
          status={<StatusIndicator label={summary.git?.branchName ?? t("Unavailable")} tone={summary.git ? "info" : "neutral"} />}
        />
        <DataRow
          compact
          role="listitem"
          data-environment-row="commit"
          identity={<EnvironmentIdentity icon={<SquareTerminal />} label={t("Commit or push")} />}
          summary={t("Read-only shell")}
          status={<StatusIndicator label={t("Unavailable")} tone="neutral" />}
          actions={<Button size="sm" variant="secondary" onClick={onOpenCommit}>{t("Open")}</Button>}
        />
      </div>

      <InspectorSection
        className="channel-environment-evidence"
        title={t("Evidence and output")}
        summary={environmentEvidenceSummary(summary, t)}
      >
        <div className="channel-environment-evidence-grid">
          <EnvironmentMetric icon={<Search />} label={t("Browser")} value={summary.browser?.label ?? t("No browser evidence")} />
          <EnvironmentMetric icon={<FileCheck2 />} label={t("Sources")} value={summary.sources?.label ?? t("No sources")} />
          <EnvironmentMetric icon={<Archive />} label={t("Output")} value={summary.output?.label ?? t("No artifacts")} />
        </div>
        <InlineFeedback tone="neutral" title={t("Commit shell is disabled")}>{commitDisabledReason}</InlineFeedback>
      </InspectorSection>
    </section>
  );
}

function EnvironmentIdentity({ icon, label }: { readonly icon: ReactNode; readonly label: string }): JSX.Element {
  return <span className="channel-environment-identity"><span aria-hidden="true">{icon}</span><strong>{label}</strong></span>;
}

function EnvironmentMetric({ icon, label, value }: { readonly icon: ReactNode; readonly label: string; readonly value: string }): JSX.Element {
  return <span className="channel-environment-metric"><span aria-hidden="true">{icon}</span><span><strong>{label}</strong><small>{value}</small></span></span>;
}

function deriveEnvironmentSurfaceState(summary: ChannelEnvironmentSummary): { readonly id: string; readonly label: string; readonly tone: StatusTone } {
  if (summary.gitStatusLoadState.status === "error" || summary.workspace?.status === "blocked" || summary.workspace?.status === "missing") {
    return { id: "blocked", label: "Needs attention", tone: "danger" };
  }
  if (summary.changes?.conflictedFileCount) return { id: "conflict", label: "Needs attention", tone: "danger" };
  if (summary.gitStatusLoadState.status === "loading") return { id: "loading", label: "Loading", tone: "info" };
  if (summary.changes || summary.review) return { id: "attention", label: "Needs attention", tone: "warning" };
  return { id: "ready", label: "Ready", tone: "success" };
}

function deriveGitRowState(summary: ChannelEnvironmentSummary, t: Translate): { readonly label: string; readonly tone: StatusTone } {
  if (summary.gitStatusLoadState.status === "error") return { label: t("Unavailable"), tone: "danger" };
  if (summary.gitStatusLoadState.status === "loading") return { label: t("Loading"), tone: "info" };
  if (summary.changes?.conflictedFileCount) return { label: t("Needs attention"), tone: "danger" };
  if (summary.changes) return { label: summary.changes.label, tone: "warning" };
  const status = environmentGitStatusLabel(summary.gitStatusLoadState, t);
  return { label: status, tone: status === t("No code changes") ? "success" : "neutral" };
}

function environmentEvidenceSummary(summary: ChannelEnvironmentSummary, t: Translate): string {
  const count = (summary.browser?.count ?? 0) + (summary.sources?.count ?? 0) + (summary.output?.count ?? 0);
  return count === 0 ? t("No linked resources") : t("{count} linked items", { count });
}

export function ChannelEnvironmentDiffStat({ additions, deletions }: { readonly additions: number; readonly deletions: number }): JSX.Element {
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
  return changedFileCount === 1 ? t("1 changed file") : t("{count} changed files", { count: changedFileCount });
}

function environmentChangesDetail(changes: ChannelEnvironmentGitChanges, t: Translate): string {
  const parts = [
    changes.stagedFileCount > 0 ? t("{count} staged", { count: changes.stagedFileCount }) : "",
    changes.unstagedFileCount > 0 ? t("{count} unstaged", { count: changes.unstagedFileCount }) : "",
    changes.untrackedFileCount > 0 ? t("{count} untracked", { count: changes.untrackedFileCount }) : "",
    changes.conflictedFileCount > 0 ? t("{count} conflicted", { count: changes.conflictedFileCount }) : "",
  ].filter(Boolean);
  const total = environmentChangesLabel(changes.changedFileCount, t);
  return parts.length > 0 ? `${total} · ${parts.join(" · ")}` : total;
}

export function environmentReviewLabel(reviewItemCount: number, t: Translate): string {
  return reviewItemCount === 1 ? t("1 review item") : t("{count} review items", { count: reviewItemCount });
}

function environmentGitStatusLabel(state: ChannelGitStatusLoadState, t: Translate): string {
  if (state.status === "loading") return t("Loading Git status");
  if (state.status === "error" || state.status !== "loaded") return t("Git status unavailable");
  switch (state.statusValue.state) {
    case "clean": return t("No code changes");
    case "not_git_repo": return t("Not a Git repository");
    case "unavailable": return state.statusValue.unavailableReason ?? t("Git status unavailable");
    case "error": return state.statusValue.errorMessage ?? t("Git status failed");
    case "dirty": return environmentChangesLabel(state.statusValue.changedFileCount, t);
    default: return t("Git status unavailable");
  }
}

function environmentGitStatusEmptyMessage(state: ChannelGitStatusLoadState, t: Translate): string {
  if (state.status === "loading") return t("Loading Git status");
  if (state.status === "error" || state.status !== "loaded") return t("Git status unavailable");
  switch (state.statusValue.state) {
    case "clean": return t("No code changes");
    case "not_git_repo": return t("Not a Git repository");
    case "unavailable": return t("Git status unavailable");
    case "error": return t("Git status failed");
    case "dirty": return environmentChangesLabel(state.statusValue.changedFileCount, t);
    default: return t("Git status unavailable");
  }
}
