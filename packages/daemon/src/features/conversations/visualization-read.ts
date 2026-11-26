import type { ServerResponse } from "node:http";
import { isConversationVisualizationId, type ConversationVisualization } from "@ling-stack/contracts";
import { readConversationVisualizationReferences } from "@ling-stack/conversation-ui-core/message-body";
import type { LingThread, RunStore } from "@ling-stack/core";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { writeJson } from "../../shared/response.js";
import { findChannelDefaultConversationThread } from "../channels/conversation-thread-resolution.js";
import { isTeammateDirectMessageInScope, resolveTeammateDirectRunOwner } from "../teammates/direct-run-owner.js";

export interface ConversationVisualizationRead {
  readonly artifactId: string;
  readonly messageId: string;
  readonly messageRevision: number;
}

type ReadScope = { readonly threadId: string } | {
  readonly workspaceId: string;
  readonly conversationId: string;
  readonly kind: "conversation" | "channel" | "teammate_direct";
};

export function readConversationVisualization(store: RunStore, query: ConversationVisualizationRead,
  scope: ReadScope): ConversationVisualization | undefined {
  if (!isConversationVisualizationId(query.artifactId)) return undefined;
  return store.readSnapshot(() => {
    const saved = store.getConversationVisualization(query.artifactId);
    if (!saved) return undefined;
    const { workspaceId, threadId, turnId, runId, messageId, ...document } = saved;
    const thread = store.getLingThread(threadId);
    if (!thread || thread.workspaceId !== workspaceId || !matchesReadScope(store, scope, thread)) return undefined;
    const run = store.getRun(runId);
    const turn = store.getLingTurnForRun(runId);
    if (run?.status !== "succeeded" || run.threadId !== threadId || run.workflowStepId
      || !turn || turn.id !== turnId || turn.threadId !== threadId || turn.workspaceId !== workspaceId || turn.status === "superseded") return undefined;
    const remote = "conversationId" in scope;
    let body: string;
    let revision: number;
    if (thread.kind === "teammate_direct") {
      const message = store.getTeammateDirectMessage(messageId);
      if (!message || query.messageId !== message.id || (remote && scope.conversationId !== message.threadId)
        || message.workspaceId !== workspaceId || message.status !== "ready" || message.authorType !== "ai-teammate"
        || message.linkedRunId !== runId || !thread.teammateId
        || !isTeammateDirectMessageInScope(message, { teammateId: thread.teammateId, directThreadId: message.threadId })
        || !resolveTeammateDirectRunOwner(store, runId, { teammateId: thread.teammateId, directThreadId: message.threadId,
          canonicalThreadId: threadId, turnId, replyMessageId: messageId })) return undefined;
      body = message.body;
      revision = message.revision ?? 1;
    } else {
      const item = store.getEffectiveConversationItem(messageId);
      if (!item || item.id !== messageId || item.kind !== "assistant_message" || item.status !== "committed"
        || item.payload.streaming || item.payload.deliveryStatus !== "ready" || item.threadId !== threadId
        || item.workspaceId !== workspaceId || item.turnId !== turnId || item.visibilityOwnerId
        || !["ling_agent", "teammate"].includes(item.actorType) || !item.actorId || item.actorId !== run.teammateId) return undefined;
      if (thread.kind === "conversation") {
        const narration = item.payload.runNarration;
        const attempts = store.listLingTurnRuns(turnId).filter(link => link.role !== "validation");
        const current = attempts.reduce<typeof attempts[number] | undefined>((latest, link) =>
          !latest || link.attemptNumber > latest.attemptNumber ? link : latest, undefined);
        if (item.visibility !== "thread_participants" || item.channelId || narration?.source.runId !== runId
          || current?.runId !== runId || query.messageId !== (remote ? narration.messageId : item.id)) return undefined;
      } else if (thread.kind === "channel_discussion") {
        if (item.visibility !== "channel" || !thread.channelId || item.channelId !== thread.channelId || run.channelId !== thread.channelId
          || query.messageId !== item.id || !run.requestSnapshot || typeof run.requestSnapshot !== "object"
          || Reflect.get(run.requestSnapshot, "linkedMessageId") !== item.id) return undefined;
      } else return undefined;
      body = item.payload.body;
      revision = item.revision;
    }
    if (remote) {
      const entityType = scope.kind === "channel" ? "conversation_item" : scope.kind === "conversation" ? "run_session" : "teammate_direct_message";
      const entityId = scope.kind === "conversation" ? runId : messageId;
      const projected = store.getRemoteProjectionEntityVersion({
        workspaceId, conversationKind: scope.kind, conversationId: scope.conversationId, entityType, entityId,
      });
      revision = Math.max(1, projected.revision);
    }
    if (query.messageRevision !== revision) return undefined;
    return readConversationVisualizationReferences(body).some(ref => ref.artifactId === query.artifactId) ? document : undefined;
  });
}

function matchesReadScope(store: RunStore, scope: ReadScope, thread: LingThread): boolean {
  if ("threadId" in scope) return scope.threadId === thread.id;
  if (scope.workspaceId !== thread.workspaceId) return false;
  if (scope.kind === "conversation") return thread.kind === "conversation" && scope.conversationId === thread.id;
  if (scope.kind === "teammate_direct") return thread.kind === "teammate_direct";
  return thread.kind === "channel_discussion" && scope.conversationId === thread.channelId
    && findChannelDefaultConversationThread(store, scope.conversationId)?.id === thread.id;
}

export function handleConversationVisualization(response: ServerResponse, url: URL, stores: RunStoreRegistry, artifactId: string): void {
  response.setHeader("Cache-Control", "no-store");
  const cwd = url.searchParams.get("cwd")?.trim();
  const threadId = url.searchParams.get("threadId");
  const messageId = url.searchParams.get("messageId");
  const revision = url.searchParams.get("messageRevision");
  const messageRevision = revision !== null && /^\d+$/u.test(revision) ? Number(revision) : NaN;
  if (cwd && threadId && messageId && messageId.length <= 256 && threadId.length <= 256
    && Number.isSafeInteger(messageRevision) && messageRevision >= 0 && stores.isTrustedWorkspaceRoot(cwd)) {
    const document = readConversationVisualization(stores.getStore(cwd), { artifactId, messageId, messageRevision }, { threadId });
    if (document) {
      writeJson(response, 200, document);
      return;
    }
  }
  writeJson(response, 404, { error: "visualization_not_found", message: "This visualization is not available in the requested message." });
}
