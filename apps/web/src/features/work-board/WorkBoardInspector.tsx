import { CircleAlert, ClipboardList, Route } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useI18n } from "../../i18n.js";
import { formatDateTime } from "../../lib/formatting.js";
import { isTerminalWorkItemView, workItemNextActionLabel, workItemStatusLabel, type WorkItemView } from "../../lib/work-items.js";
import { Button, EmptyState, InlineFeedback, InspectorSection, Select, Skeleton, StatusIndicator } from "../../shared/ui/index.js";
import type { Channel, WorkItemClaimBlocker } from "../../types.js";
import { WorkBoardGuide } from "./WorkBoardGuide.js";
import { WorkBoardLinkedObjects } from "./WorkBoardLinkedObjects.js";
import { derivePrimaryWorkBoardAction, workItemStatusTone } from "./work-board-view-models.js";
import type { WorkBoardActionFailure, WorkBoardEvidenceState, WorkBoardMutation } from "./work-board-types.js";

export function WorkBoardInspector(props: {
  readonly item?: WorkItemView;
  readonly selectedHidden: boolean;
  readonly selectedMissing: boolean;
  readonly channels: readonly Channel[];
  readonly channelName?: string;
  readonly busy?: WorkBoardMutation;
  readonly failure?: WorkBoardActionFailure;
  readonly blocker?: WorkItemClaimBlocker;
  readonly evidence?: WorkBoardEvidenceState;
  readonly onClearFilters: () => void;
  readonly onClearSelection: () => void;
  readonly onRefresh: () => void;
  readonly onOpenTask: (id: string) => void;
  readonly onOpenRun: (id: string) => void;
  readonly onOpenApproval: (id: string) => void;
  readonly onOpenChannel: (id: string) => void;
  readonly onRoute?: (externalWorkId: string, channelId: string) => void;
  readonly onClaim?: (id: string) => void;
  readonly onHeartbeat?: (id: string, token: string) => void;
  readonly onRelease?: (id: string, token: string) => void;
  readonly onComplete?: (id: string, token: string) => void;
  readonly onOpenFail: (id: string, trigger: HTMLElement) => void;
  readonly onLoadEvidence: (item: WorkItemView) => void;
}): JSX.Element {
  const { t } = useI18n();
  const [routeChannelId, setRouteChannelId] = useState("");
  const item = props.item;
  const [controlsOpen, setControlsOpen] = useState(Boolean(item && !isTerminalWorkItemView(item)));
  useEffect(() => {
    setControlsOpen(Boolean(item && !isTerminalWorkItemView(item)));
    setRouteChannelId("");
  }, [item?.id]);
  const targetChannelId = routeChannelId || item?.channelId || props.channels[0]?.id || "";
  const action = useMemo(() => item ? derivePrimaryWorkBoardAction(item, {
    busy: props.busy, canClaim: Boolean(props.onClaim), canOpenTask: true, canOpenRun: true, canOpenApproval: true,
    canOpenChannel: true, canRoute: Boolean(props.onRoute && props.channels.length > 0),
  }) : undefined, [item, props.busy, props.channels.length, props.onClaim, props.onRoute]);
  if (props.selectedHidden) return <aside className="work-board-detail"><InlineFeedback title={t("Selected work is hidden by filters")} tone="warning"><Button size="sm" variant="ghost" onClick={props.onClearFilters}>{t("Clear filters")}</Button></InlineFeedback></aside>;
  if (props.selectedMissing) return <aside className="work-board-detail"><InlineFeedback title={t("Selected work is no longer available")} tone="warning"><div className="work-board-inline-actions"><Button size="sm" onClick={props.onRefresh}>{t("Retry")}</Button><Button size="sm" variant="ghost" onClick={props.onClearSelection}>{t("Clear selection")}</Button></div></InlineFeedback></aside>;
  if (!item) return <aside className="work-board-detail empty"><EmptyState compact icon={<ClipboardList />} title={t("Select work to inspect")} /><WorkBoardGuide /></aside>;
  const invokePrimary = (): void => {
    if (action?.target === "approval" && item.approvalId) props.onOpenApproval(item.approvalId);
    else if (action?.target === "claim") props.onClaim?.(item.id);
    else if (action?.target === "run" && item.runId) props.onOpenRun(item.runId);
    else if (action?.target === "task" && item.taskId) props.onOpenTask(item.taskId);
    else if (action?.target === "channel" && item.channelId) props.onOpenChannel(item.channelId);
  };
  return (
    <aside className="work-board-detail" aria-label={t("Work details")}>
      <header className="work-board-detail-head"><span className="work-board-detail-status"><StatusIndicator label={t(workItemStatusLabel(item.status))} tone={workItemStatusTone(item.status)} /></span><h2 dir="auto">{item.title}</h2><p>{t(workItemNextActionLabel(item))}</p></header>
      {props.failure ? <InlineFeedback title={t(props.failure.message)} tone="danger">{t("Raw failure detail is available in technical details.")}</InlineFeedback> : null}
      {props.blocker ? <InlineFeedback title={t("Work cannot be claimed yet")} tone="warning">{props.blocker.message}</InlineFeedback> : null}
      {action && action.target !== "route" ? <Button className="work-board-primary-action" disabled={action.disabled} loading={action.loading} loadingLabel={t(action.label)} onClick={invokePrimary}>{t(action.label)}</Button> : null}
      <div className="work-board-detail-meta"><DetailField label={t("Owner")} value={item.claim?.ownerId ?? item.assigneeTeammateId ?? t("Unassigned")} /><DetailField label={t("Channel")} value={props.channelName ?? "-"} /><DetailField label={t("Source")} value={t(item.sourceType)} /><DetailField label={t("Updated")} value={formatDateTime(item.updatedAt)} /></div>
      <InspectorSection title={t("Linked objects")} summary={linkedCount(item)}><WorkBoardLinkedObjects item={item} onOpenTask={props.onOpenTask} onOpenRun={props.onOpenRun} onOpenApproval={props.onOpenApproval} onOpenChannel={props.onOpenChannel} /></InspectorSection>
      <InspectorSection title={t("Evidence")} summary={evidenceSummary(item, props.evidence)} onToggle={(event) => { if (event.currentTarget.open) props.onLoadEvidence(item); }}>
        <EvidenceBody item={item} evidence={props.evidence} onOpenRun={props.onOpenRun} />
      </InspectorSection>
      {(item.claim || item.externalWorkId) ? <InspectorSection open={controlsOpen} title={t("Work controls")} onToggle={(event) => setControlsOpen(event.currentTarget.open)}>
        <div className="work-board-control-stack">
          {item.externalWorkId && props.onRoute ? <div className="work-board-route-control"><Select aria-label={t("Route to channel")} size="sm" value={targetChannelId} onChange={(event) => setRouteChannelId(event.target.value)}>{props.channels.map((channel) => <option key={channel.id} value={channel.id}>{channel.name}</option>)}</Select><Button leadingIcon={<Route />} loading={props.busy === "route"} size="sm" disabled={!targetChannelId || targetChannelId === item.channelId} onClick={() => props.onRoute?.(item.externalWorkId as string, targetChannelId)}>{t("Route")}</Button></div> : null}
          {item.claim?.token ? <div className="work-board-control-grid"><Button disabled={Boolean(props.busy && props.busy !== "heartbeat")} loading={props.busy === "heartbeat"} size="sm" variant="ghost" onClick={() => props.onHeartbeat?.(item.id, item.claim?.token as string)}>{t("Renew claim")}</Button><Button disabled={Boolean(props.busy && props.busy !== "release")} loading={props.busy === "release"} size="sm" variant="ghost" onClick={() => props.onRelease?.(item.id, item.claim?.token as string)}>{t("Release claim")}</Button><Button disabled={Boolean(props.busy && props.busy !== "complete")} loading={props.busy === "complete"} size="sm" onClick={() => props.onComplete?.(item.id, item.claim?.token as string)}>{t("Mark done")}</Button><Button disabled={Boolean(props.busy && props.busy !== "fail")} leadingIcon={<CircleAlert />} loading={props.busy === "fail"} size="sm" variant="danger" onClick={(event) => props.onOpenFail(item.id, event.currentTarget)}>{t("Mark failed")}</Button></div> : null}
        </div>
      </InspectorSection> : null}
      <InspectorSection key={item.id} title={t("Technical details")}><div className="work-board-technical"><DetailField label={t("Work item ID")} value={item.id} /><DetailField label={t("Source ID")} value={item.sourceId} /><DetailField label={t("Created")} value={formatDateTime(item.createdAt)} /><DetailField label={t("Attempts")} value={item.attemptCount === undefined ? "-" : `${item.attemptCount}/${item.retryBudget ?? "-"}`} />{item.labels.length > 0 ? <DetailField label={t("Labels")} value={item.labels.join(", ")} /> : null}{props.failure ? <DetailField label={t("Failure details")} value={props.failure.technicalMessage ?? t("No failure message was captured.")} /> : null}</div></InspectorSection>
    </aside>
  );
}

