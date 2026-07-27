import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Field,
  InlineFeedback,
  Textarea,
} from "../../shared/ui/index.js";
import { CheckCircle2 } from "lucide-react";
import { useRef, type RefObject } from "react";
import { useI18n } from "../../i18n.js";
import type { ApprovalRequest } from "../../types.js";
import type { ApprovalResolution } from "./types.js";

export function ApprovalDecisionDialog({
  approval,
  open,
  busy,
  reason,
  reasonRequired,
  reasonError,
  mutationError,
  restoreFocusRef,
  onOpenChange,
  onReasonChange,
  onConfirm,
}: {
  readonly approval: ApprovalRequest;
  readonly open: boolean;
  readonly busy: boolean;
  readonly reason: string;
  readonly reasonRequired: boolean;
  readonly reasonError: string;
  readonly mutationError: string;
  readonly restoreFocusRef: RefObject<HTMLButtonElement>;
  readonly onOpenChange: (open: boolean) => void;
  readonly onReasonChange: (reason: string) => void;
  readonly onConfirm: (decision: ApprovalResolution) => void;
}): JSX.Element {
  const { t } = useI18n();
  const cancelRef = useRef<HTMLButtonElement>(null);
  return (
    <Dialog busy={busy} open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="approval-decision-dialog"
        size="sm"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          cancelRef.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          const fallback = [...document.querySelectorAll<HTMLElement>("[data-approval-id]")]
            .find((element) => element.dataset.approvalId === approval.id);
          (restoreFocusRef.current ?? fallback)?.focus();
        }}
      >
        <DialogHeader
          description={t("Review the approval payload, then confirm.")}
          title={`${t("Decision")}: ${approval.title}`}
        />
        <DialogBody className="approval-decision-dialog-body">
          <InlineFeedback tone="warning">
            {t(reasonRequired
              ? "High-risk approval. Review the payload and reason, then confirm."
              : "Review the approval payload, then confirm.")}
          </InlineFeedback>
          <Field
            error={reasonError ? t(reasonError) : undefined}
            label={t("Decision reason")}
            required={reasonRequired}
          >
            <Textarea
              autoComplete="off"
              disabled={busy}
              rows={4}
              value={reason}
              onChange={(event) => onReasonChange(event.target.value)}
            />
          </Field>
          {mutationError ? <InlineFeedback title={t("Decision")} tone="danger">{mutationError}</InlineFeedback> : null}
        </DialogBody>
        <DialogFooter>
          <Button ref={cancelRef} disabled={busy} onClick={() => onOpenChange(false)}>{t("Cancel")}</Button>
          <Button
            leadingIcon={<CheckCircle2 aria-hidden="true" size={15} />}
            loading={busy}
            loadingLabel={t("Approving")}
            variant="primary"
            onClick={() => onConfirm("approve")}
          >
            {mutationError ? t("Retry") : t("Approve")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
