import {
  House,
  ListChecks,
  MessageSquare,
  PanelRight,
  Search,
  Settings,
  SquareTerminal,
} from "lucide-react";
import { type CSSProperties, useId } from "react";
import { Button } from "../controls/Button.js";
import { Field } from "../controls/Field.js";
import { IconButton } from "../controls/IconButton.js";
import { Input } from "../controls/Input.js";
import { Select } from "../controls/Select.js";
import { DataRow } from "../data-display/DataRow.js";
import { InspectorSection } from "../data-display/InspectorSection.js";
import { InlineFeedback } from "../feedback/InlineFeedback.js";
import { StatusIndicator } from "../feedback/StatusIndicator.js";
import type { LingPresentationSurfacePolicy } from "../theme/presentation/profile-types.js";
import { LING_THEME_CSS_VARIABLES, type LingThemeCssVariable } from "../theme/types.js";

export const THEME_STUDIO_PREVIEW_VIEWPORTS = Object.freeze({
  "1280x800": Object.freeze({ width: 1280, height: 800 }),
  "1440x960": Object.freeze({ width: 1440, height: 960 }),
  "1920x1080": Object.freeze({ width: 1920, height: 1080 }),
  "2560x1440": Object.freeze({ width: 2560, height: 1440 }),
  "3440x1440": Object.freeze({ width: 3440, height: 1440 }),
});

export type ThemeStudioPreviewViewport = keyof typeof THEME_STUDIO_PREVIEW_VIEWPORTS;
export type ThemeStudioPreviewSurface = "home" | "conversation" | "settings" | "dialog";

export interface ThemeStudioPreviewCopy {
  readonly ariaLabel: string;
  readonly navigation: {
    readonly home: string;
    readonly conversations: string;
    readonly settings: string;
  };
  readonly shared: {
    readonly workspace: string;
    readonly ready: string;
    readonly search: string;
    readonly summary: string;
    readonly terminal: string;
    readonly details: string;
  };
  readonly home: {
    readonly eyebrow: string;
    readonly title: string;
    readonly body: string;
    readonly primaryAction: string;
    readonly composerPlaceholder: string;
    readonly recentTitle: string;
    readonly recentSummary: string;
  };
  readonly conversation: {
    readonly title: string;
    readonly status: string;
    readonly userMessage: string;
    readonly assistantMessage: string;
    readonly composerPlaceholder: string;
    readonly dockTitle: string;
    readonly dockSummary: string;
    readonly terminalTitle: string;
  };
  readonly settings: {
    readonly title: string;
    readonly sectionTitle: string;
    readonly fieldLabel: string;
    readonly fieldValue: string;
    readonly rowLabel: string;
    readonly rowSummary: string;
    readonly rowStatus: string;
    readonly inspectorTitle: string;
    readonly inspectorSummary: string;
    readonly inspectorBody: string;
  };
  readonly dialog: {
    readonly pageTitle: string;
    readonly title: string;
    readonly body: string;
    readonly fieldLabel: string;
    readonly fieldValue: string;
    readonly statusTitle: string;
    readonly statusBody: string;
    readonly cancel: string;
    readonly confirm: string;
    readonly toast: string;
  };
}

export interface ThemeStudioPreviewFixtureProps {
  readonly artworkUrl?: string;
  readonly copy: ThemeStudioPreviewCopy;
  readonly presentationPolicy: LingPresentationSurfacePolicy;
  readonly scale: number;
  readonly surface: ThemeStudioPreviewSurface;
  readonly variableMap: Readonly<Record<LingThemeCssVariable, string>>;
  readonly viewport: ThemeStudioPreviewViewport;
}

