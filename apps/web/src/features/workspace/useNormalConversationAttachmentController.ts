import { useMemo, useState } from "react";
import { deleteAttachment, uploadConversationAttachment } from "../../api.js";
import type { PendingAttachmentItem } from "../../shared/components/index.js";
import { useComposerAttachmentUploads } from "../../shared/conversation/use-composer-attachment-uploads.js";
import type { ConversationAttachment } from "../../types.js";
import type { NormalConversationIdentitySnapshot } from "./useNormalConversationIdentityController.js";

export type PendingConversationAttachment = PendingAttachmentItem<ConversationAttachment>;

export function useNormalConversationAttachmentController(input: {
  readonly composerBusy: boolean;
  readonly ownerKey: string;
  readonly captureIdentity: () => NormalConversationIdentitySnapshot;
  readonly isCurrentIdentity: (snapshot: NormalConversationIdentitySnapshot) => boolean;
  readonly report: (message: string) => void;
  readonly clear: () => void;
  readonly translate: (key: string) => string;
}) {
  const [pendingAttachments, setPendingAttachments] = useState<readonly PendingConversationAttachment[]>([]);
  const uploads = useComposerAttachmentUploads({
    ownerKey: input.ownerKey,
    sourceCwd: input.captureIdentity().workspaceCwd,
    pending: pendingAttachments,
    setPending: setPendingAttachments,
    captureScope: () => {
      const identity = input.captureIdentity();
      return {
        upload: async (file: File) => (await uploadConversationAttachment(identity.workspaceCwd, file, identity.threadId)).attachment,
        remove: (attachment: ConversationAttachment) => deleteAttachment(identity.workspaceCwd, attachment.id),
      };
    },
  });

  async function attachFiles(files: FileList | readonly File[]) {
    const selected = Array.from(files);
    if (!selected.length || input.composerBusy) return;
    if (!input.captureIdentity().workspaceCwd) {
      input.report(input.translate("Local workspace is not ready."));
      return;
    }
    if (pendingAttachments.length + selected.length > 10) {
      input.report(input.translate("A conversation message can attach at most 10 files."));
      return;
    }
    input.clear();
    await uploads.attachFiles(selected);
  }

  function abandonSend(items: readonly PendingConversationAttachment[]) {
    for (const item of items) {
      if (!item.sourceCwd) { uploads.releasePreviews([item]); continue; }
      const sourceCwd = item.sourceCwd;
      void uploads.discardAttachment(item, {
        remove: attachment => deleteAttachment(sourceCwd, attachment.id),
      });
    }
  }

  function restoreForIdentity(items: readonly PendingConversationAttachment[], identity: NormalConversationIdentitySnapshot) {
    if (!input.isCurrentIdentity(identity)) {
      abandonSend(items);
      return false;
    }
    uploads.replacePending(items);
    return true;
  }

  const readyAttachmentIds = useMemo(() => pendingAttachments.flatMap(item =>
    item.state === "ready" && item.attachment ? [item.attachment.id] : []), [pendingAttachments]);
  return { pendingAttachments, readyAttachmentIds, attachFiles,
    removeAttachment: uploads.removeAttachment, retryAttachment: uploads.retryAttachment,
    cleanupFailures: uploads.cleanupFailures, retryCleanup: uploads.retryCleanup,
    consumeForSend: uploads.takePending,
    protectForSubmission: uploads.protectForSubmission,
    markSendBound: uploads.releasePreviews,
    restoreForIdentity, abandonSend, releasePreviews: uploads.releasePreviews,
  };
}
