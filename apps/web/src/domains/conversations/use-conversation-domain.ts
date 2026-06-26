import { useCallback, useState } from "react";
import { getConversation, listLingThreads, streamConversation } from "../../api.js";
import { readSseResponse } from "../../sse.js";
import type {
  ConversationDetailResponse,
  ConversationStreamBlockedEvent,
  ConversationStreamDoneEvent,
  ConversationStreamReadyEvent,
  ConversationStreamRunEvent,
  ConversationTranscriptMessage,
  LingThread,
  PermissionPreset,
  ProviderThinkingMode,
  ResponseLanguagePreference,
  RunThinkingLevel,
  RunTool,
  SessionPermissionMode,
} from "../../types.js";

export interface ConversationSendInput {
  readonly message: string;
  readonly projectPath?: string;
  readonly providerPresetId: string;
  readonly thinkingLevel?: ProviderThinkingMode;
  readonly permissionPreset?: PermissionPreset;
  readonly permissionMode?: SessionPermissionMode;
  readonly responseLanguage?: ResponseLanguagePreference;
  readonly tools?: readonly RunTool[];
}

export interface ConversationStreamHandlers {
  readonly onReady?: (event: ConversationStreamReadyEvent) => void;
  readonly onRunEvent?: (event: ConversationStreamRunEvent) => void;
  readonly onDone?: (event: ConversationStreamDoneEvent) => void;
  readonly onBlocked?: (event: ConversationStreamBlockedEvent) => void;
  readonly onError?: (message: string, event?: ConversationStreamBlockedEvent) => void;
}

export function useConversationDomain(input: {
  readonly cwd: string;
  readonly setErrorMessage: (message: string) => void;
}): {
  readonly state: {
    readonly conversationThreads: readonly LingThread[];
    readonly conversationsLoading: boolean;
    readonly selectedConversationThreadId: string;
    readonly selectedConversationDetail?: ConversationDetailResponse;
    readonly conversationStreamBusy: boolean;
  };
  readonly actions: {
    readonly refreshConversationThreads: (cwd?: string) => Promise<void>;
    readonly openNewConversation: () => void;
    readonly selectConversationThread: (threadId: string, cwd?: string) => Promise<void>;
    readonly sendConversationMessage: (message: ConversationSendInput, handlers?: ConversationStreamHandlers) => Promise<void>;
  };
} {
  const [conversationThreads, setConversationThreads] = useState<readonly LingThread[]>([]);
  const [conversationsLoading, setConversationsLoading] = useState(false);
  const [selectedConversationThreadId, setSelectedConversationThreadId] = useState("");
  const [selectedConversationDetail, setSelectedConversationDetail] = useState<ConversationDetailResponse | undefined>();
  const [conversationStreamBusy, setConversationStreamBusy] = useState(false);

  const refreshConversationThreads = useCallback(async (cwd = input.cwd): Promise<void> => {
    const workspaceCwd = cwd.trim();
    if (!workspaceCwd) {
      setConversationThreads([]);
      return;
    }
    setConversationsLoading(true);
    try {
      const response = await listLingThreads(workspaceCwd, { kind: "conversation", archived: "exclude", limit: 20 });
      setConversationThreads(response.threads);
    } catch (error) {
      input.setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setConversationsLoading(false);
    }
  }, [input]);

  const openNewConversation = useCallback((): void => {
    setSelectedConversationThreadId("");
    setSelectedConversationDetail(undefined);
  }, []);

  const selectConversationThread = useCallback(async (threadId: string, cwd = input.cwd): Promise<void> => {
    const workspaceCwd = cwd.trim();
    if (!workspaceCwd || !threadId) {
      openNewConversation();
      return;
    }
    setSelectedConversationThreadId(threadId);
    setConversationsLoading(true);
    try {
      const detail = await getConversation(workspaceCwd, threadId);
      setSelectedConversationDetail(detail);
      input.setErrorMessage("");
    } catch (error) {
      input.setErrorMessage(error instanceof Error ? error.message : String(error));
      setSelectedConversationDetail(undefined);
    } finally {
      setConversationsLoading(false);
    }
  }, [input, openNewConversation]);

  const sendConversationMessage = useCallback(async (
    message: ConversationSendInput,
    handlers: ConversationStreamHandlers = {},
  ): Promise<void> => {
    const workspaceCwd = input.cwd.trim();
    if (!workspaceCwd) {
      const errorMessage = "Local workspace is not ready.";
      input.setErrorMessage(errorMessage);
      handlers.onError?.(errorMessage);
      return;
    }

    setConversationStreamBusy(true);
    try {
      input.setErrorMessage("");
      const response = await streamConversation(workspaceCwd, {
        threadId: selectedConversationThreadId || undefined,
        message: message.message,
        projectPath: message.projectPath,
        providerPresetId: message.providerPresetId,
        thinkingLevel: normalizeThinkingLevel(message.thinkingLevel),
        permissionPreset: message.permissionPreset,
        permissionMode: message.permissionMode,
        responseLanguage: message.responseLanguage,
        tools: message.tools,
      });
      if (!response.ok || !response.body) {
        throw new Error(await readResponseError(response));
      }
      let activeThreadId = selectedConversationThreadId;
      await readSseResponse(response, (parsed) => {
        if (parsed.event === "ready") {
          const event = JSON.parse(parsed.data) as ConversationStreamReadyEvent;
          activeThreadId = event.thread.id;
          setSelectedConversationThreadId(event.thread.id);
          setSelectedConversationDetail((current) => mergeConversationMessages(current, workspaceCwd, event.thread, [
            event.userMessage,
            event.assistantMessage,
          ]));
          handlers.onReady?.(event);
          return;
        }
        if (parsed.event === "run_event") {
          const event = JSON.parse(parsed.data) as ConversationStreamRunEvent;
          if (event.assistantMessage) {
            setSelectedConversationDetail((current) => mergeConversationMessages(current, workspaceCwd, undefined, [event.assistantMessage as ConversationTranscriptMessage]));
          }
          handlers.onRunEvent?.(event);
          return;
        }
        if (parsed.event === "done") {
          const event = JSON.parse(parsed.data) as ConversationStreamDoneEvent;
          activeThreadId = event.thread.id;
          setSelectedConversationThreadId(event.thread.id);
          setSelectedConversationDetail((current) => mergeConversationMessages(current, workspaceCwd, event.thread, [event.assistantMessage]));
          handlers.onDone?.(event);
          return;
        }
        if (parsed.event === "blocked") {
          const event = JSON.parse(parsed.data) as ConversationStreamBlockedEvent;
          if (event.thread) {
            activeThreadId = event.thread.id;
            setSelectedConversationThreadId(event.thread.id);
          }
          if (event.assistantMessage) {
            setSelectedConversationDetail((current) => mergeConversationMessages(current, workspaceCwd, event.thread, [event.assistantMessage as ConversationTranscriptMessage]));
          }
          handlers.onBlocked?.(event);
          return;
        }
        if (parsed.event === "error") {
          const event = JSON.parse(parsed.data) as ConversationStreamBlockedEvent;
          const messageText = event.error || event.assistantMessage?.content || "Ling Agent run failed.";
          if (event.assistantMessage) {
            setSelectedConversationDetail((current) => mergeConversationMessages(current, workspaceCwd, event.thread, [event.assistantMessage as ConversationTranscriptMessage]));
          }
          handlers.onError?.(messageText, event);
        }
      });
      await refreshConversationThreads(workspaceCwd);
      if (activeThreadId) {
        const detail = await getConversation(workspaceCwd, activeThreadId);
        setSelectedConversationDetail(detail);
      }
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      input.setErrorMessage(messageText);
      handlers.onError?.(messageText);
    } finally {
      setConversationStreamBusy(false);
    }
  }, [input, refreshConversationThreads, selectedConversationThreadId]);

  return {
    state: {
      conversationThreads,
      conversationsLoading,
      selectedConversationThreadId,
      selectedConversationDetail,
      conversationStreamBusy,
    },
    actions: {
      refreshConversationThreads,
      openNewConversation,
      selectConversationThread,
      sendConversationMessage,
    },
  };
}

