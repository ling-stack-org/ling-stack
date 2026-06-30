import { useMemo } from "react";
import {
  GitBranch,
  ListChecks,
  SquareTerminal,
} from "lucide-react";
import type { Translate } from "../../i18n.js";
import { conversationContextSourceSummaryLabel, type ConversationContextSourceSummary } from "../../lib/conversation-context-sources.js";
import type {
  ChannelWorkspaceBinding,
} from "../../types.js";
import {
  ChannelEnvironmentPage,
  environmentChangesHaveDiffStats,
  environmentChangesLabel,
  environmentReviewLabel,
  type ChannelEnvironmentEvidenceSummary,
  type ChannelEnvironmentGitChanges,
  type ChannelEnvironmentGitStatus,
  type ChannelEnvironmentOutputSummary,
  type ChannelEnvironmentPopoverRow,
  type ChannelEnvironmentReviewSummary,
  type ChannelEnvironmentSummary,
  type ChannelEnvironmentWorkspace,
  type ChannelGitStatusLoadState,
} from "./ChannelEnvironmentPage.js";
import {
  channelWorkspaceModeIcon,
  channelWorkspaceModeLabel,
  shortWorkspacePath,
} from "./ChannelSettingsPanels.js";
import type { WorkspaceRightDockProps } from "./right-dock/index.js";

interface ChannelEnvironmentSummaryInput {
  readonly cwd: string;
  readonly workspace?: ChannelWorkspaceBinding;
  readonly executionPath: string;
  readonly gitStatusState: ChannelGitStatusLoadState;
  readonly reviewItems: WorkspaceRightDockProps["reviewItems"];
  readonly evidenceGroups: WorkspaceRightDockProps["evidenceGroups"];
  readonly fileItems: WorkspaceRightDockProps["fileItems"];
  readonly activeSourceSummary?: ConversationContextSourceSummary;
  readonly t: Translate;
  readonly onOpenReview: () => void;
  readonly onOpenEnvironment: () => void;
  readonly onOpenCommit: () => void;
}

