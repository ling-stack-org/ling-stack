import { useEffect, useRef, useState } from "react";
import type { CompanionEvent, CompanionProfile, CompanionState, TeammateDirectMessage } from "../../types.js";
import {
  getCompanionMessageSubmission, getCompanionState, listCompanionEvents,
  listCompanionMessages, streamCompanionMessage,
} from "../../api.js";
import { readSseResponse } from "../../sse.js";
import { useI18n } from "../../i18n.js";
import { mergeCompanionMessages } from "./companion-messages.js";
import {
  forgetPendingCompanionSubmission, markPendingCompanionSubmissionTerminal,
  readPendingCompanionSubmission, rememberPendingCompanionSubmission,
} from "./companion-submission-journal.js";

const pageSize = 40;
const syncIntervalMs = 5_000;
const receiptUnknownRetryLimit = 3;

interface PendingSubmission { readonly key: string; readonly body?: string; readonly terminal?: boolean }
interface ChatSession {
  readonly cwd: string;
  readonly companionId: string;
  readonly controller: AbortController;
  pending?: PendingSubmission;
  receiptPending: boolean;
  sending: boolean;
  replyError?: string;
  reconnect?: () => Promise<void>;
  unknownReceiptAttempts: number;
}
interface CompanionStreamEvent {
  readonly message?: TeammateDirectMessage;
  readonly aiReply?: TeammateDirectMessage;
  readonly state?: CompanionState;
  readonly messageId?: string;
  readonly body?: string;
  readonly companionReply?: { readonly actionRequests?: readonly { readonly actionId: string }[] };
  readonly error?: string;
}