function DetailField({ label, value }: { readonly label: string; readonly value: string }): JSX.Element { return <span className="work-board-detail-field"><small>{label}</small><strong dir="auto" title={value}>{value}</strong></span>; }
function linkedCount(item: WorkItemView): string { return String([item.taskId, item.runId, item.approvalId, item.channelId].filter(Boolean).length); }
function evidenceSummary(item: WorkItemView, evidence?: WorkBoardEvidenceState): string { return evidence?.status === "ready" || evidence?.status === "stale" ? String(evidence.artifacts.length) : String(item.artifactIds.length + item.proofArtifactIds.length); }
function EvidenceBody({ item, evidence, onOpenRun }: { readonly item: WorkItemView; readonly evidence?: WorkBoardEvidenceState; readonly onOpenRun: (id: string) => void }): JSX.Element {
  const { t } = useI18n();
  if (evidence?.status === "loading") return <Skeleton height={48} shape="block" />;
  if (evidence?.issue) return <InlineFeedback title={t(evidence.status === "stale" ? "Showing retained evidence" : "Evidence could not be loaded")} tone="warning">{t(evidence.issue.message)}</InlineFeedback>;
  const ids = evidence?.artifacts.map((artifact) => artifact.id) ?? [...item.artifactIds, ...item.proofArtifactIds];
  return <div className="work-board-evidence-list">{ids.length > 0 ? ids.map((id) => <span dir="auto" key={id}>{id}</span>) : <p>{t(item.runId ? "No run artifacts" : "No evidence recorded")}</p>}{item.runId ? <Button size="sm" variant="ghost" onClick={() => onOpenRun(item.runId as string)}>{t("Open run evidence")}</Button> : null}</div>;
}
