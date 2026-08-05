import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import type { ComposerSlashCommandOption } from "@ling-stack/core/composer-slash-intents";
import {
  cancelRunIntervention,
  createRunIntervention,
  listRunInterventions,
  promoteRunIntervention,
} from "../../api.js";
import type { Translate } from "../../i18n.js";
import { titleFromPrompt } from "../../lib/formatting.js";
import {
  createLocalComposerAssetId,
  parseComposerSlashIntent,
  revokePendingAttachmentPreviews,
  serializeComposerInputParts,
  type ComposerInputPart,
  type PendingAttachmentItem,
} from "../../shared/components/index.js";
import {
  isConversationGuidanceQueueVisible,
  type ConversationGuidanceItem,
} from "../../shared/conversation/index.js";
import type {
  Channel,
  ChannelAttachment,
  ChannelLinkPreview,
  ChannelMention,
  ChannelMessageFileRef,
  LingThreadGoal,
  RunIntervention,
  RunSession,
} from "../../types.js";
import type { ChannelComposerSendState } from "./ChannelComposer.js";
import type { PendingChannelSendPreview } from "./ChannelMessageFeed.js";
import type { PendingLinkPreviewItem } from "./useChannelComposerDraftController.js";
import type { DetachedChannelSendSnapshot } from "./useChannelComposerSnapshotController.js";
import { findMentionsInText, mergeMentions } from "./channelMentionText.js";

interface ChannelComposerActionsInput {
  readonly cwd: string;
  readonly selectedChannelId: string;
  readonly selectedChannelBranchRootThreadId?: string;
  readonly selectedChannel: Channel | undefined;
  readonly guidanceModeActive: boolean;
  readonly activeConversationRun: RunSession | undefined;
  readonly activeConversationSourceRunId: string;
  readonly isCancellingRun: boolean;
  readonly composerHasSendableContent: boolean;
  readonly assetOperationPending: boolean;
  readonly messageDraft: string;
  readonly setMessageDraft: Dispatch<SetStateAction<string>>;
  readonly messageMentions: readonly ChannelMention[];
  readonly setMessageMentions: Dispatch<SetStateAction<readonly ChannelMention[]>>;
  readonly pendingAttachments: readonly PendingAttachmentItem<ChannelAttachment>[];
  readonly setPendingAttachments: Dispatch<SetStateAction<readonly PendingAttachmentItem<ChannelAttachment>[]>>;
  readonly pendingLinkPreviews: readonly PendingLinkPreviewItem[];
  readonly setPendingLinkPreviews: Dispatch<SetStateAction<readonly PendingLinkPreviewItem[]>>;
  readonly composerInputParts: readonly ComposerInputPart[];
  readonly composerFileRefs: readonly ChannelMessageFileRef[];
  readonly readyLinkPreviewIds: readonly string[];
  readonly composerBusy: boolean;
  readonly setComposerBusy: Dispatch<SetStateAction<boolean>>;
  readonly sendState: ChannelComposerSendState;
  readonly setSendState: Dispatch<SetStateAction<ChannelComposerSendState>>;
  readonly setSendError: Dispatch<SetStateAction<string>>;
  readonly setMentionPicker: Dispatch<SetStateAction<undefined | { readonly query: string; readonly start: number; readonly end: number }>>;
  readonly setMentionActiveIndex: Dispatch<SetStateAction<number>>;
  readonly setPendingChannelSendPreview: Dispatch<SetStateAction<PendingChannelSendPreview | undefined>>;
  readonly autoPreviewUrlsRef: { readonly current: Set<string> };
  readonly attachmentPreviewUrlsRef: { readonly current: Set<string> };
  readonly teammateOptions: readonly ChannelMention[];
  readonly slashCommands: readonly ComposerSlashCommandOption[];
  readonly channelAttachmentById: ReadonlyMap<string, ChannelAttachment>;
  readonly channelLinkPreviewById: ReadonlyMap<string, ChannelLinkPreview>;
  readonly planModeActive: boolean;
  readonly activeGoal: LingThreadGoal | undefined;
  readonly messageFeedScrollToLatest: () => void;
  readonly focusComposerAt: (offset: number) => void;
  readonly showComposerFeedback: (tone: "success" | "info" | "error", message: string) => void;
  readonly onCreateLinkPreview: (url: string) => Promise<ChannelLinkPreview | undefined>;
  readonly onCreateTaskFromSlashCommand: (input: {
    readonly title: string;
    readonly prompt: string;
    readonly assigneeTeammateId?: string;
    readonly requestedSkillId: string;
    readonly attachmentIds?: readonly string[];
  }) => Promise<void>;
  readonly onRevealPlanModeChip: () => void;
  readonly onRevealGoalChip: () => void;
  readonly onSetPlanMode: (active: boolean) => Promise<void>;
  readonly onSetGoalObjective: (objective: string, replaceExisting?: boolean) => Promise<void>;
  readonly onPatchGoal: (input: { readonly status?: LingThreadGoal["status"]; readonly objective?: string; readonly blockedReason?: string | null }) => Promise<void>;
  readonly onCompleteGoal: (reason?: string) => Promise<void>;
  readonly onClearGoal: () => Promise<void>;
  readonly onSendMessage: (input: {
    readonly threadId?: string;
    readonly body: string;
    readonly mentions: readonly ChannelMention[];
    readonly attachmentIds: readonly string[];
    readonly linkPreviewIds: readonly string[];
    readonly fileRefs: readonly ChannelMessageFileRef[];
    readonly requestAiReply: boolean;
  }) => Promise<{ readonly errorMessage?: string }>;
  readonly isChannelCurrent: (channelId: string) => boolean;
  readonly rememberDetachedSendFailure: (
    channelId: string,
    snapshot: DetachedChannelSendSnapshot,
    errorMessage: string,
  ) => void;
  readonly rememberDetachedSendSuccess: (channelId: string) => void;
  readonly onCancelActiveRun: (run?: RunSession) => void;
  readonly onRefreshChannelActivity: () => void;
  readonly onRefreshTasks: () => void;
  readonly onRefreshRuntime: () => void;
  readonly onRefreshRunApprovals: () => void;
  readonly t: Translate;
}

