import { FileCheck2 } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { Button, Field, Textarea } from "../../shared/ui/index.js";

export interface ChannelBriefDraft {
  readonly objective: string;
  readonly scope: string;
  readonly acceptanceCriteria: string;
  readonly openQuestions: string;
  readonly risks: string;
}

export function ChannelBriefEditor({
  draft,
  onDraftChange,
  onSave,
}: {
  readonly draft: ChannelBriefDraft;
  readonly onDraftChange: (draft: ChannelBriefDraft) => void;
  readonly onSave: () => void;
}): JSX.Element {
  const { t } = useI18n();

  return (
    <section className="channel-brief-editor" role="group" aria-label={t("Brief")}>
      <Field label={t("Objective")}>
        <Textarea
          rows={2}
          value={draft.objective}
          onChange={(event) => onDraftChange({ ...draft, objective: event.target.value })}
        />
      </Field>
      <Field label={t("Scope")}>
        <Textarea
          rows={2}
          value={draft.scope}
          onChange={(event) => onDraftChange({ ...draft, scope: event.target.value })}
        />
      </Field>
      <Field label={t("Acceptance criteria")}>
        <Textarea
          rows={3}
          value={draft.acceptanceCriteria}
          onChange={(event) => onDraftChange({ ...draft, acceptanceCriteria: event.target.value })}
        />
      </Field>
      <Field label={t("Open questions")}>
        <Textarea
          rows={2}
          value={draft.openQuestions}
          onChange={(event) => onDraftChange({ ...draft, openQuestions: event.target.value })}
        />
      </Field>
      <Field label={t("Risks")}>
        <Textarea
          rows={2}
          value={draft.risks}
          onChange={(event) => onDraftChange({ ...draft, risks: event.target.value })}
        />
      </Field>
      <div className="channel-brief-editor-actions">
        <Button
          leadingIcon={<FileCheck2 />}
          size="sm"
          type="button"
          variant="primary"
          onClick={onSave}
        >
          {t("Save brief")}
        </Button>
      </div>
    </section>
  );
}
