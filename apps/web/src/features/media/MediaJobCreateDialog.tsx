import { Plus } from "lucide-react";
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Field,
  InlineFeedback,
  Select,
  Textarea,
} from "../../shared/ui/index.js";
import { providerModelRouteLabel } from "../../lib/providers.js";
import { useI18n } from "../../i18n.js";
import type { MediaJobFormState, ProviderPreset } from "../../types.js";
import type { MediaJobFormErrors } from "./media-job-types.js";
import { MediaJobAdvancedFields } from "./MediaJobAdvancedFields.js";

export function MediaJobCreateDialog({
  open,
  busy,
  form,
  errors,
  providers,
  serverError,
  videoGeneration,
  onOpenChange,
  onOperationChange,
  onPatch,
  onSubmit,
}: {
  readonly open: boolean;
  readonly busy: boolean;
  readonly form: MediaJobFormState;
  readonly errors: MediaJobFormErrors;
  readonly providers: readonly ProviderPreset[];
  readonly serverError: boolean;
  readonly videoGeneration?: import("../../types.js").VideoGenerationCapabilities;
  readonly onOpenChange: (open: boolean) => void;
  readonly onOperationChange: (operation: MediaJobFormState["operation"]) => void;
  readonly onPatch: (patch: Partial<MediaJobFormState>, field?: keyof MediaJobFormErrors) => void;
  readonly onSubmit: () => Promise<void>;
}): React.JSX.Element {
  const { t } = useI18n();
  return (
    <Dialog open={open} busy={busy} onOpenChange={onOpenChange}>
      <DialogContent className="media-job-create-dialog" size="lg" aria-label={t("New generation task")}>
        <DialogHeader title={t("New generation task")} closeLabel={t("Close")} />
        <DialogBody className="media-job-create-body">
          {serverError ? <InlineFeedback tone="danger" title={t("Could not create generation task")}>{t("Your settings are still here. Review them and try again.")}</InlineFeedback> : null}
          <div className="media-create-field-grid two-columns media-create-core-fields">
            <Field label={t("Operation")} required error={errors.operation}>
              <Select value={form.operation} onChange={(event) => onOperationChange(event.target.value as MediaJobFormState["operation"])}>
                <option value="image_generate">{t("Image generate")}</option>
                <option value="image_edit">{t("Image edit")}</option>
                <option value="video_generate">{t("Video generate")}</option>
              </Select>
            </Field>
            <Field label={t("Generation model")} required error={errors.providerPresetId}>
              <Select value={providers.some((provider) => provider.id === form.providerPresetId) ? form.providerPresetId : ""} onChange={(event) => onPatch({ providerPresetId: event.target.value }, "providerPresetId")}>
                <option value="">{t("Select generation model")}</option>
                {providers.map((provider) => <option key={provider.id} value={provider.id}>{providerModelRouteLabel(provider)}</option>)}
              </Select>
            </Field>
          </div>
          <Field
            className="media-create-prompt"
            label={t("Prompt")}
            required
            error={errors.prompt}
            description={<span className="media-create-counter">{form.prompt.length} / 2000</span>}
          >
            <Textarea rows={7} maxLength={2_000} value={form.prompt} onChange={(event) => onPatch({ prompt: event.target.value }, "prompt")} />
          </Field>
          {form.operation === "image_edit" ? <MediaJobAdvancedFields form={form} errors={errors} onPatch={onPatch} /> : null}
          {form.operation === "video_generate" ? <MediaJobAdvancedFields form={form} errors={errors} section="core" videoGeneration={videoGeneration} onPatch={onPatch} /> : null}
          {form.operation !== "image_edit" ? (
            <details className="media-create-advanced">
              <summary>{t("Advanced parameters")}</summary>
              <MediaJobAdvancedFields form={form} errors={errors} section="advanced" videoGeneration={videoGeneration} onPatch={onPatch} />
            </details>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button disabled={busy} onClick={() => onOpenChange(false)}>{t("Cancel")}</Button>
          <Button leadingIcon={<Plus size={16} />} loading={busy} loadingLabel={t("Creating task")} variant="primary" onClick={() => void onSubmit()}>{t("Create task")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
