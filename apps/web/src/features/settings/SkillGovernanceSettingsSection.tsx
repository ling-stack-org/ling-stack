import { ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { getEffectiveConfig } from "../../api.js";
import { updateWorkspaceSettings } from "../../api/workspace-settings.js";
import { useI18n } from "../../i18n.js";
import { InlineFeedback, Skeleton, useLingToast } from "../../shared/ui/index.js";
import type { EffectiveConfigResponse, SkillGovernancePolicy } from "../../types.js";
import { defaultSkillGovernancePolicy, SkillGovernanceSettingsPanel } from "./SkillGovernanceSettingsPanel.js";

export function SkillGovernanceSettingsSection({ cwd }: { readonly cwd: string }): JSX.Element {
  const { t } = useI18n();
  const { showToast } = useLingToast();
  const [effectiveConfig, setEffectiveConfig] = useState<EffectiveConfigResponse | undefined>();
  const [skillGovernanceDraft, setSkillGovernanceDraft] = useState<SkillGovernancePolicy>(defaultSkillGovernancePolicy);
  const [loading, setLoading] = useState(false);
  const [loadAttempted, setLoadAttempted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void refresh();
  }, [cwd]);

  async function refresh(): Promise<void> {
    const workspaceCwd = cwd.trim();
    if (!workspaceCwd) {
      setError(t("Workspace path is required."));
      setLoadAttempted(true);
      return;
    }
    setLoading(true);
    try {
      setError("");
      const nextConfig = await getEffectiveConfig(workspaceCwd);
      setEffectiveConfig(nextConfig);
      setSkillGovernanceDraft(nextConfig.values.skillGovernancePolicy?.value ?? defaultSkillGovernancePolicy);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
      setLoadAttempted(true);
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
      if (effectiveConfig && !effectiveConfig.values.skillGovernancePolicy) {
        setError(t("Skill governance policy is not supported by this daemon."));
        return;
      }
      await updateWorkspaceSettings(workspaceCwd, { skillGovernancePolicy: skillGovernanceDraft });
      const nextConfig = await getEffectiveConfig(workspaceCwd);
      setEffectiveConfig(nextConfig);
      setSkillGovernanceDraft(nextConfig.values.skillGovernancePolicy?.value ?? defaultSkillGovernancePolicy);
      showToast({
        message: t("Skill governance policy saved"),
        scope: "settings:personalization:governance:save",
        tone: "success",
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  const initialLoading = !loadAttempted || (loading && !effectiveConfig);
  const policy = effectiveConfig?.values.skillGovernancePolicy?.value;
  const supported = Boolean(effectiveConfig?.values.skillGovernancePolicy);
  const dirty = policy ? !skillGovernancePoliciesEqual(skillGovernanceDraft, policy) : false;
  const state = initialLoading ? "loading" : error ? "error" : supported ? "loaded" : "unsupported";

  return (
    <section
      className="skill-governance-settings-panel settings-personalization-section"
      data-personalization-governance="true"
      data-governance-state={state}
      aria-labelledby="skill-governance-settings-title"
    >
      <div className="settings-personalization-section-head">
        <span>
          <ShieldCheck size={18} />
          <h2 id="skill-governance-settings-title">{t("Skill policy")}</h2>
        </span>
      </div>

      {error ? <InlineFeedback className="settings-personalization-feedback" tone="danger">{error}</InlineFeedback> : null}
      {initialLoading ? (
        <div className="settings-personalization-loading" aria-label={t("Loading")} aria-busy="true">
          <Skeleton width="58%" />
          <Skeleton height={72} shape="block" />
        </div>
      ) : effectiveConfig ? (
        <SkillGovernanceSettingsPanel
          dirty={dirty}
          policy={skillGovernanceDraft}
          supported={supported}
          saving={saving || loading}
          onChange={setSkillGovernanceDraft}
          onSave={() => void saveSkillGovernancePolicy()}
          t={t}
        />
      ) : null}
    </section>
  );
}

function skillGovernancePoliciesEqual(left: SkillGovernancePolicy, right: SkillGovernancePolicy): boolean {
  return left.generationMode === right.generationMode
    && left.recordingMode === right.recordingMode
    && left.invocationMode === right.invocationMode
    && left.publishMode === right.publishMode
    && left.bindMode === right.bindMode;
}
