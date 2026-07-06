import {
  Bot,
  Box,
  Brain,
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
import { StatusActionRow } from "../../shared/components/index.js";
import type { PermissionPreset, SessionPermissionMode } from "../../types.js";

export interface WorkspaceToolCounts {
  readonly readyProviderCount: number;
  readonly visibleTeammateCount: number;
  readonly activeCouncilCount: number;
  readonly openWorkItemCount: number;
}

interface WorkspaceToolItem {
  readonly id: "providers" | "teammates" | "councils" | "work-board" | "approval";
  readonly title: string;
  readonly chipLabel: string;
  readonly actionLabel: string;
  readonly icon: LucideIcon;
  readonly onOpen: () => void;
}

interface WorkspaceToolGroup {
  readonly id: "setup" | "controls";
  readonly title: string;
  readonly description: string;
  readonly tools: readonly WorkspaceToolItem[];
}

export function SettingsWorkspaceToolsPanel({
  counts,
  defaultPermissionMode,
  defaultPermissionPreset,
  onOpenProviders,
  onOpenTeammates,
  onOpenCouncils,
  onOpenWorkBoard,
  onOpenApprovalPolicy,
}: {
  readonly counts: WorkspaceToolCounts;
  readonly defaultPermissionMode: SessionPermissionMode | undefined;
  readonly defaultPermissionPreset: PermissionPreset | undefined;
  readonly onOpenProviders: () => void;
  readonly onOpenTeammates: () => void;
  readonly onOpenCouncils: () => void;
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
      chipLabel: readyModelCountLabel(counts.readyProviderCount, t),
      actionLabel: t("Open Model Workbench"),
      icon: Box,
      onOpen: onOpenProviders,
    },
    {
      id: "teammates",
      title: t("Teammate Management"),
      chipLabel: t("{count} teammates", { count: counts.visibleTeammateCount }),
      actionLabel: t("Open Teammate Management"),
      icon: Bot,
      onOpen: onOpenTeammates,
    },
    {
      id: "councils",
      title: t("Council Workspace"),
      chipLabel: t("{count} council(s)", { count: counts.activeCouncilCount }),
      actionLabel: t("Open Council Workspace"),
      icon: Brain,
      onOpen: onOpenCouncils,
    },
    {
      id: "work-board",
      title: t("Work Board"),
      chipLabel: t("{count} pending work items", { count: counts.openWorkItemCount }),
      actionLabel: t("Open Work Board"),
      icon: Kanban,
      onOpen: onOpenWorkBoard,
    },
    {
      id: "approval",
      title: t("Default authorization"),
      chipLabel: t("Default: {mode}", { mode: t(authorizationOption.labelKey) }),
      actionLabel: t("Open default authorization"),
      icon: ShieldCheck,
      onOpen: onOpenApprovalPolicy,
    },
  ];
  const toolGroups: readonly WorkspaceToolGroup[] = [
    {
      id: "setup",
      title: t("Workspace setup"),
      description: t("Prepare the models and AI collaborators Ling uses."),
      tools: tools.filter((tool) => tool.id === "providers" || tool.id === "teammates" || tool.id === "councils"),
    },
    {
      id: "controls",
      title: t("Work controls"),
      description: t("Review workspace work and default authorization."),
      tools: tools.filter((tool) => tool.id === "work-board" || tool.id === "approval"),
    },
  ];

  return (
    <section className="settings-workspace-tools" aria-label={t("Configuration shortcuts")}>
      <div className="settings-configuration-grid">
        {toolGroups.map((group) => (
          <section key={group.id} className="settings-tool-row-group" aria-labelledby={`settings-tool-group-${group.id}`}>
            <header className="settings-tool-row-group-head">
              <div>
                <h3 id={`settings-tool-group-${group.id}`}>{group.title}</h3>
                <p>{group.description}</p>
              </div>
            </header>
            <div className="settings-tool-row-list" aria-label={group.title}>
              {group.tools.map((tool) => (
                <WorkspaceToolRow key={tool.id} tool={tool} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </section>
  );
}

export function SettingsGlobalApprovalDefaultCard({
  defaultPermissionMode,
  defaultPermissionPreset,
  onDefaultPermissionChange,
  onOpenAdvancedPolicy,
}: {
  readonly defaultPermissionMode: SessionPermissionMode | undefined;
  readonly defaultPermissionPreset: PermissionPreset | undefined;
  readonly onDefaultPermissionChange: (mode: SessionPermissionMode, preset: PermissionPreset) => void;
  readonly onOpenAdvancedPolicy?: () => void;
}): JSX.Element {
  const { t } = useI18n();
  const authorizationMode = permissionToAuthorizationMode(defaultPermissionMode, defaultPermissionPreset);
  const authorizationOption = authorizationOptions.find((option) => option.mode === authorizationMode) ?? authorizationOptions[1];

  return (
    <aside className="settings-global-approval-card" aria-labelledby="settings-global-approval-title">
      <div className="settings-global-approval-head">
        <span aria-hidden="true">
          <ShieldCheck size={18} />
        </span>
        <div>
          <strong id="settings-global-approval-title">{t("Default authorization")}</strong>
          <small>{t("Choose how new conversations get permission to use tools.")}</small>
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
      {onOpenAdvancedPolicy ? (
        <button className="secondary-button settings-global-approval-action" type="button" onClick={onOpenAdvancedPolicy}>
          {t("Open advanced policy")}
        </button>
      ) : null}
    </aside>
  );
}

function WorkspaceToolRow({ tool }: { readonly tool: WorkspaceToolItem }): JSX.Element {
  const Icon = tool.icon;
  return (
    <StatusActionRow
      className="settings-tool-row settings-tool-status-row"
      leading={(
        <span className="settings-tool-row-icon" aria-hidden="true">
          <Icon size={21} />
        </span>
      )}
      title={(
        <span className="settings-tool-row-heading">
          <strong>{tool.title}</strong>
        </span>
      )}
      status={<small className="settings-tool-row-chip">{tool.chipLabel}</small>}
      actions={(
        <button className="secondary-button settings-tool-row-action" type="button" onClick={tool.onOpen}>
          {tool.actionLabel}
        </button>
      )}
    />
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
