import type { IncomingMessage, ServerResponse } from "node:http";
import {
  isLingAgentTeammateId,
  type AiTeammate,
  type AuthorizationMode,
  type PermissionConfirmation,
  type PermissionPreset,
  type RunStore,
  type SkillOptimizationMode,
  type TeammateDirectMessage,
  type TeammateDirectThread,
  type WorkspaceAccessMode,
} from "@ling-stack/core";
import type { ResolvedDaemonConfig } from "../../config.js";
import { HttpError } from "../../errors.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { readJsonBody, readOptionalIntegerQuery } from "../../shared/request.js";
import { writeJson, writeSse, writeSseHead } from "../../shared/response.js";
import type { ActiveDirectReplyRegistry } from "./direct-reply-active-registry.js";
import { assertDirectFileRefsWithinWorkspace, type DirectWorkspaceReady } from "./direct-workspace.js";
import { parseTeammateDirectMessageRequest } from "./schemas.js";
import {
  flushLingAgentGovernanceNotificationDigests,
  flushTeammateDirectGovernanceNotifications,
} from "../governance-notifications/private-delivery.js";
import {
  enrichTeammateDirectMessageWithWebEvidence,
  enrichTeammateDirectMessagesWithWebEvidence,
} from "../web/message-web-evidence.js";
import {
  buildConversationSupersessionProjection,
  filterSupersededTeammateDirectMessages,
  projectTeammateDirectMessageRevisionMetadata,
} from "../conversations/supersession-projection.js";

