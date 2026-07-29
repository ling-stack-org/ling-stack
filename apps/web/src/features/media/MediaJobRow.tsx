import { Play, RotateCcw } from "lucide-react";
import { Button, DataRow, StatusIndicator } from "../../shared/ui/index.js";
import { useI18n } from "../../i18n.js";
import type { MediaJobActionId, MediaJobProjectionInput, MediaJobRowView } from "./media-job-types.js";
import { MediaArtifactPreview } from "./MediaArtifactPreview.js";

export function MediaJobRow({
  cwd,
  projection,
  row,
  selected,
  onAction,
  onSelect,
}: {
  readonly cwd: string;
  readonly projection: MediaJobProjectionInput;
  readonly row: MediaJobRowView;
  readonly selected: boolean;
  readonly onAction: (action: MediaJobActionId, projection: MediaJobProjectionInput) => void;
  readonly onSelect: (jobId: string) => void;
}): JSX.Element {
  const { t } = useI18n();
  const action = row.primaryAction;
  return (
    <DataRow
      className="media-job-row"
      data-media-job-row={row.jobId}
      data-product-state={row.status.id}
      data-stale={row.stale || undefined}
      identity={(
        <div className="media-job-row-identity">
          <MediaArtifactPreview cwd={cwd} artifact={row.preview.artifact} mode="tile" loading={row.preview.kind === "loading"} />
          <span className="media-job-row-copy">
            <strong title={row.identity.titleTooltip}>{row.identity.title}</strong>
            <span title={row.identity.description}>{row.identity.description}</span>
          </span>
        </div>
      )}
      summary={<span className="media-job-row-meta">{row.meta.map((item) => <span key={item} title={item}>{item}</span>)}</span>}
      status={<StatusIndicator compact label={t(row.status.labelKey)} tone={row.status.tone} />}
      actions={action ? (
        <Button
          aria-label={t(action.labelKey)}
          disabled={action.disabled}
          leadingIcon={action.id === "retry" ? <RotateCcw size={15} /> : action.id === "start" ? <Play size={15} /> : undefined}
          size="sm"
          title={action.disabledReasonKey ? t(action.disabledReasonKey) : undefined}
          variant={action.emphasis === "primary" ? "primary" : "secondary"}
          onClick={(event) => {
            event.stopPropagation();
            onAction(action.id, projection);
          }}
        >{t(action.labelKey)}</Button>
      ) : null}
      selected={selected}
      onClick={() => onSelect(row.jobId)}
    />
  );
}
