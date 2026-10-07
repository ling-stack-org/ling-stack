import { ChevronDown, SquareTerminal } from "lucide-react";
import { conversationTimelineRendererKey, type ConversationTimelineCommandBatchItem } from "@ling-stack/conversation-ui-core";
import { useI18n } from "../../../i18n.js";
import type { ConversationTimelineBatchDisclosure } from "../timeline/conversation-timeline-display-model.js";

export function ConversationCommandBatch({
  batch,
  actionIds,
  revision,
  depth = 0,
  disclosure,
  onExpandedChange,
}: {
  readonly batch: ConversationTimelineCommandBatchItem["batch"];
  readonly actionIds?: readonly string[];
  readonly revision?: number;
  readonly depth?: 0 | 1;
  readonly disclosure: ConversationTimelineBatchDisclosure;
  readonly onExpandedChange: (expanded: boolean) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const duration = formatCommandDuration(batch.durationMs);
  const batchLabel = t("Ran {count} commands", { count: batch.commandCount });
  const density = batch.commandCount > 20 ? "large" : "default";

  return (
    <section
      className={`conversation-command-batch density-${density} ${disclosure.expanded ? "expanded" : "collapsed"}`}
      data-conversation-timeline-kind="commandBatch"
      data-conversation-timeline-renderer-key={conversationTimelineRendererKey("commandBatch")}
      data-conversation-timeline-id={batch.id}
      data-conversation-timeline-revision={revision ?? 0}
      data-conversation-timeline-status="succeeded"
      data-conversation-timeline-depth={depth}
      data-conversation-batch-kind="command"
      data-conversation-batch-count={batch.commandCount}
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
        className="conversation-command-batch-header"
        type="button"
        aria-expanded={disclosure.expanded}
        aria-controls={disclosure.expanded ? disclosure.groupId : undefined}
        aria-label={`${batchLabel}. ${disclosure.expanded ? t("Collapse command batch") : t("Expand command batch")}`}
        onClick={() => onExpandedChange(!disclosure.expanded)}
      >
        <SquareTerminal size={14} aria-hidden="true" />
        <span>{batchLabel}</span>
        {duration ? <small>{duration}</small> : null}
        <span className="conversation-command-batch-toggle" aria-hidden="true">
          <ChevronDown size={13} />
        </span>
      </button>
    </section>
  );
}

function formatCommandDuration(durationMs: number | undefined): string | undefined {
  if (durationMs === undefined || durationMs < 0) {
    return undefined;
  }
  if (durationMs < 1000) {
    return `${Math.max(1, Math.round(durationMs))}ms`;
  }
  const seconds = durationMs / 1000;
  return seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`;
}
