import { useMemo, useRef, useState, type ReactNode } from "react";
import { Copy, UserRound } from "lucide-react";
import { MessageActionBar } from "@ling-stack/conversation-ui-react";
import {
  conversationTimelineRendererKey,
  type ConversationInteractionSurfaceKind, type ConversationTimelineScopeKind,
  type ConversationTimelineUserInputItem,
} from "@ling-stack/conversation-ui-core";
import { useI18n } from "../../../i18n.js";
import { Button, InlineFeedback, Radio, Textarea } from "../../ui/index.js";
import { MessageRow } from "../blocks/MessageRow.js";
import { MessageBodyRenderer } from "../blocks/MessageBodyRenderer.js";
import { LocalFileLink } from "../blocks/LocalFileLink.js";
import { userInputHistoryPresentation } from "./user-input-history-presentation.js";
import type { UserInputAnswerAcceptedResponseV1, UserInputAnswerCommandV1, UserInputAnswerV1 } from "../../../types.js";

const surfaces: Record<ConversationTimelineScopeKind, ConversationInteractionSurfaceKind> = {
  normal: "normal_conversation", private: "teammate_direct", channel_root: "channel_root",
  topic: "topic_reply", branch: "channel_branch", run_detail: "run_thread", child: "run_thread",
};

/** Shared question/answer history. Only current Host authority enables the answer form. */
export function ConversationTimelineUserInputRenderer({ item, depth, cwd, scopeKind = "normal", renderAvatar, onSubmitAnswer }: {
  readonly item: ConversationTimelineUserInputItem;
  readonly depth: 0 | 1;
  readonly cwd?: string;
  readonly scopeKind?: ConversationTimelineScopeKind;
  readonly renderAvatar?: (item: ConversationTimelineUserInputItem) => ReactNode;
  readonly onSubmitAnswer?: (command: UserInputAnswerCommandV1) => Promise<UserInputAnswerAcceptedResponseV1>;
}): React.JSX.Element {
  const { t } = useI18n();
  const presentation = userInputHistoryPresentation(item);
  const own = item.kind === "userInputAnswer";
  const surface = surfaces[scopeKind];
  const record = item.userInput;
  const answerable = record.availability === "available" && record.kind === "user_input_request"
    && record.status === "pending" && record.answerAuthority && onSubmitAnswer;
  const currentAuthorityToken = record.availability === "available" && record.kind === "user_input_request"
    && record.status === "pending" ? record.answerAuthority?.token : undefined;
  const [acceptedAuthorityToken, setAcceptedAuthorityToken] = useState<string>();
  const locallyAccepted = Boolean(currentAuthorityToken && acceptedAuthorityToken === currentAuthorityToken);
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
      statusNode={<span className="conversation-user-input-status" data-tone={presentation.tone}
        role="status" aria-live="polite" aria-atomic="true">
        {t(locallyAccepted ? "user_input.delivery.pending" : presentation.labelKey)}
      </span>}
      bodyNode={record.availability === "unavailable" ? null : <div className="conversation-user-input-content">
        {record.kind === "user_input_request" ? answerable && !locallyAccepted ? <UserInputAnswerForm
          key={currentAuthorityToken}
          request={record}
          onSubmit={onSubmitAnswer}
          onAccepted={() => setAcceptedAuthorityToken(record.answerAuthority!.token)}
          renderBody={body}
        /> : record.questions.map((question, index) =>
          <section key={question.questionId} aria-label={t("user_input.question_number", { number: index + 1 })}>
            {body(question.prompt)}
            {question.options.length ? <ul className="conversation-user-input-options conversation-user-input-options-history">
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

type AnswerDrafts = Readonly<Record<string, UserInputAnswerV1 | undefined>>;

function UserInputAnswerForm({ request, onSubmit, onAccepted, renderBody }: {
  readonly request: Extract<ConversationTimelineUserInputItem["userInput"], { kind: "user_input_request" }>;
  readonly onSubmit: (command: UserInputAnswerCommandV1) => Promise<UserInputAnswerAcceptedResponseV1>;
  readonly onAccepted: () => void;
  readonly renderBody: (text: string) => ReactNode;
}): React.JSX.Element {
  const { t } = useI18n();
  const [drafts, setDrafts] = useState<AnswerDrafts>({});
  const [submitting, setSubmitting] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [failed, setFailed] = useState(false);
  const inFlightRef = useRef(false);
  const idempotencyRef = useRef<{ readonly fingerprint: string; readonly key: string } | undefined>(undefined);
  const answers = useMemo<readonly UserInputAnswerV1[]>(() => request.questions.flatMap((question) => {
    const draft = drafts[question.questionId];
    if (!draft || (draft.kind === "text" && !draft.text.trim())) return [];
    return [draft.kind === "text" ? { ...draft, text: draft.text.trim() } : draft];
  }), [drafts, request.questions]);
  const answered = new Set(answers.map(answer => answer.questionId));
  const valid = answers.length > 0 && request.questions.every(question => !question.required || answered.has(question.questionId));

  const update = (questionId: string, answer: UserInputAnswerV1 | undefined): void => {
    setDrafts(current => ({ ...current, [questionId]: answer }));
    setFailed(false);
  };
  const submit = async (): Promise<void> => {
    if (!valid || accepted || inFlightRef.current || !request.answerAuthority) return;
    const fingerprint = JSON.stringify(answers);
    const previous = idempotencyRef.current;
    const idempotencyKey = previous?.fingerprint === fingerprint
      ? previous.key
      : `answer:${request.requestId}:${request.requestVersion}:${createSubmissionId()}`;
    idempotencyRef.current = { fingerprint, key: idempotencyKey };
    inFlightRef.current = true;
    setSubmitting(true);
    setFailed(false);
    try {
      const response = await onSubmit({ schemaVersion: 1, authority: request.answerAuthority, idempotencyKey, answers });
      if (!response.accepted || response.delivery.status !== "pending") throw new Error("answer_not_accepted");
      setAccepted(true);
      onAccepted();
    } catch {
      setFailed(true);
    } finally {
      inFlightRef.current = false;
      setSubmitting(false);
    }
  };

  return <form className="conversation-user-input-form" data-user-input-answer-form={request.requestId}
    onSubmit={(event) => { event.preventDefault(); void submit(); }}>
    {request.questions.map((question, index) => {
      const draft = drafts[question.questionId];
      return <fieldset key={question.questionId} className="conversation-user-input-fieldset">
        <legend>{t("user_input.question_number", { number: index + 1 })}{question.required ? ` · ${t("Required")}` : ` · ${t("Optional")}`}</legend>
        {renderBody(question.prompt)}
        <div className="conversation-user-input-question-controls">
          {question.options.length ? <div className="conversation-user-input-options" role="radiogroup"
            aria-label={t("user_input.choose_answer")}>
            {question.options.map(option => <Radio key={option.optionId}
              name={`answer:${request.requestId}:${question.questionId}`} label={option.label}
              checked={draft?.kind === "option" && draft.optionId === option.optionId}
              disabled={submitting || accepted}
              onChange={() => update(question.questionId, {
                questionId: question.questionId,
                kind: "option",
                optionId: option.optionId,
              })} />)}
          </div> : null}
          {question.allowFreeText ? <label className="conversation-user-input-free-text">
            <span>{t(question.options.length ? "user_input.custom_answer" : "user_input.your_answer")}</span>
            <Textarea rows={3} maxLength={8000} disabled={submitting || accepted}
              aria-label={question.prompt}
              placeholder={t("user_input.answer_placeholder")}
              value={draft?.kind === "text" ? draft.text : ""}
              onChange={(event) => update(question.questionId, event.currentTarget.value
                ? { questionId: question.questionId, kind: "text", text: event.currentTarget.value }
                : undefined)} />
          </label> : null}
        </div>
      </fieldset>;
    })}
    <div className="conversation-user-input-answer-form">
      {failed ? <InlineFeedback tone="danger">{t("user_input.answer_failed")}</InlineFeedback> : null}
      <Button type="submit" size="sm" variant="primary" disabled={!valid || accepted}
        loading={submitting} loadingLabel={t("user_input.submitting_answer")}
        title={failed ? t("Retry") : t("Send")}>
        {t(failed ? "user_input.retry_answer" : "user_input.submit_answer")}
      </Button>
    </div>
  </form>;
}

function createSubmissionId(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
