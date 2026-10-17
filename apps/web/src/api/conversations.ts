import type {
  ConversationAttachmentMutationResponse,
  ConversationDetailResponse,
  ConversationStreamRequest,
  EditConversationMessageRequest,
  EditConversationMessageResponse,
  UserInputAnswerAcceptedResponseV1,
  UserInputAnswerCommandV1,
} from "../types.js";
import { daemonClient } from "./client.js";
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

export async function submitUserInputAnswer(cwd: string, input: UserInputAnswerCommandV1): Promise<UserInputAnswerAcceptedResponseV1> {
  return daemonClient.submitUserInputAnswer(cwd, input);
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
