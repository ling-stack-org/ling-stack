import { BookOpen, ChevronDown } from "lucide-react";
import type { ConversationTimelineExplorationBatchItem, ConversationTimelineExplorationItem } from "@ling-stack/conversation-ui-core";
import { useI18n } from "../../../i18n.js";
import { useConversationBlockView } from "../view-store/use-conversation-block-view.js";

export function ConversationExplorationBatch({
  batch,
  actionIds,
  revision,
  depth = 0,
  renderItem,
}: {
  readonly batch: ConversationTimelineExplorationBatchItem["batch"];
  readonly actionIds?: readonly string[];
  readonly revision?: number;
  readonly depth?: 0 | 1;
  readonly renderItem: (item: ConversationTimelineExplorationItem) => React.ReactNode;
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
    <section
      className={`conversation-exploration-batch ${disclosure.expanded ? "expanded" : "collapsed"}`}
      data-conversation-timeline-kind="explorationBatch"
      data-conversation-timeline-id={batch.id}
      data-conversation-timeline-revision={revision ?? 0}
      data-conversation-timeline-status="succeeded"
      data-conversation-timeline-depth={depth}
      data-conversation-batch-kind="exploration"
      data-conversation-batch-count={batch.operationCount}
      data-conversation-batch-action-ids={(actionIds ?? batch.actionIds).join(",")}
      data-conversation-action-id={(actionIds ?? batch.actionIds)[0]}
      data-conversation-run-id={batch.runId}
      data-conversation-attempt-id={batch.attemptId}
      data-conversation-work-unit-id={batch.workUnitId}
      data-conversation-participant-id={batch.participantId}
      data-conversation-workflow-step-id={batch.workflowStepId}
      data-conversation-source-refs={batch.sourceRefs.map((ref) => `${ref.kind}:${ref.id}`).join(",")}
    >
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
          {batch.children.map((item) => renderItem(item))}
        </div>
      ) : null}
    </section>
  );
}
