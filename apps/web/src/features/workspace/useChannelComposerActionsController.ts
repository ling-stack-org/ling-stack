import { useCallback, useEffect, useMemo, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { ComposerSlashCommandOption } from "@ling-stack/core/composer-slash-intents";
import {
  cancelRunIntervention,
  listRunInterventions,
} from "../../api.js";
import type { Translate } from "../../i18n.js";
import { titleFromPrompt } from "../../lib/formatting.js";
import {
  createLocalComposerAssetId,
  composerWorkspaceFileParts,
  parseComposerSlashIntent,
  parseComposerInputParts,
  revokePendingAttachmentPreviews,
  serializeComposerInputParts,
  type ComposerInputPart,
  type PendingAttachmentItem,
  type TokenizedComposerInputHandle,
} from "../../shared/components/index.js";
import {
  isConversationGuidanceQueueVisible,
  type ConversationSendLifecycleController,
  type ConversationSendOperation,
  type ConversationGuidanceItem,
} from "../../shared/conversation/index.js";
import type {
  Channel,
  ChannelAttachment,
  ChannelMessage,
  ChannelReplyPendingEvent,
  ChannelReplyDispatch,
  ChannelReplyDisposition,
  ConversationActiveReplyTarget,
  ChannelLinkPreview,
  ChannelMention,
  ChannelMessageFileRef,
  LingThreadGoal,
  RunIntervention,
} from "../../types.js";
import type { ChannelComposerSendState } from "./ChannelComposer.js";
import type { PendingChannelSendPreview } from "./ChannelMessageFeed.js";
import type { PendingLinkPreviewItem } from "./useChannelComposerDraftController.js";
import type { DetachedChannelSendSnapshot } from "./useChannelComposerSnapshotController.js";
import {
  filterQueuedChannelGuidanceInterventions,
  type ChannelGuidanceTarget,
} from "./channel-guidance-targets.js";
import {
  channelGuidanceTargetLabel,
  channelRunInterventionStatusLabel,
} from "./channel-guidance-label.js";
import { projectAuthoritativeChannelGuidanceItem } from "./channel-guidance-item.js";
import {
  acknowledgePendingChannelSendPreview,
  projectPendingChannelReply,
} from "./channel-pending-send-preview.js";
import {
  confirmOptimisticChannelGuidance,
  createOptimisticChannelGuidance,
  projectOptimisticChannelGuidanceItems,
  pruneVisibleOptimisticChannelGuidance,
  removeOptimisticChannelGuidance,
  upsertOptimisticChannelGuidance,
  type OptimisticChannelGuidance,
} from "./channel-optimistic-guidance.js";
import { findMentionsInText, mergeMentions } from "./channelMentionText.js";

interface ChannelComposerActionsInput {
  readonly cwd: string;
  readonly selectedChannelId: string;
  readonly selectedChannelBranchRootThreadId?: string;
  readonly selectedChannel: Channel | undefined;
  readonly sendLifecycle: ConversationSendLifecycleController;
  readonly activeConversationTarget: ChannelGuidanceTarget | undefined;
  readonly activeConversationSourceRunId: string;
  readonly visibleChannelMessageIds: ReadonlySet<string>;
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
  readonly composerInputRef: MutableRefObject<TokenizedComposerInputHandle | null>;
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
    readonly replyDisposition?: ChannelReplyDisposition;
    readonly onMessageAccepted?: (message: ChannelMessage) => void;
    readonly onReplyPending?: (pending: ChannelReplyPendingEvent) => void;
    readonly onReplyLinked?: (target: ConversationActiveReplyTarget) => void;
    readonly onReplyDispatch?: (dispatch: ChannelReplyDispatch) => void;
  }) => Promise<{ readonly errorMessage?: string }>;
  readonly isChannelCurrent: (channelId: string) => boolean;
  readonly rememberDetachedSendFailure: (
    channelId: string,
    snapshot: DetachedChannelSendSnapshot,
    errorMessage: string,
  ) => void;
  readonly rememberDetachedSendSuccess: (channelId: string) => void;
  readonly onCancelActiveReply: (target: ChannelGuidanceTarget) => void;
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
  readonly sendMessage: (draftOverride?: string) => Promise<void>;
  readonly handleChannelComposerSubmit: () => void;
  readonly dismissSendError: () => void;
}

