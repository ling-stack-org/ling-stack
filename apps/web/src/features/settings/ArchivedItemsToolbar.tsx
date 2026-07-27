import { Search, X } from "lucide-react";
import type { MutableRefObject } from "react";
import { useI18n } from "../../i18n.js";
import { IconButton, Input } from "../../shared/ui/index.js";
import { SettingsSubnav, type SettingsSubnavOption } from "./SettingsSubnav.js";
import {
  archivedCategoryDefinitions,
  isArchivedCategoryId,
  type ArchivedCategoryId,
} from "./archived-items-view-models.js";

export function ArchivedItemsToolbar({
  activeCategory,
  counts,
  query,
  searchInputRef,
  onCategoryChange,
  onQueryChange,
}: {
  readonly activeCategory: ArchivedCategoryId;
  readonly counts: Readonly<Record<ArchivedCategoryId, number>>;
  readonly query: string;
  readonly searchInputRef: MutableRefObject<HTMLInputElement | null>;
  readonly onCategoryChange: (categoryId: ArchivedCategoryId) => void;
  readonly onQueryChange: (query: string) => void;
}): JSX.Element {
  const { t } = useI18n();
  const options: readonly SettingsSubnavOption[] = archivedCategoryDefinitions.map((category) => ({
    id: category.id,
    label: category.labelKey,
    badge: String(counts[category.id]),
  }));

  return (
    <div className="archived-items-toolbar">
      <SettingsSubnav
        label="Archived item categories"
        options={options}
        activeId={activeCategory}
        onChange={(categoryId) => {
          if (isArchivedCategoryId(categoryId)) onCategoryChange(categoryId);
        }}
      />
      <div className="archived-items-search">
        <Input
        ref={(node) => {
          searchInputRef.current = node;
        }}
          aria-label={t("Search archived items")}
          containerClassName="archived-items-search-input"
          placeholder={t("Search archived items")}
          prefix={<Search aria-hidden="true" />}
          size="sm"
          type="search"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              onQueryChange("");
            }
          }}
        />
        {query ? (
          <IconButton
            className="archived-items-search-clear"
            icon={X}
            label={t("Clear search")}
            onClick={() => onQueryChange("")}
            size="sm"
          />
        ) : null}
      </div>
    </div>
  );
}
