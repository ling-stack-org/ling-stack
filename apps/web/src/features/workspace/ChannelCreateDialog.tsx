import { Check, Loader2, Plus, UserPlus, X } from "lucide-react";
import { useMemo } from "react";
import { useI18n } from "../../i18n.js";
import { isMediaProvider, providerPreflightReady } from "../../lib/providers.js";
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
    <div
      className="channel-create-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <section className="channel-create-dialog" role="dialog" aria-modal="true" aria-label={t("New channel")}>
        <div className="channel-create-head">
          <span>
            <Plus size={16} />
            <strong>{t("New channel")}</strong>
          </span>
          <button className="icon-button" type="button" onClick={onClose} aria-label={t("Cancel")} title={t("Cancel")}>
            <X size={14} />
          </button>
        </div>
        <div className="channel-options-grid channel-create-grid">
          <label className="field wide">
            <span>{t("Run provider")}</span>
            <select value={form.defaultProviderPresetId} onChange={(event) => onFormChange({ ...form, defaultProviderPresetId: event.target.value })} disabled={providersLoading || providers.length === 0}>
              <option value="">{t("Select provider preset")}</option>
              <ProviderPresetOptions runnableProviders={taskReadyProviders} blockedProviders={setupChatProviders} />
            </select>
          </label>
          <label className="field wide">
            <span>{t("Name")}</span>
            <input value={form.name} onChange={(event) => onFormChange({ ...form, name: event.target.value })} autoFocus />
          </label>
          <section className="channel-create-teammates field wide" aria-label={t("AI teammates")}>
            <span>{t("AI teammates")}</span>
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
          </section>
          <label className="field wide">
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
          <ChannelRuntimePolicyFields form={form} onChange={updateRuntimeForm} />
          <div className="channel-option-actions">
            <button className="primary-button compact-button" type="button" onClick={onCreateChannel} disabled={creating}>
              {creating ? <Loader2 className="spin" size={14} /> : <Plus size={14} />}
              {creating ? t("Creating isolated workspace...") : t("Create channel")}
            </button>
            <button className="secondary-button compact-button" type="button" onClick={onClose}>
              {t("Cancel")}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
