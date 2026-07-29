import { Copy, Pin } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { aiCouncilRoutingModeLabel } from "../../lib/ai-councils.js";
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Field,
  InlineFeedback,
  Input,
  Textarea,
} from "../../shared/ui/index.js";
import type { CouncilCloneDraft } from "./council-create-clone-view-model.js";
import type { CouncilCloneReview } from "./useCouncilCreateCloneController.js";

export function CouncilCloneDialog({
  busy,
  error,
  open,
  review,
  onDraftChange,
  onOpenChange,
  onRestoreFocus,
  onSubmit,
}: {
  readonly busy: boolean;
  readonly error: string;
  readonly open: boolean;
  readonly review?: CouncilCloneReview;
  readonly onDraftChange: (patch: Partial<CouncilCloneDraft>) => void;
  readonly onOpenChange: (open: boolean) => void;
  readonly onRestoreFocus: () => void;
  readonly onSubmit: () => void | Promise<void>;
}): JSX.Element {
  const { t } = useI18n();
  if (!review) return <></>;

  return (
    <Dialog busy={busy} open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-label={t("Review council clone")}
        className="council-create-clone-dialog"
        size="lg"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          onRestoreFocus();
        }}
      >
        <DialogHeader
          closeLabel={t("Close")}
          title={t("Review council clone")}
          description={t("Review the supported clone fields before creating a new council.")}
        />
        <form
          className="council-create-clone-form"
          onSubmit={(event) => {
            event.preventDefault();
            void onSubmit();
          }}
        >
          <DialogBody className="council-create-clone-body">
            <section className="council-clone-source" aria-label={t("Clone source summary")}>
              <div className="council-clone-source-heading">
                <span>{t("Source council")}</span>
                <strong title={review.source.displayName}>{review.source.displayName}</strong>
              </div>
              <div className="council-clone-facts">
                <span>
                  <small>{t("Members")}</small>
                  <strong>{review.memberSummaryAvailable ? t("{count} current members", { count: review.members.length }) : t("Member summary unavailable")}</strong>
                </span>
                <span><small>{t("Routing mode")}</small><strong>{aiCouncilRoutingModeLabel(review.source.routingPolicy.defaultMode, t)}</strong></span>
                <span><small>{t("New status")}</small><strong>{t("Active custom council")}</strong></span>
              </div>
              {review.memberSummaryAvailable && review.members.length > 0 ? (
                <div className="council-clone-member-summary" aria-label={t("Members copied by clone")}>
                  {review.members.map((member) => (
                    <span key={member.id} title={member.displayName} data-enabled={member.enabled ? "true" : "false"}>{member.displayName}</span>
                  ))}
                </div>
              ) : null}
            </section>

            {!review.memberSummaryAvailable ? (
              <InlineFeedback tone="warning" title={t("Member summary unavailable")}>
                {t("Current member details could not be loaded. Clone still copies the source council's server-side members.")}
              </InlineFeedback>
            ) : null}

            <InlineFeedback tone="info" title={t("Members and routing will be copied")}>
              {t("The clone API copies the source council's current members and routing in the same operation.")}
            </InlineFeedback>
            {review.changedSinceReview ? (
              <InlineFeedback tone="warning" title={t("Review changes")}>
                {t("Review the supported clone fields before creating a new council.")}
              </InlineFeedback>
            ) : null}
            <InlineFeedback tone="warning" title={t("Channel attachments will not be copied")}>
              {t("Attach the new council to channels separately after cloning.")}
            </InlineFeedback>

            <section className="council-create-clone-section" aria-label={t("Clone fields")}>
              <div className="council-create-clone-fields">
                <Field label={t("Clone name")} required>
                  <Input
                    aria-label={t("Clone name")}
                    autoFocus
                    disabled={busy}
                    value={review.draft.displayName}
                    onChange={(event) => onDraftChange({ displayName: event.target.value })}
                  />
                </Field>
                <label className="council-clone-pin-option">
                  <input
                    data-ling-control-native="true"
                    aria-label={t("Pin cloned council")}
                    type="checkbox"
                    checked={review.draft.pinned}
                    disabled={busy}
                    onChange={(event) => onDraftChange({ pinned: event.target.checked })}
                  />
                  <span><Pin size={15} />{t("Pin cloned council")}</span>
                </label>
                <Field className="council-create-description" label={t("Clone description")}>
                  <Textarea
                    aria-label={t("Clone description")}
                    disabled={busy}
                    rows={3}
                    value={review.draft.description}
                    onChange={(event) => onDraftChange({ description: event.target.value })}
                  />
                </Field>
              </div>
            </section>
            <p className="council-clone-active-note">{t("The new council will be active. Pinning follows the choice above.")}</p>
            {error ? <InlineFeedback tone="danger" title={t("Council clone failed")}>{error}</InlineFeedback> : null}
          </DialogBody>
          <DialogFooter>
            <Button disabled={busy} onClick={() => onOpenChange(false)}>{t("Cancel")}</Button>
            <Button
              disabled={!review.draft.displayName.trim()}
              leadingIcon={<Copy />}
              loading={busy}
              loadingLabel={t("Cloning council...")}
              type="submit"
              variant="primary"
            >
              {t("Clone council")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
