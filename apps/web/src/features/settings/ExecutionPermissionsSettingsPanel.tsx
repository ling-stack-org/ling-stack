import { useState } from "react";
import { Bot, CircleAlert, Loader2, RefreshCw, Save, Settings } from "lucide-react";
import { useI18n } from "../../i18n.js";
import {
  buildLocalEffectivePolicyPreview,
  formatToolDecisionGroups,
  inferPermissionPreset,
  permissionModeForPreset,
  permissionPresetDescription,
  permissionPresetLabel,
  permissionPresetOptions,
  summarizeEffectivePolicySnapshot,
} from "../../lib/session-permissions.js";
import { allTools, riskyTools } from "../../lib/tools.js";
import { formatDateTime } from "../../lib/formatting.js";
import { MetaRow, StatusBadge } from "../../shared/components/index.js";
import type { RuntimeSettingsFormState } from "../../domains/settings/use-settings-domain.js";
import type {
  ApprovalPolicy,
  ApprovalPolicyFormState,
  ApprovalToolDecision,
  Channel,
  PermissionPreset,
  RunnerListItem,
  SessionPermissionMode,
  WorkspaceRuntimeSettings,
} from "../../types.js";
import { SettingsSubnav } from "./SettingsSubnav.js";
import { SettingsGlobalApprovalDefaultCard } from "./SettingsWorkspaceToolsPanel.js";

type ExecutionSubsectionId = "defaults" | "policy" | "runners";

