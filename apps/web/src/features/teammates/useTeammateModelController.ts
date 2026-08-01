import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { useI18n } from "../../i18n.js";
import { useLingToast } from "../../shared/ui/index.js";
import type { AiTeammate, ProviderPreset, UpdateAiTeammateRequest } from "../../types.js";
import {
  buildTeammateModelViewModel,
  workspaceDefaultModelOptionValue,
  type TeammateModelViewModel,
} from "./teammate-model-view-models.js";
import type { TeammateSettingsForm } from "./teammate-workspace-utils.js";
import type { TeammateUpdateAction } from "./types.js";

export interface TeammateModelController {
  readonly modelDirty: boolean;
  readonly modelError: string;
  readonly savingModel: boolean;
  readonly viewModel: TeammateModelViewModel;
  readonly resetModel: () => void;
  readonly saveModel: () => Promise<void>;
  readonly selectProvider: (providerPresetId: string) => void;
}

export function useTeammateModelController({
  teammate,
  providers,
  settingsForm,
  setSettingsForm,
  isProtectedSystemTeammate,
  workspaceDefaultProviderPresetId,
  onUpdateTeammate,
  onTeammateUpdated,
  onRefreshDirectRuntime,
}: {
  readonly teammate: AiTeammate;
  readonly providers: readonly ProviderPreset[];
  readonly settingsForm: TeammateSettingsForm;
  readonly setSettingsForm: Dispatch<SetStateAction<TeammateSettingsForm>>;
  readonly isProtectedSystemTeammate: boolean;
  readonly workspaceDefaultProviderPresetId?: string;
  readonly onUpdateTeammate: (
    teammateId: string,
    input: UpdateAiTeammateRequest,
    action?: TeammateUpdateAction,
  ) => Promise<AiTeammate>;
  readonly onTeammateUpdated?: (teammate: AiTeammate) => void;
  readonly onRefreshDirectRuntime?: () => Promise<void>;
}): TeammateModelController {
  const { t } = useI18n();
  const { showToast } = useLingToast();
  const operationSequenceRef = useRef(0);
  const [savingModel, setSavingModel] = useState(false);
  const [modelError, setModelError] = useState("");
  const canFollowWorkspaceDefault = teammateCanFollowWorkspaceDefault(teammate.id);
  const authoritativeBindingMode = teammate.modelBindingMode;
  const authoritativeProviderId = teammate.providerPresetId ?? "";
  const modelDirty = !isProtectedSystemTeammate && (
    settingsForm.modelBindingMode !== authoritativeBindingMode ||
    (settingsForm.modelBindingMode === "fixed" && settingsForm.providerPresetId !== authoritativeProviderId)
  );
  const viewModel = useMemo(() => buildTeammateModelViewModel({
    canFollowWorkspaceDefault,
    isProtected: isProtectedSystemTeammate,
    modelBindingMode: settingsForm.modelBindingMode,
    providers,
    selectedProviderId: settingsForm.providerPresetId,
    workspaceDefaultProviderPresetId,
    t,
  }), [
    canFollowWorkspaceDefault,
    isProtectedSystemTeammate,
    providers,
    settingsForm.modelBindingMode,
    settingsForm.providerPresetId,
    t,
    workspaceDefaultProviderPresetId,
  ]);

  useEffect(() => {
    operationSequenceRef.current += 1;
    setSavingModel(false);
    setModelError("");
  }, [teammate.id]);

  function selectProvider(providerPresetId: string): void {
    setSettingsForm((current) => providerPresetId === workspaceDefaultModelOptionValue
      ? { ...current, modelBindingMode: "workspace_default", providerPresetId: "" }
      : { ...current, modelBindingMode: "fixed", providerPresetId });
    setModelError("");
  }

  function resetModel(): void {
    if (savingModel || isProtectedSystemTeammate) return;
    setSettingsForm((current) => ({
      ...current,
      modelBindingMode: authoritativeBindingMode,
      providerPresetId: authoritativeProviderId,
    }));
    setModelError("");
  }

  async function saveModel(): Promise<void> {
    if (!modelDirty || savingModel || isProtectedSystemTeammate) return;
    if (settingsForm.modelBindingMode === "workspace_default" && !canFollowWorkspaceDefault) {
      setModelError(t("This teammate must use a fixed model."));
      return;
    }
    if (settingsForm.modelBindingMode === "fixed" && !settingsForm.providerPresetId) {
      setModelError(t("Choose a model before saving."));
      return;
    }
    const operationId = ++operationSequenceRef.current;
    const teammateId = teammate.id;
    setSavingModel(true);
    setModelError("");
    try {
      const updated = await onUpdateTeammate(teammateId, {
        modelBindingMode: settingsForm.modelBindingMode,
        providerPresetId: settingsForm.modelBindingMode === "fixed"
          ? settingsForm.providerPresetId
          : null,
      }, "model-save");
      if (operationSequenceRef.current !== operationId) return;
      setSettingsForm((current) => ({
        ...current,
        modelBindingMode: updated.modelBindingMode,
        providerPresetId: updated.providerPresetId ?? "",
      }));
      onTeammateUpdated?.(updated);
      showToast({
        message: t("Teammate model saved"),
        scope: `teammate:model:${teammateId}:save`,
        tone: "success",
      });
      void onRefreshDirectRuntime?.().catch(() => undefined);
    } catch {
      if (operationSequenceRef.current === operationId) {
        setModelError(t("Model changes were not saved. Try again."));
      }
    } finally {
      if (operationSequenceRef.current === operationId) {
        setSavingModel(false);
      }
    }
  }

  return {
    modelDirty,
    modelError,
    savingModel,
    viewModel,
    resetModel,
    saveModel,
    selectProvider,
  };
}

function teammateCanFollowWorkspaceDefault(teammateId: string): boolean {
  return teammateId === "ling_agent" || teammateId.startsWith("teammate_builtin_");
}
