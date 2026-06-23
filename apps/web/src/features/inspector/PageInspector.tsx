import {
  Database,
  FileText,
  Settings,
  ShieldCheck,
  SquareTerminal,
} from "lucide-react";
import { useI18n } from "../../i18n.js";
import { effectiveApprovalStatus } from "../../lib/approvals.js";
import { formatDateTime } from "../../lib/formatting.js";
import { ArtifactRow, MetaRow, StatusBadge } from "../../shared/components/index.js";
import type {
  ApprovalPolicy,
  ApprovalPolicyFormState,
  ApprovalRequest,
  ExternalWorkCiTriageView,
  ExternalWorkActionView,
  ExternalWorkStatusResponse,
  MediaJob,
  ProviderCheckResult,
  ProviderPreset,
  RunArtifact,
  RunEventEnvelope,
  RunSession,
  Task,
} from "../../types.js";
import type { SelectedEntity, ViewId } from "../../app/view-types.js";
import { ApprovalCard, type ExternalActionBusyState } from "../approvals/ApprovalCard.js";
import type { ApprovalResolution } from "../approvals/types.js";
import { CiTriageAuditPanel } from "../external-work/CiTriageAuditPanel.js";
import { RunInspector, RunTimeline } from "../runs/index.js";

export function PageInspector({
  activeView,
  selectedEntity,
  selectedTask,
  selectedRun,
  activeRunId,
  lookupRunId,
  events,
  artifacts,
  assistantText,
  errorMessage,
  isRunning,
  pendingApprovals,
  approvalsLoading,
  resolvingApprovals,
  providers,
  selectedProviderId,
  editingProviderId,
  providerCheck,
  checkedProviderId,
  mediaJobs,
  selectedMediaJobId,
  mediaJobArtifacts,
  cwd,
  approvals,
  selectedApprovalId,
  externalActionDetails,
  externalActionBusy,
  externalWorkCiTriage,
  externalWorkCiTriageLoading,
  externalWorkStatus,
  approvalPolicy,
  approvalPolicyForm,
  onLookupRunIdChange,
  onLoadRun,
  onRefreshApprovals,
  onResolveApproval,
  onExecuteExternalAction,
  onCancelExternalAction,
}: {
  readonly activeView: ViewId;
  readonly selectedEntity: SelectedEntity;
  readonly selectedTask: Task | undefined;
  readonly selectedRun: RunSession | undefined;
  readonly activeRunId: string;
  readonly lookupRunId: string;
  readonly events: readonly RunEventEnvelope[];
  readonly artifacts: readonly RunArtifact[];
  readonly assistantText: string;
  readonly errorMessage: string;
  readonly isRunning: boolean;
  readonly pendingApprovals: readonly ApprovalRequest[];
  readonly approvalsLoading: boolean;
  readonly resolvingApprovals: Readonly<Record<string, ApprovalResolution>>;
  readonly providers: readonly ProviderPreset[];
  readonly selectedProviderId: string;
  readonly editingProviderId: string;
  readonly providerCheck: ProviderCheckResult | undefined;
  readonly checkedProviderId: string;
  readonly mediaJobs: readonly MediaJob[];
  readonly selectedMediaJobId: string;
  readonly mediaJobArtifacts: Record<string, readonly RunArtifact[]>;
  readonly cwd: string;
  readonly approvals: readonly ApprovalRequest[];
  readonly selectedApprovalId: string;
  readonly externalActionDetails: Readonly<Record<string, ExternalWorkActionView>>;
  readonly externalActionBusy: Readonly<Record<string, ExternalActionBusyState>>;
  readonly externalWorkCiTriage: readonly ExternalWorkCiTriageView[];
  readonly externalWorkCiTriageLoading: boolean;
  readonly externalWorkStatus: ExternalWorkStatusResponse | undefined;
  readonly approvalPolicy: ApprovalPolicy | undefined;
  readonly approvalPolicyForm: ApprovalPolicyFormState;
  readonly onLookupRunIdChange: (runId: string) => void;
  readonly onLoadRun: () => void;
  readonly onRefreshApprovals: () => void;
  readonly onResolveApproval: (approvalId: string, decision: ApprovalResolution, reason?: string) => void;
  readonly onExecuteExternalAction: (actionId: string) => void;
  readonly onCancelExternalAction: (actionId: string) => void;
}): JSX.Element {
  const { t } = useI18n();
  if (activeView === "runs") {
    return (
      <RunInspector
        activeRunId={activeRunId}
        lookupRunId={lookupRunId}
        run={selectedRun}
        events={events}
        artifacts={artifacts}
        onLookupRunIdChange={onLookupRunIdChange}
        onLoadRun={onLoadRun}
      />
    );
  }

  if (activeView === "providers") {
    void selectedEntity;
    void editingProviderId;
    void selectedProviderId;
    void providerCheck;
    void checkedProviderId;
    return <section className="inspector empty-inspector" aria-label={t("Model Workbench")} />;
  }

  if (activeView === "media") {
    const mediaJobId = selectedEntity.type === "mediaJob" ? selectedEntity.id : selectedMediaJobId;
    return (
      <MediaJobInspector
        mediaJob={mediaJobs.find((job) => job.id === mediaJobId) ?? mediaJobs[0]}
        providers={providers}
        artifacts={mediaJobId ? mediaJobArtifacts[mediaJobId] ?? [] : []}
        cwd={cwd}
      />
    );
  }

  if (activeView === "approvals") {
    const approvalId = selectedEntity.type === "approval" ? selectedEntity.id : selectedApprovalId;
    return (
      <ApprovalInspector
        approval={approvals.find((item) => item.id === approvalId) ?? approvals[0]}
        approvals={approvals}
        resolvingApprovals={resolvingApprovals}
        externalActionDetails={externalActionDetails}
        externalActionBusy={externalActionBusy}
        cwd={cwd}
        onResolveApproval={onResolveApproval}
        onExecuteExternalAction={onExecuteExternalAction}
        onCancelExternalAction={onCancelExternalAction}
      />
    );
  }

  if (activeView === "settings") {
    return <SettingsInspector policy={approvalPolicy} form={approvalPolicyForm} externalWorkStatus={externalWorkStatus} />;
  }

  if (activeView === "teammates") {
    return (
      <section className="inspector" aria-label={t("AI teammate context")}>
        <div className="panel-title">
          <SquareTerminal size={18} />
          <h2>{t("AI teammate context")}</h2>
        </div>
        <p className="muted">{t("Choose or create a teammate in the main panel. Conversation entry points now live with the teammate workspace instead of the global sidebar.")}</p>
      </section>
    );
  }

  const selectedTaskCiTriage = selectedTask
    ? externalWorkCiTriage.filter((record) =>
      record.triage.taskId === selectedTask.id ||
      record.task?.id === selectedTask.id ||
      (selectedTask.currentRunId ? record.triage.runId === selectedTask.currentRunId || record.run?.id === selectedTask.currentRunId : false),
    )
    : [];

  return (
    <section className="inspector workspace-task-inspector" aria-label={t("Task inspector")}>
      <div className="panel-title">
        <SquareTerminal size={18} />
        <h2>{t("Task context")}</h2>
      </div>
      {selectedTask ? (
        <div className="meta-list">
          <MetaRow label={t("Task")} value={selectedTask.title} compact />
          <MetaRow label={t("Status")} value={t(selectedTask.status)} />
          <MetaRow label={t("Updated")} value={formatDateTime(selectedTask.updatedAt)} compact />
        </div>
      ) : (
        <div className="empty-state compact-empty">
          <SquareTerminal />
          <span>{t("No task selected")}</span>
        </div>
      )}
      <CiTriageAuditPanel
        records={selectedTaskCiTriage}
        loading={externalWorkCiTriageLoading}
        compact
        cwd={cwd}
      />
      <RunTimeline
        events={events}
        assistantText={assistantText}
        errorMessage={errorMessage}
        isRunning={isRunning}
        pendingApprovals={pendingApprovals}
        approvalsLoading={approvalsLoading}
        resolvingApprovals={resolvingApprovals}
        onRefreshApprovals={onRefreshApprovals}
        onResolveApproval={onResolveApproval}
      />
    </section>
  );
}

