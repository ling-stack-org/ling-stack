import { Eye, FolderOpen, Hand, RefreshCw, Shield, ShieldCheck, Trash2, type LucideIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "../../i18n.js";
import { listApprovalCommandRules, revokeApprovalCommandRule } from "../../api.js";
import { resolveAuthorizationMode, resolveWorkspaceAccessMode } from "../../lib/conversation-authorization.js";
import { Button, DataRow, SegmentedControl, SegmentedControlItem } from "../../shared/ui/index.js";
import type { ApprovalCommandRule, AuthorizationMode, PermissionPreset, SessionPermissionMode, WorkspaceAccessMode } from "../../types.js";

interface AuthorizationChoice<Value extends string> {
  readonly value: Value;
  readonly label: string;
  readonly description: string;
  readonly icon: LucideIcon;
}

export function ExecutionPermissionsSettingsPanel({
  cwd,
  workspaceDefaultPermissionMode,
  workspaceDefaultPermissionPreset,
  workspaceDefaultAuthorizationMode,
  workspaceDefaultWorkspaceAccessMode,
  onWorkspaceDefaultAuthorizationChange,
  onWorkspaceDefaultWorkspaceAccessChange,
}: {
  readonly cwd: string;
  readonly workspaceDefaultPermissionMode?: SessionPermissionMode;
  readonly workspaceDefaultPermissionPreset?: PermissionPreset;
  readonly workspaceDefaultAuthorizationMode?: AuthorizationMode;
  readonly workspaceDefaultWorkspaceAccessMode?: WorkspaceAccessMode;
  readonly onWorkspaceDefaultAuthorizationChange: (mode: AuthorizationMode) => void;
  readonly onWorkspaceDefaultWorkspaceAccessChange: (mode: WorkspaceAccessMode) => void;
}): React.JSX.Element {
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
      <ApprovalCommandRulesSettings cwd={cwd} />
    </section>
  );
}

function ApprovalCommandRulesSettings({ cwd }: { readonly cwd: string }): React.JSX.Element {
  const { t } = useI18n();
  const [rules, setRules] = useState<readonly ApprovalCommandRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [revokingId, setRevokingId] = useState("");
  const cwdRef = useRef(cwd);
  const listRequestSequenceRef = useRef(0);
  cwdRef.current = cwd;

  async function refresh(): Promise<void> {
    const workspaceCwd = cwd;
    const requestId = ++listRequestSequenceRef.current;
    setLoading(true);
    setError("");
    try {
      const response = await listApprovalCommandRules(workspaceCwd);
      if (cwdRef.current !== workspaceCwd || listRequestSequenceRef.current !== requestId) return;
      setRules(response.rules);
    } catch (caught) {
      if (cwdRef.current !== workspaceCwd || listRequestSequenceRef.current !== requestId) return;
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (cwdRef.current === workspaceCwd && listRequestSequenceRef.current === requestId) setLoading(false);
    }
  }

  useEffect(() => {
    const requestId = ++listRequestSequenceRef.current;
    let active = true;
    setLoading(true);
    setError("");
    setRules([]);
    setRevokingId("");
    void listApprovalCommandRules(cwd)
      .then((response) => {
        if (active && listRequestSequenceRef.current === requestId) setRules(response.rules);
      })
      .catch((caught) => {
        if (active && listRequestSequenceRef.current === requestId) {
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      })
      .finally(() => {
        if (active && listRequestSequenceRef.current === requestId) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [cwd]);

  async function revoke(rule: ApprovalCommandRule): Promise<void> {
    const workspaceCwd = cwd;
    setRevokingId(rule.id);
    setError("");
    try {
      await revokeApprovalCommandRule(workspaceCwd, rule.id);
      if (cwdRef.current !== workspaceCwd) return;
      setRules((current) => current.filter((item) => item.id !== rule.id));
    } catch (caught) {
      if (cwdRef.current !== workspaceCwd) return;
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (cwdRef.current === workspaceCwd) setRevokingId("");
    }
  }

  return (
    <section className="settings-command-rules" aria-label={t("Terminal command rules")}>
      <header className="settings-command-rules-header">
        <span className="settings-authorization-copy">
          <strong>{t("Terminal command rules")}</strong>
          <small>{t("Commands allowed with Allow similar commands in this workspace.")}</small>
        </span>
        {error ? (
          <Button leadingIcon={<RefreshCw aria-hidden="true" size={14} />} size="sm" variant="secondary" onClick={() => void refresh()}>
            {t("Retry")}
          </Button>
        ) : null}
      </header>
      {error ? <p className="settings-command-rules-error" role="alert">{error}</p> : null}
      {loading ? (
        <p className="settings-command-rules-empty" role="status">{t("Loading command rules")}</p>
      ) : rules.length === 0 ? (
        <p className="settings-command-rules-empty">{t("No saved command rules")}</p>
      ) : (
        <div className="settings-command-rule-list">
          {rules.map((rule) => (
            <DataRow
              compact
              className="settings-command-rule-row"
              key={rule.id}
              identity={(
                <span className="settings-authorization-copy">
                  <strong><code>{rule.display}</code></strong>
                  <small>{t("Allows commands starting with {command}", { command: rule.display })}</small>
                </span>
              )}
              actions={(
                <Button
                  leadingIcon={<Trash2 aria-hidden="true" size={14} />}
                  loading={revokingId === rule.id}
                  loadingLabel={t("Revoking command rule")}
                  size="sm"
                  variant="secondary"
                  onClick={() => void revoke(rule)}
                >
                  {t("Revoke")}
                </Button>
              )}
            />
          ))}
        </div>
      )}
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
}): React.JSX.Element {
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
