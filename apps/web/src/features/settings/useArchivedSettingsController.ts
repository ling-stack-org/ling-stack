import { useCallback, useEffect, useMemo, useState } from "react";
import {
  deleteChannel,
  deleteChannelBranch,
  listChannelBranches,
  listChannels,
  patchChannel,
  updateChannelBranch,
} from "../../api/channels.js";
import {
  hardDeleteAiTeammate,
  hardDeleteLingThread,
  listAiTeammates,
  listLingThreads,
  unarchiveLingThread,
  updateAiTeammate,
} from "../../api.js";
import { useI18n, type Translate } from "../../i18n.js";
import type { AiTeammate, Channel, ChannelBranch, LingThread } from "../../types.js";

export interface ArchivedSettingsFeedback {
  readonly message: string;
  readonly details?: string;
}

export interface ArchivedSettingsActionError extends ArchivedSettingsFeedback {
  readonly actionId: string;
}

export interface ArchivedSettingsControllerState {
  readonly archivedChannels: readonly Channel[];
  readonly archiveParentChannels: readonly Channel[];
  readonly archiveParentChannelById: ReadonlyMap<string, Channel>;
  readonly archivedBranches: readonly ChannelBranch[];
  readonly archivedConversations: readonly LingThread[];
  readonly archivedTeammates: readonly AiTeammate[];
  readonly isLoading: boolean;
  readonly loadError?: ArchivedSettingsFeedback;
  readonly actionError?: ArchivedSettingsActionError;
  readonly actionId: string;
}

export interface ArchivedSettingsControllerActions {
  readonly refresh: () => Promise<boolean>;
  readonly clearActionError: () => void;
  readonly restoreChannel: (channelId: string) => Promise<boolean>;
  readonly deleteChannel: (channel: Channel) => Promise<boolean>;
  readonly restoreBranch: (branch: ChannelBranch) => Promise<boolean>;
  readonly deleteBranch: (branch: ChannelBranch) => Promise<boolean>;
  readonly restoreConversation: (threadId: string) => Promise<boolean>;
  readonly deleteConversation: (thread: LingThread) => Promise<boolean>;
  readonly restoreTeammate: (teammateId: string) => Promise<boolean>;
  readonly deleteTeammate: (teammate: AiTeammate) => Promise<boolean>;
}

