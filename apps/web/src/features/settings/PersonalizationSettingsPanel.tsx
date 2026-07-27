import { MessageCircle, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { getEffectiveConfig } from "../../api.js";
import { updateWorkspaceSettings } from "../../api/workspace-settings.js";
import { useI18n, type Translate } from "../../i18n.js";
import {
  IconButton,
  InlineFeedback,
  SegmentedControl,
  SegmentedControlItem,
  Skeleton,
  useLingToast,
} from "../../shared/ui/index.js";
import type { EffectiveConfigResponse, LingConversationTone } from "../../types.js";
import { SkillGovernanceSettingsSection } from "./SkillGovernanceSettingsSection.js";

const visibleLingConversationTones: readonly LingConversationTone[] = ["friendly", "pragmatic"];
const defaultLingConversationTone: LingConversationTone = "pragmatic";

export function PersonalizationSettingsPanel({ cwd }: { readonly cwd: string }): JSX.Element {
  const { t } = useI18n();
  const { showToast } = useLingToast();
  const [effectiveConfig, setEffectiveConfig] = useState<EffectiveConfigResponse | undefined>();
  const [toneDraft, setToneDraft] = useState<LingConversationTone>(defaultLingConversationTone);
  const [loading, setLoading] = useState(false);
  const [loadAttempted, setLoadAttempted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void refresh(false);
  }, [cwd]);

  async function refresh(showMessage = true): Promise<void> {
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
      setToneDraft(nextConfig.values.lingConversationTone?.value ?? defaultLingConversationTone);
      if (showMessage) {
        showToast({
          message: t("Ling conversation tone refreshed"),
          scope: "settings:personalization:tone:refresh",
          tone: "success",
        });
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
      setLoadAttempted(true);
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
      const response = await updateWorkspaceSettings(workspaceCwd, { lingConversationTone: tone });
      const nextConfig = await getEffectiveConfig(workspaceCwd);
      const appliedTone = nextConfig.values.lingConversationTone?.value ?? response.settings.lingConversationTone;
      if (appliedTone !== tone) {
        throw new Error(t("Ling conversation tone was not applied. Please restart Ling and try again."));
      }
      setEffectiveConfig(nextConfig);
      setToneDraft(appliedTone);
      showToast({
        message: t("Ling conversation tone applied"),
        scope: "settings:personalization:tone:save",
        tone: "success",
      });
    } catch (caught) {
      setToneDraft(previousTone);
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  const initialLoading = !loadAttempted || (loading && !effectiveConfig);
  const state = initialLoading ? "loading" : error ? "error" : "loaded";
  const toneSource = effectiveConfig?.values.lingConversationTone?.source;

  return (
    <div
      className="settings-personalization"
      data-ui2-personalization="true"
      data-personalization-state={state}
    >
      <section
        className="personalization-settings-panel settings-personalization-section"
        data-personalization-tone="true"
        aria-labelledby="personalization-settings-title"
      >
        <div className="settings-personalization-section-head">
          <span>
            <MessageCircle size={18} />
            <h2 id="personalization-settings-title">{t("Ling conversation tone")}</h2>
          </span>
          <IconButton
            icon={RefreshCw}
            label={t("Refresh")}
            loading={loading}
            loadingLabel={t("Loading")}
            onClick={() => void refresh(true)}
          />
        </div>

        {error ? <InlineFeedback className="settings-personalization-feedback" tone="danger">{error}</InlineFeedback> : null}
        {initialLoading ? (
          <div className="settings-personalization-loading" aria-label={t("Loading")} aria-busy="true">
            <Skeleton width="42%" />
            <Skeleton height={38} shape="block" />
          </div>
        ) : effectiveConfig ? (
          <div className="settings-personalization-tone-row">
            <div className="settings-personalization-tone-meta">
              <span>{toneSource ? configSourceLabel(toneSource, t) : t("Loading")}</span>
              <p>{lingToneDescription(toneDraft, t)}</p>
            </div>
            <SegmentedControl
              className="settings-personalization-tone-control"
              aria-label={t("Ling conversation tone")}
              value={toneDraft}
              onValueChange={(value) => void applyTone(value as LingConversationTone)}
            >
              {visibleLingConversationTones.map((tone) => (
                <SegmentedControlItem key={tone} value={tone} disabled={saving || loading}>
                  {lingToneLabel(tone, t)}
                </SegmentedControlItem>
              ))}
            </SegmentedControl>
          </div>
        ) : null}
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
