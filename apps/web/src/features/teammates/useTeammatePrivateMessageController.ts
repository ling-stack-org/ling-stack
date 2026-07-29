import { useEffect, useMemo, useState } from "react";
import { editConversationMessage } from "../../api.js";
import type {
  AiTeammate,
  PermissionConfirmation,
  PermissionPreset,
  TeammateDirectMessage,
} from "../../types.js";

export interface TeammatePrivateMessageController {
  readonly editError: string;
  readonly editSaving: boolean;
  readonly editingMessageId?: string;
  readonly feedbackById: Readonly<Record<string, "up" | "down">>;
  readonly latestEditableMessageId?: string;
  readonly replacementRetryError: string;
  readonly replacementRetryingMessageId?: string;
  readonly beginEdit: (messageId: string) => void;
  readonly cancelEdit: () => void;
  readonly retryReplacement: (message: TeammateDirectMessage) => void | Promise<void>;
  readonly saveEdit: (message: TeammateDirectMessage, body: string) => void | Promise<void>;
  readonly toggleFeedback: (messageId: string, feedback: "up" | "down") => void;
}

export function useTeammatePrivateMessageController({
  cwd,
  messages,
  onRefreshMessages,
  permissionConfirmation,
  permissionPreset,
  teammate,
}: {
  readonly cwd: string;
  readonly messages: readonly TeammateDirectMessage[];
  readonly onRefreshMessages: () => void | Promise<void>;
  readonly permissionConfirmation?: PermissionConfirmation;
  readonly permissionPreset: PermissionPreset;
  readonly teammate: AiTeammate;
}): TeammatePrivateMessageController {
  const [feedbackById, setFeedbackById] = useState<Record<string, "up" | "down">>({});
  const [editingMessageId, setEditingMessageId] = useState<string>();
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState("");
  const [replacementRetryingMessageId, setReplacementRetryingMessageId] = useState<string>();
  const [replacementRetryError, setReplacementRetryError] = useState("");
  const latestEditableMessageId = useMemo(
    () => [...messages].reverse().find((message) => message.authorType === "local-user" && !message.pendingReplacement)?.id,
    [messages],
  );

  useEffect(() => {
    setFeedbackById({});
    setEditingMessageId(undefined);
    setEditError("");
    setReplacementRetryingMessageId(undefined);
    setReplacementRetryError("");
  }, [teammate.id]);

  async function saveEdit(message: TeammateDirectMessage, body: string): Promise<void> {
    if (editSaving) return;
    setEditSaving(true);
    setEditError("");
    setReplacementRetryError("");
    try {
      await editConversationMessage(cwd.trim(), {
        surface: "teammate_direct",
        ownerId: teammate.id,
        messageId: message.id,
        expectedRevision: message.revision ?? 1,
        body,
        attachmentIds: message.attachmentIds,
        linkPreviewIds: message.linkPreviewIds,
        fileRefs: message.fileRefs,
        providerPresetId: teammate.providerPresetId,
        permissionPreset,
        permissionConfirmation,
        idempotencyKey: `teammate-message-edit:${message.id}:${crypto.randomUUID()}`,
      });
      setEditingMessageId(undefined);
      await onRefreshMessages();
    } catch (error) {
      setEditError(error instanceof Error ? error.message : String(error));
    } finally {
      setEditSaving(false);
    }
  }

  async function retryReplacement(message: TeammateDirectMessage): Promise<void> {
    const pending = message.pendingReplacement;
    if (!pending || replacementRetryingMessageId) return;
    setReplacementRetryingMessageId(message.id);
    setReplacementRetryError("");
    try {
      const result = await editConversationMessage(cwd.trim(), {
        surface: "teammate_direct",
        ownerId: teammate.id,
        messageId: message.id,
        expectedRevision: message.revision ?? 1,
        body: message.body,
        attachmentIds: message.attachmentIds,
        linkPreviewIds: message.linkPreviewIds,
        fileRefs: message.fileRefs,
        providerPresetId: teammate.providerPresetId,
        permissionPreset,
        permissionConfirmation,
        idempotencyKey: pending.idempotencyKey,
      });
      if (result.status === "replacement_pending") {
        setReplacementRetryError(result.failureReason ?? pending.failureReason ?? "");
      }
      await onRefreshMessages();
    } catch (error) {
      setReplacementRetryError(error instanceof Error ? error.message : String(error));
    } finally {
      setReplacementRetryingMessageId(undefined);
    }
  }

  function toggleFeedback(messageId: string, feedback: "up" | "down"): void {
    setFeedbackById((current) => {
      if (current[messageId] === feedback) {
        const next = { ...current };
        delete next[messageId];
        return next;
      }
      return { ...current, [messageId]: feedback };
    });
  }

  return {
    editError,
    editSaving,
    editingMessageId,
    feedbackById,
    latestEditableMessageId,
    replacementRetryError,
    replacementRetryingMessageId,
    beginEdit: (messageId) => {
      setEditError("");
      setEditingMessageId(messageId);
    },
    cancelEdit: () => {
      setEditError("");
      setEditingMessageId(undefined);
    },
    retryReplacement,
    saveEdit,
    toggleFeedback,
  };
}
