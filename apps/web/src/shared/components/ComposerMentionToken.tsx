import { AtSign, X } from "lucide-react";

export interface ComposerMentionTokenProps {
  readonly label: string;
  readonly kind?: "teammate" | "skill";
  readonly onRemove?: () => void;
}

export function ComposerMentionToken({ label, kind = "teammate", onRemove }: ComposerMentionTokenProps): JSX.Element {
  return (
    <span className={`composer-structured-token mention ${kind}`}>
      <AtSign size={13} />
      <strong>{label}</strong>
      <small>{kind}</small>
      {onRemove ? (
        <button type="button" onClick={onRemove} aria-label={`Remove ${label}`}>
          <X size={12} />
        </button>
      ) : null}
    </span>
  );
}
