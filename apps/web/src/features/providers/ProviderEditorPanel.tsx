import { useRef, type ReactNode } from "react";
import { Plus, Save } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { providerCheckStatusLabel } from "../../lib/providers.js";
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  InlineFeedback,
  InspectorSection,
} from "../../shared/ui/index.js";
import type { ProviderCheckResult, ProviderFormState, ProviderPreset, ProviderTemplate } from "../../types.js";
import { ProviderAdvancedSettings } from "./ProviderAdvancedSettings.js";
import { ProviderEditorCoreFields } from "./ProviderEditorCoreFields.js";
import type { ProviderSetupIntent } from "./provider-workbench-view-models.js";

export function ProviderEditorPanel({
  supplierTemplates,
  setupIntent,
  selectedTemplateId,
  form,
  editingProvider,
  editingProviderId,
  showApiKey,
  canEditCustomProviderFields,
  modelImportPanel,
  editorErrorMessage,
  editorWarningMessage,
  checkResult,
  editorCheckProviderName,
  editorCheckMessage,
  editorCheckGuidance,
  selectedImportCount,
  isCheckingProviders,
  isSaveChecking,
  onClose,
  onTemplateSelect,
  onResetModelDiscovery,
  onFormChange,
  onShowApiKeyChange,
  onSaveCurrentPreset,
  onPrimaryAction,
}: {
  readonly supplierTemplates: readonly ProviderTemplate[];
  readonly setupIntent: ProviderSetupIntent | "";
  readonly selectedTemplateId: string;
  readonly form: ProviderFormState;
  readonly editingProvider: ProviderPreset | undefined;
  readonly editingProviderId: string;
  readonly showApiKey: boolean;
  readonly canEditCustomProviderFields: boolean;
  readonly modelImportPanel: ReactNode;
  readonly editorErrorMessage: string;
  readonly editorWarningMessage: string;
  readonly checkResult: ProviderCheckResult | undefined;
  readonly editorCheckProviderName: string;
  readonly editorCheckMessage: string;
  readonly editorCheckGuidance: string;
  readonly selectedImportCount: number;
  readonly isCheckingProviders: boolean;
  readonly isSaveChecking: boolean;
  readonly onClose: () => void;
  readonly onTemplateSelect: (template: ProviderTemplate) => void;
  readonly onResetModelDiscovery: () => void;
  readonly onFormChange: (form: ProviderFormState) => void;
  readonly onShowApiKeyChange: (value: boolean) => void;
  readonly onSaveCurrentPreset: () => void;
  readonly onPrimaryAction: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const title = !editingProviderId && setupIntent === "chat"
    ? t("New chat model")
    : !editingProviderId && setupIntent === "generation"
      ? t("New image generation model")
      : !editingProviderId && setupIntent === "video_generation"
        ? t("New video generation model")
        : editingProviderId ? t("Edit preset") : t("New preset");
  const returnFocusRef = useRef<HTMLElement | null>(
    typeof document !== "undefined" && document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );

  function requestClose(): void {
    if (!isCheckingProviders) onClose();
  }

  return (
    <Dialog busy={isCheckingProviders} dismissible open onOpenChange={(nextOpen) => { if (!nextOpen) requestClose(); }}>
      <DialogContent
        aria-label={title}
        className="provider-form-panel provider-sheet"
        size="lg"
        onEscapeKeyDown={() => requestClose()}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          event.stopPropagation();
          requestClose();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          returnFocusRef.current?.focus({ preventScroll: true });
        }}
      >
        <DialogHeader className="provider-sheet-header" closeLabel={t("Close model preset editor")} title={title} />
        <DialogBody className="provider-sheet-body">
          <ProviderEditorCoreFields
            supplierTemplates={supplierTemplates}
            selectedTemplateId={selectedTemplateId}
            form={form}
            editingProvider={editingProvider}
            showApiKey={showApiKey}
            onFormChange={onFormChange}
            onResetModelDiscovery={onResetModelDiscovery}
            onShowApiKeyChange={onShowApiKeyChange}
            onTemplateSelect={onTemplateSelect}
          />
          {modelImportPanel}
          <ProviderAdvancedSettings
            form={form}
            editingProviderId={editingProviderId}
            isCustomProvider={selectedTemplateId === "custom-openai-compatible"}
            canEditCustomProviderFields={canEditCustomProviderFields}
            onFormChange={onFormChange}
          />
          {editorErrorMessage ? <InlineFeedback className="provider-editor-error" tone="danger" title={t("Error")}>{t(editorErrorMessage)}</InlineFeedback> : null}
          {editorWarningMessage ? <InlineFeedback className="provider-editor-warning" tone="warning">{t(editorWarningMessage)}</InlineFeedback> : null}
          {checkResult && !editorErrorMessage ? (
            <InlineFeedback className="provider-editor-check-feedback" tone={checkResult.ok ? "success" : "danger"} title={editorCheckProviderName || t("Provider check")}>
              <span className="provider-editor-check-status">{providerCheckStatusLabel(checkResult, t)}</span>
              <span>{editorCheckMessage}</span>
              {editorCheckGuidance ? <small>{editorCheckGuidance}</small> : null}
              {checkResult.message ? (
                <InspectorSection className="provider-check-raw-details" title={t("Check details")}>
                  <small>{t("Provider response")}: {t(checkResult.message)}</small>
                </InspectorSection>
              ) : null}
            </InlineFeedback>
          ) : null}
        </DialogBody>
        <DialogFooter className="provider-sheet-footer">
          <Button disabled={isCheckingProviders} onClick={requestClose}>{t("Cancel")}</Button>
          {editingProviderId && selectedImportCount > 0 ? (
            <Button disabled={isCheckingProviders} leadingIcon={<Save />} onClick={onSaveCurrentPreset}>{t("Save current preset")}</Button>
          ) : null}
          <Button
            variant="primary"
            loading={isSaveChecking}
            loadingLabel={t("Loading")}
            disabled={isCheckingProviders && !isSaveChecking}
            leadingIcon={selectedImportCount > 0 ? <Plus /> : <Save />}
            onClick={onPrimaryAction}
          >
            {selectedImportCount > 0
              ? t("Import selected models ({count})", { count: selectedImportCount })
              : editingProviderId ? t("Save changes") : t("Add model")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
