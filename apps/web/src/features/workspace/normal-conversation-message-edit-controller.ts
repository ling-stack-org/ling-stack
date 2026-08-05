import type { Dispatch, SetStateAction } from "react";
import { editConversationMessage } from "../../api.js";
import type { PermissionPreset } from "../../types.js";
import type { useNormalConversationActionFeedback } from "./useNormalConversationActionFeedback.js";
import type { useNormalConversationIdentityController } from "./useNormalConversationIdentityController.js";
import type { useNormalConversationOperationOwner } from "./useNormalConversationOperationOwner.js";
import type { ConversationHomeMessage } from "./normal-conversation-types.js";

type ActionFeedback = ReturnType<typeof useNormalConversationActionFeedback>;
type IdentityController = ReturnType<typeof useNormalConversationIdentityController>;
type StringOperationOwner = ReturnType<typeof useNormalConversationOperationOwner<string>>;

export function createNormalConversationMessageEditController(input: {
  readonly workspaceCwd: string;
  readonly threadId?: string;
  readonly providerPresetId: string;
  readonly permissionPreset: PermissionPreset;
  readonly identityController: IdentityController;
  readonly editOperation: StringOperationOwner;
  readonly replacementOperation: StringOperationOwner;
  readonly actionFeedback: ActionFeedback;
  readonly setMessages: Dispatch<SetStateAction<readonly ConversationHomeMessage[]>>;
  readonly setEditingMessageId: Dispatch<SetStateAction<string | undefined>>;
  readonly refresh: () => Promise<void>;
}): {
  readonly save: (message: ConversationHomeMessage, body: string) => Promise<void>;
  readonly retryReplacement: (message: ConversationHomeMessage) => Promise<void>;
} {
  return {
    async save(message, body) {
      const threadId = message.threadId ?? input.threadId;
      if (!threadId || input.editOperation.busy) return;
      const shouldCommit = input.identityController.createCommitGuard();
      const operation = input.editOperation.begin(message.id);
      const idempotencyKey = `conversation-edit:${message.id}:${crypto.randomUUID()}`;
      input.actionFeedback.clear("edit");
      input.actionFeedback.clear("replacement");
      try {
        const result = await editConversationMessage(input.workspaceCwd.trim(), revisionRequest(input, message, threadId, body, idempotencyKey));
        if (!shouldCommit()) return;
        input.setMessages((current) => current.map((item) => item.id === message.id ? {
          ...item,
          content: result.message.body,
          revision: result.message.revision,
          editedAt: result.message.createdAt,
          updatedAt: result.message.createdAt,
          pendingReplacement: result.status === "replacement_pending" ? {
            supersessionId: result.supersessionId,
            idempotencyKey,
            ...(result.failureReason ? { failureReason: result.failureReason } : {}),
          } : undefined,
        } : item));
        input.setEditingMessageId(undefined);
        await input.refresh();
      } catch (error) {
        input.actionFeedback.report("edit", error instanceof Error ? error.message : String(error));
      } finally {
        input.editOperation.finish(operation);
      }
    },
    async retryReplacement(message) {
      const pending = message.pendingReplacement;
      const threadId = message.threadId ?? input.threadId;
      if (!pending || !threadId || input.replacementOperation.busy) return;
      const shouldCommit = input.identityController.createCommitGuard();
      const operation = input.replacementOperation.begin(message.id);
      input.actionFeedback.clear("replacement");
      try {
        const result = await editConversationMessage(
          input.workspaceCwd.trim(),
          revisionRequest(input, message, threadId, message.content, pending.idempotencyKey),
        );
        if (!shouldCommit()) return;
        if (result.status === "replacement_pending") {
          input.actionFeedback.report("replacement", result.failureReason ?? pending.failureReason ?? "");
        }
        await input.refresh();
      } catch (error) {
        input.actionFeedback.report("replacement", error instanceof Error ? error.message : String(error));
      } finally {
        input.replacementOperation.finish(operation);
      }
    },
  };
}

function revisionRequest(
  input: { readonly providerPresetId: string; readonly permissionPreset: PermissionPreset },
  message: ConversationHomeMessage,
  threadId: string,
  body: string,
  idempotencyKey: string,
) {
  return {
    surface: "normal_conversation" as const,
    ownerId: threadId,
    messageId: message.id,
    expectedRevision: message.revision ?? 1,
    body,
    attachmentIds: (message.attachments ?? []).map((attachment) => attachment.id),
    providerPresetId: input.providerPresetId,
    permissionPreset: input.permissionPreset,
    idempotencyKey,
  };
}
