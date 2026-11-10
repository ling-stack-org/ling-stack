import { Command, FolderOpen, GitBranch, LockKeyhole, RefreshCw } from "lucide-react";
import { useI18n } from "../../i18n.js";
import {
  Button,
  DataRow,
  Field,
  InlineFeedback,
  Input,
} from "../../shared/ui/index.js";
import type { ChannelFormState, ChannelWorkspaceBinding, ChannelWorkspaceMode } from "../../types.js";
import { ChannelExecutionPathField } from "./ChannelExecutionPathField.js";
import { ChannelWriteLockField } from "./WorkspaceControls.js";

export function ChannelSettingsWorkspacePanel({
  cwd,
  selectedChannelId,
  channelEditForm,
  onChannelEditFormChange,
  onChangeChannelWorkspacePath,
  selectedChannelWorkspace,
  selectedChannelExecutionPath,
  channelWorkspaceBusyAction,
  channelWorkspaceExternalPath,
  channelWorkspaceError,
  onChannelWorkspaceExternalPathChange,
  onCreateManagedChannelWorktree,
  onRefreshChannelWorkspace,
  onOpenChannelWorkspacePath,
  onHandoffChannelWorkspace,
}: {
  readonly cwd: string;
  readonly selectedChannelId: string;
  readonly channelEditForm: ChannelFormState;
  readonly onChannelEditFormChange: (form: ChannelFormState) => void;
  readonly onChangeChannelWorkspacePath: (path: string) => Promise<void>;
  readonly selectedChannelWorkspace: ChannelWorkspaceBinding | undefined;
  readonly selectedChannelExecutionPath: string;
  readonly channelWorkspaceBusyAction: string;
  readonly channelWorkspaceExternalPath: string;
  readonly channelWorkspaceError: string;
  readonly onChannelWorkspaceExternalPathChange: (value: string) => void;
  readonly onCreateManagedChannelWorktree: () => void;
  readonly onRefreshChannelWorkspace: () => void;
  readonly onOpenChannelWorkspacePath: () => void;
  readonly onHandoffChannelWorkspace: (mode: ChannelWorkspaceMode) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const workspaceShortPath = selectedChannelWorkspace
    ? shortWorkspacePath(selectedChannelExecutionPath, cwd)
    : "";

  return (
    <section className="channel-settings-surface channel-workspace-settings" aria-label={t("Channel workspace settings")}>
      <div className="channel-settings-surface-heading">
        <strong>{t("Workspace")}</strong>
      </div>

      <div className="channel-settings-row-list">
        <DataRow
          className="channel-settings-row channel-settings-control-row"
          identity={<span className="channel-settings-row-icon" aria-hidden="true"><FolderOpen size={18} /></span>}
          summary={(
            <ChannelExecutionPathField
              value={channelEditForm.boundPath}
              pickerCwd={cwd}
              disabled={!selectedChannelId || Boolean(channelWorkspaceBusyAction)}
              forceApply={Boolean(selectedChannelWorkspace && selectedChannelWorkspace.mode !== "local")}
              onApply={onChangeChannelWorkspacePath}
            />
          )}
        />

        <DataRow
          className="channel-settings-row channel-settings-control-row"
          identity={<span className="channel-settings-row-icon" aria-hidden="true"><LockKeyhole size={18} /></span>}
          summary={<ChannelWriteLockField form={channelEditForm} onChange={onChannelEditFormChange} />}
        />
      </div>

      {selectedChannelWorkspace ? (
        <section className="channel-workspace-control" aria-label={t("Channel workspace")}>
          <div className="channel-workspace-control-head">
            <span>
              {channelWorkspaceModeIcon(selectedChannelWorkspace.mode, 15)}
              <strong>{t("Current workspace")}</strong>
            </span>
            <span className="channel-workspace-mode-label">
              {t(channelWorkspaceModeLabel(selectedChannelWorkspace.mode))}
            </span>
          </div>
          {workspaceShortPath || selectedChannelWorkspace.errorMessage ? (
            <div className="channel-workspace-summary">
              {workspaceShortPath ? <small title={selectedChannelExecutionPath}>{workspaceShortPath}</small> : null}
              {selectedChannelWorkspace.errorMessage ? <small className="danger-text">{selectedChannelWorkspace.errorMessage}</small> : null}
            </div>
          ) : null}
          <div className="channel-workspace-actions">
            <Button
              leadingIcon={<GitBranch size={14} />}
              loading={channelWorkspaceBusyAction === "create-worktree"}
              loadingLabel={t("Create worktree")}
              size="sm"
              onClick={onCreateManagedChannelWorktree}
              disabled={!selectedChannelId || Boolean(channelWorkspaceBusyAction)}
            >
              {t("Create worktree")}
            </Button>
            <Button
              leadingIcon={<RefreshCw size={14} />}
              loading={channelWorkspaceBusyAction === "refresh"}
              loadingLabel={t("Check status")}
              size="sm"
              onClick={onRefreshChannelWorkspace}
              disabled={!selectedChannelId || Boolean(channelWorkspaceBusyAction)}
            >
              {t("Check status")}
            </Button>
            <Button
              leadingIcon={<FolderOpen size={14} />}
              loading={channelWorkspaceBusyAction === "open"}
              loadingLabel={t("Open path")}
              size="sm"
              onClick={onOpenChannelWorkspacePath}
              disabled={!selectedChannelExecutionPath || Boolean(channelWorkspaceBusyAction)}
            >
              {t("Open path")}
            </Button>
          </div>
          <div className="channel-workspace-actions">
            <Button
              leadingIcon={<Command size={14} />}
              loading={channelWorkspaceBusyAction === "handoff-local"}
              loadingLabel={t("Hand off to Local")}
              size="sm"
              onClick={() => onHandoffChannelWorkspace("local")}
              disabled={!selectedChannelId || Boolean(channelWorkspaceBusyAction) || selectedChannelWorkspace.mode === "local"}
            >
              {t("Hand off to Local")}
            </Button>
            <Button
              leadingIcon={<GitBranch size={14} />}
              loading={channelWorkspaceBusyAction === "handoff-managed_worktree"}
              loadingLabel={t("Hand off to Worktree")}
              size="sm"
              onClick={() => onHandoffChannelWorkspace("managed_worktree")}
              disabled={!selectedChannelId || Boolean(channelWorkspaceBusyAction) || !selectedChannelWorkspace.worktreePath}
            >
              {t("Hand off to Worktree")}
            </Button>
          </div>
          <div className="channel-workspace-external-row">
            <Field label={t("External workspace path")}>
              <Input
                aria-label={t("External workspace path")}
                value={channelWorkspaceExternalPath}
                onChange={(event) => onChannelWorkspaceExternalPathChange(event.target.value)}
                placeholder={t("External workspace path")}
                disabled={!selectedChannelId || Boolean(channelWorkspaceBusyAction)}
              />
            </Field>
            <Button
              leadingIcon={<FolderOpen size={14} />}
              loading={channelWorkspaceBusyAction === "handoff-external_path"}
              loadingLabel={t("Hand off to External")}
              size="sm"
              onClick={() => onHandoffChannelWorkspace("external_path")}
              disabled={!selectedChannelId || Boolean(channelWorkspaceBusyAction) || !channelWorkspaceExternalPath.trim()}
            >
              {t("Hand off to External")}
            </Button>
          </div>
          {channelWorkspaceError ? (
            <InlineFeedback tone="danger">{channelWorkspaceError}</InlineFeedback>
          ) : null}
        </section>
      ) : null}
    </section>
  );
}

export function channelWorkspaceModeLabel(mode: ChannelWorkspaceMode): string {
  if (mode === "managed_worktree") {
    return "Worktree";
  }
  if (mode === "external_path") {
    return "External";
  }
  return "Local";
}

export function channelWorkspaceModeIcon(mode: ChannelWorkspaceMode, size: number): React.JSX.Element {
  if (mode === "managed_worktree") {
    return <GitBranch size={size} />;
  }
  if (mode === "external_path") {
    return <FolderOpen size={size} />;
  }
  return <Command size={size} />;
}

export function shortWorkspacePath(path: string, cwd: string): string {
  const trimmed = path.trim();
  if (!trimmed) {
    return "";
  }
  const workspace = cwd.trim().replace(/\/$/, "");
  if (workspace && trimmed === workspace) {
    return "";
  }
  if (workspace && trimmed.startsWith(`${workspace}/`)) {
    return `.${trimmed.slice(workspace.length)}`;
  }
  const parts = trimmed.split("/").filter(Boolean);
  if (parts.length <= 3) {
    return trimmed;
  }
  return `.../${parts.slice(-3).join("/")}`;
}
