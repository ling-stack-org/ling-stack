import { Bot, CircleAlert, Loader2, RefreshCw, Save, Settings } from "lucide-react";
import { useI18n } from "../../i18n.js";
import {
  buildLocalEffectivePolicyPreview,
  formatToolDecisionGroups,
  inferPermissionPreset,
  permissionModeForPreset,
  permissionPresetLabel,
  permissionPresetOptions,
  summarizeEffectivePolicySnapshot,
} from "../../lib/session-permissions.js";
import { formatDateTime } from "../../lib/formatting.js";
import type { RuntimeSettingsFormState } from "../../domains/settings/use-settings-domain.js";
import type {
  ApprovalPolicy,
  ApprovalPolicyFormState,
  Channel,
  PermissionPreset,
  RunnerListItem,
  SessionPermissionMode,
  WorkspaceRuntimeSettings,
} from "../../types.js";
import { SettingsGlobalApprovalDefaultCard } from "./SettingsWorkspaceToolsPanel.js";
import { AdvancedWorkspacePolicyEditor } from "./AdvancedWorkspacePolicyEditor.js";

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
  const runtimeSummary = formatRuntimeRunnerSummary({
    enabledRunnerCount: enabledRunners.length,
    runtimeSettings,
    runners,
    t,
  });

  return (
    <div className="settings-section-stack">
      <SettingsGlobalApprovalDefaultCard
        defaultPermissionMode={workspaceDefaultPermissionMode}
        defaultPermissionPreset={workspaceDefaultPermissionPreset}
        onDefaultPermissionChange={onWorkspaceDefaultPermissionChange}
      />

      <section className="panel settings-panel" aria-labelledby="settings-title">
        <div className="panel-title split">
          <span>
            <Settings size={18} />
            <h2 id="settings-title">{t("Tool permission policy")}</h2>
          </span>
          <div className="settings-section-title-actions">
            <small className="settings-section-meta">
              {t("Current policy")}: {permissionPresetLabel(resolvedPermissionPreset, t)}
              {policy ? ` · ${t("Updated")} ${formatDateTime(policy.updatedAt)}` : ""}
            </small>
            <button className="secondary-button compact-button" type="button" onClick={onRefresh} disabled={isLoading}>
              {isLoading ? <Loader2 className="spin" size={15} /> : <RefreshCw size={15} />}
              {t("Refresh")}
            </button>
          </div>
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
            </button>
          ))}
        </div>

        <div className="permission-preview-card permission-preview-card--compact" aria-label={t("Effective permissions")}>
          <strong>{t("Effective permissions")}</strong>
          <div className="permission-preview-list">
            {policyPreviewRows.map((row) => (
              <span key={row} title={row}>{row}</span>
            ))}
          </div>
        </div>

        <details className="advanced-settings settings-policy-advanced">
          <summary>{t("Advanced workspace policy")}</summary>
          <AdvancedWorkspacePolicyEditor
            policy={policy}
            form={form}
            isLoading={isLoading}
            onFormChange={(nextForm) => {
              onPermissionModeChange(permissionModeForPreset("custom"));
              onFormChange(nextForm);
            }}
            onSave={onSave}
          />
        </details>
      </section>

      <section className="panel settings-panel runtime-runner-settings-panel" aria-labelledby="runtime-runner-settings-title">
        <div className="panel-title split">
          <span>
            <Bot size={18} />
            <h2 id="runtime-runner-settings-title">{t("Execution runners")}</h2>
          </span>
          <div className="settings-section-title-actions">
            <small className="settings-section-meta">{runtimeSummary}</small>
            <button className="secondary-button compact-button" type="button" onClick={onRefreshRuntimeSettings} disabled={runtimeSettingsLoading}>
              {runtimeSettingsLoading ? <Loader2 className="spin" size={15} /> : <RefreshCw size={15} />}
              {t("Refresh")}
            </button>
          </div>
        </div>

        {runtimeSettingsError ? (
          <div className="inline-error">
            <CircleAlert size={17} />
            {runtimeSettingsError}
          </div>
        ) : null}

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
                <span className={`runtime-runner-status-dot ${runnerStatusTone(runner)}`} aria-hidden="true" />
                <span>{runner.displayName}</span>
                <small>{runnerReadinessLabel(runner, t)}</small>
                <details className="settings-compact-details settings-interaction-details">
                  <summary>{t("Runner details")}</summary>
                  <span>{runner.id}</span>
                  {runner.featureFlag ? <span>{runner.featureFlag}</span> : null}
                  {runner.disabledReason ? <span>{runner.disabledReason}</span> : null}
                  {runner.readiness?.blockingReasons.length ? (
                    <span className="runtime-runner-readiness" aria-label={t("{runner} readiness blockers", { runner: runner.displayName })}>
                      {runner.readiness.blockingReasons.slice(0, 3).map((blocker) => blocker.message).join(" · ")}
                    </span>
                  ) : null}
                </details>
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

function runnerStatusTone(runner: RunnerListItem): "ready" | "attention" | "muted" {
  if (runner.status !== "enabled") {
    return "muted";
  }
  if (runner.readiness?.blockingReasons.length) {
    return "attention";
  }
  return "ready";
}

function formatRuntimeRunnerSummary({
  enabledRunnerCount,
  runtimeSettings,
  runners,
  t,
}: {
  readonly enabledRunnerCount: number;
  readonly runtimeSettings: WorkspaceRuntimeSettings | undefined;
  readonly runners: readonly RunnerListItem[];
  readonly t: (key: string, values?: Readonly<Record<string, string | number>>) => string;
}): string {
  const defaultRunnerId = runtimeSettings?.defaultRunnerId;
  const defaultRunner = defaultRunnerId
    ? runners.find((runner) => runner.id === defaultRunnerId)?.displayName ?? defaultRunnerId
    : t("None");
  return t("Default runner: {runner} · Available {enabled}/{total}", {
    runner: defaultRunner,
    enabled: enabledRunnerCount,
    total: runners.length,
  });
}
