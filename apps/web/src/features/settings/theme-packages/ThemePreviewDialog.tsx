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
  ThemePreviewFixture,
} from "../../../shared/ui/index.js";
import { useI18n } from "../../../i18n.js";
import type { ThemePreviewDialogState } from "./useThemePackageController.js";
import { formatThemePackageBytes } from "./theme-package-view-models.js";

export function ThemePreviewDialog({
  returnFocusRef,
  state,
  onClose,
}: {
  readonly returnFocusRef: RefObject<HTMLButtonElement | null>;
  readonly state: ThemePreviewDialogState;
  readonly onClose: () => void;
}): JSX.Element {
  const { t } = useI18n();
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const packageValue = state.package;
  return (
    <Dialog open={state.open} onOpenChange={(open) => {
      if (!open) onClose();
    }}>
      <DialogContent
        className="settings-theme-preview-dialog"
        data-ui2-theme-preview-dialog=""
        size="lg"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          closeRef.current?.focus({ preventScroll: true });
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (returnFocusRef.current?.isConnected) returnFocusRef.current.focus({ preventScroll: true });
        }}
      >
        <DialogHeader closeLabel={t("Close")} title={state.target?.name ?? t("Theme preview")} />
        <DialogBody className="settings-theme-preview-body">
          {state.loading ? (
            <div className="settings-theme-preview-loading">
              <Spinner label={t("Loading theme preview...")} size="md" />
            </div>
          ) : null}
          {state.error ? <InlineFeedback tone="danger">{state.error}</InlineFeedback> : null}
          {state.target && !state.loading ? (
            <ThemePreviewFixture
              copy={{
                action: t("Primary action"),
                body: t("This isolated preview checks shared controls without using workspace data."),
                inputLabel: t("Sample input"),
                rowLabel: t("Workspace item"),
                rowSummary: t("Compact supporting information"),
                status: t("Ready"),
                title: t("Theme preview"),
              }}
              previewUrl={state.previewUrl}
              themeName={state.target.name}
              variableMap={state.target.variableMap}
            />
          ) : null}
          {state.target ? (
            <InspectorSection summary={state.target.id} title={t("Theme details")}>
              <dl className="settings-theme-technical-list">
                <div><dt>{t("Theme ID")}</dt><dd>{state.target.id}</dd></div>
                <div><dt>{t("Color scheme")}</dt><dd>{state.target.manifest.colorScheme === "dark" ? t("Dark") : t("Light")}</dd></div>
                <div><dt>{t("Source")}</dt><dd>{state.target.source === "built-in" ? t("Built-in") : t("Local theme")}</dd></div>
                {packageValue?.packageChecksumSha256 ? (
                  <div><dt>{t("Package checksum")}</dt><dd>{packageValue.packageChecksumSha256}</dd></div>
                ) : null}
                {packageValue?.preview ? (
                  <div><dt>{t("Preview size")}</dt><dd>{formatThemePackageBytes(packageValue.preview.byteLength)}</dd></div>
                ) : null}
              </dl>
            </InspectorSection>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button ref={closeRef} size="sm" variant="secondary" onClick={onClose}>
            {t("Close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
