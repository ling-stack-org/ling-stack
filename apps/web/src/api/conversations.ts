import type {
  ConversationDetailResponse,
  ConversationStreamRequest,
} from "../types.js";
import { daemonClient } from "./client.js";

export async function getConversation(cwd: string, threadId: string): Promise<ConversationDetailResponse> {
  return daemonClient.getConversation(cwd, threadId);
}

export async function streamConversation(cwd: string, input: ConversationStreamRequest): Promise<Response> {
  return daemonClient.streamConversation(cwd, input);
}
