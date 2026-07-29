import { useEffect, useState, type KeyboardEvent } from "react";
import { Check, FolderOpen } from "lucide-react";
import { selectWorkspaceDirectory } from "../../api/workspace-directory.js";
import { useI18n } from "../../i18n.js";
import { Field, IconButton, Input } from "../../shared/ui/index.js";

export function ChannelExecutionPathField({
  value,
  pickerCwd,
  disabled,
  forceApply,
  onApply,
}: {
  readonly value: string;
  readonly pickerCwd: string;
  readonly disabled: boolean;
  readonly forceApply: boolean;
  readonly onApply: (path: string) => Promise<void>;
}): JSX.Element {
  const { t } = useI18n();
  const [draftPath, setDraftPath] = useState(value);
  const [busyAction, setBusyAction] = useState<"apply" | "select" | "">("");
  const [errorMessage, setErrorMessage] = useState("");
  const normalizedDraft = draftPath.trim();
  const canApply = Boolean(normalizedDraft) && (forceApply || normalizedDraft !== value.trim());

  useEffect(() => {
    setDraftPath(value);
    setErrorMessage("");
  }, [value]);

  async function applyPath(path: string): Promise<void> {
    const nextPath = path.trim();
    if (!nextPath || busyAction) {
      return;
    }
    setBusyAction("apply");
    setErrorMessage("");
    try {
      await onApply(nextPath);
      setDraftPath(nextPath);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyAction("");
    }
  }

  async function selectDirectory(): Promise<void> {
    if (disabled || busyAction) {
      return;
    }
    setBusyAction("select");
    setErrorMessage("");
    try {
      const result = await selectWorkspaceDirectory(normalizedDraft || value.trim() || pickerCwd.trim());
      if (result.cancelled) {
        return;
      }
      setDraftPath(result.path);
      await onApply(result.path);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyAction("");
    }
  }

  function onInputKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key !== "Enter" || !canApply) {
      return;
    }
    event.preventDefault();
    void applyPath(draftPath);
  }

  return (
    <Field className="channel-path-field" label={t("Execution path")} error={errorMessage || undefined}>
      <Input
        aria-label={t("Execution path")}
        value={draftPath}
        onChange={(event) => {
          setDraftPath(event.target.value);
          setErrorMessage("");
        }}
        onKeyDown={onInputKeyDown}
        disabled={disabled || Boolean(busyAction)}
        invalid={Boolean(errorMessage)}
        suffix={(
          <span className="channel-settings-field-actions">
            <IconButton
              className="channel-settings-field-action"
              icon={FolderOpen}
              label={t("Change directory")}
              loading={busyAction === "select"}
              loadingLabel={t("Change directory")}
              onClick={() => void selectDirectory()}
              disabled={disabled || Boolean(busyAction)}
              size="sm"
            />
            <IconButton
              className="channel-settings-field-action"
              icon={Check}
              label={t("Save")}
              loading={busyAction === "apply"}
              loadingLabel={t("Save")}
              onClick={() => void applyPath(draftPath)}
              disabled={disabled || Boolean(busyAction) || !canApply}
              size="sm"
            />
          </span>
        )}
      />
    </Field>
  );
}
