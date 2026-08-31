import { Check, ChevronDown, Folder, FolderOpen, Loader2, Plus, Search, UserPlus } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { selectWorkspaceDirectory } from "../../api/workspace-directory.js";
import { useI18n } from "../../i18n.js";
import { SupportedLocaleOptions } from "../../i18n/SupportedLocaleOptions.js";
import { canUseConversationProvider, providerPreflightReady } from "../../lib/providers.js";
import { DialogSection } from "../../shared/components/index.js";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Field,
  Input,
  Select,
  InlineFeedback,
} from "../../shared/ui/index.js";
import type { ChannelCreateFormState, ChannelFormState, ProviderPreset } from "../../types.js";
import type { LocalTeammateDraft } from "../teammates/index.js";
import { TeammateAvatarView } from "../teammates/TeammateAvatarView.js";
import { LING_AGENT_AUTHOR_ID } from "./ChannelMessageRenderers.js";
import {
  ChannelExecutionModeSummary,
  ChannelWriteLockField,
  ProviderPresetOptions,
} from "./WorkspaceControls.js";

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
  defaultProviderId,
  teammates,
  creating,
  errorMessage,
  onFormChange,
  onCreateChannel,
  onOpenProviders,
  onClose,
}: {
  readonly cwd: string;
  readonly form: ChannelCreateFormState;
  readonly projectOptions: readonly ChannelCreateProjectOption[];
  readonly providers: readonly ProviderPreset[];
  readonly providersLoading: boolean;
  readonly defaultProviderId: string;
  readonly teammates: readonly LocalTeammateDraft[];
  readonly creating: boolean;
  readonly errorMessage: string;
  readonly onFormChange: (form: ChannelCreateFormState) => void;
  readonly onCreateChannel: () => void | Promise<void>;
  readonly onOpenProviders: () => void;
  readonly onClose: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const [open, setOpen] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [projectSearch, setProjectSearch] = useState("");
  const [selectingProject, setSelectingProject] = useState(false);
  const [projectError, setProjectError] = useState("");
  const closeRequestedRef = useRef(false);
  const closeCommittedRef = useRef(false);
  const returnFocusRef = useRef<HTMLElement | null>(
    typeof document !== "undefined" && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );
  const taskReadyProviders = useMemo(
    () => providers.filter((provider) => canUseConversationProvider(provider) && providerPreflightReady(provider)),
    [providers],
  );
  const setupChatProviders = useMemo(
    () => providers.filter((provider) => canUseConversationProvider(provider) && !providerPreflightReady(provider)),
    [providers],
  );
  const teammateOptions = useMemo(
    () => teammates.filter((teammate) => teammate.id !== LING_AGENT_AUTHOR_ID && !teammate.hidden),
    [teammates],
  );
  const selectedProjectPath = form.boundPath.trim() || cwd.trim();
  const busy = creating || submitting;
  const selectedProviderReady = taskReadyProviders.some((provider) => provider.id === form.defaultProviderPresetId);
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

  useEffect(() => {
    if (providersLoading || selectedProviderReady) return;
    const nextProvider = taskReadyProviders.find((provider) => provider.id === defaultProviderId) ?? taskReadyProviders[0];
    if (nextProvider && nextProvider.id !== form.defaultProviderPresetId) {
      onFormChange({ ...form, defaultProviderPresetId: nextProvider.id });
    }
  }, [defaultProviderId, form, onFormChange, providersLoading, selectedProviderReady, taskReadyProviders]);

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

  async function submitChannel(): Promise<void> {
    if (busy) return;
    setSubmitting(true);
    try {
      await onCreateChannel();
    } catch {
      // The owner exposes the product error through errorMessage.
    } finally {
      setSubmitting(false);
    }
  }

  function requestClose(): void {
    if (busy || closeRequestedRef.current) return;
    closeRequestedRef.current = true;
    setOpen(false);
  }

  function commitClose(): void {
    returnFocusRef.current?.focus({ preventScroll: true });
    if (closeCommittedRef.current) return;
    closeCommittedRef.current = true;
    onClose();
  }

  return (
    <Dialog
      busy={busy}
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) requestClose();
      }}
    >
      <DialogContent
        aria-label={t("New channel")}
        aria-labelledby={undefined}
        className="channel-create-dialog channel-create-dialog-clean"
        overlayClassName="channel-create-overlay"
        size="lg"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          commitClose();
        }}
      >
        <DialogHeader
          closeLabel={t("Cancel")}
          description={t("Name the channel, invite teammates, then create. Runtime defaults can be adjusted later.")}
          title={<strong>{t("New channel")}</strong>}
        />
        <DialogBody className="channel-create-body">
          <DialogSection className="channel-create-section" title={t("Basic information")} description={t("This name appears in the sidebar and channel header.")}>
            <div className="channel-create-fields">
              <Field className="field wide channel-create-name-field" label={t("Name")}>
                <Input
                  autoFocus
                  className="channel-create-name-native"
                  containerClassName="channel-create-name-input"
                  value={form.name}
                  onChange={(event) => onFormChange({ ...form, name: event.target.value })}
                />
              </Field>
              <Field className="field wide channel-create-model-field" label={t("Ling Agent model")}>
                <Select
                  size="md"
                  value={form.defaultProviderPresetId}
                  onChange={(event) => onFormChange({ ...form, defaultProviderPresetId: event.target.value })}
                  disabled={providersLoading || taskReadyProviders.length === 0}
                >
                  <option value="" disabled>{t("Select provider preset")}</option>
                  <ProviderPresetOptions runnableProviders={taskReadyProviders} blockedProviders={setupChatProviders} />
                </Select>
              </Field>
              <div className="field wide channel-create-project-field">
                <span>{t("Project directory")}</span>
                <div className="channel-create-project-picker">
                  <button
                    className="channel-create-project-trigger"
                    type="button"
                    aria-label={t("Project directory")}
                    aria-haspopup="menu"
                    aria-expanded={projectMenuOpen}
                    disabled={busy}
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
                      <Input
                        aria-label={t("Search projects")}
                        className="channel-create-project-search-native"
                        containerClassName="channel-create-project-search"
                        prefix={<Search size={14} />}
                        size="sm"
                        value={projectSearch}
                        onChange={(event) => setProjectSearch(event.target.value)}
                        placeholder={t("Search projects")}
                      />
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
                  {projectError || t("Git repositories use isolated channel workspaces; other folders run directly from the selected folder.")}
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

          {!providersLoading && !selectedProviderReady ? (
            <InlineFeedback className="channel-create-model-feedback" tone="warning" title={t("Choose a model before creating.")}>
              <button className="secondary-button compact-button" type="button" onClick={onOpenProviders}>
                {t("Open Model Workbench")}
              </button>
            </InlineFeedback>
          ) : null}

          <DialogSection
            className="channel-create-section channel-create-advanced"
            title={t("Advanced settings")}
            description={t("Language and run policy")}
            collapsible
          >
            <div className="channel-create-advanced-body">
              <div className="channel-create-advanced-controls">
                <label className="field">
                  <span>{t("AI response language")}</span>
                  <Select
                    size="md"
                    value={form.responseLanguage}
                    onChange={(event) => onFormChange({ ...form, responseLanguage: event.target.value as ChannelFormState["responseLanguage"] })}
                  >
                    <option value="workspace">{t("Workspace default")}</option>
                    <option value="follow_user">{t("Follow user message")}</option>
                    <SupportedLocaleOptions />
                  </Select>
                </label>
                <ChannelWriteLockField form={form} onChange={updateRuntimeForm} />
              </div>
              <ChannelExecutionModeSummary />
            </div>
          </DialogSection>

        </DialogBody>
        <DialogFooter className="channel-create-dialog-footer">
          <button className="secondary-button compact-button" type="button" onClick={requestClose} disabled={busy}>
            {t("Cancel")}
          </button>
          <button className="primary-button compact-button" type="button" onClick={() => void submitChannel()} disabled={busy || !selectedProviderReady || !form.name.trim()}>
            {busy ? <Loader2 className="spin" size={14} /> : <Plus size={14} />}
            {busy ? t("Creating channel...") : t("Create channel")}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function projectLabelFromPath(path: string): string {
  const normalized = path.replace(/[\\/]+$/u, "");
  return normalized.split(/[\\/]/u).filter(Boolean).at(-1) || path;
}
