import type { IncomingMessage, ServerResponse } from "node:http";
import type { LingThread, LingTurn, RunSession, RunStore } from "@ling-stack/core";
import { NormalConversationForkSourceInUseError } from "@ling-stack/core";
import { HttpError } from "../../errors.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { readOptionalJsonBody } from "../../shared/request.js";
import { redactTextWithSecrets } from "../../shared/redaction.js";
import { writeJson } from "../../shared/response.js";
import { isRecord, readOptionalString } from "../../shared/validation.js";
import { deleteAttachmentPath } from "../channels/attachments.js";

export async function handleLingThreadHardDelete(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  storeRegistry: RunStoreRegistry,
  threadId: string,
  maxBodyBytes = 1024 * 1024,
): Promise<void> {
  if (request.method !== "POST") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for thread hard delete` });
    return;
  }
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }
  try {
    const store = storeRegistry.getStore(cwd);
    const thread = store.getLingThread(threadId);
    if (!thread) {
      throw new HttpError(404, "thread_not_found", `Ling thread not found: ${threadId}`);
    }
    if (thread.kind !== "conversation") {
      throw new HttpError(409, "thread_delete_kind_unsupported", `Only conversation threads can be permanently deleted: ${threadId}`);
    }
    if (!thread.archivedAt && thread.status !== "archived") {
      throw new HttpError(409, "thread_not_archived", `Conversation thread must be archived before delete: ${threadId}`);
    }
    assertLingThreadCanHardDelete(store, thread);
    const blockingAutomation = store
      .listAutomationDefinitions({ includeArchived: true, limit: 500 })
      .find((automation) =>
        automation.status === "enabled" &&
        (automation.targetThreadId === threadId || automation.target.threadId === threadId)
      );
    if (blockingAutomation) {
      throw new HttpError(
        409,
        "thread_automation_target",
        `Conversation is still targeted by automation: ${blockingAutomation.title}`,
      );
    }
    const body = await readOptionalJsonBody(request, maxBodyBytes);
    const rawReason = isRecord(body) ? readOptionalString(body, "reason")?.trim() : undefined;
    const reason = rawReason ? truncateReason(redactTextWithSecrets(rawReason)) : undefined;
    const result = store.hardDeleteLingThread(threadId, { reason }, new Date().toISOString());
    if (!result) {
      throw new HttpError(404, "thread_not_found", `Ling thread not found: ${threadId}`);
    }
    for (const path of result.deletedAttachmentPaths) {
      deleteAttachmentPath(store, path);
    }
    writeJson(response, 200, { tombstone: result.tombstone });
  } catch (error) {
    if (error instanceof NormalConversationForkSourceInUseError) {
      writeJson(response, 409, { error: error.code, message: error.message });
      return;
    }
    writeJson(response, error instanceof HttpError ? error.statusCode : 400, {
      error: error instanceof HttpError ? error.code : "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function assertLingThreadCanHardDelete(store: RunStore, thread: LingThread): void {
  const activeLinkedRun = store
    .listRuns({ threadId: thread.id, limit: 500 })
    .find((run) => !isTerminalRunStatus(run.status));
  if (activeLinkedRun) {
    throw new HttpError(409, "active_thread_archive_blocked", `Cannot delete thread with active work: ${activeLinkedRun.id}`);
  }
  if (thread.activeRunId) {
    const activeRun = store.getRun(thread.activeRunId);
    if (!activeRun || !isTerminalRunStatus(activeRun.status)) {
      throw new HttpError(409, "active_thread_archive_blocked", `Cannot delete thread with active work: ${thread.id}`);
    }
  }
  const activeTurn = store
    .listLingTurns({ threadId: thread.id, limit: 500 })
    .find((turn) => isLingTurnBlockingDelete(turn, turn.activeRunId ? store.getRun(turn.activeRunId) : undefined));
  if (activeTurn) {
    throw new HttpError(409, "active_thread_archive_blocked", `Cannot delete thread with active turn: ${activeTurn.id}`);
  }
}

function isLingTurnBlockingDelete(turn: LingTurn, activeRun: RunSession | undefined): boolean {
  if (activeRun && !isTerminalRunStatus(activeRun.status)) {
    return true;
  }
  if (turn.status === "running" || turn.status === "waiting_for_approval" || turn.status === "blocked") {
    return true;
  }
  return turn.status === "open" && Boolean(turn.activeRunId || turn.lastRunId);
}

function isTerminalRunStatus(status: RunSession["status"]): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

function truncateReason(reason: string): string {
  return reason.length > 500 ? reason.slice(0, 500) : reason;
}
