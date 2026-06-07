import { useMemo, useState } from "react";
import { Kanban, RefreshCw } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { buildWorkItemViews, workItemStatusOrder, workItemStatusLabel, type WorkItemSourceType, type WorkItemStatus, type WorkItemWaitingReason } from "../../lib/work-items.js";
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

export function GlobalWorkBoardPage({
  channels,
  tasks,
  runs,
  approvals,
  workflowSteps,
  externalActionDetails,
  externalWorkCiTriage,
  artifactsByRun,
  onRefresh,
  onOpenTask,
  onOpenRun,
  onOpenApproval,
  onOpenChannel,
  onRouteExternalWork,
  routingExternalWorkId,
}: {
  readonly channels: readonly Channel[];
  readonly tasks: readonly Task[];
  readonly runs: readonly RunSession[];
  readonly approvals: readonly ApprovalRequest[];
  readonly workflowSteps: readonly ChannelWorkflowStep[];
  readonly externalActionDetails: Readonly<Record<string, ExternalWorkActionView>>;
  readonly externalWorkCiTriage: readonly ExternalWorkCiTriageView[];
  readonly artifactsByRun?: Readonly<Record<string, readonly RunArtifact[]>>;
  readonly onRefresh: () => void;
  readonly onOpenTask: (taskId: string) => void;
  readonly onOpenRun: (runId: string) => void;
  readonly onOpenApproval: (approvalId: string) => void;
  readonly onOpenChannel: (channelId: string) => void;
  readonly onRouteExternalWork?: (externalWorkId: string, channelId: string) => void;
  readonly routingExternalWorkId?: string;
}): JSX.Element {
  const { t } = useI18n();
  const [channelFilter, setChannelFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<WorkItemStatus | "">("");
  const [sourceFilter, setSourceFilter] = useState<WorkItemSourceType | "">("");
  const [waitingFilter, setWaitingFilter] = useState<WorkItemWaitingReason | "">("");
  const channelById = useMemo(() => new Map(channels.map((channel) => [channel.id, channel])), [channels]);
  const items = useMemo(
    () => buildWorkItemViews({
      tasks,
      runs,
      approvals,
      workflowSteps,
      externalActions: externalActionDetails,
      externalWorkCiTriage,
      artifactsByRun,
    }),
    [approvals, artifactsByRun, externalActionDetails, externalWorkCiTriage, runs, tasks, workflowSteps],
  );
  const filteredItems = items.filter((item) =>
    (!channelFilter || item.channelId === channelFilter) &&
    (!statusFilter || item.status === statusFilter) &&
    (!sourceFilter || item.sourceType === sourceFilter) &&
    (!waitingFilter || item.waitingReason === waitingFilter)
  );
  const sourceOptions = [...new Set(items.map((item) => item.sourceType))].sort();
  const waitingOptions = [...new Set(items.map((item) => item.waitingReason).filter(Boolean))].sort() as WorkItemWaitingReason[];

  return (
    <section className="panel work-board-page" aria-labelledby="global-work-board-title">
      <div className="panel-title split">
        <span>
          <Kanban size={18} />
          <h2 id="global-work-board-title">{t("Global Work Board")}</h2>
        </span>
        <button className="secondary-button compact-button" type="button" onClick={onRefresh}>
          <RefreshCw size={15} />
          {t("Refresh")}
        </button>
      </div>
      <div className="work-board-filters">
        <label>
          <span>{t("Channel")}</span>
          <select value={channelFilter} onChange={(event) => setChannelFilter(event.target.value)}>
            <option value="">{t("All")}</option>
            {channels.map((channel) => <option key={channel.id} value={channel.id}>{channel.name}</option>)}
          </select>
        </label>
        <label>
          <span>{t("Status")}</span>
          <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as WorkItemStatus | "")}>
            <option value="">{t("All")}</option>
            {workItemStatusOrder.map((status) => <option key={status} value={status}>{t(workItemStatusLabel(status))}</option>)}
          </select>
        </label>
        <label>
          <span>{t("Source")}</span>
          <select value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value as WorkItemSourceType | "")}>
            <option value="">{t("All")}</option>
            {sourceOptions.map((source) => <option key={source} value={source}>{source}</option>)}
          </select>
        </label>
        <label>
          <span>{t("Waiting")}</span>
          <select value={waitingFilter} onChange={(event) => setWaitingFilter(event.target.value as WorkItemWaitingReason | "")}>
            <option value="">{t("All")}</option>
            {waitingOptions.map((reason) => <option key={reason} value={reason}>{reason}</option>)}
          </select>
        </label>
      </div>
      <div className="work-board-count-line">
        <span>{t("{count} work items", { count: filteredItems.length })}</span>
      </div>
      {filteredItems.length === 0 ? (
        <div className="client-empty-state compact-empty"><Kanban /><span>{t("No work items match these filters")}</span></div>
      ) : (
        <div className="work-board-groups">
          {workItemStatusOrder.map((status) => {
            const group = filteredItems.filter((item) => item.status === status);
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
                      channelName={item.channelId ? channelById.get(item.channelId)?.name : undefined}
                      onOpenTask={onOpenTask}
                      onOpenRun={onOpenRun}
                      onOpenApproval={onOpenApproval}
                      onOpenExternalWork={item.channelId ? () => onOpenChannel(item.channelId as string) : undefined}
                      routeChannels={channels}
                      routing={item.externalWorkId === routingExternalWorkId}
                      onRouteExternalWork={onRouteExternalWork}
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
