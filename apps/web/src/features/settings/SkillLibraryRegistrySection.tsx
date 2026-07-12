import { useEffect, useMemo, useState } from "react";
import { BookOpen, Plus, Search, Upload, X } from "lucide-react";
import { RightDrawer } from "../../shared/conversation/index.js";
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
  onDeleteSkill,
  onPreviewOptimization,
  onArchiveSource,
  onRollbackSource,
  onImport,
  onNewDraft,
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
  readonly onDeleteSkill: (skill: SkillRegistryEntry) => void;
  readonly onPreviewOptimization: () => void;
  readonly onArchiveSource: (skillId: string) => void;
  readonly onRollbackSource: (snapshotId: string) => void;
  readonly onImport: () => void;
  readonly onNewDraft: () => void;
  readonly t: SettingsTranslator;
}): JSX.Element {
  const [userSearchQuery, setUserSearchQuery] = useState("");
  const [builtinSearchQuery, setBuiltinSearchQuery] = useState("");
  const [builtinFilter, setBuiltinFilter] = useState<BuiltinSkillBindingFilter>("all");
  const [userSortMode, setUserSortMode] = useState<UserSkillSortMode>("updated");

  const partition = useMemo(() => partitionSkillRegistry(skills), [skills]);
  const boundSkillIds = useMemo(() => new Set(bindingSummaries.flatMap((summary) =>
    summary.bindings.filter((binding) => binding.enabled).map((binding) => binding.skillId)
  )), [bindingSummaries]);

  const entries = useMemo(() => mode === "user"
    ? filterUserSkillEntries(skills, {
      query: userSearchQuery,
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

  useEffect(() => {
    if (!visibleSelectedSkill) {
      return undefined;
    }
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        onSelectSkill("");
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onSelectSkill, visibleSelectedSkill]);

  const baseEntries = mode === "user" ? partition.user : partition.builtin;
  if (baseEntries.length === 0) {
    return (
      <div className="settings-skill-ownership-empty">
        <Search size={18} />
        <strong>{t(mode === "user" ? "No user skills yet" : "No built-in skills available")}</strong>
        <small>{t(mode === "user"
          ? "Import a skill or create a draft to start building your workspace library."
          : "Built-in skills are loaded with the workspace library.")}</small>
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
        </span>
      </div>
    );
  }

  const boundBuiltinCount = partition.builtin.filter((entry) => boundSkillIds.has(entry.id)).length;
  const activeSearchQuery = mode === "user" ? userSearchQuery : builtinSearchQuery;

  return (
    <>
      {mode === "builtin" ? (
        <div className="settings-skill-ownership-meta" aria-label={t("Built-in skills summary")}>
          <>
            <span><small>{t("Built-in skills")}</small><strong>{partition.builtin.length}</strong></span>
            <span><small>{t("Bound")}</small><strong>{boundBuiltinCount}</strong></span>
            <span><small>{t("Unbound")}</small><strong>{partition.builtin.length - boundBuiltinCount}</strong></span>
          </>
        </div>
      ) : null}

      <div className={`settings-skill-library-toolbar settings-skill-library-toolbar--${mode}`}>
        <label className="settings-skill-search">
          <Search size={15} />
          <input
            value={activeSearchQuery}
            onChange={(event) => mode === "user" ? setUserSearchQuery(event.target.value) : setBuiltinSearchQuery(event.target.value)}
            placeholder={t("Search skills or tools")}
          />
        </label>
        {mode === "builtin" ? (
          <div className="settings-skill-filters" role="tablist" aria-label={t("Built-in skill filters")}>
            {(["all", "bound", "unbound"] as const).map((item) => (
            <button key={item} type="button" className={builtinFilter === item ? "active" : ""} onClick={() => setBuiltinFilter(item)}>
              {t(builtinFilterLabel(item))}
            </button>
            ))}
          </div>
        ) : null}
        {mode === "user" ? (
          <div className="settings-skill-library-toolbar-actions">
            <select value={userSortMode} onChange={(event) => setUserSortMode(event.target.value === "name" ? "name" : "updated")} aria-label={t("Sort skills")}>
              <option value="updated">{t("Sort by updated")}</option>
              <option value="name">{t("Sort by name")}</option>
            </select>
            <button className="primary-button compact-button" type="button" onClick={onImport}>
              <Upload size={14} />
              {t("Import skill")}
            </button>
            <button className="secondary-button compact-button" type="button" onClick={onNewDraft}>
              <Plus size={14} />
              {t("New draft")}
            </button>
          </div>
        ) : null}
      </div>

      <div className={visibleSelectedSkill ? "settings-skill-library-body has-drawer" : "settings-skill-library-body"}>
        <SkillLibraryTable
          variant={mode}
          entries={entries}
          loading={loading}
          saving={saving}
          selectedSkillId={visibleSelectedSkill?.id}
          bindingSummaries={bindingSummaries}
          onSelectSkill={onSelectSkill}
          onArchiveSkill={onArchiveSkill}
          onDeleteSkill={onDeleteSkill}
          t={t}
        />

        {visibleSelectedSkill ? (
          <RightDrawer
            className="right-drawer settings-skill-detail-drawer"
            ariaLabel={t("Skill detail")}
            title={visibleSelectedSkill.definition.name}
            icon={<BookOpen size={15} />}
            actions={(
              <button className="icon-button" type="button" onClick={() => onSelectSkill("")} aria-label={t("Close")} title={t("Close")}>
                <X size={15} />
              </button>
            )}
          >
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
          </RightDrawer>
        ) : null}
      </div>
    </>
  );
}

function boundSkillNames(skillId: string, summaries: readonly TeammateSkillBindingSummary[]): readonly string[] {
  return summaries
    .filter((summary) => summary.bindings.some((binding) => binding.skillId === skillId && binding.enabled))
    .map((summary) => summary.teammate.displayName);
}

function builtinFilterLabel(filter: BuiltinSkillBindingFilter): string {
  if (filter === "bound") return "Bound";
  if (filter === "unbound") return "Unbound";
  return "All";
}