function MediaJobInspector({
  mediaJob,
  providers,
  artifacts,
  cwd,
}: {
  readonly mediaJob: MediaJob | undefined;
  readonly providers: readonly ProviderPreset[];
  readonly artifacts: readonly RunArtifact[];
  readonly cwd: string;
}): JSX.Element {
  const { t } = useI18n();
  const provider = mediaJob ? providers.find((item) => item.id === mediaJob.providerPresetId) : undefined;
  return (
    <section className="inspector" aria-label={t("Generation task context")}>
      <div className="panel-title">
        <Database size={18} />
        <h2>{t("Generation task context")}</h2>
      </div>
      {mediaJob ? (
        <>
          <div className="meta-list">
            <MetaRow label={t("Status")} value={t(mediaJob.status)} />
            <MetaRow label={t("Provider")} value={provider?.displayName ?? t("Unknown provider")} compact />
            <MetaRow label={t("Operation")} value={mediaJob.operation} compact />
            <MetaRow label={t("Artifacts")} value={String(mediaJob.artifactIds.length)} />
          </div>
          <p className="muted">{mediaJob.prompt}</p>
          {artifacts.length > 0 ? (
            <div className="artifact-list">
              {artifacts.map((artifact) => (
                <ArtifactRow key={artifact.id} artifact={artifact} cwd={cwd} />
              ))}
            </div>
          ) : null}
        </>
      ) : (
        <div className="empty-state compact-empty">
          <Database />
          <span>{t("No generation tasks recorded for this workspace")}</span>
        </div>
      )}
    </section>
  );
}

