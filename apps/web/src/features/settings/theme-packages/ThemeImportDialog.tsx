import { FileArchive, RefreshCw, Upload } from "lucide-react";
import { useRef, type RefObject } from "react";
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  InlineFeedback,
  InspectorSection,
  Spinner,
  StatusIndicator,
} from "../../../shared/ui/index.js";
import { useI18n } from "../../../i18n.js";
import type { ThemeImportDialogState } from "./useThemePackageController.js";
import {
  formatThemePackageBytes,
  themePackageIssueLabel,
} from "./theme-package-view-models.js";

export function ThemeImportDialog({
  returnFocusRef,
  state,
  onClose,
  onLoadFile,
  onPreview,
  onPublish,
  onUseAfterImportChange,
}: {
  readonly returnFocusRef: RefObject<HTMLButtonElement | null>;
  readonly state: ThemeImportDialogState;
  readonly onClose: () => void;
  readonly onLoadFile: (file: File | undefined) => void;
  readonly onPreview: (trigger: HTMLButtonElement | null) => void;
  readonly onPublish: () => void;
  readonly onUseAfterImportChange: (value: boolean) => void;
}): JSX.Element {
  const { t } = useI18n();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const previewButtonRef = useRef<HTMLButtonElement | null>(null);
  const busy = state.phase === "publishing" || state.phase === "validating";
  const candidate = state.candidate;
  const title = state.mode === "reimport" ? t("Reimport theme") : t("Import theme");

  return (
    <Dialog
      busy={busy}
      open={state.open}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="settings-theme-import-dialog"
        data-ui2-theme-import-dialog=""
        size="md"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          fileInputRef.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (returnFocusRef.current?.isConnected) returnFocusRef.current.focus({ preventScroll: true });
        }}
      >
        <DialogHeader closeLabel={t("Close")} title={title} />
        <DialogBody className="settings-theme-import-body">
          <label
            className="settings-theme-file-picker"
            data-busy={busy || undefined}
            data-has-file={state.fileName ? "true" : undefined}
          >
            <FileArchive aria-hidden="true" />
            <span>
              <strong>{state.fileName ?? t("Choose a theme file")}</strong>
              <small>{state.fileName ? t("Choose another .ling-theme file") : t("Local .ling-theme, up to 20 MB")}</small>
            </span>
            {state.phase === "validating" ? <Spinner label={t("Validating theme...")} size="sm" /> : null}
            <input
              data-ling-control-native="true"
              ref={fileInputRef}
              aria-label={t("Choose a theme file")}
              accept=".ling-theme"
              disabled={busy}
              type="file"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = "";
                onLoadFile(file);
              }}
            />
          </label>

          {state.issues.length > 0 ? (
            <InlineFeedback
              title={state.installed ? t("Theme installed with a warning") : t("Theme package needs attention")}
              tone={state.installed ? "warning" : "danger"}
            >
              <ul className="settings-theme-issue-list">
                {state.issues.map((item, index) => (
                  <li key={`${item.code}:${item.path}:${index}`}>{themePackageIssueLabel(item, t)}</li>
                ))}
              </ul>
            </InlineFeedback>
          ) : null}

          {candidate ? (
            <section className="settings-theme-package-review" aria-label={t("Theme package summary")}>
              <header>
                <span>
                  <strong>{candidate.manifest.name}</strong>
                  <small>{candidate.manifest.author || t("Unknown author")}</small>
                </span>
                <StatusIndicator
                  label={candidate.manifest.colorScheme === "dark" ? t("Dark") : t("Light")}
                  tone="neutral"
                />
              </header>
              <dl>
                <div><dt>{t("Theme ID")}</dt><dd>{candidate.manifest.id}</dd></div>
                <div><dt>{t("Preview")}</dt><dd>{candidate.preview ? t("Included") : t("Token preview")}</dd></div>
                <div><dt>{t("License")}</dt><dd>{candidate.manifest.license || t("Not declared")}</dd></div>
              </dl>
              {candidate.warnings.length > 0 ? (
                <InlineFeedback tone="warning">
                  {candidate.warnings.map((warning) => themePackageIssueLabel(warning, t)).join(" ")}
                </InlineFeedback>
              ) : null}
              {state.mode === "import" && !state.installed ? (
                <label className="settings-theme-use-after-import">
                  <input
                    data-ling-control-native="true"
                    checked={state.useAfterImport}
                    disabled={busy}
                    type="checkbox"
                    onChange={(event) => onUseAfterImportChange(event.currentTarget.checked)}
                  />
                  <span>{t("Use this theme after import")}</span>
                </label>
              ) : null}
              <InspectorSection
                summary={t("Schema, checksums, and package metadata")}
                title={t("Technical details")}
              >
                <dl className="settings-theme-technical-list">
                  <div><dt>{t("Schema version")}</dt><dd>{candidate.manifest.schemaVersion}</dd></div>
                  <div><dt>{t("Package checksum")}</dt><dd>{candidate.packageChecksumSha256}</dd></div>
                  {candidate.preview ? (
                    <>
                      <div><dt>{t("Preview size")}</dt><dd>{formatThemePackageBytes(candidate.preview.byteLength)}</dd></div>
                      <div><dt>{t("Preview dimensions")}</dt><dd>{candidate.preview.width} x {candidate.preview.height}</dd></div>
                    </>
                  ) : null}
                  {state.issues.map((item, index) => (
                    <div key={`detail:${item.code}:${index}`}><dt>{item.path}</dt><dd>{item.message}</dd></div>
                  ))}
                </dl>
              </InspectorSection>
            </section>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button disabled={busy} size="sm" variant="secondary" onClick={onClose}>
            {state.installed ? t("Close") : t("Cancel")}
          </Button>
          {candidate ? (
            <Button
              ref={previewButtonRef}
              disabled={busy}
              size="sm"
              variant="secondary"
              onClick={() => onPreview(previewButtonRef.current)}
            >
              {t("Preview")}
            </Button>
          ) : null}
          {!state.installed ? (
            <Button
              disabled={!candidate || state.issues.length > 0 || state.phase === "validating"}
              leadingIcon={state.mode === "reimport" ? <RefreshCw aria-hidden="true" /> : <Upload aria-hidden="true" />}
              loading={state.phase === "publishing"}
              loadingLabel={state.mode === "reimport" ? t("Reimporting theme...") : t("Importing theme...")}
              size="sm"
              variant="primary"
              onClick={onPublish}
            >
              {state.mode === "reimport" ? t("Reimport theme") : t("Import theme")}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
