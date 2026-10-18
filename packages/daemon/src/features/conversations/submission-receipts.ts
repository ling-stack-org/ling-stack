import { createHash } from "node:crypto";
import type { ServerResponse } from "node:http";
import type { RunStore } from "@ling-stack/core";
import type { ConversationSubmissionQuery, ConversationSubmissionReceipt } from "@ling-stack/contracts";
import { HttpError } from "../../errors.js";
import { writeJson } from "../../shared/response.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";

export function normalSubmissionThreadId(cwd: string, key: string): string {
  return `thread_normal_${createHash("sha256").update(JSON.stringify([cwd, key])).digest("hex")}`;
}

export function readConversationSubmission(store: RunStore, query: ConversationSubmissionQuery): ConversationSubmissionReceipt {
  const unknown: ConversationSubmissionReceipt = { cwd: store.paths.cwd, idempotencyKey: query.idempotencyKey, status: "unknown" };
  const thread = query.threadId ? store.getLingThread(query.threadId) : query.surface === "normal"
    ? store.getLingThread(normalSubmissionThreadId(store.paths.cwd, query.idempotencyKey))
    : store.findLingThreadByOwner({ kind: "channel_discussion", channelId: query.channelId, surfaceKind: "channel_root" });
  if (!thread) return unknown;
  if (query.surface === "normal" ? thread.kind !== "conversation" || Boolean(thread.channelId || thread.teammateId && thread.teammateId !== "ling_agent")
    : thread.kind !== "channel_discussion" || thread.channelId !== query.channelId) return unknown;
  const itemKey = query.surface === "normal" ? `normal-conversation:${thread.id}:${query.idempotencyKey}` : query.idempotencyKey;
  const item = store.getConversationItemByIdempotencyKey(thread.id, itemKey);
  const turn = item?.turnId ? store.getLingTurn(item.turnId) : undefined;
  if (!item || item.kind !== "user_message" || item.threadId !== thread.id || item.workspaceId !== thread.workspaceId
    || !turn || turn.threadId !== thread.id || turn.sourceItemId !== item.id || turn.workspaceId !== thread.workspaceId
    || item.channelId !== thread.channelId || turn.channelId !== thread.channelId) return unknown;
  return { ...unknown, status: "accepted", threadId: thread.id, turnId: turn.id, sourceItemId: item.id, sourceItem: item };
}

export function handleConversationSubmissionReceipt(response: ServerResponse, url: URL, registry: RunStoreRegistry): void {
  try {
    const cwd = url.searchParams.get("cwd");
    const key = url.searchParams.get("idempotencyKey");
    const surface = url.searchParams.get("surface");
    if (!cwd || !key?.trim() || key.length > 200 || /[\r\n]/.test(key) || (surface !== "normal" && surface !== "channel")) {
      throw new HttpError(400, "bad_request", "A workspace, surface and valid submission identity are required");
    }
    const threadId = url.searchParams.get("threadId") || undefined;
    const channelId = url.searchParams.get("channelId");
    if (surface === "channel" && !channelId) throw new HttpError(400, "bad_request", "channelId is required");
    writeJson(response, 200, readConversationSubmission(registry.getStore(cwd), surface === "normal"
      ? { surface, idempotencyKey: key, threadId }
      : { surface, idempotencyKey: key, threadId, channelId: channelId! }));
  } catch (error) {
    writeJson(response, error instanceof HttpError ? error.statusCode : 400, {
      error: error instanceof HttpError ? error.code : "bad_request", message: error instanceof Error ? error.message : String(error),
    });
  }
}
