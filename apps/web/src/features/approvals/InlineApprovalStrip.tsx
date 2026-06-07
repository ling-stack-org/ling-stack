import { CheckCircle2, CircleAlert, Loader2, ShieldCheck } from "lucide-react";
import { useI18n } from "../../i18n.js";
import type { InlineApprovalView } from "../../lib/inline-approvals.js";
import type { ApprovalResolution } from "./types.js";
import { RuntimePermissionScopeDelta } from "./RuntimePermissionScopeDelta.js";

export function InlineApprovalStrip({
  approvals,
  resolvingApprovals,
  onResolve,
  onOpenApproval,
}: {
  readonly approvals: readonly InlineApprovalView[];
  readonly resolvingApprovals: Readonly<Record<string, ApprovalResolution>>;
  readonly onResolve: (approvalId: string, decision: ApprovalResolution, reason?: string) => void;
  readonly onOpenApproval: (approvalId: string) => void;
}): JSX.Element | null {
  const { t } = useI18n();
  if (approvals.length === 0) {
    return null;
  }

  return (
    <div className="inline-approval-strip" aria-label={t("Inline runtime approvals")}>
      <div className="inline-approval-strip-head">
        <span>
          <ShieldCheck size={15} />
          <strong>{t("Runtime approval needed")}</strong>
        </span>
        <small>{t("{count} pending approvals", { count: approvals.length })}</small>
      </div>
      <div className="inline-approval-list">
        {approvals.map((item) => {
          const resolvingDecision = resolvingApprovals[item.approval.id];
          const isResolving = Boolean(resolvingDecision);
          return (
            <article key={item.approval.id} className={`inline-approval-item ${item.approval.risk}`}>
              <div className="inline-approval-copy">
                <span className="inline-approval-title-row">
                  <strong>{item.approval.title}</strong>
                  <span className={`approval-risk ${item.approval.risk}`}>{item.approval.risk}</span>
                </span>
                <small>{item.ownerLabel} · {item.approval.actionType}</small>
                <p>{item.summary}</p>
                <RuntimePermissionScopeDelta approval={item.approval} />
              </div>
              <div className="inline-approval-actions">
                <button className="secondary-button compact-button" type="button" onClick={() => onOpenApproval(item.approval.id)} disabled={isResolving}>
                  <ShieldCheck size={14} />
                  {t("Details")}
                </button>
                <button
                  className={item.requiresDetailConfirmation ? "secondary-button compact-button" : "secondary-button compact-button danger"}
                  type="button"
                  onClick={() => {
                    if (item.requiresDetailConfirmation) {
                      onOpenApproval(item.approval.id);
                    } else {
                      onResolve(item.approval.id, "approve");
                    }
                  }}
                  disabled={isResolving}
                >
                  {resolvingDecision === "approve" ? <Loader2 className="spin" size={14} /> : <CheckCircle2 size={14} />}
                  {item.requiresDetailConfirmation ? t("Review") : t("Approve")}
                </button>
                <button
                  className="secondary-button compact-button danger"
                  type="button"
                  onClick={() => onResolve(item.approval.id, "deny")}
                  disabled={isResolving}
                >
                  {resolvingDecision === "deny" ? <Loader2 className="spin" size={14} /> : <CircleAlert size={14} />}
                  {t("Deny")}
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}
