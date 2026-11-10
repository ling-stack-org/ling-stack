import type { ChannelMessageFileRef, ConversationActiveReplyTarget, ConversationAttachment } from "../../types.js";
import type { useNormalConversationActionFeedback } from "./useNormalConversationActionFeedback.js";
import type { useNormalConversationAttachmentController } from "./useNormalConversationAttachmentController.js";
import type { useNormalConversationIdentityController } from "./useNormalConversationIdentityController.js";
import type { useNormalConversationOperationOwner } from "./useNormalConversationOperationOwner.js";
import type { ConversationHomeMessage } from "./normal-conversation-types.js";
import { UnconfirmedConversationSubmissionError } from "../../shared/conversation/conversation-submission-recovery.js";
import {
  projectNormalConversationGuidanceMessage,
  queueNormalConversationGuidance,
} from "./normal-conversation-guidance.js";

type ActionFeedback = ReturnType<typeof useNormalConversationActionFeedback>;
type AttachmentController = ReturnType<typeof useNormalConversationAttachmentController>;
type IdentityController = ReturnType<typeof useNormalConversationIdentityController>;
type OperationOwner = ReturnType<typeof useNormalConversationOperationOwner<boolean>>;

export async function submitNormalConversationGuidance(input: {
  readonly activeReply: ConversationActiveReplyTarget | undefined;
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
  readonly onRecovered: (clearDraft: boolean) => void;
  readonly refresh: () => Promise<void>;
}): Promise<void> {
  if (input.operationOwner.busy) {
    return;
  }
  const threadId = input.threadId || input.activeReply?.threadId;
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
  let submittedAttachments = pendingAttachments;
  let accepted = false;
  try {
    const { intervention, queryOnly } = await queueNormalConversationGuidance({
      cwd: input.workspaceCwd.trim(),
      sourceReply: input.activeReply,
      threadId,
      draft: { body: input.body, attachments, fileRefs: input.fileRefs },
      onSubmitting: () => { submittedAttachments = input.attachmentController.protectForSubmission(pendingAttachments); },
      notReadyMessage: input.notReadyMessage,
    });
    accepted = true;
    if (!commitGuard(threadId)) {
      input.attachmentController.abandonSend(submittedAttachments);
      return;
    }
    if (queryOnly) {
      const payload = intervention.messagePayload;
      const boundIds = new Set(payload?.attachmentIds ?? []);
      const retained = pendingAttachments.filter(item => !item.attachment || !boundIds.has(item.attachment.id));
      input.attachmentController.restoreForIdentity(retained, operationIdentity);
      input.attachmentController.markSendBound(pendingAttachments.filter(item => item.attachment && boundIds.has(item.attachment.id)));
      const sameFiles = attachments.length === (payload?.attachmentIds.length ?? 0)
        && attachments.every((item, index) => item.id === payload?.attachmentIds[index]);
      const sameRefs = input.fileRefs.length === (payload?.fileRefs?.length ?? 0)
        && input.fileRefs.every((ref, index) => ref.path === payload?.fileRefs?.[index].path);
      input.onRecovered(input.body.trim() === (payload?.body ?? intervention.instruction).trim() && sameFiles && sameRefs);
    } else {
      input.attachmentController.markSendBound(submittedAttachments);
      input.onAccepted(projectNormalConversationGuidanceMessage({ intervention, threadId, attachments, fileRefs: input.fileRefs }));
    }
    await input.refresh();
  } catch (error) {
    if (commitGuard()) {
      if (!accepted) input.attachmentController.restoreForIdentity(
        error instanceof UnconfirmedConversationSubmissionError ? submittedAttachments : pendingAttachments, operationIdentity);
      input.actionFeedback.report("stream", error instanceof Error ? error.message : String(error));
    } else {
      input.attachmentController.abandonSend(submittedAttachments);
    }
  } finally {
    input.operationOwner.finish(operation);
  }
}
