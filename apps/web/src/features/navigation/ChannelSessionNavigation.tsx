import { useEffect, useRef, useState, type ReactNode } from "react";
import { Archive, ChevronDown, ChevronRight, MessageSquare, PencilLine, Plus, SlidersHorizontal } from "lucide-react";
import type { ChannelSessionListResponse, ChannelSessionSummary } from "@ling-stack/contracts";
import { listChannelSessions } from "../../api/channels.js";
import type { Channel } from "../../types.js";
import { useI18n } from "../../i18n.js";
import { Button, Dialog, DialogContent, DialogHeader, IconButton, InlineFeedback, Input, Skeleton, StatusIndicator } from "../../shared/ui/index.js";
import type { useChannelSessionsController } from "../../app/use-channel-sessions-controller.js";
import { sessionStatus } from "../../app/channel-session-state.js";
import { ChannelSessionActionsMenu } from "../../shared/conversation/ChannelSessionActionsMenu.js";
import { SidebarSectionMenu } from "./SidebarSectionMenu.js";
import { SidebarObjectRow } from "./SidebarObjectRow.js";
import { channelAvatarMeta } from "./sidebar-channel-avatar.js";
import { useLingToast } from "../../shared/feedback/LingToastProvider.js";

type Controller = ReturnType<typeof useChannelSessionsController>;

