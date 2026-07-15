import { CircleAlert, Command, FolderOpen, GitBranch, Loader2, LockKeyhole, RefreshCw } from "lucide-react";
import { useI18n } from "../../i18n.js";
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
  channelWorkspaceNotice,
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
  readonly channelWorkspaceNotice: string;
  readonly channelWorkspaceError: string;
  readonly onChannelWorkspaceExternalPathChange: (value: string) => void;
  readonly onCreateManagedChannelWorktree: () => void;
  readonly onRefreshChannelWorkspace: () => void;
  readonly onOpenChannelWorkspacePath: () => void;
  readonly onHandoffChannelWorkspace: (mode: ChannelWorkspaceMode) => void;
}): JSX.Element {
  const { t } = useI18n();

  return (
    <section className="channel-settings-surface channel-workspace-settings" aria-label={t("Channel workspace settings")}>
      <div className="channel-settings-surface-heading">
        <strong>{t("Workspace")}</strong>
      </div>

      <div className="channel-settings-row-list">
        <div className="channel-settings-row channel-settings-control-row">
          <span className="channel-settings-row-icon" aria-hidden="true"><FolderOpen size={18} /></span>
          <ChannelExecutionPathField
            value={channelEditForm.boundPath}
            pickerCwd={cwd}
            disabled={!selectedChannelId || Boolean(channelWorkspaceBusyAction)}
            forceApply={Boolean(selectedChannelWorkspace && selectedChannelWorkspace.mode !== "local")}
            onApply={onChangeChannelWorkspacePath}
          />
        </div>

        <div className="channel-settings-row channel-settings-control-row">
          <span className="channel-settings-row-icon" aria-hidden="true"><LockKeyhole size={18} /></span>
          <ChannelWriteLockField form={channelEditForm} onChange={onChannelEditFormChange} />
        </div>
      </div>

      {selectedChannelWorkspace ? (
        <section className="channel-workspace-control" aria-label={t("Channel workspace")}>
          <div className="channel-workspace-control-head">
            <span>
              {channelWorkspaceModeIcon(selectedChannelWorkspace.mode, 15)}
              <strong>{t("Current workspace")}</strong>
            </span>
          </div>
          <div className="channel-workspace-summary">
            <strong>{t(channelWorkspaceModeLabel(selectedChannelWorkspace.mode))}</strong>
            <small title={selectedChannelExecutionPath}>{shortWorkspacePath(selectedChannelExecutionPath, cwd)}</small>
            {selectedChannelWorkspace.errorMessage ? <small className="danger-text">{selectedChannelWorkspace.errorMessage}</small> : null}
          </div>
          <div className="channel-workspace-actions">
            <button className="secondary-button compact-button" type="button" onClick={onCreateManagedChannelWorktree} disabled={!selectedChannelId || Boolean(channelWorkspaceBusyAction)}>
              {channelWorkspaceBusyAction === "create-worktree" ? <Loader2 className="spin" size={14} /> : <GitBranch size={14} />}
              {t("Create worktree")}
            </button>
            <button className="secondary-button compact-button" type="button" onClick={onRefreshChannelWorkspace} disabled={!selectedChannelId || Boolean(channelWorkspaceBusyAction)}>
              {channelWorkspaceBusyAction === "refresh" ? <Loader2 className="spin" size={14} /> : <RefreshCw size={14} />}
              {t("Refresh status")}
            </button>
            <button className="secondary-button compact-button" type="button" onClick={onOpenChannelWorkspacePath} disabled={!selectedChannelExecutionPath || Boolean(channelWorkspaceBusyAction)}>
              {channelWorkspaceBusyAction === "open" ? <Loader2 className="spin" size={14} /> : <FolderOpen size={14} />}
              {t("Open path")}
            </button>
          </div>
          <div className="channel-workspace-actions">
            <button className="secondary-button compact-button" type="button" onClick={() => onHandoffChannelWorkspace("local")} disabled={!selectedChannelId || Boolean(channelWorkspaceBusyAction) || selectedChannelWorkspace.mode === "local"}>
              {channelWorkspaceBusyAction === "handoff-local" ? <Loader2 className="spin" size={14} /> : <Command size={14} />}
              {t("Hand off to Local")}
            </button>
            <button className="secondary-button compact-button" type="button" onClick={() => onHandoffChannelWorkspace("managed_worktree")} disabled={!selectedChannelId || Boolean(channelWorkspaceBusyAction) || !selectedChannelWorkspace.worktreePath}>
              {channelWorkspaceBusyAction === "handoff-managed_worktree" ? <Loader2 className="spin" size={14} /> : <GitBranch size={14} />}
              {t("Hand off to Worktree")}
            </button>
          </div>
          <div className="channel-workspace-external-row">
            <input
              value={channelWorkspaceExternalPath}
              onChange={(event) => onChannelWorkspaceExternalPathChange(event.target.value)}
              placeholder={t("External workspace path")}
              disabled={!selectedChannelId || Boolean(channelWorkspaceBusyAction)}
            />
            <button className="secondary-button compact-button" type="button" onClick={() => onHandoffChannelWorkspace("external_path")} disabled={!selectedChannelId || Boolean(channelWorkspaceBusyAction) || !channelWorkspaceExternalPath.trim()}>
              {channelWorkspaceBusyAction === "handoff-external_path" ? <Loader2 className="spin" size={14} /> : <FolderOpen size={14} />}
              {t("Hand off to External")}
            </button>
          </div>
          {channelWorkspaceNotice ? <div className="inline-success compact">{channelWorkspaceNotice}</div> : null}
          {channelWorkspaceError ? (
            <div className="inline-error compact">
              <CircleAlert size={14} />
              {channelWorkspaceError}
            </div>
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

export function channelWorkspaceModeIcon(mode: ChannelWorkspaceMode, size: number): JSX.Element {
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
    return ".";
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
