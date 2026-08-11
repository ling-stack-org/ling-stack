import { useEffect, useMemo, useRef, useState } from "react";
import { History } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { Button, EmptyState, InlineFeedback, InspectorSection, StatusIndicator } from "../../shared/ui/index.js";
import type { MediaJob, MediaScene, MediaSceneRun, RunArtifact } from "../../types.js";
import type { MediaProductionActions, MediaProductionFailure } from "./media-production-types.js";
import { deriveSceneRunProjections } from "./media-production-view-models.js";

export function SceneRunHistory({
  scene,
  runs,
  jobs,
  artifactsByJob,
  actions,
}: {
  readonly scene: MediaScene;
  readonly runs: readonly MediaSceneRun[];
  readonly jobs: readonly MediaJob[];
  readonly artifactsByJob: Readonly<Record<string, readonly RunArtifact[]>>;
  readonly actions: MediaProductionActions;
}): React.JSX.Element {
  const { locale, t } = useI18n();
  const projections = useMemo(() => deriveSceneRunProjections({ scene, runs, jobs, artifactsByJob, locale }), [artifactsByJob, jobs, locale, runs, scene]);
  const [busyRunIds, setBusyRunIds] = useState<ReadonlySet<string>>(() => new Set());
  const [failures, setFailures] = useState<Readonly<Record<string, MediaProductionFailure>>>({});
  const busyRef = useRef(new Set<string>());
  const sceneIdRef = useRef(scene.id);

  useEffect(() => {
    sceneIdRef.current = scene.id;
    busyRef.current.clear();
    setBusyRunIds(new Set());
    setFailures({});
  }, [scene.id]);

  const runAction = async (runId: string, action: "cancel" | "select"): Promise<void> => {
    if (busyRef.current.has(runId)) return;
    const targetSceneId = scene.id;
    busyRef.current.add(runId);
    setBusyRunIds(new Set(busyRef.current));
    setFailures((current) => omitFailure(current, runId));
    const outcome = action === "cancel"
      ? await actions.cancelSceneRun(runId)
      : await actions.selectSceneRun(targetSceneId, runId);
    if (sceneIdRef.current === targetSceneId && !outcome.ok) setFailures((current) => ({ ...current, [runId]: outcome.failure }));
    busyRef.current.delete(runId);
    if (sceneIdRef.current === targetSceneId) setBusyRunIds(new Set(busyRef.current));
  };

  const retry = async (runId: string, failure: MediaProductionFailure): Promise<void> => {
    if (busyRef.current.has(runId)) return;
    const targetSceneId = scene.id;
    busyRef.current.add(runId);
    setBusyRunIds(new Set(busyRef.current));
    const outcome = await actions.retryFailure(failure);
    if (sceneIdRef.current === targetSceneId) setFailures((current) => outcome.ok ? omitFailure(current, runId) : { ...current, [runId]: outcome.failure });
    busyRef.current.delete(runId);
    if (sceneIdRef.current === targetSceneId) setBusyRunIds(new Set(busyRef.current));
  };

  if (!projections.length) {
    return <EmptyState className="scene-inspector-section" compact icon={<History size={20} />} title={t("No generation tasks yet")} />;
  }

  return (
    <section className="scene-inspector-section scene-run-history">
      <span className="field-label">{t("History")}</span>
      <div className="scene-run-list">
        {projections.map((projection) => {
          const failure = failures[projection.run.id];
          const busy = busyRunIds.has(projection.run.id);
          return (
            <div className="scene-run-entry" key={projection.run.id} data-run-id={projection.run.id} data-run-state={projection.status}>
              <div className={`scene-run-row${projection.selected ? " selected" : ""}`}>
                <span>
                  <StatusIndicator compact label={t(projection.statusLabel.key, projection.statusLabel.values)} tone={projection.statusTone} />
                  <small>{projection.sourceName ?? t(projection.sourceLabel.key, projection.sourceLabel.values)} · {projection.createdAtLabel}</small>
                </span>
                {projection.primaryAction === "select" ? (
                  <Button size="sm" loading={busy} variant="secondary" onClick={() => void runAction(projection.run.id, "select")}>{t("Set default")}</Button>
                ) : projection.primaryAction === "cancel" ? (
                  <Button size="sm" loading={busy} variant="secondary" onClick={() => void runAction(projection.run.id, "cancel")}>{t("Cancel")}</Button>
                ) : null}
              </div>
              {projection.job?.errorMessage ? (
                <InspectorSection title={t("Technical details")}>
                  <p>{projection.job.errorMessage}</p>
                </InspectorSection>
              ) : null}
              {failure ? (
                <InlineFeedback role="alert" title={t(failure.productMessageKey)} tone="danger">
                  <span className="scene-run-failure-actions">
                    <Button size="sm" loading={busy} variant="secondary" onClick={() => void retry(projection.run.id, failure)}>{t("Retry")}</Button>
                    <Button size="sm" variant="ghost" onClick={() => {
                      actions.clearFailure(failure.owner, failure.subjectId);
                      setFailures((current) => omitFailure(current, projection.run.id));
                    }}>{t("Clear")}</Button>
                  </span>
                  {failure.technicalMessage ? <InspectorSection title={t("Technical details")}><p>{failure.technicalMessage}</p></InspectorSection> : null}
                </InlineFeedback>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function omitFailure(failures: Readonly<Record<string, MediaProductionFailure>>, runId: string): Readonly<Record<string, MediaProductionFailure>> {
  const next = { ...failures };
  delete next[runId];
  return next;
}
