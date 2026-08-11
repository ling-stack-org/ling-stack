import { Plus } from "lucide-react";
import { useI18n } from "../../i18n.js";
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
  Select,
  Textarea,
} from "../../shared/ui/index.js";
import { aiCouncilRoutingModeLabel } from "../../lib/ai-councils.js";
import type { AiTeammate } from "../../types.js";
import { councilCreateRoutingModes, type CouncilCreateDraft } from "./council-create-clone-view-model.js";

export function CouncilCreateDialog({
  busy,
  confirmEmpty,
  draft,
  eligibleTeammates,
  error,
  open,
  onDraftChange,
  onOpenChange,
  onRestoreFocus,
  onSubmit,
  onToggleMember,
}: {
  readonly busy: boolean;
  readonly confirmEmpty: boolean;
  readonly draft: CouncilCreateDraft;
  readonly eligibleTeammates: readonly AiTeammate[];
  readonly error: string;
  readonly open: boolean;
  readonly onDraftChange: (patch: Partial<CouncilCreateDraft>) => void;
  readonly onOpenChange: (open: boolean) => void;
  readonly onRestoreFocus: () => void;
  readonly onSubmit: () => void | Promise<void>;
  readonly onToggleMember: (teammateId: string) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const hasName = Boolean(draft.displayName.trim());
  const selectedCount = draft.memberIds.length;

  return (
    <Dialog busy={busy} open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-label={t("Create council")}
        className="council-create-clone-dialog"
        size="lg"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          onRestoreFocus();
        }}
      >
        <DialogHeader
          closeLabel={t("Close")}
          title={t("Create council")}
          description={t("Configure the council and its initial members in one atomic create request.")}
        />
        <form
          className="council-create-clone-form"
          onSubmit={(event) => {
            event.preventDefault();
            void onSubmit();
          }}
        >
          <DialogBody className="council-create-clone-body">
            <section className="council-create-clone-section" aria-label={t("Council configuration")}>
              <div className="council-create-clone-fields">
                <Field label={t("New council name")} required>
                  <Input
                    aria-label={t("New council name")}
                    autoFocus
                    disabled={busy}
                    value={draft.displayName}
                    onChange={(event) => onDraftChange({ displayName: event.target.value })}
                  />
                </Field>
                <Field label={t("Routing mode")} description={t("This is configuration only; runtime readiness is not inferred.")}>
                  <Select
                    aria-label={t("Routing mode")}
                    disabled={busy}
                    value={draft.routingMode}
                    onChange={(event) => onDraftChange({ routingMode: event.target.value as CouncilCreateDraft["routingMode"] })}
                  >
                    {councilCreateRoutingModes.map((mode) => (
                      <option key={mode} value={mode}>{aiCouncilRoutingModeLabel(mode, t)}</option>
                    ))}
                  </Select>
                </Field>
                <Field className="council-create-description" label={t("New council description")}>
                  <Textarea
                    aria-label={t("New council description")}
                    disabled={busy}
                    rows={3}
                    value={draft.description}
                    placeholder={t("Optional council description")}
                    onChange={(event) => onDraftChange({ description: event.target.value })}
                  />
                </Field>
              </div>
            </section>

            <fieldset className="council-create-members" disabled={busy}>
              <legend>
                <span>{t("Initial AI teammates")}</span>
                <small>{t("{count} selected", { count: selectedCount })}</small>
              </legend>
              {eligibleTeammates.length > 0 ? (
                <div className="council-create-member-options">
                  {eligibleTeammates.map((teammate) => {
                    const selected = draft.memberIds.includes(teammate.id);
                    return (
                      <label key={teammate.id} className="council-create-member-option" data-selected={selected ? "true" : undefined}>
                        <input
                          data-ling-control-native="true"
                          aria-label={teammate.displayName}
                          type="checkbox"
                          checked={selected}
                          onChange={() => onToggleMember(teammate.id)}
                        />
                        <span className="council-create-member-copy">
                          <strong title={teammate.displayName}>{teammate.displayName}</strong>
                          <small>{t("Available configuration")}</small>
                        </span>
                      </label>
                    );
                  })}
                </div>
              ) : (
                <InlineFeedback tone="warning" title={t("No eligible AI teammates")}>{t("You can still create an empty council and add members later.")}</InlineFeedback>
              )}
            </fieldset>

            {confirmEmpty ? (
              <InlineFeedback tone="warning" title={t("Readiness warning")}>
                {t("This council has no members and will need attention before it is useful.")}
              </InlineFeedback>
            ) : selectedCount > 0 ? (
              <InlineFeedback tone="info" title={t("Configuration ready")}>
                {t("{count} member(s) will be added with the selected routing mode.", { count: selectedCount })}
              </InlineFeedback>
            ) : null}
            {error ? <InlineFeedback tone="danger" title={t("Council creation failed")}>{error}</InlineFeedback> : null}
          </DialogBody>
          <DialogFooter>
            <Button disabled={busy} onClick={() => onOpenChange(false)}>{t("Cancel")}</Button>
            <Button
              disabled={!hasName}
              leadingIcon={<Plus />}
              loading={busy}
              loadingLabel={t("Creating council...")}
              type="submit"
              variant="primary"
            >
              {confirmEmpty ? t("Create without members") : t("Create council")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
