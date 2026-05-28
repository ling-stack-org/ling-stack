import {
  CheckCircle2,
  CircleAlert,
  Database,
  FileText,
  PlugZap,
  Settings,
  ShieldCheck,
  SquareTerminal,
} from "lucide-react";
import { useI18n } from "../../i18n.js";
import { effectiveApprovalStatus } from "../../lib/approvals.js";
import { formatDateTime } from "../../lib/formatting.js";
import {
  providerNeedsSecret,
  providerPreflightReady,
  providerRunPreflightBlocker,
} from "../../lib/providers.js";
import { ArtifactRow, MetaRow, StatusBadge } from "../../shared/components/index.js";
import type {
  ApprovalPolicy,
  ApprovalPolicyFormState,
  ApprovalRequest,
  MediaJob,
  ProviderCheckResult,
  ProviderPreset,
  RunArtifact,
  RunEventEnvelope,
  RunSession,
  Task,
} from "../../types.js";
import type { SelectedEntity, ViewId } from "../../app/view-types.js";
import { ApprovalCard, type ApprovalResolution } from "../approvals/index.js";
import { RunInspector, RunTimeline } from "../runs/index.js";

export function PageInspector({
  activeView,
  selectedEntity,
  selectedTask,
  selectedRun,
  activeRunId,
  lookupRunId,
  events,
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
  approvalPolicy,
  approvalPolicyForm,
  onLookupRunIdChange,
  onLoadRun,
  onRefreshApprovals,
  onResolveApproval,
}: {
  readonly activeView: ViewId;
  readonly selectedEntity: SelectedEntity;
  readonly selectedTask: Task | undefined;
  readonly selectedRun: RunSession | undefined;
  readonly activeRunId: string;
  readonly lookupRunId: string;
  readonly events: readonly RunEventEnvelope[];
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
  readonly approvalPolicy: ApprovalPolicy | undefined;
  readonly approvalPolicyForm: ApprovalPolicyFormState;
  readonly onLookupRunIdChange: (runId: string) => void;
  readonly onLoadRun: () => void;
  readonly onRefreshApprovals: () => void;
  readonly onResolveApproval: (approvalId: string, decision: ApprovalResolution, reason?: string) => void;
}): JSX.Element {
  if (activeView === "runs") {
    return (
      <RunInspector
        activeRunId={activeRunId}
        lookupRunId={lookupRunId}
        run={selectedRun}
        events={events}
        onLookupRunIdChange={onLookupRunIdChange}
        onLoadRun={onLoadRun}
      />
    );
  }

  if (activeView === "providers") {
    const providerId = selectedEntity.type === "provider" ? selectedEntity.id : editingProviderId || selectedProviderId;
    return (
      <ProviderContextInspector
        provider={providers.find((provider) => provider.id === providerId) ?? providers[0]}
        providerCheck={providerCheck}
        checkedProviderId={checkedProviderId}
      />
    );
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
        onResolveApproval={onResolveApproval}
      />
    );
  }

  if (activeView === "settings") {
    return <SettingsInspector policy={approvalPolicy} form={approvalPolicyForm} />;
  }

  if (activeView === "teammates") {
    return (
      <section className="inspector" aria-label="AI teammate context">
        <div className="panel-title">
          <SquareTerminal size={18} />
          <h2>AI teammate context</h2>
        </div>
        <p className="muted">Choose or create a teammate in the main panel. Conversation entry points now live with the teammate workspace instead of the global sidebar.</p>
      </section>
    );
  }

  return (
    <section className="inspector workspace-task-inspector" aria-label="Task inspector">
      <div className="panel-title">
        <SquareTerminal size={18} />
        <h2>Task context</h2>
      </div>
      {selectedTask ? (
        <div className="meta-list">
          <MetaRow label="Task" value={selectedTask.title} compact />
          <MetaRow label="Status" value={selectedTask.status} />
          <MetaRow label="Run" value={selectedTask.currentRunId ?? "not run"} compact />
          <MetaRow label="Updated" value={formatDateTime(selectedTask.updatedAt)} compact />
        </div>
      ) : (
        <div className="empty-state compact-empty">
          <SquareTerminal />
          <span>No task selected</span>
        </div>
      )}
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

function ProviderContextInspector({
  provider,
  providerCheck,
  checkedProviderId,
}: {
  readonly provider: ProviderPreset | undefined;
  readonly providerCheck: ProviderCheckResult | undefined;
  readonly checkedProviderId: string;
}): JSX.Element {
  const { t } = useI18n();
  const checkBelongsHere = Boolean(provider && providerCheck && checkedProviderId === provider.id);
  const visibleCheck = checkBelongsHere ? providerCheck : undefined;
  const blocker = providerRunPreflightBlocker(provider);
  return (
    <section className="inspector" aria-label="Model Workbench context">
      <div className="panel-title">
        <PlugZap size={18} />
        <h2>{t("Model Workbench context")}</h2>
      </div>
      {provider ? (
        <>
          <div className="meta-list">
            <MetaRow label={t("Provider")} value={provider.displayName} />
            <MetaRow label={t("Model")} value={provider.model} compact />
            <MetaRow label={t("API")} value={provider.api} compact />
            <MetaRow label={t("Secret")} value={providerNeedsSecret(provider) ? (provider.apiKeyConfigured ? t("Saved locally") : t("API key missing")) : t("no key required")} />
          </div>
          <div className={blocker ? "provider-run-notice" : "provider-run-notice ok"}>
            {blocker ? <CircleAlert size={16} /> : <CheckCircle2 size={16} />}
            <span>{blocker ?? t("This provider can run coding tasks after selection.")}</span>
          </div>
          {visibleCheck ? (
            <div className={visibleCheck.ok ? "check-result ok" : "check-result bad"}>
              {visibleCheck.ok ? <CheckCircle2 size={16} /> : <CircleAlert size={16} />}
              <span>{visibleCheck.message}</span>
            </div>
          ) : providerPreflightReady(provider) ? (
            <p className="muted">{t("Last check is ready. Edit URL, model, or key and Save & Check to validate again.")}</p>
          ) : null}
        </>
      ) : (
        <div className="empty-state compact-empty">
          <PlugZap />
          <span>{t("No model presets")}</span>
        </div>
      )}
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
    <section className="inspector" aria-label="Media job context">
      <div className="panel-title">
        <Database size={18} />
        <h2>{t("Media job context")}</h2>
      </div>
      {mediaJob ? (
        <>
          <div className="meta-list">
            <MetaRow label={t("Status")} value={mediaJob.status} />
            <MetaRow label={t("Provider")} value={provider?.displayName ?? mediaJob.providerPresetId} compact />
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
          <span>{t("No media jobs recorded for this workspace")}</span>
        </div>
      )}
    </section>
  );
}

function ApprovalInspector({
  approval,
  approvals,
  resolvingApprovals,
  onResolveApproval,
}: {
  readonly approval: ApprovalRequest | undefined;
  readonly approvals: readonly ApprovalRequest[];
  readonly resolvingApprovals: Readonly<Record<string, ApprovalResolution>>;
  readonly onResolveApproval: (approvalId: string, decision: ApprovalResolution, reason?: string) => void;
}): JSX.Element {
  const { t } = useI18n();
  const pendingCount = approvals.filter((item) => effectiveApprovalStatus(item) === "pending").length;
  return (
    <section className="inspector" aria-label="Approval context">
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
          resolvingDecision={resolvingApprovals[approval.id]}
          onResolve={onResolveApproval}
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
  policy,
  form,
}: {
  readonly policy: ApprovalPolicy | undefined;
  readonly form: ApprovalPolicyFormState;
}): JSX.Element {
  const { t } = useI18n();
  const decisions = Object.values(form.toolDecisions);
  const askCount = decisions.filter((decision) => decision === "ask").length;
  const denyCount = decisions.filter((decision) => decision === "deny").length;
  const allowCount = decisions.filter((decision) => decision === "allow").length;
  return (
    <section className="inspector" aria-label="Settings preview">
      <div className="panel-title">
        <Settings size={18} />
        <h2>{t("Settings preview")}</h2>
      </div>
      <div className="meta-list">
        <MetaRow label={t("Workspace")} value={policy?.workspaceId ?? "-"} compact />
        <MetaRow label={t("Allow")} value={String(allowCount)} />
        <MetaRow label={t("Ask")} value={String(askCount)} />
        <MetaRow label={t("Deny")} value={String(denyCount)} />
        <MetaRow label={t("Write paths")} value={String(form.allowedWritePathsText.split("\n").filter((line) => line.trim()).length)} />
      </div>
      <div className="provider-run-notice neutral">
        <FileText size={16} />
        <span>{t("This preview follows the approval policy form. Save policy to apply it to future runs.")}</span>
      </div>
    </section>
  );
}
