import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { useI18n } from "../../i18n.js";

export interface CodeBlockProps {
  readonly code: string;
  readonly language?: string;
}

export function CodeBlock({ code, language }: CodeBlockProps): JSX.Element {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);

  async function copyCode(): Promise<void> {
    if (!globalThis.navigator?.clipboard?.writeText) {
      setCopied(false);
      return;
    }

    try {
      await globalThis.navigator.clipboard.writeText(code);
      setCopied(true);
      globalThis.setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
    }
  }

  return (
    <figure className="message-code-block">
      <figcaption>
        <span>{language || "text"}</span>
        <button
          className="message-code-copy"
          type="button"
          title={copied ? t("Copied") : t("Copy code")}
          aria-label={copied ? t("Copied") : t("Copy code")}
          onClick={() => void copyCode()}
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
        </button>
      </figcaption>
      <pre><code>{code}</code></pre>
    </figure>
  );
}
