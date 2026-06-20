import type { ReactNode } from "react";
import type { SkillDefinition } from "@ling-stack/core/skill-types";
import { Brain, CheckCircle2, Loader2, Plus, Search, Trash2, Upload, X } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { StatusBadge } from "../../shared/components/index.js";
import type {
  EffectiveTeammateSkill,
  SkillImportDraft,
  SkillPackSource,
  SkillRegistryEntry,
  TeammateSkillBinding,
} from "../../types.js";
import { approvalProfileText, workflowPhaseLabel } from "./helpers.js";
import {
  skillExecutionState,
  teammateSkillFilterLabel,
  type SkillBindingFilter,
} from "./teammate-workspace-utils.js";

export interface SkillImportForm {
  readonly name: string;
  readonly sourcePath: string;
  readonly source: SkillPackSource;
  readonly content: string;
}

export interface TeammateSkillRowModel {
  readonly id: string;
  readonly skill: SkillDefinition | undefined;
  readonly binding: TeammateSkillBinding | undefined;
  readonly effectiveSkill: EffectiveTeammateSkill | undefined;
}

interface SkillStats {
  readonly bound: number;
  readonly executable: number;
  readonly blocked: number;
  readonly available: number;
}

export function TeammateSkillsTab({
  savingSkills,
  skillMessage,
  skillStats,
  skillSearchQuery,
  skillFilter,
  manualSkillInput,
  skillImportOpen,
  skillImportForm,
  skillImportDraft,
  importingSkill,
  skillRows,
  skillTableRows,
  selectedSkillRow,
  registryEntryBySkillId,
  onSkillSearchQueryChange,
  onSkillFilterChange,
  onManualSkillInputChange,
  onSkillImportOpenChange,
  onSkillImportFormChange,
  onAddManualSkillBinding,
  onPreviewSkillImport,
  onPublishSkillDraft,
  onSelectSkill,
  onToggleSkillBinding,
  onDeleteUserSkillBinding,
  onArchiveCustomSkill,
}: {
  readonly savingSkills: boolean;
  readonly skillMessage: string;
  readonly skillStats: SkillStats;
  readonly skillSearchQuery: string;
  readonly skillFilter: SkillBindingFilter;
  readonly manualSkillInput: string;
  readonly skillImportOpen: boolean;
  readonly skillImportForm: SkillImportForm;
  readonly skillImportDraft: SkillImportDraft | undefined;
  readonly importingSkill: boolean;
  readonly skillRows: readonly TeammateSkillRowModel[];
  readonly skillTableRows: readonly TeammateSkillRowModel[];
  readonly selectedSkillRow: TeammateSkillRowModel | undefined;
  readonly registryEntryBySkillId: ReadonlyMap<string, SkillRegistryEntry>;
  readonly onSkillSearchQueryChange: (value: string) => void;
  readonly onSkillFilterChange: (filter: SkillBindingFilter) => void;
  readonly onManualSkillInputChange: (value: string) => void;
  readonly onSkillImportOpenChange: (open: boolean) => void;
  readonly onSkillImportFormChange: (form: SkillImportForm) => void;
  readonly onAddManualSkillBinding: () => void | Promise<void>;
  readonly onPreviewSkillImport: () => void | Promise<void>;
  readonly onPublishSkillDraft: () => void | Promise<void>;
  readonly onSelectSkill: (skillId: string) => void;
  readonly onToggleSkillBinding: (skillId: string) => void | Promise<void>;
  readonly onDeleteUserSkillBinding: (skillId: string) => void | Promise<void>;
  readonly onArchiveCustomSkill: (skillId: string) => void | Promise<void>;
}): JSX.Element {
  const { t } = useI18n();
  return (
    <section className="teammate-list-panel teammate-skills-panel teammate-skills-workbench" aria-label={t("Skills")}>
      <div className="panel-title split">
        <span>
          <Brain size={16} />
          <h2>{t("Skills")}</h2>
        </span>
        <small>{savingSkills ? t("Saving...") : skillMessage || t("{count} executable", { count: skillStats.executable })}</small>
      </div>

      <div className="teammate-skill-summary-grid" aria-label={t("Skill execution stats")}>
        <span>
          <small>{t("Bound")}</small>
          <strong>{skillStats.bound}</strong>
        </span>
        <span>
          <small>{t("Executable")}</small>
          <strong>{skillStats.executable}</strong>
        </span>
        <span>
          <small>{t("Blocked")}</small>
          <strong>{skillStats.blocked}</strong>
        </span>
        <span>
          <small>{t("Bindable")}</small>
          <strong>{skillStats.available}</strong>
        </span>
      </div>

      <div className="teammate-skill-toolbar">
        <label className="teammate-skill-search">
          <Search size={14} />
          <input value={skillSearchQuery} onChange={(event) => onSkillSearchQueryChange(event.target.value)} placeholder={t("Search Skill or blocked reason")} />
        </label>
        <div className="teammate-skill-filter-tabs" role="tablist" aria-label={t("Skill filters")}>
          {(["all", "bound", "executable", "blocked", "available"] as const).map((filter) => (
            <button key={filter} type="button" className={skillFilter === filter ? "active" : ""} onClick={() => onSkillFilterChange(filter)}>
              {teammateSkillFilterLabel(filter, t)}
            </button>
          ))}
        </div>
        <div className="teammate-skill-bind-controls">
          <input
            aria-label={t("Skill id")}
            value={manualSkillInput}
            onChange={(event) => onManualSkillInputChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void onAddManualSkillBinding();
              }
            }}
            placeholder={t("Skill id")}
          />
          <button className="secondary-button compact-button" type="button" onClick={() => void onAddManualSkillBinding()} disabled={savingSkills}>
            <Plus size={14} />
            {t("Bind")}
          </button>
          <button className="secondary-button compact-button" type="button" onClick={() => onSkillImportOpenChange(!skillImportOpen)}>
            <Upload size={14} />
            {t("Import")}
          </button>
        </div>
      </div>

      {skillImportOpen ? (
        <div className="teammate-import-panel teammate-skill-import-panel">
          <div className="panel-title split">
            <span>
              <Upload size={15} />
              <h3>{t("Import skill draft")}</h3>
            </span>
            <span>
              {skillImportDraft ? <small>{t("{count} parsed", { count: skillImportDraft.definitions.length })}</small> : null}
              <button className="ghost-button compact-button" type="button" onClick={() => onSkillImportOpenChange(false)}>
                {t("Close")}
              </button>
            </span>
          </div>
          <div className="teammate-task-create-grid">
            <label className="field">
              <span>{t("Source")}</span>
              <select value={skillImportForm.source} onChange={(event) => onSkillImportFormChange({ ...skillImportForm, source: event.target.value as SkillPackSource })}>
                <option value="custom">{t("custom")}</option>
                <option value="skill-directory">{t("skill-directory")}</option>
                <option value="agents-md">{t("agents-md")}</option>
                <option value="workspace">{t("workspace")}</option>
              </select>
            </label>
            <label className="field">
              <span>{t("Draft name")}</span>
              <input value={skillImportForm.name} onChange={(event) => onSkillImportFormChange({ ...skillImportForm, name: event.target.value })} />
            </label>
            <label className="field">
              <span>{t("Source path")}</span>
              <input value={skillImportForm.sourcePath} onChange={(event) => onSkillImportFormChange({ ...skillImportForm, sourcePath: event.target.value })} placeholder="SKILL.md" />
            </label>
            <label className="field wide">
              <span>{t("Skill content")}</span>
              <textarea rows={5} value={skillImportForm.content} onChange={(event) => onSkillImportFormChange({ ...skillImportForm, content: event.target.value })} />
            </label>
          </div>
          {skillImportDraft ? (
            <div className="teammate-import-preview">
              {skillImportDraft.definitions.map((item) => (
                <article key={item.definition.id} className="teammate-data-row">
                  <span>
                    <strong>{item.definition.name}</strong>
                    <small>
                      {item.definition.id} · {item.definition.summary}
                    </small>
                  </span>
                  <StatusBadge status={item.warnings?.some((warning) => warning.severity === "error") ? "blocked" : "draft"} />
                </article>
              ))}
              {[...skillImportDraft.warnings, ...skillImportDraft.definitions.flatMap((item) => item.warnings ?? [])].map((warning, index) => (
                <small key={`${warning.code}-${index}`} className={`teammate-warning ${warning.severity}`}>
                  {t(warning.code)}: {warning.message}
                </small>
              ))}
            </div>
          ) : null}
          <div className="teammate-settings-actions">
            <button className="secondary-button" type="button" onClick={() => void onPreviewSkillImport()} disabled={importingSkill || !skillImportForm.content.trim()}>
              {importingSkill ? <Loader2 className="spin" size={15} /> : <Search size={15} />}
              {t("Preview draft")}
            </button>
            <button
              className="primary-button"
              type="button"
              onClick={() => void onPublishSkillDraft()}
              disabled={
                importingSkill ||
                !skillImportDraft ||
                skillImportDraft.warnings.some((warning) => warning.severity === "error") ||
                skillImportDraft.definitions.some((item) => item.warnings?.some((warning) => warning.severity === "error"))
              }
            >
              <CheckCircle2 size={15} />
              {t("Publish to registry")}
            </button>
          </div>
        </div>
      ) : null}

      {skillRows.length === 0 ? (
        <div className="client-empty-state teammate-empty">
          <Brain size={18} />
          <span>{t("No skills bound to this teammate")}</span>
        </div>
      ) : (
        <div className="teammate-skill-workbench-grid">
          <div className="teammate-skill-table-wrap">
            <table className="teammate-skill-table">
              <thead>
                <tr>
                  <th>{t("Status")}</th>
                  <th>{t("Skill")}</th>
                  <th>{t("Source")}</th>
                  <th>{t("Stage")}</th>
                  <th>{t("Required tools")}</th>
                  <th>{t("Approval")}</th>
                  <th>{t("Blocked reasons")}</th>
                  <th>{t("Actions")}</th>
                </tr>
              </thead>
              <tbody>
                {skillTableRows.length === 0 ? (
                  <tr>
                    <td colSpan={8}>
                      <div className="client-empty-state teammate-empty compact">
                        <span>{t("No skills match filters")}</span>
                      </div>
                    </td>
                  </tr>
                ) : (
                  skillTableRows.map(({ id, skill, binding, effectiveSkill }) => {
                    const enabled = Boolean(binding?.enabled);
                    const sourceLabel = binding
                      ? binding.source === "template"
                        ? t("Default skill")
                        : t("User skill")
                      : registryEntryBySkillId.get(id)?.source === "builtin"
                        ? t("Available skill")
                        : t("Registry skill");
                    const canDelete = binding?.source === "user";
                    const canArchive = !binding && registryEntryBySkillId.has(id) && registryEntryBySkillId.get(id)?.source !== "builtin";
                    const blockedLabel = effectiveSkill?.blockedReasons.map((reason) => t(reason.code)).join(", ");
                    const state = skillExecutionState(binding, effectiveSkill, t);
                    return (
                      <tr key={id} className={selectedSkillRow?.id === id ? "selected" : ""}>
                        <td>
                          <SkillStatePill label={state.label} tone={state.tone} />
                        </td>
                        <td>
                          <button className="teammate-skill-name-button" type="button" onClick={() => onSelectSkill(id)}>
                            <strong>{skill ? t(skill.name) : id}</strong>
                            <small>{skill?.id ?? id}</small>
                          </button>
                        </td>
                        <td>{sourceLabel}</td>
                        <td>
                          <span className={`phase-token ${skill?.workflowPhase ?? "operate"}`}>{skill ? workflowPhaseLabel(skill.workflowPhase, t) : t("Custom")}</span>
                        </td>
                        <td>
                          <TeammateSkillTokenList values={skill?.requiredTools ?? []} emptyLabel={t("No tools")} />
                        </td>
                        <td>{skill ? approvalProfileText(skill.approvalProfile, t) : "-"}</td>
                        <td>{blockedLabel || (enabled ? t("Ready") : t("Not bound"))}</td>
                        <td>
                          <span className="teammate-skill-row-actions">
                            <button className="secondary-button compact-button" type="button" onClick={() => onSelectSkill(id)}>
                              <Search size={14} />
                              {t("Details")}
                            </button>
                            <button className="secondary-button compact-button" type="button" onClick={() => void onToggleSkillBinding(id)} disabled={savingSkills}>
                              {enabled ? <X size={14} /> : <Plus size={14} />}
                              {binding ? (enabled ? t("Disable") : t("Enable")) : t("Bind")}
                            </button>
                            {canDelete ? (
                              <button className="secondary-button danger compact-button" type="button" onClick={() => void onDeleteUserSkillBinding(id)} disabled={savingSkills}>
                                <Trash2 size={14} />
                                {t("Delete")}
                              </button>
                            ) : null}
                            {canArchive ? (
                              <button className="secondary-button danger compact-button" type="button" onClick={() => void onArchiveCustomSkill(id)} disabled={savingSkills}>
                                <Trash2 size={14} />
                                {t("Archive")}
                              </button>
                            ) : null}
                          </span>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          <aside className="teammate-skill-inspector" aria-label={t("Skill detail")}>
            {selectedSkillRow ? (
              <>
                <div className="teammate-skill-inspector-head">
                  <span>
                    <Brain size={15} />
                    <strong>{selectedSkillRow.skill ? t(selectedSkillRow.skill.name) : selectedSkillRow.id}</strong>
                  </span>
                  <SkillStatePill
                    label={skillExecutionState(selectedSkillRow.binding, selectedSkillRow.effectiveSkill, t).label}
                    tone={skillExecutionState(selectedSkillRow.binding, selectedSkillRow.effectiveSkill, t).tone}
                  />
                </div>
                <SkillInspectorSection title={t("Description")}>
                  <p>{selectedSkillRow.skill ? t(selectedSkillRow.skill.summary) : t("Custom skill binding")}</p>
                </SkillInspectorSection>
                <SkillInspectorSection title={t("Blocked reasons")}>
                  {selectedSkillRow.effectiveSkill?.blockedReasons.length ? (
                    <div className="teammate-skill-reason-list">
                      {selectedSkillRow.effectiveSkill.blockedReasons.map((reason) => (
                        <span key={reason.code}>
                          <strong>{t(reason.code)}</strong>
                          <small>{reason.missing?.length ? reason.missing.join(", ") : reason.message}</small>
                        </span>
                      ))}
                    </div>
                  ) : (
                    <p>{selectedSkillRow.binding?.enabled ? t("No blocked reasons") : t("Bind this skill to evaluate executability.")}</p>
                  )}
                </SkillInspectorSection>
                <SkillInspectorSection title={t("Prompt fragments")}>
                  {selectedSkillRow.skill?.promptFragments.length ? <pre>{selectedSkillRow.skill.promptFragments.slice(0, 3).join("\n\n")}</pre> : <p>{t("No prompt fragments")}</p>}
                </SkillInspectorSection>
                <SkillInspectorSection title={t("Required tools")}>
                  <TeammateSkillTokenList values={selectedSkillRow.skill?.requiredTools ?? []} emptyLabel={t("No tools")} />
                </SkillInspectorSection>
                <SkillInspectorSection title={t("Provider capability")}>
                  <TeammateSkillTokenList values={selectedSkillRow.skill?.requiredProviderCapabilities ?? []} emptyLabel={t("No provider capability required")} />
                </SkillInspectorSection>
                <SkillInspectorSection title={t("Approval profile")}>
                  <p>{selectedSkillRow.skill ? approvalProfileText(selectedSkillRow.skill.approvalProfile, t) : "-"}</p>
                </SkillInspectorSection>
                <div className="teammate-skill-inspector-actions">
                  <button className="primary-button compact-button" type="button" onClick={() => void onToggleSkillBinding(selectedSkillRow.id)} disabled={savingSkills}>
                    {selectedSkillRow.binding?.enabled ? <X size={14} /> : <Plus size={14} />}
                    {selectedSkillRow.binding ? (selectedSkillRow.binding.enabled ? t("Disable skill") : t("Enable skill")) : t("Bind to teammate")}
                  </button>
                  {selectedSkillRow.binding?.source === "user" ? (
                    <button className="secondary-button danger compact-button" type="button" onClick={() => void onDeleteUserSkillBinding(selectedSkillRow.id)} disabled={savingSkills}>
                      <Trash2 size={14} />
                      {t("Delete skill")}
                    </button>
                  ) : null}
                </div>
              </>
            ) : (
              <div className="client-empty-state teammate-empty compact">
                <span>{t("Select a skill to inspect")}</span>
              </div>
            )}
          </aside>
        </div>
      )}
    </section>
  );
}

function SkillStatePill({
  label,
  tone,
}: {
  readonly label: string;
  readonly tone: "executable" | "blocked" | "disabled" | "available";
}): JSX.Element {
  return <span className={`teammate-skill-state ${tone}`}>{label}</span>;
}

function TeammateSkillTokenList({ values, emptyLabel }: { readonly values: readonly string[]; readonly emptyLabel: string }): JSX.Element {
  if (values.length === 0) {
    return <span className="teammate-skill-empty-token">{emptyLabel}</span>;
  }
  return (
    <span className="teammate-skill-token-list">
      {values.slice(0, 4).map((value) => <code key={value}>{value}</code>)}
      {values.length > 4 ? <small>+{values.length - 4}</small> : null}
    </span>
  );
}

function SkillInspectorSection({ title, children }: { readonly title: string; readonly children: ReactNode }): JSX.Element {
  return (
    <section className="teammate-skill-inspector-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}
