import type {
  ConversationAttachmentMutationResponse,
  ConversationDetailResponse,
  ConversationStreamRequest,
  EditConversationMessageRequest,
  EditConversationMessageResponse,
} from "../types.js";
import { daemonClient } from "./client.js";
import type { ConversationSubmissionQuery, ConversationSubmissionReceipt } from "../types.js";

export function getConversationSubmission(cwd: string, query: ConversationSubmissionQuery): Promise<ConversationSubmissionReceipt> {
  return daemonClient.getConversationSubmission(cwd, query);
}
import { fileToBase64 } from "./file-uploads.js";

export async function getConversation(cwd: string, threadId: string): Promise<ConversationDetailResponse> {
  return daemonClient.getConversation(cwd, threadId);
}

export async function streamConversation(cwd: string, input: ConversationStreamRequest): Promise<Response> {
  return daemonClient.streamConversation(cwd, input);
}

export async function editConversationMessage(cwd: string, input: EditConversationMessageRequest): Promise<EditConversationMessageResponse> {
  return daemonClient.editConversationMessage(cwd, input);
}

export async function uploadConversationAttachment(
  cwd: string,
  file: File,
  threadId?: string,
): Promise<ConversationAttachmentMutationResponse> {
  return daemonClient.createConversationAttachment(cwd, {
    fileName: file.name,
    contentType: file.type || undefined,
    contentBase64: await fileToBase64(file),
    threadId,
  });
}
