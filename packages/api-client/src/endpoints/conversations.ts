import type {
  ConversationAttachmentListResponse,
  ConversationAttachmentMutationResponse,
  ConversationDetailResponse,
  ConversationStreamRequest,
  CreateConversationAttachmentRequest,
  EditConversationMessageRequest,
  EditConversationMessageResponse,
} from "@ling-stack/contracts";
import type { LingDaemonEndpointContext, PublicEndpointGroup } from "../transport.js";

export const conversationEndpoints = {
  async getConversation(this: LingDaemonEndpointContext, cwd: string, threadId: string): Promise<ConversationDetailResponse> {
    return this._get(`/conversations/${encodeURIComponent(threadId)}`, { cwd });
  },

  async streamConversation(this: LingDaemonEndpointContext, cwd: string, input: ConversationStreamRequest): Promise<Response> {
    return this._fetch(this._url("/conversations/stream", { cwd }), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  },

  async listConversationAttachments(this: LingDaemonEndpointContext, cwd: string, threadId?: string, limit: number = 100): Promise<ConversationAttachmentListResponse> {
    return this._get("/conversations/attachments", { cwd, ...(threadId ? { threadId } : {}), limit: String(limit) });
  },

  async createConversationAttachment(this: LingDaemonEndpointContext, cwd: string, input: CreateConversationAttachmentRequest): Promise<ConversationAttachmentMutationResponse> {
    return this._post("/conversations/attachments", { cwd }, input);
  },

  async editConversationMessage(this: LingDaemonEndpointContext, cwd: string, input: EditConversationMessageRequest): Promise<EditConversationMessageResponse> {
    return this._post("/conversation-message-edits", { cwd }, input);
  },
};

export type ConversationEndpoints = PublicEndpointGroup<typeof conversationEndpoints>;