export function useChannelEnvironmentSummary({
  cwd,
  workspace: selectedChannelWorkspace,
  executionPath,
  gitStatusState,
  reviewItems,
  evidenceGroups,
  fileItems,
  activeSourceSummary,
  t,
  onOpenReview,
  onOpenEnvironment,
  onOpenCommit,
}: ChannelEnvironmentSummaryInput): ChannelEnvironmentSummary {
  return useMemo<ChannelEnvironmentSummary>(() => {
    const workspace = selectedChannelWorkspace ? {
      mode: selectedChannelWorkspace.mode,
      modeLabel: t(channelWorkspaceModeLabel(selectedChannelWorkspace.mode)),
      status: selectedChannelWorkspace.status,
      path: executionPath,
      shortPath: shortWorkspacePath(executionPath, cwd),
      errorMessage: selectedChannelWorkspace.errorMessage,
    } satisfies ChannelEnvironmentWorkspace : undefined;
    const loadedGitStatus = gitStatusState.status === "loaded" ? gitStatusState.statusValue : undefined;
    const changes = loadedGitStatus && (loadedGitStatus.state === "dirty" || loadedGitStatus.changedFileCount > 0)
      ? {
        changedFileCount: loadedGitStatus.changedFileCount,
        stagedFileCount: loadedGitStatus.stagedFileCount,
        unstagedFileCount: loadedGitStatus.unstagedFileCount,
        untrackedFileCount: loadedGitStatus.untrackedFileCount,
        conflictedFileCount: loadedGitStatus.conflictedFileCount,
        additions: loadedGitStatus.additions,
        deletions: loadedGitStatus.deletions,
        label: environmentChangesLabel(loadedGitStatus.changedFileCount, t),
      } satisfies ChannelEnvironmentGitChanges
      : undefined;
    const review = reviewItems.length > 0 ? {
      reviewItemCount: reviewItems.length,
      actionItemCount: reviewItems.length,
      label: environmentReviewLabel(reviewItems.length, t),
    } satisfies ChannelEnvironmentReviewSummary : undefined;
    const branchName = loadedGitStatus?.branchName?.trim() || selectedChannelWorkspace?.branchName?.trim();
    const git = branchName ? {
      branchName,
      baseBranch: loadedGitStatus?.upstream ?? selectedChannelWorkspace?.baseBranch,
    } satisfies ChannelEnvironmentGitStatus : undefined;
    const browserCount = evidenceGroups
      .filter((group) => group.id === "browser")
      .reduce((count, group) => count + group.items.length, 0);
    const browser = browserCount > 0 ? {
      count: browserCount,
      label: browserCount === 1 ? t("1 browser item") : t("{count} browser items", { count: browserCount }),
    } satisfies ChannelEnvironmentEvidenceSummary : undefined;
    const evidenceSourceCount = evidenceGroups
      .filter((group) => group.id === "source")
      .reduce((count, group) => count + group.items.length, 0);
    const sourceCount = activeSourceSummary?.sourceCount ?? evidenceSourceCount;
    const sources = sourceCount > 0 ? {
      count: sourceCount,
      label: activeSourceSummary
        ? conversationContextSourceSummaryLabel(activeSourceSummary, t)
        : sourceCount === 1 ? t("1 source") : t("{count} sources", { count: sourceCount }),
    } satisfies ChannelEnvironmentEvidenceSummary : undefined;
    const outputCount = fileItems.filter((item) =>
      item.kind === "artifact" ||
      item.kind === "change" ||
      item.status === "generated" ||
      item.status === "changed"
    ).length;
    const output = {
      count: outputCount,
      label: outputCount === 0 ? t("No artifacts") : outputCount === 1 ? t("1 artifact") : t("{count} artifacts", { count: outputCount }),
    } satisfies ChannelEnvironmentOutputSummary;
    const commitAction = changes ? {
      disabledReason: t("Commit and push require a daemon Git action and approval policy. This first version is read-only."),
    } : undefined;
    const changeDiffStats = changes && environmentChangesHaveDiffStats(changes)
      ? { additions: changes.additions ?? 0, deletions: changes.deletions ?? 0 }
      : undefined;
    const popoverRows: ChannelEnvironmentPopoverRow[] = [];
    if (changes) {
      popoverRows.push({
        id: "changes",
        icon: <ListChecks size={18} />,
        label: t("Changes"),
        value: changeDiffStats ? `+${changeDiffStats.additions} -${changeDiffStats.deletions}` : changes.label,
        stats: changeDiffStats,
        tone: changes.conflictedFileCount > 0 ? "blocked" : "neutral",
      });
    }
    if (review) {
      popoverRows.push({
        id: "review",
        icon: <ListChecks size={18} />,
        label: t("Review"),
        value: review.label,
        tone: "waiting",
        onOpen: onOpenReview,
      });
    }
    if (workspace) {
      popoverRows.push({
        id: "local",
        icon: channelWorkspaceModeIcon(workspace.mode, 18),
        label: t("Local environment"),
        value: workspace.shortPath || workspace.path || workspace.modeLabel,
        tone: workspace.status === "ready" ? "success" : workspace.status === "missing" || workspace.status === "blocked" ? "blocked" : "neutral",
        onOpen: onOpenEnvironment,
      });
    }
    if (git) {
      popoverRows.push({
        id: "git-branch",
        icon: <GitBranch size={18} />,
        label: t("Working branch"),
        value: git.branchName,
        tone: "info",
      });
    }
    if (commitAction) {
      popoverRows.push({
        id: "commit-push",
        icon: <SquareTerminal size={18} />,
        label: t("Commit or push"),
        value: t("Read-only shell"),
        tone: "neutral",
        onOpen: onOpenCommit,
        disabledReason: commitAction.disabledReason,
      });
    }
    return {
      workspace,
      gitStatusLoadState: gitStatusState,
      changes,
      review,
      git,
      browser,
      sources,
      output,
      commitAction,
      popoverRows,
    };
  }, [
    activeSourceSummary,
    cwd,
    evidenceGroups,
    executionPath,
    fileItems,
    gitStatusState,
    onOpenCommit,
    onOpenEnvironment,
    onOpenReview,
    reviewItems,
    selectedChannelWorkspace,
    t,
  ]);
}

export { ChannelEnvironmentPage };
export type { ChannelEnvironmentSummary, ChannelGitStatusLoadState };
