import { Kanban } from "lucide-react";
import { useMemo } from "react";
import { useI18n } from "../../i18n.js";
import { buildWorkItemViews, filterWorkItemsByChannel, isTerminalWorkItemView, workItemActionGroup, workItemActionGroupLabel, workItemActionGroupOrder } from "../../lib/work-items.js";
import { EmptyState, Skeleton } from "../../shared/ui/index.js";
import type { ApprovalRequest, Channel, ChannelWorkflowStep, ExternalWorkActionView, ExternalWorkCiTriageView, RunArtifact, RunSession, Task, WorkItemView as DurableWorkItemView } from "../../types.js";
import { WorkItemRow } from "./WorkItemRow.js";

interface ChannelWorkBoardProps {
  readonly channel: Channel | undefined;
  readonly tasks: readonly Task[];
  readonly runs: readonly RunSession[];
  readonly approvals: readonly ApprovalRequest[];
  readonly workflowSteps: readonly ChannelWorkflowStep[];
  readonly externalActionDetails: Readonly<Record<string, ExternalWorkActionView>>;
  readonly externalWorkCiTriage: readonly ExternalWorkCiTriageView[];
  readonly artifactsByRun?: Readonly<Record<string, readonly RunArtifact[]>>;
  readonly durableWorkItems?: readonly DurableWorkItemView[];
  readonly loading?: boolean;
  readonly onOpenTask: (taskId: string) => void;
  readonly onOpenRun: (runId: string) => void;
  readonly onOpenApproval: (approvalId: string) => void;
  readonly onClaimWorkItem?: (workItemId: string) => void;
  readonly onHeartbeatWorkItem?: (workItemId: string, claimToken: string) => void;
  readonly onReleaseWorkItem?: (workItemId: string, claimToken: string) => void;
  readonly onCompleteWorkItem?: (workItemId: string, claimToken: string) => void;
  readonly onFailWorkItem?: (workItemId: string, claimToken: string) => void;
  readonly busyWorkItemId?: string;
}

export function ChannelWorkBoard(props: ChannelWorkBoardProps): JSX.Element {
  const { t } = useI18n();
  const items = useMemo(() => {
    const projected = buildWorkItemViews({
      tasks: props.tasks, runs: props.runs, approvals: props.approvals, workflowSteps: props.workflowSteps,
      externalActions: props.externalActionDetails, externalWorkCiTriage: props.externalWorkCiTriage,
      artifactsByRun: props.artifactsByRun, durableWorkItems: props.durableWorkItems,
    });
    return props.channel ? filterWorkItemsByChannel(projected, props.channel.id).filter((item) => !isTerminalWorkItemView(item)) : [];
  }, [props.approvals, props.artifactsByRun, props.channel, props.durableWorkItems, props.externalActionDetails, props.externalWorkCiTriage, props.runs, props.tasks, props.workflowSteps]);
  return (
    <section className="work-board-panel channel-work-board" aria-label={t("Channel Work Board")}>
      <header className="channel-work-board-header"><span><Kanban aria-hidden="true" size={16} /><h3>{t("Channel Work Board")}</h3></span><span>{props.loading ? t("Loading") : t("{count} work items", { count: items.length })}</span></header>
      {props.loading ? <div className="channel-work-board-skeleton">{Array.from({ length: 3 }, (_, index) => <Skeleton height={48} key={index} shape="block" />)}</div> : items.length === 0 ? <EmptyState compact icon={<Kanban />} title={t("No active work items for this channel")} /> : (
        <div className="work-board-groups channel-work-board-groups" role="listbox" aria-label={t("Channel work items")}>
          {workItemActionGroupOrder.map((groupKey) => {
            const group = items.filter((item) => workItemActionGroup(item) === groupKey);
            return group.length > 0 ? <section className="work-board-group" key={groupKey}><div className="work-board-group-head"><strong>{t(workItemActionGroupLabel(groupKey))}</strong><span>{group.length}</span></div><div className="work-board-list">{group.map((item) => <WorkItemRow key={item.id} compact item={item} channelName={props.channel?.name} busy={props.busyWorkItemId === item.id ? "claim" : undefined} onOpenTask={props.onOpenTask} onOpenRun={props.onOpenRun} onOpenApproval={props.onOpenApproval} onClaimWorkItem={props.onClaimWorkItem} onHeartbeatWorkItem={props.onHeartbeatWorkItem} />)}</div></section> : null;
          })}
        </div>
      )}
    </section>
  );
}
