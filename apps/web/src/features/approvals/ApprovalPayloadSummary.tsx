import { useI18n, type Translate } from "../../i18n.js";
import { formatUnknownPreview, readDataField, readDataString } from "../../lib/data.js";
import type { ApprovalRequest } from "../../types.js";

export function ApprovalPayloadSummary({ approval }: { readonly approval: ApprovalRequest }): React.JSX.Element | null {
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
    const patchFormat = readDataString(approval.payload, "patchFormat");
    const touchedPaths = readStringList(readDataField(approval.payload, "touchedPaths"));
    const summary = readDataField(approval.payload, "summary");
    const fileCount = isRecord(summary) && typeof summary.fileCount === "number" ? summary.fileCount : undefined;
    const addedLines = isRecord(summary) && typeof summary.addedLines === "number" ? summary.addedLines : undefined;
    const removedLines = isRecord(summary) && typeof summary.removedLines === "number" ? summary.removedLines : undefined;
    const preview = payloadType === "file_edit"
      ? readDataString(approval.payload, "diffPreview")
      : readDataString(approval.payload, "preview");
    return (
      <div className="approval-payload-summary" aria-label="File mutation approval summary">
        {patchFormat ? <span>{t("patch {format}", { format: patchFormat })}</span> : null}
        <span>{t("path {path}", { path: touchedPaths.length > 0 ? touchedPaths.join(", ") : path })}</span>
        {fileCount !== undefined ? <span>{t("{count} files", { count: fileCount })}</span> : null}
        {addedLines !== undefined || removedLines !== undefined ? <span>{`+${addedLines ?? 0} / -${removedLines ?? 0}`}</span> : null}
        {typeof bytes === "number" ? <span>{t("{count} bytes", { count: bytes })}</span> : null}
        {preview ? <pre>{preview}</pre> : null}
      </div>
    );
  }
  if (payloadType === "workflow_step") {
    const gateStage = readDataString(approval.payload, "gateStage");
    const gateLabel = gateStage === "post" ? t("Post-step approval") : gateStage === "pre" ? t("Pre-step approval") : undefined;
    const approvalMode = readDataString(approval.payload, "approvalMode") || "-";
    const requiredForTools = readStringList(readDataField(approval.payload, "requiredForTools"));
    const requiredForActions = readStringList(readDataField(approval.payload, "requiredForActions"));
    return (
      <div className="approval-payload-summary" aria-label="Workflow step approval summary">
        <span>{t("step {step}", { step: readDataString(approval.payload, "title") || approval.title })}</span>
        {gateLabel ? <span>{gateLabel}</span> : null}
        <span>{t("mode {mode}", { mode: approvalMode })}</span>
        {requiredForTools.length > 0 ? <span>{t("tools {tools}", { tools: requiredForTools.join(", ") })}</span> : null}
        {requiredForActions.length > 0 ? <span>{t("actions {actions}", { actions: requiredForActions.join(", ") })}</span> : null}
      </div>
    );
  }
  if (payloadType === "runtime_permission_request") {
    const reason = readDataString(approval.payload, "reason");
    return (
      <div className="approval-payload-summary" aria-label="Runtime permission approval summary">
        <span>{t("permission {kind}", { kind: readDataString(approval.payload, "requestKind") || "-" })}</span>
        {reason ? <p>{reason}</p> : null}
      </div>
    );
  }
  if (payloadType === "mcp_tool_call" || payloadType === "tool_call") {
    const cwd = readDataString(approval.payload, "cwd");
    const input = readDataField(approval.payload, "input");
    return (
      <div className="approval-payload-summary" aria-label="Tool approval summary">
        <span>{t("tool {tool}", { tool: readDataString(approval.payload, "toolName") || "-" })}</span>
        {cwd ? <span>{t("cwd {cwd}", { cwd })}</span> : null}
        {input ? <p>{formatUnknownPreview(input, 240)}</p> : null}
      </div>
    );
  }
  if (payloadType === "deploy") {
    const environment = readDataString(approval.payload, "environment");
    const command = readDataString(approval.payload, "command");
    return (
      <div className="approval-payload-summary" aria-label="Deploy approval summary">
        <span>{t("target {target}", { target: readDataString(approval.payload, "target") || "-" })}</span>
        {environment ? <span>{t("environment {environment}", { environment })}</span> : null}
        {command ? <code>{command}</code> : null}
      </div>
    );
  }
  if (payloadType === "provider_change") {
    const changedFields = readStringList(readDataField(approval.payload, "changedFields"));
    return (
      <div className="approval-payload-summary" aria-label="Provider change approval summary">
        <span>{t("provider {provider}", { provider: readDataString(approval.payload, "providerPresetId") || "-" })}</span>
        {changedFields.length > 0 ? <span>{t("fields {fields}", { fields: changedFields.join(", ") })}</span> : null}
      </div>
    );
  }
  if (approval.actionType === "external_send" && payloadType === "external_action") {
    const target = readDataField(approval.payload, "target");
    return (
      <div className="approval-payload-summary" aria-label="External action approval summary">
        <span>{t("source {sourceKind}", { sourceKind: readDataString(approval.payload, "sourceKind") || "-" })}</span>
        <span>{t("action {actionKind}", { actionKind: readDataString(approval.payload, "actionKind") || "-" })}</span>
        {target ? <span>{t("target {target}", { target: formatUnknownPreview(target, 120) })}</span> : null}
        {readDataString(approval.payload, "preview") ? <p>{readDataString(approval.payload, "preview")}</p> : null}
      </div>
    );
  }
  if (approval.actionType !== "media_cost" || payloadType !== "media_cost") return null;
  const model = readDataString(approval.payload, "model") || "-";
  const workflowName = readDataString(approval.payload, "workflowName");
  return (
    <div className="approval-payload-summary" aria-label="Media cost approval summary">
      <span>{workflowName ? t("workflow {workflow}", { workflow: workflowName }) : t("model {model}", { model })}</span>
      <span>{t("operation {operation}", { operation: mediaOperationLabel(readDataString(approval.payload, "operation"), t) })}</span>
      {readDataString(approval.payload, "promptPreview") ? <p>{readDataString(approval.payload, "promptPreview")}</p> : null}
    </div>
  );
}

function mediaOperationLabel(operation: string, t: Translate): string {
  if (operation === "image_generate") return t("Image generation");
  if (operation === "image_edit") return t("Image editing");
  if (operation === "video_generate") return t("Video generation");
  return operation || "-";
}

function readStringList(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
