import { useEffect, useMemo, useState } from "react";
import { Plus, RefreshCw, Search, Upload } from "lucide-react";
import type {
  SkillOptimizationPreview,
  SkillRegistryEntry,
  SkillSourceArtifact,
  SkillSourceSnapshot,
} from "../../types.js";
import { SkillCompactInspector } from "./SkillCompactInspector.js";
import { SkillLibraryTable } from "./SkillLibraryTable.js";
import type {
  SettingsTranslator,
  TeammateSkillBindingSummary,
} from "./skill-library-utils.js";
import {
  filterBuiltinSkillEntries,
  filterUserSkillEntries,
  partitionSkillRegistry,
  type BuiltinSkillBindingFilter,
  type UserSkillSortMode,
  type UserSkillStatusFilter,
} from "./skill-library-view-models.js";

export function SkillLibraryRegistrySection({
  mode,
  skills,
  loading,
  saving,
  selectedSkillId,
  bindingSummaries,
  sourceSnapshotBySkillId,
  sourceHistoryBySkillId,
  artifacts,
  optimizationPreview,
  optimizationPreviewLoading,
  cwd,
  onSelectSkill,
  onArchiveSkill,
  onPreviewOptimization,
  onArchiveSource,
  onRollbackSource,
  onImport,
  onNewDraft,
  onRefresh,
  t,
}: {
  readonly mode: "user" | "builtin";
  readonly skills: readonly SkillRegistryEntry[];
  readonly loading: boolean;
  readonly saving: boolean;
  readonly selectedSkillId: string | undefined;
  readonly bindingSummaries: readonly TeammateSkillBindingSummary[];
  readonly sourceSnapshotBySkillId: ReadonlyMap<string, SkillSourceSnapshot>;
  readonly sourceHistoryBySkillId: ReadonlyMap<string, readonly SkillSourceSnapshot[]>;
  readonly artifacts: readonly SkillSourceArtifact[];
  readonly optimizationPreview: SkillOptimizationPreview | undefined;
  readonly optimizationPreviewLoading: boolean;
  readonly cwd: string;
  readonly onSelectSkill: (skillId: string) => void;
  readonly onArchiveSkill: (skillId: string) => void;
  readonly onPreviewOptimization: () => void;
  readonly onArchiveSource: (skillId: string) => void;
  readonly onRollbackSource: (snapshotId: string) => void;
  readonly onImport: () => void;
  readonly onNewDraft: () => void;
  readonly onRefresh: () => void;
  readonly t: SettingsTranslator;
}): JSX.Element {
  const [userSearchQuery, setUserSearchQuery] = useState("");
  const [builtinSearchQuery, setBuiltinSearchQuery] = useState("");
  const [userFilter, setUserFilter] = useState<UserSkillStatusFilter>("current");
  const [builtinFilter, setBuiltinFilter] = useState<BuiltinSkillBindingFilter>("all");
  const [userSortMode, setUserSortMode] = useState<UserSkillSortMode>("updated");

  const partition = useMemo(() => partitionSkillRegistry(skills), [skills]);
  const boundSkillIds = useMemo(() => new Set(bindingSummaries.flatMap((summary) =>
    summary.bindings.filter((binding) => binding.enabled).map((binding) => binding.skillId)
  )), [bindingSummaries]);

  const entries = useMemo(() => mode === "user"
    ? filterUserSkillEntries(skills, {
      query: userSearchQuery,
      status: userFilter,
      sortMode: userSortMode,
      sourceSnapshotBySkillId,
    })
    : filterBuiltinSkillEntries(skills, {
      query: builtinSearchQuery,
      binding: builtinFilter,
      boundSkillIds,
      sourceSnapshotBySkillId,
    }), [
    boundSkillIds,
    builtinFilter,
    builtinSearchQuery,
    mode,
    skills,
    sourceSnapshotBySkillId,
    userFilter,
    userSearchQuery,
    userSortMode,
  ]);

  const visibleSelectedSkill = selectedSkillId
    ? entries.find((entry) => entry.id === selectedSkillId)
    : undefined;

  useEffect(() => {
    if (selectedSkillId && !visibleSelectedSkill) {
      onSelectSkill("");
    }
  }, [onSelectSkill, selectedSkillId, visibleSelectedSkill]);

  const baseEntries = mode === "user" ? partition.user : partition.builtin;
  if (baseEntries.length === 0) {
    return (
      <div className="settings-skill-ownership-empty">
        <Search size={18} />
        <strong>{t(mode === "user" ? "No user skills yet" : "No built-in skills available")}</strong>
        <small>{t(mode === "user"
          ? "Import a skill or create a draft to start building your workspace library."
          : "Refresh the library to load Ling built-in skills.")}</small>
        <span>
          {mode === "user" ? (
            <>
              <button className="primary-button compact-button" type="button" onClick={onImport}>
                <Upload size={14} />
                {t("Import skill")}
              </button>
              <button className="secondary-button compact-button" type="button" onClick={onNewDraft}>
                <Plus size={14} />
                {t("New draft")}
              </button>
            </>
          ) : null}
          <button className="secondary-button compact-button" type="button" onClick={onRefresh} disabled={loading}>
            <RefreshCw size={14} className={loading ? "spin" : undefined} />
            {t("Refresh")}
          </button>
        </span>
      </div>
    );
  }

  const boundBuiltinCount = partition.builtin.filter((entry) => boundSkillIds.has(entry.id)).length;
  const publishedUserCount = partition.user.filter((entry) => entry.reviewStatus === "published").length;
  const draftUserCount = partition.user.filter((entry) => entry.reviewStatus === "draft").length;
  const activeSearchQuery = mode === "user" ? userSearchQuery : builtinSearchQuery;

  return (
    <>
      <div className="settings-skill-ownership-meta" aria-label={t(mode === "user" ? "My skills summary" : "Built-in skills summary")}>
        {mode === "user" ? (
          <>
            <span><small>{t("Current")}</small><strong>{partition.user.length}</strong></span>
            <span><small>{t("Published")}</small><strong>{publishedUserCount}</strong></span>
            <span><small>{t("Draft")}</small><strong>{draftUserCount}</strong></span>
          </>
        ) : (
          <>
            <span><small>{t("Built-in skills")}</small><strong>{partition.builtin.length}</strong></span>
            <span><small>{t("Bound")}</small><strong>{boundBuiltinCount}</strong></span>
            <span><small>{t("Unbound")}</small><strong>{partition.builtin.length - boundBuiltinCount}</strong></span>
          </>
        )}
      </div>

      <div className={`settings-skill-library-toolbar settings-skill-library-toolbar--${mode}`}>
        <label className="settings-skill-search">
          <Search size={15} />
          <input
            value={activeSearchQuery}
            onChange={(event) => mode === "user" ? setUserSearchQuery(event.target.value) : setBuiltinSearchQuery(event.target.value)}
            placeholder={t("Search Skill, source, or tool")}
          />
        </label>
        <div className="settings-skill-filters" role="tablist" aria-label={t(mode === "user" ? "My skill filters" : "Built-in skill filters")}>
          {mode === "user" ? (["current", "published", "draft"] as const).map((item) => (
            <button key={item} type="button" className={userFilter === item ? "active" : ""} onClick={() => setUserFilter(item)}>
              {t(userFilterLabel(item))}
            </button>
          )) : (["all", "bound", "unbound"] as const).map((item) => (
            <button key={item} type="button" className={builtinFilter === item ? "active" : ""} onClick={() => setBuiltinFilter(item)}>
              {t(builtinFilterLabel(item))}
            </button>
          ))}
        </div>
        {mode === "user" ? (
          <select value={userSortMode} onChange={(event) => setUserSortMode(event.target.value === "name" ? "name" : "updated")} aria-label={t("Sort skills")}>
            <option value="updated">{t("Sort by updated")}</option>
            <option value="name">{t("Sort by name")}</option>
          </select>
        ) : null}
      </div>

      <div className="settings-skill-library-body">
        <SkillLibraryTable
          variant={mode}
          entries={entries}
          loading={loading}
          saving={saving}
          selectedSkillId={visibleSelectedSkill?.id}
          bindingSummaries={bindingSummaries}
          sourceSnapshotBySkillId={sourceSnapshotBySkillId}
          onSelectSkill={onSelectSkill}
          onArchiveSkill={onArchiveSkill}
          t={t}
        />

        <aside className="settings-skill-inspector" aria-label={t("Skill detail")}>
          {visibleSelectedSkill ? (
            <SkillCompactInspector
              skill={visibleSelectedSkill}
              readOnly={mode === "builtin"}
              sourceSnapshot={sourceSnapshotBySkillId.get(visibleSelectedSkill.id)}
              sourceHistory={sourceHistoryBySkillId.get(visibleSelectedSkill.id) ?? []}
              artifacts={artifacts}
              optimizationPreview={optimizationPreview}
              optimizationPreviewLoading={optimizationPreviewLoading}
              cwd={cwd}
              saving={saving}
              boundTeammates={boundSkillNames(visibleSelectedSkill.id, bindingSummaries)}
              onPreviewOptimization={onPreviewOptimization}
              onArchiveSource={() => onArchiveSource(visibleSelectedSkill.id)}
              onRollbackSource={onRollbackSource}
              t={t}
            />
          ) : (
            <div className="compact-empty settings-skill-search-empty">
              <Search size={16} />
              <span>{t("No skill selected")}</span>
            </div>
          )}
        </aside>
      </div>
    </>
  );
}

function boundSkillNames(skillId: string, summaries: readonly TeammateSkillBindingSummary[]): readonly string[] {
  return summaries
    .filter((summary) => summary.bindings.some((binding) => binding.skillId === skillId && binding.enabled))
    .map((summary) => summary.teammate.displayName);
}

function userFilterLabel(filter: UserSkillStatusFilter): string {
  if (filter === "current") return "Current";
  if (filter === "published") return "Published";
  return "Draft";
}

function builtinFilterLabel(filter: BuiltinSkillBindingFilter): string {
  if (filter === "bound") return "Bound";
  if (filter === "unbound") return "Unbound";
  return "All";
}
