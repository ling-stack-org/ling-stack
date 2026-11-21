import { useEffect, useMemo, useRef, useState } from "react";
import type { CompanionNavigationRequest } from "../../../../desktop/shared/companion-capabilities.js";
import { ArrowUp, ExternalLink, Pause, Play, RefreshCw, Send, Sparkles, X, Zap } from "lucide-react";
import type {
  AiTeammate,
  CompanionAttentionItem,
  CompanionAttentionSource,
  CompanionAttentionUserInputPayload,
  CompanionProfile,
  CompanionState,
} from "../../types.js";
import {
  approveApproval,
  denyApproval,
  getCompanionAttention,
  interactWithCompanion,
  listCompanions,
  submitUserInputAnswer,
  updateCompanion,
} from "../../api.js";
import { useI18n } from "../../i18n.js";
import { Button, Icon, IconButton, Select, Textarea } from "../../shared/ui/index.js";
import { TeammateAvatarView } from "../teammates/TeammateAvatarView.js";
import { CompanionPetStage } from "./CompanionPetStage.js";
import { useCompanionChat } from "./use-companion-chat.js";
import { CompanionAttentionCard, type CompanionAnswerDraft } from "./CompanionAttentionCard.js";
import { chooseCompanionCardPlacement, sourceNavigationRequest } from "./companion-layout.js";

const companionRetryDelayMs = 5_000;
const companionRetryLimit = 3;

