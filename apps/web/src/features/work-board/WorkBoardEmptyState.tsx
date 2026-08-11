import { Kanban, SearchX } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { Button, EmptyState } from "../../shared/ui/index.js";
import type { WorkBoardScope } from "./work-board-types.js";

export function WorkBoardEmptyState({ totalCount, scopedCount, filtered, scope, onClearFilters, onChangeScope, onOpenChannel }: {
  readonly totalCount: number;
  readonly scopedCount: number;
  readonly filtered: boolean;
  readonly scope: WorkBoardScope;
  readonly onClearFilters: () => void;
  readonly onChangeScope: (scope: WorkBoardScope) => void;
  readonly onOpenChannel?: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  if (filtered && scopedCount > 0) return <EmptyState className="work-board-empty" icon={<SearchX />} title={t("No work matches these filters")} description={t("Clear filters to see work in this view.")} action={<Button size="sm" onClick={onClearFilters}>{t("Clear filters")}</Button>} />;
  if (totalCount === 0) return <EmptyState className="work-board-empty" icon={<Kanban />} title={t("No work yet")} description={t("Work from tasks, runs, approvals, and channels will appear here.")} action={onOpenChannel ? <Button size="sm" onClick={onOpenChannel}>{t("Open a channel")}</Button> : undefined} />;
  if (scope === "actionable") return <EmptyState className="work-board-empty" icon={<Kanban />} title={t("No work needs your attention")} action={<Button size="sm" onClick={() => onChangeScope("global")}>{t("View all active")}</Button>} secondaryAction={<Button size="sm" variant="ghost" onClick={() => onChangeScope("history")}>{t("History")}</Button>} />;
  if (scope === "history") return <EmptyState className="work-board-empty" icon={<Kanban />} title={t("No completed work yet")} action={<Button size="sm" onClick={() => onChangeScope("actionable")}>{t("View needs action")}</Button>} />;
  return <EmptyState className="work-board-empty" icon={<Kanban />} title={t("No work in this view")} action={<Button size="sm" onClick={() => onChangeScope("actionable")}>{t("Needs action")}</Button>} secondaryAction={<Button size="sm" variant="ghost" onClick={() => onChangeScope("global")}>{t("All active")}</Button>} />;
}
