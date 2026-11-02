import type { ExecutionBindingRequest } from "@ling-stack/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { archiveLingThread, getConversation, getConversationSubmission, listLingThreads, streamConversation } from "../../api.js";
import { LingDaemonError, LingDaemonTransportError } from "@ling-stack/api-client";
import { DaemonObservationDeferredError, isDaemonObservationPausedForWorkspace, liveDaemonObservation, type DaemonObservation } from "../../shared/conversation/observation/daemon-observation.js";
import { recoverSubmissionReceipt, submissionWasRejected } from "../../shared/conversation/conversation-submission-recovery.js";
import { submissionLookupJournal } from "../../shared/conversation/conversation-submission-journal.js";
import { validateConversationSubmissionReceipt } from "../../shared/conversation/submission-receipt-scope.js";
import { shouldReportConversationStreamError } from "../../shared/conversation/stream-error-ownership.js";
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
  ReasoningSummaryMode,
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
import { mergeConversationDetailSnapshots } from "./conversation-detail-merge.js";
import { createConversationReadEpoch } from "../../lib/conversation-read-epoch.js";
import { useConversationStreamBusyOwner } from "./use-conversation-stream-busy-owner.js";

export interface ConversationSendInput {
  readonly message: string;
  readonly attachmentIds?: readonly string[];
  readonly fileRefs?: readonly ChannelMessageFileRef[];
  readonly projectPath?: string;
  readonly providerPresetId?: string;
  readonly executionBinding?: ExecutionBindingRequest;
  readonly thinkingLevel?: ProviderThinkingMode;
  readonly reasoningSummary?: ReasoningSummaryMode;
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
  readonly onMessageAccepted?: (event?: ConversationStreamReadyEvent) => void;
  readonly onSubmissionUnknown?: (recoveryOnly?: boolean) => void;
  readonly onSubmissionRecovered?: (threadId: string, originalBody: string) => void;
  readonly onReplyLinked?: (target: NonNullable<ConversationStreamReadyEvent["activeReply"]>) => void;
  readonly onRunEvent?: (event: ConversationStreamRunEvent) => void;
  readonly onDone?: (event: ConversationStreamDoneEvent) => void;
  readonly onBlocked?: (event: ConversationStreamBlockedEvent) => void;
  readonly onError?: (message: string, event?: ConversationStreamBlockedEvent) => void;
  readonly onThreadBound?: (threadId: string) => void;
  readonly shouldCommit?: (threadId?: string) => boolean;
}

interface AcceptedStreamObservation {
  readonly operation: ConversationErrorOperation;
  readonly sourceItemId: string;
}

