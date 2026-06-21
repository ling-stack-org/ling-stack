import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Bot,
  Brain,
  CheckCircle2,
  Code2,
  EyeOff,
  FileText,
  Hash,
  MoreHorizontal,
  Palette,
  Pin,
  PinOff,
  PlugZap,
  Plus,
  RefreshCw,
  Rocket,
  Sparkles,
  ShieldCheck,
  Trash2,
  UserPlus,
  Users,
  Workflow,
  X,
} from "lucide-react";
import type {
  AiTeammateTemplate,
  SkillApprovalProfile,
  SkillDefinition,
  SkillPack,
  WorkflowStepTemplate,
} from "@ling-stack/core/skill-types";
import {
  listAiCouncilMembers,
  replaceAiCouncilMembers,
} from "../../api/ai-councils.js";
import { useI18n } from "../../i18n.js";
import { isMediaProvider, providerPreflightReady } from "../../lib/providers.js";
import { MetaRow } from "../../shared/components/index.js";
import type {
  AiCouncil,
  AiCouncilMember,
  Channel,
  ProviderPreset,
  ReplaceAiCouncilMembersRequest,
} from "../../types.js";
import {
  approvalProfileText,
  roleLabel,
  workflowPhaseLabel,
} from "./helpers.js";
import { TeammateAvatarView } from "./TeammateAvatarView.js";
import type {
  LocalTeammateCreateInput,
  LocalTeammateDraft,
} from "./types.js";

const defaultMemoryScopeLabels: readonly string[] = [
  "private-chat-summary",
  "private-notes",
  "channel-brief",
  "channel-decisions",
];

