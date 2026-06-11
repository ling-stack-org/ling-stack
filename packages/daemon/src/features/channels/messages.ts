import type { IncomingMessage, ServerResponse } from "node:http";
import type { Channel, ChannelMessage, RunStore } from "@ling-stack/core";
import type { ResolvedDaemonConfig } from "../../config.js";
import { HttpError } from "../../errors.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { readJsonBody, readOptionalIntegerQuery } from "../../shared/request.js";
import { writeJson } from "../../shared/response.js";
import {
  routeChannelMessageReply,
  routeExplicitChannelMention,
  type ChannelMessageRouteInput,
} from "./channel-message-router.js";
import { selectChannelWorkflowIntent } from "./channel-intent-selector.js";
import { validateChannelMessageReferences } from "./protocol.js";
import { parseChannelMessageRequest } from "./schemas.js";

export type CreateChannelAiReply = (input: {
  readonly store: RunStore;
  readonly channel: Channel;
  readonly sourceMessage: ChannelMessage;
  readonly providerPresetId?: string;
  readonly teammateId?: string;
  readonly proposalMode?: "allow" | "disabled";
  readonly channelParallelLimit?: number;
  readonly visibleParticipantTeammateIds?: readonly string[];
}) => Promise<ChannelMessage>;

export async function handleChannelMessagesCollection(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  channelId: string,
  createAiReply: CreateChannelAiReply,
  routeDependencies: Omit<ChannelMessageRouteInput, "store" | "channel" | "sourceMessage" | "requestedProviderPresetId" | "requestedTeammateId">,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    const channel = store.getChannel(channelId);
    if (!channel) {
      writeJson(response, 404, { error: "channel_not_found", message: `Channel not found: ${channelId}` });
      return;
    }

    if (request.method === "GET") {
      const page = store.listChannelMessagesPage({
        channelId,
        threadId: url.searchParams.get("threadId") ?? undefined,
        beforeMessageId: url.searchParams.get("beforeMessageId") ?? undefined,
        limit: readOptionalIntegerQuery(url, "limit", 1),
      });
      writeJson(response, 200, {
        cwd,
        channelId,
        messages: page.messages,
        hasMore: page.hasMore,
        nextBeforeMessageId: page.nextBeforeMessageId,
      });
      return;
    }

    if (request.method === "POST") {
      const body = await readJsonBody(request, config.maxBodyBytes);
      const input = parseChannelMessageRequest(body);
      const referenceError = validateChannelMessageReferences(store, channelId, input.attachmentIds, input.linkPreviewIds);
      if (referenceError) {
        writeJson(response, referenceError.statusCode, {
          error: referenceError.code,
          message: referenceError.message,
        });
        return;
      }
      const now = new Date().toISOString();
      const message = store.createChannelMessage(
        {
          channelId,
          threadId: input.threadId,
          kind: input.kind ?? "message",
          intent: input.intent ?? "discuss",
          authorType: input.authorType,
          authorId: input.authorId,
          body: input.body,
          mentions: input.mentions,
          attachmentIds: input.attachmentIds,
          linkPreviewIds: input.linkPreviewIds,
          linkedTaskId: input.linkedTaskId,
          linkedRunId: input.linkedRunId,
        },
        now,
      );

      let aiReply: ChannelMessage | undefined;
      let routeDecisionId: string | undefined;
      if (input.requestAiReply) {
        const route = routeExplicitChannelMention({
          ...routeDependencies,
          store,
          channel,
          sourceMessage: message,
          requestedProviderPresetId: input.providerPresetId,
          requestedTeammateId: input.teammateId,
        });
        routeDecisionId = route.decisionId;
        aiReply = await createAiReply({
          store,
          channel,
          sourceMessage: message,
          providerPresetId: route.action === "reply" ? route.providerPresetId ?? input.providerPresetId : input.providerPresetId,
          teammateId: route.action === "reply" ? route.teammateId : input.teammateId,
          proposalMode: "allow",
        });
      } else {
        const workflowIntent = await selectChannelWorkflowIntent({
          store,
          channel,
          sourceMessage: message,
          requestedProviderPresetId: input.providerPresetId,
          secretResolver: routeDependencies.secretResolver,
          config,
          runnerRegistry: routeDependencies.runnerRegistry,
        });
        if (workflowIntent.action === "no_reply") {
          writeJson(response, 201, { message });
          return;
        }
        if (workflowIntent.action === "workflow_proposal") {
          writeJson(response, 201, { message });
          return;
        }
        if (workflowIntent.action === "visible_multi_reply") {
          const aiReplies = workflowIntent.aiReplies ?? await Promise.all(workflowIntent.teammateIds.map((teammateId) => createAiReply({
            store,
            channel,
            sourceMessage: message,
            providerPresetId: input.providerPresetId,
            teammateId,
            proposalMode: "disabled",
            channelParallelLimit: workflowIntent.teammateIds.length,
            visibleParticipantTeammateIds: workflowIntent.teammateIds,
          })));
          if (!workflowIntent.intentDecisionId) {
            store.createChannelIntentDecision({
              channelId: channel.id,
              sourceMessageId: message.id,
              action: "visible_multi_reply",
              selectedTeammateIds: workflowIntent.teammateIds,
              replyMessageIds: aiReplies.map((reply) => reply.id),
              reason: workflowIntent.reason,
              status: "accepted",
              createdBy: workflowIntent.createdBy,
            }, new Date().toISOString());
          }
          writeJson(response, 201, { message, aiReply: aiReplies[0], aiReplies });
          return;
        }
        if (workflowIntent.action === "clarify") {
          aiReply = workflowIntent.aiReply;
        }

        if (!aiReply) {
          const route = await routeChannelMessageReply({
            ...routeDependencies,
            store,
            channel,
            sourceMessage: message,
            requestedProviderPresetId: input.providerPresetId,
            requestedTeammateId: input.teammateId,
          });
          routeDecisionId = route.decisionId;
          if (route.action === "reply") {
            aiReply = await createAiReply({
              store,
              channel,
              sourceMessage: message,
              providerPresetId: route.providerPresetId ?? input.providerPresetId,
              teammateId: route.teammateId,
              proposalMode: "disabled",
            });
          }
        }
      }

      if (routeDecisionId && aiReply) {
        store.updateChannelMessageRouteDecision(routeDecisionId, {
          replyMessageId: aiReply.id,
        }, new Date().toISOString());
      }

      writeJson(response, 201, aiReply ? { message, aiReply } : { message });
      return;
    }

    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for channel messages` });
  } catch (error) {
    writeJson(response, error instanceof HttpError ? error.statusCode : 400, {
      error: error instanceof HttpError ? error.code : "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
