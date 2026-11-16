import { useEffect, useMemo, useRef, useState } from "react";
import { Pause, Play, RefreshCw, Send, Sparkles, X, Zap } from "lucide-react";
import type {
  AiTeammate,
  CompanionEvent,
  CompanionProfile,
  CompanionState,
  TeammateDirectMessage,
} from "../../types.js";
import {
  createCompanionMessage,
  getCompanionState,
  interactWithCompanion,
  listCompanionEvents,
  listCompanionMessages,
  listCompanions,
  updateCompanion,
} from "../../api.js";
import { useI18n } from "../../i18n.js";
import { Button, Icon, IconButton, Select, Textarea } from "../../shared/ui/index.js";
import { TeammateAvatarView } from "../teammates/TeammateAvatarView.js";
import { CompanionPetStage } from "./CompanionPetStage.js";

const companionSyncIntervalMs = 1_000;

export function CompanionMiniPanel({
  cwd,
  teammates,
  open,
  onClose,
  onOpenSettings,
}: {
  readonly cwd: string;
  readonly teammates: readonly AiTeammate[];
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onOpenSettings: () => void;
}): React.JSX.Element | null {
  const { t } = useI18n();
  const [companions, setCompanions] = useState<readonly CompanionProfile[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [state, setState] = useState<CompanionState | undefined>();
  const [messages, setMessages] = useState<readonly TeammateDirectMessage[]>([]);
  const [input, setInput] = useState("");
  const [activeActionId, setActiveActionId] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<"send" | "action" | "status" | undefined>();
  const [error, setError] = useState("");
  const panelRef = useRef<HTMLElement>(null);
  const dragRef = useRef<{ pointerId: number; offsetX: number; offsetY: number } | undefined>(undefined);
  const actionQueueRef = useRef<string[]>([]);
  const seenEventIdsRef = useRef<Set<string>>(new Set());
  const [floatingPosition, setFloatingPosition] = useState<{ left: number; top: number }>();
  const [dragging, setDragging] = useState(false);

  const activeCompanions = useMemo(
    () => companions.filter((companion) => companion.status !== "disabled"),
    [companions],
  );
  const selected = activeCompanions.find((companion) => companion.id === selectedId) ?? activeCompanions[0];
  const teammate = selected ? teammates.find((item) => item.id === selected.teammateId) : undefined;
  const orderedMessages = useMemo(
    () => [...messages].sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
    [messages],
  );
  const emotion = selected?.manifest.emotions.find((item) => item.id === state?.emotionId)
    ?? selected?.manifest.emotions.find((item) => item.id === selected.manifest.defaultEmotionId);
  const latestAssistantMessage = [...orderedMessages]
    .reverse()
    .find((message) => message.authorType !== "local-user" && message.body.trim())?.body.trim();
  const visiblePhase = state && (
    state.phase === "error"
    || Boolean(activeActionId)
    || isRecentCompanionState(state.updatedAt)
  ) ? state.phase : "idle";

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
    setLoading(true);
    setError("");
    void listCompanions(cwd.trim())
      .then((response) => {
        if (cancelled) return;
        const next = response.companions.filter((companion) => companion.status !== "disabled");
        setCompanions(next);
        setSelectedId((current) => next.some((companion) => companion.id === current) ? current : next[0]?.id ?? "");
      })
      .catch((caught) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [cwd, open]);

  useEffect(() => {
    if (!open || !cwd.trim() || !selected) {
      setMessages([]);
      setState(undefined);
      actionQueueRef.current = [];
      seenEventIdsRef.current.clear();
      return;
    }
    let cancelled = false;
    let syncing = false;
    let syncTimer: number | undefined;
    const companionId = selected.id;

    async function syncCompanion(initial: boolean): Promise<void> {
      if (cancelled || syncing) return;
      syncing = true;
      try {
        const [messageResponse, stateResponse, eventResponse] = await Promise.all([
          listCompanionMessages(cwd.trim(), companionId, { limit: 40 }),
          getCompanionState(cwd.trim(), companionId),
          listCompanionEvents(cwd.trim(), companionId, { limit: 40 }),
        ]);
        if (cancelled) return;
        setMessages((current) => initial ? messageResponse.messages : mergeCompanionMessages(current, messageResponse.messages));
        setState(stateResponse.state);
        const events = eventResponse.events;
        if (initial) {
          seenEventIdsRef.current = new Set(events.map((event) => event.id));
        } else {
          const unseenEvents = events.filter((event) => !seenEventIdsRef.current.has(event.id));
          for (const event of events) seenEventIdsRef.current.add(event.id);
          enqueueActionIds(unseenEvents.flatMap(readActionId));
        }
      } catch (caught) {
        if (initial && !cancelled) setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        syncing = false;
      }
    }

    actionQueueRef.current = [];
    setActiveActionId(undefined);
    setLoading(true);
    setError("");
    void syncCompanion(true).finally(() => {
      if (!cancelled) {
        setLoading(false);
        syncTimer = window.setInterval(() => void syncCompanion(false), companionSyncIntervalMs);
      }
    });
    return () => {
      cancelled = true;
      if (syncTimer !== undefined) window.clearInterval(syncTimer);
    };
  }, [cwd, open, selected?.id]);

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
    setError("");
    try {
      const response = await listCompanions(cwd.trim());
      const next = response.companions.filter((companion) => companion.status !== "disabled");
      setCompanions(next);
      setSelectedId((current) => next.some((companion) => companion.id === current) ? current : next[0]?.id ?? "");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }

  async function sendMessage(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const body = input.trim();
    if (!body || !selected || !cwd.trim() || busy) return;
    setBusy("send");
    setError("");
    try {
      const response = await createCompanionMessage(cwd.trim(), selected.id, { body });
      setMessages((current) => [
        ...current.filter((message) => message.id !== response.message.id && message.id !== response.aiReply?.id),
        response.message,
        ...(response.aiReply ? [response.aiReply] : []),
      ]);
      setState(response.state);
      enqueueActionIds(response.companionReply?.actionRequests?.map((action) => action.actionId) ?? []);
      setInput("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(undefined);
    }
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

  function beginDrag(event: React.PointerEvent<HTMLElement>): void {
    if (event.button !== 0 || !panelRef.current) return;
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
      className={`companion-mini-panel${dragging ? " is-dragging" : ""}`}
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
      <header className="companion-mini-header">
        <div className="companion-mini-heading">
          <span className="companion-mini-heading-icon" aria-hidden="true"><Icon icon={Sparkles} size="sm" /></span>
          <div>
            <strong>{t("Intelligent companion")}</strong>
            <span>{selected ? selected.displayName : t("No companion selected")}</span>
          </div>
        </div>
        <div className="companion-mini-header-actions">
          <IconButton label={t("Refresh")} icon={RefreshCw} size="sm" onClick={() => void refresh()} disabled={loading} />
          <IconButton label={t("Close")} icon={X} size="sm" onClick={onClose} />
        </div>
      </header>

      {activeCompanions.length > 1 ? (
        <label className="companion-mini-select-label">
          <span>{t("Active companion")}</span>
          <Select value={selected?.id ?? ""} onChange={(event) => setSelectedId(event.target.value)}>
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
          <CompanionPetStage
            companionName={selected.displayName}
            phase={visiblePhase}
            actionId={activeActionId}
            emotionLabel={emotion?.label ?? t("Ready")}
            message={latestAssistantMessage ?? t("Say hello to your companion.")}
            onPointerDown={beginDrag}
          />
          <form className="companion-mini-composer companion-mini-composer-under-stage" onSubmit={(event) => void sendMessage(event)}>
            <Textarea
              aria-label={t("Message companion")}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder={t("Message your companion...")}
              rows={1}
              disabled={busy !== undefined}
            />
            <Button type="submit" size="sm" variant="primary" leadingIcon={<Send />} disabled={!input.trim() || busy !== undefined} loading={busy === "send"}>
              {t("Send")}
            </Button>
          </form>
          <section className="companion-mini-presence" aria-label={t("Companion status")}>
            <div className="companion-mini-avatar-wrap">
              {teammate ? <TeammateAvatarView teammate={teammate} cwd={cwd} /> : <span className="companion-mini-avatar-fallback" aria-hidden="true">🐾</span>}
              <span className={`companion-mini-phase companion-mini-phase-${visiblePhase ?? "idle"}`} aria-label={visiblePhase ?? "idle"} />
            </div>
            <div className="companion-mini-presence-copy">
              <strong>{emotion?.label ?? t("Ready")}</strong>
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

          <div className="companion-mini-messages" aria-live="polite">
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
                {action.label}
              </Button>
            ))}
          </div>

        </>
      ) : null}

      {error ? <p className="companion-mini-error" role="alert">{error}</p> : null}
      <footer className="companion-mini-footer">
        <button type="button" className="companion-mini-settings-link" onClick={onOpenSettings}>{t("Manage companions in Settings")}</button>
      </footer>
    </aside>
  );
}

function phaseLabel(phase: CompanionState["phase"] | undefined, t: (key: string) => string): string {
  if (phase === "thinking") return t("Thinking");
  if (phase === "speaking") return t("Speaking");
  if (phase === "reacting") return t("Reacting");
  if (phase === "error") return t("Needs attention");
  return t("Idle");
}

function readActionId(event: CompanionEvent): string | undefined {
  if (event.type !== "action_requested") return undefined;
  const actionId = event.payload.actionId;
  return typeof actionId === "string" ? actionId : undefined;
}

function mergeCompanionMessages(
  current: readonly TeammateDirectMessage[],
  incoming: readonly TeammateDirectMessage[],
): readonly TeammateDirectMessage[] {
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()];
}

function isRecentCompanionState(updatedAt?: string): boolean {
  if (!updatedAt) return false;
  const timestamp = Date.parse(updatedAt);
  return Number.isFinite(timestamp) && Math.abs(Date.now() - timestamp) < 1_800;
}
