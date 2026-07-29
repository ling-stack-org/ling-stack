import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getChannelCouncilPolicy, updateChannelCouncilPolicy } from "../../api/ai-councils.js";
import { listChannels } from "../../api/channels.js";
import { useI18n } from "../../i18n.js";
import type { AiCouncil, Channel, ChannelCouncilPolicy } from "../../types.js";
import {
  buildCouncilChannelRelationshipRows,
  channelRestrictionLabelKey,
  deriveCouncilChannelPolicyMutation,
  mergeCouncilChannelCatalog,
  type CouncilChannelMutationAction,
} from "./council-channels-view-model.js";

type MaybePromise<T> = T | Promise<T>;

export function useCouncilChannelsController({
  channels,
  councils,
  cwd,
  onOpenChannel,
  selectedCouncil,
}: {
  readonly channels: readonly Channel[];
  readonly councils: readonly AiCouncil[];
  readonly cwd: string;
  readonly onOpenChannel: (channelId: string) => MaybePromise<void>;
  readonly selectedCouncil?: AiCouncil;
}) {
  const { t } = useI18n();
  const [archivedChannels, setArchivedChannels] = useState<readonly Channel[]>([]);
  const [selectedChannelId, setSelectedChannelId] = useState("");
  const [policy, setPolicy] = useState<ChannelCouncilPolicy>();
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [stale, setStale] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [busyActions, setBusyActions] = useState<Readonly<Record<string, CouncilChannelMutationAction>>>({});
  const [rowErrors, setRowErrors] = useState<Readonly<Record<string, string>>>({});

  const catalogSequenceRef = useRef(0);
  const loadSequenceRef = useRef(0);
  const identityRef = useRef("");
  const policyRef = useRef<ChannelCouncilPolicy>();
  const hasSnapshotRef = useRef(false);
  const busyActionsRef = useRef<Readonly<Record<string, CouncilChannelMutationAction>>>({});
  const mutationQueueRef = useRef<Promise<void>>(Promise.resolve());

  const catalog = useMemo(
    () => mergeCouncilChannelCatalog(channels, archivedChannels),
    [archivedChannels, channels],
  );
  const selectedChannel = catalog.find((channel) => channel.id === selectedChannelId) ?? catalog[0];
  const selectedChannelKey = selectedChannel?.id ?? "";
  const identityKey = `${cwd.trim()}::${selectedChannelKey}`;
  identityRef.current = identityKey;

  const rows = useMemo(
    () => buildCouncilChannelRelationshipRows({ councils, policy, selectedChannel }),
    [councils, policy, selectedChannel],
  );
  const selectedCouncilAttached = Boolean(
    selectedCouncil && policy?.attachedCouncilIds.includes(selectedCouncil.id),
  );
  const restrictionLabelKey = channelRestrictionLabelKey(selectedChannel?.status);
  const mutationsBlocked = loading || stale || !policy || !selectedChannel;
  const attachBusy = selectedCouncil ? busyActions[selectedCouncil.id] === "attach" : false;
  const canAttachSelectedCouncil = Boolean(
    selectedCouncil
      && selectedChannel?.status === "active"
      && !selectedCouncilAttached
      && !mutationsBlocked
      && !busyActions[selectedCouncil.id],
  );

  useEffect(() => {
    const workspaceCwd = cwd.trim();
    const requestId = ++catalogSequenceRef.current;
    setArchivedChannels([]);
    if (!workspaceCwd) return;
    void listChannels(workspaceCwd, { archived: true, limit: 100 })
      .then((response) => {
        if (requestId === catalogSequenceRef.current) setArchivedChannels(response.channels);
      })
      .catch(() => {
        // Current active and paused channels remain authoritative when archive discovery is unavailable.
      });
  }, [cwd]);

  useEffect(() => {
    setSelectedChannelId((current) => {
      if (current && catalog.some((channel) => channel.id === current)) return current;
      return catalog[0]?.id ?? "";
    });
  }, [catalog]);

  const refresh = useCallback(async (mode: "initial" | "refresh" = "refresh"): Promise<void> => {
    const workspaceCwd = cwd.trim();
    const channelId = selectedChannelKey;
    const requestIdentity = `${workspaceCwd}::${channelId}`;
    const requestId = ++loadSequenceRef.current;
    if (!workspaceCwd) {
      setLoadError(t("Workspace path is required."));
      return;
    }
    if (!channelId) return;
    if (mode === "initial") setLoading(true);
    else setRefreshing(true);
    setLoadError("");
    try {
      const response = await getChannelCouncilPolicy(workspaceCwd, channelId);
      if (identityRef.current !== requestIdentity || requestId !== loadSequenceRef.current) return;
      policyRef.current = response.policy;
      hasSnapshotRef.current = true;
      setPolicy(response.policy);
      setStale(false);
      setRowErrors({});
    } catch (caught) {
      if (identityRef.current !== requestIdentity || requestId !== loadSequenceRef.current) return;
      setStale(hasSnapshotRef.current);
      setLoadError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (identityRef.current === requestIdentity && requestId === loadSequenceRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [cwd, selectedChannelKey, t]);

  useEffect(() => {
    loadSequenceRef.current += 1;
    policyRef.current = undefined;
    hasSnapshotRef.current = false;
    busyActionsRef.current = {};
    mutationQueueRef.current = Promise.resolve();
    setPolicy(undefined);
    setLoading(false);
    setRefreshing(false);
    setStale(false);
    setLoadError("");
    setBusyActions({});
    setRowErrors({});
    if (selectedChannelKey) void refresh("initial");
  }, [identityKey, refresh, selectedChannelKey]);

  function mutate(action: CouncilChannelMutationAction, councilId: string): Promise<void> {
    if (!councilId || mutationsBlocked || busyActionsRef.current[councilId]) return Promise.resolve();
    const operationIdentity = identityRef.current;
    const operationChannel = selectedChannel;
    if (!operationChannel) return Promise.resolve();
    beginBusy(councilId, action);
    clearRowError(councilId);
    loadSequenceRef.current += 1;
    setLoading(false);
    setRefreshing(false);

    const operation = mutationQueueRef.current.then(async () => {
      if (identityRef.current !== operationIdentity) return;
      const payload = deriveCouncilChannelPolicyMutation({
        action,
        councilId,
        policy: policyRef.current,
        selectedChannel: operationChannel,
      });
      if (!payload) return;
      try {
        const response = await updateChannelCouncilPolicy(cwd.trim(), operationChannel.id, payload);
        if (identityRef.current !== operationIdentity || response.channelId !== operationChannel.id) return;
        policyRef.current = response.policy;
        hasSnapshotRef.current = true;
        setPolicy(response.policy);
        setLoadError("");
        setStale(false);
        clearRowError(councilId);
      } catch (caught) {
        if (identityRef.current === operationIdentity) {
          setRowError(councilId, caught instanceof Error ? caught.message : String(caught));
        }
      }
    }).finally(() => {
      if (identityRef.current === operationIdentity) finishBusy(councilId);
    });
    mutationQueueRef.current = operation.catch(() => undefined);
    return operation;
  }

  function beginBusy(councilId: string, action: CouncilChannelMutationAction): void {
    busyActionsRef.current = { ...busyActionsRef.current, [councilId]: action };
    setBusyActions(busyActionsRef.current);
  }

  function finishBusy(councilId: string): void {
    const next = { ...busyActionsRef.current };
    delete next[councilId];
    busyActionsRef.current = next;
    setBusyActions(next);
  }

  function clearRowError(councilId: string): void {
    setRowErrors((current) => {
      if (!(councilId in current)) return current;
      const next = { ...current };
      delete next[councilId];
      return next;
    });
  }

  function setRowError(councilId: string, message: string): void {
    setRowErrors((current) => ({ ...current, [councilId]: message }));
  }

  function selectChannel(channelId: string): void {
    if (catalog.some((channel) => channel.id === channelId)) setSelectedChannelId(channelId);
  }

  return {
    attachBusy,
    busyActions,
    canAttachSelectedCouncil,
    canOpenSelectedChannel: Boolean(selectedChannel && selectedChannel.status !== "archived"),
    catalog,
    loadError,
    loading,
    mutationsBlocked,
    policy,
    refreshing,
    restrictionLabelKey,
    rowErrors,
    rows,
    selectedChannel,
    selectedChannelId: selectedChannelKey,
    selectedCouncilId: selectedCouncil?.id ?? "",
    selectedCouncilName: selectedCouncil?.displayName ?? "",
    selectedCouncilAttached,
    stale,
    attachSelectedCouncil: () => selectedCouncil ? mutate("attach", selectedCouncil.id) : Promise.resolve(),
    detachCouncil: (councilId: string) => mutate("detach", councilId),
    openSelectedChannel: () => selectedChannel && selectedChannel.status !== "archived"
      ? onOpenChannel(selectedChannel.id)
      : undefined,
    preferCouncil: (councilId: string) => mutate("prefer", councilId),
    refresh,
    selectChannel,
  };
}

export type CouncilChannelsController = ReturnType<typeof useCouncilChannelsController>;
