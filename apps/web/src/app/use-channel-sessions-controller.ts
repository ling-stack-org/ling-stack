import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { ChannelSessionListResponse, ChannelSessionSummary, UpdateChannelSessionRequest } from "@ling-stack/contracts";
import { createChannelSession, getChannelSession, listChannelSessions, updateChannelSession } from "../api/channels.js";
import type { Channel, ChannelBranch } from "../types.js";
import { channelSessionSelection, channelSessionThreadId, channelSessionUnread, isChannelSessionDraft, reconcileSessionReadWatermarks } from "./channel-session-state.js";

interface Draft { readonly id: string; readonly key: string; readonly title?: string; readonly bound?: ChannelSessionSummary; readonly creationUnconfirmed?: boolean }
const load = <T,>(key: string, fallback: T): T => { try { return JSON.parse(localStorage.getItem(key) ?? "null") as T ?? fallback; } catch { return fallback; } };
const save = (key: string, value: unknown): void => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* In-memory state remains usable when browser storage is unavailable. */ } };

/** Owns the channel conversation directory; timeline and execution remain in their existing domains. */
export function useChannelSessionsController(input: {
  readonly cwd: string; readonly channels: readonly Channel[]; readonly selectedChannelId: string;
  readonly selection: string; readonly branches: readonly ChannelBranch[];
  readonly setSelection: Dispatch<SetStateAction<string>>;
}) {
  const storagePrefix = `ling:channel-sessions:v1:${input.cwd.trim()}`;
  const [hydratedPrefix, setHydratedPrefix] = useState(storagePrefix);
  const [details, setDetails] = useState<Readonly<Record<string, ChannelSessionSummary>>>({});
  const [pages, setPages] = useState<Readonly<Record<string, ChannelSessionListResponse>>>({});
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const [creating, setCreating] = useState<Readonly<Record<string, boolean>>>({});
  const [loading, setLoading] = useState<Readonly<Record<string, boolean>>>({});
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() => load(`${storagePrefix}:drafts`, {}));
  const [read, setRead] = useState<Record<string, number>>(() => load(`${storagePrefix}:read`, {}));
  const [last, setLast] = useState<Record<string, string>>(() => load(`${storagePrefix}:last`, {}));
  const ownerRef = useRef(storagePrefix);
  const latestRef = useRef(input); latestRef.current = input;
  const draftsRef = useRef(drafts); draftsRef.current = drafts;
  const generations = useRef(new Map<string, number>());
  const creations = useRef(new Map<string, Promise<ChannelSessionSummary>>());
  useEffect(() => {
    ownerRef.current = storagePrefix;
    setPages({}); setDetails({}); setErrors({}); setLoading({}); setCreating({});
    setDrafts(load(`${storagePrefix}:drafts`, {}));
    setRead(load(`${storagePrefix}:read`, {})); setLast(load(`${storagePrefix}:last`, {}));
    generations.current.clear(); creations.current.clear(); setHydratedPrefix(storagePrefix);
  }, [storagePrefix]);
  useEffect(() => { if (hydratedPrefix === storagePrefix) save(`${storagePrefix}:drafts`, drafts); }, [drafts, storagePrefix, hydratedPrefix]);
  useEffect(() => { if (hydratedPrefix === storagePrefix) save(`${storagePrefix}:read`, read); }, [read, storagePrefix, hydratedPrefix]);
  useEffect(() => { if (hydratedPrefix === storagePrefix) save(`${storagePrefix}:last`, last); }, [last, storagePrefix, hydratedPrefix]);

  async function refresh(channelId: string): Promise<void> {
    const owner = storagePrefix;
    const generation = (generations.current.get(channelId) ?? 0) + 1;
    generations.current.set(channelId, generation);
    setLoading(current => ({ ...current, [channelId]: true }));
    try {
      const page = await listChannelSessions(input.cwd, channelId, { limit: 10 });
      if (ownerRef.current !== owner || generations.current.get(channelId) !== generation) return;
      setPages(current => ({ ...current, [channelId]: page }));
      setDetails(current => ({ ...current, ...Object.fromEntries([page.defaultSession, ...page.sessions]
        .filter((session): session is ChannelSessionSummary => Boolean(session)).map(session => [session.id, session])) }));
      setRead(current => {
        const baselineKey = `channel-baseline:${channelId}`;
        const next = current[baselineKey] ? { ...current } : reconcileSessionReadWatermarks(current, page.notificationWatermarks);
        for (const entry of page.notificationWatermarks) if (next[entry.id] === undefined) next[entry.id] = 0;
        next[baselineKey] = 1;
        return next;
      });
      setErrors(current => ({ ...current, [channelId]: "" }));
    } catch (error) {
      if (ownerRef.current === owner && generations.current.get(channelId) === generation) setErrors(current => ({ ...current, [channelId]: error instanceof Error ? error.message : String(error) }));
    } finally {
      if (ownerRef.current === owner && generations.current.get(channelId) === generation) setLoading(current => ({ ...current, [channelId]: false }));
    }
  }
  const channelKey = input.channels.map(channel => channel.id).join("|");
  useEffect(() => {
    if (!input.cwd.trim()) return;
    const refreshAll = () => { for (const channel of input.channels) void refresh(channel.id); };
    refreshAll();
    const timer = setInterval(refreshAll, 5000);
    window.addEventListener("focus", refreshAll);
    window.addEventListener("online", refreshAll);
    return () => { clearInterval(timer); window.removeEventListener("focus", refreshAll); window.removeEventListener("online", refreshAll); };
  }, [storagePrefix, channelKey]);

  const selectedPage = pages[input.selectedChannelId];
  const selectedDraft = drafts[input.selectedChannelId];
  const threadId = channelSessionThreadId(input.selection)
    ?? input.branches.find(branch => branch.id === input.selection && branch.channelId === input.selectedChannelId)?.rootThreadId
    ?? (isChannelSessionDraft(input.selection) ? selectedDraft?.bound?.id ?? input.selection : selectedPage?.defaultSession?.id);
  const selectedSession = [threadId ? details[threadId] : undefined, selectedPage?.defaultSession, ...(selectedPage?.sessions ?? []), selectedDraft?.bound]
    .find(session => session?.id === threadId);
  const composerIdentity = selectedDraft && (selectedDraft.id === input.selection || selectedDraft.bound?.id === threadId)
    ? selectedDraft.id : threadId;

  function select(channelId: string, session: ChannelSessionSummary): void {
    const selection = channelSessionSelection(session.id);
    setDetails(current => ({ ...current, [session.id]: session }));
    input.setSelection(selection);
    setLast(current => ({ ...current, [channelId]: selection }));
  }
  function restore(channelId: string): void {
    const page = pages[channelId];
    const previous = last[channelId];
    const draft = drafts[channelId];
    const previousId = previous ? channelSessionThreadId(previous) : undefined;
    const valid = previous && (draft?.id === previous || page?.notificationWatermarks.some(entry => entry.id === previousId));
    input.setSelection(valid ? previous! : page?.defaultSession ? channelSessionSelection(page.defaultSession.id) : "");
  }
  function openDraft(channelId: string, title?: string): void {
    const current = drafts[channelId];
    const draft = current && !current.bound ? { ...current, ...(title?.trim() ? { title: title.trim() } : {}) }
      : { id: `session-draft:${crypto.randomUUID()}`, key: crypto.randomUUID(), ...(title?.trim() ? { title: title.trim() } : {}) };
    draftsRef.current = { ...draftsRef.current, [channelId]: draft };
    setDrafts(draftsRef.current);
    input.setSelection(draft.id);
    setLast(current => ({ ...current, [channelId]: draft.id }));
  }
  async function ensureThread(channelId: string, selection = input.selection): Promise<{ session: ChannelSessionSummary; draftKey?: string }> {
    const draft = draftsRef.current[channelId];
    if (draft && (selection === draft.id || channelSessionThreadId(selection) === draft.bound?.id)) {
      if (draft.bound) return { session: draft.bound, draftKey: draft.key };
      let pending = creations.current.get(draft.key);
      if (!pending) {
        draftsRef.current = { ...draftsRef.current, [channelId]: { ...draft, creationUnconfirmed: true } };
        setDrafts(draftsRef.current);
        // Persist the request identity before network I/O so an interrupted app can retry it.
        save(`${storagePrefix}:drafts`, draftsRef.current);
        setCreating(current => ({ ...current, [draft.id]: true }));
        pending = createChannelSession(input.cwd, channelId, { idempotencyKey: draft.key, ...(draft.title ? { title: draft.title } : {}) }).then(response => response.session);
        creations.current.set(draft.key, pending);
      }
      const session = await pending.catch(error => {
        const status = error && typeof error === "object" && "status" in error ? Number(error.status) : 0;
        if (ownerRef.current === storagePrefix && status >= 400 && status < 500) {
          draftsRef.current = { ...draftsRef.current, [channelId]: { ...draft, creationUnconfirmed: false } };
          setDrafts(draftsRef.current);
        }
        throw error;
      }).finally(() => {
        creations.current.delete(draft.key);
        if (ownerRef.current === storagePrefix) setCreating(current => ({ ...current, [draft.id]: false }));
      });
      if (ownerRef.current !== storagePrefix) throw new Error("Workspace changed while creating the conversation.");
      const bound = { ...draft, bound: session };
      draftsRef.current = { ...draftsRef.current, [channelId]: bound }; setDrafts(draftsRef.current);
      setDetails(current => ({ ...current, [session.id]: session }));
      if (latestRef.current.selectedChannelId === channelId && latestRef.current.selection === selection) input.setSelection(channelSessionSelection(session.id));
      setLast(current => ({ ...current, [channelId]: channelSessionSelection(session.id) }));
      void refresh(channelId);
      return { session, draftKey: draft.key };
    }
    const id = channelSessionThreadId(selection) ?? input.branches.find(branch => branch.id === selection && branch.channelId === channelId)?.rootThreadId;
    if (id) {
      const { session } = await getChannelSession(input.cwd, channelId, id);
      if (ownerRef.current !== storagePrefix) throw new Error("Workspace changed while resolving the conversation.");
      if (session.archivedAt) throw new Error("This conversation is archived. Restore it before sending.");
      setDetails(current => ({ ...current, [session.id]: session }));
      return { session };
    }
    if (selection) throw new Error("Conversation is unavailable. Select it again before sending.");
    const page = pages[channelId] ?? await listChannelSessions(input.cwd, channelId, { limit: 10 });
    if (ownerRef.current !== storagePrefix) throw new Error("Workspace changed while resolving the conversation.");
    const session = page.defaultSession;
    if (!session || session.archivedAt) throw new Error("The default conversation is unavailable.");
    return { session };
  }
  function renameDraft(channelId: string, title: string): void {
    const draft = draftsRef.current[channelId];
    if (!draft || draft.bound || draft.creationUnconfirmed) return;
    draftsRef.current = { ...draftsRef.current, [channelId]: { ...draft, title } };
    setDrafts(draftsRef.current);
  }

  async function update(channelId: string, sessionId: string, patch: UpdateChannelSessionRequest): Promise<void> {
    const owner = storagePrefix;
    const response = await updateChannelSession(input.cwd, channelId, sessionId, patch);
    if (ownerRef.current !== owner) return;
    setDetails(current => ({ ...current, [sessionId]: response.session }));
    if (patch.archived && latestRef.current.selectedChannelId === channelId
      && channelSessionThreadId(latestRef.current.selection) === sessionId) {
      input.setSelection(pages[channelId]?.defaultSession ? channelSessionSelection(pages[channelId]!.defaultSession!.id) : "");
    }
    await refresh(channelId);
  }
  function markRead(channelId: string, id: string): void {
    if (!document.hasFocus() || document.visibilityState !== "visible") return;
    const entry = pages[channelId]?.notificationWatermarks.find(entry => entry.id === id);
    if (entry) setRead(current => current[id] === entry.latestNotificationRevision ? current : { ...current, [id]: entry.latestNotificationRevision });
  }
  const enteredChannelRef = useRef("");
  useEffect(() => {
    if (!input.selectedChannelId || !pages[input.selectedChannelId]) return;
    const owner = `${storagePrefix}:${input.selectedChannelId}`;
    if (enteredChannelRef.current === owner) return;
    enteredChannelRef.current = owner;
    if (!input.selection) restore(input.selectedChannelId);
  }, [storagePrefix, input.selectedChannelId, pages]);
  useEffect(() => {
    const id = channelSessionThreadId(input.selection);
    if (!id || !input.selectedChannelId || !selectedPage) return;
    let cancelled = false;
    void getChannelSession(input.cwd, input.selectedChannelId, id).then(({ session }) => {
      if (cancelled) return;
      setDetails(current => ({ ...current, [session.id]: session }));
    }).catch(error => {
      if (cancelled) return;
      setErrors(current => ({ ...current, [input.selectedChannelId]: error instanceof Error ? error.message : String(error) }));
    });
    return () => { cancelled = true; };
  }, [storagePrefix, input.selectedChannelId, input.selection, selectedPage]);
  const unreadByChannel = Object.fromEntries(Object.entries(pages).map(([id, page]) => [id, channelSessionUnread(page.notificationWatermarks, read)]));
  return { pages, errors, loading, creating, selectedSession, threadId, composerIdentity, drafts, read, unreadByChannel, refresh, select, restore, openDraft, renameDraft, ensureThread, update, markRead };
}
