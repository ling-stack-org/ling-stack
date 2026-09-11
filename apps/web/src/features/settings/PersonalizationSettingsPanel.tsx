import { ListTree, MessageCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { getEffectiveConfig } from "../../api.js";
import { updateWorkspaceSettings } from "../../api/workspace-settings.js";
import { useI18n, type Translate } from "../../i18n.js";
import {
  InlineFeedback,
  SegmentedControl,
  SegmentedControlItem,
  Skeleton,
  useLingToast,
} from "../../shared/ui/index.js";
import type { EffectiveConfigResponse, LingConversationTone, ReasoningSummaryMode } from "../../types.js";
import { SkillGovernanceSettingsSection } from "./SkillGovernanceSettingsSection.js";

const visibleLingConversationTones: readonly LingConversationTone[] = ["friendly", "pragmatic"];
const defaultLingConversationTone: LingConversationTone = "pragmatic";
const reasoningSummaryModes: readonly ReasoningSummaryMode[] = ["auto", "concise", "detailed", "none"];

export function PersonalizationSettingsPanel({ cwd }: { readonly cwd: string }): React.JSX.Element {
  const { t } = useI18n();
  const { showToast } = useLingToast();
  const [effectiveConfig, setEffectiveConfig] = useState<EffectiveConfigResponse | undefined>();
  const [toneDraft, setToneDraft] = useState<LingConversationTone>(defaultLingConversationTone);
  const [reasoningSummaryDraft, setReasoningSummaryDraft] = useState<ReasoningSummaryMode>("auto");
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
      setToneDraft(nextConfig.values.lingConversationTone?.value ?? defaultLingConversationTone);
      setReasoningSummaryDraft(nextConfig.values.reasoningSummary.value);
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

  async function applyReasoningSummary(mode: ReasoningSummaryMode): Promise<void> {
    const workspaceCwd = cwd.trim();
    if (!workspaceCwd || saving || loading || reasoningSummaryDraft === mode) return;
    const previous = reasoningSummaryDraft;
    setReasoningSummaryDraft(mode);
    setSaving(true);
    try {
      setError("");
      const response = await updateWorkspaceSettings(workspaceCwd, { defaultReasoningSummary: mode });
      if (response.settings.defaultReasoningSummary !== mode) {
        throw new Error(t("Reasoning summary preference was not applied."));
      }
      const nextConfig = await getEffectiveConfig(workspaceCwd);
      if (nextConfig.values.reasoningSummary.value !== mode) {
        throw new Error(t("Reasoning summary preference was not applied."));
      }
      setEffectiveConfig(nextConfig);
      setReasoningSummaryDraft(mode);
      showToast({ message: t("Reasoning summary preference applied"), scope: "settings:personalization:reasoning-summary:save", tone: "success" });
    } catch (caught) {
      setReasoningSummaryDraft(previous);
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  const initialLoading = !loadAttempted || (loading && !effectiveConfig);
  const state = initialLoading ? "loading" : error ? "error" : "loaded";

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
        </div>

        {error ? <InlineFeedback className="settings-personalization-feedback" tone="danger">{error}</InlineFeedback> : null}
        {initialLoading ? (
          <div className="settings-personalization-loading" aria-label={t("Loading")} aria-busy="true">
            <Skeleton width="42%" />
            <Skeleton height={38} shape="block" />
          </div>
        ) : effectiveConfig ? (
          <div className="settings-personalization-tone-row">
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

      <section
        className="personalization-settings-panel settings-personalization-section"
        data-personalization-reasoning-summary="true"
        aria-labelledby="personalization-reasoning-summary-title"
      >
        <div className="settings-personalization-section-head">
          <span>
            <ListTree size={18} />
            <h2 id="personalization-reasoning-summary-title">{t("Reasoning summary")}</h2>
          </span>
        </div>
        <p>{t("Choose how much provider-safe reasoning summary appears in conversations. Raw reasoning is never shown.")}</p>
        {initialLoading ? (
          <div className="settings-personalization-loading" aria-label={t("Loading")} aria-busy="true">
            <Skeleton height={38} shape="block" />
          </div>
        ) : effectiveConfig ? (
          <div className="settings-personalization-tone-row">
            <SegmentedControl
              aria-label={t("Reasoning summary")}
              value={reasoningSummaryDraft}
              onValueChange={(value) => void applyReasoningSummary(value as ReasoningSummaryMode)}
            >
              {reasoningSummaryModes.map((mode) => (
                <SegmentedControlItem key={mode} value={mode} disabled={saving || loading}>
                  {reasoningSummaryLabel(mode, t)}
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

function reasoningSummaryLabel(mode: ReasoningSummaryMode, t: Translate): string {
  if (mode === "auto") return t("Automatic");
  if (mode === "concise") return t("Concise");
  if (mode === "detailed") return t("Detailed");
  return t("None");
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
