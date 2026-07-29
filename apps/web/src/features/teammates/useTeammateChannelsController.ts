import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listChannels, listTeammateChannels, replaceTeammateChannels } from "../../api.js";
import { useI18n } from "../../i18n.js";
import { deriveEffectiveTeammateChannelMemberships } from "../../lib/channel-teammates.js";
import { useLingToast } from "../../shared/ui/index.js";
import type { AiTeammate, Channel, TeammateChannelMembership } from "../../types.js";
import {
  buildTeammateChannelRows,
  deriveTeammateChannelMutationPayload,
  filterTeammateChannelRows,
  mergeTeammateChannelCatalog,
  summarizeTeammateChannels,
  type TeammateChannelAction,
  type TeammateChannelFilter,
} from "./teammate-channels-view-models.js";

type MaybePromise<T> = T | Promise<T>;

export function useTeammateChannelsController({
  channels,
  cwd,
  protectedTeammate,
  teammate,
  onRefreshChannels,
}: {
  readonly channels: readonly Channel[];
  readonly cwd: string;
  readonly protectedTeammate: boolean;
  readonly teammate: AiTeammate;
  readonly onRefreshChannels?: () => MaybePromise<void>;
}) {
  const { t } = useI18n();
  const { dismissToast, showToast } = useLingToast();
  const identityKey = `${cwd.trim()}::${teammate.id}`;
  const identityRef = useRef(identityKey);
  const loadSequenceRef = useRef(0);
  const membershipsRef = useRef<readonly TeammateChannelMembership[]>([]);
  const hasSnapshotRef = useRef(false);
  const busyActionsRef = useRef<Readonly<Record<string, TeammateChannelAction>>>({});
  const mutationQueueRef = useRef<Promise<void>>(Promise.resolve());
  const feedbackToastIdRef = useRef("");
  identityRef.current = identityKey;

  const [memberships, setMemberships] = useState<readonly TeammateChannelMembership[]>([]);
  const [archivedChannels, setArchivedChannels] = useState<readonly Channel[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [stale, setStale] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [filter, setFilter] = useState<TeammateChannelFilter>("all");
  const [busyActions, setBusyActions] = useState<Readonly<Record<string, TeammateChannelAction>>>({});
  const [rowErrors, setRowErrors] = useState<Readonly<Record<string, string>>>({});

  const catalogChannels = useMemo(
    () => mergeTeammateChannelCatalog(channels, archivedChannels),
    [archivedChannels, channels],
  );
  const effectiveMemberships = useMemo(
    () => deriveEffectiveTeammateChannelMemberships({ teammate, channels: catalogChannels, memberships }),
    [catalogChannels, memberships, teammate],
  );
  const rows = useMemo(() => buildTeammateChannelRows({
    channels: catalogChannels,
    memberships: effectiveMemberships,
    protectedTeammate,
  }), [catalogChannels, effectiveMemberships, protectedTeammate]);
  const visibleRows = useMemo(
    () => filterTeammateChannelRows(rows, searchQuery, filter),
    [filter, rows, searchQuery],
  );
  const stats = useMemo(() => summarizeTeammateChannels(rows), [rows]);

  const refresh = useCallback(async (mode: "initial" | "refresh" = "refresh"): Promise<void> => {
    const workspaceCwd = cwd.trim();
    const requestIdentity = `${workspaceCwd}::${teammate.id}`;
    const requestId = ++loadSequenceRef.current;
    if (!workspaceCwd) {
      setLoadError(t("Workspace path is required."));
      return;
    }
    if (mode === "initial") setLoading(true);
    else setRefreshing(true);
    setLoadError("");
    try {
      const [response, archivedResponse] = await Promise.all([
        listTeammateChannels(workspaceCwd, teammate.id),
        listChannels(workspaceCwd, { archived: true, limit: 100 }),
      ]);
      if (identityRef.current !== requestIdentity || requestId !== loadSequenceRef.current) return;
      membershipsRef.current = response.memberships;
      hasSnapshotRef.current = true;
      setMemberships(response.memberships);
      setArchivedChannels(archivedResponse.channels);
      setStale(false);
      setRowErrors({});
    } catch {
      if (identityRef.current !== requestIdentity || requestId !== loadSequenceRef.current) return;
      setStale(hasSnapshotRef.current);
      setLoadError(t("Channel memberships could not be loaded. Try again."));
    } finally {
      if (identityRef.current === requestIdentity && requestId === loadSequenceRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [cwd, t, teammate.id]);

  useEffect(() => {
    loadSequenceRef.current += 1;
    membershipsRef.current = [];
    hasSnapshotRef.current = false;
    busyActionsRef.current = {};
    mutationQueueRef.current = Promise.resolve();
    setMemberships([]);
    setArchivedChannels([]);
    setLoading(false);
    setRefreshing(false);
    setStale(false);
    setLoadError("");
    setSearchQuery("");
    setFilter("all");
    setBusyActions({});
    setRowErrors({});
    if (feedbackToastIdRef.current) dismissToast(feedbackToastIdRef.current);
    feedbackToastIdRef.current = "";
    void refresh("initial");
  }, [dismissToast, identityKey, refresh]);

  function clearFilters(): void {
    setSearchQuery("");
    setFilter("all");
  }

  function mutate(action: TeammateChannelAction, channelId: string): Promise<void> {
    if (protectedTeammate || busyActionsRef.current[channelId]) return Promise.resolve();
    const operationIdentity = identityRef.current;
    beginBusy(channelId, action);
    clearRowError(channelId);

    const operation = mutationQueueRef.current.then(async () => {
      if (identityRef.current !== operationIdentity) return;
      const effectiveSnapshot = deriveEffectiveTeammateChannelMemberships({
        teammate,
        channels: catalogChannels,
        memberships: membershipsRef.current,
      });
      const payload = deriveTeammateChannelMutationPayload({
        action,
        channelId,
        channels: catalogChannels,
        memberships: effectiveSnapshot,
        protectedTeammate,
      });
      if (!payload) return;
      try {
        const response = await replaceTeammateChannels(cwd.trim(), teammate.id, payload);
        if (identityRef.current !== operationIdentity) return;
        loadSequenceRef.current += 1;
        membershipsRef.current = response.memberships;
        hasSnapshotRef.current = true;
        setMemberships(response.memberships);
        setLoadError("");
        setStale(false);
        clearRowError(channelId);
        if (feedbackToastIdRef.current) dismissToast(feedbackToastIdRef.current);
        feedbackToastIdRef.current = showToast({
          message: successMessage(action, channelId),
          scope: `teammate:channels:${teammate.id}:mutation`,
          tone: "success",
        });
        try {
          await onRefreshChannels?.();
        } catch {
          // The membership response is authoritative; shell refresh can recover independently.
        }
      } catch {
        if (identityRef.current === operationIdentity) {
          setRowError(channelId, t("Channel relationship could not be updated. Try again."));
        }
      }
    }).finally(() => {
      if (identityRef.current === operationIdentity) finishBusy(channelId);
    });
    mutationQueueRef.current = operation.catch(() => undefined);
    return operation;
  }

  function successMessage(action: TeammateChannelAction, channelId: string): string {
    const name = catalogChannels.find((channel) => channel.id === channelId)?.name ?? t("Channel");
    if (action === "join") return t("Joined {name}", { name });
    if (action === "leave") return t("Left {name}", { name });
    return t("{name} is now the default channel", { name });
  }

  function beginBusy(channelId: string, action: TeammateChannelAction): void {
    busyActionsRef.current = { ...busyActionsRef.current, [channelId]: action };
    setBusyActions(busyActionsRef.current);
  }

  function finishBusy(channelId: string): void {
    const next = { ...busyActionsRef.current };
    delete next[channelId];
    busyActionsRef.current = next;
    setBusyActions(next);
  }

  function clearRowError(channelId: string): void {
    setRowErrors((current) => {
      if (!(channelId in current)) return current;
      const next = { ...current };
      delete next[channelId];
      return next;
    });
  }

  function setRowError(channelId: string, message: string): void {
    setRowErrors((current) => ({ ...current, [channelId]: message }));
  }

  return {
    busyActions,
    effectiveMemberships,
    filter,
    loadError,
    loading,
    refreshing,
    rowErrors,
    rows,
    searchQuery,
    stale,
    stats,
    visibleRows,
    clearFilters,
    join: (channelId: string) => mutate("join", channelId),
    leave: (channelId: string) => mutate("leave", channelId),
    refresh,
    setDefault: (channelId: string) => mutate("set-default", channelId),
    setFilter,
    setSearchQuery,
  };
}

export type TeammateChannelsController = ReturnType<typeof useTeammateChannelsController>;
