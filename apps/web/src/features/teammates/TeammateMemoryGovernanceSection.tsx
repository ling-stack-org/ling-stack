import { Download, Upload } from "lucide-react";
import { useI18n } from "../../i18n.js";
import {
  Button,
  Field,
  InlineFeedback,
  InspectorSection,
  Select,
  StatusIndicator,
  Switch,
} from "../../shared/ui/index.js";
import type { MemoryReviewMode } from "../../types.js";
import { memoryReviewModeDescription } from "./teammate-memory-view-models.js";
import { TeammateMemoryReviewList } from "./TeammateMemoryReviewList.js";
import type { TeammateMemoryController } from "./useTeammateMemoryController.js";

export function TeammateMemoryGovernanceSection({
  controller,
}: {
  readonly controller: TeammateMemoryController;
}): JSX.Element {
  const { t } = useI18n();
  const policy = controller.snapshot?.policy;
  return (
    <section className="teammate-memory-section teammate-memory-governance" aria-labelledby="teammate-memory-governance-title">
      <div className="teammate-memory-section-heading">
        <div>
          <h3 id="teammate-memory-governance-title">{t("Workspace memory governance")}</h3>
          <p>{t("Policy and inbox changes apply to the whole Workspace, not only this teammate.")}</p>
        </div>
        <StatusIndicator compact label={t("Workspace policy")} tone="info" />
      </div>

      <div className="teammate-memory-policy-row">
        <Field
          className="teammate-memory-policy-field"
          label={t("Memory review mode")}
          description={t(memoryReviewModeDescription(policy?.mode ?? "balanced"))}
          error={controller.policyError || undefined}
        >
          <Select
            aria-label={t("Memory review mode")}
            value={policy?.mode ?? "balanced"}
            loading={controller.policySaving}
            disabled={!policy}
            onChange={(event) => void controller.changeReviewMode(event.target.value as MemoryReviewMode)}
          >
            <option value="conservative">{t("Conservative")}</option>
            <option value="balanced">{t("Balanced")}</option>
            <option value="fast">{t("Fast")}</option>
          </Select>
        </Field>
        <div className="teammate-memory-transfer-actions">
          <Button size="sm" variant="secondary" leadingIcon={<Upload />} onClick={() => controller.setImportOpen(true)}>
            {t("Import")}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            leadingIcon={<Download />}
            loading={controller.transferBusy === "export"}
            disabled={Boolean(controller.transferBusy)}
            onClick={() => void controller.exportProjection()}
          >
            {t("Export")}
          </Button>
        </div>
      </div>

      {controller.exportError ? <InlineFeedback tone="danger">{controller.exportError}</InlineFeedback> : null}
      <InspectorSection
        className="teammate-memory-export-options"
        title={t("Export options")}
        summary={t(controller.exportIncludeSecretAdjacent ? "Secret-adjacent content included" : "Secret-adjacent content excluded")}
      >
        <label className="teammate-memory-switch-row">
          <span>
            <strong>{t("Include secret-adjacent exports")}</strong>
            <small>{t("Keep this off unless the exported file will remain in a trusted local boundary.")}</small>
          </span>
          <Switch
            aria-label={t("Include secret-adjacent exports")}
            checked={controller.exportIncludeSecretAdjacent}
            disabled={Boolean(controller.transferBusy)}
            onCheckedChange={controller.setExportIncludeSecretAdjacent}
          />
        </label>
      </InspectorSection>

      <TeammateMemoryReviewList
        error={controller.reviewError}
        reviewingId={controller.reviewingId}
        rows={controller.viewModel.reviewRows}
        onOpenDetail={(row) => controller.openMemoryDetail({ kind: "memory", item: row.item })}
        onRequestReview={(row, action) => controller.requestReview(row.item, action)}
        onStartEdit={(row) => controller.startEdit(row.item)}
      />
    </section>
  );
}
