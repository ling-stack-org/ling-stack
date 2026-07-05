import { Loader2, MessageCircle, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { getEffectiveConfig } from "../../api.js";
import { updateWorkspaceSettings } from "../../api/workspace-settings.js";
import { useI18n, type Translate } from "../../i18n.js";
import type { EffectiveConfigResponse, LingConversationTone } from "../../types.js";
import { SkillGovernanceSettingsSection } from "./SkillGovernanceSettingsSection.js";

const visibleLingConversationTones: readonly LingConversationTone[] = ["friendly", "pragmatic"];
const defaultLingConversationTone: LingConversationTone = "pragmatic";

export function PersonalizationSettingsPanel({ cwd }: { readonly cwd: string }): JSX.Element {
  const { t } = useI18n();
  const [effectiveConfig, setEffectiveConfig] = useState<EffectiveConfigResponse | undefined>();
  const [toneDraft, setToneDraft] = useState<LingConversationTone>(defaultLingConversationTone);
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
      setToneDraft(nextConfig.values.lingConversationTone?.value ?? defaultLingConversationTone);
      setMessage(showMessage ? t("Ling conversation tone refreshed") : "");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }

  async function saveTone(): Promise<void> {
    const workspaceCwd = cwd.trim();
    if (!workspaceCwd || saving) {
      return;
    }
    setSaving(true);
    try {
      setError("");
      setMessage("");
      if (effectiveConfig && !effectiveConfig.values.lingConversationTone) {
        setError(t("Ling conversation tone is not supported by this daemon."));
        return;
      }
      await updateWorkspaceSettings(workspaceCwd, { lingConversationTone: toneDraft });
      const nextConfig = await getEffectiveConfig(workspaceCwd);
      setEffectiveConfig(nextConfig);
      setToneDraft(nextConfig.values.lingConversationTone?.value ?? defaultLingConversationTone);
      setMessage(t("Ling conversation tone saved"));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="settings-section-stack">
      <section className="panel settings-panel personalization-settings-panel" aria-labelledby="personalization-settings-title">
        <div className="panel-title split">
          <span>
            <MessageCircle size={18} />
            <h2 id="personalization-settings-title">{t("Ling conversation tone")}</h2>
          </span>
          <button className="secondary-button compact-button" type="button" onClick={() => void refresh(true)} disabled={loading}>
            {loading ? <Loader2 className="spin" size={15} /> : <RefreshCw size={15} />}
            {t("Refresh")}
          </button>
        </div>

        <p className="settings-panel-copy">
          {t("Choose how Ling replies by default in this workspace.")}
        </p>

        {error ? <div className="inline-error">{error}</div> : null}
        {message ? <div className="settings-inline-success">{message}</div> : null}

        <div className="interface-preference-grid">
          <div className="interface-preference-row">
            <span>
              <MessageCircle size={16} />
              <strong>{t("Ling conversation tone")}</strong>
              <small>{configSourceLabel(effectiveConfig?.values.lingConversationTone?.source, t)}</small>
            </span>
            <div className="ling-tone-options" role="radiogroup" aria-label={t("Ling conversation tone")}>
              {visibleLingConversationTones.map((tone) => (
                <button
                  key={tone}
                  className={toneDraft === tone ? "ling-tone-option active" : "ling-tone-option"}
                  type="button"
                  role="radio"
                  aria-checked={toneDraft === tone}
                  onClick={() => setToneDraft(tone)}
                >
                  <strong>{lingToneLabel(tone, t)}</strong>
                  <small>{lingToneDescription(tone, t)}</small>
                </button>
              ))}
            </div>
          </div>
        </div>

        <footer className="personalization-settings-actions">
          <small>
            {t("Current source")}: {configSourceLabel(effectiveConfig?.values.lingConversationTone?.source, t)}
          </small>
          <button className="primary-button compact-button" type="button" onClick={() => void saveTone()} disabled={saving || loading}>
            {saving ? <Loader2 className="spin" size={15} /> : null}
            {saving ? t("Saving tone...") : t("Save conversation tone")}
          </button>
        </footer>
      </section>

      <SkillGovernanceSettingsSection cwd={cwd} />
    </div>
  );
}

function configSourceLabel(source: EffectiveConfigResponse["values"]["theme"]["source"] | undefined, t: Translate): string {
  if (source === "workspace") {
    return t("Workspace");
  }
  if (source === "user") {
    return t("User default");
  }
  if (source === "built_in") {
    return t("Built-in");
  }
  return t("Loading");
}

function lingToneLabel(tone: LingConversationTone, t: Translate): string {
  if (tone === "friendly") {
    return t("Friendly");
  }
  if (tone === "pragmatic") {
    return t("Pragmatic");
  }
  return t("No extra tone");
}

function lingToneDescription(tone: LingConversationTone, t: Translate): string {
  if (tone === "friendly") {
    return t("Warm, collaborative, considerate.");
  }
  if (tone === "pragmatic") {
    return t("Concise, focused, direct.");
  }
  return t("Do not add a default tone instruction.");
}
