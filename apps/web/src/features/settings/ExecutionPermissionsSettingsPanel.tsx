import { Eye, FolderOpen, Hand, Shield, ShieldCheck, type LucideIcon } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { resolveAuthorizationMode, resolveWorkspaceAccessMode } from "../../lib/conversation-authorization.js";
import { DataRow, SegmentedControl, SegmentedControlItem } from "../../shared/ui/index.js";
import type { AuthorizationMode, PermissionPreset, SessionPermissionMode, WorkspaceAccessMode } from "../../types.js";

interface AuthorizationChoice<Value extends string> {
  readonly value: Value;
  readonly label: string;
  readonly description: string;
  readonly icon: LucideIcon;
}

export function ExecutionPermissionsSettingsPanel({
  workspaceDefaultPermissionMode,
  workspaceDefaultPermissionPreset,
  workspaceDefaultAuthorizationMode,
  workspaceDefaultWorkspaceAccessMode,
  onWorkspaceDefaultAuthorizationChange,
  onWorkspaceDefaultWorkspaceAccessChange,
}: {
  readonly workspaceDefaultPermissionMode?: SessionPermissionMode;
  readonly workspaceDefaultPermissionPreset?: PermissionPreset;
  readonly workspaceDefaultAuthorizationMode?: AuthorizationMode;
  readonly workspaceDefaultWorkspaceAccessMode?: WorkspaceAccessMode;
  readonly onWorkspaceDefaultAuthorizationChange: (mode: AuthorizationMode) => void;
  readonly onWorkspaceDefaultWorkspaceAccessChange: (mode: WorkspaceAccessMode) => void;
}): JSX.Element {
  const { t } = useI18n();
  const authorizationMode = resolveAuthorizationMode(
    workspaceDefaultAuthorizationMode,
    workspaceDefaultPermissionMode,
    workspaceDefaultPermissionPreset,
  );
  const workspaceAccessMode = resolveWorkspaceAccessMode(
    workspaceDefaultWorkspaceAccessMode,
    workspaceDefaultPermissionMode,
    workspaceDefaultPermissionPreset,
  );
  const authorizationOptions: readonly AuthorizationChoice<AuthorizationMode>[] = [
    {
      value: "ask",
      label: t("Ask first"),
      description: t("Ask before workspace changes, commands, and external actions."),
      icon: Hand,
    },
    {
      value: "smart",
      label: t("Smart authorization"),
      description: t("Allow workspace edits; ask before commands, external actions, or policy risks."),
      icon: Shield,
    },
    {
      value: "always",
      label: t("Always authorize"),
      description: t("Automatically authorize operations allowed by the selected sandbox; safety gates still apply."),
      icon: ShieldCheck,
    },
  ];
  const accessOptions: readonly AuthorizationChoice<WorkspaceAccessMode>[] = [
    {
      value: "read_only",
      label: t("Read only"),
      description: t("Read project files; editing and commands are blocked."),
      icon: Eye,
    },
    {
      value: "workspace_write",
      label: t("Workspace write"),
      description: t("Edit files inside the current workspace; commands still ask for approval."),
      icon: FolderOpen,
    },
    {
      value: "full_access",
      label: t("Full access"),
      description: t("Access files outside the workspace; each run still requires explicit confirmation."),
      icon: ShieldCheck,
    },
  ];

  return (
    <section
      className="settings-default-authorization-section"
      data-ui2-default-authorization="true"
      aria-label={t("Default authorization")}
    >
      <AuthorizationDecisionRow
        id="mode"
        ariaLabel={t("Authorization mode")}
        label={t("Default authorization")}
        value={authorizationMode}
        options={authorizationOptions}
        onChange={onWorkspaceDefaultAuthorizationChange}
      />
      <AuthorizationDecisionRow
        id="access"
        ariaLabel={t("Sandbox settings")}
        label={t("Sandbox settings")}
        value={workspaceAccessMode}
        options={accessOptions}
        onChange={onWorkspaceDefaultWorkspaceAccessChange}
      />
    </section>
  );
}

function AuthorizationDecisionRow<Value extends string>({
  id,
  ariaLabel,
  label,
  value,
  options,
  onChange,
}: {
  readonly id: "access" | "mode";
  readonly ariaLabel: string;
  readonly label: string;
  readonly value: Value;
  readonly options: readonly AuthorizationChoice<Value>[];
  readonly onChange: (value: Value) => void;
}): JSX.Element {
  const selected = options.find((option) => option.value === value) ?? options[0];
  return (
    <DataRow
      compact
      className="settings-authorization-row"
      data-authorization-choice={id}
      identity={(
        <span className="settings-authorization-copy">
          <strong>{label}</strong>
          <small>{selected.description}</small>
        </span>
      )}
      actions={(
        <SegmentedControl
          className="settings-authorization-segments"
          aria-label={ariaLabel}
          value={value}
          onValueChange={(nextValue) => {
            const next = options.find((option) => option.value === nextValue);
            if (next) onChange(next.value);
          }}
        >
          {options.map((option) => {
            const Icon = option.icon;
            return (
              <SegmentedControlItem key={option.value} value={option.value} title={option.description}>
                <Icon aria-hidden="true" />
                <span>{option.label}</span>
              </SegmentedControlItem>
            );
          })}
        </SegmentedControl>
      )}
    />
  );
}
