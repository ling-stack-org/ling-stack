import { Bot, Eye, Pencil } from "lucide-react";
import { Button, DialogFooter, EmptyState, Field, InlineFeedback, StatusIndicator, Textarea } from "../../shared/ui/index.js";
import type { AutomationContextPreview, AutomationDraft } from "../../types.js";
import { automationScheduleLabel, automationTargetLabel, type AutomationTranslate } from "./automation-view-models.js";

export function AutomationChatDraftForm({
  busy,
  channels,
  draft,
  error,
  preview,
  prompt,
  t,
  threadTitleById,
  onCancel,
  onConfirm,
  onCreateDraft,
  onPreview,
  onPromptChange,
  onRepair,
}: {
  readonly busy: boolean;
  readonly channels: Parameters<typeof automationTargetLabel>[0]["channels"];
  readonly draft?: AutomationDraft;
  readonly error: string;
  readonly preview?: AutomationContextPreview;
  readonly prompt: string;
  readonly t: AutomationTranslate;
  readonly threadTitleById: ReadonlyMap<string, string>;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
  readonly onCreateDraft: () => void;
  readonly onPreview: () => void;
  readonly onPromptChange: (value: string) => void;
  readonly onRepair: () => void;
}): JSX.Element {
  if (!draft) {
    return (
      <div className="automation-ui2-chat-form">
        {error ? <InlineFeedback title={t("Setup needs attention")} tone="danger">{error}</InlineFeedback> : null}
        <Field label={t("Request")} required>
          <Textarea
            autoFocus
            disabled={busy}
            onChange={(event) => onPromptChange(event.target.value)}
            placeholder={t("Draft a daily brief every morning from recent runs and approvals")}
            rows={9}
            value={prompt}
          />
        </Field>
        <DialogFooter>
          <Button disabled={busy} onClick={onCancel} variant="ghost">{t("Cancel")}</Button>
          <Button disabled={!prompt.trim()} leadingIcon={<Bot size={15} />} loading={busy} loadingLabel={t("Create draft")} onClick={onCreateDraft} variant="primary">
            {t("Create draft")}
          </Button>
        </DialogFooter>
      </div>
    );
  }

  const ready = draft.status === "ready_for_confirmation" && draft.missingFields.length === 0;
  return (
    <div className="automation-ui2-chat-review">
      {error ? <InlineFeedback title={t("Setup needs attention")} tone="danger">{error}</InlineFeedback> : null}
      <div className="automation-ui2-chat-review-header">
        <strong>{draft.title ?? t("Untitled draft")}</strong>
        <StatusIndicator compact label={ready ? t("Draft ready") : t("Setup needs attention")} tone={ready ? "success" : "warning"} />
      </div>
      <dl className="automation-ui2-review-grid">
        <div><dt>{t("Target")}</dt><dd>{automationTargetLabel({ channels, target: draft.target, threadTitleById, t })}</dd></div>
        <div><dt>{t("Schedule")}</dt><dd>{automationScheduleLabel(draft.trigger, t)}</dd></div>
        <div><dt>{t("Prompt")}</dt><dd>{draft.promptTemplate?.promptMarkdown ?? t("Missing")}</dd></div>
        <div><dt>{t("Model")}</dt><dd>{draft.executionPolicy?.providerPresetId ?? t("Select model")}</dd></div>
      </dl>
      {draft.missingFields.length ? (
        <InlineFeedback title={t("Missing")} tone="warning">{draft.missingFields.join(", ")}</InlineFeedback>
      ) : null}
      {draft.warnings.map((warning) => (
        <InlineFeedback key={`${warning.code}:${warning.field ?? ""}`} tone="warning">{warning.message}</InlineFeedback>
      ))}
      {preview ? (
        <section className="automation-ui2-context-preview">
          <strong>{t("Context preview")}</strong>
          <pre>{preview.contextMarkdown || preview.renderedPrompt}</pre>
        </section>
      ) : (
        <EmptyState compact title={t("Context preview")} />
      )}
      <DialogFooter>
        <Button disabled={busy} leadingIcon={<Eye size={15} />} onClick={onPreview} variant="ghost">{t("Context preview")}</Button>
        {!ready ? <Button disabled={busy} leadingIcon={<Pencil size={15} />} onClick={onRepair} variant="secondary">{t("Manual setup")}</Button> : null}
        <Button disabled={!ready} loading={busy} loadingLabel={t("Confirm automation")} onClick={onConfirm} variant="primary">
          {t("Confirm automation")}
        </Button>
      </DialogFooter>
    </div>
  );
}
