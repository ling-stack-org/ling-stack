import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { useI18n } from "../../i18n.js";
import { useLingToast } from "../../shared/ui/index.js";
import type { AiTeammate, ProviderPreset, UpdateAiTeammateRequest } from "../../types.js";
import {
  buildTeammateModelViewModel,
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
  onUpdateTeammate,
  onTeammateUpdated,
  onRefreshDirectRuntime,
}: {
  readonly teammate: AiTeammate;
  readonly providers: readonly ProviderPreset[];
  readonly settingsForm: TeammateSettingsForm;
  readonly setSettingsForm: Dispatch<SetStateAction<TeammateSettingsForm>>;
  readonly isProtectedSystemTeammate: boolean;
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
  const authoritativeProviderId = teammate.providerPresetId ?? "";
  const modelDirty = !isProtectedSystemTeammate && settingsForm.providerPresetId !== authoritativeProviderId;
  const viewModel = useMemo(() => buildTeammateModelViewModel({
    isProtected: isProtectedSystemTeammate,
    providers,
    selectedProviderId: settingsForm.providerPresetId,
    t,
  }), [isProtectedSystemTeammate, providers, settingsForm.providerPresetId, t]);

  useEffect(() => {
    operationSequenceRef.current += 1;
    setSavingModel(false);
    setModelError("");
  }, [teammate.id]);

  function selectProvider(providerPresetId: string): void {
    setSettingsForm((current) => ({ ...current, providerPresetId }));
    setModelError("");
  }

  function resetModel(): void {
    if (savingModel || isProtectedSystemTeammate) return;
    setSettingsForm((current) => ({ ...current, providerPresetId: authoritativeProviderId }));
    setModelError("");
  }

  async function saveModel(): Promise<void> {
    if (!modelDirty || savingModel || isProtectedSystemTeammate) return;
    const operationId = ++operationSequenceRef.current;
    const teammateId = teammate.id;
    setSavingModel(true);
    setModelError("");
    try {
      const updated = await onUpdateTeammate(teammateId, {
        providerPresetId: settingsForm.providerPresetId || null,
      }, "model-save");
      if (operationSequenceRef.current !== operationId) return;
      setSettingsForm((current) => ({
        ...current,
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
