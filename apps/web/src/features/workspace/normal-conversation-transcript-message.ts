import type { ConversationTranscriptMessage } from "../../types.js";
import type { ConversationHomeMessage } from "./normal-conversation-types.js";

/** Adapt a Host transcript DTO consistently for detail and every SSE event. */
export function homeMessageFromTranscript(message: ConversationTranscriptMessage): ConversationHomeMessage {
  return {
    id: message.id,
    canonicalItemId: message.canonicalItemId,
    threadId: message.threadId,
    turnId: message.turnId,
    runId: message.runId,
    role: message.role,
    authorLabel: message.authorLabel,
    content: message.content,
    contentSource: message.contentSource,
    narrationSegments: message.narrationSegments,
    errorMessage: message.errorMessage,
    attachments: message.attachments,
    fileRefs: message.fileRefs,
    status: message.status,
    revision: message.revision,
    editedAt: message.editedAt,
    pendingReplacement: message.pendingReplacement,
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
  };
}
