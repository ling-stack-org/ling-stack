import type { IncomingMessage, ServerResponse } from "node:http";
import type { Channel, ChannelMessage, RunStore } from "@ling-stack/core";
import type { ResolvedDaemonConfig } from "../../config.js";
import { HttpError } from "../../errors.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { readJsonBody, readOptionalIntegerQuery } from "../../shared/request.js";
import { writeJson } from "../../shared/response.js";
import { validateChannelMessageReferences } from "./protocol.js";
import { parseChannelMessageRequest } from "./schemas.js";

export type CreateChannelAiReply = (input: {
  readonly store: RunStore;
  readonly channel: Channel;
  readonly sourceMessage: ChannelMessage;
  readonly providerPresetId?: string;
  readonly teammateId?: string;
}) => Promise<ChannelMessage>;

export async function handleChannelMessagesCollection(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  channelId: string,
  createAiReply: CreateChannelAiReply,
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
      if (input.requestAiReply) {
        aiReply = await createAiReply({
          store,
          channel,
          sourceMessage: message,
          providerPresetId: input.providerPresetId,
          teammateId: input.teammateId,
        });
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
