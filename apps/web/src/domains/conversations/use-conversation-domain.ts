import { useCallback, useState } from "react";
import { archiveLingThread, getConversation, listLingThreads, streamConversation } from "../../api.js";
import { readSseResponse } from "../../sse.js";
import type {
  AuthorizationMode,
  ConversationDetailResponse,
  ConversationStreamBlockedEvent,
  ConversationStreamDoneEvent,
  ConversationStreamReadyEvent,
  ConversationStreamRunEvent,
  ConversationTranscriptMessage,
  LingThread,
  PermissionConfirmation,
  PermissionPreset,
  ProviderThinkingMode,
  ResponseLanguagePreference,
  RunThinkingLevel,
  RunTool,
  SessionPermissionMode,
  WorkspaceAccessMode,
} from "../../types.js";

export interface ConversationSendInput {
  readonly message: string;
  readonly attachmentIds?: readonly string[];
  readonly projectPath?: string;
  readonly providerPresetId: string;
  readonly thinkingLevel?: ProviderThinkingMode;
  readonly authorizationMode?: AuthorizationMode;
  readonly workspaceAccessMode?: WorkspaceAccessMode;
  readonly permissionPreset?: PermissionPreset;
  readonly permissionMode?: SessionPermissionMode;
  readonly permissionConfirmation?: PermissionConfirmation;
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
  readonly translate: (key: string, values?: Record<string, string | number>) => string;
  readonly setErrorMessage: (message: string) => void;
}): {
  readonly state: {
    readonly conversationThreads: readonly LingThread[];
    readonly conversationsLoading: boolean;
    readonly selectedConversationThreadId: string;
    readonly selectedConversationDetail?: ConversationDetailResponse;
    readonly conversationStreamBusy: boolean;
    readonly conversationArchiveError: string;
  };
  readonly actions: {
    readonly refreshConversationThreads: (cwd?: string) => Promise<void>;
    readonly refreshSelectedConversation: (cwd?: string) => Promise<void>;
    readonly openNewConversation: () => void;
    readonly selectConversationThread: (threadId: string, cwd?: string) => Promise<void>;
    readonly archiveConversationThread: (threadId: string, cwd?: string) => Promise<void>;
    readonly archiveAllConversationThreads: (cwd?: string) => Promise<void>;
    readonly sendConversationMessage: (message: ConversationSendInput, handlers?: ConversationStreamHandlers) => Promise<void>;
  };
} {
  const [conversationThreads, setConversationThreads] = useState<readonly LingThread[]>([]);
  const [conversationsLoading, setConversationsLoading] = useState(false);
  const [selectedConversationThreadId, setSelectedConversationThreadId] = useState("");
  const [selectedConversationDetail, setSelectedConversationDetail] = useState<ConversationDetailResponse | undefined>();
  const [conversationStreamBusy, setConversationStreamBusy] = useState(false);
  const [conversationArchiveError, setConversationArchiveError] = useState("");

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

  const refreshSelectedConversation = useCallback(async (cwd = input.cwd): Promise<void> => {
    const workspaceCwd = cwd.trim();
    if (!workspaceCwd || !selectedConversationThreadId) {
      return;
    }
    setConversationsLoading(true);
    try {
      const detail = await getConversation(workspaceCwd, selectedConversationThreadId);
      setSelectedConversationDetail(detail);
      input.setErrorMessage("");
    } catch (error) {
      input.setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setConversationsLoading(false);
    }
  }, [input, selectedConversationThreadId]);

  const archiveConversationThread = useCallback(async (threadId: string, cwd = input.cwd): Promise<void> => {
    const workspaceCwd = cwd.trim();
    if (!workspaceCwd || !threadId) {
      return;
    }
    setConversationsLoading(true);
    try {
      input.setErrorMessage("");
      setConversationArchiveError("");
      await archiveLingThread(workspaceCwd, threadId, {
        reason: "sidebar_conversation_archived",
        idempotencyKey: `sidebar-conversation-archive:${threadId}`,
      });
      setConversationThreads((current) => current.filter((thread) => thread.id !== threadId));
      if (selectedConversationThreadId === threadId) {
        openNewConversation();
      }
      await refreshConversationThreads(workspaceCwd);
    } catch (error) {
      const message = formatConversationArchiveError(error, input.translate);
      setConversationArchiveError(message);
      input.setErrorMessage(message);
    } finally {
      setConversationsLoading(false);
    }
  }, [input, openNewConversation, refreshConversationThreads, selectedConversationThreadId]);

  const archiveAllConversationThreads = useCallback(async (cwd = input.cwd): Promise<void> => {
    const workspaceCwd = cwd.trim();
    const visibleThreads = conversationThreads.filter((thread) => !thread.archivedAt && thread.status !== "archived");
    if (!workspaceCwd || visibleThreads.length === 0) {
      setConversationArchiveError(input.translate("No conversations to archive"));
      return;
    }
    const confirmed = globalThis.confirm(input.translate("Archive all conversations? You can restore archived conversations from Settings."));
    if (!confirmed) {
      return;
    }
    setConversationsLoading(true);
    try {
      input.setErrorMessage("");
      setConversationArchiveError("");
      const results = await Promise.allSettled(
        visibleThreads.map((thread) => archiveLingThread(workspaceCwd, thread.id, {
          reason: "sidebar_all_conversations_archived",
          idempotencyKey: `sidebar-conversation-archive-all:${thread.id}`,
        })),
      );
      const archivedIds = new Set<string>();
      const failures: unknown[] = [];
      results.forEach((result, index) => {
        if (result.status === "fulfilled") {
          archivedIds.add(visibleThreads[index]?.id ?? "");
          return;
        }
        failures.push(result.reason);
      });
      if (archivedIds.size > 0) {
        setConversationThreads((current) => current.filter((thread) => !archivedIds.has(thread.id)));
        if (selectedConversationThreadId && archivedIds.has(selectedConversationThreadId)) {
          openNewConversation();
        }
      }
      await refreshConversationThreads(workspaceCwd);
      if (failures.length > 0) {
        const activeFailures = failures.filter((failure) => {
          const message = failure instanceof Error ? failure.message : String(failure);
          return message.includes("active_thread_archive_blocked") || message.includes("Cannot archive thread with active");
        }).length;
        const message = activeFailures === failures.length
          ? input.translate("{count} conversations still have active work and cannot be archived yet.", { count: failures.length })
          : input.translate("Archive conversation failed: {message}", {
            message: failures.map((failure) => failure instanceof Error ? failure.message : String(failure)).join("; "),
          });
        setConversationArchiveError(message);
        input.setErrorMessage(message);
      }
    } catch (error) {
      const message = formatConversationArchiveError(error, input.translate);
      setConversationArchiveError(message);
      input.setErrorMessage(message);
    } finally {
      setConversationsLoading(false);
    }
  }, [conversationThreads, input, openNewConversation, refreshConversationThreads, selectedConversationThreadId]);

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
        attachmentIds: message.attachmentIds,
        projectPath: message.projectPath,
        providerPresetId: message.providerPresetId,
        thinkingLevel: normalizeThinkingLevel(message.thinkingLevel),
        authorizationMode: message.authorizationMode,
        workspaceAccessMode: message.workspaceAccessMode,
        permissionPreset: message.permissionPreset,
        permissionMode: message.permissionMode,
        permissionConfirmation: message.permissionConfirmation,
        responseLanguage: message.responseLanguage,
        tools: message.tools,
      });
      if (!response.ok || !response.body) {
        throw new Error(await readResponseError(response));
      }
      let activeThreadId = selectedConversationThreadId;
      let evidenceRefreshTimer: ReturnType<typeof setTimeout> | undefined;
      let evidenceRefreshPromise: Promise<void> | undefined;
      let evidenceRefreshRequested = false;
      const refreshActiveConversationEvidence = (): Promise<void> => {
        if (!activeThreadId) {
          return Promise.resolve();
        }
        if (evidenceRefreshPromise) {
          evidenceRefreshRequested = true;
          return evidenceRefreshPromise;
        }
        const requestedThreadId = activeThreadId;
        evidenceRefreshPromise = (async () => {
          try {
            const detail = await getConversation(workspaceCwd, requestedThreadId);
            if (requestedThreadId === activeThreadId) {
              setSelectedConversationDetail((current) => mergeConversationDetailSnapshot(current, detail));
            }
          } catch {
            // The terminal refresh remains authoritative if an incremental refresh races startup.
          } finally {
            evidenceRefreshPromise = undefined;
            if (evidenceRefreshRequested) {
              evidenceRefreshRequested = false;
              scheduleEvidenceRefresh();
            }
          }
        })();
        return evidenceRefreshPromise;
      };
      const scheduleEvidenceRefresh = (): void => {
        evidenceRefreshRequested = true;
        if (evidenceRefreshTimer !== undefined || evidenceRefreshPromise) {
          return;
        }
        evidenceRefreshTimer = setTimeout(() => {
          evidenceRefreshTimer = undefined;
          evidenceRefreshRequested = false;
          void refreshActiveConversationEvidence();
        }, 250);
      };
      await readSseResponse(response, (parsed) => {
        if (parsed.event === "ready") {
          const event = JSON.parse(parsed.data) as ConversationStreamReadyEvent;
          activeThreadId = event.thread.id;
          setSelectedConversationThreadId(event.thread.id);
          setSelectedConversationDetail((current) => mergeConversationMessages(current, workspaceCwd, event.thread, [
            event.userMessage,
            event.assistantMessage,
          ]));
          scheduleEvidenceRefresh();
          handlers.onReady?.(event);
          return;
        }
        if (parsed.event === "run_event") {
          const event = JSON.parse(parsed.data) as ConversationStreamRunEvent;
          if (event.assistantMessage) {
            setSelectedConversationDetail((current) => mergeConversationMessages(current, workspaceCwd, undefined, [event.assistantMessage as ConversationTranscriptMessage]));
          }
          if (event.event.type === "tool_start" || event.event.type === "tool_update" || event.event.type === "tool_end") {
            scheduleEvidenceRefresh();
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
      if (evidenceRefreshTimer !== undefined) {
        clearTimeout(evidenceRefreshTimer);
      }
      evidenceRefreshRequested = false;
      await evidenceRefreshPromise;
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
      conversationArchiveError,
    },
    actions: {
      refreshConversationThreads,
      refreshSelectedConversation,
      openNewConversation,
      selectConversationThread,
      archiveConversationThread,
      archiveAllConversationThreads,
      sendConversationMessage,
    },
  };
}

function mergeConversationDetailSnapshot(
  current: ConversationDetailResponse | undefined,
  snapshot: ConversationDetailResponse,
): ConversationDetailResponse {
  if (!current || current.thread.id !== snapshot.thread.id) {
    return snapshot;
  }
  const messages = new Map(snapshot.messages.map((message) => [conversationMessageMergeKey(message), message]));
  for (const message of current.messages) {
    messages.set(conversationMessageMergeKey(message), message);
  }
  return {
    ...snapshot,
    messages: [...messages.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
  };
}

function formatConversationArchiveError(
  error: unknown,
  translate: (key: string, values?: Record<string, string | number>) => string,
): string {
  const rawMessage = error instanceof Error ? error.message : String(error);
  if (rawMessage.includes("active_thread_archive_blocked") || rawMessage.includes("Cannot archive thread with active")) {
    return translate("This conversation still has active work and cannot be archived yet.");
  }
  if (rawMessage.includes("thread_not_found")) {
    return translate("This conversation no longer exists. Refresh and try again.");
  }
  return translate("Archive conversation failed: {message}", { message: rawMessage });
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
    executionActions: current?.executionActions ?? [],
    terminalReports: current?.terminalReports ?? [],
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
    conversationMode: { mode: "default" },
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
