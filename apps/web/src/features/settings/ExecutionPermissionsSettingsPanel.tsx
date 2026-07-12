import { Eye, FolderOpen, Hand, Shield, ShieldCheck } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { resolveAuthorizationMode, resolveWorkspaceAccessMode } from "../../lib/conversation-authorization.js";
import type { AuthorizationMode, PermissionPreset, SessionPermissionMode, WorkspaceAccessMode } from "../../types.js";
import { SettingsChoiceMenu, type SettingsChoiceOption } from "./SettingsChoiceMenu.js";

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
  const authorizationOptions: readonly SettingsChoiceOption<AuthorizationMode>[] = [
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
  const accessOptions: readonly SettingsChoiceOption<WorkspaceAccessMode>[] = [
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
    <div className="settings-section-stack settings-default-authorization-section">
      <section className="settings-global-approval-card" aria-label={t("Default authorization")}>
        <div className="settings-decision-row">
          <div className="settings-decision-copy">
            <strong>{t("Default authorization")}</strong>
            <small>{t("Choose when Ling asks before acting.")}</small>
          </div>
          <SettingsChoiceMenu
            ariaLabel={t("Authorization mode")}
            value={authorizationMode}
            options={authorizationOptions}
            onChange={onWorkspaceDefaultAuthorizationChange}
          />
        </div>
        <div className="settings-decision-row">
          <div className="settings-decision-copy">
            <strong>{t("Sandbox settings")}</strong>
            <small>{t("Limit the files and commands Ling can use by default.")}</small>
          </div>
          <SettingsChoiceMenu
            ariaLabel={t("Sandbox settings")}
            value={workspaceAccessMode}
            options={accessOptions}
            onChange={onWorkspaceDefaultWorkspaceAccessChange}
          />
        </div>
      </section>
    </div>
  );
}
