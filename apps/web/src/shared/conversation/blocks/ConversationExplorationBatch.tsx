import { BookOpen, ChevronDown } from "lucide-react";
import { conversationTimelineRendererKey, type ConversationTimelineExplorationBatchItem } from "@ling-stack/conversation-ui-core";
import { useI18n } from "../../../i18n.js";
import type { ConversationTimelineBatchDisclosure } from "../timeline/conversation-timeline-display-model.js";

export function ConversationExplorationBatch({
  batch,
  actionIds,
  revision,
  depth = 0,
  disclosure,
  onExpandedChange,
}: {
  readonly batch: ConversationTimelineExplorationBatchItem["batch"];
  readonly actionIds?: readonly string[];
  readonly revision?: number;
  readonly depth?: 0 | 1;
  readonly disclosure: ConversationTimelineBatchDisclosure;
  readonly onExpandedChange: (expanded: boolean) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const batchLabel = t("Read {count} items", { count: batch.targetCount ?? batch.operationCount });
  const density = batch.operationCount > 20 ? "large" : "default";

  return (
    <section
      className={`conversation-exploration-batch density-${density} ${disclosure.expanded ? "expanded" : "collapsed"}`}
      data-conversation-timeline-kind="explorationBatch"
      data-conversation-timeline-renderer-key={conversationTimelineRendererKey("explorationBatch")}
      data-conversation-timeline-id={batch.id}
      data-conversation-timeline-revision={revision ?? 0}
      data-conversation-timeline-status="succeeded"
      data-conversation-timeline-depth={depth}
      data-conversation-batch-kind="exploration"
      data-conversation-batch-count={batch.operationCount}
      data-conversation-batch-density={density}
      data-conversation-batch-action-ids={(actionIds ?? batch.actionIds).join(",")}
      data-conversation-batch-child-action-ids={batch.childActionIds.join(",")}
      data-conversation-batch-child-item-ids={batch.childItemIds.join(",")}
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
        aria-controls={disclosure.expanded ? disclosure.groupId : undefined}
        aria-label={`${batchLabel}. ${disclosure.expanded ? t("Collapse read records") : t("Expand read records")}`}
        onClick={() => onExpandedChange(!disclosure.expanded)}
      >
        <BookOpen size={14} aria-hidden="true" />
        <span>{batchLabel}</span>
        <span className="conversation-exploration-batch-toggle" aria-hidden="true">
          <ChevronDown size={13} />
        </span>
      </button>
    </section>
  );
}
