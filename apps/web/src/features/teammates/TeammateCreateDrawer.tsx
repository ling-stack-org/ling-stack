import type { AiTeammateTemplate } from "@ling-stack/core/skill-types";
import { ArrowLeft, Check, Plus, Settings } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../../i18n.js";
import { canUseConversationProvider, providerPreflightReady } from "../../lib/providers.js";
import type { AvatarTone } from "../../shared/components/index.js";
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  InlineFeedback,
} from "../../shared/ui/index.js";
import type { Channel, ProviderPreset } from "../../types.js";
import { TeammateCreateProgress, teammateCreateSetupStepIds, type TeammateCreateStepViewState } from "./TeammateCreateProgress.js";
import { TeammateCreateRoleStep } from "./TeammateCreateRoleStep.js";
import { TeammateCustomSetupStep } from "./TeammateCustomSetupStep.js";
import { selectDefaultTeammateProvider, selectDefaultTeammateTemplate } from "./teammate-create-defaults.js";
import type {
  LocalTeammateCreateInput,
  TeammateCreateMode,
  TeammateCreateProgressEvent,
  TeammateCreateResult,
  TeammateCreateSetupStep,
} from "./types.js";

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
}): React.JSX.Element | null {
  const { t } = useI18n();
  const providerOptions = useMemo(
    () => providers.filter((provider) => canUseConversationProvider(provider) && providerPreflightReady(provider)),
    [providers],
  );
  const [dialogOpen, setDialogOpen] = useState(open);
  const [mode, setMode] = useState<TeammateCreateMode>("role_select");
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [draftName, setDraftName] = useState("");
  const [draftDescription, setDraftDescription] = useState("");
  const [selectedProviderId, setSelectedProviderId] = useState("");
  const [selectedChannelIds, setSelectedChannelIds] = useState<readonly string[]>([]);
  const [avatarTone, setAvatarTone] = useState<AvatarTone>("violet");
  const [avatarFile, setAvatarFile] = useState<File | undefined>();
  const [avatarPreviewUrl, setAvatarPreviewUrl] = useState("");
  const [setupSteps, setSetupSteps] = useState<Record<TeammateCreateSetupStep, TeammateCreateStepViewState>>(createInitialStepState);
  const [setupResult, setSetupResult] = useState<TeammateCreateResult | undefined>();
  const [setupInput, setSetupInput] = useState<LocalTeammateCreateInput | undefined>();
  const closeCommittedRef = useRef(false);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const draftSequenceRef = useRef(0);
  const draftIdentityRef = useRef("");
  const createRequestRevisionRef = useRef(0);

  const selectedTemplate = selectedTemplateId ? templates.find((template) => template.id === selectedTemplateId) : undefined;
  const selectedProvider = providerOptions.find((provider) => provider.id === selectedProviderId);
  const previewName = draftName.trim() || (selectedTemplate ? t(selectedTemplate.name) : t("Custom teammate"));
  const previewDescription = draftDescription.trim() || (selectedTemplate ? t(selectedTemplate.summary) : t("Describe this teammate with a short working brief."));
  const selectedProviderReady = Boolean(selectedProvider && providerPreflightReady(selectedProvider));
  const canCreateTeammate = Boolean(previewName.trim()) && selectedProviderReady;
  const visibleCreateTemplates = templates.slice(0, 5);
  const setupBusy = mode === "setup_progress" && (!setupResult || Object.values(setupSteps).some((step) => step.state === "running"));

  useEffect(() => {
    if (!open) return;
    const template = templates.find((item) => item.id === initialTemplateId) ?? selectDefaultTeammateTemplate(templates);
    returnFocusRef.current = typeof document !== "undefined" && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    draftSequenceRef.current += 1;
    draftIdentityRef.current = `teammate-draft-${draftSequenceRef.current}`;
    createRequestRevisionRef.current += 1;
    closeCommittedRef.current = false;
    setDialogOpen(true);
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
    if (!open || !selectedProviderId || providerOptions.some((provider) => provider.id === selectedProviderId)) return;
    setSelectedProviderId(selectDefaultTeammateProvider(providerOptions, defaultProviderId)?.id ?? providerOptions[0]?.id ?? "");
  }, [defaultProviderId, open, providerOptions, selectedProviderId]);

  if (!open) return null;

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

  function requestClose(): void {
    if (!setupBusy) setDialogOpen(false);
  }

  function openProvidersAndClose(): void {
    if (setupBusy) return;
    onClose();
    onOpenProviders();
  }

  function buildCreateInput(providerPresetId: string): LocalTeammateCreateInput {
    return {
      draftId: draftIdentityRef.current,
      templateId: selectedTemplate?.id,
      displayName: previewName,
      description: previewDescription,
      avatarTone: selectedTemplate ? undefined : avatarTone,
      avatarFile: selectedTemplate ? undefined : avatarFile,
      providerPresetId,
      modelLabel: selectedProvider ? `${selectedProvider.displayName} / ${selectedProvider.model}` : t("No model selected"),
      channelIds: selectedChannelIds,
    };
  }

  async function createTeammateDraft(): Promise<void> {
    if (!canCreateTeammate || setupBusy || !selectedProvider) return;
    const createInput = buildCreateInput(selectedProvider.id);
    const draftIdentity = createInput.draftId ?? "";
    const requestRevision = ++createRequestRevisionRef.current;
    setSetupInput(createInput);
    setSetupSteps(createInitialStepState());
    setSetupResult(undefined);
    setMode("setup_progress");
    const result = await onCreate(createInput, (event) => handleProgressEvent(draftIdentity, requestRevision, event));
    if (
      result.stale ||
      draftIdentityRef.current !== draftIdentity ||
      createRequestRevisionRef.current !== requestRevision
    ) return;
    setSetupResult(result);
    if (result.ok) {
      onClose();
      if (result.teammateId) onOpenCreated?.(result.teammateId);
    }
  }

  function handleProgressEvent(
    draftIdentity: string,
    requestRevision: number,
    event: TeammateCreateProgressEvent,
  ): void {
    if (
      draftIdentityRef.current !== draftIdentity ||
      createRequestRevisionRef.current !== requestRevision
    ) return;
    setSetupSteps((current) => ({
      ...current,
      [event.step]: {
        state: event.state,
        message: event.message ?? current[event.step].message,
      },
    }));
  }

  function retrySetup(): void {
    if (!setupInput || setupBusy) return;
    setDraftName(setupInput.displayName);
    setDraftDescription(setupInput.description);
    setSelectedProviderId(setupInput.providerPresetId);
    setSelectedChannelIds(setupInput.channelIds);
    setAvatarTone(isAvatarTone(setupInput.avatarTone) ? setupInput.avatarTone : "violet");
    setAvatarFile(setupInput.templateId ? undefined : setupInput.avatarFile);
    setSelectedTemplateId(setupInput.templateId ?? "");
    setMode(setupInput.templateId ? "role_select" : "custom_setup");
    setSetupResult(undefined);
    setSetupSteps(createInitialStepState());
  }

  function finishSetup(): void {
    const createdTeammateId = setupResult?.ok || setupResult?.partial ? setupResult.teammateId : undefined;
    onClose();
    if (createdTeammateId) onOpenCreated?.(createdTeammateId);
  }

  return (
    <Dialog
      busy={setupBusy}
      dismissible={!setupBusy}
      open={dialogOpen}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !setupBusy) setDialogOpen(false);
      }}
    >
      <DialogContent
        aria-label={t("Create AI teammate")}
        aria-labelledby={undefined}
        className="teammate-create-dialog"
        data-mode={mode}
        data-ui2-teammate-create="true"
        overlayClassName="teammate-create-overlay"
        size="lg"
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          event.stopPropagation();
          requestClose();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          returnFocusRef.current?.focus({ preventScroll: true });
          if (closeCommittedRef.current) return;
          closeCommittedRef.current = true;
          onClose();
        }}
      >
        <DialogHeader
          closeLabel={t("Cancel")}
          description={dialogDescription(mode, t)}
          title={dialogTitle(mode, t)}
        />
        <DialogBody className="teammate-create-body">
          {mode === "role_select" ? (
            <TeammateCreateRoleStep
              channels={channels}
              disabled={setupBusy}
              draftName={draftName}
              providers={providerOptions}
              selectedChannelId={selectedChannelIds[0] ?? ""}
              selectedProviderId={selectedProviderId}
              selectedTemplateId={selectedTemplateId}
              templates={visibleCreateTemplates}
              onChangeChannel={(value) => setSelectedChannelIds(value ? [value] : [])}
              onChangeName={setDraftName}
              onChangeProvider={setSelectedProviderId}
              onOpenCustom={openCustomSetup}
              onOpenProviders={openProvidersAndClose}
              onSelectTemplate={selectTemplate}
            />
          ) : mode === "custom_setup" ? (
            <TeammateCustomSetupStep
              avatarFile={avatarFile}
              avatarPreviewUrl={avatarPreviewUrl}
              avatarTone={avatarTone}
              channels={channels}
              disabled={setupBusy}
              draftDescription={draftDescription}
              draftName={draftName}
              previewName={previewName}
              providers={providerOptions}
              selectedChannelId={selectedChannelIds[0] ?? ""}
              selectedProviderId={selectedProviderId}
              onBack={() => setMode("role_select")}
              onChangeAvatarFile={setAvatarFile}
              onChangeAvatarTone={setAvatarTone}
              onChangeChannel={(value) => setSelectedChannelIds(value ? [value] : [])}
              onChangeDescription={setDraftDescription}
              onChangeName={setDraftName}
              onChangeProvider={setSelectedProviderId}
              onOpenProviders={openProvidersAndClose}
            />
          ) : (
            <TeammateCreateProgress result={setupResult} steps={setupSteps} />
          )}
        </DialogBody>
        <DialogFooter className="teammate-create-actions">
          {renderFooter()}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  function renderFooter(): React.JSX.Element {
    if (mode === "setup_progress") {
      const createdWithWarnings = Boolean(setupResult?.partial && setupResult.teammateId);
      const showModelWorkbench = Boolean(setupResult && !setupResult.ok && setupSteps.model.state === "failed");
      return (
        <>
          {setupResult && !setupResult.ok && !createdWithWarnings ? (
            <Button leadingIcon={<ArrowLeft />} size="sm" onClick={retrySetup}>{t("Back to setup")}</Button>
          ) : null}
          {showModelWorkbench ? (
            <Button leadingIcon={<Settings />} size="sm" onClick={openProvidersAndClose}>{t("Open Model Workbench")}</Button>
          ) : null}
          <Button
            leadingIcon={<Check />}
            loading={setupBusy}
            loadingLabel={t("Creating...")}
            size="sm"
            variant="primary"
            onClick={finishSetup}
          >
            {setupBusy
              ? t("Creating...")
              : (setupResult?.ok || setupResult?.partial) && setupResult.teammateId
                ? t("Open teammate chat")
                : setupResult && !setupResult.ok
                  ? t("Close")
                  : t("Done")}
          </Button>
        </>
      );
    }

    return (
      <>
        {!selectedProviderReady && providerOptions.length > 0 ? (
          <InlineFeedback className="teammate-create-blocked" title={selectedProvider ? t("Selected model needs configuration.") : t("Choose a model before creating.")} tone="warning" />
        ) : null}
        <Button size="sm" onClick={requestClose}>{t("Cancel")}</Button>
        <Button
          disabled={!canCreateTeammate}
          leadingIcon={<Plus />}
          size="sm"
          variant="primary"
          onClick={() => void createTeammateDraft()}
        >
          {mode === "custom_setup" ? t("Create and verify") : t("Create teammate")}
        </Button>
      </>
    );
  }
}

function createInitialStepState(): Record<TeammateCreateSetupStep, TeammateCreateStepViewState> {
  return Object.fromEntries(
    teammateCreateSetupStepIds.map((step) => [step, { state: "pending", message: "" }]),
  ) as Record<TeammateCreateSetupStep, TeammateCreateStepViewState>;
}

function dialogTitle(mode: TeammateCreateMode, t: (key: string) => string): string {
  if (mode === "custom_setup") return t("Custom AI teammate");
  if (mode === "setup_progress") return t("Creating AI teammate");
  return t("New AI teammate");
}

function dialogDescription(mode: TeammateCreateMode, t: (key: string) => string): string {
  if (mode === "setup_progress") return t("Ling is checking the model and preparing this teammate.");
  if (mode === "custom_setup") return t("Choose the identity and ready model this teammate will use.");
  return t("Recommended role and model are prefilled. Review them, then create.");
}

function isAvatarTone(value: string | undefined): value is AvatarTone {
  return value === "default" || value === "orange" || value === "teal" || value === "violet" || value === "blue" || value === "rose" || value === "gray";
}
