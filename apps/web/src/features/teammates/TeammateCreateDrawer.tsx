import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  Brain,
  Check,
  CheckCircle2,
  CircleAlert,
  Code2,
  FileText,
  Loader2,
  Palette,
  PlugZap,
  Plus,
  Rocket,
  Settings,
  ShieldCheck,
  Sparkles,
  Upload,
  Workflow,
  X,
} from "lucide-react";
import type { AiTeammateTemplate } from "@ling-stack/core/skill-types";
import { useI18n } from "../../i18n.js";
import { canUseConversationProvider, providerModelRouteLabel, providerPreflightReady } from "../../lib/providers.js";
import { AvatarInitial, CreateDialogShell, DialogSection, type AvatarTone } from "../../shared/components/index.js";
import type { Channel, ProviderPreset } from "../../types.js";
import { roleLabel } from "./helpers.js";
import { selectDefaultTeammateProvider, selectDefaultTeammateTemplate } from "./teammate-create-defaults.js";
import type {
  LocalTeammateCreateInput,
  TeammateCreateMode,
  TeammateCreateProgressEvent,
  TeammateCreateResult,
  TeammateCreateSetupStep,
  TeammateCreateStepState,
} from "./types.js";

interface StepViewState {
  readonly state: TeammateCreateStepState;
  readonly message: string;
}

const setupStepIds: readonly TeammateCreateSetupStep[] = ["workspace", "model", "record", "avatar", "channels", "memory", "refresh"];
const avatarTones: readonly AvatarTone[] = ["violet", "blue", "teal", "orange", "rose", "gray"];

