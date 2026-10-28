import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Plus, Search, Upload } from "lucide-react";
import { Button, EmptyState, Skeleton } from "../../shared/ui/index.js";
import type {
  SkillOptimizationPreview,
  SkillRegistryEntry,
  SkillSourceArtifact,
  SkillSourceSnapshot,
} from "../../types.js";
import { isEditableSkillEntry } from "./skill-editor-utils.js";
import { SkillLibraryInspectorPanel } from "./SkillLibraryInspectorPanel.js";
import { SkillLibraryTable } from "./SkillLibraryTable.js";
import { SkillLibraryToolbar } from "./SkillLibraryToolbar.js";
import type { SettingsTranslator, TeammateSkillBindingSummary } from "./skill-library-utils.js";
import {
  filterBuiltinSkillEntries,
  filterEvolvedSkillEntries,
  filterUserSkillEntries,
  partitionSkillRegistry,
  type BuiltinSkillBindingFilter,
  type UserSkillSortMode,
} from "./skill-library-view-models.js";

export function SkillLibraryRegistrySection({
  mode,
  skills,
  loading,
  busyAction,
  selectedSkillId,
  bindingSummaries,
  sourceSnapshotBySkillId,
  sourceHistoryBySkillId,
  artifacts,
  sourceArtifactsLoading,
  sourceError,
  optimizationPreview,
  cwd,
  onSelectSkill,
  onArchiveSkill,
  onDeleteSkill,
  onPreviewOptimization,
  onArchiveSource,
  onRollbackSource,
  onDefinitionChanged,
  onImport,
  onNewDraft,
  onEditSkill,
  toolbarAfterSearch,
  t,
}: {
  readonly mode: "user" | "evolved" | "builtin";
  readonly skills: readonly SkillRegistryEntry[];
  readonly loading: boolean;
  readonly busyAction: string;
  readonly selectedSkillId: string | undefined;
  readonly bindingSummaries: readonly TeammateSkillBindingSummary[];
  readonly sourceSnapshotBySkillId: ReadonlyMap<string, SkillSourceSnapshot>;
  readonly sourceHistoryBySkillId: ReadonlyMap<string, readonly SkillSourceSnapshot[]>;
  readonly artifacts: readonly SkillSourceArtifact[];
  readonly sourceArtifactsLoading: boolean;
  readonly sourceError: string;
  readonly optimizationPreview: SkillOptimizationPreview | undefined;
  readonly cwd: string;
  readonly onSelectSkill: (skillId: string) => void;
  readonly onArchiveSkill: (skillId: string) => void;
  readonly onDeleteSkill: (skill: SkillRegistryEntry, trigger: HTMLButtonElement) => void;
  readonly onPreviewOptimization: () => void;
  readonly onArchiveSource: (skillId: string) => void;
  readonly onRollbackSource: (snapshotId: string) => void;
  readonly onDefinitionChanged?: () => Promise<void>;
  readonly onImport: () => void;
  readonly onNewDraft: () => void;
  readonly onEditSkill: (skill: SkillRegistryEntry) => void;
  readonly toolbarAfterSearch?: ReactNode;
  readonly t: SettingsTranslator;
}): React.JSX.Element {
  const [userSearch, setUserSearch] = useState("");
  const [evolvedSearch, setEvolvedSearch] = useState("");
  const [builtinSearch, setBuiltinSearch] = useState("");
  const [builtinFilter, setBuiltinFilter] = useState<BuiltinSkillBindingFilter>("all");
  const [userSort, setUserSort] = useState<UserSkillSortMode>("updated");
  const [evolvedSort, setEvolvedSort] = useState<UserSkillSortMode>("updated");
  const partition = useMemo(() => partitionSkillRegistry(skills), [skills]);
  const boundSkillIds = useMemo(() => new Set(bindingSummaries.flatMap((summary) =>
    summary.bindings.filter((binding) => binding.enabled).map((binding) => binding.skillId)
  )), [bindingSummaries]);
  const entries = useMemo(() => {
    if (mode === "user") return filterUserSkillEntries(skills, { query: userSearch, sortMode: userSort });
    if (mode === "evolved") return filterEvolvedSkillEntries(skills, { query: evolvedSearch, sortMode: evolvedSort });
    return filterBuiltinSkillEntries(skills, { query: builtinSearch, binding: builtinFilter, boundSkillIds });
  }, [boundSkillIds, builtinFilter, builtinSearch, evolvedSearch, evolvedSort, mode, skills, userSearch, userSort]);
  const visibleSelectedSkill = selectedSkillId ? entries.find((entry) => entry.id === selectedSkillId) : undefined;

  useEffect(() => {
    if (selectedSkillId && !visibleSelectedSkill) onSelectSkill("");
  }, [onSelectSkill, selectedSkillId, visibleSelectedSkill]);

  const searchQuery = mode === "user" ? userSearch : mode === "evolved" ? evolvedSearch : builtinSearch;
  const sortMode = mode === "evolved" ? evolvedSort : userSort;
  const baseEntries = mode === "user" ? partition.user : mode === "evolved" ? partition.evolved : partition.builtin;
  const boundBuiltinCount = partition.builtin.filter((entry) => boundSkillIds.has(entry.id)).length;
  const toolbar = (
    <SkillLibraryToolbar
      mode={mode}
      searchQuery={searchQuery}
      builtinFilter={builtinFilter}
      sortMode={sortMode}
      afterSearch={toolbarAfterSearch}
      onSearchChange={(value) => {
        if (mode === "user") setUserSearch(value);
        else if (mode === "evolved") setEvolvedSearch(value);
        else setBuiltinSearch(value);
      }}
      onBuiltinFilterChange={setBuiltinFilter}
      onSortModeChange={(value) => {
        if (mode === "evolved") setEvolvedSort(value);
        else setUserSort(value);
      }}
      onImport={onImport}
      onCreate={onNewDraft}
      t={t}
    />
  );

  if (loading && baseEntries.length === 0) {
    return (
      <div className="settings-skill-registry-loading" aria-label={t("Loading skills...")}>
        {toolbar}
        {[0, 1, 2, 3].map((index) => <Skeleton key={index} shape="block" height={44} width="100%" />)}
      </div>
    );
  }

  if (baseEntries.length === 0) {
    return (
      <>
        {mode === "evolved" ? toolbar : null}
        <EmptyState
          className="settings-skill-ownership-empty"
          compact
          icon={<Search size={18} />}
          title={t(mode === "user" ? "No user skills yet" : mode === "evolved" ? "No AI-created skills yet" : "No built-in skills available")}
          description={t(mode === "user"
            ? "Import a skill or create a draft to start building your workspace library."
            : mode === "evolved"
              ? "Adopt and publish a pending skill to manage it here."
              : "Built-in skills are loaded with the workspace library.")}
          secondaryAction={mode === "user" ? (
            <Button size="sm" variant="secondary" leadingIcon={<Upload size={14} />} onClick={onImport}>{t("Import skill")}</Button>
          ) : undefined}
          action={mode === "user" ? (
            <Button size="sm" variant="secondary" leadingIcon={<Plus size={14} />} onClick={onNewDraft}>{t("Create skill")}</Button>
          ) : undefined}
        />
      </>
    );
  }

  return (
    <>
      {mode === "builtin" ? (
        <div className="settings-skill-ownership-meta" aria-label={t("Built-in skills summary")}>
          <span>{t("Built-in skills")} <strong>{partition.builtin.length}</strong></span>
          <span>{t("Bound")} <strong>{boundBuiltinCount}</strong></span>
          <span>{t("Unbound")} <strong>{partition.builtin.length - boundBuiltinCount}</strong></span>
        </div>
      ) : null}
      {toolbar}
      <div className={visibleSelectedSkill ? "settings-skill-library-body has-drawer" : "settings-skill-library-body"}>
        <SkillLibraryTable
          variant={mode}
          entries={entries}
          loading={loading}
          busyAction={busyAction}
          selectedSkillId={visibleSelectedSkill?.id}
          bindingSummaries={bindingSummaries}
          onSelectSkill={onSelectSkill}
          onArchiveSkill={onArchiveSkill}
          onDeleteSkill={onDeleteSkill}
          t={t}
        />
        {visibleSelectedSkill ? (
          <SkillLibraryInspectorPanel
            skill={visibleSelectedSkill}
            readOnly={mode === "builtin"}
            sourceSnapshot={sourceSnapshotBySkillId.get(visibleSelectedSkill.id)}
            sourceHistory={sourceHistoryBySkillId.get(visibleSelectedSkill.id) ?? []}
            artifacts={artifacts}
            sourceArtifactsLoading={sourceArtifactsLoading}
            sourceError={sourceError}
            optimizationPreview={optimizationPreview}
            busyAction={busyAction}
            cwd={cwd}
            boundTeammates={boundSkillNames(visibleSelectedSkill.id, bindingSummaries)}
            editable={isEditableSkillEntry(visibleSelectedSkill)}
            onClose={() => onSelectSkill("")}
            onEdit={() => onEditSkill(visibleSelectedSkill)}
            onPreviewOptimization={onPreviewOptimization}
            onArchiveSource={() => onArchiveSource(visibleSelectedSkill.id)}
            onRollbackSource={onRollbackSource}
            onDefinitionChanged={onDefinitionChanged}
            t={t}
          />
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
