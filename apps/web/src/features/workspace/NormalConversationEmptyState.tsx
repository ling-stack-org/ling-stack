import type { ReactNode } from "react";
import { File, FileText, PackagePlus, Presentation, Table2 } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { publicAssetUrl } from "../../shared/ui/public-asset-url.js";

const conversationMarkSrc = publicAssetUrl("icons/ling-stack-gpt-image-2-icon.png");

export interface NormalConversationEmptyStateProps {
  readonly composerNode: ReactNode;
  readonly onApplyShortcut: (value: string) => void;
}

export function NormalConversationEmptyState({
  composerNode,
  onApplyShortcut,
}: NormalConversationEmptyStateProps): JSX.Element {
  const { t } = useI18n();
  return (
    <section className="conversation-home" aria-label={t("Conversation home")}>
      <div className="conversation-home-center">
        <div className="conversation-home-mark" aria-hidden="true">
          <img src={conversationMarkSrc} alt="" />
        </div>
        <h1>{t("Ling Stack, make work easier.")}</h1>
        {composerNode}
        <div className="conversation-home-shortcuts" aria-label={t("Conversation shortcuts")}>
          <button type="button" onClick={() => onApplyShortcut(t("Create a Team workspace for this project."))}>
            <PackagePlus size={14} />
            <span>{t("Create Team")}</span>
          </button>
          <button type="button" onClick={() => onApplyShortcut(t("Draft a slide outline from the current context."))}>
            <Presentation size={14} />
            <span>{t("Slides")}</span>
          </button>
          <button type="button" onClick={() => onApplyShortcut(t("Analyze an uploaded PDF and summarize the decisions."))}>
            <FileText size={14} />
            <span>{t("PDF")}</span>
          </button>
          <button type="button" onClick={() => onApplyShortcut(t("Organize the latest documents into action items."))}>
            <File size={14} />
            <span>{t("Docs")}</span>
          </button>
          <button type="button" onClick={() => onApplyShortcut(t("Generate a table from the current discussion."))}>
            <Table2 size={14} />
            <span>{t("Sheets")}</span>
          </button>
        </div>
      </div>
    </section>
  );
}
