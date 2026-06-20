import { Bot, CheckCircle2, Image, Loader2, Save, Search, Settings, ShieldCheck, Upload } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { StatusBadge } from "../../shared/components/index.js";
import type { AiTeammate, TeammatePersonaDraft } from "../../types.js";
import { TeammateAvatarView } from "./TeammateAvatarView.js";

interface TeammateProfileSettingsForm {
  readonly displayName: string;
  readonly description: string;
  readonly providerPresetId: string;
  readonly status: AiTeammate["status"];
  readonly pinned: boolean;
  readonly hidden: boolean;
  readonly systemPrompt: string;
  readonly appendSystemPromptText: string;
}

interface PersonaImportForm {
  readonly sourcePath: string;
  readonly content: string;
}

export function TeammateProfileTab({
  cwd,
  teammate,
  settingsForm,
  personaImportForm,
  personaDraft,
  saveMessage,
  isProtectedSystemTeammate,
  uploadingAvatar,
  importingPersona,
  saving,
  onSettingsFormChange,
  onPersonaImportFormChange,
  onUploadAvatarFile,
  onRemoveAvatar,
  onPreviewPersonaImport,
  onApplyPersonaDraft,
  onSaveSettings,
}: {
  readonly cwd: string;
  readonly teammate: AiTeammate;
  readonly settingsForm: TeammateProfileSettingsForm;
  readonly personaImportForm: PersonaImportForm;
  readonly personaDraft: TeammatePersonaDraft | undefined;
  readonly saveMessage: string;
  readonly isProtectedSystemTeammate: boolean;
  readonly uploadingAvatar: boolean;
  readonly importingPersona: boolean;
  readonly saving: boolean;
  readonly onSettingsFormChange: (form: TeammateProfileSettingsForm) => void;
  readonly onPersonaImportFormChange: (form: PersonaImportForm) => void;
  readonly onUploadAvatarFile: (file: File | undefined) => void | Promise<void>;
  readonly onRemoveAvatar: () => void | Promise<void>;
  readonly onPreviewPersonaImport: () => void | Promise<void>;
  readonly onApplyPersonaDraft: () => void | Promise<void>;
  readonly onSaveSettings: () => void | Promise<void>;
}): JSX.Element {
  const { t } = useI18n();
  return (
    <section className="teammate-settings-panel" aria-label={t("Teammate settings")}>
      <div className="panel-title split">
        <span>
          <Settings size={16} />
          <h2>{t("Settings")}</h2>
        </span>
        {saveMessage ? <small>{saveMessage}</small> : null}
      </div>
      {isProtectedSystemTeammate ? (
        <div className="provider-run-notice neutral">
          <ShieldCheck size={16} />
          <span>{t("Ling Agent is a protected built-in teammate. You can personalize its name, avatar, description, and additional instructions; lifecycle and permissions stay managed by Ling Stack.")}</span>
        </div>
      ) : null}
      <section className="teammate-avatar-settings" aria-label={t("Avatar")}>
        <div className="teammate-avatar-preview compact-preview">
          <TeammateAvatarView teammate={teammate} cwd={cwd} />
          <span>{teammate.displayName}</span>
        </div>
        <div className="teammate-avatar-actions">
          <label className="secondary-button">
            {uploadingAvatar ? <Loader2 className="spin" size={15} /> : <Upload size={15} />}
            {t("Upload avatar")}
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = "";
                void onUploadAvatarFile(file);
              }}
            />
          </label>
          <button className="secondary-button compact-button" type="button" onClick={() => void onRemoveAvatar()} disabled={uploadingAvatar || !teammate.avatarImageAttachmentId}>
            <Image size={14} />
            {t("Remove avatar")}
          </button>
        </div>
      </section>
      {!isProtectedSystemTeammate ? (
        <section className="teammate-import-panel" aria-label={t("Persona import")}>
          <div className="panel-title split">
            <span>
              <Upload size={15} />
              <h3>{t("Persona import")}</h3>
            </span>
            {personaDraft ? <small>{t("Draft ready")}</small> : null}
          </div>
          <div className="teammate-task-create-grid">
            <label className="field">
              <span>{t("Source path")}</span>
              <input value={personaImportForm.sourcePath} onChange={(event) => onPersonaImportFormChange({ ...personaImportForm, sourcePath: event.target.value })} placeholder="AGENTS.md" />
            </label>
            <label className="field wide">
              <span>{t("Persona content")}</span>
              <textarea rows={5} value={personaImportForm.content} onChange={(event) => onPersonaImportFormChange({ ...personaImportForm, content: event.target.value })} />
            </label>
          </div>
          {personaDraft ? (
            <div className="teammate-import-preview">
              <article className="teammate-data-row">
                <span>
                  <strong>{personaDraft.displayName}</strong>
                  <small>{personaDraft.description}</small>
                </span>
                <StatusBadge status={personaDraft.sourceKind} />
              </article>
              {personaDraft.warnings.map((warning, index) => (
                <small key={`${warning}-${index}`} className="teammate-warning warning">
                  {warning}
                </small>
              ))}
            </div>
          ) : null}
          <div className="teammate-settings-actions">
            <button className="secondary-button" type="button" onClick={() => void onPreviewPersonaImport()} disabled={importingPersona || !personaImportForm.content.trim()}>
              {importingPersona ? <Loader2 className="spin" size={15} /> : <Search size={15} />}
              {t("Preview draft")}
            </button>
            <button className="primary-button" type="button" onClick={() => void onApplyPersonaDraft()} disabled={importingPersona || !personaDraft}>
              <CheckCircle2 size={15} />
              {t("Apply persona draft")}
            </button>
          </div>
        </section>
      ) : null}
      <div className="teammate-settings-grid">
        <label className="field">
          <span>{t("Teammate name")}</span>
          <input value={settingsForm.displayName} onChange={(event) => onSettingsFormChange({ ...settingsForm, displayName: event.target.value })} />
        </label>
        {!isProtectedSystemTeammate ? (
          <>
            <label className="field">
              <span>{t("Status")}</span>
              <select value={settingsForm.status} onChange={(event) => onSettingsFormChange({ ...settingsForm, status: event.target.value as AiTeammate["status"] })}>
                <option value="active">{t("active")}</option>
                <option value="paused">{t("paused")}</option>
                <option value="disabled">{t("disabled")}</option>
              </select>
            </label>
            <label className="teammate-toggle inline-toggle">
              <input type="checkbox" checked={settingsForm.pinned} onChange={(event) => onSettingsFormChange({ ...settingsForm, pinned: event.target.checked })} />
              <Bot size={15} />
              <span>
                <strong>{t("Pinned in sidebar")}</strong>
                <small>{t("Keep this teammate near the top of the workspace roster.")}</small>
              </span>
            </label>
            <label className="teammate-toggle inline-toggle">
              <input type="checkbox" checked={settingsForm.hidden} onChange={(event) => onSettingsFormChange({ ...settingsForm, hidden: event.target.checked })} />
              <Bot size={15} />
              <span>
                <strong>{t("Hidden from sidebar")}</strong>
                <small>{t("The teammate remains durable and can be restored later.")}</small>
              </span>
            </label>
          </>
        ) : null}
        <label className="field wide">
          <span>{t("Description")}</span>
          <textarea rows={3} value={settingsForm.description} onChange={(event) => onSettingsFormChange({ ...settingsForm, description: event.target.value })} />
        </label>
        {isProtectedSystemTeammate ? (
          <label className="field wide">
            <span>{t("Additional instructions")}</span>
            <textarea rows={5} value={settingsForm.appendSystemPromptText} onChange={(event) => onSettingsFormChange({ ...settingsForm, appendSystemPromptText: event.target.value })} placeholder={t("Add user preferences for Ling Agent without changing its core behavior.")} />
          </label>
        ) : (
          <label className="field wide">
            <span>{t("System prompt")}</span>
            <textarea rows={5} value={settingsForm.systemPrompt} onChange={(event) => onSettingsFormChange({ ...settingsForm, systemPrompt: event.target.value })} />
          </label>
        )}
      </div>
      <div className="teammate-settings-actions">
        <button className="primary-button" type="button" onClick={() => void onSaveSettings()} disabled={saving}>
          {saving ? <Loader2 className="spin" size={15} /> : <Save size={15} />}
          {t("Save")}
        </button>
      </div>
    </section>
  );
}
