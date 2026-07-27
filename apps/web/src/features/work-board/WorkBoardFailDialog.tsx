import type { RefObject } from "react";
import { useI18n } from "../../i18n.js";
import type { WorkItemView } from "../../lib/work-items.js";
import { Button, Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, Field, InlineFeedback, InspectorSection, Textarea } from "../../shared/ui/index.js";
import type { WorkBoardActionFailure } from "./work-board-types.js";

export function WorkBoardFailDialog(props: {
  readonly item?: WorkItemView;
  readonly open: boolean;
  readonly reason: string;
  readonly validation: string;
  readonly busy: boolean;
  readonly failure?: WorkBoardActionFailure;
  readonly returnFocusRef: RefObject<HTMLElement | null>;
  readonly onReasonChange: (reason: string) => void;
  readonly onValidationChange: (message: string) => void;
  readonly onClose: () => void;
  readonly onConfirm: (reason: string) => Promise<boolean>;
}): JSX.Element {
  const { t } = useI18n();
  async function confirm(): Promise<void> {
    const reason = props.reason.trim();
    if (!reason) {
      props.onValidationChange(t("A failure reason is required."));
      return;
    }
    if (await props.onConfirm(reason)) props.onClose();
  }
  return (
    <Dialog busy={props.busy} open={props.open} onOpenChange={(open) => { if (!open) props.onClose(); }}>
      <DialogContent aria-label={t("Mark work as failed")} onCloseAutoFocus={(event) => {
        event.preventDefault();
        const target = props.returnFocusRef.current?.isConnected
          ? props.returnFocusRef.current
          : document.querySelector<HTMLElement>('.work-item-row[aria-selected="true"]') ?? document.querySelector<HTMLElement>('.work-board-header button');
        target?.focus();
      }} size="sm">
        <DialogHeader closeLabel={t("Close")} title={t("Mark work as failed")} description={t("This records a terminal failure for {name}.", { name: props.item?.title ?? t("this work item") })} />
        <DialogBody>
          {props.failure ? (
            <>
              <InlineFeedback title={t(props.failure.message)} tone="danger">{t("Raw failure detail is available in technical details.")}</InlineFeedback>
              <InspectorSection title={t("Technical details")} summary={t("Failure details")}>
                <p className="work-board-failure-technical" data-work-board-failure-technical>{props.failure.technicalMessage ?? t("No failure message was captured.")}</p>
              </InspectorSection>
            </>
          ) : null}
          <Field error={props.validation || undefined} label={t("Reason")} required>
            <Textarea autoFocus disabled={props.busy} rows={4} value={props.reason} onChange={(event) => { props.onReasonChange(event.target.value); props.onValidationChange(""); }} />
          </Field>
        </DialogBody>
        <DialogFooter>
          <Button disabled={props.busy} variant="ghost" onClick={props.onClose}>{t("Cancel")}</Button>
          <Button loading={props.busy} loadingLabel={t("Marking failed")} variant="danger" onClick={() => void confirm()}>{t("Mark failed")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
