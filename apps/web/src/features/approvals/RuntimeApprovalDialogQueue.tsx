import { CheckCircle2, CircleAlert, ShieldCheck } from "lucide-react";
import { useEffect, useRef } from "react";
import { useI18n } from "../../i18n.js";
import type { InlineApprovalView } from "../../lib/inline-approvals.js";
import { runtimeApprovalActionSentence } from "../../lib/runtime-approval-presentation.js";
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  InlineFeedback,
} from "../../shared/ui/index.js";
import type { ApprovalResolution } from "./types.js";
import { useApprovalDecisionController } from "./useApprovalDecisionController.js";

export function RuntimeApprovalDialogQueue({
  approvals,
  approvalErrors,
  resolvingApprovals,
  onResolve,
}: {
  readonly approvals: readonly InlineApprovalView[];
  readonly approvalErrors: Readonly<Record<string, string>>;
  readonly resolvingApprovals: Readonly<Record<string, ApprovalResolution>>;
  readonly onResolve: (approvalId: string, decision: ApprovalResolution, reason?: string) => void;
}): React.JSX.Element | null {
  const { t } = useI18n();
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const denyButtonRef = useRef<HTMLButtonElement>(null);
  const previousApprovalIdRef = useRef("");
  const uniqueApprovals = [...new Map(approvals.map((item) => [item.approval.id, item])).values()];
  const current = uniqueApprovals[0];
  const decision = useApprovalDecisionController({
    approval: current?.approval ?? emptyApproval,
    resolvingDecision: current ? resolvingApprovals[current.approval.id] : undefined,
    errorMessage: current ? approvalErrors[current.approval.id] : undefined,
    reasonPolicy: "none",
    onResolve,
  });

  useEffect(() => {
    const currentId = current?.approval.id ?? "";
    if (!currentId && previousApprovalIdRef.current) {
      const focusTarget = returnFocusRef.current;
      globalThis.requestAnimationFrame(() => {
        if (focusTarget?.isConnected) focusTarget.focus();
      });
      returnFocusRef.current = null;
    }
    previousApprovalIdRef.current = currentId;
  }, [current?.approval.id]);

  useEffect(() => {
    if (!current) return undefined;
    const frame = globalThis.requestAnimationFrame(() => denyButtonRef.current?.focus());
    return () => globalThis.cancelAnimationFrame(frame);
  }, [current?.approval.id]);

  if (!current) return null;
  const approval = current.approval;
  const resolvingDecision = resolvingApprovals[approval.id];
  const actionSentence = runtimeApprovalActionSentence(approval, current.summary, t);

  return (
    <Dialog busy={decision.isResolving} dismissible={false} open onOpenChange={() => undefined}>
      <DialogContent
        className="runtime-approval-dialog"
        data-computer-use-obstacle="true"
        data-computer-use-obstacle-kind="approval"
        size="sm"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          if (!returnFocusRef.current && document.activeElement instanceof HTMLElement) {
            returnFocusRef.current = document.activeElement;
          }
          denyButtonRef.current?.focus();
        }}
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <DialogHeader
          title={<span className="runtime-approval-dialog-title"><ShieldCheck aria-hidden="true" size={18} />{t("Allow this action?")}</span>}
        />
        <DialogBody className="runtime-approval-dialog-body">
          <p className="runtime-approval-dialog-summary">{actionSentence}</p>
          {decision.mutationError ? (
            <InlineFeedback title={t("Decision")} tone="danger">{decision.mutationError}</InlineFeedback>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button
            ref={denyButtonRef}
            leadingIcon={<CircleAlert aria-hidden="true" size={15} />}
            loading={resolvingDecision === "deny"}
            loadingLabel={t("Denying")}
            variant="danger"
            onClick={() => decision.submit("deny")}
          >
            {decision.mutationError && decision.attemptedDecision === "deny" ? t("Retry") : t("Deny")}
          </Button>
          <Button
            leadingIcon={<CheckCircle2 aria-hidden="true" size={15} />}
            loading={resolvingDecision === "approve"}
            loadingLabel={t("Allowing")}
            variant="primary"
            onClick={() => decision.submit("approve")}
          >
            {decision.mutationError && decision.attemptedDecision === "approve" ? t("Retry") : t("Allow")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const emptyApproval = {
  id: "runtime-approval-placeholder",
  actionType: "runtime_permission_request",
  title: "",
  description: "",
  risk: "low",
  status: "pending",
  payload: {},
  createdAt: "",
} as const;
