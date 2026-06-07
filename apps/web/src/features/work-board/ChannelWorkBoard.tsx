import { useMemo } from "react";
import { Kanban, Loader2 } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { buildWorkItemViews, filterWorkItemsByChannel, workItemStatusOrder, workItemStatusLabel } from "../../lib/work-items.js";
import type {
  ApprovalRequest,
  Channel,
  ChannelWorkflowStep,
  ExternalWorkActionView,
  ExternalWorkCiTriageView,
  RunArtifact,
  RunSession,
  Task,
} from "../../types.js";
import { WorkItemRow } from "./WorkItemRow.js";

export function ChannelWorkBoard({
  channel,
  tasks,
  runs,
  approvals,
  workflowSteps,
  externalActionDetails,
  externalWorkCiTriage,
  artifactsByRun,
  loading,
  onOpenTask,
  onOpenRun,
  onOpenApproval,
}: {
  readonly channel: Channel | undefined;
  readonly tasks: readonly Task[];
  readonly runs: readonly RunSession[];
  readonly approvals: readonly ApprovalRequest[];
  readonly workflowSteps: readonly ChannelWorkflowStep[];
  readonly externalActionDetails: Readonly<Record<string, ExternalWorkActionView>>;
  readonly externalWorkCiTriage: readonly ExternalWorkCiTriageView[];
  readonly artifactsByRun?: Readonly<Record<string, readonly RunArtifact[]>>;
  readonly loading?: boolean;
  readonly onOpenTask: (taskId: string) => void;
  readonly onOpenRun: (runId: string) => void;
  readonly onOpenApproval: (approvalId: string) => void;
}): JSX.Element {
  const { t } = useI18n();
  const items = useMemo(() => {
    const all = buildWorkItemViews({
      tasks,
      runs,
      approvals,
      workflowSteps,
      externalActions: externalActionDetails,
      externalWorkCiTriage,
      artifactsByRun,
    });
    return channel ? filterWorkItemsByChannel(all, channel.id) : [];
  }, [approvals, artifactsByRun, channel, externalActionDetails, externalWorkCiTriage, runs, tasks, workflowSteps]);

  return (
    <section className="work-board-panel channel-work-board" aria-label={t("Channel Work Board")}>
      <div className="panel-title split tight">
        <span>
          <Kanban size={16} />
          <h3>{t("Channel Work Board")}</h3>
        </span>
        <span className="event-count">{loading ? t("Loading") : t("{count} work items", { count: items.length })}</span>
      </div>
      {loading ? (
        <div className="client-empty-state compact-empty"><Loader2 className="spin" /><span>{t("Loading work board...")}</span></div>
      ) : items.length === 0 ? (
        <div className="client-empty-state compact-empty"><Kanban /><span>{t("No work items for this channel")}</span></div>
      ) : (
        <div className="work-board-groups">
          {workItemStatusOrder.map((status) => {
            const group = items.filter((item) => item.status === status);
            if (group.length === 0) {
              return null;
            }
            return (
              <section key={status} className="work-board-group">
                <div className="work-board-group-head">
                  <strong>{t(workItemStatusLabel(status))}</strong>
                  <span>{group.length}</span>
                </div>
                <div className="work-board-list">
                  {group.map((item) => (
                    <WorkItemRow
                      key={item.id}
                      item={item}
                      channelName={channel?.name}
                      onOpenTask={onOpenTask}
                      onOpenRun={onOpenRun}
                      onOpenApproval={onOpenApproval}
                    />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </section>
  );
}
