import { CircleAlert, Search } from "lucide-react";
import type { ApprovalResolution } from "../approvals/types.js";
import { useI18n } from "../../i18n.js";
import { readDataString } from "../../lib/data.js";
import { buildRunRepairHint, readRunEventIssueText, readRunWorkspaceCwd } from "../../lib/run-evidence.js";
import { RunRepairHintBanner } from "../../shared/components/index.js";
import { EmptyState, InlineFeedback } from "../../shared/ui/index.js";
import type {
  ApprovalRequest,
  MemoryObject,
  ResourceLease,
  RunArtifact,
  RunEventEnvelope,
  RunSession,
  StateTransitionEvent,
  UsedMemoryEvent,
  WorkUnitDetailResponse,
} from "../../types.js";
import { RunApprovalSection } from "./RunApprovalSection.js";
import { RunArtifactSection } from "./RunArtifactSection.js";
import { RunDetailHeader } from "./RunDetailHeader.js";
import { RunEvidenceSection } from "./RunEvidenceSection.js";
import { RunGuidancePanel } from "./RunGuidancePanel.js";
import { RunOverviewSection } from "./RunOverviewSection.js";
import { RuntimeRunRepairPanel } from "./RuntimeRunRepairPanel.js";
import { RunTechnicalDetails } from "./RunTechnicalDetails.js";
import { RunThreadContinuationSection } from "./RunThreadContinuationSection.js";
import { RunTimeline } from "./RunTimeline.js";
import { runCanBeStopped } from "./runs-thread-view-models.js";
import type { WorkHistoryTurnContext } from "./runs-thread-types.js";

export function RunDetailPanel({
  run,
  memoryById,
  usedMemoryEvents,
  events,
  artifacts,
  resourceLeases,
  stateTransitions,
  workUnitDetail,
  assistantText,
  turnContext,
  approvals,
  approvalsLoading,
  resolvingApprovals,
  isRunning,
  cancellingRunId,
  onRefresh,
  onRefreshApprovals,
  onRerun,
  onCancelRun,
  onResolveApproval,
  onOpenProviders,
  onOpenApprovals,
  onEditTask,
  onSelectRun,
  cwd,
}: {
  readonly run: RunSession | undefined;
  readonly memoryById: ReadonlyMap<string, MemoryObject>;
  readonly usedMemoryEvents: readonly UsedMemoryEvent[];
  readonly events: readonly RunEventEnvelope[];
  readonly artifacts: readonly RunArtifact[];
  readonly resourceLeases: readonly ResourceLease[];
  readonly stateTransitions: readonly StateTransitionEvent[];
  readonly workUnitDetail: WorkUnitDetailResponse | undefined;
  readonly assistantText: string;
  readonly turnContext: WorkHistoryTurnContext | undefined;
  readonly approvals: readonly ApprovalRequest[];
  readonly approvalsLoading: boolean;
  readonly resolvingApprovals: Readonly<Record<string, ApprovalResolution>>;
  readonly isRunning: boolean;
  readonly cancellingRunId: string;
  readonly onRefresh: () => void;
  readonly onRefreshApprovals: () => void;
  readonly onRerun: (run: RunSession) => void;
  readonly onCancelRun: (run: RunSession) => void;
  readonly onResolveApproval: (approvalId: string, decision: ApprovalResolution, reason?: string) => void;
  readonly onOpenProviders: (run?: RunSession) => void;
  readonly onOpenApprovals: (runId?: string) => void;
  readonly onEditTask: (run: RunSession) => void;
  readonly onSelectRun: (runId: string) => void;
  readonly cwd: string;
}): JSX.Element {
  const { t } = useI18n();
  const pendingApprovals = approvals.filter((approval) => approval.status === "pending");
  const terminalEvent = [...events].reverse().find((event) => ["result", "run_error", "run_cancelled", "run_end"].includes(event.type));
  const repairHint = run ? buildRunRepairHint(run, pendingApprovals.length, run.status, readRunEventIssueText(terminalEvent), t) : undefined;
  const workspaceCwd = run ? readRunWorkspaceCwd(run, readDataString(run.requestSnapshot, "workspaceCwd") || run.cwd) : cwd;
  const runLeases = run ? resourceLeases.filter((lease) => lease.ownerId === run.id || lease.workUnitId === run.workUnitId) : [];
  const transitions = run ? stateTransitions.filter((transition) =>
    (transition.entityType === "run" && transition.entityId === run.id) ||
    (transition.entityType === "task" && transition.entityId === run.taskId) ||
    (transition.entityType === "work_unit" && transition.entityId === run.workUnitId)) : [];
  return (
    <section className="runs-detail-workspace run-detail-panel" aria-labelledby="run-detail-title" aria-label={t("Run detail")}>
      <RunDetailHeader approvals={approvals} cancellingRunId={cancellingRunId} isRunning={isRunning} onCancelRun={onCancelRun} onRefresh={onRefresh} onRerun={onRerun} run={run} />
      {!run ? <EmptyState icon={<Search />} title={t("Select a run to inspect execution details")} /> : (
        <div className="runs-detail-sections run-detail-content">
          <RunOverviewSection onSelectRun={onSelectRun} run={run} turnContext={turnContext} />
          {repairHint ? <RunRepairHintBanner hint={repairHint} runId={run.id} onOpenProviders={() => onOpenProviders(run)} onOpenApprovals={onOpenApprovals} onReload={onRefresh} /> : null}
          {run.errorMessage ? <InlineFeedback title={t("Failed")} tone="danger"><CircleAlert size={16} />{run.errorMessage}</InlineFeedback> : null}
          {run.status === "failed" && repairHint?.target === "run" ? <RuntimeRunRepairPanel events={events} isRunning={isRunning} onEditTask={onEditTask} onReload={onRefresh} onRerun={onRerun} run={run} workspaceCwd={workspaceCwd} /> : null}
          <RunTimeline
            approvalsLoading={false}
            assistantText=""
            errorMessage=""
            events={events}
            isRunning={isRunning}
            onRefreshApprovals={onRefreshApprovals}
            onResolveApproval={onResolveApproval}
            pendingApprovals={[]}
            resolvingApprovals={resolvingApprovals}
          />
          <RunApprovalSection approvals={approvals} loading={approvalsLoading} onRefresh={onRefreshApprovals} onResolve={onResolveApproval} resolvingApprovals={resolvingApprovals} />
          <RunArtifactSection artifacts={artifacts} cwd={cwd} events={events} run={run} />
          <RunEvidenceSection approvals={approvals} artifacts={artifacts} assistantText={assistantText} cwd={cwd} events={events} memoryById={memoryById} run={run} usedMemoryEvents={usedMemoryEvents} />
          <RunGuidancePanel canRedirect={runCanBeStopped(run)} cwd={cwd} onRefreshRun={onRefresh} run={run} />
          <RunThreadContinuationSection cwd={cwd} isRunning={isRunning} onRefresh={onRefresh} run={run} turnContext={turnContext} />
          <RunTechnicalDetails events={events} leases={runLeases} run={run} transitions={transitions} workUnitDetail={workUnitDetail} />
        </div>
      )}
    </section>
  );
}
