import { useI18n } from "../../i18n.js";
import type { WorkItemView } from "../../lib/work-items.js";
import { Button, InlineFeedback, Skeleton } from "../../shared/ui/index.js";
import { WorkBoardEmptyState } from "./WorkBoardEmptyState.js";
import { WorkItemRow } from "./WorkItemRow.js";
import { workBoardScopeTitle } from "./work-board-view-models.js";
import type { WorkBoardFreshness, WorkBoardGroupView, WorkBoardMutation, WorkBoardScope, WorkBoardSourceIssue } from "./work-board-types.js";

export function WorkBoardList(props: {
  readonly items: readonly WorkItemView[];
  readonly totalCount: number;
  readonly scopedCount: number;
  readonly groups: readonly WorkBoardGroupView[];
  readonly selectedItemId: string;
  readonly scope: WorkBoardScope;
  readonly loading: boolean;
  readonly freshness: WorkBoardFreshness;
  readonly issues: readonly WorkBoardSourceIssue[];
  readonly filtered: boolean;
  readonly channelNames: ReadonlyMap<string, string>;
  readonly busyByWorkItemId: ReadonlyMap<string, WorkBoardMutation>;
  readonly onSelect: (itemId: string) => void;
  readonly onRefresh: () => void;
  readonly onClearFilters: () => void;
  readonly onChangeScope: (scope: WorkBoardScope) => void;
  readonly onOpenTask: (id: string) => void;
  readonly onOpenRun: (id: string) => void;
  readonly onOpenApproval: (id: string) => void;
  readonly onOpenChannel: (id: string) => void;
  readonly onClaim?: (id: string) => void;
  readonly onHeartbeat?: (id: string, token: string) => void;
}): JSX.Element {
  const { t } = useI18n();
  if (props.loading && props.items.length === 0) return <div className="work-board-list-skeleton" aria-label={t("Loading work board...")}>{Array.from({ length: 6 }, (_, index) => <Skeleton key={index} height={56} shape="block" />)}</div>;
  return (
    <div className="work-board-list-scroll">
      <h2 className="work-board-view-title">{t(workBoardScopeTitle(props.scope))}</h2>
      {props.issues.length > 0 ? <InlineFeedback className="work-board-source-feedback" title={t(sourceFeedbackTitle(props.freshness))} tone={props.freshness === "capped" ? "info" : "warning"}><span>{props.issues.map((issue) => issue.source).join(", ")}</span>{props.issues.some((issue) => issue.kind === "load") ? <Button size="sm" variant="ghost" onClick={props.onRefresh}>{t("Retry")}</Button> : null}</InlineFeedback> : null}
      {props.items.length === 0 ? <WorkBoardEmptyState totalCount={props.totalCount} scopedCount={props.scopedCount} filtered={props.filtered} scope={props.scope} onClearFilters={props.onClearFilters} onChangeScope={props.onChangeScope} /> : (
        <div className="work-board-groups" role="listbox" aria-label={t("Work items")} aria-busy={props.loading || undefined}>
          {props.groups.map((group) => group.items.length > 0 ? <section className="work-board-group" key={group.key}><div className="work-board-group-head"><strong>{t(group.label)}</strong><span>{group.items.length}</span></div><div className="work-board-list">{group.items.map((item) => <WorkItemRow key={item.id} item={item} selected={props.selectedItemId === item.id} channelName={item.channelId ? props.channelNames.get(item.channelId) : undefined} busy={props.busyByWorkItemId.get(item.id)} onSelect={props.onSelect} onOpenTask={props.onOpenTask} onOpenRun={props.onOpenRun} onOpenApproval={props.onOpenApproval} onOpenChannel={props.onOpenChannel} onClaimWorkItem={props.onClaim} onHeartbeatWorkItem={props.onHeartbeat} />)}</div></section> : null)}
        </div>
      )}
    </div>
  );
}

function sourceFeedbackTitle(freshness: WorkBoardFreshness): string {
  if (freshness === "capped") return "Showing the latest available records";
  if (freshness === "stale") return "Showing retained data";
  if (freshness === "error") return "Work Board could not be loaded";
  return "Partial data";
}
