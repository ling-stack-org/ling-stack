import type { IncomingMessage, ServerResponse } from "node:http";
import {
  DEFAULT_WORKSPACE_ID,
  LING_AGENT_ID,
  type LingThread,
  type LingTurn,
  type RunEventEnvelope,
  type RunSession,
  type RunStore,
} from "@ling-stack/core";
import type {
  ConversationDetailResponse,
  ConversationStreamRequest,
  ConversationTranscriptMessage,
  ConversationTranscriptStatus,
  PermissionPreset,
  ResponseLanguagePreference,
  RunThinkingLevel,
  RunTool,
  SessionPermissionMode,
} from "@ling-stack/contracts";
import type { ResolvedDaemonConfig } from "../../config.js";
import { HttpError } from "../../errors.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { readJsonBody } from "../../shared/request.js";
import { writeJson, writeSse, writeSseHead } from "../../shared/response.js";
import { isRecord, readOptionalString, readOptionalStringArray, readString } from "../../shared/validation.js";
import { inferUserLanguage, responseLanguageInstruction } from "../channels/response-language.js";
import type { RunExecutionSink } from "../runs/orchestrator.js";
import type { RunRequest } from "../runs/schemas.js";

type StartConversationRun = (runRequest: RunRequest, sink: RunExecutionSink) => Promise<string | undefined>;

const defaultConversationTools: readonly RunTool[] = ["read", "grep", "find", "ls", "bash", "edit", "write"];
const thinkingLevels: readonly RunThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
const runTools: readonly RunTool[] = ["read", "grep", "find", "ls", "bash", "edit", "write"];
const permissionPresets: readonly PermissionPreset[] = ["read_only", "workspace_collaboration", "full_access", "custom"];
const permissionModes: readonly SessionPermissionMode[] = ["ask_everything", "balanced", "workspace_write", "full_access", "custom"];
const responseLanguagePreferences: readonly ResponseLanguagePreference[] = ["follow_user", "zh-CN", "en-US"];

