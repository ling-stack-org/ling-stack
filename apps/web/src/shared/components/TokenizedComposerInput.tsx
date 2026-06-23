import { forwardRef, type ChangeEventHandler, type ClipboardEventHandler, type KeyboardEventHandler, type ReactEventHandler } from "react";
import { AtSign, Command, FileText, Link2 } from "lucide-react";
import type { ComposerInputPart } from "./composer-input-parts.js";

export interface TokenizedComposerInputProps {
  readonly value: string;
  readonly parts: readonly ComposerInputPart[];
  readonly rows?: number;
  readonly placeholder: string;
  readonly ariaLabel: string;
  readonly executableSlashCommandId?: string;
  readonly executableSlashTargetLabel?: string;
  readonly onChange: ChangeEventHandler<HTMLTextAreaElement>;
  readonly onKeyDown: KeyboardEventHandler<HTMLTextAreaElement>;
  readonly onPaste: ClipboardEventHandler<HTMLTextAreaElement>;
  readonly onSelect: ReactEventHandler<HTMLTextAreaElement>;
}

export const TokenizedComposerInput = forwardRef<HTMLTextAreaElement, TokenizedComposerInputProps>(function TokenizedComposerInput(
  {
    ariaLabel,
    executableSlashCommandId,
    executableSlashTargetLabel,
    onChange,
    onKeyDown,
    onPaste,
    onSelect,
    parts,
    placeholder,
    rows = 3,
    value,
  },
  ref,
) {
  return (
    <div className={value ? "tokenized-composer-input has-value" : "tokenized-composer-input"}>
      <div className="tokenized-composer-input-overlay" aria-hidden="true">
        {renderComposerInlineParts(parts, executableSlashCommandId, executableSlashTargetLabel)}
        {value.endsWith("\n") ? "\u200b" : null}
      </div>
      <textarea
        ref={ref}
        value={value}
        rows={rows}
        onChange={onChange}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onSelect={onSelect}
        placeholder={placeholder}
        aria-label={ariaLabel}
        spellCheck
      />
    </div>
  );
});

function renderComposerInlineParts(
  parts: readonly ComposerInputPart[],
  executableSlashCommandId: string | undefined,
  executableSlashTargetLabel: string | undefined,
): JSX.Element[] {
  const rendered: JSX.Element[] = [];
  let slashIndex = 0;
  parts.forEach((part, index) => {
    if (part.type === "attachment") {
      return;
    }
    if (part.type === "text") {
      rendered.push(<span key={`text-${index}`} className="composer-inline-text">{part.text}</span>);
      return;
    }
    if (part.type === "teammate_mention" || part.type === "skill_mention") {
      rendered.push(
        <span key={`${part.type}-${part.raw}-${index}`} className="composer-inline-token mention">
          <AtSign size={12} />
          <strong>{part.label}</strong>
        </span>,
      );
      return;
    }
    if (part.type === "slash_command") {
      const executable = slashIndex === 0 && part.commandId === executableSlashCommandId;
      slashIndex += 1;
      rendered.push(
        <span
          key={`slash-${part.raw}-${index}`}
          className={executable ? "composer-inline-token command executable" : "composer-inline-token command"}
        >
          <Command size={12} />
          <strong>{part.label}</strong>
          <small>{executable && executableSlashTargetLabel ? `${executableSlashTargetLabel} · ${part.raw}` : part.raw}</small>
        </span>,
      );
      return;
    }
    if (part.type === "workspace_file") {
      rendered.push(
        <span key={`file-${part.raw}-${index}`} className="composer-inline-token file-reference">
          <FileText size={12} />
          <strong>{part.path}</strong>
          {part.line !== undefined ? <small>:{part.line}</small> : null}
        </span>,
      );
      return;
    }
    rendered.push(
      <span key={`url-${part.raw}-${index}`} className={`composer-inline-token url-reference ${part.state ?? "idle"}`}>
        <Link2 size={12} />
        <strong>{part.label}</strong>
        <small>{urlReferenceSubtitle(part)}</small>
      </span>,
    );
  });
  return rendered;
}

function urlReferenceSubtitle(part: Extract<ComposerInputPart, { readonly type: "url_ref" }>): string {
  if (part.state === "uploading") {
    return "Fetching";
  }
  if (part.state === "blocked") {
    return part.error || "Blocked";
  }
  if (part.state === "failed") {
    return part.error || "Failed";
  }
  return part.host ?? part.raw;
}
