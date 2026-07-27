import { Badge, Button, InlineFeedback, InspectorSection } from "../../shared/ui/index.js";
import { CircleAlert, ExternalLink, FileText, RefreshCw, Send, Tags } from "lucide-react";
import { previewArtifactContent } from "../../api.js";
import type { ExternalActionBusyState } from "../../domains/approvals/approval-domain-types.js";
import { useI18n } from "../../i18n.js";
import { formatUnknownPreview, readDataField, readDataString } from "../../lib/data.js";
import { deriveFileChangeArtifacts, fileChangeStatusFromApproval } from "../../lib/file-change-evidence.js";
import { formatDateTime } from "../../lib/formatting.js";
import { ArtifactRow } from "../../shared/components/index.js";
import { FileChangeEvidencePanel } from "../../shared/conversation/index.js";
import type { ApprovalRequest, ExternalWorkActionView } from "../../types.js";

export function ApprovalExternalActionSection({
  approval,
  actionView,
  operation,
  cwd,
  compact,
  onExecute,
  onCancel,
  onRefresh,
}: {
  readonly approval: ApprovalRequest;
  readonly actionView?: ExternalWorkActionView;
  readonly operation?: ExternalActionBusyState;
  readonly cwd?: string;
  readonly compact?: boolean;
  readonly onExecute?: (actionId: string) => void;
  readonly onCancel?: (actionId: string) => void;
  readonly onRefresh?: () => void;
}): JSX.Element | null {
  const { t } = useI18n();
  const hasExternalPayload = readDataString(approval.payload, "type") === "external_action";
  const action = actionView?.action;
  if (!action && !hasExternalPayload && !approval.externalWorkActionId) return null;
  const targetRecord = isRecord(readDataField(approval.payload, "target"))
    ? readDataField(approval.payload, "target") as Record<string, unknown>
    : {};
  const repository = action?.target.repository ?? readRecordScalar(targetRecord, "repository") ?? "-";
  const subjectKind = action?.target.subjectKind ?? readRecordScalar(targetRecord, "subjectKind") ?? "-";
  const subjectNumber = action?.target.number !== undefined ? String(action.target.number) : readRecordScalar(targetRecord, "number") ?? "-";
  const targetUrl = action?.target.url ?? readRecordScalar(targetRecord, "url");
  const actionKind = action?.actionKind || readDataString(approval.payload, "actionKind") || "-";
  const sourceKind = action?.sourceKind || readDataString(approval.payload, "sourceKind") || "-";
  const labels = action?.payload.type === "github_label" ? action.payload.labels : [];
  const preview = action ? externalActionPayloadPreview(action.payload) : readDataString(approval.payload, "preview") || formatUnknownPreview(readDataField(approval.payload, "payload"), 220);
  const artifacts = actionView?.artifacts ?? [];
  const fileChangeArtifacts = cwd ? deriveFileChangeArtifacts(artifacts) : [];
  const standaloneArtifacts = fileChangeArtifacts.length > 0
    ? artifacts.filter((artifact) => !fileChangeArtifacts.includes(artifact))
    : artifacts;
  const canExecute = Boolean(action && action.status === "approved" && onExecute);
  const canCancel = Boolean(action && ["proposed", "waiting_for_approval", "approved"].includes(action.status) && onCancel);
  const busy = operation?.busy;
  return (
    <section className={`external-action-audit approval-external-action${compact ? " compact" : ""}`} aria-label={t("External action audit")}>
      <header className="external-action-audit-head">
        <span>{action?.payload.type === "github_label" ? <Tags aria-hidden="true" size={14} /> : <FileText aria-hidden="true" size={14} />}<strong>{t("External action")}</strong></span>
        <Badge tone={externalActionTone(action?.status)} variant="outline">{action?.status ? t(action.status) : t("detail unavailable")}</Badge>
      </header>
      <InspectorSection summary={`${sourceKind} · ${actionKind}`} title={t("Audit details")}>
        <div className="external-action-meta">
          <span>{sourceKind}</span><span>{actionKind}</span><span>{repository}</span><span>{subjectKind} #{subjectNumber}</span>
          {action ? <span>{t("{count} attempts", { count: action.executionAttemptCount })}</span> : null}
          {action?.updatedAt ? <time>{t("updated {time}", { time: formatDateTime(action.updatedAt) })}</time> : null}
        </div>
        {targetUrl ? <a className="external-action-target-link" href={targetUrl} target="_blank" rel="noreferrer"><ExternalLink aria-hidden="true" size={13} />{targetUrl}</a> : null}
        {preview ? (
          <div className="external-action-preview">
            <strong>{t("Payload preview")}</strong>
            {labels.length > 0 ? <div className="external-action-labels">{labels.map((label) => <span key={label}>{label}</span>)}</div> : <p>{preview}</p>}
          </div>
        ) : null}
      </InspectorSection>
      {action?.lastErrorMessage ? (
        <InlineFeedback title={action.lastErrorCode || t("External action")} tone="danger">{action.lastErrorMessage}</InlineFeedback>
      ) : null}
      {operation?.error ? (
        <InlineFeedback title={t("External action")} tone="danger">
          <span>{operation.error}</span>
          <ExternalActionRetry operation={operation} actionId={action?.id} canExecute={canExecute} canCancel={canCancel} onExecute={onExecute} onCancel={onCancel} onRefresh={onRefresh} />
        </InlineFeedback>
      ) : null}
      {!action && approval.externalWorkActionId && !operation?.error ? (
        <InlineFeedback tone="warning">{t("Action detail could not be loaded. Showing approval preview only.")}</InlineFeedback>
      ) : null}
      {artifacts.length > 0 ? (
        <InspectorSection className="external-action-artifacts" summary={t("{count} artifacts", { count: artifacts.length })} title={t("External action artifacts")}>
          {cwd && fileChangeArtifacts.length > 0 ? (
            <FileChangeEvidencePanel cwd={cwd} artifacts={fileChangeArtifacts} status={fileChangeStatusFromApproval(approval)} loadArtifactPreview={previewArtifactContent} approvalId={approval.id} compact />
          ) : null}
          {standaloneArtifacts.map((artifact) => <ArtifactRow key={artifact.id} artifact={artifact} cwd={cwd} />)}
        </InspectorSection>
      ) : null}
      {action ? (
        <div className="external-action-controls">
          {canExecute ? <Button leadingIcon={<Send aria-hidden="true" size={14} />} loading={busy === "execute"} loadingLabel={t("Executing")} size="sm" variant="primary" onClick={() => onExecute?.(action.id)}>{t("Execute action")}</Button> : null}
          {canCancel ? <Button leadingIcon={<CircleAlert aria-hidden="true" size={14} />} loading={busy === "cancel"} loadingLabel={t("Cancelling")} size="sm" variant="danger" onClick={() => onCancel?.(action.id)}>{t("Cancel proposal")}</Button> : null}
        </div>
      ) : null}
    </section>
  );
}