export function useChannelComposerActionsController({
  activeConversationTarget,
  activeConversationSourceRunId,
  visibleChannelMessageIds,
  assetOperationPending,
  attachmentPreviewUrlsRef,
  autoPreviewUrlsRef,
  channelAttachmentById,
  channelLinkPreviewById,
  planModeActive,
  activeGoal,
  composerHasSendableContent,
  composerInputParts,
  composerInputRef,
  cwd,
  focusComposerAt,
  sendLifecycle,
  isCancellingRun,
  messageDraft,
  messageFeedScrollToLatest,
  messageMentions,
  onCancelActiveReply,
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
  rememberDetachedSendFailure,
  rememberDetachedSendSuccess,
  selectedChannel,
  selectedChannelBranchRootThreadId,
  selectedChannelId,
  sendState,
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
  const [optimisticGuidance, setOptimisticGuidance] = useState<readonly OptimisticChannelGuidance[]>([]);
  const [runGuidanceLoading, setRunGuidanceLoading] = useState(false);
  const runGuidanceSubmitting = "" as const;
  const [runGuidanceCancelingId, setRunGuidanceCancelingId] = useState("");
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
  }, [activeConversationSourceRunId, activeConversationTarget?.activeReply.runId, cwd]);

  const cancelChannelRunGuidance = useCallback(async (interventionId: string): Promise<void> => {
    if (runGuidanceCancelingId) {
      return;
    }
    setRunGuidanceCancelingId(interventionId);
    setRunGuidanceError("");
    try {
      const response = await cancelRunIntervention(cwd, interventionId);
      setRunGuidanceInterventions((current) => current.map((item) => item.id === response.intervention.id ? response.intervention : item));
      setOptimisticGuidance((current) => removeOptimisticChannelGuidance(current, interventionId));
      showComposerFeedback("info", t("Queued guidance removed"));
      refreshChannelRunGuidanceSurfaces();
    } catch (error) {
      setRunGuidanceError(error instanceof Error ? error.message : String(error));
    } finally {
      setRunGuidanceCancelingId("");
    }
  }, [cwd, refreshChannelRunGuidanceSurfaces, runGuidanceCancelingId, showComposerFeedback, t]);

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
    () => filterQueuedChannelGuidanceInterventions(
      runGuidanceInterventions.filter((item) => item.sourceRunId === activeConversationSourceRunId),
      visibleChannelMessageIds,
    ),
    [activeConversationSourceRunId, runGuidanceInterventions, visibleChannelMessageIds],
  );
  const openRunGuidanceInterventions = useMemo(
    () => visibleRunGuidanceInterventions.filter((item) => (
      isConversationGuidanceQueueVisible(item.status)
    )),
    [visibleRunGuidanceInterventions],
  );
  const runGuidanceItems = useMemo<readonly ConversationGuidanceItem[]>(
    () => {
      const authoritativeIds = new Set(openRunGuidanceInterventions.map((intervention) => intervention.id));
      return [
        ...projectOptimisticChannelGuidanceItems({
          current: optimisticGuidance,
          channelId: selectedChannelId,
          sourceRunId: activeConversationSourceRunId,
          authoritativeInterventionIds: authoritativeIds,
          visibleMessageIds: visibleChannelMessageIds,
        }),
        ...openRunGuidanceInterventions.map((intervention) => projectAuthoritativeChannelGuidanceItem({
          intervention,
          attachmentById: channelAttachmentById,
          linkPreviewById: channelLinkPreviewById,
          teammateOptions,
          cancelingId: runGuidanceCancelingId,
          onCancel: (interventionId) => void cancelChannelRunGuidance(interventionId),
          onEdit: (item) => void editChannelRunGuidance(item),
          t,
        })),
      ];
    },
    [
      activeConversationTarget,
      cancelChannelRunGuidance,
      channelAttachmentById,
      channelLinkPreviewById,
      editChannelRunGuidance,
      openRunGuidanceInterventions,
      optimisticGuidance,
      runGuidanceCancelingId,
      selectedChannelId,
      t,
      teammateOptions,
      visibleChannelMessageIds,
    ],
  );

  useEffect(() => {
    setOptimisticGuidance((current) => {
      const next = pruneVisibleOptimisticChannelGuidance(current, visibleChannelMessageIds);
      return next.length === current.length ? current : next;
    });
  }, [visibleChannelMessageIds]);

  const sendMessage = useCallback(async (draftOverride?: string): Promise<void> => {
    if (!selectedChannelId || assetOperationPending) {
      return;
    }
    const retryingFailedSend = sendState === "failed";
    const liveDraft = draftOverride ?? composerInputRef.current?.readValue() ?? messageDraft;
    const readyAttachmentIds = pendingAttachments.flatMap((item) => item.attachment ? [item.attachment.id] : []);
    const liveInputParts = liveDraft === messageDraft
      ? composerInputParts
      : parseComposerInputParts(liveDraft, {
          cwd,
          attachments: readyAttachmentIds.map((attachmentId) => ({ attachmentId })),
          teammateMentions: teammateOptions.map((teammate) => ({ id: teammate.id, label: teammate.label })),
          slashCommands,
          linkPreviews: pendingLinkPreviews.map((item) => ({
            url: item.url,
            normalizedUrl: item.preview?.normalizedUrl,
            title: item.preview?.title,
            state: item.state,
            error: item.error ?? item.preview?.errorMessage,
          })),
        });
    const serializedInput = serializeComposerInputParts(liveInputParts);
    const body = serializedInput.body.trim();
    const fileRefs = composerWorkspaceFileParts(liveInputParts).map((part): ChannelMessageFileRef => ({
      path: part.path,
      label: part.path,
      source: "composer",
      ...(part.line !== undefined ? { line: part.line } : {}),
    }));
    if (!body && serializedInput.attachmentIds.length === 0 && !pendingLinkPreviews.some((item) => item.preview) && fileRefs.length === 0) {
      return;
    }
    const draftSnapshot = liveDraft;
    const sendChannelId = selectedChannelId;
    const messageMentionsSnapshot = messageMentions;
    const pendingAttachmentsSnapshot = pendingAttachments;
    const pendingLinkPreviewsSnapshot = pendingLinkPreviews;
    const slashIntent = parseComposerSlashIntent(body, {
      teammateMentions: teammateOptions.map((teammate) => ({ id: teammate.id, label: teammate.label })),
      commands: slashCommands,
    });
    const pastedUrls = extractUrls(body);
    const newPreviews: ChannelLinkPreview[] = [];
    const attachmentIds = [...serializedInput.attachmentIds];
    const pendingPreviewRecords = pendingLinkPreviews.flatMap((item) => item.preview ? [item.preview] : []);
    const mentions = mergeMentions(messageMentions, findMentionsInText(body, teammateOptions));
    const shouldRequestAi = true;
    let pendingSendPreviewId = "";
    let acceptedSourceMessageId = "";
    let pendingAttachmentPreviewsReleased = false;
    let sendOperation: ConversationSendOperation | undefined;
    messageFeedScrollToLatest();
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
      sendOperation = sendLifecycle.begin();
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
      const replyDisposition: ChannelReplyDisposition | undefined = activeConversationTarget
        ? {
            mode: "queue_followup",
            activeRunId: activeConversationTarget.activeReply.runId,
          }
        : sendOperation.hasPendingPredecessor
          ? { mode: "queue_followup" }
          : undefined;
      const shouldProjectAsQueuedGuidance = Boolean(replyDisposition);
      if (shouldProjectAsQueuedGuidance) {
        const aiMentions = mentions.filter((mention) => mention.kind === "ai-teammate");
        const targetTeammateId = aiMentions.length === 1 ? aiMentions[0]?.id : "ling_agent";
        setPendingChannelSendPreview(undefined);
        setOptimisticGuidance((current) => upsertOptimisticChannelGuidance(current, createOptimisticChannelGuidance({
          id: pendingSendPreview.id,
          channelId: sendChannelId,
          instruction: body,
          pendingAttachments: pendingAttachmentsSnapshot,
          linkPreviews,
          fileRefs,
          statusLabel: t("Sending..."),
          meta: channelGuidanceTargetLabel({
            teammateId: targetTeammateId,
            teammateOptions,
            lingAgentLabel: t("Ling Agent"),
            fallbackLabel: t("AI teammate"),
          }),
        })));
      } else {
        setPendingChannelSendPreview(pendingSendPreview);
      }
      setMessageDraft((current) => current === draftSnapshot ? "" : current);
      setMessageMentions((current) => current === messageMentionsSnapshot ? [] : current);
      setPendingAttachments((current) => current === pendingAttachmentsSnapshot ? [] : current);
      setPendingLinkPreviews((current) => current === pendingLinkPreviewsSnapshot ? [] : current);
      autoPreviewUrlsRef.current.clear();
      const sendResult = await onSendMessage({
        threadId: selectedChannelBranchRootThreadId,
        body,
        mentions,
        attachmentIds,
        linkPreviewIds: linkPreviews.map((preview) => preview.id),
        fileRefs,
        requestAiReply: shouldRequestAi,
        ...(replyDisposition ? { replyDisposition } : {}),
        onMessageAccepted: (message) => {
          if (!sendOperation || !sendLifecycle.accept(sendOperation) || !isChannelCurrent(sendChannelId)) return;
          acceptedSourceMessageId = message.id;
          setPendingChannelSendPreview((current) => acknowledgePendingChannelSendPreview(
            current,
            pendingSendPreviewId,
            message.id,
          ));
          if (!pendingAttachmentPreviewsReleased) {
            pendingAttachmentPreviewsReleased = true;
            revokePendingAttachmentPreviews(pendingAttachmentsSnapshot, (previewUrl) => attachmentPreviewUrlsRef.current.delete(previewUrl));
          }
        },
        onReplyPending: (pending) => {
          if (!sendOperation || !sendLifecycle.accept(sendOperation) || !isChannelCurrent(sendChannelId)) return;
          setOptimisticGuidance((current) => removeOptimisticChannelGuidance(current, pendingSendPreviewId));
          setPendingChannelSendPreview((current) => projectPendingChannelReply(
            current?.id === pendingSendPreviewId
              ? current
              : { ...pendingSendPreview, sourceMessageId: acceptedSourceMessageId || pending.sourceMessageId },
            pendingSendPreviewId,
            pending,
          ));
        },
        onReplyLinked: (target) => {
          if (!sendOperation || !sendLifecycle.link(sendOperation, target) || !isChannelCurrent(sendChannelId)) return;
          setSendState("idle");
          setSendError("");
        },
        onReplyDispatch: (dispatch) => {
          if (!isChannelCurrent(sendChannelId)) return;
          if (dispatch.disposition !== "followup_queued" || !dispatch.intervention) {
            setOptimisticGuidance((current) => removeOptimisticChannelGuidance(current, pendingSendPreviewId));
            return;
          }
          const confirmedIntervention = dispatch.intervention;
          setOptimisticGuidance((current) => confirmOptimisticChannelGuidance(
            current,
            pendingSendPreviewId,
            confirmedIntervention,
            channelRunInterventionStatusLabel(confirmedIntervention.status, t),
          ));
          setPendingChannelSendPreview((current) => current?.id === pendingSendPreviewId ? undefined : current);
          setRunGuidanceInterventions((current) => {
            const index = current.findIndex((item) => item.id === confirmedIntervention.id);
            if (index < 0) return [...current, confirmedIntervention];
            return current.map((item) => item.id === confirmedIntervention.id ? confirmedIntervention : item);
          });
          refreshChannelRunGuidanceSurfaces();
        },
      });
      if (!isChannelCurrent(sendChannelId)) {
        setOptimisticGuidance((current) => removeOptimisticChannelGuidance(current, pendingSendPreviewId));
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
      if (sendOperation) sendLifecycle.settle(sendOperation);
      setOptimisticGuidance((current) => removeOptimisticChannelGuidance(current, pendingSendPreviewId));
      if (!pendingAttachmentPreviewsReleased) {
        revokePendingAttachmentPreviews(pendingAttachmentsSnapshot, (previewUrl) => attachmentPreviewUrlsRef.current.delete(previewUrl));
      }
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
      const failure = sendOperation
        ? sendLifecycle.fail(sendOperation)
        : { accepted: false, restoreInput: false };
      if (!isChannelCurrent(sendChannelId)) {
        setOptimisticGuidance((current) => removeOptimisticChannelGuidance(current, pendingSendPreviewId));
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
        setOptimisticGuidance((current) => removeOptimisticChannelGuidance(current, pendingSendPreviewId));
      }
      if (failure.restoreInput && pendingSendPreviewId) {
        setMessageDraft((current) => current.trim() ? current : draftSnapshot);
        setMessageMentions((current) => current.length > 0 ? current : messageMentionsSnapshot);
        setPendingAttachments((current) => current.length > 0 ? current : pendingAttachmentsSnapshot);
        setPendingLinkPreviews((current) => current.length > 0 ? current : pendingLinkPreviewsSnapshot);
      }
      setSendState("failed");
      setSendError(message);
    }
  }, [
    activeGoal,
    activeConversationTarget,
    assetOperationPending,
    attachmentPreviewUrlsRef,
    autoPreviewUrlsRef,
    composerInputParts,
    composerInputRef,
    cwd,
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
    sendLifecycle,
    planModeActive,
    sendState,
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
    if (composerHasSendableContent) {
      void sendMessage();
      return;
    }
    if (activeConversationTarget) {
      onCancelActiveReply(activeConversationTarget);
    }
  }, [activeConversationTarget, composerHasSendableContent, onCancelActiveReply, sendMessage]);

  const dismissSendError = useCallback((): void => {
    setSendState("idle");
    setSendError("");
  }, [setSendError, setSendState]);

  return {
    runGuidanceLoading,
    runGuidanceSubmitting,
    runGuidanceError,
    runGuidanceItems,
    sendMessage,
    handleChannelComposerSubmit,
    dismissSendError,
  };
}

function extractUrls(value: string): string[] {
  const matches = value.match(/https?:\/\/[^\s)]+/g) ?? [];
  return [...new Set(matches.map((item) => item.replace(/[.,;!?]+$/, "")))];
}
