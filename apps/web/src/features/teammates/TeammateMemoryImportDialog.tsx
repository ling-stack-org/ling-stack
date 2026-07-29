import { FileText, Upload } from "lucide-react";
import { useI18n } from "../../i18n.js";
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Field,
  InlineFeedback,
  Input,
  InspectorSection,
  StatusIndicator,
  Textarea,
} from "../../shared/ui/index.js";
import { importPlanWarningCount } from "./teammate-memory-view-models.js";
import type { TeammateMemoryController } from "./useTeammateMemoryController.js";

export function TeammateMemoryImportDialog({ controller }: { readonly controller: TeammateMemoryController }): JSX.Element {
  const { t } = useI18n();
  const plan = controller.importPlan;
  const warningCount = importPlanWarningCount(plan);
  const busy = controller.transferBusy === "preview" || controller.transferBusy === "import";
  return (
    <Dialog open={controller.importOpen} busy={busy} onOpenChange={controller.setImportOpen}>
      <DialogContent size="lg" className="teammate-memory-import-dialog">
        <DialogHeader
          title={t("Import memory")}
          description={t("Preview creates no memory. Import commits the reviewed candidates to the Workspace inbox.")}
          closeLabel={t("Close")}
        />
        <DialogBody className="teammate-memory-import-body">
          {controller.importError ? <InlineFeedback tone="danger">{controller.importError}</InlineFeedback> : null}
          <div className="teammate-memory-import-source">
            <Field label={t("Source label")}>
              <Input
                value={controller.importSourceLabel}
                disabled={busy}
                placeholder="memory-export.md"
                onChange={(event) => controller.setImportSourceLabel(event.target.value)}
              />
            </Field>
            <Button asChild size="sm" variant="secondary" leadingIcon={<Upload />}>
              <label className="teammate-memory-file-button">
                {t("Choose Markdown")}
                <input
                  data-ling-control-native="true"
                  type="file"
                  accept=".md,text/markdown,text/plain"
                  disabled={busy}
                  onChange={(event) => {
                    const file = event.currentTarget.files?.[0];
                    event.currentTarget.value = "";
                    void controller.loadImportFile(file);
                  }}
                />
              </label>
            </Button>
          </div>
          <Field label={t("Markdown")}>
            <Textarea
              rows={10}
              value={controller.importContent}
              disabled={busy}
              placeholder={t("Paste a Ling memory Markdown export")}
              onChange={(event) => controller.updateImportContent(event.target.value)}
            />
          </Field>

          {plan ? (
            <div className="teammate-memory-import-plan" aria-label={t("Import preview summary")}>
              <StatusIndicator label={t("{count} candidates", { count: plan.candidateCount })} tone="neutral" />
              <StatusIndicator label={t("{count} skipped", { count: plan.skippedCount })} tone={plan.skippedCount ? "warning" : "neutral"} />
              <StatusIndicator label={t("{count} warnings", { count: warningCount })} tone={warningCount ? "warning" : "neutral"} />
            </div>
          ) : null}

          {plan && (warningCount > 0 || plan.skipped.length > 0) ? (
            <InspectorSection title={t("Import warnings and skipped items")} summary={t("Review before importing") }>
              <div className="teammate-memory-import-warning-list">
                {plan.candidates.flatMap((candidate) => candidate.warnings.map((warning, index) => (
                  <InlineFeedback key={`${candidate.index}:${index}`} tone="warning" title={candidate.title}>{warning}</InlineFeedback>
                )))}
                {plan.skipped.map((item) => (
                  <InlineFeedback key={`skipped:${item.index}`} tone="warning" title={item.title ?? t("Skipped item")}>{item.reason}</InlineFeedback>
                ))}
              </div>
            </InspectorSection>
          ) : null}

          {plan?.candidates.some((candidate) => candidate.createInput.sensitivity === "secret-adjacent") ? (
            <InlineFeedback tone="warning" title={t("Secret-adjacent candidates stay disabled")}>
              {t("They require verification before use and are excluded from default export.")}
            </InlineFeedback>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => controller.setImportOpen(false)}>{t("Cancel")}</Button>
          <Button
            size="sm"
            variant="secondary"
            leadingIcon={<FileText />}
            loading={controller.transferBusy === "preview"}
            disabled={busy || !controller.importContent.trim()}
            onClick={() => void controller.previewImport()}
          >
            {t("Preview import")}
          </Button>
          <Button
            size="sm"
            variant="primary"
            loading={controller.transferBusy === "import"}
            disabled={busy || !controller.importPreviewCurrent}
            onClick={() => void controller.commitImport()}
          >
            {t("Import candidates")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