function mergeConversationMessages(
  current: ConversationDetailResponse | undefined,
  cwd: string,
  thread: LingThread | undefined,
  messages: readonly ConversationTranscriptMessage[],
): ConversationDetailResponse {
  const byId = new Map<string, ConversationTranscriptMessage>();
  for (const message of current?.messages ?? []) {
    byId.set(conversationMessageMergeKey(message), message);
  }
  for (const message of messages) {
    byId.set(conversationMessageMergeKey(message), message);
  }
  return {
    cwd: current?.cwd ?? cwd,
    thread: thread ?? current?.thread ?? messagesThreadFallback(messages),
    turns: current?.turns ?? [],
    runs: current?.runs ?? [],
    messages: [...byId.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
    defaults: current?.defaults ?? {},
  };
}

function conversationMessageMergeKey(message: ConversationTranscriptMessage): string {
  return message.turnId && (message.role === "user" || message.role === "assistant")
    ? `${message.role}:${message.turnId}`
    : message.id;
}

function messagesThreadFallback(messages: readonly ConversationTranscriptMessage[]): LingThread {
  const now = new Date().toISOString();
  return {
    id: messages[0]?.threadId ?? "pending-conversation",
    workspaceId: "default",
    kind: "conversation",
    title: "Conversation",
    objective: "Conversation",
    status: "running",
    createdAt: now,
    updatedAt: now,
  };
}

function normalizeThinkingLevel(level: ProviderThinkingMode | undefined): RunThinkingLevel | undefined {
  if (!level || level === "off" || level === "auto") {
    return undefined;
  }
  return level;
}

async function readResponseError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { readonly message?: unknown; readonly error?: unknown };
    if (typeof body.message === "string") {
      return body.message;
    }
    if (typeof body.error === "string") {
      return body.error;
    }
  } catch {
    // Fall through to status text.
  }
  return `${response.status} ${response.statusText}`.trim();
}