export function useArchivedSettingsController({
  cwd,
  enabled,
  onChanged,
}: {
  readonly cwd: string;
  readonly enabled: boolean;
  readonly onChanged?: () => void | Promise<void>;
}): {
  readonly state: ArchivedSettingsControllerState;
  readonly actions: ArchivedSettingsControllerActions;
} {
  const { t } = useI18n();
  const [archivedChannels, setArchivedChannels] = useState<readonly Channel[]>([]);
  const [archiveParentChannels, setArchiveParentChannels] = useState<readonly Channel[]>([]);
  const [archivedBranches, setArchivedBranches] = useState<readonly ChannelBranch[]>([]);
  const [archivedConversations, setArchivedConversations] = useState<readonly LingThread[]>([]);
  const [archivedTeammates, setArchivedTeammates] = useState<readonly AiTeammate[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<ArchivedSettingsFeedback>();
  const [actionError, setActionError] = useState<ArchivedSettingsActionError>();
  const [actionId, setActionId] = useState("");

  const refresh = useCallback(async (): Promise<boolean> => {
    if (!cwd.trim()) {
      setArchivedChannels([]);
      setArchiveParentChannels([]);
      setArchivedBranches([]);
      setArchivedConversations([]);
      setArchivedTeammates([]);
      setLoadError(undefined);
      return true;
    }
    setIsLoading(true);
    setLoadError(undefined);
    try {
      const [activeChannelsResponse, archivedChannelsResponse, archivedConversationResponse, teammateResponse] = await Promise.all([
        listChannels(cwd, { archived: false, limit: 500 }),
        listChannels(cwd, { archived: true, limit: 500 }),
        listLingThreads(cwd, { kind: "conversation", archived: "only", limit: 500 }),
        listAiTeammates(cwd),
      ]);
      const parentChannels = [...activeChannelsResponse.channels, ...archivedChannelsResponse.channels];
      const branchResponses = await Promise.all(
        parentChannels.map((channel) =>
          listChannelBranches(cwd, channel.id, { archived: true, limit: 500 })
            .catch(() => ({ cwd, channelId: channel.id, branches: [] as ChannelBranch[] })),
        ),
      );
      setArchivedChannels(archivedChannelsResponse.channels);
      setArchiveParentChannels(parentChannels);
      setArchivedBranches(branchResponses.flatMap((response) => response.branches));
      setArchivedConversations([...archivedConversationResponse.threads].sort(sortByUpdatedAtDesc));
      setArchivedTeammates(
        teammateResponse.teammates
          .filter((teammate) => teammate.hidden && teammate.status !== "disabled")
          .sort(sortByUpdatedAtDesc),
      );
      return true;
    } catch (caught) {
      setLoadError(createLoadFeedback(caught, t));
      return false;
    } finally {
      setIsLoading(false);
    }
  }, [cwd, t]);

  useEffect(() => {
    if (enabled) {
      void refresh();
    }
  }, [enabled, refresh]);

  const archiveParentChannelById = useMemo(
    () => new Map(archiveParentChannels.map((channel) => [channel.id, channel])),
    [archiveParentChannels],
  );

  const clearActionError = useCallback(() => {
    setActionError(undefined);
  }, []);

  const runAction = useCallback(async (
    nextActionId: string,
    actionKind: "restore" | "delete",
    action: () => Promise<void>,
  ): Promise<boolean> => {
    setActionId(nextActionId);
    setActionError(undefined);
    try {
      await action();
      return true;
    } catch (caught) {
      setActionError({ actionId: nextActionId, ...createActionFeedback(caught, actionKind, t) });
      return false;
    } finally {
      setActionId("");
    }
  }, [t]);

  const finishMutation = useCallback(async (): Promise<void> => {
    const refreshed = await refresh();
    await onChanged?.();
    if (!refreshed) {
      throw new Error(t("The archived item changed, but the list could not be refreshed. Reopen Settings and try again."));
    }
  }, [onChanged, refresh, t]);

  const restoreChannel = useCallback(async (channelId: string) => {
    return await runAction(`channel:${channelId}:restore`, "restore", async () => {
      await patchChannel(cwd, channelId, { status: "active" });
      await finishMutation();
    });
  }, [cwd, finishMutation, runAction]);

  const removeChannel = useCallback(async (channel: Channel) => {
    return await runAction(`channel:${channel.id}:delete`, "delete", async () => {
      await deleteChannel(cwd, channel.id);
      await finishMutation();
    });
  }, [cwd, finishMutation, runAction]);

  const restoreBranch = useCallback(async (branch: ChannelBranch) => {
    const parent = archiveParentChannelById.get(branch.channelId);
    return await runAction(`branch:${branch.id}:restore`, "restore", async () => {
      if (parent?.status === "archived") {
        await patchChannel(cwd, branch.channelId, { status: "active" });
      }
      await updateChannelBranch(cwd, branch.channelId, branch.id, { status: "active" });
      await finishMutation();
    });
  }, [archiveParentChannelById, cwd, finishMutation, runAction]);

  const removeBranch = useCallback(async (branch: ChannelBranch) => {
    return await runAction(`branch:${branch.id}:delete`, "delete", async () => {
      await deleteChannelBranch(cwd, branch.channelId, branch.id);
      await finishMutation();
    });
  }, [cwd, finishMutation, runAction]);

  const restoreConversation = useCallback(async (threadId: string) => {
    return await runAction(`conversation:${threadId}:restore`, "restore", async () => {
      await unarchiveLingThread(cwd, threadId, {
        idempotencyKey: `settings-conversation-restore:${threadId}`,
      });
      await finishMutation();
    });
  }, [cwd, finishMutation, runAction]);

  const removeConversation = useCallback(async (thread: LingThread) => {
    return await runAction(`conversation:${thread.id}:delete`, "delete", async () => {
      await hardDeleteLingThread(cwd, thread.id, "settings_archived_items_delete");
      await finishMutation();
    });
  }, [cwd, finishMutation, runAction]);

  const restoreTeammate = useCallback(async (teammateId: string) => {
    return await runAction(`teammate:${teammateId}:restore`, "restore", async () => {
      await updateAiTeammate(cwd, teammateId, { hidden: false });
      await finishMutation();
    });
  }, [cwd, finishMutation, runAction]);

  const removeTeammate = useCallback(async (teammate: AiTeammate) => {
    return await runAction(`teammate:${teammate.id}:delete`, "delete", async () => {
      await hardDeleteAiTeammate(cwd, teammate.id, "settings_archived_items_delete");
      await finishMutation();
    });
  }, [cwd, finishMutation, runAction]);

  return {
    state: {
      archivedChannels,
      archiveParentChannels,
      archiveParentChannelById,
      archivedBranches,
      archivedConversations,
      archivedTeammates,
      isLoading,
      loadError,
      actionError,
      actionId,
    },
    actions: {
      refresh,
      clearActionError,
      restoreChannel,
      deleteChannel: removeChannel,
      restoreBranch,
      deleteBranch: removeBranch,
      restoreConversation,
      deleteConversation: removeConversation,
      restoreTeammate,
      deleteTeammate: removeTeammate,
    },
  };
}

function createLoadFeedback(caught: unknown, t: Translate): ArchivedSettingsFeedback {
  return {
    message: t("Archived items could not be loaded. Review details and try again."),
    details: errorMessage(caught),
  };
}

function createActionFeedback(
  caught: unknown,
  actionKind: "restore" | "delete",
  t: Translate,
): ArchivedSettingsFeedback {
  const message = errorMessage(caught);
  if (message.includes("targeted by automation")) {
    return { message: t("This conversation is still used by an automation. Update the automation before deleting it.") };
  }
  if (message.includes("active work") || message.includes("active turn")) {
    return { message: t("This conversation still has active work and cannot be deleted.") };
  }
  if (message.includes("must be archived") || message.includes("Only conversation threads")) {
    return { message: t("Only archived conversations can be deleted.") };
  }
  if (message.includes("Ling Agent cannot be deleted")) {
    return { message: t("Ling Agent cannot be deleted.") };
  }
  if (message === t("The archived item changed, but the list could not be refreshed. Reopen Settings and try again.")) {
    return { message };
  }
  return {
    message: actionKind === "delete"
      ? t("The archived item could not be deleted. Review details and try again.")
      : t("The archived item could not be restored. Review details and try again."),
    details: message,
  };
}

function errorMessage(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

function sortByUpdatedAtDesc<T extends { readonly updatedAt: string }>(left: T, right: T): number {
  return right.updatedAt.localeCompare(left.updatedAt);
}
