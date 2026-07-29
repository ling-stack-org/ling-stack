import { Check, Search } from "lucide-react";
import { useI18n } from "../../i18n.js";
import {
  Button,
  DataRow,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Field,
  InlineFeedback,
  Input,
  Select,
  StatusIndicator,
  Textarea,
} from "../../shared/ui/index.js";
import type { SkillImportDraft, SkillPackSource } from "../../types.js";
import type { SkillImportForm } from "./teammate-skills-controller-types.js";
import { importDraftHasErrors } from "./teammate-skills-view-models.js";

export function TeammateSkillImportDialog({
  draft,
  error,
  form,
  mutationKey,
  open,
  onFormChange,
  onOpenChange,
  onPreview,
  onPublish,
}: {
  readonly draft: SkillImportDraft | undefined;
  readonly error: string;
  readonly form: SkillImportForm;
  readonly mutationKey: string;
  readonly open: boolean;
  readonly onFormChange: (form: SkillImportForm) => void;
  readonly onOpenChange: (open: boolean) => void;
  readonly onPreview: () => void | Promise<void>;
  readonly onPublish: () => void | Promise<void>;
}): JSX.Element {
  const { t } = useI18n();
  const previewing = mutationKey === "import:preview";
  const publishing = mutationKey === "import:publish";
  const busy = previewing || publishing;
  const hasErrors = draft ? importDraftHasErrors(draft) : false;
  const warnings = draft
    ? [...draft.warnings, ...draft.definitions.flatMap((item) => item.warnings ?? [])]
    : [];

  return (
    <Dialog busy={busy} open={open} onOpenChange={onOpenChange}>
      <DialogContent className="teammate-skill-import-dialog" size="lg">
        <DialogHeader closeLabel={t("Close")} title={t("Import skill")} />
        <DialogBody>
          {error ? <InlineFeedback tone="danger">{error}</InlineFeedback> : null}
          <div className="teammate-skill-import-fields">
            <Field label={t("Source")}>
              <Select
                disabled={busy}
                value={form.source}
                onChange={(event) => onFormChange({ ...form, source: event.target.value as SkillPackSource })}
              >
                <option value="custom">{t("custom")}</option>
                <option value="skill-directory">{t("skill-directory")}</option>
                <option value="agents-md">{t("agents-md")}</option>
                <option value="workspace">{t("workspace")}</option>
              </Select>
            </Field>
            <Field label={t("Draft name")}>
              <Input disabled={busy} value={form.name} onChange={(event) => onFormChange({ ...form, name: event.target.value })} />
            </Field>
            <Field className="teammate-skill-import-path" label={t("Source path")}>
              <Input
                disabled={busy}
                value={form.sourcePath}
                placeholder="SKILL.md"
                onChange={(event) => onFormChange({ ...form, sourcePath: event.target.value })}
              />
            </Field>
            <Field className="teammate-skill-import-content" label={t("Skill content")}>
              <Textarea
                disabled={busy}
                rows={9}
                value={form.content}
                onChange={(event) => onFormChange({ ...form, content: event.target.value })}
              />
            </Field>
          </div>

          {draft ? (
            <section className="teammate-skill-import-preview" aria-label={t("Import check summary")}>
              <div className="teammate-skill-import-preview-heading">
                <h3>{t("Import check summary")}</h3>
                <StatusIndicator
                  compact
                  label={hasErrors ? t("Import contains blocking issues") : t("Draft ready")}
                  tone={hasErrors ? "danger" : warnings.length > 0 ? "warning" : "success"}
                />
              </div>
              <div className="teammate-skill-import-definitions">
                {draft.definitions.map((item) => {
                  const blocked = item.warnings?.some((warning) => warning.severity === "error") ?? false;
                  return (
                    <DataRow
                      key={item.definition.id}
                      compact
                      identity={(
                        <span className="teammate-skill-import-definition-identity">
                          <strong>{item.definition.name}</strong>
                          <small>{item.definition.id}</small>
                        </span>
                      )}
                      status={<StatusIndicator compact label={blocked ? t("Needs fixes") : t("Draft")} tone={blocked ? "danger" : "neutral"} />}
                      summary={<span title={item.definition.summary}>{item.definition.summary}</span>}
                    />
                  );
                })}
              </div>
              {warnings.length > 0 ? (
                <div className="teammate-skill-import-warnings">
                  {warnings.map((warning, index) => (
                    <InlineFeedback
                      key={`${warning.code}-${index}`}
                      tone={warning.severity === "error" ? "danger" : "warning"}
                    >
                      {t(warning.code)}: {warning.message}
                    </InlineFeedback>
                  ))}
                </div>
              ) : null}
            </section>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>{t("Cancel")}</Button>
          <Button
            leadingIcon={<Search />}
            loading={previewing}
            loadingLabel={t("Checking...")}
            onClick={() => void onPreview()}
            disabled={busy || !form.content.trim()}
          >
            {t("Preview draft")}
          </Button>
          <Button
            leadingIcon={<Check />}
            loading={publishing}
            loadingLabel={t("Publishing...")}
            variant="primary"
            onClick={() => void onPublish()}
            disabled={busy || !draft || hasErrors}
          >
            {t("Publish to registry")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
