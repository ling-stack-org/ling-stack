import { ChevronDown, SquareTerminal } from "lucide-react";
import type { ReactNode } from "react";
import { useI18n } from "../../../i18n.js";
import type { ConversationCommandBatch as ConversationCommandBatchModel, ConversationCommandBatchItem } from "../../../lib/conversation-work-cell.js";
import { useConversationBlockView } from "../view-store/use-conversation-block-view.js";

export function ConversationCommandBatch({
  batch,
  renderCommand,
}: {
  readonly batch: ConversationCommandBatchModel;
  readonly renderCommand: (command: ConversationCommandBatchItem) => ReactNode;
}): JSX.Element {
  const { t } = useI18n();
  const disclosure = useConversationBlockView({
    blockId: batch.id,
    revisionKey: batch.revisionKey,
    defaultExpanded: batch.defaultExpanded,
    preserveTouchedStateOnRevision: true,
  });
  const duration = formatCommandDuration(batch.durationMs);
  const batchLabel = t("Ran {count} commands", { count: batch.commandCount });

  return (
    <section className={`conversation-command-batch ${disclosure.expanded ? "expanded" : "collapsed"}`}>
      <button
        className="conversation-command-batch-header"
        type="button"
        aria-expanded={disclosure.expanded}
        aria-label={`${batchLabel}. ${disclosure.expanded ? t("Collapse command batch") : t("Expand command batch")}`}
        onClick={disclosure.toggleExpanded}
      >
        <SquareTerminal size={14} aria-hidden="true" />
        <span>{batchLabel}</span>
        {duration ? <small>{duration}</small> : null}
        <span className="conversation-command-batch-toggle" aria-hidden="true">
          <ChevronDown size={13} />
        </span>
      </button>
      {disclosure.expanded ? (
        <div className="conversation-command-batch-list">
          {batch.commands.map((command) => renderCommand(command))}
        </div>
      ) : null}
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
