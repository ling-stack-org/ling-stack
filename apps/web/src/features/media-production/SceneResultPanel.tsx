import { Play } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { EmptyState, InlineFeedback, InspectorSection, StatusIndicator } from "../../shared/ui/index.js";
import type { RunArtifact } from "../../types.js";
import { MediaArtifactPreview } from "../media/MediaArtifactPreview.js";
import { mediaJobFailureRecoveryView } from "../media/media-job-view-models.js";
import type { SceneReadiness } from "./media-production-view-models.js";
import { deriveSceneResultProjection } from "./media-production-view-models.js";

export function SceneResultPanel({
  cwd,
  readiness,
  artifactsByJob,
}: {
  readonly cwd: string;
  readonly readiness?: SceneReadiness;
  readonly artifactsByJob: Readonly<Record<string, readonly RunArtifact[]>>;
}): JSX.Element {
  const { t } = useI18n();
  const projection = deriveSceneResultProjection(readiness);
  const recovery = readiness?.latestJob && readiness.latestIssue
    ? mediaJobFailureRecoveryView({
      job: readiness.latestJob,
      artifacts: artifactsByJob[readiness.latestJob.id] ?? [],
      t,
    })
    : undefined;

  return (
    <div className="scene-result-view" data-result-state={projection.state}>
      {readiness?.currentArtifact ? (
        <section className="scene-inspector-section scene-current-result">
          <div className="scene-inspector-section-head">
            <span className="field-label">{t("Generated result")}</span>
            {!recovery ? <StatusIndicator compact label={t(projection.statusLabel.key, projection.statusLabel.values)} tone={projection.statusTone} /> : null}
          </div>
          <MediaArtifactPreview artifact={readiness.currentArtifact} cwd={cwd} variant="scene" />
        </section>
      ) : (
        <EmptyState
          className="scene-result-empty"
          compact
          icon={<Play size={22} strokeWidth={1.6} />}
          title={t("No artifacts")}
        />
      )}

      {recovery ? (
        <InlineFeedback className="scene-latest-run-issue" role="alert" title={recovery.title} tone="danger">
          <span>{recovery.description}</span>
          <InspectorSection title={t("Technical details")}>
            <p>{recovery.rawDetails}</p>
          </InspectorSection>
        </InlineFeedback>
      ) : !readiness?.currentArtifact ? (
        <StatusIndicator compact label={t(projection.statusLabel.key, projection.statusLabel.values)} tone={projection.statusTone} />
      ) : null}
    </div>
  );
}
