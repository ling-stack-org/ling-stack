import { useCallback, useEffect, useRef, useState } from "react";
import { archiveLingThread, getConversation, listLingThreads, streamConversation } from "../../api.js";
import { readSseResponse } from "../../sse.js";
import type {
  AuthorizationMode,
  ChannelMessageFileRef,
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
import {
  selectConversationError,
  useConversationErrorOwner,
  type ConversationErrorOperation,
} from "./conversation-error-owner.js";
import { createConversationDraftIdentity } from "./conversation-surface-identity.js";
import { useConversationStreamBusyOwner } from "./use-conversation-stream-busy-owner.js";

export interface ConversationSendInput {
  readonly message: string;
  readonly attachmentIds?: readonly string[];
  readonly fileRefs?: readonly ChannelMessageFileRef[];
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
  readonly onMessageAccepted?: (event: ConversationStreamReadyEvent) => void;
  readonly onReplyLinked?: (target: NonNullable<ConversationStreamReadyEvent["activeReply"]>) => void;
  readonly onRunEvent?: (event: ConversationStreamRunEvent) => void;
  readonly onDone?: (event: ConversationStreamDoneEvent) => void;
  readonly onBlocked?: (event: ConversationStreamBlockedEvent) => void;
  readonly onError?: (message: string, event?: ConversationStreamBlockedEvent) => void;
  readonly onThreadBound?: (threadId: string) => void;
  readonly shouldCommit?: (threadId?: string) => boolean;
}

export function useConversationDomain(input: {
  readonly cwd: string;
  readonly translate: (key: string, values?: Record<string, string | number>) => string;
}): {
  readonly state: {
    readonly conversationThreads: readonly LingThread[];
    readonly conversationThreadsLoading: boolean;
    readonly selectedConversationThreadId: string;
    readonly selectedConversationDetail?: ConversationDetailResponse;
    readonly conversationIdentity: string;
    readonly conversationStreamBusy: boolean;
    readonly conversationSidebarError: string;
    readonly conversationSurfaceError: string;
    readonly conversationComposerError: string;
  };
  readonly actions: {
    readonly refreshConversationThreads: (cwd?: string) => Promise<void>;
    readonly refreshSelectedConversation: (cwd?: string) => Promise<void>;
    readonly openNewConversation: () => void;
    readonly selectConversationThread: (
      threadId: string,
      cwd?: string,
      shouldCommit?: () => boolean,
    ) => Promise<boolean>;
    readonly archiveConversationThread: (threadId: string, cwd?: string) => Promise<void>;
    readonly archiveAllConversationThreads: (cwd?: string) => Promise<void>;
    readonly sendConversationMessage: (message: ConversationSendInput, handlers?: ConversationStreamHandlers) => Promise<void>;
  };
} {
  const [conversationThreads, setConversationThreads] = useState<readonly LingThread[]>([]);
  const [conversationThreadsLoading, setConversationThreadsLoading] = useState(false);
  const [selectedConversationThreadId, setSelectedConversationThreadId] = useState("");
  const [selectedConversationDetail, setSelectedConversationDetail] = useState<ConversationDetailResponse | undefined>();
  const [conversationSurfaceIdentity, setConversationSurfaceIdentity] = useState(createConversationDraftIdentity(0));
  const selectedConversationThreadIdRef = useRef("");
  const conversationDraftGenerationRef = useRef(0);
  const conversationSurfaceIdentityRef = useRef(createConversationDraftIdentity(0));
  const currentCwdRef = useRef(input.cwd.trim());
  const conversationOwnerCwdRef = useRef(input.cwd.trim());
  const selectionSequenceRef = useRef(0);
  const threadListLoadingOperationsRef = useRef(0);
  currentCwdRef.current = input.cwd.trim();
  const conversationErrors = useConversationErrorOwner();
  const conversationStreamBusyOwner = useConversationStreamBusyOwner();

  const beginThreadListLoading = useCallback((): void => {
    threadListLoadingOperationsRef.current += 1;
    setConversationThreadsLoading(true);
  }, []);

  const finishThreadListLoading = useCallback((): void => {
    threadListLoadingOperationsRef.current = Math.max(0, threadListLoadingOperationsRef.current - 1);
    if (threadListLoadingOperationsRef.current === 0) setConversationThreadsLoading(false);
  }, []);

  const commitSelectedConversationThreadId = useCallback((threadId: string): void => {
    selectedConversationThreadIdRef.current = threadId;
    setSelectedConversationThreadId(threadId);
  }, []);

  const commitConversationSurfaceIdentity = useCallback((identity: string): void => {
    conversationSurfaceIdentityRef.current = identity;
    setConversationSurfaceIdentity(identity);
  }, []);

  useEffect(() => {
    const workspaceCwd = input.cwd.trim();
    if (conversationOwnerCwdRef.current === workspaceCwd) return;
    conversationOwnerCwdRef.current = workspaceCwd;
    selectionSequenceRef.current += 1;
    const draftGeneration = conversationDraftGenerationRef.current + 1;
    conversationDraftGenerationRef.current = draftGeneration;
    commitSelectedConversationThreadId("");
    setSelectedConversationDetail(undefined);
    setConversationThreads([]);
    commitConversationSurfaceIdentity(createConversationDraftIdentity(draftGeneration));
  }, [commitConversationSurfaceIdentity, commitSelectedConversationThreadId, input.cwd]);

  const refreshConversationThreads = useCallback(async (cwd = input.cwd): Promise<void> => {
    const workspaceCwd = cwd.trim();
    if (!workspaceCwd) {
      setConversationThreads([]);
      return;
    }
    const operation = conversationErrors.begin({
      workspaceCwd,
      surface: "sidebar",
      identity: "list",
      scope: "load",
    });
    conversationErrors.clear(operation);
    beginThreadListLoading();
    try {
      const response = await listLingThreads(workspaceCwd, { kind: "conversation", archived: "exclude", limit: 20 });
      if (conversationErrors.isCurrent(operation) && currentCwdRef.current === workspaceCwd) {
        setConversationThreads(response.threads);
      }
    } catch (error) {
      conversationErrors.report(operation, error instanceof Error ? error.message : String(error));
    } finally {
      finishThreadListLoading();
    }
  }, [beginThreadListLoading, conversationErrors, finishThreadListLoading, input.cwd]);

  const openNewConversation = useCallback((): void => {
    selectionSequenceRef.current += 1;
    const draftGeneration = conversationDraftGenerationRef.current + 1;
    conversationDraftGenerationRef.current = draftGeneration;
    commitSelectedConversationThreadId("");
    setSelectedConversationDetail(undefined);
    commitConversationSurfaceIdentity(createConversationDraftIdentity(draftGeneration));
  }, [commitConversationSurfaceIdentity, commitSelectedConversationThreadId]);

  const selectConversationThread = useCallback(async (
    threadId: string,
    cwd = input.cwd,
    shouldCommit: () => boolean = () => true,
  ): Promise<boolean> => {
    const workspaceCwd = cwd.trim();
    if (!workspaceCwd || !threadId) {
      if (shouldCommit()) {
        openNewConversation();
      }
      return false;
    }
    if (!shouldCommit()) {
      return false;
    }
    const selectionSequence = ++selectionSequenceRef.current;
    commitConversationSurfaceIdentity(threadId);
    const operation = conversationErrors.begin({
      workspaceCwd,
      surface: "thread",
      identity: threadId,
      scope: "select",
    });
    conversationErrors.clear(operation);
    try {
      const detail = await getConversation(workspaceCwd, threadId);
      conversationErrors.clear(operation);
      if (
        selectionSequence !== selectionSequenceRef.current
        || currentCwdRef.current !== workspaceCwd
        || !shouldCommit()
      ) {
        return false;
      }
      commitSelectedConversationThreadId(threadId);
      setSelectedConversationDetail(detail);
      commitConversationSurfaceIdentity(threadId);
      return true;
    } catch (error) {
      conversationErrors.report(operation, error instanceof Error ? error.message : String(error));
      if (
        selectionSequence !== selectionSequenceRef.current
        || currentCwdRef.current !== workspaceCwd
        || !shouldCommit()
      ) {
        return false;
      }
      return false;
    }
  }, [commitConversationSurfaceIdentity, commitSelectedConversationThreadId, conversationErrors, input.cwd, openNewConversation]);

  const refreshSelectedConversation = useCallback(async (cwd = input.cwd): Promise<void> => {
    const workspaceCwd = cwd.trim();
    const requestedThreadId = selectedConversationThreadIdRef.current;
    if (!workspaceCwd || !requestedThreadId) {
      return;
    }
    const operation = conversationErrors.begin({
      workspaceCwd,
      surface: "thread",
      identity: requestedThreadId,
      scope: "refresh",
    });
    conversationErrors.clear(operation);
    try {
      const detail = await getConversation(workspaceCwd, requestedThreadId);
      conversationErrors.clear(operation);
      if (
        conversationErrors.isCurrent(operation)
        && currentCwdRef.current === workspaceCwd
        && selectedConversationThreadIdRef.current === requestedThreadId
      ) {
        setSelectedConversationDetail(detail);
      }
    } catch (error) {
      conversationErrors.report(operation, error instanceof Error ? error.message : String(error));
    }
  }, [conversationErrors, input.cwd]);

  const archiveConversationThread = useCallback(async (threadId: string, cwd = input.cwd): Promise<void> => {
    const workspaceCwd = cwd.trim();
    if (!workspaceCwd || !threadId) {
      return;
    }
    const operation = conversationErrors.begin({
      workspaceCwd,
      surface: "sidebar",
      identity: threadId,
      scope: "archive",
    });
    conversationErrors.clear(operation);
    try {
      await archiveLingThread(workspaceCwd, threadId, {
        reason: "sidebar_conversation_archived",
        idempotencyKey: `sidebar-conversation-archive:${threadId}`,
      });
      conversationErrors.clear(operation);
      if (currentCwdRef.current === workspaceCwd) {
        setConversationThreads((current) => current.filter((thread) => thread.id !== threadId));
      }
      if (selectedConversationThreadIdRef.current === threadId) {
        openNewConversation();
      }
      await refreshConversationThreads(workspaceCwd);
    } catch (error) {
      const message = formatConversationArchiveError(error, input.translate);
      conversationErrors.report(operation, message);
    }
  }, [conversationErrors, input.cwd, input.translate, openNewConversation, refreshConversationThreads]);

  const archiveAllConversationThreads = useCallback(async (cwd = input.cwd): Promise<void> => {
    const workspaceCwd = cwd.trim();
    const visibleThreads = conversationThreads.filter((thread) => !thread.archivedAt && thread.status !== "archived");
    if (!workspaceCwd || visibleThreads.length === 0) {
      if (workspaceCwd) {
        const operation = conversationErrors.begin({
          workspaceCwd,
          surface: "sidebar",
          identity: "all",
          scope: "archive",
        });
        conversationErrors.report(operation, input.translate("No conversations to archive"));
      }
      return;
    }
    const operation = conversationErrors.begin({
      workspaceCwd,
      surface: "sidebar",
      identity: "all",
      scope: "archive",
    });
    conversationErrors.clear(operation);
    try {
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
        conversationErrors.report(operation, message);
      } else {
        conversationErrors.clear(operation);
      }
    } catch (error) {
      const message = formatConversationArchiveError(error, input.translate);
      conversationErrors.report(operation, message);
    }
  }, [conversationErrors, conversationThreads, input.cwd, input.translate, openNewConversation, refreshConversationThreads, selectedConversationThreadId]);

  const sendConversationMessage = useCallback(async (
    message: ConversationSendInput,
    handlers: ConversationStreamHandlers = {},
  ): Promise<void> => {
    const workspaceCwd = input.cwd.trim();
    const originThreadId = selectedConversationThreadIdRef.current;
    const originSurfaceIdentity = conversationSurfaceIdentityRef.current;
    let activeThreadId = originThreadId;
    const busyOperation = conversationStreamBusyOwner.begin({
      workspaceCwd,
      identity: originSurfaceIdentity,
    });
    let streamOperation: ConversationErrorOperation = conversationErrors.begin({
      workspaceCwd,
      surface: "composer",
      identity: originSurfaceIdentity,
      scope: "stream",
    });
    conversationErrors.clear(streamOperation);
    const canCommitToSurface = (threadId = activeThreadId): boolean => {
      if (currentCwdRef.current !== workspaceCwd) return false;
      if (handlers.shouldCommit) return handlers.shouldCommit(threadId || undefined);
      return conversationSurfaceIdentityRef.current === originSurfaceIdentity
        || Boolean(threadId && conversationSurfaceIdentityRef.current === threadId);
    };
    const retargetStreamOperation = (threadId: string): void => {
      if (!threadId || streamOperation.identity === threadId) return;
      conversationStreamBusyOwner.bind(busyOperation, threadId);
      conversationErrors.clear(streamOperation);
      streamOperation = conversationErrors.begin({
        workspaceCwd,
        surface: "composer",
        identity: threadId,
        scope: "stream",
      });
      conversationErrors.clear(streamOperation);
    };
    if (!workspaceCwd) {
      const errorMessage = "Local workspace is not ready.";
      conversationErrors.report(streamOperation, errorMessage);
      if (canCommitToSurface()) handlers.onError?.(errorMessage);
      conversationStreamBusyOwner.finish(busyOperation);
      return;
    }

    try {
      const response = await streamConversation(workspaceCwd, {
        threadId: originThreadId || undefined,
        message: message.message,
        attachmentIds: message.attachmentIds,
        fileRefs: message.fileRefs,
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
            if (requestedThreadId === activeThreadId && canCommitToSurface(requestedThreadId)) {
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
          handlers.onThreadBound?.(activeThreadId);
          retargetStreamOperation(activeThreadId);
          if (event.activeReply) {
            conversationStreamBusyOwner.finish(busyOperation);
          }
          if (canCommitToSurface(activeThreadId)) {
            commitSelectedConversationThreadId(activeThreadId);
            commitConversationSurfaceIdentity(activeThreadId);
            setSelectedConversationDetail((current) => mergeConversationMessages(current, workspaceCwd, event.thread, [
              event.userMessage,
              event.assistantMessage,
            ]));
            scheduleEvidenceRefresh();
            handlers.onReady?.(event);
            handlers.onMessageAccepted?.(event);
            if (event.activeReply) handlers.onReplyLinked?.(event.activeReply);
            void refreshConversationThreads(workspaceCwd);
          }
          return;
        }
        if (parsed.event === "run_event") {
          const event = JSON.parse(parsed.data) as ConversationStreamRunEvent;
          handlers.onThreadBound?.(event.threadId);
          if (event.assistantMessage && canCommitToSurface(event.threadId)) {
            setSelectedConversationDetail((current) => mergeConversationMessages(current, workspaceCwd, undefined, [event.assistantMessage as ConversationTranscriptMessage]));
          }
          if (canCommitToSurface(event.threadId) && conversationEventNeedsDetailRefresh(event.event.type)) {
            scheduleEvidenceRefresh();
          }
          if (canCommitToSurface(event.threadId)) handlers.onRunEvent?.(event);
          return;
        }
        if (parsed.event === "done") {
          const event = JSON.parse(parsed.data) as ConversationStreamDoneEvent;
          activeThreadId = event.thread.id;
          handlers.onThreadBound?.(activeThreadId);
          retargetStreamOperation(activeThreadId);
          conversationErrors.clear(streamOperation);
          if (canCommitToSurface(activeThreadId)) {
            commitSelectedConversationThreadId(activeThreadId);
            commitConversationSurfaceIdentity(activeThreadId);
            setSelectedConversationDetail((current) => mergeConversationMessages(current, workspaceCwd, event.thread, [event.assistantMessage]));
            handlers.onDone?.(event);
          }
          return;
        }
        if (parsed.event === "blocked") {
          const event = JSON.parse(parsed.data) as ConversationStreamBlockedEvent;
          if (event.thread) {
            activeThreadId = event.thread.id;
            handlers.onThreadBound?.(activeThreadId);
            retargetStreamOperation(activeThreadId);
          }
          if (event.error) conversationErrors.report(streamOperation, event.error);
          if (event.thread && canCommitToSurface(activeThreadId)) {
            commitSelectedConversationThreadId(activeThreadId);
            commitConversationSurfaceIdentity(activeThreadId);
          }
          if (event.assistantMessage && canCommitToSurface(activeThreadId)) {
            setSelectedConversationDetail((current) => mergeConversationMessages(current, workspaceCwd, event.thread, [event.assistantMessage as ConversationTranscriptMessage]));
          }
          if (canCommitToSurface(activeThreadId)) {
            handlers.onBlocked?.(event);
            void refreshConversationThreads(workspaceCwd);
          }
          return;
        }
        if (parsed.event === "error") {
          const event = JSON.parse(parsed.data) as ConversationStreamBlockedEvent;
          const messageText = event.error || event.assistantMessage?.content || "Ling Agent run failed.";
          if (event.thread) {
            activeThreadId = event.thread.id;
            handlers.onThreadBound?.(activeThreadId);
            retargetStreamOperation(activeThreadId);
          }
          conversationErrors.report(streamOperation, messageText);
          if (event.assistantMessage && canCommitToSurface(activeThreadId)) {
            setSelectedConversationDetail((current) => mergeConversationMessages(current, workspaceCwd, event.thread, [event.assistantMessage as ConversationTranscriptMessage]));
          }
          if (canCommitToSurface(activeThreadId)) handlers.onError?.(messageText, event);
        }
      });
      if (evidenceRefreshTimer !== undefined) {
        clearTimeout(evidenceRefreshTimer);
      }
      evidenceRefreshRequested = false;
      await evidenceRefreshPromise;
      await refreshConversationThreads(workspaceCwd);
      if (activeThreadId) {
        const refreshOperation = conversationErrors.begin({
          workspaceCwd,
          surface: "thread",
          identity: activeThreadId,
          scope: "refresh",
        });
        conversationErrors.clear(refreshOperation);
        try {
          const detail = await getConversation(workspaceCwd, activeThreadId);
          conversationErrors.clear(refreshOperation);
          if (canCommitToSurface(activeThreadId)) setSelectedConversationDetail(detail);
        } catch (error) {
          conversationErrors.report(refreshOperation, error instanceof Error ? error.message : String(error));
        }
      }
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      conversationErrors.report(streamOperation, messageText);
      if (canCommitToSurface(activeThreadId)) handlers.onError?.(messageText);
    } finally {
      conversationStreamBusyOwner.finish(busyOperation);
    }
  }, [commitConversationSurfaceIdentity, commitSelectedConversationThreadId, conversationErrors, conversationStreamBusyOwner, input.cwd, refreshConversationThreads]);

  const workspaceCwd = input.cwd.trim();
  const conversationSidebarError = selectConversationError(conversationErrors.entries, {
    workspaceCwd,
    surface: "sidebar",
    scopes: ["load", "archive"],
  })?.message ?? "";
  const conversationSurfaceError = selectConversationError(conversationErrors.entries, {
    workspaceCwd,
    surface: "thread",
    identity: conversationSurfaceIdentity,
    scopes: ["select", "refresh", "action"],
  })?.message ?? "";
  const conversationComposerError = selectConversationError(conversationErrors.entries, {
    workspaceCwd,
    surface: "composer",
    identity: conversationSurfaceIdentity,
    scopes: ["stream"],
  })?.message ?? "";
  const conversationStreamBusy = conversationStreamBusyOwner.isBusy({
    workspaceCwd,
    identity: conversationSurfaceIdentity,
  });

  return {
    state: {
      conversationThreads,
      conversationThreadsLoading,
      selectedConversationThreadId,
      selectedConversationDetail,
      conversationIdentity: conversationSurfaceIdentity,
      conversationStreamBusy,
      conversationSidebarError,
      conversationSurfaceError,
      conversationComposerError,
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

function conversationEventNeedsDetailRefresh(type: ConversationStreamRunEvent["event"]["type"]): boolean {
  return type === "tool_start"
    || type === "tool_update"
    || type === "tool_end"
    || type === "approval_requested"
    || type === "approval_approved"
    || type === "approval_denied"
    || type === "approval_expired"
    || type === "approval_cancelled"
    || type === "artifact_created"
    || type === "run_intervention_created"
    || type === "run_followup_queued"
    || type === "run_interrupt_requested"
    || type === "run_continuation_starting"
    || type === "run_continuation_started"
    || type === "run_intervention_failed";
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
    approvals: current?.approvals ?? [],
    interventions: current?.interventions ?? [],
    terminalReports: current?.terminalReports ?? [],
    messages: [...byId.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
    generatedMedia: current?.generatedMedia ?? [],
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
