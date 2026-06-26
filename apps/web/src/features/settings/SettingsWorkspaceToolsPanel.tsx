import {
  Bot,
  Box,
  Hand,
  Kanban,
  Shield,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";
import { useI18n, type Translate } from "../../i18n.js";
import {
  authorizationModeToPermission,
  permissionToAuthorizationMode,
  type ConversationAuthorizationMode,
} from "../../lib/conversation-authorization.js";
import type { PermissionPreset, SessionPermissionMode } from "../../types.js";

export interface WorkspaceToolCounts {
  readonly readyProviderCount: number;
  readonly visibleTeammateCount: number;
  readonly openWorkItemCount: number;
}

interface WorkspaceToolItem {
  readonly id: "providers" | "teammates" | "work-board" | "approval";
  readonly title: string;
  readonly description: string;
  readonly chipLabel: string;
  readonly actionLabel: string;
  readonly icon: LucideIcon;
  readonly onOpen: () => void;
}

export function SettingsWorkspaceToolsPanel({
  counts,
  defaultPermissionMode,
  defaultPermissionPreset,
  onDefaultPermissionChange,
  onOpenProviders,
  onOpenTeammates,
  onOpenWorkBoard,
  onOpenApprovalPolicy,
}: {
  readonly counts: WorkspaceToolCounts;
  readonly defaultPermissionMode: SessionPermissionMode | undefined;
  readonly defaultPermissionPreset: PermissionPreset | undefined;
  readonly onDefaultPermissionChange: (mode: SessionPermissionMode, preset: PermissionPreset) => void;
  readonly onOpenProviders: () => void;
  readonly onOpenTeammates: () => void;
  readonly onOpenWorkBoard: () => void;
  readonly onOpenApprovalPolicy: () => void;
}): JSX.Element {
  const { t } = useI18n();
  const authorizationMode = permissionToAuthorizationMode(defaultPermissionMode, defaultPermissionPreset);
  const authorizationOption = authorizationOptions.find((option) => option.mode === authorizationMode) ?? authorizationOptions[1];
  const tools: readonly WorkspaceToolItem[] = [
    {
      id: "providers",
      title: t("Model Workbench"),
      description: t("Configure providers, models, and checks."),
      chipLabel: readyModelCountLabel(counts.readyProviderCount, t),
      actionLabel: t("Open Model Workbench"),
      icon: Box,
      onOpen: onOpenProviders,
    },
    {
      id: "teammates",
      title: t("AI Teammates"),
      description: t("Manage teammate roster, models, and private chats."),
      chipLabel: t("{count} teammates", { count: counts.visibleTeammateCount }),
      actionLabel: t("Open AI Teammates"),
      icon: Bot,
      onOpen: onOpenTeammates,
    },
    {
      id: "work-board",
      title: t("Work Board"),
      description: t("Review actionable work across channels and runs."),
      chipLabel: t("{count} pending work items", { count: counts.openWorkItemCount }),
      actionLabel: t("Open Work Board"),
      icon: Kanban,
      onOpen: onOpenWorkBoard,
    },
    {
      id: "approval",
      title: t("Approval strategy"),
      description: t("Set the default authorization for new conversations."),
      chipLabel: t("Default: {mode}", { mode: t(authorizationOption.labelKey) }),
      actionLabel: t("Open advanced policy"),
      icon: ShieldCheck,
      onOpen: onOpenApprovalPolicy,
    },
  ];

  return (
    <section className="settings-workspace-tools" aria-labelledby="workspace-tools-settings-title">
      <header className="settings-configuration-head">
        <span>{t("Workspace configuration")}</span>
        <h2 id="workspace-tools-settings-title">{t("Configuration")}</h2>
        <p>{t("Configure the workspace defaults that new conversations and daily work start from.")}</p>
      </header>
      <div className="settings-configuration-grid">
        <div className="settings-tool-row-list" aria-label={t("Configuration shortcuts")}>
          {tools.map((tool) => (
            <WorkspaceToolRow key={tool.id} tool={tool} />
          ))}
        </div>
        <aside className="settings-global-approval-card" aria-labelledby="settings-global-approval-title">
          <div className="settings-global-approval-head">
            <span aria-hidden="true">
              <ShieldCheck size={18} />
            </span>
            <div>
              <strong id="settings-global-approval-title">{t("Global approval default")}</strong>
              <small>{t("New conversations inherit this setting unless the conversation changes it.")}</small>
            </div>
          </div>
          <div className="settings-authorization-options" aria-label={t("Authorization mode")}>
            {authorizationOptions.map((option) => (
              <AuthorizationOptionButton
                key={option.mode}
                option={option}
                selected={option.mode === authorizationMode}
                onSelect={() => {
                  const selection = authorizationModeToPermission(option.mode);
                  onDefaultPermissionChange(selection.permissionMode, selection.permissionPreset);
                }}
              />
            ))}
          </div>
          <div className="settings-authorization-note">
            <strong>{t("Current default")}: {t(authorizationOption.labelKey)}</strong>
            <span>{t(authorizationOption.descriptionKey)}</span>
          </div>
          <button className="secondary-button settings-global-approval-action" type="button" onClick={onOpenApprovalPolicy}>
            {t("Open advanced policy")}
          </button>
        </aside>
      </div>
    </section>
  );
}

function WorkspaceToolRow({ tool }: { readonly tool: WorkspaceToolItem }): JSX.Element {
  const Icon = tool.icon;
  return (
    <article className="settings-tool-row">
      <span className="settings-tool-row-icon" aria-hidden="true">
        <Icon size={21} />
      </span>
      <span className="settings-tool-row-copy">
        <span className="settings-tool-row-heading">
          <strong>{tool.title}</strong>
          <small>{tool.chipLabel}</small>
        </span>
        <span>{tool.description}</span>
      </span>
      <button className="secondary-button settings-tool-row-action" type="button" onClick={tool.onOpen}>
        {tool.actionLabel}
      </button>
    </article>
  );
}

interface AuthorizationOption {
  readonly mode: ConversationAuthorizationMode;
  readonly icon: LucideIcon;
  readonly labelKey: string;
  readonly descriptionKey: string;
}

const authorizationOptions: readonly AuthorizationOption[] = [
  {
    mode: "ask",
    icon: Hand,
    labelKey: "Ask first",
    descriptionKey: "Ask before workspace changes, commands, and external actions.",
  },
  {
    mode: "smart",
    icon: Shield,
    labelKey: "Smart authorization",
    descriptionKey: "Allow workspace edits; ask before commands, external actions, or policy risks.",
  },
  {
    mode: "always",
    icon: ShieldCheck,
    labelKey: "Always authorize",
    descriptionKey: "Use full access for this conversation after explicit confirmation.",
  },
];

function AuthorizationOptionButton({
  option,
  selected,
  onSelect,
}: {
  readonly option: AuthorizationOption;
  readonly selected: boolean;
  readonly onSelect: () => void;
}): JSX.Element {
  const { t } = useI18n();
  const Icon = option.icon;
  return (
    <button
      className={selected ? "settings-authorization-option selected" : "settings-authorization-option"}
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      title={t(option.descriptionKey)}
    >
      <Icon size={15} />
      <span>{t(option.labelKey)}</span>
    </button>
  );
}

function readyModelCountLabel(count: number, t: Translate): string {
  return count === 1
    ? t("{count} available model", { count })
    : t("{count} available models", { count });
}
