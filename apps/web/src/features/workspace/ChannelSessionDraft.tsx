import { useId } from "react";
import { useI18n } from "../../i18n.js";
import { InlineFeedback, Input } from "../../shared/ui/index.js";

export interface ChannelSessionDraftProps {
  readonly title: string;
  readonly creating: boolean;
  readonly creationUnconfirmed: boolean;
  readonly onRename: (title: string) => void;
}

export function ChannelSessionDraft({ title, creating, creationUnconfirmed, onRename }: ChannelSessionDraftProps): React.JSX.Element {
  const { t } = useI18n();
  const id = useId();
  const invalid = [...title.trim()].length > 120;
  return <section className="channel-session-draft" aria-labelledby={`${id}-heading`}>
    <h2 id={`${id}-heading`}>{t("Start a new conversation")}</h2>
    <p>{t("This conversation shares channel settings and resources, with its own message history.")}</p>
    <label htmlFor={`${id}-name`}>{t("Conversation name (optional)")}</label>
    <Input id={`${id}-name`} value={title} disabled={creating || creationUnconfirmed} invalid={invalid}
      aria-describedby={invalid ? `${id}-error` : undefined} onChange={event => onRename(event.target.value)}
      placeholder={t("Leave empty to name it from your first message")} />
    {invalid ? <InlineFeedback id={`${id}-error`} tone="danger">{t("Use 120 characters or fewer for the conversation name.")}</InlineFeedback> : null}
    {creating ? <p role="status">{t("Creating conversation...")}</p> : null}
    {creationUnconfirmed && !creating ? <InlineFeedback tone="warning">{t("Conversation creation is unconfirmed. Send again to check using the same request.")}</InlineFeedback> : null}
  </section>;
}
