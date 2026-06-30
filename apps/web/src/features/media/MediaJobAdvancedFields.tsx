import type { MediaJobFormState } from "../../types.js";
import { useI18n } from "../../i18n.js";

export function MediaJobAdvancedFields({
  form,
  onFormChange,
}: {
  readonly form: MediaJobFormState;
  readonly onFormChange: (form: MediaJobFormState) => void;
}): JSX.Element {
  const { t } = useI18n();
  return (
    <div className="media-structured-fields">
      {form.operation === "video_generate" ? (
        <>
          <label className="field">
            <span>{t("Aspect ratio")}</span>
            <select value={form.ratio} onChange={(event) => onFormChange({ ...form, ratio: event.target.value })}>
              <option value="16:9">16:9</option>
              <option value="9:16">9:16</option>
              <option value="1:1">1:1</option>
              <option value="4:3">4:3</option>
              <option value="3:4">3:4</option>
            </select>
          </label>
          <label className="field">
            <span>{t("Video duration")}</span>
            <input
              inputMode="numeric"
              min="1"
              placeholder="5"
              value={form.duration}
              onChange={(event) => onFormChange({ ...form, duration: event.target.value })}
            />
          </label>
          <WatermarkField form={form} onFormChange={onFormChange} />
        </>
      ) : form.operation === "image_edit" ? (
        <>
          <label className="field wide">
            <span>{t("Source image URL")}</span>
            <input
              placeholder="https://..."
              value={form.imageUrl}
              onChange={(event) => onFormChange({ ...form, imageUrl: event.target.value })}
            />
          </label>
          <label className="field wide">
            <span>{t("Mask image URL")}</span>
            <input
              placeholder="https://..."
              value={form.maskUrl}
              onChange={(event) => onFormChange({ ...form, maskUrl: event.target.value })}
            />
          </label>
        </>
      ) : (
        <>
          <label className="field">
            <span>{t("Image size")}</span>
            <select value={form.size} onChange={(event) => onFormChange({ ...form, size: event.target.value })}>
              <option value="">{t("Model default")}</option>
              <option value="1024x1024">1024x1024</option>
              <option value="1536x1024">1536x1024</option>
              <option value="1024x1536">1024x1536</option>
              <option value="2K">2K</option>
              <option value="4K">4K</option>
            </select>
          </label>
          <label className="field">
            <span>{t("Result count")}</span>
            <input
              inputMode="numeric"
              min="1"
              placeholder={t("Model default")}
              value={form.count}
              onChange={(event) => onFormChange({ ...form, count: event.target.value })}
            />
          </label>
          <label className="field">
            <span>{t("Seed")}</span>
            <input
              inputMode="numeric"
              placeholder={t("Random")}
              value={form.seed}
              onChange={(event) => onFormChange({ ...form, seed: event.target.value })}
            />
          </label>
          <WatermarkField form={form} onFormChange={onFormChange} />
        </>
      )}
    </div>
  );
}

function WatermarkField({
  form,
  onFormChange,
}: {
  readonly form: MediaJobFormState;
  readonly onFormChange: (form: MediaJobFormState) => void;
}): JSX.Element {
  const { t } = useI18n();
  return (
    <label className="field">
      <span>{t("Watermark")}</span>
      <select value={form.watermark} onChange={(event) => onFormChange({ ...form, watermark: event.target.value as MediaJobFormState["watermark"] })}>
        <option value="">{t("Model default")}</option>
        <option value="false">{t("Off")}</option>
        <option value="true">{t("On")}</option>
      </select>
    </label>
  );
}
