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

  const orderedApprovals = [...approvals].sort(compareInlineApprovalViews);
  const primaryApproval = orderedApprovals[0];
  const secondaryApprovals = orderedApprovals.slice(1);
  const highestRisk = primaryApproval?.approval.risk ?? "low";

  return (
    <div className="composer-approval-overlay inline-approval-strip" role="status" aria-live="polite" aria-label={t("Composer approval overlay")}>
      <div className="inline-approval-strip-head">
        <span>
          <ShieldCheck size={15} />
          <strong>{approvals.length > 1 ? t("Runtime approvals needed") : t("Runtime approval needed")}</strong>
        </span>
        <small>{t("Highest risk: {risk}", { risk: t(highestRisk) })} · {t("{count} pending approvals", { count: approvals.length })}</small>
      </div>
      <p className="inline-approval-summary">{t("Resolve the blocking approval before the run can continue.")}</p>
      {primaryApproval ? (
        <InlineApprovalItem
          item={primaryApproval}
          priority="primary"
          resolvingDecision={resolvingApprovals[primaryApproval.approval.id]}
          onResolve={onResolve}
          onOpenApproval={onOpenApproval}
        />
      ) : null}
      {secondaryApprovals.length > 0 ? (
        <details className="inline-approval-more">
          <summary>{t("Show other approvals")} · {secondaryApprovals.length}</summary>
          <div className="inline-approval-list">
            {secondaryApprovals.map((item) => (
              <InlineApprovalItem
                key={item.approval.id}
                item={item}
                priority="secondary"
                resolvingDecision={resolvingApprovals[item.approval.id]}
                onResolve={onResolve}
                onOpenApproval={onOpenApproval}
              />
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}

function InlineApprovalItem({
  item,
  priority,
  resolvingDecision,
  onResolve,
  onOpenApproval,
}: {
  readonly item: InlineApprovalView;
  readonly priority: "primary" | "secondary";
  readonly resolvingDecision?: ApprovalResolution;
  readonly onResolve: (approvalId: string, decision: ApprovalResolution, reason?: string) => void;
  readonly onOpenApproval: (approvalId: string) => void;
}): JSX.Element {
  const { t } = useI18n();
  const isResolving = Boolean(resolvingDecision);
  return (
    <article className={`inline-approval-item ${priority} ${item.approval.risk}`}>
      <div className="inline-approval-copy">
        <span className="inline-approval-title-row">
          <strong>{item.approval.title}</strong>
          <span className={`approval-risk ${item.approval.risk}`}>{t(item.approval.risk)}</span>
        </span>
        <small>{item.ownerLabel} · {t(item.approval.actionType)}</small>
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
}

function compareInlineApprovalViews(left: InlineApprovalView, right: InlineApprovalView): number {
  const riskComparison = riskRank(right.approval.risk) - riskRank(left.approval.risk);
  if (riskComparison !== 0) {
    return riskComparison;
  }
  return left.approval.createdAt.localeCompare(right.approval.createdAt);
}

function riskRank(risk: InlineApprovalView["approval"]["risk"]): number {
  if (risk === "critical") {
    return 4;
  }
  if (risk === "high") {
    return 3;
  }
  if (risk === "medium") {
    return 2;
  }
  return 1;
}