export function ChannelSessionNavigation({ channel, cwd, active, status, statusId, controller, onSelectChannel, onArchiveChannel, onSelectSession, onNewSession, onChannelAction }: {
  readonly channel: Channel; readonly cwd: string; readonly active: boolean;
  readonly status?: ReactNode; readonly statusId?: string; readonly controller: Controller;
  readonly onChannelAction?: (action: "settings" | "rename") => void;
  readonly onSelectChannel: () => void; readonly onArchiveChannel?: () => void;
  readonly onSelectSession: (session: ChannelSessionSummary) => void; readonly onNewSession: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const { showToast } = useLingToast();
  const [expanded, setExpanded] = useState(() => { try { return localStorage.getItem(`ling:channel-expanded:${cwd}:${channel.id}`) !== "false"; } catch { return true; } });
  const [allOpen, setAllOpen] = useState(false);
  const [archived, setArchived] = useState(false);
  const [q, setQ] = useState("");
  const [page, setPage] = useState<ChannelSessionListResponse>();
  const [items, setItems] = useState<readonly ChannelSessionSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState("");
  const [title, setTitle] = useState("");
  const [busyId, setBusyId] = useState("");
  const [retry, setRetry] = useState(0);
  const [failedPage, setFailedPage] = useState<"first" | "more">();
  const [menuOpen, setMenuOpen] = useState("");
  const [channelMenuOpen, setChannelMenuOpen] = useState(false);
  const [focusWithin, setFocusWithin] = useState(false);
  const generation = useRef(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const navigateOnClose = useRef(false);
  const orderRef = useRef<readonly string[]>([]);
  const scopeRef = useRef("");
  scopeRef.current = `${cwd}:${channel.id}`;
  const preview = controller.pages[channel.id];
  const avatar = channelAvatarMeta(channel);
  const selectedId = active ? controller.threadId : undefined;
  const visibleSessions = [...(preview?.sessions ?? [])];
  if (!focusWithin && !editing && !menuOpen) orderRef.current = visibleSessions.map(session => session.id);
  else visibleSessions.sort((a, b) => {
    const position = (id: string) => { const index = orderRef.current.indexOf(id); return index < 0 ? Number.MAX_SAFE_INTEGER : index; };
    return position(a.id) - position(b.id);
  });
  const selectedOutsidePreview = active && controller.selectedSession?.channelId === channel.id
    && controller.selectedSession.id !== preview?.defaultSession?.id
    && !visibleSessions.some(session => session.id === controller.selectedSession?.id)
    ? controller.selectedSession : undefined;
  function openDirectory(): void { setArchived(false); setQ(""); setPage(undefined); setItems([]); setAllOpen(true); }
  useEffect(() => {
    if (!allOpen) { generation.current += 1; return; }
    const request = ++generation.current;
    setLoading(true); setError("");
    const timer = setTimeout(() => {
      void listChannelSessions(cwd, channel.id, { q, archived, limit: 50 }).then(response => {
        if (generation.current !== request) return;
        setPage(response); setItems(response.sessions);
      }).catch(caught => {
        if (generation.current === request) { setFailedPage("first"); setError(caught instanceof Error ? caught.message : String(caught)); }
      }).finally(() => { if (generation.current === request) setLoading(false); });
    }, 180);
    return () => { clearTimeout(timer); generation.current += 1; };
  }, [allOpen, q, archived, cwd, channel.id, retry]);
  async function more(): Promise<void> {
    if (!page?.nextCursor || loading) return;
    const request = ++generation.current; setLoading(true); setError("");
    try {
      const response = await listChannelSessions(cwd, channel.id, { q, archived, limit: 50, cursor: page.nextCursor });
      if (generation.current !== request) return;
      setPage(response); setItems(current => [...new Map([...current, ...response.sessions].map(session => [session.id, session])).values()]);
    } catch (caught) { if (generation.current === request) { setFailedPage("more"); setError(caught instanceof Error ? caught.message : String(caught)); } }
    finally { if (generation.current === request) setLoading(false); }
  }
  async function mutate(session: ChannelSessionSummary, patch: { title?: string; archived?: boolean }): Promise<void> {
    if (busyId) return;
    const scope = scopeRef.current;
    setBusyId(session.id); setError(""); setFailedPage(undefined);
    try {
      await controller.update(channel.id, session.id, patch);
      if (scopeRef.current !== scope) return;
      setEditing("");
      if (patch.archived !== undefined) setItems(current => current.filter(item => item.id !== session.id));
      else setItems(current => current.map(item => item.id === session.id ? { ...item, title: patch.title! } : item));
      if (patch.archived) showToast({ message: `${session.title} · ${t("Archived")}`, tone: "success", action: {
        label: t("Undo"), altText: t("Restore conversation"), onSelect: () => {
          void controller.update(channel.id, session.id, { archived: false }).catch(caught => {
            if (scopeRef.current === scope) setError(caught instanceof Error ? caught.message : String(caught));
            showToast({ message: caught instanceof Error ? caught.message : String(caught), tone: "error", action: {
              label: t("View all conversations"), altText: t("View all conversations"), onSelect: () => { openDirectory(); setArchived(true); },
            } });
          });
        },
      } });
    } catch (caught) { if (scopeRef.current === scope) setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { if (scopeRef.current === scope) setBusyId(""); }
  }
  const row = (session: ChannelSessionSummary) => {
    const unread = (controller.read[session.id] ?? session.latestNotificationRevision) < session.latestNotificationRevision;
    const status = sessionStatus(session);
    const statusLabel = status === "waiting" ? t(session.pendingApprovalCount > 0 ? "Waiting for approval" : "Conversation waiting")
      : status === "blocked" ? t("Blocked") : status === "failed" ? t("Failed") : status === "queued" ? t("Queued") : t("Running");
    return <div key={session.id} data-session-id={session.id} data-session-default={session.isDefault || undefined} className={`sidebar-branch-row-shell${selectedId === session.id ? " selected" : ""}`}>
      {editing === session.id ? <form className="sidebar-session-rename" onSubmit={event => { event.preventDefault(); void mutate(session, { title }); }}>
        <Input autoFocus size="sm" value={title} data-session-rename="true" aria-label={t("Conversation title")} onChange={event => setTitle(event.target.value)} onKeyDown={event => { if (event.key === "Escape") setEditing(""); }} />
        <Button type="submit" size="sm" disabled={!title.trim() || [...title.trim()].length > 120 || busyId === session.id}>{t("Save")}</Button>
      </form> : <>
        <button type="button" className="sidebar-branch-row" title={session.title} aria-current={selectedId === session.id ? "page" : undefined} onClick={() => { navigateOnClose.current = allOpen; onSelectSession(session); setAllOpen(false); }}>
          <MessageSquare size={13} aria-hidden="true" />
          <span>{session.title === "Default conversation" ? t("Default conversation") : session.title === "New conversation" ? t("New channel conversation") : session.title}</span>
          {session.isDefault ? <small className="sidebar-session-default">{t("Default")}</small> : null}
          {status ? <StatusIndicator tone={status === "waiting" || status === "blocked" ? "warning" : status === "failed" ? "danger" : "info"} label={statusLabel} /> : null}
          {unread ? <span className="sidebar-session-unread" aria-label={t("Unread")} /> : null}
          {session.pendingApprovalCount > 0 ? <small>{session.pendingApprovalCount}</small> : null}
        </button>
        <span className="sidebar-row-tools">
          <ChannelSessionActionsMenu title={session.title} isDefault={session.isDefault} archived={Boolean(session.archivedAt)} disabled={busyId !== ""}
            onOpenChange={open => setMenuOpen(open ? session.id : "")}
            onRename={() => { setEditing(session.id); setTitle(session.title); }}
            onToggleArchived={() => void mutate(session, { archived: !session.archivedAt })} />
        </span>
      </>}
    </div>;
  };
  const directoryDefault = !archived && page?.defaultSession
    && (!q.trim() || (page.defaultSession.title === "Default conversation" ? t("Default conversation") : page.defaultSession.title).toLocaleLowerCase().includes(q.trim().toLocaleLowerCase()))
    ? page.defaultSession : undefined;
  return <div className="sidebar-channel-group" onFocusCapture={() => setFocusWithin(true)} onBlurCapture={event => {
    if (!event.currentTarget.contains(event.relatedTarget)) setFocusWithin(false);
  }}>
    <div className="sidebar-channel-container-row">
      <IconButton className="sidebar-session-expand" icon={expanded ? ChevronDown : ChevronRight} label={`${expanded ? t("Collapse conversations") : t("Expand conversations")}: ${channel.name}`} aria-expanded={expanded} onClick={() => {
        const next = !expanded; setExpanded(next); try { localStorage.setItem(`ling:channel-expanded:${cwd}:${channel.id}`, String(next)); } catch { /* Session remains usable without browser storage. */ }
      }} />
      <SidebarObjectRow actionsLabel={t("Channel actions")} ariaLabel={channel.name} shellClassName={active ? "channel-contains-selection" : undefined} icon={<span className={`sidebar-channel-avatar ${avatar.tone}`} aria-hidden="true">{avatar.label}</span>} onSelect={onSelectChannel}
        status={status} statusId={statusId}
        actions={<><IconButton className="sidebar-mini-action" icon={Plus} label={t("New conversation in {channel}", { channel: channel.name })} onClick={onNewSession} />{onArchiveChannel ? <SidebarSectionMenu open={channelMenuOpen} onOpenChange={setChannelMenuOpen} label={`${t("Channel actions")}: ${channel.name}`} items={[
            ...(onChannelAction ? [
              { id: "settings", icon: SlidersHorizontal, label: t("Channel settings"), onSelect: () => onChannelAction("settings") },
              { id: "rename", icon: PencilLine, label: t("Rename channel"), onSelect: () => onChannelAction("rename") },
            ] : []),
            { id: "archive", icon: Archive, label: t("Archive channel"), danger: true, onSelect: onArchiveChannel },
          ]} /> : null}</>}>{channel.name}</SidebarObjectRow>
    </div>
    {expanded ? <div className="sidebar-branch-list" role="list" aria-label={`${channel.name} ${t("Conversations")}`}>
      {preview?.defaultSession ? row(preview.defaultSession) : null}
      {selectedOutsidePreview ? row(selectedOutsidePreview) : null}
      {visibleSessions.map(row)}
      {active && controller.drafts[channel.id]?.id === selectedId ? <div className="sidebar-branch-row-shell selected" data-session-draft="true"><button type="button" className="sidebar-branch-row" aria-current="page" onClick={onNewSession} title={controller.drafts[channel.id]?.title || t("New channel conversation")}><MessageSquare size={13} aria-hidden="true" /><span>{controller.drafts[channel.id]?.title || t("New channel conversation")}</span><small>{t("Draft")}</small></button></div> : null}
      {!preview && controller.loading[channel.id] ? <div className="sidebar-session-loading" role="status"><span className="sidebar-session-empty">{t("Loading conversations...")}</span><Skeleton height={12} width="70%" /><Skeleton height={12} width="55%" /></div> : null}
      {controller.errors[channel.id] ? <><InlineFeedback tone="danger">{controller.errors[channel.id]}</InlineFeedback><Button size="sm" variant="ghost" onClick={() => void controller.refresh(channel.id)}>{t("Retry")}</Button></> : null}
      {preview?.diagnostics.length ? <details className="sidebar-session-diagnostics"><summary>{t("Some historical conversations need repair")}</summary><ul>{preview.diagnostics.map(item => <li key={`${item.branchId}:${item.code}`}><code>{item.branchId}</code>: {item.code}</li>)}</ul></details> : null}
      <button ref={triggerRef} type="button" className="sidebar-session-all" onClick={openDirectory}>{t("View all conversations")}</button>
    </div> : null}
    {!allOpen && error ? <InlineFeedback tone="danger">{error}</InlineFeedback> : null}
    <Dialog open={allOpen} onOpenChange={setAllOpen}>
      <DialogContent size="md" onCloseAutoFocus={event => {
        event.preventDefault();
        if (navigateOnClose.current) { document.querySelector<HTMLElement>(".channel-title-line h1")?.focus(); navigateOnClose.current = false; }
        else triggerRef.current?.focus();
      }}>
        <DialogHeader title={`${channel.name} / ${t("Conversations")}`} closeLabel={t("Close")} />
        <div className="channel-session-directory">
          <Input aria-label={t("Search conversations")} placeholder={t("Search by title")} value={q} onChange={event => setQ(event.target.value)} />
          <div className="channel-session-tabs"><Button size="sm" variant={!archived ? "primary" : "ghost"} onClick={() => setArchived(false)}>{t("Active")}</Button><Button size="sm" variant={archived ? "primary" : "ghost"} onClick={() => setArchived(true)}>{t("Archived")}</Button><Button size="sm" variant="ghost" onClick={() => { navigateOnClose.current = true; setAllOpen(false); onNewSession(); }}>{t("New channel conversation")}</Button></div>
          <div className="channel-session-results">
          {error ? <><InlineFeedback tone="danger">{error}</InlineFeedback>{failedPage ? <Button size="sm" disabled={loading} onClick={() => failedPage === "more" ? void more() : setRetry(current => current + 1)}>{t("Retry")}</Button> : null}</> : null}
          {directoryDefault ? row(directoryDefault) : null}
          {items.map(row)}
          {!loading && items.length === 0 && !directoryDefault ? <p>{archived ? t("No archived conversations") : t("No matching conversations")}</p> : null}
          {loading ? <p role="status">{t("Loading conversations...")}</p> : null}
          {page?.nextCursor ? <Button size="sm" variant="secondary" disabled={loading} onClick={() => void more()}>{t("Load more")}</Button> : null}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  </div>;
}
