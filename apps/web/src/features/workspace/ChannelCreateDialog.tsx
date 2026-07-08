import { Check, Loader2, Plus, UserPlus } from "lucide-react";
import { useMemo } from "react";
import { useI18n } from "../../i18n.js";
import { isMediaProvider, providerPreflightReady } from "../../lib/providers.js";
import { CreateDialogShell, DialogSection } from "../../shared/components/index.js";
import type { ChannelCreateFormState, ChannelFormState, ProviderPreset } from "../../types.js";
import type { LocalTeammateDraft } from "../teammates/index.js";
import { TeammateAvatarView } from "../teammates/TeammateAvatarView.js";
import { LING_AGENT_AUTHOR_ID } from "./ChannelMessageRenderers.js";
import { ChannelRuntimePolicyFields, ProviderPresetOptions } from "./WorkspaceControls.js";

export function ChannelCreateDialog({
  cwd,
  form,
  providers,
  providersLoading,
  teammates,
  creating,
  onFormChange,
  onCreateChannel,
  onClose,
}: {
  readonly cwd: string;
  readonly form: ChannelCreateFormState;
  readonly providers: readonly ProviderPreset[];
  readonly providersLoading: boolean;
  readonly teammates: readonly LocalTeammateDraft[];
  readonly creating: boolean;
  readonly onFormChange: (form: ChannelCreateFormState) => void;
  readonly onCreateChannel: () => void;
  readonly onClose: () => void;
}): JSX.Element {
  const { t } = useI18n();
  const taskReadyProviders = useMemo(
    () => providers.filter(providerPreflightReady),
    [providers],
  );
  const setupChatProviders = useMemo(
    () => providers.filter((provider) => !isMediaProvider(provider) && !providerPreflightReady(provider)),
    [providers],
  );
  const teammateOptions = useMemo(
    () => teammates.filter((teammate) => teammate.id !== LING_AGENT_AUTHOR_ID && !teammate.hidden),
    [teammates],
  );

  function toggleTeammate(teammateId: string): void {
    const selected = new Set(form.selectedTeammateIds);
    if (selected.has(teammateId)) {
      selected.delete(teammateId);
    } else {
      selected.add(teammateId);
    }
    onFormChange({
      ...form,
      selectedTeammateIds: [...selected],
      defaultResponderTeammateId: "",
      defaultTeammateId: "",
    });
  }

  function updateRuntimeForm(nextForm: ChannelFormState): void {
    onFormChange({
      ...nextForm,
      selectedTeammateIds: form.selectedTeammateIds,
      defaultResponderTeammateId: "",
      defaultTeammateId: "",
    });
  }

  return (
    <CreateDialogShell
      ariaLabel={t("New channel")}
      title={t("New channel")}
      description={t("Name the channel, invite teammates, then create. Runtime defaults can be adjusted later.")}
      closeLabel={t("Cancel")}
      onClose={onClose}
      className="channel-create-dialog channel-create-dialog-clean"
      overlayClassName="channel-create-overlay"
      bodyClassName="channel-create-body"
      footer={(
        <>
          <button className="secondary-button compact-button" type="button" onClick={onClose}>
            {t("Cancel")}
          </button>
          <button className="primary-button compact-button" type="button" onClick={onCreateChannel} disabled={creating}>
            {creating ? <Loader2 className="spin" size={14} /> : <Plus size={14} />}
            {creating ? t("Creating isolated workspace...") : t("Create channel")}
          </button>
        </>
      )}
    >
          <DialogSection className="channel-create-section" title={t("Basic information")} description={t("This name appears in the sidebar and channel header.")}>
            <div className="channel-create-fields">
              <label className="field wide">
                <span>{t("Name")}</span>
                <input value={form.name} onChange={(event) => onFormChange({ ...form, name: event.target.value })} autoFocus />
              </label>
            </div>
          </DialogSection>

          <DialogSection className="channel-create-section channel-create-teammates" title={t("Invite teammates")} description={t("Pick collaborators now or manage members later.")}>
            {teammateOptions.length === 0 ? (
              <div className="client-empty-state compact-empty">
                <UserPlus size={16} />
                <span>{t("Create a workspace teammate before assigning channel members.")}</span>
              </div>
            ) : (
              <div className="channel-create-teammate-grid">
                {teammateOptions.map((teammate) => {
                  const selected = form.selectedTeammateIds.includes(teammate.id);
                  return (
                    <button
                      key={teammate.id}
                      className={selected ? "channel-create-teammate selected" : "channel-create-teammate"}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => toggleTeammate(teammate.id)}
                    >
                      <TeammateAvatarView teammate={teammate} cwd={cwd} compact />
                      <span>
                        <strong>{teammate.displayName}</strong>
                        <small>{selected ? t("Joined channel") : t("Not joined")}</small>
                      </span>
                      {selected ? <Check size={14} /> : <Plus size={14} />}
                    </button>
                  );
                })}
              </div>
            )}
          </DialogSection>

          <DialogSection
            className="channel-create-section channel-create-advanced"
            title={t("Advanced settings")}
            description={t("Model, language, and run policy")}
            collapsible
          >
            <div className="channel-create-advanced-body">
              <div className="channel-create-fields">
                <label className="field">
                  <span>{t("Base model")}</span>
                  <select value={form.defaultProviderPresetId} onChange={(event) => onFormChange({ ...form, defaultProviderPresetId: event.target.value })} disabled={providersLoading || providers.length === 0}>
                    <option value="">{t("Select provider preset")}</option>
                    <ProviderPresetOptions runnableProviders={taskReadyProviders} blockedProviders={setupChatProviders} />
                  </select>
                </label>
                <label className="field">
                  <span>{t("AI response language")}</span>
                  <select
                    value={form.responseLanguage}
                    onChange={(event) => onFormChange({ ...form, responseLanguage: event.target.value as ChannelFormState["responseLanguage"] })}
                  >
                    <option value="workspace">{t("Workspace default")}</option>
                    <option value="follow_user">{t("Follow user message")}</option>
                    <option value="zh-CN">{t("Chinese")}</option>
                    <option value="en-US">{t("English")}</option>
                  </select>
                </label>
              </div>
              <ChannelRuntimePolicyFields form={form} onChange={updateRuntimeForm} />
            </div>
          </DialogSection>

    </CreateDialogShell>
  );
}
