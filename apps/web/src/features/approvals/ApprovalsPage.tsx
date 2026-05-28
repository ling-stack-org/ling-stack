import { useState } from "react";
import {
  CheckCircle2,
  CircleAlert,
  History,
  Loader2,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { useI18n } from "../../i18n.js";
import {
  approvalOwnerLabels,
  approvalTimingLabel,
  effectiveApprovalStatus,
  highestApprovalRisk,
} from "../../lib/approvals.js";
import { formatEventData, readDataString } from "../../lib/data.js";
import { formatDateTime } from "../../lib/formatting.js";
import { readTaskTitle } from "../../lib/run-evidence.js";
import type { ApprovalRequest, RunSession } from "../../types.js";
import type { ApprovalResolution } from "./types.js";

export function ApprovalsPage({
  cwd,
  approvals,
  repairRunId,
  repairRun,
  selectedApprovalId,
  isLoading,
  resolvingApprovals,
  errorMessage,
  onCwdChange,
  onRefresh,
  onSelectApproval,
  onRefreshRepair,
  onResolve,
  onOpenRun,
  onClearRepair,
}: {
  readonly cwd: string;
  readonly approvals: readonly ApprovalRequest[];
  readonly repairRunId: string;
  readonly repairRun: RunSession | undefined;
  readonly selectedApprovalId: string;
  readonly isLoading: boolean;
  readonly resolvingApprovals: Readonly<Record<string, ApprovalResolution>>;
  readonly errorMessage: string;
  readonly onCwdChange: (cwd: string) => void;
  readonly onRefresh: () => void;
  readonly onSelectApproval: (approvalId: string) => void;
  readonly onRefreshRepair: (runId: string) => void;
  readonly onResolve: (approvalId: string, decision: ApprovalResolution, reason?: string) => void;
  readonly onOpenRun: (runId: string) => void;
  readonly onClearRepair: () => void;
}): JSX.Element {
  const { t } = useI18n();
  const focusedApprovals = repairRunId ? approvals.filter((approval) => approval.runId === repairRunId) : approvals;
  const listEmptyCopy = repairRunId ? t("No approval records for this run") : t("No approval requests for this workspace");

  return (
    <section className="panel approvals-panel" aria-labelledby="approvals-title">
      <div className="panel-title split">
        <span>
          <ShieldCheck size={18} />
          <h2 id="approvals-title">{t("Approval requests")}</h2>
        </span>
        <button
          className="secondary-button compact-button"
          type="button"
          onClick={repairRunId ? () => onRefreshRepair(repairRunId) : onRefresh}
          disabled={isLoading}
        >
          {isLoading ? <Loader2 className="spin" size={15} /> : <RefreshCw size={15} />}
          {t("Refresh")}
        </button>
      </div>

      <label className="field wide runs-cwd">
        <span>{t("Workspace path")}</span>
        <input value={cwd} onChange={(event) => onCwdChange(event.target.value)} />
      </label>

      {errorMessage ? (
        <div className="inline-error">
          <CircleAlert size={17} />
          {errorMessage}
        </div>
      ) : null}

      {repairRunId ? (
        <ApprovalRunRepairPanel
          runId={repairRunId}
          run={repairRun}
          approvals={focusedApprovals}
          isLoading={isLoading}
          onRefresh={() => onRefreshRepair(repairRunId)}
          onOpenRun={() => onOpenRun(repairRunId)}
          onClear={onClearRepair}
        />
      ) : null}

      <div className="approval-list">
        {focusedApprovals.length === 0 ? (
          <div className="empty-state compact-empty">
            {isLoading ? <Loader2 className="spin" /> : <ShieldCheck />}
            <span>{isLoading ? t("Loading approvals...") : listEmptyCopy}</span>
          </div>
        ) : (
          focusedApprovals.map((approval) => (
            <ApprovalCard
              key={approval.id}
              approval={approval}
              selected={approval.id === selectedApprovalId}
              resolvingDecision={resolvingApprovals[approval.id]}
              onSelect={onSelectApproval}
              onResolve={onResolve}
            />
          ))
        )}
      </div>
    </section>
  );
}

function ApprovalRunRepairPanel({
  runId,
  run,
  approvals,
  isLoading,
  onRefresh,
  onOpenRun,
  onClear,
}: {
  readonly runId: string;
  readonly run: RunSession | undefined;
  readonly approvals: readonly ApprovalRequest[];
  readonly isLoading: boolean;
  readonly onRefresh: () => void;
  readonly onOpenRun: () => void;
  readonly onClear: () => void;
}): JSX.Element {
  const pendingApprovals = approvals.filter((approval) => effectiveApprovalStatus(approval) === "pending");
  const resolvedApprovals = approvals.filter((approval) => effectiveApprovalStatus(approval) !== "pending");
  const highestRisk = highestApprovalRisk(approvals);
  const actionTypes = [...new Set(approvals.map((approval) => approval.actionType))];
  const taskLabel = run ? readTaskTitle(run.taskSnapshot) || run.taskId : approvals[0]?.taskId ?? "-";

  return (
    <div className="approval-run-repair" aria-label="Approval run repair">
      <div className="approval-run-repair-head">
        <span>
          <ShieldCheck size={16} />
          <strong>Resolve run approvals</strong>
        </span>
        <button className="secondary-button compact-button" type="button" onClick={onClear}>
          Clear
        </button>
      </div>
      <div className="approval-run-repair-copy">
        <span>
          Run <code>{runId}</code> is focused for approval repair.
        </span>
        <small>Task: {taskLabel}</small>
      </div>
      <div className="approval-run-repair-meta">
        <span className="approval-state pending">{pendingApprovals.length} pending</span>
        <span className="approval-state approved">{resolvedApprovals.length} resolved</span>
        <span className={`approval-risk ${highestRisk}`}>{highestRisk}</span>
        {actionTypes.length > 0 ? <span className="approval-state">{actionTypes.join(", ")}</span> : null}
      </div>
      <div className="approval-run-repair-actions">
        <button className="secondary-button compact-button" type="button" onClick={onRefresh} disabled={isLoading}>
          {isLoading ? <Loader2 className="spin" size={14} /> : <RefreshCw size={14} />}
          Reload
        </button>
        <button className="primary-button compact-button" type="button" onClick={onOpenRun}>
          <History size={14} />
          Back to run
        </button>
      </div>
    </div>
  );
}

export function ApprovalCard({
  approval,
  compact = false,
  selected = false,
  resolvingDecision,
  onSelect,
  onResolve,
}: {
  readonly approval: ApprovalRequest;
  readonly compact?: boolean;
  readonly selected?: boolean;
  readonly resolvingDecision?: ApprovalResolution;
  readonly onSelect?: (approvalId: string) => void;
  readonly onResolve: (approvalId: string, decision: ApprovalResolution, reason?: string) => void;
}): JSX.Element {
  const { t } = useI18n();
  const [decisionReason, setDecisionReason] = useState("");
  const [confirmDecision, setConfirmDecision] = useState<ApprovalResolution | undefined>();
  const [reasonError, setReasonError] = useState("");
  const isResolving = Boolean(resolvingDecision);
  const requiresSecondConfirmation = approval.risk === "high" || approval.risk === "critical";
  const trimmedReason = decisionReason.trim();
  const effectiveStatus = effectiveApprovalStatus(approval);
  const timing = approvalTimingLabel(approval);
  const ownerLabels = approvalOwnerLabels(approval);

  function submitDecision(decision: ApprovalResolution): void {
    if (isResolving || effectiveStatus !== "pending") {
      return;
    }

    if (decision === "approve" && requiresSecondConfirmation) {
      if (confirmDecision !== "approve") {
        setConfirmDecision("approve");
        setReasonError(trimmedReason ? "" : t("High-risk approvals need a decision reason."));
        return;
      }
      if (!trimmedReason) {
        setReasonError(t("High-risk approvals need a decision reason."));
        return;
      }
    }

    setConfirmDecision(undefined);
    setReasonError("");
    onResolve(approval.id, decision, trimmedReason || undefined);
  }

  return (
    <article
      className={`approval-row ${approval.risk}${compact ? " compact" : ""}${selected ? " selected" : ""}`}
      onClick={() => onSelect?.(approval.id)}
    >
      <div className="approval-main">
        <div className="approval-head">
          <strong>{approval.title}</strong>
          <span className={`approval-state ${effectiveStatus}`}>{effectiveStatus}</span>
          <span className={`approval-risk ${approval.risk}`}>{approval.risk}</span>
        </div>
        <p>{approval.description}</p>
        <div className="provider-meta-line">
          <span>{approval.actionType}</span>
          {ownerLabels.map((label) => <span key={label}>{label}</span>)}
          <time>{formatDateTime(approval.createdAt)}</time>
          {timing ? <time>{timing}</time> : null}
          {approval.resolvedAt ? <time>{t("resolved {time}", { time: formatDateTime(approval.resolvedAt) })}</time> : null}
        </div>
        {approval.decisionReason ? <p className="approval-decision-reason">{approval.decisionReason}</p> : null}
        <ApprovalPayloadSummary approval={approval} />
        <pre>{formatEventData(approval.payload)}</pre>
      </div>
      {effectiveStatus === "pending" ? (
        <div className="approval-decision-panel">
          <label className="approval-reason-field">
            <span>{t("Decision reason")}</span>
            <textarea
              value={decisionReason}
              rows={compact ? 2 : 3}
              placeholder={requiresSecondConfirmation ? t("Required before approving high-risk requests") : t("Optional note for the audit log")}
              disabled={isResolving}
              onChange={(event) => {
                setDecisionReason(event.target.value);
                if (event.target.value.trim()) {
                  setReasonError("");
                }
              }}
            />
          </label>
          {reasonError ? <p className="approval-reason-error">{reasonError}</p> : null}
          {confirmDecision === "approve" ? (
            <div className="approval-confirm-panel" role="alert">
              <CircleAlert size={15} />
              <span>{t("High-risk approval. Review the payload and reason, then confirm.")}</span>
              <button className="secondary-button compact-button" type="button" onClick={() => setConfirmDecision(undefined)} disabled={isResolving}>
                {t("Cancel")}
              </button>
            </div>
          ) : null}
          <div className="approval-actions">
            <button
              className={confirmDecision === "approve" ? "secondary-button compact-button danger" : "secondary-button compact-button"}
              type="button"
              onClick={() => submitDecision("approve")}
              disabled={isResolving}
            >
              {resolvingDecision === "approve" ? <Loader2 className="spin" size={14} /> : <CheckCircle2 size={14} />}
              {resolvingDecision === "approve" ? t("Approving") : confirmDecision === "approve" ? t("Confirm approve") : t("Approve")}
            </button>
            <button
              className="secondary-button compact-button danger"
              type="button"
              onClick={() => submitDecision("deny")}
              disabled={isResolving}
            >
              {resolvingDecision === "deny" ? <Loader2 className="spin" size={14} /> : <CircleAlert size={14} />}
              {resolvingDecision === "deny" ? t("Denying") : t("Deny")}
            </button>
          </div>
        </div>
      ) : null}
    </article>
  );
}

function ApprovalPayloadSummary({ approval }: { readonly approval: ApprovalRequest }): JSX.Element | null {
  const { t } = useI18n();

  if (approval.actionType !== "media_cost" || readDataString(approval.payload, "type") !== "media_cost") {
    return null;
  }

  const providerPresetId = readDataString(approval.payload, "providerPresetId") || "-";
  const model = readDataString(approval.payload, "model") || "-";
  const operation = readDataString(approval.payload, "operation") || "-";
  const promptPreview = readDataString(approval.payload, "promptPreview");

  return (
    <div className="approval-payload-summary" aria-label="Media cost approval summary">
      <span>{t("provider {providerPresetId}", { providerPresetId })}</span>
      <span>{t("model {model}", { model })}</span>
      <span>{t("operation {operation}", { operation })}</span>
      {promptPreview ? <p>{promptPreview}</p> : null}
    </div>
  );
}
