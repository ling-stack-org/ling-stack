import type { IncomingMessage, ServerResponse } from "node:http";
import type { ResolvedDaemonConfig } from "../../config.js";
import { HttpError } from "../../errors.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { readJsonBody, readOptionalIntegerQuery } from "../../shared/request.js";
import { writeJson } from "../../shared/response.js";
import {
  CHANNEL_ATTACHMENT_REQUEST_MAX_BYTES,
  deleteAttachmentContent,
  deleteAttachmentPath,
  persistTeammatePrivateAttachment,
} from "../channels/attachments.js";
import { parseHardDeleteAiTeammateRequest, parseTeammatePrivateAttachmentRequest } from "./schemas.js";

export async function handleTeammateDirectAttachments(
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
    if (!store.getAiTeammate(teammateId)) {
      writeJson(response, 404, { error: "teammate_not_found", message: `AI teammate not found: ${teammateId}` });
      return;
    }

    const thread = store.getOrCreateTeammateDirectThread(teammateId, new Date().toISOString());
    if (request.method === "GET") {
      writeJson(response, 200, {
        cwd,
        teammateId,
        thread,
        attachments: store.listTeammatePrivateAttachments({
          teammateId,
          threadId: thread.id,
          scope: "teammate_direct_thread",
          limit: readOptionalIntegerQuery(url, "limit", 1),
        }),
      });
      return;
    }

    if (request.method === "POST") {
      const body = await readJsonBody(request, Math.max(config.maxBodyBytes, CHANNEL_ATTACHMENT_REQUEST_MAX_BYTES));
      const input = parseTeammatePrivateAttachmentRequest(body);
      if (input.scope && input.scope !== "teammate_direct_thread") {
        throw new HttpError(400, "invalid_attachment_scope", "direct-attachments only accepts teammate_direct_thread scope");
      }
      const attachment = persistTeammatePrivateAttachment(store, teammateId, {
        ...input,
        scope: "teammate_direct_thread",
        threadId: thread.id,
      });
      writeJson(response, 201, { attachment });
      return;
    }

    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for teammate direct-attachments` });
  } catch (error) {
    writeJson(response, error instanceof HttpError ? error.statusCode : 400, {
      error: error instanceof HttpError ? error.code : "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function handleTeammateAvatar(
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

    if (request.method === "POST") {
      const body = await readJsonBody(request, Math.max(config.maxBodyBytes, CHANNEL_ATTACHMENT_REQUEST_MAX_BYTES));
      const input = parseTeammatePrivateAttachmentRequest(body);
      const previousAvatarId = teammate.avatarImageAttachmentId;
      const previousAvatar = previousAvatarId ? store.getTeammatePrivateAttachment(previousAvatarId) : undefined;
      const attachment = persistTeammatePrivateAttachment(store, teammateId, {
        ...input,
        scope: "teammate_profile_avatar",
      });
      const updated = store.updateAiTeammate(teammateId, { avatarImageAttachmentId: attachment.id }, new Date().toISOString());
      if (previousAvatar && previousAvatar.id !== attachment.id) {
        deleteAttachmentContent(store, previousAvatar);
        store.deleteTeammatePrivateAttachment(previousAvatar.id);
      }
      writeJson(response, 201, { teammate: updated, attachment });
      return;
    }

    if (request.method === "DELETE") {
      const avatarId = teammate.avatarImageAttachmentId;
      const avatar = avatarId ? store.getTeammatePrivateAttachment(avatarId) : undefined;
      const updated = store.updateAiTeammate(teammateId, { avatarImageAttachmentId: null }, new Date().toISOString());
      if (avatar) {
        deleteAttachmentContent(store, avatar);
        store.deleteTeammatePrivateAttachment(avatar.id);
      }
      writeJson(response, 200, { teammate: updated });
      return;
    }

    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for teammate avatar` });
  } catch (error) {
    writeJson(response, error instanceof HttpError ? error.statusCode : 400, {
      error: error instanceof HttpError ? error.code : "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function handleTeammateHardDelete(
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
    if (!store.getAiTeammate(teammateId)) {
      writeJson(response, 404, { error: "teammate_not_found", message: `AI teammate not found: ${teammateId}` });
      return;
    }

    if (request.method !== "POST") {
      writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for teammate hard delete` });
      return;
    }

    const body = await readJsonBody(request, config.maxBodyBytes);
    const input = parseHardDeleteAiTeammateRequest(body);
    const result = store.hardDeleteAiTeammate(teammateId, input, new Date().toISOString());
    if (!result) {
      writeJson(response, 404, { error: "teammate_not_found", message: `AI teammate not found: ${teammateId}` });
      return;
    }
    for (const path of result.deletedAttachmentPaths) {
      deleteAttachmentPath(store, path);
    }
    writeJson(response, 200, { tombstone: result.tombstone });
  } catch (error) {
    writeJson(response, error instanceof HttpError ? error.statusCode : 400, {
      error: error instanceof HttpError ? error.code : "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