export function CompanionMiniPanel({
  cwd,
  teammates,
  open,
  onClose,
  onOpenSettings,
  onOpenSource,
  desktop = false,
}: {
  readonly cwd: string;
  readonly teammates: readonly AiTeammate[];
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onOpenSettings: () => void;
  readonly onOpenSource?: (request: CompanionNavigationRequest) => void;
  readonly desktop?: boolean;
}): React.JSX.Element | null {
  const { t } = useI18n();
  const [companions, setCompanions] = useState<readonly CompanionProfile[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [pinnedId, setPinnedId] = useState("");
  const [roleMenuOpen, setRoleMenuOpen] = useState(false);
  const [attentionItems, setAttentionItems] = useState<readonly CompanionAttentionItem[]>([]);
  const [activeAttentionId, setActiveAttentionId] = useState("");
  const [attentionLoading, setAttentionLoading] = useState(false);
  const [attentionError, setAttentionError] = useState("");
  const [attentionNotice, setAttentionNotice] = useState("");
  const attentionGenerationRef = useRef(0);
  const [conversationOpen, setConversationOpen] = useState(false);
  const [answering, setAnswering] = useState(false);
  const [interactionCompanionId, setInteractionCompanionId] = useState("");
  const [input, setInput] = useState("");
  const logRef = useRef<HTMLDivElement>(null);
  const followMessagesRef = useRef(true);
  const [activeActionId, setActiveActionId] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<"action" | "status" | "approval" | undefined>();
  const [error, setError] = useState("");
  const panelRef = useRef<HTMLElement>(null);
  const attentionCardRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const conversationRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const dragRef = useRef<{ pointerId: number; offsetX: number; offsetY: number } | undefined>(undefined);
  const actionQueueRef = useRef<string[]>([]);
  const [floatingPosition, setFloatingPosition] = useState<{ left: number; top: number }>();
  const [dragging, setDragging] = useState(false);
  const [cardPlacement, setCardPlacement] = useState<{ side: "right" | "left" | "above" | "below"; rect: { left: number; top: number; width: number; height: number } }>();
  const draftHydratedKeyRef = useRef("");

  const activeCompanions = useMemo(
    () => companions.filter((companion) => companion.status !== "disabled"),
    [companions],
  );
  const activeAttention = attentionItems.find((item) => item.id === activeAttentionId)
    ?? attentionItems.find((item) => item.status === "pending" || item.status === "active")
    ?? attentionItems[0];
  const actorCompanion = activeAttention?.actor?.teammateId
    ? activeCompanions.find((companion) => companion.teammateId === activeAttention.actor?.teammateId)
    : undefined;
  const interactionLocked = conversationOpen || Boolean(input.trim()) || answering || dragging;
  const selected = activeCompanions.find((companion) => companion.id === pinnedId)
    ?? (interactionLocked ? activeCompanions.find((companion) => companion.id === interactionCompanionId) : undefined)
    ?? activeCompanions.find((companion) => companion.id === selectedId)
    ?? actorCompanion
    ?? activeCompanions[0];
  const teammate = selected ? teammates.find((item) => item.id === selected.teammateId) : undefined;
  const chat = useCompanionChat({ cwd, companion: selected, open,
    onActions: enqueueActionIds,
    onDelivered: (body) => {
      setInput((current) => current.trim() === body ? "" : current);
    },
  });
  const { state, setState } = chat;
  const orderedMessages = useMemo(
    () => chat.messages.filter((message) => message.authorType !== "system")
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
    [chat.messages],
  );
  const emotion = selected?.manifest.emotions.find((item) => item.id === state?.emotionId)
    ?? selected?.manifest.emotions.find((item) => item.id === selected.manifest.defaultEmotionId);
  const visiblePhase = chat.sending ? "thinking" : state && (
    state.phase === "error"
    || Boolean(activeActionId)
    || isRecentCompanionState(state.updatedAt)
  ) ? state.phase : activeAttention?.status === "pending" ? "reacting" : "idle";
  const pendingAttentionCount = attentionItems.filter((item) => item.status === "pending" || item.status === "active").length;
  const [cardSide, setCardSide] = useState<"right" | "left" | "above" | "below">("left");

  useEffect(() => {
    if (followMessagesRef.current && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [orderedMessages.at(-1)?.id, orderedMessages.at(-1)?.body]);

  useEffect(() => {
    if (activeActionId) {
      const timer = window.setTimeout(() => setActiveActionId(undefined), 1400);
      return () => window.clearTimeout(timer);
    }
    const nextActionId = actionQueueRef.current.shift();
    if (nextActionId) setActiveActionId(nextActionId);
    return undefined;
  }, [activeActionId]);

  useEffect(() => {
    if (!open || !cwd.trim()) {
      return;
    }
    let cancelled = false;
    let retryTimer: number | undefined;
    let attempt = 0;
    const load = (): void => {
      if (cancelled) return;
      attempt += 1;
      setLoading(true);
      setError("");
      void listCompanions(cwd.trim())
        .then((response) => {
          if (cancelled) return;
          const next = response.companions.filter((companion) => companion.status !== "disabled");
          setCompanions(next);
          setSelectedId((current) => next.some((companion) => companion.id === current) ? current : "");
          setLoading(false);
        })
        .catch((caught) => {
          if (cancelled) return;
          if (attempt <= companionRetryLimit) {
            retryTimer = window.setTimeout(load, companionRetryDelayMs);
            return;
          }
          setError(caught instanceof Error ? caught.message : String(caught));
          setLoading(false);
        });
    };
    load();
    return () => {
      cancelled = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    };
  }, [cwd, open]);

  useEffect(() => {
    if (!open || !cwd.trim()) return;
    try {
      const saved = window.localStorage.getItem("companion-pinned:" + cwd.trim());
      if (saved) setPinnedId(saved);
    } catch {
      // Pinning remains session-local when storage is unavailable.
    }
  }, [cwd, open]);

  useEffect(() => {
    if (!open || !cwd.trim() || !selected?.id) return;
    const key = companionDraftKey(cwd.trim(), selected.id);
    draftHydratedKeyRef.current = key;
    try {
      setInput(window.localStorage.getItem(key) ?? "");
    } catch {
      setInput("");
    }
  }, [cwd, open, selected?.id]);

  useEffect(() => {
    const key = draftHydratedKeyRef.current;
    if (!key) return;
    try {
      if (input.trim()) window.localStorage.setItem(key, input);
      else window.localStorage.removeItem(key);
    } catch {
      // Draft persistence is best effort in private or sandboxed contexts.
    }
  }, [input]);

  useEffect(() => {
    if (!open || !cwd.trim()) return;
    let cancelled = false;
    let timer: number | undefined;
    const load = async (): Promise<void> => {
      const generation = ++attentionGenerationRef.current;
      try {
        setAttentionLoading(true);
        const projection = await getCompanionAttention(cwd.trim(), { limit: 120 });
        if (cancelled || generation !== attentionGenerationRef.current) return;
        const nextItems = filterSeenAttentionItems(cwd.trim(), projection.items);
        setAttentionItems(nextItems);
        setAttentionError("");
        setActiveAttentionId((current) => preferredAttentionId(nextItems, current));
      } catch (caught) {
        if (!cancelled && generation === attentionGenerationRef.current) setAttentionError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        if (!cancelled && generation === attentionGenerationRef.current) setAttentionLoading(false);
      }
    };
    void load();
    timer = window.setInterval(() => void load(), 5_000);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, [cwd, open]);

  useEffect(() => {
    actionQueueRef.current = [];
    setActiveActionId(undefined);
    setAttentionNotice("");
    followMessagesRef.current = true;
  }, [cwd, selected?.id]);

  useEffect(() => {
    if (interactionLocked && selected) {
      setInteractionCompanionId((current) => current || selected.id);
    } else if (!interactionLocked) {
      setInteractionCompanionId("");
    }
  }, [interactionLocked, selected?.id]);

  useEffect(() => {
    if (!conversationOpen) return;
    const frame = window.requestAnimationFrame(() => composerRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [conversationOpen, selected?.id]);

  useEffect(() => {
    if (!conversationOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent): void => {
      const target = event.target as Element | null;
      if (target?.closest(".companion-mini-header, .companion-attention-card")) return;
      const editor = document.querySelector(".companion-mini-conversation.is-open");
      if (editor && !editor.contains(event.target as Node) && !chat.sending && !answering) {
        setConversationOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && !chat.sending && !answering) setConversationOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [answering, chat.sending, conversationOpen]);

  useEffect(() => {
    if (!open || !panelRef.current) return;
    const updatePlacement = (): void => {
      const panel = panelRef.current;
      const stage = stageRef.current;
      const card = attentionCardRef.current;
      if (!panel) return;
      const panelRect = panel.getBoundingClientRect();
      const stageRect = stage?.getBoundingClientRect();
      if (card && stageRect) {
        const cardRect = card.getBoundingClientRect();
        const placement = chooseCompanionCardPlacement({
          anchor: {
            left: stageRect.left - panelRect.left,
            top: stageRect.top - panelRect.top,
            width: stageRect.width,
            height: stageRect.height,
          },
          card: { width: cardRect.width, height: cardRect.height },
          viewport: { left: 0, top: 0, width: panelRect.width, height: panelRect.height },
          preferredSide: cardSide,
        });
        setCardSide(placement.side);
        setCardPlacement((current) => current?.side === placement.side
          && current.rect.left === placement.rect.left
          && current.rect.top === placement.rect.top
          && current.rect.width === placement.rect.width
          && current.rect.height === placement.rect.height
          ? current
          : placement);
      } else {
        setCardPlacement(undefined);
      }
      const desktopBridge = desktop ? window.lingCompanionDesktop : undefined;
      if (desktopBridge
        && typeof desktopBridge.getGeometry === "function"
        && typeof desktopBridge.setLayout === "function") {
        void desktopBridge.getGeometry().then((geometry) => {
          if (!geometry || !panelRef.current) return;
          const bounds = geometry.bounds;
          const current = panelRef.current.getBoundingClientRect();
          const local = (element: HTMLElement) => {
            const rect = element.getBoundingClientRect();
            return { x: rect.left - current.left, y: rect.top - current.top, width: rect.width, height: rect.height };
          };
          const regionElements = [
            ...(desktop ? [] : [stageRef.current]),
            attentionCardRef.current,
            conversationRef.current,
          ].filter((element): element is HTMLDivElement => element !== null);
          const regions = regionElements.map(local);
          void desktopBridge.setLayout({
            bounds,
            anchor: stageRef.current ? local(stageRef.current) : { x: 0, y: 0, width: 0, height: 0 },
            regions,
            pointerPassthrough: regions.length === 0,
          });
        }).catch(() => undefined);
      }
    };
    updatePlacement();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(updatePlacement);
    observer?.observe(panelRef.current);
    if (observer) {
      if (stageRef.current) observer.observe(stageRef.current);
      if (attentionCardRef.current) observer.observe(attentionCardRef.current);
      if (conversationRef.current) observer.observe(conversationRef.current);
    }
    window.addEventListener("resize", updatePlacement);
    const removeGeometryListener = desktop && window.lingCompanionDesktop
      && typeof window.lingCompanionDesktop.onGeometryChanged === "function"
      ? window.lingCompanionDesktop.onGeometryChanged(() => updatePlacement())
      : undefined;
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", updatePlacement);
      removeGeometryListener?.();
    };
  }, [activeAttention, cardSide, conversationOpen, desktop, open]);

  function enqueueActionIds(actionIds: readonly (string | undefined)[]): void {
    const validActionIds = actionIds.filter((actionId): actionId is string => (
      typeof actionId === "string" && selected?.manifest.actions.some((action) => action.id === actionId) === true
    ));
    if (!validActionIds.length) return;
    actionQueueRef.current.push(...validActionIds);
    setActiveActionId((current) => current ?? actionQueueRef.current.shift());
  }

  if (!open) {
    return null;
  }

  async function refresh(): Promise<void> {
    if (!cwd.trim()) return;
    setLoading(true);
    setAttentionLoading(true);
    setError("");
    const attentionGeneration = ++attentionGenerationRef.current;
    try {
      const [response, projection] = await Promise.all([
        listCompanions(cwd.trim()),
        getCompanionAttention(cwd.trim(), { limit: 120 }),
      ]);
      if (attentionGeneration !== attentionGenerationRef.current) return;
      const next = response.companions.filter((companion) => companion.status !== "disabled");
      setCompanions(next);
      setSelectedId((current) => next.some((companion) => companion.id === current) ? current : "");
      const nextItems = filterSeenAttentionItems(cwd.trim(), projection.items);
      setAttentionItems(nextItems);
      setActiveAttentionId((current) => preferredAttentionId(nextItems, current));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
      if (attentionGeneration === attentionGenerationRef.current) setAttentionLoading(false);
    }
  }

  async function refreshAttention(): Promise<void> {
    if (!cwd.trim()) return;
    setAttentionLoading(true);
    const generation = ++attentionGenerationRef.current;
    try {
      const projection = await getCompanionAttention(cwd.trim(), { limit: 120 });
      if (generation !== attentionGenerationRef.current) return;
      const nextItems = filterSeenAttentionItems(cwd.trim(), projection.items);
      setAttentionItems(nextItems);
      setActiveAttentionId((current) => preferredAttentionId(nextItems, current));
    } catch (caught) {
      if (generation === attentionGenerationRef.current) setAttentionError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (generation === attentionGenerationRef.current) setAttentionLoading(false);
    }
  }

  async function sendMessage(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!busy) await chat.send(input.trim());
  }

  async function requestAction(actionId: string): Promise<void> {
    if (!selected || !cwd.trim() || busy) return;
    setBusy("action");
    setError("");
    try {
      const response = await interactWithCompanion(cwd.trim(), selected.id, {
        type: "action_requested",
        actionId,
      });
      setState(response.state);
      enqueueActionIds([actionId]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(undefined);
    }
  }

  async function toggleProactive(): Promise<void> {
    if (!selected || !cwd.trim() || busy) return;
    setBusy("status");
    setError("");
    try {
      const response = await updateCompanion(cwd.trim(), selected.id, {
        behaviorPolicy: { proactiveEnabled: !selected.behaviorPolicy.proactiveEnabled },
      });
      setCompanions((current) => current.map((item) => item.id === response.companion.id ? response.companion : item));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(undefined);
    }
  }

  async function submitQuestion(payload: CompanionAttentionUserInputPayload, answers: readonly CompanionAnswerDraft[]): Promise<void> {
    if (!payload.answerAuthority || !cwd.trim() || payload.questions.some((question) => {
      const answer = answers.find((entry) => entry.questionId === question.questionId);
      return question.required && (!answer || answer.kind === "text" && !answer.text.trim());
    })) {
      setError(t("This question is no longer answerable."));
      return;
    }
    setAnswering(true);
    setError("");
    try {
      const storageKey = "companion-answer-key:" + cwd.trim() + ":" + payload.requestId + ":" + payload.requestVersion;
      let idempotencyKey: string | null = null;
      try {
        idempotencyKey = window.localStorage.getItem(storageKey);
        if (!idempotencyKey) {
          idempotencyKey = crypto.randomUUID();
          window.localStorage.setItem(storageKey, idempotencyKey);
        }
      } catch {
        idempotencyKey = crypto.randomUUID();
      }
      await submitUserInputAnswer(cwd.trim(), {
        schemaVersion: 1,
        authority: payload.answerAuthority,
        idempotencyKey: idempotencyKey ?? crypto.randomUUID(),
        answers,
      });
      setAttentionNotice(t("Answer submitted"));
      setConversationOpen(false);
      window.setTimeout(() => void refreshAttention(), 350);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setAnswering(false);
    }
  }

  async function resolveApproval(decision: "approve" | "deny"): Promise<void> {
    if (!activeAttention || activeAttention.payload.kind !== "approval" || !cwd.trim()) return;
    setBusy("approval");
    setError("");
    try {
      if (decision === "approve") {
        await approveApproval(cwd.trim(), activeAttention.payload.approvalId, { decisionKind: "approve_once" });
      } else {
        await denyApproval(cwd.trim(), activeAttention.payload.approvalId);
      }
      setAttentionNotice(decision === "approve" ? t("Approval submitted") : t("Approval denied"));
      window.setTimeout(() => void refreshAttention(), 350);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(undefined);
    }
  }

  function openSource(source: CompanionAttentionSource): void {
    const request = sourceNavigationRequest(source);
    if (desktop && window.lingCompanionDesktop) {
      void window.lingCompanionDesktop.navigate(request).then((result) => {
        if (!result.accepted) setError(t("Source unavailable"));
      }).catch((caught) => {
        setError(caught instanceof Error ? caught.message : String(caught));
      });
      return;
    }
    onOpenSource?.(request);
  }

  function advanceAttention(): void {
    const pending = attentionItems.filter((item) => item.status === "pending" || item.status === "active");
    if (pending.length < 2) return;
    const index = pending.findIndex((item) => item.id === activeAttention?.id);
    setActiveAttentionId(pending[(index + 1 + pending.length) % pending.length]!.id);
  }

  function dismissAttention(): void {
    if (!activeAttention) return;
    try {
      window.localStorage.setItem(
        "companion-seen:" + cwd.trim() + ":" + activeAttention.source.kind + ":" + activeAttention.source.id,
        String(activeAttention.revision),
      );
    } catch {
      // Seen state is optional when storage is unavailable.
    }
    setAttentionItems((current) => current.filter((item) => item.id !== activeAttention.id));
    setActiveAttentionId("");
  }

  function pinCompanion(): void {
    if (!selected) return;
    const next = pinnedId === selected.id ? "" : selected.id;
    setPinnedId(next);
    try {
      if (next) window.localStorage.setItem("companion-pinned:" + cwd.trim(), next);
      else window.localStorage.removeItem("companion-pinned:" + cwd.trim());
    } catch {
      // Pinning is best effort when storage is unavailable.
    }
  }

  function beginDrag(event: React.PointerEvent<HTMLElement>): void {
    if (desktop || event.button !== 0 || !panelRef.current) return;
    const target = event.target as HTMLElement;
    if (target.closest("button, textarea, input, select, a")) return;
    const rect = panelRef.current.getBoundingClientRect();
    dragRef.current = {
      pointerId: event.pointerId,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
    };
    setFloatingPosition({ left: rect.left, top: rect.top });
    setDragging(true);
    panelRef.current.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  function moveDrag(event: React.PointerEvent<HTMLElement>): void {
    const drag = dragRef.current;
    const panel = panelRef.current;
    if (!drag || !panel || drag.pointerId !== event.pointerId) return;
    const maxLeft = Math.max(12, window.innerWidth - panel.offsetWidth - 12);
    const maxTop = Math.max(12, window.innerHeight - panel.offsetHeight - 12);
    setFloatingPosition({
      left: Math.min(maxLeft, Math.max(12, event.clientX - drag.offsetX)),
      top: Math.min(maxTop, Math.max(12, event.clientY - drag.offsetY)),
    });
  }

  function endDrag(event: React.PointerEvent<HTMLElement>): void {
    if (!dragRef.current || dragRef.current.pointerId !== event.pointerId) return;
    panelRef.current?.releasePointerCapture(event.pointerId);
    dragRef.current = undefined;
    setDragging(false);
  }

  return (
    <aside
      ref={panelRef}
      className={`companion-overlay${desktop ? " companion-desktop-panel" : ""}${chat.connection !== "connected" ? " has-connection-issue" : ""}${dragging ? " is-dragging" : ""}`}
      data-card-side={cardSide}
      role="dialog"
      aria-label={t("Intelligent companion")}
      style={floatingPosition ? {
        left: `${floatingPosition.left}px`,
        top: `${floatingPosition.top}px`,
        right: "auto",
        bottom: "auto",
      } : undefined}
      onPointerMove={moveDrag}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      {activeAttention ? (
        <div
          ref={attentionCardRef}
          className="companion-attention-card-slot"
          style={cardPlacement ? {
            left: `${cardPlacement.rect.left}px`,
            top: `${cardPlacement.rect.top}px`,
          } : undefined}
        >
          <CompanionAttentionCard
            item={activeAttention}
            pendingCount={pendingAttentionCount}
          onAdvance={advanceAttention}
            submitting={answering || busy === "approval"}
            notice={attentionNotice}
            onOpenSource={openSource}
            onApprove={() => void resolveApproval("approve")}
            onDeny={() => void resolveApproval("deny")}
          onDismiss={dismissAttention}
            onSubmitQuestion={(payload, answers) => void submitQuestion(payload, answers)}
            t={t}
          />
        </div>
      ) : (
        <div className="companion-overlay-idle">
          <span>{attentionLoading ? t("Looking for work...") : t("All clear")}</span>
          {attentionError ? <small>{attentionError}</small> : null}
        </div>
      )}

      <div
        ref={conversationRef}
        className={`companion-mini-conversation${conversationOpen ? " is-open" : " is-collapsed"}`}
        onBlur={(event: React.FocusEvent<HTMLDivElement>) => {
          const next = event.relatedTarget as Node | null;
          if (next && conversationRef.current?.contains(next)) return;
          window.setTimeout(() => {
            if (!conversationRef.current?.contains(document.activeElement)
              && !chat.sending && !answering) setConversationOpen(false);
          }, 0);
        }}
      >
        <header className="companion-mini-header">
          <div className="companion-mini-heading">
            <span className="companion-mini-heading-icon" aria-hidden="true"><Icon icon={Sparkles} size="sm" /></span>
            <div>
              <strong>{t("Intelligent companion")}</strong>
              <span>{selected ? selected.displayName : t("No companion selected")}</span>
            </div>
          </div>
          <div className="companion-mini-header-actions">
            {selected ? <button type="button" className="companion-talk-button" onPointerDown={(event) => event.stopPropagation()} onClick={() => setConversationOpen((current) => !current)}>{conversationOpen ? t("Hide chat") : t("Talk")}</button> : null}
            {selected ? <IconButton label={t("Switch companion")} icon={Sparkles} size="sm" onClick={() => setRoleMenuOpen((current) => !current)} /> : null}
            {selected ? <IconButton label={pinnedId === selected.id ? t("Unpin companion") : t("Pin companion")} icon={Sparkles} size="sm" onClick={pinCompanion} /> : null}
            {!desktop && window.lingDesktop?.companionWindow ? <IconButton label={t("Open desktop companion")} icon={ExternalLink} size="sm" onClick={() => {
              void window.lingDesktop!.companionWindow!.open(cwd.trim()).then((result) => {
                if (result.accepted) onClose();
                else setError(result.reason ?? t("Unable to open desktop companion"));
              }).catch((caught) => setError(caught instanceof Error ? caught.message : String(caught)));
            }} /> : null}
            <IconButton label={t("Refresh")} icon={RefreshCw} size="sm" onClick={() => void refresh()} disabled={loading} />
            <IconButton label={t("Close")} icon={X} size="sm" onClick={onClose} />
          </div>
        </header>

        {roleMenuOpen ? (
          <div className="companion-overlay-role-menu" role="menu">
            {activeCompanions.map((companion) => (
              <button key={companion.id} type="button" className={`companion-overlay-role-option${selected?.id === companion.id ? " selected" : ""}`} onClick={() => {
                setSelectedId(companion.id);
                setInteractionCompanionId(companion.id);
                setRoleMenuOpen(false);
              }}>
                <span>{companion.displayName}</span>
                <small>{teammates.find((item) => item.id === companion.teammateId)?.displayName ?? companion.description}</small>
              </button>
            ))}
            {activeCompanions.length === 0 ? <span className="companion-overlay-role-empty">{t("Create a companion in Settings.")}</span> : null}
          </div>
        ) : null}

        {activeCompanions.length > 1 ? (
          <label className="companion-mini-select-label">
            <span>{t("Active companion")}</span>
              <Select value={selected?.id ?? ""} onChange={(event) => {
                setSelectedId(event.target.value);
                setInteractionCompanionId(event.target.value);
              }}>
              {activeCompanions.map((companion) => <option key={companion.id} value={companion.id}>{companion.displayName}</option>)}
            </Select>
          </label>
        ) : null}

        {!cwd.trim() ? (
          <div className="companion-mini-empty">
            <span>{t("Choose a workspace before opening a companion.")}</span>
          </div>
        ) : activeCompanions.length === 0 ? (
          <div className="companion-mini-empty">
            <span>{t("Create a companion in Settings to start chatting.")}</span>
            <Button size="sm" variant="primary" leadingIcon={<Sparkles />} onClick={onOpenSettings}>{t("Open companion settings")}</Button>
          </div>
        ) : selected ? (
          <>
            <section className="companion-mini-presence" aria-label={t("Companion status")}>
              <div className="companion-mini-avatar-wrap">
                {teammate ? <TeammateAvatarView teammate={teammate} cwd={cwd} /> : <span className="companion-mini-avatar-fallback" aria-hidden="true">🐾</span>}
                <span className={`companion-mini-phase companion-mini-phase-${visiblePhase ?? "idle"}`} aria-label={visiblePhase ?? "idle"} />
              </div>
              <div className="companion-mini-presence-copy">
                <strong>{emotion ? companionLabel(emotion.label, t) : t("Ready")}</strong>
                <span>{phaseLabel(visiblePhase, t)} · {t("Energy")} {Math.round(state?.energy ?? 100)}%</span>
                <div className="companion-energy-bar" aria-label={t("Energy") }><span style={{ width: `${Math.max(0, Math.min(100, state?.energy ?? 100))}%` }} /></div>
              </div>
              <IconButton
                label={selected.behaviorPolicy.proactiveEnabled ? t("Pause proactive behavior") : t("Resume proactive behavior")}
                icon={selected.behaviorPolicy.proactiveEnabled ? Pause : Play}
                size="sm"
                disabled={busy === "status"}
                onClick={() => void toggleProactive()}
              />
            </section>

            <div ref={logRef} className="companion-mini-messages" onScroll={(event) => {
              const log = event.currentTarget;
              followMessagesRef.current = log.scrollHeight - log.scrollTop - log.clientHeight < 32;
            }} role="log" aria-label={t("Companion messages")} aria-live="polite">
              {chat.hasEarlier ? <Button size="sm" variant="ghost" leadingIcon={<ArrowUp />} onClick={() => {
                const log = logRef.current;
                const height = log?.scrollHeight ?? 0;
                followMessagesRef.current = false;
                void chat.loadEarlier().then(() => requestAnimationFrame(() => {
                  if (log) log.scrollTop += log.scrollHeight - height;
                }));
              }} loading={chat.loadingEarlier}>{t("Load earlier messages")}</Button> : null}
              {orderedMessages.length === 0 ? <p className="companion-mini-message-empty">{t("Say hello to your companion.")}</p> : null}
              {orderedMessages.map((message) => (
                <div key={message.id} className={`companion-mini-message ${message.authorType === "local-user" ? "user" : "assistant"}`}>
                  <span>{message.body || (message.status === "pending" ? t("Thinking...") : message.errorMessage ?? "")}</span>
                </div>
              ))}
            </div>

            <div className="companion-mini-actions" aria-label={t("Companion actions")}>
              {selected.manifest.actions.map((action) => (
                <Button
                  key={action.id}
                  size="sm"
                  variant="ghost"
                  leadingIcon={<Zap />}
                  disabled={busy !== undefined}
                  onClick={() => void requestAction(action.id)}
                >
                  {companionLabel(action.label, t)}
                </Button>
              ))}
            </div>

            <form className="companion-mini-composer" onSubmit={(event) => void sendMessage(event)}>
              <Textarea
                ref={composerRef}
                aria-label={t("Message companion")}
                value={input}
                onChange={(event) => setInput(event.target.value)}
                placeholder={t("Message your companion...")}
                rows={1}
                disabled={busy !== undefined || chat.sending || Boolean(chat.pending)}
              />
              <Button type="submit" size="sm" variant="primary" leadingIcon={<Send />} disabled={!input.trim() || busy !== undefined || chat.sending || Boolean(chat.pending)} loading={chat.sending}>
                {t("Send")}
              </Button>
            </form>
            {chat.connection !== "connected" && !chat.sending ? <Button className="companion-mini-reconnect" size="sm" variant="secondary" onClick={() => void chat.reconnect()} disabled={busy !== undefined}>{chat.pending?.body || chat.pending?.terminal ? t("Recover or retry message") : t("Reconnect")}</Button> : null}

          </>
        ) : null}

        {error || chat.error ? <p className="companion-mini-error" role="alert">{error || chat.error}</p> : null}
        <footer className="companion-mini-footer">
          <Button size="sm" variant="ghost" className="companion-mini-settings-link" onClick={onOpenSettings}>{t("Manage companions in Settings")}</Button>
        </footer>
      </div>
      {selected ? (
        <div ref={stageRef} className="companion-pet-stage-slot">
          <CompanionPetStage companionName={selected.displayName} phase={visiblePhase}
            actionId={activeActionId} emotionId={state?.emotionId} onPointerDown={beginDrag} />
        </div>
      ) : null}
    </aside>
  );
}

function companionLabel(label: string, t: (key: string) => string): string {
  switch (label) {
    case "Neutral": return t("Neutral");
    case "Happy": return t("Happy");
    case "Sad": return t("Sad");
    case "Excited": return t("Excited");
    case "Tired": return t("Tired");
    case "Idle": return t("Idle");
    case "Greet": return t("Greet");
    case "Think": return t("Think");
    case "Celebrate": return t("Celebrate");
    default: return label;
  }
}

function phaseLabel(phase: CompanionState["phase"] | undefined, t: (key: string) => string): string {
  if (phase === "thinking") return t("Thinking");
  if (phase === "speaking") return t("Speaking");
  if (phase === "reacting") return t("Reacting");
  if (phase === "error") return t("Needs attention");
  return t("Idle");
}

function isRecentCompanionState(updatedAt?: string): boolean {
  if (!updatedAt) return false;
  const timestamp = Date.parse(updatedAt);
  return Number.isFinite(timestamp) && Math.abs(Date.now() - timestamp) < 1_800;
}

function filterSeenAttentionItems(cwd: string, items: readonly CompanionAttentionItem[]): readonly CompanionAttentionItem[] {
  return items.filter((item) => {
    if (item.priority !== "result") return true;
    try {
      const value = window.localStorage.getItem("companion-seen:" + cwd + ":" + item.source.kind + ":" + item.source.id);
      if (value === "1") return false;
      const seenRevision = value === null ? 0 : Number(value);
      return !Number.isFinite(seenRevision) || seenRevision < item.revision;
    } catch {
      return true;
    }
  });
}

function companionDraftKey(cwd: string, companionId: string): string {
  return "companion-chat-draft:" + cwd + ":" + companionId;
}

function preferredAttentionId(items: readonly CompanionAttentionItem[], currentId: string): string {
  const current = items.find((item) => item.id === currentId);
  const actionable = items.find((item) => item.status === "pending" || item.status === "active");
  if (current && (current.status === "pending" || current.status === "active")) return current.id;
  return actionable?.id ?? current?.id ?? items[0]?.id ?? "";
}
