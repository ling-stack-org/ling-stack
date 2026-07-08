import { Brain, MessageSquare, Paperclip, SquareTerminal } from "lucide-react";
import { attachmentContentUrl } from "../../api.js";
import { useI18n } from "../../i18n.js";
import { formatDateTime } from "../../lib/formatting.js";
import type {
  DirectWorkspaceResponse,
  MemoryObject,
  TeammateDirectMessage,
  TeammatePrivateAttachment,
  UsedMemoryEvent,
} from "../../types.js";
import {
  directWorkspacePathLabel,
  directWorkspaceStatusLabel,
  formatBytes,
  truncateText,
} from "./teammate-workspace-utils.js";

export function TeammateChatContextPanel({
  cwd,
  embedded = false,
  lastAiMessage,
  directWorkspace,
  directAttachments,
  recentUsedMemoryEvents,
  recentMemoryObjects,
}: {
  readonly cwd: string;
  readonly embedded?: boolean;
  readonly lastAiMessage: TeammateDirectMessage | undefined;
  readonly directWorkspace: DirectWorkspaceResponse | undefined;
  readonly directAttachments: readonly TeammatePrivateAttachment[];
  readonly recentUsedMemoryEvents: readonly UsedMemoryEvent[];
  readonly recentMemoryObjects: readonly MemoryObject[];
}): JSX.Element {
  const { t } = useI18n();
  return (
    <div
      className={embedded ? "teammate-context-panel teammate-context-dock-page" : "teammate-context-panel"}
      aria-label={t("Conversation context")}
    >
      <section>
        <div className="panel-title split">
          <span>
            <MessageSquare size={15} />
            <h3>{t("Conversation context")}</h3>
          </span>
          <small>{t("Private")}</small>
        </div>
        <p>{lastAiMessage?.body ? truncateText(lastAiMessage.body, 180) : t("No AI reply summary yet.")}</p>
      </section>
      <section>
        <div className="panel-title split">
          <span>
            <SquareTerminal size={15} />
            <h3>{t("Private workspace")}</h3>
          </span>
          <small>{directWorkspaceStatusLabel(directWorkspace, t)}</small>
        </div>
        <p>{directWorkspacePathLabel(directWorkspace, t)}</p>
        {directWorkspace?.binding.errorMessage ? <small className="teammate-message-error">{directWorkspace.binding.errorMessage}</small> : null}
      </section>
      <section>
        <div className="panel-title split">
          <span>
            <Paperclip size={15} />
            <h3>{t("Private attachments")}</h3>
          </span>
          <small>{directAttachments.length}</small>
        </div>
        {directAttachments.length === 0 ? (
          <p>{t("No private attachments yet.")}</p>
        ) : (
          <div className="teammate-context-list">
            {directAttachments.slice(0, 4).map((attachment) => (
              <a key={attachment.id} className="teammate-context-row" href={attachmentContentUrl(attachment, cwd.trim())} target="_blank" rel="noreferrer">
                <Paperclip size={13} />
                <span>
                  <strong>{attachment.fileName}</strong>
                  <small>{formatBytes(attachment.sizeBytes)} · {formatDateTime(attachment.createdAt)}</small>
                </span>
              </a>
            ))}
          </div>
        )}
      </section>
      <section>
        <div className="panel-title split">
          <span>
            <Brain size={15} />
            <h3>{t("Recent Used Memory")}</h3>
          </span>
          <small>{recentUsedMemoryEvents.length}</small>
        </div>
        {recentMemoryObjects.length === 0 ? (
          <p>{t("No used memory in this private thread yet.")}</p>
        ) : (
          <div className="teammate-context-list">
            {recentMemoryObjects.map((memory) => (
              <span key={memory.id} className="teammate-context-row">
                <Brain size={13} />
                <span>
                  <strong>{memory.title}</strong>
                  <small>{truncateText(memory.body, 96)}</small>
                </span>
              </span>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
