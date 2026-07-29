import { Brain, RefreshCw, ShieldCheck } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { Button, IconButton, InlineFeedback, Skeleton, StatusIndicator } from "../../shared/ui/index.js";
import { TeammateMemoryGovernanceSection } from "./TeammateMemoryGovernanceSection.js";
import { TeammateMemoryHealthSection } from "./TeammateMemoryHealthSection.js";
import { TeammateMemoryImportDialog } from "./TeammateMemoryImportDialog.js";
import { TeammateMemoryInspectorDrawer } from "./TeammateMemoryInspectorDrawer.js";
import { TeammateMemoryReviewConfirmDialog } from "./TeammateMemoryReviewConfirmDialog.js";
import { TeammateMemoryScopeList } from "./TeammateMemoryScopeList.js";
import type { TeammateMemoryController } from "./useTeammateMemoryController.js";

export function TeammateMemoryTab({
  controller,
  isProtectedSystemTeammate,
}: {
  readonly controller: TeammateMemoryController;
  readonly isProtectedSystemTeammate: boolean;
}): JSX.Element {
  const { t } = useI18n();
  const snapshot = controller.snapshot;
  return (
    <section className="teammate-memory-panel" data-ui2-teammate-memory="true" aria-label={t("Memory")}>
      <header className="teammate-memory-heading">
        <div>
          <Brain aria-hidden="true" />
          <div><h2>{t("Memory")}</h2><p>{controller.viewModel.summaryLabel}</p></div>
        </div>
        <span className="teammate-memory-heading-actions">
          {snapshot ? <StatusIndicator compact label={controller.viewModel.healthLabel} tone={controller.viewModel.healthTone} /> : null}
          <IconButton
            icon={RefreshCw}
            label={t("Refresh memory")}
            loading={controller.refreshing}
            disabled={controller.loading}
            onClick={() => void controller.refresh("refresh")}
          />
        </span>
      </header>

      {isProtectedSystemTeammate ? (
        <InlineFeedback className="teammate-memory-protected" tone="info" title={t("Protected coordinator memory")}>
          {t("Ling Agent scopes are managed and cannot be disabled here. Review actions still preserve the audit lifecycle.")}
        </InlineFeedback>
      ) : null}

      {controller.loadError ? (
        <div className="teammate-memory-load-error">
          <InlineFeedback tone={controller.stale ? "warning" : "danger"} title={controller.stale ? t("Showing retained memory data") : undefined}>
            {controller.loadError}
          </InlineFeedback>
          <Button size="sm" variant="secondary" loading={controller.refreshing} onClick={() => void controller.refresh("refresh")}>{t("Retry")}</Button>
        </div>
      ) : null}

      {controller.loading && !snapshot ? (
        <div className="teammate-memory-loading" aria-label={t("Loading memory")}>
          <Skeleton height={54} />
          <Skeleton height={54} />
          <Skeleton height={88} />
          <Skeleton height={120} />
        </div>
      ) : snapshot ? (
        <div className="teammate-memory-content">
          <TeammateMemoryScopeList rows={controller.viewModel.scopeRows} onOpenDetail={controller.openMemoryDetail} />
          <TeammateMemoryHealthSection
            health={snapshot.health}
            healthLabel={controller.viewModel.healthLabel}
            healthTone={controller.viewModel.healthTone}
            onOpenDetail={controller.openMemoryDetail}
          />
          <TeammateMemoryGovernanceSection controller={controller} />
        </div>
      ) : null}

      <TeammateMemoryImportDialog controller={controller} />
      <TeammateMemoryInspectorDrawer controller={controller} />
      <TeammateMemoryReviewConfirmDialog controller={controller} />
    </section>
  );
}