function ExternalActionRetry({ operation, actionId, canExecute, canCancel, onExecute, onCancel, onRefresh }: {
  readonly operation: ExternalActionBusyState;
  readonly actionId?: string;
  readonly canExecute: boolean;
  readonly canCancel: boolean;
  readonly onExecute?: (actionId: string) => void;
  readonly onCancel?: (actionId: string) => void;
  readonly onRefresh?: () => void;
}): JSX.Element | null {
  const { t } = useI18n();
  if (operation.failedOperation === "execute" && actionId && canExecute) return <Button size="sm" variant="ghost" onClick={() => onExecute?.(actionId)}>{t("Retry")}</Button>;
  if (operation.failedOperation === "cancel" && actionId && canCancel) return <Button size="sm" variant="ghost" onClick={() => onCancel?.(actionId)}>{t("Retry")}</Button>;
  if (operation.failedOperation === "detail" && onRefresh) return <Button leadingIcon={<RefreshCw aria-hidden="true" size={14} />} size="sm" variant="ghost" onClick={onRefresh}>{t("Retry")}</Button>;
  return null;
}

function externalActionTone(status?: string): "neutral" | "success" | "warning" | "danger" | "info" {
  if (status === "succeeded") return "success";
  if (status === "approved" || status === "executing") return "info";
  if (status === "proposed" || status === "waiting_for_approval") return "warning";
  if (status === "failed" || status === "stale_target" || status === "denied" || status === "cancelled") return "danger";
  return "neutral";
}

function externalActionPayloadPreview(payload: ExternalWorkActionView["action"]["payload"]): string {
  if (payload.type === "github_comment") return formatUnknownPreview(payload.body, 320);
  if (payload.type === "github_pr_review") return `${payload.event}: ${formatUnknownPreview(payload.body, 320)}`;
  return payload.labels.join(", ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readRecordScalar(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (typeof value === "string" && value) return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}
