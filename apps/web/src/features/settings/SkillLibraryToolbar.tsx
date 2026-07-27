import { Plus, Search, Upload } from "lucide-react";
import { Button, Input, Select } from "../../shared/ui/index.js";
import type { SettingsTranslator } from "./skill-library-utils.js";
import type { BuiltinSkillBindingFilter, UserSkillSortMode } from "./skill-library-view-models.js";
import type { ReactNode } from "react";

export function SkillLibraryToolbar({
  mode,
  searchQuery,
  builtinFilter,
  sortMode,
  afterSearch,
  onSearchChange,
  onBuiltinFilterChange,
  onSortModeChange,
  onImport,
  onCreate,
  t,
}: {
  readonly mode: "user" | "evolved" | "builtin";
  readonly searchQuery: string;
  readonly builtinFilter: BuiltinSkillBindingFilter;
  readonly sortMode: UserSkillSortMode;
  readonly afterSearch?: ReactNode;
  readonly onSearchChange: (value: string) => void;
  readonly onBuiltinFilterChange: (value: BuiltinSkillBindingFilter) => void;
  readonly onSortModeChange: (value: UserSkillSortMode) => void;
  readonly onImport: () => void;
  readonly onCreate: () => void;
  readonly t: SettingsTranslator;
}): JSX.Element {
  return (
    <div className={`settings-skill-library-toolbar settings-skill-library-toolbar--${mode}${afterSearch ? " has-view-select" : ""}`}>
      <Input
        containerClassName="settings-skill-search"
        prefix={<Search size={15} />}
        size="sm"
        value={searchQuery}
        onChange={(event) => onSearchChange(event.currentTarget.value)}
        placeholder={t("Search skills or tools")}
        aria-label={t("Search skills or tools")}
      />
      {afterSearch}
      {mode === "builtin" ? (
        <Select
          containerClassName="settings-skill-builtin-filter"
          size="sm"
          value={builtinFilter}
          onChange={(event) => {
            const value = event.currentTarget.value;
            onBuiltinFilterChange(value === "bound" || value === "unbound" ? value : "all");
          }}
          aria-label={t("Built-in skill filters")}
        >
          <option value="all">{t("All")}</option>
          <option value="bound">{t("Bound")}</option>
          <option value="unbound">{t("Unbound")}</option>
        </Select>
      ) : (
        <div className="settings-skill-library-toolbar-actions">
          <Select
            containerClassName="settings-skill-sort"
            size="sm"
            value={sortMode}
            onChange={(event) => onSortModeChange(event.currentTarget.value === "name" ? "name" : "updated")}
            aria-label={t("Sort skills")}
          >
            <option value="updated">{t("Sort by updated")}</option>
            <option value="name">{t("Sort by name")}</option>
          </Select>
          {mode === "user" ? (
            <>
              <Button size="sm" variant="secondary" leadingIcon={<Upload size={14} />} onClick={onImport}>
                {t("Import skill")}
              </Button>
              <Button size="sm" variant="secondary" leadingIcon={<Plus size={14} />} onClick={onCreate}>
                {t("Create skill")}
              </Button>
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}
