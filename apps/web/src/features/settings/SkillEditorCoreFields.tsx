import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { Button, Field, IconButton, Input, Textarea } from "../../shared/ui/index.js";
import type { SkillEditorForm } from "./skill-editor-utils.js";
import type { SettingsTranslator } from "./skill-library-utils.js";

export function SkillEditorCoreFields({
  form,
  busy,
  onFormChange,
  t,
}: {
  readonly form: SkillEditorForm;
  readonly busy: boolean;
  readonly onFormChange: (form: SkillEditorForm) => void;
  readonly t: SettingsTranslator;
}): React.JSX.Element {
  return (
    <>
      <section className="settings-skill-editor-section" aria-labelledby="skill-editor-basic-title">
        <header><strong id="skill-editor-basic-title">{t("Basic information")}</strong></header>
        <div className="settings-skill-editor-fields">
          <Field label={t("Skill name")} required>
            <Input
              autoFocus
              value={form.name}
              onChange={(event) => onFormChange({ ...form, name: event.currentTarget.value })}
              disabled={busy}
              maxLength={160}
            />
          </Field>
          <Field label={t("Skill description")} required>
            <Textarea
              rows={3}
              value={form.summary}
              onChange={(event) => onFormChange({ ...form, summary: event.currentTarget.value })}
              disabled={busy}
            />
          </Field>
        </div>
      </section>

      <section className="settings-skill-editor-section" aria-labelledby="skill-editor-instructions-title">
        <header className="settings-skill-editor-section-head">
          <strong id="skill-editor-instructions-title">{t("Execution instructions")}</strong>
          <Button
            size="sm"
            variant="secondary"
            leadingIcon={<Plus size={14} />}
            onClick={() => onFormChange({ ...form, promptFragments: [...form.promptFragments, ""] })}
            disabled={busy}
          >
            {t("Add instruction")}
          </Button>
        </header>
        <div className="settings-skill-instruction-list">
          {form.promptFragments.map((fragment, index) => (
            <article className="settings-skill-instruction-row" key={index}>
              <div className="settings-skill-instruction-order" aria-label={t("Instruction order")}>
                <IconButton
                  icon={ArrowUp}
                  label={t("Move instruction up")}
                  tooltip={t("Move up")}
                  size="sm"
                  onClick={() => onFormChange({
                    ...form,
                    promptFragments: moveItem(form.promptFragments, index, index - 1),
                  })}
                  disabled={busy || index === 0}
                />
                <IconButton
                  icon={ArrowDown}
                  label={t("Move instruction down")}
                  tooltip={t("Move down")}
                  size="sm"
                  onClick={() => onFormChange({
                    ...form,
                    promptFragments: moveItem(form.promptFragments, index, index + 1),
                  })}
                  disabled={busy || index === form.promptFragments.length - 1}
                />
              </div>
              <Field label={t("Instruction {index}", { index: index + 1 })} required>
                <Textarea
                  rows={5}
                  value={fragment}
                  onChange={(event) => onFormChange({
                    ...form,
                    promptFragments: replaceItem(form.promptFragments, index, event.currentTarget.value),
                  })}
                  disabled={busy}
                />
              </Field>
              <IconButton
                className="settings-skill-instruction-remove"
                icon={Trash2}
                label={t("Remove instruction")}
                tooltip={t("Remove")}
                size="sm"
                variant="danger"
                onClick={() => onFormChange({
                  ...form,
                  promptFragments: form.promptFragments.length === 1
                    ? [""]
                    : form.promptFragments.filter((_, itemIndex) => itemIndex !== index),
                })}
                disabled={busy}
              />
            </article>
          ))}
        </div>
      </section>
    </>
  );
}

function replaceItem(values: readonly string[], index: number, value: string): string[] {
  return values.map((item, itemIndex) => itemIndex === index ? value : item);
}

function moveItem(values: readonly string[], from: number, to: number): string[] {
  if (to < 0 || to >= values.length) return [...values];
  const next = [...values];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}
