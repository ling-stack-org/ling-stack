import type { ReactNode } from "react";
import {
  Database,
  EyeOff,
  Hash,
  History,
  Inbox,
  Pin,
  PinOff,
  PlugZap,
  Plus,
  Settings,
  ShieldCheck,
  SquareTerminal,
  Users,
  Workflow,
} from "lucide-react";
import type { AiTeammateTemplate } from "@ling-stack/core/skill-types";
import { useI18n } from "../../i18n.js";
import {
  channelSidebarTarget,
  conversationSidebarTarget,
  type SidebarConversationItem,
  type SidebarTarget,
  type ViewId,
} from "../../app/view-types.js";
import { effectiveApprovalStatus } from "../../lib/approvals.js";
import { AvatarInitial, type AvatarTone } from "../../shared/components/index.js";
import type { ApprovalRequest, Channel } from "../../types.js";
import {
  roleAvatarTone,
  teammateInitial,
  teammateInitialFromName,
} from "../teammates/helpers.js";
import type { LocalTeammateDraft } from "../teammates/types.js";

export function SidebarNavigation({
  activeSidebarTarget,
  channels,
  conversations,
  approvals,
  teammateTemplates,
  localTeammates,
  pinnedTemplateIds,
  hiddenTemplateIds,
  onToggleLocalTeammatePinned,
  onToggleLocalTeammateHidden,
  onToggleTemplatePinned,
  onToggleTemplateHidden,
  onOpenView,
  onOpenTasks,
  onSelectChannel,
  onSelectConversation,
}: {
  readonly activeSidebarTarget: SidebarTarget;
  readonly channels: readonly Channel[];
  readonly conversations: readonly SidebarConversationItem[];
  readonly approvals: readonly ApprovalRequest[];
  readonly teammateTemplates: readonly AiTeammateTemplate[];
  readonly localTeammates: readonly LocalTeammateDraft[];
  readonly pinnedTemplateIds: readonly string[];
  readonly hiddenTemplateIds: readonly string[];
  readonly onToggleLocalTeammatePinned: (teammateId: string) => void;
  readonly onToggleLocalTeammateHidden: (teammateId: string) => void;
  readonly onToggleTemplatePinned: (templateId: string) => void;
  readonly onToggleTemplateHidden: (templateId: string) => void;
  readonly onOpenView: (view: ViewId) => void;
  readonly onOpenTasks: () => void;
  readonly onSelectChannel: (channelId: string) => void;
  readonly onSelectConversation: (item: SidebarConversationItem) => void;
}): JSX.Element {
  const { t } = useI18n();
  const pendingApprovalCount = approvals.filter((approval) => effectiveApprovalStatus(approval) === "pending").length;
  const pinnedTemplates = new Set(pinnedTemplateIds);
  const hiddenTemplates = new Set(hiddenTemplateIds);
  const visibleLocalTeammates = [...localTeammates]
    .filter((teammate) => !teammate.hidden)
    .sort((left, right) => Number(right.pinned) - Number(left.pinned) || left.createdAt.localeCompare(right.createdAt));
  const visibleTemplateRows = [...teammateTemplates]
    .filter((template) => !hiddenTemplates.has(template.id))
    .sort((left, right) => Number(pinnedTemplates.has(right.id)) - Number(pinnedTemplates.has(left.id)) || left.name.localeCompare(right.name))
    .slice(0, Math.max(2, 6 - visibleLocalTeammates.length));

  return (
    <aside className="left-nav" aria-label="Ling Stack navigation">
      <div className="brand">
        <div className="brand-mark">L</div>
        <div>
          <strong>Ling Stack</strong>
          <span>{t("AI teammate workspace")}</span>
        </div>
      </div>

      <nav className="primary-nav">
        <NavItem icon={<Workflow />} label={t("Workspace")} active={activeSidebarTarget === "workspace"} onClick={() => onOpenView("workspace")} />
        <NavItem icon={<Users />} label={t("AI Teammates")} active={activeSidebarTarget === "teammates"} onClick={() => onOpenView("teammates")} />
        <NavItem icon={<Inbox />} label={t("Inbox")} active={activeSidebarTarget === "approvals"} onClick={() => onOpenView("approvals")} />
        <NavItem icon={<SquareTerminal />} label={t("Tasks")} active={activeSidebarTarget === "tasks"} onClick={onOpenTasks} />
        <NavItem icon={<PlugZap />} label={t("Model Workbench")} active={activeSidebarTarget === "providers"} onClick={() => onOpenView("providers")} />
        <NavItem icon={<History />} label={t("Runs")} active={activeSidebarTarget === "runs"} onClick={() => onOpenView("runs")} />
      </nav>

      <SidebarSection title={t("Channels")} actionLabel={channels.length === 0 ? t("Create") : undefined}>
        {channels.length === 0 ? (
          <button className="sidebar-row muted-row" type="button" onClick={() => onOpenView("workspace")}>
            <Hash size={14} />
            <span>{t("No channel yet")}</span>
          </button>
        ) : (
          channels.map((channel) => (
            <button
              key={channel.id}
              className={activeSidebarTarget === channelSidebarTarget(channel.id) ? "sidebar-row selected" : "sidebar-row"}
              type="button"
              onClick={() => onSelectChannel(channel.id)}
            >
              <Hash size={14} />
              <span>{channel.name}</span>
            </button>
          ))
        )}
      </SidebarSection>

      <SidebarSection title={t("AI Teammates")} actionLabel={t("Add")} onAction={() => onOpenView("teammates")}>
        {conversations.filter((item) => item.kind === "teammate").map((item) => (
          <button
            key={`${item.kind}:${item.id}`}
            className={activeSidebarTarget === conversationSidebarTarget(item) ? "sidebar-row selected" : "sidebar-row"}
            type="button"
            onClick={() => onSelectConversation(item)}
          >
            <AvatarInitial label={item.avatarLabel} tone={item.tone} />
            <span>{item.label}</span>
          </button>
        ))}
        {visibleLocalTeammates.map((teammate) => {
          const template = teammate.templateId ? teammateTemplates.find((item) => item.id === teammate.templateId) : undefined;
          return (
            <SidebarTeammateRow
              key={teammate.id}
              active={activeSidebarTarget === "teammates"}
              label={teammate.displayName}
              tag={t("Local")}
              avatarLabel={template ? teammateInitial(template) : teammateInitialFromName(teammate.displayName)}
              tone={template ? roleAvatarTone(template.roleKey) : "gray"}
              pinned={teammate.pinned}
              onOpen={() => onOpenView("teammates")}
              onTogglePinned={() => onToggleLocalTeammatePinned(teammate.id)}
              onToggleHidden={() => onToggleLocalTeammateHidden(teammate.id)}
            />
          );
        })}
        {visibleTemplateRows.map((template) => (
          <SidebarTeammateRow
            key={template.id}
            active={activeSidebarTarget === "teammates"}
            label={t(template.name)}
            tag={t("AI")}
            avatarLabel={teammateInitial(template)}
            tone={roleAvatarTone(template.roleKey)}
            pinned={pinnedTemplates.has(template.id)}
            onOpen={() => onOpenView("teammates")}
            onTogglePinned={() => onToggleTemplatePinned(template.id)}
            onToggleHidden={() => onToggleTemplateHidden(template.id)}
          />
        ))}
      </SidebarSection>

      <SidebarSection title={t("Direct Messages")}>
        {conversations.filter((item) => item.kind === "direct").map((item) => (
          <button
            key={`${item.kind}:${item.id}`}
            className={activeSidebarTarget === conversationSidebarTarget(item) ? "sidebar-row selected" : "sidebar-row"}
            type="button"
            onClick={() => onSelectConversation(item)}
          >
            <AvatarInitial label={item.avatarLabel} tone={item.tone} />
            <span>{item.label}</span>
          </button>
        ))}
      </SidebarSection>

      <div className="sidebar-config">
        <span>{t("Configuration")}</span>
        <div className="config-grid">
          <button
            type="button"
            className={activeSidebarTarget === "approvals" ? "config-button active" : "config-button"}
            onClick={() => onOpenView("approvals")}
            title={t("Approvals")}
            aria-label={t("Approvals")}
          >
            <ShieldCheck size={16} />
            <small>{pendingApprovalCount}</small>
          </button>
          <button
            type="button"
            className={activeSidebarTarget === "media" ? "config-button active" : "config-button"}
            onClick={() => onOpenView("media")}
            title={t("Media Jobs")}
            aria-label={t("Media Jobs")}
          >
            <Database size={16} />
          </button>
          <button
            type="button"
            className={activeSidebarTarget === "settings" ? "config-button active" : "config-button"}
            onClick={() => onOpenView("settings")}
            title={t("Settings")}
            aria-label={t("Settings")}
          >
            <Settings size={16} />
          </button>
        </div>
      </div>
    </aside>
  );
}

