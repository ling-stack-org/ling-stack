import { useState } from "react";
import {
  CheckCircle2,
  CircleAlert,
  ExternalLink,
  FileText,
  History,
  Loader2,
  RefreshCw,
  Send,
  ShieldCheck,
  Tags,
} from "lucide-react";
import { useI18n } from "../../i18n.js";
import {
  approvalOwnerLabels,
  approvalTimingLabel,
  effectiveApprovalStatus,
  highestApprovalRisk,
} from "../../lib/approvals.js";
import { formatEventData, formatUnknownPreview, readDataField, readDataString } from "../../lib/data.js";
import { formatDateTime } from "../../lib/formatting.js";
import { readTaskTitle } from "../../lib/run-evidence.js";
import { ArtifactRow } from "../../shared/components/index.js";
import type { ApprovalRequest, ExternalWorkActionView, RunSession } from "../../types.js";
import type { ApprovalResolution } from "./types.js";

export type ExternalActionBusyState = "execute" | "cancel";

export function ApprovalsPage({
  cwd,
  approvals,
  repairRunId,
  repairRun,
  selectedApprovalId,
  externalActionDetails,
  externalActionBusy,
  isLoading,
  resolvingApprovals,
  errorMessage,
  onRefresh,
  onSelectApproval,
  onRefreshRepair,
  onResolve,
  onExecuteExternalAction,
  onCancelExternalAction,
  onOpenRun,
  onClearRepair,
}: {
  readonly cwd: string;
  readonly approvals: readonly ApprovalRequest[];
  readonly repairRunId: string;
  readonly repairRun: RunSession | undefined;
  readonly selectedApprovalId: string;
  readonly externalActionDetails: Readonly<Record<string, ExternalWorkActionView>>;
  readonly externalActionBusy: Readonly<Record<string, ExternalActionBusyState>>;
  readonly isLoading: boolean;
  readonly resolvingApprovals: Readonly<Record<string, ApprovalResolution>>;
  readonly errorMessage: string;
  readonly onRefresh: () => void;
  readonly onSelectApproval: (approvalId: string) => void;
  readonly onRefreshRepair: (runId: string) => void;
  readonly onResolve: (approvalId: string, decision: ApprovalResolution, reason?: string) => void;
  readonly onExecuteExternalAction: (actionId: string) => void;
  readonly onCancelExternalAction: (actionId: string) => void;
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
              externalAction={approval.externalWorkActionId ? externalActionDetails[approval.externalWorkActionId] : undefined}
              externalActionBusy={approval.externalWorkActionId ? externalActionBusy[approval.externalWorkActionId] : undefined}
              cwd={cwd}
              resolvingDecision={resolvingApprovals[approval.id]}
              onSelect={onSelectApproval}
              onResolve={onResolve}
              onExecuteExternalAction={onExecuteExternalAction}
              onCancelExternalAction={onCancelExternalAction}
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
  externalAction,
  externalActionBusy,
  cwd,
  resolvingDecision,
  onSelect,
  onResolve,
  onExecuteExternalAction,
  onCancelExternalAction,
}: {
  readonly approval: ApprovalRequest;
  readonly compact?: boolean;
  readonly selected?: boolean;
  readonly externalAction?: ExternalWorkActionView;
  readonly externalActionBusy?: ExternalActionBusyState;
  readonly cwd?: string;
  readonly resolvingDecision?: ApprovalResolution;
  readonly onSelect?: (approvalId: string) => void;
  readonly onResolve: (approvalId: string, decision: ApprovalResolution, reason?: string) => void;
  readonly onExecuteExternalAction?: (actionId: string) => void;
  readonly onCancelExternalAction?: (actionId: string) => void;
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
        <ExternalActionAuditPanel
          approval={approval}
          actionView={externalAction}
          busyState={externalActionBusy}
          cwd={cwd}
          compact={compact}
          onExecuteExternalAction={onExecuteExternalAction}
          onCancelExternalAction={onCancelExternalAction}
        />
        <details className="json-details compact-json">
          <summary>{t("Audit details")}</summary>
          <pre>{formatEventData(approval.payload)}</pre>
        </details>
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

function ExternalActionAuditPanel({
  approval,
  actionView,
  busyState,
  cwd,
  compact,
  onExecuteExternalAction,
  onCancelExternalAction,
}: {
  readonly approval: ApprovalRequest;
  readonly actionView?: ExternalWorkActionView;
  readonly busyState?: ExternalActionBusyState;
  readonly cwd?: string;
  readonly compact?: boolean;
  readonly onExecuteExternalAction?: (actionId: string) => void;
  readonly onCancelExternalAction?: (actionId: string) => void;
}): JSX.Element | null {
  const { t } = useI18n();
  const payloadType = readDataString(approval.payload, "type");
  const hasExternalActionPayload = payloadType === "external_action";
  const action = actionView?.action;
  if (!action && !hasExternalActionPayload && !approval.externalWorkActionId) {
    return null;
  }

  const target = action?.target;
  const fallbackTarget = readDataField(approval.payload, "target");
  const targetRecord = isRecord(fallbackTarget) ? fallbackTarget : {};
  const repository = target?.repository ?? readRecordScalar(targetRecord, "repository") ?? "-";
  const subjectKind = target?.subjectKind ?? readRecordScalar(targetRecord, "subjectKind") ?? "-";
  const subjectNumber = target?.number !== undefined ? String(target.number) : readRecordScalar(targetRecord, "number") ?? "-";
  const targetUrl = target?.url ?? readRecordScalar(targetRecord, "url");
  const expectedState = target?.expectedState ?? readRecordScalar(targetRecord, "expectedState") ?? "-";
  const expectedHeadSha = target?.expectedHeadSha ?? readRecordScalar(targetRecord, "expectedHeadSha") ?? "";
  const expectedUpdatedAt = target?.expectedUpdatedAt ?? readRecordScalar(targetRecord, "expectedUpdatedAt") ?? "";
  const actionKind = action?.actionKind || readDataString(approval.payload, "actionKind") || "-";
  const sourceKind = action?.sourceKind || readDataString(approval.payload, "sourceKind") || "-";
  const actionStatus = action?.status ?? t("detail unavailable");
  const preview = action ? externalActionPayloadPreview(action.payload) : readDataString(approval.payload, "preview") || formatUnknownPreview(readDataField(approval.payload, "payload"), 220);
  const labels = action?.payload.type === "github_label" ? action.payload.labels : [];
  const reviewEvent = action?.payload.type === "github_pr_review" ? action.payload.event : undefined;
  const artifacts = actionView?.artifacts ?? [];
  const canExecute = Boolean(action && action.status === "approved" && onExecuteExternalAction);
  const canCancel = Boolean(action && ["proposed", "waiting_for_approval", "approved"].includes(action.status) && onCancelExternalAction);
  const isBusy = Boolean(busyState);

  return (
    <div className={compact ? "external-action-audit compact" : "external-action-audit"} aria-label={t("External action audit")}>
      <div className="external-action-audit-head">
        <span>
          {action?.payload.type === "github_label" ? <Tags size={14} /> : <FileText size={14} />}
          <strong>{t("External action")}</strong>
        </span>
        <span className={`approval-state ${action?.status ?? "pending"}`}>{actionStatus}</span>
      </div>
      <details className="json-details compact-json">
        <summary>{t("Audit details")}</summary>
        <div className="external-action-meta">
          <span>{sourceKind}</span>
          <span>{actionKind}</span>
          {reviewEvent ? <span>{reviewEvent}</span> : null}
          <span>{repository}</span>
          <span>{subjectKind} #{subjectNumber}</span>
          <span>{t("expected {state}", { state: expectedState })}</span>
          {expectedHeadSha ? <span>{t("head {sha}", { sha: shortSha(expectedHeadSha) })}</span> : null}
          {expectedUpdatedAt ? <time>{t("updated {time}", { time: formatDateTime(expectedUpdatedAt) })}</time> : null}
          {action ? <span>{t("{count} attempts", { count: action.executionAttemptCount })}</span> : null}
        </div>
        {targetUrl ? (
          <a className="external-action-target-link" href={targetUrl} target="_blank" rel="noreferrer">
            <ExternalLink size={13} />
            {targetUrl}
          </a>
        ) : null}
        {preview ? (
          <div className="external-action-preview">
            <strong>{t("Payload preview")}</strong>
            {labels.length > 0 ? (
              <div className="external-action-labels">
                {labels.map((label) => <span key={label}>{label}</span>)}
              </div>
            ) : (
              <p>{preview}</p>
            )}
          </div>
        ) : null}
      </details>
      {action?.lastErrorMessage ? (
        <div className="external-action-error">
          <CircleAlert size={14} />
          <span>{action.lastErrorCode ? `${action.lastErrorCode}: ${action.lastErrorMessage}` : action.lastErrorMessage}</span>
        </div>
      ) : null}
      {artifacts.length > 0 ? (
        <div className="external-action-artifacts" aria-label={t("External action artifacts")}>
          {artifacts.map((artifact) => <ArtifactRow key={artifact.id} artifact={artifact} cwd={cwd} />)}
        </div>
      ) : null}
      {action ? (
        <div className="external-action-controls">
          {canExecute ? (
            <button className="primary-button compact-button" type="button" disabled={isBusy} onClick={() => onExecuteExternalAction?.(action.id)}>
              {busyState === "execute" ? <Loader2 className="spin" size={14} /> : <Send size={14} />}
              {busyState === "execute" ? t("Executing") : t("Execute action")}
            </button>
          ) : null}
          {canCancel ? (
            <button className="secondary-button compact-button danger" type="button" disabled={isBusy} onClick={() => onCancelExternalAction?.(action.id)}>
              {busyState === "cancel" ? <Loader2 className="spin" size={14} /> : <CircleAlert size={14} />}
              {busyState === "cancel" ? t("Cancelling") : t("Cancel proposal")}
            </button>
          ) : null}
        </div>
      ) : approval.externalWorkActionId ? (
        <p className="external-action-missing">{t("Action detail could not be loaded. Showing approval preview only.")}</p>
      ) : null}
    </div>
  );
}

function ApprovalPayloadSummary({ approval }: { readonly approval: ApprovalRequest }): JSX.Element | null {
  const { t } = useI18n();
  const payloadType = readDataString(approval.payload, "type");

  if (payloadType === "bash") {
    const command = readDataString(approval.payload, "command");
    const cwd = readDataString(approval.payload, "cwd");
    const riskFlags = readStringList(readDataField(approval.payload, "riskFlags"));
    return (
      <div className="approval-payload-summary" aria-label="Shell command approval summary">
        {cwd ? <span>{t("cwd {cwd}", { cwd })}</span> : null}
        {riskFlags.length > 0 ? <span>{t("risk {risk}", { risk: riskFlags.join(", ") })}</span> : null}
        {command ? <code>{command}</code> : null}
      </div>
    );
  }

  if (payloadType === "file_write" || payloadType === "file_edit") {
    const path = readDataString(approval.payload, "path") || "-";
    const bytes = readDataField(approval.payload, "bytes");
    const preview = payloadType === "file_edit"
      ? readDataString(approval.payload, "diffPreview")
      : readDataString(approval.payload, "preview");
    return (
      <div className="approval-payload-summary" aria-label="File mutation approval summary">
        <span>{t("path {path}", { path })}</span>
        {typeof bytes === "number" ? <span>{t("{count} bytes", { count: bytes })}</span> : null}
        {preview ? <pre>{preview}</pre> : null}
      </div>
    );
  }

  if (payloadType === "workflow_step") {
    const title = readDataString(approval.payload, "title") || approval.title;
    const approvalMode = readDataString(approval.payload, "approvalMode") || "-";
    const requiredForTools = readStringList(readDataField(approval.payload, "requiredForTools"));
    const requiredForActions = readStringList(readDataField(approval.payload, "requiredForActions"));
    return (
      <div className="approval-payload-summary" aria-label="Workflow step approval summary">
        <span>{t("step {step}", { step: title })}</span>
        <span>{t("mode {mode}", { mode: approvalMode })}</span>
        {requiredForTools.length > 0 ? <span>{t("tools {tools}", { tools: requiredForTools.join(", ") })}</span> : null}
        {requiredForActions.length > 0 ? <span>{t("actions {actions}", { actions: requiredForActions.join(", ") })}</span> : null}
      </div>
    );
  }

  if (payloadType === "mcp_tool_call" || payloadType === "tool_call") {
    const toolName = readDataString(approval.payload, "toolName") || "-";
    const cwd = readDataString(approval.payload, "cwd");
    const input = readDataField(approval.payload, "input");
    return (
      <div className="approval-payload-summary" aria-label="Tool approval summary">
        <span>{t("tool {tool}", { tool: toolName })}</span>
        {cwd ? <span>{t("cwd {cwd}", { cwd })}</span> : null}
        {input ? <p>{formatUnknownPreview(input, 240)}</p> : null}
      </div>
    );
  }

  if (payloadType === "deploy") {
    const target = readDataString(approval.payload, "target") || "-";
    const environment = readDataString(approval.payload, "environment");
    const command = readDataString(approval.payload, "command");
    return (
      <div className="approval-payload-summary" aria-label="Deploy approval summary">
        <span>{t("target {target}", { target })}</span>
        {environment ? <span>{t("environment {environment}", { environment })}</span> : null}
        {command ? <code>{command}</code> : null}
      </div>
    );
  }

  if (payloadType === "provider_change") {
    const providerPresetId = readDataString(approval.payload, "providerPresetId") || "-";
    const changedFields = readStringList(readDataField(approval.payload, "changedFields"));
    return (
      <div className="approval-payload-summary" aria-label="Provider change approval summary">
        <span>{t("provider {provider}", { provider: providerPresetId })}</span>
        {changedFields.length > 0 ? <span>{t("fields {fields}", { fields: changedFields.join(", ") })}</span> : null}
      </div>
    );
  }

  if (approval.actionType === "external_send" && payloadType === "external_action") {
    const sourceKind = readDataString(approval.payload, "sourceKind") || "-";
    const actionKind = readDataString(approval.payload, "actionKind") || "-";
    const preview = readDataString(approval.payload, "preview");
    const target = readDataField(approval.payload, "target");
    return (
      <div className="approval-payload-summary" aria-label="External action approval summary">
        <span>{t("source {sourceKind}", { sourceKind })}</span>
        <span>{t("action {actionKind}", { actionKind })}</span>
        {target ? <span>{t("target {target}", { target: formatUnknownPreview(target, 120) })}</span> : null}
        {preview ? <p>{preview}</p> : null}
      </div>
    );
  }

  if (approval.actionType !== "media_cost" || payloadType !== "media_cost") {
    return null;
  }

  const model = readDataString(approval.payload, "model") || "-";
  const operation = readDataString(approval.payload, "operation") || "-";
  const promptPreview = readDataString(approval.payload, "promptPreview");

  return (
    <div className="approval-payload-summary" aria-label="Media cost approval summary">
      <span>{t("model {model}", { model })}</span>
      <span>{t("operation {operation}", { operation })}</span>
      {promptPreview ? <p>{promptPreview}</p> : null}
    </div>
  );
}

function readStringList(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

function externalActionPayloadPreview(payload: ExternalWorkActionView["action"]["payload"]): string {
  if (payload.type === "github_comment") {
    return formatUnknownPreview(payload.body, 320);
  }
  if (payload.type === "github_pr_review") {
    return `${payload.event}: ${formatUnknownPreview(payload.body, 320)}`;
  }
  return payload.labels.join(", ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readRecordScalar(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (typeof value === "string" && value) {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}

function shortSha(value: string): string {
  return value.length > 12 ? value.slice(0, 12) : value;
}