export type CreateTeammateDirectAiReply = (input: {
  readonly store: RunStore;
  readonly teammate: AiTeammate;
  readonly thread: TeammateDirectThread;
  readonly sourceMessage: TeammateDirectMessage;
  readonly providerPresetId?: string;
  readonly authorizationMode?: AuthorizationMode;
  readonly workspaceAccessMode?: WorkspaceAccessMode;
  readonly permissionPreset?: PermissionPreset;
  readonly permissionConfirmation?: PermissionConfirmation;
  readonly requestedSkillId?: string;
  readonly skillOptimizationMode?: SkillOptimizationMode;
  readonly workspace?: DirectWorkspaceReady;
  readonly signal?: AbortSignal;
  readonly onWorkUnitStarted?: (handle: {
    readonly workUnitId: string;
    readonly messageId: string;
    readonly teammateId: string;
    readonly threadId: string;
  }) => void;
  readonly stream?: {
    readonly onReady: (message: TeammateDirectMessage) => void;
    readonly onRunLinked?: (message: TeammateDirectMessage) => void;
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
      flushTeammateDirectGovernanceNotifications(store, {
        teammateId,
        threadId: thread.id,
        ignoreDeliverAfter: true,
      });
      if (isLingAgentTeammateId(teammateId)) {
        flushLingAgentGovernanceNotificationDigests(store, {
          teammateId,
          ignoreDeliverAfter: true,
        });
      }
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
      flushTeammateDirectGovernanceNotifications(store, {
        teammateId,
        threadId: thread.id,
        ignoreDeliverAfter: true,
      });
      if (isLingAgentTeammateId(teammateId)) {
        flushLingAgentGovernanceNotificationDigests(store, {
          teammateId,
          ignoreDeliverAfter: true,
        });
      }
      const page = store.listTeammateDirectMessagesPage({
        teammateId,
        threadId: thread.id,
        beforeMessageId: url.searchParams.get("beforeMessageId") ?? undefined,
        limit: readOptionalIntegerQuery(url, "limit", 1),
      });
      const visibleMessages = url.searchParams.get("includeSuperseded") === "true"
        ? page.messages
        : filterSupersededTeammateDirectMessages(page.messages, buildConversationSupersessionProjection(store, {
            surfaces: ["teammate_direct"],
            ownerId: teammateId,
            laneId: thread.id,
          }));
      const messages = enrichTeammateDirectMessagesWithWebEvidence(store, visibleMessages.map((message) => projectTeammateDirectMessageRevisionMetadata(store, message)));
      writeJson(response, 200, {
        cwd,
        teammateId,
        thread,
        messages,
        hasMore: page.hasMore,
        nextBeforeMessageId: page.nextBeforeMessageId,
      });
      return;
    }

    if (request.method === "POST") {
      const body = await readJsonBody(request, config.maxBodyBytes);
      const input = parseTeammateDirectMessageRequest(body);
      assertDirectFileRefsWithinWorkspace({
        thread,
        workspaceCwd: store.paths.cwd,
        workspacePaths: store.paths,
        fileRefs: input.fileRefs,
      });
      const now = new Date().toISOString();
      const message = store.createTeammateDirectMessage(
        {
          threadId: thread.id,
          teammateId,
          authorType: "local-user",
          authorId: "local-user",
          body: input.body,
          attachmentIds: input.attachmentIds,
          linkPreviewIds: input.linkPreviewIds,
          fileRefs: input.fileRefs,
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
            authorizationMode: input.authorizationMode,
            workspaceAccessMode: input.workspaceAccessMode,
            permissionPreset: input.permissionPreset,
            permissionConfirmation: input.permissionConfirmation,
            requestedSkillId: input.requestedSkillId,
            skillOptimizationMode: input.skillOptimizationMode,
            workspace: undefined,
          })
        : undefined;
      writeJson(response, 201, aiReply ? { message, aiReply: enrichTeammateDirectMessageWithWebEvidence(store, aiReply) } : { message });
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
  activeDirectReplies?: ActiveDirectReplyRegistry,
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
    assertDirectFileRefsWithinWorkspace({
      thread,
      workspaceCwd: store.paths.cwd,
      workspacePaths: store.paths,
      fileRefs: messageInput.fileRefs,
    });
    const now = new Date().toISOString();
    const message = store.createTeammateDirectMessage(
      {
        threadId: thread.id,
        teammateId: teammate.id,
        authorType: "local-user",
        authorId: "local-user",
        body: messageInput.body,
        attachmentIds: messageInput.attachmentIds,
        linkPreviewIds: messageInput.linkPreviewIds,
        fileRefs: messageInput.fileRefs,
      },
      now,
    );
    const abortController = new AbortController();
    let registeredWorkUnitId: string | undefined;
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
        authorizationMode: messageInput.authorizationMode,
        workspaceAccessMode: messageInput.workspaceAccessMode,
        permissionPreset: messageInput.permissionPreset,
        permissionConfirmation: messageInput.permissionConfirmation,
        requestedSkillId: messageInput.requestedSkillId,
        skillOptimizationMode: messageInput.skillOptimizationMode,
        signal: abortController.signal,
        onWorkUnitStarted: (handle) => {
          registeredWorkUnitId = handle.workUnitId;
          activeDirectReplies?.register({ ...handle, abortController });
        },
        stream: {
          onReady: (aiReply) => safeWriteSse("ready", { message, aiReply }),
          onRunLinked: (aiReply) => safeWriteSse("run_linked", { messageId: aiReply.id, linkedRunId: aiReply.linkedRunId }),
          onDelta: (aiReply, delta) => safeWriteSse("delta", {
            messageId: aiReply.id,
            delta,
            body: aiReply.body,
          }),
          onDone: (aiReply) => safeWriteSse("done", { message, aiReply: enrichTeammateDirectMessageWithWebEvidence(store, aiReply) }),
          onBlocked: (aiReply) => {
            const enrichedReply = enrichTeammateDirectMessageWithWebEvidence(store, aiReply);
            safeWriteSse(aiReply.status === "failed" ? "error" : "blocked", { message, aiReply: enrichedReply, error: aiReply.errorMessage });
          },
        },
      });
    } catch (error) {
      safeWriteSse("error", { message, error: error instanceof Error ? error.message : String(error) });
    } finally {
      if (registeredWorkUnitId) {
        activeDirectReplies?.delete(registeredWorkUnitId);
      }
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
