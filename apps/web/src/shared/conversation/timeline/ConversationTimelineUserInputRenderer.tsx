import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Copy, UserRound } from "lucide-react";
import { LingDaemonError } from "@ling-stack/api-client";
import type { UserInputAnswerV1 } from "@ling-stack/contracts";
import { MessageActionBar } from "@ling-stack/conversation-ui-react";
import {
  conversationTimelineRendererKey,
  type ConversationInteractionSurfaceKind, type ConversationTimelineScopeKind,
  type ConversationTimelineUserInputItem,
} from "@ling-stack/conversation-ui-core";
import { useI18n } from "../../../i18n.js";
import { submitUserInputAnswer } from "../../../api/runs.js";
import { Button, InlineFeedback, Radio, Textarea } from "../../ui/index.js";
import { MessageRow } from "../blocks/MessageRow.js";
import { MessageBodyRenderer } from "../blocks/MessageBodyRenderer.js";
import { LocalFileLink } from "../blocks/LocalFileLink.js";
import { userInputHistoryPresentation } from "./user-input-history-presentation.js";

const surfaces: Record<ConversationTimelineScopeKind, ConversationInteractionSurfaceKind> = {
  normal: "normal_conversation", private: "teammate_direct", channel_root: "channel_root",
  topic: "topic_reply", branch: "channel_branch", run_detail: "run_thread", child: "run_thread",
};

type AnswerDrafts = Readonly<Record<string, UserInputAnswerV1 | undefined>>;

/** Shared history and durable answer surface for every conversation timeline. */
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
  const [drafts, setDrafts] = useState<AnswerDrafts>({});
  const [submitting, setSubmitting] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [failure, setFailure] = useState<"conflict" | "generic">();
  const requestIdentity = record.availability === "available"
    ? `${record.requestId}:${record.requestVersion}:${record.kind === "user_input_request" ? record.statusRevision : record.itemId}`
    : record.itemId;
  const idempotencyKey = useMemo(() => `web-answer:${createSubmissionId()}`, [requestIdentity]);
  useEffect(() => {
    setDrafts({});
    setSubmitting(false);
    setAccepted(false);
    setFailure(undefined);
  }, [requestIdentity]);
  const body = (text: string): ReactNode => <MessageBodyRenderer text={text} cwd={cwd} compact={false}
    streaming={false} renderLocalFile={({ reference }) => <LocalFileLink reference={reference} />} />;
  const request = record.availability === "available" && record.kind === "user_input_request" ? record : undefined;
  const orderedAnswers = request?.questions.reduce<UserInputAnswerV1[]>((answers, question) => {
    const answer = drafts[question.questionId];
    if (answer) answers.push(answer.kind === "text" ? { ...answer, text: answer.text.trim() } : answer);
    return answers;
  }, []) ?? [];
  const requiredComplete = request?.questions.every(question => {
    const answer = drafts[question.questionId];
    return !question.required || Boolean(answer && (answer.kind !== "text" || answer.text.trim()));
  }) ?? false;
  const canSubmit = Boolean(cwd && request?.status === "pending" && requiredComplete && orderedAnswers.length > 0 && !accepted);
  const updateDraft = (questionId: string, answer: UserInputAnswerV1 | undefined): void => {
    setDrafts(current => ({ ...current, [questionId]: answer }));
    setFailure(undefined);
  };
  const handleSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!cwd || !request || !canSubmit || submitting) return;
    setSubmitting(true);
    setFailure(undefined);
    try {
      await submitUserInputAnswer(cwd, request.source.threadId, request.requestId, {
        schemaVersion: 1,
        requestId: request.requestId,
        expectedVersion: request.requestVersion,
        expectedStatusRevision: request.statusRevision,
        idempotencyKey,
        answers: orderedAnswers,
      });
      setAccepted(true);
    } catch (error) {
      setFailure(error instanceof LingDaemonError && error.status === 409 ? "conflict" : "generic");
    } finally {
      setSubmitting(false);
    }
  };
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
      statusNode={accepted ? undefined
        : <span className="conversation-user-input-status" data-tone={presentation.tone}>{t(presentation.labelKey)}</span>}
      bodyNode={record.availability === "unavailable" ? null : <div className="conversation-user-input-content">
        {record.kind === "user_input_request" ? <>
          {record.questions.map((question, index) => {
            const draft = drafts[question.questionId];
            return <section key={question.questionId} aria-label={t("user_input.question_number", { number: index + 1 })}>
              {body(question.prompt)}
              {record.status === "pending" && cwd ? <div className="conversation-user-input-question-controls">
                {question.options.length ? <div className="conversation-user-input-options" role="radiogroup"
                  aria-label={t("user_input.choose_answer")}>
                  {question.options.map(option => <Radio key={option.optionId}
                    name={`${record.requestId}:${question.questionId}`} label={option.label}
                    checked={draft?.kind === "option" && draft.optionId === option.optionId}
                    disabled={submitting || accepted}
                    onChange={() => updateDraft(question.questionId, {
                        questionId: question.questionId,
                        kind: "option",
                        optionId: option.optionId,
                      })} />)}
                </div> : null}
                {question.allowFreeText ? <label className="conversation-user-input-free-text">
                  <span>{t(question.options.length ? "user_input.custom_answer" : "user_input.your_answer")}</span>
                  <Textarea rows={3} maxLength={8000} disabled={submitting || accepted}
                    placeholder={t("user_input.answer_placeholder")}
                    value={draft?.kind === "text" ? draft.text : ""}
                    onChange={event => updateDraft(question.questionId, event.target.value
                      ? { questionId: question.questionId, kind: "text", text: event.target.value }
                      : undefined)} />
                </label> : null}
              </div> : question.options.length ? <ul className="conversation-user-input-options conversation-user-input-options-history">
                {question.options.map(option => <li key={option.optionId}>{option.label}</li>)}
              </ul> : null}
            </section>;
          })}
          {record.status === "pending" && cwd ? <form className="conversation-user-input-answer-form"
            data-user-input-answer-form={record.requestId} onSubmit={event => void handleSubmit(event)}>
            {accepted ? <InlineFeedback tone="success">{t("user_input.answer_saved")}</InlineFeedback> : null}
            {failure ? <InlineFeedback tone="danger">{t(failure === "conflict"
              ? "user_input.answer_conflict" : "user_input.answer_failed")}</InlineFeedback> : null}
            {!accepted ? <Button type="submit" size="sm" variant="primary" loading={submitting}
              loadingLabel={t("user_input.submitting_answer")} disabled={!canSubmit}>
              {t(failure ? "user_input.retry_answer" : "user_input.submit_answer")}
            </Button> : null}
          </form> : null}
        </> : record.answers.map((answer, index) =>
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

function createSubmissionId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