function ApprovalInspector({
  approval,
  approvals,
  resolvingApprovals,
  externalActionDetails,
  externalActionBusy,
  cwd,
  onResolveApproval,
  onExecuteExternalAction,
  onCancelExternalAction,
}: {
  readonly approval: ApprovalRequest | undefined;
  readonly approvals: readonly ApprovalRequest[];
  readonly resolvingApprovals: Readonly<Record<string, ApprovalResolution>>;
  readonly externalActionDetails: Readonly<Record<string, ExternalWorkActionView>>;
  readonly externalActionBusy: Readonly<Record<string, ExternalActionBusyState>>;
  readonly cwd: string;
  readonly onResolveApproval: (approvalId: string, decision: ApprovalResolution, reason?: string) => void;
  readonly onExecuteExternalAction: (actionId: string) => void;
  readonly onCancelExternalAction: (actionId: string) => void;
}): JSX.Element {
  const { t } = useI18n();
  const pendingCount = approvals.filter((item) => effectiveApprovalStatus(item) === "pending").length;
  return (
    <section className="inspector" aria-label={t("Approval context")}>
      <div className="panel-title">
        <ShieldCheck size={18} />
        <h2>{t("Approval context")}</h2>
      </div>
      <div className="meta-list">
        <MetaRow label={t("Pending approvals")} value={String(pendingCount)} />
        <MetaRow label={t("Total")} value={String(approvals.length)} />
      </div>
      {approval ? (
        <ApprovalCard
          approval={approval}
          compact
          externalAction={approval.externalWorkActionId ? externalActionDetails[approval.externalWorkActionId] : undefined}
          externalActionBusy={approval.externalWorkActionId ? externalActionBusy[approval.externalWorkActionId] : undefined}
          cwd={cwd}
          resolvingDecision={resolvingApprovals[approval.id]}
          onResolve={onResolveApproval}
          onExecuteExternalAction={onExecuteExternalAction}
          onCancelExternalAction={onCancelExternalAction}
        />
      ) : (
        <div className="empty-state compact-empty">
          <ShieldCheck />
          <span>{t("No approval requests for this workspace")}</span>
        </div>
      )}
    </section>
  );
}

function SettingsInspector({
  form,
  externalWorkStatus,
}: {
  readonly policy: ApprovalPolicy | undefined;
  readonly form: ApprovalPolicyFormState;
  readonly externalWorkStatus: ExternalWorkStatusResponse | undefined;
}): JSX.Element {
  const { t } = useI18n();
  const decisions = Object.values(form.toolDecisions);
  const askCount = decisions.filter((decision) => decision === "ask").length;
  const denyCount = decisions.filter((decision) => decision === "deny").length;
  const allowCount = decisions.filter((decision) => decision === "allow").length;
  return (
    <section className="inspector" aria-label={t("Settings preview")}>
      <div className="panel-title">
        <Settings size={18} />
        <h2>{t("Settings preview")}</h2>
      </div>
      <div className="meta-list">
        <MetaRow label={t("Allow")} value={String(allowCount)} />
        <MetaRow label={t("Ask")} value={String(askCount)} />
        <MetaRow label={t("Deny")} value={String(denyCount)} />
      </div>
      <div className="provider-run-notice neutral">
        <FileText size={16} />
        <span>{t("This preview follows the approval policy form. Save policy to apply it to future runs.")}</span>
      </div>
      <div className="meta-list">
        <MetaRow label={t("External work")} value={externalWorkStatus ? externalWorkStatus.workflow.sourceKind : t("not loaded")} compact />
        <MetaRow label={t("Target")} value={externalWorkStatus?.workflow.repository ?? externalWorkStatus?.workflow.projectSlug ?? "-"} compact />
        <MetaRow label={t("Workflow")} value={externalWorkStatus?.workflow.valid ? t("valid") : externalWorkStatus?.workflow.exists === false ? t("missing") : t("invalid")} compact />
        <MetaRow label={t("Token")} value={externalWorkStatus?.secret.status ?? "not_required"} compact />
        <MetaRow label={t("Background")} value={externalWorkStatus?.background.status ?? "not_configured"} compact />
        <MetaRow label={t("Records")} value={String(externalWorkStatus?.records.externalWork.total ?? 0)} compact />
      </div>
    </section>
  );
}
