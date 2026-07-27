import { Field, Input, Select } from "../../shared/ui/index.js";
import { useI18n } from "../../i18n.js";
import type { MediaJobFormState, VideoGenerationCapabilities } from "../../types.js";
import type { MediaJobFormErrors } from "./media-job-types.js";

export function MediaJobAdvancedFields({
  form,
  errors,
  section = "all",
  videoGeneration,
  onPatch,
}: {
  readonly form: MediaJobFormState;
  readonly errors: MediaJobFormErrors;
  readonly section?: "core" | "advanced" | "all";
  readonly videoGeneration?: VideoGenerationCapabilities;
  readonly onPatch: (patch: Partial<MediaJobFormState>, field?: keyof MediaJobFormErrors) => void;
}): JSX.Element {
  const { t } = useI18n();
  if (form.operation === "image_edit") {
    return (
      <div className="media-create-field-grid">
        <Field label={t("Source image URL")} error={errors.imageUrl}>
          <Input type="url" value={form.imageUrl} onChange={(event) => onPatch({ imageUrl: event.target.value }, "imageUrl")} />
        </Field>
        <Field label={t("Mask image URL")} description={t("Optional")} error={errors.maskUrl}>
          <Input type="url" value={form.maskUrl} onChange={(event) => onPatch({ maskUrl: event.target.value }, "maskUrl")} />
        </Field>
      </div>
    );
  }
  if (form.operation === "video_generate" && section === "core") {
    const ratios = videoGeneration?.aspectRatios ?? ["16:9", "9:16", "1:1"];
    const durations = videoGeneration?.durationsSeconds ?? [5, 10];
    return (
      <div className="media-create-field-grid two-columns">
        <Field label={t("Aspect ratio")}>
          <Select value={form.ratio} onChange={(event) => onPatch({ ratio: event.target.value })}>
            {ratios.map((ratio) => <option key={ratio} value={ratio}>{ratio}</option>)}
          </Select>
        </Field>
        <Field label={t("Duration")} error={errors.duration}>
          <Select value={form.duration} onChange={(event) => onPatch({ duration: event.target.value }, "duration")}>
            {durations.map((duration) => <option key={duration} value={String(duration)}>{duration}s</option>)}
          </Select>
        </Field>
      </div>
    );
  }
  if (form.operation === "video_generate") {
    return <WatermarkField form={form} onPatch={onPatch} />;
  }
  return (
    <div className="media-create-field-grid two-columns">
      <Field label={t("Image size")}>
        <Select value={form.size} onChange={(event) => onPatch({ size: event.target.value })}>
          <option value="">{t("Model default")}</option>
          <option value="1024x1024">1024x1024</option>
          <option value="1536x1024">1536x1024</option>
          <option value="1024x1536">1024x1536</option>
        </Select>
      </Field>
      <Field label={t("Result count")} error={errors.count}><Input inputMode="numeric" value={form.count} onChange={(event) => onPatch({ count: event.target.value }, "count")} /></Field>
      <Field label={t("Seed")} error={errors.seed}><Input inputMode="numeric" value={form.seed} onChange={(event) => onPatch({ seed: event.target.value }, "seed")} /></Field>
      <WatermarkField form={form} onPatch={onPatch} />
    </div>
  );
}

function WatermarkField({
  form,
  onPatch,
}: {
  readonly form: MediaJobFormState;
  readonly onPatch: (patch: Partial<MediaJobFormState>) => void;
}): JSX.Element {
  const { t } = useI18n();
  return (
    <Field label={t("Watermark")}>
      <Select value={form.watermark} onChange={(event) => onPatch({ watermark: event.target.value as MediaJobFormState["watermark"] })}>
        <option value="">{t("Model default")}</option><option value="true">{t("On")}</option><option value="false">{t("Off")}</option>
      </Select>
    </Field>
  );
}
