import type { ReactNode } from "react";
import { Copy } from "lucide-react";
import { MessageActionBar } from "@ling-stack/conversation-ui-react";
import type { ConversationInteractionSurfaceKind, ConversationTimelineScopeKind } from "@ling-stack/conversation-ui-core";
import { useI18n } from "../../../i18n.js";
import { hasFinalTimelineResponseNarration, type ConversationTimelineResponse } from "./timeline-response-presentation.js";
import { timelineResponseCopyText } from "./terminal-report-copy-text.js";

const surfaceByScope: Record<ConversationTimelineScopeKind, ConversationInteractionSurfaceKind> = {
  normal: "normal_conversation", private: "teammate_direct", channel_root: "channel_root",
  topic: "topic_reply", branch: "channel_branch", run_detail: "run_thread", child: "run_thread",
};

/** Surface actions receive the shared, privacy-filtered response copy projection. */
export type ConversationTimelineResponseActionsRenderer = (response: ConversationTimelineResponse, copyText: string) => ReactNode;

export function ConversationTimelineResponseFooter({ response, scopeKind = "normal", renderActions }: {
  readonly response: ConversationTimelineResponse;
  readonly scopeKind?: ConversationTimelineScopeKind;
  readonly renderActions?: ConversationTimelineResponseActionsRenderer;
}): React.JSX.Element | null {
  const { t } = useI18n();
  if (!response.settled) return null;
  const copyText = timelineResponseCopyText(response, hasFinalTimelineResponseNarration(response));
  const actions = renderActions?.(response, copyText) ?? (copyText ? <MessageActionBar
    surface={surfaceByScope[scopeKind]}
    copiedLabel={t("Copied")}
    actions={[{ id: "copy-response", kind: "copy", label: t("Copy message"), icon: <Copy size={14} />, copyText }]}
  /> : null);
  return actions ? <div className="conversation-timeline-response-footer" data-conversation-response-footer
    data-conversation-response-id={response.id} data-conversation-turn-id={response.message?.turnId ?? response.report?.turnId}
    data-conversation-action-owner>{actions}</div> : null;
}
