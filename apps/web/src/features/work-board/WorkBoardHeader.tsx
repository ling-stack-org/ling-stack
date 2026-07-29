import { RefreshCw } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { IconButton, StatusIndicator } from "../../shared/ui/index.js";
import type { WorkBoardFreshness, WorkBoardStats } from "./work-board-types.js";

export function WorkBoardHeader({ stats, freshness, refreshing, onRefresh }: {
  readonly stats: WorkBoardStats;
  readonly freshness: WorkBoardFreshness;
  readonly refreshing: boolean;
  readonly onRefresh: () => void;
}): JSX.Element {
  const { t } = useI18n();
  const degraded = freshness === "partial" || freshness === "stale" || freshness === "error";
  return (
    <header className="work-board-header">
      <div className="work-board-header-copy">
        <h1 id="global-work-board-title">{t("Work Board")}</h1>
        <div className="work-board-summary" aria-live="polite">
          {degraded ? <StatusIndicator label={t("Partial data")} tone="warning" /> : null}
          <span>{t("{count} need action", { count: stats.actionable })}</span>
          <span>{t("{count} running", { count: stats.running })}</span>
          <span>{t("{count} blocked", { count: stats.blocked })}</span>
        </div>
      </div>
      <IconButton
        icon={RefreshCw}
        label={t("Refresh")}
        loading={refreshing}
        loadingLabel={t("Refreshing")}
        onClick={onRefresh}
        variant="ghost"
      />
    </header>
  );
}
