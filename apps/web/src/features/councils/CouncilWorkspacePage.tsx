import { useEffect, useMemo, useRef, useState } from "react";
import {
  cloneAiCouncil,
  createAiCouncil,
  getChannelCouncilPolicy,
  listAiCouncilMembers,
  replaceAiCouncilMembers,
  updateAiCouncil,
  updateChannelCouncilPolicy,
} from "../../api/ai-councils.js";
import { useI18n } from "../../i18n.js";
import {
  aiCouncilBoundaryLabels,
  aiCouncilCapacityLabel,
  aiCouncilHealthFindingLabels,
  aiCouncilHealthLabels,
  aiCouncilHealthOverview,
  aiCouncilMatchesHealthFilter,
  type AiCouncilHealthFilter,
} from "../../lib/ai-councils.js";
import type {
  AiCouncil,
  AiCouncilHealthReport,
  AiCouncilMember,
  AiTeammate,
  Channel,
  ChannelCouncilPolicy,
  ReplaceAiCouncilMembersRequest,
} from "../../types.js";
import { CouncilWorkspacePanels } from "./CouncilWorkspacePanels.js";

type CouncilActionKind = "create" | "clone" | "archive" | "";

export interface CouncilWorkspacePageProps {
  readonly cwd: string;
  readonly aiCouncils: readonly AiCouncil[];
  readonly aiCouncilHealthReport?: AiCouncilHealthReport;
  readonly aiCouncilsLoading: boolean;
  readonly channels: readonly Channel[];
  readonly teammates: readonly AiTeammate[];
  readonly onRefresh: () => void | Promise<void>;
  readonly onOpenAiTeammates: () => void;
  readonly onOpenChannel: (channelId: string) => void;
  readonly onBackToWorkspaceTools?: () => void;
}

