import { useEffect, useState } from "react";
import type { Channel, ChannelWorkspaceBinding } from "../../types.js";
import { getChannelWorkspaceGitStatus } from "../../api/channels.js";
import type { ChannelGitStatusLoadState } from "./ChannelEnvironmentSummary.js";

export function useChannelWorkspaceEnvironment(input: {
  readonly cwd: string;
  readonly selectedChannel?: Channel;
  readonly environmentOpen: boolean;
  readonly summaryOpen: boolean;
}) {
  const { cwd, selectedChannel, environmentOpen: channelEnvironmentPageOpen, summaryOpen: progressPopoverOpen } = input;
  const selectedChannelId = selectedChannel?.id;
  const selectedChannelWorkspace = selectedChannel ? resolveChannelWorkspaceBinding(selectedChannel, cwd) : undefined;
  const selectedChannelExecutionPath = selectedChannel && selectedChannelWorkspace ? resolveChannelWorkspaceExecutionPath(selectedChannelWorkspace, selectedChannel, cwd) : "";
  const [channelGitStatusState, setChannelGitStatusState] = useState<ChannelGitStatusLoadState>({ status: "idle" });
  useEffect(() => {
    const channelId = selectedChannelId ?? "";
    const executionPath = selectedChannelExecutionPath.trim();
    if (!channelId || !executionPath || selectedChannelWorkspace?.status !== "ready") {
      setChannelGitStatusState({ status: "idle" });
      return;
    }

    let cancelled = false;
    const requestKey = `${channelId}:${executionPath}`;
    setChannelGitStatusState({ status: "loading", requestKey });
    getChannelWorkspaceGitStatus(cwd, channelId)
      .then((response) => {
        if (cancelled) {
          return;
        }
        setChannelGitStatusState({
          status: "loaded",
          requestKey,
          statusValue: response.gitStatus,
        });
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        setChannelGitStatusState({
          status: "error",
          requestKey,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      });

    return () => {
      cancelled = true;
    };
  }, [
    channelEnvironmentPageOpen,
    cwd,
    progressPopoverOpen,
    selectedChannelExecutionPath,
    selectedChannelId,
    selectedChannelWorkspace?.status,
    selectedChannelWorkspace?.updatedAt,
  ]);
  return { selectedChannelWorkspace, selectedChannelExecutionPath, channelGitStatusState };
}

function resolveChannelWorkspaceBinding(channel: Channel, cwd: string): ChannelWorkspaceBinding {
  return channel.workspaceBinding ?? {
    mode: "local",
    status: "ready",
    executionPath: channel.boundPath || cwd,
    updatedAt: channel.updatedAt,
  };
}

function resolveChannelWorkspaceExecutionPath(binding: ChannelWorkspaceBinding, channel: Channel, cwd: string): string {
  if (binding.mode === "managed_worktree" && binding.worktreePath) {
    return binding.worktreePath;
  }
  if (binding.mode === "external_path" && binding.executionPath) {
    return binding.executionPath;
  }
  return binding.executionPath || channel.boundPath || cwd;
}
