import { forwardRef, type KeyboardEventHandler, type ReactNode } from "react";
import { Loader2, Plus, Send } from "lucide-react";

export interface MessageComposerProps {
  readonly className?: string;
  readonly label: string;
  readonly value: string;
  readonly placeholder: string;
  readonly rows?: number;
  readonly disabled?: boolean;
  readonly sendDisabled?: boolean;
  readonly sending?: boolean;
  readonly sendLabel: string;
  readonly sendingLabel: string;
  readonly sendIcon?: ReactNode;
  readonly sendingIcon?: ReactNode;
  readonly sendButtonClassName?: string;
  readonly attachLabel?: string;
  readonly accept?: string;
  readonly multiple?: boolean;
  readonly previewContent?: ReactNode;
  readonly toolContent?: ReactNode;
  readonly overlayContent?: ReactNode;
  readonly onChange: (value: string) => void;
  readonly onSend: () => void | Promise<void>;
  readonly onAttachFiles?: (files: FileList) => void | Promise<void>;
  readonly onKeyDown?: KeyboardEventHandler<HTMLTextAreaElement>;
}

export const MessageComposer = forwardRef<HTMLTextAreaElement, MessageComposerProps>(function MessageComposer(
  {
    className,
    label,
    value,
    placeholder,
    rows = 3,
    disabled = false,
    sendDisabled = false,
    sending = false,
    sendLabel,
    sendingLabel,
    sendIcon,
    sendingIcon,
    sendButtonClassName,
    attachLabel,
    accept,
    multiple = true,
    previewContent,
    toolContent,
    overlayContent,
    onChange,
    onSend,
    onAttachFiles,
    onKeyDown,
  },
  ref,
) {
  const rootClassName = ["composer-panel", "channel-composer", "message-composer", className].filter(Boolean).join(" ");
  const effectiveSendDisabled = disabled || sendDisabled || sending;
  const currentSendLabel = sending ? sendingLabel : sendLabel;
  const currentSendIcon = sending ? (sendingIcon ?? <Loader2 className="spin" size={15} />) : (sendIcon ?? <Send size={15} />);

  return (
    <section className={rootClassName} aria-label={label}>
      <div className="composer-drop-zone">
        {previewContent}
        <textarea
          ref={ref}
          value={value}
          rows={rows}
          disabled={disabled}
          onChange={(event) => onChange(event.currentTarget.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          aria-label={placeholder}
        />
        {overlayContent}
      </div>
      <div className="composer-primary-actions">
        <div className="composer-tool-row" aria-label={label}>
          {onAttachFiles ? (
            <label className="icon-button composer-tool-button composer-attach-button" aria-label={attachLabel} title={attachLabel}>
              <Plus size={17} />
              <input
                type="file"
                multiple={multiple}
                hidden
                accept={accept}
                disabled={disabled}
                onChange={(event) => {
                  const files = event.currentTarget.files;
                  if (files && files.length > 0) {
                    void onAttachFiles(files);
                  }
                  event.currentTarget.value = "";
                }}
              />
            </label>
          ) : null}
          {toolContent}
        </div>
        <button
          className={["primary-button", "composer-send-button", sendButtonClassName].filter(Boolean).join(" ")}
          type="button"
          onClick={() => void onSend()}
          disabled={effectiveSendDisabled}
          aria-label={currentSendLabel}
          title={currentSendLabel}
        >
          {currentSendIcon}
        </button>
      </div>
    </section>
  );
});
