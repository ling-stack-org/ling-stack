import { Check, Info, Pencil, ShieldAlert } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { Button, DataRow, EmptyState, IconButton, InlineFeedback, StatusIndicator } from "../../shared/ui/index.js";
import type { MemoryReviewAction } from "../../types.js";
import type { TeammateMemoryReviewRow } from "./teammate-memory-view-models.js";

export function TeammateMemoryReviewList({
  error,
  reviewingId,
  rows,
  onOpenDetail,
  onRequestReview,
  onStartEdit,
}: {
  readonly error: string;
  readonly reviewingId: string;
  readonly rows: readonly TeammateMemoryReviewRow[];
  readonly onOpenDetail: (row: TeammateMemoryReviewRow) => void;
  readonly onRequestReview: (row: TeammateMemoryReviewRow, action: MemoryReviewAction) => void;
  readonly onStartEdit: (row: TeammateMemoryReviewRow) => void;
}): JSX.Element {
  const { t } = useI18n();
  return (
    <section className="teammate-memory-review-section" aria-labelledby="teammate-memory-review-title">
      <div className="teammate-memory-section-heading compact">
        <h4 id="teammate-memory-review-title">{t("Review inbox")}</h4>
        {rows.length > 0 ? (
          <StatusIndicator compact label={t("{count} pending", { count: rows.length })} tone="warning" />
        ) : null}
      </div>
      {error ? <InlineFeedback tone="danger">{error}</InlineFeedback> : null}
      {rows.length === 0 ? (
        <EmptyState compact icon={<ShieldAlert />} title={t("No memory candidates need review")} />
      ) : (
        <div className="teammate-memory-review-list" data-ui2-teammate-memory-review-list="true" role="list">
          {rows.map((row) => {
            const busy = reviewingId === row.item.memory.id;
            return (
              <DataRow
                key={row.item.memory.id}
                className="teammate-memory-review-row"
                compact
                role="listitem"
                data-memory-id={row.item.memory.id}
                loading={busy}
                identity={<span className="teammate-memory-row-copy"><strong title={row.item.memory.title}>{row.item.memory.title}</strong><small>{row.scopeLabel} · {row.ownerLabel}</small></span>}
                summary={<span className="teammate-memory-review-used">{row.usedCount ? t("Used {count} times", { count: row.usedCount }) : t("Not used yet")}</span>}
                status={<StatusIndicator compact label={row.statusLabel} tone={row.statusTone} />}
                actions={(
                  <>
                    <Button
                      size="sm"
                      variant={row.primaryAction === "quarantine" || row.primaryAction === "reject" ? "secondary" : "primary"}
                      leadingIcon={row.primaryAction === "approve" ? <Check /> : <ShieldAlert />}
                      disabled={Boolean(reviewingId)}
                      onClick={() => onRequestReview(row, row.primaryAction)}
                    >
                      {row.primaryActionLabel}
                    </Button>
                    <IconButton icon={Pencil} label={t("Edit memory candidate")} disabled={Boolean(reviewingId)} onClick={() => onStartEdit(row)} />
                    <IconButton icon={Info} label={t("View memory details")} disabled={Boolean(reviewingId)} onClick={() => onOpenDetail(row)} />
                  </>
                )}
              />
            );
          })}
        </div>
      )}
    </section>
  );
}