export interface ChannelComposerActionsController {
  readonly runGuidanceLoading: boolean;
  readonly runGuidanceSubmitting: RunIntervention["mode"] | "stop" | "";
  readonly runGuidanceError: string;
  readonly runGuidanceItems: readonly ConversationGuidanceItem[];
  readonly openRunGuidanceInterventions: readonly RunIntervention[];
  readonly submitChannelRunGuidanceFromDraft: () => Promise<boolean>;
  readonly sendMessage: () => Promise<void>;
  readonly handleChannelComposerSubmit: () => void;
  readonly dismissSendError: () => void;
}

export function useChannelComposerActionsController({
  activeConversationRun,
  activeConversationSourceRunId,
  assetOperationPending,
  attachmentPreviewUrlsRef,
  autoPreviewUrlsRef,
  channelAttachmentById,
  channelLinkPreviewById,
  planModeActive,
  activeGoal,
  composerBusy,
  composerFileRefs,
  composerHasSendableContent,
  composerInputParts,
  cwd,
  focusComposerAt,
  guidanceModeActive,
  isCancellingRun,
  messageDraft,
  messageFeedScrollToLatest,
  messageMentions,
  onCancelActiveRun,
  onCreateLinkPreview,
  onCreateTaskFromSlashCommand,
  onRevealGoalChip,
  onRevealPlanModeChip,
  onSetPlanMode,
  onSetGoalObjective,
  onPatchGoal,
  onCompleteGoal,
  onClearGoal,
  onRefreshChannelActivity,
  onRefreshRunApprovals,
  onRefreshRuntime,
  onRefreshTasks,
  onSendMessage,
  isChannelCurrent,
  pendingAttachments,
  pendingLinkPreviews,
  readyLinkPreviewIds,
  rememberDetachedSendFailure,
  rememberDetachedSendSuccess,
  selectedChannel,
  selectedChannelBranchRootThreadId,
  selectedChannelId,
  sendState,
  setComposerBusy,
  setMentionActiveIndex,
  setMentionPicker,
  setMessageDraft,
  setMessageMentions,
  setPendingAttachments,
  setPendingChannelSendPreview,
  setPendingLinkPreviews,
  setSendError,
  setSendState,
  showComposerFeedback,
  slashCommands,
  t,
  teammateOptions,
}: ChannelComposerActionsInput): ChannelComposerActionsController {
  const [runGuidanceInterventions, setRunGuidanceInterventions] = useState<readonly RunIntervention[]>([]);
  const [runGuidanceLoading, setRunGuidanceLoading] = useState(false);
  const [runGuidanceSubmitting, setRunGuidanceSubmitting] = useState<RunIntervention["mode"] | "stop" | "">("");
  const [runGuidanceCancelingId, setRunGuidanceCancelingId] = useState("");
  const [runGuidancePromotingId, setRunGuidancePromotingId] = useState("");
  const [runGuidanceError, setRunGuidanceError] = useState("");

  const refreshChannelRunGuidanceSurfaces = useCallback((): void => {
    onRefreshChannelActivity();
    onRefreshTasks();
    onRefreshRuntime();
    onRefreshRunApprovals();
  }, [onRefreshChannelActivity, onRefreshRunApprovals, onRefreshRuntime, onRefreshTasks]);

  const refreshChannelRunGuidance = useCallback(async (sourceRunId = activeConversationSourceRunId): Promise<void> => {
    if (!cwd || !sourceRunId) {
      setRunGuidanceInterventions([]);
      return;
    }
    try {
      const response = await listRunInterventions(cwd, sourceRunId, 100);
      setRunGuidanceInterventions(response.interventions);
    } catch (error) {
      setRunGuidanceError(error instanceof Error ? error.message : String(error));
    }
  }, [activeConversationSourceRunId, cwd]);

  useEffect(() => {
    if (!cwd || !activeConversationSourceRunId) {
      setRunGuidanceInterventions([]);
      setRunGuidanceError("");
      return undefined;
    }
    let cancelled = false;
    setRunGuidanceLoading(true);
    setRunGuidanceError("");
    void listRunInterventions(cwd, activeConversationSourceRunId, 100)
      .then((response) => {
        if (!cancelled) {
          setRunGuidanceInterventions(response.interventions);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setRunGuidanceError(error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setRunGuidanceLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeConversationSourceRunId, cwd]);

  const cancelChannelRunGuidance = useCallback(async (interventionId: string): Promise<void> => {
    if (runGuidanceCancelingId) {
      return;
    }
    setRunGuidanceCancelingId(interventionId);
    setRunGuidanceError("");
    try {
      const response = await cancelRunIntervention(cwd, interventionId);
      setRunGuidanceInterventions((current) => current.map((item) => item.id === response.intervention.id ? response.intervention : item));
      showComposerFeedback("info", t("Queued guidance removed"));
      refreshChannelRunGuidanceSurfaces();
    } catch (error) {
      setRunGuidanceError(error instanceof Error ? error.message : String(error));
    } finally {
      setRunGuidanceCancelingId("");
    }
  }, [cwd, refreshChannelRunGuidanceSurfaces, runGuidanceCancelingId, showComposerFeedback, t]);

  const promoteChannelRunGuidance = useCallback(async (interventionId: string): Promise<void> => {
    if (runGuidancePromotingId) {
      return;
    }
    setRunGuidancePromotingId(interventionId);
    setRunGuidanceError("");
    try {
      const response = await promoteRunIntervention(cwd, interventionId);
      setRunGuidanceInterventions((current) => current.map((item) => item.id === response.intervention.id ? response.intervention : item));
      showComposerFeedback("success", t("Queued guidance started"));
      refreshChannelRunGuidanceSurfaces();
      globalThis.setTimeout(() => {
        void refreshChannelRunGuidance(activeConversationSourceRunId);
        refreshChannelRunGuidanceSurfaces();
      }, 800);
    } catch (error) {
      setRunGuidanceError(error instanceof Error ? error.message : String(error));
    } finally {
      setRunGuidancePromotingId("");
    }
  }, [activeConversationSourceRunId, cwd, refreshChannelRunGuidance, refreshChannelRunGuidanceSurfaces, runGuidancePromotingId, showComposerFeedback, t]);

  const editChannelRunGuidance = useCallback(async (intervention: RunIntervention): Promise<void> => {
    const payload = intervention.messagePayload;
    const body = payload?.body ?? intervention.instruction;
    setMessageDraft(body);
    setPendingAttachments((payload?.attachmentIds ?? [])
      .map((attachmentId) => channelAttachmentById.get(attachmentId))
      .filter((attachment): attachment is ChannelAttachment => Boolean(attachment))
      .map((attachment) => ({
        localId: createLocalComposerAssetId("attachment"),
        fileName: attachment.fileName,
        sizeBytes: attachment.sizeBytes,
        state: "ready" as const,
        attachment,
      })));
    setPendingLinkPreviews((payload?.linkPreviewIds ?? [])
      .map((previewId) => channelLinkPreviewById.get(previewId))
      .filter((preview): preview is ChannelLinkPreview => Boolean(preview))
      .map((preview) => ({
        localId: createLocalComposerAssetId("link"),
        url: preview.url,
        state: preview.status === "ready" ? "ready" as const : preview.status === "blocked" ? "blocked" as const : "failed" as const,
        preview,
        error: preview.errorMessage,
      })));
    setSendState("idle");
    setSendError("");
    await cancelChannelRunGuidance(intervention.id);
    focusComposerAt(body.length);
  }, [cancelChannelRunGuidance, channelAttachmentById, channelLinkPreviewById, focusComposerAt, setMessageDraft, setPendingAttachments, setPendingLinkPreviews, setSendError, setSendState]);

  const visibleRunGuidanceInterventions = useMemo(
    () => runGuidanceInterventions.filter((item) => item.sourceRunId === activeConversationSourceRunId),
    [activeConversationSourceRunId, runGuidanceInterventions],
  );
  const openRunGuidanceInterventions = useMemo(
    () => visibleRunGuidanceInterventions.filter((item) => isConversationGuidanceQueueVisible(item.status)),
    [visibleRunGuidanceInterventions],
  );
  const runGuidanceItems = useMemo<readonly ConversationGuidanceItem[]>(
    () =>
      openRunGuidanceInterventions.map((intervention) => {
        const isQueued = intervention.status === "queued";
        const rowBusy = runGuidanceCancelingId === intervention.id || runGuidancePromotingId === intervention.id;
        return {
          id: intervention.id,
          instruction: intervention.messagePayload?.body || intervention.instruction,
          attachments: (intervention.messagePayload?.attachmentIds ?? [])
            .map((attachmentId) => channelAttachmentById.get(attachmentId))
            .filter((attachment): attachment is ChannelAttachment => Boolean(attachment))
            .map((attachment) => ({ id: attachment.id, label: attachment.fileName })),
          linkPreviews: (intervention.messagePayload?.linkPreviewIds ?? [])
            .map((previewId) => channelLinkPreviewById.get(previewId))
            .filter((preview): preview is ChannelLinkPreview => Boolean(preview))
            .map((preview) => ({ id: preview.id, label: preview.title || preview.url })),
          fileRefs: (intervention.messagePayload?.fileRefs ?? []).map((fileRef, index) => ({
            id: `${fileRef.path}:${fileRef.label ?? ""}:${index}`,
            label: fileRef.label ?? fileRef.path,
            status: fileRef.materializationStatus,
          })),
          statusLabel: channelRunInterventionStatusLabel(intervention.status, t),
          meta: channelRunInterventionModeLabel(intervention.mode, t),
          promoteLabel: t("Run this guidance now"),
          promoteDisabled: rowBusy || Boolean(runGuidanceSubmitting) || !activeConversationRun,
          promoteLoading: runGuidancePromotingId === intervention.id,
          onPromote: isQueued && activeConversationRun ? () => void promoteChannelRunGuidance(intervention.id) : undefined,
          deleteLabel: t("Delete queued guidance"),
          deleteDisabled: rowBusy,
          deleteLoading: runGuidanceCancelingId === intervention.id,
          onDelete: isQueued ? () => void cancelChannelRunGuidance(intervention.id) : undefined,
          moreLabel: t("More guidance actions"),
          editLabel: t("Edit message"),
          editDisabled: rowBusy,
          onEdit: isQueued ? () => void editChannelRunGuidance(intervention) : undefined,
          closeQueueLabel: t("Close queue"),
          closeQueueDisabled: rowBusy,
          closeQueueLoading: runGuidanceCancelingId === intervention.id,
          onCloseQueue: isQueued ? () => void cancelChannelRunGuidance(intervention.id) : undefined,
        };
      }),
    [
      activeConversationRun,
      cancelChannelRunGuidance,
      channelAttachmentById,
      channelLinkPreviewById,
      editChannelRunGuidance,
      openRunGuidanceInterventions,
      promoteChannelRunGuidance,
      runGuidanceCancelingId,
      runGuidancePromotingId,
      runGuidanceSubmitting,
      t,
    ],
  );

  const submitChannelRunGuidanceFromDraft = useCallback(async (): Promise<boolean> => {
    if (!selectedChannelId || runGuidanceSubmitting || composerBusy || assetOperationPending) {
      return false;
    }
    if (!activeConversationRun || !activeConversationSourceRunId) {
      setRunGuidanceError(t("Select a teammate before queueing guidance."));
      return false;
    }
    const draftSnapshot = messageDraft;
    const messageMentionsSnapshot = messageMentions;
    const pendingAttachmentsSnapshot = pendingAttachments;
    const pendingLinkPreviewsSnapshot = pendingLinkPreviews;
    const serializedInput = serializeComposerInputParts(composerInputParts);
    const body = serializedInput.body.trim();
    const fileRefs = [...composerFileRefs];
    const guidanceFileRefs = fileRefs.map((fileRef) => ({
      path: fileRef.path,
      ...(fileRef.label ? { label: fileRef.label } : {}),
      rootRelation: "unknown" as const,
      kind: "unknown" as const,
      materializationStatus: "not_loaded" as const,
    }));
    const attachmentIds = [...serializedInput.attachmentIds];
    const pendingPreviewRecords = pendingLinkPreviews.flatMap((item) => item.preview ? [item.preview] : []);
    const newPreviews: ChannelLinkPreview[] = [];
    if (!body && attachmentIds.length === 0 && readyLinkPreviewIds.length === 0 && fileRefs.length === 0) {
      return false;
    }
    setRunGuidanceSubmitting("queue_followup");
    setRunGuidanceError("");
    setComposerBusy(true);
    try {
      for (const url of extractUrls(body)) {
        if (!pendingPreviewRecords.some((preview) => preview.normalizedUrl === url || preview.url === url)) {
          try {
            const preview = await onCreateLinkPreview(url);
            if (preview) {
              newPreviews.push(preview);
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            setPendingLinkPreviews((current) => [
              ...current,
              { localId: createLocalComposerAssetId("link"), url, state: "failed", error: message },
            ]);
          }
        }
      }
      const linkPreviews = [...pendingPreviewRecords, ...newPreviews];
      const messagePayload = {
        body,
        attachmentIds,
        linkPreviewIds: linkPreviews.map((preview) => preview.id),
        fileRefs: guidanceFileRefs,
      };
      const instruction = summarizeChannelGuidancePayload(messagePayload, t);
      const response = await createRunIntervention(cwd, activeConversationSourceRunId, {
        mode: "queue_followup",
        instruction,
        messagePayload,
        idempotencyKey: `web-channel:${activeConversationRun.id}:queue_followup:${Date.now()}:${Math.random().toString(36).slice(2)}`,
      });
      setRunGuidanceInterventions((current) => [...current.filter((item) => item.id !== response.intervention.id), response.intervention]
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt)));
      setMessageDraft("");
      setMessageMentions([]);
      setPendingAttachments([]);
      setPendingLinkPreviews([]);
      autoPreviewUrlsRef.current.clear();
      setMentionPicker(undefined);
      setMentionActiveIndex(0);
      setSendState("idle");
      setSendError("");
      showComposerFeedback("success", t("Guidance queued"));
      revokePendingAttachmentPreviews(pendingAttachmentsSnapshot, (previewUrl) => attachmentPreviewUrlsRef.current.delete(previewUrl));
      refreshChannelRunGuidanceSurfaces();
      globalThis.setTimeout(() => {
        void refreshChannelRunGuidance(activeConversationSourceRunId);
        refreshChannelRunGuidanceSurfaces();
      }, 250);
      return true;
    } catch (error) {
      setMessageDraft(draftSnapshot);
      setMessageMentions(messageMentionsSnapshot);
      setPendingAttachments(pendingAttachmentsSnapshot);
      setPendingLinkPreviews(pendingLinkPreviewsSnapshot);
      setRunGuidanceError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setComposerBusy(false);
      setRunGuidanceSubmitting("");
    }
  }, [
    activeConversationRun,
    activeConversationSourceRunId,
    assetOperationPending,
    attachmentPreviewUrlsRef,
    autoPreviewUrlsRef,
    composerBusy,
    composerFileRefs,
    composerInputParts,
    cwd,
    messageDraft,
    messageMentions,
    onCreateLinkPreview,
    pendingAttachments,
    pendingLinkPreviews,
    readyLinkPreviewIds.length,
    refreshChannelRunGuidance,
    refreshChannelRunGuidanceSurfaces,
    runGuidanceSubmitting,
    selectedChannelId,
    setComposerBusy,
    setMentionActiveIndex,
    setMentionPicker,
    setMessageDraft,
    setMessageMentions,
    setPendingAttachments,
    setPendingLinkPreviews,
    setSendError,
    setSendState,
    showComposerFeedback,
    t,
  ]);

  const sendMessage = useCallback(async (): Promise<void> => {
    if (!selectedChannelId || composerBusy || assetOperationPending || !composerHasSendableContent) {
      return;
    }
    const retryingFailedSend = sendState === "failed";
    const draftSnapshot = messageDraft;
    const sendChannelId = selectedChannelId;
    const messageMentionsSnapshot = messageMentions;
    const pendingAttachmentsSnapshot = pendingAttachments;
    const pendingLinkPreviewsSnapshot = pendingLinkPreviews;
    const serializedInput = serializeComposerInputParts(composerInputParts);
    const body = serializedInput.body.trim();
    const slashIntent = parseComposerSlashIntent(body, {
      teammateMentions: teammateOptions.map((teammate) => ({ id: teammate.id, label: teammate.label })),
      commands: slashCommands,
    });
    const fileRefs = [...composerFileRefs];
    const pastedUrls = extractUrls(body);
    const newPreviews: ChannelLinkPreview[] = [];
    const attachmentIds = [...serializedInput.attachmentIds];
    const pendingPreviewRecords = pendingLinkPreviews.flatMap((item) => item.preview ? [item.preview] : []);
    const mentions = mergeMentions(messageMentions, findMentionsInText(body, teammateOptions));
    const shouldRequestAi = mentions.some((mention) => mention.kind === "ai-teammate");
    let pendingSendPreviewId = "";
    messageFeedScrollToLatest();
    setComposerBusy(true);
    setSendState("sending");
    setSendError("");
    try {
      if (slashIntent.kind === "session_command") {
        if (slashIntent.commandId === "plan") {
          onRevealPlanModeChip();
          if (slashIntent.action === "status") {
            showComposerFeedback("info", planModeActive ? t("Plan Mode is on") : t("Plan Mode is off"));
          } else {
            const nextActive = slashIntent.action === "on";
            await onSetPlanMode(nextActive);
          }
        }
        if (slashIntent.commandId === "goal") {
          onRevealGoalChip();
          if (slashIntent.action === "status") {
            showComposerFeedback("info", activeGoal ? t("Goal is {status}: {objective}", { status: activeGoal.status, objective: activeGoal.objective }) : t("Goal is not set"));
          } else if (slashIntent.action === "pause") {
            await onPatchGoal({ status: "paused" });
            showComposerFeedback("success", t("Goal paused"));
          } else if (slashIntent.action === "resume") {
            await onPatchGoal({ status: "active", blockedReason: null });
            showComposerFeedback("success", t("Goal resumed"));
          } else if (slashIntent.action === "clear") {
            await onClearGoal();
            showComposerFeedback("success", t("Goal cleared"));
          } else if (slashIntent.action === "complete") {
            const reason = slashIntent.args.replace(/^complete\b/i, "").trim();
            await onCompleteGoal(reason);
            showComposerFeedback("success", t("Goal completed"));
          } else {
            const objective = slashIntent.action === "edit"
              ? slashIntent.args.replace(/^edit\b/i, "").trim()
              : slashIntent.args.trim();
            if (!objective) {
              const draft = activeGoal ? `/goal ${activeGoal.objective}` : "/goal ";
              setMessageDraft(draft);
              focusComposerAt(draft.length);
              showComposerFeedback("info", activeGoal ? t("Edit the goal objective and press Enter") : t("Type a goal objective and press Enter"));
              setSendState("idle");
              setSendError("");
              return;
            }
            await onSetGoalObjective(objective, Boolean(activeGoal));
            showComposerFeedback("success", activeGoal ? t("Goal updated") : t("Goal set"));
          }
        }
        setMessageDraft("");
        setMessageMentions([]);
        setMentionPicker(undefined);
        setMentionActiveIndex(0);
        setSendState("idle");
        setSendError("");
        return;
      }
      if (slashIntent.kind === "agent_command" || slashIntent.kind === "multi_agent_command" || slashIntent.kind === "global_command") {
        if (planModeActive) {
          showComposerFeedback("error", t("Exit Plan Mode before creating implementation tasks."));
          setSendState("idle");
          setSendError("");
          return;
        }
        const prompt = slashIntent.args.trim() || t("Run /{command} using the current channel context.", { command: slashIntent.commandId });
        const title = titleFromPrompt(prompt || slashIntent.commandLabel);
        const slashTaskTargets = slashIntent.kind === "multi_agent_command"
          ? slashIntent.teammates.map((teammate) => ({ id: teammate.id, label: teammate.label }))
          : slashIntent.kind === "agent_command"
            ? [{ id: slashIntent.teammateId, label: slashIntent.teammateLabel }]
            : [undefined];
        for (const target of slashTaskTargets) {
          await onCreateTaskFromSlashCommand({
            title,
            prompt,
            requestedSkillId: slashIntent.commandId,
            attachmentIds,
            ...(target ? { assigneeTeammateId: target.id } : {}),
          });
        }
        setMessageDraft("");
        setMessageMentions([]);
        revokePendingAttachmentPreviews(pendingAttachmentsSnapshot, (previewUrl) => attachmentPreviewUrlsRef.current.delete(previewUrl));
        setPendingAttachments([]);
        setPendingLinkPreviews([]);
        autoPreviewUrlsRef.current.clear();
        setSendState("idle");
        setSendError("");
        return;
      }
      for (const url of pastedUrls) {
        if (!pendingPreviewRecords.some((preview) => preview.normalizedUrl === url || preview.url === url)) {
          try {
            const preview = await onCreateLinkPreview(url);
            if (preview) {
              newPreviews.push(preview);
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            setPendingLinkPreviews((current) => [
              ...current,
              { localId: createLocalComposerAssetId("link"), url, state: "failed", error: message },
            ]);
          }
        }
      }
      const linkPreviews = [...pendingPreviewRecords, ...newPreviews];
      const pendingSendPreview = {
        id: createLocalComposerAssetId("message"),
        channelId: selectedChannelId,
        threadId: selectedChannelBranchRootThreadId,
        body,
        mentions,
        attachmentIds,
        linkPreviewIds: linkPreviews.map((preview) => preview.id),
        fileRefs,
        requestAiReply: shouldRequestAi,
        autoReplyMode: selectedChannel?.autoReplyMode ?? "mentions_only",
        createdAt: new Date().toISOString(),
      } satisfies PendingChannelSendPreview;
      pendingSendPreviewId = pendingSendPreview.id;
      setPendingChannelSendPreview(pendingSendPreview);
      setMessageDraft("");
      setMessageMentions([]);
      setPendingAttachments([]);
      setPendingLinkPreviews([]);
      autoPreviewUrlsRef.current.clear();
      const sendResult = await onSendMessage({
        threadId: selectedChannelBranchRootThreadId,
        body,
        mentions,
        attachmentIds,
        linkPreviewIds: linkPreviews.map((preview) => preview.id),
        fileRefs,
        requestAiReply: shouldRequestAi,
      });
      if (!isChannelCurrent(sendChannelId)) {
        if (sendResult.errorMessage) {
          rememberDetachedSendFailure(sendChannelId, {
            messageDraft: draftSnapshot,
            messageMentions: messageMentionsSnapshot,
            pendingAttachments: pendingAttachmentsSnapshot,
            pendingLinkPreviews: pendingLinkPreviewsSnapshot,
          }, sendResult.errorMessage);
        } else {
          rememberDetachedSendSuccess(sendChannelId);
        }
        return;
      }
      revokePendingAttachmentPreviews(pendingAttachmentsSnapshot, (previewUrl) => attachmentPreviewUrlsRef.current.delete(previewUrl));
      setPendingChannelSendPreview((current) => current?.id === pendingSendPreviewId ? undefined : current);
      if (sendResult.errorMessage) {
        setSendState("failed");
        setSendError(sendResult.errorMessage);
        return;
      }
      setSendState("idle");
      setSendError("");
      if (retryingFailedSend) {
        showComposerFeedback("success", t("Message sent"));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!isChannelCurrent(sendChannelId)) {
        rememberDetachedSendFailure(sendChannelId, {
          messageDraft: draftSnapshot,
          messageMentions: messageMentionsSnapshot,
          pendingAttachments: pendingAttachmentsSnapshot,
          pendingLinkPreviews: pendingLinkPreviewsSnapshot,
        }, message);
        return;
      }
      if (pendingSendPreviewId) {
        setPendingChannelSendPreview((current) => current?.id === pendingSendPreviewId ? undefined : current);
        setMessageDraft(draftSnapshot);
        setMessageMentions(messageMentionsSnapshot);
        setPendingAttachments(pendingAttachmentsSnapshot);
        setPendingLinkPreviews(pendingLinkPreviewsSnapshot);
      }
      setSendState("failed");
      setSendError(message);
    } finally {
      setComposerBusy(false);
    }
  }, [
    activeGoal,
    assetOperationPending,
    attachmentPreviewUrlsRef,
    autoPreviewUrlsRef,
    composerBusy,
    composerFileRefs,
    composerHasSendableContent,
    composerInputParts,
    messageDraft,
    messageFeedScrollToLatest,
    messageMentions,
    onCreateLinkPreview,
    onCreateTaskFromSlashCommand,
    onClearGoal,
    onPatchGoal,
    onRevealGoalChip,
    onRevealPlanModeChip,
    onSetGoalObjective,
    onSetPlanMode,
    onSendMessage,
    isChannelCurrent,
    pendingAttachments,
    pendingLinkPreviews,
    rememberDetachedSendFailure,
    rememberDetachedSendSuccess,
    selectedChannel?.autoReplyMode,
    selectedChannelBranchRootThreadId,
    selectedChannelId,
    planModeActive,
    sendState,
    setComposerBusy,
    setMessageDraft,
    setMessageMentions,
    setPendingAttachments,
    setPendingChannelSendPreview,
    setPendingLinkPreviews,
    setSendError,
    setSendState,
    showComposerFeedback,
    slashCommands,
    t,
    teammateOptions,
  ]);

  const handleChannelComposerSubmit = useCallback((): void => {
    if (guidanceModeActive) {
      if (!activeConversationRun) {
        setRunGuidanceError(t("Select a teammate before queueing guidance."));
        return;
      }
      if (composerHasSendableContent) {
        void submitChannelRunGuidanceFromDraft();
        return;
      }
      onCancelActiveRun(activeConversationRun);
      return;
    }
    void sendMessage();
  }, [activeConversationRun, composerHasSendableContent, guidanceModeActive, onCancelActiveRun, sendMessage, submitChannelRunGuidanceFromDraft, t]);

  const dismissSendError = useCallback((): void => {
    setSendState("idle");
    setSendError("");
  }, [setSendError, setSendState]);

  return {
    runGuidanceLoading,
    runGuidanceSubmitting,
    runGuidanceError,
    runGuidanceItems,
    openRunGuidanceInterventions,
    submitChannelRunGuidanceFromDraft,
    sendMessage,
    handleChannelComposerSubmit,
    dismissSendError,
  };
}

function channelRunInterventionStatusLabel(
  status: RunIntervention["status"],
  t: Translate,
): string {
  if (status === "cancelling_source") {
    return t("Stopping source");
  }
  if (status === "starting_continuation") {
    return t("Starting continuation");
  }
  if (status === "started") {
    return t("Started");
  }
  if (status === "cancelled") {
    return t("Cancelled");
  }
  if (status === "failed") {
    return t("Failed");
  }
  return t("Queued");
}

function channelRunInterventionModeLabel(
  mode: RunIntervention["mode"],
  t: Translate,
): string {
  return mode === "interrupt_redirect" ? t("Stop and redirect") : t("Queue guidance");
}

function extractUrls(value: string): string[] {
  const matches = value.match(/https?:\/\/[^\s)]+/g) ?? [];
  return [...new Set(matches.map((item) => item.replace(/[.,;!?]+$/, "")))];
}

function summarizeChannelGuidancePayload(
  payload: {
    readonly body: string;
    readonly attachmentIds: readonly string[];
    readonly linkPreviewIds: readonly string[];
    readonly fileRefs?: readonly ChannelMessageFileRef[];
  },
  t: Translate,
): string {
  if (payload.body.trim()) {
    return payload.body.trim();
  }
  if (payload.fileRefs?.length) {
    return t("Queued guidance with {count} file reference(s)", { count: payload.fileRefs.length });
  }
  if (payload.attachmentIds.length > 0 && payload.linkPreviewIds.length > 0) {
    return t("Queued guidance with {attachmentCount} attachment(s) and {linkCount} link(s)", {
      attachmentCount: payload.attachmentIds.length,
      linkCount: payload.linkPreviewIds.length,
    });
  }
  if (payload.attachmentIds.length > 0) {
    return t("Queued guidance with {count} attachment(s)", { count: payload.attachmentIds.length });
  }
  if (payload.linkPreviewIds.length > 0) {
    return t("Queued guidance with {count} link(s)", { count: payload.linkPreviewIds.length });
  }
  return t("Queued guidance");
}
