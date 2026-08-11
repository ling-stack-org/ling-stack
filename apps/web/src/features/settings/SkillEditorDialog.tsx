import { Bot, Check } from "lucide-react";
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  InlineFeedback,
} from "../../shared/ui/index.js";
import type { SkillRevisionPreview } from "../../types.js";
import { SkillEditorAdvancedFields } from "./SkillEditorAdvancedFields.js";
import { SkillEditorCoreFields } from "./SkillEditorCoreFields.js";
import { SkillEditorFeedback } from "./SkillEditorFeedback.js";
import type { SkillEditorForm, SkillEditorMode } from "./skill-editor-utils.js";
import type { SettingsTranslator } from "./skill-library-utils.js";
import type { SkillEditorBusyState } from "./useSkillEditorController.js";

export function SkillEditorDialog({
  open,
  mode,
  sourceKind,
  form,
  dirty,
  busy,
  error,
  conflict,
  preview,
  authorityConfirmation,
  discardConfirmation,
  onFormChange,
  onClose,
  onDiscard,
  onContinueEditing,
  onSave,
  onConfirmAuthorityChanges,
  onReload,
  t,
}: {
  readonly open: boolean;
  readonly mode: SkillEditorMode;
  readonly sourceKind: "user" | "evolved";
  readonly form: SkillEditorForm;
  readonly dirty: boolean;
  readonly busy: SkillEditorBusyState;
  readonly error: string;
  readonly conflict: boolean;
  readonly preview: SkillRevisionPreview | undefined;
  readonly authorityConfirmation: boolean;
  readonly discardConfirmation: boolean;
  readonly onFormChange: (form: SkillEditorForm) => void;
  readonly onClose: () => void;
  readonly onDiscard: () => void;
  readonly onContinueEditing: () => void;
  readonly onSave: () => void;
  readonly onConfirmAuthorityChanges: () => void;
  readonly onReload: () => void;
  readonly t: SettingsTranslator;
}): React.JSX.Element {
  const formValid = Boolean(form.name.trim() && form.summary.trim() && form.promptFragments.some((item) => item.trim()));
  const busyLabel = busy === "checking" ? t("Checking...") : t("Saving...");
  return (
    <Dialog
      open={open}
      busy={Boolean(busy)}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
    >
      <DialogContent className="settings-skill-editor-dialog" data-ui2-skill-editor-dialog="" size="lg">
        <DialogHeader
          title={t(mode === "create" ? "Create skill" : "Edit skill")}
          description={(
            <span className={sourceKind === "evolved" ? "settings-skill-editor-source is-evolved" : "settings-skill-editor-source"}>
              {sourceKind === "evolved" ? <Bot size={12} /> : null}
              {t(sourceKind === "evolved" ? "AI generated" : "My skill")}
            </span>
          )}
          closeLabel={t("Close skill editor")}
        />

        <DialogBody className="settings-skill-editor-body">
          <SkillEditorCoreFields form={form} busy={Boolean(busy)} onFormChange={onFormChange} t={t} />
          <SkillEditorAdvancedFields form={form} busy={Boolean(busy)} onFormChange={onFormChange} t={t} />
          <SkillEditorFeedback
            error={error}
            conflict={conflict}
            preview={preview}
            authorityConfirmation={authorityConfirmation}
            busy={Boolean(busy)}
            onReload={onReload}
            t={t}
          />
        </DialogBody>

        <DialogFooter className="settings-skill-editor-actions">
          {discardConfirmation ? (
            <InlineFeedback className="settings-skill-editor-discard" tone="warning" title={t("Discard unsaved changes?")}>
              <div className="settings-skill-editor-discard-actions">
                <Button size="sm" variant="secondary" onClick={onContinueEditing}>{t("Continue editing")}</Button>
                <Button size="sm" variant="danger" onClick={onDiscard}>{t("Discard changes")}</Button>
              </div>
            </InlineFeedback>
          ) : (
            <>
              <Button size="sm" variant="secondary" onClick={onClose} disabled={Boolean(busy)}>{t("Cancel")}</Button>
              <Button
                size="sm"
                variant="primary"
                leadingIcon={<Check size={15} />}
                loading={Boolean(busy)}
                loadingLabel={busyLabel}
                onClick={authorityConfirmation ? onConfirmAuthorityChanges : onSave}
                disabled={!formValid || (mode === "revision" && !dirty && !authorityConfirmation)}
              >
                {t(authorityConfirmation ? "Confirm and save" : "Save changes")}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
