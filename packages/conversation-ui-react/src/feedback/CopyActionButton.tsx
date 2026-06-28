import { useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";

export interface CopyActionButtonProps {
  readonly text: string;
  readonly label: string;
  readonly copiedLabel?: string;
  readonly className?: string;
  readonly iconSize?: number;
  readonly idleContent?: ReactNode;
  readonly copiedContent?: ReactNode;
}

export function CopyActionButton({
  text,
  label,
  copiedLabel,
  className,
  iconSize = 13,
  idleContent,
  copiedContent,
}: CopyActionButtonProps): JSX.Element {
  const [copied, setCopied] = useState(false);
  const copiedText = copiedLabel ?? "Copied";
  const currentLabel = copied ? copiedText : label;

  async function copyText(): Promise<void> {
    if (!globalThis.navigator?.clipboard?.writeText) {
      setCopied(false);
      return;
    }

    try {
      await globalThis.navigator.clipboard.writeText(text);
      setCopied(true);
      globalThis.setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
    }
  }

  return (
    <button
      className={className ?? "message-code-copy"}
      type="button"
      title={currentLabel}
      aria-label={currentLabel}
      data-tooltip={currentLabel}
      onClick={() => void copyText()}
    >
      {copied ? copiedContent ?? <Check size={iconSize} /> : idleContent ?? <Copy size={iconSize} />}
    </button>
  );
}
