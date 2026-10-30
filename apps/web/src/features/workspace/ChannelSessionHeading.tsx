import { useState } from "react";
import type { ChannelSessionSummary, UpdateChannelSessionRequest } from "@ling-stack/contracts";
import { useI18n } from "../../i18n.js";
import { Button, InlineFeedback, Input, useLingToast } from "../../shared/ui/index.js";
import { ChannelSessionActionsMenu } from "../../shared/conversation/ChannelSessionActionsMenu.js";

export function ChannelSessionHeading({ channelName, title, session, disabled, onUpdate }: {
  readonly channelName: string;
  readonly title?: string;
  readonly session?: ChannelSessionSummary;
  readonly disabled?: boolean;
  readonly onUpdate?: (patch: UpdateChannelSessionRequest) => Promise<void>;
}): React.JSX.Element {
  const { t } = useI18n();
  const { showToast } = useLingToast();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const displayTitle = title === "Default conversation" ? t("Default conversation")
    : title === "New conversation" ? t("New channel conversation") : title;
  async function update(patch: UpdateChannelSessionRequest): Promise<void> {
    if (!onUpdate || busy) return;
    setBusy(true); setError("");
    try {
      await onUpdate(patch);
      setEditing(false);
      if (patch.archived) showToast({ message: `${displayTitle} · ${t("Archived")}`, tone: "success", action: {
        label: t("Undo"), altText: t("Restore conversation"), onSelect: () => {
          void onUpdate({ archived: false }).catch(caught => showToast({ message: String(caught instanceof Error ? caught.message : caught), tone: "error" }));
        },
      } });
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError(message);
      showToast({ message: `${displayTitle ?? session?.title ?? channelName}: ${message}`, tone: "error" });
    }
    finally { setBusy(false); }
  }
  return <div className="channel-session-heading">
    {editing ? <form className="sidebar-session-rename" onSubmit={event => { event.preventDefault(); void update({ title: name }); }}>
      <Input autoFocus data-session-rename="true" aria-label={t("Conversation title")} value={name}
        disabled={busy} onChange={event => setName(event.target.value)} onKeyDown={event => {
          if (event.key === "Escape" && !busy) { setEditing(false); setError(""); }
        }} />
      <Button type="submit" size="sm" disabled={busy || !name.trim() || [...name.trim()].length > 120}>{t("Save")}</Button>
      <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(false)}>{t("Cancel")}</Button>
    </form> : <h1 tabIndex={-1} title={[channelName, displayTitle].filter(Boolean).join(" / ")}>{channelName}{displayTitle ? <><span className="channel-session-title-separator"> / </span><span className="channel-session-title">{displayTitle}</span></> : null}</h1>}
    {session && onUpdate && !editing ? <ChannelSessionActionsMenu title={displayTitle ?? session.title} isDefault={session.isDefault}
      archived={Boolean(session.archivedAt)} disabled={disabled || busy}
      onRename={() => { setName(session.title); setEditing(true); }}
      onToggleArchived={() => void update({ archived: !session.archivedAt })} /> : null}
    {error ? <InlineFeedback tone="danger">{error}</InlineFeedback> : null}
  </div>;
}