function SidebarSection({
  title,
  actionLabel,
  onAction,
  children,
}: {
  readonly title: string;
  readonly actionLabel?: string;
  readonly onAction?: () => void;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <section className="sidebar-section">
      <div className="sidebar-section-title">
        <span>{title}</span>
        {actionLabel ? (
          onAction ? (
            <button className="sidebar-section-action" type="button" onClick={onAction}>
              <Plus size={11} />
              {actionLabel}
            </button>
          ) : (
            <small>{actionLabel}</small>
          )
        ) : null}
      </div>
      <div className="sidebar-section-list">{children}</div>
    </section>
  );
}

function SidebarTeammateRow({
  active,
  label,
  tag,
  avatarLabel,
  tone,
  pinned,
  onOpen,
  onTogglePinned,
  onToggleHidden,
}: {
  readonly active: boolean;
  readonly label: string;
  readonly tag: string;
  readonly avatarLabel: string;
  readonly tone: AvatarTone;
  readonly pinned: boolean;
  readonly onOpen: () => void;
  readonly onTogglePinned: () => void;
  readonly onToggleHidden: () => void;
}): JSX.Element {
  const { t } = useI18n();
  return (
    <div className={active ? "sidebar-row-shell selected" : "sidebar-row-shell"}>
      <button className="sidebar-row-main" type="button" onClick={onOpen}>
        <AvatarInitial label={avatarLabel} tone={tone} />
        <span>{label}</span>
        <small>{tag}</small>
      </button>
      <span className="sidebar-row-tools">
        <button
          className={pinned ? "sidebar-mini-action active" : "sidebar-mini-action"}
          type="button"
          aria-label={`${pinned ? t("Unpin") : t("Pin")} ${label}`}
          onClick={onTogglePinned}
        >
          {pinned ? <PinOff size={12} /> : <Pin size={12} />}
        </button>
        <button className="sidebar-mini-action" type="button" aria-label={`${t("Hide")} ${label}`} onClick={onToggleHidden}>
          <EyeOff size={12} />
        </button>
      </span>
    </div>
  );
}

function NavItem({
  icon,
  label,
  active = false,
  disabled = false,
  onClick,
}: {
  readonly icon: JSX.Element;
  readonly label: string;
  readonly active?: boolean;
  readonly disabled?: boolean;
  readonly onClick?: () => void;
}): JSX.Element {
  return (
    <button className={active ? "nav-item active" : "nav-item"} type="button" disabled={disabled} onClick={onClick}>
      {icon}
      <span>{label}</span>
    </button>
  );
}
