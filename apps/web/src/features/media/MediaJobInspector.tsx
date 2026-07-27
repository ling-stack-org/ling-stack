import { Image as ImageIcon } from "lucide-react";
import { EmptyState, Skeleton, StatusIndicator } from "../../shared/ui/index.js";
import { useI18n } from "../../i18n.js";
import { mediaOperationLabel } from "./media-job-state-view-models.js";
import type { MediaJobActionId, MediaJobProjectionInput, MediaJobRepairView } from "./media-job-types.js";
import { deriveMediaJobRowView } from "./media-job-state-view-models.js";
import { MediaJobRepair } from "./MediaJobRepair.js";
import { MediaJobResult } from "./MediaJobResult.js";

export function MediaJobInspector({
  cwd,
  projection,
  repair,
  initialLoading,
  copyError,
  onAction,
  onRetryArtifacts,
}: {
  readonly cwd: string;
  readonly projection?: MediaJobProjectionInput;
  readonly repair?: MediaJobRepairView;
  readonly initialLoading: boolean;
  readonly copyError: string;
  readonly onAction: (action: MediaJobActionId, projection: MediaJobProjectionInput) => void;
  readonly onRetryArtifacts: (jobId: string) => void;
}): JSX.Element {
  const { t } = useI18n();
  if (initialLoading) {
    return <aside className="media-job-inspector" aria-busy="true"><Skeleton shape="block" width="100%" height={180} /><Skeleton width="70%" /><Skeleton width="90%" /></aside>;
  }
  if (!projection) {
    return <aside className="media-job-inspector"><EmptyState compact icon={<ImageIcon size={24} />} title={t("Select a generation task")} /></aside>;
  }
  const row = deriveMediaJobRowView(projection);
  return (
    <aside className="media-job-inspector" data-media-job-inspector={projection.job.id}>
      <div className="media-job-inspector-head">
        <div>
          <span>{t(mediaOperationLabel(projection.job.operation))}</span>
          <h2>{projection.context?.sceneName || projection.job.prompt || t("Generation task")}</h2>
          <p>{t(sourceLabel(projection))}{projection.context?.projectName ? ` · ${projection.context.projectName}` : ""}</p>
        </div>
        <span aria-live="polite"><StatusIndicator label={t(row.status.labelKey)} tone={row.status.tone} /></span>
      </div>
      {repair ? <MediaJobRepair projection={projection} repair={repair} onAction={onAction} /> : null}
      <MediaJobResult cwd={cwd} projection={projection} copyError={copyError} onAction={onAction} onRetryArtifacts={onRetryArtifacts} />
    </aside>
  );
}

function sourceLabel(projection: MediaJobProjectionInput): string {
  if (projection.source.kind === "provider" || projection.source.kind === "workflow") return projection.source.name;
  return "Source unavailable";
}
