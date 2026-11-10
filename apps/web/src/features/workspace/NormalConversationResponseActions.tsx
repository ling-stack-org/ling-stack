import { Copy, ThumbsDown, ThumbsUp } from "lucide-react";
import { MessageActionBar } from "@ling-stack/conversation-ui-react";
import { useI18n } from "../../i18n.js";

export function NormalConversationResponseActions({ copyText, feedback, onToggleFeedback }: {
  readonly copyText: string;
  readonly feedback?: "up" | "down";
  readonly onToggleFeedback: (value: "up" | "down") => void;
}): React.JSX.Element {
  const { t } = useI18n();
  return <MessageActionBar surface="normal_conversation" className="normal-conversation-message-actions"
    copiedLabel={t("Copied")} actions={[
      { id: "copy", kind: "copy", label: t("Copy message"), icon: <Copy size={14} />, copyText },
      { id: "like", kind: "like", label: t("Like response"), icon: <ThumbsUp size={14} />, selected: feedback === "up", onClick: () => onToggleFeedback("up") },
      { id: "dislike", kind: "dislike", label: t("Dislike response"), icon: <ThumbsDown size={14} />, selected: feedback === "down", onClick: () => onToggleFeedback("down") },
    ]} />;
}
