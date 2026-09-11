import type { ReactNode } from "react";
import { Copy, UserRound } from "lucide-react";
import { MessageActionBar } from "@ling-stack/conversation-ui-react";
import {
  conversationTimelineRendererKey,
  type ConversationInteractionSurfaceKind, type ConversationTimelineScopeKind,
  type ConversationTimelineUserInputItem,
} from "@ling-stack/conversation-ui-core";
import { useI18n } from "../../../i18n.js";
import { MessageRow } from "../blocks/MessageRow.js";
import { MessageBodyRenderer } from "../blocks/MessageBodyRenderer.js";
import { LocalFileLink } from "../blocks/LocalFileLink.js";
import { userInputHistoryPresentation } from "./user-input-history-presentation.js";

const surfaces: Record<ConversationTimelineScopeKind, ConversationInteractionSurfaceKind> = {
  normal: "normal_conversation", private: "teammate_direct", channel_root: "channel_root",
  topic: "topic_reply", branch: "channel_branch", run_detail: "run_thread", child: "run_thread",
};

/** Shared read-only history. Submission stays with the durable input controller. */
export function ConversationTimelineUserInputRenderer({ item, depth, cwd, scopeKind = "normal", renderAvatar }: {
  readonly item: ConversationTimelineUserInputItem;
  readonly depth: 0 | 1;
  readonly cwd?: string;
  readonly scopeKind?: ConversationTimelineScopeKind;
  readonly renderAvatar?: (item: ConversationTimelineUserInputItem) => ReactNode;
}): React.JSX.Element {
  const { t } = useI18n();
  const presentation = userInputHistoryPresentation(item);
  const own = item.kind === "userInputAnswer";
  const surface = surfaces[scopeKind];
  const record = item.userInput;
  const body = (text: string): ReactNode => <MessageBodyRenderer text={text} cwd={cwd} compact={false}
    streaming={false} renderLocalFile={({ reference }) => <LocalFileLink reference={reference} />} />;
  return <div className="conversation-timeline-user-input"
    data-conversation-timeline-kind={item.kind}
    data-conversation-timeline-renderer-key={conversationTimelineRendererKey(item.kind)}
    data-conversation-timeline-id={item.id} data-conversation-item-id={item.itemId}
    data-conversation-timeline-revision={item.revision} data-conversation-timeline-depth={depth}
    data-user-input-availability={record.availability}
    data-user-input-status={presentation.state} data-conversation-run-id={item.runId}
    data-conversation-attempt-id={item.attemptId} data-conversation-participant-id={item.participantId}>
    <MessageRow surface={surface} authorType={own ? "local-user" : "ai-teammate"} tone="document"
      authorName={own ? t("You") : item.participantId ?? t("Agent")}
      avatar={record.availability === "available"
        ? renderAvatar?.(item) ?? <UserRound size={18} aria-hidden="true" /> : undefined}
      statusNode={<span className="conversation-user-input-status" data-tone={presentation.tone}>{t(presentation.labelKey)}</span>}
      bodyNode={record.availability === "unavailable" ? null : <div className="conversation-user-input-content">
        {record.kind === "user_input_request" ? record.questions.map((question, index) =>
          <section key={question.questionId} aria-label={t("user_input.question_number", { number: index + 1 })}>
            {body(question.prompt)}
            {question.options.length ? <ul className="conversation-user-input-options">
              {question.options.map(option => <li key={option.optionId}>{option.label}</li>)}
            </ul> : null}
          </section>) : record.answers.map((answer, index) =>
          <section key={answer.questionId} aria-label={t("user_input.answer_number", { number: index + 1 })}>
            {body(answer.kind === "text" ? answer.text : answer.label)}
          </section>)}
      </div>}
      actionsNode={presentation.copyText !== undefined ? <MessageActionBar surface={surface}
        copiedLabel={t("Copied")} actions={[{ id: "copy", kind: "copy", label: t("Copy message"),
          icon: <Copy size={14} aria-hidden="true" />, copyText: presentation.copyText }]} /> : undefined}
    />
  </div>;
}
