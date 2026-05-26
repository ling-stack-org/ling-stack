import {
  CircleAlert,
  Loader2,
  RefreshCw,
  Save,
  Settings,
} from "lucide-react";
import { useI18n } from "../../i18n.js";
import { formatDateTime } from "../../lib/formatting.js";
import { allTools, riskyTools } from "../../lib/tools.js";
import { MetaRow } from "../../shared/components/index.js";
import type {
  ApprovalPolicy,
  ApprovalPolicyFormState,
  ApprovalToolDecision,
} from "../../types.js";

export function SettingsPage({
  cwd,
  policy,
  form,
  isLoading,
  errorMessage,
  onCwdChange,
  onFormChange,
  onRefresh,
  onSave,
}: {
  readonly cwd: string;
  readonly policy: ApprovalPolicy | undefined;
  readonly form: ApprovalPolicyFormState;
  readonly isLoading: boolean;
  readonly errorMessage: string;
  readonly onCwdChange: (cwd: string) => void;
  readonly onFormChange: (form: ApprovalPolicyFormState) => void;
  readonly onRefresh: () => void;
  readonly onSave: () => void;
}): JSX.Element {
  const { t } = useI18n();

  return (
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
  );
}
