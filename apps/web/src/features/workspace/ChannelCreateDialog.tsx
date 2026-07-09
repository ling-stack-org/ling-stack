import { Check, ChevronDown, Folder, FolderOpen, Loader2, Plus, Search, UserPlus } from "lucide-react";
import { useMemo, useState } from "react";
import { selectWorkspaceDirectory } from "../../api/workspace-directory.js";
import { useI18n } from "../../i18n.js";
import { isMediaProvider, providerPreflightReady } from "../../lib/providers.js";
import { CreateDialogShell, DialogSection } from "../../shared/components/index.js";
import type { ChannelCreateFormState, ChannelFormState, ProviderPreset } from "../../types.js";
import type { LocalTeammateDraft } from "../teammates/index.js";
import { TeammateAvatarView } from "../teammates/TeammateAvatarView.js";
import { LING_AGENT_AUTHOR_ID } from "./ChannelMessageRenderers.js";
import { ChannelRuntimePolicyFields, ProviderPresetOptions } from "./WorkspaceControls.js";

export interface ChannelCreateProjectOption {
  readonly path: string;
  readonly label: string;
}

export function ChannelCreateDialog({
  cwd,
  form,
  projectOptions,
  providers,
  providersLoading,
  teammates,
  creating,
  errorMessage,
  onFormChange,
  onCreateChannel,
  onClose,
}: {
  readonly cwd: string;
  readonly form: ChannelCreateFormState;
  readonly projectOptions: readonly ChannelCreateProjectOption[];
  readonly providers: readonly ProviderPreset[];
  readonly providersLoading: boolean;
  readonly teammates: readonly LocalTeammateDraft[];
  readonly creating: boolean;
  readonly errorMessage: string;
  readonly onFormChange: (form: ChannelCreateFormState) => void;
  readonly onCreateChannel: () => void;
  readonly onClose: () => void;
}): JSX.Element {
  const { t } = useI18n();
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [projectSearch, setProjectSearch] = useState("");
  const [selectingProject, setSelectingProject] = useState(false);
  const [projectError, setProjectError] = useState("");
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
  const selectedProjectPath = form.boundPath.trim() || cwd.trim();
  const selectedProjectLabel = selectedProjectPath ? projectLabelFromPath(selectedProjectPath) : t("Workspace default");
  const availableProjectOptions = useMemo(() => {
    const byPath = new Map<string, ChannelCreateProjectOption>();
    for (const option of projectOptions) {
      const path = option.path.trim();
      if (path && !byPath.has(path)) {
        byPath.set(path, { path, label: option.label.trim() || projectLabelFromPath(path) });
      }
    }
    if (selectedProjectPath && !byPath.has(selectedProjectPath)) {
      byPath.set(selectedProjectPath, { path: selectedProjectPath, label: selectedProjectLabel });
    }
    return [...byPath.values()];
  }, [projectOptions, selectedProjectLabel, selectedProjectPath]);
  const visibleProjectOptions = useMemo(() => {
    const query = projectSearch.trim().toLowerCase();
    if (!query) {
      return availableProjectOptions;
    }
    return availableProjectOptions.filter((option) =>
      `${option.label} ${option.path}`.toLowerCase().includes(query)
    );
  }, [availableProjectOptions, projectSearch]);

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

  function selectProjectPath(path: string): void {
    onFormChange({ ...form, boundPath: path });
    setProjectError("");
    setProjectSearch("");
    setProjectMenuOpen(false);
  }

  async function chooseExistingFolder(): Promise<void> {
    const pickerCwd = selectedProjectPath || cwd.trim();
    if (!pickerCwd) {
      setProjectError(t("Workspace folder unavailable"));
      return;
    }
    setSelectingProject(true);
    setProjectError("");
    try {
      const result = await selectWorkspaceDirectory(pickerCwd);
      if (!result.cancelled) {
        selectProjectPath(result.path);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setProjectError(message ? `${t("Folder picker unavailable.")} ${message}` : t("Folder picker unavailable."));
    } finally {
      setSelectingProject(false);
    }
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
              <div className="field wide channel-create-project-field">
                <span>{t("Project directory")}</span>
                <div className="channel-create-project-picker">
                  <button
                    className="channel-create-project-trigger"
                    type="button"
                    aria-label={t("Project directory")}
                    aria-haspopup="menu"
                    aria-expanded={projectMenuOpen}
                    disabled={creating}
                    onClick={() => {
                      setProjectError("");
                      setProjectMenuOpen((current) => !current);
                    }}
                  >
                    <Folder size={16} />
                    <span className="channel-create-project-label">
                      <strong>{selectedProjectLabel}</strong>
                      <small title={selectedProjectPath}>{selectedProjectPath || t("Workspace default")}</small>
                    </span>
                    {selectingProject ? <Loader2 className="spin" size={14} /> : <ChevronDown className={projectMenuOpen ? "expanded" : ""} size={15} />}
                  </button>
                  {projectMenuOpen ? (
                    <div className="channel-create-project-menu" role="menu" aria-label={t("Project folder options")}>
                      <label className="channel-create-project-search">
                        <Search size={14} />
                        <input
                          value={projectSearch}
                          onChange={(event) => setProjectSearch(event.target.value)}
                          placeholder={t("Search projects")}
                          aria-label={t("Search projects")}
                        />
                      </label>
                      <div className="channel-create-project-options">
                        {visibleProjectOptions.length > 0 ? visibleProjectOptions.map((option) => {
                          const selected = option.path === selectedProjectPath;
                          return (
                            <button
                              key={option.path}
                              className={selected ? "channel-create-project-option selected" : "channel-create-project-option"}
                              type="button"
                              role="menuitemradio"
                              aria-checked={selected}
                              onClick={() => selectProjectPath(option.path)}
                            >
                              <Folder size={15} />
                              <span>
                                <strong>{option.label}</strong>
                                <small>{option.path === cwd.trim() ? t("Current workspace") : option.path}</small>
                              </span>
                              {selected ? <Check size={14} /> : null}
                            </button>
                          );
                        }) : (
                          <span className="channel-create-project-empty">{t("No matching projects")}</span>
                        )}
                      </div>
                      <div className="channel-create-project-divider" />
                      <button
                        className="channel-create-project-option action"
                        type="button"
                        role="menuitem"
                        disabled={selectingProject}
                        onClick={() => void chooseExistingFolder()}
                      >
                        {selectingProject ? <Loader2 className="spin" size={15} /> : <FolderOpen size={15} />}
                        <span>
                          <strong>{selectingProject ? t("Selecting project...") : t("Use existing folder")}</strong>
                          <small>{t("Open the system folder picker")}</small>
                        </span>
                      </button>
                    </div>
                  ) : null}
                </div>
                <small className={projectError ? "channel-create-project-note error" : "channel-create-project-note"}>
                  {projectError || t("Ling will create an isolated channel workspace from this Git repository.")}
                </small>
              </div>
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

          {errorMessage ? (
            <div className="channel-create-error" role="alert">
              {errorMessage}
            </div>
          ) : null}

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

function projectLabelFromPath(path: string): string {
  const normalized = path.replace(/[\\/]+$/u, "");
  return normalized.split(/[\\/]/u).filter(Boolean).at(-1) || path;
}
