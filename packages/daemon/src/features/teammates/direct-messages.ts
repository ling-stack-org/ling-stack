import type { IncomingMessage, ServerResponse } from "node:http";
import type { AiTeammate, RunStore, TeammateDirectMessage, TeammateDirectThread } from "@ling-stack/core";
import type { ResolvedDaemonConfig } from "../../config.js";
import { HttpError } from "../../errors.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { readJsonBody, readOptionalIntegerQuery } from "../../shared/request.js";
import { writeJson, writeSse, writeSseHead } from "../../shared/response.js";
import { parseTeammateDirectMessageRequest } from "./schemas.js";

export type CreateTeammateDirectAiReply = (input: {
  readonly store: RunStore;
  readonly teammate: AiTeammate;
  readonly thread: TeammateDirectThread;
  readonly sourceMessage: TeammateDirectMessage;
  readonly providerPresetId?: string;
  readonly signal?: AbortSignal;
  readonly stream?: {
    readonly onReady: (message: TeammateDirectMessage) => void;
    readonly onDelta: (message: TeammateDirectMessage, delta: string) => void;
    readonly onDone: (message: TeammateDirectMessage) => void;
    readonly onBlocked: (message: TeammateDirectMessage) => void;
  };
}) => Promise<TeammateDirectMessage>;

export async function handleTeammateDirectThread(
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

    if (request.method === "GET") {
      const thread = store.getOrCreateTeammateDirectThread(teammateId, new Date().toISOString());
      writeJson(response, 200, { cwd, teammateId, thread });
      return;
    }

    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for teammate direct-thread` });
  } catch (error) {
    writeJson(response, error instanceof HttpError ? error.statusCode : 400, {
      error: error instanceof HttpError ? error.code : "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function handleTeammateDirectMessagesCollection(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  teammateId: string,
  createAiReply: CreateTeammateDirectAiReply,
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

    const thread = store.getOrCreateTeammateDirectThread(teammateId, new Date().toISOString());
    if (request.method === "GET") {
      writeJson(response, 200, {
        cwd,
        teammateId,
        thread,
        messages: store.listTeammateDirectMessages({
          teammateId,
          threadId: thread.id,
          limit: readOptionalIntegerQuery(url, "limit", 1),
        }),
      });
      return;
    }

    if (request.method === "POST") {
      const body = await readJsonBody(request, config.maxBodyBytes);
      const input = parseTeammateDirectMessageRequest(body);
      const now = new Date().toISOString();
      const message = store.createTeammateDirectMessage(
        {
          threadId: thread.id,
          teammateId,
          authorType: "local-user",
          authorId: "local-user",
          body: input.body,
          attachmentIds: input.attachmentIds,
        },
        now,
      );
      const aiReply = input.requestAiReply
        ? await createAiReply({
            store,
            teammate,
            thread,
            sourceMessage: message,
            providerPresetId: input.providerPresetId,
          })
        : undefined;
      writeJson(response, 201, aiReply ? { message, aiReply } : { message });
      return;
    }

    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for teammate direct-messages` });
  } catch (error) {
    writeJson(response, error instanceof HttpError ? error.statusCode : 400, {
      error: error instanceof HttpError ? error.code : "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function handleTeammateDirectMessageStream(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  teammateId: string,
  createAiReply: CreateTeammateDirectAiReply,
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
    if (request.method !== "POST") {
      writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for teammate direct message stream` });
      return;
    }

    const thread = store.getOrCreateTeammateDirectThread(teammate.id, new Date().toISOString());
    const body = await readJsonBody(request, config.maxBodyBytes);
    const messageInput = parseTeammateDirectMessageRequest(body);
    const now = new Date().toISOString();
    const message = store.createTeammateDirectMessage(
      {
        threadId: thread.id,
        teammateId: teammate.id,
        authorType: "local-user",
        authorId: "local-user",
        body: messageInput.body,
        attachmentIds: messageInput.attachmentIds,
      },
      now,
    );
    const abortController = new AbortController();
    let closed = false;
    response.on("close", () => {
      closed = true;
      abortController.abort();
    });
    const safeWriteSse = (event: string, data: unknown): void => {
      if (!closed && !response.destroyed) {
        writeSse(response, event, data);
      }
    };
    writeSseHead(response);
    try {
      await createAiReply({
        store,
        teammate,
        thread,
        sourceMessage: message,
        providerPresetId: messageInput.providerPresetId,
        signal: abortController.signal,
        stream: {
          onReady: (aiReply) => safeWriteSse("ready", { message, aiReply }),
          onDelta: (aiReply, delta) => safeWriteSse("delta", { messageId: aiReply.id, delta, body: aiReply.body }),
          onDone: (aiReply) => safeWriteSse("done", { message, aiReply }),
          onBlocked: (aiReply) => safeWriteSse(aiReply.status === "failed" ? "error" : "blocked", { message, aiReply, error: aiReply.errorMessage }),
        },
      });
    } catch (error) {
      safeWriteSse("error", { message, error: error instanceof Error ? error.message : String(error) });
    } finally {
      if (!closed && !response.destroyed) {
        response.end();
      }
    }
  } catch (error) {
    if (response.headersSent) {
      response.end();
      return;
    }
    writeJson(response, error instanceof HttpError ? error.statusCode : 400, {
      error: error instanceof HttpError ? error.code : "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
