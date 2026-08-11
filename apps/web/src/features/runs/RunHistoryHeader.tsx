import { History, Search } from "lucide-react";
import type { KeyboardEvent } from "react";
import { useI18n } from "../../i18n.js";
import { Input, SegmentedControl, SegmentedControlItem } from "../../shared/ui/index.js";
import type { LingThreadArchivedFilter } from "../../types.js";

export function RunHistoryHeader({
  archivedFilter,
  search,
  title,
  onArchivedFilterChange,
  onSearchChange,
}: {
  readonly archivedFilter: LingThreadArchivedFilter;
  readonly search: string;
  readonly title: string;
  readonly onArchivedFilterChange: (filter: LingThreadArchivedFilter) => void;
  readonly onSearchChange: (value: string) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  function handleSearchKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "Escape" && search) {
      event.preventDefault();
      onSearchChange("");
    }
  }
  return (
    <header className="runs-page-header">
      <div className="runs-page-heading">
        <History aria-hidden="true" size={18} />
        <h2>{title}</h2>
      </div>
      <div className="runs-page-toolbar">
        <Input
          aria-label={t("Search thread bindings")}
          onChange={(event) => onSearchChange(event.target.value)}
          onKeyDown={handleSearchKeyDown}
          placeholder={t("Search thread bindings")}
          prefix={<Search aria-hidden="true" size={14} />}
          type="search"
          value={search}
        />
        <SegmentedControl
          aria-label={t("Thread binding visibility")}
          onValueChange={(value) => onArchivedFilterChange(value as LingThreadArchivedFilter)}
          size="sm"
          value={archivedFilter}
        >
          <SegmentedControlItem role="button" value="exclude">{t("Active")}</SegmentedControlItem>
          <SegmentedControlItem role="button" value="include">{t("All")}</SegmentedControlItem>
          <SegmentedControlItem role="button" value="only">{t("Archived")}</SegmentedControlItem>
        </SegmentedControl>
      </div>
    </header>
  );
}