export function AiTeammatesPage({
  cwd,
  skillPack,
  providers,
  channels,
  localTeammates,
  aiCouncils = [],
  aiCouncilsLoading = false,
  createRequestId = 0,
  onCreateRequestHandled,
  onCreateTeammate,
  onRemoveTeammate,
  onToggleTeammatePinned,
  onToggleTeammateHidden,
  onRefreshAiCouncils,
  onOpenTeammate,
  onOpenProviders,
}: {
  readonly cwd: string;
  readonly skillPack: SkillPack | undefined;
  readonly providers: readonly ProviderPreset[];
  readonly channels: readonly Channel[];
  readonly localTeammates: readonly LocalTeammateDraft[];
  readonly aiCouncils?: readonly AiCouncil[];
  readonly aiCouncilsLoading?: boolean;
  readonly createRequestId?: number;
  readonly onCreateRequestHandled?: () => void;
  readonly onCreateTeammate: (teammate: LocalTeammateCreateInput) => void;
  readonly onRemoveTeammate: (teammateId: string) => void;
  readonly onToggleTeammatePinned: (teammateId: string) => void;
  readonly onToggleTeammateHidden: (teammateId: string) => void;
  readonly onRefreshAiCouncils?: () => void;
  readonly onOpenTeammate?: (teammateId: string) => void;
  readonly onOpenProviders: () => void;
}): JSX.Element {
  const { t } = useI18n();
  const templates = skillPack?.teammateTemplates ?? [];
  const skills = skillPack?.skills ?? [];
  const workflow = skillPack?.workflowTemplates.find((item) => item.id === "autoplan-lite") ?? skillPack?.workflowTemplates[0];
  const skillById = useMemo(() => new Map(skills.map((skill) => [skill.id, skill])), [skills]);
  const providerOptions = useMemo(() => providers.filter((provider) => !isMediaProvider(provider)), [providers]);
  const activeLocalTeammates = useMemo(
    () => localTeammates.filter((teammate) => !teammate.disabled),
    [localTeammates],
  );
  const readyLocalTeammateCount = activeLocalTeammates.filter((teammate) => {
    const provider = teammate.providerPresetId ? providers.find((item) => item.id === teammate.providerPresetId) : undefined;
    return Boolean(provider && providerPreflightReady(provider));
  }).length;
  const needsModelTeammateCount = activeLocalTeammates.filter((teammate) => {
    const provider = teammate.providerPresetId ? providers.find((item) => item.id === teammate.providerPresetId) : undefined;
    return !provider || !providerPreflightReady(provider);
  }).length;
  const noChannelTeammateCount = activeLocalTeammates.filter((teammate) => teammate.channelIds.length === 0).length;
  const hiddenTeammateCount = localTeammates.filter((teammate) => teammate.hidden && !teammate.disabled).length;
  const activeAiCouncils = useMemo(
    () => aiCouncils.filter((council) => council.status !== "archived"),
    [aiCouncils],
  );
  const [selectedTemplateId, setSelectedTemplateId] = useState(() => templates[0]?.id ?? "");
  const [draftName, setDraftName] = useState(() => templates[0] ? t(templates[0].name) : t("Custom teammate"));
  const [draftDescription, setDraftDescription] = useState(() => templates[0] ? t(templates[0].summary) : "");
  const [selectedProviderId, setSelectedProviderId] = useState(() => providerOptions.find(providerPreflightReady)?.id ?? providerOptions[0]?.id ?? "");
  const [selectedChannelIds, setSelectedChannelIds] = useState<readonly string[]>(() => channels[0] ? [channels[0].id] : []);
  const [isCreateOpen, setCreateOpen] = useState(false);
  const [detailTemplateId, setDetailTemplateId] = useState<string>("");
  const [openTeammateMenuId, setOpenTeammateMenuId] = useState("");
  const [selectedCouncilId, setSelectedCouncilId] = useState("");
  const [councilMembers, setCouncilMembers] = useState<readonly AiCouncilMember[]>([]);
  const [councilMembersLoading, setCouncilMembersLoading] = useState(false);
  const [councilMembersSaving, setCouncilMembersSaving] = useState(false);
  const [councilMemberError, setCouncilMemberError] = useState("");
  const [pendingCouncilTeammateId, setPendingCouncilTeammateId] = useState("");
  const wizardRef = useRef<HTMLElement | null>(null);
  const selectedTemplate = templates.find((template) => template.id === selectedTemplateId) ?? templates[0];
  const detailTemplate = templates.find((template) => template.id === detailTemplateId);
  const selectedCouncil = activeAiCouncils.find((council) => council.id === selectedCouncilId) ?? activeAiCouncils[0];
  const selectedProvider = providerOptions.find((provider) => provider.id === selectedProviderId);
  const previewName = draftName.trim() || selectedTemplate?.name || t("Custom teammate");
  const previewDescription = draftDescription.trim() || selectedTemplate?.summary || t("Describe this teammate with a short working brief.");
  const selectedProviderReady = selectedProvider ? providerPreflightReady(selectedProvider) : false;
  const canCreateTeammate = Boolean(previewName.trim()) && Boolean(selectedProvider) && selectedProviderReady;
  const connectedChannelCount = new Set(activeLocalTeammates.flatMap((teammate) => teammate.channelIds)).size;
  const visibleCreateTemplates = templates.slice(0, 5);
  const teammateById = useMemo(
    () => new Map(activeLocalTeammates.map((teammate) => [teammate.id, teammate])),
    [activeLocalTeammates],
  );
  const councilMemberTeammateIds = useMemo(
    () => new Set(councilMembers.map((member) => member.teammateId)),
    [councilMembers],
  );
  const councilEligibleTeammates = useMemo(
    () => activeLocalTeammates.filter((teammate) => !isLingAgentDraft(teammate)),
    [activeLocalTeammates],
  );
  const availableCouncilTeammates = useMemo(
    () => councilEligibleTeammates.filter((teammate) => !councilMemberTeammateIds.has(teammate.id)),
    [councilEligibleTeammates, councilMemberTeammateIds],
  );
  const sortedCouncilMembers = useMemo(
    () => [...councilMembers].sort((left, right) => left.position - right.position || left.teammateId.localeCompare(right.teammateId)),
    [councilMembers],
  );
  const renderedCouncilMembers = useMemo(
    () => sortedCouncilMembers.filter((member) => teammateById.has(member.teammateId)),
    [sortedCouncilMembers, teammateById],
  );

  useEffect(() => {
    if (!selectedProviderId || !providerOptions.some((provider) => provider.id === selectedProviderId)) {
      setSelectedProviderId(providerOptions.find(providerPreflightReady)?.id ?? providerOptions[0]?.id ?? "");
    }
  }, [providerOptions, selectedProviderId]);

  useEffect(() => {
    if (selectedChannelIds.length === 0 && channels[0]) {
      setSelectedChannelIds([channels[0].id]);
    }
  }, [channels, selectedChannelIds.length]);

  useEffect(() => {
    if (createRequestId > 0) {
      setCreateOpen(true);
      onCreateRequestHandled?.();
    }
  }, [createRequestId, onCreateRequestHandled]);

  useEffect(() => {
    if (!selectedCouncil || !activeAiCouncils.some((council) => council.id === selectedCouncilId)) {
      setSelectedCouncilId(activeAiCouncils[0]?.id ?? "");
    }
  }, [activeAiCouncils, selectedCouncil, selectedCouncilId]);

  useEffect(() => {
    const workspaceCwd = cwd.trim();
    if (!workspaceCwd || !selectedCouncilId) {
      setCouncilMembers([]);
      setCouncilMembersLoading(false);
      return;
    }

    let cancelled = false;
    setCouncilMembersLoading(true);
    setCouncilMemberError("");
    void listAiCouncilMembers(workspaceCwd, selectedCouncilId)
      .then((response) => {
        if (!cancelled) {
          setCouncilMembers(response.members);
        }
      })
      .catch((caught: unknown) => {
        if (!cancelled) {
          setCouncilMembers([]);
          setCouncilMemberError(caught instanceof Error ? caught.message : String(caught));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setCouncilMembersLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [cwd, selectedCouncilId]);

  function selectTemplate(template: AiTeammateTemplate): void {
    setSelectedTemplateId(template.id);
    setDraftName(t(template.name));
    setDraftDescription(t(template.summary));
  }

  function selectBlankTemplate(): void {
    setSelectedTemplateId("");
    setDraftName(t("Custom teammate"));
    setDraftDescription(t("Describe this teammate with a short working brief."));
  }

  function toggleChannel(channelId: string): void {
    setSelectedChannelIds((currentIds) =>
      currentIds.includes(channelId) ? currentIds.filter((id) => id !== channelId) : [...currentIds, channelId],
    );
  }

  function createTeammateDraft(): void {
    if (!canCreateTeammate) {
      return;
    }
    onCreateTeammate({
      templateId: selectedTemplate?.id,
      displayName: previewName,
      description: previewDescription,
      providerPresetId: selectedProvider?.id,
      modelLabel: selectedProvider ? `${selectedProvider.displayName} / ${selectedProvider.model}` : t("No model selected"),
      channelIds: selectedChannelIds,
    });
    setCreateOpen(false);
  }

  function focusCreateFlow(): void {
    setCreateOpen(true);
  }

  function openTemplateDetail(template: AiTeammateTemplate): void {
    setDetailTemplateId(template.id);
  }

  function createFromTemplate(template: AiTeammateTemplate): void {
    selectTemplate(template);
    setDetailTemplateId("");
    setCreateOpen(true);
  }

  async function saveCouncilMembers(nextMembers: readonly AiCouncilMember[]): Promise<void> {
    const workspaceCwd = cwd.trim();
    if (!workspaceCwd || !selectedCouncil || councilMembersSaving) {
      return;
    }

    setCouncilMembersSaving(true);
    setCouncilMemberError("");
    try {
      const response = await replaceAiCouncilMembers(workspaceCwd, selectedCouncil.id, {
        members: toCouncilMemberReplaceInput(nextMembers),
      });
      setCouncilMembers(response.members);
    } catch (caught) {
      setCouncilMemberError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setCouncilMembersSaving(false);
    }
  }

  function addCouncilMember(): void {
    if (!selectedCouncil || !pendingCouncilTeammateId) {
      return;
    }
    const teammate = councilEligibleTeammates.find((item) => item.id === pendingCouncilTeammateId);
    if (!teammate || councilMemberTeammateIds.has(teammate.id)) {
      return;
    }
    const nextMember: AiCouncilMember = {
      councilId: selectedCouncil.id,
      teammateId: teammate.id,
      slotKey: teammate.roleKey,
      label: teammate.roleKey ? roleLabel(teammate.roleKey, t) : teammate.displayName,
      position: sortedCouncilMembers.length,
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    setPendingCouncilTeammateId("");
    void saveCouncilMembers([...sortedCouncilMembers, nextMember]);
  }

  function removeCouncilMember(teammateId: string): void {
    void saveCouncilMembers(sortedCouncilMembers.filter((member) => member.teammateId !== teammateId));
  }

  function toggleCouncilMember(teammateId: string): void {
    void saveCouncilMembers(sortedCouncilMembers.map((member) =>
      member.teammateId === teammateId ? { ...member, enabled: !member.enabled } : member,
    ));
  }

  function moveCouncilMember(teammateId: string, delta: -1 | 1): void {
    const currentIndex = sortedCouncilMembers.findIndex((member) => member.teammateId === teammateId);
    const targetIndex = currentIndex + delta;
    if (currentIndex < 0 || targetIndex < 0 || targetIndex >= sortedCouncilMembers.length) {
      return;
    }
    const nextMembers = [...sortedCouncilMembers];
    const [member] = nextMembers.splice(currentIndex, 1);
    nextMembers.splice(targetIndex, 0, member);
    void saveCouncilMembers(nextMembers);
  }

  if (!skillPack || templates.length === 0) {
    return (
      <div className="empty-state">
        <Bot />
        <span>{t("No teammate templates available")}</span>
      </div>
    );
  }

  return (
    <div className="teammates-page">
      <header className="teammates-page-header">
        <div>
          <h1>{t("AI Teammates")}</h1>
          <p>
            {t("{count} teammates · {needsModel} need configuration · {channels} connected channels", {
              count: activeLocalTeammates.length,
              needsModel: needsModelTeammateCount,
              channels: connectedChannelCount,
            })}
          </p>
        </div>
        <button className="primary-button teammate-page-create-button" type="button" onClick={focusCreateFlow}>
          <Plus size={16} />
          {t("Add teammate")}
        </button>
      </header>

      {isCreateOpen ? (
        <div className="channel-create-overlay teammate-create-overlay" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) {
            setCreateOpen(false);
          }
        }}>
          <section className="channel-create-dialog teammate-create-dialog" aria-label={t("Create AI teammate")} ref={wizardRef} role="dialog" aria-modal="true">
            <div className="channel-create-head">
              <div className="teammate-create-title-block">
                <strong>{t("New teammate")}</strong>
                <p>{t("Choose a role first, then model. Extra configuration can be completed later.")}</p>
              </div>
              <button className="icon-button" type="button" onClick={() => setCreateOpen(false)} aria-label={t("Cancel")} title={t("Cancel")}>
                <X size={14} />
              </button>
            </div>

            <div className="channel-options-grid channel-create-grid teammate-create-body">
              <div className="teammate-create-steps" aria-hidden="true">
                <span className="active"><strong>1</strong>{t("Role")}</span>
                <span><strong>2</strong>{t("Model")}</span>
                <span><strong>3</strong>{t("Confirm")}</span>
              </div>

              <section className="teammate-create-section">
                <div className="teammate-create-section-title">
                  <span>{t("Choose initial role")}</span>
                </div>
                <div className="teammate-create-list role-grid" aria-label={t("Teammate template chooser")}>
                  {visibleCreateTemplates.map((template) => (
                    <button
                      key={template.id}
                      className={template.id === selectedTemplate?.id ? "teammate-template-row selected" : "teammate-template-row"}
                      type="button"
                      aria-pressed={template.id === selectedTemplate?.id}
                      onClick={() => selectTemplate(template)}
                    >
                      <span className="teammate-role-icon">{templateRoleIcon(template)}</span>
                      <span className="teammate-template-copy">
                        <strong>{t(template.name)}</strong>
                        <small>{t(template.summary)}</small>
                      </span>
                      <small className="template-skill-count">{roleLabel(template.roleKey, t)}</small>
                    </button>
                  ))}
                  <button
                    className={!selectedTemplateId ? "teammate-template-row selected" : "teammate-template-row"}
                    type="button"
                    aria-pressed={!selectedTemplateId}
                    onClick={selectBlankTemplate}
                  >
                    <span className="teammate-role-icon"><Plus size={14} /></span>
                    <span className="teammate-template-copy">
                      <strong>{t("Start from blank")}</strong>
                      <small>{t("Use a short description now, then bind skills and memory later.")}</small>
                    </span>
                    <small className="template-skill-count">{t("Custom")}</small>
                  </button>
                </div>
              </section>

              <section className="teammate-create-section">
                <div className="teammate-create-section-title">
                  <span>{t("Basic information")}</span>
                </div>
                <div className="teammate-create-fields">
                  <label className="field">
                    <span>{t("Teammate name")}</span>
                    <input value={draftName} onChange={(event) => setDraftName(event.target.value)} />
                  </label>
                  <label className="field">
                    <span>{t("Join channels")}</span>
                    <select
                      value={selectedChannelIds[0] ?? ""}
                      onChange={(event) => setSelectedChannelIds(event.target.value ? [event.target.value] : [])}
                      disabled={channels.length === 0}
                    >
                      <option value="">{channels.length === 0 ? t("No channels yet") : t("No channels available")}</option>
                      {channels.map((channel) => (
                        <option key={channel.id} value={channel.id}>
                          {channel.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>{t("Base model")}</span>
                    <select value={selectedProviderId} onChange={(event) => setSelectedProviderId(event.target.value)} disabled={providerOptions.length === 0}>
                      <option value="">{t("Select model")}</option>
                      {providerOptions.map((provider) => (
                        <option key={provider.id} value={provider.id}>
                          {provider.displayName} / {provider.model}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                {providerOptions.length === 0 ? (
                  <div className="client-empty-state teammate-empty">
                    <PlugZap size={20} />
                    <span>{t("No model presets")}</span>
                    <button className="secondary-button" type="button" onClick={onOpenProviders}>{t("Open Model Workbench")}</button>
                  </div>
                ) : null}
              </section>

              <details className="teammate-create-section teammate-create-advanced">
                <summary>
                  <span>{t("Advanced settings")}</span>
                  <small>{t("Memory, skills, MCP, permissions and prompt")}</small>
                </summary>
                <div className="teammate-create-advanced-body">
                  <section>
                    <h3>{t("Join channels")}</h3>
                    <div className="teammate-chip-grid" aria-label={t("Channel choices")}>
                      {channels.length === 0 ? (
                        <span className="teammate-muted-note">{t("No channels yet")}</span>
                      ) : (
                        channels.map((channel) => (
                          <button
                            key={channel.id}
                            className={selectedChannelIds.includes(channel.id) ? "teammate-chip selected" : "teammate-chip"}
                            type="button"
                            aria-pressed={selectedChannelIds.includes(channel.id)}
                            onClick={() => toggleChannel(channel.id)}
                          >
                            <Hash size={13} />
                            {channel.name}
                          </button>
                        ))
                      )}
                    </div>
                  </section>
                  <section>
                    <h3>{t("Memory")}</h3>
                    <div className="provider-run-notice neutral">
                      <ShieldCheck size={15} />
                      <span>{t("Memory is always on for each teammate.")}</span>
                    </div>
                    <div className="teammate-memory-list compact">
                      {defaultMemoryScopeLabels.map((scope) => (
                        <span key={scope} className="teammate-toggle static">
                          <FileText size={15} />
                          <span>
                            <strong>{t(scope)}</strong>
                          </span>
                        </span>
                      ))}
                    </div>
                  </section>
                </div>
              </details>

              <div className="channel-option-actions teammate-create-actions">
                {!selectedProviderReady ? (
                  <span className="teammate-create-blocked">{selectedProvider ? t("Selected model needs configuration.") : t("Choose a model before creating.")}</span>
                ) : null}
                <button className="secondary-button compact-button" type="button" onClick={() => setCreateOpen(false)}>
                  {t("Cancel")}
                </button>
                <button className="primary-button compact-button" type="button" onClick={createTeammateDraft} disabled={!canCreateTeammate}>
                  <Plus size={14} />
                  {t("Create teammate")}
                </button>
              </div>
            </div>
          </section>
        </div>
      ) : null}

      <div className="teammate-management-grid">
        <section className="teammate-add-panel" aria-label={t("Workspace teammates")}>
          <div className="panel-title split teammate-panel-title">
            <span>
              <Users size={16} />
              <span className="teammate-panel-heading">
                <h2>{t("Workspace teammates")}</h2>
                <small className="teammate-panel-meta" aria-label={t("AI teammate action summary")}>
                  {t("Ready")} {readyLocalTeammateCount} · {t("Needs model")} {needsModelTeammateCount} · {t("No channel")} {noChannelTeammateCount} · {t("Hidden")} {hiddenTeammateCount}
                </small>
              </span>
            </span>
            <small>{t("{count} configured", { count: activeLocalTeammates.length })}</small>
          </div>
          {activeLocalTeammates.length === 0 ? (
            <div className="client-empty-state teammate-empty">
              <Bot size={18} />
              <span>{t("No workspace teammates")}</span>
            </div>
          ) : (
            <div className="teammate-draft-list">
              {activeLocalTeammates.map((draft) => {
                const template = draft.templateId ? templates.find((item) => item.id === draft.templateId) : undefined;
                const draftChannels = draft.channelIds
                  .map((channelId) => channels.find((channel) => channel.id === channelId)?.name)
                  .filter((name): name is string => Boolean(name));
                const provider = draft.providerPresetId ? providers.find((item) => item.id === draft.providerPresetId) : undefined;
                const ready = provider ? providerPreflightReady(provider) : false;
                const modelLabel = draft.modelLabel === "No model selected" ? t("No model selected") : draft.modelLabel;
                const channelLabel = draftChannels.length ? draftChannels.join(", ") : t("No channel");
                const roleSummary = template ? t(template.name) : roleLabel(draft.roleKey ?? "custom", t);
                const readinessLabel = !provider ? t("Needs model") : ready ? t("Ready teammate") : t("Model needs check");
                return (
                  <article key={draft.id} className={draft.hidden ? "teammate-draft-row hidden-row" : "teammate-draft-row"}>
                    <TeammateAvatarView teammate={draft} cwd={cwd} compact />
                    <span className="teammate-draft-copy">
                      <strong>{draft.displayName}</strong>
                      <small>{roleSummary}</small>
                    </span>
                    <span className={ready ? "teammate-model-pill ready" : "teammate-model-pill warning"}>{modelLabel}</span>
                    <span className="teammate-channel-pill">{channelLabel}</span>
                    <time className="teammate-updated-time">{draft.updatedAt ? formatRelativeDraftTime(draft.updatedAt, t) : t("Just now")}</time>
                    <span className="teammate-row-actions">
                      <span className={ready ? "teammate-row-status ready" : "teammate-row-status warning"}>{readinessLabel}</span>
                      {ready && onOpenTeammate ? (
                        <button className="teammate-row-primary-action" type="button" onClick={() => onOpenTeammate(draft.id)}>
                          {t("Open")}
                        </button>
                      ) : !ready ? (
                        <button className="teammate-row-primary-action" type="button" onClick={onOpenProviders}>
                          <PlugZap size={13} />
                          {t("Configure model")}
                        </button>
                      ) : null}
                      <span
                        className={openTeammateMenuId === draft.id ? "teammate-row-menu hover-action-menu open" : "teammate-row-menu hover-action-menu"}
                        onMouseEnter={() => setOpenTeammateMenuId(draft.id)}
                        onMouseLeave={() => setOpenTeammateMenuId("")}
                        onFocus={() => setOpenTeammateMenuId(draft.id)}
                        onBlur={(event) => {
                          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                            setOpenTeammateMenuId("");
                          }
                        }}
                      >
                        <button
                          className="teammate-row-menu-trigger hover-action-menu-trigger"
                          type="button"
                          aria-label={t("Teammate actions")}
                          title={t("Teammate actions")}
                          aria-haspopup="menu"
                          onMouseDown={(event) => event.preventDefault()}
                        >
                          <MoreHorizontal size={16} />
                        </button>
                        <span
                          className="teammate-row-menu-popover hover-action-menu-popover"
                          role="menu"
                          hidden={openTeammateMenuId !== draft.id}
                        >
                          <button type="button" onClick={() => { setOpenTeammateMenuId(""); onToggleTeammatePinned(draft.id); }} role="menuitem">
                            {draft.pinned ? <PinOff size={14} /> : <Pin size={14} />}
                            {draft.pinned ? t("Unpin") : t("Pin")}
                          </button>
                          <button type="button" onClick={() => { setOpenTeammateMenuId(""); onToggleTeammateHidden(draft.id); }} role="menuitem">
                            <EyeOff size={14} />
                            {draft.hidden ? t("Show") : t("Hide")}
                          </button>
                          <button type="button" onClick={() => { setOpenTeammateMenuId(""); onRemoveTeammate(draft.id); }} role="menuitem">
                            <Trash2 size={14} />
                            {t("Delete")}
                          </button>
                        </span>
                      </span>
                    </span>
                  </article>
                );
              })}
            </div>
          )}
        </section>

        <div className="teammate-side-stack">
          <section className="teammate-council-panel" aria-label={t("AI Councils")}>
            <div className="panel-title split">
              <span>
                <Users size={16} />
                <h2>{t("AI Councils")}</h2>
              </span>
              <button className="icon-button compact-icon-button" type="button" onClick={onRefreshAiCouncils} disabled={aiCouncilsLoading} aria-label={t("Refresh AI councils")} title={t("Refresh AI councils")}>
                <RefreshCw className={aiCouncilsLoading ? "spin" : undefined} size={14} />
              </button>
            </div>

            {activeAiCouncils.length === 0 ? (
              <div className="client-empty-state teammate-empty">
                <Users size={18} />
                <span>{aiCouncilsLoading ? t("Loading councils...") : t("No AI councils available")}</span>
              </div>
            ) : (
              <div className="teammate-council-manager">
                <label className="field teammate-council-selector">
                  <span>{t("Council")}</span>
                  <select
                    aria-label={t("Select AI council")}
                    value={selectedCouncil?.id ?? ""}
                    onChange={(event) => setSelectedCouncilId(event.target.value)}
                    disabled={aiCouncilsLoading || councilMembersSaving}
                  >
                    {activeAiCouncils.map((council) => (
                      <option key={council.id} value={council.id}>{council.displayName}</option>
                    ))}
                  </select>
                </label>

                {selectedCouncil ? (
                  <div className="teammate-council-summary">
                    <strong>{selectedCouncil.displayName}</strong>
                    <small>{selectedCouncil.description}</small>
                    <span className="teammate-council-meta">
                      <span>{councilSourceLabel(selectedCouncil.source, t)}</span>
                      <span>{councilRoutingModeLabel(selectedCouncil.routingPolicy.defaultMode, t)}</span>
                      <span>{selectedCouncil.status}</span>
                    </span>
                  </div>
                ) : null}

                {councilMemberError ? (
                  <div className="provider-run-notice warning">
                    <ShieldCheck size={15} />
                    <span>{councilMemberError}</span>
                  </div>
                ) : null}

                <div className="teammate-council-add-row">
                  <select
                    aria-label={t("Add teammate to council")}
                    value={pendingCouncilTeammateId}
                    onChange={(event) => setPendingCouncilTeammateId(event.target.value)}
                    disabled={availableCouncilTeammates.length === 0 || councilMembersLoading || councilMembersSaving}
                  >
                    <option value="">{availableCouncilTeammates.length === 0 ? t("No teammates available") : t("Select teammate")}</option>
                    {availableCouncilTeammates.map((teammate) => (
                      <option key={teammate.id} value={teammate.id}>{teammate.displayName}</option>
                    ))}
                  </select>
                  <button className="secondary-button compact-button" type="button" onClick={addCouncilMember} disabled={!pendingCouncilTeammateId || councilMembersLoading || councilMembersSaving}>
                    <Plus size={14} />
                    {t("Add member")}
                  </button>
                </div>

                {councilMembersLoading ? (
                  <div className="client-empty-state teammate-empty compact">
                    <RefreshCw className="spin" size={16} />
                    <span>{t("Loading council members...")}</span>
                  </div>
                ) : renderedCouncilMembers.length === 0 ? (
                  <div className="client-empty-state teammate-empty compact">
                    <Users size={16} />
                    <span>{t("No council members")}</span>
                  </div>
                ) : (
                  <div className="teammate-council-member-list" role="list" aria-label={t("Council members")}>
                    {renderedCouncilMembers.map((member) => {
                      const teammate = teammateById.get(member.teammateId);
                      if (!teammate) {
                        return null;
                      }
                      const memberIndex = sortedCouncilMembers.findIndex((item) => item.teammateId === member.teammateId);
                      return (
                        <article key={member.teammateId} className={member.enabled ? "teammate-council-member-row" : "teammate-council-member-row disabled"} role="listitem">
                          <div className="teammate-council-member-head">
                            <TeammateAvatarView teammate={teammate} cwd={cwd} compact />
                            <span className="teammate-council-member-copy">
                              <strong>{teammate.displayName}</strong>
                              <small>{member.label ?? member.slotKey ?? t("Council member")}</small>
                            </span>
                            <span className={member.enabled ? "teammate-council-status enabled" : "teammate-council-status disabled"}>
                              {member.enabled ? t("Enabled") : t("Disabled")}
                            </span>
                          </div>
                          <div className="teammate-council-member-actions">
                            <button className="icon-button compact-icon-button" type="button" aria-label={t("Move council member up")} title={t("Move council member up")} onClick={() => moveCouncilMember(member.teammateId, -1)} disabled={memberIndex <= 0 || councilMembersSaving}>
                              <ArrowUp size={13} />
                            </button>
                            <button className="icon-button compact-icon-button" type="button" aria-label={t("Move council member down")} title={t("Move council member down")} onClick={() => moveCouncilMember(member.teammateId, 1)} disabled={memberIndex < 0 || memberIndex === sortedCouncilMembers.length - 1 || councilMembersSaving}>
                              <ArrowDown size={13} />
                            </button>
                            <button className="secondary-button compact-button" type="button" onClick={() => toggleCouncilMember(member.teammateId)} disabled={councilMembersSaving}>
                              {member.enabled ? t("Disable") : t("Enable")}
                            </button>
                            <button className="icon-button compact-icon-button" type="button" aria-label={t("Remove council member")} title={t("Remove council member")} onClick={() => removeCouncilMember(member.teammateId)} disabled={councilMembersSaving}>
                              <Trash2 size={13} />
                            </button>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </section>

          <section className="teammate-template-panel" aria-label={t("Teammate templates")}>
            <div className="panel-title split">
              <span>
                <Brain size={16} />
                <h2>{t("Default roles")}</h2>
              </span>
              <button className="primary-button compact-button" type="button" onClick={focusCreateFlow}>
                <UserPlus size={14} />
                {t("Add teammate")}
              </button>
            </div>
            <div className="teammate-template-list">
              {templates.map((template) => (
                <button
                  key={template.id}
                  className={template.id === detailTemplate?.id ? "teammate-template-row selected" : "teammate-template-row"}
                  type="button"
                  aria-pressed={template.id === detailTemplate?.id}
                  onClick={() => openTemplateDetail(template)}
                >
                  <span className="teammate-role-icon">{templateRoleIcon(template)}</span>
                  <span className="teammate-template-copy">
                    <strong>{t(template.name)}</strong>
                    <small>{t(template.summary)}</small>
                  </span>
                  <small className="template-skill-count">{roleLabel(template.roleKey, t)}</small>
                </button>
              ))}
            </div>
          </section>
        </div>
      </div>

      {detailTemplate ? (
        <TemplateDetailSheet
          template={detailTemplate}
          skills={detailTemplate.defaultSkillIds.map((skillId) => skillById.get(skillId)).filter((skill): skill is SkillDefinition => Boolean(skill))}
          workflow={workflow}
          templates={templates}
          skillById={skillById}
          onClose={() => setDetailTemplateId("")}
          onCreate={() => createFromTemplate(detailTemplate)}
        />
      ) : null}
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

function isLingAgentDraft(teammate: LocalTeammateDraft): boolean {
  return teammate.id === "ling_agent" || teammate.id === "ling-agent" || teammate.systemRole === "ling_agent";
}

function councilSourceLabel(source: AiCouncil["source"], t: (key: string) => string): string {
  if (source === "builtin") {
    return t("Built-in");
  }
  if (source === "template") {
    return t("Template");
  }
  return t("Custom");
}

function councilRoutingModeLabel(mode: AiCouncil["routingPolicy"]["defaultMode"], t: (key: string) => string): string {
  if (mode === "parallel_review") {
    return t("Parallel review");
  }
  if (mode === "handoff") {
    return t("Handoff");
  }
  return t("Advisory");
}

function templateRoleIcon(template: AiTeammateTemplate): JSX.Element {
  if (template.roleKey === "product") {
    return <Brain size={15} />;
  }
  if (template.roleKey === "engineer") {
    return <Code2 size={15} />;
  }
  if (template.roleKey === "architect") {
    return <Workflow size={15} />;
  }
  if (template.roleKey === "designer") {
    return <Palette size={15} />;
  }
  if (template.roleKey === "qa") {
    return <CheckCircle2 size={15} />;
  }
  if (template.roleKey === "security") {
    return <ShieldCheck size={15} />;
  }
  if (template.roleKey === "release") {
    return <Rocket size={15} />;
  }
  if (template.roleKey === "docs") {
    return <FileText size={15} />;
  }
  return <Sparkles size={15} />;
}

function formatRelativeDraftTime(value: string, t: (key: string, values?: Record<string, string | number>) => string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return t("Just now");
  }
  const minutes = Math.max(0, Math.round((Date.now() - timestamp) / 60_000));
  if (minutes < 1) {
    return t("Just now");
  }
  if (minutes < 60) {
    return t("{count}m ago", { count: minutes });
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return t("{count}h ago", { count: hours });
  }
  return t("{count}d ago", { count: Math.round(hours / 24) });
}

function TemplateDetailSheet({
  template,
  skills,
  workflow,
  templates,
  skillById,
  onClose,
  onCreate,
}: {
  readonly template: AiTeammateTemplate;
  readonly skills: readonly SkillDefinition[];
  readonly workflow: SkillPack["workflowTemplates"][number] | undefined;
  readonly templates: readonly AiTeammateTemplate[];
  readonly skillById: ReadonlyMap<string, SkillDefinition>;
  readonly onClose: () => void;
  readonly onCreate: () => void;
}): JSX.Element {
  const { t } = useI18n();
  return (
    <div className="teammate-sheet-backdrop" role="presentation">
      <section className="teammate-detail-sheet" aria-label={t("Role detail")} role="dialog" aria-modal="true">
        <header className="teammate-detail-sheet-header">
          <div className="teammate-detail-hero">
            <span className="teammate-role-icon large">{templateRoleIcon(template)}</span>
            <div>
              <span className="teammate-pack-label">{roleLabel(template.roleKey, t)}</span>
              <h2>{t(template.name)}</h2>
              <p>{t(template.summary)}</p>
            </div>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label={t("Close role detail")}>
            <X size={16} />
          </button>
        </header>

        <div className="teammate-detail-sheet-body">
          <section className="teammate-section">
            <h3>{t("What this teammate does")}</h3>
            <p className="teammate-readable-copy">{teammateRoleDescription(template, t)}</p>
          </section>

          <section className="teammate-section">
            <h3>{t("Best for")}</h3>
            <div className="teammate-use-list">
              {teammateRoleUseCases(template, t).map((item) => (
                <span key={item}>{item}</span>
              ))}
            </div>
          </section>

          <section className="teammate-section">
            <h3>{t("Default skills")}</h3>
            <div className="teammate-skill-list">
              {skills.map((skill) => (
                <article key={skill.id} className="teammate-skill-row">
                  <span className={`phase-token ${skill.workflowPhase}`}>{workflowPhaseLabel(skill.workflowPhase, t)}</span>
                  <div>
                    <strong>{t(skill.name)}</strong>
                    <small>{t(skill.summary)}</small>
                  </div>
                  <ApprovalProfileBadge profile={skill.approvalProfile} compact />
                </article>
              ))}
            </div>
          </section>

          <section className="teammate-section">
            <h3>{t("Safety")}</h3>
            <p className="teammate-readable-copy">
              {template.allowedTools.every((tool) => ["read", "grep", "find", "ls"].includes(tool))
                ? t("This role can only read and search project context by default.")
                : t("This role may use configured tools according to its approval profile.")}
            </p>
            <ApprovalProfileBadge profile={template.approvalProfile} />
          </section>

          <details className="teammate-advanced-detail">
            <summary>{t("Advanced details")}</summary>
            <div className="teammate-meta-grid">
              <MetaRow label={t("Provider capabilities")} value={template.requiredProviderCapabilities.join(", ")} />
              <MetaRow label={t("Allowed tools")} value={template.allowedTools.join(", ")} />
            </div>
            <div className="teammate-section">
              <h3>{t("System prompt")}</h3>
              <p className="teammate-prompt-preview">{template.systemPrompt}</p>
            </div>
            {workflow ? <WorkflowTemplatePanel workflow={workflow} templates={templates} skillById={skillById} /> : null}
          </details>
        </div>

        <footer className="teammate-detail-sheet-actions">
          <button className="secondary-button" type="button" onClick={onClose}>{t("Close")}</button>
          <button className="primary-button" type="button" onClick={onCreate}>
            <UserPlus size={15} />
            {t("Use this role")}
          </button>
        </footer>
      </section>
    </div>
  );
}

function teammateRoleDescription(template: AiTeammateTemplate, t: (key: string, values?: Record<string, string | number>) => string): string {
  if (template.roleKey === "product") {
    return t("Clarifies the problem, audience, scope, tradeoffs, and acceptance criteria before execution.");
  }
  if (template.roleKey === "engineer") {
    return t("Turns scoped tasks into implementation steps, code changes, and verification notes.");
  }
  if (template.roleKey === "architect") {
    return t("Reviews system boundaries, data flow, architecture risk, and validation strategy.");
  }
  if (template.roleKey === "designer") {
    return t("Reviews user experience, layout, interaction details, and visual hierarchy.");
  }
  if (template.roleKey === "qa") {
    return t("Checks behavior, regression risk, edge cases, and user-visible quality.");
  }
  if (template.roleKey === "security") {
    return t("Reviews trust boundaries, secrets, approvals, and risky execution paths.");
  }
  if (template.roleKey === "docs") {
    return t("Keeps product, API, and workflow documentation aligned with shipped behavior.");
  }
  if (template.roleKey === "release") {
    return t("Prepares release checks, publication steps, and launch readiness.");
  }
  return t(template.summary);
}

function teammateRoleUseCases(template: AiTeammateTemplate, t: (key: string, values?: Record<string, string | number>) => string): string[] {
  if (template.roleKey === "product") {
    return [t("When a feature idea is still fuzzy"), t("When scope and priority need decisions"), t("Before turning an idea into engineering work")];
  }
  if (template.roleKey === "engineer") {
    return [t("When a task is ready to implement"), t("When code changes need verification"), t("When an execution plan needs concrete steps")];
  }
  if (template.roleKey === "architect") {
    return [t("When system design needs review"), t("When data flow or ownership is unclear"), t("Before touching shared architecture")];
  }
  if (template.roleKey === "designer") {
    return [t("When a screen feels hard to use"), t("When layout hierarchy needs cleanup"), t("Before shipping user-facing UI")];
  }
  if (template.roleKey === "qa") {
    return [t("When behavior needs regression testing"), t("When edge cases need coverage"), t("Before marking work complete")];
  }
  if (template.roleKey === "security") {
    return [t("When secrets or approvals are involved"), t("When tool access needs review"), t("Before enabling risky actions")];
  }
  if (template.roleKey === "docs") {
    return [t("When docs need to match the product"), t("When handoff notes need cleanup"), t("Before publishing workflow changes")];
  }
  if (template.roleKey === "release") {
    return [t("When preparing a release"), t("When launch steps need review"), t("Before announcing shipped work")];
  }
  return [t("When this role matches the current work"), t("When you want a focused teammate"), t("Before assigning a scoped task")];
}

function ApprovalProfileBadge({ profile, compact = false }: { readonly profile: SkillApprovalProfile; readonly compact?: boolean }): JSX.Element {
  const { t } = useI18n();
  return <span className={`approval-profile-badge ${profile.mode} ${compact ? "compact" : ""}`}>{approvalProfileText(profile, t)}</span>;
}

function WorkflowTemplatePanel({
  workflow,
  templates,
  skillById,
}: {
  readonly workflow: SkillPack["workflowTemplates"][number];
  readonly templates: readonly AiTeammateTemplate[];
  readonly skillById: ReadonlyMap<string, SkillDefinition>;
}): JSX.Element {
  const { t } = useI18n();
  return (
    <section className="teammate-workflow-panel" aria-label={t("Workflow")}>
      <div className="panel-title split">
        <span>
          <Workflow size={16} />
          <h2>{workflow.name}</h2>
        </span>
        <small>{t("State-machine gated")}</small>
      </div>
      <p>{t(workflow.summary)}</p>
      <div className="workflow-step-lane">
        {workflow.steps.map((step, index) => (
          <WorkflowStepCard key={step.id} step={step} index={index} templates={templates} skillById={skillById} />
        ))}
      </div>
    </section>
  );
}

function WorkflowStepCard({
  step,
  index,
  templates,
  skillById,
}: {
  readonly step: WorkflowStepTemplate;
  readonly index: number;
  readonly templates: readonly AiTeammateTemplate[];
  readonly skillById: ReadonlyMap<string, SkillDefinition>;
}): JSX.Element {
  const { t } = useI18n();
  const template = templates.find((item) => item.id === step.teammateTemplateId);
  const skill = skillById.get(step.skillId);
  return (
    <article className="workflow-step-card">
      <span className="workflow-step-index">{index + 1}</span>
      <div>
        <strong>{t(step.name)}</strong>
        <small>{template ? t(template.name) : step.teammateTemplateId} · {skill ? t(skill.name) : step.skillId}</small>
      </div>
      {step.approvalGate ? <ApprovalProfileBadge profile={step.approvalGate} compact /> : null}
    </article>
  );
}
