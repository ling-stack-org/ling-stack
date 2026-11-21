import { useEffect, useState } from "react";
import { Check, ExternalLink, Send } from "lucide-react";
import type {
  CompanionAttentionItem,
  CompanionAttentionSource,
  CompanionAttentionUserInputPayload,
  UserInputAnswerV1,
} from "../../types.js";
import { Button, IconButton, Textarea } from "../../shared/ui/index.js";

export type CompanionAnswerDraft = Extract<UserInputAnswerV1, { readonly questionId: string }>;

export function CompanionAttentionCard({
  item,
  pendingCount,
  onAdvance,
  submitting,
  notice,
  onOpenSource,
  onApprove,
  onDeny,
  onDismiss,
  onSubmitQuestion,
  t,
}: {
  readonly item: CompanionAttentionItem;
  readonly pendingCount: number;
  readonly onAdvance: () => void;
  readonly submitting?: boolean;
  readonly notice?: string;
  readonly onOpenSource: (source: CompanionAttentionSource) => void;
  readonly onApprove: () => void;
  readonly onDeny: () => void;
  readonly onDismiss: () => void;
  readonly onSubmitQuestion: (payload: CompanionAttentionUserInputPayload, answers: readonly CompanionAnswerDraft[]) => void;
  readonly t: (key: string) => string;
}): React.JSX.Element {
  const payload = item.payload;
  const [drafts, setDrafts] = useState<Readonly<Record<string, CompanionAnswerDraft>>>({});
  const [freeTextQuestions, setFreeTextQuestions] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    if (payload.kind !== "user_input") return;
    const saved = readDraft(item, payload);
    setDrafts(saved);
    setFreeTextQuestions(new Set(payload.questions.filter((question) => question.options.length === 0).map((question) => question.questionId)));
  }, [item.source.kind, item.source.id, item.source.revision, payload.kind,
    payload.kind === "user_input" ? payload.requestId : "",
    payload.kind === "user_input" ? payload.requestVersion : 0]);

  useEffect(() => {
    if (payload.kind === "user_input") writeDraft(item, drafts);
  }, [drafts, item, payload]);

  const answerable = payload.kind === "user_input"
    && Boolean(payload.answerAuthority)
    && payload.questions.every((question) => !question.required || isCompleteAnswer(drafts[question.questionId]));

  return (
    <section className="companion-attention-card" aria-live="polite">
      <header className="companion-attention-header">
        <div>
          <span className="companion-attention-kicker">{attentionLabel(item.priority, t)}</span>
          {item.actor?.label ? <span className="companion-attention-actor">{item.actor.label}</span> : null}
          <strong>{item.title}</strong>
        </div>
        <div className="companion-attention-header-actions">
          {pendingCount > 1 ? <button type="button" className="companion-attention-count" aria-label={t("Pending items")} onClick={onAdvance}>{pendingCount}</button> : null}
          <IconButton label={t("Open source")} icon={ExternalLink} size="sm" onClick={() => onOpenSource(item.source)} />
        </div>
      </header>
      <p className="companion-attention-summary">{item.summary}</p>
      <p className="companion-attention-source">{sourceLabel(item.source, t)}</p>
      {attentionDetail(payload, t) ? <p className="companion-attention-detail">{attentionDetail(payload, t)}</p> : null}
      {payload.kind === "user_input" ? (
        <div className="companion-question-list">
          {payload.questions.map((question) => {
            const draft = drafts[question.questionId];
            const freeText = freeTextQuestions.has(question.questionId);
            return (
              <div className="companion-question" key={question.questionId}>
                <strong>{question.prompt}</strong>
                {question.options.length > 0 && !freeText ? (
                  <div className="companion-question-options">
                    {question.options.map((option) => (
                      <button
                        key={option.optionId}
                        type="button"
                        className={"companion-question-option" + (draft?.kind === "option" && draft.optionId === option.optionId ? " selected" : "")}
                        onClick={() => setDrafts((current) => ({ ...current, [question.questionId]: { questionId: question.questionId, kind: "option", optionId: option.optionId } }))}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                ) : null}
                {question.allowFreeText && freeText ? (
                  <Textarea
                    aria-label={question.prompt}
                    autoFocus={freeText}
                    rows={2}
                    value={draft?.kind === "text" ? draft.text : ""}
                    onChange={(event) => setDrafts((current) => ({ ...current, [question.questionId]: { questionId: question.questionId, kind: "text", text: event.target.value } }))}
                    placeholder={t("Type your answer")}
                  />
                ) : null}
                {question.allowFreeText && question.options.length > 0 ? (
                  <Button size="sm" variant="ghost" onClick={() => setFreeTextQuestions((current) => {
                    const next = new Set(current);
                    if (next.has(question.questionId)) next.delete(question.questionId);
                    else next.add(question.questionId);
                    return next;
                  })}>
                    {freeText ? t("Choose an option") : t("Answer with text")}
                  </Button>
                ) : null}
              </div>
            );
          })}
          <div className="companion-attention-actions">
            <Button
              size="sm"
              variant="primary"
              leadingIcon={<Send />}
              disabled={!answerable || submitting}
              loading={submitting}
              onClick={() => onSubmitQuestion(payload, Object.values(drafts))}
            >
              {t("Submit answer")}
            </Button>
          </div>
        </div>
      ) : null}
      {payload.kind === "approval" ? (
        <div className="companion-attention-actions">
          <Button size="sm" variant="primary" leadingIcon={<Check />} disabled={submitting} loading={submitting} onClick={onApprove}>{t("Approve")}</Button>
          <Button size="sm" variant="ghost" disabled={submitting} onClick={onDeny}>{t("Deny")}</Button>
        </div>
      ) : null}
      {payload.kind !== "user_input" && payload.kind !== "approval" ? (
        <div className="companion-attention-actions">
          <Button size="sm" variant="ghost" leadingIcon={<ExternalLink />} onClick={() => onOpenSource(item.source)}>{t("Open work")}</Button>
          {item.priority === "result" ? <Button size="sm" variant="ghost" onClick={onDismiss}>{t("Dismiss")}</Button> : null}
        </div>
      ) : null}
      {notice ? <p className="companion-attention-notice" role="status">{notice}</p> : null}
    </section>
  );
}

function attentionLabel(priority: CompanionAttentionItem["priority"], t: (key: string) => string): string {
  switch (priority) {
    case "required_input": return t("Needs your answer");
    case "approval": return t("Needs approval");
    case "optional_input": return t("Question");
    case "blocker": return t("Blocked");
    case "handoff": return t("Handoff");
    case "result": return t("Completed");
    default: return t("In progress");
  }
}

function sourceLabel(source: CompanionAttentionSource, t: (key: string) => string): string {
  const sourceKind = source.kind.replaceAll("_", " ");
  const location = source.channelId ? `${t("Channel")} ${source.channelId}` : source.threadId ? `${t("Thread")} ${source.threadId}` : "";
  return location ? `${sourceKind} · ${location}` : sourceKind;
}

function attentionDetail(
  payload: CompanionAttentionItem["payload"],
  t: (key: string) => string,
): string {
  if (payload.kind === "blocker") return payload.nextAction ?? "";
  if (payload.kind === "handoff") {
    const participants = [payload.fromParticipant, payload.toParticipant].filter(Boolean).join(` ${t("to")} `);
    return [participants, payload.requestedOutput].filter(Boolean).join(" · ");
  }
  if (payload.kind === "terminal_report") return payload.verificationSummary ?? "";
  if (payload.kind === "progress") return payload.phase ? `${t("Phase")} ${payload.phase}` : "";
  if (payload.kind === "approval" && payload.expiresAt) return `${t("Expires")} ${payload.expiresAt}`;
  return "";
}

function isCompleteAnswer(answer: CompanionAnswerDraft | undefined): boolean {
  if (!answer) return false;
  return answer.kind !== "text" || answer.text.trim().length > 0;
}

function readDraft(item: CompanionAttentionItem, payload: CompanionAttentionUserInputPayload): Readonly<Record<string, CompanionAnswerDraft>> {
  try {
    const value = window.localStorage.getItem(draftKey(item, payload));
    if (!value) return {};
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Readonly<Record<string, CompanionAnswerDraft>>
      : {};
  } catch {
    return {};
  }
}

function writeDraft(item: CompanionAttentionItem, drafts: Readonly<Record<string, CompanionAnswerDraft>>): void {
  try {
    window.localStorage.setItem(draftKey(item, item.payload as CompanionAttentionUserInputPayload), JSON.stringify(drafts));
  } catch {
    // Storage is optional in sandboxed or private browser contexts.
  }
}

function draftKey(item: CompanionAttentionItem, payload: CompanionAttentionUserInputPayload): string {
  return "companion-answer-draft:" + item.source.cwd + ":" + payload.requestId + ":" + payload.requestVersion;
}
