import { Route, ShieldCheck, Wrench } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { readDataField, readDataString } from "../../lib/data.js";
import type { ApprovalRequest } from "../../types.js";

export function RuntimePermissionScopeDelta({ approval }: { readonly approval: ApprovalRequest }): JSX.Element | null {
  const { t } = useI18n();
  if (approval.actionType !== "runtime_permission_request") {
    return null;
  }

  const requestedScope = readDataField(approval.payload, "requestedScope");
  const continuation = readDataField(approval.payload, "proposedContinuation");
  const kind = readDataString(approval.payload, "requestKind") || "-";
  const continuationMode = readObjectString(continuation, "mode") || "-";
  const scopeSummary = summarizeScope(requestedScope);

  return (
    <div className="runtime-permission-delta" aria-label={t("Runtime permission scope")}>
      <span>
        <ShieldCheck size={13} />
        {t("Scope")}: {kind}
      </span>
      <span>
        <Wrench size={13} />
        {scopeSummary}
      </span>
      <span>
        <Route size={13} />
        {t("Continuation")}: {continuationMode}
      </span>
    </div>
  );
}

function summarizeScope(value: unknown): string {
  if (!isRecord(value)) {
    return "-";
  }
  const kind = readObjectString(value, "kind");
  if (kind === "core_tool") {
    return `tools: ${readStringArray(value.tools).join(", ") || "-"}`;
  }
  if (kind === "write_scope") {
    return `${readObjectString(value, "operation") || "write"}: ${readStringArray(value.paths).join(", ") || "-"}`;
  }
  if (kind === "mcp_tool") {
    return `mcp: ${readObjectString(value, "serverId") || "-"}/${readObjectString(value, "toolName") || "-"}`;
  }
  if (kind === "runner_capability") {
    return `runner: ${readObjectString(value, "runnerId") || "-"}/${readObjectString(value, "capability") || "-"}`;
  }
  return kind || "-";
}

function readObjectString(value: unknown, key: string): string {
  if (!isRecord(value)) {
    return "";
  }
  const raw = value[key];
  return typeof raw === "string" ? raw : "";
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
