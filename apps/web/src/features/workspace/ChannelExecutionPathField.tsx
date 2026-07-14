import { useEffect, useId, useState, type KeyboardEvent } from "react";
import { Check, FolderOpen, Loader2 } from "lucide-react";
import { selectWorkspaceDirectory } from "../../api/workspace-directory.js";
import { useI18n } from "../../i18n.js";

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
  const inputId = useId();
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
    <div className="field channel-path-field">
      <span><label htmlFor={inputId}>{t("Execution path")}</label></span>
      <span className="channel-execution-path-control">
        <input
          id={inputId}
          aria-label={t("Execution path")}
          aria-invalid={Boolean(errorMessage)}
          value={draftPath}
          onChange={(event) => {
            setDraftPath(event.target.value);
            setErrorMessage("");
          }}
          onKeyDown={onInputKeyDown}
          disabled={disabled || Boolean(busyAction)}
        />
        <button
          className="icon-button channel-execution-path-action"
          type="button"
          aria-label={t("Change directory")}
          title={t("Change directory")}
          onClick={() => void selectDirectory()}
          disabled={disabled || Boolean(busyAction)}
        >
          {busyAction === "select" ? <Loader2 className="spin" size={15} /> : <FolderOpen size={15} />}
        </button>
        <button
          className="icon-button channel-execution-path-action"
          type="button"
          aria-label={t("Save")}
          title={t("Save")}
          onClick={() => void applyPath(draftPath)}
          disabled={disabled || Boolean(busyAction) || !canApply}
        >
          {busyAction === "apply" ? <Loader2 className="spin" size={15} /> : <Check size={15} />}
        </button>
      </span>
      {errorMessage ? <small className="channel-execution-path-error danger-text" role="alert">{errorMessage}</small> : null}
    </div>
  );
}
