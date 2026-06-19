import type { IncomingMessage, ServerResponse } from "node:http";
import type { TeammateDirectLinkPreview, TeammateStoreFacet } from "@ling-stack/core";
import type { ResolvedDaemonConfig } from "../../config.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { readJsonBody, readOptionalIntegerQuery } from "../../shared/request.js";
import { writeJson } from "../../shared/response.js";
import { fetchLinkPreviewMetadata, normalizePreviewUrl } from "../channels/link-previews.js";
import { parseChannelLinkPreviewRequest, type ChannelLinkPreviewRequest } from "../channels/schemas.js";

export async function handleTeammateDirectLinkPreviews(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  teammateId: string,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    const teammate = store.getAiTeammate(teammateId);
    if (!teammate) {
      writeJson(response, 404, { error: "teammate_not_found", message: `AI teammate not found: ${teammateId}` });
      return;
    }
    const thread = store.getOrCreateTeammateDirectThread(teammate.id, new Date().toISOString());

    if (request.method === "GET") {
      writeJson(response, 200, {
        cwd,
        teammateId,
        thread,
        linkPreviews: store.listTeammateDirectLinkPreviews({ teammateId, threadId: thread.id, limit: readOptionalIntegerQuery(url, "limit", 1) }),
      });
      return;
    }

    if (request.method === "POST") {
      const body = await readJsonBody(request, config.maxBodyBytes);
      const input = parseChannelLinkPreviewRequest(body);
      if (input.messageId) {
        const message = store.getTeammateDirectMessage(input.messageId);
        if (!message || message.teammateId !== teammateId || message.threadId !== thread.id) {
          writeJson(response, 400, { error: "message_mismatch", message: "Link preview message does not belong to this private chat." });
          return;
        }
      }
      const linkPreview = await createOrFetchTeammateDirectLinkPreview(store, teammateId, thread.id, input);
      writeJson(response, 201, { cwd, teammateId, thread, linkPreview });
      return;
    }

    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for teammate direct link previews` });
  } catch (error) {
    writeJson(response, 400, {
      error: "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function createOrFetchTeammateDirectLinkPreview(
  store: TeammateStoreFacet,
  teammateId: string,
  threadId: string,
  input: ChannelLinkPreviewRequest,
): Promise<TeammateDirectLinkPreview> {
  const normalizedUrl = normalizePreviewUrl(input.url);
  const existing = store
    .listTeammateDirectLinkPreviews({ teammateId, threadId, limit: 500 })
    .find((preview) => preview.normalizedUrl === normalizedUrl);
  if (existing) {
    return existing;
  }

  const metadata = await fetchLinkPreviewMetadata(normalizedUrl);
  return store.createTeammateDirectLinkPreview(
    {
      teammateId,
      threadId,
      messageId: input.messageId,
      url: input.url,
      normalizedUrl,
      title: metadata.title ?? undefined,
      description: metadata.description ?? undefined,
      imageUrl: metadata.imageUrl ?? undefined,
      siteName: metadata.siteName ?? undefined,
      status: metadata.status,
      errorMessage: metadata.errorMessage ?? undefined,
    },
    new Date().toISOString(),
  );
}
