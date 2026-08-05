import type { ChannelMessageFileRef, ConversationAttachment, RunSession } from "../../types.js";
import type { useNormalConversationActionFeedback } from "./useNormalConversationActionFeedback.js";
import type { useNormalConversationAttachmentController } from "./useNormalConversationAttachmentController.js";
import type { useNormalConversationIdentityController } from "./useNormalConversationIdentityController.js";
import type { useNormalConversationOperationOwner } from "./useNormalConversationOperationOwner.js";
import type { ConversationHomeMessage } from "./normal-conversation-types.js";
import {
  projectNormalConversationGuidanceMessage,
  queueNormalConversationGuidance,
} from "./normal-conversation-guidance.js";

type ActionFeedback = ReturnType<typeof useNormalConversationActionFeedback>;
type AttachmentController = ReturnType<typeof useNormalConversationAttachmentController>;
type IdentityController = ReturnType<typeof useNormalConversationIdentityController>;
type OperationOwner = ReturnType<typeof useNormalConversationOperationOwner<boolean>>;

export async function submitNormalConversationGuidance(input: {
  readonly activeRun: RunSession | undefined;
  readonly threadId?: string;
  readonly workspaceCwd: string;
  readonly body: string;
  readonly fileRefs: readonly ChannelMessageFileRef[];
  readonly notReadyMessage: string;
  readonly attachmentController: AttachmentController;
  readonly identityController: IdentityController;
  readonly operationOwner: OperationOwner;
  readonly actionFeedback: ActionFeedback;
  readonly onAccepted: (message: ConversationHomeMessage) => void;
  readonly refresh: () => Promise<void>;
}): Promise<void> {
  if (!input.activeRun || input.operationOwner.busy) {
    return;
  }
  const threadId = input.threadId || input.activeRun.threadId;
  if (!threadId) {
    input.actionFeedback.report("stream", input.notReadyMessage);
    return;
  }
  const operationIdentity = input.identityController.capture();
  const commitGuard = input.identityController.createCommitGuard();
  const pendingAttachments = input.attachmentController.consumeForSend();
  const attachments = pendingAttachments
    .map((item) => item.attachment)
    .filter((attachment): attachment is ConversationAttachment => Boolean(attachment));
  const operation = input.operationOwner.begin(true);
  input.actionFeedback.clear("validation");
  input.actionFeedback.clear("stream");
  try {
    const intervention = await queueNormalConversationGuidance({
      cwd: input.workspaceCwd.trim(),
      sourceRun: input.activeRun,
      draft: { body: input.body, attachments, fileRefs: input.fileRefs },
      idempotencyKey: `web-conversation:${input.activeRun.id}:queue_followup:${Date.now()}:${Math.random().toString(36).slice(2)}`,
    });
    if (!commitGuard(threadId)) {
      input.attachmentController.abandonSend(pendingAttachments);
      return;
    }
    input.attachmentController.markSendBound(pendingAttachments);
    input.onAccepted(projectNormalConversationGuidanceMessage({
      intervention,
      threadId,
      attachments,
      fileRefs: input.fileRefs,
    }));
    await input.refresh();
  } catch (error) {
    if (commitGuard()) {
      input.attachmentController.restoreForIdentity(pendingAttachments, operationIdentity);
      input.actionFeedback.report("stream", error instanceof Error ? error.message : String(error));
    } else {
      input.attachmentController.abandonSend(pendingAttachments);
    }
    throw error;
  } finally {
    input.operationOwner.finish(operation);
  }
}
