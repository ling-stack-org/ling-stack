import { Check, FileText, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
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
  SegmentedControl,
  SegmentedControlItem,
  StatusIndicator,
  Textarea,
} from "../../shared/ui/index.js";
import type { TeammatePersonaDraft } from "../../types.js";
import type { PersonaImportForm } from "./useTeammateProfileController.js";

type PersonaInputMode = "file" | "paste";

export function TeammatePersonaImportDialog({
  busyAction,
  draft,
  error,
  form,
  open,
  onApply,
  onFormChange,
  onOpenChange,
  onPreview,
}: {
  readonly busyAction: "" | "apply" | "preview";
  readonly draft?: TeammatePersonaDraft;
  readonly error: string;
  readonly form: PersonaImportForm;
  readonly open: boolean;
  readonly onApply: () => Promise<boolean>;
  readonly onFormChange: (form: PersonaImportForm) => void;
  readonly onOpenChange: (open: boolean) => void;
  readonly onPreview: () => void | Promise<void>;
}): React.JSX.Element {
  const { t } = useI18n();
  const busy = Boolean(busyAction);
  const [mode, setMode] = useState<PersonaInputMode>("file");
  const [fileForm, setFileForm] = useState<PersonaImportForm>({ sourcePath: "", content: "" });
  const [pastedContent, setPastedContent] = useState("");
  const [fileError, setFileError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) return;
    setMode("file");
    setFileForm({ sourcePath: "", content: "" });
    setPastedContent("");
    setFileError("");
  }, [open]);

  function changeMode(nextMode: PersonaInputMode): void {
    setMode(nextMode);
    setFileError("");
    onFormChange(nextMode === "file"
      ? fileForm
      : { sourcePath: "", content: pastedContent });
  }

  async function loadFile(file?: File): Promise<void> {
    if (!file || busy) return;
    const normalizedName = file.name.trim();
    if (!/\.(?:md|markdown|txt)$/iu.test(normalizedName)) {
      setFileError(t("Choose a Markdown or text file"));
      return;
    }
    try {
      const content = await file.text();
      if (!content.trim()) {
        setFileError(t("The selected file is empty"));
        return;
      }
      const nextForm = { sourcePath: normalizedName, content };
      setFileForm(nextForm);
      setFileError("");
      onFormChange(nextForm);
    } catch {
      setFileError(t("The file could not be read. Choose another file."));
    }
  }

  return (
    <Dialog busy={busy} open={open} onOpenChange={onOpenChange}>
      <DialogContent className="teammate-persona-import-dialog" size="md" aria-label={t("Import role profile")}>
        <DialogHeader title={t("Import role profile")} closeLabel={t("Close")} />
        <DialogBody className="teammate-persona-import-body">
          {error || fileError ? <InlineFeedback tone="danger">{fileError || error}</InlineFeedback> : null}

          <SegmentedControl
            aria-label={t("Role profile input")}
            className="teammate-persona-import-mode"
            size="sm"
            value={mode}
            onValueChange={(value) => changeMode(value as PersonaInputMode)}
          >
            <SegmentedControlItem value="file">{t("Select file")}</SegmentedControlItem>
            <SegmentedControlItem value="paste">{t("Paste content")}</SegmentedControlItem>
          </SegmentedControl>

          {mode === "file" ? (
            <label className={`teammate-persona-file-picker${form.sourcePath ? " has-file" : ""}`}>
              <span>
                {form.sourcePath ? <FileText aria-hidden="true" /> : <Upload aria-hidden="true" />}
                <strong>{form.sourcePath || t("Choose AGENTS.md or Markdown")}</strong>
              </span>
              <input
                data-ling-control-native="true"
                ref={fileInputRef}
                type="file"
                accept=".md,.markdown,.txt,text/markdown,text/plain"
                aria-label={t("Choose role profile file")}
                disabled={busy}
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  event.currentTarget.value = "";
                  void loadFile(file);
                }}
              />
            </label>
          ) : (
            <Field label={t("Role profile content")}>
              <Textarea
                rows={10}
                value={form.content}
                disabled={busy}
                placeholder={t("Paste role profile content")}
                onChange={(event) => {
                  const content = event.target.value;
                  setPastedContent(content);
                  onFormChange({ sourcePath: "", content });
                }}
              />
            </Field>
          )}

          {draft ? (
            <div className="teammate-persona-preview" aria-label={t("Role profile preview")}>
              <DataRow
                compact
                className="teammate-persona-preview-row"
                identity={<strong>{draft.displayName}</strong>}
                summary={<span>{draft.description}</span>}
                status={<StatusIndicator compact label={t(draft.sourceKind)} tone="neutral" />}
              />
              {draft.warnings.map((warning, index) => (
                <InlineFeedback key={`${warning}-${index}`} tone="warning">{warning}</InlineFeedback>
              ))}
            </div>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => onOpenChange(false)}>
            {t("Cancel")}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={busy || !form.content.trim()}
            loading={busyAction === "preview"}
            onClick={() => void onPreview()}
          >
            {t("Check content")}
          </Button>
          <Button
            size="sm"
            variant="primary"
            leadingIcon={<Check />}
            disabled={busy || !draft}
            loading={busyAction === "apply"}
            onClick={() => {
              void onApply().then((applied) => {
                if (applied) onOpenChange(false);
              });
            }}
          >
            {t("Apply to profile")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