export function TeammateCreateDrawer({
  open,
  initialTemplateId,
  templates,
  providers,
  channels,
  defaultProviderId = "",
  onCreate,
  onClose,
  onOpenCreated,
  onOpenProviders,
}: {
  readonly open: boolean;
  readonly initialTemplateId?: string;
  readonly templates: readonly AiTeammateTemplate[];
  readonly providers: readonly ProviderPreset[];
  readonly channels: readonly Channel[];
  readonly defaultProviderId?: string;
  readonly onCreate: (
    teammate: LocalTeammateCreateInput,
    onProgress?: (event: TeammateCreateProgressEvent) => void,
  ) => Promise<TeammateCreateResult>;
  readonly onClose: () => void;
  readonly onOpenCreated?: (teammateId: string) => void;
  readonly onOpenProviders: () => void;
}): JSX.Element | null {
  const { t } = useI18n();
  const providerOptions = useMemo(
    () => providers.filter((provider) => canUseConversationProvider(provider) && providerPreflightReady(provider)),
    [providers],
  );
  const [mode, setMode] = useState<TeammateCreateMode>("role_select");
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [draftName, setDraftName] = useState("");
  const [draftDescription, setDraftDescription] = useState("");
  const [selectedProviderId, setSelectedProviderId] = useState("");
  const [selectedChannelIds, setSelectedChannelIds] = useState<readonly string[]>([]);
  const [avatarTone, setAvatarTone] = useState<AvatarTone>("violet");
  const [avatarFile, setAvatarFile] = useState<File | undefined>();
  const [avatarPreviewUrl, setAvatarPreviewUrl] = useState("");
  const [setupSteps, setSetupSteps] = useState<Record<TeammateCreateSetupStep, StepViewState>>(createInitialStepState);
  const [setupResult, setSetupResult] = useState<TeammateCreateResult | undefined>();
  const [setupInput, setSetupInput] = useState<LocalTeammateCreateInput | undefined>();
  const selectedTemplate = selectedTemplateId ? templates.find((template) => template.id === selectedTemplateId) : undefined;
  const selectedProvider = providerOptions.find((provider) => provider.id === selectedProviderId);
  const previewName = draftName.trim() || (selectedTemplate ? t(selectedTemplate.name) : t("Custom teammate"));
  const previewDescription = draftDescription.trim() || (selectedTemplate ? t(selectedTemplate.summary) : t("Describe this teammate with a short working brief."));
  const selectedProviderReady = Boolean(selectedProvider && providerPreflightReady(selectedProvider));
  const canCreateTeammate = Boolean(previewName.trim()) && Boolean(selectedProvider) && selectedProviderReady;
  const visibleCreateTemplates = templates.slice(0, 5);
  const setupBusy = mode === "setup_progress" && (!setupResult || Object.values(setupSteps).some((step) => step.state === "running"));

  useEffect(() => {
    if (!open) {
      return;
    }
    const template = templates.find((item) => item.id === initialTemplateId) ?? selectDefaultTeammateTemplate(templates);
    setMode("role_select");
    setSelectedTemplateId(template?.id ?? "");
    setDraftName(template ? t(template.name) : t("Custom teammate"));
    setDraftDescription(template ? t(template.summary) : t("Describe this teammate with a short working brief."));
    setSelectedProviderId(selectDefaultTeammateProvider(providerOptions, defaultProviderId)?.id ?? providerOptions[0]?.id ?? "");
    setSelectedChannelIds(channels[0] ? [channels[0].id] : []);
    setAvatarTone("violet");
    setAvatarFile(undefined);
    setSetupSteps(createInitialStepState());
    setSetupResult(undefined);
    setSetupInput(undefined);
  }, [channels, defaultProviderId, initialTemplateId, open, providerOptions, templates, t]);

  useEffect(() => {
    if (!avatarFile) {
      setAvatarPreviewUrl("");
      return undefined;
    }
    const objectUrl = URL.createObjectURL(avatarFile);
    setAvatarPreviewUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [avatarFile]);

  useEffect(() => {
    if (!open || !selectedProviderId || providerOptions.some((provider) => provider.id === selectedProviderId)) {
      return;
    }
    setSelectedProviderId(selectDefaultTeammateProvider(providerOptions, defaultProviderId)?.id ?? providerOptions[0]?.id ?? "");
  }, [defaultProviderId, open, providerOptions, selectedProviderId]);

  if (!open) {
    return null;
  }

  function selectTemplate(template: AiTeammateTemplate): void {
    setSelectedTemplateId(template.id);
    setDraftName(t(template.name));
    setDraftDescription(t(template.summary));
    setAvatarTone("violet");
    setAvatarFile(undefined);
  }

  function openCustomSetup(): void {
    setSelectedTemplateId("");
    setDraftName(t("Custom teammate"));
    setDraftDescription(t("Describe this teammate with a short working brief."));
    setAvatarTone("violet");
    setAvatarFile(undefined);
    setMode("custom_setup");
    setSetupResult(undefined);
  }

  function openProvidersAndClose(): void {
    if (setupBusy) {
      return;
    }
    onClose();
    onOpenProviders();
  }

  function buildCreateInput(): LocalTeammateCreateInput {
    return {
      templateId: selectedTemplate?.id,
      displayName: previewName,
      description: previewDescription,
      avatarTone: selectedTemplate ? undefined : avatarTone,
      avatarFile: selectedTemplate ? undefined : avatarFile,
      providerPresetId: selectedProvider?.id,
      modelLabel: selectedProvider ? `${selectedProvider.displayName} / ${selectedProvider.model}` : t("No model selected"),
      channelIds: selectedChannelIds,
    };
  }

  async function createTeammateDraft(): Promise<void> {
    if (!canCreateTeammate || setupBusy) {
      return;
    }
    const createInput = buildCreateInput();
    setSetupInput(createInput);
    setSetupSteps(createInitialStepState());
    setSetupResult(undefined);
    setMode("setup_progress");
    const result = await onCreate(createInput, handleProgressEvent);
    setSetupResult(result);
    if (result.ok) {
      onClose();
      if (result.teammateId) {
        onOpenCreated?.(result.teammateId);
      }
    }
  }

  function handleProgressEvent(event: TeammateCreateProgressEvent): void {
    setSetupSteps((current) => ({
      ...current,
      [event.step]: {
        state: event.state,
        message: event.message ?? current[event.step].message,
      },
    }));
  }

  function retrySetup(): void {
    if (!setupInput || setupBusy) {
      return;
    }
    setDraftName(setupInput.displayName);
    setDraftDescription(setupInput.description);
    setSelectedProviderId(setupInput.providerPresetId ?? "");
    setSelectedChannelIds(setupInput.channelIds);
    setAvatarTone(isAvatarTone(setupInput.avatarTone) ? setupInput.avatarTone : "violet");
    setAvatarFile(setupInput.templateId ? undefined : setupInput.avatarFile);
    setSelectedTemplateId(setupInput.templateId ?? "");
    setMode(setupInput.templateId ? "role_select" : "custom_setup");
    setSetupResult(undefined);
    setSetupSteps(createInitialStepState());
  }

  function finishSetup(): void {
    const createdTeammateId = setupResult?.ok ? setupResult.teammateId : undefined;
    onClose();
    if (createdTeammateId) {
      onOpenCreated?.(createdTeammateId);
    }
  }

  const footer = renderFooter();

  return (
    <CreateDialogShell
      ariaLabel={t("Create AI teammate")}
      title={mode === "custom_setup" ? t("Custom AI teammate") : mode === "setup_progress" ? t("Creating AI teammate") : t("New AI teammate")}
      description={mode === "setup_progress" ? t("Ling is checking the model and preparing this teammate.") : mode === "custom_setup" ? t("Choose the identity and ready model this teammate will use.") : t("Recommended role and model are prefilled. Review them, then create.")}
      closeLabel={t("Cancel")}
      onClose={setupBusy ? () => undefined : onClose}
      className={`channel-create-dialog teammate-create-dialog ${mode === "custom_setup" ? "custom-mode" : ""} ${mode === "setup_progress" ? "progress-mode" : ""}`}
      overlayClassName="channel-create-overlay teammate-create-overlay"
      bodyClassName="channel-options-grid channel-create-grid teammate-create-body"
      footer={footer}
    >
      {mode === "custom_setup" ? renderCustomSetup() : mode === "setup_progress" ? renderSetupProgress() : renderRoleSelect()}
    </CreateDialogShell>
  );

  function renderRoleSelect(): JSX.Element {
    return (
      <>
        <DialogSection className="teammate-create-section" title={t("Choose initial role")}>
          <div className="teammate-create-list role-grid" aria-label={t("Teammate template chooser")}>
            {visibleCreateTemplates.map((template) => (
              <button
                key={template.id}
                className={template.id === selectedTemplate?.id ? "teammate-template-row selected" : "teammate-template-row"}
                type="button"
                aria-pressed={template.id === selectedTemplate?.id}
                onClick={() => selectTemplate(template)}
              >
                <span className="teammate-role-icon">{templateRoleIcon(template)}</span>
                <span className="teammate-template-copy">
                  <strong>{t(template.name)}</strong>
                  <small>{t(template.summary)}</small>
                </span>
                <small className="template-skill-count">{roleLabel(template.roleKey, t)}</small>
              </button>
            ))}
            <button
              className="teammate-template-row teammate-custom-entry"
              type="button"
              aria-pressed={mode === "custom_setup"}
              onClick={openCustomSetup}
            >
              <span className="teammate-role-icon"><Plus size={14} /></span>
              <span className="teammate-template-copy">
                <strong>{t("Start from blank")}</strong>
                <small>{t("Open a focused setup page for a custom teammate.")}</small>
              </span>
              <small className="template-skill-count">{t("Custom")}</small>
            </button>
          </div>
        </DialogSection>

        <DialogSection className="teammate-create-section" title={t("Basic information")}>
          <div className="teammate-create-fields">
            <label className="field">
              <span>{t("Teammate name")}</span>
              <input value={draftName} onChange={(event) => setDraftName(event.target.value)} />
            </label>
            <label className="field">
              <span>{t("Join channels")}</span>
              {renderChannelSelect()}
            </label>
            <label className="field">
              <span>{t("Base model")}</span>
              {renderProviderSelect()}
            </label>
          </div>
          {renderNoModelState()}
        </DialogSection>
      </>
    );
  }

  function renderCustomSetup(): JSX.Element {
    return (
      <section className="teammate-custom-setup" aria-label={t("Custom teammate setup")}>
        <button className="secondary-button compact-button teammate-custom-back" type="button" onClick={() => setMode("role_select")}>
          <ArrowLeft size={14} />
          {t("Back")}
        </button>
        <div className="teammate-custom-profile">
          <div className="teammate-custom-avatar">
            <label className="teammate-custom-avatar-picker">
              {avatarPreviewUrl ? (
                <img src={avatarPreviewUrl} alt="" />
              ) : (
                <AvatarInitial label={teammateInitial(previewName)} tone={avatarTone} />
              )}
              <span className="teammate-custom-avatar-upload" aria-hidden="true">
                <Upload size={13} />
              </span>
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                aria-label={t("Upload avatar")}
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  event.currentTarget.value = "";
                  setAvatarFile(file);
                }}
              />
            </label>
            <span className="teammate-custom-avatar-copy">
              <strong>{avatarFile ? avatarFile.name : t("Custom")}</strong>
              <small>{avatarFile ? t("Avatar selected") : t("Upload an avatar or use a color.")}</small>
            </span>
          </div>
          {avatarFile ? (
            <button className="secondary-button compact-button teammate-avatar-remove" type="button" onClick={() => setAvatarFile(undefined)}>
              <X size={13} />
              {t("Remove avatar")}
            </button>
          ) : (
            <div className="teammate-avatar-tone-list" aria-label={t("Avatar color")}>
              {avatarTones.map((tone) => (
                <button
                  key={tone}
                  className={avatarTone === tone ? `avatar-tone-option ${tone} selected` : `avatar-tone-option ${tone}`}
                  type="button"
                  aria-label={t("Avatar color {tone}", { tone })}
                  aria-pressed={avatarTone === tone}
                  onClick={() => setAvatarTone(tone)}
                />
              ))}
            </div>
          )}
        </div>

        <div className="teammate-custom-fields">
          <label className="field">
            <span>{t("Teammate name")}</span>
            <input value={draftName} onChange={(event) => setDraftName(event.target.value)} />
          </label>
          <label className="field">
            <span>{t("Base model")}</span>
            {renderProviderSelect()}
          </label>
          <label className="field teammate-custom-brief">
            <span>{t("Brief description")}</span>
            <textarea
              rows={5}
              value={draftDescription}
              onChange={(event) => setDraftDescription(event.target.value)}
              placeholder={t("Describe what this teammate should help with.")}
            />
          </label>
          <label className="field">
            <span>{t("Join channels")}</span>
            {renderChannelSelect()}
          </label>
        </div>
        {renderNoModelState()}
      </section>
    );
  }

  function renderSetupProgress(): JSX.Element {
    const tone = setupResult?.ok ? "success" : setupResult ? "failed" : "running";
    return (
      <section className={`teammate-create-progress ${tone}`} aria-label={t("Teammate setup progress")}>
        <div className="teammate-create-progress-summary">
          <span className={`teammate-create-progress-icon ${tone}`}>
            {setupResult ? setupResult.ok ? <CheckCircle2 size={22} /> : <CircleAlert size={22} /> : <Loader2 className="spin" size={22} />}
          </span>
          <div>
            <strong>{setupResult ? setupResult.ok ? t("Teammate ready") : t("Setup needs attention") : t("Creating and checking teammate")}</strong>
            <p>{setupResult?.message ?? t("Keep this dialog open while Ling prepares the teammate.")}</p>
          </div>
        </div>
        <ol className="teammate-create-step-list">
          {setupStepIds.map((step) => (
            <li key={step} className={`teammate-create-step ${setupSteps[step].state}`}>
              <span className="teammate-create-step-icon">{renderStepIcon(setupSteps[step].state)}</span>
              <span>
                <strong>{t(setupStepLabel(step))}</strong>
                <small>{setupSteps[step].message || t(setupStepDefaultMessage(step))}</small>
              </span>
            </li>
          ))}
        </ol>
      </section>
    );
  }

  function renderProviderSelect(): JSX.Element {
    return (
      <select value={selectedProviderId} onChange={(event) => setSelectedProviderId(event.target.value)} disabled={providerOptions.length === 0 || setupBusy}>
        <option value="">{t("Select model")}</option>
        {providerOptions.map((provider) => (
          <option key={provider.id} value={provider.id}>
            {providerModelRouteLabel(provider)}
          </option>
        ))}
      </select>
    );
  }

  function renderChannelSelect(): JSX.Element {
    return (
      <select
        value={selectedChannelIds[0] ?? ""}
        onChange={(event) => setSelectedChannelIds(event.target.value ? [event.target.value] : [])}
        disabled={channels.length === 0 || setupBusy}
      >
        <option value="">{channels.length === 0 ? t("No channels yet") : t("No channel")}</option>
        {channels.map((channel) => (
          <option key={channel.id} value={channel.id}>
            {channel.name}
          </option>
        ))}
      </select>
    );
  }

  function renderNoModelState(): JSX.Element | null {
    return providerOptions.length === 0 ? (
      <div className="client-empty-state teammate-empty teammate-create-model-empty">
        <PlugZap size={20} />
        <span>{t("No ready chat model")}</span>
        <button className="secondary-button" type="button" onClick={openProvidersAndClose}>{t("Open Model Workbench")}</button>
      </div>
    ) : null;
  }

  function renderFooter(): JSX.Element {
    if (mode === "setup_progress") {
      const showModelWorkbench = Boolean(setupResult && !setupResult.ok && setupSteps.model.state === "failed");
      return (
        <>
          {setupResult && !setupResult.ok ? (
            <button className="secondary-button compact-button" type="button" onClick={retrySetup}>
              <ArrowLeft size={14} />
              {t("Back to setup")}
            </button>
          ) : null}
          {showModelWorkbench ? (
            <button className="secondary-button compact-button" type="button" onClick={openProvidersAndClose}>
              <Settings size={14} />
              {t("Open Model Workbench")}
            </button>
          ) : null}
          <button className="primary-button compact-button" type="button" onClick={finishSetup} disabled={setupBusy}>
            {setupBusy ? <Loader2 className="spin" size={14} /> : <Check size={14} />}
            {setupBusy ? t("Creating...") : setupResult?.ok && setupResult.teammateId ? t("Open teammate chat") : t("Done")}
          </button>
        </>
      );
    }

    return (
      <>
        {!selectedProviderReady ? (
          <span className="teammate-create-blocked">{selectedProvider ? t("Selected model needs configuration.") : t("Choose a model before creating.")}</span>
        ) : null}
        <button className="secondary-button compact-button" type="button" onClick={onClose}>
          {t("Cancel")}
        </button>
        <button className="primary-button compact-button" type="button" onClick={() => void createTeammateDraft()} disabled={!canCreateTeammate || setupBusy}>
          {setupBusy ? <Loader2 className="spin" size={14} /> : <Plus size={14} />}
          {mode === "custom_setup" ? t("Create and verify") : t("Create teammate")}
        </button>
      </>
    );
  }
}