export function ExecutionPermissionsSettingsPanel({
  policy,
  form,
  runners,
  runtimeSettings,
  runtimeSettingsForm,
  selectedChannel,
  workspaceDefaultPermissionMode,
  workspaceDefaultPermissionPreset,
  permissionMode,
  permissionPreset,
  isLoading,
  runtimeSettingsLoading,
  runtimeSettingsAction,
  runtimeSettingsError,
  errorMessage,
  onFormChange,
  onPermissionModeChange,
  onWorkspaceDefaultPermissionChange,
  onRefresh,
  onSave,
  onRuntimeSettingsFormChange,
  onToggleAllowedRunner,
  onRefreshRuntimeSettings,
  onSaveRuntimeSettings,
}: {
  readonly policy: ApprovalPolicy | undefined;
  readonly form: ApprovalPolicyFormState;
  readonly runners: readonly RunnerListItem[];
  readonly runtimeSettings: WorkspaceRuntimeSettings | undefined;
  readonly runtimeSettingsForm: RuntimeSettingsFormState;
  readonly selectedChannel: Channel | undefined;
  readonly workspaceDefaultPermissionMode?: SessionPermissionMode;
  readonly workspaceDefaultPermissionPreset?: PermissionPreset;
  readonly permissionMode: SessionPermissionMode;
  readonly permissionPreset?: PermissionPreset;
  readonly isLoading: boolean;
  readonly runtimeSettingsLoading: boolean;
  readonly runtimeSettingsAction: "save" | undefined;
  readonly runtimeSettingsError: string;
  readonly errorMessage: string;
  readonly onFormChange: (form: ApprovalPolicyFormState) => void;
  readonly onPermissionModeChange: (mode: SessionPermissionMode) => void;
  readonly onWorkspaceDefaultPermissionChange: (mode: SessionPermissionMode, preset: PermissionPreset) => void;
  readonly onRefresh: () => void;
  readonly onSave: () => void;
  readonly onRuntimeSettingsFormChange: (form: RuntimeSettingsFormState) => void;
  readonly onToggleAllowedRunner: (runnerId: string, allowed: boolean) => void;
  readonly onRefreshRuntimeSettings: () => void;
  readonly onSaveRuntimeSettings: () => void;
}): JSX.Element {
  const { t } = useI18n();
  const [activeSubsection, setActiveSubsection] = useState<ExecutionSubsectionId>("defaults");
  const enabledRunners = runners.filter((runner) => runner.status === "enabled");
  const resolvedPermissionPreset = permissionPreset ?? inferPermissionPreset(permissionMode);
  const policyPreview = buildLocalEffectivePolicyPreview({
    policy,
    form,
    mode: permissionMode,
    channelBoundPath: selectedChannel?.boundPath,
  });
  const policyPreviewRows = [
    ...summarizeEffectivePolicySnapshot(policyPreview, t),
    ...formatToolDecisionGroups(policyPreview, t),
  ];

  return (
    <div className="settings-section-stack">
      <SettingsSubnav
        label="Runtime and permissions sections"
        activeId={activeSubsection}
        onChange={(id) => setActiveSubsection(id as ExecutionSubsectionId)}
        options={[
          {
            id: "defaults",
            label: "Default authorization",
            description: "Choose how new conversations get permission to use tools.",
          },
          {
            id: "policy",
            label: "Tool permission policy",
            description: "Tune tool decisions, permission previews, and write boundaries.",
          },
          {
            id: "runners",
            label: "Execution runners",
            description: "Choose which local execution runners Ling can use.",
            badge: String(enabledRunners.length),
          },
        ]}
      />

      {activeSubsection === "defaults" ? (
        <SettingsGlobalApprovalDefaultCard
          defaultPermissionMode={workspaceDefaultPermissionMode}
          defaultPermissionPreset={workspaceDefaultPermissionPreset}
          onDefaultPermissionChange={onWorkspaceDefaultPermissionChange}
        />
      ) : null}

      {activeSubsection === "policy" ? (
        <section className="panel settings-panel" aria-labelledby="settings-title">
        <div className="panel-title split">
          <span>
            <Settings size={18} />
            <h2 id="settings-title">{t("Tool permission policy")}</h2>
          </span>
          <button className="secondary-button compact-button" type="button" onClick={onRefresh} disabled={isLoading}>
            {isLoading ? <Loader2 className="spin" size={15} /> : <RefreshCw size={15} />}
            {t("Refresh")}
          </button>
        </div>

        {errorMessage ? (
          <div className="inline-error">
            <CircleAlert size={17} />
            {errorMessage}
          </div>
        ) : null}

        <div className="permission-preset-card-grid" aria-label={t("Permission preset")}>
          {permissionPresetOptions.map((preset) => (
            <button
              key={preset}
              className={resolvedPermissionPreset === preset ? "permission-preset-card active" : "permission-preset-card"}
              type="button"
              onClick={() => onPermissionModeChange(permissionModeForPreset(preset))}
              aria-pressed={resolvedPermissionPreset === preset}
            >
              <strong>{permissionPresetLabel(preset, t)}</strong>
              <small>{permissionPresetDescription(preset, t)}</small>
            </button>
          ))}
        </div>

        <div className="permission-preview-card" aria-label={t("Effective permissions")}>
          <div>
            <strong>{t("Effective permissions")}</strong>
            <small>{t("This preview follows the selected preset and approval policy form. Save policy to apply advanced policy edits.")}</small>
          </div>
          <div className="permission-preview-list">
            {policyPreviewRows.map((row) => (
              <span key={row}>{row}</span>
            ))}
          </div>
        </div>

        <div className="policy-meta">
          <MetaRow label={t("Updated")} value={policy ? formatDateTime(policy.updatedAt) : "-"} compact />
          <MetaRow label={t("Selected preset")} value={permissionPresetLabel(resolvedPermissionPreset, t)} compact />
        </div>

        <details className="advanced-settings" open={resolvedPermissionPreset === "custom"}>
          <summary>{t("Advanced workspace policy")}</summary>
          <div className="policy-tool-grid" aria-label={t("Tool approval decisions")}>
            {allTools.map((tool) => (
              <label key={tool} className={`policy-tool-row${riskyTools.includes(tool) ? " risky" : ""}`}>
                <span>{tool}</span>
                <select
                  value={form.toolDecisions[tool]}
                  onChange={(event) => {
                    onPermissionModeChange(permissionModeForPreset("custom"));
                    onFormChange({
                      ...form,
                      toolDecisions: {
                        ...form.toolDecisions,
                        [tool]: event.target.value as ApprovalToolDecision,
                      },
                    });
                  }}
                >
                  <option value="allow">{t("Allow")}</option>
                  <option value="ask">{t("Ask")}</option>
                  <option value="deny">{t("Deny")}</option>
                </select>
              </label>
            ))}
          </div>
          <label className="field wide">
            <span>{t("Allowed write paths")}</span>
            <textarea
              value={form.allowedWritePathsText}
              onChange={(event) => {
                onPermissionModeChange(permissionModeForPreset("custom"));
                onFormChange({ ...form, allowedWritePathsText: event.target.value });
              }}
            />
          </label>
        </details>

        <div className="action-row">
          <button className="primary-button" type="button" onClick={onSave} disabled={isLoading}>
            {isLoading ? <Loader2 className="spin" size={16} /> : <Save size={16} />}
            {t("Save policy")}
          </button>
        </div>
        </section>
      ) : null}

      {activeSubsection === "runners" ? (
        <section className="panel settings-panel runtime-runner-settings-panel" aria-labelledby="runtime-runner-settings-title">
        <div className="panel-title split">
          <span>
            <Bot size={18} />
            <h2 id="runtime-runner-settings-title">{t("Execution runners")}</h2>
          </span>
          <button className="secondary-button compact-button" type="button" onClick={onRefreshRuntimeSettings} disabled={runtimeSettingsLoading}>
            {runtimeSettingsLoading ? <Loader2 className="spin" size={15} /> : <RefreshCw size={15} />}
            {t("Refresh")}
          </button>
        </div>

        {runtimeSettingsError ? (
          <div className="inline-error">
            <CircleAlert size={17} />
            {runtimeSettingsError}
          </div>
        ) : null}

        <div className="settings-status-grid">
          <MetaRow label={t("Default runner")} value={runtimeSettings?.defaultRunnerId ?? "-"} compact />
          <MetaRow label={t("Allowed runners")} value={runtimeSettings?.allowedRunnerIds.join(", ") || "-"} compact />
          <MetaRow label={t("Explicit fallback")} value={runtimeSettings?.explicitRunnerFallback ?? "-"} compact />
          <MetaRow label={t("Implicit fallback")} value={runtimeSettings?.implicitRunnerFallback ?? "-"} compact />
          <MetaRow label={t("Updated")} value={runtimeSettings ? formatDateTime(runtimeSettings.updatedAt) : "-"} compact />
        </div>

        <div className="policy-tool-grid" aria-label={t("Runner settings")}>
          <label className="policy-tool-row">
            <span>{t("Default runner")}</span>
            <select
              value={runtimeSettingsForm.defaultRunnerId}
              onChange={(event) => onRuntimeSettingsFormChange({ ...runtimeSettingsForm, defaultRunnerId: event.target.value })}
              disabled={runtimeSettingsLoading || runtimeSettingsAction !== undefined || enabledRunners.length === 0}
            >
              {enabledRunners.map((runner) => (
                <option key={runner.id} value={runner.id}>{runner.displayName} ({runner.id})</option>
              ))}
            </select>
          </label>
          <label className="policy-tool-row">
            <span>{t("Explicit fallback")}</span>
            <select
              value={runtimeSettingsForm.explicitRunnerFallback}
              onChange={(event) => onRuntimeSettingsFormChange({
                ...runtimeSettingsForm,
                explicitRunnerFallback: event.target.value as RuntimeSettingsFormState["explicitRunnerFallback"],
              })}
              disabled={runtimeSettingsAction !== undefined}
            >
              <option value="disabled">{t("Disabled")}</option>
              <option value="allow_to_default">{t("Allow to default")}</option>
            </select>
          </label>
          <label className="policy-tool-row">
            <span>{t("Implicit fallback")}</span>
            <select
              value={runtimeSettingsForm.implicitRunnerFallback}
              onChange={(event) => onRuntimeSettingsFormChange({
                ...runtimeSettingsForm,
                implicitRunnerFallback: event.target.value as RuntimeSettingsFormState["implicitRunnerFallback"],
              })}
              disabled={runtimeSettingsAction !== undefined}
            >
              <option value="disabled">{t("Disabled")}</option>
              <option value="allow_to_default">{t("Allow to default")}</option>
            </select>
          </label>
        </div>

        <div className="runtime-list">
          {runners.length === 0 ? (
            <div className="empty-state compact-empty">
              {runtimeSettingsLoading ? <Loader2 className="spin" /> : <Bot />}
              <span>{runtimeSettingsLoading ? t("Loading runners...") : t("No runners registered")}</span>
            </div>
          ) : (
            runners.map((runner) => (
              <label key={runner.id} className="runtime-list-row runtime-runner-row">
                <input
                  type="checkbox"
                  checked={runtimeSettingsForm.allowedRunnerIds.includes(runner.id)}
                  onChange={(event) => onToggleAllowedRunner(runner.id, event.target.checked)}
                  disabled={runner.status !== "enabled" || runtimeSettingsAction !== undefined}
                />
                <StatusBadge status={runner.status} />
                <span>{runner.displayName}</span>
                <small>
                  {runner.id}
                  {runner.featureFlag ? ` · ${runner.featureFlag}` : ""}
                  {runner.disabledReason ? ` · ${runner.disabledReason}` : ""}
                  {runner.readiness ? ` · ${runnerReadinessLabel(runner, t)}` : ""}
                </small>
                {runner.readiness?.blockingReasons.length ? (
                  <span className="runtime-runner-readiness" aria-label={t("{runner} readiness blockers", { runner: runner.displayName })}>
                    {runner.readiness.blockingReasons.slice(0, 3).map((blocker) => blocker.message).join(" · ")}
                  </span>
                ) : null}
              </label>
            ))
          )}
        </div>

        <div className="action-row">
          <button
            className="primary-button"
            type="button"
            onClick={onSaveRuntimeSettings}
            disabled={runtimeSettingsAction !== undefined || runtimeSettingsLoading || enabledRunners.length === 0}
          >
            {runtimeSettingsAction === "save" ? <Loader2 className="spin" size={16} /> : <Save size={16} />}
            {t("Save runtime settings")}
          </button>
        </div>
        </section>
      ) : null}
    </div>
  );
}

function runnerReadinessLabel(runner: RunnerListItem, t: (key: string, values?: Readonly<Record<string, string | number>>) => string): string {
  const readiness = runner.readiness;
  if (!readiness) {
    return t("readiness unknown");
  }
  const blockerCount = readiness.blockingReasons.length;
  if (blockerCount === 0) {
    return t("readiness {status}", { status: readiness.status });
  }
  return t("readiness {status}, {count} blockers", { status: readiness.status, count: blockerCount });
}
