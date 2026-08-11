import { Check, Copy } from "lucide-react";
import { useI18n } from "../../../i18n.js";
import { useConversationActionView } from "../view-store/use-conversation-action-view.js";

export interface OperationBubbleCopyActionProps {
  readonly actionId: string;
  readonly text: string;
  readonly label: string;
  readonly copiedLabel?: string;
  readonly className?: string;
  readonly iconSize?: number;
}

export function OperationBubbleCopyAction({
  actionId,
  text,
  label,
  copiedLabel,
  className,
  iconSize = 13,
}: OperationBubbleCopyActionProps): React.JSX.Element {
  const { t } = useI18n();
  const { active, copied, copyText, setActive } = useConversationActionView({ actionId });
  const currentLabel = copied ? copiedLabel ?? t("Copied") : label;

  return (
    <button
      className={className ?? "conversation-operation-bubble-action"}
      type="button"
      title={currentLabel}
      aria-label={currentLabel}
      data-active={active ? "true" : undefined}
      data-copied={copied ? "true" : undefined}
      onPointerEnter={() => setActive(true)}
      onPointerLeave={() => setActive(false)}
      onFocus={() => setActive(true)}
      onBlur={() => setActive(false)}
      onClick={() => void copyText(text)}
    >
      {copied ? <Check size={iconSize} /> : <Copy size={iconSize} />}
    </button>
  );
}