export function CouncilWorkspacePage({
  cwd,
  aiCouncils,
  aiCouncilHealthReport,
  aiCouncilsLoading,
  channels,
  teammates,
  onRefresh,
  onOpenAiTeammates,
  onOpenChannel,
  onBackToWorkspaceTools,
}: CouncilWorkspacePageProps): JSX.Element {
  const { t } = useI18n();
  const [selectedCouncilId, setSelectedCouncilId] = useState("");
  const [councilHealthFilter, setCouncilHealthFilter] = useState<AiCouncilHealthFilter>("all");
  const [members, setMembers] = useState<readonly AiCouncilMember[]>([]);
  const [membersLoading, setMembersLoading] = useState(false);
  const [membersSaving, setMembersSaving] = useState(false);
  const [membersError, setMembersError] = useState("");
  const [pendingTeammateId, setPendingTeammateId] = useState("");
  const [createCouncilOpen, setCreateCouncilOpen] = useState(false);
  const [newCouncilName, setNewCouncilName] = useState(() => t("Custom council"));
  const [newCouncilDescription, setNewCouncilDescription] = useState("");
  const [actionSaving, setActionSaving] = useState<CouncilActionKind>("");
  const [actionError, setActionError] = useState("");
  const [settingsName, setSettingsName] = useState("");
  const [settingsDescription, setSettingsDescription] = useState("");
  const [settingsPinned, setSettingsPinned] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState<"save" | "status" | "">("");
  const [settingsError, setSettingsError] = useState("");
  const [selectedChannelId, setSelectedChannelId] = useState("");
  const [channelPolicy, setChannelPolicy] = useState<ChannelCouncilPolicy | undefined>();
  const [channelPolicyLoading, setChannelPolicyLoading] = useState(false);
  const [channelPolicySaving, setChannelPolicySaving] = useState(false);
  const [channelPolicyError, setChannelPolicyError] = useState("");
  const pendingCouncilSelectionRef = useRef("");

  const activeCouncils = useMemo(
    () => aiCouncils.filter((council) => council.status !== "archived"),
    [aiCouncils],
  );
  const filteredCouncils = useMemo(
    () => activeCouncils
      .filter((council) => aiCouncilMatchesHealthFilter(council, aiCouncilHealthReport, councilHealthFilter))
      .sort((left, right) => Number(right.pinned) - Number(left.pinned) || left.displayName.localeCompare(right.displayName)),
    [activeCouncils, aiCouncilHealthReport, councilHealthFilter],
  );
  const selectedCouncil = filteredCouncils.find((council) => council.id === selectedCouncilId) ?? filteredCouncils[0];
  const selectedCouncilKey = selectedCouncil?.id ?? "";
  const activeTeammates = useMemo(
    () => teammates.filter((teammate) => teammate.status !== "disabled" && !teammate.hidden),
    [teammates],
  );
  const teammateById = useMemo(() => new Map(activeTeammates.map((teammate) => [teammate.id, teammate])), [activeTeammates]);
  const sortedMembers = useMemo(
    () => [...members].sort((left, right) => left.position - right.position || left.teammateId.localeCompare(right.teammateId)),
    [members],
  );
  const memberTeammateIds = useMemo(() => new Set(members.map((member) => member.teammateId)), [members]);
  const eligibleTeammates = useMemo(
    () => activeTeammates.filter((teammate) => !isLingAgentTeammate(teammate)),
    [activeTeammates],
  );
  const availableTeammates = useMemo(
    () => eligibleTeammates.filter((teammate) => !memberTeammateIds.has(teammate.id)),
    [eligibleTeammates, memberTeammateIds],
  );
  const overview = useMemo(() => aiCouncilHealthOverview(activeCouncils, aiCouncilHealthReport), [activeCouncils, aiCouncilHealthReport]);
  const councilHealthLabelById = useMemo(
    () => new Map(activeCouncils.map((council) => [council.id, aiCouncilHealthLabels(aiCouncilHealthReport, council.id, t)])),
    [activeCouncils, aiCouncilHealthReport, t],
  );
  const activeCouncilCount = activeCouncils.filter((council) => council.status === "active").length;
  const userCouncilCount = activeCouncils.filter((council) => council.source === "user").length;
  const visibleChannels = useMemo(
    () => [...channels].filter((channel) => channel.status !== "archived").slice(0, 6),
    [channels],
  );
  const selectedChannel = visibleChannels.find((channel) => channel.id === selectedChannelId) ?? visibleChannels[0];
  const selectedChannelKey = selectedChannel?.id ?? "";
  const attachedCouncilIds = channelPolicy?.attachedCouncilIds ?? [];
  const attachedCouncils = useMemo(
    () => attachedCouncilIds
      .map((councilId) => activeCouncils.find((council) => council.id === councilId))
      .filter((council): council is AiCouncil => Boolean(council)),
    [activeCouncils, attachedCouncilIds],
  );
  const selectedCouncilAttached = selectedCouncil ? attachedCouncilIds.includes(selectedCouncil.id) : false;
  const mutationDisabled = membersSaving || Boolean(actionSaving) || Boolean(settingsSaving) || aiCouncilsLoading;
  const canCreateCouncil = Boolean(cwd.trim()) && Boolean(newCouncilName.trim()) && !mutationDisabled;
  const canCloneCouncil = Boolean(cwd.trim()) && Boolean(selectedCouncil) && !mutationDisabled;
  const canArchiveCouncil = Boolean(cwd.trim()) && selectedCouncil?.source === "user" && !mutationDisabled;
  const canEditSelectedCouncil = Boolean(cwd.trim()) && selectedCouncil?.source === "user";
  const settingsDraftChanged = selectedCouncil
    ? settingsName.trim() !== selectedCouncil.displayName || settingsDescription.trim() !== selectedCouncil.description || settingsPinned !== selectedCouncil.pinned
    : false;
  const canSaveCouncilSettings = canEditSelectedCouncil && Boolean(settingsName.trim()) && settingsDraftChanged && !mutationDisabled;
  const canToggleCouncilStatus = canEditSelectedCouncil && !mutationDisabled;
  const canAttachSelectedCouncil = Boolean(cwd.trim()) && Boolean(selectedChannel) && Boolean(selectedCouncil) && !selectedCouncilAttached && !channelPolicyLoading && !channelPolicySaving;

  useEffect(() => {
    const pendingCouncilSelectionId = pendingCouncilSelectionRef.current;
    if (pendingCouncilSelectionId) {
      if (filteredCouncils.some((council) => council.id === pendingCouncilSelectionId)) {
        pendingCouncilSelectionRef.current = "";
        if (selectedCouncilId !== pendingCouncilSelectionId) {
          setSelectedCouncilId(pendingCouncilSelectionId);
        }
      }
      return;
    }
    if (!selectedCouncilId || !filteredCouncils.some((council) => council.id === selectedCouncilId)) {
      setSelectedCouncilId(filteredCouncils[0]?.id ?? "");
    }
  }, [filteredCouncils, selectedCouncilId]);

  useEffect(() => {
    setSettingsName(selectedCouncil?.displayName ?? "");
    setSettingsDescription(selectedCouncil?.description ?? "");
    setSettingsPinned(selectedCouncil?.pinned ?? false);
    setSettingsError("");
  }, [selectedCouncilKey, selectedCouncil?.displayName, selectedCouncil?.description, selectedCouncil?.pinned]);

  useEffect(() => {
    const trimmedCwd = cwd.trim();
    if (!trimmedCwd || !selectedCouncilKey) {
      setMembers([]);
      setMembersError("");
      setMembersLoading(false);
      return;
    }

    let cancelled = false;
    setMembersLoading(true);
    setMembersError("");
    void listAiCouncilMembers(trimmedCwd, selectedCouncilKey)
      .then((response) => {
        if (!cancelled) {
          setMembers(response.members);
        }
      })
      .catch((caught: unknown) => {
        if (!cancelled) {
          setMembers([]);
          setMembersError(caught instanceof Error ? caught.message : String(caught));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setMembersLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [cwd, selectedCouncilKey]);

  useEffect(() => {
    if (!selectedChannelId || !visibleChannels.some((channel) => channel.id === selectedChannelId)) {
      setSelectedChannelId(visibleChannels[0]?.id ?? "");
    }
  }, [selectedChannelId, visibleChannels]);

  useEffect(() => {
    const trimmedCwd = cwd.trim();
    if (!trimmedCwd || !selectedChannelKey) {
      setChannelPolicy(undefined);
      setChannelPolicyError("");
      setChannelPolicyLoading(false);
      return;
    }

    let cancelled = false;
    setChannelPolicyLoading(true);
    setChannelPolicyError("");
    void getChannelCouncilPolicy(trimmedCwd, selectedChannelKey)
      .then((response) => {
        if (!cancelled) {
          setChannelPolicy(response.policy);
        }
      })
      .catch((caught: unknown) => {
        if (!cancelled) {
          setChannelPolicy(undefined);
          setChannelPolicyError(caught instanceof Error ? caught.message : String(caught));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setChannelPolicyLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [cwd, selectedChannelKey]);

  const selectedHealthLabels = selectedCouncil ? aiCouncilHealthLabels(aiCouncilHealthReport, selectedCouncil.id, t) : [];
  const selectedHealthFindings = selectedCouncil ? aiCouncilHealthFindingLabels(aiCouncilHealthReport, selectedCouncil.id, t) : [];
  const selectedBoundaryLabels = selectedCouncil ? aiCouncilBoundaryLabels(selectedCouncil, t) : [];
  const selectedCapacityLabel = selectedCouncil ? aiCouncilCapacityLabel(selectedCouncil, t) : undefined;

  async function refreshCouncils(): Promise<void> {
    await onRefresh();
  }

  async function saveMembers(nextMembers: readonly AiCouncilMember[]): Promise<void> {
    const trimmedCwd = cwd.trim();
    if (!trimmedCwd || !selectedCouncil || membersSaving) {
      return;
    }

    setMembersSaving(true);
    setMembersError("");
    try {
      const response = await replaceAiCouncilMembers(trimmedCwd, selectedCouncil.id, {
        members: toCouncilMemberReplaceInput(nextMembers),
      });
      setMembers(response.members);
      await refreshCouncils();
    } catch (caught) {
      setMembersError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setMembersSaving(false);
    }
  }

  async function createCustomCouncil(): Promise<void> {
    const trimmedCwd = cwd.trim();
    const displayName = newCouncilName.trim();
    if (!trimmedCwd || !displayName || actionSaving) {
      return;
    }

    setActionSaving("create");
    setActionError("");
    try {
      const response = await createAiCouncil(trimmedCwd, {
        displayName,
        description: newCouncilDescription.trim() || undefined,
        routingPolicy: { defaultMode: "advisory" },
      });
      pendingCouncilSelectionRef.current = response.council.id;
      setSelectedCouncilId(response.council.id);
      setNewCouncilName(t("Custom council"));
      setNewCouncilDescription("");
      setCreateCouncilOpen(false);
      await refreshCouncils();
      setSelectedCouncilId(response.council.id);
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setActionSaving("");
    }
  }

  async function cloneSelectedCouncil(): Promise<void> {
    const trimmedCwd = cwd.trim();
    if (!trimmedCwd || !selectedCouncil || actionSaving) {
      return;
    }

    setActionSaving("clone");
    setActionError("");
    try {
      const response = await cloneAiCouncil(trimmedCwd, selectedCouncil.id, {
        displayName: t("Copy of {name}", { name: selectedCouncil.displayName }),
        description: selectedCouncil.description,
      });
      pendingCouncilSelectionRef.current = response.council.id;
      setSelectedCouncilId(response.council.id);
      await refreshCouncils();
      setSelectedCouncilId(response.council.id);
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setActionSaving("");
    }
  }

  async function saveSelectedCouncilSettings(): Promise<void> {
    const trimmedCwd = cwd.trim();
    const displayName = settingsName.trim();
    if (!trimmedCwd || !selectedCouncil || selectedCouncil.source !== "user" || !displayName || settingsSaving) {
      return;
    }

    setSettingsSaving("save");
    setSettingsError("");
    try {
      const response = await updateAiCouncil(trimmedCwd, selectedCouncil.id, {
        displayName,
        description: settingsDescription.trim(),
        pinned: settingsPinned,
      });
      pendingCouncilSelectionRef.current = response.council.id;
      setSelectedCouncilId(response.council.id);
      setSettingsName(response.council.displayName);
      setSettingsDescription(response.council.description);
      setSettingsPinned(response.council.pinned);
      await refreshCouncils();
      setSelectedCouncilId(response.council.id);
    } catch (caught) {
      setSettingsError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSettingsSaving("");
    }
  }

  async function toggleSelectedCouncilStatus(): Promise<void> {
    const trimmedCwd = cwd.trim();
    if (!trimmedCwd || !selectedCouncil || selectedCouncil.source !== "user" || settingsSaving) {
      return;
    }

    setSettingsSaving("status");
    setSettingsError("");
    try {
      const response = await updateAiCouncil(trimmedCwd, selectedCouncil.id, {
        status: selectedCouncil.status === "paused" ? "active" : "paused",
      });
      pendingCouncilSelectionRef.current = response.council.id;
      setSelectedCouncilId(response.council.id);
      await refreshCouncils();
      setSelectedCouncilId(response.council.id);
    } catch (caught) {
      setSettingsError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSettingsSaving("");
    }
  }

  async function archiveSelectedCouncil(): Promise<void> {
    const trimmedCwd = cwd.trim();
    if (!trimmedCwd || !selectedCouncil || selectedCouncil.source !== "user" || actionSaving) {
      return;
    }

    setActionSaving("archive");
    setActionError("");
    try {
      await updateAiCouncil(trimmedCwd, selectedCouncil.id, { status: "archived" });
      pendingCouncilSelectionRef.current = "";
      setSelectedCouncilId(activeCouncils.find((council) => council.id !== selectedCouncil.id)?.id ?? "");
      setMembers([]);
      await refreshCouncils();
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setActionSaving("");
    }
  }

  function addMember(): void {
    if (!selectedCouncil || !pendingTeammateId) {
      return;
    }
    const teammate = eligibleTeammates.find((item) => item.id === pendingTeammateId);
    if (!teammate || memberTeammateIds.has(teammate.id)) {
      return;
    }
    const now = new Date().toISOString();
    const nextMember: AiCouncilMember = {
      councilId: selectedCouncil.id,
      teammateId: teammate.id,
      slotKey: teammate.roleKey,
      label: teammate.roleKey ? t(`role.${teammate.roleKey}`) : teammate.displayName,
      position: sortedMembers.length,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    };
    setPendingTeammateId("");
    void saveMembers([...sortedMembers, nextMember]);
  }

  function removeMember(teammateId: string): void {
    void saveMembers(sortedMembers.filter((member) => member.teammateId !== teammateId));
  }

  function toggleMember(teammateId: string): void {
    void saveMembers(sortedMembers.map((member) =>
      member.teammateId === teammateId ? { ...member, enabled: !member.enabled } : member,
    ));
  }

  function moveMember(teammateId: string, delta: -1 | 1): void {
    const currentIndex = sortedMembers.findIndex((member) => member.teammateId === teammateId);
    const targetIndex = currentIndex + delta;
    if (currentIndex < 0 || targetIndex < 0 || targetIndex >= sortedMembers.length) {
      return;
    }
    const nextMembers = [...sortedMembers];
    const [member] = nextMembers.splice(currentIndex, 1);
    nextMembers.splice(targetIndex, 0, member);
    void saveMembers(nextMembers);
  }

  async function updateSelectedChannelPolicy(input: { readonly attachedCouncilIds?: readonly string[]; readonly preferredCouncilId?: string | null }): Promise<void> {
    const trimmedCwd = cwd.trim();
    if (!trimmedCwd || !selectedChannelKey || channelPolicySaving) {
      return;
    }
    setChannelPolicySaving(true);
    setChannelPolicyError("");
    try {
      const response = await updateChannelCouncilPolicy(trimmedCwd, selectedChannelKey, input);
      setChannelPolicy(response.policy);
    } catch (caught) {
      setChannelPolicyError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setChannelPolicySaving(false);
    }
  }

  function attachSelectedCouncilToChannel(): void {
    if (!selectedCouncil || !selectedChannel || selectedCouncilAttached || channelPolicySaving) {
      return;
    }
    const nextIds = attachedCouncilIds.includes(selectedCouncil.id) ? attachedCouncilIds : [...attachedCouncilIds, selectedCouncil.id];
    void updateSelectedChannelPolicy({
      attachedCouncilIds: nextIds,
      preferredCouncilId: channelPolicy?.preferredCouncilId ?? selectedCouncil.id,
    });
  }

  function setPreferredChannelCouncil(councilId: string): void {
    const nextIds = attachedCouncilIds.includes(councilId) ? attachedCouncilIds : [...attachedCouncilIds, councilId];
    void updateSelectedChannelPolicy({
      attachedCouncilIds: nextIds,
      preferredCouncilId: councilId,
    });
  }

  function detachChannelCouncil(councilId: string): void {
    const nextIds = attachedCouncilIds.filter((id) => id !== councilId);
    void updateSelectedChannelPolicy({
      attachedCouncilIds: nextIds,
      preferredCouncilId: channelPolicy?.preferredCouncilId === councilId ? (nextIds[0] ?? null) : (channelPolicy?.preferredCouncilId ?? null),
    });
  }

  return (
    <CouncilWorkspacePanels
      cwd={cwd}
      aiCouncilsLoading={aiCouncilsLoading}
      activeCouncils={activeCouncils}
      filteredCouncils={filteredCouncils}
      selectedCouncil={selectedCouncil}
      selectedCouncilId={selectedCouncil?.id ?? ""}
      totalCouncilCount={overview.total}
      activeCouncilCount={activeCouncilCount}
      needsAttentionCount={overview.needsAttention}
      userCouncilCount={userCouncilCount}
      councilHealthLabelById={councilHealthLabelById}
      councilHealthFilter={councilHealthFilter}
      onCouncilHealthFilterChange={setCouncilHealthFilter}
      onSelectCouncil={setSelectedCouncilId}
      onRefresh={refreshCouncils}
      onOpenAiTeammates={onOpenAiTeammates}
      onBackToWorkspaceTools={onBackToWorkspaceTools}
      createCouncilOpen={createCouncilOpen}
      onCreateCouncilOpenChange={setCreateCouncilOpen}
      newCouncilName={newCouncilName}
      newCouncilDescription={newCouncilDescription}
      onNewCouncilNameChange={setNewCouncilName}
      onNewCouncilDescriptionChange={setNewCouncilDescription}
      canCreateCouncil={canCreateCouncil}
      actionSaving={actionSaving}
      actionError={actionError}
      onCreateCouncil={createCustomCouncil}
      onCloneCouncil={cloneSelectedCouncil}
      onArchiveCouncil={archiveSelectedCouncil}
      canCloneCouncil={canCloneCouncil}
      canArchiveCouncil={canArchiveCouncil}
      selectedHealthLabels={selectedHealthLabels}
      selectedHealthFindings={selectedHealthFindings}
      selectedBoundaryLabels={selectedBoundaryLabels}
      selectedCapacityLabel={selectedCapacityLabel}
      members={sortedMembers}
      membersLoading={membersLoading}
      membersSaving={membersSaving}
      membersError={membersError}
      availableTeammates={availableTeammates}
      teammateById={teammateById}
      pendingTeammateId={pendingTeammateId}
      onPendingTeammateChange={setPendingTeammateId}
      onAddMember={addMember}
      onRemoveMember={removeMember}
      onToggleMember={toggleMember}
      onMoveMember={moveMember}
      settingsName={settingsName}
      settingsDescription={settingsDescription}
      settingsPinned={settingsPinned}
      settingsSaving={settingsSaving}
      settingsError={settingsError}
      canEditSelectedCouncil={canEditSelectedCouncil}
      canSaveCouncilSettings={canSaveCouncilSettings}
      canToggleCouncilStatus={canToggleCouncilStatus}
      onSettingsNameChange={setSettingsName}
      onSettingsDescriptionChange={setSettingsDescription}
      onSettingsPinnedChange={setSettingsPinned}
      onSaveCouncilSettings={saveSelectedCouncilSettings}
      onToggleCouncilStatus={toggleSelectedCouncilStatus}
      visibleChannels={visibleChannels}
      selectedChannel={selectedChannel}
      selectedChannelId={selectedChannelId}
      onSelectedChannelChange={setSelectedChannelId}
      channelPolicy={channelPolicy}
      channelPolicyLoading={channelPolicyLoading}
      channelPolicySaving={channelPolicySaving}
      channelPolicyError={channelPolicyError}
      attachedCouncils={attachedCouncils}
      selectedCouncilAttached={selectedCouncilAttached}
      canAttachSelectedCouncil={canAttachSelectedCouncil}
      onAttachSelectedCouncilToChannel={attachSelectedCouncilToChannel}
      onSetPreferredChannelCouncil={setPreferredChannelCouncil}
      onDetachChannelCouncil={detachChannelCouncil}
      onOpenChannel={onOpenChannel}
    />
  );
}

function toCouncilMemberReplaceInput(members: readonly AiCouncilMember[]): ReplaceAiCouncilMembersRequest["members"] {
  return members.map((member, index) => ({
    teammateId: member.teammateId,
    slotKey: member.slotKey,
    label: member.label,
    position: index,
    enabled: member.enabled,
  }));
}

function isLingAgentTeammate(teammate: AiTeammate): boolean {
  return teammate.id === "ling_agent" || teammate.id === "ling-agent" || teammate.systemRole === "ling_agent";
}
