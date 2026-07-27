import { useEffect, useRef, useState } from "react";
import {
  createChannelWorktree,
  handoffChannelWorkspace,
  openChannelWorkspace,
  refreshChannelWorkspace,
} from "../../api/channels.js";
import type { Translate } from "../../i18n.js";
import { useLingToast } from "../../shared/ui/index.js";
import type { ChannelFormState, ChannelWorkspaceBinding, ChannelWorkspaceMode } from "../../types.js";

type ChannelWorkspaceBusyAction =
  | ""
  | "create-worktree"
  | "refresh"
  | "open"
  | `handoff-${ChannelWorkspaceMode}`;

interface ChannelWorkspaceFailure {
  readonly action: ChannelWorkspaceBusyAction;
  readonly message: string;
}

export function useChannelWorkspaceFeedback({
  cwd,
  selectedChannelId,
  selectedChannelExecutionPath,
  selectedChannelWorkspace,
  channelEditForm,
  onChannelEditFormChange,
  onRefreshChannels,
  t,
}: {
  readonly cwd: string;
  readonly selectedChannelId: string;
  readonly selectedChannelExecutionPath: string;
  readonly selectedChannelWorkspace: ChannelWorkspaceBinding | undefined;
  readonly channelEditForm: ChannelFormState;
  readonly onChannelEditFormChange: (form: ChannelFormState) => void;
  readonly onRefreshChannels: () => void;
  readonly t: Translate;
}) {
  const { showToast } = useLingToast();
  const [busyAction, setBusyAction] = useState<ChannelWorkspaceBusyAction>("");
  const [externalPath, setExternalPath] = useState("");
  const [failure, setFailure] = useState<ChannelWorkspaceFailure | undefined>();
  const requestRevisionRef = useRef(0);
  const busyActionRef = useRef<ChannelWorkspaceBusyAction>("");
  const selectedChannelIdRef = useRef(selectedChannelId);
  const channelEditFormRef = useRef(channelEditForm);
  selectedChannelIdRef.current = selectedChannelId;
  channelEditFormRef.current = channelEditForm;

  useEffect(() => {
    requestRevisionRef.current += 1;
    busyActionRef.current = "";
    setBusyAction("");
    setFailure(undefined);
    setExternalPath("");
  }, [selectedChannelId]);

  useEffect(() => {
    if (selectedChannelWorkspace?.mode === "external_path" && selectedChannelWorkspace.executionPath) {
      setExternalPath(selectedChannelWorkspace.executionPath);
    }
  }, [selectedChannelId, selectedChannelWorkspace?.executionPath, selectedChannelWorkspace?.mode]);

  function onExternalPathChange(value: string): void {
    setExternalPath(value);
    setFailure((current) => current?.action === "handoff-external_path" ? undefined : current);
  }

  async function runBindingAction(
    action: ChannelWorkspaceBusyAction,
    operation: (workspaceCwd: string, channelId: string) => Promise<{ readonly binding: ChannelWorkspaceBinding }>,
    successMessage: string,
    syncBinding = true,
  ): Promise<void> {
    const workspaceCwd = cwd.trim();
    const channelId = selectedChannelId.trim();
    if (!workspaceCwd || !channelId || busyActionRef.current) {
      return;
    }

    const requestRevision = ++requestRevisionRef.current;
    busyActionRef.current = action;
    setBusyAction(action);
    setFailure(undefined);
    try {
      const response = await operation(workspaceCwd, channelId);
      if (requestRevisionRef.current !== requestRevision || selectedChannelIdRef.current !== channelId) {
        return;
      }
      if (syncBinding) {
        onChannelEditFormChange({ ...channelEditFormRef.current, workspaceBinding: response.binding });
      }
      showToast({
        message: successMessage,
        scope: `channel:${channelId}:workspace-binding`,
        tone: "success",
        durationMs: 3_000,
      });
      if (syncBinding) {
        onRefreshChannels();
      }
    } catch (caught: unknown) {
      if (requestRevisionRef.current === requestRevision && selectedChannelIdRef.current === channelId) {
        setFailure({
          action,
          message: caught instanceof Error ? caught.message : String(caught),
        });
      }
    } finally {
      if (requestRevisionRef.current === requestRevision && selectedChannelIdRef.current === channelId) {
        busyActionRef.current = "";
        setBusyAction("");
      }
    }
  }

  function createManagedWorktree(): void {
    void runBindingAction(
      "create-worktree",
      (workspaceCwd, channelId) => createChannelWorktree(workspaceCwd, channelId),
      t("Managed worktree is ready."),
    );
  }

  function refreshWorkspace(): void {
    void runBindingAction(
      "refresh",
      (workspaceCwd, channelId) => refreshChannelWorkspace(workspaceCwd, channelId),
      t("Workspace status refreshed."),
    );
  }

  function handoffWorkspace(mode: ChannelWorkspaceMode): void {
    const executionPath = mode === "external_path" ? externalPath.trim() : undefined;
    if (mode === "external_path" && !executionPath) {
      setFailure({ action: "handoff-external_path", message: t("Enter an external workspace path.") });
      return;
    }
    void runBindingAction(
      `handoff-${mode}`,
      (workspaceCwd, channelId) => handoffChannelWorkspace(workspaceCwd, channelId, { mode, executionPath }),
      mode === "local"
        ? t("Channel handed off to Local.")
        : mode === "managed_worktree"
          ? t("Channel handed off to Worktree.")
          : t("Channel handed off to External path."),
    );
  }

  function openWorkspacePath(): void {
    if (!selectedChannelExecutionPath.trim()) {
      return;
    }
    void runBindingAction(
      "open",
      (workspaceCwd, channelId) => openChannelWorkspace(workspaceCwd, channelId),
      t("Opened"),
      false,
    );
  }

  return {
    busyAction,
    error: failure?.message ?? "",
    externalPath,
    onExternalPathChange,
    createManagedWorktree,
    refreshWorkspace,
    openWorkspacePath,
    handoffWorkspace,
  } as const;
}
