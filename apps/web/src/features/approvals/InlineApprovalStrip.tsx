import { Badge, Button, Collapsible, CollapsibleContent, CollapsibleTrigger } from "../../shared/ui/index.js";
import { CheckCircle2, ChevronDown, CircleAlert, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { useI18n } from "../../i18n.js";
import type { InlineApprovalView } from "../../lib/inline-approvals.js";
import { approvalRiskTone } from "./approval-view-models.js";
import type { ApprovalResolution } from "./types.js";
import { RuntimePermissionScopeDelta } from "./RuntimePermissionScopeDelta.js";

export function InlineApprovalStrip({ approvals, resolvingApprovals, onResolve, onOpenApproval }: {
  readonly approvals: readonly InlineApprovalView[];
  readonly resolvingApprovals: Readonly<Record<string, ApprovalResolution>>;
  readonly onResolve: (approvalId: string, decision: ApprovalResolution, reason?: string) => void;
  readonly onOpenApproval: (approvalId: string) => void;
}): JSX.Element | null {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const uniqueApprovals = [...new Map(approvals.map((item) => [item.approval.id, item])).values()];
  if (uniqueApprovals.length === 0) return null;
  const primaryApproval = uniqueApprovals[0];
  const secondaryApprovals = uniqueApprovals.slice(1);
  return (
    <section
      className="composer-approval-overlay inline-approval-strip approval-inline-strip"
      data-computer-use-obstacle="true"
      data-computer-use-obstacle-kind="approval"
      aria-label={t("Composer approval overlay")}
    >
      <span className="approval-inline-announcement" role="status" aria-live="polite" aria-atomic="true">
        {t("Highest risk: {risk}", { risk: t(primaryApproval.approval.risk) })} · {t("{count} pending approvals", { count: uniqueApprovals.length })}
      </span>
      <header className="inline-approval-strip-head approval-inline-header">
        <span><ShieldCheck aria-hidden="true" size={15} /><strong>{t(uniqueApprovals.length > 1 ? "Runtime approvals needed" : "Runtime approval needed")}</strong></span>
        <small>{t("Highest risk: {risk}", { risk: t(primaryApproval.approval.risk) })} · {t("{count} pending approvals", { count: uniqueApprovals.length })}</small>
      </header>
      <p className="inline-approval-summary">{t("Resolve the blocking approval before the run can continue.")}</p>
      <InlineApprovalItem item={primaryApproval} priority="primary" resolvingDecision={resolvingApprovals[primaryApproval.approval.id]} onResolve={onResolve} onOpenApproval={onOpenApproval} />
      {secondaryApprovals.length > 0 ? (
        <Collapsible className="inline-approval-more approval-inline-more" open={expanded} onOpenChange={setExpanded}>
          <CollapsibleTrigger asChild>
            <Button trailingIcon={<ChevronDown aria-hidden="true" size={14} />} size="sm" variant="ghost">
              {t("Show other approvals")} · {secondaryApprovals.length}
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="inline-approval-list approval-inline-list">
              {secondaryApprovals.map((item) => (
                <InlineApprovalItem key={item.approval.id} item={item} priority="secondary" resolvingDecision={resolvingApprovals[item.approval.id]} onResolve={onResolve} onOpenApproval={onOpenApproval} />
              ))}
            </div>
          </CollapsibleContent>
        </Collapsible>
      ) : null}
    </section>
  );
}

function InlineApprovalItem({ item, priority, resolvingDecision, onResolve, onOpenApproval }: {
  readonly item: InlineApprovalView;
  readonly priority: "primary" | "secondary";
  readonly resolvingDecision?: ApprovalResolution;
  readonly onResolve: (approvalId: string, decision: ApprovalResolution, reason?: string) => void;
  readonly onOpenApproval: (approvalId: string) => void;
}): JSX.Element {
  const { t } = useI18n();
  const isResolving = Boolean(resolvingDecision);
  return (
    <article className={`inline-approval-item approval-inline-item ${priority}`} data-approval-risk={item.approval.risk}>
      <div className="inline-approval-copy">
        <span className="inline-approval-title-row"><strong>{item.approval.title}</strong><Badge tone={approvalRiskTone(item.approval.risk)} variant="outline">{t(item.approval.risk)}</Badge></span>
        <small>{item.ownerLabel} · {t(item.approval.actionType)}</small>
        <p>{item.summary}</p>
        <RuntimePermissionScopeDelta approval={item.approval} />
      </div>
      <div className="inline-approval-actions">
        <Button leadingIcon={<ShieldCheck aria-hidden="true" size={14} />} size="sm" disabled={isResolving} onClick={() => onOpenApproval(item.approval.id)}>{t("Details")}</Button>
        <Button
          leadingIcon={<CheckCircle2 aria-hidden="true" size={14} />}
          loading={resolvingDecision === "approve"}
          loadingLabel={t("Approving")}
          size="sm"
          variant="primary"
          onClick={() => item.requiresDetailConfirmation ? onOpenApproval(item.approval.id) : onResolve(item.approval.id, "approve")}
        >
          {item.requiresDetailConfirmation ? t("Review") : t("Approve")}
        </Button>
        <Button leadingIcon={<CircleAlert aria-hidden="true" size={14} />} loading={resolvingDecision === "deny"} loadingLabel={t("Denying")} size="sm" variant="danger" onClick={() => onResolve(item.approval.id, "deny")}>{t("Deny")}</Button>
      </div>
    </article>
  );
}
