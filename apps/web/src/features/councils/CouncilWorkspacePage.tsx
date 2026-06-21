import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  Archive,
  ArrowRight,
  ArrowDown,
  ArrowUp,
  Copy,
  PauseCircle,
  Pin,
  Play,
  Plus,
  RefreshCw,
  Save,
  Settings,
  ShieldCheck,
  Trash2,
  UsersRound,
} from "lucide-react";
import {
  cloneAiCouncil,
  createAiCouncil,
  getChannelCouncilPolicy,
  listAiCouncilMembers,
  replaceAiCouncilMembers,
  updateChannelCouncilPolicy,
  updateAiCouncil,
} from "../../api/ai-councils.js";
import { useI18n } from "../../i18n.js";
import {
  aiCouncilBoundaryLabels,
  aiCouncilCapacityLabel,
  aiCouncilHealthFilterLabel,
  aiCouncilHealthFilters,
  aiCouncilHealthFindingLabels,
  aiCouncilHealthLabels,
  aiCouncilHealthOverview,
  aiCouncilMatchesHealthFilter,
  aiCouncilRoutingModeLabel,
  aiCouncilSourceLabel,
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
import { TeammateAvatarView } from "../teammates/TeammateAvatarView.js";

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
}: CouncilWorkspacePageProps): JSX.Element {
  const { t } = useI18n();
  const [selectedCouncilId, setSelectedCouncilId] = useState("");
  const [councilHealthFilter, setCouncilHealthFilter] = useState<AiCouncilHealthFilter>("all");
  const [members, setMembers] = useState<readonly AiCouncilMember[]>([]);
  const [membersLoading, setMembersLoading] = useState(false);
  const [membersSaving, setMembersSaving] = useState(false);
  const [membersError, setMembersError] = useState("");
  const [pendingTeammateId, setPendingTeammateId] = useState("");
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
    <div className="council-workspace-page" aria-label={t("Council Workspace")}>
      <header className="council-workspace-header">
        <div>
          <span className="council-workspace-kicker">{t("AI Councils")}</span>
          <h1>{t("Council Workspace")}</h1>
          <p>{t("Manage council workspaces")}</p>
        </div>
        <div className="council-workspace-actions">
          <button className="secondary-button compact-button" type="button" onClick={() => void refreshCouncils()} aria-label={t("Refresh councils")}>
            <RefreshCw size={15} />
            <span>{t("Refresh")}</span>
          </button>
          <button className="primary-button compact-button" type="button" onClick={onOpenAiTeammates} aria-label={t("Open AI Teammates")}>
            <UsersRound size={15} />
            <span>{t("Open AI Teammates")}</span>
          </button>
        </div>
      </header>

      <section className="council-workspace-overview" aria-label={t("Council overview")}>
        <MetricCard icon={<UsersRound size={16} />} label={t("AI Councils")} value={t("{count} council(s)", { count: overview.total })} />
        <MetricCard icon={<Activity size={16} />} label={t("Active councils")} value={String(activeCouncilCount)} />
        <MetricCard icon={<ShieldCheck size={16} />} label={t("Needs attention")} value={String(overview.needsAttention)} />
        <MetricCard icon={<Settings size={16} />} label={t("User councils")} value={String(userCouncilCount)} />
      </section>

      <div className="council-workspace-grid">
        <section className="council-workspace-list" aria-label={t("AI Councils")}>
          <div className="council-panel-title">
            <strong>{t("AI Councils")}</strong>
            {aiCouncilsLoading ? <small>{t("Loading")}</small> : <small>{t("{count} council(s)", { count: filteredCouncils.length })}</small>}
          </div>
          <label className="field council-filter-field">
            <span>{t("Health filter")}</span>
            <select
              aria-label={t("Filter councils by health")}
              value={councilHealthFilter}
              onChange={(event) => setCouncilHealthFilter(event.target.value as AiCouncilHealthFilter)}
              disabled={!aiCouncilHealthReport || aiCouncilsLoading || membersSaving}
            >
              {aiCouncilHealthFilters.map((filter) => (
                <option key={filter} value={filter}>{aiCouncilHealthFilterLabel(filter, t)}</option>
              ))}
            </select>
          </label>
          {activeCouncils.length === 0 ? (
            <div className="client-empty-state">
              <span>{t("No councils available")}</span>
            </div>
          ) : filteredCouncils.length === 0 ? (
            <div className="client-empty-state">
              <span>{t("No councils match this health filter")}</span>
            </div>
          ) : (
            <div className="council-list-stack">
              {filteredCouncils.map((council) => {
                const healthLabels = aiCouncilHealthLabels(aiCouncilHealthReport, council.id, t);
                return (
                  <button
                    key={council.id}
                    className={council.id === selectedCouncil?.id ? "council-list-row selected" : "council-list-row"}
                    type="button"
                    onClick={() => setSelectedCouncilId(council.id)}
                  >
                    <span className="council-row-main">
                      <strong>{council.displayName}</strong>
                      <small>{council.description || council.id}</small>
                    </span>
                    <span className="council-row-meta">
                      <span>{aiCouncilSourceLabel(council.source, t)}</span>
                      <span>{aiCouncilRoutingModeLabel(council.routingPolicy.defaultMode, t)}</span>
                      {healthLabels.length > 0 ? healthLabels.slice(0, 2).map((label) => <span key={label}>{label}</span>) : <span>{t("Health pending")}</span>}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </section>

        <section className="council-workspace-detail" aria-label={t("Selected council")}>
          {selectedCouncil ? (
            <>
              <div className="council-detail-head">
                <div>
                  <strong>{selectedCouncil.displayName}</strong>
                  <small>{selectedCouncil.description || selectedCouncil.id}</small>
                </div>
                <span className={`status-badge ${selectedCouncil.status}`}>{selectedCouncil.status}</span>
              </div>
              <div className="council-chip-row" aria-label={t("Council boundaries")}>
                <span>{aiCouncilSourceLabel(selectedCouncil.source, t)}</span>
                <span>{aiCouncilRoutingModeLabel(selectedCouncil.routingPolicy.defaultMode, t)}</span>
                {selectedCapacityLabel ? <span>{selectedCapacityLabel}</span> : null}
                {selectedBoundaryLabels.map((label) => <span key={label}>{label}</span>)}
              </div>
              <div className="council-detail-columns">
                <section aria-label={t("Council members")} className="council-detail-section">
                  <div className="council-panel-title">
                    <strong>{t("Council members")}</strong>
                    <small>{membersLoading ? t("Loading council members...") : t("{count} enabled members", { count: sortedMembers.filter((member) => member.enabled).length })}</small>
                  </div>
                  {membersError ? <p className="inline-error">{membersError}</p> : null}
                  <div className="council-member-add-row">
                    <select
                      aria-label={t("Add teammate to council")}
                      value={pendingTeammateId}
                      onChange={(event) => setPendingTeammateId(event.target.value)}
                      disabled={availableTeammates.length === 0 || membersLoading || membersSaving}
                    >
                      <option value="">{availableTeammates.length === 0 ? t("No teammates available") : t("Select teammate")}</option>
                      {availableTeammates.map((teammate) => (
                        <option key={teammate.id} value={teammate.id}>{teammate.displayName}</option>
                      ))}
                    </select>
                    <button className="secondary-button compact-button" type="button" onClick={addMember} disabled={!pendingTeammateId || membersLoading || membersSaving}>
                      <Plus size={14} />
                      {t("Add member")}
                    </button>
                  </div>
                  {membersLoading ? (
                    <div className="client-empty-state"><span>{t("Loading council members...")}</span></div>
                  ) : sortedMembers.length === 0 ? (
                    <div className="client-empty-state"><span>{t("No council members")}</span></div>
                  ) : (
                    <div className="council-member-list">
                      {sortedMembers.map((member) => {
                        const teammate = teammateById.get(member.teammateId);
                        const displayName = teammate?.displayName ?? member.teammateId;
                        const memberIndex = sortedMembers.findIndex((item) => item.teammateId === member.teammateId);
                        return (
                          <div key={`${member.councilId}:${member.teammateId}:${member.position}`} className={member.enabled ? "council-member-row" : "council-member-row disabled"}>
                            <TeammateAvatarView teammate={teammate ?? { displayName }} cwd={cwd} compact />
                            <span>
                              <strong>{displayName}</strong>
                              <small>{member.label ?? member.slotKey ?? t("Member unavailable")}</small>
                            </span>
                            <span className={member.enabled ? "teammate-council-status enabled" : "teammate-council-status disabled"}>
                              {member.enabled ? t("Enabled") : t("Disabled")}
                            </span>
                            <span className="council-member-actions">
                              <button className="icon-button compact-icon-button" type="button" aria-label={t("Move council member up")} title={t("Move council member up")} onClick={() => moveMember(member.teammateId, -1)} disabled={memberIndex <= 0 || membersSaving}>
                                <ArrowUp size={13} />
                              </button>
                              <button className="icon-button compact-icon-button" type="button" aria-label={t("Move council member down")} title={t("Move council member down")} onClick={() => moveMember(member.teammateId, 1)} disabled={memberIndex < 0 || memberIndex === sortedMembers.length - 1 || membersSaving}>
                                <ArrowDown size={13} />
                              </button>
                              <button className="secondary-button compact-button" type="button" onClick={() => toggleMember(member.teammateId)} disabled={membersSaving}>
                                {member.enabled ? t("Disable") : t("Enable")}
                              </button>
                              <button className="icon-button compact-icon-button" type="button" aria-label={t("Remove council member")} title={t("Remove council member")} onClick={() => removeMember(member.teammateId)} disabled={membersSaving}>
                                <Trash2 size={13} />
                              </button>
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </section>

                <section aria-label={t("Council health")} className="council-detail-section">
                  <div className="council-panel-title">
                    <strong>{t("Council health")}</strong>
                    <small>{selectedHealthLabels.length > 0 ? selectedHealthLabels.join(" / ") : t("Health pending")}</small>
                  </div>
                  {selectedHealthFindings.length === 0 ? (
                    <div className="client-empty-state"><span>{t("No health findings")}</span></div>
                  ) : (
                    <ul className="council-health-list" aria-label={t("Council health findings")}>
                      {selectedHealthFindings.map((label) => <li key={label}>{label}</li>)}
                    </ul>
                  )}
                </section>
              </div>
            </>
          ) : (
            <div className="client-empty-state">
              <span>{t("No council selected")}</span>
            </div>
          )}
        </section>

        <aside className="council-workspace-side">
          <section className="council-workspace-settings" aria-label={t("Council settings")}>
            <div className="council-panel-title">
              <strong>{t("Council settings")}</strong>
              <small>{canEditSelectedCouncil ? t("Editable for custom councils") : t("Built-in councils must be cloned before editing")}</small>
            </div>
            <div className="council-settings-fields">
              <label className="field">
                <span>{t("Council name")}</span>
                <input
                  aria-label={t("Council name")}
                  value={settingsName}
                  onChange={(event) => setSettingsName(event.target.value)}
                  disabled={!canEditSelectedCouncil || mutationDisabled}
                />
              </label>
              <label className="field">
                <span>{t("Council description")}</span>
                <textarea
                  aria-label={t("Council description")}
                  value={settingsDescription}
                  onChange={(event) => setSettingsDescription(event.target.value)}
                  disabled={!canEditSelectedCouncil || mutationDisabled}
                />
              </label>
              <label className="council-settings-toggle">
                <input
                  type="checkbox"
                  checked={settingsPinned}
                  onChange={(event) => setSettingsPinned(event.target.checked)}
                  disabled={!canEditSelectedCouncil || mutationDisabled}
                />
                <span>
                  <Pin size={14} />
                  {t("Pin council")}
                </span>
              </label>
            </div>
            <div className="council-settings-actions">
              <button className="primary-button compact-button" type="button" onClick={() => void saveSelectedCouncilSettings()} disabled={!canSaveCouncilSettings}>
                <Save size={14} />
                {settingsSaving === "save" ? t("Saving settings...") : t("Save council settings")}
              </button>
              <button
                className="secondary-button compact-button"
                type="button"
                onClick={() => void toggleSelectedCouncilStatus()}
                disabled={!canToggleCouncilStatus}
                title={canEditSelectedCouncil ? (selectedCouncil?.status === "paused" ? t("Resume council") : t("Pause council")) : t("Built-in councils must be cloned before editing")}
              >
                {selectedCouncil?.status === "paused" ? <Play size={14} /> : <PauseCircle size={14} />}
                {settingsSaving === "status"
                  ? (selectedCouncil?.status === "paused" ? t("Resuming council...") : t("Pausing council..."))
                  : (selectedCouncil?.status === "paused" ? t("Resume council") : t("Pause council"))}
              </button>
            </div>
            {settingsError ? <p className="inline-error">{settingsError}</p> : null}
          </section>

          <section className="council-workspace-actions-panel" aria-label={t("Council actions")}>
            <div className="council-panel-title">
              <strong>{t("Council actions")}</strong>
              <small>{selectedCouncil?.source === "user" ? t("Custom") : t("Clone built-in councils before editing")}</small>
            </div>
            <div className="council-create-fields">
              <label className="field">
                <span>{t("New council name")}</span>
                <input
                  aria-label={t("New council name")}
                  value={newCouncilName}
                  onChange={(event) => setNewCouncilName(event.target.value)}
                  disabled={mutationDisabled}
                />
              </label>
              <label className="field">
                <span>{t("New council description")}</span>
                <input
                  aria-label={t("New council description")}
                  value={newCouncilDescription}
                  onChange={(event) => setNewCouncilDescription(event.target.value)}
                  placeholder={t("Optional council description")}
                  disabled={mutationDisabled}
                />
              </label>
            </div>
            <div className="council-action-row">
              <button className="primary-button compact-button" type="button" onClick={() => void createCustomCouncil()} disabled={!canCreateCouncil}>
                <Plus size={14} />
                {actionSaving === "create" ? t("Creating council...") : t("Create council")}
              </button>
              <button className="secondary-button compact-button" type="button" onClick={() => void cloneSelectedCouncil()} disabled={!canCloneCouncil}>
                <Copy size={14} />
                {actionSaving === "clone" ? t("Cloning council...") : t("Clone council")}
              </button>
              <button
                className="secondary-button compact-button"
                type="button"
                onClick={() => void archiveSelectedCouncil()}
                disabled={!canArchiveCouncil}
                title={selectedCouncil?.source === "user" ? t("Archive council") : t("Clone built-in councils before editing")}
              >
                <Archive size={14} />
                {actionSaving === "archive" ? t("Archiving council...") : t("Archive council")}
              </button>
            </div>
            {actionError ? <p className="inline-error">{actionError}</p> : null}
          </section>

          <section className="council-workspace-channels" aria-label={t("Channel usage")}>
            <div className="council-panel-title">
              <strong>{t("Channel usage")}</strong>
              <small>
                {channelPolicyLoading
                  ? t("Loading councils...")
                  : t("{count} council(s) attached", { count: attachedCouncils.length })}
              </small>
            </div>
            {visibleChannels.length === 0 ? (
              <div className="client-empty-state">
                <span>{t("No channels available")}</span>
              </div>
            ) : (
              <div className="council-channel-policy">
                <label className="field council-channel-select-field">
                  <span>{t("Selected channel")}</span>
                  <select
                    aria-label={t("Select channel for council")}
                    value={selectedChannel?.id ?? ""}
                    onChange={(event) => setSelectedChannelId(event.target.value)}
                    disabled={channelPolicyLoading || channelPolicySaving}
                  >
                    {visibleChannels.map((channel) => (
                      <option key={channel.id} value={channel.id}>{channel.name}</option>
                    ))}
                  </select>
                </label>

                {channelPolicyError ? <p className="inline-error">{channelPolicyError}</p> : null}

                <div className="council-channel-policy-actions">
                  <button className="primary-button compact-button" type="button" onClick={attachSelectedCouncilToChannel} disabled={!canAttachSelectedCouncil}>
                    <Plus size={14} />
                    {selectedCouncilAttached ? t("Selected council attached") : t("Attach selected council")}
                  </button>
                  <button className="secondary-button compact-button" type="button" onClick={() => selectedChannel ? onOpenChannel(selectedChannel.id) : undefined} disabled={!selectedChannel}>
                    <ArrowRight size={14} />
                    {t("Open channel")}
                  </button>
                </div>

                {attachedCouncils.length === 0 ? (
                  <div className="client-empty-state compact">
                    <span>{t("No AI councils attached")}</span>
                  </div>
                ) : (
                  <div className="council-channel-list" role="list" aria-label={t("Attached councils")}>
                    {attachedCouncils.map((council) => {
                      const preferred = channelPolicy?.preferredCouncilId === council.id;
                      return (
                        <article key={council.id} className={preferred ? "council-channel-row preferred" : "council-channel-row"} role="listitem">
                          <span>
                            <strong>{council.displayName}</strong>
                            <small>{preferred ? t("Preferred") : aiCouncilRoutingModeLabel(council.routingPolicy.defaultMode, t)}</small>
                          </span>
                          <span className="council-channel-row-actions">
                            <button className="secondary-button compact-button" type="button" onClick={() => setPreferredChannelCouncil(council.id)} disabled={preferred || channelPolicySaving}>
                              {preferred ? t("Preferred") : t("Prefer")}
                            </button>
                            <button className="icon-button compact-icon-button" type="button" aria-label={t("Detach council")} title={t("Detach council")} onClick={() => detachChannelCouncil(council.id)} disabled={channelPolicySaving}>
                              <Trash2 size={13} />
                            </button>
                          </span>
                        </article>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}

function MetricCard({
  icon,
  label,
  value,
}: {
  readonly icon: JSX.Element;
  readonly label: string;
  readonly value: string;
}): JSX.Element {
  return (
    <div className="council-metric-card">
      <span>{icon}</span>
      <small>{label}</small>
      <strong>{value}</strong>
    </div>
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
