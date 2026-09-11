import { CheckSquare, GitBranch, Handshake, ListChecks, MessageSquareText, Play, Workflow } from "lucide-react";
import type { ConversationProtocolAction, ConversationTimelineProtocolEventItem } from "@ling-stack/conversation-ui-core";
import { TimelineFactRow } from "./TimelineFactRow.js";
import { TextDetail, detailExists } from "./timeline-renderer-details.js";
import { ConversationTimelineProtocolActions } from "./ConversationTimelineProtocolActions.js";

export function ConversationTimelineProtocolRenderer({
  item,
  depth,
  onInvokeProtocolAction,
}: {
  readonly item: ConversationTimelineProtocolEventItem;
  readonly depth: 0 | 1;
  readonly onInvokeProtocolAction?: (item: ConversationTimelineProtocolEventItem, action: ConversationProtocolAction) => void | Promise<void>;
}): React.JSX.Element {
  const hasActions = Boolean(onInvokeProtocolAction && item.availableActions?.length);
  return (
    <TimelineFactRow
      item={item}
      depth={depth}
      title={item.title}
      meta={item.meta}
      icon={<ProtocolIcon kind={item.protocolKind} />}
      detail={detailExists(item) || hasActions ? (
        <>
          {detailExists(item) ? <TextDetail text={item.description ?? item.detailLines?.map((line) => line.text).join("\n")} /> : null}
          <ConversationTimelineProtocolActions item={item} onInvoke={onInvokeProtocolAction} />
        </>
      ) : undefined}
    />
  );
}

function ProtocolIcon({ kind }: { readonly kind: ConversationTimelineProtocolEventItem["protocolKind"] }): React.JSX.Element {
  if (kind === "handoff") return <Handshake size={14} aria-hidden="true" />;
  if (kind === "decision") return <CheckSquare size={14} aria-hidden="true" />;
  if (kind === "summary") return <MessageSquareText size={14} aria-hidden="true" />;
  if (kind === "workflow" || kind === "workflow-step") return <Workflow size={14} aria-hidden="true" />;
  if (kind === "task") return <ListChecks size={14} aria-hidden="true" />;
  if (kind === "run") return <Play size={14} aria-hidden="true" />;
  return <GitBranch size={14} aria-hidden="true" />;
}
