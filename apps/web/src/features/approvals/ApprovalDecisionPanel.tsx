import { Button, Field, InlineFeedback, Textarea } from "../../shared/ui/index.js";
import { CheckCircle2, CircleAlert } from "lucide-react";
import { useRef } from "react";
import { useI18n } from "../../i18n.js";
import type { ApprovalRequest } from "../../types.js";
import type { ApprovalResolution } from "./types.js";
import { ApprovalDecisionDialog } from "./ApprovalDecisionDialog.js";
import { useApprovalDecisionController } from "./useApprovalDecisionController.js";

export function ApprovalDecisionPanel({
  approval,
  compact,
  enabled = true,
  errorMessage,
  resolvingDecision,
  onResolve,
}: {
  readonly approval: ApprovalRequest;
  readonly compact?: boolean;
  readonly enabled?: boolean;
  readonly errorMessage?: string;
  readonly resolvingDecision?: ApprovalResolution;
  readonly onResolve: (approvalId: string, decision: ApprovalResolution, reason?: string) => void;
}): JSX.Element | null {
  const { t } = useI18n();
  const approveButtonRef = useRef<HTMLButtonElement>(null);
  const decision = useApprovalDecisionController({ approval, resolvingDecision, errorMessage, onResolve });
  if (!enabled || decision.status !== "pending") return null;
  return (
    <section className="approval-decision-panel" aria-label={t("Decision")}>
      <Field
        description={decision.reasonRequired ? t("Required before approving high-risk requests") : t("Optional note for the audit log")}
        label={t("Decision reason")}
      >
        <Textarea
          disabled={decision.isResolving}
          rows={compact ? 2 : 3}
          value={decision.decisionReason}
          onChange={(event) => decision.updateReason(event.target.value)}
        />
      </Field>
      {decision.mutationError && !decision.dialogOpen ? (
        <InlineFeedback title={t("Decision")} tone="danger">{decision.mutationError}</InlineFeedback>
      ) : null}
      <div className="approval-actions">
        <Button
          ref={approveButtonRef}
          disabled={decision.isResolving}
          leadingIcon={<CheckCircle2 aria-hidden="true" size={14} />}
          loading={resolvingDecision === "approve"}
          loadingLabel={t("Approving")}
          size="sm"
          variant="primary"
          onClick={() => decision.requestDecision("approve")}
        >
          {decision.mutationError ? t("Retry") : t("Approve")}
        </Button>
        <Button
          disabled={decision.isResolving}
          leadingIcon={<CircleAlert aria-hidden="true" size={14} />}
          loading={resolvingDecision === "deny"}
          loadingLabel={t("Denying")}
          size="sm"
          variant="danger"
          onClick={() => decision.requestDecision("deny")}
        >
          {t("Deny")}
        </Button>
      </div>
      <ApprovalDecisionDialog
        approval={approval}
        busy={decision.isResolving}
        mutationError={decision.mutationError}
        open={decision.dialogOpen}
        reason={decision.decisionReason}
        reasonError={decision.reasonError}
        reasonRequired={decision.reasonRequired}
        restoreFocusRef={approveButtonRef}
        onConfirm={decision.submit}
        onOpenChange={decision.setOpen}
        onReasonChange={decision.updateReason}
      />
    </section>
  );
}
