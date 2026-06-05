import { useEffect, useMemo, useRef, useState } from "react";
import {
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
import { useI18n } from "../../i18n.js";
import { isMediaProvider, providerPreflightReady } from "../../lib/providers.js";
import { AvatarInitial, MetaRow } from "../../shared/components/index.js";
import type {
  Channel,
  ProviderPreset,
} from "../../types.js";
import {
  approvalProfileText,
  roleAvatarTone,
  roleLabel,
  teammateInitial,
  teammateInitialFromName,
  teammateTemplateMatchesFilter,
  workflowPhaseLabel,
} from "./helpers.js";
import type {
  LocalTeammateCreateInput,
  LocalTeammateDraft,
  TeammateTemplateFilter,
} from "./types.js";

const teammateTemplateFilters: readonly { readonly id: TeammateTemplateFilter; readonly label: string }[] = [
  { id: "all", label: "All" },
  { id: "product", label: "Product" },
  { id: "engineering", label: "Engineering" },
  { id: "design", label: "Design" },
  { id: "qa", label: "QA" },
  { id: "security", label: "Security" },
  { id: "docs", label: "Docs" },
];

const teammateMemorySources: readonly { readonly id: string; readonly label: string; readonly detail: string }[] = [
  { id: "project-files", label: "Project files", detail: "Repository files and task artifacts" },
  { id: "agents-md", label: "AGENTS.md", detail: "Project agent rules and local operating protocol" },
  { id: "skill-pack", label: "Skill pack", detail: "Bound skill prompts and workflow templates" },
  { id: "private-notes", label: "Private notes", detail: "Future per-teammate notes store" },
];

export function AiTeammatesPage({
  skillPack,
  providers,
  channels,
  localTeammates,
  onCreateTeammate,
  onRemoveTeammate,
  onToggleTeammatePinned,
  onToggleTeammateHidden,
  onOpenProviders,
}: {
  readonly skillPack: SkillPack | undefined;
  readonly providers: readonly ProviderPreset[];
  readonly channels: readonly Channel[];
  readonly localTeammates: readonly LocalTeammateDraft[];
  readonly onCreateTeammate: (teammate: LocalTeammateCreateInput) => void;
  readonly onRemoveTeammate: (teammateId: string) => void;
  readonly onToggleTeammatePinned: (teammateId: string) => void;
  readonly onToggleTeammateHidden: (teammateId: string) => void;
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
  const [selectedTemplateId, setSelectedTemplateId] = useState(() => templates[0]?.id ?? "");
  const [templateFilter, setTemplateFilter] = useState<TeammateTemplateFilter>("all");
  const [draftName, setDraftName] = useState(() => templates[0] ? t(templates[0].name) : t("Custom teammate"));
  const [draftDescription, setDraftDescription] = useState(() => templates[0] ? t(templates[0].summary) : "");
  const [selectedProviderId, setSelectedProviderId] = useState(() => providerOptions.find(providerPreflightReady)?.id ?? providerOptions[0]?.id ?? "");
  const [selectedChannelIds, setSelectedChannelIds] = useState<readonly string[]>(() => channels[0] ? [channels[0].id] : []);
  const [selectedMemorySources, setSelectedMemorySources] = useState<readonly string[]>(["project-files", "agents-md", "skill-pack"]);
  const [isCreateOpen, setCreateOpen] = useState(false);
  const [detailTemplateId, setDetailTemplateId] = useState<string>("");
  const wizardRef = useRef<HTMLElement | null>(null);
  const selectedTemplate = templates.find((template) => template.id === selectedTemplateId) ?? templates[0];
  const detailTemplate = templates.find((template) => template.id === detailTemplateId);
  const selectedProvider = providerOptions.find((provider) => provider.id === selectedProviderId);
  const previewName = draftName.trim() || selectedTemplate?.name || t("Custom teammate");
  const previewDescription = draftDescription.trim() || selectedTemplate?.summary || t("Describe this teammate with a short working brief.");
  const filteredTemplates = templates.filter((template) => teammateTemplateMatchesFilter(template, templateFilter));
  const selectedProviderReady = selectedProvider ? providerPreflightReady(selectedProvider) : false;
  const canCreateTeammate = Boolean(previewName.trim()) && Boolean(selectedProvider) && selectedProviderReady;

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

  function toggleMemorySource(sourceId: string): void {
    setSelectedMemorySources((currentSources) =>
      currentSources.includes(sourceId) ? currentSources.filter((id) => id !== sourceId) : [...currentSources, sourceId],
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
      memorySources: selectedMemorySources,
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
      {isCreateOpen ? (
        <div className="teammate-sheet-backdrop" role="presentation">
          <section className="teammate-create-sheet" aria-label={t("Create AI teammate")} ref={wizardRef} role="dialog" aria-modal="true">
            <header className="teammate-create-header">
              <div>
                <h2>{t("Add teammate")}</h2>
                <p>{t("Choose role, model, and channel scope.")}</p>
              </div>
              <button className="icon-button" type="button" onClick={() => setCreateOpen(false)} aria-label={t("Close teammate creator")}>
                <X size={16} />
              </button>
            </header>

            <div className="teammate-create-body">
              <section className="teammate-create-section">
                <div className="teammate-create-section-title">
                  <span>{t("Choose a role")}</span>
                  <small>{t("Start from a default role or blank teammate.")}</small>
                </div>
                <div className="teammate-filter-tabs" role="tablist" aria-label={t("Role filters")}>
                  {teammateTemplateFilters.map((filter) => (
                    <button
                      key={filter.id}
                      className={filter.id === templateFilter ? "active" : ""}
                      type="button"
                      onClick={() => setTemplateFilter(filter.id)}
                    >
                      {t(filter.label)}
                    </button>
                  ))}
                </div>
                <div className="teammate-create-list role-grid" aria-label={t("Teammate template chooser")}>
                  {filteredTemplates.map((template) => (
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
                  <span>{t("Choose a model")}</span>
                  <small>{t("Bind a provider preset for this teammate.")}</small>
                </div>
                {providerOptions.length === 0 ? (
                  <div className="client-empty-state teammate-empty">
                    <PlugZap size={20} />
                    <span>{t("No model presets")}</span>
                    <button className="secondary-button" type="button" onClick={onOpenProviders}>{t("Open Model Workbench")}</button>
                  </div>
                ) : (
                  <div className="teammate-create-list compact" aria-label={t("Model choices")}>
                    {providerOptions.map((provider) => (
                      <button
                        key={provider.id}
                        className={provider.id === selectedProviderId ? "teammate-provider-row selected" : "teammate-provider-row"}
                        type="button"
                        aria-pressed={provider.id === selectedProviderId}
                        onClick={() => setSelectedProviderId(provider.id)}
                      >
                        <span className={providerPreflightReady(provider) ? "provider-state run-ready" : "provider-state run-blocked"}>
                          {providerPreflightReady(provider) ? t("ready") : t("needs check")}
                        </span>
                        <span>
                          <strong>{provider.displayName}</strong>
                          <small>{provider.model}</small>
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </section>

              <section className="teammate-create-section">
                <div className="teammate-create-section-title">
                  <span>{t("Basic information")}</span>
                  <small>{t("Name and a short working brief.")}</small>
                </div>
                <div className="teammate-create-fields">
                  <label className="field">
                    <span>{t("Teammate name")}</span>
                    <input value={draftName} onChange={(event) => setDraftName(event.target.value)} />
                  </label>
                  <label className="field">
                    <span>{t("Description")}</span>
                    <textarea value={draftDescription} onChange={(event) => setDraftDescription(event.target.value)} />
                  </label>
                </div>
              </section>

              <details className="teammate-create-section teammate-create-advanced">
                <summary>
                  <span>{t("Advanced settings")}</span>
                  <small>{t("Channels and memory")}</small>
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
                    <div className="teammate-memory-list compact">
                      {teammateMemorySources.map((source) => (
                        <label key={source.id} className="teammate-toggle">
                          <input
                            type="checkbox"
                            checked={selectedMemorySources.includes(source.id)}
                            onChange={() => toggleMemorySource(source.id)}
                          />
                          <FileText size={15} />
                          <span>
                            <strong>{t(source.label)}</strong>
                          </span>
                        </label>
                      ))}
                    </div>
                  </section>
                </div>
              </details>
            </div>

            <footer className="teammate-create-actions">
              {!selectedProviderReady ? (
                <span className="teammate-create-blocked">{selectedProvider ? t("Selected model needs configuration.") : t("Choose a model before creating.")}</span>
              ) : null}
              <button className="secondary-button" type="button" onClick={() => setCreateOpen(false)}>{t("Cancel")}</button>
              <button className="primary-button" type="button" onClick={createTeammateDraft} disabled={!canCreateTeammate}>
                <Plus size={15} />
                {t("Create teammate")}
              </button>
            </footer>
          </section>
        </div>
      ) : null}

      <div className="teammate-management-grid">
        <section className="teammate-add-panel" aria-label={t("Workspace teammates")}>
          <div className="panel-title split">
            <span>
              <Users size={16} />
              <h2>{t("Workspace teammates")}</h2>
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
                return (
                  <article key={draft.id} className={draft.hidden ? "teammate-draft-row hidden-row" : "teammate-draft-row"}>
                    <AvatarInitial label={template ? teammateInitial(template) : teammateInitialFromName(draft.displayName)} tone={template ? roleAvatarTone(template.roleKey) : "gray"} />
                    <span className="teammate-draft-copy">
                      <strong>{draft.displayName}</strong>
                      <small>{draft.modelLabel} · {draftChannels.length ? draftChannels.join(", ") : t("No channel")}</small>
                    </span>
                    <span className={ready ? "teammate-status-dot ready" : "teammate-status-dot blocked"} aria-label={ready ? t("ready") : t("needs check")} />
                    <details className="teammate-row-menu">
                      <summary aria-label={t("Teammate actions")} title={t("Teammate actions")}>
                        <MoreHorizontal size={16} />
                      </summary>
                      <div className="teammate-row-menu-popover" role="menu">
                        <button type="button" onClick={() => onToggleTeammatePinned(draft.id)} role="menuitem">
                          {draft.pinned ? <PinOff size={14} /> : <Pin size={14} />}
                          {draft.pinned ? t("Unpin") : t("Pin")}
                        </button>
                        <button type="button" onClick={() => onToggleTeammateHidden(draft.id)} role="menuitem">
                          <EyeOff size={14} />
                          {draft.hidden ? t("Show") : t("Hide")}
                        </button>
                        <button type="button" onClick={() => onRemoveTeammate(draft.id)} role="menuitem">
                          <Trash2 size={14} />
                          {t("Delete")}
                        </button>
                      </div>
                    </details>
                  </article>
                );
              })}
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
