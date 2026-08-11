import { Badge, InlineFeedback } from "../../shared/ui/index.js";
import { Route, ShieldCheck } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { effectiveApprovalStatus, projectRuntimePermissionDelta } from "../../lib/approvals.js";
import type { ApprovalRequest } from "../../types.js";
import { approvalStatusTone } from "./approval-view-models.js";

export function ApprovalPermissionDelta({
  approval,
  compact = false,
}: {
  readonly approval: ApprovalRequest;
  readonly compact?: boolean;
}): React.JSX.Element | null {
  const { t } = useI18n();
  const delta = projectRuntimePermissionDelta(approval);
  if (!delta || delta.added.length + delta.removed.length + delta.unchanged.length === 0) return null;
  const status = effectiveApprovalStatus(approval);
  return (
    <section className={`approval-permission-delta runtime-permission-delta${compact ? " compact" : ""}`} aria-label={t("Runtime permission scope")}>
      <header>
        <span><ShieldCheck aria-hidden="true" size={14} /><strong>{t("Runtime permission scope")}</strong></span>
        <Badge tone={approvalStatusTone(status)} variant="outline">{t(status)}</Badge>
      </header>
      <div className="approval-permission-meta">
        <span><strong>{t("Scope")}</strong>{delta.kind}</span>
        <span><Route aria-hidden="true" size={13} /><strong>{t("Continuation")}</strong>{delta.continuationMode}</span>
      </div>
      <div className="approval-permission-columns">
        <PermissionEntries label={t("Add")} entries={delta.added} />
        <PermissionEntries label={t("Remove")} entries={delta.removed} />
        <PermissionEntries label={t("Unchanged")} entries={delta.unchanged} />
      </div>
      {status !== "pending" ? (
        <InlineFeedback title={t("Result")} tone={status === "approved" ? "success" : "warning"}>
          {t(status)} · {t("Runtime permission scope")}
        </InlineFeedback>
      ) : null}
    </section>
  );
}

function PermissionEntries({ label, entries }: { readonly label: string; readonly entries: readonly string[] }): React.JSX.Element | null {
  if (entries.length === 0) return null;
  return (
    <span className="approval-permission-column">
      <strong>{label}</strong>
      {entries.map((entry) => <code key={entry}>{entry}</code>)}
    </span>
  );
}
