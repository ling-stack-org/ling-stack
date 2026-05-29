import type { ReactNode } from "react";
import {
  Bot,
  Database,
  Hash,
  History,
  Inbox,
  PlugZap,
  Plus,
  Settings,
  ShieldCheck,
  SquareTerminal,
  Users,
  Workflow,
} from "lucide-react";
import { useI18n } from "../../i18n.js";
import {
  channelSidebarTarget,
  teammateSidebarTarget,
  type SidebarTarget,
  type ViewId,
} from "../../app/view-types.js";
import { effectiveApprovalStatus } from "../../lib/approvals.js";
import type { AiTeammate, ApprovalRequest, Channel } from "../../types.js";

export function SidebarNavigation({
  activeSidebarTarget,
  channels,
  teammates,
  approvals,
  onOpenView,
  onOpenTasks,
  onSelectChannel,
  onSelectTeammate,
}: {
  readonly activeSidebarTarget: SidebarTarget;
  readonly channels: readonly Channel[];
  readonly teammates: readonly AiTeammate[];
  readonly approvals: readonly ApprovalRequest[];
  readonly onOpenView: (view: ViewId) => void;
  readonly onOpenTasks: () => void;
  readonly onSelectChannel: (channelId: string) => void;
  readonly onSelectTeammate: (teammateId: string) => void;
}): JSX.Element {
  const { t } = useI18n();
  const pendingApprovalCount = approvals.filter((approval) => effectiveApprovalStatus(approval) === "pending").length;
  const visibleTeammates = teammates.filter((teammate) => !teammate.hidden && teammate.status !== "disabled");

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
        <NavItem icon={<SquareTerminal />} label={t("Tasks")} active={activeSidebarTarget === "tasks"} onClick={onOpenTasks} />
        <NavItem icon={<PlugZap />} label={t("Model Workbench")} active={activeSidebarTarget === "providers"} onClick={() => onOpenView("providers")} />
        <NavItem icon={<History />} label={t("Runs")} active={activeSidebarTarget === "runs"} onClick={() => onOpenView("runs")} />
        <NavItem icon={<Inbox />} label={t("Inbox")} active={activeSidebarTarget === "approvals"} onClick={() => onOpenView("approvals")} />
        <NavItem icon={<Database />} label={t("Media Jobs")} active={activeSidebarTarget === "media"} onClick={() => onOpenView("media")} />
        <NavItem icon={<Settings />} label={t("Settings")} active={activeSidebarTarget === "settings"} onClick={() => onOpenView("settings")} />
        <NavItem icon={<Users />} label={t("AI Teammates")} active={activeSidebarTarget === "teammates"} onClick={() => onOpenView("teammates")} />
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

      <SidebarSection title={t("AI Teammates")} actionLabel={visibleTeammates.length === 0 ? t("Create") : undefined}>
        {visibleTeammates.length === 0 ? (
          <button className="sidebar-row muted-row" type="button" onClick={() => onOpenView("teammates")}>
            <Bot size={14} />
            <span>{t("No teammate yet")}</span>
          </button>
        ) : (
          visibleTeammates.map((teammate) => (
            <button
              key={teammate.id}
              className={activeSidebarTarget === teammateSidebarTarget(teammate.id) ? "sidebar-row selected" : "sidebar-row"}
              type="button"
              onClick={() => onSelectTeammate(teammate.id)}
            >
              <Bot size={14} />
              <span>{teammate.displayName}</span>
            </button>
          ))
        )}
      </SidebarSection>

      {pendingApprovalCount > 0 ? (
        <button className="sidebar-inbox-alert" type="button" onClick={() => onOpenView("approvals")}>
          <ShieldCheck size={15} />
          <span>{t("{count} pending approvals", { count: pendingApprovalCount })}</span>
        </button>
      ) : null}
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
