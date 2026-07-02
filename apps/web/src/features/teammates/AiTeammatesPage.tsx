import { useEffect, useMemo, useState } from "react";
import {
  Bot,
  Brain,
  CheckCircle2,
  Code2,
  EyeOff,
  FileText,
  MoreHorizontal,
  Palette,
  Pin,
  PinOff,
  PlugZap,
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
import { providerPreflightReady } from "../../lib/providers.js";
import { MetaRow, SettingsToolReturnRow } from "../../shared/components/index.js";
import type {
  Channel,
  ProviderPreset,
} from "../../types.js";
import {
  approvalProfileText,
  roleLabel,
  workflowPhaseLabel,
} from "./helpers.js";
import { TeammateAvatarView } from "./TeammateAvatarView.js";
import { TeammateCreateDrawer } from "./TeammateCreateDrawer.js";
import type {
  LocalTeammateCreateInput,
  LocalTeammateDraft,
} from "./types.js";

export function AiTeammatesPage({
  cwd,
  skillPack,
  providers,
  channels,
  localTeammates,
  createRequestId = 0,
  onCreateRequestHandled,
  onCreateTeammate,
  onRemoveTeammate,
  onToggleTeammatePinned,
  onToggleTeammateHidden,
  onOpenTeammate,
  onOpenCouncils,
  onOpenProviders,
  onBackToWorkspaceTools,
  defaultProviderId = "",
}: {
  readonly cwd: string;
  readonly skillPack: SkillPack | undefined;
  readonly providers: readonly ProviderPreset[];
  readonly channels: readonly Channel[];
  readonly localTeammates: readonly LocalTeammateDraft[];
  readonly createRequestId?: number;
  readonly onCreateRequestHandled?: () => void;
  readonly onCreateTeammate: (teammate: LocalTeammateCreateInput) => void;
  readonly onRemoveTeammate: (teammateId: string) => void;
  readonly onToggleTeammatePinned: (teammateId: string) => void;
  readonly onToggleTeammateHidden: (teammateId: string) => void;
  readonly onOpenTeammate?: (teammateId: string) => void;
  readonly onOpenCouncils?: () => void;
  readonly onOpenProviders: () => void;
  readonly onBackToWorkspaceTools?: () => void;
  readonly defaultProviderId?: string;
}): JSX.Element {
  const { t } = useI18n();
  const templates = skillPack?.teammateTemplates ?? [];
  const skills = skillPack?.skills ?? [];
  const workflow = skillPack?.workflowTemplates.find((item) => item.id === "autoplan-lite") ?? skillPack?.workflowTemplates[0];
  const skillById = useMemo(() => new Map(skills.map((skill) => [skill.id, skill])), [skills]);
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
  const [isCreateOpen, setCreateOpen] = useState(false);
  const [createTemplateId, setCreateTemplateId] = useState("");
  const [detailTemplateId, setDetailTemplateId] = useState<string>("");
  const [openTeammateMenuId, setOpenTeammateMenuId] = useState("");
  const detailTemplate = templates.find((template) => template.id === detailTemplateId);
  const connectedChannelCount = new Set(activeLocalTeammates.flatMap((teammate) => teammate.channelIds)).size;

  useEffect(() => {
    if (createRequestId > 0) {
      setCreateTemplateId("");
      setCreateOpen(true);
      onCreateRequestHandled?.();
    }
  }, [createRequestId, onCreateRequestHandled]);

  useEffect(() => {
    if (!openTeammateMenuId || typeof document === "undefined") {
      return;
    }
    function handlePointerDown(event: PointerEvent): void {
      const target = event.target as Element | null;
      if (target?.closest(".teammate-row-menu")) {
        return;
      }
      setOpenTeammateMenuId("");
    }
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        setOpenTeammateMenuId("");
      }
    }
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [openTeammateMenuId]);

  function focusCreateFlow(): void {
    setCreateTemplateId("");
    setCreateOpen(true);
  }

  function openTemplateDetail(template: AiTeammateTemplate): void {
    setDetailTemplateId(template.id);
  }

  function createFromTemplate(template: AiTeammateTemplate): void {
    setDetailTemplateId("");
    setCreateTemplateId(template.id);
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
    <div className={onBackToWorkspaceTools ? "teammates-page settings-return-mode" : "teammates-page"}>
      <header className={onBackToWorkspaceTools ? "teammates-page-header settings-return-mode" : "teammates-page-header"}>
        {onBackToWorkspaceTools ? <SettingsToolReturnRow onBack={onBackToWorkspaceTools} /> : null}
        {!onBackToWorkspaceTools ? (
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
        ) : null}
      </header>

      <TeammateCreateDrawer
        open={isCreateOpen}
        initialTemplateId={createTemplateId}
        templates={templates}
        providers={providers}
        channels={channels}
        defaultProviderId={defaultProviderId}
        onCreate={onCreateTeammate}
        onClose={() => setCreateOpen(false)}
        onOpenProviders={onOpenProviders}
      />

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
          {onOpenCouncils ? (
            <section className="teammate-council-inline-entry" aria-label={t("Council workspace entry")}>
              <span>
                <Users size={15} />
                <small>{t("Teammates can join councils for shared management.")}</small>
              </span>
              <button className="secondary-button compact-button" type="button" onClick={onOpenCouncils}>
                {t("Open Council Workspace")}
              </button>
            </section>
          ) : null}
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
                          aria-expanded={openTeammateMenuId === draft.id}
                          onClick={() => setOpenTeammateMenuId((currentId) => currentId === draft.id ? "" : draft.id)}
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