export function ThemeStudioPreviewFixture({
  artworkUrl,
  copy,
  presentationPolicy,
  scale,
  surface,
  variableMap,
  viewport,
}: ThemeStudioPreviewFixtureProps): JSX.Element {
  const fieldId = useId();
  const dimensions = THEME_STUDIO_PREVIEW_VIEWPORTS[viewport];
  const normalizedScale = normalizeScale(scale);
  const policy = protectedPolicy(surface, presentationPolicy);
  const safeArtworkUrl = artworkUrl?.startsWith("blob:") ? artworkUrl : undefined;
  const showArtwork = Boolean(safeArtworkUrl && policy.artwork !== "off");
  const frameStyle = {
    "--ling-theme-studio-preview-height": `${dimensions.height}px`,
    "--ling-theme-studio-preview-scale": normalizedScale,
    "--ling-theme-studio-preview-scaled-height": `${dimensions.height * normalizedScale}px`,
    "--ling-theme-studio-preview-scaled-width": `${dimensions.width * normalizedScale}px`,
    "--ling-theme-studio-preview-width": `${dimensions.width}px`,
  } as CSSProperties;
  const viewportStyle = scopedVariableMap(variableMap);

  return (
    <section
      aria-label={copy.ariaLabel}
      className="ling-ui-theme-studio-preview-fixture"
      data-theme-studio-preview-fixture="true"
      data-preview-height={dimensions.height}
      data-preview-scale={normalizedScale}
      data-preview-surface={surface}
      data-preview-viewport={viewport}
      data-preview-width={dimensions.width}
      style={frameStyle}
    >
      <div className="ling-ui-theme-studio-preview-stage">
        <div
          className="ling-ui-theme-studio-preview-viewport"
          data-artwork={policy.artwork}
          data-decorations={policy.decorations ? "true" : "false"}
          data-surface-recipe={policy.surfaceRecipe}
          style={viewportStyle}
        >
          {showArtwork ? (
            <img
              alt=""
              className="ling-ui-theme-studio-preview-artwork"
              draggable={false}
              src={safeArtworkUrl}
            />
          ) : null}
          {showArtwork ? <span className="ling-ui-theme-studio-preview-artwork-scrim" aria-hidden="true" /> : null}
          {policy.decorations ? (
            <span className="ling-ui-theme-studio-preview-decorations" aria-hidden="true">
              <i />
              <i />
            </span>
          ) : null}
          <PreviewSidebar copy={copy} surface={surface} />
          <main className="ling-ui-theme-studio-preview-main">
            {surface === "home" ? <HomePreview copy={copy} /> : null}
            {surface === "conversation" ? <ConversationPreview copy={copy} /> : null}
            {surface === "settings" ? <SettingsPreview copy={copy} fieldId={fieldId} /> : null}
            {surface === "dialog" ? <DialogPreview copy={copy} fieldId={fieldId} /> : null}
          </main>
        </div>
      </div>
    </section>
  );
}

function PreviewSidebar({
  copy,
  surface,
}: {
  readonly copy: ThemeStudioPreviewCopy;
  readonly surface: ThemeStudioPreviewSurface;
}): JSX.Element {
  return (
    <aside className="ling-ui-theme-studio-preview-sidebar">
      <strong>{copy.shared.workspace}</strong>
      <nav aria-label={copy.shared.workspace}>
        <Button leadingIcon={<House />} size="sm" variant={surface === "home" ? "secondary" : "ghost"}>
          {copy.navigation.home}
        </Button>
        <Button leadingIcon={<MessageSquare />} size="sm" variant={surface === "conversation" ? "secondary" : "ghost"}>
          {copy.navigation.conversations}
        </Button>
        <Button leadingIcon={<Settings />} size="sm" variant={surface === "settings" || surface === "dialog" ? "secondary" : "ghost"}>
          {copy.navigation.settings}
        </Button>
      </nav>
    </aside>
  );
}

function HomePreview({ copy }: { readonly copy: ThemeStudioPreviewCopy }): JSX.Element {
  return (
    <div className="ling-ui-theme-studio-preview-home">
      <header className="ling-ui-theme-studio-preview-page-header">
        <span>
          <small>{copy.home.eyebrow}</small>
          <strong>{copy.home.title}</strong>
        </span>
        <StatusIndicator compact label={copy.shared.ready} tone="success" />
      </header>
      <section className="ling-ui-theme-studio-preview-home-intro">
        <h2>{copy.home.title}</h2>
        <p>{copy.home.body}</p>
        <Button size="sm" variant="primary">{copy.home.primaryAction}</Button>
      </section>
      <section className="ling-ui-theme-studio-preview-home-recent">
        <DataRow
          compact
          identity={<strong>{copy.home.recentTitle}</strong>}
          status={<StatusIndicator compact label={copy.shared.ready} tone="neutral" />}
          summary={copy.home.recentSummary}
        />
      </section>
      <Input aria-label={copy.home.composerPlaceholder} placeholder={copy.home.composerPlaceholder} readOnly />
    </div>
  );
}