function createInitialStepState(): Record<TeammateCreateSetupStep, StepViewState> {
  return Object.fromEntries(setupStepIds.map((step) => [step, { state: "pending", message: "" }])) as Record<TeammateCreateSetupStep, StepViewState>;
}

function renderStepIcon(state: TeammateCreateStepState): JSX.Element {
  if (state === "running") {
    return <Loader2 className="spin" size={14} />;
  }
  if (state === "success") {
    return <Check size={14} />;
  }
  if (state === "failed") {
    return <CircleAlert size={14} />;
  }
  if (state === "skipped") {
    return <CheckCircle2 size={14} />;
  }
  return <span aria-hidden="true" />;
}

function setupStepLabel(step: TeammateCreateSetupStep): string {
  switch (step) {
    case "workspace":
      return "Workspace";
    case "model":
      return "Model check";
    case "record":
      return "Create teammate";
    case "avatar":
      return "Upload avatar";
    case "channels":
      return "Join channel";
    case "memory":
      return "Prepare memory";
    case "refresh":
      return "Refresh workspace";
  }
}

function setupStepDefaultMessage(step: TeammateCreateSetupStep): string {
  switch (step) {
    case "workspace":
      return "Waiting for workspace";
    case "model":
      return "Waiting to check the selected model";
    case "record":
      return "Waiting to create the teammate";
    case "avatar":
      return "Waiting for avatar upload";
    case "channels":
      return "Waiting for channel setup";
    case "memory":
      return "Waiting for memory setup";
    case "refresh":
      return "Waiting to refresh workspace";
  }
}

function templateRoleIcon(template: AiTeammateTemplate): JSX.Element {
  if (template.roleKey === "product") {
    return <Brain size={15} />;
  }
  if (template.roleKey === "engineer") {
    return <Code2 size={15} />;
  }
  if (template.roleKey === "architect") {
    return <Workflow size={15} />;
  }
  if (template.roleKey === "designer") {
    return <Palette size={15} />;
  }
  if (template.roleKey === "qa") {
    return <CheckCircle2 size={15} />;
  }
  if (template.roleKey === "security") {
    return <ShieldCheck size={15} />;
  }
  if (template.roleKey === "release") {
    return <Rocket size={15} />;
  }
  if (template.roleKey === "docs") {
    return <FileText size={15} />;
  }
  return <Sparkles size={15} />;
}

function teammateInitial(value: string): string {
  const trimmed = value.trim();
  return (trimmed[0] ?? "T").toLocaleUpperCase();
}

function isAvatarTone(value: string | undefined): value is AvatarTone {
  return value === "default" || value === "orange" || value === "teal" || value === "violet" || value === "blue" || value === "rose" || value === "gray";
}
