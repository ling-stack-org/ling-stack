import { useEffect, useMemo, useRef, useState } from "react";
import {
  Bot,
  Brain,
  ChevronLeft,
  ChevronRight,
  EyeOff,
  FileText,
  Folder,
  Hash,
  Pin,
  PinOff,
  PlugZap,
  Plus,
  Sparkles,
  Trash2,
  UserPlus,
  Users,
  Workflow,
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
  TeammateWizardStepId,
} from "./types.js";

const teammateWizardSteps: readonly { readonly id: TeammateWizardStepId; readonly label: string; readonly detail: string }[] = [
  { id: "template", label: "Role", detail: "Pick a default teammate or start blank" },
  { id: "model", label: "Model", detail: "Bind a provider preset for this teammate" },
  { id: "profile", label: "Profile", detail: "Name, avatar, and working brief" },
  { id: "placement", label: "Scope", detail: "Channels, memory, and files" },
];

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
  const [selectedTemplateId, setSelectedTemplateId] = useState(() => templates[0]?.id ?? "");
  const [templateFilter, setTemplateFilter] = useState<TeammateTemplateFilter>("all");
  const [activeStep, setActiveStep] = useState<TeammateWizardStepId>("template");
  const [draftName, setDraftName] = useState(() => templates[0]?.name ?? t("Custom teammate"));
  const [draftDescription, setDraftDescription] = useState(() => templates[0]?.summary ?? "");
  const [selectedProviderId, setSelectedProviderId] = useState(() => providerOptions.find(providerPreflightReady)?.id ?? providerOptions[0]?.id ?? "");
  const [selectedChannelIds, setSelectedChannelIds] = useState<readonly string[]>(() => channels[0] ? [channels[0].id] : []);
  const [selectedMemorySources, setSelectedMemorySources] = useState<readonly string[]>(["project-files", "agents-md", "skill-pack"]);
  const wizardRef = useRef<HTMLElement | null>(null);
  const selectedTemplate = templates.find((template) => template.id === selectedTemplateId) ?? templates[0];
  const selectedProvider = providerOptions.find((provider) => provider.id === selectedProviderId);
  const activeStepIndex = teammateWizardSteps.findIndex((step) => step.id === activeStep);
  const previewName = draftName.trim() || selectedTemplate?.name || t("Custom teammate");
  const previewDescription = draftDescription.trim() || selectedTemplate?.summary || t("Describe this teammate with a short working brief.");
  const filteredTemplates = templates.filter((template) => teammateTemplateMatchesFilter(template, templateFilter));
  const selectedSkills = selectedTemplate
    ? selectedTemplate.defaultSkillIds
        .map((skillId) => skillById.get(skillId))
        .filter((skill): skill is SkillDefinition => Boolean(skill))
    : [];
  const selectedChannelNames = selectedChannelIds
    .map((channelId) => channels.find((channel) => channel.id === channelId)?.name)
    .filter((name): name is string => Boolean(name));

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
    setDraftName(template.name);
    setDraftDescription(template.summary);
  }

  function selectBlankTemplate(): void {
    setSelectedTemplateId("");
    setDraftName(t("Custom teammate"));
    setDraftDescription(t("Describe this teammate with a short working brief."));
  }

  function moveStep(direction: -1 | 1): void {
    const nextIndex = Math.min(Math.max(activeStepIndex + direction, 0), teammateWizardSteps.length - 1);
    setActiveStep(teammateWizardSteps[nextIndex].id);
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
    onCreateTeammate({
      templateId: selectedTemplate?.id,
      displayName: previewName,
      description: previewDescription,
      providerPresetId: selectedProvider?.id,
      modelLabel: selectedProvider ? `${selectedProvider.displayName} / ${selectedProvider.model}` : t("No model selected"),
      channelIds: selectedChannelIds,
      memorySources: selectedMemorySources,
    });
  }

  function focusCreateFlow(): void {
    setActiveStep("template");
    globalThis.requestAnimationFrame(() => {
      wizardRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
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
      <section className="teammate-command-strip" aria-label={t("AI Teammates")}>
        <div>
          <span className="teammate-pack-label">{skillPack.name}</span>
          <strong>{t("Build an AI teammate")}</strong>
          <small>{t("{count} templates · {skillCount} skills · model per teammate", { count: templates.length, skillCount: skills.length })}</small>
        </div>
        <div className="teammate-command-actions">
          <button className="primary-button" type="button" onClick={focusCreateFlow}>
            <UserPlus size={15} />
            {t("Add teammate")}
          </button>
          <button className="secondary-button" type="button" onClick={onOpenProviders}>
            <PlugZap size={15} />
            {t("Model Workbench")}
          </button>
        </div>
      </section>

      <section className="teammate-wizard" aria-label={t("Create AI teammate")} ref={wizardRef}>
        <aside className="teammate-step-rail" aria-label={t("Teammate setup steps")}>
          {teammateWizardSteps.map((step, index) => (
            <button
              key={step.id}
              className={step.id === activeStep ? "teammate-step active" : index < activeStepIndex ? "teammate-step done" : "teammate-step"}
              type="button"
              onClick={() => setActiveStep(step.id)}
            >
              <span>{index + 1}</span>
              <strong>{t(step.label)}</strong>
              <small>{t(step.detail)}</small>
            </button>
          ))}
        </aside>

        <section className="teammate-wizard-stage">
          {activeStep === "template" ? (
            <>
              <div className="teammate-stage-title">
                <span><UserPlus size={16} />{t("Choose a role")}</span>
                <small>{t("Default roles come from gstack-default; blank stays custom.")}</small>
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
              <div className="teammate-template-cards" aria-label={t("Teammate template chooser")}>
                {filteredTemplates.map((template) => (
                  <button
                    key={template.id}
                    className={template.id === selectedTemplate?.id ? "teammate-template-card selected" : "teammate-template-card"}
                    type="button"
                    aria-pressed={template.id === selectedTemplate?.id}
                    onClick={() => selectTemplate(template)}
                  >
                    <AvatarInitial label={teammateInitial(template)} tone={roleAvatarTone(template.roleKey)} />
                    <span>
                      <strong>{t(template.name)}</strong>
                      <small>{roleLabel(template.roleKey, t)}</small>
                    </span>
                    <p>{t(template.summary)}</p>
                    <footer>
                      <small>{t("{count} skills", { count: template.defaultSkillIds.length })}</small>
                      <ApprovalProfileBadge profile={template.approvalProfile} compact />
                    </footer>
                  </button>
                ))}
                <button
                  className={!selectedTemplateId ? "teammate-template-card custom-card selected" : "teammate-template-card custom-card"}
                  type="button"
                  aria-pressed={!selectedTemplateId}
                  onClick={selectBlankTemplate}
                >
                  <AvatarInitial label="AI" tone="gray" />
                  <span>
                    <strong>{t("Start from blank")}</strong>
                    <small>{t("Custom")}</small>
                  </span>
                  <p>{t("Use a short description now, then bind skills and memory later.")}</p>
                  <footer>
                    <small>{t("0 skills")}</small>
                    <span className="approval-profile-badge none compact">{t("No approval")}</span>
                  </footer>
                </button>
              </div>
            </>
          ) : null}

          {activeStep === "model" ? (
            <>
              <div className="teammate-stage-title">
                <span><Sparkles size={16} />{t("Choose a model")}</span>
                <small>{t("Each teammate can bind a different provider preset.")}</small>
              </div>
              {providerOptions.length === 0 ? (
                <div className="client-empty-state teammate-empty">
                  <PlugZap size={20} />
                  <span>{t("No model presets")}</span>
                  <button className="secondary-button" type="button" onClick={onOpenProviders}>{t("Open Model Workbench")}</button>
                </div>
              ) : (
                <div className="teammate-provider-grid" aria-label={t("Model choices")}>
                  {providerOptions.map((provider) => (
                    <button
                      key={provider.id}
                      className={provider.id === selectedProviderId ? "teammate-provider-card selected" : "teammate-provider-card"}
                      type="button"
                      aria-pressed={provider.id === selectedProviderId}
                      onClick={() => setSelectedProviderId(provider.id)}
                    >
                      <span className={providerPreflightReady(provider) ? "provider-state run-ready" : "provider-state run-blocked"}>
                        {providerPreflightReady(provider) ? t("preflight ready") : t("needs check")}
                      </span>
                      <strong>{provider.displayName}</strong>
                      <small>{provider.model}</small>
                      <p>{provider.kind} · {provider.capabilities.join(", ")}</p>
                    </button>
                  ))}
                </div>
              )}
            </>
          ) : null}

          {activeStep === "profile" ? (
            <>
              <div className="teammate-stage-title">
                <span><Bot size={16} />{t("Profile")}</span>
                <small>{t("Avatar, name, and a compact working brief.")}</small>
              </div>
              <div className="teammate-profile-form">
                <div className="teammate-avatar-preview">
                  <AvatarInitial label={selectedTemplate ? teammateInitial(selectedTemplate) : teammateInitialFromName(previewName)} tone={selectedTemplate ? roleAvatarTone(selectedTemplate.roleKey) : "gray"} />
                  <span>{previewName}</span>
                </div>
                <label className="field">
                  <span>{t("Teammate name")}</span>
                  <input value={draftName} onChange={(event) => setDraftName(event.target.value)} />
                </label>
                <label className="field">
                  <span>{t("Description")}</span>
                  <textarea value={draftDescription} onChange={(event) => setDraftDescription(event.target.value)} />
                </label>
              </div>
              <div className="teammate-section compact">
                <h3>{t("System prompt")}</h3>
                <p className="teammate-prompt-preview">{selectedTemplate ? selectedTemplate.systemPrompt : t("Custom teammate prompt will be generated from the role description and selected skills.")}</p>
              </div>
            </>
          ) : null}

          {activeStep === "placement" ? (
            <>
              <div className="teammate-stage-title">
                <span><Folder size={16} />{t("Channels and memory")}</span>
                <small>{t("Keep channel defaults, files, and memory scoped per teammate.")}</small>
              </div>
              <div className="teammate-scope-grid">
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
                  <h3>{t("Memory and files")}</h3>
                  <div className="teammate-memory-list">
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
                          <small>{t(source.detail)}</small>
                        </span>
                      </label>
                    ))}
                  </div>
                </section>
              </div>
            </>
          ) : null}
        </section>

        <aside className="teammate-live-preview" aria-label={t("Teammate preview")}>
          <span className="teammate-pack-label">{selectedTemplate ? roleLabel(selectedTemplate.roleKey, t) : t("Custom")}</span>
          <div className="teammate-preview-hero">
            <AvatarInitial label={selectedTemplate ? teammateInitial(selectedTemplate) : teammateInitialFromName(previewName)} tone={selectedTemplate ? roleAvatarTone(selectedTemplate.roleKey) : "gray"} />
            <div>
              <strong>{previewName}</strong>
              <small>{selectedProvider ? selectedProvider.model : t("No model selected")}</small>
            </div>
          </div>
          <p>{t(previewDescription)}</p>
          <div className="teammate-preview-meta">
            <MetaRow label={t("Provider")} value={selectedProvider ? selectedProvider.displayName : t("None")} compact />
            <MetaRow label={t("Channels")} value={selectedChannelNames.length ? selectedChannelNames.join(", ") : t("None")} compact />
            <MetaRow label={t("Memory")} value={`${selectedMemorySources.length}`} compact />
            <MetaRow label={t("Approval")} value={selectedTemplate ? approvalProfileText(selectedTemplate.approvalProfile, t) : t("No approval")} compact />
          </div>
          {selectedSkills.length > 0 ? (
            <div className="teammate-preview-skills">
              {selectedSkills.map((skill) => (
                <span key={skill.id}>{t(skill.name)}</span>
              ))}
            </div>
          ) : null}
        </aside>

        <footer className="teammate-wizard-actions">
          <button className="secondary-button" type="button" onClick={() => moveStep(-1)} disabled={activeStepIndex === 0}>
            <ChevronLeft size={15} />
            {t("Back")}
          </button>
          {activeStepIndex < teammateWizardSteps.length - 1 ? (
            <button className="primary-button" type="button" onClick={() => moveStep(1)}>
              {t("Next")}
              <ChevronRight size={15} />
            </button>
          ) : (
            <button className="primary-button" type="button" onClick={createTeammateDraft} disabled={!previewName.trim()}>
              <Plus size={15} />
              {t("Create teammate")}
            </button>
          )}
        </footer>
      </section>

      <div className="teammate-management-grid">
        <section className="teammate-add-panel" aria-label={t("Local teammates")}>
          <div className="panel-title split">
            <span>
              <Users size={16} />
              <h2>{t("Local teammates")}</h2>
            </span>
            <small>{t("{count} configured", { count: localTeammates.length })}</small>
          </div>
          {localTeammates.length === 0 ? (
            <div className="client-empty-state teammate-empty">
              <Bot size={18} />
              <span>{t("No local teammate drafts")}</span>
            </div>
          ) : (
            <div className="teammate-draft-list">
              {localTeammates.map((draft) => {
                const template = draft.templateId ? templates.find((item) => item.id === draft.templateId) : undefined;
                const draftChannels = draft.channelIds
                  .map((channelId) => channels.find((channel) => channel.id === channelId)?.name)
                  .filter((name): name is string => Boolean(name));
                return (
                  <article key={draft.id} className={draft.hidden ? "teammate-draft-row hidden-row" : "teammate-draft-row"}>
                    <AvatarInitial label={template ? teammateInitial(template) : teammateInitialFromName(draft.displayName)} tone={template ? roleAvatarTone(template.roleKey) : "gray"} />
                    <span>
                      <strong>{draft.displayName}</strong>
                      <small>{draft.modelLabel} · {draftChannels.length ? draftChannels.join(", ") : t("No channel")}</small>
                    </span>
                    <div className="teammate-row-actions">
                      <button className={draft.pinned ? "icon-button active" : "icon-button"} type="button" onClick={() => onToggleTeammatePinned(draft.id)} aria-label={`${draft.pinned ? t("Unpin") : t("Pin")} ${draft.displayName}`}>
                        {draft.pinned ? <PinOff size={14} /> : <Pin size={14} />}
                      </button>
                      <button className={draft.hidden ? "icon-button active" : "icon-button"} type="button" onClick={() => onToggleTeammateHidden(draft.id)} aria-label={`${t("Hide")} ${draft.displayName}`}>
                        <EyeOff size={14} />
                      </button>
                      <button className="icon-button" type="button" onClick={() => onRemoveTeammate(draft.id)} aria-label={t("Delete")}>
                        <Trash2 size={14} />
                      </button>
                    </div>
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
          </div>
          <div className="teammate-template-list">
            {templates.map((template) => (
              <button
                key={template.id}
                className={template.id === selectedTemplate?.id ? "teammate-template-row selected" : "teammate-template-row"}
                type="button"
                aria-pressed={template.id === selectedTemplate?.id}
                onClick={() => {
                  selectTemplate(template);
                  setActiveStep("template");
                }}
              >
                <AvatarInitial label={teammateInitial(template)} tone={roleAvatarTone(template.roleKey)} />
                <span>
                  <strong>{t(template.name)}</strong>
                  <small>{t(template.summary)}</small>
                </span>
                <small className="template-skill-count">{t("{count} skills", { count: template.defaultSkillIds.length })}</small>
              </button>
            ))}
          </div>
        </section>

        <section className="teammate-detail-panel" aria-label={t("Teammate detail")}>
          {selectedTemplate ? (
            <>
              <div className="teammate-detail-hero">
                <AvatarInitial label={teammateInitial(selectedTemplate)} tone={roleAvatarTone(selectedTemplate.roleKey)} />
                <div>
                  <h2>{t(selectedTemplate.name)}</h2>
                  <p>{t(selectedTemplate.summary)}</p>
                </div>
                <ApprovalProfileBadge profile={selectedTemplate.approvalProfile} />
              </div>

              <div className="teammate-meta-grid">
                <MetaRow label={t("Role")} value={roleLabel(selectedTemplate.roleKey, t)} />
                <MetaRow label={t("Approval")} value={approvalProfileText(selectedTemplate.approvalProfile, t)} />
                <MetaRow label={t("Provider capabilities")} value={selectedTemplate.requiredProviderCapabilities.join(", ")} />
                <MetaRow label={t("Allowed tools")} value={selectedTemplate.allowedTools.join(", ")} />
              </div>

              <div className="teammate-section">
                <h3>{t("Default skills")}</h3>
                <div className="teammate-skill-list">
                  {selectedSkills.map((skill) => (
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
              </div>

              <div className="teammate-section">
                <h3>{t("System prompt")}</h3>
                <p className="teammate-prompt-preview">{selectedTemplate.systemPrompt}</p>
              </div>
            </>
          ) : null}
        </section>
      </div>

      {workflow ? <WorkflowTemplatePanel workflow={workflow} templates={templates} skillById={skillById} /> : null}
    </div>
  );
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
