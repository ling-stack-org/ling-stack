import { useRef } from "react";
import { FileText, Upload } from "lucide-react";
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  InlineFeedback,
  Spinner,
} from "../../shared/ui/index.js";
import type { SkillImportWarningCode } from "../../types.js";
import { skillImportProblemLabel, type SkillImportForm } from "./skill-import-utils.js";
import type { SettingsTranslator } from "./skill-library-utils.js";
import type { SkillImportBusyState } from "./useSkillImportController.js";

export function SkillImportDialog({
  open,
  form,
  blockingIssues,
  busy,
  error,
  onClose,
  onLoadFile,
  onImport,
  t,
}: {
  readonly open: boolean;
  readonly form: SkillImportForm;
  readonly blockingIssues: readonly SkillImportWarningCode[];
  readonly busy: SkillImportBusyState;
  readonly error: string;
  readonly onClose: () => void;
  readonly onLoadFile: (file: File | undefined) => void;
  readonly onImport: () => void;
  readonly t: SettingsTranslator;
}): JSX.Element {
  const fileInputRef = useRef<HTMLInputElement>(null);
  return (
    <Dialog
      open={open}
      busy={Boolean(busy)}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
    >
      <DialogContent
        className="settings-skill-import-dialog"
        data-ui2-skill-import-dialog=""
        size="sm"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          fileInputRef.current?.focus();
        }}
      >
        <DialogHeader title={t("Import skill")} closeLabel={t("Close import dialog")} />
        <DialogBody className="settings-skill-import-body">
          {error ? <InlineFeedback tone="danger">{error}</InlineFeedback> : null}

          <label className={`settings-skill-file-picker${form.fileName ? " has-file" : ""}${busy ? " is-busy" : ""}`}>
            {form.fileName ? (
              <span className="settings-skill-selected-file">
                <FileText size={18} />
                <span>
                  <strong>{form.fileName}</strong>
                  <small>{t("Choose another file")}</small>
                </span>
              </span>
            ) : (
              <span className="settings-skill-file-empty">
                <Upload size={20} />
                <strong>{t("Select a skill file")}</strong>
                <small>{t("Supports Markdown, JSON, and text files")}</small>
              </span>
            )}
            {busy === "reading" ? (
              <Spinner className="settings-skill-file-picker-loading" label={t("Reading file...")} size="sm" />
            ) : null}
            <input
              data-ling-control-native="true"
              ref={fileInputRef}
              type="file"
              accept=".md,.markdown,.json,.txt,text/markdown,text/plain,application/json"
              aria-label={t("Select a skill file")}
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = "";
                onLoadFile(file);
              }}
              disabled={Boolean(busy)}
            />
          </label>

          {blockingIssues.length > 0 ? (
            <InlineFeedback tone="warning" title={t("This skill cannot be imported yet")}>
              <ul className="settings-skill-import-problems">
                {blockingIssues.map((code) => <li key={code}>{t(skillImportProblemLabel(code))}</li>)}
              </ul>
            </InlineFeedback>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button size="sm" variant="secondary" disabled={Boolean(busy)} onClick={onClose}>
            {t("Cancel")}
          </Button>
          <Button
            size="sm"
            variant="primary"
            leadingIcon={<Upload size={15} />}
            loading={busy === "publishing"}
            loadingLabel={t("Importing...")}
            disabled={!form.fileName || busy === "reading"}
            onClick={onImport}
          >
            {t("Import")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
