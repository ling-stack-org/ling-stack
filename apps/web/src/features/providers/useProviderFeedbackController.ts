import { useI18n } from "../../i18n.js";
import { useLingToast } from "../../shared/ui/index.js";
import type { ProviderModelOption } from "../../types.js";
import type { ProviderBatchResult, ProviderImportResult, ProviderSaveResult } from "./types.js";

export function useProviderFeedbackController(input: {
  readonly onSave: () => Promise<ProviderSaveResult>;
  readonly onImportModels: (models: readonly ProviderModelOption[]) => Promise<ProviderImportResult>;
  readonly onCheckBatch: () => Promise<ProviderBatchResult | undefined>;
}) {
  const { t } = useI18n();
  const { showToast } = useLingToast();

  async function save(): Promise<ProviderSaveResult> {
    const result = await input.onSave();
    if (result.ok) {
      showToast({
        message: result.successMessage ?? t("Model preset saved successfully."),
        scope: "model-workbench:provider-save",
        tone: "success",
      });
    }
    return result;
  }

  async function importModels(models: readonly ProviderModelOption[]): Promise<ProviderImportResult> {
    const result = await input.onImportModels(models);
    if (result.ok) {
      showToast({
        message: result.successMessage ?? t("Imported {count} model presets.", {
          count: result.response?.createdCount ?? 0,
        }),
        scope: "model-workbench:model-import",
        tone: "success",
      });
    }
    return result;
  }

  async function checkBatch(): Promise<void> {
    const result = await input.onCheckBatch();
    if (!result || result.failedCount > 0) return;
    showToast({
      message: result.message,
      scope: "model-workbench:batch-check",
      tone: "success",
    });
  }

  return { checkBatch, importModels, save } as const;
}
