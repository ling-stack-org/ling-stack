import {
  CircleAlert,
  Database,
  GitBranch,
  Languages,
  Loader2,
  Palette,
  Play,
  Power,
  PowerOff,
  RefreshCw,
  Save,
  Settings,
  ShieldCheck,
} from "lucide-react";
import { LanguageSwitcher, useI18n } from "../../i18n.js";
import { formatDateTime } from "../../lib/formatting.js";
import { allTools, riskyTools } from "../../lib/tools.js";
import { MetaRow } from "../../shared/components/index.js";
import { ThemeSwitcher } from "../../theme.js";
import type {
  ApprovalPolicy,
  ApprovalPolicyFormState,
  ApprovalToolDecision,
  Channel,
  ExternalWorkStatusResponse,
} from "../../types.js";

export function SettingsPage({
  cwd,
  policy,
  form,
  selectedChannel,
  externalWorkStatus,
  isLoading,
  externalWorkStatusLoading,
  externalWorkStatusAction,
  errorMessage,
  onCwdChange,
  onFormChange,
  onRefresh,
  onSave,
  onRefreshExternalWork,
  onExternalWorkAction,
  onOpenExternalWorkRecords,
  onOpenExternalWorkTriage,
}: {
  readonly cwd: string;
  readonly policy: ApprovalPolicy | undefined;
  readonly form: ApprovalPolicyFormState;
  readonly selectedChannel: Channel | undefined;
  readonly externalWorkStatus: ExternalWorkStatusResponse | undefined;
  readonly isLoading: boolean;
  readonly externalWorkStatusLoading: boolean;
  readonly externalWorkStatusAction: "poll" | "reconcile" | "start" | "stop" | undefined;
  readonly errorMessage: string;
  readonly onCwdChange: (cwd: string) => void;
  readonly onFormChange: (form: ApprovalPolicyFormState) => void;
  readonly onRefresh: () => void;
  readonly onSave: () => void;
  readonly onRefreshExternalWork: () => void;
  readonly onExternalWorkAction: (action: "poll" | "reconcile" | "start" | "stop") => void;
  readonly onOpenExternalWorkRecords: () => void;
  readonly onOpenExternalWorkTriage: () => void;
}): JSX.Element {
  const { t } = useI18n();

  return (
    <div className="settings-stack">
      <section className="panel settings-panel interface-settings-panel" aria-labelledby="interface-settings-title">
        <div className="panel-title">
          <Palette size={18} />
          <h2 id="interface-settings-title">{t("Interface preferences")}</h2>
        </div>
        <div className="interface-preference-grid">
          <div className="interface-preference-row">
            <span>
              <Palette size={16} />
              <strong>{t("Theme")}</strong>
            </span>
            <ThemeSwitcher />
          </div>
          <div className="interface-preference-row">
            <span>
              <Languages size={16} />
              <strong>{t("Language")}</strong>
            </span>
            <LanguageSwitcher />
          </div>
        </div>
      </section>

      <section className="panel settings-panel external-work-settings-panel" aria-labelledby="external-work-settings-title">
        <div className="panel-title split">
          <span>
            <GitBranch size={18} />
            <h2 id="external-work-settings-title">{t("External work")}</h2>
          </span>
          <button className="secondary-button compact-button" type="button" onClick={onRefreshExternalWork} disabled={externalWorkStatusLoading || !selectedChannel}>
            {externalWorkStatusLoading ? <Loader2 className="spin" size={15} /> : <RefreshCw size={15} />}
            {t("Refresh")}
          </button>
        </div>

        {!selectedChannel ? (
          <div className="empty-state compact-empty">
            <GitBranch />
            <span>{t("Select a channel to inspect external work setup.")}</span>
          </div>
        ) : (
          <>
            <div className="external-work-status-grid">
              <MetaRow label={t("Channel")} value={`${selectedChannel.name} (${selectedChannel.id})`} compact />
              <MetaRow label={t("Bound path")} value={selectedChannel.boundPath ?? t("not set")} compact />
              <MetaRow label={t("Workflow")} value={externalWorkStatus?.workflow.path ?? "WORKFLOW.md"} compact />
              <MetaRow label={t("Workflow status")} value={workflowStatusLabel(externalWorkStatus)} compact />
              <MetaRow label={t("Source")} value={externalWorkStatus?.workflow.sourceKind ?? "unknown"} compact />
              <MetaRow label={t("Target")} value={externalWorkTargetLabel(externalWorkStatus)} compact />
              <MetaRow label={t("Token")} value={externalWorkStatus?.secret.status ?? "not_required"} compact />
              <MetaRow label={t("Background")} value={externalWorkStatus?.background.status ?? "not_configured"} compact />
            </div>

            {!selectedChannel.boundPath ? (
              <div className="inline-warning">
                <CircleAlert size={16} />
                {t("External work is easiest to operate from a channel bound path. Bind this channel to the repository root before enabling polling.")}
              </div>
            ) : null}

            {externalWorkStatus?.workflow.error ? (
              <div className="inline-error">
                <CircleAlert size={17} />
                {externalWorkStatus.workflow.error}
              </div>
            ) : null}

            {externalWorkStatus?.secret.message ? (
              <div className="inline-warning">
                <ShieldCheck size={16} />
                {externalWorkStatus.secret.message}
              </div>
            ) : null}

            <div className="external-work-counts">
              <span>{t("External work")}: {externalWorkStatus?.records.externalWork.total ?? 0}</span>
              <span>{t("Ready")}: {externalWorkStatus?.records.externalWork.ready ?? 0}</span>
              <span>{t("CI triage")}: {externalWorkStatus?.records.ciTriage.total ?? 0}</span>
              <span>{t("Actions")}: {externalWorkStatus?.records.actions.total ?? 0}</span>
              <span>{t("Waiting")}: {externalWorkStatus?.records.actions.waitingForApproval ?? 0}</span>
            </div>

            <div className="action-row wrap">
              <button
                className="secondary-button"
                type="button"
                onClick={() => onExternalWorkAction("poll")}
                disabled={!externalWorkStatus?.workflow.valid || externalWorkStatusAction !== undefined}
              >
                {externalWorkStatusAction === "poll" ? <Loader2 className="spin" size={16} /> : <Play size={16} />}
                {t("Poll once")}
              </button>
              <button
                className="secondary-button"
                type="button"
                onClick={() => onExternalWorkAction("reconcile")}
                disabled={!externalWorkStatus || externalWorkStatusAction !== undefined}
              >
                {externalWorkStatusAction === "reconcile" ? <Loader2 className="spin" size={16} /> : <RefreshCw size={16} />}
                {t("Reconcile")}
              </button>
              {externalWorkStatus?.workflow.sourceKind === "github" && externalWorkStatus.background.status !== "running" ? (
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => onExternalWorkAction("start")}
                  disabled={!externalWorkStatus.workflow.valid || externalWorkStatusAction !== undefined}
                >
                  {externalWorkStatusAction === "start" ? <Loader2 className="spin" size={16} /> : <Power size={16} />}
                  {t("Start background")}
                </button>
              ) : null}
              {externalWorkStatus?.background.status === "running" ? (
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => onExternalWorkAction("stop")}
                  disabled={externalWorkStatusAction !== undefined}
                >
                  {externalWorkStatusAction === "stop" ? <Loader2 className="spin" size={16} /> : <PowerOff size={16} />}
                  {t("Stop background")}
                </button>
              ) : null}
              <button className="ghost-button" type="button" onClick={onOpenExternalWorkRecords} disabled={!externalWorkStatus}>
                <Database size={16} />
                {t("View records")}
              </button>
              <button className="ghost-button" type="button" onClick={onOpenExternalWorkTriage} disabled={!externalWorkStatus}>
                <ShieldCheck size={16} />
                {t("View CI triage")}
              </button>
            </div>
          </>
        )}
      </section>

      <section className="panel settings-panel" aria-labelledby="settings-title">
      <div className="panel-title split">
        <span>
          <Settings size={18} />
          <h2 id="settings-title">{t("Approval policy")}</h2>
        </span>
        <button className="secondary-button compact-button" type="button" onClick={onRefresh} disabled={isLoading}>
          {isLoading ? <Loader2 className="spin" size={15} /> : <RefreshCw size={15} />}
          {t("Refresh")}
        </button>
      </div>

      <label className="field wide runs-cwd">
        <span>{t("Workspace path")}</span>
        <input value={cwd} onChange={(event) => onCwdChange(event.target.value)} />
      </label>

      {errorMessage ? (
        <div className="inline-error">
          <CircleAlert size={17} />
          {errorMessage}
        </div>
      ) : null}

      <div className="policy-meta">
        <MetaRow label={t("Workspace")} value={policy?.workspaceId ?? "-"} compact />
        <MetaRow label={t("Updated")} value={policy ? formatDateTime(policy.updatedAt) : "-"} compact />
      </div>

      <div className="policy-tool-grid" aria-label={t("Tool approval decisions")}>
        {allTools.map((tool) => (
          <label key={tool} className={`policy-tool-row${riskyTools.includes(tool) ? " risky" : ""}`}>
            <span>{tool}</span>
            <select
              value={form.toolDecisions[tool]}
              onChange={(event) =>
                onFormChange({
                  ...form,
                  toolDecisions: {
                    ...form.toolDecisions,
                    [tool]: event.target.value as ApprovalToolDecision,
                  },
                })
              }
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
          onChange={(event) => onFormChange({ ...form, allowedWritePathsText: event.target.value })}
        />
      </label>

      <div className="action-row">
        <button className="primary-button" type="button" onClick={onSave} disabled={isLoading}>
          {isLoading ? <Loader2 className="spin" size={16} /> : <Save size={16} />}
          {t("Save policy")}
        </button>
      </div>
      </section>
    </div>
  );
}

function workflowStatusLabel(status: ExternalWorkStatusResponse | undefined): string {
  if (!status) {
    return "not loaded";
  }
  if (!status.workflow.exists) {
    return "missing";
  }
  return status.workflow.valid ? "valid" : "invalid";
}

function externalWorkTargetLabel(status: ExternalWorkStatusResponse | undefined): string {
  if (!status) {
    return "not configured";
  }
  return status.workflow.repository ?? status.workflow.projectSlug ?? "not configured";
}
