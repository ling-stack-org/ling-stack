import { Camera, RotateCcw, UserRoundCog } from "lucide-react";
import { useEffect, useRef, useState, type RefObject } from "react";
import { useI18n } from "../../i18n.js";
import {
  AvatarCropDialog,
  Button,
  Field,
  IconButton,
  InlineFeedback,
  Input,
  InspectorSection,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  Select,
  Textarea,
} from "../../shared/ui/index.js";
import type { AiTeammate, TeammatePersonaDraft } from "../../types.js";
import { TeammateAvatarView } from "./TeammateAvatarView.js";
import type { PersonaImportForm } from "./useTeammateProfileController.js";
import type { TeammateSettingsForm } from "./teammate-workspace-utils.js";
import { TeammatePersonaImportDialog } from "./TeammatePersonaImportDialog.js";

export function TeammateProfileTab({
  avatarCropSource,
  avatarTriggerRef,
  cwd,
  teammate,
  settingsForm,
  personaImportForm,
  personaDraft,
  personaError,
  profileError,
  isProtectedSystemTeammate,
  uploadingAvatar,
  personaBusyAction,
  onSettingsFormChange,
  onPersonaImportFormChange,
  onSelectAvatarFile,
  onRemoveAvatar,
  onCancelAvatarCrop,
  onConfirmAvatarCrop,
  onPreviewPersonaImport,
  onApplyPersonaDraft,
}: {
  readonly avatarCropSource?: string;
  readonly avatarTriggerRef: RefObject<HTMLButtonElement | null>;
  readonly cwd: string;
  readonly teammate: AiTeammate;
  readonly settingsForm: TeammateSettingsForm;
  readonly personaImportForm: PersonaImportForm;
  readonly personaDraft?: TeammatePersonaDraft;
  readonly personaError: string;
  readonly profileError: string;
  readonly isProtectedSystemTeammate: boolean;
  readonly uploadingAvatar: boolean;
  readonly personaBusyAction: "" | "apply" | "preview";
  readonly onSettingsFormChange: (form: TeammateSettingsForm) => void;
  readonly onPersonaImportFormChange: (form: PersonaImportForm) => void;
  readonly onSelectAvatarFile: (file?: File) => void | Promise<void>;
  readonly onRemoveAvatar: () => void | Promise<void>;
  readonly onCancelAvatarCrop: () => void;
  readonly onConfirmAvatarCrop: (dataUrl: string) => void | Promise<void>;
  readonly onPreviewPersonaImport: () => void | Promise<void>;
  readonly onApplyPersonaDraft: () => Promise<boolean>;
}): React.JSX.Element {
  const { t } = useI18n();
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const [personaImportOpen, setPersonaImportOpen] = useState(false);

  useEffect(() => setPersonaImportOpen(false), [teammate.id]);

  return (
    <section className="teammate-profile-panel" aria-label={t("Teammate profile")}>
      {profileError ? (
        <InlineFeedback className="teammate-profile-error" title={t("Profile needs attention")} tone="danger">
          {profileError}
        </InlineFeedback>
      ) : null}

      {isProtectedSystemTeammate ? (
        <InlineFeedback className="teammate-profile-protected" title={t("Protected teammate")} tone="neutral">
          {t("Ling Agent keeps lifecycle and permissions managed by Ling Stack.")}
        </InlineFeedback>
      ) : null}

      <div className="teammate-profile-identity">
        <div className="teammate-profile-avatar" aria-label={t("Avatar")}>
          <TeammateAvatarView teammate={teammate} cwd={cwd} />
          <Menu>
            <MenuTrigger asChild>
              <IconButton
                ref={avatarTriggerRef}
                className="teammate-profile-avatar-change"
                disabled={uploadingAvatar}
                icon={Camera}
                label={t("Avatar options")}
                loading={uploadingAvatar}
              />
            </MenuTrigger>
            <MenuContent align="start">
              <MenuItem onSelect={() => avatarInputRef.current?.click()}>
                <Camera aria-hidden="true" />
                <span>{t("Change avatar")}</span>
              </MenuItem>
              <MenuItem
                disabled={!teammate.avatarImageAttachmentId}
                onSelect={() => void onRemoveAvatar()}
              >
                <RotateCcw aria-hidden="true" />
                <span>{t("Restore default avatar")}</span>
              </MenuItem>
            </MenuContent>
          </Menu>
          <input
            data-ling-control-native="true"
            ref={avatarInputRef}
            className="teammate-profile-avatar-input"
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            aria-label={t("Upload avatar")}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              void onSelectAvatarFile(file);
            }}
          />
        </div>
        <div className="teammate-profile-identity-fields">
          <Field label={t("Teammate name")}>
            <Input
              value={settingsForm.displayName}
              onChange={(event) => onSettingsFormChange({ ...settingsForm, displayName: event.target.value })}
            />
          </Field>
        </div>
      </div>

      <Field className="teammate-profile-description" label={t("Description")}>
        <Textarea
          rows={3}
          value={settingsForm.description}
          onChange={(event) => onSettingsFormChange({ ...settingsForm, description: event.target.value })}
        />
      </Field>

      {!isProtectedSystemTeammate ? (
        <div className="teammate-profile-lifecycle">
          <Field label={t("Status")}>
            <Select
              value={settingsForm.status}
              onChange={(event) => onSettingsFormChange({
                ...settingsForm,
                status: event.target.value as AiTeammate["status"],
              })}
            >
              <option value="active">{t("active")}</option>
              <option value="paused">{t("paused")}</option>
              <option value="disabled">{t("disabled")}</option>
            </Select>
          </Field>
          <Field label={t("Sidebar display")}>
            <Select
              value={sidebarDisplayValue(settingsForm)}
              onChange={(event) => onSettingsFormChange(updateSidebarDisplay(
                settingsForm,
                event.target.value as SidebarDisplayValue,
              ))}
            >
              <option value="pinned">{t("Pinned display")}</option>
              <option value="normal">{t("Normal display")}</option>
              <option value="hidden">{t("Hidden display")}</option>
            </Select>
          </Field>
        </div>
      ) : null}

      {isProtectedSystemTeammate ? (
        <Field label={t("Additional instructions")}>
          <Textarea
            rows={6}
            value={settingsForm.appendSystemPromptText}
            placeholder={t("Add user preferences for Ling Agent without changing its core behavior.")}
            onChange={(event) => onSettingsFormChange({
              ...settingsForm,
              appendSystemPromptText: event.target.value,
            })}
          />
        </Field>
      ) : (
        <InspectorSection
          className="teammate-profile-advanced"
          title={t("Advanced profile")}
        >
          <div className="teammate-profile-advanced-body">
            <Field label={t("System prompt")}>
              <Textarea
                rows={5}
                value={settingsForm.systemPrompt}
                onChange={(event) => onSettingsFormChange({ ...settingsForm, systemPrompt: event.target.value })}
              />
            </Field>
            <div className="teammate-profile-persona-entry">
              <strong>{t("Role profile")}</strong>
              <Button
                leadingIcon={<UserRoundCog />}
                size="sm"
                variant="secondary"
                onClick={() => setPersonaImportOpen(true)}
              >
                {t("Import role profile")}
              </Button>
            </div>
          </div>
        </InspectorSection>
      )}

      {avatarCropSource ? (
        <AvatarCropDialog
          sourceDataUrl={avatarCropSource}
          onCancel={onCancelAvatarCrop}
          onConfirm={onConfirmAvatarCrop}
        />
      ) : null}

      {!isProtectedSystemTeammate ? (
        <TeammatePersonaImportDialog
          busyAction={personaBusyAction}
          draft={personaDraft}
          error={personaError}
          form={personaImportForm}
          open={personaImportOpen}
          onApply={onApplyPersonaDraft}
          onFormChange={onPersonaImportFormChange}
          onOpenChange={setPersonaImportOpen}
          onPreview={onPreviewPersonaImport}
        />
      ) : null}
    </section>
  );
}

type SidebarDisplayValue = "pinned" | "normal" | "hidden";

function sidebarDisplayValue(form: TeammateSettingsForm): SidebarDisplayValue {
  if (form.hidden) return "hidden";
  return form.pinned ? "pinned" : "normal";
}

function updateSidebarDisplay(
  form: TeammateSettingsForm,
  value: SidebarDisplayValue,
): TeammateSettingsForm {
  return {
    ...form,
    pinned: value === "pinned",
    hidden: value === "hidden",
  };
}