export function useConversationDomain(input: {
  readonly cwd: string;
  readonly observation?: DaemonObservation;
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
    readonly refreshConversationThreads: (cwd?: string, options?: { readonly throwOnError?: boolean }) => Promise<void>;
    readonly refreshSelectedConversation: (cwd?: string, options?: { readonly throwOnError?: boolean }) => Promise<void>;
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
  const selectionInFlightRef = useRef<number | undefined>(undefined);
  const threadListLoadingOperationsRef = useRef(0);
  currentCwdRef.current = input.cwd.trim();
  const conversationErrors = useConversationErrorOwner();
  const acceptedStreamObservationsRef = useRef(new Map<number, AcceptedStreamObservation>());
  const detailReadEpochRef = useRef(createConversationReadEpoch());
  const conversationStreamBusyOwner = useConversationStreamBusyOwner();
  const observationRef = useRef(input.observation ?? liveDaemonObservation);
  observationRef.current = input.observation ?? liveDaemonObservation;
  const observationPaused = isDaemonObservationPausedForWorkspace(observationRef.current, input.cwd);
  const canObserve = (cwd: string): boolean => !isDaemonObservationPausedForWorkspace(observationRef.current, cwd);
  const reportObservationError = useCallback((operation: ConversationErrorOperation, error: unknown): void => {
    conversationErrors.report(operation, error instanceof Error ? error.message : String(error),
      error instanceof LingDaemonTransportError ? "transport" : undefined);
  }, [conversationErrors]);

  useEffect(() => {
    // Late successes from a previous observation cannot certify the current UI.
    detailReadEpochRef.current.invalidate();
  }, [input.observation?.epoch]);

  const reconcileStreamObservations = useCallback((
    detail: ConversationDetailResponse,
    observations: readonly AcceptedStreamObservation[],
  ): void => {
    for (const observation of observations) {
      const { operation, sourceItemId } = observation;
      if (acceptedStreamObservationsRef.current.get(operation.sequence) !== observation) continue;
      if (!conversationErrors.isCurrent(operation)) {
        acceptedStreamObservationsRef.current.delete(operation.sequence);
        continue;
      }
      // Only a read started after this failure, containing the exact accepted
      // source in its own scope, recovers transport observation. Host execution
      // errors remain in the canonical transcript, even when observation heals.
      if (detail.cwd !== operation.workspaceCwd || detail.thread.id !== operation.identity
        || !detail.messages.some(message => message.id === sourceItemId && message.role === "user"
          && message.threadId === operation.identity)) continue;
      conversationErrors.clear(operation);
      acceptedStreamObservationsRef.current.delete(operation.sequence);
    }
  }, [conversationErrors]);

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
    detailReadEpochRef.current.invalidate();
    selectionSequenceRef.current += 1;
    selectionInFlightRef.current = undefined;
    const draftGeneration = conversationDraftGenerationRef.current + 1;
    conversationDraftGenerationRef.current = draftGeneration;
    commitSelectedConversationThreadId("");
    setSelectedConversationDetail(undefined);
    setConversationThreads([]);
    commitConversationSurfaceIdentity(createConversationDraftIdentity(draftGeneration));
  }, [commitConversationSurfaceIdentity, commitSelectedConversationThreadId, input.cwd]);

  const refreshConversationThreads = useCallback(async (
    cwd = input.cwd,
    options?: { readonly throwOnError?: boolean },
  ): Promise<void> => {
    const workspaceCwd = cwd.trim();
    if (!canObserve(workspaceCwd)) {
      if (options?.throwOnError) throw new DaemonObservationDeferredError();
      return;
    }
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
    const observationEpoch = observationRef.current.epoch;
    try {
      const response = await listLingThreads(workspaceCwd, { kind: "conversation", archived: "exclude", limit: 20 });
      if (canObserve(workspaceCwd) && observationRef.current.epoch === observationEpoch
        && conversationErrors.isCurrent(operation) && currentCwdRef.current === workspaceCwd) {
        setConversationThreads(response.threads);
      } else if (options?.throwOnError) {
        throw new DaemonObservationDeferredError();
      }
    } catch (error) {
      if (!(error instanceof DaemonObservationDeferredError)) reportObservationError(operation, error);
      if (options?.throwOnError) throw error;
    } finally {
      finishThreadListLoading();
    }
  }, [beginThreadListLoading, conversationErrors, finishThreadListLoading, input.cwd, reportObservationError]);

  const openNewConversation = useCallback((): void => {
    detailReadEpochRef.current.invalidate();
    selectionSequenceRef.current += 1;
    selectionInFlightRef.current = undefined;
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
    if (!canObserve(workspaceCwd)) return false;
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
    selectionInFlightRef.current = selectionSequence;
    const detailRead = detailReadEpochRef.current.begin(JSON.stringify([workspaceCwd, threadId]));
    commitConversationSurfaceIdentity(threadId);
    const operation = conversationErrors.begin({
      workspaceCwd,
      surface: "thread",
      identity: threadId,
      scope: "select",
    });
    conversationErrors.clear(operation);
    const observations = [...acceptedStreamObservationsRef.current.values()];
    const observationEpoch = observationRef.current.epoch;
    try {
      const detail = await getConversation(workspaceCwd, threadId);
      if (detail.thread.id !== threadId) throw new Error("Conversation response scope mismatch.");
      conversationErrors.clear(operation);
      if (
        !detailReadEpochRef.current.isCurrent(detailRead)
        || !canObserve(workspaceCwd) || observationRef.current.epoch !== observationEpoch
        || selectionSequence !== selectionSequenceRef.current
        || currentCwdRef.current !== workspaceCwd
        || !shouldCommit()
      ) {
        return false;
      }
      commitSelectedConversationThreadId(threadId);
      setSelectedConversationDetail(mergeConversationDetailSnapshots(undefined, detail));
      reconcileStreamObservations(detail, observations);
      commitConversationSurfaceIdentity(threadId);
      return true;
    } catch (error) {
      reportObservationError(operation, error);
      if (
        selectionSequence !== selectionSequenceRef.current
        || currentCwdRef.current !== workspaceCwd
        || !shouldCommit()
      ) {
        return false;
      }
      return false;
    } finally {
      if (selectionInFlightRef.current === selectionSequence) {
        selectionInFlightRef.current = undefined;
      }
    }
  }, [commitConversationSurfaceIdentity, commitSelectedConversationThreadId, conversationErrors, input.cwd, openNewConversation, reconcileStreamObservations, reportObservationError]);

  const refreshSelectedConversation = useCallback(async (cwd = input.cwd, options?: { readonly throwOnError?: boolean }): Promise<void> => {
    if (!canObserve(cwd)) {
      if (options?.throwOnError) throw new DaemonObservationDeferredError();
      return;
    }
    // A background refresh must not supersede a navigation selection read.
    if (selectionInFlightRef.current !== undefined) {
      if (options?.throwOnError) throw new DaemonObservationDeferredError();
      return;
    }
    const workspaceCwd = cwd.trim();
    const requestedThreadId = selectedConversationThreadIdRef.current;
    if (!workspaceCwd || !requestedThreadId || conversationSurfaceIdentityRef.current !== requestedThreadId) {
      return;
    }
    const operation = conversationErrors.begin({
      workspaceCwd,
      surface: "thread",
      identity: requestedThreadId,
      scope: "refresh",
    });
    const detailRead = detailReadEpochRef.current.begin(JSON.stringify([workspaceCwd, requestedThreadId]));
    conversationErrors.clear(operation);
    const observations = [...acceptedStreamObservationsRef.current.values()];
    const observationEpoch = observationRef.current.epoch;
    try {
      const detail = await getConversation(workspaceCwd, requestedThreadId);
      if (detail.thread.id !== requestedThreadId) throw new Error("Conversation response scope mismatch.");
      conversationErrors.clear(operation);
      if (
        detailReadEpochRef.current.isCurrent(detailRead)
        && canObserve(workspaceCwd) && observationRef.current.epoch === observationEpoch
        && conversationErrors.isCurrent(operation)
        && currentCwdRef.current === workspaceCwd
        && selectedConversationThreadIdRef.current === requestedThreadId
      ) {
        setSelectedConversationDetail((current) => mergeConversationDetailSnapshots(current, detail));
        reconcileStreamObservations(detail, observations);
      } else if (options?.throwOnError) {
        throw new DaemonObservationDeferredError();
      }
    } catch (error) {
      if (!(error instanceof DaemonObservationDeferredError)) reportObservationError(operation, error);
      if (options?.throwOnError) throw error;
    }
  }, [conversationErrors, input.cwd, reconcileStreamObservations, reportObservationError]);

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
    let messageAccepted = false;
    let acceptedSourceItemId = "";
    let submitted = false;
    const submissionScope = { cwd: workspaceCwd, surface: "normal" as const, threadId: originThreadId || undefined };
    const idempotencyKey = crypto.randomUUID();
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
    for (const [sequence, observation] of acceptedStreamObservationsRef.current) {
      if (!conversationErrors.isCurrent(observation.operation)) acceptedStreamObservationsRef.current.delete(sequence);
    }
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
    if (!canObserve(workspaceCwd)) {
      conversationStreamBusyOwner.finish(busyOperation);
      return;
    }
    const streamObservation = observationRef.current;
    const canPublishStream = (threadId = activeThreadId): boolean => canCommitToSurface(threadId)
      && canObserve(workspaceCwd) && observationRef.current.epoch === streamObservation.epoch
      && observationRef.current.baseUrl === streamObservation.baseUrl;

    try {
      const pendingKey = submissionLookupJournal.read(submissionScope);
      if (pendingKey) {
        const observationEpoch = observationRef.current.epoch;
        const assertObservationCurrent = (): void => {
          if (!canObserve(workspaceCwd) || observationRef.current.epoch !== observationEpoch) {
            throw new DaemonObservationDeferredError();
          }
        };
        const query = { surface: "normal" as const, idempotencyKey: pendingKey, threadId: originThreadId || undefined };
        const receipt = await recoverSubmissionReceipt(async () => {
          assertObservationCurrent();
          return validateConversationSubmissionReceipt(await getConversationSubmission(workspaceCwd, query), workspaceCwd, query);
        });
        assertObservationCurrent();
        if (!receipt?.threadId || !receipt.sourceItem) {
          conversationErrors.report(streamOperation, input.translate("Pending confirmation"));
          if (canCommitToSurface()) handlers.onSubmissionUnknown?.(true);
          return;
        }
        activeThreadId = receipt.threadId;
        const detail = await getConversation(workspaceCwd, activeThreadId);
        if (detail.thread.id !== activeThreadId) throw new Error("Conversation response scope mismatch.");
        assertObservationCurrent();
        if (canCommitToSurface(activeThreadId)) {
          const original = detail.messages.find(item => item.id === receipt.sourceItemId);
          handlers.onSubmissionRecovered?.(activeThreadId, original?.content ?? "");
          commitSelectedConversationThreadId(activeThreadId);
          commitConversationSurfaceIdentity(activeThreadId);
          setSelectedConversationDetail(current => mergeConversationDetailSnapshots(current, detail));
          conversationErrors.clear(streamOperation);
        }
        submissionLookupJournal.forget(submissionScope, pendingKey);
        await refreshConversationThreads(workspaceCwd);
        return;
      }
      submissionLookupJournal.remember(submissionScope, idempotencyKey);
      submitted = true;
      const response = await streamConversation(workspaceCwd, {
        idempotencyKey,
        threadId: originThreadId || undefined,
        message: message.message,
        attachmentIds: message.attachmentIds,
        fileRefs: message.fileRefs,
        projectPath: message.projectPath,
        providerPresetId: message.providerPresetId,
        executionBinding: message.executionBinding,
        thinkingLevel: normalizeThinkingLevel(message.thinkingLevel),
        reasoningSummary: message.reasoningSummary,
        authorizationMode: message.authorizationMode,
        workspaceAccessMode: message.workspaceAccessMode,
        permissionPreset: message.permissionPreset,
        permissionMode: message.permissionMode,
        permissionConfirmation: message.permissionConfirmation,
        responseLanguage: message.responseLanguage,
        tools: message.tools,
      });
      if (!response.ok || !response.body) {
        throw new LingDaemonError(await readResponseError(response), response.status, response.statusText);
      }
      let evidenceRefreshTimer: ReturnType<typeof setTimeout> | undefined;
      let evidenceRefreshPromise: Promise<void> | undefined;
      let evidenceRefreshRequested = false;
      const refreshActiveConversationEvidence = (): Promise<void> => {
        if (!canObserve(workspaceCwd) || !activeThreadId || !canCommitToSurface(activeThreadId)) {
          return Promise.resolve();
        }
        if (evidenceRefreshPromise) {
          evidenceRefreshRequested = true;
          return evidenceRefreshPromise;
        }
        const requestedThreadId = activeThreadId;
        const observationEpoch = observationRef.current.epoch;
        const detailRead = detailReadEpochRef.current.begin(JSON.stringify([workspaceCwd, requestedThreadId]));
        evidenceRefreshPromise = (async () => {
          try {
            const detail = await getConversation(workspaceCwd, requestedThreadId);
            if (detail.thread.id !== requestedThreadId) throw new Error("Conversation response scope mismatch.");
            if (canObserve(workspaceCwd) && observationRef.current.epoch === observationEpoch
              && detailReadEpochRef.current.isCurrent(detailRead) && requestedThreadId === activeThreadId && canCommitToSurface(requestedThreadId)) {
              setSelectedConversationDetail((current) => mergeConversationDetailSnapshots(current, detail));
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
      const streamCompletion = readSseResponse(response, (parsed) => {
        if (parsed.event === "ready") {
          const event = JSON.parse(parsed.data) as ConversationStreamReadyEvent;
          activeThreadId = event.thread.id;
          messageAccepted = true;
          acceptedSourceItemId = event.userMessage.id;
          submissionLookupJournal.forget(submissionScope, idempotencyKey);
          handlers.onThreadBound?.(activeThreadId);
          retargetStreamOperation(activeThreadId);
          if (event.activeReply) {
            conversationStreamBusyOwner.finish(busyOperation);
          }
          if (canCommitToSurface(activeThreadId)) {
            // Acceptance/linkage is a fact even when its message snapshot is
            // no longer the current observation. Do not turn it into a resend.
            handlers.onMessageAccepted?.(event);
            if (event.activeReply) handlers.onReplyLinked?.(event.activeReply);
            commitSelectedConversationThreadId(activeThreadId);
            commitConversationSurfaceIdentity(activeThreadId);
          }
          if (canPublishStream(activeThreadId)) {
            setSelectedConversationDetail((current) => canPublishStream(activeThreadId)
              ? mergeConversationMessages(current, workspaceCwd, event.thread, [event.userMessage, event.assistantMessage]) : current);
            scheduleEvidenceRefresh();
            handlers.onReady?.(event);
          }
          return;
        }
        if (parsed.event === "run_event") {
          const event = JSON.parse(parsed.data) as ConversationStreamRunEvent;
          handlers.onThreadBound?.(event.threadId);
          if (event.assistantMessage && canPublishStream(event.threadId)) {
            setSelectedConversationDetail((current) => canPublishStream(event.threadId)
              ? mergeConversationMessages(current, workspaceCwd, undefined, [event.assistantMessage as ConversationTranscriptMessage]) : current);
          }
          if (canPublishStream(event.threadId) && conversationEventNeedsDetailRefresh(event.event.type)) {
            scheduleEvidenceRefresh();
          }
          if (canPublishStream(event.threadId)) handlers.onRunEvent?.(event);
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
          }
          if (canPublishStream(activeThreadId)) {
            setSelectedConversationDetail((current) => canPublishStream(activeThreadId)
              ? mergeConversationMessages(current, workspaceCwd, event.thread, [event.assistantMessage]) : current);
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
          if (shouldReportConversationStreamError({ error: event.error, hasAssistantReply: Boolean(event.assistantMessage) }) && !messageAccepted) {
            conversationErrors.report(streamOperation, event.error);
          }
          if (event.thread && canCommitToSurface(activeThreadId)) {
            commitSelectedConversationThreadId(activeThreadId);
            commitConversationSurfaceIdentity(activeThreadId);
          }
          if (event.assistantMessage && canPublishStream(activeThreadId)) {
            setSelectedConversationDetail((current) => canPublishStream(activeThreadId)
              ? mergeConversationMessages(current, workspaceCwd, event.thread, [event.assistantMessage as ConversationTranscriptMessage]) : current);
          }
          if (canPublishStream(activeThreadId)) handlers.onBlocked?.(event);
          return;
        }
        if (parsed.event === "error") {
          const event = JSON.parse(parsed.data) as ConversationStreamBlockedEvent;
          const messageText = event.error || event.assistantMessage?.errorMessage || "Ling Agent run failed.";
          if (event.thread) {
            activeThreadId = event.thread.id;
            handlers.onThreadBound?.(activeThreadId);
            retargetStreamOperation(activeThreadId);
          }
          if (shouldReportConversationStreamError({ error: messageText, hasAssistantReply: Boolean(event.assistantMessage) }) && !messageAccepted) {
            conversationErrors.report(streamOperation, messageText);
          }
          if (event.assistantMessage && canPublishStream(activeThreadId)) {
            setSelectedConversationDetail((current) => canPublishStream(activeThreadId)
              ? mergeConversationMessages(current, workspaceCwd, event.thread, [event.assistantMessage as ConversationTranscriptMessage]) : current);
          }
          if (canCommitToSurface(activeThreadId)) handlers.onError?.(messageText, event);
        }
      });
      try {
        await streamCompletion;
      } finally {
        if (evidenceRefreshTimer !== undefined) clearTimeout(evidenceRefreshTimer);
        evidenceRefreshRequested = false;
        await evidenceRefreshPromise;
        // A lost stream must reconcile accepted input just like a normal terminal event.
        if (messageAccepted) await refreshConversationThreads(workspaceCwd);
        if (messageAccepted && canObserve(workspaceCwd) && activeThreadId && canCommitToSurface(activeThreadId)) {
          const refreshOperation = conversationErrors.begin({
            workspaceCwd,
            surface: "thread",
            identity: activeThreadId,
            scope: "refresh",
          });
          conversationErrors.clear(refreshOperation);
          const detailRead = detailReadEpochRef.current.begin(JSON.stringify([workspaceCwd, activeThreadId]));
          const observationEpoch = observationRef.current.epoch;
          try {
            const detail = await getConversation(workspaceCwd, activeThreadId);
            if (detail.thread.id !== activeThreadId) throw new Error("Conversation response scope mismatch.");
            conversationErrors.clear(refreshOperation);
            if (canObserve(workspaceCwd) && observationRef.current.epoch === observationEpoch
              && detailReadEpochRef.current.isCurrent(detailRead) && canCommitToSurface(activeThreadId)) {
              setSelectedConversationDetail((current) => mergeConversationDetailSnapshots(current, detail));
            }
          } catch (error) {
            reportObservationError(refreshOperation, error);
          }
        }
      }
      if (!messageAccepted) throw new Error("Pending confirmation");
    } catch (error) {
      if (!submitted) {
        if (error instanceof DaemonObservationDeferredError) {
          conversationErrors.report(streamOperation, input.translate("Pending confirmation"));
        } else {
          reportObservationError(streamOperation, error);
        }
        if (canCommitToSurface(activeThreadId)) handlers.onSubmissionUnknown?.(true);
        return;
      }
      let rejectionConfirmed = false;
      if (!messageAccepted) {
        if (!canObserve(workspaceCwd)) {
          reportObservationError(streamOperation, error);
          if (canCommitToSurface(activeThreadId)) handlers.onSubmissionUnknown?.();
          return;
        }
        const observationEpoch = observationRef.current.epoch;
        const query = { surface: "normal" as const, idempotencyKey, threadId: originThreadId || undefined };
        const receipt = await recoverSubmissionReceipt(async () => {
          if (!canObserve(workspaceCwd) || observationRef.current.epoch !== observationEpoch) {
            throw new DaemonObservationDeferredError();
          }
          return validateConversationSubmissionReceipt(await getConversationSubmission(workspaceCwd, query), workspaceCwd, query);
        });
        const receiptObservationCurrent = canObserve(workspaceCwd) && observationRef.current.epoch === observationEpoch;
        rejectionConfirmed = receiptObservationCurrent && submissionWasRejected(error, receipt);
        if (receipt?.threadId && receipt.turnId && receipt.sourceItemId) {
          messageAccepted = true;
          acceptedSourceItemId = receipt.sourceItemId;
          submissionLookupJournal.forget(submissionScope, idempotencyKey);
          activeThreadId = receipt.threadId;
          handlers.onThreadBound?.(activeThreadId);
          retargetStreamOperation(activeThreadId);
          if (canCommitToSurface(activeThreadId)) {
            handlers.onMessageAccepted?.();
            commitSelectedConversationThreadId(activeThreadId);
            commitConversationSurfaceIdentity(activeThreadId);
            const detailRead = detailReadEpochRef.current.begin(JSON.stringify([workspaceCwd, activeThreadId]));
            try {
              if (!canObserve(workspaceCwd) || observationRef.current.epoch !== observationEpoch) {
                throw new DaemonObservationDeferredError();
              }
              const detail = await getConversation(workspaceCwd, activeThreadId);
              if (detail.thread.id !== activeThreadId) throw new Error("Conversation response scope mismatch.");
              if (canObserve(workspaceCwd) && observationRef.current.epoch === observationEpoch
                && detailReadEpochRef.current.isCurrent(detailRead) && canCommitToSurface(activeThreadId)) {
                setSelectedConversationDetail(current => mergeConversationDetailSnapshots(current, detail));
              }
            } catch (readError) {
              if (!(readError instanceof DaemonObservationDeferredError)) reportObservationError(streamOperation, readError);
            }
          }
          await refreshConversationThreads(workspaceCwd);
        } else if (!rejectionConfirmed) {
          if (receiptObservationCurrent) {
            conversationErrors.report(streamOperation, input.translate("Pending confirmation"));
          } else {
            reportObservationError(streamOperation, error);
          }
          if (canCommitToSurface(activeThreadId)) handlers.onSubmissionUnknown?.();
          return;
        }
      }
      if (rejectionConfirmed) submissionLookupJournal.forget(submissionScope, idempotencyKey);
      const messageText = error instanceof Error ? error.message : String(error);
      reportObservationError(streamOperation, error);
      if (messageAccepted && acceptedSourceItemId) {
        if (conversationErrors.isCurrent(streamOperation)) {
          acceptedStreamObservationsRef.current.set(streamOperation.sequence, {
            operation: streamOperation,
            sourceItemId: acceptedSourceItemId,
          });
        }
        // Accepted input is never re-sent and a lost POST stream is not a
        // failed execution. Observe the Host now, or let control-plane recovery
        // perform the same read after connectivity returns.
        if (canCommitToSurface(activeThreadId)) await refreshSelectedConversation(workspaceCwd);
        return;
      }
      if (canCommitToSurface(activeThreadId)) handlers.onError?.(messageText);
    } finally {
      conversationStreamBusyOwner.finish(busyOperation);
    }
  }, [commitConversationSurfaceIdentity, commitSelectedConversationThreadId, conversationErrors, conversationStreamBusyOwner, input.cwd, refreshConversationThreads, refreshSelectedConversation, reportObservationError]);

  const workspaceCwd = input.cwd.trim();
  const conversationSidebarError = selectConversationError(conversationErrors.entries, {
    workspaceCwd,
    surface: "sidebar",
    scopes: ["load", "archive"],
    excludeTransport: observationPaused,
  })?.message ?? "";
  const conversationSurfaceError = selectConversationError(conversationErrors.entries, {
    workspaceCwd,
    surface: "thread",
    identity: conversationSurfaceIdentity,
    scopes: ["select", "refresh", "action"],
    excludeTransport: observationPaused,
  })?.message ?? "";
  const conversationComposerError = selectConversationError(conversationErrors.entries, {
    workspaceCwd,
    surface: "composer",
    identity: conversationSurfaceIdentity,
    scopes: ["stream"],
    excludeTransport: observationPaused,
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
  return type === "assistant_reasoning_summary"
    || type === "context_compaction_start"
    || type === "context_compaction_end"
    || type === "tool_start"
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
    conversationItems: current?.conversationItems ?? [],
    userInputs: current?.userInputs ?? [],
    supersessionTombstones: current?.supersessionTombstones ?? {
      turnIds: [],
      runIds: [],
      responseMessageIds: [],
    },
    runLinks: current?.runLinks ?? [],
    runs: current?.runs ?? [],
    reasoningSummaries: current?.reasoningSummaries ?? [],
    contextCompactions: current?.contextCompactions ?? [],
    executionActions: current?.executionActions ?? [],
    approvals: current?.approvals ?? [],
    approvalCheckpoints: current?.approvalCheckpoints ?? [],
    interventions: current?.interventions ?? [],
    terminalReports: current?.terminalReports ?? [],
    artifacts: current?.artifacts ?? [],
    plans: current?.plans ?? [],
    compactionCheckpoints: current?.compactionCheckpoints ?? [],
    contextSnapshots: current?.contextSnapshots ?? [],
    contextSummaries: current?.contextSummaries ?? [],
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