export function useCompanionChat(input: {
  readonly cwd: string;
  readonly companion?: CompanionProfile;
  readonly open: boolean;
  readonly onActions: (ids: readonly string[]) => void;
  readonly onDelivered: (body: string) => void;
}) {
  const { t } = useI18n();
  const [messages, setMessages] = useState<readonly TeammateDirectMessage[]>([]);
  const [state, setState] = useState<CompanionState>();
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [pending, setPending] = useState<PendingSubmission>();
  const [error, setError] = useState("");
  const [connection, setConnection] = useState<"connected" | "reconnecting" | "offline">("connected");
  const [cursor, setCursor] = useState<string>();
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const sessionRef = useRef<ChatSession | undefined>(undefined);
  const callbacks = useRef(input);
  callbacks.current = input;
  const earlierLock = useRef(false);

  function isCurrent(session: ChatSession): boolean {
    return sessionRef.current === session && !session.controller.signal.aborted;
  }

  function finish(session: ChatSession): void {
    const submission = session.pending;
    if (!submission) return;
    forgetPendingCompanionSubmission(session.cwd, session.companionId, submission.key);
    session.pending = undefined;
    session.receiptPending = false;
    setPending(undefined);
    setConnection("connected");
    setError("");
    if (submission.body) callbacks.current.onDelivered(submission.body);
  }

  async function reconcile(session: ChatSession): Promise<boolean> {
    const submission = session.pending;
    if (!submission) return true;
    const receipt = await getCompanionMessageSubmission(session.cwd, session.companionId, submission.key);
    if (!isCurrent(session)) return false;
    // A background lookup may finish after the user has already submitted a
    // different message in this session. Its receipt must not replace the
    // newer submission's recovery key or clear its pending state.
    if (session.pending?.key !== submission.key) return false;
    session.receiptPending = false;
    if (receipt.status === "unknown") {
      session.unknownReceiptAttempts += 1;
      if (session.unknownReceiptAttempts < receiptUnknownRetryLimit) {
        session.receiptPending = true;
        setConnection("reconnecting");
        setError(t("The reply was interrupted. Reconnect to recover or retry the same message."));
        return false;
      }
      // A few empty reads protect an accepted request from a network race. If
      // the key is still unknown after the bounded grace period, it is safe to
      // release the draft and let the user submit a new message.
      forgetPendingCompanionSubmission(session.cwd, session.companionId, submission.key);
      session.pending = undefined;
      setPending(undefined);
      session.replyError = t("The reply was interrupted. Reconnect to recover or retry the same message.");
      setConnection("connected");
      setError(session.replyError);
      return true;
    }
    session.unknownReceiptAttempts = 0;
    if (receipt.message) {
      setMessages((current) => mergeCompanionMessages(current, [receipt.message!]));
      session.pending = { key: submission.key, body: receipt.message.body, ...(submission.terminal ? { terminal: true } : {}) };
      setPending(session.pending);
    }
    if (receipt.state) setState(receipt.state);
    if (receipt.aiReply) {
      setMessages((current) => mergeCompanionMessages(current, [receipt.aiReply!]));
      if (receipt.aiReply.status !== "pending") {
        finish(session);
        session.replyError = receipt.aiReply.errorMessage;
        setError(session.replyError ?? "");
        return true;
      }
    }
    // The daemon records the user message before it creates the reply row.
    // An accepted receipt without an AI reply is therefore still in progress;
    // retrying during this gap would submit the same key a second time.
    session.receiptPending = receipt.status === "accepted" && (
      !receipt.aiReply || receipt.aiReply.status === "pending"
    );
    setConnection("reconnecting");
    return false;
  }

  useEffect(() => {
    setMessages([]);
    setState(undefined);
    setCursor(undefined);
    setLoadingEarlier(false);
    earlierLock.current = false;
    setSending(false);
    setError("");
    if (!input.open || !input.cwd.trim() || !input.companion) return;
    const session: ChatSession = {
      cwd: input.cwd.trim(), companionId: input.companion.id,
      controller: new AbortController(), receiptPending: false, sending: false,
      unknownReceiptAttempts: 0,
      pending: readPendingCompanionSubmission(input.cwd, input.companion.id),
    };
    sessionRef.current = session;
    setPending(session.pending);
    setLoading(true);
    setConnection("reconnecting");
    let syncing = false;
    let initialized = false;
    let seenEvents = new Set<string>();

    async function sync(): Promise<void> {
      if (!isCurrent(session) || syncing || session.sending) return;
      syncing = true;
      try {
        const [history, status, events] = await Promise.all([
          listCompanionMessages(session.cwd, session.companionId, { limit: pageSize }),
          getCompanionState(session.cwd, session.companionId),
          listCompanionEvents(session.cwd, session.companionId, { limit: 40 }),
        ]);
        if (!isCurrent(session) || session.sending) return;
        setMessages((current) => mergeCompanionMessages(current, history.messages));
        setState((current) => current && current.updatedAt > status.state.updatedAt ? current : status.state);
        if (!initialized) setCursor(history.hasMore ? history.nextBeforeMessageId : undefined);
        else callbacks.current.onActions(events.events.filter((event) => !seenEvents.has(event.id)).flatMap(actionIds));
        seenEvents = new Set(events.events.map((event) => event.id));
        initialized = true;
        if (!session.pending || await reconcile(session)) {
          setConnection("connected");
          setError(session.replyError ?? "");
        }
      } catch (caught) {
        if (isCurrent(session)) {
          setConnection("offline");
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      } finally {
        syncing = false;
        if (isCurrent(session)) setLoading(false);
      }
    }
    session.reconnect = sync;
    void sync();
    const timer = window.setInterval(() => void sync(), syncIntervalMs);
    const resume = () => { if (document.visibilityState === "visible") void sync(); };
    window.addEventListener("online", resume);
    document.addEventListener("visibilitychange", resume);
    return () => {
      session.controller.abort();
      window.clearInterval(timer);
      window.removeEventListener("online", resume);
      document.removeEventListener("visibilitychange", resume);
      if (sessionRef.current === session) sessionRef.current = undefined;
    };
  }, [input.cwd, input.companion?.id, input.open]);

  async function send(body: string): Promise<void> {
    const session = sessionRef.current;
    if (!session || !isCurrent(session) || session.sending || !body.trim()) return;
    // A restored key needs its receipt's original text before it can be retried.
    if (session.pending && session.pending.body === undefined) return;
    // Retrying always uses the original text and key, even if the draft was edited.
    const submission = { key: session.pending?.key ?? crypto.randomUUID(), body: session.pending?.body ?? body.trim() };
    session.pending = submission;
    session.receiptPending = false;
    session.unknownReceiptAttempts = 0;
    session.sending = true;
    session.replyError = undefined;
    setPending(submission);
    setSending(true);
    setError("");
    rememberPendingCompanionSubmission(session.cwd, session.companionId, submission.key);
    let terminal = false;
    try {
      const response = await streamCompanionMessage(session.cwd, session.companionId, {
        body: submission.body, idempotencyKey: submission.key,
      }, session.controller.signal);
      await readSseResponse(response, (event) => {
        if (!isCurrent(session)) return;
        const data = JSON.parse(event.data) as CompanionStreamEvent;
        if (data.message) setMessages((current) => mergeCompanionMessages(current, [data.message!]));
        if (data.aiReply) setMessages((current) => mergeCompanionMessages(current, [data.aiReply!]));
        if (data.state) setState(data.state);
        if (event.event === "delta" && data.messageId && typeof data.body === "string") {
          setMessages((current) => current.map((message) => message.id === data.messageId
            ? { ...message, body: data.body!, updatedAt: new Date().toISOString() } : message));
        }
        if (["done", "blocked", "error"].includes(event.event)) {
          terminal = true;
          callbacks.current.onActions(data.companionReply?.actionRequests?.map((action) => action.actionId) ?? []);
          if (data.aiReply && data.aiReply.status !== "pending") finish(session);
          if (event.event === "error" && session.pending && !data.aiReply) {
            session.pending = { ...session.pending, terminal: true };
            setPending(session.pending);
            markPendingCompanionSubmissionTerminal(session.cwd, session.companionId, session.pending.key);
          }
          session.replyError = data.error ?? data.aiReply?.errorMessage;
          if (session.replyError) setError(session.replyError);
        }
      });
      if (isCurrent(session) && session.pending) {
        await reconcile(session);
        if (!isCurrent(session)) return;
        if (session.pending && !terminal) setError(t("The reply was interrupted. Reconnect to recover or retry the same message."));
      }
    } catch (caught) {
      if (!isCurrent(session)) return;
      try {
        await reconcile(session);
        if (!isCurrent(session)) return;
        if (session.pending) setError(t("The reply was interrupted. Reconnect to recover or retry the same message."));
      } catch {
        if (isCurrent(session)) {
          setConnection("offline");
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      }
    } finally {
      session.sending = false;
      if (isCurrent(session)) setSending(false);
    }
  }

  async function reconnect(): Promise<void> {
    const session = sessionRef.current;
    if (!session || !isCurrent(session) || session.sending) return;
    setError("");
    setConnection("reconnecting");
    try {
      if (session.pending?.terminal) {
        const key = session.pending.key;
        if (!session.pending.body) await reconcile(session);
        if (!isCurrent(session) || session.pending?.key !== key) return;
        if (session.pending?.body) {
          await send(session.pending.body);
          return;
        }
      }
      if (session.pending) {
        const key = session.pending.key;
        const finished = await reconcile(session);
        if (!isCurrent(session) || finished || session.pending?.key !== key) return;
        if (session.receiptPending) return;
        if (session.pending?.body) await send(session.pending.body);
        else await session.reconnect?.();
      } else await session.reconnect?.();
    } catch (caught) {
      if (isCurrent(session)) {
        setConnection("offline");
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    }
  }

  async function loadEarlier(): Promise<void> {
    const session = sessionRef.current;
    if (!session || !cursor || earlierLock.current) return;
    earlierLock.current = true;
    setLoadingEarlier(true);
    try {
      const history = await listCompanionMessages(session.cwd, session.companionId, { limit: pageSize, beforeMessageId: cursor });
      if (!isCurrent(session)) return;
      setMessages((current) => mergeCompanionMessages(current, history.messages));
      setCursor(history.hasMore ? history.nextBeforeMessageId : undefined);
    } catch (caught) {
      if (isCurrent(session)) setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (isCurrent(session)) { earlierLock.current = false; setLoadingEarlier(false); }
    }
  }

  return { messages, state, setState, loading, sending, pending, error, connection,
    hasEarlier: Boolean(cursor), loadingEarlier, loadEarlier, send, reconnect };
}

function actionIds(event: CompanionEvent): readonly string[] {
  return event.type === "action_requested" && typeof event.payload.actionId === "string" ? [event.payload.actionId] : [];
}
