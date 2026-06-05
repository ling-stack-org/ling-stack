import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Archive,
  BookOpen,
  CheckCircle2,
  Eye,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Upload,
} from "lucide-react";
import {
  archiveSkill,
  createSkillImportDraft,
  listAiTeammates,
  listSkills,
  listTeammateSkills,
  publishSkillImportDraft,
} from "../../api.js";
import { useI18n } from "../../i18n.js";
import { formatDateTime } from "../../lib/formatting.js";
import type {
  AiTeammate,
  SkillImportDraft,
  SkillPackSource,
  SkillRegistryEntry,
  TeammateSkillBinding,
} from "../../types.js";
import { approvalProfileText, workflowPhaseLabel } from "../teammates/helpers.js";

type SkillLibraryFilter = "all" | "builtin" | "custom" | "draft" | "archived";

interface SkillImportForm {
  readonly name: string;
  readonly sourcePath: string;
  readonly source: SkillPackSource;
  readonly content: string;
}

interface TeammateSkillBindingSummary {
  readonly teammate: AiTeammate;
  readonly bindings: readonly TeammateSkillBinding[];
}

const initialSkillImportForm: SkillImportForm = {
  name: "",
  sourcePath: "",
  source: "custom",
  content: "",
};

export function SkillLibrarySettingsPanel({ cwd }: { readonly cwd: string }): JSX.Element {
  const { t } = useI18n();
  const [skills, setSkills] = useState<readonly SkillRegistryEntry[]>([]);
  const [bindingSummaries, setBindingSummaries] = useState<readonly TeammateSkillBindingSummary[]>([]);
  const [selectedSkillId, setSelectedSkillId] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [filter, setFilter] = useState<SkillLibraryFilter>("all");
  const [sortMode, setSortMode] = useState<"updated" | "name">("updated");
  const [importOpen, setImportOpen] = useState(false);
  const [importForm, setImportForm] = useState<SkillImportForm>(initialSkillImportForm);
  const [importDraft, setImportDraft] = useState<SkillImportDraft | undefined>();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    void refresh();
  }, [cwd]);

  const stats = useMemo(() => {
    const bindable = skills.filter((entry) => entry.reviewStatus === "builtin" || entry.reviewStatus === "published").length;
    const draft = skills.filter((entry) => entry.reviewStatus === "draft").length;
    const blocked = skills.filter((entry) => entry.reviewStatus === "disabled").length;
    return { total: skills.length, bindable, draft, blocked };
  }, [skills]);

  const filteredSkills = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    const rows = skills.filter((entry) => {
      if (filter === "builtin" && entry.source !== "builtin" && entry.reviewStatus !== "builtin") {
        return false;
      }
      if (filter === "custom" && (entry.source === "builtin" || entry.reviewStatus === "builtin")) {
        return false;
      }
      if (filter === "draft" && entry.reviewStatus !== "draft") {
        return false;
      }
      if (filter === "archived" && entry.reviewStatus !== "archived") {
        return false;
      }
      if (!query) {
        return true;
      }
      const haystack = [
        entry.id,
        entry.definition.name,
        entry.definition.summary,
        entry.source,
        entry.sourcePath ?? "",
        entry.definition.workflowPhase,
        ...entry.definition.requiredTools,
        ...entry.definition.requiredProviderCapabilities,
      ].join(" ").toLowerCase();
      return haystack.includes(query);
    });
    return [...rows].sort((left, right) => {
      if (sortMode === "name") {
        return left.definition.name.localeCompare(right.definition.name);
      }
      return right.updatedAt.localeCompare(left.updatedAt);
    });
  }, [filter, searchQuery, skills, sortMode]);

  const selectedSkill = useMemo(() => {
    return skills.find((entry) => entry.id === selectedSkillId) ?? filteredSkills[0] ?? skills[0];
  }, [filteredSkills, selectedSkillId, skills]);

  useEffect(() => {
    if (!selectedSkill && selectedSkillId) {
      setSelectedSkillId("");
      return;
    }
    if (selectedSkill && selectedSkill.id !== selectedSkillId) {
      setSelectedSkillId(selectedSkill.id);
    }
  }, [selectedSkill, selectedSkillId]);

  async function refresh(): Promise<void> {
    const workspaceCwd = cwd.trim();
    if (!workspaceCwd) {
      setError(t("Workspace path is required."));
      return;
    }
    setLoading(true);
    try {
      setError("");
      const [skillsResponse, teammatesResponse] = await Promise.all([
        listSkills(workspaceCwd),
        listAiTeammates(workspaceCwd),
      ]);
      const visibleTeammates = teammatesResponse.teammates.filter((teammate) => teammate.status !== "disabled" && !teammate.hidden);
      const teammateSkillResponses = await Promise.all(
        visibleTeammates.map(async (teammate) => ({
          teammate,
          bindings: (await listTeammateSkills(workspaceCwd, teammate.id)).bindings,
        })),
      );
      setSkills(skillsResponse.skills);
      setBindingSummaries(teammateSkillResponses);
      setMessage(t("Skill library refreshed"));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }

  async function previewImportDraft(): Promise<void> {
    if (!importForm.content.trim() || saving) {
      setMessage(t("Paste skill content first"));
      return;
    }
    setSaving(true);
    try {
      setError("");
      setMessage("");
      const response = await createSkillImportDraft(cwd.trim(), {
        content: importForm.content,
        source: importForm.source,
        sourcePath: importForm.sourcePath.trim() || undefined,
        name: importForm.name.trim() || undefined,
      });
      setImportDraft(response.draft);
      setMessage(t("Draft ready"));
    } catch (draftError) {
      setError(draftError instanceof Error ? draftError.message : String(draftError));
    } finally {
      setSaving(false);
    }
  }

  async function publishImportDraft(): Promise<void> {
    if (!importDraft || saving) {
      return;
    }
    setSaving(true);
    try {
      setError("");
      const response = await publishSkillImportDraft(cwd.trim(), importDraft.id);
      setImportDraft(undefined);
      setImportForm(initialSkillImportForm);
      setImportOpen(false);
      await refresh();
      setMessage(t("Published {count} skills", { count: response.skills.length }));
    } catch (publishError) {
      setError(publishError instanceof Error ? publishError.message : String(publishError));
    } finally {
      setSaving(false);
    }
  }

  async function archiveRegistrySkill(skillId: string): Promise<void> {
    if (saving) {
      return;
    }
    setSaving(true);
    try {
      setError("");
      await archiveSkill(cwd.trim(), skillId);
      await refresh();
      setMessage(t("Skill archived"));
    } catch (archiveError) {
      setError(archiveError instanceof Error ? archiveError.message : String(archiveError));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="settings-skill-library" aria-labelledby="settings-skill-library-title">
      <header className="settings-skill-library-head">
        <div>
          <h2 id="settings-skill-library-title">{t("Skill Library")}</h2>
          <p>{t("Workspace Skill Library manages Skill definitions and teammate binding visibility.")}</p>
        </div>
        <div className="settings-skill-library-actions">
          <button className="primary-button compact-button" type="button" onClick={() => setImportOpen(true)}>
            <Upload size={15} />
            {t("Import skill")}
          </button>
          <button
            className="secondary-button compact-button"
            type="button"
            onClick={() => {
              setImportOpen(true);
              setImportDraft(undefined);
              setImportForm(initialSkillImportForm);
            }}
          >
            <Plus size={15} />
            {t("New draft")}
          </button>
          <button className="icon-button" type="button" onClick={() => void refresh()} disabled={loading} aria-label={t("Refresh")}>
            <RefreshCw size={15} className={loading ? "spin" : undefined} />
          </button>
        </div>
      </header>

      {error ? <div className="inline-error">{error}</div> : null}

      <div className="settings-skill-library-stats" aria-label={t("Skill library stats")}>
        <span><small>{t("Total skills")}</small><strong>{stats.total}</strong></span>
        <span><small>{t("Bindable")}</small><strong>{stats.bindable}</strong></span>
        <span><small>{t("Drafts")}</small><strong>{stats.draft}</strong></span>
        <span><small>{t("Blocked")}</small><strong>{stats.blocked}</strong></span>
      </div>

      <div className="settings-skill-library-toolbar">
        <label className="settings-skill-search">
          <Search size={15} />
          <input value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder={t("Search Skill, source, or tool")} />
        </label>
        <div className="settings-skill-filters" role="tablist" aria-label={t("Skill filters")}>
          {(["all", "builtin", "custom", "draft", "archived"] as const).map((item) => (
            <button key={item} type="button" className={filter === item ? "active" : ""} onClick={() => setFilter(item)}>
              {skillLibraryFilterLabel(item, t)}
            </button>
          ))}
        </div>
        <select value={sortMode} onChange={(event) => setSortMode(event.target.value === "name" ? "name" : "updated")} aria-label={t("Sort skills")}>
          <option value="updated">{t("Sort by updated")}</option>
          <option value="name">{t("Sort by name")}</option>
        </select>
      </div>

      {importOpen ? (
        <div className="settings-skill-import-panel">
          <div className="panel-title split">
            <span>
              <Upload size={15} />
              <h3>{t("Import skill draft")}</h3>
            </span>
            <button className="ghost-button compact-button" type="button" onClick={() => setImportOpen(false)}>
              {t("Close")}
            </button>
          </div>
          <div className="settings-skill-import-grid">
            <label className="field">
              <span>{t("Source")}</span>
              <select value={importForm.source} onChange={(event) => setImportForm({ ...importForm, source: event.target.value as SkillPackSource })}>
                <option value="custom">{t("custom")}</option>
                <option value="skill-directory">{t("skill-directory")}</option>
                <option value="agents-md">{t("agents-md")}</option>
                <option value="workspace">{t("workspace")}</option>
              </select>
            </label>
            <label className="field">
              <span>{t("Draft name")}</span>
              <input value={importForm.name} onChange={(event) => setImportForm({ ...importForm, name: event.target.value })} />
            </label>
            <label className="field">
              <span>{t("Source path")}</span>
              <input value={importForm.sourcePath} onChange={(event) => setImportForm({ ...importForm, sourcePath: event.target.value })} placeholder="SKILL.md / AGENTS.md" />
            </label>
            <label className="field wide">
              <span>{t("Skill content")}</span>
              <textarea rows={5} value={importForm.content} onChange={(event) => setImportForm({ ...importForm, content: event.target.value })} />
            </label>
          </div>
          {importDraft ? (
            <div className="settings-skill-import-preview">
              {importDraft.definitions.map((item) => (
                <article key={item.definition.id} className="settings-skill-draft-row">
                  <span>
                    <strong>{item.definition.name}</strong>
                    <small>{item.definition.id} · {item.definition.summary}</small>
                  </span>
                  <SkillStatePill label={item.warnings?.some((warning) => warning.severity === "error") ? t("Blocked") : t("Draft")} tone={item.warnings?.some((warning) => warning.severity === "error") ? "blocked" : "draft"} />
                </article>
              ))}
              {[...importDraft.warnings, ...importDraft.definitions.flatMap((item) => item.warnings ?? [])].map((warning, index) => (
                <small key={`${warning.code}-${index}`} className={`teammate-warning ${warning.severity}`}>{t(warning.code)}: {warning.message}</small>
              ))}
            </div>
          ) : null}
          <div className="settings-skill-import-actions">
            <button className="secondary-button compact-button" type="button" onClick={() => void previewImportDraft()} disabled={saving || !importForm.content.trim()}>
              {saving ? <Loader2 className="spin" size={15} /> : <Search size={15} />}
              {t("Preview draft")}
            </button>
            <button
              className="primary-button compact-button"
              type="button"
              onClick={() => void publishImportDraft()}
              disabled={saving || !importDraft || importDraft.warnings.some((warning) => warning.severity === "error") || importDraft.definitions.some((item) => item.warnings?.some((warning) => warning.severity === "error"))}
            >
              <CheckCircle2 size={15} />
              {t("Publish to registry")}
            </button>
          </div>
        </div>
      ) : null}

      <div className="settings-skill-library-body">
        <div className="settings-skill-table-wrap">
          <table className="settings-skill-table">
            <thead>
              <tr>
                <th>{t("Status")}</th>
                <th>{t("Skill")}</th>
                <th>{t("Source")}</th>
                <th>{t("Stage")}</th>
                <th>{t("Required tools")}</th>
                <th>{t("Approval")}</th>
                <th>{t("Bound teammates")}</th>
                <th>{t("Actions")}</th>
              </tr>
            </thead>
            <tbody>
              {filteredSkills.length === 0 ? (
                <tr>
                  <td colSpan={8}>
                    <div className="compact-empty">{loading ? t("Loading skills...") : t("No skills match these filters")}</div>
                  </td>
                </tr>
              ) : filteredSkills.map((entry) => {
                const boundTeammates = boundTeammateNames(entry.id, bindingSummaries);
                const state = skillRegistryState(entry, t);
                const selected = selectedSkill?.id === entry.id;
                const canArchive = entry.source !== "builtin" && entry.reviewStatus !== "archived";
                return (
                  <tr key={entry.id} className={selected ? "selected" : ""}>
                    <td><SkillStatePill label={state.label} tone={state.tone} /></td>
                    <td>
                      <button className="settings-skill-name-button" type="button" onClick={() => setSelectedSkillId(entry.id)}>
                        <strong>{entry.definition.name}</strong>
                        <small>{entry.id}</small>
                      </button>
                    </td>
                    <td>{skillSourceLabel(entry.source, t)}</td>
                    <td><span className={`phase-token ${entry.definition.workflowPhase}`}>{workflowPhaseLabel(entry.definition.workflowPhase, t)}</span></td>
                    <td><SkillTokenList values={entry.definition.requiredTools} emptyLabel={t("No tools")} /></td>
                    <td>{approvalProfileText(entry.definition.approvalProfile, t)}</td>
                    <td>{boundTeammates.length > 0 ? boundTeammates.join(", ") : t("Unbound")}</td>
                    <td>
                      <span className="settings-skill-row-actions">
                        <button className="secondary-button compact-button" type="button" onClick={() => setSelectedSkillId(entry.id)}>
                          <Eye size={14} />
                          {t("Details")}
                        </button>
                        {canArchive ? (
                          <button className="secondary-button danger compact-button" type="button" onClick={() => void archiveRegistrySkill(entry.id)} disabled={saving}>
                            <Archive size={14} />
                            {t("Archive")}
                          </button>
                        ) : null}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <aside className="settings-skill-inspector" aria-label={t("Skill detail")}>
          {selectedSkill ? (
            <>
              <div className="settings-skill-inspector-head">
                <span>
                  <BookOpen size={15} />
                  <strong>{selectedSkill.definition.name}</strong>
                </span>
                <SkillStatePill label={skillRegistryState(selectedSkill, t).label} tone={skillRegistryState(selectedSkill, t).tone} />
              </div>
              <SkillInspectorSection title={t("Description")}>
                <p>{selectedSkill.definition.summary}</p>
              </SkillInspectorSection>
              <SkillInspectorSection title={t("Prompt fragments")}>
                {selectedSkill.definition.promptFragments.length > 0 ? (
                  <pre>{selectedSkill.definition.promptFragments.slice(0, 3).join("\n\n")}</pre>
                ) : (
                  <p>{t("No prompt fragments")}</p>
                )}
              </SkillInspectorSection>
              <SkillInspectorSection title={t("Required tools")}>
                <SkillTokenList values={selectedSkill.definition.requiredTools} emptyLabel={t("No tools")} />
              </SkillInspectorSection>
              <SkillInspectorSection title={t("Approval profile")}>
                <p>{approvalProfileText(selectedSkill.definition.approvalProfile, t)}</p>
              </SkillInspectorSection>
              <SkillInspectorSection title={t("Provider capability")}>
                <SkillTokenList values={selectedSkill.definition.requiredProviderCapabilities} emptyLabel={t("No provider capability required")} />
              </SkillInspectorSection>
              <SkillInspectorSection title={t("Bound teammates")}>
                <SkillTokenList values={boundTeammateNames(selectedSkill.id, bindingSummaries)} emptyLabel={t("Unbound")} />
              </SkillInspectorSection>
              <small>{t("Updated {time}", { time: formatDateTime(selectedSkill.updatedAt) })}</small>
            </>
          ) : (
            <div className="compact-empty">{t("Select a skill to inspect")}</div>
          )}
        </aside>
      </div>

      <footer className="settings-skill-audit-note">
        {message ? <span>{message}</span> : null}
        <span>{t("Persona cannot grant tools, approvals, or secrets; Skill permissions are enforced by binding and policy checks.")}</span>
      </footer>
    </section>
  );
}

function SkillTokenList({ values, emptyLabel }: { readonly values: readonly string[]; readonly emptyLabel: string }): JSX.Element {
  if (values.length === 0) {
    return <span className="settings-skill-empty-token">{emptyLabel}</span>;
  }
  return (
    <span className="settings-skill-token-list">
      {values.slice(0, 4).map((value) => <code key={value}>{value}</code>)}
      {values.length > 4 ? <small>+{values.length - 4}</small> : null}
    </span>
  );
}

function SkillInspectorSection({ title, children }: { readonly title: string; readonly children: ReactNode }): JSX.Element {
  return (
    <section className="settings-skill-inspector-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function SkillStatePill({ label, tone }: { readonly label: string; readonly tone: "bindable" | "draft" | "blocked" | "archived" }): JSX.Element {
  return <span className={`settings-skill-state ${tone}`}>{label}</span>;
}

function skillRegistryState(entry: SkillRegistryEntry, t: (key: string, values?: Readonly<Record<string, string | number>>) => string): { readonly label: string; readonly tone: "bindable" | "draft" | "blocked" | "archived" } {
  if (entry.reviewStatus === "archived") {
    return { label: t("Archived"), tone: "archived" };
  }
  if (entry.reviewStatus === "draft") {
    return { label: t("Draft"), tone: "draft" };
  }
  if (entry.reviewStatus === "disabled") {
    return { label: t("Blocked"), tone: "blocked" };
  }
  return { label: t("Bindable"), tone: "bindable" };
}

function skillLibraryFilterLabel(filter: SkillLibraryFilter, t: (key: string) => string): string {
  if (filter === "builtin") {
    return t("Built-in");
  }
  if (filter === "custom") {
    return t("Custom");
  }
  if (filter === "draft") {
    return t("Draft");
  }
  if (filter === "archived") {
    return t("Archived");
  }
  return t("All");
}

function skillSourceLabel(source: SkillPackSource, t: (key: string) => string): string {
  if (source === "builtin") {
    return t("Built-in");
  }
  if (source === "agents-md") {
    return "AGENTS.md";
  }
  if (source === "skill-directory") {
    return t("skill-directory");
  }
  if (source === "workspace") {
    return t("Workspace");
  }
  if (source === "gstack") {
    return "gstack";
  }
  return t("Custom");
}

function boundTeammateNames(skillId: string, summaries: readonly TeammateSkillBindingSummary[]): readonly string[] {
  return summaries
    .filter((summary) => summary.bindings.some((binding) => binding.skillId === skillId && binding.enabled))
    .map((summary) => summary.teammate.displayName);
}
