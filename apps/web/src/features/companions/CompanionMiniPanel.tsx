import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, ExternalLink, Pause, Play, RefreshCw, Send, Sparkles, X, Zap } from "lucide-react";
import type {
  AiTeammate,
  CompanionProfile,
  CompanionState,
} from "../../types.js";
import {
  interactWithCompanion,
  listCompanions,
  updateCompanion,
} from "../../api.js";
import { useI18n } from "../../i18n.js";
import { Button, Icon, IconButton, Select, Textarea } from "../../shared/ui/index.js";
import { TeammateAvatarView } from "../teammates/TeammateAvatarView.js";
import { CompanionPetStage } from "./CompanionPetStage.js";
import { useCompanionChat } from "./use-companion-chat.js";

const companionRetryDelayMs = 5_000;
const companionRetryLimit = 3;

export function CompanionMiniPanel({
  cwd,
  teammates,
  open,
  onClose,
  onOpenSettings,
  desktop = false,
}: {
  readonly cwd: string;
  readonly teammates: readonly AiTeammate[];
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onOpenSettings: () => void;
  readonly desktop?: boolean;
}): React.JSX.Element | null {
  const { t } = useI18n();
  const [companions, setCompanions] = useState<readonly CompanionProfile[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [input, setInput] = useState("");
  const logRef = useRef<HTMLDivElement>(null);
  const followMessagesRef = useRef(true);
  const [activeActionId, setActiveActionId] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<"action" | "status" | undefined>();
  const [error, setError] = useState("");
  const panelRef = useRef<HTMLElement>(null);
  const dragRef = useRef<{ pointerId: number; offsetX: number; offsetY: number } | undefined>(undefined);
  const actionQueueRef = useRef<string[]>([]);
  const [floatingPosition, setFloatingPosition] = useState<{ left: number; top: number }>();
  const [dragging, setDragging] = useState(false);

  const activeCompanions = useMemo(
    () => companions.filter((companion) => companion.status !== "disabled"),
    [companions],
  );
  const selected = activeCompanions.find((companion) => companion.id === selectedId) ?? activeCompanions[0];
  const teammate = selected ? teammates.find((item) => item.id === selected.teammateId) : undefined;
  const chat = useCompanionChat({ cwd, companion: selected, open,
    onActions: enqueueActionIds,
    onDelivered: (body) => setInput((current) => current.trim() === body ? "" : current),
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
  ) ? state.phase : "idle";

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
          setSelectedId((current) => next.some((companion) => companion.id === current) ? current : next[0]?.id ?? "");
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
    actionQueueRef.current = [];
    setActiveActionId(undefined);
    setInput("");
    followMessagesRef.current = true;
  }, [cwd, selected?.id]);

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
      className={`companion-mini-panel${desktop ? " companion-desktop-panel" : ""}${chat.connection !== "connected" ? " has-connection-issue" : ""}${dragging ? " is-dragging" : ""}`}
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
      <div className="companion-mini-conversation">
        <header className="companion-mini-header">
          <div className="companion-mini-heading">
            <span className="companion-mini-heading-icon" aria-hidden="true"><Icon icon={Sparkles} size="sm" /></span>
            <div>
              <strong>{t("Intelligent companion")}</strong>
              <span>{selected ? selected.displayName : t("No companion selected")}</span>
            </div>
          </div>
          <div className="companion-mini-header-actions">
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
            {chat.connection !== "connected" && !chat.sending ? <Button className="companion-mini-reconnect" size="sm" variant="secondary" onClick={() => void chat.reconnect()} disabled={busy !== undefined}>{chat.pending?.body ? t("Recover or retry message") : t("Reconnect")}</Button> : null}

          </>
        ) : null}

        {error || chat.error ? <p className="companion-mini-error" role="alert">{error || chat.error}</p> : null}
        <footer className="companion-mini-footer">
          <Button size="sm" variant="ghost" className="companion-mini-settings-link" onClick={onOpenSettings}>{t("Manage companions in Settings")}</Button>
        </footer>
      </div>
      {selected ? <CompanionPetStage companionName={selected.displayName} phase={visiblePhase}
        actionId={activeActionId} emotionId={state?.emotionId} onPointerDown={beginDrag} /> : null}
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
