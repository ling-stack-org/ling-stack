import { ImagePlus, Trash2, Upload } from "lucide-react";
import { useRef, type DragEvent } from "react";
import { useI18n } from "../../../i18n.js";
import {
  Button,
  Field,
  Input,
  SegmentedControl,
  SegmentedControlItem,
} from "../../../shared/ui/index.js";
import type { QuickThemeStudioController } from "./useQuickThemeStudioController.js";

export function QuickThemeInputPanel({ controller }: { readonly controller: QuickThemeStudioController }): React.JSX.Element {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);
  const { source, stage } = controller.state;
  const analyzing = controller.restoring || stage === "validating" || stage === "analyzing";

  const loadDroppedFile = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    if (controller.restoring) return;
    const file = event.dataTransfer.files.item(0);
    if (file) void controller.analyzeFile(file);
  };

  return (
    <section className="settings-theme-studio-input" aria-labelledby="settings-theme-studio-input-title">
      <header>
        <span>
          <h2 id="settings-theme-studio-input-title">{t("Create from an image")}</h2>
        </span>
        <span className="settings-theme-studio-local-note">{t("Local only")}</span>
      </header>

      <div
        className="settings-theme-studio-dropzone"
        data-has-source={source ? "true" : undefined}
        onDragOver={(event) => event.preventDefault()}
        onDrop={loadDroppedFile}
      >
        <input
          ref={inputRef}
          accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp"
          className="settings-theme-studio-file-input"
          data-ling-control-native="true"
          disabled={controller.restoring}
          type="file"
          onChange={(event) => {
            const file = event.currentTarget.files?.item(0);
            event.currentTarget.value = "";
            if (file) void controller.analyzeFile(file);
          }}
        />
        {source ? (
          <div className="settings-theme-studio-source-row">
            {controller.sourcePreviewUrl ? <img alt="" src={controller.sourcePreviewUrl} /> : <ImagePlus aria-hidden="true" />}
            <span>
              <strong>{source.displayName}</strong>
              <small>{source.width} x {source.height} · {formatBytes(source.byteLength)}</small>
            </span>
            <Button disabled={controller.restoring} size="sm" variant="ghost" onClick={() => inputRef.current?.click()}>
              {t("Replace")}
            </Button>
            <Button
              aria-label={t("Remove image")}
              leadingIcon={<Trash2 aria-hidden="true" />}
              disabled={controller.restoring}
              size="sm"
              variant="ghost"
              onClick={controller.removeSource}
            >
              {t("Remove")}
            </Button>
          </div>
        ) : (
          <div className="settings-theme-studio-dropzone-empty">
            <ImagePlus aria-hidden="true" />
            <span>
              <strong>{t("Choose an image")}</strong>
              <small>{t("PNG, JPEG, or WebP up to 16 MB")}</small>
            </span>
            <Button
              leadingIcon={<Upload aria-hidden="true" />}
              loading={analyzing}
              loadingLabel={controller.restoring ? t("Restoring local draft") : t("Analyzing image")}
              size="sm"
              variant="secondary"
              onClick={() => inputRef.current?.click()}
            >
              {t("Choose image")}
            </Button>
          </div>
        )}
      </div>

      <Field label={t("Theme name")} required>
        <Input
          maxLength={80}
          disabled={controller.restoring}
          placeholder={t("Name this theme")}
          value={controller.state.name}
          onChange={(event) => controller.changeName(event.target.value)}
        />
      </Field>

      <div className="settings-theme-studio-field-group">
        <span>{t("Color scheme")}</span>
        <SegmentedControl
          aria-label={t("Color scheme")}
          size="sm"
          value={controller.state.colorScheme}
          onValueChange={(value) => controller.changeScheme(value as "dark" | "light")}
        >
          <SegmentedControlItem disabled={controller.restoring} value="light">{t("Light")}</SegmentedControlItem>
          <SegmentedControlItem disabled={controller.restoring} value="dark">{t("Dark")}</SegmentedControlItem>
        </SegmentedControl>
      </div>

      <div className="settings-theme-studio-standard-row">
        <span>
          <strong>{t("Standard layout")}</strong>
          <small>{t("Your image sets the colors only. It is never published as a background.")}</small>
        </span>
      </div>

      <Button
        disabled={!controller.canCompile}
        loading={controller.state.stage === "compiling"}
        loadingLabel={t("Generating preview")}
        variant="primary"
        onClick={controller.compile}
      >
        {t("Generate preview")}
      </Button>
    </section>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KB`;
  return `${Math.round(bytes / 1024 / 102.4) / 10} MB`;
}
