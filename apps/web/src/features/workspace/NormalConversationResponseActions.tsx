import { Copy, ThumbsDown, ThumbsUp, Video } from "lucide-react";
import { MessageActionBar } from "@ling-stack/conversation-ui-react";
import { useState } from "react";
import { useI18n } from "../../i18n.js";
import { PublishConversationVideoDialog } from "./PublishConversationVideoDialog.js";

export function NormalConversationResponseActions({ copyText, feedback, onToggleFeedback, videoTarget }: {
  readonly copyText: string;
  readonly feedback?: "up" | "down";
  readonly onToggleFeedback: (value: "up" | "down") => void;
  readonly videoTarget?: { readonly cwd: string; readonly runId: string; readonly onPublished: () => Promise<void> };
}): React.JSX.Element {
  const { t } = useI18n();
  const [showVideoDialog, setShowVideoDialog] = useState(false);
  return (
    <>
      <MessageActionBar surface="normal_conversation" className="normal-conversation-message-actions"
        copiedLabel={t("Copied")} actions={[
          { id: "copy", kind: "copy", label: t("Copy message"), icon: <Copy size={14} />, copyText },
          { id: "like", kind: "like", label: t("Like response"), icon: <ThumbsUp size={14} />, selected: feedback === "up", onClick: () => onToggleFeedback("up") },
          { id: "dislike", kind: "dislike", label: t("Dislike response"), icon: <ThumbsDown size={14} />, selected: feedback === "down", onClick: () => onToggleFeedback("down") },
          { id: "add-video", kind: "custom", label: t("Add video to response"), icon: <Video size={14} />,
            onClick: videoTarget ? () => setShowVideoDialog(true) : undefined },
        ]} />
      {showVideoDialog && videoTarget ? <PublishConversationVideoDialog
        key={JSON.stringify([videoTarget.cwd, videoTarget.runId])}
        {...videoTarget}
        onClose={() => setShowVideoDialog(false)}
      /> : null}
    </>
  );
}
