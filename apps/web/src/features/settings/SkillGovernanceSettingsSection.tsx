import { Loader2, RefreshCw, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { getEffectiveConfig } from "../../api.js";
import { updateWorkspaceSettings } from "../../api/workspace-settings.js";
import { useI18n } from "../../i18n.js";
import type { EffectiveConfigResponse, SkillGovernancePolicy } from "../../types.js";
import { defaultSkillGovernancePolicy, SkillGovernanceSettingsPanel } from "./SkillGovernanceSettingsPanel.js";

export function SkillGovernanceSettingsSection({ cwd }: { readonly cwd: string }): JSX.Element {
  const { t } = useI18n();
  const [effectiveConfig, setEffectiveConfig] = useState<EffectiveConfigResponse | undefined>();
  const [skillGovernanceDraft, setSkillGovernanceDraft] = useState<SkillGovernancePolicy>(defaultSkillGovernancePolicy);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    void refresh(false);
  }, [cwd]);

  async function refresh(showMessage = true): Promise<void> {
    const workspaceCwd = cwd.trim();
    if (!workspaceCwd) {
      setError(t("Workspace path is required."));
      return;
    }
    setLoading(true);
    try {
      setError("");
      const nextConfig = await getEffectiveConfig(workspaceCwd);
      setEffectiveConfig(nextConfig);
      setSkillGovernanceDraft(nextConfig.values.skillGovernancePolicy?.value ?? defaultSkillGovernancePolicy);
      setMessage(showMessage ? t("Skill governance policy refreshed") : "");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }

  async function saveSkillGovernancePolicy(): Promise<void> {
    const workspaceCwd = cwd.trim();
    if (!workspaceCwd || saving) {
      return;
    }
    setSaving(true);
    try {
      setError("");
      setMessage("");
      if (effectiveConfig && !effectiveConfig.values.skillGovernancePolicy) {
        setError(t("Skill governance policy is not supported by this daemon."));
        return;
      }
      await updateWorkspaceSettings(workspaceCwd, { skillGovernancePolicy: skillGovernanceDraft });
      const nextConfig = await getEffectiveConfig(workspaceCwd);
      setEffectiveConfig(nextConfig);
      setSkillGovernanceDraft(nextConfig.values.skillGovernancePolicy?.value ?? defaultSkillGovernancePolicy);
      setMessage(t("Skill governance policy saved"));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="panel settings-panel skill-governance-settings-panel" aria-labelledby="skill-governance-settings-title">
      <div className="panel-title split">
        <span>
          <ShieldCheck size={18} />
          <h2 id="skill-governance-settings-title">{t("Skill policy")}</h2>
        </span>
        <button className="secondary-button compact-button" type="button" onClick={() => void refresh(true)} disabled={loading}>
          {loading ? <Loader2 className="spin" size={15} /> : <RefreshCw size={15} />}
          {t("Refresh")}
        </button>
      </div>

      <p className="settings-panel-copy">
        {t("Control skill recording, generation, and publication policy.")}
      </p>

      {error ? <div className="inline-error">{error}</div> : null}
      {message ? <div className="settings-inline-success">{message}</div> : null}

      <SkillGovernanceSettingsPanel
        policy={skillGovernanceDraft}
        source={effectiveConfig?.values.skillGovernancePolicy?.source}
        path={effectiveConfig?.values.skillGovernancePolicy?.path}
        supported={effectiveConfig === undefined || effectiveConfig.values.skillGovernancePolicy !== undefined}
        saving={saving || loading}
        onChange={setSkillGovernanceDraft}
        onSave={() => void saveSkillGovernancePolicy()}
        t={t}
      />
    </section>
  );
}
