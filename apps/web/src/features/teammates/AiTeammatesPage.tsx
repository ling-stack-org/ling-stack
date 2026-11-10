import { useMemo, useRef, useState } from "react";
import {
  Bot,
  UserPlus,
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
import {
  DesktopTitlebarSurface,
  useDesktopTitlebarPlacement,
} from "../../app/DesktopTitlebarSurface.js";
import { MetaRow } from "../../shared/components/index.js";
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
} from "../../shared/ui/index.js";
import type {
  Channel,
  ProviderPreset,
} from "../../types.js";
import {
  approvalProfileText,
  roleLabel,
} from "./helpers.js";
import { TeammateCreateDrawer } from "./TeammateCreateDrawer.js";
import { TeammateManagementList } from "./TeammateManagementList.js";
import { TeammateRoleCatalog } from "./TeammateRoleCatalog.js";
import type {
  LocalTeammateCreateInput,
  LocalTeammateDraft,
  TeammateCreateProgressEvent,
  TeammateCreateResult,
} from "./types.js";

export function AiTeammatesPage({
  cwd,
  skillPack,
  providers,
  channels,
  localTeammates,
  isLoading = false,
  loadErrorMessage,
  actionErrorMessagesByTeammateId = {},
  onCreateTeammate,
  onRemoveTeammate,
  onToggleTeammatePinned,
  onToggleTeammateHidden,
  onEditTeammate,
  onOpenTeammate,
  onOpenCouncils,
  onOpenProviders,
  onRefresh = () => undefined,
  settingsToolMode = false,
  defaultProviderId = "",
}: {
  readonly cwd: string;
  readonly skillPack: SkillPack | undefined;
  readonly providers: readonly ProviderPreset[];
  readonly channels: readonly Channel[];
  readonly localTeammates: readonly LocalTeammateDraft[];
  readonly isLoading?: boolean;
  readonly loadErrorMessage?: string;
  readonly actionErrorMessagesByTeammateId?: Readonly<Record<string, string>>;
  readonly onCreateTeammate: (
    teammate: LocalTeammateCreateInput,
    onProgress?: (event: TeammateCreateProgressEvent) => void,
  ) => Promise<TeammateCreateResult>;
  readonly onRemoveTeammate: (teammateId: string) => void;
  readonly onToggleTeammatePinned: (teammateId: string) => void;
  readonly onToggleTeammateHidden: (teammateId: string) => void;
  readonly onEditTeammate?: (teammateId: string) => void;
  readonly onOpenTeammate?: (teammateId: string) => void;
  readonly onOpenCouncils?: () => void;
  readonly onOpenProviders: () => void;
  readonly onRefresh?: () => void;
  readonly settingsToolMode?: boolean;
  readonly defaultProviderId?: string;
}): React.JSX.Element {
  const { t } = useI18n();
  const titlebarPlacement = useDesktopTitlebarPlacement();
  const templates = skillPack?.teammateTemplates ?? [];
  const skills = skillPack?.skills ?? [];
  const workflow = skillPack?.workflowTemplates.find((item) => item.id === "autoplan-lite") ?? skillPack?.workflowTemplates[0];
  const skillById = useMemo(() => new Map(skills.map((skill) => [skill.id, skill])), [skills]);
  const activeLocalTeammates = useMemo(
    () => localTeammates.filter((teammate) => !teammate.disabled),
    [localTeammates],
  );
  const [isCreateOpen, setCreateOpen] = useState(false);
  const [createTemplateId, setCreateTemplateId] = useState("");
  const [detailTemplateId, setDetailTemplateId] = useState<string>("");
  const detailTemplate = templates.find((template) => template.id === detailTemplateId);

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
      <div className="empty-state" data-desktop-window-drag-region="true">
        <Bot />
        <span>{t("No teammate templates available")}</span>
      </div>
    );
  }

  return (
    <div className={`${settingsToolMode ? "teammates-page settings-return-mode" : "teammates-page"} titlebar-${titlebarPlacement}`}>
      {!settingsToolMode || titlebarPlacement === "window" ? (
        <DesktopTitlebarSurface>
        <header className="teammates-page-header" data-desktop-window-drag-region="true">
          <div>
            <h1>{t("AI Teammates")}</h1>
            <p>{t("{count} configured", { count: activeLocalTeammates.length })}</p>
          </div>
        </header>
        </DesktopTitlebarSurface>
      ) : null}

      <TeammateCreateDrawer
        open={isCreateOpen}
        initialTemplateId={createTemplateId}
        templates={templates}
        providers={providers}
        channels={channels}
        defaultProviderId={defaultProviderId}
        onCreate={onCreateTeammate}
        onClose={() => setCreateOpen(false)}
        onOpenCreated={onOpenTeammate}
        onOpenProviders={onOpenProviders}
      />

      <div className="teammate-management-grid">
        <TeammateManagementList
          channels={channels}
          cwd={cwd}
          isLoading={isLoading}
          loadErrorMessage={loadErrorMessage}
          actionErrorMessagesByTeammateId={actionErrorMessagesByTeammateId}
          providers={providers}
          settingsToolMode={settingsToolMode}
          teammates={localTeammates}
          templates={templates}
          onCreate={focusCreateFlow}
          onEditTeammate={onEditTeammate}
          onOpenCouncils={onOpenCouncils}
          onOpenProviders={onOpenProviders}
          onOpenTeammate={onOpenTeammate}
          onRefresh={onRefresh}
          onRemoveTeammate={onRemoveTeammate}
          onToggleTeammateHidden={onToggleTeammateHidden}
          onToggleTeammatePinned={onToggleTeammatePinned}
        />

        <TeammateRoleCatalog
          selectedTemplateId={detailTemplate?.id}
          showCreateAction={activeLocalTeammates.length > 0}
          templates={templates}
          onCreate={focusCreateFlow}
          onOpenTemplate={openTemplateDetail}
        />
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
}): React.JSX.Element {
  const { t } = useI18n();
  const [dialogOpen, setDialogOpen] = useState(true);
  const closeCommittedRef = useRef(false);
  const returnFocusRef = useRef<HTMLElement | null>(
    typeof document !== "undefined" && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );

  function requestClose(): void {
    setDialogOpen(false);
  }

  return (
    <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
      <DialogContent
        aria-label={t("Role detail")}
        aria-labelledby={undefined}
        className="teammate-role-detail-dialog"
        size="lg"
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          event.stopPropagation();
          requestClose();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          returnFocusRef.current?.focus({ preventScroll: true });
          if (closeCommittedRef.current) return;
          closeCommittedRef.current = true;
          onClose();
        }}
      >
        <DialogHeader
          closeLabel={t("Close role detail")}
          description={t(template.summary)}
          title={t(template.name)}
        />
        <DialogBody className="teammate-detail-sheet-body">
          <section className="teammate-section">
            <span className="teammate-pack-label">{roleLabel(template.roleKey, t)}</span>
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
            <div className="teammate-role-skill-list">
              {skills.map((skill) => (
                <article key={skill.id} className="teammate-role-skill-row">
                  <div className="teammate-role-skill-copy">
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
        </DialogBody>
        <DialogFooter className="teammate-detail-sheet-actions">
          <Button onClick={requestClose}>{t("Close")}</Button>
          <Button leadingIcon={<UserPlus />} variant="primary" onClick={onCreate}>{t("Use this role")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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

function ApprovalProfileBadge({ profile, compact = false }: { readonly profile: SkillApprovalProfile; readonly compact?: boolean }): React.JSX.Element {
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
}): React.JSX.Element {
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
}): React.JSX.Element {
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
