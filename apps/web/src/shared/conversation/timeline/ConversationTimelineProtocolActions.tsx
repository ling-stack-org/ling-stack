import { useRef, useState } from "react";
import { GitBranch, GitPullRequestArrow } from "lucide-react";
import type {
  ConversationProtocolAction,
  ConversationTimelineApprovalItem,
  ConversationTimelineProtocolEventItem,
} from "@ling-stack/conversation-ui-core";
import { useI18n } from "../../../i18n.js";

type ProtocolActionItem = ConversationTimelineProtocolEventItem | ConversationTimelineApprovalItem;

export function ConversationTimelineProtocolActions<TItem extends ProtocolActionItem>({
  item,
  onInvoke,
}: {
  readonly item: TItem;
  readonly onInvoke?: (item: TItem, action: ConversationProtocolAction) => void | Promise<void>;
}): React.JSX.Element | null {
  const { t } = useI18n();
  const invocationInFlightRef = useRef(false);
  const [invocationInFlight, setInvocationInFlight] = useState(false);
  const actions = item.availableActions ?? [];
  if (!onInvoke || actions.length === 0) return null;

  async function invoke(action: ConversationProtocolAction): Promise<void> {
    if (invocationInFlightRef.current) return;
    invocationInFlightRef.current = true;
    setInvocationInFlight(true);
    try {
      await onInvoke?.(item, action);
    } finally {
      invocationInFlightRef.current = false;
      setInvocationInFlight(false);
    }
  }

  return (
    <div
      className="conversation-timeline-protocol-actions"
      aria-label={t("Actions")}
      aria-busy={invocationInFlight || undefined}
    >
      {actions.map((action) => (
        <button
          key={action}
          className="secondary-button compact-button"
          type="button"
          disabled={invocationInFlight}
          data-workflow-conflict-recovery={action === "recover_workflow_conflict" ? item.sourceRefs.find(ref => ref.kind === "workflow")?.id : undefined}
          onClick={() => void invoke(action)}
        >
          {action === "start_isolated_workflow" ? <GitBranch size={14} aria-hidden="true" /> : null}
          {action === "recover_workflow_conflict" ? <GitPullRequestArrow size={14} aria-hidden="true" /> : null}
          {t(protocolActionLabel(action))}
        </button>
      ))}
    </div>
  );
}

function protocolActionLabel(action: ConversationProtocolAction): string {
  const labels: Record<ConversationProtocolAction, string> = {
    open_details: "Details",
    open_source: "Review source",
    create_task: "Create task",
    open_task: "Show task in transcript",
    open_run: "Show run in transcript",
    open_approval: "Open approval",
    start_workflow: "Start workflow",
    advance_workflow: "Advance workflow",
    start_isolated_workflow: "Start isolated branches (candidate only)",
    recover_workflow_conflict: "Repair conflict",
    cancel_workflow: "Cancel workflow",
    retry_step: "Retry",
    supersede_decision: "Supersede",
    reject_decision: "Reject",
  };
  return labels[action];
}
