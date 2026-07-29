import {
  Button,
  Input,
  SegmentedControl,
  SegmentedControlItem,
  Select,
} from "../../shared/ui/index.js";
import { Search, X } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { reviewQueueCategoryLabel, type ReviewQueueItemCategory } from "../../lib/review-queue.js";
import type { ApprovalRisk } from "../../types.js";
import type { ApprovalCategoryFilter, ApprovalQueueMode, ApprovalRiskFilter } from "./approval-view-models.js";

export function ApprovalToolbar({
  mode,
  category,
  risk,
  search,
  categoryOptions,
  filtersActive,
  onModeChange,
  onCategoryChange,
  onRiskChange,
  onSearchChange,
  onClear,
}: {
  readonly mode: ApprovalQueueMode;
  readonly category: ApprovalCategoryFilter;
  readonly risk: ApprovalRiskFilter;
  readonly search: string;
  readonly categoryOptions: readonly ReviewQueueItemCategory[];
  readonly filtersActive: boolean;
  readonly onModeChange: (mode: ApprovalQueueMode) => void;
  readonly onCategoryChange: (category: ApprovalCategoryFilter) => void;
  readonly onRiskChange: (risk: ApprovalRisk | "all") => void;
  readonly onSearchChange: (search: string) => void;
  readonly onClear: () => void;
}): JSX.Element {
  const { t } = useI18n();
  return (
    <div className="approvals-ui2-toolbar" aria-label={t("Filters")}>
      <SegmentedControl
        aria-label={t("View")}
        size="sm"
        value={mode}
        onValueChange={(value) => onModeChange(value as ApprovalQueueMode)}
      >
        <SegmentedControlItem value="actionable">{t("Needs attention")}</SegmentedControlItem>
        <SegmentedControlItem value="history">{t("History")}</SegmentedControlItem>
      </SegmentedControl>
      <Input
        aria-label={t("Search")}
        placeholder={t("Search")}
        prefix={<Search aria-hidden="true" size={14} />}
        size="sm"
        value={search}
        onChange={(event) => onSearchChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && search) {
            event.preventDefault();
            onSearchChange("");
          }
        }}
      />
      <Select
        aria-label={t("Category")}
        size="sm"
        value={category}
        onChange={(event) => onCategoryChange(event.target.value as ApprovalCategoryFilter)}
      >
        <option value="all">{t("All")}</option>
        {categoryOptions.map((option) => (
          <option key={option} value={option}>{t(reviewQueueCategoryLabel(option))}</option>
        ))}
      </Select>
      <Select
        aria-label={t("Risk")}
        size="sm"
        value={risk}
        onChange={(event) => onRiskChange(event.target.value as ApprovalRisk | "all")}
      >
        <option value="all">{t("All")}</option>
        {(["low", "medium", "high", "critical"] as const).map((option) => (
          <option key={option} value={option}>{t(option)}</option>
        ))}
      </Select>
      {filtersActive ? (
        <Button leadingIcon={<X aria-hidden="true" size={14} />} size="sm" variant="ghost" onClick={onClear}>
          {t("Clear filters")}
        </Button>
      ) : null}
    </div>
  );
}
