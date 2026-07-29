import { Camera, Check, Search, ShieldCheck, Trash2 } from "lucide-react";
import { useRef, type RefObject } from "react";
import { useI18n } from "../../i18n.js";
import {
  AvatarCropDialog,
  Button,
  DataRow,
  Field,
  IconButton,
  InlineFeedback,
  Input,
  InspectorSection,
  Select,
  StatusIndicator,
  Switch,
  Textarea,
} from "../../shared/ui/index.js";
import type { AiTeammate, TeammatePersonaDraft } from "../../types.js";
import { TeammateAvatarView } from "./TeammateAvatarView.js";
import type { PersonaImportForm } from "./useTeammateProfileController.js";
import type { TeammateSettingsForm } from "./teammate-workspace-utils.js";

export function TeammateProfileTab({
  avatarCropSource,
  avatarTriggerRef,
  cwd,
  teammate,
  settingsForm,
  personaImportForm,
  personaDraft,
  profileError,
  isProtectedSystemTeammate,
  uploadingAvatar,
  importingPersona,
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
  readonly avatarTriggerRef: RefObject<HTMLButtonElement>;
  readonly cwd: string;
  readonly teammate: AiTeammate;
  readonly settingsForm: TeammateSettingsForm;
  readonly personaImportForm: PersonaImportForm;
  readonly personaDraft?: TeammatePersonaDraft;
  readonly profileError: string;
  readonly isProtectedSystemTeammate: boolean;
  readonly uploadingAvatar: boolean;
  readonly importingPersona: boolean;
  readonly onSettingsFormChange: (form: TeammateSettingsForm) => void;
  readonly onPersonaImportFormChange: (form: PersonaImportForm) => void;
  readonly onSelectAvatarFile: (file?: File) => void | Promise<void>;
  readonly onRemoveAvatar: () => void | Promise<void>;
  readonly onCancelAvatarCrop: () => void;
  readonly onConfirmAvatarCrop: (dataUrl: string) => void | Promise<void>;
  readonly onPreviewPersonaImport: () => void | Promise<void>;
  readonly onApplyPersonaDraft: () => void | Promise<void>;
}): JSX.Element {
  const { t } = useI18n();
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const status = teammateProfileStatus(settingsForm.status, isProtectedSystemTeammate, t);

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
          <IconButton
            ref={avatarTriggerRef}
            className="teammate-profile-avatar-change"
            disabled={uploadingAvatar}
            icon={Camera}
            label={t("Change avatar")}
            loading={uploadingAvatar}
            onClick={() => avatarInputRef.current?.click()}
          />
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
          <div className="teammate-profile-identity-status">
            <StatusIndicator compact label={status.label} tone={status.tone} />
            <IconButton
              disabled={uploadingAvatar || !teammate.avatarImageAttachmentId}
              icon={Trash2}
              label={t("Remove avatar")}
              onClick={() => void onRemoveAvatar()}
            />
          </div>
        </div>
      </div>

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
          <Field label={t("Pinned in sidebar")}>
            <Switch
              checked={settingsForm.pinned}
              onCheckedChange={(checked) => onSettingsFormChange({ ...settingsForm, pinned: checked })}
            />
          </Field>
          <Field label={t("Hidden from sidebar")}>
            <Switch
              checked={settingsForm.hidden}
              onCheckedChange={(checked) => onSettingsFormChange({ ...settingsForm, hidden: checked })}
            />
          </Field>
        </div>
      ) : null}

      <Field className="teammate-profile-description" label={t("Description")}>
        <Textarea
          rows={4}
          value={settingsForm.description}
          onChange={(event) => onSettingsFormChange({ ...settingsForm, description: event.target.value })}
        />
      </Field>

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
          summary={t("System prompt and persona import")}
        >
          <div className="teammate-profile-advanced-body">
            <Field label={t("System prompt")}>
              <Textarea
                rows={6}
                value={settingsForm.systemPrompt}
                onChange={(event) => onSettingsFormChange({ ...settingsForm, systemPrompt: event.target.value })}
              />
            </Field>

            <section className="teammate-profile-persona" aria-label={t("Persona import")}>
              <div className="teammate-profile-persona-heading">
                <h3>{t("Persona import")}</h3>
                {personaDraft ? <StatusIndicator compact label={t("Draft ready")} tone="info" /> : null}
              </div>
              <Field label={t("Source path")}>
                <Input
                  value={personaImportForm.sourcePath}
                  placeholder="AGENTS.md"
                  onChange={(event) => onPersonaImportFormChange({
                    ...personaImportForm,
                    sourcePath: event.target.value,
                  })}
                />
              </Field>
              <Field label={t("Persona content")}>
                <Textarea
                  rows={6}
                  value={personaImportForm.content}
                  onChange={(event) => onPersonaImportFormChange({
                    ...personaImportForm,
                    content: event.target.value,
                  })}
                />
              </Field>
              {personaDraft ? (
                <div className="teammate-profile-persona-preview">
                  <DataRow
                    compact
                    className="teammate-profile-persona-row"
                    identity={<strong>{personaDraft.displayName}</strong>}
                    summary={<span className="teammate-profile-persona-summary">{personaDraft.description}</span>}
                    status={<StatusIndicator compact label={t(personaDraft.sourceKind)} tone="neutral" />}
                  />
                  {personaDraft.warnings.map((warning, index) => (
                    <InlineFeedback key={`${warning}-${index}`} tone="warning">{warning}</InlineFeedback>
                  ))}
                </div>
              ) : null}
              <div className="teammate-profile-persona-actions">
                <Button
                  disabled={!personaImportForm.content.trim()}
                  leadingIcon={<Search />}
                  loading={importingPersona}
                  loadingLabel={t("Loading")}
                  size="sm"
                  onClick={() => void onPreviewPersonaImport()}
                >
                  {t("Preview draft")}
                </Button>
                <Button
                  disabled={!personaDraft}
                  leadingIcon={<Check />}
                  loading={importingPersona}
                  loadingLabel={t("Saving")}
                  size="sm"
                  variant="primary"
                  onClick={() => void onApplyPersonaDraft()}
                >
                  {t("Apply persona draft")}
                </Button>
              </div>
            </section>
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
    </section>
  );
}

function teammateProfileStatus(
  status: AiTeammate["status"],
  isProtected: boolean,
  t: (key: string) => string,
): { readonly label: string; readonly tone: "danger" | "neutral" | "success" | "warning" } {
  if (isProtected) return { label: t("Protected teammate"), tone: "neutral" };
  if (status === "active") return { label: t("active"), tone: "success" };
  if (status === "paused") return { label: t("paused"), tone: "warning" };
  return { label: t("disabled"), tone: "danger" };
}