export async function handleConversationStream(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  startRun: StartConversationRun,
): Promise<void> {
  if (request.method !== "POST") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for conversation stream` });
    return;
  }
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const workspaceCwd = url.searchParams.get("cwd");
  if (!workspaceCwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const input = parseConversationStreamRequest(await readJsonBody(request, config.maxBodyBytes));
    const store = storeRegistry.getStore(workspaceCwd);
    const now = new Date().toISOString();
    const thread = resolveConversationThread(store, input, now);
    const turn = store.createLingTurn({
      threadId: thread.id,
      kind: thread.metadata?.lastTurnId ? "manual_followup" : "initial_request",
      title: conversationTitle(input.message),
      userInstruction: input.message.trim(),
      teammateId: LING_AGENT_ID,
      createdByActor: "local-user",
    }, now);
    const userMessage = createUserTranscriptMessage(thread, turn);
    let assistantMessage = createAssistantTranscriptMessage(thread, turn, undefined, "", "running", now);
    let runId = "";
    let closed = false;

    response.on("close", () => {
      closed = true;
    });
    const safeWrite = (event: string, data: unknown): void => {
      if (!closed && !response.destroyed) {
        writeSse(response, event, data);
      }
    };
    const streamSink: RunExecutionSink = {
      kind: "sse",
      onClose(listener) {
        response.on("close", listener);
      },
      isClosed() {
        return closed || response.destroyed;
      },
      writeReady(data) {
        const ready = data as { readonly runId?: unknown };
        if (typeof ready.runId === "string") {
          runId = ready.runId;
          assistantMessage = { ...assistantMessage, runId };
        }
        safeWrite("ready", { thread, turn, userMessage, assistantMessage, runId: runId || undefined });
      },
      writeEvent(_event, data) {
        const envelope = data as RunEventEnvelope;
        if (envelope.type === "assistant_text_delta") {
          assistantMessage = {
            ...assistantMessage,
            content: assistantMessage.content + readEventText(envelope),
            status: "running",
            updatedAt: envelope.ts,
          };
        } else if (envelope.type === "run_error") {
          assistantMessage = {
            ...assistantMessage,
            content: readEventError(envelope) || assistantMessage.content || conversationRunFailedContent(input.responseLanguage, input.message),
            status: "failed",
            updatedAt: envelope.ts,
          };
        } else if (envelope.type === "run_cancelled") {
          assistantMessage = {
            ...assistantMessage,
            status: "cancelled",
            updatedAt: envelope.ts,
          };
        }
        safeWrite("run_event", {
          threadId: thread.id,
          turnId: turn.id,
          runId: runId || envelope.runId,
          event: envelope,
          assistantMessage,
        });
      },
      writeError(_statusCode, body) {
        const message = readErrorBodyMessage(body, input.responseLanguage, input.message);
        assistantMessage = { ...assistantMessage, content: message, status: "failed", updatedAt: new Date().toISOString() };
        safeWrite("error", { thread, turn, assistantMessage, error: message });
      },
      end() {
        const latestRun = runId ? store.getRun(runId) : undefined;
        const latestThread = store.getLingThread(thread.id) ?? thread;
        const latestTurn = store.getLingTurn(turn.id) ?? turn;
        const terminalStatus = statusFromRun(latestRun) ?? assistantMessage.status;
        const finalAssistant = {
          ...assistantMessage,
          status: terminalStatus,
          content: assistantMessage.content || fallbackAssistantContent(terminalStatus, input.responseLanguage, input.message),
          updatedAt: latestRun?.updatedAt ?? new Date().toISOString(),
        };
        if (latestRun && (terminalStatus === "succeeded" || terminalStatus === "cancelled")) {
          safeWrite("done", { thread: latestThread, turn: latestTurn, run: latestRun, assistantMessage: finalAssistant });
        } else {
          safeWrite("blocked", { thread: latestThread, turn: latestTurn, run: latestRun, assistantMessage: finalAssistant, error: finalAssistant.content });
        }
        if (!closed) {
          response.end();
        }
      },
    };

    writeSseHead(response);
    safeWrite("ready", { thread, turn, userMessage, assistantMessage });
    const runRequest = buildConversationRunRequest({ workspaceCwd, thread, turn, input });
    await startRun(runRequest, streamSink);
  } catch (error) {
    writeJson(response, error instanceof HttpError ? error.statusCode : 400, {
      error: error instanceof HttpError ? error.code : "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export function handleConversationDetail(
  response: ServerResponse,
  url: URL,
  storeRegistry: RunStoreRegistry,
  threadId: string,
): void {
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }
  try {
    const store = storeRegistry.getStore(cwd);
    const thread = store.getLingThread(threadId);
    if (!thread || thread.kind !== "conversation") {
      writeJson(response, 404, { error: "conversation_not_found", message: `Conversation not found: ${threadId}` });
      return;
    }
    writeJson(response, 200, buildConversationDetail(store, cwd, thread));
  } catch (error) {
    writeJson(response, 400, {
      error: "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export function buildConversationDetail(store: RunStore, cwd: string, thread: LingThread): ConversationDetailResponse {
  const turns = [...store.listLingTurns({ threadId: thread.id, limit: 200 })].reverse();
  const runLinks = turns.flatMap((turn) => store.listLingTurnRuns(turn.id));
  const runs = runLinks
    .map((link) => store.getRun(link.runId))
    .filter((run): run is RunSession => Boolean(run))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const runByTurnId = new Map(runLinks.map((link) => [link.turnId, store.getRun(link.runId)]));
  const messages = turns.flatMap((turn) => {
    const user = createUserTranscriptMessage(thread, turn);
    const run = runByTurnId.get(turn.id);
    return run ? [user, assistantMessageFromRun(store, thread, turn, run)] : [user];
  });
  const latestRun = runs[runs.length - 1];
  const latestSnapshot = readRecord(latestRun?.requestSnapshot);
  const latestProjectPath = latestRun?.cwd && latestRun.cwd !== cwd ? latestRun.cwd : undefined;
  return {
    cwd,
    thread,
    turns,
    runs,
    messages,
    defaults: {
      projectPath: readOptionalRecordString(latestSnapshot, "projectPath") || latestProjectPath,
      providerPresetId: latestRun?.providerPresetId ?? readOptionalRecordString(latestSnapshot, "providerPresetId"),
      thinkingLevel: readThinkingLevel(readOptionalRecordString(latestSnapshot, "thinkingLevel")),
      permissionPreset: readPermissionPreset(readOptionalRecordString(latestSnapshot, "permissionPreset")),
      permissionMode: readPermissionMode(readOptionalRecordString(latestSnapshot, "permissionMode")),
    },
  };
}

function parseConversationStreamRequest(value: unknown): ConversationStreamRequest {
  if (!isRecord(value)) {
    throw new Error("Conversation request must be a JSON object.");
  }
  const message = readString(value, "message").trim();
  if (!message) {
    throw new Error("message is required.");
  }
  const providerPresetId = readString(value, "providerPresetId").trim();
  if (!providerPresetId) {
    throw new Error("providerPresetId is required.");
  }
  return {
    threadId: readOptionalString(value, "threadId")?.trim() || undefined,
    message,
    projectPath: readOptionalString(value, "projectPath")?.trim() || undefined,
    providerPresetId,
    thinkingLevel: readThinkingLevel(readOptionalString(value, "thinkingLevel")),
    permissionPreset: readPermissionPreset(readOptionalString(value, "permissionPreset")),
    permissionMode: readPermissionMode(readOptionalString(value, "permissionMode")),
    responseLanguage: readResponseLanguagePreference(readOptionalString(value, "responseLanguage")),
    tools: readOptionalStringArray(value, "tools", runTools),
    idempotencyKey: readOptionalString(value, "idempotencyKey")?.trim() || undefined,
  };
}

function resolveConversationThread(store: RunStore, input: ConversationStreamRequest, now: string): LingThread {
  if (input.threadId) {
    const thread = store.getLingThread(input.threadId);
    if (!thread || thread.kind !== "conversation") {
      throw new HttpError(404, "conversation_not_found", `Conversation not found: ${input.threadId}`);
    }
    if (thread.status === "archived") {
      throw new HttpError(409, "conversation_archived", `Conversation is archived: ${thread.id}`);
    }
    return thread;
  }
  return store.createLingThread({
    kind: "conversation",
    teammateId: LING_AGENT_ID,
    title: conversationTitle(input.message),
    objective: input.message.trim(),
    status: "open",
  }, now);
}

function buildConversationRunRequest(input: {
  readonly workspaceCwd: string;
  readonly thread: LingThread;
  readonly turn: LingTurn;
  readonly input: ConversationStreamRequest;
}): RunRequest {
  return {
    workspaceCwd: input.workspaceCwd,
    cwd: input.input.projectPath || input.workspaceCwd,
    task: {
      id: conversationRunTaskId(input.turn.id),
      title: input.turn.title,
      prompt: buildConversationRunPrompt(input.input.message, input.input.responseLanguage),
    },
    threadId: input.thread.id,
    turnId: input.turn.id,
    teammateId: LING_AGENT_ID,
    providerPresetId: input.input.providerPresetId,
    tools: input.input.tools ?? defaultConversationTools,
    permissionPreset: input.input.permissionPreset,
    permissionMode: input.input.permissionMode,
    thinkingLevel: input.input.thinkingLevel,
    idempotencyKey: input.input.idempotencyKey ?? `conversation:${input.turn.id}`,
  };
}

function createUserTranscriptMessage(thread: LingThread, turn: LingTurn): ConversationTranscriptMessage {
  return {
    id: `conversation-user:${turn.id}`,
    role: "user",
    content: turn.userInstruction,
    status: statusFromTurn(turn),
    threadId: thread.id,
    turnId: turn.id,
    createdAt: turn.createdAt,
    updatedAt: turn.updatedAt,
  };
}

function createAssistantTranscriptMessage(
  thread: LingThread,
  turn: LingTurn,
  run: RunSession | undefined,
  content: string,
  status: ConversationTranscriptStatus,
  now: string,
): ConversationTranscriptMessage {
  return {
    id: conversationAssistantMessageId(turn.id),
    role: "assistant",
    authorId: LING_AGENT_ID,
    authorLabel: "Ling Agent",
    content,
    status,
    threadId: thread.id,
    turnId: turn.id,
    runId: run?.id,
    createdAt: run?.createdAt ?? now,
    updatedAt: run?.updatedAt ?? now,
  };
}

function assistantMessageFromRun(store: RunStore, thread: LingThread, turn: LingTurn, run: RunSession): ConversationTranscriptMessage {
  const events = store.listEvents(run.id, { limit: 1000 });
  const content = events.filter((event) => event.type === "assistant_text_delta").map(readEventText).join("");
  const error = [...events].reverse().map(readEventError).find(Boolean);
  const status = statusFromRun(run) ?? "running";
  const requestSnapshot = readRecord(run.requestSnapshot);
  const responseLanguage = readResponseLanguagePreference(readOptionalRecordString(requestSnapshot, "responseLanguage"));
  return createAssistantTranscriptMessage(
    thread,
    turn,
    run,
    content || error || fallbackAssistantContent(status, responseLanguage, turn.userInstruction),
    status,
    run.updatedAt,
  );
}

function statusFromTurn(turn: LingTurn): ConversationTranscriptStatus {
  if (turn.status === "failed") {
    return "failed";
  }
  if (turn.status === "blocked" || turn.status === "waiting_for_approval") {
    return "blocked";
  }
  if (turn.status === "cancelled" || turn.status === "superseded") {
    return "cancelled";
  }
  if (turn.status === "running") {
    return "running";
  }
  return "succeeded";
}

function statusFromRun(run: RunSession | undefined): ConversationTranscriptStatus | undefined {
  if (!run) {
    return undefined;
  }
  if (run.status === "failed") {
    return "failed";
  }
  if (run.status === "waiting_for_approval") {
    return "blocked";
  }
  if (run.status === "cancelled") {
    return "cancelled";
  }
  if (run.status === "queued" || run.status === "running") {
    return "running";
  }
  return "succeeded";
}

function conversationTitle(message: string): string {
  const oneLine = message.replace(/\s+/g, " ").trim();
  return oneLine.length > 48 ? `${oneLine.slice(0, 45)}...` : oneLine || "New conversation";
}

function conversationRunTaskId(turnId: string): string {
  return `conversation:${turnId}`;
}

function conversationAssistantMessageId(turnId: string): string {
  return `conversation-assistant:${turnId}`;
}

function readEventText(event: RunEventEnvelope): string {
  return readOptionalRecordString(readRecord(event.data), "text") ?? "";
}

function readEventError(event: RunEventEnvelope): string {
  const data = readRecord(event.data);
  return readOptionalRecordString(data, "message") || readOptionalRecordString(data, "error") || "";
}

function readErrorBodyMessage(body: unknown, responseLanguage: ResponseLanguagePreference | undefined, message: string): string {
  return readOptionalRecordString(readRecord(body), "message") || conversationRunFailedBeforeStartContent(responseLanguage, message);
}

function fallbackAssistantContent(status: ConversationTranscriptStatus, responseLanguage: ResponseLanguagePreference | undefined, message: string): string {
  if (status === "running") {
    return "";
  }
  const language = resolveConversationResponseLanguage(responseLanguage, message);
  if (status === "cancelled") {
    return language === "zh-CN" ? "这次运行已取消。" : "Ling Agent run was cancelled.";
  }
  if (status === "succeeded") {
    return language === "zh-CN" ? "这次运行已完成，但没有返回文本内容。" : "Ling Agent finished without text output.";
  }
  return conversationRunFailedContent(responseLanguage, message);
}

function conversationRunFailedContent(responseLanguage: ResponseLanguagePreference | undefined, message: string): string {
  return resolveConversationResponseLanguage(responseLanguage, message) === "zh-CN"
    ? "Ling 助手暂时无法完成这次请求。"
    : "Ling Agent could not complete this request.";
}

function conversationRunFailedBeforeStartContent(responseLanguage: ResponseLanguagePreference | undefined, message: string): string {
  return resolveConversationResponseLanguage(responseLanguage, message) === "zh-CN"
    ? "Ling 助手还没启动就遇到了问题，请稍后重试。"
    : "Ling Agent run failed before it started.";
}

function readRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function readOptionalRecordString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readThinkingLevel(value: string | undefined): RunThinkingLevel | undefined {
  return value && thinkingLevels.includes(value as RunThinkingLevel) ? value as RunThinkingLevel : undefined;
}

function readPermissionPreset(value: string | undefined): PermissionPreset | undefined {
  return value && permissionPresets.includes(value as PermissionPreset) ? value as PermissionPreset : undefined;
}

function readPermissionMode(value: string | undefined): SessionPermissionMode | undefined {
  return value && permissionModes.includes(value as SessionPermissionMode) ? value as SessionPermissionMode : undefined;
}

function readResponseLanguagePreference(value: string | undefined): ResponseLanguagePreference | undefined {
  return value && responseLanguagePreferences.includes(value as ResponseLanguagePreference) ? value as ResponseLanguagePreference : undefined;
}

function resolveConversationResponseLanguage(responseLanguage: ResponseLanguagePreference | undefined, message: string): "zh-CN" | "en-US" {
  return responseLanguage === "zh-CN" || responseLanguage === "en-US"
    ? responseLanguage
    : inferUserLanguage(message);
}

function buildConversationRunPrompt(message: string, responseLanguage: ResponseLanguagePreference | undefined): string {
  const trimmedMessage = message.trim();
  return `${trimmedMessage}\n\n${responseLanguageInstruction(resolveConversationResponseLanguage(responseLanguage, trimmedMessage))}`;
}
