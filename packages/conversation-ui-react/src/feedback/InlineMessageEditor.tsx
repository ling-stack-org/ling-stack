import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Check, Loader2, X } from "lucide-react";
import { parseComposerInputParts } from "@ling-stack/conversation-ui-core";
import { TokenizedComposerInput, type TokenizedComposerInputHandle } from "../composer/TokenizedComposerInput.js";

export interface InlineMessageEditorProps {
  readonly initialValue: string;
  readonly cwd?: string;
  readonly ariaLabel: string;
  readonly saveLabel: string;
  readonly cancelLabel: string;
  readonly warning?: string;
  readonly saving?: boolean;
  readonly onSave: (value: string) => void | Promise<void>;
  readonly onCancel: () => void;
}

export function InlineMessageEditor({
  initialValue,
  cwd,
  ariaLabel,
  saveLabel,
  cancelLabel,
  warning,
  saving = false,
  onSave,
  onCancel,
}: InlineMessageEditorProps): React.JSX.Element {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<TokenizedComposerInputHandle | null>(null);
  const parts = useMemo(() => parseComposerInputParts(value, { cwd, deferTrailingAtomicTokens: true }), [cwd, value]);
  const canSave = Boolean(value.trim()) && value.trim() !== initialValue.trim() && !saving;

  useEffect(() => {
    inputRef.current?.focusAt(initialValue.length);
  }, [initialValue.length]);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      if (canSave) {
        void onSave(value.trim());
      }
    }
  }

  return (
    <div className="conversation-inline-message-editor">
      <TokenizedComposerInput
        ref={inputRef}
        value={value}
        parts={parts}
        placeholder={ariaLabel}
        ariaLabel={ariaLabel}
        onChange={(nextValue) => setValue(nextValue)}
        onKeyDown={handleKeyDown}
        onSelect={() => {}}
      />
      {warning ? <p className="conversation-inline-message-editor-warning">{warning}</p> : null}
      <div className="conversation-inline-message-editor-actions">
        <button type="button" className="icon-button" onClick={onCancel} disabled={saving} aria-label={cancelLabel} title={cancelLabel}>
          <X size={14} />
        </button>
        <button
          type="button"
          className="icon-button primary"
          onClick={() => void onSave(value.trim())}
          disabled={!canSave}
          aria-label={saveLabel}
          title={saveLabel}
        >
          {saving ? <Loader2 className="spin" size={14} /> : <Check size={14} />}
        </button>
      </div>
    </div>
  );
}
