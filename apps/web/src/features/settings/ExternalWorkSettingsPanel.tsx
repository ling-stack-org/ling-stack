import { useEffect, useState } from "react";
import {
  CircleAlert,
  Database,
  GitBranch,
  KeyRound,
  Loader2,
  Play,
  Power,
  PowerOff,
  RefreshCw,
  Save,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { useI18n } from "../../i18n.js";
import type { Channel, ExternalWorkStatusResponse } from "../../types.js";
import { SettingsMetaLine } from "./SettingsSubnav.js";

export function ExternalWorkSettingsPanel({
  selectedChannel,
  externalWorkStatus,
  externalWorkStatusLoading,
  externalWorkStatusAction,
  externalWorkSecretAction,
  externalWorkWorkflowAction,
  onRefreshExternalWork,
  onExternalWorkAction,
  onConfigureExternalWorkWorkflow,
  onConfigureExternalWorkSecret,
  onDeleteExternalWorkSecret,
  onOpenExternalWorkRecords,
  onOpenExternalWorkTriage,
}: {
  readonly selectedChannel: Channel | undefined;
  readonly externalWorkStatus: ExternalWorkStatusResponse | undefined;
  readonly externalWorkStatusLoading: boolean;
  readonly externalWorkStatusAction: "poll" | "reconcile" | "start" | "stop" | undefined;
  readonly externalWorkSecretAction: "configure" | "delete" | undefined;
  readonly externalWorkWorkflowAction: "configure" | undefined;
  readonly onRefreshExternalWork: () => void;
  readonly onExternalWorkAction: (action: "poll" | "reconcile" | "start" | "stop") => void;
  readonly onConfigureExternalWorkWorkflow: (input: {
    readonly sourceKind: "github" | "linear";
    readonly repository?: string;
    readonly projectSlug?: string;
  }) => Promise<void>;
  readonly onConfigureExternalWorkSecret: (token: string) => Promise<void>;
  readonly onDeleteExternalWorkSecret: () => Promise<void>;
  readonly onOpenExternalWorkRecords: () => void;
  readonly onOpenExternalWorkTriage: () => void;
}): JSX.Element {
  const { t } = useI18n();
  const [externalWorkToken, setExternalWorkToken] = useState("");
  const [workflowSourceKind, setWorkflowSourceKind] = useState<"github" | "linear">("github");
  const [workflowRepository, setWorkflowRepository] = useState("");
  const [workflowProjectSlug, setWorkflowProjectSlug] = useState("");

  const secretRef = externalWorkStatus?.secret.ref ?? externalWorkStatus?.workflow.secretRef;
  const canConfigureSecret = Boolean(externalWorkStatus?.workflow.valid && externalWorkStatus.workflow.sourceKind !== "unknown");
  const canRemoveSecret = Boolean(secretRef?.startsWith("keychain:"));
  const sourceLabel = externalWorkStatus?.workflow.sourceKind === "linear" ? "Linear" : "GitHub";
  const secretBusy = externalWorkSecretAction !== undefined;
  const workflowBusy = externalWorkWorkflowAction !== undefined;
  const shouldShowWorkflowSetup = Boolean(selectedChannel && (!externalWorkStatus?.workflow.valid || externalWorkStatus.workflow.sourceKind === "unknown"));
  const normalizedWorkflowRepository = normalizeGitHubRepositoryInput(workflowRepository);
  const workflowTargetReady = workflowSourceKind === "github"
    ? normalizedWorkflowRepository !== undefined
    : workflowProjectSlug.trim().length > 0;

  useEffect(() => {
    const sourceKind = externalWorkStatus?.workflow.sourceKind;
    if (sourceKind === "github" || sourceKind === "linear") {
      setWorkflowSourceKind(sourceKind);
    }
    if (externalWorkStatus?.workflow.repository) {
      setWorkflowRepository(externalWorkStatus.workflow.repository);
    }
    if (externalWorkStatus?.workflow.projectSlug) {
      setWorkflowProjectSlug(externalWorkStatus.workflow.projectSlug);
    }
  }, [
    externalWorkStatus?.workflow.sourceKind,
    externalWorkStatus?.workflow.repository,
    externalWorkStatus?.workflow.projectSlug,
  ]);

  return (
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
          <SettingsMetaLine
            label={t("External work status")}
            items={[
              { label: "Channel", value: `${selectedChannel.name} (${selectedChannel.id})` },
              { label: "Bound path", value: selectedChannel.boundPath ?? t("not set") },
              { label: "Workflow", value: externalWorkStatus?.workflow.path ?? "WORKFLOW.md" },
              { label: "Workflow status", value: workflowStatusLabel(externalWorkStatus) },
              { label: "Source", value: externalWorkStatus?.workflow.sourceKind ?? "unknown" },
              { label: "Target", value: externalWorkTargetLabel(externalWorkStatus) },
              { label: "Token", value: externalWorkStatus?.secret.status ?? "not_required" },
              { label: "Background", value: externalWorkStatus?.background.status ?? "not_configured" },
            ]}
          />

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

          {shouldShowWorkflowSetup ? (
            <div className="settings-action-box">
              <div>
                <strong>{t("Create WORKFLOW.md")}</strong>
                <small>{t("Create a minimal local workflow before saving the token. This does not contact GitHub or Linear.")}</small>
              </div>
              <div className="external-work-workflow-form">
                <label className="field">
                  <span>{t("Source")}</span>
                  <select
                    value={workflowSourceKind}
                    onChange={(event) => setWorkflowSourceKind(event.target.value === "linear" ? "linear" : "github")}
                    disabled={workflowBusy}
                  >
                    <option value="github">{t("GitHub")}</option>
                    <option value="linear">{t("Linear")}</option>
                  </select>
                </label>
                {workflowSourceKind === "github" ? (
                  <label className="field">
                    <span>{t("Repository")}</span>
                    <input
                      value={workflowRepository}
                      onChange={(event) => setWorkflowRepository(event.target.value)}
                      placeholder={t("owner/repo or GitHub URL")}
                      disabled={workflowBusy}
                    />
                  </label>
                ) : (
                  <label className="field">
                    <span>{t("Project slug")}</span>
                    <input
                      value={workflowProjectSlug}
                      onChange={(event) => setWorkflowProjectSlug(event.target.value)}
                      placeholder={t("linear-project")}
                      disabled={workflowBusy}
                    />
                  </label>
                )}
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => void onConfigureExternalWorkWorkflow({
                    sourceKind: workflowSourceKind,
                    repository: workflowSourceKind === "github" ? normalizedWorkflowRepository : undefined,
                    projectSlug: workflowSourceKind === "linear" ? workflowProjectSlug.trim() : undefined,
                  })}
                  disabled={!workflowTargetReady || workflowBusy}
                >
                  {workflowBusy ? <Loader2 className="spin" size={16} /> : <Save size={16} />}
                  {externalWorkStatus?.workflow.exists ? t("Repair WORKFLOW.md") : t("Create WORKFLOW.md")}
                </button>
              </div>
            </div>
          ) : null}

          <div className="settings-action-box">
            <div>
              <strong>{t("External token")}</strong>
              <small>
                {canConfigureSecret
                  ? t("Saved to system Keychain; token value is never shown in Ling.")
                  : t("Create a valid WORKFLOW.md before saving an external token.")}
              </small>
            </div>
            <SettingsMetaLine
              label={t("External credential status")}
              items={[{ label: "Secret ref", value: secretRef ?? t("not configured") }]}
            />
            <div className="external-work-secret-form">
              <label className="field">
                <span>{t("Token")}</span>
                <input
                  type="password"
                  autoComplete="off"
                  value={externalWorkToken}
                  onChange={(event) => setExternalWorkToken(event.target.value)}
                  placeholder={t(`Paste ${sourceLabel} token`)}
                  disabled={!canConfigureSecret || secretBusy}
                />
              </label>
              <button
                className="secondary-button"
                type="button"
                onClick={() => {
                  const token = externalWorkToken;
                  setExternalWorkToken("");
                  void onConfigureExternalWorkSecret(token);
                }}
                disabled={!canConfigureSecret || !externalWorkToken.trim() || secretBusy}
              >
                {externalWorkSecretAction === "configure" ? <Loader2 className="spin" size={16} /> : <KeyRound size={16} />}
                {t(`Save ${sourceLabel} token`)}
              </button>
              {canRemoveSecret ? (
                <button
                  className="ghost-button danger-ghost-button"
                  type="button"
                  onClick={() => void onDeleteExternalWorkSecret()}
                  disabled={secretBusy}
                >
                  {externalWorkSecretAction === "delete" ? <Loader2 className="spin" size={16} /> : <Trash2 size={16} />}
                  {t("Remove token")}
                </button>
              ) : null}
            </div>
          </div>

          <div className="settings-inline-counts">
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

function normalizeGitHubRepositoryInput(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  let candidate = trimmed;
  if (/^https?:\/\//i.test(candidate)) {
    try {
      const url = new URL(candidate);
      if (url.hostname !== "github.com") {
        return undefined;
      }
      const [owner, repo] = url.pathname.split("/").filter(Boolean);
      candidate = owner && repo ? `${owner}/${repo}` : "";
    } catch {
      return undefined;
    }
  } else if (candidate.startsWith("git@github.com:")) {
    candidate = candidate.slice("git@github.com:".length);
  } else if (candidate.startsWith("github.com/")) {
    candidate = candidate.slice("github.com/".length);
  }

  candidate = candidate.replace(/\.git$/i, "").replace(/\/+$/g, "");
  const [owner, repo, ...extra] = candidate.split("/");
  if (!owner || !repo || extra.length > 0) {
    return undefined;
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) {
    return undefined;
  }
  return `${owner}/${repo}`;
}
