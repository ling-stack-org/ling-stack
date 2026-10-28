import type {
  ConversationAttachmentMutationResponse,
  ConversationDetailResponse,
  ConversationStreamRequest,
  EditConversationMessageRequest,
  EditConversationMessageResponse,
} from "@ling-stack/contracts";
import { daemonClient } from "./client.js";
import { authorizationAndAccessFromLegacyPermission } from "@ling-stack/core/session-permissions";
import type { ConversationSubmissionQuery, ConversationSubmissionReceipt } from "@ling-stack/contracts";

export function getConversationSubmission(cwd: string, query: ConversationSubmissionQuery): Promise<ConversationSubmissionReceipt> {
  return daemonClient.getConversationSubmission(cwd, query);
}
import { fileToBase64 } from "./file-uploads.js";

export async function getConversation(cwd: string, threadId: string): Promise<ConversationDetailResponse> {
  return daemonClient.getConversation(cwd, threadId);
}

export async function streamConversation(cwd: string, input: ConversationStreamRequest): Promise<Response> {
  const legacy = authorizationAndAccessFromLegacyPermission(input.permissionMode, input.permissionPreset);
  const { permissionMode: _permissionMode, permissionPreset: _permissionPreset, ...request } = input;
  return daemonClient.streamConversation(cwd, {
    ...request,
    schemaVersion: 2,
    authorizationMode: input.authorizationMode ?? legacy.authorizationMode,
    workspaceAccessMode: input.workspaceAccessMode ?? legacy.workspaceAccessMode,
  });
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