function ConversationPreview({ copy }: { readonly copy: ThemeStudioPreviewCopy }): JSX.Element {
  return (
    <div className="ling-ui-theme-studio-preview-conversation">
      <header className="ling-ui-theme-studio-preview-conversation-header">
        <span>
          <strong>{copy.conversation.title}</strong>
          <small>{copy.conversation.status}</small>
        </span>
        <div className="ling-ui-theme-studio-preview-toolbar">
          <IconButton icon={Search} label={copy.shared.search} tooltip="" />
          <IconButton icon={ListChecks} label={copy.shared.summary} tooltip="" />
          <IconButton icon={SquareTerminal} label={copy.shared.terminal} tooltip="" />
          <IconButton icon={PanelRight} label={copy.shared.details} pressed tooltip="" />
        </div>
      </header>
      <div className="ling-ui-theme-studio-preview-conversation-workspace">
        <section className="ling-ui-theme-studio-preview-feed">
          <article data-author="user"><p>{copy.conversation.userMessage}</p></article>
          <article data-author="assistant"><p>{copy.conversation.assistantMessage}</p></article>
          <Input aria-label={copy.conversation.composerPlaceholder} placeholder={copy.conversation.composerPlaceholder} readOnly />
        </section>
        <aside className="ling-ui-theme-studio-preview-dock">
          <strong>{copy.conversation.dockTitle}</strong>
          <p>{copy.conversation.dockSummary}</p>
          <StatusIndicator compact label={copy.shared.ready} tone="info" />
        </aside>
      </div>
      <section className="ling-ui-theme-studio-preview-terminal">
        <strong>{copy.conversation.terminalTitle}</strong>
        <code>$ ling status</code>
      </section>
    </div>
  );
}

function SettingsPreview({
  copy,
  fieldId,
}: {
  readonly copy: ThemeStudioPreviewCopy;
  readonly fieldId: string;
}): JSX.Element {
  return (
    <div className="ling-ui-theme-studio-preview-settings">
      <header className="ling-ui-theme-studio-preview-page-header">
        <span><strong>{copy.settings.title}</strong></span>
        <StatusIndicator compact label={copy.shared.ready} tone="success" />
      </header>
      <div className="ling-ui-theme-studio-preview-settings-layout">
        <nav aria-label={copy.settings.title}>
          <Button size="sm" variant="secondary">{copy.settings.sectionTitle}</Button>
        </nav>
        <section>
          <h2>{copy.settings.sectionTitle}</h2>
          <Field controlId={fieldId} label={copy.settings.fieldLabel}>
            <Select defaultValue={copy.settings.fieldValue}>
              <option value={copy.settings.fieldValue}>{copy.settings.fieldValue}</option>
            </Select>
          </Field>
          <DataRow
            compact
            identity={<strong>{copy.settings.rowLabel}</strong>}
            status={<StatusIndicator compact label={copy.settings.rowStatus} tone="info" />}
            summary={copy.settings.rowSummary}
          />
          <InspectorSection
            open
            summary={copy.settings.inspectorSummary}
            title={copy.settings.inspectorTitle}
          >
            <p>{copy.settings.inspectorBody}</p>
          </InspectorSection>
        </section>
      </div>
    </div>
  );
}

function DialogPreview({
  copy,
  fieldId,
}: {
  readonly copy: ThemeStudioPreviewCopy;
  readonly fieldId: string;
}): JSX.Element {
  return (
    <div className="ling-ui-theme-studio-preview-dialog-page">
      <header className="ling-ui-theme-studio-preview-page-header">
        <span><strong>{copy.dialog.pageTitle}</strong></span>
      </header>
      <div className="ling-ui-theme-studio-preview-dialog-backdrop" aria-hidden="true" />
      <section
        aria-label={copy.dialog.title}
        aria-modal="false"
        className="ling-ui-theme-studio-preview-dialog"
        role="dialog"
      >
        <header>
          <strong>{copy.dialog.title}</strong>
          <p>{copy.dialog.body}</p>
        </header>
        <Field controlId={fieldId} label={copy.dialog.fieldLabel}>
          <Input defaultValue={copy.dialog.fieldValue} readOnly />
        </Field>
        <InlineFeedback title={copy.dialog.statusTitle} tone="warning">
          {copy.dialog.statusBody}
        </InlineFeedback>
        <footer>
          <Button size="sm">{copy.dialog.cancel}</Button>
          <Button size="sm" variant="danger">{copy.dialog.confirm}</Button>
        </footer>
      </section>
      <div className="ling-ui-theme-studio-preview-toast" role="status">
        <StatusIndicator label={copy.dialog.toast} tone="success" />
      </div>
    </div>
  );
}

function normalizeScale(scale: number): number {
  if (!Number.isFinite(scale)) return 0.5;
  return Math.min(1, Math.max(0.1, scale));
}

function protectedPolicy(
  surface: ThemeStudioPreviewSurface,
  policy: LingPresentationSurfacePolicy,
): LingPresentationSurfacePolicy {
  if (surface !== "settings" && surface !== "dialog") return policy;
  return { artwork: "off", decorations: false, surfaceRecipe: "solid" };
}

function scopedVariableMap(
  variableMap: Readonly<Record<LingThemeCssVariable, string>>,
): CSSProperties {
  return Object.fromEntries(
    LING_THEME_CSS_VARIABLES.map((variable) => [variable, variableMap[variable]]),
  ) as CSSProperties;
}
