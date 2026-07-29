import { ArchiveRestore, Trash2 } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { formatDateTime } from "../../lib/formatting.js";
import { Button, DataRow, EmptyState, IconButton, Skeleton } from "../../shared/ui/index.js";
import { ArchivedErrorFeedback } from "./ArchivedErrorFeedback.js";
import type { ArchivedSettingsActionError } from "./useArchivedSettingsController.js";
import type { ArchivedItemRowViewModel } from "./archived-items-view-models.js";

export function ArchivedItemList({
  actionError,
  actionId,
  emptyLabel,
  isLoading,
  label,
  rows,
  onDelete,
  onRestore,
}: {
  readonly actionError?: ArchivedSettingsActionError;
  readonly actionId: string;
  readonly emptyLabel: string;
  readonly isLoading: boolean;
  readonly label: string;
  readonly rows: readonly ArchivedItemRowViewModel[];
  readonly onDelete: (row: ArchivedItemRowViewModel, trigger: HTMLButtonElement) => void;
  readonly onRestore: (row: ArchivedItemRowViewModel) => void;
}): JSX.Element {
  const { t } = useI18n();
  const mutationBusy = Boolean(actionId);
  const showSkeletons = isLoading && rows.length === 0;

  return (
    <div
      className="archived-item-list"
      data-ui2-archived-list=""
      role="tabpanel"
      aria-busy={isLoading || undefined}
      aria-label={label}
    >
      {actionError ? <ArchivedErrorFeedback className="archived-items-list-feedback" feedback={actionError} /> : null}
      {showSkeletons ? <ArchivedListSkeleton /> : rows.length > 0 ? rows.map((row) => {
        const displayName = row.displayName || (row.displayNameFallbackKey ? t(row.displayNameFallbackKey) : "");
        const restoring = actionId === row.restoreActionId;
        const deleting = actionId === row.deleteActionId;
        return (
          <DataRow
            key={row.key}
            className="archived-item-row"
            compact
            data-archived-id={row.id}
            data-archived-kind={row.kind}
            identity={(
              <div className="archived-item-main">
                <strong title={displayName}>{displayName}</strong>
              </div>
            )}
            summary={<time className="archived-item-time" dateTime={row.archivedAt}>{formatDateTime(row.archivedAt)}</time>}
            actions={(
              <div className="archived-item-actions">
                <Button
                  disabled={mutationBusy}
                  leadingIcon={<ArchiveRestore aria-hidden="true" />}
                  loading={restoring}
                  loadingLabel={t("Restoring...")}
                  size="sm"
                  variant="secondary"
                  onClick={() => onRestore(row)}
                >
                  <span className="archived-action-label">{t(row.restoreLabelKey)}</span>
                </Button>
                <IconButton
                  className="archived-delete-action"
                  disabled={mutationBusy}
                  icon={Trash2}
                  label={t(row.deleteLabelKey)}
                  loading={deleting}
                  loadingLabel={t("Deleting...")}
                  size="sm"
                  variant="danger"
                  onClick={(event) => onDelete(row, event.currentTarget)}
                />
              </div>
            )}
          />
        );
      }) : <EmptyState className="archived-item-empty" compact title={emptyLabel} />}
    </div>
  );
}

function ArchivedListSkeleton(): JSX.Element {
  const { t } = useI18n();
  return (
    <div className="archived-item-loading" aria-label={t("Loading archived items")}>
      {Array.from({ length: 4 }, (_, index) => (
        <DataRow
          key={index}
          className="archived-item-row archived-item-skeleton"
          compact
          identity={<Skeleton width={`${62 - index * 4}%`} />}
          summary={<Skeleton width={116} />}
          actions={<><Skeleton height={32} shape="block" width={78} /><Skeleton height={32} shape="block" width={32} /></>}
        />
      ))}
    </div>
  );
}
