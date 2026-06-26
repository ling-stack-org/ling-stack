import type {
  ConversationDetailResponse,
  ConversationStreamRequest,
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
};

export type ConversationEndpoints = PublicEndpointGroup<typeof conversationEndpoints>;
