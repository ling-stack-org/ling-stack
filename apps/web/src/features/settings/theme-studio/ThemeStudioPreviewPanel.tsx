import { Monitor } from "lucide-react";
import { useMemo, useState } from "react";
import { useI18n } from "../../../i18n.js";
import {
  EmptyState,
  PresentationProfileRegistry,
  SegmentedControl,
  SegmentedControlItem,
  Tabs,
  TabsList,
  TabsTrigger,
  ThemeStudioPreviewFixture,
  type ThemeStudioPreviewSurface,
  type ThemeStudioPreviewViewport,
} from "../../../shared/ui/index.js";
import { previewSurfacePolicy, quickThemePreviewCopy } from "./quick-theme-view-models.js";
import type { QuickThemeState } from "./quick-theme-state.js";

const profileRegistry = new PresentationProfileRegistry();

export function ThemeStudioPreviewPanel({ state }: { readonly state: QuickThemeState }): JSX.Element {
  const { t } = useI18n();
  const [surface, setSurface] = useState<ThemeStudioPreviewSurface>("home");
  const [viewport, setViewport] = useState<ThemeStudioPreviewViewport>("1440x960");
  const copy = useMemo(() => quickThemePreviewCopy(t), [t]);
  const candidate = state.compiled;

  return (
    <section className="settings-theme-studio-preview" aria-labelledby="settings-theme-studio-preview-title">
      <header>
        <span>
          <h2 id="settings-theme-studio-preview-title">{state.name.trim() || t("Untitled theme")}</h2>
        </span>
        <span>{t("Token colors only")}</span>
      </header>
      <div className="settings-theme-studio-preview-controls">
        <Tabs value={surface} onValueChange={(value) => setSurface(value as ThemeStudioPreviewSurface)}>
          <TabsList size="sm">
            <TabsTrigger value="home">{t("Home")}</TabsTrigger>
            <TabsTrigger value="conversation">{t("Conversation")}</TabsTrigger>
            <TabsTrigger value="settings">{t("Settings")}</TabsTrigger>
            <TabsTrigger value="dialog">{t("Dialog")}</TabsTrigger>
          </TabsList>
        </Tabs>
        <SegmentedControl
          aria-label={t("Preview size")}
          size="sm"
          value={viewport}
          onValueChange={(value) => setViewport(value as ThemeStudioPreviewViewport)}
        >
          <SegmentedControlItem value="1280x800">1280 x 800</SegmentedControlItem>
          <SegmentedControlItem value="1440x960">1440 x 960</SegmentedControlItem>
        </SegmentedControl>
      </div>
      <div className="settings-theme-studio-preview-stage">
        {candidate ? (
          <ThemeStudioPreviewFixture
            copy={copy}
            presentationPolicy={profileRegistry.resolveSurface("ling-standard", previewSurfacePolicy(surface))}
            scale={viewport === "1440x960" ? 0.42 : 0.48}
            surface={surface}
            variableMap={candidate.tokenMap}
            viewport={viewport}
          />
        ) : (
          <EmptyState
            compact
            description={t("Choose an image and generate a preview. The image stays on this device.")}
            icon={<Monitor />}
            title={t("Preview will appear here")}
          />
        )}
      </div>
    </section>
  );
}
