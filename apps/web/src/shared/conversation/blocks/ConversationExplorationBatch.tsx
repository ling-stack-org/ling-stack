import { BookOpen, ChevronDown } from "lucide-react";
import { useI18n } from "../../../i18n.js";
import type { ConversationExplorationBatch as ConversationExplorationBatchModel, ConversationWorkCellRow } from "../../../lib/conversation-work-cell.js";
import { useConversationBlockView } from "../view-store/use-conversation-block-view.js";

export function ConversationExplorationBatch({
  batch,
  renderRow,
}: {
  readonly batch: ConversationExplorationBatchModel;
  readonly renderRow: (row: ConversationWorkCellRow) => React.ReactNode;
}): React.JSX.Element {
  const { t } = useI18n();
  const disclosure = useConversationBlockView({
    blockId: batch.id,
    revisionKey: batch.revisionKey,
    defaultExpanded: batch.defaultExpanded,
    preserveTouchedStateOnRevision: true,
  });
  const batchLabel = t("Read {count} items", { count: batch.targetCount ?? batch.operationCount });

  return (
    <section className={`conversation-exploration-batch ${disclosure.expanded ? "expanded" : "collapsed"}`}>
      <button
        className="conversation-exploration-batch-header"
        type="button"
        aria-expanded={disclosure.expanded}
        aria-label={`${batchLabel}. ${disclosure.expanded ? t("Collapse read records") : t("Expand read records")}`}
        onClick={disclosure.toggleExpanded}
      >
        <BookOpen size={14} aria-hidden="true" />
        <span>{batchLabel}</span>
        <span className="conversation-exploration-batch-toggle" aria-hidden="true">
          <ChevronDown size={13} />
        </span>
      </button>
      {disclosure.expanded ? (
        <div className="conversation-exploration-batch-list">
          {batch.rows.map((row) => renderRow(row))}
        </div>
      ) : null}
    </section>
  );
}
