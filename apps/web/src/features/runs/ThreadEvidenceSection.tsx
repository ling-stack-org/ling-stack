import { RotateCcw, ShieldCheck } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { DataRow, EmptyState, InlineFeedback, InspectorSection, StatusIndicator } from "../../shared/ui/index.js";
import type { ThreadDetailController } from "./ThreadDetailPanel.js";
import { RunInterventionRow } from "./RunInterventionRow.js";
import { runStatusTone } from "./run-list-view-models.js";

export function ThreadEvidenceSection({ controller }: { readonly controller: ThreadDetailController }): JSX.Element {
  const { t } = useI18n();
  const { evidence, interventions, interventionsLoading, errors } = controller.state;
  const artifactById = new Map(evidence?.runs.flatMap((item) => item.artifacts).map((artifact) => [artifact.id, artifact]) ?? []);
  return (
    <InspectorSection summary={t("{count} actions", { count: evidence?.actions.length ?? 0 })} title={t("Evidence")}>
      <div className="runs-section-stack">
        <section className="runs-subsection">
          <h4>{t("Execution actions")}</h4>
          {!evidence?.actions.length ? <EmptyState compact icon={<ShieldCheck />} title={t("No execution actions recorded")} /> : evidence.actions.map((action) => (
            <DataRow
              identity={<span><strong>{action.actionType}: {action.title}</strong><small>{formatTargets(action.targetRefs)}</small></span>}
              key={action.id}
              status={<span><StatusIndicator compact label={t(action.status)} tone={runStatusTone(action.status)} /><small>{[...action.previewArtifactIds, ...action.resultArtifactIds].map((id) => artifactById.get(id)?.title ?? id).join(" · ")}</small></span>}
            />
          ))}
        </section>
        <section className="runs-subsection">
          <h4>{t("Queued follow-ups and redirects")}</h4>
          {errors.interventions ? <InlineFeedback tone="warning">{t("{count} intervention audit request failed", { count: Number.parseInt(errors.interventions, 10) || 1 })}</InlineFeedback> : null}
          {!interventionsLoading && interventions.length === 0 ? <EmptyState compact icon={<RotateCcw />} title={t("No queued follow-ups or redirects")} /> : interventions.map((intervention) => (
            <RunInterventionRow
              intervention={intervention}
              key={intervention.id}
              loading={interventionsLoading}
            />
          ))}
        </section>
      </div>
    </InspectorSection>
  );
}

function formatTargets(targetRefs: readonly { readonly type: string; readonly id?: string; readonly path?: string }[]): string {
  return targetRefs.map((target) => target.id ? `${target.type}:${target.id}` : target.path ? `${target.type}:${target.path}` : target.type).join(", ") || "-";
}
