import { useCallback, useEffect, useMemo, useState } from "react";
import {
  deleteChannel,
  deleteChannelBranch,
  listChannelBranches,
  listChannels,
  patchChannel,
  updateChannelBranch,
} from "../../api/channels.js";
import type { Channel, ChannelBranch } from "../../types.js";

export interface ArchivedSettingsControllerState {
  readonly archivedChannels: readonly Channel[];
  readonly archiveParentChannels: readonly Channel[];
  readonly archiveParentChannelById: ReadonlyMap<string, Channel>;
  readonly archivedBranches: readonly ChannelBranch[];
  readonly isLoading: boolean;
  readonly errorMessage: string;
  readonly actionId: string;
}

export interface ArchivedSettingsControllerActions {
  readonly refresh: () => Promise<void>;
  readonly restoreChannel: (channelId: string) => Promise<void>;
  readonly deleteChannel: (channel: Channel) => Promise<void>;
  readonly restoreBranch: (branch: ChannelBranch) => Promise<void>;
  readonly deleteBranch: (branch: ChannelBranch) => Promise<void>;
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
  const [archivedChannels, setArchivedChannels] = useState<readonly Channel[]>([]);
  const [archiveParentChannels, setArchiveParentChannels] = useState<readonly Channel[]>([]);
  const [archivedBranches, setArchivedBranches] = useState<readonly ChannelBranch[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [actionId, setActionId] = useState("");

  const refresh = useCallback(async () => {
    if (!cwd.trim()) {
      setArchivedChannels([]);
      setArchiveParentChannels([]);
      setArchivedBranches([]);
      return;
    }
    setIsLoading(true);
    setErrorMessage("");
    try {
      const [activeChannelsResponse, archivedChannelsResponse] = await Promise.all([
        listChannels(cwd, { archived: false, limit: 500 }),
        listChannels(cwd, { archived: true, limit: 500 }),
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
    } catch (caught) {
      setErrorMessage(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setIsLoading(false);
    }
  }, [cwd]);

  useEffect(() => {
    if (enabled) {
      void refresh();
    }
  }, [enabled, refresh]);

  const archiveParentChannelById = useMemo(
    () => new Map(archiveParentChannels.map((channel) => [channel.id, channel])),
    [archiveParentChannels],
  );

  const runAction = useCallback(async (nextActionId: string, action: () => Promise<void>) => {
    setActionId(nextActionId);
    setErrorMessage("");
    try {
      await action();
    } catch (caught) {
      setErrorMessage(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setActionId("");
    }
  }, []);

  const restoreChannel = useCallback(async (channelId: string) => {
    await runAction(`channel:${channelId}:restore`, async () => {
      await patchChannel(cwd, channelId, { status: "active" });
      await refresh();
      await onChanged?.();
    });
  }, [cwd, onChanged, refresh, runAction]);

  const removeChannel = useCallback(async (channel: Channel) => {
    await runAction(`channel:${channel.id}:delete`, async () => {
      await deleteChannel(cwd, channel.id);
      await refresh();
      await onChanged?.();
    });
  }, [cwd, onChanged, refresh, runAction]);

  const restoreBranch = useCallback(async (branch: ChannelBranch) => {
    const parent = archiveParentChannelById.get(branch.channelId);
    await runAction(`branch:${branch.id}:restore`, async () => {
      if (parent?.status === "archived") {
        await patchChannel(cwd, branch.channelId, { status: "active" });
      }
      await updateChannelBranch(cwd, branch.channelId, branch.id, { status: "active" });
      await refresh();
      await onChanged?.();
    });
  }, [archiveParentChannelById, cwd, onChanged, refresh, runAction]);

  const removeBranch = useCallback(async (branch: ChannelBranch) => {
    await runAction(`branch:${branch.id}:delete`, async () => {
      await deleteChannelBranch(cwd, branch.channelId, branch.id);
      await refresh();
      await onChanged?.();
    });
  }, [cwd, onChanged, refresh, runAction]);

  return {
    state: {
      archivedChannels,
      archiveParentChannels,
      archiveParentChannelById,
      archivedBranches,
      isLoading,
      errorMessage,
      actionId,
    },
    actions: {
      refresh,
      restoreChannel,
      deleteChannel: removeChannel,
      restoreBranch,
      deleteBranch: removeBranch,
    },
  };
}
