import { Loader2, MessageCircle, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { getEffectiveConfig } from "../../api.js";
import { updateWorkspaceSettings } from "../../api/workspace-settings.js";
import { useI18n, type Translate } from "../../i18n.js";
import type { EffectiveConfigResponse, LingConversationTone } from "../../types.js";
import { SkillGovernanceSettingsSection } from "./SkillGovernanceSettingsSection.js";

const visibleLingConversationTones: readonly LingConversationTone[] = ["friendly", "pragmatic"];
const defaultLingConversationTone: LingConversationTone = "pragmatic";
const feedbackMessageDurationMs = 2000;

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

  useEffect(() => {
    if (!message) {
      return;
    }
    const timeoutId = globalThis.setTimeout(() => setMessage(""), feedbackMessageDurationMs);
    return () => globalThis.clearTimeout(timeoutId);
  }, [message]);

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

  async function applyTone(tone: LingConversationTone): Promise<void> {
    const workspaceCwd = cwd.trim();
    if (!workspaceCwd || saving || loading || toneDraft === tone) {
      return;
    }
    const previousTone = toneDraft;
    setToneDraft(tone);
    setSaving(true);
    try {
      setError("");
      setMessage("");
      const response = await updateWorkspaceSettings(workspaceCwd, { lingConversationTone: tone });
      const nextConfig = await getEffectiveConfig(workspaceCwd);
      const appliedTone = nextConfig.values.lingConversationTone?.value ?? response.settings.lingConversationTone;
      if (appliedTone !== tone) {
        throw new Error(t("Ling conversation tone was not applied. Please restart Ling and try again."));
      }
      setEffectiveConfig(nextConfig);
      setToneDraft(appliedTone);
      setMessage(t("Ling conversation tone applied"));
    } catch (caught) {
      setToneDraft(previousTone);
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

        {error ? <div className="inline-error">{error}</div> : null}
        {message ? <div className="settings-inline-tip" role="status" aria-live="polite">{message}</div> : null}

        <div className="interface-preference-grid">
          <div className="interface-preference-row">
            <span>
              <MessageCircle size={16} />
              <strong>{t("Ling conversation tone")}</strong>
              {effectiveConfig?.values.lingConversationTone?.source ? (
                <small>{configSourceLabel(effectiveConfig.values.lingConversationTone.source, t)}</small>
              ) : null}
            </span>
            <div className="ling-tone-options" role="radiogroup" aria-label={t("Ling conversation tone")}>
              {visibleLingConversationTones.map((tone) => (
                <button
                  key={tone}
                  className={toneDraft === tone ? "ling-tone-option active" : "ling-tone-option"}
                  type="button"
                  role="radio"
                  aria-checked={toneDraft === tone}
                  onClick={() => void applyTone(tone)}
                  disabled={saving || loading}
                >
                  <strong>{lingToneLabel(tone, t)}</strong>
                  <small>{lingToneDescription(tone, t)}</small>
                </button>
              ))}
            </div>
          </div>
        </div>
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
